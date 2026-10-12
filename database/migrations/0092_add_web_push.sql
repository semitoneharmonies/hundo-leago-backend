ALTER TABLE league_communications ADD COLUMN push_notify INTEGER NOT NULL DEFAULT 0 CHECK(push_notify IN(0,1));
CREATE TABLE push_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)),
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  endpoint TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL CHECK(json_valid(subscription_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE push_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  team_id TEXT,
  commissioner_only INTEGER NOT NULL DEFAULT 0 CHECK(commissioner_only IN(0,1)),
  category TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  guard_json TEXT NOT NULL CHECK(json_valid(guard_json)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','sent','suppressed','failed')),
  UNIQUE(subscription_id,event_key)
) STRICT;
CREATE INDEX push_deliveries_due ON push_deliveries(status,next_attempt_at_ms);
CREATE INDEX push_deliveries_league ON push_deliveries(league_id);
CREATE TABLE push_event_cursors (source TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL) STRICT;
-- Explicit migration boundary: installing push never replays historical events.
INSERT INTO push_event_cursors VALUES('notifications',(SELECT COALESCE(MAX(rowid),0) FROM notifications));
INSERT INTO push_event_cursors VALUES('trade_events',(SELECT COALESCE(MAX(rowid),0) FROM trade_events));
INSERT INTO push_event_cursors VALUES('auction_events',(SELECT COALESCE(MAX(rowid),0) FROM auction_events));
CREATE TABLE push_roster_state (
  league_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  week_id TEXT NOT NULL,
  last_reason TEXT NOT NULL,
  last_sent_at_ms INTEGER NOT NULL,
  PRIMARY KEY(league_id,team_id,week_id)
) STRICT;
UPDATE application_metadata
SET metadata_value = '92', updated_at_ms = max(updated_at_ms, 92)
WHERE metadata_key = 'data_model_version' AND metadata_value = '91';
