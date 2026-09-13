"use strict";

const {
  sha256Hex,
} = require("../shared/sha256");

const AUCTION_READ_INPUT_INVALID =
  "AUCTION_READ_INPUT_INVALID";
const DEFAULT_AUCTION_PAGE_SIZE = 50;
const MAXIMUM_AUCTION_PAGE_SIZE = 100;
const MAXIMUM_AUCTION_QUERY_CODE_POINTS = 200;
const MAXIMUM_AUCTION_CURSOR_CODE_POINTS = 1_024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const AUCTION_SOURCE_KINDS = Object.freeze([
  "ordinary_weekly",
  "fad_open_rapid",
  "fad_restricted",
]);
const AUCTION_PUBLIC_STATUSES = Object.freeze([
  "active",
  "resolved",
  "no_winner",
  "cancelled",
  "correction_required",
]);
const AUCTION_READ_ORDERS = Object.freeze([
  "resolves_asc",
  "resolved_desc",
  "updated_desc",
]);
const QUERY_FIELDS = Object.freeze([
  "cursor",
  "fadId",
  "limit",
  "q",
  "sourceKind",
  "status",
]);
const CURSOR_FIELDS = Object.freeze([
  "auctionId",
  "filterSha256",
  "order",
  "sortMs",
  "version",
]);

class AuctionReadPolicyError extends Error {
  constructor(reasonCode) {
    super("The auction read request is invalid.");
    this.name = "AuctionReadPolicyError";
    this.code = AUCTION_READ_INPUT_INVALID;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new AuctionReadPolicyError(reasonCode);
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactFields(value, fields) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (field, index) => field === expected[index]
    )
  );
}

function optionalSingleString(value, reasonCode) {
  if (value === undefined) return null;
  if (typeof value !== "string") fail(reasonCode);
  return value;
}

function normalizeSourceKind(value) {
  const sourceKind = optionalSingleString(
    value,
    "source_kind_invalid"
  );
  if (
    sourceKind !== null &&
    !AUCTION_SOURCE_KINDS.includes(sourceKind)
  ) {
    fail("source_kind_invalid");
  }
  return sourceKind;
}

function normalizeFadId(value, sourceKind) {
  const fadId = optionalSingleString(
    value,
    "fad_id_invalid"
  );
  if (
    fadId !== null &&
    (
      !UUID_PATTERN.test(fadId) ||
      sourceKind === "ordinary_weekly"
    )
  ) {
    fail("fad_id_invalid");
  }
  return fadId;
}

function normalizeStatuses(value) {
  if (value === undefined) {
    return Object.freeze(["active"]);
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.length < 1) fail("status_invalid");
  const selected = new Set();
  for (const status of values) {
    if (
      typeof status !== "string" ||
      status.length === 0 ||
      status.includes(",") ||
      !AUCTION_PUBLIC_STATUSES.includes(status)
    ) {
      fail("status_invalid");
    }
    selected.add(status);
  }
  return Object.freeze(
    AUCTION_PUBLIC_STATUSES.filter((status) =>
      selected.has(status)
    )
  );
}

function normalizeQueryText(value) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    CONTROL_PATTERN.test(value)
  ) {
    fail("query_invalid");
  }
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (
    Array.from(normalized).length >
    MAXIMUM_AUCTION_QUERY_CODE_POINTS
  ) {
    fail("query_invalid");
  }
  return normalized;
}

function normalizeLimit(value) {
  if (value === undefined) {
    return DEFAULT_AUCTION_PAGE_SIZE;
  }
  const source =
    typeof value === "number" &&
    Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (
    typeof source !== "string" ||
    !/^[1-9]\d*$/.test(source)
  ) {
    fail("limit_invalid");
  }
  const limit = Number(source);
  if (
    !Number.isSafeInteger(limit) ||
    limit > MAXIMUM_AUCTION_PAGE_SIZE
  ) {
    fail("limit_invalid");
  }
  return limit;
}

function auctionReadOrder(statuses) {
  if (
    statuses.length === 1 &&
    statuses[0] === "active"
  ) {
    return "resolves_asc";
  }
  if (!statuses.includes("active")) {
    return "resolved_desc";
  }
  return "updated_desc";
}

function filterProjection(query) {
  return {
    fadId: query.fadId,
    limit: query.limit,
    order: query.order,
    q: query.q,
    sourceKind: query.sourceKind,
    statuses: [...query.statuses],
  };
}

function filterSha256(query) {
  return sha256Hex(
    JSON.stringify(filterProjection(query))
  );
}

function decodeCursor(value, query) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Array.from(value).length >
      MAXIMUM_AUCTION_CURSOR_CODE_POINTS ||
    !BASE64URL_PATTERN.test(value)
  ) {
    fail("cursor_invalid");
  }
  let parsed;
  try {
    const json = Buffer.from(value, "base64url")
      .toString("utf8");
    if (
      Buffer.from(json, "utf8").toString("base64url") !==
      value
    ) {
      fail("cursor_invalid");
    }
    parsed = JSON.parse(json);
  } catch (error) {
    if (error instanceof AuctionReadPolicyError) {
      throw error;
    }
    fail("cursor_invalid");
  }
  if (
    !exactFields(parsed, CURSOR_FIELDS) ||
    parsed.version !== 1 ||
    !AUCTION_READ_ORDERS.includes(parsed.order) ||
    parsed.order !== query.order ||
    !SHA256_PATTERN.test(parsed.filterSha256 || "") ||
    parsed.filterSha256 !== filterSha256(query) ||
    !Number.isSafeInteger(parsed.sortMs) ||
    parsed.sortMs < 0 ||
    !UUID_PATTERN.test(parsed.auctionId || "")
  ) {
    fail("cursor_invalid");
  }
  return Object.freeze({
    sortMs: parsed.sortMs,
    auctionId: parsed.auctionId,
  });
}

function normalizeAuctionListQuery(value = {}) {
  if (!isPlainObject(value)) fail("query_fields_invalid");
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).some(
      (field) => !QUERY_FIELDS.includes(field)
    )
  ) {
    fail("query_fields_invalid");
  }
  const sourceKind = normalizeSourceKind(value.sourceKind);
  const fadId = normalizeFadId(value.fadId, sourceKind);
  const statuses = normalizeStatuses(value.status);
  const q = normalizeQueryText(value.q);
  const limit = normalizeLimit(value.limit);
  const order = auctionReadOrder(statuses);
  const withoutCursor = {
    sourceKind,
    fadId,
    statuses,
    q,
    limit,
    order,
  };
  const cursor = decodeCursor(value.cursor, withoutCursor);
  return Object.freeze({
    ...withoutCursor,
    cursor,
  });
}

function encodeAuctionReadCursor(query, {
  sortMs,
  auctionId,
} = {}) {
  if (
    !query ||
    !AUCTION_READ_ORDERS.includes(query.order) ||
    !Number.isSafeInteger(sortMs) ||
    sortMs < 0 ||
    !UUID_PATTERN.test(auctionId || "")
  ) {
    fail("cursor_value_invalid");
  }
  const cursor = {
    auctionId,
    filterSha256: filterSha256(query),
    order: query.order,
    sortMs,
    version: 1,
  };
  return Buffer.from(
    JSON.stringify(cursor),
    "utf8"
  ).toString("base64url");
}

module.exports = {
  AUCTION_PUBLIC_STATUSES,
  AUCTION_READ_INPUT_INVALID,
  AUCTION_READ_ORDERS,
  AUCTION_SOURCE_KINDS,
  AuctionReadPolicyError,
  DEFAULT_AUCTION_PAGE_SIZE,
  MAXIMUM_AUCTION_PAGE_SIZE,
  MAXIMUM_AUCTION_QUERY_CODE_POINTS,
  auctionReadOrder,
  encodeAuctionReadCursor,
  normalizeAuctionListQuery,
};
