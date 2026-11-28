"use strict";

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { resolveAnalyticsPeriod } = require("./createAggregateAnalyticsStore");
const HEALTH_GROUPS = Object.freeze(["failed_jobs", "pending_jobs", "running_jobs", "daily_scoring_pending", "matchups_awaiting_data", "failed_statistics", "failed_injuries"]);
const LIMIT = 50;
const JOB_KINDS = Object.freeze({
  "statistics:completed_games": "statistics", "matchup:statistics_refresh": "statistics",
  "matchup:baseline": "matchup_baseline", "matchup:lock": "matchup_lock", "matchup:finalize": "matchup_finalize", "matchup:rollover": "matchup_rollover",
  "league:entry_draft_rollover": "season_rollover", "auction.resolve.target": "auction", "encrypted_database_backup": "backup",
  fad_deadline: "draft", fad_allocation: "draft", fad_restricted_activation: "draft", fad_fallback_activation: "draft", fad_rollover: "draft",
  fad_completion: "draft", fad_eligibility_revalidation: "draft", fad_queued_nomination_activation: "draft", fad_deadline_reminder: "draft",
});
// Exact known codes only. An unfamiliar code may contain sensitive text and never leaves this reader.
const REASONS = Object.freeze({
  STATISTICS_PROVIDER_FAILED: "provider_unavailable", LIVE_STATISTICS_PROVIDER_FAILED: "provider_unavailable", INJURY_FEED_UNAVAILABLE: "provider_unavailable",
  INJURY_FEED_TIMEOUT: "provider_timeout", INJURY_FEED_RATE_LIMITED: "provider_rate_limited",
  INJURY_API_KEY_MISSING: "provider_credentials", INJURY_FEED_AUTH_FAILED: "provider_credentials",
  STATISTICS_RESPONSE_INCOMPLETE: "incomplete_data", PLAYER_GAME_COVERAGE_RESPONSE_INCOMPLETE: "incomplete_data", INJURY_FEED_INCOMPLETE: "incomplete_data",
  LIVE_STATISTICS_SNAPSHOT_INVALID: "invalid_data", NHL_COMPLETED_SNAPSHOT_INVALID: "invalid_data", INJURY_FEED_INVALID: "invalid_data", INJURY_FEED_TOO_LARGE: "invalid_data",
  STATISTICS_PERSISTENCE_FAILED: "storage_failure", LIVE_STATISTICS_PERSISTENCE_FAILED: "storage_failure", BACKUP_DISK_SPACE_INSUFFICIENT: "disk_space",
  INJURY_LEASE_EXPIRED: "lease_expired", INJURY_REFRESH_CONFLICT: "state_conflict", INJURY_FEED_STALE: "stale_data",
  INJURY_IDENTITY_CHANGED: "identity_conflict", INJURY_MAPPING_CONFLICT: "identity_conflict",
  MATCHUP_LOCK_SOURCE_STALE: "stale_data", MATCHUP_LEGALITY_STATISTICS_MISSING: "incomplete_data", MATCHUP_LEGALITY_PLAYER_GAME_STATISTICS_MISSING: "incomplete_data",
});
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Health facts are unavailable.");
  return value;
}
function time(value) { return value === null || value === undefined ? null : integer(value); }
function item(kind, status, source, reasonCode) {
  return { kind, status, attempts: source.attempts == null ? null : integer(source.attempts),
    scheduledAtMs: time(source.scheduledAtMs), startedAtMs: time(source.startedAtMs), completedAtMs: time(source.completedAtMs),
    updatedAtMs: time(source.updatedAtMs), reasonCode };
}
function knownReason(code) { return Object.hasOwn(REASONS, code) ? REASONS[code] : "unknown"; }
function createAnalyticsHealthReader({ database, dailyFilename, clock = Date.now } = {}) {
  if (typeof database?.prepare !== "function" || typeof dailyFilename !== "string" || !dailyFilename || typeof clock !== "function") throw new TypeError("Health details require read-only sources and a clock.");
  function read({ group, selection = 28 } = {}) {
    if (!HEALTH_GROUPS.includes(group)) throw new TypeError("Choose a known health group.");
    const asOfMs = integer(clock());
    const { period: selected } = resolveAnalyticsPeriod(selection, asOfMs);
    const period = { startDate: selected.startDate, endDate: selected.endDate };
    const scope = ["failed_statistics", "failed_injuries"].includes(group) ? "period" : "current";
    const base = { code: "ADMIN_ANALYTICS_HEALTH_FOUND", group, scope, asOfMs, period, status: "available", total: 0, limit: LIMIT, truncated: false, items: [] };
    const unavailable = status => ({ ...base, status, total: null, truncated: false, items: [] });
    const start = Date.parse(period.startDate + "T08:00:00Z");
    const end = Date.parse(period.endDate + "T08:00:00Z") + 86400000;
    let daily;
    try {
      let rows;
      if (["failed_jobs", "pending_jobs", "running_jobs"].includes(group)) {
        const predicates = { failed_jobs: "status='failed'", pending_jobs: "status='pending'", running_jobs: "status IN ('leased','running')" };
        rows = database.prepare(`SELECT COUNT(*) OVER() AS total, job_type, status, attempt_count AS attempts,
          scheduled_for_ms AS scheduledAtMs, started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
          updated_at_ms AS updatedAtMs, lease_expires_at_ms AS leaseExpiresAtMs, last_error_code AS errorCode
          FROM job_runs WHERE ${predicates[group]} ORDER BY updated_at_ms DESC,id LIMIT 50`).all();
        base.items = rows.map(row => item(Object.hasOwn(JOB_KINDS, row.job_type) ? JOB_KINDS[row.job_type] : "other_job", row.status, row,
          row.status === "pending" ? (row.scheduledAtMs > asOfMs ? "scheduled" : "queued") :
          ["leased", "running"].includes(row.status) ? (row.leaseExpiresAtMs !== null && row.leaseExpiresAtMs <= asOfMs ? "lease_expired" : "in_progress") : knownReason(row.errorCode)));
      } else if (group === "failed_statistics") {
        rows = database.prepare(`SELECT COUNT(*) OVER() AS total,status,started_at_ms AS startedAtMs,completed_at_ms AS completedAtMs,error_code AS errorCode
          FROM stat_refreshes WHERE status IN ('failed','rejected') AND completed_at_ms>=? AND completed_at_ms<? ORDER BY completed_at_ms DESC,id LIMIT 50`).all(start, end);
        base.items = rows.map(row => item("statistics", row.status, row, knownReason(row.errorCode)));
      } else if (group === "failed_injuries") {
        rows = database.prepare(`SELECT COUNT(*) OVER() AS total,status,scheduled_at_ms AS scheduledAtMs,attempted_at_ms AS startedAtMs,
          completed_at_ms AS completedAtMs,error_code AS errorCode FROM player_injury_realtime_runs
          WHERE status IN ('failed','abandoned') AND completed_at_ms>=? AND completed_at_ms<? ORDER BY completed_at_ms DESC,id LIMIT 50`).all(start, end);
        base.items = rows.map(row => item("injuries", row.status, row, knownReason(row.errorCode)));
      } else if (group === "matchups_awaiting_data") {
        rows = database.prepare(`SELECT COUNT(*) OVER() AS total,locks_at_ms AS scheduledAtMs,updated_at_ms AS updatedAtMs FROM matchup_weeks
          WHERE status='awaiting_data' ORDER BY updated_at_ms DESC,id LIMIT 50`).all();
        base.items = rows.map(row => item("matchup", "awaiting_data", row, "awaiting_matchup_data"));
      } else {
        try { fs.statSync(dailyFilename); } catch (error) { if (error.code === "ENOENT") return unavailable("not_measured"); throw error; }
        // A closed WAL database can create support files even on read-only open. Never initialize it on a GET.
        const header = Buffer.alloc(100), handle = fs.openSync(dailyFilename, "r");
        try { fs.readSync(handle, header, 0, 100, 0); } finally { fs.closeSync(handle); }
        if ((header[18] === 2 || header[19] === 2) && (!fs.existsSync(dailyFilename + "-wal") || !fs.existsSync(dailyFilename + "-shm"))) return unavailable("unavailable");
        daily = new DatabaseSync(dailyFilename, { readOnly: true });
        if (daily.prepare("PRAGMA application_id").get().application_id !== 1212433457 || daily.prepare("PRAGMA user_version").get().user_version !== 1) return unavailable("unavailable");
        rows = daily.prepare(`SELECT COUNT(*) OVER() AS total,COALESCE(json_extract(info,'$.mode'),'scheduled') AS mode,first_game_at AS scheduledAtMs
          FROM rooms WHERE closed=0 AND COALESCE(json_extract(info,'$.finished'),0)=0 AND COALESCE(json_extract(info,'$.void'),0)=0
          AND (first_game_at<=@now OR (json_array_length(info,'$.members')>0 AND json_array_length(play,'$.lots')=7*json_array_length(info,'$.members')
            AND NOT EXISTS (SELECT 1 FROM json_each(play,'$.lots') lot WHERE json_extract(lot.value,'$.endsAt')>@now)))
          ORDER BY first_game_at,id LIMIT 50`).all({ now: asOfMs });
        base.items = rows.map(row => {
          if (!["practice", "scheduled"].includes(row.mode)) throw new Error("Unknown Daily mode.");
          return item(row.mode === "practice" ? "daily_practice" : "daily_scheduled", "pending_scoring", row, "awaiting_daily_scoring");
        });
      }
      base.total = rows.length ? integer(rows[0].total) : 0;
      base.truncated = base.total > base.items.length;
      return base;
    } catch { return unavailable("unavailable"); }
    finally { if (daily) daily.close(); }
  }
  return Object.freeze({ read });
}
module.exports = { createAnalyticsHealthReader, HEALTH_GROUPS };
