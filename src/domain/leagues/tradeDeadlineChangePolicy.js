function fail(code='TRADE_DEADLINE_CHANGE_CONFLICT'){throw Object.assign(new Error(code),{code});}
function input(value){
  if(!value||Array.isArray(value)||Object.keys(value).sort().join()!=='reason,tradeDeadlineAtMs'||
    !Number.isSafeInteger(value.tradeDeadlineAtMs)||value.tradeDeadlineAtMs<0||value.tradeDeadlineAtMs>8_640_000_000_000_000||
    typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.reason))fail('TRADE_DEADLINE_CHANGE_INVALID');
  return{tradeDeadlineAtMs:value.tradeDeadlineAtMs,reason:value.reason.trim()};
}
function blockedReason(state){
  if(!['setup','active'].includes(state.league.status))return 'The league must be in setup or active.';
  if(!state.settings)return 'League settings are unavailable.';
  if(state.league.status==='active'&&state.season?.status!=='active')return 'An active current season is required.';
  if(state.proposals.some(p=>p.proposal_model_version!==2||!Number.isSafeInteger(p.effective_deadline_at_ms)))return 'A legacy pending proposal needs review before changing the deadline.';
  if(state.proposals.some(p=>state.settings.trade_deadline_at_ms===null||p.effective_deadline_at_ms>state.settings.trade_deadline_at_ms))return 'A pending proposal has inconsistent timing and needs review first.';
  return null;
}
function plan(state,value,nowMs){
  const proposed=input(value);
  if(blockedReason(state))fail();
  if(proposed.tradeDeadlineAtMs<=nowMs)fail('TRADE_DEADLINE_CHANGE_NOT_FUTURE');
  if(proposed.tradeDeadlineAtMs===state.settings.trade_deadline_at_ms)fail('TRADE_DEADLINE_CHANGE_UNCHANGED');
  const before=[],after=[];let expiredRetained=0,shortened=0,extended=0;
  for(const p of state.proposals){
    // Even an expiry the worker has not yet recorded is final. Never revive it.
    if(p.effective_deadline_at_ms<=nowMs||p.expires_at_ms<=nowMs||
       (state.settings.trade_deadline_at_ms!==null&&state.settings.trade_deadline_at_ms<=nowMs)){expiredRetained++;continue;}
    const at=Math.min(p.expires_at_ms,proposed.tradeDeadlineAtMs);
    if(at===p.effective_deadline_at_ms)continue;
    before.push(p);after.push({...p,effective_deadline_at_ms:at,updated_at_ms:Math.max(nowMs,p.updated_at_ms),version:p.version+1});
    if(at<p.effective_deadline_at_ms)shortened++;else extended++;
  }
  return{proposed,before,after,impact:{shortened,extended,expiredRetained,unchanged:state.proposals.length-before.length-expiredRetained,
    reopensDeadline:state.settings.trade_deadline_at_ms!==null&&state.settings.trade_deadline_at_ms<=nowMs}};
}
module.exports={fail,input,blockedReason,plan};
