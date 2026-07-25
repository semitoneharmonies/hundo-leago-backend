const MATCHUP_SCORING_CODES = Object.freeze({
  inputInvalid: "MATCHUP_SCORING_INPUT_INVALID",
  sourceFuture: "MATCHUP_SCORING_SOURCE_FUTURE",
  sourceRegressed: "MATCHUP_SCORING_SOURCE_REGRESSED",
});
const LIVE_FRESHNESS_WINDOW_MS = 6 * 60 * 60 * 1000;

class MatchupScoringPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupScoringPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupScoringPolicyError(code, message);
}

function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(MATCHUP_SCORING_CODES.inputInvalid, `${label} must be a nonnegative integer.`);
  }
  return value;
}

function describeLiveSource({ nowMs, completedAtMs } = {}) {
  const now = nonnegative(nowMs, "Current time");
  const completed = nonnegative(completedAtMs, "Source completion time");
  if (completed > now) {
    fail(MATCHUP_SCORING_CODES.sourceFuture, "The live source completed in the future.");
  }
  const ageMs = now - completed;
  return Object.freeze({
    ageMs,
    freshnessStatus: ageMs <= LIVE_FRESHNESS_WINDOW_MS ? "fresh" : "stale",
  });
}

function calculateTeamLiveScore({ lock, lockedPlayers, currentTotals } = {}) {
  if (!lock || ![0, 1].includes(lock.legal)) {
    fail(MATCHUP_SCORING_CODES.inputInvalid, "A legal or illegal team lock is required.");
  }
  if (!Array.isArray(lockedPlayers) || !Array.isArray(currentTotals)) {
    fail(MATCHUP_SCORING_CODES.inputInvalid, "Locked players and current totals are required.");
  }
  if (lock.legal === 0) {
    return Object.freeze({
      teamId: lock.team_id,
      legal: false,
      scoreHundredths: 0,
      players: Object.freeze([]),
    });
  }
  const totals = new Map();
  for (const current of currentTotals) {
    if (!current || typeof current.player_id !== "string" || totals.has(current.player_id)) {
      fail(MATCHUP_SCORING_CODES.inputInvalid, "Current totals require unique player IDs.");
    }
    for (const field of ["games_played", "goals", "assists", "fantasy_points_hundredths"]) {
      nonnegative(current[field], field);
    }
    totals.set(current.player_id, current);
  }
  const seenPlayers = new Set();
  const players = lockedPlayers.map((player) => {
    if (
      !player ||
      typeof player.player_id !== "string" ||
      typeof player.player_full_name !== "string" ||
      player.player_full_name.trim().length === 0 ||
      seenPlayers.has(player.player_id)
    ) {
      fail(MATCHUP_SCORING_CODES.inputInvalid, "Locked players require unique IDs.");
    }
    seenPlayers.add(player.player_id);
    const currentAvailable = totals.has(player.player_id);
    const current = totals.get(player.player_id) || {
      games_played: 0,
      goals: 0,
      assists: 0,
      fantasy_points_hundredths: 0,
    };
    const baselines = {
      gamesPlayed: nonnegative(player.baseline_games_played, "Baseline games"),
      goals: nonnegative(player.baseline_goals, "Baseline goals"),
      assists: nonnegative(player.baseline_assists, "Baseline assists"),
      fantasyPoints: nonnegative(
        player.baseline_fantasy_points_hundredths,
        "Baseline fantasy points"
      ),
    };
    if (
      current.games_played < baselines.gamesPlayed ||
      current.goals < baselines.goals ||
      current.assists < baselines.assists ||
      current.fantasy_points_hundredths < baselines.fantasyPoints
    ) {
      fail(MATCHUP_SCORING_CODES.sourceRegressed, "A player total regressed below its baseline.");
    }
    const goalDelta = current.goals - baselines.goals;
    const assistDelta = current.assists - baselines.assists;
    const scoreHundredths = goalDelta * 125 + assistDelta * 100;
    if (current.fantasy_points_hundredths - baselines.fantasyPoints !== scoreHundredths) {
      fail(MATCHUP_SCORING_CODES.sourceRegressed, "A player fantasy total is inconsistent with scoring deltas.");
    }
    return Object.freeze({
      playerId: player.player_id,
      fullName: player.player_full_name,
      positionGroup: player.position_group,
      slotNumber: player.slot_number,
      gamesPlayedDelta: current.games_played - baselines.gamesPlayed,
      goalDelta,
      assistDelta,
      pointDelta: goalDelta + assistDelta,
      scoreHundredths,
      dataStatus: currentAvailable ? "available" : "missing",
    });
  });
  players.sort((left, right) =>
    left.positionGroup.localeCompare(right.positionGroup) ||
    left.slotNumber - right.slotNumber ||
    left.playerId.localeCompare(right.playerId)
  );
  return Object.freeze({
    teamId: lock.team_id,
    legal: true,
    scoreHundredths: players.reduce((sum, player) => sum + player.scoreHundredths, 0),
    players: Object.freeze(players),
  });
}

module.exports = {
  LIVE_FRESHNESS_WINDOW_MS,
  MATCHUP_SCORING_CODES,
  MatchupScoringPolicyError,
  calculateTeamLiveScore,
  describeLiveSource,
};
