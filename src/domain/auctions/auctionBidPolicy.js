const COOLDOWN_MS = 75 * 60 * 1000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ACTOR_AUTHORITIES = Object.freeze(["manager", "commissioner"]);
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

function validateBidOffer(totalValueCents, termYears, { joining = false } = {}) {
  if (!Number.isSafeInteger(termYears) || termYears < 1 || termYears > 3) {
    fail(AUCTION_BID_CODES.termInvalid);
  }
  const minimum = joining
    ? JOINING_MINIMUM_TOTALS[termYears]
    : termYears * 100;
  if (
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < minimum ||
    (termYears > 1 && totalValueCents % 100 !== 0)
  ) {
    fail(AUCTION_BID_CODES.valueInvalid);
  }
  return Object.freeze({
    totalValueCents,
    termYears,
    aavCents: calculateAavCents(totalValueCents, termYears),
  });
}

function validateAuctionBidCommand(input) {
  exactObject(input, [
    "auctionId",
    "bidId",
    "eventId",
    "idempotencyRequestId",
    "leagueId",
    "teamId",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "totalValueCents",
    "termYears",
    "expectedBidVersion",
    "idempotencyKey",
    "occurredAtMs",
    "idempotencyExpiresAtMs",
  ]);
  if (!ACTOR_AUTHORITIES.includes(input.actorAuthority)) {
    fail(AUCTION_BID_CODES.authorityInvalid);
  }
  const occurredAtMs = safeTimestamp(input.occurredAtMs);
  const idempotencyExpiresAtMs = safeTimestamp(input.idempotencyExpiresAtMs);
  if (idempotencyExpiresAtMs <= occurredAtMs) {
    fail(AUCTION_BID_CODES.timestampInvalid);
  }
  const offer = validateBidOffer(input.totalValueCents, input.termYears);
  return Object.freeze({
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
  });
}

function authorized(command, authority) {
  if (!authority || authority.membership_status !== "active") return false;
  if (command.actorAuthority === "manager") {
    return (
      authority.league_status === "active" &&
      authority.membership_permission === "manager" &&
      authority.assignment_status === "accepted" &&
      authority.assignment_ended_at_ms === null &&
      authority.team_id === command.teamId &&
      authority.team_status === "active"
    );
  }
  return (
    ["active", "frozen"].includes(authority.league_status) &&
    authority.membership_permission === "commissioner" &&
    authority.commissioner_membership_id === command.actorMembershipId &&
    authority.team_status === "active"
  );
}

function assertAuctionBidState({ command, authority, auction, existingBid }) {
  if (!authorized(command, authority)) {
    fail(AUCTION_BID_CODES.authorizationDenied);
  }
  if (
    !auction ||
    auction.league_id !== command.leagueId ||
    auction.status !== "open"
  ) {
    fail(AUCTION_BID_CODES.auctionUnavailable);
  }
  if (command.occurredAtMs >= auction.resolves_at_ms) {
    fail(AUCTION_BID_CODES.windowClosed);
  }

  if (!existingBid) {
    if (command.expectedBidVersion !== null) {
      fail(AUCTION_BID_CODES.versionConflict);
    }
    const offer = validateBidOffer(
      command.totalValueCents,
      command.termYears,
      { joining: true }
    );
    return Object.freeze({
      action: "submitted",
      ...offer,
      lowestOfferedAavCents: offer.aavCents,
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

  const offer = validateBidOffer(command.totalValueCents, command.termYears);
  const isStarter =
    existingBid.first_submitted_at_ms === auction.opened_at_ms;
  if (command.actorAuthority === "manager") {
    const limit = isStarter ? 2 : 1;
    if (existingBid.edit_count >= limit) {
      fail(AUCTION_BID_CODES.editLimitReached);
    }
    if (command.occurredAtMs < existingBid.last_edited_at_ms + COOLDOWN_MS) {
      fail(AUCTION_BID_CODES.cooldownActive);
    }
  }

  return Object.freeze({
    action: "edited",
    ...offer,
    lowestOfferedAavCents: Math.min(
      existingBid.lowest_offered_aav_cents,
      offer.aavCents
    ),
    firstSubmittedAtMs: existingBid.first_submitted_at_ms,
    lastEditedAtMs: command.occurredAtMs,
    editCount:
      existingBid.edit_count +
      (command.actorAuthority === "manager" ? 1 : 0),
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
