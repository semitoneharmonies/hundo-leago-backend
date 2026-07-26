const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  LEAGUE_ID_INVALID: "The league identifier is invalid.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  LEAGUE_READ_FAILED: "The league request could not be completed.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league read routes require ${description}`);
  }
}

function createLeagueReadRouter({
  requestSecurity,
  leagueReadService,
} = {}) {
  for (const method of [
    "assignRequestId",
    "authenticateBootstrap",
    "credentialedCors",
    "getRequestId",
    "getSessionBootstrap",
    "requireAllowedOrigin",
    "requireCompatibleFetchMetadata",
    "securityHeaders",
  ]) {
    assertMethod(
      requestSecurity,
      method,
      "the target request-security boundary"
    );
  }
  for (const method of [
    "list",
    "listMemberships",
    "listInvitableUsers",
    "listSeasons",
    "readLeague",
    "readSettings",
  ]) {
    assertMethod(
      leagueReadService,
      method,
      "a league read service"
    );
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function successResponse(request, response, result) {
    return response.status(200).json({
      data: result,
      meta: { requestId: requestId(request) },
    });
  }

  function errorResponse(request, response, status, code) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestId(request),
      },
    });
  }

  function mapError(request, response, error) {
    if (error?.code === "LEAGUE_ID_INVALID") {
      return errorResponse(request, response, 400, error.code);
    }
    if (error?.code === "LEAGUE_NOT_FOUND") {
      return errorResponse(request, response, 404, error.code);
    }
    if (error?.code === "LEAGUE_COMMISSIONER_REQUIRED") {
      return errorResponse(request, response, 403, error.code);
    }
    return errorResponse(request, response, 500, "LEAGUE_READ_FAILED");
  }

  function authenticated(request) {
    return requestSecurity.getSessionBootstrap(request);
  }

  function handle(method) {
    return (request, response) => {
      try {
        return successResponse(
          request,
          response,
          leagueReadService[method]({
            ...(request.params.leagueId
              ? { leagueId: request.params.leagueId }
              : {}),
            authenticated: authenticated(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    };
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireCompatibleFetchMetadata);

  router.get(
    "/api/v1/leagues",
    requestSecurity.authenticateBootstrap,
    handle("list")
  );
  router.get(
    "/api/v1/leagues/:leagueId/settings",
    requestSecurity.authenticateBootstrap,
    handle("readSettings")
  );
  router.get(
    "/api/v1/leagues/:leagueId/memberships",
    requestSecurity.authenticateBootstrap,
    handle("listMemberships")
  );
  router.get(
    "/api/v1/leagues/:leagueId/invitable-users",
    requestSecurity.authenticateBootstrap,
    handle("listInvitableUsers")
  );
  router.get(
    "/api/v1/leagues/:leagueId/seasons",
    requestSecurity.authenticateBootstrap,
    handle("listSeasons")
  );
  router.get(
    "/api/v1/leagues/:leagueId",
    requestSecurity.authenticateBootstrap,
    handle("readLeague")
  );

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createLeagueReadRouter,
};
