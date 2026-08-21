"use strict";

const express = require("express");

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const FAD_OPERATIONAL_WRITE_ACTION =
  "fad_operational_write";
const RECOVERY_VALIDATION_REASON_CODES = new Set([
  "action_invalid",
  "reason_invalid",
  "resource_id_invalid",
  "resource_id_must_be_null",
  "resource_id_required",
]);

const SAFE_MESSAGES = Object.freeze({
  CANDIDATE_CARD_NOT_FOUND:
    "The Candidate Card was not found.",
  FAD_CARDS_NOT_PUBLISHED:
    "Candidate Cards are not published yet.",
  FAD_CORRECTION_NOT_APPLICABLE:
    "The Free Agent Draft allocation correction is no longer safely applicable.",
  FAD_READINESS_NOT_READY:
    "Free Agent Draft readiness is not available for retry.",
  FAD_READINESS_PRECONDITION_FAILED:
    "Free Agent Draft readiness changed; refetch it and try again.",
  FAD_RECOVERY_ACTION_INVALID:
    "The Free Agent Draft recovery action is invalid.",
  FREE_AGENT_DRAFT_INPUT_INVALID:
    "The Free Agent Draft request is invalid.",
  FREE_AGENT_DRAFT_NOT_FOUND:
    "The Free Agent Draft was not found.",
  FREE_AGENT_DRAFT_REQUEST_FAILED:
    "The Free Agent Draft request could not be completed.",
  FREE_AGENT_DRAFT_REQUEST_TOO_LARGE:
    "The Free Agent Draft request is too large.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  PRECONDITION_FAILED:
    "The resource changed; refetch it and try again.",
  RATE_LIMITED:
    "Too many requests. Try again later.",
});

function assertMethod(
  value,
  method,
  description
) {
  if (
    !value ||
    typeof value[method] !== "function"
  ) {
    throw new TypeError(
      `FAD routes require ${description}`
    );
  }
}

function inputInvalid() {
  const error = new TypeError(
    "The Free Agent Draft request is invalid."
  );
  error.code = "FAD_READ_INPUT_INVALID";
  throw error;
}

function exactQuery(query, fields) {
  if (
    query === null ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.getOwnPropertySymbols(query).length !== 0 ||
    Object.keys(query).sort().join("|") !==
      [...fields].sort().join("|")
  ) {
    inputInvalid();
  }
  const result = {};
  for (const field of fields) {
    const value = query[field];
    if (
      typeof value !== "string" ||
      !UUID_V4_PATTERN.test(value)
    ) {
      inputInvalid();
    }
    result[field] = value;
  }
  return Object.freeze(result);
}

function navigationQuery(query) {
  const fields = Object.keys(query || {});
  if (fields.length === 0) {
    return Object.freeze({});
  }
  return exactQuery(query, [
    "rosterSeasonId",
    "rosterTeamId",
  ]);
}

function optionalQuery(query, allowed) {
  if (
    query === null ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.getOwnPropertySymbols(query).length !== 0 ||
    Object.keys(query).some(
      (field) => !allowed.includes(field)
    ) ||
    Object.values(query).some(
      (value) => typeof value !== "string"
    )
  ) {
    inputInvalid();
  }
  return query;
}

function readLimit(value) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) {
    inputInvalid();
  }
  const result = Number(value);
  if (
    !Number.isSafeInteger(result) ||
    result > 100
  ) {
    inputInvalid();
  }
  return result;
}

function readCursor(value) {
  if (value === undefined) return undefined;
  if (
    value.length < 1 ||
    Array.from(value).length > 1_024 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    inputInvalid();
  }
  return value;
}

function normalizeSearch(value) {
  if (value === undefined) return undefined;
  if (
    Array.from(value).some(
      (character) =>
        CONTROL_PATTERN.test(character) &&
        !/\s/u.test(character)
    )
  ) {
    inputInvalid();
  }
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (Array.from(normalized).length > 200) {
    inputInvalid();
  }
  return normalized;
}

function publishedCardsQuery(query) {
  const source = optionalQuery(query, [
    "cursor",
    "limit",
  ]);
  return Object.freeze({
    ...(source.cursor === undefined
      ? {}
      : { cursor: readCursor(source.cursor) }),
    ...(source.limit === undefined
      ? {}
      : { limit: readLimit(source.limit) }),
  });
}

function allocationResultsQuery(query) {
  const source = optionalQuery(query, [
    "cursor",
    "limit",
    "q",
    "status",
    "teamId",
  ]);
  if (
    source.teamId === undefined ||
    !UUID_V4_PATTERN.test(source.teamId)
  ) {
    inputInvalid();
  }
  if (
    source.status !== undefined &&
    !["signed", "not_won", "tied"].includes(
      source.status
    )
  ) {
    inputInvalid();
  }
  return Object.freeze({
    ...(source.cursor === undefined
      ? {}
      : { cursor: readCursor(source.cursor) }),
    ...(source.limit === undefined
      ? {}
      : { limit: readLimit(source.limit) }),
    ...(source.q === undefined
      ? {}
      : { q: normalizeSearch(source.q) }),
    ...(source.status === undefined
      ? {}
      : { status: source.status }),
    teamId: source.teamId,
  });
}

function parseIfMatch(request) {
  const value = request.get("if-match");
  const match =
    typeof value === "string" &&
    /^"([1-9]\d*)"$/.exec(value);
  if (!match) inputInvalid();
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    inputInvalid();
  }
  return version;
}

function parseIdempotencyKey(request) {
  const value = request.get("idempotency-key");
  if (
    typeof value !== "string" ||
    Array.from(value).length < 1 ||
    Array.from(value).length > 128 ||
    value !== value.trim() ||
    CONTROL_PATTERN.test(value)
  ) {
    inputInvalid();
  }
  return value;
}

function safePreconditionDetails(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.currentVersion) ||
    value.currentVersion < 1 ||
    value.refetch !== true
  ) {
    return undefined;
  }
  return Object.freeze({
    currentVersion: value.currentVersion,
    refetch: true,
  });
}

function retryData(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.httpStatus !== 202 ||
    result.data === null ||
    typeof result.data !== "object" ||
    Array.isArray(result.data) ||
    typeof result.data.then === "function"
  ) {
    throw new TypeError(
      "The FAD readiness-retry result is unavailable."
    );
  }
  return result.data;
}

function recoveryActionData(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getOwnPropertySymbols(result).length !== 0 ||
    Object.keys(result).sort().join("|") !==
      "data|httpStatus|replayed" ||
    result.httpStatus !== 202 ||
    typeof result.replayed !== "boolean" ||
    result.data === null ||
    typeof result.data !== "object" ||
    Array.isArray(result.data) ||
    typeof result.data.then === "function"
  ) {
    throw new TypeError(
      "The FAD recovery-action result is unavailable."
    );
  }
  return result.data;
}

function correctionPreviewData(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.then === "function"
  ) {
    throw new TypeError(
      "The FAD allocation-correction preview is unavailable."
    );
  }
  return result;
}

function correctionData(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getOwnPropertySymbols(result).length !== 0 ||
    Object.keys(result).sort().join("|") !==
      "data|httpStatus|replayed" ||
    result.httpStatus !== 200 ||
    typeof result.replayed !== "boolean" ||
    result.data === null ||
    typeof result.data !== "object" ||
    Array.isArray(result.data) ||
    typeof result.data.then === "function"
  ) {
    throw new TypeError(
      "The FAD allocation-correction result is unavailable."
    );
  }
  return result.data;
}

function createFreeAgentDraftRouter({
  requestSecurity,
  freeAgentDraftReadService,
  freeAgentDraftReadinessRetryService,
  freeAgentDraftRecoveryReadService,
  freeAgentDraftRecoveryActionService,
  freeAgentDraftCorrectionPreviewService,
  freeAgentDraftAllocationCorrectionService,
  rateLimiter,
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
  for (const method of [
    "allocationResults",
    "navigation",
    "overview",
    "publishedCardHistory",
    "publishedCardSummaries",
    "readiness",
  ]) {
    assertMethod(
      freeAgentDraftReadService,
      method,
      "the FAD read service"
    );
  }
  assertMethod(
    freeAgentDraftReadinessRetryService,
    "retry",
    "the FAD readiness-retry service"
  );
  assertMethod(
    freeAgentDraftRecoveryReadService,
    "recovery",
    "the FAD recovery-read service"
  );
  assertMethod(
    freeAgentDraftRecoveryActionService,
    "accept",
    "the FAD recovery-action service"
  );
  assertMethod(
    freeAgentDraftCorrectionPreviewService,
    "preview",
    "the FAD allocation-correction preview service"
  );
  assertMethod(
    freeAgentDraftAllocationCorrectionService,
    "apply",
    "the FAD allocation-correction service"
  );
  assertMethod(
    rateLimiter,
    "recordAttempt",
    "the shared rate limiter"
  );

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function privateNoStore(
    _request,
    response,
    next
  ) {
    response.set(
      "Cache-Control",
      "private, no-store"
    );
    next();
  }

  function success(
    request,
    response,
    status,
    data
  ) {
    return response
      .status(status)
      .set("Cache-Control", "private, no-store")
      .json({
        data,
        meta: { requestId: requestId(request) },
      });
  }

  function failure(
    request,
    response,
    status,
    code,
    { details, retryAfterSeconds } = {}
  ) {
    if (
      status === 429 &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 0
    ) {
      response.set(
        "Retry-After",
        String(retryAfterSeconds)
      );
    }
    return response
      .status(status)
      .set("Cache-Control", "private, no-store")
      .json({
        error: {
          code,
          message: SAFE_MESSAGES[code],
          ...(details ? { details } : {}),
          requestId: requestId(request),
        },
      });
  }

  function mapError(
    request,
    response,
    error,
    { versionCode = "FAD_READINESS_PRECONDITION_FAILED" } = {}
  ) {
    const code = error?.code;
    const reasonCode =
      error?.reasonCode ||
      error?.details?.reasonCode;
    if (
      code === "FAD_RECOVERY_ACTION_INVALID" ||
      code === "RECOVERY_NOT_AVAILABLE" ||
      (
        code === "FAD_RECOVERY_INPUT_INVALID" &&
        RECOVERY_VALIDATION_REASON_CODES.has(
          reasonCode
        )
      )
    ) {
      return failure(
        request,
        response,
        422,
        "FAD_RECOVERY_ACTION_INVALID"
      );
    }
    if (
      [
        "FAD_READ_INPUT_INVALID",
        "FAD_READINESS_INPUT_INVALID",
        "FAD_RECOVERY_INPUT_INVALID",
        "FAD_RECOVERY_READ_INPUT_INVALID",
        "FAD_ALLOCATION_CORRECTION_INPUT_INVALID",
        "LEAGUE_ID_INVALID",
        "REPOSITORY_ARGUMENT_INVALID",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        400,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
    }
    if (code === "CANDIDATE_CARD_NOT_FOUND") {
      return failure(
        request,
        response,
        404,
        "CANDIDATE_CARD_NOT_FOUND"
      );
    }
    if (
      [
        "LEAGUE_COMMISSIONER_REQUIRED",
        "NOT_AUTHORIZED",
        "FAD_CORRECTION_AUTHORIZATION_DENIED",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        403,
        "LEAGUE_COMMISSIONER_REQUIRED"
      );
    }
    if (
      [
        "FAD_READ_AUTHORIZATION_DENIED",
        "FAD_RECOVERY_READ_AUTHORIZATION_DENIED",
        "LEAGUE_NOT_FOUND",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        404,
        "LEAGUE_NOT_FOUND"
      );
    }
    if (
      [
        "FREE_AGENT_DRAFT_NOT_FOUND",
        "REPOSITORY_RECORD_NOT_FOUND",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        404,
        "FREE_AGENT_DRAFT_NOT_FOUND"
      );
    }
    if (
      [
        "FAD_READINESS_NOT_READY",
        "FAD_CARDS_NOT_PUBLISHED",
        "FAD_CORRECTION_NOT_APPLICABLE",
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      ].includes(code)
    ) {
      return failure(request, response, 409, code);
    }
    if (
      [
        "FAD_READINESS_PRECONDITION_FAILED",
        "REPOSITORY_VERSION_CONFLICT",
      ].includes(code)
    ) {
      return failure(
        request,
        response,
        412,
        versionCode,
        {
          details: safePreconditionDetails(
            error?.details
          ),
        }
      );
    }
    return failure(
      request,
      response,
      500,
      "FREE_AGENT_DRAFT_REQUEST_FAILED"
    );
  }

  function bootstrap(request) {
    return requestSecurity.getSessionBootstrap(
      request
    );
  }

  function unsafeSession(request) {
    return requestSecurity.getAuthenticatedSession(
      request
    );
  }

  function limitOperationalWrite(
    request,
    response,
    authenticated,
    leagueId
  ) {
    const attempts = [
      {
        action: FAD_OPERATIONAL_WRITE_ACTION,
        bucket: "session",
        canonicalIdentifier:
          authenticated?.session?.id,
      },
      {
        action: FAD_OPERATIONAL_WRITE_ACTION,
        bucket: "league",
        canonicalIdentifier: leagueId,
      },
    ].map((attempt) =>
      rateLimiter.recordAttempt({
        ...attempt,
        failed: false,
      })
    );
    for (const result of attempts) {
      if (
        !result ||
        typeof result.allowed !== "boolean" ||
        !Number.isSafeInteger(
          result.retryAfterSeconds
        ) ||
        result.retryAfterSeconds < 0
      ) {
        throw new TypeError(
          "The FAD operational rate-limit result is unavailable."
        );
      }
    }
    if (attempts.some((result) => !result.allowed)) {
      failure(
        request,
        response,
        429,
        "RATE_LIMITED",
        {
          retryAfterSeconds: Math.max(
            ...attempts.map(
              (result) =>
                result.retryAfterSeconds
            )
          ),
        }
      );
      return false;
    }
    return true;
  }

  function handleNavigation(request, response) {
    try {
      const query = navigationQuery(request.query);
      return success(
        request,
        response,
        200,
        freeAgentDraftReadService.navigation({
          leagueId: request.params.leagueId,
          authenticated: bootstrap(request),
          ...query,
        })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleReadiness(request, response) {
    try {
      const query = exactQuery(request.query, [
        "seasonId",
      ]);
      return success(
        request,
        response,
        200,
        freeAgentDraftReadService.readiness({
          leagueId: request.params.leagueId,
          seasonId: query.seasonId,
          authenticated: bootstrap(request),
        })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleRetry(request, response) {
    try {
      exactQuery(request.query, []);
      const result =
        freeAgentDraftReadinessRetryService.retry({
          leagueId: request.params.leagueId,
          input: request.body,
          expectedVersion: parseIfMatch(request),
          idempotencyKey:
            parseIdempotencyKey(request),
          authenticated: unsafeSession(request),
        });
      return success(
        request,
        response,
        202,
        retryData(result)
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleOverview(request, response) {
    try {
      exactQuery(request.query, []);
      return success(
        request,
        response,
        200,
        freeAgentDraftReadService.overview({
          leagueId: request.params.leagueId,
          fadId: request.params.fadId,
          authenticated: bootstrap(request),
        })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleRecovery(request, response) {
    try {
      exactQuery(request.query, []);
      return success(
        request,
        response,
        200,
        freeAgentDraftRecoveryReadService.recovery({
          authenticated: bootstrap(request),
          fadId: request.params.fadId,
          leagueId: request.params.leagueId,
        })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleRecoveryAction(
    request,
    response
  ) {
    try {
      exactQuery(request.query, []);
      if (request.get("if-match") !== undefined) {
        inputInvalid();
      }
      const idempotencyKey =
        parseIdempotencyKey(request);
      const authenticated = unsafeSession(request);
      if (
        !limitOperationalWrite(
          request,
          response,
          authenticated,
          request.params.leagueId
        )
      ) {
        return undefined;
      }
      const result =
        freeAgentDraftRecoveryActionService.accept({
          authenticated,
          fadId: request.params.fadId,
          idempotencyKey,
          input: request.body,
          leagueId: request.params.leagueId,
        });
      return success(
        request,
        response,
        result.httpStatus,
        recoveryActionData(result)
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleCorrectionPreview(
    request,
    response
  ) {
    try {
      exactQuery(request.query, []);
      return success(
        request,
        response,
        200,
        correctionPreviewData(
          freeAgentDraftCorrectionPreviewService.preview({
            allocationId: request.params.allocationId,
            authenticated: unsafeSession(request),
            fadId: request.params.fadId,
            input: request.body,
            leagueId: request.params.leagueId,
          })
        )
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  async function handleCorrection(
    request,
    response
  ) {
    try {
      exactQuery(request.query, []);
      const expectedAllocationVersion =
        parseIfMatch(request);
      const idempotencyKey =
        parseIdempotencyKey(request);
      const authenticated = unsafeSession(request);
      if (
        !limitOperationalWrite(
          request,
          response,
          authenticated,
          request.params.leagueId
        )
      ) {
        return undefined;
      }
      const result =
        await freeAgentDraftAllocationCorrectionService.apply({
          allocationId: request.params.allocationId,
          authenticated,
          expectedAllocationVersion,
          fadId: request.params.fadId,
          idempotencyKey,
          input: request.body,
          leagueId: request.params.leagueId,
        });
      return success(
        request,
        response,
        result.httpStatus,
        correctionData(result)
      );
    } catch (error) {
      return mapError(request, response, error, {
        versionCode: "PRECONDITION_FAILED",
      });
    }
  }

  function handlePublishedCardSummaries(
    request,
    response
  ) {
    try {
      const query = publishedCardsQuery(
        request.query
      );
      const result =
        freeAgentDraftReadService
          .publishedCardSummaries({
            leagueId: request.params.leagueId,
            fadId: request.params.fadId,
            authenticated: bootstrap(request),
            query,
          });
      return response
        .status(200)
        .set("Cache-Control", "private, no-store")
        .json({
          data: result.data,
          page: result.page,
          meta: { requestId: requestId(request) },
        });
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handlePublishedCardHistory(
    request,
    response
  ) {
    try {
      exactQuery(request.query, []);
      return success(
        request,
        response,
        200,
        freeAgentDraftReadService
          .publishedCardHistory({
            leagueId: request.params.leagueId,
            fadId: request.params.fadId,
            teamId: request.params.teamId,
            authenticated: bootstrap(request),
          })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleAllocationResults(
    request,
    response
  ) {
    try {
      const query = allocationResultsQuery(
        request.query
      );
      const result =
        freeAgentDraftReadService
          .allocationResults({
            leagueId: request.params.leagueId,
            fadId: request.params.fadId,
            authenticated: bootstrap(request),
            query,
          });
      return response
        .status(200)
        .set("Cache-Control", "private, no-store")
        .json({
          data: result.data,
          page: result.page,
          meta: { requestId: requestId(request) },
        });
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  const router = express.Router();
  router.use(privateNoStore);
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(privateNoStore);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(
    requestSecurity.requireCompatibleFetchMetadata
  );

  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/navigation",
    requestSecurity.authenticateBootstrap,
    handleNavigation
  );
  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/readiness",
    requestSecurity.authenticateBootstrap,
    handleReadiness
  );
  router.post(
    "/api/v1/leagues/:leagueId/free-agent-drafts/readiness/retries",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    express.json({ limit: "16kb", strict: true }),
    handleRetry
  );
  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery",
    requestSecurity.authenticateBootstrap,
    handleRecovery
  );
  router.post(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery/actions",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    express.json({ limit: "16kb", strict: true }),
    handleRecoveryAction
  );
  router.post(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/correction-previews",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    express.json({ limit: "16kb", strict: true }),
    handleCorrectionPreview
  );
  router.post(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/corrections",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    express.json({ limit: "16kb", strict: true }),
    handleCorrection
  );
  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards",
    requestSecurity.authenticateBootstrap,
    handlePublishedCardSummaries
  );
  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/history",
    requestSecurity.authenticateBootstrap,
    handlePublishedCardHistory
  );
  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/results",
    requestSecurity.authenticateBootstrap,
    handleAllocationResults
  );
  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId",
    requestSecurity.authenticateBootstrap,
    handleOverview
  );

  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      return failure(
        request,
        response,
        413,
        "FREE_AGENT_DRAFT_REQUEST_TOO_LARGE"
      );
    }
    return failure(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "FREE_AGENT_DRAFT_INPUT_INVALID"
        : "FREE_AGENT_DRAFT_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  FAD_OPERATIONAL_WRITE_ACTION,
  SAFE_MESSAGES,
  createFreeAgentDraftRouter,
};
