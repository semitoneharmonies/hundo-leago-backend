"use strict";

const express = require("express");

const ROUTE_PATH =
  "/api/v1/operations/release-qa/strict-manager-outbox";
const SAFE_MESSAGES = Object.freeze({
  RELEASE_QA_STRICT_MANAGER_OUTBOX_DENIED:
    "The exact accepting release-QA manager is required.",
  RELEASE_QA_STRICT_MANAGER_OUTBOX_INPUT_INVALID:
    "The strict manager-outbox request is invalid.",
  RELEASE_QA_STRICT_MANAGER_OUTBOX_CONFLICT:
    "The strict manager-outbox request conflicts with current release state.",
  RELEASE_QA_STRICT_MANAGER_OUTBOX_FAILED:
    "The strict manager-outbox publication could not be completed safely.",
  RELEASE_QA_STRICT_MANAGER_OUTBOX_REQUEST_TOO_LARGE:
    "The strict manager-outbox request is too large.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `strict manager-outbox routes require ${description}`
    );
  }
}

function createReleaseQaStrictManagerOutboxRouter({
  requestSecurity,
  service,
} = {}) {
  for (const method of [
    "assignRequestId",
    "authenticateUnsafe",
    "credentialedCors",
    "getAuthenticatedSession",
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
  assertMethod(service, "publish", "the strict publication service");

  function failure(request, response, status, code) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestSecurity.getRequestId(request),
      },
    });
  }

  function mapError(request, response, error) {
    if (error?.code === "RELEASE_QA_STRICT_MANAGER_OUTBOX_DENIED") {
      return failure(
        request,
        response,
        403,
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_DENIED"
      );
    }
    if (error?.code === "RELEASE_QA_STRICT_MANAGER_OUTBOX_INPUT_INVALID") {
      return failure(
        request,
        response,
        400,
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_INPUT_INVALID"
      );
    }
    if (
      [
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_ENVIRONMENT_UNSAFE",
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_STATE_CHANGED",
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_IN_PROGRESS",
      ].includes(error?.code)
    ) {
      return failure(
        request,
        response,
        409,
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_CONFLICT"
      );
    }
    return failure(
      request,
      response,
      503,
      "RELEASE_QA_STRICT_MANAGER_OUTBOX_FAILED"
    );
  }

  const router = express.Router();
  router.use(ROUTE_PATH, requestSecurity.assignRequestId);
  router.use(ROUTE_PATH, requestSecurity.securityHeaders);
  router.use(ROUTE_PATH, requestSecurity.credentialedCors);
  router.use(ROUTE_PATH, requestSecurity.requireAllowedOrigin);
  router.use(ROUTE_PATH, requestSecurity.requireJson);
  router.use(
    ROUTE_PATH,
    requestSecurity.requireCompatibleFetchMetadata
  );
  router.use(ROUTE_PATH, express.json({ limit: "4kb", strict: true }));
  router.post(
    ROUTE_PATH,
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        const data = await service.publish({
          input: request.body,
          idempotencyKey: request.get("idempotency-key"),
          authenticated:
            requestSecurity.getAuthenticatedSession(request),
        });
        return response.status(200).json({
          data,
          meta: { requestId: requestSecurity.getRequestId(request) },
        });
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );
  router.use(ROUTE_PATH, (error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      return failure(
        request,
        response,
        413,
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_REQUEST_TOO_LARGE"
      );
    }
    return failure(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 503,
      error?.type === "entity.parse.failed"
        ? "RELEASE_QA_STRICT_MANAGER_OUTBOX_INPUT_INVALID"
        : "RELEASE_QA_STRICT_MANAGER_OUTBOX_FAILED"
    );
  });
  return router;
}

module.exports = {
  ROUTE_PATH,
  SAFE_MESSAGES,
  createReleaseQaStrictManagerOutboxRouter,
};
