"use strict";

const {
  UUID_PATTERN,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftRolloverFinalizationPolicy"
);

const SERVICE_CODES = Object.freeze({
  inputInvalid: "FAD_ROLLOVER_FINALIZATION_INPUT_INVALID",
  stateInvalid: "FAD_ROLLOVER_FINALIZATION_STATE_INVALID",
});
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INPUT_FIELDS = Object.freeze([
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "rolloverAtMs",
  "rolloverId",
  "scheduledForMs",
  "seasonId",
  "sequence",
]);
const FAILURE_INPUT_FIELDS = Object.freeze([
  ...INPUT_FIELDS,
  "reasonCode",
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
const IDENTITY_FIELDS = Object.freeze([
  "fadId",
  "leagueId",
  "occurrenceKey",
  "rolloverAtMs",
  "rolloverId",
  "seasonId",
  "sequence",
]);
const LIVE_FIELDS = Object.freeze([
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "jobStatus",
  "leagueId",
  "occurrenceKey",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "rolloverVersion",
  "seasonId",
  "sequence",
  "sourceRecoveryId",
  "sourceRecoveryStatus",
  "sourceRecoveryVersion",
  "status",
]);
const DECISION_FIELDS = Object.freeze([
  "evidence",
  "fadId",
  "outcome",
  "reasonCode",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "sequence",
]);
const POLICY_EVIDENCE_FIELDS = Object.freeze([
  "auctionCount",
  "createdFallbackCount",
  "nominationCount",
  "normalAuctionCount",
  "recoverableAuctionCount",
  "recoverableUnresolvedCount",
  "requiredFallbackCount",
  "terminalNominationCount",
  "unresolvedCount",
]);
const COMPLETED_FIELDS = Object.freeze([
  "evidence",
  "fadId",
  "finalizedAtMs",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "rolloverVersion",
  "seasonId",
  "sequence",
  "sourceRecoveryId",
]);
const COMPLETED_EVIDENCE_FIELDS = Object.freeze([
  ...POLICY_EVIDENCE_FIELDS,
  "reasonCode",
]);
const FAILURE_FIELDS = Object.freeze([
  "extensionJobRunId",
  "extensionRolloverId",
  "fadId",
  "failedAtMs",
  "failureCode",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "recoveryId",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "rolloverVersion",
  "seasonId",
  "sequence",
]);

class FreeAgentDraftRolloverServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft rollover could not be finalized."
    );
    this.name = "FreeAgentDraftRolloverServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftRolloverServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(SERVICE_CODES.inputInvalid, reasonCode);
}

function failState(reasonCode) {
  fail(SERVICE_CODES.stateInvalid, reasonCode);
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
  if (!hasExactFields(value, fields)) failInput(reasonCode);
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

function boundedText(value, maximumLength, reasonCode) {
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
  if (!Number.isSafeInteger(value) || value < 0) {
    failInput(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failInput(reasonCode);
  }
  return value;
}

function normalizeExecution(input, { failure }) {
  exactInput(
    input,
    failure ? FAILURE_INPUT_FIELDS : INPUT_FIELDS,
    failure
      ? "failure_fields_invalid"
      : "execution_fields_invalid"
  );
  exactInput(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "job_execution_fields_invalid"
  );
  const fadId = canonicalId(input.fadId, "fad_id_invalid");
  const sequence = positiveInteger(
    input.sequence,
    "rollover_sequence_invalid"
  );
  const rolloverAtMs = safeTimestamp(
    input.rolloverAtMs,
    "rollover_timestamp_invalid"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "scheduled_timestamp_invalid"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    500,
    "occurrence_key_invalid"
  );
  let canonicalOccurrenceKey;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftRolloverOccurrenceKey({
        fadId,
        sequence,
        rolloverAtMs,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== rolloverAtMs
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
  const execution = {
    leagueId: canonicalId(
      input.leagueId,
      "league_id_invalid"
    ),
    seasonId: canonicalId(
      input.seasonId,
      "season_id_invalid"
    ),
    fadId,
    rolloverId: canonicalId(
      input.rolloverId,
      "rollover_id_invalid"
    ),
    sequence,
    rolloverAtMs,
    occurrenceKey,
    scheduledForMs,
    jobExecution: Object.freeze({
      runId: canonicalId(
        input.jobExecution.runId,
        "job_run_id_invalid"
      ),
      expectedVersion: positiveInteger(
        input.jobExecution.expectedVersion,
        "job_version_invalid"
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
    }),
  };
  if (failure) {
    if (input.reasonCode !== "boundary_recovery_required") {
      failInput("failure_reason_invalid");
    }
    execution.reasonCode = input.reasonCode;
  }
  return Object.freeze(execution);
}

function identityFor(execution) {
  return Object.freeze(
    Object.fromEntries(
      IDENTITY_FIELDS.map((field) => [
        field,
        execution[field],
      ])
    )
  );
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function requireEvidence(value, fields) {
  if (
    !hasExactFields(value, fields) ||
    !fields.every((field) =>
      field === "reasonCode" ||
      (
        Number.isSafeInteger(value[field]) &&
        value[field] >= 0
      )
    ) ||
    value.normalAuctionCount > value.auctionCount ||
    value.recoverableAuctionCount > value.auctionCount ||
    value.normalAuctionCount + value.recoverableAuctionCount >
      value.auctionCount ||
    value.terminalNominationCount > value.nominationCount ||
    value.createdFallbackCount > value.requiredFallbackCount ||
    value.recoverableUnresolvedCount > value.unresolvedCount
  ) {
    failState("finalization_evidence_invalid");
  }
  return value;
}

function requireDecision(result, execution) {
  const expectedReason = {
    awaiting_data: "boundary_work_pending",
    recovery_required: "boundary_recovery_required",
  }[result?.outcome];
  const evidence = result?.evidence;
  if (
    !hasExactFields(result, DECISION_FIELDS) ||
    !expectedReason ||
    result.reasonCode !== expectedReason ||
    result.replayed !== false ||
    result.rolloverId !== execution.rolloverId ||
    result.fadId !== execution.fadId ||
    result.sequence !== execution.sequence ||
    result.rolloverAtMs !== execution.rolloverAtMs
  ) {
    failState("decision_result_invalid");
  }
  requireEvidence(evidence, POLICY_EVIDENCE_FIELDS);
  if (
    evidence.unresolvedCount < 1 ||
    (
      result.outcome === "recovery_required"
        ? evidence.unresolvedCount !==
          evidence.recoverableUnresolvedCount
        : evidence.unresolvedCount <=
          evidence.recoverableUnresolvedCount
    )
  ) {
    failState("decision_result_invalid");
  }
  return deepFreeze({ ...result });
}

function nullableCanonicalId(value) {
  return value === null || UUID_PATTERN.test(value || "");
}

function terminalDelta(sourceRecoveryId) {
  return sourceRecoveryId === null ? 2 : 1;
}

function requireCompleted(
  result,
  execution,
  {
    replayed,
    observedAtMs,
    expectedRolloverVersion = null,
    sourceRecoveryId = undefined,
  }
) {
  const evidence = result?.evidence;
  const delta = terminalDelta(result?.sourceRecoveryId);
  if (
    !hasExactFields(result, COMPLETED_FIELDS) ||
    result.outcome !== "completed" ||
    result.replayed !== replayed ||
    result.leagueId !== execution.leagueId ||
    result.seasonId !== execution.seasonId ||
    result.fadId !== execution.fadId ||
    result.rolloverId !== execution.rolloverId ||
    result.sequence !== execution.sequence ||
    result.rolloverAtMs !== execution.rolloverAtMs ||
    !Number.isSafeInteger(result.finalizedAtMs) ||
    result.finalizedAtMs < execution.rolloverAtMs ||
    result.finalizedAtMs < execution.jobExecution.startedAtMs ||
    result.finalizedAtMs >=
      execution.jobExecution.leaseExpiresAtMs ||
    result.finalizedAtMs > observedAtMs ||
    (!replayed && result.finalizedAtMs !== observedAtMs) ||
    !Number.isSafeInteger(result.rolloverVersion) ||
    result.rolloverVersion <= delta ||
    (
      expectedRolloverVersion !== null &&
      result.rolloverVersion !==
        expectedRolloverVersion + delta
    ) ||
    result.jobRunId !== execution.jobExecution.runId ||
    result.jobRunVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !nullableCanonicalId(result.sourceRecoveryId) ||
    (
      sourceRecoveryId !== undefined &&
      result.sourceRecoveryId !== sourceRecoveryId
    )
  ) {
    failState("terminal_result_invalid");
  }
  requireEvidence(evidence, COMPLETED_EVIDENCE_FIELDS);
  if (
    evidence.reasonCode !== "boundary_accounted" ||
    evidence.unresolvedCount !== 0 ||
    evidence.recoverableUnresolvedCount !== 0 ||
    evidence.normalAuctionCount !== evidence.auctionCount ||
    evidence.terminalNominationCount !== evidence.nominationCount ||
    evidence.createdFallbackCount !== evidence.requiredFallbackCount
  ) {
    failState("terminal_result_invalid");
  }
  return deepFreeze({ ...result });
}

function requireFailure(
  result,
  execution,
  {
    replayed,
    observedAtMs,
    expectedRolloverVersion = null,
    rolloverDelta = null,
  }
) {
  if (
    !hasExactFields(result, FAILURE_FIELDS) ||
    result.outcome !== "failure_recorded" ||
    result.replayed !== replayed ||
    result.leagueId !== execution.leagueId ||
    result.seasonId !== execution.seasonId ||
    result.fadId !== execution.fadId ||
    result.rolloverId !== execution.rolloverId ||
    result.sequence !== execution.sequence ||
    result.rolloverAtMs !== execution.rolloverAtMs ||
    !Number.isSafeInteger(result.failedAtMs) ||
    result.failedAtMs < execution.rolloverAtMs ||
    result.failedAtMs < execution.jobExecution.startedAtMs ||
    result.failedAtMs >= execution.jobExecution.leaseExpiresAtMs ||
    result.failedAtMs > observedAtMs ||
    (!replayed && result.failedAtMs !== observedAtMs) ||
    !Number.isSafeInteger(result.rolloverVersion) ||
    result.rolloverVersion < 2 ||
    (
      expectedRolloverVersion !== null &&
      result.rolloverVersion !==
        expectedRolloverVersion + rolloverDelta
    ) ||
    result.jobRunId !== execution.jobExecution.runId ||
    result.jobRunVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !UUID_PATTERN.test(result.recoveryId || "") ||
    !nullableCanonicalId(result.extensionRolloverId) ||
    !nullableCanonicalId(result.extensionJobRunId) ||
    (
      (result.extensionRolloverId === null) !==
      (result.extensionJobRunId === null)
    ) ||
    result.failureCode !==
      FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE
  ) {
    failState("failure_result_invalid");
  }
  return deepFreeze({ ...result });
}

function requireLiveProjection(value, execution) {
  const hasRecovery = value?.sourceRecoveryId !== null;
  if (
    !hasExactFields(value, LIVE_FIELDS) ||
    value.leagueId !== execution.leagueId ||
    value.seasonId !== execution.seasonId ||
    value.fadId !== execution.fadId ||
    value.rolloverId !== execution.rolloverId ||
    value.sequence !== execution.sequence ||
    value.rolloverAtMs !== execution.rolloverAtMs ||
    value.occurrenceKey !== execution.occurrenceKey ||
    value.jobRunId !== execution.jobExecution.runId ||
    value.jobStatus !== "running" ||
    value.jobRunVersion !==
      execution.jobExecution.expectedVersion ||
    !Number.isSafeInteger(value.rolloverVersion) ||
    value.rolloverVersion < 1 ||
    value.replayed !== false ||
    !nullableCanonicalId(value.sourceRecoveryId) ||
    (
      hasRecovery
        ? (
            value.sourceRecoveryStatus !== "running" ||
            !Number.isSafeInteger(value.sourceRecoveryVersion) ||
            value.sourceRecoveryVersion < 1
          )
        : (
            value.sourceRecoveryStatus !== null ||
            value.sourceRecoveryVersion !== null
          )
    )
  ) {
    failState("finalization_state_invalid");
  }
  if (
    value.status === "scheduled" &&
    !hasRecovery
  ) {
    return Object.freeze({
      expectedRolloverVersion: value.rolloverVersion,
      expectedTerminalRolloverVersion:
        value.rolloverVersion + 2,
      sourceRecoveryId: null,
      sourceStatus: value.status,
    });
  }
  if (
    value.status === "recovery_required" &&
    hasRecovery &&
    execution.jobExecution.attemptCount >= 2
  ) {
    return Object.freeze({
      expectedRolloverVersion: value.rolloverVersion,
      expectedTerminalRolloverVersion:
        value.rolloverVersion + 1,
      sourceRecoveryId: value.sourceRecoveryId,
      sourceStatus: value.status,
    });
  }
  failState("finalization_not_claimed_or_replayable");
}

function currentClock(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    failState("clock_timestamp_invalid");
  }
  return value;
}

function requireLiveClock(execution, observedAtMs) {
  if (observedAtMs < execution.rolloverAtMs) {
    failState("rollover_not_due");
  }
  if (
    observedAtMs < execution.jobExecution.startedAtMs ||
    observedAtMs >= execution.jobExecution.leaseExpiresAtMs
  ) {
    failState("claimed_lease_expired");
  }
}

function createFreeAgentDraftRolloverService({
  writer,
  clock,
} = {}) {
  if (
    !writer ||
    typeof writer.findFinalization !== "function" ||
    typeof writer.executeClaimed !== "function" ||
    typeof writer.recordFailure !== "function"
  ) {
    throw new TypeError(
      "FAD rollover finalization requires its atomic writer"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "FAD rollover finalization requires a UTC clock"
    );
  }

  function load(execution) {
    const result = writer.findFinalization(
      identityFor(execution)
    );
    if (result && typeof result.then === "function") {
      failState("writer_must_be_synchronous");
    }
    if (result === null) {
      failState("finalization_not_found");
    }
    return result;
  }

  return Object.freeze({
    executeClaimedRollover(input = {}) {
      const execution = normalizeExecution(input, {
        failure: false,
      });
      const projection = load(execution);
      const observedAtMs = currentClock(clock);
      if (projection?.outcome === "completed") {
        return requireCompleted(
          projection,
          execution,
          { replayed: true, observedAtMs }
        );
      }
      if (projection?.outcome === "failure_recorded") {
        failState("failure_already_recorded");
      }
      const expectation = requireLiveProjection(
        projection,
        execution
      );
      requireLiveClock(execution, observedAtMs);
      const result = writer.executeClaimed({
        ...identityFor(execution),
        expectedRolloverVersion:
          expectation.expectedRolloverVersion,
        finalizedAtMs: observedAtMs,
        jobExecution: execution.jobExecution,
      });
      if (result && typeof result.then === "function") {
        failState("writer_must_be_synchronous");
      }
      if (result?.outcome === "completed") {
        return requireCompleted(result, execution, {
          replayed: false,
          observedAtMs,
          expectedRolloverVersion:
            expectation.expectedRolloverVersion,
          sourceRecoveryId:
            expectation.sourceRecoveryId,
        });
      }
      return requireDecision(result, execution);
    },

    recordClaimedFailure(input = {}) {
      const execution = normalizeExecution(input, {
        failure: true,
      });
      const projection = load(execution);
      const observedAtMs = currentClock(clock);
      if (projection?.outcome === "failure_recorded") {
        return requireFailure(
          projection,
          execution,
          { replayed: true, observedAtMs }
        );
      }
      if (projection?.outcome === "completed") {
        failState("finalization_already_completed");
      }
      const expectation = requireLiveProjection(
        projection,
        execution
      );
      requireLiveClock(execution, observedAtMs);
      const result = writer.recordFailure({
        ...identityFor(execution),
        expectedRolloverVersion:
          expectation.expectedRolloverVersion,
        failedAtMs: observedAtMs,
        reasonCode: execution.reasonCode,
        jobExecution: execution.jobExecution,
      });
      if (result && typeof result.then === "function") {
        failState("writer_must_be_synchronous");
      }
      return requireFailure(result, execution, {
        replayed: false,
        observedAtMs,
        expectedRolloverVersion:
          expectation.expectedRolloverVersion,
        rolloverDelta:
          expectation.sourceStatus === "scheduled"
            ? 2
            : 1,
      });
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_ROLLOVER_SERVICE_CODES:
    SERVICE_CODES,
  FreeAgentDraftRolloverServiceError,
  createFreeAgentDraftRolloverService,
};
