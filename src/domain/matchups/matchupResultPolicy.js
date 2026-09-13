const MATCHUP_RESULT_CODES = Object.freeze({
  inputInvalid: "MATCHUP_RESULT_INPUT_INVALID",
  sourceFuture: "MATCHUP_RESULT_SOURCE_FUTURE",
  correctionInvalid: "MATCHUP_RESULT_CORRECTION_INVALID",
});
const FINAL_FRESHNESS_WINDOW_MS = 6 * 60 * 60 * 1000;

class MatchupResultPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupResultPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupResultPolicyError(code, message);
}

function score(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(MATCHUP_RESULT_CODES.inputInvalid, "A nonnegative score is required.");
  }
  return value;
}

function deriveMatchupOutcome(homeScoreHundredths, awayScoreHundredths) {
  const home = score(homeScoreHundredths);
  const away = score(awayScoreHundredths);
  if (home === away) return "tie";
  return home > away ? "home_win" : "away_win";
}

function evaluateFinalSource({ weekEndsAtMs, refreshCompletedAtMs, nowMs } = {}) {
  for (const value of [weekEndsAtMs, refreshCompletedAtMs, nowMs]) score(value);
  if (refreshCompletedAtMs > nowMs) {
    fail(MATCHUP_RESULT_CODES.sourceFuture, "The final source completed in the future.");
  }
  if (refreshCompletedAtMs < weekEndsAtMs) {
    return Object.freeze({ ready: false, reasonCode: "SOURCE_BEFORE_WEEK_END" });
  }
  const ageMs = nowMs - refreshCompletedAtMs;
  if (ageMs > FINAL_FRESHNESS_WINDOW_MS) {
    return Object.freeze({ ready: false, reasonCode: "SOURCE_STALE", ageMs });
  }
  return Object.freeze({ ready: true, reasonCode: null, ageMs });
}

function validateResultCorrection({ homeScoreHundredths, awayScoreHundredths, reason } = {}) {
  const home = score(homeScoreHundredths);
  const away = score(awayScoreHundredths);
  if (
    typeof reason !== "string" ||
    reason.trim() !== reason ||
    reason.length < 1 ||
    reason.length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(reason)
  ) {
    fail(MATCHUP_RESULT_CODES.correctionInvalid, "A bounded correction reason is required.");
  }
  return Object.freeze({
    homeScoreHundredths: home,
    awayScoreHundredths: away,
    outcome: deriveMatchupOutcome(home, away),
    reason,
  });
}

module.exports = {
  FINAL_FRESHNESS_WINDOW_MS,
  MATCHUP_RESULT_CODES,
  MatchupResultPolicyError,
  deriveMatchupOutcome,
  evaluateFinalSource,
  validateResultCorrection,
};
