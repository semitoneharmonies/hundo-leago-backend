const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseInjuryList, matchInjuryList } = require('../../src/domain/players/injuryListPolicy');
const { createReleaseQaFixture } = require('../../src/operations/release/createReleaseQaFixture');
const { fixtureId } = require('../../src/operations/release/releaseQaFixtureContract');
const { openDatabase } = require('../../src/infrastructure/database/connection');
const { createSqlitePlayerInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerInjuryRepository');
const { createSqliteTeamWorkspaceRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTeamWorkspaceRepository');
const { createPlayerInjuryService } = require('../../src/application/services/players/createPlayerInjuryService');
const { injuryProjection, canUseInjuredReserve } = require('../../src/domain/players/injuryStatusPolicy');

test('schema 90 upgrade preserves existing injury records and adds empty detail fields', t => {
  const Database = require('better-sqlite3');
  const { migrateDatabase, discoverMigrations, applyMigrations } = require('../../src/infrastructure/database/migrate');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'injury-migration-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const migrationsDirectory = path.resolve(__dirname, '../../database/migrations');
  for (const name of fs.readdirSync(migrationsDirectory).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 90)) {
    fs.copyFileSync(path.join(migrationsDirectory, name), path.join(root, name));
  }
  migrateDatabase({ database: db, migrationsDirectory: root, applicationBuildId: 'injury-upgrade-test' });
  const id = '11111111-1111-4111-8111-000000000001';
  db.prepare("INSERT INTO players(id,first_name,last_name,full_name,status,created_at_ms,updated_at_ms) VALUES(?,'Test','Player','Test Player','active',1,1)").run(id);
  db.prepare("INSERT INTO player_injury_status(id,status,source,evidence_at_ms,observed_at_ms,updated_at_ms,version) VALUES(?,'injured','admin',1,1,1,7)").run(id);
  const before = db.prepare('SELECT * FROM player_injury_status').get();
  const players = db.prepare('SELECT * FROM players').all();
  applyMigrations({ database: db, migrations: discoverMigrations({ migrationsDirectory }).filter(m => m.id <= 91), applicationBuildId: 'injury-upgrade-test' });
  assert.deepEqual(db.prepare('SELECT * FROM player_injury_status').get(), { ...before, timeline: null, designation: null, injury_reason: null });
  assert.deepEqual(db.prepare('SELECT * FROM players').all(), players);
  assert.equal(db.pragma('user_version', { simple: true }), 91);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('clipboard formats, absent status, aliases, ambiguity and malformed input fail closed', () => {
  const text = "Player\tTimeline\tStatus\tReason\r\nTanev, Christopher\t\r\nDay to Day\r\nIR\tUpper Body\r\nSýkora, Adam\tMonth to Month\tOUT\tLower Body\r\nMews, Henry\nDay to Day\nKnee";
  const rows = parseInjuryList(text);
  assert.equal(rows.length, 3); assert.equal(rows[2].designation, null);
  const players = [{ id: 'one', full_name: 'Chris Tanev' }, { id: 'two', full_name: 'Adam Sykora' }];
  let result = matchInjuryList(rows, players);
  assert.equal(result.matches.length, 2); assert.equal(result.unresolved[0].name, 'Henry Mews');
  assert.equal(matchInjuryList(rows, players, { henrymews: 'skip' }).skipped.length, 1);
  result = matchInjuryList(rows, [...players, { id: 'three', full_name: 'Chris Tanev' }]);
  assert.equal(result.unresolved[0].candidates.length, 2);
  assert.throws(() => matchInjuryList(rows, players, { christophertanev: 'skip' }), { code: 'INJURY_LIST_INVALID' });
  for (const bad of ['', 'garbage', text + '\nThis is not a player', 'Name, First\tDay to Day\tBOGUS\tLeg', text + '\nTanev, Christopher\tDay to Day\tIR\tHand']) {
    assert.throws(() => parseInjuryList(bad), { code: 'INJURY_LIST_INVALID' });
  }
});

test('review is read-only; apply is atomic, audited, exact, stale-safe and preserves two leagues', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'injury-list-'));
  const databasePath = path.join(root, 'injuries-release-qa.sqlite3');
  await createReleaseQaFixture({ databasePath, environment: 'test', migrationsDirectory: path.resolve(__dirname, '../../database/migrations'), password: 'hundo', temporaryRoot: root });
  const { database: db } = openDatabase({ databasePath, environment: 'test' });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const actorId = fixtureId('account:platformAdmin');
  const repo = createSqlitePlayerInjuryRepository({ database: db });
  const service = createPlayerInjuryService({ repository: repo, platformAuthorization: {
    requireAdministrator(authenticated) { if (authenticated !== 'admin') throw Object.assign(new Error(), { code: 'PLATFORM_ADMINISTRATOR_REQUIRED' }); return { actorUserId: actorId }; },
  } });
  const shared = db.prepare("SELECT player_id FROM player_ownerships WHERE roster_category='Injured Reserve' GROUP BY player_id HAVING count(DISTINCT league_id)>1 LIMIT 1").get().player_id;
  const other = db.prepare('SELECT id FROM players WHERE id<>? LIMIT 1').get(shared).id;
  // Use controlled names with real fixture identities in two leagues.
  db.prepare('UPDATE players SET full_name=? WHERE id=?').run('Jordan Staal', shared);
  db.prepare('UPDATE players SET full_name=? WHERE id=?').run('Chris Tanev', other);
  function protectedHash() {
    return crypto.createHash('sha256').update(JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'player_injury_%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))).digest('hex');
  }
  const before = protectedHash();
  const input = { text: 'Staal, Jordan\nDay to Day\nOUT\tLower Body\nTanev, Christopher\tWeek to Week\tIR\tUpper Body' };
  for (const authenticated of ['commissioner', 'manager', null]) {
    assert.throws(() => service.previewList({ input, authenticated }), { code: 'PLATFORM_ADMINISTRATOR_REQUIRED' });
    assert.throws(() => service.applyList({ input, authenticated }), { code: 'PLATFORM_ADMINISTRATOR_REQUIRED' });
  }
  const writes = db.prepare('SELECT total_changes() n').get().n;
  const preview = service.previewList({ input, authenticated: 'admin' });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, writes);
  assert.equal(preview.counts.add, 2);
  const applyInput = { ...input, expectedRevision: preview.revision, confirmReplacement: true };
  assert.throws(() => service.applyList({ input: { ...applyInput, confirmReplacement: false }, authenticated: 'admin' }), { code: 'INJURY_INPUT_INVALID' });
  // A mid-batch failure must roll back the statuses and their audit events.
  db.exec(`CREATE TEMP TRIGGER fail_second_injury BEFORE INSERT ON player_injury_status WHEN NEW.id='${other}' BEGIN SELECT RAISE(ABORT,'test rollback'); END`);
  assert.throws(() => service.applyList({ input: applyInput, authenticated: 'admin' }));
  assert.equal(db.prepare('SELECT count(*) n FROM player_injury_status').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM player_injury_events').get().n, 0);
  db.exec('DROP TRIGGER fail_second_injury');
  assert.equal(service.applyList({ input: applyInput, authenticated: 'admin' }).applied, 2);
  assert.throws(() => service.applyList({ input: applyInput, authenticated: 'admin' }), { code: 'INJURY_VERSION_CONFLICT' });
  const workspace = createSqliteTeamWorkspaceRepository({ database: db });
  for (const own of db.prepare('SELECT team_id,league_id FROM player_ownerships WHERE player_id=?').all(shared)) {
    const player = workspace.read({ leagueId: own.league_id, teamId: own.team_id }).players.find(p => p.player_id === shared);
    assert.deepEqual(player.injury.details, { timeline: 'Day to Day', designation: 'OUT', reason: 'Lower Body' });
    assert.equal(canUseInjuredReserve(player), true);
  }
  const noChange = service.previewList({ input, authenticated: 'admin' });
  assert.equal(noChange.changes.length, 0); assert.equal(noChange.counts.unchanged, 2);
  const recovery = { text: 'Tanev, Christopher\tMonth to Month\tIR\tHand' };
  const review = service.previewList({ input: recovery, authenticated: 'admin' });
  assert.equal(review.counts.clear, 1); assert.equal(review.counts.update, 1); assert.equal(review.warnings.length, 2);
  assert.equal(service.applyList({ input: { ...recovery, expectedRevision: review.revision, confirmReplacement: true }, authenticated: 'admin' }).applied, 2);
  assert.equal(injuryProjection(repo.read(shared)).details, undefined);
  assert.equal(canUseInjuredReserve({ injury: injuryProjection(repo.read(shared)), source_payload_json: '{"Status":"Injured Reserve"}' }), false);
  assert.equal(repo.read(shared).timeline, null); assert.equal(repo.read(other).injury_reason, 'Hand');
  assert.equal(db.prepare('SELECT count(*) n FROM player_injury_events WHERE action=? AND actor_user_id=?').get('admin_decision', actorId).n, 4);
  const unresolvedInput = { text: recovery.text + '\nAbsent, Player\tDay to Day\tOUT\tUndisclosed' };
  const unresolved = service.previewList({ input: unresolvedInput, authenticated: 'admin' });
  assert.equal(unresolved.canApply, false);
  assert.throws(() => service.applyList({ input: { ...unresolvedInput, expectedRevision: unresolved.revision, confirmReplacement: true }, authenticated: 'admin' }), { code: 'INJURY_LIST_INVALID' });
  assert.equal(service.previewList({ input: { ...unresolvedInput, resolutions: { playerabsent: 'skip' } }, authenticated: 'admin' }).canApply, true);
  assert.equal(protectedHash(), before, 'all other records including commissioner corrections and locked matchups preserved');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
