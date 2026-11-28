"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createDailyStore } = require("../../src/daily/createDailyStore");
const { createDailyService } = require("../../src/daily/createDailyService");

const minute = 60_000, start = Date.parse("2026-11-28T20:00:00Z"), puck = start + 30 * minute;
const host = { id: "host", name: "Host" }, guest = { id: "guest", name: "Guest" };
const players = Array.from({ length: 24 }, (_, i) => ({ id: String(i + 1), name: `Player ${i + 1}`,
  position: i < 12 ? "F" : "D", team: "VAN", opponent: "SEA" }));
const slate = { date: "2026-11-28", firstGameAt: puck, games: [], players };

function fixture(t, { mode = "scheduled", filename = ":memory:" } = {}) {
  let now = mode === "practice" ? start : start - minute;
  const store = createDailyStore({ filename, clock: () => now });
  t.after(() => store.close());
  const input = { actor: host, name: "Minimum", capacity: 3, slate, mode, requestId: "minimum-room",
    ...(mode === "scheduled" ? { scheduledStartsAt: start } : {}) };
  const room = store.createRoom(input);
  store.joinRoom({ actor: guest, roomId: room.id });
  return { store, room, input, at: value => { now = value; },
    bid: (actor, playerId, amount) => store.bid({ roomId: room.id, actor, playerId: String(playerId), amount }),
    view: (actor = host) => store.getRoom({ roomId: room.id, actor }) };
}

function filename() {
  const directory = fs.mkdtempSync(path.join(__dirname, ".daily-minimum-"));
  return path.join(directory, "daily.sqlite");
}
function removeFixture(file) {
  const directory = path.dirname(file);
  assert.equal(path.dirname(directory), __dirname);
  assert.ok(path.basename(directory).startsWith(".daily-minimum-"));
  fs.rmSync(directory, { recursive: true, force: true });
}

test("new scheduled and practice rooms expose the rising rule and exact next increase", t => {
  for (const mode of ["scheduled", "practice"]) {
    const f = fixture(t, { mode });
    assert.equal(f.room.biddingVersion, "minute-floor-v1");
    assert.equal(f.room.rules.minBid, 1, "base minimum and existing future-slot reserve remain $1");
    assert.equal(f.room.nominationMinimum, 1);
    assert.equal(f.room.nominationMinimumIncreasesAt, new Date(start + minute).toISOString());
    assert.equal(f.store.listRooms({ actor: host })[0].biddingVersion, "minute-floor-v1");
    f.at(start + 59_999);
    assert.equal(f.view().nominationMinimum, 1);
    f.bid(host, 1, 1);
    f.at(start + 60_000);
    assert.equal(f.view().nominationMinimum, 2);
    assert.equal(f.view().nominationMinimumIncreasesAt, new Date(start + 2 * minute).toISOString());
    assert.throws(() => f.bid(host, 2, 1), { code: "DAILY_BID_MINIMUM" });
    f.bid(host, 2, 2);
    f.at(start + 119_999);
    assert.equal(f.view().nominationMinimum, 2);
    f.bid(host, 3, 2);
    f.at(start + 120_000);
    assert.equal(f.view().nominationMinimum, 3);
    assert.throws(() => f.bid(host, 4, 2), { code: "DAILY_BID_MINIMUM" });
    f.bid(host, 4, 3);
  }
});

test("a player keeps its opening floor across room minutes, regardless of the first bid's amount", t => {
  const f = fixture(t);
  f.at(start + 50_000);
  f.bid(host, 1, 20);
  f.at(start + 2 * minute + 45_000);
  assert.equal(f.view().nominationMinimum, 3);
  const accepted = f.bid(guest, 1, 2).auctions[0];
  assert.equal(accepted.minimumBid, 1);
  assert.equal(accepted.ownBid, 2);
  assert.equal(accepted.bidCount, 2);
  assert.equal(accepted.endsAt, new Date(start + 170_000).toISOString());
  f.bid(host, 2, 3);
  assert.throws(() => f.bid(guest, 2, 2), error => error.code === "DAILY_BID_MINIMUM" && error.message.includes("$3"));
  f.at(start + 170_000);
  assert.equal(f.view().members[0].roster[0].price, 20, "a low but legal sealed bid does not displace a higher bid");
});

test("same-minute equal bids remain legal and the earlier committed bid still wins", t => {
  const f = fixture(t);
  f.at(start + 59_999);
  f.bid(host, 1, 1);
  f.at(start + minute);
  f.bid(guest, 1, 1);
  f.at(start + 179_999);
  assert.equal(f.view().members[0].roster[0].id, "1");
  assert.equal(f.view().members[1].roster.length, 0);
});

test("identical retries remain idempotent after increases and expiry; edits remain binding", t => {
  const f = fixture(t);
  f.at(start + 50_000);
  f.bid(host, 1, 1);
  f.at(start + 2 * minute);
  assert.equal(f.bid(host, 1, 1).auctions[0].bidCount, 1);
  assert.throws(() => f.bid(host, 1, 2), { code: "DAILY_BID_BINDING" });
  f.at(puck);
  assert.equal(f.bid(host, 1, 1).members[0].roster[0].price, 1);
  assert.throws(() => f.bid(guest, 2, 1), { code: "DAILY_AUCTION_INACTIVE" });
  assert.equal(f.view().nominationMinimumIncreasesAt, null);
});

test("seven concurrent bids still reserve all slots and dollars, including losing commitments", t => {
  const f = fixture(t);
  f.at(start);
  for (const id of [1, 2, 3, 4, 5, 13, 14]) f.bid(host, id, id === 1 ? 94 : 1);
  assert.equal(f.view().members[0].reserved, 100);
  assert.equal(f.view().auctions.length, 7);
  assert.throws(() => f.bid(host, 15, 1), { code: "DAILY_ROSTER_LIMIT" });
  f.bid(guest, 13, 2);
  assert.equal(f.view().members[0].reserved, 100, "outbid commitments are still reserved until settlement");
  f.at(start + 2 * minute);
  assert.equal(f.view().members[0].roster.length, 6);
  assert.equal(f.view().members[0].remainingCap, 1);
  assert.equal(f.view().bidLimits.D.maxAmount, 1, "do not silently replace the agreed $1 reserve with the rising floor");
  assert.throws(() => f.bid(host, 15, 1), { code: "DAILY_BID_MINIMUM" });
  assert.throws(() => f.bid(host, 15, 3), { code: "DAILY_CAP_LIMIT" });
});

test("both positional limits still account for every pending bid", t => {
  const f = fixture(t);
  f.at(start + minute);
  for (const id of [1, 2, 3, 4, 5]) f.bid(host, id, 2);
  assert.throws(() => f.bid(host, 6, 2), { code: "DAILY_ROSTER_LIMIT" });
  for (const id of [13, 14, 15, 16]) f.bid(guest, id, 2);
  assert.throws(() => f.bid(guest, 17, 2), { code: "DAILY_ROSTER_LIMIT" });
});

test("failed nominations do not persist a clock anchor or change the room", t => {
  const file = filename(), f = fixture(t, { filename: file });
  const db = new DatabaseSync(file); t.after(() => db.close());
  t.after(() => removeFixture(file));
  const rows = () => db.prepare("SELECT * FROM rooms ORDER BY id").all();
  const before = rows();
  f.at(start + 2 * minute);
  assert.throws(() => f.bid(host, 1, 1), { code: "DAILY_BID_MINIMUM" });
  assert.throws(() => f.bid(host, 1, 95), { code: "DAILY_CAP_LIMIT" });
  assert.throws(() => f.bid(host, 999, 3), { code: "DAILY_INELIGIBLE_PLAYER" });
  assert.deepEqual(rows(), before);
  assert.equal(JSON.parse(rows()[0].info).biddingStartsAt, undefined);
  f.bid(host, 1, 3);
  const info = JSON.parse(rows()[0].info), lot = JSON.parse(rows()[0].play).lots[0];
  assert.equal(info.biddingStartsAt, start);
  assert.equal(lot.nominatedAt, start + 2 * minute);
  assert.equal(lot.minimumBid, 3);
});

test("persisted floors survive reconnects and separate store connections", t => {
  const file = filename(), f = fixture(t, { filename: file });
  f.at(start + 59_999);
  f.bid(host, 1, 1);
  const second = createDailyStore({ filename: file, clock: () => start + 2 * minute, existingOnly: true });
  t.after(() => second.close());
  const view = second.bid({ roomId: f.room.id, actor: guest, playerId: "1", amount: 2 });
  assert.equal(view.auctions[0].minimumBid, 1);
  assert.equal(view.auctions[0].bidCount, 2);
  assert.equal(view.nominationMinimum, 3);
  assert.throws(() => second.bid({ roomId: f.room.id, actor: guest, playerId: "2", amount: 2 }), { code: "DAILY_BID_MINIMUM" });
  f.at(start + 2 * minute);
  assert.equal(f.view().auctions[0].bidCount, 2);
  f.store.close(); second.close();
  const reopened = createDailyStore({ filename: file, clock: () => start + 2 * minute, existingOnly: true });
  t.after(() => reopened.close());
  t.after(() => removeFixture(file));
  const restored = reopened.getRoom({ roomId: f.room.id, actor: guest });
  assert.equal(restored.auctions[0].minimumBid, 1);
  assert.equal(restored.auctions[0].ownBid, 2);
  assert.equal(restored.nominationMinimum, 3);
});

test("legacy and unknown-version rooms remain classic and reads or create replays never upgrade them", t => {
  const file = filename();
  let now = start - minute;
  let store = createDailyStore({ filename: file, clock: () => now });
  const inputs = [undefined, "future-rule"].map((version, index) => ({ actor: host, name: `Old ${index}`,
    capacity: 3, slate, requestId: `old-${index}`, version }));
  const rooms = inputs.map(input => store.createRoom(input));
  store.close();
  const db = new DatabaseSync(file);
  t.after(() => { store.close(); db.close(); });
  t.after(() => removeFixture(file));
  rooms.forEach((room, index) => {
    const info = JSON.parse(db.prepare("SELECT info FROM rooms WHERE id=?").get(room.id).info);
    if (inputs[index].version === undefined) delete info.biddingVersion;
    else info.biddingVersion = inputs[index].version;
    db.prepare("UPDATE rooms SET info=? WHERE id=?").run(JSON.stringify(info), room.id);
  });
  const rows = () => db.prepare("SELECT * FROM rooms ORDER BY id").all();
  const before = rows(), version = db.prepare("PRAGMA data_version").get().data_version;
  store = createDailyStore({ filename: file, clock: () => now, existingOnly: true });
  for (const elapsed of [-1, 10, 30]) {
    now = start + elapsed * minute;
    rooms.forEach((room, index) => {
      const view = store.getRoom({ roomId: room.id, actor: host });
      assert.equal(view.biddingVersion, "classic");
      assert.equal(view.nominationMinimum, 1);
      assert.equal(view.nominationMinimumIncreasesAt, null);
      assert.equal(store.createRoom(inputs[index]).id, room.id);
    });
    store.listRooms({ actor: host });
    assert.deepEqual(rows(), before);
    assert.equal(db.prepare("PRAGMA data_version").get().data_version, version);
  }
  now = start + 10 * minute;
  rooms.forEach(room => {
    const view = store.bid({ roomId: room.id, actor: host, playerId: "1", amount: 1 });
    assert.equal(view.auctions[0].minimumBid, 1);
    assert.equal(view.auctions[0].ownBid, 1);
  });
});

test("waiting schedule changes select the clock, then accepted nominations freeze it through later corrections", t => {
  const f = fixture(t);
  f.store.syncRoomSchedule(f.room.id, { ...slate, firstGameAt: puck - minute });
  f.at(start);
  assert.equal(f.view().nominationMinimum, 2);
  f.bid(host, 1, 2);
  const originalEnd = f.view().auctions[0].endsAt;
  f.store.syncRoomSchedule(f.room.id, { ...slate, firstGameAt: puck - 2 * minute });
  assert.equal(f.view().nominationMinimum, 2, "the room start correction does not reprice a running bidding clock");
  assert.equal(f.view().auctions[0].endsAt, originalEnd);
  f.at(start + minute);
  assert.equal(f.view().nominationMinimum, 3);
  f.bid(guest, 1, 2);
  assert.equal(f.view().auctions[0].minimumBid, 2);
});

test("the final horn clips a lot without changing its frozen minimum", t => {
  const f = fixture(t);
  f.at(puck - 30_000);
  assert.equal(f.view().nominationMinimum, 30);
  f.bid(host, 1, 30);
  assert.equal(f.view().auctions[0].minimumBid, 30);
  assert.equal(f.view().auctions[0].endsAt, new Date(puck).toISOString());
  f.at(puck - 1);
  f.bid(guest, 1, 31);
  f.at(puck);
  assert.equal(f.view().phase, "locked");
  assert.equal(f.view().members[1].roster[0].price, 31);
  assert.equal(f.view().nominationMinimumIncreasesAt, null);
  const locked = f.view();
  f.at(puck + 24 * 60 * minute);
  assert.deepEqual(f.view(), locked, "closed nomination display is stable after the deadline");
});

test("a legacy saved auction without floor metadata stays at $1 without read-side rewriting", t => {
  const file = filename(), f = fixture(t, { filename: file });
  f.at(start + 50_000); f.bid(host, 1, 1);
  const db = new DatabaseSync(file); t.after(() => db.close());
  t.after(() => removeFixture(file));
  const row = db.prepare("SELECT * FROM rooms WHERE id=?").get(f.room.id);
  const info = JSON.parse(row.info), play = JSON.parse(row.play);
  delete info.biddingVersion; delete info.biddingStartsAt;
  delete play.lots[0].minimumBid; delete play.lots[0].nominatedAt;
  db.prepare("UPDATE rooms SET info=?,play=? WHERE id=?").run(JSON.stringify(info), JSON.stringify(play), f.room.id);
  const before = db.prepare("SELECT * FROM rooms WHERE id=?").get(f.room.id);
  f.at(start + 2 * minute);
  assert.equal(f.view().auctions[0].minimumBid, 1);
  assert.equal(f.view().nominationMinimum, 1);
  assert.deepEqual(db.prepare("SELECT * FROM rooms WHERE id=?").get(f.room.id), before);
  assert.equal(f.bid(guest, 1, 2).auctions[0].minimumBid, 1);
  const persisted = JSON.parse(db.prepare("SELECT play FROM rooms WHERE id=?").get(f.room.id).play);
  assert.equal(persisted.lots[0].minimumBid, undefined, "normal new bids do not backfill legacy auction metadata");
});

test("server time after an asynchronous schedule check determines the accepted minimum", async t => {
  let now = start - minute, crossing = false;
  const service = createDailyService({ filename: ":memory:", clock: () => now,
    feed: { getSchedule: async () => { if (crossing) now = start + minute; return slate; }, getSlate: async () => slate } });
  t.after(() => service.close());
  const { room } = await service.create({ actor: host, input: { name: "Clock boundary", capacity: 2,
    slateDate: slate.date, auctionStartsAt: new Date(start).toISOString() } });
  crossing = true; now = start + 59_999;
  await assert.rejects(service.bid({ actor: host, roomId: room.id,
    input: { playerId: "1", amount: 1, nominatedAt: start, timestamp: start } }), { code: "DAILY_BID_MINIMUM" });
  assert.equal(service.room({ actor: host, roomId: room.id }).room.auctions.length, 0);
  const result = await service.bid({ actor: host, roomId: room.id, input: { playerId: "1", amount: 2 } });
  assert.equal(result.room.auctions[0].minimumBid, 2);
});
