const express = require("express");

const base = "/api/v1/daily";
const endpoints = [
  ["GET", base + "/rooms", "lobby"],
  ["GET", base + "/rooms/:roomId", "room"],
  ["GET", base + "/rooms/:roomId/chat", "chat"],
  ["POST", base + "/rooms/:roomId/chat", "postChat"],
  ["GET", base + "/reminders", "reminders"],
  ["GET", base + "/profile", "profile"],
  ["POST", base + "/profile", "updateProfile"],
  ["POST", base + "/rooms", "create"],
  ["POST", base + "/rooms/:roomId/join", "join"],
  ["POST", base + "/rooms/:roomId/bids", "bid"],
  ["POST", base + "/rooms/:roomId/close", "closeRoom"],
];

function createHundoDailyRouter({ requestSecurity, service, getActor, nowMs, playerDetails = null }) {
  const router = express.Router();
  for (const name of ["assignRequestId", "securityHeaders", "credentialedCors",
    "requireAllowedOrigin", "requireJson", "requireCompatibleFetchMetadata"]) {
    router.use(requestSecurity[name]);
  }
  router.use(express.json({ limit: "4kb", strict: true }));

  for (const [method, path, action] of endpoints) {
    const reading = method === "GET";
    router[method.toLowerCase()](path,
      reading ? requestSecurity.authenticateBootstrap : requestSecurity.authenticateUnsafe,
      async (request, response, next) => {
        try {
          const session = reading ? requestSecurity.getSessionBootstrap(request) : requestSecurity.getAuthenticatedSession(request);
          const data = await service[action]({
            actor: getActor(session), roomId: request.params.roomId,
            input: request.body, requestId: request.get("idempotency-key"),
          });
          // Present new and previously saved rooms with the same current season
          // ordering. Totals are private to the ranking feed, never stored in a room.
          if (data.room?.availablePlayers?.length > 1 && service.orderPlayerPool) {
            data.room.availablePlayers = await service.orderPlayerPool(data.room.date, data.room.availablePlayers);
          }
          if (data.room && playerDetails) data.room = playerDetails.project(data.room);
          response.set("Cache-Control", "private, no-store").json({
            data, meta: { requestId: requestSecurity.getRequestId(request), serverNowMs: nowMs() },
          });
        } catch (error) { next(error); }
      });
  }
  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const known = Number.isInteger(error.status) && /^DAILY_/.test(error.code);
    const status = known ? error.status : error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" ? 413 : 503;
    response.status(status).set("Cache-Control", "no-store").json({ error: {
      code: known ? error.code : status === 503 ? "DAILY_UNAVAILABLE" : "DAILY_INPUT_INVALID",
      message: known ? error.message : status === 503 ? "Hundo Daily is temporarily unavailable. Try again shortly." : "Invalid request.",
      requestId: requestSecurity.getRequestId(request),
    } });
  });
  return router;
}

module.exports = { createHundoDailyRouter, dailyEndpoints: endpoints };
