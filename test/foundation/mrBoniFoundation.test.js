const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {test}=require('node:test');
const Database=require('better-sqlite3');
const {setup,base,start,save,protectedRows,record,fixtureVerifier,NOW,DIR,READER,MANAGER,SECOND,OUTSIDER,LEAGUE,OTHER}=require('../helpers/mrBoniFixture');
const {createMrBoniService}=require('../../src/application/services/games/createMrBoniService');
const {createMrBoniPublicService,guestIdentity}=require('../../src/application/services/games/createMrBoniPublicService');
const {createSqliteMrBoniPublicRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteMrBoniPublicRepository');
const {discoverMigrations,applyMigrations}=require('../../src/infrastructure/database/migrate');
const {getRepositoryCatalogForSchemaVersion}=require('../../src/infrastructure/persistence/sqlite/repositoryCatalog');
const {validatedCommands}=require('../../src/features/mrBoni/commandValidation');
function publicGame(r,verifyRun=fixtureVerifier){return createMrBoniPublicService({...r.dependencies,repository:createSqliteMrBoniPublicRepository({database:r.database}),verifyRun});}
const guestStart=(service,guestKey=crypto.randomBytes(32).toString('hex'),clientRunId=crypto.randomUUID())=>({guestKey,...service.start({input:{guestKey,clientRunId}})});
const guestSave=(service,run,commands)=>service.checkpoint({runId:run.runId,input:{guestKey:run.guestKey,commands}});
test('schema96 only adds Mr. Boni tables, preserves populated TipJar and all other rows, retries inertly',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');
  const migrations=discoverMigrations({migrationsDirectory:DIR});
  applyMigrations({database:db,migrations:migrations.filter(m=>m.id<96),applicationBuildId:'before',now:()=>NOW});
  db.prepare("INSERT INTO tip_jar_guest_runs VALUES (?, ?, ?, 'campaign-v1',42,'[]','{}',1,1,1)").run(crypto.randomUUID(),'a'.repeat(64),crypto.randomUUID());
  const snapshot=()=>protectedRows(db).filter(([name])=>!['schema_migrations','application_metadata'].includes(name));
  const before=snapshot(),oldSchema=db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  applyMigrations({database:db,migrations,applicationBuildId:'after',now:()=>NOW});
  assert.deepEqual(snapshot(),before);
  for(const item of oldSchema)assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(item.name).sql,item.sql);
  assert.equal(db.pragma('user_version',{simple:true}),96);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const bytes=db.serialize();applyMigrations({database:db,migrations,applicationBuildId:'repeat',now:()=>NOW});assert.deepEqual(db.serialize(),bytes);
  for(const version of [54,56,85,93,94,95])assert(!getRepositoryCatalogForSchemaVersion(version).some(x=>x.tableName.startsWith('mr_boni_')));
  assert.equal(getRepositoryCatalogForSchemaVersion(96).filter(x=>x.tableName.startsWith('mr_boni_')).length,4);
});
test('completed levels rank before cumulative time; unfinished next-level ticks and worse new runs preserve best',async t=>{
  const r=setup(t),before=protectedRows(r.database),run=start(r);
  assert.deepEqual(r.service.leaderboard(base()).entries,[]);
  assert.equal(r.database.prepare('SELECT count(*) n FROM mr_boni_bests').get().n,0);
  await save(r,run,record(1));assert.equal(r.database.prepare('SELECT count(*) n FROM mr_boni_bests').get().n,0);
  let result=await save(r,run,record(3));assert.equal(result.highestLevelCompleted,1);assert.equal(result.cumulativeTimeMs,2000);assert.equal(result.commandsProcessed,3);assert.equal(result.rulesetVersion,'resurface-v1');
  const second=start(r,base(SECOND));await save(r,second,record(4,2),base(SECOND));
  assert.equal(r.service.leaderboard(base()).entries[0].managerId,SECOND);
  const improved=start(r);await save(r,improved,record(4));
  let board=r.service.leaderboard(base());assert.equal(board.entries[0].managerId,MANAGER);assert.equal(board.entries[0].cumulativeTimeMs,4000);
  const worse=start(r);await save(r,worse,record(2));assert.equal(r.service.leaderboard(base()).personalBest.highestLevelCompleted,2);
  const tied=start(r,base(SECOND));await save(r,tied,record(4),base(SECOND));assert.deepEqual(r.service.leaderboard(base()).entries.map(x=>x.rank),[1,1]);
  result=await save(r,improved,record(6));assert.equal(result.completed,true);assert.equal(result.cumulativeTimeMs,6000);
  assert.deepEqual(protectedRows(r.database),before);
});
test('league/account authority, exact bodies, prefix conflicts, retries and asynchronous revocation are isolated',async t=>{
  const r=setup(t),clientRunId=crypto.randomUUID(),run=start(r,{input:{clientRunId}});
  assert.equal(start(r,{input:{clientRunId}}).runId,run.runId);
  assert.throws(()=>start(r,base(READER)),{code:'TEAM_MANAGER_REQUIRED'});assert.throws(()=>start(r,base(OUTSIDER)),{code:'LEAGUE_NOT_FOUND'});
  await assert.rejects(save(r,run,record(2),base(SECOND)),{code:'MR_BONI_RUN_NOT_FOUND'});
  await assert.rejects(save(r,run,record(2),base(MANAGER,OTHER)),{code:'MR_BONI_RUN_NOT_FOUND'});
  const result=await save(r,run,record(2)),bytes=r.database.serialize();
  assert.deepEqual(await save(r,run,record(1)),result);assert.deepEqual(await save(r,run,record(2)),result);
  await assert.rejects(save(r,run,record(2,2)),{code:'MR_BONI_PREFIX_CONFLICT'});
  await assert.rejects(r.service.checkpoint({...base(),runId:run.runId,input:{commands:record(3),cumulativeTimeMs:1}}),{code:'MR_BONI_INPUT_INVALID'});
  assert.deepEqual(r.database.serialize(),bytes);
  let finish;const pendingService=createMrBoniService({...r.dependencies,verifyRun:input=>new Promise(resolve=>{finish=()=>resolve(fixtureVerifier(input));})});
  const pending=pendingService.checkpoint({...base(),runId:run.runId,input:{commands:record(4)}});
  r.database.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=?,version=version+1 WHERE league_id=? AND user_id=?").run(NOW+1,LEAGUE,MANAGER);
  const revoked=r.database.serialize();finish();await assert.rejects(pending,{code:'TEAM_MANAGER_REQUIRED'});assert.deepEqual(r.database.serialize(),revoked);
});
test('racing checkpoints keep longest prefix and reject forks after asynchronous replay',async t=>{
  const waiting=[],r=setup(t,input=>new Promise(resolve=>waiting.push(()=>resolve(fixtureVerifier(input))))),run=start(r);
  const short=save(r,run,record(2)),long=save(r,run,record(4));waiting[1]();const best=await long;waiting[0]();assert.deepEqual(await short,best);
  const second=start(r),a=save(r,second,record(2)),b=save(r,second,record(2,2));waiting[2]();await a;const bytes=r.database.serialize();waiting[3]();await assert.rejects(b,{code:'MR_BONI_PREFIX_CONFLICT'});assert.deepEqual(r.database.serialize(),bytes);
});
test('guest capability/naming and combined public ranking deduplicate accounts across leagues without identity leaks',async t=>{
  const r=setup(t),service=publicGame(r),run=guestStart(service),before=protectedRows(r.database);
  assert.equal(r.database.prepare('SELECT count(*) n FROM mr_boni_guest_bests').get().n,0);
  await guestSave(service,run,record(2));assert.deepEqual(service.leaderboard().entries,[]);
  assert.deepEqual(service.name({runId:run.runId,input:{guestKey:run.guestKey,name:'Snow Cat'}}),{saved:true,qualifies:true});
  await guestSave(service,run,record(4));assert.equal(service.leaderboard().entries[0].playerName,'Snow Cat');
  assert.equal(r.database.prepare('SELECT guest_hash FROM mr_boni_guest_runs WHERE id=?').get(run.runId).guest_hash,guestIdentity(run.guestKey));
  await assert.rejects(guestSave(service,{...run,guestKey:'f'.repeat(64)},record(6)),{code:'MR_BONI_RUN_NOT_FOUND'});
  assert.throws(()=>service.name({runId:run.runId,input:{guestKey:run.guestKey,name:'Changed'}}),{code:'MR_BONI_NAME_CONFLICT'});
  const own=start(r);await save(r,own,record(2));const other=start(r,base(MANAGER,OTHER));await save(r,other,record(6),base(MANAGER,OTHER));
  const bytes=r.database.serialize(),board=service.leaderboard();assert.equal(board.entries.length,2);assert.equal(board.entries[0].highestLevelCompleted,3);
  for(const privateValue of [MANAGER,LEAGUE,OTHER,run.guestKey])assert(!JSON.stringify(board).includes(privateValue));
  assert.deepEqual(r.database.serialize(),bytes);assert.deepEqual(protectedRows(r.database),before);
});
test('guest top100 includes ties, rechecks qualification, and cannot claim using an incomplete newer run',async t=>{
  const r=setup(t),service=publicGame(r),candidate=guestStart(service);await guestSave(service,candidate,record(2));
  for(let i=0;i<100;i++){const run=guestStart(service);await guestSave(service,run,record(4));service.name({runId:run.runId,input:{guestKey:run.guestKey,name:`Player ${i}`}});}
  assert.deepEqual(service.name({runId:candidate.runId,input:{guestKey:candidate.guestKey,name:'Candidate'}}),{saved:false,qualifies:false});
  await guestSave(service,candidate,record(4));assert.equal(service.name({runId:candidate.runId,input:{guestKey:candidate.guestKey,name:'Candidate'}}).saved,true);
  assert.equal(service.leaderboard().entries.length,101);assert(service.leaderboard().entries.every(x=>x.rank===1));
  const guest=crypto.randomBytes(32).toString('hex'),qualified=guestStart(service,guest);await guestSave(service,qualified,record(6));
  const incomplete=guestStart(service,guest);await guestSave(service,incomplete,record(1));assert.equal(service.name({runId:incomplete.runId,input:{guestKey:guest,name:'Wrong run'}}).saved,false);
  assert.equal(service.name({runId:qualified.runId,input:{guestKey:guest,name:'Recovered'}}).saved,true);
});
test('command shape, segment, aggregate and result limits reject forged inputs before persistence',async t=>{
  for(const commands of [null,[{}],[[0,601,1,0,0]],[[0,1,2,0,0]],[[0,1,1,0,2]],[[1,3]],[[2,1]],[[4,1]],[[5]],Array(24001).fill([3]),Array(361).fill([0,600,1,0,0])])assert.throws(()=>validatedCommands(commands),{code:'MR_BONI_INPUT_INVALID'});
  const r=setup(t,()=>({highestLevelCompleted:3,cumulativeTimeMs:1.1,completed:true})),run=start(r),bytes=r.database.serialize();
  await assert.rejects(save(r,run,record(2)),{code:'MR_BONI_VERIFICATION_FAILED'});assert.deepEqual(r.database.serialize(),bytes);
});
test('UUID inputs cannot use array or object coercion and leave all database rows unchanged',async t=>{
  const r=setup(t),service=publicGame(r),guestKey=crypto.randomBytes(32).toString('hex'),uuid=crypto.randomUUID();
  const before=r.database.serialize();
  for(const clientRunId of [[uuid],{value:uuid},{toString:uuid},null,123]) {
    assert.throws(()=>start(r,{input:{clientRunId}}),{code:'MR_BONI_INPUT_INVALID'});
    assert.throws(()=>service.start({input:{clientRunId,guestKey}}),{code:'MR_BONI_INPUT_INVALID'});
  }
  assert.deepEqual(r.database.serialize(),before);
  const run=start(r),guest=guestStart(service),saved=r.database.serialize();
  await assert.rejects(r.service.checkpoint({...base(),runId:[run.runId],input:{commands:record(2)}}),{code:'MR_BONI_INPUT_INVALID'});
  await assert.rejects(service.checkpoint({runId:[guest.runId],input:{guestKey:guest.guestKey,commands:record(2)}}),{code:'MR_BONI_INPUT_INVALID'});
  assert.throws(()=>service.name({runId:[guest.runId],input:{guestKey:guest.guestKey,name:'Forged'}}),{code:'MR_BONI_INPUT_INVALID'});
  assert.deepEqual(r.database.serialize(),saved);
});
test('real worker rejects illegal advance and does not accept client completion assertions',async t=>{
  const r=setup(t,null),run=start(r),result=await save(r,run,[[0,1,1,0,0]]);assert.equal(result.highestLevelCompleted,0);assert.equal(result.cumulativeTimeMs,null);
  const bytes=r.database.serialize();await assert.rejects(save(r,run,[[0,1,1,0,0],[4]]),{code:'MR_BONI_TRANSCRIPT_INVALID'});assert.deepEqual(r.database.serialize(),bytes);
});
test('real driving replay saves all three completed-level checkpoints and excludes unfinished next-level time',async t=>{
  const fixture=require('../fixtures/mr-boni-completion.json'),r=setup(t,null),run=start(r);
  for(const checkpoint of fixture.checkpoints) {
    const result=await save(r,run,checkpoint.commands);
    assert.equal(result.highestLevelCompleted,checkpoint.result.highestLevelCompleted);
    assert.equal(result.cumulativeTimeMs,checkpoint.result.cumulativeTimeMs);
    assert.equal(result.completed,checkpoint.result.completed);
    assert.equal(result.commandsProcessed,checkpoint.commands.length);
  }
  const partialRun=start(r),first=fixture.checkpoints[0];
  const result=await save(r,partialRun,[...first.commands,[4],[0,60,0,0,0]]);
  assert.equal(result.highestLevelCompleted,1);assert.equal(result.cumulativeTimeMs,first.result.cumulativeTimeMs);
  assert.equal(r.service.leaderboard(base()).personalBest.highestLevelCompleted,3);
});
test('packaged replay bytes match the versioned manifest',()=>{
  const fs=require('node:fs'),path=require('node:path'),directory=path.resolve(__dirname,'../../src/features/mrBoni/rules');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.rulesetVersion,'resurface-v1');assert.deepEqual(manifest.files.map(x=>x.path),['engine.js','replay.js','package.json']);
  for(const file of manifest.files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,file.path))).digest('hex'),file.sha256);
});
