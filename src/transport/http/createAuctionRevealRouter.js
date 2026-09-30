const express=require('express');
function createAuctionRevealRouter({requestSecurity:security,service}) {
  const router=express.Router();
  router.use(security.assignRequestId,security.securityHeaders,security.credentialedCors,security.requireAllowedOrigin,
    security.requireJson,security.requireCompatibleFetchMetadata,express.json({limit:'8kb',strict:true}));
  router.post('/api/v1/leagues/:leagueId/auctions/:auctionId/administration/reveal',security.authenticateUnsafe,(req,res)=>{
    try {
      const data=service.reveal({leagueId:req.params.leagueId,auctionId:req.params.auctionId,input:req.body,
        idempotencyKey:req.get('Idempotency-Key'),authenticated:security.getAuthenticatedSession(req)});
      res.set('Cache-Control','private, no-store').json({data,meta:{requestId:security.getRequestId(req)}});
    } catch(error) {
      const errors={PRIVATE_REVEAL_INVALID:[400,'Enter a reason and confirm the private information you need to see.'],
        PRIVATE_REVEAL_NOT_FOUND:[404,'That auction or bid is unavailable.'],PRIVATE_REVEAL_UNAVAILABLE:[503,'Private review is unavailable.'],
        PRIVATE_REVEAL_CONFLICT:[409,'Start a new private review.'],LEAGUE_COMMISSIONER_REQUIRED:[403,'Current commissioner or administrator authority is required.'],
        LEAGUE_NOT_FOUND:[404,'The league is unavailable.'],LEAGUE_ID_INVALID:[400,'The league is invalid.']};
      const code=Object.hasOwn(errors,error?.code||'')?error.code:'PRIVATE_REVEAL_FAILED';
      const [status,message]=errors[code]||[500,'Private information could not be opened.'];
      res.set('Cache-Control','private, no-store').status(status).json({error:{code,message,requestId:security.getRequestId(req)}});
    }
  });
  router.use((error,req,res,next)=>res.headersSent?next(error):res.status(400).set('Cache-Control','private, no-store').json({error:{code:'PRIVATE_REVEAL_INVALID',message:'The private review request is invalid.'}}));
  return router;
}
module.exports={createAuctionRevealRouter};
