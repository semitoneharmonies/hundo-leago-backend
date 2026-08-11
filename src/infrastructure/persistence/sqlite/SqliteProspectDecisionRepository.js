const {
  ContractPolicyError,
  createFantasyElcAggregate,
} = require("../../../domain/contracts/contractPolicy");
const {
  ProspectDecisionPolicyError,
  assertUnsignedProspectOwnership,
  validateProspectElcSigning,
  validateUnsignedProspectRelease,
} = require("../../../domain/rosters/prospectDecisionPolicy");
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

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function createSqliteProspectDecisionRepository({
  database,
  candidateCardSummerSynchronizer,
} = {}) {
  if (
    !candidateCardSummerSynchronizer ||
    typeof candidateCardSummerSynchronizer.synchronize !== "function"
  ) {
    throw new TypeError(
      "createSqliteProspectDecisionRepository requires a Candidate Card summer synchronizer"
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
  const contracts = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contracts"),
  });
  const contractYears = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contract_years"),
  });
  const contractEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contract_events"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });

  let findOwnershipStatement;
  let deleteOwnershipStatement;
  let signTransaction;
  let releaseTransaction;
  try {
    findOwnershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE id = @ownershipId AND league_id = @leagueId LIMIT 2"
    );
    deleteOwnershipStatement = database.prepare(
      "DELETE FROM player_ownerships " +
        "WHERE id = @ownershipId AND league_id = @leagueId " +
        "AND version = @expectedOwnershipVersion"
    );

    function currentOwnership(decision) {
      const rows = findOwnershipStatement.all(decision);
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "An ownership stable ID is not unique within its league."
        );
      }
      if (!rows[0]) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "The prospect right does not exist."
        );
      }
      const current = freezeRow(rows[0]);
      assertUnsignedProspectOwnership({ current, decision });
      return current;
    }

    signTransaction = database.transaction(({ decision, aggregate }) => {
      const current = currentOwnership(decision);
      const ownership = freezeRow(
        ownerships.updateVersioned({
          key: current.id,
          leagueId: decision.leagueId,
          expectedVersion: decision.expectedOwnershipVersion,
          changes: {
            ownership_kind: "Rostered",
            updated_at_ms: decision.occurredAtMs,
          },
        })
      );
      const contract = freezeRow(contracts.insert(aggregate.contract));
      const years = freezeRows(
        aggregate.years.map((year) => contractYears.insert(year))
      );
      const contractEvent = freezeRow(
        contractEvents.insert(aggregate.event)
      );
      const ownershipEvent = freezeRow(
        ownershipEvents.insert({
          id: decision.ownershipEventId,
          league_id: decision.leagueId,
          season_id: decision.seasonId,
          player_id: decision.playerId,
          team_id: decision.teamId,
          ownership_id: decision.ownershipId,
          event_type: "fantasy_elc_signed",
          actor_user_id: decision.actorUserId,
          source_type: "fantasy_elc",
          source_id: decision.contractId,
          before_metadata_json: JSON.stringify({
            ownershipKind: current.ownership_kind,
            rosterCategory: current.roster_category,
            version: current.version,
          }),
          after_metadata_json: JSON.stringify({
            ownershipKind: ownership.ownership_kind,
            rosterCategory: ownership.roster_category,
            version: ownership.version,
          }),
          reason: null,
          occurred_at_ms: decision.occurredAtMs,
        })
      );
      const activityRow = freezeRow(
        activity.insert({
          id: decision.activityId,
          league_id: decision.leagueId,
          season_id: decision.seasonId,
          event_type: "fantasy_elc_signed",
          actor_user_id: decision.actorUserId,
          actor_authority: decision.actorAuthority,
          team_id: decision.teamId,
          player_id: decision.playerId,
          related_type: "contract",
          related_id: decision.contractId,
          display_summary: "Fantasy ELC signed.",
          reason: null,
          metadata_json: JSON.stringify({
            ownershipId: decision.ownershipId,
            contractId: decision.contractId,
            rosterCategory: "Prospect",
          }),
          occurred_at_ms: decision.occurredAtMs,
        })
      );
      candidateCardSummerSynchronizer.synchronize({
        leagueId: decision.leagueId,
        affectedTeamIds: [decision.teamId],
        affectedPlayerIds: [decision.playerId],
        sourceOperationId: decision.ownershipEventId,
        sourceKind: "prospect_decision",
        nowMs: decision.occurredAtMs,
      });
      return Object.freeze({
        ownership,
        contract,
        years,
        contractEvent,
        ownershipEvent,
        activity: activityRow,
      });
    });

    releaseTransaction = database.transaction((decision) => {
      const current = currentOwnership(decision);
      const eventType =
        decision.decision === "decline_elc"
          ? "fantasy_elc_declined"
          : "unsigned_prospect_rights_released";
      const ownershipEvent = freezeRow(
        ownershipEvents.insert({
          id: decision.ownershipEventId,
          league_id: decision.leagueId,
          season_id: decision.seasonId,
          player_id: decision.playerId,
          team_id: decision.teamId,
          ownership_id: decision.ownershipId,
          event_type: eventType,
          actor_user_id: decision.actorUserId,
          source_type: "prospect_decision",
          source_id: decision.activityId,
          before_metadata_json: JSON.stringify({
            ownershipKind: current.ownership_kind,
            rosterCategory: current.roster_category,
            version: current.version,
          }),
          after_metadata_json: JSON.stringify({ owned: false }),
          reason: decision.reason,
          occurred_at_ms: decision.occurredAtMs,
        })
      );
      const activityRow = freezeRow(
        activity.insert({
          id: decision.activityId,
          league_id: decision.leagueId,
          season_id: decision.seasonId,
          event_type: eventType,
          actor_user_id: decision.actorUserId,
          actor_authority: decision.actorAuthority,
          team_id: decision.teamId,
          player_id: decision.playerId,
          related_type: "player_ownership",
          related_id: decision.ownershipId,
          display_summary:
            decision.decision === "decline_elc"
              ? "Fantasy ELC declined; prospect rights released."
              : "Unsigned prospect rights released.",
          reason: decision.reason,
          metadata_json: JSON.stringify({
            ownershipId: decision.ownershipId,
            decision: decision.decision,
          }),
          occurred_at_ms: decision.occurredAtMs,
        })
      );
      const result = deleteOwnershipStatement.run(decision);
      if (result.changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The prospect right changed before release."
        );
      }
      candidateCardSummerSynchronizer.synchronize({
        leagueId: decision.leagueId,
        affectedTeamIds: [decision.teamId],
        affectedPlayerIds: [decision.playerId],
        sourceOperationId: decision.ownershipEventId,
        sourceKind: "prospect_decision",
        nowMs: decision.occurredAtMs,
      });
      return Object.freeze({
        releasedOwnership: current,
        ownershipEvent,
        activity: activityRow,
      });
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareProspectDecisionRepository",
      tableName: "player_ownerships",
    });
  }

  function rethrow(error, operation) {
    if (
      error instanceof ProspectDecisionPolicyError ||
      error instanceof ContractPolicyError
    ) {
      throw error;
    }
    throw mapRepositoryError(error, {
      operation,
      tableName: "player_ownerships",
    });
  }

  return Object.freeze({
    signFantasyElc(input) {
      const decision = validateProspectElcSigning(input);
      const aggregate = createFantasyElcAggregate({
        contractId: decision.contractId,
        contractYearIds: decision.contractYearIds,
        contractEventId: decision.contractEventId,
        leagueId: decision.leagueId,
        playerId: decision.playerId,
        teamId: decision.teamId,
        startSeasonId: decision.seasonId,
        seasonIds: decision.seasonIds,
        acquisitionSourceId: decision.activityId,
        actorUserId: decision.actorUserId,
        occurredAtMs: decision.occurredAtMs,
      });
      try {
        return signTransaction.immediate({ decision, aggregate });
      } catch (error) {
        rethrow(error, "signFantasyElc");
      }
    },

    releaseUnsignedRights(input) {
      const decision = validateUnsignedProspectRelease(input);
      try {
        return releaseTransaction.immediate(decision);
      } catch (error) {
        rethrow(error, "releaseUnsignedProspectRights");
      }
    },
  });
}

module.exports = { createSqliteProspectDecisionRepository };
