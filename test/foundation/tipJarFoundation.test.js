const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { migrateDatabase, applyMigrations, discoverMigrations } = require('../../src/infrastructure/database/migrate');
const { createSqliteRepositoryContext } = require('../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext');
const { createSqliteTipJarRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTipJarRepository');
const { createSqliteUserRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteUserRepository');
const { createSqliteLeagueAccessRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository');
const { createSqliteTeamAuthorityRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository');
const { createLeagueAuthorizationService } = require('../../src/application/services/authorization/requireLeagueAuthority');
const { createTeamAuthorizationService } = require('../../src/application/services/authorization/requireTeamManagerAuthority');
const { createTipJarService } = require('../../src/application/services/games/createTipJarService');
const { createTipJarRouter } = require('../../src/transport/http/createTipJarRouter');
const { createTargetRequestSecurity } = require('../../src/transport/http/createTargetRequestSecurity');
const { createSessionCookie } = require('../../src/transport/http/sessionCookie');
const { selectTargetRouterKey, TARGET_ENDPOINTS } = require('../../src/bootstrap/createTargetRuntime');
const { getRepositoryCatalogForSchemaVersion } = require('../../src/infrastructure/persistence/sqlite/repositoryCatalog');

const DIR = path.resolve(__dirname, '../../database/migrations');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const READER=id(1), MANAGER=id(2), SECOND=id(3), OUTSIDER=id(4), LEAGUE=id(10), OTHER=id(11);
const authenticated = userId => ({ valid: true, user: { id: userId, status: 'active', version: 1 }, session: { id: id(900+Number(userId.slice(-1))), userId } });
const base = (userId=MANAGER, leagueId=LEAGUE) => ({ authenticated: authenticated(userId), leagueId });
const shot = (index, success=true) => ({ time:index*7, x:0, height:.16, power:success?100:15 });
const transcript = values => values.map((success,index)=>shot(index,success));
function fixtureVerifier({ shots }) {
  let level=1,pucks=20,levelHits=0,levelShots=0,highestLevelCompleted=0,shotsToCompletion=null,completed=false,failed=false;
  const levelResults=[];
  for(let i=0;i<shots.length;i++) {
    if(completed||failed) throw new Error('Ended run');
    if(i && shots[i].time<=shots[i-1].time) throw new Error('Non-increasing time');
    if(shots[i].x===1) throw new Error('Illegal replay fixture');
    pucks--;levelShots++;if(shots[i].power===100)levelHits++;
    if(levelHits===(level===1?3:5)) {
      highestLevelCompleted=level;shotsToCompletion=i+1;levelResults.push({level,shots:levelShots,totalShots:i+1});
      if(level===3)completed=true;else{level++;pucks+=20;levelHits=0;levelShots=0;}
    }else if(pucks===0)failed=true;
  }
  return {highestLevelCompleted,shotsToCompletion,shotsUsed:shots.length,level,pucks,completed,failed,levelResults};
}
function setup(t, verifier=fixtureVerifier) {
  const database=new Database(':memory:');database.pragma('foreign_keys = ON');
  migrateDatabase({database,migrationsDirectory:DIR,applicationBuildId:'tip-jar-test',now:()=>NOW});
  t.after(()=>database.close());
  const context=createSqliteRepositoryContext({database});
  for(const [userId,name] of [[READER,'Commissioner'],[MANAGER,'Alpha manager'],[SECOND,'Beta manager'],[OUTSIDER,'Other manager']]) {
    context.repositories.users.insert({id:userId,email_normalized:`${userId}@example.test`,email_display:`${userId}@example.test`,
      display_name:name,display_name_normalized:name.toLowerCase(),status:'active',created_at_ms:NOW,updated_at_ms:NOW,version:1});
  }
  for(const [leagueId,name] of [[LEAGUE,'Alpha'],[OTHER,'Other']]) {
    context.repositories.leagues.insert({id:leagueId,name,name_normalized:name.toLowerCase(),status:'active',timezone:'America/Vancouver',
      commissioner_membership_id:null,current_season_id:null,created_at_ms:NOW,updated_at_ms:NOW,version:1});
  }
  for(const [userId,leagueId] of [[READER,LEAGUE],[MANAGER,LEAGUE],[SECOND,LEAGUE],[OUTSIDER,OTHER],[MANAGER,OTHER]]) {
    const memberId=id(Number(userId.slice(-1))+Number(leagueId.slice(-2))*10);
    context.repositories.league_memberships.insert({id:memberId,league_id:leagueId,user_id:userId,permission_category:userId===READER?'commissioner':'manager',
      status:'active',joined_at_ms:NOW,ended_at_ms:null,created_at_ms:NOW,updated_at_ms:NOW,version:1});
    if(userId===READER)context.repositories.leagues.updateVersioned({key:leagueId,expectedVersion:1,changes:{commissioner_membership_id:memberId,updated_at_ms:NOW}});
    if(userId!==READER) {
      const teamId=id(Number(userId.slice(-1))+Number(leagueId.slice(-2))*100);
      context.repositories.teams.insert({id:teamId,league_id:leagueId,name:`Team ${teamId}`,name_normalized:`team ${teamId}`,status:'active',
        primary_colour:null,secondary_colour:null,logo_reference:null,created_at_ms:NOW,updated_at_ms:NOW,version:1});
      context.repositories.team_manager_assignments.insert({id:id(Number(userId.slice(-1))+Number(leagueId.slice(-2))*1000),league_id:leagueId,team_id:teamId,
        user_id:userId,membership_id:memberId,assigned_by_user_id:READER,status:'accepted',assigned_at_ms:NOW,accepted_at_ms:NOW,ended_at_ms:null,version:1});
    }
  }
  const leagueAuthorization=createLeagueAuthorizationService({userRepository:createSqliteUserRepository({database}),leagueAccessRepository:createSqliteLeagueAccessRepository({database})});
  const teamAuthorityRepository=createSqliteTeamAuthorityRepository({database});
  const dependencies={repositoryContext:context,repository:createSqliteTipJarRepository({database}),leagueAuthorization,
    teamAuthorization:createTeamAuthorizationService({leagueAuthorization,teamAuthorityRepository}),teamAuthorityRepository,
    clock:{nowMs:()=>NOW+100},secureRandom:{id:crypto.randomUUID,bytes:crypto.randomBytes},...(verifier?{verifyRun:verifier}:{})};
  return {database,context,dependencies,service:createTipJarService(dependencies)};
}
const start = (r, args={}) => r.service.start({...base(),input:{clientRunId:crypto.randomUUID()},...args});
const save = (r,run,shots,args={}) => r.service.checkpoint({...base(),runId:run.runId,input:{shots},...args});
function protectedRows(database) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'tip_jar_%' ORDER BY name").all()
    .map(({name})=>[name,database.prepare(`SELECT * FROM "${name}"`).all()]);
}

test('Tip Jar additive migration preserves populated pre-existing rows and historical catalogues',t=>{
  const database=new Database(':memory:');t.after(()=>database.close());database.pragma('foreign_keys=ON');
  const migrations=discoverMigrations({migrationsDirectory:DIR});
  applyMigrations({database,migrations:migrations.filter(m=>m.id<94),applicationBuildId:'tip-jar-before',now:()=>NOW});
  database.prepare(`INSERT INTO users (id,email_normalized,email_display,display_name,display_name_normalized,status,created_at_ms,updated_at_ms,version)
    VALUES (?,'preserved@example.test','preserved@example.test','Preserved','preserved','active',?,?,1)`).run(MANAGER,NOW,NOW);
  const old=protectedRows(database).filter(([name])=>!['schema_migrations','application_metadata'].includes(name));
  applyMigrations({database,migrations,applicationBuildId:'tip-jar-after',now:()=>NOW});
  assert.deepEqual(protectedRows(database).filter(([name])=>!['schema_migrations','application_metadata'].includes(name)),old);
  assert.equal(database.pragma('user_version',{simple:true}),95);
  assert.equal(database.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key='data_model_version'").get().metadata_value,'95');
  assert.deepEqual(database.pragma('foreign_key_check'),[]);
  createSqliteRepositoryContext({database});
  const bytes=database.serialize();applyMigrations({database,migrations,applicationBuildId:'tip-jar-repeat',now:()=>NOW});assert(bytes.equals(database.serialize()));
  for(const version of [54,56,85,93])assert(!getRepositoryCatalogForSchemaVersion(version).some(d=>d.tableName.startsWith('tip_jar_')));
  assert.equal(getRepositoryCatalogForSchemaVersion(94).filter(d=>d.tableName.startsWith('tip_jar_')).length,2);
});

test('run start and checkpoints write only dedicated side-game tables; zero-level display is explicit',async t=>{
  const r=setup(t),before=protectedRows(r.database),run=start(r);
  assert.equal(run.rulesetVersion,'campaign-v1');assert(Number.isInteger(run.seed)&&run.seed>=0&&run.seed<=0xffffffff);
  assert.equal(Date.parse(run.createdAt),NOW+100);
  let board=r.service.leaderboard(base());assert.equal(board.entries[0].highestLevelCompleted,0);assert.equal(board.entries[0].shotsToCompletion,null);
  assert.equal(board.personalBest.managerId,MANAGER);
  await save(r,run,transcript([true,false,true,true,false]));
  board=r.service.leaderboard(base());assert.equal(board.entries[0].highestLevelCompleted,1);assert.equal(board.entries[0].shotsToCompletion,4);
  assert.deepEqual(protectedRows(r.database),before);
  const bytes=r.database.serialize();r.service.leaderboard(base());assert(bytes.equals(r.database.serialize()));
  assert.deepEqual(Object.keys(board.entries[0]).sort(),['completed','highestLevelCompleted','managerId','managerName','rank','shotsToCompletion','updatedAt']);
});

test('best ranking uses completed levels then cumulative completion shots, excluding failed later attempts',async t=>{
  const r=setup(t),first=start(r),second=start(r,base(SECOND));
  const a=transcript([true,false,true,true,true,false,true,true,true,true,...Array(30).fill(false)]);
  const b=transcript([true,true,true,true,true,true,true,true,...Array(5).fill(false)]);
  const result=await save(r,first,a);assert.equal(result.highestLevelCompleted,2);assert.equal(result.shotsToCompletion,10);
  await save(r,second,b,base(SECOND));
  let board=r.service.leaderboard(base());assert.deepEqual(board.entries.map(x=>[x.managerId,x.shotsToCompletion]),[[SECOND,8],[MANAGER,10]]);
  const worse=start(r);await save(r,worse,transcript([true,true,true]));
  assert.equal(r.service.leaderboard(base()).personalBest.highestLevelCompleted,2);
  const winner=start(r);await save(r,winner,transcript(Array(13).fill(true)));
  board=r.service.leaderboard(base());assert.equal(board.entries[0].managerId,MANAGER);assert.equal(board.entries[0].completed,true);assert.equal(board.entries[0].shotsToCompletion,13);
  const tied=start(r,base(SECOND));await save(r,tied,transcript(Array(13).fill(true)),base(SECOND));
  assert.deepEqual(r.service.leaderboard(base()).entries.map(x=>x.rank),[1,1]);
});

test('client UUID starts are idempotent per manager and league; prefix retries do not write or worsen results',async t=>{
  const r=setup(t),clientRunId=crypto.randomUUID(),run=start(r,{input:{clientRunId}});
  let bytes=r.database.serialize();assert.deepEqual(start(r,{input:{clientRunId}}),run);assert(bytes.equals(r.database.serialize()));
  assert.notEqual(start(r,{...base(SECOND),input:{clientRunId}}).runId,run.runId);
  assert.notEqual(start(r,{...base(MANAGER,OTHER),input:{clientRunId}}).runId,run.runId);
  const shots=transcript([true,false,true,true]);const result=await save(r,run,shots);
  bytes=r.database.serialize();assert.deepEqual(await save(r,run,shots),result);assert.deepEqual(await save(r,run,shots.slice(0,2)),result);assert(bytes.equals(r.database.serialize()));
  await assert.rejects(save(r,run,[{...shots[0],x:.5}]),{code:'TIP_JAR_PREFIX_CONFLICT'});assert(bytes.equals(r.database.serialize()));
});

test('session identity, league membership and current manager authority are independently enforced',async t=>{
  const r=setup(t),run=start(r),bytes=r.database.serialize();
  assert.throws(()=>start(r,base(READER)),{code:'TEAM_MANAGER_REQUIRED'});
  assert.throws(()=>start(r,base(OUTSIDER)),{code:'LEAGUE_NOT_FOUND'});
  assert.throws(()=>r.service.leaderboard(base(OUTSIDER)),{code:'LEAGUE_NOT_FOUND'});
  assert.throws(()=>start(r,{authenticated:{...authenticated(MANAGER),session:{userId:SECOND}}}),{code:'LEAGUE_NOT_FOUND'});
  await assert.rejects(save(r,run,[],base(SECOND)),{code:'TIP_JAR_RUN_NOT_FOUND'});
  await assert.rejects(save(r,run,[],base(MANAGER,OTHER)),{code:'TIP_JAR_RUN_NOT_FOUND'});
  assert.throws(()=>start(r,{input:{clientRunId:crypto.randomUUID(),userId:SECOND}}),{code:'TIP_JAR_INPUT_INVALID'});
  assert(bytes.equals(r.database.serialize()));
  r.database.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=?,version=version+1 WHERE league_id=? AND user_id=?").run(NOW+1,LEAGUE,MANAGER);
  await assert.rejects(save(r,run,[]),{code:'TEAM_MANAGER_REQUIRED'});
  r.database.prepare("UPDATE league_memberships SET status='ended',ended_at_ms=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND user_id=?").run(NOW+1,NOW+1,LEAGUE,MANAGER);
  assert.throws(()=>r.service.leaderboard(base()),{code:'LEAGUE_NOT_FOUND'});
});

test('bounded input and rejected physics replay preserve all rows',async t=>{
  const r=setup(t),run=start(r),bytes=r.database.serialize();
  const invalid=[null,{},[],{shots:Array(61).fill(shot(0))},{shots:[{...shot(0),time:Infinity}]},{shots:[{...shot(0),time:-1}]},
    {shots:[{...shot(0),x:1.5}]},{shots:[{...shot(0),height:0}]},{shots:[{...shot(0),power:101}]},{shots:[{...shot(0),extra:true}]},
    {shots:[shot(0)],highestLevelCompleted:3}];
  for(const input of invalid)await assert.rejects(r.service.checkpoint({...base(),runId:run.runId,input}),{code:'TIP_JAR_INPUT_INVALID'});
  await assert.rejects(save(r,run,[{...shot(0),x:1}]),{code:'TIP_JAR_TRANSCRIPT_INVALID'});
  await assert.rejects(save(r,run,[shot(1),shot(0)]),{code:'TIP_JAR_TRANSCRIPT_INVALID'});
  assert(bytes.equals(r.database.serialize()));
});

test('concurrent checkpoint rechecks preserve longest prefix and reject forks without stale writes',async t=>{
  const waiting=[];const r=setup(t,input=>new Promise(resolve=>waiting.push(()=>resolve(fixtureVerifier(input))))),run=start(r);
  const short=save(r,run,transcript([true,true]));const long=save(r,run,transcript([true,true,true]));
  waiting[1]();const result=await long;waiting[0]();assert.deepEqual(await short,result);
  assert.equal(JSON.parse(r.dependencies.repository.findRun({leagueId:LEAGUE,userId:MANAGER,runId:run.runId}).shots_json).length,3);
  const second=start(r);const a=save(r,second,transcript([true]));const b=save(r,second,transcript([false,true]));
  waiting[2]();await a;const before=r.database.serialize();waiting[3]();await assert.rejects(b,{code:'TIP_JAR_PREFIX_CONFLICT'});assert(before.equals(r.database.serialize()));
});

test('manager revocation while async replay runs is rechecked before writing',async t=>{
  let finish;const r=setup(t,input=>new Promise(resolve=>{finish=()=>resolve(fixtureVerifier(input));})),run=start(r);
  const request=save(r,run,[shot(0)]);
  r.database.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=?,version=version+1 WHERE league_id=? AND user_id=?").run(NOW+1,LEAGUE,MANAGER);
  const before=r.database.serialize();finish();await assert.rejects(request,{code:'TEAM_MANAGER_REQUIRED'});assert(before.equals(r.database.serialize()));
});

test('level-three exhaustion retains level-one plus level-two shots; final puck can complete a level',async t=>{
  const r=setup(t),run=start(r),shots=transcript([...Array(17).fill(false),true,true,true,...Array(5).fill(true),...Array(35).fill(false)]);
  const result=await save(r,run,shots);assert.equal(result.failed,true);assert.equal(result.highestLevelCompleted,2);assert.equal(result.shotsToCompletion,25);
  assert.deepEqual(result.levelResults,[{level:1,shots:20,totalShots:20},{level:2,shots:5,totalShots:25}]);
  assert.equal(r.service.leaderboard(base()).personalBest.shotsToCompletion,25);
});

test('HTTP routes enforce origin, session, CSRF, bounded JSON and safe errors',async t=>{
  const r=setup(t),origin='http://localhost:5173',cookie=createSessionCookie({appEnv:'local',publicFrontendOrigin:origin,sameSite:'lax'});
  const token=Buffer.alloc(32,97).toString('base64url'),csrf=Buffer.alloc(32,98).toString('base64url');
  const requestSecurity=createTargetRequestSecurity({sessionCookie:cookie,isAllowedOrigin:value=>value===origin,requestIdFactory:()=> 'tip-jar-test',
    sessionService:{bootstrap:value=>value===token?authenticated(MANAGER):{valid:false},resolveWithCsrf:({rawSessionToken,rawCsrfToken})=>rawSessionToken!==token?{valid:false}:rawCsrfToken!==csrf?{valid:false,code:'CSRF_INVALID'}:authenticated(MANAGER)}});
  const app=express();app.use(createTipJarRouter({requestSecurity,tipJarService:r.service}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=`http://127.0.0.1:${server.address().port}/api/v1/leagues/${LEAGUE}/tip-jar`;
  const headers={Origin:origin,'Content-Type':'application/json',Cookie:`${cookie.name}=${token}`,'X-CSRF-Token':csrf};
  const before=r.database.serialize();
  for(const [changes,status] of [[{...headers,'X-CSRF-Token':'bad'},403],[{...headers,Origin:'https://evil.example'},403],[{Origin:origin,'Content-Type':'application/json'},401]]) {
    assert.equal((await fetch(`${root}/runs`,{method:'POST',headers:changes,body:JSON.stringify({clientRunId:crypto.randomUUID()})})).status,status);assert(before.equals(r.database.serialize()));
  }
  const started=await fetch(`${root}/runs`,{method:'POST',headers,body:JSON.stringify({clientRunId:crypto.randomUUID()})});assert.equal(started.status,200);
  const run=(await started.json()).data;
  assert.equal((await fetch(`${root}/runs/${run.runId}/checkpoint`,{method:'POST',headers,body:JSON.stringify({shots:transcript([true,true,true])})})).status,200);
  let response=await fetch(`${root}/leaderboard`,{headers});assert.equal(response.status,200);assert.equal((await response.json()).data.entries[0].shotsToCompletion,3);
  const current=r.database.serialize();response=await fetch(`${root}/runs/${run.runId}/checkpoint`,{method:'POST',headers,body:JSON.stringify({shots:[],extra:'x'.repeat(25000)})});assert.equal(response.status,413);assert(current.equals(r.database.serialize()));
  assert.equal(selectTargetRouterKey('GET',`/api/v1/leagues/${LEAGUE}/tip-jar/leaderboard`),'tipJar');
  assert.equal(selectTargetRouterKey('POST',`/api/v1/leagues/${LEAGUE}/tip-jar/runs`),'tipJar');
  assert.equal(selectTargetRouterKey('OPTIONS',`/api/v1/leagues/${LEAGUE}/tip-jar/runs/${run.runId}/checkpoint`,'POST'),'tipJar');
});

test('packaged seeded physics verifies actual controller shots through all three levels',async t=>{
  const fixture=require('../fixtures/tip-jar-campaign.json'),r=setup(t,null);
  r.service=createTipJarService({...r.dependencies,secureRandom:{id:crypto.randomUUID,bytes:()=>{
    const buffer=Buffer.alloc(4);buffer.writeUInt32LE(fixture.seed);return buffer;
  }}});
  const before=protectedRows(r.database),run=start(r);assert.equal(run.seed,fixture.seed);
  const prefix=await save(r,run,fixture.shots.slice(0,8));
  assert.equal(prefix.highestLevelCompleted,2);assert.equal(prefix.shotsToCompletion,8);
  const result=await save(r,run,fixture.shots);assert.deepEqual(result,{runId:run.runId,...fixture.expected});
  assert.equal(r.service.leaderboard(base()).personalBest.shotsToCompletion,13);
  const bytes=r.database.serialize();
  await assert.rejects(save(r,run,[...fixture.shots,{time:500,x:0,height:.16,power:65}]),{code:'TIP_JAR_TRANSCRIPT_INVALID'});
  assert(bytes.equals(r.database.serialize()));assert.deepEqual(protectedRows(r.database),before);
  const overlap=start(r);
  await assert.rejects(save(r,overlap,[fixture.shots[0],{...fixture.shots[1],time:fixture.shots[0].time+.1}]),{code:'TIP_JAR_TRANSCRIPT_INVALID'});
});
