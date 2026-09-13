-- hundo-leago: foreign-key-rebuild
-- Preserve legacy imported trade rows without guessed actor/deadline history,
-- while requiring complete actor, deadline, and typed-asset evidence for every
-- target proposal created by M5-06 and later.

DROP TRIGGER retention_obligations_creation_trade_insert;
DROP TRIGGER retention_obligations_creation_trade_update;

CREATE TABLE trades_m5_06 (
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
    CHECK (status IN ('proposed', 'accepted', 'declined', 'cancelled', 'expired', 'completed', 'reversed')),
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

INSERT INTO trades_m5_06 (
  id,
  league_id,
  season_id,
  proposing_team_id,
  receiving_team_id,
  proposing_user_id,
  creating_membership_id,
  creating_authority,
  status,
  created_at_ms,
  expires_at_ms,
  effective_deadline_at_ms,
  responded_at_ms,
  completed_at_ms,
  commissioner_completion_reference,
  proposal_model_version,
  updated_at_ms,
  version
)
SELECT
  id,
  league_id,
  season_id,
  proposing_team_id,
  receiving_team_id,
  proposing_user_id,
  NULL,
  NULL,
  status,
  created_at_ms,
  expires_at_ms,
  NULL,
  responded_at_ms,
  completed_at_ms,
  commissioner_completion_reference,
  1,
  updated_at_ms,
  version
FROM trades;

DROP TABLE trades;
ALTER TABLE trades_m5_06 RENAME TO trades;

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

CREATE TABLE trade_assets_m5_06 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  trade_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('proposing_to_receiving', 'receiving_to_proposing')),
  source_team_id TEXT NOT NULL,
  destination_team_id TEXT NOT NULL,
  asset_type TEXT NOT NULL
    CHECK (asset_type IN (
      'contract',
      'prospect_right',
      'draft_pick',
      'retention_obligation',
      'buyout_obligation',
      'future_consideration',
      'requested_retention'
    )),
  contract_id TEXT,
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  draft_pick_id TEXT,
  retention_obligation_id TEXT,
  buyout_obligation_id TEXT,
  future_consideration_id TEXT,
  requested_retention_contract_id TEXT,
  requested_retention_cents INTEGER
    CHECK (requested_retention_cents IS NULL OR requested_retention_cents > 0),
  future_consideration_description TEXT
    CHECK (
      future_consideration_description IS NULL
      OR length(trim(future_consideration_description)) BETWEEN 1 AND 500
    ),
  proposal_snapshot_json TEXT,
  asset_model_version INTEGER NOT NULL DEFAULT 1
    CHECK (asset_model_version IN (1, 2)),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (trade_id, sequence),
  CHECK (source_team_id <> destination_team_id),
  CHECK (
    (
      asset_model_version = 1
      AND requested_retention_contract_id IS NULL
      AND future_consideration_description IS NULL
      AND (
        (asset_type = 'contract'
          AND contract_id IS NOT NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_cents IS NULL)
        OR (asset_type = 'prospect_right'
          AND contract_id IS NULL
          AND player_id IS NOT NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_cents IS NULL)
        OR (asset_type = 'draft_pick'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NOT NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_cents IS NULL)
        OR (asset_type = 'retention_obligation'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NOT NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_cents IS NULL)
        OR (asset_type = 'buyout_obligation'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NOT NULL
          AND future_consideration_id IS NULL
          AND requested_retention_cents IS NULL)
        OR (asset_type = 'future_consideration'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NOT NULL
          AND requested_retention_cents IS NULL)
        OR (asset_type = 'requested_retention'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_cents IS NOT NULL)
      )
    )
    OR (
      asset_model_version = 2
      AND proposal_snapshot_json IS NOT NULL
      AND json_valid(proposal_snapshot_json) = 1
      AND json_type(proposal_snapshot_json) = 'object'
      AND (
        (asset_type = 'contract'
          AND contract_id IS NOT NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_contract_id IS NULL
          AND requested_retention_cents IS NULL
          AND future_consideration_description IS NULL)
        OR (asset_type = 'prospect_right'
          AND contract_id IS NULL
          AND player_id IS NOT NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_contract_id IS NULL
          AND requested_retention_cents IS NULL
          AND future_consideration_description IS NULL)
        OR (asset_type = 'draft_pick'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NOT NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_contract_id IS NULL
          AND requested_retention_cents IS NULL
          AND future_consideration_description IS NULL)
        OR (asset_type = 'retention_obligation'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NOT NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_contract_id IS NULL
          AND requested_retention_cents IS NULL
          AND future_consideration_description IS NULL)
        OR (asset_type = 'buyout_obligation'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NOT NULL
          AND future_consideration_id IS NULL
          AND requested_retention_contract_id IS NULL
          AND requested_retention_cents IS NULL
          AND future_consideration_description IS NULL)
        OR (asset_type = 'future_consideration'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND requested_retention_contract_id IS NULL
          AND requested_retention_cents IS NULL
          AND (
            (future_consideration_id IS NOT NULL
              AND future_consideration_description IS NULL)
            OR (future_consideration_id IS NULL
              AND future_consideration_description IS NOT NULL)
          ))
        OR (asset_type = 'requested_retention'
          AND contract_id IS NULL
          AND player_id IS NULL
          AND draft_pick_id IS NULL
          AND retention_obligation_id IS NULL
          AND buyout_obligation_id IS NULL
          AND future_consideration_id IS NULL
          AND requested_retention_contract_id IS NOT NULL
          AND requested_retention_cents IS NOT NULL
          AND future_consideration_description IS NULL)
      )
    )
  ),
  FOREIGN KEY (league_id, trade_id)
    REFERENCES trades(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, destination_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, draft_pick_id)
    REFERENCES draft_picks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, retention_obligation_id)
    REFERENCES retention_obligations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, buyout_obligation_id)
    REFERENCES buyout_obligations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, future_consideration_id)
    REFERENCES future_considerations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, requested_retention_contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO trade_assets_m5_06 (
  id,
  league_id,
  trade_id,
  direction,
  source_team_id,
  destination_team_id,
  asset_type,
  contract_id,
  player_id,
  draft_pick_id,
  retention_obligation_id,
  buyout_obligation_id,
  future_consideration_id,
  requested_retention_contract_id,
  requested_retention_cents,
  future_consideration_description,
  proposal_snapshot_json,
  asset_model_version,
  sequence,
  created_at_ms
)
SELECT
  id,
  league_id,
  trade_id,
  direction,
  source_team_id,
  destination_team_id,
  asset_type,
  contract_id,
  player_id,
  draft_pick_id,
  retention_obligation_id,
  buyout_obligation_id,
  future_consideration_id,
  NULL,
  requested_retention_cents,
  NULL,
  proposal_snapshot_json,
  1,
  sequence,
  created_at_ms
FROM trade_assets;

DROP TABLE trade_assets;
ALTER TABLE trade_assets_m5_06 RENAME TO trade_assets;

CREATE INDEX trade_assets_league_trade
  ON trade_assets (league_id, trade_id);
CREATE INDEX trade_assets_reference_lookup
  ON trade_assets (
    league_id,
    asset_type,
    contract_id,
    player_id,
    draft_pick_id,
    retention_obligation_id,
    buyout_obligation_id,
    future_consideration_id,
    requested_retention_contract_id
  );

UPDATE application_metadata
SET
  metadata_value = '12',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
