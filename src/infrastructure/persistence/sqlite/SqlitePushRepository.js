const { randomUUID, createHash } = require('node:crypto');
const { DEFAULT_PREFERENCES, NOTIFICATION_COPY, TRADE_COPY } = require('../../../domain/activity/pushPolicy');
const { createSqliteFadPushReminders } = require('./SqliteFadPushReminders');
const { ANNOUNCEMENT_VISIBILITY_MS } = require('../../../domain/leagues/leagueCommunicationPolicy');
const HOUR = 3_600_000;

function createSqlitePushRepository({ database, notificationWriter, configuredSeasonsOnly = false }) {
  const db = database;
  // Disabled push must not prepare newer-schema queries in historical QA runtimes.
  let fadReminders;
  const getFadReminders = () => fadReminders ||= createSqliteFadPushReminders({ database, configuredSeasonsOnly });
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function preferences(userId) { return { ...DEFAULT_PREFERENCES, ...JSON.parse(get('SELECT preferences_json FROM push_preferences WHERE user_id=?',userId)?.preferences_json || '{}') }; }
  function member(userId, leagueId, commissioner = false) {
    return get(`SELECT m.* FROM league_memberships m JOIN users u ON u.id=m.user_id JOIN leagues l ON l.id=m.league_id
      WHERE m.user_id=? AND m.league_id=? AND m.status='active' AND u.status='active' AND l.status IN ('active','setup')
      AND (?=0 OR (m.permission_category='commissioner' AND l.commissioner_membership_id=m.id))`,userId,leagueId,Number(commissioner));
  }
  function managers(leagueId, teamId) {
    return all(`SELECT DISTINCT a.user_id FROM team_manager_assignments a JOIN teams t ON t.id=a.team_id AND t.league_id=a.league_id
      JOIN league_memberships m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.league_id=a.league_id
      JOIN users u ON u.id=a.user_id WHERE a.league_id=? AND a.team_id=? AND a.status='accepted' AND a.ended_at_ms IS NULL
      AND t.status='active' AND m.status='active' AND u.status='active'`,leagueId,teamId);
  }
  function commissioners(leagueId) { return all("SELECT m.user_id FROM league_memberships m JOIN leagues l ON l.commissioner_membership_id=m.id WHERE m.league_id=? AND m.status='active' AND m.permission_category='commissioner'",leagueId); }
  function emit({userId,leagueId,teamId=null,commissioner=false,category,title,url,eventKey,at,expiresAt,guard={},existing=false}, now) {
    if (!member(userId,leagueId,commissioner) || (teamId && !managers(leagueId,teamId).some(row=>row.user_id===userId))) return;
    if (expiresAt <= now || at > now || now-at > HOUR) return;
    const tag = 'hl-'+createHash('sha256').update(eventKey+userId).digest('hex').slice(0,40);
    const body = (get('SELECT name FROM leagues WHERE id=?',leagueId)?.name || '').replace(/[\r\n\t]/g,' ').slice(0,48);
    const payload = { title,body,url,tag };
    // Durable event receipts survive reset queue cleanup and device changes.
    // A repeated timer must not recreate a delivery that was already handled.
    if (!existing && get("SELECT id FROM notifications WHERE user_id=? AND event_type='push_alert' AND deduplication_key=?",userId,eventKey)) return;
    if (!existing) {
      notificationWriter.insert({id:randomUUID(),userId,leagueId,eventType:'push_alert',messageDataJson:JSON.stringify({summary:title,path:url}),
        relatedFeature:null,relatedRecordId:null,deliveryStatus:'delivered',createdAtMs:at,deliveredAtMs:at,deduplicationKey:eventKey});
    }
    if (preferences(userId)[category] === false) return;
    if(category==='roster_illegal' && guard.locksAtMs-now<=2*HOUR && preferences(userId).roster_lock!==false) return;
    for (const sub of all('SELECT id FROM push_subscriptions WHERE user_id=? AND created_at_ms<=?',userId,at)) {
      run(`INSERT OR IGNORE INTO push_deliveries(id,subscription_id,user_id,league_id,team_id,commissioner_only,category,event_key,payload_json,guard_json,created_at_ms,expires_at_ms,next_attempt_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,randomUUID(),sub.id,userId,leagueId,teamId,Number(commissioner),category,eventKey,JSON.stringify(payload),JSON.stringify(guard),at,expiresAt,now);
    }
  }
  function forTeam(event,teamId,now,exclude) { for(const row of managers(event.leagueId,teamId)) if(row.user_id!==exclude) emit({...event,userId:row.user_id,teamId},now); }
  function forCommissioners(event,now,exclude) { for(const row of commissioners(event.leagueId)) if(row.user_id!==exclude) emit({...event,userId:row.user_id,commissioner:true},now); }
  function consume(source,process) {
    const cursor = get('SELECT last_rowid FROM push_event_cursors WHERE source=?',source).last_rowid;
    const rows = all(`SELECT rowid AS source_rowid,* FROM ${source} WHERE rowid>? ORDER BY rowid LIMIT 200`,cursor);
    // Reset restoration gives historical events new rowids; explicit markers
    // prevent replay without advancing past another league's unread events.
    for(const row of rows) if(!get('SELECT 1 FROM push_event_cursors WHERE source=?',`restored:${source}:${row.id}`)) process(row);
    if(rows.length) run('UPDATE push_event_cursors SET last_rowid=? WHERE source=?',rows.at(-1).source_rowid,source);
  }
  function collectNotifications(now) {
    consume('notifications',row=>{
      const copy=NOTIFICATION_COPY[row.event_type]; if(!copy || !row.league_id) return;
      const data=JSON.parse(row.message_data_json); let url=`/leagues/${row.league_id}`; let guard={}; let teamId=data.teamId || null;
      if(row.event_type==='trade_proposal_received') { const id=data.tradeId || data.proposalId || row.related_record_id; url=`/leagues/${row.league_id}/trades/${id}`; guard={kind:'trade_offer',id}; teamId=data.receivingTeamId; }
      if(row.event_type==='league_announcement') {
        const communication=get('SELECT * FROM league_communications WHERE id=? AND league_id=?',data.communicationId,row.league_id);
        if(!communication?.push_notify || communication.archived_at_ms!==null ||
          communication.created_at_ms <= now-ANNOUNCEMENT_VISIBILITY_MS ||
          (communication.expires_at_ms !== null && communication.expires_at_ms <= now)) return;
        guard={kind:'announcement',id:communication.id};
      }
      let title=copy[1];
      if(row.event_type==='fad_rapid_auction_result') { title=({won:'Auction won',lost:'Auction lost',invalid:'Auction bid invalid',removed:'Auction bid removed',cancelled:'Auction cancelled',no_winner:'Auction ended: no winner',correction_required:'Auction needs attention'})[data.outcomeCode] || 'Auction result ready'; const auctionId=data.auctionId || data.destination?.auctionId; if(auctionId) url=`/leagues/${row.league_id}/auctions/${auctionId}`; }
      if(row.event_type.startsWith('fad_') && row.event_type!=='fad_rapid_auction_result') {
        url=`/leagues/${row.league_id}/free-agent-draft${data.fadId?'/'+data.fadId:''}`;
        if(data.destination?.kind==='private_card' && data.fadId && teamId) url+=`/cards/${teamId}`;
        guard={kind:row.event_type,id:data.fadId,teamId,auctionId:data.auctionId};
        if(data.auctionId) url=`/leagues/${row.league_id}/auctions/${data.auctionId}`;
        else if(copy[0]==='commissioner_action') url=`/leagues/${row.league_id}/commissioner`;
      }
      emit({userId:row.user_id,leagueId:row.league_id,teamId,commissioner:copy[0]==='commissioner_action',category:copy[0],title,url,
        eventKey:'notification:'+row.id,at:row.created_at_ms,expiresAt:row.created_at_ms+HOUR,guard,existing:true},now);
    });
  }
  function collectTrades(now) {
    consume('trade_events',row=>{
      const copy=TRADE_COPY[row.event_type] || (/cancel/.test(row.event_type)?['trade_closed','Trade cancelled']: /expir/.test(row.event_type)?['trade_closed','Trade expired']:null);
      if(!copy) return;
      const trade=get('SELECT * FROM trades WHERE id=? AND league_id=?',row.trade_id,row.league_id); if(!trade) return;
      const teams=new Set([trade.proposing_team_id,trade.receiving_team_id,...all('SELECT team_id FROM trade_participants WHERE trade_id=? AND league_id=?',trade.id,row.league_id).map(r=>r.team_id)]);
      const event={leagueId:row.league_id,category:copy[0],title:copy[1],url:`/leagues/${row.league_id}/trades/${trade.id}`,eventKey:'trade:'+row.id,at:row.occurred_at_ms,expiresAt:row.occurred_at_ms+HOUR};
      for(const team of teams) forTeam(event,team,now,row.actor_user_id);
      if(row.event_type==='proposal_accepted_awaiting_commissioner_approval') forCommissioners({...event,category:'commissioner_action',title:'Trade needs approval',guard:{kind:'trade_approval',id:trade.id}},now,row.actor_user_id);
    });
  }
  function collectAuctions(now) {
    consume('auction_events',row=>{
      const auction=get('SELECT * FROM auctions WHERE id=? AND league_id=?',row.auction_id,row.league_id); if(!auction) return;
      const base={leagueId:row.league_id,url:`/leagues/${row.league_id}/auctions/${auction.id}`,eventKey:'auction:'+row.id,at:row.occurred_at_ms,expiresAt:row.occurred_at_ms+HOUR};
      if(row.event_type==='bid_submitted' && auction.status==='open') {
        for(const bid of all("SELECT DISTINCT team_id FROM auction_bids WHERE auction_id=? AND league_id=? AND status='active' AND team_id<>? AND first_submitted_at_ms<=?",auction.id,row.league_id,row.team_id,row.occurred_at_ms)) {
          forTeam({...base,category:'auction_bid',title:'New competing bid',expiresAt:Math.min(base.expiresAt,auction.resolves_at_ms),guard:{kind:'auction_open',id:auction.id,deadline:auction.resolves_at_ms}},bid.team_id,now,row.actor_user_id);
        }
      }
      if(['auction_resolved','auction_no_winner','auction_cancelled'].includes(row.event_type) && !get("SELECT id FROM auction_contexts WHERE auction_id=? AND source_kind<>'ordinary_weekly'",auction.id)) {
        for(const bid of all('SELECT team_id,status FROM auction_bids WHERE auction_id=? AND league_id=?',auction.id,row.league_id)) {
          const title=row.event_type==='auction_cancelled'?'Auction cancelled':bid.status==='won'?'Auction won':row.event_type==='auction_no_winner'?'Auction ended: no winner':'Auction lost';
          forTeam({...base,category:'auction_result',title},bid.team_id,now);
        }
      }
    });
  }
  function collectTimers(now, rosterDecision) {
    getFadReminders().collect(now,forTeam);
    for(const auction of all("SELECT a.* FROM auctions a JOIN leagues l ON l.id=a.league_id WHERE a.status='open' AND a.resolves_at_ms>? AND a.resolves_at_ms<=? AND l.status='active' AND NOT EXISTS(SELECT 1 FROM auction_contexts c WHERE c.league_id=a.league_id AND c.auction_id=a.id AND c.source_kind<>'ordinary_weekly')",now,now+2*HOUR)) {
      for(const bid of all("SELECT DISTINCT team_id FROM auction_bids WHERE auction_id=? AND league_id=? AND status='active'",auction.id,auction.league_id)) {
        forTeam({leagueId:auction.league_id,category:'auction_closing',title:'Auction closes soon',url:`/leagues/${auction.league_id}/auctions/${auction.id}`,
          eventKey:`auction-closing:${auction.id}:${auction.resolves_at_ms}`,at:now,expiresAt:auction.resolves_at_ms,guard:{kind:'auction_open',id:auction.id,deadline:auction.resolves_at_ms}},bid.team_id,now);
      }
    }
    for(const auction of all("SELECT a.* FROM auctions a JOIN leagues l ON l.id=a.league_id WHERE a.status='failed' AND l.status='active' AND a.updated_at_ms>?",now-HOUR)) {
      forCommissioners({leagueId:auction.league_id,category:'commissioner_action',title:'Auction needs attention',url:`/leagues/${auction.league_id}/commissioner`,eventKey:`auction-failed:${auction.id}:${auction.version}`,at:auction.updated_at_ms,expiresAt:auction.updated_at_ms+HOUR,guard:{kind:'auction_failed',id:auction.id}},now);
    }
    for(const row of all(`SELECT w.id AS weekId,w.league_id AS leagueId,w.season_id AS seasonId,w.locks_at_ms AS locksAtMs,t.id AS teamId
      FROM matchup_weeks w JOIN leagues l ON l.id=w.league_id AND l.current_season_id=w.season_id JOIN teams t ON t.league_id=w.league_id
      WHERE l.status='active' AND t.status='active' AND w.status IN ('scheduled','baseline_ready','live') AND w.locks_at_ms>? AND w.locks_at_ms<=?
      AND w.locks_at_ms=(SELECT MIN(w2.locks_at_ms) FROM matchup_weeks w2 WHERE w2.league_id=w.league_id AND w2.season_id=w.season_id AND w2.status IN ('scheduled','baseline_ready','live') AND w2.locks_at_ms>?)`,now,now+24*HOUR,now)) {
      const decision=rosterDecision(row); if(!decision) continue;
      const near=row.locksAtMs-now<=2*HOUR;
      const guard={kind:'roster',...row,combined:near,announcedIllegal:!decision.legal};
      const base={leagueId:row.leagueId,url:`/leagues/${row.leagueId}/teams/${row.teamId}/roster`,at:now,expiresAt:row.locksAtMs,guard};
      if(near) forTeam({...base,category:'roster_lock',title:decision.legal?(row.locksAtMs-now>=110*60_000?'Roster locks in 2 hours':'Roster locks soon'):'Roster needs fixing before lock',eventKey:`roster-lock:${row.weekId}:${row.locksAtMs}`},row.teamId,now);
      const reason=decision.legal?'':decision.reasonCodes.join(',');
      const previous=get('SELECT * FROM push_roster_state WHERE league_id=? AND team_id=? AND week_id=?',row.leagueId,row.teamId,row.weekId);
      if(reason && reason!==previous?.last_reason && (!previous || now-previous.last_sent_at_ms>=6*HOUR)) {
        forTeam({...base,category:'roster_illegal',title:'Roster needs attention',guard:{...guard,illegal:true},eventKey:`roster-illegal:${row.weekId}:${row.teamId}:${now}`},row.teamId,now);
        run('INSERT INTO push_roster_state VALUES(?,?,?,?,?) ON CONFLICT(league_id,team_id,week_id) DO UPDATE SET last_reason=excluded.last_reason,last_sent_at_ms=excluded.last_sent_at_ms',row.leagueId,row.teamId,row.weekId,reason,now);
      } else if(!reason && previous?.last_reason) run('UPDATE push_roster_state SET last_reason=? WHERE league_id=? AND team_id=? AND week_id=?','',row.leagueId,row.teamId,row.weekId);
    }
  }
  function validGuard(delivery, now, rosterDecision) {
    const guard=JSON.parse(delivery.guard_json);
    const fadAllowed=getFadReminders().authorize(delivery,guard,now);
    if (fadAllowed!==null) return fadAllowed;
    if(guard.kind==='auction_open') { const row=get('SELECT status,resolves_at_ms FROM auctions WHERE id=? AND league_id=?',guard.id,delivery.league_id); return row?.status==='open' && row.resolves_at_ms===guard.deadline && row.resolves_at_ms>now; }
    if(guard.kind==='auction_failed') return get('SELECT status FROM auctions WHERE id=?',guard.id)?.status==='failed';
    if(guard.kind==='trade_offer') return Boolean(get("SELECT id FROM trades t WHERE t.id=? AND t.status='proposed' AND t.effective_deadline_at_ms>? AND NOT EXISTS(SELECT 1 FROM trade_future_consideration_acceptances a WHERE a.trade_id=t.id)",guard.id,now));
    if(guard.kind==='trade_approval') return Boolean(get("SELECT t.id FROM trades t JOIN trade_future_consideration_acceptances a ON a.trade_id=t.id AND a.league_id=t.league_id WHERE t.id=? AND t.status='proposed'",guard.id));
    if(guard.kind==='announcement') { const row=get('SELECT * FROM league_communications WHERE id=?',guard.id); return row?.push_notify===1 && row.archived_at_ms===null && row.created_at_ms>now-ANNOUNCEMENT_VISIBILITY_MS && (!row.expires_at_ms || row.expires_at_ms>now); }
    if(guard.kind==='roster') { const week=get('SELECT locks_at_ms FROM matchup_weeks WHERE id=? AND league_id=?',guard.weekId,delivery.league_id); if(week?.locks_at_ms!==guard.locksAtMs || week.locks_at_ms<=now) return false; if(guard.illegal) return rosterDecision(guard)?.legal===false; if(guard.combined && guard.announcedIllegal && rosterDecision(guard)?.legal===true) { const payload=JSON.parse(delivery.payload_json); payload.title='Roster locks soon'; delivery.payload_json=JSON.stringify(payload); } }
    if(guard.kind?.startsWith('fad_') && guard.id) {
      if(guard.auctionId && !get("SELECT id FROM auctions WHERE id=? AND status='open' AND resolves_at_ms>?",guard.auctionId,now)) return false;
      const draft=get('SELECT status FROM free_agent_drafts WHERE id=? AND league_id=?',guard.id,delivery.league_id);
      if(!draft || ['complete','completed','cancelled'].includes(draft.status)) return false;
      if(['fad_cards_opened','fad_deadline_approaching'].includes(guard.kind)) {
        if(draft.status!=='cards_open') return false;
        const card=get('SELECT completeness_code FROM candidate_cards WHERE fad_id=? AND team_id=?',guard.id,guard.teamId);
        if(guard.kind==='fad_deadline_approaching' && card?.completeness_code==='complete') return false;
      }
    }
    return true;
  }
  const removeSubscription = db.transaction(id => {
    run('DELETE FROM push_deliveries WHERE subscription_id=?',id);
    run('DELETE FROM push_subscriptions WHERE id=?',id);
  });
  return {
    preferences,
    savePreferences(userId,value,now) { run('INSERT INTO push_preferences VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET preferences_json=excluded.preferences_json,updated_at_ms=excluded.updated_at_ms',userId,JSON.stringify(value),now); },
    subscribe(userId,sessionId,subscription,now) {
      return db.transaction(()=>{
        const existing=get('SELECT * FROM push_subscriptions WHERE endpoint=?',subscription.endpoint);
        if(existing && (existing.user_id!==userId || existing.session_id!==sessionId)) removeSubscription(existing.id);
        if(all('SELECT id FROM push_subscriptions WHERE user_id=?',userId).length>=10 && (!existing || existing.user_id!==userId)) throw Object.assign(new Error('Device limit reached.'),{code:'PUSH_DEVICE_LIMIT'});
        run(`INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json,updated_at_ms=excluded.updated_at_ms`,randomUUID(),userId,sessionId,subscription.endpoint,JSON.stringify(subscription),now,now);
      }).immediate();
    },
    unsubscribe(userId,endpoint) {
      return db.transaction(()=>{
        const sub=get('SELECT id FROM push_subscriptions WHERE user_id=? AND endpoint=?',userId,endpoint);
        if(sub) removeSubscription(sub.id);
      }).immediate();
    },
    collect(now,rosterDecision) { return db.transaction(()=>{ collectTrades(now); collectAuctions(now); collectTimers(now,rosterDecision); collectNotifications(now); }).immediate(); },
    due(now) {
      run("UPDATE push_deliveries SET status='pending' WHERE status='sending' AND next_attempt_at_ms<=?",now);
      run("UPDATE push_deliveries SET status='suppressed' WHERE status='pending' AND expires_at_ms<=?",now);
      return all("SELECT * FROM push_deliveries WHERE status='pending' AND next_attempt_at_ms<=? ORDER BY created_at_ms,id LIMIT 10",now);
    },
    authorize(delivery,now,rosterDecision) {
      const sub=get(`SELECT p.* FROM push_subscriptions p JOIN sessions s ON s.id=p.session_id AND s.user_id=p.user_id
        JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.user_id=? AND s.status='active' AND s.idle_expires_at_ms>? AND s.absolute_expires_at_ms>?
        AND u.status='active'`,delivery.subscription_id,delivery.user_id,now,now);
      if(!sub || !member(delivery.user_id,delivery.league_id,delivery.commissioner_only===1) || preferences(delivery.user_id)[delivery.category]===false || delivery.expires_at_ms<=now) return null;
      if(delivery.team_id && !managers(delivery.league_id,delivery.team_id).some(r=>r.user_id===delivery.user_id)) return null;
      if(!validGuard(delivery,now,rosterDecision)) return null;
      return JSON.parse(sub.subscription_json);
    },
    claim(id,now) { return run("UPDATE push_deliveries SET status='sending',attempts=attempts+1,next_attempt_at_ms=? WHERE id=? AND status='pending'",now+60_000,id).changes===1; },
    finish(id,status,next) { run('UPDATE push_deliveries SET status=?,next_attempt_at_ms=? WHERE id=?',status,next,id); },
    removeSubscription(id) { removeSubscription.immediate(id); },
  };
}
module.exports = { createSqlitePushRepository };
