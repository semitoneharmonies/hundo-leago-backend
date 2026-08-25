-- hundo-leago: foreign-key-rebuild
-- Preserve exact original contract totals while allowing the approved AAV
-- calculation to round total divided by term to the nearest integer cent.

CREATE TABLE contracts_m4_05 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  current_team_id TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK (contract_type IN ('normal', 'fantasy_elc')),
  original_total_value_cents INTEGER NOT NULL
    CHECK (original_total_value_cents > 0),
  original_term_years INTEGER NOT NULL
    CHECK (original_term_years BETWEEN 1 AND 3),
  aav_cents INTEGER NOT NULL CHECK (aav_cents > 0),
  start_season_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'expired', 'eliminated', 'cancelled')),
  acquisition_source_type TEXT NOT NULL
    CHECK (length(trim(acquisition_source_type)) > 0),
  acquisition_source_id TEXT,
  auction_buyout_lock_expires_at_ms INTEGER
    CHECK (auction_buyout_lock_expires_at_ms IS NULL OR auction_buyout_lock_expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  CHECK (
    aav_cents =
      (original_total_value_cents / original_term_years)
      + CASE
        WHEN
          (original_total_value_cents % original_term_years) * 2
            >= original_term_years
        THEN 1
        ELSE 0
      END
  ),
  FOREIGN KEY (league_id, current_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, start_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO contracts_m4_05 (
  id,
  league_id,
  player_id,
  current_team_id,
  contract_type,
  original_total_value_cents,
  original_term_years,
  aav_cents,
  start_season_id,
  status,
  acquisition_source_type,
  acquisition_source_id,
  auction_buyout_lock_expires_at_ms,
  created_at_ms,
  updated_at_ms,
  version
)
SELECT
  id,
  league_id,
  player_id,
  current_team_id,
  contract_type,
  original_total_value_cents,
  original_term_years,
  aav_cents,
  start_season_id,
  status,
  acquisition_source_type,
  acquisition_source_id,
  auction_buyout_lock_expires_at_ms,
  created_at_ms,
  updated_at_ms,
  version
FROM contracts;

DROP TABLE contracts;

ALTER TABLE contracts_m4_05 RENAME TO contracts;

CREATE UNIQUE INDEX contracts_one_active_per_player
  ON contracts (league_id, player_id)
  WHERE status = 'active';

CREATE INDEX contracts_league_status
  ON contracts (league_id, status);

UPDATE application_metadata
SET
  metadata_value = '6',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
