const {
  SESSION_POLICY_CODES,
  createSessionDeadlines,
  evaluateSession,
} = require(
  "../../../domain/accounts/sessionPolicy"
);
const REPOSITORY_VERSION_CONFLICT =
  "REPOSITORY_VERSION_CONFLICT";
const REPOSITORY_RECORD_NOT_FOUND =
  "REPOSITORY_RECORD_NOT_FOUND";

const INVALID_SESSION_RESULT = Object.freeze({
  valid: false,
  code: "SESSION_INVALID",
});
const INVALID_CSRF_RESULT = Object.freeze({
  valid: false,
  code: "CSRF_INVALID",
});

const CLIENT_METADATA_KEYS = Object.freeze([
  "networkSourceCategory",
  "origin",
  "userAgentFamily",
  "userAgentHash",
]);
const NETWORK_SOURCE_CATEGORIES = new Set([
  "direct",
  "trusted_proxy",
  "local",
  "unknown",
]);

class SessionServiceError extends Error {
  constructor(code) {
    super("The session operation could not be completed.");
    this.name = "SessionServiceError";
    this.code = code;
  }
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

function serializeClientMetadata(metadata) {
  if (metadata === null) return null;
  if (!isPlainObject(metadata)) {
    throw new SessionServiceError(
      "SESSION_CLIENT_METADATA_INVALID"
    );
  }
  const keys = Object.keys(metadata).sort();
  if (
    keys.some(
      (key) => !CLIENT_METADATA_KEYS.includes(key)
    )
  ) {
    throw new SessionServiceError(
      "SESSION_CLIENT_METADATA_INVALID"
    );
  }

  const output = {};
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== "string") {
      throw new SessionServiceError(
        "SESSION_CLIENT_METADATA_INVALID"
      );
    }
    if (key === "origin") {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new SessionServiceError(
          "SESSION_CLIENT_METADATA_INVALID"
        );
      }
      if (
        !["http:", "https:"].includes(
          parsed.protocol
        ) ||
        parsed.origin !== value ||
        value.length > 256
      ) {
        throw new SessionServiceError(
          "SESSION_CLIENT_METADATA_INVALID"
        );
      }
    } else if (
      key === "userAgentFamily" &&
      (value.length < 1 ||
        value.length > 64 ||
        !/^[A-Za-z0-9 ._/-]+$/.test(value))
    ) {
      throw new SessionServiceError(
        "SESSION_CLIENT_METADATA_INVALID"
      );
    } else if (
      key === "userAgentHash" &&
      !/^[0-9a-f]{64}$/.test(value)
    ) {
      throw new SessionServiceError(
        "SESSION_CLIENT_METADATA_INVALID"
      );
    } else if (
      key === "networkSourceCategory" &&
      !NETWORK_SOURCE_CATEGORIES.has(value)
    ) {
      throw new SessionServiceError(
        "SESSION_CLIENT_METADATA_INVALID"
      );
    }
    output[key] = value;
  }

  return JSON.stringify(output);
}

function safeSession(row) {
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    status: row.status,
    createdAtMs: row.created_at_ms,
    lastUsedAtMs: row.last_used_at_ms,
    idleExpiresAtMs: row.idle_expires_at_ms,
    absoluteExpiresAtMs:
      row.absolute_expires_at_ms,
    version: row.version,
  });
}

function safeUser(user) {
  return Object.freeze({
    id: user.id,
    displayName: user.display_name,
    status: user.status,
    version: user.version,
  });
}

function createInternalIssueResult({
  session,
  previousSessionId,
  rawSessionToken,
  rawCsrfToken,
}) {
  const result = {
    kind: "internal_session_issue",
    session,
    previousSessionId,
  };
  for (const [key, value] of Object.entries({
    rawSessionToken,
    rawCsrfToken,
  })) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function createSafeResolution(session, user) {
  return Object.freeze({
    valid: true,
    code: "SESSION_VALID",
    session: safeSession(session),
    user: safeUser(user),
  });
}

function createInternalBootstrapResult(
  resolution,
  rawCsrfToken
) {
  const result = {
    kind: "internal_session_bootstrap",
    ...resolution,
  };
  Object.defineProperty(result, "rawCsrfToken", {
    configurable: false,
    enumerable: false,
    value: rawCsrfToken,
    writable: false,
  });
  return Object.freeze(result);
}

function createSessionService({
  userRepository,
  sessionRepository,
  sessionSecrets,
  clock,
  secureRandom,
} = {}) {
  if (
    !userRepository ||
    typeof userRepository.findById !== "function"
  ) {
    throw new TypeError(
      "createSessionService requires a user repository"
    );
  }
  for (const method of [
    "findByTokenDigest",
    "replaceActive",
    "refreshActive",
    "revokeActive",
    "expireActive",
  ]) {
    if (
      !sessionRepository ||
      typeof sessionRepository[method] !==
        "function"
    ) {
      throw new TypeError(
        "createSessionService requires a session repository"
      );
    }
  }
  if (
    !sessionSecrets ||
    typeof sessionSecrets.generate !== "function" ||
    typeof sessionSecrets.digest !== "function" ||
    typeof sessionSecrets.deriveCsrf !==
      "function" ||
    typeof sessionSecrets.verifyCsrf !==
      "function"
  ) {
    throw new TypeError(
      "createSessionService requires session secrets"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "createSessionService requires a clock"
    );
  }
  if (
    !secureRandom ||
    typeof secureRandom.id !== "function"
  ) {
    throw new TypeError(
      "createSessionService requires secure randomness"
    );
  }

  function issueForUser({
    userId,
    clientMetadata = null,
    transactionHook = null,
  } = {}) {
    const user = userRepository.findById(userId);
    if (!user || user.status !== "active") {
      throw new SessionServiceError(
        "SESSION_ISSUE_DENIED"
      );
    }
    if (
      transactionHook !== null &&
      typeof transactionHook !== "function"
    ) {
      throw new SessionServiceError(
        "SESSION_TRANSACTION_HOOK_INVALID"
      );
    }

    const nowMs = clock.nowMs();
    const deadlines =
      createSessionDeadlines(nowMs);
    const metadataJson =
      serializeClientMetadata(clientMetadata);
    const secrets = sessionSecrets.generate();
    const sessionId = secureRandom.id();
    const replacement = {
      id: sessionId,
      user_id: user.id,
      token_digest:
        secrets.sessionTokenDigest,
      csrf_secret_digest:
        secrets.csrfTokenDigest,
      status: "active",
      created_at_ms: deadlines.createdAtMs,
      last_used_at_ms:
        deadlines.lastUsedAtMs,
      idle_expires_at_ms:
        deadlines.idleExpiresAtMs,
      absolute_expires_at_ms:
        deadlines.absoluteExpiresAtMs,
      revoked_at_ms: null,
      revocation_reason: null,
      client_metadata_json: metadataJson,
      version: 1,
    };
    const stored = sessionRepository.replaceActive({
      replacement,
      replacedAtMs: nowMs,
      transactionHook,
    });

    return createInternalIssueResult({
      session: safeSession(stored.active),
      previousSessionId:
        stored.previous?.id || null,
      rawSessionToken:
        secrets.rawSessionToken,
      rawCsrfToken: secrets.rawCsrfToken,
    });
  }

  function markExpired(session, evaluation, nowMs) {
    const reason =
      evaluation.reasonCode ===
      SESSION_POLICY_CODES.absoluteExpired
        ? "absolute_expired"
        : "idle_expired";
    try {
      sessionRepository.expireActive({
        sessionId: session.id,
        expectedVersion: session.version,
        changedAtMs: nowMs,
        reason,
        transactionHook: null,
      });
    } catch (error) {
      if (
        ![
          REPOSITORY_VERSION_CONFLICT,
          REPOSITORY_RECORD_NOT_FOUND,
        ].includes(error?.code)
      ) {
        throw error;
      }
    }
  }

  function resolveInternal(
    rawSessionToken,
    {
      persistActivity = true,
      persistExpiry = true,
    } = {}
  ) {
    let digest;
    try {
      digest = sessionSecrets.digest(
        rawSessionToken
      );
    } catch {
      return INVALID_SESSION_RESULT;
    }

    let session =
      sessionRepository.findByTokenDigest(digest);
    if (!session) return INVALID_SESSION_RESULT;

    const nowMs = clock.nowMs();
    let evaluation;
    try {
      evaluation = evaluateSession(
        session,
        nowMs
      );
    } catch {
      return INVALID_SESSION_RESULT;
    }
    if (!evaluation.valid) {
      if (
        persistExpiry &&
        session.status === "active" &&
        [
          SESSION_POLICY_CODES.absoluteExpired,
          SESSION_POLICY_CODES.idleExpired,
        ].includes(evaluation.reasonCode)
      ) {
        markExpired(session, evaluation, nowMs);
      }
      return INVALID_SESSION_RESULT;
    }

    const user = userRepository.findById(
      session.user_id
    );
    if (!user || user.status !== "active") {
      return INVALID_SESSION_RESULT;
    }

    if (
      evaluation.persistRefresh &&
      persistActivity
    ) {
      try {
        session =
          sessionRepository.refreshActive({
            sessionId: session.id,
            expectedVersion: session.version,
            lastUsedAtMs:
              evaluation.refresh.lastUsedAtMs,
            idleExpiresAtMs:
              evaluation.refresh
                .idleExpiresAtMs,
          });
      } catch (error) {
        if (
          error?.code !==
          REPOSITORY_VERSION_CONFLICT
        ) {
          throw error;
        }
        session =
          sessionRepository.findByTokenDigest(
            digest
          );
        if (!session) {
          return INVALID_SESSION_RESULT;
        }
        try {
          evaluation = evaluateSession(
            session,
            nowMs
          );
        } catch {
          return INVALID_SESSION_RESULT;
        }
        if (!evaluation.valid) {
          return INVALID_SESSION_RESULT;
        }
      }
    }

    return Object.freeze({
      valid: true,
      code: "SESSION_VALID",
      session,
      user,
    });
  }

  function resolve(rawSessionToken) {
    const resolution =
      resolveInternal(rawSessionToken);
    if (!resolution.valid) return resolution;
    return createSafeResolution(
      resolution.session,
      resolution.user
    );
  }

  function resolveWithoutActivity(rawSessionToken) {
    const resolution = resolveInternal(
      rawSessionToken,
      {
        persistActivity: false,
        persistExpiry: false,
      }
    );
    if (!resolution.valid) return resolution;
    return createSafeResolution(
      resolution.session,
      resolution.user
    );
  }

  function bootstrap(rawSessionToken) {
    const resolution =
      resolveInternal(rawSessionToken, {
        persistActivity: false,
      });
    if (!resolution.valid) return resolution;

    let rawCsrfToken;
    try {
      rawCsrfToken =
        sessionSecrets.deriveCsrf(
          rawSessionToken
        );
    } catch {
      return INVALID_SESSION_RESULT;
    }
    if (
      !sessionSecrets.verifyCsrf({
        rawSessionToken,
        rawCsrfToken,
        storedDigest:
          resolution.session.csrf_secret_digest,
      })
    ) {
      return INVALID_SESSION_RESULT;
    }

    return createInternalBootstrapResult(
      createSafeResolution(
        resolution.session,
        resolution.user
      ),
      rawCsrfToken
    );
  }

  function resolveWithCsrf({
    rawSessionToken,
    rawCsrfToken,
  } = {}) {
    const resolution =
      resolveInternal(rawSessionToken);
    if (!resolution.valid) return resolution;

    if (
      !sessionSecrets.verifyCsrf({
        rawSessionToken,
        rawCsrfToken,
        storedDigest:
          resolution.session.csrf_secret_digest,
      })
    ) {
      return INVALID_CSRF_RESULT;
    }
    return createSafeResolution(
      resolution.session,
      resolution.user
    );
  }

  function revoke({
    sessionId,
    expectedVersion,
    reason,
    transactionHook = null,
  } = {}) {
    const revoked = sessionRepository.revokeActive({
      sessionId,
      expectedVersion,
      changedAtMs: clock.nowMs(),
      reason,
      transactionHook,
    });
    return safeSession(revoked);
  }

  return Object.freeze({
    bootstrap,
    issueForUser,
    resolve,
    resolveWithoutActivity,
    resolveWithCsrf,
    revoke,
  });
}

module.exports = {
  CLIENT_METADATA_KEYS,
  INVALID_CSRF_RESULT,
  INVALID_SESSION_RESULT,
  NETWORK_SOURCE_CATEGORIES,
  SessionServiceError,
  createSessionService,
  serializeClientMetadata,
};
