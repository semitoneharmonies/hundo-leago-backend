const test = require('node:test');
const assert = require('node:assert/strict');
const { ENDPOINT, createRealtimeInjuryAdapter, normalizeRealtimeInjurySnapshot } = require('../../src/infrastructure/realtime/RealtimeInjuryAdapter');
const { classifyRealtimeInjury, assessRealtimeRecovery, resolveRealtimeIdentityCandidates } = require('../../src/domain/players/realtimeInjuryPolicy');
const NOW = Date.parse('2026-11-26T04:00:00Z');
const fixture = (overrides = {}) => {
  const entry = { athlete: { id: '123', displayName: 'Synthetic Player', position: 'D' },
    team: { id: '4', displayName: 'Synthetic Team' }, status: 'Out', bodyPart: 'Illness',
    type: 'out', fantasyStatus: 'OUT', date: '2026-11-26T01:21Z', ...overrides };
  return { success: true, data: { count: 1, groups: [{ team: entry.team, injuries: [entry] }], injuries: [structuredClone(entry)] },
    meta: { rateLimit: { limit: 125, remaining: 120, reset: Date.parse('2026-12-01T00:00:00Z') } } };
};
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('adapter returns provider-owned identity, honest fetch time and normalized medical evidence', () => {
  const result = normalizeRealtimeInjurySnapshot(fixture(), NOW);
  assert.equal(result.source, 'realtime'); assert.equal(result.sourceGeneratedAtMs, null);
  assert.equal(result.fetchedAtMs, NOW); assert.equal(result.sourceCount, 1); assert.equal(result.teamCount, 1);
  assert.equal(result.rows[0].providerPlayerId, '123'); assert.equal(result.rows[0].status, 'injured');
  assert.equal(result.rows[0].medicalReason, 'Illness'); assert.equal(result.rows[0].classificationReason, 'ILLNESS');
  assert.ok(!('playerId' in result.rows[0])); assert.ok(!('nhlPlayerId' in result.rows[0]));
  assert.equal(result.quota.remaining, 120);
});

test('contract disputes, suspensions and personal reasons override IR or fantasy OUT', () => {
  for (const overrides of [{ status: 'Injured Reserve', fantasyStatus: 'IR-NR', bodyPart: 'Contract Dispute' },
    { status: 'Suspension', fantasyStatus: 'OUT', bodyPart: 'Suspension' },
    { bodyPart: 'Knee', statusType: 'Disciplinary' }, { bodyPart: 'Personal' }]) {
    assert.equal(normalizeRealtimeInjurySnapshot(fixture(overrides), NOW).rows[0].status, 'excluded');
  }
});

test('explicit undisclosed injury is medical, but unknown reason and status labels alone need review', () => {
  assert.equal(normalizeRealtimeInjurySnapshot(fixture({ bodyPart: 'Undisclosed' }), NOW).rows[0].status, 'injured');
  for (const bodyPart of [null, 'Unknown', 'Out', 'Injured Reserve']) {
    assert.equal(normalizeRealtimeInjurySnapshot(fixture({ status: 'Injured Reserve', bodyPart }), NOW).rows[0].status, 'review');
  }
  assert.equal(classifyRealtimeInjury({ status: 'injured', designation: 'Out', medicalReason: 'Contract Dispute' }).status, 'excluded');
});

test('empty, partial, duplicate, invalid date and potentially capped snapshots fail closed', () => {
  const invalid = [null, fixture({ date: null }), fixture({ date: '2026-02-30T00:00:00Z' }),
    fixture({ date: '2026-11-26T04:01:00Z' })];
  const empty = fixture(); empty.data = { count: 0, groups: [], injuries: [] }; invalid.push(empty);
  const count = fixture(); count.data.count = 2; invalid.push(count);
  const mismatch = fixture(); mismatch.data.injuries[0].bodyPart = 'Knee'; invalid.push(mismatch);
  const duplicate = fixture(); duplicate.data.groups[0].injuries.push(duplicate.data.groups[0].injuries[0]); duplicate.data.count = 2; invalid.push(duplicate);
  for (const body of invalid) assert.throws(() => normalizeRealtimeInjurySnapshot(body, NOW), { code: 'INJURY_FEED_INVALID' });
  const capped = fixture(); capped.data.groups[0].injuries = Array.from({ length: 25 }, (_, i) => ({ ...capped.data.injuries[0], athlete: { id: String(100 + i), displayName: `Synthetic ${i}` } }));
  assert.throws(() => normalizeRealtimeInjurySnapshot(capped, NOW), { code: 'INJURY_FEED_INCOMPLETE' });
});

test('one authenticated GET uses only the injuries endpoint, without retries or ancillary feeds', async () => {
  const calls = [];
  const adapter = createRealtimeInjuryAdapter({ apiKey: 'synthetic-key', nowMs: () => NOW,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(fixture()); } });
  await adapter.fetchSnapshot();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-key');
});

test('missing key, authentication failure, HTTP429 and body bounds are safe and explicit', async () => {
  await assert.rejects(createRealtimeInjuryAdapter({ fetchImpl: () => assert.fail('no request') }).fetchSnapshot(), { code: 'INJURY_API_KEY_MISSING' });
  for (const status of [401, 403]) {
    await assert.rejects(createRealtimeInjuryAdapter({ apiKey: 'secret', fetchImpl: async () => new Response('secret', { status }) }).fetchSnapshot(), { code: 'INJURY_FEED_AUTH_FAILED' });
  }
  await assert.rejects(createRealtimeInjuryAdapter({ apiKey: 'secret', nowMs: () => NOW,
    fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '3600' } }) }).fetchSnapshot(),
  { code: 'INJURY_FEED_RATE_LIMITED', retryAfterMs: 3600000 });
  await assert.rejects(createRealtimeInjuryAdapter({ apiKey: 'secret', maxResponseBytes: 1024,
    fetchImpl: async () => response({ data: 'a'.repeat(1200) }) }).fetchSnapshot(), { code: 'INJURY_FEED_TOO_LARGE' });
});

test('timeout covers hung fetch/body and error objects never retain secrets or upstream metadata', async () => {
  const secret = 'SYNTHETIC-DO-NOT-EXPOSE';
  for (const fetchImpl of [async () => { throw new Error(`upstream ${secret}`); },
    async () => { throw null; }, async () => { throw { code: 'INJURY_FEED_RATE_LIMITED', retryAfterMs: secret }; },
    async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }),
      { headers: { 'content-type': 'application/json' } })]) {
    const adapter = createRealtimeInjuryAdapter({ apiKey: secret, fetchImpl, timeoutMs: 100 });
    await assert.rejects(adapter.fetchSnapshot(), error => {
      assert.ok(['INJURY_FEED_UNAVAILABLE', 'INJURY_FEED_TIMEOUT'].includes(error.code));
      assert.ok(!error.message.includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
      assert.equal(error.cause, undefined); return true;
    });
  }
});

const recoveryInput = () => ({ present: false, absenceCount: 2, lastInjuryEvidenceAtMs: NOW - 300000,
  manualDecisionAtMs: NOW - 200000, nowMs: NOW,
  proof: { source: 'nhl', trusted: true, final: true, participated: true, gameId: '2026020001', occurredAtMs: NOW - 100000 } });

test('only two accepted absences plus newer trusted final NHL participation permit healthy', () => {
  const result = assessRealtimeRecovery(recoveryInput());
  assert.equal(result.status, 'healthy'); assert.equal(result.reason, 'POSITIVE_FINAL_GAME_PARTICIPATION');
  for (const patch of [{ present: true }, { present: undefined }, { absenceCount: 1 }, { absenceCount: 0 },
    { lastInjuryEvidenceAtMs: null }, { manualDecisionAtMs: NOW }, { manualDecisionAtMs: 'unknown' }]) {
    assert.equal(assessRealtimeRecovery({ ...recoveryInput(), ...patch }).status, null);
  }
});

test('absence, roster membership, nonfinal games, old or future participation cannot clear injury', () => {
  for (const patch of [{ source: 'espn' }, { trusted: false }, { final: false }, { participated: false },
    { occurredAtMs: NOW - 200000 }, { occurredAtMs: NOW + 1 }, { gameId: null }]) {
    const input = recoveryInput(); input.proof = { ...input.proof, ...patch };
    assert.equal(assessRealtimeRecovery(input).status, null);
  }
  assert.equal(assessRealtimeRecovery({ ...recoveryInput(), proof: null }).status, null);
  assert.equal(assessRealtimeRecovery({ ...recoveryInput(), proof: { activeRoster: true } }).status, null);
});

const identityInput = () => ({ snapshot: { source: 'realtime', fetchedAtMs: NOW,
  rows: [{ providerPlayerId: '123', name: 'Synthetic Player', team: 'Vancouver Canucks', position: 'C' }] },
  catalogue: [{ playerId: 'player-one', nhlPlayerId: '8470001', name: 'Synthetic Player',
    teamAbbreviation: 'VAN', position: 'F', active: true }], mappings: [], nowMs: NOW });

test('identity proposal requires unique full name, NHL team and compatible position without touching inputs', () => {
  const input = identityInput(), before = structuredClone(input);
  const result = resolveRealtimeIdentityCandidates(input);
  assert.equal(result.mappings.length, 1); assert.equal(result.pending.length, 0);
  assert.equal(result.mappings[0].nhlPlayerId, '8470001'); assert.equal(result.mappings[0].playerId, 'player-one');
  assert.equal(result.mappings[0].verificationMethod, 'unique_name_team_position');
  assert.equal(result.mappings[0].teamAbbreviation, 'VAN'); assert.equal(result.mappings[0].position, 'F');
  assert.deepEqual(input, before);
  const accent = identityInput(); accent.snapshot.rows[0].name = '  Synthétic   Player  ';
  assert.equal(resolveRealtimeIdentityCandidates(accent).mappings.length, 1);
  const goalie = identityInput(); goalie.snapshot.rows[0].position = 'G'; goalie.catalogue[0].position = 'G';
  assert.equal(resolveRealtimeIdentityCandidates(goalie).mappings.length, 1);
});

test('name alone, wrong team/position, missing catalogue and nickname guesses never establish identity', () => {
  for (const patch of [{ team: null }, { position: null }, { team: 'Seattle Kraken' }, { position: 'D' },
    { name: 'S. Player' }, { name: 'Synthetic Players' }, { team: 'Unknown Club' }]) {
    const input = identityInput(); Object.assign(input.snapshot.rows[0], patch);
    assert.equal(resolveRealtimeIdentityCandidates(input).mappings.length, 0);
  }
  for (const patch of [{ active: false }, { nhlPlayerId: null }, { playerId: null }, { position: 'G' }]) {
    const input = identityInput(); Object.assign(input.catalogue[0], patch);
    assert.equal(resolveRealtimeIdentityCandidates(input).mappings.length, 0);
  }
  const missing = identityInput(); missing.catalogue = [];
  assert.equal(resolveRealtimeIdentityCandidates(missing).mappings.length, 0);
});

test('duplicate feed/catalogue names and existing stable mappings cannot be silently reassigned', () => {
  const duplicateName = identityInput(); duplicateName.catalogue.push({ ...duplicateName.catalogue[0],
    playerId: 'player-two', nhlPlayerId: '8470002', position: 'D' });
  assert.equal(resolveRealtimeIdentityCandidates(duplicateName).mappings.length, 0);
  const duplicateFeed = identityInput(); duplicateFeed.snapshot.rows.push({ ...duplicateFeed.snapshot.rows[0], providerPlayerId: '456' });
  assert.equal(resolveRealtimeIdentityCandidates(duplicateFeed).mappings.length, 0);
  const existing = identityInput(); existing.mappings.push({ providerPlayerId: '123', nhlPlayerId: '8479999', playerId: 'prior-player' });
  assert.deepEqual(resolveRealtimeIdentityCandidates(existing), { mappings: [], pending: [] });
  const occupied = identityInput(); occupied.mappings.push({ providerPlayerId: '456', nhlPlayerId: '8470001', playerId: 'player-one' });
  assert.equal(resolveRealtimeIdentityCandidates(occupied).mappings.length, 0);
  const conflict = identityInput(); conflict.catalogue.push({ ...conflict.catalogue[0], name: 'Other Player' });
  assert.equal(resolveRealtimeIdentityCandidates(conflict).mappings.length, 0);
});
