const { randomUUID } = require("node:crypto");
const { createJobRunner } = require("../runJob");
const EVENING_TIMES = Object.freeze([18 * 60, 20 * 60, 22 * 60, 23 * 60 + 45]);
const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function latestEveningOccurrence(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("A safe statistics schedule time is required.");
  // Walk real UTC minutes so the persisted slot remains correct across both DST changes.
  const minute = nowMs - nowMs % 60_000;
  for (let age = 0; age <= 26 * 60; age += 1) {
    const instant = minute - age * 60_000;
    const parts = Object.fromEntries(pacific.formatToParts(instant).map(({ type, value }) => [type, value]));
    if (EVENING_TIMES.includes(Number(parts.hour) * 60 + Number(parts.minute))) return instant;
  }
  throw new Error("The previous statistics refresh slot could not be resolved.");
}

function createRunCompletedGameStatisticsJob({ repository, statisticsService, nhlSeasonKey, clock, afterRefresh = async () => {}, logger = console, owner = randomUUID() } = {}) {
  if (!repository?.claim || !repository?.assertLease || !repository?.complete || !statisticsService?.refresh || !clock?.nowMs || !/^\d{8}$/.test(nhlSeasonKey)) throw new TypeError("The completed-game scheduler requires durable storage, statistics and season context.");
  return createJobRunner({ name: "statistics:completed_games", logger, async execute() {
    const nowMs = clock.nowMs();
    const scheduledForMs = latestEveningOccurrence(nowMs);
    const lease = repository.claim({ occurrenceKey: `${nhlSeasonKey}:${scheduledForMs}`, scheduledForMs, nowMs, owner });
    if (!lease) return { status: "skipped", reason: "already_claimed_or_completed" };
    try {
      const result = await statisticsService.refresh({ authorizePersist: () => repository.assertLease(lease, clock.nowMs()) });
      repository.complete({ lease, nowMs: clock.nowMs(), result });
      let lateLocks;
      try { lateLocks = await afterRefresh(); }
      catch { lateLocks = { status: "awaiting_data" }; }
      return { status: "succeeded", refreshId: result.refreshId, scheduledForMs, lateLocks };
    } catch (error) {
      repository.complete({ lease, nowMs: clock.nowMs(), errorCode: error.code || "NHL_STATISTICS_REFRESH_FAILED" });
      return { status: "failed", code: error.code || "NHL_STATISTICS_REFRESH_FAILED", scheduledForMs };
    }
  } });
}
module.exports = { EVENING_TIMES, latestEveningOccurrence, createRunCompletedGameStatisticsJob };
