const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),Database=require('better-sqlite3');
const {applyMigrations,discoverMigrations}=require('../../src/infrastructure/database/migrate');
const {seedFixture}=require('../../src/operations/release/createReleaseQaFixture');
const {createScryptPasswordHasher}=require('../../src/infrastructure/security/createScryptPasswordHasher');
const {createCalendarWorkspaceService}=require('../../src/application/services/leagues/createCalendarWorkspaceService');
const {calendarWarnings}=require('../../src/domain/leagues/calendarWorkspaceWarnings');
const {nhlCalendarBreaks}=require('../../src/domain/leagues/nhlCalendarBreaks');
const now=Date.parse('2026-09-30T00:00:00Z');
async function setup(t,clockNow=now){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');t.after(()=>db.close());
 const migrations=discoverMigrations({migrationsDirectory:path.resolve(__dirname,'../../database/migrations')});
 const migrate=list=>applyMigrations({database:db,migrations:list,applicationBuildId:'calendar-workspace-test',now:()=>now});
 migrate(migrations.filter(m=>m.id<=66));
 const hash=await createScryptPasswordHasher({secureRandom:{bytes:crypto.randomBytes}}).hash('synthetic calendar fixture'),fixture=db.transaction(()=>seedFixture(db,hash)).immediate();
 await Promise.all(fixture.acceptancePromises);migrate(migrations);
 const repositories={},services={},leagueId=db.prepare("SELECT id FROM leagues WHERE name LIKE '%Alpha%'").get().id;
 const actor=db.prepare("SELECT m.user_id FROM league_memberships m JOIN leagues l ON l.id=m.league_id AND l.commissioner_membership_id=m.id WHERE l.id=?").get(leagueId).user_id;
 const leagueAuthorization={requireCommissioner(a,id){if(a?.id!==actor||id!==leagueId)throw Object.assign(Error('Denied'),{code:'LEAGUE_COMMISSIONER_REQUIRED'});return {actorUserId:actor,authority:'commissioner'};}},clock={nowMs:()=>clockNow};
 for(const [key,name,folder]of [['leagueCalendar','LeagueCalendar','leagues'],['leagueAuctionSchedule','LeagueAuctionSchedule','leagues'],['tradeDeadlineChange','TradeDeadlineChange','leagues'],['auctionTiming','AuctionTiming','auctions'],['fadTiming','FadTiming','freeAgentDraft']]){
  repositories[key]=require('../../src/infrastructure/persistence/sqlite/Sqlite'+name+'Repository')['createSqlite'+name+'Repository']({database:db});
  services[key]=require('../../src/application/services/'+folder+'/create'+name+'Service')['create'+name+'Service']({repository:repositories[key],leagueAuthorization,clock});
 }
 const service=createCalendarWorkspaceService({repositories,services,leagueAuthorization,clock}),args={leagueId,authenticated:{id:actor}};
 const snapshot=()=>Object.fromEntries(['leagues','league_settings','auctions','auction_bids','seasons','matchup_weeks','job_runs','league_calendar_changes','league_auction_schedule_changes','trade_deadline_changes','league_activity','notifications','league_communications'].filter(table=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 return {db,repositories,service,args,snapshot};
}
test('workspace composes public clocks, rejects unauthorized access and performs no writes when read or previewed',async t=>{
 const {db,service,args,snapshot}=await setup(t),before=snapshot(),changes=db.prepare('SELECT total_changes() n').get().n;
 const read=service.read(args);assert(read.expectedVersion);assert.equal(read.breaks.length,4);assert(Array.isArray(read.drafts));
 assert.throws(()=>service.read({...args,authenticated:{id:'manager'}}),{code:'LEAGUE_COMMISSIONER_REQUIRED'});
 assert.throws(()=>service.read({...args,leagueId:'different'}),{code:'LEAGUE_COMMISSIONER_REQUIRED'});
 const body={expectedVersion:read.expectedVersion,reason:'Calendar review',operations:[{kind:'trade',id:null,value:{tradeDeadlineAtMs:now+20*86400000}},{kind:'schedule',id:null,value:{closeWeekday:5,closeMinuteOfDay:1000,creationCutoffMinutes:60}}]};
 const preview=service.preview({...args,input:body});assert(preview.warnings.some(w=>w.code==='recurring-auctions'));
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.deepEqual(snapshot(),before);
 for(const a of read.auctions)assert(!Object.hasOwn(a,'bids')&&!Object.hasOwn(a,'userId'));
 for(const d of read.drafts)assert(!Object.hasOwn(d,'cards')&&!Object.hasOwn(d,'offers'));
});
test('one save commits trade and auction rules together, preserves bids, and retries without duplicate notices',async t=>{
 const {service,args,snapshot}=await setup(t),read=service.read(args),before=snapshot();
 const p=service.preview({...args,input:{expectedVersion:read.expectedVersion,reason:'Coordinate dates',operations:[{kind:'calendar',id:null,value:{calendar:{...read.calendar,regularSeasonEndsAtMs:read.calendar.regularSeasonEndsAtMs+86400000},weeks:read.weeks}},{kind:'trade',id:null,value:{tradeDeadlineAtMs:now+20*86400000}},{kind:'schedule',id:null,value:{closeWeekday:5,closeMinuteOfDay:1000,creationCutoffMinutes:60}}]}});
 const apply={...args,input:{...p.proposed,previewHash:p.previewHash,confirmed:true},idempotencyKey:'calendar-test-apply'};
 assert.equal(service.apply(apply).accepted,true);const after=snapshot();assert.equal(service.apply(apply).replayed,true);assert.deepEqual(snapshot(),after);
 assert.deepEqual(after.auction_bids,before.auction_bids);assert.deepEqual(after.auctions,before.auctions);assert.deepEqual(after.matchup_weeks,before.matchup_weeks);
 const current=service.read(args);assert.equal(current.trade.tradeDeadlineAtMs,now+20*86400000);assert.equal(current.schedule.schedule.closeWeekday,5);assert.equal(current.calendar.regularSeasonEndsAtMs,read.calendar.regularSeasonEndsAtMs+86400000);
 assert.throws(()=>service.apply({...apply,input:{...apply.input,reason:'Different edit'}}),/confirmation/);
});
test('failed second edit rolls back the first edit, audit and all notifications',async t=>{
 const {service,args,snapshot,repositories}=await setup(t),read=service.read(args);
 const p=service.preview({...args,input:{expectedVersion:read.expectedVersion,reason:'Atomic failure test',operations:[{kind:'trade',id:null,value:{tradeDeadlineAtMs:now+21*86400000}},{kind:'schedule',id:null,value:{closeWeekday:5,closeMinuteOfDay:1000,creationCutoffMinutes:60}}]}});
 const before=snapshot();repositories.leagueAuctionSchedule.apply=()=>{throw Error('Simulated storage failure');};
 assert.throws(()=>service.apply({...args,input:{...p.proposed,previewHash:p.previewHash,confirmed:true},idempotencyKey:'calendar-test-rollback'}),/Simulated/);assert.deepEqual(snapshot(),before);
});
test('stale drafts and invalid combined schedules never save any part',async t=>{
 const {service,args,db,snapshot}=await setup(t),read=service.read(args),body={expectedVersion:read.expectedVersion,reason:'Review safety',operations:[{kind:'trade',id:null,value:{tradeDeadlineAtMs:now+86400000}}]};
 const p=service.preview({...args,input:body});db.prepare('UPDATE leagues SET version=version+1 WHERE id=?').run(args.leagueId);const before=snapshot();
 assert.throws(()=>service.preview({...args,input:body}),/saved schedule changed/);
 assert.throws(()=>service.apply({...args,input:{...p.proposed,previewHash:p.previewHash,confirmed:true},idempotencyKey:'calendar-test-stale'}),/saved schedule changed/);assert.deepEqual(snapshot(),before);
 const fresh=service.read(args);
 assert.throws(()=>service.preview({...args,input:{...body,expectedVersion:fresh.expectedVersion,operations:[...body.operations,{kind:'schedule',id:null,value:{closeWeekday:0,closeMinuteOfDay:0,creationCutoffMinutes:100}}]}}));assert.deepEqual(snapshot(),before);
});
test('known NHL breaks are season-specific and unusual weeks create warnings',()=>{
 const calendar={regularSeasonStartsAtMs:Date.parse('2026-09-29T07:00Z'),fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00Z')};
 assert(nhlCalendarBreaks(calendar,'America/Vancouver').some(b=>b.firstDay==='2026-12-23'&&b.lastDay==='2026-12-25'));
 assert.deepEqual(nhlCalendarBreaks({regularSeasonStartsAtMs:Date.parse('2030-10-01T00:00Z')},'UTC'),[]);
 const weeks=[{id:'w',startsAtMs:Date.parse('2026-12-23T08:00Z'),endsAtMs:Date.parse('2026-12-28T08:00Z')}];
 const warnings=calendarWarnings({calendar,weeks,statuses:[{id:'w',sequence:2}],operations:[{kind:'calendar'}],plans:[{changes:[{id:'w',sequence:2,fields:['startsAtMs']}]}],timeZone:'America/Vancouver'});
 assert(warnings.some(w=>w.code==='unusual-week:w'));assert(warnings.some(w=>w.message.includes('christmas')));
});
test('auction and season changes respect SQLite boundaries when extending or shortening together',async t=>{
 const {FIXTURE_NOW_MS}=require('../../src/operations/release/releaseQaFixtureContract');
 const {service,args,db}=await setup(t,FIXTURE_NOW_MS),first=service.read(args),auction=first.auctions.find(a=>a.canEdit);
 assert(auction,'fixture must include an editable ordinary auction');
 const bids=db.prepare('SELECT * FROM auction_bids ORDER BY id').all();
 for(const [index,direction]of [1,-1].entries()){
  const current=service.read(args),calendar={...current.calendar,fantasyPlayoffsStartAtMs:current.calendar.fantasyPlayoffsStartAtMs+direction*86400000};
  const closesAtMs=calendar.fantasyPlayoffsStartAtMs-3600000;
  const p=service.preview({...args,input:{expectedVersion:current.expectedVersion,reason:'Coordinate auction and playoff dates',operations:[
   {kind:'auction',id:auction.id,value:{closesAtMs}},{kind:'calendar',id:null,value:{calendar,weeks:current.weeks}}]}});
  const request={...args,input:{...p.proposed,confirmed:true,previewHash:p.previewHash},idempotencyKey:'boundary-order-test-'+index};
  assert.equal(service.apply(request).accepted,true);assert.equal(service.apply(request).replayed,true);
  assert.equal(service.read(args).auctions.find(a=>a.id===auction.id).closesAtMs,closesAtMs);
 }
 assert.deepEqual(db.prepare('SELECT * FROM auction_bids ORDER BY id').all(),bids);
});
test('moving a week start and previous end saves their bound jobs atomically in a populated league',async t=>{
 const {service,args,db,repositories}=await setup(t),s=repositories.leagueCalendar.state(args.leagueId);
 const index=s.weeks.findIndex((w,i)=>i>0&&w.starts_at_ms>now+3*86400000&&w.status==='scheduled');
 assert(index>0);const pair=s.weeks.slice(index-1,index+1),generation=s.currentGeneration;
 const {buildMatchupOccurrenceKey}=require('../../src/domain/matchups/matchupJobPolicy');
 // This test-only fixture supplies the same pending job bindings as canonical
 // schedule generation. It never repairs the user's local or hosted league.
 for(const w of pair)for(const [suffix,at]of [['statistics_refresh',w.starts_at_ms],['baseline',w.baseline_at_ms],['lock',w.locks_at_ms],['statistics_refresh',w.ends_at_ms],['finalize',w.ends_at_ms],['rollover',w.rolls_over_at_ms]]){
  const id=crypto.randomUUID(),type='matchup:'+suffix,key=buildMatchupOccurrenceKey({jobType:type,leagueId:args.leagueId,seasonId:s.season.id,weekId:w.id,scheduleOperationId:generation.schedule_operation_id,scheduleVersion:generation.schedule_version,scheduledForMs:at});
  db.prepare("INSERT INTO job_runs(id,league_id,season_id,job_type,occurrence_key,scheduled_for_ms,status,attempt_count,created_at_ms,updated_at_ms,version) VALUES(?,?,?,?,?,?,'pending',0,?,?,1)").run(id,args.leagueId,s.season.id,type,key,at,now,now);
  db.prepare('INSERT INTO matchup_schedule_job_bindings(id,league_id,season_id,job_run_id,job_type,schedule_operation_id,schedule_version,owning_matchup_week_id,created_at_ms,version) VALUES(?,?,?,?,?,?,?,?,?,1)').run(id,args.leagueId,s.season.id,id,type,generation.schedule_operation_id,generation.schedule_version,w.id,now);
 }
 const read=service.read(args),weeks=structuredClone(read.weeks),current=weeks.find(w=>w.id===pair[1].id),previous=weeks.find(w=>w.id===pair[0].id),beforeBids=db.prepare('SELECT * FROM auction_bids ORDER BY id').all();
 current.startsAtMs-=86400000;current.baselineAtMs=current.startsAtMs;current.locksAtMs-=86400000;previous.endsAtMs=current.startsAtMs;previous.rollsOverAtMs=current.startsAtMs;
 const p=service.preview({...args,input:{expectedVersion:read.expectedVersion,reason:'Earlier weekly boundary',operations:[{kind:'calendar',id:null,value:{calendar:read.calendar,weeks}}]}});
 service.apply({...args,input:{...p.proposed,previewHash:p.previewHash,confirmed:true},idempotencyKey:'paired-matchup-boundary'});
 const after=service.read(args),a=after.weeks.find(w=>w.id===current.id),b=after.weeks.find(w=>w.id===previous.id);
 assert.equal(a.startsAtMs,b.endsAtMs);assert.equal(a.startsAtMs,current.startsAtMs);
 const jobs=repositories.leagueCalendar.state(args.leagueId).jobs;
 assert(jobs.some(j=>j.weekId===a.id&&j.job_type==='matchup:baseline'&&j.scheduled_for_ms===a.baselineAtMs));
 assert(jobs.some(j=>j.weekId===b.id&&j.job_type==='matchup:finalize'&&j.scheduled_for_ms===b.endsAtMs));
 assert.deepEqual(db.prepare('SELECT * FROM auction_bids ORDER BY id').all(),beforeBids);
});
