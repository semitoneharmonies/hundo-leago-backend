const TRADE_PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTOR_AUTHORITIES = Object.freeze(["manager", "commissioner"]);
const OPEN_DRAFT_STATUSES = Object.freeze(["ready", "active", "completed"]);

const TRADE_PROPOSAL_FOUNDATION_CODES = Object.freeze({
  inputInvalid: "TRADE_PROPOSAL_FOUNDATION_INPUT_INVALID",
  stableIdInvalid: "TRADE_PROPOSAL_FOUNDATION_STABLE_ID_INVALID",
  authorityInvalid: "TRADE_PROPOSAL_FOUNDATION_AUTHORITY_INVALID",
  timestampInvalid: "TRADE_PROPOSAL_FOUNDATION_TIMESTAMP_INVALID",
  teamsSame: "TRADE_PROPOSAL_FOUNDATION_TEAMS_SAME",
  authorizationDenied: "TRADE_PROPOSAL_FOUNDATION_AUTHORIZATION_DENIED",
  seasonUnavailable: "TRADE_PROPOSAL_FOUNDATION_SEASON_UNAVAILABLE",
  windowClosed: "TRADE_PROPOSAL_FOUNDATION_WINDOW_CLOSED",
  projectionInvalid: "TRADE_PROPOSAL_FOUNDATION_PROJECTION_INVALID",
});

class TradeProposalFoundationPolicyError extends Error {
  constructor(reasonCode) {
    super("The trade proposal foundation request is invalid.");
    this.name = "TradeProposalFoundationPolicyError";
    this.code = TRADE_PROPOSAL_FOUNDATION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TradeProposalFoundationPolicyError(reasonCode);
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.inputInvalid);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.timestampInvalid);
  }
  return value;
}

function validateTradeProposalFoundationInput(input) {
  exactObject(input, ["proposingTeamId", "receivingTeamId"]);
  const participants = Object.freeze({
    proposingTeamId: stableId(input.proposingTeamId),
    receivingTeamId: stableId(input.receivingTeamId),
  });
  if (participants.proposingTeamId === participants.receivingTeamId) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.teamsSame);
  }
  return participants;
}

function validateTradeProposalFoundationRequest(input) {
  exactObject(input, ["leagueId", "proposingTeamId", "receivingTeamId"]);
  const request = Object.freeze({
    leagueId: stableId(input.leagueId),
    proposingTeamId: stableId(input.proposingTeamId),
    receivingTeamId: stableId(input.receivingTeamId),
  });
  if (request.proposingTeamId === request.receivingTeamId) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.teamsSame);
  }
  return request;
}

function validateTradeProposalFoundationCommand(input) {
  exactObject(input, [
    "proposalId",
    "leagueId",
    "seasonId",
    "proposingTeamId",
    "receivingTeamId",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "createdAtMs",
  ]);
  if (!ACTOR_AUTHORITIES.includes(input.actorAuthority)) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.authorityInvalid);
  }
  const command = Object.freeze({
    proposalId: stableId(input.proposalId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    proposingTeamId: stableId(input.proposingTeamId),
    receivingTeamId: stableId(input.receivingTeamId),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    createdAtMs: safeTimestamp(input.createdAtMs),
  });
  if (command.proposingTeamId === command.receivingTeamId) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.teamsSame);
  }
  return command;
}

function requireCurrentTradeSeasonId(context) {
  if (!context || context.season_status !== "active") {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.seasonUnavailable);
  }
  try {
    return stableId(context.current_season_id);
  } catch (error) {
    if (error instanceof TradeProposalFoundationPolicyError) {
      fail(TRADE_PROPOSAL_FOUNDATION_CODES.seasonUnavailable);
    }
    throw error;
  }
}

function assertTradeProposalFoundationState({ command, context } = {}) {
  if (!context) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.authorizationDenied);
  }
  const managerAuthorized =
    command.actorAuthority === "manager" &&
    context.league_status === "active" &&
    context.membership_status === "active" &&
    context.membership_permission === "manager" &&
    context.assignment_status === "accepted" &&
    context.assignment_ended_at_ms === null;
  const commissionerAuthorized =
    command.actorAuthority === "commissioner" &&
    ["active", "frozen"].includes(context.league_status) &&
    context.membership_status === "active" &&
    context.membership_permission === "commissioner" &&
    context.commissioner_membership_id === command.actorMembershipId;
  if (
    context.proposing_team_status !== "active" ||
    context.receiving_team_status !== "active" ||
    (!managerAuthorized && !commissionerAuthorized)
  ) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.authorizationDenied);
  }
  if (
    context.current_season_id !== command.seasonId ||
    context.season_status !== "active"
  ) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.seasonUnavailable);
  }
  if (
    !OPEN_DRAFT_STATUSES.includes(context.entry_draft_status) ||
    !Number.isSafeInteger(context.trading_opens_at_ms) ||
    command.createdAtMs < context.trading_opens_at_ms ||
    !Number.isSafeInteger(context.trade_deadline_at_ms) ||
    command.createdAtMs >= context.trade_deadline_at_ms
  ) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.windowClosed);
  }
  return true;
}

function deriveTradeProposalTiming({ createdAtMs, tradeDeadlineAtMs } = {}) {
  const created = safeTimestamp(createdAtMs);
  const tradeDeadline = safeTimestamp(tradeDeadlineAtMs);
  const expiresAtMs = created + TRADE_PROPOSAL_LIFETIME_MS;
  if (
    tradeDeadline <= created ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs > MAX_TIMESTAMP_MS
  ) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.windowClosed);
  }
  return Object.freeze({
    createdAtMs: created,
    expiresAtMs,
    tradeDeadlineAtMs: tradeDeadline,
    effectiveDeadlineAtMs: Math.min(expiresAtMs, tradeDeadline),
  });
}

const STATUS_LABELS = Object.freeze({
  proposed: "Pending",
  accepted: "Accepted",
  declined: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired",
  completed: "Accepted",
  reversed: "Reversed",
  correction_required: "Correction Required",
});

function projectTradeProposalRow(row) {
  if (
    !row ||
    !STATUS_LABELS[row.storage_status] ||
    !Number.isSafeInteger(row.created_at_ms) ||
    !Number.isSafeInteger(row.expires_at_ms)
  ) {
    fail(TRADE_PROPOSAL_FOUNDATION_CODES.projectionInvalid);
  }
  const tradeDeadlineAtMs = Number.isSafeInteger(row.trade_deadline_at_ms)
    ? row.trade_deadline_at_ms
    : null;
  const persistedEffectiveDeadlineAtMs = Number.isSafeInteger(
    row.persisted_effective_deadline_at_ms
  )
    ? row.persisted_effective_deadline_at_ms
    : null;
  return Object.freeze({
    id: stableId(row.trade_id),
    leagueId: stableId(row.league_id),
    seasonId: stableId(row.season_id),
    proposingTeam: Object.freeze({
      id: stableId(row.proposing_team_id),
      name: row.proposing_team_name,
    }),
    receivingTeam: Object.freeze({
      id: stableId(row.receiving_team_id),
      name: row.receiving_team_name,
    }),
    proposingUserId: stableId(row.proposing_user_id),
    status: STATUS_LABELS[row.storage_status],
    storageStatus: row.storage_status,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    tradeDeadlineAtMs,
    effectiveDeadlineAtMs:
      persistedEffectiveDeadlineAtMs ??
      (tradeDeadlineAtMs === null
        ? row.expires_at_ms
        : Math.min(row.expires_at_ms, tradeDeadlineAtMs)),
    respondedAtMs: row.responded_at_ms,
    completedAtMs: row.completed_at_ms,
    commissionerCompletionReference:
      row.commissioner_completion_reference,
    version: row.version,
  });
}

module.exports = {
  ACTOR_AUTHORITIES,
  OPEN_DRAFT_STATUSES,
  TRADE_PROPOSAL_FOUNDATION_CODES,
  TRADE_PROPOSAL_LIFETIME_MS,
  TradeProposalFoundationPolicyError,
  assertTradeProposalFoundationState,
  deriveTradeProposalTiming,
  projectTradeProposalRow,
  requireCurrentTradeSeasonId,
  validateTradeProposalFoundationCommand,
  validateTradeProposalFoundationInput,
  validateTradeProposalFoundationRequest,
};
