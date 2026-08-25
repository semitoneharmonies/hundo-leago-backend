const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  STANDINGS_ALREADY_FINALIZED:
    "The regular-season standings are already finalized.",
  STANDINGS_FINALIZATION_INPUT_INVALID:
    "The standings-finalization request is invalid.",
  STANDINGS_FINALIZATION_LEGACY_CONFLICT:
    "Existing standings history prevents finalization.",
  STANDINGS_FINALIZATION_NOT_FOUND:
    "The standings-finalization resource was not found.",
  STANDINGS_FINALIZATION_NOT_READY:
    "The regular-season standings are not ready to be finalized.",
  STANDINGS_FINALIZATION_PRECONDITION_FAILED:
    "The season changed; refetch it and try again.",
  STANDINGS_FINALIZATION_REQUEST_FAILED:
    "The standings finalization could not be completed.",
  STANDINGS_FINALIZATION_REQUEST_TOO_LARGE:
    "The standings-finalization request is too large.",
  STANDINGS_RESULT_SET_CHANGED:
    "The official result set changed; refetch the standings and try again.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `standings-finalization routes require ${description}`
    );
  }
}

function parseIfMatch(request) {
  const value = request.get("if-match");
  const match =
    typeof value === "string" &&
    /^"([1-9]\d*)"$/.exec(value);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version)
    ? version
    : null;
}

function createStandingsFinalizationRouter({
  requestSecurity,
  standingsFinalizationService,
  auditPrivacyDigest,
  networkSourceResolver = (request) =>
    request.ip,
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
    standingsFinalizationService,
    "finalize",
    "a standings-finalization service"
  );
  assertMethod(
    auditPrivacyDigest,
    "digest",
    "an audit privacy digest"
  );
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "standings-finalization routes require a network-source resolver"
    );
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function successResponse(
    request,
    response,
    result
  ) {
    return response
      .status(201)
      .set("Cache-Control", "no-store")
      .json({
        data: result,
        meta: {
          requestId: requestId(request),
        },
      });
  }

  function errorResponse(
    request,
    response,
    status,
    code,
    details
  ) {
    return response
      .status(status)
      .set("Cache-Control", "no-store")
      .json({
        error: {
          code,
          message: SAFE_MESSAGES[code],
          requestId: requestId(request),
          ...(details ? { details } : {}),
        },
      });
  }

  function auditContext(request) {
    const networkSource =
      networkSourceResolver(request);
    if (
      typeof networkSource !== "string" ||
      networkSource.length < 1 ||
      networkSource.length > 128 ||
      networkSource !== networkSource.trim()
    ) {
      throw new TypeError(
        "the canonical network source is unavailable"
      );
    }
    const network = auditPrivacyDigest.digest(
      `network\0${networkSource}`
    );
    return {
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "unknown",
        origin: request.get("origin"),
      }),
      networkKeyVersion: network.keyVersion,
      networkMetadataDigest: network.digest,
      requestCorrelationId: requestId(request),
    };
  }

  function mapError(
    request,
    response,
    error
  ) {
    const code = error?.code;
    if (
      [
        "LEAGUE_ID_INVALID",
        "REPOSITORY_ARGUMENT_INVALID",
        "SEASON_ID_INVALID",
        "STANDINGS_FINALIZATION_INPUT_INVALID",
      ].includes(code)
    ) {
      return errorResponse(
        request,
        response,
        400,
        "STANDINGS_FINALIZATION_INPUT_INVALID"
      );
    }
    if (code === "LEAGUE_COMMISSIONER_REQUIRED") {
      return errorResponse(
        request,
        response,
        403,
        code
      );
    }
    if (
      [
        "LEAGUE_NOT_FOUND",
        "REPOSITORY_RECORD_NOT_FOUND",
        "SEASON_NOT_FOUND",
        "STANDINGS_FINALIZATION_NOT_FOUND",
      ].includes(code)
    ) {
      return errorResponse(
        request,
        response,
        404,
        "STANDINGS_FINALIZATION_NOT_FOUND"
      );
    }
    if (
      code ===
        "STANDINGS_FINALIZATION_PRECONDITION_FAILED" ||
      code === "REPOSITORY_VERSION_CONFLICT"
    ) {
      return errorResponse(
        request,
        response,
        412,
        "STANDINGS_FINALIZATION_PRECONDITION_FAILED",
        error.details
      );
    }
    if (
      [
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        "STANDINGS_ALREADY_FINALIZED",
        "STANDINGS_FINALIZATION_LEGACY_CONFLICT",
        "STANDINGS_FINALIZATION_NOT_READY",
        "STANDINGS_RESULT_SET_CHANGED",
      ].includes(code)
    ) {
      return errorResponse(
        request,
        response,
        409,
        code
      );
    }
    return errorResponse(
      request,
      response,
      500,
      "STANDINGS_FINALIZATION_REQUEST_FAILED"
    );
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(
    requestSecurity.requireCompatibleFetchMetadata
  );
  router.use(
    express.json({
      limit: "1kb",
      strict: true,
    })
  );

  router.post(
    "/api/v1/leagues/:leagueId/seasons/:seasonId/standings/finalizations",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const expectedSeasonVersion =
          parseIfMatch(request);
        if (expectedSeasonVersion === null) {
          return errorResponse(
            request,
            response,
            400,
            "STANDINGS_FINALIZATION_INPUT_INVALID"
          );
        }
        return successResponse(
          request,
          response,
          standingsFinalizationService.finalize({
            leagueId: request.params.leagueId,
            seasonId: request.params.seasonId,
            input: request.body,
            expectedSeasonVersion,
            idempotencyKey:
              request.get("idempotency-key"),
            authenticated:
              requestSecurity
                .getAuthenticatedSession(
                  request
                ),
            auditContext:
              auditContext(request),
          })
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

  router.use(
    (error, request, response, next) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (error?.type === "entity.too.large") {
        errorResponse(
          request,
          response,
          413,
          "STANDINGS_FINALIZATION_REQUEST_TOO_LARGE"
        );
        return;
      }
      errorResponse(
        request,
        response,
        error?.type === "entity.parse.failed"
          ? 400
          : 500,
        error?.type === "entity.parse.failed"
          ? "STANDINGS_FINALIZATION_INPUT_INVALID"
          : "STANDINGS_FINALIZATION_REQUEST_FAILED"
      );
    }
  );

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createStandingsFinalizationRouter,
  parseIfMatch,
};
