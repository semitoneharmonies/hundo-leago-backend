const crypto=require('node:crypto');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter}=require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated}=require('../../../domain/leagues/socketInvalidation');
function createSqliteLeaguePauseRepository({database,leagueOutboxWriter}){
  const notifications=createSqliteNotificationWriter({database}),outbox=resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
  return {
    transaction:fn=>database.transaction(fn).immediate(),
    status(leagueId){
      const league=database.prepare('SELECT id,status FROM leagues WHERE id=?').get(leagueId);
      const freeze=database.prepare("SELECT frozen_at_ms AS since FROM league_freezes WHERE league_id=? AND status='active'").get(leagueId);
      return {leagueId,paused:league.status==='frozen',since:freeze?.since??null,scope:'Manager transactions and league competition processing',deadlineBehavior:'Saved deadlines do not move. Due work is reviewed before resuming.'};
    },
    state(leagueId){
      const league=database.prepare('SELECT id,status,current_season_id AS seasonId,version FROM leagues WHERE id=?').get(leagueId);
      const freeze=database.prepare("SELECT * FROM league_freezes WHERE league_id=? AND status='active'").get(leagueId)||null;
      const receipt=freeze?database.prepare("SELECT before_json FROM league_management_actions WHERE league_id=? AND target_id=? AND action_type='pause'").get(leagueId,freeze.id):null;
      return {league,freeze,originalStatus:receipt?JSON.parse(receipt.before_json).status:null,
        busyJobs:database.prepare("SELECT id,version,status FROM job_runs WHERE league_id=? AND status IN ('leased','running') ORDER BY id").all(leagueId),
        jobs:database.prepare("SELECT id,job_type AS type,status,scheduled_for_ms AS scheduledForMs,next_attempt_at_ms AS nextAttemptAtMs,version FROM job_runs WHERE league_id=? AND status IN ('pending','failed') ORDER BY id").all(leagueId),
        auctions:database.prepare("SELECT id,resolves_at_ms AS resolvesAtMs,version FROM auctions WHERE league_id=? AND status='open' ORDER BY id").all(leagueId),
        proposals:database.prepare("SELECT id,effective_deadline_at_ms AS deadlineAtMs,version FROM trades WHERE league_id=? AND status='proposed' AND effective_deadline_at_ms IS NOT NULL ORDER BY id").all(leagueId),
      };
    },
    replay:(leagueId,userId,key)=>database.prepare('SELECT id,action_type,request_hash FROM league_management_actions WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
    apply({state:s,plan:p,actorUserId,authority,clientKey,requestHash,nowMs}){
      const id=crypto.randomUUID(),leagueId=s.league.id,freezeId=s.freeze?.id||crypto.randomUUID(),status=p.proposed.action==='pause'?'frozen':s.originalStatus;
      if(p.proposed.action==='pause')database.prepare("INSERT INTO league_freezes(id,league_id,actor_user_id,status,reason,frozen_at_ms,ended_at_ms,ended_by_user_id,version) VALUES(?,?,?,'active',?,?,NULL,NULL,1)").run(freezeId,leagueId,actorUserId,p.proposed.reason,nowMs);
      else database.prepare("UPDATE league_freezes SET status='ended',ended_at_ms=?,ended_by_user_id=?,version=version+1 WHERE league_id=? AND id=? AND status='active'").run(nowMs,actorUserId,leagueId,freezeId);
      database.prepare('UPDATE leagues SET status=?,version=version+1,updated_at_ms=max(updated_at_ms,?) WHERE id=?').run(status,nowMs,leagueId);
      database.prepare(`INSERT INTO league_management_actions(id,league_id,season_id,actor_user_id,actor_authority,action_type,target_id,client_key,request_hash,reason,before_json,after_json,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,leagueId,s.league.seasonId,actorUserId,authority,p.proposed.action,freezeId,clientKey,requestHash,p.proposed.reason,
          JSON.stringify({status:s.league.status}),JSON.stringify({status,scope:'competition',deadlineBehavior:'retain_saved_times',impacts:p.impacts}),nowMs);
      const message=p.proposed.action==='pause'?'League competition is paused. Saved deadlines are unchanged.':'League competition has resumed. Saved deadlines apply; overdue work can now process.';
      database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
        VALUES(?,?,?,'league_pause_changed',?,?,'league',?,?,?,?,?)`).run(id,leagueId,s.league.seasonId,actorUserId,authority,leagueId,message,p.proposed.reason,JSON.stringify({changeId:id,action:p.proposed.action}),nowMs);
      for(const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId))
        notifications.insert({id:crypto.randomUUID(),userId:user.id,leagueId,eventType:'league_pause_changed',messageDataJson:JSON.stringify({leagueId,message}),relatedFeature:'league',relatedRecordId:leagueId,
          deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:'pause:'+id+':'+user.id});
      outbox.write({id:crypto.randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,payload:createSocketEventMetadata({eventType:'league.changed',version:s.league.version+1,
        reasonCode:'league_changed',occurredAtMs:nowMs,related:createEmptySocketRelated()}),occurredAtMs:nowMs,audiences:[{kind:'league'}]});
      return {id};
    },
  };
}
module.exports={createSqliteLeaguePauseRepository};
