const { createHash } = require("node:crypto");

const DAY_MS = 86_400_000;
const RECENT_GAME_WINDOW_MS = 8 * DAY_MS;
const HISTORICAL_RECHECK_MS = 7 * DAY_MS;
const CACHE_VERSION = "completed-game-v1";

function gameIdentity(game) {
  return JSON.stringify([game.id, game.startsAtMs, game.homeTeamId, game.awayTeamId]);
}

function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Recent games are always fetched. Older games are reusable only while their
// identity, scoring mode, and correction-check deadline remain unchanged.
function canReuseCompletedGame({ entry, game, season, expanded, nowMs }) {
  return Boolean(entry && game.final && entry.version === CACHE_VERSION &&
    entry.season === season && entry.expanded === expanded &&
    entry.identity === gameIdentity(game) &&
    entry.data && Array.isArray(entry.data.rows) && Array.isArray(entry.data.categories) &&
    Number.isSafeInteger(entry.checkedAtMs) && entry.checkedAtMs <= nowMs &&
    game.startsAtMs < nowMs - RECENT_GAME_WINDOW_MS &&
    nowMs - entry.checkedAtMs < HISTORICAL_RECHECK_MS &&
    entry.sha256 === contentHash(entry.data));
}

function completedGameEntry({ game, season, expanded, checkedAtMs, data }) {
  return { version: CACHE_VERSION, season, expanded, identity: gameIdentity(game),
    checkedAtMs, data, sha256: contentHash(data) };
}

module.exports = { RECENT_GAME_WINDOW_MS, HISTORICAL_RECHECK_MS, canReuseCompletedGame, completedGameEntry };
