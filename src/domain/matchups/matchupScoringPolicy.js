const MATCHUP_SCORING_CODES = Object.freeze({
  inputInvalid: "MATCHUP_SCORING_INPUT_INVALID",
  sourceFuture: "MATCHUP_SCORING_SOURCE_FUTURE",
  sourceRegressed: "MATCHUP_SCORING_SOURCE_REGRESSED",
  evidenceMissing: "MATCHUP_SCORING_PLAYER_GAME_EVIDENCE_MISSING",
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

function calculateTeamLiveScore({
  lock,
  lockedPlayers,
  currentTotals,
  excludedPlayerGames = [],
} = {}) {
  if (!lock || ![0, 1].includes(lock.legal)) {
    fail(MATCHUP_SCORING_CODES.inputInvalid, "A legal or illegal team lock is required.");
  }
  if (
    !Array.isArray(lockedPlayers) ||
    !Array.isArray(currentTotals) ||
    !Array.isArray(excludedPlayerGames)
  ) {
    fail(
      MATCHUP_SCORING_CODES.inputInvalid,
      "Locked players, current totals, and exclusions are required."
    );
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
  const excludedByPlayer = new Map();
  const excludedIdentities = new Set();
  for (const excluded of excludedPlayerGames) {
    if (
      !excluded ||
      typeof excluded.player_id !== "string" ||
      typeof excluded.nhl_game_id !== "string"
    ) {
      fail(
        MATCHUP_SCORING_CODES.inputInvalid,
        "Excluded player-game evidence requires stable identities."
      );
    }
    const identity =
      `${excluded.player_id}\u0000${excluded.nhl_game_id}`;
    if (excludedIdentities.has(identity)) {
      fail(
        MATCHUP_SCORING_CODES.inputInvalid,
        "Excluded player-game evidence contains a duplicate identity."
      );
    }
    excludedIdentities.add(identity);
    const baselineGoals = nonnegative(
      excluded.baseline_goals,
      "Excluded baseline goals"
    );
    const baselineAssists = nonnegative(
      excluded.baseline_assists,
      "Excluded baseline assists"
    );
    const baselineFantasyPoints = nonnegative(
      excluded.baseline_fantasy_points_hundredths,
      "Excluded baseline fantasy points"
    );
    if (
      excluded.current_goals === null ||
      excluded.current_assists === null ||
      excluded.current_fantasy_points_hundredths === null ||
      excluded.current_goals === undefined ||
      excluded.current_assists === undefined ||
      excluded.current_fantasy_points_hundredths === undefined
    ) {
      fail(
        MATCHUP_SCORING_CODES.evidenceMissing,
        "Current player-game evidence is missing."
      );
    }
    const currentGoals = nonnegative(
      excluded.current_goals,
      "Excluded current goals"
    );
    const currentAssists = nonnegative(
      excluded.current_assists,
      "Excluded current assists"
    );
    const currentFantasyPoints = nonnegative(
      excluded.current_fantasy_points_hundredths,
      "Excluded current fantasy points"
    );
    if (
      currentGoals < baselineGoals ||
      currentAssists < baselineAssists ||
      currentFantasyPoints < baselineFantasyPoints
    ) {
      fail(
        MATCHUP_SCORING_CODES.sourceRegressed,
        "Excluded player-game evidence regressed below its baseline."
      );
    }
    const goalDelta = currentGoals - baselineGoals;
    const assistDelta = currentAssists - baselineAssists;
    const fantasyDelta =
      currentFantasyPoints - baselineFantasyPoints;
    if (fantasyDelta !== goalDelta * 125 + assistDelta * 100) {
      fail(
        MATCHUP_SCORING_CODES.sourceRegressed,
        "Excluded player-game evidence has inconsistent scoring deltas."
      );
    }
    const aggregate = excludedByPlayer.get(excluded.player_id) || {
      goals: 0,
      assists: 0,
      fantasyPoints: 0,
    };
    aggregate.goals += goalDelta;
    aggregate.assists += assistDelta;
    aggregate.fantasyPoints += fantasyDelta;
    excludedByPlayer.set(excluded.player_id, aggregate);
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
    if (!totals.has(player.player_id)) {
      fail(
        MATCHUP_SCORING_CODES.evidenceMissing,
        "A legally locked player is missing current totals."
      );
    }
    const current = totals.get(player.player_id);
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
    const ordinaryGoalDelta = current.goals - baselines.goals;
    const ordinaryAssistDelta = current.assists - baselines.assists;
    const ordinaryScoreHundredths =
      ordinaryGoalDelta * 125 + ordinaryAssistDelta * 100;
    if (
      current.fantasy_points_hundredths - baselines.fantasyPoints !==
      ordinaryScoreHundredths
    ) {
      fail(MATCHUP_SCORING_CODES.sourceRegressed, "A player fantasy total is inconsistent with scoring deltas.");
    }
    const excluded = excludedByPlayer.get(player.player_id) || {
      goals: 0,
      assists: 0,
      fantasyPoints: 0,
    };
    if (
      excluded.goals > ordinaryGoalDelta ||
      excluded.assists > ordinaryAssistDelta ||
      excluded.fantasyPoints > ordinaryScoreHundredths
    ) {
      fail(
        MATCHUP_SCORING_CODES.sourceRegressed,
        "Excluded player-game deltas exceed the matchup total."
      );
    }
    const goalDelta = ordinaryGoalDelta - excluded.goals;
    const assistDelta = ordinaryAssistDelta - excluded.assists;
    const scoreHundredths =
      ordinaryScoreHundredths - excluded.fantasyPoints;
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
      dataStatus: "available",
    });
  });
  players.sort((left, right) =>
    left.positionGroup.localeCompare(right.positionGroup) ||
    left.slotNumber - right.slotNumber ||
    left.playerId.localeCompare(right.playerId)
  );
  for (const playerId of excludedByPlayer.keys()) {
    if (!seenPlayers.has(playerId)) {
      fail(
        MATCHUP_SCORING_CODES.inputInvalid,
        "Excluded player-game evidence is outside the locked roster."
      );
    }
  }
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
