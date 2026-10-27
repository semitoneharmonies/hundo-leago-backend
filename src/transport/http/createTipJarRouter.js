const express = require('express');
function createTipJarRouter({ requestSecurity, tipJarService, publicService, rateLimiter, networkSourceResolver = request => request.ip } = {}) {
  const router = express.Router();
  for (const name of ['assignRequestId', 'securityHeaders', 'credentialedCors', 'requireAllowedOrigin', 'requireJson', 'requireCompatibleFetchMetadata']) router.use(requestSecurity[name]);
  router.use(express.json({ limit: '24kb', strict: true }));
  function failure(request, response, error) {
    const code = error?.code || '';
    const status = ['LEAGUE_NOT_FOUND', 'TEAM_NOT_FOUND', 'TIP_JAR_RUN_NOT_FOUND'].includes(code) ? 404
      : code === 'TEAM_MANAGER_REQUIRED' ? 403
        : ['TIP_JAR_PREFIX_CONFLICT', 'TIP_JAR_RULESET_CONFLICT', 'TIP_JAR_NAME_CONFLICT'].includes(code) ? 409
          : ['TIP_JAR_INPUT_INVALID', 'TIP_JAR_TRANSCRIPT_INVALID', 'TIP_JAR_NAME_INVALID', 'LEAGUE_ID_INVALID'].includes(code) || error?.type === 'entity.parse.failed' ? 400
            : error?.type === 'entity.too.large' ? 413 : code === 'TIP_JAR_UNAVAILABLE' ? 503 : 500;
    response.status(status).json({ error: { code: status === 500 ? 'TIP_JAR_REQUEST_FAILED' : code || 'TIP_JAR_INPUT_INVALID',
      message: code === 'TIP_JAR_NAME_INVALID' ? 'Enter a name with 1 to 30 letters, numbers, spaces, apostrophes, periods, underscores or hyphens.'
        : code === 'TIP_JAR_NAME_CONFLICT' ? 'This guest already has a leaderboard name.'
        : status === 409 ? 'This run changed. Reload your saved game.' : status === 403 ? 'A current team manager is required to save scores.'
        : status === 400 || status === 413 ? 'The shot record could not be verified.' : 'Tip Jar scores could not be loaded or saved.',
      requestId: requestSecurity.getRequestId(request) } });
  }
  function handle(method) {
    return async (request, response) => {
      try {
        const data = await tipJarService[method]({ leagueId: request.params.leagueId, runId: request.params.runId, input: request.body,
          authenticated: request.method === 'GET' ? requestSecurity.getSessionBootstrap(request) : requestSecurity.getAuthenticatedSession(request) });
        response.status(200).json({ data, meta: { requestId: requestSecurity.getRequestId(request) } });
      } catch (error) { failure(request, response, error); }
    };
  }
  const base = '/api/v1/leagues/:leagueId/tip-jar';
  router.get(`${base}/leaderboard`, requestSecurity.authenticateBootstrap, handle('leaderboard'));
  router.post(`${base}/runs`, requestSecurity.authenticateUnsafe, handle('start'));
  router.post(`${base}/runs/:runId/checkpoint`, requestSecurity.authenticateUnsafe, handle('checkpoint'));
  function publicHandle(method) {
    return async (request, response) => {
      try {
        if (!publicService) { const error = new Error(); error.code = 'TIP_JAR_UNAVAILABLE'; throw error; }
        if (request.method !== 'GET') {
          if (!rateLimiter) { const error = new Error(); error.code = 'TIP_JAR_UNAVAILABLE'; throw error; }
          const network = networkSourceResolver(request);
          if (typeof network !== 'string' || !network || network.length > 128 || network !== network.trim()) throw new Error('Network source unavailable.');
          const action = method === 'start' ? 'tip_jar_guest_start' : 'tip_jar_guest_write';
          const identities = [{ action, bucket:'network', canonicalIdentifier:network },
            { action, bucket:'subject', canonicalIdentifier:typeof request.body?.guestKey === 'string' && /^[0-9a-f]{64}$/.test(request.body.guestKey) ? request.body.guestKey : 'invalid_guest' }];
          const results = identities.map(identity => rateLimiter.check(identity));
          if (results.some(result => !result.allowed)) {
            const retryAfterSeconds = Math.max(1,...results.map(result => result.retryAfterSeconds || 0));
            response.set('Retry-After',String(retryAfterSeconds));
            return response.status(429).json({ error:{ code:'RATE_LIMITED',message:'Please wait before trying again.',retryAfterSeconds,
              requestId:requestSecurity.getRequestId(request) } });
          }
          for (const identity of identities) rateLimiter.recordAttempt({ ...identity,failed:false });
        }
        const data = await publicService[method]({ runId:request.params.runId,input:request.body });
        response.status(200).json({ data,meta:{ requestId:requestSecurity.getRequestId(request) } });
      } catch (error) { failure(request,response,error); }
    };
  }
  const publicBase = '/api/v1/games/tip-jar';
  router.get(`${publicBase}/leaderboard`, publicHandle('leaderboard'));
  router.post(`${publicBase}/runs`, publicHandle('start'));
  router.post(`${publicBase}/runs/:runId/checkpoint`, publicHandle('checkpoint'));
  router.post(`${publicBase}/runs/:runId/name`, publicHandle('name'));
  router.use((error, request, response, next) => response.headersSent ? next(error) : failure(request, response, error));
  return router;
}
module.exports = { createTipJarRouter };
