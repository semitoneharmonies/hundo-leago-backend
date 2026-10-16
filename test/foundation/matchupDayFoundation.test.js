const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateMatchupDay } = require('../../src/domain/matchups/matchupDayPolicy');
const { calculateMatchupGameProgress } = require('../../src/domain/matchups/matchupGameProgressPolicy');
const { calculateExpandedTeamScore } = require('../../src/domain/matchups/expandedMatchupScoringPolicy');
const { emptyScoringStats, defaultScoringWeights } = require('../../src/domain/statistics/expandedScoringPolicy');

const ms = Date.parse;
function fixture() {
  const context = {
    matchup: { status: 'live', week_starts_at_ms: ms('2026-10-12T07:00Z'), week_ends_at_ms: ms('2026-10-19T07:00Z') },
    locks: ['home', 'away'].map(team_id => ({ id: team_id, team_id, legal: 1, lock_type: 'regular' })),
    lockedPlayers: [['h1', 'home', 'VAN', 'F', 1], ['scratch', 'home', 'VAN', 'F', 2], ['off', 'home', 'BOS', 'F', 3], ['pending', 'home', 'TOR', 'F', 4], ['a1', 'away', 'SEA', 'D', 1]]
      .map(([player_id, matchup_roster_lock_id, nhl_team_abbreviation, position_group, slot_number]) => ({ player_id, player_full_name: player_id, matchup_roster_lock_id, nhl_team_abbreviation, position_group, slot_number })),
    exclusions: [], playerGameObservations: [], expandedScoring: { playerGames: [] },
  };
  const games = [
    { id: 'yesterday', startsAtMs: ms('2026-10-15T06:59Z'), homeTeam: 'VAN', awayTeam: 'SEA', status: 'final' },
    { id: 'today', startsAtMs: ms('2026-10-16T02:00Z'), homeTeam: 'VAN', awayTeam: 'SEA', status: 'final' },
    { id: 'pending', startsAtMs: ms('2026-10-16T03:00Z'), homeTeam: 'TOR', awayTeam: 'MTL', status: 'live' },
    { id: 'tomorrow', startsAtMs: ms('2026-10-17T02:00Z'), homeTeam: 'BOS', awayTeam: 'MTL', status: 'scheduled' },
  ];
  for (const [playerId, nhlGameId, gamesPlayed, stats] of [
    ['h1', 'yesterday', 1, { evenStrengthGoals: 4 }], ['h1', 'today', 1, { evenStrengthGoals: 1 }],
    ['scratch', 'today', 0, {}], ['a1', 'today', 1, { hits: 2 }],
  ]) {
    context.playerGameObservations.push({ player_id: playerId, nhl_game_id: nhlGameId, nhl_game_scheduled_starts_at_ms: games.find(g => g.id === nhlGameId).startsAtMs, observed_game_state: 'final' });
    context.expandedScoring.playerGames.push({ playerId, nhlGameId, gamesPlayed, scoringStats: { ...emptyScoringStats(), ...stats } });
  }
  return { context, schedule: { games }, timeZone: 'America/Vancouver', asOfMs: ms('2026-10-16T04:00Z') };
}
function project(data) {
  const { context } = data;
  const currentPlayerGames = new Map(context.playerGameObservations.map(row => [`${row.player_id}\u0000${row.nhl_game_id}`, {
    playerId: row.player_id, nhlGameId: row.nhl_game_id, nhlGameScheduledStartsAtMs: row.nhl_game_scheduled_starts_at_ms, observedGameState: row.observed_game_state,
  }]));
  const scoring = Object.fromEntries(['home', 'away'].map(name => [name, calculateExpandedTeamScore({
    lock: context.locks.find(l => l.team_id === name), lockedPlayers: context.lockedPlayers.filter(p => p.matchup_roster_lock_id === name),
    currentPlayerGames, expandedPlayerGames: context.expandedScoring.playerGames, excludedPlayerGames: context.exclusions.filter(e => e.team_id === name),
    weekStartsAtMs: context.matchup.week_starts_at_ms, weekEndsAtMs: context.matchup.week_ends_at_ms, scoringRule: context.scoringRule,
  })]));
  const progress = calculateMatchupGameProgress({ ...data, scoring });
  return { weekly: scoring, day: calculateMatchupDay({ ...data, scoring, progress }) };
}

test('Day uses league-local game dates, accepted points, pending zeroes and no off-day players or scratches', () => {
  const data = fixture(), before = structuredClone(data);
  const { weekly, day } = project(data);
  assert.equal(day.date, '2026-10-15');
  assert.equal(weekly.home.scoreHundredths, 1500);
  assert.equal(day.home.scoreHundredths, 300);
  assert.equal(day.away.scoreHundredths, 70);
  assert.deepEqual(day.home.players.map(p => p.playerId), ['h1', 'pending']);
  assert.equal(day.home.players[0].gamesPlayedDelta, 1);
  assert.equal(day.home.players[1].scoreHundredths, 0);
  assert.deepEqual(data, before);
});

test('Day uses the league scoring rule, including negative points and defence weights', () => {
  const data = fixture();
  data.context.scoringRule = { version: 'custom', weights: defaultScoringWeights() };
  data.context.scoringRule.weights.D.hits = 80;
  data.context.expandedScoring.playerGames[1].scoringStats = { ...emptyScoringStats(), penaltiesTaken: 2 };
  const { day } = project(data);
  assert.equal(day.home.scoreHundredths, -40);
  assert.equal(day.away.scoreHundredths, 160);
});

test('sealed whole-game exclusions govern late locks, including eligible delayed starts', () => {
  const data = fixture();
  Object.assign(data.context.locks[0], { lock_type: 'late', locked_at_ms: ms('2026-10-16T02:05Z') });
  assert.equal(project(data).day.home.scoreHundredths, 300);
  data.context.exclusions.push({ team_id: 'home', player_id: 'h1', nhl_game_id: 'today' });
  const { day } = project(data);
  assert.equal(day.home.scoreHundredths, 0);
  assert.ok(!day.home.players.some(p => p.playerId === 'h1'));
});

test('unavailable schedules stay unavailable, illegal teams stay zero, and past weeks stay empty', () => {
  const data = fixture(); data.schedule = null;
  assert.equal(project(data).day.home.scoreHundredths, null);
  assert.equal(project(data).day.home.status, 'unavailable');
  data.context.locks[1].legal = 0;
  assert.deepEqual(project(data).day.away, { teamId: 'away', players: [], status: 'not_scoring', scoreHundredths: 0 });
  const past = fixture(); past.context.matchup.status = 'final'; past.asOfMs = ms('2026-10-20T04:00Z');
  assert.deepEqual(project(past).day.home.players, []);
  assert.equal(project(past).day.home.scoreHundredths, 0);
});

test('day rollover and different league timezones use the same accepted game start', () => {
  const data = fixture(); data.asOfMs = ms('2026-10-16T07:00Z');
  assert.equal(project(data).day.home.scoreHundredths, 0);
  data.timeZone = 'Asia/Tokyo'; data.asOfMs = ms('2026-10-16T04:00Z');
  assert.equal(project(data).day.date, '2026-10-16');
  assert.equal(project(data).day.home.scoreHundredths, 300);
});

test('postponements and half-open week boundaries never create Day points', () => {
  const data = fixture();
  data.schedule.games.find(g => g.id === 'pending').status = 'postponed';
  data.context.matchup.week_ends_at_ms = ms('2026-10-16T02:00Z');
  assert.equal(project(data).day.home.scoreHundredths, 0);
  assert.deepEqual(project(data).day.home.players, []);
});
