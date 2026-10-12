const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { createSqliteNotificationWriter } = require('../../src/infrastructure/persistence/sqlite/SqliteNotificationWriter');
const { createSqlitePushRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePushRepository');
const { createPushService } = require('../../src/application/services/push/createPushService');
const policy = require('../../src/domain/activity/pushPolicy');
const { loadWebPushConfig } = require('../../src/config/loadWebPushConfig');
const { createWebPushAdapter } = require('../../src/infrastructure/push/createWebPushAdapter');
const NOW=1_800_000_000_000, HOUR=3_600_000;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const template=new Database(':memory:'); template.pragma('foreign_keys=ON');
migrateDatabase({database:template,migrationsDirectory:path.resolve(__dirname,'../../database/migrations'),applicationBuildId:'web-push-test'});
const bytes=template.serialize(); template.close();
function fixture(t) {
  const db=new Database(bytes); db.pragma('foreign_keys=ON'); t.after(()=>db.close());
  const insert=(table,row)=>{ try { return db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(k=>'@'+k).join(',')})`).run(row); } catch(error) { throw new Error(`${table}: ${error.message}`); } };
  let now=NOW;
  for(let n=1;n<=3;n++) {
    insert('users',{id:id(n),email_normalized:`u${n}@example.test`,email_display:`u${n}@example.test`,display_name:`User ${n}`,display_name_normalized:`user ${n}`,status:'active',created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
    insert('sessions',{id:id(n+10),user_id:id(n),token_digest:String(n).repeat(64),csrf_secret_digest:'a'.repeat(64),status:'active',created_at_ms:NOW-1000,last_used_at_ms:NOW-1000,idle_expires_at_ms:NOW+48*HOUR,absolute_expires_at_ms:NOW+48*HOUR});
  }
  insert('leagues',{id:id(20),name:'Test league',name_normalized:'test league',status:'active',timezone:'America/Vancouver',created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
  insert('seasons',{id:id(21),league_id:id(20),label:'2026-27',nhl_season_key:'20262027',status:'active',created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
  db.prepare('UPDATE leagues SET current_season_id=? WHERE id=?').run(id(21),id(20));
  for(let n=1;n<=2;n++) {
    insert('league_memberships',{id:id(30+n),league_id:id(20),user_id:id(n),permission_category:'member',status:'active',joined_at_ms:NOW-1000,created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
    insert('teams',{id:id(40+n),league_id:id(20),name:`Team ${n}`,name_normalized:`team ${n}`,status:'active',created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
    insert('team_manager_assignments',{id:id(50+n),league_id:id(20),team_id:id(40+n),user_id:id(n),membership_id:id(30+n),assigned_by_user_id:id(1),status:'accepted',assigned_at_ms:NOW-1000,accepted_at_ms:NOW-1000});
  }
  const writer=createSqliteNotificationWriter({database:db});
  const repo=createSqlitePushRepository({database:db,notificationWriter:writer});
  const key=crypto.createECDH('prime256v1'); key.generateKeys();
  const sub=n=>({endpoint:`https://fcm.googleapis.com/fcm/send/test-${n}`,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,n).toString('base64url')}});
  repo.subscribe(id(1),id(11),sub(1),NOW-500); repo.subscribe(id(2),id(12),sub(2),NOW-500); repo.subscribe(id(3),id(13),sub(3),NOW-500);
  const sent=[]; let legal=true;
  const rosterDecision=()=>({legal,reasonCodes:legal?[]:['SALARY_CAP_EXCEEDED']});
  const service=createPushService({repository:repo,leagueAuthorization:{requireActiveUser:a=>{if(!a?.valid)throw Error('unauthorized'); return {actorUserId:a.user.id};}},clock:{nowMs:()=>now},config:{publicKey:key.getPublicKey().toString('base64url')},adapter:{available:true,send:async(target,payload,ttl)=>sent.push({target,payload,ttl})},rosterDecision});
  const auth={valid:true,user:{id:id(1)},session:{id:id(11),userId:id(1)}};
  const notify=(type,user=1,data={})=>writer.insert({id:crypto.randomUUID(),userId:id(user),leagueId:id(20),eventType:type,messageDataJson:JSON.stringify(data),relatedFeature:null,relatedRecordId:null,deliveryStatus:'delivered',createdAtMs:now,deliveredAtMs:now,deduplicationKey:null});
  const week=(delta=2*HOUR)=>insert('matchup_weeks',{id:id(70),league_id:id(20),season_id:id(21),week_key:'week-1',sequence:1,starts_at_ms:NOW-500,baseline_at_ms:NOW-400,locks_at_ms:NOW+delta,ends_at_ms:NOW+8*24*HOUR,rolls_over_at_ms:NOW+8*24*HOUR,status:'scheduled',created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
  const trade=()=>insert('trades',{id:id(80),league_id:id(20),season_id:id(21),proposing_team_id:id(41),receiving_team_id:id(42),proposing_user_id:id(1),creating_membership_id:id(31),creating_authority:'manager',status:'proposed',proposal_model_version:2,created_at_ms:NOW-500,expires_at_ms:NOW+HOUR,effective_deadline_at_ms:NOW+HOUR,updated_at_ms:NOW-500});
  return {db,insert,repo,service,sent,auth,notify,week,trade,sub,setNow:v=>{now=v;},setLegal:v=>{legal=v;},rosterDecision};
}
test('settings reads do not write; preferences require exact categories',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n; const rows=f.db.prepare('SELECT * FROM push_preferences').all();
  assert.equal(f.service.settings(f.auth).preferences.auction_bid,true);
  assert.deepEqual(f.db.prepare('SELECT * FROM push_preferences').all(),rows); assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  assert.throws(()=>f.service.save({authenticated:f.auth,input:{preferences:{anything:true}}}),{code:'PUSH_INPUT_INVALID'});
  f.service.save({authenticated:f.auth,input:{preferences:{...policy.DEFAULT_PREFERENCES,auction_bid:false}}}); assert.equal(f.repo.preferences(id(1)).auction_bid,false);
});
test('subscription validation rejects arbitrary hosts, credentials and malformed keys',t=>{
  const f=fixture(t); assert.deepEqual(policy.subscription(f.sub(1)),f.sub(1));
  for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://user:pass@fcm.googleapis.com/x']) assert.throws(()=>policy.subscription({...f.sub(1),endpoint}),{code:'PUSH_INPUT_INVALID'});
  assert.throws(()=>policy.subscription({...f.sub(1),keys:{p256dh:'x',auth:'x'}}),{code:'PUSH_INPUT_INVALID'});
});
test('new trade offers reach only the receiving manager, with short safe copy',async t=>{
  const f=fixture(t); f.trade(); f.notify('trade_proposal_received',2,{tradeId:id(80),receivingTeamId:id(42),privateOffer:'secret'});
  await f.service.deliverDue(); assert.equal(f.sent.length,1); assert.match(f.sent[0].target.endpoint,/test-2$/); assert.equal(f.sent[0].payload.title,'New trade offer'); assert.equal(JSON.stringify(f.sent).includes('secret'),false);
  await f.service.deliverDue(); assert.equal(f.sent.length,1);
});
test('revoked sessions and removed memberships suppress queued delivery',async t=>{
  const f=fixture(t); f.notify('league_calendar_changed',1); f.repo.collect(NOW,f.rosterDecision);
  f.db.prepare("UPDATE sessions SET status='revoked',revoked_at_ms=? WHERE id=?").run(NOW,id(11));
  await f.service.deliverDue(); assert.equal(f.sent.length,0);
  f.notify('league_calendar_changed',2); f.repo.collect(NOW,f.rosterDecision); f.db.prepare("UPDATE league_memberships SET status='ended',ended_at_ms=? WHERE id=?").run(NOW,id(32));
  await f.service.deliverDue(); assert.equal(f.sent.length,0);
});
test('disabled category and other-league users do not get a push',async t=>{
  const f=fixture(t); f.repo.savePreferences(id(1),{...policy.DEFAULT_PREFERENCES,schedule_changed:false},NOW);
  f.notify('league_calendar_changed',1); f.notify('league_calendar_changed',3); await f.service.deliverDue(); assert.equal(f.sent.length,0);
});
test('two-hour reminder deduplicates and a moved deadline suppresses old delivery',async t=>{
  const f=fixture(t); f.week(); f.repo.collect(NOW,f.rosterDecision); f.repo.collect(NOW+1000,f.rosterDecision);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM push_deliveries').get().n,2);
  f.db.prepare('UPDATE matchup_weeks SET locks_at_ms=? WHERE id=?').run(NOW+5*HOUR,id(70)); await f.service.deliverDue(); assert.equal(f.sent.length,0);
});
test('illegal roster is combined with lock reminder; resolved warnings are suppressed',async t=>{
  const f=fixture(t); f.week(); f.setLegal(false); await f.service.deliverDue(); assert.equal(f.sent.length,2); assert.equal(f.sent[0].payload.title,'Roster needs fixing before lock');
});
test('standalone roster warning is cancelled when fixed before delivery',async t=>{
  const f=fixture(t); f.week(5*HOUR); f.setLegal(false); f.repo.collect(NOW,f.rosterDecision); f.setLegal(true); await f.service.deliverDue(); assert.equal(f.sent.length,0);
});
test('trade lifecycle alert skips actor and preserves league records',async t=>{
  const f=fixture(t); f.trade(); const before=f.db.prepare('SELECT * FROM trades').all();
  f.insert('trade_events',{id:id(81),league_id:id(20),season_id:id(21),trade_id:id(80),actor_user_id:id(2),event_type:'proposal_accepted',occurred_at_ms:NOW});
  await f.service.deliverDue(); assert.equal(f.sent.length,1); assert.equal(f.sent[0].payload.title,'Trade completed'); assert.deepEqual(f.db.prepare('SELECT * FROM trades').all(),before);
});
test('expired event backlog is not delivered to newly subscribed phones',async t=>{
  const f=fixture(t); f.notify('league_calendar_changed'); f.setNow(NOW+2*HOUR); await f.service.deliverDue(); assert.equal(f.sent.length,0);
});
test('endpoint transfer clears old user deliveries; unsubscribe is owner scoped',t=>{
  const f=fixture(t); f.notify('league_calendar_changed'); f.repo.collect(NOW,f.rosterDecision);
  f.repo.unsubscribe(id(2),f.sub(1).endpoint); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM push_deliveries').get().n,1);
  f.repo.subscribe(id(2),id(12),f.sub(1),NOW); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM push_deliveries').get().n,0);
});
test('disabled worker performs no collection or sending',async()=>{
  const service=createPushService({adapter:{available:false},repository:{collect(){throw Error('write');}},clock:{nowMs:()=>NOW}});
  assert.equal((await service.deliverDue()).status,'skipped');
});
test('VAPID configuration requires matching keys and sender bounds delivery',async()=>{
  assert.deepEqual(loadWebPushConfig({}),{enabled:false});
  const key=crypto.createECDH('prime256v1'); key.generateKeys();
  const privateKey=Buffer.from(key.getPrivateKey().toString('hex').padStart(64,'0'),'hex').toString('base64url');
  const config=loadWebPushConfig({WEB_PUSH_ENABLED:'true',WEB_PUSH_PUBLIC_KEY:key.getPublicKey().toString('base64url'),WEB_PUSH_PRIVATE_KEY:privateKey,WEB_PUSH_SUBJECT:'mailto:grae@hundoleago.com'});
  let options;
  await createWebPushAdapter({config,client:{sendNotification:async(s,p,o)=>{options=o;}}}).send({endpoint:'https://web.push.apple.com/test'},{title:'New trade offer',tag:'test'},99999);
  assert.equal(options.TTL,3600); assert.equal(options.timeout,10000); assert.equal(options.topic.length,32);
});

function auction(f, delta=5*HOUR) {
  f.insert('players',{id:id(90),first_name:'Synthetic',last_name:'Player',full_name:'Synthetic Player',status:'active',created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
  f.insert('auctions',{id:id(91),league_id:id(20),season_id:id(21),player_id:id(90),status:'open',opened_at_ms:NOW-1000,resolves_at_ms:NOW+delta,created_at_ms:NOW-1000,updated_at_ms:NOW-1000});
  f.insert('auction_contexts',{id:id(91),league_id:id(20),season_id:id(21),auction_id:id(91),source_kind:'ordinary_weekly',created_at_ms:NOW-1000});
  for(let n=1;n<=2;n++) f.insert('auction_bids',{id:id(91+n),league_id:id(20),season_id:id(21),auction_id:id(91),team_id:id(40+n),submitted_by_user_id:id(n),total_value_cents:123456788,term_years:2,lowest_offered_total_value_cents:123456788,lowest_offered_aav_cents:61728394,first_submitted_at_ms:NOW-100,last_edited_at_ms:NOW-100,status:'active'});
}
function auctionEvent(f,type,extra={}) { f.insert('auction_events',{id:crypto.randomUUID(),league_id:id(20),season_id:id(21),auction_id:id(91),event_type:type,occurred_at_ms:NOW,...extra}); }
test('a new competing bidder alerts participants without exposing terms; edits stay quiet',async t=>{
  const f=fixture(t); auction(f); auctionEvent(f,'bid_submitted',{team_id:id(42),actor_user_id:id(2)});
  await f.service.deliverDue(); assert.equal(f.sent.length,1); assert.match(f.sent[0].target.endpoint,/test-1$/);
  assert.equal(f.sent[0].payload.title,'New competing bid'); assert.equal(JSON.stringify(f.sent).includes('123456788'),false);
  auctionEvent(f,'bid_edited',{team_id:id(42),actor_user_id:id(2)}); await f.service.deliverDue(); assert.equal(f.sent.length,1);
});
test('auction results are individualized and closing reminders deduplicate',async t=>{
  const f=fixture(t); auction(f,HOUR); await f.service.deliverDue(); await f.service.deliverDue();
  assert.equal(f.sent.length,2); assert.equal(f.sent[0].payload.title,'Auction closes soon'); f.sent.length=0;
  f.db.prepare("UPDATE auctions SET status='resolved' WHERE id=?").run(id(91));
  f.db.prepare("UPDATE auction_bids SET status=CASE team_id WHEN ? THEN 'won' ELSE 'lost' END").run(id(41));
  auctionEvent(f,'auction_resolved'); await f.service.deliverDue();
  assert.deepEqual(f.sent.map(s=>s.payload.title).sort(),['Auction lost','Auction won']);
});
test('only explicitly important announcements send a phone alert; archived ones are suppressed',async t=>{
  const f=fixture(t);
  const message=n=>f.insert('league_communications',{id:id(100+n),league_id:id(20),created_by_user_id:id(1),kind:'announcement',title:'Long title',body:'Private announcement contents',audience:'members',pinned:0,notify:1,push_notify:n===1?0:1,recipient_count:2,client_key:'test-key-'+n,request_hash:'a'.repeat(64),created_at_ms:NOW});
  message(1); f.notify('league_announcement',2,{communicationId:id(101)}); await f.service.deliverDue(); assert.equal(f.sent.length,0);
  message(2); f.notify('league_announcement',2,{communicationId:id(102)}); await f.service.deliverDue(); assert.equal(f.sent.length,1); assert.equal(f.sent[0].payload.title,'Commissioner announcement');
  assert.equal(JSON.stringify(f.sent).includes('Private announcement contents'),false);
  message(3); f.notify('league_announcement',2,{communicationId:id(103)}); f.repo.collect(NOW,f.rosterDecision);
  f.db.prepare('UPDATE league_communications SET archived_at_ms=?,archived_by_user_id=? WHERE id=?').run(NOW,id(1),id(103));
  await f.service.deliverDue(); assert.equal(f.sent.length,1);
});
test('durable timer receipts prevent requeue after reset cleanup while a changed deadline sends once',async t=>{
 const f=fixture(t);auction(f,HOUR);await f.service.deliverDue();assert.equal(f.sent.length,2);
 f.db.prepare('DELETE FROM push_deliveries WHERE league_id=?').run(id(20));
 await f.service.deliverDue();assert.equal(f.sent.length,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM push_deliveries').get().n,0);
 f.db.prepare('UPDATE auctions SET resolves_at_ms=resolves_at_ms+60000 WHERE id=?').run(id(91));
 await f.service.deliverDue();assert.equal(f.sent.length,4);await f.service.deliverDue();assert.equal(f.sent.length,4);
});
test('preferences and team ownership are rechecked immediately before sending',async t=>{
  const f=fixture(t); f.week(); f.repo.collect(NOW,f.rosterDecision);
  f.repo.savePreferences(id(1),{...policy.DEFAULT_PREFERENCES,roster_lock:false},NOW);
  f.db.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=? WHERE user_id=?").run(NOW,id(2));
  await f.service.deliverDue(); assert.equal(f.sent.length,0);
});
test('temporary failures retry once due; expired subscriptions are removed',async t=>{
  const f=fixture(t); let now=NOW, attempts=0;
  const service=createPushService({repository:f.repo,clock:{nowMs:()=>now},rosterDecision:f.rosterDecision,adapter:{available:true,async send(){attempts++; throw {statusCode:attempts===1?503:410};}}});
  f.notify('league_calendar_changed'); await service.deliverDue(); assert.equal(attempts,1);
  await service.deliverDue(); assert.equal(attempts,1); now+=30_000; await service.deliverDue(); assert.equal(attempts,2);
  assert.equal(f.db.prepare('SELECT id FROM push_subscriptions WHERE user_id=?').get(id(1)),undefined);
});

test('commissioner actions are restricted to the current commissioner',async t=>{
  const f=fixture(t);
  f.db.prepare("UPDATE league_memberships SET permission_category='commissioner' WHERE id=?").run(id(31));
  f.db.prepare('UPDATE leagues SET commissioner_membership_id=? WHERE id=?').run(id(31),id(20));
  f.notify('fad_readiness_blocked',1); f.notify('fad_readiness_blocked',2);
  await f.service.deliverDue(); assert.equal(f.sent.length,1); assert.match(f.sent[0].target.endpoint,/test-1$/);
  assert.equal(f.sent[0].payload.url,`/leagues/${id(20)}/commissioner`);
});

test('push HTTP endpoints require origin, session and CSRF; GET is read-only',async t=>{
  const f=fixture(t),express=require('express');
  const {createPushRouter}=require('../../src/transport/http/createPushRouter');
  const {createTargetRequestSecurity}=require('../../src/transport/http/createTargetRequestSecurity');
  const {createSessionCookie}=require('../../src/transport/http/sessionCookie');
  const origin='http://localhost:5173',token=Buffer.alloc(32,41).toString('base64url'),csrf=Buffer.alloc(32,73).toString('base64url');
  const bootstrap={...f.auth,kind:'internal_session_bootstrap'};
  Object.defineProperty(bootstrap,'rawCsrfToken',{value:csrf});
  const security=createTargetRequestSecurity({isAllowedOrigin:o=>o===origin,sessionCookie:createSessionCookie({appEnv:'local',publicFrontendOrigin:origin,sameSite:'lax'}),sessionService:{bootstrap:raw=>raw===token?bootstrap:{valid:false},resolveWithCsrf:({rawSessionToken,rawCsrfToken})=>rawSessionToken!==token?{valid:false,code:'SESSION_INVALID'}:rawCsrfToken!==csrf?{valid:false,code:'CSRF_INVALID'}:f.auth}});
  const app=express(); app.use(createPushRouter({requestSecurity:security,service:f.service}));
  const server=app.listen(0,'127.0.0.1'); await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}/api/v1/push`;
  const headers={Origin:origin,Cookie:`hl_session=${token}`};
  const before=f.db.prepare('SELECT total_changes() n').get().n;
  let response=await fetch(base+'/settings',{headers}); assert.equal(response.status,200); assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal((await response.json()).data.preferences.trade_received,true); assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  response=await fetch(base+'/settings',{headers:{Origin:origin}}); assert.equal(response.status,401);
  response=await fetch(base+'/settings',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({preferences:policy.DEFAULT_PREFERENCES})}); assert.equal(response.status,403);
  response=await fetch(base+'/settings',{method:'POST',headers:{...headers,Origin:'https://evil.example','Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'}); assert.equal(response.status,403);
  response=await fetch(base+'/settings',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({preferences:{...policy.DEFAULT_PREFERENCES,trade_received:false}})}); assert.equal(response.status,200);
  assert.equal((await response.json()).data.preferences.trade_received,false);
  response=await fetch(base+'/subscriptions',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({subscription:f.sub(1)})}); assert.equal(response.status,200);
});

test('real roster reader works without statistics provider and preserves all league data',async t=>{
  const f=fixture(t); f.week();
  f.insert('league_settings',{league_id:id(20),salary_cap_cents:10000,maximum_teams:12,scoring_rule_version:1,standings_rule_version:1,created_at_ms:NOW,updated_at_ms:NOW});
  f.insert('matchups',{id:id(71),league_id:id(20),season_id:id(21),matchup_week_id:id(70),home_team_id:id(41),away_team_id:id(42),home_team_name:'Team 1',away_team_name:'Team 2',status:'scheduled',created_at_ms:NOW,updated_at_ms:NOW});
  const {createSqliteMatchupLockRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteMatchupLockRepository');
  const reader=createSqliteMatchupLockRepository({database:f.db});
  const changes=f.db.prepare('SELECT total_changes() n').get().n;
  const scope={leagueId:id(20),seasonId:id(21),weekId:id(70),teamId:id(41)};
  const context=reader.readRosterContext(scope); assert.equal(context.cap.complete,true); assert.equal(context.cap.capLimitCents,10000);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
  const tables=f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'push_%' AND name<>'notifications'").all();
  const snapshot=()=>Object.fromEntries(tables.map(({name})=>[name,f.db.prepare(`SELECT * FROM \"${name}\"`).all()]));
  const before=snapshot(), sent=[];
  const service=createPushService({repository:f.repo,clock:{nowMs:()=>NOW},adapter:{available:true,send:async(target,payload)=>sent.push(payload)},rosterDecision:scope=>{const ctx=reader.readRosterContext(scope);return ctx?policy.rosterLegality(ctx.activePlayers,ctx.cap):null;}});
  await service.deliverDue(); assert.equal(sent.length,2); assert.equal(sent[0].title,'Roster locks in 2 hours'); assert.deepEqual(snapshot(),before);
});

test('roster reminders preserve current production capacity rules and include cap warnings',()=>{
  const players=['F','D'].flatMap(position_group=>Array.from({length:position_group==='F'?12:6},(_,index)=>({player_id:position_group+index,position_group,slot_number:index+1})));
  assert.equal(policy.rosterLegality(players,{complete:true,capUsageCents:100,capLimitCents:100}).legal,true);
  assert.deepEqual(policy.rosterLegality(players,{complete:true,capUsageCents:101,capLimitCents:100}).reasonCodes,['SALARY_CAP_EXCEEDED']);
  assert.deepEqual(policy.rosterLegality(players,{complete:false,capUsageCents:0,capLimitCents:100}).reasonCodes,['SALARY_CAP_CALCULATION_INCOMPLETE']);
  assert.equal(policy.rosterLegality([],{complete:true,capUsageCents:0,capLimitCents:100}).legal,true);
  assert.deepEqual(policy.rosterLegality([...players,{player_id:'extra',position_group:'F'}],{complete:true,capUsageCents:0,capLimitCents:100}).reasonCodes,['ACTIVE_FORWARD_LIMIT_EXCEEDED']);
});

test('web-push creates encrypted delivery requests without any network call',()=>{
  const webPush=require('web-push'),vapid=webPush.generateVAPIDKeys(),receiver=crypto.createECDH('prime256v1'); receiver.generateKeys();
  const request=webPush.generateRequestDetails({endpoint:'https://fcm.googleapis.com/fcm/send/local-proof',keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}},JSON.stringify({title:'New trade offer',body:'Test league'}),{vapidDetails:{...vapid,subject:'mailto:grae@hundoleago.com'}});
  assert.equal(request.method,'POST'); assert.equal(request.headers['Content-Encoding'],'aes128gcm'); assert.equal(Buffer.isBuffer(request.body),true);
  assert.equal(request.body.includes(Buffer.from('New trade offer')),false); assert.match(request.headers.Authorization,/^vapid /);
});

test('independent device sessions retain both subscriptions and sign-out revokes only that device',async t=>{
 const f=fixture(t);
 const secureRandom={id:()=>crypto.randomUUID(),bytes:n=>crypto.randomBytes(n)};
 const sessions=require('../../src/infrastructure/persistence/sqlite/SqliteSessionRepository').createSqliteSessionRepository({database:f.db});
 const service=require('../../src/application/services/accounts/createSessionService').createSessionService({
  userRepository:require('../../src/infrastructure/persistence/sqlite/SqliteUserRepository').createSqliteUserRepository({database:f.db}),
  sessionRepository:sessions,sessionSecrets:require('../../src/infrastructure/security/createSessionSecrets').createSessionSecrets({secureRandom}),secureRandom,clock:{nowMs:()=>NOW}});
 const second=service.issueForUser({userId:id(1)});
 assert.equal(sessions.findById(id(11)).status,'active');
 f.repo.subscribe(id(1),second.session.id,f.sub(4),NOW-500);
 f.notify('league_calendar_changed');await f.service.deliverDue();
 assert.deepEqual(f.sent.map(x=>x.target.endpoint).sort(),[f.sub(1).endpoint,f.sub(4).endpoint].sort());
 f.sent.length=0;
 service.revoke({sessionId:second.session.id,expectedVersion:second.session.version,reason:'sign_out'});
 f.notify('league_calendar_changed');await f.service.deliverDue();
 assert.deepEqual(f.sent.map(x=>x.target.endpoint),[f.sub(1).endpoint]);
 f.sent.length=0;
 service.revokeAllForUser({userId:id(1),reason:'password_reset'});
 f.notify('league_calendar_changed');await f.service.deliverDue();assert.equal(f.sent.length,0);
 assert.equal(sessions.findById(id(12)).status,'active');
});
