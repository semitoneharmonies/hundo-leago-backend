const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  PUBLIC_ROSTER_REQUEST_INVALID:
    "The public roster request is invalid.",
  PUBLIC_ROSTER_NOT_FOUND: "The public roster was not found.",
  PUBLIC_ROSTER_READ_FAILED:
    "The public roster request could not be completed.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`public roster routes require ${description}`);
  }
}

function createPublicRosterRouter({ requestSecurity, publicRosterService } = {}) {
  for (const method of [
    "assignRequestId",
    "credentialedCors",
    "getRequestId",
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
  assertMethod(publicRosterService, "read", "a public-roster service");

  function requestId(request) {
    return requestSecurity.getRequestId(request);
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

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.get(
    "/api/v1/public/leagues/:leagueId/teams/:teamId/roster",
    (request, response) => {
      try {
        return response.status(200).json({
          data: publicRosterService.read({
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
          }),
          meta: { requestId: requestId(request) },
        });
      } catch (error) {
        if (error?.code === "PUBLIC_ROSTER_INPUT_INVALID") {
          return errorResponse(
            request,
            response,
            400,
            "PUBLIC_ROSTER_REQUEST_INVALID"
          );
        }
        if (error?.code === "REPOSITORY_RECORD_NOT_FOUND") {
          return errorResponse(
            request,
            response,
            404,
            "PUBLIC_ROSTER_NOT_FOUND"
          );
        }
        return errorResponse(
          request,
          response,
          500,
          "PUBLIC_ROSTER_READ_FAILED"
        );
      }
    }
  );
  return router;
}

module.exports = { SAFE_MESSAGES, createPublicRosterRouter };
