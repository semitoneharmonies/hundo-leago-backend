const crypto = require('node:crypto');
const {createSqliteNotificationWriter} = require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter} = require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated} = require('../../../domain/leagues/socketInvalidation');
function createSqliteLeaguePickRepairRepository({database,leagueOutboxWriter}) {
  const notifications = createSqliteNotificationWriter({database});
  const outbox = resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
  return {
    transaction: fn => database.transaction(fn).immediate(),
    drafts: leagueId => database.prepare(`SELECT d.id,d.season_id AS seasonId,d.status,s.label AS seasonLabel
      FROM entry_drafts d JOIN seasons s ON s.league_id=d.league_id AND s.id=d.season_id
      WHERE d.league_id=? AND d.status NOT IN ('completed','cancelled') ORDER BY s.label,d.id`).all(leagueId),
    state(leagueId,draftId) {
      const draft = database.prepare('SELECT * FROM entry_drafts WHERE league_id=? AND id=?').get(leagueId,draftId)||null;
      return {
        league:database.prepare('SELECT id,status,version FROM leagues WHERE id=?').get(leagueId), draft,
        season:draft?database.prepare('SELECT id,status,version FROM seasons WHERE league_id=? AND id=?').get(leagueId,draft.season_id):null,
        teams:database.prepare("SELECT id,name,status,version FROM teams WHERE league_id=? AND status<>'erased' ORDER BY id").all(leagueId),
        picks:database.prepare('SELECT * FROM draft_picks WHERE league_id=? AND draft_id=? ORDER BY round_number,position_number,id').all(leagueId,draftId),
        lottery:database.prepare(`SELECT r.* FROM draft_lottery_results r JOIN draft_lottery_runs l ON l.league_id=r.league_id AND l.id=r.lottery_run_id
          WHERE l.league_id=? AND l.draft_id=? AND l.status='committed' ORDER BY r.final_draft_position`).all(leagueId,draftId),
      };
    },
    replay:(leagueId,userId,key)=>database.prepare('SELECT id,request_hash,action_type FROM league_management_actions WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
    apply({state,plan,actorUserId,authority,clientKey,requestHash,nowMs}) {
      const id = crypto.randomUUID(), leagueId = state.league.id;
      const added = plan.additions.map(p => ({...p,id:crypto.randomUUID()}));
      for (const p of added) {
        database.prepare(`INSERT INTO draft_picks(id,league_id,draft_id,target_season_id,round_number,position_number,original_team_id,current_owner_team_id,status,selection_id,created_at_ms,updated_at_ms,version)
          VALUES(?,?,?,?,?,?,?,?,'unused',NULL,?,?,1)`).run(p.id,leagueId,state.draft.id,state.draft.season_id,p.round,p.position,p.teamId,p.ownerTeamId,nowMs,nowMs);
        database.prepare(`INSERT INTO draft_pick_ownership_events(id,league_id,draft_pick_id,from_team_id,to_team_id,trade_id,actor_user_id,event_type,occurred_at_ms)
          VALUES(?,?,?,NULL,?,NULL,?,'commissioner_missing_pick_repair',?)`).run(crypto.randomUUID(),leagueId,p.id,p.ownerTeamId,actorUserId,nowMs);
      }
      database.prepare(`INSERT INTO league_management_actions(id,league_id,season_id,actor_user_id,actor_authority,action_type,target_id,client_key,request_hash,reason,before_json,after_json,created_at_ms)
        VALUES(?,?,?,?,?,'pick_repair',?,?,?,?,?,?,?)`).run(id,leagueId,state.draft.season_id,actorUserId,authority,state.draft.id,clientKey,requestHash,plan.proposed.reason,
          JSON.stringify({existingPicks:state.picks.length}),JSON.stringify({added,preservedPicks:state.picks.length}),nowMs);
      database.prepare('UPDATE entry_drafts SET version=version+1,updated_at_ms=max(updated_at_ms,?) WHERE league_id=? AND id=?').run(nowMs,leagueId,state.draft.id);
      database.prepare('UPDATE leagues SET version=version+1,updated_at_ms=max(updated_at_ms,?) WHERE id=?').run(nowMs,leagueId);
      const message = added.length+' missing entry-draft picks added after commissioner review. Existing picks and trades are unchanged.';
      database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
        VALUES(?,?,?,'league_picks_repaired',?,?,'entry_draft',?,?,?,?,?)`).run(id,leagueId,state.draft.season_id,actorUserId,authority,state.draft.id,message,plan.proposed.reason,JSON.stringify({repairId:id,count:added.length}),nowMs);
      for (const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId)) {
        notifications.insert({id:crypto.randomUUID(),userId:user.id,leagueId,eventType:'league_picks_repaired',messageDataJson:JSON.stringify({leagueId,message}),relatedFeature:'league',relatedRecordId:leagueId,
          deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:'pick-repair:'+id+':'+user.id});
      }
      outbox.write({id:crypto.randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,payload:createSocketEventMetadata({eventType:'league.changed',
        version:state.league.version+1,reasonCode:'league_changed',occurredAtMs:nowMs,related:createEmptySocketRelated()}),occurredAtMs:nowMs,audiences:[{kind:'league'}]});
      return {id};
    },
  };
}
module.exports = {createSqliteLeaguePickRepairRepository};
