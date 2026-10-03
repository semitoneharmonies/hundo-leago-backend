const {randomUUID}=require('node:crypto');
const core=require('../../../operations/guidedLeagueReset');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter}=require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated}=require('../../../domain/leagues/socketInvalidation');
function createSqliteGuidedLeagueResetRepository({database,leagueOutboxWriter}){
 const notifications=createSqliteNotificationWriter({database}),outbox=resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
 return {
  transaction:fn=>database.transaction(fn).immediate(),snapshot:fn=>database.transaction(fn)(),
  read(leagueId,nowMs){const league=database.prepare('SELECT id,name,status,current_season_id AS seasonId FROM leagues WHERE id=?').get(leagueId);if(!league)core.fail('The league was not found.','LEAGUE_RESET_NOT_FOUND');let blockedReason=null;try{core.eligibility(database,leagueId,nowMs);}catch(e){if(!e.code?.startsWith('LEAGUE_RESET_'))throw e;blockedReason=e.message;}
   const archives=database.prepare(`SELECT a.id,a.created_at_ms AS at,u.display_name AS actorName,a.manifest_json,EXISTS(SELECT 1 FROM league_reset_actions r WHERE r.league_id=a.league_id AND r.archive_id=a.id AND r.action_type='restore') AS restored
    FROM league_reset_archives a JOIN users u ON u.id=a.actor_user_id WHERE a.league_id=? ORDER BY a.created_at_ms DESC,a.id DESC LIMIT 20`).all(leagueId).map(a=>({id:a.id,at:a.at,actorName:a.actorName,restored:!!a.restored,manifest:JSON.parse(a.manifest_json)}));
   return {leagueId,league,blockedReason,archives};},
  rehearse:(leagueId,actorId,at)=>core.rehearse(database,leagueId,actorId,at),
  archive:(leagueId,id)=>database.prepare('SELECT * FROM league_reset_archives WHERE league_id=? AND id=?').get(leagueId,id),
  restored:(leagueId,id)=>!!database.prepare("SELECT 1 FROM league_reset_actions WHERE league_id=? AND archive_id=? AND action_type='restore'").get(leagueId,id),
  rehearseRestore:(snapshot,afterHash)=>core.rehearseRestore(database,snapshot,afterHash),
  replay:(leagueId,actorId,key)=>database.prepare('SELECT * FROM league_reset_actions WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,actorId,key),
  reset({review,archiveId,sealed,actor,at}){
   const leagueId=review.snapshot.leagueId;
   if(core.scopeHash(database,leagueId)!==review.beforeHash)core.fail('The league changed after review. Preview the reset again.');
   const afterHash=core.reset(database,leagueId,actor.actorUserId,at);
   if(afterHash!==review.afterHash)core.fail('The reset differs from its verified rehearsal.');
   database.prepare('INSERT INTO league_reset_archives(id,league_id,season_id,actor_user_id,schema_version,key_version,nonce,ciphertext,authentication_tag,manifest_json,before_hash,after_hash,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(archiveId,leagueId,review.snapshot.tables.leagues[0].current_season_id,actor.actorUserId,core.SCHEMA_VERSION,sealed.keyVersion,sealed.nonce,sealed.ciphertext,sealed.authenticationTag,JSON.stringify(review.manifest),review.beforeHash,afterHash,at);
  },
  restore({archive,snapshot}){
   if(core.scopeHash(database,archive.league_id)!==archive.after_hash)core.fail('The league changed after reset. Later work must be preserved.');
   const currentVersion=database.prepare('SELECT version FROM leagues WHERE id=?').get(archive.league_id).version;
   core.restore(database,snapshot);if(core.scopeHash(database,archive.league_id)!==archive.before_hash)core.fail('The recovered state does not match its archive.');
   // Restore gameplay values exactly, then retain a fresh league revision for client invalidation.
   database.prepare('UPDATE leagues SET version=max(version,?)+1 WHERE id=?').run(currentVersion,archive.league_id);
  },
  record({leagueId,archiveId,actor,action,key,requestHash,reason,at}){
   const id=randomUUID(),league=database.prepare('SELECT name,version,current_season_id AS seasonId FROM leagues WHERE id=?').get(leagueId);
   database.prepare('INSERT INTO league_reset_actions(id,league_id,archive_id,actor_user_id,actor_authority,action_type,client_key,request_hash,reason,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,leagueId,archiveId,actor.actorUserId,actor.authority,action,key,requestHash,reason,at);
   const message=action==='reset'?`${league.name} returned to preseason setup after a reviewed reset. Choose new dates before starting again.`:`${league.name} was restored from its verified preseason reset archive. Competition remains paused for review.`;
   database.prepare("INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms) VALUES(?,?,?,'league_preseason_reset',?,?,'league',?,?,?,?,?)").run(id,leagueId,league.seasonId,actor.actorUserId,actor.authority,leagueId,message,reason,JSON.stringify({archiveId,action}),at);
   for(const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId))notifications.insert({id:randomUUID(),userId:user.id,leagueId,eventType:'league_preseason_reset',messageDataJson:JSON.stringify({leagueId,message}),relatedFeature:'league',relatedRecordId:leagueId,deliveryStatus:'delivered',createdAtMs:at,deliveredAtMs:at,deduplicationKey:'league-reset:'+id+':'+user.id});
   outbox.write({id:randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,payload:createSocketEventMetadata({eventType:'league.changed',version:league.version,reasonCode:'league_changed',occurredAtMs:at,related:createEmptySocketRelated()}),occurredAtMs:at,audiences:[{kind:'league'}]});
   return {leagueId,id,archiveId,action,replayed:false,recoveryVerified:true};
  },
 };
}
module.exports={createSqliteGuidedLeagueResetRepository};
