const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { createRosterRepairService } = require('../../src/application/services/leagues/createRosterRepairService');
const { createSqliteRosterRepairRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteRosterRepairRepository');
const { createSqliteRosterMovementRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteRosterMovementRepository');
const { createSqliteTeamWorkspaceRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTeamWorkspaceRepository');
const { createLeagueAuthorizationService } = require('../../src/application/services/authorization/requireLeagueAuthority');
const { createTeamAuthorizationService } = require('../../src/application/services/authorization/requireTeamManagerAuthority');
const { createSqliteLeagueAccessRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository');
const { createSqliteTeamAuthorityRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository');
const { createSqliteUserRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteUserRepository');
const { createRosterRepairRouter } = require('../../src/transport/http/createRosterRepairRouter');
const { createTargetRequestSecurity } = require('../../src/transport/http/createTargetRequestSecurity');
const { createSessionCookie } = require('../../src/transport/http/sessionCookie');
const { selectTargetRouterKey } = require('../../src/bootstrap/createTargetRuntime');
const NOW = 1_800_000_000_000, DAY = 86_400_000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const auth = n => ({ valid: true, user: { id: id(n), status: 'active' }, session: { id: id(n + 700), userId: id(n) } });
const template = new Database(':memory:');
migrateDatabase({ database: template, migrationsDirectory: path.resolve(__dirname, '../../database/migrations'), applicationBuildId: 'repair-test' });
const bytes = template.serialize(); template.close();
function fixture(t) {
  const db = new Database(bytes); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const insert = (table, row) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(key => '@' + key).join(',')})`).run(row);
  for (const n of [1, 2, 3]) insert('users', { id: id(n), email_normalized: `${n}@example.test`, email_display: `${n}@example.test`, display_name: `User ${n}`, display_name_normalized: `user ${n}`, status: 'active', created_at_ms: NOW, updated_at_ms: NOW });
  for (const n of [10, 20]) {
    insert('leagues', { id: id(n), name: `League ${n}`, name_normalized: `league ${n}`, status: 'active', timezone: 'America/Vancouver', created_at_ms: NOW, updated_at_ms: NOW });
    insert('seasons', { id: id(n + 1), league_id: id(n), label: '2026-27', nhl_season_key: '20262027', status: 'active', created_at_ms: NOW, updated_at_ms: NOW });
    insert('teams', { id: id(n + 2), league_id: id(n), name: `Team ${n}`, name_normalized: `team ${n}`, status: 'active', created_at_ms: NOW, updated_at_ms: NOW });
    insert('league_settings', { league_id: id(n), salary_cap_cents: 10000, maximum_teams: 32, scoring_rule_version: 1, standings_rule_version: 1, created_at_ms: NOW, updated_at_ms: NOW });
    insert('league_memberships', { id: id(n + 20), league_id: id(n), user_id: id(n === 10 ? 2 : 3), permission_category: 'commissioner', status: 'active', joined_at_ms: NOW, created_at_ms: NOW, updated_at_ms: NOW });
    db.prepare('UPDATE leagues SET current_season_id=?,commissioner_membership_id=? WHERE id=?').run(id(n + 1), id(n + 20), id(n));
  }
  insert('teams', { id: id(13), league_id: id(10), name: 'Opponent', name_normalized: 'opponent', status: 'active', created_at_ms: NOW, updated_at_ms: NOW });
  insert('league_memberships', { id: id(31), league_id: id(10), user_id: id(1), permission_category: 'manager', status: 'active', joined_at_ms: NOW, created_at_ms: NOW, updated_at_ms: NOW });
  insert('team_manager_assignments', { id: id(32), league_id: id(10), team_id: id(12), user_id: id(1), membership_id: id(31), assigned_by_user_id: id(2), status: 'accepted', assigned_at_ms: NOW, accepted_at_ms: NOW });
  let now = NOW, paused = false, scheduleError = false, scheduleHook = null, failSync = false, syncCalls = 0;
  const calls = [], scheduleCalls = [];
  const games = [{ id: 'one', startsAtMs: NOW + DAY, homeTeam: 'VAN', awayTeam: 'LAK', status: 'scheduled', timeTbd: false }];
  const workspace = createSqliteTeamWorkspaceRepository({ database: db, nowMs: () => now });
  const leagueAuthorization = createLeagueAuthorizationService({ userRepository: createSqliteUserRepository({ database: db }), leagueAccessRepository: createSqliteLeagueAccessRepository({ database: db }) });
  const teamAuthorization = createTeamAuthorizationService({ leagueAuthorization, teamAuthorityRepository: createSqliteTeamAuthorityRepository({ database: db }) });
  const movement = createSqliteRosterMovementRepository({ database: db, candidateCardSummerSynchronizer: { synchronize() { syncCalls++; if (failSync === syncCalls) throw new Error('synthetic sync failure'); } } });
  const service = createRosterRepairService({ repository: createSqliteRosterRepairRepository({ database: db }), workspaceRepository: workspace,
    rosterMovementRepository: movement, teamAuthorization, leagueAuthorization, clock: { nowMs: () => now },
    assertCompetitionOpen() { if (paused) throw Object.assign(new Error(), { code: 'LEAGUE_COMPETITION_PAUSED' }); },
    scheduleAdapter: { async readSchedule(input) { scheduleCalls.push(input); if (scheduleHook) await scheduleHook(); if (scheduleError) throw new Error('offline'); return { games: games.filter(row => row.startsAtMs >= input.startsAtMs && row.startsAtMs < input.endsAtMs), fetchedAtMs: NOW }; } },
    lateLockCoordinator: { async coordinateCommittedRoster(batch) { assert.equal(db.inTransaction, false); calls.push(batch); return { status: 'not_applicable' }; } } });
  const scope = { leagueId: id(10), teamId: id(12), authenticated: auth(1) };
  const add = (n, category = 'Active', options = {}) => {
    const league = options.league || 10, playerId = id(1000 + n), aav = options.aav || 100;
    insert('players', { id: playerId, first_name: 'Player', last_name: String(n), full_name: `Player ${n}`, status: 'active', created_at_ms: NOW, updated_at_ms: NOW });
    insert('player_source_state', { id: id(5000 + n), player_id: playerId, provider: 'sportsdataio-discovery-lab', source_position: options.position || 'F', normalized_position: options.position || 'F', nhl_team_abbreviation: options.team || 'VAN', active: 1, source_version: 'test', source_payload_json: '{}', effective_at_ms: NOW, created_at_ms: NOW });
    insert('player_ownerships', { id: id(2000 + n), league_id: id(league), season_id: id(league + 1), team_id: id(league + 2), player_id: playerId,
      ownership_kind: category === 'Prospect' ? 'Prospect Right' : 'Rostered', roster_category: category, position_group: options.position || 'F', slot_number: category === 'Prospect' ? null : Object.hasOwn(options, 'slot') ? options.slot : 1, acquired_transaction_type: 'migration', created_at_ms: NOW, updated_at_ms: NOW });
    if (category !== 'Prospect') {
      insert('contracts', { id: id(3000 + n), league_id: id(league), player_id: playerId, current_team_id: id(league + 2), contract_type: 'normal', original_total_value_cents: aav, original_term_years: 1, aav_cents: aav, start_season_id: id(league + 1), status: 'active', acquisition_source_type: 'migration', created_at_ms: NOW, updated_at_ms: NOW });
      insert('contract_years', { id: id(4000 + n), league_id: id(league), contract_id: id(3000 + n), season_id: id(league + 1), year_number: 1, aav_cents: aav, status: 'current', created_at_ms: NOW });
    }
    if (options.injury) insert('player_injury_status', { id: playerId, status: options.injury, source: 'admin', evidence_at_ms: NOW, observed_at_ms: NOW, updated_at_ms: NOW });
    return playerId;
  };
  const week = (n = 50, start = NOW - DAY, lock = NOW + 3600000, end = NOW + 6 * DAY) => insert('matchup_weeks', { id: id(n), league_id: id(10), season_id: id(11), week_key: `week-${n}`, sequence: n, starts_at_ms: start, baseline_at_ms: start, locks_at_ms: lock, ends_at_ms: end, rolls_over_at_ms: end, status: 'live', created_at_ms: NOW, updated_at_ms: NOW });
  const preview = () => service.preview({ ...scope, input: {} });
  const apply = revision => service.apply({ ...scope, input: { expectedRevision: revision, confirmed: true } });
  return { db, insert, add, week, service, scope, preview, apply, calls, scheduleCalls, games, workspace,
    setNow: value => { now = value; }, setPaused: value => { paused = value; }, setScheduleError: value => { scheduleError = value; }, setScheduleHook: value => { scheduleHook = value; }, setFailSync: value => { failSync = value; syncCalls = 0; } };
}
function snapshot(db, except = []) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().filter(row => !except.includes(row.name)).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

test('preview is read-only and confirmed repair preserves other leagues, prospects, contracts and pending trades', async t => {
  const f = fixture(t); f.week(); f.add(1, 'Injured Reserve', { injury: 'healthy' }); f.add(2, 'Prospect'); f.add(3, 'Active', { league: 20 });
  f.insert('trades', { id: id(80), league_id: id(10), season_id: id(11), proposing_team_id: id(12), receiving_team_id: id(13), proposing_user_id: id(1), creating_membership_id: id(31), creating_authority: 'manager', proposal_model_version: 2, status: 'proposed', created_at_ms: NOW, expires_at_ms: NOW + DAY, effective_deadline_at_ms: NOW + DAY, updated_at_ms: NOW });
  const before = f.db.serialize();
  const p = await f.preview(); assert.equal(p.canApply, true); assert.equal(p.strategy, 'scheduled_games'); assert.equal(p.moves[0].to, 'Active'); assert(before.equals(f.db.serialize()));
  const protectedBefore = snapshot(f.db, ['player_ownerships', 'ownership_events', 'league_activity', 'outbox_events', 'outbox_event_audiences']);
  const otherOwnerships = f.db.prepare('SELECT * FROM player_ownerships WHERE id<>? ORDER BY id').all(id(2001));
  const result = await f.apply(p.revision); assert.equal(result.legality.legal, true); assert.equal(result.moved, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].teams[0].ownershipWitnesses, [{ ownershipId: id(2001), ownershipVersion: 2, state: 'present' }]);
  assert.deepEqual(snapshot(f.db, ['player_ownerships', 'ownership_events', 'league_activity', 'outbox_events', 'outbox_event_audiences']), protectedBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM player_ownerships WHERE id<>? ORDER BY id').all(id(2001)), otherOwnerships);
  const saved = f.db.serialize(); await assert.rejects(f.apply(p.revision), { code: 'ROSTER_REPAIR_STALE' }); assert(saved.equals(f.db.serialize())); assert.equal(f.calls.length, 1);
});

test('full Active and IR swap is atomic, keeps Bench untouched, and coordinates only the final roster', async t => {
  const f = fixture(t); f.week();
  for (let n = 1; n <= 12; n++) f.add(n, 'Active', { slot: n, injury: n === 1 ? 'injured' : 'healthy' });
  for (let n = 13; n <= 18; n++) f.add(n, 'Active', { slot: n - 12, position: 'D' });
  for (let n = 19; n <= 22; n++) f.add(n, 'Bench', { slot: n - 18 });
  for (let n = 23; n <= 26; n++) f.add(n, 'Injured Reserve', { slot: n - 22, injury: n === 23 ? 'healthy' : 'injured', aav: 500 });
  const p = await f.preview(); assert.equal(p.canApply, true); assert.equal(p.moves.length, 2);
  f.setFailSync(2); const before = f.db.serialize(); await assert.rejects(f.apply(p.revision), error => error.cause?.message === 'synthetic sync failure'); assert(before.equals(f.db.serialize())); assert.equal(f.calls.length, 0);
  f.setFailSync(false); const result = await f.apply(p.revision); assert.equal(result.legality.legal, true); assert.equal(f.calls.length, 1);
  assert.equal(f.db.prepare('SELECT roster_category c FROM player_ownerships WHERE id=?').get(id(2001)).c, 'Injured Reserve');
  assert.equal(f.db.prepare('SELECT roster_category c FROM player_ownerships WHERE id=?').get(id(2023)).c, 'Active');
  assert.deepEqual(f.calls[0].teams[0].ownershipWitnesses, [{ ownershipId: id(2001), ownershipVersion: 2, state: 'present' }, { ownershipId: id(2023), ownershipVersion: 3, state: 'present' }]);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('state changes, revoked manager authority and pause reject apply without writes', async t => {
  for (const change of ['injury', 'contract', 'ownership', 'cap', 'week', 'lock', 'schedule', 'membership', 'pause']) {
    const f = fixture(t); f.week(); f.add(1, 'Injured Reserve', { injury: 'healthy' }); const p = await f.preview();
    if (change === 'injury') f.db.prepare("UPDATE player_injury_status SET status='injured',version=version+1 WHERE id=?").run(id(1001));
    if (change === 'contract') f.db.prepare('UPDATE contracts SET version=version+1 WHERE id=?').run(id(3001));
    if (change === 'ownership') f.db.prepare('UPDATE player_ownerships SET version=version+1 WHERE id=?').run(id(2001));
    if (change === 'cap') f.db.prepare('UPDATE league_settings SET salary_cap_cents=10001,version=version+1 WHERE league_id=?').run(id(10));
    if (change === 'week') f.db.prepare('UPDATE matchup_weeks SET version=version+1 WHERE id=?').run(id(50));
    if (change === 'lock') f.insert('matchup_roster_locks', { id: id(903), league_id: id(10), season_id: id(11), matchup_week_id: id(50), team_id: id(12), lock_type: 'normal', legal: 0, legality_reason_code: 'HEALTHY_PLAYER_ON_IR', locked_at_ms: NOW, source_freshness_status: 'unknown', created_at_ms: NOW });
    if (change === 'schedule') f.games[0] = { ...f.games[0], id: 'changed-game' };
    if (change === 'membership') f.db.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=? WHERE id=?").run(NOW, id(32));
    if (change === 'pause') f.setPaused(true);
    const before = f.db.serialize(); await assert.rejects(f.apply(p.revision)); assert(before.equals(f.db.serialize())); assert.equal(f.calls.length, 0);
  }
});

test('source-slot auto placement is included in final committed ownership witnesses', async t => {
  const f = fixture(t); f.week();
  for (let n = 1; n <= 13; n++) f.add(n, 'Active', { slot: n === 13 ? null : n, injury: n === 1 ? 'injured' : 'healthy' });
  const p = await f.preview(); assert.equal(p.moves.length, 1); assert.equal(p.moves[0].playerId, id(1001));
  await f.apply(p.revision);
  assert.deepEqual(f.calls[0].teams[0].ownershipWitnesses, [{ ownershipId: id(2001), ownershipVersion: 2, state: 'present' }, { ownershipId: id(2013), ownershipVersion: 2, state: 'present' }]);
  assert.equal(f.db.prepare('SELECT slot_number n FROM player_ownerships WHERE id=?').get(id(2013)).n, 1);
});

test('authority and state are rechecked after the schedule provider wait', async t => {
  const f = fixture(t); f.week(); f.add(1, 'Injured Reserve', { injury: 'healthy' }); const p = await f.preview(); let afterChange;
  f.setScheduleHook(() => { f.db.prepare('UPDATE contracts SET version=version+1 WHERE id=?').run(id(3001)); afterChange = f.db.serialize(); });
  await assert.rejects(f.apply(p.revision), { code: 'ROSTER_REPAIR_STALE' }); assert(afterChange.equals(f.db.serialize())); assert.equal(f.calls.length, 0);
  f.setScheduleHook(null); const fresh = await f.preview();
  f.setScheduleHook(() => { f.db.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=? WHERE id=?").run(NOW, id(32)); afterChange = f.db.serialize(); });
  await assert.rejects(f.apply(fresh.revision), { code: 'LEAGUE_COMMISSIONER_REQUIRED' }); assert(afterChange.equals(f.db.serialize())); assert.equal(f.calls.length, 0);
  const changedWeek = fixture(t); changedWeek.week(); changedWeek.add(1, 'Injured Reserve', { injury: 'healthy' });
  changedWeek.setScheduleHook(() => { changedWeek.db.prepare('UPDATE matchup_weeks SET ends_at_ms=ends_at_ms+1000,rolls_over_at_ms=rolls_over_at_ms+1000,version=version+1 WHERE id=?').run(id(50)); afterChange = changedWeek.db.serialize(); });
  await assert.rejects(changedWeek.preview(), { code: 'ROSTER_REPAIR_STALE' }); assert(afterChange.equals(changedWeek.db.serialize())); assert.equal(changedWeek.calls.length, 0);
});

test('commissioners may repair their league; other teams and leagues cannot be accessed', async t => {
  const f = fixture(t); f.add(1, 'Injured Reserve', { injury: 'healthy' });
  const before = f.db.serialize();
  await assert.rejects(f.service.preview({ ...f.scope, teamId: id(13), input: {} }), { code: 'LEAGUE_COMMISSIONER_REQUIRED' });
  await assert.rejects(f.service.preview({ ...f.scope, leagueId: id(20), teamId: id(22), input: {} }), { code: 'LEAGUE_NOT_FOUND' });
  await assert.rejects(f.service.preview({ ...f.scope, authenticated: auth(3), input: {} }), { code: 'LEAGUE_NOT_FOUND' });
  assert(before.equals(f.db.serialize()));
  const p = await f.service.preview({ ...f.scope, authenticated: auth(2), input: {} });
  assert.equal((await f.service.apply({ ...f.scope, authenticated: auth(2), input: { expectedRevision: p.revision, confirmed: true } })).legality.legal, true);
  assert.equal(f.db.prepare('SELECT actor_authority a FROM league_activity').get().a, 'commissioner');
});

test('schedule failure or unknown team uses minimal moves, while no solution and already legal never write', async t => {
  const f = fixture(t); f.week(); f.add(1, 'Injured Reserve', { injury: 'healthy', team: 'ABC' });
  let p = await f.preview(); assert.equal(p.strategy, 'legality_only'); assert.equal(p.before.scheduledGames, null); assert.equal(p.canApply, true);
  f.setScheduleError(true); p = await f.preview(); assert.equal(p.strategy, 'legality_only');
  await f.apply(p.revision); const saved = f.db.serialize(); assert.equal((await f.preview()).status, 'already_legal'); assert(saved.equals(f.db.serialize()));
  const impossible = fixture(t); impossible.add(1, 'Injured Reserve', { injury: 'healthy', aav: 10100 });
  const before = impossible.db.serialize(); const blocked = await impossible.preview(); assert.equal(blocked.status, 'no_solution'); assert.equal(blocked.canApply, false); assert.equal(blocked.revision, null); assert(before.equals(impossible.db.serialize()));
  assert.match(blocked.blockers.join(' '), /move controls.*Bench.*\$4.*IR.*trade.*contract/s);
  const tbd = fixture(t); tbd.week(); tbd.add(1, 'Injured Reserve', { injury: 'healthy' }); tbd.games[0].timeTbd = true;
  const noTimes = await tbd.preview(); assert.equal(noTimes.strategy, 'legality_only'); assert.equal(noTimes.after.scheduledGames, null); assert.equal(noTimes.canApply, true);
});

test('game counts normalize teams and include normal-week past games but exclude started games for late repair', async t => {
  const f = fixture(t); f.week(); f.add(1, 'Injured Reserve', { injury: 'healthy', team: 'LA' });
  f.games.push({ id: 'past', startsAtMs: NOW - 1000, homeTeam: 'LAK', awayTeam: 'NJD', status: 'final' }, { id: 'live', startsAtMs: NOW - 500, homeTeam: 'LAK', awayTeam: 'NJD', status: 'live' });
  let p = await f.preview(); assert.equal(p.after.scheduledGames, 3); assert.equal(p.timing, 'before_lock');
  f.setNow(NOW + 3600001); p = await f.preview(); assert.equal(p.after.scheduledGames, 1); assert.equal(p.timing, 'late_lock');
  f.setScheduleHook(() => { f.setNow(NOW + DAY + 1); }); const before = f.db.serialize(); await assert.rejects(f.apply(p.revision), { code: 'ROSTER_REPAIR_STALE' }); assert(before.equals(f.db.serialize()));
});

test('a legal existing current-week lock is preserved and the next saved week is targeted', async t => {
  const f = fixture(t); f.week(); f.week(51, NOW + 6 * DAY, NOW + 6 * DAY + 3600000, NOW + 13 * DAY); f.add(1, 'Injured Reserve', { injury: 'healthy' });
  f.insert('stat_sources', { id: id(900), provider: 'test', status: 'active', created_at_ms: NOW, updated_at_ms: NOW });
  f.insert('stat_refreshes', { id: id(901), stat_source_id: id(900), nhl_season_key: '20262027', status: 'succeeded', started_at_ms: NOW, completed_at_ms: NOW });
  f.insert('stat_snapshots', { id: id(902), stat_source_id: id(900), source_refresh_id: id(901), league_id: id(10), season_id: id(11), matchup_week_id: id(50), intended_use: 'matchup_baseline', completeness_status: 'complete', freshness_status: 'fresh', captured_at_ms: NOW, committed: 1, created_at_ms: NOW });
  f.insert('matchup_roster_locks', { id: id(903), league_id: id(10), season_id: id(11), matchup_week_id: id(50), team_id: id(12), lock_type: 'normal', legal: 1, locked_at_ms: NOW, baseline_snapshot_id: id(902), source_freshness_status: 'fresh', created_at_ms: NOW });
  const locks = f.db.prepare('SELECT * FROM matchup_roster_locks').all(); const snapshots = f.db.prepare('SELECT * FROM stat_snapshots').all();
  const p = await f.preview(); assert.equal(p.week.id, id(51)); assert.equal(p.timing, 'future_week'); assert.match(p.message, /already locked/);
  await f.apply(p.revision); assert.deepEqual(f.db.prepare('SELECT * FROM matchup_roster_locks').all(), locks); assert.deepEqual(f.db.prepare('SELECT * FROM stat_snapshots').all(), snapshots);
});

test('HTTP repair enforces session, CSRF, origin, exact confirmation and server-owned plan', async t => {
  const f = fixture(t); f.week(); f.add(1, 'Injured Reserve', { injury: 'healthy' });
  const origin = 'http://localhost:5173', token = Buffer.alloc(32, 42).toString('base64url'), csrf = Buffer.alloc(32, 43).toString('base64url');
  const cookie = createSessionCookie({ appEnv: 'local', publicFrontendOrigin: origin, sameSite: 'lax' });
  const security = createTargetRequestSecurity({ sessionCookie: cookie, isAllowedOrigin: value => value === origin, requestIdFactory: () => 'repair-test', sessionService: {
    bootstrap: value => value === token ? auth(1) : { valid: false }, resolveWithCsrf: ({ rawSessionToken, rawCsrfToken }) => rawSessionToken !== token ? { valid: false, code: 'SESSION_INVALID' } : rawCsrfToken !== csrf ? { valid: false, code: 'CSRF_INVALID' } : auth(1) } });
  const app = express(); app.use(createRosterRepairRouter({ requestSecurity: security, service: f.service })); const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `/api/v1/leagues/${id(10)}/teams/${id(12)}/roster/`, url = `http://127.0.0.1:${server.address().port}${base}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', Cookie: `${cookie.name}=${token}`, 'X-CSRF-Token': csrf };
  const before = f.db.serialize();
  for (const [changed, status] of [[{ Cookie: '' }, 401], [{ 'X-CSRF-Token': 'bad' }, 403], [{ Origin: 'https://invalid.example' }, 403]]) {
    assert.equal((await fetch(url + 'repair-preview', { method: 'POST', headers: { ...headers, ...changed }, body: '{}' })).status, status);
  }
  assert(before.equals(f.db.serialize()));
  const p = (await (await fetch(url + 'repair-preview', { method: 'POST', headers, body: '{}' })).json()).data;
  for (const body of [{ expectedRevision: p.revision, confirmed: false }, { expectedRevision: p.revision, confirmed: true, moves: [] }, { confirmed: true }]) {
    assert.equal((await fetch(url + 'repair', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert(before.equals(f.db.serialize()));
  const response = await fetch(url + 'repair', { method: 'POST', headers, body: JSON.stringify({ expectedRevision: p.revision, confirmed: true }) }); assert.equal(response.status, 200); assert.equal((await response.json()).data.legality.legal, true);
  for (const suffix of ['repair-preview', 'repair']) assert.equal(selectTargetRouterKey('POST', base + suffix), 'rosterRepair');
});
