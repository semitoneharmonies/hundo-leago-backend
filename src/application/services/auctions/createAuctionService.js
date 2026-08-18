const {
  validateStableId,
} = require("../../../domain/leagues/teamPolicy");
const {
  calculateAavCents,
} = require("../../../domain/auctions/auctionCreationPolicy");
const {
  encodeAuctionReadCursor,
  normalizeAuctionListQuery,
} = require("../../../domain/auctions/auctionReadPolicy");
const {
  validateAuctionReadProjection,
  validateAuctionStartTeamsProjection,
} = require(
  "../../../domain/auctions/auctionReadProjectionPolicy"
);

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

function exactStartInput(input) {
  return exactInput(input, [
    "playerId",
    "teamId",
    "termYears",
    "aavCents",
  ];
  const fadKeys = [
    ...ordinaryKeys,
    "bindingIllegalityConfirmed",
  ];
  const keys =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.keys(input).sort().join("|")
      : "";
  if (
    ![
      ordinaryKeys.sort().join("|"),
      fadKeys.sort().join("|"),
    ].includes(keys) ||
    (
      Object.prototype.hasOwnProperty.call(
        input || {},
        "bindingIllegalityConfirmed"
      ) &&
      input.bindingIllegalityConfirmed !== true
    )
  ) {
    const error = new TypeError("The auction request is invalid.");
    error.code = "AUCTION_INPUT_INVALID";
    throw error;
  }
  return input;
}

function exactBidInput(input) {
  return exactInput(input, ["teamId", "termYears", "aavCents"]);
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

function validateReadCollection(result, maximumRows) {
  const descriptors =
    result && typeof result === "object"
      ? Object.getOwnPropertyDescriptors(result)
      : null;
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getOwnPropertySymbols(result).length !== 0 ||
    !descriptors ||
    Object.keys(descriptors).sort().join("|") !==
      "auctions|startTeams" ||
    Object.values(descriptors).some(
      (descriptor) =>
        !("value" in descriptor) ||
        descriptor.enumerable !== true
    ) ||
    !Array.isArray(result.auctions) ||
    !Array.isArray(result.startTeams) ||
    result.auctions.length > maximumRows
  ) {
    throw new TypeError(
      "auction service requires a canonical read collection"
    );
  }
  return Object.freeze({
    auctions: Object.freeze(
      result.auctions.map(
        validateAuctionReadProjection
      )
    ),
    startTeams:
      validateAuctionStartTeamsProjection(
        result.startTeams
      ),
  });
}

function cursorSortMs(auction, order) {
  if (order === "resolves_asc") {
    return auction?.resolvesAtMs;
  }
  if (order === "resolved_desc") {
    return auction?.resolvedAtMs;
  }
  return auction?.updatedAtMs;
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUEUED_NOMINATION_FIELDS = Object.freeze([
  "aavCents",
  "acceptedAtMs",
  "bindingIllegalityConfirmedAtMs",
  "fadId",
  "openingRolloverId",
  "player",
  "queueId",
  "resolutionRolloverId",
  "status",
  "teamId",
  "termYears",
  "totalValueCents",
  "version",
]);
const QUEUED_NOMINATION_PLAYER_FIELDS = Object.freeze([
  "fullName",
  "playerId",
  "positionGroup",
]);

function isExactDataObject(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Object.keys(descriptors).sort().join("|") ===
      [...keys].sort().join("|") &&
    Object.values(descriptors).every(
      (descriptor) =>
        Object.prototype.hasOwnProperty.call(
          descriptor,
          "value"
        ) && descriptor.enumerable === true
    )
  );
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isSafeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateQueuedNominationProjection(
  value,
  { teamId, playerId, fadId, queueId }
) {
  if (
    !isExactDataObject(value, QUEUED_NOMINATION_FIELDS) ||
    !isExactDataObject(
      value.player,
      QUEUED_NOMINATION_PLAYER_FIELDS
    ) ||
    !isUuid(value.queueId) ||
    !isUuid(value.fadId) ||
    !isUuid(value.teamId) ||
    !isUuid(value.player.playerId) ||
    !isUuid(value.openingRolloverId) ||
    !(
      value.resolutionRolloverId === null ||
      isUuid(value.resolutionRolloverId)
    ) ||
    value.queueId !== queueId ||
    value.fadId !== fadId ||
    value.teamId !== teamId ||
    value.player.playerId !== playerId ||
    typeof value.player.fullName !== "string" ||
    value.player.fullName.length < 1 ||
    !["F", "D"].includes(value.player.positionGroup) ||
    !Number.isSafeInteger(value.totalValueCents) ||
    value.totalValueCents < 1 ||
    !Number.isSafeInteger(value.termYears) ||
    value.termYears < 1 ||
    !Number.isSafeInteger(value.aavCents) ||
    value.aavCents < 1 ||
    value.aavCents !==
      calculateAavCents(
        value.totalValueCents,
        value.termYears
      ) ||
    !isSafeNonnegativeInteger(
      value.bindingIllegalityConfirmedAtMs
    ) ||
    !isSafeNonnegativeInteger(value.acceptedAtMs) ||
    value.bindingIllegalityConfirmedAtMs !== value.acceptedAtMs ||
    !["queued", "opened", "invalid"].includes(
      value.status
    ) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    throw new TypeError(
      "auction service requires a canonical queued-nomination projection"
    );
  }
  return Object.freeze({
    queueId: value.queueId,
    fadId: value.fadId,
    teamId: value.teamId,
    player: Object.freeze({
      playerId: value.player.playerId,
      fullName: value.player.fullName,
      positionGroup: value.player.positionGroup,
    }),
    totalValueCents: value.totalValueCents,
    termYears: value.termYears,
    aavCents: value.aavCents,
    bindingIllegalityConfirmedAtMs:
      value.bindingIllegalityConfirmedAtMs,
    acceptedAtMs: value.acceptedAtMs,
    openingRolloverId: value.openingRolloverId,
    resolutionRolloverId: value.resolutionRolloverId,
    status: value.status,
    version: value.version,
  });
}

function createAuctionService({
  leagueAuthorization,
  teamAuthorization,
  leagueAccessRepository,
  freeAgentDraftAuctionStartWriter,
  auctionRepository,
  auctionBidRepository,
  auctionReadRepository,
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
  assertMethod(
    freeAgentDraftAuctionStartWriter,
    "startOrQueue",
    "FAD auction-start persistence"
  );
  assertMethod(auctionRepository, "startAuction", "auction creation persistence");
  assertMethod(auctionBidRepository, "putBid", "auction bid persistence");
  for (const method of ["listAuctions", "readAuction"]) {
    assertMethod(
      auctionReadRepository,
      method,
      "canonical auction read persistence"
    );
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function startAuthority(authenticated, leagueId, teamId) {
    try {
      const authority = leagueAuthorization.requireCommissioner(
        authenticated,
        leagueId
      );
      return Object.freeze({
        ...authority,
        authority:
          authority.authority === "commissioner"
            ? "commissioner"
            : "platform_administrator_as_commissioner",
      });
    } catch (error) {
      if (error?.code !== "LEAGUE_COMMISSIONER_REQUIRED") throw error;
    }
    return teamAuthorization.requireManager(authenticated, leagueId, teamId);
  }

  function list({ leagueId, query, authenticated } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const authority = leagueAuthorization.requireActiveMembership(
      authenticated,
      canonicalLeagueId
    );
    const canonicalQuery = normalizeAuctionListQuery(
      query || {}
    );
    const nowMs = safeNow(clock);
    const fetchLimit = canonicalQuery.limit + 1;
    const result = validateReadCollection(
      auctionReadRepository.listAuctions({
        leagueId: canonicalLeagueId,
        viewerUserId: authority.actorUserId,
        viewerMembershipId: authority.membershipId,
        sourceKind: canonicalQuery.sourceKind,
        fadId: canonicalQuery.fadId,
        statuses: canonicalQuery.statuses,
        q:
          canonicalQuery.q.length === 0
            ? null
            : canonicalQuery.q,
        limit: fetchLimit,
        order: canonicalQuery.order,
        cursor: canonicalQuery.cursor,
        nowMs,
      }),
      fetchLimit
    );
    const hasMore =
      result.auctions.length > canonicalQuery.limit;
    const data = Object.freeze(
      result.auctions.slice(0, canonicalQuery.limit)
    );
    const last = data.at(-1);
    return Object.freeze({
      data,
      actions: Object.freeze({
        startTeams: Object.freeze([
          ...result.startTeams,
        ]),
      }),
      page: Object.freeze({
        nextCursor:
          hasMore && last
            ? encodeAuctionReadCursor(
                canonicalQuery,
                {
                  sortMs: cursorSortMs(
                    last,
                    canonicalQuery.order
                  ),
                  auctionId: last.auctionId,
                }
              )
            : null,
        hasMore,
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
    const auction = auctionReadRepository.readAuction({
      leagueId: canonicalLeagueId,
      auctionId: canonicalAuctionId,
      viewerUserId: authority.actorUserId,
      viewerMembershipId: authority.membershipId,
      nowMs: safeNow(clock),
    });
    if (!auction) throw new AuctionNotFoundError();
    return validateAuctionReadProjection(auction);
  }

  function start({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const candidateBody = exactStartInput(input);
    const teamId = validateStableId(candidateBody.teamId);
    const playerId = validateStableId(candidateBody.playerId);
    const authority = startAuthority(
      authenticated,
      canonicalLeagueId,
      teamId
    );
    const league = leagueAccessRepository.findLeagueSummary(canonicalLeagueId);
    if (!league?.current_season_id) throw new AuctionNotFoundError();
    const nowMs = safeNow(clock);
    const fadResult = freeAgentDraftAuctionStartWriter.startOrQueue({
      leagueId: canonicalLeagueId,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      body: candidateBody,
      idempotencyKey,
      nowMs,
      idempotencyExpiresAtMs:
        nowMs + IDEMPOTENCY_LIFETIME_MS,
    });
    if (
      !isExactDataObject(fadResult, ["applicable"]) ||
      fadResult.applicable !== false
    ) {
      if (fadResult?.kind === "auction_opened") {
        if (
          !isUuid(fadResult.auctionId) ||
          fadResult.leagueId !== canonicalLeagueId ||
          fadResult.body?.teamId !== teamId ||
          fadResult.body?.playerId !== playerId
        ) {
          throw new TypeError(
            "auction service requires a canonical FAD auction-start result"
          );
        }
        const auction = auctionReadRepository.readAuction({
          leagueId: canonicalLeagueId,
          auctionId: fadResult.auctionId,
          viewerUserId: authority.actorUserId,
          viewerMembershipId: authority.membershipId,
          nowMs,
        });
        if (!auction) throw new AuctionNotFoundError();
        const projection = validateAuctionReadProjection(auction);
        if (
          projection.auctionId !== fadResult.auctionId ||
          projection.leagueId !== canonicalLeagueId ||
          projection.player.playerId !== playerId ||
          projection.sourceKind !== "fad_open_rapid" ||
          projection.fadId !== fadResult.fadId
        ) {
          throw new TypeError(
            "auction service requires a matching FAD auction projection"
          );
        }
        return Object.freeze({
          kind: "auction_opened",
          auction: projection,
          queuedNomination: null,
        });
      }
      if (fadResult?.kind === "nomination_queued") {
        return Object.freeze({
          kind: "nomination_queued",
          auction: null,
          queuedNomination:
            validateQueuedNominationProjection(
              fadResult.queuedNomination,
              {
                teamId,
                playerId,
                fadId: fadResult.fadId,
                queueId: fadResult.nominationQueueId,
              }
            ),
        });
      }
      throw new TypeError(
        "auction service requires a canonical FAD auction-start result"
      );
    }
    const body = exactInput(input, [
      "playerId",
      "teamId",
      "termYears",
      "aavCents",
    ]);
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
      aavCents: body.aavCents,
      termYears: body.termYears,
      idempotencyKey,
      occurredAtMs: nowMs,
      idempotencyExpiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
    });
    return authority.authority === "manager"
      ? Object.freeze({ code: "AUCTION_STARTED", ...result })
      : commissionerStartResult(result);
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
    const body = exactBidInput(input);
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
        aavCents: body.aavCents,
        termYears: body.termYears,
        expectedBidVersion,
        idempotencyKey,
        occurredAtMs: nowMs,
        idempotencyExpiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
      })
    );
  }

  return Object.freeze({ list, putMine, read, start });
}

module.exports = {
  AuctionNotFoundError,
  IDEMPOTENCY_LIFETIME_MS,
  createAuctionService,
};
