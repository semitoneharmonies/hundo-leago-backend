const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  ENTRY_DRAFT_SCHEDULE_INPUT_INVALID:
    "The Entry Draft schedule request is invalid.",
  ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED:
    "The Entry Draft cannot be scheduled in its current state.",
  ENTRY_DRAFT_SCHEDULE_NOT_FOUND:
    "The Entry Draft was not found.",
  ENTRY_DRAFT_SCHEDULE_NOT_FUTURE:
    "The Entry Draft start must be in the future.",
  ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED:
    "The Entry Draft changed; refetch it and try again.",
  ENTRY_DRAFT_SCHEDULE_REQUEST_FAILED:
    "The Entry Draft schedule request could not be completed.",
  ENTRY_DRAFT_SCHEDULE_REQUEST_TOO_LARGE:
    "The Entry Draft schedule request is too large.",
  ENTRY_DRAFT_SCHEDULE_RESULT_UNAVAILABLE:
    "The earlier Entry Draft schedule result is unavailable.",
  IDEMPOTENCY_KEY_REUSED:
    "The idempotency key was already used for a different request.",
  IDEMPOTENCY_REQUEST_UNAVAILABLE:
    "The earlier request result is unavailable.",
  LEAGUE_COMMISSIONER_REQUIRED:
    "Current league-commissioner authority is required.",
});

function assertMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `Entry Draft routes require ${description}`
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

function safePreconditionDetails(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(
      value.currentVersion
    ) ||
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

function createEntryDraftRouter({
  requestSecurity,
  entryDraftScheduleService,
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
    entryDraftScheduleService,
    "schedule",
    "an Entry Draft scheduling service"
  );
  assertMethod(
    auditPrivacyDigest,
    "digest",
    "an audit privacy digest"
  );
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "Entry Draft routes require a network-source resolver"
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
    if (
      ![200, 201].includes(
        result?.httpStatus
      )
    ) {
      throw new TypeError(
        "Entry Draft scheduling returned an invalid HTTP status"
      );
    }
    return response
      .status(result.httpStatus)
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
        "DRAFT_ID_INVALID",
        "ENTRY_DRAFT_ID_INVALID",
        "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
        "LEAGUE_ID_INVALID",
        "REPOSITORY_ARGUMENT_INVALID",
      ].includes(code)
    ) {
      return errorResponse(
        request,
        response,
        400,
        "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID"
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
        "ENTRY_DRAFT_NOT_FOUND",
        "LEAGUE_NOT_FOUND",
        "REPOSITORY_RECORD_NOT_FOUND",
      ].includes(code)
    ) {
      return errorResponse(
        request,
        response,
        404,
        "ENTRY_DRAFT_SCHEDULE_NOT_FOUND"
      );
    }
    if (
      code ===
        "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED" ||
      code === "REPOSITORY_VERSION_CONFLICT"
    ) {
      return errorResponse(
        request,
        response,
        412,
        "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED",
        safePreconditionDetails(
          error.details
        )
      );
    }
    if (
      code ===
      "ENTRY_DRAFT_SCHEDULE_NOT_FUTURE"
    ) {
      return errorResponse(
        request,
        response,
        422,
        code
      );
    }
    if (
      [
        "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED",
        "ENTRY_DRAFT_SCHEDULE_RESULT_UNAVAILABLE",
        "IDEMPOTENCY_KEY_REUSED",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
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
      "ENTRY_DRAFT_SCHEDULE_REQUEST_FAILED"
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
    "/api/v1/leagues/:leagueId/entry-drafts/:draftId/schedule",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      try {
        const expectedEntryDraftVersion =
          parseIfMatch(request);
        if (
          expectedEntryDraftVersion ===
          null
        ) {
          return errorResponse(
            request,
            response,
            400,
            "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID"
          );
        }
        return successResponse(
          request,
          response,
          entryDraftScheduleService.schedule({
            leagueId:
              request.params.leagueId,
            entryDraftId:
              request.params.draftId,
            input: request.body,
            expectedEntryDraftVersion,
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
        errorResponse(
          request,
          response,
          413,
          "ENTRY_DRAFT_SCHEDULE_REQUEST_TOO_LARGE"
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
          ? "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID"
          : "ENTRY_DRAFT_SCHEDULE_REQUEST_FAILED"
      );
    }
  );

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createEntryDraftRouter,
  parseIfMatch,
};
