const express = require('express');
function createMrBoniRouter({ requestSecurity, mrBoniService, publicService, rateLimiter, networkSourceResolver = request => request.ip } = {}) {
  const router = express.Router();
  for (const name of ['assignRequestId', 'securityHeaders', 'credentialedCors', 'requireAllowedOrigin', 'requireJson', 'requireCompatibleFetchMetadata']) router.use(requestSecurity[name]);
  router.use(express.json({ limit: '1mb', strict: true }));
  function failure(request, response, error) {
    const code = error?.code || '';
    const status = ['LEAGUE_NOT_FOUND', 'TEAM_NOT_FOUND', 'MR_BONI_RUN_NOT_FOUND'].includes(code) ? 404
      : code === 'TEAM_MANAGER_REQUIRED' ? 403
        : ['MR_BONI_PREFIX_CONFLICT', 'MR_BONI_RULESET_CONFLICT', 'MR_BONI_NAME_CONFLICT'].includes(code) ? 409
          : ['MR_BONI_INPUT_INVALID', 'MR_BONI_TRANSCRIPT_INVALID', 'MR_BONI_NAME_INVALID', 'LEAGUE_ID_INVALID'].includes(code) || error?.type === 'entity.parse.failed' ? 400
            : error?.type === 'entity.too.large' ? 413 : ['MR_BONI_UNAVAILABLE','MR_BONI_REPLAY_BUSY','MR_BONI_REPLAY_TIMEOUT'].includes(code) ? 503 : 500;
    if(status===503)response.set('Retry-After','15');
    response.status(status).json({ error: { code: status === 500 ? 'MR_BONI_REQUEST_FAILED' : code || 'MR_BONI_INPUT_INVALID',
      message: code === 'MR_BONI_NAME_INVALID' ? 'Enter a name with 1 to 30 letters, numbers, spaces, apostrophes, periods, underscores or hyphens.'
        : code === 'MR_BONI_NAME_CONFLICT' ? 'This guest already has a leaderboard name.'
        : status === 409 ? 'This run changed. Reload your saved game.' : status === 403 ? 'A current team manager is required to save scores.'
        : status === 400 || status === 413 ? 'The driving record could not be verified.' : status===503 ? 'Score verification is busy. Your saved result can be retried shortly.' : 'Mr. Boni scores could not be loaded or saved.',
      requestId: requestSecurity.getRequestId(request) } });
  }
  function handle(method) {
    return async (request, response) => {
      try {
        if(request.method!=='GET' && limited(request,response,method,requestSecurity.getAuthenticatedSession(request)))return;
        const data = await mrBoniService[method]({ leagueId: request.params.leagueId, runId: request.params.runId, input: request.body,
          authenticated: request.method === 'GET' ? requestSecurity.getSessionBootstrap(request) : requestSecurity.getAuthenticatedSession(request) });
        response.status(200).json({ data, meta: { requestId: requestSecurity.getRequestId(request) } });
      } catch (error) { failure(request, response, error); }
    };
  }
  const base = '/api/v1/leagues/:leagueId/mr-boni';
  router.get(`${base}/leaderboard`, requestSecurity.authenticateBootstrap, handle('leaderboard'));
  router.post(`${base}/runs`, requestSecurity.authenticateUnsafe, handle('start'));
  router.post(`${base}/runs/:runId/checkpoint`, requestSecurity.authenticateUnsafe, handle('checkpoint'));
  function limited(request,response,method,authenticated) {
    if(!rateLimiter)throw Object.assign(new Error(),{code:'MR_BONI_UNAVAILABLE'});
    const network=networkSourceResolver(request);
    if(typeof network!=='string'||!network||network.length>128||network!==network.trim())throw new Error('Network source unavailable.');
    const subject=authenticated ? 'account:'+authenticated.user.id : typeof request.body?.guestKey==='string' && /^[0-9a-f]{64}$/.test(request.body.guestKey) ? 'guest:'+request.body.guestKey : 'invalid_guest';
    const action='mr_boni_'+method;
    const identities=[{action,bucket:'network',canonicalIdentifier:network},{action,bucket:'subject',canonicalIdentifier:subject}];
    const results=identities.map(identity=>rateLimiter.check(identity));
    if(results.some(result=>!result.allowed)) {
      const retryAfterSeconds=Math.max(1,...results.map(result=>result.retryAfterSeconds||0));
      response.set('Retry-After',String(retryAfterSeconds));
      response.status(429).json({error:{code:'RATE_LIMITED',message:'Please wait before trying again.',retryAfterSeconds,requestId:requestSecurity.getRequestId(request)}});
      return true;
    }
    for(const identity of identities)rateLimiter.recordAttempt({...identity,failed:false});
    return false;
  }
  function publicHandle(method) {
    return async (request, response) => {
      try {
        if (!publicService) { const error = new Error(); error.code = 'MR_BONI_UNAVAILABLE'; throw error; }
        if(request.method!=='GET' && limited(request,response,method,null))return;
        const data = await publicService[method]({ runId:request.params.runId,input:request.body });
        response.status(200).json({ data,meta:{ requestId:requestSecurity.getRequestId(request) } });
      } catch (error) { failure(request,response,error); }
    };
  }
  const publicBase = '/api/v1/games/mr-boni';
  router.get(`${publicBase}/leaderboard`, publicHandle('leaderboard'));
  router.post(`${publicBase}/runs`, publicHandle('start'));
  router.post(`${publicBase}/runs/:runId/checkpoint`, publicHandle('checkpoint'));
  router.post(`${publicBase}/runs/:runId/name`, publicHandle('name'));
  router.use((error, request, response, next) => response.headersSent ? next(error) : failure(request, response, error));
  return router;
}
module.exports = { createMrBoniRouter };
