function createStatisticsService({
  repository,
  refreshRepository = repository,
  provider,
  nowMs = Date.now,
  lockMaxAgeMs = 15 * 60 * 1000,
  minimumPlayerCount = 200,
  seasonId,
  gameTypeId = 2,
  logger = console,
} = {}) {
  if (!repository) {
    throw new TypeError(
      "createStatisticsService requires a statistics repository"
    );
  }

  function cacheExists() {
    return repository.cacheExists();
  }

  function readCache() {
    return repository.readCache();
  }

  function readPlayer(playerId) {
    const cache = readCache();
    return cache?.byPlayerId?.[String(playerId)] || null;
  }

  async function refresh() {
    if (!provider || typeof provider.fetchRows !== "function") {
      throw new Error("Statistics refresh provider is unavailable");
    }

    refreshRepository.ensureRefreshDirectory();
    const lockTimeMs = nowMs();
    if (
      !refreshRepository.acquireLock({
        nowMs: lockTimeMs,
        maxAgeMs: lockMaxAgeMs,
      })
    ) {
      logger.log("Stats refresh already running; exiting.");
      return undefined;
    }

    try {
      logger.log(
        `Refreshing stats season=${seasonId} gameType=${gameTypeId}...`
      );
      const rows = await provider.fetchRows();
      const byPlayerId = Object.create(null);

      for (const row of rows) {
        const playerId = row?.playerId;
        if (!playerId) continue;
        byPlayerId[String(playerId)] = {
          goals: Number(row?.goals || 0),
          assists: Number(row?.assists || 0),
          points: Number(row?.points || 0),
          gamesPlayed: Number(row?.gamesPlayed || 0),
        };
      }

      const count = Object.keys(byPlayerId).length;
      if (count < minimumPlayerCount) {
        throw new Error(
          `Refusing to write: only ${count} players returned`
        );
      }

      const payload = {
        ok: true,
        seasonId: String(seasonId),
        gameTypeId,
        lastUpdatedAt: nowMs(),
        byPlayerId,
      };

      refreshRepository.writeCache(payload);
      logger.log(`Stats refreshed: ${count} players`);
      return undefined;
    } finally {
      refreshRepository.releaseLock();
    }
  }

  return {
    cacheExists,
    readCache,
    readPlayer,
    refresh,
  };
}

module.exports = { createStatisticsService };
