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
  assert.equal(result.matches.length, 2); assert.equal(result.unresolved.length, 0);
  assert.equal(result.skipped[0].name, 'Henry Mews');
  assert.equal(matchInjuryList(rows, players, { henrymews: 'skip' }).skipped.length, 1);
  result = matchInjuryList(rows, [...players, { id: 'three', full_name: 'Chris Tanev' }]);
  assert.equal(result.unresolved[0].candidates.length, 2);
  assert.throws(() => matchInjuryList(rows, players, { christophertanev: 'skip' }), { code: 'INJURY_LIST_INVALID' });
  assert.throws(() => matchInjuryList(rows, players, { henrymews: 'one' }), { code: 'INJURY_LIST_INVALID' });
  const possibleMatch = matchInjuryList(rows, [...players, { id: 'three', full_name: 'Harry Mews' }]);
  assert.equal(possibleMatch.unresolved[0].name, 'Henry Mews');
  assert.equal(possibleMatch.unresolved[0].candidates[0].id, 'three');
  for (const bad of ['', 'garbage', text + '\nThis is not a player', 'Name, First\tDay to Day\tBOGUS\tLeg', text + '\nTanev, Christopher\tDay to Day\tIR\tHand']) {
    assert.throws(() => parseInjuryList(bad), { code: 'INJURY_LIST_INVALID' });
  }
});

test('clearly different first names skip while close spellings, initials and nickname variants require review', () => {
  for (const [input, catalogue] of [["Jake O'Brien", "Liam O'Brien"], ['Patrick Thomas', 'Robert Thomas'], ['Patrick Thomas', 'Pierre Thomas']]) {
    const split = input.lastIndexOf(' ');
    const rows = parseInjuryList(`${input.slice(split + 1)}, ${input.slice(0, split)}\tDay to Day\tOUT\tUpper Body`);
    const result = matchInjuryList(rows, [{ id: 'other-player', full_name: catalogue }]);
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.skipped.map(row => row.name), [input]);
    assert.throws(() => matchInjuryList(rows, [{ id: 'other-player', full_name: catalogue }], { [rows[0].key]: 'other-player' }), { code: 'INJURY_LIST_INVALID' });
  }
  for (const [input, catalogue] of [
    ['Jordyn', 'Jordan'], ['Henry', 'Harry'], ['Jake', 'Jack'],
    ['J.', 'Jordan'], ['Alex', 'Alexander'], ['Jhon', 'John'],
    ['Mika', 'Mike'], ['Kris', 'Chris'], ['Sean', 'Shawn'],
    ['Bill', 'William'], ['Jake', 'Jacob'], ['Jake', 'Jakob'],
    ['Drew', 'Andrew'], ['Andy', 'Andrew'], ['Nick', 'Nicholas'], ['Nick', 'Nikolas'], ['Nick', 'Nicolas'],
    ['Danny', 'Daniel'], ['Sammy', 'Samuel'], ['J.T.', 'Jonathan'], ['JT', 'Jonathan'],
    ['Gabriel', 'Jean-Gabriel'], ['Jean-Gabriel', 'Gabriel'],
    ['Bob', 'Robert'], ['Jim', 'James'], ['John', 'Jack'], ['Chuck', 'Charles'],
    ['Rick', 'Richard'], ['Ted', 'Edward'], ['Ted', 'Theodore'],
    ['Sasha', 'Alexander'], ['Mike', 'Michael'], ['Joe', 'Joseph'], ['Tom', 'Thomas'],
    ['Willy', 'William'], ['Robby', 'Robert'], ['Joey', 'Joseph'],
    ['Nate', 'Nathan'], ['Nate', 'Nathaniel'], ['Timmy', 'Timothy'], ['Tony', 'Anthony'],
    ['Matty', 'Matthew'], ['Mathieu', 'Matthew'], ['Matthieu', 'Matt'],
    ['Dany', 'Daniel'], ['Paddy', 'Patrick'], ['Frank', 'Francis'], ['Frankie', 'Francis'],
  ]) {
    const rows = parseInjuryList(`Sample, ${input}\tDay to Day\tOUT\tUpper Body`);
    const result = matchInjuryList(rows, [{ id: 'possible-player', full_name: `${catalogue} Sample` }]);
    assert.deepEqual(result.matches, [], `${input}/${catalogue} must never automatically identify a player`);
    assert.deepEqual(result.skipped, [], `${input}/${catalogue} must remain reviewable`);
    assert.deepEqual(result.unresolved[0].candidates.map(row => row.id), ['possible-player']);
  }
});

test('exact names and approved aliases take precedence over similar surname candidates', () => {
  const rows = parseInjuryList("O'Brien, Jake\tDay to Day\tOUT\tUpper Body\nTanev, Christopher\tDay to Day\tIR\tHand");
  const players = [
    { id: 'jake', full_name: "Jake O'Brien" }, { id: 'jack', full_name: "Jack O'Brien" },
    { id: 'liam', full_name: "Liam O'Brien" }, { id: 'chris', full_name: 'Chris Tanev' },
    { id: 'kris', full_name: 'Kris Tanev' },
  ];
  const result = matchInjuryList(rows, players);
  assert.deepEqual(result.matches.map(row => row.playerId), ['jake', 'chris']);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.skipped, []);
  assert.throws(() => matchInjuryList(rows, players, { jakeobrien: 'skip' }), { code: 'INJURY_LIST_INVALID' });
  const duplicate = matchInjuryList(rows, [...players, { id: 'second-jake', full_name: "Jake O'Brien" }]);
  assert.deepEqual(duplicate.unresolved[0].candidates.map(row => row.id), ['jake', 'second-jake']);
  const mixed = matchInjuryList(parseInjuryList('Thomas, Patrick\tDay to Day\tOUT\tUpper Body'), [
    { id: 'near', full_name: 'Patrik Thomas' }, { id: 'different', full_name: 'Robert Thomas' },
  ]);
  assert.deepEqual(mixed.unresolved[0].candidates.map(row => row.id), ['near']);
  assert.deepEqual(mixed.skipped, []);
});

test('review is read-only; apply is atomic, audited, exact, stale-safe and preserves two leagues', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'injury-list-'));
  const databasePath = path.join(root, 'injuries-release-qa.sqlite3');
  let db;
  t.after(() => { if (db?.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const migrationsDirectory = path.resolve(__dirname, '../../database/migrations');
  const fixtureMigrations = path.join(root, 'fixture-migrations');
  fs.mkdirSync(fixtureMigrations);
  // The shared release fixture verifies schema 95; upgrade its synthetic data
  // after that verification so this importer test still covers the current DB.
  for (const name of fs.readdirSync(migrationsDirectory).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 95)) {
    fs.copyFileSync(path.join(migrationsDirectory, name), path.join(fixtureMigrations, name));
  }
  await createReleaseQaFixture({ databasePath, environment: 'test', migrationsDirectory: fixtureMigrations, password: 'hundo', temporaryRoot: root });
  db = openDatabase({ databasePath, environment: 'test' }).database;
  const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
  migrateDatabase({ database: db, migrationsDirectory, applicationBuildId: 'injury-current-schema-test' });
  assert.equal(db.pragma('user_version', { simple: true }), 96);
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
  const surnamePlayers = db.prepare('SELECT id FROM players WHERE id NOT IN (?,?) LIMIT 3').all(shared, other);
  db.prepare('UPDATE players SET full_name=? WHERE id=?').run("Liam O'Brien", surnamePlayers[0].id);
  db.prepare('UPDATE players SET full_name=? WHERE id=?').run('Robert Thomas', surnamePlayers[1].id);
  db.prepare('UPDATE players SET full_name=? WHERE id=?').run('William Sample', surnamePlayers[2].id);
  function protectedHash() {
    return crypto.createHash('sha256').update(JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'player_injury_%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))).digest('hex');
  }
  const before = protectedHash();
  const input = { text: "Staal, Jordan\nDay to Day\nOUT\tLower Body\nTanev, Christopher\tWeek to Week\tIR\tUpper Body\nAbsent, Player\tDay to Day\tOUT\tUndisclosed\nO'Brien, Jake\tDay to Day\tOUT\tUpper Body\nThomas, Patrick\tDay to Day\tIR\tLower Body" };
  for (const authenticated of ['commissioner', 'manager', null]) {
    assert.throws(() => service.previewList({ input, authenticated }), { code: 'PLATFORM_ADMINISTRATOR_REQUIRED' });
    assert.throws(() => service.applyList({ input, authenticated }), { code: 'PLATFORM_ADMINISTRATOR_REQUIRED' });
  }
  const writes = db.prepare('SELECT total_changes() n').get().n;
  const preview = service.previewList({ input, authenticated: 'admin' });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, writes);
  assert.equal(preview.counts.add, 2);
  assert.equal(preview.canApply, true);
  assert.equal(preview.matched, 2);
  assert.equal(preview.unresolved.length, 0);
  assert.deepEqual(preview.skipped.map(row => row.name), ['Player Absent', "Jake O'Brien", 'Patrick Thomas']);
  const applyInput = { ...input, expectedRevision: preview.revision, confirmReplacement: true };
  assert.throws(() => service.applyList({ input: { ...applyInput, confirmReplacement: false }, authenticated: 'admin' }), { code: 'INJURY_INPUT_INVALID' });
  // A mid-batch failure must roll back the statuses and their audit events.
  db.exec(`CREATE TEMP TRIGGER fail_second_injury BEFORE INSERT ON player_injury_status WHEN NEW.id='${other}' BEGIN SELECT RAISE(ABORT,'test rollback'); END`);
  assert.throws(() => service.applyList({ input: applyInput, authenticated: 'admin' }));
  assert.equal(db.prepare('SELECT count(*) n FROM player_injury_status').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM player_injury_events').get().n, 0);
  db.exec('DROP TRIGGER fail_second_injury');
  const applied = service.applyList({ input: applyInput, authenticated: 'admin' });
  assert.equal(applied.applied, 2);
  assert.deepEqual(applied.skipped, ['Player Absent', "Jake O'Brien", 'Patrick Thomas']);
  for (const player of surnamePlayers) assert.equal(repo.read(player.id), null);
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
  const unknownOnlyInput = { text: "Absent, Player\tDay to Day\tOUT\tUndisclosed\nO'Brien, Jake\tDay to Day\tOUT\tUpper Body\nThomas, Patrick\tDay to Day\tIR\tLower Body" };
  const beforeUnknown = db.prepare('SELECT total_changes() n').get().n;
  const unknownOnly = service.previewList({ input: unknownOnlyInput, authenticated: 'admin' });
  assert.equal(unknownOnly.canApply, false, 'an entirely unknown list must not clear existing injuries');
  assert.equal(unknownOnly.skipped.length, 3);
  assert.throws(() => service.applyList({ input: { ...unknownOnlyInput, expectedRevision: unknownOnly.revision, confirmReplacement: true }, authenticated: 'admin' }), { code: 'INJURY_LIST_INVALID' });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, beforeUnknown);
  assert.equal(repo.read(other).status, 'injured');
  const ambiguousInput = { text: 'Tanev, Christopher\tMonth to Month\tIR\tHand\nStaal, Jordyn\tDay to Day\tOUT\tUndisclosed' };
  const ambiguous = service.previewList({ input: ambiguousInput, authenticated: 'admin' });
  assert.equal(ambiguous.canApply, false);
  assert.equal(ambiguous.unresolved[0].candidates[0].id, shared);
  assert.throws(() => service.applyList({ input: { ...ambiguousInput, expectedRevision: ambiguous.revision, confirmReplacement: true }, authenticated: 'admin' }), { code: 'INJURY_LIST_INVALID' });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, beforeUnknown);
  assert.equal(protectedHash(), before, 'all other records including commissioner corrections and locked matchups preserved');
  const william = surnamePlayers[2].id;
  service.decide({ input: { playerId: william, status: 'injured', expectedVersion: 0, reason: 'Synthetic nickname preservation check' }, authenticated: 'admin' });
  const nicknameInput = { text: 'Sample, Bill\tDay to Day\tOUT\tUpper Body\nTanev, Christopher\tMonth to Month\tIR\tHand' };
  const beforeNickname = db.serialize();
  const nickname = service.previewList({ input: nicknameInput, authenticated: 'admin' });
  assert.equal(nickname.canApply, false);
  assert.equal(nickname.matched, 1);
  assert.deepEqual(nickname.unresolved[0].candidates.map(row => row.id), [william]);
  assert.throws(() => service.applyList({ input: { ...nicknameInput, expectedRevision: nickname.revision, confirmReplacement: true }, authenticated: 'admin' }), { code: 'INJURY_LIST_INVALID' });
  assert.equal(repo.read(william).status, 'injured');
  assert(beforeNickname.equals(db.serialize()), 'nickname ambiguity cannot clear an existing injury or write any record');
  assert.equal(protectedHash(), before);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
