-- Additive: existing two-team trades and all asset/history rows stay untouched.
-- Only three-team proposals have rows here. Sending records the proposer consent.
CREATE TABLE trade_participants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'accepted', 'declined')),
  responded_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  responded_by_membership_id TEXT,
  responded_at_ms INTEGER CHECK (responded_at_ms IS NULL OR responded_at_ms >= 0),
  acknowledged_at_ms INTEGER CHECK (acknowledged_at_ms IS NULL OR acknowledged_at_ms >= 0),
  UNIQUE (trade_id, team_id),
  UNIQUE (trade_id, sequence),
  CHECK ((decision = 'pending' AND responded_by_user_id IS NULL AND responded_by_membership_id IS NULL AND responded_at_ms IS NULL)
    OR (decision <> 'pending' AND responded_by_user_id IS NOT NULL AND responded_by_membership_id IS NOT NULL AND responded_at_ms IS NOT NULL)),
  FOREIGN KEY (league_id, trade_id) REFERENCES trades(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id) REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, responded_by_membership_id) REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX trade_participants_team ON trade_participants(league_id, team_id, trade_id);
UPDATE application_metadata SET metadata_value = '64', updated_at_ms = MAX(updated_at_ms, 64)
WHERE metadata_key = 'data_model_version' AND metadata_value = '63';
