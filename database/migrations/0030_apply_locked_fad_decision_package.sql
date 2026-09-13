-- hundo-leago: foreign-key-rebuild
-- Apply the locked FAD/lifecycle decision package.
--
-- Migrations 0023-0026 and 0029 were never approved for business writes.
-- Refuse to reinterpret any row written through those pre-amendment
-- structures. Ordinary auctions and all unrelated history are preserved.

CREATE TEMP TABLE migration_0030_business_row_guard (
  business_row_count INTEGER NOT NULL
    CHECK (business_row_count = 0)
) STRICT;

INSERT INTO migration_0030_business_row_guard (business_row_count)
SELECT
  (SELECT COUNT(*) FROM season_rollovers)
  + (SELECT COUNT(*) FROM season_rollover_items)
  + (SELECT COUNT(*) FROM free_agent_draft_setup_exemptions)
  + (SELECT COUNT(*) FROM free_agent_drafts)
  + (SELECT COUNT(*) FROM free_agent_draft_teams)
  + (SELECT COUNT(*) FROM candidate_cards)
  + (SELECT COUNT(*) FROM candidate_card_entries)
  + (SELECT COUNT(*) FROM candidate_card_revisions)
  + (SELECT COUNT(*) FROM candidate_card_help_requests)
  + (SELECT COUNT(*) FROM candidate_card_snapshots)
  + (SELECT COUNT(*) FROM candidate_card_snapshot_entries)
  + (SELECT COUNT(*) FROM free_agent_draft_player_allocations)
  + (SELECT COUNT(*) FROM free_agent_draft_allocation_events)
  + (SELECT COUNT(*) FROM free_agent_draft_rollovers)
  + (SELECT COUNT(*) FROM free_agent_draft_recoveries)
  + (SELECT COUNT(*) FROM free_agent_draft_auction_participants)
  + (SELECT COUNT(*) FROM free_agent_draft_draws)
  + (
      SELECT COUNT(*)
      FROM auction_contexts
      WHERE source_kind <> 'ordinary_weekly'
    )
  + (
      SELECT COUNT(*)
      FROM auction_events
      WHERE event_type LIKE 'fad_%'
    )
  + (
      SELECT COUNT(*)
      FROM job_runs
      WHERE job_type LIKE 'free_agent_draft_%'
        OR job_type IN (
          'season_rollover',
          'entry_draft_start_rollover'
        )
        OR occurrence_key LIKE 'fad:%'
        OR occurrence_key LIKE 'entry-draft:%:start:%'
    )
  + (
      SELECT COUNT(*)
      FROM league_activity
      WHERE event_type LIKE 'fad_%'
        OR event_type LIKE 'season_rollover%'
    )
  + (
      SELECT COUNT(*)
      FROM notifications
      WHERE event_type LIKE 'fad_%'
        OR related_feature IN (
          'free_agent_draft',
          'free_agent_draft_setup',
          'season_rollover'
        )
    )
  + (
      SELECT COUNT(*)
      FROM security_audit_events
      WHERE event_type LIKE 'fad.%'
        OR event_type LIKE 'season.rollover%'
    )
  + (
      SELECT COUNT(*)
      FROM operational_events
      WHERE feature IN (
        'free_agent_draft',
        'free_agent_draft_setup',
        'season_rollover'
      )
    )
  + (
      SELECT COUNT(*)
      FROM outbox_events
      WHERE aggregate_type IN (
        'free_agent_draft',
        'free_agent_draft_readiness',
        'season_rollover',
        'season_rollover_attempt'
      )
    )
  + (
      SELECT COUNT(*)
      FROM commissioner_corrections
      WHERE feature LIKE 'free_agent_draft%'
        OR feature = 'season_rollover'
    )
  + (
      SELECT COUNT(*)
      FROM idempotency_requests
      WHERE operation IN (
          'league.lifecycle.transition.v1',
          'league.lifecycle.transition.v2'
        )
        OR result_type IN (
          'free_agent_draft_setup_exemption',
          'free_agent_draft',
          'season_rollover',
          'season_rollover_attempt'
        )
    )
  + ABS(
      (SELECT COUNT(*) FROM auctions)
      - (
          SELECT COUNT(*)
          FROM auction_contexts
          WHERE source_kind = 'ordinary_weekly'
        )
    );

DROP TABLE migration_0030_business_row_guard;

CREATE TEMP TABLE migration_0030_ordinary_auction_contexts (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO migration_0030_ordinary_auction_contexts (
  id,
  league_id,
  season_id,
  auction_id,
  created_at_ms
)
SELECT
  id,
  league_id,
  season_id,
  auction_id,
  created_at_ms
FROM auction_contexts
WHERE source_kind = 'ordinary_weekly';

-- Remove cross-table enforcement owned by the superseded structures.
DROP TRIGGER IF EXISTS matchup_weeks_fad_clock_frozen_update;
DROP TRIGGER IF EXISTS free_agent_draft_recovery_job_identity_update;
DROP TRIGGER IF EXISTS free_agent_draft_recovery_job_terminal_update;
DROP TRIGGER IF EXISTS seasons_fad_completion_marker_guard;
DROP TRIGGER IF EXISTS auction_bids_require_context_insert;
DROP TRIGGER IF EXISTS auction_events_require_context_insert;
DROP TRIGGER IF EXISTS auctions_require_context_update;
DROP TRIGGER IF EXISTS fad_restricted_bids_seed_insert;
DROP TRIGGER IF EXISTS fad_restricted_seed_events_insert;
DROP TRIGGER IF EXISTS fad_restricted_bids_immutable_delete;
DROP TRIGGER IF EXISTS fad_auction_events_immutable_update;
DROP TRIGGER IF EXISTS fad_auction_events_immutable_delete;
DROP TRIGGER IF EXISTS auction_resolutions_require_context_insert;
DROP TRIGGER IF EXISTS fad_auction_resolutions_context_insert;
DROP TRIGGER IF EXISTS fad_auction_resolutions_immutable_delete;
DROP TRIGGER IF EXISTS fad_auction_resolutions_immutable_update;
DROP TRIGGER IF EXISTS fad_auction_resolution_failure_events_insert;
DROP TRIGGER IF EXISTS fad_failed_auctions_recovery_update;
DROP TRIGGER IF EXISTS fad_restricted_bids_forward_update;
DROP TRIGGER IF EXISTS fad_restricted_removal_events_insert;
DROP TRIGGER IF EXISTS fad_setup_exemptions_t037_evidence_insert;
DROP TRIGGER IF EXISTS idempotency_requests_lifecycle_update_0029;
DROP TRIGGER IF EXISTS idempotency_requests_lifecycle_complete_0029;
DROP TRIGGER IF EXISTS contract_events_rollover_evidence_update_0029;
DROP TRIGGER IF EXISTS contract_events_rollover_evidence_delete_0029;
DROP TRIGGER IF EXISTS contract_events_rollover_late_insert_0029;
DROP TRIGGER IF EXISTS ownership_events_rollover_evidence_update_0029;
DROP TRIGGER IF EXISTS ownership_events_rollover_evidence_delete_0029;
DROP TRIGGER IF EXISTS ownership_events_rollover_late_insert_0029;
DROP TRIGGER IF EXISTS trade_events_rollover_evidence_update_0029;
DROP TRIGGER IF EXISTS trade_events_rollover_evidence_delete_0029;
DROP TRIGGER IF EXISTS trade_events_rollover_late_insert_0029;
DROP TRIGGER IF EXISTS league_activity_lifecycle_evidence_update_0029;
DROP TRIGGER IF EXISTS league_activity_lifecycle_evidence_delete_0029;
DROP TRIGGER IF EXISTS league_activity_lifecycle_late_insert_0029;
DROP TRIGGER IF EXISTS security_audit_events_lifecycle_evidence_update_0029;
DROP TRIGGER IF EXISTS security_audit_events_lifecycle_evidence_delete_0029;
DROP TRIGGER IF EXISTS security_audit_events_lifecycle_late_insert_0029;
DROP TRIGGER IF EXISTS migration_reports_exemption_evidence_update_0029;
DROP TRIGGER IF EXISTS migration_reports_exemption_evidence_delete_0029;
DROP TRIGGER IF EXISTS idempotency_requests_exemption_bootstrap_update_0029;
DROP TRIGGER IF EXISTS idempotency_requests_exemption_bootstrap_delete_0029;
DROP TRIGGER IF EXISTS trade_assets_rollover_evidence_insert_0029;
DROP TRIGGER IF EXISTS trade_assets_rollover_evidence_update_0029;
DROP TRIGGER IF EXISTS trade_assets_rollover_evidence_delete_0029;
DROP TRIGGER IF EXISTS outbox_events_lifecycle_evidence_update_0029;
DROP TRIGGER IF EXISTS outbox_events_lifecycle_evidence_delete_0029;
DROP TRIGGER IF EXISTS outbox_events_lifecycle_late_insert_0029;
DROP TRIGGER IF EXISTS outbox_event_audiences_lifecycle_insert_0029;
DROP TRIGGER IF EXISTS outbox_event_audiences_lifecycle_update_0029;
DROP TRIGGER IF EXISTS outbox_event_audiences_lifecycle_delete_0029;
DROP TRIGGER IF EXISTS notifications_exemption_evidence_update_0029;
DROP TRIGGER IF EXISTS notifications_exemption_evidence_delete_0029;
DROP TRIGGER IF EXISTS notifications_exemption_late_insert_0029;
DROP TRIGGER IF EXISTS candidate_card_entries_open_update;
DROP TRIGGER IF EXISTS standings_snapshot_finalizations_schedule_root_insert_0028;
DROP VIEW IF EXISTS fad_restricted_eligible_bids;

-- Every rebuilt business table is empty because the guard ran first.
DROP TABLE free_agent_draft_draws;
DROP TABLE free_agent_draft_auction_participants;
DROP TABLE auction_contexts;
DROP TABLE free_agent_draft_recoveries;
DROP TABLE free_agent_draft_allocation_events;
DROP TABLE free_agent_draft_player_allocations;
DROP TABLE free_agent_draft_rollovers;
DROP TABLE candidate_card_revisions;
DROP TABLE free_agent_drafts;
DROP TABLE season_rollover_items;
DROP TABLE season_rollovers;

-- Scheduled Entry Draft rollover binding and immutable occurrence history.

CREATE TABLE season_matchup_schedule_generations (
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL CHECK (schedule_version >= 1),
  schedule_operation_id TEXT PRIMARY KEY
    CHECK (
      length(schedule_operation_id) = 36
      AND schedule_operation_id = lower(schedule_operation_id)
    ),
  week_one_matchup_week_id TEXT NOT NULL,
  week_one_starts_at_ms INTEGER NOT NULL
    CHECK (week_one_starts_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('current', 'superseded')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  superseded_at_ms INTEGER
    CHECK (
      superseded_at_ms IS NULL
      OR superseded_at_ms >= created_at_ms
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, season_id, schedule_version),
  UNIQUE (league_id, schedule_operation_id),
  UNIQUE (
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ),
  UNIQUE (
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version,
    week_one_matchup_week_id,
    week_one_starts_at_ms
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, schedule_operation_id)
    REFERENCES matchup_operations(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      status = 'current'
      AND superseded_at_ms IS NULL
    )
    OR (
      status = 'superseded'
      AND superseded_at_ms IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX season_matchup_schedule_generations_one_current
  ON season_matchup_schedule_generations (league_id, season_id)
  WHERE status = 'current';

INSERT INTO season_matchup_schedule_generations (
  league_id,
  season_id,
  schedule_version,
  schedule_operation_id,
  week_one_matchup_week_id,
  week_one_starts_at_ms,
  status,
  created_at_ms,
  superseded_at_ms,
  version
)
SELECT
  latest.league_id,
  latest.season_id,
  (
    SELECT COUNT(*)
    FROM matchup_operations AS generation
    WHERE generation.league_id = latest.league_id
      AND generation.season_id = latest.season_id
      AND generation.operation_type = 'schedule_generate'
      AND generation.status = 'succeeded'
      AND generation.completed_at_ms IS NOT NULL
  ),
  latest.id,
  week_one.id,
  week_one.starts_at_ms,
  'current',
  latest.completed_at_ms,
  NULL,
  1
FROM matchup_operations AS latest
JOIN matchup_weeks AS week_one
  ON week_one.league_id = latest.league_id
 AND week_one.season_id = latest.season_id
 AND week_one.sequence = 1
WHERE latest.operation_type = 'schedule_generate'
  AND latest.status = 'succeeded'
  AND latest.completed_at_ms IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM matchup_operations AS later
    WHERE later.league_id = latest.league_id
      AND later.season_id = latest.season_id
      AND later.operation_type = 'schedule_generate'
      AND later.status = 'succeeded'
      AND later.completed_at_ms IS NOT NULL
      AND (
        later.completed_at_ms > latest.completed_at_ms
        OR (
          later.completed_at_ms = latest.completed_at_ms
          AND later.id > latest.id
        )
      )
  );

-- Confirmed matchup-schedule commands retain one immutable replay result.
-- Week and matchup IDs are evidence values rather than foreign keys because a
-- later approved recovery may remove their live rows.

CREATE TABLE matchup_schedule_command_results (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('generate', 'shift_week_one')),
  idempotency_request_id TEXT NOT NULL,
  idempotency_operation TEXT NOT NULL
    CHECK (length(trim(idempotency_operation)) > 0),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  matchup_operation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  old_schedule_operation_id TEXT,
  old_schedule_version INTEGER
    CHECK (
      old_schedule_version IS NULL
      OR old_schedule_version >= 1
    ),
  new_schedule_operation_id TEXT NOT NULL,
  new_schedule_version INTEGER NOT NULL
    CHECK (new_schedule_version >= 1),
  season_version_before INTEGER NOT NULL
    CHECK (season_version_before >= 1),
  season_version_after INTEGER NOT NULL
    CHECK (season_version_after = season_version_before + 1),
  week_one_matchup_week_id TEXT NOT NULL
    CHECK (
      length(week_one_matchup_week_id) = 36
      AND week_one_matchup_week_id =
        lower(week_one_matchup_week_id)
    ),
  week_version_before INTEGER
    CHECK (
      week_version_before IS NULL
      OR week_version_before >= 1
    ),
  week_version_after INTEGER NOT NULL
    CHECK (week_version_after >= 1),
  previous_first_week_starts_at_ms INTEGER
    CHECK (
      previous_first_week_starts_at_ms IS NULL
      OR previous_first_week_starts_at_ms >= 0
    ),
  first_week_starts_at_ms INTEGER NOT NULL
    CHECK (first_week_starts_at_ms >= 0),
  last_week_ends_at_ms INTEGER NOT NULL
    CHECK (last_week_ends_at_ms > first_week_starts_at_ms),
  nhl_regular_season_starts_at_ms INTEGER
    CHECK (
      nhl_regular_season_starts_at_ms IS NULL
      OR nhl_regular_season_starts_at_ms >= 0
    ),
  nhl_regular_season_ends_at_ms INTEGER
    CHECK (
      nhl_regular_season_ends_at_ms IS NULL
      OR nhl_regular_season_ends_at_ms >
        nhl_regular_season_starts_at_ms
    ),
  fantasy_playoffs_start_at_ms INTEGER
    CHECK (
      fantasy_playoffs_start_at_ms IS NULL
      OR fantasy_playoffs_start_at_ms >= 0
    ),
  fantasy_playoffs_end_at_ms INTEGER
    CHECK (
      fantasy_playoffs_end_at_ms IS NULL
      OR fantasy_playoffs_end_at_ms >
        fantasy_playoffs_start_at_ms
    ),
  calendar_persisted INTEGER
    CHECK (
      calendar_persisted IS NULL
      OR calendar_persisted IN (0, 1)
    ),
  participant_count INTEGER
    CHECK (participant_count IS NULL OR participant_count >= 2),
  week_count INTEGER CHECK (week_count IS NULL OR week_count >= 1),
  matchup_count INTEGER
    CHECK (matchup_count IS NULL OR matchup_count >= 1),
  bye_count INTEGER CHECK (bye_count IS NULL OR bye_count >= 0),
  shifted_week_count INTEGER
    CHECK (
      shifted_week_count IS NULL
      OR shifted_week_count >= 1
    ),
  replaced_job_occurrence_count INTEGER
    CHECK (
      replaced_job_occurrence_count IS NULL
      OR replaced_job_occurrence_count >= 0
    ),
  response_http_status INTEGER NOT NULL
    CHECK (response_http_status IN (200, 201)),
  response_code TEXT
    CHECK (
      response_code IS NULL
      OR response_code = 'MATCHUP_SCHEDULE_GENERATED'
    ),
  result_schema_version INTEGER NOT NULL
    CHECK (result_schema_version = 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, idempotency_request_id),
  UNIQUE (league_id, matchup_operation_id),
  UNIQUE (league_id, new_schedule_operation_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_operation_id)
    REFERENCES matchup_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    old_schedule_operation_id,
    old_schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    new_schedule_operation_id,
    new_schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT,
  CHECK (matchup_operation_id = new_schedule_operation_id),
  CHECK (
    (
      action = 'generate'
      AND old_schedule_operation_id IS NULL
      AND old_schedule_version IS NULL
      AND new_schedule_version = 1
      AND week_version_before IS NULL
      AND previous_first_week_starts_at_ms IS NULL
      AND nhl_regular_season_starts_at_ms IS NOT NULL
      AND nhl_regular_season_ends_at_ms IS NOT NULL
      AND fantasy_playoffs_start_at_ms IS NOT NULL
      AND fantasy_playoffs_end_at_ms IS NOT NULL
      AND calendar_persisted IS NOT NULL
      AND participant_count IS NOT NULL
      AND week_count IS NOT NULL
      AND matchup_count IS NOT NULL
      AND bye_count IS NOT NULL
      AND shifted_week_count IS NULL
      AND replaced_job_occurrence_count IS NULL
      AND response_http_status = 201
      AND response_code = 'MATCHUP_SCHEDULE_GENERATED'
    )
    OR (
      action = 'shift_week_one'
      AND old_schedule_operation_id IS NOT NULL
      AND old_schedule_version IS NOT NULL
      AND new_schedule_version = old_schedule_version + 1
      AND week_version_before IS NOT NULL
      AND week_version_after = week_version_before + 1
      AND previous_first_week_starts_at_ms IS NOT NULL
      AND previous_first_week_starts_at_ms <>
        first_week_starts_at_ms
      AND nhl_regular_season_starts_at_ms IS NULL
      AND nhl_regular_season_ends_at_ms IS NULL
      AND fantasy_playoffs_start_at_ms IS NULL
      AND fantasy_playoffs_end_at_ms IS NULL
      AND calendar_persisted IS NULL
      AND participant_count IS NULL
      AND week_count IS NULL
      AND matchup_count IS NULL
      AND bye_count IS NULL
      AND shifted_week_count IS NOT NULL
      AND replaced_job_occurrence_count IS NOT NULL
      AND response_http_status = 200
      AND response_code IS NULL
    )
  )
) STRICT;

CREATE INDEX matchup_schedule_command_results_season_time
  ON matchup_schedule_command_results (
    league_id,
    season_id,
    created_at_ms,
    id
  );

-- Job bindings survive schedule-row replacement. Owning week/matchup IDs are
-- deliberately not foreign keys to the live schedule tables.

CREATE TABLE matchup_schedule_job_bindings (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  job_run_id TEXT NOT NULL,
  job_type TEXT NOT NULL
    CHECK (
      job_type = trim(job_type)
      AND length(job_type) BETWEEN 1 AND 100
    ),
  schedule_operation_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL CHECK (schedule_version >= 1),
  owning_matchup_week_id TEXT NOT NULL
    CHECK (
      length(owning_matchup_week_id) = 36
      AND owning_matchup_week_id =
        lower(owning_matchup_week_id)
    ),
  owning_matchup_id TEXT
    CHECK (
      owning_matchup_id IS NULL
      OR (
        length(owning_matchup_id) = 36
        AND owning_matchup_id = lower(owning_matchup_id)
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, job_run_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX matchup_schedule_job_bindings_generation_job
  ON matchup_schedule_job_bindings (
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version,
    job_type
  );

INSERT INTO matchup_schedule_job_bindings (
  id,
  league_id,
  season_id,
  job_run_id,
  job_type,
  schedule_operation_id,
  schedule_version,
  owning_matchup_week_id,
  owning_matchup_id,
  created_at_ms,
  version
)
SELECT
  job_runs.id,
  job_runs.league_id,
  job_runs.season_id,
  job_runs.id,
  job_runs.job_type,
  schedule_generation.schedule_operation_id,
  schedule_generation.schedule_version,
  matchup_weeks.id,
  NULL,
  job_runs.created_at_ms,
  1
FROM job_runs
JOIN matchup_weeks
  ON matchup_weeks.league_id = job_runs.league_id
 AND matchup_weeks.season_id = job_runs.season_id
 AND job_runs.occurrence_key =
      job_runs.job_type || ':' ||
      job_runs.league_id || ':' ||
      job_runs.season_id || ':' ||
      matchup_weeks.id || ':' ||
      job_runs.scheduled_for_ms
JOIN season_matchup_schedule_generations AS schedule_generation
  ON schedule_generation.league_id = job_runs.league_id
 AND schedule_generation.season_id = job_runs.season_id
 AND schedule_generation.status = 'current'
WHERE job_runs.job_type LIKE 'matchup:%';

CREATE TEMP TABLE migration_0030_unbound_matchup_job_guard (
  unbound_job_count INTEGER NOT NULL CHECK (unbound_job_count = 0)
) STRICT;

INSERT INTO migration_0030_unbound_matchup_job_guard (
  unbound_job_count
)
SELECT COUNT(*)
FROM job_runs
WHERE job_runs.job_type LIKE 'matchup:%'
  AND NOT EXISTS (
    SELECT 1
    FROM matchup_schedule_job_bindings
    WHERE matchup_schedule_job_bindings.league_id =
        job_runs.league_id
      AND matchup_schedule_job_bindings.job_run_id =
        job_runs.id
  );

DROP TABLE migration_0030_unbound_matchup_job_guard;

CREATE TABLE entry_draft_rollover_bindings (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  entry_draft_id TEXT NOT NULL,
  from_season_id TEXT NOT NULL,
  to_season_id TEXT NOT NULL,
  current_rollover_occurrence_id TEXT NOT NULL,
  current_scheduled_job_run_id TEXT NOT NULL,
  current_schedule_operation_id TEXT NOT NULL,
  target_schedule_id TEXT NOT NULL,
  target_schedule_version INTEGER NOT NULL
    CHECK (target_schedule_version >= 1),
  week_one_matchup_week_id TEXT NOT NULL,
  week_one_starts_at_ms INTEGER NOT NULL
    CHECK (week_one_starts_at_ms >= 0),
  scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (scheduled_starts_at_ms >= 0),
  current_occurrence_key TEXT NOT NULL
    CHECK (
      current_occurrence_key = trim(current_occurrence_key)
      AND length(current_occurrence_key) BETWEEN 1 AND 500
    ),
  status TEXT NOT NULL
    CHECK (status IN ('scheduled', 'blocked', 'succeeded')),
  successful_rollover_id TEXT,
  selection_gate_status TEXT NOT NULL
    CHECK (selection_gate_status IN ('locked', 'open')),
  trading_gate_status TEXT NOT NULL
    CHECK (trading_gate_status IN ('locked', 'open')),
  scheduled_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  scheduled_by_membership_id TEXT NOT NULL,
  scheduled_by_authority TEXT NOT NULL
    CHECK (
      scheduled_by_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  source_season_version_at_schedule INTEGER NOT NULL
    CHECK (source_season_version_at_schedule >= 1),
  target_season_version_at_schedule INTEGER NOT NULL
    CHECK (target_season_version_at_schedule >= 1),
  entry_draft_version_at_schedule INTEGER NOT NULL
    CHECK (entry_draft_version_at_schedule >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, entry_draft_id),
  UNIQUE (league_id, current_rollover_occurrence_id),
  UNIQUE (league_id, current_scheduled_job_run_id),
  UNIQUE (league_id, current_schedule_operation_id),
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, from_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, target_schedule_id)
    REFERENCES matchup_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    to_season_id,
    target_schedule_id,
    target_schedule_version,
    week_one_matchup_week_id,
    week_one_starts_at_ms
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version,
    week_one_matchup_week_id,
    week_one_starts_at_ms
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, scheduled_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, current_scheduled_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, current_schedule_operation_id)
    REFERENCES entry_draft_schedule_operations(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, current_rollover_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, successful_rollover_id)
    REFERENCES season_rollovers(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (from_season_id <> to_season_id),
  CHECK (
    (
      status IN ('scheduled', 'blocked')
      AND successful_rollover_id IS NULL
      AND selection_gate_status = 'locked'
      AND trading_gate_status = 'locked'
    )
    OR (
      status = 'succeeded'
      AND successful_rollover_id IS NOT NULL
      AND selection_gate_status = 'open'
      AND trading_gate_status = 'open'
    )
  )
) STRICT;

CREATE INDEX entry_draft_rollover_bindings_league_status
  ON entry_draft_rollover_bindings (
    league_id,
    status,
    scheduled_starts_at_ms
  );

CREATE TABLE season_rollover_occurrences (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL,
  entry_draft_id TEXT NOT NULL,
  from_season_id TEXT NOT NULL,
  to_season_id TEXT NOT NULL,
  target_schedule_id TEXT NOT NULL,
  target_schedule_version INTEGER NOT NULL
    CHECK (target_schedule_version >= 1),
  week_one_matchup_week_id TEXT NOT NULL,
  week_one_starts_at_ms INTEGER NOT NULL
    CHECK (week_one_starts_at_ms >= 0),
  scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (scheduled_starts_at_ms >= 0),
  occurrence_key TEXT NOT NULL
    CHECK (
      occurrence_key = trim(occurrence_key)
      AND length(occurrence_key) BETWEEN 1 AND 500
    ),
  scheduled_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  scheduled_by_membership_id TEXT NOT NULL,
  scheduled_by_authority TEXT NOT NULL
    CHECK (
      scheduled_by_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'scheduled',
        'superseded',
        'blocked',
        'succeeded'
      )
    ),
  superseded_by_occurrence_id TEXT,
  scheduled_job_run_id TEXT NOT NULL,
  schedule_operation_id TEXT NOT NULL,
  successful_rollover_id TEXT,
  source_season_version_at_schedule INTEGER NOT NULL
    CHECK (source_season_version_at_schedule >= 1),
  target_season_version_at_schedule INTEGER NOT NULL
    CHECK (target_season_version_at_schedule >= 1),
  entry_draft_version_at_schedule INTEGER NOT NULL
    CHECK (entry_draft_version_at_schedule >= 1),
  terminal_at_ms INTEGER
    CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= created_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, occurrence_key),
  UNIQUE (league_id, scheduled_job_run_id),
  UNIQUE (league_id, schedule_operation_id),
  UNIQUE (league_id, binding_id, scheduled_starts_at_ms),
  FOREIGN KEY (league_id, binding_id)
    REFERENCES entry_draft_rollover_bindings(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, from_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, target_schedule_id)
    REFERENCES matchup_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, scheduled_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, schedule_operation_id)
    REFERENCES entry_draft_schedule_operations(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, scheduled_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, superseded_by_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, successful_rollover_id)
    REFERENCES season_rollovers(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (from_season_id <> to_season_id),
  CHECK (
    superseded_by_occurrence_id IS NULL
    OR superseded_by_occurrence_id <> id
  ),
  CHECK (
    (
      status IN ('scheduled', 'blocked')
      AND successful_rollover_id IS NULL
      AND superseded_by_occurrence_id IS NULL
      AND terminal_at_ms IS NULL
    )
    OR (
      status = 'superseded'
      AND successful_rollover_id IS NULL
      AND superseded_by_occurrence_id IS NOT NULL
      AND terminal_at_ms IS NOT NULL
    )
    OR (
      status = 'succeeded'
      AND successful_rollover_id IS NOT NULL
      AND superseded_by_occurrence_id IS NULL
      AND terminal_at_ms IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX season_rollover_occurrences_one_live_binding
  ON season_rollover_occurrences (league_id, binding_id)
  WHERE status IN ('scheduled', 'blocked', 'succeeded');

CREATE INDEX season_rollover_occurrences_league_due
  ON season_rollover_occurrences (
    league_id,
    status,
    scheduled_starts_at_ms
  );

CREATE TABLE season_rollover_attempts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL,
  rollover_occurrence_id TEXT NOT NULL,
  entry_draft_id TEXT NOT NULL,
  from_season_id TEXT NOT NULL,
  to_season_id TEXT NOT NULL,
  target_schedule_id TEXT NOT NULL,
  target_schedule_version INTEGER NOT NULL
    CHECK (target_schedule_version >= 1),
  week_one_matchup_week_id TEXT NOT NULL,
  week_one_starts_at_ms INTEGER NOT NULL
    CHECK (week_one_starts_at_ms >= 0),
  scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (scheduled_starts_at_ms >= 0),
  occurrence_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  trigger_kind TEXT NOT NULL
    CHECK (
      trigger_kind IN ('scheduled_job', 'commissioner_retry')
    ),
  scheduled_job_run_id TEXT,
  retry_idempotency_request_id TEXT,
  retry_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  retry_by_membership_id TEXT,
  retry_authority TEXT
    CHECK (
      retry_authority IS NULL
      OR retry_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  status TEXT NOT NULL
    CHECK (status IN ('started', 'blocked', 'succeeded')),
  blockers_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(blockers_json) = 1
      AND json_type(blockers_json) = 'array'
      AND json(blockers_json) = blockers_json
    ),
  season_rollover_id TEXT,
  source_season_version_observed INTEGER NOT NULL
    CHECK (source_season_version_observed >= 1),
  target_season_version_observed INTEGER NOT NULL
    CHECK (target_season_version_observed >= 1),
  entry_draft_version_observed INTEGER NOT NULL
    CHECK (entry_draft_version_observed >= 1),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  terminal_at_ms INTEGER
    CHECK (
      terminal_at_ms IS NULL
      OR terminal_at_ms >= started_at_ms
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = started_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (
    league_id,
    rollover_occurrence_id,
    attempt_number
  ),
  UNIQUE (league_id, scheduled_job_run_id),
  UNIQUE (league_id, retry_idempotency_request_id),
  UNIQUE (league_id, season_rollover_id),
  FOREIGN KEY (league_id, binding_id)
    REFERENCES entry_draft_rollover_bindings(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, from_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, target_schedule_id)
    REFERENCES matchup_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, scheduled_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, retry_idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, retry_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_rollover_id)
    REFERENCES season_rollovers(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (
      trigger_kind = 'scheduled_job'
      AND scheduled_job_run_id IS NOT NULL
      AND retry_idempotency_request_id IS NULL
      AND retry_by_user_id IS NULL
      AND retry_by_membership_id IS NULL
      AND retry_authority IS NULL
    )
    OR (
      trigger_kind = 'commissioner_retry'
      AND scheduled_job_run_id IS NULL
      AND retry_idempotency_request_id IS NOT NULL
      AND retry_by_user_id IS NOT NULL
      AND retry_by_membership_id IS NOT NULL
      AND retry_authority IS NOT NULL
    )
  ),
  CHECK (
    (
      status = 'started'
      AND blockers_json = '[]'
      AND season_rollover_id IS NULL
      AND terminal_at_ms IS NULL
    )
    OR (
      status = 'blocked'
      AND json_array_length(blockers_json) >= 1
      AND season_rollover_id IS NULL
      AND terminal_at_ms IS NOT NULL
      AND updated_at_ms = terminal_at_ms
    )
    OR (
      status = 'succeeded'
      AND blockers_json = '[]'
      AND season_rollover_id IS NOT NULL
      AND terminal_at_ms IS NOT NULL
      AND updated_at_ms = terminal_at_ms
    )
  )
) STRICT;

CREATE INDEX season_rollover_attempts_occurrence_latest
  ON season_rollover_attempts (
    league_id,
    rollover_occurrence_id,
    attempt_number DESC
  );

CREATE INDEX season_rollover_attempts_league_status
  ON season_rollover_attempts (
    league_id,
    status,
    started_at_ms DESC
  );

CREATE TABLE season_rollovers (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL,
  rollover_occurrence_id TEXT NOT NULL,
  rollover_attempt_id TEXT NOT NULL,
  entry_draft_id TEXT NOT NULL,
  target_schedule_id TEXT NOT NULL,
  target_schedule_version INTEGER NOT NULL
    CHECK (target_schedule_version >= 1),
  week_one_matchup_week_id TEXT NOT NULL,
  week_one_starts_at_ms INTEGER NOT NULL
    CHECK (week_one_starts_at_ms >= 0),
  first_pick_clock_id TEXT NOT NULL,
  entry_draft_scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (entry_draft_scheduled_starts_at_ms >= 0),
  occurrence_key TEXT NOT NULL,
  from_season_id TEXT NOT NULL,
  to_season_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'succeeded'),
  execution_trigger TEXT NOT NULL
    CHECK (
      execution_trigger IN ('scheduled_job', 'commissioner_retry')
    ),
  scheduled_job_run_id TEXT,
  idempotency_request_id TEXT,
  executed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  executed_by_membership_id TEXT,
  executed_authority TEXT NOT NULL
    CHECK (
      executed_authority IN (
        'system',
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  entry_draft_scheduled_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  entry_draft_scheduled_by_membership_id TEXT NOT NULL,
  entry_draft_scheduled_by_authority TEXT NOT NULL
    CHECK (
      entry_draft_scheduled_by_authority IN (
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
    CHECK (from_season_version_after = from_season_version_before + 1),
  to_season_version_before INTEGER NOT NULL
    CHECK (to_season_version_before >= 1),
  to_season_version_after INTEGER NOT NULL
    CHECK (to_season_version_after = to_season_version_before + 1),
  entry_draft_version_before INTEGER NOT NULL
    CHECK (entry_draft_version_before >= 1),
  entry_draft_version_after INTEGER NOT NULL
    CHECK (entry_draft_version_after = entry_draft_version_before + 1),
  target_season_reused INTEGER NOT NULL
    CHECK (target_season_reused = 1),
  from_season_label TEXT NOT NULL
    CHECK (length(trim(from_season_label)) > 0),
  from_nhl_season_key TEXT NOT NULL
    CHECK (length(trim(from_nhl_season_key)) > 0),
  to_season_label TEXT NOT NULL
    CHECK (length(trim(to_season_label)) > 0),
  target_nhl_season_key TEXT NOT NULL
    CHECK (length(trim(target_nhl_season_key)) > 0),
  nhl_regular_season_starts_at_ms INTEGER NOT NULL
    CHECK (nhl_regular_season_starts_at_ms >= 0),
  nhl_regular_season_ends_at_ms INTEGER NOT NULL
    CHECK (
      nhl_regular_season_ends_at_ms >
        nhl_regular_season_starts_at_ms
    ),
  fantasy_playoffs_start_at_ms INTEGER NOT NULL
    CHECK (
      fantasy_playoffs_start_at_ms >=
        nhl_regular_season_starts_at_ms
    ),
  fantasy_playoffs_end_at_ms INTEGER NOT NULL
    CHECK (
      fantasy_playoffs_end_at_ms >
        fantasy_playoffs_start_at_ms
    ),
  source_fad_id TEXT NOT NULL,
  source_finalization_root_id TEXT NOT NULL,
  source_finalization_id TEXT NOT NULL,
  source_standings_snapshot_id TEXT NOT NULL,
  source_standings_operation_id TEXT NOT NULL,
  source_readiness_json TEXT NOT NULL
    CHECK (
      json_valid(source_readiness_json) = 1
      AND json_type(source_readiness_json) = 'object'
      AND json(source_readiness_json) = source_readiness_json
    ),
  source_readiness_schema_version INTEGER NOT NULL
    CHECK (source_readiness_schema_version = 1),
  source_readiness_sha256 TEXT NOT NULL
    CHECK (
      length(source_readiness_sha256) = 64
      AND source_readiness_sha256 = lower(source_readiness_sha256)
      AND source_readiness_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  aggregate_activity_id TEXT NOT NULL,
  security_audit_event_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  contracts_advanced INTEGER NOT NULL CHECK (contracts_advanced >= 0),
  contracts_expired INTEGER NOT NULL CHECK (contracts_expired >= 0),
  ownerships_carried INTEGER NOT NULL CHECK (ownerships_carried >= 0),
  ownerships_released INTEGER NOT NULL CHECK (ownerships_released >= 0),
  retention_years_advanced INTEGER NOT NULL
    CHECK (retention_years_advanced >= 0),
  retention_obligations_completed INTEGER NOT NULL
    CHECK (retention_obligations_completed >= 0),
  buyout_years_advanced INTEGER NOT NULL
    CHECK (buyout_years_advanced >= 0),
  buyout_obligations_completed INTEGER NOT NULL
    CHECK (buyout_obligations_completed >= 0),
  trades_cancelled INTEGER NOT NULL CHECK (trades_cancelled >= 0),
  manifest_schema_version INTEGER NOT NULL
    CHECK (manifest_schema_version = 1),
  manifest_sha256 TEXT NOT NULL
    CHECK (
      length(manifest_sha256) = 64
      AND manifest_sha256 = lower(manifest_sha256)
      AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = completed_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, binding_id),
  UNIQUE (league_id, rollover_occurrence_id),
  UNIQUE (league_id, rollover_attempt_id),
  UNIQUE (league_id, entry_draft_id),
  UNIQUE (league_id, from_season_id),
  UNIQUE (league_id, to_season_id),
  UNIQUE (league_id, first_pick_clock_id),
  UNIQUE (league_id, aggregate_activity_id),
  UNIQUE (league_id, security_audit_event_id),
  UNIQUE (league_id, outbox_event_id),
  FOREIGN KEY (league_id, binding_id)
    REFERENCES entry_draft_rollover_bindings(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_attempt_id)
    REFERENCES season_rollover_attempts(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, target_schedule_id)
    REFERENCES matchup_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, first_pick_clock_id)
    REFERENCES entry_draft_pick_clocks(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, from_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, scheduled_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, executed_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, entry_draft_scheduled_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_fad_id)
    REFERENCES free_agent_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_finalization_root_id)
    REFERENCES standings_snapshot_finalizations(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_finalization_id)
    REFERENCES standings_snapshot_finalizations(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_standings_operation_id)
    REFERENCES standings_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, aggregate_activity_id)
    REFERENCES league_activity(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (security_audit_event_id)
    REFERENCES security_audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, outbox_event_id)
    REFERENCES outbox_events(league_id, id) ON DELETE RESTRICT,
  CHECK (from_season_id <> to_season_id),
  CHECK (
    (
      execution_trigger = 'scheduled_job'
      AND scheduled_job_run_id IS NOT NULL
      AND idempotency_request_id IS NULL
      AND executed_by_user_id IS NULL
      AND executed_by_membership_id IS NULL
      AND executed_authority = 'system'
    )
    OR (
      execution_trigger = 'commissioner_retry'
      AND scheduled_job_run_id IS NULL
      AND idempotency_request_id IS NOT NULL
      AND executed_by_user_id IS NOT NULL
      AND executed_by_membership_id IS NOT NULL
      AND executed_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    )
  )
) STRICT;

CREATE INDEX season_rollovers_league_completed
  ON season_rollovers (league_id, completed_at_ms DESC);

CREATE TABLE season_rollover_items (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  rollover_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  rollover_occurrence_id TEXT NOT NULL,
  rollover_attempt_id TEXT NOT NULL,
  idempotency_request_id TEXT,
  from_season_id TEXT NOT NULL,
  to_season_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL
    CHECK (
      effect_kind IN (
        'contract_advanced',
        'contract_expired',
        'ownership_carried',
        'ownership_released',
        'retention_year_advanced',
        'retention_obligation_completed',
        'buyout_year_advanced',
        'buyout_obligation_completed',
        'trade_cancelled'
      )
    ),
  entity_type TEXT NOT NULL
    CHECK (
      entity_type IN (
        'contract',
        'player_ownership',
        'retention_obligation',
        'buyout_obligation',
        'trade'
      )
    ),
  entity_id TEXT NOT NULL
    CHECK (length(entity_id) = 36 AND entity_id = lower(entity_id)),
  before_json TEXT NOT NULL
    CHECK (
      json_valid(before_json) = 1
      AND json_type(before_json) = 'object'
      AND json(before_json) = before_json
    ),
  after_json TEXT NOT NULL
    CHECK (
      json_valid(after_json) = 1
      AND json_type(after_json) = 'object'
      AND json(after_json) = after_json
    ),
  payload_sha256 TEXT NOT NULL
    CHECK (
      length(payload_sha256) = 64
      AND payload_sha256 = lower(payload_sha256)
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_event_id TEXT,
  ownership_event_id TEXT,
  trade_event_id TEXT,
  league_activity_id TEXT,
  causal_assets_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(causal_assets_json) = 1
      AND json_type(causal_assets_json) = 'array'
      AND json(causal_assets_json) = causal_assets_json
    ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = occurred_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, rollover_id, effect_kind, entity_id),
  FOREIGN KEY (league_id, rollover_id)
    REFERENCES season_rollovers(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, binding_id)
    REFERENCES entry_draft_rollover_bindings(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_attempt_id)
    REFERENCES season_rollover_attempts(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, from_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_event_id)
    REFERENCES contract_events(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_event_id)
    REFERENCES ownership_events(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, trade_event_id)
    REFERENCES trade_events(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, league_activity_id)
    REFERENCES league_activity(league_id, id) ON DELETE RESTRICT,
  CHECK (from_season_id <> to_season_id),
  CHECK (
    (
      effect_kind IN ('contract_advanced', 'contract_expired')
      AND entity_type = 'contract'
      AND contract_event_id IS NOT NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NULL
    )
    OR (
      effect_kind IN ('ownership_carried', 'ownership_released')
      AND entity_type = 'player_ownership'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NOT NULL
      AND trade_event_id IS NULL
    )
    OR (
      effect_kind IN (
        'retention_year_advanced',
        'retention_obligation_completed'
      )
      AND entity_type = 'retention_obligation'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NULL
    )
    OR (
      effect_kind IN (
        'buyout_year_advanced',
        'buyout_obligation_completed'
      )
      AND entity_type = 'buyout_obligation'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NULL
    )
    OR (
      effect_kind = 'trade_cancelled'
      AND entity_type = 'trade'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NOT NULL
      AND league_activity_id IS NOT NULL
      AND json_array_length(causal_assets_json) >= 1
    )
  )
) STRICT;

CREATE INDEX season_rollover_items_rollover_order
  ON season_rollover_items (
    league_id,
    rollover_id,
    effect_kind,
    entity_id
  );

CREATE TABLE entry_draft_pick_clocks (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  rollover_occurrence_id TEXT NOT NULL,
  rollover_attempt_id TEXT NOT NULL,
  season_rollover_id TEXT NOT NULL,
  entry_draft_id TEXT NOT NULL,
  draft_pick_id TEXT NOT NULL,
  owning_team_id TEXT NOT NULL,
  clock_generation INTEGER NOT NULL CHECK (clock_generation >= 1),
  prior_clock_id TEXT,
  on_clock_trade_id TEXT,
  pick_sequence INTEGER NOT NULL CHECK (pick_sequence >= 1),
  status TEXT NOT NULL
    CHECK (status IN ('prepared', 'running', 'completed')),
  starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0),
  deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms > starts_at_ms),
  completed_at_ms INTEGER
    CHECK (
      completed_at_ms IS NULL
      OR completed_at_ms >= starts_at_ms
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (
    league_id,
    entry_draft_id,
    draft_pick_id,
    clock_generation
  ),
  UNIQUE (league_id, prior_clock_id),
  UNIQUE (league_id, on_clock_trade_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, binding_id)
    REFERENCES entry_draft_rollover_bindings(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_attempt_id)
    REFERENCES season_rollover_attempts(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_rollover_id)
    REFERENCES season_rollovers(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, draft_pick_id)
    REFERENCES draft_picks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, owning_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, prior_clock_id)
    REFERENCES entry_draft_pick_clocks(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, on_clock_trade_id)
    REFERENCES entry_draft_on_clock_trades(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (
      clock_generation = 1
      AND prior_clock_id IS NULL
      AND on_clock_trade_id IS NULL
    )
    OR (
      clock_generation > 1
      AND prior_clock_id IS NOT NULL
      AND on_clock_trade_id IS NOT NULL
    )
  ),
  CHECK (
    (
      status IN ('prepared', 'running')
      AND completed_at_ms IS NULL
    )
    OR (
      status = 'completed'
      AND completed_at_ms IS NOT NULL
      AND updated_at_ms = completed_at_ms
    )
  )
) STRICT;

CREATE UNIQUE INDEX entry_draft_pick_clocks_one_current
  ON entry_draft_pick_clocks (league_id, entry_draft_id)
  WHERE status IN ('prepared', 'running');

CREATE INDEX entry_draft_pick_clocks_due
  ON entry_draft_pick_clocks (
    league_id,
    status,
    deadline_at_ms
  );

CREATE TABLE entry_draft_on_clock_trades (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  entry_draft_id TEXT NOT NULL,
  draft_pick_id TEXT NOT NULL,
  completed_trade_id TEXT NOT NULL,
  draft_pick_ownership_event_id TEXT NOT NULL,
  new_owning_team_id TEXT NOT NULL,
  prior_clock_id TEXT NOT NULL,
  fresh_clock_id TEXT NOT NULL,
  prior_clock_generation INTEGER NOT NULL
    CHECK (prior_clock_generation >= 1),
  fresh_clock_generation INTEGER NOT NULL
    CHECK (fresh_clock_generation = prior_clock_generation + 1),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = completed_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, draft_pick_id),
  UNIQUE (league_id, completed_trade_id),
  UNIQUE (league_id, draft_pick_ownership_event_id),
  UNIQUE (league_id, prior_clock_id),
  UNIQUE (league_id, fresh_clock_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, draft_pick_id)
    REFERENCES draft_picks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, completed_trade_id)
    REFERENCES trades(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, draft_pick_ownership_event_id)
    REFERENCES draft_pick_ownership_events(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, new_owning_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, prior_clock_id)
    REFERENCES entry_draft_pick_clocks(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, fresh_clock_id)
    REFERENCES entry_draft_pick_clocks(league_id, id)
    ON DELETE RESTRICT,
  CHECK (prior_clock_id <> fresh_clock_id)
) STRICT;

-- One immutable row is the authoritative replay result for every commissioner
-- schedule or reschedule command. The Entry Draft's persisted `ready` status
-- is the setup-confirmed source; the draft order, eligibility snapshot, and
-- current pick ownership rows remain the other normalized readiness sources.

CREATE TABLE entry_draft_schedule_operations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  entry_draft_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('schedule', 'reschedule')),
  idempotency_request_id TEXT NOT NULL,
  rollover_binding_id TEXT NOT NULL,
  rollover_occurrence_id TEXT NOT NULL,
  scheduled_job_run_id TEXT NOT NULL,
  superseded_rollover_occurrence_id TEXT,
  superseded_job_run_id TEXT,
  scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (scheduled_starts_at_ms >= 0),
  entry_draft_version_before INTEGER NOT NULL
    CHECK (entry_draft_version_before >= 1),
  entry_draft_version_after INTEGER NOT NULL
    CHECK (entry_draft_version_after = entry_draft_version_before + 1),
  rollover_binding_version_before INTEGER NOT NULL
    CHECK (rollover_binding_version_before >= 0),
  rollover_binding_version_after INTEGER NOT NULL
    CHECK (
      rollover_binding_version_after =
        rollover_binding_version_before + 1
    ),
  scheduled_job_version INTEGER NOT NULL
    CHECK (scheduled_job_version >= 1),
  superseded_job_version_before INTEGER
    CHECK (
      superseded_job_version_before IS NULL
      OR superseded_job_version_before >= 1
    ),
  superseded_job_version_after INTEGER
    CHECK (
      superseded_job_version_after IS NULL
      OR superseded_job_version_after =
        superseded_job_version_before + 1
    ),
  scheduled_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  scheduled_by_membership_id TEXT NOT NULL,
  scheduled_by_authority TEXT NOT NULL
    CHECK (
      scheduled_by_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  reason TEXT
    CHECK (
      reason IS NULL
      OR (
        reason = trim(reason)
        AND length(reason) BETWEEN 1 AND 500
        AND instr(reason, char(0)) = 0
        AND reason NOT GLOB
          ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
      )
    ),
  result_schema_version INTEGER NOT NULL
    CHECK (result_schema_version = 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, idempotency_request_id),
  UNIQUE (league_id, rollover_occurrence_id),
  UNIQUE (league_id, scheduled_job_run_id),
  UNIQUE (
    league_id,
    entry_draft_id,
    entry_draft_version_after
  ),
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_binding_id)
    REFERENCES entry_draft_rollover_bindings(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, scheduled_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, superseded_rollover_occurrence_id)
    REFERENCES season_rollover_occurrences(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, superseded_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, scheduled_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      action = 'schedule'
      AND rollover_binding_version_before = 0
      AND rollover_binding_version_after = 1
      AND superseded_rollover_occurrence_id IS NULL
      AND superseded_job_run_id IS NULL
      AND superseded_job_version_before IS NULL
      AND superseded_job_version_after IS NULL
      AND reason IS NULL
    )
    OR (
      action = 'reschedule'
      AND rollover_binding_version_before >= 1
      AND superseded_rollover_occurrence_id IS NOT NULL
      AND superseded_job_run_id IS NOT NULL
      AND superseded_job_version_before IS NOT NULL
      AND superseded_job_version_after IS NOT NULL
      AND superseded_rollover_occurrence_id <>
        rollover_occurrence_id
      AND superseded_job_run_id <> scheduled_job_run_id
    )
  )
) STRICT;

CREATE INDEX entry_draft_schedule_operations_draft_time
  ON entry_draft_schedule_operations (
    league_id,
    entry_draft_id,
    created_at_ms,
    id
  );

-- Automatic all-team Candidate readiness and annual FAD root.

CREATE TABLE free_agent_draft_readiness_operations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  readiness_occurrence_key TEXT NOT NULL
    CHECK (
      readiness_occurrence_key = trim(readiness_occurrence_key)
      AND length(readiness_occurrence_key) BETWEEN 1 AND 500
    ),
  trigger_kind TEXT NOT NULL
    CHECK (
      trigger_kind IN (
        'entry_draft_completed',
        'no_draft_inaugural',
        'no_draft_initial_season2'
      )
    ),
  entry_draft_id TEXT,
  setup_exemption_id TEXT,
  job_run_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'blocked', 'succeeded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at_ms INTEGER
    CHECK (
      lease_expires_at_ms IS NULL
      OR lease_expires_at_ms >= 0
    ),
  blockers_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(blockers_json) = 1
      AND json_type(blockers_json) = 'array'
      AND json(blockers_json) = blockers_json
    ),
  matchup_schedule_version_before INTEGER
    CHECK (
      matchup_schedule_version_before IS NULL
      OR matchup_schedule_version_before >= 1
    ),
  matchup_schedule_version_after INTEGER
    CHECK (
      matchup_schedule_version_after IS NULL
      OR matchup_schedule_version_after >= 1
    ),
  schedule_recovery_id TEXT,
  created_fad_id TEXT,
  reminder_job_run_id TEXT,
  deadline_job_run_id TEXT,
  cards_opened_activity_id TEXT,
  cards_opened_outbox_event_id TEXT,
  started_at_ms INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  next_retry_at_ms INTEGER
    CHECK (next_retry_at_ms IS NULL OR next_retry_at_ms >= 0),
  terminal_at_ms INTEGER
    CHECK (
      terminal_at_ms IS NULL
      OR (
        started_at_ms IS NOT NULL
        AND terminal_at_ms >= started_at_ms
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id),
  UNIQUE (league_id, readiness_occurrence_key),
  UNIQUE (league_id, created_fad_id),
  UNIQUE (league_id, reminder_job_run_id),
  UNIQUE (league_id, deadline_job_run_id),
  UNIQUE (league_id, cards_opened_activity_id),
  UNIQUE (league_id, cards_opened_outbox_event_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, setup_exemption_id)
    REFERENCES free_agent_draft_setup_exemptions(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, schedule_recovery_id)
    REFERENCES free_agent_draft_schedule_recoveries(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, created_fad_id)
    REFERENCES free_agent_drafts(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, reminder_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, deadline_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, cards_opened_activity_id)
    REFERENCES league_activity(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, cards_opened_outbox_event_id)
    REFERENCES outbox_events(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      trigger_kind = 'entry_draft_completed'
      AND entry_draft_id IS NOT NULL
      AND setup_exemption_id IS NULL
    )
    OR (
      trigger_kind = 'no_draft_inaugural'
      AND entry_draft_id IS NULL
      AND setup_exemption_id IS NULL
    )
    OR (
      trigger_kind = 'no_draft_initial_season2'
      AND entry_draft_id IS NULL
      AND setup_exemption_id IS NOT NULL
    )
  ),
  CHECK (
    (
      status = 'pending'
      AND started_at_ms IS NULL
      AND blockers_json = '[]'
      AND created_fad_id IS NULL
      AND reminder_job_run_id IS NULL
      AND deadline_job_run_id IS NULL
      AND cards_opened_activity_id IS NULL
      AND cards_opened_outbox_event_id IS NULL
      AND terminal_at_ms IS NULL
    )
    OR (
      status = 'running'
      AND started_at_ms IS NOT NULL
      AND blockers_json = '[]'
      AND created_fad_id IS NULL
      AND reminder_job_run_id IS NULL
      AND deadline_job_run_id IS NULL
      AND cards_opened_activity_id IS NULL
      AND cards_opened_outbox_event_id IS NULL
      AND terminal_at_ms IS NULL
    )
    OR (
      status = 'blocked'
      AND started_at_ms IS NOT NULL
      AND json_array_length(blockers_json) >= 1
      AND created_fad_id IS NULL
      AND schedule_recovery_id IS NULL
      AND reminder_job_run_id IS NULL
      AND deadline_job_run_id IS NULL
      AND cards_opened_activity_id IS NULL
      AND cards_opened_outbox_event_id IS NULL
      AND terminal_at_ms IS NOT NULL
    )
    OR (
      status = 'succeeded'
      AND started_at_ms IS NOT NULL
      AND blockers_json = '[]'
      AND created_fad_id IS NOT NULL
      AND reminder_job_run_id IS NOT NULL
      AND deadline_job_run_id IS NOT NULL
      AND cards_opened_activity_id IS NOT NULL
      AND cards_opened_outbox_event_id IS NOT NULL
      AND terminal_at_ms IS NOT NULL
    )
  ),
  CHECK (
    (
      matchup_schedule_version_before IS NULL
      AND matchup_schedule_version_after IS NULL
      AND schedule_recovery_id IS NULL
    )
    OR (
      matchup_schedule_version_before IS NOT NULL
      AND matchup_schedule_version_after IS NOT NULL
      AND matchup_schedule_version_after >=
        matchup_schedule_version_before
      AND (
        (
          matchup_schedule_version_after =
            matchup_schedule_version_before
          AND schedule_recovery_id IS NULL
        )
        OR (
          matchup_schedule_version_after >
            matchup_schedule_version_before
          AND schedule_recovery_id IS NOT NULL
        )
      )
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_readiness_operations_league_status
  ON free_agent_draft_readiness_operations (
    league_id,
    status,
    next_retry_at_ms
  );

CREATE TABLE free_agent_drafts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  readiness_operation_id TEXT NOT NULL,
  readiness_occurrence_key TEXT NOT NULL,
  first_matchup_week_id TEXT NOT NULL,
  current_competition_first_matchup_week_id TEXT NOT NULL,
  schedule_recovery_id TEXT,
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
  opening_authority TEXT NOT NULL CHECK (opening_authority = 'system'),
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
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = opened_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id),
  UNIQUE (league_id, season_id, id),
  UNIQUE (league_id, readiness_operation_id),
  UNIQUE (league_id, readiness_occurrence_key),
  UNIQUE (league_id, schedule_recovery_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, readiness_operation_id)
    REFERENCES free_agent_draft_readiness_operations(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, current_competition_first_matchup_week_id)
    REFERENCES matchup_weeks(league_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, schedule_recovery_id)
    REFERENCES free_agent_draft_schedule_recoveries(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, entry_draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, setup_exemption_id)
    REFERENCES free_agent_draft_setup_exemptions(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, prior_season_rollover_id)
    REFERENCES season_rollovers(league_id, id) ON DELETE RESTRICT,
  CHECK (
    candidate_deadline_at_ms =
      first_matchup_starts_at_ms - 604800000
    AND help_opens_at_ms = CASE
      WHEN opened_at_ms >
        candidate_deadline_at_ms - 172800000
      THEN opened_at_ms
      ELSE candidate_deadline_at_ms - 172800000
    END
    AND opened_at_ms < candidate_deadline_at_ms
  ),
  CHECK (
    (
      setup_path = 'completed_entry_draft'
      AND entry_draft_id IS NOT NULL
      AND setup_exemption_id IS NULL
      AND prior_season_rollover_id IS NOT NULL
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
      schedule_recovery_id IS NULL
      AND current_competition_first_matchup_week_id =
        first_matchup_week_id
    )
    OR (
      schedule_recovery_id IS NOT NULL
      AND current_competition_first_matchup_week_id <>
        first_matchup_week_id
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

CREATE TABLE free_agent_draft_schedule_recoveries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  recovery_kind TEXT NOT NULL
    CHECK (recovery_kind IN ('pre_open', 'completion')),
  matchup_operation_id TEXT NOT NULL,
  old_schedule_operation_id TEXT NOT NULL,
  new_schedule_operation_id TEXT NOT NULL,
  old_first_matchup_week_id TEXT NOT NULL,
  new_first_matchup_week_id TEXT NOT NULL,
  old_schedule_version INTEGER NOT NULL
    CHECK (old_schedule_version >= 1),
  new_schedule_version INTEGER NOT NULL
    CHECK (new_schedule_version = old_schedule_version + 1),
  old_week_one_starts_at_ms INTEGER NOT NULL
    CHECK (old_week_one_starts_at_ms >= 0),
  new_week_one_starts_at_ms INTEGER NOT NULL
    CHECK (new_week_one_starts_at_ms > old_week_one_starts_at_ms),
  removed_week_count INTEGER NOT NULL
    CHECK (removed_week_count >= 1),
  removed_matchup_count INTEGER NOT NULL
    CHECK (removed_matchup_count >= 0),
  replaced_job_count INTEGER NOT NULL
    CHECK (replaced_job_count >= 0),
  cancelled_job_count INTEGER NOT NULL
    CHECK (cancelled_job_count >= 0),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  evidence_schema_version INTEGER NOT NULL
    CHECK (evidence_schema_version = 1),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      length(evidence_sha256) = 64
      AND evidence_sha256 = lower(evidence_sha256)
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = completed_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, fad_id, recovery_kind),
  UNIQUE (league_id, matchup_operation_id),
  UNIQUE (league_id, new_schedule_operation_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, fad_id)
    REFERENCES free_agent_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_operation_id)
    REFERENCES matchup_operations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    old_schedule_operation_id,
    old_schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    new_schedule_operation_id,
    new_schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, new_first_matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  CHECK (
    old_first_matchup_week_id <> new_first_matchup_week_id
    AND old_schedule_operation_id <> new_schedule_operation_id
    AND matchup_operation_id = new_schedule_operation_id
  )
) STRICT;

CREATE TABLE free_agent_draft_schedule_recovery_weeks (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  schedule_recovery_id TEXT NOT NULL,
  removed_matchup_week_id TEXT NOT NULL
    CHECK (
      length(removed_matchup_week_id) = 36
      AND removed_matchup_week_id =
        lower(removed_matchup_week_id)
    ),
  removed_sequence INTEGER NOT NULL CHECK (removed_sequence >= 1),
  removed_starts_at_ms INTEGER NOT NULL CHECK (removed_starts_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, schedule_recovery_id, removed_matchup_week_id),
  UNIQUE (league_id, schedule_recovery_id, removed_sequence),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, schedule_recovery_id)
    REFERENCES free_agent_draft_schedule_recoveries(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE free_agent_draft_schedule_recovery_matchups (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  schedule_recovery_id TEXT NOT NULL,
  removed_matchup_id TEXT NOT NULL
    CHECK (
      length(removed_matchup_id) = 36
      AND removed_matchup_id = lower(removed_matchup_id)
    ),
  removed_matchup_week_id TEXT NOT NULL
    CHECK (
      length(removed_matchup_week_id) = 36
      AND removed_matchup_week_id =
        lower(removed_matchup_week_id)
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, schedule_recovery_id, removed_matchup_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, schedule_recovery_id)
    REFERENCES free_agent_draft_schedule_recoveries(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE free_agent_draft_schedule_recovery_jobs (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  schedule_recovery_id TEXT NOT NULL,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('replaced', 'cancelled')),
  job_type TEXT NOT NULL CHECK (length(trim(job_type)) > 0),
  replaced_job_run_id TEXT NOT NULL,
  replacement_job_run_id TEXT,
  replaced_occurrence_key TEXT NOT NULL,
  replacement_occurrence_key TEXT,
  replaced_schedule_operation_id TEXT NOT NULL,
  replaced_schedule_version INTEGER NOT NULL
    CHECK (replaced_schedule_version >= 1),
  replacement_schedule_operation_id TEXT,
  replacement_schedule_version INTEGER
    CHECK (
      replacement_schedule_version IS NULL
      OR replacement_schedule_version >= 1
    ),
  replaced_job_version INTEGER NOT NULL CHECK (replaced_job_version >= 1),
  replacement_job_version INTEGER
    CHECK (
      replacement_job_version IS NULL
      OR replacement_job_version >= 1
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, schedule_recovery_id, replaced_job_run_id),
  UNIQUE (league_id, schedule_recovery_id, replacement_job_run_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, schedule_recovery_id)
    REFERENCES free_agent_draft_schedule_recoveries(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, replaced_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, replacement_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    replaced_schedule_operation_id,
    replaced_schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    replacement_schedule_operation_id,
    replacement_schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT,
  CHECK (
    (
      disposition = 'replaced'
      AND replacement_job_run_id IS NOT NULL
      AND replacement_occurrence_key IS NOT NULL
      AND replacement_schedule_operation_id IS NOT NULL
      AND replacement_schedule_version IS NOT NULL
      AND replacement_job_version IS NOT NULL
      AND replaced_job_run_id <> replacement_job_run_id
      AND replaced_occurrence_key <> replacement_occurrence_key
    )
    OR (
      disposition = 'cancelled'
      AND replacement_job_run_id IS NULL
      AND replacement_occurrence_key IS NULL
      AND replacement_schedule_operation_id IS NULL
      AND replacement_schedule_version IS NULL
      AND replacement_job_version IS NULL
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_schedule_recovery_matchups_week
  ON free_agent_draft_schedule_recovery_matchups (
    league_id,
    schedule_recovery_id,
    removed_matchup_week_id,
    removed_matchup_id
  );

CREATE INDEX free_agent_draft_schedule_recovery_jobs_disposition
  ON free_agent_draft_schedule_recovery_jobs (
    league_id,
    schedule_recovery_id,
    disposition,
    replaced_job_run_id
  );

-- Card-wide cap eligibility is explicit. The guard proves all altered tables
-- are empty, so defaults do not synthesize historical decisions.

ALTER TABLE candidate_cards
  ADD COLUMN carried_roster_structural_conflict_count INTEGER NOT NULL
    DEFAULT 0
    CHECK (
      carried_roster_structural_conflict_count >= 0
      AND carried_roster_structural_conflict_count <=
        structural_conflict_count
    );

ALTER TABLE candidate_cards
  ADD COLUMN cap_status TEXT NOT NULL DEFAULT 'compliant'
  CHECK (cap_status IN ('compliant', 'over_cap'));

ALTER TABLE candidate_cards
  ADD COLUMN allocation_eligibility TEXT NOT NULL DEFAULT 'eligible'
  CHECK (
    allocation_eligibility IN (
      'eligible',
      'excluded_structural_conflict',
      'excluded_over_cap'
    )
  );

ALTER TABLE candidate_cards
  ADD COLUMN allocation_exclusion_reason TEXT
  CHECK (
    allocation_exclusion_reason IS NULL
    OR allocation_exclusion_reason IN (
      'candidate_card_structural_conflict',
      'candidate_card_over_cap'
    )
  );

ALTER TABLE candidate_card_snapshots
  ADD COLUMN carried_roster_structural_conflict_count INTEGER NOT NULL
    DEFAULT 0
    CHECK (
      carried_roster_structural_conflict_count >= 0
      AND carried_roster_structural_conflict_count <=
        structural_conflict_count
    );

ALTER TABLE candidate_card_snapshots
  ADD COLUMN cap_status TEXT NOT NULL DEFAULT 'compliant'
  CHECK (cap_status IN ('compliant', 'over_cap'));

ALTER TABLE candidate_card_snapshots
  ADD COLUMN allocation_eligibility TEXT NOT NULL DEFAULT 'eligible'
  CHECK (
    allocation_eligibility IN (
      'eligible',
      'excluded_structural_conflict',
      'excluded_over_cap'
    )
  );

ALTER TABLE candidate_card_snapshots
  ADD COLUMN allocation_exclusion_reason TEXT
  CHECK (
    allocation_exclusion_reason IS NULL
    OR allocation_exclusion_reason IN (
      'candidate_card_structural_conflict',
      'candidate_card_over_cap'
    )
  );

ALTER TABLE candidate_card_snapshot_entries
  ADD COLUMN allocation_eligibility TEXT
  CHECK (
    allocation_eligibility IS NULL
    OR allocation_eligibility IN (
      'eligible',
      'excluded_structural_conflict',
      'excluded_over_cap'
    )
  );

ALTER TABLE candidate_card_snapshot_entries
  ADD COLUMN allocation_exclusion_reason TEXT
  CHECK (
    allocation_exclusion_reason IS NULL
    OR allocation_exclusion_reason IN (
      'candidate_card_structural_conflict',
      'candidate_card_over_cap'
    )
  );

-- Make the amendment deterministic even for a locally-created pre-0030
-- fixture. Unresolved carried-roster structural legality controls allocation
-- eligibility first, while the independently-computed cap status continues
-- to report over-cap cards. Candidate-only conflicts remain in the total
-- structural count without excluding the whole card.

UPDATE candidate_cards
SET carried_roster_structural_conflict_count = (
  SELECT COUNT(*)
  FROM candidate_card_entries
  WHERE candidate_card_entries.league_id = candidate_cards.league_id
    AND candidate_card_entries.card_id = candidate_cards.id
    AND candidate_card_entries.entry_kind = 'carryover'
    AND candidate_card_entries.placement_state = 'conflict'
);

UPDATE candidate_card_snapshots
SET carried_roster_structural_conflict_count = (
  SELECT COUNT(*)
  FROM candidate_card_snapshot_entries
  WHERE candidate_card_snapshot_entries.league_id =
        candidate_card_snapshots.league_id
    AND candidate_card_snapshot_entries.snapshot_id =
        candidate_card_snapshots.id
    AND candidate_card_snapshot_entries.row_kind = 'conflict'
    AND candidate_card_snapshot_entries.occupant_kind = 'carryover'
);

UPDATE candidate_cards
SET cap_status = CASE
      WHEN maximum_possible_cap_cents > (
        SELECT league_settings.salary_cap_cents
        FROM league_settings
        WHERE league_settings.league_id = candidate_cards.league_id
      ) THEN 'over_cap'
      ELSE 'compliant'
    END,
    allocation_eligibility = CASE
      WHEN carried_roster_structural_conflict_count > 0
        THEN 'excluded_structural_conflict'
      WHEN maximum_possible_cap_cents > (
        SELECT league_settings.salary_cap_cents
        FROM league_settings
        WHERE league_settings.league_id = candidate_cards.league_id
      ) THEN 'excluded_over_cap'
      ELSE 'eligible'
    END,
    allocation_exclusion_reason = CASE
      WHEN carried_roster_structural_conflict_count > 0
        THEN 'candidate_card_structural_conflict'
      WHEN maximum_possible_cap_cents > (
        SELECT league_settings.salary_cap_cents
        FROM league_settings
        WHERE league_settings.league_id = candidate_cards.league_id
      ) THEN 'candidate_card_over_cap'
      ELSE NULL
    END;

UPDATE candidate_card_snapshots
SET cap_status = CASE
      WHEN maximum_possible_cap_cents > cap_limit_cents
        THEN 'over_cap'
      ELSE 'compliant'
    END,
    allocation_eligibility = CASE
      WHEN carried_roster_structural_conflict_count > 0
        THEN 'excluded_structural_conflict'
      WHEN maximum_possible_cap_cents > cap_limit_cents
        THEN 'excluded_over_cap'
      ELSE 'eligible'
    END,
    allocation_exclusion_reason = CASE
      WHEN carried_roster_structural_conflict_count > 0
        THEN 'candidate_card_structural_conflict'
      WHEN maximum_possible_cap_cents > cap_limit_cents
        THEN 'candidate_card_over_cap'
      ELSE NULL
    END;

UPDATE candidate_card_snapshot_entries
SET allocation_eligibility = CASE
      WHEN occupant_kind = 'candidate' THEN (
        SELECT candidate_card_snapshots.allocation_eligibility
        FROM candidate_card_snapshots
        WHERE candidate_card_snapshots.league_id =
              candidate_card_snapshot_entries.league_id
          AND candidate_card_snapshots.id =
              candidate_card_snapshot_entries.snapshot_id
      )
      ELSE NULL
    END,
    allocation_exclusion_reason = CASE
      WHEN occupant_kind = 'candidate' THEN (
        SELECT candidate_card_snapshots.allocation_exclusion_reason
        FROM candidate_card_snapshots
        WHERE candidate_card_snapshots.league_id =
              candidate_card_snapshot_entries.league_id
          AND candidate_card_snapshots.id =
              candidate_card_snapshot_entries.snapshot_id
      )
      ELSE NULL
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
        'carryover_moved',
        'carryover_synchronized',
        'eligibility_revalidated',
        'summer_state_synchronized',
        'deadline_locked'
      )
    ),
  affected_entry_id TEXT
    CHECK (
      affected_entry_id IS NULL
      OR (length(affected_entry_id) = 36 AND affected_entry_id = lower(affected_entry_id))
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
      json_valid(before_evidence_json) = 1
      AND json_type(before_evidence_json) = 'object'
      AND length(before_evidence_json) BETWEEN 2 AND 65536
    ),
  after_evidence_json TEXT NOT NULL
    CHECK (
      json_valid(after_evidence_json) = 1
      AND json_type(after_evidence_json) = 'object'
      AND length(after_evidence_json) BETWEEN 2 AND 65536
    ),
  potential_illegality_acknowledged INTEGER NOT NULL
    CHECK (potential_illegality_acknowledged = 0),
  warning_codes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(warning_codes_json) = 1
      AND json_type(warning_codes_json) = 'array'
    ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= occurred_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
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
    (
      action IN (
        'candidate_added',
        'candidate_edited',
        'candidate_moved',
        'candidate_removed',
        'carryover_moved'
      )
      AND affected_entry_id IS NOT NULL
      AND player_id IS NOT NULL
    )
    OR action NOT IN (
      'candidate_added',
      'candidate_edited',
      'candidate_moved',
      'candidate_removed',
      'carryover_moved'
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

CREATE TABLE free_agent_draft_rollovers (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  window_kind TEXT NOT NULL
    CHECK (window_kind IN ('initial', 'extension')),
  predecessor_rollover_id TEXT,
  extension_reason TEXT
    CHECK (
      extension_reason IS NULL
      OR extension_reason IN (
        'queued_nomination',
        'restricted_auction',
        'fallback_auction',
        'recovery'
      )
    ),
  extension_source_id TEXT,
  opens_at_ms INTEGER NOT NULL CHECK (opens_at_ms >= 0),
  creation_cutoff_at_ms INTEGER NOT NULL
    CHECK (creation_cutoff_at_ms >= 0),
  rolls_over_at_ms INTEGER NOT NULL CHECK (rolls_over_at_ms >= 0),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'scheduled',
        'processing',
        'completed',
        'recovery_required'
      )
    ),
  processing_job_run_id TEXT,
  processing_started_at_ms INTEGER
    CHECK (
      processing_started_at_ms IS NULL
      OR processing_started_at_ms >= rolls_over_at_ms
    ),
  completed_at_ms INTEGER
    CHECK (
      completed_at_ms IS NULL
      OR (
        processing_started_at_ms IS NOT NULL
        AND completed_at_ms >= processing_started_at_ms
      )
    ),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        last_error_code = trim(last_error_code)
        AND length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, id),
  UNIQUE (league_id, season_id, fad_id, sequence),
  UNIQUE (league_id, season_id, fad_id, rolls_over_at_ms),
  UNIQUE (league_id, predecessor_rollover_id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, predecessor_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, processing_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  CHECK (
    creation_cutoff_at_ms = rolls_over_at_ms - 3600000
    AND opens_at_ms = rolls_over_at_ms - 86400000
  ),
  CHECK (
    (
      window_kind = 'initial'
      AND sequence BETWEEN 1 AND 7
      AND extension_reason IS NULL
      AND extension_source_id IS NULL
    )
    OR (
      window_kind = 'extension'
      AND sequence >= 8
      AND predecessor_rollover_id IS NOT NULL
      AND extension_reason IS NOT NULL
      AND extension_source_id IS NOT NULL
    )
  ),
  CHECK (
    (sequence = 1 AND predecessor_rollover_id IS NULL)
    OR (sequence > 1 AND predecessor_rollover_id IS NOT NULL)
  ),
  CHECK (
    (
      status = 'scheduled'
      AND processing_job_run_id IS NULL
      AND processing_started_at_ms IS NULL
      AND completed_at_ms IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'processing'
      AND processing_job_run_id IS NOT NULL
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'completed'
      AND processing_job_run_id IS NOT NULL
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'recovery_required'
      AND processing_job_run_id IS NOT NULL
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
      AND last_error_code IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_rollovers_league_fad_status_time
  ON free_agent_draft_rollovers (
    league_id,
    fad_id,
    status,
    rolls_over_at_ms
  );

CREATE TABLE free_agent_draft_player_allocations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending',
        'automatic_award',
        'restricted_scheduled',
        'restricted_active',
        'restricted_fallback_open',
        'restricted_resolved',
        'fallback_open_resolved',
        'no_valid_offer',
        'invalid',
        'correction_required'
      )
    ),
  decision_code TEXT
    CHECK (
      decision_code IS NULL
      OR decision_code IN (
        'sole_valid_offer',
        'highest_total',
        'highest_equal_total_aav',
        'exact_total_and_term_tie',
        'no_valid_offer',
        'invalid_snapshot',
        'candidate_card_structural_conflict',
        'candidate_card_over_cap',
        'restricted_auction_result',
        'restricted_no_improvement_fallback',
        'fallback_open_result',
        'fallback_open_no_winner',
        'corrected'
      )
    ),
  winning_snapshot_entry_id TEXT,
  winning_team_id TEXT,
  contract_id TEXT,
  ownership_id TEXT,
  restricted_auction_id TEXT,
  fallback_open_auction_id TEXT,
  restricted_minimum_total_cents INTEGER
    CHECK (
      restricted_minimum_total_cents IS NULL
      OR restricted_minimum_total_cents > 0
    ),
  restricted_minimum_term_years INTEGER
    CHECK (
      restricted_minimum_term_years IS NULL
      OR restricted_minimum_term_years BETWEEN 1 AND 3
    ),
  restricted_minimum_aav_cents INTEGER
    CHECK (
      restricted_minimum_aav_cents IS NULL
      OR restricted_minimum_aav_cents >= 100
    ),
  accounted_at_ms INTEGER
    CHECK (accounted_at_ms IS NULL OR accounted_at_ms >= 0),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        last_error_code = trim(last_error_code)
        AND length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, id),
  UNIQUE (league_id, season_id, fad_id, id, player_id),
  UNIQUE (league_id, season_id, fad_id, player_id),
  UNIQUE (league_id, restricted_auction_id),
  UNIQUE (league_id, fallback_open_auction_id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_snapshot_entry_id)
    REFERENCES candidate_card_snapshot_entries(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, restricted_auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, fallback_open_auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      winning_snapshot_entry_id IS NULL
      AND winning_team_id IS NULL
      AND contract_id IS NULL
      AND ownership_id IS NULL
    )
    OR (
      winning_snapshot_entry_id IS NOT NULL
      AND winning_team_id IS NOT NULL
      AND contract_id IS NOT NULL
      AND ownership_id IS NOT NULL
    )
    OR (
      status = 'fallback_open_resolved'
      AND decision_code = 'fallback_open_result'
      AND winning_snapshot_entry_id IS NULL
      AND winning_team_id IS NOT NULL
      AND contract_id IS NOT NULL
      AND ownership_id IS NOT NULL
    )
  ),
  CHECK (
    (
      restricted_minimum_total_cents IS NULL
      AND restricted_minimum_term_years IS NULL
      AND restricted_minimum_aav_cents IS NULL
    )
    OR (
      restricted_minimum_total_cents IS NOT NULL
      AND restricted_minimum_term_years IS NOT NULL
      AND restricted_minimum_aav_cents IS NOT NULL
      AND restricted_minimum_aav_cents =
        (restricted_minimum_total_cents / restricted_minimum_term_years)
        + CASE
            WHEN
              (
                restricted_minimum_total_cents
                % restricted_minimum_term_years
              ) * 2 >= restricted_minimum_term_years
            THEN 1
            ELSE 0
          END
      AND (
        restricted_minimum_term_years = 1
        OR restricted_minimum_total_cents % 100 = 0
      )
    )
  ),
  CHECK (
    restricted_auction_id IS NULL
    OR restricted_minimum_total_cents IS NOT NULL
  ),
  CHECK (
    status <> 'restricted_fallback_open'
    OR (
      restricted_auction_id IS NOT NULL
      AND fallback_open_auction_id IS NOT NULL
      AND decision_code = 'restricted_no_improvement_fallback'
      AND winning_snapshot_entry_id IS NULL
    )
  ),
  CHECK (
    status NOT IN ('restricted_resolved', 'fallback_open_resolved')
    OR accounted_at_ms IS NOT NULL
  )
) STRICT;

CREATE INDEX free_agent_draft_allocations_league_fad_status
  ON free_agent_draft_player_allocations (
    league_id,
    fad_id,
    status
  );

CREATE INDEX free_agent_draft_allocations_league_player_status
  ON free_agent_draft_player_allocations (
    league_id,
    player_id,
    status
  );

CREATE TABLE free_agent_draft_allocation_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  allocation_version INTEGER NOT NULL CHECK (allocation_version >= 1),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_kind TEXT NOT NULL
    CHECK (
      event_kind IN (
        'offer_considered',
        'decision_recorded',
        'restricted_state_changed',
        'fallback_state_changed',
        'correction_applied'
      )
    ),
  snapshot_entry_id TEXT,
  team_id TEXT,
  offer_valid INTEGER CHECK (offer_valid IS NULL OR offer_valid IN (0, 1)),
  rank_position INTEGER CHECK (rank_position IS NULL OR rank_position >= 1),
  offer_outcome_code TEXT
    CHECK (
      offer_outcome_code IS NULL
      OR offer_outcome_code IN (
        'winner',
        'lost_lower_total',
        'lost_lower_aav',
        'restricted_tied',
        'excluded_structural_conflict',
        'excluded_over_cap',
        'invalid'
      )
    ),
  decision_code TEXT,
  resulting_allocation_status TEXT NOT NULL
    CHECK (
      resulting_allocation_status IN (
        'pending',
        'automatic_award',
        'restricted_scheduled',
        'restricted_active',
        'restricted_fallback_open',
        'restricted_resolved',
        'fallback_open_resolved',
        'no_valid_offer',
        'invalid',
        'correction_required'
      )
    ),
  contract_id TEXT,
  ownership_id TEXT,
  auction_id TEXT,
  activity_id TEXT,
  correction_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'system',
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  evidence_json TEXT NOT NULL
    CHECK (
      json_valid(evidence_json) = 1
      AND json_type(evidence_json) = 'object'
      AND length(evidence_json) BETWEEN 2 AND 100000
    ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= occurred_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    player_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id,
    player_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, snapshot_entry_id)
    REFERENCES candidate_card_snapshot_entries(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, activity_id)
    REFERENCES league_activity(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, correction_id)
    REFERENCES commissioner_corrections(league_id, id)
    ON DELETE RESTRICT,
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
  )
) STRICT;

CREATE INDEX free_agent_draft_allocation_events_league_allocation_time
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    occurred_at_ms
  );

CREATE INDEX free_agent_draft_allocation_events_league_fad_kind
  ON free_agent_draft_allocation_events (
    league_id,
    fad_id,
    event_kind
  );

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_offer_version
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version,
    snapshot_entry_id
  )
  WHERE event_kind = 'offer_considered';

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_state_version
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version,
    event_kind
  )
  WHERE event_kind <> 'offer_considered';

CREATE TABLE auction_contexts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (
      source_kind IN (
        'ordinary_weekly',
        'fad_open_rapid',
        'fad_restricted'
      )
    ),
  fad_id TEXT,
  fad_rollover_id TEXT,
  fad_allocation_id TEXT,
  fad_origin TEXT
    CHECK (
      fad_origin IS NULL
      OR fad_origin IN (
        'manager_nomination',
        'queued_nomination',
        'candidate_tie_restricted',
        'restricted_no_improvement_fallback'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, auction_id),
  UNIQUE (league_id, season_id, auction_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    fad_rollover_id
  ) REFERENCES free_agent_draft_rollovers(
    league_id,
    season_id,
    fad_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    fad_allocation_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id
  ) ON DELETE RESTRICT,
  CHECK (id = auction_id),
  CHECK (
    (
      source_kind = 'ordinary_weekly'
      AND fad_id IS NULL
      AND fad_rollover_id IS NULL
      AND fad_allocation_id IS NULL
      AND fad_origin IS NULL
    )
    OR (
      source_kind = 'fad_open_rapid'
      AND fad_id IS NOT NULL
      AND fad_rollover_id IS NOT NULL
      AND (
        (
          fad_origin IN (
            'manager_nomination',
            'queued_nomination'
          )
          AND fad_allocation_id IS NULL
        )
        OR (
          fad_origin = 'restricted_no_improvement_fallback'
          AND fad_allocation_id IS NOT NULL
        )
      )
    )
    OR (
      source_kind = 'fad_restricted'
      AND fad_id IS NOT NULL
      AND fad_rollover_id IS NOT NULL
      AND fad_allocation_id IS NOT NULL
      AND fad_origin = 'candidate_tie_restricted'
    )
  )
) STRICT;

CREATE INDEX auction_contexts_league_source_time
  ON auction_contexts (
    league_id,
    source_kind,
    created_at_ms,
    auction_id
  );

CREATE INDEX auction_contexts_league_fad
  ON auction_contexts (
    league_id,
    season_id,
    fad_id,
    source_kind,
    auction_id
  )
  WHERE fad_id IS NOT NULL;

CREATE INDEX auction_contexts_league_rollover
  ON auction_contexts (
    league_id,
    season_id,
    fad_rollover_id,
    auction_id
  )
  WHERE fad_rollover_id IS NOT NULL;

CREATE UNIQUE INDEX auction_contexts_one_restricted_allocation
  ON auction_contexts (
    league_id,
    season_id,
    fad_id,
    fad_allocation_id
  )
  WHERE source_kind = 'fad_restricted';

CREATE UNIQUE INDEX auction_contexts_one_fallback_allocation
  ON auction_contexts (
    league_id,
    season_id,
    fad_id,
    fad_allocation_id
  )
  WHERE fad_origin = 'restricted_no_improvement_fallback';

INSERT INTO auction_contexts (
  id,
  league_id,
  season_id,
  auction_id,
  source_kind,
  fad_id,
  fad_rollover_id,
  fad_allocation_id,
  fad_origin,
  created_at_ms
)
SELECT
  id,
  league_id,
  season_id,
  auction_id,
  'ordinary_weekly',
  NULL,
  NULL,
  NULL,
  NULL,
  created_at_ms
FROM migration_0030_ordinary_auction_contexts;

DROP TABLE migration_0030_ordinary_auction_contexts;

CREATE TABLE auction_administration_command_results (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  bid_id TEXT,
  idempotency_request_id TEXT NOT NULL,
  job_run_id TEXT,
  action TEXT NOT NULL
    CHECK (
      action IN (
        'edit_bid',
        'remove_bid',
        'cancel_auction',
        'request_resolution'
      )
    ),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  precondition_kind TEXT NOT NULL
    CHECK (precondition_kind IN ('bid', 'auction')),
  expected_resource_version INTEGER NOT NULL
    CHECK (expected_resource_version >= 1),
  resulting_resource_version INTEGER NOT NULL
    CHECK (resulting_resource_version >= 1),
  response_http_status INTEGER NOT NULL
    CHECK (response_http_status IN (200, 202)),
  response_json TEXT NOT NULL
    CHECK (
      json_valid(response_json) = 1
      AND json_type(response_json) = 'object'
      AND json(response_json) = response_json
    ),
  response_sha256 TEXT NOT NULL
    CHECK (
      length(response_sha256) = 64
      AND response_sha256 = lower(response_sha256)
      AND response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, idempotency_request_id),
  FOREIGN KEY (league_id, season_id, auction_id)
    REFERENCES auction_contexts(league_id, season_id, auction_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      action IN ('edit_bid', 'remove_bid')
      AND precondition_kind = 'bid'
    )
    OR (
      action IN ('cancel_auction', 'request_resolution')
      AND precondition_kind = 'auction'
    )
  ),
  CHECK (
    (
      action IN ('edit_bid', 'remove_bid')
      AND bid_id IS NOT NULL
      AND job_run_id IS NULL
    )
    OR (
      action = 'cancel_auction'
      AND bid_id IS NULL
      AND job_run_id IS NULL
    )
    OR (
      action = 'request_resolution'
      AND bid_id IS NULL
      AND job_run_id IS NOT NULL
    )
  ),
  CHECK (
    (
      action IN (
        'edit_bid',
        'remove_bid',
        'cancel_auction'
      )
      AND response_http_status = 200
    )
    OR (
      action = 'request_resolution'
      AND response_http_status = 202
    )
  ),
  CHECK (
    (
      action IN ('edit_bid', 'remove_bid')
      AND resulting_resource_version =
        expected_resource_version + 1
    )
    OR (
      action = 'cancel_auction'
      AND resulting_resource_version >
        expected_resource_version
    )
    OR (
      action = 'request_resolution'
      AND resulting_resource_version =
        expected_resource_version
    )
  )
) STRICT;

CREATE INDEX auction_administration_command_results_auction_time
  ON auction_administration_command_results (
    league_id,
    season_id,
    auction_id,
    created_at_ms
  );

CREATE TABLE free_agent_draft_nomination_queue (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_rollover_id TEXT NOT NULL,
  target_opening_rollover_id TEXT NOT NULL,
  resolution_rollover_id TEXT,
  opening_total_value_cents INTEGER NOT NULL
    CHECK (opening_total_value_cents > 0),
  opening_term_years INTEGER NOT NULL
    CHECK (opening_term_years BETWEEN 1 AND 3),
  opening_aav_cents INTEGER NOT NULL
    CHECK (opening_aav_cents >= 100),
  binding_illegality_confirmed INTEGER NOT NULL
    CHECK (binding_illegality_confirmed = 1),
  binding_confirmed_at_ms INTEGER NOT NULL
    CHECK (binding_confirmed_at_ms >= 0),
  submitted_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  submitted_by_membership_id TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
  candidate_card_version_observed INTEGER NOT NULL
    CHECK (candidate_card_version_observed >= 1),
  team_version_observed INTEGER NOT NULL CHECK (team_version_observed >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued', 'opened', 'invalid')),
  opened_auction_id TEXT,
  opened_starter_bid_id TEXT,
  opened_at_ms INTEGER
    CHECK (opened_at_ms IS NULL OR opened_at_ms >= accepted_at_ms),
  terminal_at_ms INTEGER
    CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= accepted_at_ms),
  validation_code TEXT
    CHECK (
      validation_code IS NULL
      OR (
        validation_code = trim(validation_code)
        AND length(validation_code) BETWEEN 1 AND 100
        AND validation_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = accepted_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, opened_auction_id),
  UNIQUE (league_id, opened_starter_bid_id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, target_opening_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, resolution_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, submitted_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, opened_auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, opened_starter_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  CHECK (
    opening_aav_cents =
      (opening_total_value_cents / opening_term_years)
      + CASE
          WHEN
            (opening_total_value_cents % opening_term_years) * 2
              >= opening_term_years
          THEN 1
          ELSE 0
        END
  ),
  CHECK (
    opening_term_years = 1
    OR opening_total_value_cents % 100 = 0
  ),
  CHECK (
    binding_confirmed_at_ms = accepted_at_ms
    AND source_rollover_id = target_opening_rollover_id
  ),
  CHECK (
    (
      status = 'queued'
      AND resolution_rollover_id IS NULL
      AND opened_auction_id IS NULL
      AND opened_starter_bid_id IS NULL
      AND opened_at_ms IS NULL
      AND terminal_at_ms IS NULL
      AND validation_code IS NULL
    )
    OR (
      status = 'opened'
      AND resolution_rollover_id IS NOT NULL
      AND target_opening_rollover_id <> resolution_rollover_id
      AND opened_auction_id IS NOT NULL
      AND opened_starter_bid_id IS NOT NULL
      AND opened_at_ms IS NOT NULL
      AND terminal_at_ms IS NOT NULL
      AND validation_code IS NULL
    )
    OR (
      status = 'invalid'
      AND resolution_rollover_id IS NULL
      AND opened_auction_id IS NULL
      AND opened_starter_bid_id IS NULL
      AND opened_at_ms IS NULL
      AND terminal_at_ms IS NOT NULL
      AND validation_code IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX free_agent_draft_nomination_queue_one_queued_player
  ON free_agent_draft_nomination_queue (
    league_id,
    season_id,
    player_id
  )
  WHERE status = 'queued';

CREATE INDEX free_agent_draft_nomination_queue_opening_boundary
  ON free_agent_draft_nomination_queue (
    league_id,
    target_opening_rollover_id,
    status
  );

CREATE TABLE free_agent_draft_auction_participants (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  source_snapshot_entry_id TEXT NOT NULL,
  originating_candidate_revision_id TEXT NOT NULL,
  minimum_total_value_cents INTEGER NOT NULL
    CHECK (minimum_total_value_cents > 0),
  minimum_term_years INTEGER NOT NULL
    CHECK (minimum_term_years BETWEEN 1 AND 3),
  minimum_aav_cents INTEGER NOT NULL CHECK (minimum_aav_cents >= 100),
  active_improvement_bid_id TEXT,
  manager_edit_limit INTEGER NOT NULL CHECK (manager_edit_limit = 1),
  cooldown_duration_ms INTEGER NOT NULL
    CHECK (cooldown_duration_ms = 4500000),
  first_improvement_at_ms INTEGER
    CHECK (first_improvement_at_ms IS NULL OR first_improvement_at_ms >= 0),
  current_cooldown_anchor_at_ms INTEGER
    CHECK (
      current_cooldown_anchor_at_ms IS NULL
      OR current_cooldown_anchor_at_ms >= 0
    ),
  improvement_committed_at_ms INTEGER
    CHECK (
      improvement_committed_at_ms IS NULL
      OR improvement_committed_at_ms >= 0
    ),
  originating_actor_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  originating_actor_membership_id TEXT NOT NULL,
  originating_actor_authority TEXT NOT NULL
    CHECK (
      originating_actor_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  removed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  removed_by_membership_id TEXT,
  removed_authority TEXT
    CHECK (
      removed_authority IS NULL
      OR removed_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  removal_reason TEXT
    CHECK (
      removal_reason IS NULL
      OR (
        removal_reason = trim(removal_reason)
        AND length(removal_reason) BETWEEN 1 AND 500
      )
    ),
  removed_at_ms INTEGER
    CHECK (removed_at_ms IS NULL OR removed_at_ms >= created_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, source_snapshot_entry_id),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    team_id
  ),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    auction_id,
    team_id
  ),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id, auction_id)
    REFERENCES auction_contexts(league_id, season_id, auction_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_snapshot_entry_id)
    REFERENCES candidate_card_snapshot_entries(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, originating_candidate_revision_id)
    REFERENCES candidate_card_revisions(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, active_improvement_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, originating_actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, removed_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    minimum_aav_cents =
      (minimum_total_value_cents / minimum_term_years)
      + CASE
          WHEN
            (minimum_total_value_cents % minimum_term_years) * 2
              >= minimum_term_years
          THEN 1
          ELSE 0
        END
  ),
  CHECK (
    minimum_term_years = 1
    OR minimum_total_value_cents % 100 = 0
  ),
  CHECK (
    (
      status = 'active'
      AND active_improvement_bid_id IS NULL
      AND first_improvement_at_ms IS NULL
      AND current_cooldown_anchor_at_ms IS NULL
      AND improvement_committed_at_ms IS NULL
    )
    OR (
      status = 'active'
      AND active_improvement_bid_id IS NOT NULL
      AND first_improvement_at_ms IS NOT NULL
      AND current_cooldown_anchor_at_ms IS NOT NULL
      AND improvement_committed_at_ms IS NOT NULL
      AND first_improvement_at_ms <= improvement_committed_at_ms
      AND current_cooldown_anchor_at_ms <= improvement_committed_at_ms
    )
    OR (
      status = 'removed'
      AND active_improvement_bid_id IS NULL
      AND (
        (
          first_improvement_at_ms IS NULL
          AND current_cooldown_anchor_at_ms IS NULL
          AND improvement_committed_at_ms IS NULL
        )
        OR (
          first_improvement_at_ms IS NOT NULL
          AND current_cooldown_anchor_at_ms IS NOT NULL
          AND improvement_committed_at_ms IS NOT NULL
          AND first_improvement_at_ms <=
            improvement_committed_at_ms
          AND current_cooldown_anchor_at_ms <=
            improvement_committed_at_ms
        )
      )
    )
  ),
  CHECK (
    (
      status = 'active'
      AND removed_by_user_id IS NULL
      AND removed_by_membership_id IS NULL
      AND removed_authority IS NULL
      AND removal_reason IS NULL
      AND removed_at_ms IS NULL
    )
    OR (
      status = 'removed'
      AND active_improvement_bid_id IS NULL
      AND removed_by_user_id IS NOT NULL
      AND removed_by_membership_id IS NOT NULL
      AND removed_authority IS NOT NULL
      AND removed_at_ms IS NOT NULL
      AND updated_at_ms = removed_at_ms
    )
  )
) STRICT;

CREATE UNIQUE INDEX free_agent_draft_participants_one_active_bid
  ON free_agent_draft_auction_participants (
    league_id,
    active_improvement_bid_id
  )
  WHERE active_improvement_bid_id IS NOT NULL;

CREATE INDEX free_agent_draft_participants_auction_status
  ON free_agent_draft_auction_participants (
    league_id,
    auction_id,
    status
  );

CREATE TABLE free_agent_draft_draws (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  allocation_id TEXT,
  auction_id TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version = 1),
  nonce_bytes BLOB NOT NULL
    CHECK (typeof(nonce_bytes) = 'blob' AND length(nonce_bytes) = 32),
  commitment_hex TEXT NOT NULL
    CHECK (
      length(commitment_hex) = 64
      AND commitment_hex = lower(commitment_hex)
      AND commitment_hex NOT GLOB '*[^0-9a-f]*'
    ),
  ordered_tied_bid_ids_json TEXT
    CHECK (
      ordered_tied_bid_ids_json IS NULL
      OR (
        json_valid(ordered_tied_bid_ids_json) = 1
        AND json_type(ordered_tied_bid_ids_json) = 'array'
      )
    ),
  ordered_tied_team_ids_json TEXT
    CHECK (
      ordered_tied_team_ids_json IS NULL
      OR (
        json_valid(ordered_tied_team_ids_json) = 1
        AND json_type(ordered_tied_team_ids_json) = 'array'
      )
    ),
  rejection_counter INTEGER
    CHECK (
      rejection_counter IS NULL
      OR rejection_counter BETWEEN 0 AND 4294967295
    ),
  selected_index INTEGER
    CHECK (selected_index IS NULL OR selected_index >= 0),
  selected_bid_id TEXT,
  selected_team_id TEXT,
  selected_digest_hex TEXT
    CHECK (
      selected_digest_hex IS NULL
      OR (
        length(selected_digest_hex) = 64
        AND selected_digest_hex = lower(selected_digest_hex)
        AND selected_digest_hex NOT GLOB '*[^0-9a-f]*'
      )
    ),
  revealed_at_ms INTEGER
    CHECK (
      revealed_at_ms IS NULL
      OR revealed_at_ms >= created_at_ms
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version IN (1, 2)),
  UNIQUE (league_id, id),
  UNIQUE (league_id, auction_id),
  UNIQUE (league_id, commitment_hex),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id, auction_id)
    REFERENCES auction_contexts(league_id, season_id, auction_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, selected_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, selected_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      revealed_at_ms IS NULL
      AND version = 1
      AND ordered_tied_bid_ids_json IS NULL
      AND ordered_tied_team_ids_json IS NULL
      AND rejection_counter IS NULL
      AND selected_index IS NULL
      AND selected_bid_id IS NULL
      AND selected_team_id IS NULL
      AND selected_digest_hex IS NULL
    )
    OR (
      revealed_at_ms IS NOT NULL
      AND version = 2
      AND updated_at_ms = revealed_at_ms
      AND ordered_tied_bid_ids_json IS NOT NULL
      AND ordered_tied_team_ids_json IS NOT NULL
      AND json_array_length(ordered_tied_bid_ids_json) =
        json_array_length(ordered_tied_team_ids_json)
      AND (
        (
          ordered_tied_bid_ids_json = '[]'
          AND ordered_tied_team_ids_json = '[]'
          AND rejection_counter IS NULL
          AND selected_index IS NULL
          AND selected_bid_id IS NULL
          AND selected_team_id IS NULL
          AND selected_digest_hex IS NULL
        )
        OR (
          json_array_length(ordered_tied_bid_ids_json) >= 2
          AND rejection_counter IS NOT NULL
          AND selected_index IS NOT NULL
          AND selected_index <
            json_array_length(ordered_tied_bid_ids_json)
          AND selected_bid_id IS NOT NULL
          AND selected_team_id IS NOT NULL
          AND selected_digest_hex IS NOT NULL
        )
      )
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_draws_league_fad_reveal
  ON free_agent_draft_draws (
    league_id,
    fad_id,
    revealed_at_ms,
    auction_id
  );

CREATE TABLE free_agent_draft_recoveries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  allocation_id TEXT,
  rollover_id TEXT,
  auction_id TEXT,
  job_run_id TEXT,
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'deadline_retry',
        'allocation_retry',
        'restricted_activation',
        'queued_nomination_activation',
        'fallback_activation',
        'auction_resolution',
        'rollover_finalize',
        'completion'
      )
    ),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending',
        'ready',
        'running',
        'resolved',
        'correction_required'
      )
    ),
  earliest_activation_at_ms INTEGER
    CHECK (
      earliest_activation_at_ms IS NULL
      OR earliest_activation_at_ms >= 0
    ),
  target_resolution_at_ms INTEGER
    CHECK (
      target_resolution_at_ms IS NULL
      OR target_resolution_at_ms >= 0
    ),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        last_error_code = trim(last_error_code)
        AND length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  commissioner_reason TEXT
    CHECK (
      commissioner_reason IS NULL
      OR (
        commissioner_reason = trim(commissioner_reason)
        AND length(commissioner_reason) BETWEEN 1 AND 500
      )
    ),
  created_by_operation_id TEXT,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  resolved_by_membership_id TEXT,
  resolved_authority TEXT
    CHECK (
      resolved_authority IS NULL
      OR resolved_authority IN (
        'system',
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  resolved_at_ms INTEGER
    CHECK (
      resolved_at_ms IS NULL
      OR resolved_at_ms >= created_at_ms
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    player_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id,
    player_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, resolved_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      status = 'resolved'
      AND resolved_at_ms IS NOT NULL
      AND resolved_authority IS NOT NULL
    )
    OR (
      status <> 'resolved'
      AND resolved_at_ms IS NULL
      AND resolved_by_user_id IS NULL
      AND resolved_by_membership_id IS NULL
      AND resolved_authority IS NULL
    )
  ),
  CHECK (
    kind NOT IN (
      'allocation_retry',
      'restricted_activation',
      'queued_nomination_activation',
      'fallback_activation',
      'auction_resolution'
    )
    OR player_id IS NOT NULL
  ),
  CHECK (
    kind <> 'auction_resolution'
    OR (auction_id IS NOT NULL AND job_run_id IS NOT NULL)
  ),
  CHECK (
    kind <> 'rollover_finalize'
    OR (rollover_id IS NOT NULL AND job_run_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX free_agent_draft_recoveries_league_fad_status
  ON free_agent_draft_recoveries (
    league_id,
    fad_id,
    status
  );

CREATE INDEX free_agent_draft_recoveries_league_auction
  ON free_agent_draft_recoveries (
    league_id,
    auction_id,
    status
  )
  WHERE auction_id IS NOT NULL;

-- Authoritative NHL observations and whole-game late-lock exclusions are
-- immutable, sealed scoring evidence. Observation children are staged before
-- their snapshot root; exclusion children are staged before their set root.

CREATE TABLE stat_refresh_player_game_sets (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  stat_source_id TEXT NOT NULL
    REFERENCES stat_sources(id) ON DELETE RESTRICT,
  refresh_id TEXT NOT NULL UNIQUE
    REFERENCES stat_refreshes(id) ON DELETE RESTRICT,
  nhl_season_key TEXT NOT NULL
    CHECK (
      nhl_season_key = trim(nhl_season_key)
      AND length(nhl_season_key) BETWEEN 1 AND 100
    ),
  provider TEXT NOT NULL
    CHECK (
      provider = trim(provider)
      AND length(provider) BETWEEN 1 AND 100
    ),
  source_version TEXT NOT NULL
    CHECK (
      source_version = trim(source_version)
      AND length(source_version) BETWEEN 1 AND 200
    ),
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  required_player_count INTEGER NOT NULL
    CHECK (required_player_count >= 0),
  coverage_entry_count INTEGER NOT NULL
    CHECK (coverage_entry_count >= required_player_count),
  expected_player_game_count INTEGER NOT NULL
    CHECK (
      expected_player_game_count >= 0
      AND expected_player_game_count <= coverage_entry_count
    ),
  coverage_schema_version INTEGER NOT NULL
    CHECK (coverage_schema_version = 1),
  coverage_sha256 TEXT NOT NULL
    CHECK (
      length(coverage_sha256) = 64
      AND coverage_sha256 = lower(coverage_sha256)
      AND coverage_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  observation_count INTEGER NOT NULL CHECK (observation_count >= 0),
  evidence_schema_version INTEGER NOT NULL
    CHECK (evidence_schema_version = 1),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      length(evidence_sha256) = 64
      AND evidence_sha256 = lower(evidence_sha256)
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = captured_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (stat_source_id, refresh_id, id)
) STRICT;

CREATE TABLE stat_refresh_player_game_coverage_entries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  stat_source_id TEXT NOT NULL
    REFERENCES stat_sources(id) ON DELETE RESTRICT,
  refresh_id TEXT NOT NULL
    REFERENCES stat_refreshes(id) ON DELETE RESTRICT,
  observation_set_id TEXT NOT NULL,
  nhl_season_key TEXT NOT NULL
    CHECK (
      nhl_season_key = trim(nhl_season_key)
      AND length(nhl_season_key) BETWEEN 1 AND 100
    ),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  provider_player_id TEXT NOT NULL
    CHECK (
      provider_player_id = trim(provider_player_id)
      AND length(provider_player_id) BETWEEN 1 AND 100
    ),
  provider_team_id TEXT
    CHECK (
      provider_team_id IS NULL
      OR (
        provider_team_id = trim(provider_team_id)
        AND length(provider_team_id) BETWEEN 1 AND 100
      )
    ),
  disposition TEXT NOT NULL
    CHECK (
      disposition IN ('expected_game', 'no_due_game', 'no_team')
    ),
  nhl_game_id TEXT
    CHECK (
      nhl_game_id IS NULL
      OR (
        nhl_game_id = trim(nhl_game_id)
        AND length(nhl_game_id) BETWEEN 1 AND 200
      )
    ),
  nhl_game_scheduled_starts_at_ms INTEGER
    CHECK (
      nhl_game_scheduled_starts_at_ms IS NULL
      OR nhl_game_scheduled_starts_at_ms >= 0
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  CHECK (
    (
      disposition = 'expected_game'
      AND provider_team_id IS NOT NULL
      AND nhl_game_id IS NOT NULL
      AND nhl_game_scheduled_starts_at_ms IS NOT NULL
    )
    OR (
      disposition = 'no_due_game'
      AND provider_team_id IS NOT NULL
      AND nhl_game_id IS NULL
      AND nhl_game_scheduled_starts_at_ms IS NULL
    )
    OR (
      disposition = 'no_team'
      AND provider_team_id IS NULL
      AND nhl_game_id IS NULL
      AND nhl_game_scheduled_starts_at_ms IS NULL
    )
  ),
  UNIQUE (
    stat_source_id,
    refresh_id,
    observation_set_id,
    id
  ),
  FOREIGN KEY (
    stat_source_id,
    refresh_id,
    observation_set_id
  ) REFERENCES stat_refresh_player_game_sets(
    stat_source_id,
    refresh_id,
    id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE player_game_stat_observations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  stat_source_id TEXT NOT NULL
    REFERENCES stat_sources(id) ON DELETE RESTRICT,
  refresh_id TEXT NOT NULL
    REFERENCES stat_refreshes(id) ON DELETE RESTRICT,
  observation_set_id TEXT NOT NULL,
  nhl_season_key TEXT NOT NULL
    CHECK (
      nhl_season_key = trim(nhl_season_key)
      AND length(nhl_season_key) BETWEEN 1 AND 100
    ),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  nhl_game_id TEXT NOT NULL
    CHECK (
      nhl_game_id = trim(nhl_game_id)
      AND length(nhl_game_id) BETWEEN 1 AND 200
    ),
  nhl_game_scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (nhl_game_scheduled_starts_at_ms >= 0),
  observed_game_state TEXT NOT NULL
    CHECK (
      observed_game_state IN (
        'scheduled',
        'pre_game',
        'in_progress',
        'intermission',
        'final',
        'postponed',
        'cancelled'
      )
    ),
  goals INTEGER NOT NULL CHECK (goals >= 0),
  assists INTEGER NOT NULL CHECK (assists >= 0),
  nhl_points INTEGER NOT NULL
    CHECK (nhl_points >= 0 AND nhl_points = goals + assists),
  fantasy_points_hundredths INTEGER NOT NULL
    CHECK (
      fantasy_points_hundredths >= 0
      AND fantasy_points_hundredths = goals * 125 + assists * 100
    ),
  source_updated_at_ms INTEGER NOT NULL
    CHECK (source_updated_at_ms >= 0),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= source_updated_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (
    stat_source_id,
    refresh_id,
    player_id,
    nhl_game_id
  ),
  UNIQUE (
    stat_source_id,
    refresh_id,
    observation_set_id,
    player_id,
    nhl_game_id
  ),
  FOREIGN KEY (
    stat_source_id,
    refresh_id,
    observation_set_id
  ) REFERENCES stat_refresh_player_game_sets(
    stat_source_id,
    refresh_id,
    id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE nhl_game_state_observation_snapshots (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  provider TEXT NOT NULL
    CHECK (
      provider = trim(provider)
      AND length(provider) BETWEEN 1 AND 100
    ),
  source_version TEXT NOT NULL
    CHECK (
      source_version = trim(source_version)
      AND length(source_version) BETWEEN 1 AND 200
    ),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  freshness_status TEXT NOT NULL CHECK (freshness_status = 'fresh'),
  observation_count INTEGER NOT NULL CHECK (observation_count >= 0),
  evidence_schema_version INTEGER NOT NULL
    CHECK (evidence_schema_version = 1),
  observation_sha256 TEXT NOT NULL
    CHECK (
      length(observation_sha256) = 64
      AND observation_sha256 = lower(observation_sha256)
      AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = observed_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, id),
  UNIQUE (
    league_id,
    season_id,
    matchup_week_id,
    team_id,
    provider,
    source_version,
    observed_at_ms
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE nhl_game_state_observations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  observation_snapshot_id TEXT NOT NULL,
  nhl_game_id TEXT NOT NULL
    CHECK (
      nhl_game_id = trim(nhl_game_id)
      AND length(nhl_game_id) BETWEEN 1 AND 200
    ),
  nhl_game_scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (nhl_game_scheduled_starts_at_ms >= 0),
  observed_game_state TEXT NOT NULL
    CHECK (
      observed_game_state IN (
        'scheduled',
        'pre_game',
        'in_progress',
        'intermission',
        'final',
        'postponed',
        'cancelled'
      )
    ),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = observed_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (
    league_id,
    observation_snapshot_id,
    nhl_game_id
  ),
  UNIQUE (
    league_id,
    observation_snapshot_id,
    id,
    nhl_game_id,
    nhl_game_scheduled_starts_at_ms,
    observed_game_state
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    observation_snapshot_id
  ) REFERENCES nhl_game_state_observation_snapshots(
    league_id,
    season_id,
    id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE matchup_roster_game_exclusion_sets (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  matchup_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  matchup_roster_lock_id TEXT NOT NULL,
  matchup_roster_lock_version INTEGER NOT NULL
    CHECK (matchup_roster_lock_version >= 1),
  baseline_snapshot_id TEXT NOT NULL,
  observation_snapshot_id TEXT NOT NULL,
  late_snapshot_at_ms INTEGER NOT NULL CHECK (late_snapshot_at_ms >= 0),
  exclusion_count INTEGER NOT NULL CHECK (exclusion_count >= 0),
  evidence_schema_version INTEGER NOT NULL
    CHECK (evidence_schema_version = 1),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      length(evidence_sha256) = 64
      AND evidence_sha256 = lower(evidence_sha256)
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  sealed_at_ms INTEGER NOT NULL CHECK (sealed_at_ms = late_snapshot_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = late_snapshot_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, matchup_roster_lock_id),
  UNIQUE (league_id, observation_snapshot_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_id)
    REFERENCES matchups(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_roster_lock_id)
    REFERENCES matchup_roster_locks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, baseline_snapshot_id)
    REFERENCES stat_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    observation_snapshot_id
  ) REFERENCES nhl_game_state_observation_snapshots(
    league_id,
    season_id,
    id
  ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE matchup_roster_game_exclusions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  exclusion_set_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  matchup_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  matchup_roster_lock_id TEXT NOT NULL,
  matchup_roster_player_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  observation_snapshot_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  baseline_player_game_stat_observation_id TEXT NOT NULL
    REFERENCES player_game_stat_observations(id) ON DELETE RESTRICT,
  nhl_game_id TEXT NOT NULL
    CHECK (
      nhl_game_id = trim(nhl_game_id)
      AND length(nhl_game_id) BETWEEN 1 AND 200
    ),
  nhl_game_scheduled_starts_at_ms INTEGER NOT NULL
    CHECK (nhl_game_scheduled_starts_at_ms >= 0),
  observed_game_state TEXT NOT NULL
    CHECK (
      observed_game_state IN ('in_progress', 'intermission', 'final')
    ),
  late_snapshot_at_ms INTEGER NOT NULL CHECK (late_snapshot_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = late_snapshot_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (
    league_id,
    exclusion_set_id,
    player_id,
    nhl_game_id
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, exclusion_set_id)
    REFERENCES matchup_roster_game_exclusion_sets(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_id)
    REFERENCES matchups(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_roster_lock_id)
    REFERENCES matchup_roster_locks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_roster_player_id)
    REFERENCES matchup_roster_players(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    observation_snapshot_id,
    observation_id,
    nhl_game_id,
    nhl_game_scheduled_starts_at_ms,
    observed_game_state
  ) REFERENCES nhl_game_state_observations(
    league_id,
    observation_snapshot_id,
    id,
    nhl_game_id,
    nhl_game_scheduled_starts_at_ms,
    observed_game_state
  ) ON DELETE RESTRICT,
  CHECK (nhl_game_scheduled_starts_at_ms <= late_snapshot_at_ms)
) STRICT;

CREATE INDEX nhl_game_state_observations_game
  ON nhl_game_state_observations (
    league_id,
    nhl_game_id,
    observed_at_ms
  );

CREATE INDEX seasons_player_game_coverage_nhl
  ON seasons (nhl_season_key, league_id, id);

CREATE INDEX matchup_weeks_player_game_coverage_live
  ON matchup_weeks (league_id, season_id)
  WHERE status IN ('live', 'awaiting_data');

CREATE INDEX player_ownerships_player_game_coverage_active
  ON player_ownerships (league_id, season_id, player_id)
  WHERE ownership_kind = 'Rostered'
    AND roster_category = 'Active';

CREATE INDEX matchup_roster_players_player_game_coverage_season
  ON matchup_roster_players (
    league_id,
    season_id,
    player_id,
    matchup_roster_lock_id
  );

CREATE INDEX matchup_roster_game_exclusions_player_game_coverage_season
  ON matchup_roster_game_exclusions (
    league_id,
    season_id,
    player_id,
    exclusion_set_id
  );

CREATE INDEX stat_refresh_player_game_coverage_refresh
  ON stat_refresh_player_game_coverage_entries (
    stat_source_id,
    refresh_id,
    player_id,
    disposition,
    nhl_game_id
  );

CREATE UNIQUE INDEX stat_refresh_player_game_coverage_expected_identity
  ON stat_refresh_player_game_coverage_entries (
    stat_source_id,
    refresh_id,
    player_id,
    nhl_game_id
  )
  WHERE disposition = 'expected_game';

CREATE UNIQUE INDEX stat_refresh_player_game_coverage_terminal_player
  ON stat_refresh_player_game_coverage_entries (
    stat_source_id,
    refresh_id,
    player_id
  )
  WHERE disposition IN ('no_due_game', 'no_team');

CREATE INDEX player_game_stat_observations_refresh
  ON player_game_stat_observations (
    stat_source_id,
    refresh_id,
    player_id,
    nhl_game_id
  );

CREATE INDEX player_game_stat_observations_player_game
  ON player_game_stat_observations (
    player_id,
    nhl_game_id,
    created_at_ms
  );

CREATE INDEX matchup_roster_game_exclusions_scoring_lookup
  ON matchup_roster_game_exclusions (
    league_id,
    matchup_week_id,
    player_id,
    nhl_game_id
  );

CREATE TRIGGER stat_refresh_player_game_coverage_stage_before_set
BEFORE INSERT ON stat_refresh_player_game_coverage_entries
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM stat_refresh_player_game_sets
    WHERE stat_refresh_player_game_sets.id =
        NEW.observation_set_id
  ) THEN RAISE(
    ABORT,
    'player-game coverage must be staged before its immutable set'
  ) END;
END;

CREATE TRIGGER player_game_stat_observations_stage_before_set
BEFORE INSERT ON player_game_stat_observations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM stat_refresh_player_game_sets
    WHERE stat_refresh_player_game_sets.id =
        NEW.observation_set_id
  ) THEN RAISE(
    ABORT,
    'player-game observations must be staged before their immutable set'
  ) END;
END;

CREATE TRIGGER stat_refresh_player_game_sets_valid_insert
BEFORE INSERT ON stat_refresh_player_game_sets
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.created_at_ms = NEW.captured_at_ms
    AND EXISTS (
      SELECT 1
      FROM stat_sources
      WHERE stat_sources.id = NEW.stat_source_id
        AND stat_sources.provider = NEW.provider
        AND stat_sources.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM stat_refreshes
      WHERE stat_refreshes.id = NEW.refresh_id
        AND stat_refreshes.stat_source_id =
          NEW.stat_source_id
        AND stat_refreshes.nhl_season_key =
          NEW.nhl_season_key
        AND stat_refreshes.source_version =
          NEW.source_version
        AND stat_refreshes.status = 'succeeded'
        AND stat_refreshes.completed_at_ms =
          NEW.captured_at_ms
        AND stat_refreshes.player_count IS NOT NULL
        AND stat_refreshes.error_code IS NULL
    )
    AND (
      SELECT COUNT(*)
      FROM stat_refresh_player_game_coverage_entries
      WHERE stat_refresh_player_game_coverage_entries.stat_source_id =
          NEW.stat_source_id
        AND stat_refresh_player_game_coverage_entries.refresh_id =
          NEW.refresh_id
        AND stat_refresh_player_game_coverage_entries.observation_set_id =
          NEW.id
        AND stat_refresh_player_game_coverage_entries.nhl_season_key =
          NEW.nhl_season_key
        AND stat_refresh_player_game_coverage_entries.created_at_ms =
          NEW.captured_at_ms
    ) = NEW.coverage_entry_count
    AND (
      SELECT COUNT(DISTINCT player_id)
      FROM stat_refresh_player_game_coverage_entries
      WHERE stat_refresh_player_game_coverage_entries.stat_source_id =
          NEW.stat_source_id
        AND stat_refresh_player_game_coverage_entries.refresh_id =
          NEW.refresh_id
        AND stat_refresh_player_game_coverage_entries.observation_set_id =
          NEW.id
    ) = NEW.required_player_count
    AND (
      SELECT COUNT(*)
      FROM stat_refresh_player_game_coverage_entries
      WHERE stat_refresh_player_game_coverage_entries.stat_source_id =
          NEW.stat_source_id
        AND stat_refresh_player_game_coverage_entries.refresh_id =
          NEW.refresh_id
        AND stat_refresh_player_game_coverage_entries.observation_set_id =
          NEW.id
        AND stat_refresh_player_game_coverage_entries.disposition =
          'expected_game'
    ) = NEW.expected_player_game_count
    AND NEW.observation_count = NEW.expected_player_game_count
    AND NOT EXISTS (
      SELECT 1
      FROM stat_refresh_player_game_coverage_entries AS coverage
      WHERE coverage.observation_set_id = NEW.id
        AND (
          coverage.stat_source_id <> NEW.stat_source_id
          OR coverage.refresh_id <> NEW.refresh_id
          OR coverage.nhl_season_key <> NEW.nhl_season_key
          OR coverage.created_at_ms <> NEW.captured_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM stat_refresh_player_game_coverage_entries AS left_coverage
      JOIN stat_refresh_player_game_coverage_entries AS right_coverage
        ON right_coverage.observation_set_id =
            left_coverage.observation_set_id
       AND right_coverage.player_id = left_coverage.player_id
       AND right_coverage.id <> left_coverage.id
      WHERE left_coverage.observation_set_id = NEW.id
        AND (
          left_coverage.provider_player_id <>
            right_coverage.provider_player_id
          OR (
            left_coverage.disposition = 'expected_game'
            AND right_coverage.disposition IN ('no_due_game', 'no_team')
          )
          OR (
            right_coverage.disposition = 'expected_game'
            AND left_coverage.disposition IN ('no_due_game', 'no_team')
          )
        )
    )
    AND (
      SELECT COUNT(*)
      FROM player_game_stat_observations
      WHERE player_game_stat_observations.stat_source_id =
          NEW.stat_source_id
        AND player_game_stat_observations.refresh_id =
          NEW.refresh_id
        AND player_game_stat_observations.observation_set_id =
          NEW.id
        AND player_game_stat_observations.nhl_season_key =
          NEW.nhl_season_key
        AND player_game_stat_observations.created_at_ms =
          NEW.captured_at_ms
    ) = NEW.observation_count
    AND NOT EXISTS (
      SELECT 1
      FROM player_game_stat_observations
      WHERE player_game_stat_observations.observation_set_id =
          NEW.id
        AND (
          player_game_stat_observations.stat_source_id <>
            NEW.stat_source_id
          OR player_game_stat_observations.refresh_id <>
            NEW.refresh_id
          OR player_game_stat_observations.nhl_season_key <>
            NEW.nhl_season_key
          OR player_game_stat_observations.created_at_ms <>
            NEW.captured_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM stat_refresh_player_game_coverage_entries AS coverage
      WHERE coverage.observation_set_id = NEW.id
        AND coverage.disposition = 'expected_game'
        AND NOT EXISTS (
          SELECT 1
          FROM player_game_stat_observations AS observation
          WHERE observation.observation_set_id = NEW.id
            AND observation.player_id = coverage.player_id
            AND observation.nhl_game_id = coverage.nhl_game_id
            AND observation.nhl_game_scheduled_starts_at_ms =
              coverage.nhl_game_scheduled_starts_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM player_game_stat_observations AS observation
      WHERE observation.observation_set_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM stat_refresh_player_game_coverage_entries AS coverage
          WHERE coverage.observation_set_id = NEW.id
            AND coverage.disposition = 'expected_game'
            AND coverage.player_id = observation.player_id
            AND coverage.nhl_game_id = observation.nhl_game_id
            AND coverage.nhl_game_scheduled_starts_at_ms =
              observation.nhl_game_scheduled_starts_at_ms
        )
    )
  ) THEN RAISE(
    ABORT,
    'player-game observation set must seal one exact successful refresh'
  ) END;
END;

CREATE TRIGGER nhl_game_state_observations_stage_before_snapshot
BEFORE INSERT ON nhl_game_state_observations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM nhl_game_state_observation_snapshots
    WHERE nhl_game_state_observation_snapshots.league_id =
        NEW.league_id
      AND nhl_game_state_observation_snapshots.id =
        NEW.observation_snapshot_id
  ) THEN RAISE(
    ABORT,
    'NHL game observations must be staged before their immutable snapshot'
  ) END;
END;

CREATE TRIGGER nhl_game_state_observation_snapshots_valid_insert
BEFORE INSERT ON nhl_game_state_observation_snapshots
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.created_at_ms = NEW.observed_at_ms
    AND NEW.freshness_status = 'fresh'
    AND (
      SELECT COUNT(*)
      FROM nhl_game_state_observations
      WHERE nhl_game_state_observations.league_id =
          NEW.league_id
        AND nhl_game_state_observations.season_id =
          NEW.season_id
        AND nhl_game_state_observations.observation_snapshot_id =
          NEW.id
        AND nhl_game_state_observations.observed_at_ms =
          NEW.observed_at_ms
        AND nhl_game_state_observations.created_at_ms =
          NEW.observed_at_ms
    ) = NEW.observation_count
    AND NOT EXISTS (
      SELECT 1
      FROM nhl_game_state_observations
      WHERE nhl_game_state_observations.league_id =
          NEW.league_id
        AND nhl_game_state_observations.observation_snapshot_id =
          NEW.id
        AND (
          nhl_game_state_observations.season_id <>
            NEW.season_id
          OR nhl_game_state_observations.observed_at_ms <>
            NEW.observed_at_ms
          OR nhl_game_state_observations.created_at_ms <>
            NEW.observed_at_ms
        )
    )
  ) THEN RAISE(
    ABORT,
    'NHL game observation snapshot must seal its exact fresh child set'
  ) END;
END;

CREATE TRIGGER matchup_roster_game_exclusions_stage_before_set
BEFORE INSERT ON matchup_roster_game_exclusions
BEGIN
  SELECT CASE WHEN (
    EXISTS (
      SELECT 1
      FROM matchup_roster_game_exclusion_sets
      WHERE matchup_roster_game_exclusion_sets.league_id =
          NEW.league_id
        AND matchup_roster_game_exclusion_sets.id =
          NEW.exclusion_set_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM nhl_game_state_observation_snapshots
      JOIN nhl_game_state_observations
        ON nhl_game_state_observations.league_id =
            nhl_game_state_observation_snapshots.league_id
       AND nhl_game_state_observations.season_id =
            nhl_game_state_observation_snapshots.season_id
       AND nhl_game_state_observations.observation_snapshot_id =
            nhl_game_state_observation_snapshots.id
      WHERE nhl_game_state_observation_snapshots.league_id =
          NEW.league_id
        AND nhl_game_state_observation_snapshots.season_id =
          NEW.season_id
        AND nhl_game_state_observation_snapshots.id =
          NEW.observation_snapshot_id
        AND nhl_game_state_observation_snapshots.freshness_status =
          'fresh'
        AND NEW.late_snapshot_at_ms -
          nhl_game_state_observation_snapshots.observed_at_ms
          BETWEEN 0 AND 300000
        AND nhl_game_state_observations.id =
          NEW.observation_id
        AND nhl_game_state_observations.nhl_game_id =
          NEW.nhl_game_id
        AND nhl_game_state_observations
          .nhl_game_scheduled_starts_at_ms =
            NEW.nhl_game_scheduled_starts_at_ms
        AND nhl_game_state_observations.observed_game_state =
          NEW.observed_game_state
        AND NEW.observed_game_state IN (
          'in_progress',
          'intermission',
          'final'
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM matchup_roster_players
      WHERE matchup_roster_players.league_id = NEW.league_id
        AND matchup_roster_players.season_id = NEW.season_id
        AND matchup_roster_players.id =
          NEW.matchup_roster_player_id
        AND matchup_roster_players.matchup_roster_lock_id =
          NEW.matchup_roster_lock_id
        AND matchup_roster_players.player_id = NEW.player_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM matchup_roster_locks
      JOIN stat_snapshots
        ON stat_snapshots.league_id =
            matchup_roster_locks.league_id
       AND stat_snapshots.id =
            matchup_roster_locks.baseline_snapshot_id
      JOIN player_game_stat_observations
        ON player_game_stat_observations.id =
            NEW.baseline_player_game_stat_observation_id
       AND player_game_stat_observations.stat_source_id =
            stat_snapshots.stat_source_id
       AND player_game_stat_observations.refresh_id =
            stat_snapshots.source_refresh_id
      JOIN stat_refresh_player_game_sets
        ON stat_refresh_player_game_sets.id =
            player_game_stat_observations.observation_set_id
       AND stat_refresh_player_game_sets.stat_source_id =
            player_game_stat_observations.stat_source_id
       AND stat_refresh_player_game_sets.refresh_id =
            player_game_stat_observations.refresh_id
      JOIN stat_refresh_player_game_coverage_entries
        ON stat_refresh_player_game_coverage_entries.stat_source_id =
            player_game_stat_observations.stat_source_id
       AND stat_refresh_player_game_coverage_entries.refresh_id =
            player_game_stat_observations.refresh_id
       AND stat_refresh_player_game_coverage_entries.observation_set_id =
            player_game_stat_observations.observation_set_id
       AND stat_refresh_player_game_coverage_entries.nhl_season_key =
            player_game_stat_observations.nhl_season_key
       AND stat_refresh_player_game_coverage_entries.player_id =
            player_game_stat_observations.player_id
       AND stat_refresh_player_game_coverage_entries.nhl_game_id =
            player_game_stat_observations.nhl_game_id
       AND stat_refresh_player_game_coverage_entries
            .nhl_game_scheduled_starts_at_ms =
            player_game_stat_observations
              .nhl_game_scheduled_starts_at_ms
       AND stat_refresh_player_game_coverage_entries.disposition =
            'expected_game'
      WHERE matchup_roster_locks.league_id = NEW.league_id
        AND matchup_roster_locks.season_id = NEW.season_id
        AND matchup_roster_locks.id =
          NEW.matchup_roster_lock_id
        AND stat_snapshots.intended_use = 'matchup_baseline'
        AND stat_snapshots.completeness_status = 'complete'
        AND stat_snapshots.freshness_status = 'fresh'
        AND stat_snapshots.committed = 1
        AND stat_snapshots.captured_at_ms <=
          NEW.late_snapshot_at_ms
        AND player_game_stat_observations.player_id =
          NEW.player_id
        AND player_game_stat_observations.nhl_game_id =
          NEW.nhl_game_id
        AND player_game_stat_observations
          .nhl_game_scheduled_starts_at_ms =
            NEW.nhl_game_scheduled_starts_at_ms
        AND player_game_stat_observations.created_at_ms <=
          stat_snapshots.captured_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'late-lock exclusion child must match fresh state and sealed baseline statistics'
  ) END;
END;

CREATE TRIGGER matchup_roster_game_exclusion_sets_valid_insert
BEFORE INSERT ON matchup_roster_game_exclusion_sets
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.created_at_ms = NEW.late_snapshot_at_ms
    AND NEW.sealed_at_ms = NEW.late_snapshot_at_ms
    AND EXISTS (
      SELECT 1
      FROM matchup_roster_locks
      WHERE matchup_roster_locks.league_id = NEW.league_id
        AND matchup_roster_locks.season_id = NEW.season_id
        AND matchup_roster_locks.matchup_week_id =
          NEW.matchup_week_id
        AND matchup_roster_locks.team_id = NEW.team_id
        AND matchup_roster_locks.id =
          NEW.matchup_roster_lock_id
        AND matchup_roster_locks.lock_type = 'late'
        AND matchup_roster_locks.legal = 1
        AND matchup_roster_locks.legality_reason_code IS NULL
        AND matchup_roster_locks.source_freshness_status =
          'fresh'
        AND matchup_roster_locks.locked_at_ms =
          NEW.late_snapshot_at_ms
        AND matchup_roster_locks.baseline_snapshot_id =
          NEW.baseline_snapshot_id
        AND matchup_roster_locks.version =
          NEW.matchup_roster_lock_version
    )
    AND EXISTS (
      SELECT 1
      FROM matchups
      JOIN matchup_weeks
        ON matchup_weeks.league_id = matchups.league_id
       AND matchup_weeks.id = matchups.matchup_week_id
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
        AND matchups.matchup_week_id = NEW.matchup_week_id
        AND matchups.id = NEW.matchup_id
        AND matchups.status = 'live'
        AND NEW.team_id IN (
          matchups.home_team_id,
          matchups.away_team_id
        )
        AND matchup_weeks.season_id = NEW.season_id
        AND NEW.late_snapshot_at_ms >=
          matchup_weeks.starts_at_ms
        AND NEW.late_snapshot_at_ms <
          matchup_weeks.ends_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM nhl_game_state_observation_snapshots
      JOIN stat_snapshots
        ON stat_snapshots.league_id = NEW.league_id
       AND stat_snapshots.season_id = NEW.season_id
       AND stat_snapshots.matchup_week_id = NEW.matchup_week_id
       AND stat_snapshots.id = NEW.baseline_snapshot_id
      JOIN stat_refresh_player_game_sets
        ON stat_refresh_player_game_sets.stat_source_id =
            stat_snapshots.stat_source_id
       AND stat_refresh_player_game_sets.refresh_id =
            stat_snapshots.source_refresh_id
      WHERE nhl_game_state_observation_snapshots.league_id =
          NEW.league_id
        AND nhl_game_state_observation_snapshots.season_id =
          NEW.season_id
        AND nhl_game_state_observation_snapshots.matchup_week_id =
          NEW.matchup_week_id
        AND nhl_game_state_observation_snapshots.team_id =
          NEW.team_id
        AND nhl_game_state_observation_snapshots.id =
          NEW.observation_snapshot_id
        AND nhl_game_state_observation_snapshots.freshness_status =
          'fresh'
        AND NEW.late_snapshot_at_ms -
          nhl_game_state_observation_snapshots.observed_at_ms
          BETWEEN 0 AND 300000
        AND nhl_game_state_observation_snapshots.provider =
          stat_refresh_player_game_sets.provider
        AND stat_snapshots.intended_use = 'matchup_baseline'
        AND stat_snapshots.completeness_status = 'complete'
        AND stat_snapshots.freshness_status = 'fresh'
        AND stat_snapshots.committed = 1
        AND stat_snapshots.captured_at_ms <=
          NEW.late_snapshot_at_ms
    )
    AND NOT EXISTS (
      SELECT 1
      FROM matchup_roster_players AS selected_player
      WHERE selected_player.league_id = NEW.league_id
        AND selected_player.season_id = NEW.season_id
        AND selected_player.matchup_roster_lock_id =
          NEW.matchup_roster_lock_id
        AND NOT EXISTS (
          SELECT 1
          FROM stat_snapshots AS selected_snapshot
          JOIN stat_refresh_player_game_sets AS selected_set
            ON selected_set.stat_source_id =
                selected_snapshot.stat_source_id
           AND selected_set.refresh_id =
                selected_snapshot.source_refresh_id
          JOIN stat_refresh_player_game_coverage_entries AS
            selected_coverage
            ON selected_coverage.stat_source_id =
                selected_set.stat_source_id
           AND selected_coverage.refresh_id =
                selected_set.refresh_id
           AND selected_coverage.observation_set_id =
                selected_set.id
           AND selected_coverage.nhl_season_key =
                selected_set.nhl_season_key
           AND selected_coverage.player_id =
                selected_player.player_id
          WHERE selected_snapshot.league_id = NEW.league_id
            AND selected_snapshot.season_id = NEW.season_id
            AND selected_snapshot.matchup_week_id =
              NEW.matchup_week_id
            AND selected_snapshot.id = NEW.baseline_snapshot_id
            AND selected_snapshot.intended_use =
              'matchup_baseline'
            AND selected_snapshot.completeness_status = 'complete'
            AND selected_snapshot.freshness_status = 'fresh'
            AND selected_snapshot.committed = 1
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM matchup_roster_players AS selected_player
      JOIN stat_snapshots AS selected_snapshot
        ON selected_snapshot.league_id = selected_player.league_id
       AND selected_snapshot.season_id = selected_player.season_id
       AND selected_snapshot.matchup_week_id =
            NEW.matchup_week_id
       AND selected_snapshot.id = NEW.baseline_snapshot_id
      JOIN stat_refresh_player_game_sets AS selected_set
        ON selected_set.stat_source_id =
            selected_snapshot.stat_source_id
       AND selected_set.refresh_id =
            selected_snapshot.source_refresh_id
      JOIN stat_refresh_player_game_coverage_entries AS
        selected_coverage
        ON selected_coverage.stat_source_id = selected_set.stat_source_id
       AND selected_coverage.refresh_id = selected_set.refresh_id
       AND selected_coverage.observation_set_id = selected_set.id
       AND selected_coverage.nhl_season_key =
            selected_set.nhl_season_key
       AND selected_coverage.player_id = selected_player.player_id
       AND selected_coverage.disposition = 'expected_game'
      JOIN player_game_stat_observations AS baseline_observation
        ON baseline_observation.stat_source_id =
            selected_coverage.stat_source_id
       AND baseline_observation.refresh_id =
            selected_coverage.refresh_id
       AND baseline_observation.observation_set_id =
            selected_coverage.observation_set_id
       AND baseline_observation.nhl_season_key =
            selected_coverage.nhl_season_key
       AND baseline_observation.player_id =
            selected_coverage.player_id
       AND baseline_observation.nhl_game_id =
            selected_coverage.nhl_game_id
       AND baseline_observation.nhl_game_scheduled_starts_at_ms =
            selected_coverage.nhl_game_scheduled_starts_at_ms
      JOIN matchup_weeks AS selected_week
        ON selected_week.league_id = selected_player.league_id
       AND selected_week.season_id = selected_player.season_id
       AND selected_week.id = NEW.matchup_week_id
      WHERE selected_player.league_id = NEW.league_id
        AND selected_player.season_id = NEW.season_id
        AND selected_player.matchup_roster_lock_id =
          NEW.matchup_roster_lock_id
        AND selected_coverage.nhl_game_scheduled_starts_at_ms >=
          selected_week.starts_at_ms
        AND selected_coverage.nhl_game_scheduled_starts_at_ms <
          selected_week.ends_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM nhl_game_state_observations AS required_game
          WHERE required_game.league_id = NEW.league_id
            AND required_game.season_id = NEW.season_id
            AND required_game.observation_snapshot_id =
              NEW.observation_snapshot_id
            AND required_game.nhl_game_id =
              selected_coverage.nhl_game_id
            AND required_game.nhl_game_scheduled_starts_at_ms =
              selected_coverage.nhl_game_scheduled_starts_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM nhl_game_state_observations AS observed_game
      WHERE observed_game.league_id = NEW.league_id
        AND observed_game.season_id = NEW.season_id
        AND observed_game.observation_snapshot_id =
          NEW.observation_snapshot_id
        AND NOT EXISTS (
          SELECT 1
          FROM matchup_roster_players AS selected_player
          JOIN stat_snapshots AS selected_snapshot
            ON selected_snapshot.league_id =
                selected_player.league_id
           AND selected_snapshot.season_id =
                selected_player.season_id
           AND selected_snapshot.matchup_week_id =
                NEW.matchup_week_id
           AND selected_snapshot.id = NEW.baseline_snapshot_id
          JOIN stat_refresh_player_game_sets AS selected_set
            ON selected_set.stat_source_id =
                selected_snapshot.stat_source_id
           AND selected_set.refresh_id =
                selected_snapshot.source_refresh_id
          JOIN stat_refresh_player_game_coverage_entries AS
            selected_coverage
            ON selected_coverage.stat_source_id =
                selected_set.stat_source_id
           AND selected_coverage.refresh_id = selected_set.refresh_id
           AND selected_coverage.observation_set_id = selected_set.id
           AND selected_coverage.nhl_season_key =
                selected_set.nhl_season_key
           AND selected_coverage.player_id =
                selected_player.player_id
           AND selected_coverage.disposition = 'expected_game'
          JOIN player_game_stat_observations AS baseline_observation
            ON baseline_observation.stat_source_id =
                selected_coverage.stat_source_id
           AND baseline_observation.refresh_id =
                selected_coverage.refresh_id
           AND baseline_observation.observation_set_id =
                selected_coverage.observation_set_id
           AND baseline_observation.nhl_season_key =
                selected_coverage.nhl_season_key
           AND baseline_observation.player_id =
                selected_coverage.player_id
           AND baseline_observation.nhl_game_id =
                selected_coverage.nhl_game_id
           AND baseline_observation
                .nhl_game_scheduled_starts_at_ms =
                selected_coverage.nhl_game_scheduled_starts_at_ms
          JOIN matchup_weeks AS selected_week
            ON selected_week.league_id = selected_player.league_id
           AND selected_week.season_id = selected_player.season_id
           AND selected_week.id = NEW.matchup_week_id
          WHERE selected_player.league_id = NEW.league_id
            AND selected_player.season_id = NEW.season_id
            AND selected_player.matchup_roster_lock_id =
              NEW.matchup_roster_lock_id
            AND selected_coverage.nhl_game_scheduled_starts_at_ms >=
              selected_week.starts_at_ms
            AND selected_coverage.nhl_game_scheduled_starts_at_ms <
              selected_week.ends_at_ms
            AND selected_coverage.nhl_game_id =
              observed_game.nhl_game_id
            AND selected_coverage.nhl_game_scheduled_starts_at_ms =
              observed_game.nhl_game_scheduled_starts_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM matchup_roster_players AS selected_player
      JOIN stat_snapshots AS selected_snapshot
        ON selected_snapshot.league_id = selected_player.league_id
       AND selected_snapshot.season_id = selected_player.season_id
       AND selected_snapshot.matchup_week_id =
            NEW.matchup_week_id
       AND selected_snapshot.id = NEW.baseline_snapshot_id
      JOIN stat_refresh_player_game_sets AS selected_set
        ON selected_set.stat_source_id =
            selected_snapshot.stat_source_id
       AND selected_set.refresh_id =
            selected_snapshot.source_refresh_id
      JOIN stat_refresh_player_game_coverage_entries AS
        selected_coverage
        ON selected_coverage.stat_source_id = selected_set.stat_source_id
       AND selected_coverage.refresh_id = selected_set.refresh_id
       AND selected_coverage.observation_set_id = selected_set.id
       AND selected_coverage.nhl_season_key =
            selected_set.nhl_season_key
       AND selected_coverage.player_id = selected_player.player_id
       AND selected_coverage.disposition = 'expected_game'
      JOIN player_game_stat_observations AS baseline_observation
        ON baseline_observation.stat_source_id =
            selected_coverage.stat_source_id
       AND baseline_observation.refresh_id =
            selected_coverage.refresh_id
       AND baseline_observation.observation_set_id =
            selected_coverage.observation_set_id
       AND baseline_observation.nhl_season_key =
            selected_coverage.nhl_season_key
       AND baseline_observation.player_id =
            selected_coverage.player_id
       AND baseline_observation.nhl_game_id =
            selected_coverage.nhl_game_id
       AND baseline_observation.nhl_game_scheduled_starts_at_ms =
            selected_coverage.nhl_game_scheduled_starts_at_ms
      JOIN matchup_weeks AS selected_week
        ON selected_week.league_id = selected_player.league_id
       AND selected_week.season_id = selected_player.season_id
       AND selected_week.id = NEW.matchup_week_id
      JOIN nhl_game_state_observations AS observed_game
        ON observed_game.league_id = NEW.league_id
       AND observed_game.season_id = NEW.season_id
       AND observed_game.observation_snapshot_id =
            NEW.observation_snapshot_id
       AND observed_game.nhl_game_id =
            selected_coverage.nhl_game_id
       AND observed_game.nhl_game_scheduled_starts_at_ms =
            selected_coverage.nhl_game_scheduled_starts_at_ms
      WHERE selected_player.league_id = NEW.league_id
        AND selected_player.season_id = NEW.season_id
        AND selected_player.matchup_roster_lock_id =
          NEW.matchup_roster_lock_id
        AND selected_coverage.nhl_game_scheduled_starts_at_ms >=
          selected_week.starts_at_ms
        AND selected_coverage.nhl_game_scheduled_starts_at_ms <
          selected_week.ends_at_ms
        AND selected_coverage.nhl_game_scheduled_starts_at_ms <=
          NEW.late_snapshot_at_ms
        AND observed_game.observed_game_state IN (
          'in_progress',
          'intermission',
          'final'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM matchup_roster_game_exclusions AS required_exclusion
          WHERE required_exclusion.league_id = NEW.league_id
            AND required_exclusion.season_id = NEW.season_id
            AND required_exclusion.exclusion_set_id = NEW.id
            AND required_exclusion.matchup_week_id =
              NEW.matchup_week_id
            AND required_exclusion.matchup_id = NEW.matchup_id
            AND required_exclusion.team_id = NEW.team_id
            AND required_exclusion.matchup_roster_lock_id =
              NEW.matchup_roster_lock_id
            AND required_exclusion.matchup_roster_player_id =
              selected_player.id
            AND required_exclusion.player_id =
              selected_player.player_id
            AND required_exclusion.observation_snapshot_id =
              NEW.observation_snapshot_id
            AND required_exclusion.observation_id = observed_game.id
            AND required_exclusion
                .baseline_player_game_stat_observation_id =
              baseline_observation.id
            AND required_exclusion.nhl_game_id =
              selected_coverage.nhl_game_id
            AND required_exclusion
                .nhl_game_scheduled_starts_at_ms =
              selected_coverage.nhl_game_scheduled_starts_at_ms
            AND required_exclusion.observed_game_state =
              observed_game.observed_game_state
            AND required_exclusion.late_snapshot_at_ms =
              NEW.late_snapshot_at_ms
            AND required_exclusion.created_at_ms =
              NEW.late_snapshot_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM matchup_roster_game_exclusions AS sealed_exclusion
      WHERE sealed_exclusion.league_id = NEW.league_id
        AND sealed_exclusion.season_id = NEW.season_id
        AND sealed_exclusion.exclusion_set_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM matchup_roster_players AS selected_player
          JOIN stat_snapshots AS selected_snapshot
            ON selected_snapshot.league_id =
                selected_player.league_id
           AND selected_snapshot.season_id =
                selected_player.season_id
           AND selected_snapshot.matchup_week_id =
                NEW.matchup_week_id
           AND selected_snapshot.id = NEW.baseline_snapshot_id
          JOIN stat_refresh_player_game_sets AS selected_set
            ON selected_set.stat_source_id =
                selected_snapshot.stat_source_id
           AND selected_set.refresh_id =
                selected_snapshot.source_refresh_id
          JOIN stat_refresh_player_game_coverage_entries AS
            selected_coverage
            ON selected_coverage.stat_source_id =
                selected_set.stat_source_id
           AND selected_coverage.refresh_id = selected_set.refresh_id
           AND selected_coverage.observation_set_id = selected_set.id
           AND selected_coverage.nhl_season_key =
                selected_set.nhl_season_key
           AND selected_coverage.player_id =
                selected_player.player_id
           AND selected_coverage.disposition = 'expected_game'
          JOIN player_game_stat_observations AS baseline_observation
            ON baseline_observation.stat_source_id =
                selected_coverage.stat_source_id
           AND baseline_observation.refresh_id =
                selected_coverage.refresh_id
           AND baseline_observation.observation_set_id =
                selected_coverage.observation_set_id
           AND baseline_observation.nhl_season_key =
                selected_coverage.nhl_season_key
           AND baseline_observation.player_id =
                selected_coverage.player_id
           AND baseline_observation.nhl_game_id =
                selected_coverage.nhl_game_id
           AND baseline_observation
                .nhl_game_scheduled_starts_at_ms =
                selected_coverage.nhl_game_scheduled_starts_at_ms
          JOIN matchup_weeks AS selected_week
            ON selected_week.league_id = selected_player.league_id
           AND selected_week.season_id = selected_player.season_id
           AND selected_week.id = NEW.matchup_week_id
          JOIN nhl_game_state_observations AS observed_game
            ON observed_game.league_id = NEW.league_id
           AND observed_game.season_id = NEW.season_id
           AND observed_game.observation_snapshot_id =
                NEW.observation_snapshot_id
           AND observed_game.nhl_game_id =
                selected_coverage.nhl_game_id
           AND observed_game.nhl_game_scheduled_starts_at_ms =
                selected_coverage.nhl_game_scheduled_starts_at_ms
          WHERE selected_player.league_id = NEW.league_id
            AND selected_player.season_id = NEW.season_id
            AND selected_player.matchup_roster_lock_id =
              NEW.matchup_roster_lock_id
            AND selected_player.id =
              sealed_exclusion.matchup_roster_player_id
            AND selected_player.player_id =
              sealed_exclusion.player_id
            AND selected_coverage.nhl_game_scheduled_starts_at_ms >=
              selected_week.starts_at_ms
            AND selected_coverage.nhl_game_scheduled_starts_at_ms <
              selected_week.ends_at_ms
            AND selected_coverage.nhl_game_scheduled_starts_at_ms <=
              NEW.late_snapshot_at_ms
            AND baseline_observation.id =
              sealed_exclusion
                .baseline_player_game_stat_observation_id
            AND observed_game.id = sealed_exclusion.observation_id
            AND observed_game.observed_game_state IN (
              'in_progress',
              'intermission',
              'final'
            )
            AND observed_game.observed_game_state =
              sealed_exclusion.observed_game_state
            AND sealed_exclusion.observation_snapshot_id =
              NEW.observation_snapshot_id
            AND sealed_exclusion.nhl_game_id =
              selected_coverage.nhl_game_id
            AND sealed_exclusion.nhl_game_scheduled_starts_at_ms =
              selected_coverage.nhl_game_scheduled_starts_at_ms
        )
    )
    AND (
      SELECT COUNT(*)
      FROM matchup_roster_game_exclusions
      WHERE matchup_roster_game_exclusions.league_id =
          NEW.league_id
        AND matchup_roster_game_exclusions.season_id =
          NEW.season_id
        AND matchup_roster_game_exclusions.exclusion_set_id =
          NEW.id
        AND matchup_roster_game_exclusions.matchup_week_id =
          NEW.matchup_week_id
        AND matchup_roster_game_exclusions.matchup_id =
          NEW.matchup_id
        AND matchup_roster_game_exclusions.team_id =
          NEW.team_id
        AND matchup_roster_game_exclusions.matchup_roster_lock_id =
          NEW.matchup_roster_lock_id
        AND matchup_roster_game_exclusions.observation_snapshot_id =
          NEW.observation_snapshot_id
        AND matchup_roster_game_exclusions.late_snapshot_at_ms =
          NEW.late_snapshot_at_ms
        AND matchup_roster_game_exclusions.created_at_ms =
          NEW.late_snapshot_at_ms
    ) = NEW.exclusion_count
    AND NOT EXISTS (
      SELECT 1
      FROM matchup_roster_game_exclusions
      WHERE matchup_roster_game_exclusions.league_id =
          NEW.league_id
        AND matchup_roster_game_exclusions.exclusion_set_id =
          NEW.id
        AND (
          matchup_roster_game_exclusions.season_id <>
            NEW.season_id
          OR matchup_roster_game_exclusions.matchup_week_id <>
            NEW.matchup_week_id
          OR matchup_roster_game_exclusions.matchup_id <>
            NEW.matchup_id
          OR matchup_roster_game_exclusions.team_id <>
            NEW.team_id
          OR matchup_roster_game_exclusions.matchup_roster_lock_id <>
            NEW.matchup_roster_lock_id
          OR matchup_roster_game_exclusions.observation_snapshot_id <>
            NEW.observation_snapshot_id
          OR matchup_roster_game_exclusions.late_snapshot_at_ms <>
            NEW.late_snapshot_at_ms
          OR matchup_roster_game_exclusions.created_at_ms <>
            NEW.late_snapshot_at_ms
        )
    )
  ) THEN RAISE(
    ABORT,
    'late-lock exclusion root must seal one exact live roster and observation set'
  ) END;
END;

CREATE TRIGGER nhl_game_state_observation_snapshots_immutable_update
BEFORE UPDATE ON nhl_game_state_observation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'NHL game observation snapshot is immutable');
END;

CREATE TRIGGER stat_refresh_player_game_sets_immutable_update
BEFORE UPDATE ON stat_refresh_player_game_sets
BEGIN
  SELECT RAISE(
    ABORT,
    'player-game observation set is immutable'
  );
END;

CREATE TRIGGER stat_refresh_player_game_sets_immutable_delete
BEFORE DELETE ON stat_refresh_player_game_sets
BEGIN
  SELECT RAISE(
    ABORT,
    'player-game observation set is immutable'
  );
END;

CREATE TRIGGER stat_refresh_player_game_coverage_immutable_update
BEFORE UPDATE ON stat_refresh_player_game_coverage_entries
BEGIN
  SELECT RAISE(
    ABORT,
    'player-game coverage entry is immutable'
  );
END;

CREATE TRIGGER stat_refresh_player_game_coverage_immutable_delete
BEFORE DELETE ON stat_refresh_player_game_coverage_entries
BEGIN
  SELECT RAISE(
    ABORT,
    'player-game coverage entry is immutable'
  );
END;

CREATE TRIGGER player_game_stat_observations_immutable_update
BEFORE UPDATE ON player_game_stat_observations
BEGIN
  SELECT RAISE(
    ABORT,
    'player-game stat observation is immutable'
  );
END;

CREATE TRIGGER player_game_stat_observations_immutable_delete
BEFORE DELETE ON player_game_stat_observations
BEGIN
  SELECT RAISE(
    ABORT,
    'player-game stat observation is immutable'
  );
END;

CREATE TRIGGER nhl_game_state_observation_snapshots_immutable_delete
BEFORE DELETE ON nhl_game_state_observation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'NHL game observation snapshot is immutable');
END;

CREATE TRIGGER nhl_game_state_observations_immutable_update
BEFORE UPDATE ON nhl_game_state_observations
BEGIN
  SELECT RAISE(ABORT, 'NHL game observation is immutable');
END;

CREATE TRIGGER nhl_game_state_observations_immutable_delete
BEFORE DELETE ON nhl_game_state_observations
BEGIN
  SELECT RAISE(ABORT, 'NHL game observation is immutable');
END;

CREATE TRIGGER matchup_roster_game_exclusion_sets_immutable_update
BEFORE UPDATE ON matchup_roster_game_exclusion_sets
BEGIN
  SELECT RAISE(ABORT, 'late-lock exclusion set is immutable');
END;

CREATE TRIGGER matchup_roster_game_exclusion_sets_immutable_delete
BEFORE DELETE ON matchup_roster_game_exclusion_sets
BEGIN
  SELECT RAISE(ABORT, 'late-lock exclusion set is immutable');
END;

CREATE TRIGGER matchup_roster_game_exclusions_immutable_update
BEFORE UPDATE ON matchup_roster_game_exclusions
BEGIN
  SELECT RAISE(
    ABORT,
    'late-lock whole-game exclusion evidence is immutable'
  );
END;

CREATE TRIGGER matchup_roster_game_exclusions_immutable_delete
BEFORE DELETE ON matchup_roster_game_exclusions
BEGIN
  SELECT RAISE(
    ABORT,
    'late-lock whole-game exclusion evidence is immutable'
  );
END;

-- Lifecycle validation and immutable evidence.

CREATE TRIGGER entry_draft_rollover_bindings_valid_insert
BEFORE INSERT ON entry_draft_rollover_bindings
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'scheduled'
    AND length(NEW.current_schedule_operation_id) = 36
    AND NEW.current_schedule_operation_id =
      lower(NEW.current_schedule_operation_id)
    AND NEW.successful_rollover_id IS NULL
    AND NEW.selection_gate_status = 'locked'
    AND NEW.trading_gate_status = 'locked'
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND EXISTS (
      SELECT 1
      FROM entry_drafts
      WHERE entry_drafts.league_id = NEW.league_id
        AND entry_drafts.id = NEW.entry_draft_id
        AND entry_drafts.season_id = NEW.to_season_id
        AND entry_drafts.status IN (
          'setup',
          'lottery_ready',
          'ready'
        )
        AND entry_drafts.starts_at_ms = NEW.scheduled_starts_at_ms
        AND entry_drafts.version =
          NEW.entry_draft_version_at_schedule
    )
    AND EXISTS (
      SELECT 1
      FROM seasons
      WHERE seasons.league_id = NEW.league_id
        AND seasons.id = NEW.from_season_id
        AND seasons.version =
          NEW.source_season_version_at_schedule
    )
    AND EXISTS (
      SELECT 1
      FROM seasons
      WHERE seasons.league_id = NEW.league_id
        AND seasons.id = NEW.to_season_id
        AND seasons.version =
          NEW.target_season_version_at_schedule
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_operations
      WHERE matchup_operations.league_id = NEW.league_id
        AND matchup_operations.season_id = NEW.to_season_id
        AND matchup_operations.id = NEW.target_schedule_id
        AND matchup_operations.operation_type = 'schedule_generate'
        AND matchup_operations.status = 'succeeded'
        AND matchup_operations.completed_at_ms IS NOT NULL
        AND matchup_operations.completed_at_ms <= NEW.created_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_weeks
      WHERE matchup_weeks.league_id = NEW.league_id
        AND matchup_weeks.season_id = NEW.to_season_id
        AND matchup_weeks.id = NEW.week_one_matchup_week_id
        AND matchup_weeks.sequence = 1
        AND matchup_weeks.starts_at_ms = NEW.week_one_starts_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM season_matchup_schedule_generations
      WHERE season_matchup_schedule_generations.league_id =
          NEW.league_id
        AND season_matchup_schedule_generations.season_id =
          NEW.to_season_id
        AND season_matchup_schedule_generations.schedule_operation_id =
          NEW.target_schedule_id
        AND season_matchup_schedule_generations.schedule_version =
          NEW.target_schedule_version
        AND season_matchup_schedule_generations.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND season_matchup_schedule_generations.week_one_starts_at_ms =
          NEW.week_one_starts_at_ms
        AND season_matchup_schedule_generations.status = 'current'
    )
    AND EXISTS (
      SELECT 1
      FROM job_runs
      WHERE job_runs.league_id = NEW.league_id
        AND job_runs.id = NEW.current_scheduled_job_run_id
        AND job_runs.season_id = NEW.to_season_id
        AND job_runs.job_type = 'league:entry_draft_rollover'
        AND job_runs.occurrence_key = NEW.current_occurrence_key
        AND job_runs.scheduled_for_ms = NEW.scheduled_starts_at_ms
        AND job_runs.status = 'pending'
        AND job_runs.attempt_count = 0
        AND job_runs.lease_owner IS NULL
        AND job_runs.lease_token IS NULL
        AND job_runs.lease_expires_at_ms IS NULL
        AND job_runs.started_at_ms IS NULL
        AND job_runs.completed_at_ms IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id = NEW.scheduled_by_membership_id
        AND league_memberships.user_id = NEW.scheduled_by_user_id
        AND league_memberships.status = 'active'
    )
    AND (
      (
        NEW.scheduled_by_authority = 'commissioner'
        AND EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.scheduled_by_membership_id
        )
      )
      OR (
        NEW.scheduled_by_authority =
          'platform_administrator_as_commissioner'
        AND EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              NEW.scheduled_by_user_id
            AND platform_roles.role =
              'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'Entry Draft rollover binding requires its exact scheduled calendar'
  ) END;
END;

CREATE TRIGGER season_rollover_occurrences_valid_insert
BEFORE INSERT ON season_rollover_occurrences
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'scheduled'
    AND NEW.successful_rollover_id IS NULL
    AND NEW.terminal_at_ms IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND EXISTS (
      SELECT 1
      FROM entry_draft_rollover_bindings
      WHERE entry_draft_rollover_bindings.league_id = NEW.league_id
        AND entry_draft_rollover_bindings.id = NEW.binding_id
        AND entry_draft_rollover_bindings.entry_draft_id =
          NEW.entry_draft_id
        AND entry_draft_rollover_bindings.from_season_id =
          NEW.from_season_id
        AND entry_draft_rollover_bindings.to_season_id =
          NEW.to_season_id
        AND entry_draft_rollover_bindings.current_rollover_occurrence_id =
          NEW.id
        AND entry_draft_rollover_bindings.current_scheduled_job_run_id =
          NEW.scheduled_job_run_id
        AND entry_draft_rollover_bindings.current_schedule_operation_id =
          NEW.schedule_operation_id
        AND entry_draft_rollover_bindings.target_schedule_id =
          NEW.target_schedule_id
        AND entry_draft_rollover_bindings.target_schedule_version =
          NEW.target_schedule_version
        AND entry_draft_rollover_bindings.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND entry_draft_rollover_bindings.week_one_starts_at_ms =
          NEW.week_one_starts_at_ms
        AND entry_draft_rollover_bindings.scheduled_starts_at_ms =
          NEW.scheduled_starts_at_ms
        AND entry_draft_rollover_bindings.current_occurrence_key =
          NEW.occurrence_key
        AND entry_draft_rollover_bindings.scheduled_by_user_id =
          NEW.scheduled_by_user_id
        AND entry_draft_rollover_bindings.scheduled_by_membership_id =
          NEW.scheduled_by_membership_id
        AND entry_draft_rollover_bindings.scheduled_by_authority =
          NEW.scheduled_by_authority
        AND entry_draft_rollover_bindings.source_season_version_at_schedule =
          NEW.source_season_version_at_schedule
        AND entry_draft_rollover_bindings.target_season_version_at_schedule =
          NEW.target_season_version_at_schedule
        AND entry_draft_rollover_bindings.entry_draft_version_at_schedule =
          NEW.entry_draft_version_at_schedule
        AND entry_draft_rollover_bindings.status = 'scheduled'
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id = NEW.scheduled_by_membership_id
        AND league_memberships.user_id = NEW.scheduled_by_user_id
        AND league_memberships.status = 'active'
    )
    AND (
      (
        NEW.scheduled_by_authority = 'commissioner'
        AND EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.scheduled_by_membership_id
        )
      )
      OR (
        NEW.scheduled_by_authority =
          'platform_administrator_as_commissioner'
        AND EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              NEW.scheduled_by_user_id
            AND platform_roles.role =
              'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'rollover occurrence must copy its current binding snapshot'
  ) END;
END;

CREATE TRIGGER season_rollover_occurrences_forward_update
BEFORE UPDATE ON season_rollover_occurrences
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.binding_id IS OLD.binding_id
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.from_season_id IS OLD.from_season_id
    AND NEW.to_season_id IS OLD.to_season_id
    AND NEW.target_schedule_id IS OLD.target_schedule_id
    AND NEW.target_schedule_version IS OLD.target_schedule_version
    AND NEW.week_one_matchup_week_id IS OLD.week_one_matchup_week_id
    AND NEW.week_one_starts_at_ms IS OLD.week_one_starts_at_ms
    AND NEW.scheduled_starts_at_ms IS OLD.scheduled_starts_at_ms
    AND NEW.occurrence_key IS OLD.occurrence_key
    AND NEW.scheduled_job_run_id IS OLD.scheduled_job_run_id
    AND NEW.schedule_operation_id IS OLD.schedule_operation_id
    AND NEW.scheduled_by_user_id IS OLD.scheduled_by_user_id
    AND NEW.scheduled_by_membership_id IS OLD.scheduled_by_membership_id
    AND NEW.scheduled_by_authority IS OLD.scheduled_by_authority
    AND NEW.source_season_version_at_schedule IS
      OLD.source_season_version_at_schedule
    AND NEW.target_season_version_at_schedule IS
      OLD.target_season_version_at_schedule
    AND NEW.entry_draft_version_at_schedule IS
      OLD.entry_draft_version_at_schedule
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'scheduled'
        AND NEW.status = 'superseded'
        AND NEW.successful_rollover_id IS NULL
        AND OLD.superseded_by_occurrence_id IS NULL
        AND NEW.superseded_by_occurrence_id IS NOT NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM season_rollover_attempts
          WHERE season_rollover_attempts.league_id = OLD.league_id
            AND season_rollover_attempts.rollover_occurrence_id = OLD.id
        )
      )
      OR (
        OLD.status = 'scheduled'
        AND NEW.status = 'blocked'
        AND NEW.successful_rollover_id IS NULL
        AND NEW.superseded_by_occurrence_id IS
          OLD.superseded_by_occurrence_id
        AND NEW.terminal_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM season_rollover_attempts AS blocked_attempt
          WHERE blocked_attempt.league_id = NEW.league_id
            AND blocked_attempt.binding_id = NEW.binding_id
            AND blocked_attempt.rollover_occurrence_id = NEW.id
            AND blocked_attempt.status = 'blocked'
            AND blocked_attempt.terminal_at_ms = NEW.updated_at_ms
            AND json_array_length(
              blocked_attempt.blockers_json
            ) >= 1
            AND NOT EXISTS (
              SELECT 1
              FROM season_rollover_attempts AS later_attempt
              WHERE later_attempt.league_id =
                  blocked_attempt.league_id
                AND later_attempt.rollover_occurrence_id =
                  blocked_attempt.rollover_occurrence_id
                AND later_attempt.attempt_number >
                  blocked_attempt.attempt_number
            )
        )
      )
      OR (
        OLD.status IN ('scheduled', 'blocked')
        AND NEW.status = 'succeeded'
        AND NEW.successful_rollover_id IS NOT NULL
        AND NEW.superseded_by_occurrence_id IS
          OLD.superseded_by_occurrence_id
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM season_rollovers
          WHERE season_rollovers.league_id = NEW.league_id
            AND season_rollovers.id = NEW.successful_rollover_id
            AND season_rollovers.binding_id = NEW.binding_id
            AND season_rollovers.rollover_occurrence_id = NEW.id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'rollover occurrence may only be superseded before attempts or reach its exact result'
  ) END;
END;

CREATE TRIGGER entry_draft_rollover_bindings_forward_update
BEFORE UPDATE ON entry_draft_rollover_bindings
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.from_season_id IS OLD.from_season_id
    AND NEW.to_season_id IS OLD.to_season_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'scheduled'
        AND NEW.status = 'scheduled'
        AND NEW.successful_rollover_id IS NULL
        AND NEW.selection_gate_status = 'locked'
        AND NEW.trading_gate_status = 'locked'
        AND NEW.current_rollover_occurrence_id <>
          OLD.current_rollover_occurrence_id
        AND NEW.current_scheduled_job_run_id <>
          OLD.current_scheduled_job_run_id
        AND NEW.current_schedule_operation_id <>
          OLD.current_schedule_operation_id
        AND NEW.updated_at_ms < OLD.scheduled_starts_at_ms
        AND EXISTS (
          SELECT 1
          FROM job_runs AS old_job
          WHERE old_job.league_id = OLD.league_id
            AND old_job.id = OLD.current_scheduled_job_run_id
            AND old_job.status = 'skipped'
            AND old_job.attempt_count = 0
            AND old_job.lease_owner IS NULL
            AND old_job.lease_token IS NULL
            AND old_job.lease_expires_at_ms IS NULL
            AND old_job.started_at_ms IS NULL
            AND old_job.completed_at_ms IS NULL
            AND old_job.result_json IS NULL
            AND old_job.last_error_code IS NULL
            AND old_job.next_attempt_at_ms IS NULL
            AND old_job.updated_at_ms = NEW.updated_at_ms
        )
        AND EXISTS (
          SELECT 1
          FROM season_rollover_occurrences
          WHERE season_rollover_occurrences.league_id = OLD.league_id
            AND season_rollover_occurrences.id =
              OLD.current_rollover_occurrence_id
            AND season_rollover_occurrences.status = 'superseded'
            AND season_rollover_occurrences.superseded_by_occurrence_id =
              NEW.current_rollover_occurrence_id
        )
        AND EXISTS (
          SELECT 1
          FROM job_runs AS new_job
          WHERE new_job.league_id = NEW.league_id
            AND new_job.id = NEW.current_scheduled_job_run_id
            AND new_job.season_id = NEW.to_season_id
            AND new_job.job_type = 'league:entry_draft_rollover'
            AND new_job.occurrence_key = NEW.current_occurrence_key
            AND new_job.scheduled_for_ms = NEW.scheduled_starts_at_ms
            AND new_job.status = 'pending'
            AND new_job.attempt_count = 0
            AND new_job.lease_owner IS NULL
            AND new_job.lease_token IS NULL
            AND new_job.lease_expires_at_ms IS NULL
            AND new_job.started_at_ms IS NULL
            AND new_job.completed_at_ms IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM entry_drafts
          WHERE entry_drafts.league_id = NEW.league_id
            AND entry_drafts.id = NEW.entry_draft_id
            AND entry_drafts.season_id = NEW.to_season_id
            AND entry_drafts.starts_at_ms =
              NEW.scheduled_starts_at_ms
            AND entry_drafts.version =
              NEW.entry_draft_version_at_schedule
        )
        AND EXISTS (
          SELECT 1
          FROM league_memberships
          WHERE league_memberships.league_id = NEW.league_id
            AND league_memberships.id =
              NEW.scheduled_by_membership_id
            AND league_memberships.user_id =
              NEW.scheduled_by_user_id
            AND league_memberships.status = 'active'
        )
        AND (
          (
            NEW.scheduled_by_authority = 'commissioner'
            AND EXISTS (
              SELECT 1
              FROM leagues
              WHERE leagues.id = NEW.league_id
                AND leagues.commissioner_membership_id =
                  NEW.scheduled_by_membership_id
            )
          )
          OR (
            NEW.scheduled_by_authority =
              'platform_administrator_as_commissioner'
            AND EXISTS (
              SELECT 1
              FROM platform_roles
              WHERE platform_roles.user_id =
                  NEW.scheduled_by_user_id
                AND platform_roles.role =
                  'platform_administrator'
                AND platform_roles.status = 'active'
            )
          )
        )
      )
      OR (
        OLD.status IN ('scheduled', 'blocked')
        AND NEW.status = 'blocked'
        AND NEW.current_rollover_occurrence_id IS
          OLD.current_rollover_occurrence_id
        AND NEW.current_scheduled_job_run_id IS
          OLD.current_scheduled_job_run_id
        AND NEW.current_schedule_operation_id IS
          OLD.current_schedule_operation_id
        AND NEW.target_schedule_id IS OLD.target_schedule_id
        AND NEW.target_schedule_version IS OLD.target_schedule_version
        AND NEW.week_one_matchup_week_id IS
          OLD.week_one_matchup_week_id
        AND NEW.week_one_starts_at_ms IS OLD.week_one_starts_at_ms
        AND NEW.scheduled_starts_at_ms IS OLD.scheduled_starts_at_ms
        AND NEW.current_occurrence_key IS OLD.current_occurrence_key
        AND NEW.source_season_version_at_schedule IS
          OLD.source_season_version_at_schedule
        AND NEW.target_season_version_at_schedule IS
          OLD.target_season_version_at_schedule
        AND NEW.entry_draft_version_at_schedule IS
          OLD.entry_draft_version_at_schedule
        AND NEW.scheduled_by_user_id IS OLD.scheduled_by_user_id
        AND NEW.scheduled_by_membership_id IS
          OLD.scheduled_by_membership_id
        AND NEW.scheduled_by_authority IS
          OLD.scheduled_by_authority
        AND NEW.successful_rollover_id IS NULL
        AND NEW.selection_gate_status = 'locked'
        AND NEW.trading_gate_status = 'locked'
        AND EXISTS (
          SELECT 1
          FROM season_rollover_occurrences
          WHERE season_rollover_occurrences.league_id = NEW.league_id
            AND season_rollover_occurrences.id =
              NEW.current_rollover_occurrence_id
            AND season_rollover_occurrences.status = 'blocked'
        )
        AND EXISTS (
          SELECT 1
          FROM season_rollover_attempts AS blocked_attempt
          WHERE blocked_attempt.league_id = NEW.league_id
            AND blocked_attempt.binding_id = NEW.id
            AND blocked_attempt.rollover_occurrence_id =
              NEW.current_rollover_occurrence_id
            AND blocked_attempt.status = 'blocked'
            AND json_array_length(
              blocked_attempt.blockers_json
            ) >= 1
            AND NOT EXISTS (
              SELECT 1
              FROM season_rollover_attempts AS later_attempt
              WHERE later_attempt.league_id =
                  blocked_attempt.league_id
                AND later_attempt.rollover_occurrence_id =
                  blocked_attempt.rollover_occurrence_id
                AND later_attempt.attempt_number >
                  blocked_attempt.attempt_number
            )
        )
      )
      OR (
        OLD.status IN ('scheduled', 'blocked')
        AND NEW.status = 'succeeded'
        AND NEW.current_rollover_occurrence_id IS
          OLD.current_rollover_occurrence_id
        AND NEW.current_scheduled_job_run_id IS
          OLD.current_scheduled_job_run_id
        AND NEW.current_schedule_operation_id IS
          OLD.current_schedule_operation_id
        AND NEW.target_schedule_id IS OLD.target_schedule_id
        AND NEW.target_schedule_version IS OLD.target_schedule_version
        AND NEW.week_one_matchup_week_id IS
          OLD.week_one_matchup_week_id
        AND NEW.week_one_starts_at_ms IS OLD.week_one_starts_at_ms
        AND NEW.scheduled_starts_at_ms IS OLD.scheduled_starts_at_ms
        AND NEW.current_occurrence_key IS OLD.current_occurrence_key
        AND NEW.source_season_version_at_schedule IS
          OLD.source_season_version_at_schedule
        AND NEW.target_season_version_at_schedule IS
          OLD.target_season_version_at_schedule
        AND NEW.entry_draft_version_at_schedule IS
          OLD.entry_draft_version_at_schedule
        AND NEW.scheduled_by_user_id IS OLD.scheduled_by_user_id
        AND NEW.scheduled_by_membership_id IS
          OLD.scheduled_by_membership_id
        AND NEW.scheduled_by_authority IS
          OLD.scheduled_by_authority
        AND NEW.successful_rollover_id IS NOT NULL
        AND NEW.selection_gate_status = 'open'
        AND NEW.trading_gate_status = 'open'
        AND EXISTS (
          SELECT 1
          FROM season_rollovers
          WHERE season_rollovers.league_id = NEW.league_id
            AND season_rollovers.id = NEW.successful_rollover_id
            AND season_rollovers.binding_id = NEW.id
            AND season_rollovers.rollover_occurrence_id =
              NEW.current_rollover_occurrence_id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'Entry Draft rollover binding violates reschedule or gate semantics'
  ) END;
END;

CREATE TRIGGER season_rollover_attempts_valid_insert
BEFORE INSERT ON season_rollover_attempts
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.blockers_json) AS blocker
    WHERE blocker.type <> 'object'
      OR (
        SELECT COUNT(*)
        FROM json_each(blocker.value)
      ) <> 5
      OR EXISTS (
        SELECT 1
        FROM json_each(blocker.value) AS member
        WHERE member.key NOT IN (
          'code',
          'field',
          'resourceType',
          'resourceId',
          'message'
        )
      )
      OR json_type(blocker.value, '$.code') <> 'text'
      OR json_type(blocker.value, '$.message') <> 'text'
      OR json_type(blocker.value, '$.field') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceType') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceId') NOT IN ('text', 'null')
      OR length(json_extract(blocker.value, '$.code')) NOT BETWEEN 1 AND 100
      OR json_extract(blocker.value, '$.code') GLOB '*[^A-Z0-9_]*'
      OR length(json_extract(blocker.value, '$.message')) NOT BETWEEN 1 AND 500
  ) THEN RAISE(
    ABORT,
    'rollover blockers require the canonical safe object shape'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.status = 'started'
    AND NEW.blockers_json = '[]'
    AND NEW.season_rollover_id IS NULL
    AND NEW.terminal_at_ms IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.started_at_ms
    AND NEW.attempt_number = 1 + COALESCE((
      SELECT MAX(season_rollover_attempts.attempt_number)
      FROM season_rollover_attempts
      WHERE season_rollover_attempts.league_id = NEW.league_id
        AND season_rollover_attempts.rollover_occurrence_id =
          NEW.rollover_occurrence_id
    ), 0)
    AND NOT EXISTS (
      SELECT 1
      FROM season_rollover_attempts
      WHERE season_rollover_attempts.league_id = NEW.league_id
        AND season_rollover_attempts.rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND season_rollover_attempts.status = 'started'
    )
    AND EXISTS (
      SELECT 1
      FROM entry_draft_rollover_bindings AS binding
      JOIN season_rollover_occurrences AS occurrence
        ON occurrence.league_id = binding.league_id
       AND occurrence.binding_id = binding.id
      WHERE binding.league_id = NEW.league_id
        AND binding.id = NEW.binding_id
        AND binding.current_rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND binding.status IN ('scheduled', 'blocked')
        AND binding.selection_gate_status = 'locked'
        AND binding.trading_gate_status = 'locked'
        AND occurrence.id = NEW.rollover_occurrence_id
        AND occurrence.status IN ('scheduled', 'blocked')
        AND occurrence.entry_draft_id = NEW.entry_draft_id
        AND occurrence.from_season_id = NEW.from_season_id
        AND occurrence.to_season_id = NEW.to_season_id
        AND occurrence.target_schedule_id = NEW.target_schedule_id
        AND occurrence.target_schedule_version =
          NEW.target_schedule_version
        AND occurrence.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND occurrence.week_one_starts_at_ms =
          NEW.week_one_starts_at_ms
        AND occurrence.scheduled_starts_at_ms =
          NEW.scheduled_starts_at_ms
        AND occurrence.occurrence_key = NEW.occurrence_key
        AND (
          NEW.trigger_kind <> 'scheduled_job'
          OR occurrence.scheduled_job_run_id =
            NEW.scheduled_job_run_id
        )
    )
  ) THEN RAISE(
    ABORT,
    'rollover attempt must target the exact current occurrence'
  ) END;

  SELECT CASE WHEN
    NEW.trigger_kind = 'scheduled_job'
    AND NOT EXISTS (
      SELECT 1
      FROM job_runs
      WHERE job_runs.league_id = NEW.league_id
        AND job_runs.id = NEW.scheduled_job_run_id
        AND job_runs.season_id = NEW.to_season_id
        AND job_runs.job_type = 'league:entry_draft_rollover'
        AND job_runs.occurrence_key = NEW.occurrence_key
        AND job_runs.scheduled_for_ms = NEW.scheduled_starts_at_ms
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_token IS NOT NULL
    )
  THEN RAISE(
    ABORT,
    'scheduled rollover attempt requires its exact active job lease'
  ) END;

  SELECT CASE WHEN
    NEW.trigger_kind = 'commissioner_retry'
    AND NOT EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id =
          NEW.retry_idempotency_request_id
        AND idempotency_requests.actor_user_id =
          NEW.retry_by_user_id
        AND idempotency_requests.operation =
          'league.lifecycle.transition.v2'
        AND idempotency_requests.status = 'started'
    )
  THEN RAISE(
    ABORT,
    'commissioner retry requires its started lifecycle idempotency request'
  ) END;
END;

CREATE TRIGGER season_rollover_attempts_forward_update
BEFORE UPDATE ON season_rollover_attempts
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'started'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.binding_id IS OLD.binding_id
    AND NEW.rollover_occurrence_id IS OLD.rollover_occurrence_id
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.from_season_id IS OLD.from_season_id
    AND NEW.to_season_id IS OLD.to_season_id
    AND NEW.target_schedule_id IS OLD.target_schedule_id
    AND NEW.target_schedule_version IS OLD.target_schedule_version
    AND NEW.week_one_matchup_week_id IS OLD.week_one_matchup_week_id
    AND NEW.week_one_starts_at_ms IS OLD.week_one_starts_at_ms
    AND NEW.scheduled_starts_at_ms IS OLD.scheduled_starts_at_ms
    AND NEW.occurrence_key IS OLD.occurrence_key
    AND NEW.attempt_number IS OLD.attempt_number
    AND NEW.trigger_kind IS OLD.trigger_kind
    AND NEW.scheduled_job_run_id IS OLD.scheduled_job_run_id
    AND NEW.retry_idempotency_request_id IS
      OLD.retry_idempotency_request_id
    AND NEW.retry_by_user_id IS OLD.retry_by_user_id
    AND NEW.retry_by_membership_id IS OLD.retry_by_membership_id
    AND NEW.retry_authority IS OLD.retry_authority
    AND NEW.source_season_version_observed IS
      OLD.source_season_version_observed
    AND NEW.target_season_version_observed IS
      OLD.target_season_version_observed
    AND NEW.entry_draft_version_observed IS
      OLD.entry_draft_version_observed
    AND NEW.started_at_ms IS OLD.started_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms = NEW.terminal_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        NEW.status = 'blocked'
        AND json_array_length(NEW.blockers_json) >= 1
        AND NEW.season_rollover_id IS NULL
      )
      OR (
        NEW.status = 'succeeded'
        AND NEW.blockers_json = '[]'
        AND NEW.season_rollover_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM season_rollovers
          WHERE season_rollovers.league_id = NEW.league_id
            AND season_rollovers.id = NEW.season_rollover_id
            AND season_rollovers.binding_id = NEW.binding_id
            AND season_rollovers.rollover_occurrence_id =
              NEW.rollover_occurrence_id
            AND season_rollovers.rollover_attempt_id = NEW.id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'rollover attempt may only persist one blocked or succeeded result'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.blockers_json) AS blocker
    WHERE blocker.type <> 'object'
      OR (
        SELECT COUNT(*)
        FROM json_each(blocker.value)
      ) <> 5
      OR EXISTS (
        SELECT 1
        FROM json_each(blocker.value) AS member
        WHERE member.key NOT IN (
          'code',
          'field',
          'resourceType',
          'resourceId',
          'message'
        )
      )
      OR json_type(blocker.value, '$.code') <> 'text'
      OR json_type(blocker.value, '$.message') <> 'text'
      OR json_type(blocker.value, '$.field') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceType') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceId') NOT IN ('text', 'null')
  ) THEN RAISE(
    ABORT,
    'rollover blockers require the canonical safe object shape'
  ) END;
END;

CREATE TRIGGER entry_draft_pick_clocks_valid_insert
BEFORE INSERT ON entry_draft_pick_clocks
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'prepared'
    AND NEW.completed_at_ms IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND EXISTS (
      SELECT 1
      FROM draft_picks
      JOIN entry_drafts
        ON entry_drafts.league_id = draft_picks.league_id
       AND entry_drafts.id = draft_picks.draft_id
      WHERE draft_picks.league_id = NEW.league_id
        AND draft_picks.id = NEW.draft_pick_id
        AND draft_picks.draft_id = NEW.entry_draft_id
        AND draft_picks.target_season_id = NEW.season_id
        AND draft_picks.current_owner_team_id =
          NEW.owning_team_id
        AND draft_picks.status = 'unused'
        AND entry_drafts.season_id = NEW.season_id
        AND (
          (
            NEW.clock_generation = 1
            AND NEW.prior_clock_id IS NULL
            AND NEW.on_clock_trade_id IS NULL
            AND entry_drafts.status IN ('ready', 'active')
            AND NEW.pick_sequence = 1 + (
              SELECT COUNT(*)
              FROM draft_picks AS sequenced_pick
              WHERE sequenced_pick.league_id =
                  draft_picks.league_id
                AND sequenced_pick.draft_id =
                  draft_picks.draft_id
                AND (
                  sequenced_pick.round_number <
                    draft_picks.round_number
                  OR (
                    sequenced_pick.round_number =
                      draft_picks.round_number
                    AND sequenced_pick.position_number <
                      draft_picks.position_number
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM draft_picks AS earlier_pick
              WHERE earlier_pick.league_id = draft_picks.league_id
                AND earlier_pick.draft_id = draft_picks.draft_id
                AND earlier_pick.status = 'unused'
                AND (
                  earlier_pick.round_number < draft_picks.round_number
                  OR (
                    earlier_pick.round_number = draft_picks.round_number
                    AND earlier_pick.position_number <
                      draft_picks.position_number
                  )
                )
            )
          )
          OR (
            NEW.clock_generation > 1
            AND entry_drafts.status = 'active'
            AND NEW.prior_clock_id IS NOT NULL
            AND NEW.on_clock_trade_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM entry_draft_pick_clocks AS prior_clock
              WHERE prior_clock.league_id = NEW.league_id
                AND prior_clock.id = NEW.prior_clock_id
                AND prior_clock.season_id = NEW.season_id
                AND prior_clock.binding_id = NEW.binding_id
                AND prior_clock.rollover_occurrence_id =
                  NEW.rollover_occurrence_id
                AND prior_clock.rollover_attempt_id =
                  NEW.rollover_attempt_id
                AND prior_clock.season_rollover_id =
                  NEW.season_rollover_id
                AND prior_clock.entry_draft_id =
                  NEW.entry_draft_id
                AND prior_clock.draft_pick_id =
                  NEW.draft_pick_id
                AND prior_clock.owning_team_id <>
                  NEW.owning_team_id
                AND prior_clock.clock_generation + 1 =
                  NEW.clock_generation
                AND prior_clock.pick_sequence =
                  NEW.pick_sequence
                AND prior_clock.status = 'completed'
                AND prior_clock.completed_at_ms =
                  NEW.starts_at_ms
            )
          )
        )
        AND NEW.deadline_at_ms =
          NEW.starts_at_ms + entry_drafts.pick_clock_seconds * 1000
    )
    AND EXISTS (
      SELECT 1
      FROM season_rollover_attempts
      JOIN entry_draft_rollover_bindings
        ON entry_draft_rollover_bindings.league_id =
            season_rollover_attempts.league_id
       AND entry_draft_rollover_bindings.id =
            season_rollover_attempts.binding_id
      WHERE season_rollover_attempts.league_id = NEW.league_id
        AND season_rollover_attempts.id = NEW.rollover_attempt_id
        AND season_rollover_attempts.binding_id = NEW.binding_id
        AND season_rollover_attempts.rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND season_rollover_attempts.entry_draft_id =
          NEW.entry_draft_id
        AND (
          season_rollover_attempts.status = 'started'
          OR season_rollover_attempts.status = 'succeeded'
        )
    )
  ) THEN RAISE(
    ABORT,
    'draft clock must bind the exact unused pick and rollover generation'
  ) END;
END;

CREATE TRIGGER season_rollovers_valid_insert
BEFORE INSERT ON season_rollovers
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
      SELECT 1
      FROM season_rollover_attempts
      WHERE season_rollover_attempts.league_id = NEW.league_id
        AND season_rollover_attempts.id = NEW.rollover_attempt_id
        AND season_rollover_attempts.binding_id = NEW.binding_id
        AND season_rollover_attempts.rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND season_rollover_attempts.entry_draft_id =
          NEW.entry_draft_id
        AND season_rollover_attempts.from_season_id =
          NEW.from_season_id
        AND season_rollover_attempts.to_season_id =
          NEW.to_season_id
        AND season_rollover_attempts.target_schedule_id =
          NEW.target_schedule_id
        AND season_rollover_attempts.target_schedule_version =
          NEW.target_schedule_version
        AND season_rollover_attempts.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND season_rollover_attempts.week_one_starts_at_ms =
          NEW.week_one_starts_at_ms
        AND season_rollover_attempts.scheduled_starts_at_ms =
          NEW.entry_draft_scheduled_starts_at_ms
        AND season_rollover_attempts.occurrence_key =
          NEW.occurrence_key
        AND season_rollover_attempts.trigger_kind =
          NEW.execution_trigger
        AND season_rollover_attempts.scheduled_job_run_id IS
          NEW.scheduled_job_run_id
        AND season_rollover_attempts.retry_idempotency_request_id IS
          NEW.idempotency_request_id
        AND season_rollover_attempts.status = 'started'
    )
    AND EXISTS (
      SELECT 1
      FROM entry_draft_rollover_bindings AS binding
      JOIN season_rollover_occurrences AS occurrence
        ON occurrence.league_id = binding.league_id
       AND occurrence.binding_id = binding.id
      WHERE binding.league_id = NEW.league_id
        AND binding.id = NEW.binding_id
        AND binding.entry_draft_id = NEW.entry_draft_id
        AND binding.from_season_id = NEW.from_season_id
        AND binding.to_season_id = NEW.to_season_id
        AND binding.current_rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND binding.target_schedule_id = NEW.target_schedule_id
        AND binding.target_schedule_version =
          NEW.target_schedule_version
        AND binding.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND binding.week_one_starts_at_ms =
          NEW.week_one_starts_at_ms
        AND binding.scheduled_starts_at_ms =
          NEW.entry_draft_scheduled_starts_at_ms
        AND binding.current_occurrence_key = NEW.occurrence_key
        AND binding.status IN ('scheduled', 'blocked')
        AND binding.selection_gate_status = 'locked'
        AND binding.trading_gate_status = 'locked'
        AND occurrence.id = NEW.rollover_occurrence_id
        AND occurrence.entry_draft_id = NEW.entry_draft_id
        AND occurrence.from_season_id = NEW.from_season_id
        AND occurrence.to_season_id = NEW.to_season_id
        AND occurrence.target_schedule_id = NEW.target_schedule_id
        AND occurrence.target_schedule_version =
          NEW.target_schedule_version
        AND occurrence.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND occurrence.week_one_starts_at_ms =
          NEW.week_one_starts_at_ms
        AND occurrence.scheduled_starts_at_ms =
          NEW.entry_draft_scheduled_starts_at_ms
        AND occurrence.occurrence_key = NEW.occurrence_key
        AND occurrence.scheduled_by_user_id =
          NEW.entry_draft_scheduled_by_user_id
        AND occurrence.scheduled_by_membership_id =
          NEW.entry_draft_scheduled_by_membership_id
        AND occurrence.scheduled_by_authority =
          NEW.entry_draft_scheduled_by_authority
        AND occurrence.status IN ('scheduled', 'blocked')
    )
    AND (
      (
        NEW.execution_trigger = 'scheduled_job'
        AND NEW.executed_authority = 'system'
        AND EXISTS (
          SELECT 1
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.id = NEW.scheduled_job_run_id
            AND job_runs.season_id = NEW.to_season_id
            AND job_runs.job_type =
              'league:entry_draft_rollover'
            AND job_runs.occurrence_key = NEW.occurrence_key
            AND job_runs.scheduled_for_ms =
              NEW.entry_draft_scheduled_starts_at_ms
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_token IS NOT NULL
        )
      )
      OR (
        NEW.execution_trigger = 'commissioner_retry'
        AND EXISTS (
          SELECT 1
          FROM season_rollover_attempts
          JOIN idempotency_requests
            ON idempotency_requests.league_id =
                season_rollover_attempts.league_id
           AND idempotency_requests.id =
                season_rollover_attempts.retry_idempotency_request_id
          WHERE season_rollover_attempts.league_id = NEW.league_id
            AND season_rollover_attempts.id =
              NEW.rollover_attempt_id
            AND season_rollover_attempts.retry_by_user_id =
              NEW.executed_by_user_id
            AND season_rollover_attempts.retry_by_membership_id =
              NEW.executed_by_membership_id
            AND season_rollover_attempts.retry_authority =
              NEW.executed_authority
            AND idempotency_requests.id =
              NEW.idempotency_request_id
            AND idempotency_requests.actor_user_id =
              NEW.executed_by_user_id
            AND idempotency_requests.operation =
              'league.lifecycle.transition.v2'
            AND idempotency_requests.status = 'started'
        )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM leagues
      WHERE leagues.id = NEW.league_id
        AND leagues.current_season_id = NEW.to_season_id
        AND leagues.version = NEW.league_version_after
        AND leagues.updated_at_ms = NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM seasons AS source_season
      WHERE source_season.league_id = NEW.league_id
        AND source_season.id = NEW.from_season_id
        AND source_season.status = 'completed'
        AND source_season.label = NEW.from_season_label
        AND source_season.nhl_season_key =
          NEW.from_nhl_season_key
        AND source_season.version =
          NEW.from_season_version_after
        AND source_season.updated_at_ms = NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM seasons AS target_season
      WHERE target_season.league_id = NEW.league_id
        AND target_season.id = NEW.to_season_id
        AND target_season.status = 'active'
        AND target_season.free_agent_draft_completed_at_ms IS NULL
        AND target_season.label = NEW.to_season_label
        AND target_season.nhl_season_key =
          NEW.target_nhl_season_key
        AND target_season.regular_season_starts_at_ms =
          NEW.nhl_regular_season_starts_at_ms
        AND target_season.regular_season_ends_at_ms =
          NEW.nhl_regular_season_ends_at_ms
        AND target_season.fantasy_playoffs_start_at_ms =
          NEW.fantasy_playoffs_start_at_ms
        AND target_season.fantasy_playoffs_end_at_ms =
          NEW.fantasy_playoffs_end_at_ms
        AND target_season.version =
          NEW.to_season_version_after
        AND target_season.updated_at_ms = NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM entry_drafts
      WHERE entry_drafts.league_id = NEW.league_id
        AND entry_drafts.id = NEW.entry_draft_id
        AND entry_drafts.season_id = NEW.to_season_id
        AND entry_drafts.status = 'ready'
        AND entry_drafts.starts_at_ms =
          NEW.entry_draft_scheduled_starts_at_ms
        AND entry_drafts.version =
          NEW.entry_draft_version_before
    )
    AND EXISTS (
      SELECT 1
      FROM season_matchup_schedule_generations
      WHERE season_matchup_schedule_generations.league_id =
          NEW.league_id
        AND season_matchup_schedule_generations.season_id =
          NEW.to_season_id
        AND season_matchup_schedule_generations.schedule_operation_id =
          NEW.target_schedule_id
        AND season_matchup_schedule_generations.schedule_version =
          NEW.target_schedule_version
        AND season_matchup_schedule_generations.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND season_matchup_schedule_generations.week_one_starts_at_ms =
          NEW.week_one_starts_at_ms
        AND season_matchup_schedule_generations.status = 'current'
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.from_season_id
        AND free_agent_drafts.id = NEW.source_fad_id
        AND free_agent_drafts.status = 'completed'
        AND free_agent_drafts.completed_at_ms IS NOT NULL
        AND free_agent_drafts.completed_at_ms <= NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM standings_snapshot_finalizations AS finalization_root
      WHERE finalization_root.league_id = NEW.league_id
        AND finalization_root.season_id = NEW.from_season_id
        AND finalization_root.id =
          NEW.source_finalization_root_id
        AND finalization_root.replaces_finalization_id IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM standings_snapshot_finalizations AS finalization
      JOIN standings_snapshots
        ON standings_snapshots.league_id =
            finalization.league_id
       AND standings_snapshots.id =
            finalization.standings_snapshot_id
      JOIN standings_operations
        ON standings_operations.league_id =
            finalization.league_id
       AND standings_operations.id =
            finalization.standings_operation_id
      WHERE finalization.league_id = NEW.league_id
        AND finalization.season_id = NEW.from_season_id
        AND finalization.id = NEW.source_finalization_id
        AND finalization.status = 'final'
        AND finalization.standings_snapshot_id =
          NEW.source_standings_snapshot_id
        AND finalization.standings_operation_id =
          NEW.source_standings_operation_id
        AND standings_snapshots.season_id = NEW.from_season_id
        AND standings_snapshots.status = 'final'
        AND standings_operations.season_id = NEW.from_season_id
        AND standings_operations.status = 'succeeded'
    )
    AND json_extract(
      NEW.source_readiness_json,
      '$.leagueId'
    ) = NEW.league_id
    AND json_extract(
      NEW.source_readiness_json,
      '$.fromSeasonId'
    ) = NEW.from_season_id
    AND json_extract(
      NEW.source_readiness_json,
      '$.sourceFadId'
    ) = NEW.source_fad_id
    AND json_extract(
      NEW.source_readiness_json,
      '$.sourceFinalizationRootId'
    ) = NEW.source_finalization_root_id
    AND json_extract(
      NEW.source_readiness_json,
      '$.sourceFinalizationId'
    ) = NEW.source_finalization_id
    AND json_extract(
      NEW.source_readiness_json,
      '$.sourceStandingsSnapshotId'
    ) = NEW.source_standings_snapshot_id
    AND json_extract(
      NEW.source_readiness_json,
      '$.sourceStandingsOperationId'
    ) = NEW.source_standings_operation_id
    AND EXISTS (
      SELECT 1
      FROM league_activity
      WHERE league_activity.league_id = NEW.league_id
        AND league_activity.id = NEW.aggregate_activity_id
        AND league_activity.season_id = NEW.to_season_id
        AND league_activity.event_type = 'season_rolled_over'
        AND league_activity.related_type = 'season'
        AND league_activity.related_id = NEW.to_season_id
        AND league_activity.actor_user_id IS
          NEW.executed_by_user_id
        AND league_activity.actor_authority =
          NEW.executed_authority
        AND league_activity.occurred_at_ms =
          NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM security_audit_events
      WHERE security_audit_events.id =
          NEW.security_audit_event_id
        AND security_audit_events.league_id = NEW.league_id
        AND security_audit_events.event_type =
          'league.season_rolled_over'
        AND security_audit_events.outcome = 'success'
        AND security_audit_events.actor_user_id IS
          NEW.executed_by_user_id
        AND security_audit_events.target_user_id IS NULL
        AND security_audit_events.occurred_at_ms =
          NEW.completed_at_ms
        AND security_audit_events.reason_code = CASE
          WHEN NEW.execution_trigger = 'scheduled_job'
          THEN 'scheduled_entry_draft_rollover'
          ELSE 'season_rollover_retry_authorized'
        END
    )
    AND EXISTS (
      SELECT 1
      FROM outbox_events
      WHERE outbox_events.league_id = NEW.league_id
        AND outbox_events.id = NEW.outbox_event_id
        AND outbox_events.event_type = 'league.changed'
        AND outbox_events.aggregate_type = 'league'
        AND outbox_events.aggregate_id = NEW.league_id
        AND outbox_events.created_at_ms = NEW.completed_at_ms
    )
    AND (
      SELECT COUNT(*)
      FROM outbox_event_audiences
      WHERE outbox_event_audiences.league_id = NEW.league_id
        AND outbox_event_audiences.outbox_event_id =
          NEW.outbox_event_id
        AND outbox_event_audiences.audience_kind = 'league'
    ) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM outbox_event_audiences
      WHERE outbox_event_audiences.league_id = NEW.league_id
        AND outbox_event_audiences.outbox_event_id =
          NEW.outbox_event_id
        AND outbox_event_audiences.audience_kind <> 'league'
    )
    AND EXISTS (
      SELECT 1
      FROM entry_draft_pick_clocks
      WHERE entry_draft_pick_clocks.league_id = NEW.league_id
        AND entry_draft_pick_clocks.id = NEW.first_pick_clock_id
        AND entry_draft_pick_clocks.binding_id = NEW.binding_id
        AND entry_draft_pick_clocks.rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND entry_draft_pick_clocks.rollover_attempt_id =
          NEW.rollover_attempt_id
        AND entry_draft_pick_clocks.season_rollover_id = NEW.id
        AND entry_draft_pick_clocks.entry_draft_id = NEW.entry_draft_id
        AND entry_draft_pick_clocks.clock_generation = 1
        AND entry_draft_pick_clocks.pick_sequence = 1
        AND entry_draft_pick_clocks.status = 'prepared'
        AND entry_draft_pick_clocks.starts_at_ms = NEW.completed_at_ms
    )
    AND (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.binding_id = NEW.binding_id
        AND season_rollover_items.rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND season_rollover_items.rollover_attempt_id =
          NEW.rollover_attempt_id
    ) =
      NEW.contracts_advanced
      + NEW.contracts_expired
      + NEW.ownerships_carried
      + NEW.ownerships_released
      + NEW.retention_years_advanced
      + NEW.retention_obligations_completed
      + NEW.buyout_years_advanced
      + NEW.buyout_obligations_completed
      + NEW.trades_cancelled
  ) THEN RAISE(
    ABORT,
    'season rollover requires its exact attempt, first clock, and item manifest'
  ) END;

  SELECT CASE WHEN
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'contract_advanced') <>
      NEW.contracts_advanced
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'contract_expired') <>
      NEW.contracts_expired
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'ownership_carried') <>
      NEW.ownerships_carried
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'ownership_released') <>
      NEW.ownerships_released
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'retention_year_advanced') <>
      NEW.retention_years_advanced
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'retention_obligation_completed') <>
      NEW.retention_obligations_completed
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'buyout_year_advanced') <>
      NEW.buyout_years_advanced
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'buyout_obligation_completed') <>
      NEW.buyout_obligations_completed
    OR
    (SELECT COUNT(*) FROM season_rollover_items
      WHERE league_id = NEW.league_id
        AND rollover_id = NEW.id
        AND effect_kind = 'trade_cancelled') <>
      NEW.trades_cancelled
  THEN RAISE(
    ABORT,
    'season rollover summary must equal its normalized manifest'
  ) END;
END;

CREATE TRIGGER season_rollover_items_valid_insert
BEFORE INSERT ON season_rollover_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM season_rollover_attempts
    WHERE season_rollover_attempts.league_id = NEW.league_id
      AND season_rollover_attempts.id = NEW.rollover_attempt_id
      AND season_rollover_attempts.binding_id = NEW.binding_id
      AND season_rollover_attempts.rollover_occurrence_id =
        NEW.rollover_occurrence_id
      AND season_rollover_attempts.from_season_id =
        NEW.from_season_id
      AND season_rollover_attempts.to_season_id =
        NEW.to_season_id
      AND season_rollover_attempts.retry_idempotency_request_id IS
        NEW.idempotency_request_id
      AND season_rollover_attempts.status = 'started'
  ) THEN RAISE(
    ABORT,
    'rollover item requires its exact started attempt'
  ) END;
END;

CREATE TRIGGER entry_drafts_rollover_gate_update
BEFORE UPDATE OF status ON entry_drafts
WHEN NEW.status = 'active'
  AND OLD.status <> 'active'
  AND EXISTS (
    SELECT 1
    FROM entry_draft_rollover_bindings
    WHERE entry_draft_rollover_bindings.league_id = NEW.league_id
      AND entry_draft_rollover_bindings.entry_draft_id = NEW.id
  )
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'ready'
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM entry_draft_rollover_bindings
      JOIN season_rollovers
        ON season_rollovers.league_id =
            entry_draft_rollover_bindings.league_id
       AND season_rollovers.id =
            entry_draft_rollover_bindings.successful_rollover_id
      JOIN entry_draft_pick_clocks
        ON entry_draft_pick_clocks.league_id =
            season_rollovers.league_id
       AND entry_draft_pick_clocks.id =
            season_rollovers.first_pick_clock_id
      WHERE entry_draft_rollover_bindings.league_id = NEW.league_id
        AND entry_draft_rollover_bindings.entry_draft_id = NEW.id
        AND entry_draft_rollover_bindings.status = 'succeeded'
        AND entry_draft_rollover_bindings.selection_gate_status = 'open'
        AND entry_draft_rollover_bindings.trading_gate_status = 'open'
        AND season_rollovers.entry_draft_version_before = OLD.version
        AND season_rollovers.entry_draft_version_after = NEW.version
        AND entry_draft_pick_clocks.status = 'prepared'
        AND entry_draft_pick_clocks.clock_generation = 1
        AND entry_draft_pick_clocks.pick_sequence = 1
    )
  ) THEN RAISE(
    ABORT,
    'Entry Draft cannot become active before rollover and first clock commit'
  ) END;
END;

CREATE TRIGGER entry_drafts_start_first_pick_clock
AFTER UPDATE OF status ON entry_drafts
WHEN OLD.status = 'ready' AND NEW.status = 'active'
BEGIN
  UPDATE entry_draft_pick_clocks
  SET status = 'running',
      updated_at_ms = NEW.updated_at_ms,
      version = version + 1
  WHERE league_id = NEW.league_id
    AND entry_draft_id = NEW.id
    AND status = 'prepared'
    AND clock_generation = 1;
END;

CREATE TRIGGER entry_draft_pick_clocks_forward_update
BEFORE UPDATE ON entry_draft_pick_clocks
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.binding_id IS OLD.binding_id
    AND NEW.rollover_occurrence_id IS OLD.rollover_occurrence_id
    AND NEW.rollover_attempt_id IS OLD.rollover_attempt_id
    AND NEW.season_rollover_id IS OLD.season_rollover_id
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.draft_pick_id IS OLD.draft_pick_id
    AND NEW.owning_team_id IS OLD.owning_team_id
    AND NEW.clock_generation IS OLD.clock_generation
    AND NEW.prior_clock_id IS OLD.prior_clock_id
    AND NEW.on_clock_trade_id IS OLD.on_clock_trade_id
    AND NEW.pick_sequence IS OLD.pick_sequence
    AND NEW.starts_at_ms IS OLD.starts_at_ms
    AND NEW.deadline_at_ms IS OLD.deadline_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'prepared'
        AND NEW.status = 'running'
        AND NEW.completed_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM entry_drafts
          WHERE entry_drafts.league_id = NEW.league_id
            AND entry_drafts.id = NEW.entry_draft_id
            AND entry_drafts.status = 'active'
        )
      )
      OR (
        OLD.status = 'running'
        AND NEW.status = 'completed'
        AND NEW.completed_at_ms = NEW.updated_at_ms
      )
    )
  ) THEN RAISE(
    ABORT,
    'draft clock may only start once or complete once'
  ) END;
END;

CREATE TRIGGER entry_draft_on_clock_trades_valid_insert
BEFORE INSERT ON entry_draft_on_clock_trades
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
      SELECT 1
      FROM draft_picks
      WHERE draft_picks.league_id = NEW.league_id
        AND draft_picks.id = NEW.draft_pick_id
        AND draft_picks.draft_id = NEW.entry_draft_id
        AND draft_picks.target_season_id = NEW.season_id
    )
    AND EXISTS (
      SELECT 1
      FROM trades
      WHERE trades.league_id = NEW.league_id
        AND trades.id = NEW.completed_trade_id
        AND trades.season_id = NEW.season_id
        AND trades.status = 'completed'
        AND trades.completed_at_ms = NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM draft_pick_ownership_events
      WHERE draft_pick_ownership_events.league_id = NEW.league_id
        AND draft_pick_ownership_events.id =
          NEW.draft_pick_ownership_event_id
        AND draft_pick_ownership_events.draft_pick_id =
          NEW.draft_pick_id
        AND draft_pick_ownership_events.trade_id =
          NEW.completed_trade_id
        AND draft_pick_ownership_events.to_team_id =
          NEW.new_owning_team_id
        AND draft_pick_ownership_events.occurred_at_ms =
          NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM entry_draft_pick_clocks AS prior_clock
      JOIN entry_draft_pick_clocks AS fresh_clock
        ON fresh_clock.league_id = prior_clock.league_id
       AND fresh_clock.entry_draft_id = prior_clock.entry_draft_id
      WHERE prior_clock.league_id = NEW.league_id
        AND prior_clock.id = NEW.prior_clock_id
        AND prior_clock.entry_draft_id = NEW.entry_draft_id
        AND prior_clock.draft_pick_id = NEW.draft_pick_id
        AND prior_clock.owning_team_id <>
          NEW.new_owning_team_id
        AND prior_clock.clock_generation =
          NEW.prior_clock_generation
        AND prior_clock.status = 'completed'
        AND prior_clock.completed_at_ms = NEW.completed_at_ms
        AND prior_clock.on_clock_trade_id IS NULL
        AND fresh_clock.id = NEW.fresh_clock_id
        AND fresh_clock.draft_pick_id = NEW.draft_pick_id
        AND fresh_clock.owning_team_id =
          NEW.new_owning_team_id
        AND fresh_clock.binding_id = prior_clock.binding_id
        AND fresh_clock.rollover_occurrence_id =
          prior_clock.rollover_occurrence_id
        AND fresh_clock.rollover_attempt_id =
          prior_clock.rollover_attempt_id
        AND fresh_clock.season_rollover_id =
          prior_clock.season_rollover_id
        AND fresh_clock.clock_generation =
          NEW.fresh_clock_generation
        AND fresh_clock.prior_clock_id = prior_clock.id
        AND fresh_clock.on_clock_trade_id = NEW.id
        AND fresh_clock.pick_sequence =
          prior_clock.pick_sequence
        AND fresh_clock.status IN ('prepared', 'running')
        AND fresh_clock.starts_at_ms = NEW.completed_at_ms
        AND EXISTS (
          SELECT 1
          FROM draft_picks AS current_pick
          WHERE current_pick.league_id = NEW.league_id
            AND current_pick.id = NEW.draft_pick_id
            AND current_pick.current_owner_team_id =
              NEW.new_owning_team_id
        )
    )
  ) THEN RAISE(
    ABORT,
    'on-clock trade requires one completed trade and fresh full clock'
  ) END;
END;

-- Automatic readiness, card legality, and FAD lifecycle constraints.

CREATE TRIGGER free_agent_draft_readiness_blockers_insert
BEFORE INSERT ON free_agent_draft_readiness_operations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.blockers_json) AS blocker
    WHERE blocker.type <> 'object'
      OR (
        SELECT COUNT(*)
        FROM json_each(blocker.value)
      ) <> 5
      OR EXISTS (
        SELECT 1
        FROM json_each(blocker.value) AS member
        WHERE member.key NOT IN (
          'code',
          'field',
          'resourceType',
          'resourceId',
          'message'
        )
      )
      OR json_type(blocker.value, '$.code') <> 'text'
      OR json_type(blocker.value, '$.message') <> 'text'
      OR json_type(blocker.value, '$.field') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceType') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceId') NOT IN ('text', 'null')
  ) THEN RAISE(
    ABORT,
    'readiness blockers require the canonical safe object shape'
  ) END;
END;

CREATE TRIGGER free_agent_draft_readiness_operations_forward_update
BEFORE UPDATE ON free_agent_draft_readiness_operations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.blockers_json) AS blocker
    WHERE blocker.type <> 'object'
      OR (
        SELECT COUNT(*)
        FROM json_each(blocker.value)
      ) <> 5
      OR EXISTS (
        SELECT 1
        FROM json_each(blocker.value) AS member
        WHERE member.key NOT IN (
          'code',
          'field',
          'resourceType',
          'resourceId',
          'message'
        )
      )
      OR json_type(blocker.value, '$.code') <> 'text'
      OR json_type(blocker.value, '$.message') <> 'text'
      OR json_type(blocker.value, '$.field') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceType') NOT IN ('text', 'null')
      OR json_type(blocker.value, '$.resourceId') NOT IN ('text', 'null')
  ) THEN RAISE(
    ABORT,
    'readiness blockers require the canonical safe object shape'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.readiness_occurrence_key IS OLD.readiness_occurrence_key
    AND NEW.trigger_kind IS OLD.trigger_kind
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.setup_exemption_id IS OLD.setup_exemption_id
    AND NEW.job_run_id IS OLD.job_run_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status IN ('pending', 'blocked')
        AND NEW.status = 'running'
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.started_at_ms IS NOT NULL
        AND NEW.blockers_json = '[]'
        AND NEW.created_fad_id IS NULL
        AND NEW.terminal_at_ms IS NULL
      )
      OR (
        OLD.status = 'running'
        AND NEW.status = 'blocked'
        AND NEW.attempt_count = OLD.attempt_count
        AND json_array_length(NEW.blockers_json) >= 1
        AND NEW.created_fad_id IS NULL
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
      )
      OR (
        OLD.status = 'running'
        AND NEW.status = 'succeeded'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.blockers_json = '[]'
        AND NEW.created_fad_id IS NOT NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND (
          NEW.schedule_recovery_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_schedule_recoveries
            WHERE free_agent_draft_schedule_recoveries.league_id =
                NEW.league_id
              AND free_agent_draft_schedule_recoveries.season_id =
                NEW.season_id
              AND free_agent_draft_schedule_recoveries.fad_id =
                NEW.created_fad_id
              AND free_agent_draft_schedule_recoveries.id =
                NEW.schedule_recovery_id
              AND free_agent_draft_schedule_recoveries.recovery_kind =
                'pre_open'
              AND free_agent_draft_schedule_recoveries.old_schedule_version =
                NEW.matchup_schedule_version_before
              AND free_agent_draft_schedule_recoveries.new_schedule_version =
                NEW.matchup_schedule_version_after
          )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.created_fad_id
            AND free_agent_drafts.readiness_operation_id = NEW.id
            AND free_agent_drafts.readiness_occurrence_key =
              NEW.readiness_occurrence_key
            AND (
              SELECT COUNT(*)
              FROM free_agent_draft_teams
              WHERE free_agent_draft_teams.league_id = NEW.league_id
                AND free_agent_draft_teams.fad_id = NEW.created_fad_id
            ) = free_agent_drafts.participating_team_count
            AND (
              SELECT COUNT(*)
              FROM candidate_cards
              WHERE candidate_cards.league_id = NEW.league_id
                AND candidate_cards.fad_id = NEW.created_fad_id
            ) = free_agent_drafts.participating_team_count
            AND (
              SELECT COUNT(*)
              FROM free_agent_draft_rollovers
              WHERE free_agent_draft_rollovers.league_id = NEW.league_id
                AND free_agent_draft_rollovers.fad_id = NEW.created_fad_id
                AND free_agent_draft_rollovers.window_kind = 'initial'
                AND free_agent_draft_rollovers.sequence BETWEEN 1 AND 7
            ) = 7
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          JOIN job_runs AS reminder_job
            ON reminder_job.league_id =
                free_agent_drafts.league_id
           AND reminder_job.id = NEW.reminder_job_run_id
          JOIN job_runs AS deadline_job
            ON deadline_job.league_id =
                free_agent_drafts.league_id
           AND deadline_job.id = NEW.deadline_job_run_id
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.id = NEW.created_fad_id
            AND reminder_job.season_id = NEW.season_id
            AND reminder_job.job_type =
              'fad_deadline_reminder'
            AND reminder_job.occurrence_key =
              'fad:' || NEW.created_fad_id || ':reminder:' ||
                (
                  free_agent_drafts.candidate_deadline_at_ms -
                    259200000
                )
            AND reminder_job.scheduled_for_ms =
              free_agent_drafts.candidate_deadline_at_ms -
                259200000
            AND reminder_job.status = 'pending'
            AND reminder_job.attempt_count = 0
            AND reminder_job.lease_owner IS NULL
            AND reminder_job.lease_token IS NULL
            AND reminder_job.started_at_ms IS NULL
            AND reminder_job.completed_at_ms IS NULL
            AND deadline_job.season_id = NEW.season_id
            AND deadline_job.job_type = 'fad_deadline'
            AND deadline_job.occurrence_key =
              'fad:' || NEW.created_fad_id || ':deadline:' ||
                free_agent_drafts.candidate_deadline_at_ms
            AND deadline_job.scheduled_for_ms =
              free_agent_drafts.candidate_deadline_at_ms
            AND deadline_job.status = 'pending'
            AND deadline_job.attempt_count = 0
            AND deadline_job.lease_owner IS NULL
            AND deadline_job.lease_token IS NULL
            AND deadline_job.started_at_ms IS NULL
            AND deadline_job.completed_at_ms IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers
          WHERE free_agent_draft_rollovers.league_id =
              NEW.league_id
            AND free_agent_draft_rollovers.fad_id =
              NEW.created_fad_id
            AND (
              SELECT COUNT(*)
              FROM job_runs
              WHERE job_runs.league_id = NEW.league_id
                AND job_runs.season_id = NEW.season_id
                AND job_runs.job_type = 'fad_rollover'
                AND job_runs.occurrence_key =
                  'fad:' || NEW.created_fad_id ||
                    ':rollover:' ||
                    free_agent_draft_rollovers.sequence ||
                    ':' ||
                    free_agent_draft_rollovers
                      .rolls_over_at_ms
                AND job_runs.scheduled_for_ms =
                  free_agent_draft_rollovers
                    .rolls_over_at_ms
                AND job_runs.status = 'pending'
                AND job_runs.attempt_count = 0
                AND job_runs.lease_owner IS NULL
                AND job_runs.lease_token IS NULL
                AND job_runs.started_at_ms IS NULL
                AND job_runs.completed_at_ms IS NULL
            ) <> 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM player_ownerships
          JOIN contracts
            ON contracts.league_id =
                player_ownerships.league_id
           AND contracts.player_id =
                player_ownerships.player_id
           AND contracts.current_team_id =
                player_ownerships.team_id
           AND contracts.status = 'active'
          JOIN contract_years
            ON contract_years.league_id = contracts.league_id
           AND contract_years.contract_id = contracts.id
           AND contract_years.season_id =
                player_ownerships.season_id
           AND contract_years.status = 'current'
          WHERE player_ownerships.league_id = NEW.league_id
            AND player_ownerships.season_id = NEW.season_id
            AND player_ownerships.ownership_kind = 'Rostered'
            AND player_ownerships.roster_category IN (
              'Active',
              'Bench',
              'Injured Reserve'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM candidate_card_entries
              WHERE candidate_card_entries.league_id =
                  player_ownerships.league_id
                AND candidate_card_entries.season_id =
                  player_ownerships.season_id
                AND candidate_card_entries.fad_id =
                  NEW.created_fad_id
                AND candidate_card_entries.team_id =
                  player_ownerships.team_id
                AND candidate_card_entries.player_id =
                  player_ownerships.player_id
                AND candidate_card_entries.entry_kind =
                  'carryover'
                AND candidate_card_entries.carryover_ownership_id =
                  player_ownerships.id
                AND candidate_card_entries.carryover_contract_id =
                  contracts.id
                AND candidate_card_entries.source_roster_category =
                  player_ownerships.roster_category
                AND candidate_card_entries
                  .carryover_original_total_value_cents =
                    contracts.original_total_value_cents
                AND candidate_card_entries
                  .carryover_original_term_years =
                    contracts.original_term_years
                AND candidate_card_entries.carryover_aav_cents =
                  contracts.aav_cents
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_entries
          WHERE candidate_card_entries.league_id = NEW.league_id
            AND candidate_card_entries.season_id = NEW.season_id
            AND candidate_card_entries.fad_id =
              NEW.created_fad_id
            AND candidate_card_entries.entry_kind = 'carryover'
            AND NOT EXISTS (
              SELECT 1
              FROM player_ownerships
              JOIN contracts
                ON contracts.league_id =
                    player_ownerships.league_id
               AND contracts.id =
                    candidate_card_entries.carryover_contract_id
               AND contracts.player_id =
                    player_ownerships.player_id
               AND contracts.current_team_id =
                    player_ownerships.team_id
               AND contracts.status = 'active'
              JOIN contract_years
                ON contract_years.league_id = contracts.league_id
               AND contract_years.contract_id = contracts.id
               AND contract_years.season_id =
                    player_ownerships.season_id
               AND contract_years.status = 'current'
              WHERE player_ownerships.league_id =
                  candidate_card_entries.league_id
                AND player_ownerships.season_id =
                  candidate_card_entries.season_id
                AND player_ownerships.id =
                  candidate_card_entries.carryover_ownership_id
                AND player_ownerships.team_id =
                  candidate_card_entries.team_id
                AND player_ownerships.player_id =
                  candidate_card_entries.player_id
                AND player_ownerships.ownership_kind = 'Rostered'
                AND player_ownerships.roster_category IN (
                  'Active',
                  'Bench',
                  'Injured Reserve'
                )
            )
        )
        AND EXISTS (
          SELECT 1
          FROM league_activity
          WHERE league_activity.league_id = NEW.league_id
            AND league_activity.season_id = NEW.season_id
            AND league_activity.id =
              NEW.cards_opened_activity_id
            AND league_activity.event_type = 'free_agent_draft_started'
            AND league_activity.actor_user_id IS NULL
            AND league_activity.actor_authority = 'system'
            AND league_activity.related_type =
              'free_agent_draft'
            AND league_activity.related_id =
              NEW.created_fad_id
            AND league_activity.occurred_at_ms =
              NEW.terminal_at_ms
        )
        AND EXISTS (
          SELECT 1
          FROM outbox_events
          WHERE outbox_events.league_id = NEW.league_id
            AND outbox_events.id =
              NEW.cards_opened_outbox_event_id
            AND outbox_events.event_type = 'fad_cards_opened'
            AND outbox_events.aggregate_type =
              'free_agent_draft'
            AND outbox_events.aggregate_id =
              NEW.created_fad_id
            AND outbox_events.created_at_ms =
              NEW.terminal_at_ms
            AND EXISTS (
              SELECT 1
              FROM outbox_event_audiences
              WHERE outbox_event_audiences.league_id =
                  outbox_events.league_id
                AND outbox_event_audiences.outbox_event_id =
                  outbox_events.id
                AND outbox_event_audiences.audience_kind =
                  'league'
                AND outbox_event_audiences.created_at_ms =
                  NEW.terminal_at_ms
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_teams
          JOIN team_manager_assignments
            ON team_manager_assignments.league_id =
                free_agent_draft_teams.league_id
           AND team_manager_assignments.team_id =
                free_agent_draft_teams.team_id
          JOIN league_memberships
            ON league_memberships.league_id =
                team_manager_assignments.league_id
           AND league_memberships.id =
                team_manager_assignments.membership_id
           AND league_memberships.user_id =
                team_manager_assignments.user_id
          WHERE free_agent_draft_teams.league_id =
              NEW.league_id
            AND free_agent_draft_teams.fad_id =
              NEW.created_fad_id
            AND team_manager_assignments.status = 'accepted'
            AND team_manager_assignments.ended_at_ms IS NULL
            AND league_memberships.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM notifications
              WHERE notifications.league_id = NEW.league_id
                AND notifications.user_id =
                  team_manager_assignments.user_id
                AND notifications.event_type =
                  'fad_cards_opened'
                AND notifications.related_feature =
                  'free_agent_draft'
                AND notifications.related_record_id =
                  NEW.created_fad_id
                AND notifications.created_at_ms =
                  NEW.terminal_at_ms
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD readiness must open every team and seven windows or none'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_valid_insert
BEFORE INSERT ON free_agent_drafts
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'cards_open'
    AND NEW.opening_authority = 'system'
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.opened_at_ms
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_readiness_operations
      WHERE free_agent_draft_readiness_operations.league_id =
          NEW.league_id
        AND free_agent_draft_readiness_operations.season_id =
          NEW.season_id
        AND free_agent_draft_readiness_operations.id =
          NEW.readiness_operation_id
        AND free_agent_draft_readiness_operations.readiness_occurrence_key =
          NEW.readiness_occurrence_key
        AND free_agent_draft_readiness_operations.status = 'running'
        AND free_agent_draft_readiness_operations.created_fad_id IS NULL
        AND (
          (
            NEW.setup_path = 'completed_entry_draft'
            AND free_agent_draft_readiness_operations.trigger_kind =
              'entry_draft_completed'
            AND free_agent_draft_readiness_operations.entry_draft_id =
              NEW.entry_draft_id
          )
          OR (
            NEW.setup_path = 'no_draft_inaugural'
            AND free_agent_draft_readiness_operations.trigger_kind =
              'no_draft_inaugural'
          )
          OR (
            NEW.setup_path = 'no_draft_initial_season2'
            AND free_agent_draft_readiness_operations.trigger_kind =
              'no_draft_initial_season2'
            AND free_agent_draft_readiness_operations.setup_exemption_id =
              NEW.setup_exemption_id
          )
        )
    )
    AND EXISTS (
      SELECT 1
      FROM seasons
      JOIN leagues
        ON leagues.id = seasons.league_id
      WHERE seasons.league_id = NEW.league_id
        AND seasons.id = NEW.season_id
        AND seasons.status = 'active'
        AND seasons.free_agent_draft_completed_at_ms IS NULL
        AND leagues.current_season_id = NEW.season_id
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_weeks
      WHERE matchup_weeks.league_id = NEW.league_id
        AND matchup_weeks.season_id = NEW.season_id
        AND matchup_weeks.id = NEW.first_matchup_week_id
        AND matchup_weeks.sequence = 1
        AND matchup_weeks.starts_at_ms =
          NEW.first_matchup_starts_at_ms
    )
    AND NEW.current_competition_first_matchup_week_id =
      NEW.first_matchup_week_id
    AND NEW.schedule_recovery_id IS NULL
    AND NEW.participating_team_count = (
      SELECT COUNT(*)
      FROM teams
      WHERE teams.league_id = NEW.league_id
        AND teams.status = 'active'
    )
    AND NOT EXISTS (
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
          WHERE team_manager_assignments.league_id = NEW.league_id
            AND team_manager_assignments.team_id = teams.id
            AND team_manager_assignments.status = 'accepted'
            AND team_manager_assignments.ended_at_ms IS NULL
            AND league_memberships.status = 'active'
        )
    )
  ) THEN RAISE(
    ABORT,
    'FAD may only open through automatic all-team readiness'
  ) END;

  SELECT CASE WHEN
    NEW.setup_path = 'completed_entry_draft'
    AND NOT (
      EXISTS (
        SELECT 1
        FROM entry_drafts
        WHERE entry_drafts.league_id = NEW.league_id
          AND entry_drafts.season_id = NEW.season_id
          AND entry_drafts.id = NEW.entry_draft_id
          AND entry_drafts.status = 'completed'
          AND entry_drafts.completed_at_ms IS NOT NULL
          AND entry_drafts.completed_at_ms <= NEW.opened_at_ms
      )
      AND EXISTS (
        SELECT 1
        FROM season_rollovers
        WHERE season_rollovers.league_id = NEW.league_id
          AND season_rollovers.id =
            NEW.prior_season_rollover_id
          AND season_rollovers.entry_draft_id =
            NEW.entry_draft_id
          AND season_rollovers.to_season_id = NEW.season_id
          AND season_rollovers.status = 'succeeded'
          AND season_rollovers.completed_at_ms <=
            NEW.opened_at_ms
      )
    )
  THEN RAISE(
    ABORT,
    'normal FAD readiness requires its exact successful Entry Draft rollover'
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
    AND NEW.readiness_operation_id IS OLD.readiness_operation_id
    AND NEW.readiness_occurrence_key IS OLD.readiness_occurrence_key
    AND NEW.first_matchup_week_id IS OLD.first_matchup_week_id
    AND NEW.participating_team_count IS OLD.participating_team_count
    AND NEW.setup_path IS OLD.setup_path
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.setup_exemption_id IS OLD.setup_exemption_id
    AND NEW.prior_season_rollover_id IS OLD.prior_season_rollover_id
    AND NEW.no_draft_reason IS OLD.no_draft_reason
    AND NEW.opening_authority IS OLD.opening_authority
    AND NEW.opened_at_ms IS OLD.opened_at_ms
    AND NEW.help_opens_at_ms IS OLD.help_opens_at_ms
    AND NEW.candidate_deadline_at_ms IS OLD.candidate_deadline_at_ms
    AND NEW.first_matchup_starts_at_ms IS OLD.first_matchup_starts_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'cards_open'
        AND NEW.status = 'deadline_locked'
        AND NEW.current_competition_first_matchup_week_id IS
          OLD.current_competition_first_matchup_week_id
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.deadline_locked_at_ms >=
          NEW.candidate_deadline_at_ms
        AND NEW.allocation_completed_at_ms IS NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status = 'deadline_locked'
        AND NEW.status = 'allocating'
        AND NEW.current_competition_first_matchup_week_id IS
          OLD.current_competition_first_matchup_week_id
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.deadline_locked_at_ms IS OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status IN ('deadline_locked', 'allocating')
        AND NEW.status = 'rapid'
        AND NEW.current_competition_first_matchup_week_id IS
          OLD.current_competition_first_matchup_week_id
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.deadline_locked_at_ms IS OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS NOT NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status = 'rapid'
        AND NEW.status = 'completed'
        AND NEW.deadline_locked_at_ms IS OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS
          OLD.allocation_completed_at_ms
        AND NEW.completed_at_ms IS NOT NULL
        AND NEW.completed_at_ms < (
          SELECT matchup_weeks.starts_at_ms
          FROM matchup_weeks
          WHERE matchup_weeks.league_id = NEW.league_id
            AND matchup_weeks.id =
              NEW.current_competition_first_matchup_week_id
        )
        AND (
          SELECT seasons.free_agent_draft_completed_at_ms
          FROM seasons
          WHERE seasons.league_id = NEW.league_id
            AND seasons.id = NEW.season_id
        ) IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations
          WHERE free_agent_draft_player_allocations.league_id =
              NEW.league_id
            AND free_agent_draft_player_allocations.fad_id =
              NEW.id
            AND free_agent_draft_player_allocations.status NOT IN (
              'automatic_award',
              'restricted_resolved',
              'fallback_open_resolved',
              'no_valid_offer',
              'invalid'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers
          WHERE free_agent_draft_rollovers.league_id =
              NEW.league_id
            AND free_agent_draft_rollovers.fad_id = NEW.id
            AND free_agent_draft_rollovers.status <> 'completed'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_nomination_queue
          WHERE free_agent_draft_nomination_queue.league_id =
              NEW.league_id
            AND free_agent_draft_nomination_queue.fad_id = NEW.id
            AND free_agent_draft_nomination_queue.status =
              'queued'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auction_contexts
          JOIN auctions
            ON auctions.league_id = auction_contexts.league_id
           AND auctions.season_id = auction_contexts.season_id
           AND auctions.id = auction_contexts.auction_id
          WHERE auction_contexts.league_id = NEW.league_id
            AND auction_contexts.fad_id = NEW.id
            AND auction_contexts.source_kind IN (
              'fad_open_rapid',
              'fad_restricted'
            )
            AND (
              auctions.status NOT IN (
                'resolved',
                'no_winner',
                'cancelled'
              )
              OR (
                SELECT COUNT(*)
                FROM auction_resolutions
                WHERE auction_resolutions.league_id =
                    auctions.league_id
                  AND auction_resolutions.auction_id =
                    auctions.id
                  AND auction_resolutions.status IN (
                    'resolved',
                    'no_bids',
                    'no_winner',
                    'cancelled',
                    'recovered'
                  )
              ) <> 1
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_draws
                  WHERE free_agent_draft_draws.league_id =
                      auctions.league_id
                    AND free_agent_draft_draws.auction_id =
                      auctions.id
                    AND free_agent_draft_draws.revealed_at_ms =
                      auctions.updated_at_ms
                )
                AND NOT (
                  auction_contexts.source_kind = 'fad_restricted'
                  AND auctions.status = 'cancelled'
                  AND EXISTS (
                    SELECT 1
                    FROM auction_resolutions
                    WHERE auction_resolutions.league_id =
                        auctions.league_id
                      AND auction_resolutions.auction_id =
                        auctions.id
                      AND auction_resolutions.status = 'cancelled'
                      AND auction_resolutions.outcome_code = 'failed'
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_draws
                    WHERE free_agent_draft_draws.league_id =
                        auctions.league_id
                      AND free_agent_draft_draws.auction_id =
                        auctions.id
                      AND free_agent_draft_draws.revealed_at_ms IS NULL
                      AND free_agent_draft_draws.version = 1
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_recoveries
                    WHERE free_agent_draft_recoveries.league_id =
                        auction_contexts.league_id
                      AND free_agent_draft_recoveries.fad_id =
                        auction_contexts.fad_id
                      AND free_agent_draft_recoveries.allocation_id =
                        auction_contexts.fad_allocation_id
                      AND free_agent_draft_recoveries.rollover_id =
                        auction_contexts.fad_rollover_id
                      AND free_agent_draft_recoveries.auction_id =
                        auction_contexts.auction_id
                      AND free_agent_draft_recoveries.kind =
                        'auction_resolution'
                      AND free_agent_draft_recoveries.status = 'resolved'
                      AND free_agent_draft_recoveries.resolved_at_ms <=
                        NEW.completed_at_ms
                  )
                )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_recoveries
          WHERE free_agent_draft_recoveries.league_id =
              NEW.league_id
            AND free_agent_draft_recoveries.fad_id = NEW.id
            AND free_agent_draft_recoveries.status <> 'resolved'
        )
        AND (
          SELECT COUNT(*)
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.season_id = NEW.season_id
            AND job_runs.job_type = 'fad_completion'
            AND job_runs.occurrence_key =
              'fad:' || NEW.id || ':complete'
            AND job_runs.scheduled_for_ms <=
              NEW.completed_at_ms
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms >
              NEW.completed_at_ms
            AND job_runs.started_at_ms IS NOT NULL
            AND job_runs.completed_at_ms IS NULL
        ) = 1
        AND (
          (
            NEW.schedule_recovery_id IS NULL
            AND NEW.current_competition_first_matchup_week_id IS
              OLD.current_competition_first_matchup_week_id
          )
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_schedule_recoveries
            WHERE free_agent_draft_schedule_recoveries.league_id =
                NEW.league_id
              AND free_agent_draft_schedule_recoveries.fad_id = NEW.id
              AND free_agent_draft_schedule_recoveries.id =
                NEW.schedule_recovery_id
              AND free_agent_draft_schedule_recoveries.recovery_kind =
                'completion'
              AND free_agent_draft_schedule_recoveries.old_first_matchup_week_id =
                OLD.current_competition_first_matchup_week_id
              AND free_agent_draft_schedule_recoveries.new_first_matchup_week_id =
                NEW.current_competition_first_matchup_week_id
              AND free_agent_draft_schedule_recoveries.completed_at_ms =
                NEW.completed_at_ms
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD may only advance through its atomic locked lifecycle'
  ) END;
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
            AND candidate_card_snapshot_entries.row_kind =
              'conflict'
            AND candidate_card_snapshot_entries.occupant_kind =
              'carryover'
        ) <> candidate_card_snapshots
              .carried_roster_structural_conflict_count
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

CREATE TRIGGER free_agent_drafts_deadline_allocation_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'cards_open'
  AND NEW.status = 'deadline_locked'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.window_kind = 'initial'
  ) <> 7 THEN RAISE(
    ABORT,
    'FAD deadline requires exactly seven rapid rollovers'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        free_agent_draft_rollovers.window_kind <> 'initial'
        OR free_agent_draft_rollovers.status <> 'scheduled'
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires all rapid rollovers to remain scheduled'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
  ) <> (
    SELECT COUNT(DISTINCT player_id)
    FROM candidate_card_snapshot_entries
    WHERE candidate_card_snapshot_entries.league_id = NEW.league_id
      AND candidate_card_snapshot_entries.season_id = NEW.season_id
      AND candidate_card_snapshot_entries.fad_id = NEW.id
      AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one pending allocation per candidate player'
  ) END;

  SELECT CASE WHEN
    EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id = NEW.league_id
        AND candidate_card_snapshot_entries.season_id = NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.id
        AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations
          WHERE free_agent_draft_player_allocations.league_id =
              candidate_card_snapshot_entries.league_id
            AND free_agent_draft_player_allocations.season_id =
              candidate_card_snapshot_entries.season_id
            AND free_agent_draft_player_allocations.fad_id =
              candidate_card_snapshot_entries.fad_id
            AND free_agent_draft_player_allocations.player_id =
              candidate_card_snapshot_entries.player_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id = NEW.league_id
        AND free_agent_draft_player_allocations.season_id = NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              free_agent_draft_player_allocations.league_id
            AND candidate_card_snapshot_entries.season_id =
              free_agent_draft_player_allocations.season_id
            AND candidate_card_snapshot_entries.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND candidate_card_snapshot_entries.player_id =
              free_agent_draft_player_allocations.player_id
            AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
        )
    )
  THEN RAISE(
    ABORT,
    'FAD deadline requires the exact Candidate snapshot player set'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status <> 'pending'
  ) THEN RAISE(
    ABORT,
    'FAD deadline allocations must all begin pending'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline_reminder'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':reminder:' ||
          (NEW.candidate_deadline_at_ms - 259200000)
      AND job_runs.scheduled_for_ms =
        NEW.candidate_deadline_at_ms - 259200000
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD deadline requires its exact reminder occurrence'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':deadline:' ||
          NEW.candidate_deadline_at_ms
      AND job_runs.scheduled_for_ms = NEW.candidate_deadline_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms >
        NEW.deadline_locked_at_ms
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD deadline requires its exact deadline occurrence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        SELECT COUNT(*)
        FROM job_runs
        WHERE job_runs.league_id = NEW.league_id
          AND job_runs.season_id = NEW.season_id
          AND job_runs.job_type = 'fad_rollover'
          AND job_runs.occurrence_key =
            'fad:' || NEW.id || ':rollover:' ||
              free_agent_draft_rollovers.sequence || ':' ||
              free_agent_draft_rollovers.rolls_over_at_ms
          AND job_runs.scheduled_for_ms =
            free_agent_draft_rollovers.rolls_over_at_ms
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one exact occurrence per rollover'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND (
        SELECT COUNT(*)
        FROM job_runs
        WHERE job_runs.league_id = NEW.league_id
          AND job_runs.season_id = NEW.season_id
          AND job_runs.job_type = 'fad_allocation'
          AND job_runs.occurrence_key =
            'fad:' || NEW.id || ':allocate:' ||
              free_agent_draft_player_allocations.player_id
          AND job_runs.scheduled_for_ms =
            NEW.candidate_deadline_at_ms
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one exact occurrence per allocation'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_allocation_start_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'deadline_locked'
  AND NEW.status = 'allocating'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD with no candidate allocations must enter rapid directly'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND (
        free_agent_draft_player_allocations.status <> 'pending'
        OR (
          SELECT COUNT(*)
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.season_id = NEW.season_id
            AND job_runs.job_type = 'fad_allocation'
            AND job_runs.occurrence_key =
              'fad:' || NEW.id || ':allocate:' ||
                free_agent_draft_player_allocations.player_id
            AND job_runs.scheduled_for_ms =
              NEW.candidate_deadline_at_ms
        ) <> 1
      )
  ) THEN RAISE(
    ABORT,
    'FAD allocation start requires pending durable per-player work'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_allocation_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status IN ('deadline_locked', 'allocating')
  AND NEW.status = 'rapid'
BEGIN
  SELECT CASE WHEN
    OLD.status = 'deadline_locked'
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.season_id =
          NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.id
    )
  THEN RAISE(
    ABORT,
    'FAD may bypass allocating only when no allocations exist'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND (
        free_agent_draft_player_allocations.status = 'pending'
        OR free_agent_draft_player_allocations.updated_at_ms >
          NEW.allocation_completed_at_ms
        OR (
          SELECT COUNT(*)
          FROM free_agent_draft_allocation_events
          WHERE free_agent_draft_allocation_events.league_id =
              free_agent_draft_player_allocations.league_id
            AND free_agent_draft_allocation_events.season_id =
              free_agent_draft_player_allocations.season_id
            AND free_agent_draft_allocation_events.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND free_agent_draft_allocation_events.allocation_id =
              free_agent_draft_player_allocations.id
            AND free_agent_draft_allocation_events.player_id =
              free_agent_draft_player_allocations.player_id
            AND free_agent_draft_allocation_events.allocation_version =
              free_agent_draft_player_allocations.version
            AND free_agent_draft_allocation_events
              .resulting_allocation_status =
                free_agent_draft_player_allocations.status
            AND free_agent_draft_allocation_events.decision_code IS
              free_agent_draft_player_allocations.decision_code
            AND free_agent_draft_allocation_events.contract_id IS
              free_agent_draft_player_allocations.contract_id
            AND free_agent_draft_allocation_events.ownership_id IS
              free_agent_draft_player_allocations.ownership_id
            AND free_agent_draft_allocation_events.occurred_at_ms =
              free_agent_draft_player_allocations.updated_at_ms
            AND free_agent_draft_allocation_events.event_kind IN (
              'decision_recorded',
              'restricted_state_changed',
              'fallback_state_changed',
              'correction_applied'
            )
        ) <> 1
        OR EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              free_agent_draft_player_allocations.league_id
            AND candidate_card_snapshot_entries.season_id =
              free_agent_draft_player_allocations.season_id
            AND candidate_card_snapshot_entries.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND candidate_card_snapshot_entries.player_id =
              free_agent_draft_player_allocations.player_id
            AND candidate_card_snapshot_entries.occupant_kind =
              'candidate'
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_allocation_events
              WHERE free_agent_draft_allocation_events.league_id =
                  candidate_card_snapshot_entries.league_id
                AND free_agent_draft_allocation_events.season_id =
                  candidate_card_snapshot_entries.season_id
                AND free_agent_draft_allocation_events.fad_id =
                  candidate_card_snapshot_entries.fad_id
                AND free_agent_draft_allocation_events.allocation_id =
                  free_agent_draft_player_allocations.id
                AND free_agent_draft_allocation_events.player_id =
                  candidate_card_snapshot_entries.player_id
                AND free_agent_draft_allocation_events
                  .allocation_version =
                    free_agent_draft_player_allocations.version
                AND free_agent_draft_allocation_events.event_kind =
                  'offer_considered'
                AND free_agent_draft_allocation_events.snapshot_entry_id =
                  candidate_card_snapshot_entries.id
            )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires current evidence for every allocation and offer'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND NOT (
        (
          allocation.status = 'automatic_award'
          AND allocation.decision_code IN (
            'sole_valid_offer',
            'highest_total',
            'highest_equal_total_aav'
          )
        )
        OR (
          allocation.status IN (
            'restricted_scheduled',
            'restricted_active'
          )
          AND allocation.decision_code =
            'exact_total_and_term_tie'
        )
        OR (
          allocation.status = 'no_valid_offer'
          AND allocation.decision_code = 'no_valid_offer'
        )
        OR (
          allocation.status = 'invalid'
          AND allocation.decision_code IN (
            'invalid_snapshot',
            'candidate_card_structural_conflict',
            'candidate_card_over_cap'
          )
        )
        OR allocation.status = 'correction_required'
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires an approved accounted allocation state'
  ) END;

  WITH
    current_allocations AS (
      SELECT *
      FROM free_agent_draft_player_allocations
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
        AND fad_id = NEW.id
    ),
    valid_offers AS (
      SELECT
        current_allocations.id AS allocation_id,
        candidate_card_snapshot_entries.id AS snapshot_entry_id,
        candidate_card_snapshot_entries.team_id AS team_id,
        candidate_card_snapshot_entries.proposed_total_value_cents
          AS total_value_cents,
        candidate_card_snapshot_entries.proposed_term_years
          AS term_years,
        candidate_card_snapshot_entries.proposed_aav_cents
          AS aav_cents
      FROM current_allocations
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            current_allocations.league_id
       AND candidate_card_snapshot_entries.season_id =
            current_allocations.season_id
       AND candidate_card_snapshot_entries.fad_id =
            current_allocations.fad_id
       AND candidate_card_snapshot_entries.player_id =
            current_allocations.player_id
       AND candidate_card_snapshot_entries.row_kind = 'slot'
       AND candidate_card_snapshot_entries.occupant_kind =
            'candidate'
       AND candidate_card_snapshot_entries.eligibility_status
            IN ('valid', 'warning')
       AND candidate_card_snapshot_entries.allocation_eligibility =
            'eligible'
    ),
    maximum_totals AS (
      SELECT allocation_id, MAX(total_value_cents) AS total_value_cents
      FROM valid_offers
      GROUP BY allocation_id
    ),
    top_total_offers AS (
      SELECT valid_offers.*
      FROM valid_offers
      JOIN maximum_totals
        ON maximum_totals.allocation_id = valid_offers.allocation_id
       AND maximum_totals.total_value_cents =
            valid_offers.total_value_cents
    ),
    maximum_aavs AS (
      SELECT allocation_id, MAX(aav_cents) AS aav_cents
      FROM top_total_offers
      GROUP BY allocation_id
    ),
    top_offers AS (
      SELECT top_total_offers.*
      FROM top_total_offers
      JOIN maximum_aavs
        ON maximum_aavs.allocation_id =
            top_total_offers.allocation_id
       AND maximum_aavs.aav_cents = top_total_offers.aav_cents
    ),
    offer_counts AS (
      SELECT
        current_allocations.id AS allocation_id,
        COUNT(valid_offers.snapshot_entry_id) AS valid_count,
        COUNT(top_total_offers.snapshot_entry_id) AS top_total_count,
        COUNT(top_offers.snapshot_entry_id) AS top_count,
        COUNT(DISTINCT top_offers.term_years) AS top_term_count
      FROM current_allocations
      LEFT JOIN valid_offers
        ON valid_offers.allocation_id = current_allocations.id
      LEFT JOIN top_total_offers
        ON top_total_offers.allocation_id = current_allocations.id
       AND top_total_offers.snapshot_entry_id =
            valid_offers.snapshot_entry_id
      LEFT JOIN top_offers
        ON top_offers.allocation_id = current_allocations.id
       AND top_offers.snapshot_entry_id = valid_offers.snapshot_entry_id
      GROUP BY current_allocations.id
    ),
    event_counts AS (
      SELECT
        current_allocations.id AS allocation_id,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'winner'
        ), 0) AS winner_count,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'restricted_tied'
        ), 0) AS restricted_count
      FROM current_allocations
      LEFT JOIN free_agent_draft_allocation_events
        ON free_agent_draft_allocation_events.league_id =
            current_allocations.league_id
       AND free_agent_draft_allocation_events.season_id =
            current_allocations.season_id
       AND free_agent_draft_allocation_events.fad_id =
            current_allocations.fad_id
       AND free_agent_draft_allocation_events.allocation_id =
            current_allocations.id
       AND free_agent_draft_allocation_events.allocation_version =
            current_allocations.version
       AND free_agent_draft_allocation_events.event_kind =
            'offer_considered'
      GROUP BY current_allocations.id
    )
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM current_allocations
    JOIN offer_counts
      ON offer_counts.allocation_id = current_allocations.id
    JOIN event_counts
      ON event_counts.allocation_id = current_allocations.id
    WHERE (
      current_allocations.decision_code = 'sole_valid_offer'
      AND (
        offer_counts.valid_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code = 'highest_total'
      AND (
        offer_counts.valid_count < 2
        OR offer_counts.top_total_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code =
        'highest_equal_total_aav'
      AND (
        offer_counts.top_total_count < 2
        OR offer_counts.top_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code =
        'exact_total_and_term_tie'
      AND (
        offer_counts.top_count < 2
        OR offer_counts.top_term_count <> 1
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> offer_counts.top_count
      )
    )
    OR (
      current_allocations.decision_code = 'no_valid_offer'
      AND (
        offer_counts.valid_count <> 0
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code IN (
        'sole_valid_offer',
        'highest_total',
        'highest_equal_total_aav'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM top_offers
        JOIN free_agent_draft_allocation_events AS winner_event
          ON winner_event.league_id = current_allocations.league_id
         AND winner_event.season_id = current_allocations.season_id
         AND winner_event.fad_id = current_allocations.fad_id
         AND winner_event.allocation_id = current_allocations.id
         AND winner_event.allocation_version =
              current_allocations.version
         AND winner_event.player_id = current_allocations.player_id
         AND winner_event.event_kind = 'offer_considered'
         AND winner_event.snapshot_entry_id =
              top_offers.snapshot_entry_id
         AND winner_event.team_id = top_offers.team_id
         AND winner_event.offer_valid = 1
         AND winner_event.offer_outcome_code = 'winner'
        WHERE top_offers.allocation_id = current_allocations.id
          AND top_offers.snapshot_entry_id =
              current_allocations.winning_snapshot_entry_id
          AND top_offers.team_id = current_allocations.winning_team_id
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires deterministic total-first and AAV-second evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status IN (
        'restricted_scheduled',
        'restricted_active'
      )
      AND NOT (
        EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.season_id = auctions.season_id
           AND auction_contexts.auction_id = auctions.id
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auction_contexts.league_id
           AND free_agent_draft_rollovers.season_id =
                auction_contexts.season_id
           AND free_agent_draft_rollovers.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_rollovers.id =
                auction_contexts.fad_rollover_id
          JOIN free_agent_draft_draws
            ON free_agent_draft_draws.league_id =
                auction_contexts.league_id
           AND free_agent_draft_draws.season_id =
                auction_contexts.season_id
           AND free_agent_draft_draws.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_draws.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_draws.auction_id =
                auction_contexts.auction_id
          WHERE auctions.league_id = allocation.league_id
            AND auctions.season_id = allocation.season_id
            AND auctions.id = allocation.restricted_auction_id
            AND auctions.player_id = allocation.player_id
            AND auctions.status = 'open'
            AND auctions.resolves_at_ms =
              free_agent_draft_rollovers.rolls_over_at_ms
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = allocation.fad_id
            AND auction_contexts.fad_allocation_id = allocation.id
            AND auction_contexts.fad_origin =
              'candidate_tie_restricted'
            AND free_agent_draft_draws.created_at_ms =
              auctions.opened_at_ms
            AND free_agent_draft_draws.revealed_at_ms IS NULL
            AND free_agent_draft_draws.version = 1
        )
        AND (
          SELECT COUNT(*)
          FROM free_agent_draft_auction_participants
          WHERE free_agent_draft_auction_participants.league_id =
              allocation.league_id
            AND free_agent_draft_auction_participants.season_id =
              allocation.season_id
            AND free_agent_draft_auction_participants.fad_id =
              allocation.fad_id
            AND free_agent_draft_auction_participants.allocation_id =
              allocation.id
            AND free_agent_draft_auction_participants.auction_id =
              allocation.restricted_auction_id
            AND free_agent_draft_auction_participants.status = 'active'
            AND free_agent_draft_auction_participants
              .minimum_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND free_agent_draft_auction_participants
              .minimum_term_years =
                allocation.restricted_minimum_term_years
            AND free_agent_draft_auction_participants
              .minimum_aav_cents =
                allocation.restricted_minimum_aav_cents
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS eligible_offer
          WHERE eligible_offer.league_id = allocation.league_id
            AND eligible_offer.season_id = allocation.season_id
            AND eligible_offer.fad_id = allocation.fad_id
            AND eligible_offer.player_id = allocation.player_id
            AND eligible_offer.row_kind = 'slot'
            AND eligible_offer.occupant_kind = 'candidate'
            AND eligible_offer.eligibility_status IN ('valid', 'warning')
            AND eligible_offer.allocation_eligibility = 'eligible'
            AND (
              eligible_offer.proposed_total_value_cents >
                allocation.restricted_minimum_total_cents
              OR (
                eligible_offer.proposed_total_value_cents =
                  allocation.restricted_minimum_total_cents
                AND eligible_offer.proposed_aav_cents >
                  allocation.restricted_minimum_aav_cents
              )
            )
        )
        AND (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS tied_offer
          WHERE tied_offer.league_id = allocation.league_id
            AND tied_offer.season_id = allocation.season_id
            AND tied_offer.fad_id = allocation.fad_id
            AND tied_offer.player_id = allocation.player_id
            AND tied_offer.row_kind = 'slot'
            AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.eligibility_status IN ('valid', 'warning')
            AND tied_offer.allocation_eligibility = 'eligible'
            AND tied_offer.proposed_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND tied_offer.proposed_term_years =
                allocation.restricted_minimum_term_years
            AND tied_offer.proposed_aav_cents =
                allocation.restricted_minimum_aav_cents
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS tied_offer
          WHERE tied_offer.league_id = allocation.league_id
            AND tied_offer.season_id = allocation.season_id
            AND tied_offer.fad_id = allocation.fad_id
            AND tied_offer.player_id = allocation.player_id
            AND tied_offer.row_kind = 'slot'
            AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.eligibility_status IN ('valid', 'warning')
            AND tied_offer.allocation_eligibility = 'eligible'
            AND tied_offer.proposed_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND tied_offer.proposed_aav_cents =
                allocation.restricted_minimum_aav_cents
            AND (
              tied_offer.proposed_term_years <>
                allocation.restricted_minimum_term_years
              OR NOT EXISTS (
                SELECT 1
                FROM free_agent_draft_auction_participants AS participant
                WHERE participant.league_id = allocation.league_id
                  AND participant.season_id = allocation.season_id
                  AND participant.fad_id = allocation.fad_id
                  AND participant.allocation_id = allocation.id
                  AND participant.auction_id =
                      allocation.restricted_auction_id
                  AND participant.team_id = tied_offer.team_id
                  AND participant.source_snapshot_entry_id = tied_offer.id
                  AND participant.status = 'active'
                  AND participant.minimum_total_value_cents =
                      allocation.restricted_minimum_total_cents
                  AND participant.minimum_term_years =
                      allocation.restricted_minimum_term_years
                  AND participant.minimum_aav_cents =
                      allocation.restricted_minimum_aav_cents
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_auction_participants AS participant
          WHERE participant.league_id = allocation.league_id
            AND participant.season_id = allocation.season_id
            AND participant.fad_id = allocation.fad_id
            AND participant.allocation_id = allocation.id
            AND participant.auction_id = allocation.restricted_auction_id
            AND participant.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries AS tied_offer
              WHERE tied_offer.league_id = participant.league_id
                AND tied_offer.season_id = participant.season_id
                AND tied_offer.fad_id = participant.fad_id
                AND tied_offer.id = participant.source_snapshot_entry_id
                AND tied_offer.player_id = allocation.player_id
                AND tied_offer.team_id = participant.team_id
                AND tied_offer.row_kind = 'slot'
                AND tied_offer.occupant_kind = 'candidate'
                AND tied_offer.eligibility_status IN ('valid', 'warning')
                AND tied_offer.allocation_eligibility = 'eligible'
                AND tied_offer.proposed_total_value_cents =
                    allocation.restricted_minimum_total_cents
                AND tied_offer.proposed_term_years =
                    allocation.restricted_minimum_term_years
                AND tied_offer.proposed_aav_cents =
                    allocation.restricted_minimum_aav_cents
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = allocation.league_id
            AND auction_bids.auction_id =
              allocation.restricted_auction_id
        )
        AND (
          (
            allocation.status = 'restricted_active'
            AND NOT EXISTS (
              SELECT 1
              FROM job_runs
              WHERE job_runs.league_id = allocation.league_id
                AND job_runs.season_id = allocation.season_id
                AND job_runs.job_type = 'fad_restricted_activation'
                AND job_runs.occurrence_key LIKE
                  'fad:' || allocation.fad_id ||
                    ':restricted-activate:' || allocation.id || ':%'
            )
          )
          OR (
            allocation.status = 'restricted_scheduled'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN job_runs
                ON job_runs.league_id = auctions.league_id
               AND job_runs.season_id = auctions.season_id
               AND job_runs.job_type =
                    'fad_restricted_activation'
               AND job_runs.occurrence_key =
                    'fad:' || allocation.fad_id ||
                      ':restricted-activate:' || allocation.id ||
                      ':' || auctions.opened_at_ms
               AND job_runs.scheduled_for_ms =
                    auctions.opened_at_ms
              WHERE auctions.league_id = allocation.league_id
                AND auctions.id = allocation.restricted_auction_id
                AND job_runs.status = 'pending'
                AND job_runs.attempt_count = 0
                AND job_runs.lease_owner IS NULL
                AND job_runs.lease_token IS NULL
                AND job_runs.started_at_ms IS NULL
                AND job_runs.completed_at_ms IS NULL
            )
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires complete immediate or scheduled restricted resources'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status = 'correction_required'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            allocation.league_id
          AND free_agent_draft_recoveries.season_id =
            allocation.season_id
          AND free_agent_draft_recoveries.fad_id = allocation.fad_id
          AND free_agent_draft_recoveries.allocation_id = allocation.id
          AND free_agent_draft_recoveries.player_id =
            allocation.player_id
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code =
            allocation.last_error_code
          AND free_agent_draft_recoveries.created_at_ms =
            allocation.updated_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires correction-required allocation recovery'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_automatic_award_resources_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN NEW.status IN ('rapid', 'completed')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status = 'automatic_award'
      AND NOT EXISTS (
        SELECT 1
        FROM contracts
        JOIN player_ownerships
          ON player_ownerships.league_id = contracts.league_id
         AND player_ownerships.id = allocation.ownership_id
         AND player_ownerships.season_id = allocation.season_id
         AND player_ownerships.player_id = allocation.player_id
         AND player_ownerships.team_id =
              allocation.winning_team_id
         AND player_ownerships.ownership_kind = 'Rostered'
        JOIN candidate_card_snapshot_entries AS winning_offer
          ON winning_offer.league_id = contracts.league_id
         AND winning_offer.season_id = allocation.season_id
         AND winning_offer.fad_id = allocation.fad_id
         AND winning_offer.id =
              allocation.winning_snapshot_entry_id
         AND winning_offer.player_id = allocation.player_id
         AND winning_offer.team_id = allocation.winning_team_id
         AND winning_offer.row_kind = 'slot'
         AND winning_offer.occupant_kind = 'candidate'
         AND winning_offer.eligibility_status IN (
              'valid',
              'warning'
            )
         AND winning_offer.allocation_eligibility = 'eligible'
        JOIN seasons AS target_season
          ON target_season.league_id = contracts.league_id
         AND target_season.id = allocation.season_id
        WHERE contracts.league_id = allocation.league_id
          AND contracts.id = allocation.contract_id
          AND contracts.player_id = allocation.player_id
          AND contracts.current_team_id =
              allocation.winning_team_id
          AND contracts.status = 'active'
          AND contracts.contract_type = 'normal'
          AND contracts.start_season_id = allocation.season_id
          AND contracts.acquisition_source_type =
              'free_agent_draft_allocation'
          AND contracts.acquisition_source_id = allocation.id
          AND contracts.created_at_ms = allocation.accounted_at_ms
          AND contracts.auction_buyout_lock_expires_at_ms =
              allocation.accounted_at_ms + 1209600000
          AND player_ownerships.acquired_transaction_type =
              'free_agent_draft_allocation'
          AND player_ownerships.acquired_transaction_id =
              allocation.id
          AND player_ownerships.created_at_ms =
              allocation.accounted_at_ms
          AND target_season.status = 'active'
          AND length(target_season.nhl_season_key) = 8
          AND target_season.nhl_season_key
            NOT GLOB '*[^0-9]*'
          AND CAST(
            substr(target_season.nhl_season_key, 5, 4) AS INTEGER
          ) = CAST(
            substr(target_season.nhl_season_key, 1, 4) AS INTEGER
          ) + 1
          AND target_season.nhl_season_key = printf(
            '%04d%04d',
            CAST(
              substr(
                target_season.nhl_season_key,
                1,
                4
              ) AS INTEGER
            ),
            CAST(
              substr(
                target_season.nhl_season_key,
                1,
                4
              ) AS INTEGER
            ) + 1
          )
          AND (
            SELECT COUNT(*)
            FROM contract_years
            WHERE contract_years.league_id = allocation.league_id
              AND contract_years.contract_id =
                  allocation.contract_id
          ) = contracts.original_term_years
          AND NOT EXISTS (
            SELECT 1
            FROM contract_years
            JOIN seasons AS contract_year_season
              ON contract_year_season.league_id =
                  contract_years.league_id
             AND contract_year_season.id =
                  contract_years.season_id
            WHERE contract_years.league_id =
                allocation.league_id
              AND contract_years.contract_id =
                  allocation.contract_id
              AND (
                contract_years.year_number >
                  contracts.original_term_years
                OR contract_years.aav_cents <> contracts.aav_cents
                OR contract_years.created_at_ms <>
                  allocation.accounted_at_ms
                OR NOT (
                  (
                    contract_years.year_number = 1
                    AND contract_years.season_id =
                      allocation.season_id
                    AND contract_years.status = 'current'
                  )
                  OR (
                    contract_years.year_number BETWEEN
                      2 AND contracts.original_term_years
                    AND contract_years.status = 'future'
                    AND contract_year_season.status = 'planned'
                    AND contract_year_season
                      .regular_season_starts_at_ms IS NULL
                    AND contract_year_season
                      .regular_season_ends_at_ms IS NULL
                    AND contract_year_season
                      .fantasy_playoffs_start_at_ms IS NULL
                    AND contract_year_season
                      .fantasy_playoffs_end_at_ms IS NULL
                    AND contract_year_season.nhl_season_key =
                      printf(
                        '%04d%04d',
                        CAST(
                          substr(
                            target_season.nhl_season_key,
                            1,
                            4
                          ) AS INTEGER
                        ) + contract_years.year_number - 1,
                        CAST(
                          substr(
                            target_season.nhl_season_key,
                            1,
                            4
                          ) AS INTEGER
                        ) + contract_years.year_number
                      )
                    AND contract_year_season.label = printf(
                      '%04d-%02d',
                      CAST(
                        substr(
                          target_season.nhl_season_key,
                          1,
                          4
                        ) AS INTEGER
                      ) + contract_years.year_number - 1,
                      (
                        CAST(
                          substr(
                            target_season.nhl_season_key,
                            1,
                            4
                          ) AS INTEGER
                        ) + contract_years.year_number
                      ) % 100
                    )
                  )
                )
              )
          )
          AND contracts.original_total_value_cents =
              winning_offer.proposed_total_value_cents
          AND contracts.original_term_years =
              winning_offer.proposed_term_years
          AND contracts.aav_cents =
              winning_offer.proposed_aav_cents
          AND (
            (
              winning_offer.slot_group IN ('F', 'D')
              AND player_ownerships.roster_category = 'Active'
            )
            OR (
              winning_offer.slot_group = 'B'
              AND player_ownerships.roster_category = 'Bench'
            )
          )
          AND player_ownerships.position_group =
              winning_offer.effective_position_group
          AND player_ownerships.slot_number =
              winning_offer.slot_number
      )
  ) THEN RAISE(
    ABORT,
    'FAD milestone requires durable automatic-award resources'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status = 'automatic_award'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_allocation_events AS decision_event
        JOIN league_activity
          ON league_activity.league_id = decision_event.league_id
         AND league_activity.id = decision_event.activity_id
        JOIN outbox_events
          ON outbox_events.league_id = decision_event.league_id
         AND outbox_events.id = json_extract(
              decision_event.evidence_json,
              '$.sideEffects.outboxEventId'
            )
        WHERE decision_event.league_id = allocation.league_id
          AND decision_event.season_id = allocation.season_id
          AND decision_event.fad_id = allocation.fad_id
          AND decision_event.allocation_id = allocation.id
          AND decision_event.allocation_version = allocation.version
          AND decision_event.player_id = allocation.player_id
          AND decision_event.event_kind = 'decision_recorded'
          AND decision_event.decision_code = allocation.decision_code
          AND decision_event.resulting_allocation_status =
              allocation.status
          AND decision_event.contract_id = allocation.contract_id
          AND decision_event.ownership_id = allocation.ownership_id
          AND decision_event.auction_id IS NULL
          AND decision_event.activity_id IS NOT NULL
          AND decision_event.actor_authority = 'system'
          AND decision_event.occurred_at_ms = allocation.accounted_at_ms
          AND json_extract(
                decision_event.evidence_json,
                '$.sideEffects.activityId'
              ) = decision_event.activity_id
          AND league_activity.season_id = allocation.season_id
          AND league_activity.event_type =
              'fad_automatic_signing_completed'
          AND league_activity.actor_user_id IS NULL
          AND league_activity.actor_authority = 'system'
          AND league_activity.team_id = allocation.winning_team_id
          AND league_activity.player_id = allocation.player_id
          AND league_activity.related_type =
              'free_agent_draft_allocation'
          AND league_activity.related_id = allocation.id
          AND league_activity.reason IS NULL
          AND league_activity.occurred_at_ms = allocation.accounted_at_ms
          AND json_extract(
                league_activity.metadata_json,
                '$.fadId'
              ) = allocation.fad_id
          AND json_extract(
                league_activity.metadata_json,
                '$.allocationId'
              ) = allocation.id
          AND json_extract(
                league_activity.metadata_json,
                '$.playerId'
              ) = allocation.player_id
          AND json_extract(
                league_activity.metadata_json,
                '$.winningTeamId'
              ) = allocation.winning_team_id
          AND json_extract(
                league_activity.metadata_json,
                '$.contractId'
              ) = allocation.contract_id
          AND json_extract(
                league_activity.metadata_json,
                '$.ownershipId'
              ) = allocation.ownership_id
          AND outbox_events.event_type = 'free_agent_draft.changed'
          AND outbox_events.aggregate_type = 'free_agent_draft'
          AND outbox_events.aggregate_id = allocation.fad_id
          AND outbox_events.available_at_ms = allocation.accounted_at_ms
          AND outbox_events.created_at_ms = allocation.accounted_at_ms
          AND json_extract(outbox_events.payload_json, '$.kind') =
              'invalidation'
          AND json_extract(outbox_events.payload_json, '$.eventType') =
              'free_agent_draft.changed'
          AND json_extract(outbox_events.payload_json, '$.scope') =
              'league'
          AND json_extract(outbox_events.payload_json, '$.scopeId') =
              allocation.league_id
          AND json_extract(outbox_events.payload_json, '$.changedAtMs') =
              allocation.accounted_at_ms
          AND (
            SELECT COUNT(*)
            FROM outbox_event_audiences
            WHERE outbox_event_audiences.league_id = allocation.league_id
              AND outbox_event_audiences.outbox_event_id = outbox_events.id
              AND outbox_event_audiences.audience_kind = 'league'
              AND outbox_event_audiences.team_id IS NULL
              AND outbox_event_audiences.user_id IS NULL
              AND outbox_event_audiences.created_at_ms =
                  allocation.accounted_at_ms
          ) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM outbox_event_audiences
            WHERE outbox_event_audiences.league_id = allocation.league_id
              AND outbox_event_audiences.outbox_event_id = outbox_events.id
              AND outbox_event_audiences.audience_kind <> 'league'
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD milestone requires automatic-award activity and scoped outbox evidence'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_auction_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN free_agent_draft_rollovers
      ON free_agent_draft_rollovers.league_id =
          auction_contexts.league_id
     AND free_agent_draft_rollovers.season_id =
          auction_contexts.season_id
     AND free_agent_draft_rollovers.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_rollovers.id =
          auction_contexts.fad_rollover_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND (
        free_agent_draft_rollovers.status <> 'completed'
        OR free_agent_draft_rollovers.completed_at_ms >
          NEW.completed_at_ms
        OR auctions.status NOT IN (
          'resolved',
          'no_winner',
          'cancelled'
        )
        OR (
          SELECT COUNT(*)
          FROM auction_resolutions
          WHERE auction_resolutions.league_id =
              auction_contexts.league_id
            AND auction_resolutions.season_id =
              auction_contexts.season_id
            AND auction_resolutions.auction_id =
              auction_contexts.auction_id
            AND auction_resolutions.resolved_at_ms <=
              NEW.completed_at_ms
            AND (
              (
                auctions.status = 'resolved'
                AND auction_resolutions.status = 'resolved'
                AND auction_resolutions.outcome_code = 'winner'
              )
              OR (
                auctions.status = 'no_winner'
                AND auction_resolutions.status IN (
                  'no_bids',
                  'no_winner'
                )
                AND auction_resolutions.outcome_code = 'no_winner'
              )
              OR (
                auctions.status = 'cancelled'
                AND auction_resolutions.status = 'cancelled'
                AND auction_resolutions.outcome_code IN (
                  'failed',
                  'recovered',
                  'player_unavailable',
                  'season_closed'
                )
              )
            )
        ) <> 1
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires every FAD auction to be terminal and accounted'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN auction_resolutions
      ON auction_resolutions.league_id =
          auction_contexts.league_id
     AND auction_resolutions.season_id =
          auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND NOT (
        (
          auction_contexts.source_kind = 'fad_restricted'
          AND auctions.status = 'cancelled'
          AND auction_resolutions.status = 'cancelled'
          AND auction_resolutions.outcome_code = 'failed'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_draws
            WHERE free_agent_draft_draws.league_id =
                auction_contexts.league_id
              AND free_agent_draft_draws.season_id =
                auction_contexts.season_id
              AND free_agent_draft_draws.fad_id =
                auction_contexts.fad_id
              AND free_agent_draft_draws.allocation_id =
                auction_contexts.fad_allocation_id
              AND free_agent_draft_draws.auction_id =
                auction_contexts.auction_id
              AND free_agent_draft_draws.revealed_at_ms IS NULL
              AND free_agent_draft_draws.version = 1
          )
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries
            WHERE free_agent_draft_recoveries.league_id =
                auction_contexts.league_id
              AND free_agent_draft_recoveries.season_id =
                auction_contexts.season_id
              AND free_agent_draft_recoveries.fad_id =
                auction_contexts.fad_id
              AND free_agent_draft_recoveries.allocation_id =
                auction_contexts.fad_allocation_id
              AND free_agent_draft_recoveries.rollover_id =
                auction_contexts.fad_rollover_id
              AND free_agent_draft_recoveries.auction_id =
                auction_contexts.auction_id
              AND free_agent_draft_recoveries.kind =
                'auction_resolution'
              AND free_agent_draft_recoveries.status = 'resolved'
              AND free_agent_draft_recoveries.resolved_at_ms <=
                NEW.completed_at_ms
          )
        )
        OR EXISTS (
          SELECT 1
          FROM free_agent_draft_draws
          WHERE free_agent_draft_draws.league_id =
              auction_contexts.league_id
            AND free_agent_draft_draws.season_id =
              auction_contexts.season_id
            AND free_agent_draft_draws.fad_id =
              auction_contexts.fad_id
            AND free_agent_draft_draws.allocation_id IS
              auction_contexts.fad_allocation_id
            AND free_agent_draft_draws.auction_id =
              auction_contexts.auction_id
            AND free_agent_draft_draws.revealed_at_ms =
              auction_resolutions.resolved_at_ms
            AND free_agent_draft_draws.revealed_at_ms <=
              NEW.completed_at_ms
            AND free_agent_draft_draws.version = 2
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires an auditable draw or resolved blind correction'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_final_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND (
        allocation.status NOT IN (
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
        OR allocation.updated_at_ms > NEW.completed_at_ms
        OR (
          SELECT COUNT(*)
          FROM free_agent_draft_allocation_events
          WHERE free_agent_draft_allocation_events.league_id =
              allocation.league_id
            AND free_agent_draft_allocation_events.season_id =
              allocation.season_id
            AND free_agent_draft_allocation_events.fad_id =
              allocation.fad_id
            AND free_agent_draft_allocation_events.allocation_id =
              allocation.id
            AND free_agent_draft_allocation_events.player_id =
              allocation.player_id
            AND free_agent_draft_allocation_events.allocation_version =
              allocation.version
            AND free_agent_draft_allocation_events
              .resulting_allocation_status = allocation.status
            AND free_agent_draft_allocation_events.decision_code IS
              allocation.decision_code
            AND free_agent_draft_allocation_events.contract_id IS
              allocation.contract_id
            AND free_agent_draft_allocation_events.ownership_id IS
              allocation.ownership_id
            AND free_agent_draft_allocation_events.occurred_at_ms =
              allocation.updated_at_ms
            AND free_agent_draft_allocation_events.event_kind IN (
              'decision_recorded',
              'restricted_state_changed',
              'fallback_state_changed',
              'correction_applied'
            )
        ) <> 1
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires every allocation to be terminal and current'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.window_kind = 'initial'
  ) <> 7 OR EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        free_agent_draft_rollovers.status <> 'completed'
        OR free_agent_draft_rollovers.completed_at_ms >
          NEW.completed_at_ms
      )
  ) OR (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
  ) <> (
    SELECT MAX(sequence)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD completion requires seven initial and every contiguous extension rollover'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_nomination_queue
    WHERE free_agent_draft_nomination_queue.league_id =
        NEW.league_id
      AND free_agent_draft_nomination_queue.season_id =
        NEW.season_id
      AND free_agent_draft_nomination_queue.fad_id = NEW.id
      AND free_agent_draft_nomination_queue.status = 'queued'
  ) OR EXISTS (
    SELECT 1
    FROM free_agent_draft_recoveries
    WHERE free_agent_draft_recoveries.league_id = NEW.league_id
      AND free_agent_draft_recoveries.season_id = NEW.season_id
      AND free_agent_draft_recoveries.fad_id = NEW.id
      AND free_agent_draft_recoveries.status <> 'resolved'
  ) THEN RAISE(
    ABORT,
    'FAD completion requires no queued work or unresolved recovery'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':deadline:' ||
          NEW.candidate_deadline_at_ms
      AND job_runs.scheduled_for_ms = NEW.candidate_deadline_at_ms
      AND job_runs.status IN ('succeeded', 'skipped')
      AND job_runs.attempt_count >= 1
      AND job_runs.completed_at_ms <= NEW.completed_at_ms
      AND job_runs.completed_at_ms = job_runs.updated_at_ms
      AND job_runs.lease_owner IS NULL
      AND job_runs.lease_token IS NULL
      AND job_runs.lease_expires_at_ms IS NULL
      AND job_runs.last_error_code IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD completion requires its terminal deadline occurrence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id = allocation.league_id
          AND job_runs.season_id = allocation.season_id
          AND job_runs.job_type = 'fad_allocation'
          AND job_runs.occurrence_key =
            'fad:' || allocation.fad_id || ':allocate:' ||
              allocation.player_id
          AND job_runs.scheduled_for_ms =
            NEW.candidate_deadline_at_ms
          AND job_runs.attempt_count >= 1
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.completed_at_ms = job_runs.updated_at_ms
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND (
            (
              job_runs.status IN ('succeeded', 'skipped')
              AND job_runs.last_error_code IS NULL
            )
            OR (
              job_runs.status = 'failed'
              AND job_runs.last_error_code IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries
                WHERE free_agent_draft_recoveries.league_id =
                    allocation.league_id
                  AND free_agent_draft_recoveries.season_id =
                    allocation.season_id
                  AND free_agent_draft_recoveries.fad_id =
                    allocation.fad_id
                  AND free_agent_draft_recoveries.allocation_id =
                    allocation.id
                  AND free_agent_draft_recoveries.player_id =
                    allocation.player_id
                  AND free_agent_draft_recoveries.job_run_id =
                    job_runs.id
                  AND free_agent_draft_recoveries.kind =
                    'allocation_retry'
                  AND free_agent_draft_recoveries.status = 'resolved'
                  AND free_agent_draft_recoveries.resolved_at_ms <=
                    NEW.completed_at_ms
              )
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires terminal allocation occurrences'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers AS rollover
    WHERE rollover.league_id = NEW.league_id
      AND rollover.season_id = NEW.season_id
      AND rollover.fad_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id = rollover.league_id
          AND job_runs.season_id = rollover.season_id
          AND job_runs.job_type = 'fad_rollover'
          AND job_runs.occurrence_key =
            'fad:' || rollover.fad_id || ':rollover:' ||
              rollover.sequence || ':' || rollover.rolls_over_at_ms
          AND job_runs.scheduled_for_ms = rollover.rolls_over_at_ms
          AND job_runs.attempt_count >= 1
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.completed_at_ms = job_runs.updated_at_ms
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND (
            (
              job_runs.status IN ('succeeded', 'skipped')
              AND job_runs.last_error_code IS NULL
            )
            OR (
              job_runs.status = 'failed'
              AND job_runs.last_error_code IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries
                WHERE free_agent_draft_recoveries.league_id =
                    rollover.league_id
                  AND free_agent_draft_recoveries.season_id =
                    rollover.season_id
                  AND free_agent_draft_recoveries.fad_id =
                    rollover.fad_id
                  AND free_agent_draft_recoveries.rollover_id =
                    rollover.id
                  AND free_agent_draft_recoveries.job_run_id =
                    job_runs.id
                  AND free_agent_draft_recoveries.kind =
                    'rollover_finalize'
                  AND free_agent_draft_recoveries.status = 'resolved'
                  AND free_agent_draft_recoveries.resolved_at_ms <=
                    NEW.completed_at_ms
              )
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires terminal rollover occurrences'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_completion'
      AND job_runs.occurrence_key = 'fad:' || NEW.id || ':complete'
      AND job_runs.scheduled_for_ms <= NEW.completed_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms > NEW.completed_at_ms
      AND job_runs.completed_at_ms IS NULL
      AND job_runs.last_error_code IS NULL
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD completion requires its exact durable occurrence'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_resolution_job_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN auction_resolutions
      ON auction_resolutions.league_id = auction_contexts.league_id
     AND auction_resolutions.season_id = auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND auction_resolutions.outcome_code IN (
        'winner',
        'no_winner'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id = auction_contexts.league_id
          AND job_runs.season_id = auction_contexts.season_id
          AND job_runs.job_type = 'auction.resolve.target'
          AND job_runs.occurrence_key =
            auction_resolutions.scheduled_occurrence_key
          AND job_runs.occurrence_key =
            'auction:' || auctions.id || ':' ||
              auctions.resolves_at_ms
          AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
          AND job_runs.status = 'succeeded'
          AND job_runs.attempt_count >= 1
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.started_at_ms IS NOT NULL
          AND job_runs.completed_at_ms >=
            auction_resolutions.resolved_at_ms
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND CASE
                WHEN
                  json_valid(job_runs.result_json) = 1
                  AND json_type(job_runs.result_json) = 'object'
                THEN
                  (
                    SELECT COUNT(*)
                    FROM json_each(job_runs.result_json)
                  ) = 2
                  AND json_type(
                        job_runs.result_json,
                        '$.auctionId'
                      ) = 'text'
                  AND json_extract(
                        job_runs.result_json,
                        '$.auctionId'
                      ) = auctions.id
                  AND json_type(
                        job_runs.result_json,
                        '$.outcome'
                      ) = 'text'
                  AND json_extract(
                        job_runs.result_json,
                        '$.outcome'
                      ) = CASE auctions.status
                            WHEN 'resolved' THEN 'resolved'
                            WHEN 'no_winner' THEN 'no_winner'
                          END
                ELSE 0
              END
          AND job_runs.last_error_code IS NULL
          AND job_runs.next_attempt_at_ms IS NULL
          AND job_runs.updated_at_ms = job_runs.completed_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires each semantic auction job to succeed'
  ) END;
END;

CREATE TRIGGER seasons_fad_completion_marker_guard
BEFORE UPDATE OF free_agent_draft_completed_at_ms ON seasons
WHEN NEW.free_agent_draft_completed_at_ms IS NOT
  OLD.free_agent_draft_completed_at_ms
BEGIN
  SELECT CASE WHEN NOT (
    OLD.free_agent_draft_completed_at_ms IS NULL
    AND NEW.free_agent_draft_completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.id
        AND free_agent_drafts.status = 'completed'
        AND free_agent_drafts.completed_at_ms =
          NEW.free_agent_draft_completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'season FAD completion marker must match its completed FAD'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_sync_season_completion
AFTER UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  UPDATE seasons
  SET free_agent_draft_completed_at_ms = NEW.completed_at_ms,
      updated_at_ms = CASE
        WHEN updated_at_ms < NEW.completed_at_ms
          THEN NEW.completed_at_ms
        ELSE updated_at_ms
      END,
      version = version + 1
  WHERE seasons.league_id = NEW.league_id
    AND seasons.id = NEW.season_id
    AND seasons.free_agent_draft_completed_at_ms IS NULL;

  SELECT CASE WHEN changes() <> 1 THEN RAISE(
    ABORT,
    'FAD completion must update exactly one season marker'
  ) END;
END;

CREATE TRIGGER candidate_cards_cap_state_insert
BEFORE INSERT ON candidate_cards
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_settings
    WHERE league_settings.league_id = NEW.league_id
      AND (
        (
          NEW.maximum_possible_cap_cents <=
            league_settings.salary_cap_cents
          AND NEW.cap_status = 'compliant'
        )
        OR (
          NEW.maximum_possible_cap_cents >
            league_settings.salary_cap_cents
          AND NEW.cap_status = 'over_cap'
        )
      )
      AND (
        (
          NEW.carried_roster_structural_conflict_count > 0
          AND NEW.allocation_eligibility =
            'excluded_structural_conflict'
          AND NEW.allocation_exclusion_reason =
            'candidate_card_structural_conflict'
        )
        OR (
          NEW.carried_roster_structural_conflict_count = 0
          AND NEW.cap_status = 'compliant'
          AND NEW.allocation_eligibility = 'eligible'
          AND NEW.allocation_exclusion_reason IS NULL
        )
        OR (
          NEW.carried_roster_structural_conflict_count = 0
          AND NEW.cap_status = 'over_cap'
          AND NEW.allocation_eligibility = 'excluded_over_cap'
          AND NEW.allocation_exclusion_reason =
            'candidate_card_over_cap'
        )
      )
  ) THEN RAISE(
    ABORT,
    'Candidate Card cap eligibility is whole-card state'
  ) END;
END;

CREATE TRIGGER candidate_cards_cap_state_update
BEFORE UPDATE OF
  maximum_possible_cap_cents,
  structural_conflict_count,
  carried_roster_structural_conflict_count,
  cap_status,
  allocation_eligibility,
  allocation_exclusion_reason
ON candidate_cards
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_settings
    WHERE league_settings.league_id = NEW.league_id
      AND (
        (
          NEW.maximum_possible_cap_cents <=
            league_settings.salary_cap_cents
          AND NEW.cap_status = 'compliant'
        )
        OR (
          NEW.maximum_possible_cap_cents >
            league_settings.salary_cap_cents
          AND NEW.cap_status = 'over_cap'
        )
      )
      AND (
        (
          NEW.carried_roster_structural_conflict_count > 0
          AND NEW.allocation_eligibility =
            'excluded_structural_conflict'
          AND NEW.allocation_exclusion_reason =
            'candidate_card_structural_conflict'
        )
        OR (
          NEW.carried_roster_structural_conflict_count = 0
          AND NEW.cap_status = 'compliant'
          AND NEW.allocation_eligibility = 'eligible'
          AND NEW.allocation_exclusion_reason IS NULL
        )
        OR (
          NEW.carried_roster_structural_conflict_count = 0
          AND NEW.cap_status = 'over_cap'
          AND NEW.allocation_eligibility = 'excluded_over_cap'
          AND NEW.allocation_exclusion_reason =
            'candidate_card_over_cap'
        )
      )
  ) THEN RAISE(
    ABORT,
    'Candidate Card cap eligibility is whole-card state'
  ) END;
END;

-- Candidate validity remains part of the whole-card summary after an
-- authoritative position or ownership change displaces the row into a
-- conflict. Keep cap projection limited to placed offers, but count every
-- invalid Candidate when the immutable deadline snapshot is created.

DROP TRIGGER candidate_card_snapshots_locked_insert;

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

CREATE TRIGGER candidate_card_snapshots_cap_state_insert
BEFORE INSERT ON candidate_card_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_cards
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.id = NEW.card_id
      AND candidate_cards.structural_conflict_count =
        NEW.structural_conflict_count
      AND candidate_cards.carried_roster_structural_conflict_count =
        NEW.carried_roster_structural_conflict_count
      AND candidate_cards.cap_status = NEW.cap_status
      AND candidate_cards.allocation_eligibility =
        NEW.allocation_eligibility
      AND candidate_cards.allocation_exclusion_reason IS
        NEW.allocation_exclusion_reason
  ) THEN RAISE(
    ABORT,
    'Candidate snapshot must copy whole-card structural and cap eligibility'
  ) END;
END;

CREATE TRIGGER candidate_card_snapshot_entries_cap_state_insert
BEFORE INSERT ON candidate_card_snapshot_entries
BEGIN
  SELECT CASE WHEN NOT (
    (
      NEW.occupant_kind <> 'candidate'
      AND NEW.allocation_eligibility IS NULL
      AND NEW.allocation_exclusion_reason IS NULL
    )
    OR (
      NEW.occupant_kind = 'candidate'
      AND EXISTS (
        SELECT 1
        FROM candidate_card_snapshots
        WHERE candidate_card_snapshots.league_id = NEW.league_id
          AND candidate_card_snapshots.id = NEW.snapshot_id
          AND candidate_card_snapshots.allocation_eligibility =
            NEW.allocation_eligibility
          AND candidate_card_snapshots.allocation_exclusion_reason IS
            NEW.allocation_exclusion_reason
      )
    )
  ) THEN RAISE(
    ABORT,
    'every snapshot candidate must copy the card-wide exclusion'
  ) END;
END;

CREATE TRIGGER candidate_card_revisions_valid_insert
BEFORE INSERT ON candidate_card_revisions
BEGIN
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
    'Candidate revision must match the resulting card version'
  ) END;

  SELECT CASE WHEN
    NEW.action = 'carryover_moved'
    AND NEW.actor_authority = 'system'
  THEN RAISE(
    ABORT,
    'carryover movement requires manager or help-authorized attribution'
  ) END;
END;

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
    AND NEW.created_by_membership_id IS OLD.created_by_membership_id
    AND NEW.created_by_authority IS OLD.created_by_authority
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id = candidate_cards.league_id
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
    AND (
      OLD.entry_kind = 'candidate'
      OR (
        NEW.carryover_ownership_id IS OLD.carryover_ownership_id
        AND NEW.carryover_contract_id IS OLD.carryover_contract_id
        AND NEW.carryover_original_total_value_cents IS
          OLD.carryover_original_total_value_cents
        AND NEW.carryover_original_term_years IS
          OLD.carryover_original_term_years
        AND NEW.carryover_aav_cents IS OLD.carryover_aav_cents
        AND NEW.remaining_years IS OLD.remaining_years
        AND NEW.effective_position_group IS
          OLD.effective_position_group
        AND NEW.placement_state = 'placed'
        AND NEW.conflict_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM player_ownerships
          WHERE player_ownerships.league_id = NEW.league_id
            AND player_ownerships.id = NEW.carryover_ownership_id
            AND player_ownerships.season_id = NEW.season_id
            AND player_ownerships.team_id = NEW.team_id
            AND player_ownerships.player_id = NEW.player_id
            AND player_ownerships.roster_category =
              NEW.source_roster_category
            AND (
              (
                NEW.source_roster_category = 'Active'
                AND NEW.requested_slot_group =
                  NEW.effective_position_group
              )
              OR (
                NEW.source_roster_category = 'Bench'
                AND NEW.requested_slot_group = 'B'
              )
              OR (
                NEW.source_roster_category = 'Injured Reserve'
                AND NEW.requested_slot_group =
                  NEW.effective_position_group
              )
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate entry update violates open-card or carryover move rules'
  ) END;
END;

-- Schedule generations are append-only. A replacement transaction first
-- supersedes the current generation and then inserts the exact new Week 1.

CREATE TRIGGER season_matchup_schedule_generations_valid_insert
BEFORE INSERT ON season_matchup_schedule_generations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'current'
    AND NEW.superseded_at_ms IS NULL
    AND NEW.version = 1
    AND NEW.schedule_version = 1 + COALESCE((
      SELECT MAX(schedule_version)
      FROM season_matchup_schedule_generations
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
    ), 0)
    AND NOT EXISTS (
      SELECT 1
      FROM season_matchup_schedule_generations
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
        AND status = 'current'
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_operations
      WHERE matchup_operations.league_id = NEW.league_id
        AND matchup_operations.season_id = NEW.season_id
        AND matchup_operations.id = NEW.schedule_operation_id
        AND matchup_operations.operation_type = 'schedule_generate'
        AND matchup_operations.status = 'succeeded'
        AND matchup_operations.matchup_week_id IS NULL
        AND matchup_operations.matchup_id IS NULL
        AND matchup_operations.completed_at_ms = NEW.created_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_weeks
      WHERE matchup_weeks.league_id = NEW.league_id
        AND matchup_weeks.season_id = NEW.season_id
        AND matchup_weeks.id = NEW.week_one_matchup_week_id
        AND matchup_weeks.sequence = 1
        AND matchup_weeks.starts_at_ms = NEW.week_one_starts_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'schedule generation requires the next exact succeeded schedule'
  ) END;
END;

CREATE TRIGGER season_matchup_schedule_generations_forward_update
BEFORE UPDATE ON season_matchup_schedule_generations
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'current'
    AND NEW.status = 'superseded'
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.schedule_version IS OLD.schedule_version
    AND NEW.schedule_operation_id IS OLD.schedule_operation_id
    AND NEW.week_one_matchup_week_id IS
      OLD.week_one_matchup_week_id
    AND NEW.week_one_starts_at_ms IS OLD.week_one_starts_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.superseded_at_ms IS NOT NULL
    AND NEW.version = OLD.version + 1
  ) THEN RAISE(
    ABORT,
    'schedule generation may only become superseded once'
  ) END;
END;

-- Immutable lifecycle evidence never disappears after commit.

CREATE TRIGGER season_matchup_schedule_generations_immutable_delete
BEFORE DELETE ON season_matchup_schedule_generations
BEGIN
  SELECT RAISE(ABORT, 'schedule generation evidence is immutable');
END;

CREATE TRIGGER matchup_schedule_command_results_valid_insert
BEFORE INSERT ON matchup_schedule_command_results
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id =
          NEW.idempotency_request_id
        AND idempotency_requests.actor_user_id =
          NEW.actor_user_id
        AND idempotency_requests.operation =
          NEW.idempotency_operation
        AND idempotency_requests.request_hash =
          NEW.request_sha256
        AND idempotency_requests.status = 'started'
        AND idempotency_requests.result_type IS NULL
        AND idempotency_requests.result_id IS NULL
        AND idempotency_requests.completed_at_ms IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id = NEW.actor_membership_id
        AND league_memberships.user_id = NEW.actor_user_id
        AND league_memberships.status = 'active'
    )
    AND (
      (
        NEW.actor_authority = 'commissioner'
        AND EXISTS (
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
        AND EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = NEW.actor_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_operations
      WHERE matchup_operations.league_id = NEW.league_id
        AND matchup_operations.season_id = NEW.season_id
        AND matchup_operations.id = NEW.matchup_operation_id
        AND matchup_operations.operation_type = 'schedule_generate'
        AND matchup_operations.status = 'succeeded'
        AND matchup_operations.matchup_week_id IS NULL
        AND matchup_operations.matchup_id IS NULL
        AND matchup_operations.completed_at_ms = NEW.created_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM seasons
      WHERE seasons.league_id = NEW.league_id
        AND seasons.id = NEW.season_id
        AND seasons.version = NEW.season_version_after
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_weeks
      WHERE matchup_weeks.league_id = NEW.league_id
        AND matchup_weeks.season_id = NEW.season_id
        AND matchup_weeks.id = NEW.week_one_matchup_week_id
        AND matchup_weeks.sequence = 1
        AND matchup_weeks.starts_at_ms =
          NEW.first_week_starts_at_ms
        AND matchup_weeks.version = NEW.week_version_after
    )
    AND EXISTS (
      SELECT 1
      FROM season_matchup_schedule_generations AS new_generation
      WHERE new_generation.league_id = NEW.league_id
        AND new_generation.season_id = NEW.season_id
        AND new_generation.schedule_operation_id =
          NEW.new_schedule_operation_id
        AND new_generation.schedule_version =
          NEW.new_schedule_version
        AND new_generation.week_one_matchup_week_id =
          NEW.week_one_matchup_week_id
        AND new_generation.week_one_starts_at_ms =
          NEW.first_week_starts_at_ms
        AND new_generation.status = 'current'
    )
    AND (
      (
        NEW.action = 'generate'
        AND EXISTS (
          SELECT 1
          FROM seasons
          WHERE seasons.league_id = NEW.league_id
            AND seasons.id = NEW.season_id
            AND seasons.regular_season_starts_at_ms =
              NEW.nhl_regular_season_starts_at_ms
            AND seasons.regular_season_ends_at_ms =
              NEW.nhl_regular_season_ends_at_ms
            AND seasons.fantasy_playoffs_start_at_ms =
              NEW.fantasy_playoffs_start_at_ms
            AND seasons.fantasy_playoffs_end_at_ms =
              NEW.fantasy_playoffs_end_at_ms
        )
      )
      OR (
        NEW.action = 'shift_week_one'
        AND EXISTS (
          SELECT 1
          FROM season_matchup_schedule_generations AS old_generation
          WHERE old_generation.league_id = NEW.league_id
            AND old_generation.season_id = NEW.season_id
            AND old_generation.schedule_operation_id =
              NEW.old_schedule_operation_id
            AND old_generation.schedule_version =
              NEW.old_schedule_version
            AND old_generation.week_one_matchup_week_id =
              NEW.week_one_matchup_week_id
            AND old_generation.week_one_starts_at_ms =
              NEW.previous_first_week_starts_at_ms
            AND old_generation.status = 'superseded'
            AND old_generation.superseded_at_ms =
              NEW.created_at_ms
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'matchup schedule command result must match its exact durable command'
  ) END;
END;

CREATE TRIGGER matchup_schedule_command_results_immutable_update
BEFORE UPDATE ON matchup_schedule_command_results
BEGIN
  SELECT RAISE(ABORT, 'matchup schedule command result is immutable');
END;

CREATE TRIGGER matchup_schedule_command_results_immutable_delete
BEFORE DELETE ON matchup_schedule_command_results
BEGIN
  SELECT RAISE(ABORT, 'matchup schedule command result is immutable');
END;

CREATE TRIGGER idempotency_requests_matchup_schedule_result_update
BEFORE UPDATE ON idempotency_requests
WHEN OLD.result_type = 'matchup_schedule_command'
  OR NEW.result_type = 'matchup_schedule_command'
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'started'
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
    AND NEW.result_type = 'matchup_schedule_command'
    AND NEW.result_id IS NOT NULL
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.completed_at_ms IS NOT NULL
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND EXISTS (
      SELECT 1
      FROM matchup_schedule_command_results
      WHERE matchup_schedule_command_results.league_id =
          NEW.league_id
        AND matchup_schedule_command_results.id = NEW.result_id
        AND matchup_schedule_command_results.idempotency_request_id =
          NEW.id
        AND matchup_schedule_command_results.idempotency_operation =
          NEW.operation
        AND matchup_schedule_command_results.request_sha256 =
          NEW.request_hash
        AND matchup_schedule_command_results.actor_user_id =
          NEW.actor_user_id
        AND matchup_schedule_command_results.created_at_ms =
          NEW.completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'matchup schedule idempotency result is immutable and exact'
  ) END;
END;

CREATE TRIGGER idempotency_requests_matchup_schedule_result_delete
BEFORE DELETE ON idempotency_requests
WHEN OLD.result_type = 'matchup_schedule_command'
  OR EXISTS (
    SELECT 1
    FROM matchup_schedule_command_results
    WHERE matchup_schedule_command_results.league_id =
        OLD.league_id
      AND matchup_schedule_command_results.idempotency_request_id =
        OLD.id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'matchup schedule idempotency evidence cannot be deleted'
  );
END;

CREATE TRIGGER matchup_schedule_job_bindings_valid_insert
BEFORE INSERT ON matchup_schedule_job_bindings
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.job_type LIKE 'matchup:%'
    AND EXISTS (
      SELECT 1
      FROM job_runs
      WHERE job_runs.league_id = NEW.league_id
        AND job_runs.season_id = NEW.season_id
        AND job_runs.id = NEW.job_run_id
        AND job_runs.job_type = NEW.job_type
        AND job_runs.created_at_ms = NEW.created_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM season_matchup_schedule_generations
      WHERE season_matchup_schedule_generations.league_id =
          NEW.league_id
        AND season_matchup_schedule_generations.season_id =
          NEW.season_id
        AND season_matchup_schedule_generations.schedule_operation_id =
          NEW.schedule_operation_id
        AND season_matchup_schedule_generations.schedule_version =
          NEW.schedule_version
    )
    AND EXISTS (
      SELECT 1
      FROM matchup_weeks
      WHERE matchup_weeks.league_id = NEW.league_id
        AND matchup_weeks.season_id = NEW.season_id
        AND matchup_weeks.id = NEW.owning_matchup_week_id
    )
    AND (
      NEW.owning_matchup_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM matchups
        WHERE matchups.league_id = NEW.league_id
          AND matchups.season_id = NEW.season_id
          AND matchups.matchup_week_id =
            NEW.owning_matchup_week_id
          AND matchups.id = NEW.owning_matchup_id
      )
    )
  ) THEN RAISE(
    ABORT,
    'matchup job binding must match one exact schedule generation and job'
  ) END;
END;

CREATE TRIGGER matchup_schedule_job_bindings_immutable_update
BEFORE UPDATE ON matchup_schedule_job_bindings
BEGIN
  SELECT RAISE(ABORT, 'matchup schedule job binding is immutable');
END;

CREATE TRIGGER matchup_schedule_job_bindings_immutable_delete
BEFORE DELETE ON matchup_schedule_job_bindings
BEGIN
  SELECT RAISE(ABORT, 'matchup schedule job binding is immutable');
END;

CREATE TRIGGER entry_draft_rollover_bindings_immutable_delete
BEFORE DELETE ON entry_draft_rollover_bindings
BEGIN
  SELECT RAISE(ABORT, 'rollover binding evidence is immutable');
END;

CREATE TRIGGER season_rollover_occurrences_immutable_delete
BEFORE DELETE ON season_rollover_occurrences
BEGIN
  SELECT RAISE(ABORT, 'rollover occurrence evidence is immutable');
END;

CREATE TRIGGER season_rollover_attempts_immutable_delete
BEFORE DELETE ON season_rollover_attempts
BEGIN
  SELECT RAISE(ABORT, 'rollover attempt evidence is immutable');
END;

CREATE TRIGGER season_rollovers_immutable_update
BEFORE UPDATE ON season_rollovers
BEGIN
  SELECT RAISE(ABORT, 'successful rollover evidence is immutable');
END;

CREATE TRIGGER season_rollovers_immutable_delete
BEFORE DELETE ON season_rollovers
BEGIN
  SELECT RAISE(ABORT, 'successful rollover evidence is immutable');
END;

CREATE TRIGGER season_rollover_items_immutable_update
BEFORE UPDATE ON season_rollover_items
BEGIN
  SELECT RAISE(ABORT, 'rollover manifest items are immutable');
END;

CREATE TRIGGER season_rollover_items_immutable_delete
BEFORE DELETE ON season_rollover_items
BEGIN
  SELECT RAISE(ABORT, 'rollover manifest items are immutable');
END;

CREATE TRIGGER entry_draft_pick_clocks_immutable_delete
BEFORE DELETE ON entry_draft_pick_clocks
BEGIN
  SELECT RAISE(ABORT, 'draft clock generations are immutable history');
END;

CREATE TRIGGER entry_draft_on_clock_trades_immutable_update
BEFORE UPDATE ON entry_draft_on_clock_trades
BEGIN
  SELECT RAISE(ABORT, 'on-clock trade evidence is immutable');
END;

CREATE TRIGGER entry_draft_on_clock_trades_immutable_delete
BEFORE DELETE ON entry_draft_on_clock_trades
BEGIN
  SELECT RAISE(ABORT, 'on-clock trade evidence is immutable');
END;

CREATE TRIGGER entry_draft_schedule_operations_valid_insert
BEFORE INSERT ON entry_draft_schedule_operations
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id = NEW.idempotency_request_id
        AND idempotency_requests.actor_user_id =
          NEW.scheduled_by_user_id
        AND idempotency_requests.operation =
          'entry_draft.schedule.v1'
        AND idempotency_requests.status = 'started'
        AND idempotency_requests.result_type IS NULL
        AND idempotency_requests.result_id IS NULL
        AND idempotency_requests.completed_at_ms IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id =
          NEW.scheduled_by_membership_id
        AND league_memberships.user_id =
          NEW.scheduled_by_user_id
        AND league_memberships.status = 'active'
    )
    AND (
      (
        NEW.scheduled_by_authority = 'commissioner'
        AND EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.scheduled_by_membership_id
        )
      )
      OR (
        NEW.scheduled_by_authority =
          'platform_administrator_as_commissioner'
        AND EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              NEW.scheduled_by_user_id
            AND platform_roles.role =
              'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM entry_drafts
      WHERE entry_drafts.league_id = NEW.league_id
        AND entry_drafts.id = NEW.entry_draft_id
        AND entry_drafts.status = 'ready'
        AND entry_drafts.starts_at_ms =
          NEW.scheduled_starts_at_ms
        AND entry_drafts.version =
          NEW.entry_draft_version_after
    )
    AND EXISTS (
      SELECT 1
      FROM entry_draft_rollover_bindings
      WHERE entry_draft_rollover_bindings.league_id = NEW.league_id
        AND entry_draft_rollover_bindings.id =
          NEW.rollover_binding_id
        AND entry_draft_rollover_bindings.entry_draft_id =
          NEW.entry_draft_id
        AND entry_draft_rollover_bindings.current_rollover_occurrence_id =
          NEW.rollover_occurrence_id
        AND entry_draft_rollover_bindings.current_scheduled_job_run_id =
          NEW.scheduled_job_run_id
        AND entry_draft_rollover_bindings.current_schedule_operation_id =
          NEW.id
        AND entry_draft_rollover_bindings.scheduled_starts_at_ms =
          NEW.scheduled_starts_at_ms
        AND entry_draft_rollover_bindings.scheduled_by_user_id =
          NEW.scheduled_by_user_id
        AND entry_draft_rollover_bindings.scheduled_by_membership_id =
          NEW.scheduled_by_membership_id
        AND entry_draft_rollover_bindings.scheduled_by_authority =
          NEW.scheduled_by_authority
        AND entry_draft_rollover_bindings.status = 'scheduled'
        AND entry_draft_rollover_bindings.version =
          NEW.rollover_binding_version_after
    )
    AND EXISTS (
      SELECT 1
      FROM season_rollover_occurrences
      WHERE season_rollover_occurrences.league_id = NEW.league_id
        AND season_rollover_occurrences.id =
          NEW.rollover_occurrence_id
        AND season_rollover_occurrences.binding_id =
          NEW.rollover_binding_id
        AND season_rollover_occurrences.entry_draft_id =
          NEW.entry_draft_id
        AND season_rollover_occurrences.scheduled_job_run_id =
          NEW.scheduled_job_run_id
        AND season_rollover_occurrences.schedule_operation_id =
          NEW.id
        AND season_rollover_occurrences.scheduled_starts_at_ms =
          NEW.scheduled_starts_at_ms
        AND season_rollover_occurrences.scheduled_by_user_id =
          NEW.scheduled_by_user_id
        AND season_rollover_occurrences.scheduled_by_membership_id =
          NEW.scheduled_by_membership_id
        AND season_rollover_occurrences.scheduled_by_authority =
          NEW.scheduled_by_authority
        AND season_rollover_occurrences.status = 'scheduled'
    )
    AND EXISTS (
      SELECT 1
      FROM job_runs
      WHERE job_runs.league_id = NEW.league_id
        AND job_runs.id = NEW.scheduled_job_run_id
        AND job_runs.job_type = 'league:entry_draft_rollover'
        AND job_runs.scheduled_for_ms = NEW.scheduled_starts_at_ms
        AND job_runs.status = 'pending'
        AND job_runs.attempt_count = 0
        AND job_runs.lease_owner IS NULL
        AND job_runs.lease_token IS NULL
        AND job_runs.started_at_ms IS NULL
        AND job_runs.completed_at_ms IS NULL
        AND job_runs.version = NEW.scheduled_job_version
    )
    AND (
      (
        NEW.action = 'schedule'
        AND NOT EXISTS (
          SELECT 1
          FROM entry_draft_schedule_operations
          WHERE entry_draft_schedule_operations.league_id =
              NEW.league_id
            AND entry_draft_schedule_operations.entry_draft_id =
              NEW.entry_draft_id
        )
      )
      OR (
        NEW.action = 'reschedule'
        AND EXISTS (
          SELECT 1
          FROM season_rollover_occurrences AS prior_occurrence
          JOIN job_runs AS prior_job
            ON prior_job.league_id = prior_occurrence.league_id
           AND prior_job.id = prior_occurrence.scheduled_job_run_id
          WHERE prior_occurrence.league_id = NEW.league_id
            AND prior_occurrence.id =
              NEW.superseded_rollover_occurrence_id
            AND prior_occurrence.binding_id =
              NEW.rollover_binding_id
            AND prior_occurrence.superseded_by_occurrence_id =
              NEW.rollover_occurrence_id
            AND prior_occurrence.status = 'superseded'
            AND prior_job.id = NEW.superseded_job_run_id
            AND prior_job.status = 'skipped'
            AND prior_job.attempt_count = 0
            AND prior_job.lease_owner IS NULL
            AND prior_job.lease_token IS NULL
            AND prior_job.lease_expires_at_ms IS NULL
            AND prior_job.started_at_ms IS NULL
            AND prior_job.completed_at_ms IS NULL
            AND prior_job.result_json IS NULL
            AND prior_job.last_error_code IS NULL
            AND prior_job.next_attempt_at_ms IS NULL
            AND prior_job.version =
              NEW.superseded_job_version_after
            AND prior_job.updated_at_ms = NEW.created_at_ms
            AND EXISTS (
              SELECT 1
              FROM entry_draft_schedule_operations AS prior_operation
              WHERE prior_operation.league_id = NEW.league_id
                AND prior_operation.entry_draft_id =
                  NEW.entry_draft_id
                AND prior_operation.rollover_binding_id =
                  NEW.rollover_binding_id
                AND prior_operation.rollover_occurrence_id =
                  NEW.superseded_rollover_occurrence_id
                AND prior_operation.scheduled_job_run_id =
                  NEW.superseded_job_run_id
                AND prior_operation.scheduled_job_version =
                  NEW.superseded_job_version_before
                AND prior_operation.rollover_binding_version_after =
                  NEW.rollover_binding_version_before
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'Entry Draft schedule result must match its atomic durable plan'
  ) END;
END;

CREATE TRIGGER entry_draft_schedule_operations_immutable_update
BEFORE UPDATE ON entry_draft_schedule_operations
BEGIN
  SELECT RAISE(ABORT, 'Entry Draft schedule results are immutable');
END;

CREATE TRIGGER entry_draft_schedule_operations_immutable_delete
BEFORE DELETE ON entry_draft_schedule_operations
BEGIN
  SELECT RAISE(ABORT, 'Entry Draft schedule results are immutable');
END;

CREATE TRIGGER idempotency_requests_entry_draft_schedule_insert
BEFORE INSERT ON idempotency_requests
WHEN NEW.operation = 'entry_draft.schedule.v1'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.league_id IS NOT NULL
    AND NEW.request_hash = lower(NEW.request_hash)
    AND NEW.request_hash NOT GLOB '*[^0-9a-f]*'
    AND NEW.status = 'started'
    AND NEW.result_type IS NULL
    AND NEW.result_id IS NULL
    AND NEW.completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'Entry Draft schedule idempotency must begin started'
  ) END;
END;

CREATE TRIGGER idempotency_requests_entry_draft_schedule_update
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation = 'entry_draft.schedule.v1'
  OR NEW.operation = 'entry_draft.schedule.v1'
BEGIN
  SELECT CASE WHEN NOT (
    OLD.operation = 'entry_draft.schedule.v1'
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
    AND NEW.result_type = 'entry_draft_schedule'
    AND NEW.result_id IS NOT NULL
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.completed_at_ms IS NOT NULL
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND EXISTS (
      SELECT 1
      FROM entry_draft_schedule_operations
      WHERE entry_draft_schedule_operations.league_id =
          NEW.league_id
        AND entry_draft_schedule_operations.id = NEW.result_id
        AND entry_draft_schedule_operations.idempotency_request_id =
          NEW.id
        AND entry_draft_schedule_operations.scheduled_by_user_id =
          NEW.actor_user_id
        AND entry_draft_schedule_operations.created_at_ms =
          NEW.completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'Entry Draft schedule idempotency result is immutable and exact'
  ) END;
END;

CREATE TRIGGER idempotency_requests_entry_draft_schedule_delete
BEFORE DELETE ON idempotency_requests
WHEN OLD.operation = 'entry_draft.schedule.v1'
BEGIN
  SELECT RAISE(
    ABORT,
    'Entry Draft schedule idempotency evidence cannot be deleted'
  );
END;

CREATE TRIGGER idempotency_requests_lifecycle_v2_insert
BEFORE INSERT ON idempotency_requests
WHEN NEW.operation = 'league.lifecycle.transition.v2'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.league_id IS NOT NULL
    AND NEW.status = 'started'
    AND NEW.result_type IS NULL
    AND NEW.result_id IS NULL
    AND NEW.completed_at_ms IS NULL
    AND EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.user_id = NEW.actor_user_id
        AND league_memberships.status = 'active'
        AND (
          EXISTS (
            SELECT 1
            FROM leagues
            WHERE leagues.id = NEW.league_id
              AND leagues.commissioner_membership_id =
                league_memberships.id
          )
          OR EXISTS (
            SELECT 1
            FROM platform_roles
            WHERE platform_roles.user_id = NEW.actor_user_id
              AND platform_roles.role = 'platform_administrator'
              AND platform_roles.status = 'active'
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'lifecycle v2 retry requires a current commissioner request'
  ) END;
END;

CREATE TRIGGER fad_setup_exemptions_t037_evidence_insert
BEFORE INSERT ON free_agent_draft_setup_exemptions
BEGIN
  SELECT CASE WHEN NOT (
    NEW.idempotency_request_id IS NOT NULL
    AND NEW.migration_report_sha256 IS NOT NULL
    AND NEW.bootstrap_identity_sha256 IS NOT NULL
    AND NEW.bootstrap_idempotency_request_id IS NOT NULL
    AND NEW.bootstrap_activity_id IS NOT NULL
    AND NEW.bootstrap_security_audit_event_id IS NOT NULL
    AND NEW.bootstrap_actor_user_id IS NOT NULL
    AND NEW.authorization_activity_id IS NOT NULL
    AND NEW.authorization_security_audit_event_id IS NOT NULL
    AND NEW.commissioner_notification_id IS NOT NULL
    AND NEW.outbox_event_id IS NOT NULL
    AND NEW.created_at_ms = NEW.authorized_at_ms
    AND NEW.updated_at_ms = NEW.authorized_at_ms
    AND NEW.version = 1
    AND NEW.consumed_fad_id IS NULL
    AND NEW.consumed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption requires complete version-1 evidence'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM idempotency_requests
    WHERE idempotency_requests.league_id = NEW.league_id
      AND idempotency_requests.id = NEW.idempotency_request_id
      AND idempotency_requests.actor_user_id =
        NEW.authorized_by_user_id
      AND idempotency_requests.operation =
        'league.lifecycle.transition.v2'
      AND idempotency_requests.status = 'started'
      AND idempotency_requests.result_type IS NULL
      AND idempotency_requests.result_id IS NULL
      AND idempotency_requests.completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption requires its started lifecycle request'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.idempotency_request_id =
      NEW.idempotency_request_id
  ) THEN RAISE(
    ABORT,
    'lifecycle request cannot own both resource types'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN seasons
      ON seasons.league_id = leagues.id
      AND seasons.id = NEW.season_id
    WHERE leagues.id = NEW.league_id
      AND leagues.status IN ('active', 'frozen')
      AND leagues.current_season_id = NEW.season_id
      AND seasons.status = 'active'
      AND seasons.label = '2026'
      AND seasons.nhl_season_key = '20262027'
      AND (
        SELECT COUNT(*)
        FROM seasons AS all_seasons
        WHERE all_seasons.league_id = NEW.league_id
      ) = 1
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption target is not the reset Season 2'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM migration_reports
    WHERE migration_reports.league_id = NEW.league_id
      AND migration_reports.id = NEW.migration_report_id
      AND migration_reports.status = 'succeeded'
      AND migration_reports.completed_at_ms IS NOT NULL
      AND migration_reports.reset_manifest_id =
        '2026-season-1-reset-v1'
      AND migration_reports.database_schema_version >= 1
      AND length(trim(migration_reports.source_bundle_id)) > 0
      AND json_valid(
        migration_reports.source_hashes_json
      ) = 1
      AND json_type(
        migration_reports.source_hashes_json
      ) = 'object'
      AND json_valid(migration_reports.counts_json) = 1
      AND json_type(
        migration_reports.counts_json
      ) = 'object'
      AND json_valid(migration_reports.totals_json) = 1
      AND json_type(
        migration_reports.totals_json
      ) = 'object'
      AND json_valid(migration_reports.warnings_json) = 1
      AND json_type(
        migration_reports.warnings_json
      ) = 'array'
      AND json_valid(migration_reports.rejects_json) = 1
      AND json(migration_reports.rejects_json) = '[]'
  ) OR (
    SELECT COUNT(*)
    FROM migration_reports
    WHERE migration_reports.league_id = NEW.league_id
      AND migration_reports.status = 'succeeded'
      AND migration_reports.completed_at_ms IS NOT NULL
      AND migration_reports.reset_manifest_id =
        '2026-season-1-reset-v1'
      AND migration_reports.database_schema_version >= 1
      AND length(trim(migration_reports.source_bundle_id)) > 0
      AND json_valid(
        migration_reports.source_hashes_json
      ) = 1
      AND json_type(
        migration_reports.source_hashes_json
      ) = 'object'
      AND json_valid(migration_reports.counts_json) = 1
      AND json_type(
        migration_reports.counts_json
      ) = 'object'
      AND json_valid(migration_reports.totals_json) = 1
      AND json_type(
        migration_reports.totals_json
      ) = 'object'
      AND json_valid(migration_reports.warnings_json) = 1
      AND json_type(
        migration_reports.warnings_json
      ) = 'array'
      AND json_valid(migration_reports.rejects_json) = 1
      AND json(migration_reports.rejects_json) = '[]'
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD setup exemption migration report is not exact'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN seasons
      ON seasons.league_id = leagues.id
      AND seasons.id = NEW.season_id
    JOIN idempotency_requests AS bootstrap_request
      ON bootstrap_request.league_id = leagues.id
      AND bootstrap_request.id =
        NEW.bootstrap_idempotency_request_id
    JOIN league_activity AS bootstrap_activity
      ON bootstrap_activity.league_id = leagues.id
      AND bootstrap_activity.id = NEW.bootstrap_activity_id
    JOIN security_audit_events AS bootstrap_audit
      ON bootstrap_audit.league_id = leagues.id
      AND bootstrap_audit.id =
        NEW.bootstrap_security_audit_event_id
    WHERE leagues.id = NEW.league_id
      AND NEW.bootstrap_actor_user_id =
        bootstrap_request.actor_user_id
      AND bootstrap_request.operation =
        'admin.league.bootstrap_reset_original.v1'
      AND bootstrap_request.status = 'completed'
      AND bootstrap_request.result_type = 'league'
      AND bootstrap_request.result_id = NEW.league_id
      AND bootstrap_request.created_at_ms =
        leagues.created_at_ms
      AND bootstrap_request.completed_at_ms =
        leagues.created_at_ms
      AND bootstrap_activity.season_id = NEW.season_id
      AND bootstrap_activity.event_type = 'league_created'
      AND bootstrap_activity.actor_user_id =
        NEW.bootstrap_actor_user_id
      AND bootstrap_activity.actor_authority =
        'platform_administrator'
      AND bootstrap_activity.team_id IS NULL
      AND bootstrap_activity.player_id IS NULL
      AND bootstrap_activity.related_type = 'league'
      AND bootstrap_activity.related_id = NEW.league_id
      AND bootstrap_activity.display_summary =
        leagues.name || ' was created in Setup.'
      AND bootstrap_activity.reason IS NULL
      AND bootstrap_activity.metadata_json =
        '{"leagueStatus":"setup","seasonStatus":"planned"}'
      AND bootstrap_activity.occurred_at_ms =
        leagues.created_at_ms
      AND bootstrap_audit.event_type =
        'system_bootstrap.reset_original_league_created'
      AND bootstrap_audit.outcome = 'success'
      AND bootstrap_audit.actor_user_id =
        NEW.bootstrap_actor_user_id
      AND bootstrap_audit.target_user_id IS NULL
      AND bootstrap_audit.session_id IS NULL
      AND bootstrap_audit.request_correlation_id IS NULL
      AND bootstrap_audit.reason_code =
        'closed_write_reset_handoff'
      AND bootstrap_audit.network_key_version IS NULL
      AND bootstrap_audit.network_metadata_digest IS NULL
      AND bootstrap_audit.client_metadata_json IS NULL
      AND bootstrap_audit.unknown_account_digest IS NULL
      AND bootstrap_audit.occurred_at_ms =
        leagues.created_at_ms
      AND seasons.created_at_ms = leagues.created_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption bootstrap identity is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_activity
    WHERE league_activity.league_id = NEW.league_id
      AND league_activity.id = NEW.authorization_activity_id
      AND league_activity.season_id = NEW.season_id
      AND league_activity.event_type =
        'fad_setup_exemption_authorized'
      AND league_activity.actor_user_id =
        NEW.authorized_by_user_id
      AND league_activity.actor_authority =
        NEW.authorized_authority
      AND league_activity.team_id IS NULL
      AND league_activity.player_id IS NULL
      AND league_activity.related_type = 'season'
      AND league_activity.related_id = NEW.season_id
      AND league_activity.display_summary =
        'Initial Season 2 Free Agent Draft exemption authorized.'
      AND league_activity.reason IS NULL
      AND league_activity.occurred_at_ms =
        NEW.authorized_at_ms
      AND json_valid(league_activity.metadata_json) = 1
      AND json_type(league_activity.metadata_json) = 'object'
      AND json(league_activity.metadata_json) =
        league_activity.metadata_json
      AND (
        SELECT COUNT(*)
        FROM json_each(league_activity.metadata_json)
      ) = 3
      AND json_extract(
        league_activity.metadata_json,
        '$.exemptionId'
      ) = NEW.id
      AND json_extract(
        league_activity.metadata_json,
        '$.seasonId'
      ) = NEW.season_id
      AND json_extract(
        league_activity.metadata_json,
        '$.migrationReportId'
      ) = NEW.migration_report_id
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption activity is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM security_audit_events
    WHERE security_audit_events.id =
      NEW.authorization_security_audit_event_id
      AND security_audit_events.event_type =
        'fad.setup_exemption_authorized'
      AND security_audit_events.outcome = 'success'
      AND security_audit_events.actor_user_id =
        NEW.authorized_by_user_id
      AND security_audit_events.target_user_id IS NULL
      AND security_audit_events.league_id = NEW.league_id
      AND security_audit_events.reason_code =
        'initial_season2_no_draft_authorized'
      AND security_audit_events.occurred_at_ms =
        NEW.authorized_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption security audit is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM notifications
    JOIN leagues
      ON leagues.id = NEW.league_id
    JOIN league_memberships AS commissioner_membership
      ON commissioner_membership.league_id = leagues.id
      AND commissioner_membership.id =
        leagues.commissioner_membership_id
    WHERE notifications.league_id = NEW.league_id
      AND notifications.id = NEW.commissioner_notification_id
      AND commissioner_membership.status = 'active'
      AND notifications.user_id =
        commissioner_membership.user_id
      AND notifications.event_type =
        'fad_setup_exemption_authorized'
      AND notifications.related_feature =
        'free_agent_draft_setup'
      AND notifications.related_record_id = NEW.id
      AND notifications.delivery_status = 'pending'
      AND notifications.created_at_ms = NEW.authorized_at_ms
      AND notifications.read_at_ms IS NULL
      AND notifications.delivered_at_ms IS NULL
      AND notifications.version = 1
      AND notifications.deduplication_key =
        'fad_setup_exemption_authorized:' ||
        NEW.league_id || ':' || NEW.season_id || ':' ||
        NEW.id || ':' || commissioner_membership.user_id
      AND json_valid(notifications.message_data_json) = 1
      AND json_type(
        notifications.message_data_json
      ) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(notifications.message_data_json)
      ) = 3
      AND json_extract(
        notifications.message_data_json,
        '$.leagueId'
      ) = NEW.league_id
      AND json_extract(
        notifications.message_data_json,
        '$.seasonId'
      ) = NEW.season_id
      AND json_extract(
        notifications.message_data_json,
        '$.exemptionId'
      ) = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption notification is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM outbox_events
    WHERE outbox_events.league_id = NEW.league_id
      AND outbox_events.id = NEW.outbox_event_id
      AND outbox_events.event_type = 'league.changed'
      AND outbox_events.aggregate_type = 'league'
      AND outbox_events.aggregate_id = NEW.league_id
      AND outbox_events.status = 'pending'
      AND outbox_events.attempt_count = 0
      AND outbox_events.available_at_ms = NEW.authorized_at_ms
      AND outbox_events.published_at_ms IS NULL
      AND outbox_events.last_error_code IS NULL
      AND outbox_events.created_at_ms = NEW.authorized_at_ms
      AND outbox_events.updated_at_ms = NEW.authorized_at_ms
      AND outbox_events.version = 1
      AND json_valid(outbox_events.payload_json) = 1
      AND json_type(outbox_events.payload_json) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(outbox_events.payload_json)
      ) = 5
      AND json_extract(
        outbox_events.payload_json,
        '$.kind'
      ) = 'invalidation'
      AND json_extract(
        outbox_events.payload_json,
        '$.eventType'
      ) = 'league.changed'
      AND json_extract(
        outbox_events.payload_json,
        '$.scope'
      ) = 'league'
      AND json_extract(
        outbox_events.payload_json,
        '$.scopeId'
      ) = NEW.league_id
      AND json_extract(
        outbox_events.payload_json,
        '$.changedAtMs'
      ) = NEW.authorized_at_ms
      AND (
        SELECT COUNT(*)
        FROM outbox_event_audiences
        WHERE outbox_event_audiences.league_id =
            NEW.league_id
          AND outbox_event_audiences.outbox_event_id =
            NEW.outbox_event_id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM outbox_event_audiences
        WHERE outbox_event_audiences.league_id =
            NEW.league_id
          AND outbox_event_audiences.outbox_event_id =
            NEW.outbox_event_id
          AND outbox_event_audiences.audience_kind =
            'league'
          AND outbox_event_audiences.created_at_ms =
            NEW.authorized_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption outbox evidence is inconsistent'
  ) END;
END;

CREATE TRIGGER idempotency_requests_lifecycle_v2_update
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation = 'league.lifecycle.transition.v2'
  OR NEW.operation = 'league.lifecycle.transition.v2'
BEGIN
  SELECT CASE WHEN NOT (
    OLD.operation = 'league.lifecycle.transition.v2'
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
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.completed_at_ms IS NOT NULL
    AND (
      (
        NEW.status = 'completed'
        AND NEW.result_type = 'season_rollover'
        AND NEW.result_id IS NOT NULL
        AND (
          SELECT COUNT(*)
          FROM season_rollovers
          WHERE season_rollovers.league_id = NEW.league_id
            AND season_rollovers.id = NEW.result_id
            AND season_rollovers.idempotency_request_id =
              NEW.id
            AND season_rollovers.execution_trigger =
              'commissioner_retry'
            AND season_rollovers.executed_by_user_id =
              NEW.actor_user_id
            AND season_rollovers.completed_at_ms =
              NEW.completed_at_ms
            AND season_rollovers.status = 'succeeded'
            AND season_rollovers.version = 1
        ) = 1
      )
      OR (
        NEW.status = 'completed'
        AND NEW.result_type =
          'free_agent_draft_setup_exemption'
        AND NEW.result_id IS NOT NULL
        AND (
          SELECT COUNT(*)
          FROM free_agent_draft_setup_exemptions
          WHERE free_agent_draft_setup_exemptions.league_id =
              NEW.league_id
            AND free_agent_draft_setup_exemptions.id =
              NEW.result_id
            AND free_agent_draft_setup_exemptions
              .idempotency_request_id = NEW.id
            AND free_agent_draft_setup_exemptions
              .authorized_by_user_id = NEW.actor_user_id
            AND free_agent_draft_setup_exemptions
              .authorized_at_ms = NEW.completed_at_ms
            AND free_agent_draft_setup_exemptions.version = 1
            AND free_agent_draft_setup_exemptions
              .consumed_fad_id IS NULL
            AND free_agent_draft_setup_exemptions
              .consumed_at_ms IS NULL
        ) = 1
      )
      OR (
        NEW.status = 'failed'
        AND NEW.result_type IS NULL
        AND NEW.result_id IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'lifecycle v2 retry evidence is immutable or incomplete'
  ) END;
END;

CREATE TRIGGER idempotency_requests_lifecycle_v2_delete
BEFORE DELETE ON idempotency_requests
WHEN OLD.operation = 'league.lifecycle.transition.v2'
  AND OLD.status = 'completed'
BEGIN
  SELECT RAISE(
    ABORT,
    'completed lifecycle v2 replay evidence is immutable'
  );
END;

CREATE TRIGGER free_agent_draft_readiness_operations_immutable_delete
BEFORE DELETE ON free_agent_draft_readiness_operations
BEGIN
  SELECT RAISE(ABORT, 'FAD readiness evidence is immutable');
END;

CREATE TRIGGER free_agent_drafts_immutable_delete
BEFORE DELETE ON free_agent_drafts
BEGIN
  SELECT RAISE(ABORT, 'FAD lifecycle evidence is immutable');
END;

CREATE TRIGGER candidate_card_revisions_immutable_update
BEFORE UPDATE ON candidate_card_revisions
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card revisions are immutable');
END;

CREATE TRIGGER candidate_card_revisions_immutable_delete
BEFORE DELETE ON candidate_card_revisions
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card revisions are immutable');
END;

-- Rapid boundaries are contiguous. The first seven are created together by
-- readiness; every later row proves the durable FAD work that required it.

CREATE TRIGGER free_agent_draft_rollovers_valid_insert
BEFORE INSERT ON free_agent_draft_rollovers
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'scheduled'
    AND NEW.processing_job_run_id IS NULL
    AND NEW.processing_started_at_ms IS NULL
    AND NEW.completed_at_ms IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status IN (
          'cards_open',
          'deadline_locked',
          'allocating',
          'rapid'
        )
        AND NEW.rolls_over_at_ms =
          free_agent_drafts.candidate_deadline_at_ms
          + NEW.sequence * 86400000
    )
    AND (
      (
        NEW.sequence = 1
        AND NEW.window_kind = 'initial'
        AND NEW.predecessor_rollover_id IS NULL
      )
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_rollovers AS predecessor
        WHERE predecessor.league_id = NEW.league_id
          AND predecessor.season_id = NEW.season_id
          AND predecessor.fad_id = NEW.fad_id
          AND predecessor.id = NEW.predecessor_rollover_id
          AND predecessor.sequence = NEW.sequence - 1
          AND predecessor.rolls_over_at_ms = NEW.opens_at_ms
          AND (
            (
              NEW.window_kind = 'initial'
              AND NEW.sequence BETWEEN 2 AND 7
            )
            OR (
              NEW.window_kind = 'extension'
              AND NEW.sequence >= 8
              AND predecessor.status IN (
                'processing',
                'completed',
                'recovery_required'
              )
            )
          )
      )
    )
    AND (
      NEW.window_kind = 'initial'
      OR (
        (
          NEW.extension_reason = 'queued_nomination'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_nomination_queue
            WHERE free_agent_draft_nomination_queue.league_id =
                NEW.league_id
              AND free_agent_draft_nomination_queue.season_id =
                NEW.season_id
              AND free_agent_draft_nomination_queue.fad_id =
                NEW.fad_id
              AND free_agent_draft_nomination_queue.id =
                NEW.extension_source_id
              AND free_agent_draft_nomination_queue.status = 'queued'
              AND free_agent_draft_nomination_queue.target_opening_rollover_id =
                NEW.predecessor_rollover_id
              AND free_agent_draft_nomination_queue.resolution_rollover_id IS NULL
          )
        )
        OR (
          NEW.extension_reason = 'restricted_auction'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_player_allocations
            WHERE free_agent_draft_player_allocations.league_id =
                NEW.league_id
              AND free_agent_draft_player_allocations.season_id =
                NEW.season_id
              AND free_agent_draft_player_allocations.fad_id =
                NEW.fad_id
              AND free_agent_draft_player_allocations.id =
                NEW.extension_source_id
              AND free_agent_draft_player_allocations.status IN (
                'restricted_scheduled',
                'restricted_active'
              )
          )
        )
        OR (
          NEW.extension_reason = 'fallback_auction'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_player_allocations
            WHERE free_agent_draft_player_allocations.league_id =
                NEW.league_id
              AND free_agent_draft_player_allocations.season_id =
                NEW.season_id
              AND free_agent_draft_player_allocations.fad_id =
                NEW.fad_id
              AND free_agent_draft_player_allocations.id =
                NEW.extension_source_id
              AND free_agent_draft_player_allocations.status =
                'restricted_fallback_open'
          )
        )
        OR (
          NEW.extension_reason = 'recovery'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries
            WHERE free_agent_draft_recoveries.league_id =
                NEW.league_id
              AND free_agent_draft_recoveries.season_id =
                NEW.season_id
              AND free_agent_draft_recoveries.fad_id = NEW.fad_id
              AND free_agent_draft_recoveries.id =
                NEW.extension_source_id
              AND free_agent_draft_recoveries.status <>
                'resolved'
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rollover must be the next contiguous justified boundary'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_forward_update
BEFORE UPDATE ON free_agent_draft_rollovers
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.sequence IS OLD.sequence
    AND NEW.window_kind IS OLD.window_kind
    AND NEW.predecessor_rollover_id IS OLD.predecessor_rollover_id
    AND NEW.extension_reason IS OLD.extension_reason
    AND NEW.extension_source_id IS OLD.extension_source_id
    AND NEW.opens_at_ms IS OLD.opens_at_ms
    AND NEW.creation_cutoff_at_ms IS OLD.creation_cutoff_at_ms
    AND NEW.rolls_over_at_ms IS OLD.rolls_over_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'scheduled'
        AND NEW.status = 'processing'
        AND NEW.processing_job_run_id IS NOT NULL
        AND NEW.processing_started_at_ms = NEW.updated_at_ms
        AND NEW.processing_started_at_ms >= NEW.rolls_over_at_ms
        AND NEW.completed_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.season_id = NEW.season_id
            AND job_runs.id = NEW.processing_job_run_id
            AND job_runs.job_type = 'fad_rollover'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':rollover:' ||
                NEW.sequence || ':' || NEW.rolls_over_at_ms
            AND job_runs.scheduled_for_ms = NEW.rolls_over_at_ms
            AND job_runs.status = 'running'
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND length(trim(job_runs.lease_owner)) > 0
            AND job_runs.lease_token IS NOT NULL
            AND length(trim(job_runs.lease_token)) > 0
            AND job_runs.lease_expires_at_ms >
              NEW.processing_started_at_ms
            AND job_runs.started_at_ms IS NOT NULL
            AND job_runs.started_at_ms <=
              NEW.processing_started_at_ms
            AND job_runs.updated_at_ms <=
              NEW.processing_started_at_ms
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms IS NULL
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status IN ('completed', 'recovery_required')
        AND NEW.processing_job_run_id IS
          OLD.processing_job_run_id
        AND NEW.processing_started_at_ms IS
          OLD.processing_started_at_ms
        AND NEW.completed_at_ms = NEW.updated_at_ms
        AND (
          (
            NEW.status = 'completed'
            AND NEW.last_error_code IS NULL
          )
          OR (
            NEW.status = 'recovery_required'
            AND NEW.last_error_code IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_recoveries
              WHERE free_agent_draft_recoveries.league_id =
                  NEW.league_id
                AND free_agent_draft_recoveries.fad_id =
                  NEW.fad_id
                AND free_agent_draft_recoveries.rollover_id =
                  NEW.id
                AND free_agent_draft_recoveries.status <>
                  'resolved'
            )
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rollover may only process and reach durable terminal evidence'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_immutable_delete
BEFORE DELETE ON free_agent_draft_rollovers
BEGIN
  SELECT RAISE(ABORT, 'FAD rollover evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_nomination_queue_valid_insert
BEFORE INSERT ON free_agent_draft_nomination_queue
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'queued'
    AND NEW.resolution_rollover_id IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.accepted_at_ms
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status = 'rapid'
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_rollovers
      WHERE free_agent_draft_rollovers.league_id = NEW.league_id
        AND free_agent_draft_rollovers.season_id = NEW.season_id
        AND free_agent_draft_rollovers.fad_id = NEW.fad_id
        AND free_agent_draft_rollovers.id =
          NEW.source_rollover_id
        AND free_agent_draft_rollovers.id =
          NEW.target_opening_rollover_id
        AND free_agent_draft_rollovers.status IN (
          'scheduled',
          'processing'
        )
        AND NEW.accepted_at_ms >=
          free_agent_draft_rollovers.creation_cutoff_at_ms
        AND NEW.accepted_at_ms <
          free_agent_draft_rollovers.rolls_over_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM teams
      WHERE teams.league_id = NEW.league_id
        AND teams.id = NEW.team_id
        AND teams.status = 'active'
        AND teams.version = NEW.team_version_observed
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.season_id = NEW.season_id
        AND candidate_cards.fad_id = NEW.fad_id
        AND candidate_cards.team_id = NEW.team_id
        AND candidate_cards.version =
          NEW.candidate_card_version_observed
    )
    AND EXISTS (
      SELECT 1
      FROM team_manager_assignments
      JOIN league_memberships
        ON league_memberships.league_id =
            team_manager_assignments.league_id
       AND league_memberships.id =
            team_manager_assignments.membership_id
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.membership_id =
          NEW.submitted_by_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
        AND league_memberships.user_id =
          NEW.submitted_by_user_id
        AND league_memberships.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM player_ownerships
      WHERE player_ownerships.league_id = NEW.league_id
        AND player_ownerships.season_id = NEW.season_id
        AND player_ownerships.player_id = NEW.player_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.player_id = NEW.player_id
        AND auctions.status IN ('open', 'resolving')
    )
  ) THEN RAISE(
    ABORT,
    'final-hour nomination must privately bind the active opening boundary'
  ) END;
END;

CREATE TRIGGER free_agent_draft_nomination_queue_forward_update
BEFORE UPDATE ON free_agent_draft_nomination_queue
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'queued'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.source_rollover_id IS OLD.source_rollover_id
    AND NEW.target_opening_rollover_id IS
      OLD.target_opening_rollover_id
    AND NEW.opening_total_value_cents IS
      OLD.opening_total_value_cents
    AND NEW.opening_term_years IS OLD.opening_term_years
    AND NEW.opening_aav_cents IS OLD.opening_aav_cents
    AND NEW.binding_illegality_confirmed IS
      OLD.binding_illegality_confirmed
    AND NEW.binding_confirmed_at_ms IS
      OLD.binding_confirmed_at_ms
    AND NEW.submitted_by_user_id IS OLD.submitted_by_user_id
    AND NEW.submitted_by_membership_id IS
      OLD.submitted_by_membership_id
    AND NEW.accepted_at_ms IS OLD.accepted_at_ms
    AND NEW.candidate_card_version_observed IS
      OLD.candidate_card_version_observed
    AND NEW.team_version_observed IS OLD.team_version_observed
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        NEW.status = 'invalid'
        AND NEW.resolution_rollover_id IS NULL
        AND NEW.opened_auction_id IS NULL
        AND NEW.opened_starter_bid_id IS NULL
        AND NEW.opened_at_ms IS NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.validation_code IS NOT NULL
      )
      OR (
        NEW.status = 'opened'
        AND NEW.resolution_rollover_id IS NOT NULL
        AND NEW.opened_at_ms = NEW.updated_at_ms
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.validation_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers AS opening_rollover
          JOIN free_agent_draft_rollovers AS resolution_rollover
            ON resolution_rollover.league_id =
                opening_rollover.league_id
           AND resolution_rollover.season_id =
                opening_rollover.season_id
           AND resolution_rollover.fad_id =
                opening_rollover.fad_id
          WHERE opening_rollover.league_id = NEW.league_id
            AND opening_rollover.season_id = NEW.season_id
            AND opening_rollover.fad_id = NEW.fad_id
            AND opening_rollover.id =
              NEW.target_opening_rollover_id
            AND opening_rollover.rolls_over_at_ms =
              NEW.opened_at_ms
            AND resolution_rollover.id =
              NEW.resolution_rollover_id
            AND resolution_rollover.sequence =
              opening_rollover.sequence + 1
            AND resolution_rollover.opens_at_ms =
              opening_rollover.rolls_over_at_ms
            AND resolution_rollover.rolls_over_at_ms =
              opening_rollover.rolls_over_at_ms + 86400000
        )
        AND EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.auction_id = auctions.id
          WHERE auctions.league_id = NEW.league_id
            AND auctions.season_id = NEW.season_id
            AND auctions.id = NEW.opened_auction_id
            AND auctions.player_id = NEW.player_id
            AND auctions.status = 'open'
            AND auctions.opened_at_ms = NEW.opened_at_ms
            AND auctions.resolves_at_ms = (
              SELECT rolls_over_at_ms
              FROM free_agent_draft_rollovers
              WHERE league_id = NEW.league_id
                AND id = NEW.resolution_rollover_id
            )
            AND auctions.opened_by_user_id =
              NEW.submitted_by_user_id
            AND auction_contexts.season_id = NEW.season_id
            AND auction_contexts.source_kind = 'fad_open_rapid'
            AND auction_contexts.fad_id = NEW.fad_id
            AND auction_contexts.fad_rollover_id =
              NEW.resolution_rollover_id
            AND auction_contexts.fad_allocation_id IS NULL
            AND auction_contexts.fad_origin = 'queued_nomination'
        )
        AND EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = NEW.league_id
            AND auction_bids.season_id = NEW.season_id
            AND auction_bids.id = NEW.opened_starter_bid_id
            AND auction_bids.auction_id = NEW.opened_auction_id
            AND auction_bids.team_id = NEW.team_id
            AND auction_bids.submitted_by_user_id =
              NEW.submitted_by_user_id
            AND auction_bids.total_value_cents =
              NEW.opening_total_value_cents
            AND auction_bids.term_years =
              NEW.opening_term_years
            AND auction_bids.lowest_offered_aav_cents =
              NEW.opening_aav_cents
            AND auction_bids.first_submitted_at_ms =
              NEW.accepted_at_ms
            AND auction_bids.last_edited_at_ms =
              NEW.accepted_at_ms
            AND auction_bids.edit_count = 0
            AND auction_bids.status = 'active'
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'queued nomination may only open atomically or record objective invalidity'
  ) END;
END;

CREATE TRIGGER free_agent_draft_nomination_queue_immutable_delete
BEFORE DELETE ON free_agent_draft_nomination_queue
BEGIN
  SELECT RAISE(ABORT, 'private nomination queue evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_allocations_pending_insert
BEFORE INSERT ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'pending'
    AND NEW.decision_code IS NULL
    AND NEW.winning_snapshot_entry_id IS NULL
    AND NEW.winning_team_id IS NULL
    AND NEW.contract_id IS NULL
    AND NEW.ownership_id IS NULL
    AND NEW.restricted_auction_id IS NULL
    AND NEW.fallback_open_auction_id IS NULL
    AND NEW.restricted_minimum_total_cents IS NULL
    AND NEW.restricted_minimum_term_years IS NULL
    AND NEW.restricted_minimum_aav_cents IS NULL
    AND NEW.accounted_at_ms IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status IN (
          'deadline_locked',
          'allocating'
        )
    )
  ) THEN RAISE(
    ABORT,
    'allocation must begin as uncommitted per-player work'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_forward_update
BEFORE UPDATE ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'pending'
        AND NEW.status = 'automatic_award'
        AND NEW.decision_code IN (
          'sole_valid_offer',
          'highest_total',
          'highest_equal_total_aav'
        )
        AND NEW.winning_snapshot_entry_id IS NOT NULL
        AND NEW.winning_team_id IS NOT NULL
        AND NEW.contract_id IS NOT NULL
        AND NEW.ownership_id IS NOT NULL
        AND NEW.restricted_auction_id IS NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NULL
        AND NEW.restricted_minimum_term_years IS NULL
        AND NEW.restricted_minimum_aav_cents IS NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'pending'
        AND NEW.status IN (
          'restricted_scheduled',
          'restricted_active'
        )
        AND NEW.decision_code = 'exact_total_and_term_tie'
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.restricted_auction_id IS NOT NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NOT NULL
        AND NEW.restricted_minimum_term_years IS NOT NULL
        AND NEW.restricted_minimum_aav_cents IS NOT NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND (
          (
            NEW.status = 'restricted_active'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN free_agent_draft_rollovers AS current_rollover
                ON current_rollover.league_id = auctions.league_id
               AND current_rollover.season_id = auctions.season_id
               AND current_rollover.fad_id = NEW.fad_id
               AND current_rollover.rolls_over_at_ms =
                    auctions.resolves_at_ms
              WHERE auctions.league_id = NEW.league_id
                AND auctions.season_id = NEW.season_id
                AND auctions.id = NEW.restricted_auction_id
                AND auctions.player_id = NEW.player_id
                AND auctions.status = 'open'
                AND auctions.opened_at_ms = NEW.updated_at_ms
                AND current_rollover.status IN (
                  'scheduled',
                  'processing'
                )
                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.creation_cutoff_at_ms
            )
          )
          OR (
            NEW.status = 'restricted_scheduled'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN free_agent_draft_rollovers AS target_rollover
                ON target_rollover.league_id = auctions.league_id
               AND target_rollover.season_id = auctions.season_id
               AND target_rollover.fad_id = NEW.fad_id
               AND target_rollover.rolls_over_at_ms =
                    auctions.resolves_at_ms
              JOIN free_agent_draft_rollovers AS current_rollover
                ON current_rollover.league_id =
                    target_rollover.league_id
               AND current_rollover.season_id =
                    target_rollover.season_id
               AND current_rollover.fad_id =
                    target_rollover.fad_id
               AND current_rollover.id =
                    target_rollover.predecessor_rollover_id
               AND current_rollover.sequence =
                    target_rollover.sequence - 1
              WHERE auctions.league_id = NEW.league_id
                AND auctions.season_id = NEW.season_id
                AND auctions.id = NEW.restricted_auction_id
                AND auctions.player_id = NEW.player_id
                AND auctions.status = 'open'
                AND auctions.opened_at_ms =
                  target_rollover.opens_at_ms
                AND target_rollover.status = 'scheduled'
                AND target_rollover.opens_at_ms =
                  current_rollover.rolls_over_at_ms
                AND current_rollover.status IN (
                  'scheduled',
                  'processing'
                )
                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms >=
                  current_rollover.creation_cutoff_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.rolls_over_at_ms
            )
          )
        )
      )
      OR (
        OLD.status = 'pending'
        AND NEW.status IN ('no_valid_offer', 'invalid')
        AND NEW.decision_code IN (
          'no_valid_offer',
          'invalid_snapshot',
          'candidate_card_structural_conflict',
          'candidate_card_over_cap'
        )
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.restricted_auction_id IS NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NULL
        AND NEW.restricted_minimum_term_years IS NULL
        AND NEW.restricted_minimum_aav_cents IS NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
      )
      OR (
        OLD.status = 'restricted_scheduled'
        AND NEW.status = 'restricted_active'
        AND NEW.decision_code IS OLD.decision_code
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.season_id = auctions.season_id
           AND auction_contexts.auction_id = auctions.id
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auction_contexts.league_id
           AND free_agent_draft_rollovers.season_id =
                auction_contexts.season_id
           AND free_agent_draft_rollovers.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_rollovers.id =
                auction_contexts.fad_rollover_id
          JOIN job_runs
            ON job_runs.league_id = auctions.league_id
           AND job_runs.season_id = auctions.season_id
           AND job_runs.job_type = 'fad_restricted_activation'
           AND job_runs.occurrence_key =
                'fad:' || OLD.fad_id || ':restricted-activate:' ||
                  OLD.id || ':' || auctions.opened_at_ms
           AND job_runs.scheduled_for_ms = auctions.opened_at_ms
          WHERE auctions.league_id = OLD.league_id
            AND auctions.season_id = OLD.season_id
            AND auctions.id = OLD.restricted_auction_id
            AND auctions.player_id = OLD.player_id
            AND auctions.status = 'open'
            AND auctions.opened_at_ms <= NEW.updated_at_ms
            AND NEW.updated_at_ms < auctions.resolves_at_ms
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = OLD.fad_id
            AND auction_contexts.fad_allocation_id = OLD.id
            AND auction_contexts.fad_origin = 'candidate_tie_restricted'
            AND free_agent_draft_rollovers.opens_at_ms =
                auctions.opened_at_ms
            AND free_agent_draft_rollovers.rolls_over_at_ms =
                auctions.resolves_at_ms
            AND free_agent_draft_rollovers.status IN (
              'scheduled',
              'processing'
            )
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms > NEW.updated_at_ms
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms IS NULL
        )
      )
      OR (
        OLD.status = 'restricted_active'
        AND NEW.status = 'restricted_fallback_open'
        AND NEW.decision_code =
          'restricted_no_improvement_fallback'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS NOT NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'restricted_active'
        AND NEW.status = 'restricted_resolved'
        AND NEW.decision_code = 'restricted_auction_result'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.winning_snapshot_entry_id IS NOT NULL
        AND NEW.winning_team_id IS NOT NULL
        AND NEW.contract_id IS NOT NULL
        AND NEW.ownership_id IS NOT NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'restricted_fallback_open'
        AND NEW.status = 'fallback_open_resolved'
        AND NEW.decision_code IN (
          'fallback_open_result',
          'fallback_open_no_winner'
        )
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
        AND (
          (
            NEW.decision_code = 'fallback_open_result'
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
          )
          OR (
            NEW.decision_code = 'fallback_open_no_winner'
            AND NEW.winning_snapshot_entry_id IS NULL
            AND NEW.winning_team_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
          )
        )
      )
      OR (
        OLD.status IN (
          'pending',
          'restricted_scheduled',
          'restricted_active',
          'restricted_fallback_open'
        )
        AND NEW.status = 'correction_required'
        AND NEW.decision_code IS OLD.decision_code
        AND NEW.winning_snapshot_entry_id IS
          OLD.winning_snapshot_entry_id
        AND NEW.winning_team_id IS OLD.winning_team_id
        AND NEW.contract_id IS OLD.contract_id
        AND NEW.ownership_id IS OLD.ownership_id
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms IS OLD.accounted_at_ms
        AND NEW.last_error_code IS NOT NULL
      )
      OR (
        OLD.status = 'correction_required'
        AND NEW.status IN (
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
        AND NEW.decision_code = 'corrected'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM commissioner_corrections
          JOIN leagues
            ON leagues.id = commissioner_corrections.league_id
          JOIN league_memberships
            ON league_memberships.league_id = leagues.id
           AND league_memberships.id =
                leagues.commissioner_membership_id
           AND league_memberships.user_id =
                commissioner_corrections.actor_user_id
          WHERE commissioner_corrections.league_id = NEW.league_id
            AND commissioner_corrections.season_id = NEW.season_id
            AND commissioner_corrections.feature =
                'free_agent_draft_allocation'
            AND commissioner_corrections.feature_record_id = NEW.id
            AND commissioner_corrections.corrected_at_ms =
                NEW.updated_at_ms
            AND json_extract(
                  commissioner_corrections.before_snapshot_json,
                  '$.status'
                ) = 'correction_required'
            AND json_extract(
                  commissioner_corrections.after_snapshot_json,
                  '$.status'
                ) = NEW.status
            AND json_extract(
                  commissioner_corrections.after_snapshot_json,
                  '$.decisionCode'
                ) = 'corrected'
            AND league_memberships.permission_category = 'commissioner'
            AND league_memberships.status = 'active'
        )
        AND (
          NEW.winning_team_id IS NOT NULL
          OR (
            NEW.winning_snapshot_entry_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
          )
        )
      )
    )
    AND (
      NEW.winning_team_id IS NULL
      OR (
        EXISTS (
          SELECT 1
          FROM contracts
          WHERE contracts.league_id = NEW.league_id
            AND contracts.id = NEW.contract_id
            AND contracts.player_id = NEW.player_id
            AND contracts.current_team_id = NEW.winning_team_id
            AND contracts.start_season_id = NEW.season_id
            AND contracts.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM player_ownerships
          WHERE player_ownerships.league_id = NEW.league_id
            AND player_ownerships.id = NEW.ownership_id
            AND player_ownerships.season_id = NEW.season_id
            AND player_ownerships.player_id = NEW.player_id
            AND player_ownerships.team_id = NEW.winning_team_id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'allocation may only follow automatic, restricted, fallback, or quarantine state'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_immutable_delete
BEFORE DELETE ON free_agent_draft_player_allocations
BEGIN
  SELECT RAISE(ABORT, 'allocation decisions are immutable history');
END;

CREATE TRIGGER free_agent_draft_allocation_events_valid_insert
BEFORE INSERT ON free_agent_draft_allocation_events
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.created_at_ms >= NEW.occurred_at_ms
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.season_id =
          NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.fad_id
        AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
        AND free_agent_draft_player_allocations.player_id =
          NEW.player_id
        AND free_agent_draft_player_allocations.version =
          NEW.allocation_version
        AND free_agent_draft_player_allocations.status =
          NEW.resulting_allocation_status
    )
    AND (
      (
        NEW.event_kind = 'offer_considered'
        AND NEW.snapshot_entry_id IS NOT NULL
        AND NEW.team_id IS NOT NULL
        AND NEW.offer_valid IS NOT NULL
        AND NEW.rank_position IS NOT NULL
        AND NEW.offer_outcome_code IS NOT NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.auction_id IS NULL
        AND NEW.correction_id IS NULL
      )
      OR (
        NEW.event_kind <> 'offer_considered'
        AND NEW.offer_valid IS NULL
        AND NEW.rank_position IS NULL
        AND NEW.offer_outcome_code IS NULL
      )
    )
    AND (
      NEW.actor_authority = 'system'
      OR EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = NEW.league_id
          AND league_memberships.id = NEW.actor_membership_id
          AND league_memberships.user_id = NEW.actor_user_id
      )
    )
    AND (
      NEW.event_kind <> 'correction_applied'
      OR (
        NEW.decision_code = 'corrected'
        AND NEW.correction_id IS NOT NULL
        AND NEW.actor_authority IN (
          'commissioner',
          'platform_administrator_as_commissioner'
        )
        AND NEW.snapshot_entry_id IS NULL
        AND NEW.team_id IS NULL
        AND NEW.activity_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations AS allocation
          JOIN commissioner_corrections
            ON commissioner_corrections.league_id = allocation.league_id
           AND commissioner_corrections.id = NEW.correction_id
           AND commissioner_corrections.season_id = allocation.season_id
           AND commissioner_corrections.feature =
                'free_agent_draft_allocation'
           AND commissioner_corrections.feature_record_id = allocation.id
           AND commissioner_corrections.actor_user_id = NEW.actor_user_id
           AND commissioner_corrections.corrected_at_ms =
                NEW.occurred_at_ms
          WHERE allocation.league_id = NEW.league_id
            AND allocation.season_id = NEW.season_id
            AND allocation.fad_id = NEW.fad_id
            AND allocation.id = NEW.allocation_id
            AND allocation.player_id = NEW.player_id
            AND allocation.version = NEW.allocation_version
            AND allocation.status = NEW.resulting_allocation_status
            AND allocation.decision_code = 'corrected'
            AND allocation.contract_id IS NEW.contract_id
            AND allocation.ownership_id IS NEW.ownership_id
            AND allocation.restricted_auction_id IS NEW.auction_id
            AND allocation.accounted_at_ms = NEW.occurred_at_ms
            AND allocation.last_error_code IS NULL
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'allocation event must match the exact resulting aggregate version'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocation_events_immutable_update
BEFORE UPDATE ON free_agent_draft_allocation_events
BEGIN
  SELECT RAISE(ABORT, 'allocation events are immutable');
END;

CREATE TRIGGER free_agent_draft_allocation_events_immutable_delete
BEFORE DELETE ON free_agent_draft_allocation_events
BEGIN
  SELECT RAISE(ABORT, 'allocation events are immutable');
END;

CREATE TRIGGER free_agent_draft_auction_participants_valid_insert
BEFORE INSERT ON free_agent_draft_auction_participants
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'active'
    AND NEW.active_improvement_bid_id IS NULL
    AND NEW.first_improvement_at_ms IS NULL
    AND NEW.current_cooldown_anchor_at_ms IS NULL
    AND NEW.improvement_committed_at_ms IS NULL
    AND NEW.removed_by_user_id IS NULL
    AND NEW.removed_by_membership_id IS NULL
    AND NEW.removed_authority IS NULL
    AND NEW.removal_reason IS NULL
    AND NEW.removed_at_ms IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind = 'fad_restricted'
        AND auction_contexts.fad_id = NEW.fad_id
        AND auction_contexts.fad_allocation_id =
          NEW.allocation_id
        AND auction_contexts.fad_origin =
          'candidate_tie_restricted'
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.season_id =
          NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.fad_id
        AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
        AND free_agent_draft_player_allocations.restricted_auction_id =
          NEW.auction_id
        AND free_agent_draft_player_allocations.status IN (
          'restricted_scheduled',
          'restricted_active'
        )
        AND free_agent_draft_player_allocations.restricted_minimum_total_cents =
          NEW.minimum_total_value_cents
        AND free_agent_draft_player_allocations.restricted_minimum_term_years =
          NEW.minimum_term_years
        AND free_agent_draft_player_allocations.restricted_minimum_aav_cents =
          NEW.minimum_aav_cents
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id =
          NEW.league_id
        AND candidate_card_snapshot_entries.id =
          NEW.source_snapshot_entry_id
        AND candidate_card_snapshot_entries.season_id = NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
        AND candidate_card_snapshot_entries.team_id = NEW.team_id
        AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
        AND candidate_card_snapshot_entries.player_id = (
          SELECT player_id
          FROM free_agent_draft_player_allocations
          WHERE league_id = NEW.league_id
            AND id = NEW.allocation_id
        )
        AND candidate_card_snapshot_entries.proposed_total_value_cents =
          NEW.minimum_total_value_cents
        AND candidate_card_snapshot_entries.proposed_term_years =
          NEW.minimum_term_years
        AND candidate_card_snapshot_entries.proposed_aav_cents =
          NEW.minimum_aav_cents
        AND candidate_card_snapshot_entries.eligibility_status IN (
          'valid',
          'warning'
        )
        AND candidate_card_snapshot_entries.allocation_eligibility =
          'eligible'
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_card_revisions
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            candidate_card_revisions.league_id
       AND candidate_card_snapshot_entries.id =
            NEW.source_snapshot_entry_id
      JOIN candidate_card_snapshots
        ON candidate_card_snapshots.league_id =
            candidate_card_snapshot_entries.league_id
       AND candidate_card_snapshots.id =
            candidate_card_snapshot_entries.snapshot_id
      WHERE candidate_card_revisions.league_id = NEW.league_id
        AND candidate_card_revisions.id =
          NEW.originating_candidate_revision_id
        AND candidate_card_revisions.season_id = NEW.season_id
        AND candidate_card_revisions.fad_id = NEW.fad_id
        AND candidate_card_revisions.team_id = NEW.team_id
        AND candidate_card_revisions.player_id = (
          SELECT player_id
          FROM free_agent_draft_player_allocations
          WHERE league_id = NEW.league_id
            AND id = NEW.allocation_id
        )
        AND candidate_card_revisions.card_id =
          candidate_card_snapshot_entries.card_id
        AND candidate_card_revisions.affected_entry_id =
          candidate_card_snapshot_entries.source_entry_id
        AND candidate_card_revisions.action IN (
          'candidate_added',
          'candidate_edited',
          'candidate_moved'
        )
        AND candidate_card_revisions.resulting_card_version <=
          candidate_card_snapshots.locked_card_version
        AND candidate_card_revisions.actor_user_id =
          NEW.originating_actor_user_id
        AND candidate_card_revisions.actor_membership_id =
          NEW.originating_actor_membership_id
        AND candidate_card_revisions.actor_authority =
          NEW.originating_actor_authority
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_revisions AS later_revision
          WHERE later_revision.league_id =
              candidate_card_revisions.league_id
            AND later_revision.card_id =
              candidate_card_revisions.card_id
            AND later_revision.affected_entry_id =
              candidate_card_revisions.affected_entry_id
            AND later_revision.player_id =
              candidate_card_revisions.player_id
            AND later_revision.action IN (
              'candidate_added',
              'candidate_edited',
              'candidate_moved'
            )
            AND later_revision.resulting_card_version >
              candidate_card_revisions.resulting_card_version
            AND later_revision.resulting_card_version <=
              candidate_card_snapshots.locked_card_version
        )
    )
  ) THEN RAISE(
    ABORT,
    'restricted participant must begin with immutable Candidate minimum and no bid'
  ) END;
END;

CREATE TRIGGER free_agent_draft_auction_participants_forward_update
BEFORE UPDATE ON free_agent_draft_auction_participants
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.source_snapshot_entry_id IS OLD.source_snapshot_entry_id
    AND NEW.originating_candidate_revision_id IS
      OLD.originating_candidate_revision_id
    AND NEW.minimum_total_value_cents IS
      OLD.minimum_total_value_cents
    AND NEW.minimum_term_years IS OLD.minimum_term_years
    AND NEW.minimum_aav_cents IS OLD.minimum_aav_cents
    AND NEW.manager_edit_limit IS OLD.manager_edit_limit
    AND NEW.cooldown_duration_ms IS OLD.cooldown_duration_ms
    AND NEW.originating_actor_user_id IS
      OLD.originating_actor_user_id
    AND NEW.originating_actor_membership_id IS
      OLD.originating_actor_membership_id
    AND NEW.originating_actor_authority IS
      OLD.originating_actor_authority
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'active'
        AND NEW.status = 'active'
        AND NEW.removed_by_user_id IS NULL
        AND NEW.removed_by_membership_id IS NULL
        AND NEW.removed_authority IS NULL
        AND NEW.removal_reason IS NULL
        AND NEW.removed_at_ms IS NULL
        AND NEW.active_improvement_bid_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = NEW.league_id
            AND auction_bids.season_id = NEW.season_id
            AND auction_bids.id =
              NEW.active_improvement_bid_id
            AND auction_bids.auction_id = NEW.auction_id
            AND auction_bids.team_id = NEW.team_id
            AND auction_bids.status = 'active'
            AND (
              auction_bids.total_value_cents >
                NEW.minimum_total_value_cents
              OR (
                auction_bids.total_value_cents =
                  NEW.minimum_total_value_cents
                AND auction_bids.lowest_offered_aav_cents >
                  NEW.minimum_aav_cents
              )
            )
            AND NEW.current_cooldown_anchor_at_ms =
              auction_bids.last_edited_at_ms
            AND NEW.improvement_committed_at_ms =
              auction_bids.last_edited_at_ms
            AND (
              (
                OLD.active_improvement_bid_id IS NULL
                AND NEW.first_improvement_at_ms =
                  auction_bids.first_submitted_at_ms
                AND auction_bids.edit_count = 0
              )
              OR (
                OLD.active_improvement_bid_id =
                  NEW.active_improvement_bid_id
                AND NEW.first_improvement_at_ms =
                  OLD.first_improvement_at_ms
              )
            )
        )
      )
      OR (
        OLD.status = 'active'
        AND NEW.status = 'removed'
        AND NEW.active_improvement_bid_id IS NULL
        AND NEW.first_improvement_at_ms IS
          OLD.first_improvement_at_ms
        AND NEW.current_cooldown_anchor_at_ms IS
          OLD.current_cooldown_anchor_at_ms
        AND NEW.improvement_committed_at_ms IS
          OLD.improvement_committed_at_ms
        AND NEW.removed_by_user_id IS NOT NULL
        AND NEW.removed_by_membership_id IS NOT NULL
        AND NEW.removed_authority IS NOT NULL
        AND NEW.removed_at_ms = NEW.updated_at_ms
        AND OLD.active_improvement_bid_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM auction_events
          JOIN auctions
            ON auctions.league_id = auction_events.league_id
           AND auctions.season_id = auction_events.season_id
           AND auctions.id = auction_events.auction_id
          JOIN auction_contexts
            ON auction_contexts.league_id =
                auction_events.league_id
           AND auction_contexts.season_id =
                auction_events.season_id
           AND auction_contexts.auction_id =
                auction_events.auction_id
          JOIN free_agent_draft_player_allocations
            ON free_agent_draft_player_allocations.league_id =
                auction_contexts.league_id
           AND free_agent_draft_player_allocations.season_id =
                auction_contexts.season_id
           AND free_agent_draft_player_allocations.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_player_allocations.id =
                auction_contexts.fad_allocation_id
          JOIN auction_bids
            ON auction_bids.league_id = auction_events.league_id
           AND auction_bids.season_id = auction_events.season_id
           AND auction_bids.id = auction_events.bid_id
           AND auction_bids.auction_id =
                auction_events.auction_id
           AND auction_bids.team_id = auction_events.team_id
          JOIN league_memberships
            ON league_memberships.league_id =
                auction_events.league_id
           AND league_memberships.id =
                NEW.removed_by_membership_id
           AND league_memberships.user_id =
                auction_events.actor_user_id
          WHERE auction_events.league_id = NEW.league_id
            AND auction_events.season_id = NEW.season_id
            AND auction_events.auction_id = NEW.auction_id
            AND auction_events.bid_id =
              OLD.active_improvement_bid_id
            AND auction_events.team_id = NEW.team_id
            AND auction_events.actor_user_id =
              NEW.removed_by_user_id
            AND auction_events.event_type =
              'commissioner_bid_removed'
            AND auction_events.occurred_at_ms =
              NEW.removed_at_ms
            AND json_valid(auction_events.metadata_json) = 1
            AND json_extract(
              auction_events.metadata_json,
              '$.actorMembershipId'
            ) = NEW.removed_by_membership_id
            AND json_extract(
              auction_events.metadata_json,
              '$.actorAuthority'
            ) = NEW.removed_authority
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = NEW.fad_id
            AND auction_contexts.fad_allocation_id =
              NEW.allocation_id
            AND auctions.status = 'open'
            AND NEW.removed_at_ms >= auctions.opened_at_ms
            AND NEW.removed_at_ms < auctions.resolves_at_ms
            AND free_agent_draft_player_allocations.status =
              'restricted_active'
            AND free_agent_draft_player_allocations
              .restricted_auction_id = NEW.auction_id
            AND auction_bids.status = 'withdrawn'
            AND league_memberships.status = 'active'
            AND (
              (
                NEW.removed_authority = 'commissioner'
                AND EXISTS (
                  SELECT 1
                  FROM leagues
                  WHERE leagues.id = NEW.league_id
                    AND leagues.commissioner_membership_id =
                      NEW.removed_by_membership_id
                )
              )
              OR (
                NEW.removed_authority =
                  'platform_administrator_as_commissioner'
                AND EXISTS (
                  SELECT 1
                  FROM platform_roles
                  WHERE platform_roles.user_id =
                      NEW.removed_by_user_id
                    AND platform_roles.role =
                      'platform_administrator'
                    AND platform_roles.status = 'active'
                )
              )
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'restricted participant requires a current strict improvement or permanent removal'
  ) END;
END;

CREATE TRIGGER free_agent_draft_auction_participants_immutable_delete
BEFORE DELETE ON free_agent_draft_auction_participants
BEGIN
  SELECT RAISE(ABORT, 'restricted participant evidence is immutable');
END;

CREATE VIEW fad_frozen_eligible_bids AS
SELECT
  auction_bids.league_id,
  auction_bids.season_id,
  auction_contexts.fad_id,
  auction_contexts.fad_allocation_id AS allocation_id,
  auction_bids.auction_id,
  auction_bids.id AS bid_id,
  auction_bids.team_id,
  auction_bids.total_value_cents,
  auction_bids.term_years,
  (
    (auction_bids.total_value_cents / auction_bids.term_years)
    + CASE
        WHEN
          (auction_bids.total_value_cents %
            auction_bids.term_years) * 2
              >= auction_bids.term_years
        THEN 1
        ELSE 0
      END
  ) AS aav_cents
FROM auction_bids
JOIN auction_contexts
  ON auction_contexts.league_id = auction_bids.league_id
 AND auction_contexts.season_id = auction_bids.season_id
 AND auction_contexts.auction_id = auction_bids.auction_id
JOIN teams
  ON teams.league_id = auction_bids.league_id
 AND teams.id = auction_bids.team_id
WHERE auction_contexts.source_kind IN (
    'fad_open_rapid',
    'fad_restricted'
  )
  AND auction_bids.status IN ('won', 'lost')
  AND teams.status = 'active'
  AND (
    (
      auction_contexts.source_kind = 'fad_restricted'
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_auction_participants
        WHERE free_agent_draft_auction_participants.league_id =
            auction_bids.league_id
          AND free_agent_draft_auction_participants.auction_id =
            auction_bids.auction_id
          AND free_agent_draft_auction_participants.team_id =
            auction_bids.team_id
          AND free_agent_draft_auction_participants.status = 'active'
          AND free_agent_draft_auction_participants
            .active_improvement_bid_id = auction_bids.id
          AND (
            auction_bids.total_value_cents >
              free_agent_draft_auction_participants
                .minimum_total_value_cents
            OR (
              auction_bids.total_value_cents =
                free_agent_draft_auction_participants
                  .minimum_total_value_cents
              AND (
                (auction_bids.total_value_cents /
                  auction_bids.term_years)
                + CASE
                    WHEN
                      (auction_bids.total_value_cents %
                        auction_bids.term_years) * 2
                          >= auction_bids.term_years
                    THEN 1
                    ELSE 0
                  END
              ) >
                free_agent_draft_auction_participants
                  .minimum_aav_cents
            )
          )
      )
    )
    OR (
      auction_contexts.source_kind = 'fad_open_rapid'
      AND (
        auction_contexts.fad_origin <>
          'restricted_no_improvement_fallback'
        OR EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations
          WHERE free_agent_draft_player_allocations.league_id =
              auction_contexts.league_id
            AND free_agent_draft_player_allocations.id =
              auction_contexts.fad_allocation_id
            AND (
              auction_bids.total_value_cents >
                free_agent_draft_player_allocations
                  .restricted_minimum_total_cents
              OR (
                auction_bids.total_value_cents =
                  free_agent_draft_player_allocations
                    .restricted_minimum_total_cents
                AND (
                  (auction_bids.total_value_cents /
                    auction_bids.term_years)
                  + CASE
                      WHEN
                        (auction_bids.total_value_cents %
                          auction_bids.term_years) * 2
                            >= auction_bids.term_years
                      THEN 1
                      ELSE 0
                    END
                ) >=
                  free_agent_draft_player_allocations
                    .restricted_minimum_aav_cents
              )
            )
        )
      )
    )
  );

CREATE TRIGGER free_agent_draft_draws_valid_insert
BEFORE INSERT ON free_agent_draft_draws
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.revealed_at_ms IS NULL
    AND EXISTS (
      SELECT 1
      FROM auctions
      JOIN auction_contexts
        ON auction_contexts.league_id = auctions.league_id
       AND auction_contexts.auction_id = auctions.id
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.status IN ('open', 'resolving')
        AND auctions.opened_at_ms = NEW.created_at_ms
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
        AND auction_contexts.fad_id = NEW.fad_id
        AND auction_contexts.fad_allocation_id IS NEW.allocation_id
    )
  ) THEN RAISE(
    ABORT,
    'every FAD auction must begin with its private draw commitment'
  ) END;
END;

CREATE TRIGGER free_agent_draft_draws_reveal_update
BEFORE UPDATE ON free_agent_draft_draws
BEGIN
  SELECT CASE WHEN NOT (
    OLD.revealed_at_ms IS NULL
    AND OLD.version = 1
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.algorithm_version IS OLD.algorithm_version
    AND NEW.nonce_bytes IS OLD.nonce_bytes
    AND NEW.commitment_hex IS OLD.commitment_hex
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.revealed_at_ms IS NOT NULL
    AND NEW.updated_at_ms = NEW.revealed_at_ms
    AND NEW.version = 2
    AND json(NEW.ordered_tied_bid_ids_json) =
      NEW.ordered_tied_bid_ids_json
    AND json(NEW.ordered_tied_team_ids_json) =
      NEW.ordered_tied_team_ids_json
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.ordered_tied_bid_ids_json)
      GROUP BY value
      HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.ordered_tied_team_ids_json)
      GROUP BY value
      HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.ordered_tied_bid_ids_json) AS current_bid
      JOIN json_each(NEW.ordered_tied_bid_ids_json) AS next_bid
        ON next_bid.key = current_bid.key + 1
      WHERE current_bid.value >= next_bid.value
    )
    AND EXISTS (
      SELECT 1
      FROM auctions
      JOIN auction_resolutions
        ON auction_resolutions.league_id = auctions.league_id
       AND auction_resolutions.auction_id = auctions.id
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.auction_id
        AND auctions.status IN (
          'resolving',
          'resolved',
          'no_winner',
          'cancelled'
        )
        AND auction_resolutions.resolved_at_ms =
          NEW.revealed_at_ms
        AND (
          (
            json_array_length(NEW.ordered_tied_bid_ids_json) = 0
            AND NEW.selected_bid_id IS NULL
            AND NEW.selected_team_id IS NULL
            AND NEW.selected_index IS NULL
            AND NEW.rejection_counter IS NULL
            AND NEW.selected_digest_hex IS NULL
          )
          OR (
            json_array_length(NEW.ordered_tied_bid_ids_json) >= 2
            AND auction_resolutions.winning_bid_id =
              NEW.selected_bid_id
            AND auction_resolutions.winning_team_id =
              NEW.selected_team_id
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.ordered_tied_bid_ids_json) AS bid_item
      JOIN json_each(NEW.ordered_tied_team_ids_json) AS team_item
        ON team_item.key = bid_item.key
      WHERE NOT EXISTS (
        SELECT 1
        FROM auction_bids
        WHERE auction_bids.league_id = NEW.league_id
          AND auction_bids.auction_id = NEW.auction_id
          AND auction_bids.id = bid_item.value
          AND auction_bids.team_id = team_item.value
          AND auction_bids.status IN ('won', 'lost')
      )
    )
    AND (
      (
        (
          SELECT COUNT(*)
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.term_years = (
              SELECT MIN(candidate.term_years)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.aav_cents = (
                  SELECT MAX(ranked.aav_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
        ) < 2
        AND NEW.ordered_tied_bid_ids_json = '[]'
        AND NEW.ordered_tied_team_ids_json = '[]'
      )
      OR (
        (
          SELECT COUNT(*)
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.term_years = (
              SELECT MIN(candidate.term_years)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.aav_cents = (
                  SELECT MAX(ranked.aav_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
        ) >= 2
        AND json_array_length(
          NEW.ordered_tied_bid_ids_json
        ) = (
          SELECT COUNT(*)
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.term_years = (
              SELECT MIN(candidate.term_years)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.aav_cents = (
                  SELECT MAX(ranked.aav_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            NEW.ordered_tied_bid_ids_json
          ) AS supplied_bid
          JOIN json_each(
            NEW.ordered_tied_team_ids_json
          ) AS supplied_team
            ON supplied_team.key = supplied_bid.key
          WHERE NOT EXISTS (
            SELECT 1
            FROM fad_frozen_eligible_bids AS top_bid
            WHERE top_bid.league_id = NEW.league_id
              AND top_bid.auction_id = NEW.auction_id
              AND top_bid.bid_id = supplied_bid.value
              AND top_bid.team_id = supplied_team.value
              AND top_bid.aav_cents = (
                SELECT MAX(candidate.aav_cents)
                FROM fad_frozen_eligible_bids AS candidate
                WHERE candidate.league_id = NEW.league_id
                  AND candidate.auction_id = NEW.auction_id
              )
              AND top_bid.term_years = (
                SELECT MIN(candidate.term_years)
                FROM fad_frozen_eligible_bids AS candidate
                WHERE candidate.league_id = NEW.league_id
                  AND candidate.auction_id = NEW.auction_id
                  AND candidate.aav_cents = (
                    SELECT MAX(ranked.aav_cents)
                    FROM fad_frozen_eligible_bids AS ranked
                    WHERE ranked.league_id = NEW.league_id
                      AND ranked.auction_id = NEW.auction_id
                  )
              )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.term_years = (
              SELECT MIN(candidate.term_years)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.aav_cents = (
                  SELECT MAX(ranked.aav_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(
                NEW.ordered_tied_bid_ids_json
              ) AS supplied_bid
              JOIN json_each(
                NEW.ordered_tied_team_ids_json
              ) AS supplied_team
                ON supplied_team.key = supplied_bid.key
              WHERE supplied_bid.value = top_bid.bid_id
                AND supplied_team.value = top_bid.team_id
            )
        )
      )
    )
    AND (
      NEW.selected_index IS NULL
      OR (
        json_extract(
          NEW.ordered_tied_bid_ids_json,
          '$[' || NEW.selected_index || ']'
        ) = NEW.selected_bid_id
        AND json_extract(
          NEW.ordered_tied_team_ids_json,
          '$[' || NEW.selected_index || ']'
        ) = NEW.selected_team_id
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD draw reveal must prove the terminal no-selection or exact-tie result'
  ) END;
END;

CREATE TRIGGER free_agent_draft_draws_immutable_delete
BEFORE DELETE ON free_agent_draft_draws
BEGIN
  SELECT RAISE(ABORT, 'FAD draw commitment and reveal are immutable');
END;

CREATE TRIGGER auction_contexts_valid_insert
BEFORE INSERT ON auction_contexts
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.created_at_ms <= NEW.created_at_ms
    )
    AND (
      NEW.source_kind = 'ordinary_weekly'
      OR (
        EXISTS (
          SELECT 1
          FROM auctions
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auctions.league_id
           AND free_agent_draft_rollovers.season_id =
                auctions.season_id
          WHERE auctions.league_id = NEW.league_id
            AND auctions.id = NEW.auction_id
            AND auctions.status = 'open'
            AND free_agent_draft_rollovers.fad_id = NEW.fad_id
            AND free_agent_draft_rollovers.id =
              NEW.fad_rollover_id
            AND auctions.resolves_at_ms =
              free_agent_draft_rollovers.rolls_over_at_ms
            AND auctions.opened_at_ms >=
              free_agent_draft_rollovers.opens_at_ms
            AND auctions.opened_at_ms <
              free_agent_draft_rollovers.rolls_over_at_ms
        )
        AND (
          (
            NEW.source_kind = 'fad_restricted'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.fad_allocation_id
                AND free_agent_draft_player_allocations.restricted_auction_id =
                  NEW.auction_id
                AND free_agent_draft_player_allocations.status IN (
                  'restricted_scheduled',
                  'restricted_active'
                )
            )
          )
          OR (
            NEW.fad_origin =
              'restricted_no_improvement_fallback'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.fad_allocation_id
                AND free_agent_draft_player_allocations.fallback_open_auction_id =
                  NEW.auction_id
                AND free_agent_draft_player_allocations.status =
                  'restricted_fallback_open'
            )
          )
          OR NEW.fad_origin IN (
            'manager_nomination',
            'queued_nomination'
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'auction context must bind the exact ordinary or FAD window'
  ) END;
END;

CREATE TRIGGER auction_contexts_immutable_update
BEFORE UPDATE ON auction_contexts
BEGIN
  SELECT RAISE(ABORT, 'auction context is immutable');
END;

CREATE TRIGGER auction_contexts_immutable_delete
BEFORE DELETE ON auction_contexts
BEGIN
  SELECT RAISE(ABORT, 'auction context is immutable');
END;

CREATE TRIGGER auction_administration_command_results_valid_insert
BEFORE INSERT ON auction_administration_command_results
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
    )
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id =
          NEW.idempotency_request_id
        AND idempotency_requests.actor_user_id =
          NEW.actor_user_id
        AND idempotency_requests.request_hash =
          NEW.request_sha256
        AND idempotency_requests.status = 'started'
        AND idempotency_requests.result_type IS NULL
        AND idempotency_requests.result_id IS NULL
        AND idempotency_requests.completed_at_ms IS NULL
        AND idempotency_requests.created_at_ms =
          NEW.created_at_ms
        AND (
          (
            NEW.action = 'edit_bid'
            AND idempotency_requests.operation =
              'auction.bid.put'
          )
          OR (
            NEW.action = 'remove_bid'
            AND idempotency_requests.operation =
              'auction.bid.remove'
          )
          OR (
            NEW.action = 'cancel_auction'
            AND idempotency_requests.operation =
              'auction.cancel'
          )
          OR (
            NEW.action = 'request_resolution'
            AND idempotency_requests.operation =
              'auction.resolve.request'
          )
        )
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id = NEW.actor_membership_id
        AND league_memberships.user_id = NEW.actor_user_id
        AND league_memberships.status = 'active'
        AND (
          (
            NEW.actor_authority = 'commissioner'
            AND EXISTS (
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
            AND EXISTS (
              SELECT 1
              FROM platform_roles
              WHERE platform_roles.user_id = NEW.actor_user_id
                AND platform_roles.role =
                  'platform_administrator'
                AND platform_roles.status = 'active'
            )
          )
        )
    )
    AND (
      (
        NEW.action = 'edit_bid'
        AND EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = NEW.league_id
            AND auction_bids.season_id = NEW.season_id
            AND auction_bids.id = NEW.bid_id
            AND auction_bids.auction_id = NEW.auction_id
            AND auction_bids.status = 'active'
            AND auction_bids.idempotency_request_id =
              NEW.idempotency_request_id
            AND auction_bids.last_edited_at_ms =
              NEW.created_at_ms
            AND auction_bids.version =
              NEW.resulting_resource_version
        )
      )
      OR (
        NEW.action = 'remove_bid'
        AND EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = NEW.league_id
            AND auction_bids.season_id = NEW.season_id
            AND auction_bids.id = NEW.bid_id
            AND auction_bids.auction_id = NEW.auction_id
            AND auction_bids.status = 'withdrawn'
            AND auction_bids.last_edited_at_ms =
              NEW.created_at_ms
            AND auction_bids.version =
              NEW.resulting_resource_version
        )
      )
      OR (
        NEW.action = 'cancel_auction'
        AND EXISTS (
          SELECT 1
          FROM auctions
          WHERE auctions.league_id = NEW.league_id
            AND auctions.season_id = NEW.season_id
            AND auctions.id = NEW.auction_id
            AND auctions.status = 'cancelled'
            AND auctions.updated_at_ms = NEW.created_at_ms
            AND auctions.version =
              NEW.resulting_resource_version
        )
      )
      OR (
        NEW.action = 'request_resolution'
        AND EXISTS (
          SELECT 1
          FROM auctions
          JOIN job_runs
            ON job_runs.league_id = auctions.league_id
           AND job_runs.season_id = auctions.season_id
           AND job_runs.id = NEW.job_run_id
          WHERE auctions.league_id = NEW.league_id
            AND auctions.season_id = NEW.season_id
            AND auctions.id = NEW.auction_id
            AND auctions.status IN (
              'open',
              'resolving',
              'failed',
              'resolved',
              'no_winner',
              'cancelled'
            )
            AND auctions.version =
              NEW.resulting_resource_version
            AND NEW.created_at_ms >= auctions.resolves_at_ms
            AND job_runs.job_type = 'auction.resolve.target'
            AND job_runs.occurrence_key =
              'auction:' || auctions.id || ':' ||
                auctions.resolves_at_ms
            AND job_runs.scheduled_for_ms =
              auctions.resolves_at_ms
            AND job_runs.status IN (
              'pending',
              'leased',
              'running',
              'succeeded'
            )
            AND (
              (
                job_runs.status IN (
                  'pending',
                  'leased',
                  'running'
                )
                AND json_extract(
                  NEW.response_json,
                  '$.status'
                ) = 'pending'
                AND auctions.status IN (
                  'open',
                  'resolving',
                  'failed'
                )
              )
              OR (
                job_runs.status = 'succeeded'
                AND json_extract(
                  NEW.response_json,
                  '$.status'
                ) = 'already_succeeded'
              )
            )
            AND json_extract(
              NEW.response_json,
              '$.operationId'
            ) = NEW.job_run_id
            AND json_extract(
              NEW.response_json,
              '$.occurrenceKey'
            ) = job_runs.occurrence_key
            AND json_extract(
              NEW.response_json,
              '$.auctionId'
            ) = NEW.auction_id
            AND json_extract(
              NEW.response_json,
              '$.acceptedAtMs'
            ) = NEW.created_at_ms
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'auction administration result must bind its exact request, actor, and resource version'
  ) END;
END;

CREATE TRIGGER auction_administration_command_results_immutable_update
BEFORE UPDATE ON auction_administration_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'auction administration command results are immutable'
  );
END;

CREATE TRIGGER auction_administration_command_results_immutable_delete
BEFORE DELETE ON auction_administration_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'auction administration command results are immutable'
  );
END;

CREATE TRIGGER idempotency_requests_auction_administration_complete
BEFORE UPDATE ON idempotency_requests
WHEN OLD.status = 'started'
  AND NEW.status = 'completed'
  AND EXISTS (
    SELECT 1
    FROM auction_administration_command_results
    WHERE auction_administration_command_results.league_id =
        OLD.league_id
      AND auction_administration_command_results
        .idempotency_request_id = OLD.id
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.result_type =
      'auction_administration_command_result'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM auction_administration_command_results
      WHERE auction_administration_command_results.league_id =
          NEW.league_id
        AND auction_administration_command_results.id =
          NEW.result_id
        AND auction_administration_command_results
          .idempotency_request_id = NEW.id
        AND auction_administration_command_results.actor_user_id =
          NEW.actor_user_id
        AND auction_administration_command_results.request_sha256 =
          NEW.request_hash
        AND auction_administration_command_results.created_at_ms =
          NEW.completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'auction administration request must complete against its immutable result'
  ) END;
END;

CREATE TRIGGER idempotency_requests_auction_administration_requires_result
BEFORE UPDATE ON idempotency_requests
WHEN OLD.status = 'started'
  AND NEW.status = 'completed'
  AND (
    OLD.operation IN (
      'auction.bid.remove',
      'auction.cancel',
      'auction.resolve.request'
    )
    OR NEW.result_type =
      'auction_administration_command_result'
    OR (
      OLD.operation = 'auction.bid.put'
      AND EXISTS (
        SELECT 1
        FROM auction_bids
        JOIN auction_events
          ON auction_events.league_id =
              auction_bids.league_id
         AND auction_events.season_id =
              auction_bids.season_id
         AND auction_events.auction_id =
              auction_bids.auction_id
         AND auction_events.bid_id = auction_bids.id
         AND auction_events.team_id = auction_bids.team_id
        WHERE auction_bids.league_id = OLD.league_id
          AND auction_bids.idempotency_request_id = OLD.id
          AND auction_events.actor_user_id =
            OLD.actor_user_id
          AND auction_events.event_type = 'bid_edited'
          AND auction_events.occurred_at_ms =
            NEW.completed_at_ms
          AND json_valid(auction_events.metadata_json) = 1
          AND json_extract(
            auction_events.metadata_json,
            '$.actorAuthority'
          ) IN (
            'commissioner',
            'platform_administrator_as_commissioner'
          )
      )
    )
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.result_type =
      'auction_administration_command_result'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM auction_administration_command_results
      WHERE auction_administration_command_results.league_id =
          NEW.league_id
        AND auction_administration_command_results.id =
          NEW.result_id
        AND auction_administration_command_results
          .idempotency_request_id = NEW.id
        AND auction_administration_command_results.actor_user_id =
          NEW.actor_user_id
        AND auction_administration_command_results.request_sha256 =
          NEW.request_hash
        AND auction_administration_command_results.created_at_ms =
          NEW.completed_at_ms
        AND (
          (
            NEW.operation = 'auction.bid.put'
            AND auction_administration_command_results.action =
              'edit_bid'
          )
          OR (
            NEW.operation = 'auction.bid.remove'
            AND auction_administration_command_results.action =
              'remove_bid'
          )
          OR (
            NEW.operation = 'auction.cancel'
            AND auction_administration_command_results.action =
              'cancel_auction'
          )
          OR (
            NEW.operation = 'auction.resolve.request'
            AND auction_administration_command_results.action =
              'request_resolution'
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'auction administration completion requires its exact immutable result'
  ) END;
END;

CREATE TRIGGER idempotency_requests_auction_administration_completed_immutable
BEFORE UPDATE ON idempotency_requests
WHEN OLD.status = 'completed'
  AND (
    OLD.result_type =
      'auction_administration_command_result'
    OR EXISTS (
      SELECT 1
      FROM auction_administration_command_results
      WHERE auction_administration_command_results.league_id =
          OLD.league_id
        AND auction_administration_command_results
          .idempotency_request_id = OLD.id
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'completed auction administration request evidence is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_auction_administration_result_delete
BEFORE DELETE ON idempotency_requests
WHEN EXISTS (
  SELECT 1
  FROM auction_administration_command_results
  WHERE auction_administration_command_results.league_id =
      OLD.league_id
    AND auction_administration_command_results
      .idempotency_request_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'auction administration result request evidence is immutable'
  );
END;

CREATE TRIGGER auction_bids_require_context_insert
BEFORE INSERT ON auction_bids
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
  ) THEN RAISE(
    ABORT,
    'auction bid requires its persisted context'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_draws
        WHERE free_agent_draft_draws.league_id = NEW.league_id
          AND free_agent_draft_draws.auction_id = NEW.auction_id
          AND free_agent_draft_draws.revealed_at_ms IS NULL
      )
  ) THEN RAISE(
    ABORT,
    'FAD bid requires the auction draw commitment'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND NOT (
        auctions.status = 'open'
        AND NEW.status = 'active'
        AND NEW.version = 1
        AND NEW.edit_count = 0
        AND NEW.first_submitted_at_ms = NEW.last_edited_at_ms
        AND NEW.first_submitted_at_ms >= auctions.opened_at_ms
        AND NEW.first_submitted_at_ms < auctions.resolves_at_ms
        AND NEW.idempotency_request_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM idempotency_requests
          WHERE idempotency_requests.league_id = NEW.league_id
            AND idempotency_requests.id =
              NEW.idempotency_request_id
            AND idempotency_requests.actor_user_id =
              NEW.submitted_by_user_id
            AND idempotency_requests.operation = 'auction.bid.put'
            AND idempotency_requests.status = 'started'
            AND idempotency_requests.result_type IS NULL
            AND idempotency_requests.result_id IS NULL
            AND idempotency_requests.created_at_ms =
              NEW.first_submitted_at_ms
        )
        AND (
          EXISTS (
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
                NEW.league_id
              AND team_manager_assignments.team_id = NEW.team_id
              AND team_manager_assignments.user_id =
                NEW.submitted_by_user_id
              AND team_manager_assignments.status = 'accepted'
              AND team_manager_assignments.ended_at_ms IS NULL
              AND league_memberships.status = 'active'
          )
          OR EXISTS (
            SELECT 1
            FROM league_memberships
            WHERE league_memberships.league_id = NEW.league_id
              AND league_memberships.user_id =
                NEW.submitted_by_user_id
              AND league_memberships.status = 'active'
              AND (
                EXISTS (
                  SELECT 1
                  FROM leagues
                  WHERE leagues.id = NEW.league_id
                    AND leagues.commissioner_membership_id =
                      league_memberships.id
                )
                OR EXISTS (
                  SELECT 1
                  FROM platform_roles
                  WHERE platform_roles.user_id =
                      NEW.submitted_by_user_id
                    AND platform_roles.role =
                      'platform_administrator'
                    AND platform_roles.status = 'active'
                )
              )
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD opening bid requires a current actor and started request'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_auction_participants
        WHERE free_agent_draft_auction_participants.league_id =
            NEW.league_id
          AND free_agent_draft_auction_participants.auction_id =
            NEW.auction_id
          AND free_agent_draft_auction_participants.team_id =
            NEW.team_id
          AND free_agent_draft_auction_participants.status = 'active'
          AND (
            NEW.total_value_cents >
              free_agent_draft_auction_participants.minimum_total_value_cents
            OR (
              NEW.total_value_cents =
                free_agent_draft_auction_participants.minimum_total_value_cents
              AND NEW.lowest_offered_aav_cents >
                free_agent_draft_auction_participants.minimum_aav_cents
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'restricted bid must be an allowlisted strict improvement'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN free_agent_draft_player_allocations
      ON free_agent_draft_player_allocations.league_id =
          auction_contexts.league_id
     AND free_agent_draft_player_allocations.season_id =
          auction_contexts.season_id
     AND free_agent_draft_player_allocations.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_player_allocations.id =
          auction_contexts.fad_allocation_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_open_rapid'
      AND auction_contexts.fad_origin =
        'restricted_no_improvement_fallback'
      AND NOT (
        NEW.total_value_cents >
          free_agent_draft_player_allocations
            .restricted_minimum_total_cents
        OR (
          NEW.total_value_cents =
            free_agent_draft_player_allocations
              .restricted_minimum_total_cents
          AND NEW.lowest_offered_aav_cents >=
            free_agent_draft_player_allocations
              .restricted_minimum_aav_cents
        )
      )
  ) THEN RAISE(
    ABORT,
    'fallback bid cannot rank below its Candidate minimum'
  ) END;
END;

CREATE TRIGGER fad_auction_bids_forward_update
BEFORE UPDATE ON auction_bids
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.season_id = OLD.season_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT CASE WHEN OLD.status <> 'active' THEN RAISE(
    ABORT,
    'terminal FAD bid evidence is immutable'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.submitted_by_user_id IS OLD.submitted_by_user_id
    AND NEW.first_submitted_at_ms IS OLD.first_submitted_at_ms
    AND NEW.version = OLD.version + 1
    AND NEW.last_edited_at_ms >= OLD.last_edited_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD bid identity and version history are immutable'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'active'
    AND NOT (
      EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status = 'open'
          AND NEW.last_edited_at_ms < auctions.resolves_at_ms
      )
      AND NEW.idempotency_request_id IS NOT NULL
      AND NEW.lowest_offered_aav_cents = MIN(
        OLD.lowest_offered_aav_cents,
        (NEW.total_value_cents / NEW.term_years)
          + CASE
              WHEN
                (NEW.total_value_cents % NEW.term_years) * 2
                  >= NEW.term_years
              THEN 1
              ELSE 0
            END
      )
      AND EXISTS (
        SELECT 1
        FROM idempotency_requests
        WHERE idempotency_requests.league_id = NEW.league_id
          AND idempotency_requests.id =
            NEW.idempotency_request_id
          AND idempotency_requests.operation = 'auction.bid.put'
          AND idempotency_requests.status = 'started'
          AND idempotency_requests.result_type IS NULL
          AND idempotency_requests.result_id IS NULL
          AND idempotency_requests.created_at_ms =
            NEW.last_edited_at_ms
          AND (
            (
              NEW.edit_count = OLD.edit_count + 1
              AND NEW.last_edited_at_ms >=
                OLD.last_edited_at_ms + 4500000
              AND (
                EXISTS (
                  SELECT 1
                  FROM auction_contexts
                  JOIN auctions
                    ON auctions.league_id =
                        auction_contexts.league_id
                   AND auctions.season_id =
                        auction_contexts.season_id
                   AND auctions.id =
                        auction_contexts.auction_id
                  WHERE auction_contexts.league_id =
                      NEW.league_id
                    AND auction_contexts.season_id =
                      NEW.season_id
                    AND auction_contexts.auction_id =
                      NEW.auction_id
                    AND auction_contexts.source_kind =
                      'fad_open_rapid'
                    AND NEW.edit_count <= CASE
                      WHEN OLD.first_submitted_at_ms =
                        auctions.opened_at_ms
                      THEN 2
                      ELSE 1
                    END
                )
                OR EXISTS (
                  SELECT 1
                  FROM auction_contexts
                  JOIN free_agent_draft_auction_participants
                    ON free_agent_draft_auction_participants
                      .league_id = auction_contexts.league_id
                   AND free_agent_draft_auction_participants
                      .season_id = auction_contexts.season_id
                   AND free_agent_draft_auction_participants
                      .auction_id = auction_contexts.auction_id
                   AND free_agent_draft_auction_participants
                      .team_id = NEW.team_id
                  WHERE auction_contexts.league_id =
                      NEW.league_id
                    AND auction_contexts.season_id =
                      NEW.season_id
                    AND auction_contexts.auction_id =
                      NEW.auction_id
                    AND auction_contexts.source_kind =
                      'fad_restricted'
                    AND free_agent_draft_auction_participants
                      .status = 'active'
                    AND NEW.edit_count <=
                      free_agent_draft_auction_participants
                        .manager_edit_limit
                )
              )
              AND EXISTS (
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
                    NEW.league_id
                  AND team_manager_assignments.team_id =
                    NEW.team_id
                  AND team_manager_assignments.user_id =
                    idempotency_requests.actor_user_id
                  AND team_manager_assignments.status =
                    'accepted'
                  AND team_manager_assignments.ended_at_ms IS NULL
                  AND league_memberships.status = 'active'
              )
            )
            OR (
              NEW.edit_count = OLD.edit_count
              AND EXISTS (
                SELECT 1
                FROM league_memberships
                WHERE league_memberships.league_id =
                    NEW.league_id
                  AND league_memberships.user_id =
                    idempotency_requests.actor_user_id
                  AND league_memberships.status = 'active'
                  AND (
                    EXISTS (
                      SELECT 1
                      FROM leagues
                      WHERE leagues.id = NEW.league_id
                        AND leagues.commissioner_membership_id =
                          league_memberships.id
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM platform_roles
                      WHERE platform_roles.user_id =
                          idempotency_requests.actor_user_id
                        AND platform_roles.role =
                          'platform_administrator'
                        AND platform_roles.status = 'active'
                    )
                  )
              )
            )
          )
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM auction_contexts
          WHERE auction_contexts.league_id = NEW.league_id
            AND auction_contexts.auction_id = NEW.auction_id
            AND auction_contexts.source_kind = 'fad_restricted'
        )
        OR EXISTS (
          SELECT 1
          FROM free_agent_draft_auction_participants
          WHERE free_agent_draft_auction_participants.league_id =
              NEW.league_id
            AND free_agent_draft_auction_participants.auction_id =
              NEW.auction_id
            AND free_agent_draft_auction_participants.team_id =
              NEW.team_id
            AND free_agent_draft_auction_participants.status =
              'active'
            AND free_agent_draft_auction_participants
              .active_improvement_bid_id = NEW.id
            AND (
              NEW.total_value_cents >
                free_agent_draft_auction_participants
                  .minimum_total_value_cents
              OR (
                NEW.total_value_cents =
                  free_agent_draft_auction_participants
                    .minimum_total_value_cents
                AND (
                  (NEW.total_value_cents / NEW.term_years)
                    + CASE
                        WHEN
                          (NEW.total_value_cents % NEW.term_years) * 2
                            >= NEW.term_years
                        THEN 1
                        ELSE 0
                      END
                ) >
                  free_agent_draft_auction_participants
                    .minimum_aav_cents
              )
            )
        )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD bid edit exceeds its actor entitlement, cooldown, or bid floor'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'active'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN free_agent_draft_player_allocations
        ON free_agent_draft_player_allocations.league_id =
            auction_contexts.league_id
       AND free_agent_draft_player_allocations.season_id =
            auction_contexts.season_id
       AND free_agent_draft_player_allocations.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_player_allocations.id =
            auction_contexts.fad_allocation_id
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind = 'fad_open_rapid'
        AND auction_contexts.fad_origin =
          'restricted_no_improvement_fallback'
        AND NOT (
          NEW.total_value_cents >
            free_agent_draft_player_allocations
              .restricted_minimum_total_cents
          OR (
            NEW.total_value_cents =
              free_agent_draft_player_allocations
                .restricted_minimum_total_cents
            AND (
              (NEW.total_value_cents / NEW.term_years)
                + CASE
                    WHEN
                      (NEW.total_value_cents % NEW.term_years) * 2
                        >= NEW.term_years
                    THEN 1
                    ELSE 0
                  END
            ) >=
              free_agent_draft_player_allocations
                .restricted_minimum_aav_cents
          )
        )
    )
  THEN RAISE(
    ABORT,
    'fallback bid cannot rank below its Candidate minimum'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'withdrawn'
    AND NOT (
      NEW.total_value_cents IS OLD.total_value_cents
      AND NEW.term_years IS OLD.term_years
      AND NEW.lowest_offered_aav_cents IS
        OLD.lowest_offered_aav_cents
      AND NEW.edit_count IS OLD.edit_count
      AND NEW.idempotency_request_id IS
        OLD.idempotency_request_id
      AND EXISTS (
        SELECT 1
        FROM auction_events
        JOIN league_memberships
          ON league_memberships.league_id =
              auction_events.league_id
         AND league_memberships.user_id =
              auction_events.actor_user_id
        WHERE auction_events.league_id = NEW.league_id
          AND auction_events.season_id = NEW.season_id
          AND auction_events.auction_id = NEW.auction_id
          AND auction_events.bid_id = NEW.id
          AND auction_events.team_id = NEW.team_id
          AND auction_events.event_type =
            'commissioner_bid_removed'
          AND auction_events.occurred_at_ms =
            NEW.last_edited_at_ms
          AND league_memberships.status = 'active'
          AND (
            EXISTS (
              SELECT 1
              FROM leagues
              WHERE leagues.id = NEW.league_id
                AND leagues.commissioner_membership_id =
                  league_memberships.id
            )
            OR EXISTS (
              SELECT 1
              FROM platform_roles
              WHERE platform_roles.user_id =
                  auction_events.actor_user_id
                AND platform_roles.role =
                  'platform_administrator'
                AND platform_roles.status = 'active'
            )
          )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD bid withdrawal requires an attributable commissioner removal'
  ) END;

  SELECT CASE WHEN NEW.status NOT IN (
    'active',
    'withdrawn',
    'won',
    'lost',
    'invalid',
    'cancelled'
  ) THEN RAISE(
    ABORT,
    'FAD bid has an unsupported forward state'
  ) END;
END;

CREATE TRIGGER fad_auction_bids_immutable_delete
BEFORE DELETE ON auction_bids
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'FAD bid evidence is immutable');
END;

CREATE TRIGGER auction_events_require_context_insert
BEFORE INSERT ON auction_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
  ) THEN RAISE(
    ABORT,
    'auction event requires its persisted context'
  ) END;

  SELECT CASE WHEN
    NEW.event_type = 'commissioner_bid_removed'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      NEW.bid_id IS NOT NULL
      AND NEW.team_id IS NOT NULL
      AND NEW.actor_user_id IS NOT NULL
      AND json_valid(NEW.metadata_json)
      AND json_type(NEW.metadata_json, '$.actorMembershipId') =
        'text'
      AND json_type(NEW.metadata_json, '$.actorAuthority') =
        'text'
      AND json_extract(NEW.metadata_json, '$.actorAuthority') IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
      AND EXISTS (
        SELECT 1
        FROM auction_bids
        WHERE auction_bids.league_id = NEW.league_id
          AND auction_bids.season_id = NEW.season_id
          AND auction_bids.id = NEW.bid_id
          AND auction_bids.auction_id = NEW.auction_id
          AND auction_bids.team_id = NEW.team_id
          AND auction_bids.status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = NEW.league_id
          AND league_memberships.id =
            json_extract(
              NEW.metadata_json,
              '$.actorMembershipId'
            )
          AND league_memberships.user_id = NEW.actor_user_id
          AND league_memberships.status = 'active'
          AND (
            (
              json_extract(
                NEW.metadata_json,
                '$.actorAuthority'
              ) = 'commissioner'
              AND EXISTS (
                SELECT 1
                FROM leagues
                WHERE leagues.id = NEW.league_id
                  AND leagues.commissioner_membership_id =
                    league_memberships.id
              )
            )
            OR (
              json_extract(
                NEW.metadata_json,
                '$.actorAuthority'
              ) =
                'platform_administrator_as_commissioner'
              AND EXISTS (
                SELECT 1
                FROM platform_roles
                WHERE platform_roles.user_id = NEW.actor_user_id
                  AND platform_roles.role =
                    'platform_administrator'
                  AND platform_roles.status = 'active'
              )
            )
          )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD commissioner removal event requires current attributable authority'
  ) END;

  SELECT CASE WHEN
    NEW.event_type = 'bid_edited'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      NEW.bid_id IS NOT NULL
      AND NEW.team_id IS NOT NULL
      AND NEW.actor_user_id IS NOT NULL
      AND json_valid(NEW.metadata_json) = 1
      AND json_type(NEW.metadata_json) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(NEW.metadata_json)
      ) = 4
      AND json_type(
        NEW.metadata_json,
        '$.actorMembershipId'
      ) = 'text'
      AND json_type(
        NEW.metadata_json,
        '$.actorAuthority'
      ) = 'text'
      AND json_type(NEW.metadata_json, '$.before') = 'object'
      AND json_type(NEW.metadata_json, '$.after') = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(
          json_extract(NEW.metadata_json, '$.before')
        )
      ) = 5
      AND (
        SELECT COUNT(*)
        FROM json_each(
          json_extract(NEW.metadata_json, '$.after')
        )
      ) = 6
      AND EXISTS (
        SELECT 1
        FROM auction_bids
        JOIN idempotency_requests
          ON idempotency_requests.league_id =
              auction_bids.league_id
         AND idempotency_requests.id =
              auction_bids.idempotency_request_id
        WHERE auction_bids.league_id = NEW.league_id
          AND auction_bids.season_id = NEW.season_id
          AND auction_bids.id = NEW.bid_id
          AND auction_bids.auction_id = NEW.auction_id
          AND auction_bids.team_id = NEW.team_id
          AND auction_bids.status = 'active'
          AND auction_bids.version > 1
          AND auction_bids.last_edited_at_ms =
            NEW.occurred_at_ms
          AND idempotency_requests.operation =
            'auction.bid.put'
          AND idempotency_requests.status = 'started'
          AND idempotency_requests.result_type IS NULL
          AND idempotency_requests.result_id IS NULL
          AND idempotency_requests.actor_user_id =
            NEW.actor_user_id
          AND idempotency_requests.created_at_ms =
            NEW.occurred_at_ms
          AND json_extract(
            NEW.metadata_json,
            '$.after.totalValueCents'
          ) = auction_bids.total_value_cents
          AND json_extract(
            NEW.metadata_json,
            '$.after.termYears'
          ) = auction_bids.term_years
          AND json_extract(
            NEW.metadata_json,
            '$.after.aavCents'
          ) = (
            (auction_bids.total_value_cents /
              auction_bids.term_years)
            + CASE
                WHEN
                  (
                    auction_bids.total_value_cents %
                    auction_bids.term_years
                  ) * 2 >= auction_bids.term_years
                THEN 1
                ELSE 0
              END
          )
          AND json_extract(
            NEW.metadata_json,
            '$.after.lowestOfferedAavCents'
          ) = auction_bids.lowest_offered_aav_cents
          AND json_extract(
            NEW.metadata_json,
            '$.after.editCount'
          ) = auction_bids.edit_count
          AND json_extract(
            NEW.metadata_json,
            '$.after.version'
          ) = auction_bids.version
          AND json_type(
            NEW.metadata_json,
            '$.before.totalValueCents'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.totalValueCents'
          ) > 0
          AND json_type(
            NEW.metadata_json,
            '$.before.termYears'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.termYears'
          ) BETWEEN 1 AND 3
          AND json_type(
            NEW.metadata_json,
            '$.before.lowestOfferedAavCents'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.lowestOfferedAavCents'
          ) > 0
          AND json_type(
            NEW.metadata_json,
            '$.before.editCount'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.editCount'
          ) >= 0
          AND json_extract(
            NEW.metadata_json,
            '$.before.version'
          ) = auction_bids.version - 1
          AND auction_bids.lowest_offered_aav_cents = MIN(
            json_extract(
              NEW.metadata_json,
              '$.before.lowestOfferedAavCents'
            ),
            (
              (auction_bids.total_value_cents /
                auction_bids.term_years)
              + CASE
                  WHEN
                    (
                      auction_bids.total_value_cents %
                      auction_bids.term_years
                    ) * 2 >= auction_bids.term_years
                  THEN 1
                  ELSE 0
                END
            )
          )
          AND (
            (
              json_extract(
                NEW.metadata_json,
                '$.actorAuthority'
              ) = 'manager'
              AND json_extract(
                NEW.metadata_json,
                '$.after.editCount'
              ) = json_extract(
                NEW.metadata_json,
                '$.before.editCount'
              ) + 1
              AND EXISTS (
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
                    NEW.league_id
                  AND team_manager_assignments.team_id =
                    NEW.team_id
                  AND team_manager_assignments.user_id =
                    NEW.actor_user_id
                  AND team_manager_assignments.membership_id =
                    json_extract(
                      NEW.metadata_json,
                      '$.actorMembershipId'
                    )
                  AND team_manager_assignments.status =
                    'accepted'
                  AND team_manager_assignments.ended_at_ms IS NULL
                  AND league_memberships.status = 'active'
              )
            )
            OR (
              json_extract(
                NEW.metadata_json,
                '$.after.editCount'
              ) = json_extract(
                NEW.metadata_json,
                '$.before.editCount'
              )
              AND EXISTS (
                SELECT 1
                FROM league_memberships
                WHERE league_memberships.league_id =
                    NEW.league_id
                  AND league_memberships.id =
                    json_extract(
                      NEW.metadata_json,
                      '$.actorMembershipId'
                    )
                  AND league_memberships.user_id =
                    NEW.actor_user_id
                  AND league_memberships.status = 'active'
                  AND (
                    (
                      json_extract(
                        NEW.metadata_json,
                        '$.actorAuthority'
                      ) = 'commissioner'
                      AND EXISTS (
                        SELECT 1
                        FROM leagues
                        WHERE leagues.id = NEW.league_id
                          AND leagues
                            .commissioner_membership_id =
                            league_memberships.id
                      )
                    )
                    OR (
                      json_extract(
                        NEW.metadata_json,
                        '$.actorAuthority'
                      ) =
                        'platform_administrator_as_commissioner'
                      AND EXISTS (
                        SELECT 1
                        FROM platform_roles
                        WHERE platform_roles.user_id =
                            NEW.actor_user_id
                          AND platform_roles.role =
                            'platform_administrator'
                          AND platform_roles.status = 'active'
                      )
                    )
                  )
              )
            )
          )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD bid edit event must prove its exact bid version and actor authority'
  ) END;
END;

CREATE TRIGGER fad_auction_resolution_failure_events_insert
BEFORE INSERT ON auction_events
WHEN NEW.event_type = 'fad_auction_resolution_failed'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.bid_id IS NULL
    AND NEW.team_id IS NULL
    AND NEW.actor_user_id IS NULL
    AND json_valid(NEW.metadata_json) = 1
    AND json_type(NEW.metadata_json) = 'object'
    AND (
      SELECT COUNT(*)
      FROM json_each(NEW.metadata_json)
    ) = 3
    AND json_type(
      NEW.metadata_json,
      '$.recoveryId'
    ) = 'text'
    AND json_type(
      NEW.metadata_json,
      '$.jobRunId'
    ) = 'text'
    AND json_type(
      NEW.metadata_json,
      '$.errorCode'
    ) = 'text'
    AND EXISTS (
      SELECT 1
      FROM auctions
      JOIN auction_contexts
        ON auction_contexts.league_id = auctions.league_id
       AND auction_contexts.season_id = auctions.season_id
       AND auction_contexts.auction_id = auctions.id
      JOIN free_agent_draft_draws
        ON free_agent_draft_draws.league_id =
            auction_contexts.league_id
       AND free_agent_draft_draws.season_id =
            auction_contexts.season_id
       AND free_agent_draft_draws.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_draws.allocation_id IS
            auction_contexts.fad_allocation_id
       AND free_agent_draft_draws.auction_id =
            auction_contexts.auction_id
      JOIN free_agent_draft_recoveries
        ON free_agent_draft_recoveries.league_id =
            auction_contexts.league_id
       AND free_agent_draft_recoveries.season_id =
            auction_contexts.season_id
       AND free_agent_draft_recoveries.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_recoveries.player_id =
            auctions.player_id
       AND free_agent_draft_recoveries.allocation_id IS
            auction_contexts.fad_allocation_id
       AND free_agent_draft_recoveries.rollover_id =
            auction_contexts.fad_rollover_id
       AND free_agent_draft_recoveries.auction_id =
            auction_contexts.auction_id
      JOIN job_runs
        ON job_runs.league_id =
            free_agent_draft_recoveries.league_id
       AND job_runs.id =
            free_agent_draft_recoveries.job_run_id
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.status = 'failed'
        AND auctions.updated_at_ms = NEW.occurred_at_ms
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
        AND free_agent_draft_draws.revealed_at_ms IS NULL
        AND free_agent_draft_draws.version = 1
        AND free_agent_draft_recoveries.id =
          json_extract(
            NEW.metadata_json,
            '$.recoveryId'
          )
        AND free_agent_draft_recoveries.kind =
          'auction_resolution'
        AND free_agent_draft_recoveries.status =
          'correction_required'
        AND free_agent_draft_recoveries.last_error_code =
          json_extract(
            NEW.metadata_json,
            '$.errorCode'
          )
        AND free_agent_draft_recoveries.created_at_ms =
          NEW.occurred_at_ms
        AND free_agent_draft_recoveries.updated_at_ms =
          NEW.occurred_at_ms
        AND free_agent_draft_recoveries.resolved_at_ms IS NULL
        AND job_runs.id = json_extract(
          NEW.metadata_json,
          '$.jobRunId'
        )
        AND job_runs.job_type = 'auction.resolve.target'
        AND job_runs.occurrence_key =
          'auction:' || auctions.id || ':' ||
            auctions.resolves_at_ms
        AND job_runs.scheduled_for_ms =
          auctions.resolves_at_ms
        AND job_runs.status = 'failed'
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NULL
        AND job_runs.lease_token IS NULL
        AND job_runs.lease_expires_at_ms IS NULL
        AND job_runs.started_at_ms IS NOT NULL
        AND job_runs.started_at_ms <= NEW.occurred_at_ms
        AND job_runs.completed_at_ms =
          NEW.occurred_at_ms
        AND job_runs.result_json IS NULL
        AND job_runs.last_error_code =
          json_extract(
            NEW.metadata_json,
            '$.errorCode'
          )
        AND job_runs.updated_at_ms =
          NEW.occurred_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM auction_resolutions
          WHERE auction_resolutions.league_id =
              NEW.league_id
            AND auction_resolutions.auction_id =
              NEW.auction_id
        )
        AND (
          auction_contexts.fad_allocation_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_player_allocations
            WHERE free_agent_draft_player_allocations.league_id =
                auction_contexts.league_id
              AND free_agent_draft_player_allocations.id =
                auction_contexts.fad_allocation_id
              AND free_agent_draft_player_allocations.status =
                'correction_required'
              AND free_agent_draft_player_allocations
                .updated_at_ms = NEW.occurred_at_ms
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'FAD operational failure requires its exact private draw, job, and recovery'
  ) END;
END;

CREATE TRIGGER fad_auction_events_immutable_update
BEFORE UPDATE ON auction_events
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.season_id = OLD.season_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'FAD auction events are immutable');
END;

CREATE TRIGGER fad_auction_events_immutable_delete
BEFORE DELETE ON auction_events
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.season_id = OLD.season_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'FAD auction events are immutable');
END;

CREATE TRIGGER idempotency_requests_fad_bid_complete
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation = 'auction.bid.put'
  AND OLD.status = 'started'
  AND NEW.status = 'completed'
  AND EXISTS (
    SELECT 1
    FROM auction_bids
    JOIN auction_contexts
      ON auction_contexts.league_id = auction_bids.league_id
     AND auction_contexts.season_id = auction_bids.season_id
     AND auction_contexts.auction_id = auction_bids.auction_id
    WHERE auction_bids.league_id = NEW.league_id
      AND auction_bids.id = NEW.result_id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.result_type = 'auction_bid'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM auction_bids
      WHERE auction_bids.league_id = NEW.league_id
        AND auction_bids.id = NEW.result_id
        AND auction_bids.idempotency_request_id = NEW.id
        AND auction_bids.last_edited_at_ms =
          NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM auction_events
      JOIN auction_bids
        ON auction_bids.league_id = auction_events.league_id
       AND auction_bids.id = auction_events.bid_id
      WHERE auction_events.league_id = NEW.league_id
        AND auction_events.bid_id = NEW.result_id
        AND auction_events.auction_id = auction_bids.auction_id
        AND auction_events.team_id = auction_bids.team_id
        AND auction_events.actor_user_id = NEW.actor_user_id
        AND auction_events.occurred_at_ms =
          NEW.completed_at_ms
        AND auction_events.event_type = CASE
          WHEN auction_bids.version = 1
            THEN 'bid_submitted'
          ELSE 'bid_edited'
        END
    )
  ) THEN RAISE(
    ABORT,
    'FAD bid request must complete against its exact bid and event'
  ) END;
END;

CREATE TRIGGER auction_resolutions_require_context_insert
BEFORE INSERT ON auction_resolutions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
  ) THEN RAISE(
    ABORT,
    'auction resolution requires its persisted context'
  ) END;
END;

CREATE TRIGGER fad_auction_resolutions_context_insert
BEFORE INSERT ON auction_resolutions
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = NEW.league_id
    AND auction_contexts.season_id = NEW.season_id
    AND auction_contexts.auction_id = NEW.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT CASE WHEN NOT (
    NEW.scheduled_occurrence_key = (
      SELECT
        'auction:' || auctions.id || ':' ||
          auctions.resolves_at_ms
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
    )
    AND json_valid(NEW.warnings_json) = 1
    AND json_type(NEW.warnings_json) = 'array'
    AND json(NEW.warnings_json) = NEW.warnings_json
    AND NEW.general_illegal = CASE
      WHEN json_array_length(NEW.warnings_json) > 0 THEN 1
      ELSE 0
    END
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_draws
      JOIN auction_contexts
        ON auction_contexts.league_id =
            free_agent_draft_draws.league_id
       AND auction_contexts.season_id =
            free_agent_draft_draws.season_id
       AND auction_contexts.fad_id =
            free_agent_draft_draws.fad_id
       AND auction_contexts.fad_allocation_id IS
            free_agent_draft_draws.allocation_id
       AND auction_contexts.auction_id =
            free_agent_draft_draws.auction_id
      WHERE free_agent_draft_draws.league_id =
          NEW.league_id
        AND free_agent_draft_draws.season_id =
          NEW.season_id
        AND free_agent_draft_draws.auction_id =
          NEW.auction_id
        AND free_agent_draft_draws.revealed_at_ms IS NULL
        AND free_agent_draft_draws.version = 1
    )
  ) THEN RAISE(
    ABORT,
    'FAD result requires its canonical occurrence, warnings, and private draw'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.status = 'resolved'
      AND NEW.outcome_code = 'winner'
      AND NEW.winning_team_id IS NOT NULL
      AND NEW.winning_bid_id IS NOT NULL
      AND NEW.highest_bid_cents IS NOT NULL
      AND NEW.second_price_input_cents IS NOT NULL
      AND NEW.final_contract_value_cents IS NOT NULL
      AND NEW.winning_term_years IS NOT NULL
      AND NEW.final_aav_cents IS NOT NULL
      AND NEW.contract_id IS NOT NULL
      AND NEW.ownership_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auctions
        JOIN auction_bids
          ON auction_bids.league_id = auctions.league_id
         AND auction_bids.season_id = auctions.season_id
         AND auction_bids.auction_id = auctions.id
        JOIN contracts
          ON contracts.league_id = auction_bids.league_id
         AND contracts.id = NEW.contract_id
        JOIN player_ownerships
          ON player_ownerships.league_id =
              auction_bids.league_id
         AND player_ownerships.id = NEW.ownership_id
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status IN ('resolving', 'resolved')
          AND NEW.resolved_at_ms >= auctions.resolves_at_ms
          AND auction_bids.id = NEW.winning_bid_id
          AND auction_bids.team_id = NEW.winning_team_id
          AND auction_bids.status = 'won'
          AND auction_bids.total_value_cents =
            NEW.highest_bid_cents
          AND auction_bids.term_years =
            NEW.winning_term_years
          AND NEW.final_aav_cents = (
            (NEW.final_contract_value_cents /
              NEW.winning_term_years)
            + CASE
                WHEN
                  (
                    NEW.final_contract_value_cents %
                    NEW.winning_term_years
                  ) * 2 >= NEW.winning_term_years
                THEN 1
                ELSE 0
              END
          )
          AND contracts.player_id = auctions.player_id
          AND contracts.current_team_id =
            NEW.winning_team_id
          AND contracts.start_season_id = NEW.season_id
          AND contracts.original_total_value_cents =
            NEW.final_contract_value_cents
          AND contracts.original_term_years =
            NEW.winning_term_years
          AND contracts.aav_cents = NEW.final_aav_cents
          AND contracts.status = 'active'
          AND player_ownerships.season_id = NEW.season_id
          AND player_ownerships.player_id = auctions.player_id
          AND player_ownerships.team_id = NEW.winning_team_id
      )
    )
    OR (
      NEW.status IN ('no_bids', 'no_winner')
      AND NEW.outcome_code = 'no_winner'
      AND NEW.winning_team_id IS NULL
      AND NEW.winning_bid_id IS NULL
      AND NEW.highest_bid_cents IS NULL
      AND NEW.second_price_input_cents IS NULL
      AND NEW.final_contract_value_cents IS NULL
      AND NEW.winning_term_years IS NULL
      AND NEW.final_aav_cents IS NULL
      AND NEW.contract_id IS NULL
      AND NEW.ownership_id IS NULL
      AND NEW.general_illegal = 0
      AND NEW.warnings_json = '[]'
      AND EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status IN ('resolving', 'no_winner')
          AND NEW.resolved_at_ms >= auctions.resolves_at_ms
      )
    )
    OR (
      NEW.status = 'cancelled'
      AND NEW.outcome_code = 'failed'
      AND NEW.winning_team_id IS NULL
      AND NEW.winning_bid_id IS NULL
      AND NEW.highest_bid_cents IS NULL
      AND NEW.second_price_input_cents IS NULL
      AND NEW.final_contract_value_cents IS NULL
      AND NEW.winning_term_years IS NULL
      AND NEW.final_aav_cents IS NULL
      AND NEW.contract_id IS NULL
      AND NEW.ownership_id IS NULL
      AND NEW.general_illegal = 0
      AND NEW.warnings_json = '[]'
      AND NEW.trigger_type = 'commissioner'
      AND NEW.triggered_by_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auctions
        JOIN auction_contexts
          ON auction_contexts.league_id = auctions.league_id
         AND auction_contexts.season_id = auctions.season_id
         AND auction_contexts.auction_id = auctions.id
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status = 'cancelled'
          AND auctions.updated_at_ms = NEW.resolved_at_ms
          AND auction_contexts.source_kind =
            'fad_restricted'
      )
    )
    OR (
      NEW.status = 'cancelled'
      AND NEW.outcome_code IN (
        'recovered',
        'player_unavailable',
        'season_closed'
      )
      AND NEW.winning_team_id IS NULL
      AND NEW.winning_bid_id IS NULL
      AND NEW.highest_bid_cents IS NULL
      AND NEW.second_price_input_cents IS NULL
      AND NEW.final_contract_value_cents IS NULL
      AND NEW.winning_term_years IS NULL
      AND NEW.final_aav_cents IS NULL
      AND NEW.contract_id IS NULL
      AND NEW.ownership_id IS NULL
      AND NEW.general_illegal = 0
      AND NEW.warnings_json = '[]'
      AND (
        NEW.outcome_code <> 'recovered'
        OR (
          NEW.trigger_type = 'commissioner'
          AND NEW.triggered_by_user_id IS NOT NULL
        )
      )
      AND EXISTS (
        SELECT 1
        FROM auctions
        JOIN auction_contexts
          ON auction_contexts.league_id = auctions.league_id
         AND auction_contexts.season_id = auctions.season_id
         AND auction_contexts.auction_id = auctions.id
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status IN ('resolving', 'cancelled')
          AND auction_contexts.source_kind =
            'fad_open_rapid'
          AND (
            NEW.outcome_code = 'recovered'
            OR NEW.resolved_at_ms >= auctions.resolves_at_ms
          )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD result status and resources do not match its physical outcome'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM auction_events
    WHERE auction_events.league_id = NEW.league_id
      AND auction_events.season_id = NEW.season_id
      AND auction_events.auction_id = NEW.auction_id
      AND auction_events.occurred_at_ms = NEW.resolved_at_ms
      AND auction_events.event_type = CASE
        WHEN NEW.outcome_code = 'winner'
          THEN 'auction_resolved'
        WHEN NEW.outcome_code = 'no_winner'
          THEN 'auction_no_winner'
        ELSE 'auction_cancelled'
      END
      AND (
        NEW.trigger_type <> 'commissioner'
        OR auction_events.actor_user_id =
          NEW.triggered_by_user_id
      )
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD result requires one exact terminal auction event'
  ) END;

  SELECT CASE WHEN
    NEW.outcome_code IN ('winner', 'no_winner')
    AND (
      SELECT COUNT(*)
      FROM auctions
      JOIN job_runs
        ON job_runs.league_id = auctions.league_id
       AND job_runs.season_id = auctions.season_id
       AND job_runs.job_type = 'auction.resolve.target'
       AND job_runs.occurrence_key =
            'auction:' || auctions.id || ':' ||
              auctions.resolves_at_ms
       AND job_runs.scheduled_for_ms =
            auctions.resolves_at_ms
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms >
          NEW.resolved_at_ms
        AND job_runs.completed_at_ms IS NULL
        AND job_runs.updated_at_ms <= NEW.resolved_at_ms
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD semantic result requires its exact active resolution job'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
  ) AND NOT (
    (
      NEW.outcome_code = 'winner'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        JOIN free_agent_draft_player_allocations
          ON free_agent_draft_player_allocations.league_id =
              auction_contexts.league_id
         AND free_agent_draft_player_allocations.season_id =
              auction_contexts.season_id
         AND free_agent_draft_player_allocations.fad_id =
              auction_contexts.fad_id
         AND free_agent_draft_player_allocations.id =
              auction_contexts.fad_allocation_id
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.auction_id = NEW.auction_id
          AND free_agent_draft_player_allocations.status =
            'restricted_resolved'
          AND free_agent_draft_player_allocations.decision_code =
            'restricted_auction_result'
          AND free_agent_draft_player_allocations.winning_team_id =
            NEW.winning_team_id
          AND free_agent_draft_player_allocations.contract_id =
            NEW.contract_id
          AND free_agent_draft_player_allocations.ownership_id =
            NEW.ownership_id
          AND free_agent_draft_player_allocations.accounted_at_ms =
            NEW.resolved_at_ms
      )
    )
    OR (
      NEW.outcome_code = 'no_winner'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        JOIN free_agent_draft_player_allocations
          ON free_agent_draft_player_allocations.league_id =
              auction_contexts.league_id
         AND free_agent_draft_player_allocations.season_id =
              auction_contexts.season_id
         AND free_agent_draft_player_allocations.fad_id =
              auction_contexts.fad_id
         AND free_agent_draft_player_allocations.id =
              auction_contexts.fad_allocation_id
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.auction_id = NEW.auction_id
          AND free_agent_draft_player_allocations.status =
            'restricted_fallback_open'
          AND free_agent_draft_player_allocations.decision_code =
            'restricted_no_improvement_fallback'
          AND free_agent_draft_player_allocations
            .fallback_open_auction_id IS NOT NULL
      )
    )
    OR (
      NEW.outcome_code = 'failed'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        JOIN free_agent_draft_player_allocations
          ON free_agent_draft_player_allocations.league_id =
              auction_contexts.league_id
         AND free_agent_draft_player_allocations.season_id =
              auction_contexts.season_id
         AND free_agent_draft_player_allocations.fad_id =
              auction_contexts.fad_id
         AND free_agent_draft_player_allocations.id =
              auction_contexts.fad_allocation_id
        JOIN free_agent_draft_recoveries
          ON free_agent_draft_recoveries.league_id =
              auction_contexts.league_id
         AND free_agent_draft_recoveries.season_id =
              auction_contexts.season_id
         AND free_agent_draft_recoveries.fad_id =
              auction_contexts.fad_id
         AND free_agent_draft_recoveries.player_id = (
              SELECT player_id
              FROM auctions
              WHERE auctions.league_id = NEW.league_id
                AND auctions.id = NEW.auction_id
            )
         AND free_agent_draft_recoveries.allocation_id =
              auction_contexts.fad_allocation_id
         AND free_agent_draft_recoveries.rollover_id =
              auction_contexts.fad_rollover_id
         AND free_agent_draft_recoveries.auction_id =
              auction_contexts.auction_id
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.auction_id = NEW.auction_id
          AND free_agent_draft_player_allocations.status =
            'correction_required'
          AND free_agent_draft_player_allocations.updated_at_ms =
            NEW.resolved_at_ms
          AND free_agent_draft_recoveries.kind =
            'auction_resolution'
          AND free_agent_draft_recoveries.status =
            'correction_required'
          AND free_agent_draft_recoveries.created_at_ms =
            NEW.resolved_at_ms
          AND free_agent_draft_recoveries.resolved_at_ms IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'restricted result must reconcile its exact allocation and recovery state'
  ) END;

  SELECT CASE WHEN
    NEW.outcome_code = 'recovered'
    AND NOT EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN free_agent_draft_recoveries
        ON free_agent_draft_recoveries.league_id =
            auction_contexts.league_id
       AND free_agent_draft_recoveries.season_id =
            auction_contexts.season_id
       AND free_agent_draft_recoveries.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_recoveries.player_id = (
            SELECT player_id
            FROM auctions
            WHERE auctions.league_id = NEW.league_id
              AND auctions.id = NEW.auction_id
          )
       AND free_agent_draft_recoveries.allocation_id IS
            auction_contexts.fad_allocation_id
       AND free_agent_draft_recoveries.rollover_id =
            auction_contexts.fad_rollover_id
       AND free_agent_draft_recoveries.auction_id =
            auction_contexts.auction_id
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind = 'fad_open_rapid'
        AND free_agent_draft_recoveries.kind =
          'auction_resolution'
        AND free_agent_draft_recoveries.status = 'resolved'
        AND free_agent_draft_recoveries.resolved_at_ms =
          NEW.resolved_at_ms
        AND free_agent_draft_recoveries.resolved_by_user_id =
          NEW.triggered_by_user_id
        AND free_agent_draft_recoveries.resolved_authority IN (
          'commissioner',
          'platform_administrator_as_commissioner'
        )
    )
  THEN RAISE(
    ABORT,
    'recovered open FAD cancellation requires its resolved recovery'
  ) END;
END;

CREATE TRIGGER fad_auction_resolutions_immutable_update
BEFORE UPDATE ON auction_resolutions
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.season_id = OLD.season_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD auction resolution evidence is immutable'
  );
END;

CREATE TRIGGER fad_auction_resolutions_immutable_delete
BEFORE DELETE ON auction_resolutions
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.season_id = OLD.season_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD auction resolution evidence is immutable'
  );
END;

CREATE TRIGGER auctions_require_context_update
BEFORE UPDATE ON auctions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'auction state transition requires its persisted context'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
  ) AND NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.opened_at_ms IS OLD.opened_at_ms
    AND NEW.resolves_at_ms IS OLD.resolves_at_ms
    AND NEW.opened_by_user_id IS OLD.opened_by_user_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND OLD.status NOT IN (
      'resolved',
      'no_winner',
      'cancelled'
    )
  ) THEN RAISE(
    ABORT,
    'FAD auction identity and terminal history are immutable'
  ) END;

  SELECT CASE WHEN
    NEW.status IN ('resolved', 'no_winner', 'cancelled')
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      (
        NEW.status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM auction_contexts
          JOIN free_agent_draft_player_allocations
            ON free_agent_draft_player_allocations.league_id =
                auction_contexts.league_id
           AND free_agent_draft_player_allocations.season_id =
                auction_contexts.season_id
           AND free_agent_draft_player_allocations.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_player_allocations.id =
                auction_contexts.fad_allocation_id
          JOIN free_agent_draft_draws
            ON free_agent_draft_draws.league_id =
                auction_contexts.league_id
           AND free_agent_draft_draws.season_id =
                auction_contexts.season_id
           AND free_agent_draft_draws.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_draws.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_draws.auction_id =
                auction_contexts.auction_id
          JOIN free_agent_draft_recoveries
            ON free_agent_draft_recoveries.league_id =
                auction_contexts.league_id
           AND free_agent_draft_recoveries.season_id =
                auction_contexts.season_id
           AND free_agent_draft_recoveries.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_recoveries.player_id =
                NEW.player_id
           AND free_agent_draft_recoveries.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_recoveries.rollover_id =
                auction_contexts.fad_rollover_id
           AND free_agent_draft_recoveries.auction_id =
                auction_contexts.auction_id
          WHERE auction_contexts.league_id = NEW.league_id
            AND auction_contexts.season_id = NEW.season_id
            AND auction_contexts.auction_id = NEW.id
            AND auction_contexts.source_kind =
              'fad_restricted'
            AND free_agent_draft_player_allocations.status =
              'correction_required'
            AND free_agent_draft_player_allocations
              .restricted_auction_id = NEW.id
            AND free_agent_draft_player_allocations
              .updated_at_ms = NEW.updated_at_ms
            AND free_agent_draft_draws.revealed_at_ms IS NULL
            AND free_agent_draft_draws.version = 1
            AND free_agent_draft_recoveries.kind =
              'auction_resolution'
            AND free_agent_draft_recoveries.status =
              'correction_required'
            AND free_agent_draft_recoveries.last_error_code
              IS NOT NULL
            AND free_agent_draft_recoveries.created_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_recoveries.updated_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_recoveries.resolved_at_ms IS NULL
            AND free_agent_draft_recoveries
              .resolved_by_user_id IS NULL
            AND free_agent_draft_recoveries
              .resolved_by_membership_id IS NULL
            AND free_agent_draft_recoveries
              .resolved_authority IS NULL
        )
      )
      OR (
        NOT (
          NEW.status = 'cancelled'
          AND EXISTS (
            SELECT 1
            FROM auction_contexts
            WHERE auction_contexts.league_id = NEW.league_id
              AND auction_contexts.season_id = NEW.season_id
              AND auction_contexts.auction_id = NEW.id
              AND auction_contexts.source_kind =
                'fad_restricted'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_draws
          WHERE free_agent_draft_draws.league_id =
              NEW.league_id
            AND free_agent_draft_draws.auction_id = NEW.id
            AND free_agent_draft_draws.revealed_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_draws.version = 2
        )
      )
    )
  THEN RAISE(
    ABORT,
    'terminal FAD auction requires the exact revealed or correction draw state'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'failed'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      OLD.status IN ('open', 'resolving')
      AND NEW.updated_at_ms >= NEW.resolves_at_ms
      AND NOT EXISTS (
        SELECT 1
        FROM auction_resolutions
        WHERE auction_resolutions.league_id = NEW.league_id
          AND auction_resolutions.auction_id = NEW.id
      )
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_draws
        WHERE free_agent_draft_draws.league_id =
            NEW.league_id
          AND free_agent_draft_draws.auction_id = NEW.id
          AND free_agent_draft_draws.revealed_at_ms IS NULL
          AND free_agent_draft_draws.version = 1
      )
    )
  THEN RAISE(
    ABORT,
    'failed FAD auction must preserve its private draw and have no result'
  ) END;
END;

CREATE TRIGGER fad_failed_auctions_recovery_update
BEFORE UPDATE OF status ON auctions
WHEN OLD.status = 'failed'
  AND NEW.status <> OLD.status
  AND EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
  )
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
      SELECT 1
      FROM auction_events
      WHERE auction_events.league_id = OLD.league_id
        AND auction_events.season_id = OLD.season_id
        AND auction_events.auction_id = OLD.id
        AND auction_events.event_type =
          'fad_auction_resolution_failed'
        AND auction_events.actor_user_id IS NULL
        AND auction_events.bid_id IS NULL
        AND auction_events.team_id IS NULL
        AND auction_events.occurred_at_ms =
          OLD.updated_at_ms
    )
    AND NOT EXISTS (
      SELECT 1
      FROM auction_resolutions
      WHERE auction_resolutions.league_id = OLD.league_id
        AND auction_resolutions.auction_id = OLD.id
    )
    AND (
      (
        NEW.status = 'resolving'
        AND EXISTS (
          SELECT 1
          FROM auction_contexts
          JOIN free_agent_draft_recoveries
            ON free_agent_draft_recoveries.league_id =
                auction_contexts.league_id
           AND free_agent_draft_recoveries.season_id =
                auction_contexts.season_id
           AND free_agent_draft_recoveries.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_recoveries.player_id =
                OLD.player_id
           AND free_agent_draft_recoveries.allocation_id IS
                auction_contexts.fad_allocation_id
           AND free_agent_draft_recoveries.rollover_id =
                auction_contexts.fad_rollover_id
           AND free_agent_draft_recoveries.auction_id =
                auction_contexts.auction_id
          JOIN job_runs
            ON job_runs.league_id =
                free_agent_draft_recoveries.league_id
           AND job_runs.id =
                free_agent_draft_recoveries.job_run_id
          WHERE auction_contexts.league_id = OLD.league_id
            AND auction_contexts.season_id = OLD.season_id
            AND auction_contexts.auction_id = OLD.id
            AND free_agent_draft_recoveries.kind =
              'auction_resolution'
            AND free_agent_draft_recoveries.status =
              'running'
            AND free_agent_draft_recoveries.updated_at_ms <=
              NEW.updated_at_ms
            AND job_runs.job_type =
              'auction.resolve.target'
            AND job_runs.occurrence_key =
              'auction:' || OLD.id || ':' ||
                OLD.resolves_at_ms
            AND job_runs.scheduled_for_ms =
              OLD.resolves_at_ms
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms >
              NEW.updated_at_ms
        )
      )
      OR (
        NEW.status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM auction_contexts
          JOIN free_agent_draft_player_allocations
            ON free_agent_draft_player_allocations.league_id =
                auction_contexts.league_id
           AND free_agent_draft_player_allocations.season_id =
                auction_contexts.season_id
           AND free_agent_draft_player_allocations.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_player_allocations.id =
                auction_contexts.fad_allocation_id
          JOIN free_agent_draft_recoveries
            ON free_agent_draft_recoveries.league_id =
                auction_contexts.league_id
           AND free_agent_draft_recoveries.season_id =
                auction_contexts.season_id
           AND free_agent_draft_recoveries.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_recoveries.player_id =
                OLD.player_id
           AND free_agent_draft_recoveries.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_recoveries.rollover_id =
                auction_contexts.fad_rollover_id
           AND free_agent_draft_recoveries.auction_id =
                auction_contexts.auction_id
          WHERE auction_contexts.league_id = OLD.league_id
            AND auction_contexts.season_id = OLD.season_id
            AND auction_contexts.auction_id = OLD.id
            AND auction_contexts.source_kind =
              'fad_restricted'
            AND free_agent_draft_player_allocations.status =
              'correction_required'
            AND free_agent_draft_recoveries.kind =
              'auction_resolution'
            AND free_agent_draft_recoveries.status =
              'correction_required'
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'failed FAD auction may only advance through exact retry or restricted correction'
  ) END;
END;

CREATE TRIGGER free_agent_draft_schedule_recoveries_valid_insert
BEFORE INSERT ON free_agent_draft_schedule_recoveries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.created_at_ms = NEW.completed_at_ms
    AND EXISTS (
      SELECT 1
      FROM matchup_operations
      WHERE matchup_operations.league_id = NEW.league_id
        AND matchup_operations.season_id = NEW.season_id
        AND matchup_operations.id = NEW.matchup_operation_id
        AND matchup_operations.operation_type = 'schedule_generate'
        AND matchup_operations.status = 'succeeded'
        AND matchup_operations.matchup_week_id IS NULL
        AND matchup_operations.matchup_id IS NULL
        AND matchup_operations.completed_at_ms =
          NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM season_matchup_schedule_generations AS old_generation
      WHERE old_generation.league_id = NEW.league_id
        AND old_generation.season_id = NEW.season_id
        AND old_generation.schedule_operation_id =
          NEW.old_schedule_operation_id
        AND old_generation.schedule_version =
          NEW.old_schedule_version
        AND old_generation.week_one_matchup_week_id =
          NEW.old_first_matchup_week_id
        AND old_generation.week_one_starts_at_ms =
          NEW.old_week_one_starts_at_ms
        AND old_generation.status = 'superseded'
        AND old_generation.superseded_at_ms =
          NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM season_matchup_schedule_generations AS new_generation
      WHERE new_generation.league_id = NEW.league_id
        AND new_generation.season_id = NEW.season_id
        AND new_generation.schedule_operation_id =
          NEW.new_schedule_operation_id
        AND new_generation.schedule_version =
          NEW.new_schedule_version
        AND new_generation.week_one_matchup_week_id =
          NEW.new_first_matchup_week_id
        AND new_generation.week_one_starts_at_ms =
          NEW.new_week_one_starts_at_ms
        AND new_generation.status = 'current'
        AND new_generation.created_at_ms = NEW.completed_at_ms
    )
    AND (
      SELECT COUNT(*)
      FROM free_agent_draft_schedule_recovery_weeks
      WHERE free_agent_draft_schedule_recovery_weeks.league_id =
          NEW.league_id
        AND free_agent_draft_schedule_recovery_weeks.season_id =
          NEW.season_id
        AND free_agent_draft_schedule_recovery_weeks
          .schedule_recovery_id = NEW.id
        AND free_agent_draft_schedule_recovery_weeks.created_at_ms =
          NEW.completed_at_ms
    ) = NEW.removed_week_count
    AND (
      SELECT MIN(removed_sequence)
      FROM free_agent_draft_schedule_recovery_weeks
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
        AND schedule_recovery_id = NEW.id
    ) = 1
    AND (
      SELECT MAX(removed_sequence)
      FROM free_agent_draft_schedule_recovery_weeks
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
        AND schedule_recovery_id = NEW.id
    ) = NEW.removed_week_count
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_schedule_recovery_weeks
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
        AND schedule_recovery_id = NEW.id
        AND removed_sequence = 1
        AND removed_matchup_week_id =
          NEW.old_first_matchup_week_id
        AND removed_starts_at_ms =
          NEW.old_week_one_starts_at_ms
    )
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_schedule_recovery_weeks
      WHERE league_id = NEW.league_id
        AND schedule_recovery_id = NEW.id
        AND (
          season_id <> NEW.season_id
          OR created_at_ms <> NEW.completed_at_ms
          OR removed_starts_at_ms >=
            NEW.new_week_one_starts_at_ms
          OR removed_matchup_week_id =
            NEW.new_first_matchup_week_id
        )
    )
    AND (
      SELECT COUNT(*)
      FROM free_agent_draft_schedule_recovery_matchups
      WHERE free_agent_draft_schedule_recovery_matchups.league_id =
          NEW.league_id
        AND free_agent_draft_schedule_recovery_matchups.season_id =
          NEW.season_id
        AND free_agent_draft_schedule_recovery_matchups
          .schedule_recovery_id = NEW.id
        AND free_agent_draft_schedule_recovery_matchups.created_at_ms =
          NEW.completed_at_ms
    ) = NEW.removed_matchup_count
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_schedule_recovery_matchups AS removed_matchup
      WHERE removed_matchup.league_id = NEW.league_id
        AND removed_matchup.schedule_recovery_id = NEW.id
        AND (
          removed_matchup.season_id <> NEW.season_id
          OR removed_matchup.created_at_ms <>
            NEW.completed_at_ms
          OR NOT EXISTS (
            SELECT 1
            FROM free_agent_draft_schedule_recovery_weeks AS removed_week
            WHERE removed_week.league_id =
                removed_matchup.league_id
              AND removed_week.season_id =
                removed_matchup.season_id
              AND removed_week.schedule_recovery_id =
                removed_matchup.schedule_recovery_id
              AND removed_week.removed_matchup_week_id =
                removed_matchup.removed_matchup_week_id
          )
        )
    )
    AND (
      SELECT COUNT(*)
      FROM free_agent_draft_schedule_recovery_jobs
      WHERE free_agent_draft_schedule_recovery_jobs.league_id =
          NEW.league_id
        AND free_agent_draft_schedule_recovery_jobs.season_id =
          NEW.season_id
        AND free_agent_draft_schedule_recovery_jobs
          .schedule_recovery_id = NEW.id
        AND free_agent_draft_schedule_recovery_jobs.disposition =
          'replaced'
        AND free_agent_draft_schedule_recovery_jobs.created_at_ms =
          NEW.completed_at_ms
    ) = NEW.replaced_job_count
    AND (
      SELECT COUNT(*)
      FROM free_agent_draft_schedule_recovery_jobs
      WHERE free_agent_draft_schedule_recovery_jobs.league_id =
          NEW.league_id
        AND free_agent_draft_schedule_recovery_jobs.season_id =
          NEW.season_id
        AND free_agent_draft_schedule_recovery_jobs
          .schedule_recovery_id = NEW.id
        AND free_agent_draft_schedule_recovery_jobs.disposition =
          'cancelled'
        AND free_agent_draft_schedule_recovery_jobs.created_at_ms =
          NEW.completed_at_ms
    ) = NEW.cancelled_job_count
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_schedule_recovery_jobs AS job_effect
      WHERE job_effect.league_id = NEW.league_id
        AND job_effect.schedule_recovery_id = NEW.id
        AND (
          job_effect.season_id <> NEW.season_id
          OR job_effect.created_at_ms <> NEW.completed_at_ms
          OR job_effect.replaced_schedule_operation_id <>
            NEW.old_schedule_operation_id
          OR job_effect.replaced_schedule_version <>
            NEW.old_schedule_version
          OR (
            job_effect.disposition = 'replaced'
            AND (
              job_effect.replacement_schedule_operation_id <>
                NEW.new_schedule_operation_id
              OR job_effect.replacement_schedule_version <>
                NEW.new_schedule_version
            )
          )
          OR (
            job_effect.disposition = 'cancelled'
            AND NOT EXISTS (
              SELECT 1
              FROM matchup_schedule_job_bindings AS old_binding
              JOIN free_agent_draft_schedule_recovery_weeks AS removed_week
                ON removed_week.league_id =
                    old_binding.league_id
               AND removed_week.season_id =
                    old_binding.season_id
               AND removed_week.schedule_recovery_id =
                    job_effect.schedule_recovery_id
               AND removed_week.removed_matchup_week_id =
                    old_binding.owning_matchup_week_id
              WHERE old_binding.league_id =
                  job_effect.league_id
                AND old_binding.job_run_id =
                  job_effect.replaced_job_run_id
            )
          )
        )
    )
    AND (
      (
        NEW.recovery_kind = 'pre_open'
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          JOIN free_agent_draft_readiness_operations
            ON free_agent_draft_readiness_operations.league_id =
                free_agent_drafts.league_id
           AND free_agent_draft_readiness_operations.id =
                free_agent_drafts.readiness_operation_id
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'cards_open'
            AND free_agent_drafts.first_matchup_week_id =
              NEW.new_first_matchup_week_id
            AND free_agent_draft_readiness_operations.status =
              'running'
        )
      )
      OR (
        NEW.recovery_kind = 'completion'
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'rapid'
            AND free_agent_drafts.current_competition_first_matchup_week_id =
              NEW.old_first_matchup_week_id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD schedule recovery must bind one exact old and new generation'
  ) END;
END;

CREATE TRIGGER free_agent_draft_schedule_recoveries_immutable_update
BEFORE UPDATE ON free_agent_draft_schedule_recoveries
BEGIN
  SELECT RAISE(ABORT, 'FAD schedule recovery root is immutable');
END;

CREATE TRIGGER free_agent_draft_schedule_recoveries_immutable_delete
BEFORE DELETE ON free_agent_draft_schedule_recoveries
BEGIN
  SELECT RAISE(ABORT, 'FAD schedule recovery root is immutable');
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_weeks_valid_insert
BEFORE INSERT ON free_agent_draft_schedule_recovery_weeks
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_schedule_recoveries
    WHERE free_agent_draft_schedule_recoveries.league_id =
        NEW.league_id
      AND free_agent_draft_schedule_recoveries.id =
        NEW.schedule_recovery_id
  ) THEN RAISE(
    ABORT,
    'removed schedule week evidence must be staged before the recovery seal'
  ) END;
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_weeks_immutable_update
BEFORE UPDATE ON free_agent_draft_schedule_recovery_weeks
BEGIN
  SELECT RAISE(ABORT, 'removed schedule week evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_weeks_immutable_delete
BEFORE DELETE ON free_agent_draft_schedule_recovery_weeks
BEGIN
  SELECT RAISE(ABORT, 'removed schedule week evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_matchups_valid_insert
BEFORE INSERT ON free_agent_draft_schedule_recovery_matchups
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_schedule_recoveries
    WHERE free_agent_draft_schedule_recoveries.league_id =
        NEW.league_id
      AND free_agent_draft_schedule_recoveries.id =
        NEW.schedule_recovery_id
  ) THEN RAISE(
    ABORT,
    'removed matchup evidence must be staged before the recovery seal'
  ) END;
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_matchups_immutable_update
BEFORE UPDATE ON free_agent_draft_schedule_recovery_matchups
BEGIN
  SELECT RAISE(ABORT, 'removed matchup evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_matchups_immutable_delete
BEFORE DELETE ON free_agent_draft_schedule_recovery_matchups
BEGIN
  SELECT RAISE(ABORT, 'removed matchup evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_jobs_valid_insert
BEFORE INSERT ON free_agent_draft_schedule_recovery_jobs
BEGIN
  SELECT CASE WHEN NOT (
    NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_schedule_recoveries
      WHERE free_agent_draft_schedule_recoveries.league_id =
          NEW.league_id
        AND free_agent_draft_schedule_recoveries.id =
          NEW.schedule_recovery_id
    )
    AND EXISTS (
      SELECT 1
      FROM job_runs AS replaced_job
      JOIN matchup_schedule_job_bindings AS replaced_binding
        ON replaced_binding.league_id = replaced_job.league_id
       AND replaced_binding.job_run_id = replaced_job.id
      WHERE replaced_job.league_id = NEW.league_id
        AND replaced_job.season_id = NEW.season_id
        AND replaced_job.id = NEW.replaced_job_run_id
        AND replaced_job.job_type = NEW.job_type
        AND replaced_job.occurrence_key =
          NEW.replaced_occurrence_key
        AND replaced_job.status = 'skipped'
        AND replaced_job.attempt_count = 0
        AND replaced_job.lease_owner IS NULL
        AND replaced_job.lease_token IS NULL
        AND replaced_job.lease_expires_at_ms IS NULL
        AND replaced_job.started_at_ms IS NULL
        AND replaced_job.completed_at_ms IS NULL
        AND replaced_job.result_json IS NULL
        AND replaced_job.last_error_code IS NULL
        AND replaced_job.next_attempt_at_ms IS NULL
        AND replaced_job.version = NEW.replaced_job_version
        AND replaced_job.updated_at_ms = NEW.created_at_ms
        AND replaced_binding.season_id = NEW.season_id
        AND replaced_binding.job_type = NEW.job_type
        AND replaced_binding.schedule_operation_id =
          NEW.replaced_schedule_operation_id
        AND replaced_binding.schedule_version =
          NEW.replaced_schedule_version
    )
    AND (
      NEW.disposition = 'cancelled'
      OR EXISTS (
        SELECT 1
        FROM job_runs AS replacement_job
        JOIN matchup_schedule_job_bindings AS replacement_binding
          ON replacement_binding.league_id =
              replacement_job.league_id
         AND replacement_binding.job_run_id =
              replacement_job.id
        WHERE replacement_job.league_id = NEW.league_id
          AND replacement_job.season_id = NEW.season_id
          AND replacement_job.id = NEW.replacement_job_run_id
          AND replacement_job.job_type = NEW.job_type
          AND replacement_job.occurrence_key =
            NEW.replacement_occurrence_key
          AND replacement_job.status = 'pending'
          AND replacement_job.attempt_count = 0
          AND replacement_job.lease_owner IS NULL
          AND replacement_job.lease_token IS NULL
          AND replacement_job.lease_expires_at_ms IS NULL
          AND replacement_job.started_at_ms IS NULL
          AND replacement_job.completed_at_ms IS NULL
          AND replacement_job.result_json IS NULL
          AND replacement_job.last_error_code IS NULL
          AND replacement_job.version =
            NEW.replacement_job_version
          AND replacement_job.created_at_ms = NEW.created_at_ms
          AND replacement_binding.season_id = NEW.season_id
          AND replacement_binding.job_type = NEW.job_type
          AND replacement_binding.schedule_operation_id =
            NEW.replacement_schedule_operation_id
          AND replacement_binding.schedule_version =
            NEW.replacement_schedule_version
      )
    )
  ) THEN RAISE(
    ABORT,
    'schedule recovery job must prove one skipped old job and any exact replacement'
  ) END;
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_jobs_immutable_update
BEFORE UPDATE ON free_agent_draft_schedule_recovery_jobs
BEGIN
  SELECT RAISE(ABORT, 'schedule recovery job evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_schedule_recovery_jobs_immutable_delete
BEFORE DELETE ON free_agent_draft_schedule_recovery_jobs
BEGIN
  SELECT RAISE(ABORT, 'schedule recovery job evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_recoveries_valid_insert
BEFORE INSERT ON free_agent_draft_recoveries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status IN (
      'pending',
      'ready',
      'running',
      'correction_required'
    )
    AND NEW.resolved_at_ms IS NULL
    AND NEW.resolved_by_user_id IS NULL
    AND NEW.resolved_by_membership_id IS NULL
    AND NEW.resolved_authority IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND (
      NEW.allocation_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_player_allocations
        WHERE free_agent_draft_player_allocations.league_id =
            NEW.league_id
          AND free_agent_draft_player_allocations.season_id =
            NEW.season_id
          AND free_agent_draft_player_allocations.fad_id =
            NEW.fad_id
          AND free_agent_draft_player_allocations.id =
            NEW.allocation_id
          AND free_agent_draft_player_allocations.player_id =
            NEW.player_id
      )
    )
    AND (
      NEW.rollover_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_rollovers
        WHERE free_agent_draft_rollovers.league_id = NEW.league_id
          AND free_agent_draft_rollovers.season_id = NEW.season_id
          AND free_agent_draft_rollovers.fad_id = NEW.fad_id
          AND free_agent_draft_rollovers.id = NEW.rollover_id
      )
    )
    AND (
      NEW.auction_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM auction_contexts
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.season_id = NEW.season_id
          AND auction_contexts.auction_id = NEW.auction_id
          AND auction_contexts.fad_id = NEW.fad_id
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery must preserve exact causal resources'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recoveries_forward_update
BEFORE UPDATE ON free_agent_draft_recoveries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.rollover_id IS OLD.rollover_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.job_run_id IS OLD.job_run_id
    AND NEW.kind IS OLD.kind
    AND NEW.earliest_activation_at_ms IS
      OLD.earliest_activation_at_ms
    AND NEW.target_resolution_at_ms IS
      OLD.target_resolution_at_ms
    AND NEW.created_by_operation_id IS
      OLD.created_by_operation_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status IN ('pending', 'ready')
        AND NEW.status = 'running'
        AND NEW.resolved_at_ms IS NULL
        AND NEW.resolved_authority IS NULL
      )
      OR (
        OLD.status = 'running'
        AND NEW.status = 'resolved'
        AND NEW.resolved_at_ms = NEW.updated_at_ms
        AND NEW.resolved_authority IS NOT NULL
        AND (
          NEW.resolved_authority = 'system'
          OR EXISTS (
            SELECT 1
            FROM league_memberships
            WHERE league_memberships.league_id = NEW.league_id
              AND league_memberships.id =
                NEW.resolved_by_membership_id
              AND league_memberships.user_id =
                NEW.resolved_by_user_id
          )
        )
        AND (
          (
            NEW.kind = 'deadline_retry'
            AND EXISTS (
              SELECT 1
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = NEW.league_id
                AND free_agent_drafts.id = NEW.fad_id
                AND free_agent_drafts.status IN (
                  'deadline_locked',
                  'allocating',
                  'rapid',
                  'completed'
                )
                AND free_agent_drafts.deadline_locked_at_ms
                  IS NOT NULL
            )
          )
          OR (
            NEW.kind = 'allocation_retry'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.allocation_id
                AND free_agent_draft_player_allocations.status IN (
                  'automatic_award',
                  'restricted_scheduled',
                  'restricted_active',
                  'restricted_fallback_open',
                  'restricted_resolved',
                  'fallback_open_resolved',
                  'no_valid_offer',
                  'invalid'
                )
                AND free_agent_draft_player_allocations.status <>
                  'correction_required'
            )
          )
          OR (
            NEW.kind = 'restricted_activation'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              JOIN auctions
                ON auctions.league_id =
                    free_agent_draft_player_allocations.league_id
               AND auctions.id =
                    free_agent_draft_player_allocations
                      .restricted_auction_id
              JOIN auction_contexts
                ON auction_contexts.league_id = auctions.league_id
               AND auction_contexts.auction_id = auctions.id
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.allocation_id
                AND free_agent_draft_player_allocations
                  .restricted_auction_id = NEW.auction_id
                AND free_agent_draft_player_allocations.status IN (
                  'restricted_active',
                  'restricted_resolved',
                  'restricted_fallback_open',
                  'fallback_open_resolved'
                )
                AND auctions.status IN (
                  'open',
                  'resolving',
                  'resolved',
                  'no_winner'
                )
                AND auction_contexts.source_kind =
                  'fad_restricted'
            )
          )
          OR (
            NEW.kind = 'queued_nomination_activation'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_nomination_queue
              WHERE free_agent_draft_nomination_queue.league_id =
                  NEW.league_id
                AND free_agent_draft_nomination_queue.fad_id =
                  NEW.fad_id
                AND free_agent_draft_nomination_queue.id =
                  NEW.created_by_operation_id
                AND free_agent_draft_nomination_queue.player_id =
                  NEW.player_id
                AND free_agent_draft_nomination_queue
                  .target_opening_rollover_id = NEW.rollover_id
                AND free_agent_draft_nomination_queue.status IN (
                  'opened',
                  'invalid'
                )
                AND free_agent_draft_nomination_queue
                  .terminal_at_ms <= NEW.resolved_at_ms
            )
          )
          OR (
            NEW.kind = 'fallback_activation'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              JOIN auctions
                ON auctions.league_id =
                    free_agent_draft_player_allocations.league_id
               AND auctions.id =
                    free_agent_draft_player_allocations
                      .fallback_open_auction_id
              JOIN auction_contexts
                ON auction_contexts.league_id = auctions.league_id
               AND auction_contexts.auction_id = auctions.id
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.allocation_id
                AND free_agent_draft_player_allocations
                  .fallback_open_auction_id = NEW.auction_id
                AND free_agent_draft_player_allocations.status IN (
                  'restricted_fallback_open',
                  'fallback_open_resolved'
                )
                AND auctions.status IN (
                  'open',
                  'resolving',
                  'resolved',
                  'no_winner'
                )
                AND auction_contexts.source_kind =
                  'fad_open_rapid'
                AND auction_contexts.fad_origin =
                  'restricted_no_improvement_fallback'
            )
          )
          OR (
            NEW.kind = 'auction_resolution'
            AND (
              EXISTS (
                SELECT 1
                FROM auctions
                JOIN free_agent_draft_draws
                  ON free_agent_draft_draws.league_id =
                      auctions.league_id
                 AND free_agent_draft_draws.auction_id =
                      auctions.id
                WHERE auctions.league_id = NEW.league_id
                  AND auctions.id = NEW.auction_id
                  AND auctions.status IN (
                    'resolved',
                    'no_winner',
                    'cancelled'
                  )
                  AND free_agent_draft_draws.revealed_at_ms =
                    auctions.updated_at_ms
                  AND (
                    SELECT COUNT(*)
                    FROM auction_resolutions
                    WHERE auction_resolutions.league_id =
                        auctions.league_id
                      AND auction_resolutions.auction_id =
                        auctions.id
                      AND auction_resolutions.status IN (
                        'resolved',
                        'no_bids',
                        'no_winner',
                        'cancelled',
                        'recovered'
                      )
                  ) = 1
              )
              OR EXISTS (
                SELECT 1
                FROM auctions
                JOIN auction_contexts
                  ON auction_contexts.league_id = auctions.league_id
                 AND auction_contexts.season_id = auctions.season_id
                 AND auction_contexts.auction_id = auctions.id
                JOIN auction_resolutions
                  ON auction_resolutions.league_id = auctions.league_id
                 AND auction_resolutions.season_id = auctions.season_id
                 AND auction_resolutions.auction_id = auctions.id
                JOIN free_agent_draft_draws
                  ON free_agent_draft_draws.league_id = auctions.league_id
                 AND free_agent_draft_draws.season_id = auctions.season_id
                 AND free_agent_draft_draws.fad_id =
                      auction_contexts.fad_id
                 AND free_agent_draft_draws.allocation_id =
                      auction_contexts.fad_allocation_id
                 AND free_agent_draft_draws.auction_id = auctions.id
                JOIN free_agent_draft_player_allocations AS allocation
                  ON allocation.league_id = auction_contexts.league_id
                 AND allocation.season_id = auction_contexts.season_id
                 AND allocation.fad_id = auction_contexts.fad_id
                 AND allocation.id = auction_contexts.fad_allocation_id
                 AND allocation.player_id = auctions.player_id
                JOIN free_agent_draft_allocation_events AS correction_event
                  ON correction_event.league_id = allocation.league_id
                 AND correction_event.season_id = allocation.season_id
                 AND correction_event.fad_id = allocation.fad_id
                 AND correction_event.allocation_id = allocation.id
                 AND correction_event.allocation_version = allocation.version
                 AND correction_event.player_id = allocation.player_id
                JOIN commissioner_corrections
                  ON commissioner_corrections.league_id =
                      correction_event.league_id
                 AND commissioner_corrections.id =
                      correction_event.correction_id
                 AND commissioner_corrections.season_id =
                      correction_event.season_id
                JOIN job_runs
                  ON job_runs.league_id = auctions.league_id
                 AND job_runs.season_id = auctions.season_id
                 AND job_runs.id = NEW.job_run_id
                WHERE auctions.league_id = NEW.league_id
                  AND auctions.season_id = NEW.season_id
                  AND auctions.id = NEW.auction_id
                  AND auctions.player_id = NEW.player_id
                  AND auctions.status = 'cancelled'
                  AND auctions.updated_at_ms <= NEW.resolved_at_ms
                  AND auction_contexts.source_kind = 'fad_restricted'
                  AND auction_contexts.fad_id = NEW.fad_id
                  AND auction_contexts.fad_rollover_id = NEW.rollover_id
                  AND auction_contexts.fad_allocation_id =
                      NEW.allocation_id
                  AND auction_contexts.fad_origin =
                      'candidate_tie_restricted'
                  AND auction_resolutions.scheduled_occurrence_key =
                      'auction:' || auctions.id || ':' ||
                        auctions.resolves_at_ms
                  AND auction_resolutions.status = 'cancelled'
                  AND auction_resolutions.outcome_code = 'failed'
                  AND auction_resolutions.resolved_at_ms =
                      auctions.updated_at_ms
                  AND free_agent_draft_draws.revealed_at_ms IS NULL
                  AND free_agent_draft_draws.ordered_tied_bid_ids_json
                      IS NULL
                  AND free_agent_draft_draws.ordered_tied_team_ids_json
                      IS NULL
                  AND free_agent_draft_draws.selected_bid_id IS NULL
                  AND free_agent_draft_draws.selected_team_id IS NULL
                  AND free_agent_draft_draws.updated_at_ms =
                      free_agent_draft_draws.created_at_ms
                  AND free_agent_draft_draws.version = 1
                  AND allocation.status IN (
                    'automatic_award',
                    'restricted_resolved',
                    'fallback_open_resolved',
                    'no_valid_offer',
                    'invalid'
                  )
                  AND allocation.decision_code = 'corrected'
                  AND allocation.restricted_auction_id = auctions.id
                  AND allocation.last_error_code IS NULL
                  AND allocation.accounted_at_ms <= NEW.resolved_at_ms
                  AND correction_event.event_kind = 'correction_applied'
                  AND correction_event.decision_code = 'corrected'
                  AND correction_event.resulting_allocation_status =
                      allocation.status
                  AND correction_event.auction_id = auctions.id
                  AND correction_event.actor_authority IN (
                    'commissioner',
                    'platform_administrator_as_commissioner'
                  )
                  AND correction_event.occurred_at_ms =
                      allocation.accounted_at_ms
                  AND commissioner_corrections.feature =
                      'free_agent_draft_allocation'
                  AND commissioner_corrections.feature_record_id =
                      allocation.id
                  AND commissioner_corrections.actor_user_id =
                      correction_event.actor_user_id
                  AND commissioner_corrections.corrected_at_ms =
                      correction_event.occurred_at_ms
                  AND job_runs.job_type = 'auction.resolve.target'
                  AND job_runs.occurrence_key =
                      auction_resolutions.scheduled_occurrence_key
                  AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
                  AND job_runs.status = 'failed'
                  AND job_runs.attempt_count >= 1
                  AND job_runs.lease_owner IS NULL
                  AND job_runs.lease_token IS NULL
                  AND job_runs.lease_expires_at_ms IS NULL
                  AND job_runs.result_json IS NULL
                  AND job_runs.last_error_code = OLD.last_error_code
                  AND job_runs.completed_at_ms = auctions.updated_at_ms
              )
            )
            AND (
              NEW.allocation_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM free_agent_draft_player_allocations
                WHERE free_agent_draft_player_allocations.league_id =
                    NEW.league_id
                  AND free_agent_draft_player_allocations.id =
                    NEW.allocation_id
                  AND free_agent_draft_player_allocations.status IN (
                    'restricted_resolved',
                    'restricted_fallback_open',
                    'fallback_open_resolved',
                    'no_valid_offer',
                    'invalid'
                  )
              )
            )
          )
          OR (
            NEW.kind = 'rollover_finalize'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_rollovers
              WHERE free_agent_draft_rollovers.league_id =
                  NEW.league_id
                AND free_agent_draft_rollovers.id =
                  NEW.rollover_id
                AND free_agent_draft_rollovers.status =
                  'completed'
                AND free_agent_draft_rollovers.completed_at_ms <=
                  NEW.resolved_at_ms
            )
          )
          OR (
            NEW.kind = 'completion'
            AND EXISTS (
              SELECT 1
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = NEW.league_id
                AND free_agent_drafts.id = NEW.fad_id
                AND free_agent_drafts.status = 'rapid'
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_player_allocations
                  WHERE free_agent_draft_player_allocations.league_id =
                      NEW.league_id
                    AND free_agent_draft_player_allocations.fad_id =
                      NEW.fad_id
                    AND free_agent_draft_player_allocations.status NOT IN (
                      'automatic_award',
                      'restricted_resolved',
                      'fallback_open_resolved',
                      'no_valid_offer',
                      'invalid'
                    )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_rollovers
                  WHERE free_agent_draft_rollovers.league_id =
                      NEW.league_id
                    AND free_agent_draft_rollovers.fad_id =
                      NEW.fad_id
                    AND free_agent_draft_rollovers.status <>
                      'completed'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_nomination_queue
                  WHERE free_agent_draft_nomination_queue.league_id =
                      NEW.league_id
                    AND free_agent_draft_nomination_queue.fad_id =
                      NEW.fad_id
                    AND free_agent_draft_nomination_queue.status =
                      'queued'
                )
            )
          )
        )
      )
      OR (
        OLD.status IN ('pending', 'ready', 'running')
        AND NEW.status = 'correction_required'
        AND NEW.resolved_at_ms IS NULL
        AND NEW.resolved_authority IS NULL
        AND NEW.last_error_code IS NOT NULL
      )
      OR (
        OLD.status = 'correction_required'
        AND NEW.status = 'running'
        AND NEW.resolved_at_ms IS NULL
        AND NEW.resolved_authority IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery may only advance through explicit retry or resolution'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recoveries_immutable_delete
BEFORE DELETE ON free_agent_draft_recoveries
BEGIN
  SELECT RAISE(ABORT, 'FAD recovery evidence is immutable');
END;

-- Migration 0028 could only prove one unversioned schedule root. Once the
-- versioned generation table exists, finalization binds the single current
-- generation and permits its complete superseded history.
CREATE TRIGGER standings_snapshot_finalizations_schedule_lineage_insert_0030
BEFORE INSERT ON standings_snapshot_finalizations
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM season_matchup_schedule_generations
    WHERE league_id = NEW.league_id
      AND season_id = NEW.season_id
      AND status = 'current'
  ) <> 1 THEN RAISE(
    ABORT,
    'standings finalization requires one current schedule generation'
  ) END;

  WITH succeeded_roots AS (
    SELECT *
    FROM matchup_operations
    WHERE league_id = NEW.league_id
      AND season_id = NEW.season_id
      AND operation_type = 'schedule_generate'
      AND status = 'succeeded'
  ),
  generations AS (
    SELECT *
    FROM season_matchup_schedule_generations
    WHERE league_id = NEW.league_id
      AND season_id = NEW.season_id
  )
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM generations) < 1
    OR (SELECT COUNT(*) FROM generations) <>
       (SELECT COUNT(*) FROM succeeded_roots)
    OR (SELECT MIN(schedule_version) FROM generations) <> 1
    OR (SELECT MAX(schedule_version) FROM generations) <>
       (SELECT COUNT(*) FROM generations)
    OR EXISTS (
      SELECT 1
      FROM generations AS generation
      LEFT JOIN succeeded_roots AS operation
        ON operation.id = generation.schedule_operation_id
       AND operation.league_id = generation.league_id
       AND operation.season_id = generation.season_id
      WHERE operation.id IS NULL
        OR operation.matchup_week_id IS NOT NULL
        OR operation.matchup_id IS NOT NULL
        OR operation.started_at_ms IS NULL
        OR operation.completed_at_ms IS NULL
        OR operation.completed_at_ms < operation.started_at_ms
        OR operation.completed_at_ms > NEW.finalized_at_ms
        OR generation.created_at_ms <> operation.completed_at_ms
        OR (
          generation.status = 'current'
          AND (
            generation.schedule_version <>
              (SELECT MAX(schedule_version) FROM generations)
            OR generation.superseded_at_ms IS NOT NULL
            OR generation.version <> 1
            OR NOT EXISTS (
              SELECT 1
              FROM matchup_weeks AS week_one
              WHERE week_one.league_id = generation.league_id
                AND week_one.season_id = generation.season_id
                AND week_one.id =
                  generation.week_one_matchup_week_id
                AND week_one.sequence = 1
                AND week_one.starts_at_ms =
                  generation.week_one_starts_at_ms
            )
          )
        )
        OR (
          generation.status = 'superseded'
          AND (
            generation.superseded_at_ms IS NULL
            OR generation.version <> 2
            OR NOT EXISTS (
              SELECT 1
              FROM generations AS successor
              WHERE successor.schedule_version =
                  generation.schedule_version + 1
                AND successor.created_at_ms =
                  generation.superseded_at_ms
            )
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM succeeded_roots AS operation
      WHERE NOT EXISTS (
        SELECT 1
        FROM generations AS generation
        WHERE generation.schedule_operation_id = operation.id
      )
    )
  THEN RAISE(
    ABORT,
    'standings finalization schedule-generation lineage is inconsistent'
  ) END;
END;

CREATE TRIGGER standings_snapshot_finalizations_initial_schedule_root_insert_0030
BEFORE INSERT ON standings_snapshot_finalizations
BEGIN
  WITH initial_generation AS (
    SELECT *
    FROM season_matchup_schedule_generations
    WHERE league_id = NEW.league_id
      AND season_id = NEW.season_id
      AND schedule_version = 1
  ),
  initial_root AS (
    SELECT operation.*,
      CASE WHEN json_valid(operation.metadata_json) = 1
        THEN operation.metadata_json ELSE '{}' END AS evidence_json
    FROM matchup_operations AS operation
    JOIN initial_generation AS generation
      ON generation.league_id = operation.league_id
     AND generation.season_id = operation.season_id
     AND generation.schedule_operation_id = operation.id
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
    FROM initial_generation AS generation
    JOIN initial_root AS operation
      ON operation.id = generation.schedule_operation_id
    WHERE COALESCE((
      operation.actor_user_id IS NOT NULL
      AND operation.reason IS NULL
      AND json_valid(operation.metadata_json) = 1
      AND json_type(operation.evidence_json) = 'object'
      AND json_type(operation.evidence_json, '$.participantCount') =
        'integer'
      AND json_type(operation.evidence_json, '$.participantTeamIds') =
        'array'
      AND json_type(operation.evidence_json, '$.weekCount') = 'integer'
      AND json_type(operation.evidence_json, '$.matchupCount') = 'integer'
      AND (
        json_type(operation.evidence_json, '$.jobOccurrenceCount') IS NULL
        OR (
          json_type(operation.evidence_json, '$.jobOccurrenceCount') =
            'integer'
          AND json_extract(
            operation.evidence_json,
            '$.jobOccurrenceCount'
          ) >= 0
        )
      )
      AND (SELECT COUNT(*) FROM json_each(operation.evidence_json))
        IN (4, 5)
      AND (
        SELECT COUNT(DISTINCT key)
        FROM json_each(operation.evidence_json)
      ) IN (4, 5)
      AND (
        SELECT COUNT(DISTINCT key)
        FROM json_each(operation.evidence_json)
      ) = (SELECT COUNT(*) FROM json_each(operation.evidence_json))
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(operation.evidence_json)
        WHERE key NOT IN (
          'participantCount',
          'participantTeamIds',
          'weekCount',
          'matchupCount',
          'jobOccurrenceCount'
        )
      )
      AND json_extract(operation.evidence_json, '$.participantCount') =
        (SELECT COUNT(*) FROM schedule_participants)
      AND json_array_length(
        operation.evidence_json,
        '$.participantTeamIds'
      ) = (SELECT COUNT(*) FROM schedule_participants)
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          operation.evidence_json,
          '$.participantTeamIds'
        ) AS participant
        WHERE participant.type <> 'text'
          OR NOT EXISTS (
            SELECT 1
            FROM schedule_participants
            WHERE schedule_participants.team_id = participant.value
          )
          OR (
            CAST(participant.key AS INTEGER) > 0
            AND participant.value <= (
              SELECT prior.value
              FROM json_each(
                operation.evidence_json,
                '$.participantTeamIds'
              ) AS prior
              WHERE CAST(prior.key AS INTEGER) =
                CAST(participant.key AS INTEGER) - 1
            )
          )
      )
      AND json_extract(operation.evidence_json, '$.weekCount') >= 1
      AND json_extract(operation.evidence_json, '$.matchupCount') >= 1
      AND (
        generation.status <> 'current'
        OR (
          json_extract(operation.evidence_json, '$.weekCount') =
            NEW.expected_week_count
          AND json_extract(operation.evidence_json, '$.matchupCount') =
            NEW.expected_matchup_count
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_schedule_recoveries AS recovery
        WHERE recovery.league_id = NEW.league_id
          AND recovery.season_id = NEW.season_id
          AND recovery.new_schedule_operation_id = operation.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_schedule_command_results AS command_result
        WHERE command_result.league_id = NEW.league_id
          AND command_result.season_id = NEW.season_id
          AND command_result.new_schedule_operation_id = operation.id
          AND NOT (
            command_result.action = 'generate'
            AND command_result.matchup_operation_id = operation.id
            AND command_result.actor_user_id = operation.actor_user_id
            AND command_result.old_schedule_operation_id IS NULL
            AND command_result.old_schedule_version IS NULL
            AND command_result.new_schedule_version = 1
            AND command_result.week_one_matchup_week_id =
              generation.week_one_matchup_week_id
            AND command_result.previous_first_week_starts_at_ms IS NULL
            AND command_result.first_week_starts_at_ms =
              generation.week_one_starts_at_ms
            AND command_result.shifted_week_count IS NULL
            AND command_result.replaced_job_occurrence_count IS NULL
            AND command_result.created_at_ms = operation.completed_at_ms
            AND command_result.version = 1
          )
      )
    ), 0) = 1
  ) THEN RAISE(
    ABORT,
    'standings finalization initial schedule provenance is inconsistent'
  ) END;
END;

CREATE TRIGGER standings_snapshot_finalizations_replacement_schedule_root_insert_0030
BEFORE INSERT ON standings_snapshot_finalizations
BEGIN
  WITH schedule_participants AS (
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
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM season_matchup_schedule_generations AS generation
    JOIN season_matchup_schedule_generations AS previous_generation
      ON previous_generation.league_id = generation.league_id
     AND previous_generation.season_id = generation.season_id
     AND previous_generation.schedule_version =
       generation.schedule_version - 1
    JOIN matchup_operations AS operation
      ON operation.league_id = generation.league_id
     AND operation.season_id = generation.season_id
     AND operation.id = generation.schedule_operation_id
    WHERE generation.league_id = NEW.league_id
      AND generation.season_id = NEW.season_id
      AND generation.schedule_version > 1
      AND NOT (
        COALESCE((
          operation.actor_user_id IS NOT NULL
          AND operation.reason IS NULL
          AND json_valid(operation.metadata_json) = 1
          AND json_type(operation.metadata_json) = 'object'
          AND (SELECT COUNT(*) FROM json_each(operation.metadata_json)) = 10
          AND (
            SELECT COUNT(DISTINCT key)
            FROM json_each(operation.metadata_json)
          ) = 10
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(operation.metadata_json)
            WHERE key NOT IN (
              'action',
              'oldScheduleOperationId',
              'oldScheduleVersion',
              'newScheduleVersion',
              'previousFirstWeekStartsAtMs',
              'firstWeekStartsAtMs',
              'shiftedWeekCount',
              'replacedJobOccurrenceCount',
              'participantTeamIds',
              'responseSha256'
            )
          )
          AND json_extract(operation.metadata_json, '$.action') =
            'shift_week_one'
          AND json_extract(
            operation.metadata_json,
            '$.oldScheduleOperationId'
          ) = previous_generation.schedule_operation_id
          AND json_extract(operation.metadata_json, '$.oldScheduleVersion') =
            previous_generation.schedule_version
          AND json_extract(operation.metadata_json, '$.newScheduleVersion') =
            generation.schedule_version
          AND json_extract(
            operation.metadata_json,
            '$.previousFirstWeekStartsAtMs'
          ) = previous_generation.week_one_starts_at_ms
          AND json_extract(
            operation.metadata_json,
            '$.firstWeekStartsAtMs'
          ) = generation.week_one_starts_at_ms
          AND json_type(
            operation.metadata_json,
            '$.shiftedWeekCount'
          ) = 'integer'
          AND json_extract(
            operation.metadata_json,
            '$.shiftedWeekCount'
          ) >= 1
          AND json_type(
            operation.metadata_json,
            '$.replacedJobOccurrenceCount'
          ) = 'integer'
          AND json_extract(
            operation.metadata_json,
            '$.replacedJobOccurrenceCount'
          ) >= 0
          AND json_type(
            operation.metadata_json,
            '$.participantTeamIds'
          ) = 'array'
          AND json_array_length(
            operation.metadata_json,
            '$.participantTeamIds'
          ) = (SELECT COUNT(*) FROM schedule_participants)
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(
              operation.metadata_json,
              '$.participantTeamIds'
            ) AS participant
            WHERE participant.type <> 'text'
              OR NOT EXISTS (
                SELECT 1
                FROM schedule_participants
                WHERE schedule_participants.team_id = participant.value
              )
              OR (
                CAST(participant.key AS INTEGER) > 0
                AND participant.value <= (
                  SELECT prior.value
                  FROM json_each(
                    operation.metadata_json,
                    '$.participantTeamIds'
                  ) AS prior
                  WHERE CAST(prior.key AS INTEGER) =
                    CAST(participant.key AS INTEGER) - 1
                )
              )
          )
          AND json_type(operation.metadata_json, '$.responseSha256') = 'text'
          AND length(json_extract(
            operation.metadata_json,
            '$.responseSha256'
          )) = 64
          AND json_extract(operation.metadata_json, '$.responseSha256') =
            lower(json_extract(operation.metadata_json, '$.responseSha256'))
          AND json_extract(operation.metadata_json, '$.responseSha256')
            NOT GLOB '*[^0-9a-f]*'
          AND (
            SELECT COUNT(*)
            FROM matchup_schedule_command_results AS command_result
            WHERE command_result.league_id = generation.league_id
              AND command_result.season_id = generation.season_id
              AND command_result.new_schedule_operation_id = operation.id
              AND command_result.action = 'shift_week_one'
              AND command_result.matchup_operation_id = operation.id
              AND command_result.actor_user_id = operation.actor_user_id
              AND command_result.old_schedule_operation_id =
                previous_generation.schedule_operation_id
              AND command_result.old_schedule_version =
                previous_generation.schedule_version
              AND command_result.new_schedule_version =
                generation.schedule_version
              AND command_result.week_one_matchup_week_id =
                generation.week_one_matchup_week_id
              AND command_result.previous_first_week_starts_at_ms =
                previous_generation.week_one_starts_at_ms
              AND command_result.first_week_starts_at_ms =
                generation.week_one_starts_at_ms
              AND command_result.shifted_week_count = json_extract(
                operation.metadata_json,
                '$.shiftedWeekCount'
              )
              AND command_result.replaced_job_occurrence_count = json_extract(
                operation.metadata_json,
                '$.replacedJobOccurrenceCount'
              )
              AND command_result.created_at_ms = operation.completed_at_ms
              AND command_result.version = 1
          ) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM free_agent_draft_schedule_recoveries AS recovery
            WHERE recovery.league_id = generation.league_id
              AND recovery.season_id = generation.season_id
              AND recovery.new_schedule_operation_id = operation.id
          )
        ), 0) = 1
        OR
        COALESCE((
          operation.actor_user_id IS NULL
          AND operation.reason IN (
            'fad_pre_open_schedule_recovery',
            'fad_completion_schedule_recovery'
          )
          AND json_valid(operation.metadata_json) = 1
          AND json_type(operation.metadata_json) = 'object'
          AND (SELECT COUNT(*) FROM json_each(operation.metadata_json)) = 6
          AND (
            SELECT COUNT(DISTINCT key)
            FROM json_each(operation.metadata_json)
          ) = 6
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(operation.metadata_json)
            WHERE key NOT IN (
              'fadId',
              'recoveryId',
              'recoveryKind',
              'oldScheduleOperationId',
              'oldScheduleVersion',
              'newScheduleVersion'
            )
          )
          AND (
            SELECT COUNT(*)
            FROM free_agent_draft_schedule_recoveries AS recovery
            WHERE recovery.league_id = generation.league_id
              AND recovery.season_id = generation.season_id
              AND recovery.new_schedule_operation_id = operation.id
              AND recovery.matchup_operation_id = operation.id
              AND recovery.old_schedule_operation_id =
                previous_generation.schedule_operation_id
              AND recovery.old_schedule_version =
                previous_generation.schedule_version
              AND recovery.new_schedule_version =
                generation.schedule_version
              AND recovery.old_first_matchup_week_id =
                previous_generation.week_one_matchup_week_id
              AND recovery.new_first_matchup_week_id =
                generation.week_one_matchup_week_id
              AND recovery.old_week_one_starts_at_ms =
                previous_generation.week_one_starts_at_ms
              AND recovery.new_week_one_starts_at_ms =
                generation.week_one_starts_at_ms
              AND recovery.completed_at_ms = operation.completed_at_ms
              AND recovery.created_at_ms = operation.completed_at_ms
              AND recovery.version = 1
              AND recovery.evidence_schema_version = 1
              AND operation.reason =
                'fad_' || recovery.recovery_kind || '_schedule_recovery'
              AND json_extract(operation.metadata_json, '$.fadId') =
                recovery.fad_id
              AND json_extract(operation.metadata_json, '$.recoveryId') =
                recovery.id
              AND json_extract(operation.metadata_json, '$.recoveryKind') =
                recovery.recovery_kind
              AND json_extract(
                operation.metadata_json,
                '$.oldScheduleOperationId'
              ) = recovery.old_schedule_operation_id
              AND json_extract(
                operation.metadata_json,
                '$.oldScheduleVersion'
              ) = recovery.old_schedule_version
              AND json_extract(
                operation.metadata_json,
                '$.newScheduleVersion'
              ) = recovery.new_schedule_version
          ) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM matchup_schedule_command_results AS command_result
            WHERE command_result.league_id = generation.league_id
              AND command_result.season_id = generation.season_id
              AND command_result.new_schedule_operation_id = operation.id
          )
        ), 0) = 1
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization replacement schedule provenance is inconsistent'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '30',
    updated_at_ms = CASE
      WHEN updated_at_ms < 30 THEN 30
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version';
