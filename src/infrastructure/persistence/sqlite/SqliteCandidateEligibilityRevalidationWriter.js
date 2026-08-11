const {
  UUID_PATTERN,
  buildFreeAgentDraftEligibilityOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const JOB_TYPE = "fad_eligibility_revalidation";
const SOURCE_KIND = "player_catalog_import";
const COMMAND_FIELDS = Object.freeze([
  "executedAtMs",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceId",
  "occurrenceKey",
  "playerId",
  "scheduledForMs",
  "seasonId",
  "sourceOperationId",
  "sourceProvider",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function invalid(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    { details: { reasonCode } }
  );
}

function conflict(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    { details: { reasonCode } }
  );
}

function incompatible(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    { details: { reasonCode } }
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, fields, description) {
  if (!isPlainObject(value)) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_INVALID"
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_FIELDS_INVALID"
    );
  }
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`,
      "IDENTIFIER_INVALID"
    );
  }
  return value;
}

function boundedText(
  value,
  maximumLength,
  description
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid(
      `A bounded ${description} is required.`,
      "TEXT_INVALID"
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      `A safe ${description} is required.`,
      "TIMESTAMP_INVALID"
    );
  }
  return value;
}

function positiveInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(
      `A positive ${description} is required.`,
      "VERSION_INVALID"
    );
  }
  return value;
}

function normalizeCommand(input) {
  exactObject(
    input,
    COMMAND_FIELDS,
    "Candidate eligibility execution command"
  );
  exactObject(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "Candidate eligibility job execution"
  );
  const leagueId = canonicalId(
    input.leagueId,
    "league identifier"
  );
  const seasonId = canonicalId(
    input.seasonId,
    "season identifier"
  );
  const fadId = canonicalId(
    input.fadId,
    "Free Agent Draft identifier"
  );
  const playerId = canonicalId(
    input.playerId,
    "player identifier"
  );
  const sourceOperationId = canonicalId(
    input.sourceOperationId,
    "catalog source-operation identifier"
  );
  const occurrenceId = canonicalId(
    input.occurrenceId,
    "eligibility-revalidation occurrence identifier"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "eligibility-revalidation occurrence key"
  );
  const canonicalOccurrenceKey =
    buildFreeAgentDraftEligibilityOccurrenceKey({
      fadId,
      playerId,
      sourceOperationId,
    });
  if (occurrenceKey !== canonicalOccurrenceKey) {
    invalid(
      "The Candidate eligibility occurrence key is not canonical for its scope.",
      "OCCURRENCE_KEY_INVALID"
    );
  }
  const executedAtMs = safeTimestamp(
    input.executedAtMs,
    "eligibility execution timestamp"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "eligibility scheduled timestamp"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "eligibility lease expiry"
  );
  if (executedAtMs >= leaseExpiresAtMs) {
    conflict(
      "The Candidate eligibility execution lease has expired.",
      "JOB_LEASE_EXPIRED"
    );
  }
  return Object.freeze({
    leagueId,
    seasonId,
    fadId,
    occurrenceId,
    playerId,
    sourceOperationId,
    sourceProvider: boundedText(
      input.sourceProvider,
      80,
      "catalog source provider"
    ),
    occurrenceKey,
    scheduledForMs,
    executedAtMs,
    runId: canonicalId(
      input.jobExecution.runId,
      "job-run identifier"
    ),
    leaseOwner: boundedText(
      input.jobExecution.leaseOwner,
      128,
      "job lease owner"
    ),
    leaseToken: boundedText(
      input.jobExecution.leaseToken,
      200,
      "job lease token"
    ),
    leaseExpiresAtMs,
    expectedVersion: positiveInteger(
      input.jobExecution.expectedVersion,
      "job-run version"
    ),
  });
}

function requireSynchronizationResult(
  result,
  command
) {
  if (
    !isPlainObject(result) ||
    Object.keys(result).sort().join("|") !==
      [
        "affectedCardCount",
        "cards",
        "changedCardCount",
        "leagueId",
        "sourceKind",
        "sourceOperationId",
      ]
        .sort()
        .join("|") ||
    result.leagueId !== command.leagueId ||
    result.sourceOperationId !==
      command.occurrenceId ||
    result.sourceKind !== SOURCE_KIND ||
    !Number.isSafeInteger(
      result.affectedCardCount
    ) ||
    result.affectedCardCount < 0 ||
    !Number.isSafeInteger(
      result.changedCardCount
    ) ||
    result.changedCardCount < 0 ||
    result.changedCardCount >
      result.affectedCardCount ||
    !Array.isArray(result.cards) ||
    result.cards.length !==
      result.affectedCardCount
  ) {
    incompatible(
      "The Candidate eligibility synchronizer returned a noncanonical result.",
      "SYNCHRONIZATION_RESULT_INVALID"
    );
  }
  return result;
}

function createSqliteCandidateEligibilityRevalidationWriter({
  database,
  candidateCardSummerSynchronizer,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateEligibilityRevalidationWriter requires an opened database"
    );
  }
  if (
    !candidateCardSummerSynchronizer ||
    typeof candidateCardSummerSynchronizer.synchronize !==
      "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateEligibilityRevalidationWriter requires the shared Candidate Card summer synchronizer"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Candidate eligibility beforeCommit must be a function"
    );
  }

  let jobStatement;
  let bindingStatement;
  let succeedStatement;
  try {
    jobStatement = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
      LIMIT 2
    `);
    bindingStatement = database.prepare(`
      SELECT
        occurrence.id,
        occurrence.source_provider,
        occurrence.created_at_ms,
        event.event_type,
        event.feature,
        event.outcome,
        event.actor_user_id,
        event.reason_code,
        event.details_json,
        event.occurred_at_ms
      FROM free_agent_draft_eligibility_revalidation_occurrences
        AS occurrence
      JOIN operational_events AS event
        ON event.id = occurrence.source_operation_id
      WHERE occurrence.id = @occurrenceId
        AND occurrence.league_id = @leagueId
        AND occurrence.season_id = @seasonId
        AND occurrence.fad_id = @fadId
        AND occurrence.player_id = @playerId
        AND occurrence.source_operation_id =
            @sourceOperationId
        AND occurrence.source_provider =
            @sourceProvider
        AND occurrence.job_run_id = @runId
        AND occurrence.occurrence_key =
            @occurrenceKey
        AND occurrence.scheduled_for_ms =
            @scheduledForMs
        AND occurrence.created_at_ms =
            @scheduledForMs
        AND occurrence.version = 1
        AND event.league_id IS NULL
        AND event.season_id IS NULL
        AND event.event_type =
            'player_catalog_applied'
        AND event.feature =
            'player_data_provider'
        AND event.outcome = 'succeeded'
        AND event.actor_user_id IS NULL
        AND event.reason_code =
            'provider_catalog_import'
        AND event.occurred_at_ms =
            occurrence.created_at_ms
        AND json_valid(event.details_json) = 1
        AND json_extract(
              event.details_json,
              '$.sourceOperationId'
            ) = occurrence.source_operation_id
        AND json_extract(
              event.details_json,
              '$.provider'
            ) = occurrence.source_provider
        AND json_extract(
              event.details_json,
              '$.appliedAtMs'
            ) = event.occurred_at_ms
      LIMIT 2
    `);
    succeedStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @executedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @executedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
        AND status = 'running'
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms =
            @leaseExpiresAtMs
        AND lease_expires_at_ms >
            @executedAtMs
        AND version = @expectedVersion
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareCandidateEligibilityRevalidationWriter",
      tableName:
        "free_agent_draft_eligibility_revalidation_occurrences",
    });
  }

  const executeTransaction = database.transaction(
    (command) => {
      const jobs = jobStatement.all(command);
      if (jobs.length !== 1) {
        conflict(
          "The claimed Candidate eligibility job is unavailable or ambiguous.",
          "JOB_BINDING_CHANGED"
        );
      }
      const job = jobs[0];
      if (
        job.status !== "running" ||
        job.lease_owner !== command.leaseOwner ||
        job.lease_token !== command.leaseToken ||
        job.lease_expires_at_ms !==
          command.leaseExpiresAtMs ||
        job.lease_expires_at_ms <=
          command.executedAtMs ||
        job.version !== command.expectedVersion ||
        !Number.isSafeInteger(job.started_at_ms) ||
        job.started_at_ms < 0 ||
        job.started_at_ms > command.executedAtMs ||
        job.completed_at_ms !== null ||
        job.result_json !== null ||
        job.last_error_code !== null ||
        job.next_attempt_at_ms !== null
      ) {
        conflict(
          "The Candidate eligibility job lease, version, or state changed.",
          "JOB_LEASE_CHANGED"
        );
      }
      const bindings = bindingStatement.all(command);
      if (bindings.length !== 1) {
        incompatible(
          "The claimed Candidate eligibility job lost its sealed occurrence binding.",
          "OCCURRENCE_BINDING_INVALID"
        );
      }

      const synchronization =
        requireSynchronizationResult(
          candidateCardSummerSynchronizer.synchronize({
            leagueId: command.leagueId,
            affectedTeamIds: [],
            affectedPlayerIds: [command.playerId],
            sourceOperationId:
              command.occurrenceId,
            sourceKind: SOURCE_KIND,
            nowMs: command.executedAtMs,
          }),
          command
        );
      const result = Object.freeze({
        schemaVersion: 1,
        code:
          "FAD_ELIGIBILITY_REVALIDATED",
        occurrenceId: command.occurrenceId,
        playerId: command.playerId,
        affectedCardCount:
          synchronization.affectedCardCount,
        changedCardCount:
          synchronization.changedCardCount,
      });
      const resultJson =
        serializeCanonicalJsonV1(result);
      if (
        succeedStatement.run({
          ...command,
          resultJson,
        }).changes !== 1
      ) {
        conflict(
          "The Candidate eligibility job lease or version changed before completion.",
          "JOB_TERMINAL_CAS_FAILED"
        );
      }
      if (beforeCommit) {
        const hookResult = beforeCommit({
          command,
          result,
          synchronization,
        });
        if (
          hookResult &&
          typeof hookResult.then === "function"
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.transactionAsync,
            "Candidate eligibility beforeCommit must be synchronous."
          );
        }
      }
      const terminalRows = jobStatement.all(command);
      if (terminalRows.length !== 1) {
        incompatible(
          "The completed Candidate eligibility job could not be reloaded.",
          "JOB_TERMINAL_STATE_INVALID"
        );
      }
      const terminal = terminalRows[0];
      if (
        terminal.status !== "succeeded" ||
        terminal.attempt_count !== job.attempt_count ||
        terminal.lease_owner !== null ||
        terminal.lease_token !== null ||
        terminal.lease_expires_at_ms !== null ||
        terminal.started_at_ms !== job.started_at_ms ||
        terminal.completed_at_ms !==
          command.executedAtMs ||
        terminal.result_json !== resultJson ||
        terminal.last_error_code !== null ||
        terminal.next_attempt_at_ms !== null ||
        terminal.updated_at_ms !==
          command.executedAtMs ||
        terminal.version !==
          command.expectedVersion + 1
      ) {
        incompatible(
          "The completed Candidate eligibility job is noncanonical.",
          "JOB_TERMINAL_STATE_INVALID"
        );
      }
      return Object.freeze({
        outcome: "succeeded",
        runId: command.runId,
        occurrenceId: command.occurrenceId,
        playerId: command.playerId,
        affectedCardCount:
          synchronization.affectedCardCount,
        changedCardCount:
          synchronization.changedCardCount,
        completedAtMs: command.executedAtMs,
        jobVersion: command.expectedVersion + 1,
      });
    }
  );

  return Object.freeze({
    executeClaimed(input = {}) {
      const command = normalizeCommand(input);
      try {
        return executeTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "executeClaimedCandidateEligibilityRevalidation",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  CANDIDATE_ELIGIBILITY_REVALIDATION_JOB_TYPE:
    JOB_TYPE,
  CANDIDATE_ELIGIBILITY_REVALIDATION_SOURCE_KIND:
    SOURCE_KIND,
  createSqliteCandidateEligibilityRevalidationWriter,
};
