const express = require("express");

function createPlayersCompatibilityRouter({
  playerService,
  expressModule = express,
} = {}) {
  if (!playerService) {
    throw new TypeError(
      "createPlayersCompatibilityRouter requires a playerService"
    );
  }

  const router = expressModule.Router();

  router.get("/api/players", (request, response) => {
    const query = String(request.query?.query || "").trim();

    const rawLimit = Number(request.query?.limit);
    const limitNoQuery = Math.max(
      1,
      Math.min(
        5000,
        Number.isFinite(rawLimit) ? rawLimit : 5000
      )
    );
    const limitQuery = Math.max(
      1,
      Math.min(
        100,
        Number(request.query?.limit || 25) || 25
      )
    );
    const count = playerService.getCacheCount();

    if (!query) {
      return response.json({
        ok: true,
        players: playerService.list().slice(0, limitNoQuery),
        count,
        cacheCount: count,
        limitUsed: limitNoQuery,
      });
    }

    const players = playerService.search(query, limitQuery);
    return response.json({
      ok: true,
      players,
      count,
      cacheCount: count,
      limitUsed: limitQuery,
    });
  });

  router.get("/api/players/debug", (request, response) => {
    try {
      const debug = playerService.getDebugInfo();
      return response.json({
        ok: true,
        PLAYERS_FILE: debug.playerFile,
        disk: debug.disk,
        repo: debug.repo,
        cacheCount: debug.cacheCount,
      });
    } catch (error) {
      return response.status(500).json({
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  router.get("/api/players/:id", (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id)) {
      return response
        .status(400)
        .json({ ok: false, error: "Invalid player id" });
    }

    const player = playerService.getById(id);
    if (!player) {
      return response
        .status(404)
        .json({ ok: false, error: "Player not found" });
    }

    return response.json({ ok: true, player });
  });

  router.post("/api/players/reload", (request, response) => {
    const result = playerService.reload();
    return response.json({
      ok: result.ok,
      count: result.count,
      source: result.source || null,
      error: result.error || null,
    });
  });

  return router;
}

module.exports = { createPlayersCompatibilityRouter };
