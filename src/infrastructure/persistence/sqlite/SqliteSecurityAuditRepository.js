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
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_TEXT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CLIENT_METADATA_KEYS = new Set([
  "actorAuthority",
  "networkSourceCategory",
  "origin",
  "userAgentFamily",
  "userAgentHash",
]);
const NETWORK_SOURCE_CATEGORIES = new Set([
  "direct",
  "trusted_proxy",
  "local",
  "unknown",
]);
const AUDIT_COLUMNS = Object.freeze([
  "id",
  "event_type",
  "outcome",
  "actor_user_id",
  "target_user_id",
  "league_id",
  "session_id",
  "request_correlation_id",
  "reason_code",
  "network_key_version",
  "network_metadata_digest",
  "client_metadata_json",
  "unknown_account_digest",
  "occurred_at_ms",
]);
const SELECT_COLUMNS = AUDIT_COLUMNS.join(", ");

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function assertNullableId(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid("A canonical audit identifier is required.");
  }
  return value;
}

function assertSafeText(value, nullable = true) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !SAFE_TEXT_PATTERN.test(value)
  ) {
    invalid("Bounded safe audit text is required.");
  }
  return value;
}

function assertDigest(value) {
  if (
    value !== null &&
    (typeof value !== "string" ||
      !DIGEST_PATTERN.test(value))
  ) {
    invalid("A canonical audit digest is required.");
  }
  return value;
}

function assertClientMetadata(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 2048
  ) {
    invalid("Safe audit client metadata is required.");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid("Safe audit client metadata is required.");
  }
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).some(
      (key) => !CLIENT_METADATA_KEYS.has(key)
    )
  ) {
    invalid("Safe audit client metadata is required.");
  }
  for (const [key, entry] of Object.entries(
    parsed
  )) {
    if (typeof entry !== "string") {
      invalid("Safe audit client metadata is required.");
    }
    if (
      key === "actorAuthority" &&
      ![
        "commissioner",
        "platform_administrator_as_commissioner",
      ].includes(entry)
    ) {
      invalid("Safe audit client metadata is required.");
    }
    if (
      key === "networkSourceCategory" &&
      !NETWORK_SOURCE_CATEGORIES.has(entry)
    ) {
      invalid("Safe audit client metadata is required.");
    }
    if (
      key === "userAgentFamily" &&
      (entry.length < 1 ||
        entry.length > 64 ||
        !/^[A-Za-z0-9 ._/-]+$/.test(entry))
    ) {
      invalid("Safe audit client metadata is required.");
    }
    if (
      key === "userAgentHash" &&
      !DIGEST_PATTERN.test(entry)
    ) {
      invalid("Safe audit client metadata is required.");
    }
    if (key === "origin") {
      let origin;
      try {
        origin = new URL(entry);
      } catch {
        invalid("Safe audit client metadata is required.");
      }
      if (
        !["http:", "https:"].includes(
          origin.protocol
        ) ||
        origin.origin !== entry ||
        entry.length > 256
      ) {
        invalid("Safe audit client metadata is required.");
      }
    }
  }
  return value;
}

function assertAuditRecord(record) {
  if (
    !isPlainObject(record) ||
    Object.keys(record).length !==
      AUDIT_COLUMNS.length ||
    Object.keys(record).some(
      (key) => !AUDIT_COLUMNS.includes(key)
    )
  ) {
    invalid("An exact security-audit record is required.");
  }
  if (!UUID_PATTERN.test(record.id)) {
    invalid("A canonical audit event ID is required.");
  }
  assertSafeText(record.event_type, false);
  assertSafeText(record.outcome, false);
  assertNullableId(record.actor_user_id);
  assertNullableId(record.target_user_id);
  assertNullableId(record.league_id);
  assertNullableId(record.session_id);
  assertSafeText(record.request_correlation_id);
  assertSafeText(record.reason_code);
  assertDigest(record.network_metadata_digest);
  assertDigest(record.unknown_account_digest);
  assertClientMetadata(record.client_metadata_json);
  const hasPrivacyDigest =
    record.network_metadata_digest !== null ||
    record.unknown_account_digest !== null;
  if (
    record.network_key_version === null
      ? hasPrivacyDigest
      : !Number.isSafeInteger(
          record.network_key_version
        ) ||
        record.network_key_version < 1 ||
        !hasPrivacyDigest
  ) {
    invalid("Audit network metadata is inconsistent.");
  }
  if (
    !Number.isSafeInteger(record.occurred_at_ms) ||
    record.occurred_at_ms < 0
  ) {
    invalid("A safe audit timestamp is required.");
  }
  return record;
}

function assertLookup(id, limit) {
  if (
    typeof id !== "string" ||
    !UUID_PATTERN.test(id) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    invalid("A bounded audit lookup is required.");
  }
  return { id, limit };
}

function createSqliteSecurityAuditRepository({
  database,
} = {}) {
  const records = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition(
      "security_audit_events"
    ),
  });
  let byId;
  let byActor;
  let byTarget;
  try {
    byId = database.prepare(
      `SELECT ${SELECT_COLUMNS} ` +
        "FROM security_audit_events " +
        "WHERE id = @id"
    );
    byActor = database.prepare(
      `SELECT ${SELECT_COLUMNS} ` +
        "FROM security_audit_events " +
        "WHERE actor_user_id = @id " +
        "ORDER BY occurred_at_ms DESC, id DESC " +
        "LIMIT @limit"
    );
    byTarget = database.prepare(
      `SELECT ${SELECT_COLUMNS} ` +
        "FROM security_audit_events " +
        "WHERE target_user_id = @id " +
        "ORDER BY occurred_at_ms DESC, id DESC " +
        "LIMIT @limit"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareSecurityAuditRepository",
      tableName: "security_audit_events",
    });
  }

  function query(statement, options, operation) {
    const validated = assertLookup(
      options?.id,
      options?.limit
    );
    try {
      return Object.freeze(
        statement
          .all(validated)
          .map(freezeRow)
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation,
        tableName: "security_audit_events",
      });
    }
  }

  return Object.freeze({
    append(record) {
      return freezeRow(
        records.insert(
          assertAuditRecord(record)
        )
      );
    },
    findById(eventId) {
      if (
        typeof eventId !== "string" ||
        !UUID_PATTERN.test(eventId)
      ) {
        invalid("A canonical audit event ID is required.");
      }
      try {
        return freezeRow(
          byId.get({ id: eventId })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findSecurityAuditById",
          tableName: "security_audit_events",
        });
      }
    },
    findRecentByActor(options) {
      return query(
        byActor,
        options,
        "findSecurityAuditByActor"
      );
    },
    findRecentByTarget(options) {
      return query(
        byTarget,
        options,
        "findSecurityAuditByTarget"
      );
    },
  });
}

module.exports = {
  AUDIT_COLUMNS,
  CLIENT_METADATA_KEYS,
  DIGEST_PATTERN,
  NETWORK_SOURCE_CATEGORIES,
  UUID_PATTERN,
  createSqliteSecurityAuditRepository,
};
