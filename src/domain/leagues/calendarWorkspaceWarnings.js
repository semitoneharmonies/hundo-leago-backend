const {nhlCalendarBreaks}=require('./nhlCalendarBreaks');
function calendarWarnings({calendar,weeks,statuses,operations,plans,timeZone}) {
 const warnings=[],day=ms=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
 const add=(code,message)=>warnings.push({code,message});
 const changed=plans.flatMap((p,i)=>operations[i].kind==='calendar'?p.changes:[]);
 const ordered=[...weeks].sort((a,b)=>a.startsAtMs-b.startsAtMs);
 if(plans.some((p,i)=>operations[i].kind==='calendar'&&p.seasonFields?.some(f=>f.startsWith('fantasyPlayoffs')))){
  const length=Math.round((Date.parse(day(calendar.fantasyPlayoffsEndAtMs))-Date.parse(day(calendar.fantasyPlayoffsStartAtMs)))/86400000);
  if(length!==28)add('playoff-length','The playoffs span '+length+' days instead of four weeks. Round 1 and Round 2 each use one week; the Final uses the remaining time.');
 }
 for(const change of changed){
  const w=weeks.find(w=>w.id===change.id),length=Math.round((Date.parse(day(w.endsAtMs))-Date.parse(day(w.startsAtMs)))/86400000);
  if(length!==7)add('unusual-week:'+w.id,'Week '+change.sequence+' spans '+length+' calendar days instead of seven.');
  if(change.fields.includes('locksAtMs'))add('roster-lock:'+w.id,'Week '+change.sequence+' roster lock will move with this change.');
 }
 if(changed.length)for(let i=1;i<ordered.length;i++)if(ordered[i-1].endsAtMs<ordered[i].startsAtMs)add('gap:'+ordered[i].id,'There is time without a matchup before Week '+statuses.find(s=>s.id===ordered[i].id)?.sequence+'. Games in that gap will not score.');
 for(const b of nhlCalendarBreaks(calendar,timeZone))for(const c of changed){
  const w=weeks.find(w=>w.id===c.id);
  if(day(w.startsAtMs)>=b.firstDay&&day(w.startsAtMs)<=b.lastDay)add('break:'+c.id+':'+b.id,'Week '+c.sequence+' starts during the '+b.label.toLowerCase()+'.');
 }
 const trade=operations.find(op=>op.kind==='trade');
 if(trade&&trade.value.tradeDeadlineAtMs>=calendar.fantasyPlayoffsStartAtMs)add('trade-playoffs','The trade deadline is during or after the playoffs.');
 for(const [i,op]of operations.entries()){
  const p=plans[i];
  if(op.kind==='calendar'&&(p.closesAuctions||p.reopensAuctions))add('auction-season','This moves the boundary for starting in-season auctions.');
  if(op.kind==='schedule')add('recurring-auctions','This changes the weekly rule for new auctions. Existing auctions keep their dates unless also edited here.');
  if(op.kind==='auction'&&p.shortened)add('shorter-auction:'+op.id,'An existing auction will close earlier. Saved bids remain unchanged.');
  if(op.kind==='trade'&&(p.impact.shortened||p.impact.extended||p.impact.reopensDeadline))add('trade-proposals','The trade window or pending proposal deadlines will change; expired proposals stay expired.');
  if(op.kind==='fad')add('fad:'+op.id,'Draft round openings and new-auction cutoffs will follow the revised deadline and closing times.'+(p.auctionChanges.length?' '+p.auctionChanges.length+' active draft auctions will move too.':''));
 }
 return warnings;
}
module.exports={calendarWarnings};
