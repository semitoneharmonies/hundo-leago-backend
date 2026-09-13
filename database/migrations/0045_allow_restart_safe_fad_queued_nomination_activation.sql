-- Make queued FAD nomination activation restart-safe without changing
-- any ordinary, immediate-open, restricted, or fallback auction path.
--
-- No table or column changes are required. The replacement triggers bind
-- delayed/reclaimed activation to its exact live job, admit the required
-- scheduled-predecessor extension, and seal terminal queue evidence.

DROP TRIGGER auction_bids_require_context_insert;

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
                      AND fad.status = 'rapid'
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
              AND resolution_rollover.rolls_over_at_ms =
                opening_rollover.rolls_over_at_ms + 86400000
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
              AND free_agent_drafts.status = 'rapid'
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



DROP TRIGGER free_agent_draft_rollovers_valid_insert;

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

DROP TRIGGER free_agent_draft_nomination_queue_forward_update;

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
              resolution_rollover.rolls_over_at_ms - 3600000
            AND resolution_rollover.rolls_over_at_ms =
              opening_rollover.rolls_over_at_ms + 86400000
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

CREATE UNIQUE INDEX
  free_agent_draft_recoveries_one_queued_nomination_job
  ON free_agent_draft_recoveries (
    league_id,
    season_id,
    fad_id,
    nomination_queue_id,
    job_run_id
  )
  WHERE kind = 'queued_nomination_activation'
    AND job_run_id IS NOT NULL;

UPDATE application_metadata
SET metadata_value = '45',
    updated_at_ms = CASE
      WHEN updated_at_ms < 45 THEN 45
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '44';
