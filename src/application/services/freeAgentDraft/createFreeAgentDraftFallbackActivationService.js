"use strict";

const {
  UUID_PATTERN,
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_SERVICE_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_FALLBACK_ACTIVATION_INPUT_INVALID",
    stateInvalid:
      "FAD_FALLBACK_ACTIVATION_STATE_INVALID",
  });
const INPUT_FIELDS = Object.freeze([
  "activationAtMs",
  "allocationId",
  "auctionId",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "rolloverId",
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
const ACTIVATION_FIELDS = Object.freeze([
  "activationAtMs",
  "activationJobRunId",
  "activationOccurrenceKey",
  "allocationId",
  "allocationVersion",
  "auctionId",
  "fadId",
  "jobRunVersion",
  "jobStatus",
  "leagueId",
  "playerId",
  "resolvesAtMs",
  "rolloverId",
  "seasonId",
  "sourceAuctionId",
  "status",
]);
const TERMINAL_FIELDS = Object.freeze([
  "activatedAtMs",
  "activationAtMs",
  "allocationId",
  "allocationVersion",
  "auctionId",
  "evidence",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "playerId",
  "replayed",
  "rolloverId",
  "seasonId",
  "sourceAuctionId",
  "sourceRecoveryId",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "activityId",
  "notificationIds",
  "outboxEventIds",
  "sourceResolutionId",
  "stateEventId",
]);
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class FreeAgentDraftFallbackActivationServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The fallback Free Agent Draft auction could not be activated."
    );
    this.name =
      "FreeAgentDraftFallbackActivationServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftFallbackActivationServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_SERVICE_CODES
      .inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_SERVICE_CODES
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

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (field, index) => field === expected[index]
    )
  );
}

function exactInput(value, fields, reasonCode) {
  if (!hasExactFields(value, fields)) {
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
  exactInput(
    input,
    INPUT_FIELDS,
    "execution_fields_invalid"
  );
  exactInput(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "job_execution_fields_invalid"
  );
  const fadId = canonicalId(
    input.fadId,
    "fad_id_invalid"
  );
  const allocationId = canonicalId(
    input.allocationId,
    "allocation_id_invalid"
  );
  const activationAtMs = safeTimestamp(
    input.activationAtMs,
    "activation_timestamp_invalid"
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
      buildFreeAgentDraftFallbackActivationOccurrenceKey(
        {
          fadId,
          allocationId,
          activationAtMs,
        }
      );
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== activationAtMs
  ) {
    failInput("occurrence_scope_invalid");
  }
  const startedAtMs = safeTimestamp(
    input.jobExecution.startedAtMs,
    "started_timestamp_invalid"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "lease_expiry_invalid"
  );
  if (
    startedAtMs < scheduledForMs ||
    leaseExpiresAtMs <= startedAtMs
  ) {
    failInput("job_execution_chronology_invalid");
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
    allocationId,
    playerId: canonicalId(
      input.playerId,
      "player_id_invalid"
    ),
    auctionId: canonicalId(
      input.auctionId,
      "auction_id_invalid"
    ),
    rolloverId: canonicalId(
      input.rolloverId,
      "rollover_id_invalid"
    ),
    activationAtMs,
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
      leaseExpiresAtMs,
      startedAtMs,
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

function safeStateTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireActivation(
  activation,
  execution
) {
  if (
    !hasExactFields(activation, ACTIVATION_FIELDS) ||
    activation.leagueId !== execution.leagueId ||
    activation.seasonId !== execution.seasonId ||
    activation.fadId !== execution.fadId ||
    activation.allocationId !==
      execution.allocationId ||
    activation.playerId !== execution.playerId ||
    activation.auctionId !== execution.auctionId ||
    activation.rolloverId !== execution.rolloverId ||
    activation.activationAtMs !==
      execution.activationAtMs ||
    activation.activationJobRunId !==
      execution.jobExecution.runId ||
    activation.activationOccurrenceKey !==
      execution.occurrenceKey ||
    !UUID_PATTERN.test(
      activation.sourceAuctionId || ""
    ) ||
    activation.sourceAuctionId ===
      activation.auctionId ||
    activation.status !==
      "restricted_fallback_open" ||
    activation.activationAtMs >
      Number.MAX_SAFE_INTEGER -
        FALLBACK_WINDOW_MS ||
    activation.resolvesAtMs !==
      activation.activationAtMs +
        FALLBACK_WINDOW_MS ||
    !Number.isSafeInteger(
      activation.allocationVersion
    ) ||
    activation.allocationVersion < 1 ||
    !Number.isSafeInteger(activation.jobRunVersion) ||
    activation.jobRunVersion < 1
  ) {
    failState("activation_state_invalid");
  }
  if (
    activation.jobStatus === "running" &&
    activation.jobRunVersion ===
      execution.jobExecution.expectedVersion
  ) {
    return Object.freeze({
      expectedAllocationVersion:
        activation.allocationVersion,
      expectedJobVersion:
        activation.jobRunVersion,
      sourceAuctionId:
        activation.sourceAuctionId,
      replayExpected: false,
    });
  }
  if (
    activation.jobStatus === "succeeded" &&
    activation.jobRunVersion > 1 &&
    activation.jobRunVersion - 1 ===
      execution.jobExecution.expectedVersion
  ) {
    return Object.freeze({
      expectedAllocationVersion:
        activation.allocationVersion,
      expectedJobVersion:
        activation.jobRunVersion - 1,
      sourceAuctionId:
        activation.sourceAuctionId,
      replayExpected: true,
    });
  }
  failState("activation_not_claimed_or_replayable");
}

function canonicalIdArray(value, exactLength = null) {
  return (
    Array.isArray(value) &&
    (
      exactLength === null ||
      value.length === exactLength
    ) &&
    value.every(
      (id) => UUID_PATTERN.test(id || "")
    ) &&
    new Set(value).size === value.length
  );
}

function requireTerminal(
  result,
  execution,
  expectation,
  activatedAtMs
) {
  const evidence = result?.evidence;
  if (
    !hasExactFields(result, TERMINAL_FIELDS) ||
    result.outcome !== "succeeded" ||
    result.leagueId !== execution.leagueId ||
    result.seasonId !== execution.seasonId ||
    result.fadId !== execution.fadId ||
    result.allocationId !== execution.allocationId ||
    result.playerId !== execution.playerId ||
    result.sourceAuctionId !==
      expectation.sourceAuctionId ||
    result.auctionId !== execution.auctionId ||
    result.rolloverId !== execution.rolloverId ||
    result.activationAtMs !==
      execution.activationAtMs ||
    !safeStateTimestamp(result.activatedAtMs) ||
    result.activatedAtMs <
      execution.activationAtMs ||
    result.activatedAtMs >=
      execution.activationAtMs +
        FALLBACK_WINDOW_MS ||
    result.activatedAtMs > activatedAtMs ||
    (
      !expectation.replayExpected &&
      result.activatedAtMs !== activatedAtMs
    ) ||
    result.allocationVersion !==
      expectation.expectedAllocationVersion ||
    result.jobRunId !==
      execution.jobExecution.runId ||
    result.jobRunVersion !==
      expectation.expectedJobVersion + 1 ||
    typeof result.replayed !== "boolean" ||
    (
      expectation.replayExpected &&
      result.replayed !== true
    ) ||
    (
      result.sourceRecoveryId !== null &&
      !UUID_PATTERN.test(
        result.sourceRecoveryId || ""
      )
    ) ||
    !hasExactFields(evidence, EVIDENCE_FIELDS) ||
    !UUID_PATTERN.test(
      evidence.sourceResolutionId || ""
    ) ||
    !UUID_PATTERN.test(evidence.stateEventId || "") ||
    !UUID_PATTERN.test(evidence.activityId || "") ||
    !canonicalIdArray(evidence.notificationIds) ||
    !canonicalIdArray(evidence.outboxEventIds, 2)
  ) {
    failState("terminal_result_invalid");
  }
  return Object.freeze({
    ...result,
    evidence: Object.freeze({
      ...evidence,
      notificationIds: Object.freeze([
        ...evidence.notificationIds,
      ]),
      outboxEventIds: Object.freeze([
        ...evidence.outboxEventIds,
      ]),
    }),
  });
}

function createFreeAgentDraftFallbackActivationService({
  repository,
  clock,
} = {}) {
  if (
    !repository ||
    typeof repository.findActivation !== "function" ||
    typeof repository.executeClaimed !== "function"
  ) {
    throw new TypeError(
      "FAD fallback activation requires its durable repository"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "FAD fallback activation requires a UTC clock"
    );
  }

  return Object.freeze({
    executeClaimedActivation(input = {}) {
      const execution = normalizeExecution(input);
      const activation = repository.findActivation({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        allocationId: execution.allocationId,
        activationAtMs: execution.activationAtMs,
      });
      if (
        activation &&
        typeof activation.then === "function"
      ) {
        failState("repository_must_be_synchronous");
      }
      const activatedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(activatedAtMs) ||
        activatedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (activatedAtMs < execution.activationAtMs) {
        failState("activation_not_due");
      }
      const expectation = requireActivation(
        activation,
        execution
      );
      if (
        !expectation.replayExpected &&
        (
          activatedAtMs <
            execution.jobExecution.startedAtMs ||
          activatedAtMs >=
            execution.jobExecution.leaseExpiresAtMs
        )
      ) {
        failState("claimed_lease_expired");
      }
      if (
        !expectation.replayExpected &&
        activatedAtMs >= activation.resolvesAtMs
      ) {
        failState("activation_window_closed");
      }
      const result = repository.executeClaimed({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        allocationId: execution.allocationId,
        playerId: execution.playerId,
        sourceAuctionId:
          expectation.sourceAuctionId,
        auctionId: execution.auctionId,
        rolloverId: execution.rolloverId,
        activationAtMs: execution.activationAtMs,
        occurrenceKey: execution.occurrenceKey,
        expectedAllocationVersion:
          expectation.expectedAllocationVersion,
        activatedAtMs,
        jobExecution: {
          runId: execution.jobExecution.runId,
          expectedVersion:
            expectation.expectedJobVersion,
          leaseOwner:
            execution.jobExecution.leaseOwner,
          leaseToken:
            execution.jobExecution.leaseToken,
          leaseExpiresAtMs:
            execution.jobExecution.leaseExpiresAtMs,
        },
      });
      if (
        result &&
        typeof result.then === "function"
      ) {
        failState("repository_must_be_synchronous");
      }
      return requireTerminal(
        result,
        execution,
        expectation,
        activatedAtMs
      );
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_SERVICE_CODES,
  FreeAgentDraftFallbackActivationServiceError,
  createFreeAgentDraftFallbackActivationService,
};
