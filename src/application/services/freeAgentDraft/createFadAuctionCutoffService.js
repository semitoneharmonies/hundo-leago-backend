const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {DEFAULT_GAP_MS,cutoffError:fail,cutoffInput,cutoffBlockedReason,protectedRound,planCutoff}=require('../../../domain/freeAgentDraft/fadAuctionCutoffPolicy');
function createFadAuctionCutoffService({repository,leagueAuthorization,clock}) {
  function state(leagueId,fadId) {
    if(!repository)fail('FAD_CUTOFF_UNAVAILABLE');
    if(!/^[a-f0-9-]{36}$/.test(fadId||''))fail('FAD_CUTOFF_INVALID');
    return repository.state(leagueId,fadId);
  }
  function project(s,nowMs=clock.nowMs()) {
    const blockedReason=cutoffBlockedReason(s,nowMs);
    return {leagueId:s.draft.league_id,fadId:s.draft.id,gapMinutes:(s.settings?.gap_ms??(s.draft.auction_creation_cutoff_minutes??60)*60_000)/60_000,
      canEdit:blockedReason===null,blockedReason,serverNowMs:nowMs,
      rounds:s.rounds.map(r=>({sequence:r.sequence,opensAtMs:r.opens_at_ms,closesAtMs:r.rolls_over_at_ms,cutoffAtMs:r.creation_cutoff_at_ms,
        protected:protectedRound(s,r)}))};
  }
  function review(s,input,actorUserId,nowMs=clock.nowMs()) {
    const plan=planCutoff(s,input,nowMs);
    const impact={changes:plan.changes,retained:plan.retained};
    return {...project(s,nowMs),proposed:plan.proposed,...impact,previewHash:digest({state:s,proposed:plan.proposed,actorUserId,impact})};
  }
  return {
    read({leagueId,fadId,authenticated}) {leagueAuthorization.requireCommissioner(authenticated,leagueId);return project(state(leagueId,fadId));},
    preview({leagueId,fadId,authenticated,input}) {const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);return review(state(leagueId,fadId),input,actor.actorUserId);},
    apply({leagueId,fadId,authenticated,input,idempotencyKey}) {
      leagueAuthorization.requireCommissioner(authenticated,leagueId);
      if(!repository)fail('FAD_CUTOFF_UNAVAILABLE');
      if(!input||Object.keys(input).sort().join()!=='confirmed,gapMinutes,previewHash,reason'||input.confirmed!==true||!/^[a-f0-9]{64}$/.test(input.previewHash||''))fail('FAD_CUTOFF_INVALID');
      const proposed=cutoffInput({gapMinutes:input.gapMinutes,reason:input.reason});
      let key;try{key=clientKey(idempotencyKey);}catch{fail('FAD_CUTOFF_INVALID');}
      return repository.transaction(()=>{
        const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);
        const requestHash=digest({fadId,proposed,previewHash:input.previewHash}),prior=repository.replay(leagueId,actor.actorUserId,key);
        if(prior){if(prior.request_hash!==requestHash)fail();return{leagueId,fadId,id:prior.id,accepted:true,replayed:true};}
        const s=state(leagueId,fadId),nowMs=clock.nowMs(),preview=review(s,proposed,actor.actorUserId,nowMs);
        if(preview.previewHash!==input.previewHash)fail('FAD_CUTOFF_PREVIEW_CHANGED');
        const receipt=repository.apply({state:s,plan:planCutoff(s,proposed,nowMs),actorUserId:actor.actorUserId,
          authority:actor.authority,clientKey:key,requestHash,nowMs});
        return{leagueId,fadId,id:receipt.id,accepted:true,replayed:false};
      });
    },
  };
}
module.exports={createFadAuctionCutoffService};
