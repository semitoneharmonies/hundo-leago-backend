const express=require('express');
function createCorrectionReversalRouter({requestSecurity:s,service}){
 const router=express.Router(),base='/api/v1/leagues/:leagueId/management/reversals';
 router.use(s.assignRequestId,s.securityHeaders,s.credentialedCors,s.requireAllowedOrigin,s.requireCompatibleFetchMetadata,s.requireJson,express.json({limit:'4kb',strict:true}));
 function failed(req,res,e){let status=500,code='CORRECTION_REVERSAL_FAILED',message='The reversal could not be completed.';
  if(['LEAGUE_COMMISSIONER_REQUIRED','LEAGUE_MEMBERSHIP_REQUIRED'].includes(e?.code)){status=403;code=e.code;message='Current commissioner or administrator authority is required.';}
  else if(e?.code==='LEAGUE_NOT_FOUND'){status=404;code=e.code;message='The league was not found.';}
  else if(e?.code==='LEAGUE_ID_INVALID'){status=400;code=e.code;message='The league identifier is invalid.';}
  else if(e?.code?.startsWith('CORRECTION_REVERSAL_')){code=e.code;status=code.endsWith('INVALID')?400:code.endsWith('UNAVAILABLE')?503:409;message=e.message;}
  else if(e?.code==='COMMISSIONER_CORRECTION_INPUT_INVALID'||e?.code?.startsWith('REPOSITORY_')){status=409;code='CORRECTION_REVERSAL_CONFLICT';message='Current roster, contract or transaction dependencies prevent this reversal. Use the existing correction tools.';}
  res.set('Cache-Control','private, no-store').status(status).json({error:{code,message,requestId:s.getRequestId(req)}});
 }
 for(const [method,suffix,operation]of[['get','','read'],['post','/preview','preview'],['post','/apply','apply']])router[method](base+suffix,method==='get'?s.authenticateBootstrap:s.authenticateUnsafe,async(req,res)=>{
  try{const data=await service[operation]({leagueId:req.params.leagueId,authenticated:method==='get'?s.getSessionBootstrap(req):s.getAuthenticatedSession(req),input:req.body,idempotencyKey:req.get('Idempotency-Key')});res.set('Cache-Control','private, no-store').json({data,meta:{requestId:s.getRequestId(req)}});}catch(e){failed(req,res,e);}
 });router.use((e,req,res,next)=>res.headersSent?next(e):failed(req,res,{code:'CORRECTION_REVERSAL_INVALID',message:'Enter a valid reversal request.'}));return router;
}
module.exports={createCorrectionReversalRouter};
