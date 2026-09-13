const {
  TRADE_EXECUTION_CODES,
  TradeExecutionPolicyError,
  validateTradeExecutionInput,
} = require("../../../domain/trades/tradeExecutionPolicy");

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const LATE_LOCK_STATUSES = new Set([
  "awaiting_data",
  "completed",
  "not_applicable",
  "still_illegal",
]);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const AWAITING_DATA_LATE_LOCK = Object.freeze({ status: "awaiting_data" });

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

function safeLateLockProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("trade acceptance received an unsafe late-lock result");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "status" && keys !== "lockId,status") {
    throw new TypeError("trade acceptance received an unsafe late-lock result");
  }
  if (!LATE_LOCK_STATUSES.has(value.status)) {
    throw new TypeError("trade acceptance received an unsafe late-lock result");
  }
  if (
    Object.hasOwn(value, "lockId") &&
    (value.status !== "completed" || !UUID_PATTERN.test(value.lockId || ""))
  ) {
    throw new TypeError("trade acceptance received an unsafe late-lock result");
  }
  return Object.freeze({
    status: value.status,
    ...(Object.hasOwn(value, "lockId") ? { lockId: value.lockId } : {}),
  });
}

function projectTransfer(transfer) {
  return Object.freeze({
    assetId: transfer.assetId,
    assetType: transfer.assetType,
    sourceTeamId: transfer.sourceTeamId,
    destinationTeamId: transfer.destinationTeamId,
    plannedRosterSlotNumber: transfer.plannedRosterSlotNumber,
  });
}

function committedBatch(result) {
  const teams = result?.committedTeams;
  const trade = result?.trade;
  if (
    !Array.isArray(teams) ||
    teams.length !== 2 ||
    !trade ||
    !UUID_PATTERN.test(trade.league_id || "") ||
    !UUID_PATTERN.test(trade.season_id || "") ||
    !UUID_PATTERN.test(trade.proposing_team_id || "") ||
    !UUID_PATTERN.test(trade.receiving_team_id || "") ||
    trade.proposing_team_id === trade.receiving_team_id
  ) {
    throw new TypeError("trade acceptance requires its committed team receipt");
  }

  const expectedTeamIds = new Set([
    trade.proposing_team_id,
    trade.receiving_team_id,
  ]);
  const seenOwnershipIds = new Set();
  let previousTeamId = null;
  const committedTeams = teams.map((team) => {
    if (
      !team ||
      typeof team !== "object" ||
      Array.isArray(team) ||
      Object.keys(team).sort().join(",") !==
        "leagueId,ownershipWitnesses,seasonId,teamId" ||
      team.leagueId !== trade.league_id ||
      team.seasonId !== trade.season_id ||
      !expectedTeamIds.delete(team.teamId) ||
      (previousTeamId !== null && team.teamId <= previousTeamId) ||
      !Array.isArray(team.ownershipWitnesses)
    ) {
      throw new TypeError("trade acceptance requires exact committed team receipts");
    }
    previousTeamId = team.teamId;

    let previousOwnershipId = null;
    const ownershipWitnesses = team.ownershipWitnesses.map((witness) => {
      if (
        !witness ||
        typeof witness !== "object" ||
        Array.isArray(witness) ||
        Object.keys(witness).sort().join(",") !==
          "ownershipId,ownershipVersion,state" ||
        !UUID_PATTERN.test(witness.ownershipId || "") ||
        !Number.isSafeInteger(witness.ownershipVersion) ||
        witness.ownershipVersion < 1 ||
        !["present", "deleted"].includes(witness.state) ||
        (previousOwnershipId !== null &&
          witness.ownershipId <= previousOwnershipId) ||
        seenOwnershipIds.has(witness.ownershipId)
      ) {
        throw new TypeError(
          "trade acceptance requires exact committed ownership witnesses"
        );
      }
      previousOwnershipId = witness.ownershipId;
      seenOwnershipIds.add(witness.ownershipId);
      return Object.freeze({
        ownershipId: witness.ownershipId,
        ownershipVersion: witness.ownershipVersion,
        state: witness.state,
      });
    });
    return Object.freeze({
      leagueId: team.leagueId,
      seasonId: team.seasonId,
      teamId: team.teamId,
      ownershipWitnesses: Object.freeze(ownershipWitnesses),
    });
  });
  if (expectedTeamIds.size !== 0) {
    throw new TypeError("trade acceptance committed team scope is incomplete");
  }
  return Object.freeze({
    mutationKind: "trade_acceptance",
    teams: Object.freeze(committedTeams),
  });
}

function projectResult(result, lateLock, action = "accept") {
  const awaitingCommissionerApproval =
    result.trade.status === "awaiting_commissioner_approval";
  return Object.freeze({
    code: awaitingCommissionerApproval
      ? result.replayed
        ? "TRADE_ACCEPTANCE_REPLAYED"
        : "TRADE_AWAITING_COMMISSIONER_APPROVAL"
      : result.replayed
        ? action === "approve"
          ? "TRADE_APPROVAL_REPLAYED"
          : "TRADE_ACCEPTANCE_REPLAYED"
        : action === "approve"
          ? "TRADE_APPROVED"
          : "TRADE_ACCEPTED",
    replayed: result.replayed,
    proposal: Object.freeze({
      id: result.trade.id,
      leagueId: result.trade.league_id,
      seasonId: result.trade.season_id,
      proposingTeamId: result.trade.proposing_team_id,
      receivingTeamId: result.trade.receiving_team_id,
      status: awaitingCommissionerApproval
        ? "Awaiting Commissioner Approval"
        : "Accepted",
      storageStatus: result.trade.status,
      respondedAtMs: result.trade.responded_at_ms,
      completedAtMs: result.trade.completed_at_ms,
      version: result.trade.version,
    }),
    generallyIllegal: result.event.metadata.generallyIllegal,
    teams: result.event.metadata.teams,
    transfers: Object.freeze(result.event.metadata.transfers.map(projectTransfer)),
    automaticallyCancelledTradeIds:
      result.event.metadata.automaticallyCancelledTradeIds,
    event: Object.freeze({
      id: result.event.id,
      type: result.event.event_type,
      actorUserId: result.event.actor_user_id,
      occurredAtMs: result.event.occurred_at_ms,
    }),
    lateLock,
  });
}

function createAcceptTradeProposalService({
  leagueAuthorization,
  teamAuthorization,
  repository,
  lateLockCoordinator,
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
  assertMethod(
    repository,
    "executeApproval",
    "an atomic trade-approval repository"
  );
  assertMethod(
    lateLockCoordinator,
    "coordinateCommittedRoster",
    "a late-lock coordinator"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  async function accept({ leagueId, input, idempotencyKey, authenticated } = {}) {
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
    const actor = teamAuthorization.requireManager(
      authenticated,
      proposal.league_id,
      proposal.receiving_team_id
    );
    const occurredAtMs = safeNow(clock);
    const result = repository.executeAcceptance({
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
      });
    if (result.trade.status === "awaiting_commissioner_approval") {
      return projectResult(
        result,
        Object.freeze({ status: "not_applicable" })
      );
    }
    let lateLock = AWAITING_DATA_LATE_LOCK;
    try {
      const batch = committedBatch(result);
      lateLock = safeLateLockProjection(
        await lateLockCoordinator.coordinateCommittedRoster(batch)
      );
    } catch {
      lateLock = AWAITING_DATA_LATE_LOCK;
    }
    return projectResult(result, lateLock);
  }

  async function approve({ leagueId, input, idempotencyKey, authenticated } = {}) {
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
    const actor = leagueAuthorization.requireCommissioner(
      authenticated,
      proposal.league_id
    );
    const occurredAtMs = safeNow(clock);
    const result = repository.executeApproval({
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
    });
    let lateLock = AWAITING_DATA_LATE_LOCK;
    try {
      lateLock = safeLateLockProjection(
        await lateLockCoordinator.coordinateCommittedRoster(
          committedBatch(result)
        )
      );
    } catch {
      lateLock = AWAITING_DATA_LATE_LOCK;
    }
    return projectResult(result, lateLock, "approve");
  }

  return Object.freeze({ accept, approve });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  createAcceptTradeProposalService,
};
