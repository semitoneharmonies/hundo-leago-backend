const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail,input,blockedReason,plan}=require('../../../domain/leagues/tradeDeadlineChangePolicy');
function createTradeDeadlineChangeService({repository,leagueAuthorization,clock}){
  function state(leagueId){if(!repository)fail('TRADE_DEADLINE_CHANGE_UNAVAILABLE');return repository.state(leagueId);}
  function project(s,nowMs){return{leagueId:s.league.id,seasonId:s.league.current_season_id,timeZone:s.league.timezone,
    tradeDeadlineAtMs:s.settings?.trade_deadline_at_ms??null,serverNowMs:nowMs,canEdit:blockedReason(s)===null,blockedReason:blockedReason(s)};}
  function review(s,value,actorUserId,nowMs){const p=plan(s,value,nowMs);return{...project(s,nowMs),proposed:p.proposed,impact:p.impact,
    previewHash:digest({state:s,proposed:p.proposed,actorUserId,impact:p.impact})};}
  return{
    read({leagueId,authenticated}){leagueAuthorization.requireCommissioner(authenticated,leagueId);const s=state(leagueId);
      return{...project(s,clock.nowMs()),history:repository.history(leagueId)};},
    preview({leagueId,authenticated,input:value}){const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);
      return review(state(leagueId),value,actor.actorUserId,clock.nowMs());},
    apply({leagueId,authenticated,input:value,idempotencyKey}){
      leagueAuthorization.requireCommissioner(authenticated,leagueId);
      if(!repository)fail('TRADE_DEADLINE_CHANGE_UNAVAILABLE');
      if(!value||Object.keys(value).sort().join()!=='confirmed,previewHash,reason,tradeDeadlineAtMs'||value.confirmed!==true||!/^[a-f0-9]{64}$/.test(value.previewHash||''))fail('TRADE_DEADLINE_CHANGE_INVALID');
      const proposed=input({tradeDeadlineAtMs:value.tradeDeadlineAtMs,reason:value.reason});let key;
      try{key=clientKey(idempotencyKey);}catch{fail('TRADE_DEADLINE_CHANGE_INVALID');}
      return repository.transaction(()=>{
        const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId),requestHash=digest({proposed,previewHash:value.previewHash});
        const prior=repository.replay(leagueId,actor.actorUserId,key);
        if(prior){if(prior.request_hash!==requestHash)fail('TRADE_DEADLINE_CHANGE_KEY_CONFLICT');return{leagueId,id:prior.id,accepted:true,replayed:true};}
        const s=state(leagueId),nowMs=clock.nowMs(),preview=review(s,proposed,actor.actorUserId,nowMs);
        if(preview.previewHash!==value.previewHash)fail('TRADE_DEADLINE_CHANGE_PREVIEW_CHANGED');
        const result=repository.apply({state:s,plan:plan(s,proposed,nowMs),actorUserId:actor.actorUserId,authority:actor.authority,clientKey:key,requestHash,nowMs});
        return{leagueId,id:result.id,accepted:true,replayed:false};
      });
    },
  };
}
module.exports={createTradeDeadlineChangeService};
