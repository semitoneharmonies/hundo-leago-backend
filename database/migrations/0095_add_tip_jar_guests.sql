-- Anonymous game scores are independent of accounts and fantasy leagues.
CREATE TABLE tip_jar_guest_runs (
  id TEXT PRIMARY KEY NOT NULL,
  guest_hash TEXT NOT NULL CHECK (length(guest_hash) = 64 AND guest_hash NOT GLOB '*[^0-9a-f]*'),
  client_run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'campaign-v1'),
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  shots_json TEXT NOT NULL CHECK (json_valid(shots_json) AND json_type(shots_json) = 'array' AND json_array_length(shots_json) <= 60),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (guest_hash, client_run_id),
  UNIQUE (guest_hash, id)
) STRICT;
CREATE INDEX tip_jar_guest_runs_owner ON tip_jar_guest_runs (guest_hash, created_at_ms DESC);

CREATE TABLE tip_jar_guest_bests (
  id TEXT PRIMARY KEY NOT NULL,
  guest_hash TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'campaign-v1'),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 30),
  highest_level_completed INTEGER NOT NULL CHECK (highest_level_completed BETWEEN 0 AND 3),
  shots_to_completion INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK ((highest_level_completed = 0 AND shots_to_completion IS NULL) OR
    (highest_level_completed > 0 AND shots_to_completion BETWEEN 3 AND 60)),
  FOREIGN KEY (guest_hash, run_id) REFERENCES tip_jar_guest_runs (guest_hash, id)
) STRICT;
CREATE INDEX tip_jar_guest_bests_rank ON tip_jar_guest_bests (ruleset_version, highest_level_completed DESC, shots_to_completion ASC);

UPDATE application_metadata SET metadata_value = '95', updated_at_ms = max(updated_at_ms, 95)
WHERE metadata_key = 'data_model_version' AND metadata_value = '94';
