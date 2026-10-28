const { createHash, randomUUID } = require('node:crypto');
const { canUseInjuredReserve } = require('../../../domain/players/injuryStatusPolicy');
const { solveRosterRepair } = require('../../../domain/rosters/rosterRepairPolicy');
const { evaluateTeamRosterLegality } = require('./createTeamWorkspaceService');

const CATEGORIES = ['Active', 'Bench', 'Injured Reserve'];
const NHL_TEAMS = new Set('ANA ARI BOS BUF CAR CBJ CGY CHI COL DAL DET EDM FLA LAK MIN MTL NJD NSH NYI NYR OTT PHI PIT SEA SJS STL TBL TOR UTA VAN VGK WPG WSH'.split(' '));
const normalizeTeam = value => ({ LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL', MON: 'MTL' }[value] || value);
const MANUAL_REPAIR_GUIDANCE = [
  'Use the move controls on each roster row to review Active, Bench, and IR placements. Active allows up to 12 forwards and 6 defensemen within the salary cap.',
  'Bench allows up to 4 players, each with an underlying AAV of $4 or less. IR allows up to 4 eligible injured players; healthy players must leave IR.',
  'If category moves cannot satisfy those limits, review a trade or another contract decision with your commissioner. This tool does not trade, buy out, or change contracts.',
];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('ROSTER_REPAIR_INVALID');
}
function legality(workspace) {
  const result = evaluateTeamRosterLegality(workspace);
  const extra = workspace.players.filter(row => row.roster_category === 'Bench' && row.aav_cents > 400)
    .map(row => ({ code: 'BENCH_AAV_LIMIT_EXCEEDED', playerId: row.player_id }));
  return { ...result, legal: result.legal && extra.length === 0, reasons: [...result.reasons, ...extra] };
}
function selectWeek(evidence, nowMs) {
  const current = evidence.weeks.find(week => week.starts_at_ms <= nowMs && nowMs < week.ends_at_ms);
  if (current && evidence.locks.some(lock => lock.matchup_week_id === current.id && lock.legal === 1)) {
    const next = evidence.weeks.find(week => week.starts_at_ms >= current.ends_at_ms);
    return { week: next || null, timing: next ? 'future_week' : 'no_week', currentLocked: true };
  }
  const week = current || evidence.weeks.find(row => row.starts_at_ms > nowMs) || null;
  return { week, timing: !week ? 'no_week' : nowMs < week.locks_at_ms ? 'before_lock' : 'late_lock', currentLocked: false };
}
function createRosterRepairService({ repository, workspaceRepository, rosterMovementRepository, teamAuthorization,
  leagueAuthorization, scheduleAdapter, lateLockCoordinator, clock, secureRandom = { id: randomUUID }, assertCompetitionOpen = () => {} }) {
  function authority(input) {
    try { return teamAuthorization.requireManager(input.authenticated, input.leagueId, input.teamId); }
    catch (error) {
      if (error?.code !== 'TEAM_MANAGER_REQUIRED') throw error;
      return leagueAuthorization.requireCommissioner(input.authenticated, input.leagueId);
    }
  }
  function read(input) {
    const actor = authority(input);
    assertCompetitionOpen(input.leagueId);
    if (!repository) fail('ROSTER_REPAIR_UNAVAILABLE');
    const workspace = workspaceRepository.read(input);
    if (!workspace) fail('TEAM_NOT_FOUND');
    if (!workspace.scope.season_id) fail('ROSTER_REPAIR_UNAVAILABLE');
    const nowMs = clock.nowMs();
    const evidence = repository.readEvidence({ leagueId: input.leagueId, teamId: input.teamId, seasonId: workspace.scope.season_id, nowMs });
    return { actor, workspace, evidence, nowMs, target: selectWeek(evidence, nowMs) };
  }
  async function scheduleFor(state) {
    if (!state.target.week || legality(state.workspace).legal) return null;
    try {
      const week = state.target.week;
      return await scheduleAdapter.readSchedule({ startsAtMs: week.starts_at_ms, endsAtMs: week.ends_at_ms, nhlSeasonKey: state.workspace.scope.nhl_season_key });
    } catch { return null; }
  }
  function build(state, schedule) {
    const { workspace, evidence, target, nowMs } = state;
    const normal = workspace.players.filter(row => CATEGORIES.includes(row.roster_category));
    const hasTeams = normal.every(row => NHL_TEAMS.has(normalizeTeam(row.nhl_team_abbreviation)));
    const scheduleAvailable = Boolean(target.week && schedule && Array.isArray(schedule.games) && !schedule.games.some(game => game.timeTbd) && hasTeams);
    const cutoff = target.timing === 'late_lock' ? nowMs : target.week?.starts_at_ms;
    const games = scheduleAvailable ? schedule.games.filter(game =>
      (target.timing === 'late_lock' ? game.status === 'scheduled' : ['scheduled', 'live', 'final'].includes(game.status)) &&
      game.startsAtMs >= cutoff && game.startsAtMs < target.week.ends_at_ms) : [];
    const gamesByPlayer = new Map(normal.map(row => [row.player_id, scheduleAvailable
      ? games.filter(game => [normalizeTeam(game.homeTeam), normalizeTeam(game.awayTeam)].includes(normalizeTeam(row.nhl_team_abbreviation))).length : null]));
    const scheduledTotal = (players) => scheduleAvailable ? players.filter(row => row.roster_category === 'Active' && row.injury?.status !== 'injured').reduce((sum, row) => sum + gamesByPlayer.get(row.player_id), 0) : null;
    const before = { capUsageCents: workspace.cap.capUsageCents, capLimitCents: workspace.cap.capLimitCents, scheduledGames: scheduledTotal(normal) };
    const week = target.week && { id: target.week.id, label: target.week.week_key, startsAtMs: target.week.starts_at_ms, endsAtMs: target.week.ends_at_ms, locksAtMs: target.week.locks_at_ms };
    const base = { code: 'ROSTER_REPAIR_PREVIEW', leagueId: workspace.scope.league_id, teamId: workspace.scope.team_id,
      seasonId: workspace.scope.season_id, revision: null, canApply: false, status: 'no_solution',
      strategy: scheduleAvailable ? 'scheduled_games' : 'legality_only', week, timing: target.timing,
      message: '', moves: [], before, after: { ...before }, blockers: [] };
    if (legality(workspace).legal) return { preview: { ...base, status: 'already_legal', message: 'Your roster is already legal.' } };
    if (!workspace.cap.complete || normal.some(row => row.ownership_kind !== 'Rostered' || !row.contract_id || !['F', 'D'].includes(row.position_group) || !Number.isSafeInteger(row.aav_cents) || !Number.isSafeInteger(row.retained_aav_cents))) {
      return { preview: { ...base, status: 'unavailable', message: 'Roster information needs attention before a repair can be suggested.', blockers: ['A complete cap calculation, contract, and position are required for every rostered player.'] } };
    }
    const solution = solveRosterRepair({ players: normal.map(row => ({ playerId: row.player_id, rosterCategory: row.roster_category,
      positionGroup: row.position_group, aavCents: row.aav_cents, retainedAavCents: row.retained_aav_cents,
      irEligible: canUseInjuredReserve(row), injuryStatus: row.injury?.status || 'unknown', scheduledGames: gamesByPlayer.get(row.player_id) })),
    capLimitCents: workspace.cap.capLimitCents, fixedObligationsCents: workspace.cap.breakdown.retentionCents + workspace.cap.breakdown.buyoutCents, scheduleAvailable });
    if (solution.status !== 'plan') {
      if (solution.reasonCodes.includes('ROSTER_REPAIR_SEARCH_LIMIT')) return { preview: { ...base, status: 'unavailable', message: 'A safe complete repair plan could not be calculated.', blockers: ['The search limit was reached. No partial plan will be applied.'] } };
      return { preview: { ...base, message: 'This roster cannot be made legal using category moves alone.', blockers: MANUAL_REPAIR_GUIDANCE } };
    }
    const assignments = new Map(solution.assignments.map(row => [row.playerId, row.rosterCategory]));
    const projected = { ...workspace, players: workspace.players.map(row => ({ ...row, roster_category: assignments.get(row.player_id) || row.roster_category })),
      cap: { ...workspace.cap, capUsageCents: solution.metrics.capUsageCents } };
    if (!legality(projected).legal) return { preview: { ...base, message: 'Some roster issues need a separate correction.', blockers: ['The full proposed roster still has a contract, position, cap, or category issue.', ...MANUAL_REPAIR_GUIDANCE] } };
    const moves = normal.filter(row => assignments.get(row.player_id) !== row.roster_category).map(row => ({ ownershipId: row.ownership_id, playerId: row.player_id,
      name: row.full_name, from: row.roster_category, to: assignments.get(row.player_id), scheduledGames: gamesByPlayer.get(row.player_id) }));
    if (!moves.length) return { preview: { ...base, message: 'No category moves can correct the remaining roster issue.', blockers: MANUAL_REPAIR_GUIDANCE } };
    const material = { scope: workspace.scope, ownerships: evidence.ownerships, injuries: evidence.injuries,
      contracts: evidence.contracts, contractYears: evidence.contractYears, cap: workspace.cap, retentions: workspace.retentions, buyouts: workspace.buyouts,
      players: workspace.players.map(row => ({ id: row.player_id, position: row.position_group, team: row.nhl_team_abbreviation, source: row.source_payload_json })),
      weeks: evidence.weeks, locks: evidence.locks, target, schedule: scheduleAvailable ? schedule : null, eligibleGames: games.map(row => row.id), assignments: solution.assignments };
    let message = scheduleAvailable ? 'Suggested legal roster with the most scheduled games among the available placements.' : 'Suggested legal roster with as few moves as possible. Schedule information is unavailable.';
    if (target.currentLocked) message += ' Your current matchup lineup is already locked and will not change.';
    if (target.timing === 'late_lock') message += ' Current-week scoring depends on a successful late lock; games already underway cannot be recovered.';
    if (!target.week) message += ' No upcoming saved matchup week is available.';
    return { assignments, preview: { ...base, status: 'ready', canApply: true, revision: digest(material), moves, message,
      after: { ...before, capUsageCents: solution.metrics.capUsageCents, scheduledGames: scheduledTotal(projected.players.filter(row => CATEGORIES.includes(row.roster_category))) } } };
  }
  async function preview(input) {
    exact(input.input, []);
    const state = read(input);
    const schedule = await scheduleFor(state);
    // Re-read after the asynchronous provider wait; preview itself never writes.
    const current = read(input);
    if (digest(current.target.week) !== digest(state.target.week) || current.workspace.scope.nhl_season_key !== state.workspace.scope.nhl_season_key) fail('ROSTER_REPAIR_STALE');
    return build(current, schedule).preview;
  }
  async function apply(input) {
    exact(input.input, ['expectedRevision', 'confirmed']);
    if (input.input.confirmed !== true || !/^[a-f0-9]{64}$/.test(input.input.expectedRevision || '')) fail('ROSTER_REPAIR_INVALID');
    const initial = read(input);
    const schedule = await scheduleFor(initial);
    const committed = repository.commit(() => {
      const state = read(input);
      if (digest(state.target.week) !== digest(initial.target.week) || state.workspace.scope.nhl_season_key !== initial.workspace.scope.nhl_season_key) fail('ROSTER_REPAIR_STALE');
      const plan = build(state, schedule);
      if (plan.preview.revision !== input.input.expectedRevision) fail('ROSTER_REPAIR_STALE');
      if (!plan.preview.canApply) fail('ROSTER_REPAIR_NOT_AVAILABLE');
      const touched = new Set();
      const move = (playerId, destinationCategory) => {
        const current = workspaceRepository.read(input);
        const player = current.players.find(row => row.player_id === playerId);
        if (!player || player.ownership_kind !== 'Rostered' || !CATEGORIES.includes(player.roster_category)) fail('ROSTER_REPAIR_STALE');
        if (destinationCategory === 'Bench' && player.aav_cents > 400) fail('ROSTER_REPAIR_STALE');
        if (destinationCategory === 'Injured Reserve' && !canUseInjuredReserve(player)) fail('ROSTER_REPAIR_STALE');
        const occupied = new Set(current.players.filter(row => row.roster_category === destinationCategory && (destinationCategory !== 'Active' || row.position_group === player.position_group)).map(row => row.slot_number));
        const maximum = destinationCategory === 'Active' ? player.position_group === 'F' ? 12 : 6 : 4;
        const slot = Array.from({ length: maximum }, (_, index) => index + 1).find(value => !occupied.has(value)) || null;
        const result = rosterMovementRepository.move({ leagueId: input.leagueId, seasonId: state.workspace.scope.season_id, teamId: input.teamId, playerId,
          expectedVersion: player.ownership_version, expectedSourceCategory: player.roster_category, destinationCategory,
          destinationPositionGroup: player.position_group, destinationSlotNumber: slot, actorUserId: state.actor.actorUserId,
          actorAuthority: state.actor.authority === 'manager' ? 'manager' : 'commissioner', ownershipEventId: secureRandom.id(), activityId: secureRandom.id(),
          reason: 'Confirmed roster repair.', occurredAtMs: clock.nowMs() });
        for (const row of result.affectedOwnerships) touched.add(row.id);
      };
      // Vacate Bench/IR first, through Active, inside the same transaction. Any
      // temporary overflow is invisible outside the transaction and never locks.
      for (const row of plan.preview.moves) if (row.from !== 'Active') move(row.playerId, 'Active');
      for (const row of plan.preview.moves) if (row.to !== 'Active') move(row.playerId, row.to);
      const final = workspaceRepository.read(input);
      const finalLegality = legality(final);
      if (!finalLegality.legal || final.players.some(row => plan.assignments.has(row.player_id) && plan.assignments.get(row.player_id) !== row.roster_category)) fail('ROSTER_REPAIR_STALE');
      return { preview: plan.preview, legality: finalLegality, witnesses: final.players.filter(row => touched.has(row.ownership_id)).map(row => ({ ownershipId: row.ownership_id, state: 'present', ownershipVersion: row.ownership_version })).sort((a, b) => a.ownershipId.localeCompare(b.ownershipId)) };
    });
    let lateLock = { status: 'awaiting_data' };
    try {
      const result = await lateLockCoordinator.coordinateCommittedRoster({ mutationKind: 'roster_move', teams: [{ leagueId: input.leagueId, seasonId: committed.preview.seasonId, teamId: input.teamId, ownershipWitnesses: committed.witnesses }] });
      if (['not_applicable', 'awaiting_data', 'still_illegal', 'completed'].includes(result?.status)) lateLock = { status: result.status, ...(result.lockId ? { lockId: result.lockId } : {}) };
    } catch { /* A delayed post-commit lock does not undo the saved roster. */ }
    return { code: 'ROSTER_REPAIR_APPLIED', leagueId: input.leagueId, teamId: input.teamId, seasonId: committed.preview.seasonId, moved: committed.preview.moves.length, legality: committed.legality, lateLock };
  }
  return Object.freeze({ preview, apply });
}

module.exports = { createRosterRepairService };
