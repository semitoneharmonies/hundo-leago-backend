const assert = require('node:assert/strict');
const { test } = require('node:test');
const { planTimingChange, timingBlockedReason } = require('../../src/domain/freeAgentDraft/fadTimingChangePolicy');
const { createFadTimingService } = require('../../src/application/services/freeAgentDraft/createFadTimingService');
const HOUR=3_600_000, DAY=24*HOUR, NOW=200*DAY;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture() {
  const draft={id:id(1),league_id:id(2),season_id:id(3),status:'cards_open',opened_at_ms:NOW-10*DAY,
    candidate_deadline_at_ms:NOW,help_opens_at_ms:NOW-2*DAY,first_matchup_starts_at_ms:NOW+7*DAY,
    initial_rollover_times_json:JSON.stringify([NOW+DAY,NOW+2*DAY]),updated_at_ms:NOW-10*DAY,version:1};
  const job=(type,key,at,n)=>({id:id(n),job_type:type,occurrence_key:key,scheduled_for_ms:at,status:'pending',lease_owner:null,
    lease_token:null,lease_expires_at_ms:null,last_error_code:null,updated_at_ms:NOW-10*DAY,version:1});
  const state={draft,league:{status:'active',current_season_id:id(3)},control:{mode:'held',version:1},
    readiness:{status:'succeeded',created_fad_id:id(1),deadline_job_run_id:id(10),reminder_job_run_id:id(11)},
    rollovers:[1,2].map(sequence=>({id:id(sequence+20),sequence,window_kind:'initial',status:'scheduled',
      rolls_over_at_ms:NOW+sequence*DAY,opens_at_ms:NOW+(sequence-1)*DAY,version:1,updated_at_ms:NOW-10*DAY})),
    jobs:[job('fad_deadline',`fad:${id(1)}:deadline:${NOW}`,NOW,10),job('fad_deadline_reminder',`fad:${id(1)}:reminder:${NOW-3*DAY}`,NOW-3*DAY,11),
      ...[1,2].map(n=>job('fad_rollover',`fad:${id(1)}:rollover:${n}:${NOW+n*DAY}`,NOW+n*DAY,n+11))],
    closedCards:0,auctions:0,allocations:0,snapshots:0};
  const input={deadlineAtMs:NOW+HOUR,rolloverTimesAtMs:[NOW+DAY+HOUR,NOW+2*DAY],reason:'More time for cards'};
  let writes=0, time=NOW, allowed=true;
  const scope={leagueId:id(2),fadId:id(1),authenticated:{}};
  const service=createFadTimingService({repository:{state:()=>state,transaction:work=>work(),replay:()=>null,apply:()=>{writes++;return{id:id(40)};}},
    clock:{nowMs:()=>time},leagueAuthorization:{requireCommissioner(){if(!allowed)throw Object.assign(new Error('denied'),{code:'LEAGUE_COMMISSIONER_REQUIRED'});return{actorUserId:id(50),authority:'commissioner'};}}});
  return {state,input,scope,service,writes:()=>writes,setTime:t=>{time=t;},revoke:()=>{allowed=false;}};
}
test('timing plans preserve identity and completed reminders, with canonical dependent clocks',()=>{
  const f=fixture(); f.state.jobs[1].status='succeeded';const before=structuredClone(f.state);
  const plan=planTimingChange(f.state,f.input,NOW);
  assert.deepEqual(f.state,before);
  assert.deepEqual(plan.afterJobs[1],before.jobs[1]);
  assert.equal(plan.afterRollovers[0].opens_at_ms,f.input.deadlineAtMs);
  assert.equal(plan.afterRollovers[1].opens_at_ms,f.input.rolloverTimesAtMs[0]);
  assert.equal(plan.afterJobs[0].occurrence_key,`fad:${id(1)}:deadline:${f.input.deadlineAtMs}`);
});
test('timing rejects past targets, changed round counts, malformed reasons and invalid round ordering',()=>{
  for(const change of [i=>i.deadlineAtMs=NOW,i=>i.deadlineAtMs=1.5,i=>i.reason='x',i=>i.reason='bad\nreason',i=>i.reason='x'.repeat(501),
    i=>i.extra=true,i=>i.rolloverTimesAtMs=[],i=>i.rolloverTimesAtMs.push(NOW+3*DAY),i=>i.rolloverTimesAtMs[0]=i.deadlineAtMs+HOUR,
    i=>i.rolloverTimesAtMs.reverse(),i=>i.rolloverTimesAtMs[1]=NOW+8*DAY]) {
    const f=fixture();change(f.input);assert.throws(()=>planTimingChange(f.state,f.input,NOW),{code:'FAD_TIMING_INVALID'});
  }
});
test('timing blocks processing, foreign season, incomplete bindings and busy jobs',()=>{
  for(const change of [s=>s.draft.status='rapid',s=>s.league.status='archived',s=>s.league.current_season_id=id(90),
    s=>s.closedCards=1,s=>s.auctions=1,s=>s.allocations=1,s=>s.snapshots=1,s=>s.readiness=null,
    s=>s.rollovers[0].status='processing',s=>s.rollovers.pop(),s=>s.jobs.pop(),s=>s.jobs[0].status='running',
    s=>s.jobs[1].status='failed',s=>s.jobs[0].lease_token='claimed',s=>s.jobs[2].occurrence_key='wrong']) {
    const f=fixture();change(f.state);assert.ok(timingBlockedReason(f.state));assert.throws(()=>planTimingChange(f.state,f.input,NOW),{code:'FAD_TIMING_CONFLICT'});
  }
});
test('confirmation rechecks authority, preview state and the future target without private card reads',()=>{
  for(const mode of ['revoked','stale','late','unconfirmed']) {
    const f=fixture();const preview=f.service.preview({...f.scope,input:f.input});
    const input={...f.input,confirmed:true,previewHash:preview.previewHash};
    if(mode==='revoked')f.revoke();if(mode==='stale')f.state.jobs[0].version++;if(mode==='late')f.setTime(f.input.deadlineAtMs);if(mode==='unconfirmed')input.confirmed=false;
    assert.throws(()=>f.service.apply({...f.scope,input,idempotencyKey:'timing-test-01'}),{code:{revoked:'LEAGUE_COMMISSIONER_REQUIRED',stale:'FAD_TIMING_PREVIEW_CHANGED',late:'FAD_TIMING_INVALID',unconfirmed:'FAD_TIMING_INVALID'}[mode]});
    assert.equal(f.writes(),0);
    assert.deepEqual(Object.keys(preview).sort(),['blockedReason','canReschedule','canEditDeadline','canEditActiveAuctions','affectedAuctions','roundDates','deadlineAtMs','fadId','held','leagueId','previewHash','proposed','reminderAlreadySent','rolloverTimesAtMs','serverNowMs','weekOneAtMs'].sort());
  }
});

function rapidFixture() {
  const f=fixture();
  Object.assign(f.state,{supportsRapidTiming:true,committedRoundIds:[],busyJobs:[],control:null,closedCards:4,auctions:1,snapshots:4});
  f.state.draft.status='rapid';
  f.state.jobs[0].status=f.state.jobs[1].status='succeeded';
  f.input.deadlineAtMs=NOW;
  f.input.rolloverTimesAtMs=[NOW+DAY,NOW+2*DAY+HOUR];
  return f;
}
function activeFixture() {
  const f=rapidFixture(),round=f.state.rollovers[0];
  f.state.supportsActiveTiming=true;f.state.queueRoundIds=[];
  f.state.committedRoundIds=[round.id];
  f.state.auctionClocks=[{id:id(80),fad_rollover_id:round.id,source_kind:'fad_open_rapid',fad_origin:'manager_nomination',
    status:'open',resolution_count:0,recovery_count:0,job_id:id(81),resolves_at_ms:round.rolls_over_at_ms,version:2}];
  f.state.auctionJobs=[{...f.state.jobs[2],id:id(81),job_type:'auction.resolve.target',
    occurrence_key:`auction:${id(80)}:${round.rolls_over_at_ms}`,attempt_count:0,result_json:null}];
  f.input.rolloverTimesAtMs=[NOW+DAY+HOUR,NOW+2*DAY];
  return f;
}
test('active timing coordinates direct manager auction jobs and a following opening without reading bids',()=>{
  const f=activeFixture(),before=structuredClone(f.state),plan=planTimingChange(f.state,f.input,NOW);
  assert.deepEqual(f.state,before);assert.equal(plan.auctionChanges.length,1);
  assert.equal(plan.auctionChanges[0].closesAtMs,NOW+DAY+HOUR);
  assert.equal(plan.auctionChanges[0].afterJob.scheduled_for_ms,NOW+DAY+HOUR);
  assert.equal(plan.afterRollovers[1].opens_at_ms,NOW+DAY+HOUR);
  assert.equal(plan.afterRollovers[0].opens_at_ms,NOW);
  assert.equal(f.service.preview({...f.scope,input:f.input}).affectedAuctions,1);
  const shorter=planTimingChange(f.state,{...f.input,rolloverTimesAtMs:[NOW+DAY-HOUR,NOW+2*DAY]},NOW);
  assert.equal(shorter.auctionChanges[0].closesAtMs,NOW+DAY-HOUR);
});
test('active timing refuses queue dependencies, restricted or completed auctions and claimed jobs',()=>{
  for(const change of [
    s=>s.queueRoundIds=[s.rollovers[0].id],s=>s.auctionClocks[0].fad_origin='queued_nomination',
    s=>s.auctionClocks[0].source_kind='fad_restricted',s=>s.auctionClocks[0].status='resolved',
    s=>s.auctionClocks[0].fad_origin='restricted_no_improvement_fallback',
    s=>s.auctionClocks[0].resolution_count=1,s=>s.auctionClocks[0].recovery_count=1,
    s=>s.auctionJobs[0].attempt_count=1,s=>s.auctionJobs[0].status='running',
    s=>s.auctionJobs[0].lease_token='claimed',s=>s.auctionJobs[0].result_json='{}',s=>s.auctionJobs=[],
  ]) {
    const f=activeFixture();change(f.state);
    assert.throws(()=>planTimingChange(f.state,f.input,NOW));
  }
  const f=activeFixture(),review=f.service.preview({...f.scope,input:f.input});
  f.state.auctionClocks[0].version++;
  assert.throws(()=>f.service.apply({...f.scope,input:{...f.input,confirmed:true,previewHash:review.previewHash},idempotencyKey:'active-stale-clock'}),{code:'FAD_TIMING_PREVIEW_CHANGED'});
  assert.equal(f.writes(),0);
});
test('rapid timing retains opened rounds and completed jobs while moving unused future clocks',()=>{
  const f=rapidFixture(),before=structuredClone(f.state),plan=planTimingChange(f.state,f.input,NOW);
  assert.deepEqual(f.state,before);
  assert.deepEqual(plan.afterRollovers[0],before.rollovers[0]);
  assert.deepEqual(plan.afterJobs.slice(0,3),before.jobs.slice(0,3));
  assert.equal(plan.afterRoot.candidate_deadline_at_ms,NOW);
  assert.equal(plan.afterRoot.help_opens_at_ms,before.draft.help_opens_at_ms);
  assert.equal(plan.afterJobs[3].scheduled_for_ms,NOW+2*DAY+HOUR);
  assert.equal(f.service.read(f.scope).canEditDeadline,false);
  assert.deepEqual(f.service.read(f.scope).roundDates.map(r=>r.canEdit),[false,true]);
  const shorter=planTimingChange(f.state,{...f.input,rolloverTimesAtMs:[NOW+DAY,NOW+2*DAY-HOUR]},NOW);
  assert.equal(shorter.afterJobs[3].scheduled_for_ms,NOW+2*DAY-HOUR);
});
test('rapid timing refuses protected dependencies, past openings, recovery and deadline changes',()=>{
  for(const change of [f=>f.state.committedRoundIds=[f.state.rollovers[1].id],
    f=>f.state.busyJobs=[{status:'running'}],
    f=>f.state.rollovers[1].window_kind='extension',f=>f.state.rollovers[0].status='processing',
    f=>f.state.jobs[3].lease_token='claimed',f=>f.state.jobs[0].status='pending']) {
    const f=rapidFixture();change(f);assert.throws(()=>planTimingChange(f.state,f.input,NOW),{code:'FAD_TIMING_CONFLICT'});
  }
  for(const change of [f=>f.input.deadlineAtMs++,f=>f.input.rolloverTimesAtMs[0]++,
    f=>f.input.rolloverTimesAtMs[1]=NOW+DAY]) {
    const f=rapidFixture();change(f);assert.throws(()=>planTimingChange(f.state,f.input,NOW),{code:'FAD_TIMING_INVALID'});
  }
  const f=rapidFixture(),review=f.service.preview({...f.scope,input:f.input});
  f.setTime(NOW+DAY);
  assert.throws(()=>f.service.apply({...f.scope,input:{...f.input,confirmed:true,previewHash:review.previewHash},idempotencyKey:'rapid-clock-elapsed'}),{code:'FAD_TIMING_CONFLICT'});
  assert.equal(f.writes(),0);
});
