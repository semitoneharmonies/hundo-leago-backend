const crypto=require('node:crypto');
const {fail}=require('../../../domain/leagues/tradeDeadlineChangePolicy');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter}=require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated}=require('../../../domain/leagues/socketInvalidation');
function createSqliteTradeDeadlineChangeRepository({database,leagueOutboxWriter}){
  const notifications=createSqliteNotificationWriter({database}),outbox=resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
  return{
    transaction:fn=>database.transaction(fn).immediate(),
    state(leagueId){
      const league=database.prepare('SELECT id,status,timezone,current_season_id,updated_at_ms,version FROM leagues WHERE id=?').get(leagueId);
      if(!league)fail('LEAGUE_NOT_FOUND');
      return{league,settings:database.prepare('SELECT trade_deadline_at_ms,updated_at_ms,version FROM league_settings WHERE league_id=?').get(leagueId)||null,
        season:database.prepare('SELECT id,status,version FROM seasons WHERE league_id=? AND id=?').get(leagueId,league.current_season_id)||null,
        // Only proposal timing is read. Assets, participants and offers stay private.
        proposals:database.prepare(`SELECT id,season_id,status,proposal_model_version,created_at_ms,expires_at_ms,effective_deadline_at_ms,updated_at_ms,version
          FROM trades WHERE league_id=? AND season_id=? AND status='proposed' ORDER BY id`).all(leagueId,league.current_season_id)};
    },
    history:leagueId=>database.prepare(`SELECT c.id,c.previous_deadline_at_ms AS previousDeadlineAtMs,c.deadline_at_ms AS tradeDeadlineAtMs,
      c.reason,c.created_at_ms AS createdAtMs,u.display_name AS actorName FROM league_trade_deadline_changes c JOIN users u ON u.id=c.actor_user_id
      WHERE c.league_id=? ORDER BY c.created_at_ms DESC,c.id DESC LIMIT 25`).all(leagueId),
    replay:(leagueId,userId,key)=>database.prepare('SELECT id,request_hash FROM league_trade_deadline_changes WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
    apply({state:s,plan:p,actorUserId,authority,clientKey,requestHash,nowMs}){
      const id=crypto.randomUUID(),leagueId=s.league.id;
      database.prepare(`INSERT INTO league_trade_deadline_changes(id,league_id,season_id,actor_user_id,actor_authority,client_key,request_hash,reason,
        previous_deadline_at_ms,deadline_at_ms,previous_settings_version,settings_version,before_proposals_json,after_proposals_json,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,leagueId,s.league.current_season_id,actorUserId,authority,clientKey,requestHash,p.proposed.reason,
          s.settings.trade_deadline_at_ms,p.proposed.tradeDeadlineAtMs,s.settings.version,s.settings.version+1,JSON.stringify(p.before),JSON.stringify(p.after),nowMs);
      const update=database.prepare(`UPDATE trades SET effective_deadline_at_ms=?,updated_at_ms=?,version=?
        WHERE league_id=? AND season_id=? AND id=? AND status='proposed' AND version=? AND effective_deadline_at_ms=?`);
      for(const [i,row]of p.after.entries())if(update.run(row.effective_deadline_at_ms,row.updated_at_ms,row.version,leagueId,s.league.current_season_id,row.id,p.before[i].version,p.before[i].effective_deadline_at_ms).changes!==1)fail();
      if(database.prepare('UPDATE league_settings SET trade_deadline_at_ms=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND version=?')
        .run(p.proposed.tradeDeadlineAtMs,Math.max(nowMs,s.settings.updated_at_ms),leagueId,s.settings.version).changes!==1)fail();
      if(database.prepare('UPDATE leagues SET updated_at_ms=?,version=version+1 WHERE id=? AND version=?')
        .run(Math.max(nowMs,s.league.updated_at_ms),leagueId,s.league.version).changes!==1)fail();
      const display=new Intl.DateTimeFormat('en-CA',{timeZone:s.league.timezone,dateStyle:'long',timeStyle:'long'}).format(p.proposed.tradeDeadlineAtMs);
      const message=`The league trade deadline is now ${display}. Still-open proposals keep their seven-day expiry limit. Expired offers remain expired.`;
      database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
        VALUES(?,?,?,'league_trade_deadline_changed',?,?,'league',?,?,?,?,?)`).run(id,leagueId,s.league.current_season_id,actorUserId,authority,leagueId,message,p.proposed.reason,
          JSON.stringify({changeId:id,previousDeadlineAtMs:s.settings.trade_deadline_at_ms,tradeDeadlineAtMs:p.proposed.tradeDeadlineAtMs}),nowMs);
      for(const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId))notifications.insert({
        id:crypto.randomUUID(),userId:user.id,leagueId,eventType:'league_trade_deadline_changed',messageDataJson:JSON.stringify({leagueId,message,tradeDeadlineAtMs:p.proposed.tradeDeadlineAtMs}),
        relatedFeature:'league',relatedRecordId:leagueId,deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:`trade-deadline:${id}:${user.id}`});
      outbox.write({id:crypto.randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,
        payload:createSocketEventMetadata({eventType:'league.changed',version:s.league.version+1,reasonCode:'league_changed',occurredAtMs:nowMs,related:createEmptySocketRelated()}),
        occurredAtMs:nowMs,audiences:[{kind:'league'}]});
      return{id};
    },
  };
}
module.exports={createSqliteTradeDeadlineChangeRepository};
