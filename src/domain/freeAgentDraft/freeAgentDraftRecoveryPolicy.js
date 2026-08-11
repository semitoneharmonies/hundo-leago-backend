"use strict";

const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../leagues/seasonRolloverEvidencePolicy"
);
const {
  buildAuctionResolutionOccurrenceKey,
} = require("../auctions/auctionResolutionPolicy");
const {
  UUID_PATTERN,
  parseFreeAgentDraftOccurrenceKey,
} = require("./freeAgentDraftPolicy");

const FREE_AGENT_DRAFT_RECOVERY_ACTION_SCHEMA_VERSION =
  1;
const FREE_AGENT_DRAFT_RECOVERY_ACTION_REQUEST_DOMAIN =
  "hundo-leago.free-agent-draft-recovery-action-request";
const FREE_AGENT_DRAFT_RECOVERY_ACTION_HTTP_STATUS =
  202;
const FREE_AGENT_DRAFT_RECOVERY_REASON_MAXIMUM_SCALARS =
  500;
const FREE_AGENT_DRAFT_RECOVERY_IDEMPOTENCY_KEY_MAXIMUM_SCALARS =
  128;

const FREE_AGENT_DRAFT_RECOVERY_ACTIONS =
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

const FREE_AGENT_DRAFT_RECOVERY_ACTION_POLICIES =
  Object.freeze({
    retry_deadline: Object.freeze({
      action: "retry_deadline",
      recoveryKind: "deadline_retry",
      operationKind: "deadline",
      occurrenceType: "deadline",
      jobType: "fad_deadline",
      resourceType: "free_agent_draft",
      resourceIdRule: "null",
    }),
    retry_allocation: Object.freeze({
      action: "retry_allocation",
      recoveryKind: "allocation_retry",
      operationKind: "allocation",
      occurrenceType: "allocate",
      jobType: "fad_allocation",
      resourceType: "allocation",
      resourceIdRule: "uuid",
    }),
    activate_restricted: Object.freeze({
      action: "activate_restricted",
      recoveryKind: "restricted_activation",
      operationKind: "restricted_activation",
      occurrenceType: "restricted_activate",
      jobType: "fad_restricted_activation",
      resourceType: "allocation",
      resourceIdRule: "uuid",
    }),
    activate_queued_nomination: Object.freeze({
      action: "activate_queued_nomination",
      recoveryKind: "queued_nomination_activation",
      operationKind:
        "queued_nomination_activation",
      occurrenceType: "nomination_open",
      jobType:
        "fad_queued_nomination_activation",
      resourceType: "nomination_queue",
      resourceIdRule: "uuid",
    }),
    activate_fallback: Object.freeze({
      action: "activate_fallback",
      recoveryKind: "fallback_activation",
      operationKind: "fallback_activation",
      occurrenceType: "fallback_activate",
      jobType: "fad_fallback_activation",
      resourceType: "allocation",
      resourceIdRule: "uuid",
    }),
    retry_auction_resolution: Object.freeze({
      action: "retry_auction_resolution",
      recoveryKind: "auction_resolution",
      operationKind: "auction_resolution",
      occurrenceType: "auction_resolution",
      jobType: "auction.resolve.target",
      resourceType: "auction",
      resourceIdRule: "uuid",
    }),
    finalize_rollover: Object.freeze({
      action: "finalize_rollover",
      recoveryKind: "rollover_finalize",
      operationKind: "rollover",
      occurrenceType: "rollover",
      jobType: "fad_rollover",
      resourceType: "rollover",
      resourceIdRule: "uuid",
    }),
    complete_fad: Object.freeze({
      action: "complete_fad",
      recoveryKind: "completion",
      operationKind: "completion",
      occurrenceType: "complete",
      jobType: "fad_completion",
      resourceType: "free_agent_draft",
      resourceIdRule: "null",
    }),
  });

const FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES =
  Object.freeze({
    inputInvalid: "FAD_RECOVERY_INPUT_INVALID",
    resultInvalid: "FAD_RECOVERY_RESULT_INVALID",
  });

const FREE_AGENT_DRAFT_RECOVERY_REASON_CODES =
  Object.freeze({
    acceptedAtMsInvalid: "accepted_at_ms_invalid",
    actionInvalid: "action_invalid",
    bodyFieldsInvalid: "body_fields_invalid",
    fadIdInvalid: "fad_id_invalid",
    idempotencyKeyInvalid: "idempotency_key_invalid",
    leagueIdInvalid: "league_id_invalid",
    occurrenceKeyInvalid: "occurrence_key_invalid",
    operationIdInvalid: "operation_id_invalid",
    pollDescriptorInvalid: "poll_descriptor_invalid",
    reasonInvalid: "reason_invalid",
    requestFieldsInvalid: "request_fields_invalid",
    resourceIdInvalid: "resource_id_invalid",
    resourceIdMustBeNull: "resource_id_must_be_null",
    resourceIdRequired: "resource_id_required",
    responseFieldsInvalid: "response_fields_invalid",
    statusInvalid: "status_invalid",
  });

const RECOVERY_BODY_FIELDS = Object.freeze([
  "action",
  "resourceId",
  "reason",
]);
const RECOVERY_REQUEST_FIELDS = Object.freeze([
  "body",
  "fadId",
  "leagueId",
]);
const RECOVERY_RESPONSE_FIELDS = Object.freeze([
  "acceptedAtMs",
  "action",
  "occurrenceKey",
  "operationId",
  "pollDescriptor",
  "resourceId",
  "status",
]);
const RECOVERY_POLL_DESCRIPTOR_FIELDS = Object.freeze([
  "fadId",
  "kind",
  "leagueId",
]);
const RECOVERY_ACCEPTED_STATUSES = Object.freeze([
  "pending",
  "already_succeeded",
]);
const FORBIDDEN_REASON_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAXIMUM_TIMESTAMP_MS =
  8_640_000_000_000_000;
const MAXIMUM_OCCURRENCE_KEY_LENGTH = 400;

class FreeAgentDraftRecoveryPolicyError
  extends Error {
  constructor(code, reasonCode) {
    super(`${code}: ${reasonCode}`);
    this.name = "FreeAgentDraftRecoveryPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftRecoveryPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
      .inputInvalid,
    reasonCode
  );
}

function failResult(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
      .resultInvalid,
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

function requireExactDataObject(
  value,
  expectedFields,
  reasonCode,
  failure
) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    failure(reasonCode);
  }
  const actualFields =
    Object.getOwnPropertyNames(value).sort();
  const expected = [...expectedFields].sort();
  if (
    actualFields.length !== expected.length ||
    actualFields.some(
      (field, index) => field !== expected[index]
    ) ||
    actualFields.some((field) => {
      const descriptor =
        Object.getOwnPropertyDescriptor(value, field);
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
    failure(reasonCode);
  }
  return value;
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

function stableId(value, reasonCode, failure) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failure(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode, failure) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    failure(reasonCode);
  }
  return value;
}

function hasOnlyUnicodeScalars(value) {
  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff
    ) {
      const nextCodeUnit =
        value.charCodeAt(index + 1);
      if (
        !Number.isInteger(nextCodeUnit) ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        return false;
      }
      index += 1;
    } else if (
      codeUnit >= 0xdc00 &&
      codeUnit <= 0xdfff
    ) {
      return false;
    }
  }
  return true;
}

function normalizeReason(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    FORBIDDEN_REASON_PATTERN.test(value) ||
    !hasOnlyUnicodeScalars(value)
  ) {
    failInput(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .reasonInvalid
    );
  }
  const scalarCount = Array.from(value).length;
  if (
    scalarCount < 1 ||
    scalarCount >
      FREE_AGENT_DRAFT_RECOVERY_REASON_MAXIMUM_SCALARS
  ) {
    failInput(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .reasonInvalid
    );
  }
  return value;
}

function validateFreeAgentDraftRecoveryIdempotencyKey(
  value
) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    FORBIDDEN_REASON_PATTERN.test(value) ||
    !hasOnlyUnicodeScalars(value)
  ) {
    failInput(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .idempotencyKeyInvalid
    );
  }
  const scalarCount = Array.from(value).length;
  if (
    scalarCount < 1 ||
    scalarCount >
      FREE_AGENT_DRAFT_RECOVERY_IDEMPOTENCY_KEY_MAXIMUM_SCALARS
  ) {
    failInput(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .idempotencyKeyInvalid
    );
  }
  return value;
}

function getFreeAgentDraftRecoveryActionPolicy(
  action,
  failure = failInput
) {
  if (
    typeof action !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      FREE_AGENT_DRAFT_RECOVERY_ACTION_POLICIES,
      action
    )
  ) {
    failure(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .actionInvalid
    );
  }
  return FREE_AGENT_DRAFT_RECOVERY_ACTION_POLICIES[
    action
  ];
}

function normalizeResourceId(
  value,
  policy,
  failure = failInput
) {
  if (policy.resourceIdRule === "null") {
    if (value !== null) {
      failure(
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .resourceIdMustBeNull
      );
    }
    return null;
  }
  if (value === null || value === undefined) {
    failure(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .resourceIdRequired
    );
  }
  return stableId(
    value,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .resourceIdInvalid,
    failure
  );
}

function normalizeFreeAgentDraftRecoveryActionBody(
  value
) {
  requireExactDataObject(
    value,
    RECOVERY_BODY_FIELDS,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .bodyFieldsInvalid,
    failInput
  );
  const policy =
    getFreeAgentDraftRecoveryActionPolicy(
      value.action
    );
  return deepFreeze({
    action: policy.action,
    resourceId: normalizeResourceId(
      value.resourceId,
      policy
    ),
    reason: normalizeReason(value.reason),
  });
}

function freeAgentDraftRecoveryActionRequestProjection(
  input = {}
) {
  requireExactDataObject(
    input,
    RECOVERY_REQUEST_FIELDS,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .requestFieldsInvalid,
    failInput
  );
  const leagueId = stableId(
    input.leagueId,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .leagueIdInvalid,
    failInput
  );
  const fadId = stableId(
    input.fadId,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .fadIdInvalid,
    failInput
  );
  const body =
    normalizeFreeAgentDraftRecoveryActionBody(
      input.body
    );
  return deepFreeze({
    body,
    domain:
      FREE_AGENT_DRAFT_RECOVERY_ACTION_REQUEST_DOMAIN,
    fadId,
    leagueId,
    schemaVersion:
      FREE_AGENT_DRAFT_RECOVERY_ACTION_SCHEMA_VERSION,
  });
}

function serializeFreeAgentDraftRecoveryActionRequest(
  input
) {
  return serializeCanonicalJsonV1(
    freeAgentDraftRecoveryActionRequestProjection(
      input
    )
  );
}

function hashFreeAgentDraftRecoveryActionRequest(input) {
  return hashCanonicalJsonV1(
    freeAgentDraftRecoveryActionRequestProjection(
      input
    )
  );
}

function parseAuctionResolutionOccurrenceKey(
  value,
  resourceId
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_OCCURRENCE_KEY_LENGTH
  ) {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .occurrenceKeyInvalid
    );
  }
  const parts = value.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "auction" ||
    parts[1] !== resourceId ||
    !/^(0|[1-9][0-9]*)$/.test(parts[2])
  ) {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .occurrenceKeyInvalid
    );
  }
  const dueAtMs = Number(parts[2]);
  safeTimestamp(
    dueAtMs,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .occurrenceKeyInvalid,
    failResult
  );
  let rebuilt;
  try {
    rebuilt = buildAuctionResolutionOccurrenceKey({
      auctionId: resourceId,
      dueAtMs,
    });
  } catch {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .occurrenceKeyInvalid
    );
  }
  if (rebuilt !== value) {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .occurrenceKeyInvalid
    );
  }
}

function validateFadOccurrenceKey({
  action,
  fadId,
  occurrenceKey,
  resourceId,
}) {
  const policy =
    getFreeAgentDraftRecoveryActionPolicy(
      action,
      failResult
    );
  if (
    policy.occurrenceType ===
    "auction_resolution"
  ) {
    parseAuctionResolutionOccurrenceKey(
      occurrenceKey,
      resourceId
    );
    return occurrenceKey;
  }

  let parsed;
  try {
    parsed = parseFreeAgentDraftOccurrenceKey(
      occurrenceKey
    );
  } catch {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .occurrenceKeyInvalid
    );
  }
  if (
    parsed.fadId !== fadId ||
    parsed.type !== policy.occurrenceType ||
    (
      [
        "restricted_activate",
        "fallback_activate",
      ].includes(policy.occurrenceType) &&
      parsed.allocationId !== resourceId
    ) ||
    (
      policy.occurrenceType ===
        "nomination_open" &&
      parsed.queueId !== resourceId
    )
  ) {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .occurrenceKeyInvalid
    );
  }
  return occurrenceKey;
}

function projectFreeAgentDraftRecoveryAcceptedOperation(
  value = {}
) {
  requireExactDataObject(
    value,
    RECOVERY_RESPONSE_FIELDS,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .responseFieldsInvalid,
    failResult
  );
  const policy =
    getFreeAgentDraftRecoveryActionPolicy(
      value.action,
      failResult
    );
  const resourceId = normalizeResourceId(
    value.resourceId,
    policy,
    failResult
  );
  const operationId = stableId(
    value.operationId,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .operationIdInvalid,
    failResult
  );
  if (
    !RECOVERY_ACCEPTED_STATUSES.includes(
      value.status
    )
  ) {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .statusInvalid
    );
  }
  const acceptedAtMs = safeTimestamp(
    value.acceptedAtMs,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .acceptedAtMsInvalid,
    failResult
  );
  requireExactDataObject(
    value.pollDescriptor,
    RECOVERY_POLL_DESCRIPTOR_FIELDS,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .pollDescriptorInvalid,
    failResult
  );
  const leagueId = stableId(
    value.pollDescriptor.leagueId,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .pollDescriptorInvalid,
    failResult
  );
  const fadId = stableId(
    value.pollDescriptor.fadId,
    FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
      .pollDescriptorInvalid,
    failResult
  );
  if (value.pollDescriptor.kind !== "fad_recovery") {
    failResult(
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .pollDescriptorInvalid
    );
  }
  const occurrenceKey = validateFadOccurrenceKey({
    action: policy.action,
    fadId,
    occurrenceKey: value.occurrenceKey,
    resourceId,
  });
  return deepFreeze({
    operationId,
    occurrenceKey,
    action: policy.action,
    resourceId,
    status: value.status,
    acceptedAtMs,
    pollDescriptor: {
      kind: "fad_recovery",
      leagueId,
      fadId,
    },
  });
}

function validateFreeAgentDraftRecoveryAcceptedOperation(
  value
) {
  return projectFreeAgentDraftRecoveryAcceptedOperation(
    value
  );
}

function serializeFreeAgentDraftRecoveryAcceptedOperation(
  value
) {
  return serializeCanonicalJsonV1(
    projectFreeAgentDraftRecoveryAcceptedOperation(
      value
    )
  );
}

function hashFreeAgentDraftRecoveryAcceptedOperation(
  value
) {
  return hashCanonicalJsonV1(
    projectFreeAgentDraftRecoveryAcceptedOperation(
      value
    )
  );
}

module.exports = {
  FREE_AGENT_DRAFT_RECOVERY_ACTIONS,
  FREE_AGENT_DRAFT_RECOVERY_ACTION_HTTP_STATUS,
  FREE_AGENT_DRAFT_RECOVERY_ACTION_POLICIES,
  FREE_AGENT_DRAFT_RECOVERY_ACTION_REQUEST_DOMAIN,
  FREE_AGENT_DRAFT_RECOVERY_ACTION_SCHEMA_VERSION,
  FREE_AGENT_DRAFT_RECOVERY_IDEMPOTENCY_KEY_MAXIMUM_SCALARS,
  FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES,
  FREE_AGENT_DRAFT_RECOVERY_REASON_CODES,
  FREE_AGENT_DRAFT_RECOVERY_REASON_MAXIMUM_SCALARS,
  FreeAgentDraftRecoveryPolicyError,
  freeAgentDraftRecoveryActionRequestProjection,
  getFreeAgentDraftRecoveryActionPolicy,
  hashFreeAgentDraftRecoveryAcceptedOperation,
  hashFreeAgentDraftRecoveryActionRequest,
  normalizeFreeAgentDraftRecoveryActionBody,
  projectFreeAgentDraftRecoveryAcceptedOperation,
  serializeFreeAgentDraftRecoveryAcceptedOperation,
  serializeFreeAgentDraftRecoveryActionRequest,
  validateFreeAgentDraftRecoveryAcceptedOperation,
  validateFreeAgentDraftRecoveryIdempotencyKey,
};
