const { randomUUID } = require("node:crypto");
const { assertNhlSeasonKey } = require("../../../domain/statistics/statisticsPolicy");
const { readNhlGameCollection } = require("../../../domain/statistics/nhlGameCollectionPolicy");
const JOB_TYPE = "statistics:completed_games";
const LEASE_MS = 10 * 60_000;
const RETRY_MS = 15 * 60_000;

function createSqliteStatisticsScheduleRepository({ database, createId = randomUUID } = {}) {
  const read = database.prepare("SELECT * FROM job_runs WHERE league_id IS NULL AND job_type = ? AND occurrence_key = ?");
  const insert = database.prepare(`INSERT INTO job_runs (id, job_type, occurrence_key, scheduled_for_ms, status, attempt_count, lease_owner, lease_expires_at_ms, started_at_ms, created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?, 1)`);
  const retry = database.prepare(`UPDATE job_runs SET status = 'running', attempt_count = attempt_count + 1, lease_owner = ?, lease_expires_at_ms = ?, started_at_ms = ?, completed_at_ms = NULL, updated_at_ms = ?, version = version + 1 WHERE id = ? AND version = ?`);
  const finish = database.prepare(`UPDATE job_runs SET status = ?, completed_at_ms = ?, updated_at_ms = ?, result_json = ?, last_error_code = ?, lease_owner = NULL, lease_expires_at_ms = NULL, version = version + 1 WHERE id = ? AND version = ? AND lease_owner = ? AND lease_expires_at_ms > ? AND status = 'running'`);
  const active = database.prepare("SELECT 1 FROM job_runs WHERE league_id IS NULL AND job_type=? AND status='running' AND lease_expires_at_ms>? LIMIT 1");
  const claim = database.transaction(({ occurrenceKey, scheduledForMs, nowMs, owner }) => {
    if (typeof occurrenceKey !== "string" || !/^\d{8}:\d+$/.test(occurrenceKey) || !Number.isSafeInteger(scheduledForMs) || !Number.isSafeInteger(nowMs) || scheduledForMs > nowMs || typeof owner !== "string" || !owner) throw new TypeError("A canonical statistics schedule claim is required.");
    if (active.get(JOB_TYPE, nowMs)) return null;
    const previous = read.get(JOB_TYPE, occurrenceKey);
    if (previous?.status === "succeeded" || (previous?.lease_expires_at_ms > nowMs) || (previous?.status === "failed" && previous.completed_at_ms + RETRY_MS > nowMs)) return null;
    if (previous) retry.run(owner, nowMs + LEASE_MS, nowMs, nowMs, previous.id, previous.version);
    else insert.run(createId(), JOB_TYPE, occurrenceKey, scheduledForMs, owner, nowMs + LEASE_MS, nowMs, nowMs, nowMs);
    return Object.freeze({ ...read.get(JOB_TYPE, occurrenceKey) });
  });
  function assertLease(lease, nowMs) {
    const current = read.get(JOB_TYPE, lease.occurrence_key);
    if (!current || current.id !== lease.id || current.version !== lease.version || current.lease_owner !== lease.lease_owner || current.lease_expires_at_ms <= nowMs || current.status !== "running") throw Object.assign(new Error("The statistics schedule lease expired or changed."), { code: "NHL_STATISTICS_LEASE_LOST" });
  }
  return Object.freeze({
    hasPendingGames({ nhlSeasonKey, nowMs }) {
      assertNhlSeasonKey(nhlSeasonKey);
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("A safe pending-statistics time is required.");
      // Read the published capture, never the provider cache: downloading a game
      // does not prove that its statistics were successfully committed.
      const refresh = database.prepare(`SELECT r.id,r.metadata_json FROM stat_refreshes r
        JOIN stat_sources s ON s.id=r.stat_source_id
        WHERE s.provider='nhl-completed-games' AND r.nhl_season_key=? AND r.status='succeeded'
        ORDER BY r.completed_at_ms DESC,r.started_at_ms DESC,r.id DESC LIMIT 1`).get(nhlSeasonKey);
      if (!refresh) return true;
      const collection = readNhlGameCollection(refresh.metadata_json);
      // Older captures cannot prove completion for games without rostered players.
      return collection === null || collection.pendingGames.some(game => game.startsAtMs <= nowMs);
    },
    claim: (input) => claim.immediate(input),
    assertLease,
    complete({ lease, nowMs, result = null, errorCode = null }) {
      const code = errorCode && /^[A-Z][A-Z0-9_]{0,99}$/.test(errorCode) ? errorCode : errorCode ? "NHL_STATISTICS_REFRESH_FAILED" : null;
      const updated = finish.run(errorCode ? "failed" : "succeeded", nowMs, nowMs, result === null ? null : JSON.stringify(result), code, lease.id, lease.version, lease.lease_owner, nowMs);
      if (updated.changes !== 1) assertLease(lease, nowMs);
    },
  });
}
module.exports = { JOB_TYPE, LEASE_MS, RETRY_MS, createSqliteStatisticsScheduleRepository };
