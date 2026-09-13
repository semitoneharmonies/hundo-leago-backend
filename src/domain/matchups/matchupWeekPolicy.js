const MATCHUP_WEEK_CODES = Object.freeze({
  inputInvalid: "MATCHUP_WEEK_INPUT_INVALID",
  stateInvalid: "MATCHUP_WEEK_STATE_INVALID",
  transitionEarly: "MATCHUP_WEEK_TRANSITION_EARLY",
  transitionTerminal: "MATCHUP_WEEK_TRANSITION_TERMINAL",
});

const WEEK_STATUSES = Object.freeze([
  "scheduled",
  "baseline_ready",
  "live",
  "awaiting_data",
  "final",
  "correction_required",
  "cancelled",
]);
const MATCHUP_STATUSES = Object.freeze([
  "scheduled",
  "live",
  "awaiting_data",
  "final",
  "postponed",
  "cancelled",
  "correction_required",
]);

class MatchupWeekPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupWeekPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupWeekPolicyError(code, message);
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(MATCHUP_WEEK_CODES.inputInvalid, `${label} must be a safe timestamp.`);
  }
  return value;
}

function validateWeekBoundaries({
  startsAtMs,
  baselineAtMs,
  locksAtMs,
  endsAtMs,
  rollsOverAtMs,
} = {}) {
  const boundaries = Object.freeze({
    startsAtMs: timestamp(startsAtMs, "Week start"),
    baselineAtMs: timestamp(baselineAtMs, "Baseline"),
    locksAtMs: timestamp(locksAtMs, "Lock"),
    endsAtMs: timestamp(endsAtMs, "Week end"),
    rollsOverAtMs: timestamp(rollsOverAtMs, "Rollover"),
  });
  if (
    boundaries.baselineAtMs < boundaries.startsAtMs ||
    boundaries.locksAtMs < boundaries.baselineAtMs ||
    boundaries.endsAtMs <= boundaries.locksAtMs ||
    boundaries.rollsOverAtMs < boundaries.endsAtMs
  ) {
    fail(MATCHUP_WEEK_CODES.inputInvalid, "Matchup-week boundaries are out of order.");
  }
  return boundaries;
}

function isManagerRosterWriteOpen({ nowMs, locksAtMs } = {}) {
  return timestamp(nowMs, "Current time") < timestamp(locksAtMs, "Lock");
}

function deriveNextWeekTransition({ status, nowMs, ...boundariesInput } = {}) {
  if (!WEEK_STATUSES.includes(status)) {
    fail(MATCHUP_WEEK_CODES.stateInvalid, "The matchup-week status is invalid.");
  }
  const now = timestamp(nowMs, "Current time");
  const boundaries = validateWeekBoundaries(boundariesInput);
  const rules = {
    scheduled: { atMs: boundaries.baselineAtMs, toStatus: "baseline_ready", matchupStatus: null },
    baseline_ready: { atMs: boundaries.locksAtMs, toStatus: "live", matchupStatus: "live" },
    live: { atMs: boundaries.endsAtMs, toStatus: "awaiting_data", matchupStatus: "awaiting_data" },
  };
  const rule = rules[status];
  if (!rule) {
    fail(MATCHUP_WEEK_CODES.transitionTerminal, "This matchup-week state is not time-advanceable.");
  }
  if (now < rule.atMs) {
    fail(MATCHUP_WEEK_CODES.transitionEarly, "The next matchup-week boundary has not arrived.");
  }
  return Object.freeze({
    fromStatus: status,
    toStatus: rule.toStatus,
    matchupStatus: rule.matchupStatus,
    effectiveAtMs: rule.atMs,
    observedAtMs: now,
  });
}

module.exports = {
  MATCHUP_STATUSES,
  MATCHUP_WEEK_CODES,
  WEEK_STATUSES,
  MatchupWeekPolicyError,
  deriveNextWeekTransition,
  isManagerRosterWriteOpen,
  validateWeekBoundaries,
};
