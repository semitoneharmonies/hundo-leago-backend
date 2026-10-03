-- Defaults stay implicit, so upgrading changes no league's auction schedule.
CREATE TABLE league_auction_schedule_changes (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 actor_authority TEXT NOT NULL CHECK(actor_authority IN ('commissioner','platform_administrator','platform_administrator_as_commissioner')),
 revision INTEGER NOT NULL CHECK(revision>=1),
 close_weekday INTEGER NOT NULL CHECK(close_weekday BETWEEN 0 AND 6),
 close_minute_of_day INTEGER NOT NULL CHECK(close_minute_of_day BETWEEN 0 AND 1439),
 creation_cutoff_minutes INTEGER NOT NULL CHECK(creation_cutoff_minutes>=0 AND creation_cutoff_minutes<close_weekday*1440+close_minute_of_day),
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 UNIQUE(league_id,revision),
 UNIQUE(league_id,actor_user_id,client_key)
) STRICT;
CREATE TRIGGER league_auction_schedule_changes_immutable_update BEFORE UPDATE ON league_auction_schedule_changes
BEGIN SELECT RAISE(ABORT,'Auction schedule history is immutable'); END;
CREATE TRIGGER league_auction_schedule_changes_immutable_delete BEFORE DELETE ON league_auction_schedule_changes
BEGIN SELECT RAISE(ABORT,'Auction schedule history is immutable'); END;
UPDATE application_metadata SET metadata_value='81',updated_at_ms=max(updated_at_ms,81)
WHERE metadata_key='data_model_version' AND metadata_value='80';

