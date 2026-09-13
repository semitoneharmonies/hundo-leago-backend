-- Add the shared lifecycle evidence required before Free Agent Draft setup.
-- This migration does not create lifecycle transitions, exemptions, or FADs.

CREATE UNIQUE INDEX seasons_one_nhl_key_per_league
  ON seasons (league_id, nhl_season_key);

CREATE TABLE season_rollovers (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  from_season_id TEXT NOT NULL,
  to_season_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'succeeded'),
  authorized_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  authorized_by_membership_id TEXT NOT NULL,
  authorized_authority TEXT NOT NULL
    CHECK (
      authorized_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  league_version_before INTEGER NOT NULL
    CHECK (league_version_before >= 1),
  league_version_after INTEGER NOT NULL
    CHECK (league_version_after = league_version_before + 1),
  from_season_version_before INTEGER NOT NULL
    CHECK (from_season_version_before >= 1),
  from_season_version_after INTEGER NOT NULL
    CHECK (
      from_season_version_after =
        from_season_version_before + 1
    ),
  to_season_version_before INTEGER
    CHECK (
      to_season_version_before IS NULL
      OR to_season_version_before >= 1
    ),
  to_season_version_after INTEGER NOT NULL
    CHECK (to_season_version_after >= 1),
  target_season_created INTEGER NOT NULL
    CHECK (target_season_created IN (0, 1)),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  contracts_advanced INTEGER NOT NULL
    CHECK (contracts_advanced >= 0),
  contracts_expired INTEGER NOT NULL
    CHECK (contracts_expired >= 0),
  ownerships_carried INTEGER NOT NULL
    CHECK (ownerships_carried >= 0),
  ownerships_released INTEGER NOT NULL
    CHECK (ownerships_released >= 0),
  retention_years_advanced INTEGER NOT NULL
    CHECK (retention_years_advanced >= 0),
  retention_obligations_completed INTEGER NOT NULL
    CHECK (retention_obligations_completed >= 0),
  buyout_years_advanced INTEGER NOT NULL
    CHECK (buyout_years_advanced >= 0),
  buyout_obligations_completed INTEGER NOT NULL
    CHECK (buyout_obligations_completed >= 0),
  trades_cancelled INTEGER NOT NULL
    CHECK (trades_cancelled >= 0),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= completed_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, from_season_id),
  UNIQUE (league_id, to_season_id),
  FOREIGN KEY (league_id, from_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, authorized_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (from_season_id <> to_season_id),
  CHECK (
    (
      target_season_created = 1
      AND to_season_version_before IS NULL
      AND to_season_version_after = 1
    )
    OR
    (
      target_season_created = 0
      AND to_season_version_before IS NOT NULL
      AND to_season_version_after =
        to_season_version_before + 1
    )
  )
) STRICT;

CREATE INDEX season_rollovers_league_completed
  ON season_rollovers (league_id, completed_at_ms DESC);

CREATE TRIGGER season_rollovers_committed_state_insert
BEFORE INSERT ON season_rollovers
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM seasons
    WHERE seasons.league_id = NEW.league_id
      AND seasons.id = NEW.from_season_id
      AND seasons.status = 'completed'
      AND seasons.version = NEW.from_season_version_after
  ) THEN RAISE(
    ABORT,
    'season rollover source must be the completed version'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM seasons
    WHERE seasons.league_id = NEW.league_id
      AND seasons.id = NEW.to_season_id
      AND seasons.status = 'active'
      AND seasons.version = NEW.to_season_version_after
  ) THEN RAISE(
    ABORT,
    'season rollover target must be the active version'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    WHERE leagues.id = NEW.league_id
      AND leagues.current_season_id = NEW.to_season_id
      AND leagues.version = NEW.league_version_after
  ) THEN RAISE(
    ABORT,
    'season rollover target must be the current league season'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id =
        NEW.authorized_by_membership_id
      AND league_memberships.user_id =
        NEW.authorized_by_user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'season rollover actor must have active league membership'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.authorized_authority = 'commissioner'
      AND EXISTS (
        SELECT 1
        FROM leagues
        WHERE leagues.id = NEW.league_id
          AND leagues.commissioner_membership_id =
            NEW.authorized_by_membership_id
      )
    )
    OR
    (
      NEW.authorized_authority =
        'platform_administrator_as_commissioner'
      AND EXISTS (
        SELECT 1
        FROM platform_roles
        WHERE platform_roles.user_id =
            NEW.authorized_by_user_id
          AND platform_roles.role = 'platform_administrator'
          AND platform_roles.status = 'active'
      )
    )
  ) THEN RAISE(
    ABORT,
    'season rollover actor lacks recorded authority'
  ) END;
END;

CREATE TRIGGER season_rollovers_immutable_update
BEFORE UPDATE ON season_rollovers
BEGIN
  SELECT RAISE(
    ABORT,
    'season rollover evidence is immutable'
  );
END;

CREATE TRIGGER season_rollovers_immutable_delete
BEFORE DELETE ON season_rollovers
BEGIN
  SELECT RAISE(
    ABORT,
    'season rollover evidence is immutable'
  );
END;

CREATE TABLE free_agent_draft_setup_exemptions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  exemption_kind TEXT NOT NULL
    CHECK (exemption_kind = 'initial_season2_transition'),
  migration_report_id TEXT NOT NULL,
  reason TEXT NOT NULL
    CHECK (
      reason = trim(reason)
      AND length(reason) BETWEEN 1 AND 500
    ),
  authorized_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  authorized_by_membership_id TEXT NOT NULL,
  authorized_authority TEXT NOT NULL
    CHECK (
      authorized_authority =
        'platform_administrator_as_commissioner'
    ),
  authorized_at_ms INTEGER NOT NULL CHECK (authorized_at_ms >= 0),
  consumed_fad_id TEXT
    CHECK (
      consumed_fad_id IS NULL
      OR (
        length(consumed_fad_id) = 36
        AND consumed_fad_id = lower(consumed_fad_id)
      )
    ),
  consumed_at_ms INTEGER
    CHECK (
      consumed_at_ms IS NULL
      OR consumed_at_ms >= authorized_at_ms
    ),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= authorized_at_ms),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id),
  UNIQUE (league_id, migration_report_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, migration_report_id)
    REFERENCES migration_reports(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, authorized_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      consumed_fad_id IS NULL
      AND consumed_at_ms IS NULL
    )
    OR
    (
      consumed_fad_id IS NOT NULL
      AND consumed_at_ms IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_setup_exemptions_league_time
  ON free_agent_draft_setup_exemptions (
    league_id,
    authorized_at_ms DESC
  );

CREATE INDEX migration_reports_fad_reset_evidence_lookup
  ON migration_reports (
    league_id,
    reset_manifest_id,
    status,
    completed_at_ms
  );

CREATE TRIGGER free_agent_draft_setup_exemptions_authority_insert
BEFORE INSERT ON free_agent_draft_setup_exemptions
BEGIN
  SELECT CASE WHEN
    NEW.consumed_fad_id IS NOT NULL
    OR NEW.consumed_at_ms IS NOT NULL
  THEN RAISE(
    ABORT,
    'FAD setup exemption must begin unconsumed'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id =
        NEW.authorized_by_membership_id
      AND league_memberships.user_id =
        NEW.authorized_by_user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption actor must have active league membership'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM platform_roles
    WHERE platform_roles.user_id =
        NEW.authorized_by_user_id
      AND platform_roles.role = 'platform_administrator'
      AND platform_roles.status = 'active'
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption actor must be a platform administrator'
  ) END;
END;

-- The same-league consumed FAD relationship is added in migration 0024,
-- after the free_agent_drafts parent table exists.
CREATE TRIGGER free_agent_draft_setup_exemptions_consume_update
BEFORE UPDATE ON free_agent_draft_setup_exemptions
BEGIN
  SELECT CASE WHEN NOT (
    OLD.consumed_fad_id IS NULL
    AND OLD.consumed_at_ms IS NULL
    AND NEW.consumed_fad_id IS NOT NULL
    AND NEW.consumed_at_ms IS NOT NULL
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.exemption_kind IS OLD.exemption_kind
    AND NEW.migration_report_id IS OLD.migration_report_id
    AND NEW.reason IS OLD.reason
    AND NEW.authorized_by_user_id IS OLD.authorized_by_user_id
    AND NEW.authorized_by_membership_id IS
      OLD.authorized_by_membership_id
    AND NEW.authorized_authority IS OLD.authorized_authority
    AND NEW.authorized_at_ms IS OLD.authorized_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.updated_at_ms >= NEW.consumed_at_ms
    AND NEW.consumed_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption may only be consumed once'
  ) END;
END;

CREATE TRIGGER free_agent_draft_setup_exemptions_immutable_delete
BEFORE DELETE ON free_agent_draft_setup_exemptions
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD setup exemption evidence is immutable'
  );
END;

CREATE TRIGGER free_agent_draft_setup_exemptions_consumed_fad_shape
BEFORE UPDATE OF consumed_fad_id, consumed_at_ms
  ON free_agent_draft_setup_exemptions
WHEN NEW.consumed_fad_id IS NULL
  OR NEW.consumed_at_ms IS NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD setup exemption consumption requires both fields'
  );
END;

UPDATE application_metadata
SET metadata_value = '23',
    updated_at_ms =
      CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
