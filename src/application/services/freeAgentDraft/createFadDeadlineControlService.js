const { digest, clientKey } = require("../../../domain/leagues/leagueCommunicationPolicy");
function fail(code = "FAD_DEADLINE_CONTROL_CONFLICT") {
  const error = new Error(code); error.code = code; throw error;
}

function createFadDeadlineControlService({ repository, leagueAuthorization, clock }) {
  function readState(leagueId, fadId) {
    if (!repository) fail("FAD_DEADLINE_CONTROL_UNAVAILABLE");
    if (!/^[a-f0-9-]{36}$/.test(fadId || "")) fail("FAD_DEADLINE_CONTROL_INVALID");
    return repository.state(leagueId, fadId);
  }
  function projection(state, nowMs) {
    const unfinished = state.cards.filter(c => c.completeness !== "complete" || c.eligibility !== "eligible");
    let blockedReason = null;
    if (state.draft.status !== "cards_open") blockedReason = "Cards have already been locked. Use the existing recovery controls for processed results.";
    else if (state.draft.league_status !== "active") blockedReason = "Resume the league before processing cards.";
    else if (nowMs < state.draft.candidate_deadline_at_ms) blockedReason = "Automatic processing is scheduled for the target deadline.";
    else if (state.cards.length !== state.draft.participating_team_count) blockedReason = "The participating team and card records need attention.";
    else if (state.jobs.length !== 1 || state.jobs[0].status !== "pending") blockedReason = "A deadline job is already running or requires recovery.";
    else if (state.nextRolloverAtMs === null || state.nextRolloverAtMs <= nowMs + (state.cutoffGapMs ?? 3_600_000)) blockedReason = "The first auction rollover must leave time for new nominations before the configured cutoff. Update draft timing before proceeding.";
    return { leagueId: state.draft.league_id, fadId: state.draft.id, deadlineAtMs: state.draft.candidate_deadline_at_ms,
      serverNowMs: nowMs, held: state.control?.mode === "held", processingAuthorized: state.control?.mode === "proceed",
      total: state.cards.length, complete: state.cards.length - unfinished.length,
      unfinishedTeams: unfinished.map(c => ({ teamId: c.teamId, teamName: c.teamName, status: c.filled === 0 ? "empty" : "incomplete" })),
      canProceed: blockedReason === null, blockedReason };
  }
  function reason(input) {
    if (!input || Object.keys(input).length !== 1 || typeof input.reason !== "string" ||
        input.reason.trim().length < 3 || input.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(input.reason)) {
      fail("FAD_DEADLINE_CONTROL_INVALID");
    }
    return input.reason.trim();
  }
  function review(leagueId, fadId, authority, text) {
    const state = readState(leagueId, fadId);
    const visible = projection(state, clock.nowMs());
    if (!visible.canProceed) fail("FAD_DEADLINE_CONTROL_CONFLICT");
    return { ...visible, reason: text, previewHash: digest({ leagueId, fadId, actor: authority.actorUserId,
      reason: text, state }) };
  }
  return {
    read({ leagueId, fadId, authenticated }) {
      leagueAuthorization.requireCommissioner(authenticated, leagueId);
      return projection(readState(leagueId, fadId), clock.nowMs());
    },
    preview({ leagueId, fadId, authenticated, input }) {
      const authority = leagueAuthorization.requireCommissioner(authenticated, leagueId);
      return review(leagueId, fadId, authority, reason(input));
    },
    proceed({ leagueId, fadId, authenticated, input, idempotencyKey }) {
      leagueAuthorization.requireCommissioner(authenticated, leagueId);
      if (!repository) fail("FAD_DEADLINE_CONTROL_UNAVAILABLE");
      if (!input || Object.keys(input).sort().join() !== "confirmed,previewHash,reason" ||
          input.confirmed !== true || !/^[a-f0-9]{64}$/.test(input.previewHash || "")) fail("FAD_DEADLINE_CONTROL_INVALID");
      const text = reason({ reason: input.reason });
      let key;
      try { key = clientKey(idempotencyKey); } catch { fail("FAD_DEADLINE_CONTROL_INVALID"); }
      return repository.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(authenticated, leagueId);
        const requestHash = digest({ fadId, reason: text, previewHash: input.previewHash });
        const prior = repository.replay(leagueId, authority.actorUserId, key);
        if (prior) {
          if (prior.request_hash !== requestHash) fail("FAD_DEADLINE_CONTROL_CONFLICT");
          return { leagueId, fadId, id: prior.id, accepted: true, replayed: true };
        }
        const preview = review(leagueId, fadId, authority, text);
        if (preview.previewHash !== input.previewHash) fail("FAD_DEADLINE_CONTROL_PREVIEW_CHANGED");
        const state = readState(leagueId, fadId);
        const receipt = repository.proceed({ leagueId, fadId, seasonId: state.draft.season_id,
          actorUserId: authority.actorUserId, actorAuthority: authority.authority,
          reason: text, clientKey: key, requestHash, nowMs: clock.nowMs() });
        return { leagueId, fadId, id: receipt.id, accepted: true, replayed: false };
      });
    },
  };
}
module.exports = { createFadDeadlineControlService };
