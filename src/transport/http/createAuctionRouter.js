const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  AUCTION_BID_AUTHORIZATION_DENIED: "Current auction authority is required.",
  AUCTION_BID_COOLDOWN_ACTIVE: "This bid is still in its edit cooldown.",
  AUCTION_BID_EDIT_LIMIT_REACHED: "This bid has no manager edits remaining.",
  AUCTION_BID_INPUT_INVALID: "The auction-bid request is invalid.",
  AUCTION_BID_WINDOW_CLOSED: "Auction bidding is closed.",
  AUCTION_ADMIN_ACTION_INVALID: "The auction administration action is not allowed.",
  AUCTION_ADMINISTRATION_AUTHORIZATION_DENIED:
    "Current auction-administration authority is required.",
  AUCTION_CREATION_AUTHORIZATION_DENIED: "Current auction authority is required.",
  AUCTION_CREATION_INPUT_INVALID: "The auction-start request is invalid.",
  AUCTION_CREATION_WINDOW_CLOSED: "New auctions cannot be started now.",
  AUCTION_INPUT_INVALID: "The auction request is invalid.",
  AUCTION_NOT_FOUND: "The auction was not found.",
  AUCTION_PRECONDITION_FAILED: "The bid changed; refetch it and try again.",
  AUCTION_REQUEST_CONFLICT: "The auction request conflicts with current state.",
  AUCTION_REQUEST_FAILED: "The auction request could not be completed.",
  AUCTION_REQUEST_TOO_LARGE: "The auction request is too large.",
  FAD_ALLOCATION_QUARANTINED: "This player is temporarily unavailable.",
  IDEMPOTENCY_KEY_REUSED:
    "This idempotency key was already used for a different request.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  TEAM_MANAGER_REQUIRED: "Current team-manager authority is required.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`auction routes require ${description}`);
  }
}

function optionalIfMatch(request) {
  const value = request.get("if-match");
  if (value === undefined) return Object.freeze({ valid: true, version: null });
  const match = typeof value === "string" && /^"([1-9]\d*)"$/.exec(value);
  if (!match) return Object.freeze({ valid: false, version: null });
  const version = Number(match[1]);
  return Object.freeze({ valid: Number.isSafeInteger(version), version });
}

function createAuctionRouter({
  requestSecurity,
  auctionService,
  auctionAdministrationService,
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
    assertMethod(requestSecurity, method, "the target request-security boundary");
  }
  for (const method of [
    "list",
    "putMine",
    "read",
    "start",
  ]) {
    assertMethod(auctionService, method, "an auction service");
  }
  for (const method of [
    "editBid",
    "removeBid",
    "cancelAuction",
    "requestResolution",
  ]) {
    assertMethod(
      auctionAdministrationService,
      method,
      "an auction-administration service"
    );
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function success(request, response, status, data) {
    return response.status(status).json({
      data,
      meta: { requestId: requestId(request) },
    });
  }

  function collectionSuccess(
    request,
    response,
    result
  ) {
    return response.status(200).json({
      data: result.data,
      actions: result.actions,
      page: result.page,
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
    const policyCode = error?.code;
    const code =
      typeof policyCode === "string" &&
      (
        policyCode.startsWith(
          "AUCTION_ADMINISTRATION_"
        ) ||
        policyCode ===
          "AUCTION_ADMIN_ACTION_INVALID" ||
        policyCode ===
          "AUCTION_READ_INPUT_INVALID"
      )
        ? policyCode
        : error?.reasonCode || policyCode;
    if (
      code ===
        "AUCTION_ADMINISTRATION_REQUEST_INVALID" ||
      code === "REPOSITORY_ARGUMENT_INVALID" ||
      code === "AUCTION_READ_INPUT_INVALID"
    ) {
      return failure(
        request,
        response,
        400,
        "AUCTION_INPUT_INVALID"
      );
    }
    if (code === "AUCTION_ADMIN_ACTION_INVALID") {
      return failure(
        request,
        response,
        422,
        "AUCTION_ADMIN_ACTION_INVALID"
      );
    }
    if (
      code ===
        "FAD_BINDING_ILLEGALITY_CONFIRMATION_REQUIRED"
    ) {
      return failure(request, response, 422, code);
    }
    if (
      code ===
        "AUCTION_ADMINISTRATION_AUTHORIZATION_DENIED"
    ) {
      return failure(
        request,
        response,
        403,
        code
      );
    }
    if (code === "AUCTION_READ_AUTHORIZATION_DENIED") {
      return failure(
        request,
        response,
        404,
        "LEAGUE_NOT_FOUND"
      );
    }
    if (
      code === "IDEMPOTENCY_KEY_REUSED"
    ) {
      return failure(
        request,
        response,
        409,
        code
      );
    }
    if (
      code ===
        "AUCTION_PRECONDITION_FAILED"
    ) {
      return failure(
        request,
        response,
        412,
        code
      );
    }
    if (
      [
        "AUCTION_ADMINISTRATION_NOT_DUE",
        "AUCTION_ADMINISTRATION_STATE_CONFLICT",
        "AUCTION_ADMIN_FAD_INTEGRATION_REQUIRED",
        "REPOSITORY_CONSTRAINT",
        "REPOSITORY_VERSION_CONFLICT",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        409,
        "AUCTION_REQUEST_CONFLICT"
      );
    }
    if (
      code === "REPOSITORY_RECORD_NOT_FOUND"
    ) {
      return failure(
        request,
        response,
        404,
        "AUCTION_NOT_FOUND"
      );
    }
    if (
      code === "AUCTION_INPUT_INVALID" ||
      code?.endsWith("_INPUT_INVALID") ||
      code?.endsWith("_STABLE_ID_INVALID") ||
      code?.endsWith("_IDEMPOTENCY_INVALID") ||
      code?.endsWith("_TIMESTAMP_INVALID") ||
      code?.endsWith("_TERM_INVALID") ||
      code?.endsWith("_VALUE_INVALID") ||
      code === "LEAGUE_ID_INVALID" ||
      code === "TEAM_ID_INVALID"
    ) {
      return failure(
        request,
        response,
        400,
        code?.startsWith("AUCTION_CREATION")
          ? "AUCTION_CREATION_INPUT_INVALID"
          : code === "AUCTION_INPUT_INVALID"
            ? code
            : "AUCTION_BID_INPUT_INVALID"
      );
    }
    if (
      [
        "AUCTION_BID_AUTHORIZATION_DENIED",
        "AUCTION_CREATION_AUTHORIZATION_DENIED",
        "LEAGUE_COMMISSIONER_REQUIRED",
        "TEAM_MANAGER_REQUIRED",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        403,
        code === "TEAM_MANAGER_REQUIRED" ? code :
          code?.startsWith("AUCTION_CREATION")
            ? "AUCTION_CREATION_AUTHORIZATION_DENIED"
            : "AUCTION_BID_AUTHORIZATION_DENIED"
      );
    }
    if (
      [
        "AUCTION_NOT_FOUND",
        "AUCTION_BID_AUCTION_UNAVAILABLE",
        "LEAGUE_NOT_FOUND",
        "TEAM_NOT_FOUND",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        404,
        code === "LEAGUE_NOT_FOUND" ? code : "AUCTION_NOT_FOUND"
      );
    }
    if (code === "AUCTION_BID_VERSION_CONFLICT") {
      return failure(request, response, 412, "AUCTION_PRECONDITION_FAILED");
    }
    if (code === "FAD_ALLOCATION_QUARANTINED") {
      return failure(request, response, 409, code);
    }
    if (
      code?.startsWith("AUCTION_BID_") ||
      code?.startsWith("AUCTION_CREATION_")
    ) {
      const publicCode = [
        "AUCTION_BID_COOLDOWN_ACTIVE",
        "AUCTION_BID_EDIT_LIMIT_REACHED",
        "AUCTION_BID_WINDOW_CLOSED",
        "AUCTION_CREATION_WINDOW_CLOSED",
      ].includes(code)
        ? code
        : "AUCTION_REQUEST_CONFLICT";
      return failure(request, response, 409, publicCode);
    }
    return failure(request, response, 500, "AUCTION_REQUEST_FAILED");
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
    "/api/v1/leagues/:leagueId/auctions",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return collectionSuccess(request, response, auctionService.list({
          leagueId: request.params.leagueId,
          query: request.query,
          authenticated: requestSecurity.getSessionBootstrap(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );
  router.get(
    "/api/v1/leagues/:leagueId/auctions/:auctionId",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(request, response, 200, auctionService.read({
          leagueId: request.params.leagueId,
          auctionId: request.params.auctionId,
          authenticated: requestSecurity.getSessionBootstrap(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );
  router.post(
    "/api/v1/leagues/:leagueId/auctions",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        return success(request, response, 201, auctionService.start({
          leagueId: request.params.leagueId,
          input: request.body,
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );
  router.put(
    "/api/v1/leagues/:leagueId/auctions/:auctionId/bids/mine",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      const precondition = optionalIfMatch(request);
      if (!precondition.valid) {
        return failure(request, response, 400, "AUCTION_BID_INPUT_INVALID");
      }
      try {
        return success(request, response, 200, auctionService.putMine({
          leagueId: request.params.leagueId,
          auctionId: request.params.auctionId,
          input: request.body,
          expectedBidVersion: precondition.version,
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );
  router.patch(
    "/api/v1/leagues/:leagueId/auctions/:auctionId/bids/:bidId",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      const precondition = optionalIfMatch(request);
      if (
        !precondition.valid ||
        precondition.version === null
      ) {
        return failure(request, response, 400, "AUCTION_BID_INPUT_INVALID");
      }
      try {
        const result =
          auctionAdministrationService.editBid({
            leagueId:
              request.params.leagueId,
            auctionId:
              request.params.auctionId,
            bidId: request.params.bidId,
            input: request.body,
            expectedBidVersion:
              precondition.version,
            idempotencyKey:
              request.get(
                "idempotency-key"
              ),
            authenticated:
              requestSecurity.getAuthenticatedSession(
                request
              ),
          });
        return success(
          request,
          response,
          result.httpStatus,
          result.data
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );
  router.delete(
    "/api/v1/leagues/:leagueId/auctions/:auctionId/bids/:bidId",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      const precondition = optionalIfMatch(request);
      if (
        !precondition.valid ||
        precondition.version === null
      ) {
        return failure(
          request,
          response,
          400,
          "AUCTION_BID_INPUT_INVALID"
        );
      }
      try {
        const result =
          auctionAdministrationService.removeBid({
            leagueId: request.params.leagueId,
            auctionId: request.params.auctionId,
            bidId: request.params.bidId,
            input: request.body,
            expectedBidVersion:
              precondition.version,
            idempotencyKey:
              request.get("idempotency-key"),
            authenticated:
              requestSecurity.getAuthenticatedSession(
                request
              ),
          });
        return success(
          request,
          response,
          result.httpStatus,
          result.data
        );
      } catch (error) {
        return mapError(
          request,
          response,
          error
        );
      }
    }
  );
  router.post(
    "/api/v1/leagues/:leagueId/auctions/:auctionId/cancel",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      const precondition = optionalIfMatch(request);
      if (
        !precondition.valid ||
        precondition.version === null
      ) {
        return failure(
          request,
          response,
          400,
          "AUCTION_INPUT_INVALID"
        );
      }
      try {
        const result =
          auctionAdministrationService.cancelAuction(
            {
              leagueId:
                request.params.leagueId,
              auctionId:
                request.params.auctionId,
              input: request.body,
              expectedAuctionVersion:
                precondition.version,
              idempotencyKey:
                request.get(
                  "idempotency-key"
                ),
              authenticated:
                requestSecurity.getAuthenticatedSession(
                  request
                ),
            }
          );
        return success(
          request,
          response,
          result.httpStatus,
          result.data
        );
      } catch (error) {
        return mapError(
          request,
          response,
          error
        );
      }
    }
  );
  router.post(
    "/api/v1/leagues/:leagueId/auctions/:auctionId/resolve",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      const precondition = optionalIfMatch(request);
      if (
        !precondition.valid ||
        precondition.version === null
      ) {
        return failure(
          request,
          response,
          400,
          "AUCTION_INPUT_INVALID"
        );
      }
      try {
        const result =
          auctionAdministrationService.requestResolution(
            {
              leagueId:
                request.params.leagueId,
              auctionId:
                request.params.auctionId,
              input: request.body,
              expectedAuctionVersion:
                precondition.version,
              idempotencyKey:
                request.get(
                  "idempotency-key"
                ),
              authenticated:
                requestSecurity.getAuthenticatedSession(
                  request
                ),
            }
          );
        return success(
          request,
          response,
          result.httpStatus,
          result.data
        );
      } catch (error) {
        return mapError(
          request,
          response,
          error
        );
      }
    }
  );

  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      return failure(request, response, 413, "AUCTION_REQUEST_TOO_LARGE");
    }
    return failure(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "AUCTION_INPUT_INVALID"
        : "AUCTION_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = { SAFE_MESSAGES, createAuctionRouter, optionalIfMatch };
