const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  LIVE_FRESHNESS_WINDOW_MS,
  MATCHUP_SCORING_CODES,
  calculateTeamLiveScore,
  describeLiveSource,
} = require("../../src/domain/matchups/matchupScoringPolicy");
const {
  MATCHUP_SCORING_SERVICE_CODES,
  createMatchupScoringService,
} = require("../../src/application/services/matchups/createMatchupScoringService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupScoringRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupScoringRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = 200 * HOUR_MS;
const IDS = Object.freeze({
  league: uuid(1), otherLeague: uuid(2), season: uuid(3), week: uuid(4),
  home: uuid(5), away: uuid(6), matchup: uuid(7), player: uuid(8),
  source: uuid(9), baselineRefresh: uuid(10), liveRefresh: uuid(11),
  failedRefresh: uuid(12), baselineTotal: uuid(13), liveTotal: uuid(14),
  snapshot: uuid(15), snapshotPlayer: uuid(16), homeLock: uuid(17),
  homeLockPlayer: uuid(18), awayLock: uuid(19),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(database, { baselineGoals = 1 } = {}) {
  const insertLeague = database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'active', 'America/Vancouver', 1, 1, 1)"
  );
  insertLeague.run(IDS.league, "Score League", "score league");
  insertLeague.run(IDS.otherLeague, "Other Score League", "other score league");
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
  ).run(IDS.week, IDS.league, IDS.season, NOW_MS - 20 * HOUR_MS, NOW_MS - 19 * HOUR_MS, NOW_MS - 4 * HOUR_MS, NOW_MS + 4 * HOUR_MS, NOW_MS + 5 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'live', 1, 1, 2)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);
  database.prepare(
    "INSERT INTO players (id, first_name, last_name, full_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Scoring', 'Player', 'Scoring Player', 'active', 1, 1, 1)"
  ).run(IDS.player);
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  const insertRefresh = database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, error_code, version) VALUES (?, ?, '20262027', ?, ?, ?, ?, ?, ?, 1)"
  );
  insertRefresh.run(IDS.baselineRefresh, IDS.source, "baseline", "succeeded", NOW_MS - 20 * HOUR_MS, NOW_MS - 19 * HOUR_MS, 1, null);
  insertRefresh.run(IDS.liveRefresh, IDS.source, "live", "succeeded", NOW_MS - HOUR_MS - 1, NOW_MS - HOUR_MS, 1, null);
  insertRefresh.run(IDS.failedRefresh, IDS.source, null, "failed", NOW_MS - 1, NOW_MS, null, "provider_failed");
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals (id, stat_source_id, refresh_id, nhl_season_key, player_id, games_played, " +
      "goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (?, ?, ?, '20262027', ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertTotal.run(
    IDS.baselineTotal, IDS.source, IDS.baselineRefresh, IDS.player, 10,
    baselineGoals, 1, baselineGoals + 1, baselineGoals * 125 + 100,
    NOW_MS - 19 * HOUR_MS, NOW_MS - 19 * HOUR_MS
  );
  insertTotal.run(IDS.liveTotal, IDS.source, IDS.liveRefresh, IDS.player, 12, 2, 3, 5, 550, NOW_MS - HOUR_MS, NOW_MS - HOUR_MS);
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', 'fresh', ?, 1, ?)"
  ).run(IDS.snapshot, IDS.source, IDS.baselineRefresh, IDS.league, IDS.season, IDS.week, NOW_MS - 19 * HOUR_MS, NOW_MS - 19 * HOUR_MS);
  database.prepare(
    "INSERT INTO stat_snapshot_players (id, league_id, stat_snapshot_id, player_id, games_played, goals, assists, " +
      "nhl_points, fantasy_points_hundredths, created_at_ms) VALUES (?, ?, ?, ?, 10, ?, 1, ?, ?, ?)"
  ).run(IDS.snapshotPlayer, IDS.league, IDS.snapshot, IDS.player, baselineGoals, baselineGoals + 1, baselineGoals * 125 + 100, NOW_MS - 19 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 1, NULL, ?, ?, 'fresh', ?, 1)"
  ).run(IDS.homeLock, IDS.league, IDS.season, IDS.week, IDS.home, NOW_MS - 4 * HOUR_MS, IDS.snapshot, NOW_MS - 4 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_players (id, league_id, season_id, matchup_roster_lock_id, player_id, position_group, " +
      "slot_number, baseline_games_played, baseline_goals, baseline_assists, " +
      "baseline_fantasy_points_hundredths, created_at_ms) VALUES (?, ?, ?, ?, ?, 'F', 1, 10, ?, 1, ?, ?)"
  ).run(IDS.homeLockPlayer, IDS.league, IDS.season, IDS.homeLock, IDS.player, baselineGoals, baselineGoals * 125 + 100, NOW_MS - 4 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 0, 'ACTIVE_FORWARD_SLOTS_INCOMPLETE', ?, NULL, 'unknown', ?, 1)"
  ).run(IDS.awayLock, IDS.league, IDS.season, IDS.week, IDS.away, NOW_MS - 4 * HOUR_MS, NOW_MS - 4 * HOUR_MS);
}

function createRuntime(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-06-"));
  const connection = openDatabase({
    databasePath: path.join(root, "scoring.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-06-test",
    now: () => 1,
  });
  seed(connection.database, options);
  const repository = createSqliteMatchupScoringRepository({ database: connection.database });
  const service = createMatchupScoringService({ repository });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

function input(nowMs = NOW_MS) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    matchupId: IDS.matchup,
    provider: "nhl",
    nowMs,
  };
}

describe("M6-06 live matchup scoring policy", () => {
  test("uses independent baselines and exact goal-plus-assist hundredths", () => {
    const currentTotals = [{
      player_id: IDS.player,
      games_played: 12,
      goals: 2,
      assists: 3,
      fantasy_points_hundredths: 550,
    }];
    const score = (baselineGoals, baselineAssists) => calculateTeamLiveScore({
      lock: { legal: 1, team_id: uuid(50) },
      lockedPlayers: [{
        player_id: IDS.player,
        player_full_name: "Scoring Player",
        position_group: "F",
        slot_number: 1,
        baseline_games_played: 10,
        baseline_goals: baselineGoals,
        baseline_assists: baselineAssists,
        baseline_fantasy_points_hundredths: baselineGoals * 125 + baselineAssists * 100,
      }],
      currentTotals,
    }).scoreHundredths;
    assert.equal(score(1, 1), 325);
    assert.equal(score(2, 2), 100);
    assert.equal(
      calculateTeamLiveScore({ lock: { legal: 0, team_id: uuid(51) }, lockedPlayers: [], currentTotals }).scoreHundredths,
      0
    );
  });

  test("reports stale health and rejects future or regressed totals", () => {
    assert.equal(
      describeLiveSource({ nowMs: NOW_MS, completedAtMs: NOW_MS - LIVE_FRESHNESS_WINDOW_MS - 1 }).freshnessStatus,
      "stale"
    );
    assert.throws(
      () => describeLiveSource({ nowMs: NOW_MS, completedAtMs: NOW_MS + 1 }),
      { code: MATCHUP_SCORING_CODES.sourceFuture }
    );
    assert.throws(
      () => calculateTeamLiveScore({
        lock: { legal: 1, team_id: IDS.home },
        lockedPlayers: [{
          player_id: IDS.player, player_full_name: "Scoring Player",
          position_group: "F", slot_number: 1,
          baseline_games_played: 10, baseline_goals: 2, baseline_assists: 1,
          baseline_fantasy_points_hundredths: 350,
        }],
        currentTotals: [{
          player_id: IDS.player, games_played: 12, goals: 1, assists: 3,
          fantasy_points_hundredths: 425,
        }],
      }),
      { code: MATCHUP_SCORING_CODES.sourceRegressed }
    );
  });

  test("projects player identity, NHL points, and missing-data status explicitly", () => {
    const result = calculateTeamLiveScore({
      lock: { legal: 1, team_id: IDS.home },
      lockedPlayers: [{
        player_id: IDS.player,
        player_full_name: "Scoring Player",
        position_group: "F",
        slot_number: 1,
        baseline_games_played: 0,
        baseline_goals: 0,
        baseline_assists: 0,
        baseline_fantasy_points_hundredths: 0,
      }],
      currentTotals: [],
    });
    assert.deepEqual(result.players[0], {
      playerId: IDS.player,
      fullName: "Scoring Player",
      positionGroup: "F",
      slotNumber: 1,
      gamesPlayedDelta: 0,
      goalDelta: 0,
      assistDelta: 0,
      pointDelta: 0,
      scoreHundredths: 0,
      dataStatus: "missing",
    });
  });
});

describe("M6-06 SELECT-only live scoring", () => {
  test("uses the last successful refresh, scores illegal zero, and performs no writes", (t) => {
    const { database, service } = createRuntime(t);
    const changesBefore = database.prepare("SELECT total_changes() AS count").get().count;
    const result = service.readLive(input());
    const changesAfter = database.prepare("SELECT total_changes() AS count").get().count;
    assert.equal(result.source.refreshId, IDS.liveRefresh);
    assert.equal(result.source.freshnessStatus, "fresh");
    assert.equal(result.home.scoreHundredths, 325);
    assert.equal(result.home.players[0].goalDelta, 1);
    assert.equal(result.home.players[0].assistDelta, 2);
    assert.equal(result.home.players[0].pointDelta, 3);
    assert.equal(result.home.players[0].fullName, "Scoring Player");
    assert.equal(result.home.players[0].dataStatus, "available");
    assert.equal(result.away.scoreHundredths, 0);
    assert.equal(changesAfter, changesBefore);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("reconstructs a final breakdown from its exact persisted refresh without writes", (t) => {
    const { database, service } = createRuntime(t);
    database.prepare(
      "UPDATE matchups SET status = 'final' WHERE id = ?"
    ).run(IDS.matchup);
    const changesBefore = database.prepare("SELECT total_changes() AS count").get().count;
    const result = service.readAtRefresh({
      ...input(),
      refreshId: IDS.liveRefresh,
    });
    const changesAfter = database.prepare("SELECT total_changes() AS count").get().count;
    assert.equal(result.source.refreshId, IDS.liveRefresh);
    assert.equal(result.home.players[0].fullName, "Scoring Player");
    assert.equal(result.home.players[0].pointDelta, 3);
    assert.equal(changesAfter, changesBefore);
  });

  test("keeps stale last-valid data readable and fails scope or regression closed", (t) => {
    const stale = createRuntime(t);
    assert.equal(
      stale.service.readLive(input(NOW_MS + LIVE_FRESHNESS_WINDOW_MS + 1)).source.freshnessStatus,
      "stale"
    );
    assert.throws(
      () => stale.service.readLive({ ...input(), leagueId: IDS.otherLeague }),
      { code: MATCHUP_SCORING_SERVICE_CODES.contextMissing }
    );
    const regressed = createRuntime(t, { baselineGoals: 3 });
    assert.throws(() => regressed.service.readLive(input()), {
      code: MATCHUP_SCORING_CODES.sourceRegressed,
    });
  });
});
