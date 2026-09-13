-- hundo-leago: foreign-key-rebuild
-- Preserve every proposal and its model-version evidence while adding the
-- approved terminal state used to route an unsafe direct reversal to explicit
-- commissioner correction recovery.

DROP TRIGGER retention_obligations_creation_trade_insert;
DROP TRIGGER retention_obligations_creation_trade_update;

CREATE TABLE trades_m5_10 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  proposing_team_id TEXT NOT NULL,
  receiving_team_id TEXT NOT NULL,
  proposing_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creating_membership_id TEXT,
  creating_authority TEXT
    CHECK (creating_authority IS NULL OR creating_authority IN ('manager', 'commissioner')),
  status TEXT NOT NULL
    CHECK (status IN (
      'proposed', 'accepted', 'declined', 'cancelled', 'expired',
      'completed', 'reversed', 'correction_required'
    )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  effective_deadline_at_ms INTEGER
    CHECK (effective_deadline_at_ms IS NULL OR effective_deadline_at_ms >= 0),
  responded_at_ms INTEGER CHECK (responded_at_ms IS NULL OR responded_at_ms >= created_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  commissioner_completion_reference TEXT,
  proposal_model_version INTEGER NOT NULL DEFAULT 1
    CHECK (proposal_model_version IN (1, 2)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  CHECK (proposing_team_id <> receiving_team_id),
  CHECK (
    (
      proposal_model_version = 1
      AND creating_membership_id IS NULL
      AND creating_authority IS NULL
      AND effective_deadline_at_ms IS NULL
    )
    OR (
      proposal_model_version = 2
      AND creating_membership_id IS NOT NULL
      AND creating_authority IS NOT NULL
      AND effective_deadline_at_ms > created_at_ms
      AND effective_deadline_at_ms <= expires_at_ms
    )
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, proposing_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, receiving_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, creating_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO trades_m5_10 SELECT * FROM trades;

DROP TABLE trades;
ALTER TABLE trades_m5_10 RENAME TO trades;

CREATE INDEX trades_league_status
  ON trades (league_id, status);
CREATE INDEX trades_pending_team_deadline
  ON trades (
    league_id,
    status,
    proposing_team_id,
    receiving_team_id,
    effective_deadline_at_ms
  );

CREATE TRIGGER retention_obligations_creation_trade_insert
BEFORE INSERT ON retention_obligations
WHEN NEW.creation_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM trades
    WHERE trades.id = NEW.creation_trade_id
      AND trades.league_id = NEW.league_id
  )
BEGIN
  SELECT RAISE(ABORT, 'retention obligation creation trade must belong to the same league');
END;

CREATE TRIGGER retention_obligations_creation_trade_update
BEFORE UPDATE OF league_id, creation_trade_id ON retention_obligations
WHEN NEW.creation_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM trades
    WHERE trades.id = NEW.creation_trade_id
      AND trades.league_id = NEW.league_id
  )
BEGIN
  SELECT RAISE(ABORT, 'retention obligation creation trade must belong to the same league');
END;

UPDATE application_metadata
SET
  metadata_value = '14',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
