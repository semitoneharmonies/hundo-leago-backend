const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function freezeRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function createSqliteMatchupReadRepository({ database } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupReadRepository requires a database");
  }

  const seasonStatement = database.prepare(
    "SELECT seasons.id, seasons.league_id, seasons.status, seasons.version, " +
      "seasons.nhl_season_key FROM seasons WHERE seasons.league_id = @leagueId " +
      "AND seasons.id = @seasonId LIMIT 2"
  );
  const weeksStatement = database.prepare(
    "SELECT * FROM matchup_weeks WHERE league_id = @leagueId " +
      "AND season_id = @seasonId ORDER BY sequence"
  );
  const matchupsStatement = database.prepare(
    "SELECT matchups.*, home_team.name AS current_home_team_name, " +
      "away_team.name AS current_away_team_name FROM matchups " +
      "LEFT JOIN teams AS home_team ON home_team.league_id = matchups.league_id " +
      "AND home_team.id = matchups.home_team_id " +
      "LEFT JOIN teams AS away_team ON away_team.league_id = matchups.league_id " +
      "AND away_team.id = matchups.away_team_id " +
      "WHERE matchups.league_id = @leagueId " +
      "AND matchups.season_id = @seasonId ORDER BY matchups.matchup_week_id, matchups.id"
  );
  const byesStatement = database.prepare(
    "SELECT matchup_byes.*, teams.name AS current_team_name, " +
      "matchup_weeks.status AS week_status FROM matchup_byes " +
      "LEFT JOIN teams ON teams.league_id = matchup_byes.league_id " +
      "AND teams.id = matchup_byes.team_id " +
      "JOIN matchup_weeks ON matchup_weeks.league_id = matchup_byes.league_id " +
      "AND matchup_weeks.id = matchup_byes.matchup_week_id " +
      "WHERE matchup_byes.league_id = @leagueId " +
      "AND matchup_byes.season_id = @seasonId " +
      "ORDER BY matchup_byes.matchup_week_id, matchup_byes.team_id"
  );
  const weekStatement = database.prepare(
    "SELECT * FROM matchup_weeks WHERE league_id = @leagueId " +
      "AND season_id = @seasonId AND id = @weekId LIMIT 2"
  );
  const matchupStatement = database.prepare(
    "SELECT matchups.*, matchup_weeks.week_key, matchup_weeks.sequence, " +
      "matchup_weeks.starts_at_ms, matchup_weeks.baseline_at_ms, " +
      "matchup_weeks.locks_at_ms, matchup_weeks.ends_at_ms, " +
    "matchup_weeks.rolls_over_at_ms, matchup_weeks.status AS week_status, " +
      "matchup_weeks.version AS week_version, " +
      "home_team.name AS current_home_team_name, " +
      "away_team.name AS current_away_team_name FROM matchups " +
      "JOIN matchup_weeks ON matchup_weeks.league_id = matchups.league_id " +
      "AND matchup_weeks.id = matchups.matchup_week_id " +
      "LEFT JOIN teams AS home_team ON home_team.league_id = matchups.league_id " +
      "AND home_team.id = matchups.home_team_id " +
      "LEFT JOIN teams AS away_team ON away_team.league_id = matchups.league_id " +
      "AND away_team.id = matchups.away_team_id " +
      "WHERE matchups.league_id = @leagueId AND matchups.season_id = @seasonId " +
      "AND matchups.matchup_week_id = @weekId AND matchups.id = @matchupId LIMIT 2"
  );
  const resultStatement = database.prepare(
    "SELECT matchup_results.*, matchup_result_versions.id AS result_version_id, " +
      "matchup_result_versions.version_number, matchup_result_versions.home_team_id, " +
      "matchup_result_versions.away_team_id, matchup_result_versions.home_score_hundredths, " +
      "matchup_result_versions.away_score_hundredths, matchup_result_versions.outcome, " +
      "matchup_result_versions.source_type, matchup_result_versions.reason, " +
      "matchup_result_versions.source_snapshot_id, " +
      "stat_snapshots.source_refresh_id AS result_source_refresh_id, " +
      "matchup_result_versions.created_at_ms AS result_version_created_at_ms " +
      "FROM matchup_results JOIN matchup_result_versions " +
      "ON matchup_result_versions.league_id = matchup_results.league_id " +
      "AND matchup_result_versions.id = matchup_results.current_version_id " +
      "JOIN stat_snapshots " +
      "ON stat_snapshots.league_id = matchup_result_versions.league_id " +
      "AND stat_snapshots.id = matchup_result_versions.source_snapshot_id " +
      "WHERE matchup_results.league_id = @leagueId " +
      "AND matchup_results.matchup_id = @matchupId LIMIT 2"
  );
  const resultScopeStatement = database.prepare(
    "SELECT matchup_results.id AS result_id, matchup_results.version AS result_version, " +
      "matchups.matchup_week_id AS week_id, matchups.id AS matchup_id, " +
      "matchup_result_versions.id AS result_version_id, " +
      "matchup_result_versions.version_number, " +
      "matchup_result_versions.home_score_hundredths, " +
      "matchup_result_versions.away_score_hundredths, matchup_result_versions.outcome " +
      "FROM matchup_results JOIN matchups ON matchups.league_id = matchup_results.league_id " +
      "AND matchups.id = matchup_results.matchup_id " +
      "JOIN matchup_result_versions " +
      "ON matchup_result_versions.league_id = matchup_results.league_id " +
      "AND matchup_result_versions.id = matchup_results.current_version_id " +
      "WHERE matchup_results.league_id = @leagueId " +
      "AND matchup_results.season_id = @seasonId " +
      "AND matchup_results.id = @resultId LIMIT 2"
  );
  const latestSuccessfulRefreshStatement = database.prepare(
      "SELECT stat_refreshes.id, stat_refreshes.status, stat_refreshes.completed_at_ms " +
      "FROM stat_refreshes JOIN stat_sources " +
      "ON stat_sources.id = stat_refreshes.stat_source_id " +
      "WHERE stat_sources.status = 'active' " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
      "AND stat_refreshes.status = 'succeeded' " +
      "ORDER BY stat_refreshes.completed_at_ms DESC, stat_refreshes.id DESC LIMIT 1"
  );
  const latestRefreshStatement = database.prepare(
      "SELECT stat_refreshes.id, stat_refreshes.status, stat_refreshes.started_at_ms, " +
      "stat_refreshes.completed_at_ms FROM stat_refreshes JOIN stat_sources " +
      "ON stat_sources.id = stat_refreshes.stat_source_id " +
      "WHERE stat_sources.status = 'active' " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
      "ORDER BY stat_refreshes.started_at_ms DESC, stat_refreshes.id DESC LIMIT 1"
  );

  function one(rows, message) {
    if (rows.length > 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, message);
    }
    return rows[0] ? Object.freeze({ ...rows[0] }) : null;
  }

  function seasonScope(input) {
    return {
      leagueId: stableId(input.leagueId),
      seasonId: stableId(input.seasonId),
    };
  }

  function readSeason(scope) {
    return one(
      seasonStatement.all(scope),
      "The matchup season scope is ambiguous."
    );
  }

  function readHealth(season) {
    const key = { nhlSeasonKey: season.nhl_season_key };
    const successful = latestSuccessfulRefreshStatement.get(key) || null;
    const latest = latestRefreshStatement.get(key) || null;
    return Object.freeze({
      latest: latest ? Object.freeze({ ...latest }) : null,
      latestSuccessful: successful ? Object.freeze({ ...successful }) : null,
    });
  }

  function readSchedule(input) {
    try {
      const scope = seasonScope(input);
      const season = readSeason(scope);
      if (!season) return null;
      return Object.freeze({
        season,
        health: readHealth(season),
        weeks: freezeRows(weeksStatement.all(scope)),
        matchups: freezeRows(matchupsStatement.all(scope)),
        byes: freezeRows(byesStatement.all(scope)),
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readMatchupScheduleProjection",
        tableName: "matchup_weeks",
      });
    }
  }

  function readWeek(input) {
    try {
      const scope = {
        ...seasonScope(input),
        weekId: stableId(input.weekId),
      };
      const week = one(
        weekStatement.all(scope),
        "The matchup week scope is ambiguous."
      );
      if (!week) return null;
      return Object.freeze({
        week,
        matchups: freezeRows(
          matchupsStatement
            .all(scope)
            .filter((row) => row.matchup_week_id === scope.weekId)
        ),
        byes: freezeRows(
          byesStatement
            .all(scope)
            .filter((row) => row.matchup_week_id === scope.weekId)
        ),
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readMatchupWeekProjection",
        tableName: "matchup_weeks",
      });
    }
  }

  function readMatchup(input) {
    try {
      const scope = {
        ...seasonScope(input),
        weekId: stableId(input.weekId),
        matchupId: stableId(input.matchupId),
      };
      const matchup = one(
        matchupStatement.all(scope),
        "The matchup scope is ambiguous."
      );
      if (!matchup) return null;
      const result = one(
        resultStatement.all(scope),
        "The official matchup result is ambiguous."
      );
      return Object.freeze({ matchup, result });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readMatchupProjection",
        tableName: "matchups",
      });
    }
  }

  function readResultScope(input) {
    try {
      const scope = {
        ...seasonScope(input),
        resultId: stableId(input.resultId),
      };
      return one(
        resultScopeStatement.all(scope),
        "The matchup-result scope is ambiguous."
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readMatchupResultScope",
        tableName: "matchup_results",
      });
    }
  }

  return Object.freeze({
    readMatchup,
    readResultScope,
    readSchedule,
    readWeek,
  });
}

module.exports = { createSqliteMatchupReadRepository };
