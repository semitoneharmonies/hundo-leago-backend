const assert = require("node:assert/strict");
const { before, test } = require("node:test");
const crypto = require("node:crypto");
const path = require("node:path");
const Database = require("better-sqlite3");
const express = require("express");
const { migrateDatabase, discoverMigrations, applyMigrations } = require("../../src/infrastructure/database/migrate");
const { seedFixture } = require("../../src/operations/release/createReleaseQaFixture");
const { createSqliteRepositoryContext } = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const { createSqliteLeagueDeletionRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueDeletionRepository");
const { createSqliteSecurityAuditRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createSqlitePlatformRoleRepository } = require("../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository");
const { createPlatformAuthorizationService } = require("../../src/application/services/authorization/requirePlatformAdministrator");
const { createLeagueDeletionService } = require("../../src/application/services/leagues/createLeagueDeletionService");
const { createPlatformAdministrationRouter } = require("../../src/transport/http/createPlatformAdministrationRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createSessionCookie } = require("../../src/transport/http/sessionCookie");
const { selectTargetRouterKey } = require("../../src/bootstrap/createTargetRuntime");

let fixture;
before(async () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateDatabase({ database: db, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "league-deletion-test" });
  const seeded = db.transaction(() => seedFixture(db, "test-only-unused-password-hash")).immediate();
  await Promise.all(seeded.acceptancePromises);
  seeded.assertLateLockCoverage();
  fixture = db.serialize();
  db.close();
});

function setup(t, overrides = {}, fixtureBytes = fixture) {
  const db = new Database(fixtureBytes);
  db.pragma("foreign_keys = ON");
  t.after(() => db.close());
  const context = createSqliteRepositoryContext({ database: db });
  const actor = db.prepare("SELECT user_id FROM platform_roles WHERE status = 'active'").get().user_id;
  const sessionId = crypto.randomUUID();
  const now = Date.parse("2026-09-20T12:00:00Z");
  context.repositories.sessions.insert({
    id: sessionId, user_id: actor, token_digest: "a".repeat(64), csrf_secret_digest: "b".repeat(64),
    status: "active", created_at_ms: now, last_used_at_ms: now, idle_expires_at_ms: now + 3600000,
    absolute_expires_at_ms: now + 7200000, revoked_at_ms: null, revocation_reason: null,
    client_metadata_json: null, version: 1,
  });
  const authenticated = { valid: true, user: { id: actor }, session: { id: sessionId, userId: actor } };
  const leagueId = db.prepare("SELECT id FROM leagues ORDER BY name LIMIT 1").get().id;
  const repository = createSqliteLeagueDeletionRepository({ database: db });
  const serviceOptions = {
    repositoryContext: context, repository,
    platformAuthorization: createPlatformAuthorizationService({
      userRepository: createSqliteUserRepository({ database: db }),
      platformRoleRepository: createSqlitePlatformRoleRepository({ database: db }),
    }),
    auditRepository: createSqliteSecurityAuditRepository({ database: db }),
    clock: { nowMs: () => now }, secureRandom: { id: crypto.randomUUID }, ...overrides,
  };
  const service = createLeagueDeletionService(serviceOptions);
  function command(targetLeagueId = leagueId) {
    const leagueId = targetLeagueId;
    const preview = service.preview({ authenticated, leagueId });
    return { authenticated, leagueId, idempotencyKey: "league-delete-test",
      input: { confirmed: true, leagueName: preview.league.name, previewHash: preview.previewHash } };
  }
  return { db, service, serviceOptions, repository, context, authenticated, leagueId, command };
}

function rows(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function triggers(db) {
  return db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
}

test("preview is read-only; populated deletion preserves every unrelated row and all schema guards", (t) => {
  const r = setup(t);
  const backupId = crypto.randomUUID();
  const migrationId = crypto.randomUUID();
  r.context.repositories.backup_catalog.insert({
    id: backupId, league_id: r.leagueId, environment_identity: "test", backup_kind: "manual",
    storage_reference: "test://existing-backup-no-file", database_checksum: "c".repeat(64), schema_version: 57,
    source_database_id: null, status: "verified", created_at_ms: 1, verified_at_ms: 2, metadata_json: "{}",
  });
  r.context.repositories.migration_reports.insert({
    id: migrationId, league_id: r.leagueId, source_bundle_id: "test-existing-report", reset_manifest_id: null,
    database_schema_version: 57, status: "succeeded", source_hashes_json: "{}", counts_json: "{}", totals_json: "{}",
    warnings_json: "[]", rejects_json: "[]", started_at_ms: 1, completed_at_ms: 2, created_at_ms: 1,
  });
  const beforeRows = rows(r.db);
  const beforeTriggers = triggers(r.db);
  const command = r.command();
  assert.deepEqual(rows(r.db), beforeRows);
  const result = r.service.remove(command);
  assert.equal(result.code, "LEAGUE_DELETED");
  assert.ok(result.deletedRecords > 50);
  const afterRows = rows(r.db);
  const retained = new Set(["backup_catalog", "migration_reports", "security_audit_events"]);
  for (const [table, original] of Object.entries(beforeRows)) {
    const expected = original.filter((row) => table === "leagues" ? row.id !== r.leagueId : retained.has(table) || row.league_id !== r.leagueId)
      .map((row) => retained.has(table) && row.league_id === r.leagueId ? { ...row, league_id: null } : row);
    const ids = new Set(original.map((row) => row.id));
    const actual = ["operational_events", "security_audit_events", "idempotency_requests"].includes(table)
      ? afterRows[table].filter((row) => ids.has(row.id)) : afterRows[table];
    assert.deepEqual(actual, expected, `${table} must preserve all unrelated records`);
  }
  assert.deepEqual(triggers(r.db), beforeTriggers);
  assert.deepEqual(r.db.pragma("foreign_key_check"), []);
  assert.equal(r.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(r.db.pragma("defer_foreign_keys", { simple: true }), 0);
  const receipt = r.db.prepare("SELECT * FROM operational_events WHERE event_type='platform_administration.league_deleted'").get();
  assert.equal(receipt.league_id, null);
  assert.equal(JSON.parse(receipt.details_json).result.league.id, r.leagueId);
  assert.deepEqual(JSON.parse(receipt.details_json).retainedEvidence.backup_catalog, [backupId]);
  assert.deepEqual(JSON.parse(receipt.details_json).retainedEvidence.migration_reports, [migrationId]);
  assert.deepEqual(r.service.remove(command), result);
  assert.deepEqual(rows(r.db), afterRows, "lost-response retry must be read-only");
  assert.throws(() => r.service.remove({ ...command, leagueId: crypto.randomUUID() }), { code: "IDEMPOTENCY_KEY_REUSED" });
});

test("upgrading the historical staging allocation schema preserves atomic deletion", async (t) => {
  const legacy = new Database(":memory:");
  legacy.pragma("foreign_keys = ON");
  const migrationsDirectory = path.resolve(__dirname, "../../database/migrations");
  const migrations = discoverMigrations({ migrationsDirectory });
  applyMigrations({ database: legacy, migrations: migrations.filter(({ id }) => id <= 57), applicationBuildId: "historical-staging-test" });
  const table = "free_agent_draft_player_allocations";
  const original = legacy.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table).sql;
  const historical = original.replace(`CREATE TABLE ${table}`, `CREATE TABLE "${table}"`)
    .replace("\n      AND (\n        restricted_minimum_term_years = 1\n        OR restricted_minimum_total_cents % 100 = 0\n      )", "");
  assert.notEqual(historical, original);
  // Reproduce the exact previously rebuilt table definition only in this
  // disposable in-memory fixture. Runtime deletion never edits sqlite_schema.
  legacy.unsafeMode(true);
  try {
    legacy.pragma("writable_schema = ON");
    legacy.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = ?").run(historical, table);
  } finally {
    legacy.pragma("writable_schema = OFF");
    legacy.unsafeMode(false);
  }
  legacy.pragma(`schema_version = ${legacy.pragma("schema_version", { simple: true }) + 1}`);
  migrateDatabase({ database: legacy, migrationsDirectory, applicationBuildId: "staging-trade-upgrade-test" });
  const seeded = legacy.transaction(() => seedFixture(legacy, "test-only-unused-password-hash")).immediate();
  await Promise.all(seeded.acceptancePromises);
  seeded.assertLateLockCoverage();
  const bytes = legacy.serialize();
  legacy.close();
  const r = setup(t, {}, bytes);
  const before = rows(r.db);
  const guards = triggers(r.db);
  const result = r.service.remove(r.command());
  assert.equal(result.code, "LEAGUE_DELETED");
  assert.equal(r.db.prepare("SELECT count(*) n FROM leagues WHERE id = ?").get(r.leagueId).n, 0);
  assert.deepEqual(triggers(r.db), guards);
  assert.deepEqual(rows(r.db).users, before.users);
  assert.deepEqual(rows(r.db).players, before.players);
  assert.deepEqual(r.db.pragma("foreign_key_check"), []);
});

test("normal managers/commissioners and revoked admins cannot preview or delete", (t) => {
  const r = setup(t);
  const command = r.command();
  for (const { user_id } of r.db.prepare("SELECT DISTINCT user_id FROM league_memberships WHERE user_id <> ?").all(r.authenticated.user.id)) {
    const authenticated = { ...r.authenticated, user: { id: user_id }, session: { ...r.authenticated.session, userId: user_id } };
    assert.throws(() => r.service.preview({ authenticated, leagueId: r.leagueId }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
    assert.throws(() => r.service.remove({ ...command, authenticated }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  }
  r.db.prepare("UPDATE platform_roles SET status='ended', ended_at_ms=granted_at_ms WHERE user_id=?").run(r.authenticated.user.id);
  const beforeRows = rows(r.db);
  assert.throws(() => r.service.remove(command), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  assert.deepEqual(rows(r.db), beforeRows);
});

test("confirmation, missing membership, stale content and busy jobs fail without deletion", (t) => {
  const r = setup(t);
  const command = r.command();
  for (const input of [null, {}, { ...command.input, confirmed: false }, { ...command.input, confirmed: "true" }]) {
    assert.throws(() => r.service.remove({ ...command, input }), { code: "LEAGUE_DELETION_INVALID" });
  }
  assert.throws(() => r.service.remove({ ...command, input: { ...command.input, leagueName: "Wrong league" } }), { code: "LEAGUE_DELETION_PREVIEW_CHANGED" });
  r.db.prepare("UPDATE teams SET name=name || ' renamed' WHERE league_id=?").run(r.leagueId);
  assert.throws(() => r.service.remove(command), { code: "LEAGUE_DELETION_PREVIEW_CHANGED" });
  r.db.prepare("INSERT INTO job_runs (id, league_id, job_type, occurrence_key, scheduled_for_ms, status, created_at_ms, updated_at_ms) VALUES (?, ?, 'league_deletion_test', 'test', 1, 'running', 1, 1)").run(crypto.randomUUID(), r.leagueId);
  const busyCommand = r.command();
  assert.throws(() => r.service.remove(busyCommand), { code: "LEAGUE_DELETION_BUSY" });
  r.db.prepare("DELETE FROM league_memberships WHERE league_id=? AND user_id=?").run(r.leagueId, r.authenticated.user.id);
  assert.throws(() => r.service.preview({ authenticated: r.authenticated, leagueId: r.leagueId }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
});

test("late deletion failure rolls back erased rows, receipts and suspended triggers", (t) => {
  const r = setup(t);
  const service = createLeagueDeletionService({ ...r.serviceOptions, repository: {
    ...r.repository, erase(leagueId) { r.repository.erase(leagueId); throw new Error("Failure after all rows were erased"); },
  } });
  const beforeRows = rows(r.db);
  const beforeTriggers = triggers(r.db);
  assert.throws(() => service.remove(r.command()));
  assert.deepEqual(rows(r.db), beforeRows);
  assert.deepEqual(triggers(r.db), beforeTriggers);
  assert.deepEqual(r.db.pragma("foreign_key_check"), []);
  assert.equal(r.db.pragma("defer_foreign_keys", { simple: true }), 0);
});

test("an unreviewed schema change fails closed instead of bypassing new protections", (t) => {
  const r = setup(t);
  const command = r.command();
  r.db.exec("CREATE TRIGGER new_league_safety BEFORE DELETE ON teams BEGIN SELECT RAISE(ABORT, 'new protection'); END");
  const beforeRows = rows(r.db);
  assert.throws(() => r.service.remove(command), { code: "LEAGUE_DELETION_SCHEMA_CHANGED" });
  assert.deepEqual(rows(r.db), beforeRows);
});

test("each fixture league, including draft history, can be deleted independently", (t) => {
  const inventory = setup(t).db.prepare("SELECT id, name FROM leagues ORDER BY name").all();
  for (const league of inventory) {
    const r = setup(t);
    const result = r.service.remove(r.command(league.id));
    assert.equal(result.league.id, league.id, league.name);
    assert.deepEqual(r.db.pragma("foreign_key_check"), [], league.name);
    assert.equal(r.db.prepare("SELECT count(*) AS count FROM leagues").get().count, inventory.length - 1);
  }
});

test("audit failure cannot delete league content", (t) => {
  const r = setup(t, { auditRepository: { append() { throw new Error("Audit unavailable"); } } });
  const beforeRows = rows(r.db);
  assert.throws(() => r.service.remove(r.command()));
  assert.deepEqual(rows(r.db), beforeRows);
});

test("in-flight league event publication blocks deletion without affecting shared work", (t) => {
  const r = setup(t);
  const event = r.db.prepare("SELECT id FROM outbox_events WHERE league_id=? LIMIT 1").get(r.leagueId);
  assert.ok(event, "the fixture includes a league event");
  r.db.prepare("UPDATE outbox_events SET status='publishing' WHERE id=?").run(event.id);
  const beforeRows = rows(r.db);
  assert.throws(() => r.service.remove(r.command()), { code: "LEAGUE_DELETION_BUSY" });
  assert.deepEqual(rows(r.db), beforeRows);
});

test("actual HTTP security protects preview and DELETE, with registered target routes", async (t) => {
  const r = setup(t);
  const origin = "https://hundo.example";
  const token = Buffer.alloc(32, 1).toString("base64url");
  const csrf = Buffer.alloc(32, 2).toString("base64url");
  const cookie = createSessionCookie({ appEnv: "staging", publicFrontendOrigin: origin, sameSite: "none" });
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin: (value) => value === origin, requestIdFactory: () => "league-delete-http", sessionCookie: cookie,
    sessionService: {
      bootstrap: (rawSessionToken) => rawSessionToken === token ? r.authenticated : { valid: false, code: "SESSION_INVALID" },
      resolveWithCsrf: ({ rawSessionToken, rawCsrfToken }) => rawSessionToken === token && rawCsrfToken === csrf ? r.authenticated : { valid: false, code: "CSRF_INVALID" },
    },
  });
  const app = express();
  app.use(createPlatformAdministrationRouter({ requestSecurity, leagueDeletionService: r.service,
    leagueCreationService: { create() {}, listUsers() {} },
    auditPrivacyDigest: { digest: () => ({ digest: "a".repeat(64), keyVersion: 1 }) },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const route = `/api/v1/admin/leagues/${r.leagueId}`;
  assert.equal(selectTargetRouterKey("DELETE", route), "platformAdministration");
  assert.equal(selectTargetRouterKey("GET", `${route}/deletion-preview`), "platformAdministration");
  const url = `http://127.0.0.1:${server.address().port}${route}`;
  const headers = { origin, "content-type": "application/json", "x-csrf-token": csrf,
    "idempotency-key": "http-delete", cookie: `${cookie.name}=${token}` };
  const anonymous = await fetch(`${url}/deletion-preview`, { headers: { origin } });
  assert.equal(anonymous.status, 401);
  const preview = await fetch(`${url}/deletion-preview`, { headers });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  const command = r.command();
  const unconfirmed = await fetch(url, { method: "DELETE", headers,
    body: JSON.stringify({ ...command.input, confirmed: false }) });
  assert.equal(unconfirmed.status, 400);
  for (const badHeaders of [{ ...headers, "x-csrf-token": "bad" }, { ...headers, origin: "https://evil.example" }]) {
    const denied = await fetch(url, { method: "DELETE", headers: badHeaders, body: JSON.stringify(command.input) });
    assert.equal(denied.status, 403);
  }
  const removed = await fetch(url, { method: "DELETE", headers, body: JSON.stringify(command.input) });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).data.code, "LEAGUE_DELETED");
  const missing = await fetch(`${url}/deletion-preview`, { headers });
  assert.equal(missing.status, 404);
});
