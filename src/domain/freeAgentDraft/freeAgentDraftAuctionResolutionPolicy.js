const {
  AUCTION_RESOLUTION_CODES,
  AuctionResolutionPolicyError,
  calculateAavCents,
  validateSubmittedValue,
} = require("../auctions/auctionResolutionPolicy");
const {
  CandidateAllocationPolicyError,
  evaluateFallbackFloorBid,
  evaluateRestrictedCandidateImprovement,
} = require("./candidateAllocationPolicy");
const {
  FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
  FreeAgentDraftAuctionDrawPolicyError,
  createFreeAgentDraftAuctionDrawCommitment,
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
} = require("./freeAgentDraftAuctionDrawPolicy");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const AUCTION_STATUSES = new Set([
  "open",
  "resolving",
  "resolved",
  "no_winner",
  "cancelled",
  "failed",
]);
const BID_STATUSES = new Set([
  "active",
  "withdrawn",
  "won",
  "lost",
  "invalid",
  "cancelled",
]);
const TEAM_STATUSES = new Set([
  "active",
  "inactive",
]);
const PARTICIPANT_STATUSES = new Set([
  "active",
  "removed",
]);

const FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_AUCTION_RESOLUTION_INPUT_INVALID",
    contextInvalid:
      "FAD_AUCTION_RESOLUTION_CONTEXT_INVALID",
    auctionInvalid:
      "FAD_AUCTION_RESOLUTION_AUCTION_INVALID",
    floorInvalid:
      "FAD_AUCTION_RESOLUTION_FLOOR_INVALID",
    participantInvalid:
      "FAD_AUCTION_RESOLUTION_PARTICIPANT_INVALID",
    drawInvalid:
      "FAD_AUCTION_RESOLUTION_DRAW_INVALID",
    pricingInvalid:
      "FAD_AUCTION_RESOLUTION_PRICING_INVALID",
    fadBidMustBeNonstarter:
      "FAD_AUCTION_RESOLUTION_BID_MUST_BE_NONSTARTER",
    participantMissing:
      "FAD_AUCTION_RESOLUTION_PARTICIPANT_MISSING",
    participantInactive:
      "FAD_AUCTION_RESOLUTION_PARTICIPANT_INACTIVE",
    participantLinkMismatch:
      "FAD_AUCTION_RESOLUTION_PARTICIPANT_LINK_MISMATCH",
    restrictedFloorNotImproved:
      "FAD_AUCTION_RESOLUTION_RESTRICTED_FLOOR_NOT_IMPROVED",
    fallbackFloorNotMet:
      "FAD_AUCTION_RESOLUTION_FALLBACK_FLOOR_NOT_MET",
  });

class FreeAgentDraftAuctionResolutionPolicyError
  extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft auction resolution input is invalid."
    );
    this.name =
      "FreeAgentDraftAuctionResolutionPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftAuctionResolutionPolicyError(
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
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    fail(code, reasonCode);
  }
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

function stableId(value, code, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(code, reasonCode);
  }
  return value;
}

function safeTimestamp(value, code, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail(code, reasonCode);
  }
  return value;
}

function canonicalContext(value) {
  const code =
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .contextInvalid;
  exactObject(
    value,
    ["sourceKind", "origin", "allocationId"],
    code,
    "context_fields_invalid"
  );
  if (
    value.sourceKind === "fad_restricted" &&
    value.origin === "candidate_tie_restricted"
  ) {
    const allocationId = stableId(
      value.allocationId,
      code,
      "allocation_id_invalid"
    );
    return immutable({
      sourceKind: value.sourceKind,
      origin: value.origin,
      allocationId,
      kind: "restricted",
    });
  }
  if (
    value.sourceKind === "fad_open_rapid" &&
    value.origin ===
      "restricted_no_improvement_fallback"
  ) {
    const allocationId = stableId(
      value.allocationId,
      code,
      "allocation_id_invalid"
    );
    return immutable({
      sourceKind: value.sourceKind,
      origin: value.origin,
      allocationId,
      kind: "fallback",
    });
  }
  if (
    value.sourceKind === "fad_open_rapid" &&
    ["manager_nomination", "queued_nomination"].includes(
      value.origin
    )
  ) {
    if (value.allocationId !== null) {
      fail(code, "open_rapid_allocation_id_not_null");
    }
    return immutable({
      sourceKind: value.sourceKind,
      origin: value.origin,
      allocationId: null,
      kind: "open",
    });
  }
  fail(code, "fad_context_unsupported");
}

function canonicalAuction(value) {
  const code =
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .auctionInvalid;
  exactObject(
    value,
    [
      "id",
      "leagueId",
      "playerId",
      "status",
      "resolvesAtMs",
      "playerOwned",
      "nowMs",
    ],
    code,
    "auction_fields_invalid"
  );
  if (
    !AUCTION_STATUSES.has(value.status) ||
    typeof value.playerOwned !== "boolean"
  ) {
    fail(code, "auction_state_invalid");
  }
  return immutable({
    id: stableId(
      value.id,
      code,
      "auction_id_invalid"
    ),
    leagueId: stableId(
      value.leagueId,
      code,
      "auction_league_id_invalid"
    ),
    playerId: stableId(
      value.playerId,
      code,
      "auction_player_id_invalid"
    ),
    status: value.status,
    resolvesAtMs: safeTimestamp(
      value.resolvesAtMs,
      code,
      "auction_resolves_at_ms_invalid"
    ),
    playerOwned: value.playerOwned,
    nowMs: safeTimestamp(
      value.nowMs,
      code,
      "auction_now_ms_invalid"
    ),
  });
}

function canonicalContract(
  value,
  code,
  reasonPrefix
) {
  exactObject(
    value,
    ["totalValueCents", "termYears", "aavCents"],
    code,
    `${reasonPrefix}_fields_invalid`
  );
  let offer;
  try {
    offer = validateSubmittedValue(
      value.totalValueCents,
      value.termYears
    );
  } catch (error) {
    if (!(error instanceof AuctionResolutionPolicyError)) {
      throw error;
    }
    fail(code, `${reasonPrefix}_contract_invalid`);
  }
  if (value.aavCents !== offer.aavCents) {
    fail(code, `${reasonPrefix}_aav_mismatch`);
  }
  return immutable({
    totalValueCents: offer.totalValueCents,
    termYears: offer.termYears,
    aavCents: offer.aavCents,
  });
}

function canonicalFloor(value, context) {
  if (context.kind === "open") {
    if (value !== null) {
      fail(
        FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
          .floorInvalid,
        "open_rapid_floor_not_null"
      );
    }
    return null;
  }
  return canonicalContract(
    value,
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .floorInvalid,
    "floor"
  );
}

function nullableStableId(
  value,
  code,
  reasonCode
) {
  if (value === null) return null;
  return stableId(value, code, reasonCode);
}

function canonicalParticipant(
  value,
  { context, auction, floor }
) {
  const code =
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .participantInvalid;
  exactObject(
    value,
    [
      "id",
      "leagueId",
      "allocationId",
      "auctionId",
      "teamId",
      "status",
      "activeImprovementBidId",
      "minimumTotalValueCents",
      "minimumTermYears",
      "minimumAavCents",
    ],
    code,
    "participant_fields_invalid"
  );
  if (!PARTICIPANT_STATUSES.has(value.status)) {
    fail(code, "participant_status_invalid");
  }
  const participant = {
    id: stableId(
      value.id,
      code,
      "participant_id_invalid"
    ),
    leagueId: stableId(
      value.leagueId,
      code,
      "participant_league_id_invalid"
    ),
    allocationId: stableId(
      value.allocationId,
      code,
      "participant_allocation_id_invalid"
    ),
    auctionId: stableId(
      value.auctionId,
      code,
      "participant_auction_id_invalid"
    ),
    teamId: stableId(
      value.teamId,
      code,
      "participant_team_id_invalid"
    ),
    status: value.status,
    activeImprovementBidId: nullableStableId(
      value.activeImprovementBidId,
      code,
      "participant_active_bid_id_invalid"
    ),
    minimumTotalValueCents:
      value.minimumTotalValueCents,
    minimumTermYears: value.minimumTermYears,
    minimumAavCents: value.minimumAavCents,
  };
  const minimum = canonicalContract(
    {
      totalValueCents:
        participant.minimumTotalValueCents,
      termYears: participant.minimumTermYears,
      aavCents: participant.minimumAavCents,
    },
    code,
    "participant_minimum"
  );
  if (
    participant.leagueId !== auction.leagueId ||
    participant.allocationId !==
      context.allocationId ||
    participant.auctionId !== auction.id
  ) {
    fail(code, "participant_scope_invalid");
  }
  if (
    minimum.totalValueCents !==
      floor.totalValueCents ||
    minimum.termYears !== floor.termYears ||
    minimum.aavCents !== floor.aavCents
  ) {
    fail(code, "participant_floor_mismatch");
  }
  if (
    participant.status === "removed" &&
    participant.activeImprovementBidId !== null
  ) {
    fail(code, "removed_participant_bid_link_invalid");
  }
  return immutable(participant);
}

function canonicalParticipants(
  value,
  { context, auction, floor }
) {
  const code =
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .participantInvalid;
  if (!Array.isArray(value)) {
    fail(code, "participants_invalid");
  }
  if (
    context.kind === "fallback" ||
    context.kind === "open"
  ) {
    if (value.length !== 0) {
      fail(
        code,
        context.kind === "fallback"
          ? "fallback_participants_not_empty"
          : "open_rapid_participants_not_empty"
      );
    }
    return immutable([]);
  }
  if (value.length < 2) {
    fail(code, "restricted_participant_count_invalid");
  }
  const participants = value.map((participant) =>
    canonicalParticipant(participant, {
      context,
      auction,
      floor,
    })
  );
  const participantIds = new Set();
  const teamIds = new Set();
  const activeBidIds = new Set();
  for (const participant of participants) {
    if (participantIds.has(participant.id)) {
      fail(code, "participant_id_duplicate");
    }
    if (teamIds.has(participant.teamId)) {
      fail(code, "participant_team_duplicate");
    }
    if (
      participant.activeImprovementBidId !== null &&
      activeBidIds.has(
        participant.activeImprovementBidId
      )
    ) {
      fail(code, "participant_active_bid_duplicate");
    }
    participantIds.add(participant.id);
    teamIds.add(participant.teamId);
    if (participant.activeImprovementBidId !== null) {
      activeBidIds.add(
        participant.activeImprovementBidId
      );
    }
  }
  return immutable(
    participants.sort(
      (left, right) =>
        left.teamId.localeCompare(right.teamId) ||
        left.id.localeCompare(right.id)
    )
  );
}

function canonicalDraw(value, auctionId) {
  const code =
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .drawInvalid;
  exactObject(
    value,
    ["algorithmVersion", "commitmentHex", "nonceBytes"],
    code,
    "draw_fields_invalid"
  );
  if (
    value.algorithmVersion !==
      FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION ||
    typeof value.commitmentHex !== "string" ||
    !HEX_64_PATTERN.test(value.commitmentHex) ||
    !(value.nonceBytes instanceof Uint8Array) ||
    value.nonceBytes.byteLength !== 32
  ) {
    fail(code, "draw_evidence_invalid");
  }
  const nonceBytes = new Uint8Array(
    value.nonceBytes
  );
  try {
    const actual =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId,
        nonceBytes,
      });
    if (
      actual.algorithmVersion !==
        value.algorithmVersion ||
      actual.commitmentHex !== value.commitmentHex
    ) {
      fail(code, "draw_commitment_mismatch");
    }
  } catch (error) {
    if (
      error instanceof
        FreeAgentDraftAuctionResolutionPolicyError
    ) {
      throw error;
    }
    if (
      error instanceof
      FreeAgentDraftAuctionDrawPolicyError
    ) {
      fail(code, "draw_evidence_invalid");
    }
    throw error;
  }
  return {
    algorithmVersion: value.algorithmVersion,
    commitmentHex: value.commitmentHex,
    nonceBytes,
  };
}

function inspectBid(
  value,
  auction,
  { allowStartingBid }
) {
  let bidId = null;
  try {
    exactObject(
      value,
      [
        "id",
        "leagueId",
        "auctionId",
        "teamId",
        "status",
        "teamStatus",
        "totalValueCents",
        "termYears",
        "lowestOfferedAavCents",
        "lowestOfferedTotalValueCents",
        "firstSubmittedAtMs",
        "isStartingBid",
        "authorityValid",
      ],
      AUCTION_RESOLUTION_CODES.bidInvalid,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    bidId = stableId(
      value.id,
      AUCTION_RESOLUTION_CODES.bidInvalid,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    const leagueId = stableId(
      value.leagueId,
      AUCTION_RESOLUTION_CODES.bidInvalid,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    const auctionId = stableId(
      value.auctionId,
      AUCTION_RESOLUTION_CODES.bidInvalid,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    const teamId = stableId(
      value.teamId,
      AUCTION_RESOLUTION_CODES.bidInvalid,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    if (
      leagueId !== auction.leagueId ||
      auctionId !== auction.id
    ) {
      fail(
        AUCTION_RESOLUTION_CODES.bidScopeInvalid,
        AUCTION_RESOLUTION_CODES.bidScopeInvalid
      );
    }
    if (
      !BID_STATUSES.has(value.status) ||
      value.status !== "active"
    ) {
      fail(
        AUCTION_RESOLUTION_CODES.bidInactive,
        AUCTION_RESOLUTION_CODES.bidInactive
      );
    }
    if (
      !TEAM_STATUSES.has(value.teamStatus) ||
      value.teamStatus !== "active"
    ) {
      fail(
        AUCTION_RESOLUTION_CODES.teamInactive,
        AUCTION_RESOLUTION_CODES.teamInactive
      );
    }
    if (value.authorityValid !== true) {
      fail(
        AUCTION_RESOLUTION_CODES.authorityInvalid,
        AUCTION_RESOLUTION_CODES.authorityInvalid
      );
    }
    if (
      typeof value.isStartingBid !== "boolean" ||
      (!allowStartingBid && value.isStartingBid)
    ) {
      fail(
        typeof value.isStartingBid === "boolean"
          ? FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
              .fadBidMustBeNonstarter
          : AUCTION_RESOLUTION_CODES.bidInvalid,
        typeof value.isStartingBid === "boolean"
          ? FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
              .fadBidMustBeNonstarter
          : AUCTION_RESOLUTION_CODES.bidInvalid
      );
    }
    let offer;
    try {
      offer = validateSubmittedValue(
        value.totalValueCents,
        value.termYears
      );
    } catch (error) {
      if (!(error instanceof AuctionResolutionPolicyError)) {
        throw error;
      }
      fail(
        AUCTION_RESOLUTION_CODES.valueInvalid,
        AUCTION_RESOLUTION_CODES.valueInvalid
      );
    }
    if (
      !Number.isSafeInteger(
        value.lowestOfferedTotalValueCents
      ) ||
      value.lowestOfferedTotalValueCents < 1 ||
      value.lowestOfferedTotalValueCents >
        offer.totalValueCents
    ) {
      fail(
        AUCTION_RESOLUTION_CODES.lowestTotalInvalid,
        AUCTION_RESOLUTION_CODES.lowestTotalInvalid
      );
    }
    if (
      !Number.isSafeInteger(
        value.lowestOfferedAavCents
      ) ||
      value.lowestOfferedAavCents < 1 ||
      value.lowestOfferedAavCents > offer.aavCents
    ) {
      fail(
        AUCTION_RESOLUTION_CODES.lowestAavInvalid,
        AUCTION_RESOLUTION_CODES.lowestAavInvalid
      );
    }
    return {
      bid: immutable({
        id: bidId,
        leagueId,
        auctionId,
        teamId,
        totalValueCents: offer.totalValueCents,
        termYears: offer.termYears,
        aavCents: offer.aavCents,
        lowestOfferedAavCents:
          value.lowestOfferedAavCents,
        lowestOfferedTotalValueCents:
          value.lowestOfferedTotalValueCents,
        firstSubmittedAtMs: safeTimestamp(
          value.firstSubmittedAtMs,
          AUCTION_RESOLUTION_CODES.bidInvalid,
          AUCTION_RESOLUTION_CODES.bidInvalid
        ),
      }),
      skipped: null,
    };
  } catch (error) {
    if (
      !(error instanceof
        FreeAgentDraftAuctionResolutionPolicyError)
    ) {
      throw error;
    }
    return {
      bid: null,
      skipped: immutable({
        bidId,
        reasonCode: error.reasonCode,
      }),
    };
  }
}

function participantReason(bid, participant) {
  if (!participant) {
    return FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .participantMissing;
  }
  if (participant.status !== "active") {
    return FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .participantInactive;
  }
  if (
    participant.activeImprovementBidId !== bid.id
  ) {
    return FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .participantLinkMismatch;
  }
  try {
    const result =
      evaluateRestrictedCandidateImprovement({
        candidateMinimum: {
          totalValueCents:
            participant.minimumTotalValueCents,
          termYears: participant.minimumTermYears,
          aavCents: participant.minimumAavCents,
        },
        submittedBid: {
          totalValueCents: bid.totalValueCents,
          termYears: bid.termYears,
          aavCents: bid.aavCents,
        },
      });
    if (result.eligible) return null;
    return result.isStrictImprovement
      ? AUCTION_RESOLUTION_CODES.valueInvalid
      : FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
          .restrictedFloorNotImproved;
  } catch (error) {
    if (error instanceof CandidateAllocationPolicyError) {
      return FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
        .restrictedFloorNotImproved;
    }
    throw error;
  }
}

function fallbackFloorReason(bid, floor) {
  try {
    const result = evaluateFallbackFloorBid({
      floor,
      submittedBid: {
        totalValueCents: bid.totalValueCents,
        termYears: bid.termYears,
        aavCents: bid.aavCents,
      },
    });
    return result.eligible
      ? null
      : FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
          .fallbackFloorNotMet;
  } catch (error) {
    if (error instanceof CandidateAllocationPolicyError) {
      return FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
        .fallbackFloorNotMet;
    }
    throw error;
  }
}

function rankBids(left, right) {
  return (
    right.totalValueCents - left.totalValueCents ||
    right.aavCents - left.aavCents ||
    left.id.localeCompare(right.id)
  );
}

function safeRankedBid(bid, rank) {
  return immutable({
    rank,
    bidId: bid.id,
    teamId: bid.teamId,
    totalValueCents: bid.totalValueCents,
    termYears: bid.termYears,
    aavCents: bid.aavCents,
    lowestOfferedAavCents:
      bid.lowestOfferedAavCents,
    lowestOfferedTotalValueCents:
      bid.lowestOfferedTotalValueCents,
    firstSubmittedAtMs: bid.firstSubmittedAtMs,
  });
}

function rankedProjection(eligible) {
  let rank = 0;
  let previous = null;
  return immutable(
    eligible.map((bid, index) => {
      if (
        !previous ||
        previous.totalValueCents !==
          bid.totalValueCents ||
        previous.aavCents !== bid.aavCents
      ) {
        rank = index + 1;
      }
      previous = bid;
      return safeRankedBid(bid, rank);
    })
  );
}

function tiedTopProjection(tiedTop) {
  return immutable(
    tiedTop.map((bid) => ({
      bidId: bid.id,
      teamId: bid.teamId,
      totalValueCents: bid.totalValueCents,
      termYears: bid.termYears,
      aavCents: bid.aavCents,
    }))
  );
}

function drawRevealWithTeam(
  drawReveal,
  selectedTeamId
) {
  return immutable({
    algorithmVersion: drawReveal.algorithmVersion,
    nonceHex: drawReveal.nonceHex,
    selectionUsed: drawReveal.selectionUsed,
    orderedBidIds: [...drawReveal.orderedBidIds],
    counter: drawReveal.counter,
    digestHex: drawReveal.digestHex,
    selectedIndex: drawReveal.selectedIndex,
    selectedBidId: drawReveal.selectedBidId,
    selectedTeamId,
  });
}

function noSelectionReveal(auction, draw) {
  try {
    return drawRevealWithTeam(
      createFreeAgentDraftAuctionNoSelectionReveal({
        auctionId: auction.id,
        commitmentHex: draw.commitmentHex,
        nonceBytes: draw.nonceBytes,
      }),
      null
    );
  } catch (error) {
    if (error instanceof FreeAgentDraftAuctionDrawPolicyError) {
      fail(
        FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
          .drawInvalid,
        "draw_reveal_invalid"
      );
    }
    throw error;
  }
}

function selectedReveal(
  auction,
  draw,
  tiedTop
) {
  try {
    const reveal =
      createFreeAgentDraftAuctionDrawReveal({
        auctionId: auction.id,
        commitmentHex: draw.commitmentHex,
        nonceBytes: draw.nonceBytes,
        rolloverAtMs: auction.resolvesAtMs,
        tiedBidIds: tiedTop.map((bid) => bid.id),
      });
    const selected = tiedTop.find(
      (bid) => bid.id === reveal.selectedBidId
    );
    if (!selected) {
      fail(
        FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
          .drawInvalid,
        "draw_selected_bid_invalid"
      );
    }
    return immutable({
      winner: selected,
      drawReveal: drawRevealWithTeam(
        reveal,
        selected.teamId
      ),
    });
  } catch (error) {
    if (
      error instanceof
        FreeAgentDraftAuctionResolutionPolicyError
    ) {
      throw error;
    }
    if (error instanceof FreeAgentDraftAuctionDrawPolicyError) {
      fail(
        FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
          .drawInvalid,
        "draw_reveal_invalid"
      );
    }
    throw error;
  }
}

function restrictedFloorPrice(
  normalTotalValueCents,
  termYears,
  floor
) {
  const requiredTotalValueCents = Math.max(
    normalTotalValueCents,
    floor.totalValueCents
  );
  let aavCents = Math.max(
    100,
    Math.ceil(
      requiredTotalValueCents / termYears / 25
    ) * 25
  );
  let totalValueCents = aavCents * termYears;
  if (
    totalValueCents === floor.totalValueCents &&
    aavCents < floor.aavCents
  ) {
    aavCents += 25;
    totalValueCents = aavCents * termYears;
  }
  return totalValueCents;
}

function winnerProjection({
  winner,
  competitor,
  context,
  floor,
}) {
  const highestCompetingAavCents =
    competitor?.aavCents ?? null;
  const highestCompetingTotalValueCents =
    competitor?.totalValueCents ?? null;
  const requiredWinningTotalValueCents = competitor
    ? Math.max(
        winner.lowestOfferedTotalValueCents,
        competitor.totalValueCents
      )
    : winner.totalValueCents;
  const legacySubmittedPrice =
    requiredWinningTotalValueCents ===
      winner.totalValueCents &&
    (
      winner.totalValueCents % winner.termYears !== 0 ||
      (
        winner.totalValueCents / winner.termYears
      ) % 25 !== 0
    );
  let requiredWinningAavCents = legacySubmittedPrice
    ? winner.aavCents
    : Math.max(
        100,
        Math.ceil(
          requiredWinningTotalValueCents /
            winner.termYears /
            25
        ) * 25
      );
  let finalTotalValueCents = legacySubmittedPrice
    ? winner.totalValueCents
    : requiredWinningAavCents * winner.termYears;
  if (context.kind === "restricted") {
    finalTotalValueCents = restrictedFloorPrice(
      finalTotalValueCents,
      winner.termYears,
      floor
    );
    requiredWinningAavCents =
      finalTotalValueCents / winner.termYears;
  }
  if (
    !Number.isSafeInteger(finalTotalValueCents) ||
    finalTotalValueCents < 1 ||
    finalTotalValueCents >
      winner.totalValueCents
  ) {
    fail(
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
        .pricingInvalid,
      "winning_price_exceeds_submitted_total"
    );
  }
  return immutable({
    bidId: winner.id,
    teamId: winner.teamId,
    submittedTotalValueCents:
      winner.totalValueCents,
    submittedTermYears: winner.termYears,
    submittedAavCents: winner.aavCents,
    lowestOfferedAavCents:
      winner.lowestOfferedAavCents,
    lowestOfferedTotalValueCents:
      winner.lowestOfferedTotalValueCents,
    highestCompetingAavCents,
    highestCompetingTotalValueCents,
    persistedSecondPriceInputCents:
      highestCompetingTotalValueCents ?? 0,
    requiredWinningTotalValueCents,
    requiredWinningAavCents,
    finalTotalValueCents,
    finalAavCents: calculateAavCents(
      finalTotalValueCents,
      winner.termYears
    ),
  });
}

function evaluateFreeAgentDraftAuctionResolution(
  input = {}
) {
  exactObject(
    input,
    [
      "context",
      "auction",
      "bids",
      "participants",
      "floor",
      "draw",
    ],
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
      .inputInvalid,
    "resolution_fields_invalid"
  );
  if (!Array.isArray(input.bids)) {
    fail(
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
        .inputInvalid,
      "bids_invalid"
    );
  }
  const context = canonicalContext(input.context);
  const auction = canonicalAuction(input.auction);
  const floor = canonicalFloor(input.floor, context);
  const participants = canonicalParticipants(
    input.participants,
    { context, auction, floor }
  );
  const draw = canonicalDraw(input.draw, auction.id);
  const base = {
    auctionId: auction.id,
    leagueId: auction.leagueId,
    allocationId: context.allocationId,
    auctionType: context.sourceKind,
    dueAtMs: auction.resolvesAtMs,
  };
  if (
    auction.status !== "open" &&
    auction.status !== "resolving"
  ) {
    return immutable({
      ...base,
      outcome: "not_due",
      reason: "auction_not_open",
    });
  }
  if (auction.playerOwned) {
    fail(
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
        .auctionInvalid,
      "player_already_owned"
    );
  }
  if (auction.nowMs < auction.resolvesAtMs) {
    return immutable({
      ...base,
      outcome: "not_due",
      reason: "before_deadline",
    });
  }

  const inspected = input.bids.map((bid) =>
    inspectBid(bid, auction, {
      allowStartingBid: context.kind === "open",
    })
  );
  const valid = inspected
    .filter(({ bid }) => bid)
    .map(({ bid }) => bid);
  const skipped = inspected
    .filter(({ skipped: value }) => value)
    .map(({ skipped: value }) => value);
  const idCounts = new Map();
  const teamCounts = new Map();
  for (const bid of valid) {
    idCounts.set(
      bid.id,
      (idCounts.get(bid.id) || 0) + 1
    );
    teamCounts.set(
      bid.teamId,
      (teamCounts.get(bid.teamId) || 0) + 1
    );
  }
  const participantsByTeam = new Map(
    participants.map((participant) => [
      participant.teamId,
      participant,
    ])
  );
  const eligible = [];
  for (const bid of valid) {
    if (
      idCounts.get(bid.id) > 1 ||
      teamCounts.get(bid.teamId) > 1
    ) {
      skipped.push(
        immutable({
          bidId: bid.id,
          reasonCode:
            AUCTION_RESOLUTION_CODES.bidDuplicate,
        })
      );
      continue;
    }
    const reasonCode = context.kind === "restricted"
      ? participantReason(
          bid,
          participantsByTeam.get(bid.teamId)
        )
      : context.kind === "fallback"
        ? fallbackFloorReason(bid, floor)
        : null;
    if (reasonCode) {
      skipped.push(
        immutable({ bidId: bid.id, reasonCode })
      );
    } else {
      eligible.push(bid);
    }
  }
  eligible.sort(rankBids);
  const skippedBids = immutable(
    skipped.sort(
      (left, right) =>
        (left.bidId || "").localeCompare(
          right.bidId || ""
        ) ||
        left.reasonCode.localeCompare(
          right.reasonCode
        )
    )
  );
  const terminalBase = {
    ...base,
    eligibleBidCount: eligible.length,
    skippedBids,
    rankedBids: rankedProjection(eligible),
  };
  if (eligible.length === 0) {
    return immutable({
      ...terminalBase,
      outcome:
        context.kind === "restricted"
          ? "restricted_fallback"
          : "no_winner",
      tiedTopBids: immutable([]),
      drawReveal: noSelectionReveal(
        auction,
        draw
      ),
    });
  }

  const top = eligible[0];
  const tiedTop = eligible.filter(
    (bid) =>
      bid.totalValueCents ===
        top.totalValueCents &&
      bid.aavCents === top.aavCents
  );
  let winner = top;
  let drawReveal;
  let safeTiedTop = immutable([]);
  if (tiedTop.length > 1) {
    const selection = selectedReveal(
      auction,
      draw,
      tiedTop
    );
    winner = selection.winner;
    drawReveal = selection.drawReveal;
    safeTiedTop = tiedTopProjection(tiedTop);
  } else {
    drawReveal = noSelectionReveal(auction, draw);
  }
  const competitor = eligible
    .filter((bid) => bid.id !== winner.id)
    .sort(rankBids)[0] || null;
  return immutable({
    ...terminalBase,
    outcome: "winner",
    tiedTopBids: safeTiedTop,
    drawReveal,
    winner: winnerProjection({
      winner,
      competitor,
      context,
      floor,
    }),
  });
}

module.exports = {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES,
  FreeAgentDraftAuctionResolutionPolicyError,
  evaluateFreeAgentDraftAuctionResolution,
};
