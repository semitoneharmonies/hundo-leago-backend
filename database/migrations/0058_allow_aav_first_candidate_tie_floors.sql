-- hundo-leago: foreign-key-rebuild

-- Permit exact quarter-dollar AAV Candidate tie floors, as already accepted by cards and participants.

-- Preserve legacy floors, every allocation row, and all existing indexes and trigger definitions.

DROP TRIGGER auction_bids_require_context_insert;

DROP TRIGGER auction_contexts_restricted_fallback_full_window_insert;

DROP TRIGGER auction_contexts_valid_insert;

DROP TRIGGER auctions_require_context_update;

DROP TRIGGER auctions_restricted_fallback_overlap_insert;

DROP TRIGGER fad_auction_bids_forward_update;

DROP TRIGGER fad_auction_resolution_failure_events_insert;

DROP TRIGGER fad_auction_resolutions_context_insert;

DROP TRIGGER fad_failed_auctions_recovery_update;

DROP TRIGGER fad_open_rapid_recovery_resolution_guard;

DROP TRIGGER free_agent_draft_allocation_correction_results_valid_insert;

DROP TRIGGER free_agent_draft_allocation_events_valid_insert;

DROP TRIGGER free_agent_draft_allocations_forward_update;

DROP TRIGGER free_agent_draft_allocations_immutable_delete;

DROP TRIGGER free_agent_draft_allocations_pending_insert;

DROP TRIGGER free_agent_draft_auction_participants_forward_update;

DROP TRIGGER free_agent_draft_auction_participants_valid_insert;

DROP TRIGGER free_agent_draft_draws_reveal_update;

DROP TRIGGER free_agent_draft_recoveries_forward_update;

DROP TRIGGER free_agent_draft_recoveries_valid_insert;

DROP TRIGGER free_agent_draft_rollovers_valid_insert;

DROP TRIGGER free_agent_drafts_allocation_completion_barrier;

DROP TRIGGER free_agent_drafts_allocation_start_barrier;

DROP TRIGGER free_agent_drafts_automatic_award_resources_barrier;

DROP TRIGGER free_agent_drafts_deadline_allocation_barrier;

DROP TRIGGER free_agent_drafts_final_completion_barrier;

DROP TRIGGER free_agent_drafts_forward_update;

DROP VIEW fad_frozen_eligible_bids;

CREATE TABLE free_agent_draft_player_allocations_aav_rebuild (
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
        OR (
          restricted_minimum_aav_cents % 25 = 0
          AND restricted_minimum_total_cents =
            restricted_minimum_aav_cents * restricted_minimum_term_years
        )
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

INSERT INTO free_agent_draft_player_allocations_aav_rebuild SELECT * FROM free_agent_draft_player_allocations;

DROP TABLE free_agent_draft_player_allocations;

ALTER TABLE free_agent_draft_player_allocations_aav_rebuild RENAME TO free_agent_draft_player_allocations;

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
        NEW.status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM auction_contexts AS context
          JOIN free_agent_draft_player_allocations AS allocation
            ON allocation.league_id = context.league_id
           AND allocation.season_id = context.season_id
           AND allocation.fad_id = context.fad_id
           AND allocation.id = context.fad_allocation_id
           AND allocation.player_id = NEW.player_id
          JOIN auction_resolutions AS resolution
            ON resolution.league_id = context.league_id
           AND resolution.season_id = context.season_id
           AND resolution.auction_id = context.auction_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.allocation_id = context.fad_allocation_id
           AND draw.auction_id = context.auction_id
          JOIN commissioner_corrections AS correction
            ON correction.league_id = allocation.league_id
           AND correction.season_id = allocation.season_id
           AND correction.feature =
                'free_agent_draft_allocation'
           AND correction.feature_record_id = allocation.id
           AND correction.corrected_at_ms = NEW.updated_at_ms
          JOIN auction_events AS event
            ON event.league_id = context.league_id
           AND event.season_id = context.season_id
           AND event.auction_id = context.auction_id
           AND event.event_type = 'auction_cancelled'
           AND event.actor_user_id = correction.actor_user_id
           AND event.occurred_at_ms = correction.corrected_at_ms
          WHERE context.league_id = NEW.league_id
            AND context.season_id = NEW.season_id
            AND context.auction_id = NEW.id
            AND (
              (
                context.source_kind = 'fad_restricted'
                AND context.fad_origin =
                  'candidate_tie_restricted'
                AND allocation.restricted_auction_id = NEW.id
                AND allocation.status IN (
                  'restricted_scheduled',
                  'restricted_active',
                  'correction_required'
                )
              )
              OR (
                context.source_kind = 'fad_open_rapid'
                AND context.fad_origin =
                  'restricted_no_improvement_fallback'
                AND allocation.fallback_open_auction_id = NEW.id
                AND allocation.status IN (
                  'restricted_fallback_open',
                  'correction_required'
                )
              )
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
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.version'
                ) = allocation.version
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.status'
                ) = allocation.status
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.version'
                ) = allocation.version + 1
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.status'
                ) IN ('automatic_award', 'no_valid_offer')
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.decisionCode'
                ) = 'corrected'
            AND json_extract(
                  event.metadata_json,
                  '$.correctionId'
                ) = correction.id
            AND json_extract(
                  event.metadata_json,
                  '$.actorAuthority'
                ) IN (
                  'commissioner',
                  'platform_administrator_as_commissioner'
                )
            AND NOT EXISTS (
              SELECT 1
              FROM auction_bids AS bid
              WHERE bid.league_id = NEW.league_id
                AND bid.auction_id = NEW.id
            )
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
                    AND (
                      auction_contexts.fad_origin =
                        'restricted_no_improvement_fallback'
                      OR (
                        auction_contexts.fad_origin IN (
                          'manager_nomination',
                          'queued_nomination'
                        )
                        AND auction_contexts.fad_allocation_id
                          IS NULL
                        AND EXISTS (
                          SELECT 1
                          FROM auction_events AS starter_event
                          JOIN auction_bids AS starter_bid
                            ON starter_bid.league_id =
                                starter_event.league_id
                           AND starter_bid.season_id =
                                starter_event.season_id
                           AND starter_bid.auction_id =
                                starter_event.auction_id
                           AND starter_bid.id =
                                starter_event.bid_id
                           AND starter_bid.team_id =
                                starter_event.team_id
                          WHERE starter_event.league_id =
                              auction_contexts.league_id
                            AND starter_event.season_id =
                              auction_contexts.season_id
                            AND starter_event.auction_id =
                              auction_contexts.auction_id
                            AND starter_event.event_type =
                              'auction_started'
                            AND starter_event.occurred_at_ms =
                              auctions.opened_at_ms
                            AND (
                              SELECT COUNT(*)
                              FROM auction_events AS exact_event
                              WHERE exact_event.league_id =
                                  starter_event.league_id
                                AND exact_event.season_id =
                                  starter_event.season_id
                                AND exact_event.auction_id =
                                  starter_event.auction_id
                                AND exact_event.event_type =
                                  'auction_started'
                            ) = 1
                            AND (
                              (
                                auction_contexts.fad_origin =
                                  'manager_nomination'
                                AND NOT EXISTS (
                                  SELECT 1
                                  FROM free_agent_draft_nomination_queue
                                    AS direct_queue
                                  WHERE direct_queue.league_id =
                                      auction_contexts.league_id
                                    AND direct_queue.opened_auction_id =
                                      auction_contexts.auction_id
                                )
                              )
                              OR (
                                auction_contexts.fad_origin =
                                  'queued_nomination'
                                AND EXISTS (
                                  SELECT 1
                                  FROM free_agent_draft_nomination_queue
                                    AS queued_start
                                  WHERE queued_start.league_id =
                                      auction_contexts.league_id
                                    AND queued_start.season_id =
                                      auction_contexts.season_id
                                    AND queued_start.fad_id =
                                      auction_contexts.fad_id
                                    AND queued_start.status = 'opened'
                                    AND queued_start.opened_auction_id =
                                      auction_contexts.auction_id
                                    AND queued_start.opened_starter_bid_id =
                                      starter_event.bid_id
                                    AND queued_start.team_id =
                                      starter_event.team_id
                                    AND queued_start.opened_at_ms =
                                      auctions.opened_at_ms
                                )
                              )
                            )
                        )
                      )
                    )
                    AND NEW.edit_count <= CASE
                      WHEN auction_contexts.fad_origin IN (
                        'manager_nomination',
                        'queued_nomination'
                      )
                      AND EXISTS (
                        SELECT 1
                        FROM auction_events AS starter_event
                        WHERE starter_event.league_id = OLD.league_id
                          AND starter_event.season_id = OLD.season_id
                          AND starter_event.auction_id = OLD.auction_id
                          AND starter_event.bid_id = OLD.id
                          AND starter_event.team_id = OLD.team_id
                          AND starter_event.event_type =
                            'auction_started'
                          AND starter_event.occurred_at_ms =
                            auctions.opened_at_ms
                      )
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
        AND free_agent_draft_recoveries.created_at_ms <=
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
    AND NOT EXISTS (
      SELECT 1
      FROM auction_events AS later_failure
      WHERE later_failure.league_id = NEW.league_id
        AND later_failure.season_id = NEW.season_id
        AND later_failure.auction_id = NEW.auction_id
        AND later_failure.event_type =
          'fad_auction_resolution_failed'
        AND later_failure.occurred_at_ms >=
          NEW.occurred_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'FAD operational failure requires its exact private draw, job, and recovery'
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
      WHERE free_agent_draft_draws.league_id = NEW.league_id
        AND free_agent_draft_draws.season_id = NEW.season_id
        AND free_agent_draft_draws.auction_id = NEW.auction_id
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
          ON player_ownerships.league_id = auction_bids.league_id
         AND player_ownerships.id = NEW.ownership_id
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status IN ('resolving', 'resolved')
          AND NEW.resolved_at_ms >= auctions.resolves_at_ms
          AND auction_bids.id = NEW.winning_bid_id
          AND auction_bids.team_id = NEW.winning_team_id
          AND auction_bids.status = 'won'
          AND auction_bids.total_value_cents = NEW.highest_bid_cents
          AND auction_bids.term_years = NEW.winning_term_years
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
          AND contracts.current_team_id = NEW.winning_team_id
          AND contracts.start_season_id = NEW.season_id
          AND contracts.original_total_value_cents =
            NEW.final_contract_value_cents
          AND contracts.original_term_years = NEW.winning_term_years
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
          AND auction_contexts.source_kind = 'fad_restricted'
      )
    )
    OR (
      NEW.status = 'cancelled'
      AND NEW.outcome_code = 'recovered'
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
        FROM auctions AS auction
        JOIN auction_contexts AS context
          ON context.league_id = auction.league_id
         AND context.season_id = auction.season_id
         AND context.auction_id = auction.id
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = context.league_id
         AND allocation.season_id = context.season_id
         AND allocation.fad_id = context.fad_id
         AND allocation.id = context.fad_allocation_id
         AND allocation.player_id = auction.player_id
        JOIN free_agent_draft_draws AS draw
          ON draw.league_id = context.league_id
         AND draw.season_id = context.season_id
         AND draw.fad_id = context.fad_id
         AND draw.allocation_id = context.fad_allocation_id
         AND draw.auction_id = context.auction_id
        JOIN commissioner_corrections AS correction
          ON correction.league_id = allocation.league_id
         AND correction.season_id = allocation.season_id
         AND correction.feature =
              'free_agent_draft_allocation'
         AND correction.feature_record_id = allocation.id
         AND correction.actor_user_id = NEW.triggered_by_user_id
         AND correction.corrected_at_ms = NEW.resolved_at_ms
        JOIN auction_events AS event
          ON event.league_id = auction.league_id
         AND event.season_id = auction.season_id
         AND event.auction_id = auction.id
         AND event.event_type = 'auction_cancelled'
         AND event.actor_user_id = correction.actor_user_id
         AND event.occurred_at_ms = correction.corrected_at_ms
        WHERE auction.league_id = NEW.league_id
          AND auction.season_id = NEW.season_id
          AND auction.id = NEW.auction_id
          AND auction.status = 'resolving'
          AND auction.created_at_ms <= NEW.resolved_at_ms
          AND draw.created_at_ms <= NEW.resolved_at_ms
          AND draw.revealed_at_ms IS NULL
          AND draw.version = 1
          AND draw.ordered_tied_bid_ids_json IS NULL
          AND draw.ordered_tied_team_ids_json IS NULL
          AND draw.rejection_counter IS NULL
          AND draw.selected_index IS NULL
          AND draw.selected_bid_id IS NULL
          AND draw.selected_team_id IS NULL
          AND draw.selected_digest_hex IS NULL
          AND (
            (
              context.source_kind = 'fad_restricted'
              AND context.fad_origin =
                'candidate_tie_restricted'
              AND allocation.restricted_auction_id = auction.id
              AND allocation.status IN (
                'restricted_scheduled',
                'restricted_active',
                'correction_required'
              )
            )
            OR (
              context.source_kind = 'fad_open_rapid'
              AND context.fad_origin =
                'restricted_no_improvement_fallback'
              AND allocation.fallback_open_auction_id = auction.id
              AND allocation.status IN (
                'restricted_fallback_open',
                'correction_required'
              )
            )
          )
          AND json_valid(correction.before_snapshot_json) = 1
          AND json_valid(correction.after_snapshot_json) = 1
          AND json_extract(
                correction.before_snapshot_json,
                '$.version'
              ) = allocation.version
          AND json_extract(
                correction.before_snapshot_json,
                '$.status'
              ) = allocation.status
          AND json_extract(
                correction.after_snapshot_json,
                '$.version'
              ) = allocation.version + 1
          AND json_extract(
                correction.after_snapshot_json,
                '$.status'
              ) IN ('automatic_award', 'no_valid_offer')
          AND json_extract(
                correction.after_snapshot_json,
                '$.decisionCode'
              ) = 'corrected'
          AND json_extract(
                event.metadata_json,
                '$.correctionId'
              ) = correction.id
          AND json_extract(
                event.metadata_json,
                '$.actorAuthority'
              ) IN (
                'commissioner',
                'platform_administrator_as_commissioner'
              )
          AND NOT EXISTS (
            SELECT 1
            FROM auction_bids AS bid
            WHERE bid.league_id = auction.league_id
              AND bid.auction_id = auction.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM auction_resolutions AS prior_resolution
            WHERE prior_resolution.league_id = auction.league_id
              AND prior_resolution.auction_id = auction.id
          )
          AND EXISTS (
            SELECT 1
            FROM league_memberships AS membership
            WHERE membership.league_id = correction.league_id
              AND membership.user_id = correction.actor_user_id
              AND membership.status = 'active'
              AND (
                (
                  json_extract(
                    event.metadata_json,
                    '$.actorAuthority'
                  ) = 'commissioner'
                  AND EXISTS (
                    SELECT 1
                    FROM leagues AS league
                    WHERE league.id = correction.league_id
                      AND league.commissioner_membership_id =
                          membership.id
                  )
                )
                OR (
                  json_extract(
                    event.metadata_json,
                    '$.actorAuthority'
                  ) =
                    'platform_administrator_as_commissioner'
                  AND EXISTS (
                    SELECT 1
                    FROM platform_roles AS role
                    WHERE role.user_id = correction.actor_user_id
                      AND role.role = 'platform_administrator'
                      AND role.status = 'active'
                  )
                )
              )
          )
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
          AND auction_contexts.source_kind = 'fad_open_rapid'
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
        OR auction_events.actor_user_id = NEW.triggered_by_user_id
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
            'auction:' || auctions.id || ':' || auctions.resolves_at_ms
       AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms > NEW.resolved_at_ms
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
          AND free_agent_draft_recoveries.kind = 'auction_resolution'
          AND free_agent_draft_recoveries.status =
            'correction_required'
          AND free_agent_draft_recoveries.created_at_ms =
            NEW.resolved_at_ms
          AND free_agent_draft_recoveries.resolved_at_ms IS NULL
      )
    )
    OR (
      NEW.outcome_code = 'recovered'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts AS context
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = context.league_id
         AND allocation.season_id = context.season_id
         AND allocation.fad_id = context.fad_id
         AND allocation.id = context.fad_allocation_id
        JOIN commissioner_corrections AS correction
          ON correction.league_id = allocation.league_id
         AND correction.season_id = allocation.season_id
         AND correction.feature =
              'free_agent_draft_allocation'
         AND correction.feature_record_id = allocation.id
         AND correction.actor_user_id = NEW.triggered_by_user_id
         AND correction.corrected_at_ms = NEW.resolved_at_ms
        WHERE context.league_id = NEW.league_id
          AND context.season_id = NEW.season_id
          AND context.auction_id = NEW.auction_id
          AND context.source_kind = 'fad_restricted'
          AND allocation.restricted_auction_id = NEW.auction_id
          AND allocation.status IN (
            'restricted_scheduled',
            'restricted_active',
            'correction_required'
          )
          AND json_extract(
                correction.before_snapshot_json,
                '$.version'
              ) = allocation.version
          AND json_extract(
                correction.before_snapshot_json,
                '$.status'
              ) = allocation.status
          AND json_extract(
                correction.after_snapshot_json,
                '$.version'
              ) = allocation.version + 1
          AND json_extract(
                correction.after_snapshot_json,
                '$.status'
              ) IN ('automatic_award', 'no_valid_offer')
          AND json_extract(
                correction.after_snapshot_json,
                '$.decisionCode'
              ) = 'corrected'
      )
    )
  ) THEN RAISE(
    ABORT,
    'restricted result must reconcile its exact allocation and recovery state'
  ) END;

  SELECT CASE WHEN
    NEW.outcome_code = 'recovered'
    AND NOT (
      EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN free_agent_draft_recoveries AS recovery
        ON recovery.league_id = auction_contexts.league_id
       AND recovery.season_id = auction_contexts.season_id
       AND recovery.fad_id = auction_contexts.fad_id
       AND recovery.player_id = (
            SELECT player_id
            FROM auctions
            WHERE auctions.league_id = NEW.league_id
              AND auctions.id = NEW.auction_id
          )
       AND recovery.allocation_id IS
            auction_contexts.fad_allocation_id
       AND recovery.rollover_id =
            auction_contexts.fad_rollover_id
       AND recovery.auction_id = auction_contexts.auction_id
      JOIN job_runs AS job
        ON job.league_id = recovery.league_id
       AND job.season_id = recovery.season_id
       AND job.id = recovery.job_run_id
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind = 'fad_open_rapid'
        AND recovery.kind = 'auction_resolution'
        AND recovery.status = 'running'
        AND recovery.resolved_at_ms IS NULL
        AND recovery.resolved_by_user_id IS NULL
        AND recovery.resolved_by_membership_id IS NULL
        AND recovery.resolved_authority IS NULL
        AND recovery.updated_at_ms <= NEW.resolved_at_ms
        AND recovery.created_by_operation_id = job.id
        AND job.job_type = 'auction.resolve.target'
        AND job.occurrence_key = NEW.scheduled_occurrence_key
        AND job.status IN ('leased', 'running')
        AND job.attempt_count >= 1
        AND job.lease_owner IS NOT NULL
        AND job.lease_token IS NOT NULL
        AND job.lease_expires_at_ms > NEW.resolved_at_ms
        AND job.completed_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM league_memberships AS membership
          WHERE membership.league_id = NEW.league_id
            AND membership.user_id = NEW.triggered_by_user_id
            AND membership.status = 'active'
            AND (
              EXISTS (
                SELECT 1
                FROM leagues AS league
                WHERE league.id = NEW.league_id
                  AND league.commissioner_membership_id = membership.id
              )
              OR EXISTS (
                SELECT 1
                FROM platform_roles AS role
                WHERE role.user_id = NEW.triggered_by_user_id
                  AND role.role = 'platform_administrator'
                  AND role.status = 'active'
              )
            )
        )
      )
      OR EXISTS (
        SELECT 1
        FROM auction_contexts AS context
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = context.league_id
         AND allocation.season_id = context.season_id
         AND allocation.fad_id = context.fad_id
         AND allocation.id = context.fad_allocation_id
        JOIN commissioner_corrections AS correction
          ON correction.league_id = allocation.league_id
         AND correction.season_id = allocation.season_id
         AND correction.feature =
              'free_agent_draft_allocation'
         AND correction.feature_record_id = allocation.id
         AND correction.actor_user_id = NEW.triggered_by_user_id
         AND correction.corrected_at_ms = NEW.resolved_at_ms
        WHERE context.league_id = NEW.league_id
          AND context.season_id = NEW.season_id
          AND context.auction_id = NEW.auction_id
          AND context.source_kind IN (
            'fad_restricted',
            'fad_open_rapid'
          )
          AND (
            (
              context.source_kind = 'fad_restricted'
              AND allocation.restricted_auction_id = NEW.auction_id
            )
            OR (
              context.source_kind = 'fad_open_rapid'
              AND context.fad_origin =
                'restricted_no_improvement_fallback'
              AND allocation.fallback_open_auction_id = NEW.auction_id
            )
          )
          AND json_extract(
                correction.before_snapshot_json,
                '$.version'
              ) = allocation.version
          AND json_extract(
                correction.before_snapshot_json,
                '$.status'
              ) = allocation.status
          AND json_extract(
                correction.after_snapshot_json,
                '$.version'
              ) = allocation.version + 1
          AND json_extract(
                correction.after_snapshot_json,
                '$.status'
              ) IN ('automatic_award', 'no_valid_offer')
          AND json_extract(
                correction.after_snapshot_json,
                '$.decisionCode'
              ) = 'corrected'
      )
    )
  THEN RAISE(
    ABORT,
    'recovered open FAD cancellation requires its running recovery and exact active operation'
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

CREATE TRIGGER fad_open_rapid_recovery_resolution_guard
BEFORE UPDATE OF status ON free_agent_draft_recoveries
WHEN OLD.status = 'running'
  AND NEW.status = 'resolved'
  AND NEW.kind = 'auction_resolution'
  AND EXISTS (
    SELECT 1
    FROM auction_contexts AS context
    WHERE context.league_id = NEW.league_id
      AND context.season_id = NEW.season_id
      AND context.fad_id = NEW.fad_id
      AND context.auction_id = NEW.auction_id
      AND context.source_kind = 'fad_open_rapid'
  )
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
    SELECT 1
    FROM auction_contexts AS context
    JOIN auctions AS auction
      ON auction.league_id = context.league_id
     AND auction.season_id = context.season_id
     AND auction.id = context.auction_id
    JOIN auction_resolutions AS resolution
      ON resolution.league_id = auction.league_id
     AND resolution.season_id = auction.season_id
     AND resolution.auction_id = auction.id
    JOIN free_agent_draft_draws AS draw
      ON draw.league_id = context.league_id
     AND draw.season_id = context.season_id
     AND draw.fad_id = context.fad_id
     AND draw.allocation_id IS context.fad_allocation_id
     AND draw.auction_id = context.auction_id
    JOIN job_runs AS job
      ON job.league_id = NEW.league_id
     AND job.season_id = NEW.season_id
     AND job.id = NEW.job_run_id
    JOIN auction_events AS failure_event
      ON failure_event.league_id = context.league_id
     AND failure_event.season_id = context.season_id
     AND failure_event.auction_id = context.auction_id
     AND failure_event.event_type = 'fad_auction_resolution_failed'
    WHERE context.league_id = NEW.league_id
      AND context.season_id = NEW.season_id
      AND context.fad_id = NEW.fad_id
      AND context.auction_id = NEW.auction_id
      AND context.fad_allocation_id IS NEW.allocation_id
      AND context.fad_rollover_id = NEW.rollover_id
      AND context.source_kind = 'fad_open_rapid'
      AND auction.player_id = NEW.player_id
      AND auction.status = 'cancelled'
      AND auction.updated_at_ms = NEW.resolved_at_ms
      AND resolution.status = 'cancelled'
      AND resolution.outcome_code = 'recovered'
      AND resolution.trigger_type = 'commissioner'
      AND resolution.triggered_by_user_id = NEW.resolved_by_user_id
      AND resolution.resolved_at_ms = NEW.resolved_at_ms
      AND draw.revealed_at_ms = NEW.resolved_at_ms
      AND draw.version = 2
      AND draw.ordered_tied_bid_ids_json = '[]'
      AND draw.ordered_tied_team_ids_json = '[]'
      AND draw.selected_bid_id IS NULL
      AND draw.selected_team_id IS NULL
      AND job.job_type = 'auction.resolve.target'
      AND job.occurrence_key = resolution.scheduled_occurrence_key
      AND job.status IN ('leased', 'running')
      AND job.attempt_count >= 1
      AND job.lease_owner IS NOT NULL
      AND job.lease_token IS NOT NULL
      AND job.lease_expires_at_ms > NEW.resolved_at_ms
      AND job.completed_at_ms IS NULL
      AND NEW.created_by_operation_id = job.id
      AND NEW.last_error_code IS NULL
      AND failure_event.actor_user_id IS NULL
      AND failure_event.bid_id IS NULL
      AND failure_event.team_id IS NULL
      AND NEW.created_at_ms <=
        failure_event.occurred_at_ms
      AND failure_event.occurred_at_ms <=
        NEW.resolved_at_ms
      AND json_extract(
            failure_event.metadata_json,
            '$.recoveryId'
          ) = NEW.id
      AND json_extract(
            failure_event.metadata_json,
            '$.jobRunId'
          ) = NEW.job_run_id
      AND json_extract(
            failure_event.metadata_json,
            '$.errorCode'
          ) = OLD.last_error_code
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
              ) = NEW.id
          AND json_extract(
                later_failure.metadata_json,
                '$.jobRunId'
              ) = NEW.job_run_id
          AND later_failure.occurred_at_ms >
            failure_event.occurred_at_ms
      )
      AND EXISTS (
        SELECT 1
        FROM league_memberships AS membership
        WHERE membership.league_id = NEW.league_id
          AND membership.id = NEW.resolved_by_membership_id
          AND membership.user_id = NEW.resolved_by_user_id
          AND membership.status = 'active'
          AND (
            (
              NEW.resolved_authority = 'commissioner'
              AND EXISTS (
                SELECT 1
                FROM leagues AS league
                WHERE league.id = NEW.league_id
                  AND league.commissioner_membership_id =
                    membership.id
              )
            )
            OR (
              NEW.resolved_authority =
                'platform_administrator_as_commissioner'
              AND EXISTS (
                SELECT 1
                FROM platform_roles AS role
                WHERE role.user_id = NEW.resolved_by_user_id
                  AND role.role = 'platform_administrator'
                  AND role.status = 'active'
              )
            )
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM auction_contexts AS context
      JOIN auctions AS auction
        ON auction.league_id = context.league_id
       AND auction.season_id = context.season_id
       AND auction.id = context.auction_id
      JOIN auction_resolutions AS resolution
        ON resolution.league_id = auction.league_id
       AND resolution.season_id = auction.season_id
       AND resolution.auction_id = auction.id
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = context.league_id
       AND draw.season_id = context.season_id
       AND draw.fad_id = context.fad_id
       AND draw.allocation_id IS context.fad_allocation_id
       AND draw.auction_id = context.auction_id
      JOIN job_runs AS job
        ON job.league_id = NEW.league_id
       AND job.season_id = NEW.season_id
       AND job.id = NEW.job_run_id
      JOIN auction_events AS failure_event
        ON failure_event.league_id = context.league_id
       AND failure_event.season_id = context.season_id
       AND failure_event.auction_id = context.auction_id
       AND failure_event.event_type =
            'fad_auction_resolution_failed'
      JOIN free_agent_draft_recovery_action_command_results AS receipt
        ON receipt.league_id = NEW.league_id
       AND receipt.season_id = NEW.season_id
       AND receipt.fad_id = NEW.fad_id
       AND receipt.recovery_id = NEW.id
       AND receipt.job_run_id = NEW.job_run_id
      JOIN idempotency_requests AS request
        ON request.league_id = receipt.league_id
       AND request.id = receipt.idempotency_request_id
      WHERE context.league_id = NEW.league_id
        AND context.season_id = NEW.season_id
        AND context.fad_id = NEW.fad_id
        AND context.auction_id = NEW.auction_id
        AND context.fad_allocation_id IS NEW.allocation_id
        AND context.fad_rollover_id = NEW.rollover_id
        AND context.source_kind = 'fad_open_rapid'
        AND auction.player_id = NEW.player_id
        AND resolution.outcome_code IN ('winner', 'no_winner')
        AND auction.status = CASE resolution.outcome_code
          WHEN 'winner' THEN 'resolved'
          ELSE 'no_winner'
        END
        AND auction.updated_at_ms = NEW.resolved_at_ms
        AND resolution.status = CASE resolution.outcome_code
          WHEN 'winner' THEN 'resolved'
          ELSE 'no_winner'
        END
        AND resolution.trigger_type = 'automatic'
        AND resolution.triggered_by_user_id IS NULL
        AND resolution.resolved_at_ms = NEW.resolved_at_ms
        AND draw.revealed_at_ms = NEW.resolved_at_ms
        AND draw.version = 2
        AND job.job_type = 'auction.resolve.target'
        AND job.occurrence_key =
          resolution.scheduled_occurrence_key
        AND job.scheduled_for_ms = auction.resolves_at_ms
        AND job.status = 'running'
        AND job.attempt_count >= 2
        AND job.lease_owner IS NOT NULL
        AND job.lease_token IS NOT NULL
        AND job.lease_expires_at_ms > NEW.resolved_at_ms
        AND job.started_at_ms IS NOT NULL
        AND job.started_at_ms <= NEW.resolved_at_ms
        AND job.completed_at_ms IS NULL
        AND job.result_json IS NULL
        AND job.last_error_code IS NULL
        AND job.next_attempt_at_ms IS NULL
        AND job.updated_at_ms <= NEW.resolved_at_ms
        AND NEW.created_by_operation_id = job.id
        AND NEW.last_error_code IS NULL
        AND NEW.resolved_by_user_id IS NULL
        AND NEW.resolved_by_membership_id IS NULL
        AND NEW.resolved_authority = 'system'
        AND NEW.created_at_ms <=
          failure_event.occurred_at_ms
        AND failure_event.occurred_at_ms <=
          NEW.resolved_at_ms
        AND failure_event.actor_user_id IS NULL
        AND failure_event.bid_id IS NULL
        AND failure_event.team_id IS NULL
        AND json_extract(
              failure_event.metadata_json,
              '$.recoveryId'
            ) = NEW.id
        AND json_extract(
              failure_event.metadata_json,
              '$.jobRunId'
            ) = NEW.job_run_id
        AND json_extract(
              failure_event.metadata_json,
              '$.errorCode'
            ) = OLD.last_error_code
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
                ) = NEW.id
            AND json_extract(
                  later_failure.metadata_json,
                  '$.jobRunId'
                ) = NEW.job_run_id
            AND later_failure.occurred_at_ms >
              failure_event.occurred_at_ms
        )
        AND receipt.action = 'retry_auction_resolution'
        AND receipt.resource_kind = 'auction'
        AND receipt.resource_id = auction.id
        AND receipt.operation_id = job.id
        AND receipt.occurrence_key = job.occurrence_key
        AND receipt.commissioner_reason = NEW.commissioner_reason
        AND receipt.accepted_status = 'pending'
        AND receipt.accepted_at_ms >=
          failure_event.occurred_at_ms
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
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_recovery_action_command_results
            AS later_receipt
          WHERE later_receipt.league_id = receipt.league_id
            AND later_receipt.recovery_id = receipt.recovery_id
            AND later_receipt.action = 'retry_auction_resolution'
            AND (
              later_receipt.accepted_at_ms > receipt.accepted_at_ms
              OR (
                later_receipt.accepted_at_ms = receipt.accepted_at_ms
                AND later_receipt.id > receipt.id
              )
            )
        )
        AND (
          (
            context.fad_allocation_id IS NULL
            AND NEW.allocation_id IS NULL
          )
          OR (
            context.fad_allocation_id IS NOT NULL
            AND NEW.allocation_id = context.fad_allocation_id
            AND context.fad_origin =
              'restricted_no_improvement_fallback'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations AS allocation
              WHERE allocation.league_id = context.league_id
                AND allocation.season_id = context.season_id
                AND allocation.fad_id = context.fad_id
                AND allocation.id = context.fad_allocation_id
                AND allocation.player_id = auction.player_id
                AND allocation.fallback_open_auction_id = auction.id
                AND allocation.status = 'fallback_open_resolved'
                AND allocation.decision_code =
                  CASE resolution.outcome_code
                    WHEN 'winner' THEN 'fallback_open_result'
                    ELSE 'fallback_open_no_winner'
                  END
                AND allocation.accounted_at_ms = NEW.resolved_at_ms
                AND allocation.updated_at_ms = NEW.resolved_at_ms
                AND allocation.last_error_code IS NULL
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'open rapid recovery resolution requires its exact latest failure, live operation, terminal result, draw, and authority evidence'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocation_correction_results_valid_insert
BEFORE INSERT ON free_agent_draft_allocation_correction_command_results
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.resulting_allocation_version =
      NEW.accepted_from_allocation_version + 1
    AND json_type(NEW.request_json, '$.reason') = 'text'
    AND json_extract(NEW.request_json, '$.reason') =
      trim(json_extract(NEW.request_json, '$.reason'))
    AND length(json_extract(NEW.request_json, '$.reason'))
      BETWEEN 1 AND 500
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests AS request
      WHERE request.league_id = NEW.league_id
        AND request.id = NEW.idempotency_request_id
        AND request.actor_user_id = NEW.actor_user_id
        AND request.operation =
          'free_agent_draft.allocation.correction'
        AND request.request_hash = NEW.request_sha256
        AND request.status = 'started'
        AND request.result_type IS NULL
        AND request.result_id IS NULL
        AND request.completed_at_ms IS NULL
        AND request.created_at_ms = NEW.completed_at_ms
        AND request.expires_at_ms > NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships AS membership
      JOIN users AS actor
        ON actor.id = membership.user_id
      WHERE membership.league_id = NEW.league_id
        AND membership.id = NEW.actor_membership_id
        AND membership.user_id = NEW.actor_user_id
        AND membership.status = 'active'
        AND actor.status = 'active'
        AND (
          (
            NEW.actor_authority = 'commissioner'
            AND EXISTS (
              SELECT 1
              FROM leagues AS league
              WHERE league.id = NEW.league_id
                AND league.commissioner_membership_id =
                  NEW.actor_membership_id
            )
          )
          OR (
            NEW.actor_authority =
              'platform_administrator_as_commissioner'
            AND EXISTS (
              SELECT 1
              FROM platform_roles AS role
              WHERE role.user_id = NEW.actor_user_id
                AND role.role = 'platform_administrator'
                AND role.status = 'active'
            )
          )
        )
    )
    AND EXISTS (
      SELECT 1
      FROM commissioner_corrections AS correction
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = correction.league_id
       AND allocation.season_id = correction.season_id
       AND allocation.id = correction.feature_record_id
      JOIN free_agent_draft_allocation_events AS correction_event
        ON correction_event.league_id = allocation.league_id
       AND correction_event.season_id = allocation.season_id
       AND correction_event.fad_id = allocation.fad_id
       AND correction_event.allocation_id = allocation.id
       AND correction_event.allocation_version = allocation.version
       AND correction_event.player_id = allocation.player_id
       AND correction_event.correction_id = correction.id
      WHERE correction.league_id = NEW.league_id
        AND correction.season_id = NEW.season_id
        AND correction.id = NEW.commissioner_correction_id
        AND correction.feature = 'free_agent_draft_allocation'
        AND correction.feature_record_id = NEW.allocation_id
        AND correction.actor_user_id = NEW.actor_user_id
        AND correction.reason =
          json_extract(NEW.request_json, '$.reason')
        AND correction.corrected_at_ms = NEW.completed_at_ms
        AND json_valid(correction.before_snapshot_json) = 1
        AND json_valid(correction.after_snapshot_json) = 1
        AND json_extract(
              correction.before_snapshot_json,
              '$.version'
            ) = NEW.accepted_from_allocation_version
        AND json_extract(
              correction.after_snapshot_json,
              '$.version'
            ) = NEW.resulting_allocation_version
        AND json_extract(
              correction.after_snapshot_json,
              '$.decisionCode'
            ) = 'corrected'
        AND allocation.fad_id = NEW.fad_id
        AND allocation.player_id = NEW.player_id
        AND allocation.version = NEW.resulting_allocation_version
        AND allocation.decision_code = 'corrected'
        AND allocation.updated_at_ms = NEW.completed_at_ms
        AND allocation.accounted_at_ms = NEW.completed_at_ms
        AND allocation.last_error_code IS NULL
        AND correction_event.event_kind = 'correction_applied'
        AND correction_event.decision_code = 'corrected'
        AND correction_event.resulting_allocation_status =
          allocation.status
        AND correction_event.contract_id IS allocation.contract_id
        AND correction_event.ownership_id IS allocation.ownership_id
        AND correction_event.actor_user_id = NEW.actor_user_id
        AND correction_event.actor_membership_id =
          NEW.actor_membership_id
        AND correction_event.actor_authority = NEW.actor_authority
        AND correction_event.activity_id IS NULL
        AND correction_event.occurred_at_ms = NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM league_activity AS activity
      WHERE activity.league_id = NEW.league_id
        AND activity.season_id = NEW.season_id
        AND activity.id = NEW.activity_id
        AND activity.actor_user_id = NEW.actor_user_id
        AND activity.actor_authority = NEW.actor_authority
        AND activity.player_id = NEW.player_id
        AND activity.related_type =
          'free_agent_draft_allocation'
        AND activity.related_id = NEW.allocation_id
        AND activity.occurred_at_ms = NEW.completed_at_ms
    )
    AND json_extract(NEW.preview_json, '$.allocationId') =
      NEW.allocation_id
    AND json_extract(NEW.preview_json, '$.allocationVersion') =
      NEW.accepted_from_allocation_version
    AND json_extract(NEW.preview_json, '$.reversible') = 1
    AND json_extract(NEW.preview_json, '$.confirmationText') =
      'APPLY FAD CORRECTION'
    AND NEW.request_json = json_object(
      'allocationId', NEW.allocation_id,
      'confirmation', 'APPLY FAD CORRECTION',
      'domain', 'hundo-leago.fad-allocation-correction-request',
      'fadId', NEW.fad_id,
      'leagueId', NEW.league_id,
      'mode', 'recompute_locked_snapshot',
      'previewFingerprint', NEW.preview_fingerprint,
      'reason', json_extract(NEW.request_json, '$.reason'),
      'schemaVersion', 1
    )
    AND (
      SELECT COUNT(*)
      FROM json_each(NEW.response_json)
    ) = 5
    AND json_extract(NEW.response_json, '$.activityId') =
      NEW.activity_id
    AND json_extract(
          NEW.response_json,
          '$.allocation.allocationId'
        ) = NEW.allocation_id
    AND json_extract(
          NEW.response_json,
          '$.allocation.allocationVersion'
        ) = NEW.resulting_allocation_version
    AND json_type(NEW.response_json, '$.appliedDeltas') = 'array'
    AND json_extract(NEW.response_json, '$.completedAtMs') =
      NEW.completed_at_ms
    AND json_extract(NEW.response_json, '$.correctionId') =
      NEW.commissioner_correction_id
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_recoveries AS recovery
      WHERE recovery.league_id = NEW.league_id
        AND recovery.season_id = NEW.season_id
        AND recovery.fad_id = NEW.fad_id
        AND recovery.allocation_id = NEW.allocation_id
        AND recovery.status <> 'resolved'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations AS allocation
      JOIN auctions AS auction
        ON auction.league_id = allocation.league_id
       AND auction.id IN (
            allocation.restricted_auction_id,
            allocation.fallback_open_auction_id
          )
      WHERE allocation.league_id = NEW.league_id
        AND allocation.season_id = NEW.season_id
        AND allocation.fad_id = NEW.fad_id
        AND allocation.id = NEW.allocation_id
        AND auction.status IN ('open', 'resolving', 'failed')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        NEW.response_json,
        '$.appliedDeltas'
      ) AS delta
      WHERE json_extract(delta.value, '$.resourceType') =
          'auction'
        AND json_extract(delta.value, '$.action') = 'cancel'
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations AS allocation
          JOIN auctions AS auction
            ON auction.league_id = allocation.league_id
           AND auction.id = json_extract(
                delta.value,
                '$.resourceId'
              )
           AND auction.id IN (
                allocation.restricted_auction_id,
                allocation.fallback_open_auction_id
              )
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
          JOIN auction_events AS event
            ON event.league_id = auction.league_id
           AND event.season_id = auction.season_id
           AND event.auction_id = auction.id
          WHERE allocation.league_id = NEW.league_id
            AND allocation.season_id = NEW.season_id
            AND allocation.fad_id = NEW.fad_id
            AND allocation.id = NEW.allocation_id
            AND auction.status = 'cancelled'
            AND auction.updated_at_ms = NEW.completed_at_ms
            AND auction.version > json_extract(
                  delta.value,
                  '$.beforeVersion'
                )
            AND json_extract(
                  delta.value,
                  '$.afterSummary.status'
                ) = 'cancelled'
            AND json_extract(
                  delta.value,
                  '$.afterSummary.auctionId'
                ) = auction.id
            AND resolution.status = 'cancelled'
            AND resolution.outcome_code = 'recovered'
            AND resolution.trigger_type = 'commissioner'
            AND resolution.triggered_by_user_id = NEW.actor_user_id
            AND resolution.resolved_at_ms = NEW.completed_at_ms
            AND draw.version = 2
            AND draw.revealed_at_ms = NEW.completed_at_ms
            AND draw.ordered_tied_bid_ids_json = '[]'
            AND draw.ordered_tied_team_ids_json = '[]'
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND event.event_type = 'auction_cancelled'
            AND event.actor_user_id = NEW.actor_user_id
            AND event.occurred_at_ms = NEW.completed_at_ms
            AND json_extract(
                  event.metadata_json,
                  '$.actorAuthority'
                ) = NEW.actor_authority
            AND json_extract(
                  event.metadata_json,
                  '$.correctionId'
                ) = NEW.commissioner_correction_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations AS allocation
      JOIN auctions AS auction
        ON auction.league_id = allocation.league_id
       AND auction.id IN (
            allocation.restricted_auction_id,
            allocation.fallback_open_auction_id
          )
      JOIN auction_resolutions AS resolution
        ON resolution.league_id = auction.league_id
       AND resolution.season_id = auction.season_id
       AND resolution.auction_id = auction.id
      WHERE allocation.league_id = NEW.league_id
        AND allocation.season_id = NEW.season_id
        AND allocation.fad_id = NEW.fad_id
        AND allocation.id = NEW.allocation_id
        AND auction.status = 'cancelled'
        AND auction.updated_at_ms = NEW.completed_at_ms
        AND resolution.status = 'cancelled'
        AND resolution.outcome_code = 'recovered'
        AND resolution.resolved_at_ms = NEW.completed_at_ms
        AND (
          SELECT COUNT(*)
          FROM json_each(
            NEW.response_json,
            '$.appliedDeltas'
          ) AS delta
          WHERE json_extract(
                  delta.value,
                  '$.resourceType'
                ) = 'auction'
            AND json_extract(delta.value, '$.action') = 'cancel'
            AND json_extract(
                  delta.value,
                  '$.resourceId'
                ) = auction.id
        ) <> 1
    )
  ) THEN RAISE(
    ABORT,
    'FAD allocation correction result must bind its exact request, preview, authority, correction, event, activity, allocation version, and response'
  ) END;
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
        AND (
          (
            NEW.offer_valid = 1
            AND NEW.rank_position IS NOT NULL
          )
          OR (
            NEW.offer_valid = 0
            AND NEW.rank_position IS NULL
          )
        )
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

CREATE TRIGGER free_agent_draft_allocations_immutable_delete
BEFORE DELETE ON free_agent_draft_player_allocations
BEGIN
  SELECT RAISE(ABORT, 'allocation decisions are immutable history');
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
                ) > NEW.minimum_aav_cents
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
        AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
        AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
        AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
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
        AND (
          (
            candidate_card_revisions.player_id = (
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
          )
          OR (
            candidate_card_revisions.action =
              'candidate_card_saved'
            AND EXISTS (
              SELECT 1
              FROM candidate_card_revision_entry_changes AS entry_change
              WHERE entry_change.league_id =
                  candidate_card_revisions.league_id
                AND entry_change.season_id =
                  candidate_card_revisions.season_id
                AND entry_change.fad_id =
                  candidate_card_revisions.fad_id
                AND entry_change.card_id =
                  candidate_card_revisions.card_id
                AND entry_change.team_id =
                  candidate_card_revisions.team_id
                AND entry_change.revision_id =
                  candidate_card_revisions.id
                AND entry_change.entry_id =
                  candidate_card_snapshot_entries.source_entry_id
                AND entry_change.player_id = (
                  SELECT player_id
                  FROM free_agent_draft_player_allocations
                  WHERE league_id = NEW.league_id
                    AND id = NEW.allocation_id
                )
                AND entry_change.change_kind IN (
                  'add',
                  'edit',
                  'move'
                )
            )
          )
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
            AND (
              (
                later_revision.affected_entry_id =
                  candidate_card_revisions.affected_entry_id
                AND later_revision.player_id =
                  candidate_card_revisions.player_id
                AND later_revision.action IN (
                  'candidate_added',
                  'candidate_edited',
                  'candidate_moved'
                )
              )
              OR (
                later_revision.action =
                  'candidate_card_saved'
                AND EXISTS (
                  SELECT 1
                  FROM candidate_card_revision_entry_changes AS later_change
                  WHERE later_change.league_id =
                      later_revision.league_id
                    AND later_change.revision_id =
                      later_revision.id
                    AND later_change.entry_id =
                      candidate_card_snapshot_entries.source_entry_id
                    AND later_change.player_id = (
                      SELECT player_id
                      FROM free_agent_draft_player_allocations
                      WHERE league_id = NEW.league_id
                        AND id = NEW.allocation_id
                    )
                    AND later_change.change_kind IN (
                      'add',
                      'edit',
                      'move'
                    )
                )
              )
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
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
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
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
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
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
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
              AND top_bid.total_value_cents = (
                SELECT MAX(candidate.total_value_cents)
                FROM fad_frozen_eligible_bids AS candidate
                WHERE candidate.league_id = NEW.league_id
                  AND candidate.auction_id = NEW.auction_id
              )
              AND top_bid.aav_cents = (
                SELECT MAX(candidate.aav_cents)
                FROM fad_frozen_eligible_bids AS candidate
                WHERE candidate.league_id = NEW.league_id
                  AND candidate.auction_id = NEW.auction_id
                  AND candidate.total_value_cents = (
                    SELECT MAX(ranked.total_value_cents)
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
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
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

UPDATE application_metadata SET metadata_value = '58', updated_at_ms = max(updated_at_ms, 58)
WHERE metadata_key = 'data_model_version' AND metadata_value = '57';

