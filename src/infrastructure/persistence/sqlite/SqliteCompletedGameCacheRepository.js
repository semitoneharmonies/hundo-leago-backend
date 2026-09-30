const { randomUUID } = require("node:crypto");

function createSqliteCompletedGameCacheRepository({ database }) {
  const read = database.prepare("SELECT nhl_game_id, entry_json FROM nhl_completed_game_cache WHERE nhl_season_key = ? AND expanded = ?");
  const write = database.prepare(`INSERT INTO nhl_completed_game_cache
    (id, nhl_season_key, nhl_game_id, expanded, checked_at_ms, entry_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(nhl_season_key, nhl_game_id, expanded) DO UPDATE SET
    checked_at_ms = excluded.checked_at_ms, entry_json = excluded.entry_json
    WHERE excluded.checked_at_ms >= nhl_completed_game_cache.checked_at_ms`);
  const save = database.transaction(entries => {
    for (const entry of entries) write.run(randomUUID(), entry.season, entry.gameId, Number(entry.expanded), entry.checkedAtMs, JSON.stringify(entry));
  });
  return Object.freeze({
    read({ season, expanded }) {
      return new Map(read.all(season, Number(expanded)).map(row => [row.nhl_game_id, JSON.parse(row.entry_json)]));
    },
    save(entries) { save.immediate(entries); },
  });
}
module.exports = { createSqliteCompletedGameCacheRepository };
