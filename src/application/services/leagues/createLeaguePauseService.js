const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail,input,plan}=require('../../../domain/leagues/leaguePausePolicy');
function createLeaguePauseService({repository,leagueAuthorization,clock}){
  function ready(){if(!repository)fail('Pause controls are not available yet.','LEAGUE_PAUSE_UNAVAILABLE');}
  function review(state,value,actorUserId){const result=plan(state,value,clock.nowMs());return {leagueId:state.league.id,...result,previewHash:digest({state,result,actorUserId})};}
  return {
    status({leagueId,authenticated}){leagueAuthorization.requireActiveMembership(authenticated,leagueId);ready();return repository.status(leagueId);},
    read({leagueId,authenticated}){
      leagueAuthorization.requireCommissioner(authenticated,leagueId);ready();const state=repository.state(leagueId);
      return {...repository.status(leagueId),canResume:Boolean(state.originalStatus),busyJobs:state.busyJobs.length,interruptedJobs:state.busyJobs.filter(j=>Number.isSafeInteger(j.leaseExpiresAtMs)&&j.leaseExpiresAtMs<clock.nowMs()).length,reason:state.freeze?.reason??null,
        jobs:state.jobs.map(({id,type,status,scheduledForMs})=>({id,type,status,scheduledForMs})),
        auctionCount:state.auctions.length,proposalCount:state.proposals.length};
    },
    preview({leagueId,authenticated,input:value}){const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);ready();return review(repository.state(leagueId),value,actor.actorUserId);},
    apply({leagueId,authenticated,input:value,idempotencyKey}){
      leagueAuthorization.requireCommissioner(authenticated,leagueId);ready();
      if(!value||Object.keys(value).sort().join()!=='action,confirmed,previewHash,reason'||value.confirmed!==true||!/^[a-f0-9]{64}$/.test(value.previewHash||''))fail('Review the pause or resume before confirming.','LEAGUE_PAUSE_INVALID');
      const proposed=input({action:value.action,reason:value.reason});let key;
      try{key=clientKey(idempotencyKey);}catch{fail('A valid confirmation key is required.','LEAGUE_PAUSE_INVALID');}
      return repository.transaction(()=>{
        const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId),requestHash=digest({proposed,previewHash:value.previewHash});
        const prior=repository.replay(leagueId,actor.actorUserId,key);
        if(prior){if(prior.request_hash!==requestHash||prior.action_type!==proposed.action)fail('This confirmation was used for another change.');return {leagueId,id:prior.id,accepted:true,replayed:true};}
        const state=repository.state(leagueId),preview=review(state,proposed,actor.actorUserId);
        if(preview.previewHash!==value.previewHash)fail('The league or due work changed. Review again.','LEAGUE_PAUSE_PREVIEW_CHANGED');
        const result=repository.apply({state,plan:preview,actorUserId:actor.actorUserId,authority:actor.authority,clientKey:key,requestHash,nowMs:clock.nowMs()});
        return {leagueId,id:result.id,accepted:true,replayed:false};
      });
    },
  };
}
module.exports={createLeaguePauseService};
