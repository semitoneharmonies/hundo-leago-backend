const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  LEAGUE_INVITATION_CONFLICT:
    "The league invitation cannot be changed in its current state.",
  LEAGUE_INVITATION_INVALID:
    "The league-invitation request is invalid.",
  LEAGUE_INVITATION_NOT_FOUND:
    "The league invitation was not found.",
  LEAGUE_INVITATION_REQUEST_FAILED:
    "The league-invitation request could not be completed.",
  LEAGUE_INVITATION_RESULT_UNAVAILABLE:
    "The league-invitation result is unavailable.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league-invitation routes require ${description}`);
  }
}

function createLeagueInvitationRouter({
  requestSecurity,
  leagueInvitationService,
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
  for (const method of ["accept", "decline", "invite", "read"]) {
    assertMethod(
      leagueInvitationService,
      method,
      "a league-invitation service"
    );
  }
  assertMethod(auditPrivacyDigest, "digest", "an audit privacy digest");
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "league-invitation routes require a network-source resolver"
    );
  }

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

  function successResponse(request, response, result, status = 200) {
    return response.status(status).json({
      data: result,
      meta: { requestId: requestId(request) },
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
        "LEAGUE_INVITATION_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        400,
        "LEAGUE_INVITATION_INVALID"
      );
    }
    if (error?.code === "LEAGUE_COMMISSIONER_REQUIRED") {
      return errorResponse(request, response, 403, error.code);
    }
    if (
      ["LEAGUE_INVITATION_NOT_FOUND", "LEAGUE_NOT_FOUND"].includes(
        error?.code
      )
    ) {
      return errorResponse(request, response, 404, error.code);
    }
    if (
      [
        "LEAGUE_INVITATION_CONFLICT",
        "LEAGUE_INVITATION_RESULT_UNAVAILABLE",
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
      "LEAGUE_INVITATION_REQUEST_FAILED"
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
    "/api/v1/leagues/:leagueId/invitations",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const result = leagueInvitationService.invite({
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

  router.get(
    "/api/v1/league-invitations/:invitationId",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return successResponse(
          request,
          response,
          leagueInvitationService.read({
            invitationId: request.params.invitationId,
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
      `/api/v1/league-invitations/:invitationId/${action}`,
      requestSecurity.authenticateUnsafe,
      (request, response) => {
        try {
          return successResponse(
            request,
            response,
            leagueInvitationService[action]({
              invitationId: request.params.invitationId,
              input: request.body,
              authenticated:
                requestSecurity.getAuthenticatedSession(request),
              auditContext: auditContext(request),
            })
          );
        } catch (error) {
          return mapError(request, response, error);
        }
      }
    );
  }

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
        ? "LEAGUE_INVITATION_INVALID"
        : "LEAGUE_INVITATION_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createLeagueInvitationRouter,
};
