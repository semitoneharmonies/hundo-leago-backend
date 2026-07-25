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

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteRosterMovementRepository({ database } = {}) {
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
  let moveTransaction;
  try {
    findOwnershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE league_id = @leagueId AND player_id = @playerId LIMIT 2"
    );
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
      const updated = freezeRow(
        ownerships.updateVersioned({
          key: current.id,
          leagueId: move.leagueId,
          expectedVersion: move.expectedVersion,
          changes: {
            roster_category: move.destinationCategory,
            position_group: move.destinationPositionGroup,
            slot_number: move.destinationSlotNumber,
            updated_at_ms: move.occurredAtMs,
          },
        })
      );
      const beforeMetadata = JSON.stringify({
        rosterCategory: current.roster_category,
        positionGroup: current.position_group,
        slotNumber: current.slot_number,
        version: current.version,
      });
      const afterMetadata = JSON.stringify({
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
      return Object.freeze({
        ownership: updated,
        ownershipEvent: event,
        activity: activityRow,
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
