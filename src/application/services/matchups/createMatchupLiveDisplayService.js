const {
  emptyScoringStats, addScoringStats, normalizeScoringStats, calculateExpandedScore,
} = require('../../../domain/statistics/expandedScoringPolicy');

const identity = value => typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : null;
const pair = (playerId, gameId) => `${playerId}\u0000${gameId}`;

// Presentation only. The official scorer verifies the context before calling this
// service; this service neither persists evidence nor participates in finalization.
function createMatchupLiveDisplayService({ repository, liveStatistics } = {}) {
  if (!repository || typeof repository.readContext !== 'function' || !liveStatistics || typeof liveStatistics.readSnapshot !== 'function') {
    throw new TypeError('Live display requires a scoring read repository and live cache.');
  }

  function projection(context, scoring, date, timeZone) {
    if (!['live', 'awaiting_data'].includes(context?.matchup?.status) ||
        context.refresh?.provider !== 'nhl-completed-games' || !context.expandedScoring ||
        context.refresh.id !== scoring?.source?.refreshId) return null;
    const snapshot = liveStatistics.readSnapshot();
    if (!snapshot?.enabled) return null;
    const status = snapshot.status === 'available' ? 'fresh' : snapshot.status === 'stale' ? 'stale' : 'unavailable';
    const metadata = {
      status, updatedAtMs: snapshot.updatedAtMs ?? null, lastAttemptAtMs: snapshot.lastAttemptAtMs ?? null,
      provisionalGameCount: 0, gameIds: [], provisional: true,
    };
    const byTeam = new Map();
    if (status === 'unavailable') return { byTeam, metadata };

    // The accepted final observation, not the live feed's FINAL label, hands a
    // game back to the existing authority. Scratch/DNP final zeroes count too.
    const acceptedGames = new Set(context.playerGameObservations
      .filter(row => row.observed_game_state === 'final').map(row => String(row.nhl_game_id)));
    const bindings = new Map();
    for (const row of context.playerGameCoverage) {
      const providerId = identity(row.provider_player_id);
      if (!providerId) continue;
      const existing = bindings.get(row.player_id);
      if (existing !== undefined && existing !== providerId) throw new TypeError('Ambiguous live player identity.');
      bindings.set(row.player_id, providerId);
    }
    const latest = new Map();
    const dateFormatter = date ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) : null;
    for (const game of snapshot.games || []) {
      const gameId = identity(game.gameId);
      if (!gameId || !['live', 'final'].includes(game.state) || !Number.isSafeInteger(game.startsAtMs) ||
          game.startsAtMs < context.matchup.week_starts_at_ms || game.startsAtMs >= context.matchup.week_ends_at_ms || acceptedGames.has(gameId)) continue;
      if (dateFormatter && dateFormatter.format(new Date(game.startsAtMs)) !== date) continue;
      if (!Number.isSafeInteger(game.updatedAtMs)) throw new TypeError('Live game freshness is required.');
      const previous = latest.get(gameId);
      if (!previous || game.updatedAtMs > previous.updatedAtMs) latest.set(gameId, game);
      else if (game.updatedAtMs === previous.updatedAtMs && JSON.stringify(game) !== JSON.stringify(previous)) throw new TypeError('Conflicting live game snapshots.');
    }
    const usedGames = new Set();
    for (const lock of context.locks) {
      if (lock.legal !== 1) continue;
      const excluded = new Set(context.exclusions.filter(row => row.team_id === lock.team_id)
        .map(row => pair(row.player_id, String(row.nhl_game_id))));
      const players = context.lockedPlayers.filter(row => row.matchup_roster_lock_id === lock.id);
      const totals = new Map();
      for (const [gameId, game] of latest) {
        const livePlayers = new Map();
        for (const row of game.playerGames) {
          const providerId = identity(row.providerPlayerId);
          if (!providerId || livePlayers.has(providerId)) throw new TypeError('Duplicate or missing live player identity.');
          livePlayers.set(providerId, row);
        }
        for (const player of players) {
          if (excluded.has(pair(player.player_id, gameId))) continue;
          const row = livePlayers.get(bindings.get(player.player_id));
          if (!row) continue;
          if (![0, 1].includes(row.gamesPlayed)) throw new TypeError('Live participation is required.');
          const stats = normalizeScoringStats(row.scoringStats);
          if (!row.gamesPlayed) {
            if (Object.values(stats).some(value => value !== 0)) throw new TypeError('Nonparticipant has live statistics.');
            continue;
          }
          // Eligibility comes from sealed whole-game exclusions. An advertised
          // start before a late lock does not prove the game had already begun.
          const total = totals.get(player.player_id) || { stats: emptyScoringStats(), gameIds: [] };
          addScoringStats(total.stats, stats);
          total.gameIds.push(gameId);
          totals.set(player.player_id, total);
          usedGames.add(gameId);
        }
      }
      byTeam.set(lock.team_id, totals);
    }
    metadata.gameIds = [...usedGames].sort();
    metadata.provisionalGameCount = usedGames.size;
    return { byTeam, metadata };
  }

  function side(context, official, totals) {
    if (!totals?.size || official.legal === false || ['not_scoring', 'unavailable'].includes(official.status)) return official;
    const lock = context.locks.find(row => row.team_id === official.teamId);
    if (lock?.legal !== 1) return official;
    const players = new Map(official.players.map(player => [player.playerId, player]));
    for (const [playerId, total] of totals) {
      const locked = context.lockedPlayers.find(row => row.player_id === playerId && row.matchup_roster_lock_id === lock.id);
      if (!locked) continue;
      const current = players.get(playerId) || {
        playerId, fullName: locked.player_full_name, nhlTeamAbbreviation: locked.nhl_team_abbreviation || null,
        positionGroup: locked.position_group, slotNumber: locked.slot_number, gamesPlayedDelta: 0,
        scoreHundredths: 0, scoringStats: emptyScoringStats(), dataStatus: 'available',
      };
      const stats = { ...current.scoringStats };
      addScoringStats(stats, total.stats);
      // Always retain the locked position, even if the current NHL feed differs.
      const calculation = calculateExpandedScore(stats, locked.position_group, context.scoringRule);
      const goalDelta = stats.evenStrengthGoals + stats.powerPlayGoals + stats.shortHandedGoals;
      const assistDelta = stats.primaryAssists + stats.secondaryAssists;
      players.set(playerId, { ...current, goalDelta, assistDelta, pointDelta: goalDelta + assistDelta,
        scoreHundredths: calculation.fantasyPointsHundredths, scoringStats: calculation.scoringStats,
        scoringBreakdown: calculation.breakdown, scoringRuleVersion: calculation.scoringRuleVersion,
        ...(calculation.scoringWeights ? { scoringWeights: calculation.scoringWeights } : {}),
        live: { provisional: true, officialScoreHundredths: current.scoreHundredths, gameIds: total.gameIds },
      });
    }
    const result = [...players.values()].sort((a, b) => a.positionGroup.localeCompare(b.positionGroup) || a.slotNumber - b.slotNumber || a.playerId.localeCompare(b.playerId));
    return { ...official, players: result, scoreHundredths: result.reduce((sum, player) => sum + player.scoreHundredths, 0) };
  }

  function project({ context, scoring }) {
    try {
      const live = projection(context, scoring);
      if (!live) return scoring;
      return { ...scoring, source: { ...scoring.source, live: live.metadata },
        home: side(context, scoring.home, live.byTeam.get(scoring.home.teamId)),
        away: side(context, scoring.away, live.byTeam.get(scoring.away.teamId)) };
    } catch {
      // An invalid provisional cache cannot take the accepted score offline.
      return { ...scoring, source: { ...scoring.source, live: { status: 'unavailable', updatedAtMs: null,
        lastAttemptAtMs: null, provisionalGameCount: 0, gameIds: [], provisional: true } } };
    }
  }

  function projectDay({ context, scoring, day, timeZone }) {
    if (!day) return day;
    try {
      const live = projection(context, scoring, day.date, timeZone);
      if (!live) return day;
      return { ...day, live: live.metadata,
        home: side(context, day.home, live.byTeam.get(day.home.teamId)),
        away: side(context, day.away, live.byTeam.get(day.away.teamId)) };
    } catch { return day; }
  }

  function read(input, officialScore) {
    try { return project({ context: repository.readContext(input), scoring: officialScore }); }
    catch { return officialScore; }
  }
  return Object.freeze({ read, project, projectDay });
}

module.exports = { createMatchupLiveDisplayService };
