const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { loadTargetRuntimeConfig } = require("../../src/config/loadTargetRuntimeConfig");
const { createSecurityFoundations } = require("../../src/bootstrap/createSecurityFoundations");
const { openDeployedTargetRuntime } = require("../../src/bootstrap/openDeployedTargetRuntime");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { initializeDatabaseIdentity } = require("../../src/infrastructure/database/databaseIdentity");
const { createSecurityNotificationOutboxRecord } = require("../../src/application/services/accounts/accountEmailOutbox");
const { runBootstrapCommand, PRODUCTION_CONFIRMATION } = require("../../scripts/bootstrap-first-platform-administrator");
const { runDeliveryCommand, CONFIRM_ARGUMENT } = require("../../scripts/deliver-first-administrator-setup");
const { deliverFirstAdministratorSetup, ERROR_CODE } = require("../../src/operations/accounts/deliverFirstAdministratorSetup");

const ROOT = path.resolve(__dirname, "../.."), MIGRATIONS = path.join(ROOT, "database/migrations");
const ORIGIN = "https://production.example.test", BUILD = "a".repeat(40);
const ENVIRONMENT = "synthetic-delivery-environment", DATABASE = "synthetic-delivery-database";
const nowEmail = "synthetic-admin@example.test";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-admin-delivery-"));
  assert(path.relative(ROOT, root).startsWith(".."));
  const file = path.join(root, "candidate.sqlite3");
  const connection = openDatabase({ databasePath: file, environment: "test" });
  try { migrateDatabase({ database: connection.database, migrationsDirectory: MIGRATIONS, applicationBuildId: BUILD, now: Date.now }); }
  finally { connection.database.close(); }
  initializeDatabaseIdentity({ databasePath: file, persistentRoot: root, applicationEnvironment: "production", environmentId: ENVIRONMENT,
    databaseId: DATABASE, databaseCreatedAt: new Date().toISOString(), migrationsDirectory: MIGRATIONS, productionConfirmation: DATABASE });
  const env = { APP_ENV: "production", NODE_ENV: "production", APP_BUILD_ID: BUILD, APP_ENVIRONMENT_ID: ENVIRONMENT, DATABASE_ID: DATABASE,
    FRONTEND_BUILD_ID: "frontend-synthetic-build", DATABASE_PATH: file, PERSISTENT_DATA_ROOT: root, PORT: "10000",
    CURRENT_SEASON_LABEL: "2026", CURRENT_NHL_SEASON_KEY: "20262027", SPORTSDATAIO_NHL_LIVE_MODE: "disabled",
    PUBLIC_FRONTEND_ORIGIN: ORIGIN, FRONTEND_ORIGINS: ORIGIN, LOG_LEVEL: "info", SESSION_COOKIE_SAME_SITE: "lax",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false", SCHEDULED_JOBS_ENABLED: "false", FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
    LEAGUE_WRITE_MODE: "closed", DEBUG_ROUTES_ENABLED: "false", EMAIL_DELIVERY_MODE: "send", EMAIL_FROM: "sender@example.test",
    RESEND_API_KEY: "re_" + crypto.randomBytes(24).toString("hex"), RATE_LIMIT_KEY_SECRET: crypto.randomBytes(32).toString("hex"),
    AUDIT_METADATA_SECRET: crypto.randomBytes(32).toString("hex"), ACTION_TOKEN_DELIVERY_KEY: crypto.randomBytes(32).toString("base64url"),
    BOOTSTRAP_ADMIN_EMAIL: nowEmail, BOOTSTRAP_ADMIN_DISPLAY_NAME: "Synthetic Administrator" };
  const result = runBootstrapCommand({ argv: ["--app-env", "production", "--confirm-app-env", "production", "--database", file,
    "--migrations", MIGRATIONS, "--persistent-root", root, "--production-confirmation", PRODUCTION_CONFIRMATION], env, output: { log() {} } });
  const time = { now: Date.now() }, expiresAt = new Date(time.now + 3600000).toISOString();
  Object.assign(env, { FIRST_ADMINISTRATOR_SETUP_ENABLED: "true", FIRST_ADMINISTRATOR_SETUP_USER_ID: result.userId,
    FIRST_ADMINISTRATOR_SETUP_EXPIRES_AT: expiresAt,
    FIRST_ADMINISTRATOR_SETUP_CONFIRMATION: `${ENVIRONMENT}:${DATABASE}:${BUILD}:${result.userId}:${expiresAt}`,
    FIRST_ADMINISTRATOR_SETUP_RECIPIENT: nowEmail });
  const f = { root, file, env, time, userId: result.userId, cleanups: [] };
  t.after(async () => {
    for (const cleanup of f.cleanups.reverse()) await cleanup();
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const r = open(f);
  f.eventId = r.runtime.database.prepare("SELECT id FROM outbox_events").get().id;
  f.unrelatedIds = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of f.unrelatedIds) r.runtime.repositories.outbox.insertPending(createSecurityNotificationOutboxRecord({
    id, userId: f.userId, notificationKind: "password_changed", nowMs: time.now - 60000 }));
  f.unrelatedBefore = unrelated(r.runtime.database, f.eventId);
  r.runtime.close();
  Object.assign(env, { FIRST_ADMINISTRATOR_SETUP_OUTBOX_EVENT_ID: f.eventId,
    FIRST_ADMINISTRATOR_SETUP_DELIVERY_CONFIRMATION: confirmation(f, f.eventId) });
  return f;
}
function confirmation(f, eventId) { return `${ENVIRONMENT}:${DATABASE}:${BUILD}:${f.userId}:${eventId}`; }
function open(f) {
  const config = loadTargetRuntimeConfig({ env: f.env, backendRoot: ROOT });
  const securityFoundations = createSecurityFoundations({ env: f.env, loadConfig: () => config.security, now: () => f.time.now, loggerSink() {} });
  const runtime = openDeployedTargetRuntime({ config, securityFoundations,
    emailAdapter: { async sendEmailVerification() { assert.fail("Unexpected message"); }, async sendAccountActionLink() { assert.fail("Use the explicit test adapter"); } },
    emailFetchImplementation() { assert.fail("A provider fetch is forbidden"); } });
  f.cleanups.push(() => runtime.close());
  return { runtime, securityFoundations };
}
function unrelated(db, eventId) { return JSON.stringify(db.prepare("SELECT * FROM outbox_events WHERE id <> ? ORDER BY id").all(eventId)); }
function queued(db) { return JSON.stringify(db.prepare("SELECT * FROM outbox_events ORDER BY id").all()); }
function inspect(f, fn) { const r = open(f); try { return fn(r.runtime.database, r); } finally { r.runtime.close(); } }
function command(f, send, overrides = {}) {
  return runDeliveryCommand({ argv: [CONFIRM_ARGUMENT], env: f.env, now: () => f.time.now, output: { log() {} },
    emailAdapter: { async sendEmailVerification() { assert.fail("Unexpected verification"); }, async sendSecurityNotification() { assert.fail("Unrelated notification must remain queued"); }, sendAccountActionLink: send },
    emailFetchImplementation() { assert.fail("A provider fetch is forbidden"); }, ...overrides });
}

test("the real command delivers only the selected setup event, preserves earlier due messages and never resends a published event", async t => {
  const f = fixture(t), messages = [], safeOutput = [];
  const send = async message => { messages.push(message); return { accepted: true }; };
  assert.deepEqual(await command(f, send, { output: { log(line) { safeOutput.push(line); } } }), { eventId: f.eventId, outcome: "published" });
  assert.equal(messages.length, 1); assert.equal(messages[0].to, nowEmail); assert.equal(messages[0].actionKind, "administrator_setup");
  assert.equal(messages[0].idempotencyKey, f.eventId);
  const url = new URL(messages[0].actionUrl); assert.equal(url.origin, ORIGIN); assert.equal(url.pathname, "/setup-account"); assert.equal(url.search, ""); assert(url.hash.startsWith("#token="));
  assert.equal(safeOutput.join("").includes(nowEmail), false); assert.equal(safeOutput.join("").includes(url.hash.slice(7)), false);
  inspect(f, db => {
    const row = db.prepare("SELECT * FROM outbox_events WHERE id=?").get(f.eventId);
    assert.equal(row.status, "published"); assert.equal(row.attempt_count, 1); assert.deepEqual(JSON.parse(row.payload_json), { cleared: true, schemaVersion: 1 });
    assert.equal(unrelated(db, f.eventId), f.unrelatedBefore);
    for (const table of ["user_credentials", "sessions", "job_runs"]) assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
  });
  assert.deepEqual(await command(f, send), { eventId: f.eventId, outcome: "already_published" }); assert.equal(messages.length, 1);
  const r = open(f), password = "SyntheticOnly!" + crypto.randomBytes(12).toString("hex");
  const completed = await r.runtime.services.account.credentialSetup.complete({ token: new URLSearchParams(url.hash.slice(1)).get("token"), password, passwordConfirmation: password });
  assert.equal(completed.completed, true); assert.equal(completed.signedOut, true);
  assert.equal(r.runtime.database.prepare("SELECT COUNT(*) count FROM user_credentials").get().count, 1);
  assert.equal(r.runtime.database.prepare("SELECT COUNT(*) count FROM sessions").get().count, 0);
  r.runtime.close();
  await assert.rejects(command(f, send)); assert.equal(messages.length, 1);
});

test("confirmation, selected recipient/event, token and running-worker mismatches refuse without claiming any queued message", async t => {
  const f = fixture(t), before = inspect(f, queued); let sends = 0;
  const send = async () => { sends++; return { accepted: true }; };
  for (const changes of [
    { FIRST_ADMINISTRATOR_SETUP_RECIPIENT: "another@example.test" },
    { FIRST_ADMINISTRATOR_SETUP_OUTBOX_EVENT_ID: f.unrelatedIds[0], FIRST_ADMINISTRATOR_SETUP_DELIVERY_CONFIRMATION: confirmation(f, f.unrelatedIds[0]) },
    { FIRST_ADMINISTRATOR_SETUP_DELIVERY_CONFIRMATION: "true" },
    { FIRST_ADMINISTRATOR_SETUP_OUTBOX_EVENT_ID: "invalid" },
    { ACCOUNT_EMAIL_DELIVERY_ENABLED: "true" },
    { DATABASE_ID: "different-database" },
  ]) {
    await assert.rejects(command(f, send, { env: { ...f.env, ...changes } }));
    assert.equal(inspect(f, queued), before);
  }
  await assert.rejects(command(f, send, { argv: [] }), { code: ERROR_CODE });
  inspect(f, db => db.prepare("UPDATE account_action_tokens SET status='invalidated',invalidated_at_ms=?,version=version+1 WHERE user_id=?").run(f.time.now, f.userId));
  await assert.rejects(command(f, send), { code: ERROR_CODE }); assert.equal(inspect(f, queued), before); assert.equal(sends, 0);
});

test("a retryable provider failure schedules only this event and a later explicit attempt reuses the same idempotency key", async t => {
  const f = fixture(t), keys = [];
  const send = async message => { keys.push(message.idempotencyKey); if (keys.length === 1) { const error = new Error("Synthetic provider timeout"); error.retryable = true; throw error; } return { accepted: true }; };
  assert.equal((await command(f, send)).outcome, "retry_scheduled");
  inspect(f, db => { assert.equal(db.prepare("SELECT status FROM outbox_events WHERE id=?").get(f.eventId).status, "failed"); assert.equal(unrelated(db, f.eventId), f.unrelatedBefore); });
  await assert.rejects(command(f, send), { code: ERROR_CODE }); assert.equal(keys.length, 1);
  f.time.now += 60000;
  assert.equal((await command(f, send)).outcome, "published"); assert.deepEqual(keys, [f.eventId, f.eventId]);
  inspect(f, db => assert.equal(unrelated(db, f.eventId), f.unrelatedBefore));
});

test("an in-flight selected event cannot be claimed twice and the command never recovers interrupted claims automatically", async t => {
  const f = fixture(t); let announce, release, sends = 0;
  const entered = new Promise(resolve => { announce = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  const first = command(f, async () => { sends++; announce(); await waiting; return { accepted: true }; });
  try { await entered; f.time.now += 6 * 60000; await assert.rejects(command(f, async () => { sends++; return { accepted: true }; }), { code: ERROR_CODE }); }
  finally { release(); }
  assert.equal((await first).outcome, "published"); assert.equal(sends, 1);
  inspect(f, db => assert.equal(unrelated(db, f.eventId), f.unrelatedBefore));
});

test("recipient changes between selection and claim are rechecked under the claim transaction before any provider call", async t => {
  const f = fixture(t), r = open(f), original = r.runtime.repositories.outbox; let reads = 0, sends = 0;
  const scoped = { ...original, findById(id) {
    const row = original.findById(id);
    if (++reads === 1) r.runtime.database.prepare("UPDATE users SET email_display='changed@example.test',version=version+1 WHERE id=?").run(f.userId);
    return row;
  } };
  const runtime = { ...r.runtime, repositories: { ...r.runtime.repositories, outbox: scoped },
    services: { ...r.runtime.services, accountEmail: { adapter: { async sendEmailVerification() {}, async sendAccountActionLink() { sends++; return { accepted: true }; } } } } };
  const before = queued(r.runtime.database);
  await assert.rejects(deliverFirstAdministratorSetup({ runtime, securityFoundations: r.securityFoundations, eventId: f.eventId,
    recipientEmail: nowEmail, confirmation: confirmation(f, f.eventId) }), { code: ERROR_CODE });
  assert.equal(queued(r.runtime.database), before); assert.equal(sends, 0);
});

test("the actual CLI refuses unconfirmed execution with a fixed error and no protected values", () => {
  const secretMarker = crypto.randomBytes(24).toString("hex");
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/deliver-first-administrator-setup.js"), "--invalid"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, env: { ...process.env, FIRST_ADMINISTRATOR_SETUP_RECIPIENT: nowEmail, RESEND_API_KEY: secretMarker }, timeout: 10000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, ERROR_CODE);
  assert.equal(result.stderr.includes(nowEmail), false); assert.equal(result.stderr.includes(secretMarker), false);
});

test("an expired setup window refuses delivery and preserves every queued event", async t => {
  const f = fixture(t), before = inspect(f, queued), previousTime = f.time.now; let sends = 0;
  f.time.now = Date.parse(f.env.FIRST_ADMINISTRATOR_SETUP_EXPIRES_AT);
  await assert.rejects(command(f, async () => { sends++; return { accepted: true }; }));
  f.time.now = previousTime;
  assert.equal(inspect(f, queued), before); assert.equal(sends, 0);
});

test("a wrong delivery key preserves the setup message so the corrected key can deliver it", async t => {
  const f = fixture(t), before = inspect(f, queued), messages = [];
  const send = async message => { messages.push(message); return { accepted: true }; };
  const env = { ...f.env, ACTION_TOKEN_DELIVERY_KEY: crypto.randomBytes(32).toString("base64url") };
  await assert.rejects(command(f, send, { env }), { code: ERROR_CODE });
  assert.equal(messages.length, 0);
  assert.equal(inspect(f, queued), before);
  inspect(f, db => {
    assert.equal(db.prepare("SELECT status FROM account_action_tokens WHERE user_id=?").get(f.userId).status, "active");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_credentials").get().count, 0);
  });
  assert.deepEqual(await command(f, send), { eventId: f.eventId, outcome: "published" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].idempotencyKey, f.eventId);
  inspect(f, db => assert.equal(unrelated(db, f.eventId), f.unrelatedBefore));
});

test("terminal provider rejection still discards only the selected event without automatic retries", async t => {
  const f = fixture(t); let sends = 0;
  const send = async () => { sends++; const error = new Error("Synthetic terminal rejection"); error.retryable = false; throw error; };
  assert.equal((await command(f, send)).outcome, "discarded");
  inspect(f, db => {
    const row = db.prepare("SELECT status,payload_json,attempt_count FROM outbox_events WHERE id=?").get(f.eventId);
    assert.equal(row.status, "discarded"); assert.equal(row.attempt_count, 1); assert.deepEqual(JSON.parse(row.payload_json), { cleared: true, schemaVersion: 1 });
    assert.equal(unrelated(db, f.eventId), f.unrelatedBefore);
  });
  await assert.rejects(command(f, send), { code: ERROR_CODE });
  assert.equal(sends, 1);
});

test("invalid envelope binding or a mismatched stored token preserves all queued messages and account state", async t => {
  const f = fixture(t), r = open(f), db = r.runtime.database;
  const selected = db.prepare("SELECT payload_json FROM outbox_events WHERE id=?").get(f.eventId);
  const payload = JSON.parse(selected.payload_json);
  const token = db.prepare("SELECT token_digest FROM account_action_tokens WHERE id=?").get(payload.tokenId);
  let sends = 0;
  const send = async () => { sends++; return { accepted: true }; };
  for (const failure of ["envelope", "digest"]) {
    if (failure === "envelope") {
      const changed = structuredClone(payload); changed.envelope.authenticationTag = crypto.randomBytes(16).toString("base64url");
      db.prepare("UPDATE outbox_events SET payload_json=? WHERE id=?").run(JSON.stringify(changed), f.eventId);
    } else {
      db.prepare("UPDATE account_action_tokens SET token_digest=? WHERE id=?").run(crypto.randomBytes(32).toString("hex"), payload.tokenId);
    }
    const queueBefore = queued(db);
    const tokensBefore = JSON.stringify(db.prepare("SELECT * FROM account_action_tokens ORDER BY id").all());
    await assert.rejects(command(f, send), { code: ERROR_CODE });
    assert.equal(queued(db), queueBefore);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM account_action_tokens ORDER BY id").all()), tokensBefore);
    assert.equal(sends, 0);
    db.prepare("UPDATE outbox_events SET payload_json=? WHERE id=?").run(selected.payload_json, f.eventId);
    db.prepare("UPDATE account_action_tokens SET token_digest=? WHERE id=?").run(token.token_digest, payload.tokenId);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_credentials").get().count, 0);
  assert.equal(unrelated(db, f.eventId), f.unrelatedBefore);
});

test("the stored token is revalidated inside the claim transaction and a changed digest rolls back before sending", async t => {
  const f = fixture(t), r = open(f), db = r.runtime.database, original = r.runtime.repositories.outbox;
  let reads = 0, sends = 0;
  const outbox = { ...original, findById(id) {
    const row = original.findById(id);
    if (++reads === 2) db.prepare("UPDATE account_action_tokens SET token_digest=?,version=version+1 WHERE user_id=?").run(crypto.randomBytes(32).toString("hex"), f.userId);
    return row;
  } };
  const runtime = { ...r.runtime, repositories: { ...r.runtime.repositories, outbox },
    services: { ...r.runtime.services, accountEmail: { adapter: { async sendEmailVerification() {}, async sendAccountActionLink() { sends++; return { accepted: true }; } } } } };
  const queueBefore = queued(db), tokensBefore = JSON.stringify(db.prepare("SELECT * FROM account_action_tokens ORDER BY id").all());
  await assert.rejects(deliverFirstAdministratorSetup({ runtime, securityFoundations: r.securityFoundations,
    eventId: f.eventId, recipientEmail: nowEmail, confirmation: confirmation(f, f.eventId) }), { code: ERROR_CODE });
  assert.equal(reads, 2); assert.equal(sends, 0);
  assert.equal(queued(db), queueBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM account_action_tokens ORDER BY id").all()), tokensBefore);
});
