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

function createSqliteMatchupResultRepository({ database, beforeCommit } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupResultRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup-result beforeCommit must be a function");
  }
  const contextStatement = database.prepare(
    "SELECT matchups.*, matchup_weeks.status AS week_status, matchup_weeks.ends_at_ms, " +
      "matchup_weeks.version AS week_version, leagues.commissioner_membership_id, " +
      "league_memberships.user_id AS commissioner_user_id " +
      "FROM matchups JOIN matchup_weeks ON matchup_weeks.league_id = matchups.league_id " +
      "AND matchup_weeks.id = matchups.matchup_week_id " +
      "JOIN leagues ON leagues.id = matchups.league_id " +
      "LEFT JOIN league_memberships ON league_memberships.id = leagues.commissioner_membership_id " +
      "AND league_memberships.league_id = leagues.id AND league_memberships.status = 'active' " +
      "WHERE matchups.league_id = @leagueId AND matchups.season_id = @seasonId " +
      "AND matchups.matchup_week_id = @weekId AND matchups.id = @matchupId LIMIT 2"
  );
  const resultStatement = database.prepare(
    "SELECT * FROM matchup_results WHERE league_id = @leagueId AND matchup_id = @matchupId LIMIT 2"
  );
  const versionsStatement = database.prepare(
    "SELECT * FROM matchup_result_versions WHERE league_id = @leagueId " +
      "AND matchup_result_id = @resultId ORDER BY version_number"
  );
  const operationStatement = database.prepare(
    "SELECT * FROM matchup_operations WHERE id = @operationId LIMIT 2"
  );
  const refreshStatement = database.prepare(
    "SELECT * FROM stat_refreshes WHERE id = @refreshId AND status = 'succeeded' LIMIT 2"
  );
  const insertSnapshot = database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, " +
      "matchup_week_id, intended_use, completeness_status, freshness_status, captured_at_ms, " +
      "committed, created_at_ms) VALUES (@snapshotId, @statSourceId, @refreshId, @leagueId, " +
      "@seasonId, @weekId, 'matchup_final', 'complete', 'fresh', @nowMs, 1, @nowMs)"
  );
  const insertResult = database.prepare(
    "INSERT INTO matchup_results (id, league_id, season_id, matchup_id, current_version_id, status, " +
      "finalized_at_ms, created_at_ms, updated_at_ms, version) VALUES (@resultId, @leagueId, " +
      "@seasonId, @matchupId, NULL, 'pending', NULL, @nowMs, @nowMs, 1)"
  );
  const insertVersion = database.prepare(
    "INSERT INTO matchup_result_versions (id, league_id, season_id, matchup_result_id, version_number, " +
      "home_team_id, away_team_id, home_score_hundredths, away_score_hundredths, outcome, " +
      "source_snapshot_id, source_type, actor_user_id, reason, supersedes_version_id, created_at_ms) " +
      "VALUES (@resultVersionId, @leagueId, @seasonId, @resultId, @versionNumber, @homeTeamId, " +
      "@awayTeamId, @homeScoreHundredths, @awayScoreHundredths, @outcome, @snapshotId, " +
      "@sourceType, @actorUserId, @reason, @supersedesVersionId, @nowMs)"
  );
  const finalizeResult = database.prepare(
    "UPDATE matchup_results SET current_version_id = @resultVersionId, status = 'official', " +
      "finalized_at_ms = @nowMs, updated_at_ms = @nowMs WHERE id = @resultId " +
      "AND league_id = @leagueId AND status = 'pending' AND version = 1"
  );
  const correctResult = database.prepare(
    "UPDATE matchup_results SET current_version_id = @resultVersionId, status = 'corrected', " +
      "updated_at_ms = @nowMs, version = version + 1 WHERE id = @resultId " +
      "AND league_id = @leagueId AND current_version_id = @supersedesVersionId " +
      "AND version = @expectedResultVersion"
  );
  const finalizeMatchup = database.prepare(
    "UPDATE matchups SET status = 'final', updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @matchupId AND league_id = @leagueId AND season_id = @seasonId " +
      "AND status IN ('awaiting_data', 'correction_required')"
  );
  const remainingMatchups = database.prepare(
    "SELECT COUNT(*) AS count FROM matchups WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND matchup_week_id = @weekId AND status NOT IN ('final', 'cancelled')"
  );
  const finalizeWeek = database.prepare(
    "UPDATE matchup_weeks SET status = 'final', updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @weekId AND league_id = @leagueId AND season_id = @seasonId " +
      "AND status IN ('awaiting_data', 'correction_required')"
  );
  const insertOperation = database.prepare(
    "INSERT INTO matchup_operations (id, league_id, season_id, matchup_week_id, matchup_id, " +
      "actor_user_id, operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms) " +
      "VALUES (@operationId, @leagueId, @seasonId, @weekId, @matchupId, @actorUserId, " +
      "@operationType, 'succeeded', @reason, @metadataJson, @nowMs, @nowMs)"
  );

  function keys(input) {
    return {
      leagueId: stableId(input.leagueId),
      seasonId: stableId(input.seasonId),
      weekId: stableId(input.weekId),
      matchupId: stableId(input.matchupId),
    };
  }

  function readContext(input) {
    try {
      const scope = keys(input);
      const rows = contextStatement.all(scope);
      if (rows.length > 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The matchup result context is ambiguous.");
      }
      if (rows.length === 0) return null;
      const resultRows = resultStatement.all(scope);
      if (resultRows.length > 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The matchup result is ambiguous.");
      }
      const result = resultRows[0] || null;
      return Object.freeze({
        matchup: Object.freeze({ ...rows[0] }),
        result: result ? Object.freeze({ ...result }) : null,
        versions: result
          ? Object.freeze(versionsStatement.all({ leagueId: scope.leagueId, resultId: result.id }).map((row) => Object.freeze({ ...row })))
          : Object.freeze([]),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readMatchupResultContext", tableName: "matchup_results" });
    }
  }

  function readOperation(input) {
    try {
      const operationId = stableId(input.operationId);
      const rows = operationStatement.all({ operationId });
      if (rows.length > 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The matchup operation is ambiguous.");
      }
      if (rows.length === 0) return null;
      const operation = rows[0];
      const scope = keys(input);
      if (
        operation.league_id !== scope.leagueId ||
        operation.season_id !== scope.seasonId ||
        operation.matchup_week_id !== scope.weekId ||
        operation.matchup_id !== scope.matchupId ||
        (input.expectedOperationType && operation.operation_type !== input.expectedOperationType)
      ) {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The operation ID is already in use.");
      }
      return Object.freeze({ ...operation });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readMatchupResultOperation", tableName: "matchup_operations" });
    }
  }

  const finalizeTransaction = database.transaction((command) => {
    const context = readContext(command);
    if (
      !context || context.result || context.matchup.status !== "awaiting_data" ||
      context.matchup.week_status !== "awaiting_data" || context.matchup.version !== command.expectedMatchupVersion
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The matchup cannot be finalized.");
    }
    const refreshRows = refreshStatement.all({ refreshId: stableId(command.refreshId) });
    if (
      refreshRows.length !== 1 ||
      refreshRows[0].completed_at_ms < context.matchup.ends_at_ms ||
      refreshRows[0].completed_at_ms > command.nowMs
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The final statistics changed.");
    }
    insertSnapshot.run({ ...command, statSourceId: refreshRows[0].stat_source_id });
    insertResult.run(command);
    insertVersion.run({
      ...command,
      versionNumber: 1,
      sourceType: "calculated",
      actorUserId: null,
      reason: null,
      supersedesVersionId: null,
    });
    if (finalizeResult.run(command).changes !== 1 || finalizeMatchup.run(command).changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The final result lost its compare-and-set race.");
    }
    if (remainingMatchups.get(command).count === 0) finalizeWeek.run(command);
    insertOperation.run({
      ...command,
      actorUserId: null,
      operationType: "result_finalize",
      reason: null,
      metadataJson: JSON.stringify({ resultId: command.resultId, resultVersionId: command.resultVersionId }),
    });
    if (beforeCommit) beforeCommit();
    return readContext(command);
  });

  const correctionTransaction = database.transaction((command) => {
    const context = readContext(command);
    if (
      !context || !context.result ||
      (
        context.matchup.commissioner_user_id !== command.actorUserId &&
        command.authorizedAsPlatformAdministrator !== true
      ) ||
      context.result.version !== command.expectedResultVersion ||
      context.result.current_version_id !== command.supersedesVersionId ||
      context.versions.at(-1)?.id !== command.supersedesVersionId
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The result correction context changed.");
    }
    insertVersion.run(command);
    if (correctResult.run(command).changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The correction lost its compare-and-set race.");
    }
    finalizeMatchup.run(command);
    if (remainingMatchups.get(command).count === 0) finalizeWeek.run(command);
    insertOperation.run({
      ...command,
      operationType: "result_correct",
      metadataJson: JSON.stringify({ resultId: command.resultId, resultVersionId: command.resultVersionId }),
    });
    if (beforeCommit) beforeCommit();
    return readContext(command);
  });

  return Object.freeze({
    readContext,
    readOperation,
    finalize(command) {
      try {
        return finalizeTransaction.immediate({ ...command, ...keys(command) });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "finalizeMatchupResult", tableName: "matchup_results" });
      }
    },
    correct(command) {
      try {
        return correctionTransaction.immediate({ ...command, ...keys(command) });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "correctMatchupResult", tableName: "matchup_result_versions" });
      }
    },
  });
}

module.exports = { createSqliteMatchupResultRepository };
