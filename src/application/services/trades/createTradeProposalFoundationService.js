const {
  assertTradeProposalFoundationState,
  deriveTradeProposalTiming,
  requireCurrentTradeSeasonId,
  validateTradeProposalFoundationCommand,
  validateTradeProposalFoundationInput,
  validateTradeProposalFoundationRequest,
} = require("../../../domain/trades/tradeProposalPolicy");

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `trade proposal foundation requires ${description}`
    );
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("trade proposal foundation requires a safe clock");
  }
  return value;
}

function createTradeProposalFoundationService({
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
  for (const method of ["loadFoundationState", "listVisible"]) {
    assertMethod(repository, method, "a SELECT-only trade proposal repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function proposalAuthority(authenticated, leagueId, proposingTeamId) {
    try {
      return leagueAuthorization.requireCommissioner(authenticated, leagueId);
    } catch (error) {
      if (error?.code !== "LEAGUE_COMMISSIONER_REQUIRED") throw error;
    }
    return teamAuthorization.requireManager(
      authenticated,
      leagueId,
      proposingTeamId
    );
  }

  function preview({ leagueId, input, authenticated } = {}) {
    const participants = validateTradeProposalFoundationInput(input);
    const request = validateTradeProposalFoundationRequest({
      leagueId,
      ...participants,
    });
    const authority = proposalAuthority(
      authenticated,
      request.leagueId,
      request.proposingTeamId
    );
    const context = repository.loadFoundationState({
      ...request,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
    });
    const seasonId = requireCurrentTradeSeasonId(context);
    const command = validateTradeProposalFoundationCommand({
      proposalId: secureRandom.id(),
      leagueId: request.leagueId,
      seasonId,
      proposingTeamId: request.proposingTeamId,
      receivingTeamId: request.receivingTeamId,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      createdAtMs: safeNow(clock),
    });
    assertTradeProposalFoundationState({ command, context });
    const timing = deriveTradeProposalTiming({
      createdAtMs: command.createdAtMs,
      tradeDeadlineAtMs: context.trade_deadline_at_ms,
    });
    return Object.freeze({
      code: "TRADE_PROPOSAL_PREVIEW_READY",
      persisted: false,
      proposal: Object.freeze({
        id: command.proposalId,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        proposingTeamId: command.proposingTeamId,
        receivingTeamId: command.receivingTeamId,
        creatingActor: Object.freeze({
          userId: command.actorUserId,
          membershipId: command.actorMembershipId,
          authority: command.actorAuthority,
        }),
        status: "Preview",
        ...timing,
      }),
    });
  }

  function list({ leagueId, authenticated } = {}) {
    const authority = leagueAuthorization.requireActiveMembership(
      authenticated,
      leagueId
    );
    return Object.freeze({
      code: "TRADE_PROPOSALS_FOUND",
      proposals: repository.listVisible({
        leagueId: authority.leagueId,
        viewerUserId: authority.actorUserId,
        viewerMembershipId: authority.membershipId,
      }),
    });
  }

  return Object.freeze({ list, preview });
}

module.exports = {
  createTradeProposalFoundationService,
};
