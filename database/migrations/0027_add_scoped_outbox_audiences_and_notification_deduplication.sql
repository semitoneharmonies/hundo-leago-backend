-- Add explicit league, team, and user audiences for league-scoped realtime
-- outbox events, plus optional notification deduplication keys.
-- This migration creates no FAD, activity, notification, or operational rows.

CREATE TABLE outbox_event_audiences (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  outbox_event_id TEXT NOT NULL,
  audience_kind TEXT NOT NULL
    CHECK (audience_kind IN ('league', 'team', 'user')),
  team_id TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, outbox_event_id)
    REFERENCES outbox_events(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      audience_kind = 'league'
      AND team_id IS NULL
      AND user_id IS NULL
    )
    OR
    (
      audience_kind = 'team'
      AND team_id IS NOT NULL
      AND user_id IS NULL
    )
    OR
    (
      audience_kind = 'user'
      AND team_id IS NULL
      AND user_id IS NOT NULL
    )
  )
) STRICT;

-- Partial indexes are required because SQLite treats NULL values as distinct
-- in an ordinary multi-column unique constraint.
CREATE UNIQUE INDEX outbox_event_audiences_one_league
  ON outbox_event_audiences (league_id, outbox_event_id)
  WHERE audience_kind = 'league';

CREATE UNIQUE INDEX outbox_event_audiences_one_team
  ON outbox_event_audiences (
    league_id,
    outbox_event_id,
    team_id
  )
  WHERE audience_kind = 'team';

CREATE UNIQUE INDEX outbox_event_audiences_one_user
  ON outbox_event_audiences (
    league_id,
    outbox_event_id,
    user_id
  )
  WHERE audience_kind = 'user';

CREATE INDEX outbox_event_audiences_league_event
  ON outbox_event_audiences (league_id, outbox_event_id);

CREATE TRIGGER outbox_event_audiences_user_membership_insert
BEFORE INSERT ON outbox_event_audiences
WHEN NEW.audience_kind = 'user'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.user_id = NEW.user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'user outbox audience requires active league membership'
  ) END;
END;

CREATE TRIGGER outbox_event_audiences_user_membership_update
BEFORE UPDATE OF league_id, audience_kind, user_id
  ON outbox_event_audiences
WHEN NEW.audience_kind = 'user'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.user_id = NEW.user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'user outbox audience requires active league membership'
  ) END;
END;

-- Every existing league-scoped realtime row receives exactly one league
-- audience. Global rows retain their existing audience-free pipeline.
INSERT INTO outbox_event_audiences (
  id,
  league_id,
  outbox_event_id,
  audience_kind,
  team_id,
  user_id,
  created_at_ms
)
SELECT
  outbox_events.id,
  outbox_events.league_id,
  outbox_events.id,
  'league',
  NULL,
  NULL,
  outbox_events.created_at_ms
FROM outbox_events
WHERE outbox_events.league_id IS NOT NULL;

ALTER TABLE notifications
ADD COLUMN deduplication_key TEXT
  CHECK (
    deduplication_key IS NULL
    OR (
      deduplication_key = trim(deduplication_key)
      AND length(deduplication_key) BETWEEN 1 AND 500
    )
  );

CREATE UNIQUE INDEX notifications_user_event_deduplication
  ON notifications (
    user_id,
    event_type,
    deduplication_key
  )
  WHERE deduplication_key IS NOT NULL;

UPDATE application_metadata
SET metadata_value = '27',
    updated_at_ms = CASE
      WHEN updated_at_ms < 27 THEN 27
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version';
