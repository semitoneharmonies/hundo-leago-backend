const express = require("express");

const ERRORS = Object.freeze({
  COMMUNICATION_INVALID: [400, "Check the announcement and expiry time."],
  COMMUNICATION_UNAVAILABLE: [503, "Announcements are not available yet."],
  COMMUNICATION_NO_RECIPIENTS: [409, "There are no eligible leagues for this announcement."],
  COMMUNICATION_PREVIEW_CHANGED: [409, "The leagues, recipients or message changed. Review a new preview."],
  COMMUNICATION_KEY_CONFLICT: [409, "This send was already used for a different announcement. Review a new preview."],
  PLATFORM_ADMINISTRATOR_REQUIRED: [403, "Platform-administrator authority is required."],
  LEAGUE_COMMISSIONER_REQUIRED: [403, "Current administrator authority is required for every league."],
  LEAGUE_NOT_FOUND: [404, "A target league or required administrator membership is unavailable."],
  COMMUNICATION_FAILED: [500, "The announcement could not be completed."],
});

function createPlatformAnnouncementRouter({ requestSecurity: security, service }) {
  const router = express.Router();
  router.use(security.assignRequestId, security.securityHeaders, security.credentialedCors,
    security.requireAllowedOrigin, security.requireJson, security.requireCompatibleFetchMetadata,
    express.json({ limit: "20kb", strict: true }));
  function failed(req, res, error) {
    const code = Object.hasOwn(ERRORS, error?.code || "") ? error.code : "COMMUNICATION_FAILED";
    const [status, message] = ERRORS[code];
    return res.status(status).json({ error: { code, message, requestId: security.getRequestId(req) } });
  }
  function handle(method) {
    return (req, res) => {
      try {
        const data = service[method]({ authenticated: security.getAuthenticatedSession(req), input: req.body,
          idempotencyKey: req.get("Idempotency-Key"), requestCorrelationId: security.getRequestId(req) });
        return res.set("Cache-Control", "no-store").json({ data, meta: { requestId: security.getRequestId(req) } });
      } catch (error) { return failed(req, res, error); }
    };
  }
  router.post("/api/v1/admin/announcements/preview", security.authenticateUnsafe, handle("preview"));
  router.post("/api/v1/admin/announcements", security.authenticateUnsafe, handle("publish"));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return failed(req, res, { code: "COMMUNICATION_INVALID" });
  });
  return router;
}

module.exports = { createPlatformAnnouncementRouter };
