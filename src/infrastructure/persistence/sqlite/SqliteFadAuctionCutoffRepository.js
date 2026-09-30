const crypto=require('node:crypto');
const {cutoffError}=require('../../../domain/freeAgentDraft/fadAuctionCutoffPolicy');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
function createSqliteFadAuctionCutoffRepository({database}) {
  const notifications=createSqliteNotificationWriter({database});
  return {
    transaction:work=>database.transaction(work).immediate(),
    replay:(leagueId,actorUserId,key)=>database.prepare('SELECT id,request_hash FROM fad_auction_cutoff_changes WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,actorUserId,key),
    state(leagueId,fadId) {
      const draft=database.prepare('SELECT id,league_id,season_id,status,version,auction_creation_cutoff_minutes FROM free_agent_drafts WHERE league_id=? AND id=?').get(leagueId,fadId);
      if(!draft)cutoffError('FAD_CUTOFF_NOT_FOUND');
      return {draft,
        league:database.prepare('SELECT status,current_season_id,version FROM leagues WHERE id=?').get(leagueId),
        settings:database.prepare('SELECT * FROM fad_auction_cutoff_settings WHERE league_id=? AND id=?').get(leagueId,fadId)||null,
        rounds:database.prepare('SELECT * FROM free_agent_draft_rollovers WHERE league_id=? AND fad_id=? ORDER BY sequence').all(leagueId,fadId),
        // Only presence is read. No players, managers, offers or bids are loaded.
        committedRoundIds:database.prepare(`SELECT r.id FROM free_agent_draft_rollovers r WHERE r.league_id=? AND r.fad_id=? AND (
          EXISTS(SELECT 1 FROM auction_contexts a WHERE a.league_id=r.league_id AND a.fad_rollover_id=r.id) OR
          EXISTS(SELECT 1 FROM free_agent_draft_nomination_queue q WHERE q.league_id=r.league_id AND q.fad_id=r.fad_id AND
            r.id IN(q.source_rollover_id,q.target_opening_rollover_id,q.resolution_rollover_id))) ORDER BY r.id`).all(leagueId,fadId).map(r=>r.id),
        busyJobs:database.prepare(`SELECT id,status,version FROM job_runs WHERE league_id=? AND season_id=? AND occurrence_key LIKE ?
          AND status IN ('leased','running','failed') ORDER BY id`).all(leagueId,draft.season_id,`fad:${fadId}:%`),
      };
    },
    apply({state,plan,actorUserId,authority,clientKey,requestHash,nowMs}) {
      const id=crypto.randomUUID(),f=state.draft,priorVersion=state.settings?.version??0;
      database.prepare(`INSERT INTO fad_auction_cutoff_changes (id,league_id,fad_id,actor_user_id,client_key,request_hash,reason,
        previous_gap_ms,gap_ms,previous_settings_version,settings_version,before_rollovers_json,after_rollovers_json,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,f.league_id,f.id,actorUserId,clientKey,requestHash,plan.proposed.reason,
          state.settings?.gap_ms??(state.draft.auction_creation_cutoff_minutes??60)*60_000,plan.gapMs,priorVersion,priorVersion+1,JSON.stringify(plan.before),JSON.stringify(plan.after),nowMs);
      database.prepare(`INSERT INTO fad_auction_cutoff_settings(id,league_id,season_id,gap_ms,updated_at_ms,version) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET gap_ms=excluded.gap_ms,updated_at_ms=excluded.updated_at_ms,version=excluded.version`)
        .run(f.id,f.league_id,f.season_id,plan.gapMs,nowMs,priorVersion+1);
      const update=database.prepare(`UPDATE free_agent_draft_rollovers SET creation_cutoff_at_ms=?,updated_at_ms=?,version=?
        WHERE league_id=? AND id=? AND version=? AND status='scheduled'`);
      for(const [i,r] of plan.after.entries())if(update.run(r.creation_cutoff_at_ms,r.updated_at_ms,r.version,f.league_id,r.id,plan.before[i].version).changes!==1)cutoffError();
      const message=`The commissioner set the Free Agent Draft nomination cutoff gap to ${plan.proposed.gapMinutes} minutes. Existing committed rounds keep their saved cutoff. Check the draft for current times.`;
      database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
        VALUES(?,?,?,'league_fad_deadline_changed',?,?,'free_agent_draft',?,?,?,?,?)`)
        .run(id,f.league_id,f.season_id,actorUserId,authority,f.id,message,plan.proposed.reason,JSON.stringify({fadId:f.id,cutoffChangeId:id,gapMinutes:plan.proposed.gapMinutes}),nowMs);
      for(const user of database.prepare("SELECT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(f.league_id))notifications.insert({
        id:crypto.randomUUID(),userId:user.id,leagueId:f.league_id,eventType:'league_fad_deadline_changed',
        messageDataJson:JSON.stringify({message,leagueId:f.league_id,fadId:f.id}),relatedFeature:'free_agent_draft',relatedRecordId:f.id,
        deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:`fad-cutoff:${id}:${user.id}`});
      return {id};
    },
  };
}
module.exports={createSqliteFadAuctionCutoffRepository};
