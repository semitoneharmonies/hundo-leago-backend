const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { snapshotSqliteState } = require('../helpers/snapshotSqliteState');
const { createSqlitePlayerRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository');
const { createSqliteNhlTeamAssignmentRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteNhlTeamAssignmentRepository');

const ROOT = path.resolve(__dirname, '../..');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceVersion = 'b'.repeat(64);
function seed(database, n, { provider = 'nhl', team = 'VAN', active = 1 } = {}) {
  const playerId = uuid(n), sourceId = uuid(n + 10), providerPlayerId = String(8_400_000 + n);
  database.prepare(`INSERT INTO players (id, first_name, last_name, full_name, birth_date, status, created_at_ms, updated_at_ms, version)
    VALUES (?, 'Test', 'Skater', 'Test Skater', '1999-01-01', 'active', 10, 10, 7)`).run(playerId);
  database.prepare("INSERT INTO player_external_ids (id, player_id, provider, external_value, created_at_ms) VALUES (?, ?, 'nhl', ?, 10)")
    .run(uuid(n + 20), playerId, providerPlayerId);
  database.prepare(`INSERT INTO player_source_state
    (id, player_id, provider, source_position, normalized_position, nhl_team_abbreviation, active,
      source_version, source_payload_json, effective_at_ms, ended_at_ms, created_at_ms)
    VALUES (?, ?, ?, 'LW', 'F', ?, ?, 'original-version', ?, 20, NULL, 15)`)
    .run(sourceId, playerId, provider, team, active, '{ "unknown": [1, 2], "team": "historical provider payload" }');
  return { playerId, providerPlayerId, nhlTeamAbbreviation: team, sourceId };
}
function fixture(t) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrateDatabase({ database, migrationsDirectory: path.join(ROOT, 'database/migrations'), applicationBuildId: 'nhl-team-assignment-test', now: () => 100 });
  t.after(() => database.close());
  const first = seed(database, 1), second = seed(database, 2, { active: 0 });
  let next = 100;
  const repository = createSqliteNhlTeamAssignmentRepository({ database, createId: () => uuid(++next) });
  return { database, repository, first, second };
}
function assignment(player, team = 'NYR') {
  return { playerId: player.playerId, providerPlayerId: player.providerPlayerId, nhlTeamAbbreviation: team };
}
function command(assignments, overrides = {}) { return { observedAtMs: 1000, sourceVersion, assignments, ...overrides }; }
function row(database, id) { return database.prepare('SELECT * FROM player_source_state WHERE id = ?').get(id); }
function state(database) { return snapshotSqliteState(database); }

test('team assignment replaces only current NHL team metadata and audits exact preserved source history', t => {
  const { database, repository, first, second } = fixture(t);
  const before = state(database), sourceBefore = row(database, first.sourceId), secondBefore = row(database, second.sourceId);
  const counts = { cataloguePlayers: 2, indexPlayers: 2, matchedPlayers: 2, unchangedPlayers: 1, omittedPlayers: 0, confirmedChanges: 1 };
  let authorized = 0;
  const result = repository.applyAssignments(command([assignment(first)], { counts, authorizePersist: () => {
    authorized++; assert.equal(database.inTransaction, true);
    assert.deepEqual(row(database, first.sourceId), sourceBefore);
  } }));
  assert.equal(authorized, 1); assert.equal(result.changedPlayers, 1);
  assert.deepEqual(row(database, first.sourceId), { ...sourceBefore, ended_at_ms: 1000 });
  const after = database.prepare("SELECT * FROM player_source_state WHERE player_id = ? AND ended_at_ms IS NULL").get(first.playerId);
  assert.deepEqual(after, { ...sourceBefore, id: after.id, nhl_team_abbreviation: 'NYR', source_version: after.source_version,
    effective_at_ms: 1000, created_at_ms: 1000 });
  assert.match(after.source_version, /^[a-f0-9]{64}$/);
  assert.notEqual(after.source_version, sourceVersion);
  assert.deepEqual(row(database, second.sourceId), secondBefore);
  const afterState = state(database);
  for (const [table, records] of Object.entries(before.tables)) {
    if (!['player_source_state', 'operational_events'].includes(table)) assert.deepEqual(afterState.tables[table], records, table);
  }
  assert.deepEqual(afterState.foreignKeys, []);
  const event = database.prepare('SELECT * FROM operational_events WHERE id = ?').get(result.operationId);
  assert.equal(event.event_type, 'nhl_team_assignments_refreshed');
  assert.equal(event.actor_user_id, null);
  const evidence = JSON.parse(event.details_json);
  assert.equal(evidence.sourceVersion, sourceVersion); assert.deepEqual(evidence.counts, counts);
  assert.deepEqual(evidence.changes, [{ playerId: first.playerId, providerPlayerId: first.providerPlayerId, before: 'VAN', after: 'NYR',
    previousSourceStateId: first.sourceId, sourceStateId: after.id, sourceVersion: after.source_version }]);
  const readRepository = createSqlitePlayerRepository({ database });
  assert.equal(readRepository.findDetailById(first.playerId).nhl_team_abbreviation, 'NYR');
  assert.equal(repository.readPlayers().find(p => p.playerId === first.playerId).nhlTeamAbbreviation, 'NYR');
});

test('unchanged teams and omitted players cause no write, null cannot clear a team', t => {
  const { database, repository, first } = fixture(t);
  const before = state(database);
  assert.deepEqual(repository.applyAssignments(command([])), { changedPlayers: 0, unchangedPlayers: 0, skippedPlayers: 0, operationId: null });
  assert.deepEqual(repository.applyAssignments(command([assignment(first, 'VAN')])), { changedPlayers: 0, unchangedPlayers: 1, skippedPlayers: 0, operationId: null });
  assert.throws(() => repository.applyAssignments(command([assignment(first, null)])), { code: 'NHL_TEAM_ASSIGNMENT_INPUT_INVALID' });
  assert.deepEqual(state(database), before);
});

test('validates complete batch before writes and rejects invalid, duplicate, changed identity and stale snapshots atomically', t => {
  const { database, repository, first, second } = fixture(t);
  const before = state(database);
  for (const bad of [
    command([assignment(first), assignment(second, 'XXX')]),
    command([assignment(first), assignment(first)]),
    command([assignment(first)], { sourceVersion: 'unhashed' }),
    command([assignment(first)], { observedAtMs: -1 }),
    command([assignment(first)], { counts: { confirmedChanges: 1 } }),
    command([assignment(first)], { authorizePersist: true }),
    command([assignment(first)], { injected: true }),
  ]) {
    assert.throws(() => repository.applyAssignments(bad), { code: 'NHL_TEAM_ASSIGNMENT_INPUT_INVALID' });
    assert.deepEqual(state(database), before);
  }
  assert.throws(() => repository.applyAssignments(command([assignment(first), { ...assignment(second), providerPlayerId: '9999999' }])), { code: 'NHL_TEAM_ASSIGNMENT_IDENTITY_CHANGED' });
  database.prepare('UPDATE player_source_state SET effective_at_ms = 1100 WHERE id = ?').run(second.sourceId);
  const newer = state(database);
  assert.throws(() => repository.applyAssignments(command([assignment(first), assignment(second)])), { code: 'NHL_TEAM_ASSIGNMENT_STALE' });
  assert.deepEqual(state(database), newer);
});

test('same-time changed snapshots are rejected without synthetic future timestamps, replay is a no-op', t => {
  const { database, repository, first } = fixture(t);
  repository.applyAssignments(command([assignment(first)]));
  const before = state(database);
  assert.equal(repository.applyAssignments(command([assignment(first)])).changedPlayers, 0);
  assert.throws(() => repository.applyAssignments(command([assignment(first, 'TOR')])), { code: 'NHL_TEAM_ASSIGNMENT_STALE' });
  assert.throws(() => repository.applyAssignments(command([assignment(first)], { observedAtMs: 999 })), { code: 'NHL_TEAM_ASSIGNMENT_STALE' });
  assert.deepEqual(state(database), before);
  assert.equal(repository.applyAssignments(command([assignment(first, 'TOR')], { observedAtMs: 1001 })).changedPlayers, 1);
});

test('unsupported providers are skipped, never replaced or given fabricated NHL provenance', t => {
  const { database, repository, first } = fixture(t);
  const unsupported = seed(database, 3, { provider: 'sportsdataio-discovery-lab' });
  assert.equal(repository.readPlayers().some(p => p.playerId === unsupported.playerId), false);
  const before = row(database, unsupported.sourceId);
  const result = repository.applyAssignments(command([assignment(first), assignment(unsupported)]));
  assert.equal(result.changedPlayers, 1); assert.equal(result.skippedPlayers, 1);
  assert.deepEqual(row(database, unsupported.sourceId), before);
});

test('persistence authorization and insertion failures roll back the entire batch', t => {
  const { database, repository, first, second } = fixture(t);
  const before = state(database);
  assert.throws(() => repository.applyAssignments(command([assignment(first)], { authorizePersist: () => { throw new Error('lease lost'); } })), /lease lost/);
  assert.throws(() => repository.applyAssignments(command([assignment(first)], { authorizePersist: () => false })), { code: 'NHL_TEAM_ASSIGNMENT_PERSISTENCE_NOT_AUTHORIZED' });
  let calls = 0;
  const broken = createSqliteNhlTeamAssignmentRepository({ database, createId: () => ++calls < 3 ? uuid(500 + calls) : 'invalid' });
  assert.throws(() => broken.applyAssignments(command([assignment(first), assignment(second)])), { code: 'NHL_TEAM_ASSIGNMENT_ID_INVALID' });
  assert.deepEqual(state(database), before);
});

test('the actual FAD source-evidence immutability trigger permits closing pinned history and forbids editing its team', t => {
  // A narrow fixture loads the production trigger verbatim; unrelated FAD workflow
  // setup is omitted while the actual source-history protection runs unchanged.
  const database = new Database(':memory:'); t.after(() => database.close());
  const initial = fs.readFileSync(path.join(ROOT, 'database/migrations/0001_initial.sql'), 'utf8');
  database.exec(initial);
  database.exec('CREATE TABLE free_agent_draft_eligibility_revalidation_occurrences (source_state_before_id TEXT, source_state_after_id TEXT)');
  const migration = fs.readFileSync(path.join(ROOT, 'database/migrations/0036_add_fad_eligibility_revalidation_occurrences.sql'), 'utf8');
  database.exec(migration.match(/CREATE TRIGGER player_source_state_fad_eligibility_evidence_update[\s\S]*?\nEND;/)[0]);
  const player = seed(database, 1);
  database.prepare('INSERT INTO free_agent_draft_eligibility_revalidation_occurrences VALUES (?, ?)').run(player.sourceId, player.sourceId);
  const before = row(database, player.sourceId);
  assert.throws(() => database.prepare("UPDATE player_source_state SET nhl_team_abbreviation = 'NYR' WHERE id = ?").run(player.sourceId), /cannot be changed/);
  const repository = createSqliteNhlTeamAssignmentRepository({ database });
  assert.equal(repository.applyAssignments(command([assignment(player)])).changedPlayers, 1);
  assert.deepEqual(row(database, player.sourceId), { ...before, ended_at_ms: 1000 });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM free_agent_draft_eligibility_revalidation_occurrences').get().count, 1);
});
