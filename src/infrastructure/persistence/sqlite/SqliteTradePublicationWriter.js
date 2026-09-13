const crypto = require("node:crypto");

const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

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

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function createSqliteTradePublicationWriter({
  database,
  leagueOutboxWriter,
} = {}) {
  let activityRepository;
  let outboxWriter;
  try {
    activityRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("league_activity"),
    });
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTradePublicationWriter",
      tableName: "league_activity",
    });
  }

  return Object.freeze({
    publish({
      eventId,
      leagueId,
      seasonId,
      tradeId,
      actorUserId,
      actorAuthority,
      teamId,
      eventType,
      displaySummary,
      reason,
      metadata,
      occurredAtMs,
      tradeVersion,
    }) {
      try {
        const activity = activityRepository.insert({
          id: deterministicUuid(`activity:${eventId}`),
          league_id: leagueId,
          season_id: seasonId,
          event_type: eventType,
          actor_user_id: actorUserId,
          actor_authority: actorAuthority,
          team_id: teamId,
          player_id: null,
          related_type: "trade",
          related_id: tradeId,
          display_summary: displaySummary,
          reason,
          metadata_json: JSON.stringify(metadata),
          occurred_at_ms: occurredAtMs,
        });
        const payload = createSocketEventMetadata({
          eventType: "trade.changed",
          version: tradeVersion,
          reasonCode: "trade_changed",
          occurredAtMs,
          related: createEmptySocketRelated(),
        });
        const outbox = outboxWriter.write({
          id: deterministicUuid(`outbox:${eventId}:trade.changed`),
          leagueId,
          eventType: "trade.changed",
          aggregateType: "trade",
          aggregateId: tradeId,
          payload,
          occurredAtMs,
        });
        if (outbox && typeof outbox.then === "function") {
          invalid("Trade publication writes must be synchronous.");
        }
        return Object.freeze({
          activity: Object.freeze({ ...activity }),
          outbox,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "publishTradeChange",
          tableName: "league_activity",
        });
      }
    },
  });
}

function resolveSqliteTradePublicationWriter({
  database,
  leagueOutboxWriter,
  tradePublicationWriter,
} = {}) {
  if (tradePublicationWriter === undefined) {
    return createSqliteTradePublicationWriter({
      database,
      leagueOutboxWriter,
    });
  }
  if (
    !tradePublicationWriter ||
    typeof tradePublicationWriter.publish !== "function"
  ) {
    invalid("A synchronous trade publication writer is required.");
  }
  return tradePublicationWriter;
}

module.exports = {
  createSqliteTradePublicationWriter,
  resolveSqliteTradePublicationWriter,
};
