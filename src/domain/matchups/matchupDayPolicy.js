const { calculateExpandedTeamScore } = require('./expandedMatchupScoringPolicy');

function matchupDates({ context, timeZone }) {
  const startsAtMs = context?.matchup?.week_starts_at_ms;
  const endsAtMs = context?.matchup?.week_ends_at_ms;
  if (!timeZone || !Number.isSafeInteger(startsAtMs) || !Number.isSafeInteger(endsAtMs) || endsAtMs <= startsAtMs) return [];
  let first, last;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    first = formatter.format(new Date(startsAtMs));
    last = formatter.format(new Date(endsAtMs - 1));
  } catch { return []; }
  // Advance calendar labels in UTC, not elapsed 24-hour periods in the league's
  // timezone. A DST change must neither repeat nor omit a selectable day.
  const cursor = new Date(`${first}T00:00:00.000Z`);
  const end = Date.parse(`${last}T00:00:00.000Z`);
  const dates = [];
  while (cursor.getTime() <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// Called only after the ordinary scorer has verified the complete sealed context.
// Filtering that accepted evidence by local game date never changes saved scores.
function calculateMatchupDay({ context, scoring, progress, timeZone, asOfMs, date: requestedDate }) {
  if (!timeZone || !Number.isSafeInteger(asOfMs)) return null;
  if (requestedDate !== undefined && !matchupDates({ context, timeZone }).includes(requestedDate)) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateOf = ms => formatter.format(new Date(ms));
  const date = requestedDate ?? dateOf(asOfMs);
  const observations = context.playerGameObservations.filter(row => dateOf(row.nhl_game_scheduled_starts_at_ms) === date);
  const currentPlayerGames = new Map(observations.map(row => [`${row.player_id}\u0000${row.nhl_game_id}`, {
    playerId: row.player_id, nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs: row.nhl_game_scheduled_starts_at_ms, observedGameState: row.observed_game_state,
  }]));
  const side = name => {
    const weekly = scoring[name];
    const base = { teamId: weekly.teamId, players: [] };
    if (!weekly.legal) return { ...base, status: 'not_scoring', scoreHundredths: 0 };
    const details = progress[name]?.details;
    if (!details) return { ...base, status: 'unavailable', scoreHundredths: null };
    const lock = context.locks.find(row => row.team_id === weekly.teamId);
    const daily = calculateExpandedTeamScore({
      lock, lockedPlayers: context.lockedPlayers.filter(row => row.matchup_roster_lock_id === lock.id),
      currentPlayerGames, expandedPlayerGames: context.expandedScoring.playerGames,
      excludedPlayerGames: context.exclusions.filter(row => row.team_id === weekly.teamId),
      weekStartsAtMs: context.matchup.week_starts_at_ms, weekEndsAtMs: context.matchup.week_ends_at_ms,
      scoringRule: context.scoringRule,
    });
    const scheduled = new Set(details.games.filter(game => dateOf(game.startsAtMs) === date).map(game => game.playerId));
    // Accepted participation also includes delayed pre-game starts eligible under
    // sealed late-lock exclusions, even when schedule progress omitted that game.
    const players = daily.players.filter(player => scheduled.has(player.playerId) || player.gamesPlayedDelta > 0);
    return { ...base, status: 'available', scoreHundredths: players.reduce((sum, player) => sum + player.scoreHundredths, 0), players };
  };
  return { date, timeZone, asOfMs, home: side('home'), away: side('away') };
}

function calculateMatchupDays(input) {
  return matchupDates(input).map(date => calculateMatchupDay({ ...input, date })).filter(Boolean);
}

module.exports = { calculateMatchupDay, calculateMatchupDays };
