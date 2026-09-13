const { assertNhlSeasonKey } = require("../../domain/statistics/statisticsPolicy");
const { createSqliteStatisticsRepository } = require("../../infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const { normalizeMatchupExecutionLeagueIds } = require("../../domain/matchups/matchupExecutionScope");

function inspectNhlStatisticsReadiness({ database, nhlSeasonKey, minimumPlayerCount = 200, matchupLeagueIds = null } = {}) {
  const season = assertNhlSeasonKey(nhlSeasonKey);
  const selectedLeagues = normalizeMatchupExecutionLeagueIds(matchupLeagueIds);
  if (!Number.isSafeInteger(minimumPlayerCount) || minimumPlayerCount < 1) throw new TypeError("A positive NHL catalog threshold is required.");
  const repository = createSqliteStatisticsRepository({ database });
  const catalog = repository.readNhlCatalogPlayers();
  const missingRosterIdentities = database.prepare(`
    SELECT DISTINCT player.id AS playerId, player.full_name AS fullName
    FROM player_ownerships AS ownership
    JOIN seasons AS season ON season.id = ownership.season_id AND season.league_id = ownership.league_id
    JOIN players AS player ON player.id = ownership.player_id
    LEFT JOIN player_external_ids AS identity ON identity.player_id = player.id AND identity.provider = 'nhl'
    WHERE season.nhl_season_key = ? AND ownership.ownership_kind = 'Rostered' AND identity.id IS NULL
    ORDER BY player.id
  `).all(season);
  const allConflictingLocks = database.prepare(`
    SELECT lock.id AS lockId, lock.league_id AS leagueId, source.provider
    FROM matchup_roster_locks AS lock
    JOIN seasons AS season ON season.id = lock.season_id AND season.league_id = lock.league_id
    JOIN matchup_weeks AS week ON week.id = lock.matchup_week_id AND week.league_id = lock.league_id
    JOIN stat_snapshots AS snapshot ON snapshot.id = lock.baseline_snapshot_id AND snapshot.league_id = lock.league_id
    JOIN stat_sources AS source ON source.id = snapshot.stat_source_id
    WHERE season.nhl_season_key = ? AND week.status <> 'final' AND source.provider <> 'nhl-completed-games'
    ORDER BY lock.id
  `).all(season);
  const inScope = (row) => selectedLeagues === null || selectedLeagues.includes(row.leagueId);
  const conflictingLocks = allConflictingLocks.filter(inScope);
  const conflictingWeeks = database.prepare(`
    SELECT DISTINCT week.id AS weekId, week.league_id AS leagueId, source.provider
    FROM stat_snapshots AS snapshot
    JOIN stat_sources AS source ON source.id = snapshot.stat_source_id
    JOIN matchup_weeks AS week ON week.id = snapshot.matchup_week_id AND week.league_id = snapshot.league_id AND week.season_id = snapshot.season_id
    JOIN seasons AS season ON season.id = week.season_id AND season.league_id = week.league_id
    WHERE season.nhl_season_key = ? AND week.status <> 'final' AND snapshot.committed = 1
      AND snapshot.intended_use IN ('matchup_baseline', 'matchup_final') AND source.provider <> 'nhl-completed-games'
    ORDER BY week.id, source.provider
  `).all(season).filter(inScope);
  const unknownScopeLeagues = selectedLeagues === null ? [] : selectedLeagues.filter((leagueId) => !database.prepare("SELECT 1 FROM seasons WHERE league_id = ? AND nhl_season_key = ?").get(leagueId, season));
  let coverageRequirements = null, coverageReady = false;
  try {
    const requirements = repository.readPlayerGameCoverageRequirements({ nhlSeasonKey: season, playerIdentityProvider: "nhl" });
    coverageRequirements = { playerCount: requirements.requiredPlayers.length, playerGameCount: requirements.requiredPlayerGames.length };
    coverageReady = true;
  } catch {
    // Missing or conflicting identity/evidence remains an explicit release blocker.
  }
  const issues = [];
  if (catalog.length < minimumPlayerCount) issues.push("The NHL identity catalog is below the required player count.");
  if (missingRosterIdentities.length) issues.push("Some current-season rostered players have no NHL identity. Verify and add their NHL IDs to the existing player records before enabling statistics.");
  if (!coverageReady) issues.push("Required player-game identities or historical bindings could not be verified.");
  if (conflictingLocks.length || conflictingWeeks.length) issues.push("An unfinished matchup in the selected scope uses another provider. Do not switch its source or replace its baseline.");
  if (unknownScopeLeagues.length) issues.push("Some selected leagues have no season matching this NHL season. Verify the execution scope before enabling jobs.");
  const latest = repository.readLatestSeason({ provider: "nhl-completed-games", nhlSeasonKey: season });
  return Object.freeze({
    readOnly: true, nhlSeasonKey: season, readyForStatistics: issues.length === 0,
    mappedPlayerCount: catalog.length, minimumPlayerCount, missingRosterIdentities, conflictingLocks, coverageRequirements,
    matchupLeagueIds: selectedLeagues, conflictingWeeks, unknownScopeLeagues,
    excludedConflictingLockCount: allConflictingLocks.length - conflictingLocks.length,
    latestSuccessfulRefresh: latest ? { jobId: latest.refresh.id, completedAtMs: latest.refresh.completed_at_ms, playerCount: latest.refresh.player_count } : null,
    issues,
    nextStep: issues.length ? "Resolve the listed identity and source issues on a verified copy; preserve existing player IDs and league data." : "Verify a current-season refresh on staging before enabling automatic matchup processing.",
  });
}

module.exports = { inspectNhlStatisticsReadiness };
