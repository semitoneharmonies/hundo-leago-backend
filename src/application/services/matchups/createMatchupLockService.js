const { randomUUID } = require("node:crypto");

const {
  assertFreshBaselineSource,
  buildLockedPlayerBaselines,
} = require("../../../domain/matchups/matchupLockPolicy");

const MATCHUP_LOCK_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_LOCK_CONTEXT_MISSING",
  weekNotLive: "MATCHUP_LOCK_WEEK_NOT_LIVE",
  tooEarly: "MATCHUP_LOCK_TOO_EARLY",
  weekEnded: "MATCHUP_LOCK_WEEK_ENDED",
  statisticsMissing: "MATCHUP_LOCK_STATISTICS_MISSING",
  alreadyLocked: "MATCHUP_LOCK_ALREADY_EXISTS",
  providerInvalid: "MATCHUP_LOCK_PROVIDER_INVALID",
});

class MatchupLockServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupLockServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupLockServiceError(code, message);
}

function createMatchupLockService({ repository, createId = randomUUID } = {}) {
  if (
    !repository ||
    typeof repository.readContext !== "function" ||
    typeof repository.persistNormalLock !== "function"
  ) {
    throw new TypeError("createMatchupLockService requires a matchup-lock repository");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createMatchupLockService requires an ID factory");
  }

  function lock(input) {
    if (
      typeof input?.provider !== "string" ||
      input.provider.length < 1 ||
      input.provider.length > 80 ||
      input.provider.trim() !== input.provider
    ) {
      fail(MATCHUP_LOCK_SERVICE_CODES.providerInvalid, "A canonical statistics provider is required.");
    }
    const context = repository.readContext(input);
    if (!context) fail(MATCHUP_LOCK_SERVICE_CODES.contextMissing, "The matchup team was not found.");
    const lockId = input.lockId || createId();
    if (context.existingLocks.length > 0) {
      if (context.existingLocks.length === 1 && context.existingLocks[0].id === lockId) {
        return repository.persistNormalLock({
          ...input,
          lockId,
          expectedWeekVersion: context.week.version,
          refreshId: context.refresh?.id || null,
          activePlayerFingerprint: JSON.stringify(context.activePlayers),
          players: Object.freeze([]),
        });
      }
      fail(MATCHUP_LOCK_SERVICE_CODES.alreadyLocked, "The team already has a matchup lock.");
    }
    if (context.week.status !== "live") {
      fail(MATCHUP_LOCK_SERVICE_CODES.weekNotLive, "The matchup week is not live.");
    }
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < context.week.locks_at_ms) {
      fail(MATCHUP_LOCK_SERVICE_CODES.tooEarly, "The matchup lock boundary has not arrived.");
    }
    if (input.nowMs >= context.week.ends_at_ms) {
      fail(MATCHUP_LOCK_SERVICE_CODES.weekEnded, "The matchup week has ended.");
    }
    if (!context.refresh) {
      fail(MATCHUP_LOCK_SERVICE_CODES.statisticsMissing, "No successful baseline statistics are available.");
    }
    assertFreshBaselineSource({
      baselineAtMs: context.week.baseline_at_ms,
      refreshCompletedAtMs: context.refresh.completed_at_ms,
    });
    const baselines = buildLockedPlayerBaselines({
      activePlayers: context.activePlayers,
      totals: context.totals,
    });
    const players = baselines.map((player) => Object.freeze({
      ...player,
      snapshotPlayerId: createId(),
      lockPlayerId: createId(),
    }));
    return repository.persistNormalLock({
      leagueId: context.week.league_id,
      seasonId: context.week.season_id,
      weekId: context.week.id,
      teamId: input.teamId,
      provider: input.provider,
      lockId,
      snapshotId: createId(),
      statSourceId: context.refresh.stat_source_id,
      refreshId: context.refresh.id,
      expectedWeekVersion: context.week.version,
      activePlayerFingerprint: JSON.stringify(context.activePlayers),
      baselineAtMs: context.week.baseline_at_ms,
      locksAtMs: context.week.locks_at_ms,
      nowMs: input.nowMs,
      players: Object.freeze(players),
      ...(input.occurrenceExecution === undefined
        ? {}
        : { occurrenceExecution: input.occurrenceExecution }),
    });
  }

  return Object.freeze({ lock });
}

module.exports = {
  MATCHUP_LOCK_SERVICE_CODES,
  MatchupLockServiceError,
  createMatchupLockService,
};
