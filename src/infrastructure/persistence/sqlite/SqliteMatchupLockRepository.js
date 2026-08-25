const {
  createMatchupLateLockExclusionSetEvidence,
  createNhlGameObservationSnapshotEvidence,
} = require("../../../domain/matchups/matchupLateLockEvidencePolicy");
const {
  verifySealedLateLockEvidence,
  verifySealedPlayerGameSet,
} = require("../../../domain/matchups/matchupSealedEvidenceVerifier");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A stable identifier is required.");
  }
  return value;
}

function freezeRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function playerGameRoot(row) {
  return Object.freeze({
    setId: row.id,
    statSourceId: row.stat_source_id,
    refreshId: row.refresh_id,
    nhlSeasonKey: row.nhl_season_key,
    provider: row.provider,
    sourceVersion: row.source_version,
    capturedAtMs: row.captured_at_ms,
    requiredPlayerCount: row.required_player_count,
    coverageEntryCount: row.coverage_entry_count,
    expectedPlayerGameCount: row.expected_player_game_count,
    coverageSchemaVersion: row.coverage_schema_version,
    coverageSha256: row.coverage_sha256,
    observationCount: row.observation_count,
    evidenceSchemaVersion: row.evidence_schema_version,
    evidenceSha256: row.evidence_sha256,
  });
}

function playerGameCoverage(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({
    coverageEntryId: row.id,
    playerId: row.player_id,
    providerPlayerId: row.provider_player_id,
    providerTeamId: row.provider_team_id,
    disposition: row.disposition,
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
  })));
}

function playerGameObservations(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({
    observationId: row.id,
    playerId: row.player_id,
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
    observedGameState: row.observed_game_state,
    goals: row.goals,
    assists: row.assists,
    nhlPoints: row.nhl_points,
    fantasyPointsHundredths: row.fantasy_points_hundredths,
    sourceUpdatedAtMs: row.source_updated_at_ms,
  })));
}

function gameStateRoot(row) {
  return Object.freeze({
    observationSnapshotId: row.id,
    provider: row.provider,
    sourceVersion: row.source_version,
    observedAtMs: row.observed_at_ms,
    freshnessStatus: row.freshness_status,
    observationCount: row.observation_count,
    evidenceSchemaVersion: row.evidence_schema_version,
    observationSha256: row.observation_sha256,
  });
}

function gameStates(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
    observedGameState: row.observed_game_state,
  })));
}

function exclusionRoot(row, observationSha256) {
  return Object.freeze({
    exclusionSetId: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    matchupWeekId: row.matchup_week_id,
    matchupId: row.matchup_id,
    teamId: row.team_id,
    matchupRosterLockId: row.matchup_roster_lock_id,
    lateSnapshotAtMs: row.late_snapshot_at_ms,
    observationSnapshotId: row.observation_snapshot_id,
    observationSha256,
    exclusionCount: row.exclusion_count,
    evidenceSchemaVersion: row.evidence_schema_version,
    evidenceSha256: row.evidence_sha256,
  });
}

function exclusions(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({
    exclusionId: row.id,
    matchupRosterPlayerId: row.matchup_roster_player_id,
    playerId: row.player_id,
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
    observedGameState: row.observed_game_state,
    baselinePlayerGameStatObservationId:
      row.baseline_player_game_stat_observation_id,
  })));
}

function verifyPlayerGameRows(rootRow, coverageRows, observationRows) {
  return verifySealedPlayerGameSet({
    root: playerGameRoot(rootRow),
    coverage: playerGameCoverage(coverageRows),
    observations: playerGameObservations(observationRows),
  });
}

function json(value) {
  return JSON.stringify(value);
}

function createSqliteMatchupLockRepository({
  database,
  beforeCommit,
  occurrenceExecutionGuard,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupLockRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup-lock beforeCommit must be a function");
  }
  if (
    occurrenceExecutionGuard !== undefined &&
    (
      !occurrenceExecutionGuard ||
      typeof occurrenceExecutionGuard.assertCurrent !== "function"
    )
  ) {
    throw new TypeError(
      "matchup-lock occurrenceExecutionGuard must assert current execution"
    );
  }

  const weekStatement = database.prepare(
    "SELECT matchup_weeks.*, seasons.nhl_season_key, matchups.id AS matchup_id " +
      "FROM matchup_weeks " +
      "JOIN seasons ON seasons.league_id = matchup_weeks.league_id " +
      "AND seasons.id = matchup_weeks.season_id " +
      "JOIN matchups ON matchups.league_id = matchup_weeks.league_id " +
      "AND matchups.season_id = matchup_weeks.season_id " +
      "AND matchups.matchup_week_id = matchup_weeks.id " +
      "WHERE matchup_weeks.league_id = @leagueId AND matchup_weeks.season_id = @seasonId " +
      "AND matchup_weeks.id = @weekId " +
      "AND @teamId IN (matchups.home_team_id, matchups.away_team_id) LIMIT 2"
  );
  const playersStatement = database.prepare(
    "SELECT id AS ownership_id, player_id, position_group, slot_number, version " +
      "FROM player_ownerships WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND team_id = @teamId AND ownership_kind = 'Rostered' AND roster_category = 'Active' " +
      "ORDER BY position_group, slot_number, player_id"
  );
  const refreshStatement = database.prepare(
    "SELECT stat_refreshes.*, stat_sources.provider FROM stat_refreshes " +
      "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
      "WHERE stat_sources.provider = @provider AND stat_sources.status = 'active' " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
      "AND stat_refreshes.status = 'succeeded' AND stat_refreshes.completed_at_ms <= @baselineAtMs " +
      "ORDER BY stat_refreshes.completed_at_ms DESC, stat_refreshes.id DESC LIMIT 1"
  );
  const sealedRefreshStatement = database.prepare(
    "SELECT stat_refreshes.*, stat_sources.provider FROM stat_refreshes " +
      "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
      "JOIN stat_refresh_player_game_sets ON " +
      "stat_refresh_player_game_sets.stat_source_id = stat_refreshes.stat_source_id " +
      "AND stat_refresh_player_game_sets.refresh_id = stat_refreshes.id " +
      "WHERE stat_sources.provider = @provider AND stat_sources.status = 'active' " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
      "AND stat_refreshes.status = 'succeeded' AND stat_refreshes.completed_at_ms <= @baselineAtMs " +
      "ORDER BY stat_refreshes.completed_at_ms DESC, stat_refreshes.id DESC LIMIT 1"
  );
  const totalsStatement = database.prepare(
    "SELECT player_id, games_played, goals, assists, fantasy_points_hundredths " +
      "FROM player_stat_totals WHERE refresh_id = @refreshId ORDER BY player_id"
  );
  const playerGameSetStatement = database.prepare(
    "SELECT * FROM stat_refresh_player_game_sets " +
      "WHERE stat_source_id = @statSourceId AND refresh_id = @refreshId LIMIT 2"
  );
  const playerGameCoverageStatement = database.prepare(
    "SELECT * FROM stat_refresh_player_game_coverage_entries " +
      "WHERE stat_source_id = @statSourceId AND refresh_id = @refreshId " +
      "AND observation_set_id = @playerGameSetId " +
      "ORDER BY player_id, disposition, nhl_game_id, id"
  );
  const playerGameObservationsStatement = database.prepare(
    "SELECT player_game_stat_observations.* " +
      "FROM player_game_stat_observations " +
      "JOIN stat_refresh_player_game_sets " +
      "ON stat_refresh_player_game_sets.stat_source_id = " +
      "player_game_stat_observations.stat_source_id " +
      "AND stat_refresh_player_game_sets.refresh_id = " +
      "player_game_stat_observations.refresh_id " +
      "AND stat_refresh_player_game_sets.id = " +
      "player_game_stat_observations.observation_set_id " +
      "WHERE player_game_stat_observations.stat_source_id = @statSourceId " +
      "AND player_game_stat_observations.refresh_id = @refreshId " +
      "AND player_game_stat_observations.observation_set_id = @playerGameSetId " +
      "ORDER BY player_game_stat_observations.player_id, " +
      "player_game_stat_observations.nhl_game_id, " +
      "player_game_stat_observations.id"
  );
  const lockByScopeStatement = database.prepare(
    "SELECT * FROM matchup_roster_locks WHERE league_id = @leagueId " +
      "AND matchup_week_id = @weekId AND team_id = @teamId LIMIT 2"
  );
  const lockPlayerCountStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM matchup_roster_players WHERE league_id = @leagueId " +
      "AND matchup_roster_lock_id = @lockId"
  );
  const lockPlayersStatement = database.prepare(
    "SELECT * FROM matchup_roster_players WHERE league_id = @leagueId " +
      "AND matchup_roster_lock_id = @lockId " +
      "ORDER BY position_group, slot_number, player_id, id"
  );
  const snapshotByIdStatement = database.prepare(
    "SELECT * FROM stat_snapshots WHERE league_id = @leagueId " +
      "AND id = @snapshotId LIMIT 2"
  );
  const gameObservationSnapshotByIdStatement = database.prepare(
    "SELECT * FROM nhl_game_state_observation_snapshots " +
      "WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND id = @observationSnapshotId LIMIT 2"
  );
  const gameObservationsBySnapshotStatement = database.prepare(
    "SELECT * FROM nhl_game_state_observations " +
      "WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND observation_snapshot_id = @observationSnapshotId " +
      "ORDER BY nhl_game_id, id"
  );
  const exclusionsBySetStatement = database.prepare(
    "SELECT * FROM matchup_roster_game_exclusions " +
      "WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND exclusion_set_id = @exclusionSetId " +
      "ORDER BY player_id, nhl_game_id, id"
  );
  const insertSnapshot = database.prepare(
    "INSERT INTO stat_snapshots " +
      "(id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (@snapshotId, @statSourceId, @refreshId, @leagueId, @seasonId, @weekId, " +
      "'matchup_baseline', 'complete', 'fresh', @baselineAtMs, 1, @nowMs)"
  );
  const insertSnapshotPlayer = database.prepare(
    "INSERT INTO stat_snapshot_players " +
      "(id, league_id, stat_snapshot_id, player_id, games_played, goals, assists, " +
      "nhl_points, fantasy_points_hundredths, created_at_ms) " +
      "VALUES (@snapshotPlayerId, @leagueId, @snapshotId, @playerId, @baselineGamesPlayed, " +
      "@baselineGoals, @baselineAssists, @nhlPoints, @baselineFantasyPointsHundredths, @nowMs)"
  );
  const insertLock = database.prepare(
    "INSERT INTO matchup_roster_locks " +
      "(id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, locked_at_ms, " +
      "baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (@lockId, @leagueId, @seasonId, @weekId, @teamId, 'normal', 1, @locksAtMs, " +
      "@snapshotId, 'fresh', @nowMs, 1)"
  );
  const insertIllegalLock = database.prepare(
    "INSERT INTO matchup_roster_locks " +
      "(id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, " +
      "created_at_ms, version) VALUES (@lockId, @leagueId, @seasonId, @weekId, @teamId, " +
      "'normal', 0, @reasonCode, @locksAtMs, NULL, 'unknown', @nowMs, 1)"
  );
  const promoteLateLock = database.prepare(
    "UPDATE matchup_roster_locks SET lock_type = 'late', legal = 1, legality_reason_code = NULL, " +
      "locked_at_ms = @baselineAtMs, baseline_snapshot_id = @snapshotId, " +
      "source_freshness_status = 'fresh', version = version + 1 " +
      "WHERE id = @lockId AND league_id = @leagueId AND season_id = @seasonId " +
      "AND matchup_week_id = @weekId AND team_id = @teamId AND lock_type = 'normal' " +
      "AND legal = 0 AND version = @expectedLockVersion"
  );
  const insertLockPlayer = database.prepare(
    "INSERT INTO matchup_roster_players " +
      "(id, league_id, season_id, matchup_roster_lock_id, player_id, position_group, slot_number, " +
      "baseline_games_played, baseline_goals, baseline_assists, " +
      "baseline_fantasy_points_hundredths, created_at_ms) " +
      "VALUES (@lockPlayerId, @leagueId, @seasonId, @lockId, @playerId, @positionGroup, " +
      "@slotNumber, @baselineGamesPlayed, @baselineGoals, @baselineAssists, " +
      "@baselineFantasyPointsHundredths, @nowMs)"
  );
  const insertGameObservation = database.prepare(
    "INSERT INTO nhl_game_state_observations " +
      "(id, league_id, season_id, observation_snapshot_id, nhl_game_id, " +
      "nhl_game_scheduled_starts_at_ms, observed_game_state, observed_at_ms, " +
      "created_at_ms, version) VALUES (@observationId, @leagueId, @seasonId, " +
      "@observationSnapshotId, @nhlGameId, @nhlGameScheduledStartsAtMs, " +
      "@observedGameState, @observationObservedAtMs, @observationObservedAtMs, 1)"
  );
  const insertGameObservationSnapshot = database.prepare(
    "INSERT INTO nhl_game_state_observation_snapshots " +
      "(id, league_id, season_id, matchup_week_id, team_id, provider, " +
      "source_version, observed_at_ms, freshness_status, observation_count, " +
      "evidence_schema_version, observation_sha256, created_at_ms, version) " +
      "VALUES (@observationSnapshotId, @leagueId, @seasonId, @weekId, @teamId, " +
      "@observationProvider, @observationSourceVersion, @observationObservedAtMs, " +
      "'fresh', @observationCount, 1, @observationSha256, " +
      "@observationObservedAtMs, 1)"
  );
  const insertGameExclusion = database.prepare(
    "INSERT INTO matchup_roster_game_exclusions " +
      "(id, league_id, season_id, exclusion_set_id, matchup_week_id, matchup_id, " +
      "team_id, matchup_roster_lock_id, matchup_roster_player_id, player_id, " +
      "observation_snapshot_id, observation_id, " +
      "baseline_player_game_stat_observation_id, nhl_game_id, " +
      "nhl_game_scheduled_starts_at_ms, observed_game_state, late_snapshot_at_ms, " +
      "created_at_ms, version) VALUES (@exclusionId, @leagueId, @seasonId, " +
      "@exclusionSetId, @weekId, @matchupId, @teamId, @lockId, " +
      "@matchupRosterPlayerId, @playerId, @observationSnapshotId, @observationId, " +
      "@baselinePlayerGameStatObservationId, @nhlGameId, " +
      "@nhlGameScheduledStartsAtMs, @observedGameState, @baselineAtMs, " +
      "@baselineAtMs, 1)"
  );
  const insertGameExclusionSet = database.prepare(
    "INSERT INTO matchup_roster_game_exclusion_sets " +
      "(id, league_id, season_id, matchup_week_id, matchup_id, team_id, " +
      "matchup_roster_lock_id, matchup_roster_lock_version, baseline_snapshot_id, " +
      "observation_snapshot_id, late_snapshot_at_ms, exclusion_count, " +
      "evidence_schema_version, evidence_sha256, sealed_at_ms, created_at_ms, version) " +
      "VALUES (@exclusionSetId, @leagueId, @seasonId, @weekId, @matchupId, @teamId, " +
      "@lockId, @matchupRosterLockVersion, @snapshotId, @observationSnapshotId, " +
      "@baselineAtMs, @exclusionCount, 1, @exclusionEvidenceSha256, @baselineAtMs, " +
      "@baselineAtMs, 1)"
  );
  const exclusionSetByLockStatement = database.prepare(
    "SELECT * FROM matchup_roster_game_exclusion_sets " +
      "WHERE league_id = @leagueId AND matchup_roster_lock_id = @lockId LIMIT 2"
  );

  function scope(input) {
    return {
      leagueId: stableId(input.leagueId),
      seasonId: stableId(input.seasonId),
      weekId: stableId(input.weekId),
      teamId: stableId(input.teamId),
    };
  }

  function exactlyOne(rows, message) {
    if (rows.length !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        message
      );
    }
    return rows[0];
  }

  function contextPlayerGameBundle(current) {
    return Object.freeze({
      root: playerGameRoot(current.playerGameSet),
      coverage: playerGameCoverage(current.playerGameCoverage),
      observations: playerGameObservations(
        current.playerGameObservations
      ),
    });
  }

  function candidateLateEvidenceBundle(
    command,
    current,
    observationEvidence,
    exclusionEvidence
  ) {
    const playerGame = contextPlayerGameBundle(current);
    return Object.freeze({
      playerGameRoot: playerGame.root,
      coverage: playerGame.coverage,
      playerGameObservations: playerGame.observations,
      selectedRosterPlayers: Object.freeze(
        command.players.map((row) => Object.freeze({
          playerId: row.playerId,
          matchupRosterPlayerId: row.lockPlayerId,
        }))
      ),
      weekStartsAtMs: current.week.starts_at_ms,
      weekEndsAtMs: current.week.ends_at_ms,
      gameStateRoot: Object.freeze({
        observationSnapshotId: command.observationSnapshotId,
        provider: observationEvidence.preimage.provider,
        sourceVersion: observationEvidence.preimage.sourceVersion,
        observedAtMs: observationEvidence.preimage.observedAtMs,
        freshnessStatus: observationEvidence.preimage.freshnessStatus,
        observationCount: observationEvidence.observationCount,
        evidenceSchemaVersion:
          observationEvidence.preimage.schemaVersion,
        observationSha256: observationEvidence.observationSha256,
      }),
      gameStates: observationEvidence.preimage.games,
      exclusionRoot: Object.freeze({
        exclusionSetId: command.exclusionSetId,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        matchupWeekId: command.weekId,
        matchupId: command.matchupId,
        teamId: command.teamId,
        matchupRosterLockId: command.lockId,
        lateSnapshotAtMs: command.baselineAtMs,
        observationSnapshotId: command.observationSnapshotId,
        observationSha256: observationEvidence.observationSha256,
        exclusionCount: exclusionEvidence.exclusionCount,
        evidenceSchemaVersion:
          exclusionEvidence.preimage.schemaVersion,
        evidenceSha256: exclusionEvidence.evidenceSha256,
      }),
      exclusions: exclusionEvidence.preimage.exclusions,
    });
  }

  function readCommittedLateEvidence(current, existing) {
    const exclusionSet = exactlyOne(
      exclusionSetByLockStatement.all({
        leagueId: existing.league_id,
        lockId: existing.id,
      }),
      "The late matchup lock has incomplete exclusion evidence."
    );
    const baselineSnapshot = exactlyOne(
      snapshotByIdStatement.all({
        leagueId: existing.league_id,
        snapshotId: existing.baseline_snapshot_id,
      }),
      "The late matchup lock has incomplete baseline evidence."
    );
    const playerGameSet = exactlyOne(
      playerGameSetStatement.all({
        statSourceId: baselineSnapshot.stat_source_id,
        refreshId: baselineSnapshot.source_refresh_id,
      }),
      "The late matchup lock has incomplete player-game evidence."
    );
    const evidenceParameters = {
      statSourceId: playerGameSet.stat_source_id,
      refreshId: playerGameSet.refresh_id,
      playerGameSetId: playerGameSet.id,
    };
    const coverageRows = playerGameCoverageStatement.all(
      evidenceParameters
    );
    const observationRows = playerGameObservationsStatement.all(
      evidenceParameters
    );
    verifyPlayerGameRows(
      playerGameSet,
      coverageRows,
      observationRows
    );
    const observationSnapshot = exactlyOne(
      gameObservationSnapshotByIdStatement.all({
        leagueId: existing.league_id,
        seasonId: existing.season_id,
        observationSnapshotId: exclusionSet.observation_snapshot_id,
      }),
      "The late matchup lock has incomplete game-state evidence."
    );
    const observationRowsByGame =
      gameObservationsBySnapshotStatement.all({
        leagueId: existing.league_id,
        seasonId: existing.season_id,
        observationSnapshotId: observationSnapshot.id,
      });
    const exclusionRows = exclusionsBySetStatement.all({
      leagueId: existing.league_id,
      seasonId: existing.season_id,
      exclusionSetId: exclusionSet.id,
    });
    const lockedPlayers = lockPlayersStatement.all({
      leagueId: existing.league_id,
      lockId: existing.id,
    });
    if (
      baselineSnapshot.season_id !== existing.season_id ||
      baselineSnapshot.matchup_week_id !== existing.matchup_week_id ||
      baselineSnapshot.intended_use !== "matchup_baseline" ||
      baselineSnapshot.completeness_status !== "complete" ||
      baselineSnapshot.freshness_status !== "fresh" ||
      baselineSnapshot.committed !== 1 ||
      baselineSnapshot.captured_at_ms !== existing.locked_at_ms ||
      exclusionSet.baseline_snapshot_id !== baselineSnapshot.id ||
      exclusionSet.matchup_roster_lock_version !== existing.version ||
      observationSnapshot.matchup_week_id !== existing.matchup_week_id ||
      observationSnapshot.team_id !== existing.team_id
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The late matchup lock evidence scope is inconsistent."
      );
    }
    const bundle = Object.freeze({
      playerGameRoot: playerGameRoot(playerGameSet),
      coverage: playerGameCoverage(coverageRows),
      playerGameObservations:
        playerGameObservations(observationRows),
      selectedRosterPlayers: Object.freeze(
        lockedPlayers.map((row) => Object.freeze({
          playerId: row.player_id,
          matchupRosterPlayerId: row.id,
        }))
      ),
      weekStartsAtMs: current.week.starts_at_ms,
      weekEndsAtMs: current.week.ends_at_ms,
      gameStateRoot: gameStateRoot(observationSnapshot),
      gameStates: gameStates(observationRowsByGame),
      exclusionRoot: exclusionRoot(
        exclusionSet,
        observationSnapshot.observation_sha256
      ),
      exclusions: exclusions(exclusionRows),
    });
    verifySealedLateLockEvidence(bundle);
    return Object.freeze({
      baselineSnapshot: Object.freeze({ ...baselineSnapshot }),
      bundle,
      exclusionSet: Object.freeze({ ...exclusionSet }),
      lockedPlayers: freezeRows(lockedPlayers),
    });
  }

  function rosterSemantics(rows, persisted) {
    return rows.map((row) => persisted
      ? {
          playerId: row.player_id,
          positionGroup: row.position_group,
          slotNumber: row.slot_number,
          baselineGamesPlayed: row.baseline_games_played,
          baselineGoals: row.baseline_goals,
          baselineAssists: row.baseline_assists,
          baselineFantasyPointsHundredths:
            row.baseline_fantasy_points_hundredths,
        }
      : {
          playerId: row.playerId,
          positionGroup: row.positionGroup,
          slotNumber: row.slotNumber,
          baselineGamesPlayed: row.baselineGamesPlayed,
          baselineGoals: row.baselineGoals,
          baselineAssists: row.baselineAssists,
          baselineFantasyPointsHundredths:
            row.baselineFantasyPointsHundredths,
        });
  }

  function semanticLateEvidence(bundle, roster) {
    return {
      playerGameRoot: bundle.playerGameRoot,
      coverage: bundle.coverage,
      playerGameObservations: bundle.playerGameObservations,
      roster,
      weekStartsAtMs: bundle.weekStartsAtMs,
      weekEndsAtMs: bundle.weekEndsAtMs,
      gameState: {
        provider: bundle.gameStateRoot.provider,
        sourceVersion: bundle.gameStateRoot.sourceVersion,
        observedAtMs: bundle.gameStateRoot.observedAtMs,
        freshnessStatus: bundle.gameStateRoot.freshnessStatus,
        games: bundle.gameStates,
      },
      exclusionScope: {
        leagueId: bundle.exclusionRoot.leagueId,
        seasonId: bundle.exclusionRoot.seasonId,
        matchupWeekId: bundle.exclusionRoot.matchupWeekId,
        matchupId: bundle.exclusionRoot.matchupId,
        teamId: bundle.exclusionRoot.teamId,
        matchupRosterLockId:
          bundle.exclusionRoot.matchupRosterLockId,
        lateSnapshotAtMs: bundle.exclusionRoot.lateSnapshotAtMs,
      },
      exclusions: bundle.exclusions.map((row) => ({
        playerId: row.playerId,
        nhlGameId: row.nhlGameId,
        nhlGameScheduledStartsAtMs:
          row.nhlGameScheduledStartsAtMs,
        observedGameState: row.observedGameState,
        baselinePlayerGameStatObservationId:
          row.baselinePlayerGameStatObservationId,
      })),
    };
  }

  function assertCurrentOccurrenceExecution(command) {
    if (command.occurrenceExecution === undefined) return;
    if (!occurrenceExecutionGuard) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A matchup occurrence execution guard is required."
      );
    }
    occurrenceExecutionGuard.assertCurrent(
      command.occurrenceExecution
    );
    if (
      command.occurrenceExecution.leagueId !== command.leagueId ||
      command.occurrenceExecution.seasonId !== command.seasonId ||
      command.occurrenceExecution.weekId !== command.weekId
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "The matchup occurrence execution scope does not match the lock command."
      );
    }
  }

  function readContext(input) {
    try {
      const keys = scope(input);
      const weeks = weekStatement.all(keys);
      if (weeks.length > 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The matchup week is ambiguous.");
      }
      if (weeks.length === 0) return null;
      const week = weeks[0];
      const refreshCutoffAtMs = input.baselineCutoffAtMs ?? week.baseline_at_ms;
      const selectedRefreshStatement =
        input.requireSealedPlayerGameEvidence === true
          ? sealedRefreshStatement
          : refreshStatement;
      const refresh = selectedRefreshStatement.get({
        provider: input.provider,
        nhlSeasonKey: week.nhl_season_key,
        baselineAtMs: refreshCutoffAtMs,
      }) || null;
      const playerGameSets =
        input.requireSealedPlayerGameEvidence === true && refresh
          ? playerGameSetStatement.all({
              statSourceId: refresh.stat_source_id,
              refreshId: refresh.id,
            })
          : [];
      if (playerGameSets.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The statistics refresh has multiple player-game roots."
        );
      }
      const playerGameSet = playerGameSets[0] || null;
      const evidenceParameters = playerGameSet
        ? {
            statSourceId: refresh.stat_source_id,
            refreshId: refresh.id,
            playerGameSetId: playerGameSet.id,
          }
        : null;
      const coverageRows = evidenceParameters
        ? playerGameCoverageStatement.all(evidenceParameters)
        : [];
      const observationRows = evidenceParameters
        ? playerGameObservationsStatement.all(evidenceParameters)
        : [];
      if (playerGameSet) {
        verifyPlayerGameRows(
          playerGameSet,
          coverageRows,
          observationRows
        );
      }
      return Object.freeze({
        week: Object.freeze({ ...week }),
        activePlayers: freezeRows(playersStatement.all(keys)),
        refresh: refresh ? Object.freeze({ ...refresh }) : null,
        totals: refresh ? freezeRows(totalsStatement.all({ refreshId: refresh.id })) : Object.freeze([]),
        playerGameSet: playerGameSet
          ? Object.freeze({ ...playerGameSet })
          : null,
        playerGameCoverage: freezeRows(coverageRows),
        playerGameObservations: freezeRows(observationRows),
        existingLocks: freezeRows(lockByScopeStatement.all(keys)),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readMatchupLockContext", tableName: "matchup_roster_locks" });
    }
  }

  const persistTransaction = database.transaction((command) => {
    assertCurrentOccurrenceExecution(command);
    const current = readContext(command);
    if (!current) {
      throw repositoryError(REPOSITORY_ERROR_CODES.recordNotFound, "The matchup lock context is missing.");
    }
    if (current.existingLocks.length > 0) {
      const existing = current.existingLocks[0];
      if (current.existingLocks.length === 1 && existing.id === command.lockId) {
        return Object.freeze({
          replayed: true,
          lock: existing,
          playerCount: lockPlayerCountStatement.get({
            leagueId: command.leagueId,
            lockId: command.lockId,
          }).count,
        });
      }
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The team already has a matchup lock.");
    }
    const currentFingerprint = JSON.stringify(current.activePlayers);
    if (
      current.week.version !== command.expectedWeekVersion ||
      current.week.status !== "live" ||
      current.refresh?.id !== command.refreshId ||
      currentFingerprint !== command.activePlayerFingerprint
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The matchup lock sources changed.");
    }
    insertSnapshot.run(command);
    for (const player of command.players) {
      insertSnapshotPlayer.run({
        ...command,
        ...player,
        nhlPoints: player.baselineGoals + player.baselineAssists,
      });
    }
    insertLock.run(command);
    for (const player of command.players) insertLockPlayer.run({ ...command, ...player });
    if (beforeCommit) beforeCommit();
    return Object.freeze({
      replayed: false,
      lock: Object.freeze({
        id: command.lockId,
        league_id: command.leagueId,
        season_id: command.seasonId,
        matchup_week_id: command.weekId,
        team_id: command.teamId,
        lock_type: "normal",
        legal: 1,
        locked_at_ms: command.locksAtMs,
        baseline_snapshot_id: command.snapshotId,
        source_freshness_status: "fresh",
      }),
      playerCount: command.players.length,
    });
  });

  function insertBaseline(command) {
    insertSnapshot.run(command);
    for (const player of command.players) {
      insertSnapshotPlayer.run({
        ...command,
        ...player,
        nhlPoints: player.baselineGoals + player.baselineAssists,
      });
    }
  }

  const illegalTransaction = database.transaction((command) => {
    assertCurrentOccurrenceExecution(command);
    const current = readContext(command);
    if (!current) {
      throw repositoryError(REPOSITORY_ERROR_CODES.recordNotFound, "The matchup lock context is missing.");
    }
    if (current.existingLocks.length > 0) {
      const existing = current.existingLocks[0];
      if (
        current.existingLocks.length === 1 &&
        existing.id === command.lockId &&
        existing.legal === 0 &&
        existing.legality_reason_code === command.reasonCode
      ) {
        return Object.freeze({ replayed: true, lock: existing, playerCount: 0 });
      }
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The team already has a matchup lock.");
    }
    if (
      current.week.version !== command.expectedWeekVersion ||
      current.week.status !== "live" ||
      JSON.stringify(current.activePlayers) !== command.activePlayerFingerprint
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The illegal-lock sources changed.");
    }
    insertIllegalLock.run(command);
    if (beforeCommit) beforeCommit();
    return Object.freeze({
      replayed: false,
      lock: Object.freeze({
        id: command.lockId,
        lock_type: "normal",
        legal: 0,
        legality_reason_code: command.reasonCode,
        baseline_snapshot_id: null,
      }),
      playerCount: 0,
    });
  });

  const lateEvidenceTransaction = database.transaction((command) => {
    assertCurrentOccurrenceExecution(command);
    const current = readContext({
      ...command,
      requireSealedPlayerGameEvidence: true,
    });
    if (!current || current.existingLocks.length !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        "The illegal matchup lock is missing."
      );
    }
    const existing = current.existingLocks[0];
    const observationEvidence =
      createNhlGameObservationSnapshotEvidence({
        observationSnapshotId: command.observationSnapshotId,
        provider: command.observationProvider,
        sourceVersion: command.observationSourceVersion,
        observedAtMs: command.observationObservedAtMs,
        freshnessStatus: "fresh",
        games: command.gameObservations.map((row) => ({
          nhlGameId: row.nhlGameId,
          nhlGameScheduledStartsAtMs:
            row.nhlGameScheduledStartsAtMs,
          observedGameState: row.observedGameState,
        })),
      });
    const exclusionEvidence =
      createMatchupLateLockExclusionSetEvidence({
        exclusionSetId: command.exclusionSetId,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        matchupWeekId: command.weekId,
        matchupId: command.matchupId,
        teamId: command.teamId,
        matchupRosterLockId: command.lockId,
        lateSnapshotAtMs: command.baselineAtMs,
        observationSnapshotId: command.observationSnapshotId,
        observationSha256: observationEvidence.observationSha256,
        exclusions: command.exclusions.map((row) => ({
          exclusionId: row.exclusionId,
          matchupRosterPlayerId: row.matchupRosterPlayerId,
          playerId: row.playerId,
          nhlGameId: row.nhlGameId,
          nhlGameScheduledStartsAtMs:
            row.nhlGameScheduledStartsAtMs,
          observedGameState: row.observedGameState,
          baselinePlayerGameStatObservationId:
            row.baselinePlayerGameStatObservationId,
        })),
      });
    const candidateBundle = candidateLateEvidenceBundle(
      command,
      current,
      observationEvidence,
      exclusionEvidence
    );
    verifySealedLateLockEvidence(candidateBundle);
    const sourcesMatch =
      existing.id === command.lockId &&
      current.week.status === "live" &&
      current.week.version === command.expectedWeekVersion &&
      current.week.matchup_id === command.matchupId &&
      current.refresh?.id === command.refreshId &&
      current.playerGameSet?.id ===
        command.expectedPlayerGameSetId &&
      current.playerGameSet?.coverage_sha256 ===
        command.expectedPlayerGameCoverageSha256 &&
      current.playerGameSet?.evidence_sha256 ===
        command.expectedPlayerGameEvidenceSha256 &&
      json(current.playerGameSet) ===
        command.playerGameRootFingerprint &&
      json(current.playerGameCoverage) ===
        command.playerGameCoverageFingerprint &&
      json(current.playerGameObservations) ===
        command.playerGameFingerprint &&
      json(current.activePlayers) ===
        command.activePlayerFingerprint;
    if (!sourcesMatch) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The evidence-aware late-lock sources changed."
      );
    }
    if (existing.legal === 1 && existing.lock_type === "late") {
      const committed = readCommittedLateEvidence(current, existing);
      const candidateSemantic = semanticLateEvidence(
        candidateBundle,
        rosterSemantics(command.players, false)
      );
      const committedSemantic = semanticLateEvidence(
        committed.bundle,
        rosterSemantics(committed.lockedPlayers, true)
      );
      if (json(candidateSemantic) !== json(committedSemantic)) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The late-lock replay is not semantically equivalent."
        );
      }
      return Object.freeze({
        replayed: true,
        lock: Object.freeze({ ...existing }),
        playerCount: committed.lockedPlayers.length,
        exclusionSet: committed.exclusionSet,
      });
    }
    if (
      existing.legal !== 0 ||
      existing.lock_type !== "normal" ||
      existing.version !== command.expectedLockVersion
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The illegal matchup lock changed."
      );
    }
    for (const row of command.gameObservations) {
      insertGameObservation.run({ ...command, ...row });
    }
    insertGameObservationSnapshot.run({
      ...command,
      observationCount: observationEvidence.observationCount,
      observationSha256: observationEvidence.observationSha256,
    });
    insertBaseline(command);
    const promoted = promoteLateLock.run(command);
    if (promoted.changes !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The evidence-aware late lock lost its compare-and-set race."
      );
    }
    for (const player of command.players) {
      insertLockPlayer.run({ ...command, ...player });
    }
    for (const row of command.exclusions) {
      insertGameExclusion.run({ ...command, ...row });
    }
    insertGameExclusionSet.run({
      ...command,
      matchupRosterLockVersion: existing.version + 1,
      exclusionCount: exclusionEvidence.exclusionCount,
      exclusionEvidenceSha256: exclusionEvidence.evidenceSha256,
    });
    if (beforeCommit) beforeCommit();
    const committedLock = exactlyOne(
      lockByScopeStatement.all(command),
      "The committed late matchup lock is missing."
    );
    const committed = readCommittedLateEvidence(
      current,
      committedLock
    );
    const committedSemantic = semanticLateEvidence(
      committed.bundle,
      rosterSemantics(committed.lockedPlayers, true)
    );
    const candidateSemantic = semanticLateEvidence(
      candidateBundle,
      rosterSemantics(command.players, false)
    );
    if (json(committedSemantic) !== json(candidateSemantic)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The committed late-lock evidence differs from its verified command."
      );
    }
    return Object.freeze({
      replayed: false,
      lock: Object.freeze({ ...committedLock }),
      playerCount: committed.lockedPlayers.length,
      exclusionSet: committed.exclusionSet,
    });
  });

  return Object.freeze({
    readContext,
    persistNormalLock(command) {
      try {
        return persistTransaction.immediate({ ...command, ...scope(command) });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "persistNormalMatchupLock", tableName: "matchup_roster_locks" });
      }
    },
    persistIllegalLock(command) {
      try {
        return illegalTransaction.immediate({ ...command, ...scope(command) });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "persistIllegalMatchupLock", tableName: "matchup_roster_locks" });
      }
    },
    persistLateLockWithEvidence(command) {
      try {
        return lateEvidenceTransaction.immediate({
          ...command,
          ...scope(command),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "persistLateMatchupLockWithEvidence",
          tableName: "matchup_roster_game_exclusion_sets",
        });
      }
    },
  });
}

module.exports = { createSqliteMatchupLockRepository };
