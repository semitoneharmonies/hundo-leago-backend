-- hundo-leago: foreign-key-rebuild
-- Commissioner correction reasons are optional in the approved product rules.
-- Preserve the searchable correction index while removing the legacy NOT NULL
-- constraint that incorrectly required a written reason.

CREATE TABLE commissioner_corrections_m4_11 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT,
  feature TEXT NOT NULL CHECK (length(trim(feature)) > 0),
  feature_record_id TEXT NOT NULL CHECK (length(trim(feature_record_id)) > 0),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) > 0),
  before_snapshot_json TEXT,
  after_snapshot_json TEXT,
  corrected_at_ms INTEGER NOT NULL CHECK (corrected_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO commissioner_corrections_m4_11 (
  id,
  league_id,
  season_id,
  feature,
  feature_record_id,
  actor_user_id,
  reason,
  before_snapshot_json,
  after_snapshot_json,
  corrected_at_ms
)
SELECT
  id,
  league_id,
  season_id,
  feature,
  feature_record_id,
  actor_user_id,
  reason,
  before_snapshot_json,
  after_snapshot_json,
  corrected_at_ms
FROM commissioner_corrections;

DROP TABLE commissioner_corrections;

ALTER TABLE commissioner_corrections_m4_11
  RENAME TO commissioner_corrections;

CREATE INDEX commissioner_corrections_league_time
  ON commissioner_corrections (league_id, corrected_at_ms DESC);

UPDATE application_metadata
SET
  metadata_value = '8',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
