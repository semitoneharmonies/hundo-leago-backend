const {getAuctionCreationWindow}=require('../auctions/auctionCreationPolicy');
// Read-only projection of the same clock used when an auction is started.
// Current rules describe upcoming windows; historical auctions keep their saved clocks.
function calendarAuctionEvents({season,timeZone,schedule=null,stagingDaily=false,nowMs}) {
 if(!season||!Number.isSafeInteger(season.free_agent_draft_completed_at_ms)||!Number.isSafeInteger(season.regular_season_starts_at_ms)||!Number.isSafeInteger(season.fantasy_playoffs_start_at_ms))return [];
 const start=Math.max(nowMs,season.regular_season_starts_at_ms,season.free_agent_draft_completed_at_ms);
 const end=Math.min(season.fantasy_playoffs_start_at_ms,season.regular_season_ends_at_ms??Infinity);
 const events=[];
 let cursor=start;
 for(let count=0;cursor<end&&count<800;count++) {
  const window=getAuctionCreationWindow({nowMs:cursor,timeZone,schedule,stagingDaily});
  if(window.bidClosesAtMs<end) {
   if(window.newAuctionCutoffAtMs>=start)events.push({id:'weekly-cutoff:'+window.newAuctionCutoffAtMs,kind:'auction-cutoff',label:'New-auction cutoff',atMs:window.newAuctionCutoffAtMs,recurring:true});
   if(window.bidClosesAtMs>=start)events.push({id:'weekly-close:'+window.bidClosesAtMs,kind:'auction',label:stagingDaily&&!schedule?'Daily auctions close':'Weekly auctions close',atMs:window.bidClosesAtMs,recurring:true});
  }
  if(window.nextOpensAtMs<=cursor)break;
  cursor=window.nextOpensAtMs;
 }
 return events;
}
module.exports={calendarAuctionEvents};
