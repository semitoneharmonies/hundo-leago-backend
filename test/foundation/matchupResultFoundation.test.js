const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FINAL_FRESHNESS_WINDOW_MS,
  MATCHUP_RESULT_CODES,
  deriveMatchupOutcome,
  evaluateFinalSource,
  validateResultCorrection,
} = require("../../src/domain/matchups/matchupResultPolicy");
const {
  MATCHUP_RESULT_SERVICE_CODES,
  createMatchupResultService,
} = require("../../src/application/services/matchups/createMatchupResultService");
const {
  createMatchupScoringService,
} = require("../../src/application/services/matchups/createMatchupScoringService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupResultRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupResultRepository");
const {
  createSqliteMatchupScoringRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupScoringRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const HOUR_MS = 60 * 60 * 1000;
const END_MS = 1000 * HOUR_MS;
const NOW_MS = END_MS + HOUR_MS;
const IDS = Object.freeze({
  commissioner: uuid(1), outsider: uuid(2), membership: uuid(3), league: uuid(4),
  season: uuid(5), week: uuid(6), home: uuid(7), away: uuid(8), matchup: uuid(9),
  player: uuid(10), source: uuid(11), baselineRefresh: uuid(12), finalRefresh: uuid(13),
  baselineTotal: uuid(14), finalTotal: uuid(15), baselineSnapshot: uuid(16),
  snapshotPlayer: uuid(17), homeLock: uuid(18), homeLockPlayer: uuid(19), awayLock: uuid(20),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function insertUser(database, id, name) {
  database.prepare(
    "INSERT INTO users (id, email_normalized, email_display, display_name, display_name_normalized, " +
      "status, created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(id, `${name}@example.test`, `${name}@example.test`, name, name);
}

function seed(database, finalCompletedAtMs) {
  insertUser(database, IDS.commissioner, "commissioner");
  insertUser(database, IDS.outsider, "outsider");
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Result League', 'result league', 'active', 'America/Vancouver', 1, 1, 1)"
  ).run(IDS.league);
  database.prepare(
    "INSERT INTO league_memberships (id, league_id, user_id, permission_category, status, joined_at_ms, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'commissioner', 'active', 1, 1, 1, 1)"
  ).run(IDS.membership, IDS.league, IDS.commissioner);
  database.prepare(
    "UPDATE leagues SET commissioner_membership_id = ?, updated_at_ms = 2, version = 2 WHERE id = ?"
  ).run(IDS.membership, IDS.league);
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
      "VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?, 'awaiting_data', 1, 1, 4)"
  ).run(IDS.week, IDS.league, IDS.season, END_MS - 7 * 24 * HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS, END_MS - 7 * 24 * HOUR_MS + 16 * HOUR_MS, END_MS, END_MS);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'awaiting_data', 1, 1, 3)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);
  database.prepare(
    "INSERT INTO players (id, first_name, last_name, full_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Final', 'Player', 'Final Player', 'active', 1, 1, 1)"
  ).run(IDS.player);
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  const insertRefresh = database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', ?, 'succeeded', ?, ?, 1, 1)"
  );
  insertRefresh.run(IDS.baselineRefresh, IDS.source, "baseline", END_MS - 7 * 24 * HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  insertRefresh.run(IDS.finalRefresh, IDS.source, "final", finalCompletedAtMs - 1, finalCompletedAtMs);
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals (id, stat_source_id, refresh_id, nhl_season_key, player_id, games_played, " +
      "goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (?, ?, ?, '20262027', ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertTotal.run(IDS.baselineTotal, IDS.source, IDS.baselineRefresh, IDS.player, 10, 1, 1, 2, 225, END_MS - 7 * 24 * HOUR_MS + HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  insertTotal.run(IDS.finalTotal, IDS.source, IDS.finalRefresh, IDS.player, 12, 2, 3, 5, 550, finalCompletedAtMs, finalCompletedAtMs);
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', 'fresh', ?, 1, ?)"
  ).run(IDS.baselineSnapshot, IDS.source, IDS.baselineRefresh, IDS.league, IDS.season, IDS.week, END_MS - 7 * 24 * HOUR_MS + HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  database.prepare(
    "INSERT INTO stat_snapshot_players (id, league_id, stat_snapshot_id, player_id, games_played, goals, assists, " +
      "nhl_points, fantasy_points_hundredths, created_at_ms) VALUES (?, ?, ?, ?, 10, 1, 1, 2, 225, ?)"
  ).run(IDS.snapshotPlayer, IDS.league, IDS.baselineSnapshot, IDS.player, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 1, NULL, ?, ?, 'fresh', ?, 1)"
  ).run(IDS.homeLock, IDS.league, IDS.season, IDS.week, IDS.home, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS, IDS.baselineSnapshot, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_players (id, league_id, season_id, matchup_roster_lock_id, player_id, position_group, " +
      "slot_number, baseline_games_played, baseline_goals, baseline_assists, baseline_fantasy_points_hundredths, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, 'F', 1, 10, 1, 1, 225, ?)"
  ).run(IDS.homeLockPlayer, IDS.league, IDS.season, IDS.homeLock, IDS.player, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 0, 'ACTIVE_FORWARD_SLOTS_INCOMPLETE', ?, NULL, 'unknown', ?, 1)"
  ).run(IDS.awayLock, IDS.league, IDS.season, IDS.week, IDS.away, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS);
}

function createRuntime(t, { finalCompletedAtMs = END_MS, fail = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-07-"));
  const connection = openDatabase({
    databasePath: path.join(root, "results.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-07-test",
    now: () => 1,
  });
  seed(connection.database, finalCompletedAtMs);
  const scoringService = createMatchupScoringService({
    repository: createSqliteMatchupScoringRepository({ database: connection.database }),
  });
  const repository = createSqliteMatchupResultRepository({
    database: connection.database,
    beforeCommit() {
      if (fail()) throw new Error("late result failure");
    },
  });
  let nextId = 500;
  const service = createMatchupResultService({ repository, scoringService, createId: () => uuid(nextId++) });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

function input(operationId = uuid(400), nowMs = NOW_MS) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    matchupId: IDS.matchup,
    provider: "nhl",
    operationId,
    nowMs,
  };
}

describe("M6-07 matchup result policy", () => {
  test("derives exact outcomes and post-end freshness readiness", () => {
    assert.equal(deriveMatchupOutcome(100, 100), "tie");
    assert.equal(deriveMatchupOutcome(101, 100), "home_win");
    assert.equal(deriveMatchupOutcome(100, 101), "away_win");
    assert.equal(evaluateFinalSource({ weekEndsAtMs: END_MS, refreshCompletedAtMs: END_MS - 1, nowMs: NOW_MS }).ready, false);
    assert.equal(evaluateFinalSource({ weekEndsAtMs: END_MS, refreshCompletedAtMs: END_MS, nowMs: END_MS + FINAL_FRESHNESS_WINDOW_MS }).ready, true);
    assert.equal(evaluateFinalSource({ weekEndsAtMs: END_MS, refreshCompletedAtMs: END_MS, nowMs: END_MS + FINAL_FRESHNESS_WINDOW_MS + 1 }).ready, false);
  });

  test("requires bounded explicit correction scores and reason", () => {
    assert.deepEqual(
      validateResultCorrection({ homeScoreHundredths: 0, awayScoreHundredths: 100, reason: "Official stat correction" }),
      { homeScoreHundredths: 0, awayScoreHundredths: 100, outcome: "away_win", reason: "Official stat correction" }
    );
    assert.throws(
      () => validateResultCorrection({ homeScoreHundredths: 0, awayScoreHundredths: 0, reason: "" }),
      { code: MATCHUP_RESULT_CODES.correctionInvalid }
    );
  });
});

describe("M6-07 atomic finalization and append-only correction", () => {
  test("waits without writes when the latest successful source predates week end", (t) => {
    const { database, service } = createRuntime(t, { finalCompletedAtMs: END_MS - 1 });
    const result = service.finalize(input());
    assert.equal(result.finalized, false);
    assert.equal(result.waiting.reasonCode, "SOURCE_BEFORE_WEEK_END");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_results").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 0);
  });

  test("finalizes once, versions a correction, and preserves prior evidence", (t) => {
    const { database, service } = createRuntime(t);
    const finalized = service.finalize(input());
    assert.equal(finalized.finalized, true);
    assert.equal(finalized.context.result.status, "official");
    assert.equal(finalized.context.versions[0].home_score_hundredths, 325);
    assert.equal(finalized.context.versions[0].away_score_hundredths, 0);
    assert.equal(finalized.context.versions[0].outcome, "home_win");
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "final");
    assert.equal(database.prepare("SELECT status FROM matchup_weeks").get().status, "final");
    assert.equal(service.finalize(input()).replayed, true);

    const corrected = service.correct({
      ...input(uuid(401), NOW_MS + 1),
      actorUserId: IDS.commissioner,
      expectedResultVersion: 1,
      homeScoreHundredths: 0,
      awayScoreHundredths: 100,
      reason: "Official scorer correction",
    });
    assert.equal(corrected.corrected, true);
    assert.equal(corrected.context.result.status, "corrected");
    assert.equal(corrected.context.result.version, 2);
    assert.equal(corrected.context.versions.length, 2);
    assert.equal(corrected.context.versions[0].source_type, "calculated");
    assert.equal(corrected.context.versions[1].source_type, "correction");
    assert.equal(corrected.context.versions[1].actor_user_id, IDS.commissioner);
    assert.equal(corrected.context.versions[1].supersedes_version_id, corrected.context.versions[0].id);
    assert.equal(corrected.context.versions[1].outcome, "away_win");
    assert.equal(service.correct({ ...input(uuid(401), NOW_MS + 1), actorUserId: IDS.commissioner }).replayed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_result_versions").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("denies noncommissioner and stale corrections without appending", (t) => {
    const { database, service } = createRuntime(t);
    service.finalize(input());
    const correction = {
      ...input(uuid(402), NOW_MS + 1),
      expectedResultVersion: 1,
      homeScoreHundredths: 100,
      awayScoreHundredths: 100,
      reason: "Correction",
    };
    assert.throws(() => service.correct({ ...correction, actorUserId: IDS.outsider }), {
      code: MATCHUP_RESULT_SERVICE_CODES.commissionerRequired,
    });
    assert.throws(() => service.correct({ ...correction, actorUserId: IDS.commissioner, expectedResultVersion: 99 }), {
      code: "REPOSITORY_VERSION_CONFLICT",
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_result_versions").get().count, 1);
  });

  test("records a correction by a previously authorized platform administrator", (t) => {
    const { database, service } = createRuntime(t);
    service.finalize(input());

    const corrected = service.correct({
      ...input(uuid(403), NOW_MS + 1),
      actorUserId: IDS.outsider,
      authorizedAsPlatformAdministrator: true,
      expectedResultVersion: 1,
      homeScoreHundredths: 100,
      awayScoreHundredths: 200,
      reason: "Platform administrator correction",
    });

    assert.equal(corrected.corrected, true);
    assert.equal(corrected.context.versions[1].actor_user_id, IDS.outsider);
  });

  test("rolls every finalization effect back after a late failure", (t) => {
    let fail = true;
    const { database, service } = createRuntime(t, { fail: () => fail });
    assert.throws(() => service.finalize(input()));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_results").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stat_snapshots WHERE intended_use = 'matchup_final'").get().count, 0);
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "awaiting_data");
    assert.equal(database.prepare("SELECT status FROM matchup_weeks").get().status, "awaiting_data");
    fail = false;
    assert.equal(service.finalize(input()).finalized, true);
  });
});
