const {
  TRADE_LIFECYCLE_CODES,
  TradeLifecyclePolicyError,
  validateTradeAcceptancePreviewInput,
} = require("../../../domain/trades/tradeLifecyclePolicy");

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade acceptance preview requires ${description}`);
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("trade acceptance preview requires a safe clock");
  }
  return value;
}

function projectAsset(asset) {
  return Object.freeze({
    id: asset.id,
    direction: asset.direction,
    sourceTeamId: asset.source_team_id,
    destinationTeamId: asset.destination_team_id,
    type:
      asset.asset_type === "future_consideration" &&
      asset.future_consideration_description !== null
        ? "future_consideration_instruction"
        : asset.asset_type,
    sequence: asset.sequence,
    plannedRosterSlotNumber: asset.plannedRosterSlotNumber,
    proposalSnapshot: asset.proposalSnapshot,
    currentSnapshot: asset.currentSnapshot,
  });
}

function projectResult(result) {
  return Object.freeze({
    code: "TRADE_ACCEPTANCE_PREVIEWED",
    proposal: Object.freeze({
      id: result.trade.trade_id,
      leagueId: result.trade.league_id,
      seasonId: result.trade.season_id,
      proposingTeamId: result.trade.proposing_team_id,
      receivingTeamId: result.trade.receiving_team_id,
      status: "Pending",
      effectiveDeadlineAtMs: result.trade.effective_deadline_at_ms,
      version: result.trade.trade_version,
    }),
    assets: Object.freeze(result.assets.map(projectAsset)),
    teams: result.teams,
    generallyIllegal: result.generallyIllegal,
  });
}

function createPreviewTradeAcceptanceService({
  leagueAuthorization,
  teamAuthorization,
  repository,
  clock,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveMembership",
    "league membership authorization"
  );
  assertMethod(teamAuthorization, "requireManager", "team-manager authorization");
  for (const method of ["findLifecycleParticipants", "previewAcceptance"]) {
    assertMethod(repository, method, "a read-only trade preview repository");
  }
  assertMethod(clock, "nowMs", "a clock");

  function preview({ leagueId, input, authenticated } = {}) {
    const body = validateTradeAcceptancePreviewInput(input);
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
    const actor = teamAuthorization.requireManager(
      authenticated,
      proposal.league_id,
      proposal.receiving_team_id
    );
    return projectResult(
      repository.previewAcceptance({
        tradeId: proposal.trade_id,
        leagueId: proposal.league_id,
        seasonId: proposal.season_id,
        proposingTeamId: proposal.proposing_team_id,
        receivingTeamId: proposal.receiving_team_id,
        expectedVersion: proposal.version,
        actorUserId: actor.actorUserId,
        actorMembershipId: actor.membershipId,
        actorAuthority: actor.authority,
        occurredAtMs: safeNow(clock),
        effectiveDeadlineAtMs: proposal.effective_deadline_at_ms,
      })
    );
  }

  return Object.freeze({ preview });
}

module.exports = { createPreviewTradeAcceptanceService };
