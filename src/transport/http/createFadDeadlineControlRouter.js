const express = require("express");
function createFadDeadlineControlRouter({ requestSecurity: security, service, timingService, cutoffService }) {
  const router = express.Router();
  router.use(security.assignRequestId, security.securityHeaders, security.credentialedCors,
    security.requireAllowedOrigin, security.requireJson, security.requireCompatibleFetchMetadata,
    express.json({ limit: "32kb", strict: true }));
  const messages = {
    FAD_CUTOFF_INVALID: [400, 'Enter a whole number of minutes from 0 to 10080, a reason and confirmation.'],
    FAD_CUTOFF_UNCHANGED: [400, 'Choose a different cutoff gap before reviewing.'],
    FAD_CUTOFF_CONFLICT: [409, 'Draft processing or recovery prevents this change. Refresh the current status.'],
    FAD_CUTOFF_PREVIEW_CHANGED: [409, 'The draft or nomination window changed. Review a fresh cutoff preview.'],
    FAD_CUTOFF_NOT_FOUND: [404, 'The draft was not found.'],
    FAD_CUTOFF_UNAVAILABLE: [503, 'Auction cutoff controls are not available yet.'],
    FAD_TIMING_INVALID: [400, "Choose a future target and increasing round dates ending by Week 1. Keep the existing round count and allow more than an hour for the first round."],
    FAD_TIMING_UNCHANGED: [400, "Change at least one date before reviewing."],
    FAD_TIMING_CONFLICT: [409, "Draft processing or another timing change prevents this edit. Refresh the schedule."],
    FAD_TIMING_PREVIEW_CHANGED: [409, "The schedule changed. Review a new preview."],
    FAD_TIMING_NOT_FOUND: [404, "The draft was not found."],
    FAD_TIMING_UNAVAILABLE: [503, "Timing controls are not available yet."],
    FAD_DEADLINE_CONTROL_INVALID: [400, "Check the reason and confirmation."],
    FAD_DEADLINE_CONTROL_CONFLICT: [409, "The draft cannot proceed in its current state. Refresh its status."],
    FAD_DEADLINE_CONTROL_PREVIEW_CHANGED: [409, "The cards or draft state changed. Review a new preview."],
    FAD_DEADLINE_CONTROL_NOT_FOUND: [404, "The draft was not found."],
    FAD_DEADLINE_CONTROL_UNAVAILABLE: [503, "Deadline controls are not available yet."],
    LEAGUE_NOT_FOUND: [404, "The league was not found."],
    LEAGUE_COMMISSIONER_REQUIRED: [403, "Current commissioner or administrator authority is required."],
  };
  function failed(req, res, error) {
    const code = Object.hasOwn(messages, error?.code || "") ? error.code : "FAD_DEADLINE_CONTROL_FAILED";
    const [status, message] = messages[code] || [500, "The deadline action could not be completed."];
    res.set("Cache-Control", "private, no-store").status(status).json({ error: { code, message, requestId: security.getRequestId(req) } });
  }
  const base = "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/deadline-control";
  for (const [method, suffix, operation, target = service] of [["get", "", "read"], ["post", "/preview", "preview"], ["post", "/proceed", "proceed"],
    ["get", "/timing", "read", timingService], ["post", "/timing/preview", "preview", timingService], ["post", "/timing/apply", "apply", timingService],
    ['get','/auction-cutoff','read',cutoffService], ['post','/auction-cutoff/preview','preview',cutoffService], ['post','/auction-cutoff/apply','apply',cutoffService]]) {
    router[method](base + suffix, method === "get" ? security.authenticateBootstrap : security.authenticateUnsafe, (req, res) => {
      try {
        const data = target[operation]({ leagueId: req.params.leagueId, fadId: req.params.fadId,
          authenticated: method === "get" ? security.getSessionBootstrap(req) : security.getAuthenticatedSession(req),
          input: req.body, idempotencyKey: req.get("Idempotency-Key") });
        res.set("Cache-Control", "private, no-store").json({ data, meta: { requestId: security.getRequestId(req) } });
      } catch (error) { failed(req, res, error); }
    });
  }
  router.use((error, req, res, next) => res.headersSent ? next(error) : failed(req, res, { code: "FAD_DEADLINE_CONTROL_INVALID" }));
  return router;
}
module.exports = { createFadDeadlineControlRouter };
