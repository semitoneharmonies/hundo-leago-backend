const crypto = require("node:crypto");

const {
  M6_JOB_TYPES,
} = require("../../../domain/matchups/matchupJobPolicy");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

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
    async "matchup:statistics_refresh"() {
      return statisticsService.refresh();
    },
    async "matchup:baseline"(input) {
      const outcome = transition(input, "baseline_transition");
      return Object.freeze({ status: outcome.week?.status || "baseline_ready" });
    },
    async "matchup:lock"(input) {
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
        })
      );
      return Object.freeze({ lockedTeams: locks.length });
    },
    async "matchup:finalize"(input) {
      transition(input, "finalize_transition");
      const outcomes = finalizeOutstanding(input, "finalize");
      return Object.freeze({ finalizedMatchups: outcomes.length });
    },
    async "matchup:rollover"(input) {
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
