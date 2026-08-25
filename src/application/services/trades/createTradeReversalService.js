const {
  TRADE_REVERSAL_CODES,
  TradeReversalPolicyError,
  validateTradeRecoveryWriteInput,
  validateTradeReversalPreviewInput,
} = require("../../../domain/trades/tradeReversalPolicy");

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

function safeLateLockProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("trade reversal received an unsafe late-lock result");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "status" && keys !== "lockId,status") {
    throw new TypeError("trade reversal received an unsafe late-lock result");
  }
  if (!LATE_LOCK_STATUSES.has(value.status)) {
    throw new TypeError("trade reversal received an unsafe late-lock result");
  }
  if (
    Object.hasOwn(value, "lockId") &&
    (value.status !== "completed" || !UUID_PATTERN.test(value.lockId || ""))
  ) {
    throw new TypeError("trade reversal received an unsafe late-lock result");
  }
  return Object.freeze({
    status: value.status,
    ...(Object.hasOwn(value, "lockId") ? { lockId: value.lockId } : {}),
  });
}

function committedBatch(result) {
  const descriptor = result && Object.getOwnPropertyDescriptor(
    result,
    "committedTeams"
  );
  const receipt = descriptor?.value;
  if (
    !descriptor ||
    descriptor.enumerable ||
    descriptor.writable ||
    descriptor.configurable ||
    !Array.isArray(receipt) ||
    receipt.length < 1 ||
    !Object.isFrozen(receipt)
  ) {
    throw new TypeError("trade reversal requires its committed roster receipt");
  }
  const teams = [];
  const seenTeams = new Set();
  const seenOwnerships = new Set();
  let priorTeamKey = null;
  for (const team of receipt) {
    if (
      !team ||
      typeof team !== "object" ||
      Array.isArray(team) ||
      Object.keys(team).sort().join(",") !==
        "leagueId,ownershipWitnesses,seasonId,teamId" ||
      !UUID_PATTERN.test(team.leagueId || "") ||
      !UUID_PATTERN.test(team.seasonId || "") ||
      !UUID_PATTERN.test(team.teamId || "") ||
      !Array.isArray(team.ownershipWitnesses) ||
      !Object.isFrozen(team) ||
      !Object.isFrozen(team.ownershipWitnesses)
    ) {
      throw new TypeError("trade reversal requires an exact committed team");
    }
    const teamKey = `${team.leagueId}:${team.seasonId}:${team.teamId}`;
    if (
      seenTeams.has(teamKey) ||
      (priorTeamKey !== null && priorTeamKey.localeCompare(teamKey) >= 0)
    ) {
      throw new TypeError("trade reversal requires stable unique committed teams");
    }
    priorTeamKey = teamKey;
    seenTeams.add(teamKey);
    let priorOwnershipId = null;
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
        !["deleted", "present"].includes(witness.state) ||
        seenOwnerships.has(witness.ownershipId) ||
        (priorOwnershipId !== null &&
          priorOwnershipId.localeCompare(witness.ownershipId) >= 0) ||
        !Object.isFrozen(witness)
      ) {
        throw new TypeError(
          "trade reversal requires exact committed ownership witnesses"
        );
      }
      priorOwnershipId = witness.ownershipId;
      seenOwnerships.add(witness.ownershipId);
      return Object.freeze({ ...witness });
    });
    teams.push(Object.freeze({
      leagueId: team.leagueId,
      seasonId: team.seasonId,
      teamId: team.teamId,
      ownershipWitnesses: Object.freeze(ownershipWitnesses),
    }));
  }
  return Object.freeze({
    mutationKind: "trade_reversal",
    teams: Object.freeze(teams),
  });
}

function publicRecoveryMetadata(metadata) {
  const { ownershipTenureMappings, ...publicMetadata } = metadata;
  return Object.freeze(publicMetadata);
}

function projectRecovery(result, action, lateLock) {
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
      metadata: publicRecoveryMetadata(result.event.metadata),
    }),
    ...(action === "reverse" ? { lateLock } : {}),
  });
}

function createTradeReversalService({
  leagueAuthorization,
  repository,
  lateLockCoordinator,
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
  assertMethod(
    lateLockCoordinator,
    "coordinateCommittedRoster",
    "a late-lock coordinator"
  );
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

  async function recover({
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
    if (action !== "reverse") return projectRecovery(result, action);
    let lateLock = AWAITING_DATA_LATE_LOCK;
    try {
      const batch = committedBatch(result);
      lateLock = safeLateLockProjection(
        await lateLockCoordinator.coordinateCommittedRoster(batch)
      );
    } catch {
      lateLock = AWAITING_DATA_LATE_LOCK;
    }
    return projectRecovery(result, action, lateLock);
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
