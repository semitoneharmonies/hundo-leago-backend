"use strict";

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const DAY_MS = 86400000;
const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_DATABASE_ID = 1212433457;
const GAMEPLAY_KEYS = Object.freeze(["completedTrades", "resolvedAuctions", "rosterChanges", "dailyDrafts"]);

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Operational analytics count is unavailable.");
  return value;
}
function timestamp(value) {
  if (value === null) return null;
  return count(value);
}
function dateValid(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(Date.parse(value + "T00:00:00Z")).toISOString().slice(0, 10) === value;
}
function dateShift(value, days) {
  return new Date(Date.parse(value + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}
function weekStart(value) {
  const weekday = new Date(value + "T00:00:00Z").getUTCDay();
  return dateShift(value, -(weekday + 6) % 7);
}
function emptyGameplay() { return Object.fromEntries(GAMEPLAY_KEYS.map(key => [key, 0])); }
function unavailableRooms(status = "unavailable") {
  return { status, cohort: "play_date", modes: [], historicalStartFillAvailable: false };
}
function unavailableFreshness() {
  return { status: "unavailable", statistics: null, injuries: null, jobs: null,
    dailyScoringPending: null, matchupsAwaitingData: null };
}
function createOperationalAnalyticsReader({ database, dailyFilename, clock = Date.now } = {}) {
  if (!database || typeof database.prepare !== "function" || typeof dailyFilename !== "string" ||
      !dailyFilename || typeof clock !== "function") {
    throw new TypeError("Operational analytics requires database readers and a clock.");
  }

  function readDaily({ startDate, endDate, nowMs }) {
    let daily;
    try {
      try { fs.statSync(dailyFilename); }
      catch (error) {
        if (error.code === "ENOENT") return { rooms: unavailableRooms("not_measured"), drafts: null, pending: null };
        throw error;
      }
      // Even SQLITE_OPEN_READONLY may create WAL support files for a closed database.
      // Daily normally holds its writer open. Before that happens after process start,
      // report unavailable rather than initialize WAL/SHM or bypass SQLite locking.
      const header = Buffer.alloc(100);
      const handle = fs.openSync(dailyFilename, "r");
      try { fs.readSync(handle, header, 0, header.length, 0); }
      finally { fs.closeSync(handle); }
      if ((header[18] === 2 || header[19] === 2) &&
          (!fs.existsSync(dailyFilename + "-wal") || !fs.existsSync(dailyFilename + "-shm"))) {
        return { rooms: unavailableRooms(), drafts: null, pending: null };
      }
      daily = new DatabaseSync(dailyFilename, { readOnly: true });
      if (daily.prepare("PRAGMA application_id").get().application_id !== DAILY_DATABASE_ID ||
          daily.prepare("PRAGMA user_version").get().user_version !== 1) throw new Error("Daily storage is unavailable.");
      // SQL projects aggregate facts directly; member identities, room names, bids and messages never enter this reader.
      const parts = `WITH room_parts AS (
        SELECT date AS play_date, COALESCE(json_extract(info,'$.mode'),'scheduled') AS mode,
          json_extract(info,'$.capacity') AS capacity,
          json_array_length(info,'$.members') AS members,
          closed, COALESCE(json_extract(info,'$.finished'),0) AS finished,
          COALESCE(json_extract(info,'$.void'),0) AS voided,
          json_array_length(play,'$.lots') AS lots,
          (first_game_at<=@now OR (
            json_array_length(info,'$.members')>0 AND
            json_array_length(play,'$.lots')=7*json_array_length(info,'$.members') AND
            NOT EXISTS (SELECT 1 FROM json_each(play,'$.lots') lot WHERE json_extract(lot.value,'$.endsAt')>@now)
          )) AS draft_ended
        FROM rooms
      )`;
      const rows = daily.prepare(parts + `
        SELECT play_date,mode,COUNT(*) AS rooms,
          SUM(finished=1 AND voided=0) AS completed,
          SUM(voided=1 OR (closed=1 AND finished=0)) AS cancelled,
          SUM(closed=0 AND finished=0 AND voided=0 AND draft_ended=1) AS pending_scoring,
          SUM(members) AS filled_seats,SUM(capacity) AS capacity_seats,
          SUM(members>=capacity) AS full_rooms,
          SUM(voided=0 AND (closed=0 OR finished=1) AND draft_ended=1 AND lots>0) AS drafts
        FROM room_parts WHERE play_date>=@start AND play_date<=@end
        GROUP BY play_date,mode ORDER BY play_date,mode`).all({ now: nowMs, start: startDate, end: endDate });
      const pending = count(daily.prepare(parts + `
        SELECT COUNT(*) AS count FROM room_parts
        WHERE closed=0 AND finished=0 AND voided=0 AND draft_ended=1`).get({ now: nowMs }).count);
      const modes = ["practice", "scheduled"].map(mode => ({ mode, rooms: 0, completed: 0, cancelled: 0,
        pendingScoring: 0, filledSeats: 0, capacitySeats: 0, fullRooms: 0 }));
      const drafts = new Map();
      for (const row of rows) {
        if (!dateValid(row.play_date) || !modes.some(mode => mode.mode === row.mode)) throw new Error("Daily aggregate format is unavailable.");
        const mode = modes.find(value => value.mode === row.mode);
        for (const [key, source] of Object.entries({ rooms: "rooms", completed: "completed", cancelled: "cancelled",
          pendingScoring: "pending_scoring", filledSeats: "filled_seats", capacitySeats: "capacity_seats", fullRooms: "full_rooms" })) {
          mode[key] = count(mode[key] + count(row[source]));
        }
        drafts.set(row.play_date, count((drafts.get(row.play_date) || 0) + count(row.drafts)));
      }
      return { rooms: { status: "available", cohort: "play_date", modes, historicalStartFillAvailable: false }, drafts, pending };
    } catch {
      return { rooms: unavailableRooms(), drafts: null, pending: null };
    } finally { if (daily) daily.close(); }
  }

  function read(input) {
    const { startMs, endMs, days, startDate, endDate } = input || {};
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs ||
        !Number.isInteger(days) || days < 1 || days > 90 || endMs - startMs !== days * DAY_MS ||
        !dateValid(startDate) || !dateValid(endDate) || dateShift(startDate, days - 1) !== endDate ||
        Date.parse(startDate + "T00:00:00Z") + OFFSET_MS !== startMs ||
        Date.parse(dateShift(endDate, 1) + "T00:00:00Z") + OFFSET_MS !== endMs) {
      throw new TypeError("Operational analytics requires a bounded UTC-8 period.");
    }
    const nowMs = timestamp(clock());
    if (nowMs === null) throw new TypeError("Operational analytics requires a clock.");
    const daily = readDaily({ startDate, endDate, nowMs });
    let gameplay = { status: "unavailable", totals: null, weekly: [] };
    let freshness = unavailableFreshness();
    let calendar = { status: "unavailable", nhlCoverage: "recorded_only", days: [] };

    try {
      const weeks = new Map();
      for (let index = 0; index < days; index++) {
        const key = weekStart(dateShift(startDate, index));
        if (!weeks.has(key)) weeks.set(key, { weekStartDate: key, ...emptyGameplay() });
      }
      const totals = emptyGameplay();
      const sources = [
        ["completedTrades", "trades", "completed_at_ms", "status='completed'"],
        ["resolvedAuctions", "auction_resolutions", "resolved_at_ms", "status IN ('resolved','no_bids','no_winner','recovered')"],
        ["rosterChanges", "ownership_events", "occurred_at_ms", "event_type='roster_category_moved'"],
      ];
      for (const [key, table, timeColumn, predicate] of sources) {
        const rows = database.prepare(`SELECT date(${timeColumn}/1000,'unixepoch','-8 hours') AS day,COUNT(*) AS count
          FROM ${table} WHERE ${predicate} AND ${timeColumn}>=? AND ${timeColumn}<? GROUP BY day`).all(startMs, endMs);
        for (const row of rows) {
          if (!dateValid(row.day) || !weeks.has(weekStart(row.day))) throw new Error("Gameplay date is unavailable.");
          totals[key] = count(totals[key] + count(row.count));
          weeks.get(weekStart(row.day))[key] = count(weeks.get(weekStart(row.day))[key] + row.count);
        }
      }
      if (daily.drafts) {
        for (const [date, value] of daily.drafts) {
          totals.dailyDrafts = count(totals.dailyDrafts + value);
          weeks.get(weekStart(date)).dailyDrafts = count(weeks.get(weekStart(date)).dailyDrafts + value);
        }
      } else {
        totals.dailyDrafts = null;
        for (const week of weeks.values()) week.dailyDrafts = null;
      }
      gameplay = { status: "available", totals, weekly: [...weeks.values()] };
    } catch { /* Keep this section unavailable; other reads remain independent. */ }

    try {
      const statistics = database.prepare(`SELECT MAX(CASE WHEN status='succeeded' THEN completed_at_ms END) AS lastSuccessAtMs,
        COALESCE(SUM(status IN ('failed','rejected') AND completed_at_ms>=@start AND completed_at_ms<@end),0) AS failedInPeriod
        FROM stat_refreshes`).get({ start: startMs, end: endMs });
      const injuryState = database.prepare("SELECT MAX(last_success_at_ms) AS lastSuccessAtMs FROM player_injury_realtime_state").get();
      const injuries = database.prepare(`SELECT COUNT(*) AS failedInPeriod FROM player_injury_realtime_runs
        WHERE status IN ('failed','abandoned') AND completed_at_ms>=? AND completed_at_ms<?`).get(startMs, endMs);
      const jobs = database.prepare(`SELECT COALESCE(SUM(status='failed'),0) AS failedCount,
        COALESCE(SUM(status='pending'),0) AS pendingCount,COALESCE(SUM(status IN ('leased','running')),0) AS runningCount FROM job_runs`).get();
      const matchups = database.prepare("SELECT COUNT(*) AS count FROM matchup_weeks WHERE status='awaiting_data'").get();
      freshness = { status: "available",
        statistics: { lastSuccessAtMs: timestamp(statistics.lastSuccessAtMs), failedInPeriod: count(statistics.failedInPeriod) },
        injuries: { lastSuccessAtMs: timestamp(injuryState.lastSuccessAtMs), failedInPeriod: count(injuries.failedInPeriod) },
        jobs: { failedCount: count(jobs.failedCount), pendingCount: count(jobs.pendingCount), runningCount: count(jobs.runningCount) },
        dailyScoringPending: daily.pending, matchupsAwaitingData: count(matchups.count) };
    } catch { /* Missing or incompatible health sources do not invent healthy zeroes. */ }

    try {
      const byDate = new Map(Array.from({ length: days }, (_, index) => {
        const date = dateShift(startDate, index);
        return [date, { date, recordedNhlGames: null, matchupDeadlines: 0, auctionDeadlines: 0,
          tradeDeadlines: 0, dailyDrafts: daily.drafts ? daily.drafts.get(date) || 0 : null }];
      }));
      const deadlines = [
        ["matchupDeadlines", "SELECT locks_at_ms AS time FROM matchup_weeks WHERE status<>'cancelled'"],
        ["auctionDeadlines", "SELECT resolves_at_ms AS time FROM auctions WHERE status<>'cancelled'"],
        ["tradeDeadlines", "SELECT settings.trade_deadline_at_ms AS time FROM league_settings settings JOIN leagues ON leagues.id=settings.league_id WHERE leagues.status<>'deleted'"],
      ];
      for (const [key, query] of deadlines) {
        const rows = database.prepare(`SELECT date(time/1000,'unixepoch','-8 hours') AS day,COUNT(*) AS count
          FROM (${query}) WHERE time>=? AND time<? GROUP BY day`).all(startMs, endMs);
        for (const row of rows) {
          if (!byDate.has(row.day)) throw new Error("Calendar date is unavailable.");
          byDate.get(row.day)[key] = count(row.count);
        }
      }
      const games = database.prepare(`WITH latest_games AS (
        SELECT nhl_game_id,nhl_game_scheduled_starts_at_ms AS time,observed_game_state,
          ROW_NUMBER() OVER (PARTITION BY nhl_game_id ORDER BY observed_at_ms DESC,id DESC) AS position
        FROM nhl_game_state_observations WHERE observed_at_ms<=?
      )
      SELECT date(time/1000,'unixepoch','-8 hours') AS day,COUNT(*) AS count FROM latest_games
      WHERE position=1 AND observed_game_state NOT IN ('cancelled','postponed') AND time>=? AND time<?
      GROUP BY day`).all(nowMs, startMs, endMs);
      for (const row of games) {
        if (!byDate.has(row.day)) throw new Error("NHL calendar date is unavailable.");
        byDate.get(row.day).recordedNhlGames = count(row.count);
      }
      calendar = { status: "available", nhlCoverage: "recorded_only", days: [...byDate.values()] };
    } catch { /* Do not query providers or initialize state to repair missing calendar evidence. */ }
    return { dailyRooms: daily.rooms, gameplay, freshness, calendar };
  }
  return Object.freeze({ read });
}

module.exports = { createOperationalAnalyticsReader };
