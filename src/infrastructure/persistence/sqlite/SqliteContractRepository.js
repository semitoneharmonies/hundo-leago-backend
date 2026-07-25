const {
  ContractPolicyError,
  createNormalContractAggregate,
  validateContractLookup,
  validateContractYearLookup,
} = require("../../../domain/contracts/contractPolicy");
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

function createSqliteContractRepository({ database } = {}) {
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

  let findActiveStatement;
  let listYearsStatement;
  let createTransaction;
  try {
    findActiveStatement = database.prepare(
      "SELECT * FROM contracts " +
        "WHERE league_id = @leagueId AND player_id = @playerId " +
        "AND status = 'active' LIMIT 2"
    );
    listYearsStatement = database.prepare(
      "SELECT * FROM contract_years " +
        "WHERE league_id = @leagueId AND contract_id = @contractId " +
        "ORDER BY year_number ASC"
    );
    createTransaction = database.transaction((aggregate) => {
      const contract = freezeRow(
        contracts.insert(aggregate.contract)
      );
      const years = freezeRows(
        aggregate.years.map((year) => contractYears.insert(year))
      );
      const event = freezeRow(
        contractEvents.insert(aggregate.event)
      );
      return Object.freeze({ contract, years, event });
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareContractRepository",
      tableName: "contracts",
    });
  }

  return Object.freeze({
    createNormal(input) {
      const aggregate = createNormalContractAggregate(input);
      try {
        return createTransaction.immediate(aggregate);
      } catch (error) {
        if (error instanceof ContractPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "createNormalContract",
          tableName: "contracts",
        });
      }
    },

    findActiveByPlayer(input) {
      const lookup = validateContractLookup(input);
      try {
        const rows = findActiveStatement.all(lookup);
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A league player has multiple active contracts."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveContractByPlayer",
          tableName: "contracts",
        });
      }
    },

    listYears(input) {
      const lookup = validateContractYearLookup(input);
      try {
        return freezeRows(listYearsStatement.all(lookup));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listContractYears",
          tableName: "contract_years",
        });
      }
    },
  });
}

module.exports = { createSqliteContractRepository };
