const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEAM = /^[A-Z]{2,3}$/;
const STATES = { FUT: "scheduled", PRE: "scheduled", LIVE: "live", CRIT: "live", FINAL: "final", OFF: "final" };

function unavailable() {
  return Object.assign(new Error("The NHL schedule is temporarily unavailable."), { code: "NHL_SCHEDULE_UNAVAILABLE" });
}

// Public NHL schedule data only. This cache never writes to league storage.
function createNhlScheduleAdapter({ fetchImpl = fetch, nowMs = Date.now, timeoutMs = 10_000, ttlMs = 300_000 } = {}) {
  const cache = new Map();
  const pending = new Map();

  async function page(date) {
    const cached = cache.get(date);
    if (cached && nowMs() < cached.expiresAtMs) {
      if (cached.error) throw unavailable();
      return cached;
    }
    if (pending.has(date)) return pending.get(date);
    if (pending.size >= 8) throw unavailable();
    const request = (async () => {
      try {
        const response = await fetchImpl(`https://api-web.nhle.com/v1/schedule/${date}`, {
          headers: { Accept: "application/json", "User-Agent": "hundo-leago/1.0" },
          signal: AbortSignal.timeout(timeoutMs), redirect: "error",
        });
        if (!response.ok) throw unavailable();
        const body = await response.json();
        if (!Array.isArray(body?.gameWeek) || body.gameWeek.length !== 7) throw unavailable();
        const games = [];
        const ids = new Set();
        for (let index = 0; index < 7; index += 1) {
          const day = body.gameWeek[index];
          const expected = new Date(Date.parse(`${date}T00:00:00Z`) + index * DAY_MS).toISOString().slice(0, 10);
          if (!DATE.test(day?.date) || day.date !== expected || !Array.isArray(day.games) || day.games.length > 32) throw unavailable();
          for (const raw of day.games) {
            if (!Number.isSafeInteger(raw.id) || ids.has(raw.id)) throw unavailable();
            ids.add(raw.id);
            // Hundo scores NHL regular-season games only.
            if (raw.gameType !== 2) continue;
            const startsAtMs = Date.parse(raw.startTimeUTC);
            const homeTeam = raw.homeTeam?.abbrev;
            const awayTeam = raw.awayTeam?.abbrev;
            const status = raw.gameScheduleState === "PPD" ? "postponed"
              : ["CNCL", "CANC"].includes(raw.gameScheduleState) ? "cancelled" : STATES[raw.gameState];
            if (!Number.isSafeInteger(startsAtMs) || !TEAM.test(homeTeam) || !TEAM.test(awayTeam) || homeTeam === awayTeam || !status || !/^\d{8}$/.test(String(raw.season))) throw unavailable();
            games.push(Object.freeze({ id: String(raw.id), nhlSeasonKey: String(raw.season), startsAtMs, homeTeam, awayTeam, status, timeTbd: raw.gameScheduleState === "TBD" }));
          }
        }
        const result = { games: Object.freeze(games), fetchedAtMs: nowMs(), expiresAtMs: nowMs() + ttlMs };
        cache.set(date, result);
        return result;
      } catch {
        cache.set(date, { error: true, expiresAtMs: nowMs() + 30_000 });
        throw unavailable();
      } finally {
        // Bound both successful entries and failure cooldown entries.
        while (cache.size > 64) cache.delete(cache.keys().next().value);
      }
    })();
    pending.set(date, request);
    try { return await request; } finally { pending.delete(date); }
  }

  return Object.freeze({
    async readSchedule({ startsAtMs, endsAtMs, nhlSeasonKey }) {
      if (!Number.isSafeInteger(startsAtMs) || !Number.isSafeInteger(endsAtMs) || endsAtMs <= startsAtMs || endsAtMs - startsAtMs > 62 * DAY_MS || !/^\d{8}$/.test(nhlSeasonKey)) throw unavailable();
      // NHL calendar dates are Eastern; include the preceding UTC day so evening games are never lost.
      const firstDay = Math.floor(startsAtMs / DAY_MS) * DAY_MS - DAY_MS;
      const games = new Map();
      let fetchedAtMs = Infinity;
      for (let day = firstDay; day < endsAtMs; day += 7 * DAY_MS) {
        const result = await page(new Date(day).toISOString().slice(0, 10));
        fetchedAtMs = Math.min(fetchedAtMs, result.fetchedAtMs);
        for (const game of result.games) {
          if (game.nhlSeasonKey === nhlSeasonKey && game.startsAtMs >= startsAtMs && game.startsAtMs < endsAtMs) games.set(game.id, game);
        }
      }
      return Object.freeze({ fetchedAtMs, games: Object.freeze([...games.values()].sort((a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id))) });
    },
  });
}

module.exports = { createNhlScheduleAdapter };
