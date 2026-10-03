const assert=require('node:assert/strict');
const {test}=require('node:test');
const {planCutoff,cutoffInput}=require('../../src/domain/freeAgentDraft/fadAuctionCutoffPolicy');
const {classifyFreeAgentDraftNominationTiming}=require('../../src/domain/freeAgentDraft/freeAgentDraftPolicy');
const {createFadAuctionCutoffService}=require('../../src/application/services/freeAgentDraft/createFadAuctionCutoffService');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const H=3_600_000,scope={leagueId:id(1),fadId:id(2),authenticated:{current:true}};
function fixture(){
  const state={draft:{id:scope.fadId,league_id:scope.leagueId,season_id:id(3),status:'rapid'},
    league:{status:'active',current_season_id:id(3)},settings:null,busyJobs:[],committedRoundIds:[],
    rounds:[1,2].map(n=>({id:id(10+n),sequence:n,opens_at_ms:n*24*H,rolls_over_at_ms:(n+1)*24*H,
      creation_cutoff_at_ms:(n+1)*24*H-H,status:'scheduled',version:1,updated_at_ms:1}))};
  let time=25*H,writes=0;
  const service=createFadAuctionCutoffService({repository:{state:()=>state,replay:()=>null,transaction:fn=>fn(),apply:()=>{writes++;return{id:id(4)};}},
    clock:{nowMs:()=>time},leagueAuthorization:{requireCommissioner(auth){if(!auth.current)throw Object.assign(Error('Denied'),{code:'LEAGUE_COMMISSIONER_REQUIRED'});return{actorUserId:id(5),authority:'commissioner'};}}});
  return{state,service,setTime:n=>{time=n;},writes:()=>writes};
}
test('configurable gaps honor exact before/at boundaries including zero and shorter rounds',()=>{
  for(const minutes of [0,30,120,10080]){
    const f=fixture(),snapshot=structuredClone(f.state),plan=planCutoff(f.state,{gapMinutes:minutes,reason:'League timing change'},25*H);
    assert.deepEqual(f.state,snapshot);
    for(const r of plan.after){
      assert.equal(r.creation_cutoff_at_ms,Math.max(r.opens_at_ms,r.rolls_over_at_ms-minutes*60000));
      const classify=acceptedAtMs=>classifyFreeAgentDraftNominationTiming({acceptedAtMs,opensAtMs:r.opens_at_ms,creationCutoffAtMs:r.creation_cutoff_at_ms,rollsOverAtMs:r.rolls_over_at_ms});
      if(r.creation_cutoff_at_ms>r.opens_at_ms)assert.equal(classify(r.creation_cutoff_at_ms-1).disposition,'open_immediately');
      if(minutes>0)assert.equal(classify(r.creation_cutoff_at_ms).disposition,'queue_private');
      else assert.throws(()=>classify(r.creation_cutoff_at_ms));
    }
  }
});
test('cutoff plans retain committed and completed rounds and flag immediate window changes',()=>{
  const f=fixture();f.state.committedRoundIds=[f.state.rounds[1].id];
  const plan=planCutoff(f.state,{gapMinutes:120,reason:'League timing change'},46*H);
  assert.equal(plan.after.length,1);assert.equal(plan.changes[0].closesNow,true);assert.equal(plan.retained[0].sequence,2);
  assert.equal(planCutoff(f.state,{gapMinutes:30,reason:'League timing change'},47*H).changes[0].reopensNow,true);
  f.state.rounds[0].status='completed';
  const onlyFuture=planCutoff(f.state,{gapMinutes:30,reason:'Future extensions'},48*H);
  assert.equal(onlyFuture.after.length,0);assert.equal(onlyFuture.retained.length,2);
});
test('invalid input and busy, completed, wrong-season or overdue drafts fail closed',()=>{
  for(const gapMinutes of [-1,10081,0.5,'30',null,NaN])assert.throws(()=>cutoffInput({gapMinutes,reason:'Timing change'}),{code:'FAD_CUTOFF_INVALID'});
  for(const reason of ['','a','x'.repeat(501),'secret\ntext'])assert.throws(()=>cutoffInput({gapMinutes:30,reason}),{code:'FAD_CUTOFF_INVALID'});
  for(const change of [s=>s.league.status='archived',s=>s.league.current_season_id=id(9),s=>s.draft.status='completed',s=>s.busyJobs=[{status:'running'}],s=>s.rounds[0].status='recovery_required',s=>s.rounds[0].rolls_over_at_ms=1]){
    const f=fixture();change(f.state);assert.equal(f.service.read(scope).canEdit,false);
    assert.throws(()=>f.service.preview({...scope,input:{gapMinutes:30,reason:'Timing change'}}),{code:'FAD_CUTOFF_CONFLICT'});assert.equal(f.writes(),0);
  }
});
test('confirmation binds current authority, round evidence and time-sensitive nomination impact',()=>{
  const f=fixture(),input={gapMinutes:30,reason:'More nomination time'};
  f.setTime(47*H-1);
  const preview=f.service.preview({...scope,input}),command={...scope,input:{...input,confirmed:true,previewHash:preview.previewHash},idempotencyKey:'cutoff-confirm-1'};
  assert.equal(f.writes(),0);
  assert.throws(()=>f.service.apply({...command,authenticated:{current:false}}),{code:'LEAGUE_COMMISSIONER_REQUIRED'});
  f.setTime(47*H);
  assert.throws(()=>f.service.apply(command),{code:'FAD_CUTOFF_PREVIEW_CHANGED'});
  f.setTime(47*H-1);f.state.committedRoundIds.push(f.state.rounds[0].id);
  assert.throws(()=>f.service.apply(command),{code:'FAD_CUTOFF_PREVIEW_CHANGED'});assert.equal(f.writes(),0);
  f.state.committedRoundIds=[];assert.equal(f.service.apply(command).accepted,true);
});
