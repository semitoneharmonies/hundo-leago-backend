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
  const memberships = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_memberships"),
  });
  let countAllStatement;
  let findActiveByUserStatement;
  let listUncoveredLeaguesStatement;
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
    listUncoveredLeaguesStatement = database.prepare(`
      SELECT leagues.id
      FROM leagues
      WHERE leagues.status <> 'deleted'
        AND NOT EXISTS (
          SELECT 1
          FROM league_memberships
          WHERE league_memberships.league_id = leagues.id
            AND league_memberships.user_id = @userId
            AND league_memberships.status = 'active'
        )
      ORDER BY leagues.id ASC
    `);
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
    listUncoveredLeagueIds(userId) {
      const stableUserId = assertStableId(userId);
      try {
        return Object.freeze(
          listUncoveredLeaguesStatement
            .all({ userId: stableUserId })
            .map(({ id }) => id)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listUncoveredPlatformAdministratorLeagues",
          tableName: "league_memberships",
        });
      }
    },
    insertProtectedLeagueMembership({
      id,
      leagueId,
      userId,
      nowMs,
    } = {}) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        invalid("A safe platform-role membership timestamp is required.");
      }
      return freezeRow(
        memberships.insert({
          id: assertStableId(id),
          league_id: assertStableId(leagueId),
          user_id: assertStableId(userId),
          permission_category: "member",
          status: "active",
          joined_at_ms: nowMs,
          ended_at_ms: null,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          version: 1,
        })
      );
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
