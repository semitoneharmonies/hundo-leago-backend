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

function createSqliteMatchupRecoveryRepository({ database, beforeCommit } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupRecoveryRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup recovery beforeCommit must be a function");
  }
  const matchupContext = database.prepare(
    "SELECT matchups.*, matchup_weeks.status AS week_status, matchup_weeks.version AS week_version, " +
      "league_memberships.user_id AS commissioner_user_id FROM matchups " +
      "JOIN matchup_weeks ON matchup_weeks.league_id = matchups.league_id " +
      "AND matchup_weeks.id = matchups.matchup_week_id " +
      "JOIN leagues ON leagues.id = matchups.league_id " +
      "LEFT JOIN league_memberships ON league_memberships.id = leagues.commissioner_membership_id " +
      "AND league_memberships.league_id = leagues.id AND league_memberships.status = 'active' " +
      "WHERE matchups.league_id = @leagueId AND matchups.season_id = @seasonId " +
      "AND matchups.matchup_week_id = @weekId AND matchups.id = @matchupId LIMIT 2"
  );
  const seasonContext = database.prepare(
    "SELECT seasons.id AS season_id, league_memberships.user_id AS commissioner_user_id " +
      "FROM seasons JOIN leagues ON leagues.id = seasons.league_id " +
      "LEFT JOIN league_memberships ON league_memberships.id = leagues.commissioner_membership_id " +
      "AND league_memberships.league_id = leagues.id AND league_memberships.status = 'active' " +
      "WHERE seasons.league_id = @leagueId AND seasons.id = @seasonId LIMIT 2"
  );
  const currentSnapshot = database.prepare(
    "SELECT * FROM standings_snapshots WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND status = 'current' LIMIT 2"
  );
  const maximumSnapshotVersion = database.prepare(
    "SELECT COALESCE(MAX(snapshot_version), 0) AS version FROM standings_snapshots " +
      "WHERE league_id = @leagueId AND season_id = @seasonId"
  );
  const matchupOperation = database.prepare(
    "SELECT * FROM matchup_operations WHERE id = @operationId LIMIT 2"
  );
  const standingsOperation = database.prepare(
    "SELECT * FROM standings_operations WHERE id = @operationId LIMIT 2"
  );
  const routeMatchup = database.prepare(
    "UPDATE matchups SET status = 'correction_required', updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @matchupId AND league_id = @leagueId AND season_id = @seasonId " +
      "AND version = @expectedVersion AND status IN ('awaiting_data', 'final')"
  );
  const routeWeek = database.prepare(
    "UPDATE matchup_weeks SET status = 'correction_required', updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @weekId AND league_id = @leagueId AND season_id = @seasonId " +
      "AND version = @expectedWeekVersion AND status IN ('awaiting_data', 'final')"
  );
  const insertMatchupOperation = database.prepare(
    "INSERT INTO matchup_operations (id, league_id, season_id, matchup_week_id, matchup_id, actor_user_id, " +
      "operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms) " +
      "VALUES (@operationId, @leagueId, @seasonId, @weekId, @matchupId, @actorUserId, " +
      "'matchup_recovery_route', 'succeeded', @reason, @metadataJson, @nowMs, @nowMs)"
  );
  const supersedeSnapshot = database.prepare(
    "UPDATE standings_snapshots SET status = 'superseded' WHERE id = @currentSnapshotId " +
      "AND league_id = @leagueId AND season_id = @seasonId AND status = 'current'"
  );
  const insertSnapshot = database.prepare(
    "INSERT INTO standings_snapshots (id, league_id, season_id, snapshot_version, source_result_version, " +
      "status, calculated_at_ms, created_at_ms) VALUES (@snapshotId, @leagueId, @seasonId, " +
      "@snapshotVersion, @sourceResultVersion, 'current', @nowMs, @nowMs)"
  );
  const insertRow = database.prepare(
    "INSERT INTO standings_rows (id, league_id, season_id, standings_snapshot_id, team_id, rank, wins, losses, " +
      "ties, standings_points, fantasy_points_for_hundredths, fantasy_points_against_hundredths, " +
      "fantasy_point_differential_hundredths, created_at_ms) VALUES (@rowId, @leagueId, @seasonId, " +
      "@snapshotId, @teamId, @rank, @wins, @losses, @ties, @standingsPoints, " +
      "@fantasyPointsForHundredths, @fantasyPointsAgainstHundredths, " +
      "@fantasyPointsDifferentialHundredths, @nowMs)"
  );
  const insertStandingsOperation = database.prepare(
    "INSERT INTO standings_operations (id, league_id, season_id, standings_snapshot_id, actor_user_id, " +
      "operation_type, status, reason, started_at_ms, completed_at_ms) VALUES (@operationId, @leagueId, " +
      "@seasonId, @snapshotId, @actorUserId, 'rebuild', 'succeeded', @reason, @nowMs, @nowMs)"
  );

  function matchupKeys(input) {
    return {
      leagueId: stableId(input.leagueId), seasonId: stableId(input.seasonId),
      weekId: stableId(input.weekId), matchupId: stableId(input.matchupId),
    };
  }
  function seasonKeys(input) {
    return { leagueId: stableId(input.leagueId), seasonId: stableId(input.seasonId) };
  }
  function one(rows, message) {
    if (rows.length > 1) throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, message);
    return rows[0] ? Object.freeze({ ...rows[0] }) : null;
  }
  function readMatchupContext(input) {
    try {
      return one(matchupContext.all(matchupKeys(input)), "The matchup recovery context is ambiguous.");
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readMatchupRecoveryContext", tableName: "matchups" });
    }
  }
  function readStandingsContext(input) {
    try {
      const scope = seasonKeys(input);
      const season = one(seasonContext.all(scope), "The standings recovery context is ambiguous.");
      if (!season) return null;
      const current = one(currentSnapshot.all(scope), "The current standings snapshot is ambiguous.");
      return Object.freeze({ season, currentSnapshot: current, maximumSnapshotVersion: maximumSnapshotVersion.get(scope).version });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readStandingsRecoveryContext", tableName: "standings_snapshots" });
    }
  }
  function readRecoveryOperation(statement, input, type) {
    const operationId = stableId(input.operationId);
    const rows = statement.all({ operationId });
    if (rows.length > 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The recovery operation is ambiguous.");
    }
    if (rows.length === 0) return null;
    const row = rows[0];
    if (
      row.league_id !== input.leagueId || row.season_id !== input.seasonId ||
      row.actor_user_id !== input.actorUserId || row.operation_type !== type
    ) throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The recovery operation ID is already used.");
    return Object.freeze({ ...row });
  }

  const routeTransaction = database.transaction((command) => {
    const prior = matchupOperation.get({ operationId: command.operationId });
    if (prior) {
      if (prior.league_id !== command.leagueId || prior.matchup_id !== command.matchupId || prior.actor_user_id !== command.actorUserId || prior.operation_type !== "matchup_recovery_route") {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The recovery operation ID is already used.");
      }
      return Object.freeze({ replayed: true, matchup: readMatchupContext(command) });
    }
    const context = readMatchupContext(command);
    if (
      !context ||
      (
        context.commissioner_user_id !== command.actorUserId &&
        command.authorizedAsPlatformAdministrator !== true
      ) ||
      context.version !== command.expectedVersion || context.week_version !== command.expectedWeekVersion
    ) throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The matchup recovery context changed.");
    if (routeMatchup.run(command).changes !== 1 || routeWeek.run(command).changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The recovery transition lost its race.");
    }
    insertMatchupOperation.run({ ...command, metadataJson: JSON.stringify({ fromStatus: context.status, fromWeekStatus: context.week_status }) });
    if (beforeCommit) beforeCommit("matchup");
    return Object.freeze({ replayed: false, matchup: readMatchupContext(command) });
  });

  const rebuildTransaction = database.transaction((command) => {
    const prior = standingsOperation.get({ operationId: command.operationId });
    if (prior) {
      if (prior.league_id !== command.leagueId || prior.season_id !== command.seasonId || prior.actor_user_id !== command.actorUserId || prior.operation_type !== "rebuild") {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The standings operation ID is already used.");
      }
      return Object.freeze({ replayed: true, context: readStandingsContext(command) });
    }
    const context = readStandingsContext(command);
    const currentId = context?.currentSnapshot?.id || null;
    if (
      !context ||
      (
        context.season.commissioner_user_id !== command.actorUserId &&
        command.authorizedAsPlatformAdministrator !== true
      ) ||
      currentId !== command.expectedCurrentSnapshotId
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The standings recovery context changed.");
    }
    if (currentId && supersedeSnapshot.run({ ...command, currentSnapshotId: currentId }).changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The current standings snapshot changed.");
    }
    insertSnapshot.run({ ...command, snapshotVersion: context.maximumSnapshotVersion + 1 });
    for (const row of command.rows) insertRow.run({ ...command, ...row });
    insertStandingsOperation.run(command);
    if (beforeCommit) beforeCommit("standings");
    return Object.freeze({ replayed: false, context: readStandingsContext(command) });
  });

  return Object.freeze({
    readMatchupContext,
    readStandingsContext,
    readMatchupOperation(input) {
      try { return readRecoveryOperation(matchupOperation, { ...input, ...matchupKeys(input) }, "matchup_recovery_route"); }
      catch (error) { throw mapRepositoryError(error, { operation: "readMatchupRecoveryOperation", tableName: "matchup_operations" }); }
    },
    readStandingsOperation(input) {
      try { return readRecoveryOperation(standingsOperation, { ...input, ...seasonKeys(input) }, "rebuild"); }
      catch (error) { throw mapRepositoryError(error, { operation: "readStandingsRecoveryOperation", tableName: "standings_operations" }); }
    },
    routeMatchup(command) {
      try { return routeTransaction.immediate({ ...command, ...matchupKeys(command), operationId: stableId(command.operationId) }); }
      catch (error) { throw mapRepositoryError(error, { operation: "routeMatchupRecovery", tableName: "matchups" }); }
    },
    rebuildStandings(command) {
      try { return rebuildTransaction.immediate({ ...command, ...seasonKeys(command), operationId: stableId(command.operationId) }); }
      catch (error) { throw mapRepositoryError(error, { operation: "rebuildStandings", tableName: "standings_snapshots" }); }
    },
  });
}

module.exports = { createSqliteMatchupRecoveryRepository };
