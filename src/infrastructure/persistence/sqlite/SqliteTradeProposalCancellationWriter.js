const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteTradePublicationWriter,
} = require("./SqliteTradePublicationWriter");

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function displayStatus(storageStatus) {
  return storageStatus === "awaiting_commissioner_approval"
    ? "Awaiting Commissioner Approval"
    : "Pending";
}

function createSqliteTradeProposalCancellationWriter({
  database,
  leagueOutboxWriter,
  tradePublicationWriter,
} = {}) {
  let updatePendingTradeStatement;
  let insertAutomaticCancellationEventStatement;
  let publicationWriter;
  try {
    updatePendingTradeStatement = database.prepare(`
      UPDATE trades
      SET status = 'cancelled', responded_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs, version = version + 1
      WHERE league_id = @leagueId
        AND id = @tradeId
        AND status = 'proposed'
        AND version = @expectedVersion
    `);
    insertAutomaticCancellationEventStatement = database.prepare(`
      INSERT INTO trade_events (
        id, league_id, season_id, trade_id, actor_user_id,
        event_type, reason, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @tradeId,
        NULL, 'proposal_auto_cancelled', @reasonCode,
        @metadataJson, @occurredAtMs
      )
    `);
    publicationWriter = resolveSqliteTradePublicationWriter({
      database,
      leagueOutboxWriter,
      tradePublicationWriter,
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTradeProposalCancellationWriter",
      tableName: "trades",
    });
  }

  return Object.freeze({
    cancelPending({
      eventId,
      leagueId,
      seasonId,
      tradeId,
      expectedVersion,
      fromStatus,
      reasonCode,
      sourceMetadata,
      occurredAtMs,
    }) {
      if (!database.inTransaction) {
        invalid(
          "Automatic trade cancellation must run inside its source transaction."
        );
      }
      try {
        const result = updatePendingTradeStatement.run({
          leagueId,
          tradeId,
          expectedVersion,
          occurredAtMs,
        });
        if (result.changes !== 1) return null;

        insertAutomaticCancellationEventStatement.run({
          eventId,
          leagueId,
          seasonId,
          tradeId,
          reasonCode,
          metadataJson: JSON.stringify({
            schemaVersion: 1,
            ...sourceMetadata,
            fromStatus,
            reasonCode,
          }),
          occurredAtMs,
        });
        const publication = publicationWriter.publish({
          eventId,
          leagueId,
          seasonId,
          tradeId,
          actorUserId: null,
          actorAuthority: "system",
          teamId: null,
          eventType: "trade_proposal_automatically_cancelled",
          displaySummary: "Trade proposal automatically cancelled.",
          reason: reasonCode,
          metadata: {
            schemaVersion: 1,
            proposalId: tradeId,
            ...sourceMetadata,
            fromStatus: displayStatus(fromStatus),
            toStatus: "Automatically Cancelled",
            reasonCode,
          },
          occurredAtMs,
          tradeVersion: expectedVersion + 1,
        });
        if (publication && typeof publication.then === "function") {
          invalid("Automatic trade cancellation publication must be synchronous.");
        }
        return Object.freeze({
          tradeId,
          eventId,
          version: expectedVersion + 1,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "cancelPendingTradeProposal",
          tableName: "trades",
        });
      }
    },
  });
}

function resolveSqliteTradeProposalCancellationWriter({
  database,
  leagueOutboxWriter,
  tradePublicationWriter,
  tradeProposalCancellationWriter,
} = {}) {
  if (tradeProposalCancellationWriter === undefined) {
    return createSqliteTradeProposalCancellationWriter({
      database,
      leagueOutboxWriter,
      tradePublicationWriter,
    });
  }
  if (
    !tradeProposalCancellationWriter ||
    typeof tradeProposalCancellationWriter.cancelPending !== "function"
  ) {
    invalid("A synchronous trade proposal cancellation writer is required.");
  }
  return tradeProposalCancellationWriter;
}

module.exports = {
  createSqliteTradeProposalCancellationWriter,
  resolveSqliteTradeProposalCancellationWriter,
};
