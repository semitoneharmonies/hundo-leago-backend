"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auctionStartOptions, validateAuctionStart } = require("../../src/daily/dailySchedule");
const { createDailyService } = require("../../src/daily/createDailyService");

const minute = 60_000;
const today = "2026-11-24", tomorrow = "2026-11-25";
const tonight = Date.parse("2026-11-25T03:15:00Z"); // November 24, 8:15pm Pacific.
const firstGameAt = Date.parse("2026-11-26T00:00:00Z"); // November 25, 5pm Pacific.
const slate = { date: tomorrow, firstGameAt, games: [{ id: "42" }], players: [
  { id: "21", name: "Player", position: "F", team: "VAN", opponent: "SEA" },
] };

test("tomorrow's start choices begin at tonight's next quarter and retain the exact latest legal time", () => {
  const now = tonight - 7 * minute;
  const choices = auctionStartOptions(tomorrow, firstGameAt, now);
  assert.equal(choices[0], new Date(tonight).toISOString());
  assert.equal(choices.at(-1), "2026-11-25T23:30:00.000Z");
  assert.equal(new Set(choices).size, choices.length);
  for (const choice of choices) {
    const at = Date.parse(choice);
    assert.equal(at % (15 * minute), 0);
    assert.ok(at > now && at + 30 * minute <= firstGameAt);
    assert.doesNotThrow(() => validateAuctionStart(at, slate, now));
  }
  assert.equal(auctionStartOptions(tomorrow, firstGameAt, tonight)[0], new Date(tonight + 15 * minute).toISOString());
  assert.deepEqual(auctionStartOptions(tomorrow, firstGameAt, firstGameAt - 30 * minute), []);
  assert.equal(auctionStartOptions(tomorrow, firstGameAt + 10 * minute, now).at(-1), "2026-11-25T23:30:00.000Z");
});

test("cross-date validation still rejects elapsed, non-quarter and too-late starts", () => {
  const now = tonight - 7 * minute;
  for (const at of [now, tonight - 15 * minute, tonight + minute, firstGameAt - 15 * minute, NaN]) {
    assert.throws(() => validateAuctionStart(at, slate, now), { code: "DAILY_START_UNAVAILABLE" });
  }
  assert.doesNotThrow(() => validateAuctionStart(undefined, slate, now), "Legacy clients keep their established default");
});

test("a tomorrow-slate room created after today's puck drop can draft tonight, remind on time, and lock after thirty minutes", async t => {
  let now = tonight - 12 * minute;
  const notices = [];
  const todaySlate = { ...slate, date: today, firstGameAt: firstGameAt - 86_400_000 };
  const daily = createDailyService({ filename: ":memory:", clock: () => now,
    feed: { getSchedule: async date => date === tomorrow ? slate : date === today ? todaySlate : null,
      getSlate: async date => date === tomorrow ? slate : todaySlate,
      getScores: async () => ({ final: false, pointsByPlayerId: {} }) },
    notify: notice => notices.push(notice),
  });
  t.after(() => daily.close());
  const actor = { id: "host", name: "Host" };
  const lobby = await daily.lobby({ actor });
  assert.equal(lobby.slateOptions[0].status, "locked");
  assert.ok(lobby.slateOptions[1].auctionStartOptions.includes(new Date(tonight).toISOString()));
  const { room } = await daily.create({ actor, input: { name: "Tonight for tomorrow", capacity: 2,
    slateDate: tomorrow, auctionStartsAt: new Date(tonight).toISOString() } });
  const read = () => daily.room({ actor, roomId: room.id }).room;
  assert.equal(room.date, tomorrow);
  assert.equal(room.auctionStartsAt, new Date(tonight).toISOString());
  assert.equal(room.auctionEndsAt, new Date(tonight + 30 * minute).toISOString());
  assert.equal(room.firstGameAt, new Date(firstGameAt).toISOString());
  assert.equal(room.phase, "waiting");
  now = tonight - 10 * minute;
  await daily.runMaintenance();
  assert.ok(notices.some(notice => notice.type === "daily_auction_reminder"));
  now = tonight;
  await daily.bid({ actor, roomId: room.id, input: { playerId: "21", amount: 1 } });
  assert.equal(read().phase, "auction");
  now = tonight + 30 * minute;
  assert.equal(read().phase, "locked");
  await daily.runMaintenance();
  assert.equal(read().phase, "locked");
  assert.deepEqual(read().winners, []);
});
