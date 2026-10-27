-- Mr. Boni is an independent side game. No fantasy records are rewritten.
CREATE TABLE mr_boni_runs (
  id TEXT PRIMARY KEY NOT NULL,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  client_run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'resurface-v1'),
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  commands_json TEXT NOT NULL CHECK (json_valid(commands_json) AND json_type(commands_json) = 'array' AND json_array_length(commands_json) <= 24000),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (league_id, user_id, client_run_id),
  UNIQUE (league_id, user_id, id)
) STRICT;
CREATE INDEX mr_boni_runs_owner ON mr_boni_runs (league_id, user_id, created_at_ms DESC);

CREATE TABLE mr_boni_bests (
  id TEXT PRIMARY KEY NOT NULL,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'resurface-v1'),
  highest_level_completed INTEGER NOT NULL CHECK (highest_level_completed BETWEEN 0 AND 3),
  cumulative_time_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK ((highest_level_completed = 0 AND cumulative_time_ms IS NULL) OR
    (highest_level_completed > 0 AND cumulative_time_ms BETWEEN 1 AND 3600000)),
  UNIQUE (league_id, user_id, ruleset_version),
  FOREIGN KEY (league_id, user_id, run_id) REFERENCES mr_boni_runs (league_id, user_id, id)
) STRICT;
CREATE INDEX mr_boni_bests_rank ON mr_boni_bests (league_id, ruleset_version, highest_level_completed DESC, cumulative_time_ms ASC);


-- Anonymous game scores are independent of accounts and fantasy leagues.
CREATE TABLE mr_boni_guest_runs (
  id TEXT PRIMARY KEY NOT NULL,
  guest_hash TEXT NOT NULL CHECK (length(guest_hash) = 64 AND guest_hash NOT GLOB '*[^0-9a-f]*'),
  client_run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'resurface-v1'),
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  commands_json TEXT NOT NULL CHECK (json_valid(commands_json) AND json_type(commands_json) = 'array' AND json_array_length(commands_json) <= 24000),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (guest_hash, client_run_id),
  UNIQUE (guest_hash, id)
) STRICT;
CREATE INDEX mr_boni_guest_runs_owner ON mr_boni_guest_runs (guest_hash, created_at_ms DESC);

CREATE TABLE mr_boni_guest_bests (
  id TEXT PRIMARY KEY NOT NULL,
  guest_hash TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL CHECK (ruleset_version = 'resurface-v1'),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 30),
  highest_level_completed INTEGER NOT NULL CHECK (highest_level_completed BETWEEN 0 AND 3),
  cumulative_time_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK ((highest_level_completed = 0 AND cumulative_time_ms IS NULL) OR
    (highest_level_completed > 0 AND cumulative_time_ms BETWEEN 1 AND 3600000)),
  FOREIGN KEY (guest_hash, run_id) REFERENCES mr_boni_guest_runs (guest_hash, id)
) STRICT;
CREATE INDEX mr_boni_guest_bests_rank ON mr_boni_guest_bests (ruleset_version, highest_level_completed DESC, cumulative_time_ms ASC);

UPDATE application_metadata SET metadata_value = '96', updated_at_ms = max(updated_at_ms, 96) WHERE metadata_key = 'data_model_version' AND metadata_value = '95';
