const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { discoverMigrations, applyMigrations } = require('../../src/infrastructure/database/migrate');
const { createSqliteRealtimeInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteRealtimeInjuryRepository');
const { createSqlitePlayerInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerInjuryRepository');
const { getRepositoryCatalogForSchemaVersion } = require('../../src/infrastructure/persistence/sqlite/repositoryCatalog');
const { snapshotSqliteState } = require('../helpers/snapshotSqliteState');

const NOW = Date.parse('2026-11-26T03:00:00Z');
const migrations = discoverMigrations({ migrationsDirectory: path.resolve(__dirname, '../../database/migrations') });
const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
function seed(db, n) {
  db.prepare(`INSERT INTO players(id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms)
    VALUES (?,'Test',? ,?,'2000-01-01','active',1,1)`).run(uuid(n), `Player ${n}`, `Test Player ${n}`);
  db.prepare("INSERT INTO player_external_ids(id,player_id,provider,external_value,created_at_ms) VALUES (?,?,'nhl',?,1)")
    .run(uuid(100 + n), uuid(n), String(8400000 + n));
  db.prepare(`INSERT INTO player_source_state(id,player_id,provider,source_position,normalized_position,nhl_team_abbreviation,
    active,source_version,source_payload_json,effective_at_ms,created_at_ms)
    VALUES (?,?,'nhl','LW','F','VAN',1,'fixture','{"preserve":"unknown data"}',1,1)`).run(uuid(200 + n), uuid(n));
}
function fixture(t, { version = 97, limit = 100 } = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  applyMigrations({ database: db, migrations: migrations.filter(item => item.id <= version), applicationBuildId: 'realtime-test', now: () => NOW });
  for (let n = 1; n <= 3; n++) seed(db, n);
  let at = NOW;
  const repo = version >= 97 ? createSqliteRealtimeInjuryRepository({ database: db, nowMs: () => at, monthlyRequestLimit: limit }) : null;
  return { db, repo, now: () => at, advance: (ms = 12 * 3600_000) => at += ms, setTime: value => at = value };
}
const map = (n, patch = {}) => ({ providerPlayerId: String(9000 + n), nhlPlayerId: String(8400000 + n),
  providerName: `Test Player ${n}`, verifiedAtMs: NOW - 1, evidenceUrls: [`https://www.nhl.com/player/${8400000 + n}`], ...patch });
const row = (n, patch = {}) => ({ providerPlayerId: String(9000 + n), name: `Test Player ${n}`,
  reportedAtMs: NOW - 60000, status: 'injured', medicalReason: 'Illness', designation: 'OUT',
  teamId: '22', team: 'Vancouver Canucks', position: 'LW', ...patch });
function snapshot(at, rows = [row(1)], patch = {}) {
  return { source: 'realtime', fetchedAtMs: at, sourceGeneratedAtMs: null, sourceCount: rows.length,
    teamCount: new Set(rows.map(value => value.teamId)).size, rows, ...patch };
}
function claim(f, id) {
  const result = f.repo.claim({ occurrenceId: id, scheduledAtMs: f.now(), atMs: f.now() });
  assert.equal(result.status, 'claimed'); return result.token;
}
function apply(f, id, rows, options, patch) { return f.repo.apply(snapshot(f.now(), rows, patch), claim(f, id), options); }
const status = (f, n) => f.db.prepare('SELECT * FROM player_injury_status WHERE id=?').get(uuid(n));
const protectedState = db => Object.fromEntries(Object.entries(snapshotSqliteState(db).tables).filter(([name]) => !name.startsWith('player_injury_')));

test('97 preserves all prior injury values, row identities, ESPN state and unrelated tables; historical catalog excludes new tables', t => {
  const f = fixture(t, { version: 96 });
  f.db.prepare(`INSERT INTO player_injury_status(rowid,id,status,source,evidence_at_ms,observed_at_ms,review_reason,updated_at_ms,version,timeline,designation,injury_reason)
    VALUES (17,?,'injured','admin',1,2,'review',3,7,'Day to Day','OUT','Illness')`).run(uuid(1));
  f.db.prepare("INSERT INTO player_injury_status(id,status,source,evidence_at_ms,observed_at_ms,updated_at_ms) VALUES (?,'healthy','espn',10,11,12)").run(uuid(2));
  f.db.prepare("INSERT INTO player_injury_sync(id,enabled,last_success_at_ms,version) VALUES ('espn',1,50,4)").run();
  const before = snapshotSqliteState(f.db);
  applyMigrations({ database: f.db, migrations, applicationBuildId: 'realtime-test', now: () => NOW + 1 });
  const after = snapshotSqliteState(f.db);
  for (const [name, records] of Object.entries(before.tables)) {
    if (!['application_metadata', 'schema_migrations'].includes(name)) assert.deepEqual(after.tables[name], records, name);
  }
  assert.equal(after.userVersion, 97); assert.deepEqual(after.foreignKeys, []); assert.equal(after.integrity, 'ok');
  assert.equal(getRepositoryCatalogForSchemaVersion(96).some(value => value.tableName.startsWith('player_injury_realtime_')), false);
  assert.equal(getRepositoryCatalogForSchemaVersion(97).filter(value => value.tableName.startsWith('player_injury_realtime_')).length, 4);
});

test('repository construction and all read methods perform zero writes', t => {
  const f = fixture(t), before = snapshotSqliteState(f.db), changes = f.db.prepare('SELECT total_changes() n').get().n;
  const repo = createSqliteRealtimeInjuryRepository({ database: f.db, nowMs: f.now });
  assert.equal(repo.state().quota.attempted, 0); assert.equal(repo.listMappings().length, 0); assert.equal(repo.listFeed().length, 0);
  assert.equal(repo.readIdentityCatalogue().length, 3);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes); assert.deepEqual(snapshotSqliteState(f.db), before);
});

test('verified crosswalk resolves exact NHL canonical identity, is idempotent, audited and rejects conflicts atomically', t => {
  const f = fixture(t), protectedBefore = protectedState(f.db);
  assert.deepEqual(f.repo.registerMappings([map(1)]), { added: 1, unchanged: 0 });
  const before = snapshotSqliteState(f.db);
  assert.deepEqual(f.repo.registerMappings([map(1)]), { added: 0, unchanged: 1 });
  assert.deepEqual(snapshotSqliteState(f.db), before);
  for (const mappings of [[map(2), map(2)], [map(2), map(3, { nhlPlayerId: '9999999' })],
    [map(1, { nhlPlayerId: '8400002' })], [map(2, { playerId: uuid(3) })], [map(2, { verified: 'false' })]]) {
    assert.throws(() => f.repo.registerMappings(mappings)); assert.deepEqual(snapshotSqliteState(f.db), before);
  }
  assert.equal(f.repo.listMappings()[0].playerId, uuid(1));
  assert.equal(f.db.prepare('SELECT count(*) n FROM player_injury_events').get().n, 1);
  assert.deepEqual(protectedState(f.db), protectedBefore);
});

test('automatic crosswalk registration rechecks exact current NHL name, team and position in its transaction', t => {
  const f = fixture(t);
  const automatic = map(1, { verificationMethod: 'unique_name_team_position', teamAbbreviation: 'VAN', position: 'F', verified: true });
  for (const patch of [{ providerName: 'Different Player' }, { teamAbbreviation: 'NYR' }, { position: 'D' }]) {
    assert.throws(() => f.repo.registerMappings([{ ...automatic, ...patch }]), { code: 'INJURY_IDENTITY_CHANGED' });
  }
  assert.equal(f.repo.registerMappings([automatic]).added, 1);
  assert.equal(f.repo.listMappings()[0].verificationMethod, 'unique_name_team_position');
});

test('claim durably charges quota before retrieval and never retries an attempted occurrence after restart or lease expiry', t => {
  const f = fixture(t), first = claim(f, '2026-11-25@23:30');
  assert.equal(f.repo.state().quota.attempted, 1);
  assert.equal(f.repo.state().latestRun.status, 'running');
  assert.equal(f.repo.claim({ occurrenceId: 'other', scheduledAtMs: f.now() }).reason, 'already_running');
  f.advance(16 * 60000);
  const restarted = createSqliteRealtimeInjuryRepository({ database: f.db, nowMs: f.now });
  assert.equal(restarted.claim({ occurrenceId: '2026-11-25@23:30', scheduledAtMs: NOW }).reason, 'occurrence_already_attempted');
  assert.equal(restarted.state().latestRun.status, 'abandoned');
  assert.equal(restarted.state().quota.attempted, 1);
  assert.throws(() => restarted.apply(snapshot(f.now()), first), { code: 'INJURY_REFRESH_CONFLICT' });
  assert.equal(restarted.claim({ occurrenceId: 'next', scheduledAtMs: f.now() }).status, 'claimed');
});

test('monthly request budget and provider 429 cooldown are persistent and sanitized', t => {
  const f = fixture(t, { limit: 2 });
  const first = claim(f, 'first');
  f.repo.fail(first, 'INJURY_FEED_RATE_LIMITED', { retryAfterMs: 3600_000 });
  assert.equal(f.repo.claim({ occurrenceId: 'second', scheduledAtMs: f.now() }).reason, 'provider_cooldown');
  f.advance(3600_001);
  f.repo.fail(claim(f, 'second'), 'provider error containing a secret');
  assert.equal(f.repo.state().errorCode, 'INJURY_REFRESH_FAILED');
  assert.equal(f.repo.claim({ occurrenceId: 'third', scheduledAtMs: f.now() }).reason, 'monthly_quota_exhausted');
  assert.ok(!JSON.stringify(f.repo.state()).includes('token'));
  f.setTime(Date.parse('2026-12-01T00:01:00Z'));
  assert.equal(f.repo.claim({ occurrenceId: 'december', scheduledAtMs: f.now() }).status, 'claimed');
});

test('provider remaining quota prevents excess requests and resets safely in a later month', t => {
  const f = fixture(t);
  apply(f, 'first', [row(1)], {}, { quota: { remaining: 0, resetAtMs: null } });
  assert.equal(f.repo.claim({ occurrenceId: 'second', scheduledAtMs: f.now() }).reason, 'monthly_quota_exhausted');
  f.setTime(Date.parse('2026-12-01T00:01:00Z'));
  apply(f, 'december-1', [row(1)]);
  f.advance();
  assert.equal(f.repo.claim({ occurrenceId: 'december-2', scheduledAtMs: f.now() }).status, 'claimed');
});

test('only mapped medical injuries update state; nonmedical IR, unknown identity and changed name never update players', t => {
  const f = fixture(t), protectedBefore = protectedState(f.db);
  f.repo.registerMappings([map(1), map(2)]);
  const result = apply(f, 'first', [row(1), row(2, { designation: 'IR', medicalReason: 'Contract Dispute' }), row(3)]);
  assert.equal(result.changed, 1); assert.equal(result.unresolved, 1);
  assert.equal(status(f, 1).status, 'injured'); assert.equal(status(f, 1).source, 'realtime');
  assert.equal(status(f, 2), undefined); assert.equal(status(f, 3), undefined);
  const firstStatus = status(f, 1); f.advance();
  apply(f, 'second', [row(1, { name: 'Different Athlete' }), row(2)]);
  assert.deepEqual(status(f, 1), firstStatus);
  assert.deepEqual(protectedState(f.db), protectedBefore); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('existing manual decisions win over older/equal reports and newer actual injury evidence can reopen them', t => {
  const f = fixture(t); f.repo.registerMappings([map(1)]);
  const manual = createSqlitePlayerInjuryRepository({ database: f.db, nowMs: f.now });
  manual.decide({ playerId: uuid(1), status: 'healthy', expectedVersion: 0, reason: 'Synthetic correction', actorId: null });
  const original = status(f, 1);
  apply(f, 'first', [row(1)]); assert.deepEqual(status(f, 1), original);
  f.advance(); apply(f, 'equal', [row(1, { reportedAtMs: NOW })]); assert.deepEqual(status(f, 1), original);
  f.advance(); apply(f, 'newer', [row(1, { reportedAtMs: NOW + 1 })]);
  assert.equal(status(f, 1).status, 'injured'); assert.equal(status(f, 1).source, 'realtime');
});

test('malformed, duplicate, stale, incomplete and unauthorized snapshots preserve accepted status and absence evidence', t => {
  const f = fixture(t); f.repo.registerMappings([map(1)]);
  const many = Array.from({ length: 12 }, (_, index) => row(index + 1));
  apply(f, 'first', many); f.advance();
  const token = claim(f, 'next'), before = snapshotSqliteState(f.db);
  const invalid = [snapshot(f.now(), []), snapshot(f.now(), [row(1), row(1)]), snapshot(f.now(), many, { sourceCount: 100 }),
    snapshot(f.now(), [row(1)]), snapshot(NOW, many)];
  for (const input of invalid) {
    assert.throws(() => f.repo.apply(input, token)); assert.deepEqual(snapshotSqliteState(f.db), before);
  }
  assert.throws(() => f.repo.apply(snapshot(f.now(), many), token, { authorizePersist: () => false }), { code: 'INJURY_PERSISTENCE_NOT_AUTHORIZED' });
  assert.deepEqual(snapshotSqliteState(f.db), before);
  f.repo.fail(token, 'INJURY_FEED_UNAVAILABLE');
  assert.deepEqual(f.repo.listFeed(), before.tables.player_injury_realtime_feed.map(value => { const { __snapshot_rowid__, ...rest } = JSON.parse(value); return rest; }).sort((a,b) => a.id.localeCompare(b.id)));
});

test('two accepted absences alone never clear, and a currently listed player cannot be cleared by participation proof', t => {
  const f = fixture(t); f.repo.registerMappings([map(1)]); apply(f, 'first', [row(1)]);
  const proof = { source: 'nhl', trusted: true, final: true, participated: true, playerId: uuid(1), gameId: '2026020123', occurredAtMs: NOW + 1 };
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(f.repo.recoveryCandidates(snapshot(f.now(), [row(1)])), []);
  assert.deepEqual(f.repo.recoveryCandidates(snapshot(f.now(), [row(2)])), [{ playerId: uuid(1), nhlPlayerId: '8400001', afterMs: NOW - 60000 }]);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  f.advance(); apply(f, 'absent1', [row(2)]);
  assert.equal(f.repo.listFeed().find(value => value.id === '9001').absence_count, 1);
  f.advance(); apply(f, 'absent2', [row(2)]);
  assert.equal(status(f, 1).status, 'injured'); assert.equal(status(f, 1).review_reason, 'possible_return');
  f.advance(); apply(f, 'present', [row(1)], { recoveryProofs: { [uuid(1)]: proof } });
  assert.equal(status(f, 1).status, 'injured'); assert.equal(f.repo.listFeed().find(value => value.id === '9001').absence_count, 0);
});

test('positive final-game proof after injury and manual evidence can clear only its exact mapped player after two absences', t => {
  const f = fixture(t); f.repo.registerMappings([map(1)]); apply(f, 'first', [row(1)]);
  const proof = { source: 'nhl', trusted: true, final: true, participated: true, playerId: uuid(1), gameId: '2026020123', occurredAtMs: NOW + 1 };
  f.advance(); apply(f, 'absent1', [row(2)], { recoveryProofs: { [uuid(1)]: proof } });
  assert.equal(status(f, 1).status, 'injured');
  f.advance(); apply(f, 'absent2-wrong-player', [row(2)], { recoveryProofs: { [uuid(1)]: { ...proof, playerId: uuid(2) } } });
  assert.equal(status(f, 1).status, 'injured');
  f.advance(); apply(f, 'absent3', [row(2)], { recoveryProofs: { [uuid(1)]: proof } });
  assert.equal(status(f, 1).status, 'healthy'); assert.equal(status(f, 1).evidence_at_ms, proof.occurredAtMs);
  assert.match(f.db.prepare("SELECT reason FROM player_injury_events WHERE json_extract(after_json,'$.status')='healthy'").get().reason, /2026020123/);
});

test('a newer manual correction blocks earlier return proof and failed snapshots do not count as absence', t => {
  const f = fixture(t); f.repo.registerMappings([map(1)]); apply(f, 'first', [row(1)]);
  f.advance(); f.repo.fail(claim(f, 'failed'), 'INJURY_FEED_INVALID');
  assert.equal(f.repo.listFeed()[0].absence_count, 0);
  const manual = createSqlitePlayerInjuryRepository({ database: f.db, nowMs: f.now });
  manual.decide({ playerId: uuid(1), status: 'injured', expectedVersion: status(f, 1).version, reason: 'New injury after game', actorId: null });
  const original = status(f, 1), proof = { source: 'nhl', trusted: true, final: true, participated: true, playerId: uuid(1), gameId: '2026020123', occurredAtMs: NOW + 1 };
  f.advance(); apply(f, 'absent1', [row(2)], { recoveryProofs: { [uuid(1)]: proof } });
  f.advance(); apply(f, 'absent2', [row(2)], { recoveryProofs: { [uuid(1)]: proof } });
  assert.deepEqual(status(f, 1), original);
});

test('a newer unresolved medical report also prevents clearing from older game evidence', t => {
  const f = fixture(t); f.repo.registerMappings([map(1)]); apply(f, 'first', [row(1)]);
  f.advance(); apply(f, 'uncertain-new-report', [row(1, { status: 'review', medicalReason: 'Unknown', reportedAtMs: NOW + 2 })]);
  const proof = { source: 'nhl', trusted: true, final: true, participated: true, playerId: uuid(1), gameId: '2026020123', occurredAtMs: NOW + 1 };
  f.advance(); apply(f, 'absent1', [row(2)], { recoveryProofs: { [uuid(1)]: proof } });
  f.advance(); apply(f, 'absent2', [row(2)], { recoveryProofs: { [uuid(1)]: proof } });
  assert.equal(status(f, 1).status, 'injured');
  assert.equal(f.repo.recoveryCandidates(snapshot(f.now(), [row(2)]))[0].afterMs, NOW + 2);
});

test('mid-transaction failures roll back all status, feed, audit and completion writes', t => {
  const f = fixture(t); f.repo.registerMappings([map(1), map(2)]);
  const token = claim(f, 'rollback'), before = snapshotSqliteState(f.db);
  const broken = createSqliteRealtimeInjuryRepository({ database: f.db, nowMs: f.now, createId: () => 'invalid id with whitespace' });
  assert.throws(() => broken.apply(snapshot(f.now(), [row(1), row(2)]), token), { code: 'INJURY_INPUT_INVALID' });
  assert.deepEqual(snapshotSqliteState(f.db), before);
});
