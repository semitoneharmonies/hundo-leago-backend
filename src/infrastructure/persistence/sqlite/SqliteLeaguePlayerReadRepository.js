const {
  CANONICAL_UUID_PATTERN,
} = require("../../../domain/players/playerIdentityPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  isPlainObject,
} = require("./createSqliteRecordRepository");

const MAXIMUM_PLAYER_IDS = 100;
const LEAGUE_PLAYER_COLUMNS = Object.freeze([
  "players.id AS player_id",
  "ownership.id AS ownership_id",
  "ownership.ownership_kind",
  "ownership.roster_category",
  "team.id AS team_id",
  "team.name AS team_name",
  "contract.id AS contract_id",
  "contract.original_total_value_cents",
  "contract.original_term_years",
  "contract.aav_cents",
  `COALESCE((
    SELECT COUNT(*)
    FROM contract_years AS contract_year
    WHERE contract_year.league_id = contract.league_id
      AND contract_year.contract_id = contract.id
      AND contract_year.status IN ('current', 'future')
  ), 0) AS remaining_years`,
]);

function stableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical player or league identifier is required."
    );
  }
  return value;
}

function exactObject(value, keys) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Exact league-player read options are required."
    );
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function selectLeaguePlayerSql(predicate) {
  return `
    SELECT ${LEAGUE_PLAYER_COLUMNS.join(", ")}
    FROM players
    LEFT JOIN leagues AS league
      ON league.id = @leagueId
    LEFT JOIN player_ownerships AS ownership
      ON ownership.league_id = league.id
     AND ownership.season_id = league.current_season_id
     AND ownership.player_id = players.id
    LEFT JOIN teams AS team
      ON team.league_id = ownership.league_id
     AND team.id = ownership.team_id
    LEFT JOIN contracts AS contract
      ON contract.league_id = league.id
     AND contract.player_id = players.id
     AND contract.status = 'active'
    WHERE ${predicate}
    ORDER BY players.id ASC
  `;
}

function createSqliteLeaguePlayerReadRepository({ database } = {}) {
  let findByPlayerIdStatement;
  try {
    findByPlayerIdStatement = database.prepare(
      selectLeaguePlayerSql("players.id = @playerId")
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeaguePlayerReadRepository",
      tableName: "player_ownerships",
    });
  }
  const listStatements = new Map();

  function listStatement(count) {
    let statement = listStatements.get(count);
    if (statement) return statement;
    const placeholders = Array.from(
      { length: count },
      (_, index) => `@playerId${index}`
    );
    statement = database.prepare(
      selectLeaguePlayerSql(`players.id IN (${placeholders.join(", ")})`)
    );
    listStatements.set(count, statement);
    return statement;
  }

  return Object.freeze({
    findByPlayerId(options) {
      const lookup = exactObject(options, ["leagueId", "playerId"]);
      try {
        return freezeRow(
          findByPlayerIdStatement.get({
            leagueId: stableId(lookup.leagueId),
            playerId: stableId(lookup.playerId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeaguePlayerRead",
          tableName: "player_ownerships",
        });
      }
    },

    listByPlayerIds(options) {
      const lookup = exactObject(options, ["leagueId", "playerIds"]);
      const leagueId = stableId(lookup.leagueId);
      if (
        !Array.isArray(lookup.playerIds) ||
        lookup.playerIds.length > MAXIMUM_PLAYER_IDS
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "At most 100 player identifiers may be read at once."
        );
      }
      const playerIds = lookup.playerIds.map(stableId);
      if (new Set(playerIds).size !== playerIds.length) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "League-player identifiers must be unique."
        );
      }
      if (playerIds.length === 0) return Object.freeze([]);
      try {
        return freezeRows(
          listStatement(playerIds.length).all({
            leagueId,
            ...Object.fromEntries(
              playerIds.map((playerId, index) => [
                `playerId${index}`,
                playerId,
              ])
            ),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listLeaguePlayerReads",
          tableName: "player_ownerships",
        });
      }
    },
  });
}

module.exports = {
  MAXIMUM_PLAYER_IDS,
  createSqliteLeaguePlayerReadRepository,
};
