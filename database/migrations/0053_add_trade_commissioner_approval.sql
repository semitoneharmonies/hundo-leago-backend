-- Persist the receiving-side acceptance that gates any proposal containing
-- Future Considerations. The proposal remains open in the legacy trades table
-- so every existing cancellation and expiry guard continues to apply; this
-- one-to-one receipt is the durable evidence from which the new exact state is
-- projected until the proposal reaches a terminal status.

CREATE TABLE trade_future_consideration_acceptances (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  accepted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_by_membership_id TEXT NOT NULL,
  accepted_authority TEXT NOT NULL
    CHECK (accepted_authority = 'manager'),
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
  trade_version_after INTEGER NOT NULL CHECK (trade_version_after >= 2),
  UNIQUE (league_id, trade_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, trade_id)
    REFERENCES trades(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, accepted_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX trade_future_consideration_acceptances_actor
  ON trade_future_consideration_acceptances (
    league_id,
    accepted_by_user_id,
    accepted_at_ms
  );

UPDATE application_metadata
SET metadata_value = '53',
    updated_at_ms = CASE
      WHEN updated_at_ms < 53 THEN 53
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '52';
