-- A reset archive is private recovery material. It is never part of league exports.
CREATE TABLE league_reset_archives (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 season_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 schema_version INTEGER NOT NULL CHECK(schema_version>=83),
 key_version INTEGER NOT NULL CHECK(key_version>0),
 nonce TEXT NOT NULL,
 ciphertext TEXT NOT NULL,
 authentication_tag TEXT NOT NULL,
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 before_hash TEXT NOT NULL CHECK(length(before_hash)=64),
 after_hash TEXT NOT NULL CHECK(length(after_hash)=64),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 FOREIGN KEY(league_id,season_id) REFERENCES seasons(league_id,id),
 UNIQUE(league_id,id)
) STRICT;
CREATE TABLE league_reset_actions (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 archive_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 actor_authority TEXT NOT NULL CHECK(actor_authority IN ('commissioner','platform_administrator')),
 action_type TEXT NOT NULL CHECK(action_type IN ('reset','restore')),
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 FOREIGN KEY(league_id,archive_id) REFERENCES league_reset_archives(league_id,id),
 UNIQUE(league_id,actor_user_id,client_key),
 UNIQUE(league_id,archive_id,action_type)
) STRICT;
CREATE TRIGGER league_reset_archives_immutable_update BEFORE UPDATE ON league_reset_archives
BEGIN SELECT RAISE(ABORT,'Reset recovery archives are immutable'); END;
CREATE TRIGGER league_reset_archives_immutable_delete BEFORE DELETE ON league_reset_archives
BEGIN SELECT RAISE(ABORT,'Reset recovery archives are retained'); END;
CREATE TRIGGER league_reset_actions_immutable_update BEFORE UPDATE ON league_reset_actions
BEGIN SELECT RAISE(ABORT,'Reset action receipts are immutable'); END;
CREATE TRIGGER league_reset_actions_immutable_delete BEFORE DELETE ON league_reset_actions
BEGIN SELECT RAISE(ABORT,'Reset action receipts are retained'); END;
UPDATE application_metadata SET metadata_value='83',updated_at_ms=max(updated_at_ms,83)
WHERE metadata_key='data_model_version' AND metadata_value='82';
