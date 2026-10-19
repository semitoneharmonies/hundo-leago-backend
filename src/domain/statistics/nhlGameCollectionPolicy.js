function normalizeNhlGameCollection(value) {
  if (value == null) return null; // Captures made before pending-game tracking.
  if (value.schemaVersion !== 1 || !Array.isArray(value.pendingGames) || value.pendingGames.length > 2000) {
    throw new TypeError("NHL game collection evidence is invalid.");
  }
  const seen = new Set();
  const pendingGames = value.pendingGames.map(game => {
    if (!game || typeof game.nhlGameId !== "string" || !/^[1-9][0-9]{9}$/.test(game.nhlGameId) ||
        !Number.isSafeInteger(game.startsAtMs) || game.startsAtMs < 0 || seen.has(game.nhlGameId)) {
      throw new TypeError("NHL pending-game identity or start time is invalid.");
    }
    seen.add(game.nhlGameId);
    return Object.freeze({ nhlGameId: game.nhlGameId, startsAtMs: game.startsAtMs });
  }).sort((a, b) => a.startsAtMs - b.startsAtMs || a.nhlGameId.localeCompare(b.nhlGameId));
  return Object.freeze({ schemaVersion: 1, pendingGames: Object.freeze(pendingGames) });
}

function readNhlGameCollection(metadataJson) {
  return normalizeNhlGameCollection(metadataJson == null ? null : JSON.parse(metadataJson).nhlGameCollection);
}

module.exports = { normalizeNhlGameCollection, readNhlGameCollection };
