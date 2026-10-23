const express = require('express');
function createTipJarRouter({ requestSecurity, tipJarService } = {}) {
  const router = express.Router();
  for (const name of ['assignRequestId', 'securityHeaders', 'credentialedCors', 'requireAllowedOrigin', 'requireJson', 'requireCompatibleFetchMetadata']) router.use(requestSecurity[name]);
  router.use(express.json({ limit: '24kb', strict: true }));
  function failure(request, response, error) {
    const code = error?.code || '';
    const status = ['LEAGUE_NOT_FOUND', 'TEAM_NOT_FOUND', 'TIP_JAR_RUN_NOT_FOUND'].includes(code) ? 404
      : code === 'TEAM_MANAGER_REQUIRED' ? 403
        : ['TIP_JAR_PREFIX_CONFLICT', 'TIP_JAR_RULESET_CONFLICT'].includes(code) ? 409
          : ['TIP_JAR_INPUT_INVALID', 'TIP_JAR_TRANSCRIPT_INVALID', 'LEAGUE_ID_INVALID'].includes(code) || error?.type === 'entity.parse.failed' ? 400
            : error?.type === 'entity.too.large' ? 413 : code === 'TIP_JAR_UNAVAILABLE' ? 503 : 500;
    response.status(status).json({ error: { code: status === 500 ? 'TIP_JAR_REQUEST_FAILED' : code || 'TIP_JAR_INPUT_INVALID',
      message: status === 409 ? 'This run changed. Reload your saved game.' : status === 403 ? 'A current team manager is required to save scores.'
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
  router.use((error, request, response, next) => response.headersSent ? next(error) : failure(request, response, error));
  return router;
}
module.exports = { createTipJarRouter };
