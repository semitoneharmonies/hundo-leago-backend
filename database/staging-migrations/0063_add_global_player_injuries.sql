CREATE TABLE player_injury_status (
  id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'injured', 'healthy')),
  source TEXT NOT NULL CHECK (source IN ('espn', 'admin')),
  evidence_at_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  review_reason TEXT,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE player_injury_feed (
  id TEXT PRIMARY KEY,
  player_id TEXT UNIQUE REFERENCES players(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  birth_date TEXT,
  team TEXT NOT NULL,
  designation TEXT NOT NULL,
  injury_type TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  reported_at_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE player_injury_events (
  id TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE player_injury_sync (
  id TEXT PRIMARY KEY CHECK (id = 'espn'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  last_success_at_ms INTEGER,
  last_attempt_at_ms INTEGER,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;

UPDATE application_metadata SET metadata_value = '63', updated_at_ms = MAX(updated_at_ms, 63)
WHERE metadata_key = 'data_model_version' AND metadata_value = '62';
