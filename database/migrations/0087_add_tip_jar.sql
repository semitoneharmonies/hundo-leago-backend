-- Tip Jar is an independent side game. No fantasy records are rewritten.
CREATE TABLE tip_jar_runs (
  id TEXT PRIMARY KEY NOT NULL,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  client_run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'campaign-v1'),
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  shots_json TEXT NOT NULL CHECK (json_valid(shots_json) AND json_type(shots_json) = 'array' AND json_array_length(shots_json) <= 60),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (league_id, user_id, client_run_id),
  UNIQUE (league_id, user_id, id)
) STRICT;
CREATE INDEX tip_jar_runs_owner ON tip_jar_runs (league_id, user_id, created_at_ms DESC);

CREATE TABLE tip_jar_bests (
  id TEXT PRIMARY KEY NOT NULL,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'campaign-v1'),
  highest_level_completed INTEGER NOT NULL CHECK (highest_level_completed BETWEEN 0 AND 3),
  shots_to_completion INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK ((highest_level_completed = 0 AND shots_to_completion IS NULL) OR
    (highest_level_completed > 0 AND shots_to_completion BETWEEN 3 AND 60)),
  UNIQUE (league_id, user_id, ruleset_version),
  FOREIGN KEY (league_id, user_id, run_id) REFERENCES tip_jar_runs (league_id, user_id, id)
) STRICT;
CREATE INDEX tip_jar_bests_rank ON tip_jar_bests (league_id, ruleset_version, highest_level_completed DESC, shots_to_completion ASC);

UPDATE application_metadata SET metadata_value = '87', updated_at_ms = max(updated_at_ms, 87)
WHERE metadata_key = 'data_model_version' AND metadata_value = '86';
