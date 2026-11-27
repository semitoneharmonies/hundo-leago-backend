const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { createSqliteRealtimeInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteRealtimeInjuryRepository');
const { createSqlitePlayerInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerInjuryRepository');
const { createSqlitePlayerRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository');
const { createDailyPlayerDetails } = require('../../src/daily/createDailyPlayerDetails');
const { legacyRealtimeRecoveryCandidates } = require('../../src/domain/players/realtimeLegacyInjuryRecoveryPolicy');
const { snapshotSqliteState } = require('../helpers/snapshotSqliteState');

const NOW = Date.parse('2026-11-26T08:00:00Z');
const MANUAL = NOW - 3 * 86400_000;
const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const row = (patch = {}) => ({ providerPlayerId: '9002', name: 'Other Forward', reportedAtMs: MANUAL,
  status: 'injured', medicalReason: 'Illness', designation: 'OUT', teamId: '22',
  team: 'Vancouver Canucks', position: 'LW', ...patch });
const snapshot = (at, rows = [row()]) => ({ source: 'realtime', fetchedAtMs: at, sourceGeneratedAtMs: null,
  sourceCount: rows.length, teamCount: new Set(rows.map(item => item.teamId)).size, rows });
const proof = (patch = {}) => ({ source: 'nhl', trusted: true, final: true, participated: true,
  playerId: uuid(1), nhlPlayerId: '8400001', gameId: '2026020397', occurredAtMs: NOW - 3600_000, ...patch });
const mapping = { providerPlayerId: '9002', nhlPlayerId: '8400002', providerName: 'Other Forward',
  verifiedAtMs: MANUAL, evidenceUrls: ['https://www.nhl.com/player/8400002'] };
const protectedState = db => Object.fromEntries(Object.entries(snapshotSqliteState(db).tables)
  .filter(([name]) => !name.startsWith('player_injury_')));

const template = new Database(':memory:');
migrateDatabase({ database: template, migrationsDirectory: path.resolve(__dirname, '../../database/migrations'),
  applicationBuildId: 'legacy-injury-recovery-test', now: () => NOW });
for (const [n, fullName, position, team] of [[1, 'Legacy Defender', 'D', 'COL'], [2, 'Other Forward', 'LW', 'VAN']]) {
  template.prepare("INSERT INTO players(id,first_name,last_name,full_name,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,'active',1,1)")
    .run(uuid(n), fullName.split(' ')[0], fullName.split(' ')[1], fullName);
  template.prepare("INSERT INTO player_external_ids(id,player_id,provider,external_value,created_at_ms) VALUES (?,?,'nhl',?,1)")
    .run(uuid(100 + n), uuid(n), String(8400000 + n));
  template.prepare("INSERT INTO player_source_state(id,player_id,provider,source_position,normalized_position,nhl_team_abbreviation,active,source_version,effective_at_ms,created_at_ms) VALUES (?,?,'nhl',?,?,?,1,'test',1,1)")
    .run(uuid(200 + n), uuid(n), position, position === 'D' ? 'D' : 'F', team);
}
const initial = template.serialize(); template.close();

function fixture(t) {
  const db = new Database(initial); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  let at = MANUAL, occurrence = 0;
  const manual = createSqlitePlayerInjuryRepository({ database: db, nowMs: () => at });
  const status = () => db.prepare('SELECT * FROM player_injury_status WHERE id=?').get(uuid(1));
  const decide = statusValue => manual.decide({ playerId: uuid(1), status: statusValue,
    expectedVersion: status()?.version || 0, reason: 'Verified synthetic decision', actorId: null });
  decide('injured'); at = NOW;
  const repo = createSqliteRealtimeInjuryRepository({ database: db, nowMs: () => at });
  repo.registerMappings([mapping]);
  const claim = () => repo.claim({ occurrenceId: `synthetic-${++occurrence}`, scheduledAtMs: at, atMs: at }).token;
  return { db, repo, status, decide, claim, now: () => at, advance: () => at += 12 * 3600_000,
    apply: (rows = [row()], recoveryProof = proof()) => repo.apply(snapshot(at, rows), claim(),
      { recoveryProofs: recoveryProof ? { [uuid(1)]: recoveryProof } : {} }) };
}

test('legacy manual injury clears after two accepted absences and exact later NHL proof; existing Daily panels reread without writes', t => {
  const f = fixture(t), before = protectedState(f.db);
  const player = { id: '8400001', name: 'Legacy Defender', position: 'D', team: 'COL', opponent: 'VAN' };
  const room = { availablePlayers: [player], auctions: [player], members: [{ roster: [player] }] };
  const savedRoom = structuredClone(room);
  const project = createDailyPlayerDetails({ playerRepository: createSqlitePlayerRepository({ database: f.db }) }).project;
  const checkRead = status => {
    const bytes = f.db.serialize(); f.db.pragma('query_only=ON');
    const projected = project(room);
    for (const p of [projected.availablePlayers[0], projected.auctions[0], projected.members[0].roster[0]]) assert.equal(p.injury.status, status);
    assert.deepEqual(f.db.serialize(), bytes); assert.deepEqual(room, savedRoom); f.db.pragma('query_only=OFF');
  };
  checkRead('injured');
  assert.deepEqual(f.repo.recoveryCandidates(snapshot(f.now())), []);
  assert.equal(f.apply().recovered, 0); assert.equal(f.status().status, 'injured');
  f.advance();
  const bytes = f.db.serialize(); f.db.pragma('query_only=ON');
  assert.deepEqual(f.repo.recoveryCandidates(snapshot(f.now())), [{ playerId: uuid(1), nhlPlayerId: '8400001', afterMs: MANUAL }]);
  assert.deepEqual(f.db.serialize(), bytes); f.db.pragma('query_only=OFF');
  assert.equal(f.apply().recovered, 1); assert.equal(f.status().source, 'realtime');
  checkRead('healthy'); assert.deepEqual(protectedState(f.db), before);
  assert.match(f.db.prepare("SELECT reason FROM player_injury_events WHERE player_id=? AND json_extract(after_json,'$.status')='healthy'").get(uuid(1)).reason, /2026020397/);
  assert.equal(f.repo.listMappings().some(value => value.playerId === uuid(1)), false, 'no synthetic provider mapping');
});

test('failed and malformed reports never supply the first accepted absence', t => {
  const f = fixture(t), original = f.status();
  const token = f.claim();
  assert.throws(() => f.repo.apply(snapshot(f.now(), []), token, { recoveryProofs: { [uuid(1)]: proof() } }));
  f.repo.fail(token, 'INJURY_FEED_INVALID'); f.advance();
  assert.deepEqual(f.repo.recoveryCandidates(snapshot(f.now())), []);
  assert.equal(f.apply().recovered, 0); assert.deepEqual(f.status(), original);
  f.advance(); assert.equal(f.apply().recovered, 1);
});

test('missing, old, future, untrusted and wrong canonical or NHL proof cannot clear a legacy injury', t => {
  const f = fixture(t); f.apply(); f.advance();
  const original = f.status();
  for (const evidence of [null, proof({ occurredAtMs: MANUAL }), proof({ occurredAtMs: f.now() + 30 * 86400_000 }),
    proof({ trusted: false }), proof({ final: false }), proof({ participated: false }),
    proof({ playerId: uuid(2) }), proof({ nhlPlayerId: '8400002' })]) {
    assert.equal(f.apply([row()], evidence).recovered, 0); assert.deepEqual(f.status(), original); f.advance();
  }
});

test('manual decision after candidate read wins the race and requires two later absences', t => {
  const f = fixture(t); f.apply(); f.advance();
  assert.equal(f.repo.recoveryCandidates(snapshot(f.now())).length, 1);
  f.decide('injured'); const renewed = f.status(), renewedAt = f.now();
  assert.equal(f.apply().recovered, 0); assert.deepEqual(f.status(), renewed);
  f.advance();
  const laterProof = proof({ occurredAtMs: renewedAt + 1 });
  assert.equal(f.apply([row()], laterProof).recovered, 0, 'previous report was at the manual decision, not after it');
  f.advance(); assert.equal(f.apply([row()], laterProof).recovered, 1);
});

test('current unregistered same-name report prevents recovery despite later positive game proof', t => {
  const f = fixture(t); f.apply(); f.advance();
  const rows = [row(), row({ providerPlayerId: '9999', name: 'Legacy Defender', team: 'Colorado Avalanche', teamId: '21', position: 'D' })];
  assert.deepEqual(f.repo.recoveryCandidates(snapshot(f.now(), rows)), []);
  assert.equal(f.apply(rows).recovered, 0); assert.equal(f.status().source, 'admin');
});

function policyInput() {
  return { snapshot: snapshot(NOW + 1), previousRows: [{ ...row(), observedAtMs: NOW, present: true }],
    previousSuccessAtMs: NOW, previousSourceCount: 1, previousTeamCount: 1,
    catalogue: [{ playerId: uuid(1), nhlPlayerId: '8400001', name: 'Legacy Defender', teamAbbreviation: 'COL', position: 'D', active: true },
      { playerId: uuid(2), nhlPlayerId: '8400002', name: 'Other Forward', teamAbbreviation: 'VAN', position: 'LW', active: true }],
    identities: [{ playerId: uuid(1), nhlPlayerId: '8400001' }, { playerId: uuid(2), nhlPlayerId: '8400002' }],
    mappings: [{ ...mapping, playerId: uuid(2), aliases: [] }],
    statuses: [{ playerId: uuid(1), status: 'injured', source: 'admin', evidenceAtMs: MANUAL }] };
}
test('unresolved same-position candidates need both a different known surname and a different verified team', () => {
  for (const [extra, expected] of [
    [{ name: 'Unknown Defender', team: 'Vancouver Canucks', position: 'D' }, 0],
    [{ name: 'L. Defender', team: 'Vancouver Canucks', position: 'D' }, 0],
    [{ name: 'Unknown Skater', team: 'Colorado Avalanche', position: 'D' }, 0],
    [{ name: 'Unknown Skater', team: null, position: 'D' }, 0],
    [{ name: 'Unconfirmed', team: 'Vancouver Canucks', position: 'D' }, 0],
    [{ name: 'Different Skater', team: 'Vancouver Canucks', position: null }, 0],
    [{ name: 'Different Skater', team: 'Vancouver Canucks', position: 'D' }, 1],
    [{ name: 'Unknown Goalie', team: null, position: 'G' }, 1],
  ]) {
    for (const side of ['previous', 'current']) {
      const input = policyInput(), extraRow = row({ providerPlayerId: '9999', ...extra });
      if (side === 'previous') { input.previousRows.push({ ...extraRow, observedAtMs: NOW, present: true }); input.previousSourceCount++; }
      else input.snapshot.rows.push(extraRow);
      assert.equal(legacyRealtimeRecoveryCandidates(input).length, expected, JSON.stringify({ extra, side }));
    }
  }
});

test('ambiguous identities, aliases, inconsistent prior snapshot and newer manual evidence fail closed', () => {
  const changes = [
    input => input.identities.push({ playerId: uuid(2), nhlPlayerId: '8400001' }),
    input => input.identities.push({ playerId: uuid(1), nhlPlayerId: '8400999' }),
    input => input.catalogue.push({ ...input.catalogue[0], playerId: uuid(3), nhlPlayerId: '8400003' }),
    input => input.catalogue[0].active = false,
    input => input.mappings[0].aliases.push('Legacy Defender'),
    input => input.previousRows[0].observedAtMs--,
    input => input.previousSourceCount++,
    input => input.previousTeamCount++,
    input => input.previousSuccessAtMs = null,
    input => input.statuses[0].evidenceAtMs = NOW,
  ];
  for (const change of changes) { const input = policyInput(); change(input); assert.deepEqual(legacyRealtimeRecoveryCandidates(input), []); }
});

test('NHL identity changed after proof lookup is rechecked before legacy recovery', t => {
  const f = fixture(t); f.apply(); f.advance();
  assert.equal(f.repo.recoveryCandidates(snapshot(f.now())).length, 1);
  f.db.prepare("UPDATE player_external_ids SET external_value='8400999' WHERE player_id=? AND provider='nhl'").run(uuid(1));
  assert.equal(f.apply().recovered, 0); assert.equal(f.status().source, 'admin');
});
