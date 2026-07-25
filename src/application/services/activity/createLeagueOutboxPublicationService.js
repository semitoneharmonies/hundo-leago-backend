const {
  createSocketInvalidation,
} = require("../../../domain/leagues/socketInvalidation");

const DEFAULT_RETRY_DELAY_MS = 5_000;

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

function parsePayload(row) {
  let raw;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    const error = new Error("The league outbox payload is invalid.");
    error.code = "PUBLICATION_PAYLOAD_INVALID";
    throw error;
  }
  const payload = createSocketInvalidation({
    eventType: raw.eventType,
    scope: raw.scope,
    scopeId: raw.scopeId,
    ...(raw.version === undefined ? {} : { version: raw.version }),
    ...(raw.changedAtMs === undefined
      ? {}
      : { changedAtMs: raw.changedAtMs }),
  });
  if (
    raw.kind !== "invalidation" ||
    Object.keys(raw).length !== Object.keys(payload).length ||
    payload.scope !== "league" ||
    payload.scopeId !== row.league_id ||
    payload.eventType !== row.event_type
  ) {
    const error = new Error("The league outbox payload is invalid.");
    error.code = "PUBLICATION_PAYLOAD_INVALID";
    throw error;
  }
  return payload;
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
        const payload = parsePayload(claimed);
        await publisher.publish({
          eventId: claimed.id,
          eventType: claimed.event_type,
          leagueId: claimed.league_id,
          aggregateType: claimed.aggregate_type,
          aggregateId: claimed.aggregate_id,
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
  createLeagueOutboxPublicationService,
  parsePayload,
  safeErrorCode,
};
