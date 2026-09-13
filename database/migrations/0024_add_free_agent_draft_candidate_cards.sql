-- Add the annual Free Agent Draft, private Candidate Card, help-request,
-- revision, and immutable deadline-snapshot storage.
-- Canonical slots are protocol keys (F01-F12, D01-D06, B01-B04), not rows.
-- This migration creates no FAD, card, snapshot, activity, or notification.

CREATE TABLE free_agent_drafts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  first_matchup_week_id TEXT NOT NULL,
  participating_team_count INTEGER NOT NULL
    CHECK (participating_team_count >= 1),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'cards_open',
        'deadline_locked',
        'allocating',
        'rapid',
        'completed'
      )
    ),
  setup_path TEXT NOT NULL
    CHECK (
      setup_path IN (
        'completed_entry_draft',
        'no_draft_inaugural',
        'no_draft_initial_season2'
      )
    ),
  entry_draft_id TEXT,
  setup_exemption_id TEXT,
  prior_season_rollover_id TEXT,
  no_draft_reason TEXT
    CHECK (
      no_draft_reason IS NULL
      OR (
        no_draft_reason = trim(no_draft_reason)
        AND length(no_draft_reason) BETWEEN 1 AND 500
      )
    ),
  opened_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  opened_by_membership_id TEXT NOT NULL,
  opened_authority TEXT NOT NULL
    CHECK (
      opened_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  opened_at_ms INTEGER NOT NULL CHECK (opened_at_ms >= 0),
  help_opens_at_ms INTEGER NOT NULL CHECK (help_opens_at_ms >= 0),
  candidate_deadline_at_ms INTEGER NOT NULL
    CHECK (candidate_deadline_at_ms >= 0),
  first_matchup_starts_at_ms INTEGER NOT NULL
    CHECK (first_matchup_starts_at_ms >= 0),
  deadline_locked_at_ms INTEGER
    CHECK (
      deadline_locked_at_ms IS NULL
      OR deadline_locked_at_ms >= candidate_deadline_at_ms
    ),
  allocation_completed_at_ms INTEGER
    CHECK (
      allocation_completed_at_ms IS NULL
      OR (
        deadline_locked_at_ms IS NOT NULL
        AND allocation_completed_at_ms >= deadline_locked_at_ms
      )
    ),
  completed_at_ms INTEGER
    CHECK (
      completed_at_ms IS NULL
      OR (
        allocation_completed_at_ms IS NOT NULL
        AND completed_at_ms >= allocation_completed_at_ms
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= opened_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id),
  UNIQUE (league_id, season_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, first_matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, setup_exemption_id)
    REFERENCES free_agent_draft_setup_exemptions(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, prior_season_rollover_id)
    REFERENCES season_rollovers(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, opened_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    help_opens_at_ms = candidate_deadline_at_ms - 172800000
    AND candidate_deadline_at_ms =
      first_matchup_starts_at_ms - 604800000
    AND opened_at_ms < help_opens_at_ms
  ),
  CHECK (
    (
      setup_path = 'completed_entry_draft'
      AND entry_draft_id IS NOT NULL
      AND setup_exemption_id IS NULL
      AND no_draft_reason IS NULL
    )
    OR (
      setup_path = 'no_draft_inaugural'
      AND entry_draft_id IS NULL
      AND setup_exemption_id IS NULL
      AND no_draft_reason IS NOT NULL
      AND prior_season_rollover_id IS NULL
    )
    OR (
      setup_path = 'no_draft_initial_season2'
      AND entry_draft_id IS NULL
      AND setup_exemption_id IS NOT NULL
      AND no_draft_reason IS NOT NULL
      AND prior_season_rollover_id IS NULL
    )
  ),
  CHECK (
    (
      status = 'cards_open'
      AND deadline_locked_at_ms IS NULL
      AND allocation_completed_at_ms IS NULL
      AND completed_at_ms IS NULL
    )
    OR (
      status IN ('deadline_locked', 'allocating')
      AND deadline_locked_at_ms IS NOT NULL
      AND allocation_completed_at_ms IS NULL
      AND completed_at_ms IS NULL
    )
    OR (
      status = 'rapid'
      AND deadline_locked_at_ms IS NOT NULL
      AND allocation_completed_at_ms IS NOT NULL
      AND completed_at_ms IS NULL
    )
    OR (
      status = 'completed'
      AND deadline_locked_at_ms IS NOT NULL
      AND allocation_completed_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX free_agent_drafts_league_status_deadline
  ON free_agent_drafts (
    league_id,
    status,
    candidate_deadline_at_ms
  );

CREATE INDEX free_agent_drafts_league_first_week
  ON free_agent_drafts (league_id, first_matchup_week_id);

CREATE TRIGGER free_agent_drafts_setup_insert
BEFORE INSERT ON free_agent_drafts
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'cards_open'
    AND NEW.deadline_locked_at_ms IS NULL
    AND NEW.allocation_completed_at_ms IS NULL
    AND NEW.completed_at_ms IS NULL
    AND NEW.created_at_ms = NEW.opened_at_ms
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
  ) THEN RAISE(
    ABORT,
    'FAD must begin as a version-1 cards-open aggregate'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN seasons
      ON seasons.league_id = leagues.id
     AND seasons.id = NEW.season_id
    WHERE leagues.id = NEW.league_id
      AND leagues.status = 'active'
      AND leagues.current_season_id = NEW.season_id
      AND seasons.status = 'active'
      AND seasons.free_agent_draft_completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD target must be the current active unfinished league season'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
      AND matchup_weeks.id = NEW.first_matchup_week_id
      AND matchup_weeks.sequence = 1
      AND matchup_weeks.starts_at_ms =
        NEW.first_matchup_starts_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD Week 1 must be the target season sequence-1 week'
  ) END;

  SELECT CASE WHEN
    NEW.participating_team_count <> (
      SELECT COUNT(*)
      FROM teams
      WHERE teams.league_id = NEW.league_id
        AND teams.status = 'active'
    )
    OR EXISTS (
      SELECT 1
      FROM teams
      WHERE teams.league_id = NEW.league_id
        AND teams.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM team_manager_assignments
          JOIN league_memberships
            ON league_memberships.league_id =
                team_manager_assignments.league_id
           AND league_memberships.id =
                team_manager_assignments.membership_id
           AND league_memberships.user_id =
                team_manager_assignments.user_id
          WHERE team_manager_assignments.league_id =
              teams.league_id
            AND team_manager_assignments.team_id = teams.id
            AND team_manager_assignments.status = 'accepted'
            AND team_manager_assignments.ended_at_ms IS NULL
            AND league_memberships.status = 'active'
        )
    )
  THEN RAISE(
    ABORT,
    'FAD participating-team commitment must include every active managed team'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id = NEW.opened_by_membership_id
      AND league_memberships.user_id = NEW.opened_by_user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'FAD opener must have active league membership'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.opened_authority = 'commissioner'
      AND EXISTS (
        SELECT 1
        FROM leagues
        WHERE leagues.id = NEW.league_id
          AND leagues.commissioner_membership_id =
            NEW.opened_by_membership_id
      )
    )
    OR (
      NEW.opened_authority =
        'platform_administrator_as_commissioner'
      AND EXISTS (
        SELECT 1
        FROM platform_roles
        WHERE platform_roles.user_id = NEW.opened_by_user_id
          AND platform_roles.role = 'platform_administrator'
          AND platform_roles.status = 'active'
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD opener lacks recorded commissioner authority'
  ) END;

  SELECT CASE WHEN
    NEW.setup_path = 'completed_entry_draft'
    AND NOT EXISTS (
      SELECT 1
      FROM entry_drafts
      WHERE entry_drafts.league_id = NEW.league_id
        AND entry_drafts.season_id = NEW.season_id
        AND entry_drafts.id = NEW.entry_draft_id
        AND entry_drafts.status = 'completed'
        AND entry_drafts.completed_at_ms IS NOT NULL
        AND entry_drafts.completed_at_ms <= NEW.opened_at_ms
    )
  THEN RAISE(
    ABORT,
    'FAD setup requires the completed target-season Entry Draft'
  ) END;

  SELECT CASE WHEN
    NEW.setup_path = 'no_draft_inaugural'
    AND (
      (
        SELECT COUNT(*)
        FROM seasons
        WHERE seasons.league_id = NEW.league_id
      ) <> 1
      OR EXISTS (
        SELECT 1
        FROM entry_drafts
        WHERE entry_drafts.league_id = NEW.league_id
          AND entry_drafts.season_id = NEW.season_id
      )
      OR (
        EXISTS (
          SELECT 1
          FROM seasons
          WHERE seasons.league_id = NEW.league_id
            AND seasons.id = NEW.season_id
            AND seasons.nhl_season_key = '20262027'
        )
        AND EXISTS (
          SELECT 1
          FROM migration_reports
          WHERE migration_reports.league_id = NEW.league_id
            AND migration_reports.status = 'succeeded'
            AND migration_reports.completed_at_ms IS NOT NULL
            AND migration_reports.reset_manifest_id =
              '2026-season-1-reset-v1'
            AND migration_reports.database_schema_version >= 1
            AND json_valid(migration_reports.source_hashes_json) = 1
            AND json_type(migration_reports.source_hashes_json) =
              'object'
            AND json_valid(migration_reports.counts_json) = 1
            AND json_type(migration_reports.counts_json) = 'object'
            AND json_valid(migration_reports.totals_json) = 1
            AND json_type(migration_reports.totals_json) = 'object'
            AND json_valid(migration_reports.warnings_json) = 1
            AND json_type(migration_reports.warnings_json) = 'array'
            AND json_valid(migration_reports.rejects_json) = 1
            AND json_type(migration_reports.rejects_json) = 'array'
            AND json_array_length(migration_reports.rejects_json) = 0
        )
      )
    )
  THEN RAISE(
    ABORT,
    'inaugural no-draft setup requires the league first season'
  ) END;

  SELECT CASE WHEN
    NEW.setup_path = 'no_draft_initial_season2'
    AND (
      EXISTS (
        SELECT 1
        FROM entry_drafts
        WHERE entry_drafts.league_id = NEW.league_id
          AND entry_drafts.season_id = NEW.season_id
      )
      OR NOT EXISTS (
        SELECT 1
        FROM seasons
        WHERE seasons.league_id = NEW.league_id
          AND seasons.id = NEW.season_id
          AND seasons.nhl_season_key = '20262027'
      )
      OR (
        SELECT COUNT(*)
        FROM migration_reports
        WHERE migration_reports.league_id = NEW.league_id
          AND migration_reports.status = 'succeeded'
          AND migration_reports.completed_at_ms IS NOT NULL
          AND migration_reports.reset_manifest_id =
            '2026-season-1-reset-v1'
          AND migration_reports.database_schema_version >= 1
          AND json_valid(migration_reports.source_hashes_json) = 1
          AND json_type(migration_reports.source_hashes_json) =
            'object'
          AND json_valid(migration_reports.counts_json) = 1
          AND json_type(migration_reports.counts_json) = 'object'
          AND json_valid(migration_reports.totals_json) = 1
          AND json_type(migration_reports.totals_json) = 'object'
          AND json_valid(migration_reports.warnings_json) = 1
          AND json_type(migration_reports.warnings_json) = 'array'
          AND json_valid(migration_reports.rejects_json) = 1
          AND json_type(migration_reports.rejects_json) = 'array'
          AND json_array_length(migration_reports.rejects_json) = 0
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_setup_exemptions
        JOIN migration_reports
          ON migration_reports.league_id =
              free_agent_draft_setup_exemptions.league_id
         AND migration_reports.id =
              free_agent_draft_setup_exemptions.migration_report_id
        WHERE free_agent_draft_setup_exemptions.league_id =
            NEW.league_id
          AND free_agent_draft_setup_exemptions.season_id =
            NEW.season_id
          AND free_agent_draft_setup_exemptions.id =
            NEW.setup_exemption_id
          AND free_agent_draft_setup_exemptions.exemption_kind =
            'initial_season2_transition'
          AND free_agent_draft_setup_exemptions.reason =
            NEW.no_draft_reason
          AND free_agent_draft_setup_exemptions.consumed_fad_id
            IS NULL
          AND free_agent_draft_setup_exemptions.consumed_at_ms
            IS NULL
          AND free_agent_draft_setup_exemptions.updated_at_ms <=
            NEW.opened_at_ms
          AND migration_reports.status = 'succeeded'
          AND migration_reports.completed_at_ms IS NOT NULL
          AND migration_reports.reset_manifest_id =
            '2026-season-1-reset-v1'
          AND migration_reports.database_schema_version >= 1
          AND json_valid(migration_reports.source_hashes_json) = 1
          AND json_type(migration_reports.source_hashes_json) =
            'object'
          AND json_valid(migration_reports.counts_json) = 1
          AND json_type(migration_reports.counts_json) = 'object'
          AND json_valid(migration_reports.totals_json) = 1
          AND json_type(migration_reports.totals_json) = 'object'
          AND json_valid(migration_reports.warnings_json) = 1
          AND json_type(migration_reports.warnings_json) = 'array'
          AND json_valid(migration_reports.rejects_json) = 1
          AND json_type(migration_reports.rejects_json) = 'array'
          AND json_array_length(migration_reports.rejects_json) = 0
      )
    )
  THEN RAISE(
    ABORT,
    'initial Season 2 setup requires its unused exemption'
  ) END;

  SELECT CASE WHEN (
    EXISTS (
      SELECT 1
      FROM seasons
      WHERE seasons.league_id = NEW.league_id
        AND seasons.id <> NEW.season_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM season_rollovers
      WHERE season_rollovers.league_id = NEW.league_id
        AND season_rollovers.to_season_id = NEW.season_id
        AND season_rollovers.id =
          NEW.prior_season_rollover_id
        AND season_rollovers.status = 'succeeded'
        AND season_rollovers.completed_at_ms <= NEW.opened_at_ms
    )
  ) OR (
    NOT EXISTS (
      SELECT 1
      FROM seasons
      WHERE seasons.league_id = NEW.league_id
        AND seasons.id <> NEW.season_id
    )
    AND NEW.prior_season_rollover_id IS NOT NULL
  ) THEN RAISE(
    ABORT,
    'FAD prior-season rollover evidence does not match the target season'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_consume_setup_exemption
AFTER INSERT ON free_agent_drafts
WHEN NEW.setup_path = 'no_draft_initial_season2'
BEGIN
  UPDATE free_agent_draft_setup_exemptions
  SET consumed_fad_id = NEW.id,
      consumed_at_ms = NEW.opened_at_ms,
      updated_at_ms = NEW.opened_at_ms,
      version = version + 1
  WHERE league_id = NEW.league_id
    AND season_id = NEW.season_id
    AND id = NEW.setup_exemption_id;
END;

CREATE TRIGGER free_agent_drafts_forward_update
BEFORE UPDATE ON free_agent_drafts
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.first_matchup_week_id IS OLD.first_matchup_week_id
    AND NEW.participating_team_count IS
      OLD.participating_team_count
    AND NEW.setup_path IS OLD.setup_path
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.setup_exemption_id IS OLD.setup_exemption_id
    AND NEW.prior_season_rollover_id IS
      OLD.prior_season_rollover_id
    AND NEW.no_draft_reason IS OLD.no_draft_reason
    AND NEW.opened_by_user_id IS OLD.opened_by_user_id
    AND NEW.opened_by_membership_id IS
      OLD.opened_by_membership_id
    AND NEW.opened_authority IS OLD.opened_authority
    AND NEW.opened_at_ms IS OLD.opened_at_ms
    AND NEW.help_opens_at_ms IS OLD.help_opens_at_ms
    AND NEW.candidate_deadline_at_ms IS
      OLD.candidate_deadline_at_ms
    AND NEW.first_matchup_starts_at_ms IS
      OLD.first_matchup_starts_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'cards_open'
        AND NEW.status = 'deadline_locked'
        AND OLD.deadline_locked_at_ms IS NULL
        AND NEW.deadline_locked_at_ms >=
          NEW.candidate_deadline_at_ms
        AND NEW.updated_at_ms = NEW.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status = 'deadline_locked'
        AND NEW.status = 'allocating'
        AND NEW.deadline_locked_at_ms IS
          OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status IN ('deadline_locked', 'allocating')
        AND NEW.status = 'rapid'
        AND NEW.deadline_locked_at_ms IS
          OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS NOT NULL
        AND NEW.updated_at_ms =
          NEW.allocation_completed_at_ms
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status = 'rapid'
        AND NEW.status = 'completed'
        AND NEW.deadline_locked_at_ms IS
          OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS
          OLD.allocation_completed_at_ms
        AND NEW.completed_at_ms IS NOT NULL
        AND NEW.updated_at_ms = NEW.completed_at_ms
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD may only advance through its frozen lifecycle'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_immutable_delete
BEFORE DELETE ON free_agent_drafts
BEGIN
  SELECT RAISE(ABORT, 'FAD evidence cannot be deleted');
END;

CREATE TRIGGER free_agent_draft_setup_exemptions_consumed_fad_reference
BEFORE UPDATE OF consumed_fad_id, consumed_at_ms
  ON free_agent_draft_setup_exemptions
WHEN NEW.consumed_fad_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_drafts
    WHERE free_agent_drafts.id = NEW.consumed_fad_id
      AND free_agent_drafts.league_id = NEW.league_id
      AND free_agent_drafts.season_id = NEW.season_id
      AND free_agent_drafts.setup_path =
        'no_draft_initial_season2'
      AND free_agent_drafts.setup_exemption_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'consumed exemption must reference its same-season FAD'
  ) END;
END;

CREATE TRIGGER matchup_weeks_fad_clock_frozen_update
BEFORE UPDATE OF league_id, season_id, sequence, starts_at_ms
  ON matchup_weeks
WHEN EXISTS (
  SELECT 1
  FROM free_agent_drafts
  WHERE free_agent_drafts.league_id = OLD.league_id
    AND free_agent_drafts.first_matchup_week_id = OLD.id
)
AND (
  NEW.league_id IS NOT OLD.league_id
  OR NEW.season_id IS NOT OLD.season_id
  OR NEW.sequence IS NOT OLD.sequence
  OR NEW.starts_at_ms IS NOT OLD.starts_at_ms
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD Week 1 clock is frozen after Candidate Cards open'
  );
END;

CREATE TABLE free_agent_draft_teams (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_status_at_setup TEXT NOT NULL
    CHECK (team_status_at_setup = 'active'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, team_id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX free_agent_draft_teams_league_fad
  ON free_agent_draft_teams (league_id, season_id, fad_id);

CREATE TRIGGER free_agent_draft_teams_participant_insert
BEFORE INSERT ON free_agent_draft_teams
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_teams
    WHERE free_agent_draft_teams.league_id = NEW.league_id
      AND free_agent_draft_teams.fad_id = NEW.fad_id
  ) >= (
    SELECT free_agent_drafts.participating_team_count
    FROM free_agent_drafts
    WHERE free_agent_drafts.league_id = NEW.league_id
      AND free_agent_drafts.id = NEW.fad_id
  ) THEN RAISE(
    ABORT,
    'FAD participating-team commitment is already complete'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_drafts
    WHERE free_agent_drafts.league_id = NEW.league_id
      AND free_agent_drafts.season_id = NEW.season_id
      AND free_agent_drafts.id = NEW.fad_id
      AND free_agent_drafts.status = 'cards_open'
      AND free_agent_drafts.opened_at_ms = NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD participant must be frozen during setup'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM teams
    WHERE teams.league_id = NEW.league_id
      AND teams.id = NEW.team_id
      AND teams.status = NEW.team_status_at_setup
  ) THEN RAISE(
    ABORT,
    'FAD participant must be an active same-league team'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM team_manager_assignments
    JOIN league_memberships
      ON league_memberships.league_id =
          team_manager_assignments.league_id
     AND league_memberships.id =
          team_manager_assignments.membership_id
     AND league_memberships.user_id =
          team_manager_assignments.user_id
    WHERE team_manager_assignments.league_id = NEW.league_id
      AND team_manager_assignments.team_id = NEW.team_id
      AND team_manager_assignments.status = 'accepted'
      AND team_manager_assignments.ended_at_ms IS NULL
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'FAD participant requires a current accepted manager'
  ) END;
END;

CREATE TRIGGER free_agent_draft_teams_immutable_update
BEFORE UPDATE ON free_agent_draft_teams
BEGIN
  SELECT RAISE(ABORT, 'FAD participant snapshot is immutable');
END;

CREATE TRIGGER free_agent_draft_teams_immutable_delete
BEFORE DELETE ON free_agent_draft_teams
BEGIN
  SELECT RAISE(ABORT, 'FAD participant snapshot is immutable');
END;

CREATE TABLE candidate_cards (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'open',
        'locked_complete',
        'locked_incomplete',
        'locked_conflicted'
      )
    ),
  completeness_code TEXT NOT NULL
    CHECK (
      completeness_code IN (
        'complete',
        'incomplete',
        'conflicted'
      )
    ),
  filled_mandatory_count INTEGER NOT NULL
    CHECK (filled_mandatory_count BETWEEN 0 AND 18),
  missing_mandatory_count INTEGER NOT NULL
    CHECK (missing_mandatory_count BETWEEN 0 AND 18),
  filled_bench_count INTEGER NOT NULL
    CHECK (filled_bench_count BETWEEN 0 AND 4),
  empty_bench_count INTEGER NOT NULL
    CHECK (empty_bench_count BETWEEN 0 AND 4),
  blocking_validation_count INTEGER NOT NULL
    CHECK (blocking_validation_count >= 0),
  structural_conflict_count INTEGER NOT NULL
    CHECK (structural_conflict_count >= 0),
  maximum_possible_cap_cents INTEGER NOT NULL
    CHECK (maximum_possible_cap_cents >= 0),
  locked_at_ms INTEGER CHECK (locked_at_ms IS NULL OR locked_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, team_id),
  UNIQUE (league_id, season_id, fad_id, id, team_id),
  FOREIGN KEY (league_id, season_id, fad_id, team_id)
    REFERENCES free_agent_draft_teams(
      league_id,
      season_id,
      fad_id,
      team_id
    ) ON DELETE RESTRICT,
  CHECK (filled_mandatory_count + missing_mandatory_count = 18),
  CHECK (filled_bench_count + empty_bench_count = 4),
  CHECK (
    (
      completeness_code = 'complete'
      AND missing_mandatory_count = 0
      AND blocking_validation_count = 0
      AND structural_conflict_count = 0
    )
    OR (
      completeness_code = 'incomplete'
      AND structural_conflict_count = 0
      AND (
        missing_mandatory_count > 0
        OR blocking_validation_count > 0
      )
    )
    OR (
      completeness_code = 'conflicted'
      AND structural_conflict_count > 0
    )
  ),
  CHECK (
    (
      status = 'open'
      AND locked_at_ms IS NULL
    )
    OR (
      status = 'locked_complete'
      AND completeness_code = 'complete'
      AND locked_at_ms IS NOT NULL
    )
    OR (
      status = 'locked_incomplete'
      AND completeness_code = 'incomplete'
      AND locked_at_ms IS NOT NULL
    )
    OR (
      status = 'locked_conflicted'
      AND completeness_code = 'conflicted'
      AND locked_at_ms IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX candidate_cards_league_fad_status
  ON candidate_cards (league_id, fad_id, status);

CREATE TRIGGER candidate_cards_setup_insert
BEFORE INSERT ON candidate_cards
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'open'
    AND NEW.locked_at_ms IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status = 'cards_open'
        AND free_agent_drafts.opened_at_ms = NEW.created_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'Candidate Card must begin open at FAD setup'
  ) END;
END;

CREATE TRIGGER candidate_cards_open_update
BEFORE UPDATE ON candidate_cards
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'open'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        NEW.status = 'open'
        AND NEW.locked_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'cards_open'
        )
      )
      OR (
        NEW.status IN (
          'locked_complete',
          'locked_incomplete',
          'locked_conflicted'
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'cards_open'
            AND NEW.locked_at_ms =
              free_agent_drafts.candidate_deadline_at_ms
            AND NEW.updated_at_ms >=
              free_agent_drafts.candidate_deadline_at_ms
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate Card may only advance once from its open state'
  ) END;
END;

CREATE TRIGGER candidate_cards_immutable_delete
BEFORE DELETE ON candidate_cards
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card cannot be deleted');
END;

CREATE TABLE candidate_card_revisions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  resulting_card_version INTEGER NOT NULL
    CHECK (resulting_card_version >= 1),
  action TEXT NOT NULL
    CHECK (
      action IN (
        'card_opened',
        'candidate_added',
        'candidate_edited',
        'candidate_moved',
        'candidate_removed',
        'carryover_synchronized',
        'eligibility_revalidated',
        'summer_state_synchronized',
        'deadline_locked'
      )
    ),
  affected_entry_id TEXT
    CHECK (
      affected_entry_id IS NULL
      OR (
        length(affected_entry_id) = 36
        AND affected_entry_id = lower(affected_entry_id)
      )
    ),
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  before_evidence_json TEXT NOT NULL
    CHECK (
      length(before_evidence_json) BETWEEN 2 AND 65536
      AND json_valid(before_evidence_json) = 1
      AND json_type(before_evidence_json) = 'object'
    ),
  after_evidence_json TEXT NOT NULL
    CHECK (
      length(after_evidence_json) BETWEEN 2 AND 65536
      AND json_valid(after_evidence_json) = 1
      AND json_type(after_evidence_json) = 'object'
    ),
  potential_illegality_acknowledged INTEGER NOT NULL
    CHECK (potential_illegality_acknowledged IN (0, 1)),
  warning_codes_json TEXT NOT NULL
    CHECK (
      length(warning_codes_json) BETWEEN 2 AND 8192
      AND json_valid(warning_codes_json) = 1
      AND json_type(warning_codes_json) = 'array'
    ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= occurred_at_ms),
  UNIQUE (league_id, id),
  UNIQUE (league_id, card_id, resulting_card_version),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ),
  FOREIGN KEY (league_id, season_id, fad_id, card_id, team_id)
    REFERENCES candidate_cards(
      league_id,
      season_id,
      fad_id,
      id,
      team_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      actor_authority = 'system'
      AND actor_user_id IS NULL
      AND actor_membership_id IS NULL
    )
    OR (
      actor_authority <> 'system'
      AND actor_user_id IS NOT NULL
      AND actor_membership_id IS NOT NULL
    )
  ),
  CHECK (
    action NOT IN ('card_opened', 'deadline_locked')
    OR (
      affected_entry_id IS NULL
      AND player_id IS NULL
    )
  ),
  CHECK (
    action NOT IN (
      'candidate_added',
      'candidate_edited',
      'candidate_moved',
      'candidate_removed'
    )
    OR (
      affected_entry_id IS NOT NULL
      AND player_id IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX candidate_card_revisions_league_card_time
  ON candidate_card_revisions (
    league_id,
    card_id,
    occurred_at_ms
  );

CREATE INDEX candidate_card_revisions_league_actor_time
  ON candidate_card_revisions (
    league_id,
    card_id,
    actor_authority,
    occurred_at_ms
  );

CREATE TRIGGER candidate_card_revisions_authority_insert
BEFORE INSERT ON candidate_card_revisions
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.warning_codes_json)
    WHERE json_each.type <> 'text'
      OR json_each.value <> trim(json_each.value)
      OR length(json_each.value) NOT BETWEEN 1 AND 100
      OR json_each.value GLOB '*[^A-Z0-9_]*'
  ) THEN RAISE(
    ABORT,
    'Candidate Card warning codes must be safe strings'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_cards
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.season_id = NEW.season_id
      AND candidate_cards.fad_id = NEW.fad_id
      AND candidate_cards.id = NEW.card_id
      AND candidate_cards.team_id = NEW.team_id
      AND candidate_cards.version = NEW.resulting_card_version
  ) THEN RAISE(
    ABORT,
    'Candidate Card revision must match the resulting card version'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_cards
    JOIN free_agent_drafts
      ON free_agent_drafts.league_id =
          candidate_cards.league_id
     AND free_agent_drafts.season_id =
          candidate_cards.season_id
     AND free_agent_drafts.id = candidate_cards.fad_id
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.id = NEW.card_id
      AND (
        (
          NEW.action = 'card_opened'
          AND candidate_cards.status = 'open'
          AND free_agent_drafts.status = 'cards_open'
          AND NEW.occurred_at_ms = free_agent_drafts.opened_at_ms
        )
        OR (
          NEW.action = 'deadline_locked'
          AND candidate_cards.status IN (
            'locked_complete',
            'locked_incomplete',
            'locked_conflicted'
          )
          AND NEW.occurred_at_ms >=
            free_agent_drafts.candidate_deadline_at_ms
        )
        OR (
          NEW.action NOT IN ('card_opened', 'deadline_locked')
          AND candidate_cards.status = 'open'
          AND free_agent_drafts.status = 'cards_open'
          AND (
            NEW.actor_authority = 'system'
            OR NEW.occurred_at_ms <
              free_agent_drafts.candidate_deadline_at_ms
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'Candidate Card revision is outside its lifecycle phase'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority = 'system'
    AND NEW.action NOT IN (
      'card_opened',
      'carryover_synchronized',
      'eligibility_revalidated',
      'summer_state_synchronized',
      'deadline_locked'
    )
  THEN RAISE(
    ABORT,
    'system cannot perform a manager Candidate action'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority <> 'system'
    AND NOT EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id = NEW.actor_membership_id
        AND league_memberships.user_id = NEW.actor_user_id
        AND league_memberships.status = 'active'
    )
  THEN RAISE(
    ABORT,
    'Candidate Card revision actor must have active membership'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority = 'manager'
    AND NOT EXISTS (
      SELECT 1
      FROM team_manager_assignments
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.user_id = NEW.actor_user_id
        AND team_manager_assignments.membership_id =
          NEW.actor_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
    )
  THEN RAISE(
    ABORT,
    'Candidate Card revision actor is not the current manager'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority IN (
      'commissioner',
      'platform_administrator_as_commissioner'
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM candidate_card_help_requests
        WHERE candidate_card_help_requests.league_id =
            NEW.league_id
          AND candidate_card_help_requests.fad_id = NEW.fad_id
          AND candidate_card_help_requests.card_id = NEW.card_id
          AND candidate_card_help_requests.team_id = NEW.team_id
          AND candidate_card_help_requests.status = 'active'
          AND NEW.occurred_at_ms <
            candidate_card_help_requests.expires_at_ms
      )
      OR (
        NEW.actor_authority = 'commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.actor_membership_id
        )
      )
      OR (
        NEW.actor_authority =
          'platform_administrator_as_commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = NEW.actor_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  THEN RAISE(
    ABORT,
    'commissioner Candidate edit requires active help authority'
  ) END;

  SELECT CASE WHEN
    (
      NEW.action = 'card_opened'
      AND NOT (
        NEW.actor_authority = 'system'
        AND NEW.resulting_card_version = 1
      )
    )
    OR (
      NEW.action = 'deadline_locked'
      AND NOT (
        NEW.actor_authority = 'system'
        AND EXISTS (
          SELECT 1
          FROM candidate_cards
          WHERE candidate_cards.league_id = NEW.league_id
            AND candidate_cards.id = NEW.card_id
            AND candidate_cards.status IN (
              'locked_complete',
              'locked_incomplete',
              'locked_conflicted'
            )
        )
      )
    )
  THEN RAISE(
    ABORT,
    'Candidate Card lifecycle revision has invalid authority'
  ) END;
END;

CREATE TRIGGER candidate_card_revisions_immutable_update
BEFORE UPDATE ON candidate_card_revisions
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card revision is immutable');
END;

CREATE TRIGGER candidate_card_revisions_immutable_delete
BEFORE DELETE ON candidate_card_revisions
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card revision is immutable');
END;

CREATE TABLE candidate_card_entries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL
    CHECK (entry_kind IN ('carryover', 'candidate')),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  effective_position_group TEXT NOT NULL
    CHECK (effective_position_group IN ('F', 'D')),
  requested_slot_group TEXT NOT NULL
    CHECK (requested_slot_group IN ('F', 'D', 'B')),
  requested_slot_number INTEGER NOT NULL,
  placement_state TEXT NOT NULL
    CHECK (placement_state IN ('placed', 'conflict')),
  conflict_code TEXT
    CHECK (
      conflict_code IS NULL
      OR (
        conflict_code = trim(conflict_code)
        AND length(conflict_code) BETWEEN 1 AND 100
        AND conflict_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  carryover_ownership_id TEXT
    CHECK (
      carryover_ownership_id IS NULL
      OR (
        length(carryover_ownership_id) = 36
        AND carryover_ownership_id = lower(carryover_ownership_id)
      )
    ),
  carryover_contract_id TEXT,
  source_roster_category TEXT
    CHECK (
      source_roster_category IS NULL
      OR source_roster_category IN (
        'Active',
        'Bench',
        'Injured Reserve'
      )
    ),
  carryover_original_total_value_cents INTEGER
    CHECK (
      carryover_original_total_value_cents IS NULL
      OR carryover_original_total_value_cents > 0
    ),
  carryover_original_term_years INTEGER
    CHECK (
      carryover_original_term_years IS NULL
      OR carryover_original_term_years BETWEEN 1 AND 3
    ),
  carryover_aav_cents INTEGER
    CHECK (carryover_aav_cents IS NULL OR carryover_aav_cents > 0),
  remaining_years INTEGER
    CHECK (remaining_years IS NULL OR remaining_years BETWEEN 1 AND 3),
  proposed_total_value_cents INTEGER
    CHECK (
      proposed_total_value_cents IS NULL
      OR proposed_total_value_cents > 0
    ),
  proposed_term_years INTEGER
    CHECK (
      proposed_term_years IS NULL
      OR proposed_term_years BETWEEN 1 AND 3
    ),
  proposed_aav_cents INTEGER
    CHECK (proposed_aav_cents IS NULL OR proposed_aav_cents > 0),
  eligibility_status TEXT
    CHECK (
      eligibility_status IS NULL
      OR eligibility_status IN ('valid', 'warning', 'invalid')
    ),
  validation_code TEXT
    CHECK (
      validation_code IS NULL
      OR (
        validation_code = trim(validation_code)
        AND length(validation_code) BETWEEN 1 AND 100
        AND validation_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  last_acknowledgement_revision_id TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_by_membership_id TEXT,
  created_by_authority TEXT NOT NULL
    CHECK (
      created_by_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  last_edited_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  last_edited_by_membership_id TEXT,
  last_edited_by_authority TEXT NOT NULL
    CHECK (
      last_edited_by_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, card_id, player_id),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ),
  FOREIGN KEY (league_id, season_id, fad_id, card_id, team_id)
    REFERENCES candidate_cards(
      league_id,
      season_id,
      fad_id,
      id,
      team_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, carryover_contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    last_acknowledgement_revision_id
  ) REFERENCES candidate_card_revisions(
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, created_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, last_edited_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      requested_slot_group = 'F'
      AND requested_slot_number BETWEEN 1 AND 12
      AND effective_position_group = 'F'
    )
    OR (
      requested_slot_group = 'D'
      AND requested_slot_number BETWEEN 1 AND 6
      AND effective_position_group = 'D'
    )
    OR (
      requested_slot_group = 'B'
      AND requested_slot_number BETWEEN 1 AND 4
    )
  ),
  CHECK (
    (
      placement_state = 'placed'
      AND conflict_code IS NULL
    )
    OR (
      placement_state = 'conflict'
      AND conflict_code IS NOT NULL
    )
  ),
  CHECK (
    (
      entry_kind = 'carryover'
      AND carryover_ownership_id IS NOT NULL
      AND carryover_contract_id IS NOT NULL
      AND source_roster_category IS NOT NULL
      AND carryover_original_total_value_cents IS NOT NULL
      AND carryover_original_term_years IS NOT NULL
      AND carryover_aav_cents IS NOT NULL
      AND remaining_years IS NOT NULL
      AND remaining_years <= carryover_original_term_years
      AND proposed_total_value_cents IS NULL
      AND proposed_term_years IS NULL
      AND proposed_aav_cents IS NULL
      AND eligibility_status IS NULL
      AND validation_code IS NULL
      AND last_acknowledgement_revision_id IS NULL
    )
    OR (
      entry_kind = 'candidate'
      AND carryover_ownership_id IS NULL
      AND carryover_contract_id IS NULL
      AND source_roster_category IS NULL
      AND carryover_original_total_value_cents IS NULL
      AND carryover_original_term_years IS NULL
      AND carryover_aav_cents IS NULL
      AND remaining_years IS NULL
      AND proposed_total_value_cents IS NOT NULL
      AND proposed_term_years IS NOT NULL
      AND proposed_aav_cents IS NOT NULL
      AND proposed_aav_cents >= 100
      AND eligibility_status IS NOT NULL
      AND (
        (
          eligibility_status = 'valid'
          AND validation_code IS NULL
        )
        OR (
          eligibility_status IN ('warning', 'invalid')
          AND validation_code IS NOT NULL
        )
      )
      AND proposed_aav_cents =
        (proposed_total_value_cents / proposed_term_years)
        + CASE
          WHEN
            (proposed_total_value_cents % proposed_term_years) * 2
              >= proposed_term_years
          THEN 1
          ELSE 0
        END
      AND (
        proposed_term_years = 1
        OR proposed_total_value_cents % 100 = 0
      )
    )
  ),
  CHECK (
    requested_slot_group <> 'B'
    OR placement_state = 'conflict'
    OR COALESCE(proposed_aav_cents, carryover_aav_cents) <= 400
  ),
  CHECK (
    entry_kind <> 'candidate'
    OR created_by_authority <> 'system'
  ),
  CHECK (
    entry_kind <> 'carryover'
    OR created_by_authority = 'system'
  ),
  CHECK (
    entry_kind <> 'carryover'
    OR (
      source_roster_category = 'Active'
      AND requested_slot_group = effective_position_group
    )
    OR (
      source_roster_category = 'Bench'
      AND requested_slot_group = 'B'
    )
    OR (
      source_roster_category = 'Injured Reserve'
      AND requested_slot_group = effective_position_group
    )
  ),
  CHECK (
    (
      created_by_authority = 'system'
      AND created_by_user_id IS NULL
      AND created_by_membership_id IS NULL
    )
    OR (
      created_by_authority <> 'system'
      AND created_by_user_id IS NOT NULL
      AND created_by_membership_id IS NOT NULL
    )
  ),
  CHECK (
    (
      last_edited_by_authority = 'system'
      AND last_edited_by_user_id IS NULL
      AND last_edited_by_membership_id IS NULL
    )
    OR (
      last_edited_by_authority <> 'system'
      AND last_edited_by_user_id IS NOT NULL
      AND last_edited_by_membership_id IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX candidate_card_entries_one_placed_slot
  ON candidate_card_entries (
    league_id,
    card_id,
    requested_slot_group,
    requested_slot_number
  )
  WHERE placement_state = 'placed';

CREATE INDEX candidate_card_entries_league_fad_player
  ON candidate_card_entries (league_id, fad_id, player_id);

CREATE INDEX candidate_card_entries_league_card_placement
  ON candidate_card_entries (
    league_id,
    card_id,
    placement_state
  );

CREATE TRIGGER candidate_card_entries_open_insert
BEFORE INSERT ON candidate_card_entries
BEGIN
  SELECT CASE WHEN
    NEW.entry_kind = 'candidate'
    AND NEW.placement_state <> 'placed'
  THEN RAISE(
    ABORT,
    'new selectable Candidate entry must begin placed'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.last_edited_by_user_id IS NEW.created_by_user_id
    AND NEW.last_edited_by_membership_id IS
      NEW.created_by_membership_id
    AND NEW.last_edited_by_authority IS NEW.created_by_authority
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id =
            candidate_cards.league_id
       AND free_agent_drafts.season_id =
            candidate_cards.season_id
       AND free_agent_drafts.id = candidate_cards.fad_id
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.season_id = NEW.season_id
        AND candidate_cards.fad_id = NEW.fad_id
        AND candidate_cards.id = NEW.card_id
        AND candidate_cards.team_id = NEW.team_id
        AND candidate_cards.status = 'open'
        AND free_agent_drafts.status = 'cards_open'
        AND (
          NEW.created_by_authority = 'system'
          OR NEW.created_at_ms <
            free_agent_drafts.candidate_deadline_at_ms
        )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate entry insert requires an open pre-deadline card'
  ) END;

  SELECT CASE WHEN
    NEW.entry_kind = 'carryover'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM player_ownerships
        WHERE player_ownerships.id =
            NEW.carryover_ownership_id
          AND player_ownerships.league_id = NEW.league_id
          AND player_ownerships.season_id = NEW.season_id
          AND player_ownerships.team_id = NEW.team_id
          AND player_ownerships.player_id = NEW.player_id
          AND player_ownerships.ownership_kind = 'Rostered'
          AND player_ownerships.roster_category =
            NEW.source_roster_category
          AND player_ownerships.position_group =
            NEW.effective_position_group
          AND (
            player_ownerships.roster_category =
              'Injured Reserve'
            OR player_ownerships.slot_number IS NULL
            OR player_ownerships.slot_number =
              NEW.requested_slot_number
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM contracts
        WHERE contracts.id = NEW.carryover_contract_id
          AND contracts.league_id = NEW.league_id
          AND contracts.player_id = NEW.player_id
          AND contracts.current_team_id = NEW.team_id
          AND contracts.status = 'active'
          AND contracts.original_total_value_cents =
            NEW.carryover_original_total_value_cents
          AND contracts.original_term_years =
            NEW.carryover_original_term_years
          AND contracts.aav_cents = NEW.carryover_aav_cents
      )
      OR NOT EXISTS (
        SELECT 1
        FROM contract_years
        WHERE contract_years.league_id = NEW.league_id
          AND contract_years.contract_id =
            NEW.carryover_contract_id
          AND contract_years.season_id = NEW.season_id
          AND contract_years.status = 'current'
      )
      OR NEW.remaining_years <> (
        SELECT COUNT(*)
        FROM contract_years
        WHERE contract_years.league_id = NEW.league_id
          AND contract_years.contract_id =
            NEW.carryover_contract_id
          AND contract_years.status IN ('current', 'future')
      )
    )
  THEN RAISE(
    ABORT,
    'carryover entry must copy current ownership and contract evidence'
  ) END;
END;

CREATE TRIGGER candidate_card_entries_acknowledgement_insert
BEFORE INSERT ON candidate_card_entries
WHEN NEW.last_acknowledgement_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM candidate_card_revisions
    WHERE candidate_card_revisions.league_id = NEW.league_id
      AND candidate_card_revisions.season_id = NEW.season_id
      AND candidate_card_revisions.fad_id = NEW.fad_id
      AND candidate_card_revisions.card_id = NEW.card_id
      AND candidate_card_revisions.team_id = NEW.team_id
      AND candidate_card_revisions.id =
        NEW.last_acknowledgement_revision_id
      AND candidate_card_revisions.action IN (
        'candidate_added',
        'candidate_edited',
        'candidate_moved'
      )
      AND candidate_card_revisions.affected_entry_id = NEW.id
      AND candidate_card_revisions.player_id = NEW.player_id
      AND candidate_card_revisions.potential_illegality_acknowledged = 1
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Candidate acknowledgement must reference its accepted revision'
  );
END;

CREATE TRIGGER candidate_card_entries_actor_insert
BEFORE INSERT ON candidate_card_entries
WHEN NEW.created_by_authority <> 'system'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id = NEW.created_by_membership_id
      AND league_memberships.user_id = NEW.created_by_user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'Candidate entry creator must have active membership'
  ) END;

  SELECT CASE WHEN
    NEW.created_by_authority = 'manager'
    AND NOT EXISTS (
      SELECT 1
      FROM team_manager_assignments
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.user_id =
          NEW.created_by_user_id
        AND team_manager_assignments.membership_id =
          NEW.created_by_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
    )
  THEN RAISE(
    ABORT,
    'Candidate entry creator is not the current manager'
  ) END;

  SELECT CASE WHEN
    NEW.created_by_authority IN (
      'commissioner',
      'platform_administrator_as_commissioner'
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM candidate_card_help_requests
        WHERE candidate_card_help_requests.league_id =
            NEW.league_id
          AND candidate_card_help_requests.fad_id = NEW.fad_id
          AND candidate_card_help_requests.card_id = NEW.card_id
          AND candidate_card_help_requests.team_id = NEW.team_id
          AND candidate_card_help_requests.status = 'active'
          AND NEW.created_at_ms <
            candidate_card_help_requests.expires_at_ms
      )
      OR (
        NEW.created_by_authority = 'commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.created_by_membership_id
        )
      )
      OR (
        NEW.created_by_authority =
          'platform_administrator_as_commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              NEW.created_by_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  THEN RAISE(
    ABORT,
    'commissioner Candidate entry requires active help'
  ) END;
END;

CREATE TRIGGER candidate_card_entries_actor_update
BEFORE UPDATE ON candidate_card_entries
WHEN NEW.last_edited_by_authority <> 'system'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id =
        NEW.last_edited_by_membership_id
      AND league_memberships.user_id =
        NEW.last_edited_by_user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'Candidate entry editor must have active membership'
  ) END;

  SELECT CASE WHEN
    NEW.last_edited_by_authority = 'manager'
    AND NOT EXISTS (
      SELECT 1
      FROM team_manager_assignments
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.user_id =
          NEW.last_edited_by_user_id
        AND team_manager_assignments.membership_id =
          NEW.last_edited_by_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
    )
  THEN RAISE(
    ABORT,
    'Candidate entry editor is not the current manager'
  ) END;

  SELECT CASE WHEN
    NEW.last_edited_by_authority IN (
      'commissioner',
      'platform_administrator_as_commissioner'
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM candidate_card_help_requests
        WHERE candidate_card_help_requests.league_id =
            NEW.league_id
          AND candidate_card_help_requests.fad_id = NEW.fad_id
          AND candidate_card_help_requests.card_id = NEW.card_id
          AND candidate_card_help_requests.team_id = NEW.team_id
          AND candidate_card_help_requests.status = 'active'
          AND NEW.updated_at_ms <
            candidate_card_help_requests.expires_at_ms
      )
      OR (
        NEW.last_edited_by_authority = 'commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.last_edited_by_membership_id
        )
      )
      OR (
        NEW.last_edited_by_authority =
          'platform_administrator_as_commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              NEW.last_edited_by_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  THEN RAISE(
    ABORT,
    'commissioner Candidate edit requires active help'
  ) END;
END;

CREATE TRIGGER candidate_card_entries_acknowledgement_update
BEFORE UPDATE OF last_acknowledgement_revision_id
  ON candidate_card_entries
WHEN NEW.last_acknowledgement_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM candidate_card_revisions
    WHERE candidate_card_revisions.league_id = NEW.league_id
      AND candidate_card_revisions.season_id = NEW.season_id
      AND candidate_card_revisions.fad_id = NEW.fad_id
      AND candidate_card_revisions.card_id = NEW.card_id
      AND candidate_card_revisions.team_id = NEW.team_id
      AND candidate_card_revisions.id =
        NEW.last_acknowledgement_revision_id
      AND candidate_card_revisions.action IN (
        'candidate_added',
        'candidate_edited',
        'candidate_moved'
      )
      AND candidate_card_revisions.affected_entry_id = NEW.id
      AND candidate_card_revisions.player_id = NEW.player_id
      AND candidate_card_revisions.potential_illegality_acknowledged = 1
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Candidate acknowledgement must reference its accepted revision'
  );
END;

CREATE TRIGGER candidate_card_entries_open_update
BEFORE UPDATE ON candidate_card_entries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.card_id IS OLD.card_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.entry_kind IS OLD.entry_kind
    AND NEW.player_id IS OLD.player_id
    AND NEW.created_by_user_id IS OLD.created_by_user_id
    AND NEW.created_by_membership_id IS
      OLD.created_by_membership_id
    AND NEW.created_by_authority IS OLD.created_by_authority
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND (
      OLD.entry_kind <> 'carryover'
      OR NEW.last_edited_by_authority = 'system'
    )
    AND (
      NEW.entry_kind <> 'candidate'
      OR NEW.placement_state <> 'conflict'
      OR NEW.last_edited_by_authority = 'system'
    )
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id =
            candidate_cards.league_id
       AND free_agent_drafts.id = candidate_cards.fad_id
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.id = NEW.card_id
        AND candidate_cards.status = 'open'
        AND free_agent_drafts.status = 'cards_open'
        AND (
          NEW.last_edited_by_authority = 'system'
          OR NEW.updated_at_ms <
            free_agent_drafts.candidate_deadline_at_ms
        )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate entry may only change on its open pre-deadline card'
  ) END;

  SELECT CASE WHEN
    NEW.entry_kind = 'carryover'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM player_ownerships
        WHERE player_ownerships.id =
            NEW.carryover_ownership_id
          AND player_ownerships.league_id = NEW.league_id
          AND player_ownerships.season_id = NEW.season_id
          AND player_ownerships.team_id = NEW.team_id
          AND player_ownerships.player_id = NEW.player_id
          AND player_ownerships.ownership_kind = 'Rostered'
          AND player_ownerships.roster_category =
            NEW.source_roster_category
          AND player_ownerships.position_group =
            NEW.effective_position_group
          AND (
            player_ownerships.roster_category =
              'Injured Reserve'
            OR player_ownerships.slot_number IS NULL
            OR player_ownerships.slot_number =
              NEW.requested_slot_number
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM contracts
        WHERE contracts.id = NEW.carryover_contract_id
          AND contracts.league_id = NEW.league_id
          AND contracts.player_id = NEW.player_id
          AND contracts.current_team_id = NEW.team_id
          AND contracts.status = 'active'
          AND contracts.original_total_value_cents =
            NEW.carryover_original_total_value_cents
          AND contracts.original_term_years =
            NEW.carryover_original_term_years
          AND contracts.aav_cents = NEW.carryover_aav_cents
      )
      OR NOT EXISTS (
        SELECT 1
        FROM contract_years
        WHERE contract_years.league_id = NEW.league_id
          AND contract_years.contract_id =
            NEW.carryover_contract_id
          AND contract_years.season_id = NEW.season_id
          AND contract_years.status = 'current'
      )
      OR NEW.remaining_years <> (
        SELECT COUNT(*)
        FROM contract_years
        WHERE contract_years.league_id = NEW.league_id
          AND contract_years.contract_id =
            NEW.carryover_contract_id
          AND contract_years.status IN ('current', 'future')
      )
    )
  THEN RAISE(
    ABORT,
    'carryover update must copy current ownership and contract evidence'
  ) END;
END;

CREATE TRIGGER candidate_card_entries_valid_carryover_delete
BEFORE DELETE ON candidate_card_entries
WHEN OLD.entry_kind = 'carryover'
  AND EXISTS (
    SELECT 1
    FROM player_ownerships
    JOIN contracts
      ON contracts.league_id = player_ownerships.league_id
     AND contracts.id = OLD.carryover_contract_id
     AND contracts.player_id = player_ownerships.player_id
     AND contracts.current_team_id = player_ownerships.team_id
     AND contracts.status = 'active'
     AND contracts.original_total_value_cents =
       OLD.carryover_original_total_value_cents
     AND contracts.original_term_years =
       OLD.carryover_original_term_years
     AND contracts.aav_cents = OLD.carryover_aav_cents
    WHERE player_ownerships.id = OLD.carryover_ownership_id
      AND player_ownerships.league_id = OLD.league_id
      AND player_ownerships.season_id = OLD.season_id
      AND player_ownerships.team_id = OLD.team_id
      AND player_ownerships.player_id = OLD.player_id
      AND player_ownerships.ownership_kind = 'Rostered'
      AND player_ownerships.roster_category =
        OLD.source_roster_category
      AND player_ownerships.position_group =
        OLD.effective_position_group
      AND (
        player_ownerships.roster_category = 'Injured Reserve'
        OR player_ownerships.slot_number IS NULL
        OR player_ownerships.slot_number =
          OLD.requested_slot_number
      )
      AND EXISTS (
        SELECT 1
        FROM contract_years
        WHERE contract_years.league_id = OLD.league_id
          AND contract_years.contract_id =
            OLD.carryover_contract_id
          AND contract_years.season_id = OLD.season_id
          AND contract_years.status = 'current'
      )
      AND OLD.remaining_years = (
        SELECT COUNT(*)
        FROM contract_years
        WHERE contract_years.league_id = OLD.league_id
          AND contract_years.contract_id =
            OLD.carryover_contract_id
          AND contract_years.status IN ('current', 'future')
      )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'valid carryover entry cannot be removed from its Candidate Card'
  );
END;

CREATE TRIGGER candidate_card_entries_open_delete
BEFORE DELETE ON candidate_card_entries
WHEN NOT EXISTS (
  SELECT 1
  FROM candidate_cards
  JOIN free_agent_drafts
    ON free_agent_drafts.league_id = candidate_cards.league_id
   AND free_agent_drafts.id = candidate_cards.fad_id
  WHERE candidate_cards.league_id = OLD.league_id
    AND candidate_cards.id = OLD.card_id
    AND candidate_cards.status = 'open'
    AND free_agent_drafts.status = 'cards_open'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'locked Candidate entry cannot be deleted'
  );
END;

CREATE TABLE candidate_card_help_requests (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired')),
  message TEXT
    CHECK (
      message IS NULL
      OR (
        message = trim(message)
        AND length(message) BETWEEN 1 AND 500
      )
    ),
  requested_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  requested_by_membership_id TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > requested_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= requested_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, fad_id, card_id),
  FOREIGN KEY (league_id, season_id, fad_id, card_id, team_id)
    REFERENCES candidate_cards(
      league_id,
      season_id,
      fad_id,
      id,
      team_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, requested_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX candidate_card_help_requests_league_fad_status
  ON candidate_card_help_requests (
    league_id,
    fad_id,
    status,
    requested_at_ms
  );

CREATE TRIGGER candidate_card_help_requests_manager_insert
BEFORE INSERT ON candidate_card_help_requests
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'active'
    AND NEW.created_at_ms = NEW.requested_at_ms
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id =
            candidate_cards.league_id
       AND free_agent_drafts.season_id =
            candidate_cards.season_id
       AND free_agent_drafts.id = candidate_cards.fad_id
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.season_id = NEW.season_id
        AND candidate_cards.fad_id = NEW.fad_id
        AND candidate_cards.id = NEW.card_id
        AND candidate_cards.team_id = NEW.team_id
        AND candidate_cards.status = 'open'
        AND free_agent_drafts.status = 'cards_open'
        AND NEW.requested_at_ms >=
          free_agent_drafts.help_opens_at_ms
        AND NEW.requested_at_ms <
          free_agent_drafts.candidate_deadline_at_ms
        AND NEW.expires_at_ms =
          free_agent_drafts.candidate_deadline_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'help request must begin in the final 48-hour window'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM team_manager_assignments
    JOIN league_memberships
      ON league_memberships.league_id =
          team_manager_assignments.league_id
     AND league_memberships.id =
          team_manager_assignments.membership_id
     AND league_memberships.user_id =
          team_manager_assignments.user_id
    WHERE team_manager_assignments.league_id = NEW.league_id
      AND team_manager_assignments.team_id = NEW.team_id
      AND team_manager_assignments.user_id =
        NEW.requested_by_user_id
      AND team_manager_assignments.membership_id =
        NEW.requested_by_membership_id
      AND team_manager_assignments.status = 'accepted'
      AND team_manager_assignments.ended_at_ms IS NULL
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'help requester must be the current accepted manager'
  ) END;
END;

CREATE TRIGGER candidate_card_help_requests_expire_update
BEFORE UPDATE ON candidate_card_help_requests
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'active'
    AND NEW.status = 'expired'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.card_id IS OLD.card_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.message IS OLD.message
    AND NEW.requested_by_user_id IS OLD.requested_by_user_id
    AND NEW.requested_by_membership_id IS
      OLD.requested_by_membership_id
    AND NEW.requested_at_ms IS OLD.requested_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.expires_at_ms
    AND NEW.version = OLD.version + 1
  ) THEN RAISE(
    ABORT,
    'help request may only expire once at the deadline'
  ) END;
END;

CREATE TRIGGER candidate_card_help_requests_immutable_delete
BEFORE DELETE ON candidate_card_help_requests
BEGIN
  SELECT RAISE(ABORT, 'help request cannot be deleted');
END;

CREATE TABLE candidate_card_snapshots (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  locked_card_version INTEGER NOT NULL
    CHECK (locked_card_version >= 1),
  locked_status TEXT NOT NULL
    CHECK (
      locked_status IN (
        'locked_complete',
        'locked_incomplete',
        'locked_conflicted'
      )
    ),
  completeness_code TEXT NOT NULL
    CHECK (
      completeness_code IN (
        'complete',
        'incomplete',
        'conflicted'
      )
    ),
  filled_mandatory_count INTEGER NOT NULL
    CHECK (filled_mandatory_count BETWEEN 0 AND 18),
  missing_mandatory_count INTEGER NOT NULL
    CHECK (missing_mandatory_count BETWEEN 0 AND 18),
  filled_bench_count INTEGER NOT NULL
    CHECK (filled_bench_count BETWEEN 0 AND 4),
  empty_bench_count INTEGER NOT NULL
    CHECK (empty_bench_count BETWEEN 0 AND 4),
  blocking_validation_count INTEGER NOT NULL
    CHECK (blocking_validation_count >= 0),
  structural_conflict_count INTEGER NOT NULL
    CHECK (structural_conflict_count >= 0),
  cap_limit_cents INTEGER NOT NULL CHECK (cap_limit_cents >= 0),
  carried_active_player_amount_cents INTEGER NOT NULL
    CHECK (carried_active_player_amount_cents >= 0),
  retention_obligation_cents INTEGER NOT NULL
    CHECK (retention_obligation_cents >= 0),
  buyout_penalty_cents INTEGER NOT NULL
    CHECK (buyout_penalty_cents >= 0),
  carried_cap_usage_cents INTEGER NOT NULL
    CHECK (carried_cap_usage_cents >= 0),
  proposed_candidate_aav_cents INTEGER NOT NULL
    CHECK (proposed_candidate_aav_cents >= 0),
  maximum_possible_cap_cents INTEGER NOT NULL
    CHECK (maximum_possible_cap_cents >= 0),
  maximum_cap_space_cents INTEGER NOT NULL,
  effective_deadline_at_ms INTEGER NOT NULL
    CHECK (effective_deadline_at_ms >= 0),
  processed_at_ms INTEGER NOT NULL
    CHECK (processed_at_ms >= effective_deadline_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= processed_at_ms),
  UNIQUE (league_id, id),
  UNIQUE (league_id, card_id),
  UNIQUE (league_id, fad_id, team_id),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    id,
    card_id,
    team_id
  ),
  FOREIGN KEY (league_id, season_id, fad_id, card_id, team_id)
    REFERENCES candidate_cards(
      league_id,
      season_id,
      fad_id,
      id,
      team_id
    ) ON DELETE RESTRICT,
  CHECK (filled_mandatory_count + missing_mandatory_count = 18),
  CHECK (filled_bench_count + empty_bench_count = 4),
  CHECK (
    carried_cap_usage_cents =
      carried_active_player_amount_cents
      + retention_obligation_cents
      + buyout_penalty_cents
  ),
  CHECK (
    maximum_possible_cap_cents =
      carried_cap_usage_cents + proposed_candidate_aav_cents
  ),
  CHECK (
    maximum_cap_space_cents =
      cap_limit_cents - maximum_possible_cap_cents
  ),
  CHECK (
    (locked_status = 'locked_complete' AND completeness_code = 'complete')
    OR (
      locked_status = 'locked_incomplete'
      AND completeness_code = 'incomplete'
    )
    OR (
      locked_status = 'locked_conflicted'
      AND completeness_code = 'conflicted'
    )
  )
) STRICT;

CREATE INDEX candidate_card_snapshots_league_fad_status
  ON candidate_card_snapshots (
    league_id,
    fad_id,
    locked_status
  );

CREATE TRIGGER candidate_card_snapshots_locked_insert
BEFORE INSERT ON candidate_card_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_cards
    JOIN free_agent_drafts
      ON free_agent_drafts.league_id =
          candidate_cards.league_id
     AND free_agent_drafts.season_id =
          candidate_cards.season_id
     AND free_agent_drafts.id = candidate_cards.fad_id
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.season_id = NEW.season_id
      AND candidate_cards.fad_id = NEW.fad_id
      AND candidate_cards.id = NEW.card_id
      AND candidate_cards.team_id = NEW.team_id
      AND candidate_cards.version = NEW.locked_card_version
      AND candidate_cards.status = NEW.locked_status
      AND candidate_cards.completeness_code =
        NEW.completeness_code
      AND candidate_cards.filled_mandatory_count =
        NEW.filled_mandatory_count
      AND candidate_cards.missing_mandatory_count =
        NEW.missing_mandatory_count
      AND candidate_cards.filled_bench_count =
        NEW.filled_bench_count
      AND candidate_cards.empty_bench_count =
        NEW.empty_bench_count
      AND candidate_cards.blocking_validation_count =
        NEW.blocking_validation_count
      AND candidate_cards.structural_conflict_count =
        NEW.structural_conflict_count
      AND candidate_cards.maximum_possible_cap_cents =
        NEW.maximum_possible_cap_cents
      AND candidate_cards.locked_at_ms =
        NEW.effective_deadline_at_ms
      AND free_agent_drafts.candidate_deadline_at_ms =
        NEW.effective_deadline_at_ms
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot must copy its locked deadline card'
  ) END;

  SELECT CASE WHEN NEW.blocking_validation_count <> (
    SELECT COUNT(*)
    FROM candidate_card_entries
    WHERE candidate_card_entries.league_id = NEW.league_id
      AND candidate_card_entries.card_id = NEW.card_id
      AND candidate_card_entries.entry_kind = 'candidate'
      AND candidate_card_entries.placement_state = 'placed'
      AND candidate_card_entries.eligibility_status = 'invalid'
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot blocking validation count must match current entries'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_settings
    WHERE league_settings.league_id = NEW.league_id
      AND league_settings.salary_cap_cents = NEW.cap_limit_cents
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot cap limit must match league settings'
  ) END;

  SELECT CASE WHEN NEW.proposed_candidate_aav_cents <> (
    SELECT COALESCE(SUM(proposed_aav_cents), 0)
    FROM candidate_card_entries
    WHERE candidate_card_entries.league_id = NEW.league_id
      AND candidate_card_entries.card_id = NEW.card_id
      AND candidate_card_entries.entry_kind = 'candidate'
      AND candidate_card_entries.placement_state = 'placed'
      AND candidate_card_entries.requested_slot_group IN ('F', 'D')
      AND candidate_card_entries.eligibility_status IN (
        'valid',
        'warning'
      )
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot proposed cap must match placed offers'
  ) END;

  SELECT CASE WHEN NEW.carried_active_player_amount_cents <> (
    SELECT COALESCE(SUM(
      contract_years.aav_cents - COALESCE((
        SELECT SUM(retention_years.retained_aav_cents)
        FROM retention_obligations
        JOIN retention_years
          ON retention_years.league_id =
              retention_obligations.league_id
         AND retention_years.retention_obligation_id =
              retention_obligations.id
        WHERE retention_obligations.league_id = NEW.league_id
          AND retention_obligations.contract_id = contracts.id
          AND retention_obligations.status = 'active'
          AND retention_years.season_id = NEW.season_id
          AND retention_years.status = 'current'
      ), 0)
    ), 0)
    FROM player_ownerships
    JOIN contracts
      ON contracts.league_id = player_ownerships.league_id
     AND contracts.player_id = player_ownerships.player_id
     AND contracts.current_team_id = player_ownerships.team_id
     AND contracts.status = 'active'
    JOIN contract_years
      ON contract_years.league_id = contracts.league_id
     AND contract_years.contract_id = contracts.id
     AND contract_years.season_id = NEW.season_id
     AND contract_years.status = 'current'
    WHERE player_ownerships.league_id = NEW.league_id
      AND player_ownerships.season_id = NEW.season_id
      AND player_ownerships.team_id = NEW.team_id
      AND player_ownerships.ownership_kind = 'Rostered'
      AND player_ownerships.roster_category = 'Active'
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot carried cap must match current roster'
  ) END;

  SELECT CASE WHEN NEW.retention_obligation_cents <> (
    SELECT COALESCE(SUM(retention_years.retained_aav_cents), 0)
    FROM retention_obligations
    JOIN retention_years
      ON retention_years.league_id =
          retention_obligations.league_id
     AND retention_years.retention_obligation_id =
          retention_obligations.id
    WHERE retention_obligations.league_id = NEW.league_id
      AND retention_obligations.responsible_team_id = NEW.team_id
      AND retention_obligations.status = 'active'
      AND retention_years.season_id = NEW.season_id
      AND retention_years.status = 'current'
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot retention cap must match current obligations'
  ) END;

  SELECT CASE WHEN NEW.buyout_penalty_cents <> (
    SELECT COALESCE(SUM(buyout_years.penalty_cents), 0)
    FROM buyout_obligations
    JOIN buyout_years
      ON buyout_years.league_id = buyout_obligations.league_id
     AND buyout_years.buyout_obligation_id =
          buyout_obligations.id
    WHERE buyout_obligations.league_id = NEW.league_id
      AND buyout_obligations.responsible_team_id = NEW.team_id
      AND buyout_obligations.status = 'active'
      AND buyout_years.season_id = NEW.season_id
      AND buyout_years.status = 'current'
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot buyout cap must match current obligations'
  ) END;
END;

CREATE TRIGGER candidate_card_snapshots_immutable_update
BEFORE UPDATE ON candidate_card_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card snapshot is immutable');
END;

CREATE TRIGGER candidate_card_snapshots_immutable_delete
BEFORE DELETE ON candidate_card_snapshots
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card snapshot is immutable');
END;

CREATE TABLE candidate_card_snapshot_entries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  row_kind TEXT NOT NULL CHECK (row_kind IN ('slot', 'conflict')),
  occupant_kind TEXT NOT NULL
    CHECK (occupant_kind IN ('empty', 'carryover', 'candidate')),
  slot_group TEXT NOT NULL CHECK (slot_group IN ('F', 'D', 'B')),
  slot_number INTEGER NOT NULL,
  source_entry_id TEXT,
  source_entry_version INTEGER
    CHECK (
      source_entry_version IS NULL
      OR source_entry_version >= 1
    ),
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  effective_position_group TEXT
    CHECK (
      effective_position_group IS NULL
      OR effective_position_group IN ('F', 'D')
    ),
  conflict_code TEXT
    CHECK (
      conflict_code IS NULL
      OR (
        conflict_code = trim(conflict_code)
        AND length(conflict_code) BETWEEN 1 AND 100
        AND conflict_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  carryover_ownership_id TEXT
    CHECK (
      carryover_ownership_id IS NULL
      OR (
        length(carryover_ownership_id) = 36
        AND carryover_ownership_id = lower(carryover_ownership_id)
      )
    ),
  carryover_contract_id TEXT,
  source_roster_category TEXT
    CHECK (
      source_roster_category IS NULL
      OR source_roster_category IN (
        'Active',
        'Bench',
        'Injured Reserve'
      )
    ),
  carryover_original_total_value_cents INTEGER
    CHECK (
      carryover_original_total_value_cents IS NULL
      OR carryover_original_total_value_cents > 0
    ),
  carryover_original_term_years INTEGER
    CHECK (
      carryover_original_term_years IS NULL
      OR carryover_original_term_years BETWEEN 1 AND 3
    ),
  carryover_aav_cents INTEGER
    CHECK (carryover_aav_cents IS NULL OR carryover_aav_cents > 0),
  remaining_years INTEGER
    CHECK (remaining_years IS NULL OR remaining_years BETWEEN 1 AND 3),
  proposed_total_value_cents INTEGER
    CHECK (
      proposed_total_value_cents IS NULL
      OR proposed_total_value_cents > 0
    ),
  proposed_term_years INTEGER
    CHECK (
      proposed_term_years IS NULL
      OR proposed_term_years BETWEEN 1 AND 3
    ),
  proposed_aav_cents INTEGER
    CHECK (proposed_aav_cents IS NULL OR proposed_aav_cents > 0),
  eligibility_status TEXT
    CHECK (
      eligibility_status IS NULL
      OR eligibility_status IN ('valid', 'warning', 'invalid')
    ),
  validation_code TEXT
    CHECK (
      validation_code IS NULL
      OR (
        validation_code = trim(validation_code)
        AND length(validation_code) BETWEEN 1 AND 100
        AND validation_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  last_edited_by_user_id TEXT
    REFERENCES users(id) ON DELETE RESTRICT,
  last_edited_by_membership_id TEXT,
  last_edited_by_authority TEXT
    CHECK (
      last_edited_by_authority IS NULL
      OR last_edited_by_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  last_edited_at_ms INTEGER
    CHECK (last_edited_at_ms IS NULL OR last_edited_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    snapshot_id,
    card_id,
    team_id
  ) REFERENCES candidate_card_snapshots(
    league_id,
    season_id,
    fad_id,
    id,
    card_id,
    team_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    source_entry_id
  ) REFERENCES candidate_card_entries(
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, carryover_contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, last_edited_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (slot_group = 'F' AND slot_number BETWEEN 1 AND 12)
    OR (slot_group = 'D' AND slot_number BETWEEN 1 AND 6)
    OR (slot_group = 'B' AND slot_number BETWEEN 1 AND 4)
  ),
  CHECK (
    (
      row_kind = 'slot'
      AND conflict_code IS NULL
    )
    OR (
      row_kind = 'conflict'
      AND occupant_kind <> 'empty'
      AND conflict_code IS NOT NULL
    )
  ),
  CHECK (
    (
      occupant_kind = 'empty'
      AND source_entry_id IS NULL
      AND source_entry_version IS NULL
      AND player_id IS NULL
      AND effective_position_group IS NULL
      AND conflict_code IS NULL
      AND carryover_ownership_id IS NULL
      AND carryover_contract_id IS NULL
      AND source_roster_category IS NULL
      AND carryover_original_total_value_cents IS NULL
      AND carryover_original_term_years IS NULL
      AND carryover_aav_cents IS NULL
      AND remaining_years IS NULL
      AND proposed_total_value_cents IS NULL
      AND proposed_term_years IS NULL
      AND proposed_aav_cents IS NULL
      AND eligibility_status IS NULL
      AND validation_code IS NULL
      AND last_edited_by_user_id IS NULL
      AND last_edited_by_membership_id IS NULL
      AND last_edited_by_authority IS NULL
      AND last_edited_at_ms IS NULL
    )
    OR (
      occupant_kind = 'carryover'
      AND source_entry_id IS NOT NULL
      AND source_entry_version IS NOT NULL
      AND player_id IS NOT NULL
      AND effective_position_group IS NOT NULL
      AND carryover_ownership_id IS NOT NULL
      AND carryover_contract_id IS NOT NULL
      AND source_roster_category IS NOT NULL
      AND carryover_original_total_value_cents IS NOT NULL
      AND carryover_original_term_years IS NOT NULL
      AND carryover_aav_cents IS NOT NULL
      AND remaining_years IS NOT NULL
      AND proposed_total_value_cents IS NULL
      AND proposed_term_years IS NULL
      AND proposed_aav_cents IS NULL
      AND eligibility_status IS NULL
      AND validation_code IS NULL
      AND last_edited_by_authority IS NOT NULL
      AND last_edited_at_ms IS NOT NULL
    )
    OR (
      occupant_kind = 'candidate'
      AND source_entry_id IS NOT NULL
      AND source_entry_version IS NOT NULL
      AND player_id IS NOT NULL
      AND effective_position_group IS NOT NULL
      AND carryover_ownership_id IS NULL
      AND carryover_contract_id IS NULL
      AND source_roster_category IS NULL
      AND carryover_original_total_value_cents IS NULL
      AND carryover_original_term_years IS NULL
      AND carryover_aav_cents IS NULL
      AND remaining_years IS NULL
      AND proposed_total_value_cents IS NOT NULL
      AND proposed_term_years IS NOT NULL
      AND proposed_aav_cents IS NOT NULL
      AND eligibility_status IS NOT NULL
      AND last_edited_by_authority IS NOT NULL
      AND last_edited_at_ms IS NOT NULL
    )
  ),
  CHECK (
    occupant_kind = 'empty'
    OR (
      (
        slot_group = 'F'
        AND effective_position_group = 'F'
      )
      OR (
        slot_group = 'D'
        AND effective_position_group = 'D'
      )
      OR slot_group = 'B'
    )
  ),
  CHECK (
    occupant_kind = 'empty'
    OR (
      (
        last_edited_by_authority = 'system'
        AND last_edited_by_user_id IS NULL
        AND last_edited_by_membership_id IS NULL
      )
      OR (
        last_edited_by_authority <> 'system'
        AND last_edited_by_user_id IS NOT NULL
        AND last_edited_by_membership_id IS NOT NULL
      )
    )
  )
) STRICT;

CREATE UNIQUE INDEX candidate_card_snapshot_entries_one_slot
  ON candidate_card_snapshot_entries (
    league_id,
    snapshot_id,
    slot_group,
    slot_number
  )
  WHERE row_kind = 'slot';

CREATE UNIQUE INDEX candidate_card_snapshot_entries_one_source
  ON candidate_card_snapshot_entries (
    league_id,
    snapshot_id,
    source_entry_id
  )
  WHERE source_entry_id IS NOT NULL;

CREATE INDEX candidate_card_snapshot_entries_league_snapshot_kind
  ON candidate_card_snapshot_entries (
    league_id,
    snapshot_id,
    row_kind
  );

CREATE INDEX candidate_card_snapshot_entries_league_fad_player
  ON candidate_card_snapshot_entries (
    league_id,
    fad_id,
    player_id
  );

CREATE TRIGGER candidate_card_snapshot_entries_source_insert
BEFORE INSERT ON candidate_card_snapshot_entries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_card_snapshots
    WHERE candidate_card_snapshots.league_id = NEW.league_id
      AND candidate_card_snapshots.id = NEW.snapshot_id
      AND candidate_card_snapshots.created_at_ms =
        NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'snapshot entry must share its snapshot commit time'
  ) END;

  SELECT CASE WHEN
    NEW.occupant_kind <> 'empty'
    AND NOT EXISTS (
      SELECT 1
      FROM candidate_card_entries
      WHERE candidate_card_entries.league_id = NEW.league_id
        AND candidate_card_entries.season_id = NEW.season_id
        AND candidate_card_entries.fad_id = NEW.fad_id
        AND candidate_card_entries.card_id = NEW.card_id
        AND candidate_card_entries.team_id = NEW.team_id
        AND candidate_card_entries.id = NEW.source_entry_id
        AND candidate_card_entries.version =
          NEW.source_entry_version
        AND candidate_card_entries.entry_kind =
          NEW.occupant_kind
        AND candidate_card_entries.player_id = NEW.player_id
        AND candidate_card_entries.effective_position_group =
          NEW.effective_position_group
        AND candidate_card_entries.requested_slot_group =
          NEW.slot_group
        AND candidate_card_entries.requested_slot_number =
          NEW.slot_number
        AND (
          (
            NEW.row_kind = 'slot'
            AND candidate_card_entries.placement_state = 'placed'
          )
          OR (
            NEW.row_kind = 'conflict'
            AND candidate_card_entries.placement_state = 'conflict'
            AND candidate_card_entries.conflict_code =
              NEW.conflict_code
          )
        )
        AND candidate_card_entries.carryover_ownership_id IS
          NEW.carryover_ownership_id
        AND candidate_card_entries.carryover_contract_id IS
          NEW.carryover_contract_id
        AND candidate_card_entries.source_roster_category IS
          NEW.source_roster_category
        AND candidate_card_entries.carryover_original_total_value_cents
          IS NEW.carryover_original_total_value_cents
        AND candidate_card_entries.carryover_original_term_years
          IS NEW.carryover_original_term_years
        AND candidate_card_entries.carryover_aav_cents IS
          NEW.carryover_aav_cents
        AND candidate_card_entries.remaining_years IS
          NEW.remaining_years
        AND candidate_card_entries.proposed_total_value_cents IS
          NEW.proposed_total_value_cents
        AND candidate_card_entries.proposed_term_years IS
          NEW.proposed_term_years
        AND candidate_card_entries.proposed_aav_cents IS
          NEW.proposed_aav_cents
        AND candidate_card_entries.eligibility_status IS
          NEW.eligibility_status
        AND candidate_card_entries.validation_code IS
          NEW.validation_code
        AND candidate_card_entries.last_edited_by_user_id IS
          NEW.last_edited_by_user_id
        AND candidate_card_entries.last_edited_by_membership_id IS
          NEW.last_edited_by_membership_id
        AND candidate_card_entries.last_edited_by_authority IS
          NEW.last_edited_by_authority
        AND candidate_card_entries.updated_at_ms =
          NEW.last_edited_at_ms
    )
  THEN RAISE(
    ABORT,
    'snapshot occupant must exactly copy its locked current entry'
  ) END;
END;

CREATE TRIGGER candidate_card_snapshot_entries_immutable_update
BEFORE UPDATE ON candidate_card_snapshot_entries
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card snapshot entry is immutable');
END;

CREATE TRIGGER candidate_card_snapshot_entries_immutable_delete
BEFORE DELETE ON candidate_card_snapshot_entries
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card snapshot entry is immutable');
END;

CREATE TRIGGER free_agent_drafts_deadline_completeness_update
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'cards_open'
  AND NEW.status = 'deadline_locked'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_teams
    WHERE free_agent_draft_teams.league_id = NEW.league_id
      AND free_agent_draft_teams.fad_id = NEW.id
  ) <> NEW.participating_team_count THEN RAISE(
    ABORT,
    'FAD deadline requires its committed frozen participants'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM candidate_cards
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.fad_id = NEW.id
      AND candidate_cards.status IN (
        'locked_complete',
        'locked_incomplete',
        'locked_conflicted'
      )
  ) <> (
    SELECT COUNT(*)
    FROM free_agent_draft_teams
    WHERE free_agent_draft_teams.league_id = NEW.league_id
      AND free_agent_draft_teams.fad_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one locked card per participant'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_cards
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.fad_id = NEW.id
      AND (
        (
          SELECT COUNT(*)
          FROM candidate_card_revisions
          WHERE candidate_card_revisions.league_id =
              candidate_cards.league_id
            AND candidate_card_revisions.card_id =
              candidate_cards.id
        ) <> candidate_cards.version
        OR NOT EXISTS (
          SELECT 1
          FROM candidate_card_revisions
          WHERE candidate_card_revisions.league_id =
              candidate_cards.league_id
            AND candidate_card_revisions.card_id =
              candidate_cards.id
            AND candidate_card_revisions.resulting_card_version = 1
            AND candidate_card_revisions.action = 'card_opened'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM candidate_card_revisions
          WHERE candidate_card_revisions.league_id =
              candidate_cards.league_id
            AND candidate_card_revisions.card_id =
              candidate_cards.id
            AND candidate_card_revisions.resulting_card_version =
              candidate_cards.version
            AND candidate_card_revisions.action = 'deadline_locked'
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires contiguous immutable card revisions'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_card_help_requests
    WHERE candidate_card_help_requests.league_id = NEW.league_id
      AND candidate_card_help_requests.fad_id = NEW.id
      AND candidate_card_help_requests.status = 'active'
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires every help grant to expire'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_cards
    LEFT JOIN candidate_card_snapshots
      ON candidate_card_snapshots.league_id =
          candidate_cards.league_id
     AND candidate_card_snapshots.card_id = candidate_cards.id
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.fad_id = NEW.id
      AND (
        candidate_card_snapshots.id IS NULL
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
        ) <> 22
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind =
              'conflict'
        ) <> candidate_card_snapshots.structural_conflict_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.source_entry_id
              IS NOT NULL
        ) <> (
          SELECT COUNT(*)
          FROM candidate_card_entries
          WHERE candidate_card_entries.league_id =
              candidate_cards.league_id
            AND candidate_card_entries.card_id =
              candidate_cards.id
        )
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group IN ('F', 'D')
            AND candidate_card_snapshot_entries.occupant_kind <>
              'empty'
        ) <> candidate_card_snapshots.filled_mandatory_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group IN ('F', 'D')
            AND candidate_card_snapshot_entries.occupant_kind = 'empty'
        ) <> candidate_card_snapshots.missing_mandatory_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group = 'B'
            AND candidate_card_snapshot_entries.occupant_kind <>
              'empty'
        ) <> candidate_card_snapshots.filled_bench_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group = 'B'
            AND candidate_card_snapshot_entries.occupant_kind = 'empty'
        ) <> candidate_card_snapshots.empty_bench_count
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires complete immutable card snapshots'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '24',
    updated_at_ms =
      CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
