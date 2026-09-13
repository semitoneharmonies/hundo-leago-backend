-- hundo-leago: foreign-key-rebuild
-- Add qualifying, exact, immutable regular-season standings finalization
-- evidence. Existing standings snapshots are deliberately not backfilled:
-- legacy final rows have no exact result-version provenance and therefore do
-- not qualify for season rollover.

CREATE TABLE standings_operations_m7_01 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  standings_snapshot_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT,
  actor_authority TEXT
    CHECK (
      actor_authority IS NULL
      OR actor_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  operation_type TEXT NOT NULL
    CHECK (
      operation_type IN (
        'calculate',
        'rebuild',
        'correction_propagation',
        'finalize_regular_season'
      )
    ),
  status TEXT NOT NULL
    CHECK (status IN ('started', 'succeeded', 'failed')),
  reason TEXT,
  metadata_json TEXT,
  idempotency_request_id TEXT,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms INTEGER
    CHECK (
      completed_at_ms IS NULL
      OR completed_at_ms >= started_at_ms
    ),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  CHECK (
    operation_type <> 'finalize_regular_season'
    OR (
      status = 'succeeded'
      AND standings_snapshot_id IS NOT NULL
      AND actor_user_id IS NOT NULL
      AND actor_membership_id IS NOT NULL
      AND actor_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
      AND idempotency_request_id IS NOT NULL
      AND completed_at_ms IS NOT NULL
    )
  )
) STRICT;

INSERT INTO standings_operations_m7_01 (
  id,
  league_id,
  season_id,
  standings_snapshot_id,
  actor_user_id,
  actor_membership_id,
  actor_authority,
  operation_type,
  status,
  reason,
  metadata_json,
  idempotency_request_id,
  started_at_ms,
  completed_at_ms
)
SELECT
  id,
  league_id,
  season_id,
  standings_snapshot_id,
  actor_user_id,
  NULL,
  NULL,
  operation_type,
  status,
  reason,
  NULL,
  NULL,
  started_at_ms,
  completed_at_ms
FROM standings_operations;

DROP TABLE standings_operations;
ALTER TABLE standings_operations_m7_01 RENAME TO standings_operations;

CREATE INDEX standings_operations_league_time
  ON standings_operations (league_id, started_at_ms DESC);

CREATE TABLE standings_snapshot_result_versions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  standings_snapshot_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  matchup_id TEXT NOT NULL,
  matchup_result_id TEXT NOT NULL,
  matchup_result_version_id TEXT NOT NULL,
  result_version_number INTEGER NOT NULL
    CHECK (result_version_number >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (standings_snapshot_id, matchup_id),
  UNIQUE (standings_snapshot_id, matchup_result_id),
  UNIQUE (standings_snapshot_id, matchup_result_version_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_id)
    REFERENCES matchups(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_result_id)
    REFERENCES matchup_results(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_result_version_id)
    REFERENCES matchup_result_versions(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX standings_snapshot_result_versions_league_snapshot
  ON standings_snapshot_result_versions (
    league_id,
    season_id,
    standings_snapshot_id
  );

CREATE INDEX standings_snapshot_result_versions_league_result
  ON standings_snapshot_result_versions (
    league_id,
    matchup_result_id
  );

CREATE INDEX standings_snapshot_result_versions_league_version
  ON standings_snapshot_result_versions (
    league_id,
    matchup_result_version_id
  );

CREATE TABLE standings_snapshot_team_identities (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  standings_snapshot_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_display_name TEXT NOT NULL
    CHECK (
      team_display_name = trim(team_display_name)
      AND length(team_display_name) BETWEEN 1 AND 120
    ),
  primary_colour TEXT NOT NULL
    CHECK (
      length(primary_colour) = 7
      AND primary_colour = lower(primary_colour)
      AND primary_colour
        GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  secondary_colour TEXT NOT NULL
    CHECK (
      length(secondary_colour) = 7
      AND secondary_colour = lower(secondary_colour)
      AND secondary_colour
        GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  tertiary_colour TEXT
    CHECK (
      tertiary_colour IS NULL
      OR (
        length(tertiary_colour) = 7
        AND tertiary_colour = lower(tertiary_colour)
        AND tertiary_colour
          GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  pattern_template TEXT NOT NULL
    CHECK (
      pattern_template IN (
        'even-two',
        'even-three',
        'wide-centre-stripe',
        'thin-centre-stripe',
        'triple-pinstripe',
        'double-accent-bands',
        'angular-peak',
        'mirrored-centre-band',
        'offset-outlined-stack',
        'layered-six-band',
        'alternating-ladder',
        'double-hairline',
        'double-light-top-accent',
        'layered-monochrome',
        'split-colour-block',
        'two-tone-stack',
        'outlined-block',
        'layered-contrast',
        'mirrored-seven-band',
        'accent-line-band',
        'outlined-centre',
        'two-stage-contrast',
        'layered-double-light',
        'tiger',
        'leopard',
        'cowhide',
        'camouflage',
        'snake-scales',
        'honeycomb',
        'checkerboard',
        'argyle',
        'chevrons',
        'ocean-waves',
        'two-colour-gradient',
        'three-colour-gradient'
      )
    ),
  source_logo_object_id TEXT
    CHECK (
      source_logo_object_id IS NULL
      OR (
        length(source_logo_object_id) = 36
        AND source_logo_object_id = lower(source_logo_object_id)
      )
    ),
  logo_media_type TEXT
    CHECK (
      logo_media_type IS NULL
      OR logo_media_type IN ('image/png', 'image/jpeg', 'image/webp')
    ),
  logo_byte_length INTEGER
    CHECK (
      logo_byte_length IS NULL
      OR logo_byte_length BETWEEN 1 AND 524288
    ),
  logo_width INTEGER
    CHECK (logo_width IS NULL OR logo_width BETWEEN 1 AND 2048),
  logo_height INTEGER
    CHECK (logo_height IS NULL OR logo_height BETWEEN 1 AND 2048),
  logo_content_sha256 TEXT
    CHECK (
      logo_content_sha256 IS NULL
      OR (
        length(logo_content_sha256) = 64
        AND logo_content_sha256 = lower(logo_content_sha256)
        AND logo_content_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  logo_content_bytes BLOB
    CHECK (
      logo_content_bytes IS NULL
      OR typeof(logo_content_bytes) = 'blob'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (standings_snapshot_id, team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      pattern_template IN (
        'even-two',
        'wide-centre-stripe',
        'thin-centre-stripe',
        'triple-pinstripe',
        'double-accent-bands',
        'angular-peak',
        'tiger',
        'cowhide',
        'honeycomb',
        'checkerboard',
        'two-colour-gradient'
      )
      AND tertiary_colour IS NULL
    )
    OR
    (
      pattern_template IN (
        'even-three',
        'mirrored-centre-band',
        'offset-outlined-stack',
        'layered-six-band',
        'alternating-ladder',
        'double-hairline',
        'double-light-top-accent',
        'layered-monochrome',
        'split-colour-block',
        'two-tone-stack',
        'outlined-block',
        'layered-contrast',
        'mirrored-seven-band',
        'accent-line-band',
        'outlined-centre',
        'two-stage-contrast',
        'layered-double-light',
        'leopard',
        'camouflage',
        'snake-scales',
        'argyle',
        'chevrons',
        'ocean-waves',
        'three-colour-gradient'
      )
      AND tertiary_colour IS NOT NULL
    )
  ),
  CHECK (
    (
      source_logo_object_id IS NULL
      AND logo_media_type IS NULL
      AND logo_byte_length IS NULL
      AND logo_width IS NULL
      AND logo_height IS NULL
      AND logo_content_sha256 IS NULL
      AND logo_content_bytes IS NULL
    )
    OR
    (
      source_logo_object_id IS NOT NULL
      AND logo_media_type IS NOT NULL
      AND logo_byte_length IS NOT NULL
      AND logo_width IS NOT NULL
      AND logo_height IS NOT NULL
      AND logo_content_sha256 IS NOT NULL
      AND logo_content_bytes IS NOT NULL
      AND length(logo_content_bytes) = logo_byte_length
    )
  )
) STRICT;

CREATE INDEX standings_snapshot_team_identities_league_snapshot
  ON standings_snapshot_team_identities (
    league_id,
    season_id,
    standings_snapshot_id
  );

CREATE TABLE standings_snapshot_finalizations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  standings_snapshot_id TEXT NOT NULL,
  finalization_version INTEGER NOT NULL
    CHECK (finalization_version >= 1),
  evidence_schema_version INTEGER NOT NULL
    CHECK (evidence_schema_version = 1),
  status TEXT NOT NULL
    CHECK (status IN ('final', 'superseded')),
  cause TEXT NOT NULL
    CHECK (
      cause IN (
        'regular_season_completion',
        'result_correction'
      )
    ),
  standings_rule_version INTEGER NOT NULL
    CHECK (standings_rule_version >= 1),
  result_set_hash TEXT NOT NULL
    CHECK (
      length(result_set_hash) = 64
      AND result_set_hash = lower(result_set_hash)
      AND result_set_hash NOT GLOB '*[^0-9a-f]*'
    ),
  result_set_hash_version INTEGER NOT NULL
    CHECK (result_set_hash_version = 1),
  expected_matchup_count INTEGER NOT NULL
    CHECK (expected_matchup_count >= 1),
  finalized_matchup_count INTEGER NOT NULL
    CHECK (finalized_matchup_count = expected_matchup_count),
  expected_week_count INTEGER NOT NULL
    CHECK (expected_week_count >= 1),
  weeks_counted INTEGER NOT NULL
    CHECK (weeks_counted = expected_week_count),
  participant_count INTEGER NOT NULL
    CHECK (participant_count >= 2),
  standings_row_count INTEGER NOT NULL
    CHECK (standings_row_count = participant_count),
  completeness_status TEXT NOT NULL
    CHECK (completeness_status = 'complete'),
  season_version_before INTEGER NOT NULL
    CHECK (season_version_before >= 1),
  season_version_after INTEGER NOT NULL
    CHECK (season_version_after = season_version_before + 1),
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
  standings_operation_id TEXT NOT NULL,
  idempotency_request_id TEXT NOT NULL,
  replaces_finalization_id TEXT,
  superseded_by_snapshot_id TEXT,
  superseded_by_user_id TEXT
    REFERENCES users(id) ON DELETE RESTRICT,
  superseded_by_membership_id TEXT,
  superseded_by_authority TEXT
    CHECK (
      superseded_by_authority IS NULL
      OR superseded_by_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  superseded_by_operation_id TEXT,
  superseded_at_ms INTEGER
    CHECK (
      superseded_at_ms IS NULL
      OR superseded_at_ms >= finalized_at_ms
    ),
  finalized_at_ms INTEGER NOT NULL CHECK (finalized_at_ms >= 0),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= finalized_at_ms),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, standings_snapshot_id),
  UNIQUE (league_id, season_id, finalization_version),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, authorized_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_operation_id)
    REFERENCES standings_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, replaces_finalization_id)
    REFERENCES standings_snapshot_finalizations(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, superseded_by_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, superseded_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, superseded_by_operation_id)
    REFERENCES standings_operations(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      cause = 'regular_season_completion'
      AND replaces_finalization_id IS NULL
    )
    OR
    (
      cause = 'result_correction'
      AND replaces_finalization_id IS NOT NULL
    )
  ),
  CHECK (
    (
      status = 'final'
      AND superseded_by_snapshot_id IS NULL
      AND superseded_by_user_id IS NULL
      AND superseded_by_membership_id IS NULL
      AND superseded_by_authority IS NULL
      AND superseded_by_operation_id IS NULL
      AND superseded_at_ms IS NULL
    )
    OR
    (
      status = 'superseded'
      AND superseded_by_snapshot_id IS NOT NULL
      AND superseded_by_user_id IS NOT NULL
      AND superseded_by_membership_id IS NOT NULL
      AND superseded_by_authority IS NOT NULL
      AND superseded_by_operation_id IS NOT NULL
      AND superseded_at_ms IS NOT NULL
    )
  ),
  CHECK (
    replaces_finalization_id IS NULL
    OR replaces_finalization_id <> id
  )
) STRICT;

CREATE UNIQUE INDEX standings_snapshot_finalizations_one_final
  ON standings_snapshot_finalizations (league_id, season_id)
  WHERE status = 'final';

CREATE UNIQUE INDEX standings_snapshot_finalizations_one_replacement
  ON standings_snapshot_finalizations (
    league_id,
    replaces_finalization_id
  )
  WHERE replaces_finalization_id IS NOT NULL;

CREATE UNIQUE INDEX standings_snapshot_finalizations_one_supersession_target
  ON standings_snapshot_finalizations (
    league_id,
    superseded_by_snapshot_id
  )
  WHERE superseded_by_snapshot_id IS NOT NULL;

CREATE INDEX standings_snapshot_finalizations_league_time
  ON standings_snapshot_finalizations (
    league_id,
    season_id,
    finalized_at_ms DESC
  );

CREATE TRIGGER standings_snapshot_result_versions_consistency_insert
BEFORE INSERT ON standings_snapshot_result_versions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM standings_snapshots
    WHERE standings_snapshots.league_id = NEW.league_id
      AND standings_snapshots.season_id = NEW.season_id
      AND standings_snapshots.id = NEW.standings_snapshot_id
      AND standings_snapshots.status = 'final'
  ) THEN RAISE(
    ABORT,
    'standings result-version link requires a staged final snapshot'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_finalizations
    WHERE standings_snapshot_finalizations.league_id = NEW.league_id
      AND standings_snapshot_finalizations.season_id = NEW.season_id
      AND standings_snapshot_finalizations.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) THEN RAISE(
    ABORT,
    'final standings result-version links are immutable'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM seasons
    JOIN matchup_weeks
      ON matchup_weeks.league_id = seasons.league_id
     AND matchup_weeks.season_id = seasons.id
    JOIN matchups
      ON matchups.league_id = matchup_weeks.league_id
     AND matchups.season_id = matchup_weeks.season_id
     AND matchups.matchup_week_id = matchup_weeks.id
    JOIN matchup_results
      ON matchup_results.league_id = matchups.league_id
     AND matchup_results.season_id = matchups.season_id
     AND matchup_results.matchup_id = matchups.id
    JOIN matchup_result_versions
      ON matchup_result_versions.league_id = matchup_results.league_id
     AND matchup_result_versions.season_id = matchup_results.season_id
     AND matchup_result_versions.matchup_result_id = matchup_results.id
    WHERE seasons.league_id = NEW.league_id
      AND seasons.id = NEW.season_id
      AND matchup_weeks.id = NEW.matchup_week_id
      AND matchups.id = NEW.matchup_id
      AND matchup_results.id = NEW.matchup_result_id
      AND matchup_result_versions.id =
        NEW.matchup_result_version_id
      AND matchup_result_versions.version_number =
        NEW.result_version_number
      AND matchup_weeks.status = 'final'
      AND matchups.status = 'final'
      AND matchup_results.status IN ('official', 'corrected')
      AND matchup_result_versions.home_team_id =
        matchups.home_team_id
      AND matchup_result_versions.away_team_id =
        matchups.away_team_id
      AND (
        (
          matchup_result_versions.outcome = 'home_win'
          AND matchup_result_versions.home_score_hundredths >
            matchup_result_versions.away_score_hundredths
        )
        OR
        (
          matchup_result_versions.outcome = 'away_win'
          AND matchup_result_versions.away_score_hundredths >
            matchup_result_versions.home_score_hundredths
        )
        OR
        (
          matchup_result_versions.outcome = 'tie'
          AND matchup_result_versions.home_score_hundredths =
            matchup_result_versions.away_score_hundredths
        )
      )
      AND seasons.regular_season_starts_at_ms IS NOT NULL
      AND seasons.fantasy_playoffs_start_at_ms IS NOT NULL
      AND matchup_weeks.starts_at_ms >=
        seasons.regular_season_starts_at_ms
      AND matchup_weeks.rolls_over_at_ms <=
        seasons.fantasy_playoffs_start_at_ms
  ) THEN RAISE(
    ABORT,
    'standings result-version link is not exact regular-season evidence'
  ) END;
END;

CREATE TRIGGER standings_snapshot_result_versions_immutable_update
BEFORE UPDATE ON standings_snapshot_result_versions
BEGIN
  SELECT RAISE(
    ABORT,
    'standings result-version links are immutable'
  );
END;

CREATE TRIGGER standings_snapshot_result_versions_immutable_delete
BEFORE DELETE ON standings_snapshot_result_versions
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      OLD.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'final standings result-version links cannot be deleted'
  );
END;

CREATE TRIGGER standings_snapshot_team_identities_consistency_insert
BEFORE INSERT ON standings_snapshot_team_identities
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM standings_snapshots
    WHERE standings_snapshots.league_id = NEW.league_id
      AND standings_snapshots.season_id = NEW.season_id
      AND standings_snapshots.id = NEW.standings_snapshot_id
      AND standings_snapshots.status = 'final'
  ) THEN RAISE(
    ABORT,
    'standings team identity requires a staged final snapshot'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_finalizations
    WHERE standings_snapshot_finalizations.league_id = NEW.league_id
      AND standings_snapshot_finalizations.season_id = NEW.season_id
      AND standings_snapshot_finalizations.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) THEN RAISE(
    ABORT,
    'final standings team identities are immutable'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM teams
    WHERE teams.league_id = NEW.league_id
      AND teams.id = NEW.team_id
  ) OR NOT (
    EXISTS (
      SELECT 1
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
        AND NEW.team_id IN (
          matchups.home_team_id,
          matchups.away_team_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
        AND matchup_byes.team_id = NEW.team_id
    )
  ) THEN RAISE(
    ABORT,
    'standings team identity requires an exact season participant'
  ) END;
END;

CREATE TRIGGER standings_snapshot_team_identities_immutable_update
BEFORE UPDATE ON standings_snapshot_team_identities
BEGIN
  SELECT RAISE(
    ABORT,
    'standings team identities are immutable'
  );
END;

CREATE TRIGGER standings_snapshot_team_identities_immutable_delete
BEFORE DELETE ON standings_snapshot_team_identities
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      OLD.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'final standings team identities cannot be deleted'
  );
END;

CREATE TRIGGER standings_snapshot_finalizations_evidence_insert
BEFORE INSERT ON standings_snapshot_finalizations
BEGIN
  SELECT CASE WHEN NEW.status <> 'final' THEN RAISE(
    ABORT,
    'standings finalization evidence must begin final'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN league_settings
      ON league_settings.league_id = leagues.id
    JOIN seasons
      ON seasons.league_id = leagues.id
    WHERE leagues.id = NEW.league_id
      AND leagues.status IN ('active', 'frozen')
      AND seasons.id = NEW.season_id
      AND seasons.version = NEW.season_version_before
      AND (
        (
          NEW.cause = 'regular_season_completion'
          AND leagues.current_season_id = NEW.season_id
          AND seasons.status = 'active'
          AND league_settings.standings_rule_version =
            NEW.standings_rule_version
        )
        OR
        (
          NEW.cause = 'result_correction'
          AND (
            (
              leagues.current_season_id = NEW.season_id
              AND seasons.status = 'active'
            )
            OR
            (
              leagues.current_season_id <> NEW.season_id
              AND seasons.status = 'completed'
            )
          )
          AND EXISTS (
            SELECT 1
            FROM standings_snapshot_finalizations AS replaced
            WHERE replaced.league_id = NEW.league_id
              AND replaced.season_id = NEW.season_id
              AND replaced.id =
                NEW.replaces_finalization_id
              AND replaced.status = 'superseded'
              AND replaced.standings_rule_version =
                NEW.standings_rule_version
              AND replaced.expected_matchup_count =
                NEW.expected_matchup_count
              AND replaced.finalized_matchup_count =
                NEW.finalized_matchup_count
              AND replaced.expected_week_count =
                NEW.expected_week_count
              AND replaced.weeks_counted =
                NEW.weeks_counted
              AND replaced.participant_count =
                NEW.participant_count
              AND replaced.standings_row_count =
                NEW.standings_row_count
              AND replaced.finalization_version <
                NEW.finalization_version
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization requires the exact eligible season version'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM standings_snapshots
    WHERE standings_snapshots.league_id = NEW.league_id
      AND standings_snapshots.season_id = NEW.season_id
      AND standings_snapshots.id = NEW.standings_snapshot_id
      AND standings_snapshots.snapshot_version =
        NEW.finalization_version
      AND standings_snapshots.status = 'final'
      AND standings_snapshots.calculated_at_ms =
        NEW.finalized_at_ms
      AND standings_snapshots.created_at_ms <= NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'standings finalization snapshot evidence is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshots
    WHERE standings_snapshots.league_id = NEW.league_id
      AND standings_snapshots.season_id = NEW.season_id
      AND standings_snapshots.status = 'current'
  ) THEN RAISE(
    ABORT,
    'current standings must be superseded before finalization'
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
    'standings finalization actor must have active membership'
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
    'standings finalization actor lacks recorded authority'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM standings_operations
    WHERE standings_operations.league_id = NEW.league_id
      AND standings_operations.season_id = NEW.season_id
      AND standings_operations.id = NEW.standings_operation_id
      AND standings_operations.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND standings_operations.actor_user_id =
        NEW.authorized_by_user_id
      AND standings_operations.actor_membership_id =
        NEW.authorized_by_membership_id
      AND standings_operations.actor_authority =
        NEW.authorized_authority
      AND standings_operations.operation_type = CASE NEW.cause
        WHEN 'regular_season_completion'
          THEN 'finalize_regular_season'
        WHEN 'result_correction'
          THEN 'correction_propagation'
      END
      AND standings_operations.status = 'succeeded'
      AND standings_operations.idempotency_request_id =
        NEW.idempotency_request_id
      AND standings_operations.completed_at_ms =
        NEW.finalized_at_ms
  ) THEN RAISE(
    ABORT,
    'standings finalization operation evidence is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM idempotency_requests
    WHERE idempotency_requests.league_id = NEW.league_id
      AND idempotency_requests.id = NEW.idempotency_request_id
      AND idempotency_requests.actor_user_id =
        NEW.authorized_by_user_id
      AND idempotency_requests.operation = CASE NEW.cause
        WHEN 'regular_season_completion'
          THEN 'standings.finalize_regular_season.v1'
        WHEN 'result_correction'
          THEN 'matchup.result.correct.v1'
      END
      AND idempotency_requests.status IN ('started', 'completed')
      AND (
        (
          idempotency_requests.status = 'started'
          AND idempotency_requests.result_type IS NULL
          AND idempotency_requests.result_id IS NULL
          AND idempotency_requests.completed_at_ms IS NULL
        )
        OR
        (
          idempotency_requests.status = 'completed'
          AND idempotency_requests.result_type = CASE NEW.cause
            WHEN 'regular_season_completion'
              THEN 'standings_finalization'
            WHEN 'result_correction'
              THEN 'matchup_result_correction'
          END
          AND (
            (
              NEW.cause = 'regular_season_completion'
              AND idempotency_requests.result_id = NEW.id
            )
            OR
            (
              NEW.cause = 'result_correction'
              AND EXISTS (
                SELECT 1
                FROM standings_snapshot_result_versions
                WHERE standings_snapshot_result_versions.league_id =
                    NEW.league_id
                  AND standings_snapshot_result_versions.season_id =
                    NEW.season_id
                  AND standings_snapshot_result_versions
                        .standings_snapshot_id =
                    NEW.standings_snapshot_id
                  AND standings_snapshot_result_versions
                        .matchup_result_version_id =
                    idempotency_requests.result_id
              )
            )
          )
          AND idempotency_requests.completed_at_ms IS NOT NULL
          AND (
            NEW.cause <> 'regular_season_completion'
            OR idempotency_requests.completed_at_ms =
              NEW.finalized_at_ms
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization idempotency evidence is inconsistent'
  ) END;

  SELECT CASE WHEN NEW.finalized_at_ms < (
    SELECT COALESCE(MAX(matchup_weeks.rolls_over_at_ms), -1)
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
  ) THEN RAISE(
    ABORT,
    'standings cannot finalize before the last regular rollover'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
  ) <> NEW.expected_week_count THEN RAISE(
    ABORT,
    'standings finalization week count is inconsistent'
  ) END;

END;

-- Schema 0028 predates durable schedule-generation identities. Keep its
-- original one-root rule isolated so migration 0030 can replace only this
-- seam once season_matchup_schedule_generations exists.
CREATE TRIGGER standings_snapshot_finalizations_schedule_root_insert_0028
BEFORE INSERT ON standings_snapshot_finalizations
BEGIN

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM matchup_operations
    WHERE matchup_operations.league_id = NEW.league_id
      AND matchup_operations.season_id = NEW.season_id
      AND matchup_operations.operation_type = 'schedule_generate'
      AND matchup_operations.status = 'succeeded'
      AND matchup_operations.matchup_week_id IS NULL
      AND matchup_operations.matchup_id IS NULL
      AND matchup_operations.completed_at_ms IS NOT NULL
  ) <> 1 THEN RAISE(
    ABORT,
    'standings finalization requires one schedule-generation root'
  ) END;

  WITH schedule_root AS (
    SELECT
      matchup_operations.*,
      CASE
        WHEN json_valid(matchup_operations.metadata_json) = 1
          THEN matchup_operations.metadata_json
        ELSE '{}'
      END AS evidence_json
    FROM matchup_operations
    WHERE matchup_operations.league_id = NEW.league_id
      AND matchup_operations.season_id = NEW.season_id
      AND matchup_operations.operation_type = 'schedule_generate'
      AND matchup_operations.status = 'succeeded'
      AND matchup_operations.matchup_week_id IS NULL
      AND matchup_operations.matchup_id IS NULL
      AND matchup_operations.completed_at_ms IS NOT NULL
  ),
  schedule_participants AS (
    SELECT matchups.home_team_id AS team_id
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
    UNION
    SELECT matchups.away_team_id
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
    UNION
    SELECT matchup_byes.team_id
    FROM matchup_byes
    WHERE matchup_byes.league_id = NEW.league_id
      AND matchup_byes.season_id = NEW.season_id
  )
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM schedule_root
    WHERE json_valid(schedule_root.metadata_json) = 1
      AND json_type(schedule_root.evidence_json) = 'object'
      AND json_type(
        schedule_root.evidence_json,
        '$.participantCount'
      ) = 'integer'
      AND json_type(
        schedule_root.evidence_json,
        '$.participantTeamIds'
      ) = 'array'
      AND json_type(
        schedule_root.evidence_json,
        '$.weekCount'
      ) = 'integer'
      AND json_type(
        schedule_root.evidence_json,
        '$.matchupCount'
      ) = 'integer'
      AND (
        json_type(
          schedule_root.evidence_json,
          '$.jobOccurrenceCount'
        ) IS NULL
        OR (
          json_type(
            schedule_root.evidence_json,
            '$.jobOccurrenceCount'
          ) = 'integer'
          AND json_extract(
            schedule_root.evidence_json,
            '$.jobOccurrenceCount'
          ) >= 0
        )
      )
      AND (
        SELECT COUNT(*)
        FROM json_each(schedule_root.evidence_json)
      ) IN (4, 5)
      AND (
        SELECT COUNT(*)
        FROM json_each(schedule_root.evidence_json)
      ) = (
        SELECT COUNT(DISTINCT key)
        FROM json_each(schedule_root.evidence_json)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(schedule_root.evidence_json)
        WHERE json_each.key NOT IN (
          'participantCount',
          'participantTeamIds',
          'weekCount',
          'matchupCount',
          'jobOccurrenceCount'
        )
      )
      AND json_array_length(
        schedule_root.evidence_json,
        '$.participantTeamIds'
      ) = json_extract(
        schedule_root.evidence_json,
        '$.participantCount'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          schedule_root.evidence_json,
          '$.participantTeamIds'
        ) AS participant_id
        WHERE participant_id.type <> 'text'
          OR (
            CAST(participant_id.key AS INTEGER) > 0
            AND participant_id.value <= (
              SELECT previous_id.value
              FROM json_each(
                schedule_root.evidence_json,
                '$.participantTeamIds'
              ) AS previous_id
              WHERE CAST(previous_id.key AS INTEGER) =
                CAST(participant_id.key AS INTEGER) - 1
            )
          )
      )
      AND json_extract(
        schedule_root.evidence_json,
        '$.participantCount'
      ) = NEW.participant_count
      AND json_extract(
        schedule_root.evidence_json,
        '$.participantCount'
      ) = (
        SELECT COUNT(*)
        FROM schedule_participants
      )
      AND NOT EXISTS (
        SELECT 1
        FROM schedule_participants
        WHERE NOT EXISTS (
          SELECT 1
          FROM json_each(
            schedule_root.evidence_json,
            '$.participantTeamIds'
          ) AS participant_id
          WHERE participant_id.value =
            schedule_participants.team_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          schedule_root.evidence_json,
          '$.participantTeamIds'
        ) AS participant_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM schedule_participants
          WHERE schedule_participants.team_id =
            participant_id.value
        )
      )
      AND json_extract(
        schedule_root.evidence_json,
        '$.weekCount'
      ) = NEW.expected_week_count
      AND json_extract(
        schedule_root.evidence_json,
        '$.weekCount'
      ) = (
        SELECT COUNT(*)
        FROM matchup_weeks
        WHERE matchup_weeks.league_id = NEW.league_id
          AND matchup_weeks.season_id = NEW.season_id
      )
      AND json_extract(
        schedule_root.evidence_json,
        '$.matchupCount'
      ) = NEW.expected_matchup_count
      AND json_extract(
        schedule_root.evidence_json,
        '$.matchupCount'
      ) = (
        SELECT COUNT(*)
        FROM matchups
        WHERE matchups.league_id = NEW.league_id
          AND matchups.season_id = NEW.season_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule-generation evidence is inconsistent'
  ) END;

END;

CREATE TRIGGER standings_snapshot_finalizations_evidence_after_schedule_insert
BEFORE INSERT ON standings_snapshot_finalizations
BEGIN

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchup_weeks
    JOIN seasons
      ON seasons.league_id = matchup_weeks.league_id
     AND seasons.id = matchup_weeks.season_id
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
      AND (
        matchup_weeks.status <> 'final'
        OR seasons.regular_season_starts_at_ms IS NULL
        OR seasons.fantasy_playoffs_start_at_ms IS NULL
        OR matchup_weeks.starts_at_ms <
          seasons.regular_season_starts_at_ms
        OR matchup_weeks.ends_at_ms <>
          matchup_weeks.rolls_over_at_ms
        OR (
          matchup_weeks.ends_at_ms -
            matchup_weeks.starts_at_ms
        ) NOT BETWEEN 590400000 AND 619200000
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization requires complete regular-season weeks'
  ) END;

  SELECT CASE WHEN (
    SELECT MIN(matchup_weeks.sequence)
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
  ) <> 1 OR (
    SELECT MAX(matchup_weeks.sequence)
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
  ) <> NEW.expected_week_count THEN RAISE(
    ABORT,
    'standings finalization requires contiguous regular-season weeks'
  ) END;

  SELECT CASE WHEN (
    SELECT final_week.rolls_over_at_ms
    FROM matchup_weeks AS final_week
    WHERE final_week.league_id = NEW.league_id
      AND final_week.season_id = NEW.season_id
    ORDER BY final_week.sequence DESC
    LIMIT 1
  ) <> (
    SELECT seasons.fantasy_playoffs_start_at_ms
    FROM seasons
    WHERE seasons.league_id = NEW.league_id
      AND seasons.id = NEW.season_id
  ) OR EXISTS (
    SELECT 1
    FROM matchup_weeks AS current_week
    WHERE current_week.league_id = NEW.league_id
      AND current_week.season_id = NEW.season_id
      AND current_week.sequence > 1
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_weeks AS prior_week
        WHERE prior_week.league_id =
          current_week.league_id
          AND prior_week.season_id =
            current_week.season_id
          AND prior_week.sequence =
            current_week.sequence - 1
          AND prior_week.rolls_over_at_ms =
            current_week.starts_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule boundaries are incomplete'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_weeks
        WHERE matchup_weeks.league_id =
          matchups.league_id
          AND matchup_weeks.season_id =
            matchups.season_id
          AND matchup_weeks.id =
            matchups.matchup_week_id
      )
  ) OR EXISTS (
    SELECT 1
    FROM matchup_byes
    WHERE matchup_byes.league_id = NEW.league_id
      AND matchup_byes.season_id = NEW.season_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_weeks
        WHERE matchup_weeks.league_id =
          matchup_byes.league_id
          AND matchup_weeks.season_id =
            matchup_byes.season_id
          AND matchup_weeks.id =
            matchup_byes.matchup_week_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule assignments cross season scope'
  ) END;

  SELECT CASE WHEN EXISTS (
    WITH participants AS (
      SELECT matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    ),
    assignments AS (
      SELECT
        matchups.matchup_week_id AS matchup_week_id,
        matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION ALL
      SELECT
        matchups.matchup_week_id,
        matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION ALL
      SELECT
        matchup_byes.matchup_week_id,
        matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    )
    SELECT 1
    FROM matchup_weeks
    CROSS JOIN participants
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
      AND (
        SELECT COUNT(*)
        FROM assignments
        WHERE assignments.matchup_week_id =
          matchup_weeks.id
          AND assignments.team_id =
            participants.team_id
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule participant coverage is incomplete'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
      AND (
        (
          SELECT COUNT(*)
          FROM matchups
          WHERE matchups.league_id = NEW.league_id
            AND matchups.season_id = NEW.season_id
            AND matchups.matchup_week_id =
              matchup_weeks.id
        ) <> CAST(NEW.participant_count / 2 AS INTEGER)
        OR
        (
          SELECT COUNT(*)
          FROM matchup_byes
          WHERE matchup_byes.league_id = NEW.league_id
            AND matchup_byes.season_id = NEW.season_id
            AND matchup_byes.matchup_week_id =
              matchup_weeks.id
        ) <> (NEW.participant_count % 2)
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule matchup and bye counts are invalid'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
  ) <> NEW.expected_matchup_count OR EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
      AND matchups.status <> 'final'
  ) THEN RAISE(
    ABORT,
    'standings finalization requires every expected matchup final'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM standings_snapshot_result_versions
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) <> NEW.finalized_matchup_count THEN RAISE(
    ABORT,
    'standings finalization result-link count is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
      AND NOT EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions
        WHERE standings_snapshot_result_versions.league_id =
          matchups.league_id
          AND standings_snapshot_result_versions.season_id =
            matchups.season_id
          AND standings_snapshot_result_versions.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND standings_snapshot_result_versions.matchup_id =
            matchups.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchups
        WHERE matchups.league_id =
          standings_snapshot_result_versions.league_id
          AND matchups.season_id =
            standings_snapshot_result_versions.season_id
          AND matchups.id =
            standings_snapshot_result_versions.matchup_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization result links do not match the schedule'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchups
        JOIN matchup_weeks
          ON matchup_weeks.league_id = matchups.league_id
         AND matchup_weeks.season_id = matchups.season_id
         AND matchup_weeks.id = matchups.matchup_week_id
        JOIN matchup_results
          ON matchup_results.league_id = matchups.league_id
         AND matchup_results.season_id = matchups.season_id
         AND matchup_results.matchup_id = matchups.id
        JOIN matchup_result_versions
          ON matchup_result_versions.league_id =
            matchup_results.league_id
         AND matchup_result_versions.season_id =
            matchup_results.season_id
         AND matchup_result_versions.matchup_result_id =
            matchup_results.id
        WHERE matchups.league_id =
          standings_snapshot_result_versions.league_id
          AND matchups.season_id =
            standings_snapshot_result_versions.season_id
          AND matchups.id =
            standings_snapshot_result_versions.matchup_id
          AND matchup_weeks.id =
            standings_snapshot_result_versions.matchup_week_id
          AND matchup_results.id =
            standings_snapshot_result_versions.matchup_result_id
          AND matchup_results.status IN ('official', 'corrected')
          AND matchup_results.current_version_id =
            standings_snapshot_result_versions.matchup_result_version_id
          AND matchup_result_versions.id =
            standings_snapshot_result_versions.matchup_result_version_id
          AND matchup_result_versions.version_number =
            standings_snapshot_result_versions.result_version_number
          AND matchup_result_versions.home_team_id =
            matchups.home_team_id
          AND matchup_result_versions.away_team_id =
            matchups.away_team_id
          AND matchup_weeks.status = 'final'
          AND matchups.status = 'final'
          AND (
            (
              matchup_result_versions.outcome = 'home_win'
              AND matchup_result_versions.home_score_hundredths >
                matchup_result_versions.away_score_hundredths
            )
            OR
            (
              matchup_result_versions.outcome = 'away_win'
              AND matchup_result_versions.away_score_hundredths >
                matchup_result_versions.home_score_hundredths
            )
            OR
            (
              matchup_result_versions.outcome = 'tie'
              AND matchup_result_versions.home_score_hundredths =
                matchup_result_versions.away_score_hundredths
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization requires exact current result versions'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    JOIN matchup_result_versions AS corrected_version
      ON corrected_version.league_id =
        standings_snapshot_result_versions.league_id
     AND corrected_version.season_id =
        standings_snapshot_result_versions.season_id
     AND corrected_version.matchup_result_id =
        standings_snapshot_result_versions.matchup_result_id
     AND corrected_version.id =
        standings_snapshot_result_versions.matchup_result_version_id
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND corrected_version.source_type = 'correction'
      AND (
        corrected_version.version_number <= 1
        OR corrected_version.actor_user_id IS NULL
        OR length(trim(corrected_version.reason))
          NOT BETWEEN 1 AND 500
        OR corrected_version.version_number <> (
          SELECT COUNT(*)
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM matchup_result_versions AS previous_version
          WHERE previous_version.league_id =
              corrected_version.league_id
            AND previous_version.season_id =
              corrected_version.season_id
            AND previous_version.matchup_result_id =
              corrected_version.matchup_result_id
            AND previous_version.version_number =
              corrected_version.version_number - 1
            AND previous_version.id =
              corrected_version.supersedes_version_id
        )
        OR EXISTS (
          SELECT 1
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
            AND NOT (
              (
                history.version_number = 1
                AND history.source_type = 'calculated'
                AND history.actor_user_id IS NULL
                AND history.reason IS NULL
                AND history.supersedes_version_id IS NULL
              )
              OR
              (
                history.version_number > 1
                AND history.source_type = 'correction'
                AND history.actor_user_id IS NOT NULL
                AND length(trim(history.reason))
                  BETWEEN 1 AND 500
                AND EXISTS (
                  SELECT 1
                  FROM matchup_result_versions AS prior
                  WHERE prior.league_id = history.league_id
                    AND prior.season_id = history.season_id
                    AND prior.matchup_result_id =
                      history.matchup_result_id
                    AND prior.version_number =
                      history.version_number - 1
                    AND prior.id =
                      history.supersedes_version_id
                )
              )
            )
        )
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization correction chain is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    JOIN matchup_result_versions AS corrected_version
      ON corrected_version.league_id =
        standings_snapshot_result_versions.league_id
     AND corrected_version.season_id =
        standings_snapshot_result_versions.season_id
     AND corrected_version.matchup_result_id =
        standings_snapshot_result_versions.matchup_result_id
     AND corrected_version.id =
        standings_snapshot_result_versions.matchup_result_version_id
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND corrected_version.source_type = 'correction'
      AND (
        SELECT COUNT(*)
        FROM matchup_operations AS correction_operation
        WHERE correction_operation.league_id =
            corrected_version.league_id
          AND correction_operation.season_id =
            corrected_version.season_id
          AND correction_operation.matchup_week_id =
            standings_snapshot_result_versions.matchup_week_id
          AND correction_operation.matchup_id =
            standings_snapshot_result_versions.matchup_id
          AND correction_operation.actor_user_id =
            corrected_version.actor_user_id
          AND correction_operation.operation_type =
            'result_correct'
          AND correction_operation.status = 'succeeded'
          AND correction_operation.reason IS
            corrected_version.reason
          AND correction_operation.completed_at_ms =
            corrected_version.created_at_ms
          AND json_valid(correction_operation.metadata_json) = 1
          AND json_type(
            CASE
              WHEN json_valid(correction_operation.metadata_json) = 1
                THEN correction_operation.metadata_json
              ELSE '{}'
            END
          ) = 'object'
          AND (
            SELECT COUNT(*)
            FROM json_each(
              CASE
                WHEN json_valid(correction_operation.metadata_json) = 1
                  THEN correction_operation.metadata_json
                ELSE '{}'
              END
            )
          ) = 2
          AND (
            SELECT COUNT(DISTINCT key)
            FROM json_each(
              CASE
                WHEN json_valid(correction_operation.metadata_json) = 1
                  THEN correction_operation.metadata_json
                ELSE '{}'
              END
            )
          ) = 2
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(
              CASE
                WHEN json_valid(correction_operation.metadata_json) = 1
                  THEN correction_operation.metadata_json
                ELSE '{}'
              END
            )
            WHERE json_each.key NOT IN (
              'resultId',
              'resultVersionId'
            )
          )
          AND json_type(
            correction_operation.metadata_json,
            '$.resultId'
          ) = 'text'
          AND json_extract(
            correction_operation.metadata_json,
            '$.resultId'
          ) = corrected_version.matchup_result_id
          AND json_type(
            correction_operation.metadata_json,
            '$.resultVersionId'
          ) = 'text'
          AND json_extract(
            correction_operation.metadata_json,
            '$.resultVersionId'
          ) = corrected_version.id
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'standings finalization correction operation is inconsistent'
  ) END;

  SELECT CASE WHEN NEW.cause = 'result_correction'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM standings_snapshot_finalizations AS replaced
        WHERE replaced.league_id = NEW.league_id
          AND replaced.season_id = NEW.season_id
          AND replaced.id = NEW.replaces_finalization_id
      )
      OR (
        SELECT COUNT(*)
        FROM standings_snapshot_result_versions AS replacement_link
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
      ) <> (
        SELECT COUNT(*)
        FROM standings_snapshot_result_versions AS replaced_link
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replaced.league_id = NEW.league_id
          AND replaced.season_id = NEW.season_id
          AND replaced.id = NEW.replaces_finalization_id
      )
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replacement_link
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND NOT EXISTS (
            SELECT 1
            FROM standings_snapshot_result_versions AS replaced_link
            JOIN standings_snapshot_finalizations AS replaced
              ON replaced.league_id = replaced_link.league_id
             AND replaced.season_id = replaced_link.season_id
             AND replaced.standings_snapshot_id =
               replaced_link.standings_snapshot_id
            WHERE replaced.league_id = NEW.league_id
              AND replaced.season_id = NEW.season_id
              AND replaced.id = NEW.replaces_finalization_id
              AND replaced_link.matchup_week_id =
                replacement_link.matchup_week_id
              AND replaced_link.matchup_id =
                replacement_link.matchup_id
              AND replaced_link.matchup_result_id =
                replacement_link.matchup_result_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replaced_link
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replaced.league_id = NEW.league_id
          AND replaced.season_id = NEW.season_id
          AND replaced.id = NEW.replaces_finalization_id
          AND NOT EXISTS (
            SELECT 1
            FROM standings_snapshot_result_versions AS replacement_link
            WHERE replacement_link.league_id = NEW.league_id
              AND replacement_link.season_id = NEW.season_id
              AND replacement_link.standings_snapshot_id =
                NEW.standings_snapshot_id
              AND replacement_link.matchup_week_id =
                replaced_link.matchup_week_id
              AND replacement_link.matchup_id =
                replaced_link.matchup_id
              AND replacement_link.matchup_result_id =
                replaced_link.matchup_result_id
          )
      )
      OR (
        SELECT COUNT(*)
        FROM standings_snapshot_result_versions AS replacement_link
        JOIN standings_snapshot_result_versions AS replaced_link
          ON replaced_link.league_id = replacement_link.league_id
         AND replaced_link.season_id = replacement_link.season_id
         AND replaced_link.matchup_week_id =
           replacement_link.matchup_week_id
         AND replaced_link.matchup_id =
           replacement_link.matchup_id
         AND replaced_link.matchup_result_id =
           replacement_link.matchup_result_id
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND replaced.id = NEW.replaces_finalization_id
          AND replacement_link.matchup_result_version_id <>
            replaced_link.matchup_result_version_id
      ) <> 1
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replacement_link
        JOIN standings_snapshot_result_versions AS replaced_link
          ON replaced_link.league_id = replacement_link.league_id
         AND replaced_link.season_id = replacement_link.season_id
         AND replaced_link.matchup_week_id =
           replacement_link.matchup_week_id
         AND replaced_link.matchup_id =
           replacement_link.matchup_id
         AND replaced_link.matchup_result_id =
           replacement_link.matchup_result_id
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        JOIN matchup_result_versions AS replacement_version
          ON replacement_version.league_id =
            replacement_link.league_id
         AND replacement_version.season_id =
            replacement_link.season_id
         AND replacement_version.matchup_result_id =
            replacement_link.matchup_result_id
         AND replacement_version.id =
            replacement_link.matchup_result_version_id
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND replaced.id = NEW.replaces_finalization_id
          AND replacement_link.matchup_result_version_id <>
            replaced_link.matchup_result_version_id
          AND (
            replacement_link.result_version_number <>
              replaced_link.result_version_number + 1
            OR replacement_version.supersedes_version_id <>
              replaced_link.matchup_result_version_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replacement_link
        JOIN standings_snapshot_result_versions AS replaced_link
          ON replaced_link.league_id = replacement_link.league_id
         AND replaced_link.season_id = replacement_link.season_id
         AND replaced_link.matchup_week_id =
           replacement_link.matchup_week_id
         AND replaced_link.matchup_id =
           replacement_link.matchup_id
         AND replaced_link.matchup_result_id =
           replacement_link.matchup_result_id
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND replaced.id = NEW.replaces_finalization_id
          AND replacement_link.matchup_result_version_id =
            replaced_link.matchup_result_version_id
          AND replacement_link.result_version_number <>
            replaced_link.result_version_number
      )
    )
  THEN RAISE(
    ABORT,
    'replacement standings links must contain one direct correction'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM (
      SELECT matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    )
  ) <> NEW.participant_count THEN RAISE(
    ABORT,
    'standings finalization participant count is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM standings_rows
    WHERE standings_rows.league_id = NEW.league_id
      AND standings_rows.season_id = NEW.season_id
      AND standings_rows.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) <> NEW.standings_row_count OR EXISTS (
    SELECT 1
    FROM standings_rows
    WHERE standings_rows.standings_snapshot_id =
      NEW.standings_snapshot_id
      AND (
        standings_rows.league_id <> NEW.league_id
        OR standings_rows.season_id <> NEW.season_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization row count is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM standings_snapshot_team_identities
    WHERE standings_snapshot_team_identities.league_id =
      NEW.league_id
      AND standings_snapshot_team_identities.season_id =
        NEW.season_id
      AND standings_snapshot_team_identities.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) <> NEW.participant_count THEN RAISE(
    ABORT,
    'standings finalization identity count is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    ) AS participants
    WHERE NOT EXISTS (
      SELECT 1
      FROM standings_rows
      WHERE standings_rows.league_id = NEW.league_id
        AND standings_rows.season_id = NEW.season_id
        AND standings_rows.standings_snapshot_id =
          NEW.standings_snapshot_id
        AND standings_rows.team_id = participants.team_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM standings_snapshot_team_identities
      WHERE standings_snapshot_team_identities.league_id =
        NEW.league_id
        AND standings_snapshot_team_identities.season_id =
          NEW.season_id
        AND standings_snapshot_team_identities.standings_snapshot_id =
          NEW.standings_snapshot_id
        AND standings_snapshot_team_identities.team_id =
          participants.team_id
    )
  ) OR EXISTS (
    SELECT 1
    FROM standings_rows
    WHERE standings_rows.league_id = NEW.league_id
      AND standings_rows.season_id = NEW.season_id
      AND standings_rows.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND NOT EXISTS (
        SELECT 1
        FROM standings_snapshot_team_identities
        WHERE standings_snapshot_team_identities.league_id =
          standings_rows.league_id
          AND standings_snapshot_team_identities.season_id =
            standings_rows.season_id
          AND standings_snapshot_team_identities.standings_snapshot_id =
            standings_rows.standings_snapshot_id
          AND standings_snapshot_team_identities.team_id =
            standings_rows.team_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization requires exact row and identity coverage'
  ) END;

  SELECT CASE WHEN NEW.replaces_finalization_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM standings_snapshot_finalizations AS replaced
      WHERE replaced.league_id = NEW.league_id
        AND replaced.season_id = NEW.season_id
        AND replaced.id = NEW.replaces_finalization_id
        AND replaced.status = 'superseded'
        AND replaced.superseded_by_snapshot_id =
          NEW.standings_snapshot_id
        AND replaced.superseded_by_user_id =
          NEW.authorized_by_user_id
        AND replaced.superseded_by_membership_id =
          NEW.authorized_by_membership_id
        AND replaced.superseded_by_authority =
          NEW.authorized_authority
        AND replaced.superseded_by_operation_id =
          NEW.standings_operation_id
        AND replaced.finalization_version <
          NEW.finalization_version
    )
  THEN RAISE(
    ABORT,
    'replacement standings finalization chain is inconsistent'
  ) END;
END;

CREATE TRIGGER standings_snapshot_finalizations_supersede_update
BEFORE UPDATE ON standings_snapshot_finalizations
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'final'
    AND NEW.status = 'superseded'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.standings_snapshot_id IS OLD.standings_snapshot_id
    AND NEW.finalization_version IS OLD.finalization_version
    AND NEW.evidence_schema_version IS OLD.evidence_schema_version
    AND NEW.cause IS OLD.cause
    AND NEW.standings_rule_version IS OLD.standings_rule_version
    AND NEW.result_set_hash IS OLD.result_set_hash
    AND NEW.result_set_hash_version IS OLD.result_set_hash_version
    AND NEW.expected_matchup_count IS OLD.expected_matchup_count
    AND NEW.finalized_matchup_count IS OLD.finalized_matchup_count
    AND NEW.expected_week_count IS OLD.expected_week_count
    AND NEW.weeks_counted IS OLD.weeks_counted
    AND NEW.participant_count IS OLD.participant_count
    AND NEW.standings_row_count IS OLD.standings_row_count
    AND NEW.completeness_status IS OLD.completeness_status
    AND NEW.season_version_before IS OLD.season_version_before
    AND NEW.season_version_after IS OLD.season_version_after
    AND NEW.authorized_by_user_id IS OLD.authorized_by_user_id
    AND NEW.authorized_by_membership_id IS
      OLD.authorized_by_membership_id
    AND NEW.authorized_authority IS OLD.authorized_authority
    AND NEW.standings_operation_id IS OLD.standings_operation_id
    AND NEW.idempotency_request_id IS OLD.idempotency_request_id
    AND NEW.replaces_finalization_id IS OLD.replaces_finalization_id
    AND OLD.superseded_by_snapshot_id IS NULL
    AND OLD.superseded_by_user_id IS NULL
    AND OLD.superseded_by_membership_id IS NULL
    AND OLD.superseded_by_authority IS NULL
    AND OLD.superseded_by_operation_id IS NULL
    AND OLD.superseded_at_ms IS NULL
    AND NEW.superseded_by_snapshot_id IS NOT NULL
    AND NEW.superseded_by_user_id IS NOT NULL
    AND NEW.superseded_by_membership_id IS NOT NULL
    AND NEW.superseded_by_authority IS NOT NULL
    AND NEW.superseded_by_operation_id IS NOT NULL
    AND NEW.superseded_at_ms IS NOT NULL
    AND NEW.finalized_at_ms IS OLD.finalized_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.updated_at_ms >= NEW.superseded_at_ms
    AND NEW.version = OLD.version + 1
  ) THEN RAISE(
    ABORT,
    'standings finalization evidence is immutable'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM standings_snapshots AS replacement
    JOIN standings_operations AS replacement_operation
      ON replacement_operation.league_id = replacement.league_id
     AND replacement_operation.season_id = replacement.season_id
     AND replacement_operation.standings_snapshot_id = replacement.id
    WHERE replacement.league_id = OLD.league_id
      AND replacement.season_id = OLD.season_id
      AND replacement.id = NEW.superseded_by_snapshot_id
      AND replacement.status = 'final'
      AND replacement.snapshot_version > OLD.finalization_version
      AND replacement_operation.id =
        NEW.superseded_by_operation_id
      AND replacement_operation.operation_type =
        'correction_propagation'
      AND replacement_operation.status = 'succeeded'
      AND replacement_operation.actor_user_id =
        NEW.superseded_by_user_id
      AND replacement_operation.actor_membership_id =
        NEW.superseded_by_membership_id
      AND replacement_operation.actor_authority =
        NEW.superseded_by_authority
      AND NOT EXISTS (
        SELECT 1
        FROM standings_snapshot_finalizations AS replacement_finalization
        WHERE replacement_finalization.league_id = replacement.league_id
          AND replacement_finalization.season_id = replacement.season_id
          AND replacement_finalization.standings_snapshot_id =
            replacement.id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization supersession requires a staged replacement'
  ) END;
END;

CREATE TRIGGER standings_snapshot_finalizations_supersede_snapshot
AFTER UPDATE OF status ON standings_snapshot_finalizations
WHEN OLD.status = 'final' AND NEW.status = 'superseded'
BEGIN
  UPDATE standings_snapshots
  SET status = 'superseded'
  WHERE standings_snapshots.league_id = NEW.league_id
    AND standings_snapshots.season_id = NEW.season_id
    AND standings_snapshots.id = NEW.standings_snapshot_id
    AND standings_snapshots.status = 'final';
END;

CREATE TRIGGER standings_snapshot_finalizations_immutable_delete
BEFORE DELETE ON standings_snapshot_finalizations
BEGIN
  SELECT RAISE(
    ABORT,
    'standings finalization evidence cannot be deleted'
  );
END;

CREATE TRIGGER standings_snapshots_canonical_update
BEFORE UPDATE ON standings_snapshots
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id = OLD.id
)
AND NOT (
  OLD.status = 'final'
  AND NEW.status = 'superseded'
  AND NEW.id IS OLD.id
  AND NEW.league_id IS OLD.league_id
  AND NEW.season_id IS OLD.season_id
  AND NEW.snapshot_version IS OLD.snapshot_version
  AND NEW.source_result_version IS OLD.source_result_version
  AND NEW.calculated_at_ms IS OLD.calculated_at_ms
  AND NEW.created_at_ms IS OLD.created_at_ms
  AND EXISTS (
    SELECT 1
    FROM standings_snapshot_finalizations
    WHERE standings_snapshot_finalizations.league_id = OLD.league_id
      AND standings_snapshot_finalizations.season_id = OLD.season_id
      AND standings_snapshot_finalizations.standings_snapshot_id = OLD.id
      AND standings_snapshot_finalizations.status = 'superseded'
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings snapshot is immutable'
  );
END;

CREATE TRIGGER standings_snapshots_canonical_delete
BEFORE DELETE ON standings_snapshots
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings snapshot cannot be deleted'
  );
END;

CREATE TRIGGER standings_snapshots_active_final_blocks_current_insert
BEFORE INSERT ON standings_snapshots
WHEN NEW.status = 'current'
AND EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  JOIN idempotency_requests
    ON idempotency_requests.league_id =
      standings_snapshot_finalizations.league_id
   AND idempotency_requests.id =
      standings_snapshot_finalizations.idempotency_request_id
  WHERE standings_snapshot_finalizations.league_id = NEW.league_id
    AND standings_snapshot_finalizations.season_id = NEW.season_id
    AND standings_snapshot_finalizations.status = 'final'
    AND standings_snapshot_finalizations.evidence_schema_version = 1
    AND idempotency_requests.status = 'completed'
    AND (
      (
        standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND idempotency_requests.operation =
          'standings.finalize_regular_season.v1'
        AND idempotency_requests.result_type =
          'standings_finalization'
      )
      OR
      (
        standings_snapshot_finalizations.cause =
          'result_correction'
        AND idempotency_requests.operation =
          'matchup.result.correct.v1'
        AND idempotency_requests.result_type =
          'matchup_result_correction'
      )
    )
    AND (
      (
        standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND idempotency_requests.result_id =
          standings_snapshot_finalizations.id
      )
      OR
      (
        standings_snapshot_finalizations.cause =
          'result_correction'
        AND EXISTS (
          SELECT 1
          FROM standings_snapshot_result_versions
          WHERE standings_snapshot_result_versions.league_id =
              standings_snapshot_finalizations.league_id
            AND standings_snapshot_result_versions.season_id =
              standings_snapshot_finalizations.season_id
            AND standings_snapshot_result_versions.standings_snapshot_id =
              standings_snapshot_finalizations.standings_snapshot_id
            AND standings_snapshot_result_versions
                  .matchup_result_version_id =
              idempotency_requests.result_id
        )
      )
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'active final standings block a current snapshot'
  );
END;

CREATE TRIGGER standings_snapshots_active_final_blocks_current_update
BEFORE UPDATE OF status ON standings_snapshots
WHEN NEW.status = 'current'
AND OLD.status <> 'current'
AND EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  JOIN idempotency_requests
    ON idempotency_requests.league_id =
      standings_snapshot_finalizations.league_id
   AND idempotency_requests.id =
      standings_snapshot_finalizations.idempotency_request_id
  WHERE standings_snapshot_finalizations.league_id = NEW.league_id
    AND standings_snapshot_finalizations.season_id = NEW.season_id
    AND standings_snapshot_finalizations.status = 'final'
    AND standings_snapshot_finalizations.evidence_schema_version = 1
    AND idempotency_requests.status = 'completed'
    AND (
      (
        standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND idempotency_requests.operation =
          'standings.finalize_regular_season.v1'
        AND idempotency_requests.result_type =
          'standings_finalization'
      )
      OR
      (
        standings_snapshot_finalizations.cause =
          'result_correction'
        AND idempotency_requests.operation =
          'matchup.result.correct.v1'
        AND idempotency_requests.result_type =
          'matchup_result_correction'
      )
    )
    AND (
      (
        standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND idempotency_requests.result_id =
          standings_snapshot_finalizations.id
      )
      OR
      (
        standings_snapshot_finalizations.cause =
          'result_correction'
        AND EXISTS (
          SELECT 1
          FROM standings_snapshot_result_versions
          WHERE standings_snapshot_result_versions.league_id =
              standings_snapshot_finalizations.league_id
            AND standings_snapshot_result_versions.season_id =
              standings_snapshot_finalizations.season_id
            AND standings_snapshot_result_versions.standings_snapshot_id =
              standings_snapshot_finalizations.standings_snapshot_id
            AND standings_snapshot_result_versions
                  .matchup_result_version_id =
              idempotency_requests.result_id
        )
      )
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'active final standings block a current snapshot'
  );
END;

CREATE TRIGGER standings_rows_canonical_insert
BEFORE INSERT ON standings_rows
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = NEW.league_id
    AND standings_snapshot_finalizations.season_id = NEW.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      NEW.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings rows are immutable'
  );
END;

CREATE TRIGGER standings_rows_canonical_update
BEFORE UPDATE ON standings_rows
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      OLD.standings_snapshot_id
)
OR EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = NEW.league_id
    AND standings_snapshot_finalizations.season_id = NEW.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      NEW.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings rows are immutable'
  );
END;

CREATE TRIGGER standings_rows_canonical_delete
BEFORE DELETE ON standings_rows
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      OLD.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings rows cannot be deleted'
  );
END;

CREATE TRIGGER matchup_result_versions_immutable_update
BEFORE UPDATE ON matchup_result_versions
BEGIN
  SELECT RAISE(
    ABORT,
    'matchup result-version history is immutable'
  );
END;

CREATE TRIGGER matchup_result_versions_immutable_delete
BEFORE DELETE ON matchup_result_versions
BEGIN
  SELECT RAISE(
    ABORT,
    'matchup result-version history cannot be deleted'
  );
END;

CREATE TRIGGER matchup_operations_schedule_generate_immutable_update
BEFORE UPDATE ON matchup_operations
WHEN OLD.operation_type = 'schedule_generate'
  AND OLD.status = 'succeeded'
BEGIN
  SELECT RAISE(
    ABORT,
    'succeeded schedule-generation evidence is immutable'
  );
END;

CREATE TRIGGER matchup_operations_schedule_generate_immutable_delete
BEFORE DELETE ON matchup_operations
WHEN OLD.operation_type = 'schedule_generate'
  AND OLD.status = 'succeeded'
BEGIN
  SELECT RAISE(
    ABORT,
    'succeeded schedule-generation evidence cannot be deleted'
  );
END;

CREATE TRIGGER matchup_operations_result_correct_immutable_update
BEFORE UPDATE ON matchup_operations
WHEN OLD.operation_type = 'result_correct'
  AND OLD.status = 'succeeded'
BEGIN
  SELECT RAISE(
    ABORT,
    'succeeded result-correction operation is immutable'
  );
END;

CREATE TRIGGER matchup_operations_result_correct_immutable_delete
BEFORE DELETE ON matchup_operations
WHEN OLD.operation_type = 'result_correct'
  AND OLD.status = 'succeeded'
BEGIN
  SELECT RAISE(
    ABORT,
    'succeeded result-correction operation cannot be deleted'
  );
END;

CREATE TRIGGER matchup_results_active_final_pointer_interlock
BEFORE UPDATE OF current_version_id, status ON matchup_results
WHEN (
  NEW.current_version_id IS NOT OLD.current_version_id
  OR NEW.status IS NOT OLD.status
)
AND EXISTS (
  SELECT 1
  FROM standings_snapshot_result_versions
  JOIN standings_snapshot_finalizations
    ON standings_snapshot_finalizations.league_id =
      standings_snapshot_result_versions.league_id
   AND standings_snapshot_finalizations.season_id =
      standings_snapshot_result_versions.season_id
   AND standings_snapshot_finalizations.standings_snapshot_id =
      standings_snapshot_result_versions.standings_snapshot_id
  JOIN idempotency_requests
    ON idempotency_requests.league_id =
      standings_snapshot_finalizations.league_id
   AND idempotency_requests.id =
      standings_snapshot_finalizations.idempotency_request_id
  WHERE standings_snapshot_result_versions.league_id = OLD.league_id
    AND standings_snapshot_result_versions.season_id = OLD.season_id
    AND standings_snapshot_result_versions.matchup_result_id = OLD.id
    AND standings_snapshot_finalizations.status = 'final'
    AND standings_snapshot_finalizations.evidence_schema_version = 1
    AND idempotency_requests.status = 'completed'
    AND (
      (
        standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND idempotency_requests.operation =
          'standings.finalize_regular_season.v1'
        AND idempotency_requests.result_type =
          'standings_finalization'
      )
      OR
      (
        standings_snapshot_finalizations.cause =
          'result_correction'
        AND idempotency_requests.operation =
          'matchup.result.correct.v1'
        AND idempotency_requests.result_type =
          'matchup_result_correction'
      )
    )
    AND (
      (
        standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND idempotency_requests.result_id =
          standings_snapshot_finalizations.id
      )
      OR
      (
        standings_snapshot_finalizations.cause =
          'result_correction'
        AND EXISTS (
          SELECT 1
          FROM standings_snapshot_result_versions
          WHERE standings_snapshot_result_versions.league_id =
              standings_snapshot_finalizations.league_id
            AND standings_snapshot_result_versions.season_id =
              standings_snapshot_finalizations.season_id
            AND standings_snapshot_result_versions.standings_snapshot_id =
              standings_snapshot_finalizations.standings_snapshot_id
            AND standings_snapshot_result_versions
                  .matchup_result_version_id =
              idempotency_requests.result_id
        )
      )
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'active final standings require atomic correction replacement'
  );
END;

CREATE TRIGGER standings_operations_finalization_immutable_update
BEFORE UPDATE ON standings_operations
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id =
      OLD.league_id
    AND standings_snapshot_finalizations.standings_operation_id =
      OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'succeeded standings finalization operation is immutable'
  );
END;

CREATE TRIGGER standings_operations_finalization_immutable_delete
BEFORE DELETE ON standings_operations
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id =
      OLD.league_id
    AND standings_snapshot_finalizations.standings_operation_id =
      OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'succeeded standings finalization operation cannot be deleted'
  );
END;

CREATE TRIGGER idempotency_requests_standings_finalization_immutable_update
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation IN (
  'standings.finalize_regular_season.v1',
  'matchup.result.correct.v1'
)
OR NEW.operation IN (
  'standings.finalize_regular_season.v1',
  'matchup.result.correct.v1'
)
BEGIN
  SELECT CASE WHEN NOT (
    OLD.operation IN (
      'standings.finalize_regular_season.v1',
      'matchup.result.correct.v1'
    )
    AND OLD.status = 'started'
    AND OLD.result_type IS NULL
    AND OLD.result_id IS NULL
    AND OLD.completed_at_ms IS NULL
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.status = 'completed'
    AND (
      (
        OLD.operation =
          'standings.finalize_regular_season.v1'
        AND NEW.result_type = 'standings_finalization'
      )
      OR
      (
        OLD.operation = 'matchup.result.correct.v1'
        AND NEW.result_type =
          'matchup_result_correction'
      )
    )
    AND NEW.result_id IS NOT NULL
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.completed_at_ms IS NOT NULL
    AND NEW.expires_at_ms IS OLD.expires_at_ms
  ) THEN RAISE(
    ABORT,
    'standings finalization idempotency evidence is immutable'
  ) END;
END;

CREATE TRIGGER idempotency_requests_standings_finalization_immutable_delete
BEFORE DELETE ON idempotency_requests
WHEN OLD.operation IN (
  'standings.finalize_regular_season.v1',
  'matchup.result.correct.v1'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'standings finalization idempotency evidence cannot be deleted'
  );
END;

CREATE TRIGGER idempotency_requests_standings_finalization_complete
BEFORE UPDATE OF status, result_type, result_id, completed_at_ms
  ON idempotency_requests
WHEN NEW.operation = 'standings.finalize_regular_season.v1'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'started'
    AND NEW.result_type = 'standings_finalization'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM standings_snapshot_finalizations
      JOIN seasons
        ON seasons.league_id =
          standings_snapshot_finalizations.league_id
       AND seasons.id =
          standings_snapshot_finalizations.season_id
      WHERE standings_snapshot_finalizations.league_id = NEW.league_id
        AND standings_snapshot_finalizations.id = NEW.result_id
        AND standings_snapshot_finalizations.idempotency_request_id =
          NEW.id
        AND standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND standings_snapshot_finalizations.status = 'final'
        AND standings_snapshot_finalizations.evidence_schema_version = 1
        AND NEW.completed_at_ms =
          standings_snapshot_finalizations.finalized_at_ms
        AND seasons.version =
          standings_snapshot_finalizations.season_version_after
    )
  ) THEN RAISE(
    ABORT,
    'standings finalization idempotency completion is inconsistent'
  ) END;
END;

CREATE TRIGGER idempotency_requests_matchup_result_correction_complete
BEFORE UPDATE OF status, result_type, result_id, completed_at_ms
  ON idempotency_requests
WHEN NEW.operation = 'matchup.result.correct.v1'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'started'
    AND NEW.result_type = 'matchup_result_correction'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM matchup_result_versions AS corrected_version
      JOIN matchup_results
        ON matchup_results.league_id =
          corrected_version.league_id
       AND matchup_results.season_id =
          corrected_version.season_id
       AND matchup_results.id =
          corrected_version.matchup_result_id
      JOIN seasons
        ON seasons.league_id =
          corrected_version.league_id
       AND seasons.id =
          corrected_version.season_id
      WHERE corrected_version.league_id = NEW.league_id
        AND corrected_version.id = NEW.result_id
        AND corrected_version.source_type = 'correction'
        AND corrected_version.actor_user_id =
          NEW.actor_user_id
        AND length(trim(corrected_version.reason))
          BETWEEN 1 AND 500
        AND corrected_version.version_number > 1
        AND matchup_results.current_version_id =
          corrected_version.id
        AND matchup_results.status = 'corrected'
        AND EXISTS (
          SELECT 1
          FROM matchup_result_versions AS previous_version
          WHERE previous_version.league_id =
              corrected_version.league_id
            AND previous_version.season_id =
              corrected_version.season_id
            AND previous_version.matchup_result_id =
              corrected_version.matchup_result_id
            AND previous_version.version_number =
              corrected_version.version_number - 1
            AND previous_version.id =
              corrected_version.supersedes_version_id
        )
        AND corrected_version.version_number = (
          SELECT COUNT(*)
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
            AND NOT (
              (
                history.version_number = 1
                AND history.source_type = 'calculated'
                AND history.actor_user_id IS NULL
                AND history.reason IS NULL
                AND history.supersedes_version_id IS NULL
              )
              OR
              (
                history.version_number > 1
                AND history.source_type = 'correction'
                AND history.actor_user_id IS NOT NULL
                AND length(trim(history.reason))
                  BETWEEN 1 AND 500
                AND EXISTS (
                  SELECT 1
                  FROM matchup_result_versions AS prior
                  WHERE prior.league_id = history.league_id
                    AND prior.season_id = history.season_id
                    AND prior.matchup_result_id =
                      history.matchup_result_id
                    AND prior.version_number =
                      history.version_number - 1
                    AND prior.id =
                      history.supersedes_version_id
                )
              )
            )
        )
        AND (
          (
            NOT EXISTS (
              SELECT 1
              FROM standings_snapshot_finalizations
              WHERE standings_snapshot_finalizations.league_id =
                  corrected_version.league_id
                AND standings_snapshot_finalizations.season_id =
                  corrected_version.season_id
                AND standings_snapshot_finalizations
                      .evidence_schema_version = 1
            )
            AND NOT EXISTS (
              SELECT 1
              FROM standings_operations
              WHERE standings_operations.league_id =
                  corrected_version.league_id
                AND standings_operations.season_id =
                  corrected_version.season_id
                AND standings_operations.operation_type =
                  'correction_propagation'
                AND standings_operations.idempotency_request_id =
                  NEW.id
            )
          )
          OR
          (
            EXISTS (
              SELECT 1
              FROM standings_snapshot_finalizations
              WHERE standings_snapshot_finalizations.league_id =
                  corrected_version.league_id
                AND standings_snapshot_finalizations.season_id =
                  corrected_version.season_id
                AND standings_snapshot_finalizations
                      .evidence_schema_version = 1
            )
            AND (
              SELECT COUNT(*)
              FROM standings_snapshot_finalizations AS replacement
              JOIN standings_operations AS replacement_operation
                ON replacement_operation.league_id =
                  replacement.league_id
               AND replacement_operation.season_id =
                  replacement.season_id
               AND replacement_operation.id =
                  replacement.standings_operation_id
               AND replacement_operation.standings_snapshot_id =
                  replacement.standings_snapshot_id
              JOIN standings_snapshot_result_versions AS replacement_link
                ON replacement_link.league_id =
                  replacement.league_id
               AND replacement_link.season_id =
                  replacement.season_id
               AND replacement_link.standings_snapshot_id =
                  replacement.standings_snapshot_id
                AND replacement_link.matchup_result_version_id =
                  corrected_version.id
              JOIN standings_snapshot_finalizations AS replaced
                ON replaced.league_id = replacement.league_id
               AND replaced.season_id = replacement.season_id
               AND replaced.id =
                  replacement.replaces_finalization_id
              JOIN standings_snapshot_result_versions AS replaced_link
                ON replaced_link.league_id = replaced.league_id
               AND replaced_link.season_id = replaced.season_id
               AND replaced_link.standings_snapshot_id =
                  replaced.standings_snapshot_id
               AND replaced_link.matchup_week_id =
                  replacement_link.matchup_week_id
               AND replaced_link.matchup_id =
                  replacement_link.matchup_id
               AND replaced_link.matchup_result_id =
                  replacement_link.matchup_result_id
              WHERE replacement.league_id =
                  corrected_version.league_id
                AND replacement.season_id =
                  corrected_version.season_id
                AND replacement.idempotency_request_id =
                  NEW.id
                AND replacement.cause = 'result_correction'
                AND replacement.status = 'final'
                AND replacement.evidence_schema_version = 1
                AND replacement_operation.operation_type =
                  'correction_propagation'
                AND replacement_operation.status = 'succeeded'
                AND replacement_operation.idempotency_request_id =
                  NEW.id
                AND replacement_link.result_version_number =
                  replaced_link.result_version_number + 1
                AND corrected_version.supersedes_version_id =
                  replaced_link.matchup_result_version_id
                AND seasons.version =
                  replacement.season_version_after
            ) = 1
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'matchup result correction idempotency completion is inconsistent'
  ) END;
END;

CREATE TRIGGER idempotency_requests_matchup_result_correction_operation_complete
BEFORE UPDATE OF status, result_type, result_id, completed_at_ms
  ON idempotency_requests
WHEN NEW.operation = 'matchup.result.correct.v1'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM matchup_result_versions AS corrected_version
    JOIN matchup_results
      ON matchup_results.league_id = corrected_version.league_id
     AND matchup_results.season_id = corrected_version.season_id
     AND matchup_results.id =
       corrected_version.matchup_result_id
    JOIN matchups
      ON matchups.league_id = matchup_results.league_id
     AND matchups.season_id = matchup_results.season_id
     AND matchups.id = matchup_results.matchup_id
    JOIN matchup_operations AS correction_operation
      ON correction_operation.league_id =
        corrected_version.league_id
     AND correction_operation.season_id =
        corrected_version.season_id
     AND correction_operation.matchup_week_id =
        matchups.matchup_week_id
     AND correction_operation.matchup_id = matchups.id
     AND correction_operation.actor_user_id =
        corrected_version.actor_user_id
     AND correction_operation.operation_type = 'result_correct'
     AND correction_operation.status = 'succeeded'
     AND correction_operation.reason IS corrected_version.reason
     AND correction_operation.completed_at_ms =
        corrected_version.created_at_ms
    WHERE corrected_version.league_id = NEW.league_id
      AND corrected_version.id = NEW.result_id
      AND corrected_version.actor_user_id =
        NEW.actor_user_id
      AND json_valid(correction_operation.metadata_json) = 1
      AND json_type(
        CASE
          WHEN json_valid(correction_operation.metadata_json) = 1
            THEN correction_operation.metadata_json
          ELSE '{}'
        END
      ) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(
          CASE
            WHEN json_valid(correction_operation.metadata_json) = 1
              THEN correction_operation.metadata_json
            ELSE '{}'
          END
        )
      ) = 2
      AND (
        SELECT COUNT(DISTINCT key)
        FROM json_each(
          CASE
            WHEN json_valid(correction_operation.metadata_json) = 1
              THEN correction_operation.metadata_json
            ELSE '{}'
          END
        )
      ) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          CASE
            WHEN json_valid(correction_operation.metadata_json) = 1
              THEN correction_operation.metadata_json
            ELSE '{}'
          END
        )
        WHERE json_each.key NOT IN (
          'resultId',
          'resultVersionId'
        )
      )
      AND json_extract(
        correction_operation.metadata_json,
        '$.resultId'
      ) = corrected_version.matchup_result_id
      AND json_extract(
        correction_operation.metadata_json,
        '$.resultVersionId'
      ) = corrected_version.id
  ) <> 1 THEN RAISE(
    ABORT,
    'matchup result correction operation evidence is inconsistent'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '28',
    updated_at_ms =
      CASE WHEN updated_at_ms < 28 THEN 28 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
