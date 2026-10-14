const crypto = require('node:crypto');
const { GOON_ID } = require('./goonDraftTiming');
const { repositoryError } = require('./SqliteRepositoryError');
const { validateFreeAgentDraftTiming, FREE_AGENT_DRAFT_HELP_WINDOW_MS,
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS, buildFreeAgentDraftReminderOccurrenceKey,
  buildFreeAgentDraftDeadlineOccurrenceKey, buildFreeAgentDraftRolloverOccurrenceKey } = require('../../../domain/freeAgentDraft/freeAgentDraftPolicy');
const { publishLeagueChangeAnnouncement } = require('./leagueChangeAnnouncement');

// Called only inside the commissioner-confirmed schedule-generation transaction.
// Existing cards, revisions, offers and completed jobs are never rewritten.
function scheduleExistingGoonDraft(database, parameters) {
  if (parameters.leagueId !== GOON_ID) return false;
  const drafts = database.prepare(`SELECT * FROM free_agent_drafts WHERE league_id=? AND season_id=?
    AND status='cards_open' AND candidate_deadline_at_ms IS NULL`).all(parameters.leagueId, parameters.seasonId);
  if (!drafts.length) return false;
  const fail = () => { throw repositoryError('REPOSITORY_SCHEMA_INCOMPATIBLE', 'The existing draft cannot be scheduled safely.'); };
  if (!database.inTransaction || drafts.length !== 1 || database.pragma('user_version', { simple:true }) < 93) fail();
  const draft = drafts[0];
  const timing = validateFreeAgentDraftTiming(JSON.parse(parameters.fadTimingJson), parameters.firstWeekStartsAtMs);
  if (timing.candidateDeadlineAtMs <= parameters.nowMs || timing.candidateDeadlineAtMs <= draft.opened_at_ms) fail();
  const league = database.prepare('SELECT status,current_season_id,timezone FROM leagues WHERE id=?').get(GOON_ID);
  const readiness = database.prepare('SELECT * FROM free_agent_draft_readiness_operations WHERE league_id=? AND id=?')
    .get(GOON_ID, draft.readiness_operation_id);
  if (league?.status !== 'active' || league.current_season_id !== draft.season_id ||
      readiness?.status !== 'succeeded' || readiness.created_fad_id !== draft.id ||
      database.prepare("SELECT 1 FROM league_freezes WHERE league_id=? AND status='active'").get(GOON_ID)) fail();
  const count = table => database.prepare(`SELECT count(*) n FROM ${table} WHERE league_id=? AND fad_id=?`).get(GOON_ID,draft.id).n;
  if (['free_agent_draft_rollovers','candidate_card_snapshots','free_agent_draft_player_allocations','auction_contexts']
      .some(table => count(table) !== 0)) fail();
  if (database.prepare("SELECT 1 FROM job_runs WHERE league_id=? AND season_id=? AND job_type LIKE 'fad_%' AND status NOT IN ('succeeded','cancelled')")
      .get(GOON_ID,draft.season_id)) fail();
  if (count('candidate_cards') !== draft.participating_team_count ||
      database.prepare("SELECT 1 FROM candidate_cards WHERE league_id=? AND fad_id=? AND status<>'open'").get(GOON_ID,draft.id)) fail();
  const cardBaselines=database.prepare(`SELECT c.id AS cardId,c.version AS cardVersion,count(r.id) AS revisionCount,
    min(r.resulting_card_version) AS firstRevision,max(r.resulting_card_version) AS lastRevision
    FROM candidate_cards c LEFT JOIN candidate_card_revisions r ON r.league_id=c.league_id AND r.card_id=c.id
    WHERE c.league_id=? AND c.fad_id=? GROUP BY c.id ORDER BY c.id`).all(GOON_ID,draft.id).map(card=>{
      const resetVersion=card.cardVersion-card.revisionCount;
      if(resetVersion<0 || (card.revisionCount>0 && (card.firstRevision!==resetVersion+1 || card.lastRevision!==card.cardVersion))) fail();
      return {...card,resetVersion};
    });

  const afterRoot = {...draft, first_matchup_week_id:parameters.firstWeekId,
    current_competition_first_matchup_week_id:parameters.firstWeekId,
    first_matchup_starts_at_ms:parameters.firstWeekStartsAtMs,
    candidate_deadline_at_ms:timing.candidateDeadlineAtMs,
    help_opens_at_ms:Math.max(draft.opened_at_ms,timing.candidateDeadlineAtMs-FREE_AGENT_DRAFT_HELP_WINDOW_MS),
    initial_rollover_times_json:JSON.stringify(timing.rolloverTimesAtMs),
    updated_at_ms:Math.max(parameters.nowMs,draft.updated_at_ms),version:draft.version+1};
  const reminderAtMs=timing.candidateDeadlineAtMs-FREE_AGENT_DRAFT_REMINDER_LEAD_MS;
  const jobs=[];
  const makeJob=(jobType,at,occurrenceKey)=>{
    const job={id:crypto.randomUUID(),league_id:GOON_ID,season_id:draft.season_id,job_type:jobType,
      occurrence_key:occurrenceKey,scheduled_for_ms:at,status:'pending',attempt_count:0,
      lease_owner:null,lease_expires_at_ms:null,started_at_ms:null,completed_at_ms:null,result_json:null,
      last_error_code:null,created_at_ms:parameters.nowMs,updated_at_ms:parameters.nowMs,version:1,
      lease_token:null,next_attempt_at_ms:null};
    jobs.push(job);return job.id;
  };
  const reminderId=makeJob('fad_deadline_reminder',reminderAtMs,
    buildFreeAgentDraftReminderOccurrenceKey({fadId:draft.id,reminderAtMs}));
  const deadlineId=makeJob('fad_deadline',timing.candidateDeadlineAtMs,
    buildFreeAgentDraftDeadlineOccurrenceKey({fadId:draft.id,deadlineAtMs:timing.candidateDeadlineAtMs}));
  const afterReadiness={...readiness,reminder_job_run_id:reminderId,deadline_job_run_id:deadlineId,
    updated_at_ms:Math.max(parameters.nowMs,readiness.updated_at_ms),version:readiness.version+1};
  const gapMs=(timing.auctionCreationCutoffMinutes ?? draft.auction_creation_cutoff_minutes)*60_000;
  let opens=timing.candidateDeadlineAtMs,predecessor=null;
  const rollovers=timing.rolloverTimesAtMs.map((closes,index)=>{
    const row={id:crypto.randomUUID(),league_id:GOON_ID,season_id:draft.season_id,fad_id:draft.id,
      sequence:index+1,window_kind:'initial',predecessor_rollover_id:predecessor,
      extension_reason:null,extension_source_id:null,opens_at_ms:opens,
      creation_cutoff_at_ms:Math.max(opens,closes-gapMs),rolls_over_at_ms:closes,status:'scheduled',
      processing_job_run_id:null,processing_started_at_ms:null,completed_at_ms:null,last_error_code:null,
      created_at_ms:parameters.nowMs,updated_at_ms:parameters.nowMs,version:1};
    makeJob('fad_rollover',closes,buildFreeAgentDraftRolloverOccurrenceKey({fadId:draft.id,sequence:index+1,rolloverAtMs:closes}));
    opens=closes;predecessor=row.id;return row;
  });
  function insert(table,row){const keys=Object.keys(row);database.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k=>'@'+k).join(',')})`).run(row);}
  for(const job of jobs) insert('job_runs',job);
  insert('goon_draft_scheduling_receipts',{id:parameters.operationId,league_id:GOON_ID,season_id:draft.season_id,
    fad_id:draft.id,actor_user_id:parameters.actorUserId,before_root_json:JSON.stringify(draft),after_root_json:JSON.stringify(afterRoot),
    before_readiness_json:JSON.stringify(readiness),after_readiness_json:JSON.stringify(afterReadiness),
    rollovers_json:JSON.stringify(rollovers),jobs_json:JSON.stringify(jobs),card_baselines_json:JSON.stringify(cardBaselines),created_at_ms:parameters.nowMs});
  const update=(table,before,after,fields)=>{
    const result=database.prepare(`UPDATE ${table} SET ${fields.map(k=>k+'=@'+k).join(',')}
      WHERE league_id=@league_id AND id=@id AND version=@expectedVersion`).run({...after,expectedVersion:before.version});
    if(result.changes!==1) fail();
  };
  update('free_agent_draft_readiness_operations',readiness,afterReadiness,
    ['reminder_job_run_id','deadline_job_run_id','updated_at_ms','version']);
  update('free_agent_drafts',draft,afterRoot,['first_matchup_week_id','current_competition_first_matchup_week_id',
    'first_matchup_starts_at_ms','candidate_deadline_at_ms','help_opens_at_ms','initial_rollover_times_json','updated_at_ms','version']);
  database.prepare(`INSERT INTO fad_auction_cutoff_settings (id,league_id,season_id,gap_ms,updated_at_ms,version)
    VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET gap_ms=excluded.gap_ms,updated_at_ms=excluded.updated_at_ms,
    version=fad_auction_cutoff_settings.version+1`).run(draft.id,GOON_ID,draft.season_id,gapMs,parameters.nowMs);
  for(const round of rollovers) insert('free_agent_draft_rollovers',round);
  if(count('free_agent_draft_rollovers')!==rollovers.length) fail();
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:league.timezone,dateStyle:'medium',timeStyle:'short'});
  publishLeagueChangeAnnouncement(database,{id:crypto.randomUUID(),leagueId:GOON_ID,actorUserId:parameters.actorUserId,
    title:'Free Agent Draft scheduled',message:`Saved Candidate Cards will be checked and processed at ${date.format(timing.candidateDeadlineAtMs)} (${league.timezone}). ${rollovers.length} rapid-auction rounds are scheduled. Review the Free Agent Draft for closing times.`,
    reason:'Commissioner confirmed the draft and season schedule.',nowMs:parameters.nowMs});
  return true;
}
module.exports={scheduleExistingGoonDraft};
