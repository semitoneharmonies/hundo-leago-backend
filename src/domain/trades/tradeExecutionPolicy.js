const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const EXECUTION_AUTHORITIES = Object.freeze([
  "manager",
  "commissioner",
  "platform_administrator",
]);

const TRADE_EXECUTION_CODES = Object.freeze({
  inputInvalid: "TRADE_EXECUTION_INPUT_INVALID",
  stableIdInvalid: "TRADE_EXECUTION_STABLE_ID_INVALID",
  authorityInvalid: "TRADE_EXECUTION_AUTHORITY_INVALID",
  timestampInvalid: "TRADE_EXECUTION_TIMESTAMP_INVALID",
  versionInvalid: "TRADE_EXECUTION_VERSION_INVALID",
  idempotencyInvalid: "TRADE_EXECUTION_IDEMPOTENCY_INVALID",
  idempotencyConflict: "TRADE_EXECUTION_IDEMPOTENCY_CONFLICT",
  notFound: "TRADE_EXECUTION_NOT_FOUND",
  notPending: "TRADE_EXECUTION_NOT_PENDING",
  roleDenied: "TRADE_EXECUTION_ROLE_DENIED",
  windowClosed: "TRADE_EXECUTION_WINDOW_CLOSED",
  stateInvalid: "TRADE_EXECUTION_STATE_INVALID",
  versionConflict: "TRADE_EXECUTION_VERSION_CONFLICT",
});

class TradeExecutionPolicyError extends Error {
  constructor(reasonCode) {
    super("The trade acceptance request is invalid.");
    this.name = "TradeExecutionPolicyError";
    this.code = TRADE_EXECUTION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TradeExecutionPolicyError(reasonCode);
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRADE_EXECUTION_CODES.inputInvalid);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(TRADE_EXECUTION_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(TRADE_EXECUTION_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    fail(TRADE_EXECUTION_CODES.timestampInvalid);
  }
  return value;
}

function validateTradeExecutionInput(input) {
  exactObject(input, ["tradeId"]);
  return Object.freeze({ tradeId: stableId(input.tradeId) });
}

function validateExecutionCommand(input, allowedAuthorities) {
  exactObject(input, [
    "tradeId",
    "eventId",
    "idempotencyRequestId",
    "leagueId",
    "seasonId",
    "proposingTeamId",
    "receivingTeamId",
    "expectedVersion",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "occurredAtMs",
    "effectiveDeadlineAtMs",
    "idempotencyKey",
    "idempotencyExpiresAtMs",
  ]);
  if (!allowedAuthorities.includes(input.actorAuthority)) {
    fail(TRADE_EXECUTION_CODES.authorityInvalid);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    fail(TRADE_EXECUTION_CODES.versionInvalid);
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128 ||
    input.idempotencyKey.trim() !== input.idempotencyKey ||
    CONTROL_PATTERN.test(input.idempotencyKey)
  ) {
    fail(TRADE_EXECUTION_CODES.idempotencyInvalid);
  }
  const command = {
    tradeId: stableId(input.tradeId),
    eventId: stableId(input.eventId),
    idempotencyRequestId: stableId(input.idempotencyRequestId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    proposingTeamId: stableId(input.proposingTeamId),
    receivingTeamId: stableId(input.receivingTeamId),
    expectedVersion: input.expectedVersion,
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    occurredAtMs: safeTimestamp(input.occurredAtMs),
    effectiveDeadlineAtMs: safeTimestamp(input.effectiveDeadlineAtMs),
    idempotencyKey: input.idempotencyKey,
    idempotencyExpiresAtMs: safeTimestamp(input.idempotencyExpiresAtMs),
  };
  if (
    command.proposingTeamId === command.receivingTeamId ||
    command.idempotencyExpiresAtMs <= command.occurredAtMs
  ) {
    fail(TRADE_EXECUTION_CODES.stateInvalid);
  }
  return Object.freeze(command);
}

function validateTradeExecutionCommand(input) {
  return validateExecutionCommand(input, EXECUTION_AUTHORITIES);
}

function validateTradeApprovalCommand(input) {
  return validateExecutionCommand(input, [
    "commissioner",
    "platform_administrator",
  ]);
}

function commissionerAuthorized(command, context) {
  const currentCommissioner =
    command.actorAuthority === "commissioner" &&
    context.commissioner_membership_id === command.actorMembershipId &&
    context.membership_permission === "commissioner";
  const inheritedPlatformAdministrator =
    command.actorAuthority === "platform_administrator" &&
    context.is_platform_administrator === 1;
  return (
    ["active", "frozen"].includes(context.league_status) &&
    context.membership_user_id === command.actorUserId &&
    context.membership_status === "active" &&
    (currentCommissioner || inheritedPlatformAdministrator)
  );
}

function assertSharedExecutionState({ command, context, expectedStatus }) {
  if (!context) fail(TRADE_EXECUTION_CODES.notFound);
  if (
    context.trade_id !== command.tradeId ||
    context.league_id !== command.leagueId ||
    context.season_id !== command.seasonId ||
    context.proposing_team_id !== command.proposingTeamId ||
    context.receiving_team_id !== command.receivingTeamId ||
    context.effective_deadline_at_ms !== command.effectiveDeadlineAtMs
  ) {
    fail(TRADE_EXECUTION_CODES.stateInvalid);
  }
  if (context.trade_status !== expectedStatus) {
    fail(TRADE_EXECUTION_CODES.notPending);
  }
  if (
    context.trade_version !== command.expectedVersion ||
    context.proposal_model_version !== 2
  ) {
    fail(TRADE_EXECUTION_CODES.versionConflict);
  }
  if (
    command.occurredAtMs >= context.effective_deadline_at_ms ||
    context.season_status !== "active"
  ) {
    fail(TRADE_EXECUTION_CODES.windowClosed);
  }
}

function assertTradeExecutionState({ command, context } = {}) {
  assertSharedExecutionState({
    command,
    context,
    expectedStatus: "proposed",
  });
  const managerAuthorized =
    command.actorAuthority === "manager" &&
    context.league_status === "active" &&
    context.membership_user_id === command.actorUserId &&
    context.membership_status === "active" &&
    context.assignment_team_id === command.receivingTeamId &&
    context.assignment_status === "accepted" &&
    context.assignment_accepted_at_ms !== null &&
    context.assignment_ended_at_ms === null;
  if (!managerAuthorized) {
    fail(TRADE_EXECUTION_CODES.roleDenied);
  }
  return true;
}

function assertTradeApprovalState({ command, context } = {}) {
  assertSharedExecutionState({
    command,
    context,
    expectedStatus: "awaiting_commissioner_approval",
  });
  if (
    context.has_future_considerations !== 1 ||
    !commissionerAuthorized(command, context)
  ) {
    fail(TRADE_EXECUTION_CODES.roleDenied);
  }
  return true;
}

module.exports = {
  EXECUTION_AUTHORITIES,
  TRADE_EXECUTION_CODES,
  TradeExecutionPolicyError,
  assertTradeApprovalState,
  assertTradeExecutionState,
  validateTradeApprovalCommand,
  validateTradeExecutionCommand,
  validateTradeExecutionInput,
};
