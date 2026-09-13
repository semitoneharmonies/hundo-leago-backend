const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  PRECONDITION_FAILED:
    "The team profile changed; refetch it and try again.",
  TEAM_LOGO_NOT_FOUND: "The team logo was not found.",
  TEAM_MANAGER_REQUIRED:
    "Current team-manager or league-commissioner authority is required.",
  TEAM_NAME_UNAVAILABLE: "The team name is unavailable.",
  TEAM_NOT_FOUND: "The team was not found.",
  TEAM_PROFILE_CONFLICT:
    "The team profile cannot be changed in its current state.",
  TEAM_PROFILE_INVALID: "The team-profile request is invalid.",
  TEAM_PROFILE_NO_CHANGES: "The team profile is unchanged.",
  TEAM_PROFILE_REQUEST_FAILED:
    "The team-profile request could not be completed.",
  TEAM_PROFILE_RESULT_UNAVAILABLE:
    "The earlier team-profile result is unavailable.",
  TEAM_PROFILE_TOO_LARGE: "The team-profile request is too large.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team-profile routes require ${description}`);
  }
}

function parseIfMatch(request) {
  const value = request.get("if-match");
  const match = typeof value === "string" && /^"([1-9]\d*)"$/.exec(value);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

function createTeamProfileRouter({
  requestSecurity,
  teamProfileService,
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
  for (const method of ["readLogo", "update"]) {
    assertMethod(teamProfileService, method, "a team-profile service");
  }
  assertMethod(auditPrivacyDigest, "digest", "an audit privacy digest");
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "team-profile routes require a network-source resolver"
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
        "TEAM_ID_INVALID",
        "TEAM_INPUT_INVALID",
        "TEAM_PROFILE_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(request, response, 400, "TEAM_PROFILE_INVALID");
    }
    if (
      ["LEAGUE_COMMISSIONER_REQUIRED", "TEAM_MANAGER_REQUIRED"].includes(
        error?.code
      )
    ) {
      return errorResponse(request, response, 403, "TEAM_MANAGER_REQUIRED");
    }
    if (
      ["LEAGUE_NOT_FOUND", "TEAM_NOT_FOUND", "TEAM_LOGO_NOT_FOUND"].includes(
        error?.code
      )
    ) {
      return errorResponse(request, response, 404, error.code);
    }
    if (error?.code === "TEAM_PROFILE_PRECONDITION_FAILED") {
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
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        "TEAM_NAME_UNAVAILABLE",
        "TEAM_PROFILE_CONFLICT",
        "TEAM_PROFILE_NO_CHANGES",
        "TEAM_PROFILE_RESULT_UNAVAILABLE",
      ].includes(error?.code)
    ) {
      return errorResponse(request, response, 409, error.code);
    }
    return errorResponse(
      request,
      response,
      500,
      "TEAM_PROFILE_REQUEST_FAILED"
    );
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "768kb", strict: true }));

  router.get(
    "/api/v1/leagues/:leagueId/teams/:teamId/logo",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        const logo = teamProfileService.readLogo({
          leagueId: request.params.leagueId,
          teamId: request.params.teamId,
          authenticated: requestSecurity.getSessionBootstrap(request),
        });
        return response
          .status(200)
          .set("Content-Type", logo.mediaType)
          .set("Content-Length", String(logo.byteLength))
          .set("ETag", `"${logo.contentSha256}"`)
          .set("X-Content-Type-Options", "nosniff")
          .set("Cache-Control", "private, no-store")
          .send(logo.bytes);
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.patch(
    "/api/v1/leagues/:leagueId/teams/:teamId",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const expectedVersion = parseIfMatch(request);
        if (expectedVersion === null) {
          return errorResponse(
            request,
            response,
            400,
            "TEAM_PROFILE_INVALID"
          );
        }
        return successResponse(
          request,
          response,
          teamProfileService.update({
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            input: request.body,
            expectedVersion,
            idempotencyKey: request.get("idempotency-key"),
            authenticated: requestSecurity.getAuthenticatedSession(request),
            auditContext: auditContext(request),
          })
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
    if (error?.type === "entity.too.large") {
      errorResponse(request, response, 413, "TEAM_PROFILE_TOO_LARGE");
      return;
    }
    errorResponse(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "TEAM_PROFILE_INVALID"
        : "TEAM_PROFILE_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createTeamProfileRouter,
  parseIfMatch,
};
