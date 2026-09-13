const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_TOKEN_PATTERN =
  /^[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/;
const DELIVERY_STATUSES = new Set([
  "pending",
  "delivered",
  "failed",
  "suppressed",
]);
const INPUT_KEYS = Object.freeze(
  [
    "createdAtMs",
    "deduplicationKey",
    "deliveredAtMs",
    "deliveryStatus",
    "eventType",
    "id",
    "leagueId",
    "messageDataJson",
    "relatedFeature",
    "relatedRecordId",
    "userId",
  ].sort()
);
const SELECT_COLUMNS = `
  id, user_id, league_id, event_type, message_data_json,
  related_feature, related_record_id, delivery_status,
  created_at_ms, read_at_ms, delivered_at_ms, version,
  deduplication_key
`;
const LOGICAL_COLUMNS = Object.freeze([
  "league_id",
  "message_data_json",
  "related_feature",
  "related_record_id",
  "delivery_status",
  "created_at_ms",
  "delivered_at_ms",
]);

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
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

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function optionalId(value, description) {
  return value === null
    ? null
    : canonicalId(value, description);
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function optionalTimestamp(value, description) {
  return value === null
    ? null
    : safeTimestamp(value, description);
}

function safeToken(value, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    value !== value.trim() ||
    !SAFE_TOKEN_PATTERN.test(value)
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function messageDataJson(value) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 100_000
  ) {
    invalid("Bounded notification message data is required.");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid("Valid notification message data is required.");
  }
  if (!isPlainObject(parsed)) {
    invalid("Notification message data must be a JSON object.");
  }
  return value;
}

function deduplicationKey(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value !== value.trim()
  ) {
    invalid(
      "A bounded trimmed notification deduplication key is required."
    );
  }
  return value;
}

function assertExactInput(command) {
  if (!isPlainObject(command)) {
    invalid("An exact notification write command is required.");
  }
  const keys = Object.keys(command).sort();
  if (
    keys.length !== INPUT_KEYS.length ||
    keys.some((key, index) => key !== INPUT_KEYS[index])
  ) {
    invalid("An exact notification write command is required.");
  }
}

function normalize(command) {
  assertExactInput(command);
  const createdAtMs = safeTimestamp(
    command.createdAtMs,
    "notification creation timestamp"
  );
  const deliveredAtMs = optionalTimestamp(
    command.deliveredAtMs,
    "notification delivery timestamp"
  );
  if (
    deliveredAtMs !== null &&
    deliveredAtMs < createdAtMs
  ) {
    invalid(
      "A notification cannot be delivered before it is created."
    );
  }
  if (
    !DELIVERY_STATUSES.has(command.deliveryStatus) ||
    (
      command.deliveryStatus === "delivered"
    ) !== (
      deliveredAtMs !== null
    )
  ) {
    invalid(
      "Notification delivery status and timestamp are inconsistent."
    );
  }

  const relatedFeature =
    command.relatedFeature === null
      ? null
      : safeToken(
          command.relatedFeature,
          "notification related feature"
        );
  const relatedRecordId = optionalId(
    command.relatedRecordId,
    "notification related-record identifier"
  );
  if (
    (relatedFeature === null) !==
    (relatedRecordId === null)
  ) {
    invalid(
      "Notification related feature and record must be provided together."
    );
  }

  return Object.freeze({
    id: canonicalId(
      command.id,
      "notification identifier"
    ),
    user_id: canonicalId(
      command.userId,
      "notification user identifier"
    ),
    league_id: optionalId(
      command.leagueId,
      "notification league identifier"
    ),
    event_type: safeToken(
      command.eventType,
      "notification event type"
    ),
    message_data_json: messageDataJson(
      command.messageDataJson
    ),
    related_feature: relatedFeature,
    related_record_id: relatedRecordId,
    delivery_status: command.deliveryStatus,
    created_at_ms: createdAtMs,
    read_at_ms: null,
    delivered_at_ms: deliveredAtMs,
    version: 1,
    deduplication_key: deduplicationKey(
      command.deduplicationKey
    ),
  });
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function sameLogicalNotification(existing, requested) {
  return LOGICAL_COLUMNS.every(
    (column) => existing[column] === requested[column]
  );
}

function isConstraintError(error) {
  return (
    typeof error?.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function replayResult(existing, requested) {
  if (!sameLogicalNotification(existing, requested)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.versionConflict,
      "A notification deduplication key identifies different content.",
      {
        details: {
          tableName: "notifications",
          eventType: requested.event_type,
          userId: requested.user_id,
        },
      }
    );
  }
  return Object.freeze({
    notification: existing,
    replayed: true,
  });
}

function createSqliteNotificationWriter({
  database,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    invalid(
      "Notification writing requires an opened SQLite database."
    );
  }

  let insertStatement;
  let findByIdStatement;
  let findByDeduplicationStatement;
  try {
    insertStatement = database.prepare(`
      INSERT INTO notifications (
        id, user_id, league_id, event_type, message_data_json,
        related_feature, related_record_id, delivery_status,
        created_at_ms, read_at_ms, delivered_at_ms, version,
        deduplication_key
      ) VALUES (
        @id, @user_id, @league_id, @event_type, @message_data_json,
        @related_feature, @related_record_id, @delivery_status,
        @created_at_ms, @read_at_ms, @delivered_at_ms, @version,
        @deduplication_key
      )
    `);
    findByIdStatement = database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM notifications
      WHERE id = @id
      LIMIT 2
    `);
    findByDeduplicationStatement = database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM notifications
      WHERE user_id = @user_id
        AND event_type = @event_type
        AND deduplication_key = @deduplication_key
      ORDER BY id ASC
      LIMIT 2
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareNotificationWriter",
      tableName: "notifications",
    });
  }

  function requireUnique(rows, description) {
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        `Notification ${description} was not unique.`,
        { details: { tableName: "notifications" } }
      );
    }
    return freezeRow(rows[0]);
  }

  function findById(record) {
    return requireUnique(
      findByIdStatement.all({ id: record.id }),
      "identifier"
    );
  }

  function findByDeduplication(record) {
    return requireUnique(
      findByDeduplicationStatement.all(record),
      "deduplication tuple"
    );
  }

  const insertTransaction = database.transaction(
    (record) => {
      if (record.deduplication_key !== null) {
        const existing =
          findByDeduplication(record);
        if (existing) {
          return replayResult(existing, record);
        }
      }

      try {
        insertStatement.run(record);
      } catch (error) {
        if (
          record.deduplication_key === null ||
          !isConstraintError(error)
        ) {
          throw error;
        }
        const concurrent =
          findByDeduplication(record);
        if (!concurrent) throw error;
        return replayResult(concurrent, record);
      }
      const inserted = findById(record);
      if (!inserted) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The inserted notification could not be read.",
          { details: { tableName: "notifications" } }
        );
      }
      return Object.freeze({
        notification: inserted,
        replayed: false,
      });
    }
  );

  return Object.freeze({
    insert(command) {
      try {
        return insertTransaction.immediate(
          normalize(command)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "insertNotification",
          tableName: "notifications",
        });
      }
    },
  });
}

function resolveSqliteNotificationWriter({
  database,
  notificationWriter,
} = {}) {
  if (notificationWriter === undefined) {
    return createSqliteNotificationWriter({ database });
  }
  if (
    !notificationWriter ||
    typeof notificationWriter.insert !== "function"
  ) {
    invalid("A synchronous notification writer is required.");
  }
  return notificationWriter;
}

module.exports = {
  createSqliteNotificationWriter,
  resolveSqliteNotificationWriter,
};
