'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const Database=require('better-sqlite3');
// Reset archive format is 88: schema 89 adds global quotes, which reset preserves.
const SCHEMA_VERSION=88;
const CLEAR_TABLES=Object.freeze([
 'auction_administration_command_results','auction_bids','auction_contexts','auction_events','auction_resolutions','auction_timing_changes','auctions',
 'buyout_obligations','buyout_years','candidate_card_entries','candidate_card_help_command_results','candidate_card_help_requests',
 'candidate_card_revision_entry_changes','candidate_card_revisions','candidate_card_snapshot_entries','candidate_card_snapshots','candidate_cards',
 'commissioner_corrections','contract_events','contract_years','contracts','fad_auction_clock_changes','fad_auction_cutoff_changes','fad_auction_cutoff_settings',
 'fad_deadline_commands','fad_deadline_controls','fad_timing_changes','free_agent_draft_allocation_correction_command_results','free_agent_draft_allocation_events',
 'free_agent_draft_auction_participants','free_agent_draft_draws','free_agent_draft_eligibility_revalidation_occurrences','free_agent_draft_nomination_queue',
 'free_agent_draft_player_allocations','free_agent_draft_readiness_attempts','free_agent_draft_readiness_corrective_requeues','free_agent_draft_readiness_operations',
 'free_agent_draft_readiness_retry_receipts','free_agent_draft_recoveries','free_agent_draft_recovery_action_command_results','free_agent_draft_rollovers',
 'free_agent_draft_schedule_recoveries','free_agent_draft_schedule_recovery_jobs','free_agent_draft_schedule_recovery_matchups','free_agent_draft_schedule_recovery_weeks',
 'free_agent_draft_setup_exemptions','free_agent_draft_teams','free_agent_drafts','future_considerations','job_runs','league_private_reveals',
 'matchup_byes','matchup_operations','matchup_result_versions','matchup_results','matchup_roster_game_exclusion_sets','matchup_roster_game_exclusions',
 'matchup_roster_locks','matchup_roster_players','matchup_schedule_command_results','matchup_schedule_job_bindings','matchup_weeks','matchups',
 'nhl_game_state_observation_snapshots','nhl_game_state_observations','ownership_events','player_ownerships','retention_obligations','retention_years',
 'roster_display_order_entries','roster_display_order_sets','season_matchup_schedule_generations','standings_operations','standings_rows',
 'standings_snapshot_finalizations','standings_snapshot_result_versions','standings_snapshot_team_identities','standings_snapshots','stat_snapshot_players','stat_snapshots',
 'trade_assets','trade_events','trade_future_consideration_acceptances','trade_participants','trades',
]);
const CHANGED_TABLES=Object.freeze([...CLEAR_TABLES,'league_freezes','league_settings','leagues','seasons','teams'].sort());
const WITNESS_TABLES=Object.freeze(['league_invitations','league_memberships','league_player_positions','team_manager_assignments']);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const fail=(message,code='LEAGUE_RESET_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Buffer.isBuffer(value)?{$binary:value.toString('base64')}:value]));
const decode=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value&&typeof value==='object'&&Object.keys(value).join()==='$binary'?Buffer.from(value.$binary,'base64'):value]));
function validateDatabase(db){
 if(![88,89].includes(db.pragma('user_version',{simple:true}))||db.pragma('foreign_keys',{simple:true})!==1)fail('This schema needs reset compatibility review.','LEAGUE_RESET_UNAVAILABLE');
}
function rows(db,table,leagueId){return db.prepare(`SELECT * FROM ${quote(table)} WHERE ${table==='leagues'?'id':'league_id'}=? ORDER BY rowid`).all(leagueId).map(encode);}
function capture(db,leagueId){validateDatabase(db);return {schemaVersion:SCHEMA_VERSION,leagueId,tables:Object.fromEntries(CHANGED_TABLES.map(t=>[t,rows(db,t,leagueId)]))};}
function scopeHash(db,leagueId){return hash({snapshot:capture(db,leagueId),witnesses:Object.fromEntries(WITNESS_TABLES.map(t=>[t,rows(db,t,leagueId)]))});}
function protectedFingerprint(db,leagueId){
 const result={};
 for(const {name}of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
  const changed=CHANGED_TABLES.includes(name),condition=changed?` WHERE ${name==='leagues'?'id':'league_id'} IS NOT ?`:'';
  const statement=db.prepare(`SELECT * FROM ${quote(name)}${condition} ORDER BY rowid`),digest=createHash('sha256');let count=0;
  for(const row of changed?statement.iterate(leagueId):statement.iterate()){digest.update(JSON.stringify(encode(row)));count++;}
  result[name]={count,hash:digest.digest('hex')};
 }
 return result;
}
function schemaObjects(db){return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all();}
function eligibility(db,leagueId,nowMs){
 validateDatabase(db);const league=db.prepare('SELECT * FROM leagues WHERE id=?').get(leagueId);
 if(!league)fail('The league was not found.','LEAGUE_RESET_NOT_FOUND');
 if(league.status!=='frozen')fail('Pause the league before reviewing a preseason reset.');
 if(db.prepare("SELECT count(*) n FROM league_freezes WHERE league_id=? AND status='active'").get(leagueId).n!==1)fail('The league pause needs recovery before a reset.');
 const seasons=db.prepare('SELECT * FROM seasons WHERE league_id=? ORDER BY nhl_season_key').all(leagueId),season=seasons.find(s=>s.id===league.current_season_id);
 if(!season||!['planned','active'].includes(season.status)||seasons.some(s=>s.id!==season.id&&(s.status!=='planned'||s.nhl_season_key<=season.nhl_season_key)))fail('Only a league without a played prior season can restart preseason setup.');
 const firstWeek=db.prepare('SELECT min(starts_at_ms) AS startsAtMs FROM matchup_weeks WHERE league_id=? AND season_id=?').get(leagueId,season.id);
 if(firstWeek.startsAtMs!==null&&firstWeek.startsAtMs<=nowMs)fail('The first matchup has begun. Use the specific correction and recovery tools.');
 for(const table of ['matchup_results','matchup_roster_locks','standings_snapshot_finalizations','entry_drafts','season_rollovers','season_rollover_occurrences','migration_reports'])if(db.prepare(`SELECT 1 FROM ${table} WHERE league_id=? LIMIT 1`).get(leagueId))fail('Played, locked, entry-draft or prior-season records prevent a preseason reset.');
 if(db.prepare("SELECT 1 FROM job_runs WHERE league_id=? AND status IN ('running','leased') LIMIT 1").get(leagueId))fail('A league job still holds a lease. Finish its supported recovery before resetting.');
 if(db.prepare("SELECT 1 FROM outbox_events WHERE league_id=? AND status IN ('pending','publishing','failed') LIMIT 1").get(leagueId))fail('League deliveries must finish before resetting. Refresh after the delivery queue clears.');
 if(db.prepare("SELECT 1 FROM idempotency_requests WHERE league_id=? AND status='started' LIMIT 1").get(leagueId))fail('An unfinished league request needs recovery first.');
 if(db.prepare("SELECT 1 FROM teams WHERE league_id=? AND status NOT IN ('active','setup','erased') LIMIT 1").get(leagueId))fail('Review inactive teams before returning the league to setup.');
 if(!db.prepare('SELECT 1 FROM free_agent_drafts WHERE league_id=? LIMIT 1').get(leagueId))fail('There is no existing Free Agent Draft to restart.');
 return {league,season};
}
function manifest(snapshot,league){
 const groups=[['Candidate Cards',['candidate_cards']],['Saved Candidate Card entries',['candidate_card_entries']],['Auctions',['auctions']],['Saved bids',['auction_bids']],['Roster ownerships',['player_ownerships']],['Contracts',['contracts']],['Trades',['trades']],['Buyout and retention obligations',['buyout_obligations','retention_obligations']],['Scheduled matchup weeks',['matchup_weeks']],['League jobs',['job_runs']]];
 return {leagueId:league.id,leagueName:league.name,scope:'Restart preseason setup',clear:groups.map(([label,tables])=>({label,count:tables.reduce((n,t)=>n+snapshot.tables[t].length,0)})),
  preserved:['League identity and name','Manager accounts, membership and team access','Team names, colours and logos','Scoring and recurring auction rules','Announcements, help requests and the league activity timeline','Other leagues and all global player information'],
  preparation:'League and teams return to setup. Current-season dates and the trade deadline become unset; unused future seasons are removed. Choose new dates through the existing setup controls, then start the league.',
  recovery:'An encrypted archive retains the cleared records. Restore is available only while the affected state and manager-access records still match the completed reset.'};
}
function rewrite(db,leagueId,operation){
 assert.equal(db.inTransaction,true,'RESET_REQUIRES_ATOMIC_TRANSACTION');
 const schema=schemaObjects(db),protectedBefore=protectedFingerprint(db,leagueId),guards=schema.filter(o=>o.type==='trigger'&&CHANGED_TABLES.includes(o.tbl_name));
 db.pragma('defer_foreign_keys=ON');for(const guard of guards)db.exec('DROP TRIGGER '+quote(guard.name));
 operation();for(const guard of guards)db.exec(guard.sql);
 assert.deepEqual(schemaObjects(db),schema,'RESET_SCHEMA_CHANGED');assert.deepEqual(db.pragma('foreign_key_check'),[],'RESET_REFERENCE_CONFLICT');
 assert.deepEqual(protectedFingerprint(db,leagueId),protectedBefore,'RESET_PROTECTED_RECORD_CHANGED');
}
function reset(db,leagueId,actorId,nowMs){
 const {league,season}=eligibility(db,leagueId,nowMs);
 rewrite(db,leagueId,()=>{
  for(const table of CLEAR_TABLES)db.prepare(`DELETE FROM ${quote(table)} WHERE league_id=?`).run(leagueId);
  db.prepare('DELETE FROM seasons WHERE league_id=? AND id<>?').run(leagueId,season.id);
  db.prepare("UPDATE seasons SET status='planned',regular_season_starts_at_ms=NULL,regular_season_ends_at_ms=NULL,fantasy_playoffs_start_at_ms=NULL,fantasy_playoffs_end_at_ms=NULL,free_agent_draft_completed_at_ms=NULL,updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE league_id=? AND id=?").run(nowMs,leagueId,season.id);
  db.prepare("UPDATE teams SET status='setup',updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE league_id=? AND status IN ('active','setup')").run(nowMs,leagueId);
  db.prepare('UPDATE league_settings SET trade_deadline_at_ms=NULL,updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE league_id=?').run(nowMs,leagueId);
  db.prepare("UPDATE league_freezes SET status='ended',ended_at_ms=?,ended_by_user_id=?,version=version+1 WHERE league_id=? AND status='active'").run(nowMs,actorId,leagueId);
  db.prepare("UPDATE leagues SET status='setup',updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE id=?").run(nowMs,league.id);
 });return scopeHash(db,leagueId);
}
function restore(db,snapshot){
 validateDatabase(db);assert.equal(snapshot.schemaVersion,SCHEMA_VERSION);assert.deepEqual(Object.keys(snapshot.tables).sort(),CHANGED_TABLES);
 rewrite(db,snapshot.leagueId,()=>{
  for(const table of CLEAR_TABLES)db.prepare(`DELETE FROM ${quote(table)} WHERE league_id=?`).run(snapshot.leagueId);
  for(const table of CHANGED_TABLES)for(const encoded of snapshot.tables[table]){
   const row=decode(encoded);assert.equal(table==='leagues'?row.id:row.league_id,snapshot.leagueId,'RESET_ARCHIVE_SCOPE_MISMATCH');
   const columns=Object.keys(row),key=table==='league_settings'?'league_id':'id';
   if(!CLEAR_TABLES.includes(table)&&db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${quote(key)}=?`).get(row[key])){
    const updates=columns.filter(c=>c!==key);db.prepare(`UPDATE ${quote(table)} SET ${updates.map(c=>quote(c)+'=?').join(',')} WHERE ${quote(key)}=?`).run(...updates.map(c=>row[c]),row[key]);
   }else db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));
  }
 });assert.deepEqual(capture(db,snapshot.leagueId),snapshot,'RESET_RESTORE_MISMATCH');
}
function withClone(db,fn){
 if(db.pragma('page_count',{simple:true})*db.pragma('page_size',{simple:true})>256*1024*1024)fail('This database requires an offline reset rehearsal.','LEAGUE_RESET_UNAVAILABLE');
 const bytes=db.serialize();
 // SQLite requires rollback-mode headers for an in-memory deserialization.
 // Only this detached serialization is changed: sqlite.org/c3ref/deserialize.html.
 assert.equal(bytes.subarray(0,16).toString('utf8'),'SQLite format 3\0');bytes[18]=1;bytes[19]=1;
 const clone=new Database(bytes);clone.pragma('foreign_keys=ON');clone.pragma('trusted_schema=OFF');
 try{return fn(clone);}finally{clone.close();}
}
function rehearse(db,leagueId,actorId,nowMs){
 const {league}=eligibility(db,leagueId,nowMs),snapshot=capture(db,leagueId),beforeHash=scopeHash(db,leagueId);
 if(Buffer.byteLength(JSON.stringify(snapshot))>24*1024*1024)fail('This league requires an offline recovery archive.','LEAGUE_RESET_UNAVAILABLE');
 const result=withClone(db,clone=>{const afterHash=clone.transaction(()=>reset(clone,leagueId,actorId,nowMs)).immediate();clone.transaction(()=>restore(clone,snapshot)).immediate();assert.equal(scopeHash(clone,leagueId),beforeHash,'RESET_REHEARSAL_RESTORE_FAILED');return {afterHash};});
 return {snapshot,beforeHash,...result,manifest:manifest(snapshot,league),recoveryVerified:true};
}
function rehearseRestore(db,snapshot,expectedCurrentHash){
 if(scopeHash(db,snapshot.leagueId)!==expectedCurrentHash)fail('League state or manager access changed after reset. Restoring would overwrite later work.');
 return withClone(db,clone=>{clone.transaction(()=>restore(clone,snapshot)).immediate();return {recoveryVerified:true};});
}
module.exports={SCHEMA_VERSION,CLEAR_TABLES,CHANGED_TABLES,WITNESS_TABLES,hash,capture,scopeHash,eligibility,manifest,reset,restore,rehearse,rehearseRestore,fail};
