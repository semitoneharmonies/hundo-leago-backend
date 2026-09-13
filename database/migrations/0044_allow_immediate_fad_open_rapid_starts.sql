-- Admit one immediate manager/commissioner FAD open-rapid starter
-- under the auction-start command without weakening any existing bid path.
--
-- No table or column changes are required. The private queued-nomination
-- acceptance and activation contracts remain unchanged.

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
                'processing'
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
              AND activation_job.lease_expires_at_ms >
                auctions.opened_at_ms
              AND activation_job.started_at_ms =
                auctions.opened_at_ms
              AND activation_job.completed_at_ms IS NULL
              AND activation_job.result_json IS NULL
              AND activation_job.last_error_code IS NULL
              AND activation_job.next_attempt_at_ms IS NULL
              AND activation_job.updated_at_ms =
                auctions.opened_at_ms
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
        AND fad.status = 'rapid'
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
        AND (
          starter.term_years = 1
          OR starter.total_value_cents % 100 = 0
        )
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

CREATE TRIGGER idempotency_requests_fad_open_rapid_start_delete
BEFORE DELETE ON idempotency_requests
WHEN OLD.operation = 'auction.start'
  AND OLD.status = 'completed'
  AND OLD.result_type = 'auction'
  AND EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.auction_id = OLD.result_id
      AND auction_contexts.source_kind = 'fad_open_rapid'
      AND auction_contexts.fad_origin = 'manager_nomination'
      AND auction_contexts.fad_allocation_id IS NULL
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD immediate auction-start request evidence is immutable'
  );
END;

UPDATE application_metadata
SET metadata_value = '44',
    updated_at_ms = CASE
      WHEN updated_at_ms < 44 THEN 44
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '43';
