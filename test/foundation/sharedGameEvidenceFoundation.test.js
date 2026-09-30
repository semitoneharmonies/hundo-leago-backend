const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Database = require("better-sqlite3");
const { migrateDatabase, discoverMigrations, applyMigrations } = require("../../src/infrastructure/database/migrate");
const { createSqliteSharedGameEvidenceRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSharedGameEvidenceRepository");
const { prepareGameCapture, prepareGameCaptureAsync } = require("../../src/domain/statistics/sharedGameEvidencePolicy");
const { hashCanonicalJsonV1, serializeCanonicalJsonV1, compareUnicodeScalarStrings } = require("../../src/domain/leagues/seasonRolloverEvidencePolicy");
const { emptyScoringStats, calculateExpandedScore, EXPANDED_SCORING_VERSION } = require("../../src/domain/statistics/expandedScoringPolicy");
const NOW = Date.parse("2026-12-20T12:00:00Z");
const DAY = 86_400_000;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrationsDirectory = path.resolve(__dirname, "../../database/migrations");

function fixture(t, { filename = ":memory:" } = {}) {
  const db = new Database(filename); db.pragma("foreign_keys=ON");
  t.after(() => { if (db.open) db.close(); });
  migrateDatabase({ database: db, migrationsDirectory, applicationBuildId: "shared-game-test", now: () => NOW });
  db.prepare("INSERT INTO stat_sources (id,provider,status,created_at_ms,updated_at_ms) VALUES (?, 'nhl-completed-games', 'active', ?, ?)").run(uuid(1), NOW, NOW);
  db.prepare("INSERT INTO players (id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms) VALUES (?, 'Test','Player','Test Player','2000-01-01','active',1,1)").run(uuid(2));
  let serial = 100;
  const insert = db.prepare("INSERT INTO stat_refreshes (id,stat_source_id,nhl_season_key,status,started_at_ms) VALUES (?,?,?,'started',?)");
  function command(records, { at = NOW + serial, statSourceId = uuid(1), nhlSeasonKey = "20262027" } = {}) {
    const refreshId = uuid(serial++); insert.run(refreshId, statSourceId, nhlSeasonKey, at);
    return { refreshId, statSourceId, nhlSeasonKey, observedAtMs: at, capturedAtMs: at + 1, records };
  }
  const repo = createSqliteSharedGameEvidenceRepository({ database: db });
  const counts = () => ({ captures: db.prepare("SELECT count(*) n FROM shared_game_evidence_captures").get().n, changes: db.prepare("SELECT count(*) n FROM shared_game_evidence_changes").get().n });
  return { db, repo, command, counts };
}
function game(overrides = {}) {
  return { playerId: uuid(2), providerPlayerId: "8478402", providerTeamId: "22", nhlGameId: "2026020001",
    scheduledStartsAtMs: NOW - DAY, gameState: "final", gamesPlayed: 1, goals: 1, assists: 1,
    scoringRuleVersion: EXPANDED_SCORING_VERSION, scoringStats: { ...emptyScoringStats(), evenStrengthGoals: 1, primaryAssists: 1 }, ...overrides };
}

test("optimized evidence bytes and hashes equal the original canonical format", async () => {
  const records = ["quote\"game", "slash\\game", "é-game", "\uE000", "😀", "2026020001"].map((nhlGameId, n) => game({ nhlGameId,
    scoringStats: { ...game().scoringStats, shotsOnGoal: n, blockedShots: n + 1 } }));
  records.push(game({ playerId: uuid(3), scoringRuleVersion: null, scoringStats: null }));
  const input = { statSourceId: uuid(1), nhlSeasonKey: "20262027", records: [...records].reverse() };
  const a = prepareGameCapture(input), b = await prepareGameCaptureAsync(input);
  assert.deepEqual(a, b);
  for (const entry of a.entries) {
    assert.equal(entry.payload, serializeCanonicalJsonV1(entry.record));
    assert.equal(entry.sha256, hashCanonicalJsonV1(entry.record));
  }
  const originalOrder = [...a.records].sort((x, y) => compareUnicodeScalarStrings(`${x.playerId}\u0000${x.nhlGameId}`, `${y.playerId}\u0000${y.nhlGameId}`));
  assert.equal(a.evidenceSha256, hashCanonicalJsonV1({ domain: "hundo-leago.shared-game-evidence.v1", statSourceId: uuid(1), nhlSeasonKey: "20262027", records: originalOrder }));
});

test("optimized preparation retains canonical rejection of negative zero and malformed Unicode", async () => {
  for (const record of [game({ gamesPlayed: -0 }), game({ scheduledStartsAtMs: -0 }), game({ assists: -0 }),
    game({ scoringStats: { ...game().scoringStats, hits: -0 } }), game({ nhlGameId: "bad\ud800" }),
    game({ scoringStats: Object.assign([], game().scoringStats) })]) {
    const c = { statSourceId: uuid(1), nhlSeasonKey: "20262027", records: [record] };
    assert.throws(() => prepareGameCapture(c)); await assert.rejects(prepareGameCaptureAsync(c));
  }
});

test("asynchronous preparation owns its inputs before yielding", async () => {
  const records = Array.from({ length: 600 }, (_, n) => game({ nhlGameId: String(2026020001 + n) }));
  const c = { statSourceId: uuid(1), nhlSeasonKey: "20262027", records };
  const original = prepareGameCapture(c), pending = prepareGameCaptureAsync(c);
  records.at(-1).scoringStats.shotsOnGoal = 9; records.at(-1).providerTeamId = "24";
  assert.deepEqual(await pending, original);
});

test("96 unchanged refreshes share one game record while keeping separate capture times", t => {
  const { repo, command, counts, db } = fixture(t); const ids = [];
  for (let n = 0; n < 96; n++) { const c = command([game()], { at: NOW + n * 1_800_000 }); ids.push(c.refreshId); assert.equal(repo.capture(c).changedRecordCount, n === 0 ? 1 : 0); }
  assert.deepEqual(counts(), { captures: 96, changes: 1 });
  const first = repo.read({ refreshId: ids[0] }), last = repo.read({ refreshId: ids.at(-1) });
  assert.deepEqual(first.records, last.records); assert.equal(last.observedAtMs - first.observedAtMs, 95 * 1_800_000);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("a corrected score creates one change and leaves the earlier sealed result intact", t => {
  const { repo, command, counts } = fixture(t); const original = command([game()]); repo.capture(original);
  const before = repo.read({ refreshId: original.refreshId });
  const correction = command([game({ scoringStats: { ...game().scoringStats, shotsOnGoal: 4 } })]);
  assert.equal(repo.capture(correction).changedRecordCount, 1);
  assert.deepEqual(repo.read({ refreshId: original.refreshId }), before);
  const after = repo.read({ refreshId: correction.refreshId });
  assert.equal(calculateExpandedScore(after.records[0].scoringStats, "F").fantasyPointsHundredths - calculateExpandedScore(before.records[0].scoringStats, "F").fantasyPointsHundredths, 80);
  assert.deepEqual(counts(), { captures: 2, changes: 2 });
});

test("removed and restored games preserve earlier membership and evidence", t => {
  const { repo, command, counts } = fixture(t); const old = command([game()]); repo.capture(old);
  const removed = command([]); assert.equal(repo.capture(removed).changedRecordCount, 1);
  const stillRemoved = command([]); assert.equal(repo.capture(stillRemoved).changedRecordCount, 0);
  const restored = command([game()]); assert.equal(repo.capture(restored).changedRecordCount, 1);
  assert.equal(repo.read({ refreshId: old.refreshId }).records.length, 1);
  assert.equal(repo.read({ refreshId: removed.refreshId }).records.length, 0);
  assert.equal(repo.read({ refreshId: restored.refreshId }).records.length, 1);
  assert.deepEqual(counts(), { captures: 4, changes: 3 });
});

test("schedule and team corrections are versioned even when points do not change", t => {
  const { repo, command } = fixture(t); const first = command([game()]); repo.capture(first);
  const next = command([game({ scheduledStartsAtMs: NOW - DAY + 60_000, providerTeamId: "23" })]);
  assert.equal(repo.capture(next).changedRecordCount, 1);
  assert.equal(repo.read({ refreshId: first.refreshId }).records[0].providerTeamId, "22");
  assert.equal(repo.read({ refreshId: next.refreshId }).records[0].providerTeamId, "23");
});

for (const duration of [7, 9, 14]) test(`${duration}-day historical score inputs survive later corrections outside the matchup`, t => {
  const { repo, command } = fixture(t);
  const startsAtMs = NOW - 20 * DAY, endsAtMs = startsAtMs + duration * DAY;
  const records = [-1, 0, duration - 1, duration].map((day, n) => game({ nhlGameId: String(2026020001 + n), scheduledStartsAtMs: startsAtMs + day * DAY }));
  const old = command(records); repo.capture(old);
  const total = refreshId => repo.read({ refreshId }).records.filter(r => r.scheduledStartsAtMs >= startsAtMs && r.scheduledStartsAtMs < endsAtMs).reduce((sum, r) => sum + calculateExpandedScore(r.scoringStats, "F").fantasyPointsHundredths, 0);
  const expected = 2 * calculateExpandedScore(game().scoringStats, "F").fantasyPointsHundredths;
  assert.equal(total(old.refreshId), expected);
  const corrected = command(records.map(r => ({ ...r, scoringStats: { ...r.scoringStats, shotsOnGoal: 1 } }))); repo.capture(corrected);
  assert.equal(total(old.refreshId), expected); assert.equal(total(corrected.refreshId), expected + 40);
});

test("exact retries perform no writes; conflicting retries are refused", t => {
  const { repo, command, db } = fixture(t); const c = command([game()]); repo.capture(c);
  const before = db.prepare("SELECT total_changes() n").get().n;
  assert.equal(repo.capture(c).replayed, true);
  assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
  assert.throws(() => repo.capture({ ...c, observedAtMs: c.observedAtMs + 1 }), /replay conflicts/);
});

test("async preparation writes nothing and publication remains atomic", async t => {
  const { repo, command, counts, db } = fixture(t); const c = command([game()]);
  const before = db.prepare("SELECT total_changes() n").get().n;
  const prepared = await repo.prepare(c);
  assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
  assert.deepEqual(counts(), { captures: 0, changes: 0 });
  assert.throws(() => db.transaction(() => { repo.commit(prepared); throw new Error("later refresh failure"); }).immediate(), /later refresh/);
  assert.deepEqual(counts(), { captures: 0, changes: 0 });
  assert.equal(repo.commit(prepared).changedRecordCount, 1);
  assert.deepEqual(repo.read({ refreshId: c.refreshId }).records, [game()]);
});

test("an intervening refresh invalidates prepared data without overwriting the new result", async t => {
  const { repo, command, counts } = fixture(t); repo.capture(command([game()]));
  const stale = command([]), prepared = await repo.prepare(stale);
  const newer = command([game({ scoringStats: { ...game().scoringStats, shotsOnGoal: 3 } })]); repo.capture(newer);
  const before = repo.read({ refreshId: newer.refreshId });
  assert.throws(() => repo.commit(prepared), /preparation is stale/);
  assert.deepEqual(counts(), { captures: 2, changes: 2 });
  assert.deepEqual(repo.read({ refreshId: newer.refreshId }), before);
});

test("publication refuses forged or cross-repository preparations", async t => {
  const { repo, command, db } = fixture(t); const prepared = await repo.prepare(command([game()]));
  const another = createSqliteSharedGameEvidenceRepository({ database: db });
  assert.throws(() => repo.commit({ ...prepared }), /owned shared game preparation/);
  assert.throws(() => another.commit(prepared), /owned shared game preparation/);
});

test("publication rolls back if a database trigger suppresses a required change", async t => {
  const { repo, command, counts, db } = fixture(t);
  const c = command([game(), game({ nhlGameId: "2026020002" })]), prepared = await repo.prepare(c);
  db.exec("CREATE TRIGGER test_suppress_shared_change BEFORE INSERT ON shared_game_evidence_changes WHEN NEW.nhl_game_id='2026020002' BEGIN SELECT RAISE(IGNORE); END");
  assert.throws(() => repo.commit(prepared), /change was not inserted/);
  assert.deepEqual(counts(), { captures: 0, changes: 0 });
});

test("a refresh that fails after preparation cannot publish shared evidence", async t => {
  const { repo, command, counts, db } = fixture(t); const c = command([game()]), prepared = await repo.prepare(c);
  db.prepare("UPDATE stat_refreshes SET status='failed',completed_at_ms=?,error_code='FAILED' WHERE id=?").run(c.capturedAtMs, c.refreshId);
  assert.throws(() => repo.commit(prepared), /source or order is invalid/);
  assert.deepEqual(counts(), { captures: 0, changes: 0 });
});

test("async preparation refuses an already-open write transaction", async t => {
  const { repo, command, db } = fixture(t); const c = command([game()]); db.exec("BEGIN IMMEDIATE");
  try { await assert.rejects(repo.prepare(c), /before opening/); } finally { db.exec("ROLLBACK"); }
});

test("a second database connection can write while large preparation yields", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-game-concurrency-"));
  const filename = path.join(dir, "fixture.sqlite3"); const { repo, command, db } = fixture(t, { filename });
  const other = new Database(filename); other.pragma("busy_timeout=0");
  try {
    const records = Array.from({ length: 1024 }, (_, n) => game({ nhlGameId: String(2026020001 + n) }));
    const c = command(records); let wroteWhilePreparing = false, completed = false;
    const concurrent = new Promise((resolve, reject) => setImmediate(() => {
      try {
        assert.equal(completed, false); assert.equal(db.inTransaction, false);
        other.prepare("INSERT INTO players (id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms) VALUES (?, 'Other','Writer','Other Writer','2000-01-01','active',1,1)").run(uuid(999));
        wroteWhilePreparing = true; resolve();
      } catch (error) { reject(error); }
    }));
    const [prepared] = await Promise.all([repo.prepare(c), concurrent]); completed = true;
    assert(wroteWhilePreparing); assert.equal(repo.commit(prepared).changedRecordCount, records.length);
  } finally { other.close(); db.close(); }
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true });
});

test("failed foreign-key write rolls back the entire new capture", t => {
  const { repo, command, counts } = fixture(t); const old = command([game()]); repo.capture(old);
  const bad = command([game(), game({ playerId: uuid(999), providerPlayerId: "999" })]);
  assert.throws(() => repo.capture(bad), /FOREIGN KEY/);
  assert.deepEqual(counts(), { captures: 1, changes: 1 });
  assert.deepEqual(repo.read({ refreshId: old.refreshId }).records, [game()]);
});

test("a later failure in the enclosing refresh rolls back its shared evidence too", t => {
  const { repo, command, counts, db } = fixture(t); const c = command([game()]);
  assert.throws(() => db.transaction(() => { repo.capture(c); throw new Error("refresh completion failed"); }).immediate(), /completion failed/);
  assert.deepEqual(counts(), { captures: 0, changes: 0 });
});

test("late-arriving older data cannot replace the current history", t => {
  const { repo, command, counts } = fixture(t); repo.capture(command([game()], { at: NOW }));
  const stale = command([], { at: NOW - 1 }); assert.throws(() => repo.capture(stale), /order is invalid/);
  assert.deepEqual(counts(), { captures: 1, changes: 1 });
});

test("source and season histories remain isolated", t => {
  const { repo, command, counts, db } = fixture(t);
  db.prepare("INSERT INTO stat_sources (id,provider,status,created_at_ms,updated_at_ms) VALUES (?, 'other-provider', 'active', ?, ?)").run(uuid(3), NOW, NOW);
  const first = command([game()]); repo.capture(first);
  const otherSeason = command([], { nhlSeasonKey: "20272028" }); assert.equal(repo.capture(otherSeason).revision, 1);
  const otherProvider = command([game()], { statSourceId: uuid(3) }); assert.throws(() => repo.capture(otherProvider), /source or order/);
  assert.equal(repo.read({ refreshId: first.refreshId }).records.length, 1);
  assert.deepEqual(counts(), { captures: 2, changes: 1 });
});

test("invalid and ambiguous evidence cannot be persisted", t => {
  const { repo, command, counts } = fixture(t);
  for (const records of [[game(), game()], [game({ sourceUpdatedAtMs: NOW })], [game({ goals: 2 })], [game({ gamesPlayed: 0 })], [game({ gameState: "in_progress" })], [game({ providerPlayerId: "0" })]]) {
    const c = command(records); assert.throws(() => repo.capture(c));
  }
  assert.deepEqual(counts(), { captures: 0, changes: 0 });
});

test("record order does not create additional versions", t => {
  const { repo, command, counts } = fixture(t); const a = game(), b = game({ nhlGameId: "2026020002" });
  repo.capture(command([a, b])); assert.equal(repo.capture(command([b, a])).changedRecordCount, 0);
  assert.deepEqual(counts(), { captures: 2, changes: 2 });
});

test("sealed evidence rejects modification, deletion, and late inserts", t => {
  const { repo, command, db } = fixture(t); const c = command([game()]); repo.capture(c);
  for (const sql of ["DELETE FROM shared_game_evidence_changes", "DELETE FROM shared_game_evidence_captures", "UPDATE shared_game_evidence_changes SET payload_json=NULL", "UPDATE shared_game_evidence_captures SET record_count=0"]) assert.throws(() => db.exec(sql), /immutable|protected/);
  assert.throws(() => db.prepare("INSERT INTO shared_game_evidence_changes SELECT ?, stat_source_id,nhl_season_key,player_id,'new-game',revision,payload_json,payload_sha256 FROM shared_game_evidence_changes").run(uuid(900)), /open capture/);
});

test("reopening the file preserves both original and corrected captures", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-game-evidence-"));
  const filename = path.join(dir, "fixture.sqlite3"); const { repo, command, db } = fixture(t, { filename });
  const a = command([game()]); repo.capture(a); const b = command([]); repo.capture(b); db.close();
  const reopened = new Database(filename, { readonly: true });
  try {
    const reader = createSqliteSharedGameEvidenceRepository({ database: reopened });
    assert.equal(reader.read({ refreshId: a.refreshId }).records.length, 1); assert.equal(reader.read({ refreshId: b.refreshId }).records.length, 0);
  } finally { reopened.close(); }
  // Close every handle before removing this uniquely created fixture on Windows.
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a damaged stored payload fails closed instead of returning a changed historical score", t => {
  const { repo, command, db } = fixture(t); const c = command([game()]); repo.capture(c);
  db.exec("DROP TRIGGER shared_game_evidence_changes_immutable_update");
  db.prepare("UPDATE shared_game_evidence_changes SET payload_json = ?").run(JSON.stringify(game({ providerTeamId: "23" })));
  assert.throws(() => repo.read({ refreshId: c.refreshId }), /corrupt/);
});

test("additive migration preserves every existing table's values", t => {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); t.after(() => db.close());
  const migrations = discoverMigrations({ migrationsDirectory });
  const opts = { database: db, applicationBuildId: "shared-game-preservation", now: () => NOW };
  applyMigrations({ ...opts, migrations: migrations.filter(m => m.id < 69) });
  db.prepare("INSERT INTO stat_sources (id,provider,status,created_at_ms,updated_at_ms) VALUES (?, 'nhl-completed-games', 'active', ?, ?)").run(uuid(1), NOW, NOW);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('application_metadata','schema_migrations') ORDER BY name").all();
  const read = () => tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
  const before = read(); applyMigrations({ ...opts, migrations }); assert.deepEqual(read(), before);
  assert.deepEqual(db.pragma("foreign_key_check"), []); assert.equal(db.pragma("quick_check", { simple: true }), "ok");
});
