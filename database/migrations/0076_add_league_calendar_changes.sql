-- Additive calendar history. Existing dates and worker records remain unchanged.
CREATE TABLE league_calendar_changes (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 season_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 actor_authority TEXT NOT NULL CHECK(actor_authority IN ('commissioner','platform_administrator','platform_administrator_as_commissioner')),
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 jobs_json TEXT NOT NULL CHECK(json_valid(jobs_json)),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 UNIQUE(league_id,actor_user_id,client_key),
 FOREIGN KEY(league_id,season_id) REFERENCES seasons(league_id,id)
) STRICT;
CREATE INDEX league_calendar_changes_history ON league_calendar_changes(league_id,season_id,created_at_ms);
CREATE TRIGGER league_calendar_changes_immutable_update BEFORE UPDATE ON league_calendar_changes
BEGIN SELECT RAISE(ABORT,'Calendar history is immutable'); END;
CREATE TRIGGER league_calendar_changes_immutable_delete BEFORE DELETE ON league_calendar_changes
BEGIN SELECT RAISE(ABORT,'Calendar history is immutable'); END;
UPDATE application_metadata SET metadata_value='76',updated_at_ms=max(updated_at_ms,76)
WHERE metadata_key='data_model_version' AND metadata_value='75';

