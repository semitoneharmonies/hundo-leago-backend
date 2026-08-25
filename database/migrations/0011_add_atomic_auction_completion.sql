-- hundo-leago: foreign-key-rebuild
-- Represent atomic target auction outcomes and an explicitly unplaced Active
-- acquisition without changing existing ownership or auction records.

CREATE TABLE player_ownerships_m5_04 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL,
  ownership_kind TEXT NOT NULL
    CHECK (ownership_kind IN ('Rostered', 'Prospect Right')),
  roster_category TEXT NOT NULL
    CHECK (roster_category IN ('Active', 'Bench', 'Injured Reserve', 'Prospect')),
  position_group TEXT NOT NULL CHECK (position_group IN ('F', 'D')),
  slot_number INTEGER,
  acquired_transaction_type TEXT NOT NULL
    CHECK (length(trim(acquired_transaction_type)) > 0),
  acquired_transaction_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, player_id),
  CHECK (
    (
      roster_category = 'Active'
      AND position_group = 'F'
      AND (
        (
          slot_number IS NOT NULL
          AND slot_number BETWEEN 1 AND 12
        )
        OR (
          slot_number IS NULL
          AND acquired_transaction_type = 'auction_resolution'
        )
      )
    )
    OR (
      roster_category = 'Active'
      AND position_group = 'D'
      AND (
        (
          slot_number IS NOT NULL
          AND slot_number BETWEEN 1 AND 6
        )
        OR (
          slot_number IS NULL
          AND acquired_transaction_type = 'auction_resolution'
        )
      )
    )
    OR (
      roster_category IN ('Bench', 'Injured Reserve')
      AND slot_number IS NOT NULL
      AND slot_number BETWEEN 1 AND 4
    )
    OR (roster_category = 'Prospect' AND slot_number IS NULL)
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO player_ownerships_m5_04 SELECT * FROM player_ownerships;

DROP TABLE player_ownerships;
ALTER TABLE player_ownerships_m5_04 RENAME TO player_ownerships;

CREATE UNIQUE INDEX player_ownerships_active_slot
  ON player_ownerships (
    league_id,
    season_id,
    team_id,
    position_group,
    slot_number
  )
  WHERE roster_category = 'Active' AND slot_number IS NOT NULL;

CREATE UNIQUE INDEX player_ownerships_bench_ir_slot
  ON player_ownerships (
    league_id,
    season_id,
    team_id,
    roster_category,
    slot_number
  )
  WHERE roster_category IN ('Bench', 'Injured Reserve');

CREATE TABLE auctions_m5_04 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN (
      'open', 'resolving', 'resolved', 'no_winner',
      'cancelled', 'failed'
    )
  ),
  opened_at_ms INTEGER NOT NULL CHECK (opened_at_ms >= 0),
  resolves_at_ms INTEGER NOT NULL CHECK (resolves_at_ms > opened_at_ms),
  opened_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO auctions_m5_04 SELECT * FROM auctions;

DROP TABLE auctions;
ALTER TABLE auctions_m5_04 RENAME TO auctions;

CREATE UNIQUE INDEX auctions_one_active_per_player
  ON auctions (league_id, player_id)
  WHERE status IN ('open', 'resolving');

CREATE TABLE auction_bids_m5_04 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  submitted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  total_value_cents INTEGER NOT NULL CHECK (total_value_cents > 0),
  term_years INTEGER NOT NULL CHECK (term_years BETWEEN 1 AND 3),
  lowest_offered_aav_cents INTEGER NOT NULL
    CHECK (lowest_offered_aav_cents > 0),
  first_submitted_at_ms INTEGER NOT NULL CHECK (first_submitted_at_ms >= 0),
  last_edited_at_ms INTEGER NOT NULL
    CHECK (last_edited_at_ms >= first_submitted_at_ms),
  edit_count INTEGER NOT NULL DEFAULT 0 CHECK (edit_count >= 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'active', 'withdrawn', 'won', 'lost', 'invalid', 'cancelled'
    )
  ),
  idempotency_request_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO auction_bids_m5_04 SELECT * FROM auction_bids;

DROP TABLE auction_bids;
ALTER TABLE auction_bids_m5_04 RENAME TO auction_bids;

CREATE UNIQUE INDEX auction_bids_one_current_team_bid
  ON auction_bids (league_id, auction_id, team_id)
  WHERE status = 'active';

CREATE TABLE auction_resolutions_m5_04 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  scheduled_occurrence_key TEXT NOT NULL,
  outcome_code TEXT NOT NULL CHECK (
    outcome_code IN (
      'winner', 'no_winner', 'player_unavailable',
      'season_closed', 'failed', 'recovered'
    )
  ),
  winning_team_id TEXT,
  winning_bid_id TEXT,
  highest_bid_cents INTEGER
    CHECK (highest_bid_cents IS NULL OR highest_bid_cents > 0),
  second_price_input_cents INTEGER
    CHECK (second_price_input_cents IS NULL OR second_price_input_cents >= 0),
  final_contract_value_cents INTEGER
    CHECK (final_contract_value_cents IS NULL OR final_contract_value_cents > 0),
  winning_term_years INTEGER
    CHECK (winning_term_years IS NULL OR winning_term_years BETWEEN 1 AND 3),
  final_aav_cents INTEGER
    CHECK (final_aav_cents IS NULL OR final_aav_cents > 0),
  general_illegal INTEGER NOT NULL DEFAULT 0
    CHECK (general_illegal IN (0, 1)),
  warnings_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(warnings_json) > 1),
  contract_id TEXT,
  ownership_id TEXT,
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('automatic', 'commissioner')),
  triggered_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'resolved', 'no_bids', 'no_winner',
      'cancelled', 'failed', 'recovered'
    )
  ),
  resolved_at_ms INTEGER NOT NULL CHECK (resolved_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, auction_id),
  UNIQUE (league_id, scheduled_occurrence_key),
  UNIQUE (league_id, idempotency_key),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_id)
    REFERENCES player_ownerships(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO auction_resolutions_m5_04 (
  id,
  league_id,
  season_id,
  auction_id,
  scheduled_occurrence_key,
  outcome_code,
  winning_team_id,
  winning_bid_id,
  highest_bid_cents,
  second_price_input_cents,
  final_contract_value_cents,
  winning_term_years,
  final_aav_cents,
  general_illegal,
  warnings_json,
  contract_id,
  ownership_id,
  trigger_type,
  triggered_by_user_id,
  idempotency_key,
  status,
  resolved_at_ms
)
SELECT
  id,
  league_id,
  season_id,
  auction_id,
  scheduled_occurrence_key,
  CASE status
    WHEN 'resolved' THEN 'winner'
    WHEN 'no_bids' THEN 'no_winner'
    WHEN 'recovered' THEN 'recovered'
    ELSE 'failed'
  END,
  winning_team_id,
  winning_bid_id,
  highest_bid_cents,
  second_price_input_cents,
  final_contract_value_cents,
  NULL,
  NULL,
  0,
  '[]',
  contract_id,
  ownership_id,
  trigger_type,
  triggered_by_user_id,
  idempotency_key,
  status,
  resolved_at_ms
FROM auction_resolutions;

DROP TABLE auction_resolutions;
ALTER TABLE auction_resolutions_m5_04 RENAME TO auction_resolutions;

UPDATE application_metadata
SET
  metadata_value = '11',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
