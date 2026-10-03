const express = require("express");
const MESSAGES = Object.freeze({
  COMMUNICATION_INVALID: "Check the message, recipients, and expiry time.",
  COMMUNICATION_UNAVAILABLE: "League messages are not available yet.",
  COMMUNICATION_NO_RECIPIENTS: "No eligible recipients currently need this reminder.",
  COMMUNICATION_PREVIEW_CHANGED: "The recipients or message changed. Review a new preview before confirming.",
  COMMUNICATION_KEY_CONFLICT: "This send was already used for a different message. Review a new preview.",
  COMMUNICATION_NOT_FOUND: "This announcement was not found.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  LEAGUE_COMMISSIONER_REQUIRED: "Current commissioner or administrator authority is required.",
  COMMUNICATION_FAILED: "The message operation could not be completed.",
});

function createLeagueCommunicationRouter({ requestSecurity: security, service }) {
  const router = express.Router();
  router.use(security.assignRequestId, security.securityHeaders, security.credentialedCors,
    security.requireAllowedOrigin, security.requireJson, security.requireCompatibleFetchMetadata,
    express.json({ limit: "20kb", strict: true }));
  function failed(req, res, caught) {
    let code = caught?.code;
    if (code === "LEAGUE_ID_INVALID") code = "COMMUNICATION_INVALID";
    if (!Object.hasOwn(MESSAGES, code || "")) code = "COMMUNICATION_FAILED";
    const status = { COMMUNICATION_INVALID: 400, COMMUNICATION_UNAVAILABLE: 503,
      COMMUNICATION_NO_RECIPIENTS: 409, COMMUNICATION_PREVIEW_CHANGED: 409,
      COMMUNICATION_KEY_CONFLICT: 409, COMMUNICATION_NOT_FOUND: 404,
      LEAGUE_NOT_FOUND: 404, LEAGUE_COMMISSIONER_REQUIRED: 403 }[code] || 500;
    res.status(status).json({ error: { code, message: MESSAGES[code], requestId: security.getRequestId(req) } });
  }
  function handle(operation, unsafe = false) {
    return (req, res) => {
      try {
        const data = operation({ leagueId: req.params.leagueId, id: req.params.id,
          authenticated: unsafe ? security.getAuthenticatedSession(req) : security.getSessionBootstrap(req),
          input: req.body, idempotencyKey: req.get("Idempotency-Key") });
        res.set("Cache-Control", "no-store").json({ data, meta: { requestId: security.getRequestId(req) } });
      } catch (caught) { failed(req, res, caught); }
    };
  }
  const base = "/api/v1/leagues/:leagueId/communications";
  router.get(base, security.authenticateBootstrap, handle(input => service.list(input)));
  router.get(`${base}/history`, security.authenticateBootstrap, handle(input => service.list({ ...input, history: true })));
  router.get(`${base}/card-progress`, security.authenticateBootstrap, handle(service.readiness));
  router.post(`${base}/preview`, security.authenticateUnsafe, handle(service.preview, true));
  router.post(base, security.authenticateUnsafe, handle(service.publish, true));
  router.post(`${base}/:id/archive`, security.authenticateUnsafe, handle(service.archive, true));
  router.use((caught, req, res, next) => {
    if (res.headersSent) return next(caught);
    return failed(req, res, { code: "COMMUNICATION_INVALID" });
  });
  return router;
}

module.exports = { createLeagueCommunicationRouter };
