const {
  UUID_PATTERN,
  buildFreeAgentDraftDeadlineOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const FREE_AGENT_DRAFT_DEADLINE_SERVICE_CODES =
  Object.freeze({
    inputInvalid: "FAD_DEADLINE_INPUT_INVALID",
    stateInvalid: "FAD_DEADLINE_STATE_INVALID",
  });
const INPUT_FIELDS = Object.freeze([
  "deadlineAtMs",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "scheduledForMs",
  "seasonId",
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
  "activityId",
  "allocationCount",
  "cardCount",
  "completedAtMs",
  "fadVersion",
  "jobVersion",
  "notificationIds",
  "outboxEventIds",
  "outcome",
  "replayed",
  "runId",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class FreeAgentDraftDeadlineServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft deadline could not be executed."
    );
    this.name = "FreeAgentDraftDeadlineServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftDeadlineServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_DEADLINE_SERVICE_CODES
      .inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_DEADLINE_SERVICE_CODES
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
  const deadlineAtMs = safeTimestamp(
    input.deadlineAtMs,
    "deadline_timestamp_invalid"
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
      buildFreeAgentDraftDeadlineOccurrenceKey({
        fadId,
        deadlineAtMs,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== deadlineAtMs
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
    deadlineAtMs,
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

function requireTerminal(result, execution) {
  if (
    !isPlainObject(result) ||
    Object.keys(result).sort().join("|") !==
      [...TERMINAL_FIELDS].sort().join("|") ||
    result.outcome !== "succeeded" ||
    typeof result.replayed !== "boolean" ||
    result.runId !== execution.jobExecution.runId ||
    !Number.isSafeInteger(result.completedAtMs) ||
    result.completedAtMs < execution.deadlineAtMs ||
    result.completedAtMs >=
      execution.jobExecution.leaseExpiresAtMs ||
    result.jobVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !Number.isSafeInteger(result.fadVersion) ||
    result.fadVersion < 1 ||
    !Number.isSafeInteger(result.cardCount) ||
    result.cardCount < 1 ||
    !Number.isSafeInteger(result.allocationCount) ||
    result.allocationCount < 0 ||
    !UUID_PATTERN.test(result.activityId || "") ||
    !Array.isArray(result.notificationIds) ||
    result.notificationIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(result.notificationIds).size !==
      result.notificationIds.length ||
    !Array.isArray(result.outboxEventIds) ||
    result.outboxEventIds.length < 2 ||
    result.outboxEventIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(result.outboxEventIds).size !==
      result.outboxEventIds.length
  ) {
    failState("terminal_result_invalid");
  }
  return Object.freeze({
    ...result,
    notificationIds: Object.freeze([
      ...result.notificationIds,
    ]),
    outboxEventIds: Object.freeze([
      ...result.outboxEventIds,
    ]),
  });
}

function createFreeAgentDraftDeadlineService({
  writer,
  lifecycleRepository,
  clock,
} = {}) {
  if (
    !writer ||
    typeof writer.executeClaimed !== "function"
  ) {
    throw new TypeError(
      "FAD deadline execution requires its atomic writer"
    );
  }
  if (
    !lifecycleRepository ||
    typeof lifecycleRepository.advanceStatus !==
      "function"
  ) {
    throw new TypeError(
      "FAD deadline execution requires the lifecycle repository"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "FAD deadline execution requires a UTC clock"
    );
  }

  return Object.freeze({
    executeClaimedDeadline(input = {}) {
      const execution = normalizeExecution(input);
      const executedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(executedAtMs) ||
        executedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (executedAtMs < execution.deadlineAtMs) {
        failState("deadline_not_due");
      }
      if (
        executedAtMs >=
        execution.jobExecution.leaseExpiresAtMs
      ) {
        failState("claimed_lease_expired");
      }
      const result = writer.executeClaimed(
        {
          leagueId: execution.leagueId,
          seasonId: execution.seasonId,
          fadId: execution.fadId,
          deadlineAtMs: execution.deadlineAtMs,
          occurrenceKey: execution.occurrenceKey,
          scheduledForMs:
            execution.scheduledForMs,
          executedAtMs,
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
  });
}

module.exports = {
  FREE_AGENT_DRAFT_DEADLINE_SERVICE_CODES,
  FreeAgentDraftDeadlineServiceError,
  createFreeAgentDraftDeadlineService,
};
