"use strict";

const {
  compareUnicodeScalarStrings,
} = require("../leagues/seasonRolloverEvidencePolicy");
const {
  FREE_AGENT_DRAFT_STATUSES,
  FREE_AGENT_DRAFT_VIEWER_PHASES,
  FREE_AGENT_DRAFT_ROLLOVER_STATUSES,
  FREE_AGENT_DRAFT_RECOVERY_STATUSES,
  UUID_PATTERN,
} = require("./freeAgentDraftPolicy");

const MAXIMUM_TIMESTAMP_MS =
  8_640_000_000_000_000;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/;

const FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS =
  Object.freeze([
    "retry_deadline",
    "retry_allocation",
    "activate_restricted",
    "activate_queued_nomination",
    "activate_fallback",
    "retry_auction_resolution",
    "finalize_rollover",
    "complete_fad",
  ]);

const FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_KINDS =
  Object.freeze([
    "deadline",
    "allocation",
    "restricted_activation",
    "queued_nomination_activation",
    "fallback_activation",
    "auction_resolution",
    "completion",
  ]);

const FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_STATUSES =
  Object.freeze([
    "pending",
    "leased",
    "running",
    "succeeded",
    "failed",
  ]);

const FREE_AGENT_DRAFT_RECOVERY_READ_REASON_CODES =
  Object.freeze([
    "NOT_AUTHORIZED",
    "HELP_NOT_GRANTED",
    "PHASE_CLOSED",
    "DEADLINE_PASSED",
    "LEAGUE_FROZEN",
    "SLOT_LOCKED",
    "SLOT_OCCUPIED",
    "ENTRY_NOT_EDITABLE",
    "PLAYER_INELIGIBLE",
    "TEAM_NOT_PARTICIPANT",
    "COOLDOWN_ACTIVE",
    "EDIT_LIMIT_REACHED",
    "PLAYER_QUARANTINED",
    "RECOVERY_NOT_AVAILABLE",
    "PREVIEW_ONLY",
  ]);

const FREE_AGENT_DRAFT_RECOVERY_READ_CODES =
  Object.freeze({
    projectionInvalid:
      "FAD_RECOVERY_READ_PROJECTION_INVALID",
  });

const TOP_LEVEL_KEYS = Object.freeze([
  "fad",
  "deadlineOperation",
  "allocationOperations",
  "rapidOperations",
  "completionOperation",
  "rollovers",
  "recoveries",
  "availableActions",
]);
const FAD_KEYS = Object.freeze([
  "leagueId",
  "seasonId",
  "fadId",
  "version",
  "status",
  "phase",
  "openedAtMs",
  "reminderAtMs",
  "helpOpensAtMs",
  "candidateDeadlineAtMs",
  "deadlineLockedAtMs",
  "allocationCompletedAtMs",
  "nextRolloverAtMs",
  "frozenFadFirstMatchupStartsAtMs",
  "competitionFirstMatchupStartsAtMs",
  "scheduleRecoveryOperationId",
  "completedAtMs",
  "counts",
]);
const COUNT_KEYS = Object.freeze([
  "participatingTeams",
  "cardsLocked",
  "allocationsPending",
  "allocationsAutomatic",
  "restrictedPending",
  "restrictedFallbackPending",
  "rapidAuctionsOpen",
  "queuedNominations",
  "rolloversPersisted",
  "rolloversCompleted",
  "recoveriesOpen",
]);
const OPERATION_KEYS = Object.freeze([
  "operationId",
  "operationKind",
  "resourceId",
  "occurrenceKey",
  "status",
  "attemptCount",
  "scheduledForMs",
  "nextAttemptAtMs",
  "leaseExpiresAtMs",
  "startedAtMs",
  "completedAtMs",
  "lastErrorCode",
  "recoveryId",
  "blocksCompletion",
  "version",
]);
const ROLLOVER_KEYS = Object.freeze([
  "rolloverId",
  "sequence",
  "opensAtMs",
  "creationCutoffAtMs",
  "rollsOverAtMs",
  "status",
  "processingStartedAtMs",
  "completedAtMs",
  "lastErrorCode",
  "recoveryIds",
  "blocksCompletion",
  "version",
]);
const RECOVERY_KEYS = Object.freeze([
  "recoveryId",
  "kind",
  "status",
  "playerId",
  "allocationId",
  "rolloverId",
  "auctionId",
  "jobRunId",
  "nominationQueueId",
  "earliestActivationAtMs",
  "targetResolutionAtMs",
  "lastErrorCode",
  "commissionerReason",
  "createdByOperationId",
  "resolvedByUserId",
  "resolvedByMembershipId",
  "resolvedAuthority",
  "createdAtMs",
  "updatedAtMs",
  "resolvedAtMs",
  "version",
]);
const ACTION_KEYS = Object.freeze([
  "action",
  "resourceId",
  "enabled",
  "reasonCode",
]);
const SCHEDULE_KEYS = Object.freeze([
  "operationId",
  "status",
  "oldWeek1StartsAtMs",
  "newWeek1StartsAtMs",
  "oldScheduleVersion",
  "newScheduleVersion",
  "removedWeekIds",
  "removedMatchupIds",
  "replacedJobs",
  "completedAtMs",
  "version",
]);
const REPLACED_JOB_KEYS = Object.freeze([
  "oldJobId",
  "oldOccurrenceKey",
  "newJobId",
  "newOccurrenceKey",
]);

const ALLOCATION_OPERATION_KINDS = new Set([
  "allocation",
  "restricted_activation",
]);
const RAPID_OPERATION_KINDS = new Set([
  "queued_nomination_activation",
  "fallback_activation",
  "auction_resolution",
]);
const RECOVERY_KINDS = new Set([
  "deadline_retry",
  "allocation_retry",
  "restricted_activation",
  "queued_nomination_activation",
  "fallback_activation",
  "auction_resolution",
  "rollover_finalize",
  "completion",
]);
const RESOLVED_AUTHORITIES = new Set([
  "system",
  "commissioner",
  "platform_administrator_as_commissioner",
]);

class FreeAgentDraftRecoveryReadPolicyError
  extends Error {
  constructor(reasonCode) {
    super(
      "The Free Agent Draft recovery-read projection is invalid."
    );
    this.name =
      "FreeAgentDraftRecoveryReadPolicyError";
    this.code =
      FREE_AGENT_DRAFT_RECOVERY_READ_CODES
        .projectionInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new FreeAgentDraftRecoveryReadPolicyError(
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

function exactObject(value, keys, reasonCode) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(reasonCode);
  }
  const actual = Object.getOwnPropertyNames(value)
    .sort(compareUnicodeScalarStrings);
  const expected = [...keys]
    .sort(compareUnicodeScalarStrings);
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    ) ||
    actual.some((field) => {
      const descriptor =
        Object.getOwnPropertyDescriptor(
          value,
          field
        );
      return !(
        descriptor &&
        descriptor.enumerable === true &&
        Object.prototype.hasOwnProperty.call(
          descriptor,
          "value"
        )
      );
    })
  ) {
    fail(reasonCode);
  }
  return value;
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function nullableStableId(value, reasonCode) {
  return value === null
    ? null
    : stableId(value, reasonCode);
}

function timestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    fail(reasonCode);
  }
  return value;
}

function nullableTimestamp(value, reasonCode) {
  return value === null
    ? null
    : timestamp(value, reasonCode);
}

function nonnegativeInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    fail(reasonCode);
  }
  return value;
}

function safeCode(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !SAFE_CODE_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function nullableCode(value, reasonCode) {
  return value === null
    ? null
    : safeCode(value, reasonCode);
}

function boundedSafeText(value, maximum, reasonCode) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Array.from(value).length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(
      value
    )
  ) {
    fail(reasonCode);
  }
  return value;
}

function nullableSafeText(value, maximum, reasonCode) {
  return value === null
    ? null
    : boundedSafeText(value, maximum, reasonCode);
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

function validateCounts(value) {
  exactObject(value, COUNT_KEYS, "counts_fields_invalid");
  const result = {};
  for (const key of COUNT_KEYS) {
    result[key] = nonnegativeInteger(
      value[key],
      "count_invalid"
    );
  }
  if (
    result.cardsLocked > result.participatingTeams ||
    result.rolloversCompleted > result.rolloversPersisted
  ) {
    fail("counts_inconsistent");
  }
  return result;
}

function validateFad(value) {
  exactObject(value, FAD_KEYS, "fad_fields_invalid");
  const result = {
    leagueId: stableId(
      value.leagueId,
      "fad_league_id_invalid"
    ),
    seasonId: stableId(
      value.seasonId,
      "fad_season_id_invalid"
    ),
    fadId: stableId(value.fadId, "fad_id_invalid"),
    version: positiveInteger(
      value.version,
      "fad_version_invalid"
    ),
    status: value.status,
    phase: value.phase,
    openedAtMs: timestamp(
      value.openedAtMs,
      "fad_opened_at_invalid"
    ),
    reminderAtMs: timestamp(
      value.reminderAtMs,
      "fad_reminder_at_invalid"
    ),
    helpOpensAtMs: timestamp(
      value.helpOpensAtMs,
      "fad_help_opens_at_invalid"
    ),
    candidateDeadlineAtMs: timestamp(
      value.candidateDeadlineAtMs,
      "fad_deadline_at_invalid"
    ),
    deadlineLockedAtMs: nullableTimestamp(
      value.deadlineLockedAtMs,
      "fad_deadline_locked_at_invalid"
    ),
    allocationCompletedAtMs: nullableTimestamp(
      value.allocationCompletedAtMs,
      "fad_allocation_completed_at_invalid"
    ),
    nextRolloverAtMs: nullableTimestamp(
      value.nextRolloverAtMs,
      "fad_next_rollover_at_invalid"
    ),
    frozenFadFirstMatchupStartsAtMs: timestamp(
      value.frozenFadFirstMatchupStartsAtMs,
      "fad_frozen_week_one_invalid"
    ),
    competitionFirstMatchupStartsAtMs: timestamp(
      value.competitionFirstMatchupStartsAtMs,
      "fad_competition_week_one_invalid"
    ),
    scheduleRecoveryOperationId: nullableStableId(
      value.scheduleRecoveryOperationId,
      "fad_schedule_recovery_operation_invalid"
    ),
    completedAtMs: nullableTimestamp(
      value.completedAtMs,
      "fad_completed_at_invalid"
    ),
    counts: validateCounts(value.counts),
  };
  if (
    !FREE_AGENT_DRAFT_STATUSES.includes(result.status) ||
    !FREE_AGENT_DRAFT_VIEWER_PHASES.includes(result.phase) ||
    !(
      result.reminderAtMs < result.candidateDeadlineAtMs &&
      result.helpOpensAtMs < result.candidateDeadlineAtMs &&
      result.candidateDeadlineAtMs <
        result.frozenFadFirstMatchupStartsAtMs
    ) ||
    (
      result.scheduleRecoveryOperationId === null &&
      result.competitionFirstMatchupStartsAtMs !==
        result.frozenFadFirstMatchupStartsAtMs
    ) ||
    (
      result.scheduleRecoveryOperationId !== null &&
      result.competitionFirstMatchupStartsAtMs <=
        result.frozenFadFirstMatchupStartsAtMs
    )
  ) {
    fail("fad_evidence_invalid");
  }
  return result;
}

function validateOperation(value) {
  exactObject(
    value,
    OPERATION_KEYS,
    "operation_fields_invalid"
  );
  const result = {
    operationId: stableId(
      value.operationId,
      "operation_id_invalid"
    ),
    operationKind: value.operationKind,
    resourceId: stableId(
      value.resourceId,
      "operation_resource_id_invalid"
    ),
    occurrenceKey: boundedSafeText(
      value.occurrenceKey,
      500,
      "operation_occurrence_key_invalid"
    ),
    status: value.status,
    attemptCount: nonnegativeInteger(
      value.attemptCount,
      "operation_attempt_count_invalid"
    ),
    scheduledForMs: timestamp(
      value.scheduledForMs,
      "operation_scheduled_for_invalid"
    ),
    nextAttemptAtMs: nullableTimestamp(
      value.nextAttemptAtMs,
      "operation_next_attempt_invalid"
    ),
    leaseExpiresAtMs: nullableTimestamp(
      value.leaseExpiresAtMs,
      "operation_lease_expiry_invalid"
    ),
    startedAtMs: nullableTimestamp(
      value.startedAtMs,
      "operation_started_at_invalid"
    ),
    completedAtMs: nullableTimestamp(
      value.completedAtMs,
      "operation_completed_at_invalid"
    ),
    lastErrorCode: nullableCode(
      value.lastErrorCode,
      "operation_error_code_invalid"
    ),
    recoveryId: nullableStableId(
      value.recoveryId,
      "operation_recovery_id_invalid"
    ),
    blocksCompletion: value.blocksCompletion,
    version: positiveInteger(
      value.version,
      "operation_version_invalid"
    ),
  };
  if (
    !FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_KINDS.includes(
      result.operationKind
    ) ||
    !FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_STATUSES.includes(
      result.status
    ) ||
    typeof result.blocksCompletion !== "boolean" ||
    (
      ["leased", "running"].includes(result.status) !==
      (result.leaseExpiresAtMs !== null)
    ) ||
    (
      ["succeeded", "failed"].includes(result.status) !==
      (result.completedAtMs !== null)
    ) ||
    (
      result.status === "failed" !==
      (result.lastErrorCode !== null)
    ) ||
    (
      result.startedAtMs !== null &&
      result.completedAtMs !== null &&
      result.completedAtMs < result.startedAtMs
    )
  ) {
    fail("operation_state_invalid");
  }
  return result;
}

function compareOperation(left, right) {
  return (
    left.scheduledForMs - right.scheduledForMs ||
    FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_KINDS.indexOf(
      left.operationKind
    ) -
      FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_KINDS.indexOf(
        right.operationKind
      ) ||
    compareUnicodeScalarStrings(
      left.resourceId,
      right.resourceId
    ) ||
    compareUnicodeScalarStrings(
      left.operationId,
      right.operationId
    )
  );
}

function validateOperations(value, allowedKinds, reasonCode) {
  if (!Array.isArray(value)) fail(reasonCode);
  const result = value.map(validateOperation);
  if (
    result.some(
      (operation) =>
        !allowedKinds.has(operation.operationKind)
    ) ||
    result.some(
      (operation, index) =>
        index > 0 &&
        compareOperation(result[index - 1], operation) >= 0
    )
  ) {
    fail(reasonCode);
  }
  return result;
}

function validateRollover(value) {
  exactObject(
    value,
    ROLLOVER_KEYS,
    "rollover_fields_invalid"
  );
  if (!Array.isArray(value.recoveryIds)) {
    fail("rollover_recovery_ids_invalid");
  }
  const recoveryIds = value.recoveryIds.map((id) =>
    stableId(id, "rollover_recovery_id_invalid")
  );
  if (
    new Set(recoveryIds).size !== recoveryIds.length ||
    recoveryIds.some(
      (id, index) =>
        index > 0 && recoveryIds[index - 1] >= id
    )
  ) {
    fail("rollover_recovery_ids_invalid");
  }
  const result = {
    rolloverId: stableId(
      value.rolloverId,
      "rollover_id_invalid"
    ),
    sequence: positiveInteger(
      value.sequence,
      "rollover_sequence_invalid"
    ),
    opensAtMs: timestamp(
      value.opensAtMs,
      "rollover_opens_at_invalid"
    ),
    creationCutoffAtMs: timestamp(
      value.creationCutoffAtMs,
      "rollover_cutoff_at_invalid"
    ),
    rollsOverAtMs: timestamp(
      value.rollsOverAtMs,
      "rollover_at_invalid"
    ),
    status: value.status,
    processingStartedAtMs: nullableTimestamp(
      value.processingStartedAtMs,
      "rollover_processing_started_invalid"
    ),
    completedAtMs: nullableTimestamp(
      value.completedAtMs,
      "rollover_completed_at_invalid"
    ),
    lastErrorCode: nullableCode(
      value.lastErrorCode,
      "rollover_error_code_invalid"
    ),
    recoveryIds,
    blocksCompletion: value.blocksCompletion,
    version: positiveInteger(
      value.version,
      "rollover_version_invalid"
    ),
  };
  if (
    !FREE_AGENT_DRAFT_ROLLOVER_STATUSES.includes(
      result.status
    ) ||
    typeof result.blocksCompletion !== "boolean" ||
    result.opensAtMs >= result.creationCutoffAtMs ||
    result.creationCutoffAtMs >= result.rollsOverAtMs ||
    (
      ["processing", "completed", "recovery_required"].includes(
        result.status
      ) !==
      (result.processingStartedAtMs !== null)
    ) ||
    (
      ["completed", "recovery_required"].includes(
        result.status
      ) !==
      (result.completedAtMs !== null)
    ) ||
    (
      result.status === "recovery_required" !==
      (result.lastErrorCode !== null)
    ) ||
    result.blocksCompletion !==
      (result.status !== "completed")
  ) {
    fail("rollover_state_invalid");
  }
  return result;
}

function validateRollovers(value) {
  if (!Array.isArray(value)) fail("rollovers_invalid");
  const result = value.map(validateRollover);
  if (
    result.length < 7 ||
    result.some(
      (rollover, index) =>
        rollover.sequence !== index + 1
    )
  ) {
    fail("rollover_order_invalid");
  }
  return result;
}

function capabilityForOperation(operation) {
  const actionByKind = {
    deadline: "retry_deadline",
    allocation: "retry_allocation",
    restricted_activation: "activate_restricted",
    queued_nomination_activation:
      "activate_queued_nomination",
    fallback_activation: "activate_fallback",
    auction_resolution: "retry_auction_resolution",
    completion: "complete_fad",
  };
  const action = actionByKind[operation.operationKind];
  return {
    action,
    resourceId: [
      "retry_deadline",
      "complete_fad",
    ].includes(action)
      ? null
      : operation.resourceId,
  };
}

function capabilityForRecovery(recovery) {
  switch (recovery.kind) {
    case "deadline_retry":
      return { action: "retry_deadline", resourceId: null };
    case "allocation_retry":
      return {
        action: "retry_allocation",
        resourceId: recovery.allocationId,
      };
    case "restricted_activation":
      return {
        action: "activate_restricted",
        resourceId: recovery.allocationId,
      };
    case "queued_nomination_activation":
      return {
        action: "activate_queued_nomination",
        resourceId: recovery.nominationQueueId,
      };
    case "fallback_activation":
      return {
        action: "activate_fallback",
        resourceId: recovery.allocationId,
      };
    case "auction_resolution":
      return {
        action: "retry_auction_resolution",
        resourceId: recovery.auctionId,
      };
    case "rollover_finalize":
      return {
        action: "finalize_rollover",
        resourceId: recovery.rolloverId,
      };
    case "completion":
      return { action: "complete_fad", resourceId: null };
    default:
      fail("recovery_capability_invalid");
  }
}

function validateProjectionBindings(result) {
  const operations = [
    result.deadlineOperation,
    ...result.allocationOperations,
    ...result.rapidOperations,
    result.completionOperation,
  ].filter(Boolean);
  const expectedCapabilities = [
    ...operations.map(capabilityForOperation),
    ...result.rollovers.map((rollover) => ({
      action: "finalize_rollover",
      resourceId: rollover.rolloverId,
    })),
  ].sort(compareAction);
  const expectedKeys = expectedCapabilities.map(
    actionResourceKey
  );
  const actionKeys = result.availableActions.map(
    actionResourceKey
  );
  if (
    new Set(expectedKeys).size !== expectedKeys.length ||
    expectedKeys.length !== actionKeys.length ||
    expectedKeys.some(
      (key, index) => key !== actionKeys[index]
    )
  ) {
    fail("available_action_binding_invalid");
  }

  const recoveriesByCapability = new Map();
  for (const recovery of result.recoveries) {
    const capability = capabilityForRecovery(recovery);
    if (
      capability.resourceId === null &&
      !["retry_deadline", "complete_fad"].includes(
        capability.action
      )
    ) {
      fail("recovery_capability_invalid");
    }
    const key = actionResourceKey(capability);
    const values = recoveriesByCapability.get(key) || [];
    values.push(recovery);
    recoveriesByCapability.set(key, values);
  }
  for (const [key, recoveries] of recoveriesByCapability) {
    if (
      !expectedKeys.includes(key) ||
      recoveries.filter(
        ({ status }) => status !== "resolved"
      ).length > 1
    ) {
      fail("recovery_capability_invalid");
    }
  }

  for (const operation of operations) {
    const key = actionResourceKey(
      capabilityForOperation(operation)
    );
    const recoveries =
      recoveriesByCapability.get(key) || [];
    const latest = recoveries.at(-1) || null;
    if (
      operation.recoveryId !==
        (latest?.recoveryId ?? null) ||
      recoveries.some(
        (recovery) =>
          recovery.createdByOperationId !==
            operation.operationId ||
          (
            recovery.jobRunId !== null &&
            recovery.jobRunId !== operation.operationId
          )
      ) ||
      operation.blocksCompletion !==
        (
          operation.status !== "succeeded" &&
          !(
            operation.status === "failed" &&
            latest?.status === "resolved"
          )
        )
    ) {
      fail("operation_recovery_binding_invalid");
    }
  }

  for (const [index, action] of
    result.availableActions.entries()) {
    const key = actionKeys[index];
    const recoveries =
      recoveriesByCapability.get(key) || [];
    const latest = recoveries.at(-1) || null;
    const enabled =
      latest !== null &&
      ["pending", "ready"].includes(latest.status);
    if (
      action.enabled !== enabled ||
      action.reasonCode !==
        (enabled ? null : "RECOVERY_NOT_AVAILABLE")
    ) {
      fail("available_action_state_invalid");
    }
  }

  const recoveriesByRollover = new Map();
  for (const recovery of result.recoveries) {
    if (recovery.rolloverId === null) continue;
    const values =
      recoveriesByRollover.get(recovery.rolloverId) || [];
    values.push(recovery.recoveryId);
    recoveriesByRollover.set(recovery.rolloverId, values);
  }
  for (const rollover of result.rollovers) {
    const expected = [
      ...(recoveriesByRollover.get(rollover.rolloverId) || []),
    ].sort(compareUnicodeScalarStrings);
    if (
      expected.length !== rollover.recoveryIds.length ||
      expected.some(
        (id, index) => id !== rollover.recoveryIds[index]
      )
    ) {
      fail("rollover_recovery_binding_invalid");
    }
  }
  if (
    [...recoveriesByRollover.keys()].some(
      (rolloverId) =>
        !result.rollovers.some(
          (rollover) =>
            rollover.rolloverId === rolloverId
        )
    ) ||
    result.fad.counts.rolloversPersisted !==
      result.rollovers.length ||
    result.fad.counts.rolloversCompleted !==
      result.rollovers.filter(
        ({ status }) => status === "completed"
      ).length ||
    result.fad.counts.recoveriesOpen !==
      result.recoveries.filter(
        ({ status }) => status !== "resolved"
      ).length
  ) {
    fail("projection_counts_invalid");
  }
}

function validateRecovery(value) {
  exactObject(
    value,
    RECOVERY_KEYS,
    "recovery_fields_invalid"
  );
  const result = {
    recoveryId: stableId(
      value.recoveryId,
      "recovery_id_invalid"
    ),
    kind: value.kind,
    status: value.status,
    playerId: nullableStableId(
      value.playerId,
      "recovery_player_id_invalid"
    ),
    allocationId: nullableStableId(
      value.allocationId,
      "recovery_allocation_id_invalid"
    ),
    rolloverId: nullableStableId(
      value.rolloverId,
      "recovery_rollover_id_invalid"
    ),
    auctionId: nullableStableId(
      value.auctionId,
      "recovery_auction_id_invalid"
    ),
    jobRunId: nullableStableId(
      value.jobRunId,
      "recovery_job_run_id_invalid"
    ),
    nominationQueueId: nullableStableId(
      value.nominationQueueId,
      "recovery_nomination_queue_id_invalid"
    ),
    earliestActivationAtMs: nullableTimestamp(
      value.earliestActivationAtMs,
      "recovery_earliest_activation_invalid"
    ),
    targetResolutionAtMs: nullableTimestamp(
      value.targetResolutionAtMs,
      "recovery_target_resolution_invalid"
    ),
    lastErrorCode: nullableCode(
      value.lastErrorCode,
      "recovery_error_code_invalid"
    ),
    commissionerReason: nullableSafeText(
      value.commissionerReason,
      500,
      "recovery_reason_invalid"
    ),
    createdByOperationId: nullableStableId(
      value.createdByOperationId,
      "recovery_created_operation_invalid"
    ),
    resolvedByUserId: nullableStableId(
      value.resolvedByUserId,
      "recovery_resolved_user_invalid"
    ),
    resolvedByMembershipId: nullableStableId(
      value.resolvedByMembershipId,
      "recovery_resolved_membership_invalid"
    ),
    resolvedAuthority: value.resolvedAuthority,
    createdAtMs: timestamp(
      value.createdAtMs,
      "recovery_created_at_invalid"
    ),
    updatedAtMs: timestamp(
      value.updatedAtMs,
      "recovery_updated_at_invalid"
    ),
    resolvedAtMs: nullableTimestamp(
      value.resolvedAtMs,
      "recovery_resolved_at_invalid"
    ),
    version: positiveInteger(
      value.version,
      "recovery_version_invalid"
    ),
  };
  const userResolution =
    result.resolvedAuthority === "commissioner" ||
    result.resolvedAuthority ===
      "platform_administrator_as_commissioner";
  if (
    !RECOVERY_KINDS.has(result.kind) ||
    !FREE_AGENT_DRAFT_RECOVERY_STATUSES.includes(
      result.status
    ) ||
    (
      result.kind === "queued_nomination_activation" !==
      (result.nominationQueueId !== null)
    ) ||
    result.updatedAtMs < result.createdAtMs ||
    (
      result.status === "resolved" !==
      (result.resolvedAtMs !== null)
    ) ||
    (
      result.status === "resolved" !==
      RESOLVED_AUTHORITIES.has(
        result.resolvedAuthority
      )
    ) ||
    (
      userResolution !==
      (
        result.resolvedByUserId !== null &&
        result.resolvedByMembershipId !== null
      )
    ) ||
    (
      result.resolvedAuthority === "system" &&
      (
        result.resolvedByUserId !== null ||
        result.resolvedByMembershipId !== null
      )
    ) ||
    (
      result.status !== "resolved" &&
      (
        result.resolvedAuthority !== null ||
        result.resolvedByUserId !== null ||
        result.resolvedByMembershipId !== null
      )
    )
  ) {
    fail("recovery_state_invalid");
  }
  return result;
}

function compareRecovery(left, right) {
  return (
    left.createdAtMs - right.createdAtMs ||
    compareUnicodeScalarStrings(
      left.recoveryId,
      right.recoveryId
    )
  );
}

function validateRecoveries(value) {
  if (!Array.isArray(value)) fail("recoveries_invalid");
  const result = value.map(validateRecovery);
  if (
    result.some(
      (recovery, index) =>
        index > 0 &&
        compareRecovery(
          result[index - 1],
          recovery
        ) >= 0
    )
  ) {
    fail("recovery_order_invalid");
  }
  return result;
}

function actionResourceKey(value) {
  return `${value.action}:${value.resourceId ?? ""}`;
}

function compareAction(left, right) {
  return (
    FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS.indexOf(
      left.action
    ) -
      FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS.indexOf(
        right.action
      ) ||
    compareUnicodeScalarStrings(
      left.resourceId || "",
      right.resourceId || ""
    )
  );
}

function validateAvailableActions(value) {
  if (!Array.isArray(value)) {
    fail("available_actions_invalid");
  }
  const result = value.map((candidate) => {
    exactObject(
      candidate,
      ACTION_KEYS,
      "available_action_fields_invalid"
    );
    if (
      !FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS.includes(
        candidate.action
      ) ||
      typeof candidate.enabled !== "boolean"
    ) {
      fail("available_action_invalid");
    }
    const resourceId = [
      "retry_deadline",
      "complete_fad",
    ].includes(candidate.action)
      ? (
          candidate.resourceId === null
            ? null
            : fail("available_action_resource_invalid")
        )
      : stableId(
          candidate.resourceId,
          "available_action_resource_invalid"
        );
    const reasonCode = candidate.enabled
      ? (
          candidate.reasonCode === null
            ? null
            : fail("available_action_reason_invalid")
        )
      : (
          FREE_AGENT_DRAFT_RECOVERY_READ_REASON_CODES.includes(
            candidate.reasonCode
          )
            ? candidate.reasonCode
            : fail("available_action_reason_invalid")
        );
    return {
      action: candidate.action,
      resourceId,
      enabled: candidate.enabled,
      reasonCode,
    };
  });
  const keys = result.map(actionResourceKey);
  if (
    new Set(keys).size !== keys.length ||
    result.some(
      (action, index) =>
        index > 0 &&
        compareAction(result[index - 1], action) >= 0
    )
  ) {
    fail("available_action_order_invalid");
  }
  return result;
}

function uniqueStableIds(value, reasonCode) {
  if (!Array.isArray(value)) fail(reasonCode);
  const result = value.map((id) =>
    stableId(id, reasonCode)
  );
  if (new Set(result).size !== result.length) {
    fail(reasonCode);
  }
  return result;
}

function validateScheduleRecovery(value) {
  exactObject(
    value,
    SCHEDULE_KEYS,
    "schedule_recovery_fields_invalid"
  );
  if (!Array.isArray(value.replacedJobs)) {
    fail("schedule_replaced_jobs_invalid");
  }
  const replacedJobs = value.replacedJobs.map(
    (candidate) => {
      exactObject(
        candidate,
        REPLACED_JOB_KEYS,
        "schedule_replaced_job_fields_invalid"
      );
      return {
        oldJobId: stableId(
          candidate.oldJobId,
          "schedule_old_job_id_invalid"
        ),
        oldOccurrenceKey: boundedSafeText(
          candidate.oldOccurrenceKey,
          1_000,
          "schedule_old_occurrence_invalid"
        ),
        newJobId: stableId(
          candidate.newJobId,
          "schedule_new_job_id_invalid"
        ),
        newOccurrenceKey: boundedSafeText(
          candidate.newOccurrenceKey,
          1_000,
          "schedule_new_occurrence_invalid"
        ),
      };
    }
  );
  if (
    replacedJobs.some(
      (job, index) =>
        index > 0 &&
        (
          compareUnicodeScalarStrings(
            replacedJobs[index - 1]
              .oldOccurrenceKey,
            job.oldOccurrenceKey
          ) ||
          compareUnicodeScalarStrings(
            replacedJobs[index - 1].oldJobId,
            job.oldJobId
          )
        ) >= 0
    )
  ) {
    fail("schedule_replaced_job_order_invalid");
  }
  const result = {
    operationId: stableId(
      value.operationId,
      "schedule_operation_id_invalid"
    ),
    status: value.status,
    oldWeek1StartsAtMs: timestamp(
      value.oldWeek1StartsAtMs,
      "schedule_old_week_one_invalid"
    ),
    newWeek1StartsAtMs: timestamp(
      value.newWeek1StartsAtMs,
      "schedule_new_week_one_invalid"
    ),
    oldScheduleVersion: positiveInteger(
      value.oldScheduleVersion,
      "schedule_old_version_invalid"
    ),
    newScheduleVersion: positiveInteger(
      value.newScheduleVersion,
      "schedule_new_version_invalid"
    ),
    removedWeekIds: uniqueStableIds(
      value.removedWeekIds,
      "schedule_removed_week_ids_invalid"
    ),
    removedMatchupIds: uniqueStableIds(
      value.removedMatchupIds,
      "schedule_removed_matchup_ids_invalid"
    ),
    replacedJobs,
    completedAtMs: timestamp(
      value.completedAtMs,
      "schedule_completed_at_invalid"
    ),
    version: positiveInteger(
      value.version,
      "schedule_version_invalid"
    ),
  };
  if (
    result.status !== "succeeded" ||
    result.newWeek1StartsAtMs <=
      result.oldWeek1StartsAtMs ||
    result.newScheduleVersion !==
      result.oldScheduleVersion + 1
  ) {
    fail("schedule_recovery_state_invalid");
  }
  return result;
}

function projectFreeAgentDraftRecoveryRead(value) {
  const hasSchedule =
    isPlainObject(value) &&
    Object.prototype.hasOwnProperty.call(
      value,
      "scheduleRecoveryEvidence"
    );
  exactObject(
    value,
    hasSchedule
      ? [...TOP_LEVEL_KEYS, "scheduleRecoveryEvidence"]
      : TOP_LEVEL_KEYS,
    "recovery_read_fields_invalid"
  );
  const fad = validateFad(value.fad);
  const deadlineOperation =
    value.deadlineOperation === null
      ? null
      : validateOperation(value.deadlineOperation);
  const allocationOperations = validateOperations(
    value.allocationOperations,
    ALLOCATION_OPERATION_KINDS,
    "allocation_operations_invalid"
  );
  const rapidOperations = validateOperations(
    value.rapidOperations,
    RAPID_OPERATION_KINDS,
    "rapid_operations_invalid"
  );
  const completionOperation =
    value.completionOperation === null
      ? null
      : validateOperation(value.completionOperation);
  if (
    (
      deadlineOperation !== null &&
      (
        deadlineOperation.operationKind !== "deadline" ||
        deadlineOperation.resourceId !== fad.fadId
      )
    ) ||
    (
      completionOperation !== null &&
      (
        completionOperation.operationKind !== "completion" ||
        completionOperation.resourceId !== fad.fadId
      )
    )
  ) {
    fail("singleton_operation_partition_invalid");
  }
  const result = {
    fad,
    deadlineOperation,
    allocationOperations,
    rapidOperations,
    completionOperation,
    rollovers: validateRollovers(value.rollovers),
    recoveries: validateRecoveries(value.recoveries),
    availableActions: validateAvailableActions(
      value.availableActions
    ),
  };
  validateProjectionBindings(result);
  if (hasSchedule) {
    result.scheduleRecoveryEvidence =
      validateScheduleRecovery(
        value.scheduleRecoveryEvidence
      );
    if (
      fad.scheduleRecoveryOperationId !==
        result.scheduleRecoveryEvidence.operationId ||
      fad.completedAtMs !==
        result.scheduleRecoveryEvidence.completedAtMs ||
      fad.frozenFadFirstMatchupStartsAtMs !==
        result.scheduleRecoveryEvidence
          .oldWeek1StartsAtMs ||
      fad.competitionFirstMatchupStartsAtMs !==
        result.scheduleRecoveryEvidence
          .newWeek1StartsAtMs
    ) {
      fail("schedule_recovery_fad_binding_invalid");
    }
  } else if (
    fad.scheduleRecoveryOperationId !== null
  ) {
    fail("schedule_recovery_missing");
  }
  return deepFreeze(result);
}

module.exports = {
  FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS,
  FREE_AGENT_DRAFT_RECOVERY_READ_CODES,
  FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_KINDS,
  FREE_AGENT_DRAFT_RECOVERY_READ_OPERATION_STATUSES,
  FREE_AGENT_DRAFT_RECOVERY_READ_REASON_CODES,
  FreeAgentDraftRecoveryReadPolicyError,
  projectFreeAgentDraftRecoveryRead,
};
