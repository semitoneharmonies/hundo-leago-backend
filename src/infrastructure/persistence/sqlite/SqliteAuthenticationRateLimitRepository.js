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
const ACTION_PATTERN =
  /^[a-z][a-z0-9_]{0,63}$/;
const RATE_LIMIT_COLUMNS = Object.freeze([
  "id",
  "action",
  "key_version",
  "bucket_digest",
  "window_started_at_ms",
  "window_ends_at_ms",
  "attempt_count",
  "failure_count",
  "blocked_until_ms",
  "updated_at_ms",
  "version",
]);
const SELECT_COLUMNS =
  RATE_LIMIT_COLUMNS.join(", ");

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function assertIdentity({
  action,
  keyVersion,
  bucketDigest,
  windowStartedAtMs,
} = {}) {
  if (
    typeof action !== "string" ||
    !ACTION_PATTERN.test(action) ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion < 1 ||
    typeof bucketDigest !== "string" ||
    !DIGEST_PATTERN.test(bucketDigest) ||
    !Number.isSafeInteger(windowStartedAtMs) ||
    windowStartedAtMs < 0
  ) {
    invalid("A canonical rate-limit window identity is required.");
  }
  return {
    action,
    keyVersion,
    bucketDigest,
    windowStartedAtMs,
  };
}

function assertRecordAttempt(options) {
  if (
    !isPlainObject(options) ||
    typeof options.id !== "string" ||
    options.id.trim() === ""
  ) {
    invalid("Exact rate-limit attempt options are required.");
  }
  const identity = assertIdentity(options);
  if (
    !Number.isSafeInteger(
      options.windowEndsAtMs
    ) ||
    options.windowEndsAtMs <=
      identity.windowStartedAtMs ||
    !Number.isSafeInteger(options.nowMs) ||
    options.nowMs <
      identity.windowStartedAtMs ||
    options.nowMs >=
      options.windowEndsAtMs ||
    typeof options.failed !== "boolean" ||
    !["attempt_count", "failure_count"].includes(
      options.blockCounter
    ) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1
  ) {
    invalid("Valid rate-limit attempt values are required.");
  }
  return {
    ...identity,
    id: options.id,
    windowEndsAtMs: options.windowEndsAtMs,
    nowMs: options.nowMs,
    failed: options.failed,
    blockCounter: options.blockCounter,
    limit: options.limit,
  };
}

function createSqliteAuthenticationRateLimitRepository({
  database,
} = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition(
      "authentication_rate_limits"
    ),
  });
  let findWindow;
  let recordTransaction;
  let cleanupStatement;
  try {
    findWindow = database.prepare(
      `SELECT ${SELECT_COLUMNS} ` +
        "FROM authentication_rate_limits " +
        "WHERE action = @action " +
        "AND key_version = @keyVersion " +
        "AND bucket_digest = @bucketDigest " +
        "AND window_started_at_ms = @windowStartedAtMs"
    );
    recordTransaction = database.transaction(
      (options) => {
        const current = findWindow.get(options);
        const currentCount =
          options.blockCounter ===
          "failure_count"
            ? current?.failure_count || 0
            : current?.attempt_count || 0;
        if (
          current &&
          (current.blocked_until_ms >
            options.nowMs ||
            currentCount >= options.limit)
        ) {
          return Object.freeze({
            allowed: false,
            recorded: false,
            row: freezeRow(current),
          });
        }
        if (!current) {
          const attemptCount = 1;
          const failureCount =
            options.failed ? 1 : 0;
          const relevantCount =
            options.blockCounter ===
            "failure_count"
              ? failureCount
              : attemptCount;
          return Object.freeze({
            allowed: true,
            recorded: true,
            row: freezeRow(
              records.insert({
              id: options.id,
              action: options.action,
              key_version:
                options.keyVersion,
              bucket_digest:
                options.bucketDigest,
              window_started_at_ms:
                options.windowStartedAtMs,
              window_ends_at_ms:
                options.windowEndsAtMs,
              attempt_count: attemptCount,
              failure_count: failureCount,
              blocked_until_ms:
                relevantCount >= options.limit
                  ? options.windowEndsAtMs
                  : null,
              updated_at_ms: options.nowMs,
              version: 1,
              })
            ),
          });
        }
        if (
          current.window_ends_at_ms !==
          options.windowEndsAtMs
        ) {
          invalid("The rate-limit window is inconsistent.");
        }
        const attemptCount =
          current.attempt_count + 1;
        const failureCount =
          current.failure_count +
          (options.failed ? 1 : 0);
        const relevantCount =
          options.blockCounter ===
          "failure_count"
            ? failureCount
            : attemptCount;
        return Object.freeze({
          allowed: true,
          recorded: true,
          row: freezeRow(
            records.updateVersioned({
            key: current.id,
            expectedVersion: current.version,
            changes: {
              attempt_count: attemptCount,
              failure_count: failureCount,
              blocked_until_ms:
                relevantCount >= options.limit
                  ? options.windowEndsAtMs
                  : current.blocked_until_ms,
              updated_at_ms: options.nowMs,
            },
            })
          ),
        });
      }
    );
    cleanupStatement = database.prepare(
      "DELETE FROM authentication_rate_limits " +
        "WHERE id IN (" +
        "SELECT id FROM authentication_rate_limits " +
        "WHERE window_ends_at_ms <= @nowMs " +
        "ORDER BY window_ends_at_ms ASC, id ASC " +
        "LIMIT @limit)"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareAuthenticationRateLimitRepository",
      tableName: "authentication_rate_limits",
    });
  }

  return Object.freeze({
    findWindow(options) {
      const identity = assertIdentity(options);
      try {
        return freezeRow(
          findWindow.get(identity)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findAuthenticationRateLimitWindow",
          tableName: "authentication_rate_limits",
        });
      }
    },
    recordAttempt(options) {
      const validated =
        assertRecordAttempt(options);
      try {
        return recordTransaction.immediate(
          validated
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "recordAuthenticationRateLimitAttempt",
          tableName: "authentication_rate_limits",
        });
      }
    },
    clearFailures({
      id,
      expectedVersion,
      nowMs,
    } = {}) {
      if (
        typeof id !== "string" ||
        id.trim() === "" ||
        !Number.isSafeInteger(
          expectedVersion
        ) ||
        expectedVersion < 1 ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0
      ) {
        invalid("Valid rate-limit clearing values are required.");
      }
      return freezeRow(
        records.updateVersioned({
          key: id,
          expectedVersion,
          changes: {
            failure_count: 0,
            blocked_until_ms: null,
            updated_at_ms: nowMs,
          },
        })
      );
    },
    cleanupExpired({ nowMs, limit } = {}) {
      if (
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      ) {
        invalid("A bounded rate-limit cleanup is required.");
      }
      try {
        return cleanupStatement.run({
          nowMs,
          limit,
        }).changes;
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "cleanupAuthenticationRateLimits",
          tableName: "authentication_rate_limits",
        });
      }
    },
  });
}

module.exports = {
  ACTION_PATTERN,
  DIGEST_PATTERN,
  RATE_LIMIT_COLUMNS,
  createSqliteAuthenticationRateLimitRepository,
};
