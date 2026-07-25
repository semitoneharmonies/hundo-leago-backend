const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  ADMINISTRATION_REQUEST_FAILED:
    "The administrative request could not be completed.",
  COMMISSIONER_ASSIGNMENT_CONFLICT:
    "The commissioner assignment cannot be changed in its current state.",
  COMMISSIONER_ASSIGNMENT_INVALID:
    "The commissioner-assignment request is invalid.",
  COMMISSIONER_ASSIGNMENT_NOT_FOUND:
    "The commissioner assignment was not found.",
  COMMISSIONER_ASSIGNMENT_REQUEST_FAILED:
    "The commissioner-assignment request could not be completed.",
  COMMISSIONER_ASSIGNMENT_RESULT_UNAVAILABLE:
    "The commissioner-assignment result is unavailable.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
  PLATFORM_ADMINISTRATOR_REQUIRED:
    "Platform-administrator authority is required.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `commissioner-assignment routes require ${description}`
    );
  }
}

function createCommissionerAssignmentRouter({
  requestSecurity,
  commissionerAssignmentService,
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
  for (const method of ["accept", "decline", "propose", "read"]) {
    assertMethod(
      commissionerAssignmentService,
      method,
      "a commissioner-assignment service"
    );
  }
  assertMethod(
    auditPrivacyDigest,
    "digest",
    "an audit privacy digest"
  );
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "commissioner-assignment routes require a network-source resolver"
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

  function mapError(request, response, error, fallbackCode) {
    if (
      error?.code === "COMMISSIONER_ASSIGNMENT_INPUT_INVALID"
    ) {
      return errorResponse(
        request,
        response,
        400,
        "COMMISSIONER_ASSIGNMENT_INVALID"
      );
    }
    if (error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED") {
      return errorResponse(request, response, 403, error.code);
    }
    if (error?.code === "COMMISSIONER_ASSIGNMENT_NOT_FOUND") {
      return errorResponse(request, response, 404, error.code);
    }
    if (
      [
        "COMMISSIONER_ASSIGNMENT_CONFLICT",
        "COMMISSIONER_ASSIGNMENT_RESULT_UNAVAILABLE",
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      ].includes(error?.code)
    ) {
      return errorResponse(request, response, 409, error.code);
    }
    return errorResponse(request, response, 500, fallbackCode);
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
    "/api/v1/admin/leagues/:leagueId/commissioner-assignments",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const result = commissionerAssignmentService.propose({
          leagueId: request.params.leagueId,
          input: request.body,
          idempotencyKey: request.get("idempotency-key"),
          authenticated:
            requestSecurity.getAuthenticatedSession(request),
          auditContext: auditContext(request),
        });
        return successResponse(
          request,
          response,
          result,
          result.replayed ? 200 : 201
        );
      } catch (error) {
        return mapError(
          request,
          response,
          error,
          "ADMINISTRATION_REQUEST_FAILED"
        );
      }
    }
  );

  router.get(
    "/api/v1/commissioner-assignments/:assignmentId",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return successResponse(
          request,
          response,
          commissionerAssignmentService.read({
            assignmentId: request.params.assignmentId,
            authenticated:
              requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (error) {
        return mapError(
          request,
          response,
          error,
          "COMMISSIONER_ASSIGNMENT_REQUEST_FAILED"
        );
      }
    }
  );

  for (const action of ["accept", "decline"]) {
    router.post(
      `/api/v1/commissioner-assignments/:assignmentId/${action}`,
      requestSecurity.authenticateUnsafe,
      (request, response) => {
        try {
          return successResponse(
            request,
            response,
            commissionerAssignmentService[action]({
              assignmentId: request.params.assignmentId,
              input: request.body,
              authenticated:
                requestSecurity.getAuthenticatedSession(request),
              auditContext: auditContext(request),
            })
          );
        } catch (error) {
          return mapError(
            request,
            response,
            error,
            "COMMISSIONER_ASSIGNMENT_REQUEST_FAILED"
          );
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
        ? "COMMISSIONER_ASSIGNMENT_INVALID"
        : "COMMISSIONER_ASSIGNMENT_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createCommissionerAssignmentRouter,
};
