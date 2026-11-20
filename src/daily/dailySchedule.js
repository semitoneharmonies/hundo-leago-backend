"use strict";

const { vancouverDate } = require("./vancouverDate");
const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
const DURATION = 30 * MINUTE;

function auctionStartOptions(date, firstGameAt, now) {
  const midnight = Date.parse(date + "T00:00:00Z");
  const options = [];
  // Iterate UTC instants so repeated or missing historical Pacific hours remain exact.
  for (let at = midnight; at < midnight + 36 * 60 * MINUTE; at += QUARTER) {
    if (at > now && at + DURATION <= firstGameAt && vancouverDate(at) === date) options.push(new Date(at).toISOString());
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
      vancouverDate(at) !== slate.date || at + DURATION > slate.firstGameAt)) {
    throw Object.assign(new Error("Choose a future start on the game day, at least 30 minutes before the first game."),
      { status: 409, code: "DAILY_START_UNAVAILABLE" });
  }
}

module.exports = { auctionStartOptions, parseAuctionStart, validateAuctionStart };
