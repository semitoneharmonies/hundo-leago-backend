const LATE_LOCK_COORDINATOR_STATUSES = Object.freeze([
  "completed",
  "awaiting_data",
  "still_illegal",
  "not_applicable",
]);

const LATE_LOCK_MUTATION_WRITER_REGISTRY = Object.freeze([
  "roster_move",
  "injured_reserve_move",
  "buyout",
  "release",
  "auction_resolution",
  "fad_auction_resolution",
  "candidate_allocation",
  "fad_allocation_correction",
  "candidate_carryover",
  "trade_acceptance",
  "trade_reversal",
  "commissioner_addition",
  "commissioner_removal",
  "commissioner_correction",
  "contract_rollover",
  "contract_correction",
  "prospect_signing",
  "prospect_release",
  "prospect_activation",
  "league_position_correction",
]);

const LATE_LOCK_MAINTENANCE_EXCLUSIONS = Object.freeze([
  "release_qa_fixture_reset",
  "staging_provider_catalog_import",
]);

const STATUS_PRIORITY = Object.freeze([
  "awaiting_data",
  "still_illegal",
  "completed",
  "not_applicable",
]);

const AWAITING_DATA_CODES = new Set([
  "MATCHUP_LOCK_SOURCE_STALE",
  "MATCHUP_LATE_LOCK_GAME_OBSERVATION_STALE",
  "MATCHUP_LEGALITY_STATISTICS_MISSING",
  "MATCHUP_LEGALITY_PLAYER_GAME_STATISTICS_MISSING",
  "MATCHUP_LEGALITY_GAME_STATE_PROVIDER_MISSING",
  "MATCHUP_LEGALITY_GAME_STATE_UNAVAILABLE",
  "MATCHUP_LEGALITY_GAME_STATE_INCOMPLETE",
  "MATCHUP_LEGALITY_GAME_STATE_PROVIDER_MISMATCH",
  "MATCHUP_LEGALITY_CLOCK_REGRESSED",
]);

const NOT_APPLICABLE_CODES = new Set([
  "MATCHUP_LEGALITY_CONTEXT_MISSING",
  "MATCHUP_LEGALITY_WEEK_NOT_LIVE",
  "MATCHUP_LEGALITY_TOO_EARLY",
  "MATCHUP_LEGALITY_WEEK_ENDED",
  "MATCHUP_LEGALITY_NORMAL_LOCK_MISSING",
]);

const STILL_ILLEGAL_CODE = "MATCHUP_LEGALITY_STILL_ILLEGAL";
const KNOWN_REASON_CODES = new Set([
  ...AWAITING_DATA_CODES,
  ...NOT_APPLICABLE_CODES,
  STILL_ILLEGAL_CODE,
]);

const OCCURRENCE_EXECUTION_FIELDS = Object.freeze([
  "bindingId",
  "claimedJobVersion",
  "jobType",
  "leagueId",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "occurrenceKey",
  "runId",
  "scheduleOperationId",
  "scheduleVersion",
  "scheduledForMs",
  "seasonId",
  "weekId",
]);

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`late-lock coordination requires ${description}`);
  }
}

function exactObject(value, keys, description) {
  const prototype =
    value !== null && typeof value === "object"
      ? Object.getPrototypeOf(value)
      : null;
  const expected = new Set(keys);
  const actual =
    value !== null && typeof value === "object"
      ? Reflect.ownKeys(value)
      : [];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some(
      (key) => typeof key !== "string" || !expected.has(key)
    )
  ) {
    throw new TypeError(`late-lock coordination requires ${description}`);
  }
  return value;
}

function stableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(
      `late-lock coordination requires a stable ${description} identifier`
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `late-lock coordination requires a safe ${description}`
    );
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "late-lock coordination requires a positive ownership version"
    );
  }
  return value;
}

function boundedText(value, maximum, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new TypeError(
      `late-lock coordination requires a canonical ${description}`
    );
  }
  return value;
}

function safeProjection(status, lockId) {
  if (!LATE_LOCK_COORDINATOR_STATUSES.includes(status)) {
    throw new TypeError("late-lock coordination produced an invalid status");
  }
  return Object.freeze({
    status,
    ...(lockId === undefined
      ? {}
      : { lockId: stableId(lockId, "late lock") }),
  });
}

function zeroRetryCounts() {
  return Object.freeze({
    attempted: 0,
    completed: 0,
    awaitingData: 0,
    stillIllegal: 0,
    notApplicable: 0,
  });
}

function reasonCode(error) {
  const visited = new Set();
  let current = error;
  let fallback = null;
  while (
    current &&
    (typeof current === "object" || typeof current === "function") &&
    !visited.has(current)
  ) {
    visited.add(current);
    const candidates = [
      current.reasonCode,
      current.details?.reasonCode,
      current.code,
    ].filter((value) => typeof value === "string");
    for (const candidate of candidates) {
      if (KNOWN_REASON_CODES.has(candidate)) return candidate;
      if (fallback === null) fallback = candidate;
    }
    current = current.cause;
  }
  return fallback;
}

function normalizeWitness(value) {
  const witness = exactObject(
    value,
    ["ownershipId", "ownershipVersion", "state"],
    "an exact ownership witness"
  );
  if (!["present", "deleted"].includes(witness.state)) {
    throw new TypeError(
      "late-lock coordination requires a canonical ownership witness state"
    );
  }
  return Object.freeze({
    ownershipId: stableId(witness.ownershipId, "ownership"),
    ownershipVersion: positiveVersion(witness.ownershipVersion),
    state: witness.state,
  });
}

function normalizeTeam(value, globalOwnershipIds) {
  const team = exactObject(
    value,
    ["leagueId", "seasonId", "teamId", "ownershipWitnesses"],
    "an exact committed team mutation"
  );
  if (!Array.isArray(team.ownershipWitnesses)) {
    throw new TypeError(
      "late-lock coordination requires a committed ownership-witness array"
    );
  }
  const ownershipWitnesses = team.ownershipWitnesses.map(normalizeWitness);
  let previousOwnershipId = null;
  for (const witness of ownershipWitnesses) {
    if (
      previousOwnershipId !== null &&
      witness.ownershipId <= previousOwnershipId
    ) {
      throw new TypeError(
        "late-lock coordination ownership witnesses must be unique and stable-ID ordered"
      );
    }
    if (globalOwnershipIds.has(witness.ownershipId)) {
      throw new TypeError(
        "late-lock coordination ownership witnesses must be globally unique"
      );
    }
    globalOwnershipIds.add(witness.ownershipId);
    previousOwnershipId = witness.ownershipId;
  }
  return Object.freeze({
    leagueId: stableId(team.leagueId, "league"),
    seasonId: stableId(team.seasonId, "season"),
    teamId: stableId(team.teamId, "team"),
    ownershipWitnesses: Object.freeze(ownershipWitnesses),
  });
}

function normalizeCommittedMutationBatch(value) {
  const batch = exactObject(
    value,
    ["mutationKind", "teams"],
    "an exact committed roster-mutation batch"
  );
  if (!Array.isArray(batch.teams) || batch.teams.length < 1) {
    throw new TypeError(
      "late-lock coordination requires committed team mutations"
    );
  }
  const globalOwnershipIds = new Set();
  const teams = batch.teams.map((team) =>
    normalizeTeam(team, globalOwnershipIds)
  );
  const teamScopes = new Set();
  let previousScope = null;
  for (const team of teams) {
    const scope = `${team.leagueId}\u0000${team.seasonId}\u0000${team.teamId}`;
    if (teamScopes.has(scope)) {
      throw new TypeError(
        "late-lock coordination committed team scopes must be unique"
      );
    }
    if (previousScope !== null && scope <= previousScope) {
      throw new TypeError(
        "late-lock coordination committed team scopes must be stable-ID ordered"
      );
    }
    teamScopes.add(scope);
    previousScope = scope;
  }
  const mutationKind = boundedText(
    batch.mutationKind,
    80,
    "roster-mutation kind"
  );
  if (!LATE_LOCK_MUTATION_WRITER_REGISTRY.includes(mutationKind)) {
    throw new TypeError(
      "late-lock coordination requires a registered roster-mutation kind"
    );
  }
  return Object.freeze({
    mutationKind,
    teams: Object.freeze(teams),
  });
}

function normalizeTarget(value) {
  const target = exactObject(
    value,
    ["leagueId", "seasonId", "weekId", "teamId", "lockId"],
    "an exact late-lock target"
  );
  return Object.freeze({
    leagueId: stableId(target.leagueId, "league"),
    seasonId: stableId(target.seasonId, "season"),
    weekId: stableId(target.weekId, "matchup week"),
    teamId: stableId(target.teamId, "team"),
    lockId: stableId(target.lockId, "normal lock"),
  });
}

function normalizeTargets(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("late-lock coordination requires target rows");
  }
  const targets = value.map(normalizeTarget);
  const identities = new Set();
  for (const target of targets) {
    const identity = `${target.leagueId}\u0000${target.seasonId}\u0000${target.weekId}\u0000${target.teamId}`;
    if (identities.has(identity)) {
      throw new TypeError("late-lock coordination targets are ambiguous");
    }
    identities.add(identity);
  }
  targets.sort(
    (left, right) =>
      left.leagueId.localeCompare(right.leagueId) ||
      left.seasonId.localeCompare(right.seasonId) ||
      left.weekId.localeCompare(right.weekId) ||
      left.teamId.localeCompare(right.teamId)
  );
  return Object.freeze(targets);
}

function normalizeOccurrenceExecution(value) {
  const occurrenceExecution = exactObject(
    value,
    OCCURRENCE_EXECUTION_FIELDS,
    "an exact occurrence execution scope"
  );
  if (
    !Object.isFrozen(occurrenceExecution) ||
    occurrenceExecution.jobType !== "matchup:statistics_refresh"
  ) {
    throw new TypeError(
      "late-lock coordination requires the frozen statistics-refresh occurrence"
    );
  }
  return Object.freeze({
    leagueId: stableId(occurrenceExecution.leagueId, "occurrence league"),
    seasonId: stableId(occurrenceExecution.seasonId, "occurrence season"),
    weekId: stableId(occurrenceExecution.weekId, "occurrence matchup week"),
  });
}

function teamKey(team) {
  return `${team.leagueId}\u0000${team.seasonId}\u0000${team.teamId}`;
}

function targetMatchesTeam(target, team) {
  return (
    target.leagueId === team.leagueId &&
    target.seasonId === team.seasonId &&
    target.teamId === team.teamId
  );
}

function targetMatchesOccurrence(target, scope) {
  return (
    target.leagueId === scope.leagueId &&
    target.seasonId === scope.seasonId &&
    target.weekId === scope.weekId
  );
}

function aggregateOutcomes(outcomes) {
  const status =
    STATUS_PRIORITY.find((candidate) =>
      outcomes.some((outcome) => outcome.projection.status === candidate)
    ) || "awaiting_data";
  const completed = outcomes.filter(
    (outcome) => outcome.projection.status === "completed"
  );
  const hasUnresolved = outcomes.some(
    (outcome) => outcome.projection.status === "awaiting_data"
  );
  const lockId =
    completed.length === 1 && !hasUnresolved
      ? completed[0].projection.lockId
      : undefined;
  return safeProjection(status, lockId);
}

function createLateLockCoordinator({
  targetRepository,
  legalityService,
  statisticsService,
  provider,
  clock,
  logger = null,
} = {}) {
  requireMethod(
    targetRepository,
    "listEligibleLateLocks",
    "an eligible-target repository"
  );
  requireMethod(legalityService, "lockLate", "a late-lock service");
  requireMethod(
    statisticsService,
    "refresh",
    "a live-statistics service"
  );
  requireMethod(clock, "nowMs", "a clock");
  const providerName = boundedText(
    provider,
    80,
    "statistics provider"
  );
  if (
    logger !== null &&
    (!logger || typeof logger.error !== "function")
  ) {
    throw new TypeError(
      "late-lock coordination requires a valid optional logger"
    );
  }

  function now() {
    return safeTimestamp(clock.nowMs(), "clock instant");
  }

  function report(phase) {
    if (!logger) return;
    try {
      logger.error("Late-lock coordination was delayed.", { phase });
    } catch {
      // A post-commit diagnostic must never reject its committed command.
    }
  }

  function classify(error) {
    const code = reasonCode(error);
    if (code === STILL_ILLEGAL_CODE) return "still_illegal";
    if (NOT_APPLICABLE_CODES.has(code)) return "not_applicable";
    return "awaiting_data";
  }

  async function attempt(target, occurrenceExecution) {
    try {
      const result = await legalityService.lockLate({
        ...target,
        provider: providerName,
        nowMs: now(),
        ...(occurrenceExecution === undefined
          ? {}
          : { occurrenceExecution }),
      });
      if (result?.lock?.id !== target.lockId) {
        throw Object.assign(
          new Error("Late-lock persistence returned a different lock."),
          { code: "LATE_LOCK_RESULT_INVALID" }
        );
      }
      return Object.freeze({
        projection: safeProjection("completed", target.lockId),
        refreshable: false,
      });
    } catch (error) {
      const code = reasonCode(error);
      const status = classify(error);
      const refreshable =
        status === "awaiting_data" && AWAITING_DATA_CODES.has(code);
      if (status === "awaiting_data" && !refreshable) {
        report("late_lock");
      }
      return Object.freeze({
        projection: safeProjection(status),
        refreshable,
      });
    }
  }

  function awaitingOutcome(team) {
    return Object.freeze({
      teamKey: teamKey(team),
      projection: safeProjection("awaiting_data"),
      refreshable: false,
    });
  }

  async function evaluateTeam(team, observedAtMs) {
    let targets;
    try {
      targets = normalizeTargets(
        targetRepository.listEligibleLateLocks({
          mode: "committed_team",
          team,
          nowMs: observedAtMs,
        })
      );
      if (targets.some((target) => !targetMatchesTeam(target, team))) {
        throw new TypeError(
          "late-lock coordination received a cross-team target"
        );
      }
    } catch {
      report("committed_team_target_read");
      return awaitingOutcome(team);
    }
    if (targets.length === 0) {
      return Object.freeze({
        teamKey: teamKey(team),
        projection: safeProjection("not_applicable"),
        refreshable: false,
      });
    }
    if (targets.length !== 1) {
      report("committed_team_target_read");
      return awaitingOutcome(team);
    }
    const result = await attempt(targets[0]);
    return Object.freeze({ teamKey: teamKey(team), ...result });
  }

  async function coordinateCommittedBatch(input) {
    const batch = normalizeCommittedMutationBatch(input);
    const initialObservedAtMs = now();
    const outcomes = [];
    for (const team of batch.teams) {
      outcomes.push(await evaluateTeam(team, initialObservedAtMs));
    }
    const refreshableKeys = new Set(
      outcomes
        .filter((outcome) => outcome.refreshable)
        .map((outcome) => outcome.teamKey)
    );
    if (refreshableKeys.size === 0) return aggregateOutcomes(outcomes);

    try {
      await statisticsService.refresh({});
    } catch {
      report("live_refresh");
      return aggregateOutcomes(outcomes);
    }

    let retryObservedAtMs;
    try {
      retryObservedAtMs = now();
    } catch {
      report("retry_clock");
      return aggregateOutcomes(outcomes);
    }
    const retryByTeam = new Map();
    for (const team of batch.teams) {
      if (!refreshableKeys.has(teamKey(team))) continue;
      retryByTeam.set(
        teamKey(team),
        await evaluateTeam(team, retryObservedAtMs)
      );
    }
    const finalOutcomes = outcomes.map(
      (outcome) => retryByTeam.get(outcome.teamKey) || outcome
    );
    return aggregateOutcomes(finalOutcomes);
  }

  async function coordinateCommittedRoster(input) {
    try {
      return await coordinateCommittedBatch(input);
    } catch {
      report("committed_batch");
      return safeProjection("awaiting_data");
    }
  }

  async function retryEligibleLateLocks(input = {}) {
    try {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !["occurrenceExecution", "nowMs"].includes(key)
        ) ||
        !Object.hasOwn(input, "occurrenceExecution")
      ) {
        throw new TypeError(
          "late-lock coordination requires an exact scheduled retry"
        );
      }
      const occurrenceExecution = input.occurrenceExecution;
      const scope = normalizeOccurrenceExecution(occurrenceExecution);
      const observedAtMs =
        input.nowMs === undefined
          ? now()
          : safeTimestamp(input.nowMs, "retry instant");
      const targets = normalizeTargets(
        targetRepository.listEligibleLateLocks({
          mode: "scheduled_occurrence",
          leagueId: scope.leagueId,
          seasonId: scope.seasonId,
          weekId: scope.weekId,
          nowMs: observedAtMs,
        })
      );
      if (
        targets.some(
          (target) => !targetMatchesOccurrence(target, scope)
        )
      ) {
        throw new TypeError(
          "late-lock coordination received a cross-occurrence target"
        );
      }
      const counts = {
        attempted: targets.length,
        completed: 0,
        awaitingData: 0,
        stillIllegal: 0,
        notApplicable: 0,
      };
      for (const target of targets) {
        const result = (await attempt(target, occurrenceExecution)).projection;
        if (result.status === "completed") counts.completed += 1;
        if (result.status === "awaiting_data") counts.awaitingData += 1;
        if (result.status === "still_illegal") counts.stillIllegal += 1;
        if (result.status === "not_applicable") counts.notApplicable += 1;
      }
      return Object.freeze(counts);
    } catch {
      report("scheduled_retry");
      return zeroRetryCounts();
    }
  }

  return Object.freeze({
    coordinateCommittedRoster,
    retryEligibleLateLocks,
  });
}

module.exports = {
  LATE_LOCK_COORDINATOR_STATUSES,
  LATE_LOCK_MAINTENANCE_EXCLUSIONS,
  LATE_LOCK_MUTATION_WRITER_REGISTRY,
  createLateLockCoordinator,
};
