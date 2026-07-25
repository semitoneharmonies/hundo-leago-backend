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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ERROR_CODE_PATTERN =
  /^[A-Z][A-Z0-9_]{0,63}$/;
const OUTBOX_COLUMNS = Object.freeze([
  "id",
  "league_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "payload_json",
  "status",
  "attempt_count",
  "available_at_ms",
  "published_at_ms",
  "last_error_code",
  "created_at_ms",
  "updated_at_ms",
  "version",
]);
const SELECT_COLUMNS = OUTBOX_COLUMNS.join(", ");
const CLEARED_PAYLOAD_JSON =
  '{"cleared":true,"schemaVersion":1}';
const SECURITY_NOTIFICATION_EVENTS = Object.freeze({
  administrator_setup_completed:
    "account.credential_setup_completed_notification",
  account_deactivated:
    "account.deactivated_notification",
  account_reactivated:
    "account.reactivated_notification",
  password_changed:
    "account.password_changed_notification",
  password_reset_completed:
    "account.password_reset_completed_notification",
  session_replaced:
    "account.session_replaced_notification",
});
const ACTION_LINK_EVENTS = Object.freeze({
  administrator_setup:
    "account.credential_setup_requested",
  password_reset:
    "account.password_reset_requested",
  self_reactivation:
    "account.reactivation_requested",
});

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function assertId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid("A canonical outbox identifier is required.");
  }
  return value;
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe outbox timestamp is required.");
  }
  return value;
}

function assertVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid("A positive outbox version is required.");
  }
  return value;
}

function assertErrorCode(value) {
  if (
    typeof value !== "string" ||
    !SAFE_ERROR_CODE_PATTERN.test(value)
  ) {
    invalid("A safe outbox error code is required.");
  }
  return value;
}

function assertEnvelope(envelope) {
  const keys = isPlainObject(envelope)
    ? Object.keys(envelope).sort()
    : [];
  const expected = [
    "algorithm",
    "authenticationTag",
    "ciphertext",
    "envelopeVersion",
    "keyVersion",
    "nonce",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    envelope.algorithm !== "A256GCM" ||
    envelope.envelopeVersion !== 1 ||
    !Number.isSafeInteger(envelope.keyVersion) ||
    envelope.keyVersion < 1
  ) {
    invalid("An encrypted outbox envelope is required.");
  }
  for (const field of [
    "authenticationTag",
    "ciphertext",
    "nonce",
  ]) {
    if (
      typeof envelope[field] !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(envelope[field])
    ) {
      invalid("An encrypted outbox envelope is required.");
    }
  }
}

function parsePendingPayload(payloadJson) {
  if (
    typeof payloadJson !== "string" ||
    payloadJson.length < 1 ||
    payloadJson.length > 4096
  ) {
    invalid("A bounded account-email outbox payload is required.");
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    invalid("A bounded account-email outbox payload is required.");
  }
  return payload;
}

function assertVerificationPayload(payload, userId) {
  const keys = isPlainObject(payload)
    ? Object.keys(payload).sort()
    : [];
  const expected = [
    "deliveryKind",
    "envelope",
    "expiresAtMs",
    "purpose",
    "recipientUserId",
    "schemaVersion",
    "tokenId",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    payload.schemaVersion !== 1 ||
    payload.deliveryKind !== "email_verification" ||
    payload.purpose !== "email_verification" ||
    payload.recipientUserId !== userId
  ) {
    invalid("An email-verification outbox payload is required.");
  }
  assertId(payload.recipientUserId);
  assertId(payload.tokenId);
  assertTimestamp(payload.expiresAtMs);
  assertEnvelope(payload.envelope);
}

function assertSecurityNotificationPayload(
  payload,
  userId,
  eventType
) {
  const keys = isPlainObject(payload)
    ? Object.keys(payload).sort()
    : [];
  const expected = [
    "deliveryKind",
    "notificationKind",
    "occurredAtMs",
    "recipientUserId",
    "schemaVersion",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    payload.schemaVersion !== 1 ||
    payload.deliveryKind !== "security_notification" ||
    payload.recipientUserId !== userId ||
    SECURITY_NOTIFICATION_EVENTS[
      payload.notificationKind
    ] !== eventType
  ) {
    invalid("A security-notification outbox payload is required.");
  }
  assertId(payload.recipientUserId);
  assertTimestamp(payload.occurredAtMs);
}

function assertActionLinkPayload(
  payload,
  userId,
  eventType
) {
  const keys = isPlainObject(payload)
    ? Object.keys(payload).sort()
    : [];
  const expected = [
    "deliveryKind",
    "envelope",
    "expiresAtMs",
    "purpose",
    "recipientUserId",
    "schemaVersion",
    "tokenId",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    payload.schemaVersion !== 1 ||
    payload.deliveryKind !== "account_action_link" ||
    payload.recipientUserId !== userId ||
    ACTION_LINK_EVENTS[payload.purpose] !== eventType
  ) {
    invalid("An account-action-link outbox payload is required.");
  }
  assertId(payload.recipientUserId);
  assertId(payload.tokenId);
  assertTimestamp(payload.expiresAtMs);
  assertEnvelope(payload.envelope);
}

function assertPendingRecord(record) {
  if (
    !isPlainObject(record) ||
    Object.keys(record).length !== OUTBOX_COLUMNS.length ||
    Object.keys(record).some(
      (key) => !OUTBOX_COLUMNS.includes(key)
    )
  ) {
    invalid("An exact pending outbox record is required.");
  }
  assertId(record.id);
  assertId(record.aggregate_id);
  if (
    record.league_id !== null ||
    record.aggregate_type !== "user" ||
    record.status !== "pending" ||
    record.attempt_count !== 0 ||
    record.published_at_ms !== null ||
    record.last_error_code !== null ||
    record.version !== 1
  ) {
    invalid("A pending account-email outbox record is required.");
  }
  const availableAtMs = assertTimestamp(
    record.available_at_ms
  );
  const createdAtMs = assertTimestamp(record.created_at_ms);
  const updatedAtMs = assertTimestamp(record.updated_at_ms);
  if (
    availableAtMs < createdAtMs ||
    updatedAtMs !== createdAtMs
  ) {
    invalid("The pending outbox timestamps are invalid.");
  }
  const payload = parsePendingPayload(
    record.payload_json
  );
  if (
    record.event_type ===
    "account.email_verification_requested"
  ) {
    assertVerificationPayload(
      payload,
      record.aggregate_id
    );
  } else if (
    Object.values(ACTION_LINK_EVENTS).includes(
      record.event_type
    )
  ) {
    assertActionLinkPayload(
      payload,
      record.aggregate_id,
      record.event_type
    );
  } else {
    assertSecurityNotificationPayload(
      payload,
      record.aggregate_id,
      record.event_type
    );
  }
  return record;
}

function createSqliteOutboxEventRepository({ database } = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("outbox_events"),
  });
  let findById;
  let findDue;
  let findInterrupted;
  let findByTokenId;
  try {
    findById = database.prepare(
      `SELECT ${SELECT_COLUMNS} FROM outbox_events ` +
        "WHERE id = @id AND league_id IS NULL"
    );
    findDue = database.prepare(
      `SELECT ${SELECT_COLUMNS} FROM outbox_events ` +
        "WHERE league_id IS NULL " +
        "AND status IN ('pending', 'failed') " +
        "AND available_at_ms <= @nowMs " +
        "ORDER BY available_at_ms ASC, created_at_ms ASC, id ASC " +
        "LIMIT @limit"
    );
    findInterrupted = database.prepare(
      `SELECT ${SELECT_COLUMNS} FROM outbox_events ` +
        "WHERE league_id IS NULL " +
        "AND status = 'publishing' " +
        "AND updated_at_ms <= @staleBeforeMs " +
        "ORDER BY updated_at_ms ASC, id ASC " +
        "LIMIT @limit"
    );
    findByTokenId = database.prepare(
      `SELECT ${SELECT_COLUMNS} FROM outbox_events ` +
        "WHERE league_id IS NULL " +
        "AND status IN ('pending', 'failed', 'publishing') " +
        "AND json_valid(payload_json) = 1 " +
        "AND json_extract(payload_json, '$.tokenId') = @tokenId " +
        "ORDER BY created_at_ms ASC, id ASC"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareOutboxRepository",
      tableName: "outbox_events",
    });
  }

  function requireStatus(eventId, statuses) {
    const current = records.requireByKey({
      key: assertId(eventId),
      leagueId: null,
    });
    if (!statuses.includes(current.status)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        "The eligible outbox event does not exist."
      );
    }
    return current;
  }

  function transition({
    eventId,
    expectedVersion,
    statuses,
    changes,
  }) {
    const current = requireStatus(eventId, statuses);
    if (current.version !== assertVersion(expectedVersion)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The outbox event version is stale."
      );
    }
    return freezeRow(
      records.updateVersioned({
        key: current.id,
        leagueId: null,
        expectedVersion,
        changes,
      })
    );
  }

  return Object.freeze({
    insertPending(record) {
      return freezeRow(
        records.insert(assertPendingRecord(record))
      );
    },
    findById(eventId) {
      try {
        return freezeRow(
          findById.get({ id: assertId(eventId) })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findOutboxById",
          tableName: "outbox_events",
        });
      }
    },
    findDue({ nowMs, limit } = {}) {
      const currentTime = assertTimestamp(nowMs);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        invalid("A bounded outbox query limit is required.");
      }
      try {
        return Object.freeze(
          findDue
            .all({ nowMs: currentTime, limit })
            .map(freezeRow)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findDueOutbox",
          tableName: "outbox_events",
        });
      }
    },
    recoverInterrupted({
      nowMs,
      staleBeforeMs,
      limit,
    } = {}) {
      const changedAtMs = assertTimestamp(nowMs);
      const cutoff = assertTimestamp(staleBeforeMs);
      if (
        cutoff > changedAtMs ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        invalid("A bounded interrupted-outbox query is required.");
      }
      let rows;
      try {
        rows = findInterrupted.all({
          staleBeforeMs: cutoff,
          limit,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findInterruptedOutbox",
          tableName: "outbox_events",
        });
      }
      const recovered = [];
      for (const row of rows) {
        try {
          recovered.push(
            transition({
              eventId: row.id,
              expectedVersion: row.version,
              statuses: ["publishing"],
              changes: {
                status: "failed",
                available_at_ms: changedAtMs,
                last_error_code:
                  "EMAIL_DELIVERY_INTERRUPTED",
                updated_at_ms: changedAtMs,
              },
            })
          );
        } catch (error) {
          if (
            ![
              REPOSITORY_ERROR_CODES.versionConflict,
              REPOSITORY_ERROR_CODES.recordNotFound,
            ].includes(error?.code)
          ) {
            throw error;
          }
        }
      }
      return Object.freeze(recovered);
    },
    discardByTokenId({
      tokenId,
      nowMs,
      errorCode,
    } = {}) {
      const stableTokenId = assertId(tokenId);
      const changedAtMs = assertTimestamp(nowMs);
      const safeErrorCode = assertErrorCode(errorCode);
      let rows;
      try {
        rows = findByTokenId.all({
          tokenId: stableTokenId,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findOutboxByTokenId",
          tableName: "outbox_events",
        });
      }
      const discarded = [];
      for (const row of rows) {
        discarded.push(
          transition({
            eventId: row.id,
            expectedVersion: row.version,
            statuses: [
              "pending",
              "failed",
              "publishing",
            ],
            changes: {
              status: "discarded",
              payload_json: CLEARED_PAYLOAD_JSON,
              last_error_code: safeErrorCode,
              updated_at_ms: changedAtMs,
            },
          })
        );
      }
      return Object.freeze(discarded);
    },
    claimForDelivery({
      eventId,
      expectedVersion,
      nowMs,
    } = {}) {
      const current = requireStatus(eventId, [
        "pending",
        "failed",
      ]);
      const changedAtMs = assertTimestamp(nowMs);
      if (current.available_at_ms > changedAtMs) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "The due outbox event does not exist."
        );
      }
      return transition({
        eventId,
        expectedVersion,
        statuses: ["pending", "failed"],
        changes: {
          status: "publishing",
          attempt_count: current.attempt_count + 1,
          updated_at_ms: changedAtMs,
          last_error_code: null,
        },
      });
    },
    markPublished({
      eventId,
      expectedVersion,
      nowMs,
    } = {}) {
      const changedAtMs = assertTimestamp(nowMs);
      return transition({
        eventId,
        expectedVersion,
        statuses: ["publishing"],
        changes: {
          status: "published",
          payload_json: CLEARED_PAYLOAD_JSON,
          published_at_ms: changedAtMs,
          last_error_code: null,
          updated_at_ms: changedAtMs,
        },
      });
    },
    markRetryableFailure({
      eventId,
      expectedVersion,
      nowMs,
      availableAtMs,
      errorCode,
    } = {}) {
      const changedAtMs = assertTimestamp(nowMs);
      const nextAvailableAtMs = assertTimestamp(
        availableAtMs
      );
      if (nextAvailableAtMs <= changedAtMs) {
        invalid("A future outbox retry time is required.");
      }
      return transition({
        eventId,
        expectedVersion,
        statuses: ["publishing"],
        changes: {
          status: "failed",
          available_at_ms: nextAvailableAtMs,
          last_error_code: assertErrorCode(errorCode),
          updated_at_ms: changedAtMs,
        },
      });
    },
    discard({
      eventId,
      expectedVersion,
      nowMs,
      errorCode,
    } = {}) {
      const changedAtMs = assertTimestamp(nowMs);
      return transition({
        eventId,
        expectedVersion,
        statuses: ["pending", "failed", "publishing"],
        changes: {
          status: "discarded",
          payload_json: CLEARED_PAYLOAD_JSON,
          last_error_code: assertErrorCode(errorCode),
          updated_at_ms: changedAtMs,
        },
      });
    },
  });
}

module.exports = {
  ACTION_LINK_EVENTS,
  CLEARED_PAYLOAD_JSON,
  OUTBOX_COLUMNS,
  SECURITY_NOTIFICATION_EVENTS,
  createSqliteOutboxEventRepository,
};
