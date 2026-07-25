const {
  validateStableId,
} = require("../../../domain/leagues/teamPolicy");

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;

class AuctionNotFoundError extends Error {
  constructor() {
    super("The auction was not found.");
    this.name = "AuctionNotFoundError";
    this.code = "AUCTION_NOT_FOUND";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`auction service requires ${description}`);
  }
}

function exactInput(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("|") !== [...keys].sort().join("|")
  ) {
    const error = new TypeError("The auction request is invalid.");
    error.code = "AUCTION_INPUT_INVALID";
    throw error;
  }
  return input;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("auction service requires a safe UTC timestamp");
  }
  return nowMs;
}

function managerResult(result) {
  return Object.freeze({
    code: result.action === "submitted" ? "AUCTION_BID_SUBMITTED" : "AUCTION_BID_EDITED",
    replayed: result.replayed,
    auction: result.auction,
    bid: result.bid,
  });
}

function commissionerResult(result) {
  return Object.freeze({
    code: result.action === "submitted" ? "AUCTION_BID_SUBMITTED" : "AUCTION_BID_EDITED",
    replayed: result.replayed,
    auction: result.auction,
    bid: Object.freeze({
      id: result.bid.id,
      teamId: result.bid.teamId,
      status: result.bid.status,
      version: result.bid.version,
    }),
  });
}

function commissionerStartResult(result) {
  return Object.freeze({
    code: "AUCTION_STARTED",
    replayed: result.replayed,
    auction: result.auction,
    openingBid: Object.freeze({
      id: result.openingBid.id,
      teamId: result.openingBid.teamId,
      status: result.openingBid.status,
      version: result.openingBid.version,
    }),
    event: result.event,
  });
}

function createAuctionService({
  leagueAuthorization,
  teamAuthorization,
  leagueAccessRepository,
  auctionRepository,
  auctionBidRepository,
  clock,
  secureRandom,
} = {}) {
  for (const method of ["requireActiveMembership", "requireCommissioner"]) {
    assertMethod(
      leagueAuthorization,
      method,
      "league membership and commissioner authorization"
    );
  }
  assertMethod(teamAuthorization, "requireManager", "team-manager authorization");
  assertMethod(leagueAccessRepository, "findLeagueSummary", "league access");
  assertMethod(auctionRepository, "startAuction", "auction creation persistence");
  for (const method of ["listActive", "putBid", "readActive"]) {
    assertMethod(auctionBidRepository, method, "auction bid persistence");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function startAuthority(authenticated, leagueId, teamId) {
    try {
      return leagueAuthorization.requireCommissioner(authenticated, leagueId);
    } catch (error) {
      if (error?.code !== "LEAGUE_COMMISSIONER_REQUIRED") throw error;
    }
    return teamAuthorization.requireManager(authenticated, leagueId, teamId);
  }

  function list({ leagueId, authenticated } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const authority = leagueAuthorization.requireActiveMembership(
      authenticated,
      canonicalLeagueId
    );
    return Object.freeze({
      code: "ACTIVE_AUCTIONS_FOUND",
      auctions: auctionBidRepository.listActive({
        leagueId: canonicalLeagueId,
        viewerUserId: authority.actorUserId,
        viewerMembershipId: authority.membershipId,
      }),
    });
  }

  function read({ leagueId, auctionId, authenticated } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalAuctionId = validateStableId(auctionId);
    const authority = leagueAuthorization.requireActiveMembership(
      authenticated,
      canonicalLeagueId
    );
    const auction = auctionBidRepository.readActive({
      leagueId: canonicalLeagueId,
      auctionId: canonicalAuctionId,
      viewerUserId: authority.actorUserId,
      viewerMembershipId: authority.membershipId,
    });
    if (!auction) throw new AuctionNotFoundError();
    return Object.freeze({ code: "ACTIVE_AUCTION_FOUND", auction });
  }

  function start({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const body = exactInput(input, [
      "playerId",
      "teamId",
      "termYears",
      "totalValueCents",
    ]);
    const teamId = validateStableId(body.teamId);
    const playerId = validateStableId(body.playerId);
    const authority = startAuthority(
      authenticated,
      canonicalLeagueId,
      teamId
    );
    const league = leagueAccessRepository.findLeagueSummary(canonicalLeagueId);
    if (!league?.current_season_id) throw new AuctionNotFoundError();
    const nowMs = safeNow(clock);
    const result = auctionRepository.startAuction({
      auctionId: secureRandom.id(),
      bidId: secureRandom.id(),
      eventId: secureRandom.id(),
      idempotencyRequestId: secureRandom.id(),
      leagueId: canonicalLeagueId,
      seasonId: league.current_season_id,
      teamId,
      playerId,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      totalValueCents: body.totalValueCents,
      termYears: body.termYears,
      idempotencyKey,
      occurredAtMs: nowMs,
      idempotencyExpiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
    });
    return authority.authority === "commissioner"
      ? commissionerStartResult(result)
      : Object.freeze({ code: "AUCTION_STARTED", ...result });
  }

  function putMine({
    leagueId,
    auctionId,
    input,
    expectedBidVersion = null,
    idempotencyKey,
    authenticated,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalAuctionId = validateStableId(auctionId);
    const body = exactInput(input, ["teamId", "termYears", "totalValueCents"]);
    const teamId = validateStableId(body.teamId);
    const authority = teamAuthorization.requireManager(
      authenticated,
      canonicalLeagueId,
      teamId
    );
    const nowMs = safeNow(clock);
    return managerResult(
      auctionBidRepository.putBid({
        auctionId: canonicalAuctionId,
        bidId: secureRandom.id(),
        eventId: secureRandom.id(),
        idempotencyRequestId: secureRandom.id(),
        leagueId: canonicalLeagueId,
        teamId,
        actorUserId: authority.actorUserId,
        actorMembershipId: authority.membershipId,
        actorAuthority: "manager",
        totalValueCents: body.totalValueCents,
        termYears: body.termYears,
        expectedBidVersion,
        idempotencyKey,
        occurredAtMs: nowMs,
        idempotencyExpiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
      })
    );
  }

  function putAsCommissioner({
    leagueId,
    auctionId,
    bidId,
    input,
    expectedBidVersion = null,
    idempotencyKey,
    authenticated,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalAuctionId = validateStableId(auctionId);
    const canonicalBidId = validateStableId(bidId);
    const body = exactInput(input, ["teamId", "termYears", "totalValueCents"]);
    const teamId = validateStableId(body.teamId);
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      canonicalLeagueId
    );
    const nowMs = safeNow(clock);
    return commissionerResult(
      auctionBidRepository.putBid({
        auctionId: canonicalAuctionId,
        bidId: canonicalBidId,
        eventId: secureRandom.id(),
        idempotencyRequestId: secureRandom.id(),
        leagueId: canonicalLeagueId,
        teamId,
        actorUserId: authority.actorUserId,
        actorMembershipId: authority.membershipId,
        actorAuthority: "commissioner",
        totalValueCents: body.totalValueCents,
        termYears: body.termYears,
        expectedBidVersion,
        idempotencyKey,
        occurredAtMs: nowMs,
        idempotencyExpiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
      })
    );
  }

  return Object.freeze({ list, putAsCommissioner, putMine, read, start });
}

module.exports = {
  AuctionNotFoundError,
  IDEMPOTENCY_LIFETIME_MS,
  createAuctionService,
};
