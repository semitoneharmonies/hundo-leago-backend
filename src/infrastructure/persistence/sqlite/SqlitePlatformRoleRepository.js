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

const PLATFORM_ROLE_COLUMNS = Object.freeze([
  "id",
  "user_id",
  "role",
  "status",
  "granted_by_user_id",
  "granted_at_ms",
  "ended_at_ms",
  "version",
]);
const SELECT_COLUMNS = PLATFORM_ROLE_COLUMNS.join(", ");

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function assertStableId(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    invalid("A stable platform-role identifier is required.");
  }
  return value;
}

function assertActivePlatformRole(record) {
  if (
    !isPlainObject(record) ||
    Object.keys(record).length !==
      PLATFORM_ROLE_COLUMNS.length ||
    Object.keys(record).some(
      (key) => !PLATFORM_ROLE_COLUMNS.includes(key)
    ) ||
    record.role !== "platform_administrator" ||
    record.status !== "active" ||
    record.ended_at_ms !== null ||
    (record.granted_by_user_id !== null &&
      (typeof record.granted_by_user_id !== "string" ||
        record.granted_by_user_id.trim() === "")) ||
    !Number.isSafeInteger(record.granted_at_ms) ||
    record.granted_at_ms < 0 ||
    record.version !== 1
  ) {
    invalid("An active schema-shaped platform role is required.");
  }
  assertStableId(record.id);
  assertStableId(record.user_id);
  return record;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqlitePlatformRoleRepository({
  database,
} = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("platform_roles"),
  });
  let countAllStatement;
  let findActiveByUserStatement;
  try {
    countAllStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM platform_roles
      WHERE role = 'platform_administrator'
    `);
    findActiveByUserStatement = database.prepare(
      `SELECT ${SELECT_COLUMNS} ` +
        "FROM platform_roles " +
        "WHERE user_id = @userId " +
        "AND role = 'platform_administrator' " +
        "AND status = 'active'"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "preparePlatformRoleRepository",
      tableName: "platform_roles",
    });
  }

  return Object.freeze({
    countPlatformAdministratorHistory() {
      try {
        return countAllStatement.get().count;
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "countPlatformAdministratorHistory",
          tableName: "platform_roles",
        });
      }
    },
    findActiveByUserId(userId) {
      const stableUserId = assertStableId(userId);
      try {
        return freezeRow(
          findActiveByUserStatement.get({
            userId: stableUserId,
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActivePlatformAdministratorByUserId",
          tableName: "platform_roles",
        });
      }
    },
    insertActive(record) {
      return freezeRow(
        records.insert(
          assertActivePlatformRole(record)
        )
      );
    },
  });
}

module.exports = {
  PLATFORM_ROLE_COLUMNS,
  assertActivePlatformRole,
  createSqlitePlatformRoleRepository,
};
