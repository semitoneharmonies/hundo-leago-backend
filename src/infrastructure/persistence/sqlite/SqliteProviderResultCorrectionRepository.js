const { deriveMatchupOutcome } = require("../../../domain/matchups/matchupResultPolicy");
const { PROVIDER_CORRECTION_REASON } = require("../../../domain/matchups/resultCorrectionSourcePolicy");
const { repositoryError, REPOSITORY_ERROR_CODES } = require("./SqliteRepositoryError");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function conflict() { throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The provider correction context changed."); }

function createSqliteProviderResultCorrectionRepository({ database, leagueIds = null, beforeCommit } = {}) {
  if (leagueIds !== null && (!Array.isArray(leagueIds) || leagueIds.some(id => !UUID.test(id)))) throw new TypeError("Correction scope requires exact league IDs.");
  const candidates = database.prepare(`
    SELECT result.id AS result_id, result.version AS result_version, result.league_id, result.season_id,
      result.matchup_id, matchup.matchup_week_id, version.id AS result_version_id, version.version_number,
      snapshot.source_refresh_id, matchup.home_team_id, matchup.away_team_id, week.ends_at_ms
    FROM matchup_results AS result
    JOIN matchup_result_versions AS version ON version.id = result.current_version_id AND version.matchup_result_id = result.id
    JOIN stat_snapshots AS snapshot ON snapshot.id = version.source_snapshot_id AND snapshot.league_id = result.league_id
    JOIN matchups AS matchup ON matchup.id = result.matchup_id AND matchup.league_id = result.league_id
    JOIN matchup_weeks AS week ON week.id = matchup.matchup_week_id AND week.league_id = matchup.league_id
    JOIN seasons AS season ON season.id = result.season_id AND season.league_id = result.league_id
    JOIN leagues AS league ON league.id = result.league_id AND league.current_season_id = season.id
    WHERE season.nhl_season_key = '20262027' AND league.status = 'active'
      AND result.status IN ('official', 'corrected') AND matchup.status = 'final'
      AND week.ends_at_ms <= season.fantasy_playoffs_start_at_ms
    ORDER BY result.league_id, result.season_id, week.sequence, matchup.id`);
  const finalizedStandings = database.prepare("SELECT 1 FROM standings_snapshot_finalizations WHERE league_id = ? AND season_id = ? LIMIT 1");
  const latest = database.prepare(`SELECT refresh.* FROM stat_refreshes AS refresh
    JOIN stat_sources AS source ON source.id = refresh.stat_source_id AND source.provider = 'nhl-completed-games' AND source.status = 'active'
    JOIN expanded_stat_refreshes AS expanded ON expanded.refresh_id = refresh.id
    WHERE refresh.nhl_season_key = '20262027' AND refresh.status = 'succeeded'
    ORDER BY refresh.completed_at_ms DESC, refresh.id DESC LIMIT 1`);
  const allowed = row => leagueIds === null || leagueIds.includes(row.league_id);
  const commit = database.transaction(command => {
    for (const key of ["leagueId", "seasonId", "weekId", "matchupId", "resultId", "supersedesVersionId", "refreshId", "resultVersionId", "snapshotId", "operationId"]) {
      if (!UUID.test(command[key] || "")) conflict();
    }
    if (!Number.isSafeInteger(command.nowMs) || command.nowMs < 0) conflict();
    const row = candidates.all().find(row => row.result_id === command.resultId && allowed(row));
    if (!row || row.league_id !== command.leagueId || row.season_id !== command.seasonId || row.matchup_id !== command.matchupId ||
        row.matchup_week_id !== command.weekId || row.result_version !== command.expectedResultVersion ||
        row.result_version_id !== command.supersedesVersionId || row.version_number + 1 !== command.versionNumber) conflict();
    if (finalizedStandings.get(row.league_id, row.season_id)) return { status: "requires_playoff_review" };
    const refresh = latest.get();
    if (!refresh || refresh.id !== command.refreshId || refresh.completed_at_ms < row.ends_at_ms || refresh.completed_at_ms > command.nowMs || command.nowMs - refresh.completed_at_ms > 6 * 60 * 60_000) conflict();
    const outcome = deriveMatchupOutcome(command.homeScoreHundredths, command.awayScoreHundredths);
    database.prepare(`INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id,
      intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'matchup_final', 'complete', 'fresh', ?, 1, ?)`)
      .run(command.snapshotId, refresh.stat_source_id, refresh.id, row.league_id, row.season_id, row.matchup_week_id, refresh.completed_at_ms, command.nowMs);
    database.prepare(`INSERT INTO matchup_result_versions (id, league_id, season_id, matchup_result_id, version_number,
      home_team_id, away_team_id, home_score_hundredths, away_score_hundredths, outcome, source_snapshot_id,
      source_type, actor_user_id, reason, supersedes_version_id, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider_correction', NULL, ?, ?, ?)`)
      .run(command.resultVersionId, row.league_id, row.season_id, row.result_id, command.versionNumber, row.home_team_id, row.away_team_id,
        command.homeScoreHundredths, command.awayScoreHundredths, outcome, command.snapshotId, PROVIDER_CORRECTION_REASON, row.result_version_id, command.nowMs);
    database.prepare(`INSERT INTO matchup_operations (id, league_id, season_id, matchup_week_id, matchup_id, actor_user_id,
      operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms)
      VALUES (?, ?, ?, ?, ?, NULL, 'result_correct', 'succeeded', ?, ?, ?, ?)`)
      .run(command.operationId, row.league_id, row.season_id, row.matchup_week_id, row.matchup_id, PROVIDER_CORRECTION_REASON,
        JSON.stringify({ resultId: row.result_id, resultVersionId: command.resultVersionId }), command.nowMs, command.nowMs);
    const update = database.prepare(`UPDATE matchup_results SET current_version_id = ?, status = 'corrected', updated_at_ms = ?, version = version + 1
      WHERE id = ? AND league_id = ? AND current_version_id = ? AND version = ?`)
      .run(command.resultVersionId, command.nowMs, row.result_id, row.league_id, row.result_version_id, row.result_version);
    if (update.changes !== 1) conflict();
    beforeCommit?.();
    return { status: "corrected", resultVersionId: command.resultVersionId };
  });
  return Object.freeze({ listCandidates: () => candidates.all().filter(allowed), commit: command => commit.immediate(command) });
}

module.exports = { createSqliteProviderResultCorrectionRepository };
