const {
  calculateStandings,
} = require("../../../domain/matchups/matchupStandingsPolicy");

const MATCHUP_STANDINGS_SERVICE_CODES = Object.freeze({
  seasonMissing: "MATCHUP_STANDINGS_SEASON_MISSING",
});

class MatchupStandingsServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupStandingsServiceError";
    this.code = code;
  }
}

function createMatchupStandingsService({ repository } = {}) {
  if (!repository || typeof repository.readContext !== "function") {
    throw new TypeError("createMatchupStandingsService requires a standings repository");
  }
  function read(input) {
    const context = repository.readContext(input);
    if (!context) {
      throw new MatchupStandingsServiceError(
        MATCHUP_STANDINGS_SERVICE_CODES.seasonMissing,
        "The standings season was not found."
      );
    }
    return Object.freeze({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      finalizedResultCount: context.results.length,
      sourceResultVersion: context.results.reduce((sum, row) => sum + row.version_number, 0),
      rows: calculateStandings(context),
    });
  }
  return Object.freeze({ read });
}

module.exports = {
  MATCHUP_STANDINGS_SERVICE_CODES,
  MatchupStandingsServiceError,
  createMatchupStandingsService,
};
