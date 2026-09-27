const express = require('express');
function createPlayerInjuryRouter({ requestSecurity: security, service }) {
  const router = express.Router();
  router.use(security.assignRequestId, security.securityHeaders, security.credentialedCors,
    security.requireAllowedOrigin, security.requireJson, security.requireCompatibleFetchMetadata,
    express.json({ limit: '8kb', strict: true }));
  function handler(action, read = false) {
    return async (request, response) => {
      try {
        const authenticated = read ? security.getSessionBootstrap(request) : security.getAuthenticatedSession(request);
        const result = await service[action]({ authenticated, input: request.body, search: request.query.search ?? '' });
        response.json({ data: result, meta: { requestId: security.getRequestId(request) } });
      } catch (error) {
        const allowed = ['PLATFORM_ADMINISTRATOR_REQUIRED','INJURY_INPUT_INVALID','INJURY_PLAYER_NOT_FOUND','INJURY_VERSION_CONFLICT','INJURY_FEED_UNAVAILABLE','INJURY_FEED_INVALID','INJURY_FEED_STALE','INJURY_FEED_INCOMPLETE','INJURY_REFRESH_CONFLICT','INJURY_REFRESH_FAILED'];
        const code = allowed.includes(error.code) ? error.code : 'INJURY_REQUEST_FAILED';
        const status = code === 'PLATFORM_ADMINISTRATOR_REQUIRED' ? 403 : code === 'INJURY_INPUT_INVALID' ? 400 : code === 'INJURY_PLAYER_NOT_FOUND' ? 404 : /CONFLICT/.test(code) ? 409 : 503;
        const message = status === 403 ? 'Administrator access is required.' : status === 409 ? 'This status changed. Refresh the list before saving again.' : status === 400 ? 'Check the player, status, and reason.' : 'The injury request could not be completed. Existing statuses were preserved.';
        response.status(status).json({ error: { code, message, requestId: security.getRequestId(request) } });
      }
    };
  }
  router.get('/api/v1/admin/injuries', security.authenticateBootstrap, handler('list', true));
  router.post('/api/v1/admin/injuries/decide', security.authenticateUnsafe, handler('decide'));
  router.use((error, request, response, next) => {
    if (!['entity.parse.failed', 'entity.too.large'].includes(error.type)) return next(error);
    return response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: {
      code: 'INJURY_INPUT_INVALID', message: 'The injury request is invalid.', requestId: security.getRequestId(request),
    } });
  });
  return router;
}
module.exports = { createPlayerInjuryRouter };
