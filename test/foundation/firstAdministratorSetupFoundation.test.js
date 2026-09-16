const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadFirstAdministratorSetupConfig, MAX_SETUP_WINDOW_MS } = require("../../src/config/loadFirstAdministratorSetupConfig");
const { loadTargetRuntimeConfig } = require("../../src/config/loadTargetRuntimeConfig");
const { createSecurityFoundations } = require("../../src/bootstrap/createSecurityFoundations");
const { openDeployedTargetRuntime } = require("../../src/bootstrap/openDeployedTargetRuntime");
const { createTargetRuntime } = require("../../src/bootstrap/createTargetRuntime");
const { createTargetHttpServer } = require("../../src/bootstrap/createTargetHttpServer");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { initializeDatabaseIdentity } = require("../../src/infrastructure/database/databaseIdentity");
const { runBootstrapCommand, PRODUCTION_CONFIRMATION } = require("../../scripts/bootstrap-first-platform-administrator");
const ROOT = path.resolve(__dirname, "../.."), MIGRATIONS = path.join(ROOT, "database/migrations");
const ORIGIN = "https://production.example.test", BUILD = "a".repeat(40);
const ENVIRONMENT = "production-setup-synthetic-environment", DATABASE = "production-setup-synthetic-database";
const USER = "00000000-0000-4000-8000-000000000001", HOUR = 3600000;

function setupFields(userId, expiresAt, environmentId = ENVIRONMENT, databaseId = DATABASE, buildId = BUILD) {
  return { FIRST_ADMINISTRATOR_SETUP_ENABLED: "true", FIRST_ADMINISTRATOR_SETUP_USER_ID: userId,
    FIRST_ADMINISTRATOR_SETUP_EXPIRES_AT: expiresAt,
    FIRST_ADMINISTRATOR_SETUP_CONFIRMATION: `${environmentId}:${databaseId}:${buildId}:${userId}:${expiresAt}` };
}
function minimalRuntimeConfig() {
  return { appEnv: "production", buildId: BUILD, environmentId: ENVIRONMENT, databaseId: DATABASE,
    leagueWriteMode: "closed", scheduledJobsEnabled: false, backupScheduleEnabled: false,
    freeAgentDraftRoutesEnabled: false, debugRoutesEnabled: false, nhlCompletedStatisticsEnabled: false,
    matchupProcessingEnabled: false, sportsDataIoLiveNhl: { mode: "disabled" } };
}
function count(database, table) { return database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count; }
function fixture(t) {
  const cleanups = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-first-admin-setup-"));
  assert(path.relative(ROOT, root).startsWith(".."));
  const file = path.join(root, "candidate.sqlite3"), opened = openDatabase({ databasePath: file, environment: "test" });
  try { migrateDatabase({ database: opened.database, migrationsDirectory: MIGRATIONS, applicationBuildId: BUILD, now: Date.now }); }
  finally { opened.database.close(); }
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
    BOOTSTRAP_ADMIN_EMAIL: "first-admin@example.test", BOOTSTRAP_ADMIN_DISPLAY_NAME: "Synthetic First Administrator" };
  const created = runBootstrapCommand({ argv: ["--app-env", "production", "--confirm-app-env", "production", "--database", file,
    "--migrations", MIGRATIONS, "--persistent-root", root, "--production-confirmation", PRODUCTION_CONFIRMATION], env, output: { log() {} } });
  const time = { now: Date.now() }, expiresAt = new Date(time.now + HOUR).toISOString();
  Object.assign(env, setupFields(created.userId, expiresAt));
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); assert(path.dirname(root) === fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, env, userId: created.userId, time, expiresAt, cleanups };
}
function open(f, { env = f.env, passwordHasher } = {}) {
  const config = loadTargetRuntimeConfig({ env, backendRoot: ROOT });
  const securityFoundations = createSecurityFoundations({ env, loadConfig: () => config.security, now: () => f.time.now, loggerSink() {} });
  const deliveries = [];
  const emailAdapter = { async sendEmailVerification() { assert.fail("Unexpected verification delivery"); },
    async sendAccountActionLink(message) { deliveries.push(message); return { accepted: true }; },
    async sendSecurityNotification(message) { deliveries.push(message); return { accepted: true }; } };
  const runtime = openDeployedTargetRuntime({ config, securityFoundations, emailAdapter,
    emailFetchImplementation() { assert.fail("No real email provider is permitted"); },
    networkSourceResolver: () => "127.0.0.1",
    ...(passwordHasher ? { createRuntimeFunction: options => createTargetRuntime({ ...options, passwordHasher }) } : {}) });
  f.cleanups.push(() => runtime.close());
  return { runtime, config, deliveries, cleanups: f.cleanups };
}
async function deliveredToken(r) {
  assert.equal(count(r.runtime.database, "outbox_events"), 1);
  const result = await r.runtime.services.accountEmail.deliveryService.deliverDue({ limit: 1 });
  assert.equal(result.length, 1); assert.equal(result[0].outcome, "published"); assert.equal(r.deliveries.length, 1);
  const link = new URL(r.deliveries[0].actionUrl); assert.equal(link.origin, ORIGIN); assert.equal(link.search, "");
  return new URLSearchParams(link.hash.slice(1)).get("token");
}
async function http(t, r) {
  const server = createTargetHttpServer({ runtime: r.runtime });
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  r.cleanups.push(() => server.close());
  return async (route, body, { method = "POST", origin = ORIGIN, cookie } = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method,
      headers: { Origin: origin, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const bodyIsJson = response.headers.get("content-type")?.includes("application/json");
    return { status: response.status, headers: response.headers, body: text && bodyIsJson ? JSON.parse(text) : null };
  };
}

test("first-administrator setup is opt-in and binds one production database, build, user and limited time", () => {
  const nowMs = Date.now(), config = minimalRuntimeConfig(), expiresAt = new Date(nowMs + HOUR).toISOString(), env = setupFields(USER, expiresAt);
  assert.equal(loadFirstAdministratorSetupConfig({ env: {}, runtimeConfig: config }), null);
  assert.equal(loadFirstAdministratorSetupConfig({ env: { FIRST_ADMINISTRATOR_SETUP_ENABLED: "false" }, runtimeConfig: config }), null);
  assert.deepEqual(loadFirstAdministratorSetupConfig({ env, runtimeConfig: config, nowMs }), { userId: USER, expiresAtMs: Date.parse(expiresAt), environmentId: ENVIRONMENT, databaseId: DATABASE, buildId: BUILD });
  for (const extra of [{ appEnv: "staging" }, { leagueWriteMode: "open" }, { scheduledJobsEnabled: true }, { backupScheduleEnabled: true },
    { freeAgentDraftRoutesEnabled: true }, { debugRoutesEnabled: true }, { nhlCompletedStatisticsEnabled: true }, { matchupProcessingEnabled: true },
    { sportsDataIoLiveNhl: { mode: "required" } }, { environmentId: "another-environment" }, { databaseId: "another-database" }, { buildId: "b".repeat(40) }]) {
    assert.throws(() => loadFirstAdministratorSetupConfig({ env, runtimeConfig: { ...config, ...extra }, nowMs }), { code: "FIRST_ADMINISTRATOR_SETUP_CONFIG_INVALID" });
  }
  for (const extra of [{ FIRST_ADMINISTRATOR_SETUP_ENABLED: "1" }, { FIRST_ADMINISTRATOR_SETUP_USER_ID: "invalid" },
    { FIRST_ADMINISTRATOR_SETUP_CONFIRMATION: "true" }, { FIRST_ADMINISTRATOR_SETUP_EXPIRES_AT: new Date(nowMs).toISOString() },
    setupFields(USER, new Date(nowMs + MAX_SETUP_WINDOW_MS + 1).toISOString())]) {
    assert.throws(() => loadFirstAdministratorSetupConfig({ env: { ...env, ...extra }, runtimeConfig: config, nowMs }), { code: "FIRST_ADMINISTRATOR_SETUP_CONFIG_INVALID" });
  }
});

test("actual closed production HTTP completes only the first administrator, permits sign-in, and preserves league closure", async t => {
  const f = fixture(t), r = open(f), token = await deliveredToken(r), request = await http(t, r), password = "SyntheticOnly!" + crypto.randomBytes(12).toString("hex");
  const input = { token, password, passwordConfirmation: password }, db = r.runtime.database;
  assert.equal(r.runtime.runtimeConfig.firstAdministratorSetup.userId, f.userId);
  assert.equal(r.runtime.scheduler.start().status, "disabled");
  assert.equal((await request("/api/v1/accounts/credential-setups", input, { origin: "https://foreign.example.test" })).status, 403);
  assert.equal(count(db, "user_credentials"), 0);
  const otherId = crypto.randomUUID();r.runtime.repositories.users.insert({ id: otherId, email_normalized: "other@example.test", email_display: "other@example.test",
    display_name: "Other Synthetic", display_name_normalized: "other synthetic", status: "pending_credential_setup", created_at_ms: f.time.now, updated_at_ms: f.time.now, version: 1 });
  let otherToken;
  r.runtime.services.actionTokenService.issue({ userId: otherId, purpose: "administrator_setup", transactionHook(context) { otherToken = context.rawToken; } });
  const wrong = await request("/api/v1/accounts/credential-setups", { ...input, token: otherToken });
  assert.equal(wrong.status, 400); assert.equal(wrong.body.error.code, "CREDENTIAL_SETUP_INVALID"); assert.equal(count(db, "user_credentials"), 0);
  for (const route of ["/api/v1/accounts", "/api/v1/password-resets", "/api/v1/session/password"]) {
    assert.equal((await request(route, {})).status, 503, route);
  }
  assert.equal((await request("/api/v1/accounts/credential-setups/", input)).status, 404);
  const completed = await request("/api/v1/accounts/credential-setups", input);
  assert.equal(completed.status, 200); assert.equal(completed.body.data.signedOut, true); assert.equal(completed.headers.get("set-cookie"), null);
  assert.equal(completed.headers.get("cache-control"), "no-store");assert.equal(count(db, "user_credentials"), 1);assert.equal(count(db, "sessions"), 0);
  assert.equal(db.prepare("SELECT status FROM users WHERE id=?").get(otherId).status, "pending_credential_setup");
  assert.throws(() => open(f), { code: "FIRST_ADMINISTRATOR_SETUP_UNAVAILABLE" });
  const replay = await request("/api/v1/accounts/credential-setups", input);assert.equal(replay.status, 400);assert.equal(replay.body.error.code, "CREDENTIAL_SETUP_INVALID");
  const login = await request("/api/v1/session", { email: f.env.BOOTSTRAP_ADMIN_EMAIL, password });
  assert.equal(login.status, 200);assert(login.headers.get("set-cookie"));assert.equal(count(db, "sessions"), 1);
  assert.equal((await request(`/api/v1/leagues/${USER}/teams/${USER}/manager-assignment`, undefined, { method: "DELETE", cookie: login.headers.get("set-cookie").split(";")[0] })).status, 503);
  for (const table of ["teams", "contracts", "player_ownerships", "job_runs"]) assert.equal(count(db, table), 0, table);
  assert.equal(r.deliveries.length, 1); // Completion and sign-in notifications remain queued.
  assert.equal(count(db, "user_credentials"), 1);
});

test("without the explicit setup mode the existing closed HTTP gate remains unchanged", async t => {
  const f = fixture(t), r = open(f, { env: { ...f.env, FIRST_ADMINISTRATOR_SETUP_ENABLED: "false" } });
  const token = await deliveredToken(r), request = await http(t, r), password = "SyntheticPassword123!";
  assert.equal((await request("/api/v1/accounts/credential-setups", { token, password, passwordConfirmation: password })).status, 503);
  assert.equal(count(r.runtime.database, "user_credentials"), 0);assert.equal(count(r.runtime.database, "sessions"), 0);
});

test("expiry during password hashing prevents the credential transaction and leaves the setup token usable", async t => {
  const f = fixture(t), r = open(f, { passwordHasher: { async hash() { f.time.now = Date.parse(f.expiresAt);return "unused-synthetic-hash"; }, async verify() { return { verified: false }; } } });
  const token = await deliveredToken(r), request = await http(t, r), password = "SyntheticPassword123!";
  const result = await request("/api/v1/accounts/credential-setups", { token, password, passwordConfirmation: password });
  assert.equal(result.status, 400);assert.equal(result.body.error.code, "CREDENTIAL_SETUP_INVALID");
  assert.equal(count(r.runtime.database, "user_credentials"), 0);assert.equal(count(r.runtime.database, "sessions"), 0);
  assert.equal(r.runtime.database.prepare("SELECT status FROM users WHERE id=?").get(f.userId).status, "pending_credential_setup");
  assert.equal(r.runtime.database.prepare("SELECT status FROM account_action_tokens WHERE user_id=?").get(f.userId).status, "active");
});

test("a changed administrator role during password hashing is checked before credentials are committed", async t => {
  const f = fixture(t);let r;
  r = open(f, { passwordHasher: { async hash() { r.runtime.database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE user_id=?").run(f.time.now, f.userId);return "unused-synthetic-hash"; }, async verify() { return { verified: false }; } } });
  const token = await deliveredToken(r), request = await http(t, r), password = "SyntheticPassword123!";
  assert.equal((await request("/api/v1/accounts/credential-setups", { token, password, passwordConfirmation: password })).status, 400);
  assert.equal(count(r.runtime.database, "user_credentials"), 0);assert.equal(r.runtime.database.prepare("SELECT status FROM account_action_tokens WHERE user_id=?").get(f.userId).status, "active");
});

test("setup runtime rejects a wrong selected user, wrong database or missing bootstrap audit before serving", async t => {
  const f = fixture(t);
  assert.throws(() => open(f, { env: { ...f.env, ...setupFields(crypto.randomUUID(), f.expiresAt) } }), { code: "FIRST_ADMINISTRATOR_SETUP_UNAVAILABLE" });
  assert.throws(() => open(f, { env: { ...f.env, DATABASE_ID: "different-database", ...setupFields(f.userId, f.expiresAt, ENVIRONMENT, "different-database") } }), { code: "DATABASE_IDENTITY_MISMATCH" });
  const opened = openDatabase({ databasePath: f.file, environment: "test" });
  try { opened.database.prepare("DELETE FROM security_audit_events WHERE event_type='system_bootstrap.platform_administrator_created'").run(); }
  finally { opened.database.close(); }
  assert.throws(() => open(f), { code: "FIRST_ADMINISTRATOR_SETUP_UNAVAILABLE" });
});
