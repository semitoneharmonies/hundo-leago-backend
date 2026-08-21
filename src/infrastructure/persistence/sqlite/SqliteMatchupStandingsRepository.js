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

function compareStableIds(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createSqliteMatchupStandingsRepository({ database } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupStandingsRepository requires a database");
  }
  const seasonStatement = database.prepare(
    "SELECT seasons.id, seasons.status AS season_status, " +
      "seasons.version AS season_version, " +
      "league_settings.standings_rule_version " +
      "FROM seasons LEFT JOIN league_settings " +
      "ON league_settings.league_id = seasons.league_id " +
      "WHERE seasons.league_id = @leagueId " +
      "AND seasons.id = @seasonId LIMIT 2"
  );
  const weekStatement = database.prepare(
    "SELECT id, league_id, season_id, week_key, sequence, " +
      "starts_at_ms, ends_at_ms, status " +
      "FROM matchup_weeks WHERE league_id = @leagueId " +
      "AND season_id = @seasonId ORDER BY sequence, id"
  );
  const matchupStatement = database.prepare(
    "SELECT matchups.*, " +
      "matchup_weeks.id AS joined_week_id, " +
      "matchup_weeks.season_id AS week_season_id, " +
      "matchup_weeks.sequence AS week_sequence, " +
      "matchup_weeks.status AS week_status " +
      "FROM matchups LEFT JOIN matchup_weeks " +
      "ON matchup_weeks.league_id = matchups.league_id " +
      "AND matchup_weeks.id = matchups.matchup_week_id " +
      "WHERE matchups.league_id = @leagueId " +
      "AND matchups.season_id = @seasonId " +
      "ORDER BY matchups.id"
  );
  const byeStatement = database.prepare(
    "SELECT matchup_byes.*, " +
      "matchup_weeks.id AS joined_week_id, " +
      "matchup_weeks.season_id AS week_season_id, " +
      "matchup_weeks.sequence AS week_sequence " +
      "FROM matchup_byes LEFT JOIN matchup_weeks " +
      "ON matchup_weeks.league_id = matchup_byes.league_id " +
      "AND matchup_weeks.id = matchup_byes.matchup_week_id " +
      "WHERE matchup_byes.league_id = @leagueId " +
      "AND matchup_byes.season_id = @seasonId " +
      "ORDER BY matchup_byes.matchup_week_id, " +
      "matchup_byes.team_id"
  );
  const resultStatement = database.prepare(
    "SELECT matchup_results.id AS matchup_result_id, " +
      "matchup_results.league_id AS result_league_id, " +
      "matchup_results.season_id AS result_season_id, " +
      "matchup_results.matchup_id, " +
      "matchup_results.version AS result_version, " +
      "matchup_results.current_version_id AS selected_result_version_id, " +
      "matchup_results.status AS result_status, " +
      "matchup_results.finalized_at_ms, " +
      "matchup_result_versions.id AS result_version_id, " +
      "matchup_result_versions.league_id AS result_version_league_id, " +
      "matchup_result_versions.season_id AS result_version_season_id, " +
      "matchup_result_versions.matchup_result_id AS version_matchup_result_id, " +
      "matchup_result_versions.version_number, " +
      "matchup_result_versions.home_team_id, " +
      "matchup_result_versions.away_team_id, " +
      "matchup_result_versions.home_score_hundredths, " +
      "matchup_result_versions.away_score_hundredths, " +
      "matchup_result_versions.outcome, " +
      "matchup_result_versions.source_snapshot_id, " +
      "matchup_result_versions.source_type, " +
      "matchup_result_versions.actor_user_id, " +
      "matchup_result_versions.reason, " +
      "matchup_result_versions.supersedes_version_id, " +
      "stat_snapshots.id AS source_snapshot_record_id, " +
      "stat_snapshots.league_id AS source_snapshot_league_id, " +
      "stat_snapshots.season_id AS source_snapshot_season_id, " +
      "stat_snapshots.matchup_week_id AS source_snapshot_week_id, " +
      "stat_snapshots.intended_use AS source_snapshot_intended_use, " +
      "stat_snapshots.completeness_status AS source_snapshot_completeness, " +
      "stat_snapshots.freshness_status AS source_snapshot_freshness, " +
      "stat_snapshots.committed AS source_snapshot_committed, " +
      "(SELECT COUNT(*) FROM matchup_result_versions AS history " +
      "WHERE history.league_id = matchup_results.league_id " +
      "AND history.matchup_result_id = matchup_results.id) " +
      "AS result_version_count, " +
      "(SELECT MAX(history.version_number) " +
      "FROM matchup_result_versions AS history " +
      "WHERE history.league_id = matchup_results.league_id " +
      "AND history.matchup_result_id = matchup_results.id) " +
      "AS latest_result_version " +
      "FROM matchup_results LEFT JOIN matchup_result_versions " +
      "ON matchup_result_versions.league_id = matchup_results.league_id " +
      "AND matchup_result_versions.id = matchup_results.current_version_id " +
      "LEFT JOIN stat_snapshots " +
      "ON stat_snapshots.league_id = matchup_result_versions.league_id " +
      "AND stat_snapshots.id = matchup_result_versions.source_snapshot_id " +
      "WHERE matchup_results.league_id = @leagueId " +
      "AND matchup_results.season_id = @seasonId " +
      "ORDER BY matchup_results.matchup_id, matchup_results.id"
  );

  function incompatible(message) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      message
    );
  }

  function validateSourceId(value, message) {
    if (
      typeof value !== "string" ||
      !UUID_PATTERN.test(value)
    ) {
      incompatible(message);
    }
    return value;
  }

  function addParticipant(participantsById, id, name) {
    validateSourceId(
      id,
      "A schedule participant has an invalid identity."
    );
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name !== name.trim()
    ) {
      incompatible(
        "A schedule participant has invalid display context."
      );
    }
    const existing = participantsById.get(id);
    if (
      existing &&
      existing.team_display_name !== name
    ) {
      incompatible(
        "A schedule participant has inconsistent display context."
      );
    }
    participantsById.set(id, {
      team_id: id,
      team_display_name: name,
    });
  }

  function validateSchedule({
    scope,
    weeks,
    matchups,
    byes,
  }) {
    const weekIds = new Set();
    for (const [index, week] of weeks.entries()) {
      if (
        week.league_id !== scope.leagueId ||
        week.season_id !== scope.seasonId ||
        week.sequence !== index + 1 ||
        weekIds.has(week.id) ||
        (
          index > 0 &&
          week.starts_at_ms < weeks[index - 1].ends_at_ms
        )
      ) {
        incompatible(
          "The standings schedule is inconsistent."
        );
      }
      validateSourceId(
        week.id,
        "A standings week has an invalid identity."
      );
      weekIds.add(week.id);
    }

    const participantsById = new Map();
    const occupiedByWeek = new Map(
      weeks.map((week) => [week.id, new Set()])
    );
    const matchupIds = new Set();
    for (const matchup of matchups) {
      if (
        matchup.league_id !== scope.leagueId ||
        matchup.season_id !== scope.seasonId ||
        matchup.joined_week_id !==
          matchup.matchup_week_id ||
        matchup.week_season_id !== scope.seasonId ||
        !weekIds.has(matchup.matchup_week_id) ||
        matchupIds.has(matchup.id) ||
        matchup.home_team_id === matchup.away_team_id
      ) {
        incompatible(
          "The standings matchup schedule is inconsistent."
        );
      }
      validateSourceId(
        matchup.id,
        "A standings matchup has an invalid identity."
      );
      const occupied = occupiedByWeek.get(
        matchup.matchup_week_id
      );
      if (
        occupied.has(matchup.home_team_id) ||
        occupied.has(matchup.away_team_id)
      ) {
        incompatible(
          "A team has ambiguous standings schedule participation."
        );
      }
      occupied.add(matchup.home_team_id);
      occupied.add(matchup.away_team_id);
      matchupIds.add(matchup.id);
      addParticipant(
        participantsById,
        matchup.home_team_id,
        matchup.home_team_name
      );
      addParticipant(
        participantsById,
        matchup.away_team_id,
        matchup.away_team_name
      );
    }

    for (const bye of byes) {
      if (
        bye.league_id !== scope.leagueId ||
        bye.season_id !== scope.seasonId ||
        bye.joined_week_id !== bye.matchup_week_id ||
        bye.week_season_id !== scope.seasonId ||
        !weekIds.has(bye.matchup_week_id)
      ) {
        incompatible(
          "The standings bye schedule is inconsistent."
        );
      }
      const occupied = occupiedByWeek.get(
        bye.matchup_week_id
      );
      if (occupied.has(bye.team_id)) {
        incompatible(
          "A team has ambiguous standings schedule participation."
        );
      }
      occupied.add(bye.team_id);
      addParticipant(
        participantsById,
        bye.team_id,
        bye.team_display_name
      );
    }

    return {
      matchupIds,
      participants: [...participantsById.values()]
        .sort((left, right) =>
          compareStableIds(left.team_id, right.team_id)
        ),
    };
  }

  function validateOfficialResult({
    row,
    matchup,
    scope,
  }) {
    const expectedOutcome =
      row.home_score_hundredths ===
      row.away_score_hundredths
        ? "tie"
        : row.home_score_hundredths >
            row.away_score_hundredths
          ? "home_win"
          : "away_win";
    const calculatedSourceValid =
      row.result_status === "official" &&
      row.source_type === "calculated" &&
      row.version_number === 1 &&
      row.result_version_count === 1 &&
      row.actor_user_id === null &&
      row.reason === null &&
      row.supersedes_version_id === null;
    const correctionSourceValid =
      row.result_status === "corrected" &&
      row.source_type === "correction" &&
      row.version_number > 1 &&
      typeof row.actor_user_id === "string" &&
      UUID_PATTERN.test(row.actor_user_id) &&
      typeof row.reason === "string" &&
      row.reason.length >= 1 &&
      row.reason === row.reason.trim() &&
      typeof row.supersedes_version_id === "string" &&
      UUID_PATTERN.test(row.supersedes_version_id);

    if (
      row.result_league_id !== scope.leagueId ||
      row.result_season_id !== scope.seasonId ||
      row.selected_result_version_id === null ||
      row.selected_result_version_id !==
        row.result_version_id ||
      row.result_version_league_id !== scope.leagueId ||
      row.result_version_season_id !== scope.seasonId ||
      row.version_matchup_result_id !==
        row.matchup_result_id ||
      !Number.isSafeInteger(row.version_number) ||
      row.version_number < 1 ||
      row.version_number !== row.latest_result_version ||
      row.result_version_count !==
        row.latest_result_version ||
      !Number.isSafeInteger(row.finalized_at_ms) ||
      row.finalized_at_ms < 0 ||
      row.home_team_id !== matchup.home_team_id ||
      row.away_team_id !== matchup.away_team_id ||
      !Number.isSafeInteger(
        row.home_score_hundredths
      ) ||
      row.home_score_hundredths < 0 ||
      !Number.isSafeInteger(
        row.away_score_hundredths
      ) ||
      row.away_score_hundredths < 0 ||
      row.outcome !== expectedOutcome ||
      matchup.status !== "final" ||
      row.source_snapshot_id !==
        row.source_snapshot_record_id ||
      row.source_snapshot_league_id !== scope.leagueId ||
      row.source_snapshot_season_id !== scope.seasonId ||
      row.source_snapshot_week_id !==
        matchup.matchup_week_id ||
      row.source_snapshot_intended_use !==
        "matchup_final" ||
      row.source_snapshot_completeness !== "complete" ||
      row.source_snapshot_freshness !== "fresh" ||
      row.source_snapshot_committed !== 1 ||
      (
        !calculatedSourceValid &&
        !correctionSourceValid
      )
    ) {
      incompatible(
        "The current official standings result source is inconsistent."
      );
    }
  }

  function selectOfficialResults({
    rows,
    matchups,
    scope,
  }) {
    const matchupsById = new Map(
      matchups.map((matchup) => [
        matchup.id,
        matchup,
      ])
    );
    const resultMatchupIds = new Set();
    const resultIds = new Set();
    const officialResults = [];
    for (const row of rows) {
      if (
        resultMatchupIds.has(row.matchup_id) ||
        resultIds.has(row.matchup_result_id) ||
        !matchupsById.has(row.matchup_id)
      ) {
        incompatible(
          "The standings result source is ambiguous."
        );
      }
      resultMatchupIds.add(row.matchup_id);
      resultIds.add(row.matchup_result_id);
      if (
        row.result_status === "pending" ||
        row.result_status === "void"
      ) {
        if (
          row.result_status === "pending" &&
          (
            row.selected_result_version_id !== null ||
            row.result_version_count !== 0
          )
        ) {
          incompatible(
            "The pending standings result source is inconsistent."
          );
        }
        continue;
      }
      if (
        !["official", "corrected"].includes(
          row.result_status
        )
      ) {
        incompatible(
          "The standings result status is invalid."
        );
      }
      validateOfficialResult({
        row,
        matchup: matchupsById.get(row.matchup_id),
        scope,
      });
      officialResults.push(row);
    }
    officialResults.sort((left, right) =>
      compareStableIds(
        left.matchup_id,
        right.matchup_id
      )
    );
    return {
      officialResults,
      officialMatchupIds: new Set(
        officialResults.map((row) => row.matchup_id)
      ),
    };
  }

  function readContext(input) {
    try {
      const scope = { leagueId: stableId(input.leagueId), seasonId: stableId(input.seasonId) };
      const seasons = seasonStatement.all(scope);
      if (seasons.length > 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The standings season is ambiguous.");
      }
      if (seasons.length === 0) return null;
      const season = seasons[0];
      if (
        season.standings_rule_version !== null &&
        (
          !Number.isSafeInteger(
            season.standings_rule_version
          ) ||
          season.standings_rule_version < 1
        )
      ) {
        incompatible(
          "The standings rule version is invalid."
        );
      }
      const weeks = weekStatement.all(scope);
      const matchups = matchupStatement.all(scope);
      const byes = byeStatement.all(scope);
      const schedule = validateSchedule({
        scope,
        weeks,
        matchups,
        byes,
      });
      const resultSelection = selectOfficialResults({
        rows: resultStatement.all(scope),
        matchups,
        scope,
      });
      const missingMatchupIds = matchups
        .map((matchup) => matchup.id)
        .filter(
          (matchupId) =>
            !resultSelection.officialMatchupIds.has(
              matchupId
            )
        )
        .sort(compareStableIds);
      const resultSetComplete =
        weeks.length > 0 &&
        matchups.length > 0 &&
        schedule.participants.length >= 2 &&
        season.standings_rule_version !== null &&
        weeks.every((week) => week.status === "final") &&
        matchups.every(
          (matchup) => matchup.status === "final"
        ) &&
        missingMatchupIds.length === 0 &&
        resultSelection.officialResults.length ===
          matchups.length;
      return Object.freeze({
        season: Object.freeze({ ...season }),
        weeks: freezeRows(weeks),
        matchups: freezeRows(matchups),
        expectedWeekCount: weeks.length,
        expectedMatchupCount: matchups.length,
        missingMatchupIds: Object.freeze(
          missingMatchupIds
        ),
        resultSetComplete,
        participants: freezeRows(
          schedule.participants
        ),
        results: freezeRows(
          resultSelection.officialResults
        ),
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readAuthoritativeStandingsContext", tableName: "matchup_results" });
    }
  }

  return Object.freeze({ readContext });
}

module.exports = { createSqliteMatchupStandingsRepository };
