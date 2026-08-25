const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function frozenWeek(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteMatchupWeekRepository({
  database,
  beforeCommit,
  occurrenceExecutionGuard,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupWeekRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup-week beforeCommit must be a function");
  }
  if (
    occurrenceExecutionGuard !== undefined &&
    (
      !occurrenceExecutionGuard ||
      typeof occurrenceExecutionGuard.assertCurrent !== "function"
    )
  ) {
    throw new TypeError(
      "matchup-week occurrenceExecutionGuard must assert current execution"
    );
  }

  const readWeekStatement = database.prepare(
    "SELECT * FROM matchup_weeks WHERE league_id = @leagueId " +
      "AND season_id = @seasonId AND id = @weekId LIMIT 2"
  );
  const readOperationStatement = database.prepare(
    "SELECT * FROM matchup_operations WHERE id = @operationId LIMIT 2"
  );
  const updateWeekStatement = database.prepare(
    "UPDATE matchup_weeks SET status = @toStatus, updated_at_ms = @nowMs, " +
      "version = version + 1 WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND id = @weekId AND status = @fromStatus AND version = @expectedVersion"
  );
  const updateMatchupsStatement = database.prepare(
    "UPDATE matchups SET status = @matchupStatus, updated_at_ms = @nowMs, " +
      "version = version + 1 WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND matchup_week_id = @weekId AND status = @expectedMatchupStatus"
  );
  const insertOperationStatement = database.prepare(
    "INSERT INTO matchup_operations " +
      "(id, league_id, season_id, matchup_week_id, matchup_id, actor_user_id, " +
      "operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms) " +
      "VALUES (@operationId, @leagueId, @seasonId, @weekId, NULL, NULL, " +
      "'week_transition', 'succeeded', NULL, @metadataJson, @nowMs, @nowMs)"
  );

  function scope(input) {
    return {
      leagueId: stableId(input.leagueId),
      seasonId: stableId(input.seasonId),
      weekId: stableId(input.weekId),
    };
  }

  function readWeek(input) {
    try {
      const rows = readWeekStatement.all(scope(input));
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The matchup-week scope is ambiguous."
        );
      }
      return frozenWeek(rows[0]);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readMatchupWeek",
        tableName: "matchup_weeks",
      });
    }
  }

  function readTransitionOperation(input) {
    try {
      const operationId = stableId(input.operationId);
      const rows = readOperationStatement.all({ operationId });
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The matchup operation is ambiguous."
        );
      }
      if (rows.length === 0) return null;
      const operation = rows[0];
      const expected = scope(input);
      if (
        operation.league_id !== expected.leagueId ||
        operation.season_id !== expected.seasonId ||
        operation.matchup_week_id !== expected.weekId ||
        operation.operation_type !== "week_transition"
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The matchup operation identifier is already in use."
        );
      }
      return Object.freeze({ ...operation });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readMatchupWeekTransitionOperation",
        tableName: "matchup_operations",
      });
    }
  }

  const transitionTransaction = database.transaction((command) => {
    if (command.occurrenceExecution !== undefined) {
      if (!occurrenceExecutionGuard) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A matchup occurrence execution guard is required."
        );
      }
      occurrenceExecutionGuard.assertCurrent(command.occurrenceExecution);
    }
    const operationRows = readOperationStatement.all({
      operationId: stableId(command.operationId),
    });
    if (operationRows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The matchup operation is ambiguous."
      );
    }
    if (operationRows.length === 1) {
      const operation = operationRows[0];
      if (
        operation.league_id !== command.leagueId ||
        operation.season_id !== command.seasonId ||
        operation.matchup_week_id !== command.weekId ||
        operation.operation_type !== "week_transition"
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The matchup operation identifier is already in use."
        );
      }
      return Object.freeze({
        replayed: true,
        operationId: operation.id,
        week: readWeek(command),
      });
    }
    if (
      command.occurrenceExecution !== undefined &&
      (
        command.expectedVersion === undefined ||
        command.fromStatus === undefined ||
        command.toStatus === undefined ||
        command.matchupStatus === undefined ||
        command.effectiveAtMs === undefined ||
        command.nowMs === undefined
      )
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The guarded matchup-week replay is no longer present."
      );
    }

    const week = readWeek(command);
    if (!week) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        "The matchup week was not found."
      );
    }
    if (week.version !== command.expectedVersion || week.status !== command.fromStatus) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The matchup week changed before the transition."
      );
    }
    const result = updateWeekStatement.run(command);
    if (result.changes !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The matchup-week transition lost its compare-and-set race."
      );
    }
    let matchupChanges = 0;
    if (command.matchupStatus !== null) {
      matchupChanges = updateMatchupsStatement.run({
        ...command,
        expectedMatchupStatus: command.fromStatus === "baseline_ready" ? "scheduled" : "live",
      }).changes;
    }
    insertOperationStatement.run({
      ...command,
      metadataJson: JSON.stringify({
        fromStatus: command.fromStatus,
        toStatus: command.toStatus,
        effectiveAtMs: command.effectiveAtMs,
        expectedVersion: command.expectedVersion,
        matchupChanges,
      }),
    });
    if (beforeCommit) beforeCommit();
    return Object.freeze({
      replayed: false,
      operationId: command.operationId,
      matchupChanges,
      week: readWeek(command),
    });
  });

  return Object.freeze({
    readWeek,
    readTransitionOperation,
    transitionWeek(command) {
      try {
        const validated = { ...command, ...scope(command) };
        return transitionTransaction.immediate(validated);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "transitionMatchupWeek",
          tableName: "matchup_weeks",
        });
      }
    },
  });
}

module.exports = { createSqliteMatchupWeekRepository };
