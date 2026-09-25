-- Preserve historical outcomes. New FAD contracts must match a saved offer
-- from their winner, including its original term.
DROP TRIGGER fad_auction_resolutions_context_insert;

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
          AND EXISTS (
            SELECT 1 FROM auction_events AS priced_event
            WHERE priced_event.league_id = auction_bids.league_id
              AND priced_event.auction_id = auction_bids.auction_id
              AND priced_event.bid_id = auction_bids.id
              AND priced_event.team_id = auction_bids.team_id
              AND priced_event.occurred_at_ms <= auctions.resolves_at_ms
              AND priced_event.event_type IN ('auction_started', 'bid_submitted', 'bid_edited')
              AND json_valid(priced_event.metadata_json)
              AND CASE WHEN priced_event.event_type = 'auction_started'
                THEN json_extract(priced_event.metadata_json, '$.termYears')
                ELSE COALESCE(json_extract(priced_event.metadata_json, '$.after.termYears'), json_extract(priced_event.metadata_json, '$.termYears'))
              END = NEW.winning_term_years
              AND CASE WHEN priced_event.event_type = 'auction_started'
                THEN json_extract(priced_event.metadata_json, '$.totalValueCents')
                ELSE COALESCE(json_extract(priced_event.metadata_json, '$.after.totalValueCents'), json_extract(priced_event.metadata_json, '$.totalValueCents'))
              END = NEW.final_contract_value_cents
          )
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

UPDATE application_metadata SET metadata_value = '61', updated_at_ms = max(updated_at_ms, 61) WHERE metadata_key = 'data_model_version' AND metadata_value = '60';
