'use strict';

// Exceptional, operator-only recovery. Never registered with HTTP or startup.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { planExplicitMatchupSchedule } = require('../domain/matchups/matchupSchedulePolicy');
const { createSqliteCommissionerCorrectionRepository } = require('../infrastructure/persistence/sqlite/SqliteCommissionerCorrectionRepository');
const { createSqliteCandidateCardSummerSynchronizer } = require('../infrastructure/persistence/sqlite/SqliteCandidateCardSummerSynchronizer');
const { installWriteFence } = require('./teamRemovalWriteFence');
const { assertApprovedExecution } = require('./teamRemovalExecutionAuthorization');

const SCOPE = Object.freeze({
  leagueId: 'bbfb5b17-0080-465f-a2cd-ac3d2c946e83',
  seasonId: 'f9ec4b60-ea9b-42b8-b057-f6246567890f',
  teamIds: ['350af81d-ce93-4d9d-b6e1-cb83aa1c0b83', 'bc5fd23f-3d06-43c2-9be1-0350a31cce8e'],
  managerAssignments: [
    {id:'e9eea77c-c410-467c-8ab0-9c0fbe4be41e',teamId:'350af81d-ce93-4d9d-b6e1-cb83aa1c0b83',userId:'2b1a76ae-aab5-4bc6-8e35-e50aea41e292',membershipId:'113c226c-443b-4763-9cd1-bec6d067559f'},
    {id:'d0baf37c-5941-4bbb-9c45-8fdcd98402a0',teamId:'bc5fd23f-3d06-43c2-9be1-0350a31cce8e',userId:'cf37a632-c4f9-41ff-850a-30e2f7abcf49',membershipId:'dd6f3300-f146-4a17-95ad-4a392221d501'},
  ],
  playerIds: ['20d57715-be14-562a-bb3e-cf9a10a3b12f', 'a9df6680-1879-5407-bc1a-6242f6a94eec', 'afc0a49b-d853-55b2-a606-2435bb48553c'],
  schema: 63,
  firstWeekStartsAtMs: Date.parse('2026-09-29T07:00:00Z'),
  operationId: 'd87105a6-77ba-48ad-9fab-dc3179126635',
});
const EVENT = 'league.two_team_removal.v1';
const REASON = 'Exceptional removal of PortaJohn Peeper and The Pizzacats before competition, preserving other teams and auction work.';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => { const h = hash(value); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
function fail(code, details) { const e = new Error(code); e.code = code; e.details = details; throw e; }
function requireThat(value, code, details) { if (!value) fail(code, details); }
function rows(db, sql, ...params) { return db.prepare(sql).all(...params); }
function schemaHash(db) { return hash(rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")); }
function inTeams(column) { return `${column} IN (?,?)`; }
function targetRows(db, table, column = 'team_id') { return rows(db, `SELECT * FROM ${table} WHERE league_id=? AND ${inTeams(column)} ORDER BY id`, SCOPE.leagueId, ...SCOPE.teamIds); }
function seasonRows(db, table, order = 'id') { return rows(db, `SELECT * FROM ${table} WHERE league_id=? AND season_id=? ORDER BY ${order}`, SCOPE.leagueId, SCOPE.seasonId); }

function inspect(db, nowMs) {
  requireThat(Number.isSafeInteger(nowMs), 'TIME_INVALID');
  requireThat(db.pragma('user_version', {simple:true}) === SCOPE.schema, 'SCHEMA_CHANGED');
  const league = db.prepare('SELECT * FROM leagues WHERE id=?').get(SCOPE.leagueId);
  requireThat(league?.current_season_id === SCOPE.seasonId && league.status === 'active', 'LEAGUE_CHANGED');
  const season = db.prepare('SELECT * FROM seasons WHERE id=? AND league_id=?').get(SCOPE.seasonId,SCOPE.leagueId);
  const actor = db.prepare("SELECT m.*,u.status user_status FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.league_id=?").get(league.commissioner_membership_id,SCOPE.leagueId);
  requireThat(actor?.status === 'active' && actor.user_status === 'active', 'COMMISSIONER_CHANGED');
  const teams = rows(db, "SELECT * FROM teams WHERE league_id=? AND status <> 'erased' ORDER BY id", SCOPE.leagueId);
  requireThat(teams.length === 14 && teams.every(t=>t.status==='active') && SCOPE.teamIds.every(t=>teams.some(x=>x.id===t)), 'TEAM_SET_CHANGED');
  const assignments = targetRows(db,'team_manager_assignments');
  requireThat(!assignments.some(a=>a.status==='pending'), 'ASSIGNMENTS_CHANGED');
  for(const expected of SCOPE.managerAssignments) {
    const original=assignments.find(a=>a.id===expected.id);
    const active=assignments.filter(a=>a.team_id===expected.teamId && a.status==='accepted' && a.ended_at_ms===null);
    requireThat(original?.team_id===expected.teamId && original.user_id===expected.userId && original.membership_id===expected.membershipId,'ASSIGNMENTS_CHANGED');
    const stillAssigned=original.status==='accepted' && original.ended_at_ms===null && active.length===1 && active[0].id===original.id;
    const alreadyUnassigned=original.status==='ended' && Number.isSafeInteger(original.ended_at_ms) && original.ended_at_ms>=original.accepted_at_ms && original.ended_at_ms<=nowMs && active.length===0;
    requireThat(stillAssigned || alreadyUnassigned,'ASSIGNMENTS_CHANGED');
  }
  requireThat(!assignments.some(a=>a.user_id===actor.user_id && a.ended_at_ms===null), 'CANNOT_REMOVE_COMMISSIONER_TEAM');
  const ownerships=targetRows(db,'player_ownerships');
  requireThat(hash(ownerships.map(o=>o.player_id).sort())===hash([...SCOPE.playerIds].sort()) && ownerships.every(o=>o.team_id===SCOPE.teamIds[0] && o.season_id===SCOPE.seasonId && o.ownership_kind==='Rostered'), 'ROSTER_CHANGED');
  const contracts=targetRows(db,'contracts','current_team_id').filter(c=>c.status==='active');
  requireThat(contracts.length===3 && ownerships.every(o=>contracts.some(c=>c.player_id===o.player_id)), 'CONTRACTS_CHANGED');
  const years=contracts.flatMap(c=>rows(db,'SELECT * FROM contract_years WHERE league_id=? AND contract_id=? ORDER BY id',SCOPE.leagueId,c.id));
  const display=ownerships.flatMap(o=>rows(db,'SELECT * FROM roster_display_order_entries WHERE league_id=? AND ownership_id=? ORDER BY id',SCOPE.leagueId,o.id));
  const picks=targetRows(db,'draft_picks','original_team_id');
  const ownedPicks=targetRows(db,'draft_picks','current_owner_team_id');
  requireThat(picks.length===32 && hash(picks)===hash(ownedPicks) && picks.every(p=>p.original_team_id===p.current_owner_team_id && p.status==='unused' && p.selection_id===null), 'DRAFT_ASSETS_CHANGED');
  const protectedDependencies = ['auction_bids','trade_assets','retention_obligations','buyout_obligations','future_considerations','trades','free_agent_draft_nomination_queue','free_agent_draft_auction_participants','draft_selections','draft_queue_items'];
  for (const table of protectedDependencies) {
    const columns=rows(db,`PRAGMA table_info(${table})`).map(c=>c.name).filter(c=>c==='team_id'||c.endsWith('_team_id'));
    if (!columns.length) continue;
    const found=rows(db,`SELECT id FROM ${table} WHERE league_id=? AND (${columns.map(inTeams).join(' OR ')})`,SCOPE.leagueId,...columns.flatMap(()=>SCOPE.teamIds));
    requireThat(found.length===0,'TEAM_DEPENDENCY',{table,ids:found.map(r=>r.id)});
  }
  requireThat(targetRows(db,'league_invitations').every(r=>r.status!=='pending'), 'PENDING_TEAM_INVITATION');
  const weeks=seasonRows(db,'matchup_weeks','sequence');
  requireThat(weeks[0]?.starts_at_ms===SCOPE.firstWeekStartsAtMs && weeks[0].baseline_at_ms===SCOPE.firstWeekStartsAtMs+3600000,'WEEK_ONE_BOUNDARY_CHANGED');
  requireThat(weeks.length===22 && weeks.every(w=>w.status==='scheduled' && w.starts_at_ms>nowMs), 'COMPETITION_STARTED');
  for(const table of ['matchup_roster_locks','matchup_results','matchup_result_versions','standings_snapshots']) requireThat(seasonRows(db,table).length===0,'COMPETITION_EVIDENCE_EXISTS',{table});
  const matches=seasonRows(db,'matchups');
  requireThat(matches.length===154 && matches.every(m=>m.status==='scheduled'), 'MATCHUPS_CHANGED');
  requireThat(seasonRows(db,'matchup_byes').length===0,'UNEXPECTED_BYES');
  const draft=seasonRows(db,'free_agent_drafts')[0];
  requireThat(draft?.status==='rapid' && draft.participating_team_count===14,'DRAFT_PHASE_CHANGED');
  const running=rows(db,"SELECT id,job_type FROM job_runs WHERE league_id=? AND status IN ('leased','running')",SCOPE.leagueId);
  requireThat(running.length===0,'JOBS_IN_FLIGHT',running);
  requireThat(rows(db,"SELECT id FROM free_agent_draft_rollovers WHERE league_id=? AND season_id=? AND rolls_over_at_ms<=? AND status<>'completed'",SCOPE.leagueId,SCOPE.seasonId,nowMs).length===0,'PRIOR_ROLLOVER_UNFINISHED');
  requireThat(rows(db,"SELECT id FROM free_agent_draft_recoveries WHERE league_id=? AND season_id=? AND status<>'resolved'",SCOPE.leagueId,SCOPE.seasonId).length===0,'DRAFT_RECOVERY_UNRESOLVED');
  requireThat(rows(db,"SELECT id FROM outbox_events WHERE league_id=? AND status='publishing'",SCOPE.leagueId).length===0,'PUBLICATION_IN_FLIGHT');
  const relevantJobs=seasonRows(db,'job_runs').filter(j=>j.job_type.startsWith('matchup:') || j.job_type==='fad_rollover');
  requireThat(relevantJobs.filter(j=>j.job_type.startsWith('matchup:')).every(j=>j.status==='pending' && j.attempt_count===0), 'MATCHUP_JOB_STARTED');
  const deadlines=rows(db,"SELECT resolves_at_ms at FROM auctions WHERE league_id=? AND status IN ('open','resolving') UNION ALL SELECT rolls_over_at_ms at FROM free_agent_draft_rollovers WHERE league_id=? AND status<>'completed'",SCOPE.leagueId,SCOPE.leagueId).map(r=>r.at);
  requireThat(deadlines.length>0 && Math.min(...deadlines)>nowMs+2*3600000,'DEADLINE_TOO_CLOSE');
  const survivors=teams.filter(t=>!SCOPE.teamIds.includes(t.id));
  const plan=planExplicitMatchupSchedule({teamIds:survivors.map(t=>t.id),nhlSeasonKey:season.nhl_season_key,timeZone:league.timezone,nhlRegularSeasonStartsAtMs:season.regular_season_starts_at_ms,nhlRegularSeasonEndsAtMs:season.regular_season_ends_at_ms,fantasyPlayoffsStartAtMs:season.fantasy_playoffs_start_at_ms,fantasyPlayoffsEndAtMs:season.fantasy_playoffs_end_at_ms,firstWeekStartsAtMs:weeks[0].starts_at_ms,nowMs});
  requireThat(plan.weeks.length===weeks.length && plan.weeks.every((w,i)=>['starts_at_ms','ends_at_ms'].every((k,j)=>weeks[i][k]===w[j?'endsAtMs':'startsAtMs'])),'CALENDAR_DIFFERS');
  const newMatches=plan.weeks.flatMap((w,i)=>w.pairs.map(p=>({id:id([SCOPE.operationId,weeks[i].id,p.homeTeamId,p.awayTeamId]),league_id:SCOPE.leagueId,season_id:SCOPE.seasonId,matchup_week_id:weeks[i].id,home_team_id:p.homeTeamId,away_team_id:p.awayTeamId,home_team_name:survivors.find(t=>t.id===p.homeTeamId).name,away_team_name:survivors.find(t=>t.id===p.awayTeamId).name,status:'scheduled',created_at_ms:nowMs,updated_at_ms:nowMs,version:1})));
  const snapshot={league,season,actor,teams,assignments,ownerships,contracts,years,display,picks,weeks,matches,draft,relevantJobs,generations:seasonRows(db,'season_matchup_schedule_generations','schedule_version'),bindings:seasonRows(db,'matchup_schedule_job_bindings')};
  // Other teams may bid between preview and apply: their bids are deliberately
  // excluded from the precondition hash and are never rewritten by this code.
  return {snapshot,newMatches,schemaHash:schemaHash(db),preconditionHash:hash(snapshot),nextDeadlineMs:Math.min(...deadlines)};
}

function inspectedPreview(db,x,nowMs) {
  return {format:'team-removal-preview-v2',operationId:SCOPE.operationId,scope:SCOPE,createdAtMs:nowMs,expiresAtMs:nowMs+15*60000,schemaHash:x.schemaHash,preconditionHash:x.preconditionHash,
    targets:x.snapshot.teams.filter(t=>SCOPE.teamIds.includes(t.id)).map(t=>({id:t.id,name:t.name})),
    managerAssignments:x.snapshot.assignments.filter(a=>SCOPE.managerAssignments.some(expected=>expected.id===a.id)).map(a=>({assignmentId:a.id,teamId:a.team_id,status:a.status,endedAtMs:a.ended_at_ms,version:a.version})),
    players:x.snapshot.ownerships.map(o=>({id:o.player_id,name:db.prepare('SELECT full_name FROM players WHERE id=?').get(o.player_id).full_name})),
    retireUnusedPicks:x.snapshot.picks.length,preserveWeekIds:x.snapshot.weeks.map(w=>w.id),nextDeadlineMs:x.nextDeadlineMs,
    weekOneHandoff:{startsAtMs:x.snapshot.weeks[0].starts_at_ms,completeBeforeMs:x.snapshot.weeks[0].baseline_at_ms,requiresAllDraftWorkTerminal:true,requiresCompetitionUnstarted:true},
    matchups:x.newMatches.map(m=>({...m,created_at_ms:nowMs,updated_at_ms:nowMs}))};
}
function preview(db,{nowMs=Date.now()}={}) {
  return db.transaction(()=>inspectedPreview(db,inspect(db,nowMs),nowMs)).deferred();
}
function insertRow(db,table,row) { const keys=Object.keys(row);return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k=>'@'+k).join(',')})`).run(row); }
function receipt(db) { const r=db.prepare('SELECT * FROM operational_events WHERE id=? AND league_id=? AND event_type=?').get(SCOPE.operationId,SCOPE.leagueId,EVENT);return r?JSON.parse(r.details_json):null; }
function phase(hook,name) { if(hook) hook(name); }
function writeScope(before,newMatches,{restore=false}={}) {
  const corrected=resource=>before.ownerships.map(o=>id([`${SCOPE.operationId}:${o.player_id}`,resource]));
  const originals=items=>items.map(r=>r.id);
  const updates={
    teams:{ids:SCOPE.teamIds,fields:['status','updated_at_ms','version']},
    team_manager_assignments:{ids:originals(before.assignments.filter(a=>a.status==='accepted'&&a.ended_at_ms===null)),fields:['status','ended_at_ms','version']},
    contracts:{ids:originals(before.contracts),fields:['status','updated_at_ms','version']},
    contract_years:{ids:originals(before.years),fields:['status','rollover_at_ms']},
    draft_picks:{ids:originals(before.picks),fields:['status','updated_at_ms','version']},
    ...(!restore?{idempotency_requests:{ids:corrected('idempotency'),fields:['status','result_type','result_id','completed_at_ms']}}:{}),
  };
  return {leagueId:SCOPE.leagueId,updates,inserts:restore?{
    player_ownerships:originals(before.ownerships),roster_display_order_entries:originals(before.display),matchups:originals(before.matches),
    operational_events:[id([SCOPE.operationId,'rollback'])],
  }:{
    commissioner_corrections:corrected('correction'),ownership_events:corrected('ownership'),contract_events:corrected('contract'),
    league_activity:corrected('activity'),idempotency_requests:corrected('idempotency'),
    team_events:SCOPE.teamIds.map(t=>id([SCOPE.operationId,t,'removed'])),matchup_operations:[id([SCOPE.operationId,'schedule'])],
    operational_events:[SCOPE.operationId,id([SCOPE.operationId,'week-one-handoff'])],matchups:originals(newMatches),
  },deletes:restore?{matchups:originals(newMatches)}:{
    player_ownerships:originals(before.ownerships),roster_display_order_entries:originals(before.display),matchups:originals(before.matches),
  }};
}
function requireExecution(db,authorization,operation,nowMs,manifestHash) {
  const path=require('node:path'),fs=require('node:fs'),real=fs.realpathSync(db.name);
  if(authorization==='REHEARSAL_ONLY'){
    requireThat(process.env.APP_ENV!=='production' && /[\\/]team-removal-prep-20260924[\\/]/.test(real) && !path.basename(real).startsWith('source-'), 'ISOLATED_COPY_REQUIRED');
    return;
  }
  requireThat(authorization!==null && typeof authorization==='object','LIVE_EXECUTION_DISABLED');
  const codeHashes=Object.fromEntries(['teamRemovalExecutionAuthorization.js','teamRemovalRecovery.js','teamRemovalWriteFence.js'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')]));
  assertApprovedExecution({grant:authorization,operation,nowMs,wallClockMs:Date.now(),manifestHash,scopeHash:hash(SCOPE),operationId:SCOPE.operationId,schema:db.pragma('user_version',{simple:true}),environment:process.env.APP_ENV,serviceId:process.env.RENDER_SERVICE_ID,databasePath:real,buildId:process.env.RENDER_GIT_COMMIT,codeHashes});
}
function protectedDigest(db) {
  // Compared inside the write transaction: concurrent legitimate bids wait,
  // then continue after commit. No old snapshot is copied over newer work.
  const tables=rows(db,"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map(r=>r.name).filter(n=>/^(auctions$|auction_|free_agent_draft|candidate_card|job_runs$|outbox_events$|users$|league_memberships$|leagues$|seasons$|matchup_weeks$|matchup_schedule_job_bindings$|season_matchup_schedule_generations$)/.test(n));
  return hash(tables.map(name=>{const keys=rows(db,`PRAGMA table_info(${name})`).filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);requireThat(keys.length,'PRIMARY_KEY_REQUIRED',{name});return [name,rows(db,`SELECT * FROM ${name} ORDER BY ${keys.join(',')}`)];}));
}

function apply(db,{manifest,nowMs=Date.now(),authorization,phaseHook,maxLockMs=1000}={}) {
  requireExecution(db,authorization,'apply',nowMs,hash(manifest));
  requireThat(authorization==='REHEARSAL_ONLY'||(phaseHook===undefined&&maxLockMs===1000),'PRODUCTION_TEST_OVERRIDES_FORBIDDEN');
  requireThat(manifest?.format==='team-removal-preview-v2' && manifest.operationId===SCOPE.operationId && hash(manifest.scope)===hash(SCOPE),'INVALID_MANIFEST');
  requireThat(db.pragma('foreign_keys',{simple:true})===1,'FOREIGN_KEYS_REQUIRED');
  requireThat(!db.prepare('SELECT id FROM operational_events WHERE id=?').get(id([SCOPE.operationId,'rollback'])),'OPERATION_ALREADY_REVERSED');
  const replay=receipt(db);if(replay) {requireThat(replay.previewHash===hash(manifest),'REPLAY_CONFLICT');return {...replay.summary,replayed:true};}
  requireThat(nowMs>=manifest.createdAtMs && nowMs<=manifest.expiresAtMs,'STALE_PREVIEW');
  const transaction=db.transaction(()=>{
    const started=performance.now();
    const x=inspect(db,nowMs);
    requireThat(x.schemaHash===manifest.schemaHash && x.preconditionHash===manifest.preconditionHash,'STATE_CHANGED');
    requireThat(hash(x.newMatches.map(({created_at_ms,updated_at_ms,...r})=>r))===hash(manifest.matchups.map(({created_at_ms,updated_at_ms,...r})=>r)),'PAIRINGS_CHANGED');
    requireThat(hash(manifest)===hash(inspectedPreview(db,x,manifest.createdAtMs)),'PREVIEW_CONTENT_CHANGED');
    const protectedBefore=protectedDigest(db);
    const before=x.snapshot;
    const removeFence=installWriteFence(db,writeScope(before,x.newMatches));
    try {
    const summer=createSqliteCandidateCardSummerSynchronizer({database:db,candidateCardRepository:{synchronizeSummerStateCurrent(){fail('UNEXPECTED_OPEN_CARD');}}});
    const correction=createSqliteCommissionerCorrectionRepository({database:db,candidateCardSummerSynchronizer:summer});
    const corrections=[];
    for(const o of before.ownerships) {
      const c=before.contracts.find(c=>c.player_id===o.player_id);
      const key=`${SCOPE.operationId}:${o.player_id}`;
      const input={correctionId:id([key,'correction']),ownershipEventId:id([key,'ownership']),contractEventId:id([key,'contract']),activityId:id([key,'activity']),leagueId:SCOPE.leagueId,seasonId:SCOPE.seasonId,ownershipId:o.id,playerId:o.player_id,expectedVersion:o.version,contractId:c.id,expectedContractVersion:c.version,actorUserId:before.actor.user_id,actorMembershipId:before.actor.id,actorAuthority:'commissioner',confirmWarnings:true,reason:REASON,occurredAtMs:nowMs};
      const result=correction.applyRemove(input,{id:id([key,'idempotency']),key,requestHash:hash(input),expiresAtMs:nowMs+86400000});
      corrections.push(result.correction.id);
      phase(phaseHook,`released:${o.player_id}`);
    }
    for(const t of before.teams.filter(t=>SCOPE.teamIds.includes(t.id))) {
      requireThat(db.prepare("UPDATE teams SET status='erased',updated_at_ms=?,version=version+1 WHERE id=? AND league_id=? AND version=? AND status='active'").run(nowMs,t.id,SCOPE.leagueId,t.version).changes===1,'TEAM_CHANGED');
      for(const a of before.assignments.filter(a=>a.team_id===t.id&&a.status==='accepted'&&a.ended_at_ms===null)) requireThat(db.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=?,version=version+1 WHERE id=? AND league_id=? AND version=?").run(nowMs,a.id,SCOPE.leagueId,a.version).changes===1,'ASSIGNMENT_CHANGED');
      insertRow(db,'team_events',{id:id([SCOPE.operationId,t.id,'removed']),league_id:SCOPE.leagueId,team_id:t.id,actor_user_id:before.actor.user_id,event_type:'team_removed_from_competition',reason:REASON,metadata_json:JSON.stringify({operationId:SCOPE.operationId,retainedHistoricalIdentity:true}),occurred_at_ms:nowMs});
    }
    phase(phaseHook,'teams');
    for(const p of before.picks) requireThat(db.prepare("UPDATE draft_picks SET status='forfeited',updated_at_ms=?,version=version+1 WHERE league_id=? AND id=? AND version=? AND status='unused'").run(nowMs,SCOPE.leagueId,p.id,p.version).changes===1,'PICK_CHANGED');
    phase(phaseHook,'picks');
    requireThat(db.prepare('DELETE FROM matchups WHERE league_id=? AND season_id=?').run(SCOPE.leagueId,SCOPE.seasonId).changes===154,'MATCHUP_COUNT_CHANGED');
    for(const m of x.newMatches) insertRow(db,'matchups',m);
    phase(phaseHook,'matchups');
    insertRow(db,'matchup_operations',{id:id([SCOPE.operationId,'schedule']),league_id:SCOPE.leagueId,season_id:SCOPE.seasonId,matchup_week_id:null,matchup_id:null,actor_user_id:before.actor.user_id,operation_type:'participant_removal_pairing_correction',status:'succeeded',reason:REASON,metadata_json:JSON.stringify({operationId:SCOPE.operationId,originalGeneration:before.generations,oldCount:154,newCount:132,calendarAndBindingsUnchanged:true}),started_at_ms:nowMs,completed_at_ms:nowMs});
    const summary={operationId:SCOPE.operationId,teamsRemoved:2,playersReleased:3,picksForfeited:32,weeks:22,matchups:132,calendarUnchanged:true,auctionRowsWritten:0,contractCorrections:corrections,replayed:false};
    // Exact before-images are private database evidence and support guarded
    // compensation; never replace the whole production database after new bids.
    const evidence={previewHash:hash(manifest),before,newMatches:x.newMatches,summary,appliedAtMs:nowMs,protectedDigest:protectedBefore};
    insertRow(db,'operational_events',{id:SCOPE.operationId,league_id:SCOPE.leagueId,season_id:SCOPE.seasonId,event_type:EVENT,feature:'team_removal_recovery',outcome:'succeeded',actor_user_id:before.actor.user_id,reason_code:'two_inactive_teams',details_json:JSON.stringify(evidence),occurred_at_ms:nowMs});
    const week=before.weeks[0],generation=before.generations.find(g=>g.status==='current');
    const handoff={format:'fad-week-one-handoff-v1',fadId:before.draft.id,matchupWeekId:week.id,scheduleVersion:generation.schedule_version,startsAtMs:week.starts_at_ms,baselineAtMs:week.baseline_at_ms,activeTeamCount:12,removalOperationId:SCOPE.operationId};
    insertRow(db,'operational_events',{id:id([SCOPE.operationId,'week-one-handoff']),league_id:SCOPE.leagueId,season_id:SCOPE.seasonId,event_type:'free_agent_draft.week_one_handoff_approved.v1',feature:'free_agent_draft',outcome:'succeeded',actor_user_id:before.actor.user_id,reason_code:'preserve_september_29_week_one',details_json:JSON.stringify(handoff),occurred_at_ms:nowMs});
    phase(phaseHook,'handoff');
    verifyApplied(db,evidence);
    requireThat(protectedDigest(db)===protectedBefore,'PROTECTED_DATA_CHANGED');
    phase(phaseHook,'verified');
    removeFence();
    const lockMs=performance.now()-started;requireThat(lockMs<=maxLockMs,'TRANSACTION_TOO_SLOW',{lockMs,maxLockMs});
    return {...summary,lockMs};
    } finally { removeFence(); }
  });
  return transaction.immediate();
}

function verifyApplied(db,evidence=receipt(db)) {
  requireThat(evidence,'RECEIPT_MISSING');
  const {before,newMatches}=evidence;
  assert.deepEqual(seasonRows(db,'matchup_weeks','sequence'),before.weeks);
  assert.deepEqual(seasonRows(db,'season_matchup_schedule_generations','schedule_version'),before.generations);
  assert.deepEqual(seasonRows(db,'matchup_schedule_job_bindings'),before.bindings);
  assert.deepEqual(seasonRows(db,'free_agent_drafts')[0],before.draft);
  const actual=seasonRows(db,'matchups');assert.deepEqual(actual,[...newMatches].sort((a,b)=>a.id.localeCompare(b.id)));
  requireThat(rows(db,"SELECT id FROM teams WHERE league_id=? AND status='active'",SCOPE.leagueId).length===12,'SURVIVOR_COUNT_INVALID');
  requireThat(targetRows(db,'player_ownerships').length===0,'OWNERSHIP_REMAINS');
  requireThat(targetRows(db,'contracts','current_team_id').every(c=>c.status!=='active'),'ACTIVE_CONTRACT_REMAINS');
  requireThat(targetRows(db,'draft_picks','original_team_id').every(p=>p.status==='forfeited'),'ACTIVE_PICK_REMAINS');
  for(const assignment of before.assignments) {
    const expected=assignment.status==='accepted'&&assignment.ended_at_ms===null
      ? {...assignment,status:'ended',ended_at_ms:evidence.appliedAtMs,version:assignment.version+1}
      : assignment;
    assert.deepEqual(db.prepare('SELECT * FROM team_manager_assignments WHERE id=? AND league_id=?').get(assignment.id,SCOPE.leagueId),expected,'ASSIGNMENT_CHANGED');
  }
  requireThat(db.prepare('SELECT COUNT(*) n FROM free_agent_draft_approved_week_one_handoffs WHERE league_id=? AND season_id=? AND fad_id=?').get(SCOPE.leagueId,SCOPE.seasonId,before.draft.id).n===1,'WEEK_ONE_HANDOFF_INVALID');
  for(const team of before.teams.filter(t=>!SCOPE.teamIds.includes(t.id))) assert.deepEqual(db.prepare('SELECT * FROM teams WHERE id=?').get(team.id),team);
  requireThat(db.pragma('foreign_key_check').length===0,'FOREIGN_KEY_FAILURE');
  return {status:'passed',calendarAndDraftUnchanged:true,activeTeams:12,matchups:actual.length};
}

function rollback(db,{nowMs=Date.now(),authorization,maxLockMs=1000}={}) {
  requireExecution(db,authorization,'rollback',nowMs,receipt(db)?.previewHash);
  requireThat(authorization==='REHEARSAL_ONLY'||maxLockMs===1000,'PRODUCTION_TEST_OVERRIDES_FORBIDDEN');
  requireThat(db.pragma('foreign_keys',{simple:true})===1,'FOREIGN_KEYS_REQUIRED');
  const reversed=db.prepare('SELECT * FROM operational_events WHERE id=?').get(id([SCOPE.operationId,'rollback']));
  if(reversed) return {replayed:true,restored:true};
  return db.transaction(()=>{
    const started=performance.now(),evidence=receipt(db);requireThat(evidence,'RECEIPT_MISSING');
    const protectedBefore=protectedDigest(db);
    requireThat(nowMs>=evidence.appliedAtMs && nowMs<=evidence.appliedAtMs+15*60000,'ROLLBACK_WINDOW_EXPIRED');
    verifyApplied(db,evidence);
    const {before}=evidence;
    requireThat(rows(db,"SELECT id FROM job_runs WHERE league_id=? AND status IN ('running','leased')",SCOPE.leagueId).length===0,'JOBS_IN_FLIGHT');
    for(const playerId of SCOPE.playerIds) {
      requireThat(rows(db,'SELECT id FROM player_ownerships WHERE league_id=? AND player_id=?',SCOPE.leagueId,playerId).length===0,'PLAYER_REACQUIRED');
      requireThat(rows(db,'SELECT id FROM auctions WHERE league_id=? AND player_id=? AND created_at_ms>=?',SCOPE.leagueId,playerId,evidence.appliedAtMs).length===0,'PLAYER_AUCTION_STARTED');
      requireThat(rows(db,"SELECT id FROM free_agent_draft_nomination_queue WHERE league_id=? AND player_id=? AND status='queued'",SCOPE.leagueId,playerId).length===0,'PLAYER_NOMINATED');
    }
    const removeFence=installWriteFence(db,writeScope(before,evidence.newMatches,{restore:true}));
    try {
    const changed=(original,changes)=>({...original,...changes});
    function restoreRow(table,original,expectedChanges,restoredChanges) {
      const current=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(original.id);
      assert.deepEqual(current,changed(original,expectedChanges),`Rollback stops on intervening ${table} change`);
      const fields=Object.keys(restoredChanges);db.prepare(`UPDATE ${table} SET ${fields.map(f=>`${f}=@${f}`).join(',')} WHERE id=@id`).run({...restoredChanges,id:original.id});
    }
    for(const t of before.teams.filter(t=>SCOPE.teamIds.includes(t.id))) restoreRow('teams',t,{status:'erased',updated_at_ms:evidence.appliedAtMs,version:t.version+1},{status:t.status,updated_at_ms:nowMs,version:t.version+2});
    for(const a of before.assignments.filter(a=>a.status==='accepted'&&a.ended_at_ms===null)) restoreRow('team_manager_assignments',a,{status:'ended',ended_at_ms:evidence.appliedAtMs,version:a.version+1},{status:'accepted',ended_at_ms:null,version:a.version+2});
    for(const c of before.contracts) restoreRow('contracts',c,{status:'cancelled',updated_at_ms:evidence.appliedAtMs,version:c.version+1},{status:'active',updated_at_ms:nowMs,version:c.version+2});
    for(const y of before.years) restoreRow('contract_years',y,{status:'eliminated',rollover_at_ms:evidence.appliedAtMs},{status:y.status,rollover_at_ms:y.rollover_at_ms});
    for(const o of before.ownerships) insertRow(db,'player_ownerships',{...o,version:o.version+1,updated_at_ms:nowMs});
    for(const d of before.display) insertRow(db,'roster_display_order_entries',d);
    for(const p of before.picks) restoreRow('draft_picks',p,{status:'forfeited',updated_at_ms:evidence.appliedAtMs,version:p.version+1},{status:'unused',updated_at_ms:nowMs,version:p.version+2});
    db.prepare('DELETE FROM matchups WHERE league_id=? AND season_id=?').run(SCOPE.leagueId,SCOPE.seasonId);
    for(const m of before.matches) insertRow(db,'matchups',{...m,version:m.version+1,updated_at_ms:nowMs});
    insertRow(db,'operational_events',{id:id([SCOPE.operationId,'rollback']),league_id:SCOPE.leagueId,season_id:SCOPE.seasonId,event_type:EVENT+'.rolled_back',feature:'team_removal_recovery',outcome:'succeeded',actor_user_id:before.actor.user_id,reason_code:'guarded_compensation',details_json:JSON.stringify({originalOperationId:SCOPE.operationId,versionsAdvanced:true,originalAuditPreserved:true}),occurred_at_ms:nowMs});
    requireThat(db.pragma('foreign_key_check').length===0,'FOREIGN_KEY_FAILURE');
    requireThat(protectedDigest(db)===protectedBefore,'PROTECTED_DATA_CHANGED');
    removeFence();
    const lockMs=performance.now()-started;requireThat(lockMs<=maxLockMs,'TRANSACTION_TOO_SLOW',{lockMs,maxLockMs});
    return {restored:true,replayed:false,lockMs};
    } finally { removeFence(); }
  }).immediate();
}

module.exports={SCOPE,EVENT,hash,id,preview,apply,rollback,verifyApplied,schemaHash,receipt,insertRow,requireExecution};
