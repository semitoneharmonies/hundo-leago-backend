const {
  calculateStandings,
} = require("../../../domain/matchups/matchupStandingsPolicy");
const {
  calculateStandingsResultSetHash,
} = require(
  "../../../domain/matchups/matchupStandingsFinalizationPolicy"
);

const MATCHUP_STANDINGS_SERVICE_CODES = Object.freeze({
  resultMissing: "MATCHUP_STANDINGS_RESULT_MISSING",
  seasonMissing: "MATCHUP_STANDINGS_SEASON_MISSING",
});

class MatchupStandingsServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupStandingsServiceError";
    this.code = code;
  }
}

const STANDINGS_ROW_FIELDS = Object.freeze([
  "rank",
  "gamesPlayed",
  "wins",
  "losses",
  "ties",
  "standingsPoints",
  "pointsPercentageHundredths",
  "fantasyPointsForHundredths",
  "fantasyPointsAgainstHundredths",
  "fantasyPointsDifferentialHundredths",
]);

function rowsChanged(current, projected) {
  const currentByTeam = new Map(
    current.map((row) => [row.teamId, row])
  );
  return Object.freeze(
    projected
      .filter((row) => {
        const before = currentByTeam.get(row.teamId);
        return (
          !before ||
          STANDINGS_ROW_FIELDS.some(
            (field) => before[field] !== row[field]
          )
        );
      })
      .map(({ teamId }) => teamId)
      .sort()
  );
}

function projectResults(context) {
  const matchups = new Map(
    context.matchups.map((matchup) => [matchup.id, matchup])
  );
  const weeks = new Map(
    context.weeks.map((week) => [week.id, week])
  );
  return Object.freeze(
    context.results
      .map((result) => {
        const matchup = matchups.get(result.matchup_id);
        const week = weeks.get(matchup.matchup_week_id);
        return Object.freeze({
          id: result.matchup_result_id,
          version: result.result_version,
          versionNumber: result.version_number,
          status: result.result_status,
          week: Object.freeze({
            id: week.id,
            sequence: week.sequence,
            startsAtMs: week.starts_at_ms,
            endsAtMs: week.ends_at_ms,
          }),
          matchup: Object.freeze({
            id: matchup.id,
            homeTeam: Object.freeze({
              id: matchup.home_team_id,
              name: matchup.home_team_name,
            }),
            awayTeam: Object.freeze({
              id: matchup.away_team_id,
              name: matchup.away_team_name,
            }),
          }),
          homeScoreHundredths:
            result.home_score_hundredths,
          awayScoreHundredths:
            result.away_score_hundredths,
          outcome: result.outcome,
        });
      })
      .sort(
        (left, right) =>
          left.week.sequence - right.week.sequence ||
          left.matchup.id.localeCompare(right.matchup.id)
      )
  );
}

function createMatchupStandingsService({ repository } = {}) {
  if (!repository || typeof repository.readContext !== "function") {
    throw new TypeError("createMatchupStandingsService requires a standings repository");
  }
  function readContext(input) {
    const context = repository.readContext(input);
    if (!context) {
      throw new MatchupStandingsServiceError(
        MATCHUP_STANDINGS_SERVICE_CODES.seasonMissing,
        "The standings season was not found."
      );
    }
    return context;
  }

  function read(input) {
    const context = readContext(input);
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
      results: projectResults(context),
    });
  }

  function previewCorrection({
    leagueId,
    seasonId,
    resultId,
    homeScoreHundredths,
    awayScoreHundredths,
  } = {}) {
    const context = readContext({ leagueId, seasonId });
    if (!context.results.some(
      (result) => result.matchup_result_id === resultId
    )) {
      throw new MatchupStandingsServiceError(
        MATCHUP_STANDINGS_SERVICE_CODES.resultMissing,
        "The official matchup result was not found."
      );
    }
    const currentRows = calculateStandings(context);
    const projectedRows = calculateStandings({
      ...context,
      results: context.results.map((result) =>
        result.matchup_result_id === resultId
          ? {
              ...result,
              home_score_hundredths:
                homeScoreHundredths,
              away_score_hundredths:
                awayScoreHundredths,
            }
          : result
      ),
    });
    return Object.freeze({
      currentRows,
      projectedRows,
      changedTeamIds: rowsChanged(
        currentRows,
        projectedRows
      ),
    });
  }

  return Object.freeze({ previewCorrection, read });
}

module.exports = {
  MATCHUP_STANDINGS_SERVICE_CODES,
  MatchupStandingsServiceError,
  createMatchupStandingsService,
};
