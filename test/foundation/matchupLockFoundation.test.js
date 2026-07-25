const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FRESHNESS_WINDOW_MS,
  MATCHUP_LOCK_CODES,
  assertFreshBaselineSource,
  buildLockedPlayerBaselines,
} = require("../../src/domain/matchups/matchupLockPolicy");
const {
  MATCHUP_LOCK_SERVICE_CODES,
  createMatchupLockService,
} = require("../../src/application/services/matchups/createMatchupLockService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupLockRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupLockRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const HOUR_MS = 60 * 60 * 1000;
const START_MS = 100 * HOUR_MS;
const BASELINE_MS = START_MS + HOUR_MS;
const LOCK_MS = START_MS + 16 * HOUR_MS;
const END_MS = START_MS + 7 * 24 * HOUR_MS;
const IDS = Object.freeze({
  league: uuid(1), season: uuid(2), week: uuid(3), home: uuid(4), away: uuid(5),
  matchup: uuid(6), forward: uuid(7), defence: uuid(8), bench: uuid(9),
  ownershipF: uuid(10), ownershipD: uuid(11), ownershipBench: uuid(12),
  source: uuid(13), refresh: uuid(14), total: uuid(15),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(database, refreshCompletedAtMs) {
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Lock League', 'lock league', 'active', 'America/Vancouver', 1, 1, 1)"
  ).run(IDS.league);
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  insertTeam.run(IDS.home, IDS.league, "Home", "home");
  insertTeam.run(IDS.away, IDS.league, "Away", "away");
  database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?, 'live', 1, 1, 2)"
  ).run(IDS.week, IDS.league, IDS.season, START_MS, BASELINE_MS, LOCK_MS, END_MS, END_MS);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'live', 1, 1, 2)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);
  const insertPlayer = database.prepare(
    "INSERT INTO players (id, first_name, last_name, full_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, 'Player', ?, 'active', 1, 1, 1)"
  );
  insertPlayer.run(IDS.forward, "Forward", "Forward Player");
  insertPlayer.run(IDS.defence, "Defence", "Defence Player");
  insertPlayer.run(IDS.bench, "Bench", "Bench Player");
  const insertOwnership = database.prepare(
    "INSERT INTO player_ownerships (id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'Rostered', ?, ?, ?, 'test', 1, 1, 1)"
  );
  insertOwnership.run(IDS.ownershipF, IDS.league, IDS.season, IDS.forward, IDS.home, "Active", "F", 1);
  insertOwnership.run(IDS.ownershipD, IDS.league, IDS.season, IDS.defence, IDS.home, "Active", "D", 1);
  insertOwnership.run(IDS.ownershipBench, IDS.league, IDS.season, IDS.bench, IDS.home, "Bench", "F", 1);
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', 'v1', 'succeeded', ?, ?, 1, 1)"
  ).run(IDS.refresh, IDS.source, refreshCompletedAtMs - 1, refreshCompletedAtMs);
  database.prepare(
    "INSERT INTO player_stat_totals (id, stat_source_id, refresh_id, nhl_season_key, player_id, " +
      "games_played, goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (?, ?, ?, '20262027', ?, 10, 3, 4, 7, 775, ?, ?)"
  ).run(IDS.total, IDS.source, IDS.refresh, IDS.forward, refreshCompletedAtMs, refreshCompletedAtMs);
}

function createRuntime(t, { refreshCompletedAtMs = BASELINE_MS, failBeforeCommit = () => false } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-04-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "lock.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-04-test",
    now: () => 1,
  });
  seed(connection.database, refreshCompletedAtMs);
  const repository = createSqliteMatchupLockRepository({
    database: connection.database,
    beforeCommit() {
      if (failBeforeCommit()) throw new Error("late lock failure");
    },
  });
  let nextId = 500;
  const service = createMatchupLockService({ repository, createId: () => uuid(nextId++) });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { database: connection.database, repository, service };
}

function lockInput(lockId = uuid(400)) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    teamId: IDS.home,
    provider: "nhl",
    lockId,
    nowMs: LOCK_MS,
  };
}

describe("M6-04 immutable matchup-lock policy", () => {
  test("accepts the exact six-hour freshness boundary and rejects stale or future sources", () => {
    assert.deepEqual(
      assertFreshBaselineSource({
        baselineAtMs: BASELINE_MS,
        refreshCompletedAtMs: BASELINE_MS - FRESHNESS_WINDOW_MS,
      }),
      { freshnessStatus: "fresh", ageMs: FRESHNESS_WINDOW_MS }
    );
    assert.throws(
      () => assertFreshBaselineSource({
        baselineAtMs: BASELINE_MS,
        refreshCompletedAtMs: BASELINE_MS - FRESHNESS_WINDOW_MS - 1,
      }),
      { code: MATCHUP_LOCK_CODES.sourceStale }
    );
    assert.throws(
      () => assertFreshBaselineSource({ baselineAtMs: BASELINE_MS, refreshCompletedAtMs: BASELINE_MS + 1 }),
      { code: MATCHUP_LOCK_CODES.sourceFuture }
    );
  });

  test("copies exact slots and uses explicit zero totals for a missing player", () => {
    const baselines = buildLockedPlayerBaselines({
      activePlayers: [
        { player_id: IDS.forward, position_group: "F", slot_number: 1 },
        { player_id: IDS.defence, position_group: "D", slot_number: 2 },
      ],
      totals: [{
        player_id: IDS.forward,
        games_played: 10,
        goals: 3,
        assists: 4,
        fantasy_points_hundredths: 775,
      }],
    });
    assert.equal(baselines[0].playerId, IDS.defence);
    assert.equal(baselines[0].baselineFantasyPointsHundredths, 0);
    assert.equal(baselines[1].baselineFantasyPointsHundredths, 775);
  });
});

describe("M6-04 atomic immutable matchup locks", () => {
  test("freezes the 4 PM active lineup against the 1 AM baseline and replays exactly", (t) => {
    const { database, service } = createRuntime(t);
    const result = service.lock(lockInput());
    assert.equal(result.replayed, false);
    assert.equal(result.playerCount, 2);
    const lock = database.prepare("SELECT * FROM matchup_roster_locks").get();
    assert.equal(lock.locked_at_ms, LOCK_MS);
    assert.equal(lock.source_freshness_status, "fresh");
    const snapshot = database.prepare("SELECT * FROM stat_snapshots").get();
    assert.equal(snapshot.captured_at_ms, BASELINE_MS);
    assert.equal(snapshot.committed, 1);
    const playersBefore = database.prepare(
      "SELECT player_id, position_group, slot_number, baseline_games_played, baseline_goals, " +
        "baseline_assists, baseline_fantasy_points_hundredths FROM matchup_roster_players ORDER BY player_id"
    ).all();
    assert.deepEqual(playersBefore.map((row) => row.baseline_fantasy_points_hundredths), [775, 0]);

    database.prepare(
      "UPDATE player_ownerships SET roster_category = 'Bench', slot_number = 2, updated_at_ms = 2, version = 2 " +
        "WHERE id = ?"
    ).run(IDS.ownershipF);
    assert.deepEqual(
      database.prepare(
        "SELECT player_id, position_group, slot_number, baseline_games_played, baseline_goals, " +
          "baseline_assists, baseline_fantasy_points_hundredths FROM matchup_roster_players ORDER BY player_id"
      ).all(),
      playersBefore
    );
    const replay = service.lock(lockInput());
    assert.equal(replay.replayed, true);
    assert.equal(replay.playerCount, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stat_snapshots").get().count, 1);
    assert.throws(() => service.lock(lockInput(uuid(401))), {
      code: MATCHUP_LOCK_SERVICE_CODES.alreadyLocked,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("fails stale, early, ended, and cross-scope attempts without writes", (t) => {
    const stale = createRuntime(t, {
      refreshCompletedAtMs: BASELINE_MS - FRESHNESS_WINDOW_MS - 1,
    });
    assert.throws(() => stale.service.lock(lockInput()), { code: MATCHUP_LOCK_CODES.sourceStale });
    assert.throws(
      () => stale.service.lock({ ...lockInput(), nowMs: LOCK_MS - 1 }),
      { code: MATCHUP_LOCK_SERVICE_CODES.tooEarly }
    );
    assert.throws(
      () => stale.service.lock({ ...lockInput(), nowMs: END_MS }),
      { code: MATCHUP_LOCK_SERVICE_CODES.weekEnded }
    );
    assert.throws(
      () => stale.service.lock({ ...lockInput(), teamId: uuid(999) }),
      { code: MATCHUP_LOCK_SERVICE_CODES.contextMissing }
    );
    assert.equal(stale.database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_locks").get().count, 0);
  });

  test("rolls every snapshot and lock row back after a late failure", (t) => {
    let fail = true;
    const { database, service } = createRuntime(t, { failBeforeCommit: () => fail });
    assert.throws(() => service.lock(lockInput()));
    for (const table of [
      "stat_snapshots", "stat_snapshot_players", "matchup_roster_locks", "matchup_roster_players",
    ]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    fail = false;
    assert.equal(service.lock(lockInput()).playerCount, 2);
  });
});
