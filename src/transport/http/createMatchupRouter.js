const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  MATCHUP_AUTHORITY_DENIED: "Current commissioner authority is required.",
  MATCHUP_CONFLICT: "The matchup request conflicts with current state.",
  MATCHUP_FAILED: "The matchup request could not be completed.",
  MATCHUP_INPUT_INVALID: "The matchup request is invalid.",
  MATCHUP_NOT_FOUND: "The matchup resource was not found.",
  MATCHUP_PRECONDITION_FAILED: "The resource changed; refetch it and try again.",
  MATCHUP_REQUEST_TOO_LARGE: "The matchup request is too large.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`matchup routes require ${description}`);
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

function createMatchupRouter({ requestSecurity, matchupService } = {}) {
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
    "correctResult",
    "generateSchedule",
    "listWeeks",
    "readCurrentWeek",
    "readMatchup",
    "readStandings",
    "readWeek",
    "rebuildStandings",
    "transitionWeek",
  ]) {
    assertMethod(matchupService, method, "a matchup integration service");
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

  function failure(request, response, status, code) {
    return response.status(status).json({
      error: { code, message: SAFE_MESSAGES[code], requestId: requestId(request) },
    });
  }

  function mapError(request, response, error) {
    const code = error?.reasonCode || error?.code || "";
    if (
      code === "MATCHUP_INTEGRATION_INPUT_INVALID" ||
      code === "LEAGUE_ID_INVALID" ||
      code === "REPOSITORY_ARGUMENT_INVALID" ||
      code.endsWith("_INPUT_INVALID") ||
      code.endsWith("_VERSION_INVALID") ||
      code.endsWith("_REASON_INVALID") ||
      code.endsWith("_CONFIRMATION_REQUIRED")
    ) {
      return failure(request, response, 400, "MATCHUP_INPUT_INVALID");
    }
    if (
      code === "LEAGUE_COMMISSIONER_REQUIRED" ||
      code.endsWith("_COMMISSIONER_REQUIRED")
    ) {
      return failure(request, response, 403, "MATCHUP_AUTHORITY_DENIED");
    }
    if (
      code === "LEAGUE_NOT_FOUND" ||
      code.endsWith("_MISSING") ||
      code === "REPOSITORY_RECORD_NOT_FOUND"
    ) {
      return failure(request, response, 404, "MATCHUP_NOT_FOUND");
    }
    if (
      code === "MATCHUP_INTEGRATION_VERSION_CONFLICT" ||
      code === "REPOSITORY_VERSION_CONFLICT"
    ) {
      return failure(request, response, 412, "MATCHUP_PRECONDITION_FAILED");
    }
    if (
      code.startsWith("MATCHUP_") ||
      code.startsWith("REPOSITORY_CONSTRAINT_")
    ) {
      return failure(request, response, 409, "MATCHUP_CONFLICT");
    }
    return failure(request, response, 500, "MATCHUP_FAILED");
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "16kb", strict: true }));

  function read(method) {
    return (request, response) => {
      try {
        return success(request, response, 200, matchupService[method]({
          leagueId: request.params.leagueId,
          seasonId: request.params.seasonId,
          ...(request.params.weekId ? { weekId: request.params.weekId } : {}),
          ...(request.params.matchupId ? { matchupId: request.params.matchupId } : {}),
          authenticated: requestSecurity.getSessionBootstrap(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    };
  }

  function write(method) {
    return (request, response) => {
      const precondition = optionalIfMatch(request);
      if (!precondition.valid) {
        return failure(request, response, 400, "MATCHUP_INPUT_INVALID");
      }
      try {
        const result = matchupService[method]({
          leagueId: request.params.leagueId,
          seasonId: request.params.seasonId,
          ...(request.params.weekId ? { weekId: request.params.weekId } : {}),
          ...(request.params.resultId ? { resultId: request.params.resultId } : {}),
          input: request.body,
          expectedVersion: precondition.version,
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
        });
        const created = result.code === "MATCHUP_SCHEDULE_GENERATED";
        return success(request, response, created ? 201 : 200, result);
      } catch (error) {
        return mapError(request, response, error);
      }
    };
  }

  const base = "/api/v1/leagues/:leagueId/seasons/:seasonId";
  router.get(`${base}/matchup-weeks`, requestSecurity.authenticateBootstrap, read("listWeeks"));
  router.get(`${base}/matchup-weeks/current`, requestSecurity.authenticateBootstrap, read("readCurrentWeek"));
  router.get(`${base}/matchup-weeks/:weekId`, requestSecurity.authenticateBootstrap, read("readWeek"));
  router.get(
    `${base}/matchup-weeks/:weekId/matchups/:matchupId`,
    requestSecurity.authenticateBootstrap,
    read("readMatchup")
  );
  router.get(`${base}/standings`, requestSecurity.authenticateBootstrap, read("readStandings"));
  router.post(`${base}/matchup-schedules`, requestSecurity.authenticateUnsafe, write("generateSchedule"));
  router.patch(
    `${base}/matchup-weeks/:weekId`,
    requestSecurity.authenticateUnsafe,
    write("transitionWeek")
  );
  router.post(
    `${base}/matchup-results/:resultId/corrections`,
    requestSecurity.authenticateUnsafe,
    write("correctResult")
  );
  router.post(
    `${base}/standings/rebuilds`,
    requestSecurity.authenticateUnsafe,
    write("rebuildStandings")
  );

  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      return failure(request, response, 413, "MATCHUP_REQUEST_TOO_LARGE");
    }
    return failure(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed" ? "MATCHUP_INPUT_INVALID" : "MATCHUP_FAILED"
    );
  });

  return router;
}

module.exports = { SAFE_MESSAGES, createMatchupRouter, optionalIfMatch };
