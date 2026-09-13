const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SESSION_ABSOLUTE_LIFETIME_MS = 7 * DAY_MS;
const SESSION_IDLE_LIFETIME_MS = 12 * HOUR_MS;
const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const SESSION_POLICY_CODES = Object.freeze({
  active: "SESSION_ACTIVE",
  revoked: "SESSION_REVOKED",
  expired: "SESSION_EXPIRED",
  idleExpired: "SESSION_IDLE_EXPIRED",
  absoluteExpired: "SESSION_ABSOLUTE_EXPIRED",
  malformed: "SESSION_RECORD_INVALID",
  clockInvalid: "SESSION_CLOCK_INVALID",
});

class SessionPolicyError extends Error {
  constructor(reasonCode) {
    super("The session lifecycle state is invalid.");
    this.name = "SessionPolicyError";
    this.code = "SESSION_POLICY_INVALID";
    this.reasonCode = reasonCode;
  }
}

function assertTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new SessionPolicyError(reasonCode);
  }
  return value;
}

function safeAdd(timestamp, duration) {
  const result = timestamp + duration;
  if (!Number.isSafeInteger(result)) {
    throw new SessionPolicyError(
      SESSION_POLICY_CODES.clockInvalid
    );
  }
  return result;
}

function createSessionDeadlines(createdAtMs) {
  const createdAt = assertTimestamp(
    createdAtMs,
    SESSION_POLICY_CODES.clockInvalid
  );
  const absoluteExpiresAtMs = safeAdd(
    createdAt,
    SESSION_ABSOLUTE_LIFETIME_MS
  );
  const idleExpiresAtMs = Math.min(
    safeAdd(
      createdAt,
      SESSION_IDLE_LIFETIME_MS
    ),
    absoluteExpiresAtMs
  );

  return Object.freeze({
    createdAtMs: createdAt,
    lastUsedAtMs: createdAt,
    idleExpiresAtMs,
    absoluteExpiresAtMs,
  });
}

function assertSessionTiming(session) {
  if (
    session === null ||
    typeof session !== "object" ||
    Array.isArray(session)
  ) {
    throw new SessionPolicyError(
      SESSION_POLICY_CODES.malformed
    );
  }

  const createdAtMs = assertTimestamp(
    session.created_at_ms,
    SESSION_POLICY_CODES.malformed
  );
  const lastUsedAtMs = assertTimestamp(
    session.last_used_at_ms,
    SESSION_POLICY_CODES.malformed
  );
  const idleExpiresAtMs = assertTimestamp(
    session.idle_expires_at_ms,
    SESSION_POLICY_CODES.malformed
  );
  const absoluteExpiresAtMs = assertTimestamp(
    session.absolute_expires_at_ms,
    SESSION_POLICY_CODES.malformed
  );

  if (
    lastUsedAtMs < createdAtMs ||
    idleExpiresAtMs <= createdAtMs ||
    absoluteExpiresAtMs < idleExpiresAtMs ||
    lastUsedAtMs >= absoluteExpiresAtMs
  ) {
    throw new SessionPolicyError(
      SESSION_POLICY_CODES.malformed
    );
  }

  if (
    !["active", "revoked", "expired"].includes(
      session.status
    )
  ) {
    throw new SessionPolicyError(
      SESSION_POLICY_CODES.malformed
    );
  }

  return Object.freeze({
    createdAtMs,
    lastUsedAtMs,
    idleExpiresAtMs,
    absoluteExpiresAtMs,
    status: session.status,
  });
}

function evaluateSession(session, nowMs) {
  const timing = assertSessionTiming(session);
  const now = assertTimestamp(
    nowMs,
    SESSION_POLICY_CODES.clockInvalid
  );

  if (now < timing.createdAtMs) {
    throw new SessionPolicyError(
      SESSION_POLICY_CODES.clockInvalid
    );
  }
  if (timing.status === "revoked") {
    return Object.freeze({
      valid: false,
      reasonCode: SESSION_POLICY_CODES.revoked,
      persistRefresh: false,
    });
  }
  if (timing.status === "expired") {
    return Object.freeze({
      valid: false,
      reasonCode: SESSION_POLICY_CODES.expired,
      persistRefresh: false,
    });
  }
  if (now >= timing.absoluteExpiresAtMs) {
    return Object.freeze({
      valid: false,
      reasonCode:
        SESSION_POLICY_CODES.absoluteExpired,
      persistRefresh: false,
    });
  }
  if (now >= timing.idleExpiresAtMs) {
    return Object.freeze({
      valid: false,
      reasonCode:
        SESSION_POLICY_CODES.idleExpired,
      persistRefresh: false,
    });
  }

  const persistRefresh =
    now - timing.lastUsedAtMs >=
    SESSION_REFRESH_INTERVAL_MS;
  const refresh = persistRefresh
    ? Object.freeze({
        lastUsedAtMs: now,
        idleExpiresAtMs: Math.min(
          safeAdd(
            now,
            SESSION_IDLE_LIFETIME_MS
          ),
          timing.absoluteExpiresAtMs
        ),
      })
    : null;

  return Object.freeze({
    valid: true,
    reasonCode: SESSION_POLICY_CODES.active,
    persistRefresh,
    refresh,
  });
}

module.exports = {
  DAY_MS,
  HOUR_MS,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_LIFETIME_MS,
  SESSION_POLICY_CODES,
  SESSION_REFRESH_INTERVAL_MS,
  SessionPolicyError,
  assertSessionTiming,
  createSessionDeadlines,
  evaluateSession,
};
