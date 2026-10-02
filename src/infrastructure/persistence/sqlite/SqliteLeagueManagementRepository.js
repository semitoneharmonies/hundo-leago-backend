const {createSqliteTeamWorkspaceRepository}=require('./SqliteTeamWorkspaceRepository');
const {evaluateTeamRosterLegality}=require('../../../application/services/leagues/createTeamWorkspaceService');
const {evaluateMatchupLineupLegality}=require('../../../domain/matchups/matchupLegalityPolicy');
const {createSqliteLeagueCommunicationRepository}=require('./SqliteLeagueCommunicationRepository');
const {createSqliteSeasonRolloverPreviewRepository}=require('./SqliteSeasonRolloverPreviewRepository');
function createSqliteLeagueManagementRepository({database,expandedScoringEnabled=false,nowMs=Date.now}) {
  const workspace=createSqliteTeamWorkspaceRepository({database,expandedScoringEnabled,nowMs});
  const communications=createSqliteLeagueCommunicationRepository({database});
  const rolloverPreview=createSqliteSeasonRolloverPreviewRepository({database});
  const league=id=>database.prepare('SELECT id,name,status,timezone,current_season_id AS seasonId FROM leagues WHERE id=?').get(id);
  const season=(leagueId,seasonId)=>database.prepare(`SELECT id,label,status,regular_season_starts_at_ms AS regularStartsAtMs,regular_season_ends_at_ms AS regularEndsAtMs,
    fantasy_playoffs_start_at_ms AS playoffsStartAtMs,fantasy_playoffs_end_at_ms AS playoffsEndAtMs,free_agent_draft_completed_at_ms AS fadCompletedAtMs
    FROM seasons WHERE league_id=? AND id=?`).get(leagueId,seasonId)||null;
  const teams=id=>database.prepare(`SELECT t.id,t.name,t.status,u.display_name AS managerName FROM teams t
    LEFT JOIN team_manager_assignments a ON a.league_id=t.league_id AND a.team_id=t.id AND a.status='accepted' AND a.ended_at_ms IS NULL
    LEFT JOIN league_memberships m ON m.league_id=a.league_id AND m.id=a.membership_id AND m.user_id=a.user_id AND m.status='active'
    LEFT JOIN users u ON u.id=m.user_id AND u.status='active'
    WHERE t.league_id=? AND t.status<>'erased' ORDER BY t.name,t.id`).all(id);
  const historyParts=[
    "SELECT id,league_id,action_type kind,actor_user_id actor,reason,created_at_ms at,CASE action_type WHEN 'pick_repair' THEN 'Missing draft picks repaired' WHEN 'pause' THEN 'League paused' WHEN 'resume' THEN 'League resumed' ELSE 'Administrative correction reversed' END summary,target_id target,before_json beforeValue,after_json afterValue FROM league_management_actions",
    "SELECT id,league_id,'calendar' kind,actor_user_id actor,reason,created_at_ms at,'League calendar updated' summary,league_id target,before_json beforeValue,after_json afterValue FROM league_calendar_changes",
    "SELECT id,league_id,'scoring',actor_user_id,reason,created_at_ms,'Scoring values from Week '||effective_week_sequence,league_id,before_json,json_object('effectiveWeekSequence',effective_week_sequence,'weights',json(weights_json)) FROM league_scoring_rules",
    "SELECT id,league_id,'auction_schedule',actor_user_id,reason,created_at_ms,'Recurring auction schedule updated',league_id,before_json,json_object('closeWeekday',close_weekday,'closeMinuteOfDay',close_minute_of_day,'creationCutoffMinutes',creation_cutoff_minutes) FROM league_auction_schedule_changes",
    "SELECT id,league_id,'trade_deadline',actor_user_id,reason,created_at_ms,'Trade deadline updated',league_id,json_object('deadlineAtMs',previous_deadline_at_ms),json_object('deadlineAtMs',deadline_at_ms) FROM league_trade_deadline_changes",
    "SELECT id,league_id,'auction_timing',actor_user_id,reason,created_at_ms,'Auction closing time updated',auction_id,json_object('closesAtMs',previous_closes_at_ms),json_object('closesAtMs',closes_at_ms) FROM auction_timing_changes",
    "SELECT id,league_id,'private_review',actor_user_id,reason,created_at_ms,CASE WHEN bid_id IS NULL THEN 'Auction bidder identities explicitly reviewed' ELSE 'Selected auction bid explicitly reviewed' END,auction_id,NULL,NULL FROM league_private_reveals",
    "SELECT id,league_id,'fad_timing',actor_user_id,reason,created_at_ms,'FAD schedule updated',fad_id,before_root_json,after_root_json FROM fad_timing_changes",
    "SELECT id,league_id,'fad_cutoff',actor_user_id,reason,created_at_ms,'FAD start cutoff updated',fad_id,json_object('gapMs',previous_gap_ms),json_object('gapMs',gap_ms) FROM fad_auction_cutoff_changes",
    "SELECT id,league_id,'fad_deadline',actor_user_id,reason,created_at_ms,'FAD deadline processing confirmed',fad_id,NULL,NULL FROM fad_deadline_commands",
    "SELECT id,league_id,'roster_correction',actor_user_id,reason,corrected_at_ms,'Commissioner '||replace(feature,'_',' ')||' correction',feature_record_id,NULL,NULL FROM commissioner_corrections WHERE feature IN ('roster','contract','roster_add','roster_remove')",
    "SELECT id,league_id,'communication',created_by_user_id,NULL,created_at_ms,CASE WHEN kind='announcement' THEN 'League announcement published' ELSE 'Targeted reminder sent' END,id,NULL,NULL FROM league_communications",
    "SELECT id,league_id,'communication_archive',archived_by_user_id,NULL,archived_at_ms,'Announcement archived',id,NULL,NULL FROM league_communications WHERE archived_at_ms IS NOT NULL",
    "SELECT id,league_id,'competition',actor_user_id,reason,completed_at_ms,'Competition operation: '||replace(operation_type,'_',' '),matchup_id,NULL,NULL FROM matchup_operations WHERE actor_user_id IS NOT NULL AND status='succeeded'",
    "SELECT id,league_id,'competition',actor_user_id,reason,completed_at_ms,'Derived standings rebuilt',standings_snapshot_id,NULL,NULL FROM standings_operations WHERE actor_user_id IS NOT NULL AND status='succeeded' AND operation_type='rebuild'",
  ];
  if(database.pragma('user_version',{simple:true})>=83)historyParts.push("SELECT id,league_id,'preseason_reset',actor_user_id,reason,created_at_ms,CASE action_type WHEN 'reset' THEN 'Preseason returned to setup' ELSE 'Preseason archive restored' END,archive_id,NULL,NULL FROM league_reset_actions");
  const timeline=database.prepare(`WITH changes AS (${historyParts.join(' UNION ALL ')}) SELECT c.id,c.kind,c.at,c.summary,c.reason,c.target,c.beforeValue,c.afterValue,u.display_name AS actorName
    FROM changes c JOIN users u ON u.id=c.actor WHERE c.league_id=@leagueId
    AND (@kind='all' OR c.kind=@kind)
    AND (@query='' OR instr(lower(c.summary||' '||coalesce(c.reason,'')||' '||u.display_name||' '||coalesce(c.target,'')),@query)>0)
    AND (@beforeAt IS NULL OR c.at<@beforeAt OR (c.at=@beforeAt AND c.kind||':'||c.id<@beforeId))
    ORDER BY c.at DESC,c.kind||':'||c.id DESC LIMIT 51`);
  return {
    snapshot:fn=>database.transaction(fn)(),
    readiness(leagueId,at) {
      const l=league(leagueId),s=season(leagueId,l.seasonId),allTeams=teams(leagueId).filter(t=>['setup','active'].includes(t.status));
      const drafts=s?database.prepare("SELECT id,status,candidate_deadline_at_ms AS deadlineAtMs FROM free_agent_drafts WHERE league_id=? AND season_id=? AND status<>'completed' ORDER BY opened_at_ms DESC").all(leagueId,s.id):[];
      const cards=communications.cardProgress(leagueId);
      const reportTeams=allTeams.map(t=>{
        let roster=null;
        if(s){const record=workspace.read({leagueId,teamId:t.id});if(record){
          const structural=evaluateTeamRosterLegality(record),lineup=s.fadCompletedAtMs===null?evaluateMatchupLineupLegality(record.players.filter(p=>p.roster_category==='Active')):{legal:true,reasonCodes:[]};
          roster={legal:structural.legal&&lineup.legal,counts:structural.counts,limits:structural.limits,cap:structural.cap,
            reasonCodes:[...new Set([...structural.reasons.map(r=>r.code),...lineup.reasonCodes])],requiredNow:s.fadCompletedAtMs!==null};
        }}
        return {...t,cardStatus:drafts.some(d=>d.status==='cards_open')?(cards.find(c=>c.teamId===t.id)?.status||'not_created'):null,roster};
      });
      const weeks=s?database.prepare('SELECT id,sequence,status,starts_at_ms AS startsAtMs,ends_at_ms AS endsAtMs,locks_at_ms AS locksAtMs FROM matchup_weeks WHERE league_id=? AND season_id=? ORDER BY sequence').all(leagueId,s.id):[];
      const calendarIssues=[];
      if(!s)calendarIssues.push('NO_CURRENT_SEASON');
      else {
        if([s.regularStartsAtMs,s.regularEndsAtMs,s.playoffsStartAtMs,s.playoffsEndAtMs].some(v=>v===null))calendarIssues.push('SEASON_DATES_UNSET');
        if(!weeks.length)calendarIssues.push('MATCHUPS_NOT_SCHEDULED');
        if(weeks.some((w,i)=>w.locksAtMs>=w.endsAtMs||w.startsAtMs>w.locksAtMs||(i>0&&weeks[i-1].endsAtMs>w.startsAtMs)))calendarIssues.push('MATCHUP_DATES_CONFLICT');
        if(s.playoffsStartAtMs!==null&&s.playoffsEndAtMs!==null&&s.playoffsStartAtMs>=s.playoffsEndAtMs)calendarIssues.push('PLAYOFF_DATES_CONFLICT');
        for(const d of drafts)if(d.status==='cards_open'&&d.deadlineAtMs===null)calendarIssues.push('CANDIDATE_DEADLINE_UNSET');
      }
      const picks=[];
      if(s)for(const draft of database.prepare("SELECT id,status,rounds FROM entry_drafts WHERE league_id=? AND season_id=? AND status<>'cancelled'").all(leagueId,s.id)){
        const existing=database.prepare('SELECT original_team_id AS teamId,round_number AS round FROM draft_picks WHERE league_id=? AND draft_id=?').all(leagueId,draft.id);
        const order=database.prepare('SELECT DISTINCT r.original_team_id AS id FROM draft_lottery_results r JOIN draft_lottery_runs l ON l.league_id=r.league_id AND l.id=r.lottery_run_id WHERE l.league_id=? AND l.draft_id=?').all(leagueId,draft.id);
        const expected=order.length?order:[...new Set([...allTeams.map(t=>t.id),...existing.map(p=>p.teamId)])].map(id=>({id}));
        for(const team of expected)for(let round=1;round<=draft.rounds;round++)if(!existing.some(p=>p.teamId===team.id&&p.round===round))picks.push({draftId:draft.id,teamId:team.id,teamName:allTeams.find(t=>t.id===team.id)?.name||'Former team',round});
      }
      const jobs=s?database.prepare(`SELECT id,job_type AS jobName,status,scheduled_for_ms AS scheduledForMs,attempt_count AS attempts,lease_expires_at_ms AS leaseExpiresAtMs,last_error_code AS errorCode,count(*) OVER() AS total FROM job_runs
        WHERE league_id=? AND season_id=? AND (status='failed' OR (status IN ('leased','running') AND lease_expires_at_ms<?)) ORDER BY scheduled_for_ms,id LIMIT 100`).all(leagueId,s.id,at):[];
      return {leagueId,checkedAtMs:at,season:s,teams:reportTeams,drafts,calendarIssues:[...new Set(calendarIssues)],missingPicks:picks,operations:jobs.map(({total,...job})=>job),
        summary:{teams:reportTeams.length,missingManagers:reportTeams.filter(t=>!t.managerName).length,unfinishedCards:reportTeams.filter(t=>t.cardStatus&&t.cardStatus!=='complete').length,
          illegalRosters:reportTeams.filter(t=>t.roster&&!t.roster.legal&&t.roster.requiredNow).length,missingPicks:picks.length,calendarIssues:new Set(calendarIssues).size,operations:jobs[0]?.total||0}};
    },
    seasonPreview:(leagueId,at)=>rolloverPreview.read(leagueId,at),
    recovery(leagueId,at) {
      const l=league(leagueId),s=season(leagueId,l.seasonId);
      const operations=database.prepare(`SELECT id,job_type AS kind,status,attempt_count AS attempts,scheduled_for_ms AS scheduledForMs,
        next_attempt_at_ms AS nextAttemptAtMs,lease_expires_at_ms AS leaseExpiresAtMs,last_error_code AS errorCode,count(*) OVER() AS total FROM job_runs WHERE league_id=?
        AND (status='failed' OR (status IN ('leased','running') AND lease_expires_at_ms<?)) ORDER BY scheduled_for_ms,id LIMIT 100`).all(leagueId,at);
      const drafts=s?database.prepare(`SELECT id,status FROM free_agent_drafts WHERE league_id=? AND season_id=? ORDER BY created_at_ms DESC,id`).all(leagueId,s.id):[];
      const weeks=s?database.prepare(`SELECT id,sequence,status FROM matchup_weeks WHERE league_id=? AND season_id=?
        AND status IN ('awaiting_data','correction_required') ORDER BY sequence,id`).all(leagueId,s.id):[];
      const trades=s?database.prepare(`SELECT t.id,t.status,a.name AS proposingTeam,b.name AS receivingTeam,count(*) OVER() AS total
        FROM trades t JOIN teams a ON a.league_id=t.league_id AND a.id=t.proposing_team_id JOIN teams b ON b.league_id=t.league_id AND b.id=t.receiving_team_id
        WHERE t.league_id=? AND t.season_id=? AND t.status='completed' ORDER BY t.updated_at_ms DESC,t.id LIMIT 50`).all(leagueId,s.id):[];
      return {leagueId,seasonId:s?.id||null,checkedAtMs:at,operations:operations.map(({total,...row})=>row),operationCount:operations[0]?.total||0,
        drafts,weeks,trades:trades.map(({total,...row})=>row),tradeCount:trades[0]?.total||0};
    },
    history({leagueId,query,kind,beforeAt,beforeId}) {
      const rows=timeline.all({leagueId,query,kind,beforeAt,beforeId}),hasMore=rows.length>50;
      return {rows:rows.slice(0,50).map(r=>({id:r.kind+':'+r.id,recordId:r.id,kind:r.kind,at:r.at,summary:r.summary,reason:r.reason,actorName:r.actorName,targetId:r.target,
        before:r.beforeValue?JSON.parse(r.beforeValue):null,after:r.afterValue?JSON.parse(r.afterValue):null})),hasMore};
    },
    export(leagueId,at) {
      const l=league(leagueId),s=season(leagueId,l.seasonId),allTeams=teams(leagueId);
      const rosters=s?database.prepare(`SELECT o.id,o.player_id AS playerId,p.full_name AS playerName,o.team_id AS teamId,o.roster_category AS rosterCategory,o.position_group AS position,
        o.ownership_kind AS ownershipKind,c.id AS contractId,c.contract_type AS contractType,c.aav_cents AS aavCents,c.original_term_years AS originalTermYears,c.original_total_value_cents AS originalTotalValueCents,
        CASE WHEN c.id IS NULL THEN NULL ELSE (SELECT count(*) FROM contract_years cy WHERE cy.league_id=c.league_id AND cy.contract_id=c.id AND cy.status IN ('current','future')) END AS remainingYears
        FROM player_ownerships o JOIN players p ON p.id=o.player_id LEFT JOIN contracts c ON c.league_id=o.league_id AND c.player_id=o.player_id AND c.current_team_id=o.team_id AND c.status='active'
        WHERE o.league_id=? AND o.season_id=? ORDER BY o.team_id,p.full_name,o.id`).all(leagueId,s.id):[];
      const picks=s?database.prepare(`SELECT id,draft_id AS draftId,round_number AS round,position_number AS position,original_team_id AS originalTeamId,current_owner_team_id AS ownerTeamId,status
        FROM draft_picks WHERE league_id=? AND target_season_id=? ORDER BY round_number,position_number,id`).all(leagueId,s.id):[];
      const results=s?database.prepare(`SELECT m.id,w.sequence AS week,m.home_team_id AS homeTeamId,m.away_team_id AS awayTeamId,r.status,v.version_number AS version,
        v.home_score_hundredths AS homeScoreHundredths,v.away_score_hundredths AS awayScoreHundredths,v.outcome
        FROM matchup_results r JOIN matchup_result_versions v ON v.league_id=r.league_id AND v.id=r.current_version_id
        JOIN matchups m ON m.league_id=r.league_id AND m.id=r.matchup_id JOIN matchup_weeks w ON w.league_id=m.league_id AND w.id=m.matchup_week_id
        WHERE r.league_id=? AND r.season_id=? AND r.status IN ('official','corrected') ORDER BY w.sequence,m.id`).all(leagueId,s.id):[];
      return {leagueId,format:'hundo-league-export-v1',generatedAtMs:at,scope:'current-season',league:l,season:s,teams:allTeams,rosters,picks,results,
        excluded:['Candidate Cards','auction bids and private bidder identities','trade proposals','account credentials and contact details','private administrative notes'],
        notice:'A league reference export. Restore requires the separate verified recovery workflow.'};
    },
  };
}
module.exports={createSqliteLeagueManagementRepository};
