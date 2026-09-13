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
    "SELECT matchups.*, matchup_weeks.status AS week_status, " +
      "matchup_weeks.starts_at_ms AS week_starts_at_ms, " +
      "matchup_weeks.ends_at_ms AS week_ends_at_ms, seasons.nhl_season_key " +
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
  const finalRefreshStatement = database.prepare(
    "SELECT stat_refreshes.*, stat_sources.provider " +
      "FROM matchup_results " +
      "JOIN matchup_result_versions " +
      "ON matchup_result_versions.league_id = matchup_results.league_id " +
      "AND matchup_result_versions.season_id = matchup_results.season_id " +
      "AND matchup_result_versions.matchup_result_id = matchup_results.id " +
      "AND matchup_result_versions.id = matchup_results.current_version_id " +
      "JOIN stat_snapshots AS result_snapshots " +
      "ON result_snapshots.league_id = matchup_result_versions.league_id " +
      "AND result_snapshots.season_id = matchup_result_versions.season_id " +
      "AND result_snapshots.matchup_week_id = @weekId " +
      "AND result_snapshots.id = matchup_result_versions.source_snapshot_id " +
      "AND result_snapshots.intended_use = 'matchup_final' " +
      "AND result_snapshots.completeness_status = 'complete' " +
      "AND result_snapshots.freshness_status = 'fresh' " +
      "AND result_snapshots.committed = 1 " +
      "JOIN stat_refreshes " +
      "ON stat_refreshes.id = result_snapshots.source_refresh_id " +
      "AND stat_refreshes.stat_source_id = result_snapshots.stat_source_id " +
      "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
      "WHERE matchup_results.league_id = @leagueId " +
      "AND matchup_results.season_id = @seasonId " +
      "AND matchup_results.matchup_id = @matchupId " +
      "AND matchup_results.status IN ('official', 'corrected') " +
      "AND stat_refreshes.id = @refreshId " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
      "AND stat_refreshes.status = 'succeeded' LIMIT 2"
  );
  const totalsStatement = database.prepare(
    "SELECT player_id, games_played, goals, assists, fantasy_points_hundredths " +
      "FROM player_stat_totals WHERE refresh_id = @refreshId ORDER BY player_id"
  );
  const playerGameSetStatement = database.prepare(
    "SELECT * FROM stat_refresh_player_game_sets WHERE refresh_id = @refreshId LIMIT 2"
  );
  const baselinePlayerGameSetsStatement = database.prepare(
    "SELECT player_game_sets.*, exclusion_sets.id AS exclusion_set_id, " +
      "baseline_snapshots.id AS baseline_snapshot_id " +
      "FROM matchup_roster_game_exclusion_sets AS exclusion_sets " +
      "JOIN stat_snapshots AS baseline_snapshots " +
      "ON baseline_snapshots.league_id = exclusion_sets.league_id " +
      "AND baseline_snapshots.season_id = exclusion_sets.season_id " +
      "AND baseline_snapshots.matchup_week_id = exclusion_sets.matchup_week_id " +
      "AND baseline_snapshots.id = exclusion_sets.baseline_snapshot_id " +
      "AND baseline_snapshots.intended_use = 'matchup_baseline' " +
      "AND baseline_snapshots.completeness_status = 'complete' " +
      "AND baseline_snapshots.freshness_status = 'fresh' " +
      "AND baseline_snapshots.committed = 1 " +
      "AND baseline_snapshots.captured_at_ms = exclusion_sets.late_snapshot_at_ms " +
      "JOIN stat_refresh_player_game_sets AS player_game_sets " +
      "ON player_game_sets.stat_source_id = baseline_snapshots.stat_source_id " +
      "AND player_game_sets.refresh_id = baseline_snapshots.source_refresh_id " +
      "WHERE exclusion_sets.league_id = @leagueId " +
      "AND exclusion_sets.season_id = @seasonId " +
      "AND exclusion_sets.matchup_week_id = @weekId " +
      "AND exclusion_sets.matchup_id = @matchupId " +
      "AND exclusion_sets.team_id IN (@homeTeamId, @awayTeamId) " +
      "ORDER BY exclusion_sets.team_id, exclusion_sets.id"
  );
  const playerGameCoverageStatement = database.prepare(
    "SELECT id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
      "player_id, provider_player_id, provider_team_id, disposition, nhl_game_id, " +
      "nhl_game_scheduled_starts_at_ms, created_at_ms, version " +
      "FROM stat_refresh_player_game_coverage_entries " +
      "WHERE stat_source_id = @statSourceId AND refresh_id = @refreshId " +
      "AND observation_set_id = @setId " +
      "ORDER BY player_id, disposition, nhl_game_id, id"
  );
  const playerGameObservationsStatement = database.prepare(
    "SELECT id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
      "player_id, nhl_game_id, nhl_game_scheduled_starts_at_ms, observed_game_state, " +
      "goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, " +
      "created_at_ms, version FROM player_game_stat_observations " +
      "WHERE stat_source_id = @statSourceId AND refresh_id = @refreshId " +
      "AND observation_set_id = @setId ORDER BY player_id, nhl_game_id, id"
  );
  const exclusionSetsStatement = database.prepare(
    "SELECT exclusion_sets.*, snapshots.provider AS observation_provider, " +
      "snapshots.source_version AS observation_source_version, " +
      "snapshots.observed_at_ms AS observation_observed_at_ms, " +
      "snapshots.freshness_status AS observation_freshness_status, " +
      "snapshots.observation_count AS observation_count, " +
      "snapshots.evidence_schema_version AS observation_evidence_schema_version, " +
      "snapshots.observation_sha256 AS observation_sha256 " +
      "FROM matchup_roster_game_exclusion_sets AS exclusion_sets " +
      "JOIN nhl_game_state_observation_snapshots AS snapshots " +
      "ON snapshots.league_id = exclusion_sets.league_id " +
      "AND snapshots.season_id = exclusion_sets.season_id " +
      "AND snapshots.matchup_week_id = exclusion_sets.matchup_week_id " +
      "AND snapshots.team_id = exclusion_sets.team_id " +
      "AND snapshots.id = exclusion_sets.observation_snapshot_id " +
      "WHERE exclusion_sets.league_id = @leagueId " +
      "AND exclusion_sets.season_id = @seasonId " +
      "AND exclusion_sets.matchup_week_id = @weekId " +
      "AND exclusion_sets.matchup_id = @matchupId " +
      "AND exclusion_sets.team_id IN (@homeTeamId, @awayTeamId) " +
      "ORDER BY exclusion_sets.team_id, exclusion_sets.id"
  );
  const gameStateObservationsStatement = database.prepare(
    "SELECT observations.observation_snapshot_id, observations.id, " +
      "observations.nhl_game_id, observations.nhl_game_scheduled_starts_at_ms, " +
      "observations.observed_game_state, observations.observed_at_ms, " +
      "observations.created_at_ms, observations.version " +
      "FROM matchup_roster_game_exclusion_sets AS exclusion_sets " +
      "JOIN nhl_game_state_observations AS observations " +
      "ON observations.league_id = exclusion_sets.league_id " +
      "AND observations.season_id = exclusion_sets.season_id " +
      "AND observations.observation_snapshot_id = exclusion_sets.observation_snapshot_id " +
      "WHERE exclusion_sets.league_id = @leagueId " +
      "AND exclusion_sets.season_id = @seasonId " +
      "AND exclusion_sets.matchup_week_id = @weekId " +
      "AND exclusion_sets.matchup_id = @matchupId " +
      "AND exclusion_sets.team_id IN (@homeTeamId, @awayTeamId) " +
      "ORDER BY observations.observation_snapshot_id, observations.nhl_game_id, observations.id"
  );
  const exclusionsStatement = database.prepare(
    "SELECT exclusions.*, " +
      "baseline.goals AS baseline_goals, baseline.assists AS baseline_assists, " +
      "baseline.fantasy_points_hundredths AS baseline_fantasy_points_hundredths, " +
      "baseline.source_updated_at_ms AS baseline_source_updated_at_ms, " +
      "baseline.stat_source_id AS baseline_stat_source_id, " +
      "baseline.refresh_id AS baseline_refresh_id, " +
      "baseline.observation_set_id AS baseline_observation_set_id, " +
      "baseline.nhl_season_key AS baseline_nhl_season_key, " +
      "baseline_sets.provider AS baseline_provider, " +
      "baseline_sets.source_version AS baseline_source_version, " +
      "baseline_coverage.provider_player_id AS baseline_provider_player_id, " +
      "baseline_coverage.provider_team_id AS baseline_provider_team_id " +
      "FROM matchup_roster_game_exclusions AS exclusions " +
      "JOIN matchup_roster_game_exclusion_sets AS exclusion_sets " +
      "ON exclusion_sets.league_id = exclusions.league_id " +
      "AND exclusion_sets.season_id = exclusions.season_id " +
      "AND exclusion_sets.matchup_week_id = exclusions.matchup_week_id " +
      "AND exclusion_sets.matchup_id = exclusions.matchup_id " +
      "AND exclusion_sets.team_id = exclusions.team_id " +
      "AND exclusion_sets.matchup_roster_lock_id = exclusions.matchup_roster_lock_id " +
      "AND exclusion_sets.observation_snapshot_id = exclusions.observation_snapshot_id " +
      "AND exclusion_sets.late_snapshot_at_ms = exclusions.late_snapshot_at_ms " +
      "AND exclusion_sets.id = exclusions.exclusion_set_id " +
      "JOIN stat_snapshots AS baseline_snapshot " +
      "ON baseline_snapshot.league_id = exclusion_sets.league_id " +
      "AND baseline_snapshot.season_id = exclusion_sets.season_id " +
      "AND baseline_snapshot.matchup_week_id = exclusion_sets.matchup_week_id " +
      "AND baseline_snapshot.id = exclusion_sets.baseline_snapshot_id " +
      "AND baseline_snapshot.intended_use = 'matchup_baseline' " +
      "AND baseline_snapshot.completeness_status = 'complete' " +
      "AND baseline_snapshot.freshness_status = 'fresh' " +
      "AND baseline_snapshot.committed = 1 " +
      "AND baseline_snapshot.captured_at_ms = exclusion_sets.late_snapshot_at_ms " +
      "JOIN player_game_stat_observations AS baseline " +
      "ON baseline.id = exclusions.baseline_player_game_stat_observation_id " +
      "AND baseline.stat_source_id = baseline_snapshot.stat_source_id " +
      "AND baseline.refresh_id = baseline_snapshot.source_refresh_id " +
      "AND baseline.player_id = exclusions.player_id " +
      "AND baseline.nhl_game_id = exclusions.nhl_game_id " +
      "AND baseline.nhl_game_scheduled_starts_at_ms = " +
      "exclusions.nhl_game_scheduled_starts_at_ms " +
      "JOIN stat_refresh_player_game_sets AS baseline_sets " +
      "ON baseline_sets.id = baseline.observation_set_id " +
      "AND baseline_sets.stat_source_id = baseline.stat_source_id " +
      "AND baseline_sets.refresh_id = baseline.refresh_id " +
      "JOIN stat_refresh_player_game_coverage_entries AS baseline_coverage " +
      "ON baseline_coverage.stat_source_id = baseline.stat_source_id " +
      "AND baseline_coverage.refresh_id = baseline.refresh_id " +
      "AND baseline_coverage.observation_set_id = baseline.observation_set_id " +
      "AND baseline_coverage.nhl_season_key = baseline.nhl_season_key " +
      "AND baseline_coverage.player_id = baseline.player_id " +
      "AND baseline_coverage.nhl_game_id = baseline.nhl_game_id " +
      "AND baseline_coverage.nhl_game_scheduled_starts_at_ms = " +
      "baseline.nhl_game_scheduled_starts_at_ms " +
      "AND baseline_coverage.disposition = 'expected_game' " +
      "WHERE exclusions.league_id = @leagueId AND exclusions.season_id = @seasonId " +
      "AND exclusions.matchup_week_id = @weekId AND exclusions.matchup_id = @matchupId " +
      "AND exclusions.team_id IN (@homeTeamId, @awayTeamId) " +
      "ORDER BY exclusions.team_id, exclusions.player_id, exclusions.nhl_game_id"
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
      const teams = {
        ...scope,
        homeTeamId: matchup.home_team_id,
        awayTeamId: matchup.away_team_id,
      };
      let refresh = null;
      if (input.refreshId === undefined) {
        const providers = sourceProviders(input);
        const sourceInput = Object.assign(
          { nhlSeasonKey: matchup.nhl_season_key },
          Object.fromEntries(providers.map((provider, index) => [`provider${index}`, provider]))
        );
        refresh = statementsForProviders(providers).latest.get(sourceInput) || null;
      } else {
        const refreshRows = finalRefreshStatement.all({
          ...scope,
          nhlSeasonKey: matchup.nhl_season_key,
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
      let playerGameSet = null;
      let playerGameCoverage = Object.freeze([]);
      let playerGameObservations = Object.freeze([]);
      if (refresh) {
        const playerGameSetRows = playerGameSetStatement.all({ refreshId: refresh.id });
        if (playerGameSetRows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The matchup player-game evidence root is ambiguous."
          );
        }
        if (playerGameSetRows.length === 1) {
          playerGameSet = Object.freeze({ ...playerGameSetRows[0] });
          const playerGameScope = {
            statSourceId: playerGameSet.stat_source_id,
            refreshId: playerGameSet.refresh_id,
            setId: playerGameSet.id,
          };
          playerGameCoverage = freezeRows(
            playerGameCoverageStatement.all(playerGameScope)
          );
          playerGameObservations = freezeRows(
            playerGameObservationsStatement.all(playerGameScope)
          );
        }
      }
      const baselinePlayerGameSetRows =
        baselinePlayerGameSetsStatement.all(teams);
      const baselineExclusionSetIds = new Set();
      const baselinePlayerGameEvidence = baselinePlayerGameSetRows.map(
        (row) => {
          if (baselineExclusionSetIds.has(row.exclusion_set_id)) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.schemaIncompatible,
              "A late-lock exclusion set has ambiguous baseline player-game evidence."
            );
          }
          baselineExclusionSetIds.add(row.exclusion_set_id);
          const playerGameScope = {
            statSourceId: row.stat_source_id,
            refreshId: row.refresh_id,
            setId: row.id,
          };
          return Object.freeze({
            exclusionSetId: row.exclusion_set_id,
            baselineSnapshotId: row.baseline_snapshot_id,
            playerGameSet: Object.freeze({
              id: row.id,
              stat_source_id: row.stat_source_id,
              refresh_id: row.refresh_id,
              nhl_season_key: row.nhl_season_key,
              provider: row.provider,
              source_version: row.source_version,
              captured_at_ms: row.captured_at_ms,
              required_player_count: row.required_player_count,
              coverage_entry_count: row.coverage_entry_count,
              expected_player_game_count:
                row.expected_player_game_count,
              coverage_schema_version: row.coverage_schema_version,
              coverage_sha256: row.coverage_sha256,
              observation_count: row.observation_count,
              evidence_schema_version: row.evidence_schema_version,
              evidence_sha256: row.evidence_sha256,
              created_at_ms: row.created_at_ms,
              version: row.version,
            }),
            coverage: freezeRows(
              playerGameCoverageStatement.all(playerGameScope)
            ),
            observations: freezeRows(
              playerGameObservationsStatement.all(playerGameScope)
            ),
          });
        }
      );
      const exclusionSets = freezeRows(
        exclusionSetsStatement.all(teams)
      );
      if (
        baselinePlayerGameEvidence.length !== exclusionSets.length ||
        exclusionSets.some(
          (row) => !baselineExclusionSetIds.has(row.id)
        )
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "A late-lock exclusion set is missing its baseline player-game evidence."
        );
      }
      return Object.freeze({
        matchup,
        locks: freezeRows(locksStatement.all(teams)),
        lockedPlayers: freezeRows(playersStatement.all(teams)),
        refresh: refresh ? Object.freeze({ ...refresh }) : null,
        totals: refresh ? freezeRows(totalsStatement.all({ refreshId: refresh.id })) : Object.freeze([]),
        playerGameSet,
        playerGameCoverage,
        playerGameObservations,
        baselinePlayerGameEvidence:
          Object.freeze(baselinePlayerGameEvidence),
        exclusionSets,
        gameStateObservations: freezeRows(
          gameStateObservationsStatement.all(teams)
        ),
        exclusions: freezeRows(exclusionsStatement.all(teams)),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readLiveMatchupScoringContext", tableName: "matchups" });
    }
  }

  return Object.freeze({ readContext });
}

module.exports = { createSqliteMatchupScoringRepository };
