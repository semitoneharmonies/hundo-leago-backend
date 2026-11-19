const { normalizeNhlLiveGame } = require('./normalizeLiveGame');

// Public game data only. League records are never read or written here.
function createNhlLiveGameAdapter({ fetchImpl = fetch, timeoutMs = 8_000, nowMs = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError('A bounded NHL live fetch is required.');
  async function json(gameId, resource) {
    const response = await fetchImpl(`https://api-web.nhle.com/v1/gamecenter/${gameId}/${resource}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'hundo-leago/1.0' },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      const raw = response.headers?.get?.('retry-after');
      const delay = /^\d+$/.test(raw || '') ? Number(raw) * 1000 : Date.parse(raw) - nowMs();
      throw Object.assign(new Error('Live NHL data is temporarily unavailable.'), { code: 'NHL_LIVE_REQUEST_FAILED',
        ...(response.status === 429 ? { retryAtMs: nowMs() + Math.min(3_600_000, Math.max(120_000, Number.isFinite(delay) ? delay : 120_000)) } : {}),
      });
    }
    // Bound the decoded body as well as the time spent waiting for it.
    const reader = response.body?.getReader?.();
    if (!reader) {
      const body = await response.json();
      if (JSON.stringify(body).length > 2_000_000) throw new Error('NHL live response is too large.');
      return body;
    }
    const chunks = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2_000_000) { await reader.cancel(); throw new Error('NHL live response is too large.'); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { reader.releaseLock(); }
  }
  return Object.freeze({
    async readGame({ gameId }) {
      if (!/^[1-9][0-9]{9}$/.test(gameId)) throw new TypeError('An NHL game ID is required.');
      const playByPlay = await json(gameId, 'play-by-play');
      if (['FUT', 'PRE'].includes(playByPlay.gameState)) return null;
      // Sequential requests bound provider and server concurrency. Inconsistent
      // snapshots are rejected by the normalizer and retried next scheduled poll.
      const boxscore = await json(gameId, 'boxscore');
      const landing = await json(gameId, 'landing');
      const game = normalizeNhlLiveGame({ playByPlay, boxscore, landing });
      if (game.gameId !== gameId) throw new Error('NHL live game identity does not match.');
      return game;
    },
  });
}
module.exports = { createNhlLiveGameAdapter };
