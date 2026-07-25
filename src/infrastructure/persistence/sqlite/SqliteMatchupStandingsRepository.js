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

function freezeRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function createSqliteMatchupStandingsRepository({ database } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupStandingsRepository requires a database");
  }
  const seasonStatement = database.prepare(
    "SELECT id FROM seasons WHERE league_id = @leagueId AND id = @seasonId LIMIT 2"
  );
  const participantStatement = database.prepare(
    "SELECT home_team_id AS team_id, home_team_name AS team_display_name FROM matchups " +
      "WHERE league_id = @leagueId AND season_id = @seasonId " +
      "UNION ALL SELECT away_team_id, away_team_name FROM matchups " +
      "WHERE league_id = @leagueId AND season_id = @seasonId " +
      "UNION ALL SELECT team_id, team_display_name FROM matchup_byes " +
      "WHERE league_id = @leagueId AND season_id = @seasonId ORDER BY team_id"
  );
  const resultStatement = database.prepare(
    "SELECT matchup_result_versions.* FROM matchup_results " +
      "JOIN matchup_result_versions ON matchup_result_versions.league_id = matchup_results.league_id " +
      "AND matchup_result_versions.id = matchup_results.current_version_id " +
      "WHERE matchup_results.league_id = @leagueId AND matchup_results.season_id = @seasonId " +
      "AND matchup_results.status IN ('official', 'corrected') " +
      "ORDER BY matchup_result_versions.matchup_result_id"
  );

  function readContext(input) {
    try {
      const scope = { leagueId: stableId(input.leagueId), seasonId: stableId(input.seasonId) };
      const seasons = seasonStatement.all(scope);
      if (seasons.length > 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The standings season is ambiguous.");
      }
      if (seasons.length === 0) return null;
      const participantRows = participantStatement.all(scope);
      const participantsById = new Map();
      for (const participant of participantRows) {
        const existing = participantsById.get(participant.team_id);
        if (existing && existing.team_display_name !== participant.team_display_name) {
          throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "A schedule participant has inconsistent display context.");
        }
        participantsById.set(participant.team_id, participant);
      }
      return Object.freeze({
        participants: freezeRows([...participantsById.values()].sort((left, right) => left.team_id.localeCompare(right.team_id))),
        results: freezeRows(resultStatement.all(scope)),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readAuthoritativeStandingsContext", tableName: "matchup_results" });
    }
  }

  return Object.freeze({ readContext });
}

module.exports = { createSqliteMatchupStandingsRepository };
