"use strict";

const {
  sha256Hex,
} = require("../shared/sha256");

const {
  parseCandidateCardSlotKey,
} = require("./candidateCardPolicy");

const CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID =
  "CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID";
const DEFAULT_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE =
  50;
const MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE =
  100;
const MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS =
  200;
const MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_CURSOR_CODE_POINTS =
  1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function containsControl(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 8_232 ||
      codePoint === 8_233
    );
  });
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CARD_IDENTITY_FIELDS = Object.freeze([
  "fadId",
  "leagueId",
  "teamId",
]);
const QUERY_FIELDS = Object.freeze([
  "cursor",
  "limit",
  "q",
  "slotKey",
]);
const CURSOR_FIELDS = Object.freeze([
  "filterSha256",
  "playerId",
  "sortName",
  "version",
]);

class CandidateEligiblePlayerSearchPolicyError extends Error {
  constructor(reasonCode) {
    super(
      "The Candidate eligible-player search request is invalid."
    );
    this.name =
      "CandidateEligiblePlayerSearchPolicyError";
    this.code =
      CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new CandidateEligiblePlayerSearchPolicyError(
    reasonCode
  );
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

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function normalizeSearchText(value) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    containsControl(value)
  ) {
    fail("query_invalid");
  }
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (
    Array.from(normalized).length >
    MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS
  ) {
    fail("query_invalid");
  }
  return normalized;
}

function normalizeLimit(value) {
  if (value === undefined) {
    return DEFAULT_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE;
  }
  const source =
    typeof value === "number" &&
    Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (
    typeof source !== "string" ||
    !/^[1-9]\d*$/u.test(source)
  ) {
    fail("limit_invalid");
  }
  const limit = Number(source);
  if (
    !Number.isSafeInteger(limit) ||
    limit >
      MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE
  ) {
    fail("limit_invalid");
  }
  return limit;
}

function filterProjection(query) {
  return {
    fadId: query.fadId,
    leagueId: query.leagueId,
    limit: query.limit,
    q: query.q,
    slotKey: query.slotKey,
    teamId: query.teamId,
  };
}

function filterSha256(query) {
  return sha256Hex(
    JSON.stringify(filterProjection(query))
  );
}

function normalizeSortName(value) {
  const normalized =
    normalizeCandidateEligiblePlayerName(
      value
    );
  if (normalized !== value) {
    fail("cursor_value_invalid");
  }
  return normalized;
}

function normalizeCandidateEligiblePlayerName(
  value
) {
  if (
    typeof value !== "string" ||
    containsControl(value)
  ) {
    fail("cursor_value_invalid");
  }
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (
    normalized.length < 1 ||
    Array.from(normalized).length >
      MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS
  ) {
    fail("cursor_value_invalid");
  }
  return normalized;
}

function decodeCursor(value, query) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Array.from(value).length >
      MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_CURSOR_CODE_POINTS ||
    !BASE64URL_PATTERN.test(value)
  ) {
    fail("cursor_invalid");
  }
  let parsed;
  try {
    const json = Buffer.from(
      value,
      "base64url"
    ).toString("utf8");
    if (
      Buffer.from(json, "utf8").toString(
        "base64url"
      ) !== value
    ) {
      fail("cursor_invalid");
    }
    parsed = JSON.parse(json);
  } catch (error) {
    if (
      error instanceof
      CandidateEligiblePlayerSearchPolicyError
    ) {
      throw error;
    }
    fail("cursor_invalid");
  }
  if (
    !exactFields(parsed, CURSOR_FIELDS) ||
    parsed.version !== 1 ||
    !SHA256_PATTERN.test(
      parsed.filterSha256 || ""
    ) ||
    parsed.filterSha256 !==
      filterSha256(query) ||
    !UUID_PATTERN.test(parsed.playerId || "")
  ) {
    fail("cursor_invalid");
  }
  let sortName;
  try {
    sortName = normalizeSortName(
      parsed.sortName
    );
  } catch (error) {
    fail("cursor_invalid");
  }
  return Object.freeze({
    sortName,
    playerId: parsed.playerId,
  });
}

function normalizeCandidateEligiblePlayerQuery(
  value = {},
  cardIdentity
) {
  if (!isPlainObject(value)) {
    fail("query_fields_invalid");
  }
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).some(
      (field) => !QUERY_FIELDS.includes(field)
    ) ||
    !("slotKey" in value)
  ) {
    fail("query_fields_invalid");
  }
  if (
    !exactFields(
      cardIdentity,
      CARD_IDENTITY_FIELDS
    )
  ) {
    fail("card_identity_invalid");
  }
  const leagueId = stableId(
    cardIdentity.leagueId,
    "card_identity_invalid"
  );
  const fadId = stableId(
    cardIdentity.fadId,
    "card_identity_invalid"
  );
  const teamId = stableId(
    cardIdentity.teamId,
    "card_identity_invalid"
  );
  let slot;
  try {
    slot = parseCandidateCardSlotKey(
      value.slotKey
    );
  } catch (error) {
    fail("slot_key_invalid");
  }
  const q = normalizeSearchText(value.q);
  const limit = normalizeLimit(value.limit);
  const withoutCursor = Object.freeze({
    leagueId,
    fadId,
    teamId,
    slotKey: slot.slotKey,
    q,
    limit,
  });
  return Object.freeze({
    ...withoutCursor,
    cursor: decodeCursor(
      value.cursor,
      withoutCursor
    ),
  });
}

function encodeCandidateEligiblePlayerCursor(
  query,
  { sortName, playerId } = {}
) {
  if (
    !query ||
    !UUID_PATTERN.test(query.leagueId || "") ||
    !UUID_PATTERN.test(query.fadId || "") ||
    !UUID_PATTERN.test(query.teamId || "") ||
    typeof query.slotKey !== "string" ||
    typeof query.q !== "string" ||
    !Number.isSafeInteger(query.limit)
  ) {
    fail("cursor_value_invalid");
  }
  try {
    parseCandidateCardSlotKey(query.slotKey);
  } catch (error) {
    fail("cursor_value_invalid");
  }
  const canonicalSortName =
    normalizeSortName(sortName);
  const canonicalPlayerId = stableId(
    playerId,
    "cursor_value_invalid"
  );
  return Buffer.from(
    JSON.stringify({
      filterSha256: filterSha256(query),
      playerId: canonicalPlayerId,
      sortName: canonicalSortName,
      version: 1,
    }),
    "utf8"
  ).toString("base64url");
}

module.exports = {
  CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID,
  CandidateEligiblePlayerSearchPolicyError,
  DEFAULT_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE,
  MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_CURSOR_CODE_POINTS,
  MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE,
  MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS,
  encodeCandidateEligiblePlayerCursor,
  normalizeCandidateEligiblePlayerName,
  normalizeCandidateEligiblePlayerSearchText:
    normalizeSearchText,
  normalizeCandidateEligiblePlayerSortName:
    normalizeSortName,
  normalizeCandidateEligiblePlayerQuery,
};
