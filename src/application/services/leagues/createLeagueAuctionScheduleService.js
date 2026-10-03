const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail,input,settings,window,plan}=require('../../../domain/leagues/leagueAuctionSchedulePolicy');
function createLeagueAuctionScheduleService({repository,leagueAuthorization,clock}){
 function state(id){if(!repository)fail('Auction schedule controls are not available yet.','LEAGUE_AUCTION_SCHEDULE_UNAVAILABLE');return repository.state(id);}
 function project(s){const now=clock.nowMs();return {leagueId:s.league.id,timeZone:s.league.timezone,serverNowMs:now,
  schedule:settings(s.current),legacyDaily:s.stagingDaily&&!s.current,window:window(s,now),openAuctionCount:s.openAuctionCount,
  revision:s.current?.revision||0,history:repository.history(s.league.id)};}
 function review(s,value,actorUserId){const p=plan(s,value,clock.nowMs());return {...project(s),proposed:p.proposed,newWindow:p.after,opensNow:p.opensNow,closesNow:p.closesNow,
  previewHash:digest({state:s,proposed:p.proposed,actorUserId,before:p.before,after:p.after})};}
 return{
  read({leagueId,authenticated}){leagueAuthorization.requireCommissioner(authenticated,leagueId);return project(state(leagueId));},
  preview({leagueId,authenticated,input:value}){const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);return review(state(leagueId),value,actor.actorUserId);},
  apply({leagueId,authenticated,input:value,idempotencyKey}){
   leagueAuthorization.requireCommissioner(authenticated,leagueId);
   if(!value||Object.keys(value).sort().join()!=='closeMinuteOfDay,closeWeekday,confirmed,creationCutoffMinutes,previewHash,reason'||value.confirmed!==true||!/^[a-f0-9]{64}$/.test(value.previewHash||''))
    fail('Review the proposed schedule before confirming.','LEAGUE_AUCTION_SCHEDULE_INVALID');
   const proposed=input({closeMinuteOfDay:value.closeMinuteOfDay,closeWeekday:value.closeWeekday,creationCutoffMinutes:value.creationCutoffMinutes,reason:value.reason});
   let key;try{key=clientKey(idempotencyKey);}catch{fail('A valid confirmation key is required.','LEAGUE_AUCTION_SCHEDULE_INVALID');}
   if(!repository)state(leagueId);
   return repository.transaction(()=>{
    const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId),requestHash=digest({proposed,previewHash:value.previewHash});
    const prior=repository.replay(leagueId,actor.actorUserId,key);
    if(prior){if(prior.request_hash!==requestHash)fail('This confirmation was used for another change.');return{leagueId,id:prior.id,accepted:true,replayed:true};}
    const s=state(leagueId),preview=review(s,proposed,actor.actorUserId);
    if(preview.previewHash!==value.previewHash)fail('The league or auction window changed. Review again.','LEAGUE_AUCTION_SCHEDULE_PREVIEW_CHANGED');
    const result=repository.apply({state:s,proposed,actorUserId:actor.actorUserId,authority:actor.authority,clientKey:key,requestHash,nowMs:clock.nowMs()});
    return{leagueId,id:result.id,accepted:true,replayed:false};
   });
  },
 };
}
module.exports={createLeagueAuctionScheduleService};

