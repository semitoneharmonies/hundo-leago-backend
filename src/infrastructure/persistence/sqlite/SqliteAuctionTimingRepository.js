const {publishLeagueChangeAnnouncement,displayDate}=require('./leagueChangeAnnouncement');
const crypto = require('node:crypto');
const { fail } = require('../../../domain/auctions/auctionTimingPolicy');
const { createSqliteNotificationWriter } = require('./SqliteNotificationWriter');
const { resolveSqliteLeagueOutboxWriter } = require('./SqliteLeagueOutboxWriter');
const { createSocketEventMetadata, createEmptySocketRelated } = require('../../../domain/leagues/socketInvalidation');
function createSqliteAuctionTimingRepository({ database, leagueOutboxWriter }) {
  const notifications = createSqliteNotificationWriter({ database });
  const outbox = resolveSqliteLeagueOutboxWriter({ database, leagueOutboxWriter });
  return {
    transaction: work => database.transaction(work).immediate(),
    state(leagueId, auctionId) {
      // Clock and authority only: do not load bidder identities, offers or bid history.
      const auction = database.prepare('SELECT id,league_id,season_id,status,opened_at_ms,resolves_at_ms,updated_at_ms,version FROM auctions WHERE league_id=? AND id=?').get(leagueId, auctionId);
      if (!auction) fail('AUCTION_TIMING_NOT_FOUND');
      return { auction,
        league: database.prepare('SELECT status,current_season_id,timezone,version FROM leagues WHERE id=?').get(leagueId),
        season: database.prepare('SELECT status,fantasy_playoffs_start_at_ms,regular_season_ends_at_ms,version FROM seasons WHERE league_id=? AND id=?').get(leagueId, auction.season_id),
        context: database.prepare('SELECT source_kind FROM auction_contexts WHERE league_id=? AND auction_id=?').get(leagueId, auctionId),
        jobCount: database.prepare("SELECT COUNT(*) n FROM job_runs WHERE league_id=? AND occurrence_key LIKE ?").get(leagueId, 'auction:' + auctionId + ':%').n,
        resolutionCount: database.prepare('SELECT COUNT(*) n FROM auction_resolutions WHERE league_id=? AND auction_id=?').get(leagueId, auctionId).n };
    },
    history: (leagueId, auctionId) => database.prepare(`SELECT c.id,c.previous_closes_at_ms AS previousClosesAtMs,c.closes_at_ms AS closesAtMs,
      c.reason,c.created_at_ms AS createdAtMs,u.display_name AS actorName FROM auction_timing_changes c JOIN users u ON u.id=c.actor_user_id
      WHERE c.league_id=? AND c.auction_id=? ORDER BY c.created_at_ms DESC,c.id DESC LIMIT 25`).all(leagueId, auctionId),
    replay: (leagueId, userId, key) => database.prepare('SELECT id,request_hash FROM auction_timing_changes WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId, userId, key),
    apply({ state, proposed, actorUserId, authority, clientKey, requestHash, nowMs }) {
      const id = crypto.randomUUID(), a = state.auction;
      database.prepare(`INSERT INTO auction_timing_changes(id,league_id,season_id,auction_id,actor_user_id,actor_authority,client_key,request_hash,reason,
        previous_closes_at_ms,closes_at_ms,previous_auction_version,auction_version,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id,a.league_id,a.season_id,a.id,actorUserId,authority,clientKey,requestHash,proposed.reason,a.resolves_at_ms,proposed.closesAtMs,a.version,a.version+1,nowMs);
      if (database.prepare("UPDATE auctions SET resolves_at_ms=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND id=? AND status='open' AND version=? AND resolves_at_ms=?")
        .run(proposed.closesAtMs,Math.max(nowMs,a.updated_at_ms),a.league_id,a.id,a.version,a.resolves_at_ms).changes !== 1) fail();
      const display = new Intl.DateTimeFormat('en-CA', { timeZone: state.league.timezone, dateStyle: 'long', timeStyle: 'long' }).format(proposed.closesAtMs);
      const message = 'An in-season auction closing time changed to ' + display + '. Open the auction to review the new deadline. Existing bids are preserved.';
      database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
        VALUES(?,?,?,'league_auction_timing_changed',?,?,'auction',?,?,?,?,?)`)
        .run(id,a.league_id,a.season_id,actorUserId,authority,a.id,message,proposed.reason,JSON.stringify({auctionId:a.id,changeId:id,previousClosesAtMs:a.resolves_at_ms,closesAtMs:proposed.closesAtMs}),nowMs);
      for (const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(a.league_id))
        notifications.insert({ id:crypto.randomUUID(),userId:user.id,leagueId:a.league_id,eventType:'league_auction_timing_changed',
          messageDataJson:JSON.stringify({leagueId:a.league_id,auctionId:a.id,message,closesAtMs:proposed.closesAtMs}),
          relatedFeature:'auction',relatedRecordId:a.id,deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:'auction-timing:'+id+':'+user.id });
      outbox.write({ id:crypto.randomUUID(),leagueId:a.league_id,eventType:'auction.changed',aggregateType:'auction',aggregateId:a.id,
        payload:createSocketEventMetadata({eventType:'auction.changed',version:a.version+1,reasonCode:'auction_changed',occurredAtMs:nowMs,
          related:{...createEmptySocketRelated(),auctionId:a.id}}),occurredAtMs:nowMs,audiences:[{kind:'league'}] });
      publishLeagueChangeAnnouncement(database,{id,leagueId:a.league_id,actorUserId,title:'Auction closing time changed',message:'Previous close: '+displayDate(a.resolves_at_ms,state.league.timezone)+'.\n'+message,reason:proposed.reason,nowMs});
      return { id };
    },
  };
}
module.exports = { createSqliteAuctionTimingRepository };
