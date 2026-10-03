const {digest,clientKey} = require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail,input,missingPickPlan,plan} = require('../../../domain/leagues/leaguePickRepairPolicy');
function createLeaguePickRepairService({repository,leagueAuthorization,clock}) {
  function ready(authenticated,leagueId) {
    const actor = leagueAuthorization.requireCommissioner(authenticated,leagueId);
    if (!repository) fail('Draft-pick repair is not available yet.','PICK_REPAIR_UNAVAILABLE');
    return actor;
  }
  function review(state,value,actorUserId) {
    const result = plan(state,value);
    return {leagueId:state.league.id,...result,previewHash:digest({state,proposed:result.proposed,actorUserId})};
  }
  return {
    read({leagueId,authenticated}) {
      ready(authenticated,leagueId);
      return {leagueId,drafts:repository.drafts(leagueId).map(draft=>{
        const state = repository.state(leagueId,draft.id);
        const teams = state.teams.filter(t=>['setup','active'].includes(t.status)).map(t=>({id:t.id,name:t.name}));
        try {return {...draft,teams,missing:missingPickPlan(state),blockedReason:null};}
        catch(error) {if(error.code!=='PICK_REPAIR_CONFLICT')throw error;return {...draft,teams,missing:[],blockedReason:error.message};}
      })};
    },
    preview({leagueId,authenticated,input:value}) {
      const actor = ready(authenticated,leagueId), proposed = input(value);
      return review(repository.state(leagueId,proposed.draftId),proposed,actor.actorUserId);
    },
    apply({leagueId,authenticated,input:value,idempotencyKey}) {
      ready(authenticated,leagueId);
      if (!value || Object.keys(value).sort().join()!=='confirmed,draftId,owners,previewHash,reason' || value.confirmed!==true || !/^[a-f0-9]{64}$/.test(value.previewHash||'')) {
        fail('Review missing picks before confirming.','PICK_REPAIR_INVALID');
      }
      const proposed = input({draftId:value.draftId,owners:value.owners,reason:value.reason});
      let key; try {key=clientKey(idempotencyKey);} catch {fail('A valid confirmation key is required.','PICK_REPAIR_INVALID');}
      return repository.transaction(()=>{
        const actor=ready(authenticated,leagueId),requestHash=digest({proposed,previewHash:value.previewHash});
        const prior=repository.replay(leagueId,actor.actorUserId,key);
        if(prior) {
          if(prior.action_type!=='pick_repair'||prior.request_hash!==requestHash)fail('This confirmation key was used for another change.');
          return {leagueId,id:prior.id,accepted:true,replayed:true};
        }
        const state=repository.state(leagueId,proposed.draftId),preview=review(state,proposed,actor.actorUserId);
        if(preview.previewHash!==value.previewHash)fail('The draft or league changed. Review the missing picks again.','PICK_REPAIR_PREVIEW_CHANGED');
        const result=repository.apply({state,plan:preview,actorUserId:actor.actorUserId,authority:actor.authority,clientKey:key,requestHash,nowMs:clock.nowMs()});
        return {leagueId,id:result.id,accepted:true,replayed:false};
      });
    },
  };
}
module.exports = {createLeaguePickRepairService};
