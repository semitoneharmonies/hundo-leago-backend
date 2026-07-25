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
  const refreshStatements = new Map();
  const totalsStatement = database.prepare(
    "SELECT player_id, games_played, goals, assists, fantasy_points_hundredths " +
      "FROM player_stat_totals WHERE refresh_id = @refreshId ORDER BY player_id"
  );

  function sourceProviders(input) {
    const values = Array.isArray(input?.providers)
      ? input.providers
      : [input?.provider];
    if (
      values.length < 1 ||
      values.some((value) =>
        typeof value !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(value)
      ) ||
      new Set(values).size !== values.length
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "An ordered list of statistics providers is required."
      );
    }
    return values;
  }

  function statementsForProviders(providers) {
    const key = providers.join("\u0000");
    const cached = refreshStatements.get(key);
    if (cached) return cached;
    const placeholders = providers.map((_, index) => `@provider${index}`);
    const priority = providers
      .map((_, index) => `WHEN @provider${index} THEN ${index}`)
      .join(" ");
    const providerFilter = `stat_sources.provider IN (${placeholders.join(", ")})`;
    const statements = Object.freeze({
      latest: database.prepare(
        "SELECT stat_refreshes.*, stat_sources.provider FROM stat_refreshes " +
          "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
          `WHERE ${providerFilter} AND stat_sources.status = 'active' ` +
          "AND stat_refreshes.nhl_season_key = @nhlSeasonKey AND stat_refreshes.status = 'succeeded' " +
          `ORDER BY CASE stat_sources.provider ${priority} ELSE 999 END, ` +
          "stat_refreshes.completed_at_ms DESC, stat_refreshes.id DESC LIMIT 1"
      ),
      byId: database.prepare(
        "SELECT stat_refreshes.*, stat_sources.provider FROM stat_refreshes " +
          "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
          `WHERE stat_refreshes.id = @refreshId AND ${providerFilter} ` +
          "AND stat_sources.status = 'active' " +
          "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
          "AND stat_refreshes.status = 'succeeded' LIMIT 2"
      ),
    });
    refreshStatements.set(key, statements);
    return statements;
  }

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
      const providers = sourceProviders(input);
      const sourceInput = Object.assign(
        { nhlSeasonKey: matchup.nhl_season_key },
        Object.fromEntries(providers.map((provider, index) => [`provider${index}`, provider]))
      );
      const sourceStatements = statementsForProviders(providers);
      const teams = {
        ...scope,
        homeTeamId: matchup.home_team_id,
        awayTeamId: matchup.away_team_id,
      };
      let refresh = null;
      if (input.refreshId === undefined) {
        refresh = sourceStatements.latest.get(sourceInput) || null;
      } else {
        const refreshRows = sourceStatements.byId.all({
          ...sourceInput,
          refreshId: stableId(input.refreshId),
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
