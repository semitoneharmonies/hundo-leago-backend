const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { createMatchupLiveDisplayService } = require('../../src/application/services/matchups/createMatchupLiveDisplayService');
const { createMatchupIntegrationService } = require('../../src/application/services/matchups/createMatchupIntegrationService');
const { calculateExpandedTeamScore } = require('../../src/domain/matchups/expandedMatchupScoringPolicy');
const { emptyScoringStats, defaultScoringWeights } = require('../../src/domain/statistics/expandedScoringPolicy');

const ms = Date.parse;
const start = ms('2026-11-16T08:00:00Z');
const gameStart = ms('2026-11-19T03:00:00Z');
const end = ms('2026-11-23T08:00:00Z');
function game(stats = { hits: 2 }, overrides = {}) {
  return { gameId: 'live-game', startsAtMs: gameStart, state: 'live', updatedAtMs: gameStart + 1000,
    playerGames: [{ providerPlayerId: '8', providerTeamId: '22', positionGroup: 'F', gamesPlayed: 1,
      scoringStats: { ...emptyScoringStats(), ...stats } }], ...overrides };
}
function fixture() {
  const context = {
    matchup: { id: 'matchup', status: 'live', week_starts_at_ms: start, week_ends_at_ms: end },
    refresh: { id: 'accepted-refresh', provider: 'nhl-completed-games' }, scoringRule: null,
    locks: ['home', 'away'].map(team_id => ({ id: `${team_id}-lock`, team_id, legal: 1 })),
    lockedPlayers: [{ player_id: 'player', player_full_name: 'Player', matchup_roster_lock_id: 'home-lock',
      position_group: 'D', slot_number: 1, nhl_team_abbreviation: 'VAN' }],
    playerGameCoverage: [{ player_id: 'player', provider_player_id: '8', provider_team_id: '22', disposition: 'no_due_game' }],
    playerGameObservations: [], expandedScoring: { playerGames: [] }, exclusions: [],
  };
  let snapshot = { enabled: true, status: 'available', updatedAtMs: gameStart + 1000, lastAttemptAtMs: gameStart + 1000, games: [game()] };
  const repository = { readContext: () => context };
  const service = createMatchupLiveDisplayService({ repository, liveStatistics: { readSnapshot: () => snapshot } });
  const official = () => {
    const currentPlayerGames = new Map(context.playerGameObservations.map(row => [`${row.player_id}\u0000${row.nhl_game_id}`, {
      playerId: row.player_id, nhlGameId: row.nhl_game_id, observedGameState: row.observed_game_state,
      nhlGameScheduledStartsAtMs: row.nhl_game_scheduled_starts_at_ms,
    }]));
    const side = name => calculateExpandedTeamScore({ lock: context.locks.find(row => row.team_id === name),
      lockedPlayers: context.lockedPlayers.filter(row => row.matchup_roster_lock_id === `${name}-lock`),
      currentPlayerGames, expandedPlayerGames: context.expandedScoring.playerGames,
      excludedPlayerGames: context.exclusions.filter(row => row.team_id === name),
      weekStartsAtMs: start, weekEndsAtMs: end, scoringRule: context.scoringRule });
    return { source: { refreshId: context.refresh.id, provider: context.refresh.provider }, home: side('home'), away: side('away') };
  };
  return { context, service, repository, official, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; } };
}

test('live overlay uses accepted identity and locked position while preserving official input', () => {
  const f = fixture(), scoring = f.official(), before = structuredClone({ context: f.context, scoring, snapshot: f.snapshot });
  const displayed = f.service.read({}, scoring);
  assert.equal(displayed.home.scoreHundredths, 70);
  assert.equal(displayed.home.players[0].positionGroup, 'D');
  assert.equal(displayed.home.players[0].scoringStats.hits, 2);
  assert.equal(displayed.home.players[0].gamesPlayedDelta, 0, 'only official participation is collected');
  assert.equal(displayed.home.players[0].live.officialScoreHundredths, 0);
  assert.deepEqual(displayed.source.live.gameIds, ['live-game']);
  assert.equal(displayed.source.live.status, 'fresh');
  assert.deepEqual({ context: f.context, scoring, snapshot: f.snapshot }, before);
});

test('repeated and corrected snapshots replace contributions instead of adding them again', () => {
  const f = fixture();
  for (let i = 0; i < 5; i += 1) assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 70);
  f.snapshot.games = [game({ hits: 3 }, { updatedAtMs: gameStart + 2000 })];
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 105);
  f.snapshot.games = [game({ penaltiesTaken: 2 }, { updatedAtMs: gameStart + 3000 })];
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, -40);
});

test('duplicate game entries use the newest complete snapshot once and reject conflicting equal timestamps', () => {
  const f = fixture();
  f.snapshot.games = [game(), game(), game({ hits: 4 }, { updatedAtMs: gameStart + 2000 })];
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 140);
  assert.equal(f.service.read({}, f.official()).source.live.provisionalGameCount, 1);
  f.snapshot.games = [game(), game({ hits: 4 })];
  const displayed = f.service.read({}, f.official());
  assert.equal(displayed.home.scoreHundredths, 0);
  assert.equal(displayed.source.live.status, 'unavailable');
});

test('scoreboard final remains provisional until accepted official game evidence replaces it', () => {
  const f = fixture();
  f.snapshot.games[0].state = 'final';
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 70);
  f.context.playerGameObservations.push({ player_id: 'player', nhl_game_id: 'live-game',
    nhl_game_scheduled_starts_at_ms: gameStart, observed_game_state: 'final' });
  f.context.expandedScoring.playerGames.push({ playerId: 'player', nhlGameId: 'live-game', gamesPlayed: 1,
    scoringStats: { ...emptyScoringStats(), hits: 1 } });
  const displayed = f.service.read({}, f.official());
  assert.equal(displayed.home.scoreHundredths, 35);
  assert.equal(displayed.source.live.provisionalGameCount, 0);
  assert.equal(displayed.home.players[0].gamesPlayedDelta, 1);
});

test('illegal locks, excluded whole games, bench players and half-open week boundaries cannot earn live points', () => {
  const f = fixture();
  f.context.locks[0].legal = 0;
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 0);
  f.context.locks[0].legal = 1;
  f.context.exclusions.push({ team_id: 'home', player_id: 'player', nhl_game_id: 'live-game' });
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 0);
  f.context.exclusions = [];
  f.snapshot.games = [game({}, { startsAtMs: start - 1 }), game({}, { gameId: 'next-week', startsAtMs: end }),
    game({}, { gameId: 'bench', playerGames: [{ ...game().playerGames[0], providerPlayerId: '999' }] })];
  assert.equal(f.service.read({}, f.official()).source.live.provisionalGameCount, 0);
});

test('delayed pre-game start before a late lock remains eligible unless sealed exclusions reject it', () => {
  const f = fixture();
  Object.assign(f.context.locks[0], { lock_type: 'late', locked_at_ms: gameStart + 5000 });
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 70);
  f.context.exclusions.push({ team_id: 'home', player_id: 'player', nhl_game_id: 'live-game' });
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 0);
});

test('custom league weights and negative categories remain authoritative for live display', () => {
  const f = fixture();
  f.context.scoringRule = { version: 'custom', weights: defaultScoringWeights() };
  f.context.scoringRule.weights.D.hits = 90;
  f.snapshot.games = [game({ hits: 2, penaltiesTaken: 1, giveaways: 2 })];
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 140);
  assert.equal(f.service.read({}, f.official()).home.players[0].scoringRuleVersion, 'custom');
});

test('disabled, final, unavailable, mismatched refresh and invalid category data preserve official scores', () => {
  const f = fixture();
  f.snapshot.enabled = false;
  let scoring = f.official();
  assert.equal(f.service.read({}, scoring), scoring);
  f.snapshot.enabled = true;
  f.context.matchup.status = 'final';
  assert.equal(f.service.read({}, scoring), scoring);
  f.context.matchup.status = 'live';
  scoring = { ...scoring, source: { refreshId: 'older' } };
  assert.equal(f.service.read({}, scoring), scoring);
  f.snapshot.status = 'unavailable';
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 0);
  f.snapshot.status = 'stale';
  assert.equal(f.service.read({}, f.official()).home.scoreHundredths, 70);
  assert.equal(f.service.read({}, f.official()).source.live.status, 'stale');
  delete f.snapshot.games[0].playerGames[0].scoringStats.penaltiesDrawn;
  assert.equal(f.service.read({}, f.official()).source.live.status, 'unavailable');
});

test('ambiguous local identity and duplicated NHL player rows cannot misattribute live points', () => {
  const f = fixture();
  f.context.playerGameCoverage.push({ player_id: 'player', provider_player_id: '9' });
  assert.equal(f.service.read({}, f.official()).source.live.status, 'unavailable');
  f.context.playerGameCoverage.pop();
  f.snapshot.games[0].playerGames.push(structuredClone(f.snapshot.games[0].playerGames[0]));
  assert.equal(f.service.read({}, f.official()).source.live.status, 'unavailable');
});

test('Day adds live participants and scopes provisional labels to the selected league-local date', () => {
  const f = fixture();
  const day = { date: '2026-11-18', timeZone: 'America/Vancouver',
    home: { teamId: 'home', status: 'available', scoreHundredths: 0, players: [] },
    away: { teamId: 'away', status: 'available', scoreHundredths: 0, players: [] } };
  const project = item => f.service.projectDay({ context: f.context, scoring: f.official(), day: item, timeZone: day.timeZone });
  assert.equal(project(day).home.scoreHundredths, 70);
  assert.equal(project(day).home.players[0].playerId, 'player');
  assert.equal(project(day).live.provisionalGameCount, 1);
  assert.equal(project({ ...day, date: '2026-11-17' }).live.provisionalGameCount, 0);
  assert.equal(project({ ...day, date: '2026-11-19' }).home.scoreHundredths, 0);
  f.context.matchup.status = 'final';
  assert.equal(project(day), day);
});

test('display read uses only cached data and leaves isolated SQLite values and official score unchanged', t => {
  const f = fixture(), database = new Database(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE preserved (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  database.prepare('INSERT INTO preserved VALUES (?, ?)').run('context', JSON.stringify(f.context));
  const before = database.serialize();
  const service = createMatchupLiveDisplayService({ repository: { readContext() {
    return JSON.parse(database.prepare('SELECT payload FROM preserved WHERE id = ?').get('context').payload);
  } }, liveStatistics: { readSnapshot: () => f.snapshot } });
  for (let i = 0; i < 16; i += 1) assert.equal(service.read({}, f.official()).home.scoreHundredths, 70);
  assert.deepEqual(database.serialize(), before);
  assert.equal(f.official().home.scoreHundredths, 0);
});

test('matchup read exposes live source metadata, while finalized matchup reads bypass the overlay', () => {
  const f = fixture();
  let status = 'live', overlays = 0;
  const noop = () => {};
  const service = createMatchupIntegrationService({
    leagueAuthorization: { requireActiveMembership: noop, requireCommissioner: noop },
    readRepository: { readSchedule: noop, readCurrentWeek: noop, readWeek: noop, readResultScope: noop,
      readMatchup: () => ({ matchup: { id: 'matchup', status }, result: { result_source_refresh_id: 'accepted-refresh' } }) },
    scheduleService: { preview: noop, generate: noop, shiftWeekOne: noop }, weekService: { advance: noop },
    scoringService: { readLive: () => f.official(), readAtRefresh: () => f.official() },
    resultCorrectionService: { correct: noop }, standingsService: { previewCorrection: noop, read: noop },
    recoveryService: { previewStandings: noop, rebuildStandings: noop },
    liveDisplayService: { read(input, score) { overlays += 1; return f.service.read(input, score); } },
    statisticsProviders: ['nhl-completed-games'], clock: { nowMs: () => gameStart }, createId: () => 'id',
  });
  const displayed = service.readMatchup({ authenticated: {}, leagueId: 'league' }).matchup;
  assert.equal(displayed.scoring.home.scoreHundredths, 70);
  assert.equal(displayed.scoring.source.live.status, 'fresh');
  status = 'final';
  const final = service.readMatchup({ authenticated: {}, leagueId: 'league' }).matchup;
  assert.equal(overlays, 1);
  assert.equal(final.scoring.home.scoreHundredths, 0);
  assert.equal(final.scoring.source, undefined);
});
