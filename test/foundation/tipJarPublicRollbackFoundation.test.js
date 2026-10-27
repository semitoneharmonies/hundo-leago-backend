const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { createTargetRuntime, selectTargetRouterKey, TARGET_ENDPOINTS } = require('../../src/bootstrap/createTargetRuntime');
const { createSecurityFoundations } = require('../../src/bootstrap/createSecurityFoundations');
const { createSqliteLeagueDeletionRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteLeagueDeletionRepository');
const { seedFixture } = require('../../src/operations/release/createReleaseQaFixture');
const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(ROOT, 'database/migrations');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fingerprint(database) {
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => {
    const rows = database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    return [name, { count: rows.length, sha256: sha(JSON.stringify(rows)) }];
  }));
}
function security() {
  return createSecurityFoundations({ env: {
    APP_ENV:'staging', NODE_ENV:'production', APP_BUILD_ID:'tip-jar-schema95-rollback-test', LOG_LEVEL:'info',
    PUBLIC_FRONTEND_ORIGIN:'https://staging.hundoleago.com', FRONTEND_ORIGINS:'https://staging.hundoleago.com',
    SESSION_COOKIE_SAME_SITE:'lax', EMAIL_DELIVERY_MODE:'capture',
    RATE_LIMIT_KEY_SECRET:'synthetic-rollback-rate-limit-secret-0123456789',
    AUDIT_METADATA_SECRET:'synthetic-rollback-audit-secret-9876543210',
    ACTION_TOKEN_DELIVERY_KEY:Buffer.alloc(32,0x5a).toString('base64url'),
  }, now:()=>NOW, loggerSink(){} });
}
function options(database) {
  return { database, migrationsDirectory:MIGRATIONS, securityFoundations:security(),
    currentSeason:{label:'2026',nhlSeasonKey:'20262027'}, networkSourceResolver:()=> '198.51.100.0/24' };
}
async function populatedDatabase(t) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys=ON');
  t.after(()=>database.close());
  migrateDatabase({database,migrationsDirectory:MIGRATIONS,applicationBuildId:'rollback-synthetic-schema95',now:()=>NOW});
  const seeded = database.transaction(()=>seedFixture(database,'synthetic-fixture-password-hash')).immediate();
  await Promise.all(seeded.acceptancePromises);
  seeded.assertLateLockCoverage();
  const game = require('../fixtures/tip-jar-campaign.json');
  const managers = database.prepare(`SELECT league_id,user_id FROM team_manager_assignments
    WHERE status='accepted' AND ended_at_ms IS NULL GROUP BY league_id ORDER BY league_id LIMIT 2`).all();
  assert.equal(managers.length,2,'Fixture must contain two separate leagues with managers');
  for(const {league_id,user_id} of managers) {
    const runId=crypto.randomUUID();
    database.prepare(`INSERT INTO tip_jar_runs(id,league_id,user_id,client_run_id,ruleset_version,seed,shots_json,result_json,created_at_ms,updated_at_ms,version)
      VALUES(?,?,?,?,'campaign-v1',?,?,?,?,?,1)`).run(runId,league_id,user_id,crypto.randomUUID(),game.seed,JSON.stringify(game.shots),JSON.stringify(game.expected),NOW,NOW);
    database.prepare(`INSERT INTO tip_jar_bests(id,league_id,user_id,run_id,ruleset_version,highest_level_completed,shots_to_completion,updated_at_ms)
      VALUES(?,?,?,?,'campaign-v1',?,?,?)`).run(crypto.randomUUID(),league_id,user_id,runId,game.expected.highestLevelCompleted,game.expected.shotsToCompletion,NOW);
  }
  const guestHash='a'.repeat(64), guestRun=crypto.randomUUID();
  database.prepare(`INSERT INTO tip_jar_guest_runs(id,guest_hash,client_run_id,ruleset_version,seed,shots_json,result_json,created_at_ms,updated_at_ms,version)
    VALUES(?,?,?,'campaign-v1',?,?,?,?,?,1)`).run(guestRun,guestHash,crypto.randomUUID(),game.seed,JSON.stringify(game.shots),JSON.stringify(game.expected),NOW,NOW);
  database.prepare(`INSERT INTO tip_jar_guest_bests(id,guest_hash,run_id,ruleset_version,display_name,highest_level_completed,shots_to_completion,updated_at_ms)
    VALUES(?,?,?,'campaign-v1','Preserved Guest',?,?,?)`).run(crypto.randomUUID(),guestHash,guestRun,game.expected.highestLevelCompleted,game.expected.shotsToCompletion,NOW);
  return {database,managers};
}

test('rollback production source differs from accepted release only by six schema95 compatibility files',()=>{
  const manifest=require('../../rollback-source-manifest.json');
  assert.equal(manifest.acceptedCommit,'4ce2b62a0be20991d3de748423a3219c3ea2778b');
  const changed=[];
  for(const entry of manifest.files) {
    const actual=sha(fs.readFileSync(path.join(ROOT,entry.path)));
    assert.equal(actual,entry.rollbackSha256,entry.path);
    if(entry.acceptedSha256!==actual)changed.push(entry.path);
  }
  assert.deepEqual(changed.sort(),manifest.expectedChangedFiles.slice().sort());
  assert.deepEqual(changed.filter(name=>name.startsWith('src/')||name.startsWith('database/')).sort(),[
    'database/migrations/0095_add_tip_jar_guests.sql',
    'src/infrastructure/migration/resetManifest.js',
    'src/infrastructure/persistence/sqlite/repositoryCatalog.js',
    'src/operations/guidedLeagueReset.js',
    'src/operations/release/verifyReleaseQaFixture.js',
    'src/operations/release/verifyReleaseQaRuntime.js',
  ]);
  const runtimeDirectories=['src','database','routes','jobs','services','utils','validators'];
  const walk=folder=>fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(folder,entry.name)):[path.relative(ROOT,path.join(folder,entry.name)).replaceAll('\\','/')]);
  assert.deepEqual(runtimeDirectories.flatMap(name=>walk(path.join(ROOT,name))).sort(),
    manifest.files.filter(entry=>runtimeDirectories.some(name=>entry.path.startsWith(name+'/'))).map(entry=>entry.path).sort());
  for(const file of ['src/application/services/games/createTipJarPublicService.js',
    'src/infrastructure/persistence/sqlite/SqliteTipJarPublicRepository.js']) {
    assert.equal(fs.existsSync(path.join(ROOT,file)),false,file);
  }
});

test('schema95 rollback composes without changing populated fantasy, league scores, or new guest scores',async t=>{
  const {database,managers}=await populatedDatabase(t),before=fingerprint(database),bytes=database.serialize();
  assert.equal(before.tip_jar_runs.count,2); assert.equal(before.tip_jar_bests.count,2);
  assert.equal(before.tip_jar_guest_runs.count,1); assert.equal(before.tip_jar_guest_bests.count,1);
  assert(before.player_ownerships.count>0&&before.contracts.count>0&&before.auctions.count>0);
  const exact=migrateDatabase({database,migrationsDirectory:MIGRATIONS,applicationBuildId:'rollback-exact-check',now:()=>NOW+1});
  assert.equal(exact.status,'exact'); assert(bytes.equals(database.serialize()),'Exact schema check must not rewrite data');
  const runtime=createTargetRuntime(options(database));
  assert.equal(runtime.migrationState.userVersion,95); assert.equal(runtime.migrationState.status,'exact');
  assert.equal(typeof runtime.services.league.auctionResolution.resolveDue,'function');
  assert.equal(typeof runtime.services.account.signIn.signIn,'function');
  assert.equal(typeof runtime.services.league.tipJar.start,'function');
  assert.equal(typeof runtime.transport.routers.tipJar,'function');
  assert.equal(runtime.services.league.tipJarPublic,undefined);
  assert.equal(runtime.transport.routers.tipJarPublic,undefined); assert.equal(runtime.repositories.tipJarPublic,undefined);
  assert.equal(TARGET_ENDPOINTS.length,215);
  assert(!TARGET_ENDPOINTS.some(endpoint=>endpoint.path.startsWith('/api/v1/games/')));
  const deletion=createSqliteLeagueDeletionRepository({database});
  for(const manager of managers)deletion.snapshot(manager.league_id);
  assert.deepEqual(fingerprint(database),before); assert(bytes.equals(database.serialize()));
  assert.deepEqual(database.pragma('foreign_key_check'),[]);
  assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  const evidence={status:'passed',nodeVersion:process.version,database:'synthetic in-memory only',schemaVersion:95,
    tableCount:Object.keys(before).length,tipJarRows:{leagueRuns:2,leagueBests:2,guestRuns:1,guestBests:1},
    fingerprintsBefore:before,fingerprintsAfter:fingerprint(database),serializedBytesUnchanged:true,
    leagueGameServicePresent:true,publicGameServicePresent:false,acceptedFantasyRuntimeUnchanged:true};
  fs.mkdirSync(path.join(ROOT,'evidence'),{recursive:true});
  fs.writeFileSync(path.join(ROOT,'evidence/schema95-preservation.json'),JSON.stringify(evidence,null,2)+'\n');
});

test('rollback HTTP omits public games while preserving protected league game and fantasy dispatch without writes',async t=>{
  const {database}=await populatedDatabase(t),before=fingerprint(database),runtime=createTargetRuntime(options(database));
  const server=runtime.app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const league=database.prepare('SELECT id FROM leagues ORDER BY id LIMIT 1').get().id;
  const base=`http://127.0.0.1:${server.address().port}`,url='/api/v1/games/tip-jar';
  for(const [method,route] of [['GET',`${url}/leaderboard`],['POST',`${url}/runs`],
    ['POST',`${url}/runs/${crypto.randomUUID()}/checkpoint`],['POST',`${url}/runs/${crypto.randomUUID()}/name`],['OPTIONS',`${url}/runs`]]) {
    assert.equal(selectTargetRouterKey(method,route,method==='OPTIONS'?'POST':undefined),null);
    const response=await fetch(base+route,{method,headers:{Origin:'https://staging.hundoleago.com','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(response.status,404,`${method} ${route}`);
  }
  for(const route of [`/api/v1/leagues/${league}/tip-jar/leaderboard`,`/api/v1/leagues/${league}/auctions`]) {
    assert.notEqual(selectTargetRouterKey('GET',route),null);
    const response=await fetch(base+route,{headers:{Origin:'https://staging.hundoleago.com'}});
    assert.equal(response.status,401,route);
  }
  assert.deepEqual(fingerprint(database),before);
});

test('accepted league game still saves on schema95 while guest scores and all other tables remain unchanged',async t=>{
  const {database,managers}=await populatedDatabase(t),before=fingerprint(database),runtime=createTargetRuntime(options(database));
  const {league_id:leagueId,user_id:userId}=managers[0];
  const user=database.prepare('SELECT version FROM users WHERE id=?').get(userId);
  const authenticated={valid:true,user:{id:userId,status:'active',version:user.version},session:{id:crypto.randomUUID(),userId}};
  const service=runtime.services.league.tipJar;
  const board=service.leaderboard({authenticated,leagueId});
  assert(board.entries.some(entry=>entry.managerId===userId));
  const run=service.start({authenticated,leagueId,input:{clientRunId:crypto.randomUUID()}});
  await service.checkpoint({authenticated,leagueId,runId:run.runId,input:{shots:[{time:0,x:0,height:.16,power:15}]}});
  const after=fingerprint(database);
  assert.equal(after.tip_jar_runs.count,before.tip_jar_runs.count+1);
  assert.equal(after.tip_jar_bests.count,before.tip_jar_bests.count);
  for(const table of Object.keys(before).filter(name=>!['tip_jar_runs','tip_jar_bests'].includes(name))) {
    assert.deepEqual(after[table],before[table],table);
  }
  assert.deepEqual(after.tip_jar_bests,before.tip_jar_bests,'A new lower score must preserve the saved best');
  assert.deepEqual(database.pragma('foreign_key_check'),[]);
});
