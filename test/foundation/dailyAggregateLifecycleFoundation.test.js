"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createDailyStore } = require("../../src/daily/createDailyStore");
const { createAggregateAnalyticsStore } = require("../../src/analytics/createAggregateAnalyticsStore");
const MINUTE = 60000;
const PUCK = Date.parse("2026-11-27T23:00:00Z");
const host = { id: "private-host", name: "Private Host" };
const guest = { id: "private-guest", name: "Private Guest" };
const late = { id: "private-late", name: "Private Late" };
const admin = { id: "private-admin", name: "Private Admin", isAdmin: true };
const slate = { date: "2026-11-27", firstGameAt: PUCK, games: [{ id: "42" }],
  players: ["F", "F", "F", "F", "F", "D", "D", "D", "D", "F", "D", "F", "D", "F"].map((position, index) =>
    ({ id: String(index + 1), name: "Private skater " + index, position, team: "VAN", opponent: "SEA" })) };
function fixture(t, sink) {
  let now = PUCK - 45 * MINUTE;
  const analytics = createAggregateAnalyticsStore({ filename: ":memory:", clock: () => now,
    readAccountTotals: () => ({ total: 0, createdInPeriod: 0 }) });
  const events = [];
  const store = createDailyStore({ filename: ":memory:", clock: () => now,
    recordAggregateMetrics: batch => { events.push(...batch); if (sink) sink(batch); else analytics.recordSystemMetrics(batch); } });
  t.after(() => { store.close(); analytics.close(); });
  return { store, analytics, events, at(value) { now = value; }, create(extra = {}) {
    return store.createRoom({ actor: host, name: "Private room name", capacity: 3, slate, requestId: "private-key", ...extra });
  } };
}
function count(value, metric) { return value.analytics.read().metrics.find(row => row.metric === metric).count; }

test("new room counters record successful creation/start seats once and exclude late joins from start occupancy", t => {
  const value = fixture(t);
  const room = value.create();
  value.create();
  assert.equal(count(value, "room.created.scheduled"), 1);
  value.store.joinRoom({ roomId: room.id, actor: guest });
  value.at(PUCK - 30 * MINUTE);
  value.store.joinRoom({ roomId: room.id, actor: late });
  value.store.captureAnalyticsStarts();
  value.store.captureAnalyticsStarts();
  assert.equal(count(value, "room.started.scheduled"), 1);
  assert.equal(count(value, "room.seats_at_start.scheduled"), 2);
  assert.equal(count(value, "room.capacity_at_start.scheduled"), 3);
  const before = JSON.stringify(value.events);
  value.store.getRoom({ roomId: room.id, actor: host });
  value.store.listRooms({ actor: host });
  assert.equal(JSON.stringify(value.events), before, "GETs cannot capture lifecycle counters");
  assert.ok(value.events.every(row => Object.keys(row).sort().join(",") === "metric,value"));
  assert.equal(JSON.stringify(value.events).includes("private"), false);
});

test("practice creation starts immediately; finish and close retries cannot duplicate or misclassify lifecycle outcomes", t => {
  const value = fixture(t);
  const room = value.create({ mode: "practice" });
  assert.equal(count(value, "room.created.practice"), 1);
  assert.equal(count(value, "room.started.practice"), 1);
  assert.equal(count(value, "room.seats_at_start.practice"), 1);
  value.store.bid({ roomId: room.id, actor: host, playerId: "1", amount: 3 });
  value.at(PUCK - 15 * MINUTE);
  value.store.updateScores({ roomId: room.id, pointsByPlayerId: { 1: 100 }, final: true });
  value.store.updateScores({ roomId: room.id, pointsByPlayerId: { 1: 100 }, final: true });
  value.store.closeRoom({ roomId: room.id, actor: host });
  value.store.closeRoom({ roomId: room.id, actor: admin });
  assert.equal(count(value, "room.completed.practice"), 1);
  assert.equal(count(value, "room.cancelled.practice"), 0);
});

test("cancellation counts once while invalid actions and unavailable analytics cannot break gameplay", t => {
  const value = fixture(t);
  const room = value.create();
  assert.throws(() => value.store.closeRoom({ roomId: room.id, actor: guest }));
  assert.equal(count(value, "room.cancelled.scheduled"), 0);
  value.store.closeRoom({ roomId: room.id, actor: admin });
  value.store.closeRoom({ roomId: room.id, actor: admin });
  assert.equal(count(value, "room.cancelled.scheduled"), 1);
  assert.equal(count(value, "room.started.scheduled"), 0);
  const failed = fixture(t, () => { throw new Error("analytics down"); });
  const created = failed.create({ mode: "practice" });
  assert.ok(created.id);
  assert.equal(failed.store.getRoom({ roomId: created.id, actor: host }).phase, "auction");
});

test("legacy rooms created without instrumentation remain untouched and emit no retrospective counters", t => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const { DatabaseSync } = require("node:sqlite");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-legacy-analytics-"));
  const filename = path.join(directory, "daily.sqlite3");
  const legacy = createDailyStore({ filename, clock: () => PUCK - 45 * MINUTE });
  const room = legacy.createRoom({ actor: host, name: "Legacy", capacity: 2, slate });
  legacy.close();
  const events = [];
  const instrumented = createDailyStore({ filename, clock: () => PUCK - 29 * MINUTE, recordAggregateMetrics: batch => events.push(...batch) });
  const reader = new DatabaseSync(filename, { readOnly: true });
  t.after(() => { reader.close(); instrumented.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const before = reader.prepare("SELECT info,play FROM rooms").get();
  instrumented.captureAnalyticsStarts();
  instrumented.getRoom({ roomId: room.id, actor: host });
  assert.deepEqual(reader.prepare("SELECT info,play FROM rooms").get(), before);
  instrumented.joinRoom({ roomId: room.id, actor: guest });
  assert.equal(JSON.parse(reader.prepare("SELECT info FROM rooms").get().info).analytics, undefined);
  assert.deepEqual(events, []);
});
