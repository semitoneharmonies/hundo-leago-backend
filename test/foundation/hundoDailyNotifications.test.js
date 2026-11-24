"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createDailyStore } = require("../../src/daily/createDailyStore");
const { createDailyService } = require("../../src/daily/createDailyService");
const { dailyNotices, DEFAULT_DAILY_PREFERENCES } = require("../../src/daily/dailyNotifications");
const { createDailyNotificationInbox } = require("../../src/daily/createDailyNotificationInbox");
const { createSqliteNotificationRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteNotificationRepository");
const minute = 60000, start = Date.parse("2026-11-23T20:30:00Z");
const host = { id: "10000000-0000-4000-8000-000000000001", name: "Host" }, guest = { id: "10000000-0000-4000-8000-000000000002", name: "Guest" };
const slate = { date: "2026-11-23", firstGameAt: start + 4 * 60 * minute, players: [{ id: "p", name: "Player", position: "F", team: "VAN", opponent: "SEA" }] };

test("all Daily alert boundaries, signed-player guard, early finish and final-only winners", () => {
  const room = { id: "r", name: "Room", capacity: 2, commissionerId: host.id, members: [host, guest],
    mode: "scheduled", date: slate.date, firstGameAt: slate.firstGameAt, scheduledStartsAt: start, lots: [], scores: {}, winners: [] };
  const at = time => dailyNotices(room, time);
  assert.equal(at(start - 10 * minute - 1).length, 0);
  assert.deepEqual(at(start - 10 * minute).map(n => n.category), ["reminder", "reminder"]);
  assert.deepEqual(at(start).map(n => n.category), ["start", "start"]);
  assert.equal(at(start + 5 * minute).length, 0);
  assert.deepEqual(at(start + 15 * minute).map(n => n.category), ["idle", "idle"]);
  room.lots.push({ endsAt: start + minute, bids: [{ userId: host.id, amount: 1 }] });
  assert.deepEqual(at(start + 15 * minute + 1).map(n => n.userId), [guest.id]);
  assert.deepEqual(at(start + 16 * minute), [], "The 15-minute reminder is not sent late");
  assert.ok(at(start + 30 * minute).every(n => n.category === "end"));
  assert.ok(!at(start + 30 * minute).some(n => n.category === "win"));
  room.finished = true; room.finishedAt = start + 31 * minute; room.winners = [{ ...host, points: 3 }];
  assert.equal(at(room.finishedAt).filter(n => n.category === "win").length, 1);
  room.closed = true;
  assert.deepEqual(at(room.finishedAt).map(n => n.category), ["win"]);
  room.closed = false; room.finished = false; room.members = [host];
  room.lots = Array.from({ length: 7 }, () => ({ endsAt: start + 4 * minute, bids: [{ userId: host.id, amount: 1 }] }));
  assert.deepEqual(at(start + 4 * minute).map(n => n.category), ["end"]);
});

test("Daily preferences and delivery receipts persist independently, GET does not create tables", t => {
  const dir = fs.mkdtempSync(path.join(__dirname, ".daily-notifications-"));
  const filename = path.join(dir, "daily.sqlite"); let now = start - 11 * minute;
  let store = createDailyStore({ filename, clock: () => now });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.createRoom({ actor: host, name: "Room", capacity: 2, slate, scheduledStartsAt: start });
  const db = new DatabaseSync(filename, { readOnly: true });
  assert.deepEqual(store.getNotificationSettings({ actor: host }).preferences, DEFAULT_DAILY_PREFERENCES);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='daily_notification_preferences'").get().n, 0); db.close();
  assert.throws(() => store.updateNotificationSettings({ actor: host, input: { preferences: { enabled: true } } }), { code: "DAILY_NOTIFICATION_PREFERENCES" });
  now = start - 10 * minute;
  const notice = store.listDuePushNotifications()[0];
  store.markPushNotificationSent(notice);
  assert.equal(store.listDueNotifications().length, 1, "push does not mark inbox delivered");
  store.markNotificationSent(notice); store.close();
  store = createDailyStore({ filename, clock: () => now, existingOnly: true });
  assert.deepEqual(store.listDuePushNotifications(), []);
  assert.deepEqual(store.listDueNotifications(), []);
  now = start;
  store.updateNotificationSettings({ actor: host, input: { preferences: { ...DEFAULT_DAILY_PREFERENCES, enabled: false } } });
  assert.deepEqual(store.listDuePushNotifications(), []);
  assert.equal(store.listDueNotifications().length, 1, "muting Daily only affects push");
  store.close(); store = createDailyStore({ filename, clock: () => now, existingOnly: true });
  assert.equal(store.getNotificationSettings({ actor: host }).preferences.enabled, false);
  assert.equal(store.getNotificationSettings({ actor: guest }).preferences.enabled, true);
});

test("due push does not wait for an earlier blocked NHL refresh", async t => {
  let now = start - 11 * minute, blocked = false, release, entered;
  const started = new Promise(resolve => { entered = resolve; }); const pushed = [];
  const service = createDailyService({ filename: ":memory:", clock: () => now,
    feed: { getSchedule: async () => slate, getSlate: async () => {
      if (!blocked) return slate; entered(); return new Promise(resolve => { release = resolve; });
    }, getScores: async () => ({ final: false, pointsByPlayerId: {} }) }, notify: () => {},
    subscriptions: () => [{}], push: { available: true, send: async (_device, payload) => pushed.push(payload) } });
  t.after(() => service.close());
  await service.create({ actor: host, input: { name: "Room", capacity: 2, slateDate: slate.date, auctionStartsAt: new Date(start).toISOString() } });
  blocked = true; const first = service.runMaintenance(); await started;
  now = start - 10 * minute; const second = service.runMaintenance();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pushed.length, 1); assert.match(pushed[0].title, /starts soon/);
  assert.ok(pushed[0].tag.length <= 100);
  blocked = false; release(slate); await Promise.all([first, second]); await service.runMaintenance(); assert.equal(pushed.length, 1);
});

test("Daily and Leago inbox reads are owner-scoped and mark-all cannot cross sections", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.transaction = operation => (...args) => { db.exec("BEGIN"); try { const result = operation(...args); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  db.exec(`CREATE TABLE notifications(id TEXT PRIMARY KEY,user_id TEXT,league_id TEXT,event_type TEXT,message_data_json TEXT,related_feature TEXT,related_record_id TEXT,delivery_status TEXT,created_at_ms INTEGER,read_at_ms INTEGER,delivered_at_ms INTEGER,version INTEGER);
    CREATE TABLE league_invitations(id TEXT,league_id TEXT,invited_user_id TEXT,status TEXT,expires_at_ms INTEGER); CREATE TABLE leagues(id TEXT,status TEXT);`);
  const ids = [1,2,3].map(n => `20000000-0000-4000-8000-00000000000${n}`);
  const insert = db.prepare("INSERT INTO notifications VALUES(?,?,NULL,?,'{}',?,'r','delivered',1,NULL,1,1)");
  insert.run(ids[0], host.id, "daily_room_won", "daily"); insert.run(ids[1], host.id, "trade_received", "trades"); insert.run(ids[2], guest.id, "daily_room_won", "daily");
  const daily = createDailyNotificationInbox({ database: db, clock: () => 3 }); const leago = createSqliteNotificationRepository({ database: db });
  assert.deepEqual(daily.list({ actor: host }).notifications.map(n => n.id), [ids[0]]);
  assert.deepEqual(leago.listPage({ userId: host.id, limit: 20 }).rows.map(n => n.id), [ids[1]]);
  assert.throws(() => daily.read({ actor: host, input: { ids: [ids[1]] } }), { code: "DAILY_NOTIFICATION_MISSING" });
  assert.throws(() => daily.read({ actor: host, input: { ids: [ids[2]] } }), { code: "DAILY_NOTIFICATION_MISSING" });
  leago.markAllRead({ userId: host.id, readAtMs: 2 }); assert.equal(daily.list({ actor: host }).unreadCount, 1);
  assert.equal(daily.read({ actor: host, input: { all: true } }).changedCount, 1);
  assert.equal(daily.list({ actor: guest }).unreadCount, 1);
});

test("retrying a failed device does not resend to a successful device", async t => {
  let now = start - 11 * minute; const attempts = { good: 0, retry: 0 };
  const service = createDailyService({ filename: ":memory:", clock: () => now,
    feed: { getSchedule: async () => slate, getSlate: async () => slate, getScores: async () => ({ final: false, pointsByPlayerId: {} }) },
    subscriptions: () => [{ endpoint: "good" }, { endpoint: "retry" }],
    push: { available: true, send: async device => { attempts[device.endpoint]++; if (device.endpoint === "retry" && attempts.retry === 1) throw Error("network"); } } });
  t.after(() => service.close());
  await service.create({ actor: host, input: { name: "Room", capacity: 2, slateDate: slate.date, auctionStartsAt: new Date(start).toISOString() } });
  now = start - 10 * minute;
  await service.runMaintenance(); await service.runMaintenance(); await service.runMaintenance();
  assert.deepEqual(attempts, { good: 1, retry: 2 });
});
