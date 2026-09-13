-- Store inspected immutable team-logo bytes under backend-generated object
-- keys so profile replacement and removal can commit atomically with SQLite.

CREATE TABLE team_logo_objects (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL,
  media_type TEXT NOT NULL
    CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_length INTEGER NOT NULL
    CHECK (byte_length BETWEEN 1 AND 524288),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 2048),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 2048),
  content_sha256 TEXT NOT NULL
    CHECK (
      length(content_sha256) = 64
      AND content_sha256 = lower(content_sha256)
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  content_bytes BLOB NOT NULL
    CHECK (
      typeof(content_bytes) = 'blob'
      AND length(content_bytes) = byte_length
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX team_logo_objects_league_team
  ON team_logo_objects (league_id, team_id);

UPDATE application_metadata
SET
  metadata_value = '5',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
