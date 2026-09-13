-- hundo-leago: foreign-key-rebuild
-- Preserve an illegal normal-lock decision without inventing a scoring baseline.

CREATE TABLE matchup_roster_locks_m6_05 (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  lock_type TEXT NOT NULL CHECK (lock_type IN ('normal', 'late')),
  legal INTEGER NOT NULL CHECK (legal IN (0, 1)),
  legality_reason_code TEXT,
  locked_at_ms INTEGER NOT NULL CHECK (locked_at_ms >= 0),
  baseline_snapshot_id TEXT,
  source_freshness_status TEXT NOT NULL
    CHECK (source_freshness_status IN ('fresh', 'stale', 'unknown')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, matchup_week_id, team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, baseline_snapshot_id)
    REFERENCES stat_snapshots(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (legal = 0 AND lock_type = 'normal' AND legality_reason_code IS NOT NULL
      AND length(trim(legality_reason_code)) BETWEEN 1 AND 100
      AND baseline_snapshot_id IS NULL AND source_freshness_status = 'unknown')
    OR
    (legal = 1 AND legality_reason_code IS NULL
      AND baseline_snapshot_id IS NOT NULL AND source_freshness_status = 'fresh')
  )
) STRICT;

INSERT INTO matchup_roster_locks_m6_05 (
  id, league_id, season_id, matchup_week_id, team_id, lock_type, legal,
  legality_reason_code, locked_at_ms, baseline_snapshot_id,
  source_freshness_status, created_at_ms, version
)
SELECT
  id, league_id, season_id, matchup_week_id, team_id, lock_type, legal,
  NULL, locked_at_ms, baseline_snapshot_id, source_freshness_status,
  created_at_ms, version
FROM matchup_roster_locks;

DROP TABLE matchup_roster_locks;
ALTER TABLE matchup_roster_locks_m6_05 RENAME TO matchup_roster_locks;

UPDATE application_metadata
SET metadata_value = '17',
    updated_at_ms = CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
