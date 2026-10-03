const express=require('express');
function createLeaguePickRepairRouter({requestSecurity:security,service}) {
 const router=express.Router();
 router.use(security.assignRequestId,security.securityHeaders,security.credentialedCors,security.requireAllowedOrigin,
  security.requireJson,security.requireCompatibleFetchMetadata,express.json({limit:'64kb',strict:true}));
 const messages={LEAGUE_ID_INVALID:[400,'The league identifier is invalid.'],LEAGUE_NOT_FOUND:[404,'The league was not found.'],
  LEAGUE_MEMBERSHIP_REQUIRED:[403,'Current league membership is required.'],LEAGUE_COMMISSIONER_REQUIRED:[403,'Current commissioner or administrator authority is required.']};
 function failed(req,res,error) {
  let code=error?.code,status,message;
  if(['PICK_REPAIR_INVALID','PICK_REPAIR_UNCHANGED','PICK_REPAIR_CONFLICT','PICK_REPAIR_PREVIEW_CHANGED','PICK_REPAIR_UNAVAILABLE'].includes(code)){
   status=code==='PICK_REPAIR_UNAVAILABLE'?503:code==='PICK_REPAIR_INVALID'||code==='PICK_REPAIR_UNCHANGED'?400:409;message=error.message;
  }else if(messages[code]){[status,message]=messages[code];}
  else {code='PICK_REPAIR_FAILED';status=500;message='The draft-pick repair could not be completed.';}
  res.set('Cache-Control','private, no-store').status(status).json({error:{code,message,requestId:security.getRequestId(req)}});
 }
 const base='/api/v1/leagues/:leagueId/management/picks';
 for(const [method,suffix,operation]of[['get','','read'],['post','/preview','preview'],['post','/apply','apply']])router[method](base+suffix,
  method==='get'?security.authenticateBootstrap:security.authenticateUnsafe,(req,res)=>{
   try {const data=service[operation]({leagueId:req.params.leagueId,authenticated:method==='get'?security.getSessionBootstrap(req):security.getAuthenticatedSession(req),input:req.body,idempotencyKey:req.get('Idempotency-Key')});
    res.set('Cache-Control','private, no-store').json({data,meta:{requestId:security.getRequestId(req)}});
   }catch(error){failed(req,res,error);}
  });
 router.use((error,req,res,next)=>res.headersSent?next(error):failed(req,res,{code:'PICK_REPAIR_INVALID',message:'Enter a valid draft-pick repair request.'}));
 return router;
}
module.exports={createLeaguePickRepairRouter};


