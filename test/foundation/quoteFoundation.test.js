const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const express = require("express");
const { migrateDatabase, applyMigrations, discoverMigrations } = require("../../src/infrastructure/database/migrate");
const { createSqliteRepositoryContext } = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const { createSqliteQuoteRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteQuoteRepository");
const { createSqliteLeagueAccessRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createSqliteSecurityAuditRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createLeagueAuthorizationService } = require("../../src/application/services/authorization/requireLeagueAuthority");
const { createQuoteService } = require("../../src/application/services/activity/createQuoteService");
const { createQuoteRouter } = require("../../src/transport/http/createQuoteRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createSessionCookie } = require("../../src/transport/http/sessionCookie");
const { selectTargetRouterKey } = require("../../src/bootstrap/createTargetRuntime");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LEAGUE = id(10), OTHER = id(11), COMMISSIONER = id(1), MANAGER = id(2), OUTSIDER = id(3), ADMIN = id(4);
const NOW = Date.parse("2026-10-02T09:00:00Z");
const authenticated = (userId) => ({ valid: true, session: { id: id(900 + Number(userId.slice(-1))), userId }, user: { id: userId, status: "active", version: 1 } });
const submit = (r, overrides = {}) => r.service.submit({ leagueId: LEAGUE, authenticated: authenticated(MANAGER), input: { text: "Skate where the puck is going.", author: "A hockey fan" }, idempotencyKey: crypto.randomUUID(), ...overrides });
const review = (r, item, overrides = {}) => r.service.review({ leagueId: LEAGUE, authenticated: authenticated(COMMISSIONER), quoteId: item.id, input: { decision: "approve", version: item.version }, idempotencyKey: crypto.randomUUID(), ...overrides });
const rotation = (r, leagueId = LEAGUE, userId = MANAGER, query) => r.service.rotation({ leagueId, authenticated: authenticated(userId), query });

test("quotes fail without writes when the historical schema has no quote repository", (t) => {
  const r = setup(t);
  r.service = createQuoteService({ ...r.dependencies, repository: null });
  const before = r.database.serialize();
  assert.throws(() => rotation(r), { code: "QUOTE_UNAVAILABLE" });
  assert.throws(() => submit(r), { code: "QUOTE_UNAVAILABLE" });
  assert.throws(() => rotation(r, OTHER), { code: "LEAGUE_NOT_FOUND" });
  assert(before.equals(r.database.serialize()));
});

test("additive migration preserves populated existing records and repeat migration is a no-op", (t) => {
  const database = new Database(":memory:");
  t.after(() => database.close());
  database.pragma("foreign_keys = ON");
  const migrations = discoverMigrations({ migrationsDirectory: path.resolve(__dirname, "../../database/migrations") });
  applyMigrations({ database, migrations: migrations.filter(({ id }) => id < 85), applicationBuildId: "quote-upgrade", now: () => NOW });
  database.prepare(`INSERT INTO users (id,email_normalized,email_display,display_name,display_name_normalized,status,created_at_ms,updated_at_ms,version)
    VALUES (?, 'existing@example.test', 'existing@example.test', 'Existing member', 'existing member', 'active', ?, ?, 1)`).run(MANAGER, NOW, NOW);
  database.prepare(`INSERT INTO leagues (id,name,name_normalized,status,timezone,commissioner_membership_id,current_season_id,created_at_ms,updated_at_ms,version)
    VALUES (?, 'Existing league', 'existing league', 'active', 'America/Vancouver', NULL, NULL, ?, ?, 1)`).run(LEAGUE, NOW, NOW);
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all();
  const snapshot = () => tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all()]);
  const before = snapshot();
  applyMigrations({ database, migrations, applicationBuildId: "quote-upgrade", now: () => NOW });
  assert.deepEqual(snapshot(), before);
  assert.equal(database.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key='data_model_version'").get().metadata_value, "85");
  assert.equal(database.pragma("user_version", { simple: true }), 85);
  assert.deepEqual(database.pragma("foreign_key_check"), []);
  const saved = database.serialize();
  applyMigrations({ database, migrations, applicationBuildId: "quote-upgrade", now: () => NOW });
  assert(saved.equals(database.serialize()));
  const repository = createSqliteQuoteRepository({ database });
  repository.insert({ id: id(99), source_league_id: LEAGUE, submitted_by_user_id: MANAGER, quote_text: "Shared beyond one league.", attribution: "Existing member", league_status: "pending", global_status: "approved", created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
  database.prepare("DELETE FROM leagues WHERE id = ?").run(LEAGUE);
  assert.equal(repository.find(id(99)).source_league_id, null);
  assert.equal(repository.listPage({ scope: "rotation", leagueId: OTHER, limit: 10, cursor: null }).rows[0].quote_text, "Shared beyond one league.");
});

function setup(t) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrateDatabase({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "announcement-test", now: () => NOW });
  t.after(() => database.close());
  const context = createSqliteRepositoryContext({ database });
  for (const [userId, name] of [[COMMISSIONER, "Commissioner"], [MANAGER, "Manager"], [OUTSIDER, "Other commissioner"], [ADMIN, "Administrator"]]) {
    context.repositories.users.insert({ id: userId, email_normalized: `${userId}@example.test`, email_display: `${userId}@example.test`, display_name: name, display_name_normalized: name.toLowerCase(), status: "active", created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
    context.repositories.sessions.insert({ id: authenticated(userId).session.id, user_id: userId, token_digest: userId.slice(-1).repeat(64), csrf_secret_digest: userId.slice(-1).repeat(64), status: "active", created_at_ms: NOW, last_used_at_ms: NOW, idle_expires_at_ms: NOW + 60000, absolute_expires_at_ms: NOW + 120000, revoked_at_ms: null, revocation_reason: null, client_metadata_json: null, version: 1 });
  }
  for (const [leagueId, name, commissioner] of [[LEAGUE, "Alpha", COMMISSIONER], [OTHER, "Bravo", OUTSIDER]]) {
    context.repositories.leagues.insert({ id: leagueId, name, name_normalized: name.toLowerCase(), status: "active", timezone: "America/Vancouver", commissioner_membership_id: null, current_season_id: null, created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
    const membershipId = id(Number(leagueId.slice(-2)) + 50);
    context.repositories.league_memberships.insert({ id: membershipId, league_id: leagueId, user_id: commissioner, permission_category: "commissioner", status: "active", joined_at_ms: NOW, ended_at_ms: null, created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
    context.repositories.leagues.updateVersioned({ key: leagueId, expectedVersion: 1, changes: { commissioner_membership_id: membershipId, updated_at_ms: NOW } });
  }
  context.repositories.league_memberships.insert({ id: id(65), league_id: LEAGUE, user_id: MANAGER, permission_category: "manager", status: "active", joined_at_ms: NOW, ended_at_ms: null, created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
  context.repositories.platform_roles.insert({ id: id(90), user_id: ADMIN, role: "platform_administrator", status: "active", granted_by_user_id: null, granted_at_ms: NOW, ended_at_ms: null, version: 1 });
  const { createPlatformAuthorizationService } = require("../../src/application/services/authorization/requirePlatformAdministrator");
  const { createSqlitePlatformRoleRepository } = require("../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository");
  const platformAuthorization = createPlatformAuthorizationService({ userRepository: createSqliteUserRepository({ database }), platformRoleRepository: createSqlitePlatformRoleRepository({ database }) });
  const dependencies = {
    platformAuthorization,
    repositoryContext: context,
    repository: createSqliteQuoteRepository({ database }),
    leagueAuthorization: createLeagueAuthorizationService({ userRepository: createSqliteUserRepository({ database }), leagueAccessRepository: createSqliteLeagueAccessRepository({ database }) }),
    auditRepository: createSqliteSecurityAuditRepository({ database }), clock: { nowMs: () => NOW + 100 }, secureRandom: { id: crypto.randomUUID },
  };
  const service = createQuoteService(dependencies);
  return { database, context, dependencies, service };
}

test("submission is pending; league approval stays local, global approval reaches other leagues without exposing private fields", (t) => {
  const r = setup(t);
  const protectedTables = r.context.schemaTables.filter((name) => !["quote_submissions", "idempotency_requests", "security_audit_events"].includes(name));
  const snapshot = () => protectedTables.map((name) => [name, r.database.prepare(`SELECT * FROM "${name}"`).all()]);
  const before = snapshot();
  const item = submit(r).quote;
  assert.equal(item.scope, "pending");
  assert.deepEqual(rotation(r).quotes, []);
  assert.equal(r.service.reviewQueue({ leagueId: LEAGUE, authenticated: authenticated(COMMISSIONER) }).quotes[0].submittedBy, "Manager");
  const local = review(r, item).quote;
  assert.equal(rotation(r).quotes[0].scope, "league");
  assert.deepEqual(rotation(r, OTHER, OUTSIDER).quotes, []);
  review(r, local, { global: true, leagueId: null, authenticated: authenticated(ADMIN) });
  assert.equal(rotation(r, OTHER, OUTSIDER).quotes[0].scope, "global");
  assert.deepEqual(Object.keys(rotation(r).quotes[0]).sort(), ["author", "id", "scope", "text"]);
  assert.deepEqual(snapshot(), before);
  const bytes = r.database.serialize();
  rotation(r);
  r.service.reviewQueue({ global: true, authenticated: authenticated(ADMIN) });
  assert(bytes.equals(r.database.serialize()));
  const reopened = new Database(bytes);
  t.after(() => reopened.close());
  assert.equal(createSqliteQuoteRepository({ database: reopened }).find(item.id).global_status, "approved");
});

test("managers cannot review; commissioners cannot read or approve outside their league or globally; revoked roles are checked", (t) => {
  const r = setup(t);
  const item = submit(r).quote;
  const saved = r.database.serialize();
  for (const user of [MANAGER, OUTSIDER]) {
    assert.throws(() => review(r, item, { authenticated: authenticated(user) }), { code: user === MANAGER ? "LEAGUE_COMMISSIONER_REQUIRED" : "LEAGUE_NOT_FOUND" });
    assert.throws(() => r.service.reviewQueue({ leagueId: LEAGUE, authenticated: authenticated(user) }));
  }
  assert.throws(() => review(r, item, { global: true, leagueId: null }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  assert.throws(() => review(r, item, { leagueId: OTHER, authenticated: authenticated(OUTSIDER) }), { code: "QUOTE_NOT_FOUND" });
  assert.throws(() => r.service.reviewQueue({ global: true, authenticated: authenticated(COMMISSIONER) }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  assert.throws(() => rotation(r, OTHER), { code: "LEAGUE_NOT_FOUND" });
  assert(saved.equals(r.database.serialize()));
  r.context.repositories.league_memberships.updateVersioned({ key: id(65), leagueId: LEAGUE, expectedVersion: 1, changes: { status: "ended", ended_at_ms: NOW + 1, updated_at_ms: NOW + 1 } });
  assert.throws(() => submit(r), { code: "LEAGUE_NOT_FOUND" });
  r.context.repositories.platform_roles.updateVersioned({ key: id(90), expectedVersion: 1, changes: { status: "ended", ended_at_ms: NOW + 1 } });
  assert.throws(() => review(r, item, { global: true, leagueId: null, authenticated: authenticated(ADMIN) }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
});

test("validation, exact retries, conflicting decisions and audit failure do not create extra writes", (t) => {
  const r = setup(t);
  const saved = r.database.serialize();
  for (const input of [{ text: "" }, { text: "a".repeat(501) }, { text: "Hi", author: "a".repeat(81) }, { text: "Hi\u0000" }, { text: "Hi", approved: true }, []]) assert.throws(() => submit(r, { input }), { code: "QUOTE_INPUT_INVALID" });
  assert(saved.equals(r.database.serialize()));
  const item = submit(r, { idempotencyKey: "same-submit" }).quote;
  const submitted = r.database.serialize();
  assert.equal(submit(r, { idempotencyKey: "same-submit" }).quote.id, item.id);
  assert.throws(() => submit(r, { idempotencyKey: "same-submit", input: { text: "Different" } }), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert(submitted.equals(r.database.serialize()));
  review(r, item, { idempotencyKey: "same-review" });
  const reviewed = r.database.serialize();
  review(r, item, { idempotencyKey: "same-review" });
  assert.throws(() => review(r, item), { code: "QUOTE_REVIEW_CONFLICT" });
  assert(reviewed.equals(r.database.serialize()));
  const failed = createQuoteService({ ...r.dependencies, auditRepository: { append() { throw new Error("Audit unavailable"); } } });
  assert.throws(() => submit({ service: failed }));
  assert(reviewed.equals(r.database.serialize()));
});

test("declined quotes stay out of the appropriate rotation and pagination never mixes pending content", (t) => {
  const r = setup(t);
  const declined = submit(r).quote;
  const rejected = review(r, declined, { input: { decision: "reject", version: declined.version } }).quote;
  assert.deepEqual(rotation(r).quotes, []);
  // Administrator can independently select a league-declined quote for everyone.
  review(r, rejected, { global: true, leagueId: null, authenticated: authenticated(ADMIN) });
  const a = submit(r).quote;
  const local = review(r, a).quote;
  review(r, local, { global: true, leagueId: null, authenticated: authenticated(ADMIN), input: { decision: "reject", version: local.version } });
  assert.equal(rotation(r).quotes.length, 2);
  assert.equal(rotation(r, OTHER, OUTSIDER).quotes.length, 1);
  submit(r, { input: { text: "Must remain pending" } });
  const first = rotation(r, LEAGUE, MANAGER, { limit: 1 });
  const second = rotation(r, LEAGUE, MANAGER, { limit: 1, cursor: first.page.nextCursor });
  assert(first.page.nextCursor);
  assert.equal(second.page.nextCursor, null);
  assert.notEqual(first.quotes[0].id, second.quotes[0].id);
});

test("HTTP quote routes enforce origin, session, CSRF and scoped approval", async (t) => {
  const r = setup(t);
  const origin = "http://localhost:5173";
  const cookie = createSessionCookie({ appEnv: "local", publicFrontendOrigin: origin, sameSite: "lax" });
  const tokens = Object.fromEntries([COMMISSIONER, MANAGER, OUTSIDER, ADMIN].map((userId, i) => [Buffer.alloc(32, 97 + i).toString("base64url"), userId]));
  const csrf = Buffer.alloc(32, 105).toString("base64url");
  const security = createTargetRequestSecurity({ sessionCookie: cookie, isAllowedOrigin: (value) => value === origin, requestIdFactory: () => "quote-test",
    sessionService: { bootstrap: (token) => tokens[token] ? authenticated(tokens[token]) : { valid: false },
      resolveWithCsrf: ({ rawSessionToken, rawCsrfToken }) => !tokens[rawSessionToken] ? { valid: false, code: "SESSION_INVALID" } : rawCsrfToken !== csrf ? { valid: false, code: "CSRF_INVALID" } : authenticated(tokens[rawSessionToken]) } });
  const app = express();
  app.use(createQuoteRouter({ requestSecurity: security, quoteService: r.service }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = `/api/v1/leagues/${LEAGUE}/quotes`;
  const headers = (userId) => ({ Origin: origin, "Content-Type": "application/json", Cookie: `${cookie.name}=${Object.keys(tokens).find((token) => tokens[token] === userId)}`, "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() });
  const before = r.database.serialize();
  for (const [changes, status] of [[{ ...headers(MANAGER), "X-CSRF-Token": "bad" }, 403], [{ ...headers(MANAGER), Origin: "https://invalid.example" }, 403], [{ Origin: origin, "Content-Type": "application/json" }, 401]]) {
    assert.equal((await fetch(base + path, { method: "POST", headers: changes, body: JSON.stringify({ text: "Welcome" }) })).status, status);
    assert(before.equals(r.database.serialize()));
  }
  const response = await fetch(base + path, { method: "POST", headers: headers(MANAGER), body: JSON.stringify({ text: "Welcome" }) });
  assert.equal(response.status, 200);
  const item = (await response.json()).data.quote;
  const adminPath = `/api/v1/admin/quote-submissions/${item.id}/review`;
  assert.equal((await fetch(base + adminPath, { method: "POST", headers: headers(COMMISSIONER), body: JSON.stringify({ decision: "approve", version: 1 }) })).status, 403);
  assert.equal((await fetch(base + adminPath, { method: "POST", headers: headers(ADMIN), body: JSON.stringify({ decision: "approve", version: 1 }) })).status, 200);
  assert.equal((await (await fetch(base + path, { headers: headers(MANAGER) })).json()).data.quotes[0].text, "Welcome");
  assert.equal(selectTargetRouterKey("GET", path), "quote");
  assert.equal(selectTargetRouterKey("POST", adminPath), "quote");
});
