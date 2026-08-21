const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  ACTIVE_CONTRACT_MISSING:
    "This player needs an active contract before joining this roster category.",
  BENCH_AAV_LIMIT_EXCEEDED:
    "This player's contract exceeds the maximum Bench AAV.",
  BUYOUT_CONTRACT_NOT_ELIGIBLE: "This contract is not eligible for buyout.",
  BUYOUT_CONTRACT_NOT_OWNED: "This team does not own that contract.",
  BUYOUT_LOCK_ACTIVE: "This contract is still protected by its auction buyout lock.",
  BUYOUT_PENDING_TRADE_EXISTS:
    "This contract cannot be bought out while it is included in a pending trade.",
  INJURED_RESERVE_FULL: "All injured-reserve slots are in use.",
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  PLAYER_NOT_IR_ELIGIBLE:
    "This player is not currently listed as injured-reserve eligible.",
  PROSPECT_DESTINATION_ILLEGAL:
    "That destination would create an illegal roster.",
  PROSPECT_ELC_SCHEDULE_UNAVAILABLE:
    "The three-season ELC schedule is not available yet.",
  PROSPECT_NOT_FOUND: "That prospect is not owned by this team.",
  PROSPECT_SIGNED_ELC_REQUIRED:
    "This prospect needs a signed fantasy ELC before activation.",
  PROSPECT_UNSIGNED_RIGHT_REQUIRED:
    "This action requires a current unsigned prospect right.",
  ROSTER_ACTION_CONFLICT:
    "The roster changed before this action could be completed.",
  ROSTER_ACTION_INVALID: "The roster action request is invalid.",
  ROSTER_ACTION_REQUEST_FAILED:
    "The roster action could not be completed.",
  ROSTER_OWNERSHIP_NOT_FOUND: "The roster player was not found.",
  ROSTER_ILLEGAL_CONFIRMATION_REQUIRED:
    "This move creates an illegal roster. Confirm the warning to continue.",
  TEAM_MANAGER_REQUIRED: "Current team-manager authority is required.",
  TEAM_NOT_FOUND: "The team was not found.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`roster-action routes require ${description}`);
  }
}

function createRosterActionRouter({ requestSecurity, rosterActionService } = {}) {
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
    assertMethod(requestSecurity, method, "the target request-security boundary");
  }
  for (const method of [
    "buyOutContract",
    "declineProspectElc",
    "moveRosterPlayer",
    "moveToInjuredReserve",
    "releaseProspectRights",
    "signProspect",
  ]) {
    assertMethod(rosterActionService, method, "a roster-action service");
  }

  function errorResponse(request, response, status, code, details = null) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestSecurity.getRequestId(request),
        ...(details === null ? {} : { details }),
      },
    });
  }

  function successResponse(request, response, result) {
    return response.status(200).json({
      data: result,
      meta: { requestId: requestSecurity.getRequestId(request) },
    });
  }

  function mapError(request, response, error) {
    const conflictCode =
      error?.reasonCode === "BUYOUT_LOCK_ACTIVE"
        ? "BUYOUT_LOCK_ACTIVE"
        : error?.reasonCode === "BUYOUT_PENDING_TRADE_EXISTS"
          ? "BUYOUT_PENDING_TRADE_EXISTS"
          : [
                "BUYOUT_CONTRACT_NOT_ELIGIBLE",
                "BUYOUT_CONTRACT_NOT_OWNED",
                "ACTIVE_CONTRACT_MISSING",
                "BENCH_AAV_LIMIT_EXCEEDED",
                "INJURED_RESERVE_FULL",
                "PLAYER_NOT_IR_ELIGIBLE",
                "PROSPECT_DESTINATION_ILLEGAL",
                "PROSPECT_ELC_SCHEDULE_UNAVAILABLE",
                "PROSPECT_NOT_FOUND",
                "PROSPECT_SIGNED_ELC_REQUIRED",
                "PROSPECT_UNSIGNED_RIGHT_REQUIRED",
                "ROSTER_ILLEGAL_CONFIRMATION_REQUIRED",
                "ROSTER_OWNERSHIP_NOT_FOUND",
              ].includes(error?.code)
            ? error.code
            : "ROSTER_ACTION_CONFLICT";
    if (
      error?.name === "RosterActionConflictError" ||
      error?.code === "REPOSITORY_VERSION_CONFLICT" ||
      (error?.name === "ProspectDecisionPolicyError" &&
        [
          "PROSPECT_DECISION_OWNERSHIP_INVALID",
          "PROSPECT_DECISION_SCOPE_MISMATCH",
          "PROSPECT_DECISION_VERSION_CONFLICT",
        ].includes(error?.reasonCode)) ||
      error?.reasonCode === "BUYOUT_LOCK_ACTIVE" ||
      error?.reasonCode === "BUYOUT_PENDING_TRADE_EXISTS"
    ) {
      return errorResponse(
        request,
        response,
        409,
        conflictCode,
        error?.details || null
      );
    }
    if (
      [
        "LEAGUE_ID_INVALID",
        "TEAM_ID_INVALID",
        "ROSTER_ACTION_INPUT_INVALID",
        "BUYOUT_INPUT_INVALID",
        "PROSPECT_DECISION_INPUT_INVALID",
        "ROSTER_MOVEMENT_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(request, response, 400, "ROSTER_ACTION_INVALID");
    }
    if (
      ["TEAM_MANAGER_REQUIRED", "LEAGUE_COMMISSIONER_REQUIRED"].includes(
        error?.code
      )
    ) {
      return errorResponse(request, response, 403, error.code);
    }
    if (error?.code === "TEAM_NOT_FOUND") {
      return errorResponse(request, response, 404, error.code);
    }
    return errorResponse(
      request,
      response,
      500,
      "ROSTER_ACTION_REQUEST_FAILED"
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

  router.post(
    "/api/v1/leagues/:leagueId/teams/:teamId/roster/:ownershipId/move",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        return successResponse(
          request,
          response,
          await rosterActionService.moveRosterPlayer({
            authenticated: requestSecurity.getAuthenticatedSession(request),
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            ownershipId: request.params.ownershipId,
            input: request.body,
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/teams/:teamId/roster/:ownershipId/move-to-ir",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        return successResponse(
          request,
          response,
          await rosterActionService.moveToInjuredReserve({
            authenticated: requestSecurity.getAuthenticatedSession(request),
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            ownershipId: request.params.ownershipId,
            input: request.body,
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/teams/:teamId/contracts/:contractId/buyout",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        return successResponse(
          request,
          response,
          await rosterActionService.buyOutContract({
            authenticated: requestSecurity.getAuthenticatedSession(request),
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            contractId: request.params.contractId,
            input: request.body,
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/teams/:teamId/prospects/:playerId/sign",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        return successResponse(
          request,
          response,
          await rosterActionService.signProspect({
            authenticated: requestSecurity.getAuthenticatedSession(request),
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            playerId: request.params.playerId,
            input: request.body,
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/teams/:teamId/prospects/:playerId/decline",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        return successResponse(
          request,
          response,
          await rosterActionService.declineProspectElc({
            authenticated: requestSecurity.getAuthenticatedSession(request),
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            playerId: request.params.playerId,
            input: request.body,
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.delete(
    "/api/v1/leagues/:leagueId/teams/:teamId/prospect-rights/:playerId",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        return successResponse(
          request,
          response,
          await rosterActionService.releaseProspectRights({
            authenticated: requestSecurity.getAuthenticatedSession(request),
            leagueId: request.params.leagueId,
            teamId: request.params.teamId,
            playerId: request.params.playerId,
            input: request.body,
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
    return errorResponse(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "ROSTER_ACTION_INVALID"
        : "ROSTER_ACTION_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = { SAFE_MESSAGES, createRosterActionRouter };
