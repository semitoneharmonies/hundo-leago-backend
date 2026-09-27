const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createReleaseQaFixture } = require('../../src/operations/release/createReleaseQaFixture');
const { fixtureId, FIXTURE_NOW_MS } = require('../../src/operations/release/releaseQaFixtureContract');
const { openDatabase } = require('../../src/infrastructure/database/connection');
const { createSqlitePlayerInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerInjuryRepository');
const { createSqliteTeamWorkspaceRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTeamWorkspaceRepository');
const { createSqliteUserRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteUserRepository');
const { createSqlitePlatformRoleRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository');
const { createPlatformAuthorizationService } = require('../../src/application/services/authorization/requirePlatformAdministrator');
const { createPlayerInjuryService } = require('../../src/application/services/players/createPlayerInjuryService');
const { evaluateTeamRosterLegality } = require('../../src/application/services/leagues/createTeamWorkspaceService');
const { canUseInjuredReserve } = require('../../src/domain/players/injuryStatusPolicy');
const { evaluateMatchupLineupLegality } = require('../../src/domain/matchups/matchupLegalityPolicy');
const { createPlayerInjuryRouter } = require('../../src/transport/http/createPlayerInjuryRouter');
const { createTargetRequestSecurity } = require('../../src/transport/http/createTargetRequestSecurity');
const { createSessionCookie } = require('../../src/transport/http/sessionCookie');

test('global admin decisions, HTTP security, cross-league IR legality and preservation', async t => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../.test-temp/injuries-'));
  const databasePath = path.join(root, 'injury-release-qa.sqlite3');
  await createReleaseQaFixture({ databasePath, environment: 'test', migrationsDirectory: path.resolve(__dirname, '../../database/migrations'), password: 'hundo', temporaryRoot: root });
  const { database: db } = openDatabase({ databasePath, environment: 'test' });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repository = createSqlitePlayerInjuryRepository({ database: db, nowMs: () => FIXTURE_NOW_MS + 1000 });
  const platformAuthorization = createPlatformAuthorizationService({ userRepository: createSqliteUserRepository({ database: db }), platformRoleRepository: createSqlitePlatformRoleRepository({ database: db }) });
  const service = createPlayerInjuryService({ repository, platformAuthorization });
  const as = alias => { const id = fixtureId(`account:${alias}`); return { valid: true, user: { id }, session: { userId: id } }; };
  const admin = as('platformAdmin');
  const ir = db.prepare("SELECT player_id FROM player_ownerships WHERE roster_category='Injured Reserve' GROUP BY player_id HAVING count(DISTINCT league_id)>1 LIMIT 1").get();
  assert.ok(ir, 'fixture has a shared player on IR in two leagues');
  const playerId = ir.player_id;
  function fingerprint() {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'player_injury_%' ORDER BY name").all();
    return crypto.createHash('sha256').update(JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))).digest('hex');
  }
  const before = fingerprint();
  const writes = db.prepare('SELECT total_changes() AS n').get().n;
  service.list({ authenticated: admin });
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, writes, 'GET is read only');
  for (const actor of [as('leagueACommissioner'), as('leagueAManagerOne'), { valid: false }]) {
    assert.throws(() => service.decide({ authenticated: actor, input: { playerId, status: 'injured', reason: 'Team report', expectedVersion: 0 } }), { code: 'PLATFORM_ADMINISTRATOR_REQUIRED' });
  }
  assert.throws(() => service.decide({ authenticated: admin, input: { playerId, status: 'injured', reason: ' ', expectedVersion: 0 } }), { code: 'INJURY_INPUT_INVALID' });
  assert.throws(() => service.settings({ authenticated: admin, input: { enabled: true, expectedVersion: 1 } }), { code: 'INJURY_FEED_UNAVAILABLE' });
  await assert.rejects(service.refresh({ authenticated: admin }), { code: 'INJURY_FEED_UNAVAILABLE' });
  service.decide({ authenticated: admin, input: { playerId, status: 'injured', reason: 'Team reports injury', expectedVersion: 0 } });
  const workspace = createSqliteTeamWorkspaceRepository({ database: db });
  const owned = db.prepare("SELECT league_id,team_id FROM player_ownerships WHERE player_id=? AND roster_category='Injured Reserve'").all(playerId);
  function records() { return owned.map(row => workspace.read({ leagueId: row.league_id, teamId: row.team_id })); }
  for (const record of records()) {
    const player = record.players.find(row => row.player_id === playerId);
    assert.equal(player.injury.status, 'injured'); assert.equal(canUseInjuredReserve(player), true);
    assert.equal(evaluateTeamRosterLegality(record).reasons.some(reason => reason.code === 'HEALTHY_PLAYER_ON_IR'), false);
  }
  const origin = 'https://hundo.example', raw = Buffer.alloc(32, 1).toString('base64url'), csrf = Buffer.alloc(32, 2).toString('base64url');
  let actor = admin;
  const sessionCookie = createSessionCookie({ appEnv: 'staging', publicFrontendOrigin: origin, sameSite: 'none' });
  const requestSecurity = createTargetRequestSecurity({ isAllowedOrigin: value => value === origin, requestIdFactory: () => 'injury-test', sessionCookie,
    sessionService: { bootstrap: token => token === raw ? actor : { valid: false, code: 'SESSION_INVALID' }, resolveWithCsrf: ({ rawSessionToken, rawCsrfToken }) => rawSessionToken !== raw ? { valid: false, code: 'SESSION_INVALID' } : rawCsrfToken !== csrf ? { valid: false, code: 'CSRF_INVALID' } : actor } });
  const app = express(); app.use(createPlayerInjuryRouter({ requestSecurity, service }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/admin/injuries`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'X-CSRF-Token': csrf, Cookie: `${sessionCookie.name}=${raw}` };
  const body = JSON.stringify({ playerId, status: 'healthy', reason: 'Team confirms return to play', expectedVersion: 1 });
  assert.equal((await fetch(url + '/decide', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body })).status, 403);
  assert.equal(repository.read(playerId).status, 'injured');
  actor = as('leagueACommissioner');
  assert.equal((await fetch(url, { headers })).status, 403);
  assert.equal((await fetch(url + '/decide', { method: 'POST', headers, body })).status, 403);
  actor = admin;
  assert.equal((await fetch(url + '/decide', { method: 'POST', headers, body })).status, 200);
  assert.equal((await fetch(url + '/decide', { method: 'POST', headers, body })).status, 409, 'stale/repeated save cannot overwrite');
  for (const record of records()) {
    const player = record.players.find(row => row.player_id === playerId);
    assert.equal(player.injury.status, 'healthy'); assert.equal(canUseInjuredReserve(player), false);
    assert.ok(evaluateTeamRosterLegality(record).reasons.some(reason => reason.code === 'HEALTHY_PLAYER_ON_IR' && reason.playerId === playerId));
    assert.equal(evaluateTeamRosterLegality(record, { ownershipId: player.ownership_id, destinationCategory: 'Bench' }).reasons.some(reason => reason.code === 'HEALTHY_PLAYER_ON_IR'), false);
  }
  service.decide({ authenticated: admin, input: { playerId, status: 'unknown', reason: 'Return report retracted', expectedVersion: 2 } });
  assert.ok(records().every(record => !evaluateTeamRosterLegality(record).reasons.some(reason => reason.code === 'HEALTHY_PLAYER_ON_IR')));
  assert.equal(repository.list().history.length, 3);
  assert.equal(repository.list().history[0].actor, db.prepare('SELECT display_name FROM users WHERE id=?').get(admin.user.id).display_name);
  assert.equal(fingerprint(), before, 'every non-injury table, including all locked matchups, is unchanged');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('confirmed healthy IR blocks a future lineup; unknown status does not', () => {
  const lineup = [...Array.from({ length: 12 }, (_, i) => ({ position_group: 'F', slot_number: i + 1 })), ...Array.from({ length: 6 }, (_, i) => ({ position_group: 'D', slot_number: i + 1 }))];
  assert.equal(evaluateMatchupLineupLegality(lineup).legal, true);
  assert.deepEqual(evaluateMatchupLineupLegality(lineup.map(row => ({ ...row, healthy_ir_count: 1 }))).reasonCodes, ['HEALTHY_PLAYER_ON_IR']);
});
