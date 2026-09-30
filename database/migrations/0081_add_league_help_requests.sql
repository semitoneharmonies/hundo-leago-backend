CREATE TABLE league_help_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 team_id TEXT NOT NULL,
 requester_user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('general','auction','roster','trade')),
 target_id TEXT,
 target_label TEXT NOT NULL,
 subject TEXT NOT NULL CHECK(length(subject) BETWEEN 3 AND 120),
 message TEXT NOT NULL CHECK(length(message) BETWEEN 3 AND 2000),
 status TEXT NOT NULL CHECK(status IN ('open','resolved','withdrawn')),
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 UNIQUE(league_id,id),
 UNIQUE(league_id,requester_user_id,client_key),
 FOREIGN KEY(league_id,team_id) REFERENCES teams(league_id,id),
 CHECK((kind='general' AND target_id IS NULL) OR (kind<>'general' AND target_id IS NOT NULL AND length(target_id)=36))
) STRICT;
CREATE INDEX league_help_requests_queue ON league_help_requests(league_id,status,created_at_ms DESC,id);
CREATE INDEX league_help_requests_requester ON league_help_requests(league_id,requester_user_id,created_at_ms DESC,id);
CREATE TABLE league_help_events (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 request_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL CHECK(action IN ('reply','resolve','withdraw','reopen')),
 message TEXT NOT NULL CHECK(length(message) BETWEEN 3 AND 2000),
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 previous_version INTEGER NOT NULL CHECK(previous_version>=1),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 UNIQUE(league_id,actor_user_id,client_key),
 UNIQUE(request_id,previous_version),
 FOREIGN KEY(league_id,request_id) REFERENCES league_help_requests(league_id,id)
) STRICT;
CREATE INDEX league_help_events_request ON league_help_events(league_id,request_id,previous_version);
CREATE TRIGGER league_help_requests_preserve_submission BEFORE UPDATE ON league_help_requests
WHEN NEW.id IS NOT OLD.id OR NEW.league_id IS NOT OLD.league_id OR NEW.team_id IS NOT OLD.team_id OR NEW.requester_user_id IS NOT OLD.requester_user_id
 OR NEW.kind IS NOT OLD.kind OR NEW.target_id IS NOT OLD.target_id OR NEW.target_label IS NOT OLD.target_label OR NEW.subject IS NOT OLD.subject
 OR NEW.message IS NOT OLD.message OR NEW.client_key IS NOT OLD.client_key OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at_ms IS NOT OLD.created_at_ms
 OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM league_help_events e WHERE e.league_id=OLD.league_id AND e.request_id=OLD.id AND e.previous_version=OLD.version
   AND e.created_at_ms=NEW.updated_at_ms AND NEW.status=CASE e.action WHEN 'resolve' THEN 'resolved' WHEN 'withdraw' THEN 'withdrawn' WHEN 'reopen' THEN 'open' ELSE OLD.status END)
BEGIN SELECT RAISE(ABORT,'Help requests retain their submitted record and require an event'); END;
CREATE TRIGGER league_help_requests_immutable_delete BEFORE DELETE ON league_help_requests
BEGIN SELECT RAISE(ABORT,'Help request history is retained'); END;
CREATE TRIGGER league_help_events_immutable_update BEFORE UPDATE ON league_help_events
BEGIN SELECT RAISE(ABORT,'Help events are immutable'); END;
CREATE TRIGGER league_help_events_immutable_delete BEFORE DELETE ON league_help_events
BEGIN SELECT RAISE(ABORT,'Help events are immutable'); END;
UPDATE application_metadata SET metadata_value='81',updated_at_ms=max(updated_at_ms,81)
WHERE metadata_key='data_model_version' AND metadata_value='80';
