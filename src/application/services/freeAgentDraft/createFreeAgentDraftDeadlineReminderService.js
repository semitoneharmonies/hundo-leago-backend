const {
  UUID_PATTERN,
  buildFreeAgentDraftReminderOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_DEADLINE_REMINDER_INPUT_INVALID",
    stateInvalid:
      "FAD_DEADLINE_REMINDER_STATE_INVALID",
  });
const INPUT_FIELDS = Object.freeze([
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "reminderAtMs",
  "scheduledForMs",
  "seasonId",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
]);
const TERMINAL_FIELDS = Object.freeze([
  "completedAtMs",
  "jobVersion",
  "notificationIds",
  "outboxEventId",
  "outcome",
  "reasonCode",
  "runId",
  "sentCount",
  "skippedCount",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SKIP_REASON_CODES = Object.freeze(
  new Set([
    "cards_locked",
    "deadline_reached",
    "fad_completed",
  ])
);

class FreeAgentDraftDeadlineReminderServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft deadline reminder could not be executed."
    );
    this.name =
      "FreeAgentDraftDeadlineReminderServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftDeadlineReminderServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES
      .inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES
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
  const reminderAtMs = safeTimestamp(
    input.reminderAtMs,
    "reminder_timestamp_invalid"
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
      buildFreeAgentDraftReminderOccurrenceKey({
        fadId,
        reminderAtMs,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== reminderAtMs
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
    reminderAtMs,
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
    !["succeeded", "skipped"].includes(
      result.outcome
    ) ||
    result.runId !==
      execution.jobExecution.runId ||
    !Number.isSafeInteger(result.completedAtMs) ||
    result.completedAtMs < 0 ||
    result.completedAtMs >=
      execution.jobExecution.leaseExpiresAtMs ||
    result.jobVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !Number.isSafeInteger(result.sentCount) ||
    result.sentCount < 0 ||
    !Number.isSafeInteger(result.skippedCount) ||
    result.skippedCount < 0 ||
    !Array.isArray(result.notificationIds) ||
    result.notificationIds.length !==
      result.sentCount ||
    result.notificationIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(result.notificationIds).size !==
      result.notificationIds.length ||
    !(
      result.outboxEventId === null ||
      UUID_PATTERN.test(
        result.outboxEventId || ""
      )
    ) ||
    (
      result.outcome === "succeeded" &&
      (
        result.reasonCode !== null ||
        (
          result.sentCount === 0 &&
          result.outboxEventId !== null
        ) ||
        (
          result.sentCount > 0 &&
          result.outboxEventId === null
        )
      )
    ) ||
    (
      result.outcome === "skipped" &&
      (
        !SKIP_REASON_CODES.has(
          result.reasonCode
        ) ||
        result.sentCount !== 0 ||
        result.notificationIds.length !== 0 ||
        result.outboxEventId !== null
      )
    )
  ) {
    failState("terminal_result_invalid");
  }
  return Object.freeze({
    ...result,
    notificationIds: Object.freeze([
      ...result.notificationIds,
    ]),
  });
}

function createFreeAgentDraftDeadlineReminderService({
  writer,
  clock,
} = {}) {
  if (
    !writer ||
    typeof writer.executeClaimed !== "function"
  ) {
    throw new TypeError(
      "FAD deadline reminders require an execution writer"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "FAD deadline reminders require a UTC clock"
    );
  }

  return Object.freeze({
    executeClaimedReminder(input = {}) {
      const execution = normalizeExecution(input);
      const executedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(executedAtMs) ||
        executedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (
        executedAtMs < execution.scheduledForMs
      ) {
        failState("reminder_not_due");
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
        reminderAtMs: execution.reminderAtMs,
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
  FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES,
  FreeAgentDraftDeadlineReminderServiceError,
  createFreeAgentDraftDeadlineReminderService,
};
