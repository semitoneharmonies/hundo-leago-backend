const {publishLeagueChangeAnnouncement,changedDates}=require('./leagueChangeAnnouncement');
const crypto=require('node:crypto');
const {leagueCalendarEvents}=require('./leagueCalendarEvents');
const {fail,SEASON_FIELDS,WEEK_FIELDS}=require('../../../domain/leagues/leagueCalendarPolicy');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter}=require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated}=require('../../../domain/leagues/socketInvalidation');
function createSqliteLeagueCalendarRepository({database,leagueOutboxWriter,stagingDailyAuctionsEnabled=false}) {
 const notifications=createSqliteNotificationWriter({database}),outbox=resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
 return {
  transaction:fn=>database.transaction(fn).immediate(),
  state(leagueId) {
   const league=database.prepare('SELECT id,status,timezone,current_season_id,version,updated_at_ms FROM leagues WHERE id=?').get(leagueId);
   if(!league)fail('The league was not found.','LEAGUE_NOT_FOUND');
   const season=database.prepare('SELECT * FROM seasons WHERE league_id=? AND id=?').get(leagueId,league.current_season_id)||null;
   const currentGeneration=database.prepare("SELECT * FROM season_matchup_schedule_generations WHERE league_id=? AND season_id=? AND status='current'").get(leagueId,league.current_season_id)||null;
   return {league,season,currentGeneration,
    unfinishedDraft:database.prepare("SELECT EXISTS(SELECT 1 FROM free_agent_drafts WHERE league_id=? AND season_id=? AND status<>'completed') OR EXISTS(SELECT 1 FROM free_agent_draft_readiness_operations r WHERE r.league_id=? AND r.season_id=? AND r.created_fad_id IS NULL AND NOT EXISTS(SELECT 1 FROM free_agent_drafts d WHERE d.league_id=r.league_id AND d.season_id=r.season_id)) AS present").get(leagueId,league.current_season_id,leagueId,league.current_season_id).present===1,
    fadCount:database.prepare('SELECT COUNT(*) n FROM free_agent_drafts WHERE league_id=? AND season_id=?').get(leagueId,league.current_season_id).n,
    resultWeekIds:database.prepare('SELECT DISTINCT m.matchup_week_id AS id FROM matchups m JOIN matchup_results r ON r.league_id=m.league_id AND r.matchup_id=m.id WHERE m.league_id=? AND m.season_id=? ORDER BY m.matchup_week_id').all(leagueId,league.current_season_id).map(r=>r.id),
    weeks:database.prepare('SELECT * FROM matchup_weeks WHERE league_id=? AND season_id=? ORDER BY sequence').all(leagueId,league.current_season_id),
    jobs:database.prepare(`SELECT j.*,b.owning_matchup_week_id AS weekId FROM job_runs j
     JOIN matchup_schedule_job_bindings b ON b.league_id=j.league_id AND b.job_run_id=j.id
     JOIN season_matchup_schedule_generations g ON g.league_id=b.league_id AND g.season_id=b.season_id
      AND g.schedule_operation_id=b.schedule_operation_id AND g.schedule_version=b.schedule_version AND g.status='current'
     WHERE j.league_id=? AND j.season_id=? ORDER BY j.id`).all(leagueId,league.current_season_id),
    lockedWeekIds:database.prepare('SELECT DISTINCT matchup_week_id FROM matchup_roster_locks WHERE league_id=? AND season_id=? ORDER BY matchup_week_id').all(leagueId,league.current_season_id).map(r=>r.matchup_week_id),
    openAuctions:database.prepare("SELECT id,resolves_at_ms FROM auctions WHERE league_id=? AND season_id=? AND status='open' ORDER BY id").all(leagueId,league.current_season_id),
   };
  },
  events:(leagueId,nowMs)=>leagueCalendarEvents(database,leagueId,{nowMs,stagingDailyAuctionsEnabled}),
  workspaceMetadata(leagueId){
   const seasonId=database.prepare('SELECT current_season_id FROM leagues WHERE id=?').get(leagueId)?.current_season_id??null;
   return {drafts:database.prepare('SELECT id,status,opened_at_ms AS openedAtMs FROM free_agent_drafts WHERE league_id=? AND season_id=? ORDER BY opened_at_ms').all(leagueId,seasonId),
    auctions:database.prepare("SELECT a.id,p.full_name AS playerName FROM auctions a JOIN players p ON p.id=a.player_id JOIN auction_contexts c ON c.league_id=a.league_id AND c.auction_id=a.id WHERE a.league_id=? AND a.season_id=? AND a.status='open' AND c.source_kind='ordinary_weekly' ORDER BY a.resolves_at_ms,a.id").all(leagueId,seasonId)};
  },
  history:leagueId=>database.prepare(`SELECT c.id,c.season_id AS seasonId,c.reason,c.created_at_ms AS createdAtMs,u.display_name AS actorName,
   c.before_json,c.after_json FROM league_calendar_changes c JOIN users u ON u.id=c.actor_user_id
   WHERE c.league_id=? ORDER BY c.created_at_ms DESC,c.id DESC LIMIT 25`).all(leagueId).map(({before_json,after_json,...row})=>({...row,before:JSON.parse(before_json),after:JSON.parse(after_json)})),
  replay:(leagueId,userId,key)=>database.prepare('SELECT id,request_hash FROM league_calendar_changes WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
  apply({state:s,plan:p,actorUserId,authority,clientKey,requestHash,nowMs}) {
   const id=crypto.randomUUID(),leagueId=s.league.id,seasonId=s.season.id;
   database.prepare(`INSERT INTO league_calendar_changes(id,league_id,season_id,actor_user_id,actor_authority,client_key,request_hash,reason,before_json,after_json,jobs_json,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,leagueId,seasonId,actorUserId,authority,clientKey,requestHash,p.proposed.reason,JSON.stringify(p.before),JSON.stringify(p.after),JSON.stringify(p.jobChanges),nowMs);
   const updateWeek=database.prepare('UPDATE matchup_weeks SET '+Object.values(WEEK_FIELDS).map(k=>k+'=?').join(',')+',updated_at_ms=?,version=version+1 WHERE league_id=? AND season_id=? AND id=? AND version=?');
   for(const change of p.changes) {
    const old=s.weeks.find(w=>w.id===change.id);
    if(updateWeek.run(...Object.keys(WEEK_FIELDS).map(k=>change.after[k]),Math.max(nowMs,old.updated_at_ms),leagueId,seasonId,old.id,old.version).changes!==1)fail('The week changed. Review again.');
   }
   const updateJob=database.prepare("UPDATE job_runs SET scheduled_for_ms=?,occurrence_key=?,next_attempt_at_ms=NULL,updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE league_id=? AND season_id=? AND id=? AND version=? AND status='pending' AND attempt_count=0 AND lease_owner IS NULL");
   for(const job of p.jobChanges)if(updateJob.run(job.scheduledForMs,job.occurrenceKey,nowMs,leagueId,seasonId,job.id,job.version).changes!==1)fail('A scheduled operation changed. Review again.');
   if(p.seasonFields.length&&database.prepare('UPDATE seasons SET '+Object.values(SEASON_FIELDS).map(k=>k+'=?').join(',')+',updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE league_id=? AND id=? AND version=?')
    .run(...Object.keys(SEASON_FIELDS).map(k=>p.proposed.calendar[k]),nowMs,leagueId,seasonId,s.season.version).changes!==1)fail('The season changed. Review again.');
   if(database.prepare('UPDATE leagues SET updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE id=? AND version=?').run(nowMs,leagueId,s.league.version).changes!==1)fail('The league changed. Review again.');
   const message='The commissioner updated the league calendar. Review matchup and playoff dates in the competition tools.';
   database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
    VALUES(?,?,?,'league_calendar_changed',?,?,'league',?,?,?,?,?)`).run(id,leagueId,seasonId,actorUserId,authority,leagueId,message,p.proposed.reason,JSON.stringify({changeId:id,changedWeekCount:p.changes.length,seasonFields:p.seasonFields}),nowMs);
   for(const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId))
    notifications.insert({id:crypto.randomUUID(),userId:user.id,leagueId,eventType:'league_calendar_changed',messageDataJson:JSON.stringify({leagueId,message}),relatedFeature:'league',relatedRecordId:leagueId,deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:'calendar:'+id+':'+user.id});
   outbox.write({id:crypto.randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,
    payload:createSocketEventMetadata({eventType:'league.changed',version:s.league.version+1,reasonCode:'league_changed',occurredAtMs:nowMs,related:createEmptySocketRelated()}),occurredAtMs:nowMs,audiences:[{kind:'league'}]});
   const dates=changedDates(p.before.calendar,p.after.calendar,{regularSeasonStartsAtMs:'Season starts',regularSeasonEndsAtMs:'Season ends',fantasyPlayoffsStartAtMs:'Playoffs start',fantasyPlayoffsEndAtMs:'Playoffs end'},s.league.timezone);
   const weekDates=p.changes.flatMap(w=>changedDates(w.before,w.after,{startsAtMs:'Week '+w.sequence+' starts',endsAtMs:'Week '+w.sequence+' ends',baselineAtMs:'Week '+w.sequence+' statistics baseline',locksAtMs:'Week '+w.sequence+' roster lock',rollsOverAtMs:'Week '+w.sequence+' rollover'},s.league.timezone));
   const allDates=[...dates,...weekDates],shown=allDates.slice(0,18);
   publishLeagueChangeAnnouncement(database,{id,leagueId,actorUserId,title:'League calendar changed',message:shown.join('\n')+(allDates.length>shown.length?'\n'+(allDates.length-shown.length)+' more date changes; review the league calendar.':''),reason:p.proposed.reason,nowMs});
      return {id};
  },
 };
}
module.exports={createSqliteLeagueCalendarRepository};
