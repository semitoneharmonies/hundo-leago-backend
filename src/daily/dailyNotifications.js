"use strict";

const { MINUTE, auctionStart, summary, reject } = require("./dailyRoom");
const DEFAULT_DAILY_PREFERENCES = Object.freeze({ enabled: true, reminder: true, start: true, idle: true, end: true, win: true });
function validateDailyPreferences(input) {
  const value = input?.preferences;
  if (!value || Array.isArray(value) || Object.keys(value).length !== 6 ||
    Object.keys(DEFAULT_DAILY_PREFERENCES).some(key => typeof value[key] !== "boolean")) {
    reject(400, "DAILY_NOTIFICATION_PREFERENCES", "Choose your Daily notification settings.");
  }
  return Object.fromEntries(Object.keys(DEFAULT_DAILY_PREFERENCES).map(key => [key, value[key]]));
}

function dailyNotices(room, now) {
  if (room.void) return [];
  const start = auctionStart(room), view = summary(room, null, now), end = Date.parse(view.auctionEndsAt);
  const notices = [];
  const add = (member, category, type, at, expiresAtMs, title, extra = {}) => {
    if (now < at || now >= expiresAtMs) return;
    const id = category === "reminder" ? `daily:reminder:${room.id}:${start}:${member.id}`
      : category === "win" ? `daily:won:${room.id}:${member.id}` : `daily:${category}:${room.id}:${start}:${member.id}`;
    notices.push({ id, roomId: room.id, userId: member.id, category, type, createdAtMs: at, expiresAtMs, title,
      messageData: { roomId: room.id, roomName: room.name, ...(category === "win" ? {} : { auctionStartsAt: new Date(start).toISOString() }), ...extra } });
  };
  if (!room.closed) for (const member of room.members) {
    if (room.mode !== "practice") add(member, "reminder", "daily_auction_reminder", start - 10 * MINUTE, start, "Auction starts soon");
    add(member, "start", "daily_auction_started", start, Math.min(start + 5 * MINUTE, end), "Auction is open");
    const signed = room.lots.some(lot => lot.endsAt <= now && lot.bids.reduce((a, b) => b.amount > a.amount ? b : a).userId === member.id);
    if (view.phase === "auction" && !signed) add(member, "idle", "daily_auction_idle", end - 15 * MINUTE, end - 14 * MINUTE,
      `${Math.ceil((end - now) / MINUTE)} minutes left — sign your first player`);
    add(member, "end", "daily_auction_ended", end, end + 30 * MINUTE, "Auction complete");
  }
  if (room.finished && room.finishedAt != null) for (const winner of room.winners) {
    add(winner, "win", "daily_room_won", room.finishedAt, room.finishedAt + 24 * 60 * MINUTE,
      room.winners.length > 1 ? "You tied for the win!" : "You won!", { points: winner.points, tied: room.winners.length > 1, winnerCount: room.winners.length });
  }
  return notices;
}

module.exports = { DEFAULT_DAILY_PREFERENCES, validateDailyPreferences, dailyNotices };
