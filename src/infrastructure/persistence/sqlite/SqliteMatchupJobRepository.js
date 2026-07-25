const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  M6_JOB_TYPES,
} = require("../../../domain/matchups/matchupJobPolicy");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A stable identifier is required.");
  }
  return value;
}

function bounded(value, maximum = 512) {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A bounded canonical value is required.");
  }
  return value;
}

function freeze(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteMatchupJobRepository({ database, beforeCommit } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupJobRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup-job beforeCommit must be a function");
  }
  const byOccurrence = database.prepare(
    "SELECT * FROM job_runs WHERE league_id = @leagueId AND job_type = @jobType " +
      "AND occurrence_key = @occurrenceKey LIMIT 2"
  );
  const byId = database.prepare(
    "SELECT * FROM job_runs WHERE league_id = @leagueId AND id = @runId LIMIT 2"
  );
  const insert = database.prepare(
    "INSERT INTO job_runs (id, league_id, season_id, job_type, occurrence_key, scheduled_for_ms, " +
      "status, attempt_count, lease_owner, lease_expires_at_ms, started_at_ms, completed_at_ms, " +
      "result_json, last_error_code, created_at_ms, updated_at_ms, version, lease_token, next_attempt_at_ms) " +
      "VALUES (@runId, @leagueId, @seasonId, @jobType, @occurrenceKey, @scheduledForMs, 'pending', " +
      "0, NULL, NULL, NULL, NULL, NULL, NULL, @nowMs, @nowMs, 1, NULL, @scheduledForMs)"
  );
  const due = database.prepare(
    "SELECT * FROM job_runs WHERE job_type IN (" + M6_JOB_TYPES.map(() => "?").join(", ") + ") " +
      "AND ((status IN ('pending', 'failed') AND COALESCE(next_attempt_at_ms, scheduled_for_ms) <= ?) " +
      "OR (status IN ('leased', 'running') AND lease_expires_at_ms <= ?)) " +
      "ORDER BY COALESCE(next_attempt_at_ms, scheduled_for_ms), scheduled_for_ms, id LIMIT ?"
  );
  const claim = database.prepare(
    "UPDATE job_runs SET status = 'running', attempt_count = attempt_count + 1, " +
      "lease_owner = @leaseOwner, lease_token = @leaseToken, lease_expires_at_ms = @leaseExpiresAtMs, " +
      "started_at_ms = @nowMs, completed_at_ms = NULL, result_json = NULL, last_error_code = NULL, " +
      "next_attempt_at_ms = NULL, updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @runId AND league_id = @leagueId AND version = @expectedVersion"
  );
  const renew = database.prepare(
    "UPDATE job_runs SET lease_expires_at_ms = @leaseExpiresAtMs, updated_at_ms = @nowMs, " +
      "version = version + 1 WHERE id = @runId AND league_id = @leagueId AND status = 'running' " +
      "AND lease_owner = @leaseOwner AND lease_token = @leaseToken AND version = @expectedVersion"
  );
  const succeed = database.prepare(
    "UPDATE job_runs SET status = 'succeeded', lease_owner = NULL, lease_token = NULL, " +
      "lease_expires_at_ms = NULL, completed_at_ms = @completedAtMs, result_json = @resultJson, " +
      "last_error_code = NULL, next_attempt_at_ms = NULL, updated_at_ms = @completedAtMs, " +
      "version = version + 1 WHERE id = @runId AND league_id = @leagueId AND status = 'running' " +
      "AND lease_owner = @leaseOwner AND lease_token = @leaseToken AND version = @expectedVersion"
  );
  const fail = database.prepare(
    "UPDATE job_runs SET status = 'failed', lease_owner = NULL, lease_token = NULL, " +
      "lease_expires_at_ms = NULL, completed_at_ms = @completedAtMs, result_json = NULL, " +
      "last_error_code = @errorCode, next_attempt_at_ms = @nextAttemptAtMs, " +
      "updated_at_ms = @completedAtMs, version = version + 1 " +
      "WHERE id = @runId AND league_id = @leagueId AND status = 'running' " +
      "AND lease_owner = @leaseOwner AND lease_token = @leaseToken AND version = @expectedVersion"
  );

  function occurrenceScope(input) {
    if (!M6_JOB_TYPES.includes(input.jobType)) {
      throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "An approved M6 job type is required.");
    }
    return {
      leagueId: stableId(input.leagueId),
      seasonId: stableId(input.seasonId),
      jobType: input.jobType,
      occurrenceKey: bounded(input.occurrenceKey),
    };
  }

  const scheduleTransaction = database.transaction((command) => {
    const rows = byOccurrence.all(command);
    if (rows.length > 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The scheduled occurrence is ambiguous.");
    }
    if (rows.length === 1) {
      const row = rows[0];
      if (
        row.id !== command.runId || row.season_id !== command.seasonId ||
        row.scheduled_for_ms !== command.scheduledForMs
      ) {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The occurrence key has conflicting evidence.");
      }
      return Object.freeze({ replayed: true, occurrence: freeze(row) });
    }
    insert.run(command);
    if (beforeCommit) beforeCommit("schedule");
    return Object.freeze({ replayed: false, occurrence: freeze(byOccurrence.get(command)) });
  });

  const claimTransaction = database.transaction((command) => {
    const rows = byOccurrence.all(command);
    if (rows.length !== 1) return Object.freeze({ acquired: false, occurrence: null });
    const row = rows[0];
    const retryAtMs = row.next_attempt_at_ms ?? row.scheduled_for_ms;
    const eligible =
      (["pending", "failed"].includes(row.status) && retryAtMs <= command.nowMs) ||
      (["leased", "running"].includes(row.status) && row.lease_expires_at_ms <= command.nowMs);
    if (!eligible) return Object.freeze({ acquired: false, occurrence: freeze(row) });
    if (claim.run({ ...command, runId: row.id, expectedVersion: row.version }).changes !== 1) {
      return Object.freeze({ acquired: false, occurrence: freeze(byOccurrence.get(command)) });
    }
    if (beforeCommit) beforeCommit("claim");
    return Object.freeze({ acquired: true, occurrence: freeze(byOccurrence.get(command)) });
  });

  function guardedMutation(statement, command, operation) {
    return database.transaction((input) => {
      if (statement.run(input).changes !== 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The job lease token or version changed.");
      }
      if (beforeCommit) beforeCommit(operation);
      return freeze(byId.get({ leagueId: input.leagueId, runId: input.runId }));
    }).immediate(command);
  }

  return Object.freeze({
    schedule(command) {
      try {
        return scheduleTransaction.immediate({
          ...command,
          ...occurrenceScope(command),
          runId: stableId(command.runId),
        });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "scheduleMatchupJob", tableName: "job_runs" });
      }
    },
    listDue({ nowMs, limit = 25 }) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A safe due query is required.");
      }
      return Object.freeze(due.all(...M6_JOB_TYPES, nowMs, nowMs, limit).map(freeze));
    },
    claim(command) {
      try {
        return claimTransaction.immediate({
          ...command,
          ...occurrenceScope(command),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
        });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "claimMatchupJob", tableName: "job_runs" });
      }
    },
    renew(command) {
      try {
        return guardedMutation(renew, {
          ...command,
          leagueId: stableId(command.leagueId),
          runId: stableId(command.runId),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
        }, "renew");
      } catch (error) {
        throw mapRepositoryError(error, { operation: "renewMatchupJob", tableName: "job_runs" });
      }
    },
    succeed(command) {
      try {
        return guardedMutation(succeed, {
          ...command,
          leagueId: stableId(command.leagueId),
          runId: stableId(command.runId),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
          resultJson: JSON.stringify(command.result ?? null),
        }, "succeed");
      } catch (error) {
        throw mapRepositoryError(error, { operation: "succeedMatchupJob", tableName: "job_runs" });
      }
    },
    fail(command) {
      try {
        return guardedMutation(fail, {
          ...command,
          leagueId: stableId(command.leagueId),
          runId: stableId(command.runId),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
          errorCode: bounded(command.errorCode, 100),
        }, "fail");
      } catch (error) {
        throw mapRepositoryError(error, { operation: "failMatchupJob", tableName: "job_runs" });
      }
    },
  });
}

module.exports = { createSqliteMatchupJobRepository };
