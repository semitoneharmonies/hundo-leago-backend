const test = require('node:test');
const assert = require('node:assert/strict');
const { createNhlPlayerAppearanceAdapter } = require('../../src/infrastructure/nhl/NhlPlayerAppearanceAdapter');

const identity = id => ({ externalIds: [{ provider: 'nhl', externalValue: String(id) }] });
const landing = { playerId: 8478402, isActive: true, currentTeamAbbrev: 'EDM', sweaterNumber: 97 };
const ok = (data = landing) => ({ ok: true, json: async () => data });

test('number and team use a verified NHL ID; concurrent requests share a bounded cached result', async () => {
  let calls = 0, now = 0;
  const adapter = createNhlPlayerAppearanceAdapter({ nowMs: () => now, cacheTtlMs: 100,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api-web.nhle.com/v1/player/8478402/landing');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return ok();
    } });
  const results = await Promise.all([adapter.read(identity(8478402)), adapter.read(identity(8478402))]);
  assert.deepEqual(results, [{ jerseyNumber: 97, nhlTeam: 'EDM' }, { jerseyNumber: 97, nhlTeam: 'EDM' }]);
  await adapter.read(identity(8478402)); assert.equal(calls, 1);
  now = 100; await adapter.read(identity(8478402)); assert.equal(calls, 2);
});

test('absent, ambiguous and malformed NHL mappings never request a guessed identity', async () => {
  const adapter = createNhlPlayerAppearanceAdapter({ fetchImpl: async () => { assert.fail('no fetch'); } });
  for (const input of [undefined, { externalIds: [{ provider: 'sportsdataio', externalValue: '8478402' }] },
    identity('../8478402'), identity('0'), identity('1?token=value'),
    { externalIds: [...identity(8478402).externalIds, ...identity(12345).externalIds] }]) {
    assert.equal(await adapter.read(input), null);
  }
});

test('wrong identity, inactive players, missing team and invalid numbers omit appearance', async () => {
  for (const change of [{ playerId: 123 }, { isActive: false }, { currentTeamAbbrev: null },
    { sweaterNumber: null }, { sweaterNumber: 0 }, { sweaterNumber: 100 }, { sweaterNumber: '97' }, { sweaterNumber: 9.7 }]) {
    const adapter = createNhlPlayerAppearanceAdapter({ fetchImpl: async () => ok({ ...landing, ...change }) });
    assert.equal(await adapter.read(identity(8478402)), null);
  }
});

test('provider errors are optional and negatively cached, then recover after expiry', async () => {
  for (const failure of [async () => { throw Error('offline'); }, async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw Error('invalid JSON'); } })]) {
    let calls = 0, now = 0;
    const adapter = createNhlPlayerAppearanceAdapter({ nowMs: () => now, unavailableTtlMs: 10,
      fetchImpl: (...args) => ++calls === 1 ? failure(...args) : ok() });
    assert.equal(await adapter.read(identity(8478402)), null);
    assert.equal(await adapter.read(identity(8478402)), null); assert.equal(calls, 1);
    now = 11;
    assert.deepEqual(await adapter.read(identity(8478402)), { jerseyNumber: 97, nhlTeam: 'EDM' });
  }
});

test('a stalled provider is aborted and concurrent work is limited without queuing cards', async () => {
  let calls = 0, signal;
  const adapter = createNhlPlayerAppearanceAdapter({ timeoutMs: 15, maxConcurrent: 1,
    fetchImpl: (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}); } });
  const stalled = adapter.read(identity(8478402));
  assert.equal(await adapter.read(identity(12345)), null);
  assert.equal(calls, 1);
  assert.equal(await stalled, null);
  assert.equal(signal.aborted, true);
});

test('appearance cache evicts old identities at its size limit', async () => {
  let calls = 0;
  const adapter = createNhlPlayerAppearanceAdapter({ maxEntries: 1, fetchImpl: async url => {
    calls++; return ok({ ...landing, playerId: Number(url.split('/').at(-2)) });
  } });
  await adapter.read(identity(8478402)); await adapter.read(identity(12345)); await adapter.read(identity(8478402));
  assert.equal(calls, 3);
});
