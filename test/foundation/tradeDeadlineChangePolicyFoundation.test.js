const assert=require('node:assert/strict');
const {test}=require('node:test');
const {input,plan,blockedReason}=require('../../src/domain/leagues/tradeDeadlineChangePolicy');
const {createTradeDeadlineChangeService}=require('../../src/application/services/leagues/createTradeDeadlineChangeService');
const H=3600000,scope={leagueId:'league',authenticated:{current:true}};
function fixture(){
  const state={league:{id:'league',status:'active',timezone:'America/Vancouver',current_season_id:'season',version:1},season:{status:'active'},settings:{trade_deadline_at_ms:50*H,version:1},
    proposals:[{id:'one',proposal_model_version:2,created_at_ms:1,expires_at_ms:60*H,effective_deadline_at_ms:50*H,updated_at_ms:1,version:1},
      {id:'two',proposal_model_version:2,created_at_ms:1,expires_at_ms:30*H,effective_deadline_at_ms:30*H,updated_at_ms:1,version:1}]};
  let now=20*H,writes=0;
  const service=createTradeDeadlineChangeService({repository:{state:()=>state,history:()=>[],replay:()=>null,transaction:fn=>fn(),apply:()=>{writes++;return{id:'change'};}},
    clock:{nowMs:()=>now},leagueAuthorization:{requireCommissioner(auth){if(!auth.current)throw Object.assign(Error('Denied'),{code:'LEAGUE_COMMISSIONER_REQUIRED'});return{actorUserId:'commissioner',authority:'commissioner'};}}});
  return{state,service,setNow:value=>{now=value;},writes:()=>writes};
}
test('deadline edits shorten or extend unexpired proposals within their original lifetime without mutating input',()=>{
  const f=fixture(),before=structuredClone(f.state);
  const extended=plan(f.state,{tradeDeadlineAtMs:100*H,reason:'More trading time'},20*H);
  assert.equal(extended.after.length,1);assert.equal(extended.after[0].effective_deadline_at_ms,60*H);assert.equal(extended.impact.extended,1);
  const short=plan(f.state,{tradeDeadlineAtMs:25*H,reason:'Earlier deadline'},20*H);
  assert.equal(short.impact.shortened,2);assert.deepEqual(f.state,before);
});
test('reopening a passed deadline cannot revive expired pending proposals, including exact boundaries',()=>{
  const f=fixture();
  const at=plan(f.state,{tradeDeadlineAtMs:100*H,reason:'Reopen trading'},50*H);
  assert.equal(at.after.length,0);assert.equal(at.impact.expiredRetained,2);assert.equal(at.impact.reopensDeadline,true);
  const earlier=plan(f.state,{tradeDeadlineAtMs:100*H,reason:'More trading time'},30*H);
  assert.equal(earlier.impact.expiredRetained,1);assert.equal(earlier.after.length,1);
});
test('future input, active season, supported proposal clocks and unchanged dates are enforced',()=>{
  for(const tradeDeadlineAtMs of [NaN,null,'100',-1,1.5,8_640_000_000_000_001])assert.throws(()=>input({tradeDeadlineAtMs,reason:'Change dates'}),{code:'TRADE_DEADLINE_CHANGE_INVALID'});
  for(const reason of ['','a','x'.repeat(501),'line\nbreak'])assert.throws(()=>input({tradeDeadlineAtMs:100*H,reason}),{code:'TRADE_DEADLINE_CHANGE_INVALID'});
  const f=fixture();
  assert.throws(()=>plan(f.state,{tradeDeadlineAtMs:20*H,reason:'Change dates'},20*H),{code:'TRADE_DEADLINE_CHANGE_NOT_FUTURE'});
  assert.throws(()=>plan(f.state,{tradeDeadlineAtMs:50*H,reason:'Change dates'},20*H),{code:'TRADE_DEADLINE_CHANGE_UNCHANGED'});
  for(const change of [s=>s.league.status='frozen',s=>s.season.status='completed',s=>s.proposals[0].proposal_model_version=1,s=>s.settings.trade_deadline_at_ms=10*H]){
    const g=fixture();change(g.state);assert.notEqual(blockedReason(g.state),null);assert.throws(()=>plan(g.state,{tradeDeadlineAtMs:100*H,reason:'Change dates'},20*H),{code:'TRADE_DEADLINE_CHANGE_CONFLICT'});
  }
});
test('preview confirmation rejects revoked authority, proposal changes and a newly expired offer',()=>{
  const f=fixture(),value={tradeDeadlineAtMs:100*H,reason:'More trading time'};
  const preview=f.service.preview({...scope,input:value}),command={...scope,input:{...value,confirmed:true,previewHash:preview.previewHash},idempotencyKey:'deadline-change-1'};
  assert.equal(f.writes(),0);
  assert.throws(()=>f.service.apply({...command,authenticated:{current:false}}),{code:'LEAGUE_COMMISSIONER_REQUIRED'});
  f.state.proposals[0].version++;
  assert.throws(()=>f.service.apply(command),{code:'TRADE_DEADLINE_CHANGE_PREVIEW_CHANGED'});f.state.proposals[0].version--;
  f.setNow(30*H);assert.throws(()=>f.service.apply(command),{code:'TRADE_DEADLINE_CHANGE_PREVIEW_CHANGED'});
  f.setNow(20*H);assert.equal(f.service.apply(command).accepted,true);assert.equal(f.writes(),1);
});
