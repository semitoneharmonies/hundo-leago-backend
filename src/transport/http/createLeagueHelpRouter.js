const express=require('express');
function createLeagueHelpRouter({requestSecurity:security,service}) {
 const router=express.Router();
 router.use(security.assignRequestId,security.securityHeaders,security.credentialedCors,security.requireAllowedOrigin,
  security.requireJson,security.requireCompatibleFetchMetadata,express.json({limit:'16kb',strict:true}));
 const codes={LEAGUE_HELP_INVALID:400,LEAGUE_HELP_NOT_FOUND:404,LEAGUE_HELP_CONFLICT:409,LEAGUE_HELP_FORBIDDEN:403,LEAGUE_HELP_UNAVAILABLE:503,
  LEAGUE_ID_INVALID:400,LEAGUE_NOT_FOUND:404,LEAGUE_MEMBERSHIP_REQUIRED:403,LEAGUE_COMMISSIONER_REQUIRED:403,TEAM_MANAGER_REQUIRED:403,TEAM_NOT_FOUND:404,TEAM_ID_INVALID:400};
 function failed(req,res,error) {
  const known=Object.hasOwn(codes,error?.code||''),code=known?error.code:'LEAGUE_HELP_FAILED';
  res.set('Cache-Control','private, no-store').status(known?codes[code]:500).json({error:{code,message:known?error.message:'The help request could not be completed.',requestId:security.getRequestId(req)}});
 }
 const base='/api/v1/leagues/:leagueId/help';
 for(const [method,suffix,operation]of[['get','','read'],['get','/targets','targets'],['get','/:requestId','detail'],['post','','create'],['post','/:requestId/events','event']])router[method](base+suffix,
  method==='get'?security.authenticateBootstrap:security.authenticateUnsafe,(req,res)=>{
   try {const data=service[operation]({leagueId:req.params.leagueId,requestId:req.params.requestId,query:req.query,
    authenticated:method==='get'?security.getSessionBootstrap(req):security.getAuthenticatedSession(req),input:req.body,idempotencyKey:req.get('Idempotency-Key')});
    res.set('Cache-Control','private, no-store').json({data,meta:{requestId:security.getRequestId(req)}});
   }catch(error){failed(req,res,error);}
  });
 router.use((error,req,res,next)=>res.headersSent?next(error):failed(req,res,{code:'LEAGUE_HELP_INVALID',message:'Enter a valid help request.'}));
 return router;
}
module.exports={createLeagueHelpRouter};
