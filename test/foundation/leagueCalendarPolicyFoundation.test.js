const {test}=require('node:test');const assert=require('node:assert/strict');
const {plan,calendar}=require('../../src/domain/leagues/leagueCalendarPolicy');
const {buildMatchupOccurrenceKey}=require('../../src/domain/matchups/matchupJobPolicy');
const uuid=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
function fixture(){
 const league={id:uuid(1),status:'active'},season={id:uuid(2),status:'active',regular_season_starts_at_ms:1000,regular_season_ends_at_ms:30000,fantasy_playoffs_start_at_ms:20000,fantasy_playoffs_end_at_ms:28000};
 const weeks=[{id:uuid(3),sequence:1,status:'scheduled',starts_at_ms:2000,baseline_at_ms:2100,locks_at_ms:2200,ends_at_ms:5000,rolls_over_at_ms:5100},
 {id:uuid(4),sequence:2,status:'scheduled',starts_at_ms:6000,baseline_at_ms:6100,locks_at_ms:6200,ends_at_ms:9000,rolls_over_at_ms:9100}];
 const state={league,season,weeks,currentGeneration:{},jobs:[],lockedWeekIds:[],openAuctions:[]};
 for(const w of weeks)for(const [type,time]of [['statistics_refresh',w.starts_at_ms],['baseline',w.baseline_at_ms],['lock',w.locks_at_ms],['statistics_refresh',w.ends_at_ms],['finalize',w.ends_at_ms],['rollover',w.rolls_over_at_ms]]){
  const jobType='matchup:'+type;state.jobs.push({id:uuid(state.jobs.length+10),weekId:w.id,job_type:jobType,scheduled_for_ms:time,
   occurrence_key:buildMatchupOccurrenceKey({jobType,leagueId:league.id,seasonId:season.id,weekId:w.id,scheduleOperationId:uuid(90),scheduleVersion:1,scheduledForMs:time}),
   status:'pending',version:1,attempt_count:0,lease_owner:null,started_at_ms:null,result_json:null});
 }
 return state;
}
function proposed(s){return {...calendar(s),reason:'League agreed to revised dates'};}

test('calendar edits cannot invalidate pending FAD readiness or completion schedule bindings',()=>{
 const s=fixture(),p=proposed(s);p.weeks[1].locksAtMs=6500;s.unfinishedDraft=true;
 assert.throws(()=>plan(s,p,1500),/unfinished Free Agent Draft/);
 s.unfinishedDraft=false;assert.equal(plan(s,p,1500).changes.length,1);
});
test('moves the exact pending jobs for a future week and retains original generation identity',()=>{
 const s=fixture(),p=proposed(s);p.weeks[1].locksAtMs=6500;
 const result=plan(s,p,1500);assert.equal(result.changes.length,1);assert.equal(result.jobChanges.length,1);
 assert.equal(result.jobChanges[0].scheduledForMs,6500);assert.ok(result.jobChanges[0].occurrenceKey.endsWith(':1:6500'));
 assert.equal(s.weeks[1].locks_at_ms,6200);
});
test('allows a live week end extension without moving its locked start or roster',()=>{
 const s=fixture();s.weeks[0].status='live';s.lockedWeekIds=[s.weeks[0].id];
 const p=proposed(s);p.weeks[0].endsAtMs=5500;p.weeks[0].rollsOverAtMs=5600;
 const result=plan(s,p,3000);assert.equal(result.jobChanges.length,3);
 assert.deepEqual(result.changes[0].fields,['endsAtMs','rollsOverAtMs']);
 p.weeks[0].locksAtMs=3500;assert.throws(()=>plan(s,p,3000),/roster locks/);
});
test('rejects overlaps, invalid season dates, cross-season weeks and first-week generation changes',()=>{
 const s=fixture();
 for(const change of [
  p=>{p.weeks[0].endsAtMs=6500;p.weeks[0].rollsOverAtMs=6600;},
  p=>{p.calendar.fantasyPlayoffsEndAtMs=31000;},
  p=>{p.weeks[0].id=uuid(999);},
  p=>{p.weeks[0].startsAtMs=1900;},
 ]){const p=proposed(s);change(p);assert.throws(()=>plan(s,p,1500));}
});
test('refuses claimed, attempted and completed work even when its old deadline is still future',()=>{
 for(const overrides of [{status:'running'},{attempt_count:1},{lease_owner:'worker'},{started_at_ms:1200},{result_json:'{}'}]){
  const s=fixture();Object.assign(s.jobs.find(j=>j.weekId===s.weeks[1].id&&j.job_type==='matchup:lock'),overrides);
  const p=proposed(s);p.weeks[1].locksAtMs=6500;assert.throws(()=>plan(s,p,1500),/claimed or attempted/);
 }
});
test('refuses elapsed changes and protects completed results and existing auction close promises',()=>{
 const s=fixture(),p=proposed(s);p.weeks[1].locksAtMs=6500;assert.equal(plan(s,p,6300).recoversUnprocessedLock,true);assert.throws(()=>plan(s,p,6600),/future boundary/);
 s.weeks[1].status='final';assert.throws(()=>plan(s,p,1500),/processed results/);
 const s2=fixture(),p2=proposed(s2);p2.calendar.fantasyPlayoffsStartAtMs=19000;s2.openAuctions=[{resolves_at_ms:19500}];
 assert.throws(()=>plan(s2,p2,1500),/open auction/);
});
test('previews a reopening at a passed playoff boundary without reviving or modifying results',()=>{
 const s=fixture();s.weeks.forEach(w=>w.status='final');const p=proposed(s);p.calendar.fantasyPlayoffsStartAtMs=25000;
 const result=plan(s,p,21000);assert.equal(result.reopensAuctions,true);assert.equal(result.changes.length,0);assert.equal(result.jobChanges.length,0);
});
test('rejects unknown fields, duplicate weeks, unsafe numbers and invalid reasons',()=>{
 const s=fixture();for(const modify of [
  p=>{p.privateBid=10;},p=>p.weeks.push(p.weeks[0]),p=>{p.calendar.fantasyPlayoffsEndAtMs=NaN;},p=>{p.reason='x';},
 ]){const p=proposed(s);modify(p);assert.throws(()=>plan(s,p,1500),{code:'LEAGUE_CALENDAR_INVALID'});}
});



test('missed unattempted locks can move; existing results and leases cannot',()=>{
 for(const change of [s=>s.resultWeekIds=[s.weeks[1].id],s=>s.lockedWeekIds=[s.weeks[1].id],s=>s.jobs.find(j=>j.job_type==='matchup:lock'&&j.weekId===s.weeks[1].id).lease_token='claimed']){
  const s=fixture(),p=proposed(s);p.weeks[1].locksAtMs=7000;change(s);assert.throws(()=>plan(s,p,6300));
 }
});
