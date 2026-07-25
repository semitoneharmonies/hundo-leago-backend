const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

const ACTIVITY_CODES = Object.freeze({
  cursorInvalid: "ACTIVITY_CURSOR_INVALID",
  inputInvalid: "ACTIVITY_INPUT_INVALID",
  notificationNotFound: "NOTIFICATION_NOT_FOUND",
});

class ActivityPolicyError extends Error {
  constructor(reasonCode) {
    super("The activity or notification request is invalid.");
    this.name = "ActivityPolicyError";
    this.code = reasonCode;
    this.reasonCode = reasonCode;
  }
}

function fail(code) {
  throw new ActivityPolicyError(code);
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(ACTIVITY_CODES.inputInvalid);
  }
  return value;
}

function pageSize(value) {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    fail(ACTIVITY_CODES.inputInvalid);
  }
  return parsed;
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 256) {
    fail(ACTIVITY_CODES.cursorInvalid);
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail(ACTIVITY_CODES.cursorInvalid);
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    !Number.isSafeInteger(decoded[0]) ||
    decoded[0] < 0 ||
    typeof decoded[1] !== "string" ||
    !UUID_PATTERN.test(decoded[1])
  ) {
    fail(ACTIVITY_CODES.cursorInvalid);
  }
  return Object.freeze({ occurredAtMs: decoded[0], id: decoded[1] });
}

function encodeCursor({ occurredAtMs, id } = {}) {
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
    fail(ACTIVITY_CODES.cursorInvalid);
  }
  return Buffer.from(JSON.stringify([occurredAtMs, stableId(id)]), "utf8")
    .toString("base64url");
}

function validatePageInput(input = {}) {
  const keys = Object.keys(input).sort();
  if (keys.some((key) => !["cursor", "limit"].includes(key))) {
    fail(ACTIVITY_CODES.inputInvalid);
  }
  return Object.freeze({
    limit: pageSize(input.limit),
    cursor: decodeCursor(input.cursor),
  });
}

function validateNotificationId(value) {
  return stableId(value);
}

module.exports = {
  ACTIVITY_CODES,
  ActivityPolicyError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  validateNotificationId,
  validatePageInput,
};
