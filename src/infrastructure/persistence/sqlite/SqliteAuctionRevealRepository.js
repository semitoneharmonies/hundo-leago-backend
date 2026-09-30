function createSqliteAuctionRevealRepository({database}) {
  return {
    available:()=>database.pragma('user_version',{simple:true})>=75,
    transaction:work=>database.transaction(work).immediate(),
    bid:(leagueId,auctionId,bidId)=>database.prepare('SELECT id,version,total_value_cents,term_years FROM auction_bids WHERE league_id=? AND auction_id=? AND id=?').get(leagueId,auctionId,bidId),
    replay:(leagueId,userId,key)=>database.prepare('SELECT id,request_hash,created_at_ms FROM league_private_reveals WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
    insert:({id,leagueId,userId,auctionId,bidId,reason,key,hash,nowMs})=>database.prepare('INSERT INTO league_private_reveals(id,league_id,actor_user_id,auction_id,bid_id,reason,client_key,request_hash,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)').run(id,leagueId,userId,auctionId,bidId,reason,key,hash,nowMs),
  };
}
module.exports={createSqliteAuctionRevealRepository};
