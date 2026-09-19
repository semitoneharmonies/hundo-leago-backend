const { EXPANDED_SCORING_VERSION, calculateExpandedScore, normalizeScoringStats } = require("../../../domain/statistics/expandedScoringPolicy");
const { normalizeExpandedSnapshot, expandedSnapshotHash } = require("../../../domain/statistics/expandedStatisticsSnapshotPolicy");

function persistExpandedStatistics(database, command) {
  if (!command.expandedScoring) return;
  const expanded = normalizeExpandedSnapshot(command.expandedScoring, { nhlSeasonKey: command.nhlSeasonKey, totals: command.rows, observations: command.playerGameRows });
  database.prepare("INSERT INTO expanded_stat_refreshes (refresh_id, scoring_rule_version, evidence_sha256, total_count, observation_count) VALUES (?, ?, ?, ?, ?)")
    .run(command.refreshId, EXPANDED_SCORING_VERSION, expandedSnapshotHash(expanded), expanded.totalsRows.length, expanded.playerGameRows.length);
  for (const [rows, child, parent, idColumn, game] of [
    [expanded.totalsRows, "expanded_stat_totals", "player_stat_totals", "total_id", false],
    [expanded.playerGameRows, "expanded_player_game_stats", "player_game_stat_observations", "observation_id", true],
  ]) {
    const source = database.prepare(`SELECT parent.id FROM ${parent} AS parent JOIN player_external_ids AS identity ON identity.player_id = parent.player_id WHERE parent.refresh_id = @refreshId AND identity.provider = @provider AND identity.external_value = @playerId ${game ? "AND parent.nhl_game_id = @nhlGameId" : ""} LIMIT 2`);
    const insert = database.prepare(`INSERT INTO ${child} (${idColumn}, refresh_id, provider_player_id, stats_json, forward_fp_hundredths, defence_fp_hundredths${game ? ", games_played" : ""}) VALUES (?, ?, ?, ?, ?, ?${game ? ", ?" : ""})`);
    for (const row of rows) {
      const sources = source.all({ refreshId: command.refreshId, provider: command.playerIdentityProvider, playerId: row.playerId, ...(game ? { nhlGameId: row.nhlGameId } : {}) });
      if (sources.length !== 1) throw new TypeError("Expanded statistics have no unique source row.");
      insert.run(sources[0].id, command.refreshId, row.playerId, JSON.stringify(row.scoringStats), calculateExpandedScore(row.scoringStats, "F").fantasyPointsHundredths, calculateExpandedScore(row.scoringStats, "D").fantasyPointsHundredths, ...(game ? [row.gamesPlayed] : []));
    }
  }
}

function readExpandedStatistics(database, refreshId) {
  const root = database.prepare("SELECT * FROM expanded_stat_refreshes WHERE refresh_id = ?").get(refreshId);
  if (!root) return null;
  const totals = database.prepare("SELECT extra.*, parent.player_id, parent.games_played, parent.goals, parent.assists FROM expanded_stat_totals AS extra JOIN player_stat_totals AS parent ON parent.id = extra.total_id AND parent.refresh_id = extra.refresh_id WHERE extra.refresh_id = ?").all(refreshId);
  const games = database.prepare("SELECT extra.*, parent.player_id, parent.nhl_game_id, parent.goals, parent.assists, parent.observed_game_state FROM expanded_player_game_stats AS extra JOIN player_game_stat_observations AS parent ON parent.id = extra.observation_id AND parent.refresh_id = extra.refresh_id WHERE extra.refresh_id = ?").all(refreshId);
  const normalized = normalizeExpandedSnapshot({ scoringRuleVersion: root.scoring_rule_version,
    totalsRows: totals.map((row) => ({ playerId: row.provider_player_id, scoringStats: JSON.parse(row.stats_json) })),
    playerGameRows: games.map((row) => ({ playerId: row.provider_player_id, nhlGameId: row.nhl_game_id, gamesPlayed: row.games_played, scoringStats: JSON.parse(row.stats_json) })),
  }, { nhlSeasonKey: "20262027",
    totals: totals.map((row) => ({ externalPlayerId: row.provider_player_id, gamesPlayed: row.games_played, goals: row.goals, assists: row.assists })),
    observations: games.map((row) => ({ externalPlayerId: row.provider_player_id, nhlGameId: row.nhl_game_id, goals: row.goals, assists: row.assists, observedGameState: row.observed_game_state })),
  });
  if (root.total_count !== totals.length || root.observation_count !== games.length || expandedSnapshotHash(normalized) !== root.evidence_sha256) throw new TypeError("Expanded scoring evidence does not match its sealed refresh.");
  return Object.freeze({ scoringRuleVersion: root.scoring_rule_version, evidenceSha256: root.evidence_sha256,
    totals: Object.freeze(totals.map((row) => Object.freeze({ playerId: row.player_id, scoringStats: normalizeScoringStats(JSON.parse(row.stats_json)) }))),
    playerGames: Object.freeze(games.map((row) => Object.freeze({ playerId: row.player_id, nhlGameId: row.nhl_game_id, gamesPlayed: row.games_played, scoringStats: normalizeScoringStats(JSON.parse(row.stats_json)) }))),
  });
}

module.exports = { persistExpandedStatistics, readExpandedStatistics };
