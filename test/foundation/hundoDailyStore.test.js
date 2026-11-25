"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { createDailyStore } = require("../../src/daily/createDailyStore");

const MINUTE = 60_000;
const puck = Date.parse("2026-11-16T23:00:00Z");
const starts = puck - 30 * MINUTE;
const host = { id: "host", name: "Host" };
const guest = { id: "guest", name: "Guest" };
const outsider = { id: "other", name: "Other" };
const admin = { id: "admin", name: "Admin", isAdmin: true };
const players = ["C", "LW", "RW", "F", "C", "C", "D", "D", "D", "D", "D"].map((position, index) => ({
  id: String(index + 1), name: "Skater " + (index + 1), position, team: "VAN", opponent: "SEA",
}));
const slate = { date: "2026-11-16", firstGameAt: puck, games: [{ id: "42" }], players };

function setup(t, capacity = 2, filename = ":memory:") {
  let now = puck - 45 * MINUTE;
  const store = createDailyStore({ filename, clock: () => now });
  t.after(() => store.close());
  const create = (overrides) => store.createRoom({ actor: host, name: "Monday", capacity, slate, ...overrides });
  const roomId = create({ requestId: "first" }).id;
  return { store, roomId, create, at: (time) => { now = time; },
    join: (actor) => store.joinRoom({ roomId, actor }),
    bid: (actor, id, amount) => store.bid({ roomId, actor, playerId: String(id), amount }),
    view: (actor = host) => store.getRoom({ roomId, actor }) };
}

function hasCode(fn, code) { assert.throws(fn, { code }); }

test("practice starts immediately after puck drop, locks on its own clock, and scores the original slate", (t) => {
  const { store, create, at } = setup(t);
  const opened = puck + 7 * MINUTE;
  at(opened);
  const room = create({ mode: "practice", requestId: "practice" });
  const roomId = room.id;
  const view = () => store.getRoom({ roomId, actor: host });
  assert.equal(room.mode, "practice");
  assert.equal(room.phase, "auction");
  assert.equal(room.firstGameAt, new Date(puck).toISOString());
  assert.equal(room.auctionStartsAt, new Date(opened).toISOString());
  assert.equal(room.auctionEndsAt, new Date(opened + 30 * MINUTE).toISOString());
  assert.equal(store.getRoomDate(roomId, host), null);
  assert.equal(create({ mode: "practice", requestId: "practice" }).id, roomId);
  hasCode(() => create({ mode: "scheduled", requestId: "practice" }), "DAILY_CREATE_CONFLICT");
  hasCode(() => create({ mode: "unknown" }), "DAILY_ROOM_MODE");
  hasCode(() => create({ mode: "scheduled" }), "DAILY_ROOM_LOCKED");
  store.joinRoom({ roomId, actor: guest });
  store.bid({ roomId, actor: guest, playerId: "1", amount: 8 });
  assert.deepEqual(store.listWaitingDates(), []);
  assert.deepEqual(store.listBiddingDates(), []);
  store.voidWaitingDate(slate.date);
  store.syncRoomSchedule(roomId, null);
  store.syncBiddingSchedule(slate.date, null);
  assert.equal(view().phase, "auction");
  assert.ok(!store.listScoringRooms().some(entry => entry.id === roomId));
  store.updateScores({ roomId, pointsByPlayerId: { 1: 354 }, final: true });
  assert.equal(view().winners.length, 0);
  at(opened + 30 * MINUTE - 1);
  store.bid({ roomId, actor: guest, playerId: "2", amount: 5 });
  assert.equal(view().auctions[0].endsAt, room.auctionEndsAt);
  at(opened + 30 * MINUTE);
  assert.equal(view().phase, "locked");
  assert.equal(view().members[1].roster.length, 2);
  assert.deepEqual(store.listScoringRooms().find(entry => entry.id === roomId).slate, slate);
  hasCode(() => store.bid({ roomId, actor: host, playerId: "7", amount: 3 }), "DAILY_AUCTION_INACTIVE");
  store.updateScores({ roomId, pointsByPlayerId: { 1: 354, 2: 0 }, final: true });
  assert.equal(view().members[1].hockeyPoints, 3.54);
  assert.deepEqual(view().winners, [{ id: guest.id, name: guest.name, points: 4.31 }]);
});

test("separate scheduled and practice rooms survive an NHL clock change on the same date", (t) => {
  const { store, roomId, create, at, view } = setup(t);
  const practice = create({ mode: "practice", requestId: "room-two" });
  const revised = { ...slate, firstGameAt: puck + 10 * MINUTE, players: players.slice(2) };
  store.refreshWaitingSlate(revised);
  assert.equal(view().mode, "scheduled");
  assert.equal(view().auctionEndsAt, new Date(revised.firstGameAt).toISOString());
  at(puck - 30 * MINUTE);
  assert.deepEqual(store.listDueReminders().map(entry => entry.roomId), [roomId]);
  const detail = store.getRoom({ roomId: practice.id, actor: host });
  assert.equal(detail.auctionEndsAt, practice.auctionEndsAt);
  assert.equal(detail.firstGameAt, new Date(puck).toISOString());
  assert.equal(detail.availablePlayers.length, players.length);
  assert.equal(detail.phase, "auction");
});

test("lobby, membership, capacity, multiple rooms and retry-safe creates", (t) => {
  const { store, roomId, create, join, view, at } = setup(t);
  assert.equal(store.listRooms({ actor: guest })[0].joined, false);
  assert.equal(view().memberCount, 1);
  assert.equal(view(guest).joined, false, "spectators can view without joining");
  assert.equal(view(admin).canClose, true);
  assert.equal(join(guest).memberCount, 2);
  assert.equal(join(guest).memberCount, 2);
  hasCode(() => join(outsider), "DAILY_ROOM_FULL");
  assert.notEqual(create({ requestId: "second" }).id, roomId);
  assert.equal(store.listRooms({ actor: host }).filter((room) => room.joined).length, 2);
  assert.equal(create({ requestId: "first" }).id, roomId);
  hasCode(() => create({ requestId: "first", capacity: 3 }), "DAILY_CREATE_CONFLICT");
  hasCode(() => create({ name: "  " }), "DAILY_ROOM_NAME");
  hasCode(() => create({ capacity: 1.5 }), "DAILY_CAPACITY");
  at(puck);
  assert.equal(store.replayCreate({ actor: host, requestId: "first", name: "Monday", capacity: 2 }).id, roomId);
  hasCode(() => create({ requestId: "late" }), "DAILY_ROOM_LOCKED");
});

test("worst-case cap and position checks admit seven simultaneous binding bids", (t) => {
  const { bid, view, at } = setup(t);
  assert.deepEqual(view().bidLimits.F, { maxAmount: 94, reason: null });
  hasCode(() => bid(host, 1, 1), "DAILY_AUCTION_INACTIVE");
  at(starts);
  hasCode(() => bid(guest, 1, 1), "DAILY_MEMBERSHIP_REQUIRED");
  hasCode(() => bid(host, 1, 95), "DAILY_CAP_LIMIT");
  hasCode(() => bid(host, 1, "4"), "DAILY_BID_AMOUNT");
  hasCode(() => bid(host, 1, 1.5), "DAILY_BID_AMOUNT");
  hasCode(() => bid(host, 99, 1), "DAILY_INELIGIBLE_PLAYER");
  for (const id of [1, 2, 3, 4, 5]) bid(host, id, 1);
  assert.equal(view().bidLimits.F.maxAmount, 0);
  assert.equal(view().bidLimits.D.maxAmount, 94);
  hasCode(() => bid(host, 6, 1), "DAILY_ROSTER_LIMIT");
  for (const id of [7, 8]) bid(host, id, 1);
  hasCode(() => bid(host, 9, 1), "DAILY_ROSTER_LIMIT");
  assert.equal(view().auctions.length, 7);
  assert.equal(view().members[0].reserved, 7);
  assert.equal(view().bidLimits.D.maxAmount, 0);
  at(starts + 2 * MINUTE);
  assert.equal(view().members[0].roster.length, 7);
  assert.equal(view().members[0].remainingCap, 93);
  hasCode(() => bid(host, 9, 1), "DAILY_AUCTION_INACTIVE");
});

for (const mode of ["scheduled", "practice"]) {
  test(`${mode} auction locks only after every joined manager signs seven players, then awaits final scores`, t => {
    const opened = mode === "practice" ? puck + 75 * MINUTE : starts;
    let now = opened;
    const store = createDailyStore({ filename: ":memory:", clock: () => now });
    t.after(() => store.close());
    const guestPlayers = ["F", "F", "F", "D", "D", "F", "F"].map((position, index) => ({
      ...players[0], id: "guest-" + index, name: "Guest skater " + index, position,
    }));
    const fullSlate = { ...slate, players: [...players, ...guestPlayers] };
    const original = store.createRoom({ actor: host, name: "Early finish", capacity: 8, slate: fullSlate, mode });
    const roomId = original.id;
    store.joinRoom({ roomId, actor: guest });
    const bid = (actor, playerId, amount = 1) => store.bid({ roomId, actor, playerId, amount });
    const view = () => store.getRoom({ roomId, actor: host });
    for (const id of ["1", "2", "3", "4", "5", "7", "8"]) bid(host, id, 2);
    bid(guest, "1"); // This reservation loses, so seven bids must not become a full roster.
    for (const player of guestPlayers.slice(0, 6)) bid(guest, player.id);
    assert.equal(view().phase, "auction");
    assert.deepEqual(view().members.map(member => member.roster.length), [0, 0]);
    assert.deepEqual(store.listScoringRooms(), []);
    now += 2 * MINUTE;
    assert.deepEqual(view().members.map(member => member.roster.length), [7, 6]);
    assert.equal(view().phase, "auction");
    assert.deepEqual(store.listScoringRooms(), []);
    bid(guest, guestPlayers[6].id);
    now += 2 * MINUTE - 1;
    assert.equal(view().phase, "auction");
    now++;
    const locked = view();
    assert.equal(locked.phase, "locked");
    assert.equal(locked.auctionEndsAt, new Date(now).toISOString());
    assert.equal(locked.auctionStartsAt, original.auctionStartsAt);
    assert.equal(locked.firstGameAt, original.firstGameAt);
    assert.deepEqual(locked.members.map(member => member.roster.length), [7, 7]);
    assert.deepEqual(locked.members.map(member => member.remainingCap), [86, 93]);
    assert.deepEqual(locked.auctions, []);
    assert.deepEqual(locked.availablePlayers, []);
    assert.equal(locked.bidLimits.F.maxAmount, 0);
    assert.equal(store.listRooms({ actor: outsider })[0].phase, "locked");
    assert.equal(store.listScoringRooms()[0].id, roomId);
    hasCode(() => store.joinRoom({ roomId, actor: outsider }), "DAILY_ROOM_LOCKED");
    hasCode(() => bid(host, "9"), "DAILY_AUCTION_INACTIVE");
    hasCode(() => store.getRoomDate(roomId, host), "DAILY_AUCTION_INACTIVE");
    hasCode(() => store.closeRoom({ roomId, actor: host }), "DAILY_CLOSE_FORBIDDEN");
    store.syncRoomSchedule(roomId, { ...slate, firstGameAt: puck + 60 * MINUTE });
    store.syncBiddingSchedule(slate.date, null);
    assert.equal(view().phase, "locked", "schedule refresh cannot reopen or void a completed auction");
    assert.equal(view().firstGameAt, original.firstGameAt);
    const pointsByPlayerId = Object.fromEntries(locked.members.flatMap(member =>
      member.roster.map(player => [player.id, member.id === host.id ? 100 : 200])));
    store.updateScores({ roomId, pointsByPlayerId, final: false });
    assert.equal(view().phase, "locked");
    assert.deepEqual(view().winners, []);
    store.updateScores({ roomId, pointsByPlayerId, final: true });
    assert.equal(view().phase, "finished");
    assert.equal(view().members[1].hockeyPoints, 14);
    assert.deepEqual(view().winners, [{ ...guest, points: 17.26 }]);
    assert.deepEqual(store.listScoringRooms(), []);
    assert.equal(store.closeRoom({ roomId, actor: host }).phase, "closed");
  });
}

test("defense flex limits and cap include all bids even when another manager bid more", (t) => {
  const { bid, at, join, view } = setup(t);
  join(guest);
  at(starts);
  for (const id of [7, 8, 9, 10]) bid(host, id, 1);
  hasCode(() => bid(host, 11, 1), "DAILY_ROSTER_LIMIT");
  bid(guest, 7, 94);
  hasCode(() => bid(guest, 8, 2), "DAILY_CAP_LIMIT");
  bid(guest, 8, 1);
  const detail = view();
  assert.equal(detail.members[0].reserved, 4);
  assert.equal(detail.members[1].reserved, null);
  assert.equal(detail.members[1].availableCap, null);
  assert.equal(detail.auctions[0].ownBid, 1);
  assert.equal(detail.auctions[0].bidCount, 2);
  assert.doesNotMatch(JSON.stringify(detail), /"amount"|leader|"bids"/);
  assert.deepEqual(detail.auctions[0], {
    ...players[6], bidCount: 2, endsAt: new Date(starts + 2 * MINUTE).toISOString(), ownBid: 1,
  });
  const repeated = bid(guest, 7, 94);
  assert.equal(repeated.auctions[0].bidCount, 2);
  hasCode(() => bid(guest, 7, 93), "DAILY_BID_BINDING");
  at(starts + 2 * MINUTE);
  assert.equal(view().members[0].reserved, 0);
  assert.equal(view(guest).members[1].remainingCap, 6);
  assert.equal(view().members[0].roster.some((row) => row.id === "8"), true, "earlier bid wins a tie");
  assert.equal(view().availablePlayers.some((row) => row.id === "8"), false);
  hasCode(() => bid(host, 7, 1 + 1), "DAILY_PLAYER_SIGNED");
});

test("horn truncates auctions; partial rosters, shared wins and commissioner closure", (t) => {
  const { store, roomId, at, join, bid, view } = setup(t);
  join(guest);
  hasCode(() => store.closeRoom({ roomId, actor: host }), "DAILY_CLOSE_FORBIDDEN");
  at(puck - 200);
  bid(host, 1, 10);
  bid(guest, 7, 10);
  assert.equal(view().auctions[0].endsAt, new Date(puck).toISOString());
  at(puck);
  hasCode(() => bid(host, 2, 2), "DAILY_AUCTION_INACTIVE");
  assert.equal(view().phase, "locked");
  assert.deepEqual(store.listScoringRooms()[0].playerIds, ["1", "7"]);
  assert.deepEqual(store.listScoringRooms()[0].slate, slate);
  store.updateScores({ roomId, pointsByPlayerId: { 1: -199 }, final: false });
  assert.equal(view().members[0].points, -1.99);
  assert.throws(() => store.updateScores({ roomId, pointsByPlayerId: { 1: 499 }, final: true }));
  assert.equal(view().members[0].points, -1.99);
  store.updateScores({ roomId, pointsByPlayerId: { 1: 201, 7: 201 }, final: true });
  assert.equal(view().winners.length, 2);
  assert.deepEqual(view().members.map((team) => team.hockeyPoints), [2.01, 2.01]);
  assert.deepEqual(view().members.map((team) => team.points), [2.46, 2.46]);
  assert.equal(view().phase, "finished");
  assert.deepEqual(store.listScoringRooms(), []);
  store.updateScores({ roomId, pointsByPlayerId: { 1: 5 }, final: true });
  assert.equal(view().members[0].points, 2.46);
  assert.equal(store.listRooms({ actor: outsider })[0].winners.length, 2);
  hasCode(() => store.closeRoom({ roomId, actor: guest }), "DAILY_CLOSE_FORBIDDEN");
  assert.equal(store.closeRoom({ roomId, actor: host }).phase, "closed");
  hasCode(() => view(), "DAILY_ROOM_CLOSED");
  assert.equal(store.listRooms().length, 0);
});

test("reminders and changed schedule respect the ten-minute window and each membership", (t) => {
  const { store, roomId, at, join, bid, view } = setup(t);
  join(guest);
  at(starts - 10 * MINUTE - 1);
  assert.deepEqual(store.listDueReminders(), []);
  at(starts - 10 * MINUTE);
  assert.equal(store.listDueReminders().length, 2);
  const reminder = store.listReminders({ actor: host })[0];
  store.markReminderSent(reminder);
  assert.equal(store.listDueReminders().length, 1);
  assert.equal(store.listReminders({ actor: host }).length, 1, "background delivery preserves the in-app reminder");
  assert.deepEqual(store.listReminders({ actor: outsider }), []);
  const revised = { ...slate, firstGameAt: puck + MINUTE, players: players.slice(1) };
  assert.deepEqual(store.listWaitingDates(), [slate.date]);
  store.refreshWaitingSlate(revised);
  assert.deepEqual(store.listDueReminders(), []);
  assert.equal(view().availablePlayers.length, players.length - 1);
  at(starts - 9 * MINUTE);
  store.markReminderSent(reminder);
  assert.equal(store.listDueReminders().length, 2);
  at(starts + MINUTE);
  assert.deepEqual(store.listDueReminders(), []);
  assert.deepEqual(store.listWaitingDates(), [slate.date], "a restarted room can refresh an unbid slate after opening");
  store.refreshWaitingSlate(slate);
  assert.equal(view().firstGameAt, new Date(slate.firstGameAt).toISOString());
  bid(host, 1, 17);
  assert.deepEqual(store.listWaitingDates(), []);
  store.refreshWaitingSlate(revised);
  assert.equal(view().auctions[0].ownBid, 17);
  const closed = store.closeRoom({ roomId, actor: admin });
  assert.equal(closed.phase, "closed");
  assert.deepEqual(closed.members, []);
  assert.deepEqual(closed.auctions, []);
  hasCode(() => view(guest), "DAILY_ROOM_CLOSED");
});

test("cancelled waiting slate announces no winner and can be closed", (t) => {
  const { store, roomId, at, view } = setup(t);
  store.voidWaitingDate(slate.date);
  assert.equal(view().phase, "void");
  assert.equal(view().canClose, true);
  at(puck);
  assert.deepEqual(view().winners, []);
  assert.equal(store.listScoringRooms().length, 0);
  assert.equal(store.closeRoom({ roomId, actor: host }).phase, "closed");
});

test("all games officially cancelled after bidding void the locked room without winners", (t) => {
  const { store, roomId, at, bid, view } = setup(t);
  at(starts);
  bid(host, 1, 37);
  const voidReport = { roomId, final: true, voided: true, pointsByPlayerId: {} };
  store.updateScores(voidReport);
  assert.equal(view().phase, "auction");
  at(puck);
  store.updateScores({ ...voidReport, final: false });
  assert.equal(view().phase, "locked");
  store.updateScores(voidReport);
  assert.equal(view().phase, "void");
  assert.equal(view().canClose, true);
  assert.equal(view().members[0].points, 0);
  assert.deepEqual(view().winners, []);
  assert.equal(store.listScoringRooms().length, 0);
});

test("a new first game pauses or shortens bidding, preserving existing bids, signs and player eligibility", (t) => {
  const { store, roomId, at, bid, view } = setup(t);
  assert.equal(store.getRoomDate(roomId, host), slate.date);
  hasCode(() => store.getRoomDate(roomId, admin), "DAILY_MEMBERSHIP_REQUIRED");
  hasCode(() => store.getRoomDate(roomId, outsider), "DAILY_MEMBERSHIP_REQUIRED");
  at(starts);
  bid(host, 1, 19);
  const originalEnd = view().auctions[0].endsAt;
  assert.deepEqual(store.listBiddingDates(), [slate.date]);
  const delayed = { date: slate.date, firstGameAt: puck + 20 * MINUTE, games: [{ id: "other-first" }] };
  store.syncBiddingSchedule(slate.date, delayed);
  assert.equal(view().phase, "waiting");
  assert.equal(view().auctions[0].ownBid, 19);
  assert.equal(view().auctions[0].endsAt, originalEnd);
  hasCode(() => bid(host, 2, 2), "DAILY_AUCTION_INACTIVE");
  at(starts + 2 * MINUTE);
  assert.equal(view().members[0].roster[0].id, "1");
  at(starts + 20 * MINUTE);
  bid(host, 2, 12);
  const earlyTime = starts + 20 * MINUTE + 10_000;
  store.syncRoomSchedule(roomId, { ...delayed, firstGameAt: earlyTime });
  assert.equal(view().auctions[0].endsAt, new Date(earlyTime).toISOString());
  assert.equal(view().availablePlayers.length, slate.players.length - 2);
  at(earlyTime);
  assert.equal(view().members[0].roster.length, 2);
  assert.deepEqual(view().members[0].roster.map((entry) => entry.price), [19, 12]);
  assert.deepEqual(store.listBiddingDates(), []);
  store.syncRoomSchedule(roomId, delayed);
  store.syncBiddingSchedule(slate.date, delayed);
  assert.equal(view().phase, "locked");
  hasCode(() => store.getRoomDate(roomId, host), "DAILY_AUCTION_INACTIVE");
  assert.equal(view().firstGameAt, new Date(earlyTime).toISOString());
});

test("schedule validation for an incoming bid handles unbid rooms and a fully cancelled active auction", (t) => {
  const { store, roomId, at, bid, view } = setup(t);
  const later = { date: slate.date, firstGameAt: puck + MINUTE };
  at(starts);
  store.syncRoomSchedule(roomId, later);
  hasCode(() => bid(host, 2, 2), "DAILY_AUCTION_INACTIVE");
  at(starts + MINUTE);
  bid(host, 2, 2);
  store.syncBiddingSchedule(slate.date, null);
  assert.equal(view().phase, "void");
  assert.deepEqual(view().auctions, []);
  assert.equal(view().members[0].reserved, 0);
  at(puck + 2 * MINUTE);
  assert.deepEqual(view().members[0].roster, []);
  assert.deepEqual(view().winners, []);
});

function fileFixture(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, ".hundo-daily-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "daily.sqlite");
}

test("opening for reads cannot create a new sidecar or initialize an empty one", (t) => {
  const filename = fileFixture(t);
  assert.throws(() => createDailyStore({ filename, existingOnly: true }));
  assert.equal(fs.existsSync(filename), false);
  fs.writeFileSync(filename, "");
  assert.throws(() => createDailyStore({ filename, existingOnly: true }), /initialized/);
  assert.equal(fs.statSync(filename).size, 0);
});

test("a manager's rooms have independent pools, reservations and results", (t) => {
  const { store, roomId, at, bid, create, join } = setup(t);
  const parallelRoom = create({ name: "Tuesday", requestId: "parallel" }).id;
  join(guest);
  at(starts);
  bid(host, 1, 94);
  store.bid({ actor: host, roomId: parallelRoom, playerId: "1", amount: 75 });
  bid(guest, 2, 2);
  at(puck);
  store.updateScores({ roomId, pointsByPlayerId: { 1: 225, 2: 124 }, final: true });
  const first = store.getRoom({ actor: host, roomId });
  const second = store.getRoom({ actor: host, roomId: parallelRoom });
  assert.deepEqual(first.winners, [{ id: host.id, name: host.name, points: 2.28 }]);
  assert.equal(second.phase, "locked");
  assert.deepEqual(second.winners, []);
  assert.equal(first.members[0].roster[0].price, 94);
  assert.equal(second.members[0].roster[0].price, 75);
});

test("refuses to initialize inside an existing season database", (t) => {
  const filename = fileFixture(t);
  const season = new DatabaseSync(filename);
  season.exec("CREATE TABLE season_data (name TEXT); INSERT INTO season_data VALUES ('untouched')");
  assert.throws(() => createDailyStore({ filename }), /dedicated database/);
  assert.deepEqual(season.prepare("SELECT name FROM sqlite_schema").all().map((r) => r.name), ["season_data"]);
  assert.equal(season.prepare("SELECT name FROM season_data").get().name, "untouched");
  season.close();
});

test("restarts settle expired lots with no hidden writes on GET; admin can close at any time", (t) => {
  const filename = fileFixture(t);
  const original = createDailyStore({ filename, clock: () => starts });
  const { id: roomId } = original.createRoom({ actor: host, name: "Persistent", capacity: 8, slate });
  original.bid({ roomId, actor: host, playerId: "7", amount: 50 });
  original.close();
  const db = new DatabaseSync(filename);
  // The first Daily release wrote room metadata without an explicit mode.
  db.prepare("UPDATE rooms SET info=json_remove(info,'$.mode') WHERE id=?").run(roomId);
  const versionBeforeOpen = db.prepare("PRAGMA data_version").get().data_version;
  const store = createDailyStore({ filename, clock: () => puck, existingOnly: true });
  try {
    const version = () => db.prepare("PRAGMA data_version").get().data_version;
    const beforeReads = version();
    assert.equal(beforeReads, versionBeforeOpen);
    assert.equal(store.getRoom({ roomId, actor: host }).members[0].roster[0].price, 50);
    assert.equal(store.listRooms()[0].phase, "locked");
    assert.equal(store.listRooms()[0].mode, "scheduled");
    assert.equal(store.listRooms()[0].auctionEndsAt, new Date(puck).toISOString());
    assert.deepEqual(store.listReminders({ actor: host }), []);
    assert.equal(version(), beforeReads);
    store.closeRoom({ roomId, actor: admin });
    assert.equal(store.listScoringRooms().length, 0);
    assert.equal(store.listRooms().length, 0);
  } finally {
    store.close();
    db.close();
  }
});

test("early roster completion survives restart without writes from lobby, detail or scoring reads", t => {
  const filename = fileFixture(t);
  const original = createDailyStore({ filename, clock: () => starts });
  const { id: roomId } = original.createRoom({ actor: host, name: "Full roster", capacity: 8, slate });
  for (const playerId of ["1", "2", "3", "4", "5", "7", "8"]) {
    original.bid({ roomId, actor: host, playerId, amount: 1 });
  }
  original.close();
  const db = new DatabaseSync(filename);
  const stored = db.prepare("SELECT * FROM rooms").all();
  const version = db.prepare("PRAGMA data_version").get().data_version;
  const reopened = createDailyStore({ filename, clock: () => starts + 2 * MINUTE, existingOnly: true });
  try {
    assert.equal(reopened.getRoom({ roomId, actor: host }).phase, "locked");
    assert.equal(reopened.listRooms()[0].auctionEndsAt, new Date(starts + 2 * MINUTE).toISOString());
    assert.equal(reopened.listScoringRooms()[0].id, roomId);
    assert.deepEqual(db.prepare("SELECT * FROM rooms").all(), stored);
    assert.equal(db.prepare("PRAGMA data_version").get().data_version, version);
  } finally {
    reopened.close();
    db.close();
  }
});

test("two independent connections racing for the last seat admit one manager", async (t) => {
  const filename = fileFixture(t);
  const store = createDailyStore({ filename, clock: () => starts });
  try {
    const { id: roomId } = store.createRoom({ actor: host, name: "Race", capacity: 2, slate });
    const barrier = new SharedArrayBuffer(4);
    function contender(actor) {
      const worker = new Worker(`
        const { parentPort, workerData: p } = require("node:worker_threads");
        const { createDailyStore } = require(p.modulePath);
        const store = createDailyStore({ filename: p.filename, clock: () => p.now });
        parentPort.postMessage("ready");
        Atomics.wait(new Int32Array(p.barrier),0,0);
        try { store.joinRoom({ roomId:p.roomId, actor:p.actor }); parentPort.postMessage("joined"); }
        catch (error) {parentPort.postMessage(error.code);}
        finally {store.close();}
      `, { eval: true, workerData: { barrier, now: starts, actor, roomId, filename, modulePath: require.resolve("../../src/daily/createDailyStore") } });
      const ready = new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
      const done = new Promise((resolve, reject) => {
        worker.on("message", (result) => { if (result !== "ready") resolve(result); });
        worker.once("error", reject);
      });
      const exited = new Promise((resolve) => worker.once("exit", resolve));
      return { ready, done, exited };
    }
    const first = contender(guest);
    const second = contender(outsider);
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0);
    assert.deepEqual((await Promise.all([first.done, second.done])).sort(), ["DAILY_ROOM_FULL", "joined"]);
    await Promise.all([first.exited, second.exited]);
    assert.equal(store.getRoom({ roomId, actor: host }).members.length, 2);
  } finally { store.close(); }
});
