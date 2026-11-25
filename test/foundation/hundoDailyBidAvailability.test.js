const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHundoDailyFeed } = require("../../src/infrastructure/nhl/HundoDailyFeed");
const { createDailyService } = require("../../src/daily/createDailyService");

const minute = 60_000;
const start = Date.parse("2026-11-17T02:30:00Z");
const host = { id: "host", name: "Host" };
const date = "2026-11-16";
const player = { id: "1", name: "One", position: "F", team: "VAN", opponent: "SEA" };

function fixture(t) {
  let now = start - 30_000, offline = false, fetches = 0;
  const game = { id: 2026020300, season: 20262027, gameType: 2,
    startTimeUTC: new Date(start + 30 * minute).toISOString(), gameScheduleState: "OK", gameState: "FUT",
    homeTeam: { id: 23, abbrev: "VAN" }, awayTeam: { id: 55, abbrev: "SEA" } };
  const day = { date, games: [game] };
  const feed = createHundoDailyFeed({ nowMs: () => now, fetchImpl: async () => {
    fetches++;
    if (offline) throw Error("NHL unavailable");
    return { ok: true, json: async () => structuredClone({ gameWeek: [day, { date: "2026-11-17", games: [] }] }) };
  } });
  const slate = { date, firstGameAt: start + 30 * minute, games: [], players: [player] };
  const service = createDailyService({ filename: ":memory:", clock: () => now,
    feed: { ...feed, getSlate: async () => slate } });
  t.after(() => service.close());
  return { feed, service, day, game, at: value => { now = value; }, offline: () => { offline = true; }, fetches: () => fetches,
    create: async () => (await service.create({ actor: host, input: { name: "Availability", capacity: 2, slateDate: date } })).room };
}

test("a brief provider outage accepts a bid using a recently verified schedule without extending its age", async t => {
  const f = fixture(t);
  const room = await f.create();
  const request = { actor: host, roomId: room.id, input: { playerId: player.id, amount: 7 } };
  f.at(start + 30_000); // The normal one-minute schedule cache has expired.
  f.offline();
  const accepted = await f.service.bid(request);
  assert.equal(accepted.room.auctions[0].ownBid, 7);
  assert.equal(f.fetches(), 2);
  // General schedule reads (including new-room creation) still fail closed.
  await assert.rejects(f.feed.getSchedule(date), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
  f.at(start + 89_999);
  assert.equal((await f.service.bid(request)).room.auctions[0].ownBid, 7);
  f.at(start + 90_000);
  await assert.rejects(f.service.bid(request), error => error.code === "DAILY_SCHEDULE_UNAVAILABLE" &&
    error.status === 503 && error.message.includes("Your bid was not placed"));
  assert.equal(f.service.room(request).room.auctions[0].bidCount, 1, "No automatic retry or duplicate accepted bid");
});

test("an outage with no verified schedule never falls back to another date or to an unverified room snapshot", async t => {
  const f = fixture(t);
  f.offline();
  await assert.rejects(f.feed.getSchedule(date, { allowRecentOnFailure: true }), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
  const other = fixture(t);
  await other.feed.getSchedule(date);
  other.offline();
  await assert.rejects(other.feed.getSchedule("2026-11-17", { allowRecentOnFailure: true }), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
});

test("a successful cancellation supersedes the recent schedule and prevents bids", async t => {
  const f = fixture(t);
  const room = await f.create();
  f.at(start + 30_000);
  f.game.gameScheduleState = "PPD";
  const request = { actor: host, roomId: room.id, input: { playerId: player.id, amount: 7 } };
  await assert.rejects(f.service.bid(request), { code: "DAILY_AUCTION_INACTIVE" });
  assert.equal(f.service.room(request).room.phase, "void");
  f.at(start + 90_000);
  f.offline();
  assert.equal(await f.feed.getSchedule(date, { allowRecentOnFailure: true }), null, "An outage cannot resurrect a cancelled slate");
});

test("a fresh earlier puck drop takes precedence over the previous auction deadline", async t => {
  const f = fixture(t);
  const room = await f.create();
  f.at(start + 30_000);
  f.game.startTimeUTC = new Date(start + 15_000).toISOString();
  const request = { actor: host, roomId: room.id, input: { playerId: player.id, amount: 7 } };
  await assert.rejects(f.service.bid(request), { code: "DAILY_AUCTION_INACTIVE" });
  const result = f.service.room(request).room;
  assert.equal(result.phase, "locked");
  assert.deepEqual(result.auctions, []);
});

test("membership and the stored auction deadline reject bids before touching the provider", async t => {
  const f = fixture(t);
  const room = await f.create();
  f.offline();
  const request = { roomId: room.id, input: { playerId: player.id, amount: 7 } };
  await assert.rejects(f.service.bid({ ...request, actor: { id: "stranger", name: "Stranger" } }), { code: "DAILY_MEMBERSHIP_REQUIRED" });
  f.at(start + 30 * minute);
  await assert.rejects(f.service.bid({ ...request, actor: host }), { code: "DAILY_AUCTION_INACTIVE" });
  assert.equal(f.fetches(), 1);
});
