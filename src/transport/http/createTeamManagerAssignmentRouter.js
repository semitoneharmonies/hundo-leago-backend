const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  TEAM_MANAGER_ASSIGNMENT_CONFLICT:
    "The team-manager assignment cannot be changed in its current state.",
  TEAM_MANAGER_ASSIGNMENT_INVALID:
    "The team-manager assignment request is invalid.",
  TEAM_MANAGER_ASSIGNMENT_NOT_FOUND:
    "The team-manager assignment was not found.",
  TEAM_MANAGER_ASSIGNMENT_REQUEST_FAILED:
    "The team-manager assignment request could not be completed.",
  TEAM_MANAGER_ASSIGNMENT_RESULT_UNAVAILABLE:
    "The team-manager assignment result is unavailable.",
  TEAM_MANAGER_TRANSFER_STALE:
    "The proposed manager transfer is no longer current.",
  PRECONDITION_FAILED:
    "The team-manager assignment changed; refetch it and try again.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team-manager assignment routes require ${description}`);
  }
}

function parseIfMatch(request) {
  const value = request.get("if-match");
  const match = typeof value === "string" && /^"([1-9]\d*)"$/.exec(value);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

function createTeamManagerAssignmentRouter({
  requestSecurity,
  teamManagerAssignmentService,
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
  for (const method of ["accept", "decline", "propose", "read", "remove"]) {
    assertMethod(
      teamManagerAssignmentService,
      method,
      "a team-manager assignment service"
    );
  }
  assertMethod(auditPrivacyDigest, "digest", "an audit privacy digest");
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "team-manager assignment routes require a network-source resolver"
    );
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

  function errorResponse(request, response, status, code, details) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestId(request),
        ...(details ? { details } : {}),
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
        "TEAM_MANAGER_ASSIGNMENT_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        400,
        "TEAM_MANAGER_ASSIGNMENT_INVALID"
      );
    }
    if (error?.code === "LEAGUE_COMMISSIONER_REQUIRED") {
      return errorResponse(request, response, 403, error.code);
    }
    if (
      ["LEAGUE_NOT_FOUND", "TEAM_MANAGER_ASSIGNMENT_NOT_FOUND"].includes(
        error?.code
      )
    ) {
      return errorResponse(request, response, 404, error.code);
    }
    if (error?.code === "TEAM_MANAGER_ASSIGNMENT_PRECONDITION_FAILED") {
      return errorResponse(
        request,
        response,
        412,
        "PRECONDITION_FAILED",
        error.details
      );
    }
    if (
      [
        "TEAM_MANAGER_ASSIGNMENT_CONFLICT",
        "TEAM_MANAGER_ASSIGNMENT_RESULT_UNAVAILABLE",
        "TEAM_MANAGER_TRANSFER_STALE",
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      ].includes(error?.code)
    ) {
      return errorResponse(request, response, 409, error.code);
    }
    return errorResponse(
      request,
      response,
      500,
      "TEAM_MANAGER_ASSIGNMENT_REQUEST_FAILED"
    );
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "16kb", strict: true }));

  router.post(
    "/api/v1/leagues/:leagueId/teams/:teamId/manager-assignment",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const result = teamManagerAssignmentService.propose({
          leagueId: request.params.leagueId,
          teamId: request.params.teamId,
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

  router.get(
    "/api/v1/team-manager-assignments/:assignmentId",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return successResponse(
          request,
          response,
          teamManagerAssignmentService.read({
            assignmentId: request.params.assignmentId,
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  for (const action of ["accept", "decline"]) {
    router.post(
      `/api/v1/team-manager-assignments/:assignmentId/${action}`,
      requestSecurity.authenticateUnsafe,
      (request, response) => {
        try {
          const result = teamManagerAssignmentService[action]({
            assignmentId: request.params.assignmentId,
            input: request.body,
            idempotencyKey: request.get("idempotency-key"),
            authenticated: requestSecurity.getAuthenticatedSession(request),
            auditContext: auditContext(request),
          });
          return successResponse(request, response, result);
        } catch (error) {
          return mapError(request, response, error);
        }
      }
    );
  }

  router.delete(
    "/api/v1/leagues/:leagueId/teams/:teamId/manager-assignment",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const expectedVersion = parseIfMatch(request);
        if (expectedVersion === null) {
          return errorResponse(
            request,
            response,
            400,
            "TEAM_MANAGER_ASSIGNMENT_INVALID"
          );
        }
        const result = teamManagerAssignmentService.remove({
          leagueId: request.params.leagueId,
          teamId: request.params.teamId,
          input: request.body,
          expectedVersion,
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
          auditContext: auditContext(request),
        });
        return successResponse(request, response, result);
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
        ? "TEAM_MANAGER_ASSIGNMENT_INVALID"
        : "TEAM_MANAGER_ASSIGNMENT_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createTeamManagerAssignmentRouter,
  parseIfMatch,
};
