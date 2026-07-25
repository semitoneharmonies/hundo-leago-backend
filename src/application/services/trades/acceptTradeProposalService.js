const {
  TRADE_EXECUTION_CODES,
  TradeExecutionPolicyError,
  validateTradeExecutionInput,
} = require("../../../domain/trades/tradeExecutionPolicy");

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade acceptance requires ${description}`);
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("trade acceptance requires a safe clock");
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
    throw new TradeExecutionPolicyError(
      TRADE_EXECUTION_CODES.idempotencyInvalid
    );
  }
  return value;
}

function projectResult(result) {
  return Object.freeze({
    code: result.replayed
      ? "TRADE_ACCEPTANCE_REPLAYED"
      : "TRADE_ACCEPTED",
    replayed: result.replayed,
    proposal: Object.freeze({
      id: result.trade.id,
      leagueId: result.trade.league_id,
      seasonId: result.trade.season_id,
      proposingTeamId: result.trade.proposing_team_id,
      receivingTeamId: result.trade.receiving_team_id,
      status: "Accepted",
      storageStatus: result.trade.status,
      respondedAtMs: result.trade.responded_at_ms,
      completedAtMs: result.trade.completed_at_ms,
      version: result.trade.version,
    }),
    generallyIllegal: result.event.metadata.generallyIllegal,
    teams: result.event.metadata.teams,
    transfers: result.event.metadata.transfers,
    automaticallyCancelledTradeIds:
      result.event.metadata.automaticallyCancelledTradeIds,
    event: Object.freeze({
      id: result.event.id,
      type: result.event.event_type,
      actorUserId: result.event.actor_user_id,
      occurredAtMs: result.event.occurred_at_ms,
    }),
  });
}

function createAcceptTradeProposalService({
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
  for (const method of ["findLifecycleParticipants", "executeAcceptance"]) {
    assertMethod(repository, method, "an atomic trade-execution repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function authority(authenticated, leagueId, receivingTeamId) {
    try {
      return leagueAuthorization.requireCommissioner(authenticated, leagueId);
    } catch (error) {
      if (error?.code !== "LEAGUE_COMMISSIONER_REQUIRED") throw error;
    }
    return teamAuthorization.requireManager(
      authenticated,
      leagueId,
      receivingTeamId
    );
  }

  function accept({ leagueId, input, idempotencyKey, authenticated } = {}) {
    const body = validateTradeExecutionInput(input);
    leagueAuthorization.requireActiveMembership(authenticated, leagueId);
    const proposal = repository.findLifecycleParticipants({
      leagueId,
      tradeId: body.tradeId,
    });
    if (!proposal) {
      throw new TradeExecutionPolicyError(TRADE_EXECUTION_CODES.notFound);
    }
    if (!Number.isSafeInteger(proposal.effective_deadline_at_ms)) {
      throw new TradeExecutionPolicyError(TRADE_EXECUTION_CODES.stateInvalid);
    }
    const actor = authority(
      authenticated,
      proposal.league_id,
      proposal.receiving_team_id
    );
    const occurredAtMs = safeNow(clock);
    return projectResult(
      repository.executeAcceptance({
        tradeId: proposal.trade_id,
        eventId: secureRandom.id(),
        idempotencyRequestId: secureRandom.id(),
        leagueId: proposal.league_id,
        seasonId: proposal.season_id,
        proposingTeamId: proposal.proposing_team_id,
        receivingTeamId: proposal.receiving_team_id,
        expectedVersion: proposal.version,
        actorUserId: actor.actorUserId,
        actorMembershipId: actor.membershipId,
        actorAuthority: actor.authority,
        occurredAtMs,
        effectiveDeadlineAtMs: proposal.effective_deadline_at_ms,
        idempotencyKey: canonicalIdempotencyKey(idempotencyKey),
        idempotencyExpiresAtMs: occurredAtMs + IDEMPOTENCY_LIFETIME_MS,
      })
    );
  }

  return Object.freeze({ accept });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  createAcceptTradeProposalService,
};
