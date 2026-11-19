const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: yieldEventLoop } = require('node:timers/promises');
const { createNhlLiveStatisticsService } = require('../../src/application/services/statistics/createNhlLiveStatisticsService');
const { emptyScoringStats } = require('../../src/domain/statistics/expandedScoringPolicy');
const NOW = Date.parse('2026-11-19T02:00:00Z');
const season = '20262027';
function fixture(count = 1) {
  let now = NOW, calls = 0, scheduleCalls = 0, error = false, scheduleError = false, goals = 1, state = 'live', active = 0, maximumActive = 0;
  const schedule = Array.from({ length: count }, (_, i) => ({ id: String(2026020344 + i), nhlSeasonKey: season, startsAtMs: NOW - 3_600_000, status: 'live', timeTbd: false }));
  const service = createNhlLiveStatisticsService({ nhlSeasonKey: season, clock: { nowMs: () => now }, logger: { error() {} },
    scheduleAdapter: { async readSchedule() { scheduleCalls++; if (scheduleError) throw new Error('schedule offline'); return { games: schedule }; } },
    adapter: { async readGame({ gameId }) {
      calls++; active++; maximumActive = Math.max(maximumActive, active);
      try {
        await yieldEventLoop();
        if (error) throw new Error('temporary failure');
        return { gameId, nhlSeasonKey: season, startsAtMs: schedule.find(g => g.id === gameId).startsAtMs, state,
          playerGames: [{ providerPlayerId: '8478402', providerTeamId: '10', positionGroup: 'F', gamesPlayed: 1,
            scoringStats: { ...emptyScoringStats(), evenStrengthGoals: goals } }] };
      } finally { active--; }
    } },
  });
  return { service, schedule, setNow(value) { now = value; }, setError(value) { error = value; }, setScheduleError(value) { scheduleError = value; }, setGoals(value) { goals = value; }, setState(value) { state = value; },
    stats: () => ({ calls, scheduleCalls, maximumActive }) };
}

test('only the scheduled job fetches; repeated reads and early polls are inert', async () => {
  const f = fixture();
  assert.equal(f.service.readSnapshot().status, 'unavailable');
  for (let i = 0; i < 100; i++) f.service.readSnapshot();
  assert.equal(f.stats().calls, 0);
  await f.service.job.run();
  assert.equal(f.stats().calls, 1);
  assert.equal((await f.service.job.run()).reason, 'not_due');
  f.setNow(NOW + 119_999); await f.service.job.run();
  assert.equal(f.stats().calls, 1);
  f.setNow(NOW + 120_000); await f.service.job.run();
  assert.equal(f.stats().calls, 2);
});

test('corrected snapshots replace counts rather than accumulating repeated points', async () => {
  const f = fixture(); await f.service.job.run();
  f.setGoals(3); f.setNow(NOW + 120_000); await f.service.job.run();
  f.setGoals(2); f.setNow(NOW + 240_000); await f.service.job.run();
  const snapshot = f.service.readSnapshot();
  assert.equal(snapshot.games.length, 1);
  assert.equal(snapshot.games[0].playerGames[0].scoringStats.evenStrengthGoals, 2);
  assert.ok(Object.isFrozen(snapshot.games[0].playerGames[0].scoringStats));
});

test('failed updates retain the last valid score and identify stale data', async () => {
  const f = fixture(); await f.service.job.run();
  f.setError(true); f.setNow(NOW + 120_000);
  const result = await f.service.job.run();
  assert.equal(result.liveStatus, 'partial');
  assert.equal(f.service.readSnapshot().status, 'stale');
  assert.equal(f.service.readSnapshot().games[0].playerGames[0].scoringStats.evenStrengthGoals, 1);
  f.setError(false); f.setNow(NOW + 240_000); await f.service.job.run();
  assert.equal(f.service.readSnapshot().status, 'available');
  f.setNow(NOW + 600_001); assert.equal(f.service.readSnapshot().status, 'stale');
});

test('16 active games share one cache with at most two concurrent game fetches', async () => {
  const f = fixture(16);
  const first = f.service.job.run();
  assert.equal((await f.service.job.run()).reason, 'overlap');
  const result = await first;
  assert.equal(result.fetchedGames, 16);
  assert.equal(f.stats().maximumActive, 2);
  assert.equal(f.stats().scheduleCalls, 1);
  assert.equal(f.service.readSnapshot().games.length, 16);
});

test('final game snapshots remain available without repeatedly polling finished games', async () => {
  const f = fixture(); f.setState('final'); await f.service.job.run();
  f.setNow(NOW + 120_000); await f.service.job.run();
  assert.equal(f.stats().calls, 1);
  assert.equal(f.service.readSnapshot().games[0].state, 'final');
  f.setNow(NOW + 8 * 86_400_000); await f.service.job.run();
  assert.equal(f.service.readSnapshot().games.length, 0);
});

test('future and cancelled games do not fetch; cancellation retires a cached snapshot', async () => {
  const f = fixture(); f.schedule[0].startsAtMs = NOW + 60_000;
  await f.service.job.run(); assert.equal(f.stats().calls, 0);
  f.setNow(NOW + 60_000); await f.service.job.run(); assert.equal(f.stats().calls, 1);
  f.schedule[0].status = 'cancelled'; f.setNow(NOW + 180_000); await f.service.job.run();
  assert.equal(f.stats().calls, 1); assert.equal(f.service.readSnapshot().games.length, 0);
});

test('schedule failure is contained and never clears last valid game snapshots', async () => {
  const f = fixture(); await f.service.job.run();
  f.setNow(NOW + 120_000); f.setScheduleError(true);
  assert.equal((await f.service.job.run()).liveStatus, 'unavailable');
  assert.equal(f.service.readSnapshot().status, 'stale');
  assert.equal(f.service.readSnapshot().games.length, 1);
  assert.equal(f.stats().calls, 1);
});

test('slow failed games cannot repeatedly consume the poll budget and starve other games', async () => {
  let now = NOW;
  const attempted = [];
  const games = Array.from({ length: 16 }, (_, i) => ({ id: String(2026020344 + i), nhlSeasonKey: season, startsAtMs: NOW - 1000, status: 'live' }));
  const service = createNhlLiveStatisticsService({ nhlSeasonKey: season, clock: { nowMs: () => now },
    scheduleAdapter: { async readSchedule() { return { games }; } },
    adapter: { async readGame({ gameId }) { attempted.push(gameId); now += 20_000; await yieldEventLoop(); throw new Error('slow feed'); } } });
  for (let i = 0; i < 8; i++) { await service.job.run(); now += 120_000; }
  assert.equal(new Set(attempted.slice(0, 16)).size, 16);
  assert.equal(service.readSnapshot().status, 'unavailable');
});
