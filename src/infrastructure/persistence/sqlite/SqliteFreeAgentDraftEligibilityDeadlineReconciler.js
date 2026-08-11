const {
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  parseCanonicalJsonV1,
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
const SOURCE_KIND = "deadline_reconciliation";
const DEADLINE_RESULT_JSON = serializeCanonicalJsonV1({
  outcome: "deadline_reconciled",
});
const INPUT_FIELDS = Object.freeze([
  "deadlineOperationId",
  "fadId",
  "leagueId",
  "nowMs",
  "seasonId",
]);
const SYNCHRONIZATION_FIELDS = Object.freeze([
  "affectedCardCount",
  "cards",
  "changedCardCount",
  "leagueId",
  "sourceKind",
  "sourceOperationId",
]);
const CONSUMABLE_STATUSES = new Set([
  "pending",
  "failed",
  "leased",
  "running",
]);
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "skipped",
]);

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

function notFound(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
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
  return value;
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

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      "A safe deadline reconciliation timestamp is required.",
      "TIMESTAMP_INVALID"
    );
  }
  return value;
}

function normalizeInput(input) {
  exactObject(
    input,
    INPUT_FIELDS,
    "FAD eligibility deadline reconciliation input"
  );
  return Object.freeze({
    leagueId: canonicalId(
      input.leagueId,
      "league identifier"
    ),
    seasonId: canonicalId(
      input.seasonId,
      "season identifier"
    ),
    fadId: canonicalId(
      input.fadId,
      "Free Agent Draft identifier"
    ),
    deadlineOperationId: canonicalId(
      input.deadlineOperationId,
      "deadline operation identifier"
    ),
    nowMs: safeTimestamp(input.nowMs),
  });
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalOptionalTimestamp(value) {
  return value === null || safeNonnegativeInteger(value);
}

function canonicalOptionalText(value) {
  return value === null || (
    typeof value === "string" &&
    value.length >= 1
  );
}

function canonicalResultJson(value) {
  if (typeof value !== "string") return false;
  try {
    parseCanonicalJsonV1(value);
    return true;
  } catch {
    return false;
  }
}

function requireCanonicalJob(row, command) {
  if (
    !row ||
    !UUID_PATTERN.test(row.occurrence_id || "") ||
    !UUID_PATTERN.test(row.occurrence_job_run_id || "") ||
    row.occurrence_league_id !== command.leagueId ||
    row.occurrence_season_id !== command.seasonId ||
    row.occurrence_fad_id !== command.fadId ||
    !safeNonnegativeInteger(
      row.occurrence_scheduled_for_ms
    ) ||
    !safeNonnegativeInteger(
      row.occurrence_created_at_ms
    ) ||
    row.occurrence_scheduled_for_ms !==
      row.occurrence_created_at_ms ||
    !UUID_PATTERN.test(row.job_id || "") ||
    row.job_id !== row.occurrence_job_run_id ||
    row.job_league_id !== command.leagueId ||
    row.job_season_id !== command.seasonId ||
    row.job_type !== JOB_TYPE ||
    row.job_occurrence_key !==
      row.occurrence_occurrence_key ||
    row.job_scheduled_for_ms !==
      row.occurrence_scheduled_for_ms ||
    row.job_created_at_ms !==
      row.occurrence_created_at_ms ||
    !safeNonnegativeInteger(row.job_attempt_count) ||
    !safeNonnegativeInteger(row.job_created_at_ms) ||
    !safeNonnegativeInteger(row.job_updated_at_ms) ||
    row.job_updated_at_ms < row.job_created_at_ms ||
    !Number.isSafeInteger(row.job_version) ||
    row.job_version < 1 ||
    !canonicalOptionalText(row.job_lease_owner) ||
    !canonicalOptionalText(row.job_lease_token) ||
    !canonicalOptionalTimestamp(
      row.job_lease_expires_at_ms
    ) ||
    !canonicalOptionalTimestamp(row.job_started_at_ms) ||
    !canonicalOptionalTimestamp(row.job_completed_at_ms) ||
    !canonicalOptionalTimestamp(
      row.job_next_attempt_at_ms
    )
  ) {
    incompatible(
      "An eligibility revalidation occurrence lost its exact job binding.",
      "JOB_BINDING_INVALID"
    );
  }

  const status = row.job_status;
  if (
    !CONSUMABLE_STATUSES.has(status) &&
    !TERMINAL_STATUSES.has(status)
  ) {
    incompatible(
      "An eligibility revalidation job has an unsupported status.",
      "JOB_STATUS_INVALID"
    );
  }
  if (
    row.job_started_at_ms !== null &&
    row.job_completed_at_ms !== null &&
    row.job_completed_at_ms < row.job_started_at_ms
  ) {
    incompatible(
      "An eligibility revalidation job has invalid timing evidence.",
      "JOB_TIMING_INVALID"
    );
  }

  const leaseCleared =
    row.job_lease_owner === null &&
    row.job_lease_token === null &&
    row.job_lease_expires_at_ms === null;
  if (status === "pending") {
    if (
      !leaseCleared ||
      row.job_started_at_ms !== null ||
      row.job_completed_at_ms !== null ||
      row.job_result_json !== null ||
      row.job_last_error_code !== null
    ) {
      incompatible(
        "A pending eligibility revalidation job is noncanonical.",
        "JOB_STATE_INVALID"
      );
    }
  } else if (status === "failed") {
    if (
      !leaseCleared ||
      row.job_started_at_ms === null ||
      row.job_completed_at_ms === null ||
      row.job_result_json !== null ||
      typeof row.job_last_error_code !== "string" ||
      row.job_last_error_code.length < 1 ||
      row.job_next_attempt_at_ms === null
    ) {
      incompatible(
        "A failed eligibility revalidation job is noncanonical.",
        "JOB_STATE_INVALID"
      );
    }
  } else if (
    status === "leased" ||
    status === "running"
  ) {
    if (
      leaseCleared ||
      row.job_lease_owner === null ||
      row.job_lease_token === null ||
      row.job_lease_expires_at_ms === null ||
      (
        status === "running" &&
        row.job_started_at_ms === null
      ) ||
      row.job_completed_at_ms !== null ||
      row.job_result_json !== null ||
      row.job_last_error_code !== null ||
      row.job_next_attempt_at_ms !== null
    ) {
      incompatible(
        "A claimed eligibility revalidation job is noncanonical.",
        "JOB_STATE_INVALID"
      );
    }
  } else if (
    !leaseCleared ||
    row.job_started_at_ms === null ||
    row.job_completed_at_ms === null ||
    !canonicalResultJson(row.job_result_json) ||
    row.job_last_error_code !== null ||
    row.job_next_attempt_at_ms !== null
  ) {
    incompatible(
      "A terminal eligibility revalidation job is noncanonical.",
      "JOB_STATE_INVALID"
    );
  }

  if (
    CONSUMABLE_STATUSES.has(status) &&
    (
      command.nowMs < row.job_created_at_ms ||
      command.nowMs < row.job_updated_at_ms ||
      (
        row.job_started_at_ms !== null &&
        command.nowMs < row.job_started_at_ms
      )
    )
  ) {
    conflict(
      "The deadline reconciliation timestamp precedes eligibility job evidence.",
      "DEADLINE_TIME_PRECEDES_JOB"
    );
  }

  return Object.freeze({ ...row });
}

function requireSynchronizationResult(
  value,
  command,
  affectedTeamIds
) {
  const actualFields = isPlainObject(value)
    ? Object.keys(value).sort()
    : [];
  const expectedFields = [...SYNCHRONIZATION_FIELDS].sort();
  if (
    !isPlainObject(value) ||
    actualFields.length !== expectedFields.length ||
    actualFields.some(
      (field, index) => field !== expectedFields[index]
    ) ||
    value.leagueId !== command.leagueId ||
    value.sourceOperationId !==
      command.deadlineOperationId ||
    value.sourceKind !== SOURCE_KIND ||
    !Number.isSafeInteger(value.affectedCardCount) ||
    value.affectedCardCount !== affectedTeamIds.length ||
    !Number.isSafeInteger(value.changedCardCount) ||
    value.changedCardCount < 0 ||
    value.changedCardCount > value.affectedCardCount ||
    !Array.isArray(value.cards) ||
    value.cards.length !== value.affectedCardCount
  ) {
    incompatible(
      "The final Candidate Card deadline synchronization result is invalid.",
      "SYNCHRONIZATION_RESULT_INVALID"
    );
  }
  return value;
}

function createSqliteFreeAgentDraftEligibilityDeadlineReconciler({
  database,
  candidateCardSummerSynchronizer,
  beforeJobCas,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "createSqliteFreeAgentDraftEligibilityDeadlineReconciler requires an opened database"
    );
  }
  const synchronizeInCurrentTransaction =
    typeof candidateCardSummerSynchronizer
      ?.synchronizeInCurrentTransaction === "function"
      ? candidateCardSummerSynchronizer
          .synchronizeInCurrentTransaction
          .bind(candidateCardSummerSynchronizer)
      : typeof candidateCardSummerSynchronizer?.synchronize ===
          "function"
        ? candidateCardSummerSynchronizer.synchronize.bind(
            candidateCardSummerSynchronizer
          )
        : null;
  if (!synchronizeInCurrentTransaction) {
    throw new TypeError(
      "createSqliteFreeAgentDraftEligibilityDeadlineReconciler requires the shared Candidate Card summer synchronizer"
    );
  }
  if (
    beforeJobCas !== undefined &&
    typeof beforeJobCas !== "function"
  ) {
    throw new TypeError(
      "FAD eligibility deadline beforeJobCas must be a function"
    );
  }

  let fadStatement;
  let cardsStatement;
  let jobsStatement;
  let consumeJobStatement;
  try {
    fadStatement = database.prepare(`
      SELECT id, status
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @fadId
      LIMIT 2
    `);
    cardsStatement = database.prepare(`
      SELECT id, team_id
      FROM candidate_cards
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND status = 'open'
      ORDER BY team_id, id
    `);
    jobsStatement = database.prepare(`
      SELECT
        occurrence.id AS occurrence_id,
        occurrence.league_id AS occurrence_league_id,
        occurrence.season_id AS occurrence_season_id,
        occurrence.fad_id AS occurrence_fad_id,
        occurrence.job_run_id AS occurrence_job_run_id,
        occurrence.occurrence_key AS occurrence_occurrence_key,
        occurrence.scheduled_for_ms
          AS occurrence_scheduled_for_ms,
        occurrence.created_at_ms
          AS occurrence_created_at_ms,
        job.id AS job_id,
        job.league_id AS job_league_id,
        job.season_id AS job_season_id,
        job.job_type AS job_type,
        job.occurrence_key AS job_occurrence_key,
        job.scheduled_for_ms AS job_scheduled_for_ms,
        job.status AS job_status,
        job.attempt_count AS job_attempt_count,
        job.lease_owner AS job_lease_owner,
        job.lease_token AS job_lease_token,
        job.lease_expires_at_ms
          AS job_lease_expires_at_ms,
        job.started_at_ms AS job_started_at_ms,
        job.completed_at_ms AS job_completed_at_ms,
        job.result_json AS job_result_json,
        job.last_error_code AS job_last_error_code,
        job.next_attempt_at_ms AS job_next_attempt_at_ms,
        job.created_at_ms AS job_created_at_ms,
        job.updated_at_ms AS job_updated_at_ms,
        job.version AS job_version
      FROM free_agent_draft_eligibility_revalidation_occurrences
        AS occurrence
      LEFT JOIN job_runs AS job
        ON job.league_id = occurrence.league_id
       AND job.id = occurrence.job_run_id
      WHERE occurrence.league_id = @leagueId
        AND occurrence.season_id = @seasonId
        AND occurrence.fad_id = @fadId
      ORDER BY occurrence.id
    `);
    consumeJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'skipped',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          started_at_ms = @newStartedAtMs,
          completed_at_ms = @nowMs,
          result_json = @deadlineResultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE id IS @jobId
        AND league_id IS @jobLeagueId
        AND season_id IS @jobSeasonId
        AND job_type IS @jobType
        AND occurrence_key IS @jobOccurrenceKey
        AND scheduled_for_ms IS @jobScheduledForMs
        AND status IS @jobStatus
        AND attempt_count IS @jobAttemptCount
        AND lease_owner IS @jobLeaseOwner
        AND lease_token IS @jobLeaseToken
        AND lease_expires_at_ms IS @jobLeaseExpiresAtMs
        AND started_at_ms IS @jobStartedAtMs
        AND completed_at_ms IS @jobCompletedAtMs
        AND result_json IS @jobResultJson
        AND last_error_code IS @jobLastErrorCode
        AND next_attempt_at_ms IS @jobNextAttemptAtMs
        AND created_at_ms IS @jobCreatedAtMs
        AND updated_at_ms IS @jobUpdatedAtMs
        AND version IS @jobVersion
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftEligibilityDeadlineReconciler",
      tableName:
        "free_agent_draft_eligibility_revalidation_occurrences",
    });
  }

  return Object.freeze({
    reconcileInCurrentTransaction(input = {}) {
      const command = normalizeInput(input);
      if (database.inTransaction !== true) {
        invalid(
          "FAD eligibility deadline reconciliation requires the caller transaction.",
          "TRANSACTION_REQUIRED"
        );
      }
      try {
        const fads = fadStatement.all(command);
        if (fads.length === 0) {
          notFound(
            "The Free Agent Draft was not found.",
            "FAD_NOT_FOUND"
          );
        }
        if (fads.length !== 1) {
          incompatible(
            "The Free Agent Draft scope is ambiguous.",
            "FAD_SCOPE_AMBIGUOUS"
          );
        }
        if (fads[0].status !== "cards_open") {
          conflict(
            "The Free Agent Draft Candidate Cards are not open.",
            "FAD_NOT_CARDS_OPEN"
          );
        }

        const cardRows = cardsStatement.all(command);
        const affectedTeamIds = Object.freeze(
          cardRows.map((row) => row.team_id)
        );
        if (
          affectedTeamIds.length === 0 ||
          new Set(affectedTeamIds).size !==
            affectedTeamIds.length ||
          cardRows.some(
            (row) =>
              !UUID_PATTERN.test(row.id || "") ||
              !UUID_PATTERN.test(row.team_id || "")
          )
        ) {
          incompatible(
            "The open Free Agent Draft must have one canonical Candidate Card per team.",
            "OPEN_CANDIDATE_CARDS_INVALID"
          );
        }

        const jobs = jobsStatement
          .all(command)
          .map((row) =>
            requireCanonicalJob(row, command)
          );
        const synchronization =
          requireSynchronizationResult(
            synchronizeInCurrentTransaction({
              leagueId: command.leagueId,
              affectedTeamIds,
              affectedPlayerIds: [],
              sourceOperationId:
                command.deadlineOperationId,
              sourceKind: SOURCE_KIND,
              nowMs: command.nowMs,
            }),
            command,
            affectedTeamIds
          );

        let reconciledJobCount = 0;
        let alreadySucceededJobCount = 0;
        let alreadySkippedJobCount = 0;
        for (let index = 0; index < jobs.length; index += 1) {
          const job = jobs[index];
          if (job.job_status === "succeeded") {
            alreadySucceededJobCount += 1;
            continue;
          }
          if (job.job_status === "skipped") {
            alreadySkippedJobCount += 1;
            continue;
          }
          if (beforeJobCas) {
            const hookResult = beforeJobCas(
              Object.freeze({
                command,
                index,
                job,
              })
            );
            if (
              hookResult &&
              typeof hookResult.then === "function"
            ) {
              throw repositoryError(
                REPOSITORY_ERROR_CODES.transactionAsync,
                "FAD eligibility deadline beforeJobCas must be synchronous."
              );
            }
          }
          const update = consumeJobStatement.run({
            jobId: job.job_id,
            jobLeagueId: job.job_league_id,
            jobSeasonId: job.job_season_id,
            jobType: job.job_type,
            jobOccurrenceKey: job.job_occurrence_key,
            jobScheduledForMs: job.job_scheduled_for_ms,
            jobStatus: job.job_status,
            jobAttemptCount: job.job_attempt_count,
            jobLeaseOwner: job.job_lease_owner,
            jobLeaseToken: job.job_lease_token,
            jobLeaseExpiresAtMs:
              job.job_lease_expires_at_ms,
            jobStartedAtMs: job.job_started_at_ms,
            jobCompletedAtMs: job.job_completed_at_ms,
            jobResultJson: job.job_result_json,
            jobLastErrorCode:
              job.job_last_error_code,
            jobNextAttemptAtMs:
              job.job_next_attempt_at_ms,
            jobCreatedAtMs: job.job_created_at_ms,
            jobUpdatedAtMs: job.job_updated_at_ms,
            jobVersion: job.job_version,
            newStartedAtMs:
              job.job_started_at_ms ?? command.nowMs,
            nowMs: command.nowMs,
            deadlineResultJson: DEADLINE_RESULT_JSON,
          });
          if (update.changes !== 1) {
            conflict(
              "An eligibility revalidation job changed during deadline reconciliation.",
              "JOB_TERMINAL_CAS_FAILED"
            );
          }
          reconciledJobCount += 1;
        }

        return Object.freeze({
          outcome: "deadline_reconciled",
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId: command.fadId,
          deadlineOperationId:
            command.deadlineOperationId,
          affectedTeamIds,
          affectedCardCount:
            synchronization.affectedCardCount,
          changedCardCount:
            synchronization.changedCardCount,
          occurrenceCount: jobs.length,
          reconciledJobCount,
          alreadySucceededJobCount,
          alreadySkippedJobCount,
          reconciledAtMs: command.nowMs,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "reconcileFreeAgentDraftEligibilityAtDeadline",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  FAD_ELIGIBILITY_DEADLINE_RESULT_JSON:
    DEADLINE_RESULT_JSON,
  createSqliteFreeAgentDraftEligibilityDeadlineReconciler,
};
