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

function createSqliteMatchupLockRepository({ database, beforeCommit } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupLockRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup-lock beforeCommit must be a function");
  }

  const weekStatement = database.prepare(
    "SELECT matchup_weeks.*, seasons.nhl_season_key FROM matchup_weeks " +
      "JOIN seasons ON seasons.league_id = matchup_weeks.league_id " +
      "AND seasons.id = matchup_weeks.season_id " +
      "WHERE matchup_weeks.league_id = @leagueId AND matchup_weeks.season_id = @seasonId " +
      "AND matchup_weeks.id = @weekId AND EXISTS (SELECT 1 FROM matchups " +
      "WHERE matchups.league_id = matchup_weeks.league_id " +
      "AND matchups.matchup_week_id = matchup_weeks.id " +
      "AND @teamId IN (matchups.home_team_id, matchups.away_team_id)) LIMIT 2"
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
  const totalsStatement = database.prepare(
    "SELECT player_id, games_played, goals, assists, fantasy_points_hundredths " +
      "FROM player_stat_totals WHERE refresh_id = @refreshId ORDER BY player_id"
  );
  const lockByScopeStatement = database.prepare(
    "SELECT * FROM matchup_roster_locks WHERE league_id = @leagueId " +
      "AND matchup_week_id = @weekId AND team_id = @teamId LIMIT 2"
  );
  const lockPlayerCountStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM matchup_roster_players WHERE league_id = @leagueId " +
      "AND matchup_roster_lock_id = @lockId"
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

  function scope(input) {
    return {
      leagueId: stableId(input.leagueId),
      seasonId: stableId(input.seasonId),
      weekId: stableId(input.weekId),
      teamId: stableId(input.teamId),
    };
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
      const refresh = refreshStatement.get({
        provider: input.provider,
        nhlSeasonKey: week.nhl_season_key,
        baselineAtMs: refreshCutoffAtMs,
      }) || null;
      return Object.freeze({
        week: Object.freeze({ ...week }),
        activePlayers: freezeRows(playersStatement.all(keys)),
        refresh: refresh ? Object.freeze({ ...refresh }) : null,
        totals: refresh ? freezeRows(totalsStatement.all({ refreshId: refresh.id })) : Object.freeze([]),
        existingLocks: freezeRows(lockByScopeStatement.all(keys)),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readMatchupLockContext", tableName: "matchup_roster_locks" });
    }
  }

  const persistTransaction = database.transaction((command) => {
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

  const lateTransaction = database.transaction((command) => {
    const current = readContext(command);
    if (!current || current.existingLocks.length !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.recordNotFound, "The illegal matchup lock is missing.");
    }
    const existing = current.existingLocks[0];
    if (existing.id === command.lockId && existing.legal === 1 && existing.lock_type === "late") {
      return Object.freeze({
        replayed: true,
        lock: existing,
        playerCount: lockPlayerCountStatement.get({
          leagueId: command.leagueId,
          lockId: command.lockId,
        }).count,
      });
    }
    if (
      existing.id !== command.lockId ||
      existing.legal !== 0 ||
      existing.lock_type !== "normal" ||
      existing.version !== command.expectedLockVersion ||
      current.week.status !== "live" ||
      current.week.version !== command.expectedWeekVersion ||
      current.refresh?.id !== command.refreshId ||
      JSON.stringify(current.activePlayers) !== command.activePlayerFingerprint
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The late-lock sources changed.");
    }
    insertBaseline(command);
    const promoted = promoteLateLock.run(command);
    if (promoted.changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The late lock lost its compare-and-set race.");
    }
    for (const player of command.players) insertLockPlayer.run({ ...command, ...player });
    if (beforeCommit) beforeCommit();
    return Object.freeze({
      replayed: false,
      lock: Object.freeze({
        ...existing,
        lock_type: "late",
        legal: 1,
        legality_reason_code: null,
        locked_at_ms: command.baselineAtMs,
        baseline_snapshot_id: command.snapshotId,
        source_freshness_status: "fresh",
        version: existing.version + 1,
      }),
      playerCount: command.players.length,
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
    persistLateLock(command) {
      try {
        return lateTransaction.immediate({ ...command, ...scope(command) });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "persistLateMatchupLock", tableName: "matchup_roster_locks" });
      }
    },
  });
}

module.exports = { createSqliteMatchupLockRepository };
