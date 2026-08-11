const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketInvalidation,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");

const DEFAULT_RETRY_DELAY_MS = 5_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_INVALIDATION_COMPATIBILITY = Object.freeze({
  "league.changed": Object.freeze({
    eventType: "league.changed",
    reasonCode: "league_changed",
  }),
  "team.changed": Object.freeze({
    eventType: "team.changed",
    reasonCode: "team_changed",
  }),
  "roster.changed": Object.freeze({
    eventType: "roster.changed",
    reasonCode: "roster_changed",
  }),
  "contract.changed": Object.freeze({
    eventType: "contract.changed",
    reasonCode: "contract_changed",
  }),
  "auction.updated": Object.freeze({
    eventType: "auction.changed",
    reasonCode: "auction_changed",
  }),
  "auction.changed": Object.freeze({
    eventType: "auction.changed",
    reasonCode: "auction_changed",
  }),
  "trade.changed": Object.freeze({
    eventType: "trade.changed",
    reasonCode: "trade_changed",
  }),
  "matchup.changed": Object.freeze({
    eventType: "matchup.changed",
    reasonCode: "matchup_changed",
  }),
  "standings.changed": Object.freeze({
    eventType: "standings.changed",
    reasonCode: "standings_changed",
  }),
  "draft.changed": Object.freeze({
    eventType: "draft.changed",
    reasonCode: "draft_changed",
  }),
  "candidate_card.changed": Object.freeze({
    eventType: "candidate_card.changed",
    reasonCode: "card_changed",
  }),
  "candidate_card_help.changed": Object.freeze({
    eventType: "candidate_card_help.changed",
    reasonCode: "help_changed",
  }),
  "activity.created": Object.freeze({
    eventType: "activity.created",
    reasonCode: "activity_created",
  }),
  "notification.created": Object.freeze({
    eventType: "notification.created",
    reasonCode: "notification_created",
  }),
  "operations.changed": Object.freeze({
    eventType: "operations.changed",
    reasonCode: "operations_changed",
  }),
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league outbox publication requires ${description}`);
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("league outbox publication requires a safe clock");
  }
  return value;
}

function safeErrorCode(error) {
  const value = error?.code;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value)
    ? value
    : "PUBLICATION_FAILED";
}

function publicationAudienceError(code) {
  const error = new Error(
    "The league outbox audience is unavailable."
  );
  error.code = code;
  return error;
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

function publicationPayloadError(code) {
  const error = new Error("The league outbox payload is invalid.");
  error.code = code;
  return error;
}

function parseAudiences(rows, event) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw publicationAudienceError(
      "PUBLICATION_AUDIENCE_MISSING"
    );
  }

  const audienceIds = new Set();
  const destinations = new Set();
  const parsed = [];
  for (const row of rows) {
    if (
      !isPlainObject(row) ||
      !UUID_PATTERN.test(row.id || "") ||
      row.league_id !== event.league_id ||
      row.outbox_event_id !== event.id ||
      !Number.isSafeInteger(row.created_at_ms) ||
      row.created_at_ms < 0 ||
      !["league", "team", "user"].includes(
        row.audience_kind
      )
    ) {
      throw publicationAudienceError(
        "PUBLICATION_AUDIENCE_INVALID"
      );
    }

    let destination;
    if (
      row.audience_kind === "league" &&
      row.team_id === null &&
      row.user_id === null
    ) {
      destination = `league:${row.league_id}`;
    } else if (
      row.audience_kind === "team" &&
      UUID_PATTERN.test(row.team_id || "") &&
      row.user_id === null
    ) {
      destination = `team:${row.team_id}`;
    } else if (
      row.audience_kind === "user" &&
      row.team_id === null &&
      UUID_PATTERN.test(row.user_id || "")
    ) {
      destination = `user:${row.user_id}`;
    } else {
      throw publicationAudienceError(
        "PUBLICATION_AUDIENCE_INVALID"
      );
    }

    if (
      audienceIds.has(row.id) ||
      destinations.has(destination)
    ) {
      throw publicationAudienceError(
        "PUBLICATION_AUDIENCE_INVALID"
      );
    }
    audienceIds.add(row.id);
    destinations.add(destination);
    parsed.push(
      Object.freeze({
        kind: row.audience_kind,
        leagueId: row.league_id,
        teamId: row.team_id,
        userId: row.user_id,
      })
    );
  }
  if (
    parsed.some(({ kind }) => kind === "league") &&
    parsed.length !== 1
  ) {
    throw publicationAudienceError(
      "PUBLICATION_AUDIENCE_INVALID"
    );
  }
  return Object.freeze(parsed);
}

function parsePayload(row) {
  let raw;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
  }

  if (
    raw?.kind === undefined &&
    Object.prototype.hasOwnProperty.call(raw, "eventId")
  ) {
    let envelope;
    try {
      envelope = createSocketEventEnvelope({
        eventId: raw.eventId,
        type: raw.type,
        leagueId: raw.leagueId,
        resourceId: raw.resourceId,
        version: raw.version,
        reasonCode: raw.reasonCode,
        occurredAt: raw.occurredAt,
        related: raw.related,
      });
    } catch {
      throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
    }
    if (
      !hasExactKeys(raw, Object.keys(envelope)) ||
      envelope.eventId !== row.id ||
      envelope.type !== row.event_type ||
      envelope.leagueId !== row.league_id ||
      envelope.resourceId !== row.aggregate_id ||
      envelope.occurredAt !== row.created_at_ms
    ) {
      throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
    }
    return envelope;
  }

  if (raw?.kind === "socket_event") {
    let metadata;
    try {
      metadata = createSocketEventMetadata({
        eventType: raw.eventType,
        version: raw.version,
        reasonCode: raw.reasonCode,
        occurredAtMs: raw.occurredAtMs,
        related: raw.related,
      });
      if (
        !hasExactKeys(raw, Object.keys(metadata)) ||
        metadata.eventType !== row.event_type ||
        metadata.occurredAtMs !== row.created_at_ms
      ) {
        throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
      }
      return createSocketEventEnvelope({
        eventId: row.id,
        type: metadata.eventType,
        leagueId: row.league_id,
        resourceId: row.aggregate_id,
        version: metadata.version,
        reasonCode: metadata.reasonCode,
        occurredAt: metadata.occurredAtMs,
        related: metadata.related,
      });
    } catch (error) {
      if (error?.code === "PUBLICATION_PAYLOAD_INVALID") {
        throw error;
      }
      throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
    }
  }

  let legacy;
  try {
    legacy = createSocketInvalidation({
      eventType: raw.eventType,
      scope: raw.scope,
      scopeId: raw.scopeId,
      ...(raw.version === undefined ? {} : { version: raw.version }),
      ...(raw.changedAtMs === undefined
        ? {}
        : { changedAtMs: raw.changedAtMs }),
    });
  } catch {
    throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
  }
  if (
    raw.kind !== "invalidation" ||
    !hasExactKeys(raw, Object.keys(legacy)) ||
    legacy.scope !== "league" ||
    legacy.scopeId !== row.league_id ||
    legacy.eventType !== row.event_type ||
    legacy.changedAtMs !== row.created_at_ms
  ) {
    throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
  }
  if (legacy.version === undefined) {
    throw publicationPayloadError(
      "PUBLICATION_PAYLOAD_VERSION_MISSING"
    );
  }
  const compatibility =
    LEGACY_INVALIDATION_COMPATIBILITY[legacy.eventType];
  if (!compatibility) {
    throw publicationPayloadError(
      "PUBLICATION_PAYLOAD_REASON_MISSING"
    );
  }
  try {
    return createSocketEventEnvelope({
      eventId: row.id,
      type: compatibility.eventType,
      leagueId: row.league_id,
      resourceId: row.aggregate_id,
      version: legacy.version,
      reasonCode: compatibility.reasonCode,
      occurredAt: legacy.changedAtMs,
      related: createEmptySocketRelated(),
    });
  } catch {
    throw publicationPayloadError("PUBLICATION_PAYLOAD_INVALID");
  }
}

function createLeagueOutboxPublicationService({
  repository,
  publisher,
  clock,
  batchSize = 25,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  for (const method of [
    "claim",
    "isUserAudienceAuthorized",
    "listAudiences",
    "listDue",
    "markFailed",
    "markPublished",
    "recoverInterrupted",
  ]) {
    assertMethod(repository, method, "a league-outbox repository");
  }
  assertMethod(publisher, "publish", "a Socket.IO invalidation publisher");
  assertMethod(clock, "nowMs", "a clock");
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 1
  ) {
    throw new TypeError("league outbox publication configuration is invalid");
  }

  async function publishDue() {
    const due = repository.listDue({ nowMs: safeNow(clock), limit: batchSize });
    const outcomes = [];
    for (const candidate of due) {
      const claimed = repository.claim({
        eventId: candidate.id,
        leagueId: candidate.league_id,
        expectedVersion: candidate.version,
        nowMs: safeNow(clock),
      });
      if (!claimed) continue;
      try {
        const audiences = parseAudiences(
          repository.listAudiences({
            eventId: claimed.id,
            leagueId: claimed.league_id,
          }),
          claimed
        );
        const payload = parsePayload(claimed);
        await publisher.publish({
          eventId: claimed.id,
          eventType: payload.type,
          leagueId: claimed.league_id,
          aggregateType: claimed.aggregate_type,
          aggregateId: claimed.aggregate_id,
          audiences,
          authorizeUserAudience({ leagueId, userId }) {
            return repository.isUserAudienceAuthorized({
              leagueId,
              userId,
              eventType: payload.type,
              resourceId: payload.resourceId,
              reasonCode: payload.reasonCode,
              related: payload.related,
              nowMs: safeNow(clock),
            });
          },
          payload,
        });
        repository.markPublished({
          eventId: claimed.id,
          leagueId: claimed.league_id,
          expectedVersion: claimed.version,
          publishedAtMs: safeNow(clock),
        });
        outcomes.push(Object.freeze({ eventId: claimed.id, outcome: "published" }));
      } catch (error) {
        const failedAtMs = safeNow(clock);
        repository.markFailed({
          eventId: claimed.id,
          leagueId: claimed.league_id,
          expectedVersion: claimed.version,
          failedAtMs,
          availableAtMs: failedAtMs + retryDelayMs,
          errorCode: safeErrorCode(error),
        });
        outcomes.push(Object.freeze({ eventId: claimed.id, outcome: "failed" }));
      }
    }
    return Object.freeze(outcomes);
  }

  function recoverInterrupted({ staleBeforeMs } = {}) {
    return repository.recoverInterrupted({
      nowMs: safeNow(clock),
      staleBeforeMs,
      limit: batchSize,
    });
  }

  return Object.freeze({ publishDue, recoverInterrupted });
}

module.exports = {
  DEFAULT_RETRY_DELAY_MS,
  LEGACY_INVALIDATION_COMPATIBILITY,
  createLeagueOutboxPublicationService,
  parseAudiences,
  parsePayload,
  safeErrorCode,
};
