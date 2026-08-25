const {
  LeaguePlayerOwnershipPolicyError,
  createLeaguePositionCorrectionRecord,
  validateLeaguePlayerLookup,
  validatePositionCorrectionReplacement,
  validateTeamOwnershipLookup,
} = require(
  "../../../domain/players/leaguePlayerOwnershipPolicy"
);
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

function requireUniqueRow(rows, message) {
  if (rows.length > 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      message
    );
  }
  return freezeRow(rows[0]);
}

function createSqliteLeaguePlayerOwnershipRepository({
  database,
  candidateCardSummerSynchronizer,
} = {}) {
  if (
    !candidateCardSummerSynchronizer ||
    typeof candidateCardSummerSynchronizer.synchronize !== "function"
  ) {
    throw new TypeError(
      "createSqliteLeaguePlayerOwnershipRepository requires a Candidate Card summer synchronizer"
    );
  }
  const corrections = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition(
      "league_player_positions"
    ),
  });
  createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("player_ownerships"),
  });

  let findCurrentCorrectionStatement;
  let findOwnershipStatement;
  let listTeamOwnershipStatement;
  let replaceCurrentCorrection;
  try {
    findCurrentCorrectionStatement = database.prepare(
      "SELECT * FROM league_player_positions " +
        "WHERE league_id = @leagueId " +
        "AND player_id = @playerId " +
        "AND ended_at_ms IS NULL LIMIT 2"
    );
    findOwnershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE league_id = @leagueId " +
        "AND player_id = @playerId LIMIT 2"
    );
    listTeamOwnershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE league_id = @leagueId " +
        "AND season_id = @seasonId " +
        "AND team_id = @teamId " +
        "ORDER BY roster_category ASC, position_group ASC, " +
        "slot_number ASC, player_id ASC"
    );
    replaceCurrentCorrection = database.transaction(
      (replacement) => {
        const current = requireUniqueRow(
          findCurrentCorrectionStatement.all({
            leagueId: replacement.league_id,
            playerId: replacement.player_id,
          }),
          "A league player has multiple current position corrections."
        );

        let previous = null;
        if (current) {
          validatePositionCorrectionReplacement({
            currentEffectiveAtMs: current.effective_at_ms,
            replacementEffectiveAtMs:
              replacement.effective_at_ms,
          });
          previous = freezeRow(
            corrections.updateVersioned({
              key: current.id,
              leagueId: current.league_id,
              expectedVersion: current.version,
              changes: {
                ended_at_ms: replacement.effective_at_ms,
              },
            })
          );
        }

        const created = freezeRow(corrections.insert(replacement));
        const ownership = requireUniqueRow(
          findOwnershipStatement.all({
            leagueId: replacement.league_id,
            playerId: replacement.player_id,
          }),
          "A league player has multiple current ownership records."
        );
        candidateCardSummerSynchronizer.synchronize({
          leagueId: replacement.league_id,
          affectedTeamIds: ownership ? [ownership.team_id] : [],
          affectedPlayerIds: [replacement.player_id],
          sourceOperationId: replacement.id,
          sourceKind: "position_correction",
          nowMs: replacement.effective_at_ms,
        });
        return Object.freeze({
          previous,
          current: created,
        });
      }
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeaguePlayerOwnershipRepository",
      tableName: "league_player_positions",
    });
  }

  function findCurrentPositionCorrection(input) {
    const lookup = validateLeaguePlayerLookup(input);
    try {
      return requireUniqueRow(
        findCurrentCorrectionStatement.all(lookup),
        "A league player has multiple current position corrections."
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "findCurrentPositionCorrection",
        tableName: "league_player_positions",
      });
    }
  }

  function findOwnership(input) {
    const lookup = validateLeaguePlayerLookup(input);
    try {
      return requireUniqueRow(
        findOwnershipStatement.all(lookup),
        "A league player has multiple current ownership records."
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "findOwnership",
        tableName: "player_ownerships",
      });
    }
  }

  function listTeamOwnership(input) {
    const lookup = validateTeamOwnershipLookup(input);
    try {
      return freezeRows(listTeamOwnershipStatement.all(lookup));
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "listTeamOwnership",
        tableName: "player_ownerships",
      });
    }
  }

  return Object.freeze({
    findCurrentPositionCorrection,
    findOwnership,
    listTeamOwnership,
    replaceCurrentPositionCorrection(input) {
      const replacement =
        createLeaguePositionCorrectionRecord(input);
      try {
        return replaceCurrentCorrection.immediate(replacement);
      } catch (error) {
        if (error instanceof LeaguePlayerOwnershipPolicyError) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "replaceCurrentPositionCorrection",
          tableName: "league_player_positions",
        });
      }
    },
  });
}

module.exports = {
  createSqliteLeaguePlayerOwnershipRepository,
};
