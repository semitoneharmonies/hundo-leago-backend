const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {test}=require('node:test'),express=require('express');
const {setup,record,fixtureVerifier,authenticated,MANAGER,LEAGUE}=require('../helpers/mrBoniFixture');
const {createMrBoniPublicService}=require('../../src/application/services/games/createMrBoniPublicService');
const {createSqliteMrBoniPublicRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteMrBoniPublicRepository');
const {createMrBoniRouter}=require('../../src/transport/http/createMrBoniRouter');
const {createTargetRequestSecurity}=require('../../src/transport/http/createTargetRequestSecurity');
const {createSessionCookie}=require('../../src/transport/http/sessionCookie');
const {createAuthenticationRateLimiter}=require('../../src/application/services/accounts/createAuthenticationRateLimiter');
const {createSqliteAuthenticationRateLimitRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteAuthenticationRateLimitRepository');
const {selectTargetRouterKey}=require('../../src/bootstrap/createTargetRuntime');
const {createReplayPool}=require('../../src/features/mrBoni/replayPool');
test('guest and authenticated HTTP are protected, rate bounded, correctly scoped and GET never writes',async t=>{
  const r=setup(t),publicService=createMrBoniPublicService({...r.dependencies,repository:createSqliteMrBoniPublicRepository({database:r.database}),verifyRun:fixtureVerifier});
  const origin='http://localhost:5173',cookie=createSessionCookie({appEnv:'local',publicFrontendOrigin:origin,sameSite:'lax'});
  const token=Buffer.alloc(32,97).toString('base64url'),csrf=Buffer.alloc(32,98).toString('base64url');let sessions=0;
  const requestSecurity=createTargetRequestSecurity({sessionCookie:cookie,isAllowedOrigin:value=>value===origin,
    sessionService:{bootstrap:value=>{sessions++;return value===token?authenticated(MANAGER):{valid:false};},resolveWithCsrf:({rawSessionToken,rawCsrfToken})=>rawSessionToken!==token?{valid:false}:rawCsrfToken!==csrf?{valid:false,code:'CSRF_INVALID'}:authenticated(MANAGER)}});
  const rateLimiter=createAuthenticationRateLimiter({repository:createSqliteAuthenticationRateLimitRepository({database:r.database}),privacyDigest:{digest:value=>({digest:crypto.createHash('sha256').update(value).digest('hex'),keyVersion:1})},clock:r.dependencies.clock,secureRandom:r.dependencies.secureRandom});
  const app=express();app.use(createMrBoniRouter({requestSecurity,mrBoniService:r.service,publicService,rateLimiter,networkSourceResolver:()=> '198.51.100.0/24'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const host=`http://127.0.0.1:${server.address().port}`,publicBase=`${host}/api/v1/games/mr-boni`,privateBase=`${host}/api/v1/leagues/${LEAGUE}/mr-boni`;
  const headers={Origin:origin,'Content-Type':'application/json'},privateHeaders={...headers,Cookie:`${cookie.name}=${token}`,'X-CSRF-Token':csrf};
  const post=(root,suffix,body,h=headers)=>fetch(root+suffix,{method:'POST',headers:h,body:JSON.stringify(body)});
  const bytes=r.database.serialize();assert.equal((await fetch(publicBase+'/leaderboard',{headers})).status,200);assert.equal(sessions,0);assert.deepEqual(r.database.serialize(),bytes);
  assert.equal((await fetch(privateBase+'/leaderboard',{headers})).status,401);
  const input={guestKey:crypto.randomBytes(32).toString('hex'),clientRunId:crypto.randomUUID()};
  for(const clientRunId of [[input.clientRunId],{value:input.clientRunId}]) {
    assert.equal((await post(publicBase,'/runs',{...input,clientRunId})).status,400);
    assert.equal((await post(privateBase,'/runs',{clientRunId},privateHeaders)).status,400);
  }
  assert.equal(r.database.prepare('SELECT count(*) n FROM mr_boni_runs').get().n,0);
  assert.equal(r.database.prepare('SELECT count(*) n FROM mr_boni_guest_runs').get().n,0);
  for(const [override,status] of [[{Origin:'https://evil.example'},403],[{'Sec-Fetch-Dest':'document'},403],[{'Content-Type':'text/plain'},415]])assert.equal((await post(publicBase,'/runs',input,{...headers,...override})).status,status);
  let response=await post(publicBase,'/runs',input);assert.equal(response.status,200);const run=(await response.json()).data;
  for(let i=0;i<18;i++){response=await post(publicBase,`/runs/${run.runId}/checkpoint`,{guestKey:input.guestKey,commands:record(2)});assert.equal(response.status,200);}
  response=await post(publicBase,`/runs/${run.runId}/checkpoint`,{guestKey:input.guestKey,commands:record(2)});assert.equal(response.status,429);assert(Number(response.headers.get('Retry-After'))>0);
  assert.equal((await post(publicBase,`/runs/${run.runId}/name`,{guestKey:input.guestKey,name:'Public Cat'})).status,200);
  assert.equal((await post(publicBase,'/runs',{...input,pad:'x'.repeat(1048577)})).status,413);
  assert.equal((await post(privateBase,'/runs',{clientRunId:crypto.randomUUID()},headers)).status,401);
  assert.equal((await post(privateBase,'/runs',{clientRunId:crypto.randomUUID()},{...privateHeaders,'X-CSRF-Token':'bad'})).status,403);
  response=await post(privateBase,'/runs',{clientRunId:crypto.randomUUID()},privateHeaders);assert.equal(response.status,200);const own=(await response.json()).data;
  for(let i=0;i<18;i++)assert.equal((await post(privateBase,`/runs/${own.runId}/checkpoint`,{commands:record(2)},privateHeaders)).status,200);
  assert.equal((await post(privateBase,`/runs/${own.runId}/checkpoint`,{commands:record(2)},privateHeaders)).status,429);
  const after=r.database.serialize();assert.equal((await fetch(privateBase+'/leaderboard',{headers:privateHeaders})).status,200);assert.equal((await fetch(publicBase+'/leaderboard',{headers})).status,200);assert.deepEqual(r.database.serialize(),after);
  for(const [method,suffix] of [['GET','/leaderboard'],['POST','/runs'],['POST',`/runs/${run.runId}/checkpoint`],['POST',`/runs/${run.runId}/name`]])assert.equal(selectTargetRouterKey(method,`/api/v1/games/mr-boni${suffix}`),'mrBoni');
  assert.equal(selectTargetRouterKey('OPTIONS',`/api/v1/leagues/${LEAGUE}/mr-boni/runs`,'POST'),'mrBoni');
  assert(!JSON.stringify(r.database.prepare('SELECT * FROM authentication_rate_limits').all()).includes(input.guestKey));
});
test('worker pool bounds active and queued jobs, expires work, and remains available afterwards',async()=>{
  const workerFile=path.resolve(__dirname,'../fixtures/mr-boni-worker-delay.cjs'),pool=createReplayPool({workerFile,timeoutMs:3000,maxQueued:1});
  const first=pool.verifyRun({commands:[]}),second=pool.verifyRun({commands:[]});
  await assert.rejects(pool.verifyRun({commands:[]}),{code:'MR_BONI_REPLAY_BUSY'});
  let immediate=false;await new Promise(resolve=>setImmediate(()=>{immediate=true;resolve();}));assert(immediate);
  await Promise.all([first,second]);assert.equal((await pool.verifyRun({commands:[]})).highestLevelCompleted,0);
  const timeoutPool=createReplayPool({workerFile,timeoutMs:20,maxQueued:1});
  const job=timeoutPool.verifyRun({commands:[]}),queued=timeoutPool.verifyRun({commands:[]});
  const results=await Promise.allSettled([job,queued]);assert(results.every(x=>x.status==='rejected'));assert(['MR_BONI_REPLAY_TIMEOUT','MR_BONI_REPLAY_BUSY'].includes(results[1].reason.code));
  await assert.rejects(timeoutPool.verifyRun({commands:[]}),{code:'MR_BONI_REPLAY_TIMEOUT'});
});
test('real guest HTTP checkpoints replay the physical three-level driving fixture in bounded workers',async t=>{
  const r=setup(t,null),fixture=require('../fixtures/mr-boni-completion.json');
  const publicService=createMrBoniPublicService({...r.dependencies,repository:createSqliteMrBoniPublicRepository({database:r.database})});
  const origin='http://localhost:5173',cookie=createSessionCookie({appEnv:'local',publicFrontendOrigin:origin,sameSite:'lax'});
  const requestSecurity=createTargetRequestSecurity({sessionCookie:cookie,isAllowedOrigin:value=>value===origin,sessionService:{bootstrap:()=>({valid:false}),resolveWithCsrf:()=>({valid:false})}});
  const rateLimiter=createAuthenticationRateLimiter({repository:createSqliteAuthenticationRateLimitRepository({database:r.database}),privacyDigest:{digest:value=>({digest:crypto.createHash('sha256').update(value).digest('hex'),keyVersion:1})},clock:r.dependencies.clock,secureRandom:r.dependencies.secureRandom});
  const app=express();app.use(createMrBoniRouter({requestSecurity,publicService,rateLimiter,networkSourceResolver:()=> '198.51.100.0/24'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=`http://127.0.0.1:${server.address().port}/api/v1/games/mr-boni`,headers={Origin:origin,'Content-Type':'application/json'},guestKey=crypto.randomBytes(32).toString('hex');
  const post=async(suffix,body)=>{const response=await fetch(root+suffix,{method:'POST',headers,body:JSON.stringify({...body,guestKey})});assert.equal(response.status,200);return (await response.json()).data;};
  const run=await post('/runs',{clientRunId:crypto.randomUUID()});
  for(const checkpoint of fixture.checkpoints){
    const result=await post(`/runs/${run.runId}/checkpoint`,{commands:checkpoint.commands});
    assert.equal(result.highestLevelCompleted,checkpoint.result.highestLevelCompleted);assert.equal(result.cumulativeTimeMs,checkpoint.result.cumulativeTimeMs);assert.equal(result.commandsProcessed,checkpoint.commands.length);assert.equal(result.qualifies,true);
    if(result.highestLevelCompleted===1)assert.equal((await post(`/runs/${run.runId}/name`,{name:'Worker Driver'})).saved,true);
    const board=await(await fetch(root+'/leaderboard',{headers})).json();assert.equal(board.data.entries[0].cumulativeTimeMs,result.cumulativeTimeMs);
  }
});
