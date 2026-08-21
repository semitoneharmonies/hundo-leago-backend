const {
  boundedIdempotencyKey,
  createTradeAssetCommands,
  validateTradeProposalCreationInput,
} = require("../../../domain/trades/tradeAssetPolicy");
const {
  assertTradeProposalFoundationState,
  deriveTradeProposalTiming,
  requireCurrentTradeSeasonId,
  validateTradeProposalFoundationCommand,
} = require("../../../domain/trades/tradeProposalPolicy");

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade proposal creation requires ${description}`);
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("trade proposal creation requires a safe clock");
  }
  return value;
}

function projectResult(result) {
  return Object.freeze({
    code: result.replayed
      ? "TRADE_PROPOSAL_REPLAYED"
      : "TRADE_PROPOSAL_CREATED",
    replayed: result.replayed,
    proposal: Object.freeze({
      id: result.trade.id,
      leagueId: result.trade.league_id,
      seasonId: result.trade.season_id,
      proposingTeamId: result.trade.proposing_team_id,
      receivingTeamId: result.trade.receiving_team_id,
      creatingActor: Object.freeze({
        userId: result.trade.proposing_user_id,
        membershipId: result.trade.creating_membership_id,
        authority: result.trade.creating_authority,
      }),
      status: "Pending",
      createdAtMs: result.trade.created_at_ms,
      expiresAtMs: result.trade.expires_at_ms,
      effectiveDeadlineAtMs: result.trade.effective_deadline_at_ms,
      version: result.trade.version,
      assets: Object.freeze(
        result.assets.map((asset) =>
          Object.freeze({
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
            snapshot: asset.proposal_snapshot,
          })
        )
      ),
    }),
    event: Object.freeze({
      id: result.event.id,
      type: result.event.event_type,
      occurredAtMs: result.event.occurred_at_ms,
      metadata: result.event.metadata,
    }),
  });
}

function createTradeProposalService({
  teamAuthorization,
  repository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(teamAuthorization, "requireManager", "team-manager authorization");
  for (const method of ["loadFoundationState", "createProposal"]) {
    assertMethod(repository, method, "an atomic trade proposal repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function create({ leagueId, input, idempotencyKey, authenticated } = {}) {
    const body = validateTradeProposalCreationInput(input);
    const canonicalIdempotencyKey = boundedIdempotencyKey(idempotencyKey);
    const authority = teamAuthorization.requireManager(
      authenticated,
      leagueId,
      body.proposingTeamId
    );
    const context = repository.loadFoundationState({
      leagueId: authority.leagueId,
      proposingTeamId: body.proposingTeamId,
      receivingTeamId: body.receivingTeamId,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
    });
    const seasonId = requireCurrentTradeSeasonId(context);
    const createdAtMs = safeNow(clock);
    const tradeId = secureRandom.id();
    const foundation = validateTradeProposalFoundationCommand({
      proposalId: tradeId,
      leagueId: authority.leagueId,
      seasonId,
      proposingTeamId: body.proposingTeamId,
      receivingTeamId: body.receivingTeamId,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      createdAtMs,
    });
    assertTradeProposalFoundationState({ command: foundation, context });
    const timing = deriveTradeProposalTiming({
      createdAtMs,
      tradeDeadlineAtMs: context.trade_deadline_at_ms,
    });
    const assetIds = Array.from(
      { length: body.proposingAssets.length + body.receivingAssets.length },
      () => secureRandom.id()
    );
    const assets = createTradeAssetCommands({
      input: body,
      assetIds,
      createdAtMs,
    });
    const result = repository.createProposal({
      tradeId,
      eventId: secureRandom.id(),
      idempotencyRequestId: secureRandom.id(),
      leagueId: foundation.leagueId,
      seasonId: foundation.seasonId,
      proposingTeamId: foundation.proposingTeamId,
      receivingTeamId: foundation.receivingTeamId,
      actorUserId: foundation.actorUserId,
      actorMembershipId: foundation.actorMembershipId,
      actorAuthority: foundation.actorAuthority,
      createdAtMs,
      expiresAtMs: timing.expiresAtMs,
      effectiveDeadlineAtMs: timing.effectiveDeadlineAtMs,
      idempotencyKey: canonicalIdempotencyKey,
      idempotencyExpiresAtMs: createdAtMs + IDEMPOTENCY_LIFETIME_MS,
      assets,
    });
    return projectResult(result);
  }

  return Object.freeze({ create });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  createTradeProposalService,
};
