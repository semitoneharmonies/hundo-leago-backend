const express=require('express');
function createPlayerCatalogueControlRouter({requestSecurity:s,service}){
 const router=express.Router(),base='/api/v1/operations/catalogue';
 router.use(base,s.assignRequestId,s.securityHeaders,s.credentialedCors,s.requireAllowedOrigin,s.requireCompatibleFetchMetadata);
 const errors={PLATFORM_ADMINISTRATOR_REQUIRED:[403,'Platform-administrator authority is required.'],CATALOGUE_INVALID:[400,'Enter a valid NHL player ID and reason.'],
  CATALOGUE_IDENTITY_CONFLICT:[409,'A possible duplicate player needs identity review before import. Existing records were preserved.'],CATALOGUE_RETRY_CONFLICT:[409,'That operation ID belongs to a different request.'],
  CATALOGUE_PREVIEW_CHANGED:[409,'The player or affected state changed. Review a fresh preview.'],CATALOGUE_PROVIDER_UNAVAILABLE:[503,'The NHL player could not be verified. Check the ID and try again.']};
 function failed(req,res,error){const code=errors[error?.code]?error.code:'CATALOGUE_FAILED';const [status,message]=errors[code]||[503,'The catalogue change could not be completed.'];return res.set('Cache-Control','private, no-store').status(status).json({error:{code,message,requestId:s.getRequestId(req)}});}
 for(const [method,suffix,operation]of[['get','','read'],['post','/preview','preview'],['post','/apply','apply']])router[method](base+suffix,
  ...(method==='get'?[s.authenticateBootstrap]:[s.requireJson,express.json({limit:'4kb',strict:true}),s.authenticateUnsafe]),async(req,res)=>{
   try{const data=await service[operation]({authenticated:method==='get'?s.getSessionBootstrap(req):s.getAuthenticatedSession(req),search:req.query.search??'',input:req.body});res.set('Cache-Control','private, no-store').json({data,meta:{requestId:s.getRequestId(req)}});}catch(error){failed(req,res,error);}
  });
 router.use(base,(error,req,res,next)=>res.headersSent?next(error):failed(req,res,{code:'CATALOGUE_INVALID'}));return router;
}
module.exports={createPlayerCatalogueControlRouter};
