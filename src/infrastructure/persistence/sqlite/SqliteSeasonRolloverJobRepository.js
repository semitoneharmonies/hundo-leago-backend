const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
} = require(
  "../../../domain/leagues/seasonRolloverJobPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stableId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      `A canonical ${description} is required.`
    );
  }
  return value;
}

function boundedText(
  value,
  maximum,
  description
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(
      value
    )
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      `A bounded ${description} is required.`
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      `A safe ${description} is required.`
    );
  }
  return value;
}

function positiveInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      `A positive ${description} is required.`
    );
  }
  return value;
}

function frozen(value) {
  return Object.freeze({ ...value });
}

function createSqliteSeasonRolloverJobRepository({
  database,
  beforeCommit,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "createSqliteSeasonRolloverJobRepository requires a database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "season-rollover-job beforeCommit must be a function"
    );
  }

  const dueStatement = database.prepare(`
    SELECT
      occurrence.id AS rollover_occurrence_id,
      occurrence.league_id,
      occurrence.entry_draft_id,
      occurrence.to_season_id,
      occurrence.scheduled_starts_at_ms,
      occurrence.occurrence_key
    FROM entry_draft_rollover_bindings AS binding
    JOIN season_rollover_occurrences AS occurrence
      ON occurrence.league_id = binding.league_id
     AND occurrence.binding_id = binding.id
     AND occurrence.id =
       binding.current_rollover_occurrence_id
     AND occurrence.scheduled_job_run_id =
       binding.current_scheduled_job_run_id
     AND occurrence.status = binding.status
    JOIN job_runs AS run
      ON run.league_id = occurrence.league_id
     AND run.id = occurrence.scheduled_job_run_id
     AND run.job_type = ?
     AND run.occurrence_key =
       occurrence.occurrence_key
    WHERE occurrence.status IN (
      'scheduled',
      'blocked',
      'succeeded'
    )
      AND occurrence.scheduled_starts_at_ms <= ?
      AND (
        (
          run.status IN ('pending', 'failed')
          AND COALESCE(
            run.next_attempt_at_ms,
            run.scheduled_for_ms
          ) <= ?
        )
        OR (
          run.status IN ('leased', 'running')
          AND run.lease_expires_at_ms <= ?
        )
      )
    ORDER BY
      COALESCE(
        run.next_attempt_at_ms,
        run.scheduled_for_ms
      ),
      occurrence.scheduled_starts_at_ms,
      occurrence.id
    LIMIT ?
  `);
  const occurrenceStatement = database.prepare(`
    SELECT
      run.*,
      occurrence.id AS rollover_occurrence_id,
      occurrence.entry_draft_id,
      occurrence.to_season_id,
      occurrence.scheduled_starts_at_ms
    FROM job_runs AS run
    JOIN season_rollover_occurrences AS occurrence
      ON occurrence.league_id = run.league_id
     AND occurrence.scheduled_job_run_id =
       run.id
     AND occurrence.occurrence_key =
       run.occurrence_key
    JOIN entry_draft_rollover_bindings AS binding
      ON binding.league_id = occurrence.league_id
     AND binding.id = occurrence.binding_id
     AND binding.current_rollover_occurrence_id =
       occurrence.id
     AND binding.current_scheduled_job_run_id =
       run.id
     AND binding.status = occurrence.status
    WHERE run.league_id = @leagueId
      AND run.job_type = @jobType
      AND run.occurrence_key = @occurrenceKey
      AND occurrence.status IN (
        'scheduled',
        'blocked',
        'succeeded'
      )
    LIMIT 2
  `);
  const runByIdStatement = database.prepare(`
    SELECT *
    FROM job_runs
    WHERE league_id = @leagueId
      AND id = @runId
    LIMIT 2
  `);
  const claimStatement = database.prepare(`
    UPDATE job_runs
    SET status = 'running',
        attempt_count = attempt_count + 1,
        lease_owner = @leaseOwner,
        lease_token = @leaseToken,
        lease_expires_at_ms = @leaseExpiresAtMs,
        started_at_ms = @nowMs,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @nowMs,
        version = version + 1
    WHERE id = @runId
      AND league_id = @leagueId
      AND version = @expectedVersion
  `);
  const succeedStatement = database.prepare(`
    UPDATE job_runs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @completedAtMs,
        result_json = @resultJson,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @completedAtMs,
        version = version + 1
    WHERE id = @runId
      AND league_id = @leagueId
      AND status = 'running'
      AND lease_owner = @leaseOwner
      AND lease_token = @leaseToken
      AND version = @expectedVersion
  `);
  const failStatement = database.prepare(`
    UPDATE job_runs
    SET status = 'failed',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @completedAtMs,
        result_json = NULL,
        last_error_code = @errorCode,
        next_attempt_at_ms = @nextAttemptAtMs,
        updated_at_ms = @completedAtMs,
        version = version + 1
    WHERE id = @runId
      AND league_id = @leagueId
      AND status = 'running'
      AND lease_owner = @leaseOwner
      AND lease_token = @leaseToken
      AND version = @expectedVersion
  `);

  const claimTransaction = database.transaction(
    (command) => {
      const rows =
        occurrenceStatement.all(command);
      if (rows.length !== 1) {
        return frozen({
          acquired: false,
          runId: null,
          version: null,
        });
      }
      const row = rows[0];
      if (
        row.season_id !== command.seasonId ||
        row.to_season_id !==
          command.seasonId ||
        row.scheduled_for_ms !==
          command.scheduledForMs ||
        row.scheduled_starts_at_ms !==
          command.scheduledForMs
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The scheduled rollover job conflicts with its binding."
        );
      }
      const retryAtMs =
        row.next_attempt_at_ms ??
        row.scheduled_for_ms;
      const eligible =
        (["pending", "failed"].includes(
          row.status
        ) &&
          retryAtMs <= command.nowMs) ||
        (["leased", "running"].includes(
          row.status
        ) &&
          row.lease_expires_at_ms !== null &&
          row.lease_expires_at_ms <=
            command.nowMs);
      if (!eligible) {
        return frozen({
          acquired: false,
          runId: row.id,
          version: row.version,
        });
      }
      if (
        claimStatement.run({
          ...command,
          runId: row.id,
          expectedVersion: row.version,
        }).changes !== 1
      ) {
        return frozen({
          acquired: false,
          runId: row.id,
          version: row.version,
        });
      }
      if (beforeCommit) beforeCommit("claim");
      const claimed = runByIdStatement.get({
        leagueId: command.leagueId,
        runId: row.id,
      });
      return frozen({
        acquired: true,
        runId: claimed.id,
        version: claimed.version,
      });
    }
  );

  function guardedMutation(
    statement,
    command,
    operation
  ) {
    return database
      .transaction((input) => {
        if (statement.run(input).changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The season-rollover job lease changed."
          );
        }
        if (beforeCommit) beforeCommit(operation);
        return frozen(
          runByIdStatement.get({
            leagueId: input.leagueId,
            runId: input.runId,
          })
        );
      })
      .immediate(command);
  }

  function leaseCommand(command) {
    return {
      leagueId: stableId(
        command.leagueId,
        "league ID"
      ),
      runId: stableId(command.runId, "job-run ID"),
      leaseOwner: boundedText(
        command.leaseOwner,
        128,
        "lease owner"
      ),
      leaseToken: boundedText(
        command.leaseToken,
        200,
        "lease token"
      ),
      expectedVersion: positiveInteger(
        command.expectedVersion,
        "job-run version"
      ),
      completedAtMs: safeTimestamp(
        command.completedAtMs,
        "completion timestamp"
      ),
    };
  }

  return Object.freeze({
    listDueRolloverBindings({
      nowMs,
      limit = 25,
    } = {}) {
      const observedAtMs = safeTimestamp(
        nowMs,
        "due-query timestamp"
      );
      const boundedLimit = positiveInteger(
        limit,
        "due-query limit"
      );
      if (boundedLimit > 100) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The due-query limit is too large."
        );
      }
      try {
        return Object.freeze(
          dueStatement
            .all(
              ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
              observedAtMs,
              observedAtMs,
              observedAtMs,
              boundedLimit
            )
            .map((row) =>
              frozen({
                leagueId: row.league_id,
                toSeasonId: row.to_season_id,
                entryDraftId:
                  row.entry_draft_id,
                rolloverOccurrenceId:
                  row.rollover_occurrence_id,
                scheduledForMs:
                  row.scheduled_starts_at_ms,
                occurrenceKey:
                  row.occurrence_key,
              })
            )
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "listDueSeasonRolloverBindings",
          tableName:
            "entry_draft_rollover_bindings",
        });
      }
    },

    claimRun(command = {}) {
      const nowMs = safeTimestamp(
        command.nowMs,
        "claim timestamp"
      );
      const leaseExpiresAtMs = safeTimestamp(
        command.leaseExpiresAtMs,
        "lease-expiry timestamp"
      );
      if (leaseExpiresAtMs <= nowMs) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The lease expiry must follow the claim."
        );
      }
      const canonical = {
        leagueId: stableId(
          command.leagueId,
          "league ID"
        ),
        seasonId: stableId(
          command.seasonId,
          "season ID"
        ),
        jobType: boundedText(
          command.jobType,
          100,
          "job type"
        ),
        occurrenceKey: boundedText(
          command.occurrenceKey,
          512,
          "occurrence key"
        ),
        scheduledForMs: safeTimestamp(
          command.scheduledForMs,
          "scheduled timestamp"
        ),
        leaseOwner: boundedText(
          command.leaseOwner,
          128,
          "lease owner"
        ),
        leaseToken: boundedText(
          command.leaseToken,
          200,
          "lease token"
        ),
        nowMs,
        leaseExpiresAtMs,
      };
      if (
        canonical.jobType !==
        ENTRY_DRAFT_ROLLOVER_JOB_TYPE
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The Entry Draft rollover job type is required."
        );
      }
      try {
        return claimTransaction.immediate(
          canonical
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "claimSeasonRolloverRun",
          tableName: "job_runs",
        });
      }
    },

    succeedRun(command = {}) {
      const canonical = leaseCommand(command);
      if (
        !["succeeded", "blocked"].includes(
          command.outcome
        ) ||
        (command.outcome === "succeeded" &&
          !UUID_PATTERN.test(
            command.rolloverId || ""
          )) ||
        (command.outcome === "blocked" &&
          command.rolloverId !== null)
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A canonical rollover-job outcome is required."
        );
      }
      try {
        return guardedMutation(
          succeedStatement,
          {
            ...canonical,
            resultJson: JSON.stringify({
              outcome: command.outcome,
              rolloverId:
                command.rolloverId,
            }),
          },
          "succeed"
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "succeedSeasonRolloverRun",
          tableName: "job_runs",
        });
      }
    },

    failRun(command = {}) {
      const canonical = leaseCommand(command);
      const nextAttemptAtMs = safeTimestamp(
        command.nextAttemptAtMs,
        "next-attempt timestamp"
      );
      if (
        nextAttemptAtMs <=
        canonical.completedAtMs
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The next attempt must follow failure."
        );
      }
      try {
        return guardedMutation(
          failStatement,
          {
            ...canonical,
            nextAttemptAtMs,
            errorCode: boundedText(
              command.errorCode,
              100,
              "error code"
            ),
          },
          "fail"
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "failSeasonRolloverRun",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  createSqliteSeasonRolloverJobRepository,
};
