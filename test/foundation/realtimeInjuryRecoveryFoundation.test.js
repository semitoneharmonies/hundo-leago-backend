const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: yieldToEventLoop } = require('node:timers/promises');
const Database = require('better-sqlite3');
const { prepareGameRecord } = require('../../src/domain/statistics/sharedGameEvidencePolicy');
const { createSqliteInjuryRecoveryReader } = require('../../src/infrastructure/persistence/sqlite/SqliteInjuryRecoveryReader');

const NOW = Date.parse('2026-11-26T04:00:00Z');
const SEASON = '20262027';
const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const SOURCE = uuid(9001);
const candidate = (n = 1, patch = {}) => ({ playerId: uuid(n), nhlPlayerId: String(8400000 + n), afterMs: NOW - 100000, ...patch });

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  // The read contract uses these production columns and covering key. Omit
  // immutability triggers deliberately so tests can simulate corrupt storage.
  db.exec(`CREATE TABLE stat_sources(id TEXT PRIMARY KEY,provider TEXT,status TEXT);
    CREATE TABLE stat_refreshes(id TEXT PRIMARY KEY,stat_source_id TEXT,nhl_season_key TEXT,status TEXT,completed_at_ms INTEGER);
    CREATE TABLE shared_game_evidence_captures(refresh_id TEXT PRIMARY KEY,stat_source_id TEXT,nhl_season_key TEXT,
      revision INTEGER,observed_at_ms INTEGER,captured_at_ms INTEGER,sealed INTEGER,
      UNIQUE(stat_source_id,nhl_season_key,revision));
    CREATE TABLE shared_game_evidence_changes(stat_source_id TEXT,nhl_season_key TEXT,player_id TEXT,nhl_game_id TEXT,
      revision INTEGER,payload_json TEXT,payload_sha256 TEXT,
      UNIQUE(stat_source_id,nhl_season_key,player_id,nhl_game_id,revision));
    CREATE TABLE protected_league_state(id TEXT PRIMARY KEY,payload TEXT);
    INSERT INTO protected_league_state VALUES('league','{"rosters":[1,2],"pendingBid":42,"unknown":{"preserve":true}}');`);
  db.prepare('INSERT INTO stat_sources VALUES(?,?,?)').run(SOURCE, 'nhl-completed-games', 'active');
  function capture(revision, patch = {}) {
    const row = { refreshId: uuid(10000 + revision), statSourceId: SOURCE, season: SEASON, revision,
      observed: NOW - 3000, captured: NOW - 2000, completed: NOW - 1000, sealed: 1, status: 'succeeded', ...patch };
    db.prepare('INSERT INTO stat_refreshes VALUES(?,?,?,?,?)').run(row.refreshId, row.statSourceId, row.season, row.status, row.completed);
    db.prepare('INSERT INTO shared_game_evidence_captures VALUES(?,?,?,?,?,?,?)')
      .run(row.refreshId, row.statSourceId, row.season, revision, row.observed, row.captured, row.sealed);
  }
  function game(n = 1, gameId = '2026020001', revision = 1, patch = {}) {
    const row = { playerId: uuid(n), providerPlayerId: String(8400000 + n), providerTeamId: '54', nhlGameId: gameId,
      scheduledStartsAtMs: NOW - 50000, gameState: 'final', gamesPlayed: 1, goals: 0, assists: 0,
      scoringRuleVersion: null, scoringStats: null, ...patch };
    const entry = prepareGameRecord(row);
    db.prepare('INSERT INTO shared_game_evidence_changes VALUES(?,?,?,?,?,?,?)')
      .run(SOURCE, SEASON, uuid(n), gameId, revision, entry.payload, entry.sha256);
  }
  function tombstone(n, gameId, revision) {
    db.prepare('INSERT INTO shared_game_evidence_changes VALUES(?,?,?,?,?,NULL,NULL)').run(SOURCE, SEASON, uuid(n), gameId, revision);
  }
  capture(1);
  return { db, capture, game, tombstone,
    read: (candidates = [candidate()], at = NOW, config = {}) =>
      createSqliteInjuryRecoveryReader({ database: db, nhlSeasonKey: SEASON, ...config }).read({ candidates, nowMs: at }) };
}

test('returns latest final participation proof with pinned capture and performs no writes', async t => {
  const f = fixture(t);
  f.game(1, '2026020001', 1, { scheduledStartsAtMs: NOW - 90000 });
  f.game(1, '2026020002');
  f.game(1, '2026020003', 1, { gamesPlayed: 0 }); // A final scratch is not participation.
  f.game(1, '2026020004', 1, { gamesPlayed: 0, gameState: 'scheduled', scheduledStartsAtMs: NOW + 100000 });
  const before = f.db.serialize();
  f.db.pragma('query_only=ON');
  const proofs = await f.read();
  assert.deepEqual(proofs[uuid(1)], { source: 'nhl', trusted: true, final: true, participated: true, playerId: uuid(1),
    nhlPlayerId: '8400001', gameId: '2026020002', occurredAtMs: NOW - 50000, observedAtMs: NOW - 3000,
    refreshId: uuid(10001), revision: 1 });
  assert.deepEqual(proofs.warnings, []);
  assert.deepEqual(Object.keys(proofs), [uuid(1)]);
  assert.deepEqual(f.db.serialize(), before);
});

test('scratches, live games and games not newer than injury evidence cannot prove recovery', async t => {
  const f = fixture(t);
  f.game(1, '2026020001', 1, { gamesPlayed: 0 });
  f.game(1, '2026020002', 1, { gamesPlayed: 0, gameState: 'in_progress' });
  f.game(1, '2026020003', 1, { scheduledStartsAtMs: candidate().afterMs });
  f.game(1, '2026020004', 1, { scheduledStartsAtMs: candidate().afterMs - 1 });
  assert.deepEqual(await f.read(), {});
});

test('latest corrections and tombstones supersede positives, while later unsealed revisions are excluded', async t => {
  const f = fixture(t);
  f.game(1, '2026020001'); f.game(1, '2026020002');
  f.capture(2);
  f.tombstone(1, '2026020001', 2);
  f.game(1, '2026020002', 2, { gamesPlayed: 0 });
  f.capture(3, { sealed: 0, status: 'started' });
  f.game(1, '2026020001', 3);
  assert.deepEqual(await f.read(), {});
  f.game(1, '2026020005', 2);
  const proof = (await f.read())[uuid(1)];
  assert.equal(proof.gameId, '2026020005'); assert.equal(proof.revision, 2);
});

test('missing or ambiguous active NHL sources fail closed without using another provider', async t => {
  const f = fixture(t); f.game();
  f.db.prepare('INSERT INTO stat_sources VALUES(?,?,?)').run(uuid(9002), 'nhl-completed-games', 'active');
  let proofs = await f.read(); assert.deepEqual(proofs, {});
  assert.equal(proofs.warnings[0].code, 'INJURY_RECOVERY_SOURCE_AMBIGUOUS');
  f.db.prepare('UPDATE stat_sources SET status=?').run('inactive');
  f.db.prepare('INSERT INTO stat_sources VALUES(?,?,?)').run(uuid(9003), 'another-provider', 'active');
  proofs = await f.read(); assert.deepEqual(proofs, {});
});

test('capture freshness, future timestamps, timestamp order and season scope are enforced', async t => {
  const variants = [
    { observed: NOW - 36 * 3600000 - 1 }, { observed: NOW + 1 }, { captured: NOW + 1 }, { completed: NOW + 1 },
    { observed: NOW - 1000, captured: NOW - 2000 }, { captured: NOW - 500, completed: NOW - 1000 },
    { observed: null }, { season: '20252026' },
  ];
  for (let i = 0; i < variants.length; i++) await t.test(`invalid capture ${i}`, async sub => {
    const f = fixture(sub); f.game(); f.db.exec('DELETE FROM shared_game_evidence_captures; DELETE FROM stat_refreshes;');
    f.capture(1, variants[i]); assert.deepEqual(await f.read(), {});
  });
  await t.test('exact freshness boundary is accepted', async sub => {
    const f = fixture(sub); f.game(1, '2026020001', 1, { scheduledStartsAtMs: NOW - 36 * 3600000 - 1000 });
    f.db.prepare('UPDATE shared_game_evidence_captures SET observed_at_ms=?').run(NOW - 36 * 3600000);
    assert.ok((await f.read([candidate(1, { afterMs: NOW - 40 * 3600000 })]))[uuid(1)]);
  });
});

test('corrupt hashes, noncanonical JSON and identity mismatches quarantine only their candidate', async t => {
  const alterations = [
    db => db.prepare('UPDATE shared_game_evidence_changes SET payload_sha256=? WHERE player_id=?').run('0'.repeat(64), uuid(1)),
    db => db.prepare("UPDATE shared_game_evidence_changes SET payload_json=payload_json||' ' WHERE player_id=?").run(uuid(1)),
    db => db.prepare('UPDATE shared_game_evidence_changes SET nhl_game_id=? WHERE player_id=?').run('wrong-game', uuid(1)),
    db => db.prepare('UPDATE shared_game_evidence_changes SET payload_json=? WHERE player_id=?').run('{invalid', uuid(1)),
    db => db.prepare('UPDATE shared_game_evidence_changes SET payload_json=? WHERE player_id=?').run('x'.repeat(20000), uuid(1)),
  ];
  for (let i = 0; i < alterations.length; i++) await t.test(`corruption ${i}`, async sub => {
    const f = fixture(sub); f.game(1); f.game(2); alterations[i](f.db);
    const proofs = await f.read([candidate(1), candidate(2)]);
    assert.equal(proofs[uuid(1)], undefined); assert.ok(proofs[uuid(2)]);
    assert.deepEqual(proofs.warnings, [{ code: 'INJURY_RECOVERY_CANDIDATE_UNVERIFIED', playerId: uuid(1) }]);
  });
  await t.test('pinned NHL identity mismatch', async sub => {
    const f = fixture(sub); f.game(); assert.deepEqual(await f.read([candidate(1, { nhlPlayerId: '9999999' })]), {});
  });
});

test('a final game dated after observation and records from failed or unsealed captures cannot prove recovery', async t => {
  for (const mutation of [
    f => f.game(1, '2026020001', 1, { scheduledStartsAtMs: NOW - 1000 }),
    f => { f.game(); f.db.prepare("UPDATE stat_refreshes SET status='failed'").run(); f.capture(2); },
    f => { f.game(); f.db.prepare('UPDATE shared_game_evidence_captures SET sealed=0').run(); f.capture(2); },
  ]) await t.test('invalid origin', async sub => {
    const f = fixture(sub); mutation(f); assert.deepEqual(await f.read(), {});
  });
});

test('candidate game bounds reject overflow, and unrelated players do not expand reads', async t => {
  const f = fixture(t);
  for (let n = 1; n <= 128; n++) f.game(1, String(2026020000 + n));
  f.game(2);
  f.db.prepare('UPDATE shared_game_evidence_changes SET payload_json=? WHERE player_id=?').run('x'.repeat(20000), uuid(2));
  assert.ok((await f.read())[uuid(1)]);
  f.game(1, '2026020129');
  const proofs = await f.read(); assert.deepEqual(proofs, {});
  assert.equal(proofs.warnings[0].code, 'INJURY_RECOVERY_CANDIDATE_UNVERIFIED');
});

test('candidate input bounds and duplicate identities reject before querying storage', async () => {
  const reader = createSqliteInjuryRecoveryReader({ database: { prepare() { assert.fail('must not query'); } }, nhlSeasonKey: SEASON });
  for (const candidates of [Array.from({ length: 2001 }, (_, i) => candidate(i + 1)), [candidate(), candidate()],
    [candidate(1, { afterMs: NOW + 1 })], [candidate(1, { playerId: '__proto__' })], [candidate(1, { nhlPlayerId: 'unknown' })]]) {
    const proofs = await reader.read({ candidates, nowMs: NOW });
    assert.deepEqual(proofs, {}); assert.equal(proofs.warnings[0].code, 'INJURY_RECOVERY_INPUT_INVALID');
  }
});

test('yields after sixteen candidates, owns input values and pins the immutable capture across the yield', async t => {
  const f = fixture(t), candidates = Array.from({ length: 17 }, (_, i) => candidate(i + 1));
  for (let i = 1; i <= 17; i++) f.game(i);
  const reading = f.read(candidates);
  candidates[16].nhlPlayerId = '9999999';
  f.capture(2); f.tombstone(17, '2026020001', 2);
  const proofs = await reading;
  assert.equal(Object.keys(proofs).length, 17);
  assert.equal(proofs[uuid(17)].nhlPlayerId, '8400017');
  assert.equal(proofs[uuid(17)].revision, 1);
  await yieldToEventLoop();
  assert.equal((await f.read([candidate(17)]))[uuid(17)], undefined);
});

test('source changes across an event-loop yield discard all pending proofs', async t => {
  const f = fixture(t), candidates = Array.from({ length: 16 }, (_, i) => candidate(i + 1));
  for (let i = 1; i <= 16; i++) f.game(i);
  const reading = f.read(candidates);
  f.db.prepare("UPDATE stat_sources SET status='inactive'").run();
  const proofs = await reading;
  assert.deepEqual(proofs, {}); assert.equal(proofs.warnings[0].code, 'INJURY_RECOVERY_SOURCE_CHANGED');
});

test('database failures are sanitized and a caller transaction is never held across an async read', async t => {
  const reader = createSqliteInjuryRecoveryReader({ database: { prepare() { throw new Error('sensitive database path'); } }, nhlSeasonKey: SEASON });
  const proofs = await reader.read({ candidates: [candidate()], nowMs: NOW });
  assert.deepEqual(proofs, {});
  assert.deepEqual(proofs.warnings, [{ code: 'INJURY_RECOVERY_EVIDENCE_UNAVAILABLE' }]);
  const f = fixture(t); f.game(); f.db.exec('BEGIN');
  assert.equal((await f.read()).warnings[0].code, 'INJURY_RECOVERY_INPUT_INVALID');
  assert.equal(f.db.inTransaction, true); f.db.exec('ROLLBACK');
});
