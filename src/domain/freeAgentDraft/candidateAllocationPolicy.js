const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const CANDIDATE_ALLOCATION_CODES = Object.freeze({
  inputInvalid:
    "FAD_CANDIDATE_ALLOCATION_INPUT_INVALID",
  offerInvalid:
    "FAD_CANDIDATE_ALLOCATION_OFFER_INVALID",
  floorInvalid:
    "FAD_CANDIDATE_ALLOCATION_FLOOR_INVALID",
  bidInvalid:
    "FAD_CANDIDATE_ALLOCATION_BID_INVALID",
});

const FAD_RESTRICTED_JOINING_MINIMUM_TOTALS =
  Object.freeze({
    1: 150,
    2: 300,
    3: 500,
  });

const OFFER_ELIGIBILITY_STATUSES = new Set([
  "valid",
  "warning",
  "invalid",
]);
const SNAPSHOT_ROW_KINDS = new Set([
  "slot",
  "conflict",
]);
const CARD_ALLOCATION_ELIGIBILITIES = new Set([
  "eligible",
  "excluded_structural_conflict",
  "excluded_over_cap",
]);
const CARD_COMPLETENESS_CODES = new Set([
  "complete",
  "incomplete",
  "conflicted",
]);

class CandidateAllocationPolicyError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft Candidate allocation input is invalid."
    );
    this.name = "CandidateAllocationPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new CandidateAllocationPolicyError(
    code,
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

function exactObject(
  value,
  expectedKeys,
  code,
  reasonCode
) {
  if (!isPlainObject(value)) {
    fail(code, reasonCode);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some(
      (key, index) =>
        key !== sortedExpectedKeys[index]
    )
  ) {
    fail(code, reasonCode);
  }
}

function stableId(value, code, reasonCode) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(code, reasonCode);
  }
  return value;
}

function immutable(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    immutable(child);
  }
  return Object.freeze(value);
}

function roundedAavCents(
  totalValueCents,
  termYears
) {
  const whole = Math.floor(
    totalValueCents / termYears
  );
  const remainder = totalValueCents % termYears;
  return whole + (
    remainder * 2 >= termYears ? 1 : 0
  );
}

function canonicalContract(
  value,
  {
    code,
    fieldReasonCode,
    totalReasonCode,
    termReasonCode,
    precisionReasonCode,
    aavReasonCode,
  }
) {
  exactObject(
    value,
    [
      "totalValueCents",
      "termYears",
      "aavCents",
    ],
    code,
    fieldReasonCode
  );
  if (
    !Number.isSafeInteger(value.termYears) ||
    value.termYears < 1 ||
    value.termYears > 3
  ) {
    fail(code, termReasonCode);
  }
  if (
    !Number.isSafeInteger(value.totalValueCents) ||
    value.totalValueCents <
      value.termYears * 100
  ) {
    fail(code, totalReasonCode);
  }
  if (
    value.termYears > 1 &&
    value.totalValueCents % 100 !== 0
  ) {
    fail(code, precisionReasonCode);
  }
  const expectedAavCents = roundedAavCents(
    value.totalValueCents,
    value.termYears
  );
  if (
    !Number.isSafeInteger(value.aavCents) ||
    value.aavCents !== expectedAavCents
  ) {
    fail(code, aavReasonCode);
  }
  return immutable({
    totalValueCents: value.totalValueCents,
    termYears: value.termYears,
    aavCents: expectedAavCents,
  });
}

function canonicalOffer(value, playerId) {
  const code =
    CANDIDATE_ALLOCATION_CODES.offerInvalid;
  exactObject(
    value,
    [
      "offerId",
      "cardSnapshotId",
      "teamId",
      "playerId",
      "rowKind",
      "totalValueCents",
      "termYears",
      "aavCents",
      "eligibilityStatus",
      "cardAllocationEligibility",
      "cardCompletenessCode",
    ],
    code,
    "offer_fields_invalid"
  );
  const offerId = stableId(
    value.offerId,
    code,
    "offer_id_invalid"
  );
  const canonicalPlayerId = stableId(
    value.playerId,
    code,
    "offer_player_id_invalid"
  );
  if (canonicalPlayerId !== playerId) {
    fail(code, "offer_player_scope_invalid");
  }
  if (!SNAPSHOT_ROW_KINDS.has(value.rowKind)) {
    fail(code, "offer_row_kind_invalid");
  }
  if (
    !OFFER_ELIGIBILITY_STATUSES.has(
      value.eligibilityStatus
    )
  ) {
    fail(code, "offer_eligibility_status_invalid");
  }
  if (
    !CARD_ALLOCATION_ELIGIBILITIES.has(
      value.cardAllocationEligibility
    )
  ) {
    fail(
      code,
      "card_allocation_eligibility_invalid"
    );
  }
  if (
    !CARD_COMPLETENESS_CODES.has(
      value.cardCompletenessCode
    )
  ) {
    fail(code, "card_completeness_code_invalid");
  }
  const contract = canonicalContract(
    {
      totalValueCents: value.totalValueCents,
      termYears: value.termYears,
      aavCents: value.aavCents,
    },
    {
      code,
      fieldReasonCode:
        "offer_contract_fields_invalid",
      totalReasonCode:
        "offer_total_value_invalid",
      termReasonCode: "offer_term_invalid",
      precisionReasonCode:
        "offer_precision_invalid",
      aavReasonCode: "offer_aav_mismatch",
    }
  );
  return immutable({
    offerId,
    cardSnapshotId: stableId(
      value.cardSnapshotId,
      code,
      "card_snapshot_id_invalid"
    ),
    teamId: stableId(
      value.teamId,
      code,
      "offer_team_id_invalid"
    ),
    playerId: canonicalPlayerId,
    rowKind: value.rowKind,
    ...contract,
    eligibilityStatus: value.eligibilityStatus,
    cardAllocationEligibility:
      value.cardAllocationEligibility,
    cardCompletenessCode:
      value.cardCompletenessCode,
  });
}

function safeOfferProjection(offer) {
  return immutable({
    offerId: offer.offerId,
    cardSnapshotId: offer.cardSnapshotId,
    teamId: offer.teamId,
    playerId: offer.playerId,
    totalValueCents: offer.totalValueCents,
    termYears: offer.termYears,
    aavCents: offer.aavCents,
    eligibilityStatus: offer.eligibilityStatus,
    cardCompletenessCode:
      offer.cardCompletenessCode,
  });
}

function rankOffers(left, right) {
  return (
    right.totalValueCents -
      left.totalValueCents ||
    right.aavCents - left.aavCents ||
    left.termYears - right.termYears ||
    left.teamId.localeCompare(right.teamId) ||
    left.offerId.localeCompare(right.offerId)
  );
}

function excludedOffer(offer) {
  if (
    offer.cardAllocationEligibility ===
    "excluded_structural_conflict"
  ) {
    return immutable({
      offerId: offer.offerId,
      teamId: offer.teamId,
      reasonCode:
        "candidate_card_structural_conflict",
    });
  }
  if (
    offer.cardAllocationEligibility ===
    "excluded_over_cap"
  ) {
    return immutable({
      offerId: offer.offerId,
      teamId: offer.teamId,
      reasonCode: "candidate_card_over_cap",
    });
  }
  if (offer.rowKind === "conflict") {
    return immutable({
      offerId: offer.offerId,
      teamId: offer.teamId,
      reasonCode: "candidate_offer_invalid",
    });
  }
  if (offer.eligibilityStatus === "invalid") {
    return immutable({
      offerId: offer.offerId,
      teamId: offer.teamId,
      reasonCode: "candidate_offer_invalid",
    });
  }
  return null;
}

function createRestrictedCandidateMinimum(
  input = {}
) {
  const code =
    CANDIDATE_ALLOCATION_CODES.floorInvalid;
  exactObject(
    input,
    [
      "sourceSnapshotEntryId",
      "teamId",
      "totalValueCents",
      "termYears",
      "aavCents",
    ],
    code,
    "candidate_minimum_fields_invalid"
  );
  const contract = canonicalContract(
    {
      totalValueCents: input.totalValueCents,
      termYears: input.termYears,
      aavCents: input.aavCents,
    },
    {
      code,
      fieldReasonCode:
        "candidate_minimum_contract_fields_invalid",
      totalReasonCode:
        "candidate_minimum_total_invalid",
      termReasonCode:
        "candidate_minimum_term_invalid",
      precisionReasonCode:
        "candidate_minimum_precision_invalid",
      aavReasonCode:
        "candidate_minimum_aav_mismatch",
    }
  );
  return immutable({
    sourceSnapshotEntryId: stableId(
      input.sourceSnapshotEntryId,
      code,
      "candidate_minimum_source_invalid"
    ),
    teamId: stableId(
      input.teamId,
      code,
      "candidate_minimum_team_invalid"
    ),
    minimumTotalValueCents:
      contract.totalValueCents,
    minimumTermYears: contract.termYears,
    minimumAavCents: contract.aavCents,
    isActiveBid: false,
    isLeader: false,
    managerEditCount: 0,
    cooldownAnchorAtMs: null,
    canWinWithoutStrictImprovement: false,
  });
}

function minimumFromOffer(offer) {
  return createRestrictedCandidateMinimum({
    sourceSnapshotEntryId: offer.offerId,
    teamId: offer.teamId,
    totalValueCents: offer.totalValueCents,
    termYears: offer.termYears,
    aavCents: offer.aavCents,
  });
}

function decideCandidateAllocation(input = {}) {
  const inputCode =
    CANDIDATE_ALLOCATION_CODES.inputInvalid;
  exactObject(
    input,
    ["playerId", "offers"],
    inputCode,
    "allocation_fields_invalid"
  );
  const playerId = stableId(
    input.playerId,
    inputCode,
    "player_id_invalid"
  );
  if (!Array.isArray(input.offers)) {
    fail(inputCode, "offers_invalid");
  }

  const offers = input.offers.map((offer) =>
    canonicalOffer(offer, playerId)
  );
  const offerIds = new Set();
  const teamIds = new Set();
  for (const offer of offers) {
    if (offerIds.has(offer.offerId)) {
      fail(
        CANDIDATE_ALLOCATION_CODES.offerInvalid,
        "offer_id_duplicate"
      );
    }
    if (teamIds.has(offer.teamId)) {
      fail(
        CANDIDATE_ALLOCATION_CODES.offerInvalid,
        "offer_team_duplicate"
      );
    }
    offerIds.add(offer.offerId);
    teamIds.add(offer.teamId);
  }

  const excludedOffers = [];
  const eligibleOffers = [];
  for (const offer of offers) {
    const exclusion = excludedOffer(offer);
    if (exclusion) {
      excludedOffers.push(exclusion);
    } else {
      eligibleOffers.push(offer);
    }
  }
  eligibleOffers.sort(rankOffers);
  excludedOffers.sort(
    (left, right) =>
      left.offerId.localeCompare(right.offerId) ||
      left.reasonCode.localeCompare(
        right.reasonCode
      )
  );
  const safeEligibleOffers = eligibleOffers.map(
    safeOfferProjection
  );
  const base = {
    playerId,
    eligibleOfferCount: eligibleOffers.length,
    excludedOfferCount: excludedOffers.length,
    eligibleOffers: safeEligibleOffers,
    excludedOffers,
  };

  if (eligibleOffers.length === 0) {
    return immutable({
      ...base,
      outcome: "no_valid_offer",
      decisionCode: "no_valid_offer",
      winner: null,
      restrictedTie: null,
    });
  }

  const top = eligibleOffers[0];
  const second = eligibleOffers[1] || null;
  if (
    !second ||
    second.totalValueCents <
      top.totalValueCents ||
    second.aavCents < top.aavCents
  ) {
    const decisionCode = !second
      ? "sole_valid_offer"
      : second.totalValueCents <
          top.totalValueCents
        ? "highest_total"
        : "highest_equal_total_aav";
    return immutable({
      ...base,
      outcome: "automatic_award",
      decisionCode,
      winner: safeOfferProjection(top),
      restrictedTie: null,
    });
  }

  const tiedOffers = eligibleOffers.filter(
    (offer) =>
      offer.totalValueCents ===
        top.totalValueCents &&
      offer.termYears === top.termYears
  );
  if (tiedOffers.length < 2) {
    fail(
      CANDIDATE_ALLOCATION_CODES.offerInvalid,
      "top_offer_ranking_ambiguous"
    );
  }
  const floor = immutable({
    totalValueCents: top.totalValueCents,
    termYears: top.termYears,
    aavCents: top.aavCents,
  });
  const participants = tiedOffers
    .map(minimumFromOffer)
    .sort(
      (left, right) =>
        left.teamId.localeCompare(right.teamId) ||
        left.sourceSnapshotEntryId.localeCompare(
          right.sourceSnapshotEntryId
        )
    );
  return immutable({
    ...base,
    outcome: "restricted_auction",
    decisionCode: "exact_total_and_term_tie",
    winner: null,
    restrictedTie: {
      floor,
      participantCount: participants.length,
      participants,
    },
  });
}

function canonicalFloor(value) {
  return canonicalContract(value, {
    code: CANDIDATE_ALLOCATION_CODES.floorInvalid,
    fieldReasonCode: "floor_fields_invalid",
    totalReasonCode: "floor_total_invalid",
    termReasonCode: "floor_term_invalid",
    precisionReasonCode: "floor_precision_invalid",
    aavReasonCode: "floor_aav_mismatch",
  });
}

function canonicalBid(value) {
  return canonicalContract(value, {
    code: CANDIDATE_ALLOCATION_CODES.bidInvalid,
    fieldReasonCode: "bid_fields_invalid",
    totalReasonCode: "bid_total_invalid",
    termReasonCode: "bid_term_invalid",
    precisionReasonCode: "bid_precision_invalid",
    aavReasonCode: "bid_aav_mismatch",
  });
}

function compareTotalFirstAavSecond(
  left,
  right
) {
  const canonicalLeft = canonicalBid(left);
  const canonicalRight = canonicalFloor(right);
  if (
    canonicalLeft.totalValueCents !==
    canonicalRight.totalValueCents
  ) {
    return canonicalLeft.totalValueCents >
      canonicalRight.totalValueCents
      ? 1
      : -1;
  }
  if (
    canonicalLeft.aavCents !==
    canonicalRight.aavCents
  ) {
    return canonicalLeft.aavCents >
      canonicalRight.aavCents
      ? 1
      : -1;
  }
  return 0;
}

function evaluateRestrictedCandidateImprovement(
  input = {}
) {
  exactObject(
    input,
    ["candidateMinimum", "submittedBid"],
    CANDIDATE_ALLOCATION_CODES.inputInvalid,
    "restricted_improvement_fields_invalid"
  );
  const candidateMinimum = canonicalFloor(
    input.candidateMinimum
  );
  const submittedBid = canonicalBid(
    input.submittedBid
  );
  const comparison =
    compareTotalFirstAavSecond(
      submittedBid,
      candidateMinimum
    );
  const isStrictImprovement = comparison > 0;
  const meetsOrdinaryJoiningMinimum =
    submittedBid.totalValueCents >=
    FAD_RESTRICTED_JOINING_MINIMUM_TOTALS[
      submittedBid.termYears
    ];
  const reasonCodes = [];
  if (!isStrictImprovement) {
    reasonCodes.push(
      "restricted_candidate_minimum_not_improved"
    );
  }
  if (!meetsOrdinaryJoiningMinimum) {
    reasonCodes.push(
      "ordinary_joining_minimum_not_met"
    );
  }
  return immutable({
    eligible:
      isStrictImprovement &&
      meetsOrdinaryJoiningMinimum,
    comparison,
    isStrictImprovement,
    meetsOrdinaryJoiningMinimum,
    reasonCodes,
    candidateMinimum,
    submittedBid,
  });
}

function evaluateFallbackFloorBid(input = {}) {
  exactObject(
    input,
    ["floor", "submittedBid"],
    CANDIDATE_ALLOCATION_CODES.inputInvalid,
    "fallback_floor_fields_invalid"
  );
  const floor = canonicalFloor(input.floor);
  const submittedBid = canonicalBid(
    input.submittedBid
  );
  const comparison =
    compareTotalFirstAavSecond(
      submittedBid,
      floor
    );
  const meetsFloor = comparison >= 0;
  return immutable({
    eligible: meetsFloor,
    comparison,
    meetsFloor,
    reasonCodes: meetsFloor
      ? []
      : ["fallback_floor_not_met"],
    floor,
    submittedBid,
  });
}

const FAD_BINDING_NO_RESERVATION_POLICY =
  immutable({
    submissionIsBinding: true,
    confirmsPossibleAggregateIllegality: true,
    reservations: {
      salaryCap: false,
      rosterCapacity: false,
      positionCapacity: false,
      playerOwnership: false,
      otherAuctionCapacity: false,
    },
    validWinsCommitIndependently: true,
    aggregateIllegalityInvalidatesWin: false,
    resolverRequiresSecondConfirmation: false,
  });

function getFadBindingNoReservationPolicy() {
  return FAD_BINDING_NO_RESERVATION_POLICY;
}

module.exports = {
  CANDIDATE_ALLOCATION_CODES,
  CandidateAllocationPolicyError,
  FAD_BINDING_NO_RESERVATION_POLICY,
  FAD_RESTRICTED_JOINING_MINIMUM_TOTALS,
  compareTotalFirstAavSecond,
  createRestrictedCandidateMinimum,
  decideCandidateAllocation,
  evaluateFallbackFloorBid,
  evaluateRestrictedCandidateImprovement,
  getFadBindingNoReservationPolicy,
};
