const express = require('express');
const MESSAGES = {
  ROSTER_REPAIR_INVALID: 'Review the roster repair request and try again.',
  ROSTER_REPAIR_STALE: 'Your roster or matchup information changed. Review a new suggestion.',
  ROSTER_REPAIR_NOT_AVAILABLE: 'This roster repair is no longer available. Review a new suggestion.',
  ROSTER_REPAIR_UNAVAILABLE: 'Roster repair is temporarily unavailable.',
  LEAGUE_COMPETITION_PAUSED: 'League competition is paused. Resume before changing the roster.',
  LEAGUE_NOT_FOUND: 'The league was not found.', TEAM_NOT_FOUND: 'The team was not found.',
  TEAM_MANAGER_REQUIRED: 'Current team-manager authority is required.',
  LEAGUE_COMMISSIONER_REQUIRED: 'Current team-manager or commissioner authority is required.',
};
function createRosterRepairRouter({ requestSecurity: security, service }) {
  const router = express.Router();
  router.use(security.assignRequestId, security.securityHeaders, security.credentialedCors,
    security.requireAllowedOrigin, security.requireJson, security.requireCompatibleFetchMetadata, express.json({ limit: '4kb', strict: true }));
  function failed(req, res, error) {
    let code = error?.code;
    if (['LEAGUE_ID_INVALID', 'TEAM_ID_INVALID'].includes(code)) code = 'ROSTER_REPAIR_INVALID';
    if (!Object.hasOwn(MESSAGES, code || '')) code = 'ROSTER_REPAIR_UNAVAILABLE';
    const status = code === 'ROSTER_REPAIR_INVALID' ? 400 : ['LEAGUE_NOT_FOUND', 'TEAM_NOT_FOUND'].includes(code) ? 404
      : ['TEAM_MANAGER_REQUIRED', 'LEAGUE_COMMISSIONER_REQUIRED'].includes(code) ? 403 : code === 'ROSTER_REPAIR_UNAVAILABLE' ? 503 : 409;
    res.status(status).json({ error: { code, message: MESSAGES[code], requestId: security.getRequestId(req) } });
  }
  for (const [suffix, method] of [['repair-preview', 'preview'], ['repair', 'apply']]) {
    router.post(`/api/v1/leagues/:leagueId/teams/:teamId/roster/${suffix}`, security.authenticateUnsafe, async (req, res) => {
      try {
        const data = await service[method]({ leagueId: req.params.leagueId, teamId: req.params.teamId,
          authenticated: security.getAuthenticatedSession(req), input: req.body });
        res.set('Cache-Control', 'no-store').json({ data, meta: { requestId: security.getRequestId(req) } });
      } catch (error) { failed(req, res, error); }
    });
  }
  router.use((error, req, res, next) => res.headersSent ? next(error) : failed(req, res, { code: 'ROSTER_REPAIR_INVALID' }));
  return router;
}

module.exports = { createRosterRepairRouter };
