const express=require('express');
function createLeagueScoringRouter({requestSecurity:security,service}) {
 const router=express.Router();
 router.use(security.assignRequestId,security.securityHeaders,security.credentialedCors,security.requireAllowedOrigin,
  security.requireJson,security.requireCompatibleFetchMetadata,express.json({limit:'64kb',strict:true}));
 const messages={LEAGUE_ID_INVALID:[400,'The league identifier is invalid.'],LEAGUE_NOT_FOUND:[404,'The league was not found.'],
  LEAGUE_MEMBERSHIP_REQUIRED:[403,'Current league membership is required.'],LEAGUE_COMMISSIONER_REQUIRED:[403,'Current commissioner or administrator authority is required.']};
 function failed(req,res,error) {
  let code=error?.code,status,message;
  if(['LEAGUE_SCORING_INVALID','LEAGUE_SCORING_UNCHANGED','LEAGUE_SCORING_CONFLICT','LEAGUE_SCORING_PREVIEW_CHANGED','LEAGUE_SCORING_UNAVAILABLE'].includes(code)){
   status=code==='LEAGUE_SCORING_UNAVAILABLE'?503:code==='LEAGUE_SCORING_INVALID'||code==='LEAGUE_SCORING_UNCHANGED'?400:409;message=error.message;
  }else if(messages[code]){[status,message]=messages[code];}
  else {code='LEAGUE_SCORING_FAILED';status=500;message='The scoring rule change could not be completed.';}
  res.set('Cache-Control','private, no-store').status(status).json({error:{code,message,requestId:security.getRequestId(req)}});
 }
 const base='/api/v1/leagues/:leagueId/scoring';
 for(const [method,suffix,operation]of[['get','','read'],['get','/rules','rules'],['post','/preview','preview'],['post','/apply','apply']])router[method](base+suffix,
  method==='get'?security.authenticateBootstrap:security.authenticateUnsafe,(req,res)=>{
   try {const data=service[operation]({leagueId:req.params.leagueId,authenticated:method==='get'?security.getSessionBootstrap(req):security.getAuthenticatedSession(req),input:req.body,idempotencyKey:req.get('Idempotency-Key')});
    res.set('Cache-Control','private, no-store').json({data,meta:{requestId:security.getRequestId(req)}});
   }catch(error){failed(req,res,error);}
  });
 router.use((error,req,res,next)=>res.headersSent?next(error):failed(req,res,{code:'LEAGUE_SCORING_INVALID',message:'Enter a valid scoring rule request.'}));
 return router;
}
module.exports={createLeagueScoringRouter};


