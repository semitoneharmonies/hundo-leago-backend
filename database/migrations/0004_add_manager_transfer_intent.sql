-- hundo-leago: foreign-key-rebuild
-- Preserve each manager-assignment record while adding the exact same-league
-- accepted assignment that a pending transfer intends to replace.

CREATE TABLE team_manager_assignments_m3_17 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id TEXT NOT NULL,
  assigned_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  replaces_assignment_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'declined', 'ended')),
  assigned_at_ms INTEGER NOT NULL CHECK (assigned_at_ms >= 0),
  accepted_at_ms INTEGER
    CHECK (accepted_at_ms IS NULL OR accepted_at_ms >= assigned_at_ms),
  ended_at_ms INTEGER
    CHECK (ended_at_ms IS NULL OR ended_at_ms >= assigned_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  CHECK (replaces_assignment_id IS NULL OR replaces_assignment_id <> id),
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, replaces_assignment_id)
    REFERENCES team_manager_assignments_m3_17(league_id, id)
    ON DELETE RESTRICT
) STRICT;

INSERT INTO team_manager_assignments_m3_17 (
  id,
  league_id,
  team_id,
  user_id,
  membership_id,
  assigned_by_user_id,
  replaces_assignment_id,
  status,
  assigned_at_ms,
  accepted_at_ms,
  ended_at_ms,
  version
)
SELECT
  id,
  league_id,
  team_id,
  user_id,
  membership_id,
  assigned_by_user_id,
  NULL,
  status,
  assigned_at_ms,
  accepted_at_ms,
  ended_at_ms,
  version
FROM team_manager_assignments;

DROP TABLE team_manager_assignments;

ALTER TABLE team_manager_assignments_m3_17
  RENAME TO team_manager_assignments;

CREATE UNIQUE INDEX team_manager_assignments_one_active_manager
  ON team_manager_assignments (league_id, team_id)
  WHERE status = 'accepted' AND ended_at_ms IS NULL;

CREATE INDEX team_manager_assignments_league_team
  ON team_manager_assignments (league_id, team_id);

UPDATE application_metadata
SET
  metadata_value = '4',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
