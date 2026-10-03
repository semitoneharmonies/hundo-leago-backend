function fail(message, code = 'PICK_REPAIR_CONFLICT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const pickKey = pick => pick.teamId + ':' + pick.round;

function input(value) {
  if (!value || Object.keys(value).sort().join() !== 'draftId,owners,reason' || !uuid(value.draftId) ||
      typeof value.reason !== 'string' || value.reason.trim().length < 3 || value.reason.trim().length > 500 ||
      /[\u0000-\u001f\u007f]/u.test(value.reason) || !Array.isArray(value.owners) || value.owners.length > 256 ||
      value.owners.some(p => !p || Object.keys(p).sort().join() !== 'ownerTeamId,round,teamId' ||
        !uuid(p.teamId) || !uuid(p.ownerTeamId) || !Number.isInteger(p.round) || p.round < 1 || p.round > 4)) {
    fail('Choose a draft, the owner of every missing pick, and a reason.', 'PICK_REPAIR_INVALID');
  }
  if (new Set(value.owners.map(pickKey)).size !== value.owners.length) fail('Review each missing pick once.', 'PICK_REPAIR_INVALID');
  return {draftId: value.draftId, owners: value.owners.map(p => ({teamId:p.teamId, round:p.round, ownerTeamId:p.ownerTeamId}))
    .sort((a,b) => a.round - b.round || a.teamId.localeCompare(b.teamId)), reason:value.reason.trim()};
}

function missingPickPlan(state) {
  const {league, draft, season, teams, picks, lottery} = state;
  if (!['setup','active','frozen'].includes(league.status) || !draft || !season ||
      !['planned','active'].includes(season.status) || !['setup','lottery_ready','ready'].includes(draft.status)) {
    fail('Repair picks before this entry draft starts. Started or completed drafts require draft recovery.');
  }
  if (!picks.length && !lottery.length) fail('Record the draft lottery order before generating missing picks.');
  const expected = lottery.length ? lottery.map(r => r.original_team_id) :
    [...new Set([...teams.filter(t => ['setup','active'].includes(t.status)).map(t => t.id), ...picks.map(p => p.original_team_id)])];
  const positions = new Map(), usedPositions = new Map();
  function record(teamId, position) {
    if (!expected.includes(teamId) || !Number.isInteger(position) || position < 1 || position > expected.length ||
        (positions.has(teamId) && positions.get(teamId) !== position) ||
        (usedPositions.has(position) && usedPositions.get(position) !== teamId)) {
      fail('Existing picks and the draft order disagree. Resolve the order before adding records.');
    }
    positions.set(teamId,position); usedPositions.set(position,teamId);
  }
  for (const row of lottery) record(row.original_team_id,row.final_draft_position);
  const existingKeys = new Set();
  for (const p of picks) {
    record(p.original_team_id,p.position_number);
    const key = p.original_team_id + ':' + p.round_number;
    if (existingKeys.has(key) || p.target_season_id !== draft.season_id) fail('Existing pick records are inconsistent. Review the draft first.');
    existingKeys.add(key);
  }
  // Only a single missing position is mathematically determined without lottery evidence.
  const unknown = expected.filter(id => !positions.has(id));
  if (unknown.length === 1) record(unknown[0], Array.from({length:expected.length},(_,i)=>i+1).find(p=>!usedPositions.has(p)));
  if (expected.some(id=>!positions.has(id))) fail('The order for missing teams is unknown. Record the draft lottery order first.');
  const missing = [];
  for (let round = 1; round <= draft.rounds; round++) for (const teamId of expected) {
    if (existingKeys.has(teamId + ':' + round)) continue;
    const team = teams.find(t => t.id === teamId);
    if (!team) fail('A draft team is unavailable. Resolve team membership first.');
    const lotteryOwner = round === 1 ? lottery.find(r=>r.original_team_id===teamId)?.current_pick_owner_team_id : null;
    missing.push({teamId,teamName:team.name,round,position:positions.get(teamId),ownerTeamId:lotteryOwner||teamId});
  }
  return missing.sort((a,b)=>a.round-b.round||a.position-b.position);
}

function plan(state, value) {
  const proposed = input(value), missing = missingPickPlan(state);
  if (state.draft.id !== proposed.draftId) fail('The selected draft changed.');
  if (!missing.length) fail('This draft has no missing picks.');
  if (proposed.owners.length !== missing.length || proposed.owners.some(p=>!missing.some(m=>pickKey(m)===pickKey(p)))) {
    fail('The missing-pick list changed. Review the current list again.');
  }
  const additions = missing.map(p => {
    const choice = proposed.owners.find(o=>pickKey(o)===pickKey(p));
    const owner = state.teams.find(t=>t.id===choice.ownerTeamId && ['setup','active'].includes(t.status));
    if (!owner) fail('Choose a current team in this league for every new pick.');
    return {...p,ownerTeamId:owner.id,ownerName:owner.name};
  });
  return {proposed,additions,preservedCount:state.picks.length};
}
module.exports = {fail,input,missingPickPlan,plan};
