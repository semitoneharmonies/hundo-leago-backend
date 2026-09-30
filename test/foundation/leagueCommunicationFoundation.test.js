const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const Database = require("better-sqlite3");
const { discoverMigrations, applyMigrations } = require("../../src/infrastructure/database/migrate");
const { createSqliteRepositoryContext } = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createSqliteLeagueAccessRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const { createLeagueAuthorizationService } = require("../../src/application/services/authorization/requireLeagueAuthority");
const { createSqliteLeagueCommunicationRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueCommunicationRepository");
const { createLeagueCommunicationService } = require("../../src/application/services/leagues/createLeagueCommunicationService");
const { selectTargetRouterKey } = require("../../src/bootstrap/createTargetRuntime");

const NOW = Date.parse("2026-09-29T00:00:00Z");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const auth = n => ({ valid: true, user: { id: id(n), status: "active" }, session: { userId: id(n), id: id(n + 900) } });
const announcement = { kind: "announcement", title: "Draft update", body: "Please review the revised schedule.",
  audience: "members", pinned: true, expiresAtMs: NOW + 60_000, notify: true };

test("communication digests retain existing preview and retry hashes", () => {
  const { digest } = require("../../src/domain/leagues/leagueCommunicationPolicy");
  const { createHash } = require("node:crypto");
  for (const value of [announcement, null, { reason: "Révision 🏒", values: [0, false, "\ud800"] },
    { cards: Array.from({ length: 1000 }, (_, i) => ({ id: id(i), version: i + 1 })) }]) {
    assert.equal(digest(value), createHash("sha256").update(JSON.stringify(value)).digest("hex"));
  }
});

function snapshot(db, excluded = []) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.filter(row => !excluded.includes(row.name)).map(({ name }) =>
    [name, db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));
}

function fixture(t, { migrated = true, notificationWriter } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  t.after(() => db.close());
  const migrations = discoverMigrations({ migrationsDirectory: path.resolve(__dirname, "../../database/migrations") });
  const migrate = list => applyMigrations({ database: db, migrations: list, applicationBuildId: "communications-test", now: () => NOW });
  migrate(migrations.filter(m => m.id <= 66));
  const context = createSqliteRepositoryContext({ database: db });
  const r = context.repositories;
  for (const n of [1, 2, 3, 4]) r.users.insert({ id: id(n), email_normalized: `user${n}@example.test`,
    email_display: `user${n}@example.test`, display_name: `User ${n}`, display_name_normalized: `user ${n}`,
    status: "active", created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
  for (const n of [10, 20]) {
    r.leagues.insert({ id: id(n), name: `League ${n}`, name_normalized: `league ${n}`, status: "setup",
      timezone: "America/Vancouver", commissioner_membership_id: null, current_season_id: null,
      created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
    r.league_memberships.insert({ id: id(n + 100), league_id: id(n), user_id: id(n === 10 ? 1 : 3),
      permission_category: "commissioner", status: "active", joined_at_ms: NOW, ended_at_ms: null,
      created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
    r.leagues.updateVersioned({ key: id(n), expectedVersion: 1,
      changes: { commissioner_membership_id: id(n + 100), updated_at_ms: NOW } });
  }
  r.league_memberships.insert({ id: id(112), league_id: id(10), user_id: id(2), permission_category: "manager",
    status: "active", joined_at_ms: NOW, ended_at_ms: null, created_at_ms: NOW, updated_at_ms: NOW, version: 1 });
  const beforeMigration = snapshot(db, ["schema_migrations"]);
  if (!migrated) return { db, migrate, migrations, beforeMigration };
  migrate(migrations);
  let time = NOW;
  const authorization = createLeagueAuthorizationService({
    userRepository: createSqliteUserRepository({ database: db }),
    leagueAccessRepository: createSqliteLeagueAccessRepository({ database: db }),
  });
  const repository = createSqliteLeagueCommunicationRepository({ database: db, notificationWriter });
  const service = createLeagueCommunicationService({ repository, leagueAuthorization: authorization, clock: { nowMs: () => time } });
  const scope = { leagueId: id(10), authenticated: auth(1) };
  const preview = message => service.preview({ ...scope, input: message });
  const publish = (message = announcement, key = "message-0001", previewHash = preview(message).previewHash) =>
    service.publish({ ...scope, input: { message, previewHash }, idempotencyKey: key });
  return { db, service, repository, scope, preview, publish, beforeMigration, setTime: value => { time = value; } };
}

test("additive migration preserves existing records except exact schema metadata and is idempotent", t => {
  const f = fixture(t, { migrated: false });
  const communicationMigrations = f.migrations.filter(m => m.id <= 67);
  f.migrate(communicationMigrations);
  f.beforeMigration.application_metadata = f.beforeMigration.application_metadata.map(encoded => {
    const row = JSON.parse(encoded);
    if (row.metadata_key === "data_model_version") {
      assert.equal(row.metadata_value, "66");
      row.metadata_value = "67";
      row.updated_at_ms = Math.max(row.updated_at_ms, 67);
    }
    return JSON.stringify(row);
  }).sort();
  assert.deepEqual(snapshot(f.db, ["schema_migrations", "league_communications"]), f.beforeMigration);
  createSqliteRepositoryContext({ database: f.db });
  const after = snapshot(f.db);
  f.migrate(communicationMigrations);
  assert.deepEqual(snapshot(f.db), after);
  assert.deepEqual(f.db.pragma("foreign_key_check"), []);
  assert.equal(f.db.pragma("integrity_check", { simple: true }), "ok");
});

test("preview is read-only; send preserves all protected tables and retries exactly once", t => {
  const f = fixture(t);
  const before = snapshot(f.db);
  const p = f.preview(announcement);
  assert.deepEqual(p.recipients.map(r => r.displayName), ["User 1", "User 2"]);
  assert.deepEqual(snapshot(f.db), before);
  const sent = f.publish(announcement, "message-0001", p.previewHash);
  assert.equal(sent.recipientCount, 2);
  assert.equal(f.publish(announcement, "message-0001", p.previewHash).replayed, true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications").get().n, 2);
  const after = snapshot(f.db, ["league_communications", "notifications"]);
  delete before.league_communications; delete before.notifications;
  assert.deepEqual(after, before);
  assert.throws(() => f.publish({ ...announcement, body: "Changed" }, "message-0001"), { code: "COMMUNICATION_KEY_CONFLICT" });
});

test("manager cannot publish or inspect private reminders; other leagues cannot read", t => {
  const f = fixture(t);
  assert.throws(() => f.service.preview({ ...f.scope, authenticated: auth(2), input: announcement }), { code: "LEAGUE_COMMISSIONER_REQUIRED" });
  assert.throws(() => f.service.list({ ...f.scope, authenticated: auth(2), history: true }), { code: "LEAGUE_COMMISSIONER_REQUIRED" });
  assert.throws(() => f.service.list({ ...f.scope, authenticated: auth(3) }), { code: "LEAGUE_NOT_FOUND" });
  f.publish({ ...announcement, kind: "reminder", pinned: false, expiresAtMs: null });
  assert.deepEqual(f.service.list({ ...f.scope, authenticated: auth(2) }).messages, []);
  assert.equal(f.service.list({ ...f.scope, history: true }).messages.length, 1);
});

test("recipient changes and revoked authority invalidate confirmation", t => {
  const f = fixture(t);
  const p = f.preview(announcement);
  f.db.prepare("UPDATE users SET status='disabled', version=version+1 WHERE id=?").run(id(2));
  const before = snapshot(f.db);
  assert.throws(() => f.publish(announcement, "message-0001", p.previewHash), { code: "COMMUNICATION_PREVIEW_CHANGED" });
  assert.deepEqual(snapshot(f.db), before);
  f.db.prepare("UPDATE users SET status='disabled', version=version+1 WHERE id=?").run(id(1));
  assert.throws(() => f.publish(announcement, "message-0001", p.previewHash), { code: "LEAGUE_NOT_FOUND" });
});

test("notification failure rolls back the entire send", t => {
  const f = fixture(t, { notificationWriter: { insert() { throw new Error("synthetic notification failure"); } } });
  const before = snapshot(f.db);
  assert.throws(() => f.publish(), /synthetic notification failure/);
  assert.deepEqual(snapshot(f.db), before);
});

test("expiry and archive hide announcements while preserving audited history", t => {
  const f = fixture(t);
  const first = f.publish();
  assert.equal(f.service.list({ ...f.scope, authenticated: auth(2) }).messages[0].title, announcement.title);
  f.setTime(NOW + 60_000);
  assert.deepEqual(f.service.list(f.scope).messages, []);
  assert.equal(f.service.list({ ...f.scope, history: true }).messages.length, 1);
  f.setTime(NOW + 10);
  assert.throws(() => f.service.archive({ ...f.scope, id: first.id, input: { version: 2, confirmed: true } }), { code: "COMMUNICATION_PREVIEW_CHANGED" });
  f.service.archive({ ...f.scope, id: first.id, input: { version: 1, confirmed: true } });
  assert.deepEqual(f.service.list(f.scope).messages, []);
  const saved = f.db.prepare("SELECT * FROM league_communications WHERE id=?").get(first.id);
  assert.equal(saved.body, announcement.body);
  assert.equal(saved.archived_by_user_id, id(1));
  assert.equal(f.service.archive({ ...f.scope, id: first.id, input: { version: 1, confirmed: true } }).archived, true);
});

test("invalid inputs and empty recipient groups cannot write", t => {
  const f = fixture(t);
  const before = snapshot(f.db);
  for (const input of [{ ...announcement, title: " " }, { ...announcement, notify: "yes" },
    { ...announcement, expiresAtMs: NOW }, { ...announcement, userIds: [id(3)] },
    { ...announcement, kind: "reminder" }]) {
    assert.throws(() => f.preview(input), { code: "COMMUNICATION_INVALID" });
  }
  assert.throws(() => f.preview({ ...announcement, kind: "reminder", pinned: false, expiresAtMs: null,
    audience: "unfinished_cards" }), { code: "COMMUNICATION_NO_RECIPIENTS" });
  assert.deepEqual(snapshot(f.db), before);
});

test("card-progress read is private and never mutates league data", t => {
  const f = fixture(t);
  const before = snapshot(f.db);
  assert.deepEqual(f.service.readiness(f.scope), { leagueId: id(10), cards: [], total: 0, complete: 0, empty: 0 });
  assert.throws(() => f.service.readiness({ ...f.scope, authenticated: auth(2) }), { code: "LEAGUE_COMMISSIONER_REQUIRED" });
  assert.deepEqual(snapshot(f.db), before);
});

test("all communication endpoints are routed through the target security boundary", () => {
  for (const [method, suffix] of [["GET", ""], ["GET", "/history"], ["GET", "/card-progress"],
    ["POST", "/preview"], ["POST", ""], ["POST", `/${id(100)}/archive`]]) {
    const pathname = `/api/v1/leagues/${id(10)}/communications${suffix}`;
    assert.equal(selectTargetRouterKey(method, pathname), "leagueCommunication");
    assert.equal(selectTargetRouterKey("OPTIONS", pathname, method), "leagueCommunication");
  }
});
