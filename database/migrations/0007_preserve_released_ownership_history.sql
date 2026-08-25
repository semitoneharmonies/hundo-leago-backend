-- hundo-leago: foreign-key-rebuild
-- Current ownership may be released while append-only history retains the
-- released ownership's stable ID as a historical reference.

CREATE TABLE ownership_events_m4_06 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  team_id TEXT,
  ownership_id TEXT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  source_type TEXT,
  source_id TEXT,
  before_metadata_json TEXT,
  after_metadata_json TEXT,
  reason TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO ownership_events_m4_06 (
  id,
  league_id,
  season_id,
  player_id,
  team_id,
  ownership_id,
  event_type,
  actor_user_id,
  source_type,
  source_id,
  before_metadata_json,
  after_metadata_json,
  reason,
  occurred_at_ms
)
SELECT
  id,
  league_id,
  season_id,
  player_id,
  team_id,
  ownership_id,
  event_type,
  actor_user_id,
  source_type,
  source_id,
  before_metadata_json,
  after_metadata_json,
  reason,
  occurred_at_ms
FROM ownership_events;

DROP TABLE ownership_events;

ALTER TABLE ownership_events_m4_06 RENAME TO ownership_events;

CREATE INDEX ownership_events_league_time
  ON ownership_events (league_id, occurred_at_ms DESC);

UPDATE application_metadata
SET
  metadata_value = '7',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
