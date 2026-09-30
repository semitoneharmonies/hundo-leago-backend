const DEFAULT_GAP_MS=3_600_000;
function cutoffError(code='FAD_CUTOFF_CONFLICT') { throw Object.assign(new Error(code),{code}); }
function cutoffInput(input) {
  if(!input||Object.keys(input).sort().join()!=='gapMinutes,reason'||!Number.isSafeInteger(input.gapMinutes)||input.gapMinutes<0||input.gapMinutes>10080||
    typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>500||/[\u0000-\u001f\u007f]/.test(input.reason)) cutoffError('FAD_CUTOFF_INVALID');
  return {gapMinutes:input.gapMinutes,reason:input.reason.trim()};
}
function cutoffBlockedReason(state,nowMs) {
  if(!['active','frozen'].includes(state.league.status)||state.league.current_season_id!==state.draft.season_id)return 'The league must be active in this season.';
  if(!['cards_open','rapid'].includes(state.draft.status))return 'Wait until cards are open or rapid auctions are underway. Completed drafts retain their history.';
  if(state.busyJobs.length)return 'A draft job is running or needs recovery. Refresh after it finishes.';
  if(!state.rounds.length||state.rounds.some(r=>r.status==='recovery_required'||r.status==='processing'||(r.status==='scheduled'&&r.rolls_over_at_ms<=nowMs)))return 'An overdue round or recovery needs attention before changing the cutoff.';
  return null;
}
function protectedRound(state,round) { return round.status!=='scheduled'||state.committedRoundIds.includes(round.id); }
function planCutoff(state,input,nowMs) {
  const proposed=cutoffInput(input);
  if(cutoffBlockedReason(state,nowMs))cutoffError();
  const gapMs=proposed.gapMinutes*60_000;
  if(gapMs===(state.settings?.gap_ms??(state.draft.auction_creation_cutoff_minutes??60)*60_000))cutoffError('FAD_CUTOFF_UNCHANGED');
  const before=[],after=[],changes=[];
  const retained=[];
  for(const round of state.rounds) {
    if(protectedRound(state,round)) { retained.push({sequence:round.sequence,cutoffAtMs:round.creation_cutoff_at_ms,
      reason:round.status==='completed'?'Completed round':'Existing auction or queued nomination'});continue; }
    const at=Math.max(round.opens_at_ms,round.rolls_over_at_ms-gapMs);
    if(at===round.creation_cutoff_at_ms)continue;
    before.push(round);after.push({...round,creation_cutoff_at_ms:at,updated_at_ms:Math.max(nowMs,round.updated_at_ms),version:round.version+1});
    const openNow=nowMs>=round.opens_at_ms&&nowMs<round.rolls_over_at_ms;
    changes.push({sequence:round.sequence,opensAtMs:round.opens_at_ms,closesAtMs:round.rolls_over_at_ms,
      beforeCutoffAtMs:round.creation_cutoff_at_ms,afterCutoffAtMs:at,
      reopensNow:openNow&&round.creation_cutoff_at_ms<=nowMs&&at>nowMs,
      closesNow:openNow&&round.creation_cutoff_at_ms>nowMs&&at<=nowMs,
      noNominationWindow:at===round.opens_at_ms});
  }
  return {proposed,gapMs,before,after,changes,retained};
}
module.exports={DEFAULT_GAP_MS,cutoffError,cutoffInput,cutoffBlockedReason,protectedRound,planCutoff};
