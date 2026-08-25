const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CLOSED_SESSION_OPERATIONS = new Set([
  "POST /api/v1/session",
  "DELETE /api/v1/session",
]);

function createLeagueWriteGate({ mode, isAllowedOrigin } = {}) {
  if (!new Set(["closed", "open"]).has(mode)) {
    throw new TypeError("league write gate requires an explicit mode");
  }
  if (typeof isAllowedOrigin !== "function") {
    throw new TypeError("league write gate requires an exact origin predicate");
  }

  return function leagueWriteGate(request, response, next) {
    if (
      mode === "open" ||
      SAFE_METHODS.has(request.method) ||
      CLOSED_SESSION_OPERATIONS.has(`${request.method} ${request.path}`)
    ) {
      next();
      return;
    }
    const origin = request.get("origin");
    if (typeof origin !== "string" || !isAllowedOrigin(origin)) {
      next();
      return;
    }
    response.vary("Origin");
    response.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.status(503).json({
      error: {
        code: "LEAGUE_WRITES_CLOSED",
        message: "League changes are temporarily unavailable.",
      },
    });
  };
}

module.exports = {
  CLOSED_SESSION_OPERATIONS,
  SAFE_METHODS,
  createLeagueWriteGate,
};
