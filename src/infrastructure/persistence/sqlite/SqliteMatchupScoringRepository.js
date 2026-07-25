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

function createSqliteMatchupScoringRepository({ database } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupScoringRepository requires a database");
  }
  const matchupStatement = database.prepare(
    "SELECT matchups.*, matchup_weeks.status AS week_status, seasons.nhl_season_key " +
      "FROM matchups JOIN matchup_weeks ON matchup_weeks.league_id = matchups.league_id " +
      "AND matchup_weeks.id = matchups.matchup_week_id " +
      "JOIN seasons ON seasons.league_id = matchups.league_id AND seasons.id = matchups.season_id " +
      "WHERE matchups.league_id = @leagueId AND matchups.season_id = @seasonId " +
      "AND matchups.matchup_week_id = @weekId AND matchups.id = @matchupId LIMIT 2"
  );
  const locksStatement = database.prepare(
    "SELECT * FROM matchup_roster_locks WHERE league_id = @leagueId " +
      "AND season_id = @seasonId AND matchup_week_id = @weekId " +
      "AND team_id IN (@homeTeamId, @awayTeamId) ORDER BY team_id"
  );
  const playersStatement = database.prepare(
    "SELECT matchup_roster_players.*, players.full_name AS player_full_name " +
      "FROM matchup_roster_players " +
      "JOIN matchup_roster_locks ON matchup_roster_locks.league_id = matchup_roster_players.league_id " +
      "AND matchup_roster_locks.id = matchup_roster_players.matchup_roster_lock_id " +
      "JOIN players ON players.id = matchup_roster_players.player_id " +
      "WHERE matchup_roster_players.league_id = @leagueId " +
      "AND matchup_roster_locks.matchup_week_id = @weekId " +
      "AND matchup_roster_locks.team_id IN (@homeTeamId, @awayTeamId) " +
      "ORDER BY matchup_roster_locks.team_id, matchup_roster_players.position_group, " +
      "matchup_roster_players.slot_number"
  );
  const refreshStatement = database.prepare(
    "SELECT stat_refreshes.*, stat_sources.provider FROM stat_refreshes " +
      "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
      "WHERE stat_sources.provider = @provider AND stat_sources.status = 'active' " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey AND stat_refreshes.status = 'succeeded' " +
      "ORDER BY stat_refreshes.completed_at_ms DESC, stat_refreshes.id DESC LIMIT 1"
  );
  const refreshByIdStatement = database.prepare(
    "SELECT stat_refreshes.*, stat_sources.provider FROM stat_refreshes " +
      "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
      "WHERE stat_refreshes.id = @refreshId AND stat_sources.provider = @provider " +
      "AND stat_sources.status = 'active' " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
      "AND stat_refreshes.status = 'succeeded' LIMIT 2"
  );
  const totalsStatement = database.prepare(
    "SELECT player_id, games_played, goals, assists, fantasy_points_hundredths " +
      "FROM player_stat_totals WHERE refresh_id = @refreshId ORDER BY player_id"
  );

  function readContext(input) {
    try {
      const scope = {
        leagueId: stableId(input.leagueId),
        seasonId: stableId(input.seasonId),
        weekId: stableId(input.weekId),
        matchupId: stableId(input.matchupId),
      };
      const rows = matchupStatement.all(scope);
      if (rows.length > 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The matchup is ambiguous.");
      }
      if (rows.length === 0) return null;
      const matchup = Object.freeze({ ...rows[0] });
      const teams = {
        ...scope,
        homeTeamId: matchup.home_team_id,
        awayTeamId: matchup.away_team_id,
      };
      let refresh = null;
      if (input.refreshId === undefined) {
        refresh = refreshStatement.get({
          provider: input.provider,
          nhlSeasonKey: matchup.nhl_season_key,
        }) || null;
      } else {
        const refreshRows = refreshByIdStatement.all({
          refreshId: stableId(input.refreshId),
          provider: input.provider,
          nhlSeasonKey: matchup.nhl_season_key,
        });
        if (refreshRows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The matchup statistics refresh is ambiguous."
          );
        }
        refresh = refreshRows[0] || null;
      }
      return Object.freeze({
        matchup,
        locks: freezeRows(locksStatement.all(teams)),
        lockedPlayers: freezeRows(playersStatement.all(teams)),
        refresh: refresh ? Object.freeze({ ...refresh }) : null,
        totals: refresh ? freezeRows(totalsStatement.all({ refreshId: refresh.id })) : Object.freeze([]),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readLiveMatchupScoringContext", tableName: "matchups" });
    }
  }

  return Object.freeze({ readContext });
}

module.exports = { createSqliteMatchupScoringRepository };
