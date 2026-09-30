-- Rebuildable provider cache only. No existing league or scoring rows change.
CREATE TABLE nhl_completed_game_cache (
  id TEXT PRIMARY KEY,
  nhl_season_key TEXT NOT NULL CHECK (length(nhl_season_key) = 8),
  nhl_game_id TEXT NOT NULL,
  expanded INTEGER NOT NULL CHECK (expanded IN (0, 1)),
  checked_at_ms INTEGER NOT NULL CHECK (checked_at_ms >= 0),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  UNIQUE (nhl_season_key, nhl_game_id, expanded)
) STRICT;

UPDATE application_metadata SET metadata_value='67', updated_at_ms=max(updated_at_ms,67)
WHERE metadata_key='data_model_version' AND metadata_value='66';
