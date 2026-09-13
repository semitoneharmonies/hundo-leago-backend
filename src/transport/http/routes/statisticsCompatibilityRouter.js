const express = require("express");
const path = require("node:path");

function createStatisticsCompatibilityRouter({
  statisticsService,
  statisticsRepository,
  statsRefreshToken,
  backendRoot,
  expressModule = express,
  pathModule = path,
  logger = console,
} = {}) {
  if (!statisticsService || !statisticsRepository) {
    throw new TypeError(
      "createStatisticsCompatibilityRouter requires service and repository"
    );
  }

  const router = expressModule.Router();
  const localPath = pathModule.join(backendRoot, "stats-cache.json");

  router.get(
    "/api/stats/debug-localpath",
    (request, response) => {
      try {
        const debug = statisticsRepository.getDebugInfo({
          localStatsFile: localPath,
        });
        return response.json({
          ok: true,
          __dirname: backendRoot,
          localPath: debug.localPath,
          localExists: debug.localExists,
          STATS_FILE: debug.statsFile,
        });
      } catch (error) {
        return response.status(500).json({
          ok: false,
          error: String(error?.message || error),
        });
      }
    }
  );

  router.get("/api/stats/debug", (request, response) => {
    try {
      const debug = statisticsRepository.getDebugInfo();
      return response.json({
        ok: true,
        STATS_FILE: debug.statsFile,
        disk: debug.disk,
      });
    } catch (error) {
      return response.status(500).json({
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  router.get("/api/stats", (request, response) => {
    try {
      if (!statisticsService.cacheExists()) {
        return response.status(200).json({
          ok: true,
          ready: false,
          byPlayerId: {},
        });
      }

      const playerId = String(
        request.query?.playerId || ""
      ).trim();
      if (playerId) {
        return response.status(200).json({
          ok: true,
          playerId,
          stats: statisticsService.readPlayer(playerId),
        });
      }

      return response
        .status(200)
        .json(statisticsService.readCache());
    } catch (error) {
      logger.error(
        "[STATS] Failed to read stats cache:",
        error?.message || error
      );
      return response.status(500).json({
        ok: false,
        error: "Failed to load stats cache",
      });
    }
  });

  router.post("/api/stats/refresh", async (request, response) => {
    try {
      const token = request.get("x-stats-token") || "";
      if (
        !statsRefreshToken ||
        token !== statsRefreshToken
      ) {
        return response
          .status(401)
          .json({ ok: false, error: "Unauthorized" });
      }

      const result = await statisticsService.refresh();
      return response.json({ ok: true, result });
    } catch (error) {
      logger.error("stats refresh failed:", error);
      return response.status(500).json({
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  return router;
}

module.exports = { createStatisticsCompatibilityRouter };
