"use strict";

const {
  AUCTION_ADMINISTRATION_CODES,
  AuctionAdministrationPolicyError,
  auctionAdministrationRequestProjection,
  getAuctionAdministrationActionPolicy,
} = require(
  "../../../domain/auctions/auctionAdministrationPolicy"
);
const {
  FreeAgentDraftCorrectionPolicyError,
  validateFreeAgentDraftPublicAllocationResultProjection,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);

const AUCTION_ADMINISTRATION_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1_000;
const AUCTION_ADMINISTRATION_AUTHORIZATION_DENIED =
  "AUCTION_ADMINISTRATION_AUTHORIZATION_DENIED";
const LEAGUE_COMMISSIONER_REQUIRED =
  "LEAGUE_COMMISSIONER_REQUIRED";
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ACTOR_AUTHORITIES = Object.freeze([
  "commissioner",
  "platform_administrator_as_commissioner",
]);
const AUTHORIZATION_AUTHORITIES =
  Object.freeze([
    ...ACTOR_AUTHORITIES,
    "platform_administrator",
  ]);
const RESULT_FIELDS = Object.freeze([
  "action",
  "actorAuthority",
  "data",
  "evidence",
  "httpStatus",
  "replayed",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "createdAtMs",
  "expectedResourceVersion",
  "idempotencyRequestId",
  "jobRunId",
  "preconditionKind",
  "requestSha256",
  "responseSha256",
  "resultId",
  "resultingResourceVersion",
  "version",
]);

function assertMethod(
  value,
  method,
  description
) {
  if (
    !value ||
    typeof value[method] !== "function"
  ) {
    throw new TypeError(
      `auction administration requires ${description}`
    );
  }
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
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value)
      .length !== 0
  ) {
    return false;
  }
  const actual =
    Object.getOwnPropertyNames(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (field, index) =>
        field === expected[index]
    )
  );
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function failRequest(reasonCode) {
  throw new AuctionAdministrationPolicyError(
    AUCTION_ADMINISTRATION_CODES
      .requestInvalid,
    reasonCode
  );
}

function failResult(reasonCode) {
  throw new AuctionAdministrationPolicyError(
    AUCTION_ADMINISTRATION_CODES
      .resultInvalid,
    reasonCode
  );
}

function requireAdministrationAuthority({
  leagueAuthorization,
  authenticated,
  leagueId,
}) {
  try {
    return leagueAuthorization
      .requireCommissioner(
        authenticated,
        leagueId
      );
  } catch (error) {
    if (
      error?.code !==
      LEAGUE_COMMISSIONER_REQUIRED
    ) {
      throw error;
    }
    const denied = new Error(
      "Current auction-administration authority is required."
    );
    denied.name =
      "AuctionAdministrationAuthorizationError";
    denied.code =
      AUCTION_ADMINISTRATION_AUTHORIZATION_DENIED;
    throw denied;
  }
}

function canonicalIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    failRequest("idempotency_key_invalid");
  }
  return value;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs >
      MAX_TIMESTAMP_MS -
        AUCTION_ADMINISTRATION_IDEMPOTENCY_LIFETIME_MS
  ) {
    throw new TypeError(
      "auction administration requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function validateAuthority(
  authority,
  leagueId
) {
  if (
    !isPlainObject(authority) ||
    authority.leagueId !== leagueId ||
    !UUID_PATTERN.test(
      authority.actorUserId || ""
    ) ||
    !UUID_PATTERN.test(
      authority.membershipId || ""
    ) ||
    !AUTHORIZATION_AUTHORITIES.includes(
      authority.authority
    )
  ) {
    throw new TypeError(
      "auction administration requires canonical current authority"
    );
  }
  return Object.freeze({
    actorUserId: authority.actorUserId,
    membershipId: authority.membershipId,
    leagueId,
    authority:
      authority.authority ===
      "commissioner"
        ? "commissioner"
        : "platform_administrator_as_commissioner",
  });
}

function positiveVersion(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value < Number.MAX_SAFE_INTEGER
  );
}

function safeTimestamp(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMESTAMP_MS
  );
}

function validateVersionRelationship(
  rule,
  expectedVersion,
  resultingVersion
) {
  return (
    (
      rule === "expected_plus_one" &&
      resultingVersion ===
        expectedVersion + 1
    ) ||
    (
      rule === "greater_than_expected" &&
      resultingVersion > expectedVersion
    ) ||
    (
      rule === "unchanged" &&
      resultingVersion === expectedVersion
    )
  );
}

function validateContextAwareAuctionData(
  action,
  data
) {
  if (!isPlainObject(data)) {
    failResult("service_result_data_invalid");
  }
  const auction = action === "edit_bid"
    ? data
    : data.auction;
  if (
    !isPlainObject(auction) ||
    ![
      "ordinary_weekly",
      "fad_open_rapid",
      "fad_restricted",
    ].includes(auction.sourceKind)
  ) {
    failResult(
      "service_auction_context_invalid"
    );
  }
  if (action === "edit_bid") {
    return;
  }
  if (action === "remove_bid") {
    const restricted =
      auction.sourceKind === "fad_restricted";
    if (
      restricted
        ? data.restrictedParticipantStatus !==
            "removed" ||
          !positiveVersion(
            data.fadAllocationVersion
          )
        : data.restrictedParticipantStatus !==
            null ||
          data.fadAllocationVersion !== null
    ) {
      failResult(
        "service_removal_context_invalid"
      );
    }
    return;
  }
  if (action === "cancel_auction") {
    if (auction.sourceKind === "ordinary_weekly") {
      if (
        data.fadAllocation !== null ||
        data.recoveryId !== null
      ) {
        failResult(
          "service_cancellation_context_invalid"
        );
      }
      return;
    }
    if (
      auction.sourceKind === "fad_restricted"
        ? auction.status !== "correction_required" ||
          !isPlainObject(data.fadAllocation) ||
          data.fadAllocation.status !==
            "correction_required" ||
          !UUID_PATTERN.test(data.recoveryId || "") ||
          auction.result?.recoveryId !==
            data.recoveryId
        : auction.status !== "cancelled" ||
          data.fadAllocation !== null ||
          !UUID_PATTERN.test(data.recoveryId || "") ||
          auction.result?.recoveryId !==
            data.recoveryId
    ) {
      failResult(
        "service_cancellation_context_invalid"
      );
    }
  }
}

function validateResolutionData(
  data,
  request,
  evidence
) {
  if (
    !hasExactFields(data, [
      "acceptedAtMs",
      "auctionId",
      "occurrenceKey",
      "operationId",
      "pollDescriptor",
      "status",
    ]) ||
    data.auctionId !== request.auctionId ||
    data.operationId !== evidence.jobRunId ||
    !UUID_PATTERN.test(
      data.operationId || ""
    ) ||
    !["pending", "already_succeeded"].includes(
      data.status
    ) ||
    !safeTimestamp(data.acceptedAtMs) ||
    !hasExactFields(
      data.pollDescriptor,
      ["auctionId", "kind", "leagueId"]
    ) ||
    data.pollDescriptor.kind !== "auction" ||
    data.pollDescriptor.leagueId !==
      request.leagueId ||
    data.pollDescriptor.auctionId !==
      request.auctionId
  ) {
    failResult(
      "service_resolution_result_invalid"
    );
  }
  const occurrencePrefix =
    `auction:${request.auctionId}:`;
  const scheduledForText =
    typeof data.occurrenceKey === "string" &&
    data.occurrenceKey.startsWith(
      occurrencePrefix
    )
      ? data.occurrenceKey.slice(
          occurrencePrefix.length
        )
      : "";
  if (
    !/^(0|[1-9][0-9]*)$/u.test(
      scheduledForText
    ) ||
    !safeTimestamp(
      Number(scheduledForText)
    )
  ) {
    failResult(
      "service_resolution_occurrence_invalid"
    );
  }
}

function validateRepositoryResult({
  result,
  request,
  policy,
  authority,
}) {
  if (
    !hasExactFields(result, RESULT_FIELDS) ||
    typeof result.replayed !== "boolean" ||
    result.action !== request.action ||
    !ACTOR_AUTHORITIES.includes(
      result.actorAuthority
    ) ||
    (
      result.replayed === false &&
      result.actorAuthority !==
        authority.authority
    ) ||
    result.httpStatus !== policy.httpStatus ||
    !hasExactFields(
      result.evidence,
      EVIDENCE_FIELDS
    )
  ) {
    failResult("service_result_invalid");
  }
  if (
    request.action === "cancel_auction" &&
    isPlainObject(result.data) &&
    result.data.fadAllocation !== null &&
    result.data.fadAllocation !== undefined
  ) {
    try {
      result = {
        ...result,
        data: {
          ...result.data,
          fadAllocation:
            validateFreeAgentDraftPublicAllocationResultProjection(
              result.data.fadAllocation
            ),
        },
      };
    } catch (error) {
      if (
        error instanceof FreeAgentDraftCorrectionPolicyError
      ) {
        failResult(
          "service_cancellation_context_invalid"
        );
      }
      throw error;
    }
  }
  const evidence = result.evidence;
  if (
    !UUID_PATTERN.test(
      evidence.resultId || ""
    ) ||
    !UUID_PATTERN.test(
      evidence.idempotencyRequestId || ""
    ) ||
    !SHA256_PATTERN.test(
      evidence.requestSha256 || ""
    ) ||
    !SHA256_PATTERN.test(
      evidence.responseSha256 || ""
    ) ||
    evidence.preconditionKind !==
      policy.preconditionKind ||
    evidence.expectedResourceVersion !==
      request.preconditionVersion ||
    !positiveVersion(
      evidence.resultingResourceVersion
    ) ||
    !validateVersionRelationship(
      policy.resultVersionRule,
      request.preconditionVersion,
      evidence.resultingResourceVersion
    ) ||
    !safeTimestamp(evidence.createdAtMs) ||
    evidence.version !== 1
  ) {
    failResult(
      "service_result_evidence_invalid"
    );
  }
  if (request.action === "request_resolution") {
    if (
      !UUID_PATTERN.test(
        evidence.jobRunId || ""
      )
    ) {
      failResult(
        "service_resolution_job_invalid"
      );
    }
    validateResolutionData(
      result.data,
      request,
      evidence
    );
  } else {
    if (evidence.jobRunId !== null) {
      failResult(
        "service_result_job_invalid"
      );
    }
    validateContextAwareAuctionData(
      request.action,
      result.data
    );
  }
  return deepFreeze(result);
}

function createAuctionAdministrationService({
  leagueAuthorization,
  repository,
  clock,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "current league-commissioner or member-platform-administrator authority"
  );
  assertMethod(
    repository,
    "findReplay",
    "an authority-revalidating auction-administration replay repository"
  );
  assertMethod(
    repository,
    "administer",
    "an atomic context-aware administration repository"
  );
  assertMethod(clock, "nowMs", "a server clock");

  function administer({
    action,
    leagueId,
    auctionId,
    bidId,
    input,
    expectedResourceVersion,
    idempotencyKey,
    authenticated,
  }) {
    const policy =
      getAuctionAdministrationActionPolicy(
        action
      );
    const request =
      auctionAdministrationRequestProjection({
        leagueId,
        auctionId,
        bidId,
        action,
        preconditionKind:
          policy.preconditionKind,
        preconditionVersion:
          expectedResourceVersion,
        body: input,
      });
    const clientKey =
      canonicalIdempotencyKey(
        idempotencyKey
    );
    const authority = validateAuthority(
      requireAdministrationAuthority({
        leagueAuthorization,
        authenticated,
        leagueId: request.leagueId,
      }),
      request.leagueId
    );
    const repositoryRequest = {
      leagueId: request.leagueId,
      auctionId: request.auctionId,
      bidId: request.bidId,
      action: request.action,
      body: request.body,
      preconditionVersion:
        request.preconditionVersion,
      actorUserId:
        authority.actorUserId,
      actorMembershipId:
        authority.membershipId,
      idempotencyKey: clientKey,
    };
    const replayed = repository.findReplay(
      repositoryRequest
    );
    if (replayed) {
      return validateRepositoryResult({
        result: replayed,
        request,
        policy,
        authority,
      });
    }
    const occurredAtMs = safeNow(clock);
    const result = repository.administer({
      ...repositoryRequest,
      occurredAtMs,
      idempotencyExpiresAtMs:
        occurredAtMs +
        AUCTION_ADMINISTRATION_IDEMPOTENCY_LIFETIME_MS,
    });
    return validateRepositoryResult({
      result,
      request,
      policy,
      authority,
    });
  }

  return Object.freeze({
    editBid({
      leagueId,
      auctionId,
      bidId,
      input,
      expectedBidVersion,
      idempotencyKey,
      authenticated,
    } = {}) {
      return administer({
        action: "edit_bid",
        leagueId,
        auctionId,
        bidId,
        input,
        expectedResourceVersion:
          expectedBidVersion,
        idempotencyKey,
        authenticated,
      });
    },

    removeBid({
      leagueId,
      auctionId,
      bidId,
      input,
      expectedBidVersion,
      idempotencyKey,
      authenticated,
    } = {}) {
      return administer({
        action: "remove_bid",
        leagueId,
        auctionId,
        bidId,
        input,
        expectedResourceVersion:
          expectedBidVersion,
        idempotencyKey,
        authenticated,
      });
    },

    cancelAuction({
      leagueId,
      auctionId,
      input,
      expectedAuctionVersion,
      idempotencyKey,
      authenticated,
    } = {}) {
      return administer({
        action: "cancel_auction",
        leagueId,
        auctionId,
        bidId: null,
        input,
        expectedResourceVersion:
          expectedAuctionVersion,
        idempotencyKey,
        authenticated,
      });
    },

    requestResolution({
      leagueId,
      auctionId,
      input,
      expectedAuctionVersion,
      idempotencyKey,
      authenticated,
    } = {}) {
      return administer({
        action: "request_resolution",
        leagueId,
        auctionId,
        bidId: null,
        input,
        expectedResourceVersion:
          expectedAuctionVersion,
        idempotencyKey,
        authenticated,
      });
    },
  });
}

module.exports = {
  AUCTION_ADMINISTRATION_IDEMPOTENCY_LIFETIME_MS,
  createAuctionAdministrationService,
};
