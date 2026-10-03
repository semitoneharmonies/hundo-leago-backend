const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const calendarPolicy=require('../../../domain/leagues/leagueCalendarPolicy');
const schedulePolicy=require('../../../domain/leagues/leagueAuctionSchedulePolicy');
const tradePolicy=require('../../../domain/leagues/tradeDeadlineChangePolicy');
const auctionPolicy=require('../../../domain/auctions/auctionTimingPolicy');
const fadPolicy=require('../../../domain/freeAgentDraft/fadTimingChangePolicy');
const {calendarWarnings}=require('../../../domain/leagues/calendarWorkspaceWarnings');
const {nhlCalendarBreaks}=require('../../../domain/leagues/nhlCalendarBreaks');

// Compose existing guarded corrections in a single transaction. Preview does
// not write or start jobs. Only public clock metadata leaves this service.
function createCalendarWorkspaceService({repositories:r,services,leagueAuthorization,clock}) {
 const fail=calendarPolicy.fail;
 const definitions={calendar:[r.leagueCalendar,calendarPolicy.plan],schedule:[r.leagueAuctionSchedule,schedulePolicy.plan],
  trade:[r.tradeDeadlineChange,tradePolicy.plan],auction:[r.auctionTiming,auctionPolicy.plan],fad:[r.fadTiming,fadPolicy.planTimingChange]};
 function parsed(value) {
  if(!value||Object.keys(value).sort().join()!=='expectedVersion,operations,reason'||!/^[a-f0-9]{64}$/.test(value.expectedVersion||'')||typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500||/[\u0000-\u001f\u007f-\u009f]/u.test(value.reason)||!Array.isArray(value.operations)||!value.operations.length||value.operations.length>100)
   fail('Choose changes and enter a reason.','LEAGUE_CALENDAR_INVALID');
  const seen=new Set();
  const operations=value.operations.map(op=>{
   if(!op||!Object.hasOwn(definitions,op.kind)||Object.keys(op).sort().join()!=='id,kind,value'||!op.value||typeof op.value!=='object'||Array.isArray(op.value))fail('Invalid calendar change.','LEAGUE_CALENDAR_INVALID');
   if(['auction','fad'].includes(op.kind)?!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(op.id||''):op.id!==null)fail('Invalid calendar event.','LEAGUE_CALENDAR_INVALID');
   const key=op.kind+':'+op.id;if(seen.has(key))fail('An event can only have one proposed change.','LEAGUE_CALENDAR_INVALID');seen.add(key);
   return {kind:op.kind,id:op.id,value:{...op.value,reason:value.reason.trim()}};
  });
  return {expectedVersion:value.expectedVersion,reason:value.reason.trim(),operations};
 }
 function version(leagueId){
  const base=r.leagueCalendar.state(leagueId),metadata=r.leagueCalendar.workspaceMetadata(leagueId);
  return digest({base,schedule:r.leagueAuctionSchedule.state(leagueId),trade:r.tradeDeadlineChange.state(leagueId),
   drafts:metadata.drafts.map(d=>r.fadTiming.state(leagueId,d.id)),auctions:metadata.auctions.map(a=>r.auctionTiming.state(leagueId,a.id))});
 }
 function state(op,leagueId){const repository=definitions[op.kind][0];if(!repository)fail('Calendar controls are unavailable.','LEAGUE_CALENDAR_UNAVAILABLE');return repository.state(leagueId,...(op.id?[op.id]:[]));}
 function readableError(error,op){
  if(error.code?.startsWith('LEAGUE_CALENDAR'))throw error;
  const names={fad:'Free Agent Draft',auction:'Auction',trade:'Trade deadline',schedule:'Weekly auction schedule'};
  const hints={FAD_TIMING_INVALID:'Keep the card deadline and rounds in order, before Week 1, with room for the auction cutoff.',FAD_TIMING_CONFLICT:'Processing has started or a round needs recovery.',AUCTION_TIMING_NOT_FUTURE:'Choose a future closing time.',AUCTION_TIMING_SEASON_BOUNDARY:'The auction must close before playoffs.',TRADE_DEADLINE_CHANGE_NOT_FUTURE:'Choose a future trade deadline.'};
  const message=hints[error.code]||(/^[A-Z_]+$/.test(error.message||'')?'The saved timing is protected or unchanged. Review this event.':error.message);
  fail((names[op.kind]||'Calendar')+': '+message);
 }
 function review(leagueId,actor,proposed) {
  if(version(leagueId)!==proposed.expectedVersion)fail('The saved schedule changed while you were editing. Reload the calendar before reviewing.','LEAGUE_CALENDAR_PREVIEW_CHANGED');
  const base=r.leagueCalendar.state(leagueId),snapshots=proposed.operations.map(op=>state(op,leagueId));
  const season=proposed.operations.find(op=>op.kind==='calendar')?.value.calendar;
  const plans=proposed.operations.map((op,i)=>{
   let s=snapshots[i];
   if(op.kind==='calendar')s={...s,openAuctions:s.openAuctions.map(a=>({...a,resolves_at_ms:proposed.operations.find(x=>x.kind==='auction'&&x.id===a.id)?.value.closesAtMs??a.resolves_at_ms}))};
   if(op.kind==='auction'&&season)s={...s,season:{...s.season,...Object.fromEntries(Object.entries(calendarPolicy.SEASON_FIELDS).map(([key,col])=>[col,season[key]]))}};
   try{return definitions[op.kind][1](s,op.value,clock.nowMs());}catch(error){readableError(error,op);}
  });
  const finalCalendar=season||calendarPolicy.calendar(base).calendar;
  const finalWeeks=plans.find((p,i)=>proposed.operations[i].kind==='calendar')?.after.weeks||calendarPolicy.calendar(base).weeks;
  const warnings=calendarWarnings({calendar:finalCalendar,weeks:finalWeeks,statuses:base.weeks,operations:proposed.operations,plans,timeZone:base.league.timezone});
  return {snapshots,plans,base,warnings,previewHash:digest({base,snapshots,proposed,actor:actor.actorUserId,warnings})};
 }
 return {
  read(args){
   leagueAuthorization.requireCommissioner(args.authenticated,args.leagueId);
   const base=services.leagueCalendar.read(args),metadata=r.leagueCalendar.workspaceMetadata(args.leagueId);
   return {...base,expectedVersion:version(args.leagueId),breaks:nhlCalendarBreaks(base.calendar,base.timeZone),schedule:services.leagueAuctionSchedule.read(args),trade:services.tradeDeadlineChange.read(args),
    drafts:metadata.drafts.map(d=>({...d,...services.fadTiming.read({...args,fadId:d.id})})),
    auctions:metadata.auctions.map(a=>({...a,...services.auctionTiming.read({...args,auctionId:a.id})}))};
  },
  preview({leagueId,authenticated,input}){
   const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId),proposed=parsed(input),p=review(leagueId,actor,proposed);
   return {leagueId,proposed,previewHash:p.previewHash,warnings:p.warnings,changeCount:proposed.operations.length};
  },
  apply({leagueId,authenticated,input,idempotencyKey}){
   const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);
   if(!input||Object.keys(input).sort().join()!=='confirmed,expectedVersion,operations,previewHash,reason'||input.confirmed!==true||!/^[a-f0-9]{64}$/.test(input.previewHash||''))fail('Review all changes before saving.','LEAGUE_CALENDAR_INVALID');
   const proposed=parsed({operations:input.operations,reason:input.reason,expectedVersion:input.expectedVersion});let key;
   try{key='calendar-batch:'+digest(clientKey(idempotencyKey));}catch{fail('A confirmation key is required.','LEAGUE_CALENDAR_INVALID');}
   const requestHash=digest({proposed,previewHash:input.previewHash});
   return r.leagueCalendar.transaction(()=>{
    leagueAuthorization.requireCommissioner(authenticated,leagueId);
    // Check all receipt types, so reusing a key with a different first operation
    // cannot create a second batch. Each subreceipt is committed atomically.
    const previous=Object.values(definitions).flatMap(([repo])=>repo?.replay(leagueId,actor.actorUserId,key+':0')||[]);
    if(previous.length){if(previous.length!==1||previous[0].request_hash!==requestHash)fail('This confirmation was already used for different changes.');return {leagueId,id:previous[0].id,accepted:true,replayed:true};}
    const p=review(leagueId,actor,proposed);
    if(p.previewHash!==input.previewHash)fail('The league schedule changed. Review your draft again.','LEAGUE_CALENDAR_PREVIEW_CHANGED');
    let id;
    // SQLite also enforces the current season boundary at each statement.
    // Extend the season before later auctions; shorten auctions before the
    // season. Every effect, including notices, remains one transaction.
    const calendarIndex=proposed.operations.findIndex(op=>op.kind==='calendar'),oldLimit=Math.min(p.base.season.fantasy_playoffs_start_at_ms,p.base.season.regular_season_ends_at_ms);
    const next=calendarIndex<0?null:p.plans[calendarIndex].proposed.calendar,calendarFirst=next&&Math.min(next.fantasyPlayoffsStartAtMs,next.regularSeasonEndsAtMs)>=oldLimit;
    const order=proposed.operations.map((op,i)=>i).sort((a,b)=>((a===calendarIndex)-(b===calendarIndex))*(calendarFirst?-1:1));
    for(const i of order){const op=proposed.operations[i],repository=definitions[op.kind][0],s=state(op,leagueId);
     const receipt=repository.apply({state:s,plan:p.plans[i],proposed:p.plans[i].proposed,actorUserId:actor.actorUserId,authority:actor.authority,clientKey:key+':'+i,requestHash,nowMs:clock.nowMs()});
     if(i===0)id=receipt.id;
    }
    return {leagueId,id,accepted:true,replayed:false};
   });
  },
 };
}
module.exports={createCalendarWorkspaceService};
