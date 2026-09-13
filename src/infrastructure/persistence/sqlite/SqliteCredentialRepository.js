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

const CREDENTIAL_COLUMNS = Object.freeze([
  "id",
  "user_id",
  "password_hash",
  "algorithm",
  "algorithm_version",
  "status",
  "created_at_ms",
  "replaced_at_ms",
  "version",
]);
const CREDENTIAL_SELECT_SQL =
  CREDENTIAL_COLUMNS.join(", ");

function assertStableId(value, field) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A stable credential lookup ID is required.",
      { details: { field } }
    );
  }
  return value;
}

function assertActiveCredential(record) {
  if (
    !isPlainObject(record) ||
    record.status !== "active" ||
    record.algorithm !== "scrypt" ||
    record.algorithm_version !== 1 ||
    record.replaced_at_ms !== null
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An active schema-shaped credential is required."
    );
  }
  return record;
}

function assertReplacementOptions(options) {
  if (!isPlainObject(options)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Credential replacement options are required."
    );
  }
  const approvedKeys = new Set([
    "currentCredentialId",
    "expectedVersion",
    "replacedAtMs",
    "replacement",
  ]);
  if (
    Object.keys(options).length !==
      approvedKeys.size ||
    Object.keys(options).some(
      (key) => !approvedKeys.has(key)
    )
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Credential replacement options are invalid."
    );
  }

  assertStableId(
    options.currentCredentialId,
    "currentCredentialId"
  );
  if (
    !Number.isSafeInteger(options.expectedVersion) ||
    options.expectedVersion < 1
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A positive expected credential version is required."
    );
  }
  if (
    !Number.isSafeInteger(options.replacedAtMs) ||
    options.replacedAtMs < 0
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe replacement timestamp is required."
    );
  }
  assertActiveCredential(options.replacement);
  return options;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteCredentialRepository({
  database,
} = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition(
      "user_credentials"
    ),
  });

  let findActiveStatement;
  let executeReplacement;
  try {
    findActiveStatement = database.prepare(
      `SELECT ${CREDENTIAL_SELECT_SQL} ` +
        "FROM user_credentials " +
        "WHERE user_id = @userId AND status = 'active'"
    );
    executeReplacement = database.transaction(
      (options) => {
        const current = records.requireByKey({
          key: options.currentCredentialId,
        });
        if (
          current.status !== "active" ||
          current.user_id !==
            options.replacement.user_id ||
          current.id === options.replacement.id
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "The active credential cannot be replaced by the supplied record."
          );
        }

        const previous = records.updateVersioned({
          key: current.id,
          expectedVersion:
            options.expectedVersion,
          changes: {
            status: "replaced",
            replaced_at_ms:
              options.replacedAtMs,
          },
        });
        const active = records.insert(
          options.replacement
        );

        return Object.freeze({
          previous: freezeRow(previous),
          active: freezeRow(active),
        });
      }
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCredentialRepository",
      tableName: "user_credentials",
    });
  }

  return Object.freeze({
    findById(credentialId) {
      return freezeRow(
        records.findByKey({
          key: credentialId,
        })
      );
    },
    findActiveByUserId(userId) {
      const stableUserId = assertStableId(
        userId,
        "userId"
      );
      try {
        return freezeRow(
          findActiveStatement.get({
            userId: stableUserId,
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveByUserId",
          tableName: "user_credentials",
        });
      }
    },
    insertActive(record) {
      assertActiveCredential(record);
      return freezeRow(records.insert(record));
    },
    replaceActive(options) {
      const validated =
        assertReplacementOptions(options);
      try {
        return executeReplacement.immediate(
          validated
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "replaceActive",
          tableName: "user_credentials",
        });
      }
    },
  });
}

module.exports = {
  CREDENTIAL_COLUMNS,
  assertActiveCredential,
  createSqliteCredentialRepository,
};
