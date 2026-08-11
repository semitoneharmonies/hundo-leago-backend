const { randomUUID } = require("node:crypto");

const {
  deriveNextWeekTransition,
  isManagerRosterWriteOpen,
  validateWeekBoundaries,
} = require("../../../domain/matchups/matchupWeekPolicy");

const MATCHUP_WEEK_SERVICE_CODES = Object.freeze({
  weekMissing: "MATCHUP_WEEK_MISSING",
});

class MatchupWeekServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupWeekServiceError";
    this.code = code;
  }
}

function createMatchupWeekService({ repository, createId = randomUUID } = {}) {
  if (
    !repository ||
    typeof repository.readWeek !== "function" ||
    typeof repository.readTransitionOperation !== "function" ||
    typeof repository.transitionWeek !== "function"
  ) {
    throw new TypeError("createMatchupWeekService requires a matchup-week repository");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createMatchupWeekService requires an ID factory");
  }

  function requireWeek(input) {
    const week = repository.readWeek(input);
    if (!week) {
      throw new MatchupWeekServiceError(
        MATCHUP_WEEK_SERVICE_CODES.weekMissing,
        "The matchup week was not found."
      );
    }
    return week;
  }

  function rosterWriteState(input) {
    const week = requireWeek(input);
    validateWeekBoundaries({
      startsAtMs: week.starts_at_ms,
      baselineAtMs: week.baseline_at_ms,
      locksAtMs: week.locks_at_ms,
      endsAtMs: week.ends_at_ms,
      rollsOverAtMs: week.rolls_over_at_ms,
    });
    return Object.freeze({
      weekId: week.id,
      locksAtMs: week.locks_at_ms,
      open: isManagerRosterWriteOpen({ nowMs: input.nowMs, locksAtMs: week.locks_at_ms }),
    });
  }

  function advance(input) {
    const week = requireWeek(input);
    const occurrenceExecution = input.occurrenceExecution;
    if (input.operationId) {
      const prior = repository.readTransitionOperation({
        leagueId: week.league_id,
        seasonId: week.season_id,
        weekId: week.id,
        operationId: input.operationId,
      });
      if (prior) {
        if (occurrenceExecution !== undefined) {
          return repository.transitionWeek({
            leagueId: week.league_id,
            seasonId: week.season_id,
            weekId: week.id,
            operationId: input.operationId,
            occurrenceExecution,
          });
        }
        return Object.freeze({
          replayed: true,
          operationId: prior.id,
          week,
        });
      }
    }
    const transition = deriveNextWeekTransition({
      status: week.status,
      nowMs: input.nowMs,
      startsAtMs: week.starts_at_ms,
      baselineAtMs: week.baseline_at_ms,
      locksAtMs: week.locks_at_ms,
      endsAtMs: week.ends_at_ms,
      rollsOverAtMs: week.rolls_over_at_ms,
    });
    return repository.transitionWeek({
      leagueId: week.league_id,
      seasonId: week.season_id,
      weekId: week.id,
      operationId: input.operationId || createId(),
      expectedVersion: week.version,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      matchupStatus: transition.matchupStatus,
      effectiveAtMs: transition.effectiveAtMs,
      nowMs: input.nowMs,
      ...(occurrenceExecution === undefined
        ? {}
        : { occurrenceExecution }),
    });
  }

  return Object.freeze({ advance, rosterWriteState });
}

module.exports = {
  MATCHUP_WEEK_SERVICE_CODES,
  MatchupWeekServiceError,
  createMatchupWeekService,
};
