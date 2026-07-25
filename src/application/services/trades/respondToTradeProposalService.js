const {
  TRADE_LIFECYCLE_CODES,
  TradeLifecyclePolicyError,
  validateTradeLifecycleInput,
} = require("../../../domain/trades/tradeLifecyclePolicy");

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade lifecycle response requires ${description}`);
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("trade lifecycle response requires a safe clock");
  }
  return value;
}

function idempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new TradeLifecyclePolicyError(
      TRADE_LIFECYCLE_CODES.idempotencyInvalid
    );
  }
  return value;
}

function projectResult(result, action) {
  const status = action === "reject" ? "Rejected" : "Cancelled";
  return Object.freeze({
    code: result.replayed
      ? "TRADE_LIFECYCLE_REPLAYED"
      : action === "reject"
        ? "TRADE_PROPOSAL_REJECTED"
        : "TRADE_PROPOSAL_CANCELLED",
    replayed: result.replayed,
    proposal: Object.freeze({
      id: result.trade.id,
      leagueId: result.trade.league_id,
      seasonId: result.trade.season_id,
      proposingTeamId: result.trade.proposing_team_id,
      receivingTeamId: result.trade.receiving_team_id,
      status,
      storageStatus: result.trade.status,
      respondedAtMs: result.trade.responded_at_ms,
      version: result.trade.version,
    }),
    event: Object.freeze({
      id: result.event.id,
      type: result.event.event_type,
      actorUserId: result.event.actor_user_id,
      occurredAtMs: result.event.occurred_at_ms,
      metadata: result.event.metadata,
    }),
  });
}

function createRespondToTradeProposalService({
  leagueAuthorization,
  teamAuthorization,
  repository,
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
  for (const method of ["findLifecycleParticipants", "transitionLifecycle"]) {
    assertMethod(repository, method, "an atomic trade lifecycle repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function authority(authenticated, leagueId, teamId) {
    try {
      return leagueAuthorization.requireCommissioner(authenticated, leagueId);
    } catch (error) {
      if (error?.code !== "LEAGUE_COMMISSIONER_REQUIRED") throw error;
    }
    return teamAuthorization.requireManager(authenticated, leagueId, teamId);
  }

  function respond({ leagueId, input, idempotencyKey: key, authenticated } = {}) {
    const body = validateTradeLifecycleInput(input);
    leagueAuthorization.requireActiveMembership(authenticated, leagueId);
    const proposal = repository.findLifecycleParticipants({
      leagueId,
      tradeId: body.tradeId,
    });
    if (!proposal) {
      throw new TradeLifecyclePolicyError(TRADE_LIFECYCLE_CODES.notFound);
    }
    if (!Number.isSafeInteger(proposal.effective_deadline_at_ms)) {
      throw new TradeLifecyclePolicyError(TRADE_LIFECYCLE_CODES.stateInvalid);
    }
    const participantTeamId =
      body.action === "reject"
        ? proposal.receiving_team_id
        : proposal.proposing_team_id;
    const actor = authority(authenticated, leagueId, participantTeamId);
    const occurredAtMs = safeNow(clock);
    const result = repository.transitionLifecycle({
      tradeId: proposal.trade_id,
      eventId: secureRandom.id(),
      idempotencyRequestId: secureRandom.id(),
      leagueId: proposal.league_id,
      seasonId: proposal.season_id,
      proposingTeamId: proposal.proposing_team_id,
      receivingTeamId: proposal.receiving_team_id,
      expectedVersion: proposal.version,
      action: body.action,
      actorUserId: actor.actorUserId,
      actorMembershipId: actor.membershipId,
      actorAuthority: actor.authority,
      occurredAtMs,
      effectiveDeadlineAtMs: proposal.effective_deadline_at_ms,
      idempotencyKey: idempotencyKey(key),
      idempotencyExpiresAtMs: occurredAtMs + IDEMPOTENCY_LIFETIME_MS,
    });
    return projectResult(result, body.action);
  }

  return Object.freeze({ respond });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  createRespondToTradeProposalService,
};
