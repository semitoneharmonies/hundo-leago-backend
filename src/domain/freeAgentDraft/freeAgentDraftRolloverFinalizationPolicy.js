"use strict";

const {
  UUID_PATTERN,
} = require("./freeAgentDraftPolicy");

const FREE_AGENT_DRAFT_ROLLOVER_FINALIZATION_POLICY_ERROR_CODE =
  "FAD_ROLLOVER_FINALIZATION_INPUT_INVALID";
const FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE =
  "FAD_ROLLOVER_FINALIZATION_FAILED";
const DAY_MS = 86_400_000;
const ROLLOVER_FIELDS = Object.freeze([
  "fadId",
  "id",
  "leagueId",
  "nowMs",
  "rollsOverAtMs",
  "seasonId",
  "sequence",
  "status",
]);
const AUCTION_FIELDS = Object.freeze([
  "id",
  "jobStatus",
  "playerId",
  "recoveryAuctionId",
  "recoveryId",
  "recoveryJobRunId",
  "recoveryPlayerId",
  "recoveryRolloverId",
  "recoveryStatus",
  "resolutionOutcomeCode",
  "resolutionStatus",
  "status",
]);
const NOMINATION_FIELDS = Object.freeze([
  "id",
  "jobStatus",
  "jobRunId",
  "openedAuctionId",
  "playerId",
  "recoveryId",
  "recoveryStatus",
  "status",
  "validationCode",
]);
const FALLBACK_FIELDS = Object.freeze([
  "allocationId",
  "createdAuctionId",
  "required",
  "sourceAuctionId",
  "successorRolloverId",
]);
const RECOVERY_FIELDS = Object.freeze([
  "allocationId",
  "auctionId",
  "id",
  "jobRunId",
  "kind",
  "nominationQueueId",
  "playerId",
  "rolloverId",
  "status",
]);
const SUCCESSOR_FIELDS = Object.freeze([
  "id",
  "opensAtMs",
  "predecessorRolloverId",
  "rollsOverAtMs",
  "sequence",
  "status",
]);
const INPUT_FIELDS = Object.freeze([
  "auctions",
  "fallbacks",
  "nominations",
  "recoveries",
  "rollover",
  "successor",
]);
const ROLLOVER_STATUSES = Object.freeze(new Set([
  "scheduled",
  "processing",
  "completed",
  "recovery_required",
]));
const AUCTION_STATUSES = Object.freeze(new Set([
  "open",
  "resolving",
  "resolved",
  "no_winner",
  "cancelled",
  "failed",
]));
const JOB_STATUSES = Object.freeze(new Set([
  "pending",
  "leased",
  "running",
  "succeeded",
  "failed",
]));
const RESOLUTION_STATUSES = Object.freeze(new Set([
  "cancelled",
  "succeeded",
  "failed",
]));
const RESOLUTION_OUTCOMES = Object.freeze(new Set([
  "winner",
  "no_winner",
  "failed",
  "recovered",
]));
const RECOVERY_KINDS = Object.freeze(new Set([
  "deadline_retry",
  "allocation_retry",
  "restricted_activation",
  "queued_nomination_activation",
  "fallback_activation",
  "auction_resolution",
  "rollover_finalize",
  "completion",
]));
const RECOVERY_STATUSES = Object.freeze(new Set([
  "pending",
  "ready",
  "running",
  "resolved",
  "correction_required",
]));
const NONRESOLVED_RECOVERY_STATUSES = Object.freeze(new Set([
  "pending",
  "ready",
  "running",
  "correction_required",
]));
const UNATTACHED_BOUNDARY_RECOVERY_KINDS = Object.freeze(new Set([
  "allocation_retry",
  "restricted_activation",
  "fallback_activation",
]));
const EXACT_LINK_REQUIRED_RECOVERY_KINDS = Object.freeze(new Set([
  "queued_nomination_activation",
  "auction_resolution",
]));

class FreeAgentDraftRolloverFinalizationPolicyError
  extends Error {
  constructor(reasonCode) {
    super("The Free Agent Draft rollover evidence is invalid.");
    this.name =
      "FreeAgentDraftRolloverFinalizationPolicyError";
    this.code =
      FREE_AGENT_DRAFT_ROLLOVER_FINALIZATION_POLICY_ERROR_CODE;
    this.reasonCode = reasonCode;
  }
}

function invalid(reasonCode) {
  throw new FreeAgentDraftRolloverFinalizationPolicyError(
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
  if (!isPlainObject(value)) invalid(reasonCode);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    !actual.every(
      (field, index) => field === expected[index]
    )
  ) {
    invalid(reasonCode);
  }
  return value;
}

function canonicalId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(reasonCode);
  }
  return value;
}

function optionalId(value, reasonCode) {
  if (value !== null) canonicalId(value, reasonCode);
  return value;
}

function timestamp(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(reasonCode);
  }
  return value;
}

function enumValue(value, values, reasonCode) {
  if (!values.has(value)) invalid(reasonCode);
  return value;
}

function optionalEnum(value, values, reasonCode) {
  if (value !== null) enumValue(value, values, reasonCode);
  return value;
}

function optionalBoundedCode(value, reasonCode) {
  if (
    value !== null &&
    (
      typeof value !== "string" ||
      !/^[A-Z0-9_]{1,100}$/u.test(value)
    )
  ) {
    invalid(reasonCode);
  }
  return value;
}

function uniqueBy(values, key, reasonCode) {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) {
    invalid(reasonCode);
  }
}

function normalizeRollover(value) {
  exactObject(value, ROLLOVER_FIELDS, "rollover_fields_invalid");
  const rollover = Object.freeze({
    id: canonicalId(value.id, "rollover_id_invalid"),
    leagueId: canonicalId(
      value.leagueId,
      "league_id_invalid"
    ),
    seasonId: canonicalId(
      value.seasonId,
      "season_id_invalid"
    ),
    fadId: canonicalId(value.fadId, "fad_id_invalid"),
    sequence: positiveInteger(
      value.sequence,
      "rollover_sequence_invalid"
    ),
    rollsOverAtMs: timestamp(
      value.rollsOverAtMs,
      "rollover_timestamp_invalid"
    ),
    status: enumValue(
      value.status,
      ROLLOVER_STATUSES,
      "rollover_status_invalid"
    ),
    nowMs: timestamp(value.nowMs, "clock_timestamp_invalid"),
  });
  return rollover;
}

function normalizeAuctions(values) {
  if (!Array.isArray(values)) invalid("auctions_invalid");
  const normalized = values.map((value) => {
    exactObject(value, AUCTION_FIELDS, "auction_fields_invalid");
    return Object.freeze({
      id: canonicalId(value.id, "auction_id_invalid"),
      playerId: canonicalId(
        value.playerId,
        "auction_player_id_invalid"
      ),
      status: enumValue(
        value.status,
        AUCTION_STATUSES,
        "auction_status_invalid"
      ),
      resolutionStatus: optionalEnum(
        value.resolutionStatus,
        RESOLUTION_STATUSES,
        "auction_resolution_status_invalid"
      ),
      resolutionOutcomeCode: optionalEnum(
        value.resolutionOutcomeCode,
        RESOLUTION_OUTCOMES,
        "auction_resolution_outcome_invalid"
      ),
      jobStatus: optionalEnum(
        value.jobStatus,
        JOB_STATUSES,
        "auction_job_status_invalid"
      ),
      recoveryId: optionalId(
        value.recoveryId,
        "auction_recovery_id_invalid"
      ),
      recoveryStatus: optionalEnum(
        value.recoveryStatus,
        RECOVERY_STATUSES,
        "auction_recovery_status_invalid"
      ),
      recoveryPlayerId: optionalId(
        value.recoveryPlayerId,
        "auction_recovery_player_id_invalid"
      ),
      recoveryAuctionId: optionalId(
        value.recoveryAuctionId,
        "auction_recovery_auction_id_invalid"
      ),
      recoveryJobRunId: optionalId(
        value.recoveryJobRunId,
        "auction_recovery_job_id_invalid"
      ),
      recoveryRolloverId: optionalId(
        value.recoveryRolloverId,
        "auction_recovery_rollover_id_invalid"
      ),
    });
  });
  uniqueBy(normalized, ({ id }) => id, "auction_id_duplicate");
  return Object.freeze(normalized);
}

function normalizeNominations(values) {
  if (!Array.isArray(values)) invalid("nominations_invalid");
  const normalized = values.map((value) => {
    exactObject(
      value,
      NOMINATION_FIELDS,
      "nomination_fields_invalid"
    );
    return Object.freeze({
      id: canonicalId(value.id, "nomination_id_invalid"),
      playerId: canonicalId(
        value.playerId,
        "nomination_player_id_invalid"
      ),
      jobRunId: optionalId(
        value.jobRunId,
        "nomination_job_id_invalid"
      ),
      status: enumValue(
        value.status,
        new Set(["queued", "opened", "invalid"]),
        "nomination_status_invalid"
      ),
      openedAuctionId: optionalId(
        value.openedAuctionId,
        "nomination_auction_id_invalid"
      ),
      validationCode: optionalBoundedCode(
        value.validationCode,
        "nomination_validation_code_invalid"
      ),
      jobStatus: optionalEnum(
        value.jobStatus,
        JOB_STATUSES,
        "nomination_job_status_invalid"
      ),
      recoveryId: optionalId(
        value.recoveryId,
        "nomination_recovery_id_invalid"
      ),
      recoveryStatus: optionalEnum(
        value.recoveryStatus,
        RECOVERY_STATUSES,
        "nomination_recovery_status_invalid"
      ),
    });
  });
  uniqueBy(
    normalized,
    ({ id }) => id,
    "nomination_id_duplicate"
  );
  return Object.freeze(normalized);
}

function normalizeFallbacks(values) {
  if (!Array.isArray(values)) invalid("fallbacks_invalid");
  const normalized = values.map((value) => {
    exactObject(value, FALLBACK_FIELDS, "fallback_fields_invalid");
    if (typeof value.required !== "boolean") {
      invalid("fallback_required_invalid");
    }
    const item = Object.freeze({
      sourceAuctionId: canonicalId(
        value.sourceAuctionId,
        "fallback_source_auction_id_invalid"
      ),
      allocationId: canonicalId(
        value.allocationId,
        "fallback_allocation_id_invalid"
      ),
      required: value.required,
      createdAuctionId: optionalId(
        value.createdAuctionId,
        "fallback_auction_id_invalid"
      ),
      successorRolloverId: optionalId(
        value.successorRolloverId,
        "fallback_successor_id_invalid"
      ),
    });
    if (
      !item.required &&
      (
        item.createdAuctionId !== null ||
        item.successorRolloverId !== null
      )
    ) {
      invalid("fallback_not_required_evidence_invalid");
    }
    return item;
  });
  uniqueBy(
    normalized,
    ({ sourceAuctionId, allocationId }) =>
      `${sourceAuctionId}:${allocationId}`,
    "fallback_identity_duplicate"
  );
  return Object.freeze(normalized);
}

function normalizeRecoveries(values) {
  if (!Array.isArray(values)) invalid("recoveries_invalid");
  const normalized = values.map((value) => {
    exactObject(value, RECOVERY_FIELDS, "recovery_fields_invalid");
    return Object.freeze({
      id: canonicalId(value.id, "recovery_id_invalid"),
      kind: enumValue(
        value.kind,
        RECOVERY_KINDS,
        "recovery_kind_invalid"
      ),
      status: enumValue(
        value.status,
        RECOVERY_STATUSES,
        "recovery_status_invalid"
      ),
      rolloverId: optionalId(
        value.rolloverId,
        "recovery_rollover_id_invalid"
      ),
      allocationId: optionalId(
        value.allocationId,
        "recovery_allocation_id_invalid"
      ),
      auctionId: optionalId(
        value.auctionId,
        "recovery_auction_id_invalid"
      ),
      nominationQueueId: optionalId(
        value.nominationQueueId,
        "recovery_nomination_queue_id_invalid"
      ),
      playerId: optionalId(
        value.playerId,
        "recovery_player_id_invalid"
      ),
      jobRunId: optionalId(
        value.jobRunId,
        "recovery_job_id_invalid"
      ),
    });
  });
  uniqueBy(normalized, ({ id }) => id, "recovery_id_duplicate");
  return Object.freeze(normalized);
}

function normalizeSuccessor(value, rollover) {
  if (value === null) return null;
  exactObject(value, SUCCESSOR_FIELDS, "successor_fields_invalid");
  if (
    rollover.rollsOverAtMs >
      Number.MAX_SAFE_INTEGER - DAY_MS
  ) {
    invalid("successor_timestamp_invalid");
  }
  const successor = Object.freeze({
    id: canonicalId(value.id, "successor_id_invalid"),
    sequence: positiveInteger(
      value.sequence,
      "successor_sequence_invalid"
    ),
    predecessorRolloverId: canonicalId(
      value.predecessorRolloverId,
      "successor_predecessor_id_invalid"
    ),
    opensAtMs: timestamp(
      value.opensAtMs,
      "successor_open_timestamp_invalid"
    ),
    rollsOverAtMs: timestamp(
      value.rollsOverAtMs,
      "successor_rollover_timestamp_invalid"
    ),
    status: enumValue(
      value.status,
      ROLLOVER_STATUSES,
      "successor_status_invalid"
    ),
  });
  if (
    successor.id === rollover.id ||
    successor.sequence !== rollover.sequence + 1 ||
    successor.predecessorRolloverId !== rollover.id ||
    successor.opensAtMs !== rollover.rollsOverAtMs ||
    successor.rollsOverAtMs !==
      rollover.rollsOverAtMs + DAY_MS
  ) {
    invalid("successor_contiguity_invalid");
  }
  return successor;
}

function exactRecovery({
  recoveries,
  recoveryId,
  recoveryStatus,
  kind,
  rolloverId,
  allocationId,
  auctionId,
  nominationQueueId,
  playerId,
  jobRunId,
  requireNonresolved,
}) {
  if (!recoveryId || !recoveryStatus) return null;
  const recovery = recoveries.find(({ id }) => id === recoveryId);
  if (
    !recovery ||
    recovery.kind !== kind ||
    recovery.status !== recoveryStatus ||
    recovery.rolloverId !== rolloverId ||
    recovery.allocationId !== allocationId ||
    recovery.auctionId !== auctionId ||
    recovery.nominationQueueId !== nominationQueueId ||
    recovery.playerId !== playerId ||
    recovery.jobRunId !== jobRunId ||
    (
      requireNonresolved &&
      !NONRESOLVED_RECOVERY_STATUSES.has(recovery.status)
    )
  ) {
    return null;
  }
  return recovery;
}

function auctionRecovery(auction, rollover, recoveries, nonresolved) {
  if (
    auction.recoveryPlayerId !== auction.playerId ||
    auction.recoveryAuctionId !== auction.id
  ) {
    return null;
  }
  return exactRecovery({
    recoveries,
    recoveryId: auction.recoveryId,
    recoveryStatus: auction.recoveryStatus,
    kind: "auction_resolution",
    rolloverId: rollover.id,
    allocationId: null,
    auctionId: auction.id,
    nominationQueueId: null,
    playerId: auction.playerId,
    jobRunId: auction.recoveryJobRunId,
    requireNonresolved: nonresolved,
  }) && auction.recoveryRolloverId === rollover.id;
}

function normalAuction(auction, rollover, recoveries) {
  const direct =
    auction.recoveryId === null &&
    auction.recoveryStatus === null &&
    auction.recoveryPlayerId === null &&
    auction.recoveryAuctionId === null &&
    auction.recoveryJobRunId === null &&
    auction.recoveryRolloverId === null;
  const recovered = auctionRecovery(
    auction,
    rollover,
    recoveries,
    false
  ) && auction.recoveryStatus === "resolved";
  if (
    auction.status === "resolved" &&
    auction.resolutionStatus === "succeeded" &&
    auction.resolutionOutcomeCode === "winner" &&
    auction.jobStatus === "succeeded"
  ) {
    return direct || recovered;
  }
  if (
    auction.status === "no_winner" &&
    auction.resolutionStatus === "succeeded" &&
    auction.resolutionOutcomeCode === "no_winner" &&
    auction.jobStatus === "succeeded"
  ) {
    return direct || recovered;
  }
  if (
    auction.status === "cancelled" &&
    auction.resolutionStatus === "cancelled" &&
    auction.resolutionOutcomeCode === "recovered" &&
    auction.jobStatus === "succeeded" &&
    recovered
  ) {
    return true;
  }
  return false;
}

function recoverableAuction(auction, rollover, recoveries) {
  return Boolean(
    auction.status === "failed" &&
    auction.resolutionStatus === null &&
    auction.resolutionOutcomeCode === null &&
    auction.jobStatus === "failed" &&
    auctionRecovery(auction, rollover, recoveries, true)
  );
}

function normalNomination(nomination, recoveries, rollover) {
  const recovery = nomination.recoveryId === null
    ? nomination.recoveryStatus === null
    : Boolean(
        exactRecovery({
          recoveries,
          recoveryId: nomination.recoveryId,
          recoveryStatus: nomination.recoveryStatus,
          kind: "queued_nomination_activation",
          rolloverId: rollover.id,
          allocationId: null,
          auctionId: null,
          nominationQueueId: nomination.id,
          playerId: nomination.playerId,
          jobRunId: nomination.jobRunId,
          requireNonresolved: false,
        }) && nomination.recoveryStatus === "resolved"
      );
  if (
    !recovery ||
    nomination.jobRunId === null ||
    nomination.jobStatus !== "succeeded"
  ) return false;
  if (nomination.status === "opened") {
    return (
      nomination.openedAuctionId !== null &&
      nomination.validationCode === null
    );
  }
  return (
    nomination.status === "invalid" &&
    nomination.openedAuctionId === null &&
    nomination.validationCode === "PLAYER_UNAVAILABLE"
  );
}

function recoverableNomination(nomination, recoveries, rollover) {
  if (
    nomination.status !== "queued" ||
    nomination.openedAuctionId !== null ||
    nomination.validationCode !== null ||
    nomination.jobStatus !== "failed" ||
    !nomination.recoveryId ||
    !NONRESOLVED_RECOVERY_STATUSES.has(
      nomination.recoveryStatus
    )
  ) {
    return false;
  }
  return Boolean(exactRecovery({
    recoveries,
    recoveryId: nomination.recoveryId,
    recoveryStatus: nomination.recoveryStatus,
    kind: "queued_nomination_activation",
    rolloverId: rollover.id,
    allocationId: null,
    auctionId: null,
    nominationQueueId: nomination.id,
    playerId: nomination.playerId,
    jobRunId: nomination.jobRunId,
    requireNonresolved: true,
  }));
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function evaluateFreeAgentDraftRolloverFinalization(value = {}) {
  exactObject(value, INPUT_FIELDS, "input_fields_invalid");
  const rollover = normalizeRollover(value.rollover);
  const auctions = normalizeAuctions(value.auctions);
  const nominations = normalizeNominations(value.nominations);
  const fallbacks = normalizeFallbacks(value.fallbacks);
  const recoveries = normalizeRecoveries(value.recoveries);
  const successor = normalizeSuccessor(value.successor, rollover);

  let normalAuctionCount = 0;
  let recoverableAuctionCount = 0;
  let terminalNominationCount = 0;
  let unresolvedCount = 0;
  let recoverableUnresolvedCount = 0;
  const consumedRecoveryIds = new Set();

  if (rollover.nowMs < rollover.rollsOverAtMs) {
    unresolvedCount += 1;
  }
  for (const item of auctions) {
    if (normalAuction(item, rollover, recoveries)) {
      normalAuctionCount += 1;
      if (item.recoveryId !== null) {
        consumedRecoveryIds.add(item.recoveryId);
      }
    } else if (recoverableAuction(item, rollover, recoveries)) {
      recoverableAuctionCount += 1;
      unresolvedCount += 1;
      recoverableUnresolvedCount += 1;
      consumedRecoveryIds.add(item.recoveryId);
    } else {
      unresolvedCount += 1;
    }
  }
  let openedNominationRequiresSuccessor = false;
  for (const item of nominations) {
    if (normalNomination(item, recoveries, rollover)) {
      terminalNominationCount += 1;
      if (item.recoveryId !== null) {
        consumedRecoveryIds.add(item.recoveryId);
      }
      if (item.status === "opened") {
        openedNominationRequiresSuccessor = true;
      }
    } else if (recoverableNomination(item, recoveries, rollover)) {
      unresolvedCount += 1;
      recoverableUnresolvedCount += 1;
      consumedRecoveryIds.add(item.recoveryId);
    } else {
      unresolvedCount += 1;
    }
  }

  const requiredFallbacks = fallbacks.filter(
    ({ required }) => required
  );
  let createdFallbackCount = 0;
  for (const item of requiredFallbacks) {
    if (
      item.createdAuctionId !== null &&
      item.successorRolloverId !== null &&
      successor !== null &&
      item.successorRolloverId === successor.id
    ) {
      createdFallbackCount += 1;
    } else {
      unresolvedCount += 1;
    }
  }
  if (
    openedNominationRequiresSuccessor &&
    successor === null
  ) {
    unresolvedCount += 1;
  }

  for (const item of recoveries) {
    if (
      item.status !== "resolved" &&
      item.rolloverId === rollover.id &&
      !consumedRecoveryIds.has(item.id)
    ) {
      if (UNATTACHED_BOUNDARY_RECOVERY_KINDS.has(item.kind)) {
        unresolvedCount += 1;
        recoverableUnresolvedCount += 1;
      } else if (EXACT_LINK_REQUIRED_RECOVERY_KINDS.has(item.kind)) {
        unresolvedCount += 1;
      }
    }
  }

  const evidence = {
    auctionCount: auctions.length,
    normalAuctionCount,
    recoverableAuctionCount,
    nominationCount: nominations.length,
    terminalNominationCount,
    requiredFallbackCount: requiredFallbacks.length,
    createdFallbackCount,
    unresolvedCount,
    recoverableUnresolvedCount,
  };
  let outcome;
  let reasonCode;
  if (unresolvedCount === 0) {
    outcome = "completed";
    reasonCode = "boundary_accounted";
  } else if (
    unresolvedCount === recoverableUnresolvedCount
  ) {
    outcome = "recovery_required";
    reasonCode = "boundary_recovery_required";
  } else {
    outcome = "awaiting_data";
    reasonCode = "boundary_work_pending";
  }
  return deepFreeze({
    rolloverId: rollover.id,
    fadId: rollover.fadId,
    sequence: rollover.sequence,
    rolloverAtMs: rollover.rollsOverAtMs,
    outcome,
    reasonCode,
    evidence,
  });
}

module.exports = {
  FREE_AGENT_DRAFT_ROLLOVER_FINALIZATION_POLICY_ERROR_CODE,
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
  FreeAgentDraftRolloverFinalizationPolicyError,
  evaluateFreeAgentDraftRolloverFinalization,
};
