// Optional, public presentation data. Never writes player or league records.
function createNhlPlayerAppearanceAdapter({ fetchImpl = fetch, nowMs = Date.now, timeoutMs = 1500,
  cacheTtlMs = 6 * 60 * 60 * 1000, unavailableTtlMs = 5 * 60 * 1000, maxEntries = 512, maxConcurrent = 4 } = {}) {
  const cache = new Map();
  const pending = new Map();

  async function fetchAppearance(nhlId) {
    const controller = new AbortController();
    let timer;
    try {
      // The explicit race also bounds a stalled body or an injected fetch that ignores abort.
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`https://api-web.nhle.com/v1/player/${nhlId}/landing`, {
            signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' },
          });
          if (!response.ok) return null;
          const data = await response.json();
          if (String(data?.playerId) !== nhlId || data.isActive !== true ||
            !/^[A-Z]{2,3}$/.test(data.currentTeamAbbrev) ||
            !Number.isInteger(data.sweaterNumber) || data.sweaterNumber < 1 || data.sweaterNumber > 99) return null;
          return Object.freeze({ jerseyNumber: data.sweaterNumber, nhlTeam: data.currentTeamAbbrev });
        })(),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
      ]);
    } catch {
      // Cosmetic data must not prevent authorized access to the card's saved information.
      return null;
    } finally { clearTimeout(timer); }
  }

  function read({ externalIds = [] } = {}) {
    const ids = [...new Set(externalIds.filter(id => id.provider === 'nhl').map(id => String(id.externalValue)))];
    if (ids.length !== 1 || !/^[1-9][0-9]{0,12}$/.test(ids[0])) return Promise.resolve(null);
    const nhlId = ids[0];
    const cached = cache.get(nhlId);
    if (cached && cached.expiresAtMs > nowMs()) return Promise.resolve(cached.value);
    if (pending.has(nhlId)) return pending.get(nhlId);
    // A busy public feed is allowed to omit decoration; it must not queue card requests.
    if (pending.size >= maxConcurrent) return Promise.resolve(null);
    const request = fetchAppearance(nhlId).then(value => {
      cache.delete(nhlId);
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(nhlId, { value, expiresAtMs: nowMs() + (value ? cacheTtlMs : unavailableTtlMs) });
      return value;
    }).finally(() => pending.delete(nhlId));
    pending.set(nhlId, request);
    return request;
  }
  return Object.freeze({ read });
}

module.exports = { createNhlPlayerAppearanceAdapter };
