-- Restore only the exact FAD allocation state that preceded a failed
-- allocation-linked auction-resolution attempt.
--
-- T-142 first requeues the canonical resolution job and restarts its exact
-- correction-required recovery.  The worker then acquires a live tokened
-- retry lease and moves the failed auction back to resolving.  This additive
-- trigger branch permits the allocation to follow only after all of that
-- immutable failure and retry causality is present.  It preserves every
-- resource link and Candidate floor, clears only the operational error, and
-- leaves ordinary auctions and every existing allocation transition unchanged.

DROP TRIGGER free_agent_draft_allocations_forward_update;

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
           AND failure_event.occurred_at_ms =
                recovery.created_at_ms
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
            AND recovery.created_at_ms =
                OLD.updated_at_ms
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
                recovery.created_at_ms
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

UPDATE application_metadata
SET metadata_value = '41',
    updated_at_ms = CASE
      WHEN updated_at_ms < 41 THEN 41
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '40';

