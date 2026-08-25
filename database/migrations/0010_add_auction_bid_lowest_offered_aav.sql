-- hundo-leago: foreign-key-rebuild
-- Preserve the lowest valid AAV each team has offered so later auction
-- resolution cannot price a winning contract above that team's own floor.

CREATE TABLE auction_bids_m5_02 (
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
  status TEXT NOT NULL
    CHECK (status IN ('active', 'withdrawn', 'won', 'lost', 'invalid')),
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

INSERT INTO auction_bids_m5_02 (
  id,
  league_id,
  season_id,
  auction_id,
  team_id,
  submitted_by_user_id,
  total_value_cents,
  term_years,
  lowest_offered_aav_cents,
  first_submitted_at_ms,
  last_edited_at_ms,
  edit_count,
  status,
  idempotency_request_id,
  version
)
SELECT
  id,
  league_id,
  season_id,
  auction_id,
  team_id,
  submitted_by_user_id,
  total_value_cents,
  term_years,
  (total_value_cents / term_years)
    + CASE
      WHEN (total_value_cents % term_years) * 2 >= term_years THEN 1
      ELSE 0
    END,
  first_submitted_at_ms,
  last_edited_at_ms,
  edit_count,
  status,
  idempotency_request_id,
  version
FROM auction_bids;

DROP TABLE auction_bids;

ALTER TABLE auction_bids_m5_02 RENAME TO auction_bids;

CREATE UNIQUE INDEX auction_bids_one_current_team_bid
  ON auction_bids (league_id, auction_id, team_id)
  WHERE status = 'active';

UPDATE application_metadata
SET
  metadata_value = '10',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
