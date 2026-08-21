-- Fail closed when legacy data contains more than one active commissioner.
-- The temporary guard is deliberately data-neutral: operators must use the
-- read-only M7-26 preview, take a backup, and explicitly reconcile each dirty
-- league before retrying this migration.

CREATE TABLE migration_0054_commissioner_preflight (
  duplicate_league_count INTEGER NOT NULL
    CHECK (duplicate_league_count = 0),
  missing_administrator_membership_count INTEGER NOT NULL
    CHECK (missing_administrator_membership_count = 0),
  noncanonical_administrator_membership_count INTEGER NOT NULL
    CHECK (noncanonical_administrator_membership_count = 0)
) STRICT;

INSERT INTO migration_0054_commissioner_preflight (
  duplicate_league_count,
  missing_administrator_membership_count,
  noncanonical_administrator_membership_count
)
SELECT
  (
    SELECT COUNT(*)
    FROM (
      SELECT league_id
      FROM league_memberships
      WHERE permission_category = 'commissioner'
        AND status = 'active'
      GROUP BY league_id
      HAVING COUNT(*) > 1
    )
  ),
  (
    SELECT COUNT(*)
    FROM platform_roles
    CROSS JOIN leagues
    WHERE platform_roles.role = 'platform_administrator'
      AND platform_roles.status = 'active'
      AND platform_roles.ended_at_ms IS NULL
      AND leagues.status <> 'deleted'
      AND NOT EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = leagues.id
          AND league_memberships.user_id = platform_roles.user_id
          AND league_memberships.status = 'active'
      )
  ),
  (
    SELECT COUNT(*)
    FROM league_memberships
    JOIN platform_roles
      ON platform_roles.user_id = league_memberships.user_id
     AND platform_roles.role = 'platform_administrator'
     AND platform_roles.status = 'active'
     AND platform_roles.ended_at_ms IS NULL
    JOIN leagues ON leagues.id = league_memberships.league_id
    WHERE leagues.status <> 'deleted'
      AND league_memberships.status = 'active'
      AND league_memberships.permission_category <> 'member'
  );

DROP TABLE migration_0054_commissioner_preflight;

CREATE UNIQUE INDEX league_memberships_one_active_commissioner
  ON league_memberships (league_id)
  WHERE permission_category = 'commissioner'
    AND status = 'active';

UPDATE application_metadata
SET metadata_value = '54',
    updated_at_ms = CASE
      WHEN updated_at_ms < 54 THEN 54
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '53';
