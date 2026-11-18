"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { MINUTE, ROSTER_SIZE, auctionEnd, reject, requireActor, phase, summary, roomView, placeBid, scoreRoom } = require("./dailyRoom");

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
    const { lots, scores, ...info } = room;
    const nextInfo = JSON.stringify(info);
    const nextPlay = JSON.stringify({ lots, scores });
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
  function getRoom({ roomId, actor }) {
    const row = findRoom(roomId);
    const info = JSON.parse(row.info);
    if (actor?.isAdmin !== true && !info.members.some(({ id }) => id === actor?.id)) {
      reject(403, "DAILY_MEMBERSHIP_REQUIRED", "Join this room to see its players and rosters.");
    }
    if (info.closed) reject(410, "DAILY_ROOM_CLOSED", "This room has been closed.");
    return roomView(fromRow(row), getSlate(row), actor, clock());
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
      return roomView(room, slate, actor, now);
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
  function replayCreate({ actor, name, capacity, requestId, slateDate, mode = "scheduled" }) {
    checkSetup(actor, name, capacity, requestId);
    if (mode !== "scheduled" && mode !== "practice") reject(400, "DAILY_ROOM_MODE", "Choose a scheduled or practice room.");
    if (requestId == null) return null;
    const row = priorCreate.get(actor.id, requestId);
    if (!row) return null;
    const info = JSON.parse(row.info);
    if (info.name !== name.trim() || info.capacity !== capacity ||
        (info.mode ?? "scheduled") !== mode || (slateDate && info.date !== slateDate)) {
      reject(409, "DAILY_CREATE_CONFLICT", "That request identifier already belongs to a different room.");
    }
    return roomView(fromRow(row), getSlate(row), actor, clock());
  }
  function createRoom(input) {
    const { actor, name, capacity, slate, requestId, mode = "scheduled" } = input;
    return transaction(() => {
      const replay = replayCreate(input);
      if (replay) return replay;
      const slateId = persistSlate(slate);
      const now = clock();
      if (mode === "scheduled" && now >= slate.firstGameAt) reject(409, "DAILY_ROOM_LOCKED", "The first game has already started.");
      const member = { id: actor.id, name: actor.name };
      const info = { id: randomUUID(), name: name.trim(), capacity, commissionerId: actor.id, date: slate.date,
        mode, firstGameAt: slate.firstGameAt, ...(mode === "practice" ? { practiceEndsAt: now + 30 * MINUTE } : {}),
        members: [member], winners: [], closed: false, finished: false, void: false };
      const play = { lots: [], scores: {} };
      db.prepare(`INSERT INTO rooms(id,slate_id,date,first_game_at,info,play,creator_id,request_id)
        VALUES(?,?,?,?,?,?,?,?)`).run(info.id, slateId, info.date, auctionEnd(info), JSON.stringify(info),
          JSON.stringify(play), member.id, requestId ?? null);
      return roomView({ ...info, ...play }, slate, actor, now);
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
  function updateScores({ roomId, pointsByPlayerId, final, voided }) {
    return transaction(() => {
      const row = findRoom(roomId);
      const room = fromRow(row);
      scoreRoom(room, pointsByPlayerId, final === true, voided === true, clock());
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
      if (row.closed || row.ended || now >= row.first_game_at || firstGameAt === row.first_game_at) return;
      const room = fromRow(row);
      if (room.mode === "practice" || phase(room, now) === "locked") return;
      if (firstGameAt === null) {
        room.void = true;
        room.voidAt = now;
      } else {
        room.firstGameAt = firstGameAt;
        for (const lot of room.lots) {
          if (lot.endsAt > now) lot.endsAt = Math.min(lot.endsAt, firstGameAt);
        }
      }
      save(row, room);
    });
  }
  function syncBiddingSchedule(date, schedule) {
    const firstGameAt = revisedTime(date, schedule);
    const rows = db.prepare(`SELECT id FROM rooms WHERE date=? AND closed=0 AND ended=0 AND first_game_at>?
      AND first_game_at IS NOT ? AND json_extract(info,'$.mode') IS NOT 'practice'
      AND json_array_length(play,'$.lots')>0`).all(date, clock(), firstGameAt);
    for (const row of rows) applyRevisedTime(row.id, firstGameAt);
  }
  function syncRoomSchedule(roomId, schedule) {
    const row = db.prepare("SELECT date,first_game_at,closed,ended,json_extract(info,'$.mode') AS mode FROM rooms WHERE id=?").get(roomId);
    if (!row) reject(404, "DAILY_ROOM_NOT_FOUND", "This room could not be found.");
    if (row.mode === "practice") return;
    const firstGameAt = revisedTime(row.date, schedule);
    if (!row.closed && !row.ended && row.first_game_at > clock() && firstGameAt !== row.first_game_at) {
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
        } else room.void = true;
        save(row, room);
      }
    });
  }

  return {
    listRooms: ({ actor } = {}) => visibleRows.all().map(row => summary(fromRow(row), actor, clock())),
    getRoom, getRoomDate, replayCreate, createRoom, joinRoom, bid, closeRoom, listScoringRooms, updateScores,
    listReminders: ({ actor }) => actor?.id ? reminders(actor.id, false) : [],
    listDueReminders: () => reminders(null, true), markReminderSent,
    listWaitingDates, listBiddingDates, syncRoomSchedule, syncBiddingSchedule, refreshWaitingSlate: (slate) => changeWaiting(slate.date, slate),
    voidWaitingDate: (date) => changeWaiting(date, null), close: () => { if (db.isOpen) db.close(); },
  };
}

module.exports = { createDailyStore };
