const {
  UUID_PATTERN,
  buildFreeAgentDraftEligibilityOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const CANDIDATE_ELIGIBILITY_REVALIDATION_SERVICE_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_ELIGIBILITY_REVALIDATION_INPUT_INVALID",
    stateInvalid:
      "FAD_ELIGIBILITY_REVALIDATION_STATE_INVALID",
  });
const INPUT_FIELDS = Object.freeze([
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
const TERMINAL_FIELDS = Object.freeze([
  "affectedCardCount",
  "changedCardCount",
  "completedAtMs",
  "jobVersion",
  "occurrenceId",
  "outcome",
  "playerId",
  "runId",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class CandidateEligibilityRevalidationServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Candidate eligibility revalidation job could not be executed."
    );
    this.name =
      "CandidateEligibilityRevalidationServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new CandidateEligibilityRevalidationServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    CANDIDATE_ELIGIBILITY_REVALIDATION_SERVICE_CODES
      .inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    CANDIDATE_ELIGIBILITY_REVALIDATION_SERVICE_CODES
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
  if (!isPlainObject(value)) {
    failInput(reasonCode);
  }
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
  const playerId = canonicalId(
    input.playerId,
    "player_id_invalid"
  );
  const sourceOperationId = canonicalId(
    input.sourceOperationId,
    "source_operation_id_invalid"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "occurrence_key_invalid"
  );
  let canonicalOccurrenceKey;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftEligibilityOccurrenceKey({
        fadId,
        playerId,
        sourceOperationId,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (occurrenceKey !== canonicalOccurrenceKey) {
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
    occurrenceId: canonicalId(
      input.occurrenceId,
      "occurrence_id_invalid"
    ),
    playerId,
    sourceOperationId,
    sourceProvider: boundedText(
      input.sourceProvider,
      80,
      "source_provider_invalid"
    ),
    occurrenceKey,
    scheduledForMs: safeTimestamp(
      input.scheduledForMs,
      "scheduled_timestamp_invalid"
    ),
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
      expectedVersion: positiveInteger(
        input.jobExecution.expectedVersion,
        "job_version_invalid"
      ),
    }),
  });
}

function requireTerminal(result, execution) {
  if (
    !isPlainObject(result) ||
    Object.keys(result).sort().join("|") !==
      [...TERMINAL_FIELDS].sort().join("|") ||
    result.outcome !== "succeeded" ||
    result.runId !== execution.jobExecution.runId ||
    result.occurrenceId !==
      execution.occurrenceId ||
    result.playerId !== execution.playerId ||
    !Number.isSafeInteger(result.completedAtMs) ||
    result.completedAtMs < 0 ||
    result.completedAtMs >=
      execution.jobExecution.leaseExpiresAtMs ||
    result.jobVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !Number.isSafeInteger(
      result.affectedCardCount
    ) ||
    result.affectedCardCount < 0 ||
    !Number.isSafeInteger(
      result.changedCardCount
    ) ||
    result.changedCardCount < 0 ||
    result.changedCardCount >
      result.affectedCardCount
  ) {
    failState("terminal_result_invalid");
  }
  return Object.freeze({ ...result });
}

function createCandidateEligibilityRevalidationService({
  writer,
  clock,
} = {}) {
  if (
    !writer ||
    typeof writer.executeClaimed !== "function"
  ) {
    throw new TypeError(
      "Candidate eligibility revalidation requires an execution writer"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "Candidate eligibility revalidation requires a UTC clock"
    );
  }

  return Object.freeze({
    executeClaimedEligibilityRevalidation(
      input = {}
    ) {
      const execution = normalizeExecution(input);
      const executedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(executedAtMs) ||
        executedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (
        executedAtMs >=
        execution.jobExecution.leaseExpiresAtMs
      ) {
        failState("claimed_lease_expired");
      }
      const result = writer.executeClaimed({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        occurrenceId: execution.occurrenceId,
        playerId: execution.playerId,
        sourceOperationId:
          execution.sourceOperationId,
        sourceProvider:
          execution.sourceProvider,
        occurrenceKey:
          execution.occurrenceKey,
        scheduledForMs:
          execution.scheduledForMs,
        executedAtMs,
        jobExecution: execution.jobExecution,
      });
      if (
        result &&
        typeof result.then === "function"
      ) {
        failState("writer_must_be_synchronous");
      }
      return requireTerminal(result, execution);
    },
  });
}

module.exports = {
  CANDIDATE_ELIGIBILITY_REVALIDATION_SERVICE_CODES,
  CandidateEligibilityRevalidationServiceError,
  createCandidateEligibilityRevalidationService,
};
