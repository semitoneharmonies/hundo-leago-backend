const { EXPANDED_SCORING_VERSION, emptyScoringStats, addScoringStats, calculateExpandedScore } = require("../statistics/expandedScoringPolicy");

function calculateExpandedTeamScore({ lock, lockedPlayers, currentPlayerGames, expandedPlayerGames, excludedPlayerGames, weekStartsAtMs, weekEndsAtMs }) {
  if (!lock || ![0, 1].includes(lock.legal) || !Number.isSafeInteger(weekStartsAtMs) || !Number.isSafeInteger(weekEndsAtMs) || weekEndsAtMs <= weekStartsAtMs) throw new TypeError("A valid matchup scoring window and team lock are required.");
  if (lock.legal === 0) return Object.freeze({ teamId: lock.team_id, legal: false, scoreHundredths: 0, scoringRuleVersion: EXPANDED_SCORING_VERSION, players: Object.freeze([]) });
  const exclusions = new Set(excludedPlayerGames.map((row) => `${row.player_id}\u0000${row.nhl_game_id}`));
  const startsAtMs = lock.lock_type === "late" ? lock.locked_at_ms : weekStartsAtMs;
  const totals = new Map();
  for (const player of lockedPlayers) {
    if (totals.has(player.player_id)) throw new TypeError("A locked roster repeats a player.");
    totals.set(player.player_id, { stats: emptyScoringStats(), gamesPlayed: 0 });
  }
  const categories = new Map(expandedPlayerGames.map((row) => [`${row.playerId}\u0000${row.nhlGameId}`, row]));
  if (categories.size !== expandedPlayerGames.length) throw new TypeError("Expanded game evidence repeats a player-game.");
  for (const [key, game] of currentPlayerGames) {
    const total = totals.get(game.playerId);
    if (!total || exclusions.has(key) || game.observedGameState !== "final" || game.nhlGameScheduledStartsAtMs < startsAtMs || game.nhlGameScheduledStartsAtMs >= weekEndsAtMs) continue;
    const expanded = categories.get(key);
    if (!expanded) throw new TypeError("A scoring-eligible game is missing expanded statistics.");
    addScoringStats(total.stats, expanded.scoringStats);
    if (![0, 1].includes(expanded.gamesPlayed)) throw new TypeError("Game participation is missing.");
    total.gamesPlayed += expanded.gamesPlayed;
  }
  const players = lockedPlayers.map((player) => {
    const total = totals.get(player.player_id);
    const calculation = calculateExpandedScore(total.stats, player.position_group);
    const goalDelta = total.stats.evenStrengthGoals + total.stats.powerPlayGoals + total.stats.shortHandedGoals;
    const assistDelta = total.stats.primaryAssists + total.stats.secondaryAssists;
    return Object.freeze({ playerId: player.player_id, fullName: player.player_full_name, positionGroup: player.position_group, slotNumber: player.slot_number,
      gamesPlayedDelta: total.gamesPlayed, goalDelta, assistDelta, pointDelta: goalDelta + assistDelta,
      scoreHundredths: calculation.fantasyPointsHundredths, dataStatus: "available", scoringRuleVersion: EXPANDED_SCORING_VERSION,
      scoringStats: calculation.scoringStats, scoringBreakdown: calculation.breakdown });
  });
  players.sort((a, b) => a.positionGroup.localeCompare(b.positionGroup) || a.slotNumber - b.slotNumber || a.playerId.localeCompare(b.playerId));
  return Object.freeze({ teamId: lock.team_id, legal: true, scoreHundredths: players.reduce((sum, player) => sum + player.scoreHundredths, 0), scoringRuleVersion: EXPANDED_SCORING_VERSION, players: Object.freeze(players) });
}

module.exports = { calculateExpandedTeamScore };
