-- Additive: no existing league records or scheduled operations are changed.
CREATE TABLE league_communications (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('announcement', 'reminder')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 3000),
  audience TEXT NOT NULL CHECK (audience IN ('members', 'managers', 'unfinished_cards', 'pending_invitations')),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
  recipient_count INTEGER NOT NULL CHECK (recipient_count >= 0),
  client_key TEXT NOT NULL CHECK (length(client_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  archived_at_ms INTEGER,
  archived_by_user_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (league_id, created_by_user_id, client_key),
  CHECK ((archived_at_ms IS NULL AND archived_by_user_id IS NULL) OR
    (archived_at_ms >= created_at_ms AND archived_by_user_id IS NOT NULL)),
  CHECK (kind = 'announcement' OR (pinned = 0 AND expires_at_ms IS NULL AND notify = 1)),
  CHECK (kind = 'reminder' OR audience = 'members')
) STRICT;
CREATE INDEX league_communications_visible
  ON league_communications(league_id, kind, archived_at_ms, pinned, created_at_ms);

UPDATE application_metadata
SET metadata_value = '71', updated_at_ms = max(updated_at_ms, 71)
WHERE metadata_key = 'data_model_version' AND metadata_value = '70';
