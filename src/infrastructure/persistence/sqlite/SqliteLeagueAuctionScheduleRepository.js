const crypto=require('node:crypto');
const {fail,settings}=require('../../../domain/leagues/leagueAuctionSchedulePolicy');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter}=require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated}=require('../../../domain/leagues/socketInvalidation');
function createSqliteLeagueAuctionScheduleRepository({database,leagueOutboxWriter,stagingDailyAuctionsEnabled=false}){
 const notifications=createSqliteNotificationWriter({database}),outbox=resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
 return{
  transaction:fn=>database.transaction(fn).immediate(),
  state(leagueId){const league=database.prepare('SELECT id,status,timezone,current_season_id,version,updated_at_ms FROM leagues WHERE id=?').get(leagueId);
   if(!league)fail('The league was not found.','LEAGUE_NOT_FOUND');
   return{league,current:database.prepare('SELECT * FROM league_auction_schedule_changes WHERE league_id=? ORDER BY revision DESC LIMIT 1').get(leagueId)||null,
    stagingDaily:stagingDailyAuctionsEnabled,openAuctionCount:database.prepare("SELECT count(*) n FROM auctions a JOIN auction_contexts c ON c.league_id=a.league_id AND c.auction_id=a.id WHERE a.league_id=? AND a.status='open' AND c.source_kind='ordinary_weekly'").get(leagueId).n};},
  history:leagueId=>database.prepare(`SELECT c.id,c.revision,c.close_weekday AS closeWeekday,c.close_minute_of_day AS closeMinuteOfDay,c.creation_cutoff_minutes AS creationCutoffMinutes,
   c.reason,c.created_at_ms AS createdAtMs,u.display_name AS actorName FROM league_auction_schedule_changes c JOIN users u ON u.id=c.actor_user_id WHERE c.league_id=? ORDER BY c.revision DESC LIMIT 25`).all(leagueId),
  replay:(leagueId,userId,key)=>database.prepare('SELECT id,request_hash FROM league_auction_schedule_changes WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
  apply({state:s,proposed:p,actorUserId,authority,clientKey,requestHash,nowMs}){
   const id=crypto.randomUUID(),leagueId=s.league.id;
   database.prepare(`INSERT INTO league_auction_schedule_changes(id,league_id,actor_user_id,actor_authority,revision,close_weekday,close_minute_of_day,creation_cutoff_minutes,client_key,request_hash,reason,before_json,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,leagueId,actorUserId,authority,(s.current?.revision||0)+1,p.closeWeekday,p.closeMinuteOfDay,p.creationCutoffMinutes,clientKey,requestHash,p.reason,JSON.stringify({schedule:settings(s.current),legacyDaily:s.stagingDaily&&!s.current}),nowMs);
   if(database.prepare('UPDATE leagues SET updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE id=? AND version=?').run(nowMs,leagueId,s.league.version).changes!==1)fail('The league changed. Review again.');
   const days=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
   const display=days[p.closeWeekday]+' '+String(Math.floor(p.closeMinuteOfDay/60)).padStart(2,'0')+':'+String(p.closeMinuteOfDay%60).padStart(2,'0');
   const message='New in-season auctions close '+display+' ('+s.league.timezone+'). New auctions stop '+p.creationCutoffMinutes+' minutes before closing. Existing auctions keep their saved times.';
   database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
    VALUES(?,?,?,'league_auction_schedule_changed',?,?,'league',?,?,?,?,?)`).run(id,leagueId,s.league.current_season_id,actorUserId,authority,leagueId,message,p.reason,JSON.stringify({changeId:id,closeWeekday:p.closeWeekday,closeMinuteOfDay:p.closeMinuteOfDay,creationCutoffMinutes:p.creationCutoffMinutes}),nowMs);
   for(const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId))
    notifications.insert({id:crypto.randomUUID(),userId:user.id,leagueId,eventType:'league_auction_schedule_changed',messageDataJson:JSON.stringify({leagueId,message}),relatedFeature:'league',relatedRecordId:leagueId,deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:'auction-schedule:'+id+':'+user.id});
   outbox.write({id:crypto.randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,payload:createSocketEventMetadata({
    eventType:'league.changed',version:s.league.version+1,reasonCode:'league_changed',occurredAtMs:nowMs,related:createEmptySocketRelated()}),occurredAtMs:nowMs,audiences:[{kind:'league'}]});
   return{id};
  },
 };
}
module.exports={createSqliteLeagueAuctionScheduleRepository};

