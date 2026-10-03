const {digest}=require('../../../domain/leagues/leagueCommunicationPolicy');
const KINDS=new Set(['all','preseason_reset','pick_repair','pause','resume','reverse_correction','calendar','scoring','auction_schedule','trade_deadline','auction_timing','private_review','fad_timing','fad_cutoff','fad_deadline','roster_correction','communication','communication_archive','competition']);
function fail(message,code='LEAGUE_MANAGEMENT_INVALID'){const error=new Error(message);error.code=code;throw error;}
function createLeagueManagementService({repository,leagueAuthorization,clock}) {
  function read(input,work){
    leagueAuthorization.requireCommissioner(input.authenticated,input.leagueId);
    if(!repository)fail('League management reports are not available yet.','LEAGUE_MANAGEMENT_UNAVAILABLE');
    return repository.snapshot(()=>{leagueAuthorization.requireCommissioner(input.authenticated,input.leagueId);return work();});
  }
  return {
    readiness:input=>read(input,()=>repository.readiness(input.leagueId,clock.nowMs())),
    recovery:input=>read(input,()=>repository.recovery(input.leagueId,clock.nowMs())),
    'season-preview':input=>read(input,()=>repository.seasonPreview(input.leagueId,clock.nowMs())),
    export:input=>read(input,()=>repository.export(input.leagueId,clock.nowMs())),
    history(input) {return read(input,()=>{
      const options=input.query||{};
      if(Object.keys(options).some(k=>!['q','kind','cursor'].includes(k)))fail('Use the search, category and page controls.');
      const query=options.q??'',kind=options.kind??'all';
      if(typeof query!=='string'||query.length>120||!KINDS.has(kind))fail('Enter a search of up to 120 characters and a valid category.');
      const normalized=query.trim().toLowerCase(),scope=digest({leagueId:input.leagueId,query:normalized,kind});
      let beforeAt=null,beforeId=null;
      if(options.cursor!==undefined){
        try{
          if(typeof options.cursor!=='string'||options.cursor.length>600||!/^[a-zA-Z0-9_-]+$/.test(options.cursor))throw Error();
          const parsed=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));
          if(Object.keys(parsed).sort().join()!=='at,id,scope'||parsed.scope!==scope||!Number.isSafeInteger(parsed.at)||parsed.at<0||!/^[a-z_]+:[a-f0-9-]{36}$/.test(parsed.id))throw Error();
          beforeAt=parsed.at;beforeId=parsed.id;
        }catch{fail('The history page is no longer valid. Start a new search.');}
      }
      const page=repository.history({leagueId:input.leagueId,query:normalized,kind,beforeAt,beforeId}),last=page.rows.at(-1);
      return {leagueId:input.leagueId,changes:page.rows,page:{hasMore:page.hasMore,nextCursor:page.hasMore?Buffer.from(JSON.stringify({scope,at:last.at,id:last.id})).toString('base64url'):null}};
    });},
  };
}
module.exports={createLeagueManagementService};
