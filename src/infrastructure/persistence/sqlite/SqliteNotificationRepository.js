const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical notification identifier is required."
    );
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe notification timestamp is required."
    );
  }
  return value;
}

function safeLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A notification page size from one through 100 is required."
    );
  }
  return value;
}

function safeReadStatus(value) {
  if (!["all", "read", "unread"].includes(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A valid notification read-status filter is required."
    );
  }
  return value;
}

function stableIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "One through 100 notification identifiers are required."
    );
  }
  const ids = value.map(stableId);
  if (new Set(ids).size !== ids.length) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Notification identifiers must be unique."
    );
  }
  return ids;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteNotificationRepository({ database } = {}) {
  let listFirstStatement;
  let listAfterStatement;
  let findOwnedStatement;
  let markReadStatement;
  let markAllReadStatement;
  try {
    const columns = `
      id, user_id, league_id, event_type, message_data_json,
      related_feature, related_record_id, delivery_status,
      created_at_ms, read_at_ms, delivered_at_ms, version
    `;
    listFirstStatement = database.prepare(`
      SELECT ${columns}
      FROM notifications
      WHERE user_id = @userId
        AND (
          @readStatus = 'all'
          OR (@readStatus = 'read' AND read_at_ms IS NOT NULL)
          OR (@readStatus = 'unread' AND read_at_ms IS NULL)
        )
      ORDER BY created_at_ms DESC, id DESC
      LIMIT @fetchLimit
    `);
    listAfterStatement = database.prepare(`
      SELECT ${columns}
      FROM notifications
      WHERE user_id = @userId
        AND (
          @readStatus = 'all'
          OR (@readStatus = 'read' AND read_at_ms IS NOT NULL)
          OR (@readStatus = 'unread' AND read_at_ms IS NULL)
        )
        AND (
          created_at_ms < @cursorOccurredAtMs
          OR (
            created_at_ms = @cursorOccurredAtMs
            AND id < @cursorId
          )
        )
      ORDER BY created_at_ms DESC, id DESC
      LIMIT @fetchLimit
    `);
    findOwnedStatement = database.prepare(`
      SELECT ${columns}
      FROM notifications
      WHERE id = @notificationId AND user_id = @userId
      LIMIT 2
    `);
    markReadStatement = database.prepare(`
      UPDATE notifications
      SET read_at_ms = @readAtMs, version = version + 1
      WHERE id = @notificationId
        AND user_id = @userId
        AND read_at_ms IS NULL
    `);
    markAllReadStatement = database.prepare(`
      UPDATE notifications
      SET read_at_ms = @readAtMs, version = version + 1
      WHERE user_id = @userId AND read_at_ms IS NULL
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareNotificationRepository",
      tableName: "notifications",
    });
  }

  function findOwned(parameters) {
    const rows = findOwnedStatement.all(parameters);
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "A notification owner lookup was not unique."
      );
    }
    return freezeRow(rows[0]);
  }

  const markBatchReadTransaction = database.transaction(
    ({ notificationIds, userId, readAtMs }) => {
      const rows = notificationIds.map((notificationId) =>
        findOwned({ notificationId, userId })
      );
      if (rows.some((row) => row === null)) return null;
      let changedCount = 0;
      for (const row of rows) {
        if (row.read_at_ms === null) {
          changedCount += markReadStatement.run({
            notificationId: row.id,
            userId,
            readAtMs,
          }).changes;
        }
      }
      return Object.freeze({
        changedCount,
        notificationIds: Object.freeze([...notificationIds]),
        readAtMs,
      });
    }
  );

  return Object.freeze({
    listPage({ userId, limit, cursor, readStatus = "all" } = {}) {
      const parameters = {
        userId: stableId(userId),
        fetchLimit: safeLimit(limit) + 1,
        readStatus: safeReadStatus(readStatus),
        ...(cursor
          ? {
              cursorOccurredAtMs: safeTimestamp(cursor.occurredAtMs),
              cursorId: stableId(cursor.id),
            }
          : {}),
      };
      try {
        const rows = (cursor ? listAfterStatement : listFirstStatement).all(
          parameters
        );
        return Object.freeze({
          hasMore: rows.length > limit,
          rows: Object.freeze(rows.slice(0, limit).map(freezeRow)),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listOwnedNotifications",
          tableName: "notifications",
        });
      }
    },
    markBatchRead({ notificationIds, userId, readAtMs } = {}) {
      const parameters = {
        notificationIds: stableIds(notificationIds),
        userId: stableId(userId),
        readAtMs: safeTimestamp(readAtMs),
      };
      try {
        return markBatchReadTransaction(parameters);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "markOwnedNotificationBatchRead",
          tableName: "notifications",
        });
      }
    },
    markAllRead({ userId, readAtMs } = {}) {
      const parameters = {
        userId: stableId(userId),
        readAtMs: safeTimestamp(readAtMs),
      };
      try {
        return Object.freeze({
          changedCount: markAllReadStatement.run(parameters).changes,
          readAtMs: parameters.readAtMs,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "markAllNotificationsRead",
          tableName: "notifications",
        });
      }
    },
    markRead({ notificationId, userId, readAtMs } = {}) {
      const parameters = {
        notificationId: stableId(notificationId),
        userId: stableId(userId),
        readAtMs: safeTimestamp(readAtMs),
      };
      try {
        const before = findOwned(parameters);
        if (!before) return null;
        if (before.read_at_ms === null) markReadStatement.run(parameters);
        return findOwned(parameters);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "markOwnedNotificationRead",
          tableName: "notifications",
        });
      }
    },
  });
}

module.exports = { createSqliteNotificationRepository };
