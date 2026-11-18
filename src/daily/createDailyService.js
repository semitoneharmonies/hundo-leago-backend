const { existsSync } = require("node:fs");
const { createDailyStore } = require("./createDailyStore");
const { vancouverDate } = require("./vancouverDate");
const { createHundoDailyFeed } = require("../infrastructure/nhl/HundoDailyFeed");

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
  openStore = createDailyStore, push, subscriptions, backgroundEnabled = false, logger } = {}) {
  let store, timer, maintenance, stopped = false;
  let nextScoring = 0;
  let nextSlateRefresh = 0;

  const logFailure = (operation) => logger?.error?.("daily.operation_failed", { code: "DAILY_RETRY", operation });

  function existing() {
    if (!store && !stopped && filename !== ":memory:" && existsSync(filename)) {
      store = openStore({ filename, clock, existingOnly: true });
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
    if (!store) store = openStore({ filename, clock });
    startTimer();
    return store;
  }
  function required() {
    if (stopped) fail(503, "DAILY_UNAVAILABLE", "Hundo Daily is restarting.");
    return existing() || fail(404, "DAILY_ROOM_MISSING", "This room could not be found.");
  }
  async function dayOption(date, day) {
    const option = { date, day, status: "no_games", firstGameAt: null, auctionStartsAt: null };
    try {
      const schedule = await feed.getSchedule(date);
      if (!schedule) return option;
      if (schedule.date !== date || !Number.isSafeInteger(schedule.firstGameAt)) {
        return { ...option, status: "unavailable" };
      }
      return { ...option, status: schedule.firstGameAt > clock() ? "open" : "locked",
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
  async function selectRoomDate(requested) {
    const today = vancouverDate(clock());
    const tomorrow = dateAfter(today, 1);
    let option;
    if (requested === today || requested === tomorrow) {
      option = await dayOption(requested, requested === today ? "today" : "tomorrow");
    } else if (!requested || (requested > tomorrow && requested <= dateAfter(today, 6))) {
      const options = await roomDates(today);
      option = options.find(item => item.status === "open");
      if (!option && options.some(item => item.status === "unavailable")) {
        fail(503, "DAILY_SCHEDULE_UNAVAILABLE", "The NHL schedule is temporarily unavailable. Try again shortly.");
      }
      if (requested && option?.date !== requested) option = null;
    }
    if (option?.status === "unavailable") {
      fail(503, "DAILY_SCHEDULE_UNAVAILABLE", "The NHL schedule is temporarily unavailable. Try again shortly.");
    }
    if (option?.status !== "open") {
      fail(409, "DAILY_SLATE_CHANGED", "There is no open NHL slate for that date. Refresh the lobby.");
    }
    return option.date;
  }
  async function create({ actor, input, requestId }) {
    const { name, capacity, slateDate, mode = "scheduled" } = input || {};
    if (!["scheduled", "practice"].includes(mode)) fail(400, "DAILY_MODE_INVALID", "Choose a scheduled or practice room.");
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60 || !Number.isSafeInteger(capacity) || capacity < 1 ||
      (slateDate !== undefined && (typeof slateDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(slateDate)))) {
      fail(400, "DAILY_INPUT_INVALID", "Enter a room name (up to 60 characters) and a positive number of seats.");
    }
    const request = { actor, name, capacity, slateDate, requestId, mode };
    const replay = requestId && existing()?.replayCreate(request);
    if (replay) return { room: replay };
    const practice = mode === "practice";
    const date = practice ? vancouverDate(clock()) : await selectRoomDate(slateDate);
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
      const schedule = await feed.getSchedule(date);
      if (stopped) fail(503, "DAILY_UNAVAILABLE", "Hundo Daily is restarting.");
      current.syncRoomSchedule(roomId, schedule);
    }
    return { room: current.bid({ roomId, actor, playerId: input?.playerId, amount: input?.amount }) };
  }

  async function sendReminders(current) {
    if (!push?.available) return;
    for (const reminder of current.listDueReminders()) {
      if (stopped) return;
      const startsAt = new Date(reminder.auctionStartsAt).getTime();
      if (startsAt <= clock()) continue;
      try {
        const targets = subscriptions(reminder.userId, clock());
        const payload = { title: "Hundo Daily auction soon", body: reminder.roomName,
          url: "/daily/rooms/" + encodeURIComponent(reminder.roomId), tag: reminder.id };
        const results = await Promise.allSettled(targets.map(device =>
          push.send(device, payload, Math.max(0, Math.floor((startsAt - clock()) / 1000)))));
        // Gone endpoints are terminal. Other failures are retried under the same browser notification tag.
        if (!stopped && targets.length && results.every(r => r.status === "fulfilled" || [404, 410].includes(r.reason?.statusCode))) {
          current.markReminderSent(reminder);
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
        if (!stopped) current.updateScores({ roomId: room.id, ...report, hydrateStatsOnly: room.hydrateStatsOnly === true });
      } catch { logFailure("scoring"); }
    }
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
    if (stopped || maintenance) return maintenance;
    const current = existing();
    if (!current) return;
    maintenance = (async () => {
      await Promise.all([scoreRooms(current), refreshWaitingDates(current).then(() => {
        if (!stopped) return sendReminders(current);
      })]);
    })().finally(() => { maintenance = null; });
    return maintenance;
  }
  // A fresh install opens its sidecar only on the first room creation. Existing rooms
  // resume after a restart even when no manager has the page open.
  return {
    lobby, create, bid, runMaintenance, orderPlayerPool: feed.orderPlayerPool,
    start() { if (backgroundEnabled && filename !== ":memory:" && existsSync(filename)) startTimer(); },
    room: ({ actor, roomId }) => ({ room: required().getRoom({ roomId, actor }) }),
    join: ({ actor, roomId }) => ({ room: required().joinRoom({ roomId, actor }) }),
    closeRoom: ({ actor, roomId }) => ({ room: required().closeRoom({ roomId, actor }) }),
    reminders: ({ actor }) => ({ reminders: existing()?.listReminders({ actor }) || [] }),
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
