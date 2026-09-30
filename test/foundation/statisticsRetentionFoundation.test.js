const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { createSqliteStatisticsRetentionRepository, RETENTION_MS } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRetentionRepository");
const { createSqliteCompletedGameCacheRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteCompletedGameCacheRepository");
const { completedGameEntry } = require("../../src/domain/statistics/completedGameCachePolicy");
const { createSqliteStatisticsRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const { emptyScoringStats, EXPANDED_SCORING_VERSION } = require("../../src/domain/statistics/expandedScoringPolicy");
const { readExpandedStatistics } = require("../../src/infrastructure/persistence/sqlite/expandedStatisticsPersistence");
const NOW = Date.parse("2026-12-20T12:00:00Z");
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture(t) {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); t.after(() => db.close());
  migrateDatabase({ database: db, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "statistics-retention-test", now: () => NOW });
  db.prepare("INSERT INTO stat_sources (id,provider,status,created_at_ms,updated_at_ms) VALUES (?, 'nhl-completed-games', 'active', ?, ?)").run(uuid(1), NOW, NOW);
  const insert = db.prepare("INSERT INTO stat_refreshes (id,stat_source_id,nhl_season_key,status,started_at_ms,completed_at_ms,player_count) VALUES (?,?,'20262027','succeeded',?,?,0)");
  function refresh(n, age) { insert.run(uuid(n), uuid(1), NOW - age, NOW - age); return uuid(n); }
  function pin(n, refreshId) { db.prepare("INSERT INTO stat_snapshots (id,stat_source_id,source_refresh_id,intended_use,completeness_status,freshness_status,captured_at_ms,created_at_ms) VALUES (?,?,?,'matchup_baseline','complete','fresh',?,?)").run(uuid(n), uuid(1), refreshId, NOW, NOW); }
  const repo = createSqliteStatisticsRetentionRepository({ database: db });
  db.prepare("INSERT INTO players (id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms) VALUES (?, 'Test','Player','Test Player','2000-01-01','active',1,1)").run(uuid(2));
  function total(n, refreshId) { db.prepare(`INSERT INTO player_stat_totals
    (id,stat_source_id,refresh_id,nhl_season_key,player_id,games_played,goals,assists,nhl_points,fantasy_points_hundredths,source_updated_at_ms,created_at_ms)
    VALUES (?, ?, ?, '20262027', ?, 1, 2, 1, 3, 350, 1, 1)`).run(uuid(n), uuid(1), refreshId, uuid(2)); }
  return { db, refresh, pin, repo, total };
}

test("retention preserves the newest refresh and referenced evidence beyond a two-week final", t => {
  const { db, refresh, pin, repo, total } = fixture(t);
  const pinned = refresh(10, 40 * 86_400_000); pin(100, pinned);
  const unreferenced = refresh(11, RETENTION_MS + 1);
  const recent = refresh(12, RETENTION_MS);
  const latest = refresh(13, 1000);
  total(210, pinned); total(211, unreferenced); total(212, recent); total(213, latest);
  const before = db.prepare("SELECT * FROM stat_snapshots").all();
  assert.deepEqual(repo.retire(NOW), { retiredRefreshCount: 1 });
  assert.deepEqual(db.prepare("SELECT refresh_id FROM stat_refresh_payload_retirements").all(), [{ refresh_id: unreferenced }]);
  assert.deepEqual(db.prepare("SELECT * FROM stat_snapshots").all(), before);
  assert.equal(db.prepare("SELECT count(*) n FROM player_stat_totals WHERE refresh_id=?").get(unreferenced).n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM player_stat_totals").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) n FROM stat_refreshes WHERE id IN (?,?,?)").get(pinned, recent, latest).n, 3);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(repo.retire(NOW).retiredRefreshCount, 0);
});

test("a newly introduced foreign-key reference fails closed and rolls the entire retirement back", t => {
  const { db, refresh, repo, total } = fixture(t);
  const old = refresh(10, RETENTION_MS + 1); refresh(11, 0); total(210, old);
  db.exec("CREATE TABLE future_scoring_reference (total_id TEXT REFERENCES player_stat_totals(id) ON DELETE RESTRICT)");
  db.prepare("INSERT INTO future_scoring_reference VALUES (?)").run(uuid(210));
  assert.throws(() => repo.retire(NOW), /FOREIGN KEY/);
  assert.equal(db.prepare("SELECT count(*) n FROM player_stat_totals").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM stat_refresh_payload_retirements").get().n, 0);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("database refuses retirement of a protected, recent, or newest refresh", t => {
  const { db, refresh, pin } = fixture(t);
  const pinned = refresh(10, 40 * 86_400_000); pin(100, pinned);
  const recent = refresh(11, 1000);
  const newest = refresh(12, 0);
  const insert = db.prepare("INSERT INTO stat_refresh_payload_retirements VALUES (?, ?, '{}')");
  for (const id of [pinned, recent, newest]) assert.throws(() => insert.run(id, NOW), /protected or recent/);
  assert.equal(db.prepare("SELECT count(*) n FROM stat_refresh_payload_retirements").get().n, 0);
});

test("retention keeps stale latest data and bounds each transaction to two candidates", t => {
  const { db, refresh, repo } = fixture(t);
  for (let n = 10; n <= 14; n++) refresh(n, (30 - n) * 86_400_000);
  assert.equal(repo.retire(NOW).retiredRefreshCount, 2);
  assert.equal(repo.retire(NOW).retiredRefreshCount, 2);
  assert.equal(repo.retire(NOW).retiredRefreshCount, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM stat_refresh_payload_retirements WHERE refresh_id=?").get(uuid(14)).n, 0);
  assert.throws(() => db.prepare("DELETE FROM stat_refresh_payload_retirements").run(), /immutable/);
});

test("cache replaces only its own game entries and survives repository recreation", t => {
  const { db } = fixture(t);
  const make = checkedAtMs => ({ gameId: "2026020001", ...completedGameEntry({ game: { id: "2026020001", startsAtMs: 1, homeTeamId: "1", awayTeamId: "2" }, season: "20262027", expanded: true, checkedAtMs, data: { rows: [], categories: [] } }) });
  const repo = createSqliteCompletedGameCacheRepository({ database: db });
  repo.save([make(NOW)]); repo.save([make(NOW - 1)]);
  const reopened = createSqliteCompletedGameCacheRepository({ database: db });
  assert.equal(reopened.read({ season: "20262027", expanded: true }).get("2026020001").checkedAtMs, NOW);
  assert.equal(reopened.read({ season: "20252026", expanded: true }).size, 0);
  assert.equal(reopened.read({ season: "20262027", expanded: false }).size, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM nhl_completed_game_cache").get().n, 1);
});

test("retention removes a sealed expanded payload atomically while preserving referenced expanded scores", t => {
  const { db, refresh, pin, repo } = fixture(t);
  db.prepare("INSERT INTO player_external_ids (id,player_id,provider,external_value,created_at_ms) VALUES (?,?,'nhl','101',1)").run(uuid(3), uuid(2));
  const statistics = createSqliteStatisticsRepository({ database: db });
  const required = statistics.readPlayerGameCoverageRequirements({ nhlSeasonKey: "20262027", playerIdentityProvider: "nhl" });
  function sealed(n) {
    const at = NOW - RETENTION_MS - 1000;
    statistics.startRefresh({ id: uuid(n), statSourceId: uuid(1), nhlSeasonKey: "20262027", startedAtMs: at });
    statistics.completeLiveRefresh({ refreshId: uuid(n), statSourceId: uuid(1), provider: "nhl-completed-games", playerIdentityProvider: "nhl",
      nhlSeasonKey: "20262027", sourceVersion: "retention-fixture", completedAtMs: at + 1,
      rows: [{ externalPlayerId: "101", gamesPlayed: 1, goals: 2, assists: 1, nhlPoints: 3, fantasyPointsHundredths: 350, sourceUpdatedAtMs: at }],
      playerGameRows: [], requiredPlayers: required.requiredPlayers, requiredPlayerGames: required.requiredPlayerGames,
      requirementsSha256: required.requirementsSha256, playerGameCoverage: [],
      expandedScoring: { scoringRuleVersion: EXPANDED_SCORING_VERSION, playerGameRows: [],
        totalsRows: [{ playerId: "101", scoringStats: { ...emptyScoringStats(), evenStrengthGoals: 2, primaryAssists: 1 } }] } });
    return uuid(n);
  }
  const disposable = sealed(10), protectedId = sealed(12);
  pin(100, protectedId); refresh(14, 0);
  const protectedScore = readExpandedStatistics(db, protectedId);
  assert.ok(readExpandedStatistics(db, disposable));
  assert.equal(repo.retire(NOW).retiredRefreshCount, 1);
  assert.equal(readExpandedStatistics(db, disposable), null);
  assert.deepEqual(readExpandedStatistics(db, protectedId), protectedScore);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stat_refresh_player_game_sets WHERE refresh_id=?").get(disposable).n, 0);
  assert.equal(db.prepare("SELECT status FROM stat_refreshes WHERE id=?").get(disposable).status, "succeeded");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});
