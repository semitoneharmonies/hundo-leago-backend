-- Keep every accepted injury value while adding truthful Realtime provenance.
-- No table references player_injury_status; its player foreign key is retained.
CREATE TABLE player_injury_status_realtime (
  id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'injured', 'healthy')),
  source TEXT NOT NULL CHECK (source IN ('espn', 'admin', 'realtime')),
  evidence_at_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  review_reason TEXT,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  timeline TEXT CHECK (timeline IS NULL OR length(timeline) <= 100),
  designation TEXT CHECK (designation IS NULL OR length(designation) <= 30),
  injury_reason TEXT CHECK (injury_reason IS NULL OR length(injury_reason) <= 200)
) STRICT;
INSERT INTO player_injury_status_realtime
  (rowid,id,status,source,evidence_at_ms,observed_at_ms,review_reason,updated_at_ms,version,timeline,designation,injury_reason)
SELECT rowid,id,status,source,evidence_at_ms,observed_at_ms,review_reason,updated_at_ms,version,timeline,designation,injury_reason
FROM player_injury_status;
DROP TABLE player_injury_status;
ALTER TABLE player_injury_status_realtime RENAME TO player_injury_status;

CREATE TABLE player_injury_realtime_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL UNIQUE REFERENCES players(id) ON DELETE RESTRICT,
  nhl_player_id TEXT NOT NULL UNIQUE,
  provider_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  verification_method TEXT NOT NULL CHECK (verification_method IN ('reviewed_crosswalk','unique_name_team_position')),
  verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= verified_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE player_injury_realtime_feed (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team TEXT,
  position TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('injured','review','excluded')),
  medical_reason TEXT,
  designation TEXT NOT NULL,
  reported_at_ms INTEGER,
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  present INTEGER NOT NULL CHECK (present IN (0,1)),
  absence_count INTEGER NOT NULL DEFAULT 0 CHECK (absence_count >= 0),
  last_present_at_ms INTEGER NOT NULL CHECK (last_present_at_ms >= 0),
  last_absent_at_ms INTEGER,
  last_injury_evidence_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE player_injury_realtime_runs (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL UNIQUE,
  scheduled_at_ms INTEGER NOT NULL CHECK (scheduled_at_ms >= 0),
  attempted_at_ms INTEGER NOT NULL CHECK (attempted_at_ms >= scheduled_at_ms),
  lease_until_ms INTEGER NOT NULL CHECK (lease_until_ms > attempted_at_ms),
  request_month TEXT NOT NULL CHECK (length(request_month) = 7),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','abandoned')),
  completed_at_ms INTEGER,
  error_code TEXT,
  source_count INTEGER,
  changed_count INTEGER,
  CHECK ((status = 'running' AND completed_at_ms IS NULL) OR
    (status <> 'running' AND completed_at_ms >= attempted_at_ms))
) STRICT;
CREATE UNIQUE INDEX player_injury_realtime_one_running
  ON player_injury_realtime_runs(status) WHERE status = 'running';
CREATE INDEX player_injury_realtime_request_month
  ON player_injury_realtime_runs(request_month);

CREATE TABLE player_injury_realtime_state (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'realtime'),
  last_attempt_at_ms INTEGER,
  last_success_at_ms INTEGER,
  last_source_generated_at_ms INTEGER,
  last_source_count INTEGER,
  last_team_count INTEGER,
  last_error_code TEXT,
  cooldown_until_ms INTEGER NOT NULL DEFAULT 0,
  provider_remaining INTEGER,
  provider_reset_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

UPDATE application_metadata SET metadata_value = '97', updated_at_ms = MAX(updated_at_ms, 97)
WHERE metadata_key = 'data_model_version' AND metadata_value = '96';
