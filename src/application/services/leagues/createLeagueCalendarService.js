const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail,input,calendar,plan,blockedReason}=require('../../../domain/leagues/leagueCalendarPolicy');
function createLeagueCalendarService({repository,leagueAuthorization,clock}) {
 function state(leagueId){if(!repository)fail('Calendar controls are not available yet.','LEAGUE_CALENDAR_UNAVAILABLE');return repository.state(leagueId);}
 function project(s){return {leagueId:s.league.id,seasonId:s.season?.id??null,timeZone:s.league.timezone,
  blockedReason:blockedReason(s),events:repository.events?.(s.league.id)||[],
  serverNowMs:clock.nowMs(),...(s.season?calendar(s):{calendar:null,weeks:[]}),
  weekOneShift:s.fadCount===0&&s.currentGeneration&&s.weeks[0]?.status==='scheduled'&&s.weeks[0].starts_at_ms>clock.nowMs()
    ?{weekId:s.weeks[0].id,version:s.weeks[0].version,startsAtMs:s.weeks[0].starts_at_ms}:null,
  weekStatus:s.weeks.map(w=>({id:w.id,sequence:w.sequence,status:w.status})),history:repository.history(s.league.id)};}
 function review(s,value,actorUserId){const p=plan(s,value,clock.nowMs());return {...project(s),proposed:p.proposed,
  changes:p.changes,seasonFields:p.seasonFields,pendingJobs:p.jobChanges.length,reopensAuctions:p.reopensAuctions,closesAuctions:p.closesAuctions,recoversUnprocessedLock:p.recoversUnprocessedLock,
  previewHash:digest({state:s,proposed:p.proposed,actorUserId,jobChanges:p.jobChanges,reopensAuctions:p.reopensAuctions,closesAuctions:p.closesAuctions,recoversUnprocessedLock:p.recoversUnprocessedLock})};}
 return {
  read({leagueId,authenticated}){leagueAuthorization.requireCommissioner(authenticated,leagueId);return project(state(leagueId));},
  preview({leagueId,authenticated,input:value}){const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);return review(state(leagueId),value,actor.actorUserId);},
  apply({leagueId,authenticated,input:value,idempotencyKey}){
   leagueAuthorization.requireCommissioner(authenticated,leagueId);
   if(!value||Object.keys(value).sort().join()!=='calendar,confirmed,previewHash,reason,weeks'||value.confirmed!==true||!/^[a-f0-9]{64}$/.test(value.previewHash||''))
    fail('Review the calendar before confirming.','LEAGUE_CALENDAR_INVALID');
   const proposed=input({calendar:value.calendar,weeks:value.weeks,reason:value.reason});let key;
   try{key=clientKey(idempotencyKey);}catch{fail('A valid confirmation key is required.','LEAGUE_CALENDAR_INVALID');}
   if(!repository)state(leagueId);
   return repository.transaction(()=>{
    const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId),requestHash=digest({proposed,previewHash:value.previewHash});
    const prior=repository.replay(leagueId,actor.actorUserId,key);
    if(prior){if(prior.request_hash!==requestHash)fail('This confirmation was already used for a different change.');return {leagueId,id:prior.id,accepted:true,replayed:true};}
    const s=state(leagueId),preview=review(s,proposed,actor.actorUserId);
    if(preview.previewHash!==value.previewHash)fail('The calendar or pending work changed. Review again.','LEAGUE_CALENDAR_PREVIEW_CHANGED');
    const result=repository.apply({state:s,plan:plan(s,proposed,clock.nowMs()),actorUserId:actor.actorUserId,authority:actor.authority,clientKey:key,requestHash,nowMs:clock.nowMs()});
    return {leagueId,id:result.id,accepted:true,replayed:false};
   });
  },
 };
}
module.exports={createLeagueCalendarService};
