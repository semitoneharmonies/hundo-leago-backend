const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  calculateStandings,
} = require("../../src/domain/matchups/matchupStandingsPolicy");
const {
  MATCHUP_STANDINGS_SERVICE_CODES,
  createMatchupStandingsService,
} = require("../../src/application/services/matchups/createMatchupStandingsService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupStandingsRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const IDS = Object.freeze({
  league: uuid(1), otherLeague: uuid(2), season: uuid(3), week1: uuid(4), week2: uuid(5),
  teamA: uuid(10), teamB: uuid(11), teamC: uuid(12), teamD: uuid(13), teamE: uuid(14),
  matchAB: uuid(20), matchCD: uuid(21), matchEA: uuid(22), byeE: uuid(23),
  source: uuid(30), refresh: uuid(31), snapshot: uuid(32),
  resultAB: uuid(40), resultCD: uuid(41), resultEA: uuid(42),
  abV1: uuid(50), abV2: uuid(51), cdV1: uuid(52),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(database) {
  const insertLeague = database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'active', 'America/Vancouver', 1, 1, 1)"
  );
  insertLeague.run(IDS.league, "Standings League", "standings league");
  insertLeague.run(IDS.otherLeague, "Other Standings", "other standings");
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  for (const [id, name] of [
    [IDS.teamA, "Alpha"], [IDS.teamB, "Bravo"], [IDS.teamC, "Charlie"],
    [IDS.teamD, "Delta"], [IDS.teamE, "Echo"],
  ]) insertTeam.run(id, IDS.league, name, name.toLowerCase());
  const insertWeek = database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)"
  );
  insertWeek.run(IDS.week1, IDS.league, IDS.season, "regular-01", 1, 100, 110, 120, 200, 200, "final");
  insertWeek.run(IDS.week2, IDS.league, IDS.season, "regular-02", 2, 200, 210, 220, 300, 300, "awaiting_data");
  const insertMatchup = database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)"
  );
  insertMatchup.run(IDS.matchAB, IDS.league, IDS.season, IDS.week1, IDS.teamA, IDS.teamB, "Alpha", "Bravo", "final");
  insertMatchup.run(IDS.matchCD, IDS.league, IDS.season, IDS.week1, IDS.teamC, IDS.teamD, "Charlie", "Delta", "final");
  insertMatchup.run(IDS.matchEA, IDS.league, IDS.season, IDS.week2, IDS.teamE, IDS.teamA, "Echo", "Alpha", "awaiting_data");
  database.prepare(
    "INSERT INTO matchup_byes (id, league_id, season_id, matchup_week_id, team_id, team_display_name, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, 'Echo', 1)"
  ).run(IDS.byeE, IDS.league, IDS.season, IDS.week1, IDS.teamE);
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', 'final', 'succeeded', 199, 200, 0, 1)"
  ).run(IDS.refresh, IDS.source);
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_final', 'complete', 'fresh', 200, 1, 200)"
  ).run(IDS.snapshot, IDS.source, IDS.refresh, IDS.league, IDS.season, IDS.week1);
  const insertResult = database.prepare(
    "INSERT INTO matchup_results (id, league_id, season_id, matchup_id, current_version_id, status, " +
      "finalized_at_ms, created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, NULL, 'pending', NULL, 200, 200, 1)"
  );
  insertResult.run(IDS.resultAB, IDS.league, IDS.season, IDS.matchAB);
  insertResult.run(IDS.resultCD, IDS.league, IDS.season, IDS.matchCD);
  insertResult.run(IDS.resultEA, IDS.league, IDS.season, IDS.matchEA);
  const insertVersion = database.prepare(
    "INSERT INTO matchup_result_versions (id, league_id, season_id, matchup_result_id, version_number, " +
      "home_team_id, away_team_id, home_score_hundredths, away_score_hundredths, outcome, source_snapshot_id, " +
      "source_type, actor_user_id, reason, supersedes_version_id, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 200)"
  );
  insertVersion.run(IDS.abV1, IDS.league, IDS.season, IDS.resultAB, 1, IDS.teamA, IDS.teamB, 500, 300, "home_win", IDS.snapshot, "calculated", null, null);
  insertVersion.run(IDS.abV2, IDS.league, IDS.season, IDS.resultAB, 2, IDS.teamA, IDS.teamB, 100, 300, "away_win", IDS.snapshot, "correction", "Corrected", IDS.abV1);
  insertVersion.run(IDS.cdV1, IDS.league, IDS.season, IDS.resultCD, 1, IDS.teamC, IDS.teamD, 200, 200, "tie", IDS.snapshot, "calculated", null, null);
  database.prepare(
    "UPDATE matchup_results SET current_version_id = ?, status = 'corrected', finalized_at_ms = 200, " +
      "updated_at_ms = 201, version = 2 WHERE id = ?"
  ).run(IDS.abV2, IDS.resultAB);
  database.prepare(
    "UPDATE matchup_results SET current_version_id = ?, status = 'official', finalized_at_ms = 200 " +
      "WHERE id = ?"
  ).run(IDS.cdV1, IDS.resultCD);
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-08-"));
  const connection = openDatabase({
    databasePath: path.join(root, "standings.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-08-test",
    now: () => 1,
  });
  seed(connection.database);
  const service = createMatchupStandingsService({
    repository: createSqliteMatchupStandingsRepository({ database: connection.database }),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

describe("M6-08 standings policy", () => {
  test("awards 2/1/0 points and competition ranks without name tie-breaking", () => {
    const rows = calculateStandings({
      participants: [
        { team_id: IDS.teamA, team_display_name: "Alpha" },
        { team_id: IDS.teamB, team_display_name: "Bravo" },
        { team_id: IDS.teamC, team_display_name: "Charlie" },
        { team_id: IDS.teamD, team_display_name: "Delta" },
      ],
      results: [
        { home_team_id: IDS.teamA, away_team_id: IDS.teamD, home_score_hundredths: 100, away_score_hundredths: 0 },
        { home_team_id: IDS.teamB, away_team_id: IDS.teamC, home_score_hundredths: 50, away_score_hundredths: 50 },
      ],
    });
    assert.deepEqual(rows.map(({ teamDisplayName, standingsPoints, rank }) => [teamDisplayName, standingsPoints, rank]), [
      ["Alpha", 2, 1], ["Bravo", 1, 2], ["Charlie", 1, 2], ["Delta", 0, 4],
    ]);
    assert.deepEqual(
      rows.map(({ teamDisplayName, pointsPercentageHundredths }) => [
        teamDisplayName,
        pointsPercentageHundredths,
      ]),
      [
        ["Alpha", 10_000],
        ["Bravo", 5_000],
        ["Charlie", 5_000],
        ["Delta", 0],
      ]
    );
  });
});

describe("M6-08 SELECT-only authoritative standings", () => {
  test("uses only current finalized versions, retains zero-game teams, and never writes", (t) => {
    const { database, service } = createRuntime(t);
    const before = database.prepare("SELECT total_changes() AS count").get().count;
    const standings = service.read({ leagueId: IDS.league, seasonId: IDS.season });
    const after = database.prepare("SELECT total_changes() AS count").get().count;
    assert.equal(standings.finalizedResultCount, 2);
    assert.deepEqual(
      standings.rows.map((row) => [row.teamDisplayName, row.standingsPoints, row.fantasyPointsDifferentialHundredths, row.rank]),
      [
        ["Bravo", 2, 200, 1],
        ["Charlie", 1, 0, 2],
        ["Delta", 1, 0, 2],
        ["Echo", 0, 0, 4],
        ["Alpha", 0, -200, 5],
      ]
    );
    assert.equal(standings.rows.find(({ teamDisplayName }) => teamDisplayName === "Alpha").fantasyPointsForHundredths, 100);
    assert.equal(
      standings.rows.find(({ teamDisplayName }) => teamDisplayName === "Echo")
        .pointsPercentageHundredths,
      0
    );
    assert.equal(after, before);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_snapshots").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("fails cross-league scope closed without exposing standings", (t) => {
    const { service } = createRuntime(t);
    assert.throws(
      () => service.read({ leagueId: IDS.otherLeague, seasonId: IDS.season }),
      { code: MATCHUP_STANDINGS_SERVICE_CODES.seasonMissing }
    );
  });
});
