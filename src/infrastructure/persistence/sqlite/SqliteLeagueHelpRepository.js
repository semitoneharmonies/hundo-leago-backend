const crypto=require('node:crypto');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
function createSqliteLeagueHelpRepository({database}){
  const notifications=createSqliteNotificationWriter({database});
  const requestSql=`SELECT h.id,h.league_id AS leagueId,h.team_id AS teamId,t.name AS teamName,h.requester_user_id AS requesterUserId,u.display_name AS requesterName,
    h.kind,h.target_id AS targetId,h.target_label AS targetLabel,h.subject,h.message,h.status,h.created_at_ms AS createdAtMs,h.updated_at_ms AS updatedAtMs,h.version
    FROM league_help_requests h JOIN teams t ON t.league_id=h.league_id AND t.id=h.team_id JOIN users u ON u.id=h.requester_user_id`;
  function recipients(leagueId,requesterUserId,actorUserId){
    const commissioner=database.prepare(`SELECT m.user_id AS id FROM leagues l JOIN league_memberships m ON m.league_id=l.id AND m.id=l.commissioner_membership_id
      JOIN users u ON u.id=m.user_id AND u.status='active' WHERE l.id=? AND m.status='active'`).get(leagueId);
    const active=database.prepare("SELECT 1 FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.user_id=? AND m.status='active' AND u.status='active'");
    return [...new Set([commissioner?.id,requesterUserId])].filter(id=>id&&id!==actorUserId&&active.get(leagueId,id));
  }
  function notify({leagueId,requesterUserId,actorUserId,id,nowMs}){
    for(const userId of recipients(leagueId,requesterUserId,actorUserId))notifications.insert({id:crypto.randomUUID(),userId,leagueId,eventType:'league_help_updated',
      messageDataJson:JSON.stringify({leagueId,message:'A private league help request was updated. Open league help to review it.'}),relatedFeature:'league',relatedRecordId:leagueId,
      deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:'help:'+id+':'+userId});
  }
  return {
    transaction:fn=>database.transaction(fn).immediate(),
    teams:(leagueId,userId)=>database.prepare(`SELECT t.id,t.name FROM teams t JOIN team_manager_assignments a ON a.league_id=t.league_id AND a.team_id=t.id
      JOIN league_memberships m ON m.league_id=a.league_id AND m.id=a.membership_id AND m.user_id=a.user_id
      WHERE t.league_id=? AND a.user_id=? AND a.status='accepted' AND a.ended_at_ms IS NULL AND m.status='active' AND t.status IN ('setup','active') ORDER BY t.name,t.id`).all(leagueId,userId),
    targets(leagueId,teamId,kind){
      if(kind==='general')return [];
      if(kind==='auction')return database.prepare(`SELECT a.id,p.full_name AS label,a.status FROM auctions a JOIN players p ON p.id=a.player_id
        WHERE a.league_id=? AND EXISTS(SELECT 1 FROM auction_bids b WHERE b.league_id=a.league_id AND b.auction_id=a.id AND b.team_id=?)
        ORDER BY a.opened_at_ms DESC,a.id LIMIT 200`).all(leagueId,teamId);
      if(kind==='roster')return database.prepare(`SELECT o.id,p.full_name AS label,o.roster_category AS status FROM player_ownerships o JOIN players p ON p.id=o.player_id
        JOIN leagues l ON l.id=o.league_id AND l.current_season_id=o.season_id WHERE o.league_id=? AND o.team_id=? ORDER BY p.full_name,o.id`).all(leagueId,teamId);
      return database.prepare(`SELECT t.id,'Trade with '||receiver.name||' / '||proposer.name AS label,t.status FROM trades t
        JOIN teams proposer ON proposer.league_id=t.league_id AND proposer.id=t.proposing_team_id JOIN teams receiver ON receiver.league_id=t.league_id AND receiver.id=t.receiving_team_id
        WHERE t.league_id=@leagueId AND (t.proposing_team_id=@teamId OR t.receiving_team_id=@teamId OR EXISTS(SELECT 1 FROM trade_participants p WHERE p.league_id=t.league_id AND p.trade_id=t.id AND p.team_id=@teamId))
        ORDER BY t.created_at_ms DESC,t.id LIMIT 200`).all({leagueId,teamId});
    },
    list({leagueId,userId,manage,status,beforeAt,beforeId}){
      return database.prepare(`${requestSql} WHERE h.league_id=@leagueId AND (@manage=1 OR h.requester_user_id=@userId)
        AND (@status='all' OR (@status='open' AND h.status='open') OR (@status='closed' AND h.status<>'open'))
        AND (@beforeAt IS NULL OR h.created_at_ms<@beforeAt OR (h.created_at_ms=@beforeAt AND h.id<@beforeId)) ORDER BY h.created_at_ms DESC,h.id DESC LIMIT 51`)
        .all({leagueId,userId,manage:manage?1:0,status,beforeAt,beforeId});
    },
    cardHelp(leagueId,userId,manage,nowMs){
      return database.prepare(`SELECT h.id,h.fad_id AS fadId,h.team_id AS teamId,t.name AS teamName,u.display_name AS requesterName,h.message,
        h.expires_at_ms AS expiresAtMs,CASE WHEN h.status='active' AND h.expires_at_ms>@nowMs AND c.status='open' THEN 1 ELSE 0 END AS available
        FROM candidate_card_help_requests h JOIN teams t ON t.league_id=h.league_id AND t.id=h.team_id JOIN users u ON u.id=h.requested_by_user_id
        JOIN candidate_cards c ON c.league_id=h.league_id AND c.id=h.card_id JOIN leagues l ON l.id=h.league_id AND l.current_season_id=h.season_id
        WHERE h.league_id=@leagueId AND (@manage=1 OR h.requested_by_user_id=@userId) ORDER BY h.requested_at_ms DESC,h.id`).all({leagueId,userId,manage:manage?1:0,nowMs}).map(r=>({...r,available:r.available===1}));
    },
    find:(leagueId,id)=>database.prepare(requestSql+' WHERE h.league_id=? AND h.id=?').get(leagueId,id)||null,
    events:(leagueId,id)=>database.prepare(`SELECT e.id,e.action,e.message,e.created_at_ms AS createdAtMs,u.display_name AS actorName FROM league_help_events e
      JOIN users u ON u.id=e.actor_user_id WHERE e.league_id=? AND e.request_id=? ORDER BY e.previous_version`).all(leagueId,id),
    createReplay:(leagueId,userId,key)=>database.prepare('SELECT id,request_hash FROM league_help_requests WHERE league_id=? AND requester_user_id=? AND client_key=?').get(leagueId,userId,key),
    eventReplay:(leagueId,userId,key)=>database.prepare('SELECT id,request_id,request_hash FROM league_help_events WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
    create({leagueId,actorUserId,input:p,targetLabel,clientKey,requestHash,nowMs}){
      const id=crypto.randomUUID();
      database.prepare(`INSERT INTO league_help_requests(id,league_id,team_id,requester_user_id,kind,target_id,target_label,subject,message,status,client_key,request_hash,created_at_ms,updated_at_ms,version)
        VALUES(?,?,?,?,?,?,?,?,?,'open',?,?,?,?,1)`).run(id,leagueId,p.teamId,actorUserId,p.kind,p.targetId,targetLabel,p.subject,p.message,clientKey,requestHash,nowMs,nowMs);
      notify({leagueId,requesterUserId:actorUserId,actorUserId,id,nowMs});return {id};
    },
    event({leagueId,request,actorUserId,input:p,clientKey,requestHash,nowMs}){
      const id=crypto.randomUUID();database.prepare(`INSERT INTO league_help_events(id,league_id,request_id,actor_user_id,action,message,client_key,request_hash,previous_version,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,leagueId,request.id,actorUserId,p.action,p.message,clientKey,requestHash,request.version,nowMs);
      database.prepare('UPDATE league_help_requests SET status=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND id=? AND version=?')
        .run({resolve:'resolved',withdraw:'withdrawn',reopen:'open'}[p.action]||request.status,nowMs,leagueId,request.id,request.version);
      notify({leagueId,requesterUserId:request.requesterUserId,actorUserId,id,nowMs});return {id,requestId:request.id};
    },
  };
}
module.exports={createSqliteLeagueHelpRepository};
