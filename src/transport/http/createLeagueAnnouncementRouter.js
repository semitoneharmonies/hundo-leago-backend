const express = require("express");

function createLeagueAnnouncementRouter({ requestSecurity, announcementService } = {}) {
  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "16kb", strict: true }));
  function failure(request, response, caught) {
    const code = caught?.code;
    const [status, safeCode, message] = ["ANNOUNCEMENT_INPUT_INVALID", "TEAM_INPUT_INVALID", "LEAGUE_ID_INVALID", "ACTIVITY_INPUT_INVALID", "ACTIVITY_CURSOR_INVALID"].includes(code)
      ? [400, "ANNOUNCEMENT_INPUT_INVALID", "Enter an announcement of 1 to 2000 characters and try again."]
      : code === "LEAGUE_NOT_FOUND" ? [404, code, "The league was not found."]
        : code === "LEAGUE_COMMISSIONER_REQUIRED" ? [403, code, "Only this league’s commissioner can post announcements."]
          : code === "IDEMPOTENCY_KEY_REUSED" ? [409, code, "This post request was already used for different text."]
            : [500, "ANNOUNCEMENT_REQUEST_FAILED", "The announcement request could not be completed."];
    return response.status(status).json({ error: { code: safeCode, message, requestId: requestSecurity.getRequestId(request) } });
  }
  function handle(method) {
    return (request, response) => {
      try {
        const data = announcementService[method]({
          leagueId: request.params.leagueId,
          ...(method === "list" ? { query: request.query, authenticated: requestSecurity.getSessionBootstrap(request) }
            : { input: request.body, authenticated: requestSecurity.getAuthenticatedSession(request), idempotencyKey: request.get("idempotency-key"), requestCorrelationId: requestSecurity.getRequestId(request) }),
        });
        response.status(200).json({ data, meta: { requestId: requestSecurity.getRequestId(request) } });
      } catch (error) { return failure(request, response, error); }
    };
  }
  router.get("/api/v1/leagues/:leagueId/announcements", requestSecurity.authenticateBootstrap, handle("list"));
  router.post("/api/v1/leagues/:leagueId/announcements", requestSecurity.authenticateUnsafe, handle("post"));
  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large" || error?.type === "entity.parse.failed") {
      return response.status(error.type === "entity.too.large" ? 413 : 400).json({ error: { code: "ANNOUNCEMENT_INPUT_INVALID", message: "The announcement request is invalid.", requestId: requestSecurity.getRequestId(request) } });
    }
    return failure(request, response, error);
  });
  return router;
}

module.exports = { createLeagueAnnouncementRouter };
