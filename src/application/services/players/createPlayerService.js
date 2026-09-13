const {
  buildSearchHaystack,
  normalizePlayers,
  normalizeString,
} = require("./normalizePlayer");

function createPlayerService({
  repository,
  logger = console,
} = {}) {
  if (!repository || typeof repository.loadPlayers !== "function") {
    throw new TypeError(
      "createPlayerService requires a player repository"
    );
  }

  let playersCache = [];
  let playersById = new Map();

  function replaceCache(players) {
    playersCache = players;
    playersById = new Map(players.map((player) => [player.id, player]));
  }

  function reload() {
    const loaded = repository.loadPlayers();

    if (!loaded.ok) {
      replaceCache([]);
      logger.error(
        "[PLAYERS] Failed to load players:",
        loaded.error
      );
      return {
        ok: false,
        count: 0,
        error: loaded.error,
      };
    }

    const players = normalizePlayers(loaded.players);
    replaceCache(players);
    return {
      ok: true,
      count: players.length,
      source: loaded.source,
    };
  }

  function list() {
    return playersCache.slice();
  }

  function getById(id) {
    return playersById.get(id) || null;
  }

  function search(query, limit = 25) {
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) return [];

    const tokens = normalizedQuery.split(" ").filter(Boolean);
    const results = [];

    for (const player of playersCache) {
      if (!player?.active) continue;
      const haystack = buildSearchHaystack(player);
      const matches = tokens.every((token) =>
        haystack.includes(token)
      );
      if (matches) results.push(player);
      if (results.length >= limit) break;
    }

    return results;
  }

  function getDebugInfo() {
    return {
      ...repository.getDebugInfo(),
      cacheCount: playersCache.length,
    };
  }

  return {
    getById,
    getCacheCount: () => playersCache.length,
    getDebugInfo,
    list,
    reload,
    search,
  };
}

module.exports = { createPlayerService };
