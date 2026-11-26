const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRealtimeInjuryConfig } = require('../../src/config/loadRealtimeInjuryConfig');
const { dueRealtimeInjuryOccurrence } = require('../../src/domain/players/realtimeInjurySchedule');
const { createRefreshRealtimeInjuriesJob } = require('../../src/jobs/definitions/refreshRealtimeInjuries');
const { createTargetScheduler } = require('../../src/application/services/operations/createTargetScheduler');
const { createPlayerInjuryService } = require('../../src/application/services/players/createPlayerInjuryService');
const { injuryProjection } = require('../../src/domain/players/injuryStatusPolicy');
const DAY = Date.parse('2026-11-30T21:00:00Z');
function harness(overrides = {}) {
  let at = DAY;
  const calls = [], claims = new Set();
  const repository = {
    claim(value) { calls.push(['claim', value]); if (claims.has(value.occurrenceId)) return { status: 'skipped', reason: 'already_attempted' }; claims.add(value.occurrenceId); return { status: 'claimed', token: 'token' }; },
    listMappings: () => [], readIdentityCatalogue: () => [], registerMappings: rows => calls.push(['mappings', rows]),
    recoveryCandidates: () => [{ playerId: 'p', nhlPlayerId: '1', afterMs: 1 }],
    apply(snapshot, token, options) { calls.push(['apply', snapshot, token, options]); return { changed: 0, recovered: 0 }; },
    fail(token, code, options) { calls.push(['fail', token, code, options]); },
  };
  const adapter = { async fetchSnapshot() { calls.push(['fetch']); return { source: 'realtime', fetchedAtMs: at, rows: [] }; } };
  const logger = { error: (...args) => calls.push(['error', ...args]) };
  const job = createRefreshRealtimeInjuriesJob({ repository, adapter, clock: { nowMs: () => at }, logger, ...overrides });
  return { job, calls, repository, adapter, setNow: value => { at = value; } };
}
test('injury configuration defaults off and never changes existing data-provider settings', () => {
  const env = { NHL_COMPLETED_STATISTICS_ENABLED: 'true', NHL_LIVE_STATISTICS_ENABLED: 'true', SPORTSDATAIO_NHL_API_KEY: 'existing-secret' };
  assert.deepEqual(loadRealtimeInjuryConfig(env), { enabled: false, timeZone: 'Etc/GMT+8', monthlyRequestLimit: 100 });
  assert.equal(loadRealtimeInjuryConfig(env).apiKey, null);
  assert.equal(env.SPORTSDATAIO_NHL_API_KEY, 'existing-secret');
  const key = 'private-injury-key';
  assert.equal(loadRealtimeInjuryConfig({ REALTIME_INJURIES_ENABLED: 'true', REALTIME_INJURY_API_KEY: key }).apiKey, key);
  assert.equal(JSON.stringify(loadRealtimeInjuryConfig({ REALTIME_INJURIES_ENABLED: 'true', REALTIME_INJURY_API_KEY: key })).includes(key), false);
  for (const value of ['1', 'TRUE', 'yes']) assert.throws(() => loadRealtimeInjuryConfig({ REALTIME_INJURIES_ENABLED: value }), /REALTIME_INJURIES_ENABLED/);
  assert.throws(() => loadRealtimeInjuryConfig({ REALTIME_INJURIES_ENABLED: 'true', REALTIME_INJURY_API_KEY: 'private\nsecret' }), error => !error.message.includes('private'));
});
test('both requested slots are fixed to the user clock and Monday is three hours before the saved live lock', () => {
  const occurrence = dueRealtimeInjuryOccurrence(DAY);
  assert.equal(occurrence.time, '13:00');
  assert.equal(1796083200000 - occurrence.scheduledAtMs, 3 * 60 * 60_000);
  assert.equal(dueRealtimeInjuryOccurrence(Date.parse('2026-11-26T07:30:00Z')).time, '23:30');
  assert.equal(dueRealtimeInjuryOccurrence(Date.parse('2026-11-30T20:00:00Z')), null);
  assert.equal(dueRealtimeInjuryOccurrence(DAY + 30 * 60_000).scheduledAtMs, DAY);
  assert.equal(dueRealtimeInjuryOccurrence(DAY + 30 * 60_000 + 1), null);
  assert.equal(dueRealtimeInjuryOccurrence(Date.parse('2027-03-15T21:00:00Z')).time, '13:00');
});
test('off-slot work does nothing and duplicate occurrence cannot make another provider request', async () => {
  const h = harness(); h.setNow(DAY - 1);
  assert.equal((await h.job.run()).reason, 'not_due'); assert.equal(h.calls.length, 0);
  h.setNow(DAY); assert.equal((await h.job.run()).status, 'succeeded');
  assert.equal((await h.job.run()).reason, 'already_attempted');
  assert.deepEqual(h.calls.slice(0, 2).map(row => row[0]), ['claim', 'fetch']);
  assert.equal(h.calls.filter(row => row[0] === 'fetch').length, 1);
});
test('a provider failure cannot apply statuses and logs only the sanitized code', async () => {
  const secret = 'private-api-key-value';
  const h = harness({ adapter: { async fetchSnapshot() { throw new Error(secret); } } });
  const result = await h.job.run();
  assert.equal(result.status, 'failed');
  assert.equal(h.calls.some(row => row[0] === 'apply'), false);
  assert.equal(JSON.stringify({ result, calls: h.calls }).includes(secret), false);
});
test('unavailable recovery evidence preserves injury ingestion and never fabricates a recovery proof', async () => {
  const h = harness({ recoveryReader: { async read() { throw new Error('unavailable'); } } });
  assert.equal((await h.job.run()).status, 'succeeded');
  assert.deepEqual(h.calls.find(row => row[0] === 'apply')[3].recoveryProofs, {});
});
test('verified crosswalk seeds only present existing catalogue players and never creates players', async () => {
  const h = harness({ initialMappings: [
    { providerPlayerId: '1', nhlPlayerId: '11', providerName: 'Known Player', verifiedAtMs: DAY - 1 },
    { providerPlayerId: '2', nhlPlayerId: '22', providerName: 'Missing Player', verifiedAtMs: DAY - 1 },
  ] });
  h.repository.readIdentityCatalogue = () => [{ playerId: 'p', nhlPlayerId: '11', name: 'Known Player', active: true, position: 'F', teamAbbreviation: 'VAN' }];
  h.adapter.fetchSnapshot = async () => ({ source: 'realtime', fetchedAtMs: DAY, rows: [{ providerPlayerId: '1', name: 'Known Player' }, { providerPlayerId: '2', name: 'Missing Player' }] });
  await h.job.run();
  assert.deepEqual(h.calls.find(row => row[0] === 'mappings')[1].map(row => row.nhlPlayerId), ['11']);
});

test('injury provider waiting cannot block league jobs and scheduler shutdown waits for its own injury work', async () => {
  let release, injuryCalls = 0, leagueCalls = 0, closed = false;
  const wait = new Promise(resolve => { release = resolve; });
  const handles = [];
  const scheduler = createTargetScheduler({ enabled: true, emailEnabled: false, leagueWriteMode: 'open',
    jobs: [{ name: 'existing-league-job', runner: { async run() { leagueCalls++; return { status: 'succeeded' }; } } }],
    injuryJob: { async run() { injuryCalls++; await wait; return { status: 'succeeded' }; } },
    health: { setSchedulerState() {} }, logger: { error() {} },
    setIntervalFunction(callback) { const handle = { callback }; handles.push(handle); return handle; },
    clearIntervalFunction(handle) { handle.cleared = true; },
  });
  const start = scheduler.start();
  await start.initialRun;
  assert.equal(injuryCalls, 1);
  assert.equal((await scheduler.runInjuryCycle()).reason, 'overlap');
  await scheduler.runCycle(); assert.equal(leagueCalls, 2);
  const closing = scheduler.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await closing;
  assert.equal(handles.every(handle => handle.cleared), true);
  assert.equal((await scheduler.runInjuryCycle()).reason, 'not_running');
});
test('injury scheduler respects disabled and maintenance controls without affecting existing manual service', async () => {
  for (const options of [{ enabled: false, leagueWriteMode: 'open' }, { enabled: true, leagueWriteMode: 'closed' }]) {
    let calls = 0;
    const scheduler = createTargetScheduler({ ...options, emailEnabled: false,
      jobs: [{ name: 'existing', runner: { async run() {} } }], injuryJob: { async run() { calls++; } },
      health: { setSchedulerState() {} }, logger: { error() {} },
    });
    scheduler.start(); assert.equal((await scheduler.runInjuryCycle()).reason, 'not_running');
    await scheduler.close(); assert.equal(calls, 0);
  }
});
test('manual injury decisions keep their original repository while automatic health is read-only', () => {
  const playerId = '00000000-0000-4000-8000-000000000001';
  let decisions = 0, lists = 0;
  const manual = {
    list() { lists++; return { players: [{ id: playerId, source: 'realtime', observedAtMs: DAY, stale: false }], unmatched: [], history: ['preserved'], importsAvailable: false }; },
    decide(input) { decisions++; return input; },
  };
  const automatic = { state: () => ({ lastSuccessAtMs: DAY, errorCode: null }),
    listMappings: () => [{ providerPlayerId: '1', playerId }],
    listFeed: () => [{ id: '1', present: 1, classification: 'injured', medical_reason: 'Knee', designation: 'Out' }] };
  const service = createPlayerInjuryService({ repository: manual, automaticRepository: automatic, automaticEnabled: true,
    platformAuthorization: { requireAdministrator: () => ({ actorUserId: 'admin' }) }, nowMs: () => DAY + 16 * 3600_000 });
  const result = service.list({ authenticated: {} });
  assert.equal(result.sync.enabled, true); assert.equal(result.players[0].stale, true);
  assert.deepEqual(result.history, ['preserved']); assert.equal(decisions, 0); assert.equal(lists, 1);
  assert.equal(service.decide({ authenticated: {}, input: { playerId, status: 'healthy', expectedVersion: 0, reason: 'Manual review' } }).status, 'healthy');
  assert.equal(decisions, 1);
  assert.equal(injuryProjection({ status: 'injured', source: 'realtime', observed_at_ms: DAY }, DAY + 14 * 3600_000).stale, false);
  assert.equal(injuryProjection({ status: 'injured', source: 'realtime', observed_at_ms: DAY }, DAY + 16 * 3600_000).stale, true);
  assert.equal(injuryProjection({ status: 'injured', source: 'espn', observed_at_ms: DAY }, DAY + 7 * 3600_000).stale, true);
  const paused = createPlayerInjuryService({ repository: manual, automaticRepository: automatic, automaticEnabled: false,
    platformAuthorization: { requireAdministrator() {} }, nowMs: () => DAY + 16 * 3600_000 });
  const pausedResult = paused.list({ authenticated: {} });
  assert.equal(pausedResult.sync.enabled, false); assert.equal(pausedResult.players[0].stale, true);
});
