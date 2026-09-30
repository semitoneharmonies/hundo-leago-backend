-- Append-only receipts for explicitly reviewed league maintenance.
CREATE TABLE league_management_actions (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 season_id TEXT,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 actor_authority TEXT NOT NULL CHECK(actor_authority IN ('commissioner','platform_administrator','platform_administrator_as_commissioner')),
 action_type TEXT NOT NULL CHECK(action_type IN ('pick_repair','pause','resume','reverse_correction')),
 target_id TEXT NOT NULL,
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 FOREIGN KEY(league_id,season_id) REFERENCES seasons(league_id,id),
 UNIQUE(league_id,actor_user_id,client_key)
) STRICT;
CREATE INDEX league_management_actions_timeline ON league_management_actions(league_id,created_at_ms DESC,id);
CREATE TRIGGER league_management_actions_immutable_update BEFORE UPDATE ON league_management_actions
BEGIN SELECT RAISE(ABORT,'Management receipts are immutable'); END;
CREATE TRIGGER league_management_actions_immutable_delete BEFORE DELETE ON league_management_actions
BEGIN SELECT RAISE(ABORT,'Management receipts are immutable'); END;
UPDATE application_metadata SET metadata_value='79',updated_at_ms=max(updated_at_ms,79)
WHERE metadata_key='data_model_version' AND metadata_value='78';
