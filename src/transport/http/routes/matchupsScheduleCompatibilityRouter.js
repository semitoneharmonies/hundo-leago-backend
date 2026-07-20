const express = require("express");

function isCommissioner(body) {
  const role = String(
    body?.meta?.actorRole || ""
  ).toLowerCase();
  return role === "commissioner";
}

function sendCompatibilityError({
  error,
  response,
  logger,
  logPrefix,
  fallbackMessage,
}) {
  if (
    error?.isCompatibilityError &&
    Number.isFinite(error.statusCode)
  ) {
    return response.status(error.statusCode).json({
      ok: false,
      error: error.message,
    });
  }

  logger.error(logPrefix, error);
  return response.status(500).json({
    ok: false,
    error: fallbackMessage,
  });
}

function createMatchupsScheduleCompatibilityRouter({
  generateScheduleService,
  updateWeekService,
  shiftScheduleService,
  logger = console,
} = {}) {
  if (!generateScheduleService) {
    throw new TypeError(
      "createMatchupsScheduleCompatibilityRouter requires generateScheduleService"
    );
  }
  if (!updateWeekService) {
    throw new TypeError(
      "createMatchupsScheduleCompatibilityRouter requires updateWeekService"
    );
  }
  if (!shiftScheduleService) {
    throw new TypeError(
      "createMatchupsScheduleCompatibilityRouter requires shiftScheduleService"
    );
  }

  const router = express.Router();

  router.post(
    "/api/matchups/schedule/generate",
    async (req, res) => {
      const body = req.body || {};
      if (!isCommissioner(body)) {
        return res.status(403).json({
          ok: false,
          error: "Commissioner only.",
        });
      }

      try {
        return res.json(
          await generateScheduleService.generateSchedule(
            body
          )
        );
      } catch (error) {
        return sendCompatibilityError({
          error,
          response: res,
          logger,
          logPrefix:
            "[MATCHUPS] schedule generate failed:",
          fallbackMessage:
            "Failed to generate schedule.",
        });
      }
    }
  );

  router.post(
    "/api/matchups/schedule/updateWeek",
    async (req, res) => {
      const body = req.body || {};
      if (!isCommissioner(body)) {
        return res.status(403).json({
          ok: false,
          error: "Commissioner only.",
        });
      }

      try {
        return res.json(
          await updateWeekService.updateWeek(body)
        );
      } catch (error) {
        return sendCompatibilityError({
          error,
          response: res,
          logger,
          logPrefix: "[MATCHUPS] updateWeek failed:",
          fallbackMessage: "Failed to update week.",
        });
      }
    }
  );

  router.post(
    "/api/matchups/schedule/shiftFrom",
    async (req, res) => {
      const body = req.body || {};
      if (!isCommissioner(body)) {
        return res.status(403).json({
          ok: false,
          error: "Commissioner only.",
        });
      }

      try {
        return res.json(
          await shiftScheduleService.shiftSchedule(body)
        );
      } catch (error) {
        return sendCompatibilityError({
          error,
          response: res,
          logger,
          logPrefix: "[MATCHUPS] shiftFrom failed:",
          fallbackMessage:
            "Failed to shift schedule.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createMatchupsScheduleCompatibilityRouter,
  isCommissioner,
  sendCompatibilityError,
};
