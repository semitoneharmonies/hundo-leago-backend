const crypto = require("node:crypto");

const {
  RosterMovementPolicyError,
  assertCurrentOwnershipForMove,
  validateRosterMove,
} = require("../../../domain/rosters/rosterMovementPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");
const {
  resolveSqliteTradeProposalCancellationWriter,
} = require("./SqliteTradeProposalCancellationWriter");

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

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteRosterMovementRepository({
  database,
  candidateCardSummerSynchronizer,
  leagueOutboxWriter,
  tradePublicationWriter,
  tradeProposalCancellationWriter,
} = {}) {
  if (
    !candidateCardSummerSynchronizer ||
    typeof candidateCardSummerSynchronizer.synchronize !== "function"
  ) {
    throw new TypeError(
      "createSqliteRosterMovementRepository requires a Candidate Card summer synchronizer"
    );
  }
  const ownerships = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("player_ownerships"),
  });
  const ownershipEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("ownership_events"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });

  let findOwnershipStatement;
  let findUnplacedSourceOwnershipStatement;
  let placeSourceOwnershipStatement;
  let listPendingProspectTradesStatement;
  let cancellationWriter;
  let moveTransaction;
  try {
    findOwnershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE league_id = @leagueId AND player_id = @playerId LIMIT 2"
    );
    findUnplacedSourceOwnershipStatement = database.prepare(`
      SELECT id, player_id, version
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND team_id = @teamId
        AND roster_category = @sourceCategory
        AND slot_number IS NULL
        AND (
          @sourceCategory <> 'Active'
          OR position_group = @sourcePositionGroup
        )
      ORDER BY updated_at_ms ASC, id ASC
      LIMIT 1
    `);
    placeSourceOwnershipStatement = database.prepare(`
      UPDATE player_ownerships
      SET slot_number = @sourceSlotNumber,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE id = @id
        AND league_id = @leagueId
        AND version = @expectedVersion
        AND slot_number IS NULL
      RETURNING *
    `);
    listPendingProspectTradesStatement = database.prepare(`
      SELECT DISTINCT
        trades.id AS trade_id,
        trades.season_id AS season_id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM trade_future_consideration_acceptances AS acceptance
            WHERE acceptance.league_id = trades.league_id
              AND acceptance.trade_id = trades.id
          ) THEN 'awaiting_commissioner_approval'
          ELSE 'proposed'
        END AS trade_status,
        trades.version AS version
      FROM trades
      JOIN trade_assets
        ON trade_assets.league_id = trades.league_id
       AND trade_assets.trade_id = trades.id
      WHERE trades.league_id = @leagueId
        AND trades.status = 'proposed'
        AND trade_assets.asset_type = 'prospect_right'
        AND trade_assets.player_id = @playerId
      ORDER BY trades.id
    `);
    cancellationWriter = resolveSqliteTradeProposalCancellationWriter({
      database,
      leagueOutboxWriter,
      tradePublicationWriter,
      tradeProposalCancellationWriter,
    });

    function cancelPendingProspectTrades(move) {
      const automaticallyCancelledTradeIds = [];
      for (const trade of listPendingProspectTradesStatement.all(move)) {
        const eventId = deterministicUuid(
          `${move.ownershipEventId}:auto-cancel:${trade.trade_id}`
        );
        const cancelled = cancellationWriter.cancelPending({
          eventId,
          leagueId: move.leagueId,
          seasonId: trade.season_id,
          tradeId: trade.trade_id,
          expectedVersion: trade.version,
          fromStatus: trade.trade_status,
          reasonCode: "prospect_right_converted",
          sourceMetadata: {
            rosterMovementId: move.ownershipEventId,
            playerId: move.playerId,
          },
          occurredAtMs: move.occurredAtMs,
        });
        if (cancelled) {
          automaticallyCancelledTradeIds.push(trade.trade_id);
        }
      }
      return Object.freeze(automaticallyCancelledTradeIds);
    }

    moveTransaction = database.transaction((move) => {
      const rows = findOwnershipStatement.all({
        leagueId: move.leagueId,
        playerId: move.playerId,
      });
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "A league player has multiple ownership records."
        );
      }
      if (!rows[0]) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "The roster ownership does not exist."
        );
      }
      const current = freezeRow(rows[0]);
      assertCurrentOwnershipForMove({ current, move });
      const activatingProspect = current.roster_category === "Prospect";
      const updated = freezeRow(
        ownerships.updateVersioned({
          key: current.id,
          leagueId: move.leagueId,
          expectedVersion: move.expectedVersion,
          changes: {
            ...(activatingProspect
              ? { ownership_kind: "Rostered" }
              : {}),
            roster_category: move.destinationCategory,
            position_group: move.destinationPositionGroup,
            slot_number: move.destinationSlotNumber,
            updated_at_ms: move.occurredAtMs,
          },
        })
      );
      let placedSourceOwnership = null;
      if (current.slot_number !== null) {
        const replacement = findUnplacedSourceOwnershipStatement.get({
          ...move,
          sourceCategory: current.roster_category,
          sourcePositionGroup: current.position_group,
        });
        if (replacement) {
          placedSourceOwnership = freezeRow(
            placeSourceOwnershipStatement.get({
            ...move,
            id: replacement.id,
            expectedVersion: replacement.version,
            sourceSlotNumber: current.slot_number,
            })
          );
          if (!placedSourceOwnership) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.versionConflict,
              "The source roster changed before its open slot was restored."
            );
          }
        }
      }
      const beforeMetadata = JSON.stringify({
        ...(activatingProspect
          ? { ownershipKind: current.ownership_kind }
          : {}),
        rosterCategory: current.roster_category,
        positionGroup: current.position_group,
        slotNumber: current.slot_number,
        version: current.version,
      });
      const afterMetadata = JSON.stringify({
        ...(activatingProspect
          ? { ownershipKind: updated.ownership_kind }
          : {}),
        rosterCategory: updated.roster_category,
        positionGroup: updated.position_group,
        slotNumber: updated.slot_number,
        version: updated.version,
      });
      const event = freezeRow(
        ownershipEvents.insert({
          id: move.ownershipEventId,
          league_id: move.leagueId,
          season_id: move.seasonId,
          player_id: move.playerId,
          team_id: move.teamId,
          ownership_id: current.id,
          event_type: "roster_category_moved",
          actor_user_id: move.actorUserId,
          source_type: "roster_move",
          source_id: move.activityId,
          before_metadata_json: beforeMetadata,
          after_metadata_json: afterMetadata,
          reason: move.reason,
          occurred_at_ms: move.occurredAtMs,
        })
      );
      const metadataJson = JSON.stringify({
        ownershipId: current.id,
        before: JSON.parse(beforeMetadata),
        after: JSON.parse(afterMetadata),
      });
      const activityRow = freezeRow(
        activity.insert({
          id: move.activityId,
          league_id: move.leagueId,
          season_id: move.seasonId,
          event_type: "roster_moved",
          actor_user_id: move.actorUserId,
          actor_authority: move.actorAuthority,
          team_id: move.teamId,
          player_id: move.playerId,
          related_type: "player_ownership",
          related_id: current.id,
          display_summary: "Roster assignment moved.",
          reason: move.reason,
          metadata_json: metadataJson,
          occurred_at_ms: move.occurredAtMs,
        })
      );
      const automaticallyCancelledTradeIds = activatingProspect
        ? cancelPendingProspectTrades(move)
        : Object.freeze([]);
      candidateCardSummerSynchronizer.synchronize({
        leagueId: move.leagueId,
        affectedTeamIds: [move.teamId],
        affectedPlayerIds: [
          ...new Set(
            [
              move.playerId,
              placedSourceOwnership?.player_id,
            ].filter(Boolean)
          ),
        ].sort(),
        sourceOperationId: move.ownershipEventId,
        sourceKind: "roster_movement",
        nowMs: move.occurredAtMs,
      });
      return Object.freeze({
        ownership: updated,
        affectedOwnerships: Object.freeze(
          [updated, placedSourceOwnership]
            .filter(Boolean)
            .sort((left, right) => left.id.localeCompare(right.id))
        ),
        ownershipEvent: event,
        activity: activityRow,
        automaticallyCancelledTradeIds,
      });
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareRosterMovementRepository",
      tableName: "player_ownerships",
    });
  }

  return Object.freeze({
    move(input) {
      const move = validateRosterMove(input);
      try {
        return moveTransaction.immediate(move);
      } catch (error) {
        if (error instanceof RosterMovementPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "moveRosterAssignment",
          tableName: "player_ownerships",
        });
      }
    },
  });
}

module.exports = { createSqliteRosterMovementRepository };
