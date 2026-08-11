const crypto = require("node:crypto");

const {
  M6_JOB_TYPES,
  parseMatchupOccurrenceKey,
} = require("../../../domain/matchups/matchupJobPolicy");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
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

function invalidExecution(message) {
  const error = new TypeError(message);
  error.code = "MATCHUP_OCCURRENCE_EXECUTION_INVALID";
  throw error;
}

function requireStableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidExecution(`A stable ${description} identifier is required.`);
  }
}

function requireBoundedText(value, maximum, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalidExecution(`A canonical ${description} is required.`);
  }
}

function requireOccurrenceExecution(
  occurrenceExecution,
  expectedJobType,
  observedAtMs
) {
  if (
    occurrenceExecution === null ||
    typeof occurrenceExecution !== "object" ||
    Array.isArray(occurrenceExecution) ||
    !Object.isFrozen(occurrenceExecution) ||
    Object.keys(occurrenceExecution).sort().join("|") !==
      OCCURRENCE_EXECUTION_FIELDS.join("|")
  ) {
    invalidExecution(
      "An exact frozen matchup occurrence execution context is required."
    );
  }
  if (
    !M6_JOB_TYPES.includes(occurrenceExecution.jobType) ||
    occurrenceExecution.jobType !== expectedJobType
  ) {
    invalidExecution(
      "The matchup occurrence execution job identity is invalid."
    );
  }
  for (const [value, description] of [
    [occurrenceExecution.bindingId, "binding"],
    [occurrenceExecution.leagueId, "league"],
    [occurrenceExecution.runId, "job run"],
    [occurrenceExecution.scheduleOperationId, "schedule operation"],
    [occurrenceExecution.seasonId, "season"],
    [occurrenceExecution.weekId, "matchup week"],
  ]) {
    requireStableId(value, description);
  }
  for (const [value, description] of [
    [occurrenceExecution.leaseOwner, "lease owner"],
    [occurrenceExecution.leaseToken, "lease token"],
    [occurrenceExecution.occurrenceKey, "occurrence key"],
  ]) {
    requireBoundedText(
      value,
      description === "lease owner" ? 128 : description === "lease token" ? 200 : 512,
      description
    );
  }
  if (
    !Number.isSafeInteger(occurrenceExecution.claimedJobVersion) ||
    occurrenceExecution.claimedJobVersion < 1 ||
    !Number.isSafeInteger(occurrenceExecution.scheduleVersion) ||
    occurrenceExecution.scheduleVersion < 1
  ) {
    invalidExecution(
      "Positive safe matchup occurrence execution versions are required."
    );
  }
  if (
    !Number.isSafeInteger(occurrenceExecution.leaseExpiresAtMs) ||
    occurrenceExecution.leaseExpiresAtMs < 0 ||
    !Number.isSafeInteger(occurrenceExecution.scheduledForMs) ||
    occurrenceExecution.scheduledForMs < 0 ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < 0
  ) {
    invalidExecution(
      "Safe matchup occurrence execution instants are required."
    );
  }

  let parsed;
  try {
    parsed = parseMatchupOccurrenceKey({
      jobType: occurrenceExecution.jobType,
      leagueId: occurrenceExecution.leagueId,
      seasonId: occurrenceExecution.seasonId,
      occurrenceKey: occurrenceExecution.occurrenceKey,
      scheduledForMs: occurrenceExecution.scheduledForMs,
    });
  } catch (error) {
    invalidExecution(
      "The matchup occurrence execution key is not canonical."
    );
  }
  if (
    parsed.weekId !== occurrenceExecution.weekId ||
    (
      parsed.scheduleOperationId !== null &&
      (
        parsed.scheduleOperationId !==
          occurrenceExecution.scheduleOperationId ||
        parsed.scheduleVersion !== occurrenceExecution.scheduleVersion
      )
    )
  ) {
    invalidExecution(
      "The matchup occurrence execution scope does not match its key."
    );
  }
  return Object.freeze({
    ...parsed,
    occurrenceExecution,
    runId: occurrenceExecution.runId,
    scheduleOperationId: occurrenceExecution.scheduleOperationId,
    scheduleVersion: occurrenceExecution.scheduleVersion,
    observedAtMs,
  });
}

function deterministicEffectId(runId, effect) {
  if (
    typeof runId !== "string" ||
    !UUID_PATTERN.test(runId) ||
    typeof effect !== "string" ||
    effect.length < 1 ||
    effect.length > 256 ||
    effect.trim() !== effect
  ) {
    throw new TypeError("matchup occurrence effect identity is invalid");
  }
  const hex = crypto
    .createHash("sha256")
    .update(`${runId}:${effect}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function createMatchupOccurrenceHandlers({
  statisticsService,
  lateLockCoordinator,
  readRepository,
  weekService,
  legalityService,
  resultService,
  provider = "nhl",
} = {}) {
  if (!statisticsService || typeof statisticsService.refresh !== "function") {
    throw new TypeError("matchup occurrence handlers require target statistics");
  }
  if (
    !lateLockCoordinator ||
    typeof lateLockCoordinator.retryEligibleLateLocks !== "function"
  ) {
    throw new TypeError(
      "matchup occurrence handlers require late-lock retry coordination"
    );
  }
  if (
    !readRepository ||
    typeof readRepository.readWeek !== "function" ||
    typeof readRepository.readMatchup !== "function"
  ) {
    throw new TypeError("matchup occurrence handlers require matchup reads");
  }
  if (!weekService || typeof weekService.advance !== "function") {
    throw new TypeError("matchup occurrence handlers require week transitions");
  }
  if (!legalityService || typeof legalityService.lockAtBoundary !== "function") {
    throw new TypeError("matchup occurrence handlers require lineup locking");
  }
  if (!resultService || typeof resultService.finalize !== "function") {
    throw new TypeError("matchup occurrence handlers require result finalization");
  }
  if (
    typeof provider !== "string" ||
    provider.length < 1 ||
    provider.length > 80 ||
    provider.trim() !== provider
  ) {
    throw new TypeError("matchup occurrence handlers require a provider name");
  }

  function transition(input, effect) {
    return weekService.advance({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      weekId: input.weekId,
      operationId: deterministicEffectId(input.runId, effect),
      nowMs: input.observedAtMs,
      occurrenceExecution: input.occurrenceExecution,
    });
  }

  function requireWeek(input) {
    const context = readRepository.readWeek(input);
    if (!context) {
      const error = new Error("The scheduled matchup week was not found.");
      error.code = "MATCHUP_OCCURRENCE_WEEK_MISSING";
      throw error;
    }
    return context;
  }

  function finalizeOutstanding(input, effectPrefix) {
    const context = requireWeek(input);
    const outcomes = [];
    for (const matchup of context.matchups) {
      if (matchup.status === "final") continue;
      const result = resultService.finalize({
        leagueId: input.leagueId,
        seasonId: input.seasonId,
        weekId: input.weekId,
        matchupId: matchup.id,
        operationId: deterministicEffectId(
          input.runId,
          `${effectPrefix}:${matchup.id}`
        ),
        nowMs: input.observedAtMs,
        occurrenceExecution: input.occurrenceExecution,
      });
      outcomes.push(result);
      if (result.finalized === false) {
        const error = new Error("Final statistics are not ready.");
        error.code = "MATCHUP_FINAL_SOURCE_WAITING";
        throw error;
      }
    }
    return Object.freeze(outcomes);
  }

  const handlers = {
    async "matchup:statistics_refresh"(
      occurrenceExecution,
      observedAtMs
    ) {
      const input = requireOccurrenceExecution(
        occurrenceExecution,
        "matchup:statistics_refresh",
        observedAtMs
      );
      const refreshResult = await statisticsService.refresh({
        occurrenceExecution: input.occurrenceExecution,
      });
      try {
        await lateLockCoordinator.retryEligibleLateLocks({
          occurrenceExecution: input.occurrenceExecution,
        });
      } catch {
        // A post-refresh late-lock retry cannot fail the committed refresh.
      }
      return refreshResult;
    },
    async "matchup:baseline"(occurrenceExecution, observedAtMs) {
      const input = requireOccurrenceExecution(
        occurrenceExecution,
        "matchup:baseline",
        observedAtMs
      );
      const outcome = transition(input, "baseline_transition");
      return Object.freeze({ status: outcome.week?.status || "baseline_ready" });
    },
    async "matchup:lock"(occurrenceExecution, observedAtMs) {
      const input = requireOccurrenceExecution(
        occurrenceExecution,
        "matchup:lock",
        observedAtMs
      );
      transition(input, "lock_transition");
      const context = requireWeek(input);
      const teamIds = [
        ...new Set(
          context.matchups.flatMap(({ home_team_id, away_team_id }) => [
            home_team_id,
            away_team_id,
          ])
        ),
      ].sort();
      const locks = teamIds.map((teamId) =>
        legalityService.lockAtBoundary({
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          weekId: input.weekId,
          teamId,
          provider,
          lockId: deterministicEffectId(input.runId, `lock:${teamId}`),
          nowMs: input.observedAtMs,
          occurrenceExecution: input.occurrenceExecution,
        })
      );
      return Object.freeze({ lockedTeams: locks.length });
    },
    async "matchup:finalize"(occurrenceExecution, observedAtMs) {
      const input = requireOccurrenceExecution(
        occurrenceExecution,
        "matchup:finalize",
        observedAtMs
      );
      transition(input, "finalize_transition");
      const outcomes = finalizeOutstanding(input, "finalize");
      return Object.freeze({ finalizedMatchups: outcomes.length });
    },
    async "matchup:rollover"(occurrenceExecution, observedAtMs) {
      const input = requireOccurrenceExecution(
        occurrenceExecution,
        "matchup:rollover",
        observedAtMs
      );
      let context = requireWeek(input);
      if (context.week.status !== "final") {
        finalizeOutstanding(input, "rollover_finalize");
        context = requireWeek(input);
      }
      if (context.week.status !== "final") {
        const error = new Error("The matchup week is not final at rollover.");
        error.code = "MATCHUP_ROLLOVER_NOT_FINAL";
        throw error;
      }
      return Object.freeze({ status: "final" });
    },
  };
  if (
    !M6_JOB_TYPES.every((jobType) => typeof handlers[jobType] === "function") ||
    Object.keys(handlers).some((jobType) => !M6_JOB_TYPES.includes(jobType))
  ) {
    throw new TypeError("matchup occurrence handlers are incomplete");
  }
  return Object.freeze(handlers);
}

module.exports = {
  createMatchupOccurrenceHandlers,
  deterministicEffectId,
};
