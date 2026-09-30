const express=require('express');
function createLeagueCalendarRouter({requestSecurity:security,service}) {
 const router=express.Router();
 router.use(security.assignRequestId,security.securityHeaders,security.credentialedCors,security.requireAllowedOrigin,
  security.requireJson,security.requireCompatibleFetchMetadata,express.json({limit:'64kb',strict:true}));
 const messages={LEAGUE_ID_INVALID:[400,'The league identifier is invalid.'],LEAGUE_NOT_FOUND:[404,'The league was not found.'],
  LEAGUE_COMMISSIONER_REQUIRED:[403,'Current commissioner or administrator authority is required.']};
 function failed(req,res,error) {
  let code=error?.code,status,message;
  if(['LEAGUE_CALENDAR_INVALID','LEAGUE_CALENDAR_UNCHANGED','LEAGUE_CALENDAR_CONFLICT','LEAGUE_CALENDAR_PREVIEW_CHANGED','LEAGUE_CALENDAR_UNAVAILABLE'].includes(code)){
   status=code==='LEAGUE_CALENDAR_UNAVAILABLE'?503:code==='LEAGUE_CALENDAR_INVALID'||code==='LEAGUE_CALENDAR_UNCHANGED'?400:409;message=error.message;
  }else if(messages[code]){[status,message]=messages[code];}
  else {code='LEAGUE_CALENDAR_FAILED';status=500;message='The calendar change could not be completed.';}
  res.set('Cache-Control','private, no-store').status(status).json({error:{code,message,requestId:security.getRequestId(req)}});
 }
 const base='/api/v1/leagues/:leagueId/calendar/season';
 for(const [method,suffix,operation]of[['get','','read'],['post','/preview','preview'],['post','/apply','apply']])router[method](base+suffix,
  method==='get'?security.authenticateBootstrap:security.authenticateUnsafe,(req,res)=>{
   try {const data=service[operation]({leagueId:req.params.leagueId,authenticated:method==='get'?security.getSessionBootstrap(req):security.getAuthenticatedSession(req),input:req.body,idempotencyKey:req.get('Idempotency-Key')});
    res.set('Cache-Control','private, no-store').json({data,meta:{requestId:security.getRequestId(req)}});
   }catch(error){failed(req,res,error);}
  });
 router.use((error,req,res,next)=>res.headersSent?next(error):failed(req,res,{code:'LEAGUE_CALENDAR_INVALID',message:'Enter a valid calendar request.'}));
 return router;
}
module.exports={createLeagueCalendarRouter};

