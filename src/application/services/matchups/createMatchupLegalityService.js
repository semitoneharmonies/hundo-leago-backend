const { randomUUID } = require("node:crypto");

const {
  evaluateMatchupLineupLegality,
} = require("../../../domain/matchups/matchupLegalityPolicy");
const {
  assertFreshBaselineSource,
  buildLockedPlayerBaselines,
} = require("../../../domain/matchups/matchupLockPolicy");

const MATCHUP_LEGALITY_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_LEGALITY_CONTEXT_MISSING",
  lockIdRequired: "MATCHUP_LEGALITY_LOCK_ID_REQUIRED",
  weekNotLive: "MATCHUP_LEGALITY_WEEK_NOT_LIVE",
  tooEarly: "MATCHUP_LEGALITY_TOO_EARLY",
  weekEnded: "MATCHUP_LEGALITY_WEEK_ENDED",
  normalLockMissing: "MATCHUP_LEGALITY_NORMAL_LOCK_MISSING",
  stillIllegal: "MATCHUP_LEGALITY_STILL_ILLEGAL",
  statisticsMissing: "MATCHUP_LEGALITY_STATISTICS_MISSING",
  lockConflict: "MATCHUP_LEGALITY_LOCK_CONFLICT",
});

class MatchupLegalityServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupLegalityServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupLegalityServiceError(code, message);
}

function createMatchupLegalityService({ repository, normalLockService, createId = randomUUID } = {}) {
  if (
    !repository ||
    typeof repository.readContext !== "function" ||
    typeof repository.persistIllegalLock !== "function" ||
    typeof repository.persistLateLock !== "function"
  ) {
    throw new TypeError("createMatchupLegalityService requires a matchup-lock repository");
  }
  if (!normalLockService || typeof normalLockService.lock !== "function") {
    throw new TypeError("createMatchupLegalityService requires the normal lock service");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createMatchupLegalityService requires an ID factory");
  }

  function requireContext(input) {
    const context = repository.readContext(input);
    if (!context) fail(MATCHUP_LEGALITY_SERVICE_CODES.contextMissing, "The matchup team was not found.");
    return context;
  }

  function validateWindow(context, nowMs, { late }) {
    if (context.week.status !== "live") {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.weekNotLive, "The matchup week is not live.");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < context.week.locks_at_ms || (late && nowMs === context.week.locks_at_ms)) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.tooEarly, "The requested lock boundary has not arrived.");
    }
    if (nowMs >= context.week.ends_at_ms) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.weekEnded, "The matchup week has ended.");
    }
  }

  function lockAtBoundary(input) {
    if (!input?.lockId) fail(MATCHUP_LEGALITY_SERVICE_CODES.lockIdRequired, "A stable lock ID is required.");
    const context = requireContext(input);
    validateWindow(context, input.nowMs, { late: false });
    if (context.existingLocks.length > 0) {
      const existing = context.existingLocks[0];
      if (context.existingLocks.length !== 1 || existing.id !== input.lockId) {
        fail(MATCHUP_LEGALITY_SERVICE_CODES.lockConflict, "The team already has different lock evidence.");
      }
      if (existing.legal === 0) {
        return repository.persistIllegalLock({
          ...input,
          expectedWeekVersion: context.week.version,
          activePlayerFingerprint: JSON.stringify(context.activePlayers),
          locksAtMs: context.week.locks_at_ms,
          reasonCode: existing.legality_reason_code,
        });
      }
      return normalLockService.lock(input);
    }
    const decision = evaluateMatchupLineupLegality(context.activePlayers);
    if (decision.legal) return normalLockService.lock(input);
    return repository.persistIllegalLock({
      leagueId: context.week.league_id,
      seasonId: context.week.season_id,
      weekId: context.week.id,
      teamId: input.teamId,
      provider: input.provider,
      lockId: input.lockId,
      expectedWeekVersion: context.week.version,
      activePlayerFingerprint: JSON.stringify(context.activePlayers),
      locksAtMs: context.week.locks_at_ms,
      reasonCode: decision.primaryReasonCode,
      nowMs: input.nowMs,
    });
  }

  function lockLate(input) {
    if (!input?.lockId) fail(MATCHUP_LEGALITY_SERVICE_CODES.lockIdRequired, "A stable lock ID is required.");
    const context = requireContext({ ...input, baselineCutoffAtMs: input.nowMs });
    validateWindow(context, input.nowMs, { late: true });
    if (context.existingLocks.length !== 1 || context.existingLocks[0].id !== input.lockId) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.normalLockMissing, "The team's illegal normal lock is missing.");
    }
    const existing = context.existingLocks[0];
    if (existing.legal === 1 && existing.lock_type === "late") {
      return repository.persistLateLock({ ...input, baselineCutoffAtMs: input.nowMs });
    }
    const decision = evaluateMatchupLineupLegality(context.activePlayers);
    if (!decision.legal) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.stillIllegal, "The team roster is still illegal.");
    }
    if (!context.refresh) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.statisticsMissing, "No successful late baseline is available.");
    }
    assertFreshBaselineSource({
      baselineAtMs: input.nowMs,
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
    return repository.persistLateLock({
      leagueId: context.week.league_id,
      seasonId: context.week.season_id,
      weekId: context.week.id,
      teamId: input.teamId,
      provider: input.provider,
      baselineCutoffAtMs: input.nowMs,
      lockId: existing.id,
      expectedLockVersion: existing.version,
      expectedWeekVersion: context.week.version,
      activePlayerFingerprint: JSON.stringify(context.activePlayers),
      snapshotId: createId(),
      statSourceId: context.refresh.stat_source_id,
      refreshId: context.refresh.id,
      baselineAtMs: input.nowMs,
      nowMs: input.nowMs,
      players: Object.freeze(players),
    });
  }

  return Object.freeze({ lockAtBoundary, lockLate });
}

module.exports = {
  MATCHUP_LEGALITY_SERVICE_CODES,
  MatchupLegalityServiceError,
  createMatchupLegalityService,
};
