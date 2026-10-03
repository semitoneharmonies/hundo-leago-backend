const express = require('express');
function createAuctionTimingRouter({ requestSecurity: security, service }) {
  const router = express.Router();
  router.use(security.assignRequestId, security.securityHeaders, security.credentialedCors, security.requireAllowedOrigin,
    security.requireJson, security.requireCompatibleFetchMetadata, express.json({ limit: '8kb', strict: true }));
  const messages = {
    AUCTION_TIMING_INVALID: [400, 'Enter a valid closing time, reason and confirmation.'],
    AUCTION_TIMING_NOT_FUTURE: [400, 'Choose a future auction closing time.'],
    AUCTION_TIMING_SEASON_BOUNDARY: [400, 'The auction must close before playoffs and the end of the season.'],
    AUCTION_TIMING_UNCHANGED: [400, 'Choose a different closing time.'],
    AUCTION_TIMING_CONFLICT: [409, 'The auction has closed or needs review before changing its time.'],
    AUCTION_TIMING_PREVIEW_CHANGED: [409, 'The auction or season changed. Review a fresh preview.'],
    AUCTION_TIMING_KEY_CONFLICT: [409, 'This confirmation was used for a different change. Review again.'],
    AUCTION_TIMING_UNAVAILABLE: [503, 'Auction timing controls are not available yet.'],
    AUCTION_TIMING_NOT_FOUND: [404, 'The auction was not found.'],
    LEAGUE_ID_INVALID: [400, 'The league identifier is invalid.'],
    LEAGUE_NOT_FOUND: [404, 'The league was not found.'],
    LEAGUE_COMMISSIONER_REQUIRED: [403, 'Current commissioner or administrator authority is required.'],
  };
  function failed(req, res, error) {
    const code = Object.hasOwn(messages, error?.code || '') ? error.code : 'AUCTION_TIMING_FAILED';
    const [status, message] = messages[code] || [500, 'The auction closing time could not be changed.'];
    res.set('Cache-Control', 'private, no-store').status(status).json({ error: { code, message, requestId: security.getRequestId(req) } });
  }
  const base = '/api/v1/leagues/:leagueId/auctions/:auctionId/timing';
  for (const [method, suffix, operation] of [['get', '', 'read'], ['post', '/preview', 'preview'], ['post', '/apply', 'apply']])
    router[method](base + suffix, method === 'get' ? security.authenticateBootstrap : security.authenticateUnsafe, (req, res) => {
      try {
        const data = service[operation]({ leagueId: req.params.leagueId, auctionId: req.params.auctionId,
          authenticated: method === 'get' ? security.getSessionBootstrap(req) : security.getAuthenticatedSession(req),
          input: req.body, idempotencyKey: req.get('Idempotency-Key') });
        res.set('Cache-Control', 'private, no-store').json({ data, meta: { requestId: security.getRequestId(req) } });
      } catch (error) { failed(req, res, error); }
    });
  router.use((error, req, res, next) => res.headersSent ? next(error) : failed(req, res, { code: 'AUCTION_TIMING_INVALID' }));
  return router;
}
module.exports = { createAuctionTimingRouter };
