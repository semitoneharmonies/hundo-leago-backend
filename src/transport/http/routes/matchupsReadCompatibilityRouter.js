const express = require("express");

const {
  MATCHUPS_STATE_UNAVAILABLE,
} = require("../../../application/services/matchups/readMatchups");

function createMatchupsReadCompatibilityRouter({
  matchupReadService,
  logger = console,
} = {}) {
  if (!matchupReadService) {
    throw new TypeError(
      "createMatchupsReadCompatibilityRouter requires matchupReadService"
    );
  }

  const router = express.Router();

  router.get("/api/matchups/standings", (req, res) => {
    try {
      return res.json(
        matchupReadService.readStandings()
      );
    } catch (error) {
      logger.error("[matchups/standings] error:", error);
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  router.get("/api/matchups/current", (req, res) => {
    return res.json(matchupReadService.readCurrent());
  });

  router.get("/api/matchups/locks", (req, res) => {
    return res.json(matchupReadService.readLocks());
  });

  router.get(
    "/api/matchups/locks/preview",
    (req, res) => {
      return res.json(
        matchupReadService.readLocksPreview()
      );
    }
  );

  router.get(
    "/api/matchups/baseline/preview",
    (req, res) => {
      try {
        return res.json(
          matchupReadService.readBaselinePreview()
        );
      } catch (error) {
        logger.error(
          "[BASELINE PREVIEW] failed:",
          error
        );
        return res.status(500).json({
          ok: false,
          error: "Baseline preview failed.",
        });
      }
    }
  );

  router.get(
    "/api/matchups/baseline/status",
    (req, res) => {
      try {
        return res.json(
          matchupReadService.readBaselineStatus()
        );
      } catch (error) {
        logger.error(
          "[BASELINE STATUS] failed:",
          error
        );
        return res.status(500).json({
          ok: false,
          error: "Baseline status failed.",
        });
      }
    }
  );

  router.get(
    "/api/matchups/scoring/preview",
    async (req, res) => {
      try {
        return res.json(
          await matchupReadService.readScoringPreview()
        );
      } catch (error) {
        if (
          error?.code === MATCHUPS_STATE_UNAVAILABLE
        ) {
          return res.status(500).json({
            ok: false,
            error: "Matchups state not available.",
          });
        }

        logger.error(
          "[SCORING PREVIEW] failed:",
          error
        );
        return res.status(500).json({
          ok: false,
          error: "Scoring preview failed.",
        });
      }
    }
  );

  router.get(
    "/api/matchups/rollover/status",
    (req, res) => {
      return res.json(
        matchupReadService.readRolloverStatus()
      );
    }
  );

  return router;
}

module.exports = {
  createMatchupsReadCompatibilityRouter,
};
