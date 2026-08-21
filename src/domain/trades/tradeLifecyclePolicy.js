const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const LIFECYCLE_ACTIONS = Object.freeze(["reject", "cancel"]);
const OPEN_PROPOSAL_STATUSES = Object.freeze([
  "proposed",
  "awaiting_commissioner_approval",
]);

const TRADE_LIFECYCLE_CODES = Object.freeze({
  inputInvalid: "TRADE_LIFECYCLE_INPUT_INVALID",
  stableIdInvalid: "TRADE_LIFECYCLE_STABLE_ID_INVALID",
  actionInvalid: "TRADE_LIFECYCLE_ACTION_INVALID",
  authorityInvalid: "TRADE_LIFECYCLE_AUTHORITY_INVALID",
  timestampInvalid: "TRADE_LIFECYCLE_TIMESTAMP_INVALID",
  versionInvalid: "TRADE_LIFECYCLE_VERSION_INVALID",
  idempotencyInvalid: "TRADE_LIFECYCLE_IDEMPOTENCY_INVALID",
  idempotencyConflict: "TRADE_LIFECYCLE_IDEMPOTENCY_CONFLICT",
  notFound: "TRADE_LIFECYCLE_NOT_FOUND",
  notPending: "TRADE_LIFECYCLE_NOT_PENDING",
  roleDenied: "TRADE_LIFECYCLE_ROLE_DENIED",
  windowClosed: "TRADE_LIFECYCLE_WINDOW_CLOSED",
  stateInvalid: "TRADE_LIFECYCLE_STATE_INVALID",
  versionConflict: "TRADE_LIFECYCLE_VERSION_CONFLICT",
});

class TradeLifecyclePolicyError extends Error {
  constructor(reasonCode) {
    super("The trade proposal lifecycle request is invalid.");
    this.name = "TradeLifecyclePolicyError";
    this.code = TRADE_LIFECYCLE_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TradeLifecyclePolicyError(reasonCode);
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRADE_LIFECYCLE_CODES.inputInvalid);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(TRADE_LIFECYCLE_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(TRADE_LIFECYCLE_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(TRADE_LIFECYCLE_CODES.timestampInvalid);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(TRADE_LIFECYCLE_CODES.versionInvalid);
  }
  return value;
}

function boundedText(value, maximum, reasonCode) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function lifecycleAction(value) {
  if (!LIFECYCLE_ACTIONS.includes(value)) {
    fail(TRADE_LIFECYCLE_CODES.actionInvalid);
  }
  return value;
}

function validateTradeLifecycleInput(input) {
  exactObject(input, ["tradeId", "action"]);
  return Object.freeze({
    tradeId: stableId(input.tradeId),
    action: lifecycleAction(input.action),
  });
}

function validateTradeLifecycleCommand(input) {
  exactObject(input, [
    "tradeId",
    "eventId",
    "idempotencyRequestId",
    "leagueId",
    "seasonId",
    "proposingTeamId",
    "receivingTeamId",
    "expectedVersion",
    "action",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "occurredAtMs",
    "effectiveDeadlineAtMs",
    "idempotencyKey",
    "idempotencyExpiresAtMs",
  ]);
  if (
    !["manager", "commissioner", "platform_administrator"].includes(
      input.actorAuthority
    )
  ) {
    fail(TRADE_LIFECYCLE_CODES.authorityInvalid);
  }
  const occurredAtMs = safeTimestamp(input.occurredAtMs);
  const effectiveDeadlineAtMs = safeTimestamp(input.effectiveDeadlineAtMs);
  const idempotencyExpiresAtMs = safeTimestamp(input.idempotencyExpiresAtMs);
  if (idempotencyExpiresAtMs <= occurredAtMs) {
    fail(TRADE_LIFECYCLE_CODES.timestampInvalid);
  }
  const command = {
    tradeId: stableId(input.tradeId),
    eventId: stableId(input.eventId),
    idempotencyRequestId: stableId(input.idempotencyRequestId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    proposingTeamId: stableId(input.proposingTeamId),
    receivingTeamId: stableId(input.receivingTeamId),
    expectedVersion: positiveVersion(input.expectedVersion),
    action: lifecycleAction(input.action),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    occurredAtMs,
    effectiveDeadlineAtMs,
    idempotencyKey: boundedText(
      input.idempotencyKey,
      128,
      TRADE_LIFECYCLE_CODES.idempotencyInvalid
    ),
    idempotencyExpiresAtMs,
  };
  if (command.proposingTeamId === command.receivingTeamId) {
    fail(TRADE_LIFECYCLE_CODES.stateInvalid);
  }
  return Object.freeze(command);
}

function expectedManagerTeamId(command) {
  return command.action === "reject"
    ? command.receivingTeamId
    : command.proposingTeamId;
}

function assertTradeLifecycleState({ command, context } = {}) {
  if (!context) fail(TRADE_LIFECYCLE_CODES.notFound);
  if (
    context.trade_id !== command.tradeId ||
    context.league_id !== command.leagueId ||
    context.season_id !== command.seasonId ||
    context.proposing_team_id !== command.proposingTeamId ||
    context.receiving_team_id !== command.receivingTeamId ||
    context.effective_deadline_at_ms !== command.effectiveDeadlineAtMs
  ) {
    fail(TRADE_LIFECYCLE_CODES.stateInvalid);
  }
  if (!OPEN_PROPOSAL_STATUSES.includes(context.trade_status)) {
    fail(TRADE_LIFECYCLE_CODES.notPending);
  }
  if (
    command.occurredAtMs >= context.effective_deadline_at_ms ||
    context.season_status !== "active"
  ) {
    fail(TRADE_LIFECYCLE_CODES.windowClosed);
  }
  const managerAuthorized =
    command.actorAuthority === "manager" &&
    context.league_status === "active" &&
    context.membership_user_id === command.actorUserId &&
    context.membership_status === "active" &&
    context.assignment_team_id === expectedManagerTeamId(command) &&
    context.assignment_status === "accepted" &&
    context.assignment_accepted_at_ms !== null &&
    context.assignment_ended_at_ms === null;
  if (!managerAuthorized) {
    fail(TRADE_LIFECYCLE_CODES.roleDenied);
  }
  return true;
}

function validateTradeAcceptancePreviewInput(input) {
  exactObject(input, ["tradeId"]);
  return Object.freeze({ tradeId: stableId(input.tradeId) });
}

function validateTradeAcceptancePreviewCommand(input) {
  exactObject(input, [
    "tradeId",
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
  ]);
  if (
    !["manager", "commissioner", "platform_administrator"].includes(
      input.actorAuthority
    )
  ) {
    fail(TRADE_LIFECYCLE_CODES.authorityInvalid);
  }
  const command = Object.freeze({
    tradeId: stableId(input.tradeId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    proposingTeamId: stableId(input.proposingTeamId),
    receivingTeamId: stableId(input.receivingTeamId),
    expectedVersion: positiveVersion(input.expectedVersion),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    occurredAtMs: safeTimestamp(input.occurredAtMs),
    effectiveDeadlineAtMs: safeTimestamp(input.effectiveDeadlineAtMs),
  });
  if (command.proposingTeamId === command.receivingTeamId) {
    fail(TRADE_LIFECYCLE_CODES.stateInvalid);
  }
  return command;
}

function assertTradeAcceptancePreviewState({ command, context } = {}) {
  if (!context) fail(TRADE_LIFECYCLE_CODES.notFound);
  if (
    context.trade_id !== command.tradeId ||
    context.league_id !== command.leagueId ||
    context.season_id !== command.seasonId ||
    context.proposing_team_id !== command.proposingTeamId ||
    context.receiving_team_id !== command.receivingTeamId ||
    context.effective_deadline_at_ms !== command.effectiveDeadlineAtMs ||
    context.trade_version !== command.expectedVersion
  ) {
    fail(TRADE_LIFECYCLE_CODES.stateInvalid);
  }
  if (!OPEN_PROPOSAL_STATUSES.includes(context.trade_status)) {
    fail(TRADE_LIFECYCLE_CODES.notPending);
  }
  if (
    command.occurredAtMs >= context.effective_deadline_at_ms ||
    context.season_status !== "active"
  ) {
    fail(TRADE_LIFECYCLE_CODES.windowClosed);
  }
  const managerAuthorized =
    command.actorAuthority === "manager" &&
    context.league_status === "active" &&
    context.membership_user_id === command.actorUserId &&
    context.membership_status === "active" &&
    context.assignment_team_id === command.receivingTeamId &&
    context.assignment_status === "accepted" &&
    context.assignment_accepted_at_ms !== null &&
    context.assignment_ended_at_ms === null;
  const commissionerApprovalAuthorized =
    context.trade_status === "awaiting_commissioner_approval" &&
    ["active", "frozen"].includes(context.league_status) &&
    context.membership_user_id === command.actorUserId &&
    context.membership_status === "active" &&
    ((command.actorAuthority === "commissioner" &&
      context.commissioner_membership_id === command.actorMembershipId &&
      context.membership_permission === "commissioner") ||
      (command.actorAuthority === "platform_administrator" &&
        context.is_platform_administrator === 1));
  if (!managerAuthorized && !commissionerApprovalAuthorized) {
    fail(TRADE_LIFECYCLE_CODES.roleDenied);
  }
  return true;
}

function validateTradeExpiryCommand(input) {
  exactObject(input, [
    "tradeId",
    "eventId",
    "leagueId",
    "seasonId",
    "expectedVersion",
    "effectiveDeadlineAtMs",
    "occurredAtMs",
    "occurrenceKey",
  ]);
  const command = {
    tradeId: stableId(input.tradeId),
    eventId: stableId(input.eventId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    expectedVersion: positiveVersion(input.expectedVersion),
    effectiveDeadlineAtMs: safeTimestamp(input.effectiveDeadlineAtMs),
    occurredAtMs: safeTimestamp(input.occurredAtMs),
    occurrenceKey: boundedText(
      input.occurrenceKey,
      200,
      TRADE_LIFECYCLE_CODES.inputInvalid
    ),
  };
  if (
    command.occurredAtMs < command.effectiveDeadlineAtMs ||
    command.occurrenceKey !== buildTradeExpiryOccurrenceKey(command)
  ) {
    fail(TRADE_LIFECYCLE_CODES.windowClosed);
  }
  return Object.freeze(command);
}

function buildTradeExpiryOccurrenceKey({ tradeId, effectiveDeadlineAtMs } = {}) {
  return `trade-expiry:${stableId(tradeId)}:${safeTimestamp(
    effectiveDeadlineAtMs
  )}`;
}

function assertTradeExpiryState({ command, context } = {}) {
  if (!context) fail(TRADE_LIFECYCLE_CODES.notFound);
  if (
    context.trade_id !== command.tradeId ||
    context.league_id !== command.leagueId ||
    context.season_id !== command.seasonId ||
    context.effective_deadline_at_ms !== command.effectiveDeadlineAtMs
  ) {
    fail(TRADE_LIFECYCLE_CODES.stateInvalid);
  }
  if (!OPEN_PROPOSAL_STATUSES.includes(context.trade_status)) {
    fail(TRADE_LIFECYCLE_CODES.notPending);
  }
  if (command.occurredAtMs < context.effective_deadline_at_ms) {
    fail(TRADE_LIFECYCLE_CODES.windowClosed);
  }
  return true;
}

module.exports = {
  LIFECYCLE_ACTIONS,
  OPEN_PROPOSAL_STATUSES,
  TRADE_LIFECYCLE_CODES,
  TradeLifecyclePolicyError,
  assertTradeAcceptancePreviewState,
  assertTradeExpiryState,
  assertTradeLifecycleState,
  buildTradeExpiryOccurrenceKey,
  expectedManagerTeamId,
  validateTradeAcceptancePreviewCommand,
  validateTradeAcceptancePreviewInput,
  validateTradeExpiryCommand,
  validateTradeLifecycleCommand,
  validateTradeLifecycleInput,
};
