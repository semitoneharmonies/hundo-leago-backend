-- hundo-leago: foreign-key-rebuild
-- Persist the approved M3-15 invitation workflow without reclassifying the
-- commissioner proposals that were stored before a discriminator existed.

CREATE TABLE league_invitations_m3_15 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  invited_email_normalized TEXT NOT NULL
    CHECK (invited_email_normalized = lower(trim(invited_email_normalized))),
  invited_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  inviting_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id TEXT,
  workflow TEXT
    CHECK (workflow IS NULL OR workflow IN ('create_team', 'manage_team')),
  team_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  accepted_at_ms INTEGER CHECK (
    accepted_at_ms IS NULL OR accepted_at_ms >= created_at_ms
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  CHECK (
    (workflow IS NULL AND team_id IS NULL)
    OR (
      workflow = 'create_team'
      AND (
        (status = 'accepted' AND team_id IS NOT NULL)
        OR (status <> 'accepted' AND team_id IS NULL)
      )
    )
    OR (workflow = 'manage_team' AND team_id IS NOT NULL)
  ),
  FOREIGN KEY (league_id, membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO league_invitations_m3_15 (
  id,
  league_id,
  invited_email_normalized,
  invited_user_id,
  inviting_user_id,
  membership_id,
  workflow,
  team_id,
  status,
  created_at_ms,
  expires_at_ms,
  accepted_at_ms,
  version
)
SELECT
  id,
  league_id,
  invited_email_normalized,
  invited_user_id,
  inviting_user_id,
  membership_id,
  NULL,
  NULL,
  status,
  created_at_ms,
  expires_at_ms,
  accepted_at_ms,
  version
FROM league_invitations;

DROP TABLE league_invitations;

ALTER TABLE league_invitations_m3_15 RENAME TO league_invitations;

CREATE UNIQUE INDEX league_invitations_one_pending_email
  ON league_invitations (league_id, invited_email_normalized)
  WHERE status = 'pending';

CREATE INDEX league_invitations_league_status
  ON league_invitations (league_id, status);

UPDATE application_metadata
SET
  metadata_value = '3',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
