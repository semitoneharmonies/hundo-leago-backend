const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  TRADE_RECOVERY_AUTHORITY_DENIED:
    "Current commissioner authority is required.",
  TRADE_RECOVERY_CONFLICT:
    "The completed trade cannot be recovered by this action.",
  TRADE_RECOVERY_FAILED: "The trade recovery request could not be completed.",
  TRADE_RECOVERY_INPUT_INVALID: "The trade recovery request is invalid.",
  TRADE_RECOVERY_NOT_FOUND: "The completed trade was not found.",
  TRADE_RECOVERY_PRECONDITION_FAILED:
    "The trade changed; refetch it and try again.",
  TRADE_RECOVERY_REQUEST_TOO_LARGE: "The trade recovery request is too large.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade recovery routes require ${description}`);
  }
}

function invalidInput() {
  const error = new Error("The trade recovery body is invalid.");
  error.reasonCode = "TRADE_REVERSAL_INPUT_INVALID";
  return error;
}

function exactConfirmationBody(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(body, "confirmed") ||
    body.confirmed !== true
  ) {
    throw invalidInput();
  }
  return true;
}

function createTradeRecoveryRouter({ requestSecurity, tradeRecoveryService } = {}) {
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
    assertMethod(requestSecurity, method, "the target request-security boundary");
  }
  for (const method of ["preview", "reverse", "markCorrectionRequired"]) {
    assertMethod(tradeRecoveryService, method, "a trade-recovery service");
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function success(request, response, data) {
    return response.status(200).json({
      data,
      meta: { requestId: requestId(request) },
    });
  }

  function failure(request, response, status, code) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestId(request),
      },
    });
  }

  function mapError(request, response, error) {
    const code = error?.reasonCode || error?.code;
    if (
      code === "TRADE_REVERSAL_INPUT_INVALID" ||
      code?.endsWith("_STABLE_ID_INVALID") ||
      code?.endsWith("_IDEMPOTENCY_INVALID") ||
      code?.endsWith("_TIMESTAMP_INVALID") ||
      code?.endsWith("_VERSION_INVALID") ||
      code === "TRADE_REVERSAL_CONFIRMATION_REQUIRED"
    ) {
      return failure(request, response, 400, "TRADE_RECOVERY_INPUT_INVALID");
    }
    if (
      [
        "LEAGUE_COMMISSIONER_REQUIRED",
        "TRADE_REVERSAL_AUTHORITY_INVALID",
        "TRADE_REVERSAL_ROLE_DENIED",
      ].includes(code)
    ) {
      return failure(request, response, 403, "TRADE_RECOVERY_AUTHORITY_DENIED");
    }
    if (
      [
        "LEAGUE_NOT_FOUND",
        "TRADE_REVERSAL_NOT_FOUND",
      ].includes(code)
    ) {
      return failure(request, response, 404, "TRADE_RECOVERY_NOT_FOUND");
    }
    if (code === "TRADE_REVERSAL_VERSION_CONFLICT") {
      return failure(
        request,
        response,
        412,
        "TRADE_RECOVERY_PRECONDITION_FAILED"
      );
    }
    if (typeof code === "string" && code.startsWith("TRADE_REVERSAL_")) {
      return failure(request, response, 409, "TRADE_RECOVERY_CONFLICT");
    }
    return failure(request, response, 500, "TRADE_RECOVERY_FAILED");
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
    "/api/v1/leagues/:leagueId/trades/:tradeId/reversal-preview",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(request, response, tradeRecoveryService.preview({
          leagueId: request.params.leagueId,
          input: { tradeId: request.params.tradeId },
          authenticated: requestSecurity.getSessionBootstrap(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  function write(method) {
    return (request, response) => {
      try {
        const confirmed = exactConfirmationBody(request.body);
        return success(request, response, tradeRecoveryService[method]({
          leagueId: request.params.leagueId,
          input: { tradeId: request.params.tradeId, confirmed },
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    };
  }

  router.post(
    "/api/v1/leagues/:leagueId/trades/:tradeId/reverse",
    requestSecurity.authenticateUnsafe,
    write("reverse")
  );
  router.post(
    "/api/v1/leagues/:leagueId/trades/:tradeId/correction-required",
    requestSecurity.authenticateUnsafe,
    write("markCorrectionRequired")
  );

  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      return failure(
        request,
        response,
        413,
        "TRADE_RECOVERY_REQUEST_TOO_LARGE"
      );
    }
    return failure(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "TRADE_RECOVERY_INPUT_INVALID"
        : "TRADE_RECOVERY_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createTradeRecoveryRouter,
  exactConfirmationBody,
};
