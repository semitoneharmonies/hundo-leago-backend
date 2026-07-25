const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  TRADE_AUTHORIZATION_DENIED: "Current trade authority is required.",
  TRADE_INPUT_INVALID: "The trade request is invalid.",
  TRADE_NOT_FOUND: "The trade proposal was not found.",
  TRADE_PRECONDITION_FAILED:
    "The trade proposal changed; refetch it and try again.",
  TRADE_REQUEST_CONFLICT: "The trade request conflicts with current state.",
  TRADE_REQUEST_FAILED: "The trade request could not be completed.",
  TRADE_REQUEST_TOO_LARGE: "The trade request is too large.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade routes require ${description}`);
  }
}

function emptyObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function createTradeRouter({
  requestSecurity,
  tradeReadService,
  tradeProposalService,
  tradeCreationService,
  tradeLifecycleService,
  tradeAcceptancePreviewService,
  tradeAcceptanceService,
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
    assertMethod(requestSecurity, method, "the request-security boundary");
  }
  assertMethod(tradeReadService, "read", "a trade-read service");
  assertMethod(tradeProposalService, "list", "a trade-list service");
  assertMethod(tradeCreationService, "create", "a trade-creation service");
  assertMethod(tradeLifecycleService, "respond", "a trade-lifecycle service");
  assertMethod(
    tradeAcceptancePreviewService,
    "preview",
    "a trade-acceptance-preview service"
  );
  assertMethod(tradeAcceptanceService, "accept", "a trade-acceptance service");

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function success(request, response, status, data) {
    return response.status(status).json({
      data,
      meta: { requestId: requestId(request) },
    });
  }

  function failure(request, response, status, code) {
    return response.status(status).json({
      error: { code, message: SAFE_MESSAGES[code], requestId: requestId(request) },
    });
  }

  function mapError(request, response, caught) {
    const code = caught?.reasonCode || caught?.code || "";
    if (
      code === "TRADE_NOT_FOUND" ||
      code.endsWith("_NOT_FOUND")
    ) {
      return failure(request, response, 404, "TRADE_NOT_FOUND");
    }
    if (
      code.includes("AUTHORIZATION") ||
      code.endsWith("_ROLE_DENIED") ||
      code.endsWith("_MEMBERSHIP_REQUIRED") ||
      code.endsWith("_MANAGER_REQUIRED") ||
      code.endsWith("_COMMISSIONER_REQUIRED") ||
      code.endsWith("_USER_REQUIRED")
    ) {
      return failure(request, response, 403, "TRADE_AUTHORIZATION_DENIED");
    }
    if (code.endsWith("_VERSION_CONFLICT")) {
      return failure(request, response, 412, "TRADE_PRECONDITION_FAILED");
    }
    if (
      code.endsWith("_INPUT_INVALID") ||
      code.endsWith("_STABLE_ID_INVALID") ||
      code.endsWith("_TYPE_UNSUPPORTED") ||
      code.endsWith("_COUNT_INVALID") ||
      code.endsWith("_DESCRIPTION_INVALID") ||
      code.endsWith("_IDEMPOTENCY_INVALID") ||
      code.endsWith("_ACTION_INVALID") ||
      code.endsWith("_TIMESTAMP_INVALID") ||
      code.endsWith("_VERSION_INVALID")
    ) {
      return failure(request, response, 400, "TRADE_INPUT_INVALID");
    }
    if (
      code.startsWith("TRADE_") ||
      code === "TEAM_NOT_FOUND" ||
      code === "LEAGUE_NOT_FOUND"
    ) {
      return failure(request, response, 409, "TRADE_REQUEST_CONFLICT");
    }
    return failure(request, response, 500, "TRADE_REQUEST_FAILED");
  }

  function requireEmptyBody(request, response, next) {
    if (!emptyObject(request.body)) {
      failure(request, response, 400, "TRADE_INPUT_INVALID");
      return;
    }
    next();
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "32kb", strict: true }));

  router.get(
    "/api/v1/leagues/:leagueId/trades",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(request, response, 200, tradeProposalService.list({
          leagueId: request.params.leagueId,
          authenticated: requestSecurity.getSessionBootstrap(request),
        }));
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/trades",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        return success(request, response, 201, tradeCreationService.create({
          leagueId: request.params.leagueId,
          input: request.body,
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
        }));
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );

  router.get(
    "/api/v1/leagues/:leagueId/trades/:tradeId",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(request, response, 200, tradeReadService.read({
          leagueId: request.params.leagueId,
          tradeId: request.params.tradeId,
          authenticated: requestSecurity.getSessionBootstrap(request),
        }));
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );

  router.get(
    "/api/v1/leagues/:leagueId/trades/:tradeId/acceptance-preview",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(
          request,
          response,
          200,
          tradeAcceptancePreviewService.preview({
            leagueId: request.params.leagueId,
            input: { tradeId: request.params.tradeId },
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/trades/:tradeId/accept",
    requestSecurity.authenticateUnsafe,
    requireEmptyBody,
    (request, response) => {
      try {
        return success(request, response, 200, tradeAcceptanceService.accept({
          leagueId: request.params.leagueId,
          input: { tradeId: request.params.tradeId },
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
        }));
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );

  for (const { path, action } of [
    { path: "decline", action: "reject" },
    { path: "cancel", action: "cancel" },
  ]) {
    router.post(
      `/api/v1/leagues/:leagueId/trades/:tradeId/${path}`,
      requestSecurity.authenticateUnsafe,
      requireEmptyBody,
      (request, response) => {
        try {
          return success(request, response, 200, tradeLifecycleService.respond({
            leagueId: request.params.leagueId,
            input: { tradeId: request.params.tradeId, action },
            idempotencyKey: request.get("idempotency-key"),
            authenticated: requestSecurity.getAuthenticatedSession(request),
          }));
        } catch (caught) {
          return mapError(request, response, caught);
        }
      }
    );
  }

  router.use((caught, request, response, next) => {
    if (response.headersSent) return next(caught);
    return failure(
      request,
      response,
      caught?.type === "entity.too.large" ? 413 : 400,
      caught?.type === "entity.too.large"
        ? "TRADE_REQUEST_TOO_LARGE"
        : "TRADE_INPUT_INVALID"
    );
  });

  return router;
}

module.exports = { SAFE_MESSAGES, createTradeRouter, emptyObject };
