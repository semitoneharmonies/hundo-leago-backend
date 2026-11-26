const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { createSecurityFoundations } = require('../../src/bootstrap/createSecurityFoundations');
const { createTargetRuntime } = require('../../src/bootstrap/createTargetRuntime');
const { createSqliteRealtimeInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteRealtimeInjuryRepository');
const { createSqlitePlayerInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerInjuryRepository');
const reset = require('../../src/operations/guidedLeagueReset');

const NOW = Date.parse('2026-07-22T12:00:00Z');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAGUE = id(1), SEASON = id(2), ACTOR = id(3), OTHER = id(4);
const DIR = path.resolve(__dirname, '../../database/migrations');
const tipRows = db => ['tip_jar_runs', 'tip_jar_bests', 'tip_jar_guest_runs', 'tip_jar_guest_bests','mr_boni_runs','mr_boni_bests','mr_boni_guest_runs','mr_boni_guest_bests'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
const injuryRows = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'player_injury_*' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]));

function seedInjuries(db) {
  for (const n of [801, 802]) {
    db.prepare(`INSERT INTO players(id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms)
      VALUES (?,'Reset',?,?,'2000-01-01','active',1,1)`).run(id(n), `Player ${n}`, `Reset Player ${n}`);
    db.prepare("INSERT INTO player_external_ids(id,player_id,provider,external_value,created_at_ms) VALUES (?,?,'nhl',?,1)")
      .run(id(n + 100), id(n), String(8400000 + n));
  }
  db.prepare(`INSERT INTO player_injury_feed(id,player_id,name,birth_date,team,designation,injury_type,eligible,present,reported_at_ms,observed_at_ms,version)
    VALUES ('espn-fixture',?,'Reset Player 802','2000-01-01','VAN','OUT','Knee',1,1,1,2,3)`).run(id(802));
  db.prepare("INSERT INTO player_injury_sync(id,enabled,last_success_at_ms,last_attempt_at_ms,next_attempt_at_ms,error_code,version) VALUES ('espn',0,2,2,3,'INJURY_FEED_UNAVAILABLE',4)").run();
  db.prepare(`INSERT INTO player_injury_status(id,status,source,evidence_at_ms,observed_at_ms,review_reason,updated_at_ms,version,timeline,designation,injury_reason)
    VALUES (?,'injured','admin',3,3,'review',3,2,'Day to Day','OUT','Knee')`).run(id(802));
  let at = NOW;
  const automatic = createSqliteRealtimeInjuryRepository({ database: db, nowMs: () => at });
  automatic.registerMappings([{ providerPlayerId: 'realtime-fixture', nhlPlayerId: '8400801', providerName: 'Reset Player 801',
    verifiedAtMs: NOW - 1, evidenceUrls: ['https://www.nhl.com/player/8400801'] }]);
  const claim = automatic.claim({ occurrenceId: 'fixture-first', scheduledAtMs: NOW, atMs: NOW });
  automatic.apply({ source: 'realtime', fetchedAtMs: NOW, sourceGeneratedAtMs: null, sourceCount: 1, teamCount: 1,
    rows: [{ providerPlayerId: 'realtime-fixture', name: 'Reset Player 801', reportedAtMs: NOW - 100,
      status: 'injured', medicalReason: 'Illness', designation: 'OUT', teamId: '22', team: 'Vancouver Canucks', position: 'LW' }],
    quota: { remaining: 99, resetAtMs: NOW + 86400000 } }, claim.token);
  return () => {
    at = NOW + 1;
    createSqlitePlayerInjuryRepository({ database: db, nowMs: () => at }).decide({ playerId: id(801), status: 'healthy',
      expectedVersion: 1, reason: 'Later manual return confirmation', actorId: ACTOR });
    assert.equal(automatic.claim({ occurrenceId: 'fixture-later', scheduledAtMs: at, atMs: at }).status, 'claimed');
  };
}

async function fixture(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateDatabase({ database: db, migrationsDirectory: DIR, applicationBuildId: 'tip-jar-reset-test', now: () => NOW });
  t.after(() => db.close());
  const runtime = createTargetRuntime({ database: db, migrationsDirectory: DIR,
    securityFoundations: createSecurityFoundations({ env: {
      APP_ENV: 'staging', NODE_ENV: 'production', APP_BUILD_ID: 'tip-jar-reset-test', LOG_LEVEL: 'debug',
      SESSION_COOKIE_SAME_SITE: 'lax', PUBLIC_FRONTEND_ORIGIN: 'https://staging.hundoleago.com',
      FRONTEND_ORIGINS: 'https://staging.hundoleago.com', EMAIL_DELIVERY_MODE: 'capture',
      RATE_LIMIT_KEY_SECRET: 'tip-jar-reset-test-rate-secret-0123456789',
      AUDIT_METADATA_SECRET: 'tip-jar-reset-test-audit-secret-0123456789',
      ACTION_TOKEN_DELIVERY_KEY: Buffer.alloc(32, 0x5a).toString('base64url'),
    }, now: () => NOW, loggerSink() {} }),
    currentSeason: { label: '2026', nhlSeasonKey: '20262027' }, networkSourceResolver: () => '198.51.100.0/24',
  });
  const r = runtime.repositories.context.repositories;
  const timestamps = { created_at_ms: NOW - 10000, updated_at_ms: NOW - 10000, version: 1 };
  for (const n of [3, 10, 11, 12, 13]) r.users.insert({ id: id(n), email_normalized: `reset-${n}@example.test`,
    email_display: `reset-${n}@example.test`, display_name: `Reset ${n}`, display_name_normalized: `reset ${n}`, status: 'active', ...timestamps });
  for (const leagueId of [LEAGUE, OTHER]) r.leagues.insert({ id: leagueId, name: `Reset ${leagueId}`, name_normalized: `reset ${leagueId}`,
    status: 'setup', timezone: 'America/Vancouver', commissioner_membership_id: null, current_season_id: null, ...timestamps });
  r.league_settings.insert({ league_id: LEAGUE, salary_cap_cents: 10000, trade_deadline_at_ms: NOW + 90 * 86400000,
    maximum_teams: 20, active_forward_slots: 12, active_defence_slots: 6, bench_slots: 4, maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4, prospect_slots_unlimited: 1, scoring_rule_version: 1, standings_rule_version: 1, ...timestamps });
  r.seasons.insert({ id: SEASON, league_id: LEAGUE, label: '2026', nhl_season_key: '20262027', status: 'planned',
    regular_season_starts_at_ms: null, regular_season_ends_at_ms: null, fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null, free_agent_draft_completed_at_ms: null, ...timestamps });
  for (const n of [3, 10, 11, 12, 13]) r.league_memberships.insert({ id: id(100 + n), league_id: LEAGUE, user_id: id(n),
    permission_category: n === 3 ? 'commissioner' : 'manager', status: 'active', joined_at_ms: NOW - 10000, ended_at_ms: null, ...timestamps });
  r.leagues.updateVersioned({ key: LEAGUE, expectedVersion: 1, changes: { commissioner_membership_id: id(103), current_season_id: SEASON, updated_at_ms: NOW } });
  for (const n of [10, 11, 12, 13]) {
    r.teams.insert({ id: id(200 + n), league_id: LEAGUE, name: `Reset team ${n}`, name_normalized: `reset team ${n}`, status: 'setup',
      primary_colour: '#102030', secondary_colour: '#f0a020', tertiary_colour: null, pattern_template: 'even-two', logo_reference: null, ...timestamps });
    r.team_manager_assignments.insert({ id: id(300 + n), league_id: LEAGUE, team_id: id(200 + n), user_id: id(n), membership_id: id(100 + n),
      assigned_by_user_id: ACTOR, replaces_assignment_id: null, status: 'accepted', assigned_at_ms: NOW - 10000,
      accepted_at_ms: NOW - 10000, ended_at_ms: null, version: 1 });
  }
  const session = runtime.services.sessionService.issueForUser({ userId: ACTOR });
  const authenticated = runtime.services.sessionService.resolveWithoutActivity(session.rawSessionToken);
  const started = runtime.services.league.start.start({ leagueId: LEAGUE, input: {}, expectedLeagueVersion: 2, idempotencyKey: 'tip-reset-start', authenticated });
  runtime.services.league.matchupSchedule.generate({ leagueId: LEAGUE, seasonId: SEASON, expectedSeasonVersion: started.league.currentSeason.version,
    input: { nhlRegularSeasonStartsAtMs: Date.parse('2026-10-06T07:00:00Z'), nhlRegularSeasonEndsAtMs: Date.parse('2027-04-12T07:00:00Z'),
      fantasyPlayoffsStartAtMs: Date.parse('2027-03-15T07:00:00Z'), fantasyPlayoffsEndAtMs: Date.parse('2027-04-12T07:00:00Z'),
      firstWeekStartsAtMs: Date.parse('2026-10-12T07:00:00Z'), confirmed: true }, idempotencyKey: 'tip-reset-calendar', authenticated });
  assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded, 1);
  const input = { action: 'pause', reason: 'Review Tip Jar reset independence' };
  const preview = runtime.services.league.leaguePause.preview({ leagueId: LEAGUE, authenticated, input });
  runtime.services.league.leaguePause.apply({ leagueId: LEAGUE, authenticated, input: { ...input, confirmed: true, previewHash: preview.previewHash }, idempotencyKey: 'tip-reset-pause' });
  db.prepare("UPDATE outbox_events SET status='published',published_at_ms=?,updated_at_ms=?,version=version+1 WHERE status='pending'").run(NOW, NOW);
  for (const [leagueId, suffix] of [[LEAGUE, 1], [OTHER, 2]]) {
    db.prepare(`INSERT INTO tip_jar_runs(id,league_id,user_id,client_run_id,ruleset_version,seed,shots_json,result_json,created_at_ms,updated_at_ms,version)
      VALUES(?,?,?,?,'campaign-v1',42,?,?,?, ?,1)`).run(id(400 + suffix), leagueId, id(10), id(500 + suffix),
      JSON.stringify([{ time: 2, x: 0, height: .2, power: 30 }]), JSON.stringify({ highestLevelCompleted: 2, shotsToCompletion: 20 }), NOW, NOW);
    db.prepare(`INSERT INTO tip_jar_bests(id,league_id,user_id,run_id,ruleset_version,highest_level_completed,shots_to_completion,updated_at_ms)
      VALUES(?,?,?,?,'campaign-v1',2,20,?)`).run(id(600 + suffix), leagueId, id(10), id(400 + suffix), NOW);
    db.prepare(`INSERT INTO mr_boni_runs(id,league_id,user_id,client_run_id,ruleset_version,seed,commands_json,result_json,created_at_ms,updated_at_ms,version)
      VALUES(?,?,?,?,'resurface-v1',42,?,?,?, ?,1)`).run(id(400 + suffix), leagueId, id(10), id(500 + suffix),
      JSON.stringify([{ time: 2, x: 0, height: .2, power: 30 }]), JSON.stringify({ highestLevelCompleted: 2, cumulativeTimeMs: 20 }), NOW, NOW);
    db.prepare(`INSERT INTO mr_boni_bests(id,league_id,user_id,run_id,ruleset_version,highest_level_completed,cumulative_time_ms,updated_at_ms)
      VALUES(?,?,?,?,'resurface-v1',2,20,?)`).run(id(600 + suffix), leagueId, id(10), id(400 + suffix), NOW);
  }
  db.prepare(`INSERT INTO tip_jar_guest_runs(id,guest_hash,client_run_id,ruleset_version,seed,shots_json,result_json,created_at_ms,updated_at_ms,version)
    VALUES(?,?,?,'campaign-v1',42,'[]','{}',?,?,1)`).run(id(701), 'a'.repeat(64), id(702), NOW, NOW);
  db.prepare(`INSERT INTO tip_jar_guest_bests(id,guest_hash,run_id,ruleset_version,display_name,highest_level_completed,shots_to_completion,updated_at_ms)
    VALUES(?,?,?,'campaign-v1','Snow Guest',2,20,?)`).run(id(703), 'a'.repeat(64), id(701), NOW);
  db.prepare(`INSERT INTO mr_boni_guest_runs(id,guest_hash,client_run_id,ruleset_version,seed,commands_json,result_json,created_at_ms,updated_at_ms,version)
    VALUES(?,?,?,'resurface-v1',42,'[]','{}',?,?,1)`).run(id(701), 'a'.repeat(64), id(702), NOW, NOW);
  db.prepare(`INSERT INTO mr_boni_guest_bests(id,guest_hash,run_id,ruleset_version,display_name,highest_level_completed,cumulative_time_ms,updated_at_ms)
    VALUES(?,?,?,'resurface-v1','Snow Guest',2,20,?)`).run(id(703), 'a'.repeat(64), id(701), NOW);
  return db;
}

test('schema 97 guided reset and restore preserve populated games and all injury records, including later decisions', async t => {
  const db = await fixture(t);
  assert.equal(db.pragma('user_version', { simple: true }), 97);
  const updateInjuries = seedInjuries(db);
  const before = db.serialize(), originalScores = tipRows(db), originalInjuries = injuryRows(db), snapshot = reset.capture(db, LEAGUE);
  assert.equal(Object.keys(originalInjuries).length, 8);
  assert.equal(Object.values(originalInjuries).every(rows => rows.length > 0), true);
  assert.equal(snapshot.schemaVersion, 88, 'Existing encrypted archive format remains compatible');
  assert.equal(Object.keys(snapshot.tables).some(name => name.startsWith('tip_jar_')), false);
  assert.equal(reset.CLEAR_TABLES.some(name => name.startsWith('tip_jar_')), false);
  assert.equal(Object.keys(snapshot.tables).some(name => name.startsWith('player_injury_')), false);
  assert.equal(reset.CLEAR_TABLES.some(name => name.startsWith('player_injury_')), false);
  const proof = reset.rehearse(db, LEAGUE, ACTOR, NOW);
  assert.equal(proof.recoveryVerified, true);
  assert.deepEqual(db.serialize(), before, 'Rehearsal never mutates the source');
  const afterHash = db.transaction(() => reset.reset(db, LEAGUE, ACTOR, NOW)).immediate();
  assert.deepEqual(tipRows(db), originalScores);
  assert.deepEqual(injuryRows(db), originalInjuries);
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_cards WHERE league_id=?').get(LEAGUE).n, 0);
  assert.equal(db.prepare('SELECT status FROM leagues WHERE id=?').get(LEAGUE).status, 'setup');
  assert.equal(db.prepare('SELECT count(*) n FROM team_manager_assignments WHERE league_id=?').get(LEAGUE).n, 4);
  // A new game best after the fantasy reset must survive restoring its old archive.
  db.prepare('UPDATE tip_jar_bests SET shots_to_completion=19,updated_at_ms=? WHERE league_id=?').run(NOW + 1, LEAGUE);
  db.prepare('UPDATE tip_jar_guest_bests SET shots_to_completion=19,updated_at_ms=? WHERE id=?').run(NOW + 1, id(703));
  db.prepare('UPDATE mr_boni_bests SET cumulative_time_ms=19,updated_at_ms=? WHERE league_id=?').run(NOW + 1, LEAGUE);
  db.prepare('UPDATE mr_boni_guest_bests SET cumulative_time_ms=19,updated_at_ms=? WHERE id=?').run(NOW + 1, id(703));
  updateInjuries();
  const laterScores = tipRows(db), laterInjuries = injuryRows(db), resetBytes = db.serialize();
  assert.notDeepEqual(laterInjuries, originalInjuries);
  assert.equal(reset.rehearseRestore(db, snapshot, afterHash).recoveryVerified, true);
  assert.deepEqual(db.serialize(), resetBytes);
  db.transaction(() => reset.restore(db, snapshot)).immediate();
  assert.deepEqual(tipRows(db), laterScores, 'Restore preserves current game results, not archived scores');
  assert.deepEqual(injuryRows(db), laterInjuries, 'Restore preserves later manual decisions, provider attempts and all existing injury evidence');
  assert.deepEqual(reset.capture(db, LEAGUE), snapshot, 'All fantasy reset rows restore exactly');
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_cards WHERE league_id=?').get(LEAGUE).n, 4);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});

test('guided reset still rejects unreviewed schema versions and disabled foreign keys', async t => {
  const db = await fixture(t);
  for (const version of [87, 98, 101]) {
    db.pragma(`user_version=${version}`);
    assert.throws(() => reset.capture(db, LEAGUE), { code: 'LEAGUE_RESET_UNAVAILABLE' });
    assert.throws(() => reset.rehearse(db, LEAGUE, ACTOR, NOW), { code: 'LEAGUE_RESET_UNAVAILABLE' });
  }
  db.pragma('user_version=97');
  db.pragma('foreign_keys=OFF');
  assert.throws(() => reset.capture(db, LEAGUE), { code: 'LEAGUE_RESET_UNAVAILABLE' });
});
