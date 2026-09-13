const MATCHUP_LOCK_CODES = Object.freeze({
  inputInvalid: "MATCHUP_LOCK_INPUT_INVALID",
  sourceFuture: "MATCHUP_LOCK_SOURCE_FUTURE",
  sourceStale: "MATCHUP_LOCK_SOURCE_STALE",
  lineupInvalid: "MATCHUP_LOCK_LINEUP_INVALID",
});
const FRESHNESS_WINDOW_MS = 6 * 60 * 60 * 1000;

class MatchupLockPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupLockPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupLockPolicyError(code, message);
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(MATCHUP_LOCK_CODES.inputInvalid, `${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function assertFreshBaselineSource({ baselineAtMs, refreshCompletedAtMs } = {}) {
  const baseline = safeInteger(baselineAtMs, "Baseline time");
  const completed = safeInteger(refreshCompletedAtMs, "Statistics completion time");
  if (completed > baseline) {
    fail(MATCHUP_LOCK_CODES.sourceFuture, "The statistics source completed after the baseline.");
  }
  if (baseline - completed > FRESHNESS_WINDOW_MS) {
    fail(MATCHUP_LOCK_CODES.sourceStale, "The baseline statistics are stale.");
  }
  return Object.freeze({ freshnessStatus: "fresh", ageMs: baseline - completed });
}

function buildLockedPlayerBaselines({ activePlayers, totals } = {}) {
  if (!Array.isArray(activePlayers) || !Array.isArray(totals)) {
    fail(MATCHUP_LOCK_CODES.inputInvalid, "Active players and statistics totals are required.");
  }
  const totalByPlayer = new Map();
  for (const total of totals) {
    if (!total || typeof total.player_id !== "string" || totalByPlayer.has(total.player_id)) {
      fail(MATCHUP_LOCK_CODES.inputInvalid, "Statistics totals require unique player IDs.");
    }
    for (const field of [
      "games_played", "goals", "assists", "fantasy_points_hundredths",
    ]) safeInteger(total[field], field);
    totalByPlayer.set(total.player_id, total);
  }
  const playerIds = new Set();
  const slots = new Set();
  const result = activePlayers.map((player) => {
    if (
      !player ||
      typeof player.player_id !== "string" ||
      playerIds.has(player.player_id) ||
      !["F", "D"].includes(player.position_group) ||
      !Number.isSafeInteger(player.slot_number) ||
      player.slot_number < 1
    ) {
      fail(MATCHUP_LOCK_CODES.lineupInvalid, "The active lineup contains an invalid player slot.");
    }
    const slot = `${player.position_group}:${player.slot_number}`;
    if (slots.has(slot)) {
      fail(MATCHUP_LOCK_CODES.lineupInvalid, "The active lineup contains a duplicate slot.");
    }
    playerIds.add(player.player_id);
    slots.add(slot);
    const total = totalByPlayer.get(player.player_id);
    return Object.freeze({
      playerId: player.player_id,
      positionGroup: player.position_group,
      slotNumber: player.slot_number,
      baselineGamesPlayed: total?.games_played || 0,
      baselineGoals: total?.goals || 0,
      baselineAssists: total?.assists || 0,
      baselineFantasyPointsHundredths: total?.fantasy_points_hundredths || 0,
    });
  });
  result.sort((left, right) =>
    left.positionGroup.localeCompare(right.positionGroup) ||
    left.slotNumber - right.slotNumber ||
    left.playerId.localeCompare(right.playerId)
  );
  return Object.freeze(result);
}

module.exports = {
  FRESHNESS_WINDOW_MS,
  MATCHUP_LOCK_CODES,
  MatchupLockPolicyError,
  assertFreshBaselineSource,
  buildLockedPlayerBaselines,
};
