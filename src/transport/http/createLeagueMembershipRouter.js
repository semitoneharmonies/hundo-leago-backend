const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  COMMISSIONER_MEMBERSHIP_PROTECTED:
    "The current commissioner cannot be removed through member management.",
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  LEAGUE_MEMBERSHIP_CONFLICT:
    "The membership changed before it could be removed.",
  LEAGUE_MEMBERSHIP_INVALID:
    "The league-membership request is invalid.",
  LEAGUE_MEMBERSHIP_NOT_FOUND: "The league membership was not found.",
  LEAGUE_MEMBERSHIP_REQUEST_FAILED:
    "The league membership could not be removed.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league-membership routes require ${description}`);
  }
}

function createLeagueMembershipRouter({
  requestSecurity,
  leagueMembershipService,
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
    assertMethod(requestSecurity, method, "the target request-security boundary");
  }
  assertMethod(leagueMembershipService, "remove", "a membership service");

  function respond(request, response, status, payload) {
    return response.status(status).json({
      ...payload,
      meta: { requestId: requestSecurity.getRequestId(request) },
    });
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "4kb", strict: true }));

  router.delete(
    "/api/v1/leagues/:leagueId/memberships/:membershipId",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        return respond(request, response, 200, {
          data: leagueMembershipService.remove({
            authenticated: requestSecurity.getAuthenticatedSession(request),
            leagueId: request.params.leagueId,
            membershipId: request.params.membershipId,
            input: request.body,
          }),
        });
      } catch (error) {
        const code =
          error?.code === "LEAGUE_COMMISSIONER_REQUIRED"
            ? error.code
            : error?.code === "LEAGUE_MEMBERSHIP_INPUT_INVALID"
              ? "LEAGUE_MEMBERSHIP_INVALID"
              : [
                    "COMMISSIONER_MEMBERSHIP_PROTECTED",
                    "LEAGUE_MEMBERSHIP_NOT_FOUND",
                  ].includes(error?.code)
                ? error.code
                : error?.name === "LeagueMembershipConflictError" ||
                    error?.code === "REPOSITORY_VERSION_CONFLICT"
                  ? "LEAGUE_MEMBERSHIP_CONFLICT"
                  : "LEAGUE_MEMBERSHIP_REQUEST_FAILED";
        const status =
          code === "LEAGUE_COMMISSIONER_REQUIRED"
            ? 403
            : code === "LEAGUE_MEMBERSHIP_INVALID"
              ? 400
              : code === "LEAGUE_MEMBERSHIP_NOT_FOUND"
                ? 404
                : code === "LEAGUE_MEMBERSHIP_REQUEST_FAILED"
                  ? 500
                  : 409;
        return respond(request, response, status, {
          error: {
            code,
            message: SAFE_MESSAGES[code],
            requestId: requestSecurity.getRequestId(request),
          },
        });
      }
    }
  );

  return router;
}

module.exports = { SAFE_MESSAGES, createLeagueMembershipRouter };
