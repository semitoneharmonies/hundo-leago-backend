const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const UUID=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail(message,code='LEAGUE_HELP_INVALID'){const error=new Error(message);error.code=code;throw error;}
function exact(value,keys){if(!value||Object.keys(value).sort().join()!==keys)fail('Enter a complete help request.');}
function text(value,max){if(typeof value!=='string'||value.trim().length<3||value.trim().length>max||/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value))fail('Enter a valid subject or message.');return value.trim();}
function key(value){try{return clientKey(value);}catch{fail('A valid retry key is required.');}}
function createLeagueHelpService({repository,leagueAuthorization,teamAuthorization,clock}){
  function authority(authenticated,leagueId){
    const actor=leagueAuthorization.requireActiveMembership(authenticated,leagueId);if(!repository)fail('League help is not available yet.','LEAGUE_HELP_UNAVAILABLE');
    let manage=false;try{leagueAuthorization.requireCommissioner(authenticated,leagueId);manage=true;}catch(error){if(error.code!=='LEAGUE_COMMISSIONER_REQUIRED')throw error;}
    return {...actor,manage};
  }
  function find(leagueId,id,actor){
    if(!UUID.test(id||''))fail('The request identifier is invalid.');const request=repository.find(leagueId,id);
    if(!request||!actor.manage&&request.requesterUserId!==actor.actorUserId)fail('The help request was not found.','LEAGUE_HELP_NOT_FOUND');return request;
  }
  return {
    read({leagueId,authenticated,query={}}){
      const actor=authority(authenticated,leagueId);if(Object.keys(query).some(k=>!['status','cursor'].includes(k)))fail('Use the help status and page controls.');
      const status=query.status||'open';if(!['open','closed','all'].includes(status))fail('Choose open, closed or all requests.');
      const scope=digest({leagueId,userId:actor.actorUserId,manage:actor.manage,status});let beforeAt=null,beforeId=null;
      if(query.cursor!==undefined){try{if(typeof query.cursor!=='string'||query.cursor.length>600)throw Error();const c=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));
        if(c.scope!==scope||!Number.isSafeInteger(c.at)||c.at<0||!UUID.test(c.id))throw Error();beforeAt=c.at;beforeId=c.id;}catch{fail('Start a new help-queue search.');}}
      const rows=repository.list({leagueId,userId:actor.actorUserId,manage:actor.manage,status,beforeAt,beforeId}),requests=rows.slice(0,50),last=requests.at(-1);
      return {leagueId,canManage:actor.manage,teams:repository.teams(leagueId,actor.actorUserId),requests,
        cardHelp:repository.cardHelp(leagueId,actor.actorUserId,actor.manage,clock.nowMs()),nextCursor:rows.length>50?Buffer.from(JSON.stringify({scope,at:last.createdAtMs,id:last.id})).toString('base64url'):null};
    },
    targets({leagueId,authenticated,query}){
      authority(authenticated,leagueId);exact(query,'kind,teamId');if(!['general','auction','roster','trade'].includes(query.kind))fail('Choose a supported help category.');
      teamAuthorization.requireManager(authenticated,leagueId,query.teamId);
      return {leagueId,teamId:query.teamId,kind:query.kind,targets:repository.targets(leagueId,query.teamId,query.kind)};
    },
    detail({leagueId,authenticated,requestId}){const actor=authority(authenticated,leagueId),request=find(leagueId,requestId,actor);return {leagueId,canManage:actor.manage,isRequester:request.requesterUserId===actor.actorUserId,request,events:repository.events(leagueId,requestId)};},
    create({leagueId,authenticated,input:value,idempotencyKey}){
      authority(authenticated,leagueId);exact(value,'kind,message,subject,targetId,teamId');
      if(!UUID.test(value.teamId||'')||!['general','auction','roster','trade'].includes(value.kind)||!(value.kind==='general'?value.targetId===null:UUID.test(value.targetId||'')))fail('Choose your team and an affected record.');
      const p={teamId:value.teamId,kind:value.kind,targetId:value.targetId,subject:text(value.subject,120),message:text(value.message,2000)},client=key(idempotencyKey),hash=digest(p);
      return repository.transaction(()=>{
        const actor=authority(authenticated,leagueId);teamAuthorization.requireManager(authenticated,leagueId,p.teamId);
        const prior=repository.createReplay(leagueId,actor.actorUserId,client);
        if(prior){if(prior.request_hash!==hash)fail('This retry key belongs to a different request.','LEAGUE_HELP_CONFLICT');return {leagueId,id:prior.id,accepted:true,replayed:true};}
        if(!repository.teams(leagueId,actor.actorUserId).some(t=>t.id===p.teamId))fail('Choose a currently managed team.');
        const target=p.kind==='general'?{label:'General league help'}:repository.targets(leagueId,p.teamId,p.kind).find(t=>t.id===p.targetId);
        if(!target)fail('That record is no longer available to your team.','LEAGUE_HELP_CONFLICT');
        const result=repository.create({leagueId,actorUserId:actor.actorUserId,input:p,targetLabel:target.label,clientKey:client,requestHash:hash,nowMs:clock.nowMs()});
        return {leagueId,id:result.id,accepted:true,replayed:false};
      });
    },
    event({leagueId,requestId,authenticated,input:value,idempotencyKey}){
      authority(authenticated,leagueId);exact(value,'action,expectedVersion,message');
      if(!['reply','resolve','withdraw','reopen'].includes(value.action)||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1)fail('Choose a valid help-request action.');
      const p={action:value.action,expectedVersion:value.expectedVersion,message:text(value.message,2000)},client=key(idempotencyKey),hash=digest({requestId,...p});
      return repository.transaction(()=>{
        const actor=authority(authenticated,leagueId),request=find(leagueId,requestId,actor),own=request.requesterUserId===actor.actorUserId;
        if(p.action==='resolve'&&!actor.manage||p.action==='withdraw'&&!own)fail('This help action is not available to your role.','LEAGUE_HELP_FORBIDDEN');
        const prior=repository.eventReplay(leagueId,actor.actorUserId,client);
        if(prior){if(prior.request_hash!==hash||prior.request_id!==requestId)fail('This retry key belongs to another action.','LEAGUE_HELP_CONFLICT');return {leagueId,id:prior.id,requestId,accepted:true,replayed:true};}
        if(request.version!==p.expectedVersion)fail('This request changed. Refresh before replying.','LEAGUE_HELP_CONFLICT');
        if(p.action==='reopen'?request.status==='open':request.status!=='open')fail('Refresh the request and choose an available action.','LEAGUE_HELP_CONFLICT');
        const result=repository.event({leagueId,request,actorUserId:actor.actorUserId,input:p,clientKey:client,requestHash:hash,nowMs:clock.nowMs()});
        return {leagueId,...result,accepted:true,replayed:false};
      });
    },
  };
}
module.exports={createLeagueHelpService};
