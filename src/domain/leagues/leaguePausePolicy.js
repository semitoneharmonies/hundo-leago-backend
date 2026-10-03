function fail(message,code='LEAGUE_PAUSE_CONFLICT'){const error=new Error(message);error.code=code;throw error;}
function input(value){
  if(!value||Object.keys(value).sort().join()!=='action,reason'||!['pause','resume'].includes(value.action)||typeof value.reason!=='string'||
    value.reason.trim().length<3||value.reason.trim().length>500||/[\u0000-\u001f\u007f]/u.test(value.reason))fail('Choose pause or resume and provide a reason.','LEAGUE_PAUSE_INVALID');
  return {action:value.action,reason:value.reason.trim()};
}
function plan(state,value,nowMs){
  const proposed=input(value);
  if(proposed.action==='pause'){
    if(state.freeze||!['active','setup'].includes(state.league.status))fail('This league is already paused or cannot be paused in its current state.');
    if(state.busyJobs.length)fail('League processing is in progress. Let it finish, or use recovery for an interrupted operation, before pausing.');
  }else if(!state.freeze||state.league.status!=='frozen'||!state.originalStatus)fail('This pause was not created by these controls. Its original operating state must be recovered explicitly.');
  const dueJobs=state.jobs.filter(j=>j.nextAttemptAtMs===null?j.scheduledForMs<=nowMs:j.nextAttemptAtMs<=nowMs);
  const dueAuctions=state.auctions.filter(a=>a.resolvesAtMs<=nowMs);
  const expiredProposals=state.proposals.filter(t=>t.deadlineAtMs<=nowMs);
  return {proposed,restoredStatus:proposed.action==='resume'?state.originalStatus:null,
    impacts:{pendingJobs:state.jobs.length,dueJobs:dueJobs.length,openAuctions:state.auctions.length,dueAuctions:dueAuctions.length,
      pendingProposals:state.proposals.length,expiredProposals:expiredProposals.length},
    overdue:dueJobs.length+dueAuctions.length+expiredProposals.length>0};
}
module.exports={fail,input,plan};
