const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){1,7}$/;
const ALLOWED_SCOPES = new Set(["user", "league"]);
const ALLOWED_INPUT_KEYS = new Set([
  "changedAtMs",
  "eventType",
  "scope",
  "scopeId",
  "version",
]);
const SOCKET_EVENT_METADATA_KEYS = Object.freeze([
  "eventType",
  "occurredAtMs",
  "reasonCode",
  "related",
  "version",
]);
const SOCKET_EVENT_ENVELOPE_KEYS = Object.freeze([
  "eventId",
  "type",
  "leagueId",
  "resourceId",
  "version",
  "reasonCode",
  "occurredAt",
  "related",
]);
const SOCKET_RELATED_KEYS = Object.freeze([
  "fadId",
  "teamId",
  "cardId",
  "allocationId",
  "auctionId",
  "recoveryId",
  "nominationQueueId",
  "scheduleRecoveryOperationId",
]);
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

const SOCKET_EVENT_REASON_CODES = Object.freeze({
  "league.changed": Object.freeze([
    "league_changed",
    "membership_changed",
    "commissioner_assignment_changed",
    "manager_assignment_changed",
  ]),
  "team.changed": Object.freeze([
    "team_changed",
    "manager_assignment_changed",
  ]),
  "roster.changed": Object.freeze([
    "roster_changed",
    "correction_applied",
  ]),
  "contract.changed": Object.freeze([
    "contract_changed",
    "correction_applied",
  ]),
  "auction.changed": Object.freeze([
    "auction_changed",
    "nomination_opened",
    "fallback_opened",
    "correction_applied",
  ]),
  "trade.changed": Object.freeze(["trade_changed"]),
  "matchup.changed": Object.freeze([
    "matchup_changed",
    "week1_recovered",
    "correction_applied",
  ]),
  "standings.changed": Object.freeze([
    "standings_changed",
    "correction_applied",
  ]),
  "draft.changed": Object.freeze(["draft_changed"]),
  "free_agent_draft.changed": Object.freeze([
    "cards_opened",
    "cards_published",
    "allocation_changed",
    "correction_applied",
    "completed",
    "nomination_opened",
    "fallback_opened",
    "week1_recovered",
  ]),
  "candidate_card.changed": Object.freeze([
    "card_changed",
    "cards_published",
  ]),
  "candidate_card_help.changed": Object.freeze([
    "help_changed",
  ]),
  "fad_nomination_queue.changed": Object.freeze([
    "nomination_queued",
    "nomination_opened",
  ]),
  "activity.created": Object.freeze([
    "activity_created",
    "setup_exemption_authorized",
    "cards_opened",
    "cards_published",
    "allocation_changed",
    "correction_applied",
    "completed",
    "nomination_opened",
    "fallback_opened",
    "week1_recovered",
    "auction_changed",
    "roster_changed",
    "contract_changed",
  ]),
  "notification.created": Object.freeze([
    "notification_created",
    "setup_exemption_authorized",
    "cards_opened",
    "cards_published",
    "allocation_changed",
    "correction_applied",
    "completed",
    "nomination_queued",
    "nomination_opened",
    "fallback_opened",
    "week1_recovered",
    "auction_changed",
    "roster_changed",
    "contract_changed",
  ]),
  "operations.changed": Object.freeze([
    "operations_changed",
    "correction_applied",
    "week1_recovered",
  ]),
});

class SocketInvalidationError extends Error {
  constructor() {
    super("The socket invalidation metadata is invalid.");
    this.name = "SocketInvalidationError";
    this.code = "SOCKET_INVALIDATION_INVALID";
  }
}

function invalid() {
  throw new SocketInvalidationError();
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
    prototype === Object.prototype || prototype === null
  );
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

function canonicalRelated(related) {
  if (!hasExactKeys(related, SOCKET_RELATED_KEYS)) invalid();
  const result = {};
  for (const key of SOCKET_RELATED_KEYS) {
    const value = related[key];
    if (value !== null && !UUID_PATTERN.test(value || "")) {
      invalid();
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function createEmptySocketRelated(overrides = {}) {
  if (!isPlainObject(overrides)) invalid();
  if (
    Object.keys(overrides).some(
      (key) => !SOCKET_RELATED_KEYS.includes(key)
    )
  ) {
    invalid();
  }
  return canonicalRelated(
    Object.fromEntries(
      SOCKET_RELATED_KEYS.map((key) => [
        key,
        Object.prototype.hasOwnProperty.call(overrides, key)
          ? overrides[key]
          : null,
      ])
    )
  );
}

function createSocketEventMetadata(input) {
  if (!hasExactKeys(input, SOCKET_EVENT_METADATA_KEYS)) invalid();
  if (
    !Object.prototype.hasOwnProperty.call(
      SOCKET_EVENT_REASON_CODES,
      input.eventType
    ) ||
    !REASON_CODE_PATTERN.test(input.reasonCode || "") ||
    !SOCKET_EVENT_REASON_CODES[input.eventType].includes(
      input.reasonCode
    ) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !Number.isSafeInteger(input.occurredAtMs) ||
    input.occurredAtMs < 0
  ) {
    invalid();
  }

  return Object.freeze({
    kind: "socket_event",
    eventType: input.eventType,
    version: input.version,
    reasonCode: input.reasonCode,
    occurredAtMs: input.occurredAtMs,
    related: canonicalRelated(input.related),
  });
}

function createSocketEventEnvelope(input) {
  if (!hasExactKeys(input, SOCKET_EVENT_ENVELOPE_KEYS)) invalid();
  if (
    !UUID_PATTERN.test(input.eventId || "") ||
    !UUID_PATTERN.test(input.leagueId || "") ||
    !UUID_PATTERN.test(input.resourceId || "")
  ) {
    invalid();
  }
  const metadata = createSocketEventMetadata({
    eventType: input.type,
    version: input.version,
    reasonCode: input.reasonCode,
    occurredAtMs: input.occurredAt,
    related: input.related,
  });
  return Object.freeze({
    eventId: input.eventId,
    type: metadata.eventType,
    leagueId: input.leagueId,
    resourceId: input.resourceId,
    version: metadata.version,
    reasonCode: metadata.reasonCode,
    occurredAt: metadata.occurredAtMs,
    related: metadata.related,
  });
}

function createSocketInvalidation(input) {
  if (!isPlainObject(input)) invalid();
  const keys = Object.keys(input);
  if (
    keys.some((key) => !ALLOWED_INPUT_KEYS.has(key)) ||
    !EVENT_TYPE_PATTERN.test(input.eventType || "") ||
    !ALLOWED_SCOPES.has(input.scope) ||
    !UUID_PATTERN.test(input.scopeId || "")
  ) {
    invalid();
  }

  const hasVersion = input.version !== undefined;
  const hasChangedAtMs =
    input.changedAtMs !== undefined;
  if (!hasVersion && !hasChangedAtMs) invalid();
  if (
    hasVersion &&
    (!Number.isSafeInteger(input.version) ||
      input.version < 1)
  ) {
    invalid();
  }
  if (
    hasChangedAtMs &&
    (!Number.isSafeInteger(input.changedAtMs) ||
      input.changedAtMs < 0)
  ) {
    invalid();
  }

  return Object.freeze({
    kind: "invalidation",
    eventType: input.eventType,
    scope: input.scope,
    scopeId: input.scopeId,
    ...(hasVersion ? { version: input.version } : {}),
    ...(hasChangedAtMs
      ? { changedAtMs: input.changedAtMs }
      : {}),
  });
}

module.exports = {
  SOCKET_EVENT_REASON_CODES,
  SOCKET_RELATED_KEYS,
  SocketInvalidationError,
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketInvalidation,
  createSocketEventMetadata,
};
