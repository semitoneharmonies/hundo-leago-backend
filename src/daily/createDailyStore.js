"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { MINUTE, ROSTER_SIZE, auctionEnd, reject, requireActor, phase, summary, roomView, placeBid, scoreRoom } = require("./dailyRoom");
const { validatedScoringDetails } = require("./dailyScoring");
const { validateAuctionStart } = require("./dailySchedule");
const { validateDailyAppearance } = require("./dailyProfile");
const { chatText, requireChatMember, chatView } = require("./dailyChat");

const DAILY_DATABASE_ID = 1212433457;
const MEMBER_PHASES = new Set(["waiting", "auction"]);

function createDailyStore({ filename, clock = Date.now, existingOnly = false } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  if (!filename) throw new TypeError("Daily needs its own SQLite filename.");
  if (existingOnly) {
    // A read that discovers a missing or empty sidecar must never initialize it.
    const probe = new DatabaseSync(filename, { readOnly: true });
    try {
      if (probe.prepare("PRAGMA application_id").get().application_id !== DAILY_DATABASE_ID) {
        throw new Error("Expected an initialized Hundo Daily database.");
      }
    } finally { probe.close(); }
  }
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout = 5000");
  function transaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  try {
    function initialized() {
      const appId = db.prepare("PRAGMA application_id").get().application_id;
      if (appId === DAILY_DATABASE_ID) {
        if (db.prepare("PRAGMA user_version").get().user_version !== 1) throw new Error("Unknown Hundo Daily database version.");
        return true;
      }
      if (existingOnly || appId) throw new Error("Hundo Daily requires a dedicated database.");
      return false;
    }
    if (!initialized()) {
      transaction(() => {
        if (initialized()) return;
        if (db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) throw new Error("Hundo Daily requires a dedicated database.");
        db.exec(`
          CREATE TABLE slates (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
          CREATE TABLE rooms (
            id TEXT PRIMARY KEY, slate_id TEXT NOT NULL REFERENCES slates(id),
            date TEXT NOT NULL, first_game_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0,
            closed INTEGER NOT NULL DEFAULT 0, info TEXT NOT NULL, play TEXT NOT NULL,
            creator_id TEXT NOT NULL, request_id TEXT, UNIQUE(creator_id,request_id)
          );
          CREATE INDEX room_lifecycle ON rooms(closed,ended,first_game_at);
          CREATE TABLE sent_reminders (
            room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL, starts_at INTEGER NOT NULL,
            PRIMARY KEY(room_id,user_id,starts_at)
          );
          PRAGMA application_id = ${DAILY_DATABASE_ID};
          PRAGMA user_version = 1;
        `);
      });
      db.exec("PRAGMA journal_mode=WAL");
    }
    db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
  } catch (error) {
    db.close();
    throw error;
  }

  const roomRow = db.prepare("SELECT * FROM rooms WHERE id=?");
  const priorCreate = db.prepare("SELECT * FROM rooms WHERE creator_id=? AND request_id=?");
  const slateRow = db.prepare("SELECT payload FROM slates WHERE id=?");
  const visibleRows = db.prepare("SELECT info,play FROM rooms WHERE closed=0 ORDER BY first_game_at DESC, rowid DESC");
  const savePlay = db.prepare("UPDATE rooms SET play=? WHERE id=?");
  const saveInfo = db.prepare("UPDATE rooms SET info=?, first_game_at=?, ended=?, closed=? WHERE id=?");

  function appearance(userId) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='daily_profiles'").get()) return null;
    const row = db.prepare("SELECT appearance FROM daily_profiles WHERE user_id=?").get(userId);
    return row ? JSON.parse(row.appearance) : null;
  }
  function getProfile({ actor }) {
    requireActor(actor);
    return { appearance: appearance(actor.id) };
  }
  function updateProfile({ actor, input }) {
    requireActor(actor);
    const value = validateDailyAppearance(input);
    return transaction(() => {
      // Optional extension of the Daily sidecar; old readers remain compatible.
      // Only an authorized profile write creates it, never a GET or startup read.
      db.exec("CREATE TABLE IF NOT EXISTS daily_profiles (user_id TEXT PRIMARY KEY, appearance TEXT NOT NULL)");
      db.prepare(`INSERT INTO daily_profiles(user_id,appearance) VALUES(?,?)
        ON CONFLICT(user_id) DO UPDATE SET appearance=excluded.appearance
        WHERE daily_profiles.appearance<>excluded.appearance`).run(actor.id, JSON.stringify(value));
      return { appearance: value };
    });
  }
  function presentRoom(room, slate, actor, now) {
    const view = roomView(room, slate, actor, now);
    view.members = view.members.map(member => ({ ...member, dailyAppearance: appearance(member.id) }));
    return view;
  }

  function persistSlate(slate) {
    if (!slate || !/^\d{4}-\d{2}-\d{2}$/.test(slate.date) || !Number.isSafeInteger(slate.firstGameAt) ||
        !Array.isArray(slate.players) || !slate.players.length) {
      reject(409, "DAILY_SLATE_UNAVAILABLE", "The day’s NHL player slate is unavailable.");
    }
    const ids = new Set();
    for (const { id, name, team, position, opponent } of slate.players) {
      if (typeof id !== "string" || !id || ids.has(id) || !name || !team || !opponent ||
          !["F", "C", "L", "R", "LW", "RW", "D"].includes(position)) {
        throw new Error("Invalid player in Hundo Daily slate.");
      }
      ids.add(id);
    }
    const json = JSON.stringify(slate);
    const hash = createHash("sha256").update(json).digest("hex");
    db.prepare("INSERT OR IGNORE INTO slates(id,payload) VALUES(?,?)").run(hash, json);
    return hash;
  }

  function fromRow(row) {
    return Object.assign(JSON.parse(row.info), JSON.parse(row.play));
  }
  function save(row, room) {
    const { lots, scores, scoringDetails, ...info } = room;
    const nextInfo = JSON.stringify(info);
    const nextPlay = JSON.stringify({ lots, scores, ...(scoringDetails ? { scoringDetails } : {}) });
    if (nextInfo !== row.info) saveInfo.run(nextInfo, auctionEnd(info), Number(info.finished || info.void), Number(info.closed), info.id);
    if (nextPlay !== row.play) savePlay.run(nextPlay, info.id);
  }
  function getSlate(row) {
    return JSON.parse(slateRow.get(row.slate_id).payload);
  }
  function findRoom(roomId) {
    const row = roomRow.get(roomId);
    if (!row) reject(404, "DAILY_ROOM_NOT_FOUND", "This room could not be found.");
    return row;
  }
  function readRoomForDisplay({ roomId, actor }) {
    const row = findRoom(roomId);
    const info = JSON.parse(row.info);
    if (actor?.isAdmin !== true && !info.members.some(({ id }) => id === actor?.id)) {
      reject(403, "DAILY_MEMBERSHIP_REQUIRED", "Join this room to see its players and rosters.");
    }
    if (info.closed) reject(410, "DAILY_ROOM_CLOSED", "This room has been closed.");
    const slate = getSlate(row);
    return { room: presentRoom(fromRow(row), slate, actor, clock()), slate };
  }
  function getRoom(input) { return readRoomForDisplay(input).room; }
  function canReadChat(roomId, userId) {
    requireChatMember(JSON.parse(findRoom(roomId).info), userId);
    return true;
  }
  function getChat({ roomId, actor }) {
    requireActor(actor);
    const room = JSON.parse(findRoom(roomId).info);
    requireChatMember(room, actor.id);
    return chatView(room);
  }
  function postChat({ roomId, actor, input, requestId }) {
    requireActor(actor);
    const text = chatText(input?.text);
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)) {
      reject(400, "DAILY_CHAT_REQUEST", "Use a valid message request identifier.");
    }
    return transaction(() => {
      const row = findRoom(roomId), room = fromRow(row);
      requireChatMember(room, actor.id);
      if (room.finished || room.void || room.closed) reject(409, "DAILY_CHAT_READ_ONLY", "This room's chat is now read-only.");
      const messages = room.chat || [];
      const prior = messages.find(message => message.userId === actor.id && message.requestId === requestId);
      if (prior) {
        if (prior.text !== text) reject(409, "DAILY_CHAT_CONFLICT", "That request already belongs to another message.");
        return chatView(room);
      }
      const now = clock();
      const previous = messages.findLast(message => message.userId === actor.id);
      if (previous && now - previous.createdAtMs < 1000) reject(429, "DAILY_CHAT_RATE_LIMIT", "Wait a moment before sending another message.");
      room.chat = [...messages, { id: randomUUID(), userId: actor.id, username: actor.name, text, createdAtMs: now, requestId }];
      save(row, room);
      return chatView(room);
    });
  }
  function getRoomDate(roomId, actor) {
    requireActor(actor);
    const row = db.prepare("SELECT info,play FROM rooms WHERE id=?").get(roomId);
    if (!row) reject(404, "DAILY_ROOM_NOT_FOUND", "This room could not be found.");
    const room = fromRow(row);
    if (!room.members.some(({ id }) => id === actor.id)) reject(403, "DAILY_MEMBERSHIP_REQUIRED", "Join this room before bidding.");
    if (!MEMBER_PHASES.has(phase(room, clock()))) reject(409, "DAILY_AUCTION_INACTIVE", "Bidding is closed.");
    return room.mode === "practice" ? null : room.date;
  }
  function mutate({ roomId, actor }, fn) {
    requireActor(actor);
    return transaction(() => {
      const row = findRoom(roomId);
      const room = fromRow(row);
      const slate = getSlate(row);
      const now = clock();
      fn(room, slate, now);
      save(row, room);
      return presentRoom(room, slate, actor, now);
    });
  }
  function checkSetup(actor, name, capacity, requestId) {
    requireActor(actor);
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
      reject(400, "DAILY_ROOM_NAME", "Enter a room name from 1 to 60 characters.");
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1) reject(400, "DAILY_CAPACITY", "Choose a positive whole number of seats.");
    if (requestId != null && (typeof requestId !== "string" || !requestId || requestId.length > 128)) {
      reject(400, "DAILY_REQUEST_ID", "Use a valid request identifier.");
    }
  }
  function replayCreate({ actor, name, capacity, requestId, slateDate, scheduledStartsAt, mode = "scheduled" }) {
    checkSetup(actor, name, capacity, requestId);
    if (mode !== "scheduled" && mode !== "practice") reject(400, "DAILY_ROOM_MODE", "Choose a scheduled or practice room.");
    if (requestId == null) return null;
    const row = priorCreate.get(actor.id, requestId);
    if (!row) return null;
    const info = JSON.parse(row.info);
    if (info.name !== name.trim() || info.capacity !== capacity ||
        (info.mode ?? "scheduled") !== mode || (slateDate && info.date !== slateDate) ||
        (info.requestedAuctionStartsAt ?? info.scheduledStartsAt) !== scheduledStartsAt) {
      reject(409, "DAILY_CREATE_CONFLICT", "That request identifier already belongs to a different room.");
    }
    return presentRoom(fromRow(row), getSlate(row), actor, clock());
  }
  function createRoom(input) {
    const { actor, name, capacity, slate, requestId, scheduledStartsAt, mode = "scheduled" } = input;
    return transaction(() => {
      const replay = replayCreate(input);
      if (replay) return replay;
      const slateId = persistSlate(slate);
      const now = clock();
      if (mode === "practice" && scheduledStartsAt !== undefined) reject(400, "DAILY_START_INVALID", "Practice auctions start immediately.");
      if (mode === "scheduled") validateAuctionStart(scheduledStartsAt, slate, now);
      if (mode === "scheduled" && now >= slate.firstGameAt) reject(409, "DAILY_ROOM_LOCKED", "The first game has already started.");
      const member = { id: actor.id, name: actor.name };
      const info = { id: randomUUID(), name: name.trim(), capacity, commissionerId: actor.id, date: slate.date,
        mode, firstGameAt: slate.firstGameAt, ...(mode === "practice" ? { practiceEndsAt: now + 30 * MINUTE } : {}),
        ...(scheduledStartsAt === undefined ? {} : { scheduledStartsAt, requestedAuctionStartsAt: scheduledStartsAt }),
        members: [member], winners: [], closed: false, finished: false, void: false };
      const play = { lots: [], scores: {} };
      db.prepare(`INSERT INTO rooms(id,slate_id,date,first_game_at,info,play,creator_id,request_id)
        VALUES(?,?,?,?,?,?,?,?)`).run(info.id, slateId, info.date, auctionEnd(info), JSON.stringify(info),
          JSON.stringify(play), member.id, requestId ?? null);
      return presentRoom({ ...info, ...play }, slate, actor, now);
    });
  }
  function joinRoom(input) {
    const { actor } = input;
    return mutate(input, (room, _slate, now) => {
      if (room.members.some(({ id }) => id === actor.id)) return;
      if (!MEMBER_PHASES.has(phase(room, now))) reject(409, "DAILY_ROOM_LOCKED", "This room is locked.");
      if (room.members.length >= room.capacity) reject(409, "DAILY_ROOM_FULL", "This room is full.");
      room.members.push({ id: actor.id, name: actor.name });
    });
  }
  function bid(input) {
    return mutate(input, (room, slate, now) => placeBid(room, slate, input.actor, input.playerId, input.amount, now));
  }
  function closeRoom(input) {
    return mutate(input, (room, _slate, now) => {
      const admin = input.actor.isAdmin === true;
      const commissioner = input.actor.id === room.commissionerId;
      if (!admin && !(commissioner && (room.finished || room.void))) {
        reject(403, "DAILY_CLOSE_FORBIDDEN", "Only an admin or the commissioner of a completed room can close it.");
      }
      if (room.closed) return;
      room.closed = true;
      room.closedAt = now;
    });
  }

  // Reminder delivery acknowledgements are distinct from the member's visible in-app reminder.
  function reminders(userId, onlyUnsent) {
    const now = clock();
    const rows = db.prepare(`SELECT r.id AS roomId, json_extract(r.info,'$.name') AS roomName,
        json_extract(m.value,'$.id') AS userId, r.first_game_at-? AS startsAt
      FROM rooms r JOIN json_each(r.info,'$.members') m
      LEFT JOIN sent_reminders s ON s.room_id=r.id AND s.user_id=json_extract(m.value,'$.id') AND s.starts_at=r.first_game_at-?
      WHERE r.closed=0 AND r.ended=0 AND r.first_game_at>? AND r.first_game_at<=?
        AND json_extract(r.info,'$.mode') IS NOT 'practice'
        AND (? IS NULL OR json_extract(m.value,'$.id')=?) AND (?=0 OR s.room_id IS NULL)`)
      .all(30 * MINUTE, 30 * MINUTE, now + 30 * MINUTE, now + 40 * MINUTE, userId, userId, Number(onlyUnsent));
    return rows.map(({ startsAt, roomId, roomName, userId: memberId }) => ({
      id: roomId + ":" + startsAt + ":" + memberId, roomId, roomName, userId: memberId,
      auctionStartsAt: new Date(startsAt).toISOString(),
    }));
  }
  function markReminderSent({ roomId, userId, auctionStartsAt }) {
    const now = clock();
    const scheduled = auctionStartsAt ? Date.parse(auctionStartsAt) : null;
    db.prepare(`INSERT OR IGNORE INTO sent_reminders(room_id,user_id,starts_at)
      SELECT id,?,first_game_at-? FROM rooms WHERE id=? AND closed=0 AND ended=0
        AND json_extract(info,'$.mode') IS NOT 'practice'
        AND first_game_at>? AND first_game_at<=? AND (? IS NULL OR first_game_at-?=?)`)
      .run(userId, 30 * MINUTE, roomId, now + 30 * MINUTE, now + 40 * MINUTE, scheduled, 30 * MINUTE, scheduled);
  }

  function listDueNotifications() {
    const notices = [];
    for (const reminder of reminders(null, false)) {
      const room = fromRow(findRoom(reminder.roomId));
      const id = "daily:reminder:" + reminder.id;
      if (room.notificationReceipts?.includes(id)) continue;
      notices.push({ id, roomId: room.id, userId: reminder.userId, type: "daily_auction_reminder",
        createdAtMs: Date.parse(reminder.auctionStartsAt) - 10 * MINUTE,
        messageData: { roomId: room.id, roomName: room.name, auctionStartsAt: reminder.auctionStartsAt } });
    }
    // Only new finalizations carry finishedAt. Historical winners are not flooded with retroactive notices.
    const finished = db.prepare(`SELECT * FROM rooms WHERE ended=1 AND json_extract(info,'$.finished')=1
      AND json_extract(info,'$.finishedAt') IS NOT NULL AND json_extract(info,'$.void')=0`).all();
    for (const row of finished) {
      const room = fromRow(row);
      for (const winner of room.winners) {
        const id = "daily:won:" + room.id + ":" + winner.id;
        if (room.notificationReceipts?.includes(id)) continue;
        notices.push({ id, roomId: room.id, userId: winner.id, type: "daily_room_won", createdAtMs: room.finishedAt,
          messageData: { roomId: room.id, roomName: room.name, points: winner.points,
            tied: room.winners.length > 1, winnerCount: room.winners.length } });
      }
    }
    return notices;
  }
  function markNotificationSent(notice) {
    return transaction(() => {
      if (!listDueNotifications().some(candidate => candidate.id === notice.id && candidate.userId === notice.userId)) return;
      const row = findRoom(notice.roomId), room = fromRow(row);
      room.notificationReceipts = [...(room.notificationReceipts || []), notice.id];
      save(row, room);
    });
  }

  function listScoringRooms() {
    const now = clock();
    const rows = db.prepare(`SELECT * FROM rooms WHERE closed=0 AND ended=0 AND
      (first_game_at<=? OR json_array_length(play,'$.lots')=?*json_array_length(info,'$.members'))`).all(now, ROSTER_SIZE)
      .filter(row => phase(fromRow(row), now) === "locked");
    const slates = new Map();
    return rows.map((row) => {
      if (!slates.has(row.slate_id)) slates.set(row.slate_id, getSlate(row));
      return { id: row.id, date: row.date, slate: slates.get(row.slate_id), playerIds: JSON.parse(row.play).lots.map((lot) => lot.playerId) };
    });
  }
  function listStatsHydrationRooms() {
    return db.prepare(`SELECT * FROM rooms WHERE closed=0 AND ended=1
      AND json_extract(info,'$.finished')=1 AND json_extract(info,'$.void')=0
      AND json_type(play,'$.scoringDetails') IS NULL`).all().map(row => ({
      id: row.id, date: row.date, slate: getSlate(row), hydrateStatsOnly: true,
    }));
  }
  function updateScores({ roomId, pointsByPlayerId, playerStatsById, final, voided, hydrateStatsOnly = false }) {
    return transaction(() => {
      const row = findRoom(roomId);
      const room = fromRow(row);
      if (room.closed || room.void) return;
      if (room.finished || hydrateStatsOnly) {
        if (!room.finished || !final || voided || room.scoringDetails) return;
        // Backfill presentation evidence only when every signed total still agrees.
        const details = validatedScoringDetails(room, getSlate(row), playerStatsById, pointsByPlayerId, true);
        if (details) { room.scoringDetails = details; save(row, room); }
        return;
      }
      if (phase(room, clock()) !== "locked") return;
      const details = voided && final ? null : validatedScoringDetails(room, getSlate(row), playerStatsById, pointsByPlayerId, final === true);
      scoreRoom(room, pointsByPlayerId, final === true, voided === true, clock());
      if (details) room.scoringDetails = details;
      save(row, room);
    });
  }
  function listWaitingDates() {
    return db.prepare(`SELECT DISTINCT date FROM rooms WHERE closed=0 AND ended=0 AND first_game_at>?
      AND json_extract(info,'$.mode') IS NOT 'practice' AND json_array_length(play,'$.lots')=0`).all(clock()).map((row) => row.date);
  }
  function listBiddingDates() {
    return db.prepare(`SELECT DISTINCT date FROM rooms WHERE closed=0 AND ended=0 AND first_game_at>?
      AND json_extract(info,'$.mode') IS NOT 'practice' AND json_array_length(play,'$.lots')>0`).all(clock()).map((row) => row.date);
  }
  function revisedTime(date, schedule) {
    if (schedule === null) return null;
    if (schedule?.date !== date || !Number.isSafeInteger(schedule.firstGameAt)) throw new TypeError("Invalid revised Hundo Daily schedule.");
    return schedule.firstGameAt;
  }
  function applyRevisedTime(roomId, firstGameAt) {
    transaction(() => {
      const row = findRoom(roomId);
      const now = clock();
      // Recheck under the write lock. A schedule update cannot reopen a locked room.
      if (row.closed || row.ended || now >= row.first_game_at) return;
      const room = fromRow(row);
      if (firstGameAt === room.firstGameAt) return;
      if (room.mode === "practice" || phase(room, now) === "locked") return;
      if (firstGameAt === null) {
        room.void = true;
        room.voidAt = now;
      } else {
        room.firstGameAt = firstGameAt;
        if (room.scheduledStartsAt !== undefined) room.scheduledStartsAt = Math.min(room.scheduledStartsAt, firstGameAt - 30 * MINUTE);
        for (const lot of room.lots) {
          if (lot.endsAt > now) lot.endsAt = Math.min(lot.endsAt, auctionEnd(room));
        }
      }
      save(row, room);
    });
  }
  function syncBiddingSchedule(date, schedule) {
    const firstGameAt = revisedTime(date, schedule);
    const rows = db.prepare(`SELECT id FROM rooms WHERE date=? AND closed=0 AND ended=0 AND first_game_at>?
      AND json_extract(info,'$.firstGameAt') IS NOT ? AND json_extract(info,'$.mode') IS NOT 'practice'
      AND json_array_length(play,'$.lots')>0`).all(date, clock(), firstGameAt);
    for (const row of rows) applyRevisedTime(row.id, firstGameAt);
  }
  function syncRoomSchedule(roomId, schedule) {
    const row = db.prepare(`SELECT date,first_game_at,closed,ended,json_extract(info,'$.mode') AS mode,
      json_extract(info,'$.firstGameAt') AS official_first_game_at FROM rooms WHERE id=?`).get(roomId);
    if (!row) reject(404, "DAILY_ROOM_NOT_FOUND", "This room could not be found.");
    if (row.mode === "practice") return;
    const firstGameAt = revisedTime(row.date, schedule);
    if (!row.closed && !row.ended && row.first_game_at > clock() && firstGameAt !== row.official_first_game_at) {
      applyRevisedTime(roomId, firstGameAt);
    }
  }
  function changeWaiting(date, slate) {
    return transaction(() => {
      const rows = db.prepare(`SELECT * FROM rooms WHERE closed=0 AND ended=0 AND date=?
        AND first_game_at>? AND json_extract(info,'$.mode') IS NOT 'practice'
        AND json_array_length(play,'$.lots')=0`).all(date, clock());
      if (!rows.length) return;
      const slateId = slate ? persistSlate(slate) : null;
      for (const row of rows) {
        const room = fromRow(row);
        if (slateId && row.slate_id === slateId) continue;
        if (slateId) {
          db.prepare("UPDATE rooms SET slate_id=? WHERE id=?").run(slateId, room.id);
          room.firstGameAt = slate.firstGameAt;
          if (room.scheduledStartsAt !== undefined) room.scheduledStartsAt = Math.min(room.scheduledStartsAt, slate.firstGameAt - 30 * MINUTE);
        } else room.void = true;
        save(row, room);
      }
    });
  }

  return {
    listRooms: ({ actor } = {}) => visibleRows.all().map(row => summary(fromRow(row), actor, clock())),
    getRoom, readRoomForDisplay, getRoomDate, replayCreate, createRoom, joinRoom, bid, closeRoom, listScoringRooms, listStatsHydrationRooms, updateScores,
    getProfile, updateProfile, getChat, postChat, canReadChat, listDueNotifications, markNotificationSent,
    listReminders: ({ actor }) => actor?.id ? reminders(actor.id, false) : [],
    listDueReminders: () => reminders(null, true), markReminderSent,
    listWaitingDates, listBiddingDates, syncRoomSchedule, syncBiddingSchedule, refreshWaitingSlate: (slate) => changeWaiting(slate.date, slate),
    voidWaitingDate: (date) => changeWaiting(date, null), close: () => { if (db.isOpen) db.close(); },
  };
}

module.exports = { createDailyStore };
