const express=require('express');
function createLeagueManagementRouter({requestSecurity:security,service}) {
  const router=express.Router();
  router.use(security.assignRequestId,security.securityHeaders,security.credentialedCors,security.requireAllowedOrigin,
    security.requireJson,security.requireCompatibleFetchMetadata);
  const errors={LEAGUE_ID_INVALID:[400,'The league identifier is invalid.'],LEAGUE_NOT_FOUND:[404,'The league was not found.'],
    LEAGUE_COMMISSIONER_REQUIRED:[403,'Current commissioner or administrator authority is required.']};
  for(const operation of ['readiness','history','export','recovery','season-preview'])router.get('/api/v1/leagues/:leagueId/management/'+operation,security.authenticateBootstrap,(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try {
      const data=service[operation]({leagueId:req.params.leagueId,authenticated:security.getSessionBootstrap(req),query:req.query});
      res.json({data,meta:{requestId:security.getRequestId(req)}});
    }catch(error){
      let code=error?.code,status,message;
      if(errors[code])[status,message]=errors[code];
      else if(code==='LEAGUE_MANAGEMENT_INVALID'){status=400;message=error.message;}
      else if(code==='LEAGUE_MANAGEMENT_UNAVAILABLE'){status=503;message=error.message;}
      else {code='LEAGUE_MANAGEMENT_FAILED';status=500;message='The league management report could not be loaded.';}
      res.status(status).json({error:{code,message,requestId:security.getRequestId(req)}});
    }
  });
  return router;
}
module.exports={createLeagueManagementRouter};
