const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  OPERATIONS_HEALTH_FAILED:
    "Operational health could not be read safely.",
  PLATFORM_ADMINISTRATOR_REQUIRED:
    "Platform-administrator authority is required.",
});

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`operations health routes require ${description}`);
  }
}

function createOperationsHealthRouter({
  requestSecurity,
  platformAuthorization,
  healthService,
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
    requireMethod(
      requestSecurity,
      method,
      "the target request-security boundary"
    );
  }
  requireMethod(
    platformAuthorization,
    "requireAdministrator",
    "platform-administrator authorization"
  );
  requireMethod(healthService, "readOperations", "a health service");

  function errorResponse(request, response, status, code) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestSecurity.getRequestId(request),
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
    "/api/v1/operations/health",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        platformAuthorization.requireAdministrator(
          requestSecurity.getSessionBootstrap(request)
        );
        return response.status(200).json({
          data: healthService.readOperations(),
          meta: { requestId: requestSecurity.getRequestId(request) },
        });
      } catch (error) {
        if (error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED") {
          return errorResponse(request, response, 403, error.code);
        }
        return errorResponse(
          request,
          response,
          503,
          "OPERATIONS_HEALTH_FAILED"
        );
      }
    }
  );
  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createOperationsHealthRouter,
};
