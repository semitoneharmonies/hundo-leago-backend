const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  TEAM_CREATION_NOT_ALLOWED:
    "Teams can be created only while the league is in Setup.",
  TEAM_CREATION_RESULT_UNAVAILABLE:
    "The earlier team-creation result is unavailable.",
  TEAM_INPUT_INVALID: "The team request is invalid.",
  TEAM_LIMIT_REACHED: "The league team limit has been reached.",
  TEAM_NAME_UNAVAILABLE: "The team name is unavailable.",
  TEAM_NOT_FOUND: "The team was not found.",
  TEAM_REQUEST_FAILED: "The team request could not be completed.",
  TEAM_MANAGER_REQUIRED: "Current team-manager authority is required.",
  TEAM_WORKSPACE_INPUT_INVALID: "The team-workspace request is invalid.",
  ROSTER_DISPLAY_ORDER_CONFLICT:
    "The roster changed before the display order could be saved.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team routes require ${description}`);
  }
}

function createTeamRouter({
  requestSecurity,
  teamReadService,
  teamCreationService,
  teamWorkspaceService,
  auditPrivacyDigest,
  networkSourceResolver = (request) => request.ip,
} = {}) {
  for (const method of [
    "assignRequestId",
    "authenticateBootstrap",
    "authenticateUnsafe",
    "credentialedCors",
    "getAuthenticatedSession",
    "getRequestId",
    "getSessionBootstrap",
    "requireAllowedOrigin",
    "requireCompatibleFetchMetadata",
    "requireJson",
    "securityHeaders",
  ]) {
    assertMethod(
      requestSecurity,
      method,
      "the target request-security boundary"
    );
  }
  for (const method of ["list", "read"]) {
    assertMethod(teamReadService, method, "a team read service");
  }
  assertMethod(teamCreationService, "create", "a team-creation service");
  for (const method of ["read", "saveOrder"]) {
    assertMethod(teamWorkspaceService, method, "a team-workspace service");
  }
  assertMethod(auditPrivacyDigest, "digest", "an audit privacy digest");
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError("team routes require a network-source resolver");
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function successResponse(request, response, result, status = 200) {
    return response.status(status).json({
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

  function auditContext(request) {
    const networkSource = networkSourceResolver(request);
    if (
      typeof networkSource !== "string" ||
      networkSource.length < 1 ||
      networkSource.length > 128 ||
      networkSource !== networkSource.trim()
    ) {
      throw new TypeError("the canonical network source is unavailable");
    }
    const network = auditPrivacyDigest.digest(`network\0${networkSource}`);
    return {
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "unknown",
        origin: request.get("origin"),
      }),
      networkKeyVersion: network.keyVersion,
      networkMetadataDigest: network.digest,
      requestCorrelationId: requestId(request),
    };
  }

  function mapError(request, response, error) {
    if (
      [
        "LEAGUE_ID_INVALID",
        "TEAM_ID_INVALID",
        "TEAM_INPUT_INVALID",
        "TEAM_WORKSPACE_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(request, response, 400, "TEAM_INPUT_INVALID");
    }
    if (error?.code === "LEAGUE_COMMISSIONER_REQUIRED") {
      return errorResponse(request, response, 403, error.code);
    }
    if (error?.code === "TEAM_MANAGER_REQUIRED") {
      return errorResponse(request, response, 403, error.code);
    }
    if (["LEAGUE_NOT_FOUND", "TEAM_NOT_FOUND"].includes(error?.code)) {
      return errorResponse(request, response, 404, error.code);
    }
    if (
      [
        "TEAM_CREATION_NOT_ALLOWED",
        "TEAM_CREATION_RESULT_UNAVAILABLE",
        "TEAM_LIMIT_REACHED",
        "TEAM_NAME_UNAVAILABLE",
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      ].includes(error?.code)
    ) {
      return errorResponse(request, response, 409, error.code);
    }
    if (error?.code === "REPOSITORY_VERSION_CONFLICT") {
      return errorResponse(
        request,
        response,
        409,
        "ROSTER_DISPLAY_ORDER_CONFLICT"
      );
    }
    return errorResponse(request, response, 500, "TEAM_REQUEST_FAILED");
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "16kb", strict: true }));

  router.get(
    "/api/v1/leagues/:leagueId/teams",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return successResponse(
          request,
          response,
          teamReadService.list({
            leagueId: request.params.leagueId,
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.get(
    "/api/v1/leagues/:leagueId/teams/:teamId/roster",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return successResponse(
          request,
          response,
          teamWorkspaceService.read({
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.put(
    "/api/v1/leagues/:leagueId/teams/:teamId/roster-display-order",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        return successResponse(
          request,
          response,
          teamWorkspaceService.saveOrder({
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            input: request.body,
            authenticated: requestSecurity.getAuthenticatedSession(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.get(
    "/api/v1/leagues/:leagueId/teams/:teamId",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return successResponse(
          request,
          response,
          teamReadService.read({
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/teams",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const result = teamCreationService.create({
          leagueId: request.params.leagueId,
          input: request.body,
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
          auditContext: auditContext(request),
        });
        return successResponse(
          request,
          response,
          result,
          result.replayed ? 200 : 201
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    errorResponse(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "TEAM_INPUT_INVALID"
        : "TEAM_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createTeamRouter,
};
