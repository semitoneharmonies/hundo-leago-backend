"use strict";

const express = require("express");

const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANDIDATE_WRITE_ACTION =
  "fad_candidate_write";
const HELP_WRITE_ACTION = "fad_help_write";

const SAFE_MESSAGES = Object.freeze({
  CANDIDATE_BENCH_AAV_EXCEEDED:
    "The proposed Bench contract exceeds the maximum allowed AAV.",
  CANDIDATE_CARD_ENTRY_NOT_FOUND:
    "The Candidate Card entry was not found.",
  CANDIDATE_CARD_NOT_FOUND:
    "The Candidate Card was not found.",
  CANDIDATE_CARD_PRECONDITION_FAILED:
    "The Candidate Card changed; refetch it and try again.",
  CANDIDATE_CARRYOVER_LOCKED:
    "The carried player is locked on the Candidate Card.",
  CANDIDATE_CONTRACT_INVALID:
    "The proposed Candidate contract is invalid.",
  CANDIDATE_PLAYER_DUPLICATE:
    "The player is already on this Candidate Card.",
  CANDIDATE_PLAYER_INELIGIBLE:
    "The player is not eligible for this Candidate Card.",
  CANDIDATE_SLOT_INVALID:
    "The Candidate Card slot is invalid for this request.",
  CANDIDATE_SLOT_OCCUPIED:
    "The Candidate Card slot is occupied.",
  FAD_ALLOCATION_QUARANTINED:
    "The player is unavailable while Free Agent Draft recovery is unresolved.",
  FAD_DEADLINE_PASSED:
    "The Candidate Card deadline has passed.",
  FAD_HELP_WINDOW_CLOSED:
    "The Candidate Card help window is closed.",
  FAD_PHASE_CONFLICT:
    "The Candidate Card is unavailable in the current Free Agent Draft phase.",
  FREE_AGENT_DRAFT_INPUT_INVALID:
    "The Candidate Card request is invalid.",
  FREE_AGENT_DRAFT_NOT_FOUND:
    "The Free Agent Draft was not found.",
  FREE_AGENT_DRAFT_REQUEST_FAILED:
    "The Candidate Card request could not be completed.",
  FREE_AGENT_DRAFT_REQUEST_TOO_LARGE:
    "The Free Agent Draft request is too large.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier Candidate Card request result is unavailable.",
  LEAGUE_FROZEN:
    "The league is temporarily frozen for changes.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  RATE_LIMITED:
    "Too many requests. Try again later.",
});

const INPUT_CODES = new Set([
  "CANDIDATE_CARD_INPUT_INVALID",
  "CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID",
  "FAD_CANDIDATE_INPUT_INVALID",
  "LEAGUE_ID_INVALID",
  "REPOSITORY_ARGUMENT_INVALID",
]);
const NOT_FOUND_CODES = new Set([
  "CANDIDATE_CARD_ENTRY_NOT_FOUND",
  "CANDIDATE_CARD_NOT_FOUND",
  "FREE_AGENT_DRAFT_NOT_FOUND",
  "LEAGUE_NOT_FOUND",
]);
const CONFLICT_CODES = new Set([
  "CANDIDATE_CARRYOVER_LOCKED",
  "CANDIDATE_PLAYER_DUPLICATE",
  "CANDIDATE_SLOT_OCCUPIED",
  "FAD_ALLOCATION_QUARANTINED",
  "FAD_DEADLINE_PASSED",
  "FAD_HELP_WINDOW_CLOSED",
  "FAD_PHASE_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_REQUEST_UNAVAILABLE",
]);
const VALIDATION_CODES = new Set([
  "CANDIDATE_BENCH_AAV_EXCEEDED",
  "CANDIDATE_CONTRACT_INVALID",
  "CANDIDATE_PLAYER_INELIGIBLE",
  "CANDIDATE_SLOT_INVALID",
]);

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `Candidate Card routes require ${description}`
    );
  }
}

function inputInvalid() {
  const error = new TypeError(
    "The Candidate Card request is invalid."
  );
  error.code = "FAD_CANDIDATE_INPUT_INVALID";
  throw error;
}

function noQuery(query) {
  if (
    query === null ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.keys(query).length !== 0
  ) {
    inputInvalid();
  }
}

function eligibleQuery(query) {
  if (
    query === null ||
    typeof query !== "object" ||
    Array.isArray(query)
  ) {
    inputInvalid();
  }
  const allowed = new Set([
    "cursor",
    "limit",
    "q",
    "slotKey",
  ]);
  const fields = Object.keys(query);
  if (
    !fields.includes("slotKey") ||
    fields.some((field) => !allowed.has(field))
  ) {
    inputInvalid();
  }
  const result = {};
  for (const field of fields) {
    if (typeof query[field] !== "string") {
      inputInvalid();
    }
    result[field] = query[field];
  }
  return Object.freeze(result);
}

function revisionAction(body) {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getOwnPropertySymbols(body).length !== 0 ||
    Object.keys(body).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(
      body,
      "action"
    )
  ) {
    inputInvalid();
  }
  return body.action;
}

function parseIfMatch(request) {
  const value = request.get("if-match");
  const match =
    typeof value === "string" &&
    /^"([1-9]\d*)"$/u.exec(value);
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
    CONTROL_PATTERN.test(value)
  ) {
    inputInvalid();
  }
  const normalized = value.trim();
  const count = [...normalized].length;
  if (count < 1 || count > 128) {
    inputInvalid();
  }
  return normalized;
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

function serviceReason(error) {
  const direct = error?.code;
  if (
    INPUT_CODES.has(direct) ||
    NOT_FOUND_CODES.has(direct) ||
    CONFLICT_CODES.has(direct) ||
    VALIDATION_CODES.has(direct) ||
    [
      "CANDIDATE_CARD_PRECONDITION_FAILED",
      "LEAGUE_FROZEN",
    ].includes(direct)
  ) {
    return direct;
  }
  return (
    error?.details?.reasonCode ||
    error?.reasonCode ||
    direct
  );
}

function commandResult(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    ![200, 201].includes(result.httpStatus) ||
    result.data === null ||
    typeof result.data !== "object" ||
    Array.isArray(result.data) ||
    typeof result.data.then === "function"
  ) {
    throw new TypeError(
      "The Candidate Card command result is unavailable."
    );
  }
  return result;
}

function createCandidateCardRouter({
  requestSecurity,
  candidateCardService,
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
    "privateCard",
    "eligiblePlayers",
    "previewRevision",
    "addCandidate",
    "editCandidate",
    "moveEntry",
    "removeCandidate",
    "requestHelp",
    "saveCard",
  ]) {
    assertMethod(
      candidateCardService,
      method,
      "the Candidate Card service"
    );
  }
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

  function collectionSuccess(
    request,
    response,
    result
  ) {
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Array.isArray(result.data) ||
      result.page === null ||
      typeof result.page !== "object" ||
      Array.isArray(result.page)
    ) {
      throw new TypeError(
        "The Candidate eligible-player page is unavailable."
      );
    }
    return response
      .status(200)
      .set("Cache-Control", "private, no-store")
      .json({
        data: result.data,
        page: result.page,
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

  function mapError(request, response, error) {
    const code = serviceReason(error);
    if (INPUT_CODES.has(code)) {
      return failure(
        request,
        response,
        400,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
    }
    if (NOT_FOUND_CODES.has(code)) {
      return failure(
        request,
        response,
        404,
        code
      );
    }
    if (code === "REPOSITORY_RECORD_NOT_FOUND") {
      return failure(
        request,
        response,
        404,
        "CANDIDATE_CARD_NOT_FOUND"
      );
    }
    if (CONFLICT_CODES.has(code)) {
      return failure(
        request,
        response,
        409,
        code
      );
    }
    if (
      code ===
      "CANDIDATE_CARD_PRECONDITION_FAILED"
    ) {
      return failure(
        request,
        response,
        412,
        code,
        {
          details: safePreconditionDetails(
            error?.details
          ),
        }
      );
    }
    if (VALIDATION_CODES.has(code)) {
      return failure(
        request,
        response,
        422,
        code
      );
    }
    if (code === "LEAGUE_FROZEN") {
      return failure(
        request,
        response,
        423,
        code
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

  function limitWrite(
    request,
    response,
    authenticated,
    action,
    leagueId
  ) {
    const attempts = [
      {
        action,
        bucket: "session",
        canonicalIdentifier:
          authenticated?.session?.id,
      },
      {
        action,
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
          "The Candidate Card rate-limit result is unavailable."
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

  function routeScope(request) {
    const scope = {
      leagueId: request.params.leagueId,
      fadId: request.params.fadId,
      teamId: request.params.teamId,
    };
    if (
      Object.values(scope).some(
        (value) =>
          typeof value !== "string" ||
          !UUID_V4_PATTERN.test(value)
      )
    ) {
      inputInvalid();
    }
    return scope;
  }

  function handlePrivateCard(request, response) {
    try {
      noQuery(request.query);
      return success(
        request,
        response,
        200,
        candidateCardService.privateCard({
          ...routeScope(request),
          authenticated: bootstrap(request),
        })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleEligiblePlayers(
    request,
    response
  ) {
    try {
      return collectionSuccess(
        request,
        response,
        candidateCardService.eligiblePlayers({
          ...routeScope(request),
          query: eligibleQuery(request.query),
          authenticated: bootstrap(request),
        })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handlePreview(request, response) {
    try {
      noQuery(request.query);
      return success(
        request,
        response,
        200,
        candidateCardService.previewRevision({
          ...routeScope(request),
          action: revisionAction(request.body),
          authenticated: unsafeSession(request),
        })
      );
    } catch (error) {
      return mapError(request, response, error);
    }
  }

  function handleMutation(
    request,
    response,
    method,
    additional = {}
  ) {
    try {
      noQuery(request.query);
      const scope = routeScope(request);
      const expectedCardVersion =
        parseIfMatch(request);
      const idempotencyKey =
        parseIdempotencyKey(request);
      const authenticated = unsafeSession(request);
      if (
        !limitWrite(
          request,
          response,
          authenticated,
          CANDIDATE_WRITE_ACTION,
          scope.leagueId
        )
      ) {
        return undefined;
      }
      const result = commandResult(
        candidateCardService[method]({
          ...scope,
          ...additional,
          ...(method === "removeCandidate"
            ? {}
            : { input: request.body }),
          expectedCardVersion,
          idempotencyKey,
          authenticated,
        })
      );
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

  function handleRemove(request, response) {
    if (
      request.body !== undefined &&
      !(
        Buffer.isBuffer(request.body) &&
        request.body.length === 0
      )
    ) {
      return failure(
        request,
        response,
        400,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
    }
    return handleMutation(
      request,
      response,
      "removeCandidate",
      { entryId: request.params.entryId }
    );
  }

  function handleHelp(request, response) {
    try {
      noQuery(request.query);
      const scope = routeScope(request);
      if (request.get("if-match") !== undefined) {
        inputInvalid();
      }
      const idempotencyKey =
        parseIdempotencyKey(request);
      const authenticated = unsafeSession(request);
      if (
        !limitWrite(
          request,
          response,
          authenticated,
          HELP_WRITE_ACTION,
          scope.leagueId
        )
      ) {
        return undefined;
      }
      const result = commandResult(
        candidateCardService.requestHelp({
          ...scope,
          input: request.body,
          idempotencyKey,
          authenticated,
        })
      );
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

  const jsonBody = express.json({
    limit: "16kb",
    strict: true,
  });
  const emptyBody = express.raw({
    limit: "16kb",
    type: () => true,
  });

  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/private",
    requestSecurity.authenticateBootstrap,
    handlePrivateCard
  );
  router.get(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/eligible-players",
    requestSecurity.authenticateBootstrap,
    handleEligiblePlayers
  );
  router.post(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/revision-previews",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    jsonBody,
    handlePreview
  );
  router.put(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    jsonBody,
    (request, response) =>
      handleMutation(
        request,
        response,
        "saveCard"
      )
  );
  router.put(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/slots/:slotKey/candidate",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    jsonBody,
    (request, response) =>
      handleMutation(
        request,
        response,
        "addCandidate",
        { slotKey: request.params.slotKey }
      )
  );
  router.patch(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    jsonBody,
    (request, response) =>
      handleMutation(
        request,
        response,
        "editCandidate",
        { entryId: request.params.entryId }
      )
  );
  router.post(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId/move",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    jsonBody,
    (request, response) =>
      handleMutation(
        request,
        response,
        "moveEntry",
        { entryId: request.params.entryId }
      )
  );
  router.delete(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
    requestSecurity.authenticateUnsafe,
    emptyBody,
    handleRemove
  );
  router.post(
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/help-requests",
    requestSecurity.authenticateUnsafe,
    requestSecurity.requireJson,
    jsonBody,
    handleHelp
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
      error?.type === "entity.parse.failed"
        ? 400
        : 500,
      error?.type === "entity.parse.failed"
        ? "FREE_AGENT_DRAFT_INPUT_INVALID"
        : "FREE_AGENT_DRAFT_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  CANDIDATE_WRITE_ACTION,
  HELP_WRITE_ACTION,
  SAFE_MESSAGES,
  createCandidateCardRouter,
};
