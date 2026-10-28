const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const express = require("express");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { createSqliteRepositoryContext } = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const { createSqliteLeagueAnnouncementRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueAnnouncementRepository");
const { createSqliteLeagueAccessRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createSqliteSecurityAuditRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createLeagueAuthorizationService } = require("../../src/application/services/authorization/requireLeagueAuthority");
const { createLeagueAnnouncementService } = require("../../src/application/services/activity/createLeagueAnnouncementService");
const { createLeagueAnnouncementRouter } = require("../../src/transport/http/createLeagueAnnouncementRouter");
const { createSqliteLeagueCommunicationRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueCommunicationRepository");
const { createLeagueCommunicationService } = require("../../src/application/services/leagues/createLeagueCommunicationService");
const { createLeagueCommunicationRouter } = require("../../src/transport/http/createLeagueCommunicationRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createSessionCookie } = require("../../src/transport/http/sessionCookie");
const { selectTargetRouterKey } = require("../../src/bootstrap/createTargetRuntime");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LEAGUE = id(10), OTHER = id(11), COMMISSIONER = id(1), MANAGER = id(2), OUTSIDER = id(3);
const NOW = Date.parse("2026-10-02T09:00:00Z");
const authenticated = (userId) => ({ valid: true, session: { id: id(900 + Number(userId.slice(-1))), userId }, user: { id: userId, status: "active", version: 1 } });

function setup(t) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrateDatabase({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "announcement-test", now: () => NOW });
  t.after(() => database.close());
  const context = createSqliteRepositoryContext({ database });
  for (const [userId, name] of [[COMMISSIONER, "Commissioner"], [MANAGER, "Manager"], [OUTSIDER, "Other commissioner"]]) {
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
  const dependencies = {
    repositoryContext: context,
    repository: createSqliteLeagueAnnouncementRepository({ database }),
    leagueAuthorization: createLeagueAuthorizationService({ userRepository: createSqliteUserRepository({ database }), leagueAccessRepository: createSqliteLeagueAccessRepository({ database }) }),
    auditRepository: createSqliteSecurityAuditRepository({ database }), clock: { nowMs: () => NOW + 100 }, secureRandom: { id: crypto.randomUUID },
  };
  const service = createLeagueAnnouncementService(dependencies);
  const post = (body = "Lineup reminder\nSet your roster by Monday.", overrides = {}) => service.post({ leagueId: LEAGUE, input: { body }, authenticated: authenticated(COMMISSIONER), idempotencyKey: crypto.randomUUID(), ...overrides });
  return { database, context, dependencies, service, post };
}

test("announcements fail without writes when the historical schema has no announcement repository", (t) => {
  const r = setup(t);
  const service = createLeagueAnnouncementService({ ...r.dependencies, repository: null });
  const before = r.database.serialize();
  assert.throws(() => service.list({ leagueId: LEAGUE, authenticated: authenticated(MANAGER) }), { code: "ANNOUNCEMENT_UNAVAILABLE" });
  assert.throws(() => service.post({ leagueId: LEAGUE, input: { body: "Reminder" }, authenticated: authenticated(COMMISSIONER), idempotencyKey: crypto.randomUUID() }), { code: "ANNOUNCEMENT_UNAVAILABLE" });
  assert.throws(() => service.list({ leagueId: OTHER, authenticated: authenticated(MANAGER) }), { code: "LEAGUE_NOT_FOUND" });
  assert(before.equals(r.database.serialize()));
});

test("announcements persist with atomic audit, preserve all existing records, and manager reads are byte-for-byte read-only", (t) => {
  const r = setup(t);
  const tables = r.context.schemaTables.filter((table) => !["league_communications", "league_activity", "security_audit", "security_audit_events", "idempotency_requests"].includes(table));
  const before = tables.map((table) => [table, r.database.prepare(`SELECT * FROM "${table}"`).all()]);
  const posted = r.post();
  assert.equal(posted.announcement.authorName, "Commissioner");
  assert.equal(posted.announcement.version, 1);
  assert.equal(posted.announcement.body, "Lineup reminder\nSet your roster by Monday.");
  assert.deepEqual(tables.map((table) => [table, r.database.prepare(`SELECT * FROM "${table}"`).all()]), before);
  const saved = r.database.serialize();
  const page = r.service.list({ leagueId: LEAGUE, authenticated: authenticated(MANAGER) });
  assert.equal(page.announcements[0].id, posted.announcement.id);
  assert.equal(page.announcements[0].version, posted.announcement.version);
  assert(saved.equals(r.database.serialize()));
  const reopened = new Database(saved);
  t.after(() => reopened.close());
  assert.equal(createSqliteLeagueAnnouncementRepository({ database: reopened }).listPage({ leagueId: LEAGUE, limit: 10, cursor: null, nowMs: NOW + 100 }).rows.length, 1);
});

test("managers and other-league commissioners cannot post or read another league, including after membership revocation", (t) => {
  const r = setup(t);
  const before = r.database.serialize();
  assert.throws(() => r.post("Denied", { authenticated: authenticated(MANAGER) }), { code: "LEAGUE_COMMISSIONER_REQUIRED" });
  assert.throws(() => r.post("Denied", { authenticated: authenticated(OUTSIDER) }), { code: "LEAGUE_NOT_FOUND" });
  assert.throws(() => r.service.list({ leagueId: OTHER, authenticated: authenticated(MANAGER) }), { code: "LEAGUE_NOT_FOUND" });
  assert(before.equals(r.database.serialize()));
  r.post("Other league only", { leagueId: OTHER, authenticated: authenticated(OUTSIDER) });
  assert.deepEqual(r.service.list({ leagueId: LEAGUE, authenticated: authenticated(MANAGER) }).announcements, []);
  r.context.repositories.league_memberships.updateVersioned({ key: id(65), leagueId: LEAGUE, expectedVersion: 1, changes: { status: "ended", ended_at_ms: NOW + 100, updated_at_ms: NOW + 100 } });
  assert.throws(() => r.service.list({ leagueId: LEAGUE, authenticated: authenticated(MANAGER) }), { code: "LEAGUE_NOT_FOUND" });
});

test("validation and idempotency prevent empty, oversized, extra-field, duplicate and changed retries", (t) => {
  const r = setup(t);
  const before = r.database.serialize();
  for (const body of [" ", "x".repeat(2001), "x\u0000", null]) assert.throws(() => r.post(body), { code: "ANNOUNCEMENT_INPUT_INVALID" });
  assert.throws(() => r.post("valid", { input: { body: "valid", leagueId: OTHER } }), { code: "ANNOUNCEMENT_INPUT_INVALID" });
  assert.throws(() => r.post("valid", { idempotencyKey: undefined }), { code: "TEAM_INPUT_INVALID" });
  assert(before.equals(r.database.serialize()));
  const a = r.post("Only once", { idempotencyKey: "retry-key" });
  const posted = r.database.serialize();
  assert.deepEqual(r.post("Only once", { idempotencyKey: "retry-key" }), a);
  assert.throws(() => r.post("Changed", { idempotencyKey: "retry-key" }), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert(posted.equals(r.database.serialize()));
});

test("pagination filters announcements before the page limit and an audit failure rolls back the post", (t) => {
  const r = setup(t);
  for (let i = 0; i < 4; i++) r.post(`Announcement ${i}`);
  const first = r.service.list({ leagueId: LEAGUE, query: { limit: "2" }, authenticated: authenticated(MANAGER) });
  const next = r.service.list({ leagueId: LEAGUE, query: { limit: "2", cursor: first.page.nextCursor }, authenticated: authenticated(MANAGER) });
  assert.equal(new Set([...first.announcements, ...next.announcements].map((item) => item.id)).size, 4);
  assert.equal(next.page.nextCursor, null);
  const before = r.database.serialize();
  const failed = createLeagueAnnouncementService({ ...r.dependencies, auditRepository: { append() { throw new Error("Test failure"); } } });
  assert.throws(() => failed.post({ leagueId: LEAGUE, input: { body: "Must roll back" }, authenticated: authenticated(COMMISSIONER), idempotencyKey: "rollback" }));
  assert(before.equals(r.database.serialize()));
});

test("HTTP routes enforce origin, session, CSRF, membership and commissioner posting", async (t) => {
  const r = setup(t);
  const origin = "http://localhost:5173";
  const cookie = createSessionCookie({ appEnv: "local", publicFrontendOrigin: origin, sameSite: "lax" });
  const tokens = Object.fromEntries([COMMISSIONER, MANAGER, OUTSIDER].map((userId, i) => [Buffer.alloc(32, 97 + i).toString("base64url"), userId]));
  const csrf = Buffer.alloc(32, 100).toString("base64url");
  const security = createTargetRequestSecurity({ sessionCookie: cookie, isAllowedOrigin: (value) => value === origin, requestIdFactory: () => "announcement-test",
    sessionService: { bootstrap: (token) => tokens[token] ? authenticated(tokens[token]) : { valid: false },
      resolveWithCsrf: ({ rawSessionToken, rawCsrfToken }) => !tokens[rawSessionToken] ? { valid: false, code: "SESSION_INVALID" } : rawCsrfToken !== csrf ? { valid: false, code: "CSRF_INVALID" } : authenticated(tokens[rawSessionToken]) },
  });
  const app = express();
  app.use(createLeagueAnnouncementRouter({ requestSecurity: security, announcementService: r.service }));
  const communications = createLeagueCommunicationService({ repository: createSqliteLeagueCommunicationRepository({ database: r.database }), leagueAuthorization: r.dependencies.leagueAuthorization, clock: r.dependencies.clock });
  app.use(createLeagueCommunicationRouter({ requestSecurity: security, service: communications }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/leagues/${LEAGUE}/announcements`;
  const headers = (userId) => ({ Origin: origin, "Content-Type": "application/json", Cookie: `${cookie.name}=${Object.keys(tokens).find((token) => tokens[token] === userId)}`, "X-CSRF-Token": csrf, "Idempotency-Key": "http-post" });
  const before = r.database.serialize();
  for (const [changes, status] of [[{ headers: headers(MANAGER) }, 403], [{ headers: headers(OUTSIDER) }, 404], [{ headers: { ...headers(COMMISSIONER), "X-CSRF-Token": "bad" } }, 403], [{ headers: { ...headers(COMMISSIONER), Origin: "https://invalid.example" } }, 403], [{ headers: { Origin: origin, "Content-Type": "application/json" } }, 401]]) {
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ body: "Welcome" }), ...changes });
    assert.equal(response.status, status);
    assert(before.equals(r.database.serialize()));
  }
  assert.equal((await fetch(url, { method: "POST", headers: headers(COMMISSIONER), body: JSON.stringify({ body: "Welcome" }) })).status, 200);
  const saved = r.database.serialize();
  const read = await fetch(url, { headers: headers(MANAGER) });
  assert.equal(read.status, 200);
  const visible = (await read.json()).data.announcements[0];
  assert.equal(visible.body, "Welcome");
  assert.equal(visible.version, 1);
  assert(saved.equals(r.database.serialize()));
  for (const method of ["GET", "POST"]) assert.equal(selectTargetRouterKey(method, new URL(url).pathname), "leagueAnnouncement");

  const archiveUrl = url.replace(/announcements$/, `communications/${visible.id}/archive`);
  const archiveHeaders = (userId) => { const result = headers(userId); delete result["Idempotency-Key"]; return result; };
  const input = { version: visible.version, confirmed: true };
  for (const [changes, status] of [
    [{ headers: archiveHeaders(MANAGER) }, 403],
    [{ headers: archiveHeaders(OUTSIDER) }, 404],
    [{ headers: { ...archiveHeaders(COMMISSIONER), "X-CSRF-Token": "bad" } }, 403],
    [{ headers: { ...archiveHeaders(COMMISSIONER), Origin: "https://invalid.example" } }, 403],
    [{ headers: { Origin: origin, "Content-Type": "application/json" } }, 401],
    [{ body: JSON.stringify({ ...input, version: visible.version + 1 }) }, 409],
    [{ body: JSON.stringify({ confirmed: true }) }, 400],
    [{ body: JSON.stringify({ ...input, confirmed: false }) }, 400],
  ]) {
    const response = await fetch(archiveUrl, { method: "POST", headers: archiveHeaders(COMMISSIONER), body: JSON.stringify(input), ...changes });
    assert.equal(response.status, status);
    assert(saved.equals(r.database.serialize()), "Denied removal must not change stored data");
  }
  const foreign = await fetch(archiveUrl.replace(LEAGUE, OTHER), { method: "POST", headers: archiveHeaders(OUTSIDER), body: JSON.stringify(input) });
  assert.equal(foreign.status, 404);
  assert(saved.equals(r.database.serialize()));
  const tables = r.context.schemaTables.filter((table) => table !== "league_communications");
  const otherRecords = tables.map((table) => [table, r.database.prepare(`SELECT * FROM "${table}"`).all()]);
  const original = r.database.prepare("SELECT * FROM league_communications WHERE id=?").get(visible.id);
  const removed = await fetch(archiveUrl, { method: "POST", headers: archiveHeaders(COMMISSIONER), body: JSON.stringify(input) });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).data.archived, true);
  assert.deepEqual(r.database.prepare("SELECT * FROM league_communications WHERE id=?").get(visible.id), {
    ...original, archived_at_ms: NOW + 100, archived_by_user_id: COMMISSIONER, version: original.version + 1,
  });
  assert.deepEqual(tables.map((table) => [table, r.database.prepare(`SELECT * FROM "${table}"`).all()]), otherRecords);
  const archived = r.database.serialize();
  const repeated = await fetch(archiveUrl, { method: "POST", headers: archiveHeaders(COMMISSIONER), body: JSON.stringify(input) });
  assert.equal(repeated.status, 200);
  assert.deepEqual((await (await fetch(url, { headers: headers(MANAGER) })).json()).data.announcements, []);
  assert.deepEqual(communications.list({ leagueId: LEAGUE, authenticated: authenticated(MANAGER) }).messages, []);
  assert.equal(communications.list({ leagueId: LEAGUE, authenticated: authenticated(COMMISSIONER), history: true }).messages[0].body, "Welcome");
  assert(archived.equals(r.database.serialize()), "Repeat removal and subsequent reads must not write");
});

test("sidebar and commissioner announcements share storage and honour archiving and expiry", t => {
  const r = setup(t);
  const communications = createLeagueCommunicationService({ repository:createSqliteLeagueCommunicationRepository({database:r.database}),leagueAuthorization:r.dependencies.leagueAuthorization,clock:r.dependencies.clock });
  const auth=authenticated(COMMISSIONER), manager=authenticated(MANAGER);
  const sidebar=r.post('Shared from sidebar');
  assert.equal(communications.list({leagueId:LEAGUE,authenticated:manager}).messages[0].id,sidebar.announcement.id);
  const message={kind:'announcement',title:'Commissioner notice',body:'x'.repeat(2500),audience:'members',pinned:true,expiresAtMs:NOW+1000,notify:false};
  const preview=communications.preview({leagueId:LEAGUE,authenticated:auth,input:message});
  const saved=communications.publish({leagueId:LEAGUE,authenticated:auth,input:{message,previewHash:preview.previewHash},idempotencyKey:crypto.randomUUID()});
  const page=()=>r.service.list({leagueId:LEAGUE,authenticated:manager}).announcements;
  assert(page().some(a=>a.id===saved.id&&a.body===message.body));
  communications.archive({leagueId:LEAGUE,id:sidebar.announcement.id,authenticated:auth,input:{version:sidebar.announcement.version,confirmed:true}});
  assert(!page().some(a=>a.id===sidebar.announcement.id));
  r.dependencies.clock.nowMs=()=>NOW+1001;
  assert.deepEqual(page(),[]);
});

test("sidebar hides existing null-expiry announcements exactly after seven days without rewriting them", t => {
  const r = setup(t);
  const week = 7 * 24 * 60 * 60 * 1000;
  const first = r.post("Existing announcement without expiry").announcement;
  r.post("Other league notice", { leagueId: OTHER, authenticated: authenticated(OUTSIDER) });
  assert.equal(r.database.prepare("SELECT expires_at_ms FROM league_communications WHERE id=?").get(first.id).expires_at_ms, null);
  r.dependencies.clock.nowMs = () => first.createdAtMs + week - 1;
  const saved = r.database.serialize();
  const page = () => r.service.list({ leagueId: LEAGUE, authenticated: authenticated(MANAGER), query: { limit: "1" } });
  assert.deepEqual(page().announcements.map(row => row.id), [first.id]);
  r.dependencies.clock.nowMs = () => first.createdAtMs + week;
  assert.deepEqual(page().announcements, []);
  assert.equal(page().page.nextCursor, null);
  r.dependencies.clock.nowMs = () => first.createdAtMs + week + 1;
  assert.deepEqual(page().announcements, []);
  assert(saved.equals(r.database.serialize()));
});
