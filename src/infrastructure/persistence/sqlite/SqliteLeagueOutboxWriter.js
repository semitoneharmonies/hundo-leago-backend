const crypto = require("node:crypto");

const {
  createSocketEventEnvelope,
  createSocketInvalidation,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
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
const METADATA_NAME_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,7}$/;
const REQUIRED_EVENT_KEYS = Object.freeze([
  "aggregateId",
  "aggregateType",
  "eventType",
  "id",
  "leagueId",
  "occurredAtMs",
  "payload",
]);
const OPTIONAL_EVENT_KEYS = Object.freeze(["audiences"]);
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_AUDIENCES = 256;

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function assertExactKeys(value, expectedKeys, message) {
  if (!isPlainObject(value)) invalid(message);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(message);
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertEventShape(value) {
  if (!isPlainObject(value)) {
    invalid("An exact league outbox event is required.");
  }
  const keys = Object.keys(value);
  if (
    REQUIRED_EVENT_KEYS.some((key) => !keys.includes(key)) ||
    keys.some(
      (key) =>
        !REQUIRED_EVENT_KEYS.includes(key) &&
        !OPTIONAL_EVENT_KEYS.includes(key)
    )
  ) {
    invalid("An exact league outbox event is required.");
  }
}

function canonicalId(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(`A canonical ${label} identifier is required.`);
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe league outbox timestamp is required.");
  }
  return value;
}

function metadataName(value, label) {
  if (
    typeof value !== "string" ||
    value.length > 120 ||
    !METADATA_NAME_PATTERN.test(value)
  ) {
    invalid(`A canonical league outbox ${label} is required.`);
  }
  return value;
}

function assertJsonValue(value, seen = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      invalid("League outbox metadata must contain safe JSON values.");
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    invalid("League outbox metadata must contain safe JSON values.");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    if (!isPlainObject(value)) {
      invalid("League outbox metadata must contain safe JSON values.");
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        key.length < 1 ||
        key.length > 120 ||
        key.trim() !== key ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(key)
      ) {
        invalid("League outbox metadata keys must be canonical.");
      }
      assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function payloadJson(payload, event) {
  if (
    !isPlainObject(payload) ||
    Object.keys(payload).length === 0
  ) {
    invalid("League outbox metadata must be a plain object.");
  }
  assertJsonValue(payload);

  let canonicalPayload;
  let persistedPayload;
  try {
    if (payload.kind === "socket_event") {
      canonicalPayload = createSocketEventMetadata({
        eventType: payload.eventType,
        version: payload.version,
        reasonCode: payload.reasonCode,
        occurredAtMs: payload.occurredAtMs,
        related: payload.related,
      });
      persistedPayload = createSocketEventEnvelope({
        eventId: event.id,
        type: canonicalPayload.eventType,
        leagueId: event.leagueId,
        resourceId: event.aggregateId,
        version: canonicalPayload.version,
        reasonCode: canonicalPayload.reasonCode,
        occurredAt: canonicalPayload.occurredAtMs,
        related: canonicalPayload.related,
      });
    } else if (payload.kind === "invalidation") {
      canonicalPayload = createSocketInvalidation({
        eventType: payload.eventType,
        scope: payload.scope,
        scopeId: payload.scopeId,
        ...(payload.version === undefined
          ? {}
          : { version: payload.version }),
        ...(payload.changedAtMs === undefined
          ? {}
          : { changedAtMs: payload.changedAtMs }),
      });
      persistedPayload = canonicalPayload;
    } else {
      canonicalPayload = createSocketEventEnvelope(payload);
      persistedPayload = canonicalPayload;
    }
  } catch {
    invalid("Canonical league outbox invalidation metadata is required.");
  }
  if (
    !hasExactKeys(payload, Object.keys(canonicalPayload)) ||
    (payload.kind === "socket_event" &&
      (canonicalPayload.eventType !== event.eventType ||
        canonicalPayload.occurredAtMs !== event.occurredAtMs)) ||
    (payload.kind === "invalidation" &&
      (canonicalPayload.eventType !== event.eventType ||
        canonicalPayload.scope !== "league" ||
        canonicalPayload.scopeId !== event.leagueId ||
        canonicalPayload.changedAtMs !== event.occurredAtMs)) ||
    (payload.kind === undefined &&
      (canonicalPayload.eventId !== event.id ||
        canonicalPayload.type !== event.eventType ||
        canonicalPayload.leagueId !== event.leagueId ||
        canonicalPayload.resourceId !== event.aggregateId ||
        canonicalPayload.occurredAt !== event.occurredAtMs))
  ) {
    invalid("Canonical league outbox invalidation metadata is required.");
  }

  let encoded;
  try {
    encoded = JSON.stringify(persistedPayload);
  } catch {
    invalid("League outbox metadata must be serializable JSON.");
  }
  if (
    typeof encoded !== "string" ||
    Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES
  ) {
    invalid("League outbox metadata exceeds its size limit.");
  }
  return encoded;
}

function deterministicUuid(value) {
  const hex = crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function normalizeAudience(
  audience,
  { eventId, leagueId, occurredAtMs }
) {
  if (audience?.kind === "league") {
    assertExactKeys(
      audience,
      ["kind"],
      "An exact league audience is required."
    );
    return Object.freeze({
      id: eventId,
      league_id: leagueId,
      outbox_event_id: eventId,
      audience_kind: "league",
      team_id: null,
      user_id: null,
      created_at_ms: occurredAtMs,
    });
  }
  if (audience?.kind === "team") {
    assertExactKeys(
      audience,
      ["kind", "teamId"],
      "An exact team audience is required."
    );
    const teamId = canonicalId(audience.teamId, "team audience");
    return Object.freeze({
      id: deterministicUuid(
        `${eventId}:audience:team:${teamId}`
      ),
      league_id: leagueId,
      outbox_event_id: eventId,
      audience_kind: "team",
      team_id: teamId,
      user_id: null,
      created_at_ms: occurredAtMs,
    });
  }
  if (audience?.kind === "user") {
    assertExactKeys(
      audience,
      ["kind", "userId"],
      "An exact user audience is required."
    );
    const userId = canonicalId(audience.userId, "user audience");
    return Object.freeze({
      id: deterministicUuid(
        `${eventId}:audience:user:${userId}`
      ),
      league_id: leagueId,
      outbox_event_id: eventId,
      audience_kind: "user",
      team_id: null,
      user_id: userId,
      created_at_ms: occurredAtMs,
    });
  }
  invalid("A supported league outbox audience is required.");
}

function normalizeAudiences(input, event) {
  const raw = Object.prototype.hasOwnProperty.call(
    input,
    "audiences"
  )
    ? input.audiences
    : [{ kind: "league" }];
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > MAX_AUDIENCES
  ) {
    invalid("At least one bounded league outbox audience is required.");
  }
  const audiences = raw.map((audience) =>
    normalizeAudience(audience, {
      eventId: event.id,
      leagueId: event.leagueId,
      occurredAtMs: event.occurredAtMs,
    })
  );
  const identities = audiences.map((audience) => {
    return (
      `${audience.audience_kind}:` +
      `${audience.team_id || audience.user_id || event.leagueId}`
    );
  });
  if (new Set(identities).size !== identities.length) {
    invalid("League outbox audiences must be unique.");
  }
  if (
    audiences.some(
      ({ audience_kind: kind }) => kind === "league"
    ) &&
    audiences.length !== 1
  ) {
    invalid(
      "A league audience cannot be combined with narrower audiences."
    );
  }
  return Object.freeze(audiences);
}

function validateWrite(input) {
  assertEventShape(input);
  const event = Object.freeze({
    id: canonicalId(input.id, "outbox event"),
    leagueId: canonicalId(input.leagueId, "league"),
    eventType: metadataName(input.eventType, "event type"),
    aggregateType: metadataName(
      input.aggregateType,
      "aggregate type"
    ),
    aggregateId: canonicalId(input.aggregateId, "aggregate"),
    occurredAtMs: safeTimestamp(input.occurredAtMs),
  });
  const encodedPayload = payloadJson(input.payload, event);
  return Object.freeze({
    event: Object.freeze({
      id: event.id,
      league_id: event.leagueId,
      event_type: event.eventType,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      payload_json: encodedPayload,
      status: "pending",
      attempt_count: 0,
      available_at_ms: event.occurredAtMs,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: event.occurredAtMs,
      updated_at_ms: event.occurredAtMs,
      version: 1,
    }),
    audiences: normalizeAudiences(input, event),
  });
}

function createSqliteLeagueOutboxWriter({ database } = {}) {
  let outboxRepository;
  let audienceRepository;
  let writeTransaction;
  try {
    outboxRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("outbox_events"),
    });
    audienceRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition(
        "outbox_event_audiences"
      ),
    });
    writeTransaction = database.transaction((write) => {
      const event = outboxRepository.insert(write.event);
      const audiences = write.audiences.map((audience) =>
        audienceRepository.insert(audience)
      );
      return Object.freeze({
        event: Object.freeze({ ...event }),
        audiences: Object.freeze(
          audiences.map((audience) =>
            Object.freeze({ ...audience })
          )
        ),
      });
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueOutboxWriter",
      tableName: "outbox_events",
    });
  }

  return Object.freeze({
    write(input) {
      const write = validateWrite(input);
      try {
        return writeTransaction.immediate(write);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "writeLeagueOutboxEvent",
          tableName: "outbox_events",
        });
      }
    },
  });
}

function resolveSqliteLeagueOutboxWriter({
  database,
  leagueOutboxWriter,
} = {}) {
  if (leagueOutboxWriter === undefined) {
    return createSqliteLeagueOutboxWriter({ database });
  }
  if (
    !leagueOutboxWriter ||
    typeof leagueOutboxWriter.write !== "function"
  ) {
    invalid("A synchronous league outbox writer is required.");
  }
  return leagueOutboxWriter;
}

module.exports = {
  MAX_PAYLOAD_BYTES,
  createSqliteLeagueOutboxWriter,
  resolveSqliteLeagueOutboxWriter,
};
