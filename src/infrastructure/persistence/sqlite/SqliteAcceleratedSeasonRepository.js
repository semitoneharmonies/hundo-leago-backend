const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A stable identifier is required.");
  }
  return value;
}

function createSqliteAcceleratedSeasonRepository({ database } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteAcceleratedSeasonRepository requires a database");
  }
  const season = database.prepare(
    "SELECT id FROM seasons WHERE league_id = @leagueId AND id = @seasonId LIMIT 2"
  );
  const weeks = database.prepare(
    "SELECT * FROM matchup_weeks WHERE league_id = @leagueId AND season_id = @seasonId ORDER BY sequence"
  );
  function readSeason(input) {
    try {
      const scope = { leagueId: stableId(input.leagueId), seasonId: stableId(input.seasonId) };
      const rows = season.all(scope);
      if (rows.length > 1) throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The simulation season is ambiguous.");
      if (rows.length === 0) return null;
      return Object.freeze({
        leagueId: scope.leagueId,
        seasonId: scope.seasonId,
        weeks: Object.freeze(weeks.all(scope).map((row) => Object.freeze({ ...row }))),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readAcceleratedSeason", tableName: "matchup_weeks" });
    }
  }
  return Object.freeze({ readSeason });
}

module.exports = { createSqliteAcceleratedSeasonRepository };
