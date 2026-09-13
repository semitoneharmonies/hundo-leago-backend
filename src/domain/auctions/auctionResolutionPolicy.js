const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const AUCTION_RESOLUTION_CODES = Object.freeze({
  inputInvalid: "AUCTION_RESOLUTION_INPUT_INVALID",
  auctionInvalid: "AUCTION_RESOLUTION_AUCTION_INVALID",
  bidInvalid: "AUCTION_RESOLUTION_BID_INVALID",
  bidScopeInvalid: "AUCTION_RESOLUTION_BID_SCOPE_INVALID",
  bidDuplicate: "AUCTION_RESOLUTION_BID_DUPLICATE",
  bidInactive: "AUCTION_RESOLUTION_BID_INACTIVE",
  teamInactive: "AUCTION_RESOLUTION_TEAM_INACTIVE",
  authorityInvalid: "AUCTION_RESOLUTION_AUTHORITY_INVALID",
  valueInvalid: "AUCTION_RESOLUTION_VALUE_INVALID",
  lowestAavInvalid: "AUCTION_RESOLUTION_LOWEST_AAV_INVALID",
  lowestTotalInvalid: "AUCTION_RESOLUTION_LOWEST_TOTAL_INVALID",
});

class AuctionResolutionPolicyError extends Error {
  constructor(reasonCode) {
    super("The auction resolution input is invalid.");
    this.name = "AuctionResolutionPolicyError";
    this.code = AUCTION_RESOLUTION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new AuctionResolutionPolicyError(reasonCode);
}

function freeze(value) {
  return Object.freeze(value);
}

function exactObject(value, keys, reasonCode) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== [...keys].sort().join("|")
  ) {
    fail(reasonCode);
  }
}

function stableId(value, reasonCode) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(reasonCode);
  }
  return value;
}

function safeTimestamp(
  value,
  {
    nullable = false,
    reasonCode = AUCTION_RESOLUTION_CODES.auctionInvalid,
  } = {}
) {
  if (nullable && value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail(reasonCode);
  }
  return value;
}

function calculateAavCents(totalValueCents, termYears) {
  if (
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < 1 ||
    !Number.isSafeInteger(termYears) ||
    termYears < 1 ||
    termYears > 3
  ) {
    fail(AUCTION_RESOLUTION_CODES.valueInvalid);
  }
  const whole = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return whole + (remainder * 2 >= termYears ? 1 : 0);
}

function validateSubmittedValue(totalValueCents, termYears) {
  const isLegacyOffer =
    termYears === 1 ||
    totalValueCents % 100 === 0;
  const isAavFirstOffer =
    totalValueCents % termYears === 0 &&
    (totalValueCents / termYears) % 25 === 0;
  if (
    !Number.isSafeInteger(termYears) ||
    termYears < 1 ||
    termYears > 3 ||
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < termYears * 100 ||
    (!isLegacyOffer && !isAavFirstOffer)
  ) {
    fail(AUCTION_RESOLUTION_CODES.valueInvalid);
  }
  return freeze({
    totalValueCents,
    termYears,
    aavCents: calculateAavCents(totalValueCents, termYears),
  });
}

function minimumAuctionTotalCents(termYears, isStartingBid) {
  if (![1, 2, 3].includes(termYears) || typeof isStartingBid !== "boolean") {
    fail(AUCTION_RESOLUTION_CODES.valueInvalid);
  }
  if (isStartingBid) return termYears * 100;
  return Object.freeze({ 1: 150, 2: 300, 3: 500 })[termYears];
}

function smallestValidTotalCents(requiredAavCents, termYears) {
  if (
    !Number.isSafeInteger(requiredAavCents) ||
    requiredAavCents < 1 ||
    !Number.isSafeInteger(termYears) ||
    termYears < 1 ||
    termYears > 3
  ) {
    fail(AUCTION_RESOLUTION_CODES.valueInvalid);
  }
  const required = BigInt(requiredAavCents);
  const term = BigInt(termYears);
  const rawNumerator = (2n * required - 1n) * term;
  let total = (rawNumerator + 1n) / 2n;
  const minimum = term * 100n;
  if (total < minimum) total = minimum;
  if (termYears > 1) total = ((total + 99n) / 100n) * 100n;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(AUCTION_RESOLUTION_CODES.valueInvalid);
  }
  return Number(total);
}

function canonicalAuction(input) {
  exactObject(
    input,
    [
      "id",
      "leagueId",
      "playerId",
      "status",
      "resolvesAtMs",
      "playoffsStartAtMs",
      "playerOwned",
      "nowMs",
    ],
    AUCTION_RESOLUTION_CODES.auctionInvalid
  );
  if (typeof input.status !== "string" || typeof input.playerOwned !== "boolean") {
    fail(AUCTION_RESOLUTION_CODES.auctionInvalid);
  }
  return freeze({
    id: stableId(input.id, AUCTION_RESOLUTION_CODES.auctionInvalid),
    leagueId: stableId(input.leagueId, AUCTION_RESOLUTION_CODES.auctionInvalid),
    playerId: stableId(input.playerId, AUCTION_RESOLUTION_CODES.auctionInvalid),
    status: input.status,
    resolvesAtMs: safeTimestamp(input.resolvesAtMs),
    playoffsStartAtMs: safeTimestamp(input.playoffsStartAtMs, { nullable: true }),
    playerOwned: input.playerOwned,
    nowMs: safeTimestamp(input.nowMs),
  });
}

function inspectBid(input, auction) {
  let id = null;
  try {
    exactObject(
      input,
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
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    id = stableId(input.id, AUCTION_RESOLUTION_CODES.bidInvalid);
    const leagueId = stableId(
      input.leagueId,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    const auctionId = stableId(
      input.auctionId,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    const teamId = stableId(
      input.teamId,
      AUCTION_RESOLUTION_CODES.bidInvalid
    );
    if (leagueId !== auction.leagueId || auctionId !== auction.id) {
      fail(AUCTION_RESOLUTION_CODES.bidScopeInvalid);
    }
    if (input.status !== "active") {
      fail(AUCTION_RESOLUTION_CODES.bidInactive);
    }
    if (input.teamStatus !== "active") {
      fail(AUCTION_RESOLUTION_CODES.teamInactive);
    }
    if (input.authorityValid !== true) {
      fail(AUCTION_RESOLUTION_CODES.authorityInvalid);
    }
    const offer = validateSubmittedValue(
      input.totalValueCents,
      input.termYears
    );
    if (
      offer.totalValueCents <
      minimumAuctionTotalCents(offer.termYears, input.isStartingBid)
    ) {
      fail(AUCTION_RESOLUTION_CODES.valueInvalid);
    }
    if (
      !Number.isSafeInteger(input.lowestOfferedAavCents) ||
      input.lowestOfferedAavCents < 1 ||
      input.lowestOfferedAavCents > offer.aavCents
    ) {
      fail(AUCTION_RESOLUTION_CODES.lowestAavInvalid);
    }
    if (
      !Number.isSafeInteger(
        input.lowestOfferedTotalValueCents
      ) ||
      input.lowestOfferedTotalValueCents < 1 ||
      input.lowestOfferedTotalValueCents >
        offer.totalValueCents
    ) {
      fail(
        AUCTION_RESOLUTION_CODES.lowestTotalInvalid
      );
    }
    return {
      bid: freeze({
        id,
        leagueId,
        auctionId,
        teamId,
        totalValueCents: offer.totalValueCents,
        termYears: offer.termYears,
        aavCents: offer.aavCents,
        lowestOfferedAavCents: input.lowestOfferedAavCents,
        lowestOfferedTotalValueCents:
          input.lowestOfferedTotalValueCents,
        firstSubmittedAtMs: safeTimestamp(input.firstSubmittedAtMs, {
          reasonCode: AUCTION_RESOLUTION_CODES.bidInvalid,
        }),
      }),
      skipped: null,
    };
  } catch (error) {
    if (!(error instanceof AuctionResolutionPolicyError)) throw error;
    return {
      bid: null,
      skipped: freeze({
        bidId: id,
        reasonCode: error.reasonCode,
      }),
    };
  }
}

function rankBids(left, right) {
  return (
    right.totalValueCents - left.totalValueCents ||
    right.aavCents - left.aavCents ||
    left.firstSubmittedAtMs - right.firstSubmittedAtMs ||
    left.id.localeCompare(right.id)
  );
}

function safeRankedBid(bid, rank) {
  return freeze({
    rank,
    bidId: bid.id,
    teamId: bid.teamId,
    totalValueCents: bid.totalValueCents,
    termYears: bid.termYears,
    aavCents: bid.aavCents,
    lowestOfferedAavCents: bid.lowestOfferedAavCents,
    lowestOfferedTotalValueCents:
      bid.lowestOfferedTotalValueCents,
    firstSubmittedAtMs: bid.firstSubmittedAtMs,
  });
}

function evaluateAuctionResolution(input) {
  exactObject(
    input,
    ["auction", "bids"],
    AUCTION_RESOLUTION_CODES.inputInvalid
  );
  if (!Array.isArray(input.bids)) {
    fail(AUCTION_RESOLUTION_CODES.inputInvalid);
  }
  const auction = canonicalAuction(input.auction);
  const playoffDue =
    auction.playoffsStartAtMs !== null &&
    auction.nowMs >= auction.playoffsStartAtMs;
  const scheduledDue = auction.nowMs >= auction.resolvesAtMs;
  const dueAtMs = playoffDue
    ? auction.playoffsStartAtMs
    : auction.resolvesAtMs;
  const base = {
    auctionId: auction.id,
    leagueId: auction.leagueId,
    dueAtMs,
  };
  if (auction.status !== "open") {
    return freeze({ ...base, outcome: "not_due", reason: "auction_not_open" });
  }
  if (!playoffDue && !scheduledDue) {
    return freeze({ ...base, outcome: "not_due", reason: "before_deadline" });
  }
  if (playoffDue) {
    return freeze({
      ...base,
      outcome: "cancelled_season_closed",
      skippedBids: freeze([]),
    });
  }
  if (auction.playerOwned) {
    return freeze({
      ...base,
      outcome: "cancelled_unavailable",
      skippedBids: freeze([]),
    });
  }

  const inspected = input.bids.map((bid) => inspectBid(bid, auction));
  const valid = inspected.filter(({ bid }) => bid).map(({ bid }) => bid);
  const skipped = inspected.filter(({ skipped: value }) => value).map(({ skipped: value }) => value);
  const duplicateIds = new Set();
  const duplicateTeams = new Set();
  const idCounts = new Map();
  const teamCounts = new Map();
  for (const bid of valid) {
    idCounts.set(bid.id, (idCounts.get(bid.id) || 0) + 1);
    teamCounts.set(bid.teamId, (teamCounts.get(bid.teamId) || 0) + 1);
  }
  for (const [id, count] of idCounts) if (count > 1) duplicateIds.add(id);
  for (const [teamId, count] of teamCounts) if (count > 1) duplicateTeams.add(teamId);
  const eligible = [];
  for (const bid of valid) {
    if (duplicateIds.has(bid.id) || duplicateTeams.has(bid.teamId)) {
      skipped.push(
        freeze({
          bidId: bid.id,
          reasonCode: AUCTION_RESOLUTION_CODES.bidDuplicate,
        })
      );
    } else {
      eligible.push(bid);
    }
  }
  eligible.sort(rankBids);
  const skippedBids = freeze(
    skipped.sort((left, right) =>
      (left.bidId || "").localeCompare(right.bidId || "") ||
      left.reasonCode.localeCompare(right.reasonCode)
    )
  );
  if (eligible.length === 0) {
    return freeze({
      ...base,
      outcome: "no_winner",
      eligibleBidCount: 0,
      skippedBids,
    });
  }

  const rankedBids = freeze(
    eligible.map((bid, index) => safeRankedBid(bid, index + 1))
  );
  const winner = eligible[0];
  const competitor = eligible[1] || null;
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
  const requiredWinningAavCents = legacySubmittedPrice
    ? winner.aavCents
    : Math.max(
        100,
        Math.ceil(
          requiredWinningTotalValueCents /
            winner.termYears /
            25
        ) * 25
      );
  const finalTotalValueCents = legacySubmittedPrice
    ? winner.totalValueCents
    : requiredWinningAavCents * winner.termYears;
  if (finalTotalValueCents > winner.totalValueCents) {
    fail(AUCTION_RESOLUTION_CODES.valueInvalid);
  }
  return freeze({
    ...base,
    outcome: "winner",
    eligibleBidCount: eligible.length,
    skippedBids,
    rankedBids,
    winner: freeze({
      bidId: winner.id,
      teamId: winner.teamId,
      submittedTotalValueCents: winner.totalValueCents,
      submittedTermYears: winner.termYears,
      submittedAavCents: winner.aavCents,
      lowestOfferedAavCents: winner.lowestOfferedAavCents,
      lowestOfferedTotalValueCents:
        winner.lowestOfferedTotalValueCents,
      highestCompetingAavCents: competitor?.aavCents ?? null,
      highestCompetingTotalValueCents:
        competitor?.totalValueCents ?? null,
      requiredWinningTotalValueCents,
      requiredWinningAavCents,
      finalTotalValueCents,
      finalAavCents: calculateAavCents(
        finalTotalValueCents,
        winner.termYears
      ),
    }),
  });
}

function buildAuctionResolutionOccurrenceKey({ auctionId, dueAtMs } = {}) {
  const id = stableId(
    auctionId,
    AUCTION_RESOLUTION_CODES.auctionInvalid
  );
  const due = safeTimestamp(dueAtMs);
  return `auction:${id}:${due}`;
}

module.exports = {
  AUCTION_RESOLUTION_CODES,
  AuctionResolutionPolicyError,
  buildAuctionResolutionOccurrenceKey,
  calculateAavCents,
  evaluateAuctionResolution,
  smallestValidTotalCents,
  validateSubmittedValue,
};
