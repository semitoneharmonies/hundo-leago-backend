const {
  calculateStandings,
} = require("../../../domain/matchups/matchupStandingsPolicy");
const {
  calculateStandingsResultSetHash,
} = require(
  "../../../domain/matchups/matchupStandingsFinalizationPolicy"
);

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
    const resultSetHash = context.resultSetComplete
      ? calculateStandingsResultSetHash({
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          standingsRuleVersion: String(
            context.season.standings_rule_version
          ),
          results: context.results.map((row) => ({
            matchupId: row.matchup_id,
            matchupResultId: row.matchup_result_id,
            resultVersionId: row.result_version_id,
            resultVersion: row.version_number,
          })),
        })
      : null;
    return Object.freeze({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      seasonVersion: context.season.season_version,
      seasonStatus: context.season.season_status,
      standingsRuleVersion:
        context.season.standings_rule_version,
      expectedWeekCount: context.expectedWeekCount,
      expectedMatchupCount:
        context.expectedMatchupCount,
      finalizedResultCount: context.results.length,
      resultSetStatus: context.resultSetComplete
        ? "complete"
        : "incomplete",
      resultSetHash,
      missingMatchupIds: context.missingMatchupIds,
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
