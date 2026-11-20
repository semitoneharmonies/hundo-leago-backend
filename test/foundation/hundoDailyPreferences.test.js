"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createDailyStore } = require("../../src/daily/createDailyStore");
const { createDailyService } = require("../../src/daily/createDailyService");
const { auctionStartOptions } = require("../../src/daily/dailySchedule");
const { TEAM_PATTERN_DEFINITIONS } = require("../../src/domain/leagues/teamPatternPolicy");

const MINUTE = 60_000;
const host = { id: "host", name: "Host" }, guest = { id: "guest", name: "Guest" };
const puck = Date.parse("2026-11-20T00:00:00Z"); // 5pm Pacific on November 19.
const start = Date.parse("2026-11-19T19:30:00Z"); // 12:30pm Pacific.
const slate = { date: "2026-11-19", firstGameAt: puck, games: [{ id: "42" }], players: [
  { id: "1", name: "One", position: "F", team: "VAN", opponent: "SEA" },
  { id: "2", name: "Two", position: "D", team: "SEA", opponent: "VAN" },
] };
const appearance = { patternTemplate: "even-two", primaryColour: "#123abc", secondaryColour: "#ffffff", tertiaryColour: null };
const input = { name: "Lunch auction", capacity: 4, slateDate: slate.date, auctionStartsAt: new Date(start).toISOString() };

function fixture(t, options = {}) {
  let now = start - 90 * MINUTE;
  const file = options.file;
  const filename = file?.filename || ":memory:";
  const notices = [], pushes = [];
  const feed = { getSchedule: async date => date === slate.date ? slate : null,
    getSlate: async () => slate, getScores: async () => ({ final: false, pointsByPlayerId: { "1": 0, "2": 0 } }), ...options.feed };
  const daily = createDailyService({ filename, clock: () => now, feed,
    notify: options.notify ?? (notice => { notices.push(structuredClone(notice)); }),
    push: { available: true, send: async (_, payload) => { pushes.push(payload); } }, subscriptions: () => [{}],
  });
  if (file) file.keep(daily); else t.after(() => daily.close());
  return { daily, notices, pushes, at: time => { now = time; } };
}
function fileFixture(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, ".hundo-daily-preferences-test-"));
  const resources = [];
  t.after(() => { for (const resource of resources.reverse()) resource.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { filename: path.join(dir, "daily.sqlite"), keep: resource => { resources.push(resource); return resource; } };
}

test("room choices are future Pacific quarter-hours ending at least thirty minutes before puck drop", async t => {
  const { daily, at } = fixture(t);
  at(Date.parse("2026-11-19T18:04:00Z"));
  const option = (await daily.lobby({ actor: host })).slateOptions[0];
  assert.equal(option.auctionStartOptions[0], "2026-11-19T18:15:00.000Z");
  assert.equal(option.auctionStartOptions.at(-1), "2026-11-19T23:30:00.000Z");
  assert.ok(option.auctionStartOptions.includes(input.auctionStartsAt));
  at(puck - 30 * MINUTE);
  assert.equal((await daily.lobby({ actor: host })).slateOptions[0].status, "locked");
  const historical = auctionStartOptions("2025-11-02", Date.parse("2025-11-03T03:00Z"), Date.parse("2025-11-02T06:00Z"));
  assert.ok(historical.includes("2025-11-02T08:00:00.000Z") && historical.includes("2025-11-02T09:00:00.000Z"));
  assert.equal(new Set(historical).size, historical.length, "Repeated historical local hours remain distinct UTC instants");
});

test("selected early auction locks after thirty minutes and keeps scores provisional until NHL finalization", async t => {
  const { daily, at } = fixture(t);
  const { room } = await daily.create({ actor: host, input });
  const request = { actor: host, roomId: room.id };
  assert.equal(room.auctionStartsAt, input.auctionStartsAt);
  assert.equal(room.auctionEndsAt, new Date(start + 30 * MINUTE).toISOString());
  assert.equal(room.firstGameAt, new Date(puck).toISOString());
  at(start - 1);
  await assert.rejects(daily.bid({ ...request, input: { playerId: "1", amount: 2 } }), { code: "DAILY_AUCTION_INACTIVE" });
  at(start);
  await daily.bid({ ...request, input: { playerId: "1", amount: 2 } });
  at(start + 30 * MINUTE);
  assert.equal(daily.room(request).room.phase, "locked");
  assert.throws(() => daily.join({ roomId: room.id, actor: guest }), { code: "DAILY_ROOM_LOCKED" });
  await daily.runMaintenance();
  assert.equal(daily.room(request).room.phase, "locked");
  assert.deepEqual(daily.room(request).room.winners, []);
});

test("invalid starts fail without writes and request retries retain their originally selected time", async t => {
  const file = fileFixture(t);
  const { daily, at } = fixture(t, { file });
  for (const auctionStartsAt of [123, null, "bad", "2026-11-19T19:31:00Z", "2026-11-19T17:00:00Z",
    "2026-11-19T23:45:00Z", "2026-11-20T19:30:00Z"]) {
    await assert.rejects(daily.create({ actor: host, input: { ...input, auctionStartsAt } }));
  }
  // Validation may open the Daily store for a well-formed rejected write, but cannot create a room.
  assert.deepEqual((await daily.lobby({ actor: host })).rooms, []);
  const original = (await daily.create({ actor: host, input, requestId: "chosen" })).room;
  at(start + MINUTE);
  assert.equal((await daily.create({ actor: host, input, requestId: "chosen" })).room.id, original.id);
  await assert.rejects(daily.create({ actor: host, input: { ...input, auctionStartsAt: new Date(start + 15 * MINUTE).toISOString() },
    requestId: "chosen" }), { code: "DAILY_CREATE_CONFLICT" });
  await assert.rejects(daily.create({ actor: host, input: { ...input, mode: "practice" } }), { code: "DAILY_START_INVALID" });
});

test("tomorrow's selected auction can be opened after today's first game", async t => {
  const tomorrow = { ...slate, date: "2026-11-20", firstGameAt: puck + 86_400_000 };
  const { daily, at } = fixture(t, { feed: { getSchedule: async date => date === tomorrow.date ? tomorrow : slate,
    getSlate: async date => date === tomorrow.date ? tomorrow : slate } });
  at(puck + MINUTE);
  const lobby = await daily.lobby({ actor: host });
  assert.equal(lobby.slateOptions[0].status, "locked");
  assert.equal(lobby.slateOptions[1].status, "open");
  const { room } = await daily.create({ actor: host, input: { ...input, slateDate: tomorrow.date,
    auctionStartsAt: new Date(start + 86_400_000).toISOString() } });
  assert.equal(room.date, tomorrow.date);
  assert.equal(room.phase, "waiting");
});

test("selected times survive later NHL delays, shorten safely for earlier puck drops and do not reopen after locking", t => {
  let now = start - MINUTE;
  const store = createDailyStore({ filename: ":memory:", clock: () => now });
  t.after(() => store.close());
  const { id: roomId } = store.createRoom({ actor: host, name: "Clock", capacity: 2, slate, scheduledStartsAt: start });
  const view = () => store.getRoom({ roomId, actor: host });
  store.refreshWaitingSlate({ ...slate, firstGameAt: puck + 30 * MINUTE });
  assert.equal(view().auctionStartsAt, new Date(start).toISOString());
  assert.equal(view().auctionEndsAt, new Date(start + 30 * MINUTE).toISOString());
  now = start;
  store.bid({ roomId, actor: host, playerId: "1", amount: 2 });
  store.syncRoomSchedule(roomId, { ...slate, firstGameAt: start + MINUTE });
  assert.equal(view().auctionEndsAt, new Date(start + MINUTE).toISOString());
  assert.equal(view().auctions[0].endsAt, view().auctionEndsAt);
  now += MINUTE;
  const locked = view();
  store.syncRoomSchedule(roomId, { ...slate, firstGameAt: puck + 60 * MINUTE });
  assert.deepEqual(view(), locked);
});

test("custom-time reminders persist once per participant; joining inside the window is immediately due", async t => {
  const { daily, at, notices, pushes } = fixture(t);
  const { room } = await daily.create({ actor: host, input });
  at(start - 10 * MINUTE - 1);
  await daily.runMaintenance();
  assert.deepEqual(notices, []);
  at(start - 10 * MINUTE);
  await daily.runMaintenance();
  await daily.runMaintenance();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].createdAtMs, start - 10 * MINUTE);
  assert.deepEqual(notices[0].messageData, { roomId: room.id, roomName: input.name, auctionStartsAt: input.auctionStartsAt });
  at(start - 5 * MINUTE);
  daily.join({ roomId: room.id, actor: guest });
  await daily.runMaintenance();
  assert.deepEqual(notices.map(notice => notice.userId), [host.id, guest.id]);
  assert.equal(pushes.length, 2);
  at(start);
  await daily.runMaintenance();
  assert.equal(notices.length, 2);
});

test("winner events include each tied winner, survive restart, and wait for a successful notification acknowledgement", t => {
  const file = fileFixture(t);
  let now = start - MINUTE;
  const store = file.keep(createDailyStore({ filename: file.filename, clock: () => now }));
  const { id: roomId } = store.createRoom({ actor: host, name: "Tie", capacity: 2, slate, scheduledStartsAt: start });
  store.joinRoom({ roomId, actor: guest });
  now = start;
  store.bid({ roomId, actor: host, playerId: "1", amount: 2 });
  store.bid({ roomId, actor: guest, playerId: "2", amount: 2 });
  now += 30 * MINUTE;
  store.updateScores({ roomId, final: false, pointsByPlayerId: { "1": 100, "2": 100 } });
  assert.deepEqual(store.listDueNotifications(), []);
  store.updateScores({ roomId, final: true, pointsByPlayerId: { "1": 100, "2": 100 } });
  const due = store.listDueNotifications();
  assert.equal(due.length, 2);
  assert.ok(due.every(notice => notice.type === "daily_room_won" && notice.messageData.tied && notice.messageData.winnerCount === 2));
  store.markNotificationSent(due[0]);
  store.closeRoom({ roomId, actor: host });
  store.close();
  const reopened = file.keep(createDailyStore({ filename: file.filename, clock: () => now, existingOnly: true }));
  assert.deepEqual(reopened.listDueNotifications(), [due[1]], "Closing a won room cannot drop its pending winner notice");
  reopened.markNotificationSent(due[1]);
  reopened.markNotificationSent(due[1]);
  assert.deepEqual(reopened.listDueNotifications(), []);
});

test("missing or failing notification sink cannot acknowledge a due event", async t => {
  const file = fileFixture(t);
  let attempts = 0;
  const f = fixture(t, { file, notify: () => { attempts++; throw Error("offline"); } });
  await f.daily.create({ actor: host, input });
  f.at(start - 10 * MINUTE);
  await f.daily.runMaintenance();
  const observer = file.keep(createDailyStore({ filename: file.filename, clock: () => start - 10 * MINUTE, existingOnly: true }));
  assert.equal(observer.listDueNotifications().length, 1);
  await f.daily.runMaintenance();
  assert.equal(attempts, 2);
  const noSink = file.keep(createDailyService({ filename: file.filename, clock: () => start - 10 * MINUTE,
    feed: { getSlate: async () => slate } }));
  await noSink.runMaintenance();
  assert.equal(observer.listDueNotifications().length, 1);
});

test("Daily stripes are opt-in, validate existing templates, persist independently and clear explicitly", t => {
  const file = fileFixture(t);
  const store = file.keep(createDailyStore({ filename: file.filename, clock: () => start - MINUTE }));
  const { id: roomId } = store.createRoom({ actor: host, name: "Profile", capacity: 2, slate });
  store.joinRoom({ roomId, actor: guest });
  const observer = file.keep(new DatabaseSync(file.filename));
  const before = observer.prepare("SELECT * FROM rooms").all();
  const version = observer.prepare("PRAGMA data_version").get().data_version;
  assert.deepEqual(store.getProfile({ actor: host }), { appearance: null });
  assert.equal(store.getRoom({ roomId, actor: host }).members[0].dailyAppearance, null);
  assert.equal(observer.prepare("SELECT 1 FROM sqlite_schema WHERE name='daily_profiles'").get(), undefined);
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, version);
  for (const [patternTemplate, count] of Object.entries(TEAM_PATTERN_DEFINITIONS)) {
    store.updateProfile({ actor: host, input: { appearance: { ...appearance, patternTemplate,
      tertiaryColour: count === 3 ? "#876abc" : null } } });
  }
  store.updateProfile({ actor: host, input: { appearance } });
  assert.deepEqual(store.getProfile({ actor: guest }), { appearance: null });
  assert.deepEqual(store.getRoom({ roomId, actor: guest }).members.map(member => member.dailyAppearance), [appearance, null]);
  assert.deepEqual(observer.prepare("SELECT * FROM rooms").all(), before);
  assert.equal(observer.prepare("PRAGMA user_version").get().user_version, 1);
  store.close();
  const reopened = file.keep(createDailyStore({ filename: file.filename, clock: () => start, existingOnly: true }));
  assert.deepEqual(reopened.getProfile({ actor: host }), { appearance });
  reopened.updateProfile({ actor: host, input: { appearance: null } });
  assert.equal(reopened.getRoom({ roomId, actor: guest }).members[0].dailyAppearance, null);
});

test("profile authentication and malformed colours fail before a new Daily sidecar is initialized", t => {
  const file = fileFixture(t);
  const { daily } = fixture(t, { file });
  assert.throws(() => daily.profile({ actor: null }), { code: "DAILY_SIGN_IN_REQUIRED" });
  assert.throws(() => daily.updateProfile({ actor: null, input: { appearance } }), { code: "DAILY_SIGN_IN_REQUIRED" });
  assert.deepEqual(daily.profile({ actor: host }), { profile: { appearance: null } });
  for (const invalid of [{}, { appearance, userId: guest.id }, { appearance: {} }, { appearance: { ...appearance, logo: null } },
    { appearance: { ...appearance, patternTemplate: "unknown" } }, { appearance: { ...appearance, primaryColour: "red" } },
    { appearance: { ...appearance, patternTemplate: "even-three" } }, { appearance: { ...appearance, tertiaryColour: "#123456" } }]) {
    assert.throws(() => daily.updateProfile({ actor: host, input: invalid }), { code: "DAILY_PROFILE_INVALID" });
  }
  assert.equal(fs.existsSync(file.filename), false);
});
