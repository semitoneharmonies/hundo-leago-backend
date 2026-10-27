const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {test}=require('node:test');const Database=require('better-sqlite3');
const {migrateDatabase}=require('../../src/infrastructure/database/migrate');
const {createSecurityFoundations}=require('../../src/bootstrap/createSecurityFoundations');
const {createTargetRuntime,selectTargetRouterKey}=require('../../src/bootstrap/createTargetRuntime');
test('schema96 recovery boots with populated game records, serves TipJar, hides MrBoni and writes nothing',async t=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');t.after(()=>db.close());
  const migrationsDirectory=path.resolve(__dirname,'../../database/migrations'),now=Date.parse('2026-10-27T12:00:00Z');
  migrateDatabase({database:db,migrationsDirectory,applicationBuildId:'mr-boni-recovery-test',now:()=>now});
  const user=crypto.randomUUID(),league=crypto.randomUUID(),guest='a'.repeat(64);
  db.prepare("INSERT INTO users(id,email_normalized,email_display,display_name,display_name_normalized,status,created_at_ms,updated_at_ms,version) VALUES(?,'fixture@example.test','fixture@example.test','Recovery Manager','recovery manager','active',1,1,1)").run(user);
  db.prepare("INSERT INTO leagues(id,name,name_normalized,status,timezone,created_at_ms,updated_at_ms,version) VALUES(?,'Recovery league','recovery league','active','America/Vancouver',1,1,1)").run(league);
  for(const [prefix,version,metric] of [['tip_jar','campaign-v1',8],['mr_boni','resurface-v1',120000]]) {
    const run=crypto.randomUUID(),guestRun=crypto.randomUUID();
    db.prepare(`INSERT INTO ${prefix}_runs VALUES(?,?,?,?,?,42,'[]','{}',1,1,1)`).run(run,league,user,crypto.randomUUID(),version);
    db.prepare(`INSERT INTO ${prefix}_bests VALUES(?,?,?,?,?,2,?,1)`).run(crypto.randomUUID(),league,user,run,version,metric);
    db.prepare(`INSERT INTO ${prefix}_guest_runs VALUES(?,?,?,?,42,'[]','{}',1,1,1)`).run(guestRun,guest,crypto.randomUUID(),version);
    db.prepare(`INSERT INTO ${prefix}_guest_bests VALUES(?,?,?,?, 'Recovery Guest',2,?,1)`).run(crypto.randomUUID(),guest,guestRun,version,metric);
  }
  const before=db.serialize();
  const securityFoundations=createSecurityFoundations({env:{APP_ENV:'local',NODE_ENV:'development',APP_BUILD_ID:'mr-boni-recovery-test',LOG_LEVEL:'error',SESSION_COOKIE_SAME_SITE:'lax',PUBLIC_FRONTEND_ORIGIN:'http://localhost:5173',FRONTEND_ORIGINS:'http://localhost:5173',EMAIL_DELIVERY_MODE:'capture',RATE_LIMIT_KEY_SECRET:'recovery-test-rate-secret-0123456789',AUDIT_METADATA_SECRET:'recovery-test-audit-secret-0123456789',ACTION_TOKEN_DELIVERY_KEY:Buffer.alloc(32,0x5a).toString('base64url')},now:()=>now,loggerSink(){}});
  const runtime=createTargetRuntime({database:db,migrationsDirectory,securityFoundations,currentSeason:{label:'2026',nhlSeasonKey:'20262027'},networkSourceResolver:()=> '198.51.100.0/24'});
  assert.equal(runtime.migrationState.userVersion,96);assert.equal(runtime.services.accountEmail.job.isStarted(),false);
  assert.equal(selectTargetRouterKey('GET','/api/v1/games/mr-boni/leaderboard'),null);
  assert.equal(selectTargetRouterKey('GET','/api/v1/games/tip-jar/leaderboard'),'tipJar');
  assert.equal(runtime.services.league.tipJarPublic.leaderboard().entries.length,2);
  assert.deepEqual(db.serialize(),before);
  const server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`,headers={Origin:'http://localhost:5173'};
  const result=await fetch(origin+'/api/v1/games/tip-jar/leaderboard',{headers});assert.equal(result.status,200);assert.equal((await result.json()).data.entries.length,2);
  assert.equal((await fetch(origin+'/api/v1/games/mr-boni/leaderboard',{headers})).status,404);
  assert.deepEqual(db.serialize(),before);assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
});
