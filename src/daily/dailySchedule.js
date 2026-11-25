"use strict";

const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
const DURATION = 30 * MINUTE;

function auctionStartOptions(_date, firstGameAt, now) {
  const options = [];
  if (!Number.isSafeInteger(firstGameAt) || !Number.isSafeInteger(now)) return options;
  // The auction may precede its game day. UTC quarters keep historical Pacific
  // clock changes exact while always starting strictly after room creation.
  for (let at = (Math.floor(now / QUARTER) + 1) * QUARTER; at + DURATION <= firstGameAt; at += QUARTER) {
    options.push(new Date(at).toISOString());
  }
  return options;
}

function parseAuctionStart(value) {
  if (value === undefined) return undefined; // Existing clients retain their puck-drop-based room time.
  const at = typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(at) || at % QUARTER !== 0) {
    throw Object.assign(new Error("Choose an auction start on a 15-minute interval."), { status: 400, code: "DAILY_START_INVALID" });
  }
  return at;
}

function validateAuctionStart(at, slate, now) {
  if (at !== undefined && (!Number.isSafeInteger(at) || at % QUARTER !== 0 || at <= now ||
      at + DURATION > slate.firstGameAt)) {
    throw Object.assign(new Error("Choose a future start at least 30 minutes before the first game."),
      { status: 409, code: "DAILY_START_UNAVAILABLE" });
  }
}

module.exports = { auctionStartOptions, parseAuctionStart, validateAuctionStart };
