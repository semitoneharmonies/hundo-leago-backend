const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  COMMISSIONER_CORRECTION_AUTHORITY_DENIED:
    "Current commissioner authority is required.",
  COMMISSIONER_CORRECTION_CONFLICT:
    "The commissioner correction conflicts with current league state.",
  COMMISSIONER_CORRECTION_FAILED:
    "The commissioner correction could not be completed.",
  COMMISSIONER_CORRECTION_INPUT_INVALID:
    "The commissioner correction request is invalid.",
  COMMISSIONER_CORRECTION_NOT_FOUND:
    "The commissioner correction record was not found.",
  COMMISSIONER_CORRECTION_PRECONDITION_FAILED:
    "The roster or contract changed; refetch it and try again.",
  COMMISSIONER_CORRECTION_REQUEST_TOO_LARGE:
    "The commissioner correction request is too large.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`commissioner-correction routes require ${description}`);
  }
}

function createCommissionerCorrectionRouter({
  requestSecurity,
  commissionerCorrectionService,
} = {}) {
  for (const method of [
    "assignRequestId",
    "authenticateBootstrap",
    "authenticateUnsafe",
    "credentialedCors",
    "getAuthenticatedSession",
    "getSessionBootstrap",
    "getRequestId",
    "requireAllowedOrigin",
    "requireCompatibleFetchMetadata",
    "requireJson",
    "securityHeaders",
  ]) {
    assertMethod(requestSecurity, method, "the target request-security boundary");
  }
  for (const method of [
    "readWorkspace",
    "previewAdd",
    "applyAdd",
    "previewRemove",
    "applyRemove",
    "previewRoster",
    "applyRoster",
    "previewContract",
    "applyContract",
  ]) {
    assertMethod(commissionerCorrectionService, method, "a commissioner-correction service");
  }

  function success(request, response, data) {
    return response.status(200).json({
      data,
      meta: { requestId: requestSecurity.getRequestId(request) },
    });
  }

  function failure(request, response, status, code) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestSecurity.getRequestId(request),
      },
    });
  }

  function mapError(request, response, error) {
    const code = error?.reasonCode || error?.code;
    if (
      code === "COMMISSIONER_CORRECTION_INPUT_INVALID" ||
      code === "LEAGUE_ID_INVALID" ||
      code === "REPOSITORY_ARGUMENT_INVALID" ||
      code?.startsWith("COMMISSIONER_CORRECTION_") && [
        "STABLE_ID_INVALID",
        "VERSION_INVALID",
        "TIMESTAMP_INVALID",
        "ROSTER_INVALID",
        "CONTRACT_INVALID",
        "SCHEDULE_INVALID",
        "REASON_INVALID",
      ].some((suffix) => code.endsWith(suffix))
    ) {
      return failure(request, response, 400, "COMMISSIONER_CORRECTION_INPUT_INVALID");
    }
    if (
      [
        "LEAGUE_COMMISSIONER_REQUIRED",
        "COMMISSIONER_CORRECTION_AUTHORITY_INVALID",
      ].includes(code)
    ) {
      return failure(request, response, 403, "COMMISSIONER_CORRECTION_AUTHORITY_DENIED");
    }
    if (
      code === "LEAGUE_NOT_FOUND" ||
      code === "REPOSITORY_RECORD_NOT_FOUND"
    ) {
      return failure(request, response, 404, "COMMISSIONER_CORRECTION_NOT_FOUND");
    }
    if (
      code === "COMMISSIONER_CORRECTION_SOURCE_CHANGED" ||
      code === "REPOSITORY_VERSION_CONFLICT"
    ) {
      return failure(request, response, 412, "COMMISSIONER_CORRECTION_PRECONDITION_FAILED");
    }
    if (
      code === "REPOSITORY_CONSTRAINT" ||
      typeof code === "string" &&
        code.startsWith("COMMISSIONER_CORRECTION_")
    ) {
      return failure(request, response, 409, "COMMISSIONER_CORRECTION_CONFLICT");
    }
    return failure(request, response, 500, "COMMISSIONER_CORRECTION_FAILED");
  }

  function command(method) {
    return (request, response) => {
      try {
        return success(request, response, commissionerCorrectionService[method]({
          leagueId: request.params.leagueId,
          input: request.body,
          idempotencyKey: request.get("idempotency-key"),
          authenticated: requestSecurity.getAuthenticatedSession(request),
        }));
      } catch (error) {
        return mapError(request, response, error);
      }
    };
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireCompatibleFetchMetadata);

  const base = "/api/v1/leagues/:leagueId/commissioner";
  router.get(
    `${base}/roster-workspace`,
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(
          request,
          response,
          commissionerCorrectionService.readWorkspace({
            leagueId: request.params.leagueId,
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (error) {
        return mapError(request, response, error);
      }
    }
  );

  router.use(requestSecurity.requireJson);
  router.use(express.json({ limit: "16kb", strict: true }));
  router.post(
    `${base}/roster-additions/previews`,
    requestSecurity.authenticateUnsafe,
    command("previewAdd")
  );
  router.post(
    `${base}/roster-additions`,
    requestSecurity.authenticateUnsafe,
    command("applyAdd")
  );
  router.post(
    `${base}/roster-removals/previews`,
    requestSecurity.authenticateUnsafe,
    command("previewRemove")
  );
  router.post(
    `${base}/roster-removals`,
    requestSecurity.authenticateUnsafe,
    command("applyRemove")
  );
  router.post(
    `${base}/roster-corrections/previews`,
    requestSecurity.authenticateUnsafe,
    command("previewRoster")
  );
  router.post(
    `${base}/roster-corrections`,
    requestSecurity.authenticateUnsafe,
    command("applyRoster")
  );
  router.post(
    `${base}/contract-corrections/previews`,
    requestSecurity.authenticateUnsafe,
    command("previewContract")
  );
  router.post(
    `${base}/contract-corrections`,
    requestSecurity.authenticateUnsafe,
    command("applyContract")
  );

  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      return failure(request, response, 413, "COMMISSIONER_CORRECTION_REQUEST_TOO_LARGE");
    }
    return failure(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "COMMISSIONER_CORRECTION_INPUT_INVALID"
        : "COMMISSIONER_CORRECTION_FAILED"
    );
  });

  return router;
}

module.exports = { SAFE_MESSAGES, createCommissionerCorrectionRouter };
