const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { migrateDatabase, applyMigrations, discoverMigrations } = require('../../src/infrastructure/database/migrate');
const { createSqliteRepositoryContext } = require('../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext');
const { createSqliteTipJarPublicRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTipJarPublicRepository');
const { createTipJarPublicService, guestIdentity, displayName } = require('../../src/application/services/games/createTipJarPublicService');
const { createTipJarRouter } = require('../../src/transport/http/createTipJarRouter');
const { createTargetRequestSecurity } = require('../../src/transport/http/createTargetRequestSecurity');
const { createSessionCookie } = require('../../src/transport/http/sessionCookie');
const { createAuthenticationRateLimiter } = require('../../src/application/services/accounts/createAuthenticationRateLimiter');
const { createSqliteAuthenticationRateLimitRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteAuthenticationRateLimitRepository');
const { selectTargetRouterKey } = require('../../src/bootstrap/createTargetRuntime');
const DIR=path.resolve(__dirname,'../../database/migrations'), NOW=Date.parse('2026-10-26T12:00:00Z');
const key=()=>crypto.randomBytes(32).toString('hex');
const shots=(count)=>Array.from({length:count},(_,index)=>({time:index*7,x:0,height:.16,power:100}));
function verify({shots}) {
  if(shots.some((shot,index)=>shot.x===1 || (index && shot.time<=shots[index-1].time)) || shots.length>13)throw Error('Invalid fixture transcript');
  const highest=shots.length>=13?3:shots.length>=8?2:shots.length>=3?1:0;
  return {highestLevelCompleted:highest,shotsToCompletion:highest===3?13:highest===2?8:highest===1?3:null,
    shotsUsed:shots.length,level:Math.min(3,highest+1),pucks:20+Math.min(2,highest)*20-shots.length,
    completed:highest===3,failed:false,levelResults:[{level:1,shots:3,totalShots:3},{level:2,shots:5,totalShots:8},{level:3,shots:5,totalShots:13}].slice(0,highest)};
}
function setup(t,verifier=verify) {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');t.after(()=>database.close());
  migrateDatabase({database,migrationsDirectory:DIR,applicationBuildId:'guest-games-test',now:()=>NOW});
  const context=createSqliteRepositoryContext({database}),repository=createSqliteTipJarPublicRepository({database});
  const dependencies={repositoryContext:context,repository,clock:{nowMs:()=>NOW},secureRandom:{id:crypto.randomUUID,bytes:crypto.randomBytes},...(verifier?{verifyRun:verifier}:{})};
  return {database,context,repository,dependencies,service:createTipJarPublicService(dependencies)};
}
const start=(r,guestKey=key(),clientRunId=crypto.randomUUID())=>({guestKey,...r.service.start({input:{guestKey,clientRunId}})});
const checkpoint=(r,run,record)=>r.service.checkpoint({runId:run.runId,input:{guestKey:run.guestKey,shots:record}});
const name=(r,run,value='Pond Player')=>r.service.name({runId:run.runId,input:{guestKey:run.guestKey,name:value}});
function protectedRows(database,excluded=[]) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'tip_jar_guest_%' ORDER BY name").all()
    .filter(({name})=>!excluded.includes(name)).map(({name})=>[name,database.prepare(`SELECT * FROM "${name}"`).all()]);
}
test('schema95 is additive over populated league game storage and repeat migration is inert',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');
  const migrations=discoverMigrations({migrationsDirectory:DIR}).filter(m=>m.id<=95);
  applyMigrations({database:db,migrations:migrations.filter(m=>m.id<=94),applicationBuildId:'before',now:()=>NOW});
  const user=crypto.randomUUID(),league=crypto.randomUUID(),run=crypto.randomUUID();
  db.prepare(`INSERT INTO users(id,email_normalized,email_display,display_name,display_name_normalized,status,created_at_ms,updated_at_ms,version)
    VALUES (?,'preserved@example.test','preserved@example.test','Preserved','preserved','active',?,?,1)`).run(user,NOW,NOW);
  db.prepare(`INSERT INTO leagues(id,name,name_normalized,status,timezone,commissioner_membership_id,current_season_id,created_at_ms,updated_at_ms,version)
    VALUES (?,'Preserved league','preserved league','active','America/Vancouver',NULL,NULL,?,?,1)`).run(league,NOW,NOW);
  db.prepare("INSERT INTO tip_jar_runs VALUES (?,?,?,?,'campaign-v1',42,'[]','{}',?,?,1)").run(run,league,user,crypto.randomUUID(),NOW,NOW);
  db.prepare("INSERT INTO tip_jar_bests VALUES (?,?,?,?,'campaign-v1',2,8,?)").run(crypto.randomUUID(),league,user,run,NOW);
  const definitions=db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const before=protectedRows(db,['schema_migrations','application_metadata']);
  applyMigrations({database:db,migrations,applicationBuildId:'after',now:()=>NOW});
  assert.deepEqual(protectedRows(db,['schema_migrations','application_metadata']),before);
  for(const row of definitions)assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(row.name).sql,row.sql);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('user_version',{simple:true}),95);
  const bytes=db.serialize();applyMigrations({database:db,migrations,applicationBuildId:'repeat',now:()=>NOW});assert.deepEqual(db.serialize(),bytes);
});
test('guest replay, qualification, naming and improved bests are isolated, idempotent and private',async t=>{
  const r=setup(t),before=protectedRows(r.database),guest=key(),client=crypto.randomUUID(),run=start(r,guest,client);
  assert.equal(start(r,guest,client).runId,run.runId);assert.notEqual(start(r,key(),client).runId,run.runId);
  assert.deepEqual(r.service.leaderboard().entries,[]);assert.deepEqual(name(r,run),{saved:false,qualifies:false});
  let result=await checkpoint(r,run,shots(3));assert.equal(result.qualifies,true);assert.equal(result.named,false);
  assert.deepEqual(r.service.leaderboard().entries,[],'Unnamed scores stay private');
  assert.deepEqual(name(r,run,'  Snow  Cat '),{saved:true,qualifies:true});
  const row=r.service.leaderboard().entries[0];assert.equal(row.playerName,'Snow Cat');assert.equal(row.isGuest,true);assert.equal(row.rank,1);
  assert.equal(row.playerId.startsWith('guest:'),true);assert.equal(JSON.stringify(row).includes(guest),false);
  assert.deepEqual(Object.keys(row).sort(),['completed','highestLevelCompleted','isGuest','playerId','playerName','rank','shotsToCompletion','updatedAt']);
  let bytes=r.database.serialize();assert.deepEqual(name(r,run,'Snow Cat'),{saved:true,qualifies:true});assert.deepEqual(bytes,r.database.serialize());
  assert.throws(()=>name(r,run,'Changed'),{code:'TIP_JAR_NAME_CONFLICT'});
  result=await checkpoint(r,run,shots(8));assert.equal(result.named,true);assert.equal(result.highestLevelCompleted,2);
  assert.equal(r.service.leaderboard().entries[0].playerName,'Snow Cat');
  const next=start(r,guest);await checkpoint(r,next,shots(3));assert.equal(r.service.leaderboard().entries.length,1);assert.equal(r.service.leaderboard().entries[0].highestLevelCompleted,2);
  bytes=r.database.serialize();await checkpoint(r,run,shots(3));r.service.leaderboard();assert.deepEqual(r.database.serialize(),bytes,'GETs and retry prefixes do not write');
  const raw=r.database.prepare('SELECT guest_hash FROM tip_jar_guest_runs WHERE id=?').get(run.runId).guest_hash;
  assert.equal(raw,guestIdentity(guest));assert.notEqual(raw,guest);assert.deepEqual(protectedRows(r.database),before);
});
test('guest capability, exact input, immutable prefix and names are validated before score writes',async t=>{
  const r=setup(t),run=start(r);await checkpoint(r,run,shots(3));const bytes=r.database.serialize();
  await assert.rejects(checkpoint(r,{...run,guestKey:key()},shots(8)),{code:'TIP_JAR_RUN_NOT_FOUND'});
  assert.throws(()=>name(r,{...run,guestKey:key()}),{code:'TIP_JAR_RUN_NOT_FOUND'});
  for(const guestKey of ['',null,'A'.repeat(64),'a'.repeat(63)])assert.throws(()=>start(r,guestKey),{code:'TIP_JAR_INPUT_INVALID'});
  await assert.rejects(r.service.checkpoint({runId:run.runId,input:{guestKey:run.guestKey,shots:shots(8),score:999}}),{code:'TIP_JAR_INPUT_INVALID'});
  await assert.rejects(checkpoint(r,run,[{...shots(3)[0],power:99},...shots(3).slice(1)]),{code:'TIP_JAR_PREFIX_CONFLICT'});
  for(const value of ['','<script>alert(1)</script>','A'.repeat(31),'Name\nNew','A\u202eB','---','Guest (Guest)'])assert.throws(()=>name(r,run,value),{code:'TIP_JAR_NAME_INVALID'});
  assert.equal(displayName('Élodie O’Connor'),'Élodie O’Connor');assert.equal(displayName('ＡＢＣ'),'ABC');
  assert.deepEqual(r.database.serialize(),bytes);
});
test('a newer incomplete run does not replace an older qualifying guest name claim',async t=>{
  const r=setup(t),guest=key(),qualified=start(r,guest);
  assert.equal((await checkpoint(r,qualified,shots(3))).qualifies,true);
  const incomplete=start(r,guest),result=await checkpoint(r,incomplete,shots(1));
  assert.equal(result.highestLevelCompleted,0);assert.equal(result.qualifies,false);assert.equal(result.named,false);
  assert.deepEqual(name(r,incomplete,'New Name'),{saved:false,qualifies:false});
  assert.deepEqual(name(r,qualified,'Recovered Name'),{saved:true,qualifies:true});
  assert.equal(r.service.leaderboard().entries[0].playerName,'Recovered Name');
  assert.equal((await checkpoint(r,incomplete,shots(1))).named,true);
});
test('site leaderboard deduplicates accounts across leagues without leaking league or account IDs',t=>{
  const r=setup(t),user=crypto.randomUUID(),leagues=[crypto.randomUUID(),crypto.randomUUID()];
  r.context.repositories.users.insert({id:user,email_normalized:'private@example.test',email_display:'private@example.test',display_name:'Manager',display_name_normalized:'manager',status:'active',created_at_ms:NOW,updated_at_ms:NOW,version:1});
  for(const [index,league] of leagues.entries()) {
    r.context.repositories.leagues.insert({id:league,name:`Private ${index}`,name_normalized:`private ${index}`,status:'active',timezone:'America/Vancouver',commissioner_membership_id:null,current_season_id:null,created_at_ms:NOW,updated_at_ms:NOW,version:1});
    const run=crypto.randomUUID();
    r.database.prepare("INSERT INTO tip_jar_runs VALUES (?,?,?,?,'campaign-v1',42,'[]','{}',?,?,1)").run(run,league,user,crypto.randomUUID(),NOW,NOW);
    r.database.prepare("INSERT INTO tip_jar_bests VALUES (?,?,?,?,'campaign-v1',?,?,?)").run(crypto.randomUUID(),league,user,run,index+1,index?8:3,NOW);
  }
  const bytes=r.database.serialize(),board=r.service.leaderboard();assert.equal(board.entries.length,1);assert.equal(board.entries[0].highestLevelCompleted,2);
  assert.equal(board.entries[0].isGuest,false);assert.equal(board.entries[0].playerName,'Manager');
  for(const privateValue of [user,...leagues,'private@example.test'])assert.equal(JSON.stringify(board).includes(privateValue),false);
  assert.deepEqual(r.database.serialize(),bytes);
});
test('qualification applies the top100 cutoff including ties and rechecks on name submission',async t=>{
  const r=setup(t),candidate=start(r);await checkpoint(r,candidate,shots(3));
  for(let i=0;i<100;i++){const run=start(r);await checkpoint(r,run,shots(8));name(r,run,`Player ${i}`);}
  assert.deepEqual(name(r,candidate),{saved:false,qualifies:false});
  let result=await checkpoint(r,candidate,shots(8));assert.equal(result.qualifies,true);name(r,candidate,'Tied Guest');
  const board=r.service.leaderboard();assert.equal(board.entries.length,101);assert(board.entries.every(row=>row.rank===1));
  const slower=start(r);result=await checkpoint(r,slower,shots(3));assert.equal(result.qualifies,false);assert.equal(result.named,false);
  assert.deepEqual(name(r,slower),{saved:false,qualifies:false});
});
test('competing guest checkpoints recheck immutable transcript after replay',async t=>{
  const r=setup(t),pending=[];r.service=createTipJarPublicService({...r.dependencies,verifyRun:input=>new Promise(resolve=>pending.push(()=>resolve(verify(input))))});
  const run=start(r),first=checkpoint(r,run,shots(3)),second=checkpoint(r,run,shots(8));
  pending[1]();await second;pending[0]();const stale=await first;assert.equal(stale.highestLevelCompleted,2);
  assert.equal(r.repository.findBest({guestHash:guestIdentity(run.guestKey),rulesetVersion:'campaign-v1'}).highest_level_completed,2);
});
test('guest scores use the real seeded campaign replay and reject forged completion',async t=>{
  const r=setup(t,null),fixture=require('../fixtures/tip-jar-campaign.json');
  r.service=createTipJarPublicService({...r.dependencies,secureRandom:{id:crypto.randomUUID,bytes:()=>{const b=Buffer.alloc(4);b.writeUInt32LE(fixture.seed);return b;}}});
  const run=start(r),result=await checkpoint(r,run,fixture.shots);assert.deepEqual(result,{runId:run.runId,...fixture.expected,qualifies:true,named:false});
  const bytes=r.database.serialize();await assert.rejects(checkpoint(r,run,[...fixture.shots,{time:500,x:0,height:.16,power:65}]),{code:'TIP_JAR_TRANSCRIPT_INVALID'});assert.deepEqual(r.database.serialize(),bytes);
});
test('public HTTP is anonymous, origin protected, bounded, rate limited and read-only on GET',async t=>{
  const r=setup(t),origin='http://localhost:5173',cookie=createSessionCookie({appEnv:'local',publicFrontendOrigin:origin,sameSite:'lax'});
  let sessions=0;const requestSecurity=createTargetRequestSecurity({sessionCookie:cookie,isAllowedOrigin:value=>value===origin,
    sessionService:{bootstrap:()=>{sessions++;return {valid:false};},resolveWithCsrf:()=>{sessions++;return {valid:false};}}});
  const rateLimiter=createAuthenticationRateLimiter({repository:createSqliteAuthenticationRateLimitRepository({database:r.database}),
    privacyDigest:{digest:value=>({digest:crypto.createHash('sha256').update(value).digest('hex'),keyVersion:1})},clock:r.dependencies.clock,secureRandom:r.dependencies.secureRandom});
  const app=express();app.use(createTipJarRouter({requestSecurity,publicService:r.service,rateLimiter,networkSourceResolver:()=> '198.51.100.0/24'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,root=`${base}/api/v1/games/tip-jar`,headers={Origin:origin,'Content-Type':'application/json'},guestKey=key();
  const post=(suffix,body,extra={})=>fetch(`${root}${suffix}`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  const before=r.database.serialize();assert.equal((await fetch(`${root}/leaderboard`,{headers})).status,200);assert.deepEqual(r.database.serialize(),before);assert.equal(sessions,0);
  const input={guestKey,clientRunId:crypto.randomUUID()};
  assert.equal((await post('/runs',input,{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('/runs',input,{'Sec-Fetch-Dest':'document'})).status,403);
  assert.equal((await post('/runs',input,{'Content-Type':'text/plain'})).status,415);assert.deepEqual(r.database.serialize(),before);
  let response=await post('/runs',input);assert.equal(response.status,200);const run=(await response.json()).data;
  response=await post(`/runs/${run.runId}/checkpoint`,{guestKey,shots:shots(3)});assert.equal(response.status,200);assert.equal((await response.json()).data.qualifies,true);
  response=await post(`/runs/${run.runId}/name`,{guestKey,name:'Anonymous Cat'});assert.equal(response.status,200);
  response=await post(`/runs/${run.runId}/checkpoint`,{guestKey:key(),shots:shots(3)});assert.equal(response.status,404);
  assert.equal((await post('/runs',{...input,pad:'x'.repeat(25000)})).status,413);
  for(let i=1;i<30;i++)assert.equal((await post('/runs',input)).status,200);
  response=await post('/runs',input);assert.equal(response.status,429);assert(Number(response.headers.get('retry-after'))>0);
  const bytes=r.database.serialize();response=await fetch(`${root}/leaderboard`,{headers});assert.equal(response.status,200);assert.deepEqual(r.database.serialize(),bytes);assert.equal(sessions,0);
  assert.equal((await fetch(`${base}/api/v1/leagues/${crypto.randomUUID()}/tip-jar/leaderboard`,{headers})).status,401);
  for(const [method,suffix] of [['GET','/leaderboard'],['POST','/runs'],['POST',`/runs/${run.runId}/checkpoint`],['POST',`/runs/${run.runId}/name`]])assert.equal(selectTargetRouterKey(method,`/api/v1/games/tip-jar${suffix}`),'tipJar');
  const rows=r.database.prepare('SELECT * FROM authentication_rate_limits').all();assert(rows.length>0);assert.equal(JSON.stringify(rows).includes(guestKey),false);
});
