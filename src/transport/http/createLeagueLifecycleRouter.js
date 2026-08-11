const express = require("express");
const {
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
} = require(
  "../../domain/leagues/leagueLifecycleTransitionPolicy"
);

const SAFE_MESSAGES = Object.freeze({
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
  INITIAL_SEASON2_NO_DRAFT_NOT_ELIGIBLE:
    "The initial Season 2 no-draft exemption is not eligible.",
  INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE:
    "The earlier initial Season 2 no-draft exemption result is unavailable.",
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID:
    "The league lifecycle-transition request is invalid.",
  LEAGUE_LIFECYCLE_TRANSITION_REQUEST_FAILED:
    "The league lifecycle-transition request could not be completed.",
  LEAGUE_LIFECYCLE_TRANSITION_TOO_LARGE:
    "The league lifecycle-transition request is too large.",
  LEAGUE_NOT_FOUND:
    "The league was not found.",
  LEAGUE_TRADE_DEADLINE_INPUT_INVALID:
    "The setup trade-deadline request is invalid.",
  LEAGUE_TRADE_DEADLINE_NOT_FUTURE:
    "The setup trade deadline must be in the future.",
  LEAGUE_TRADE_DEADLINE_NOT_ALLOWED:
    "The setup trade deadline cannot be recorded in the league's current state.",
  LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED:
    "The league changed; refetch it and try again.",
  LEAGUE_TRADE_DEADLINE_REQUEST_FAILED:
    "The setup trade-deadline request could not be completed.",
  LEAGUE_TRADE_DEADLINE_RESULT_UNAVAILABLE:
    "The earlier setup trade-deadline result is unavailable.",
  LEAGUE_TRADE_DEADLINE_SETTINGS_INVALID:
    "The league setup settings are unavailable or inconsistent.",
  LEAGUE_TRADE_DEADLINE_TOO_LARGE:
    "The setup trade-deadline request is too large.",
  LEAGUE_START_INPUT_INVALID:
    "The league-start request is invalid.",
  LEAGUE_START_INVITATIONS_PENDING:
    "Every pending launch invitation must be resolved before the league starts.",
  LEAGUE_START_INVITATION_STATE_INVALID:
    "An accepted launch invitation is inconsistent.",
  LEAGUE_START_MINIMUM_TEAMS_REQUIRED:
    "At least four teams are required before the league starts.",
  LEAGUE_START_NOT_ALLOWED:
    "The league cannot be started in its current state.",
  LEAGUE_START_PRECONDITION_FAILED:
    "The league changed; refetch it and try again.",
  LEAGUE_START_REQUEST_FAILED:
    "The league-start request could not be completed.",
  LEAGUE_START_RESULT_UNAVAILABLE:
    "The earlier league-start result is unavailable.",
  LEAGUE_START_SEASON_INVALID:
    "The league must have one planned current season before it starts.",
  LEAGUE_START_SETTINGS_INVALID:
    "League setup settings, including the trade deadline, must be complete before the league starts.",
  LEAGUE_START_TEAM_MANAGER_REQUIRED:
    "Every launch team requires an active manager before the league starts.",
  LEAGUE_START_TEAM_STATE_INVALID:
    "Every launch team must still be in Setup.",
  LEAGUE_START_TOO_LARGE:
    "The league-start request is too large.",
  PLATFORM_ADMINISTRATOR_REQUIRED:
    "Platform-administrator authority is required.",
  SEASON_ROLLOVER_NOT_READY:
    "The scheduled season rollover is not ready.",
  SEASON_ROLLOVER_PRECONDITION_FAILED:
    "The Entry Draft changed; refetch it and try again.",
  SEASON_ROLLOVER_RESULT_UNAVAILABLE:
    "The earlier season-rollover result is unavailable.",
});

function requireMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `league lifecycle routes require ${description}`
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

function createLeagueLifecycleRouter({
  requestSecurity,
  leagueLifecycleTransitionService,
  leagueTradeDeadlineService,
  leagueStartService,
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
    requireMethod(
      requestSecurity,
      method,
      "the target request-security boundary"
    );
  }
  requireMethod(
    leagueLifecycleTransitionService,
    "transition",
    "a league lifecycle-transition service"
  );
  requireMethod(
    leagueTradeDeadlineService,
    "record",
    "a setup trade-deadline service"
  );
  requireMethod(
    leagueStartService,
    "start",
    "a league-start service"
  );
  requireMethod(
    auditPrivacyDigest,
    "digest",
    "an audit privacy digest"
  );
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "league lifecycle routes require a network-source resolver"
    );
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function successResponse(
    request,
    response,
    result,
    status = 200
  ) {
    return response
      .status(status)
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
    if (
      [
        "LEAGUE_ID_INVALID",
        "LEAGUE_START_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        400,
        "LEAGUE_START_INPUT_INVALID"
      );
    }
    if (
      error?.code ===
      "LEAGUE_COMMISSIONER_REQUIRED"
    ) {
      return errorResponse(
        request,
        response,
        403,
        error.code
      );
    }
    if (error?.code === "LEAGUE_NOT_FOUND") {
      return errorResponse(
        request,
        response,
        404,
        error.code
      );
    }
    if (
      error?.code ===
      "LEAGUE_START_PRECONDITION_FAILED"
    ) {
      return errorResponse(
        request,
        response,
        412,
        error.code,
        error.details
      );
    }
    if (
      [
        "LEAGUE_START_INVITATIONS_PENDING",
        "LEAGUE_START_MINIMUM_TEAMS_REQUIRED",
        "LEAGUE_START_SETTINGS_INVALID",
        "LEAGUE_START_TEAM_MANAGER_REQUIRED",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        422,
        error.code
      );
    }
    if (
      [
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        "LEAGUE_START_INVITATION_STATE_INVALID",
        "LEAGUE_START_NOT_ALLOWED",
        "LEAGUE_START_RESULT_UNAVAILABLE",
        "LEAGUE_START_SEASON_INVALID",
        "LEAGUE_START_TEAM_STATE_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        409,
        error.code
      );
    }
    return errorResponse(
      request,
      response,
      500,
      "LEAGUE_START_REQUEST_FAILED"
    );
  }

  function mapTradeDeadlineError(
    request,
    response,
    error
  ) {
    if (
      [
        "LEAGUE_ID_INVALID",
        "LEAGUE_TRADE_DEADLINE_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        400,
        "LEAGUE_TRADE_DEADLINE_INPUT_INVALID"
      );
    }
    if (
      error?.code ===
      "LEAGUE_COMMISSIONER_REQUIRED"
    ) {
      return errorResponse(
        request,
        response,
        403,
        error.code
      );
    }
    if (error?.code === "LEAGUE_NOT_FOUND") {
      return errorResponse(
        request,
        response,
        404,
        error.code
      );
    }
    if (
      error?.code ===
      "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED"
    ) {
      return errorResponse(
        request,
        response,
        412,
        error.code,
        error.details
      );
    }
    if (
      error?.code ===
      "LEAGUE_TRADE_DEADLINE_NOT_FUTURE"
    ) {
      return errorResponse(
        request,
        response,
        422,
        error.code
      );
    }
    if (
      [
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        "LEAGUE_TRADE_DEADLINE_NOT_ALLOWED",
        "LEAGUE_TRADE_DEADLINE_RESULT_UNAVAILABLE",
        "LEAGUE_TRADE_DEADLINE_SETTINGS_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        409,
        error.code
      );
    }
    return errorResponse(
      request,
      response,
      500,
      "LEAGUE_TRADE_DEADLINE_REQUEST_FAILED"
    );
  }

  function mapLifecycleTransitionError(
    request,
    response,
    error
  ) {
    if (
      [
        "LEAGUE_ID_INVALID",
        "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        400,
        "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
      );
    }
    if (
      [
        "LEAGUE_COMMISSIONER_REQUIRED",
        "PLATFORM_ADMINISTRATOR_REQUIRED",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        403,
        error.code
      );
    }
    if (error?.code === "LEAGUE_NOT_FOUND") {
      return errorResponse(
        request,
        response,
        404,
        error.code
      );
    }
    if (
      error?.code ===
      "SEASON_ROLLOVER_PRECONDITION_FAILED"
    ) {
      return errorResponse(
        request,
        response,
        412,
        error.code,
        error.details
      );
    }
    if (
      [
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        "INITIAL_SEASON2_NO_DRAFT_NOT_ELIGIBLE",
        "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE",
        "SEASON_ROLLOVER_NOT_READY",
        "SEASON_ROLLOVER_RESULT_UNAVAILABLE",
      ].includes(error?.code)
    ) {
      return errorResponse(
        request,
        response,
        409,
        error.code
      );
    }
    return errorResponse(
      request,
      response,
      500,
      "LEAGUE_LIFECYCLE_TRANSITION_REQUEST_FAILED"
    );
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(
    requestSecurity.requireAllowedOrigin
  );
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

  router.put(
    "/api/v1/leagues/:leagueId/setup/trade-deadline",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const expectedLeagueVersion =
          parseIfMatch(request);
        if (expectedLeagueVersion === null) {
          return errorResponse(
            request,
            response,
            400,
            "LEAGUE_TRADE_DEADLINE_INPUT_INVALID"
          );
        }
        return successResponse(
          request,
          response,
          leagueTradeDeadlineService.record({
            leagueId:
              request.params.leagueId,
            input: request.body,
            expectedLeagueVersion,
            idempotencyKey:
              request.get(
                "idempotency-key"
              ),
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
        return mapTradeDeadlineError(
          request,
          response,
          error
        );
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/lifecycle-transitions",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      try {
        let expectedDraftVersion = null;
        if (
          request.body?.transitionType ===
          RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
        ) {
          expectedDraftVersion =
            parseIfMatch(request);
          if (expectedDraftVersion === null) {
            return errorResponse(
              request,
              response,
              400,
              "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
            );
          }
        } else if (
          request.body?.transitionType ===
          INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE &&
          request.get("if-match") !== undefined
        ) {
          return errorResponse(
            request,
            response,
            400,
            "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
          );
        }
        return successResponse(
          request,
          response,
          await leagueLifecycleTransitionService.transition({
            leagueId:
              request.params.leagueId,
            input: request.body,
            expectedDraftVersion,
            idempotencyKey:
              request.get(
                "idempotency-key"
              ),
            authenticated:
              requestSecurity
                .getAuthenticatedSession(
                  request
                ),
            auditContext:
              auditContext(request),
          }),
          request.body?.transitionType ===
            RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
            ? 202
            : 201
        );
      } catch (error) {
        return mapLifecycleTransitionError(
          request,
          response,
          error
        );
      }
    }
  );

  router.post(
    "/api/v1/leagues/:leagueId/start",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const expectedLeagueVersion =
          parseIfMatch(request);
        if (expectedLeagueVersion === null) {
          return errorResponse(
            request,
            response,
            400,
            "LEAGUE_START_INPUT_INVALID"
          );
        }
        return successResponse(
          request,
          response,
          leagueStartService.start({
            leagueId:
              request.params.leagueId,
            input: request.body,
            expectedLeagueVersion,
            idempotencyKey:
              request.get(
                "idempotency-key"
              ),
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
        const tradeDeadlineRequest =
          request.path.endsWith(
            "/setup/trade-deadline"
          );
        const lifecycleTransitionRequest =
          request.path.endsWith(
            "/lifecycle-transitions"
          );
        errorResponse(
          request,
          response,
          413,
          tradeDeadlineRequest
            ? "LEAGUE_TRADE_DEADLINE_TOO_LARGE"
            : lifecycleTransitionRequest
              ? "LEAGUE_LIFECYCLE_TRANSITION_TOO_LARGE"
              : "LEAGUE_START_TOO_LARGE"
        );
        return;
      }
      const tradeDeadlineRequest =
        request.path.endsWith(
          "/setup/trade-deadline"
        );
      const lifecycleTransitionRequest =
        request.path.endsWith(
          "/lifecycle-transitions"
        );
      errorResponse(
        request,
        response,
        error?.type ===
          "entity.parse.failed"
          ? 400
          : 500,
        error?.type ===
          "entity.parse.failed"
          ? tradeDeadlineRequest
            ? "LEAGUE_TRADE_DEADLINE_INPUT_INVALID"
            : lifecycleTransitionRequest
              ? "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
              : "LEAGUE_START_INPUT_INVALID"
          : tradeDeadlineRequest
            ? "LEAGUE_TRADE_DEADLINE_REQUEST_FAILED"
            : lifecycleTransitionRequest
              ? "LEAGUE_LIFECYCLE_TRANSITION_REQUEST_FAILED"
              : "LEAGUE_START_REQUEST_FAILED"
      );
    }
  );

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createLeagueLifecycleRouter,
  parseIfMatch,
};
