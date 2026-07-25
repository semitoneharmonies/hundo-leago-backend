const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
  isPlainObject,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_COLUMNS = Object.freeze([
  "id",
  "user_id",
  "token_digest",
  "csrf_secret_digest",
  "status",
  "created_at_ms",
  "last_used_at_ms",
  "idle_expires_at_ms",
  "absolute_expires_at_ms",
  "revoked_at_ms",
  "revocation_reason",
  "client_metadata_json",
  "version",
]);
const SESSION_SELECT_SQL =
  SESSION_COLUMNS.join(", ");

const REVOCATION_REASONS = Object.freeze([
  "sign_out",
  "replaced_by_login",
  "password_change",
  "password_reset",
  "account_deactivation",
  "platform_safety_disable",
  "platform_security_action",
]);
const EXPIRY_REASONS = Object.freeze([
  "idle_expired",
  "absolute_expired",
]);

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function assertStableId(value, field) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A stable session identifier is required.",
      { details: { field } }
    );
  }
  return value;
}

function assertDigest(value, field) {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical session digest is required.",
      { details: { field } }
    );
  }
  return value;
}

function assertTimestamp(value, field) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe session timestamp is required.",
      { details: { field } }
    );
  }
  return value;
}

function assertClientMetadata(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 2048
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Session client metadata is invalid."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Session client metadata is invalid."
    );
  }
  if (!isPlainObject(parsed)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Session client metadata is invalid."
    );
  }
  return value;
}

function assertActiveSession(record) {
  if (
    !isPlainObject(record) ||
    record.status !== "active" ||
    record.revoked_at_ms !== null ||
    record.revocation_reason !== null
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An active schema-shaped session is required."
    );
  }
  assertStableId(record.id, "id");
  assertStableId(record.user_id, "user_id");
  assertDigest(record.token_digest, "token_digest");
  assertDigest(
    record.csrf_secret_digest,
    "csrf_secret_digest"
  );
  assertTimestamp(record.created_at_ms, "created_at_ms");
  assertTimestamp(
    record.last_used_at_ms,
    "last_used_at_ms"
  );
  assertTimestamp(
    record.idle_expires_at_ms,
    "idle_expires_at_ms"
  );
  assertTimestamp(
    record.absolute_expires_at_ms,
    "absolute_expires_at_ms"
  );
  assertClientMetadata(record.client_metadata_json);
  return record;
}

function assertExactOptions(options, keys) {
  if (!isPlainObject(options)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Session repository options are required."
    );
  }
  const expected = new Set(keys);
  if (
    Object.keys(options).length !== expected.size ||
    Object.keys(options).some(
      (key) => !expected.has(key)
    )
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Session repository options are invalid."
    );
  }
  return options;
}

function runTransactionHook(hook, context) {
  if (hook === null) return;
  if (typeof hook !== "function") {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A session transaction hook must be a function or null."
    );
  }
  const result = hook(Object.freeze(context));
  if (
    result &&
    (typeof result === "object" ||
      typeof result === "function") &&
    typeof result.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      "Session transaction hooks must complete synchronously."
    );
  }
}

function createSqliteSessionRepository({
  database,
} = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("sessions"),
  });

  let findByDigestStatement;
  let findActiveByUserStatement;
  let replaceTransaction;
  let transitionTransaction;
  let refreshTransaction;

  try {
    findByDigestStatement = database.prepare(
      `SELECT ${SESSION_SELECT_SQL} FROM sessions ` +
        "WHERE token_digest = @digest"
    );
    findActiveByUserStatement = database.prepare(
      `SELECT ${SESSION_SELECT_SQL} FROM sessions ` +
        "WHERE user_id = @userId AND status = 'active'"
    );

    replaceTransaction = database.transaction(
      ({ replacement, replacedAtMs, hook }) => {
        const current = findActiveByUserStatement.get({
          userId: replacement.user_id,
        });
        let previous = null;
        if (current) {
          previous = records.updateVersioned({
            key: current.id,
            expectedVersion: current.version,
            changes: {
              status: "revoked",
              revoked_at_ms: replacedAtMs,
              revocation_reason:
                "replaced_by_login",
            },
          });
        }

        const active = records.insert(replacement);
        runTransactionHook(hook, {
          userId: replacement.user_id,
          previousSessionId: previous?.id || null,
          activeSessionId: active.id,
        });
        return Object.freeze({
          previous: freezeRow(previous),
          active: freezeRow(active),
        });
      }
    );

    transitionTransaction = database.transaction(
      ({
        sessionId,
        expectedVersion,
        changedAtMs,
        status,
        reason,
        hook,
      }) => {
        const current = records.requireByKey({
          key: sessionId,
        });
        if (current.status !== "active") {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.recordNotFound,
            "The active session does not exist."
          );
        }
        const updated = records.updateVersioned({
          key: sessionId,
          expectedVersion,
          changes: {
            status,
            revoked_at_ms: changedAtMs,
            revocation_reason: reason,
          },
        });
        runTransactionHook(hook, {
          userId: current.user_id,
          sessionId,
          status,
          reason,
        });
        return freezeRow(updated);
      }
    );

    refreshTransaction = database.transaction(
      ({
        sessionId,
        expectedVersion,
        lastUsedAtMs,
        idleExpiresAtMs,
      }) => {
        const current = records.requireByKey({
          key: sessionId,
        });
        if (
          current.status !== "active" ||
          lastUsedAtMs < current.last_used_at_ms ||
          idleExpiresAtMs <= lastUsedAtMs ||
          idleExpiresAtMs >
            current.absolute_expires_at_ms
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "The active session refresh is invalid."
          );
        }
        return freezeRow(
          records.updateVersioned({
            key: sessionId,
            expectedVersion,
            changes: {
              last_used_at_ms: lastUsedAtMs,
              idle_expires_at_ms: idleExpiresAtMs,
            },
          })
        );
      }
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareSessionRepository",
      tableName: "sessions",
    });
  }

  function transition(options, {
    status,
    allowedReasons,
  }) {
    assertExactOptions(options, [
      "sessionId",
      "expectedVersion",
      "changedAtMs",
      "reason",
      "transactionHook",
    ]);
    const sessionId = assertStableId(
      options.sessionId,
      "sessionId"
    );
    if (
      !Number.isSafeInteger(options.expectedVersion) ||
      options.expectedVersion < 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A positive session version is required."
      );
    }
    const changedAtMs = assertTimestamp(
      options.changedAtMs,
      "changedAtMs"
    );
    if (!allowedReasons.includes(options.reason)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "An approved session transition reason is required."
      );
    }
    if (
      options.transactionHook !== null &&
      typeof options.transactionHook !== "function"
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A session transaction hook must be a function or null."
      );
    }

    try {
      return transitionTransaction.immediate({
        sessionId,
        expectedVersion: options.expectedVersion,
        changedAtMs,
        status,
        reason: options.reason,
        hook: options.transactionHook,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          status === "expired"
            ? "expireActive"
            : "revokeActive",
        tableName: "sessions",
      });
    }
  }

  return Object.freeze({
    findById(sessionId) {
      return freezeRow(
        records.findByKey({
          key: sessionId,
        })
      );
    },
    findByTokenDigest(tokenDigest) {
      const digest = assertDigest(
        tokenDigest,
        "tokenDigest"
      );
      try {
        return freezeRow(
          findByDigestStatement.get({ digest })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findByTokenDigest",
          tableName: "sessions",
        });
      }
    },
    findActiveByUserId(userId) {
      const stableUserId = assertStableId(
        userId,
        "userId"
      );
      try {
        return freezeRow(
          findActiveByUserStatement.get({
            userId: stableUserId,
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveByUserId",
          tableName: "sessions",
        });
      }
    },
    insertActive(record) {
      assertActiveSession(record);
      return freezeRow(records.insert(record));
    },
    replaceActive(options) {
      assertExactOptions(options, [
        "replacement",
        "replacedAtMs",
        "transactionHook",
      ]);
      assertActiveSession(options.replacement);
      const replacedAtMs = assertTimestamp(
        options.replacedAtMs,
        "replacedAtMs"
      );
      if (
        options.transactionHook !== null &&
        typeof options.transactionHook !==
          "function"
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A session transaction hook must be a function or null."
        );
      }

      try {
        return replaceTransaction.immediate({
          replacement: options.replacement,
          replacedAtMs,
          hook: options.transactionHook,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "replaceActive",
          tableName: "sessions",
        });
      }
    },
    revokeActive(options) {
      return transition(options, {
        status: "revoked",
        allowedReasons: REVOCATION_REASONS,
      });
    },
    expireActive(options) {
      return transition(options, {
        status: "expired",
        allowedReasons: EXPIRY_REASONS,
      });
    },
    refreshActive(options) {
      assertExactOptions(options, [
        "sessionId",
        "expectedVersion",
        "lastUsedAtMs",
        "idleExpiresAtMs",
      ]);
      const sessionId = assertStableId(
        options.sessionId,
        "sessionId"
      );
      if (
        !Number.isSafeInteger(options.expectedVersion) ||
        options.expectedVersion < 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A positive session version is required."
        );
      }
      const lastUsedAtMs = assertTimestamp(
        options.lastUsedAtMs,
        "lastUsedAtMs"
      );
      const idleExpiresAtMs = assertTimestamp(
        options.idleExpiresAtMs,
        "idleExpiresAtMs"
      );

      try {
        return refreshTransaction.immediate({
          sessionId,
          expectedVersion:
            options.expectedVersion,
          lastUsedAtMs,
          idleExpiresAtMs,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "refreshActive",
          tableName: "sessions",
        });
      }
    },
  });
}

module.exports = {
  DIGEST_PATTERN,
  EXPIRY_REASONS,
  REVOCATION_REASONS,
  SESSION_COLUMNS,
  assertActiveSession,
  createSqliteSessionRepository,
};
