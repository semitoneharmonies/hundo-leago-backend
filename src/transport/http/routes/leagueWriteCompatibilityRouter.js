const express = require("express");
const {
  CompatibilityLeagueValidationError,
} = require("../../../validators/compatibilityLeaguePayload");

function createLeagueWriteCompatibilityRouter({
  saveCompatibilityLeagueService,
  logger = console,
  expressModule = express,
} = {}) {
  if (
    !saveCompatibilityLeagueService ||
    typeof saveCompatibilityLeagueService.save !==
      "function"
  ) {
    throw new TypeError(
      "createLeagueWriteCompatibilityRouter requires saveCompatibilityLeagueService.save"
    );
  }

  const router = expressModule.Router();

  router.post("/api/league", async (req, res) => {
    try {
      await saveCompatibilityLeagueService.save(
        req.body || {}
      );
      return res.json({ ok: true });
    } catch (error) {
      if (
        error instanceof
        CompatibilityLeagueValidationError
      ) {
        return res
          .status(error.statusCode)
          .json({
            ok: false,
            error: error.message,
          });
      }

      logger.error(
        "[BACKEND] Error writing league-state.json:",
        error
      );
      return res.status(500).json({
        ok: false,
        error: "Failed to save state",
      });
    }
  });

  return router;
}

module.exports = {
  createLeagueWriteCompatibilityRouter,
};
