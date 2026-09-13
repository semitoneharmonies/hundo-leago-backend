const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  ACCOUNT_DISPLAY_NAME_UNAVAILABLE: "That display name is unavailable.",
  ACCOUNT_PROFILE_INPUT_INVALID: "The account-profile request is invalid.",
  ACCOUNT_PROFILE_NO_CHANGES: "The account profile is unchanged.",
  ACCOUNT_PROFILE_NOT_FOUND: "The account profile was not found.",
  ACCOUNT_PROFILE_PRECONDITION_FAILED:
    "The account profile changed; refresh it and try again.",
  ACCOUNT_PROFILE_REQUEST_FAILED:
    "The account-profile request could not be completed.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`account-profile routes require ${description}`);
  }
}

function parseIfMatch(request) {
  const value = request.get("if-match");
  const match = typeof value === "string" && /^"([1-9]\d*)"$/.exec(value);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

function createAccountProfileRouter({
  requestSecurity,
  accountProfileService,
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
  for (const method of ["read", "update"]) {
    assertMethod(accountProfileService, method, "an account-profile service");
  }

  function success(request, response, data) {
    return response.status(200).json({
      data,
      meta: { requestId: requestSecurity.getRequestId(request) },
    });
  }

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
    if (error?.code === "ACCOUNT_PROFILE_INPUT_INVALID") {
      return failure(request, response, 400, error.code);
    }
    if (error?.code === "ACCOUNT_PROFILE_NOT_FOUND") {
      return failure(request, response, 404, error.code);
    }
    if (error?.code === "ACCOUNT_PROFILE_PRECONDITION_FAILED") {
      return failure(request, response, 412, error.code);
    }
    if (
      ["ACCOUNT_DISPLAY_NAME_UNAVAILABLE", "ACCOUNT_PROFILE_NO_CHANGES"].includes(
        error?.code
      )
    ) {
      return failure(request, response, 409, error.code);
    }
    return failure(
      request,
      response,
      500,
      "ACCOUNT_PROFILE_REQUEST_FAILED"
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

  router.get(
    "/api/v1/account",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(
          request,
          response,
          accountProfileService.read({
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.patch(
    "/api/v1/account",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      const expectedVersion = parseIfMatch(request);
      if (expectedVersion === null) {
        return failure(
          request,
          response,
          400,
          "ACCOUNT_PROFILE_INPUT_INVALID"
        );
      }
      try {
        return success(
          request,
          response,
          accountProfileService.update({
            authenticated:
              requestSecurity.getAuthenticatedSession(request),
            input: request.body,
            expectedVersion,
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
    return failure(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "ACCOUNT_PROFILE_INPUT_INVALID"
        : "ACCOUNT_PROFILE_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createAccountProfileRouter,
  parseIfMatch,
};
