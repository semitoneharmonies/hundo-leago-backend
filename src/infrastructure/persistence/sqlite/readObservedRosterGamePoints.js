const { calculateExpandedScore } = require("../../../domain/statistics/expandedScoringPolicy");
const { prepareGameRecord } = require("../../../domain/statistics/sharedGameEvidencePolicy");

// Read only the requested games from the last successful NHL capture. A compact
// capture stores the latest revision per player/game, including removal markers.
function readObservedRosterGamePoints(database, { leagueId, seasonId, season, games, rule, expandedRequired, schema }) {
  const refresh = database.prepare(`SELECT r.id, r.stat_source_id FROM stat_refreshes r
    JOIN stat_sources s ON s.id=r.stat_source_id AND s.provider='nhl-completed-games'
    WHERE r.nhl_season_key=? AND r.status='succeeded'
    ORDER BY r.completed_at_ms DESC, r.started_at_ms DESC, r.id DESC LIMIT 1`).get(season);
  if (!refresh) return [];
  const capture = schema >= 69 && database.prepare(
    "SELECT revision FROM shared_game_evidence_captures WHERE refresh_id=? AND sealed=1"
  ).get(refresh.id);
  const gameIds = JSON.stringify([...games.keys()]);
  if (capture) {
    const rows = database.prepare(`SELECT o.player_id, o.position_group, c.nhl_game_id, c.payload_json, c.payload_sha256
      FROM player_ownerships o CROSS JOIN json_each(@gameIds) g
      JOIN shared_game_evidence_changes c ON c.rowid=(
        SELECT latest.rowid FROM shared_game_evidence_changes latest
        WHERE latest.stat_source_id=@source AND latest.nhl_season_key=@season AND latest.player_id=o.player_id
          AND latest.nhl_game_id=g.value AND latest.revision<=@revision ORDER BY latest.revision DESC LIMIT 1)
      WHERE o.league_id=@leagueId AND o.season_id=@seasonId AND c.payload_json IS NOT NULL`)
      .all({ leagueId, seasonId, gameIds, source: refresh.stat_source_id, season, revision: capture.revision });
    return rows.flatMap(row => {
      const { record, sha256 } = prepareGameRecord(JSON.parse(row.payload_json));
      if (row.payload_sha256 !== sha256 || row.player_id !== record.playerId || row.nhl_game_id !== record.nhlGameId ||
          record.gameState !== "final" ||
          record.scheduledStartsAtMs !== games.get(row.nhl_game_id).startsAtMs || (expandedRequired && !record.scoringStats)) return [];
      const fantasyPointsHundredths = record.scoringStats
        ? calculateExpandedScore(record.scoringStats, row.position_group, rule).fantasyPointsHundredths
        : record.goals * 125 + record.assists * 100;
      return [{ gameId: row.nhl_game_id, playerId: row.player_id, fantasyPointsHundredths }];
    });
  }

  const rows = database.prepare(`SELECT obs.player_id, o.position_group, obs.nhl_game_id,
    obs.nhl_game_scheduled_starts_at_ms, obs.fantasy_points_hundredths,
    ${schema >= 57 ? "e.stats_json" : "NULL AS stats_json"}
    FROM player_ownerships o CROSS JOIN json_each(@gameIds) g CROSS JOIN player_game_stat_observations obs
    ${schema >= 57 ? "LEFT JOIN expanded_player_game_stats e ON e.observation_id=obs.id AND e.refresh_id=obs.refresh_id" : ""}
    WHERE o.league_id=@leagueId AND o.season_id=@seasonId AND obs.stat_source_id=@source AND obs.refresh_id=@refresh
      AND obs.player_id=o.player_id AND obs.nhl_game_id=g.value AND obs.observed_game_state='final'`)
    .all({ leagueId, seasonId, gameIds, source: refresh.stat_source_id, refresh: refresh.id });
  return rows.flatMap(row => {
    if (row.nhl_game_scheduled_starts_at_ms !== games.get(row.nhl_game_id).startsAtMs ||
        (expandedRequired && !row.stats_json)) return [];
    const fantasyPointsHundredths = row.stats_json
      ? calculateExpandedScore(JSON.parse(row.stats_json), row.position_group, rule).fantasyPointsHundredths
      : row.fantasy_points_hundredths;
    return [{ gameId: row.nhl_game_id, playerId: row.player_id, fantasyPointsHundredths }];
  });
}

module.exports = { readObservedRosterGamePoints };
