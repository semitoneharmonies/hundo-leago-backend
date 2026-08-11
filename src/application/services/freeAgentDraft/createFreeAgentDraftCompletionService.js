"use strict";

const {
  UUID_PATTERN,
  buildFreeAgentDraftCompletionOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const FREE_AGENT_DRAFT_COMPLETION_SERVICE_CODES =
  Object.freeze({
    inputInvalid: "FAD_COMPLETION_INPUT_INVALID",
    stateInvalid: "FAD_COMPLETION_STATE_INVALID",
  });
const INPUT_FIELDS = Object.freeze([
  "fadId",
  "initialWindowEndsAtMs",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "scheduledForMs",
  "seasonId",
]);
const FAILURE_INPUT_FIELDS = Object.freeze([
  ...INPUT_FIELDS,
  "errorCode",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "attemptCount",
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
  "startedAtMs",
]);
const TERMINAL_FIELDS = Object.freeze([
  "activityIds",
  "competitionFirstMatchupStartsAtMs",
  "completedAtMs",
  "fadVersion",
  "jobVersion",
  "notificationIds",
  "outboxEventIds",
  "outcome",
  "replayed",
  "runId",
  "scheduleRecoveryId",
]);
const FAILURE_RESULT_FIELDS = Object.freeze([
  "errorCode",
  "failedAtMs",
  "jobVersion",
  "recorded",
  "recoveryId",
  "recoveryVersion",
  "replayed",
  "runId",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/u;

class FreeAgentDraftCompletionServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft could not be completed."
    );
    this.name = "FreeAgentDraftCompletionServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftCompletionServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_COMPLETION_SERVICE_CODES
      .inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_COMPLETION_SERVICE_CODES
      .stateInvalid,
    reasonCode
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

function exactObject(value, fields, reasonCode) {
  if (!isPlainObject(value)) failInput(reasonCode);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    failInput(reasonCode);
  }
}

function canonicalId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function boundedText(
  value,
  maximumLength,
  reasonCode
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failInput(reasonCode);
  }
  return value;
}

function normalizeExecution(input) {
  exactObject(
    input,
    INPUT_FIELDS,
    "execution_fields_invalid"
  );
  exactObject(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "job_execution_fields_invalid"
  );
  const fadId = canonicalId(
    input.fadId,
    "fad_id_invalid"
  );
  const initialWindowEndsAtMs = safeTimestamp(
    input.initialWindowEndsAtMs,
    "initial_window_end_invalid"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "scheduled_timestamp_invalid"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "occurrence_key_invalid"
  );
  let canonicalOccurrenceKey;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftCompletionOccurrenceKey({
        fadId,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== initialWindowEndsAtMs
  ) {
    failInput("occurrence_scope_invalid");
  }
  return Object.freeze({
    leagueId: canonicalId(
      input.leagueId,
      "league_id_invalid"
    ),
    seasonId: canonicalId(
      input.seasonId,
      "season_id_invalid"
    ),
    fadId,
    initialWindowEndsAtMs,
    occurrenceKey,
    scheduledForMs,
    jobExecution: Object.freeze({
      runId: canonicalId(
        input.jobExecution.runId,
        "job_run_id_invalid"
      ),
      leaseOwner: boundedText(
        input.jobExecution.leaseOwner,
        128,
        "lease_owner_invalid"
      ),
      leaseToken: boundedText(
        input.jobExecution.leaseToken,
        200,
        "lease_token_invalid"
      ),
      leaseExpiresAtMs: safeTimestamp(
        input.jobExecution.leaseExpiresAtMs,
        "lease_expiry_invalid"
      ),
      startedAtMs: safeTimestamp(
        input.jobExecution.startedAtMs,
        "started_timestamp_invalid"
      ),
      attemptCount: positiveInteger(
        input.jobExecution.attemptCount,
        "attempt_count_invalid"
      ),
      expectedVersion: positiveInteger(
        input.jobExecution.expectedVersion,
        "job_version_invalid"
      ),
    }),
  });
}

function normalizeFailureExecution(input) {
  exactObject(
    input,
    FAILURE_INPUT_FIELDS,
    "failure_fields_invalid"
  );
  const { errorCode, ...executionInput } = input;
  if (
    typeof errorCode !== "string" ||
    !ERROR_CODE_PATTERN.test(errorCode)
  ) {
    failInput("failure_error_code_invalid");
  }
  return Object.freeze({
    ...normalizeExecution(executionInput),
    errorCode,
  });
}

function canonicalIdArray(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (id) => UUID_PATTERN.test(id || "")
    ) &&
    new Set(value).size === value.length
  );
}

function requireTerminal(result, execution) {
  const recovered =
    result?.scheduleRecoveryId !== null;
  if (
    !isPlainObject(result) ||
    Object.keys(result).sort().join("|") !==
      [...TERMINAL_FIELDS].sort().join("|") ||
    result.outcome !== "succeeded" ||
    typeof result.replayed !== "boolean" ||
    result.runId !== execution.jobExecution.runId ||
    !Number.isSafeInteger(result.completedAtMs) ||
    result.completedAtMs <
      execution.initialWindowEndsAtMs ||
    result.completedAtMs >=
      execution.jobExecution.leaseExpiresAtMs ||
    result.jobVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !Number.isSafeInteger(result.fadVersion) ||
    result.fadVersion < 1 ||
    !Number.isSafeInteger(
      result.competitionFirstMatchupStartsAtMs
    ) ||
    result.competitionFirstMatchupStartsAtMs < 0 ||
    (
      recovered
        ? !UUID_PATTERN.test(
            result.scheduleRecoveryId || ""
          ) || result.activityIds?.length !== 2
        : result.activityIds?.length !== 1
    ) ||
    !canonicalIdArray(result.activityIds) ||
    !canonicalIdArray(result.notificationIds) ||
    !canonicalIdArray(result.outboxEventIds) ||
    result.outboxEventIds.length < 2
  ) {
    failState("terminal_result_invalid");
  }
  return Object.freeze({
    ...result,
    activityIds: Object.freeze([
      ...result.activityIds,
    ]),
    notificationIds: Object.freeze([
      ...result.notificationIds,
    ]),
    outboxEventIds: Object.freeze([
      ...result.outboxEventIds,
    ]),
  });
}

function requireFailureResult(result, execution, failedAtMs) {
  if (
    !isPlainObject(result) ||
    Object.keys(result).sort().join("|") !==
      [...FAILURE_RESULT_FIELDS].sort().join("|") ||
    result.recorded !== true ||
    typeof result.replayed !== "boolean" ||
    result.runId !== execution.jobExecution.runId ||
    result.failedAtMs !== failedAtMs ||
    result.errorCode !== execution.errorCode ||
    result.jobVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !UUID_PATTERN.test(result.recoveryId || "") ||
    !Number.isSafeInteger(result.recoveryVersion) ||
    result.recoveryVersion < 1
  ) {
    failState("failure_result_invalid");
  }
  return Object.freeze({ ...result });
}

function createFreeAgentDraftCompletionService({
  writer,
  lifecycleRepository,
  clock,
} = {}) {
  if (
    !writer ||
    typeof writer.executeClaimed !== "function" ||
    typeof writer.recordFailure !== "function"
  ) {
    throw new TypeError(
      "FAD completion requires its atomic writer"
    );
  }
  if (
    !lifecycleRepository ||
    typeof lifecycleRepository.advanceStatus !==
      "function"
  ) {
    throw new TypeError(
      "FAD completion requires the lifecycle repository"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "FAD completion requires a UTC clock"
    );
  }

  return Object.freeze({
    executeClaimedCompletion(input = {}) {
      const execution = normalizeExecution(input);
      const completedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(completedAtMs) ||
        completedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (
        completedAtMs <
        execution.initialWindowEndsAtMs
      ) {
        failState("completion_not_due");
      }
      if (
        completedAtMs <
          execution.jobExecution.startedAtMs ||
        completedAtMs >=
          execution.jobExecution.leaseExpiresAtMs
      ) {
        failState("claimed_lease_expired");
      }
      const result = writer.executeClaimed(
        {
          leagueId: execution.leagueId,
          seasonId: execution.seasonId,
          fadId: execution.fadId,
          initialWindowEndsAtMs:
            execution.initialWindowEndsAtMs,
          occurrenceKey: execution.occurrenceKey,
          scheduledForMs:
            execution.scheduledForMs,
          completedAtMs,
          jobExecution: execution.jobExecution,
        },
        lifecycleRepository
      );
      if (
        result &&
        typeof result.then === "function"
      ) {
        failState("writer_must_be_synchronous");
      }
      return requireTerminal(result, execution);
    },
    recordClaimedFailure(input = {}) {
      const execution = normalizeFailureExecution(input);
      const failedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(failedAtMs) ||
        failedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (
        failedAtMs < execution.jobExecution.startedAtMs ||
        failedAtMs >=
          execution.jobExecution.leaseExpiresAtMs
      ) {
        failState("claimed_lease_expired");
      }
      const result = writer.recordFailure({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        initialWindowEndsAtMs:
          execution.initialWindowEndsAtMs,
        occurrenceKey: execution.occurrenceKey,
        scheduledForMs: execution.scheduledForMs,
        failedAtMs,
        errorCode: execution.errorCode,
        jobExecution: execution.jobExecution,
      });
      if (
        result &&
        typeof result.then === "function"
      ) {
        failState("writer_must_be_synchronous");
      }
      return requireFailureResult(
        result,
        execution,
        failedAtMs
      );
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_COMPLETION_SERVICE_CODES,
  FreeAgentDraftCompletionServiceError,
  createFreeAgentDraftCompletionService,
};
