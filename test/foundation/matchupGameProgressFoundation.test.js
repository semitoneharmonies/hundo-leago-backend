const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { calculateMatchupGameProgress } = require('../../src/domain/matchups/matchupGameProgressPolicy');
const { createMatchupGameProgressService } = require('../../src/application/services/matchups/createMatchupGameProgressService');
const { createMatchupRouter } = require('../../src/transport/http/createMatchupRouter');
const { selectTargetRouterKey } = require('../../src/bootstrap/createTargetRuntime');

function fixture() {
  return {
    context: {
      matchup: { status: 'live', week_starts_at_ms: 100, week_ends_at_ms: 800 },
      locks: [{ id: 'lh', team_id: 'home', lock_type: 'regular' }, { id: 'la', team_id: 'away', lock_type: 'regular' }],
      lockedPlayers: [
        { player_id: 'h1', matchup_roster_lock_id: 'lh', nhl_team_abbreviation: 'VAN' },
        { player_id: 'h2', matchup_roster_lock_id: 'lh', nhl_team_abbreviation: 'VAN' },
        { player_id: 'a1', matchup_roster_lock_id: 'la', nhl_team_abbreviation: 'SEA' },
      ],
      playerGameObservations: ['h1', 'h2', 'a1'].map(player_id => ({ player_id, nhl_game_id: 'accepted', observed_game_state: 'final' })),
      exclusions: [],
    },
    scoring: {
      home: { teamId: 'home', legal: true, players: [{ gamesPlayedDelta: 1 }, { gamesPlayedDelta: 0 }] },
      away: { teamId: 'away', legal: true, players: [{ gamesPlayedDelta: 1 }] },
    },
    schedule: { games: [
      { id: 'accepted', startsAtMs: 100, status: 'final', homeTeam: 'VAN', awayTeam: 'SEA' },
      { id: 'finished-pending', startsAtMs: 200, status: 'final', homeTeam: 'VAN', awayTeam: 'SEA' },
      { id: 'future', startsAtMs: 700, status: 'scheduled', homeTeam: 'VAN', awayTeam: 'SEA' },
    ] },
  };
}

test('counts player-games, accepted participation and pending final scores independently for each lineup', () => {
  const data = fixture(), before = structuredClone(data);
  const result = calculateMatchupGameProgress(data);
  assert.deepEqual(result.home, { teamId: 'home', status: 'available', tallied: 1, remaining: 4, total: 5 });
  assert.deepEqual(result.away, { teamId: 'away', status: 'available', tallied: 1, remaining: 2, total: 3 });
  // h2's accepted scratch contributes neither a tallied nor a pending game.
  assert.deepEqual(data, before);
});

test('honors half-open dates, late locks, sealed exclusions and postponed/cancelled games', () => {
  const data = fixture();
  data.context.locks[0] = { id: 'lh', team_id: 'home', lock_type: 'late', locked_at_ms: 200 };
  data.context.exclusions.push({ team_id: 'home', player_id: 'h1', nhl_game_id: 'finished-pending' });
  for (const [id, startsAtMs, status] of [['before', 99, 'scheduled'], ['next-week', 800, 'scheduled'], ['postponed', 300, 'postponed'], ['cancelled', 400, 'cancelled']]) {
    data.schedule.games.push({ id, startsAtMs, status, homeTeam: 'VAN', awayTeam: 'SEA' });
  }
  assert.equal(calculateMatchupGameProgress(data).home.remaining, 3);
  assert.equal(calculateMatchupGameProgress(data).away.remaining, 2);
});

test('detail lists reconcile GR and retain collected appearances while excluding confirmed scratches', () => {
  const data = fixture();
  data.timeZone = 'America/Vancouver'; data.asOfMs = 300;
  data.context.lockedPlayers.forEach(player => { player.player_full_name = player.player_id; });
  data.context.expandedScoring = { playerGames: ['h1', 'a1'].map(playerId => ({ playerId, nhlGameId: 'accepted', gamesPlayed: 1 })) };
  const live = calculateMatchupGameProgress(data);
  assert.equal(live.home.details.timeZone, data.timeZone);
  assert.equal(live.home.details.asOfMs, 300);
  assert.equal(live.home.details.games.filter(game => game.status !== 'collected').length, live.home.remaining);
  assert.deepEqual(live.home.details.games.filter(game => game.status === 'collected').map(game => game.playerId), ['h1']);
  assert.equal(live.home.details.games.find(game => game.gameId === 'finished-pending').status, 'awaiting_scoring');
  assert.ok(live.home.details.games.every(game => game.opponent === 'SEA' && game.isHome));
  data.context.matchup.status = 'final';
  const final = calculateMatchupGameProgress(data).home;
  assert.equal(final.remaining, 0);
  assert.deepEqual(final.details.games.map(game => game.status), ['collected']);
});

test('known non-final observations remain pending and accepted historical-team games resolve', () => {
  const data = fixture();
  data.context.lockedPlayers[0].nhl_team_abbreviation = 'BOS';
  data.context.playerGameObservations.push({ player_id: 'h1', nhl_game_id: 'finished-pending', observed_game_state: 'live' });
  assert.equal(calculateMatchupGameProgress(data).home.remaining, 3);
});

test('unavailable schedule or team preserves tallied count without claiming zero remaining', () => {
  const data = fixture();
  data.schedule = null;
  assert.deepEqual(calculateMatchupGameProgress(data).home, { teamId: 'home', status: 'schedule_unavailable', tallied: 1, remaining: null, total: null });
  data.schedule = fixture().schedule;
  data.context.lockedPlayers[0].nhl_team_abbreviation = null;
  assert.equal(calculateMatchupGameProgress(data).home.status, 'team_unavailable');
  assert.equal(calculateMatchupGameProgress(data).away.remaining, 2);
});

test('official final counts do not depend on current team or schedule; illegal lineups do not score', () => {
  const data = fixture();
  data.context.matchup.status = 'final'; data.schedule = null;
  data.context.lockedPlayers[0].nhl_team_abbreviation = null;
  data.scoring.away.legal = false;
  const result = calculateMatchupGameProgress(data);
  assert.deepEqual(result.home, { teamId: 'home', status: 'complete', tallied: 1, remaining: 0, total: 1 });
  assert.deepEqual(result.away, { teamId: 'away', status: 'not_scoring', tallied: 0, remaining: 0, total: 0 });
});

test('membership is required before repository or schedule access, and missing matchups fail closed', async () => {
  let reads = 0;
  const dependencies = {
    leagueAuthorization: { requireActiveMembership(auth) { if (auth !== 'member') throw Object.assign(new Error('private'), { code: 'LEAGUE_NOT_FOUND' }); } },
    readRepository: { readMatchup() { reads++; return null; } },
    scheduleAdapter: { readSchedule() { assert.fail('provider must not be called'); } },
  };
  const service = createMatchupGameProgressService(dependencies);
  await assert.rejects(service.read({ authenticated: 'outsider' }), { code: 'LEAGUE_NOT_FOUND' });
  assert.equal(reads, 0);
  await assert.rejects(service.read({ authenticated: 'member' }), { code: 'MATCHUP_INTEGRATION_MATCHUP_MISSING' });
  assert.equal(reads, 1);
});

test('unlocked matchups and missing final scoring sources return unknown rather than fabricated totals', async () => {
  for (const status of ['scheduled', 'final']) {
    const service = createMatchupGameProgressService({
      leagueAuthorization: { requireActiveMembership() {} },
      readRepository: { readMatchup: () => ({ matchup: { status, home_team_id: 'home', away_team_id: 'away' } }) },
    });
    const result = await service.read({ leagueId: 'league' });
    assert.equal(result.home.tallied, null);
    assert.equal(result.home.remaining, null);
    assert.equal(result.home.status, status === 'final' ? 'scoring_unavailable' : 'not_started');
  }
});

test('GET route requires authentication, passes exact scope, is no-store, and sanitizes errors', async () => {
  const pass = (req, res, next) => next();
  const security = Object.fromEntries(['assignRequestId', 'authenticateUnsafe', 'credentialedCors', 'requireAllowedOrigin', 'requireCompatibleFetchMetadata', 'requireJson', 'securityHeaders'].map(name => [name, pass]));
  Object.assign(security, { authenticateBootstrap(req, res, next) { if (req.get('x-test-auth') !== 'yes') return res.sendStatus(401); next(); }, getRequestId: () => 'test', getSessionBootstrap: () => ({ userId: 'member' }), getAuthenticatedSession: () => ({ userId: 'member' }) });
  const matchupService = Object.fromEntries(['correctResult', 'generateSchedule', 'listWeeks', 'readCurrentWeek', 'readMatchup', 'readStandings', 'readWeek', 'rebuildStandings', 'transitionWeek'].map(key => [key, () => ({})]));
  let calls = 0, failure = false;
  const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
  const app = express();
  app.use(createMatchupRouter({ requestSecurity: security, matchupService, auditPrivacyDigest: { digest() {} }, matchupGameProgressService: { async read(input) {
    calls++;
    assert.deepEqual([input.leagueId, input.seasonId, input.weekId, input.matchupId], [1,2,3,4].map(id));
    assert.deepEqual(input.authenticated, { userId: 'member' });
    if (failure) throw new Error('private database details');
    return { code: 'MATCHUP_GAME_PROGRESS_FOUND' };
  } } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const path = `/api/v1/leagues/${id(1)}/seasons/${id(2)}/matchup-weeks/${id(3)}/matchups/${id(4)}/game-progress`;
    assert.equal(selectTargetRouterKey('GET', path), 'matchup');
    const url = `http://127.0.0.1:${server.address().port}${path}`;
    assert.equal((await fetch(url)).status, 401); assert.equal(calls, 0);
    const result = await fetch(url, { headers: { 'x-test-auth': 'yes' } });
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).data.code, 'MATCHUP_GAME_PROGRESS_FOUND');
    failure = true;
    const failed = await fetch(url, { headers: { 'x-test-auth': 'yes' } });
    assert.equal(failed.status, 500); assert.doesNotMatch(await failed.text(), /private database/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
