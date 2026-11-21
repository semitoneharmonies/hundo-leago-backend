const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const express = require("express");
const Database = require("better-sqlite3");
const { discoverMigrations, applyMigrations } = require("../../src/infrastructure/database/migrate");
const { createSqliteRepositoryContext } = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createSqlitePlatformRoleRepository } = require("../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository");
const { createSqliteLeagueAccessRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const { createSqliteSecurityAuditRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createPlatformAuthorizationService } = require("../../src/application/services/authorization/requirePlatformAdministrator");
const { createLeagueAuthorizationService } = require("../../src/application/services/authorization/requireLeagueAuthority");
const { createSqlitePlatformAnnouncementRepository } = require("../../src/infrastructure/persistence/sqlite/SqlitePlatformAnnouncementRepository");
const { createSqliteLeagueCommunicationRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueCommunicationRepository");
const { createPlatformAnnouncementService } = require("../../src/application/services/activity/createPlatformAnnouncementService");
const { createPlatformAnnouncementRouter } = require("../../src/transport/http/createPlatformAnnouncementRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createSessionCookie } = require("../../src/transport/http/sessionCookie");
const { selectTargetRouterKey } = require("../../src/bootstrap/createTargetRuntime");

const NOW = Date.parse("2026-11-20T00:00:00Z");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const auth = n => ({ valid: true, user: { id: id(n), status: "active" }, session: { userId: id(n), id: id(n + 900) } });
const message = { kind: "announcement", title: "Site update", body: "An update for both leagues.",
  audience: "members", pinned: false, expiresAtMs: NOW + 60_000, notify: true, pushNotify: true };

function snapshot(db, excluded = []) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(row => !excluded.includes(row.name)).map(({ name }) => [name,
      db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));
}

function fixture(t) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  t.after(() => db.close());
  applyMigrations({ database: db, migrations: discoverMigrations({ migrationsDirectory: path.resolve(__dirname, "../../database/migrations") }),
    applicationBuildId: "platform-announcement-test", now: () => NOW });
  const r = createSqliteRepositoryContext({ database: db }).repositories;
  for (const n of [1, 2, 3, 4, 5]) r.users.insert({ id: id(n), email_normalized: `user${n}@example.test`,
    email_display: `user${n}@example.test`, display_name: `User ${n}`, display_name_normalized: `user ${n}`,
    status: n === 5 ? "disabled" : "active", created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
  r.sessions.insert({ id: auth(1).session.id, user_id: id(1), token_digest: "1".repeat(64),
    csrf_secret_digest: "2".repeat(64), status: "active", created_at_ms: NOW, last_used_at_ms: NOW,
    idle_expires_at_ms: NOW + 60_000, absolute_expires_at_ms: NOW + 120_000,
    revoked_at_ms: null, revocation_reason: null, client_metadata_json: null, version: 1 });
  function addLeague(n, commissioner = 3, members = [1, 2]) {
    r.leagues.insert({ id: id(n), name: `League ${n}`, name_normalized: `league ${n}`, status: "setup",
      timezone: "America/Vancouver", commissioner_membership_id: null, current_season_id: null,
      created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
    for (const user of [...new Set([...members, commissioner])]) r.league_memberships.insert({
      id: id(n * 100 + user), league_id: id(n), user_id: id(user),
      permission_category: user === commissioner ? "commissioner" : "member", status: "active",
      joined_at_ms: NOW, ended_at_ms: null, created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
    r.leagues.updateVersioned({ key: id(n), expectedVersion: 1,
      changes: { commissioner_membership_id: id(n * 100 + commissioner), updated_at_ms: NOW } });
  }
  addLeague(10, 3, [1, 2, 5]); addLeague(20, 4);
  r.platform_roles.insert({ id: id(100), user_id: id(1), role: "platform_administrator", status: "active",
    granted_by_user_id: null, granted_at_ms: NOW, ended_at_ms: null, version: 1 });
  const users = createSqliteUserRepository({ database: db });
  const platformAuthorization = createPlatformAuthorizationService({ userRepository: users,
    platformRoleRepository: createSqlitePlatformRoleRepository({ database: db }) });
  const leagueAuthorization = createLeagueAuthorizationService({ userRepository: users, platformAuthorization,
    leagueAccessRepository: createSqliteLeagueAccessRepository({ database: db }) });
  const repository = createSqlitePlatformAnnouncementRepository({ database: db });
  let time = NOW;
  const dependencies = { repository, platformAuthorization, leagueAuthorization,
    auditRepository: createSqliteSecurityAuditRepository({ database: db }), clock: { nowMs: () => time } };
  const service = createPlatformAnnouncementService(dependencies);
  const preview = (input = message) => service.preview({ authenticated: auth(1), input });
  const publish = (input = message, key = "broadcast-key-01", previewHash = preview(input).previewHash) =>
    service.publish({ authenticated: auth(1), input: { message: input, previewHash }, idempotencyKey: key });
  return { db, r, addLeague, service, repository, dependencies, preview, publish, setTime: value => { time = value; } };
}

test("administrator preview is read-only and counts unique people separately from league deliveries", t => {
  const f = fixture(t); const before = f.db.serialize();
  const p = f.preview();
  assert.deepEqual(p.leagues.map(row => row.recipientCount), [3, 3]);
  assert.equal(p.recipientCount, 6); assert.equal(p.uniqueRecipientCount, 4);
  assert.deepEqual(p.recipients.map(row => row.userId), [1, 2, 3, 4].map(id));
  assert.equal(p.scope, "all_leagues"); assert.match(p.previewHash, /^[a-f0-9]{64}$/);
  assert(f.db.serialize().equals(before));
  assert.equal(f.preview({ ...message, notify: false, pushNotify: false }).recipientCount, 0);
});

test("broadcast atomically creates both league announcements notifications audit and durable replay", t => {
  const f = fixture(t); const p = f.preview(); const before = snapshot(f.db);
  const sent = f.publish(message, "broadcast-key-01", p.previewHash);
  assert.equal(sent.leagues.length, 2); assert.equal(sent.recipientCount, 6); assert.equal(sent.uniqueRecipientCount, 4);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications").get().n, 6);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM league_communications WHERE push_notify=1").get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM security_audit_events WHERE event_type='platform.announcement_posted'").get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM idempotency_requests WHERE league_id IS NULL").get().n, 1);
  const changed = ["league_communications", "notifications", "security_audit_events", "idempotency_requests", "operational_events"];
  for (const name of changed) delete before[name];
  assert.deepEqual(snapshot(f.db, changed), before);
  const after = f.db.serialize();
  assert.deepEqual(f.publish(message, "broadcast-key-01", p.previewHash), { ...sent, replayed: true });
  assert(f.db.serialize().equals(after));
  assert.throws(() => f.publish({ ...message, body: "Different" }, "broadcast-key-01", p.previewHash), { code: "COMMUNICATION_KEY_CONFLICT" });
  const reader = createSqliteLeagueCommunicationRepository({ database: f.db });
  for (const league of sent.leagues) assert.equal(reader.list(league.leagueId, false, NOW)[0].body, message.body);
  assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});

test("new leagues and changed recipients invalidate confirmation with no partial writes", t => {
  const f = fixture(t); const p = f.preview();
  f.addLeague(30); const before = f.db.serialize();
  assert.throws(() => f.publish(message, "new-league-key", p.previewHash), { code: "COMMUNICATION_PREVIEW_CHANGED" });
  assert(f.db.serialize().equals(before));
  const revised = f.preview();
  f.db.prepare("UPDATE users SET status='disabled',version=version+1 WHERE id=?").run(id(2));
  const changed = f.db.serialize();
  assert.throws(() => f.publish(message, "changed-recipient", revised.previewHash), { code: "COMMUNICATION_PREVIEW_CHANGED" });
  assert(f.db.serialize().equals(changed));
});

test("replay returns original outcome after new league and expiry and surviving idempotency cleanup", t => {
  const f = fixture(t); const p = f.preview(); const sent = f.publish(message, "durable-key-01", p.previewHash);
  f.addLeague(30); f.setTime(NOW + 2 * 24 * 60 * 60 * 1000);
  f.db.prepare("DELETE FROM idempotency_requests WHERE league_id IS NULL").run();
  const before = f.db.serialize();
  assert.deepEqual(f.publish(message, "durable-key-01", p.previewHash), { ...sent, replayed: true });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM league_communications WHERE league_id=?").get(id(30)).n, 0);
  assert(f.db.serialize().equals(before));
  f.db.prepare("UPDATE leagues SET status='deleted',version=version+1 WHERE id=?").run(id(10));
  const deleted = f.db.serialize();
  assert.throws(() => f.publish(message, "durable-key-01", p.previewHash), { code: "LEAGUE_NOT_FOUND" });
  assert(f.db.serialize().equals(deleted));
});

test("current admin role and canonical protected membership are required for preview publish and replay", t => {
  const f = fixture(t); const p = f.preview(); const sent = f.publish(message, "permission-key", p.previewHash);
  const before = f.db.serialize();
  for (const actor of [2, 3, 4]) assert.throws(() => f.service.preview({ authenticated: auth(actor), input: message }),
    { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  for (const permissionCategory of ["manager", "commissioner", "missing"]) {
    const service = createPlatformAnnouncementService({ ...f.dependencies,
      leagueAuthorization: { requireCommissioner(a, leagueId) {
        if (permissionCategory === "missing") throw Object.assign(Error("Missing protected membership"), { code: "LEAGUE_NOT_FOUND" });
        return { ...f.dependencies.leagueAuthorization.requireCommissioner(a, leagueId), permissionCategory };
      } } });
    assert.throws(() => service.preview({ authenticated: auth(1), input: message }), { code: "LEAGUE_NOT_FOUND" });
    assert.throws(() => service.publish({ authenticated: auth(1), input: { message, previewHash: p.previewHash }, idempotencyKey: "permission-key" }),
      { code: "LEAGUE_NOT_FOUND" });
  }
  assert(f.db.serialize().equals(before));
  f.db.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE user_id=?").run(NOW, id(1));
  const revoked = f.db.serialize();
  assert.throws(() => f.publish(message, "permission-key", p.previewHash), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  assert(f.db.serialize().equals(revoked)); assert(sent.id);
});

test("any second-league notification or audit failure rolls back every broadcast row", t => {
  const f = fixture(t); const p = f.preview(); const before = f.db.serialize();
  for (const kind of ["notification", "audit", "receipt"]) {
    const service = createPlatformAnnouncementService({ ...f.dependencies,
      repository: { ...f.repository,
        notify(row) { if (kind === "notification" && row.leagueId === id(20)) throw Error("synthetic failure"); return f.repository.notify(row); },
        saveIdempotency(row) { if (kind === "receipt") throw Error("synthetic failure"); return f.repository.saveIdempotency(row); } },
      auditRepository: { append(row) { if (kind === "audit" && row.league_id === id(20)) throw Error("synthetic failure"); return f.dependencies.auditRepository.append(row); } },
    });
    assert.throws(() => service.publish({ authenticated: auth(1), input: { message, previewHash: p.previewHash }, idempotencyKey: `rollback-${kind}` }), /synthetic failure/);
    assert(f.db.serialize().equals(before));
  }
});

test("invalid or expired announcements and empty league scope cannot write", t => {
  const f = fixture(t); const before = f.db.serialize();
  for (const input of [{ ...message, title: "" }, { ...message, expiresAtMs: NOW },
    { ...message, audience: "managers" }, { ...message, kind: "reminder", pinned: false, expiresAtMs: null, pushNotify: false }]) {
    assert.throws(() => f.preview(input), { code: "COMMUNICATION_INVALID" });
  }
  const empty = createPlatformAnnouncementService({ ...f.dependencies, repository: { ...f.repository, targets: () => [] } });
  assert.throws(() => empty.preview({ authenticated: auth(1), input: message }), { code: "COMMUNICATION_NO_RECIPIENTS" });
  assert(f.db.serialize().equals(before));
});

test("admin HTTP routes retain Origin CSRF and session boundaries and preview writes nothing", async t => {
  const f = fixture(t); const origin = "http://localhost:5173";
  const cookie = createSessionCookie({ appEnv: "local", publicFrontendOrigin: origin, sameSite: "lax" });
  const token = Buffer.alloc(32, 97).toString("base64url"); const csrf = Buffer.alloc(32, 98).toString("base64url");
  const security = createTargetRequestSecurity({ sessionCookie: cookie, isAllowedOrigin: value => value === origin,
    requestIdFactory: () => "platform-announcement-test", sessionService: {
      bootstrap: value => value === token ? auth(1) : { valid: false },
      resolveWithCsrf: value => value.rawSessionToken !== token ? { valid: false, code: "SESSION_INVALID" }
        : value.rawCsrfToken !== csrf ? { valid: false, code: "CSRF_INVALID" } : auth(1),
    } });
  const app = express(); app.use(createPlatformAnnouncementRouter({ requestSecurity: security, service: f.service }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/admin/announcements`;
  const headers = { Origin: origin, "Content-Type": "application/json", Cookie: `${cookie.name}=${token}`, "X-CSRF-Token": csrf, "Idempotency-Key": "http-broadcast-01" };
  const before = f.db.serialize();
  for (const [change, status] of [[{ Origin: "https://untrusted.example" }, 403], [{ "X-CSRF-Token": "bad" }, 403], [{ Cookie: "" }, 401]]) {
    const response = await fetch(`${base}/preview`, { method: "POST", headers: { ...headers, ...change }, body: JSON.stringify(message) });
    assert.equal(response.status, status);
  }
  const preview = await fetch(`${base}/preview`, { method: "POST", headers, body: JSON.stringify(message) });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
  const p = (await preview.json()).data; assert(f.db.serialize().equals(before));
  const publish = await fetch(base, { method: "POST", headers, body: JSON.stringify({ message, previewHash: p.previewHash }) });
  assert.equal(publish.status, 200); assert.equal((await publish.json()).data.leagues.length, 2);
  for (const suffix of ["", "/preview"]) {
    assert.equal(selectTargetRouterKey("POST", `/api/v1/admin/announcements${suffix}`), "platformAnnouncement");
    assert.equal(selectTargetRouterKey("OPTIONS", `/api/v1/admin/announcements${suffix}`, "POST"), "platformAnnouncement");
  }
});
