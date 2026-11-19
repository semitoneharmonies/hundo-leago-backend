const { setImmediate: yieldEventLoop } = require('node:timers/promises');
const { createJobRunner } = require('../../../jobs/runJob');
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 120_000;

// A bounded, replace-only, process-local cache. Only its scheduled runner fetches
// NHL data. Reading a score cannot start work or alter persistent league state.
function createNhlLiveStatisticsService({ adapter, scheduleAdapter, nhlSeasonKey, clock,
  intervalMs = DEFAULT_INTERVAL_MS, maxGames = 128, logger = console } = {}) {
  if (!adapter?.readGame || !scheduleAdapter?.readSchedule || !clock?.nowMs || !/^\d{8}$/.test(nhlSeasonKey) ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 30_000 || intervalMs > 300_000 ||
      !Number.isSafeInteger(maxGames) || maxGames < 16 || maxGames > 256) throw new TypeError('Live statistics require bounded fetch, schedule, season and clock configuration.');
  const games = new Map();
  const attemptedAt = new Map();
  let nextPollAtMs = 0;
  let lastAttemptAtMs = null;
  let updatedAtMs = null;
  let failed = false;

  const job = createJobRunner({ name: 'statistics:nhl_live', logger, async execute() {
    const nowMs = clock.nowMs();
    if (nowMs < nextPollAtMs) return { status: 'skipped', reason: 'not_due' };
    nextPollAtMs = nowMs + intervalMs;
    lastAttemptAtMs = nowMs;
    // Expiry bounds retention even across a cancelled or unavailable schedule.
    for (const [id, game] of games) if (game.startsAtMs < nowMs - 7 * DAY_MS) games.delete(id);
    let schedule;
    try {
      schedule = await scheduleAdapter.readSchedule({ nhlSeasonKey, startsAtMs: nowMs - 2 * DAY_MS, endsAtMs: nowMs + DAY_MS });
      if (!Array.isArray(schedule.games)) throw new TypeError('NHL live schedule is incomplete.');
    } catch {
      failed = true;
      return { status: 'succeeded', liveStatus: 'unavailable', retainedGames: games.size };
    }
    const cancelled = new Set(schedule.games.filter(g => ['cancelled', 'postponed'].includes(g.status)).map(g => g.id));
    for (const id of cancelled) { games.delete(id); attemptedAt.delete(id); }
    const candidates = schedule.games.filter(g => g.nhlSeasonKey === nhlSeasonKey && !cancelled.has(g.id) &&
      !g.timeTbd && g.startsAtMs <= nowMs && g.startsAtMs >= nowMs - 2 * DAY_MS && games.get(g.id)?.state !== 'final')
      // Rotate even failed games: a slow game cannot starve older live games.
      .sort((a, b) => (attemptedAt.get(a.id) || 0) - (attemptedAt.get(b.id) || 0) || b.startsAtMs - a.startsAtMs).slice(0, 32);
    let fetched = 0; let failures = 0; let providerHold = false;
    // Two game fetchers, each making one request at a time; never one worker per game.
    let cursor = 0;
    async function collect() {
      while (cursor < candidates.length) {
        if (providerHold || clock.nowMs() - nowMs >= 30_000) { failures += 1; break; }
        const candidate = candidates[cursor++];
        attemptedAt.delete(candidate.id);
        attemptedAt.set(candidate.id, clock.nowMs());
        while (attemptedAt.size > maxGames) attemptedAt.delete(attemptedAt.keys().next().value);
        try {
          const game = await adapter.readGame({ gameId: candidate.id });
          if (game === null) continue; // Advertised start passed, but puck has not dropped.
          if (game.gameId !== candidate.id || game.nhlSeasonKey !== nhlSeasonKey || game.startsAtMs !== candidate.startsAtMs ||
              !['live', 'final'].includes(game.state) || !Array.isArray(game.playerGames)) throw new Error('Live NHL game scope mismatch.');
          const snapshot = structuredClone({ ...game, updatedAtMs: clock.nowMs() });
          for (const row of snapshot.playerGames) { Object.freeze(row.scoringStats); Object.freeze(row); }
          Object.freeze(snapshot.playerGames);
          games.delete(game.gameId);
          games.set(game.gameId, Object.freeze(snapshot));
          while (games.size > maxGames) games.delete(games.keys().next().value);
          fetched += 1;
          updatedAtMs = clock.nowMs();
        } catch (error) {
          failures += 1;
          if (Number.isSafeInteger(error.retryAtMs) && error.retryAtMs > nowMs) {
            providerHold = true;
            nextPollAtMs = Math.max(nextPollAtMs, error.retryAtMs);
          }
        }
        await yieldEventLoop();
      }
    }
    await Promise.all([collect(), collect()]);
    failed = failures > 0;
    if (candidates.length === 0) {
      const starts = schedule.games.filter(g => g.nhlSeasonKey === nhlSeasonKey && !cancelled.has(g.id) && !g.timeTbd && g.startsAtMs > nowMs).map(g => g.startsAtMs);
      nextPollAtMs = Math.min(nowMs + 300_000, ...starts);
    }
    return { status: 'succeeded', liveStatus: failed ? 'partial' : 'available', fetchedGames: fetched, failedGames: failures, retainedGames: games.size };
  } });
  return Object.freeze({ job,
    readSnapshot() {
      const nowMs = clock.nowMs();
      const values = [...games.values()].filter(g => g.startsAtMs >= nowMs - 7 * DAY_MS);
      const stale = failed || values.some(g => g.state === 'live' && nowMs - g.updatedAtMs > 3 * intervalMs);
      return Object.freeze({ enabled: true, status: updatedAtMs === null ? 'unavailable' : stale ? 'stale' : 'available',
        updatedAtMs, lastAttemptAtMs, games: Object.freeze(values) });
    },
  });
}
module.exports = { DEFAULT_INTERVAL_MS, createNhlLiveStatisticsService };
