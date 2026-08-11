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
const {
  createPlayerGameCoverageSetEvidence,
} = require("../../src/domain/statistics/playerGameCoveragePolicy");
const {
  createPlayerGameObservationSetEvidence,
} = require("../../src/domain/statistics/playerGameStatisticsPolicy");
const {
  createMatchupLateLockExclusionSetEvidence,
  createNhlGameObservationSnapshotEvidence,
} = require("../../src/domain/matchups/matchupLateLockEvidencePolicy");

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
  baselineGameSet: uuid(20), liveGameSet: uuid(21),
  baselineGameObservation: uuid(22), liveGameObservation: uuid(23),
  gameStateSnapshot: uuid(24), gameStateObservation: uuid(25),
   exclusionSet: uuid(26), exclusion: uuid(27),
   baselineCoverage: uuid(28), liveCoverage: uuid(29),
   extraCoverage: uuid(30), rootlessRefresh: uuid(31),
   rootlessTotal: uuid(32), finalSnapshot: uuid(33),
   finalResult: uuid(34), finalResultVersion: uuid(35),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createPlayerGameEvidence({
  setId,
  refreshId,
  coverageEntryId,
  observationId,
  sourceVersion,
  capturedAtMs,
  sourceUpdatedAtMs,
  goals,
  assists,
  coverageDisposition = "expected_game",
  omitCoverage = false,
  providerTeamId = "team-1",
  coverageSha256 = null,
  evidenceSha256 = null,
}) {
  const coverage = omitCoverage
    ? []
    : [{
        coverageEntryId,
        playerId: IDS.player,
        providerPlayerId: "8",
        providerTeamId:
          coverageDisposition === "no_team" ? null : providerTeamId,
        disposition: coverageDisposition,
        nhlGameId:
          coverageDisposition === "expected_game"
            ? "2026020001"
            : null,
        nhlGameScheduledStartsAtMs:
          coverageDisposition === "expected_game"
            ? NOW_MS - 5 * HOUR_MS
            : null,
      }];
  const observations =
    !omitCoverage && coverageDisposition === "expected_game"
      ? [{
          observationId,
          playerId: IDS.player,
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS - 5 * HOUR_MS,
          observedGameState: sourceVersion === "baseline" ? "scheduled" : "final",
          goals,
          assists,
          nhlPoints: goals + assists,
          fantasyPointsHundredths: goals * 125 + assists * 100,
          sourceUpdatedAtMs,
        }]
      : [];
  const coverageEvidence = createPlayerGameCoverageSetEvidence({
    setId,
    statSourceId: IDS.source,
    refreshId,
    nhlSeasonKey: "20262027",
    provider: "sportsdataio-live",
    sourceVersion,
    capturedAtMs,
    requiredPlayers: omitCoverage
      ? []
      : [{ playerId: IDS.player, providerPlayerId: "8" }],
    coverage,
  });
  const observationEvidence = createPlayerGameObservationSetEvidence({
    setId,
    statSourceId: IDS.source,
    refreshId,
    nhlSeasonKey: "20262027",
    provider: "sportsdataio-live",
    sourceVersion,
    capturedAtMs,
    observations,
  });
  return {
    coverage,
    observations,
    root: {
      ...coverageEvidence,
      ...observationEvidence,
      coverageSha256: coverageSha256 || coverageEvidence.coverageSha256,
      evidenceSha256: evidenceSha256 || observationEvidence.evidenceSha256,
    },
  };
}

function seed(
  database,
  {
    baselineGoals = 1,
    withPlayerGameEvidence = true,
    withExclusion = false,
    currentCoverageDisposition = "expected_game",
    omitCurrentCoverage = false,
    baselineCoverageSha256 = null,
    baselineEvidenceSha256 = null,
    currentCoverageSha256 = null,
    currentEvidenceSha256 = null,
    currentSourceUpdatedAtMs = NOW_MS - HOUR_MS,
    currentGameGoals = 1,
    currentGameAssists = 1,
    currentProviderTeamId = "team-1",
    currentGamesPlayed = 12,
    currentTotalGoals = 2,
     currentTotalAssists = 3,
     gameStateSha256 = null,
     exclusionSha256 = null,
     withNewerRootlessSuccessful = false,
  } = {}
) {
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
    "VALUES (?, 'sportsdataio-live', 'active', 1, 1, 1)"
  ).run(IDS.source);
  const insertRefresh = database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, error_code, version) VALUES (?, ?, '20262027', ?, ?, ?, ?, ?, ?, 1)"
  );
   insertRefresh.run(IDS.baselineRefresh, IDS.source, "baseline", "succeeded", NOW_MS - 20 * HOUR_MS, NOW_MS - 19 * HOUR_MS, 1, null);
   insertRefresh.run(IDS.liveRefresh, IDS.source, "live", "succeeded", NOW_MS - HOUR_MS - 1, NOW_MS - HOUR_MS, 1, null);
   insertRefresh.run(IDS.failedRefresh, IDS.source, null, "failed", NOW_MS - 1, NOW_MS, null, "provider_failed");
   if (withNewerRootlessSuccessful) {
     insertRefresh.run(
       IDS.rootlessRefresh,
       IDS.source,
       "rootless",
       "succeeded",
       NOW_MS - 1,
       NOW_MS,
       1,
       null
     );
   }
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
   insertTotal.run(
     IDS.liveTotal,
    IDS.source,
    IDS.liveRefresh,
    IDS.player,
    currentGamesPlayed,
    currentTotalGoals,
    currentTotalAssists,
    currentTotalGoals + currentTotalAssists,
    currentTotalGoals * 125 + currentTotalAssists * 100,
     NOW_MS - HOUR_MS,
     NOW_MS - HOUR_MS
   );
   if (withNewerRootlessSuccessful) {
     insertTotal.run(
       IDS.rootlessTotal,
       IDS.source,
       IDS.rootlessRefresh,
       IDS.player,
       currentGamesPlayed,
       currentTotalGoals,
       currentTotalAssists,
       currentTotalGoals + currentTotalAssists,
       currentTotalGoals * 125 + currentTotalAssists * 100,
       NOW_MS,
       NOW_MS
     );
   }
  if (withPlayerGameEvidence) {
    const baseline = createPlayerGameEvidence({
      setId: IDS.baselineGameSet,
      refreshId: IDS.baselineRefresh,
      coverageEntryId: IDS.baselineCoverage,
      observationId: IDS.baselineGameObservation,
      sourceVersion: "baseline",
      capturedAtMs: NOW_MS - 19 * HOUR_MS,
      sourceUpdatedAtMs: NOW_MS - 19 * HOUR_MS,
      goals: 0,
      assists: 0,
      coverageSha256: baselineCoverageSha256,
      evidenceSha256: baselineEvidenceSha256,
    });
    const current = createPlayerGameEvidence({
      setId: IDS.liveGameSet,
      refreshId: IDS.liveRefresh,
      coverageEntryId: IDS.liveCoverage,
      observationId: IDS.liveGameObservation,
      sourceVersion: "live",
      capturedAtMs: NOW_MS - HOUR_MS,
      sourceUpdatedAtMs: currentSourceUpdatedAtMs,
      goals: currentGameGoals,
      assists: currentGameAssists,
      coverageDisposition: currentCoverageDisposition,
      omitCoverage: omitCurrentCoverage,
      providerTeamId: currentProviderTeamId,
      coverageSha256: currentCoverageSha256,
      evidenceSha256: currentEvidenceSha256,
    });
    const insertCoverage = database.prepare(
      "INSERT INTO stat_refresh_player_game_coverage_entries " +
        "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, player_id, " +
        "provider_player_id, provider_team_id, disposition, nhl_game_id, " +
        "nhl_game_scheduled_starts_at_ms, created_at_ms, version) " +
        "VALUES (@coverageEntryId, @statSourceId, @refreshId, @setId, '20262027', " +
        "@playerId, @providerPlayerId, @providerTeamId, @disposition, @nhlGameId, " +
        "@nhlGameScheduledStartsAtMs, @capturedAtMs, 1)"
    );
    const insertPlayerGame = database.prepare(
      "INSERT INTO player_game_stat_observations " +
        "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, player_id, " +
        "nhl_game_id, nhl_game_scheduled_starts_at_ms, observed_game_state, goals, assists, " +
        "nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms, version) " +
        "VALUES (@observationId, @statSourceId, @refreshId, @setId, '20262027', " +
        "@playerId, @nhlGameId, @nhlGameScheduledStartsAtMs, @observedGameState, " +
        "@goals, @assists, @nhlPoints, @fantasyPointsHundredths, @sourceUpdatedAtMs, " +
        "@capturedAtMs, 1)"
    );
    const insertPlayerGameSet = database.prepare(
      "INSERT INTO stat_refresh_player_game_sets " +
        "(id, stat_source_id, refresh_id, nhl_season_key, provider, source_version, " +
        "captured_at_ms, required_player_count, coverage_entry_count, " +
        "expected_player_game_count, coverage_schema_version, coverage_sha256, " +
        "observation_count, evidence_schema_version, evidence_sha256, created_at_ms, version) " +
        "VALUES (@setId, @statSourceId, @refreshId, '20262027', 'sportsdataio-live', " +
        "@sourceVersion, @capturedAtMs, @requiredPlayerCount, @coverageEntryCount, " +
        "@expectedPlayerGameCount, 1, @coverageSha256, @observationCount, 1, " +
        "@evidenceSha256, @capturedAtMs, 1)"
    );
    const persistEvidence = (evidence, metadata) => {
      for (const row of evidence.coverage) {
        insertCoverage.run({
          ...row,
          ...metadata,
          statSourceId: IDS.source,
        });
      }
      for (const row of evidence.observations) {
        insertPlayerGame.run({
          ...row,
          ...metadata,
          statSourceId: IDS.source,
        });
      }
      insertPlayerGameSet.run({
        ...metadata,
        statSourceId: IDS.source,
        requiredPlayerCount: evidence.root.requiredPlayerCount,
        coverageEntryCount: evidence.root.coverageEntryCount,
        expectedPlayerGameCount: evidence.root.expectedPlayerGameCount,
        coverageSha256: evidence.root.coverageSha256,
        observationCount: evidence.root.observationCount,
        evidenceSha256: evidence.root.evidenceSha256,
      });
    };
    database.transaction(() => {
      persistEvidence(baseline, {
        setId: IDS.baselineGameSet,
        refreshId: IDS.baselineRefresh,
        sourceVersion: "baseline",
        capturedAtMs: NOW_MS - 19 * HOUR_MS,
      });
      persistEvidence(current, {
        setId: IDS.liveGameSet,
        refreshId: IDS.liveRefresh,
        sourceVersion: "live",
        capturedAtMs: NOW_MS - HOUR_MS,
      });
    })();
  }
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', 'fresh', ?, 1, ?)"
  ).run(
    IDS.snapshot,
    IDS.source,
    IDS.baselineRefresh,
    IDS.league,
    IDS.season,
    IDS.week,
    withExclusion ? NOW_MS - 4 * HOUR_MS : NOW_MS - 19 * HOUR_MS,
    withExclusion ? NOW_MS - 4 * HOUR_MS : NOW_MS - 19 * HOUR_MS
  );
  database.prepare(
    "INSERT INTO stat_snapshot_players (id, league_id, stat_snapshot_id, player_id, games_played, goals, assists, " +
      "nhl_points, fantasy_points_hundredths, created_at_ms) VALUES (?, ?, ?, ?, 10, ?, 1, ?, ?, ?)"
  ).run(IDS.snapshotPlayer, IDS.league, IDS.snapshot, IDS.player, baselineGoals, baselineGoals + 1, baselineGoals * 125 + 100, NOW_MS - 19 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, 'fresh', ?, ?)"
  ).run(
    IDS.homeLock,
    IDS.league,
    IDS.season,
    IDS.week,
    IDS.home,
    withExclusion ? "late" : "normal",
    NOW_MS - 4 * HOUR_MS,
    IDS.snapshot,
    NOW_MS - 4 * HOUR_MS,
    withExclusion ? 2 : 1
  );
  database.prepare(
    "INSERT INTO matchup_roster_players (id, league_id, season_id, matchup_roster_lock_id, player_id, position_group, " +
      "slot_number, baseline_games_played, baseline_goals, baseline_assists, " +
      "baseline_fantasy_points_hundredths, created_at_ms) VALUES (?, ?, ?, ?, ?, 'F', 1, 10, ?, 1, ?, ?)"
  ).run(IDS.homeLockPlayer, IDS.league, IDS.season, IDS.homeLock, IDS.player, baselineGoals, baselineGoals * 125 + 100, NOW_MS - 4 * HOUR_MS);
  if (withExclusion) {
    if (!withPlayerGameEvidence) {
      throw new Error("Late-lock exclusion tests require player-game evidence.");
    }
    const lateSnapshotAtMs = NOW_MS - 4 * HOUR_MS;
    const gameStateEvidence =
      createNhlGameObservationSnapshotEvidence({
        observationSnapshotId: IDS.gameStateSnapshot,
        provider: "sportsdataio-live",
        sourceVersion: "games-live",
        observedAtMs: lateSnapshotAtMs,
        freshnessStatus: "fresh",
        games: [{
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS - 5 * HOUR_MS,
          observedGameState: "final",
        }],
      });
    const sealedGameStateSha256 =
      gameStateSha256 || gameStateEvidence.observationSha256;
    const exclusionEvidence =
      createMatchupLateLockExclusionSetEvidence({
        exclusionSetId: IDS.exclusionSet,
        leagueId: IDS.league,
        seasonId: IDS.season,
        matchupWeekId: IDS.week,
        matchupId: IDS.matchup,
        teamId: IDS.home,
        matchupRosterLockId: IDS.homeLock,
        lateSnapshotAtMs,
        observationSnapshotId: IDS.gameStateSnapshot,
        observationSha256: sealedGameStateSha256,
        exclusions: [{
          exclusionId: IDS.exclusion,
          matchupRosterPlayerId: IDS.homeLockPlayer,
          playerId: IDS.player,
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS - 5 * HOUR_MS,
          observedGameState: "final",
          baselinePlayerGameStatObservationId:
            IDS.baselineGameObservation,
        }],
      });
    database.transaction(() => {
      database.prepare(
        "INSERT INTO nhl_game_state_observations (id, league_id, season_id, observation_snapshot_id, " +
          "nhl_game_id, nhl_game_scheduled_starts_at_ms, observed_game_state, observed_at_ms, " +
          "created_at_ms, version) VALUES (?, ?, ?, ?, '2026020001', ?, 'final', ?, ?, 1)"
      ).run(
        IDS.gameStateObservation,
        IDS.league,
        IDS.season,
        IDS.gameStateSnapshot,
        NOW_MS - 5 * HOUR_MS,
        lateSnapshotAtMs,
        lateSnapshotAtMs
      );
      database.prepare(
        "INSERT INTO nhl_game_state_observation_snapshots (id, league_id, season_id, matchup_week_id, " +
          "team_id, provider, source_version, observed_at_ms, freshness_status, observation_count, " +
          "evidence_schema_version, observation_sha256, created_at_ms, version) " +
          "VALUES (?, ?, ?, ?, ?, 'sportsdataio-live', 'games-live', ?, 'fresh', 1, 1, ?, ?, 1)"
      ).run(
        IDS.gameStateSnapshot,
        IDS.league,
        IDS.season,
        IDS.week,
        IDS.home,
        lateSnapshotAtMs,
        sealedGameStateSha256,
        lateSnapshotAtMs
      );
      database.prepare(
        "INSERT INTO matchup_roster_game_exclusions (id, league_id, season_id, exclusion_set_id, " +
          "matchup_week_id, matchup_id, team_id, matchup_roster_lock_id, matchup_roster_player_id, " +
          "player_id, observation_snapshot_id, observation_id, baseline_player_game_stat_observation_id, " +
          "nhl_game_id, nhl_game_scheduled_starts_at_ms, observed_game_state, late_snapshot_at_ms, " +
          "created_at_ms, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026020001', ?, " +
          "'final', ?, ?, 1)"
      ).run(
        IDS.exclusion,
        IDS.league,
        IDS.season,
        IDS.exclusionSet,
        IDS.week,
        IDS.matchup,
        IDS.home,
        IDS.homeLock,
        IDS.homeLockPlayer,
        IDS.player,
        IDS.gameStateSnapshot,
        IDS.gameStateObservation,
        IDS.baselineGameObservation,
        NOW_MS - 5 * HOUR_MS,
        lateSnapshotAtMs,
        lateSnapshotAtMs
      );
      database.prepare(
        "INSERT INTO matchup_roster_game_exclusion_sets (id, league_id, season_id, matchup_week_id, " +
          "matchup_id, team_id, matchup_roster_lock_id, matchup_roster_lock_version, baseline_snapshot_id, " +
          "observation_snapshot_id, late_snapshot_at_ms, exclusion_count, evidence_schema_version, " +
          "evidence_sha256, sealed_at_ms, created_at_ms, version) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, 1, 1, ?, ?, ?, 1)"
      ).run(
        IDS.exclusionSet,
        IDS.league,
        IDS.season,
        IDS.week,
        IDS.matchup,
        IDS.home,
        IDS.homeLock,
        IDS.snapshot,
        IDS.gameStateSnapshot,
        lateSnapshotAtMs,
        exclusionSha256 || exclusionEvidence.evidenceSha256,
        lateSnapshotAtMs,
        lateSnapshotAtMs
      );
    })();
  }
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
    provider: "sportsdataio-live",
    nowMs,
  };
}

function persistFinalResult(database) {
  database.transaction(() => {
    database.prepare(
      "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, " +
        "matchup_week_id, intended_use, completeness_status, freshness_status, captured_at_ms, " +
        "committed, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'matchup_final', 'complete', " +
        "'fresh', ?, 1, ?)"
    ).run(
      IDS.finalSnapshot,
      IDS.source,
      IDS.liveRefresh,
      IDS.league,
      IDS.season,
      IDS.week,
      NOW_MS,
      NOW_MS
    );
    database.prepare(
      "INSERT INTO matchup_results (id, league_id, season_id, matchup_id, current_version_id, " +
        "status, finalized_at_ms, created_at_ms, updated_at_ms, version) " +
        "VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, 1)"
    ).run(
      IDS.finalResult,
      IDS.league,
      IDS.season,
      IDS.matchup,
      NOW_MS,
      NOW_MS
    );
    database.prepare(
      "INSERT INTO matchup_result_versions (id, league_id, season_id, matchup_result_id, " +
        "version_number, home_team_id, away_team_id, home_score_hundredths, " +
        "away_score_hundredths, outcome, source_snapshot_id, source_type, actor_user_id, " +
        "reason, supersedes_version_id, created_at_ms) " +
        "VALUES (?, ?, ?, ?, 1, ?, ?, 325, 0, 'home_win', ?, 'calculated', NULL, NULL, " +
        "NULL, ?)"
    ).run(
      IDS.finalResultVersion,
      IDS.league,
      IDS.season,
      IDS.finalResult,
      IDS.home,
      IDS.away,
      IDS.finalSnapshot,
      NOW_MS
    );
    database.prepare(
      "UPDATE matchup_results SET current_version_id = ?, status = 'official', " +
        "finalized_at_ms = ?, updated_at_ms = ? WHERE id = ?"
    ).run(
      IDS.finalResultVersion,
      NOW_MS,
      NOW_MS,
      IDS.finalResult
    );
    database.prepare(
      "UPDATE matchups SET status = 'final', updated_at_ms = ?, version = version + 1 " +
        "WHERE id = ?"
    ).run(NOW_MS, IDS.matchup);
  })();
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

  test("subtracts the exact post-baseline amount of every excluded NHL game", () => {
    const result = calculateTeamLiveScore({
      lock: { legal: 1, team_id: IDS.home },
      lockedPlayers: [{
        player_id: IDS.player,
        player_full_name: "Scoring Player",
        position_group: "F",
        slot_number: 1,
        baseline_games_played: 10,
        baseline_goals: 1,
        baseline_assists: 1,
        baseline_fantasy_points_hundredths: 225,
      }],
      currentTotals: [{
        player_id: IDS.player,
        games_played: 12,
        goals: 3,
        assists: 4,
        fantasy_points_hundredths: 775,
      }],
      excludedPlayerGames: [
        {
          player_id: IDS.player,
          nhl_game_id: "2026020001",
          baseline_goals: 0,
          baseline_assists: 0,
          baseline_fantasy_points_hundredths: 0,
          current_goals: 1,
          current_assists: 1,
          current_fantasy_points_hundredths: 225,
        },
        {
          player_id: IDS.player,
          nhl_game_id: "2026020002",
          baseline_goals: 0,
          baseline_assists: 0,
          baseline_fantasy_points_hundredths: 0,
          current_goals: 0,
          current_assists: 1,
          current_fantasy_points_hundredths: 100,
        },
      ],
    });

    assert.deepEqual(
      {
        goalDelta: result.players[0].goalDelta,
        assistDelta: result.players[0].assistDelta,
        pointDelta: result.players[0].pointDelta,
        scoreHundredths: result.players[0].scoreHundredths,
      },
      {
        goalDelta: 1,
        assistDelta: 1,
        pointDelta: 2,
        scoreHundredths: 225,
      }
    );
  });

  test("fails closed for missing, regressed, or over-subtracted exclusion evidence", () => {
    const baseInput = {
      lock: { legal: 1, team_id: IDS.home },
      lockedPlayers: [{
        player_id: IDS.player,
        player_full_name: "Scoring Player",
        position_group: "F",
        slot_number: 1,
        baseline_games_played: 10,
        baseline_goals: 1,
        baseline_assists: 1,
        baseline_fantasy_points_hundredths: 225,
      }],
      currentTotals: [{
        player_id: IDS.player,
        games_played: 11,
        goals: 2,
        assists: 1,
        fantasy_points_hundredths: 350,
      }],
    };
    assert.throws(
      () => calculateTeamLiveScore({
        ...baseInput,
        excludedPlayerGames: [{
          player_id: IDS.player,
          nhl_game_id: "2026020001",
          baseline_goals: 0,
          baseline_assists: 0,
          baseline_fantasy_points_hundredths: 0,
          current_goals: null,
          current_assists: null,
          current_fantasy_points_hundredths: null,
        }],
      }),
      { code: MATCHUP_SCORING_CODES.evidenceMissing }
    );
    for (const excludedPlayerGames of [
      [{
        player_id: IDS.player,
        nhl_game_id: "2026020001",
        baseline_goals: 1,
        baseline_assists: 0,
        baseline_fantasy_points_hundredths: 125,
        current_goals: 0,
        current_assists: 0,
        current_fantasy_points_hundredths: 0,
      }],
      [{
        player_id: IDS.player,
        nhl_game_id: "2026020001",
        baseline_goals: 0,
        baseline_assists: 0,
        baseline_fantasy_points_hundredths: 0,
        current_goals: 2,
        current_assists: 0,
        current_fantasy_points_hundredths: 250,
      }],
    ]) {
      assert.throws(
        () => calculateTeamLiveScore({
          ...baseInput,
          excludedPlayerGames,
        }),
        { code: MATCHUP_SCORING_CODES.sourceRegressed }
      );
    }
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

  test("rejects missing legal-player totals while an illegal team remains exactly zero", () => {
    const lockedPlayers = [{
      player_id: IDS.player,
      player_full_name: "Scoring Player",
      position_group: "F",
      slot_number: 1,
      baseline_games_played: 0,
      baseline_goals: 0,
      baseline_assists: 0,
      baseline_fantasy_points_hundredths: 0,
    }];
    assert.throws(
      () => calculateTeamLiveScore({
        lock: { legal: 1, team_id: IDS.home },
        lockedPlayers,
        currentTotals: [],
      }),
      { code: MATCHUP_SCORING_CODES.evidenceMissing }
    );
    assert.deepEqual(
      calculateTeamLiveScore({
        lock: { legal: 0, team_id: IDS.away },
        lockedPlayers,
        currentTotals: [],
      }),
      {
        teamId: IDS.away,
        legal: false,
        scoreHundredths: 0,
        players: [],
      }
    );
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

  test("does not fall back when the newest successful live refresh is missing its sealed root", (t) => {
    const { database, service } = createRuntime(t, {
      withNewerRootlessSuccessful: true,
    });
    const changesBefore = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    assert.throws(
      () => service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES
            .playerGameStatisticsMissing,
      }
    );
    const changesAfter = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    assert.equal(changesAfter, changesBefore);
  });

  test("keeps latest live refresh selection active and provider-allowlisted", (t) => {
    const disallowed = createRuntime(t);
    assert.throws(
      () => disallowed.service.readLive({
        ...input(),
        providers: ["other-live"],
      }),
      { code: MATCHUP_SCORING_SERVICE_CODES.statisticsMissing }
    );

    const disabled = createRuntime(t);
    disabled.database.prepare(
      "UPDATE stat_sources SET status = 'disabled', updated_at_ms = ?, version = version + 1 " +
        "WHERE id = ?"
    ).run(NOW_MS, IDS.source);
    assert.throws(
      () => disabled.service.readLive(input()),
      { code: MATCHUP_SCORING_SERVICE_CODES.statisticsMissing }
    );
  });

  test("scores a sealed explicit-zero refresh without exclusions", (t) => {
    const { service } = createRuntime(t, {
      currentGameGoals: 0,
      currentGameAssists: 0,
      currentGamesPlayed: 10,
      currentTotalGoals: 1,
      currentTotalAssists: 1,
    });
    const result = service.readLive(input());
    assert.equal(result.home.scoreHundredths, 0);
    assert.equal(result.home.players[0].scoreHundredths, 0);
    assert.equal(result.home.players[0].dataStatus, "available");
    assert.equal(result.away.scoreHundredths, 0);

    const terminalCoverage = createRuntime(t, {
      currentCoverageDisposition: "no_due_game",
    }).service.readLive(input());
    assert.equal(terminalCoverage.home.scoreHundredths, 325);
    assert.equal(terminalCoverage.home.players[0].dataStatus, "available");
  });

  test("blocks scoring when a legally locked player lacks current totals", (t) => {
    const { database, service } = createRuntime(t);
    database.prepare(
      "DELETE FROM player_stat_totals WHERE id = ?"
    ).run(IDS.liveTotal);
    assert.throws(
      () => service.readLive(input()),
      { code: MATCHUP_SCORING_CODES.evidenceMissing }
    );
  });

  test("reconstructs a final breakdown from its exact persisted refresh without writes", (t) => {
    const { database, service } = createRuntime(t);
    persistFinalResult(database);
    const changesBefore = database.prepare("SELECT total_changes() AS count").get().count;
    const result = service.readAtRefresh({
      ...input(),
      refreshId: IDS.liveRefresh,
    });
    const changedAllowlist = service.readAtRefresh({
      ...input(),
      provider: undefined,
      providers: ["other-live"],
      refreshId: IDS.liveRefresh,
    });
    const changesAfter = database.prepare("SELECT total_changes() AS count").get().count;
    assert.equal(result.source.refreshId, IDS.liveRefresh);
    assert.equal(result.home.players[0].fullName, "Scoring Player");
    assert.equal(result.home.players[0].pointDelta, 3);
    assert.deepEqual(changedAllowlist, result);
    assert.equal(changesAfter, changesBefore);

    database.prepare(
      "UPDATE stat_sources SET status = 'disabled', updated_at_ms = ?, version = version + 1 " +
        "WHERE id = ?"
    ).run(NOW_MS, IDS.source);
    const disabledChangesBefore = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    const disabledSource = service.readAtRefresh({
      ...input(),
      providers: ["other-live"],
      refreshId: IDS.liveRefresh,
    });
    assert.deepEqual(disabledSource, result);
    assert.throws(
      () => service.readAtRefresh({
        ...input(),
        providers: ["other-live"],
        refreshId: IDS.baselineRefresh,
      }),
      { code: MATCHUP_SCORING_SERVICE_CODES.statisticsMissing }
    );
    const disabledChangesAfter = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    assert.equal(disabledChangesAfter, disabledChangesBefore);
  });

  test("subtracts immutable late-lock exclusions using the selected refresh's exact player-game row", (t) => {
    const { database, service } = createRuntime(t, { withExclusion: true });
    const changesBefore = database.prepare("SELECT total_changes() AS count").get().count;
    const result = service.readLive(input());
    const changesAfter = database.prepare("SELECT total_changes() AS count").get().count;

    assert.equal(result.home.scoreHundredths, 100);
    assert.equal(result.home.players[0].goalDelta, 0);
    assert.equal(result.home.players[0].assistDelta, 1);
    assert.equal(result.home.players[0].pointDelta, 1);
    assert.equal(changesAfter, changesBefore);
  });

  test("requires current expected-game coverage for every excluded pair", (t) => {
    for (const options of [
      {
        withExclusion: true,
        currentCoverageDisposition: "no_due_game",
      },
      {
        withExclusion: true,
        omitCurrentCoverage: true,
      },
    ]) {
      const { service } = createRuntime(t, options);
      assert.throws(
        () => service.readLive(input()),
        {
          code:
            MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
        }
      );
    }
  });

  test("rejects regressed or incompatible excluded-pair source evidence", (t) => {
    const { service } = createRuntime(t, {
      withExclusion: true,
      currentSourceUpdatedAtMs: NOW_MS - 19 * HOUR_MS - 1,
    });
    assert.throws(
      () => service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );

    const incompatible = createRuntime(t, { withExclusion: true });
    incompatible.database.exec(
      "DROP TRIGGER stat_refresh_player_game_sets_immutable_update"
    );
    incompatible.database.prepare(
      "UPDATE stat_refresh_player_game_sets SET provider = 'other-live' WHERE id = ?"
    ).run(IDS.baselineGameSet);
    assert.throws(
      () => incompatible.service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );

    const wrongHistoricalTeam = createRuntime(t, {
      withExclusion: true,
      currentProviderTeamId: "team-2",
    });
    assert.throws(
      () => wrongHistoricalTeam.service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );
  });

  test("recomputes player-game digests and sealed counts", (t) => {
    for (const options of [
      { currentCoverageSha256: "a".repeat(64) },
      { currentEvidenceSha256: "b".repeat(64) },
      {
        withExclusion: true,
        baselineCoverageSha256: "c".repeat(64),
      },
      {
        withExclusion: true,
        baselineEvidenceSha256: "d".repeat(64),
      },
    ]) {
      const { service } = createRuntime(t, options);
      assert.throws(
        () => service.readLive(input()),
        {
          code:
            MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
        }
      );
    }

    const counted = createRuntime(t);
    counted.database.exec(
      "DROP TRIGGER stat_refresh_player_game_sets_immutable_update"
    );
    counted.database.prepare(
      "UPDATE stat_refresh_player_game_sets SET coverage_entry_count = 2 WHERE id = ?"
    ).run(IDS.liveGameSet);
    assert.throws(
      () => counted.service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );
  });

  test("fails closed for missing, extra, and wrong-pair sealed children", (t) => {
    const missing = createRuntime(t);
    missing.database.exec(
      "DROP TRIGGER stat_refresh_player_game_coverage_immutable_delete"
    );
    missing.database.prepare(
      "DELETE FROM stat_refresh_player_game_coverage_entries WHERE id = ?"
    ).run(IDS.liveCoverage);
    assert.throws(
      () => missing.service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );

    const extra = createRuntime(t);
    extra.database.exec(
      "DROP TRIGGER stat_refresh_player_game_coverage_stage_before_set"
    );
    extra.database.prepare(
      "INSERT INTO stat_refresh_player_game_coverage_entries " +
        "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
        "player_id, provider_player_id, provider_team_id, disposition, " +
        "nhl_game_id, nhl_game_scheduled_starts_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, '20262027', ?, '8', 'team-1', 'no_due_game', " +
        "NULL, NULL, ?, 1)"
    ).run(
      IDS.extraCoverage,
      IDS.source,
      IDS.liveRefresh,
      IDS.liveGameSet,
      IDS.player,
      NOW_MS - HOUR_MS
    );
    assert.throws(
      () => extra.service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );

    const wrongPair = createRuntime(t);
    wrongPair.database.exec(
      "DROP TRIGGER player_game_stat_observations_immutable_update"
    );
    wrongPair.database.prepare(
      "UPDATE player_game_stat_observations " +
        "SET nhl_game_scheduled_starts_at_ms = nhl_game_scheduled_starts_at_ms + 1 " +
        "WHERE id = ?"
    ).run(IDS.liveGameObservation);
    assert.throws(
      () => wrongPair.service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );

    const baselineTampered = createRuntime(t, {
      withExclusion: true,
    });
    baselineTampered.database.exec(
      "DROP TRIGGER player_game_stat_observations_immutable_update"
    );
    baselineTampered.database.prepare(
      "UPDATE player_game_stat_observations " +
        "SET source_updated_at_ms = source_updated_at_ms - 1 " +
        "WHERE id = ?"
    ).run(IDS.baselineGameObservation);
    assert.throws(
      () => baselineTampered.service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      }
    );
  });

  test("fails closed when an explicitly selected refresh loses its sealed root", (t) => {
    const { database, service } = createRuntime(t);
    persistFinalResult(database);
    database.exec(
      "DROP TRIGGER stat_refresh_player_game_coverage_immutable_delete; " +
        "DROP TRIGGER player_game_stat_observations_immutable_delete; " +
        "DROP TRIGGER stat_refresh_player_game_sets_immutable_delete"
    );
    database.prepare(
      "DELETE FROM stat_refresh_player_game_coverage_entries WHERE observation_set_id = ?"
    ).run(IDS.liveGameSet);
    database.prepare(
      "DELETE FROM player_game_stat_observations WHERE observation_set_id = ?"
    ).run(IDS.liveGameSet);
    database.prepare(
      "DELETE FROM stat_refresh_player_game_sets WHERE id = ?"
    ).run(IDS.liveGameSet);
    assert.throws(
      () => service.readAtRefresh({
        ...input(),
        refreshId: IDS.liveRefresh,
      }),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES
            .playerGameStatisticsMissing,
      }
    );
  });

  test("verifies game-state and exclusion roots before subtraction", (t) => {
    for (const options of [
      { withExclusion: true, gameStateSha256: "c".repeat(64) },
      { withExclusion: true, exclusionSha256: "d".repeat(64) },
    ]) {
      const { service } = createRuntime(t, options);
      assert.throws(
        () => service.readLive(input()),
        {
          code:
            MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
        }
      );
    }
  });

  test("does not score a totals-only refresh without its sealed player-game evidence root", (t) => {
    const { service } = createRuntime(t, { withPlayerGameEvidence: false });
    assert.throws(
      () => service.readLive(input()),
      {
        code:
          MATCHUP_SCORING_SERVICE_CODES
            .playerGameStatisticsMissing,
      }
    );
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
