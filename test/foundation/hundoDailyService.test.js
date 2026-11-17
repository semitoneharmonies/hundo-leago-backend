const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDailyService } = require("../../src/daily/createDailyService");

const minute = 60_000;
const host = { id: "h", name: "Host" };
const puckDrop = Date.parse("2026-11-17T03:00:00Z");
const players = [{ id: "12", name: "Test Player", team: "VAN", position: "LW", opponent: "NYR" }];
const slate = { date: "2026-11-16", firstGameAt: puckDrop, games: [], players };
const input = { name: "Daily Test", capacity: 4, slateDate: slate.date };

test("today and tomorrow each create a room with its own Vancouver slate, reminder and auction deadline", async t => {
  let now = puckDrop - 45 * minute;
  const tomorrow = { ...slate, date: "2026-11-17", firstGameAt: Date.parse("2026-11-18T02:00:00Z"),
    players: [{ ...players[0], id: "27", name: "Tomorrow Skater" }] };
  const schedules = new Map([[slate.date, slate], [tomorrow.date, tomorrow]]);
  const get = async date => schedules.get(date) || null;
  const daily = createDailyService({ filename: ":memory:", clock: () => now, feed: { getSchedule: get, getSlate: get } });
  t.after(() => daily.close());
  const { slateOptions, slate: defaultSlate } = await daily.lobby({ actor: host });
  assert.deepEqual(slateOptions.map(({ day, status, date }) => [day, status, date]),
    [["today", "open", slate.date], ["tomorrow", "open", tomorrow.date]]);
  assert.deepEqual(defaultSlate, { date: slate.date, firstGameAt: puckDrop, auctionStartsAt: puckDrop - 30 * minute });
  const { room: first } = await daily.create({ actor: host, input: { name: "Today", capacity: 3 } });
  const { room: second } = await daily.create({ actor: host, input: { ...input, slateDate: tomorrow.date } });
  assert.deepEqual(second.availablePlayers.map(player => player.id), ["27"]);
  assert.equal(Date.parse(second.auctionStartsAt), tomorrow.firstGameAt - 30 * minute);
  now = puckDrop - 40 * minute;
  assert.deepEqual(daily.reminders({ actor: host }).reminders.map(r => r.roomId), [first.id]);
  now = puckDrop;
  assert.equal(daily.room({ actor: host, roomId: first.id }).room.phase, "locked");
  assert.equal(daily.room({ actor: host, roomId: second.id }).room.phase, "waiting");
  now = tomorrow.firstGameAt - 40 * minute;
  assert.deepEqual(daily.reminders({ actor: host }).reminders.map(r => r.roomId), [second.id]);
  now += 10 * minute;
  assert.equal(daily.room({ actor: host, roomId: second.id }).room.phase, "auction");
  now = tomorrow.firstGameAt;
  assert.equal(daily.room({ actor: host, roomId: second.id }).room.phase, "locked");
});

test("an empty tomorrow cannot create a different day's room and old next-game requests still work", async t => {
  let now = puckDrop - minute;
  const next = { ...slate, date: "2026-11-19", firstGameAt: puckDrop + 3 * 86400000 };
  const get = async date => date === slate.date ? slate : date === next.date ? next : null;
  const daily = createDailyService({ filename: ":memory:", clock: () => now, feed: { getSchedule: get, getSlate: get } });
  t.after(() => daily.close());
  for (const date of ["2026-11-17", next.date, "2030-11-19"]) {
    await assert.rejects(daily.create({ actor: host, input: { ...input, slateDate: date } }), { code: "DAILY_SLATE_CHANGED" });
  }
  now = puckDrop;
  const lobby = await daily.lobby({ actor: host });
  assert.deepEqual(lobby.slateOptions.map(option => option.status), ["locked", "no_games", "open"]);
  assert.equal(lobby.rooms.length, 0);
  assert.equal(lobby.slate.date, next.date);
  await assert.rejects(daily.create({ actor: host, input: { ...input, slateDate: "2026-11-17" } }), { code: "DAILY_SLATE_CHANGED" });
  const { room } = await daily.create({ actor: host, input: { ...input, slateDate: next.date } });
  assert.equal(room.date, next.date);
});

test("tomorrow follows the Vancouver calendar across fall DST and stays selectable if today's schedule fails", async t => {
  const now = Date.parse("2025-11-02T07:30:00Z"); // 00:30 locally; this date lasts 25 hours.
  const tomorrow = { ...slate, date: "2025-11-03", firstGameAt: Date.parse("2025-11-04T03:00:00Z") };
  const feed = { async getSchedule(date) {
    if (date === "2025-11-02") throw Error("offline");
    return date === tomorrow.date ? tomorrow : null;
  }, async getSlate() { return tomorrow; } };
  const daily = createDailyService({ filename: ":memory:", clock: () => now, feed });
  t.after(() => daily.close());
  const lobby = await daily.lobby({ actor: host });
  assert.deepEqual(lobby.slateOptions.map(({ date, status }) => [date, status]),
    [["2025-11-02", "unavailable"], ["2025-11-03", "open"]]);
  assert.equal(lobby.slateUnavailable, false);
  await assert.rejects(daily.create({ actor: host, input: { ...input, slateDate: "2025-11-02" } }), { code: "DAILY_SCHEDULE_UNAVAILABLE" });
  const { room } = await daily.create({ actor: host, input: { ...input, slateDate: tomorrow.date } });
  assert.equal(room.date, tomorrow.date);
});

test("practice uses today's full NHL slate after puck drop with its own immediate auction and scoring deadline", async t => {
  let now = puckDrop + 75 * minute;
  let scoreCalls = 0, outage = false;
  const tomorrow = { ...slate, date: "2026-11-17", firstGameAt: puckDrop + 86400000 };
  const schedule = date => date === slate.date ? slate : date === tomorrow.date ? tomorrow : null;
  const daily = createDailyService({ filename: ":memory:", clock: () => now, feed: {
    async getSchedule(date) { if (outage) throw Error("offline"); return schedule(date); },
    async getSlate(date) { return schedule(date); },
    async getScores(original) {
      assert.deepEqual(original, slate);
      scoreCalls++;
      return { final: true, pointsByPlayerId: { "12": 452 } };
    },
  } });
  t.after(() => daily.close());
  const lobby = await daily.lobby({ actor: host });
  assert.equal(lobby.slate.date, tomorrow.date);
  assert.deepEqual(lobby.practiceSlate, { date: slate.date, firstGameAt: puckDrop, status: "available" });
  await assert.rejects(daily.create({ actor: host, input }), { code: "DAILY_SLATE_CHANGED" });
  await assert.rejects(daily.create({ actor: host, input: { ...input, slateDate: tomorrow.date, mode: "practice" } }),
    { code: "DAILY_SLATE_CHANGED" });
  const practice = { ...input, mode: "practice" };
  const { room } = await daily.create({ actor: host, input: practice, requestId: "practice-today" });
  const request = { actor: host, roomId: room.id };
  assert.equal(room.mode, "practice");
  assert.equal(room.phase, "auction");
  assert.equal(Date.parse(room.firstGameAt), puckDrop);
  assert.equal(Date.parse(room.auctionStartsAt), now);
  assert.equal(Date.parse(room.auctionEndsAt), now + 30 * minute);
  outage = true;
  await daily.bid({ ...request, input: { playerId: "12", amount: 29 } });
  await daily.runMaintenance();
  assert.equal(scoreCalls, 0);
  assert.deepEqual(daily.reminders(request).reminders, []);
  now += 30 * minute;
  assert.equal(daily.room(request).room.phase, "locked");
  await daily.runMaintenance();
  assert.equal(scoreCalls, 1);
  assert.deepEqual(daily.room(request).room.winners, [{ id: host.id, name: host.name, points: 4.52 }]);
  assert.equal((await daily.create({ actor: host, input: practice, requestId: "practice-today" })).room.id, room.id);
  await assert.rejects(daily.create({ actor: host, input, requestId: "practice-today" }), { code: "DAILY_CREATE_CONFLICT" });
});

test("practice cannot fall through to tomorrow when Vancouver has no games today", async t => {
  const now = puckDrop + minute;
  const tomorrow = { ...slate, date: "2026-11-17", firstGameAt: puckDrop + 86400000 };
  const get = async date => date === tomorrow.date ? tomorrow : null;
  const daily = createDailyService({ filename: ":memory:", clock: () => now, feed: { getSchedule: get, getSlate: get } });
  t.after(() => daily.close());
  const lobby = await daily.lobby({ actor: host });
  assert.equal(lobby.slate.date, tomorrow.date);
  assert.deepEqual(lobby.practiceSlate, { date: slate.date, firstGameAt: null, status: "no_games" });
  await assert.rejects(daily.create({ actor: host, input: { ...input, mode: "practice" } }), { code: "DAILY_SLATE_CHANGED" });
  await assert.rejects(daily.create({ actor: host, input: { ...input, mode: "other" } }), { code: "DAILY_MODE_INVALID" });
  assert.equal((await daily.lobby({ actor: host })).rooms.length, 0);
});

test("next playable day follows the Pacific clock; an NHL outage leaves existing rooms and create retries usable", async t => {
  let now = puckDrop - 60 * minute;
  let outage = false;
  const feed = {
    async getSchedule(date) {
      if (outage) throw Error("offline");
      if (date === slate.date) return slate;
      return date === "2026-11-19" ? { date, firstGameAt: puckDrop + 3 * 86400000 } : null;
    },
    async getSlate() { return slate; },
  };
  const daily = createDailyService({ filename: ":memory:", clock: () => now, feed });
  t.after(() => daily.close());
  assert.equal((await daily.lobby({ actor: host })).slate.date, slate.date);
  const { room } = await daily.create({ actor: host, input, requestId: "once" });
  now = puckDrop;
  assert.equal((await daily.lobby({ actor: host })).slate.date, "2026-11-19");
  await assert.rejects(daily.create({ actor: host, input }), { code: "DAILY_SLATE_CHANGED" });
  outage = true;
  const lobby = await daily.lobby({ actor: host });
  assert.equal(lobby.slateUnavailable, true);
  assert.equal(lobby.rooms[0].id, room.id);
  assert.equal((await daily.create({ actor: host, input, requestId: "once" })).room.id, room.id);
  await assert.rejects(daily.create({ actor: host, input: { ...input, capacity: 3 }, requestId: "once" }),
    { code: "DAILY_CREATE_CONFLICT" });
});

test("background maintenance retries a failed push and a missing score, then preserves the winner", async t => {
  let now = puckDrop - 40 * minute, attempts = 0, scoreCalls = 0;
  const daily = createDailyService({ filename: ":memory:", clock: () => now, subscriptions: () => [{}],
    push: { available: true, async send() { if (++attempts === 1) throw Error("offline"); } },
    feed: { getSchedule: async () => slate, getSlate: async () => slate, async getScores() {
      if (++scoreCalls === 1) throw Error("incomplete");
      return { final: true, pointsByPlayerId: { "12": -45 } };
    } },
  });
  t.after(() => daily.close());
  const { room } = await daily.create({ actor: host, input });
  const request = { actor: host, roomId: room.id };
  await daily.runMaintenance();
  await daily.runMaintenance();
  await daily.runMaintenance();
  assert.equal(attempts, 2);
  assert.equal(daily.reminders(request).reminders.length, 1);
  now += 10 * minute;
  await daily.bid({ ...request, input: { playerId: "12", amount: 3 } });
  now = puckDrop;
  await daily.runMaintenance();
  assert.equal(daily.room(request).room.phase, "locked");
  now += minute;
  await daily.runMaintenance();
  assert.deepEqual(daily.room(request).room.winners, [{ id: host.id, name: host.name, points: -0.45 }]);
  now += minute;
  await daily.runMaintenance();
  assert.equal(scoreCalls, 2);
});
