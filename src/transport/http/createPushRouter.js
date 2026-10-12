const express = require('express');
function createPushRouter({ requestSecurity, service }) {
  const router=express.Router();
  for(const name of ['assignRequestId','securityHeaders','credentialedCors','requireAllowedOrigin','requireJson','requireCompatibleFetchMetadata']) router.use(requestSecurity[name]);
  router.use(express.json({limit:'8kb',strict:true}));
  function failure(request,response,error) {
    const status=error?.code==='PUSH_INPUT_INVALID'?400:error?.code==='PUSH_DEVICE_LIMIT'?409:error?.code==='PUSH_UNAVAILABLE'?503:error?.code==='LEAGUE_NOT_FOUND'?403:error?.type==='entity.too.large'?413:error?.type==='entity.parse.failed'?400:500;
    response.status(status).json({error:{code:status===500?'PUSH_REQUEST_FAILED':error.code||'PUSH_INPUT_INVALID',message:'Could not update notifications.',requestId:requestSecurity.getRequestId(request)}});
  }
  function handle(method) { return (req,res)=>{ try {
    const authenticated=req.method==='GET'?requestSecurity.getSessionBootstrap(req):requestSecurity.getAuthenticatedSession(req);
    const data=method==='settings'?service.settings(authenticated):service[method]({authenticated,input:req.body});
    res.set('Cache-Control','no-store').json({data,meta:{requestId:requestSecurity.getRequestId(req)}});
  } catch(error){failure(req,res,error);} }; }
  router.get('/api/v1/push/settings',requestSecurity.authenticateBootstrap,handle('settings'));
  router.post('/api/v1/push/settings',requestSecurity.authenticateUnsafe,handle('save'));
  router.post('/api/v1/push/subscriptions',requestSecurity.authenticateUnsafe,handle('subscribe'));
  router.post('/api/v1/push/subscriptions/remove',requestSecurity.authenticateUnsafe,handle('unsubscribe'));
  router.use((error,req,res,next)=>res.headersSent?next(error):failure(req,res,error));
  return router;
}
module.exports={createPushRouter};
