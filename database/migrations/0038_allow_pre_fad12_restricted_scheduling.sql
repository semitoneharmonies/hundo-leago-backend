-- Permit a pre-FAD-12 allocator to quarantine an exact Candidate tie as
-- future scheduled work instead of activating its restricted auction early.
-- Only the existing pending-to-restricted-scheduled branch changes: it still
-- targets the exact next complete scheduled rollover and records the actual
-- allocation command time. Every other allocation transition is preserved.

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


UPDATE application_metadata
SET metadata_value = '38',
    updated_at_ms = CASE
      WHEN updated_at_ms < 38 THEN 38
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '37';

