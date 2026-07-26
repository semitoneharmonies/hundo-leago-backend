const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const USER_COLUMNS = Object.freeze([
  "id",
  "email_normalized",
  "email_display",
  "display_name",
  "display_name_normalized",
  "status",
  "created_at_ms",
  "updated_at_ms",
  "version",
]);
const USER_SELECT_SQL = USER_COLUMNS.join(", ");

function assertCanonicalLookup(
  value,
  field,
  { minimum, maximum }
) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
    value !== value.toLowerCase()
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical user lookup value is required.",
      { details: { field } }
    );
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteUserRepository({
  database,
} = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("users"),
  });

  let findByEmailStatement;
  let findByDisplayNameStatement;
  let listSafeUsersStatement;
  try {
    findByEmailStatement = database.prepare(
      `SELECT ${USER_SELECT_SQL} FROM users ` +
        "WHERE email_normalized = @value"
    );
    findByDisplayNameStatement = database.prepare(
      `SELECT ${USER_SELECT_SQL} FROM users ` +
        "WHERE display_name_normalized = @value"
    );
    listSafeUsersStatement = database.prepare(
      `SELECT ${USER_SELECT_SQL} FROM users ` +
        "WHERE status IN ('active', 'pending_credential_setup') " +
        "ORDER BY display_name_normalized ASC, id ASC"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareSpecializedLookups",
      tableName: "users",
    });
  }

  function runLookup(statement, value, field) {
    try {
      return freezeRow(statement.get({ value }));
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: field,
        tableName: "users",
      });
    }
  }

  return Object.freeze({
    findById(userId) {
      return freezeRow(
        records.findByKey({ key: userId })
      );
    },
    findByNormalizedEmail(emailNormalized) {
      const value = assertCanonicalLookup(
        emailNormalized,
        "email_normalized",
        { minimum: 3, maximum: 320 }
      );
      return runLookup(
        findByEmailStatement,
        value,
        "findByNormalizedEmail"
      );
    },
    findByNormalizedDisplayName(
      displayNameNormalized
    ) {
      const value = assertCanonicalLookup(
        displayNameNormalized,
        "display_name_normalized",
        { minimum: 1, maximum: 100 }
      );
      return runLookup(
        findByDisplayNameStatement,
        value,
        "findByNormalizedDisplayName"
      );
    },
    listSafeUsers() {
      try {
        return Object.freeze(
          listSafeUsersStatement
            .all()
            .map((row) => Object.freeze({ ...row }))
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listSafeUsers",
          tableName: "users",
        });
      }
    },
    insert(record) {
      return freezeRow(records.insert(record));
    },
    updateVersioned(options) {
      return freezeRow(
        records.updateVersioned(options)
      );
    },
  });
}

module.exports = {
  USER_COLUMNS,
  assertCanonicalLookup,
  createSqliteUserRepository,
};
