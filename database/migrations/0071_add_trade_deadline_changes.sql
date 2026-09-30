-- Additive history only. Existing settings, proposals and completed trades are retained.
CREATE TABLE league_trade_deadline_changes (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND id=lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_authority TEXT NOT NULL CHECK(actor_authority IN ('commissioner','platform_administrator')),
  client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
  previous_deadline_at_ms INTEGER CHECK(previous_deadline_at_ms IS NULL OR previous_deadline_at_ms>=0),
  deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>created_at_ms),
  previous_settings_version INTEGER NOT NULL CHECK(previous_settings_version>=1),
  settings_version INTEGER NOT NULL CHECK(settings_version=previous_settings_version+1),
  before_proposals_json TEXT NOT NULL CHECK(json_valid(before_proposals_json) AND json_type(before_proposals_json)='array'),
  after_proposals_json TEXT NOT NULL CHECK(json_valid(after_proposals_json) AND json_type(after_proposals_json)='array'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(league_id,actor_user_id,client_key),
  FOREIGN KEY(league_id,season_id) REFERENCES seasons(league_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX league_trade_deadline_changes_history ON league_trade_deadline_changes(league_id,created_at_ms,id);
CREATE TRIGGER league_trade_deadline_changes_valid_insert BEFORE INSERT ON league_trade_deadline_changes
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM league_settings s JOIN leagues l ON l.id=s.league_id
    WHERE l.id=NEW.league_id AND l.status IN ('setup','active') AND l.current_season_id IS NEW.season_id
      AND s.trade_deadline_at_ms IS NEW.previous_deadline_at_ms AND s.version=NEW.previous_settings_version
  ) OR json_array_length(NEW.before_proposals_json)<>json_array_length(NEW.after_proposals_json)
  THEN RAISE(ABORT,'Trade deadline change requires current league settings') END;
END;
CREATE TRIGGER league_trade_deadline_changes_immutable_update BEFORE UPDATE ON league_trade_deadline_changes
BEGIN SELECT RAISE(ABORT,'Trade deadline history is immutable'); END;
CREATE TRIGGER league_trade_deadline_changes_immutable_delete BEFORE DELETE ON league_trade_deadline_changes
BEGIN SELECT RAISE(ABORT,'Trade deadline history is immutable'); END;
UPDATE application_metadata SET metadata_value='71',updated_at_ms=max(updated_at_ms,71)
WHERE metadata_key='data_model_version';
