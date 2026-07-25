const {
  RetentionPolicyError,
  createRetentionAggregate,
  validateRetentionCommand,
  validateRetentionTeamLookup,
  validateRetentionYearLookup,
} = require("../../../domain/contracts/retentionPolicy");
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

function createSqliteRetentionRepository({ database } = {}) {
  const obligations = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("retention_obligations"),
  });
  const years = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("retention_years"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });

  let findContractStatement;
  let remainingYearsStatement;
  let cumulativeStatement;
  let teamSlotsStatement;
  let duplicateStatement;
  let listTeamStatement;
  let listYearsStatement;
  let createTransaction;
  try {
    findContractStatement = database.prepare(
      "SELECT * FROM contracts " +
        "WHERE id = @contractId AND league_id = @leagueId LIMIT 2"
    );
    remainingYearsStatement = database.prepare(
      "SELECT season_id, status FROM contract_years " +
        "WHERE contract_id = @contractId AND league_id = @leagueId " +
        "AND status IN ('current', 'future') ORDER BY year_number ASC"
    );
    cumulativeStatement = database.prepare(
      "SELECT COALESCE(SUM(retained_aav_cents), 0) AS amount " +
        "FROM retention_obligations " +
        "WHERE contract_id = @contractId AND league_id = @leagueId " +
        "AND status = 'active'"
    );
    teamSlotsStatement = database.prepare(
      "SELECT COUNT(*) AS count FROM retention_obligations " +
        "WHERE responsible_team_id = @responsibleTeamId " +
        "AND league_id = @leagueId AND status = 'active'"
    );
    duplicateStatement = database.prepare(
      "SELECT COUNT(*) AS count FROM retention_obligations " +
        "WHERE contract_id = @contractId " +
        "AND responsible_team_id = @responsibleTeamId " +
        "AND league_id = @leagueId AND status = 'active'"
    );
    listTeamStatement = database.prepare(
      "SELECT * FROM retention_obligations " +
        "WHERE league_id = @leagueId " +
        "AND responsible_team_id = @responsibleTeamId " +
        "AND status = 'active' ORDER BY created_at_ms ASC, id ASC"
    );
    listYearsStatement = database.prepare(
      "SELECT * FROM retention_years " +
        "WHERE league_id = @leagueId " +
        "AND retention_obligation_id = @retentionId " +
        "ORDER BY CASE status WHEN 'current' THEN 0 ELSE 1 END, season_id ASC"
    );

    createTransaction = database.transaction((command) => {
      const contracts = findContractStatement.all(command);
      if (contracts.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "A contract stable ID is not unique within its league."
        );
      }
      if (!contracts[0]) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "The retained-salary contract does not exist."
        );
      }
      const contract = freezeRow(contracts[0]);
      const remaining = remainingYearsStatement.all(command).map((year) => ({
        seasonId: year.season_id,
        status: year.status,
      }));
      const aggregate = createRetentionAggregate({
        command,
        contractAavCents: contract.aav_cents,
        contractPlayerId: contract.player_id,
        contractCurrentTeamId: contract.current_team_id,
        contractStatus: contract.status,
        remainingContractYears: remaining,
        existingRetainedAavCents:
          cumulativeStatement.get(command).amount,
        responsibleTeamActiveRetentionCount:
          teamSlotsStatement.get(command).count,
        responsibleTeamAlreadyRetainsContract:
          duplicateStatement.get(command).count !== 0,
      });
      const obligation = freezeRow(
        obligations.insert(aggregate.obligation)
      );
      const retentionYears = freezeRows(
        aggregate.years.map((year) => years.insert(year))
      );
      const activityRow = freezeRow(
        activity.insert({
          id: command.activityId,
          league_id: command.leagueId,
          season_id: remaining[0].seasonId,
          event_type: "retained_salary_created",
          actor_user_id: command.actorUserId,
          actor_authority: command.actorAuthority,
          team_id: command.responsibleTeamId,
          player_id: command.playerId,
          related_type: "retention_obligation",
          related_id: command.retentionId,
          display_summary: "Retained-salary obligation created.",
          reason: null,
          metadata_json: JSON.stringify({
            contractId: command.contractId,
            retainedAavCents: command.retainedAavCents,
            retentionCeilingCents: aggregate.retentionCeilingCents,
            cumulativeRetainedAavCents:
              aggregate.cumulativeRetainedAavCents,
            remainingYears: retentionYears.length,
          }),
          occurred_at_ms: command.occurredAtMs,
        })
      );
      return Object.freeze({
        obligation,
        years: retentionYears,
        activity: activityRow,
        retentionCeilingCents: aggregate.retentionCeilingCents,
        cumulativeRetainedAavCents:
          aggregate.cumulativeRetainedAavCents,
      });
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareRetentionRepository",
      tableName: "retention_obligations",
    });
  }

  return Object.freeze({
    create(input) {
      const command = validateRetentionCommand(input);
      try {
        return createTransaction.immediate(command);
      } catch (error) {
        if (error instanceof RetentionPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "createRetentionObligation",
          tableName: "retention_obligations",
        });
      }
    },

    listActiveByResponsibleTeam(input) {
      const lookup = validateRetentionTeamLookup(input);
      try {
        return freezeRows(listTeamStatement.all(lookup));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listActiveRetentionByTeam",
          tableName: "retention_obligations",
        });
      }
    },

    listYears(input) {
      const lookup = validateRetentionYearLookup(input);
      try {
        return freezeRows(listYearsStatement.all(lookup));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listRetentionYears",
          tableName: "retention_years",
        });
      }
    },
  });
}

module.exports = { createSqliteRetentionRepository };
