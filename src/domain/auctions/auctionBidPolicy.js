const COOLDOWN_MS = 75 * 60 * 1000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ACTOR_AUTHORITIES = Object.freeze(["manager"]);
const JOINING_MINIMUM_TOTALS = Object.freeze({ 1: 150, 2: 300, 3: 500 });

const AUCTION_BID_CODES = Object.freeze({
  inputInvalid: "AUCTION_BID_INPUT_INVALID",
  stableIdInvalid: "AUCTION_BID_STABLE_ID_INVALID",
  authorityInvalid: "AUCTION_BID_AUTHORITY_INVALID",
  idempotencyInvalid: "AUCTION_BID_IDEMPOTENCY_INVALID",
  timestampInvalid: "AUCTION_BID_TIMESTAMP_INVALID",
  termInvalid: "AUCTION_BID_TERM_INVALID",
  valueInvalid: "AUCTION_BID_VALUE_INVALID",
  authorizationDenied: "AUCTION_BID_AUTHORIZATION_DENIED",
  auctionUnavailable: "AUCTION_BID_AUCTION_UNAVAILABLE",
  windowClosed: "AUCTION_BID_WINDOW_CLOSED",
  bidConflict: "AUCTION_BID_CONFLICT",
  versionConflict: "AUCTION_BID_VERSION_CONFLICT",
  editLimitReached: "AUCTION_BID_EDIT_LIMIT_REACHED",
  cooldownActive: "AUCTION_BID_COOLDOWN_ACTIVE",
  idempotencyConflict: "AUCTION_BID_IDEMPOTENCY_CONFLICT",
  idempotencyKeyReused: "IDEMPOTENCY_KEY_REUSED",
});

class AuctionBidPolicyError extends Error {
  constructor(reasonCode) {
    super("The auction bid request is invalid.");
    this.name = "AuctionBidPolicyError";
    this.code = AUCTION_BID_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new AuctionBidPolicyError(reasonCode);
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(AUCTION_BID_CODES.inputInvalid);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(AUCTION_BID_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(AUCTION_BID_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail(AUCTION_BID_CODES.timestampInvalid);
  }
  return value;
}

function optionalVersion(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(AUCTION_BID_CODES.versionConflict);
  }
  return value;
}

function boundedIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    fail(AUCTION_BID_CODES.idempotencyInvalid);
  }
  return value;
}

function calculateAavCents(totalValueCents, termYears) {
  const whole = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return whole + (remainder * 2 >= termYears ? 1 : 0);
}

function validateBidOffer(aavCents, termYears, { joining = false } = {}) {
  if (!Number.isSafeInteger(termYears) || termYears < 1 || termYears > 3) {
    fail(AUCTION_BID_CODES.termInvalid);
  }
  const minimum = joining
    ? JOINING_MINIMUM_TOTALS[termYears]
    : termYears * 100;
  if (
    !Number.isSafeInteger(aavCents) ||
    aavCents < 100 ||
    aavCents % 25 !== 0
  ) {
    fail(AUCTION_BID_CODES.valueInvalid);
  }
  const totalValueCents = aavCents * termYears;
  if (
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < minimum
  ) {
    fail(AUCTION_BID_CODES.valueInvalid);
  }
  return Object.freeze({
    totalValueCents,
    termYears,
    aavCents,
  });
}

function validateAuctionBidCommand(input) {
  const ordinaryFields = [
    "auctionId",
    "bidId",
    "eventId",
    "idempotencyRequestId",
    "leagueId",
    "teamId",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "aavCents",
    "termYears",
    "expectedBidVersion",
    "idempotencyKey",
    "occurredAtMs",
    "idempotencyExpiresAtMs",
  ];
  const fields = Object.prototype.hasOwnProperty.call(
    input || {},
    "bindingIllegalityConfirmed"
  )
    ? [...ordinaryFields, "bindingIllegalityConfirmed"]
    : ordinaryFields;
  exactObject(input, fields);
  if (!ACTOR_AUTHORITIES.includes(input.actorAuthority)) {
    fail(AUCTION_BID_CODES.authorityInvalid);
  }
  const occurredAtMs = safeTimestamp(input.occurredAtMs);
  const idempotencyExpiresAtMs = safeTimestamp(input.idempotencyExpiresAtMs);
  if (idempotencyExpiresAtMs <= occurredAtMs) {
    fail(AUCTION_BID_CODES.timestampInvalid);
  }
  const offer = validateBidOffer(input.aavCents, input.termYears);
  const command = {
    auctionId: stableId(input.auctionId),
    bidId: stableId(input.bidId),
    eventId: stableId(input.eventId),
    idempotencyRequestId: stableId(input.idempotencyRequestId),
    leagueId: stableId(input.leagueId),
    teamId: stableId(input.teamId),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    totalValueCents: offer.totalValueCents,
    termYears: offer.termYears,
    aavCents: offer.aavCents,
    expectedBidVersion: optionalVersion(input.expectedBidVersion),
    idempotencyKey: boundedIdempotencyKey(input.idempotencyKey),
    occurredAtMs,
    idempotencyExpiresAtMs,
  };
  if (fields.length !== ordinaryFields.length) {
    command.bindingIllegalityConfirmed =
      input.bindingIllegalityConfirmed;
  }
  return Object.freeze(command);
}

function authorized(command, authority) {
  if (
    !authority ||
    authority.user_status !== "active" ||
    authority.membership_status !== "active" ||
    !Number.isSafeInteger(authority.membership_joined_at_ms) ||
    authority.membership_joined_at_ms > command.occurredAtMs ||
    authority.membership_ended_at_ms !== null
  ) {
    return false;
  }
  return (
    command.actorAuthority === "manager" &&
    authority.league_status === "active" &&
    authority.membership_permission === "manager" &&
    authority.assignment_status === "accepted" &&
    Number.isSafeInteger(authority.assignment_accepted_at_ms) &&
    authority.assignment_accepted_at_ms <= command.occurredAtMs &&
    authority.assignment_ended_at_ms === null &&
    authority.team_id === command.teamId &&
    authority.team_status === "active"
  );
}

function isStrictlyAboveFloor(offer, totalValueCents, aavCents) {
  return offer.totalValueCents > totalValueCents || (
    offer.totalValueCents === totalValueCents &&
    offer.aavCents > aavCents
  );
}

function isAtOrAboveFloor(offer, totalValueCents, aavCents) {
  return offer.totalValueCents > totalValueCents || (
    offer.totalValueCents === totalValueCents &&
    offer.aavCents >= aavCents
  );
}

function bidContext(command, auction, participant) {
  const sourceKind = auction?.source_kind || "ordinary_weekly";
  if (sourceKind === "ordinary_weekly") {
    return Object.freeze({ kind: "ordinary", editLimit: null });
  }
  if (
    sourceKind === "fad_open_rapid" &&
    ["manager_nomination", "queued_nomination"].includes(
      auction.fad_origin
    ) &&
    auction.fad_allocation_id === null &&
    auction.fad_started_event_count === 1 &&
    auction.fad_starter_bid_count === 1 &&
    UUID_PATTERN.test(auction.fad_starter_bid_id || "") &&
    UUID_PATTERN.test(auction.fad_starter_team_id || "") &&
    (
      (
        auction.fad_origin === "manager_nomination" &&
        auction.queued_starter_count === 0 &&
        auction.queued_starter_bid_id === null &&
        auction.queued_starter_team_id === null
      ) ||
      (
        auction.fad_origin === "queued_nomination" &&
        auction.queued_starter_count === 1 &&
        auction.queued_starter_bid_id ===
          auction.fad_starter_bid_id &&
        auction.queued_starter_team_id ===
          auction.fad_starter_team_id
      )
    )
  ) {
    return Object.freeze({
      kind: "openRapid",
      editLimit: null,
      starterBidId: auction.fad_starter_bid_id,
      starterTeamId: auction.fad_starter_team_id,
    });
  }
  if (
    sourceKind === "fad_restricted" &&
    auction.fad_origin === "candidate_tie_restricted" &&
    auction.allocation_status === "restricted_active" &&
    auction.restricted_auction_id === command.auctionId &&
    participant?.status === "active" &&
    participant.season_id === auction.season_id &&
    participant.fad_id === auction.fad_id &&
    participant.allocation_id === auction.fad_allocation_id &&
    participant.auction_id === command.auctionId &&
    participant.team_id === command.teamId &&
    participant.manager_edit_limit === 1 &&
    participant.cooldown_duration_ms === COOLDOWN_MS &&
    Number.isSafeInteger(
      participant.minimum_total_value_cents
    ) &&
    participant.minimum_total_value_cents > 0 &&
    Number.isSafeInteger(participant.minimum_aav_cents) &&
    participant.minimum_aav_cents >= 100
  ) {
    return Object.freeze({
      kind: "restricted",
      editLimit: participant.manager_edit_limit,
      minimumTotalValueCents:
        participant.minimum_total_value_cents,
      minimumAavCents: participant.minimum_aav_cents,
    });
  }
  if (
    sourceKind === "fad_open_rapid" &&
    auction.fad_origin ===
      "restricted_no_improvement_fallback" &&
    auction.allocation_status === "restricted_fallback_open" &&
    auction.fallback_open_auction_id === command.auctionId &&
    Number.isSafeInteger(
      auction.restricted_minimum_total_cents
    ) &&
    auction.restricted_minimum_total_cents > 0 &&
    Number.isSafeInteger(
      auction.restricted_minimum_aav_cents
    ) &&
    auction.restricted_minimum_aav_cents >= 100
  ) {
    return Object.freeze({
      kind: "fallback",
      editLimit: 1,
      minimumTotalValueCents:
        auction.restricted_minimum_total_cents,
      minimumAavCents:
        auction.restricted_minimum_aav_cents,
    });
  }
  fail(AUCTION_BID_CODES.auctionUnavailable);
}

function assertContextOffer(offer, context) {
  if (
    context.kind === "restricted" &&
    !isStrictlyAboveFloor(
      offer,
      context.minimumTotalValueCents,
      context.minimumAavCents
    )
  ) {
    fail(AUCTION_BID_CODES.valueInvalid);
  }
  if (
    context.kind === "fallback" &&
    !isAtOrAboveFloor(
      offer,
      context.minimumTotalValueCents,
      context.minimumAavCents
    )
  ) {
    fail(AUCTION_BID_CODES.valueInvalid);
  }
}

function assertAuctionBidState({
  command,
  authority,
  auction,
  existingBid,
  participant = null,
}) {
  if (!authorized(command, authority)) {
    fail(AUCTION_BID_CODES.authorizationDenied);
  }
  if (
    !auction ||
    auction.league_id !== command.leagueId ||
    auction.status !== "open" ||
    !Number.isSafeInteger(auction.opened_at_ms) ||
    auction.opened_at_ms < 0 ||
    command.occurredAtMs < auction.opened_at_ms
  ) {
    fail(AUCTION_BID_CODES.auctionUnavailable);
  }
  if (command.occurredAtMs >= auction.resolves_at_ms) {
    fail(AUCTION_BID_CODES.windowClosed);
  }
  const context = bidContext(command, auction, participant);
  if (
    context.kind === "restricted" &&
    (
      (!existingBid &&
        (
          participant.active_improvement_bid_id !== null ||
          participant.first_improvement_at_ms !== null ||
          participant.current_cooldown_anchor_at_ms !== null ||
          participant.improvement_committed_at_ms !== null
        )) ||
      (existingBid &&
        (
          participant.active_improvement_bid_id !== existingBid.id ||
          participant.first_improvement_at_ms !==
            existingBid.first_submitted_at_ms ||
          participant.current_cooldown_anchor_at_ms !==
            existingBid.last_edited_at_ms ||
          participant.improvement_committed_at_ms !==
            existingBid.last_edited_at_ms
        ))
    )
  ) {
    fail(AUCTION_BID_CODES.bidConflict);
  }

  if (!existingBid) {
    if (command.expectedBidVersion !== null) {
      fail(AUCTION_BID_CODES.versionConflict);
    }
    const offer = validateBidOffer(
      command.aavCents,
      command.termYears,
      { joining: true }
    );
    assertContextOffer(offer, context);
    return Object.freeze({
      action: "submitted",
      ...offer,
      lowestOfferedAavCents: offer.aavCents,
      lowestOfferedTotalValueCents:
        offer.totalValueCents,
      firstSubmittedAtMs: command.occurredAtMs,
      lastEditedAtMs: command.occurredAtMs,
      editCount: 0,
      nextVersion: 1,
    });
  }

  if (
    existingBid.auction_id !== command.auctionId ||
    existingBid.team_id !== command.teamId ||
    existingBid.status !== "active"
  ) {
    fail(AUCTION_BID_CODES.bidConflict);
  }
  if (
    command.expectedBidVersion === null ||
    command.expectedBidVersion !== existingBid.version
  ) {
    fail(AUCTION_BID_CODES.versionConflict);
  }

  const offer = validateBidOffer(
    command.aavCents,
    command.termYears,
    { joining: context.kind === "restricted" }
  );
  assertContextOffer(offer, context);
  const isStarter = context.kind === "ordinary"
    ? existingBid.first_submitted_at_ms === auction.opened_at_ms
    : (
        context.kind === "openRapid" &&
        existingBid.id === context.starterBidId &&
        existingBid.team_id === context.starterTeamId
      );
  const limit = context.editLimit ?? (isStarter ? 2 : 1);
  if (existingBid.edit_count >= limit) {
    fail(AUCTION_BID_CODES.editLimitReached);
  }
  if (command.occurredAtMs < existingBid.last_edited_at_ms + COOLDOWN_MS) {
    fail(AUCTION_BID_CODES.cooldownActive);
  }

  return Object.freeze({
    action: "edited",
    ...offer,
    lowestOfferedAavCents: Math.min(
      existingBid.lowest_offered_aav_cents,
      offer.aavCents
    ),
    lowestOfferedTotalValueCents: Math.min(
      existingBid.lowest_offered_total_value_cents ??
        existingBid.total_value_cents,
      offer.totalValueCents
    ),
    firstSubmittedAtMs: existingBid.first_submitted_at_ms,
    lastEditedAtMs: command.occurredAtMs,
    editCount: existingBid.edit_count + 1,
    nextVersion: existingBid.version + 1,
  });
}

module.exports = {
  ACTOR_AUTHORITIES,
  AUCTION_BID_CODES,
  AuctionBidPolicyError,
  COOLDOWN_MS,
  JOINING_MINIMUM_TOTALS,
  assertAuctionBidState,
  calculateAavCents,
  validateAuctionBidCommand,
  validateBidOffer,
};
