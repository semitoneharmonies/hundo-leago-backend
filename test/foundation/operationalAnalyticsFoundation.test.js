"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { DatabaseSync } = require("node:sqlite");
const { createOperationalAnalyticsReader } = require("../../src/analytics/readOperationalAnalytics");

const NOW = Date.parse("2026-11-27T20:00:00Z");
const at = date => Date.parse(date + "T08:00:00Z");
const PERIOD = { days: 7, startDate: "2026-11-21", endDate: "2026-11-27",
  startMs: at("2026-11-21"), endMs: at("2026-11-28") };
function mainDatabase() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE trades(status TEXT,completed_at_ms INTEGER,secret TEXT);
    CREATE TABLE auction_resolutions(status TEXT,resolved_at_ms INTEGER);
    CREATE TABLE ownership_events(event_type TEXT,occurred_at_ms INTEGER);
    CREATE TABLE stat_refreshes(status TEXT,completed_at_ms INTEGER);
    CREATE TABLE player_injury_realtime_state(last_success_at_ms INTEGER);
    CREATE TABLE player_injury_realtime_runs(status TEXT,completed_at_ms INTEGER);
    CREATE TABLE job_runs(status TEXT);
    CREATE TABLE matchup_weeks(status TEXT,locks_at_ms INTEGER);
    CREATE TABLE auctions(status TEXT,resolves_at_ms INTEGER);
    CREATE TABLE leagues(id TEXT,status TEXT);
    CREATE TABLE league_settings(league_id TEXT,trade_deadline_at_ms INTEGER);
    CREATE TABLE nhl_game_state_observations(id TEXT,nhl_game_id TEXT,nhl_game_scheduled_starts_at_ms INTEGER,
      observed_game_state TEXT,observed_at_ms INTEGER);
  `);
  return database;
}
function fixture(t, { daily = true } = {}) {
  const database = mainDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-operations-"));
  const dailyFilename = path.join(directory, "daily.sqlite3");
  if (daily) {
    const db = new DatabaseSync(dailyFilename);
    db.exec(`CREATE TABLE rooms(date TEXT,first_game_at INTEGER,closed INTEGER,info TEXT,play TEXT);
      PRAGMA application_id=1212433457; PRAGMA user_version=1;`);
    db.close();
  }
  const reader = createOperationalAnalyticsReader({ database, dailyFilename, clock: () => NOW, buildId: "secret-build-unused" });
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function room({ date = "2026-11-24", mode = "scheduled", capacity = 4, members = 2, finished = false, voided = false,
    closed = false, end = NOW - 1000, lots = 1, lotEnd = NOW - 1000 } = {}) {
    const db = new DatabaseSync(dailyFilename);
    try {
      db.prepare("INSERT INTO rooms VALUES(?,?,?,?,?)").run(date, end, Number(closed), JSON.stringify({
        mode, name: "private room", capacity, finished, void: voided,
        members: Array.from({ length: members }, (_, id) => ({ id: "private-user-" + id, name: "private-name" })),
        chat: [{ text: "private-chat" }], commissionerId: "private-user",
      }), JSON.stringify({ lots: Array.from({ length: lots }, (_, id) => ({ playerId: id, endsAt: lotEnd,
        bids: [{ userId: "private-user", amount: 100 }] })), scores: { "private-player": 100 } }));
    } finally { db.close(); }
  }
  return { database, directory, dailyFilename, reader, room };
}
function unchanged(fixtureValue, operation) {
  const before = fixtureValue.database.serialize();
  const dailyBefore = fs.existsSync(fixtureValue.dailyFilename) ? fs.readFileSync(fixtureValue.dailyFilename) : null;
  const filesBefore = fs.readdirSync(fixtureValue.directory);
  const result = operation();
  assert.deepEqual(fixtureValue.database.serialize(), before, "main reads never mutate persisted business records");
  assert.deepEqual(fs.readdirSync(fixtureValue.directory), filesBefore, "reads never initialize storage");
  if (dailyBefore) assert.deepEqual(fs.readFileSync(fixtureValue.dailyFilename), dailyBefore, "Daily reads preserve the file");
  return result;
}

test("operational totals count completed actions once, use UTC-8 weeks and expose no private record fields", t => {
  const f = fixture(t);
  f.database.prepare("INSERT INTO trades VALUES(?,?,?)").run("completed", PERIOD.startMs, "private-trade");
  f.database.prepare("INSERT INTO trades VALUES(?,?,?)").run("completed", at("2026-11-23"), "private-trade");
  f.database.prepare("INSERT INTO trades VALUES(?,?,?)").run("reversed", at("2026-11-24"), "private-trade");
  f.database.prepare("INSERT INTO trades VALUES(?,?,?)").run("completed", PERIOD.endMs, "private-trade");
  for (const state of ["resolved", "no_bids", "no_winner", "recovered", "cancelled", "failed"]) {
    f.database.prepare("INSERT INTO auction_resolutions VALUES(?,?)").run(state, at("2026-11-24"));
  }
  f.database.prepare("INSERT INTO ownership_events VALUES(?,?)").run("roster_category_moved", at("2026-11-22"));
  f.database.prepare("INSERT INTO ownership_events VALUES(?,?)").run("fantasy_elc_signed", at("2026-11-22"));
  f.room({ finished: true, closed: true });
  const result = unchanged(f, () => f.reader.read(PERIOD));
  assert.deepEqual(result.gameplay.totals, { completedTrades: 2, resolvedAuctions: 4, rosterChanges: 1, dailyDrafts: 1 });
  assert.deepEqual(result.gameplay.weekly, [
    { weekStartDate: "2026-11-16", completedTrades: 1, resolvedAuctions: 0, rosterChanges: 1, dailyDrafts: 0 },
    { weekStartDate: "2026-11-23", completedTrades: 1, resolvedAuctions: 4, rosterChanges: 0, dailyDrafts: 1 },
  ]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(result.dailyRooms.historicalStartFillAvailable, false);
});

test("Daily play-date health distinguishes completed archives, cancellation, current fill and pending scoring", t => {
  const f = fixture(t);
  f.room({ finished: true, closed: true, members: 4 });
  f.room({ closed: true });
  f.room({ voided: true, finished: true });
  f.room({ members: 3 }); // Scheduled window ended, awaiting scores.
  f.room({ mode: "practice", members: 1, lots: 7, end: NOW + 60000 }); // All seven draft lots closed early.
  f.room({ mode: "practice", end: NOW + 60000 }); // Still drafting.
  f.room({ date: "2026-11-01" }); // Outside selected cohort, but globally pending scoring.
  const result = unchanged(f, () => f.reader.read(PERIOD));
  assert.deepEqual(result.dailyRooms, { status: "available", cohort: "play_date", historicalStartFillAvailable: false, modes: [
    { mode: "practice", rooms: 2, completed: 0, cancelled: 0, pendingScoring: 1, filledSeats: 3, capacitySeats: 8, fullRooms: 0 },
    { mode: "scheduled", rooms: 4, completed: 1, cancelled: 2, pendingScoring: 1, filledSeats: 11, capacitySeats: 16, fullRooms: 1 },
  ] });
  assert.equal(result.freshness.dailyScoringPending, 3);
  assert.equal(result.gameplay.totals.dailyDrafts, 3);
});

test("freshness reports actual successful refresh times, selected-period failures and current job states", t => {
  const f = fixture(t);
  const stat = f.database.prepare("INSERT INTO stat_refreshes VALUES(?,?)");
  stat.run("succeeded", NOW - 1000);
  stat.run("failed", at("2026-11-24"));
  stat.run("rejected", PERIOD.startMs - 1);
  stat.run("failed", PERIOD.endMs);
  f.database.prepare("INSERT INTO player_injury_realtime_state VALUES(?)").run(NOW - 60000);
  f.database.prepare("INSERT INTO player_injury_realtime_runs VALUES(?,?)").run("failed", at("2026-11-24"));
  f.database.prepare("INSERT INTO player_injury_realtime_runs VALUES(?,?)").run("abandoned", at("2026-11-25"));
  for (const status of ["pending", "running", "leased", "failed", "succeeded"]) f.database.prepare("INSERT INTO job_runs VALUES(?)").run(status);
  f.database.prepare("INSERT INTO matchup_weeks VALUES(?,?)").run("awaiting_data", PERIOD.startMs);
  const result = unchanged(f, () => f.reader.read(PERIOD));
  assert.deepEqual(result.freshness, { status: "available",
    statistics: { lastSuccessAtMs: NOW - 1000, failedInPeriod: 1 },
    injuries: { lastSuccessAtMs: NOW - 60000, failedInPeriod: 2 },
    jobs: { failedCount: 1, pendingCount: 1, runningCount: 2 }, dailyScoringPending: 0, matchupsAwaitingData: 1 });
});

test("calendar deduplicates latest NHL observations, preserves unknown days, and counts broad deadlines only", t => {
  const f = fixture(t);
  const games = f.database.prepare("INSERT INTO nhl_game_state_observations VALUES(?,?,?,?,?)");
  games.run("old", "game1", at("2026-11-22"), "scheduled", NOW - 5000);
  games.run("new", "game1", at("2026-11-24"), "final", NOW - 1000); // Same game rescheduled.
  games.run("duplicate", "game1", at("2026-11-24"), "final", NOW - 1000);
  games.run("second", "game2", at("2026-11-24"), "scheduled", NOW - 1000);
  games.run("cancelled", "game3", at("2026-11-24"), "cancelled", NOW - 1000);
  games.run("future-observation", "game4", at("2026-11-24"), "final", NOW + 1000);
  f.database.prepare("INSERT INTO matchup_weeks VALUES(?,?)").run("live", at("2026-11-24"));
  f.database.prepare("INSERT INTO matchup_weeks VALUES(?,?)").run("cancelled", at("2026-11-24"));
  f.database.prepare("INSERT INTO auctions VALUES(?,?)").run("resolved", at("2026-11-24"));
  f.database.prepare("INSERT INTO auctions VALUES(?,?)").run("cancelled", at("2026-11-24"));
  f.database.prepare("INSERT INTO leagues VALUES(?,?)").run("private-league", "active");
  f.database.prepare("INSERT INTO leagues VALUES(?,?)").run("deleted-league", "deleted");
  f.database.prepare("INSERT INTO league_settings VALUES(?,?)").run("private-league", at("2026-11-24"));
  f.database.prepare("INSERT INTO league_settings VALUES(?,?)").run("deleted-league", at("2026-11-24"));
  f.room({ finished: true });
  const result = unchanged(f, () => f.reader.read(PERIOD));
  assert.equal(result.calendar.status, "available");
  assert.equal(result.calendar.nhlCoverage, "recorded_only");
  assert.equal(result.calendar.days.length, 7);
  assert.deepEqual(result.calendar.days.find(day => day.date === "2026-11-24"),
    { date: "2026-11-24", recordedNhlGames: 2, matchupDeadlines: 1, auctionDeadlines: 1, tradeDeadlines: 1, dailyDrafts: 1 });
  assert.deepEqual(result.calendar.days[0],
    { date: "2026-11-21", recordedNhlGames: null, matchupDeadlines: 0, auctionDeadlines: 0, tradeDeadlines: 0, dailyDrafts: 0 });
  assert.equal(JSON.stringify(result).includes("private-league"), false);
});

test("missing Daily remains not measured without creation while valid main totals remain available", t => {
  const f = fixture(t, { daily: false });
  const result = unchanged(f, () => f.reader.read(PERIOD));
  assert.deepEqual(result.dailyRooms, { status: "not_measured", cohort: "play_date", modes: [], historicalStartFillAvailable: false });
  assert.equal(result.gameplay.status, "available");
  assert.deepEqual(result.gameplay.totals, { completedTrades: 0, resolvedAuctions: 0, rosterChanges: 0, dailyDrafts: null });
  assert.equal(result.freshness.dailyScoringPending, null);
  assert.equal(result.freshness.statistics.lastSuccessAtMs, null);
  assert.equal(result.calendar.days[0].dailyDrafts, null);
  assert.equal(fs.existsSync(f.dailyFilename), false);
});

test("corrupt or foreign Daily is unavailable and section failures never fabricate healthy zeroes", t => {
  const f = fixture(t);
  fs.writeFileSync(f.dailyFilename, "private corrupt data");
  f.database.exec("DROP TABLE stat_refreshes");
  const result = unchanged(f, () => f.reader.read(PERIOD));
  assert.deepEqual(result.dailyRooms, { status: "unavailable", cohort: "play_date", modes: [], historicalStartFillAvailable: false });
  assert.deepEqual(result.freshness, { status: "unavailable", statistics: null, injuries: null, jobs: null,
    dailyScoringPending: null, matchupsAwaitingData: null });
  assert.equal(result.gameplay.status, "available");
  assert.equal(result.gameplay.totals.dailyDrafts, null);
  assert.equal(JSON.stringify(result).includes("private"), false);
  f.database.exec("DROP TABLE trades; DROP TABLE nhl_game_state_observations");
  const incomplete = unchanged(f, () => f.reader.read(PERIOD));
  assert.deepEqual(incomplete.gameplay, { status: "unavailable", totals: null, weekly: [] });
  assert.deepEqual(incomplete.calendar, { status: "unavailable", nhlCoverage: "recorded_only", days: [] });
});

test("reader refuses unbounded or inconsistent periods before reading data", t => {
  const f = fixture(t);
  for (const input of [null, {}, { ...PERIOD, days: 365 }, { ...PERIOD, startMs: PERIOD.startMs + 1 },
    { ...PERIOD, startDate: "2026-11-22" }, { ...PERIOD, endDate: "bad" }]) {
    assert.throws(() => f.reader.read(input), /bounded UTC-8 period/);
  }
});


test("closed WAL Daily stays unavailable without creating WAL or shared-memory support files", t => {
  const f = fixture(t);
  const writer = new DatabaseSync(f.dailyFilename);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.close();
  assert.equal(fs.readFileSync(f.dailyFilename)[18], 2);
  assert.equal(fs.existsSync(f.dailyFilename + "-wal"), false);
  assert.equal(fs.existsSync(f.dailyFilename + "-shm"), false);
  const result = unchanged(f, () => f.reader.read(PERIOD));
  assert.equal(result.dailyRooms.status, "unavailable");
  assert.equal(result.gameplay.status, "available");
  assert.equal(result.gameplay.totals.dailyDrafts, null);
});

test("existing active Daily WAL remains readable without creating files or changing business data", t => {
  const f = fixture(t);
  f.room({ finished: true });
  const writer = new DatabaseSync(f.dailyFilename);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("SELECT COUNT(*) FROM rooms").get();
    assert.equal(fs.existsSync(f.dailyFilename + "-wal"), true);
    assert.equal(fs.existsSync(f.dailyFilename + "-shm"), true);
    const walBefore = fs.readFileSync(f.dailyFilename + "-wal");
    const result = unchanged(f, () => f.reader.read(PERIOD));
    assert.equal(result.dailyRooms.status, "available");
    assert.equal(result.gameplay.totals.dailyDrafts, 1);
    assert.deepEqual(fs.readFileSync(f.dailyFilename + "-wal"), walBefore);
  } finally { writer.close(); }
});

test("historical calendar months and one-day current periods keep business totals historical and health current", t => {
  const f=fixture(t);
  f.database.prepare("INSERT INTO trades VALUES(?,?,?)").run("completed",at("2026-10-01"),"private-trade");
  f.database.prepare("INSERT INTO trades VALUES(?,?,?)").run("completed",at("2026-10-31"),"private-trade");
  f.database.prepare("INSERT INTO trades VALUES(?,?,?)").run("completed",at("2026-11-01"),"private-trade");
  f.database.prepare("INSERT INTO stat_refreshes VALUES(?,?)").run("succeeded",NOW-1000);
  f.database.prepare("INSERT INTO job_runs VALUES(?)").run("pending");
  f.room({date:"2026-10-31",finished:true});
  const month={days:31,startDate:"2026-10-01",endDate:"2026-10-31",startMs:at("2026-10-01"),endMs:at("2026-11-01")};
  const result=unchanged(f,()=>f.reader.read(month));assert.equal(result.gameplay.totals.completedTrades,2);assert.equal(result.gameplay.totals.dailyDrafts,1);assert.equal(result.calendar.days.length,31);assert.equal(result.freshness.statistics.lastSuccessAtMs,NOW-1000);assert.equal(result.freshness.jobs.pendingCount,1);
  const oneDay=unchanged(f,()=>f.reader.read({days:1,startDate:"2026-11-01",endDate:"2026-11-01",startMs:at("2026-11-01"),endMs:at("2026-11-02")}));assert.equal(oneDay.gameplay.totals.completedTrades,1);assert.equal(oneDay.calendar.days.length,1);
});
