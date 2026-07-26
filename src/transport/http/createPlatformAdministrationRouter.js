const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  ADMINISTRATION_REQUEST_FAILED:
    "The administrative request could not be completed.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
  LEAGUE_CREATION_INVALID:
    "The league-creation request is invalid.",
  LEAGUE_NAME_UNAVAILABLE:
    "The league name is unavailable.",
  PLATFORM_ADMINISTRATOR_REQUIRED:
    "Platform-administrator authority is required.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `platform administration routes require ${description}`
    );
  }
}

function createPlatformAdministrationRouter({
  requestSecurity,
  leagueCreationService,
  auditPrivacyDigest,
  networkSourceResolver = (request) => request.ip,
} = {}) {
  for (const method of [
    "assignRequestId",
    "authenticateBootstrap",
    "authenticateUnsafe",
    "credentialedCors",
    "getAuthenticatedSession",
    "getSessionBootstrap",
    "getRequestId",
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
  assertMethod(
    leagueCreationService,
    "create",
    "an administrative league-creation service"
  );
  assertMethod(
    leagueCreationService,
    "listUsers",
    "an administrative user-read service"
  );
  assertMethod(
    auditPrivacyDigest,
    "digest",
    "an audit privacy digest"
  );
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "platform administration routes require a network-source resolver"
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

  function auditContext(request) {
    const networkSource = networkSourceResolver(request);
    if (
      typeof networkSource !== "string" ||
      networkSource.length < 1 ||
      networkSource.length > 128 ||
      networkSource !== networkSource.trim()
    ) {
      throw new TypeError(
        "the canonical network source is unavailable"
      );
    }
    const network = auditPrivacyDigest.digest(
      `network\0${networkSource}`
    );
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

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "16kb", strict: true }));

  router.get(
    "/api/v1/admin/users",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return response.status(200).json({
          data: leagueCreationService.listUsers({
            authenticated: requestSecurity.getSessionBootstrap(request),
          }),
          meta: { requestId: requestId(request) },
        });
      } catch (error) {
        return errorResponse(
          request,
          response,
          error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED" ? 403 : 500,
          error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED"
            ? error.code
            : "ADMINISTRATION_REQUEST_FAILED"
        );
      }
    }
  );

  router.post(
    "/api/v1/admin/leagues",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const result = leagueCreationService.create({
          input: request.body,
          idempotencyKey: request.get("idempotency-key"),
          authenticated:
            requestSecurity.getAuthenticatedSession(request),
          auditContext: auditContext(request),
        });
        return response
          .status(result.replayed ? 200 : 201)
          .json({
            data: result,
            meta: { requestId: requestId(request) },
          });
      } catch (error) {
        if (
          error?.code === "LEAGUE_CREATION_INPUT_INVALID"
        ) {
          return errorResponse(
            request,
            response,
            400,
            "LEAGUE_CREATION_INVALID"
          );
        }
        if (
          error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED"
        ) {
          return errorResponse(
            request,
            response,
            403,
            error.code
          );
        }
        if (
          [
            "IDEMPOTENCY_KEY_REUSED",
            "IDEMPOTENCY_REQUEST_UNAVAILABLE",
            "LEAGUE_NAME_UNAVAILABLE",
          ].includes(error?.code)
        ) {
          return errorResponse(
            request,
            response,
            409,
            error.code
          );
        }
        return errorResponse(
          request,
          response,
          500,
          "ADMINISTRATION_REQUEST_FAILED"
        );
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
        ? "LEAGUE_CREATION_INVALID"
        : "ADMINISTRATION_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createPlatformAdministrationRouter,
};
