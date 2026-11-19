const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createNhlLiveGameAdapter } = require('../../src/infrastructure/nhl/NhlLiveGameAdapter');
const { createNhlLiveStatisticsService } = require('../../src/application/services/statistics/createNhlLiveStatisticsService');
const read = name => fs.readFileSync(path.join(__dirname, '../fixtures/nhl-live', `2026020344-${name}.json`), 'utf8');

test('adapter reads three bounded resources and returns normalized complete game data', async () => {
  const calls = [];
  const adapter = createNhlLiveGameAdapter({ fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return new Response(read(url.split('/').at(-1)), { headers: { 'Content-Type': 'application/json' } });
  } });
  const game = await adapter.readGame({ gameId: '2026020344' });
  assert.equal(game.playerGames.length, 36);
  assert.deepEqual(calls.map(u => u.split('/').at(-1)), ['play-by-play', 'boxscore', 'landing']);
});

test('pregame has no invented zero snapshot and needs no additional resources', async () => {
  let calls = 0;
  const adapter = createNhlLiveGameAdapter({ fetchImpl: async () => { calls++; return new Response(JSON.stringify({ gameState: 'PRE' })); } });
  assert.equal(await adapter.readGame({ gameId: '2026020344' }), null);
  assert.equal(calls, 1);
});

test('rate-limit retry-after pauses shared polling without clearing cached data', async () => {
  let now = Date.parse('2026-11-19T02:00:00Z'), calls = 0;
  const adapter = createNhlLiveGameAdapter({ nowMs: () => now, fetchImpl: async () => {
    calls++; return new Response('', { status: 429, headers: { 'Retry-After': '600' } });
  } });
  const service = createNhlLiveStatisticsService({ adapter, nhlSeasonKey: '20262027', clock: { nowMs: () => now },
    scheduleAdapter: { async readSchedule() { return { games: [{ id: '2026020344', nhlSeasonKey: '20262027', startsAtMs: now - 1000, status: 'live' }] }; } } });
  await service.job.run();
  now += 120_000; assert.equal((await service.job.run()).reason, 'not_due');
  assert.equal(calls, 1);
  now += 480_000; await service.job.run(); assert.equal(calls, 2);
});

test('malformed, oversize and mismatched game bodies fail without partial output', async () => {
  for (const body of ['not json', ' '.repeat(2_000_001)]) {
    const adapter = createNhlLiveGameAdapter({ fetchImpl: async () => new Response(body) });
    await assert.rejects(adapter.readGame({ gameId: '2026020344' }));
  }
  const adapter = createNhlLiveGameAdapter({ fetchImpl: async url => new Response(read(url.split('/').at(-1))) });
  await assert.rejects(adapter.readGame({ gameId: '2026020345' }), /identity/);
  await assert.rejects(adapter.readGame({ gameId: '../bad' }), /game ID/);
});
