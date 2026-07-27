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

function createSqliteMatchupScheduleRepository({ database, beforeCommit } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupScheduleRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup schedule beforeCommit must be a function");
  }

  const contextStatement = database.prepare(
    "SELECT leagues.id AS league_id, leagues.timezone, leagues.commissioner_membership_id, " +
      "seasons.id AS season_id, seasons.status AS season_status, seasons.version AS season_version, " +
      "seasons.regular_season_starts_at_ms, seasons.fantasy_playoffs_start_at_ms, " +
      "league_settings.scoring_rule_version, league_memberships.user_id AS commissioner_user_id " +
      "FROM seasons JOIN leagues ON leagues.id = seasons.league_id " +
      "JOIN league_settings ON league_settings.league_id = leagues.id " +
      "LEFT JOIN league_memberships ON league_memberships.id = leagues.commissioner_membership_id " +
      "AND league_memberships.league_id = leagues.id AND league_memberships.status = 'active' " +
      "WHERE seasons.league_id = @leagueId AND seasons.id = @seasonId LIMIT 2"
  );
  const teamsStatement = database.prepare(
    "SELECT id, name, primary_colour, secondary_colour, logo_reference, version " +
      "FROM teams WHERE league_id = @leagueId AND status = 'active' ORDER BY id"
  );
  const existingScheduleStatement = database.prepare(
    "SELECT COUNT(*) AS count FROM matchup_weeks " +
      "WHERE league_id = @leagueId AND season_id = @seasonId"
  );
  const insertWeek = database.prepare(
    "INSERT INTO matchup_weeks " +
      "(id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (@id, @leagueId, @seasonId, @weekKey, @sequence, @startsAtMs, @baselineAtMs, " +
      "@locksAtMs, @endsAtMs, @rollsOverAtMs, 'scheduled', @nowMs, @nowMs, 1)"
  );
  const insertMatchup = database.prepare(
    "INSERT INTO matchups " +
      "(id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, " +
      "created_at_ms, updated_at_ms, version) " +
      "VALUES (@id, @leagueId, @seasonId, @weekId, @homeTeamId, @awayTeamId, " +
      "@homeTeamName, @awayTeamName, 'scheduled', " +
      "@nowMs, @nowMs, 1)"
  );
  const insertBye = database.prepare(
    "INSERT INTO matchup_byes " +
      "(id, league_id, season_id, matchup_week_id, team_id, team_display_name, created_at_ms) " +
      "VALUES (@id, @leagueId, @seasonId, @weekId, @teamId, @teamDisplayName, @nowMs)"
  );
  const insertOperation = database.prepare(
    "INSERT INTO matchup_operations " +
      "(id, league_id, season_id, matchup_week_id, matchup_id, actor_user_id, " +
      "operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms) " +
      "VALUES (@id, @leagueId, @seasonId, NULL, NULL, @actorUserId, " +
      "'schedule_generate', 'succeeded', NULL, @metadataJson, @nowMs, @nowMs)"
  );
  const insertJobOccurrence = database.prepare(
    "INSERT INTO job_runs (id, league_id, season_id, job_type, occurrence_key, " +
      "scheduled_for_ms, status, attempt_count, lease_owner, lease_expires_at_ms, " +
      "started_at_ms, completed_at_ms, result_json, last_error_code, created_at_ms, " +
      "updated_at_ms, version, lease_token, next_attempt_at_ms) VALUES " +
      "(@runId, @leagueId, @seasonId, @jobType, @occurrenceKey, @scheduledForMs, " +
      "'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, @nowMs, @nowMs, 1, NULL, " +
      "@scheduledForMs)"
  );
  const weeksRead = database.prepare(
    "SELECT * FROM matchup_weeks WHERE league_id = @leagueId AND season_id = @seasonId " +
      "ORDER BY sequence"
  );
  const matchupsRead = database.prepare(
    "SELECT * FROM matchups WHERE league_id = @leagueId AND season_id = @seasonId " +
      "ORDER BY matchup_week_id, id"
  );
  const byesRead = database.prepare(
    "SELECT * FROM matchup_byes WHERE league_id = @leagueId AND season_id = @seasonId " +
      "ORDER BY matchup_week_id, team_id"
  );

  function readContext({ leagueId, seasonId }) {
    try {
      const scope = { leagueId: stableId(leagueId), seasonId: stableId(seasonId) };
      const rows = contextStatement.all(scope);
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The matchup schedule context is ambiguous."
        );
      }
      if (rows.length === 0) return null;
      return Object.freeze({
        ...rows[0],
        teams: freezeRows(teamsStatement.all(scope)),
        existingWeekCount: existingScheduleStatement.get(scope).count,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readMatchupScheduleContext",
        tableName: "matchup_weeks",
      });
    }
  }

  const persistTransaction = database.transaction((command) => {
    const current = readContext(command);
    if (
      !current ||
      current.season_version !== command.expectedSeasonVersion ||
      (
        current.commissioner_user_id !== command.actorUserId &&
        command.authorizedAsPlatformAdministrator !== true
      ) ||
      current.existingWeekCount !== 0
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The matchup schedule context changed."
      );
    }
    for (const week of command.weeks) {
      insertWeek.run(week);
      for (const matchup of week.matchups) insertMatchup.run(matchup);
      if (week.bye) insertBye.run(week.bye);
      for (const occurrence of week.occurrences) {
        insertJobOccurrence.run(occurrence);
      }
    }
    insertOperation.run({
      id: command.operationId,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      actorUserId: command.actorUserId,
      metadataJson: JSON.stringify({
        participantCount: command.teamCount,
        weekCount: command.weeks.length,
        matchupCount: command.weeks.reduce((sum, week) => sum + week.matchups.length, 0),
        jobOccurrenceCount: command.weeks.reduce(
          (sum, week) => sum + week.occurrences.length,
          0
        ),
      }),
      nowMs: command.nowMs,
    });
    if (beforeCommit) beforeCommit();
    return {
      participantCount: command.teamCount,
      weekCount: command.weeks.length,
      matchupCount: command.weeks.reduce((sum, week) => sum + week.matchups.length, 0),
      byeCount: command.weeks.filter((week) => week.bye).length,
      operationId: command.operationId,
    };
  });

  return Object.freeze({
    readContext,
    persistSchedule(command) {
      try {
        return Object.freeze(persistTransaction.immediate(command));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "persistMatchupSchedule",
          tableName: "matchup_weeks",
        });
      }
    },
    readSchedule({ leagueId, seasonId }) {
      const scope = { leagueId: stableId(leagueId), seasonId: stableId(seasonId) };
      return Object.freeze({
        weeks: freezeRows(weeksRead.all(scope)),
        matchups: freezeRows(matchupsRead.all(scope)),
        byes: freezeRows(byesRead.all(scope)),
      });
    },
  });
}

module.exports = { createSqliteMatchupScheduleRepository };
