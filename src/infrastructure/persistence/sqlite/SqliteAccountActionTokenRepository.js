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
const PURPOSES = Object.freeze([
  "email_verification",
  "administrator_setup",
  "password_reset",
  "self_reactivation",
]);
const TOKEN_COLUMNS = Object.freeze([
  "id",
  "user_id",
  "token_digest",
  "purpose",
  "status",
  "created_at_ms",
  "expires_at_ms",
  "consumed_at_ms",
  "invalidated_at_ms",
  "failed_attempt_count",
  "version",
]);
const SELECT_COLUMNS = TOKEN_COLUMNS.join(", ");

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function assertId(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    invalid("A stable action-token identifier is required.");
  }
  return value;
}

function assertTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid("A safe action-token timestamp is required.");
  }
  return value;
}

function assertVersion(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid("A positive action-token version is required.");
  }
  return value;
}

function assertPurpose(value) {
  if (!PURPOSES.includes(value)) {
    invalid("An approved action-token purpose is required.");
  }
  return value;
}

function assertDigest(value) {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    invalid("A canonical action-token digest is required.");
  }
  return value;
}

function assertActiveRecord(record) {
  if (
    !isPlainObject(record) ||
    record.status !== "active" ||
    record.consumed_at_ms !== null ||
    record.invalidated_at_ms !== null ||
    record.failed_attempt_count !== 0
  ) {
    invalid("An active schema-shaped action token is required.");
  }
  assertId(record.id);
  assertId(record.user_id);
  assertDigest(record.token_digest);
  assertPurpose(record.purpose);
  assertTimestamp(record.created_at_ms);
  assertTimestamp(record.expires_at_ms);
  if (record.expires_at_ms <= record.created_at_ms) {
    invalid("The action-token expiry is invalid.");
  }
  assertVersion(record.version);
  return record;
}

function assertExact(options, keys) {
  if (!isPlainObject(options)) {
    invalid("Action-token repository options are required.");
  }
  const expected = new Set(keys);
  if (
    Object.keys(options).length !== expected.size ||
    Object.keys(options).some(
      (key) => !expected.has(key)
    )
  ) {
    invalid("Action-token repository options are invalid.");
  }
  return options;
}

function runHook(hook, context) {
  if (hook === null) return;
  if (typeof hook !== "function") {
    invalid("The action-token transaction hook is invalid.");
  }
  const result = hook(Object.freeze(context));
  if (
    result &&
    typeof result.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      "Action-token transaction hooks must be synchronous."
    );
  }
}

function createSqliteAccountActionTokenRepository({
  database,
} = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition(
      "account_action_tokens"
    ),
  });

  let findByDigest;
  let findActive;
  let replaceTransaction;
  let transitionTransaction;
  try {
    findByDigest = database.prepare(
      `SELECT ${SELECT_COLUMNS} ` +
        "FROM account_action_tokens " +
        "WHERE token_digest = @digest"
    );
    findActive = database.prepare(
      `SELECT ${SELECT_COLUMNS} ` +
        "FROM account_action_tokens " +
        "WHERE user_id = @userId " +
        "AND purpose = @purpose " +
        "AND status = 'active'"
    );
    replaceTransaction = database.transaction(
      ({
        replacement,
        replacedAtMs,
        hook,
      }) => {
        const current = findActive.get({
          userId: replacement.user_id,
          purpose: replacement.purpose,
        });
        let previous = null;
        if (current) {
          previous = records.updateVersioned({
            key: current.id,
            expectedVersion: current.version,
            changes: {
              status: "invalidated",
              invalidated_at_ms: replacedAtMs,
            },
          });
        }
        const active = records.insert(replacement);
        runHook(hook, {
          activeTokenId: active.id,
          previousTokenId: previous?.id || null,
          purpose: active.purpose,
          userId: active.user_id,
        });
        return Object.freeze({
          active: freezeRow(active),
          previous: freezeRow(previous),
        });
      }
    );
    transitionTransaction = database.transaction(
      ({
        tokenId,
        expectedVersion,
        changedAtMs,
        status,
        hook,
      }) => {
        const current = records.requireByKey({
          key: tokenId,
        });
        if (current.status !== "active") {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.recordNotFound,
            "The active action token does not exist."
          );
        }
        const changes = { status };
        if (status === "consumed") {
          changes.consumed_at_ms = changedAtMs;
        } else if (status === "invalidated") {
          changes.invalidated_at_ms = changedAtMs;
        }
        const updated = records.updateVersioned({
          key: tokenId,
          expectedVersion,
          changes,
        });
        runHook(hook, {
          purpose: current.purpose,
          status,
          tokenId,
          userId: current.user_id,
        });
        return freezeRow(updated);
      }
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareActionTokenRepository",
      tableName: "account_action_tokens",
    });
  }

  function transition(options, status) {
    assertExact(options, [
      "tokenId",
      "expectedVersion",
      "changedAtMs",
      "transactionHook",
    ]);
    const tokenId = assertId(options.tokenId);
    const expectedVersion = assertVersion(
      options.expectedVersion
    );
    const changedAtMs = assertTimestamp(
      options.changedAtMs
    );
    if (
      options.transactionHook !== null &&
      typeof options.transactionHook !== "function"
    ) {
      invalid("The action-token transaction hook is invalid.");
    }
    try {
      return transitionTransaction.immediate({
        tokenId,
        expectedVersion,
        changedAtMs,
        status,
        hook: options.transactionHook,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: `${status}ActionToken`,
        tableName: "account_action_tokens",
      });
    }
  }

  return Object.freeze({
    findById(tokenId) {
      return freezeRow(
        records.findByKey({
          key: assertId(tokenId),
        })
      );
    },
    findByDigest(tokenDigest) {
      const digest = assertDigest(tokenDigest);
      try {
        return freezeRow(
          findByDigest.get({ digest })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActionTokenByDigest",
          tableName: "account_action_tokens",
        });
      }
    },
    findActiveByUserPurpose(userId, purpose) {
      const stableUserId = assertId(userId);
      const approvedPurpose =
        assertPurpose(purpose);
      try {
        return freezeRow(
          findActive.get({
            userId: stableUserId,
            purpose: approvedPurpose,
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveActionToken",
          tableName: "account_action_tokens",
        });
      }
    },
    replaceActive(options) {
      assertExact(options, [
        "replacement",
        "replacedAtMs",
        "transactionHook",
      ]);
      const replacement = assertActiveRecord(
        options.replacement
      );
      const replacedAtMs = assertTimestamp(
        options.replacedAtMs
      );
      if (
        options.transactionHook !== null &&
        typeof options.transactionHook !== "function"
      ) {
        invalid("The action-token transaction hook is invalid.");
      }
      try {
        return replaceTransaction.immediate({
          replacement,
          replacedAtMs,
          hook: options.transactionHook,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "replaceActiveActionToken",
          tableName: "account_action_tokens",
        });
      }
    },
    consumeActive(options) {
      return transition(options, "consumed");
    },
    invalidateActive(options) {
      return transition(options, "invalidated");
    },
    expireActive(options) {
      return transition(options, "expired");
    },
    incrementFailedAttempt({
      tokenId,
      expectedVersion,
    } = {}) {
      const current = records.requireByKey({
        key: assertId(tokenId),
      });
      if (current.status !== "active") {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "The active action token does not exist."
        );
      }
      return freezeRow(
        records.updateVersioned({
          key: current.id,
          expectedVersion:
            assertVersion(expectedVersion),
          changes: {
            failed_attempt_count:
              current.failed_attempt_count + 1,
          },
        })
      );
    },
  });
}

module.exports = {
  DIGEST_PATTERN,
  PURPOSES,
  TOKEN_COLUMNS,
  createSqliteAccountActionTokenRepository,
};
