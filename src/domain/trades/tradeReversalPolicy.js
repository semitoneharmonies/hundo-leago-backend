const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

const TRADE_REVERSAL_CODES = Object.freeze({
  inputInvalid: "TRADE_REVERSAL_INPUT_INVALID",
  stableIdInvalid: "TRADE_REVERSAL_STABLE_ID_INVALID",
  authorityInvalid: "TRADE_REVERSAL_AUTHORITY_INVALID",
  timestampInvalid: "TRADE_REVERSAL_TIMESTAMP_INVALID",
  versionInvalid: "TRADE_REVERSAL_VERSION_INVALID",
  idempotencyInvalid: "TRADE_REVERSAL_IDEMPOTENCY_INVALID",
  idempotencyConflict: "TRADE_REVERSAL_IDEMPOTENCY_CONFLICT",
  confirmationRequired: "TRADE_REVERSAL_CONFIRMATION_REQUIRED",
  notFound: "TRADE_REVERSAL_NOT_FOUND",
  notCompleted: "TRADE_REVERSAL_NOT_COMPLETED",
  legacyTrade: "TRADE_REVERSAL_LEGACY_TRADE",
  roleDenied: "TRADE_REVERSAL_ROLE_DENIED",
  versionConflict: "TRADE_REVERSAL_VERSION_CONFLICT",
  safeReversalRequired: "TRADE_REVERSAL_UNSAFE",
  correctionNotRequired: "TRADE_REVERSAL_CORRECTION_NOT_REQUIRED",
  stateInvalid: "TRADE_REVERSAL_STATE_INVALID",
});

const TRADE_REVERSAL_REASON_CODES = Object.freeze({
  snapshotInvalid: "SNAPSHOT_INVALID",
  assetMissing: "ASSET_MISSING",
  assetMoved: "ASSET_MOVED",
  assetConsumed: "ASSET_CONSUMED",
  assetChanged: "ASSET_CHANGED",
  obligationChanged: "OBLIGATION_CHANGED",
  createdObligationMissing: "CREATED_OBLIGATION_MISSING",
  createdObligationChanged: "CREATED_OBLIGATION_CHANGED",
  originalSlotOccupied: "ORIGINAL_SLOT_OCCUPIED",
});

class TradeReversalPolicyError extends Error {
  constructor(reasonCode) {
    super("The trade recovery request is invalid.");
    this.name = "TradeReversalPolicyError";
    this.code = TRADE_REVERSAL_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TradeReversalPolicyError(reasonCode);
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRADE_REVERSAL_CODES.inputInvalid);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(TRADE_REVERSAL_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(TRADE_REVERSAL_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    fail(TRADE_REVERSAL_CODES.timestampInvalid);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(TRADE_REVERSAL_CODES.versionInvalid);
  }
  return value;
}

function idempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    fail(TRADE_REVERSAL_CODES.idempotencyInvalid);
  }
  return value;
}

function validateTradeReversalPreviewInput(input) {
  exactObject(input, ["tradeId"]);
  return Object.freeze({ tradeId: stableId(input.tradeId) });
}

function validateTradeRecoveryWriteInput(input) {
  exactObject(input, ["tradeId", "confirmed"]);
  if (input.confirmed !== true) {
    fail(TRADE_REVERSAL_CODES.confirmationRequired);
  }
  return Object.freeze({ tradeId: stableId(input.tradeId), confirmed: true });
}

function validateTradeReversalPreviewCommand(input) {
  exactObject(input, [
    "tradeId",
    "leagueId",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
  ]);
  if (input.actorAuthority !== "commissioner") {
    fail(TRADE_REVERSAL_CODES.authorityInvalid);
  }
  return Object.freeze({
    tradeId: stableId(input.tradeId),
    leagueId: stableId(input.leagueId),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: "commissioner",
  });
}

function validateTradeRecoveryCommand(input) {
  exactObject(input, [
    "tradeId",
    "eventId",
    "correctionId",
    "activityId",
    "outboxEventId",
    "idempotencyRequestId",
    "leagueId",
    "seasonId",
    "expectedVersion",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "action",
    "confirmed",
    "occurredAtMs",
    "idempotencyKey",
    "idempotencyExpiresAtMs",
  ]);
  if (input.actorAuthority !== "commissioner") {
    fail(TRADE_REVERSAL_CODES.authorityInvalid);
  }
  if (!['reverse', 'correction_required'].includes(input.action)) {
    fail(TRADE_REVERSAL_CODES.inputInvalid);
  }
  if (input.confirmed !== true) {
    fail(TRADE_REVERSAL_CODES.confirmationRequired);
  }
  const command = {
    tradeId: stableId(input.tradeId),
    eventId: stableId(input.eventId),
    correctionId: stableId(input.correctionId),
    activityId: stableId(input.activityId),
    outboxEventId: stableId(input.outboxEventId),
    idempotencyRequestId: stableId(input.idempotencyRequestId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    expectedVersion: positiveVersion(input.expectedVersion),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: "commissioner",
    action: input.action,
    confirmed: true,
    occurredAtMs: safeTimestamp(input.occurredAtMs),
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    idempotencyExpiresAtMs: safeTimestamp(input.idempotencyExpiresAtMs),
  };
  if (command.idempotencyExpiresAtMs <= command.occurredAtMs) {
    fail(TRADE_REVERSAL_CODES.stateInvalid);
  }
  return Object.freeze(command);
}

function assertTradeRecoveryState({ command, context }) {
  if (!context) fail(TRADE_REVERSAL_CODES.notFound);
  if (
    context.trade_id !== command.tradeId ||
    context.league_id !== command.leagueId ||
    context.season_id !== command.seasonId
  ) {
    fail(TRADE_REVERSAL_CODES.stateInvalid);
  }
  if (context.trade_status !== "completed") {
    fail(TRADE_REVERSAL_CODES.notCompleted);
  }
  if (context.proposal_model_version !== 2) {
    fail(TRADE_REVERSAL_CODES.legacyTrade);
  }
  if (context.trade_version !== command.expectedVersion) {
    fail(TRADE_REVERSAL_CODES.versionConflict);
  }
  if (
    context.commissioner_membership_id !== command.actorMembershipId ||
    context.membership_user_id !== command.actorUserId ||
    context.membership_status !== "active" ||
    context.membership_permission !== "commissioner" ||
    command.actorAuthority !== "commissioner"
  ) {
    fail(TRADE_REVERSAL_CODES.roleDenied);
  }
  return true;
}

function assertRecoveryActionAllowed(action, recoverable) {
  if (action === "reverse" && !recoverable) {
    fail(TRADE_REVERSAL_CODES.safeReversalRequired);
  }
  if (action === "correction_required" && recoverable) {
    fail(TRADE_REVERSAL_CODES.correctionNotRequired);
  }
  return true;
}

module.exports = {
  TRADE_REVERSAL_CODES,
  TRADE_REVERSAL_REASON_CODES,
  TradeReversalPolicyError,
  assertRecoveryActionAllowed,
  assertTradeRecoveryState,
  validateTradeRecoveryCommand,
  validateTradeRecoveryWriteInput,
  validateTradeReversalPreviewCommand,
  validateTradeReversalPreviewInput,
};
