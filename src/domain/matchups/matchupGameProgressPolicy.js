const TEAM = new Set('ANA ARI BOS BUF CAR CBJ CGY CHI COL DAL DET EDM FLA LAK MIN MTL NJD NSH NYI NYR OTT PHI PIT SEA SJS STL TBL TOR UTA VAN VGK WPG WSH'.split(' '));
const normalizeTeam = value => ({LA:'LAK',NJ:'NJD',SJ:'SJS',TB:'TBL',MON:'MTL'}[value] || value);

// Player-games, using exactly the lineup and accepted scoring window shown in the matchup.
function calculateMatchupGameProgress({ context, scoring, schedule, timeZone, asOfMs }) {
  const week = context.matchup;
  const side = (name) => {
    const score = scoring[name], teamId = score.teamId;
    if (!score.legal) return { teamId, status: 'not_scoring', tallied: 0, remaining: 0, total: 0 };
    const tallied = score.players.reduce((sum, player) => sum + player.gamesPlayedDelta, 0);
    const final = week.status === 'final';
    const complete = { teamId, status: 'complete', tallied, remaining: 0, total: tallied };
    const unknown = status => final ? complete : ({ teamId, status, tallied, remaining: null, total: null });
    if (!schedule) return unknown('schedule_unavailable');
    const lock = context.locks.find(item => item.team_id === teamId);
    if (!lock) return unknown('scoring_unavailable');
    const players = context.lockedPlayers.filter(player => player.matchup_roster_lock_id === lock.id);
    const startsAtMs = lock.lock_type === 'late' ? lock.locked_at_ms : week.week_starts_at_ms;
    const exclusions = new Set(context.exclusions.filter(item => item.team_id === teamId).map(item => `${item.player_id}:${item.nhl_game_id}`));
    let remaining = 0;
    const details = { timeZone, asOfMs, games: [] };
    const teamNames = new Map();
    for (const game of schedule.games) {
      if (game.homeTeamId) teamNames.set(game.homeTeamId, game.homeTeam);
      if (game.awayTeamId) teamNames.set(game.awayTeamId, game.awayTeam);
    }
    const appearances = new Set((context.expandedScoring?.playerGames || []).filter(game => game.gamesPlayed === 1).map(game => `${game.playerId}:${game.nhlGameId}`));
    for (const player of players) {
      const coverage = (context.playerGameCoverage || []).filter(item => item.player_id === player.player_id);
      const latest = coverage.toSorted((a, b) => (b.nhl_game_scheduled_starts_at_ms ?? -1) - (a.nhl_game_scheduled_starts_at_ms ?? -1))[0];
      // The locked label can predate an NHL trade. Use accepted provider bindings
      // for scheduled games, while retaining each observed game's historical team.
      const team = latest?.provider_team_id
        ? teamNames.get(String(latest.provider_team_id))
        : normalizeTeam(player.nhl_team_abbreviation);
      if (!TEAM.has(team)) return unknown('team_unavailable');
      const coverageByGame = new Map(coverage.map(item => [String(item.nhl_game_id), item]));
      const observed = new Map(context.playerGameObservations.filter(item => item.player_id === player.player_id).map(item => [String(item.nhl_game_id), item]));
      const games = new Map(schedule.games.map(game => [String(game.id), game]));
      for (const [id, game] of games) {
        const evidence = observed.get(id);
        if (game.homeTeam !== team && game.awayTeam !== team && !evidence) continue;
        if (game.startsAtMs < startsAtMs || game.startsAtMs >= week.week_ends_at_ms || exclusions.has(`${player.player_id}:${id}`)) continue;
        if (['postponed', 'cancelled'].includes(game.status)) continue;
        // Final accepted evidence also resolves a scratch/DNP, without inventing a played game.
        const collected = evidence?.observed_game_state === 'final';
        if (collected && !appearances.has(`${player.player_id}:${id}`)) continue;
        if (final && !collected) continue;
        if (!collected) remaining += 1;
        const gameTeam = teamNames.get(String(coverageByGame.get(id)?.provider_team_id)) || team;
        details.games.push({ playerId: player.player_id, playerName: player.player_full_name,
          gameId: id, startsAtMs: game.startsAtMs, timeTbd: Boolean(game.timeTbd),
          opponent: game.homeTeam === gameTeam ? game.awayTeam : game.awayTeam === gameTeam ? game.homeTeam : null,
          isHome: game.homeTeam === gameTeam ? true : game.awayTeam === gameTeam ? false : null,
          status: collected ? 'collected' : game.status === 'final' ? 'awaiting_scoring' : game.status,
        });
      }
    }
    return { ...(final ? complete : { teamId, status: 'available', tallied, remaining, total: tallied + remaining }),
      ...(timeZone && Number.isSafeInteger(asOfMs) ? { details } : {}) };
  };
  return { home: side('home'), away: side('away') };
}

module.exports = { calculateMatchupGameProgress };
