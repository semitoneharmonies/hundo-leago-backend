const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ACTOR_AUTHORITIES = Object.freeze([
  "manager",
  "commissioner",
  "platform_administrator_as_commissioner",
]);

const AUCTION_CREATION_CODES = Object.freeze({
  inputInvalid: "AUCTION_CREATION_INPUT_INVALID",
  stableIdInvalid: "AUCTION_CREATION_STABLE_ID_INVALID",
  authorityInvalid: "AUCTION_CREATION_AUTHORITY_INVALID",
  idempotencyInvalid: "AUCTION_CREATION_IDEMPOTENCY_INVALID",
  timestampInvalid: "AUCTION_CREATION_TIMESTAMP_INVALID",
  termInvalid: "AUCTION_CREATION_TERM_INVALID",
  valueInvalid: "AUCTION_CREATION_VALUE_INVALID",
  timezoneInvalid: "AUCTION_CREATION_TIMEZONE_INVALID",
  authorizationDenied: "AUCTION_CREATION_AUTHORIZATION_DENIED",
  seasonUnavailable: "AUCTION_CREATION_SEASON_UNAVAILABLE",
  windowClosed: "AUCTION_CREATION_WINDOW_CLOSED",
  playerIneligible: "AUCTION_CREATION_PLAYER_INELIGIBLE",
  playerOwned: "AUCTION_CREATION_PLAYER_OWNED",
  releasedRightsExcluded: "AUCTION_CREATION_RELEASED_RIGHTS_EXCLUDED",
  activeAuctionExists: "AUCTION_CREATION_ACTIVE_AUCTION_EXISTS",
  fadAllocationQuarantined: "FAD_ALLOCATION_QUARANTINED",
  idempotencyConflict: "AUCTION_CREATION_IDEMPOTENCY_CONFLICT",
});

class AuctionCreationPolicyError extends Error {
  constructor(reasonCode) {
    super("The auction creation request is invalid.");
    this.name = "AuctionCreationPolicyError";
    this.code = AUCTION_CREATION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new AuctionCreationPolicyError(reasonCode);
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(AUCTION_CREATION_CODES.inputInvalid);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(AUCTION_CREATION_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(AUCTION_CREATION_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail(AUCTION_CREATION_CODES.timestampInvalid);
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
    fail(AUCTION_CREATION_CODES.idempotencyInvalid);
  }
  return value;
}

function calculateAavCents(totalValueCents, termYears) {
  const whole = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return whole + (remainder * 2 >= termYears ? 1 : 0);
}

function validateOpeningBid(aavCents, termYears) {
  if (!Number.isSafeInteger(termYears) || termYears < 1 || termYears > 3) {
    fail(AUCTION_CREATION_CODES.termInvalid);
  }
  if (
    !Number.isSafeInteger(aavCents) ||
    aavCents < 100 ||
    aavCents % 25 !== 0
  ) {
    fail(AUCTION_CREATION_CODES.valueInvalid);
  }
  const totalValueCents = aavCents * termYears;
  if (!Number.isSafeInteger(totalValueCents)) {
    fail(AUCTION_CREATION_CODES.valueInvalid);
  }
  return Object.freeze({
    totalValueCents,
    termYears,
    aavCents,
  });
}

function validateAuctionCreationCommand(input) {
  exactObject(input, [
    "auctionId",
    "bidId",
    "eventId",
    "idempotencyRequestId",
    "leagueId",
    "seasonId",
    "teamId",
    "playerId",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "aavCents",
    "termYears",
    "idempotencyKey",
    "occurredAtMs",
    "idempotencyExpiresAtMs",
  ]);
  if (!ACTOR_AUTHORITIES.includes(input.actorAuthority)) {
    fail(AUCTION_CREATION_CODES.authorityInvalid);
  }
  const occurredAtMs = safeTimestamp(input.occurredAtMs);
  const idempotencyExpiresAtMs = safeTimestamp(
    input.idempotencyExpiresAtMs
  );
  if (idempotencyExpiresAtMs <= occurredAtMs) {
    fail(AUCTION_CREATION_CODES.timestampInvalid);
  }
  const bid = validateOpeningBid(input.aavCents, input.termYears);
  return Object.freeze({
    auctionId: stableId(input.auctionId),
    bidId: stableId(input.bidId),
    eventId: stableId(input.eventId),
    idempotencyRequestId: stableId(input.idempotencyRequestId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    teamId: stableId(input.teamId),
    playerId: stableId(input.playerId),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    totalValueCents: bid.totalValueCents,
    termYears: bid.termYears,
    aavCents: bid.aavCents,
    idempotencyKey: boundedIdempotencyKey(input.idempotencyKey),
    occurredAtMs,
    idempotencyExpiresAtMs,
  });
}

function zonedParts(timestampMs, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    fail(AUCTION_CREATION_CODES.timezoneInvalid);
  }
  const result = {};
  for (const part of formatter.formatToParts(new Date(timestampMs))) {
    if (part.type !== "literal") result[part.type] = part.value;
  }
  return result;
}

function calendarDate(year, month, day, offsetDays) {
  const value = new Date(Date.UTC(year, month - 1, day + offsetDays, 12));
  return Object.freeze({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  });
}

function zonedInstant({ year, month, day, hour }, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, 0, 0);
  let candidate = desired;
  for (let index = 0; index < 4; index += 1) {
    const parts = zonedParts(candidate, timeZone);
    const actual = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const delta = desired - actual;
    if (delta === 0) return candidate;
    candidate += delta;
  }
  const finalParts = zonedParts(candidate, timeZone);
  if (
    Number(finalParts.year) !== year ||
    Number(finalParts.month) !== month ||
    Number(finalParts.day) !== day ||
    Number(finalParts.hour) !== hour ||
    Number(finalParts.minute) !== 0 ||
    Number(finalParts.second) !== 0
  ) {
    fail(AUCTION_CREATION_CODES.timezoneInvalid);
  }
  return candidate;
}

function getAuctionCreationWindow({ nowMs, timeZone } = {}) {
  safeTimestamp(nowMs);
  if (
    typeof timeZone !== "string" ||
    timeZone.length < 1 ||
    timeZone.length > 100 ||
    timeZone.trim() !== timeZone
  ) {
    fail(AUCTION_CREATION_CODES.timezoneInvalid);
  }
  const parts = zonedParts(nowMs, timeZone);
  const weekday = Object.freeze({
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  })[parts.weekday];
  if (weekday === undefined) fail(AUCTION_CREATION_CODES.timezoneInvalid);
  const monday = calendarDate(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    -weekday
  );
  const friday = calendarDate(monday.year, monday.month, monday.day, 4);
  const sunday = calendarDate(monday.year, monday.month, monday.day, 6);
  const nextMonday = calendarDate(monday.year, monday.month, monday.day, 7);
  const opensAtMs = zonedInstant({ ...monday, hour: 0 }, timeZone);
  const newAuctionCutoffAtMs = zonedInstant(
    { ...friday, hour: 0 },
    timeZone
  );
  const bidClosesAtMs = zonedInstant({ ...sunday, hour: 16 }, timeZone);
  const nextOpensAtMs = zonedInstant({ ...nextMonday, hour: 0 }, timeZone);
  return Object.freeze({
    opensAtMs,
    newAuctionCutoffAtMs,
    bidClosesAtMs,
    scheduledResolutionAtMs: bidClosesAtMs,
    nextOpensAtMs,
    canStart: nowMs >= opensAtMs && nowMs < newAuctionCutoffAtMs,
  });
}

function assertAuctionStartState({ command, authority, player, window }) {
  if (!authority) fail(AUCTION_CREATION_CODES.authorizationDenied);
  const managerAuthorized =
    command.actorAuthority === "manager" &&
    authority.league_status === "active" &&
    authority.membership_status === "active" &&
    authority.membership_permission === "manager" &&
    authority.assignment_status === "accepted" &&
    authority.assignment_ended_at_ms === null;
  const commissionerAuthorized =
    command.actorAuthority === "commissioner" &&
    ["active", "frozen"].includes(authority.league_status) &&
    authority.membership_status === "active" &&
    authority.membership_permission === "commissioner" &&
    authority.commissioner_membership_id === command.actorMembershipId;
  const platformAdministratorAuthorized =
    command.actorAuthority ===
      "platform_administrator_as_commissioner" &&
    ["active", "frozen"].includes(authority.league_status) &&
    authority.membership_status === "active" &&
    authority.is_platform_administrator === 1;
  if (
    authority.team_status !== "active" ||
    (
      !managerAuthorized &&
      !commissionerAuthorized &&
      !platformAdministratorAuthorized
    )
  ) {
    fail(AUCTION_CREATION_CODES.authorizationDenied);
  }
  if (
    authority.current_season_id !== command.seasonId ||
    authority.season_status !== "active" ||
    authority.regular_season_starts_at_ms === null ||
    command.occurredAtMs < authority.regular_season_starts_at_ms ||
    (authority.regular_season_ends_at_ms !== null &&
      command.occurredAtMs >= authority.regular_season_ends_at_ms) ||
    (authority.fantasy_playoffs_start_at_ms !== null &&
      command.occurredAtMs >= authority.fantasy_playoffs_start_at_ms) ||
    authority.free_agent_draft_completed_at_ms === null ||
    command.occurredAtMs < authority.free_agent_draft_completed_at_ms
  ) {
    fail(AUCTION_CREATION_CODES.seasonUnavailable);
  }
  if (!window.canStart) fail(AUCTION_CREATION_CODES.windowClosed);
  if (
    !player ||
    player.player_status !== "active" ||
    !["F", "D"].includes(player.position_group)
  ) {
    fail(AUCTION_CREATION_CODES.playerIneligible);
  }
  if (player.fad_allocation_quarantined === 1) {
    fail(AUCTION_CREATION_CODES.fadAllocationQuarantined);
  }
  if (player.ownership_id !== null) fail(AUCTION_CREATION_CODES.playerOwned);
  if (player.released_rights_excluded === 1) {
    fail(AUCTION_CREATION_CODES.releasedRightsExcluded);
  }
  if (player.active_auction_id !== null) {
    fail(AUCTION_CREATION_CODES.activeAuctionExists);
  }
  return true;
}

module.exports = {
  ACTOR_AUTHORITIES,
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
  assertAuctionStartState,
  calculateAavCents,
  getAuctionCreationWindow,
  validateAuctionCreationCommand,
  validateOpeningBid,
};
