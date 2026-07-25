const {
  TRADE_REVERSAL_CODES,
  TradeReversalPolicyError,
  validateTradeRecoveryWriteInput,
  validateTradeReversalPreviewInput,
} = require("../../../domain/trades/tradeReversalPolicy");

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade recovery requires ${description}`);
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("trade recovery requires a safe clock");
  }
  return value;
}

function canonicalIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new TradeReversalPolicyError(
      TRADE_REVERSAL_CODES.idempotencyInvalid
    );
  }
  return value;
}

function projectRecovery(result, action) {
  return Object.freeze({
    code: result.replayed
      ? "TRADE_RECOVERY_REPLAYED"
      : action === "reverse"
        ? "TRADE_REVERSED"
        : "TRADE_CORRECTION_REQUIRED",
    replayed: result.replayed,
    trade: Object.freeze({
      id: result.trade.id,
      leagueId: result.trade.league_id,
      seasonId: result.trade.season_id,
      proposingTeamId: result.trade.proposing_team_id,
      receivingTeamId: result.trade.receiving_team_id,
      status:
        result.trade.status === "reversed"
          ? "Reversed"
          : "Correction Required",
      storageStatus: result.trade.status,
      version: result.trade.version,
    }),
    event: Object.freeze({
      id: result.event.id,
      type: result.event.event_type,
      reason: result.event.reason,
      actorUserId: result.event.actor_user_id,
      occurredAtMs: result.event.occurred_at_ms,
      metadata: result.event.metadata,
    }),
  });
}

function createTradeReversalService({
  leagueAuthorization,
  repository,
  clock,
  secureRandom,
} = {}) {
  for (const method of ["requireActiveMembership", "requireCommissioner"]) {
    assertMethod(
      leagueAuthorization,
      method,
      "league membership and current-commissioner authorization"
    );
  }
  for (const method of ["findRecoveryTarget", "preview", "recover"]) {
    assertMethod(repository, method, "an atomic trade-recovery repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function commissioner(authenticated, leagueId) {
    leagueAuthorization.requireActiveMembership(authenticated, leagueId);
    return leagueAuthorization.requireCommissioner(authenticated, leagueId);
  }

  function target(leagueId, tradeId) {
    const trade = repository.findRecoveryTarget({ leagueId, tradeId });
    if (!trade) {
      throw new TradeReversalPolicyError(TRADE_REVERSAL_CODES.notFound);
    }
    return trade;
  }

  function preview({ leagueId, input, authenticated } = {}) {
    const body = validateTradeReversalPreviewInput(input);
    const actor = commissioner(authenticated, leagueId);
    target(leagueId, body.tradeId);
    return Object.freeze({
      code: "TRADE_REVERSAL_PREVIEWED",
      preview: repository.preview({
        tradeId: body.tradeId,
        leagueId,
        actorUserId: actor.actorUserId,
        actorMembershipId: actor.membershipId,
        actorAuthority: actor.authority,
      }),
    });
  }

  function recover({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    action,
  } = {}) {
    const body = validateTradeRecoveryWriteInput(input);
    const actor = commissioner(authenticated, leagueId);
    const trade = target(leagueId, body.tradeId);
    const occurredAtMs = safeNow(clock);
    const result = repository.recover({
      tradeId: trade.id,
      eventId: secureRandom.id(),
      correctionId: secureRandom.id(),
      activityId: secureRandom.id(),
      outboxEventId: secureRandom.id(),
      idempotencyRequestId: secureRandom.id(),
      leagueId: trade.league_id,
      seasonId: trade.season_id,
      expectedVersion: trade.version,
      actorUserId: actor.actorUserId,
      actorMembershipId: actor.membershipId,
      actorAuthority: actor.authority,
      action,
      confirmed: body.confirmed,
      occurredAtMs,
      idempotencyKey: canonicalIdempotencyKey(idempotencyKey),
      idempotencyExpiresAtMs: occurredAtMs + IDEMPOTENCY_LIFETIME_MS,
    });
    return projectRecovery(result, action);
  }

  return Object.freeze({
    preview,
    reverse(options) {
      return recover({ ...options, action: "reverse" });
    },
    markCorrectionRequired(options) {
      return recover({ ...options, action: "correction_required" });
    },
  });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  createTradeReversalService,
};
