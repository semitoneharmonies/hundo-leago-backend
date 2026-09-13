const express = require("express");

const ROUTE_PATH =
  "/api/v1/operations/staging-sportsdataio-import";

const SAFE_MESSAGES = Object.freeze({
  STAGING_SPORTSDATAIO_IMPORT_DENIED:
    "Platform-administrator authority is required.",
  STAGING_SPORTSDATAIO_IMPORT_INVALID:
    "The staging provider import request is invalid.",
  STAGING_SPORTSDATAIO_IMPORT_CONFLICT:
    "The staging provider import conflicts with current state.",
  STAGING_SPORTSDATAIO_IMPORT_FAILED:
    "The staging provider import could not be completed safely.",
  STAGING_SPORTSDATAIO_IMPORT_REQUEST_TOO_LARGE:
    "The staging provider import request is too large.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `staging SportsDataIO import routes require ${description}`
    );
  }
}

function createStagingSportsDataIoImportRouter({
  requestSecurity,
  stagingSportsDataIoImportService,
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
  assertMethod(
    stagingSportsDataIoImportService,
    "run",
    "a staging provider import service"
  );

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
    const code = error?.code;
    if (code === "PLATFORM_ADMINISTRATOR_REQUIRED") {
      return failure(
        request,
        response,
        403,
        "STAGING_SPORTSDATAIO_IMPORT_DENIED"
      );
    }
    if (
      [
        "STAGING_SPORTSDATAIO_IMPORT_INPUT_INVALID",
        "STAGING_SPORTSDATAIO_IMPORT_IDEMPOTENCY_INVALID",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        400,
        "STAGING_SPORTSDATAIO_IMPORT_INVALID"
      );
    }
    if (
      [
        "STAGING_SPORTSDATAIO_IMPORT_IN_PROGRESS",
        "STAGING_SPORTSDATAIO_IMPORT_IDEMPOTENCY_CONFLICT",
        "STAGING_SPORTSDATAIO_IMPORT_IDENTITY_MISMATCH",
        "STAGING_SPORTSDATAIO_IMPORT_AUTHORITY_CHANGED",
        "DATABASE_IDENTITY_MISMATCH",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        409,
        "STAGING_SPORTSDATAIO_IMPORT_CONFLICT"
      );
    }
    return failure(
      request,
      response,
      500,
      "STAGING_SPORTSDATAIO_IMPORT_FAILED"
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
  router.use(
    ROUTE_PATH,
    express.json({ limit: "4kb", strict: true })
  );
  router.post(
    ROUTE_PATH,
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        const data =
          await stagingSportsDataIoImportService.run({
            input: request.body,
            idempotencyKey: request.get("idempotency-key"),
            authenticated:
              requestSecurity.getAuthenticatedSession(request),
          });
        return response.status(200).json({
          data,
          meta: {
            requestId: requestSecurity.getRequestId(request),
          },
        });
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );
  router.use(
    ROUTE_PATH,
    (error, request, response, next) => {
      if (response.headersSent) return next(error);
      if (error?.type === "entity.too.large") {
        return failure(
          request,
          response,
          413,
          "STAGING_SPORTSDATAIO_IMPORT_REQUEST_TOO_LARGE"
        );
      }
      return failure(
        request,
        response,
        error?.type === "entity.parse.failed" ? 400 : 500,
        error?.type === "entity.parse.failed"
          ? "STAGING_SPORTSDATAIO_IMPORT_INVALID"
          : "STAGING_SPORTSDATAIO_IMPORT_FAILED"
      );
    }
  );
  return router;
}

module.exports = {
  ROUTE_PATH,
  SAFE_MESSAGES,
  createStagingSportsDataIoImportRouter,
};
