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
const {
  REPOSITORY_ERROR_CODES,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const IDS = Object.freeze({
  league: uuid(1), otherLeague: uuid(2), season: uuid(3), week1: uuid(4), week2: uuid(5),
  teamA: uuid(10), teamB: uuid(11), teamC: uuid(12), teamD: uuid(13), teamE: uuid(14),
  matchAB: uuid(20), matchCD: uuid(21), matchEA: uuid(22), byeE: uuid(23),
  source: uuid(30), refresh: uuid(31), snapshot: uuid(32),
  refresh2: uuid(33), snapshot2: uuid(34),
  resultAB: uuid(40), resultCD: uuid(41), resultEA: uuid(42),
  abV1: uuid(50), abV2: uuid(51), cdV1: uuid(52), eaV1: uuid(53),
  abV1Alt: uuid(54), abV2Alt: uuid(55), cdV1Alt: uuid(56), eaV1Alt: uuid(57),
  correctionActor: uuid(60),
});

const DEFAULT_VERSION_IDS = Object.freeze({
  abV1: IDS.abV1,
  abV2: IDS.abV2,
  cdV1: IDS.cdV1,
  eaV1: IDS.eaV1,
});
const ALTERNATE_VERSION_IDS = Object.freeze({
  abV1: IDS.abV1Alt,
  abV2: IDS.abV2Alt,
  cdV1: IDS.cdV1Alt,
  eaV1: IDS.eaV1Alt,
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(
  database,
  { versionIds = DEFAULT_VERSION_IDS } = {}
) {
  database.prepare(
    "INSERT INTO users (id, email_normalized, email_display, " +
      "display_name, display_name_normalized, status, " +
      "created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'standings.actor@example.test', " +
      "'standings.actor@example.test', 'Standings Actor', " +
      "'standings actor', 'active', 1, 1, 1)"
  ).run(IDS.correctionActor);
  const insertLeague = database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'active', 'America/Vancouver', 1, 1, 1)"
  );
  insertLeague.run(IDS.league, "Standings League", "standings league");
  insertLeague.run(IDS.otherLeague, "Other Standings", "other standings");
  database.prepare(
    "INSERT INTO league_settings " +
      "(league_id, salary_cap_cents, trade_deadline_at_ms, " +
      "maximum_teams, active_forward_slots, " +
      "active_defence_slots, bench_slots, " +
      "maximum_bench_aav_cents, injured_reserve_slots, " +
      "prospect_slots_unlimited, scoring_rule_version, " +
      "standings_rule_version, created_at_ms, " +
      "updated_at_ms, version) " +
      "VALUES (?, 10000, NULL, 20, 12, 6, 4, 400, " +
      "4, 1, 1, 1, 1, 1, 1)"
  ).run(IDS.league);
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
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', 'final-week-2', 'succeeded', 299, 300, 0, 1)"
  ).run(IDS.refresh2, IDS.source);
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_final', 'complete', 'fresh', 200, 1, 200)"
  ).run(IDS.snapshot, IDS.source, IDS.refresh, IDS.league, IDS.season, IDS.week1);
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_final', 'complete', 'fresh', 300, 1, 300)"
  ).run(IDS.snapshot2, IDS.source, IDS.refresh2, IDS.league, IDS.season, IDS.week2);
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
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200)"
  );
  insertVersion.run(versionIds.abV1, IDS.league, IDS.season, IDS.resultAB, 1, IDS.teamA, IDS.teamB, 500, 300, "home_win", IDS.snapshot, "calculated", null, null, null);
  insertVersion.run(versionIds.abV2, IDS.league, IDS.season, IDS.resultAB, 2, IDS.teamA, IDS.teamB, 100, 300, "away_win", IDS.snapshot, "correction", IDS.correctionActor, "Corrected", versionIds.abV1);
  insertVersion.run(versionIds.cdV1, IDS.league, IDS.season, IDS.resultCD, 1, IDS.teamC, IDS.teamD, 200, 200, "tie", IDS.snapshot, "calculated", null, null, null);
  database.prepare(
    "UPDATE matchup_results SET current_version_id = ?, status = 'corrected', finalized_at_ms = 200, " +
      "updated_at_ms = 201, version = 2 WHERE id = ?"
  ).run(versionIds.abV2, IDS.resultAB);
  database.prepare(
    "UPDATE matchup_results SET current_version_id = ?, status = 'official', finalized_at_ms = 200 " +
      "WHERE id = ?"
  ).run(versionIds.cdV1, IDS.resultCD);
}

function createRuntime(t, options) {
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
  seed(connection.database, options);
  const service = createMatchupStandingsService({
    repository: createSqliteMatchupStandingsRepository({ database: connection.database }),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

function completeResultSet(
  database,
  { resultVersionId = IDS.eaV1 } = {}
) {
  database.prepare(
    "INSERT INTO matchup_result_versions " +
      "(id, league_id, season_id, matchup_result_id, " +
      "version_number, home_team_id, away_team_id, " +
      "home_score_hundredths, away_score_hundredths, " +
      "outcome, source_snapshot_id, source_type, " +
      "actor_user_id, reason, supersedes_version_id, " +
      "created_at_ms) VALUES (?, ?, ?, ?, 1, ?, ?, " +
      "400, 250, 'home_win', ?, 'calculated', NULL, " +
      "NULL, NULL, 300)"
  ).run(
    resultVersionId,
    IDS.league,
    IDS.season,
    IDS.resultEA,
    IDS.teamE,
    IDS.teamA,
    IDS.snapshot2
  );
  database.prepare(
    "UPDATE matchup_results SET current_version_id = ?, " +
      "status = 'official', finalized_at_ms = 300, " +
      "updated_at_ms = 300 WHERE id = ?"
  ).run(resultVersionId, IDS.resultEA);
  database.prepare(
    "UPDATE matchups SET status = 'final', " +
      "updated_at_ms = 300, version = version + 1 " +
      "WHERE id = ?"
  ).run(IDS.matchEA);
  database.prepare(
    "UPDATE matchup_weeks SET status = 'final', " +
      "updated_at_ms = 300, version = version + 1 " +
      "WHERE id = ?"
  ).run(IDS.week2);
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
    const priorPlayerId = uuid(9_001);
    const priorRefreshId = uuid(9_002);
    database.prepare(`
      INSERT INTO players (
        id, first_name, last_name, full_name, birth_date, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, 'Prior', 'Season', 'Prior Season', NULL, 'historical',
        1, 1, 1)
    `).run(priorPlayerId);
    database.prepare(`
      INSERT INTO stat_refreshes (
        id, stat_source_id, nhl_season_key, source_version, status,
        started_at_ms, completed_at_ms, player_count, error_code, version
      ) VALUES (?, ?, '20252026', 'prior-season-decoy', 'succeeded',
        999, 1000, 1, NULL, 1)
    `).run(priorRefreshId, IDS.source);
    database.prepare(`
      INSERT INTO player_stat_totals (
        id, stat_source_id, refresh_id, nhl_season_key, player_id,
        games_played, goals, assists, nhl_points,
        fantasy_points_hundredths, source_updated_at_ms, created_at_ms
      ) VALUES (?, ?, ?, '20252026', ?, 82, 50, 50, 100,
        99999, 1000, 1000)
    `).run(uuid(9_003), IDS.source, priorRefreshId, priorPlayerId);
    const before = database.prepare("SELECT total_changes() AS count").get().count;
    const standings = service.read({ leagueId: IDS.league, seasonId: IDS.season });
    const after = database.prepare("SELECT total_changes() AS count").get().count;
    assert.equal(standings.seasonVersion, 1);
    assert.equal(standings.seasonStatus, "active");
    assert.equal(standings.standingsRuleVersion, 1);
    assert.equal(standings.expectedWeekCount, 2);
    assert.equal(standings.expectedMatchupCount, 3);
    assert.equal(standings.finalizedResultCount, 2);
    assert.equal(standings.resultSetStatus, "incomplete");
    assert.equal(standings.resultSetHash, null);
    assert.deepEqual(
      standings.missingMatchupIds,
      [IDS.matchEA]
    );
    assert.ok(Object.isFrozen(standings.missingMatchupIds));
    assert.equal(standings.sourceResultVersion, 3);
    assert.deepEqual(standings.results[0], {
      id: IDS.resultAB,
      version: 2,
      versionNumber: 2,
      status: "corrected",
      week: {
        id: IDS.week1,
        sequence: 1,
        startsAtMs: 100,
        endsAtMs: 200,
      },
      matchup: {
        id: IDS.matchAB,
        homeTeam: { id: IDS.teamA, name: "Alpha" },
        awayTeam: { id: IDS.teamB, name: "Bravo" },
      },
      homeScoreHundredths: 100,
      awayScoreHundredths: 300,
      outcome: "away_win",
    });
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
    const preview = service.previewCorrection({
      leagueId: IDS.league,
      seasonId: IDS.season,
      resultId: IDS.resultAB,
      homeScoreHundredths: 600,
      awayScoreHundredths: 300,
    });
    assert.deepEqual(preview.changedTeamIds, [
      IDS.teamA,
      IDS.teamB,
    ]);
    assert.deepEqual(
      preview.projectedRows.map(
        ({ teamDisplayName, standingsPoints, rank }) => [
          teamDisplayName,
          standingsPoints,
          rank,
        ]
      ),
      [
        ["Alpha", 2, 1],
        ["Charlie", 1, 2],
        ["Delta", 1, 2],
        ["Echo", 0, 4],
        ["Bravo", 0, 5],
      ]
    );
    assert.equal(after, before);
    assert.equal(
      database.prepare("SELECT total_changes() AS count").get().count,
      before
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_snapshots").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("returns a complete canonical hash and distinguishes exact version identities that have the same legacy sum", (t) => {
    const first = createRuntime(t, {
      versionIds: DEFAULT_VERSION_IDS,
    });
    completeResultSet(first.database, {
      resultVersionId: DEFAULT_VERSION_IDS.eaV1,
    });
    const firstBefore = first.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const firstStandings = first.service.read({
      leagueId: IDS.league,
      seasonId: IDS.season,
    });
    const firstAfter = first.database
      .prepare("SELECT total_changes() AS count")
      .get().count;

    const second = createRuntime(t, {
      versionIds: ALTERNATE_VERSION_IDS,
    });
    completeResultSet(second.database, {
      resultVersionId: ALTERNATE_VERSION_IDS.eaV1,
    });
    const secondBefore = second.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const secondStandings = second.service.read({
      leagueId: IDS.league,
      seasonId: IDS.season,
    });
    const secondAfter = second.database
      .prepare("SELECT total_changes() AS count")
      .get().count;

    for (const standings of [
      firstStandings,
      secondStandings,
    ]) {
      assert.equal(standings.resultSetStatus, "complete");
      assert.match(standings.resultSetHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(standings.missingMatchupIds, []);
      assert.equal(standings.expectedWeekCount, 2);
      assert.equal(standings.expectedMatchupCount, 3);
      assert.equal(standings.finalizedResultCount, 3);
      assert.equal(standings.sourceResultVersion, 4);
    }
    assert.deepEqual(
      firstStandings.rows,
      secondStandings.rows
    );
    assert.equal(
      firstStandings.sourceResultVersion,
      secondStandings.sourceResultVersion
    );
    assert.notEqual(
      firstStandings.resultSetHash,
      secondStandings.resultSetHash
    );
    assert.equal(firstAfter, firstBefore);
    assert.equal(secondAfter, secondBefore);
  });

  test("returns every missing official matchup ID in stable order", (t) => {
    const { database, service } = createRuntime(t);
    database.prepare(
      "UPDATE matchup_results SET status = 'void' " +
        "WHERE id = ?"
    ).run(IDS.resultCD);
    const before = database
      .prepare("SELECT total_changes() AS count")
      .get().count;

    const standings = service.read({
      leagueId: IDS.league,
      seasonId: IDS.season,
    });

    assert.equal(standings.resultSetStatus, "incomplete");
    assert.equal(standings.resultSetHash, null);
    assert.equal(standings.finalizedResultCount, 1);
    assert.deepEqual(standings.missingMatchupIds, [
      IDS.matchCD,
      IDS.matchEA,
    ]);
    assert.equal(
      database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      before
    );
  });

  test("fails structurally inconsistent schedules closed and rejects result-version tampering", (t) => {
    const inconsistentSchedule = createRuntime(t);
    inconsistentSchedule.database
      .prepare(
        "UPDATE matchups SET away_team_name = " +
          "'Renamed Alpha' WHERE id = ?"
      )
      .run(IDS.matchEA);
    const scheduleBefore = inconsistentSchedule.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    assert.throws(
      () =>
        inconsistentSchedule.service.read({
          leagueId: IDS.league,
          seasonId: IDS.season,
        }),
      { code: REPOSITORY_ERROR_CODES.schemaIncompatible }
    );
    assert.equal(
      inconsistentSchedule.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      scheduleBefore
    );

    const inconsistentResult = createRuntime(t);
    assert.throws(
      () =>
        inconsistentResult.database
          .prepare(
            "UPDATE matchup_result_versions SET outcome = " +
              "'home_win' WHERE id = ?"
          )
          .run(IDS.abV2),
      (error) =>
        error?.code ===
          "SQLITE_CONSTRAINT_TRIGGER" &&
        /result-version history is immutable/.test(
          error.message
        )
    );
    assert.equal(
      inconsistentResult.database
        .prepare(`
          SELECT outcome
          FROM matchup_result_versions
          WHERE id = ?
        `)
        .get(IDS.abV2).outcome,
      "away_win"
    );
  });

  test("fails cross-league scope closed without exposing standings", (t) => {
    const { service } = createRuntime(t);
    assert.throws(
      () => service.read({ leagueId: IDS.otherLeague, seasonId: IDS.season }),
      { code: MATCHUP_STANDINGS_SERVICE_CODES.seasonMissing }
    );
  });
});
