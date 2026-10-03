const { FREE_AGENT_DRAFT_CREATION_CUTOFF_MS: GAP, FREE_AGENT_DRAFT_HELP_WINDOW_MS: HELP,
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS: REMINDER } = require('./freeAgentDraftPolicy');

function timingError(code = 'FAD_TIMING_CONFLICT') {
  throw Object.assign(new Error(code), { code });
}
function timingInput(input) {
  if (!input || Object.keys(input).sort().join() !== 'deadlineAtMs,reason,rolloverTimesAtMs' ||
      typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(input.reason) || !Number.isSafeInteger(input.deadlineAtMs) ||
      !Array.isArray(input.rolloverTimesAtMs) || input.rolloverTimesAtMs.length < 1 || input.rolloverTimesAtMs.length > 1000 ||
      input.rolloverTimesAtMs.some(t => !Number.isSafeInteger(t))) timingError('FAD_TIMING_INVALID');
  return { deadlineAtMs: input.deadlineAtMs, rolloverTimesAtMs: [...input.rolloverTimesAtMs], reason: input.reason.trim() };
}
function auctionCanMove(state, auction) {
  const jobs = (state.auctionJobs || []).filter(j => j.id === auction.job_id);
  return auction.source_kind === 'fad_open_rapid' && auction.fad_origin === 'manager_nomination' &&
    auction.status === 'open' && auction.resolution_count === 0 && auction.recovery_count === 0 &&
    jobs.length === 1 && jobs[0].job_type === 'auction.resolve.target' && jobs[0].status === 'pending' && jobs[0].attempt_count === 0 &&
    jobs[0].lease_owner === null && jobs[0].lease_token === null && jobs[0].last_error_code === null && jobs[0].result_json === null &&
    jobs[0].lease_expires_at_ms === null && jobs[0].scheduled_for_ms === auction.resolves_at_ms &&
    jobs[0].occurrence_key === `auction:${auction.id}:${auction.resolves_at_ms}`;
}
function rapidRoundReason(state, round, nowMs) {
  if (round.status !== 'scheduled') return 'This round has already started processing.';
  if (!state.supportsActiveTiming && round.opens_at_ms <= nowMs) return 'This round has already opened.';
  if ((state.committedRoundIds || []).includes(round.id)) {
    const auctions = (state.auctionClocks || []).filter(a => a.fad_rollover_id === round.id);
    if (!state.supportsActiveTiming || (state.queueRoundIds || []).includes(round.id) ||
      !auctions.length || auctions.some(a => !auctionCanMove(state,a))) {
      return 'This round is linked to a queued nomination, restricted auction or result that cannot be rescheduled here.';
    }
  }
  return null;
}
function editableRoundDates(state, nowMs) {
  return state.rollovers.map((round, i) => {
    let blockedReason = null;
    if (state.draft.status !== 'cards_open') {
      blockedReason = rapidRoundReason(state, round, nowMs);
      const next = state.rollovers[i + 1];
      if (!blockedReason && next && rapidRoundReason(state, next, nowMs)) {
        blockedReason = 'The following round has a protected opening time.';
      }
    }
    return { sequence: round.sequence, canEdit: blockedReason === null, blockedReason };
  });
}
function timingBlockedReason(state, nowMs = 0) {
  const { draft, league, rollovers, jobs, readiness } = state;
  if (!['active','frozen'].includes(league.status) || league.current_season_id !== draft.season_id) return 'The league must be active in this season.';
  if (draft.status === 'rapid' && state.supportsRapidTiming) {
    if (!readiness || readiness.status !== 'succeeded' || readiness.created_fad_id !== draft.id ||
        state.busyJobs.length) return 'Draft processing or recovery needs attention before changing dates.';
    if (!rollovers.length || rollovers.length !== (draft.initial_rollover_times_json ? JSON.parse(draft.initial_rollover_times_json).length : 7) ||
        rollovers.some((r, i) => r.sequence !== i + 1 || r.window_kind !== 'initial' ||
          !['scheduled', 'completed'].includes(r.status) || (r.status === 'scheduled' && r.rolls_over_at_ms <= nowMs))) {
      return 'Finish overdue rounds or review extension and recovery rounds before changing dates.';
    }
    if (jobs.length !== rollovers.length + 2 || jobs.some(j =>
      j.status !== 'succeeded' && (j.status !== 'pending' || j.lease_owner !== null || j.lease_token !== null ||
      j.lease_expires_at_ms !== null || j.last_error_code !== null))) return 'A scheduled job is running or needs recovery.';
    if ([readiness.deadline_job_run_id, readiness.reminder_job_run_id].some(id =>
      jobs.filter(j => j.id === id && j.status === 'succeeded').length !== 1) ||
      rollovers.some(r => jobs.filter(j => j.job_type === 'fad_rollover' &&
        j.status === (r.status === 'completed' ? 'succeeded' : 'pending') &&
        j.occurrence_key === `fad:${draft.id}:rollover:${r.sequence}:${r.rolls_over_at_ms}` &&
        j.scheduled_for_ms === r.rolls_over_at_ms).length !== 1)) return 'The round jobs need attention.';
    if (!editableRoundDates(state, nowMs).some(r => r.canEdit)) return 'All remaining rounds have opened or are linked to accepted auctions or nominations.';
    return null;
  }
  if (draft.status !== 'cards_open') return 'Cards are already locked. This control changes drafts whose cards are still open.';
  if (state.closedCards || state.auctions || state.allocations || state.snapshots) return 'Draft processing has already started. Review recovery controls.';
  if (!readiness || readiness.status !== 'succeeded' || readiness.created_fad_id !== draft.id) return 'The opening records need attention.';
  if (!rollovers.length || rollovers.length !== (draft.initial_rollover_times_json ? JSON.parse(draft.initial_rollover_times_json).length : 7) ||
      rollovers.some((r, i) => r.sequence !== i + 1 || r.window_kind !== 'initial' || r.status !== 'scheduled')) return 'An auction round has started or its schedule needs attention.';
  const deadline = jobs.filter(j => j.id === readiness.deadline_job_run_id && j.job_type === 'fad_deadline');
  const reminder = jobs.filter(j => j.id === readiness.reminder_job_run_id && j.job_type === 'fad_deadline_reminder');
  if (deadline.length !== 1 || reminder.length !== 1 || deadline[0].status !== 'pending' ||
      !['pending', 'succeeded'].includes(reminder[0].status)) return 'A deadline or reminder job is running or needs recovery.';
  if (jobs.length !== rollovers.length + 2 || jobs.some(j => j.status !== 'succeeded' &&
      (j.status !== 'pending' || j.lease_owner !== null || j.lease_token !== null || j.lease_expires_at_ms !== null || j.last_error_code !== null))) return 'A scheduled job is running or needs recovery.';
  if (rollovers.some(r => jobs.filter(j => j.job_type === 'fad_rollover' && j.status === 'pending' &&
      j.occurrence_key === `fad:${draft.id}:rollover:${r.sequence}:${r.rolls_over_at_ms}` && j.scheduled_for_ms === r.rolls_over_at_ms).length !== 1)) return 'The round jobs need attention.';
  return null;
}
function planTimingChange(state, input, nowMs) {
  const proposed = timingInput(input);
  if (timingBlockedReason(state, nowMs)) timingError();
  const { draft, rollovers, jobs } = state;
  const rapid = draft.status === 'rapid';
  if ((rapid ? proposed.deadlineAtMs !== draft.candidate_deadline_at_ms : proposed.deadlineAtMs <= nowMs) ||
      proposed.deadlineAtMs <= draft.opened_at_ms ||
      proposed.deadlineAtMs >= draft.first_matchup_starts_at_ms || proposed.rolloverTimesAtMs.length !== rollovers.length) timingError('FAD_TIMING_INVALID');
  let previous = proposed.deadlineAtMs;
  for (const [i, time] of proposed.rolloverTimesAtMs.entries()) {
    if (time <= previous || time > draft.first_matchup_starts_at_ms || (i === 0 && time <= previous + (state.cutoffGapMs ?? GAP))) timingError('FAD_TIMING_INVALID');
    previous = time;
  }
  if (proposed.deadlineAtMs === draft.candidate_deadline_at_ms && proposed.rolloverTimesAtMs.every((t, i) => t === rollovers[i].rolls_over_at_ms)) timingError('FAD_TIMING_UNCHANGED');
  const afterRoot = { ...draft, candidate_deadline_at_ms: proposed.deadlineAtMs,
    help_opens_at_ms: rapid ? draft.help_opens_at_ms : Math.max(draft.opened_at_ms, proposed.deadlineAtMs - HELP),
    initial_rollover_times_json: JSON.stringify(proposed.rolloverTimesAtMs), updated_at_ms: Math.max(nowMs, draft.updated_at_ms), version: draft.version + 1 };
  const afterRollovers = rollovers.map((r, i) => {
    const opens = i === 0 ? proposed.deadlineAtMs : proposed.rolloverTimesAtMs[i - 1];
    if (rapid && opens === r.opens_at_ms && proposed.rolloverTimesAtMs[i] === r.rolls_over_at_ms) return { ...r };
    if (rapid && (rapidRoundReason(state, r, nowMs) || proposed.rolloverTimesAtMs[i] <= nowMs ||
        (opens !== r.opens_at_ms && (opens <= nowMs || r.opens_at_ms <= nowMs)))) timingError('FAD_TIMING_INVALID');
    return { ...r, opens_at_ms: opens, rolls_over_at_ms: proposed.rolloverTimesAtMs[i],
      creation_cutoff_at_ms: Math.max(opens, proposed.rolloverTimesAtMs[i] - (state.cutoffGapMs ?? GAP)),
      updated_at_ms: Math.max(nowMs, r.updated_at_ms), version: r.version + 1 };
  });
  const afterJobs = jobs.map(j => {
    if (j.status === 'succeeded') return { ...j };
    let at, occurrence;
    if (j.job_type === 'fad_deadline') { at = proposed.deadlineAtMs; occurrence = `fad:${draft.id}:deadline:${at}`; }
    else if (j.job_type === 'fad_deadline_reminder') { at = proposed.deadlineAtMs - REMINDER; occurrence = `fad:${draft.id}:reminder:${at}`; }
    else {
      const i = rollovers.findIndex(r => j.occurrence_key === `fad:${draft.id}:rollover:${r.sequence}:${r.rolls_over_at_ms}`);
      if (i < 0) timingError();
      at = afterRollovers[i].rolls_over_at_ms; occurrence = `fad:${draft.id}:rollover:${i + 1}:${at}`;
    }
    if (rapid && at === j.scheduled_for_ms && occurrence === j.occurrence_key) return { ...j };
    if (at < 0) timingError('FAD_TIMING_INVALID');
    return { ...j, scheduled_for_ms: at, occurrence_key: occurrence, next_attempt_at_ms: null,
      updated_at_ms: Math.max(nowMs, j.updated_at_ms), version: j.version + 1 };
  });
  const auctionChanges = [];
  for (const auction of state.auctionClocks || []) {
    const round = afterRollovers.find(r => r.id === auction.fad_rollover_id);
    if (!round || round.rolls_over_at_ms === auction.resolves_at_ms) continue;
    if (!state.supportsActiveTiming || !auctionCanMove(state,auction)) timingError();
    const job = state.auctionJobs.find(j => j.id === auction.job_id);
    auctionChanges.push({ auction, job, closesAtMs:round.rolls_over_at_ms,cutoffAtMs:round.creation_cutoff_at_ms,
      afterJob:{...job,scheduled_for_ms:round.rolls_over_at_ms,occurrence_key:`auction:${auction.id}:${round.rolls_over_at_ms}`,
        next_attempt_at_ms:null,updated_at_ms:Math.max(nowMs,job.updated_at_ms),version:job.version+1} });
  }
  return { proposed, afterRoot, afterRollovers, afterJobs, auctionChanges };
}
module.exports = { timingError, timingInput, timingBlockedReason, planTimingChange, editableRoundDates, auctionCanMove };
