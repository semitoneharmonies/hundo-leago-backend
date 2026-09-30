const { pruneCompactTotalProjections } = require("./compactStatisticsEvidence");
const RETENTION_MS = 3 * 86_400_000;
const PAYLOAD_TABLES = Object.freeze([
  "expanded_player_game_stats", "expanded_stat_totals", "expanded_stat_refreshes",
  "stat_refresh_player_game_coverage_entries", "player_game_stat_observations",
  "stat_refresh_player_game_sets", "player_stat_totals",
]);

function createSqliteStatisticsRetentionRepository({ database }) {
  const compactExclusion = database.pragma("user_version", { simple: true }) >= 70
    ? "AND NOT EXISTS (SELECT 1 FROM compact_stat_refreshes c WHERE c.refresh_id=r.id)" : "";
  const candidates = database.prepare(`SELECT r.id FROM stat_refreshes r
    JOIN stat_sources s ON s.id = r.stat_source_id
    WHERE s.provider = 'nhl-completed-games' AND r.status = 'succeeded' AND r.completed_at_ms < ?
      ${compactExclusion}
      AND NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements a WHERE a.refresh_id = r.id)
      AND EXISTS (SELECT 1 FROM stat_refreshes n WHERE n.stat_source_id = r.stat_source_id
        AND n.nhl_season_key = r.nhl_season_key AND n.status = 'succeeded' AND n.completed_at_ms > r.completed_at_ms
        AND NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements a WHERE a.refresh_id = n.id))
      AND NOT EXISTS (SELECT 1 FROM stat_snapshots p WHERE p.source_refresh_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM matchup_roster_game_exclusions x JOIN player_game_stat_observations o
        ON o.id = x.baseline_player_game_stat_observation_id WHERE o.refresh_id = r.id)
    ORDER BY r.completed_at_ms, r.id LIMIT 2`);
  const counts = PAYLOAD_TABLES.map(table => [table, database.prepare(`SELECT COUNT(*) n FROM ${table} WHERE refresh_id = ?`)]);
  const insert = database.prepare("INSERT INTO stat_refresh_payload_retirements (refresh_id, retired_at_ms, counts_json) VALUES (?, ?, ?)");
  const retire = database.transaction(nowMs => {
    if (!Number.isSafeInteger(nowMs) || nowMs < RETENTION_MS) throw new TypeError("A valid retention clock is required.");
    const rows = candidates.all(nowMs - RETENTION_MS);
    for (const row of rows) {
      const payloadCounts = Object.fromEntries(counts.map(([table, statement]) => [table, statement.get(row.id).n]));
      insert.run(row.id, nowMs, JSON.stringify(payloadCounts));
    }
    return { retiredRefreshCount: rows.length };
  });
  return Object.freeze({ retire: nowMs => retire.immediate(nowMs), pruneCompactTotals: () => pruneCompactTotalProjections(database) });
}
module.exports = { createSqliteStatisticsRetentionRepository, RETENTION_MS };
