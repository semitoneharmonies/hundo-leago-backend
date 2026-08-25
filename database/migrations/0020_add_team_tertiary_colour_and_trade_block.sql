-- Add optional third team colour and durable informational trade-block state.
-- Existing teams remain two-colour teams and existing ownerships remain unflagged.

ALTER TABLE teams
  ADD COLUMN tertiary_colour TEXT
  CHECK (
    tertiary_colour IS NULL
    OR (
      length(tertiary_colour) = 7
      AND tertiary_colour = lower(tertiary_colour)
      AND tertiary_colour GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
  );

ALTER TABLE player_ownerships
  ADD COLUMN trade_blocked INTEGER NOT NULL DEFAULT 0
  CHECK (trade_blocked IN (0, 1));

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
SET metadata_value = '20',
    updated_at_ms = CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
