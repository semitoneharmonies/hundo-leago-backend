const { randomUUID } = require("node:crypto");

const {
  deriveMatchupOutcome,
  evaluateFinalSource,
  validateResultCorrection,
} = require("../../../domain/matchups/matchupResultPolicy");

const MATCHUP_RESULT_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_RESULT_CONTEXT_MISSING",
  stateInvalid: "MATCHUP_RESULT_STATE_INVALID",
  alreadyFinal: "MATCHUP_RESULT_ALREADY_FINAL",
  commissionerRequired: "MATCHUP_RESULT_COMMISSIONER_REQUIRED",
});

class MatchupResultServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupResultServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupResultServiceError(code, message);
}

function createMatchupResultService({ repository, scoringService, createId = randomUUID } = {}) {
  if (
    !repository ||
    typeof repository.readContext !== "function" ||
    typeof repository.readOperation !== "function" ||
    typeof repository.finalize !== "function" ||
    typeof repository.correct !== "function"
  ) {
    throw new TypeError("createMatchupResultService requires a matchup-result repository");
  }
  if (!scoringService || typeof scoringService.readLive !== "function") {
    throw new TypeError("createMatchupResultService requires the live scoring service");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createMatchupResultService requires an ID factory");
  }

  function replay(input, expectedOperationType) {
    if (!input.operationId) return null;
    const operation = repository.readOperation({ ...input, expectedOperationType });
    if (!operation) return null;
    return Object.freeze({
      replayed: true,
      operationId: operation.id,
      context: repository.readContext(input),
    });
  }

  function finalize(input) {
    const prior = replay(input, "result_finalize");
    if (prior) return prior;
    const context = repository.readContext(input);
    if (!context) fail(MATCHUP_RESULT_SERVICE_CODES.contextMissing, "The matchup was not found.");
    if (context.result) fail(MATCHUP_RESULT_SERVICE_CODES.alreadyFinal, "The matchup already has a result.");
    if (
      context.matchup.status !== "awaiting_data" ||
      context.matchup.week_status !== "awaiting_data" ||
      !Number.isSafeInteger(input.nowMs) ||
      input.nowMs < context.matchup.ends_at_ms
    ) {
      fail(MATCHUP_RESULT_SERVICE_CODES.stateInvalid, "The matchup is not ready for finalization.");
    }
    const score = scoringService.readLive(input);
    const source = evaluateFinalSource({
      weekEndsAtMs: context.matchup.ends_at_ms,
      refreshCompletedAtMs: score.source.completedAtMs,
      nowMs: input.nowMs,
    });
    if (!source.ready) {
      return Object.freeze({ replayed: false, finalized: false, waiting: source });
    }
    const result = repository.finalize({
      leagueId: context.matchup.league_id,
      seasonId: context.matchup.season_id,
      weekId: context.matchup.matchup_week_id,
      matchupId: context.matchup.id,
      expectedMatchupVersion: context.matchup.version,
      operationId: input.operationId || createId(),
      resultId: createId(),
      resultVersionId: createId(),
      snapshotId: createId(),
      refreshId: score.source.refreshId,
      homeTeamId: context.matchup.home_team_id,
      awayTeamId: context.matchup.away_team_id,
      homeScoreHundredths: score.home.scoreHundredths,
      awayScoreHundredths: score.away.scoreHundredths,
      outcome: deriveMatchupOutcome(score.home.scoreHundredths, score.away.scoreHundredths),
      nowMs: input.nowMs,
    });
    return Object.freeze({ replayed: false, finalized: true, context: result });
  }

  function correct(input) {
    const prior = replay(input, "result_correct");
    if (prior) return prior;
    const context = repository.readContext(input);
    if (!context || !context.result || context.versions.length < 1) {
      fail(MATCHUP_RESULT_SERVICE_CODES.contextMissing, "The official matchup result was not found.");
    }
    if (context.matchup.commissioner_user_id !== input.actorUserId) {
      fail(MATCHUP_RESULT_SERVICE_CODES.commissionerRequired, "Current commissioner authority is required.");
    }
    const correction = validateResultCorrection(input);
    const current = context.versions.at(-1);
    const result = repository.correct({
      leagueId: context.matchup.league_id,
      seasonId: context.matchup.season_id,
      weekId: context.matchup.matchup_week_id,
      matchupId: context.matchup.id,
      operationId: input.operationId || createId(),
      actorUserId: input.actorUserId,
      resultId: context.result.id,
      resultVersionId: createId(),
      versionNumber: current.version_number + 1,
      expectedResultVersion: input.expectedResultVersion,
      supersedesVersionId: current.id,
      snapshotId: current.source_snapshot_id,
      sourceType: "correction",
      homeTeamId: context.matchup.home_team_id,
      awayTeamId: context.matchup.away_team_id,
      homeScoreHundredths: correction.homeScoreHundredths,
      awayScoreHundredths: correction.awayScoreHundredths,
      outcome: correction.outcome,
      reason: correction.reason,
      nowMs: input.nowMs,
    });
    return Object.freeze({ replayed: false, corrected: true, context: result });
  }

  return Object.freeze({ correct, finalize });
}

module.exports = {
  MATCHUP_RESULT_SERVICE_CODES,
  MatchupResultServiceError,
  createMatchupResultService,
};
