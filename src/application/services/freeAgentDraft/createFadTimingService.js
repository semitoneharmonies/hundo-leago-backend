const { digest, clientKey } = require('../../../domain/leagues/leagueCommunicationPolicy');
const { timingError: fail, timingInput, timingBlockedReason, planTimingChange, editableRoundDates } = require('../../../domain/freeAgentDraft/fadTimingChangePolicy');

function createFadTimingService({ repository, leagueAuthorization, clock }) {
  function readState(leagueId, fadId) {
    if (!repository) fail('FAD_TIMING_UNAVAILABLE');
    if (!/^[a-f0-9-]{36}$/.test(fadId || '')) fail('FAD_TIMING_INVALID');
    return repository.state(leagueId, fadId);
  }
  function project(state) {
    const nowMs = clock.nowMs();
    const blockedReason = timingBlockedReason(state, nowMs);
    return { leagueId:state.draft.league_id,fadId:state.draft.id,deadlineAtMs:state.draft.candidate_deadline_at_ms,
      weekOneAtMs:state.draft.first_matchup_starts_at_ms,serverNowMs:clock.nowMs(),held:state.control?.mode==='held',
      rolloverTimesAtMs:state.rollovers.map(r => r.rolls_over_at_ms),canReschedule:blockedReason===null,blockedReason,
      canEditDeadline:state.draft.status==='cards_open',roundDates:editableRoundDates(state,nowMs),
      canEditActiveAuctions:state.draft.status==='rapid' && state.supportsActiveTiming===true,
      reminderAlreadySent:state.jobs.some(j => j.job_type==='fad_deadline_reminder' && j.status==='succeeded') };
  }
  function preview(leagueId, fadId, authority, input) {
    const state = readState(leagueId,fadId);
    const plan = planTimingChange(state,input,clock.nowMs());
    return { ...project(state),proposed:plan.proposed,affectedAuctions:plan.auctionChanges.length,
      previewHash:digest({ state,proposed:plan.proposed,actor:authority.actorUserId }) };
  }
  return {
    read({leagueId,fadId,authenticated}) {
      leagueAuthorization.requireCommissioner(authenticated,leagueId);
      return project(readState(leagueId,fadId));
    },
    preview({leagueId,fadId,authenticated,input}) {
      const authority=leagueAuthorization.requireCommissioner(authenticated,leagueId);
      return preview(leagueId,fadId,authority,input);
    },
    apply({leagueId,fadId,authenticated,input,idempotencyKey}) {
      leagueAuthorization.requireCommissioner(authenticated,leagueId);
      if (!repository) fail('FAD_TIMING_UNAVAILABLE');
      if (!input || Object.keys(input).sort().join()!=='confirmed,deadlineAtMs,previewHash,reason,rolloverTimesAtMs' ||
          input.confirmed!==true || !/^[a-f0-9]{64}$/.test(input.previewHash || '')) fail('FAD_TIMING_INVALID');
      const proposed=timingInput({deadlineAtMs:input.deadlineAtMs,rolloverTimesAtMs:input.rolloverTimesAtMs,reason:input.reason});
      let key;
      try { key=clientKey(idempotencyKey); } catch { fail('FAD_TIMING_INVALID'); }
      return repository.transaction(() => {
        const authority=leagueAuthorization.requireCommissioner(authenticated,leagueId);
        const requestHash=digest({fadId,proposed,previewHash:input.previewHash});
        const prior=repository.replay(leagueId,authority.actorUserId,key);
        if (prior) {
          if (prior.request_hash!==requestHash) fail('FAD_TIMING_CONFLICT');
          return {leagueId,fadId,id:prior.id,accepted:true,replayed:true};
        }
        const state=readState(leagueId,fadId);
        if (digest({state,proposed,actor:authority.actorUserId})!==input.previewHash) fail('FAD_TIMING_PREVIEW_CHANGED');
        const nowMs=clock.nowMs();
        const receipt=repository.apply({state,plan:planTimingChange(state,proposed,nowMs),actorUserId:authority.actorUserId,
          authority:authority.authority,clientKey:key,requestHash,nowMs});
        return {leagueId,fadId,id:receipt.id,accepted:true,replayed:false};
      });
    },
  };
}
module.exports={createFadTimingService};
