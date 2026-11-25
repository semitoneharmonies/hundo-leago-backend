"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createDailyStore } = require("../../src/daily/createDailyStore");
const { createDailyService } = require("../../src/daily/createDailyService");
const { createDailyChatPublisher } = require("../../src/daily/dailyChat");

const host = { id: "host", name: "Host" }, spectator = { id: "watcher", name: "Watcher" };
const admin = { id: "admin", name: "Admin", isAdmin: true };
const minute = 60_000, firstGameAt = Date.parse("2026-11-25T02:00:00Z");
const slate = { date: "2026-11-24", firstGameAt, players: [
  { id: "1", name: "Skater", team: "VAN", position: "F", opponent: "SEA" },
  { id: "2", name: "Defender", team: "SEA", position: "D", opponent: "VAN" },
] };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, ".daily-spectators-"));
  const filename = path.join(directory, "daily.sqlite");
  let now = firstGameAt - 60 * minute, store = createDailyStore({ filename, clock: () => now });
  const create = (extra = {}) => store.createRoom({ actor: host, name: "Spectator room", capacity: 2, slate, ...extra });
  const privateRoom = create({ requestId: "private" });
  const openRoom = create({ requestId: "open", allowSpectatorChat: true });
  const inspect = new DatabaseSync(filename, { readOnly: true });
  const saved = () => JSON.stringify({ rooms: inspect.prepare("SELECT * FROM rooms ORDER BY id").all(),
    slates: inspect.prepare("SELECT * FROM slates ORDER BY id").all() });
  t.after(() => { inspect.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { privateRoom, openRoom, filename, create, saved, get store() { return store; },
    at(value) { now = value; },
    reopen() { store.close(); store = createDailyStore({ filename, clock: () => now, existingOnly: true }); },
    post(roomId, actor, text, requestId = "message-1") { return store.postChat({ roomId, actor, input: { text, username: "Fake" }, requestId }); },
  };
}

test("spectators read waiting, live and scoring rooms without joining, writes or sealed bid disclosure", t => {
  const f = fixture(t), roomId = f.privateRoom.id;
  assert.throws(() => f.store.getRoom({ roomId }), { code: "DAILY_SIGN_IN_REQUIRED" });
  const before = f.saved();
  const waiting = f.store.getRoom({ roomId, actor: spectator });
  assert.equal(waiting.phase, "waiting");
  assert.equal(waiting.joined, false);
  assert.equal(waiting.memberCount, 1);
  assert.equal(waiting.allowSpectatorChat, false);
  assert.equal(f.saved(), before);
  f.at(firstGameAt - 30 * minute);
  f.store.bid({ roomId, actor: host, playerId: "1", amount: 18 });
  const activeBefore = f.saved(), live = f.store.getRoom({ roomId, actor: spectator });
  assert.equal(live.phase, "auction");
  assert.equal(live.auctions[0].ownBid, null);
  assert.equal(live.auctions[0].bidCount, 1);
  assert.equal(live.members[0].reserved, null);
  assert.equal(live.members[0].availableCap, null);
  assert.equal(live.bidLimits.F.maxAmount, 0);
  assert.equal(live.chat, undefined);
  assert.equal(live.members.length, 1);
  assert.throws(() => f.store.bid({ roomId, actor: spectator, playerId: "2", amount: 1 }), { code: "DAILY_MEMBERSHIP_REQUIRED" });
  assert.throws(() => f.store.closeRoom({ roomId, actor: spectator }), { code: "DAILY_CLOSE_FORBIDDEN" });
  assert.equal(f.saved(), activeBefore);
  assert.equal(f.store.getRoom({ roomId, actor: host }).auctions[0].ownBid, 18);
  f.at(firstGameAt);
  const lockedBefore = f.saved(), locked = f.store.getRoom({ roomId, actor: spectator });
  assert.equal(locked.phase, "locked");
  assert.equal(locked.members[0].roster[0].price, 18);
  assert.equal(f.saved(), lockedBefore);
});

test("spectator chat is opt-in, uses authenticated names, stays isolated and becomes read-only at finalization", t => {
  const f = fixture(t), roomId = f.openRoom.id;
  assert.equal(f.openRoom.allowSpectatorChat, true);
  assert.equal(f.store.getChat({ roomId, actor: spectator }).canPost, true);
  const message = f.post(roomId, host, "Welcome").messages[0];
  const chat = f.post(roomId, { ...spectator, name: "Current display name" }, "Watching the auction");
  assert.equal(chat.messages[1].username, "Current display name");
  assert.equal(chat.messages[1].userId, spectator.id);
  assert.equal(f.store.getRoom({ roomId, actor: spectator }).memberCount, 1);
  assert.equal(f.store.getRoom({ roomId, actor: spectator }).chat, undefined);
  const react = target => f.store.reactToChat({ roomId: target, actor: spectator, input: { messageId: message.id, reaction: "like", userId: "fake" } });
  assert.deepEqual(react(roomId).messages[0].reactions, [{ userId: spectator.id, username: spectator.name, reaction: "like" }]);
  assert.throws(() => f.store.getChat({ roomId: f.privateRoom.id, actor: spectator }), { code: "DAILY_MEMBERSHIP_REQUIRED" });
  assert.throws(() => f.post(f.privateRoom.id, spectator, "No entry"), { code: "DAILY_MEMBERSHIP_REQUIRED" });
  assert.throws(() => react(f.privateRoom.id), { code: "DAILY_MEMBERSHIP_REQUIRED" });
  assert.throws(() => f.store.getChat({ roomId, actor: null }), { code: "DAILY_SIGN_IN_REQUIRED" });
  f.reopen();
  assert.equal(f.store.getChat({ roomId, actor: spectator }).messages.length, 2);
  f.at(firstGameAt);
  f.post(roomId, spectator, "Stats are arriving", "message-2");
  f.store.updateScores({ roomId, pointsByPlayerId: {}, final: true });
  assert.equal(f.store.getChat({ roomId, actor: spectator }).readOnly, true);
  assert.equal(f.store.getChat({ roomId, actor: spectator }).canPost, false);
  assert.throws(() => f.post(roomId, spectator, "After final", "message-3"), { code: "DAILY_CHAT_READ_ONLY" });
  assert.throws(() => react(roomId), { code: "DAILY_CHAT_READ_ONLY" });
  f.store.closeRoom({ roomId, actor: host });
  assert.equal(f.store.getChat({ roomId, actor: spectator }).messages.length, 3);
  assert.throws(() => f.store.getRoom({ roomId, actor: spectator }), { code: "DAILY_ROOM_CLOSED" });
});

test("realtime authorizes spectators only for opted-in rooms and rechecks session revocation", t => {
  const f = fixture(t), events = [];
  let revoked = false;
  const sockets = new Map([host, spectator, admin].map(actor => [actor.id,
    { handshake: actor, emit: (name, payload) => events.push({ userId: actor.id, name, payload }) }]));
  const publish = createDailyChatPublisher({ getIo: () => ({ sockets: { sockets } }),
    authorizeHandshake: actor => {
      if (revoked && actor.id === spectator.id) throw Error("revoked");
      return { userId: actor.id };
    }, canRead: (id, userId) => f.store.canReadChat(id, userId) });
  publish(f.privateRoom.id);
  assert.deepEqual(events.map(event => event.userId), [host.id]);
  events.length = 0;
  publish(f.openRoom.id);
  assert.deepEqual(events.map(event => event.userId), [host.id, spectator.id, admin.id]);
  assert.deepEqual(events[1], { userId: spectator.id, name: "daily.chat.changed", payload: { roomId: f.openRoom.id } });
  events.length = 0; revoked = true; publish(f.openRoom.id);
  assert.deepEqual(events.map(event => event.userId), [host.id, admin.id]);
  assert.throws(() => f.store.canReadChat(f.openRoom.id, ""), { code: "DAILY_MEMBERSHIP_REQUIRED" });
});

test("chat choice is strictly validated and bound to creation retries; old rooms stay private without reads rewriting them", t => {
  const f = fixture(t);
  const before = f.saved();
  for (const value of [null, 0, 1, "true", [], {}]) {
    assert.throws(() => f.create({ requestId: "invalid", allowSpectatorChat: value }), { code: "DAILY_SPECTATOR_CHAT_INVALID" });
  }
  assert.equal(f.saved(), before);
  assert.equal(f.create({ requestId: "open", allowSpectatorChat: true }).id, f.openRoom.id);
  assert.throws(() => f.create({ requestId: "open", allowSpectatorChat: false }), { code: "DAILY_CREATE_CONFLICT" });
  assert.throws(() => f.create({ requestId: "private", allowSpectatorChat: true }), { code: "DAILY_CREATE_CONFLICT" });
  const writer = new DatabaseSync(f.filename);
  const info = JSON.parse(writer.prepare("SELECT info FROM rooms WHERE id=?").get(f.privateRoom.id).info);
  delete info.allowSpectatorChat;
  writer.prepare("UPDATE rooms SET info=? WHERE id=?").run(JSON.stringify(info), f.privateRoom.id);
  writer.close(); f.reopen();
  const legacy = f.saved();
  assert.equal(f.store.getRoom({ roomId: f.privateRoom.id, actor: spectator }).allowSpectatorChat, false);
  assert.throws(() => f.store.getChat({ roomId: f.privateRoom.id, actor: spectator }), { code: "DAILY_MEMBERSHIP_REQUIRED" });
  assert.equal(f.create({ requestId: "private" }).id, f.privateRoom.id);
  assert.equal(f.saved(), legacy);
});

test("invalid spectator-chat creation fails before any provider read or store initialization", async () => {
  let reads = 0, opens = 0;
  const daily = createDailyService({ filename: ":memory:",
    feed: { getSchedule() { reads++; }, getSlate() { reads++; } },
    openStore() { opens++; throw Error("must not open"); } });
  for (const allowSpectatorChat of [null, "false", 1]) {
    await assert.rejects(daily.create({ actor: host, input: { name: "No writes", capacity: 2, allowSpectatorChat } }),
      { code: "DAILY_SPECTATOR_CHAT_INVALID" });
  }
  assert.equal(reads, 0); assert.equal(opens, 0); daily.close();
});
