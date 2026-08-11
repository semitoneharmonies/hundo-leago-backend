-- Bind the ordinary two-edit starter allowance for nominated FAD auctions
-- to the unique immutable auction-start event instead of a timestamp.
-- Queued starters additionally require their exact queue backlink.

DROP TRIGGER fad_auction_bids_forward_update;

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

UPDATE application_metadata
SET metadata_value = '46',
    updated_at_ms = CASE
      WHEN updated_at_ms < 46 THEN 46
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '45';
