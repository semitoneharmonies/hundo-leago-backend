const express = require("express");

const SAFE_MESSAGES = Object.freeze({
  ACTIVITY_REQUEST_FAILED:
    "The activity or notification request could not be completed.",
  ACTIVITY_REQUEST_INVALID:
    "The activity or notification request is invalid.",
  LEAGUE_NOT_FOUND: "The league was not found.",
  NOTIFICATION_NOT_FOUND: "The notification was not found.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`activity routes require ${description}`);
  }
}

function emptyObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function createActivityNotificationRouter({
  requestSecurity,
  leagueActivityService,
  notificationService,
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
    assertMethod(requestSecurity, method, "the request-security boundary");
  }
  assertMethod(leagueActivityService, "list", "a League Activity service");
  for (const method of ["list", "markAllRead", "markBatchRead", "markRead"]) {
    assertMethod(notificationService, method, "a notification service");
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function success(request, response, result) {
    return response.status(200).json({
      data: result,
      meta: { requestId: requestId(request) },
    });
  }

  function error(request, response, status, code) {
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestId(request),
      },
    });
  }

  function mapError(request, response, caught) {
    if (
      [
        "ACTIVITY_CURSOR_INVALID",
        "ACTIVITY_INPUT_INVALID",
        "LEAGUE_ID_INVALID",
      ].includes(caught?.code)
    ) {
      return error(request, response, 400, "ACTIVITY_REQUEST_INVALID");
    }
    if (caught?.code === "LEAGUE_NOT_FOUND") {
      return error(request, response, 404, "LEAGUE_NOT_FOUND");
    }
    if (caught?.code === "NOTIFICATION_NOT_FOUND") {
      return error(request, response, 404, "NOTIFICATION_NOT_FOUND");
    }
    return error(request, response, 500, "ACTIVITY_REQUEST_FAILED");
  }

  function requireEmptyBody(request, response, next) {
    if (!emptyObject(request.body)) {
      error(request, response, 400, "ACTIVITY_REQUEST_INVALID");
      return;
    }
    next();
  }

  function requireNotificationBatchBody(request, response, next) {
    if (
      !request.body ||
      typeof request.body !== "object" ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 1 ||
      !Object.hasOwn(request.body, "notificationIds") ||
      !Array.isArray(request.body.notificationIds)
    ) {
      error(request, response, 400, "ACTIVITY_REQUEST_INVALID");
      return;
    }
    next();
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(requestSecurity.requireCompatibleFetchMetadata);
  router.use(express.json({ limit: "8kb", strict: true }));

  router.get(
    "/api/v1/leagues/:leagueId/activity",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(
          request,
          response,
          leagueActivityService.list({
            leagueId: request.params.leagueId,
            query: request.query,
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );
  router.get(
    "/api/v1/notifications",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      try {
        return success(
          request,
          response,
          notificationService.list({
            query: request.query,
            authenticated: requestSecurity.getSessionBootstrap(request),
          })
        );
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );
  router.post(
    "/api/v1/notifications/read-batch",
    requestSecurity.authenticateUnsafe,
    requireNotificationBatchBody,
    (request, response) => {
      try {
        return success(
          request,
          response,
          notificationService.markBatchRead({
            notificationIds: request.body.notificationIds,
            authenticated: requestSecurity.getAuthenticatedSession(request),
          })
        );
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );
  router.post(
    "/api/v1/notifications/:notificationId/read",
    requestSecurity.authenticateUnsafe,
    requireEmptyBody,
    (request, response) => {
      try {
        return success(
          request,
          response,
          notificationService.markRead({
            notificationId: request.params.notificationId,
            authenticated: requestSecurity.getAuthenticatedSession(request),
          })
        );
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );
  router.post(
    "/api/v1/notifications/read-all",
    requestSecurity.authenticateUnsafe,
    requireEmptyBody,
    (request, response) => {
      try {
        return success(
          request,
          response,
          notificationService.markAllRead({
            authenticated: requestSecurity.getAuthenticatedSession(request),
          })
        );
      } catch (caught) {
        return mapError(request, response, caught);
      }
    }
  );

  router.use((caught, request, response, next) => {
    if (response.headersSent) {
      next(caught);
      return;
    }
    error(
      request,
      response,
      caught?.type === "entity.too.large" ? 413 : 400,
      "ACTIVITY_REQUEST_INVALID"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createActivityNotificationRouter,
};
