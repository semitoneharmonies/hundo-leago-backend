"use strict";

const {
  UUID_PATTERN,
  buildFreeAgentDraftAllocationOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const CANDIDATE_ALLOCATION_SERVICE_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_CANDIDATE_ALLOCATION_INPUT_INVALID",
    stateInvalid:
      "FAD_CANDIDATE_ALLOCATION_STATE_INVALID",
  });
const INPUT_FIELDS = Object.freeze([
  "allocationId",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "playerId",
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
const ALLOCATION_FIELDS = Object.freeze([
  "accountedAtMs",
  "contractId",
  "createdAtMs",
  "decisionCode",
  "fadId",
  "fallbackOpenAuctionId",
  "id",
  "lastErrorCode",
  "leagueId",
  "ownershipId",
  "playerId",
  "restrictedAuctionId",
  "restrictedMinimum",
  "seasonId",
  "status",
  "updatedAtMs",
  "version",
  "winningSnapshotEntryId",
  "winningTeamId",
]);
const TERMINAL_FIELDS = Object.freeze([
  "accountedAtMs",
  "allocationId",
  "allocationVersion",
  "decisionCode",
  "evidence",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "replayed",
  "restrictedAuction",
  "seasonId",
  "status",
  "winner",
]);
const CORRECTION_TERMINAL_FIELDS =
  Object.freeze([
    ...TERMINAL_FIELDS,
    "recovery",
  ]);
const FIRST_EXECUTION_STATUS = "pending";
const REPLAYABLE_TERMINAL_STATUSES =
  Object.freeze(
    new Set([
      "automatic_award",
      "correction_required",
      "no_valid_offer",
      "restricted_active",
      "restricted_scheduled",
    ])
  );
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class CandidateAllocationServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Candidate allocation could not be executed."
    );
    this.name = "CandidateAllocationServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new CandidateAllocationServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    CANDIDATE_ALLOCATION_SERVICE_CODES
      .inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    CANDIDATE_ALLOCATION_SERVICE_CODES
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
  const playerId = canonicalId(
    input.playerId,
    "player_id_invalid"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "occurrence_key_invalid"
  );
  let canonicalOccurrenceKey;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftAllocationOccurrenceKey({
        fadId,
        playerId,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (occurrenceKey !== canonicalOccurrenceKey) {
    failInput("occurrence_scope_invalid");
  }
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "scheduled_timestamp_invalid"
  );
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
    allocationId: canonicalId(
      input.allocationId,
      "allocation_id_invalid"
    ),
    playerId,
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

function requireAllocation(
  allocation,
  execution,
  executedAtMs
) {
  if (
    !hasExactFields(allocation, ALLOCATION_FIELDS) ||
    allocation.id !== execution.allocationId ||
    allocation.leagueId !== execution.leagueId ||
    allocation.seasonId !== execution.seasonId ||
    allocation.fadId !== execution.fadId ||
    allocation.playerId !== execution.playerId ||
    !Number.isSafeInteger(allocation.version) ||
    allocation.version < 1 ||
    !safeStateTimestamp(allocation.createdAtMs) ||
    !safeStateTimestamp(allocation.updatedAtMs) ||
    allocation.updatedAtMs < allocation.createdAtMs ||
    allocation.updatedAtMs > executedAtMs
  ) {
    failState("allocation_state_invalid");
  }
  if (allocation.status === FIRST_EXECUTION_STATUS) {
    return Object.freeze({
      expectedAllocationVersion: allocation.version,
      replayExpected: false,
    });
  }
  if (
    REPLAYABLE_TERMINAL_STATUSES.has(
      allocation.status
    ) &&
    allocation.version > 1
  ) {
    return Object.freeze({
      expectedAllocationVersion:
        allocation.version - 1,
      replayExpected: true,
    });
  }
  failState("allocation_not_pending_or_replayable");
}

function requireTerminal(
  result,
  execution,
  allocationExpectation,
  executedAtMs
) {
  const expectedFields =
    result?.status === "correction_required"
      ? CORRECTION_TERMINAL_FIELDS
      : TERMINAL_FIELDS;
  if (
    !hasExactFields(result, expectedFields) ||
    !REPLAYABLE_TERMINAL_STATUSES.has(
      result.status
    ) ||
    result.leagueId !== execution.leagueId ||
    result.seasonId !== execution.seasonId ||
    result.fadId !== execution.fadId ||
    result.allocationId !==
      execution.allocationId ||
    result.playerId !== execution.playerId ||
    result.occurrenceKey !==
      execution.occurrenceKey ||
    result.jobRunId !==
      execution.jobExecution.runId ||
    result.jobRunVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    result.allocationVersion !==
      allocationExpectation
        .expectedAllocationVersion + 1 ||
    typeof result.replayed !== "boolean" ||
    (
      allocationExpectation.replayExpected &&
      result.replayed !== true
    ) ||
    !isPlainObject(result.evidence)
  ) {
    failState("terminal_result_invalid");
  }
  if (
    result.status === "correction_required"
  ) {
    if (
      result.accountedAtMs !== null ||
      result.decisionCode !== null ||
      result.winner !== null ||
      result.restrictedAuction !== null ||
      !isPlainObject(result.recovery)
    ) {
      failState("terminal_result_invalid");
    }
  } else if (
    !safeStateTimestamp(result.accountedAtMs) &&
    ![
      "restricted_active",
      "restricted_scheduled",
    ].includes(result.status)
  ) {
    failState("terminal_result_invalid");
  }
  if (
    safeStateTimestamp(result.accountedAtMs) &&
    result.accountedAtMs > executedAtMs
  ) {
    failState("terminal_result_invalid");
  }
  return result;
}

function createCandidateAllocationService({
  repository,
  clock,
} = {}) {
  if (
    !repository ||
    typeof repository.findAllocation !==
      "function" ||
    typeof repository.resolvePending !==
      "function"
  ) {
    throw new TypeError(
      "Candidate allocation requires its durable repository"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "Candidate allocation requires a UTC clock"
    );
  }

  return Object.freeze({
    executeClaimedAllocation(input = {}) {
      const execution = normalizeExecution(input);
      const allocation = repository.findAllocation({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        allocationId: execution.allocationId,
        playerId: execution.playerId,
      });
      if (
        allocation &&
        typeof allocation.then === "function"
      ) {
        failState("repository_must_be_synchronous");
      }
      const executedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(executedAtMs) ||
        executedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (executedAtMs < execution.scheduledForMs) {
        failState("allocation_not_due");
      }
      if (
        executedAtMs >=
        execution.jobExecution.leaseExpiresAtMs
      ) {
        failState("claimed_lease_expired");
      }
      const allocationExpectation =
        requireAllocation(
          allocation,
          execution,
          executedAtMs
        );
      const result = repository.resolvePending({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        allocationId: execution.allocationId,
        playerId: execution.playerId,
        expectedAllocationVersion:
          allocationExpectation
            .expectedAllocationVersion,
        jobRunId:
          execution.jobExecution.runId,
        expectedJobVersion:
          execution.jobExecution.expectedVersion,
        leaseOwner:
          execution.jobExecution.leaseOwner,
        leaseToken:
          execution.jobExecution.leaseToken,
        nowMs: executedAtMs,
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
        allocationExpectation,
        executedAtMs
      );
    },
  });
}

module.exports = {
  CANDIDATE_ALLOCATION_SERVICE_CODES,
  CandidateAllocationServiceError,
  createCandidateAllocationService,
};
