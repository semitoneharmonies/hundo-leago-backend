-- Deliberate private access is recorded without copying bid or card contents.
CREATE TABLE league_private_reveals (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 auction_id TEXT NOT NULL,
 bid_id TEXT,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 UNIQUE(league_id,actor_user_id,client_key),
 FOREIGN KEY(league_id,auction_id) REFERENCES auctions(league_id,id),
 FOREIGN KEY(league_id,bid_id) REFERENCES auction_bids(league_id,id)
) STRICT;
CREATE INDEX league_private_reveals_scope ON league_private_reveals(league_id,auction_id,created_at_ms);
CREATE TRIGGER league_private_reveals_immutable_update BEFORE UPDATE ON league_private_reveals
BEGIN SELECT RAISE(ABORT,'Private access history is immutable'); END;
CREATE TRIGGER league_private_reveals_immutable_delete BEFORE DELETE ON league_private_reveals
BEGIN SELECT RAISE(ABORT,'Private access history is immutable'); END;
UPDATE application_metadata SET metadata_value='75',updated_at_ms=max(updated_at_ms,75)
WHERE metadata_key='data_model_version' AND metadata_value='74';
