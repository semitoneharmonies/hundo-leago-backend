const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  LEAGUE_NOT_FOUND: "The league was not found.",
  PLAYER_NOT_FOUND: "The player was not found.",
  PLAYER_READ_FAILED: "The player request could not be completed.",
  PLAYER_READ_INPUT_INVALID: "The player request is invalid.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`player routes require ${description}`);
  }
}

function createPlayerRouter({ requestSecurity, playerReadService } = {}) {
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
    assertMethod(
      requestSecurity,
      method,
      "the target request-security boundary"
    );
  }
  for (const method of ["list", "read"]) {
    assertMethod(playerReadService, method, "a player read service");
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
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
    if (error?.code === "PLAYER_READ_INPUT_INVALID") {
      return failure(request, response, 400, error.code);
    }
    if (error?.code === "PLAYER_NOT_FOUND") {
      return failure(request, response, 404, error.code);
    }
    if (error?.code === "LEAGUE_NOT_FOUND") {
      return failure(request, response, 404, error.code);
    }
    return failure(request, response, 500, "PLAYER_READ_FAILED");
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireCompatibleFetchMetadata);

  router.get(
    "/api/v1/players",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        const result = playerReadService.list({
          authenticated: requestSecurity.getSessionBootstrap(request),
          query: request.query.query,
          status: request.query.status,
          limit: request.query.limit,
          cursor: request.query.cursor,
          leagueId: request.query.leagueId,
          auctionEligible: request.query.auctionEligible,
        });
        return response.status(200).json({
          data: result.players,
          page: result.page,
          meta: { requestId: requestId(request) },
        });
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.get(
    "/api/v1/players/:playerId",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return response.status(200).json({
          data: playerReadService.read({
            authenticated: requestSecurity.getSessionBootstrap(request),
            playerId: request.params.playerId,
          }),
          meta: { requestId: requestId(request) },
        });
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  return router;
}

module.exports = { SAFE_MESSAGES, createPlayerRouter };
