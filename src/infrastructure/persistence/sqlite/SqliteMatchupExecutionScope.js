const { normalizeMatchupExecutionLeagueIds } = require("../../../domain/matchups/matchupExecutionScope");
const { assertNhlSeasonKey } = require("../../../domain/statistics/statisticsPolicy");

// Shared by occurrence claims and every late-lock lookup. This only selects
// eligible work; excluded jobs and previously captured evidence are never edited.
function createSqliteMatchupExecutionScope({ leagueIds = null, nhlSeasonKey = null } = {}, weekAlias) {
  if (!["owning_week", "weeks"].includes(weekAlias)) throw new TypeError("A known matchup week alias is required.");
  const normalizedIds = normalizeMatchupExecutionLeagueIds(leagueIds);
  const season = nhlSeasonKey === null ? null : assertNhlSeasonKey(nhlSeasonKey);
  const parameters = Object.freeze({
    executionLeagueIds: normalizedIds === null ? null : JSON.stringify(normalizedIds),
    executionNhlSeasonKey: season,
  });
  const sql = `
    AND (@executionLeagueIds IS NULL OR ${weekAlias}.league_id IN (SELECT value FROM json_each(@executionLeagueIds)))
    AND (@executionNhlSeasonKey IS NULL OR (
      EXISTS (SELECT 1 FROM seasons AS execution_season
        WHERE execution_season.league_id = ${weekAlias}.league_id
          AND execution_season.id = ${weekAlias}.season_id
          AND execution_season.nhl_season_key = @executionNhlSeasonKey)
      AND NOT EXISTS (
        SELECT 1 FROM stat_snapshots AS execution_snapshot
        JOIN stat_sources AS execution_source ON execution_source.id = execution_snapshot.stat_source_id
        WHERE execution_snapshot.league_id = ${weekAlias}.league_id
          AND execution_snapshot.season_id = ${weekAlias}.season_id
          AND execution_snapshot.matchup_week_id = ${weekAlias}.id
          AND execution_snapshot.intended_use IN ('matchup_baseline', 'matchup_final')
          AND execution_snapshot.committed = 1
          AND execution_source.provider <> 'nhl-completed-games'
      )
    ))
  `;
  return Object.freeze({ sql, parameters });
}

module.exports = { createSqliteMatchupExecutionScope };
