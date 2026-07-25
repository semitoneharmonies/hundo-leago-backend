const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const ACTION_TOKEN_LIFETIMES_MS =
  Object.freeze({
    email_verification: 24 * HOUR_MS,
    administrator_setup: 72 * HOUR_MS,
    password_reset: 30 * MINUTE_MS,
    self_reactivation: 30 * MINUTE_MS,
  });
const ACTION_TOKEN_PURPOSES = Object.freeze(
  Object.keys(ACTION_TOKEN_LIFETIMES_MS)
);
const ACTIVE_ACTION_TOKEN_STATUS = "active";

const INVALID_ACTION_TOKEN_RESULT =
  Object.freeze({
    valid: false,
    code: "ACTION_TOKEN_INVALID",
  });

function assertTimestamp(value, field) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `${field} must be a safe UTC timestamp`
    );
  }
  return value;
}

function actionTokenLifetimeMs(purpose) {
  const lifetime =
    ACTION_TOKEN_LIFETIMES_MS[purpose];
  if (lifetime === undefined) {
    throw new TypeError(
      "an approved action-token purpose is required"
    );
  }
  return lifetime;
}

function createActionTokenDeadline(
  purpose,
  createdAtMs
) {
  const created = assertTimestamp(
    createdAtMs,
    "createdAtMs"
  );
  const expiresAtMs =
    created + actionTokenLifetimeMs(purpose);
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new TypeError(
      "action-token expiry is outside the safe range"
    );
  }
  return Object.freeze({
    createdAtMs: created,
    expiresAtMs,
  });
}

function evaluateActionToken(
  record,
  expectedPurpose,
  nowMs
) {
  const now = assertTimestamp(nowMs, "nowMs");
  if (
    !record ||
    typeof record !== "object" ||
    !ACTION_TOKEN_PURPOSES.includes(
      expectedPurpose
    ) ||
    record.purpose !== expectedPurpose ||
    record.status !== ACTIVE_ACTION_TOKEN_STATUS ||
    !Number.isSafeInteger(record.created_at_ms) ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.created_at_ms < 0 ||
    record.expires_at_ms <=
      record.created_at_ms ||
    record.consumed_at_ms !== null ||
    record.invalidated_at_ms !== null ||
    now >= record.expires_at_ms
  ) {
    return INVALID_ACTION_TOKEN_RESULT;
  }
  return Object.freeze({
    valid: true,
    code: "ACTION_TOKEN_VALID",
    expiresAtMs: record.expires_at_ms,
  });
}

module.exports = {
  ACTION_TOKEN_LIFETIMES_MS,
  ACTION_TOKEN_PURPOSES,
  ACTIVE_ACTION_TOKEN_STATUS,
  HOUR_MS,
  INVALID_ACTION_TOKEN_RESULT,
  MINUTE_MS,
  actionTokenLifetimeMs,
  createActionTokenDeadline,
  evaluateActionToken,
};
