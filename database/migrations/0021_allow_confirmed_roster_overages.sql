-- hundo-leago: foreign-key-rebuild
-- A confirmed ordinary roster move may intentionally leave a player unplaced
-- when the destination category has no remaining finite slot. The application
-- service remains authoritative for confirmation and eligibility; this
-- constraint permits the resulting temporary illegal state to persist.

CREATE TABLE player_ownerships_m7_15 (
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
  trade_blocked INTEGER NOT NULL DEFAULT 0
    CHECK (trade_blocked IN (0, 1)),
  UNIQUE (league_id, id),
  UNIQUE (league_id, player_id),
  CHECK (
    (
      roster_category = 'Active'
      AND position_group = 'F'
      AND (slot_number IS NULL OR slot_number BETWEEN 1 AND 12)
    )
    OR (
      roster_category = 'Active'
      AND position_group = 'D'
      AND (slot_number IS NULL OR slot_number BETWEEN 1 AND 6)
    )
    OR (
      roster_category IN ('Bench', 'Injured Reserve')
      AND (slot_number IS NULL OR slot_number BETWEEN 1 AND 4)
    )
    OR (roster_category = 'Prospect' AND slot_number IS NULL)
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO player_ownerships_m7_15 SELECT * FROM player_ownerships;

DROP TABLE player_ownerships;
ALTER TABLE player_ownerships_m7_15 RENAME TO player_ownerships;

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
  WHERE roster_category IN ('Bench', 'Injured Reserve')
    AND slot_number IS NOT NULL;

CREATE INDEX player_ownerships_league_trade_block
  ON player_ownerships (league_id, trade_blocked, team_id)
  WHERE trade_blocked = 1;

CREATE TRIGGER player_ownerships_clear_trade_block_on_transfer
AFTER UPDATE OF team_id ON player_ownerships
WHEN OLD.trade_blocked = 1 AND NEW.team_id IS NOT OLD.team_id
BEGIN
  UPDATE player_ownerships
  SET trade_blocked = 0
  WHERE id = NEW.id;
END;

UPDATE application_metadata
SET metadata_value = '21',
    updated_at_ms = CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
