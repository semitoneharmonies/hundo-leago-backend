const {createHash,randomUUID}=require('node:crypto');
const {createSqlitePlayerCatalogRepository}=require('./SqlitePlayerCatalogRepository');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function createSqlitePlayerCatalogueControlRepository({database,nowMs=Date.now}){
 const enabled=database.pragma('user_version',{simple:true})>=86;
 function available(){if(!enabled)fail('CATALOGUE_UNAVAILABLE');}
 const catalog=createSqlitePlayerCatalogRepository({database,now:nowMs});
 function preview(row){
  available();
  const matches=database.prepare("SELECT p.* FROM players p JOIN player_external_ids e ON e.player_id=p.id WHERE e.provider='nhl' AND e.external_value=?").all(row.providerPlayerId);
  if(matches.length>1)fail('CATALOGUE_IDENTITY_CONFLICT');
  const p=matches[0]||null;
  const possibleDuplicates=p?[]:database.prepare("SELECT id,full_name AS name FROM players WHERE lower(full_name)=lower(?) OR (birth_date=? AND lower(last_name)=lower(?)) ORDER BY id LIMIT 21").all(row.fullName,row.birthDate,row.lastName);
  if(possibleDuplicates.length)fail('CATALOGUE_IDENTITY_CONFLICT');
  const sources=p?database.prepare('SELECT * FROM player_source_state WHERE player_id=? AND ended_at_ms IS NULL ORDER BY provider,id').all(p.id):[];
  const holdings=p?database.prepare('SELECT league_id,season_id,id,team_id,version FROM player_ownerships WHERE player_id=? ORDER BY league_id,season_id,id').all(p.id):[];
  const drafts=database.prepare("SELECT id,league_id,status,version FROM free_agent_drafts WHERE status NOT IN ('completed','cancelled') ORDER BY league_id,id").all();
  const before=p?{playerId:p.id,name:p.full_name,birthDate:p.birth_date,status:p.status,version:p.version,sources:sources.map(s=>({provider:s.provider,position:s.normalized_position,team:s.nhl_team_abbreviation,active:!!s.active}))}:null;
  return {nhlId:row.providerPlayerId,action:p?'refresh':'import',before,after:{name:row.fullName,birthDate:row.birthDate,status:row.status,position:row.normalizedPosition,team:row.nhlTeamAbbreviation},
   ownedInLeagues:new Set(holdings.map(h=>h.league_id)).size,openDrafts: drafts.length,
   previewHash:hash({row,p,sources,holdings,drafts}),preserved:['Existing player identity and external IDs','League ownerships and contracts','Saved bids, cards, results and history'],
   notice:'A position or active-status change can queue the existing Candidate Card eligibility checks. League-specific position overrides remain in effect.'};
 }
 function replay(command){
  available();
  const e=database.prepare('SELECT * FROM operational_events WHERE id=?').get(command.operationId);
  if(!e)return null;
  if(e.event_type!=='administrator_catalogue_change'||e.actor_user_id!==command.actorId)fail('CATALOGUE_RETRY_CONFLICT');
  const details=JSON.parse(e.details_json);
  if(details.requestHash!==hash(command))fail('CATALOGUE_RETRY_CONFLICT');
  return {...details.result,replayed:true};
 }
 return {snapshot:fn=>{available();return database.transaction(fn)();},preview,replay,
  search(query){return database.prepare("SELECT p.id,p.full_name AS name,p.status,e.external_value AS nhlId FROM players p LEFT JOIN player_external_ids e ON e.player_id=p.id AND e.provider='nhl' WHERE instr(lower(p.full_name),lower(?))>0 OR e.external_value=? ORDER BY p.full_name,p.id LIMIT 50").all(query,query);},
  history(){return database.prepare("SELECT e.id,u.display_name AS actorName,e.occurred_at_ms AS at,e.details_json FROM operational_events e JOIN users u ON u.id=e.actor_user_id WHERE e.event_type='administrator_catalogue_change' ORDER BY e.occurred_at_ms DESC,e.id DESC LIMIT 30").all().map(e=>{const d=JSON.parse(e.details_json);return {id:e.id,actorName:e.actorName,at:e.at,reason:d.reason,before:d.before,after:d.after};});},
  apply(command,row,authorize){return database.transaction(()=>{
   authorize();const prior=replay(command);if(prior)return prior;
   const reviewed=preview(row);if(reviewed.previewHash!==command.previewHash)fail('CATALOGUE_PREVIEW_CHANGED');
   const at=nowMs(), result=catalog.applyCatalog({sourceOperationId:randomUUID(),provider:'nhl',capturedAtMs:at,rows:[{...row,sourceUpdatedAtMs:at}]});
   const player=database.prepare("SELECT player_id FROM player_external_ids WHERE provider='nhl' AND external_value=?").get(row.providerPlayerId);
   const response={operationId:command.operationId,playerId:player.player_id,action:reviewed.action,createdPlayerCount:result.createdPlayerCount,updatedPlayerCount:result.updatedPlayerCount,revalidationOccurrenceCount:result.revalidationOccurrenceCount,replayed:false};
   database.prepare("INSERT INTO operational_events(id,league_id,season_id,event_type,feature,outcome,actor_user_id,reason_code,details_json,occurred_at_ms) VALUES(?,NULL,NULL,'administrator_catalogue_change','player_catalogue','succeeded',?,'reviewed_player_refresh',?,?)")
    .run(command.operationId,command.actorId,JSON.stringify({requestHash:hash(command),reason:command.reason,before:reviewed.before,after:reviewed.after,result:response}),at);
   return response;
  }).immediate();},
 };
}
module.exports={createSqlitePlayerCatalogueControlRepository};
