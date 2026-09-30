const express=require('express');
function createTradeDeadlineChangeRouter({requestSecurity:security,service}){
  const router=express.Router();
  router.use(security.assignRequestId,security.securityHeaders,security.credentialedCors,security.requireAllowedOrigin,
    security.requireJson,security.requireCompatibleFetchMetadata,express.json({limit:'8kb',strict:true}));
  const messages={
    TRADE_DEADLINE_CHANGE_INVALID:[400,'Enter a valid date, reason and confirmation.'],
    TRADE_DEADLINE_CHANGE_NOT_FUTURE:[400,'Choose a future trade deadline.'],
    TRADE_DEADLINE_CHANGE_UNCHANGED:[400,'Choose a different trade deadline.'],
    TRADE_DEADLINE_CHANGE_CONFLICT:[409,'The league or proposals need attention before changing the deadline.'],
    TRADE_DEADLINE_CHANGE_PREVIEW_CHANGED:[409,'The league or proposals changed. Review a fresh preview.'],
    TRADE_DEADLINE_CHANGE_KEY_CONFLICT:[409,'This confirmation was used for a different change. Review again.'],
    TRADE_DEADLINE_CHANGE_UNAVAILABLE:[503,'Trade deadline controls are not available yet.'],
    LEAGUE_ID_INVALID:[400,'The league identifier is invalid.'],LEAGUE_NOT_FOUND:[404,'The league was not found.'],
    LEAGUE_COMMISSIONER_REQUIRED:[403,'Current commissioner or administrator authority is required.'],
  };
  function failed(req,res,error){const code=Object.hasOwn(messages,error?.code||'')?error.code:'TRADE_DEADLINE_CHANGE_FAILED';
    const [status,message]=messages[code]||[500,'The trade deadline change could not be completed.'];
    res.set('Cache-Control','private, no-store').status(status).json({error:{code,message,requestId:security.getRequestId(req)}});}
  const base='/api/v1/leagues/:leagueId/calendar/trade-deadline';
  for(const [method,suffix,operation]of[['get','','read'],['post','/preview','preview'],['post','/apply','apply']])router[method](base+suffix,
    method==='get'?security.authenticateBootstrap:security.authenticateUnsafe,(req,res)=>{
      try{const data=service[operation]({leagueId:req.params.leagueId,authenticated:method==='get'?security.getSessionBootstrap(req):security.getAuthenticatedSession(req),input:req.body,idempotencyKey:req.get('Idempotency-Key')});
        res.set('Cache-Control','private, no-store').json({data,meta:{requestId:security.getRequestId(req)}});
      }catch(error){failed(req,res,error);}
    });
  router.use((error,req,res,next)=>res.headersSent?next(error):failed(req,res,{code:'TRADE_DEADLINE_CHANGE_INVALID'}));
  return router;
}
module.exports={createTradeDeadlineChangeRouter};
