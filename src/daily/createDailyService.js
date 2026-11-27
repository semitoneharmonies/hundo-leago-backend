const { existsSync } = require("node:fs");
const { createDailyStore } = require("./createDailyStore");
const { vancouverDate } = require("./vancouverDate");
const { createHundoDailyFeed } = require("../infrastructure/nhl/HundoDailyFeed");
const { createDailyLiveDisplay } = require("./createDailyLiveDisplay");
const { auctionStartOptions, parseAuctionStart } = require("./dailySchedule");
const { validateDailyAppearance } = require("./dailyProfile");
const { requireActor } = require("./dailyRoom");
const { DEFAULT_DAILY_PREFERENCES, validateDailyPreferences } = require("./dailyNotifications");
const { spectatorChatSetting } = require("./dailyChat");
const { validateCapSavingsBonus } = require("./dailyTeamScore");

const MINUTE = 60_000;

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

// Bind a lobby's create button to the same NHL date even when midnight or puck drop passes.
function dateAfter(date, offset) {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function createDailyService({ filename, clock = Date.now, feed = createHundoDailyFeed({ nowMs: clock }),
  openStore = createDailyStore, push, subscriptions, notify, notificationInbox, publishChatChange = () => {}, backgroundEnabled = false, logger, liveStatistics = null, recordAggregateMetrics = null } = {}) {
  const liveDisplay = liveStatistics ? createDailyLiveDisplay({ liveStatistics }) : null;
  let store, timer, maintenance, notificationDelivery, pushDelivery, stopped = false;
  let nextScoring = 0;
  let nextSlateRefresh = 0;

  const logFailure = (operation) => logger?.error?.("daily.operation_failed", { code: "DAILY_RETRY", operation });

  function existing() {
    if (!store && !stopped && filename !== ":memory:" && existsSync(filename)) {
      store = openStore({ filename, clock, existingOnly: true, recordAggregateMetrics });
    }
    return store;
  }
  function startTimer() {
    if (!backgroundEnabled || timer || stopped) return;
    timer = setInterval(() => { runMaintenance().catch(() => logFailure("maintenance")); }, 10_000);
    timer.unref?.();
  }
  function writable() {
    if (stopped) fail(503, "DAILY_UNAVAILABLE", "Hundo Daily is restarting.");
    if (!store) store = openStore({ filename, clock, recordAggregateMetrics });
    startTimer();
    return store;
  }
  function required() {
    if (stopped) fail(503, "DAILY_UNAVAILABLE", "Hundo Daily is restarting.");
    return existing() || fail(404, "DAILY_ROOM_MISSING", "This room could not be found.");
  }
  async function dayOption(date, day) {
    const option = { date, day, status: "no_games", firstGameAt: null, auctionStartsAt: null, auctionStartOptions: [] };
    try {
      const schedule = await feed.getSchedule(date);
      if (!schedule) return option;
      if (schedule.date !== date || !Number.isSafeInteger(schedule.firstGameAt)) {
        return { ...option, status: "unavailable" };
      }
      const choices = auctionStartOptions(date, schedule.firstGameAt, clock());
      return { ...option, status: choices.length ? "open" : "locked", auctionStartOptions: choices,
        firstGameAt: schedule.firstGameAt, auctionStartsAt: schedule.firstGameAt - 30 * MINUTE };
    } catch {
      return { ...option, status: "unavailable" };
    }
  }
  async function roomDates(today) {
    const options = await Promise.all([
      dayOption(today, "today"), dayOption(dateAfter(today, 1), "tomorrow"),
    ]);
    if (!options.some(option => ["open", "unavailable"].includes(option.status))) {
      // Keep the original next-game option across breaks in the NHL schedule.
      for (let offset = 2; offset < 7; offset++) {
        const next = await dayOption(dateAfter(today, offset), "next");
        if (next.status === "open" || next.status === "unavailable") {
          options.push(next);
          break;
        }
      }
    }
    return options;
  }
  async function lobby({ actor }) {
    const rooms = existing()?.listRooms({ actor }) || [];
    const slateOptions = await roomDates(vancouverDate(clock()));
    const selected = slateOptions.find(option => option.status === "open");
    const slate = selected ? { date: selected.date, firstGameAt: selected.firstGameAt, auctionStartsAt: selected.auctionStartsAt } : null;
    const today = slateOptions[0];
    const practiceSlate = { date: today.date, firstGameAt: today.firstGameAt,
      status: today.firstGameAt === null ? today.status : "available" };
    return { rooms, slate, slateOptions, practiceSlate, slateUnavailable: !slate && slateOptions.some(option => option.status === "unavailable") };
  }
  async function selectRoomDate(requested, legacyStart) {
    const today = vancouverDate(clock());
    const tomorrow = dateAfter(today, 1);
    let option;
    if (requested === today || requested === tomorrow) {
      option = await dayOption(requested, requested === today ? "today" : "tomorrow");
    } else if (!requested || (requested > tomorrow && requested <= dateAfter(today, 6))) {
      const options = await roomDates(today);
      option = options.find(item => item.status === "open" || (legacyStart && item.firstGameAt > clock()));
      if (!option && options.some(item => item.status === "unavailable")) {
        fail(503, "DAILY_SCHEDULE_UNAVAILABLE", "The NHL schedule is temporarily unavailable. Try again shortly.");
      }
      if (requested && option?.date !== requested) option = null;
    }
    if (option?.status === "unavailable") {
      fail(503, "DAILY_SCHEDULE_UNAVAILABLE", "The NHL schedule is temporarily unavailable. Try again shortly.");
    }
    if (option?.status !== "open" && !(legacyStart && option?.firstGameAt > clock())) {
      fail(409, "DAILY_SLATE_CHANGED", "There is no open NHL slate for that date. Refresh the lobby.");
    }
    return option.date;
  }
  async function create({ actor, input, requestId }) {
    const { name, capacity, slateDate, auctionStartsAt, mode = "scheduled" } = input || {};
    const allowSpectatorChat = spectatorChatSetting(input?.allowSpectatorChat);
    const capSavingsBonus = validateCapSavingsBonus(input?.capSavingsBonus);
    const scheduledStartsAt = parseAuctionStart(auctionStartsAt);
    if (!["scheduled", "practice"].includes(mode)) fail(400, "DAILY_MODE_INVALID", "Choose a scheduled or practice room.");
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60 || !Number.isSafeInteger(capacity) || capacity < 1 ||
      (slateDate !== undefined && (typeof slateDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(slateDate)))) {
      fail(400, "DAILY_INPUT_INVALID", "Enter a room name (up to 60 characters) and a positive number of seats.");
    }
    if (mode === "practice" && scheduledStartsAt !== undefined) fail(400, "DAILY_START_INVALID", "Practice auctions start immediately.");
    const request = { actor, name, capacity, slateDate, requestId, mode, scheduledStartsAt, allowSpectatorChat, capSavingsBonus };
    const replay = requestId && existing()?.replayCreate(request);
    if (replay) return { room: replay };
    const practice = mode === "practice";
    const date = practice ? vancouverDate(clock()) : await selectRoomDate(slateDate, scheduledStartsAt === undefined);
    if (practice && slateDate && slateDate !== date) {
      fail(409, "DAILY_SLATE_CHANGED", "Practice rooms use today's NHL games. Refresh the lobby.");
    }
    const slate = await feed.getSlate(date);
    if (!slate || slate.date !== date || (practice && vancouverDate(clock()) !== date)) {
      fail(409, "DAILY_SLATE_CHANGED", "There is no available NHL slate for that date. Refresh the lobby.");
    }
    if (!practice && slate.firstGameAt <= clock()) fail(409, "DAILY_LOCKED", "The first game has already started.");
    return { room: writable().createRoom({ ...request, slate }) };
  }

  async function bid({ actor, roomId, input }) {
    const current = required();
    const date = current.getRoomDate(roomId, actor);
    if (date) {
      let schedule;
      try { schedule = await feed.getSchedule(date, { allowRecentOnFailure: true }); }
      catch (error) {
        if (error?.code !== "HUNDO_DAILY_FEED_UNAVAILABLE") throw error;
        fail(503, "DAILY_SCHEDULE_UNAVAILABLE", "The NHL schedule check is temporarily unavailable. Your bid was not placed; try again shortly.");
      }
      if (stopped) fail(503, "DAILY_UNAVAILABLE", "Hundo Daily is restarting.");
      current.syncRoomSchedule(roomId, schedule);
    }
    return { room: current.bid({ roomId, actor, playerId: input?.playerId, amount: input?.amount }) };
  }

  async function sendReminders(current) {
    if (!push?.available) return;
    for (const reminder of current.listDuePushNotifications()) {
      if (stopped) return;
      if (reminder.expiresAtMs <= clock()) continue;
      try {
        const targets = subscriptions(reminder.userId, clock());
        const payload = { title: "Hundo Daily · " + reminder.title, body: reminder.messageData.roomName,
          url: "/daily/rooms/" + encodeURIComponent(reminder.roomId),
          tag: "daily:" + require("node:crypto").createHash("sha256").update(reminder.id).digest("hex") };
        const results = await Promise.allSettled(targets.map(async device => {
          if (current.pushTargetDelivered(reminder, device)) return;
          try { await push.send(device, payload, Math.max(0, Math.floor((reminder.expiresAtMs - clock()) / 1000))); }
          catch (error) { if (![404, 410].includes(error?.statusCode)) throw error; }
          if (!stopped) current.markPushTargetDelivered(reminder, device);
        }));
        // Gone endpoints are terminal. Other failures are retried under the same browser notification tag.
        if (!stopped && targets.length && results.every(r => r.status === "fulfilled" || [404, 410].includes(r.reason?.statusCode))) {
          current.markPushNotificationSent(reminder);
        }
      } catch { logFailure("reminder"); }
    }
  }
  async function scoreRooms(current) {
    if (clock() < nextScoring) return;
    nextScoring = clock() + MINUTE;
    const reports = new Map();
    for (const room of [...current.listScoringRooms(), ...current.listStatsHydrationRooms()]) {
      if (stopped) return;
      try {
        if (!reports.has(room.slate)) reports.set(room.slate, await feed.getScores(room.slate));
        const report = reports.get(room.slate);
        if (!stopped) {
          current.updateScores({ roomId: room.id, ...report, hydrateStatsOnly: room.hydrateStatsOnly === true });
          if (report.final) publishChatChange(room.id);
        }
      } catch { logFailure("scoring"); }
    }
  }
  function sendNotifications(current) {
    if (typeof notify !== "function") return;
    if (notificationDelivery) return notificationDelivery;
    notificationDelivery = (async () => {
      for (const notice of current.listDueNotifications()) {
        if (stopped) return;
        try {
          await notify(notice);
          if (!stopped) current.markNotificationSent(notice);
        } catch { logFailure("notification"); }
      }
    })().finally(() => { notificationDelivery = null; });
    return notificationDelivery;
  }
  async function refreshWaitingDates(current) {
    if (clock() < nextSlateRefresh) return;
    nextSlateRefresh = clock() + MINUTE;
    for (const date of current.listWaitingDates()) {
      if (stopped) return;
      try {
        const slate = await feed.getSlate(date);
        if (stopped) return;
        if (slate) current.refreshWaitingSlate(slate);
        else current.voidWaitingDate(date);
      } catch { logFailure("schedule"); }
    }
    if (stopped) return;
    for (const date of current.listBiddingDates()) {
      if (stopped) return;
      try {
        const schedule = await feed.getSchedule(date);
        if (!stopped) current.syncBiddingSchedule(date, schedule);
      } catch { logFailure("schedule"); }
    }
  }
  async function runMaintenance() {
    if (stopped) return;
    const current = existing();
    if (!current) return;
    // Only newly created rooms carry lifecycle counter markers; legacy room data is unchanged.
    try { current.captureAnalyticsStarts?.(); } catch { logFailure("aggregate_analytics"); }
    // Persist due notices on every tick, including while NHL/push work is still pending.
    // Delivery is serialized independently so concurrent ticks cannot duplicate a write.
    await sendNotifications(current);
    // Timed alerts must not wait for NHL schedule/stat fetches to complete.
    if (!stopped && !pushDelivery) pushDelivery = sendReminders(current).catch(() => logFailure("push")).finally(() => { pushDelivery = null; });
    if (stopped || maintenance) return maintenance;
    maintenance = (async () => {
      await Promise.all([scoreRooms(current), refreshWaitingDates(current), pushDelivery]);
      if (!stopped) await sendNotifications(current);
    })().finally(() => { maintenance = null; });
    return maintenance;
  }
  // A fresh install opens its sidecar only on the first room creation. Existing rooms
  // resume after a restart even when no manager has the page open.
  return {
    notifications: input => notificationInbox?.list(input) || { notifications: [], unreadCount: 0 },
    readNotifications: input => notificationInbox?.read(input) || { changedCount: 0 },
    notificationSettings: ({ actor }) => { requireActor(actor); return existing()?.getNotificationSettings({ actor }) || { preferences: { ...DEFAULT_DAILY_PREFERENCES } }; },
    updateNotificationSettings: input => { requireActor(input.actor); validateDailyPreferences(input.input); return writable().updateNotificationSettings(input); },
    lobby, create, bid, runMaintenance, orderPlayerPool: feed.orderPlayerPool,
    chat: input => required().getChat(input),
    canReadChat: (roomId, userId) => required().canReadChat(roomId, userId),
    postChat: input => {
      const result = required().postChat(input);
      publishChatChange(input.roomId);
      return result;
    },
    reactToChat: input => {
      const result = required().reactToChat(input);
      publishChatChange(input.roomId);
      return result;
    },
    start() { if (backgroundEnabled && filename !== ":memory:" && existsSync(filename)) startTimer(); },
    room: ({ actor, roomId }) => {
      const current = required();
      return { room: liveDisplay ? liveDisplay.project(current.readRoomForDisplay({ roomId, actor })) : current.getRoom({ roomId, actor }) };
    },
    join: ({ actor, roomId }) => ({ room: required().joinRoom({ roomId, actor }) }),
    closeRoom: ({ actor, roomId }) => ({ room: required().closeRoom({ roomId, actor }) }),
    reminders: ({ actor }) => ({ reminders: existing()?.listReminders({ actor }) || [] }),
    profile: ({ actor }) => { requireActor(actor); return { profile: existing()?.getProfile({ actor }) || { appearance: null } }; },
    updateProfile: ({ actor, input }) => {
      requireActor(actor);
      validateDailyAppearance(input);
      return { profile: writable().updateProfile({ actor, input }) };
    },
    close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      store?.close();
      store = null;
    },
  };
}

module.exports = { createDailyService };
