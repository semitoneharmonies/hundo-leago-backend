const express = require("express");

function createQuoteRouter({ requestSecurity, quoteService } = {}) {
  const router = express.Router();
  for (const name of ["assignRequestId", "securityHeaders", "credentialedCors", "requireAllowedOrigin", "requireJson", "requireCompatibleFetchMetadata"]) router.use(requestSecurity[name]);
  router.use(express.json({ limit: "8kb", strict: true }));
  function failure(request, response, error) {
    const code = error?.code || "";
    const status = code === "QUOTE_UNAVAILABLE" ? 503 : ["QUOTE_NOT_FOUND", "LEAGUE_NOT_FOUND"].includes(code) ? 404
      : ["LEAGUE_COMMISSIONER_REQUIRED", "PLATFORM_ADMINISTRATOR_REQUIRED"].includes(code) ? 403
        : ["QUOTE_REVIEW_CONFLICT", "IDEMPOTENCY_KEY_REUSED"].includes(code) ? 409
          : /^(QUOTE_INPUT_INVALID|TEAM_INPUT_INVALID|LEAGUE_ID_INVALID|ACTIVITY_INPUT_INVALID|ACTIVITY_CURSOR_INVALID)$/.test(code) ? 400
            : error?.type === "entity.too.large" ? 413 : error?.type === "entity.parse.failed" ? 400 : 500;
    response.status(status).json({ error: { code: status === 500 ? "QUOTE_REQUEST_FAILED" : code || "QUOTE_INPUT_INVALID",
      message: status === 409 ? "This quote changed or the request was already used. Refresh and try again."
        : status === 403 ? "You do not have permission to review these quotes."
          : status === 400 || status === 413 ? "Enter a quote up to 500 characters and an attribution up to 80 characters."
            : "The quote request could not be completed.", requestId: requestSecurity.getRequestId(request) } });
  }
  function handle(method, global = false) {
    return (request, response) => {
      try {
        const reading = request.method === "GET";
        const data = quoteService[method]({ global, leagueId: global ? null : request.params.leagueId,
          quoteId: request.params.quoteId, query: request.query, input: request.body,
          authenticated: reading ? requestSecurity.getSessionBootstrap(request) : requestSecurity.getAuthenticatedSession(request),
          idempotencyKey: request.get("idempotency-key"), requestCorrelationId: requestSecurity.getRequestId(request) });
        response.status(200).json({ data, meta: { requestId: requestSecurity.getRequestId(request) } });
      } catch (error) { failure(request, response, error); }
    };
  }
  router.get("/api/v1/leagues/:leagueId/quotes", requestSecurity.authenticateBootstrap, handle("rotation"));
  router.post("/api/v1/leagues/:leagueId/quotes", requestSecurity.authenticateUnsafe, handle("submit"));
  router.get("/api/v1/leagues/:leagueId/quote-submissions", requestSecurity.authenticateBootstrap, handle("reviewQueue"));
  router.post("/api/v1/leagues/:leagueId/quote-submissions/:quoteId/review", requestSecurity.authenticateUnsafe, handle("review"));
  router.get("/api/v1/admin/quote-submissions", requestSecurity.authenticateBootstrap, handle("reviewQueue", true));
  router.post("/api/v1/admin/quote-submissions/:quoteId/review", requestSecurity.authenticateUnsafe, handle("review", true));
  router.use((error, request, response, next) => response.headersSent ? next(error) : failure(request, response, error));
  return router;
}
module.exports = { createQuoteRouter };
