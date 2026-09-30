const {randomUUID}=require('node:crypto');
const {digest}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter}=require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated}=require('../../../domain/leagues/socketInvalidation');
const fail=(message,code='CORRECTION_REVERSAL_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
function rosterSnapshot(p){return p?{id:p.id,leagueId:p.league_id,seasonId:p.season_id,playerId:p.player_id,teamId:p.team_id,ownershipKind:p.ownership_kind,rosterCategory:p.roster_category,positionGroup:p.position_group,slotNumber:p.slot_number,version:p.version}:null;}
function createSqliteCorrectionReversalRepository({database,leagueOutboxWriter}){
 const notifications=createSqliteNotificationWriter({database}),outbox=resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
 function state(leagueId,id){
  const source=database.prepare('SELECT * FROM commissioner_corrections WHERE league_id=? AND id=?').get(leagueId,id);
  if(!source||!['roster','contract'].includes(source.feature))fail('Choose a roster or contract correction from this league.');
  if(database.prepare("SELECT 1 FROM league_management_actions WHERE league_id=? AND action_type='reverse_correction' AND target_id=?").get(leagueId,id))fail('This correction was already reversed.');
  const before=JSON.parse(source.before_snapshot_json),after=JSON.parse(source.after_snapshot_json).authoritative;
  const league=database.prepare('SELECT * FROM leagues WHERE id=?').get(leagueId);
  if(!before||!after||before.playerId!==after.playerId||league.current_season_id!==source.season_id||before.leagueId!==leagueId||after.leagueId!==leagueId)fail('The original correction is outside the current season.');
  const ownership=database.prepare('SELECT * FROM player_ownerships WHERE league_id=? AND player_id=?').get(leagueId,after.playerId);
  let current;
  if(source.feature==='roster')current=rosterSnapshot(ownership);
  else {
   const p=database.prepare('SELECT * FROM contracts WHERE league_id=? AND id=?').get(leagueId,after.id);
   const years=database.prepare('SELECT id,season_id AS seasonId,year_number AS yearNumber,aav_cents AS aavCents,status,rollover_at_ms AS rolloverAtMs FROM contract_years WHERE league_id=? AND contract_id=? ORDER BY year_number').all(leagueId,after.id);
   current=p?{id:p.id,leagueId:p.league_id,playerId:p.player_id,teamId:p.current_team_id,contractType:p.contract_type,originalTotalValueCents:p.original_total_value_cents,originalTermYears:p.original_term_years,aavCents:p.aav_cents,startSeasonId:p.start_season_id,status:p.status,auctionBuyoutLockExpiresAtMs:p.auction_buyout_lock_expires_at_ms,years,version:p.version}:null;
   if(!ownership||ownership.team_id!==after.teamId||ownership.season_id!==source.season_id)fail('Ownership changed after this correction.');
  }
  if(!current||digest(current)!==digest(after))fail('The player changed after this correction. Use a new reviewed correction instead.');
  for(const table of ['ownership_events','contract_events'])if(database.prepare(`SELECT 1 FROM ${table} WHERE league_id=? AND player_id=? AND occurred_at_ms>=? AND coalesce(source_id,'')<>? LIMIT 1`).get(leagueId,after.playerId,source.corrected_at_ms,id))fail('A later player transaction prevents reversal.');
  const privateState={};
  for(const table of ['league_settings','seasons','teams','player_ownerships','contracts','contract_years','retention_obligations','buyout_obligations','trades','trade_assets','matchup_roster_locks','matchup_results']){
   privateState[table]=database.prepare(`SELECT * FROM ${table} WHERE league_id=? ORDER BY rowid`).all(leagueId);
  }
  const player=database.prepare('SELECT id,full_name,version FROM players WHERE id=?').get(after.playerId);
  return {source,before,after,league,ownership,player,privateState};
 }
 return {transaction:fn=>database.transaction(fn).immediate(),snapshot:fn=>database.transaction(fn)(),state,
  list(leagueId){return database.prepare(`SELECT c.id,c.feature,c.corrected_at_ms AS at,c.reason,u.display_name AS actorName,
   coalesce(p.full_name,'Player') AS playerName,EXISTS(SELECT 1 FROM league_management_actions a WHERE a.league_id=c.league_id AND a.action_type='reverse_correction' AND a.target_id=c.id) AS reversed
   FROM commissioner_corrections c JOIN users u ON u.id=c.actor_user_id LEFT JOIN players p ON p.id=json_extract(c.before_snapshot_json,'$.playerId')
   WHERE c.league_id=? AND c.feature IN ('roster','contract') ORDER BY c.corrected_at_ms DESC,c.id DESC LIMIT 100`).all(leagueId);},
  replay:(leagueId,actorId,key)=>database.prepare('SELECT * FROM league_management_actions WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,actorId,key),
  record({state:s,actor,reason,key,requestHash,result,at}){
   const id=randomUUID(),leagueId=s.league.id;
   database.prepare(`INSERT INTO league_management_actions(id,league_id,season_id,actor_user_id,actor_authority,action_type,target_id,client_key,request_hash,reason,before_json,after_json,created_at_ms)
    VALUES(?,?,?,?,?,'reverse_correction',?,?,?,?,?,?,?)`).run(id,leagueId,s.source.season_id,actor.actorUserId,actor.authority,s.source.id,key,requestHash,reason,JSON.stringify(s.after),JSON.stringify({correctionId:result.correction.id,values:result.authoritative}),at);
   database.prepare('UPDATE leagues SET version=version+1,updated_at_ms=max(updated_at_ms,?) WHERE id=?').run(at,leagueId);
   const message=`${s.player.full_name}: an earlier ${s.source.feature} correction was reversed after review.`;
   for(const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId))notifications.insert({id:randomUUID(),userId:user.id,leagueId,eventType:'league_correction_reversed',messageDataJson:JSON.stringify({leagueId,message}),relatedFeature:'league',relatedRecordId:leagueId,deliveryStatus:'delivered',createdAtMs:at,deliveredAtMs:at,deduplicationKey:'reversal:'+id+':'+user.id});
   outbox.write({id:randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,payload:createSocketEventMetadata({eventType:'league.changed',version:s.league.version+1,reasonCode:'league_changed',occurredAtMs:at,related:createEmptySocketRelated()}),occurredAtMs:at,audiences:[{kind:'league'}]});
   return {leagueId,id,correctionId:result.correction.id,replayed:false};
  },
 };
}
module.exports={createSqliteCorrectionReversalRepository,fail};
