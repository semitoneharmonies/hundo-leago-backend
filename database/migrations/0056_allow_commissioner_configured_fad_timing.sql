-- hundo-leago: foreign-key-rebuild

-- Commissioner-selected Candidate Card deadline and initial rollover instants.

-- Existing clocks, jobs, receipts and league rows are copied unchanged; NULL preserves legacy seven-day clocks.

DROP TRIGGER auction_bids_require_context_insert;

DROP TRIGGER auction_contexts_restricted_fallback_full_window_insert;

DROP TRIGGER auction_contexts_valid_insert;

DROP TRIGGER auctions_restricted_fallback_overlap_insert;

DROP TRIGGER candidate_card_entries_open_delete;

DROP TRIGGER candidate_card_entries_open_insert;

DROP TRIGGER candidate_card_entries_open_update;

DROP TRIGGER candidate_card_help_command_results_valid_insert;

DROP TRIGGER candidate_card_help_requests_manager_insert;

DROP TRIGGER candidate_card_revisions_authority_insert;

DROP TRIGGER candidate_card_snapshots_locked_insert;

DROP TRIGGER candidate_cards_open_update;

DROP TRIGGER candidate_cards_setup_insert;

DROP TRIGGER free_agent_draft_allocations_forward_update;

DROP TRIGGER free_agent_draft_allocations_pending_insert;

DROP TRIGGER free_agent_draft_eligibility_revalidation_valid_insert;

DROP TRIGGER free_agent_draft_nomination_queue_forward_update;

DROP TRIGGER free_agent_draft_nomination_queue_valid_insert;

DROP TRIGGER free_agent_draft_readiness_attempts_valid_insert;

DROP TRIGGER free_agent_draft_readiness_operations_forward_update;

DROP TRIGGER free_agent_draft_recoveries_forward_update;

DROP TRIGGER free_agent_draft_recoveries_valid_insert;

DROP TRIGGER free_agent_draft_rollovers_forward_update;

DROP TRIGGER free_agent_draft_rollovers_immutable_delete;

DROP TRIGGER free_agent_draft_rollovers_valid_insert;

DROP TRIGGER free_agent_draft_schedule_recoveries_valid_insert;

DROP TRIGGER free_agent_draft_setup_exemptions_consumed_fad_reference;

DROP TRIGGER free_agent_draft_teams_participant_insert;

DROP TRIGGER free_agent_drafts_allocation_completion_barrier;

DROP TRIGGER free_agent_drafts_allocation_start_barrier;

DROP TRIGGER free_agent_drafts_auction_completion_barrier;

DROP TRIGGER free_agent_drafts_automatic_award_resources_barrier;

DROP TRIGGER free_agent_drafts_consume_setup_exemption;

DROP TRIGGER free_agent_drafts_deadline_allocation_barrier;

DROP TRIGGER free_agent_drafts_deadline_completeness_update;

DROP TRIGGER free_agent_drafts_fad_eligibility_revalidation_barrier;

DROP TRIGGER free_agent_drafts_final_completion_barrier;

DROP TRIGGER free_agent_drafts_forward_update;

DROP TRIGGER free_agent_drafts_immutable_delete;

DROP TRIGGER free_agent_drafts_resolution_job_completion_barrier;

DROP TRIGGER free_agent_drafts_sync_season_completion;

DROP TRIGGER free_agent_drafts_valid_insert;

DROP TRIGGER idempotency_requests_fad_open_rapid_start_complete;

DROP TRIGGER season_rollovers_valid_insert;

DROP TRIGGER seasons_fad_completion_marker_guard;

CREATE TABLE free_agent_drafts_timing_v56 (
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
  initial_rollover_times_json TEXT
    CHECK (initial_rollover_times_json IS NULL OR (json_valid(initial_rollover_times_json) AND json_type(initial_rollover_times_json) = 'array' AND json_array_length(initial_rollover_times_json) BETWEEN 1 AND 1000)),
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
    ((initial_rollover_times_json IS NULL AND candidate_deadline_at_ms = first_matchup_starts_at_ms - 604800000)
      OR (initial_rollover_times_json IS NOT NULL AND candidate_deadline_at_ms < first_matchup_starts_at_ms))
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

INSERT INTO free_agent_drafts_timing_v56 (id, league_id, season_id, readiness_operation_id, readiness_occurrence_key, first_matchup_week_id, current_competition_first_matchup_week_id, schedule_recovery_id, participating_team_count, status, setup_path, entry_draft_id, setup_exemption_id, prior_season_rollover_id, no_draft_reason, opening_authority, opened_at_ms, help_opens_at_ms, candidate_deadline_at_ms, first_matchup_starts_at_ms, deadline_locked_at_ms, allocation_completed_at_ms, completed_at_ms, created_at_ms, updated_at_ms, version) SELECT id, league_id, season_id, readiness_operation_id, readiness_occurrence_key, first_matchup_week_id, current_competition_first_matchup_week_id, schedule_recovery_id, participating_team_count, status, setup_path, entry_draft_id, setup_exemption_id, prior_season_rollover_id, no_draft_reason, opening_authority, opened_at_ms, help_opens_at_ms, candidate_deadline_at_ms, first_matchup_starts_at_ms, deadline_locked_at_ms, allocation_completed_at_ms, completed_at_ms, created_at_ms, updated_at_ms, version FROM free_agent_drafts;

DROP TABLE free_agent_drafts;

ALTER TABLE free_agent_drafts_timing_v56 RENAME TO free_agent_drafts;

CREATE INDEX free_agent_drafts_league_status_deadline
  ON free_agent_drafts (
    league_id,
    status,
    candidate_deadline_at_ms
  );

CREATE TABLE free_agent_draft_rollovers_timing_v56 (
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
    creation_cutoff_at_ms = max(opens_at_ms, rolls_over_at_ms - 3600000)
    AND opens_at_ms < rolls_over_at_ms
    AND (window_kind = 'initial' OR opens_at_ms = rolls_over_at_ms - 86400000)
  ),
  CHECK (
    (
      window_kind = 'initial'
      AND sequence >= 1
      AND extension_reason IS NULL
      AND extension_source_id IS NULL
    )
    OR (
      window_kind = 'extension'
      AND sequence >= 2
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

INSERT INTO free_agent_draft_rollovers_timing_v56 (id, league_id, season_id, fad_id, sequence, window_kind, predecessor_rollover_id, extension_reason, extension_source_id, opens_at_ms, creation_cutoff_at_ms, rolls_over_at_ms, status, processing_job_run_id, processing_started_at_ms, completed_at_ms, last_error_code, created_at_ms, updated_at_ms, version) SELECT id, league_id, season_id, fad_id, sequence, window_kind, predecessor_rollover_id, extension_reason, extension_source_id, opens_at_ms, creation_cutoff_at_ms, rolls_over_at_ms, status, processing_job_run_id, processing_started_at_ms, completed_at_ms, last_error_code, created_at_ms, updated_at_ms, version FROM free_agent_draft_rollovers;

DROP TABLE free_agent_draft_rollovers;

ALTER TABLE free_agent_draft_rollovers_timing_v56 RENAME TO free_agent_draft_rollovers;

CREATE INDEX free_agent_draft_rollovers_league_fad_status_time
  ON free_agent_draft_rollovers (
    league_id,
    fad_id,
    status,
    rolls_over_at_ms
  );

ALTER TABLE season_matchup_schedule_generations ADD COLUMN fad_timing_json TEXT CHECK (fad_timing_json IS NULL OR (json_valid(fad_timing_json) AND json_type(fad_timing_json) = 'object'));

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
        (
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
              AND (
                idempotency_requests.operation = 'auction.bid.put'
                OR (
                  idempotency_requests.operation = 'auction.start'
                  AND auction_contexts.source_kind = 'fad_open_rapid'
                  AND auction_contexts.fad_origin =
                    'manager_nomination'
                  AND auction_contexts.fad_allocation_id IS NULL
                  AND auction_contexts.created_at_ms =
                    auctions.opened_at_ms
                  AND auctions.opened_by_user_id =
                    NEW.submitted_by_user_id
                  AND auctions.created_at_ms =
                    auctions.opened_at_ms
                  AND auctions.updated_at_ms =
                    auctions.opened_at_ms
                  AND auctions.version = 1
                  AND NEW.first_submitted_at_ms =
                    auctions.opened_at_ms
                  AND NOT EXISTS (
                    SELECT 1
                    FROM auction_bids AS existing_bid
                    WHERE existing_bid.league_id =
                        NEW.league_id
                      AND existing_bid.auction_id =
                        NEW.auction_id
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_rollovers AS rollover
                    JOIN free_agent_drafts AS fad
                      ON fad.league_id = rollover.league_id
                     AND fad.season_id = rollover.season_id
                     AND fad.id = rollover.fad_id
                    WHERE rollover.league_id =
                        auction_contexts.league_id
                      AND rollover.season_id =
                        auction_contexts.season_id
                      AND rollover.fad_id =
                        auction_contexts.fad_id
                      AND rollover.id =
                        auction_contexts.fad_rollover_id
                      AND rollover.status IN (
                        'scheduled',
                        'processing'
                      )
                      AND fad.status IN ('allocating', 'rapid')
                      AND fad.candidate_deadline_at_ms <=
                        auctions.opened_at_ms
                      AND fad.deadline_locked_at_ms <=
                        auctions.opened_at_ms
                      AND auctions.resolves_at_ms =
                        rollover.rolls_over_at_ms
                      AND auctions.opened_at_ms >=
                        rollover.opens_at_ms
                      AND auctions.opened_at_ms <
                        rollover.creation_cutoff_at_ms
                  )
                  AND (
                    EXISTS (
                      SELECT 1
                      FROM team_manager_assignments AS assignment
                      JOIN league_memberships AS membership
                        ON membership.league_id =
                            assignment.league_id
                       AND membership.id =
                            assignment.membership_id
                       AND membership.user_id =
                            assignment.user_id
                      WHERE assignment.league_id =
                          NEW.league_id
                        AND assignment.team_id =
                          NEW.team_id
                        AND assignment.user_id =
                          NEW.submitted_by_user_id
                        AND assignment.status = 'accepted'
                        AND assignment.ended_at_ms IS NULL
                        AND membership.status = 'active'
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM league_memberships AS membership
                      JOIN leagues
                        ON leagues.id = membership.league_id
                       AND leagues.commissioner_membership_id =
                            membership.id
                      WHERE membership.league_id =
                          NEW.league_id
                        AND membership.user_id =
                          NEW.submitted_by_user_id
                        AND membership.status = 'active'
                    )
                  )
                )
              )
              AND idempotency_requests.status = 'started'
              AND idempotency_requests.result_type IS NULL
              AND idempotency_requests.result_id IS NULL
              AND idempotency_requests.created_at_ms =
                NEW.first_submitted_at_ms
              AND (
                idempotency_requests.operation <> 'auction.start'
                OR (
                  idempotency_requests.completed_at_ms IS NULL
                  AND idempotency_requests.expires_at_ms >
                    NEW.first_submitted_at_ms
                )
              )
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
        OR (
          auction_contexts.source_kind = 'fad_open_rapid'
          AND auction_contexts.fad_origin = 'queued_nomination'
          AND auction_contexts.fad_allocation_id IS NULL
          AND auctions.status = 'open'
          AND auctions.player_id IS NOT NULL
          AND auctions.opened_by_user_id = NEW.submitted_by_user_id
          AND auctions.created_at_ms = auctions.opened_at_ms
          AND auctions.updated_at_ms = auctions.opened_at_ms
          AND auctions.version = 1
          AND NEW.status = 'active'
          AND NEW.version = 1
          AND NEW.edit_count = 0
          AND NEW.first_submitted_at_ms = NEW.last_edited_at_ms
          AND NEW.first_submitted_at_ms < auctions.opened_at_ms
          AND NEW.first_submitted_at_ms < auctions.resolves_at_ms
          AND NEW.idempotency_request_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_nomination_queue AS queue
            JOIN idempotency_requests AS request
              ON request.league_id = queue.league_id
             AND request.id =
                  queue.acceptance_idempotency_request_id
            JOIN free_agent_draft_rollovers AS opening_rollover
              ON opening_rollover.league_id = queue.league_id
             AND opening_rollover.season_id = queue.season_id
             AND opening_rollover.fad_id = queue.fad_id
             AND opening_rollover.id =
                  queue.target_opening_rollover_id
            JOIN free_agent_draft_rollovers AS resolution_rollover
              ON resolution_rollover.league_id = queue.league_id
             AND resolution_rollover.season_id = queue.season_id
             AND resolution_rollover.fad_id = queue.fad_id
             AND resolution_rollover.id =
                  auction_contexts.fad_rollover_id
            JOIN free_agent_draft_draws AS draw
              ON draw.league_id = queue.league_id
             AND draw.season_id = queue.season_id
             AND draw.fad_id = queue.fad_id
             AND draw.auction_id = auctions.id
            JOIN job_runs AS activation_job
              ON activation_job.league_id = queue.league_id
             AND activation_job.season_id = queue.season_id
            WHERE queue.league_id = NEW.league_id
              AND queue.season_id = NEW.season_id
              AND queue.fad_id = auction_contexts.fad_id
              AND queue.team_id = NEW.team_id
              AND queue.player_id = auctions.player_id
              AND queue.submitted_by_user_id =
                NEW.submitted_by_user_id
              AND queue.status = 'queued'
              AND queue.resolution_rollover_id IS NULL
              AND queue.opened_auction_id IS NULL
              AND queue.opened_starter_bid_id IS NULL
              AND queue.opened_at_ms IS NULL
              AND queue.terminal_at_ms IS NULL
              AND queue.validation_code IS NULL
              AND queue.acceptance_idempotency_request_id =
                NEW.idempotency_request_id
              AND queue.opening_total_value_cents =
                NEW.total_value_cents
              AND queue.opening_term_years = NEW.term_years
              AND queue.opening_aav_cents =
                NEW.lowest_offered_aav_cents
              AND queue.accepted_at_ms =
                NEW.first_submitted_at_ms
              AND queue.binding_confirmed_at_ms =
                queue.accepted_at_ms
              AND request.actor_user_id =
                queue.submitted_by_user_id
              AND request.operation = 'auction.start'
              AND request.status = 'completed'
              AND request.result_type = 'fad_nomination_queue'
              AND request.result_id = queue.id
              AND request.created_at_ms = queue.accepted_at_ms
              AND request.completed_at_ms = queue.accepted_at_ms
              AND request.expires_at_ms > queue.accepted_at_ms
              AND opening_rollover.id = queue.source_rollover_id
              AND opening_rollover.status IN (
                'scheduled',
                'processing',
                'recovery_required'
              )
              AND (
                opening_rollover.status <> 'recovery_required'
                OR EXISTS (
                  SELECT 1
                  FROM free_agent_draft_recoveries AS recovery
                  WHERE recovery.league_id = queue.league_id
                    AND recovery.season_id = queue.season_id
                    AND recovery.fad_id = queue.fad_id
                    AND recovery.nomination_queue_id = queue.id
                    AND recovery.player_id = queue.player_id
                    AND recovery.allocation_id IS NULL
                    AND recovery.rollover_id = opening_rollover.id
                    AND recovery.auction_id IS NULL
                    AND recovery.job_run_id = activation_job.id
                    AND recovery.kind =
                      'queued_nomination_activation'
                    AND recovery.status = 'running'
                    AND recovery.last_error_code IS NOT NULL
                    AND recovery.created_by_operation_id =
                      activation_job.id
                    AND recovery.resolved_at_ms IS NULL
                    AND recovery.updated_at_ms <=
                      activation_job.started_at_ms
                )
              )
              AND opening_rollover.rolls_over_at_ms =
                auctions.opened_at_ms
              AND queue.accepted_at_ms >=
                opening_rollover.creation_cutoff_at_ms
              AND queue.accepted_at_ms <
                opening_rollover.rolls_over_at_ms
              AND resolution_rollover.sequence =
                opening_rollover.sequence + 1
              AND resolution_rollover.predecessor_rollover_id =
                opening_rollover.id
              AND resolution_rollover.opens_at_ms =
                opening_rollover.rolls_over_at_ms
              AND resolution_rollover.rolls_over_at_ms >
                opening_rollover.rolls_over_at_ms
              AND resolution_rollover.status = 'scheduled'
              AND auctions.resolves_at_ms =
                resolution_rollover.rolls_over_at_ms
              AND auction_contexts.created_at_ms =
                auctions.opened_at_ms
              AND draw.allocation_id IS NULL
              AND draw.algorithm_version = 1
              AND draw.ordered_tied_bid_ids_json IS NULL
              AND draw.ordered_tied_team_ids_json IS NULL
              AND draw.rejection_counter IS NULL
              AND draw.selected_index IS NULL
              AND draw.selected_bid_id IS NULL
              AND draw.selected_team_id IS NULL
              AND draw.selected_digest_hex IS NULL
              AND draw.revealed_at_ms IS NULL
              AND draw.created_at_ms = auctions.opened_at_ms
              AND draw.updated_at_ms = auctions.opened_at_ms
              AND draw.version = 1
              AND activation_job.job_type =
                'fad_queued_nomination_activation'
              AND activation_job.occurrence_key =
                'fad:' || queue.fad_id || ':nomination-open:' ||
                  queue.id || ':' || opening_rollover.rolls_over_at_ms
              AND activation_job.scheduled_for_ms =
                opening_rollover.rolls_over_at_ms
              AND activation_job.status = 'running'
              AND activation_job.attempt_count >= 1
              AND activation_job.lease_owner IS NOT NULL
              AND activation_job.lease_token IS NOT NULL
              AND activation_job.started_at_ms >=
                auctions.opened_at_ms
              AND activation_job.lease_expires_at_ms >
                activation_job.started_at_ms
              AND activation_job.completed_at_ms IS NULL
              AND activation_job.result_json IS NULL
              AND activation_job.last_error_code IS NULL
              AND activation_job.next_attempt_at_ms IS NULL
              AND activation_job.updated_at_ms =
                activation_job.started_at_ms
              AND activation_job.created_at_ms <=
                auctions.opened_at_ms
          )
          AND EXISTS (
            SELECT 1
            FROM free_agent_drafts
            WHERE free_agent_drafts.league_id = NEW.league_id
              AND free_agent_drafts.season_id = NEW.season_id
              AND free_agent_drafts.id = auction_contexts.fad_id
              AND free_agent_drafts.status IN (
                'allocating',
                'rapid'
              )
              AND free_agent_drafts.candidate_deadline_at_ms <=
                NEW.first_submitted_at_ms
              AND free_agent_drafts.deadline_locked_at_ms <=
                NEW.first_submitted_at_ms
          )
          AND EXISTS (
            SELECT 1
            FROM teams
            WHERE teams.league_id = NEW.league_id
              AND teams.id = NEW.team_id
              AND teams.status = 'active'
          )
          AND EXISTS (
            SELECT 1
            FROM players
            WHERE players.id = auctions.player_id
              AND players.status = 'active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM player_ownerships
            WHERE player_ownerships.league_id = NEW.league_id
              AND player_ownerships.season_id = NEW.season_id
              AND player_ownerships.player_id = auctions.player_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM auctions AS other_auction
            WHERE other_auction.league_id = NEW.league_id
              AND other_auction.season_id = NEW.season_id
              AND other_auction.player_id = auctions.player_id
              AND other_auction.id <> auctions.id
              AND other_auction.status IN ('open', 'resolving')
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD opening bid requires a current actor or exact queued acceptance'
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

CREATE TRIGGER auction_contexts_restricted_fallback_full_window_insert
BEFORE INSERT ON auction_contexts
WHEN NEW.source_kind = 'fad_open_rapid'
  AND NEW.fad_origin = 'restricted_no_improvement_fallback'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auctions AS fallback_auction
    JOIN free_agent_draft_rollovers AS target_rollover
      ON target_rollover.league_id = fallback_auction.league_id
     AND target_rollover.season_id = fallback_auction.season_id
     AND target_rollover.fad_id = NEW.fad_id
     AND target_rollover.id = NEW.fad_rollover_id
    JOIN free_agent_draft_player_allocations AS allocation
      ON allocation.league_id = fallback_auction.league_id
     AND allocation.season_id = fallback_auction.season_id
     AND allocation.fad_id = NEW.fad_id
     AND allocation.id = NEW.fad_allocation_id
     AND allocation.player_id = fallback_auction.player_id
    JOIN auctions AS restricted_auction
      ON restricted_auction.league_id = allocation.league_id
     AND restricted_auction.season_id = allocation.season_id
     AND restricted_auction.id = allocation.restricted_auction_id
     AND restricted_auction.player_id = allocation.player_id
    WHERE fallback_auction.league_id = NEW.league_id
      AND fallback_auction.season_id = NEW.season_id
      AND fallback_auction.id = NEW.auction_id
      AND fallback_auction.status = 'open'
      AND fallback_auction.opened_by_user_id IS NULL
      AND fallback_auction.opened_at_ms = target_rollover.opens_at_ms
      AND fallback_auction.resolves_at_ms = target_rollover.rolls_over_at_ms
      AND fallback_auction.resolves_at_ms -
            fallback_auction.opened_at_ms > 0
      AND allocation.status = 'restricted_fallback_open'
      AND allocation.decision_code = 'restricted_no_improvement_fallback'
      AND allocation.fallback_open_auction_id = fallback_auction.id
      AND restricted_auction.status = 'resolving'
  ) THEN RAISE(
    ABORT,
    'restricted fallback context requires its exact complete handoff window'
  ) END;
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

CREATE TRIGGER auctions_restricted_fallback_overlap_insert
BEFORE INSERT ON auctions
WHEN NEW.status IN ('open', 'resolving')
  AND EXISTS (
    SELECT 1
    FROM auctions AS active_auction
    WHERE active_auction.league_id = NEW.league_id
      AND active_auction.player_id = NEW.player_id
      AND active_auction.status IN ('open', 'resolving')
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'open'
    AND NEW.opened_by_user_id IS NULL
    AND NEW.created_at_ms = NEW.updated_at_ms
    AND NEW.version = 1
    AND NEW.opened_at_ms >= NEW.created_at_ms
    AND NEW.resolves_at_ms > NEW.opened_at_ms
    AND (
      SELECT COUNT(*)
      FROM auctions AS active_auction
      WHERE active_auction.league_id = NEW.league_id
        AND active_auction.player_id = NEW.player_id
        AND active_auction.status IN ('open', 'resolving')
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM auctions AS restricted_auction
      JOIN auction_contexts AS restricted_context
        ON restricted_context.league_id = restricted_auction.league_id
       AND restricted_context.season_id = restricted_auction.season_id
       AND restricted_context.auction_id = restricted_auction.id
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = restricted_context.league_id
       AND allocation.season_id = restricted_context.season_id
       AND allocation.fad_id = restricted_context.fad_id
       AND allocation.id = restricted_context.fad_allocation_id
       AND allocation.player_id = restricted_auction.player_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = allocation.fad_id
      JOIN free_agent_draft_rollovers AS source_rollover
        ON source_rollover.league_id = restricted_context.league_id
       AND source_rollover.season_id = restricted_context.season_id
       AND source_rollover.fad_id = restricted_context.fad_id
       AND source_rollover.id = restricted_context.fad_rollover_id
      JOIN free_agent_draft_draws AS restricted_draw
        ON restricted_draw.league_id = restricted_context.league_id
       AND restricted_draw.season_id = restricted_context.season_id
       AND restricted_draw.fad_id = restricted_context.fad_id
       AND restricted_draw.allocation_id = restricted_context.fad_allocation_id
       AND restricted_draw.auction_id = restricted_context.auction_id
      JOIN job_runs AS resolution_job
        ON resolution_job.league_id = restricted_auction.league_id
       AND resolution_job.season_id = restricted_auction.season_id
       AND resolution_job.job_type = 'auction.resolve.target'
       AND resolution_job.occurrence_key =
            'auction:' || restricted_auction.id || ':' ||
              restricted_auction.resolves_at_ms
       AND resolution_job.scheduled_for_ms = restricted_auction.resolves_at_ms
      WHERE restricted_auction.league_id = NEW.league_id
        AND restricted_auction.season_id = NEW.season_id
        AND restricted_auction.player_id = NEW.player_id
        AND restricted_auction.status = 'resolving'
        AND restricted_auction.resolves_at_ms <= NEW.created_at_ms
        AND restricted_context.source_kind = 'fad_restricted'
        AND restricted_context.fad_origin = 'candidate_tie_restricted'
        AND allocation.status = 'restricted_active'
        AND allocation.decision_code = 'exact_total_and_term_tie'
        AND allocation.winning_snapshot_entry_id IS NULL
        AND allocation.winning_team_id IS NULL
        AND allocation.contract_id IS NULL
        AND allocation.ownership_id IS NULL
        AND allocation.restricted_auction_id = restricted_auction.id
        AND allocation.fallback_open_auction_id IS NULL
        AND allocation.restricted_minimum_total_cents IS NOT NULL
        AND allocation.restricted_minimum_term_years IS NOT NULL
        AND allocation.restricted_minimum_aav_cents IS NOT NULL
        AND allocation.accounted_at_ms IS NULL
        AND allocation.last_error_code IS NULL
        AND source_rollover.rolls_over_at_ms =
            restricted_auction.resolves_at_ms
        AND restricted_auction.opened_at_ms >= source_rollover.opens_at_ms
        AND restricted_auction.opened_at_ms < source_rollover.rolls_over_at_ms
        AND restricted_draw.revealed_at_ms IS NULL
        AND restricted_draw.version = 1
        AND NOT EXISTS (
          SELECT 1
          FROM auction_resolutions
          WHERE auction_resolutions.league_id = restricted_auction.league_id
            AND auction_resolutions.auction_id = restricted_auction.id
        )
        AND resolution_job.status IN ('leased', 'running')
        AND resolution_job.attempt_count >= 1
        AND resolution_job.lease_owner IS NOT NULL
        AND resolution_job.lease_token IS NOT NULL
        AND resolution_job.lease_expires_at_ms > NEW.created_at_ms
        AND resolution_job.completed_at_ms IS NULL
        AND resolution_job.result_json IS NULL
        AND resolution_job.last_error_code IS NULL
        AND resolution_job.next_attempt_at_ms IS NULL
        AND resolution_job.updated_at_ms <= NEW.created_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = restricted_auction.league_id
            AND auction_bids.auction_id = restricted_auction.id
            AND auction_bids.status = 'active'
        )
        AND NEW.opened_at_ms >= NEW.created_at_ms
        AND NEW.opened_at_ms >= restricted_auction.resolves_at_ms
        AND NEW.opened_at_ms >= fad.candidate_deadline_at_ms
        AND (EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS target
          WHERE target.league_id = fad.league_id AND target.season_id = fad.season_id AND target.fad_id = fad.id
            AND target.opens_at_ms = NEW.opened_at_ms AND target.rolls_over_at_ms = NEW.resolves_at_ms
            AND target.status IN ('scheduled', 'processing'))
          OR (
            NEW.resolves_at_ms = NEW.opened_at_ms + 86400000
            AND NOT EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS existing_target
              WHERE existing_target.league_id = fad.league_id AND existing_target.season_id = fad.season_id
                AND existing_target.fad_id = fad.id AND existing_target.opens_at_ms = NEW.opened_at_ms)
            AND EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS predecessor
              WHERE predecessor.league_id = fad.league_id AND predecessor.season_id = fad.season_id
                AND predecessor.fad_id = fad.id AND predecessor.rolls_over_at_ms = NEW.opened_at_ms
                AND predecessor.sequence >= COALESCE(json_array_length(fad.initial_rollover_times_json), 7)
                AND predecessor.status IN ('processing', 'completed', 'recovery_required')
                AND NOT EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS later
                  WHERE later.league_id = fad.league_id AND later.season_id = fad.season_id
                    AND later.fad_id = fad.id AND later.sequence > predecessor.sequence))
          ))
    )
  ) THEN RAISE(
    ABORT,
    'active auction overlap requires one exact restricted fallback handoff'
  ) END;
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

CREATE TRIGGER candidate_card_help_command_results_valid_insert
BEFORE INSERT ON candidate_card_help_command_results
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests AS request
      WHERE request.league_id = NEW.league_id
        AND request.id = NEW.idempotency_request_id
        AND request.actor_user_id = NEW.actor_user_id
        AND request.operation = 'candidate_card.help'
        AND request.request_hash = NEW.request_sha256
        AND request.status = 'started'
        AND request.result_type IS NULL
        AND request.result_id IS NULL
        AND request.completed_at_ms IS NULL
        AND request.created_at_ms = NEW.created_at_ms
        AND request.expires_at_ms > NEW.created_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM team_manager_assignments AS assignment
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
      JOIN users AS actor
        ON actor.id = assignment.user_id
      WHERE assignment.league_id = NEW.league_id
        AND assignment.team_id = NEW.team_id
        AND assignment.user_id = NEW.actor_user_id
        AND assignment.membership_id = NEW.actor_membership_id
        AND assignment.id = NEW.manager_assignment_id
        AND assignment.status = 'accepted'
        AND assignment.ended_at_ms IS NULL
        AND membership.status = 'active'
        AND actor.status = 'active'
        AND NEW.actor_authority = 'manager'
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_card_help_requests AS help
      JOIN candidate_cards AS card
        ON card.league_id = help.league_id
       AND card.season_id = help.season_id
       AND card.fad_id = help.fad_id
       AND card.id = help.card_id
       AND card.team_id = help.team_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = help.league_id
       AND fad.season_id = help.season_id
       AND fad.id = help.fad_id
      JOIN users AS requester
        ON requester.id = help.requested_by_user_id
      WHERE help.league_id = NEW.league_id
        AND help.season_id = NEW.season_id
        AND help.fad_id = NEW.fad_id
        AND help.card_id = NEW.card_id
        AND help.team_id = NEW.team_id
        AND help.id = NEW.help_request_id
        AND help.status = 'active'
        AND help.expires_at_ms = fad.candidate_deadline_at_ms
        AND help.requested_at_ms <= NEW.created_at_ms
        AND NEW.created_at_ms < help.expires_at_ms
        AND card.status = 'open'
        AND fad.status = 'cards_open'
        AND fad.help_opens_at_ms <= NEW.created_at_ms
        AND NEW.created_at_ms < fad.candidate_deadline_at_ms
        AND (
          (
            NEW.response_http_status = 201
            AND help.requested_by_user_id = NEW.actor_user_id
            AND help.requested_by_membership_id =
              NEW.actor_membership_id
            AND help.requested_at_ms = NEW.created_at_ms
            AND requester.status = 'active'
            AND NEW.requested_by_display_name = requester.display_name
            AND NEW.response_json = json_object(
              'helpRequestId', help.id,
              'leagueId', help.league_id,
              'seasonId', help.season_id,
              'fadId', help.fad_id,
              'cardId', help.card_id,
              'teamId', help.team_id,
              'status', 'active',
              'message', help.message,
              'requestedByUserId', help.requested_by_user_id,
              'requestedByDisplayName', requester.display_name,
              'requestedAtMs', help.requested_at_ms,
              'expiresAtMs', help.expires_at_ms,
              'version', 1
            )
          )
          OR (
            NEW.response_http_status = 200
            AND EXISTS (
              SELECT 1
              FROM candidate_card_help_command_results AS created_result
              WHERE created_result.league_id = NEW.league_id
                AND created_result.help_request_id = NEW.help_request_id
                AND created_result.response_http_status = 201
                AND created_result.requested_by_display_name =
                  NEW.requested_by_display_name
                AND created_result.response_json = NEW.response_json
                AND created_result.response_sha256 = NEW.response_sha256
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate Card help result must bind its exact request, manager, grant, status, and response'
  ) END;
END;

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
               AND current_rollover.fad_id = target_rollover.fad_id
               AND current_rollover.id =
                    target_rollover.predecessor_rollover_id
               AND current_rollover.sequence =
                    target_rollover.sequence - 1
              WHERE auctions.league_id = NEW.league_id
                AND auctions.season_id = NEW.season_id
                AND auctions.id = NEW.restricted_auction_id
                AND auctions.player_id = NEW.player_id
                AND auctions.status = 'open'
                AND auctions.opened_at_ms = target_rollover.opens_at_ms
                AND target_rollover.status = 'scheduled'
                AND target_rollover.opens_at_ms =
                  current_rollover.rolls_over_at_ms
                AND current_rollover.status IN (
                  'scheduled',
                  'processing'
                )
                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
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
            AND auction_contexts.fad_origin =
              'candidate_tie_restricted'
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
        AND NEW.status = CASE
          WHEN OLD.decision_code =
              'exact_total_and_term_tie'
            AND OLD.restricted_auction_id IS NOT NULL
            AND OLD.fallback_open_auction_id IS NULL
            THEN 'restricted_active'
          WHEN OLD.decision_code =
              'restricted_no_improvement_fallback'
            AND OLD.restricted_auction_id IS NOT NULL
            AND OLD.fallback_open_auction_id IS NOT NULL
            THEN 'restricted_fallback_open'
          ELSE NULL
        END
        AND NEW.decision_code IS OLD.decision_code
        AND OLD.winning_snapshot_entry_id IS NULL
        AND OLD.winning_team_id IS NULL
        AND OLD.contract_id IS NULL
        AND OLD.ownership_id IS NULL
        AND NEW.winning_snapshot_entry_id IS
          OLD.winning_snapshot_entry_id
        AND NEW.winning_team_id IS OLD.winning_team_id
        AND NEW.contract_id IS OLD.contract_id
        AND NEW.ownership_id IS OLD.ownership_id
        AND NEW.restricted_auction_id IS
          OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND OLD.restricted_minimum_total_cents IS NOT NULL
        AND OLD.restricted_minimum_term_years IS NOT NULL
        AND OLD.restricted_minimum_aav_cents IS NOT NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND OLD.accounted_at_ms IS NULL
        AND NEW.accounted_at_ms IS OLD.accounted_at_ms
        AND OLD.last_error_code IS NOT NULL
        AND NEW.last_error_code IS NULL
        AND NEW.updated_at_ms > OLD.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM auction_contexts AS context
          JOIN auctions AS auction
            ON auction.league_id = context.league_id
           AND auction.season_id = context.season_id
           AND auction.id = context.auction_id
           AND auction.player_id = OLD.player_id
          JOIN free_agent_draft_rollovers AS rollover
            ON rollover.league_id = context.league_id
           AND rollover.season_id = context.season_id
           AND rollover.fad_id = context.fad_id
           AND rollover.id = context.fad_rollover_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.allocation_id = context.fad_allocation_id
           AND draw.auction_id = context.auction_id
          JOIN free_agent_draft_recoveries AS recovery
            ON recovery.league_id = context.league_id
           AND recovery.season_id = context.season_id
           AND recovery.fad_id = context.fad_id
           AND recovery.player_id = auction.player_id
           AND recovery.allocation_id = context.fad_allocation_id
           AND recovery.rollover_id = context.fad_rollover_id
           AND recovery.auction_id = context.auction_id
          JOIN job_runs AS job
            ON job.league_id = recovery.league_id
           AND job.season_id = recovery.season_id
           AND job.id = recovery.job_run_id
          JOIN auction_events AS failure_event
            ON failure_event.league_id = recovery.league_id
           AND failure_event.season_id = recovery.season_id
           AND failure_event.auction_id = recovery.auction_id
           AND failure_event.event_type =
                'fad_auction_resolution_failed'
          JOIN free_agent_draft_recovery_action_command_results
            AS receipt
            ON receipt.league_id = recovery.league_id
           AND receipt.season_id = recovery.season_id
           AND receipt.fad_id = recovery.fad_id
           AND receipt.recovery_id = recovery.id
           AND receipt.job_run_id = recovery.job_run_id
          JOIN idempotency_requests AS request
            ON request.league_id = receipt.league_id
           AND request.id = receipt.idempotency_request_id
          WHERE context.league_id = OLD.league_id
            AND context.season_id = OLD.season_id
            AND context.fad_id = OLD.fad_id
            AND context.fad_allocation_id = OLD.id
            AND context.auction_id = CASE
              WHEN NEW.status = 'restricted_active'
                THEN OLD.restricted_auction_id
              ELSE OLD.fallback_open_auction_id
            END
            AND (
              (
                NEW.status = 'restricted_active'
                AND context.source_kind = 'fad_restricted'
                AND context.fad_origin =
                  'candidate_tie_restricted'
              )
              OR (
                NEW.status = 'restricted_fallback_open'
                AND context.source_kind = 'fad_open_rapid'
                AND context.fad_origin =
                  'restricted_no_improvement_fallback'
              )
            )
            AND auction.status = 'resolving'
            AND auction.updated_at_ms = NEW.updated_at_ms
            AND auction.resolves_at_ms <= NEW.updated_at_ms
            AND rollover.rolls_over_at_ms =
                auction.resolves_at_ms
            AND draw.algorithm_version = 1
            AND draw.nonce_bytes IS NOT NULL
            AND length(draw.nonce_bytes) = 32
            AND draw.commitment_hex IS NOT NULL
            AND draw.ordered_tied_bid_ids_json IS NULL
            AND draw.ordered_tied_team_ids_json IS NULL
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND draw.revealed_at_ms IS NULL
            AND draw.version = 1
            AND NOT EXISTS (
              SELECT 1
              FROM auction_resolutions AS resolution
              WHERE resolution.league_id = auction.league_id
                AND resolution.auction_id = auction.id
            )
            AND recovery.kind = 'auction_resolution'
            AND recovery.status = 'running'
            AND recovery.target_resolution_at_ms =
                auction.resolves_at_ms
            AND recovery.last_error_code =
                OLD.last_error_code
            AND recovery.commissioner_reason IS NOT NULL
            AND recovery.created_by_operation_id = job.id
            AND recovery.resolved_by_user_id IS NULL
            AND recovery.resolved_by_membership_id IS NULL
            AND recovery.resolved_authority IS NULL
            AND recovery.resolved_at_ms IS NULL
            AND recovery.created_at_ms <=
                failure_event.occurred_at_ms
            AND recovery.updated_at_ms =
                receipt.accepted_at_ms
            AND recovery.updated_at_ms <=
                NEW.updated_at_ms
            AND recovery.version >= 2
            AND failure_event.actor_user_id IS NULL
            AND failure_event.bid_id IS NULL
            AND failure_event.team_id IS NULL
            AND json_valid(failure_event.metadata_json) = 1
            AND json_extract(
                  failure_event.metadata_json,
                  '$.recoveryId'
                ) = recovery.id
            AND json_extract(
                  failure_event.metadata_json,
                  '$.jobRunId'
                ) = job.id
            AND json_extract(
                  failure_event.metadata_json,
                  '$.errorCode'
                ) = OLD.last_error_code
            AND failure_event.occurred_at_ms =
                OLD.updated_at_ms
            AND (
              SELECT COUNT(*)
              FROM auction_events AS exact_failure
              WHERE exact_failure.league_id =
                  failure_event.league_id
                AND exact_failure.season_id =
                  failure_event.season_id
                AND exact_failure.auction_id =
                  failure_event.auction_id
                AND exact_failure.event_type =
                  'fad_auction_resolution_failed'
                AND exact_failure.occurred_at_ms =
                  failure_event.occurred_at_ms
            ) = 1
            AND NOT EXISTS (
              SELECT 1
              FROM auction_events AS later_failure
              WHERE later_failure.league_id =
                  failure_event.league_id
                AND later_failure.season_id =
                  failure_event.season_id
                AND later_failure.auction_id =
                  failure_event.auction_id
                AND later_failure.event_type =
                  'fad_auction_resolution_failed'
                AND json_extract(
                      later_failure.metadata_json,
                      '$.recoveryId'
                    ) = recovery.id
                AND json_extract(
                      later_failure.metadata_json,
                      '$.jobRunId'
                    ) = job.id
                AND later_failure.occurred_at_ms >
                  failure_event.occurred_at_ms
            )
            AND job.job_type = 'auction.resolve.target'
            AND job.occurrence_key =
              'auction:' || auction.id || ':' ||
                auction.resolves_at_ms
            AND job.scheduled_for_ms =
                auction.resolves_at_ms
            AND job.status = 'running'
            AND job.attempt_count >= 2
            AND job.lease_owner IS NOT NULL
            AND job.lease_token IS NOT NULL
            AND job.lease_expires_at_ms >
                NEW.updated_at_ms
            AND job.started_at_ms =
                NEW.updated_at_ms
            AND job.updated_at_ms =
                NEW.updated_at_ms
            AND job.completed_at_ms IS NULL
            AND job.result_json IS NULL
            AND job.last_error_code IS NULL
            AND job.next_attempt_at_ms IS NULL
            AND receipt.action =
                'retry_auction_resolution'
            AND receipt.resource_kind = 'auction'
            AND receipt.resource_id = auction.id
            AND receipt.operation_id = job.id
            AND receipt.job_run_id = job.id
            AND receipt.occurrence_key =
                job.occurrence_key
            AND receipt.commissioner_reason =
                recovery.commissioner_reason
            AND receipt.accepted_status = 'pending'
            AND receipt.accepted_at_ms >=
                failure_event.occurred_at_ms
            AND receipt.accepted_at_ms <=
                NEW.updated_at_ms
            AND request.actor_user_id =
                receipt.actor_user_id
            AND request.operation =
                'free_agent_draft.recovery.action'
            AND request.request_hash =
                receipt.request_sha256
            AND request.status = 'completed'
            AND request.result_type =
                'free_agent_draft_recovery_action_command_result'
            AND request.result_id = receipt.id
            AND request.created_at_ms =
                receipt.accepted_at_ms
            AND request.completed_at_ms =
                receipt.accepted_at_ms
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recovery_action_command_results
                AS later_receipt
              WHERE later_receipt.league_id =
                  receipt.league_id
                AND later_receipt.recovery_id =
                  receipt.recovery_id
                AND later_receipt.action =
                  'retry_auction_resolution'
                AND (
                  later_receipt.accepted_at_ms >
                    receipt.accepted_at_ms
                  OR (
                    later_receipt.accepted_at_ms =
                      receipt.accepted_at_ms
                    AND later_receipt.id > receipt.id
                  )
                )
            )
        )
      )
      OR (
        OLD.status IN (
          'correction_required',
          'restricted_scheduled',
          'restricted_active',
          'restricted_fallback_open',
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
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
        AND (
          OLD.status NOT IN (
            'restricted_scheduled',
            'restricted_active',
            'restricted_fallback_open'
          )
          OR NEW.status IN (
            'automatic_award',
            'no_valid_offer'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM commissioner_corrections AS correction
          WHERE correction.league_id = NEW.league_id
            AND correction.season_id = NEW.season_id
            AND correction.feature =
                'free_agent_draft_allocation'
            AND correction.feature_record_id = NEW.id
            AND correction.corrected_at_ms = NEW.updated_at_ms
            AND json_valid(correction.before_snapshot_json) = 1
            AND json_valid(correction.after_snapshot_json) = 1
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.status'
                ) = OLD.status
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.version'
                ) = OLD.version
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.status'
                ) = NEW.status
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.version'
                ) = NEW.version
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.decisionCode'
                ) = 'corrected'
            AND (
              EXISTS (
                SELECT 1
                FROM leagues AS league
                JOIN league_memberships AS membership
                  ON membership.league_id = league.id
                 AND membership.id =
                      league.commissioner_membership_id
                 AND membership.user_id =
                      correction.actor_user_id
                WHERE league.id = correction.league_id
                  AND membership.permission_category = 'commissioner'
                  AND membership.status = 'active'
              )
              OR EXISTS (
                SELECT 1
                FROM league_memberships AS membership
                JOIN platform_roles AS role
                  ON role.user_id = membership.user_id
                 AND role.role = 'platform_administrator'
                 AND role.status = 'active'
                WHERE membership.league_id = correction.league_id
                  AND membership.user_id = correction.actor_user_id
                  AND membership.status = 'active'
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auctions AS linked_auction
          WHERE linked_auction.league_id = OLD.league_id
            AND linked_auction.id IN (
              OLD.restricted_auction_id,
              OLD.fallback_open_auction_id
            )
            AND linked_auction.status IN (
              'open',
              'resolving',
              'failed'
            )
        )
        AND (
          OLD.status NOT IN (
            'restricted_scheduled',
            'restricted_active',
            'restricted_fallback_open'
          )
          OR EXISTS (
            SELECT 1
            FROM commissioner_corrections AS correction
            JOIN auctions AS auction
              ON auction.league_id = NEW.league_id
             AND auction.id = CASE
                  WHEN OLD.status =
                    'restricted_fallback_open'
                    THEN OLD.fallback_open_auction_id
                  ELSE OLD.restricted_auction_id
                END
            JOIN auction_contexts AS context
              ON context.league_id = auction.league_id
             AND context.season_id = auction.season_id
             AND context.auction_id = auction.id
             AND context.fad_id = NEW.fad_id
             AND context.fad_allocation_id = NEW.id
            JOIN auction_resolutions AS resolution
              ON resolution.league_id = auction.league_id
             AND resolution.season_id = auction.season_id
             AND resolution.auction_id = auction.id
            JOIN free_agent_draft_draws AS draw
              ON draw.league_id = context.league_id
             AND draw.season_id = context.season_id
             AND draw.fad_id = context.fad_id
             AND draw.allocation_id = context.fad_allocation_id
             AND draw.auction_id = context.auction_id
            JOIN auction_events AS event
              ON event.league_id = auction.league_id
             AND event.season_id = auction.season_id
             AND event.auction_id = auction.id
            WHERE correction.league_id = NEW.league_id
              AND correction.season_id = NEW.season_id
              AND correction.feature =
                  'free_agent_draft_allocation'
              AND correction.feature_record_id = NEW.id
              AND correction.corrected_at_ms = NEW.updated_at_ms
              AND auction.player_id = NEW.player_id
              AND auction.status = 'cancelled'
              AND auction.updated_at_ms = NEW.updated_at_ms
              AND auction.created_at_ms <= NEW.updated_at_ms
              AND draw.created_at_ms <= NEW.updated_at_ms
              AND context.source_kind = CASE
                WHEN OLD.status = 'restricted_fallback_open'
                  THEN 'fad_open_rapid'
                ELSE 'fad_restricted'
              END
              AND (
                OLD.status <> 'restricted_fallback_open'
                OR context.fad_origin =
                  'restricted_no_improvement_fallback'
              )
              AND resolution.status = 'cancelled'
              AND resolution.outcome_code = 'recovered'
              AND resolution.trigger_type = 'commissioner'
              AND resolution.triggered_by_user_id =
                  correction.actor_user_id
              AND resolution.resolved_at_ms = NEW.updated_at_ms
              AND draw.version = 2
              AND draw.revealed_at_ms = NEW.updated_at_ms
              AND draw.ordered_tied_bid_ids_json = '[]'
              AND draw.ordered_tied_team_ids_json = '[]'
              AND draw.rejection_counter IS NULL
              AND draw.selected_index IS NULL
              AND draw.selected_bid_id IS NULL
              AND draw.selected_team_id IS NULL
              AND draw.selected_digest_hex IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM auction_bids AS bid
                WHERE bid.league_id = auction.league_id
                  AND bid.auction_id = auction.id
              )
              AND event.event_type = 'auction_cancelled'
              AND event.actor_user_id = correction.actor_user_id
              AND event.occurred_at_ms = NEW.updated_at_ms
              AND json_extract(
                    event.metadata_json,
                    '$.actorAuthority'
                  ) IN (
                    'commissioner',
                    'platform_administrator_as_commissioner'
                  )
              AND json_extract(
                    event.metadata_json,
                    '$.correctionId'
                  ) = correction.id
          )
        )
        AND (
          NEW.winning_snapshot_entry_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM candidate_card_snapshot_entries AS snapshot_entry
            WHERE snapshot_entry.league_id = NEW.league_id
              AND snapshot_entry.season_id = NEW.season_id
              AND snapshot_entry.fad_id = NEW.fad_id
              AND snapshot_entry.id = NEW.winning_snapshot_entry_id
              AND snapshot_entry.player_id = NEW.player_id
              AND snapshot_entry.team_id = NEW.winning_team_id
              AND snapshot_entry.proposed_total_value_cents IS NOT NULL
              AND snapshot_entry.proposed_term_years IS NOT NULL
              AND snapshot_entry.proposed_aav_cents IS NOT NULL
          )
        )
        AND (
          (
            NEW.status = 'automatic_award'
            AND NEW.winning_snapshot_entry_id IS NOT NULL
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
          )
          OR (
            NEW.status <> 'automatic_award'
            AND NEW.winning_team_id IS NULL
            AND NEW.winning_snapshot_entry_id IS NULL
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
    'allocation may only follow automatic, restricted, fallback, or attributable correction state'
  ) END;
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
        AND (
          free_agent_drafts.status IN (
            'deadline_locked',
            'allocating'
          )
          OR (
            free_agent_drafts.status = 'cards_open'
            AND NEW.created_at_ms >=
              free_agent_drafts.candidate_deadline_at_ms
            AND EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries
              WHERE candidate_card_snapshot_entries.league_id =
                  NEW.league_id
                AND candidate_card_snapshot_entries.season_id =
                  NEW.season_id
                AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
                AND candidate_card_snapshot_entries.player_id =
                  NEW.player_id
                AND candidate_card_snapshot_entries.occupant_kind =
                  'candidate'
                AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
                AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
                AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
            )
            AND EXISTS (
              SELECT 1
              FROM job_runs
              WHERE job_runs.league_id = NEW.league_id
                AND job_runs.season_id = NEW.season_id
                AND job_runs.job_type = 'fad_deadline'
                AND job_runs.occurrence_key =
                  'fad:' || NEW.fad_id || ':deadline:' ||
                    free_agent_drafts.candidate_deadline_at_ms
                AND job_runs.scheduled_for_ms =
                  free_agent_drafts.candidate_deadline_at_ms
                AND job_runs.status IN ('leased', 'running')
                AND job_runs.attempt_count >= 1
                AND job_runs.lease_owner IS NOT NULL
                AND length(trim(job_runs.lease_owner)) > 0
                AND job_runs.lease_token IS NOT NULL
                AND length(trim(job_runs.lease_token)) > 0
                AND job_runs.lease_expires_at_ms > NEW.created_at_ms
                AND job_runs.updated_at_ms >=
                  job_runs.scheduled_for_ms
                AND job_runs.updated_at_ms <= NEW.created_at_ms
                AND job_runs.completed_at_ms IS NULL
                AND job_runs.result_json IS NULL
                AND job_runs.last_error_code IS NULL
                AND job_runs.next_attempt_at_ms IS NULL
                AND (
                  (
                    job_runs.status = 'leased'
                    AND job_runs.started_at_ms IS NULL
                  )
                  OR (
                    job_runs.status = 'running'
                    AND job_runs.started_at_ms IS NOT NULL
                    AND job_runs.started_at_ms <= NEW.created_at_ms
                  )
                )
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'allocation must begin as uncommitted per-player work'
  ) END;
END;

CREATE TRIGGER free_agent_draft_eligibility_revalidation_valid_insert
BEFORE INSERT
  ON free_agent_draft_eligibility_revalidation_occurrences
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.scheduled_for_ms = NEW.created_at_ms
    AND NOT EXISTS (
      SELECT 1
      FROM operational_events AS source_operation
      WHERE source_operation.id = NEW.source_operation_id
    )
    AND EXISTS (
      SELECT 1
      FROM players AS player
      WHERE player.id = NEW.player_id
        AND player.version = NEW.player_version_after
        AND player.status = NEW.player_status_after
    )
    AND (
      (
        NEW.player_status_before = NEW.player_status_after
        AND NEW.player_version_after IN (
          NEW.player_version_before,
          NEW.player_version_before + 1
        )
      )
      OR (
        NEW.player_status_before <> NEW.player_status_after
        AND NEW.player_version_after = NEW.player_version_before + 1
      )
    )
    AND (
      NEW.source_state_before_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM player_source_state AS source_before
        WHERE source_before.player_id = NEW.player_id
          AND source_before.id = NEW.source_state_before_id
      )
    )
    AND EXISTS (
      SELECT 1
      FROM player_source_state AS source_after
      WHERE source_after.player_id = NEW.player_id
        AND source_after.id = NEW.source_state_after_id
        AND source_after.ended_at_ms IS NULL
    )
    AND NEW.source_resolved_position_group_after IS (
      SELECT CASE
        WHEN COUNT(DISTINCT source.normalized_position) = 1
        THEN MIN(source.normalized_position)
        ELSE NULL
      END
      FROM player_source_state AS source
      WHERE source.player_id = NEW.player_id
        AND source.ended_at_ms IS NULL
        AND source.active = 1
        AND source.normalized_position IN ('F', 'D')
    )
    AND (
      (
        NEW.league_position_override_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM league_player_positions AS position_override
          WHERE position_override.league_id = NEW.league_id
            AND position_override.player_id = NEW.player_id
            AND position_override.ended_at_ms IS NULL
        )
        AND NEW.effective_position_group_before IS
          NEW.source_resolved_position_group_before
        AND NEW.effective_position_group_after IS
          NEW.source_resolved_position_group_after
      )
      OR EXISTS (
        SELECT 1
        FROM league_player_positions AS position_override
        WHERE position_override.league_id = NEW.league_id
          AND position_override.player_id = NEW.player_id
          AND position_override.id = NEW.league_position_override_id
          AND position_override.ended_at_ms IS NULL
          AND NEW.effective_position_group_before =
            position_override.position_group
          AND NEW.effective_position_group_after =
            position_override.position_group
      )
    )
    AND (
      NEW.player_status_before IS NOT NEW.player_status_after
      OR NEW.effective_position_group_before IS NOT
        NEW.effective_position_group_after
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts AS fad
      JOIN candidate_cards AS card
        ON card.league_id = fad.league_id
       AND card.season_id = fad.season_id
       AND card.fad_id = fad.id
       AND card.status = 'open'
      JOIN candidate_card_entries AS entry
        ON entry.league_id = card.league_id
       AND entry.season_id = card.season_id
       AND entry.fad_id = card.fad_id
       AND entry.card_id = card.id
       AND entry.team_id = card.team_id
       AND entry.player_id = NEW.player_id
      WHERE fad.league_id = NEW.league_id
        AND fad.season_id = NEW.season_id
        AND fad.id = NEW.fad_id
        AND fad.status = 'cards_open'
        AND fad.opened_at_ms <= NEW.created_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'FAD eligibility revalidation must bind an unsealed semantic player delta in an affected open FAD'
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
    AND NEW.acceptance_idempotency_request_id IS
      OLD.acceptance_idempotency_request_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_rollovers AS opening_rollover
      JOIN job_runs AS activation_job
        ON activation_job.league_id = OLD.league_id
       AND activation_job.season_id = OLD.season_id
      WHERE opening_rollover.league_id = OLD.league_id
        AND opening_rollover.season_id = OLD.season_id
        AND opening_rollover.fad_id = OLD.fad_id
        AND opening_rollover.id =
          OLD.target_opening_rollover_id
        AND opening_rollover.rolls_over_at_ms <=
          NEW.updated_at_ms
        AND activation_job.job_type =
          'fad_queued_nomination_activation'
        AND activation_job.occurrence_key =
          'fad:' || OLD.fad_id || ':nomination-open:' ||
            OLD.id || ':' || opening_rollover.rolls_over_at_ms
        AND activation_job.scheduled_for_ms =
          opening_rollover.rolls_over_at_ms
        AND activation_job.status = 'running'
        AND activation_job.attempt_count >= 1
        AND activation_job.lease_owner IS NOT NULL
        AND activation_job.lease_token IS NOT NULL
        AND activation_job.started_at_ms >=
          opening_rollover.rolls_over_at_ms
        AND activation_job.started_at_ms <=
          NEW.updated_at_ms
        AND activation_job.updated_at_ms =
          activation_job.started_at_ms
        AND activation_job.lease_expires_at_ms >
          NEW.updated_at_ms
        AND activation_job.completed_at_ms IS NULL
        AND activation_job.result_json IS NULL
        AND activation_job.last_error_code IS NULL
        AND activation_job.next_attempt_at_ms IS NULL
        AND activation_job.created_at_ms =
          OLD.accepted_at_ms
    )
    AND (
      (
        NEW.status = 'invalid'
        AND NEW.resolution_rollover_id IS NULL
        AND NEW.opened_auction_id IS NULL
        AND NEW.opened_starter_bid_id IS NULL
        AND NEW.opened_at_ms IS NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.validation_code = 'PLAYER_UNAVAILABLE'
      )
      OR (
        NEW.status = 'opened'
        AND NEW.resolution_rollover_id IS NOT NULL
        AND NEW.opened_at_ms IS NOT NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.updated_at_ms >= NEW.opened_at_ms
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
          JOIN auctions AS auction
            ON auction.league_id = NEW.league_id
           AND auction.season_id = NEW.season_id
           AND auction.id = NEW.opened_auction_id
          JOIN auction_contexts AS context
            ON context.league_id = auction.league_id
           AND context.season_id = auction.season_id
           AND context.auction_id = auction.id
          JOIN auction_bids AS starter
            ON starter.league_id = auction.league_id
           AND starter.season_id = auction.season_id
           AND starter.id = NEW.opened_starter_bid_id
           AND starter.auction_id = auction.id
          JOIN auction_events AS started_event
            ON started_event.league_id = starter.league_id
           AND started_event.season_id = starter.season_id
           AND started_event.auction_id = starter.auction_id
           AND started_event.bid_id = starter.id
           AND started_event.team_id = starter.team_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.auction_id = context.auction_id
          JOIN idempotency_requests AS request
            ON request.league_id = NEW.league_id
           AND request.id =
                NEW.acceptance_idempotency_request_id
          JOIN job_runs AS resolution_job
            ON resolution_job.league_id = auction.league_id
           AND resolution_job.season_id = auction.season_id
           AND resolution_job.job_type =
                'auction.resolve.target'
           AND resolution_job.occurrence_key =
                'auction:' || auction.id || ':' ||
                  auction.resolves_at_ms
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
            AND resolution_rollover.predecessor_rollover_id =
              opening_rollover.id
            AND resolution_rollover.opens_at_ms =
              opening_rollover.rolls_over_at_ms
            AND resolution_rollover.creation_cutoff_at_ms =
              max(resolution_rollover.opens_at_ms, resolution_rollover.rolls_over_at_ms - 3600000)
            AND resolution_rollover.rolls_over_at_ms >
              opening_rollover.rolls_over_at_ms
            AND resolution_rollover.status = 'scheduled'
            AND auction.player_id = NEW.player_id
            AND auction.status = 'open'
            AND auction.opened_at_ms = NEW.opened_at_ms
            AND auction.resolves_at_ms =
              resolution_rollover.rolls_over_at_ms
            AND auction.opened_by_user_id =
              NEW.submitted_by_user_id
            AND auction.created_at_ms = NEW.opened_at_ms
            AND auction.updated_at_ms = NEW.opened_at_ms
            AND auction.version = 1
            AND context.id = auction.id
            AND context.source_kind = 'fad_open_rapid'
            AND context.fad_id = NEW.fad_id
            AND context.fad_rollover_id =
              NEW.resolution_rollover_id
            AND context.fad_allocation_id IS NULL
            AND context.fad_origin = 'queued_nomination'
            AND context.created_at_ms = NEW.opened_at_ms
            AND starter.team_id = NEW.team_id
            AND starter.submitted_by_user_id =
              NEW.submitted_by_user_id
            AND starter.total_value_cents =
              NEW.opening_total_value_cents
            AND starter.term_years =
              NEW.opening_term_years
            AND starter.lowest_offered_aav_cents =
              NEW.opening_aav_cents
            AND starter.first_submitted_at_ms =
              NEW.accepted_at_ms
            AND starter.last_edited_at_ms =
              NEW.accepted_at_ms
            AND starter.edit_count = 0
            AND starter.status = 'active'
            AND starter.idempotency_request_id =
              NEW.acceptance_idempotency_request_id
            AND starter.version = 1
            AND started_event.actor_user_id =
              NEW.submitted_by_user_id
            AND started_event.event_type = 'auction_started'
            AND started_event.occurred_at_ms = NEW.opened_at_ms
            AND json_valid(started_event.metadata_json) = 1
            AND json_type(started_event.metadata_json) = 'object'
            AND (
              SELECT COUNT(*)
              FROM json_each(started_event.metadata_json)
            ) = 12
            AND json_extract(
                  started_event.metadata_json,
                  '$.openingTeamId'
                ) = NEW.team_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.actorMembershipId'
                ) = NEW.submitted_by_membership_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.actorAuthority'
                ) = 'manager'
            AND json_type(
                  started_event.metadata_json,
                  '$.bindingIllegalityConfirmed'
                ) = 'true'
            AND json_extract(
                  started_event.metadata_json,
                  '$.bindingIllegalityConfirmed'
                ) = 1
            AND json_extract(
                  started_event.metadata_json,
                  '$.playerPosition'
                ) IN ('F', 'D')
            AND json_extract(
                  started_event.metadata_json,
                  '$.creationCutoffAtMs'
                ) = opening_rollover.creation_cutoff_at_ms
            AND json_extract(
                  started_event.metadata_json,
                  '$.bidClosesAtMs'
                ) = auction.resolves_at_ms
            AND json_extract(
                  started_event.metadata_json,
                  '$.totalValueCents'
                ) = NEW.opening_total_value_cents
            AND json_extract(
                  started_event.metadata_json,
                  '$.termYears'
                ) = NEW.opening_term_years
            AND json_extract(
                  started_event.metadata_json,
                  '$.aavCents'
                ) = NEW.opening_aav_cents
            AND json_extract(
                  started_event.metadata_json,
                  '$.fadId'
                ) = NEW.fad_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.fadRolloverId'
                ) = NEW.resolution_rollover_id
            AND draw.allocation_id IS NULL
            AND draw.algorithm_version = 1
            AND length(draw.nonce_bytes) = 32
            AND length(draw.commitment_hex) = 64
            AND draw.commitment_hex =
              lower(draw.commitment_hex)
            AND draw.commitment_hex NOT GLOB
              '*[^0-9a-f]*'
            AND draw.ordered_tied_bid_ids_json IS NULL
            AND draw.ordered_tied_team_ids_json IS NULL
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND draw.revealed_at_ms IS NULL
            AND draw.created_at_ms = NEW.opened_at_ms
            AND draw.updated_at_ms = NEW.opened_at_ms
            AND draw.version = 1
            AND request.actor_user_id =
              NEW.submitted_by_user_id
            AND request.operation = 'auction.start'
            AND request.status = 'completed'
            AND request.result_type =
              'fad_nomination_queue'
            AND request.result_id = NEW.id
            AND request.created_at_ms =
              NEW.accepted_at_ms
            AND request.completed_at_ms =
              NEW.accepted_at_ms
            AND request.expires_at_ms >
              NEW.accepted_at_ms
            AND resolution_job.scheduled_for_ms =
              auction.resolves_at_ms
            AND resolution_job.status = 'pending'
            AND resolution_job.attempt_count = 0
            AND resolution_job.lease_owner IS NULL
            AND resolution_job.lease_token IS NULL
            AND resolution_job.lease_expires_at_ms IS NULL
            AND resolution_job.started_at_ms IS NULL
            AND resolution_job.completed_at_ms IS NULL
            AND resolution_job.result_json IS NULL
            AND resolution_job.last_error_code IS NULL
            AND resolution_job.next_attempt_at_ms IS NULL
            AND resolution_job.created_at_ms =
              NEW.updated_at_ms
            AND resolution_job.updated_at_ms =
              NEW.updated_at_ms
            AND resolution_job.version = 1
            AND (
              SELECT COUNT(*)
              FROM auction_bids AS exact_starter
              WHERE exact_starter.league_id = auction.league_id
                AND exact_starter.auction_id = auction.id
            ) = 1
            AND (
              SELECT COUNT(*)
              FROM auction_events AS exact_started_event
              WHERE exact_started_event.league_id =
                  auction.league_id
                AND exact_started_event.auction_id = auction.id
                AND exact_started_event.event_type =
                  'auction_started'
            ) = 1
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'queued nomination may only open or invalidate under its exact live activation'
  ) END;
END;

CREATE TRIGGER free_agent_draft_nomination_queue_valid_insert
BEFORE INSERT ON free_agent_draft_nomination_queue
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'queued'
    AND NEW.resolution_rollover_id IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.accepted_at_ms
    AND NEW.acceptance_idempotency_request_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id =
          NEW.acceptance_idempotency_request_id
        AND idempotency_requests.actor_user_id =
          NEW.submitted_by_user_id
        AND idempotency_requests.operation = 'auction.start'
        AND idempotency_requests.status = 'started'
        AND idempotency_requests.result_type IS NULL
        AND idempotency_requests.result_id IS NULL
        AND idempotency_requests.created_at_ms = NEW.accepted_at_ms
        AND idempotency_requests.completed_at_ms IS NULL
        AND idempotency_requests.expires_at_ms > NEW.accepted_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status IN ('allocating', 'rapid')
        AND free_agent_drafts.candidate_deadline_at_ms <= NEW.accepted_at_ms
        AND free_agent_drafts.deadline_locked_at_ms <= NEW.accepted_at_ms
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

CREATE TRIGGER free_agent_draft_readiness_attempts_valid_insert
BEFORE INSERT ON free_agent_draft_readiness_attempts
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_readiness_operations AS readiness
      JOIN seasons
        ON seasons.league_id = readiness.league_id
       AND seasons.id = readiness.season_id
      JOIN job_runs
        ON job_runs.league_id = readiness.league_id
       AND job_runs.season_id = readiness.season_id
       AND job_runs.id = readiness.job_run_id
       AND job_runs.occurrence_key = readiness.readiness_occurrence_key
      WHERE readiness.league_id = NEW.league_id
        AND readiness.season_id = NEW.season_id
        AND readiness.id = NEW.readiness_operation_id
        AND readiness.job_run_id = NEW.job_run_id
        AND readiness.status = 'running'
        AND readiness.attempt_count = NEW.attempt_number
        AND readiness.version = NEW.observed_readiness_version
        AND seasons.version = json_extract(
          NEW.projection_json,
          '$.observedSeasonVersion'
        )
        AND job_runs.job_type = 'fad_readiness'
        AND job_runs.status = 'running'
        AND job_runs.attempt_count = NEW.attempt_number
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms > NEW.observed_at_ms
        AND job_runs.started_at_ms IS NOT NULL
        AND job_runs.started_at_ms <= NEW.observed_at_ms
        AND NEW.observed_at_ms >= readiness.started_at_ms
    )
    AND (SELECT COUNT(*) FROM json_each(NEW.projection_json)) = 12
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.projection_json) AS member
      WHERE member.key NOT IN (
        'observedSeasonVersion',
        'firstMatchupWeekBefore',
        'firstMatchupWeekAfter',
        'candidateDeadlineAtMs',
        'reminderAtMs',
        'helpOpensAtMs',
        'initialRollovers',
        'priorSeasonRollover',
        'participatingTeamCount',
        'teamProjections',
        'blockers',
        'warnings'
      )
    )
    AND json_type(
      NEW.projection_json,
      '$.observedSeasonVersion'
    ) = 'integer'
    AND json_extract(
      NEW.projection_json,
      '$.observedSeasonVersion'
    ) >= 1
    AND json_type(
      NEW.projection_json,
      '$.firstMatchupWeekBefore'
    ) IN ('object', 'null')
    AND json_type(
      NEW.projection_json,
      '$.firstMatchupWeekAfter'
    ) IN ('object', 'null')
    AND json_type(
      NEW.projection_json,
      '$.candidateDeadlineAtMs'
    ) IN ('integer', 'null')
    AND json_type(
      NEW.projection_json,
      '$.reminderAtMs'
    ) IN ('integer', 'null')
    AND json_type(
      NEW.projection_json,
      '$.helpOpensAtMs'
    ) IN ('integer', 'null')
    AND json_type(
      NEW.projection_json,
      '$.initialRollovers'
    ) = 'array'
    AND json_type(
      NEW.projection_json,
      '$.priorSeasonRollover'
    ) IN ('object', 'null')
    AND json_type(
      NEW.projection_json,
      '$.participatingTeamCount'
    ) = 'integer'
    AND json_extract(
      NEW.projection_json,
      '$.participatingTeamCount'
    ) >= 0
    AND json_type(
      NEW.projection_json,
      '$.teamProjections'
    ) = 'array'
    AND json_type(NEW.projection_json, '$.blockers') = 'array'
    AND json_type(NEW.projection_json, '$.warnings') = 'array'
    AND (
      (
        json_type(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) = 'null'
        AND json_type(
          NEW.projection_json,
          '$.reminderAtMs'
        ) = 'null'
        AND json_type(
          NEW.projection_json,
          '$.helpOpensAtMs'
        ) = 'null'
        AND json_array_length(
          json_extract(NEW.projection_json, '$.initialRollovers')
        ) = 0
      )
      OR (
        json_type(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) = 'integer'
        AND json_type(
          NEW.projection_json,
          '$.reminderAtMs'
        ) = 'integer'
        AND json_type(
          NEW.projection_json,
          '$.helpOpensAtMs'
        ) = 'integer'
        AND json_extract(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) >= 0
        AND json_extract(
          NEW.projection_json,
          '$.reminderAtMs'
        ) = json_extract(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) - 259200000
        AND json_extract(
          NEW.projection_json,
          '$.helpOpensAtMs'
        ) BETWEEN 0 AND json_extract(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        )
        AND json_array_length(
          json_extract(NEW.projection_json, '$.initialRollovers')
        ) BETWEEN 1 AND 1000
      )
    )
    AND json_array_length(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) = json_extract(
      NEW.projection_json,
      '$.participatingTeamCount'
    )
    AND (
      (
        NEW.outcome = 'blocked'
        AND json_array_length(
          json_extract(NEW.projection_json, '$.blockers')
        ) >= 1
      )
      OR (
        NEW.outcome = 'succeeded'
        AND json_extract(NEW.projection_json, '$.blockers') = '[]'
      )
    )
  ) THEN RAISE(
    ABORT,
    'readiness attempt must bind the exact active operation, job, and public projection'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(
        NEW.projection_json,
        '$.firstMatchupWeekBefore'
      ) AS projection_json_value
      UNION ALL
      SELECT json_extract(
        NEW.projection_json,
        '$.firstMatchupWeekAfter'
      )
    ) AS week_projection
    WHERE week_projection.projection_json_value IS NOT NULL
      AND NOT (
        (
          SELECT COUNT(*)
          FROM json_each(week_projection.projection_json_value)
        ) = 4
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            week_projection.projection_json_value
          ) AS member
          WHERE member.key NOT IN (
            'weekId', 'sequence', 'startsAtMs', 'version'
          )
        )
        AND json_type(
          week_projection.projection_json_value,
          '$.weekId'
        ) = 'text'
        AND length(json_extract(
          week_projection.projection_json_value,
          '$.weekId'
        )) = 36
        AND json_extract(
          week_projection.projection_json_value,
          '$.weekId'
        ) = lower(json_extract(
          week_projection.projection_json_value,
          '$.weekId'
        ))
        AND json_type(
          week_projection.projection_json_value,
          '$.sequence'
        ) = 'integer'
        AND json_extract(
          week_projection.projection_json_value,
          '$.sequence'
        ) >= 1
        AND json_type(
          week_projection.projection_json_value,
          '$.startsAtMs'
        ) = 'integer'
        AND json_extract(
          week_projection.projection_json_value,
          '$.startsAtMs'
        ) >= 0
        AND json_type(
          week_projection.projection_json_value,
          '$.version'
        ) = 'integer'
        AND json_extract(
          week_projection.projection_json_value,
          '$.version'
        ) >= 1
      )
  ) THEN RAISE(
    ABORT,
    'readiness Week 1 projections require the exact safe shape'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(NEW.projection_json, '$.initialRollovers')
    ) AS rollover
    WHERE rollover.type <> 'object'
      OR (SELECT COUNT(*) FROM json_each(rollover.value)) <> 4
      OR EXISTS (
        SELECT 1
        FROM json_each(rollover.value) AS member
        WHERE member.key NOT IN (
          'sequence',
          'opensAtMs',
          'creationCutoffAtMs',
          'rollsOverAtMs'
        )
      )
      OR json_type(rollover.value, '$.sequence') <> 'integer'
      OR json_type(rollover.value, '$.opensAtMs') <> 'integer'
      OR json_type(
        rollover.value,
        '$.creationCutoffAtMs'
      ) <> 'integer'
      OR json_type(rollover.value, '$.rollsOverAtMs') <> 'integer'
      OR json_extract(rollover.value, '$.sequence') <>
        CAST(rollover.key AS INTEGER) + 1
      OR json_extract(rollover.value, '$.opensAtMs') < 0
      OR json_extract(rollover.value, '$.rollsOverAtMs') <=
        json_extract(rollover.value, '$.opensAtMs')
      OR json_extract(rollover.value, '$.rollsOverAtMs') >
        json_extract(NEW.projection_json, '$.firstMatchupWeekAfter.startsAtMs')
      OR json_extract(
        rollover.value,
        '$.creationCutoffAtMs'
      ) <> max(json_extract(rollover.value, '$.opensAtMs'),
        json_extract(rollover.value, '$.rollsOverAtMs') - 3600000)
      OR (
        CAST(rollover.key AS INTEGER) = 0
        AND json_extract(rollover.value, '$.opensAtMs') <>
          json_extract(
            NEW.projection_json,
            '$.candidateDeadlineAtMs'
          )
      )
      OR (
        CAST(rollover.key AS INTEGER) > 0
        AND json_extract(rollover.value, '$.opensAtMs') <>
          json_extract(
            NEW.projection_json,
            '$.initialRollovers[' ||
              (CAST(rollover.key AS INTEGER) - 1) ||
              '].rollsOverAtMs'
          )
      )
  ) THEN RAISE(
    ABORT,
    'readiness rollover projection requires the exact ordered initial windows'
  ) END;

  SELECT CASE WHEN
    json_type(
      NEW.projection_json,
      '$.priorSeasonRollover'
    ) = 'object'
    AND NOT (
      (
        SELECT COUNT(*)
        FROM json_each(json_extract(
          NEW.projection_json,
          '$.priorSeasonRollover'
        ))
      ) = 5
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(
          NEW.projection_json,
          '$.priorSeasonRollover'
        )) AS member
        WHERE member.key NOT IN (
          'rolloverId',
          'fromSeasonId',
          'toSeasonId',
          'completedAtMs',
          'manifestSha256'
        )
      )
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.rolloverId'
      ) = 'text'
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.fromSeasonId'
      ) = 'text'
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.toSeasonId'
      ) = 'text'
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.toSeasonId'
      ) = NEW.season_id
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.completedAtMs'
      ) = 'integer'
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.completedAtMs'
      ) >= 0
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ) = 'text'
      AND length(json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      )) = 64
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ) = lower(json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ))
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ) NOT GLOB '*[^0-9a-f]*'
    )
  THEN RAISE(
    ABORT,
    'prior-season rollover projection requires the exact safe shape'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) AS projection
    WHERE projection.type <> 'object'
      OR (SELECT COUNT(*) FROM json_each(projection.value)) <> 9
      OR EXISTS (
        SELECT 1
        FROM json_each(projection.value) AS member
        WHERE member.key NOT IN (
          'teamId',
          'team',
          'managerReady',
          'managerAssignmentId',
          'carryoverCount',
          'openForwardSlots',
          'openDefenceSlots',
          'openBenchSlots',
          'structuralConflictCount'
        )
      )
      OR json_type(projection.value, '$.teamId') <> 'text'
      OR json_type(projection.value, '$.team') <> 'object'
      OR (
        SELECT COUNT(*)
        FROM json_each(json_extract(projection.value, '$.team'))
      ) <> 7
      OR EXISTS (
        SELECT 1
        FROM json_each(json_extract(projection.value, '$.team')) AS member
        WHERE member.key NOT IN (
          'teamId',
          'name',
          'primaryColour',
          'secondaryColour',
          'tertiaryColour',
          'patternTemplate',
          'logoReference'
        )
      )
      OR json_extract(projection.value, '$.team.teamId') IS NOT
        json_extract(projection.value, '$.teamId')
      OR json_type(projection.value, '$.team.teamId') <> 'text'
      OR json_type(projection.value, '$.team.name') <> 'text'
      OR json_type(projection.value, '$.team.primaryColour') <> 'text'
      OR json_type(projection.value, '$.team.secondaryColour') <> 'text'
      OR json_type(
        projection.value,
        '$.team.tertiaryColour'
      ) NOT IN ('text', 'null')
      OR json_type(
        projection.value,
        '$.team.patternTemplate'
      ) <> 'text'
      OR json_type(
        projection.value,
        '$.team.logoReference'
      ) NOT IN ('text', 'null')
      OR json_type(projection.value, '$.managerReady') NOT IN (
        'true', 'false'
      )
      OR json_type(
        projection.value,
        '$.managerAssignmentId'
      ) NOT IN ('text', 'null')
      OR (
        json_extract(projection.value, '$.managerReady') = 1
        AND json_type(
          projection.value,
          '$.managerAssignmentId'
        ) <> 'text'
      )
      OR (
        json_extract(projection.value, '$.managerReady') = 0
        AND json_type(
          projection.value,
          '$.managerAssignmentId'
        ) <> 'null'
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(projection.value) AS count_member
        WHERE count_member.key IN (
          'carryoverCount',
          'openForwardSlots',
          'openDefenceSlots',
          'openBenchSlots',
          'structuralConflictCount'
        )
          AND (
            count_member.type <> 'integer'
            OR count_member.atom < 0
          )
      )
  ) THEN RAISE(
    ABORT,
    'readiness team projections require the exact safe shape'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) AS current_projection
    JOIN json_each(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) AS prior_projection
      ON CAST(prior_projection.key AS INTEGER) =
        CAST(current_projection.key AS INTEGER) - 1
    WHERE json_extract(current_projection.value, '$.teamId') <=
      json_extract(prior_projection.value, '$.teamId')
  ) THEN RAISE(
    ABORT,
    'readiness team projections must be unique and stably ordered'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(NEW.projection_json, '$.blockers') AS value
      UNION ALL
      SELECT json_extract(NEW.projection_json, '$.warnings')
    ) AS diagnostics,
    json_each(diagnostics.value) AS diagnostic
    WHERE diagnostic.type <> 'object'
      OR (SELECT COUNT(*) FROM json_each(diagnostic.value)) <> 3
      OR EXISTS (
        SELECT 1
        FROM json_each(diagnostic.value) AS member
        WHERE member.key NOT IN (
          'code', 'message', 'resourceId'
        )
      )
      OR json_type(diagnostic.value, '$.code') <> 'text'
      OR length(json_extract(diagnostic.value, '$.code'))
        NOT BETWEEN 1 AND 100
      OR json_extract(diagnostic.value, '$.code')
        GLOB '*[^A-Z0-9_]*'
      OR json_type(diagnostic.value, '$.message') <> 'text'
      OR length(json_extract(diagnostic.value, '$.message'))
        NOT BETWEEN 1 AND 500
      OR json_type(diagnostic.value, '$.resourceId')
        NOT IN ('text', 'null')
  ) THEN RAISE(
    ABORT,
    'readiness public diagnostics require the exact safe shape'
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
        AND NEW.status = 'running'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_owner IS NOT NULL
        AND NEW.lease_owner = trim(
          NEW.lease_owner,
          char(9) || char(10) || char(11) ||
            char(12) || char(13) || ' '
        )
        AND length(NEW.lease_owner) BETWEEN 1 AND 128
        AND NEW.lease_token IS NOT NULL
        AND NEW.lease_token = trim(
          NEW.lease_token,
          char(9) || char(10) || char(11) ||
            char(12) || char(13) || ' '
        )
        AND length(NEW.lease_token) BETWEEN 1 AND 200
        AND NEW.lease_expires_at_ms IS NOT NULL
        AND OLD.lease_owner IS NOT NULL
        AND OLD.lease_owner = trim(
          OLD.lease_owner,
          char(9) || char(10) || char(11) ||
            char(12) || char(13) || ' '
        )
        AND length(OLD.lease_owner) BETWEEN 1 AND 128
        AND OLD.lease_token IS NOT NULL
        AND OLD.lease_token = trim(
          OLD.lease_token,
          char(9) || char(10) || char(11) ||
            char(12) || char(13) || ' '
        )
        AND length(OLD.lease_token) BETWEEN 1 AND 200
        AND OLD.lease_expires_at_ms IS NOT NULL
        AND OLD.lease_expires_at_ms <= NEW.updated_at_ms
        AND NEW.lease_token <> OLD.lease_token
        AND NEW.lease_expires_at_ms > NEW.updated_at_ms
        AND NEW.blockers_json IS OLD.blockers_json
        AND NEW.matchup_schedule_version_before IS
          OLD.matchup_schedule_version_before
        AND NEW.matchup_schedule_version_after IS
          OLD.matchup_schedule_version_after
        AND NEW.schedule_recovery_id IS OLD.schedule_recovery_id
        AND NEW.created_fad_id IS OLD.created_fad_id
        AND NEW.reminder_job_run_id IS OLD.reminder_job_run_id
        AND NEW.deadline_job_run_id IS OLD.deadline_job_run_id
        AND NEW.cards_opened_activity_id IS
          OLD.cards_opened_activity_id
        AND NEW.cards_opened_outbox_event_id IS
          OLD.cards_opened_outbox_event_id
        AND NEW.started_at_ms IS OLD.started_at_ms
        AND OLD.started_at_ms IS NOT NULL
        AND OLD.next_retry_at_ms IS NULL
        AND NEW.next_retry_at_ms IS NULL
        AND OLD.terminal_at_ms IS NULL
        AND NEW.terminal_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.season_id = NEW.season_id
            AND job_runs.id = NEW.job_run_id
            AND job_runs.job_type = 'fad_readiness'
            AND job_runs.occurrence_key =
              NEW.readiness_occurrence_key
            AND job_runs.scheduled_for_ms = OLD.created_at_ms
            AND job_runs.status = 'running'
            AND job_runs.attempt_count = OLD.attempt_count
            AND job_runs.lease_owner = NEW.lease_owner
            AND job_runs.lease_token = NEW.lease_token
            AND job_runs.lease_expires_at_ms =
              NEW.lease_expires_at_ms
            AND job_runs.started_at_ms = OLD.started_at_ms
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms IS NULL
            AND job_runs.updated_at_ms = NEW.updated_at_ms
            AND job_runs.version = NEW.version
        )
      )
      OR (
        OLD.status = 'blocked'
        AND NEW.status = 'blocked'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_owner IS OLD.lease_owner
        AND NEW.lease_token IS OLD.lease_token
        AND NEW.lease_expires_at_ms IS OLD.lease_expires_at_ms
        AND NEW.blockers_json IS OLD.blockers_json
        AND NEW.matchup_schedule_version_before IS
          OLD.matchup_schedule_version_before
        AND NEW.matchup_schedule_version_after IS
          OLD.matchup_schedule_version_after
        AND NEW.schedule_recovery_id IS OLD.schedule_recovery_id
        AND NEW.created_fad_id IS OLD.created_fad_id
        AND NEW.reminder_job_run_id IS OLD.reminder_job_run_id
        AND NEW.deadline_job_run_id IS OLD.deadline_job_run_id
        AND NEW.cards_opened_activity_id IS
          OLD.cards_opened_activity_id
        AND NEW.cards_opened_outbox_event_id IS
          OLD.cards_opened_outbox_event_id
        AND NEW.started_at_ms IS OLD.started_at_ms
        AND NEW.terminal_at_ms IS OLD.terminal_at_ms
        AND NEW.next_retry_at_ms = NEW.updated_at_ms
        AND (
          EXISTS (
            SELECT 1
            FROM free_agent_draft_readiness_retry_receipts AS receipt
            JOIN job_runs
              ON job_runs.league_id = receipt.league_id
             AND job_runs.season_id = receipt.season_id
             AND job_runs.id = receipt.job_run_id
             AND job_runs.occurrence_key = receipt.occurrence_key
            WHERE receipt.league_id = NEW.league_id
              AND receipt.season_id = NEW.season_id
              AND receipt.readiness_operation_id = NEW.id
              AND receipt.job_run_id = NEW.job_run_id
              AND receipt.occurrence_key =
                NEW.readiness_occurrence_key
              AND receipt.accepted_from_version = OLD.version
              AND receipt.resulting_readiness_version = NEW.version
              AND receipt.retry_attempt_number =
                OLD.attempt_count + 1
              AND receipt.accepted_at_ms = NEW.updated_at_ms
              AND job_runs.job_type = 'fad_readiness'
              AND job_runs.scheduled_for_ms = OLD.created_at_ms
              AND job_runs.status = 'pending'
              AND job_runs.attempt_count = OLD.attempt_count
              AND job_runs.lease_owner IS NULL
              AND job_runs.lease_token IS NULL
              AND job_runs.lease_expires_at_ms IS NULL
              AND job_runs.started_at_ms IS NULL
              AND job_runs.completed_at_ms IS NULL
              AND job_runs.result_json IS NULL
              AND job_runs.last_error_code IS NULL
              AND job_runs.next_attempt_at_ms = NEW.updated_at_ms
              AND job_runs.updated_at_ms = NEW.updated_at_ms
          )
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_readiness_corrective_requeues
              AS correction
            JOIN matchup_schedule_command_results AS command_result
              ON command_result.league_id = correction.league_id
             AND command_result.season_id = correction.season_id
             AND command_result.id =
               correction.matchup_schedule_command_result_id
            JOIN idempotency_requests AS command_request
              ON command_request.league_id = command_result.league_id
             AND command_request.id =
               command_result.idempotency_request_id
            JOIN season_matchup_schedule_generations AS generation
              ON generation.league_id = correction.league_id
             AND generation.season_id = correction.season_id
             AND generation.schedule_operation_id =
               correction.schedule_operation_id
             AND generation.schedule_version =
               correction.schedule_version
            JOIN job_runs
              ON job_runs.league_id = correction.league_id
             AND job_runs.season_id = correction.season_id
             AND job_runs.id = correction.job_run_id
             AND job_runs.occurrence_key =
               correction.occurrence_key
            WHERE correction.league_id = NEW.league_id
              AND correction.season_id = NEW.season_id
              AND correction.readiness_operation_id = NEW.id
              AND correction.job_run_id = NEW.job_run_id
              AND correction.occurrence_key =
                NEW.readiness_occurrence_key
              AND correction.correction_kind =
                'matchup_schedule_created'
              AND correction.attempt_count =
                OLD.attempt_count
              AND correction.readiness_version_before =
                OLD.version
              AND correction.readiness_version_after =
                NEW.version
              AND correction.job_version_after =
                job_runs.version
              AND correction.job_version_after =
                NEW.version
              AND correction.blockers_json =
                OLD.blockers_json
              AND correction.blocked_at_ms =
                OLD.terminal_at_ms
              AND correction.previous_next_retry_at_ms =
                OLD.next_retry_at_ms
              AND correction.requeued_at_ms =
                NEW.updated_at_ms
              AND command_result.action = 'generate'
              AND command_result.idempotency_operation =
                'matchup.schedule.generate.v1'
              AND command_result.new_schedule_operation_id =
                correction.schedule_operation_id
              AND command_result.new_schedule_version =
                correction.schedule_version
              AND command_result.old_schedule_operation_id IS NULL
              AND command_result.old_schedule_version IS NULL
              AND command_result.response_http_status = 201
              AND command_result.response_code =
                'MATCHUP_SCHEDULE_GENERATED'
              AND command_result.result_schema_version = 1
              AND command_result.created_at_ms =
                correction.requeued_at_ms
              AND command_result.version = 1
              AND command_request.operation =
                'matchup.schedule.generate.v1'
              AND command_request.status = 'started'
              AND command_request.result_type IS NULL
              AND command_request.result_id IS NULL
              AND command_request.completed_at_ms IS NULL
              AND generation.status = 'current'
              AND generation.created_at_ms =
                correction.requeued_at_ms
              AND generation.version = 1
              AND job_runs.job_type = 'fad_readiness'
              AND job_runs.scheduled_for_ms = OLD.created_at_ms
              AND job_runs.status = 'pending'
              AND job_runs.attempt_count = OLD.attempt_count
              AND job_runs.lease_owner IS NULL
              AND job_runs.lease_token IS NULL
              AND job_runs.lease_expires_at_ms IS NULL
              AND job_runs.started_at_ms IS NULL
              AND job_runs.completed_at_ms IS NULL
              AND job_runs.result_json IS NULL
              AND job_runs.last_error_code IS NULL
              AND job_runs.next_attempt_at_ms =
                NEW.updated_at_ms
              AND job_runs.updated_at_ms =
                NEW.updated_at_ms
          )
        )
      )
      OR (
        OLD.status = 'running'
        AND NEW.status = 'blocked'
        AND NEW.attempt_count = OLD.attempt_count
        AND json_array_length(NEW.blockers_json) >= 1
        AND NEW.created_fad_id IS NULL
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_readiness_attempts AS attempt
          WHERE attempt.league_id = NEW.league_id
            AND attempt.season_id = NEW.season_id
            AND attempt.readiness_operation_id = NEW.id
            AND attempt.job_run_id = NEW.job_run_id
            AND attempt.attempt_number = NEW.attempt_count
            AND attempt.observed_readiness_version = OLD.version
            AND attempt.outcome = 'blocked'
            AND attempt.recorded_at_ms = NEW.updated_at_ms
            AND json_array_length(
              json_extract(attempt.projection_json, '$.blockers')
            ) = json_array_length(NEW.blockers_json)
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(NEW.blockers_json) AS internal_blocker
              LEFT JOIN json_each(
                json_extract(attempt.projection_json, '$.blockers')
              ) AS public_blocker
                ON public_blocker.key = internal_blocker.key
              WHERE public_blocker.key IS NULL
                OR json_extract(public_blocker.value, '$.code') IS NOT
                  json_extract(internal_blocker.value, '$.code')
                OR json_extract(public_blocker.value, '$.message') IS NOT
                  json_extract(internal_blocker.value, '$.message')
                OR json_extract(public_blocker.value, '$.resourceId') IS NOT
                  json_extract(internal_blocker.value, '$.resourceId')
            )
        )
      )
      OR (
        OLD.status = 'running'
        AND NEW.status = 'succeeded'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.blockers_json = '[]'
        AND NEW.created_fad_id IS NOT NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_readiness_attempts AS attempt
          WHERE attempt.league_id = NEW.league_id
            AND attempt.season_id = NEW.season_id
            AND attempt.readiness_operation_id = NEW.id
            AND attempt.job_run_id = NEW.job_run_id
            AND attempt.attempt_number = NEW.attempt_count
            AND attempt.observed_readiness_version = OLD.version
            AND attempt.outcome = 'succeeded'
            AND attempt.recorded_at_ms = NEW.updated_at_ms
            AND json_extract(
              attempt.projection_json,
              '$.blockers'
            ) = '[]'
        )
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
                AND free_agent_draft_rollovers.sequence BETWEEN 1 AND COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7)
            ) = COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7)
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
          FROM outbox_events AS fad_event
          WHERE fad_event.league_id = NEW.league_id
            AND fad_event.id = NEW.cards_opened_outbox_event_id
            AND fad_event.event_type = 'free_agent_draft.changed'
            AND fad_event.aggregate_type = 'free_agent_draft'
            AND fad_event.aggregate_id = NEW.created_fad_id
            AND fad_event.available_at_ms = NEW.terminal_at_ms
            AND fad_event.created_at_ms = NEW.terminal_at_ms
            AND fad_event.status = 'pending'
            AND fad_event.attempt_count = 0
            AND fad_event.published_at_ms IS NULL
            AND fad_event.last_error_code IS NULL
            AND fad_event.updated_at_ms = NEW.terminal_at_ms
            AND fad_event.version = 1
            AND json_valid(fad_event.payload_json) = 1
            AND json_type(fad_event.payload_json) = 'object'
            AND (SELECT COUNT(*) FROM json_each(fad_event.payload_json)) = 8
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fad_event.payload_json) AS member
              WHERE member.key NOT IN (
                'eventId', 'type', 'leagueId', 'resourceId',
                'version', 'reasonCode', 'occurredAt', 'related'
              )
            )
            AND json_type(fad_event.payload_json, '$.eventId') = 'text'
            AND json_extract(fad_event.payload_json, '$.eventId') = fad_event.id
            AND json_type(fad_event.payload_json, '$.type') = 'text'
            AND json_extract(fad_event.payload_json, '$.type') = 'free_agent_draft.changed'
            AND json_type(fad_event.payload_json, '$.leagueId') = 'text'
            AND json_extract(fad_event.payload_json, '$.leagueId') = fad_event.league_id
            AND json_type(fad_event.payload_json, '$.resourceId') = 'text'
            AND json_extract(fad_event.payload_json, '$.resourceId') = NEW.created_fad_id
            AND json_type(fad_event.payload_json, '$.version') = 'integer'
            AND json_extract(fad_event.payload_json, '$.version') = 1
            AND json_type(fad_event.payload_json, '$.reasonCode') = 'text'
            AND json_extract(fad_event.payload_json, '$.reasonCode') = 'cards_opened'
            AND json_type(fad_event.payload_json, '$.occurredAt') = 'integer'
            AND json_extract(fad_event.payload_json, '$.occurredAt') = NEW.terminal_at_ms
            AND json_type(fad_event.payload_json, '$.related') = 'object'
            AND (SELECT COUNT(*) FROM json_each(fad_event.payload_json, '$.related')) = 8
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fad_event.payload_json, '$.related') AS related_member
              WHERE related_member.key NOT IN (
                'fadId', 'teamId', 'cardId', 'allocationId',
                'auctionId', 'recoveryId', 'nominationQueueId',
                'scheduleRecoveryOperationId'
              )
            )
            AND json_type(fad_event.payload_json, '$.related.fadId') = 'text'
            AND json_extract(fad_event.payload_json, '$.related.fadId') = NEW.created_fad_id
            AND json_type(fad_event.payload_json, '$.related.teamId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.cardId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.allocationId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.auctionId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.recoveryId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.nominationQueueId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
            AND (
              SELECT COUNT(*) FROM outbox_event_audiences AS audience
              WHERE audience.league_id = fad_event.league_id
                AND audience.outbox_event_id = fad_event.id
            ) = 1
            AND EXISTS (
              SELECT 1 FROM outbox_event_audiences AS audience
              WHERE audience.league_id = fad_event.league_id
                AND audience.outbox_event_id = fad_event.id
                AND audience.audience_kind = 'league'
                AND audience.team_id IS NULL
                AND audience.user_id IS NULL
                AND audience.created_at_ms = NEW.terminal_at_ms
            )
        )
        AND (
          SELECT COUNT(*)
          FROM outbox_events AS fad_event
          WHERE fad_event.league_id = NEW.league_id
            AND fad_event.event_type = 'free_agent_draft.changed'
            AND fad_event.aggregate_type = 'free_agent_draft'
            AND fad_event.aggregate_id = NEW.created_fad_id
            AND fad_event.available_at_ms = NEW.terminal_at_ms
            AND fad_event.created_at_ms = NEW.terminal_at_ms
            AND fad_event.status = 'pending'
            AND fad_event.attempt_count = 0
            AND fad_event.published_at_ms IS NULL
            AND fad_event.last_error_code IS NULL
            AND fad_event.updated_at_ms = NEW.terminal_at_ms
            AND fad_event.version = 1
            AND json_valid(fad_event.payload_json) = 1
            AND json_type(fad_event.payload_json) = 'object'
            AND (SELECT COUNT(*) FROM json_each(fad_event.payload_json)) = 8
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fad_event.payload_json) AS member
              WHERE member.key NOT IN (
                'eventId', 'type', 'leagueId', 'resourceId',
                'version', 'reasonCode', 'occurredAt', 'related'
              )
            )
            AND json_type(fad_event.payload_json, '$.eventId') = 'text'
            AND json_extract(fad_event.payload_json, '$.eventId') = fad_event.id
            AND json_type(fad_event.payload_json, '$.type') = 'text'
            AND json_extract(fad_event.payload_json, '$.type') = 'free_agent_draft.changed'
            AND json_type(fad_event.payload_json, '$.leagueId') = 'text'
            AND json_extract(fad_event.payload_json, '$.leagueId') = fad_event.league_id
            AND json_type(fad_event.payload_json, '$.resourceId') = 'text'
            AND json_extract(fad_event.payload_json, '$.resourceId') = NEW.created_fad_id
            AND json_type(fad_event.payload_json, '$.version') = 'integer'
            AND json_extract(fad_event.payload_json, '$.version') = 1
            AND json_type(fad_event.payload_json, '$.reasonCode') = 'text'
            AND json_extract(fad_event.payload_json, '$.reasonCode') = 'cards_opened'
            AND json_type(fad_event.payload_json, '$.occurredAt') = 'integer'
            AND json_extract(fad_event.payload_json, '$.occurredAt') = NEW.terminal_at_ms
            AND json_type(fad_event.payload_json, '$.related') = 'object'
            AND (SELECT COUNT(*) FROM json_each(fad_event.payload_json, '$.related')) = 8
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fad_event.payload_json, '$.related') AS related_member
              WHERE related_member.key NOT IN (
                'fadId', 'teamId', 'cardId', 'allocationId',
                'auctionId', 'recoveryId', 'nominationQueueId',
                'scheduleRecoveryOperationId'
              )
            )
            AND json_type(fad_event.payload_json, '$.related.fadId') = 'text'
            AND json_extract(fad_event.payload_json, '$.related.fadId') = NEW.created_fad_id
            AND json_type(fad_event.payload_json, '$.related.teamId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.cardId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.allocationId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.auctionId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.recoveryId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.nominationQueueId') = 'null'
            AND json_type(fad_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
            AND (
              SELECT COUNT(*) FROM outbox_event_audiences AS audience
              WHERE audience.league_id = fad_event.league_id
                AND audience.outbox_event_id = fad_event.id
            ) = 1
            AND EXISTS (
              SELECT 1 FROM outbox_event_audiences AS audience
              WHERE audience.league_id = fad_event.league_id
                AND audience.outbox_event_id = fad_event.id
                AND audience.audience_kind = 'league'
                AND audience.team_id IS NULL
                AND audience.user_id IS NULL
                AND audience.created_at_ms = NEW.terminal_at_ms
            )
        ) = 1
        AND NOT EXISTS (
          SELECT 1
          FROM outbox_events AS legacy_event
          WHERE legacy_event.league_id = NEW.league_id
            AND legacy_event.event_type = 'fad_cards_opened'
            AND legacy_event.aggregate_type = 'free_agent_draft'
            AND legacy_event.aggregate_id = NEW.created_fad_id
            AND legacy_event.created_at_ms = NEW.terminal_at_ms
        )
        AND (
          SELECT COUNT(*)
          FROM outbox_events AS activity_event
          WHERE activity_event.league_id = NEW.league_id
            AND activity_event.event_type = 'activity.created'
            AND activity_event.aggregate_type = 'league_activity'
            AND activity_event.aggregate_id = NEW.cards_opened_activity_id
            AND activity_event.available_at_ms = NEW.terminal_at_ms
            AND activity_event.created_at_ms = NEW.terminal_at_ms
            AND activity_event.status = 'pending'
            AND activity_event.attempt_count = 0
            AND activity_event.published_at_ms IS NULL
            AND activity_event.last_error_code IS NULL
            AND activity_event.updated_at_ms = NEW.terminal_at_ms
            AND activity_event.version = 1
            AND json_valid(activity_event.payload_json) = 1
            AND json_type(activity_event.payload_json) = 'object'
            AND (SELECT COUNT(*) FROM json_each(activity_event.payload_json)) = 8
            AND NOT EXISTS (
              SELECT 1 FROM json_each(activity_event.payload_json) AS member
              WHERE member.key NOT IN (
                'eventId', 'type', 'leagueId', 'resourceId',
                'version', 'reasonCode', 'occurredAt', 'related'
              )
            )
            AND json_type(activity_event.payload_json, '$.eventId') = 'text'
            AND json_extract(activity_event.payload_json, '$.eventId') = activity_event.id
            AND json_type(activity_event.payload_json, '$.type') = 'text'
            AND json_extract(activity_event.payload_json, '$.type') = 'activity.created'
            AND json_type(activity_event.payload_json, '$.leagueId') = 'text'
            AND json_extract(activity_event.payload_json, '$.leagueId') = activity_event.league_id
            AND json_type(activity_event.payload_json, '$.resourceId') = 'text'
            AND json_extract(activity_event.payload_json, '$.resourceId') = NEW.cards_opened_activity_id
            AND json_type(activity_event.payload_json, '$.version') = 'integer'
            AND json_extract(activity_event.payload_json, '$.version') = 1
            AND json_type(activity_event.payload_json, '$.reasonCode') = 'text'
            AND json_extract(activity_event.payload_json, '$.reasonCode') = 'cards_opened'
            AND json_type(activity_event.payload_json, '$.occurredAt') = 'integer'
            AND json_extract(activity_event.payload_json, '$.occurredAt') = NEW.terminal_at_ms
            AND json_type(activity_event.payload_json, '$.related') = 'object'
            AND (SELECT COUNT(*) FROM json_each(activity_event.payload_json, '$.related')) = 8
            AND NOT EXISTS (
              SELECT 1 FROM json_each(activity_event.payload_json, '$.related') AS related_member
              WHERE related_member.key NOT IN (
                'fadId', 'teamId', 'cardId', 'allocationId',
                'auctionId', 'recoveryId', 'nominationQueueId',
                'scheduleRecoveryOperationId'
              )
            )
            AND json_type(activity_event.payload_json, '$.related.fadId') = 'text'
            AND json_extract(activity_event.payload_json, '$.related.fadId') = NEW.created_fad_id
            AND json_type(activity_event.payload_json, '$.related.teamId') = 'null'
            AND json_type(activity_event.payload_json, '$.related.cardId') = 'null'
            AND json_type(activity_event.payload_json, '$.related.allocationId') = 'null'
            AND json_type(activity_event.payload_json, '$.related.auctionId') = 'null'
            AND json_type(activity_event.payload_json, '$.related.recoveryId') = 'null'
            AND json_type(activity_event.payload_json, '$.related.nominationQueueId') = 'null'
            AND json_type(activity_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
            AND (
              SELECT COUNT(*) FROM outbox_event_audiences AS audience
              WHERE audience.league_id = activity_event.league_id
                AND audience.outbox_event_id = activity_event.id
            ) = 1
            AND EXISTS (
              SELECT 1 FROM outbox_event_audiences AS audience
              WHERE audience.league_id = activity_event.league_id
                AND audience.outbox_event_id = activity_event.id
                AND audience.audience_kind = 'league'
                AND audience.team_id IS NULL
                AND audience.user_id IS NULL
                AND audience.created_at_ms = NEW.terminal_at_ms
            )
        ) = 1
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_cards AS opened_card
          WHERE opened_card.league_id = NEW.league_id
            AND opened_card.season_id = NEW.season_id
            AND opened_card.fad_id = NEW.created_fad_id
            AND (
              SELECT COUNT(*)
              FROM outbox_events AS card_event
              WHERE card_event.league_id = NEW.league_id
              AND card_event.event_type = 'candidate_card.changed'
              AND card_event.aggregate_type = 'candidate_card'
              AND card_event.aggregate_id = opened_card.id
              AND card_event.available_at_ms = NEW.terminal_at_ms
              AND card_event.created_at_ms = NEW.terminal_at_ms
              AND card_event.status = 'pending'
              AND card_event.attempt_count = 0
              AND card_event.published_at_ms IS NULL
              AND card_event.last_error_code IS NULL
              AND card_event.updated_at_ms = NEW.terminal_at_ms
              AND card_event.version = 1
              AND json_valid(card_event.payload_json) = 1
              AND json_type(card_event.payload_json) = 'object'
              AND (SELECT COUNT(*) FROM json_each(card_event.payload_json)) = 8
              AND NOT EXISTS (
                SELECT 1 FROM json_each(card_event.payload_json) AS member
                WHERE member.key NOT IN (
                  'eventId', 'type', 'leagueId', 'resourceId',
                  'version', 'reasonCode', 'occurredAt', 'related'
                )
              )
              AND json_type(card_event.payload_json, '$.eventId') = 'text'
              AND json_extract(card_event.payload_json, '$.eventId') = card_event.id
              AND json_type(card_event.payload_json, '$.type') = 'text'
              AND json_extract(card_event.payload_json, '$.type') = 'candidate_card.changed'
              AND json_type(card_event.payload_json, '$.leagueId') = 'text'
              AND json_extract(card_event.payload_json, '$.leagueId') = card_event.league_id
              AND json_type(card_event.payload_json, '$.resourceId') = 'text'
              AND json_extract(card_event.payload_json, '$.resourceId') = opened_card.id
              AND json_type(card_event.payload_json, '$.version') = 'integer'
              AND json_extract(card_event.payload_json, '$.version') = 1
              AND json_type(card_event.payload_json, '$.reasonCode') = 'text'
              AND json_extract(card_event.payload_json, '$.reasonCode') = 'card_changed'
              AND json_type(card_event.payload_json, '$.occurredAt') = 'integer'
              AND json_extract(card_event.payload_json, '$.occurredAt') = NEW.terminal_at_ms
              AND json_type(card_event.payload_json, '$.related') = 'object'
              AND (SELECT COUNT(*) FROM json_each(card_event.payload_json, '$.related')) = 8
              AND NOT EXISTS (
                SELECT 1 FROM json_each(card_event.payload_json, '$.related') AS related_member
                WHERE related_member.key NOT IN (
                  'fadId', 'teamId', 'cardId', 'allocationId',
                  'auctionId', 'recoveryId', 'nominationQueueId',
                  'scheduleRecoveryOperationId'
                )
              )
              AND json_type(card_event.payload_json, '$.related.fadId') = 'text'
              AND json_extract(card_event.payload_json, '$.related.fadId') = NEW.created_fad_id
              AND json_type(card_event.payload_json, '$.related.teamId') = 'text'
              AND json_extract(card_event.payload_json, '$.related.teamId') = opened_card.team_id
              AND json_type(card_event.payload_json, '$.related.cardId') = 'text'
              AND json_extract(card_event.payload_json, '$.related.cardId') = opened_card.id
              AND json_type(card_event.payload_json, '$.related.allocationId') = 'null'
              AND json_type(card_event.payload_json, '$.related.auctionId') = 'null'
              AND json_type(card_event.payload_json, '$.related.recoveryId') = 'null'
              AND json_type(card_event.payload_json, '$.related.nominationQueueId') = 'null'
              AND json_type(card_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
              AND (
                SELECT COUNT(*) FROM outbox_event_audiences AS audience
                WHERE audience.league_id = card_event.league_id
                  AND audience.outbox_event_id = card_event.id
              ) = 1
              AND EXISTS (
                SELECT 1 FROM outbox_event_audiences AS audience
                WHERE audience.league_id = card_event.league_id
                  AND audience.outbox_event_id = card_event.id
                  AND audience.audience_kind = 'team'
                  AND audience.team_id = opened_card.team_id
                  AND audience.user_id IS NULL
                  AND audience.created_at_ms = NEW.terminal_at_ms
              )
            ) <> 1
        )
        AND (
          SELECT COUNT(*)
          FROM outbox_events AS card_event
          WHERE card_event.league_id = NEW.league_id
            AND card_event.event_type = 'candidate_card.changed'
            AND card_event.created_at_ms = NEW.terminal_at_ms
            AND json_valid(card_event.payload_json) = 1
            AND json_extract(card_event.payload_json, '$.reasonCode') =
              'card_changed'
            AND json_extract(card_event.payload_json, '$.related.fadId') =
              NEW.created_fad_id
        ) = (
          SELECT COUNT(*)
          FROM candidate_cards AS opened_card
          WHERE opened_card.league_id = NEW.league_id
            AND opened_card.season_id = NEW.season_id
            AND opened_card.fad_id = NEW.created_fad_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_teams
          JOIN candidate_cards AS opened_card
            ON opened_card.league_id = free_agent_draft_teams.league_id
           AND opened_card.season_id = free_agent_draft_teams.season_id
           AND opened_card.fad_id = free_agent_draft_teams.fad_id
           AND opened_card.team_id = free_agent_draft_teams.team_id
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
          WHERE free_agent_draft_teams.league_id = NEW.league_id
            AND free_agent_draft_teams.fad_id = NEW.created_fad_id
            AND team_manager_assignments.status = 'accepted'
            AND team_manager_assignments.ended_at_ms IS NULL
            AND league_memberships.status = 'active'
            AND (
              SELECT COUNT(*)
              FROM notifications AS card_notification
              JOIN outbox_events AS notification_event
                ON notification_event.league_id =
                    card_notification.league_id
               AND notification_event.aggregate_id =
                    card_notification.id
              WHERE card_notification.league_id = NEW.league_id
                AND card_notification.user_id =
                  team_manager_assignments.user_id
                AND card_notification.event_type = 'fad_cards_opened'
                AND card_notification.related_feature = 'free_agent_draft'
                AND card_notification.related_record_id = NEW.created_fad_id
                AND card_notification.created_at_ms = NEW.terminal_at_ms
                AND card_notification.version = 1
                AND json_valid(card_notification.message_data_json) = 1
                AND json_extract(card_notification.message_data_json, '$.leagueId') =
                  NEW.league_id
                AND json_extract(card_notification.message_data_json, '$.seasonId') =
                  NEW.season_id
                AND json_extract(card_notification.message_data_json, '$.fadId') =
                  NEW.created_fad_id
                AND json_extract(card_notification.message_data_json, '$.teamId') =
                  free_agent_draft_teams.team_id
                AND json_extract(card_notification.message_data_json, '$.cardId') =
                  opened_card.id
              AND notification_event.event_type = 'notification.created'
              AND notification_event.aggregate_type = 'notification'
              AND notification_event.aggregate_id = card_notification.id
              AND notification_event.available_at_ms = NEW.terminal_at_ms
              AND notification_event.created_at_ms = NEW.terminal_at_ms
              AND notification_event.status = 'pending'
              AND notification_event.attempt_count = 0
              AND notification_event.published_at_ms IS NULL
              AND notification_event.last_error_code IS NULL
              AND notification_event.updated_at_ms = NEW.terminal_at_ms
              AND notification_event.version = 1
              AND json_valid(notification_event.payload_json) = 1
              AND json_type(notification_event.payload_json) = 'object'
              AND (SELECT COUNT(*) FROM json_each(notification_event.payload_json)) = 8
              AND NOT EXISTS (
                SELECT 1 FROM json_each(notification_event.payload_json) AS member
                WHERE member.key NOT IN (
                  'eventId', 'type', 'leagueId', 'resourceId',
                  'version', 'reasonCode', 'occurredAt', 'related'
                )
              )
              AND json_type(notification_event.payload_json, '$.eventId') = 'text'
              AND json_extract(notification_event.payload_json, '$.eventId') = notification_event.id
              AND json_type(notification_event.payload_json, '$.type') = 'text'
              AND json_extract(notification_event.payload_json, '$.type') = 'notification.created'
              AND json_type(notification_event.payload_json, '$.leagueId') = 'text'
              AND json_extract(notification_event.payload_json, '$.leagueId') = notification_event.league_id
              AND json_type(notification_event.payload_json, '$.resourceId') = 'text'
              AND json_extract(notification_event.payload_json, '$.resourceId') = card_notification.id
              AND json_type(notification_event.payload_json, '$.version') = 'integer'
              AND json_extract(notification_event.payload_json, '$.version') = 1
              AND json_type(notification_event.payload_json, '$.reasonCode') = 'text'
              AND json_extract(notification_event.payload_json, '$.reasonCode') = 'cards_opened'
              AND json_type(notification_event.payload_json, '$.occurredAt') = 'integer'
              AND json_extract(notification_event.payload_json, '$.occurredAt') = NEW.terminal_at_ms
              AND json_type(notification_event.payload_json, '$.related') = 'object'
              AND (SELECT COUNT(*) FROM json_each(notification_event.payload_json, '$.related')) = 8
              AND NOT EXISTS (
                SELECT 1 FROM json_each(notification_event.payload_json, '$.related') AS related_member
                WHERE related_member.key NOT IN (
                  'fadId', 'teamId', 'cardId', 'allocationId',
                  'auctionId', 'recoveryId', 'nominationQueueId',
                  'scheduleRecoveryOperationId'
                )
              )
              AND json_type(notification_event.payload_json, '$.related.fadId') = 'text'
              AND json_extract(notification_event.payload_json, '$.related.fadId') = NEW.created_fad_id
              AND json_type(notification_event.payload_json, '$.related.teamId') = 'text'
              AND json_extract(notification_event.payload_json, '$.related.teamId') = free_agent_draft_teams.team_id
              AND json_type(notification_event.payload_json, '$.related.cardId') = 'text'
              AND json_extract(notification_event.payload_json, '$.related.cardId') = opened_card.id
              AND json_type(notification_event.payload_json, '$.related.allocationId') = 'null'
              AND json_type(notification_event.payload_json, '$.related.auctionId') = 'null'
              AND json_type(notification_event.payload_json, '$.related.recoveryId') = 'null'
              AND json_type(notification_event.payload_json, '$.related.nominationQueueId') = 'null'
              AND json_type(notification_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
              AND (
                SELECT COUNT(*) FROM outbox_event_audiences AS audience
                WHERE audience.league_id = notification_event.league_id
                  AND audience.outbox_event_id = notification_event.id
              ) = 1
              AND EXISTS (
                SELECT 1 FROM outbox_event_audiences AS audience
                WHERE audience.league_id = notification_event.league_id
                  AND audience.outbox_event_id = notification_event.id
                  AND audience.audience_kind = 'user'
                  AND audience.team_id IS NULL
                  AND audience.user_id = team_manager_assignments.user_id
                  AND audience.created_at_ms = NEW.terminal_at_ms
              )
            ) <> 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM notifications AS card_notification
          WHERE card_notification.league_id = NEW.league_id
            AND card_notification.event_type = 'fad_cards_opened'
            AND card_notification.related_feature = 'free_agent_draft'
            AND card_notification.related_record_id = NEW.created_fad_id
            AND card_notification.created_at_ms = NEW.terminal_at_ms
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_teams
              JOIN candidate_cards AS opened_card
                ON opened_card.league_id = free_agent_draft_teams.league_id
               AND opened_card.season_id = free_agent_draft_teams.season_id
               AND opened_card.fad_id = free_agent_draft_teams.fad_id
               AND opened_card.team_id = free_agent_draft_teams.team_id
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
                  card_notification.league_id
                AND free_agent_draft_teams.fad_id = NEW.created_fad_id
                AND team_manager_assignments.user_id =
                  card_notification.user_id
                AND team_manager_assignments.status = 'accepted'
                AND team_manager_assignments.ended_at_ms IS NULL
                AND league_memberships.status = 'active'
                AND json_extract(card_notification.message_data_json, '$.teamId') =
                  free_agent_draft_teams.team_id
                AND json_extract(card_notification.message_data_json, '$.cardId') =
                  opened_card.id
            )
        )
        AND (
          SELECT COUNT(*)
          FROM outbox_events AS notification_event
          WHERE notification_event.league_id = NEW.league_id
            AND notification_event.event_type = 'notification.created'
            AND notification_event.created_at_ms = NEW.terminal_at_ms
            AND json_valid(notification_event.payload_json) = 1
            AND json_extract(notification_event.payload_json, '$.reasonCode') =
              'cards_opened'
            AND json_extract(
                  notification_event.payload_json,
                  '$.related.fadId'
                ) = NEW.created_fad_id
        ) = (
          SELECT COUNT(*)
          FROM notifications AS card_notification
          WHERE card_notification.league_id = NEW.league_id
            AND card_notification.event_type = 'fad_cards_opened'
            AND card_notification.related_feature = 'free_agent_draft'
            AND card_notification.related_record_id = NEW.created_fad_id
            AND card_notification.created_at_ms = NEW.terminal_at_ms
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD readiness must open every team and seven windows or none'
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
    AND NEW.nomination_queue_id IS OLD.nomination_queue_id
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
                AND auction_contexts.source_kind = 'fad_restricted'
            )
          )
          OR (
            NEW.kind = 'queued_nomination_activation'
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
                  NEW.nomination_queue_id
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
                AND auction_contexts.source_kind = 'fad_open_rapid'
                AND auction_contexts.fad_origin =
                  'restricted_no_improvement_fallback'
            )
          )
          OR (
            NEW.kind IN (
              'restricted_activation',
              'fallback_activation'
            )
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations AS allocation
              JOIN auctions AS auction
                ON auction.league_id = allocation.league_id
               AND auction.id = NEW.auction_id
              JOIN auction_contexts AS context
                ON context.league_id = auction.league_id
               AND context.season_id = auction.season_id
               AND context.auction_id = auction.id
               AND context.fad_id = allocation.fad_id
               AND context.fad_allocation_id = allocation.id
              JOIN auction_resolutions AS resolution
                ON resolution.league_id = auction.league_id
               AND resolution.season_id = auction.season_id
               AND resolution.auction_id = auction.id
              JOIN free_agent_draft_draws AS draw
                ON draw.league_id = context.league_id
               AND draw.season_id = context.season_id
               AND draw.fad_id = context.fad_id
               AND draw.allocation_id = context.fad_allocation_id
               AND draw.auction_id = context.auction_id
              JOIN free_agent_draft_allocation_events AS event
                ON event.league_id = allocation.league_id
               AND event.season_id = allocation.season_id
               AND event.fad_id = allocation.fad_id
               AND event.allocation_id = allocation.id
               AND event.allocation_version = allocation.version
               AND event.player_id = allocation.player_id
              JOIN commissioner_corrections AS correction
                ON correction.league_id = event.league_id
               AND correction.season_id = event.season_id
               AND correction.id = event.correction_id
              JOIN job_runs AS job
                ON job.league_id = NEW.league_id
               AND job.season_id = NEW.season_id
               AND job.id = NEW.job_run_id
              WHERE allocation.league_id = NEW.league_id
                AND allocation.season_id = NEW.season_id
                AND allocation.fad_id = NEW.fad_id
                AND allocation.id = NEW.allocation_id
                AND allocation.player_id = NEW.player_id
                AND allocation.status IN (
                  'automatic_award',
                  'no_valid_offer'
                )
                AND allocation.decision_code = 'corrected'
                AND allocation.accounted_at_ms = NEW.resolved_at_ms
                AND allocation.last_error_code IS NULL
                AND context.fad_rollover_id = NEW.rollover_id
                AND (
                  (
                    NEW.kind = 'restricted_activation'
                    AND allocation.restricted_auction_id =
                        NEW.auction_id
                    AND context.source_kind = 'fad_restricted'
                    AND context.fad_origin =
                      'candidate_tie_restricted'
                    AND job.job_type =
                      'fad_restricted_activation'
                  )
                  OR (
                    NEW.kind = 'fallback_activation'
                    AND allocation.fallback_open_auction_id =
                        NEW.auction_id
                    AND context.source_kind = 'fad_open_rapid'
                    AND context.fad_origin =
                      'restricted_no_improvement_fallback'
                    AND job.job_type =
                      'fad_fallback_activation'
                  )
                )
                AND auction.status = 'cancelled'
                AND auction.updated_at_ms = NEW.resolved_at_ms
                AND resolution.status = 'cancelled'
                AND resolution.outcome_code = 'recovered'
                AND resolution.trigger_type = 'commissioner'
                AND resolution.triggered_by_user_id =
                    NEW.resolved_by_user_id
                AND resolution.resolved_at_ms = NEW.resolved_at_ms
                AND draw.version = 2
                AND draw.revealed_at_ms = NEW.resolved_at_ms
                AND draw.ordered_tied_bid_ids_json = '[]'
                AND draw.ordered_tied_team_ids_json = '[]'
                AND draw.rejection_counter IS NULL
                AND draw.selected_index IS NULL
                AND draw.selected_bid_id IS NULL
                AND draw.selected_team_id IS NULL
                AND draw.selected_digest_hex IS NULL
                AND event.event_kind = 'correction_applied'
                AND event.decision_code = 'corrected'
                AND event.resulting_allocation_status =
                    allocation.status
                AND event.auction_id IS
                    allocation.restricted_auction_id
                AND event.actor_user_id = NEW.resolved_by_user_id
                AND event.actor_membership_id =
                    NEW.resolved_by_membership_id
                AND event.actor_authority = NEW.resolved_authority
                AND event.occurred_at_ms = NEW.resolved_at_ms
                AND correction.feature =
                    'free_agent_draft_allocation'
                AND correction.feature_record_id = allocation.id
                AND correction.actor_user_id =
                    NEW.resolved_by_user_id
                AND correction.corrected_at_ms = NEW.resolved_at_ms
                AND NEW.created_by_operation_id = job.id
                AND job.status IN (
                  'succeeded',
                  'failed',
                  'skipped'
                )
                AND job.attempt_count >= 1
                AND job.lease_owner IS NULL
                AND job.lease_token IS NULL
                AND job.lease_expires_at_ms IS NULL
                AND job.completed_at_ms IS NOT NULL
                AND job.completed_at_ms <= NEW.resolved_at_ms
                AND job.updated_at_ms <= NEW.resolved_at_ms
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
                 AND free_agent_draft_draws.auction_id = auctions.id
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
                      AND auction_resolutions.auction_id = auctions.id
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
                    'automatic_award',
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
              WHERE free_agent_draft_rollovers.league_id = NEW.league_id
                AND free_agent_draft_rollovers.id = NEW.rollover_id
                AND free_agent_draft_rollovers.status = 'completed'
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
                    AND free_agent_draft_rollovers.fad_id = NEW.fad_id
                    AND free_agent_draft_rollovers.status <> 'completed'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_nomination_queue
                  WHERE free_agent_draft_nomination_queue.league_id =
                      NEW.league_id
                    AND free_agent_draft_nomination_queue.fad_id =
                      NEW.fad_id
                    AND free_agent_draft_nomination_queue.status = 'queued'
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
        FROM free_agent_draft_player_allocations AS allocation
        WHERE allocation.league_id = NEW.league_id
          AND allocation.season_id = NEW.season_id
          AND allocation.fad_id = NEW.fad_id
          AND allocation.id = NEW.allocation_id
          AND allocation.player_id = NEW.player_id
      )
    )
    AND (
      NEW.rollover_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_rollovers AS rollover
        WHERE rollover.league_id = NEW.league_id
          AND rollover.season_id = NEW.season_id
          AND rollover.fad_id = NEW.fad_id
          AND rollover.id = NEW.rollover_id
      )
    )
    AND (
      NEW.auction_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM auction_contexts AS context
        JOIN auctions AS auction
          ON auction.league_id = context.league_id
         AND auction.season_id = context.season_id
         AND auction.id = context.auction_id
        WHERE context.league_id = NEW.league_id
          AND context.season_id = NEW.season_id
          AND context.fad_id = NEW.fad_id
          AND context.auction_id = NEW.auction_id
          AND auction.player_id = NEW.player_id
      )
    )
    AND (
      (
        NEW.job_run_id IS NULL
        AND (
          NEW.created_by_operation_id IS NULL
          OR (
            length(NEW.created_by_operation_id) = 36
            AND NEW.created_by_operation_id =
              lower(NEW.created_by_operation_id)
          )
        )
      )
      OR EXISTS (
        SELECT 1
        FROM job_runs AS job
        WHERE job.league_id = NEW.league_id
          AND job.season_id = NEW.season_id
          AND job.id = NEW.job_run_id
          AND NEW.created_by_operation_id = job.id
      )
    )
    AND (
      (
        NEW.kind = 'queued_nomination_activation'
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_nomination_queue AS queue
          WHERE queue.league_id = NEW.league_id
            AND queue.season_id = NEW.season_id
            AND queue.fad_id = NEW.fad_id
            AND queue.id = NEW.nomination_queue_id
            AND queue.player_id = NEW.player_id
            AND queue.target_opening_rollover_id = NEW.rollover_id
        )
      )
      OR (
        NEW.kind <> 'queued_nomination_activation'
        AND NEW.nomination_queue_id IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery must preserve exact causal resources and operation identity'
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
      OR (
        OLD.status = 'recovery_required'
        AND NEW.status = 'completed'
        AND NEW.processing_job_run_id IS
          OLD.processing_job_run_id
        AND NEW.processing_started_at_ms IS
          OLD.processing_started_at_ms
        AND NEW.completed_at_ms = NEW.updated_at_ms
        AND NEW.completed_at_ms > OLD.completed_at_ms
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM job_runs AS job
          JOIN free_agent_draft_recoveries AS recovery
            ON recovery.league_id = job.league_id
           AND recovery.season_id = job.season_id
           AND recovery.fad_id = NEW.fad_id
           AND recovery.rollover_id = NEW.id
           AND recovery.job_run_id = job.id
           AND recovery.kind = 'rollover_finalize'
          JOIN free_agent_draft_recovery_action_command_results AS receipt
            ON receipt.league_id = recovery.league_id
           AND receipt.season_id = recovery.season_id
           AND receipt.fad_id = recovery.fad_id
           AND receipt.recovery_id = recovery.id
           AND receipt.job_run_id = recovery.job_run_id
          JOIN idempotency_requests AS request
            ON request.league_id = receipt.league_id
           AND request.id = receipt.idempotency_request_id
          WHERE job.league_id = NEW.league_id
            AND job.season_id = NEW.season_id
            AND job.id = NEW.processing_job_run_id
            AND job.job_type = 'fad_rollover'
            AND job.occurrence_key =
              'fad:' || NEW.fad_id || ':rollover:' ||
                NEW.sequence || ':' || NEW.rolls_over_at_ms
            AND job.scheduled_for_ms = NEW.rolls_over_at_ms
            AND job.status = 'running'
            AND job.attempt_count >= 2
            AND job.lease_owner IS NOT NULL
            AND length(trim(job.lease_owner)) > 0
            AND job.lease_token IS NOT NULL
            AND length(trim(job.lease_token)) > 0
            AND job.lease_expires_at_ms > NEW.completed_at_ms
            AND job.started_at_ms IS NOT NULL
            AND job.started_at_ms >= receipt.accepted_at_ms
            AND job.started_at_ms <= NEW.completed_at_ms
            AND job.updated_at_ms = job.started_at_ms
            AND job.completed_at_ms IS NULL
            AND job.result_json IS NULL
            AND job.last_error_code IS NULL
            AND job.next_attempt_at_ms IS NULL
            AND recovery.status = 'running'
            AND recovery.last_error_code = OLD.last_error_code
            AND recovery.commissioner_reason IS NOT NULL
            AND recovery.created_by_operation_id = job.id
            AND recovery.resolved_by_user_id IS NULL
            AND recovery.resolved_by_membership_id IS NULL
            AND recovery.resolved_authority IS NULL
            AND recovery.created_at_ms <= OLD.completed_at_ms
            AND recovery.updated_at_ms = receipt.accepted_at_ms
            AND recovery.updated_at_ms <= job.started_at_ms
            AND recovery.resolved_at_ms IS NULL
            AND recovery.version >= 2
            AND receipt.action = 'finalize_rollover'
            AND receipt.resource_kind = 'rollover'
            AND receipt.resource_id = NEW.id
            AND receipt.operation_id = job.id
            AND receipt.job_run_id = job.id
            AND receipt.occurrence_key = job.occurrence_key
            AND receipt.commissioner_reason =
              recovery.commissioner_reason
            AND receipt.accepted_status = 'pending'
            AND receipt.accepted_at_ms > OLD.completed_at_ms
            AND receipt.accepted_at_ms <= NEW.completed_at_ms
            AND request.actor_user_id = receipt.actor_user_id
            AND request.operation =
              'free_agent_draft.recovery.action'
            AND request.request_hash = receipt.request_sha256
            AND request.status = 'completed'
            AND request.result_type =
              'free_agent_draft_recovery_action_command_result'
            AND request.result_id = receipt.id
            AND request.created_at_ms = receipt.accepted_at_ms
            AND request.completed_at_ms = receipt.accepted_at_ms
            AND request.expires_at_ms > receipt.accepted_at_ms
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recovery_action_command_results
                AS later_receipt
              WHERE later_receipt.league_id = receipt.league_id
                AND later_receipt.recovery_id = receipt.recovery_id
                AND later_receipt.action = 'finalize_rollover'
                AND (
                  later_receipt.accepted_at_ms >
                    receipt.accepted_at_ms
                  OR (
                    later_receipt.accepted_at_ms =
                      receipt.accepted_at_ms
                    AND later_receipt.id > receipt.id
                  )
                )
            )
        )
      )
      OR (
        OLD.status = 'recovery_required'
        AND NEW.status = 'recovery_required'
        AND NEW.processing_job_run_id IS
          OLD.processing_job_run_id
        AND NEW.processing_started_at_ms IS
          OLD.processing_started_at_ms
        AND NEW.completed_at_ms = NEW.updated_at_ms
        AND NEW.completed_at_ms > OLD.completed_at_ms
        AND NEW.last_error_code IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM job_runs AS job
          JOIN free_agent_draft_recoveries AS recovery
            ON recovery.league_id = job.league_id
           AND recovery.season_id = job.season_id
           AND recovery.fad_id = NEW.fad_id
           AND recovery.rollover_id = NEW.id
           AND recovery.job_run_id = job.id
           AND recovery.kind = 'rollover_finalize'
          JOIN free_agent_draft_recovery_action_command_results AS receipt
            ON receipt.league_id = recovery.league_id
           AND receipt.season_id = recovery.season_id
           AND receipt.fad_id = recovery.fad_id
           AND receipt.recovery_id = recovery.id
           AND receipt.job_run_id = recovery.job_run_id
          JOIN idempotency_requests AS request
            ON request.league_id = receipt.league_id
           AND request.id = receipt.idempotency_request_id
          WHERE job.league_id = NEW.league_id
            AND job.season_id = NEW.season_id
            AND job.id = NEW.processing_job_run_id
            AND job.job_type = 'fad_rollover'
            AND job.occurrence_key =
              'fad:' || NEW.fad_id || ':rollover:' ||
                NEW.sequence || ':' || NEW.rolls_over_at_ms
            AND job.scheduled_for_ms = NEW.rolls_over_at_ms
            AND job.status = 'failed'
            AND job.attempt_count >= 2
            AND job.lease_owner IS NULL
            AND job.lease_token IS NULL
            AND job.lease_expires_at_ms IS NULL
            AND job.started_at_ms IS NOT NULL
            AND job.started_at_ms >= receipt.accepted_at_ms
            AND job.started_at_ms <= NEW.completed_at_ms
            AND job.completed_at_ms = NEW.completed_at_ms
            AND job.updated_at_ms = NEW.completed_at_ms
            AND job.result_json IS NULL
            AND job.last_error_code = NEW.last_error_code
            AND job.next_attempt_at_ms IS NULL
            AND recovery.status = 'correction_required'
            AND recovery.last_error_code = NEW.last_error_code
            AND recovery.commissioner_reason IS NOT NULL
            AND recovery.created_by_operation_id = job.id
            AND recovery.resolved_by_user_id IS NULL
            AND recovery.resolved_by_membership_id IS NULL
            AND recovery.resolved_authority IS NULL
            AND recovery.created_at_ms <= OLD.completed_at_ms
            AND recovery.updated_at_ms = NEW.completed_at_ms
            AND recovery.resolved_at_ms IS NULL
            AND recovery.version >= 3
            AND receipt.action = 'finalize_rollover'
            AND receipt.resource_kind = 'rollover'
            AND receipt.resource_id = NEW.id
            AND receipt.operation_id = job.id
            AND receipt.job_run_id = job.id
            AND receipt.occurrence_key = job.occurrence_key
            AND receipt.commissioner_reason =
              recovery.commissioner_reason
            AND receipt.accepted_status = 'pending'
            AND receipt.accepted_at_ms > OLD.completed_at_ms
            AND receipt.accepted_at_ms <= job.started_at_ms
            AND request.actor_user_id = receipt.actor_user_id
            AND request.operation =
              'free_agent_draft.recovery.action'
            AND request.request_hash = receipt.request_sha256
            AND request.status = 'completed'
            AND request.result_type =
              'free_agent_draft_recovery_action_command_result'
            AND request.result_id = receipt.id
            AND request.created_at_ms = receipt.accepted_at_ms
            AND request.completed_at_ms = receipt.accepted_at_ms
            AND request.expires_at_ms > receipt.accepted_at_ms
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recovery_action_command_results
                AS later_receipt
              WHERE later_receipt.league_id = receipt.league_id
                AND later_receipt.recovery_id = receipt.recovery_id
                AND later_receipt.action = 'finalize_rollover'
                AND (
                  later_receipt.accepted_at_ms >
                    receipt.accepted_at_ms
                  OR (
                    later_receipt.accepted_at_ms =
                      receipt.accepted_at_ms
                    AND later_receipt.id > receipt.id
                  )
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
        AND (
          (NEW.window_kind = 'initial' AND NEW.sequence <= COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7)
            AND NEW.opens_at_ms = CASE
              WHEN free_agent_drafts.initial_rollover_times_json IS NULL THEN free_agent_drafts.candidate_deadline_at_ms + (NEW.sequence - 1) * 86400000
              WHEN NEW.sequence = 1 THEN free_agent_drafts.candidate_deadline_at_ms
              ELSE json_extract(free_agent_drafts.initial_rollover_times_json, '$[' || (NEW.sequence - 2) || ']') END
            AND NEW.rolls_over_at_ms = CASE
              WHEN free_agent_drafts.initial_rollover_times_json IS NULL THEN free_agent_drafts.candidate_deadline_at_ms + NEW.sequence * 86400000
              ELSE json_extract(free_agent_drafts.initial_rollover_times_json, '$[' || (NEW.sequence - 1) || ']') END)
          OR (NEW.window_kind = 'extension' AND NEW.sequence > COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7))
        )
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
              AND NEW.sequence >= 2
            )
            OR (
              NEW.window_kind = 'extension'
              AND NEW.sequence >= 2
              AND (
                predecessor.status IN (
                  'processing',
                  'completed',
                  'recovery_required'
                )
                OR (
                  predecessor.status = 'scheduled'
                  AND NEW.extension_reason = 'queued_nomination'
                  AND NEW.created_at_ms >=
                    predecessor.rolls_over_at_ms
                  AND NEW.created_at_ms <
                    NEW.rolls_over_at_ms
                )
                OR (
                  predecessor.status = 'scheduled'
                  AND NEW.extension_reason = 'fallback_auction'
                  AND NEW.created_at_ms >=
                    predecessor.creation_cutoff_at_ms
                  AND NEW.created_at_ms <
                    predecessor.rolls_over_at_ms
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_player_allocations
                      AS allocation
                    JOIN auctions AS restricted_auction
                      ON restricted_auction.league_id =
                          allocation.league_id
                     AND restricted_auction.season_id =
                          allocation.season_id
                     AND restricted_auction.id =
                          allocation.restricted_auction_id
                     AND restricted_auction.player_id =
                          allocation.player_id
                    JOIN auction_contexts AS restricted_context
                      ON restricted_context.league_id =
                          restricted_auction.league_id
                     AND restricted_context.season_id =
                          restricted_auction.season_id
                     AND restricted_context.auction_id =
                          restricted_auction.id
                    JOIN free_agent_draft_rollovers AS source_rollover
                      ON source_rollover.league_id =
                          restricted_context.league_id
                     AND source_rollover.season_id =
                          restricted_context.season_id
                     AND source_rollover.fad_id =
                          restricted_context.fad_id
                     AND source_rollover.id =
                          restricted_context.fad_rollover_id
                    JOIN free_agent_draft_draws AS restricted_draw
                      ON restricted_draw.league_id =
                          restricted_context.league_id
                     AND restricted_draw.season_id =
                          restricted_context.season_id
                     AND restricted_draw.fad_id =
                          restricted_context.fad_id
                     AND restricted_draw.allocation_id =
                          restricted_context.fad_allocation_id
                     AND restricted_draw.auction_id =
                          restricted_context.auction_id
                    JOIN job_runs AS resolution_job
                      ON resolution_job.league_id =
                          restricted_auction.league_id
                     AND resolution_job.season_id =
                          restricted_auction.season_id
                     AND resolution_job.job_type =
                          'auction.resolve.target'
                     AND resolution_job.occurrence_key =
                          'auction:' || restricted_auction.id || ':' ||
                            restricted_auction.resolves_at_ms
                     AND resolution_job.scheduled_for_ms =
                          restricted_auction.resolves_at_ms
                    WHERE allocation.league_id = NEW.league_id
                      AND allocation.season_id = NEW.season_id
                      AND allocation.fad_id = NEW.fad_id
                      AND allocation.id = NEW.extension_source_id
                      AND allocation.status = 'restricted_active'
                      AND allocation.decision_code =
                        'exact_total_and_term_tie'
                      AND allocation.winning_snapshot_entry_id IS NULL
                      AND allocation.winning_team_id IS NULL
                      AND allocation.contract_id IS NULL
                      AND allocation.ownership_id IS NULL
                      AND allocation.restricted_auction_id IS NOT NULL
                      AND allocation.fallback_open_auction_id IS NULL
                      AND allocation.restricted_minimum_total_cents
                        IS NOT NULL
                      AND allocation.restricted_minimum_term_years
                        IS NOT NULL
                      AND allocation.restricted_minimum_aav_cents
                        IS NOT NULL
                      AND allocation.accounted_at_ms IS NULL
                      AND allocation.last_error_code IS NULL
                      AND restricted_auction.status = 'resolving'
                      AND restricted_auction.opened_at_ms >=
                        source_rollover.opens_at_ms
                      AND restricted_auction.opened_at_ms <
                        source_rollover.rolls_over_at_ms
                      AND restricted_auction.resolves_at_ms =
                        source_rollover.rolls_over_at_ms
                      AND restricted_auction.resolves_at_ms <=
                        NEW.created_at_ms
                      AND NOT EXISTS (
                        SELECT 1
                        FROM auction_resolutions
                        WHERE auction_resolutions.league_id =
                            restricted_auction.league_id
                          AND auction_resolutions.auction_id =
                            restricted_auction.id
                      )
                      AND restricted_context.source_kind =
                        'fad_restricted'
                      AND restricted_context.fad_id = allocation.fad_id
                      AND restricted_context.fad_allocation_id = allocation.id
                      AND restricted_context.fad_origin =
                        'candidate_tie_restricted'
                      AND restricted_draw.revealed_at_ms IS NULL
                      AND restricted_draw.version = 1
                      AND (
                        (
                          source_rollover.id =
                            predecessor.predecessor_rollover_id
                          AND source_rollover.sequence =
                            predecessor.sequence - 1
                          AND source_rollover.rolls_over_at_ms =
                            predecessor.opens_at_ms
                          AND source_rollover.status IN (
                            'scheduled',
                            'processing',
                            'recovery_required'
                          )
                          AND resolution_job.status IN (
                            'leased',
                            'running'
                          )
                          AND resolution_job.attempt_count >= 1
                          AND resolution_job.lease_owner IS NOT NULL
                          AND resolution_job.lease_token IS NOT NULL
                          AND resolution_job.lease_expires_at_ms >
                            NEW.created_at_ms
                          AND resolution_job.completed_at_ms IS NULL
                          AND resolution_job.result_json IS NULL
                          AND resolution_job.last_error_code IS NULL
                          AND resolution_job.next_attempt_at_ms IS NULL
                          AND resolution_job.updated_at_ms <=
                            NEW.created_at_ms
                          AND (
                            source_rollover.status <>
                              'recovery_required'
                            OR EXISTS (
                              SELECT 1
                              FROM free_agent_draft_recoveries AS recovery
                              WHERE recovery.league_id =
                                  allocation.league_id
                                AND recovery.season_id =
                                  allocation.season_id
                                AND recovery.fad_id = allocation.fad_id
                                AND recovery.player_id = allocation.player_id
                                AND recovery.allocation_id = allocation.id
                                AND recovery.rollover_id = source_rollover.id
                                AND recovery.auction_id =
                                  restricted_auction.id
                                AND recovery.job_run_id = resolution_job.id
                                AND recovery.kind = 'auction_resolution'
                                AND recovery.status = 'running'
                                AND recovery.created_by_operation_id =
                                  resolution_job.id
                                AND recovery.resolved_at_ms IS NULL
                            )
                          )
                        )
                        OR (
                          source_rollover.sequence <
                            predecessor.sequence - 1
                          AND source_rollover.rolls_over_at_ms <
                            predecessor.opens_at_ms
                          AND source_rollover.status =
                            'recovery_required'
                          AND resolution_job.status IN (
                            'leased',
                            'running'
                          )
                          AND resolution_job.attempt_count >= 2
                          AND resolution_job.lease_owner IS NOT NULL
                          AND resolution_job.lease_token IS NOT NULL
                          AND resolution_job.lease_expires_at_ms >
                            NEW.created_at_ms
                          AND resolution_job.completed_at_ms IS NULL
                          AND resolution_job.result_json IS NULL
                          AND resolution_job.last_error_code IS NULL
                          AND resolution_job.next_attempt_at_ms IS NULL
                          AND resolution_job.updated_at_ms <=
                            NEW.created_at_ms
                          AND EXISTS (
                            SELECT 1
                            FROM free_agent_draft_recoveries AS recovery
                            JOIN auction_events AS failure_event
                              ON failure_event.league_id =
                                  recovery.league_id
                             AND failure_event.season_id =
                                  recovery.season_id
                             AND failure_event.auction_id =
                                  recovery.auction_id
                             AND failure_event.event_type =
                                  'fad_auction_resolution_failed'
                            JOIN free_agent_draft_recovery_action_command_results
                              AS receipt
                              ON receipt.league_id = recovery.league_id
                             AND receipt.season_id = recovery.season_id
                             AND receipt.fad_id = recovery.fad_id
                             AND receipt.recovery_id = recovery.id
                             AND receipt.job_run_id = recovery.job_run_id
                            JOIN idempotency_requests AS request
                              ON request.league_id = receipt.league_id
                             AND request.id =
                                  receipt.idempotency_request_id
                            WHERE recovery.league_id = allocation.league_id
                              AND recovery.season_id = allocation.season_id
                              AND recovery.fad_id = allocation.fad_id
                              AND recovery.player_id = allocation.player_id
                              AND recovery.allocation_id = allocation.id
                              AND recovery.rollover_id = source_rollover.id
                              AND recovery.auction_id = restricted_auction.id
                              AND recovery.job_run_id = resolution_job.id
                              AND recovery.kind = 'auction_resolution'
                              AND recovery.status = 'running'
                              AND recovery.last_error_code IS NOT NULL
                              AND recovery.created_by_operation_id =
                                resolution_job.id
                              AND recovery.resolved_at_ms IS NULL
                              AND recovery.updated_at_ms <= NEW.created_at_ms
                              AND failure_event.actor_user_id IS NULL
                              AND failure_event.bid_id IS NULL
                              AND failure_event.team_id IS NULL
                              AND json_extract(
                                    failure_event.metadata_json,
                                    '$.recoveryId'
                                  ) = recovery.id
                              AND json_extract(
                                    failure_event.metadata_json,
                                    '$.jobRunId'
                                  ) = resolution_job.id
                              AND json_extract(
                                    failure_event.metadata_json,
                                    '$.errorCode'
                                  ) = recovery.last_error_code
                              AND recovery.created_at_ms <=
                                failure_event.occurred_at_ms
                              AND NOT EXISTS (
                                SELECT 1
                                FROM auction_events AS later_failure
                                WHERE later_failure.league_id =
                                    failure_event.league_id
                                  AND later_failure.season_id =
                                    failure_event.season_id
                                  AND later_failure.auction_id =
                                    failure_event.auction_id
                                  AND later_failure.event_type =
                                    'fad_auction_resolution_failed'
                                  AND json_extract(
                                        later_failure.metadata_json,
                                        '$.recoveryId'
                                      ) = recovery.id
                                  AND json_extract(
                                        later_failure.metadata_json,
                                        '$.jobRunId'
                                      ) = resolution_job.id
                                  AND later_failure.occurred_at_ms >
                                    failure_event.occurred_at_ms
                              )
                              AND receipt.action =
                                'retry_auction_resolution'
                              AND receipt.resource_kind = 'auction'
                              AND receipt.resource_id = restricted_auction.id
                              AND receipt.operation_id = resolution_job.id
                              AND receipt.occurrence_key =
                                resolution_job.occurrence_key
                              AND receipt.accepted_status = 'pending'
                              AND receipt.accepted_at_ms >=
                                failure_event.occurred_at_ms
                              AND receipt.accepted_at_ms <= NEW.created_at_ms
                              AND request.status = 'completed'
                              AND request.result_type =
                                'free_agent_draft_recovery_action_command_result'
                              AND request.result_id = receipt.id
                              AND request.completed_at_ms =
                                receipt.accepted_at_ms
                              AND NOT EXISTS (
                                SELECT 1
                                FROM free_agent_draft_recovery_action_command_results
                                  AS later_receipt
                                WHERE later_receipt.league_id =
                                    receipt.league_id
                                  AND later_receipt.recovery_id =
                                    receipt.recovery_id
                                  AND later_receipt.action =
                                    'retry_auction_resolution'
                                  AND later_receipt.accepted_at_ms >
                                    receipt.accepted_at_ms
                                  AND later_receipt.accepted_at_ms <=
                                    NEW.created_at_ms
                              )
                          )
                        )
                      )
                  )
                )
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
            FROM free_agent_draft_nomination_queue AS queue
            JOIN free_agent_draft_rollovers AS opening_rollover
              ON opening_rollover.league_id = queue.league_id
             AND opening_rollover.season_id = queue.season_id
             AND opening_rollover.fad_id = queue.fad_id
             AND opening_rollover.id =
                  queue.target_opening_rollover_id
            JOIN job_runs AS activation_job
              ON activation_job.league_id = queue.league_id
             AND activation_job.season_id = queue.season_id
            WHERE queue.league_id = NEW.league_id
              AND queue.season_id = NEW.season_id
              AND queue.fad_id = NEW.fad_id
              AND queue.id = NEW.extension_source_id
              AND queue.status = 'queued'
              AND queue.target_opening_rollover_id =
                NEW.predecessor_rollover_id
              AND queue.resolution_rollover_id IS NULL
              AND queue.opened_auction_id IS NULL
              AND queue.opened_starter_bid_id IS NULL
              AND queue.opened_at_ms IS NULL
              AND queue.terminal_at_ms IS NULL
              AND queue.validation_code IS NULL
              AND opening_rollover.rolls_over_at_ms =
                NEW.opens_at_ms
              AND activation_job.job_type =
                'fad_queued_nomination_activation'
              AND activation_job.occurrence_key =
                'fad:' || queue.fad_id || ':nomination-open:' ||
                  queue.id || ':' || opening_rollover.rolls_over_at_ms
              AND activation_job.scheduled_for_ms =
                opening_rollover.rolls_over_at_ms
              AND activation_job.status = 'running'
              AND activation_job.attempt_count >= 1
              AND activation_job.lease_owner IS NOT NULL
              AND activation_job.lease_token IS NOT NULL
              AND activation_job.started_at_ms >=
                opening_rollover.rolls_over_at_ms
              AND activation_job.started_at_ms <=
                NEW.created_at_ms
              AND activation_job.updated_at_ms =
                activation_job.started_at_ms
              AND activation_job.lease_expires_at_ms >
                NEW.created_at_ms
              AND activation_job.completed_at_ms IS NULL
              AND activation_job.result_json IS NULL
              AND activation_job.last_error_code IS NULL
              AND activation_job.next_attempt_at_ms IS NULL
              AND activation_job.created_at_ms =
                queue.accepted_at_ms
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
          AND (
            EXISTS (
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
            OR EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations AS allocation
              JOIN auctions AS restricted_auction
                ON restricted_auction.league_id = allocation.league_id
               AND restricted_auction.season_id = allocation.season_id
               AND restricted_auction.id =
                    allocation.restricted_auction_id
               AND restricted_auction.player_id = allocation.player_id
              JOIN auction_contexts AS restricted_context
                ON restricted_context.league_id =
                    restricted_auction.league_id
               AND restricted_context.season_id =
                    restricted_auction.season_id
               AND restricted_context.auction_id = restricted_auction.id
              JOIN free_agent_draft_rollovers AS source_rollover
                ON source_rollover.league_id =
                    restricted_context.league_id
               AND source_rollover.season_id =
                    restricted_context.season_id
               AND source_rollover.fad_id = restricted_context.fad_id
               AND source_rollover.id =
                    restricted_context.fad_rollover_id
              JOIN free_agent_draft_rollovers AS predecessor
                ON predecessor.league_id = NEW.league_id
               AND predecessor.season_id = NEW.season_id
               AND predecessor.fad_id = NEW.fad_id
               AND predecessor.id = NEW.predecessor_rollover_id
              JOIN free_agent_draft_draws AS restricted_draw
                ON restricted_draw.league_id =
                    restricted_context.league_id
               AND restricted_draw.season_id =
                    restricted_context.season_id
               AND restricted_draw.fad_id = restricted_context.fad_id
               AND restricted_draw.allocation_id =
                    restricted_context.fad_allocation_id
               AND restricted_draw.auction_id =
                    restricted_context.auction_id
              JOIN job_runs AS resolution_job
                ON resolution_job.league_id = restricted_auction.league_id
               AND resolution_job.season_id = restricted_auction.season_id
               AND resolution_job.job_type = 'auction.resolve.target'
               AND resolution_job.occurrence_key =
                    'auction:' || restricted_auction.id || ':' ||
                      restricted_auction.resolves_at_ms
               AND resolution_job.scheduled_for_ms =
                    restricted_auction.resolves_at_ms
              WHERE allocation.league_id = NEW.league_id
                AND allocation.season_id = NEW.season_id
                AND allocation.fad_id = NEW.fad_id
                AND allocation.id = NEW.extension_source_id
                AND allocation.status = 'restricted_active'
                AND allocation.decision_code =
                  'exact_total_and_term_tie'
                AND allocation.winning_snapshot_entry_id IS NULL
                AND allocation.winning_team_id IS NULL
                AND allocation.contract_id IS NULL
                AND allocation.ownership_id IS NULL
                AND allocation.restricted_auction_id IS NOT NULL
                AND allocation.fallback_open_auction_id IS NULL
                AND allocation.restricted_minimum_total_cents IS NOT NULL
                AND allocation.restricted_minimum_term_years IS NOT NULL
                AND allocation.restricted_minimum_aav_cents IS NOT NULL
                AND allocation.accounted_at_ms IS NULL
                AND allocation.last_error_code IS NULL
                AND restricted_auction.status = 'resolving'
                AND restricted_auction.opened_at_ms >=
                  source_rollover.opens_at_ms
                AND restricted_auction.opened_at_ms <
                  source_rollover.rolls_over_at_ms
                AND restricted_auction.resolves_at_ms =
                  source_rollover.rolls_over_at_ms
                AND restricted_auction.resolves_at_ms <= NEW.created_at_ms
                AND NOT EXISTS (
                  SELECT 1
                  FROM auction_resolutions
                  WHERE auction_resolutions.league_id =
                      restricted_auction.league_id
                    AND auction_resolutions.auction_id =
                      restricted_auction.id
                )
                AND restricted_context.source_kind = 'fad_restricted'
                AND restricted_context.fad_id = allocation.fad_id
                AND restricted_context.fad_allocation_id = allocation.id
                AND restricted_context.fad_origin =
                  'candidate_tie_restricted'
                AND restricted_draw.revealed_at_ms IS NULL
                AND restricted_draw.version = 1
                AND predecessor.status = 'scheduled'
                AND predecessor.sequence = NEW.sequence - 1
                AND predecessor.rolls_over_at_ms = NEW.opens_at_ms
                AND NEW.created_at_ms >=
                  predecessor.creation_cutoff_at_ms
                AND NEW.created_at_ms < predecessor.rolls_over_at_ms
                AND (
                  (
                    source_rollover.id =
                      predecessor.predecessor_rollover_id
                    AND source_rollover.sequence =
                      predecessor.sequence - 1
                    AND source_rollover.rolls_over_at_ms =
                      predecessor.opens_at_ms
                    AND source_rollover.status IN (
                      'scheduled',
                      'processing',
                      'recovery_required'
                    )
                    AND resolution_job.status IN ('leased', 'running')
                    AND resolution_job.attempt_count >= 1
                    AND resolution_job.lease_owner IS NOT NULL
                    AND resolution_job.lease_token IS NOT NULL
                    AND resolution_job.lease_expires_at_ms >
                      NEW.created_at_ms
                    AND resolution_job.completed_at_ms IS NULL
                    AND resolution_job.result_json IS NULL
                    AND resolution_job.last_error_code IS NULL
                    AND resolution_job.next_attempt_at_ms IS NULL
                    AND resolution_job.updated_at_ms <= NEW.created_at_ms
                    AND (
                      source_rollover.status <> 'recovery_required'
                      OR EXISTS (
                        SELECT 1
                        FROM free_agent_draft_recoveries AS recovery
                        WHERE recovery.league_id = allocation.league_id
                          AND recovery.season_id = allocation.season_id
                          AND recovery.fad_id = allocation.fad_id
                          AND recovery.player_id = allocation.player_id
                          AND recovery.allocation_id = allocation.id
                          AND recovery.rollover_id = source_rollover.id
                          AND recovery.auction_id = restricted_auction.id
                          AND recovery.job_run_id = resolution_job.id
                          AND recovery.kind = 'auction_resolution'
                          AND recovery.status = 'running'
                          AND recovery.created_by_operation_id =
                            resolution_job.id
                          AND recovery.resolved_at_ms IS NULL
                      )
                    )
                  )
                  OR (
                    source_rollover.sequence <
                      predecessor.sequence - 1
                    AND source_rollover.rolls_over_at_ms <
                      predecessor.opens_at_ms
                    AND source_rollover.status = 'recovery_required'
                    AND resolution_job.status IN ('leased', 'running')
                    AND resolution_job.attempt_count >= 2
                    AND resolution_job.lease_owner IS NOT NULL
                    AND resolution_job.lease_token IS NOT NULL
                    AND resolution_job.lease_expires_at_ms >
                      NEW.created_at_ms
                    AND resolution_job.completed_at_ms IS NULL
                    AND resolution_job.result_json IS NULL
                    AND resolution_job.last_error_code IS NULL
                    AND resolution_job.next_attempt_at_ms IS NULL
                    AND resolution_job.updated_at_ms <= NEW.created_at_ms
                    AND EXISTS (
                      SELECT 1
                      FROM free_agent_draft_recoveries AS recovery
                      JOIN auction_events AS failure_event
                        ON failure_event.league_id = recovery.league_id
                       AND failure_event.season_id = recovery.season_id
                       AND failure_event.auction_id = recovery.auction_id
                       AND failure_event.event_type =
                            'fad_auction_resolution_failed'
                      JOIN free_agent_draft_recovery_action_command_results
                        AS receipt
                        ON receipt.league_id = recovery.league_id
                       AND receipt.season_id = recovery.season_id
                       AND receipt.fad_id = recovery.fad_id
                       AND receipt.recovery_id = recovery.id
                       AND receipt.job_run_id = recovery.job_run_id
                      JOIN idempotency_requests AS request
                        ON request.league_id = receipt.league_id
                       AND request.id = receipt.idempotency_request_id
                      WHERE recovery.league_id = allocation.league_id
                        AND recovery.season_id = allocation.season_id
                        AND recovery.fad_id = allocation.fad_id
                        AND recovery.player_id = allocation.player_id
                        AND recovery.allocation_id = allocation.id
                        AND recovery.rollover_id = source_rollover.id
                        AND recovery.auction_id = restricted_auction.id
                        AND recovery.job_run_id = resolution_job.id
                        AND recovery.kind = 'auction_resolution'
                        AND recovery.status = 'running'
                        AND recovery.last_error_code IS NOT NULL
                        AND recovery.created_by_operation_id =
                          resolution_job.id
                        AND recovery.resolved_at_ms IS NULL
                        AND recovery.updated_at_ms <= NEW.created_at_ms
                        AND failure_event.actor_user_id IS NULL
                        AND failure_event.bid_id IS NULL
                        AND failure_event.team_id IS NULL
                        AND json_extract(
                              failure_event.metadata_json,
                              '$.recoveryId'
                            ) = recovery.id
                        AND json_extract(
                              failure_event.metadata_json,
                              '$.jobRunId'
                            ) = resolution_job.id
                        AND json_extract(
                              failure_event.metadata_json,
                              '$.errorCode'
                            ) = recovery.last_error_code
                        AND recovery.created_at_ms <=
                          failure_event.occurred_at_ms
                        AND NOT EXISTS (
                          SELECT 1
                          FROM auction_events AS later_failure
                          WHERE later_failure.league_id =
                              failure_event.league_id
                            AND later_failure.season_id =
                              failure_event.season_id
                            AND later_failure.auction_id =
                              failure_event.auction_id
                            AND later_failure.event_type =
                              'fad_auction_resolution_failed'
                            AND json_extract(
                                  later_failure.metadata_json,
                                  '$.recoveryId'
                                ) = recovery.id
                            AND json_extract(
                                  later_failure.metadata_json,
                                  '$.jobRunId'
                                ) = resolution_job.id
                            AND later_failure.occurred_at_ms >
                              failure_event.occurred_at_ms
                        )
                        AND receipt.action =
                          'retry_auction_resolution'
                        AND receipt.resource_kind = 'auction'
                        AND receipt.resource_id = restricted_auction.id
                        AND receipt.operation_id = resolution_job.id
                        AND receipt.occurrence_key =
                          resolution_job.occurrence_key
                        AND receipt.accepted_status = 'pending'
                        AND receipt.accepted_at_ms >=
                          failure_event.occurred_at_ms
                        AND receipt.accepted_at_ms <= NEW.created_at_ms
                        AND request.status = 'completed'
                        AND request.result_type =
                          'free_agent_draft_recovery_action_command_result'
                        AND request.result_id = receipt.id
                        AND request.completed_at_ms = receipt.accepted_at_ms
                        AND NOT EXISTS (
                          SELECT 1
                          FROM free_agent_draft_recovery_action_command_results
                            AS later_receipt
                          WHERE later_receipt.league_id = receipt.league_id
                            AND later_receipt.recovery_id =
                              receipt.recovery_id
                            AND later_receipt.action =
                              'retry_auction_resolution'
                            AND later_receipt.accepted_at_ms >
                              receipt.accepted_at_ms
                            AND later_receipt.accepted_at_ms <=
                              NEW.created_at_ms
                        )
                    )
                  )
                )
            )
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
              AND free_agent_draft_recoveries.status <> 'resolved'
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rollover must be the next contiguous justified boundary'
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
            AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
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
        OR (
          allocation.status IN ('restricted_resolved', 'restricted_fallback_open', 'fallback_open_resolved')
          AND EXISTS (
            SELECT 1 FROM auction_resolutions AS resolution
            JOIN auctions AS auction
              ON auction.id = resolution.auction_id
             AND auction.league_id = resolution.league_id
             AND auction.season_id = resolution.season_id
            JOIN auction_contexts AS context
              ON context.auction_id = auction.id
             AND context.league_id = auction.league_id
             AND context.season_id = auction.season_id
            WHERE resolution.league_id = allocation.league_id
              AND resolution.season_id = allocation.season_id
              AND context.fad_id = allocation.fad_id
              AND context.fad_allocation_id = allocation.id
              AND auction.player_id = allocation.player_id
              AND (
                (auction.status = 'resolved' AND resolution.status = 'resolved'
                  AND resolution.outcome_code = 'winner')
                OR (auction.status = 'no_winner' AND resolution.status IN ('no_bids', 'no_winner')
                  AND resolution.outcome_code = 'no_winner')
              )
              AND resolution.contract_id IS allocation.contract_id
              AND resolution.ownership_id IS allocation.ownership_id
              AND resolution.winning_team_id IS allocation.winning_team_id
              AND (
                (allocation.status = 'restricted_resolved'
                  AND allocation.decision_code = 'restricted_auction_result'
                  AND resolution.outcome_code = 'winner'
                  AND auction.id = allocation.restricted_auction_id
                  AND context.source_kind = 'fad_restricted'
                  AND context.fad_origin = 'candidate_tie_restricted')
                OR (allocation.status = 'restricted_fallback_open'
                  AND allocation.decision_code = 'restricted_no_improvement_fallback'
                  AND resolution.outcome_code = 'no_winner'
                  AND auction.id = allocation.restricted_auction_id
                  AND context.source_kind = 'fad_restricted'
                  AND context.fad_origin = 'candidate_tie_restricted')
                OR (allocation.status = 'fallback_open_resolved'
                  AND allocation.decision_code = CASE
                    WHEN resolution.outcome_code = 'winner' THEN 'fallback_open_result'
                    WHEN resolution.outcome_code = 'no_winner' THEN 'fallback_open_no_winner'
                    ELSE NULL END
                  AND auction.id = allocation.fallback_open_auction_id
                  AND context.source_kind = 'fad_open_rapid'
                  AND context.fad_origin = 'restricted_no_improvement_fallback')
              )
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
            AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
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
            AND eligible_offer.proposed_total_value_cents IS NOT NULL
            AND eligible_offer.proposed_term_years IS NOT NULL
            AND eligible_offer.proposed_aav_cents IS NOT NULL
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
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
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
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
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
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
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
         AND winning_offer.proposed_total_value_cents IS NOT NULL
         AND winning_offer.proposed_term_years IS NOT NULL
         AND winning_offer.proposed_aav_cents IS NOT NULL
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
            ((
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
              winning_offer.slot_number)
            OR (
              EXISTS (
          SELECT 1 FROM ownership_events AS acquired
          WHERE acquired.league_id = allocation.league_id
            AND acquired.season_id = allocation.season_id
            AND acquired.player_id = allocation.player_id
            AND acquired.team_id = allocation.winning_team_id
            AND acquired.ownership_id = allocation.ownership_id
            AND acquired.event_type = 'fad_allocation_player_acquired'
            AND acquired.source_type = 'free_agent_draft_allocation'
            AND acquired.source_id = allocation.id
            AND acquired.actor_user_id IS NULL
            AND acquired.occurred_at_ms = allocation.accounted_at_ms
            AND acquired.before_metadata_json IS NULL
            AND json_extract(acquired.after_metadata_json, '$.ownershipKind') = 'Rostered'
            AND json_extract(acquired.after_metadata_json, '$.rosterCategory') =
              CASE WHEN winning_offer.slot_group = 'B' THEN 'Bench' ELSE 'Active' END
            AND json_extract(acquired.after_metadata_json, '$.positionGroup') = winning_offer.effective_position_group
            AND json_extract(acquired.after_metadata_json, '$.slotNumber') = winning_offer.slot_number)
              AND EXISTS (
                SELECT 1 FROM ownership_events AS moved
                JOIN league_activity AS activity
                  ON activity.id = moved.source_id
                 AND activity.league_id = moved.league_id
                 AND activity.season_id = moved.season_id
                 AND activity.actor_user_id = moved.actor_user_id
                 AND activity.team_id = moved.team_id
                 AND activity.event_type = 'roster_moved'
                WHERE moved.league_id = allocation.league_id
                  AND moved.season_id = allocation.season_id
                  AND moved.player_id = allocation.player_id
                  AND moved.team_id = allocation.winning_team_id
                  AND moved.ownership_id = allocation.ownership_id
                  AND moved.event_type = 'roster_category_moved'
                  AND moved.source_type = 'roster_move'
                  AND moved.actor_user_id IS NOT NULL
                  AND moved.occurred_at_ms >= allocation.accounted_at_ms
                  AND json_extract(moved.after_metadata_json, '$.version') = player_ownerships.version
                  AND json_extract(moved.after_metadata_json, '$.version') = json_extract(moved.before_metadata_json, '$.version') + 1
                  AND json_extract(moved.after_metadata_json, '$.rosterCategory') = player_ownerships.roster_category
                  AND json_extract(moved.after_metadata_json, '$.positionGroup') = player_ownerships.position_group
                  AND json_extract(moved.after_metadata_json, '$.slotNumber') = player_ownerships.slot_number
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM contracts
        JOIN candidate_card_snapshot_entries AS winning_offer
          ON winning_offer.id = allocation.winning_snapshot_entry_id
         AND winning_offer.league_id = allocation.league_id
         AND winning_offer.season_id = allocation.season_id
         AND winning_offer.fad_id = allocation.fad_id
         AND winning_offer.player_id = allocation.player_id
         AND winning_offer.team_id = allocation.winning_team_id
         AND winning_offer.row_kind = 'slot'
         AND winning_offer.occupant_kind = 'candidate'
         AND winning_offer.slot_group IN ('F', 'D', 'B')
         AND winning_offer.eligibility_status IN ('valid', 'warning')
         AND winning_offer.allocation_eligibility = 'eligible'
        JOIN contract_events AS created
          ON created.league_id = allocation.league_id
         AND created.contract_id = allocation.contract_id
         AND created.player_id = allocation.player_id
         AND created.team_id = allocation.winning_team_id
         AND created.event_type = 'contract_created'
         AND created.source_type = 'free_agent_draft_allocation'
         AND created.source_id = allocation.id
         AND created.actor_user_id IS NULL
         AND created.occurred_at_ms = allocation.accounted_at_ms
        JOIN ownership_events AS released
          ON released.league_id = allocation.league_id
         AND released.season_id = allocation.season_id
         AND released.player_id = allocation.player_id
         AND released.team_id = allocation.winning_team_id
         AND released.ownership_id = allocation.ownership_id
         AND released.actor_user_id IS NOT NULL
         AND released.occurred_at_ms >= allocation.accounted_at_ms
        WHERE contracts.league_id = allocation.league_id
          AND contracts.id = allocation.contract_id
          AND contracts.player_id = allocation.player_id
          AND contracts.acquisition_source_type = 'free_agent_draft_allocation'
          AND contracts.acquisition_source_id = allocation.id
          AND contracts.created_at_ms = allocation.accounted_at_ms
          AND json_extract(created.metadata_json, '$.contractType') = 'normal'
          AND json_extract(created.metadata_json, '$.startSeasonId') = allocation.season_id
          AND json_extract(created.metadata_json, '$.originalTotalValueCents') = winning_offer.proposed_total_value_cents
          AND json_extract(created.metadata_json, '$.originalTermYears') = winning_offer.proposed_term_years
          AND json_extract(created.metadata_json, '$.aavCents') = winning_offer.proposed_aav_cents
          AND EXISTS (
          SELECT 1 FROM ownership_events AS acquired
          WHERE acquired.league_id = allocation.league_id
            AND acquired.season_id = allocation.season_id
            AND acquired.player_id = allocation.player_id
            AND acquired.team_id = allocation.winning_team_id
            AND acquired.ownership_id = allocation.ownership_id
            AND acquired.event_type = 'fad_allocation_player_acquired'
            AND acquired.source_type = 'free_agent_draft_allocation'
            AND acquired.source_id = allocation.id
            AND acquired.actor_user_id IS NULL
            AND acquired.occurred_at_ms = allocation.accounted_at_ms
            AND acquired.before_metadata_json IS NULL
            AND json_extract(acquired.after_metadata_json, '$.ownershipKind') = 'Rostered'
            AND json_extract(acquired.after_metadata_json, '$.rosterCategory') =
              CASE WHEN winning_offer.slot_group = 'B' THEN 'Bench' ELSE 'Active' END
            AND json_extract(acquired.after_metadata_json, '$.positionGroup') = winning_offer.effective_position_group
            AND json_extract(acquired.after_metadata_json, '$.slotNumber') = winning_offer.slot_number)
          AND NOT EXISTS (
            SELECT 1 FROM player_ownerships
            WHERE league_id = allocation.league_id AND id = allocation.ownership_id
          )
          AND (
            (released.event_type = 'commissioner_player_removed'
              AND released.source_type = 'commissioner_correction'
              AND contracts.status = 'cancelled'
              AND json_extract(released.before_metadata_json, '$.ownership.id') = allocation.ownership_id
              AND json_extract(released.before_metadata_json, '$.contract.id') = allocation.contract_id
              AND json_type(released.after_metadata_json, '$.ownership') = 'null'
              AND EXISTS (
                SELECT 1 FROM commissioner_corrections AS correction
                JOIN contract_events AS cancelled
                  ON cancelled.league_id = correction.league_id
                 AND cancelled.source_id = correction.id
                 AND cancelled.source_type = 'commissioner_correction'
                 AND cancelled.event_type = 'commissioner_contract_cancelled'
                 AND cancelled.contract_id = allocation.contract_id
                 AND cancelled.player_id = allocation.player_id
                 AND cancelled.actor_user_id = correction.actor_user_id
                 AND cancelled.occurred_at_ms = correction.corrected_at_ms
                WHERE correction.id = released.source_id
                  AND correction.league_id = released.league_id
                  AND correction.season_id = released.season_id
                  AND correction.actor_user_id = released.actor_user_id
                  AND correction.corrected_at_ms = released.occurred_at_ms
                  AND correction.feature = 'roster_remove'
                  AND json_extract(cancelled.metadata_json, '$.after.status') = 'cancelled'
                  AND json_extract(cancelled.metadata_json, '$.after.id') = allocation.contract_id
              ))
            OR (released.event_type = 'trade_transfer_out'
              AND released.source_type = 'trade'
              AND json_extract(released.before_metadata_json, '$.ownership.id') = allocation.ownership_id
              AND json_extract(released.after_metadata_json, '$.exists') = 0
              AND EXISTS (
                SELECT 1 FROM trades
                JOIN ownership_events AS received
                  ON received.league_id = trades.league_id
                 AND received.season_id = trades.season_id
                 AND received.source_type = 'trade'
                 AND received.source_id = trades.id
                 AND received.event_type = 'trade_transfer_in'
                 AND received.player_id = allocation.player_id
                 AND received.ownership_id = json_extract(released.after_metadata_json, '$.destinationOwnershipId')
                 AND json_extract(received.before_metadata_json, '$.sourceOwnershipId') = allocation.ownership_id
                 AND received.occurred_at_ms = released.occurred_at_ms
                WHERE trades.id = released.source_id
                  AND trades.league_id = released.league_id
                  AND trades.season_id = released.season_id
                  AND trades.status IN ('completed', 'reversed', 'correction_required')
                  AND trades.completed_at_ms = released.occurred_at_ms
              ))
          )
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
        JOIN candidate_card_snapshot_entries AS winning_offer
          ON winning_offer.league_id = allocation.league_id
         AND winning_offer.season_id = allocation.season_id
         AND winning_offer.fad_id = allocation.fad_id
         AND winning_offer.id = allocation.winning_snapshot_entry_id
         AND winning_offer.team_id = allocation.winning_team_id
         AND winning_offer.player_id = allocation.player_id
         AND winning_offer.row_kind = 'slot'
         AND winning_offer.occupant_kind = 'candidate'
         AND winning_offer.proposed_total_value_cents IS NOT NULL
         AND winning_offer.proposed_term_years IS NOT NULL
         AND winning_offer.proposed_aav_cents IS NOT NULL
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
              'free_agent_draft_player_awarded'
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
          AND json_valid(outbox_events.payload_json) = 1
          AND json_type(outbox_events.payload_json) = 'object'
          AND (SELECT COUNT(*) FROM json_each(outbox_events.payload_json)) = 8
          AND NOT EXISTS (
            SELECT 1 FROM json_each(outbox_events.payload_json) AS member
            WHERE member.key NOT IN (
              'eventId', 'type', 'leagueId', 'resourceId',
              'version', 'reasonCode', 'occurredAt', 'related'
            )
          )
          AND json_type(outbox_events.payload_json, '$.eventId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.eventId') = outbox_events.id
          AND json_type(outbox_events.payload_json, '$.type') = 'text'
          AND json_extract(outbox_events.payload_json, '$.type') = 'free_agent_draft.changed'
          AND json_type(outbox_events.payload_json, '$.leagueId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.leagueId') = outbox_events.league_id
          AND json_type(outbox_events.payload_json, '$.resourceId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.resourceId') = allocation.fad_id
          AND json_type(outbox_events.payload_json, '$.version') = 'integer'
          AND json_type(
                decision_event.evidence_json,
                '$.sideEffects.fadVersion'
              ) = 'integer'
          AND json_extract(
                decision_event.evidence_json,
                '$.sideEffects.fadVersion'
              ) >= 1
          AND json_extract(outbox_events.payload_json, '$.version') =
              json_extract(
                decision_event.evidence_json,
                '$.sideEffects.fadVersion'
              )
          AND json_type(outbox_events.payload_json, '$.reasonCode') = 'text'
          AND json_extract(outbox_events.payload_json, '$.reasonCode') = 'allocation_changed'
          AND json_type(outbox_events.payload_json, '$.occurredAt') = 'integer'
          AND json_extract(outbox_events.payload_json, '$.occurredAt') = allocation.accounted_at_ms
          AND json_type(outbox_events.payload_json, '$.related') = 'object'
          AND (SELECT COUNT(*) FROM json_each(outbox_events.payload_json, '$.related')) = 8
          AND NOT EXISTS (
            SELECT 1 FROM json_each(outbox_events.payload_json, '$.related') AS related_member
            WHERE related_member.key NOT IN (
              'fadId', 'teamId', 'cardId', 'allocationId',
              'auctionId', 'recoveryId', 'nominationQueueId',
              'scheduleRecoveryOperationId'
            )
          )
          AND json_type(outbox_events.payload_json, '$.related.fadId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.fadId') = allocation.fad_id
          AND json_type(outbox_events.payload_json, '$.related.teamId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.teamId') = allocation.winning_team_id
          AND json_type(outbox_events.payload_json, '$.related.cardId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.cardId') = winning_offer.card_id
          AND json_type(outbox_events.payload_json, '$.related.allocationId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.allocationId') = allocation.id
          AND json_type(outbox_events.payload_json, '$.related.auctionId') = 'null'
          AND json_type(outbox_events.payload_json, '$.related.recoveryId') = 'null'
          AND json_type(outbox_events.payload_json, '$.related.nominationQueueId') = 'null'
          AND json_type(outbox_events.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
          AND (
            SELECT COUNT(*) FROM outbox_event_audiences AS audience
            WHERE audience.league_id = outbox_events.league_id
              AND audience.outbox_event_id = outbox_events.id
          ) = 1
          AND EXISTS (
            SELECT 1 FROM outbox_event_audiences AS audience
            WHERE audience.league_id = outbox_events.league_id
              AND audience.outbox_event_id = outbox_events.id
              AND audience.audience_kind = 'league'
              AND audience.team_id IS NULL
              AND audience.user_id IS NULL
              AND audience.created_at_ms = allocation.accounted_at_ms
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD milestone requires automatic-award activity and scoped outbox evidence'
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
  ) <> COALESCE(json_array_length(NEW.initial_rollover_times_json), 7) THEN RAISE(
    ABORT,
    'FAD deadline requires the complete configured initial rollover schedule'
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
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
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
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
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
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
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

CREATE TRIGGER free_agent_drafts_fad_eligibility_revalidation_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'cards_open'
  AND NEW.status = 'deadline_locked'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    LEFT JOIN job_runs AS job
      ON job.league_id = occurrence.league_id
     AND job.id = occurrence.job_run_id
    WHERE occurrence.league_id = OLD.league_id
      AND occurrence.season_id = OLD.season_id
      AND occurrence.fad_id = OLD.id
      AND (
        job.id IS NULL
        OR job.status NOT IN ('succeeded', 'skipped')
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline must consume every eligibility revalidation occurrence'
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
  ) <> COALESCE(json_array_length(NEW.initial_rollover_times_json), 7) OR EXISTS (
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

CREATE TRIGGER free_agent_drafts_immutable_delete
BEFORE DELETE ON free_agent_drafts
BEGIN
  SELECT RAISE(ABORT, 'FAD lifecycle evidence is immutable');
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

CREATE TRIGGER idempotency_requests_fad_open_rapid_start_complete
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation = 'auction.start'
  AND (
    (
      NEW.result_type = 'auction'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.auction_id = NEW.result_id
          AND auction_contexts.source_kind = 'fad_open_rapid'
          AND auction_contexts.fad_origin = 'manager_nomination'
          AND auction_contexts.fad_allocation_id IS NULL
      )
    )
    OR (
      OLD.result_type = 'auction'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        WHERE auction_contexts.league_id = OLD.league_id
          AND auction_contexts.auction_id = OLD.result_id
          AND auction_contexts.source_kind = 'fad_open_rapid'
          AND auction_contexts.fad_origin = 'manager_nomination'
          AND auction_contexts.fad_allocation_id IS NULL
      )
    )
  )
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
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.status = 'completed'
    AND NEW.result_type = 'auction'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms = OLD.created_at_ms
    AND OLD.expires_at_ms > OLD.created_at_ms
    AND EXISTS (
      SELECT 1
      FROM auctions
      JOIN auction_contexts
        ON auction_contexts.league_id = auctions.league_id
       AND auction_contexts.season_id = auctions.season_id
       AND auction_contexts.auction_id = auctions.id
      JOIN free_agent_draft_rollovers AS rollover
        ON rollover.league_id = auction_contexts.league_id
       AND rollover.season_id = auction_contexts.season_id
       AND rollover.fad_id = auction_contexts.fad_id
       AND rollover.id = auction_contexts.fad_rollover_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = rollover.league_id
       AND fad.season_id = rollover.season_id
       AND fad.id = rollover.fad_id
      JOIN auction_bids AS starter
        ON starter.league_id = auctions.league_id
       AND starter.season_id = auctions.season_id
       AND starter.auction_id = auctions.id
       AND starter.idempotency_request_id = OLD.id
      JOIN auction_events AS started_event
        ON started_event.league_id = starter.league_id
       AND started_event.season_id = starter.season_id
       AND started_event.auction_id = starter.auction_id
       AND started_event.bid_id = starter.id
       AND started_event.team_id = starter.team_id
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = auction_contexts.league_id
       AND draw.season_id = auction_contexts.season_id
       AND draw.fad_id = auction_contexts.fad_id
       AND draw.allocation_id IS NULL
       AND draw.auction_id = auction_contexts.auction_id
      JOIN job_runs AS resolution_job
        ON resolution_job.league_id = auctions.league_id
       AND resolution_job.season_id = auctions.season_id
       AND resolution_job.job_type = 'auction.resolve.target'
       AND resolution_job.occurrence_key =
            'auction:' || auctions.id || ':' ||
              auctions.resolves_at_ms
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.result_id
        AND auctions.status = 'open'
        AND auctions.opened_by_user_id = OLD.actor_user_id
        AND auctions.created_at_ms = OLD.created_at_ms
        AND auctions.opened_at_ms = OLD.created_at_ms
        AND auctions.updated_at_ms = OLD.created_at_ms
        AND auctions.version = 1
        AND auctions.resolves_at_ms =
          rollover.rolls_over_at_ms
        AND auction_contexts.source_kind = 'fad_open_rapid'
        AND auction_contexts.fad_origin =
          'manager_nomination'
        AND auction_contexts.fad_allocation_id IS NULL
        AND auction_contexts.created_at_ms =
          auctions.opened_at_ms
        AND rollover.status IN ('scheduled', 'processing')
        AND auctions.opened_at_ms >= rollover.opens_at_ms
        AND auctions.opened_at_ms <
          rollover.creation_cutoff_at_ms
        AND fad.status IN ('allocating', 'rapid')
        AND fad.candidate_deadline_at_ms <= auctions.opened_at_ms
        AND fad.deadline_locked_at_ms <= auctions.opened_at_ms
        AND starter.submitted_by_user_id =
          OLD.actor_user_id
        AND starter.status = 'active'
        AND starter.version = 1
        AND starter.edit_count = 0
        AND starter.first_submitted_at_ms =
          auctions.opened_at_ms
        AND starter.last_edited_at_ms =
          auctions.opened_at_ms
        AND starter.term_years BETWEEN 1 AND 3
        AND starter.total_value_cents >=
          starter.term_years * 100
        AND starter.lowest_offered_aav_cents >= 100
        AND starter.lowest_offered_aav_cents % 25 = 0
        AND starter.total_value_cents =
          starter.lowest_offered_aav_cents * starter.term_years
        AND starter.lowest_offered_total_value_cents =
          starter.total_value_cents
        AND starter.lowest_offered_aav_cents =
          (starter.total_value_cents / starter.term_years)
          + CASE
              WHEN (
                starter.total_value_cents %
                  starter.term_years
              ) * 2 >= starter.term_years
              THEN 1
              ELSE 0
            END
        AND started_event.actor_user_id =
          OLD.actor_user_id
        AND started_event.event_type = 'auction_started'
        AND started_event.occurred_at_ms =
          auctions.opened_at_ms
        AND json_valid(started_event.metadata_json) = 1
        AND json_type(started_event.metadata_json) =
          'object'
        AND (
          SELECT COUNT(*)
          FROM json_each(started_event.metadata_json)
        ) = 12
        AND json_type(
          started_event.metadata_json,
          '$.actorMembershipId'
        ) = 'text'
        AND json_type(
          started_event.metadata_json,
          '$.actorAuthority'
        ) = 'text'
        AND json_extract(
          started_event.metadata_json,
          '$.actorAuthority'
        ) IN ('manager', 'commissioner')
        AND json_type(
          started_event.metadata_json,
          '$.bindingIllegalityConfirmed'
        ) = 'true'
        AND json_extract(
          started_event.metadata_json,
          '$.bindingIllegalityConfirmed'
        ) = 1
        AND json_extract(
          started_event.metadata_json,
          '$.openingTeamId'
        ) = starter.team_id
        AND json_extract(
          started_event.metadata_json,
          '$.fadId'
        ) = auction_contexts.fad_id
        AND json_extract(
          started_event.metadata_json,
          '$.fadRolloverId'
        ) = auction_contexts.fad_rollover_id
        AND json_extract(
          started_event.metadata_json,
          '$.creationCutoffAtMs'
        ) = rollover.creation_cutoff_at_ms
        AND json_extract(
          started_event.metadata_json,
          '$.bidClosesAtMs'
        ) = auctions.resolves_at_ms
        AND json_extract(
          started_event.metadata_json,
          '$.totalValueCents'
        ) = starter.total_value_cents
        AND json_extract(
          started_event.metadata_json,
          '$.termYears'
        ) = starter.term_years
        AND json_extract(
          started_event.metadata_json,
          '$.aavCents'
        ) = starter.lowest_offered_aav_cents
        AND json_type(
          started_event.metadata_json,
          '$.playerPosition'
        ) = 'text'
        AND json_extract(
          started_event.metadata_json,
          '$.playerPosition'
        ) IN ('F', 'D')
        AND (
          (
            json_extract(
              started_event.metadata_json,
              '$.actorAuthority'
            ) = 'manager'
            AND EXISTS (
              SELECT 1
              FROM team_manager_assignments AS assignment
              JOIN league_memberships AS membership
                ON membership.league_id =
                    assignment.league_id
               AND membership.id =
                    assignment.membership_id
               AND membership.user_id =
                    assignment.user_id
              WHERE assignment.league_id =
                  starter.league_id
                AND assignment.team_id =
                  starter.team_id
                AND assignment.user_id =
                  starter.submitted_by_user_id
                AND assignment.membership_id =
                  json_extract(
                    started_event.metadata_json,
                    '$.actorMembershipId'
                  )
                AND assignment.status = 'accepted'
                AND assignment.ended_at_ms IS NULL
                AND membership.status = 'active'
            )
          )
          OR (
            json_extract(
              started_event.metadata_json,
              '$.actorAuthority'
            ) = 'commissioner'
            AND EXISTS (
              SELECT 1
              FROM league_memberships AS membership
              JOIN leagues
                ON leagues.id = membership.league_id
               AND leagues.commissioner_membership_id =
                    membership.id
              WHERE membership.league_id =
                  starter.league_id
                AND membership.id =
                  json_extract(
                    started_event.metadata_json,
                    '$.actorMembershipId'
                  )
                AND membership.user_id =
                  starter.submitted_by_user_id
                AND membership.status = 'active'
            )
          )
        )
        AND draw.algorithm_version = 1
        AND draw.ordered_tied_bid_ids_json IS NULL
        AND draw.ordered_tied_team_ids_json IS NULL
        AND draw.rejection_counter IS NULL
        AND draw.selected_index IS NULL
        AND draw.selected_bid_id IS NULL
        AND draw.selected_team_id IS NULL
        AND draw.selected_digest_hex IS NULL
        AND draw.revealed_at_ms IS NULL
        AND draw.created_at_ms = auctions.opened_at_ms
        AND draw.updated_at_ms = auctions.opened_at_ms
        AND draw.version = 1
        AND resolution_job.scheduled_for_ms =
          auctions.resolves_at_ms
        AND resolution_job.status = 'pending'
        AND resolution_job.attempt_count = 0
        AND resolution_job.lease_owner IS NULL
        AND resolution_job.lease_token IS NULL
        AND resolution_job.lease_expires_at_ms IS NULL
        AND resolution_job.started_at_ms IS NULL
        AND resolution_job.completed_at_ms IS NULL
        AND resolution_job.result_json IS NULL
        AND resolution_job.last_error_code IS NULL
        AND resolution_job.next_attempt_at_ms IS NULL
        AND resolution_job.created_at_ms =
          auctions.opened_at_ms
        AND resolution_job.updated_at_ms =
          auctions.opened_at_ms
        AND resolution_job.version = 1
        AND (
          SELECT COUNT(*)
          FROM auction_bids AS exact_starter
          WHERE exact_starter.league_id =
              auctions.league_id
            AND exact_starter.auction_id = auctions.id
        ) = 1
        AND (
          SELECT COUNT(*)
          FROM auction_events AS exact_started_event
          WHERE exact_started_event.league_id =
              auctions.league_id
            AND exact_started_event.auction_id =
              auctions.id
            AND exact_started_event.event_type =
              'auction_started'
        ) = 1
    )
  ) THEN RAISE(
    ABORT,
    'FAD immediate auction start must complete against exact private evidence'
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

CREATE TRIGGER season_matchup_schedule_generations_fad_timing_insert
BEFORE INSERT ON season_matchup_schedule_generations
WHEN NEW.fad_timing_json IS NOT NULL
BEGIN
  SELECT CASE WHEN (
    (SELECT count(*) FROM json_each(NEW.fad_timing_json)) = 2
    AND json_type(NEW.fad_timing_json, '$.candidateDeadlineAtMs') = 'integer'
    AND json_extract(NEW.fad_timing_json, '$.candidateDeadlineAtMs') > NEW.created_at_ms
    AND json_extract(NEW.fad_timing_json, '$.candidateDeadlineAtMs') < NEW.week_one_starts_at_ms
    AND json_type(NEW.fad_timing_json, '$.rolloverTimesAtMs') = 'array'
    AND json_array_length(NEW.fad_timing_json, '$.rolloverTimesAtMs') BETWEEN 1 AND 1000
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.fad_timing_json, '$.rolloverTimesAtMs') AS r
      WHERE r.type <> 'integer' OR r.value > NEW.week_one_starts_at_ms
        OR r.value <= CASE WHEN CAST(r.key AS INTEGER) = 0 THEN json_extract(NEW.fad_timing_json, '$.candidateDeadlineAtMs')
          ELSE json_extract(NEW.fad_timing_json, '$.rolloverTimesAtMs[' || (CAST(r.key AS INTEGER) - 1) || ']') END)
  ) IS NOT 1 THEN RAISE(ABORT, 'draft timetable must follow its deadline and finish before Week 1') END;
END;

CREATE TRIGGER season_matchup_schedule_generations_fad_timing_immutable
BEFORE UPDATE OF fad_timing_json ON season_matchup_schedule_generations
WHEN NEW.fad_timing_json IS NOT OLD.fad_timing_json
BEGIN SELECT RAISE(ABORT, 'a confirmed schedule generation has immutable draft timing'); END;

CREATE TRIGGER free_agent_drafts_initial_timing_insert
BEFORE INSERT ON free_agent_drafts
BEGIN
  SELECT CASE WHEN NEW.initial_rollover_times_json IS NULL AND EXISTS (
    SELECT 1 FROM season_matchup_schedule_generations AS generation
    WHERE generation.league_id = NEW.league_id AND generation.season_id = NEW.season_id
      AND generation.week_one_matchup_week_id = NEW.first_matchup_week_id
      AND generation.fad_timing_json IS NOT NULL
  ) THEN RAISE(ABORT, 'an explicitly configured draft timetable cannot revert to legacy defaults') END;
  SELECT CASE WHEN NEW.initial_rollover_times_json IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(NEW.initial_rollover_times_json) AS r
    WHERE r.type <> 'integer' OR r.value > NEW.first_matchup_starts_at_ms
      OR r.value <= CASE WHEN CAST(r.key AS INTEGER) = 0 THEN NEW.candidate_deadline_at_ms
        ELSE json_extract(NEW.initial_rollover_times_json, '$[' || (CAST(r.key AS INTEGER) - 1) || ']') END
  ) THEN RAISE(ABORT, 'initial draft rollovers must be ordered within the frozen timetable') END;
  SELECT CASE WHEN NEW.initial_rollover_times_json IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM season_matchup_schedule_generations AS generation
    WHERE generation.league_id = NEW.league_id AND generation.season_id = NEW.season_id
      AND generation.week_one_matchup_week_id = NEW.first_matchup_week_id
      AND generation.week_one_starts_at_ms = NEW.first_matchup_starts_at_ms
      AND json_extract(generation.fad_timing_json, '$.candidateDeadlineAtMs') = NEW.candidate_deadline_at_ms
      AND json_extract(generation.fad_timing_json, '$.rolloverTimesAtMs') = json(NEW.initial_rollover_times_json)
  ) THEN RAISE(ABORT, 'the frozen draft timetable must match its confirmed generation') END;
END;

CREATE TRIGGER free_agent_drafts_initial_timing_immutable
BEFORE UPDATE OF initial_rollover_times_json ON free_agent_drafts
WHEN NEW.initial_rollover_times_json IS NOT OLD.initial_rollover_times_json
BEGIN SELECT RAISE(ABORT, 'initial draft rollover instants are frozen after opening'); END;

UPDATE application_metadata SET metadata_value = '56', updated_at_ms = max(updated_at_ms, 56) WHERE metadata_key = 'data_model_version' AND metadata_value = '55';
