-- A commissioner-corrected award retains its human actor. Recognize only
-- the exact immutable correction receipt and matching acquisition evidence.
-- This migration changes schema only; no business or historical rows change.
CREATE VIEW free_agent_draft_confirmed_corrected_awards AS
SELECT allocation.league_id, allocation.season_id, allocation.fad_id,
       allocation.id AS allocation_id, receipt.actor_user_id,
       receipt.activity_id,
       json_extract(correction.before_snapshot_json, '$.fadVersion') AS fad_version,
       (SELECT json_extract(delta.value, '$.resourceId')
        FROM json_each(receipt.preview_json, '$.deltas') AS delta
        WHERE json_extract(delta.value, '$.resourceType') = 'auction'
        LIMIT 1) AS prior_auction_id
FROM free_agent_draft_player_allocations AS allocation
JOIN free_agent_draft_allocation_correction_command_results AS receipt
  ON receipt.league_id = allocation.league_id
 AND receipt.season_id = allocation.season_id
 AND receipt.fad_id = allocation.fad_id
 AND receipt.allocation_id = allocation.id
 AND receipt.player_id = allocation.player_id
 AND receipt.resulting_allocation_version = allocation.version
 AND receipt.accepted_from_allocation_version + 1 = allocation.version
 AND receipt.completed_at_ms = allocation.accounted_at_ms
 AND receipt.response_http_status = 200
 AND receipt.actor_authority IN ('commissioner', 'platform_administrator_as_commissioner')
JOIN commissioner_corrections AS correction
  ON correction.id = receipt.commissioner_correction_id
 AND correction.league_id = receipt.league_id
 AND correction.season_id = receipt.season_id
 AND correction.feature = 'free_agent_draft_allocation'
 AND correction.feature_record_id = allocation.id
 AND correction.actor_user_id = receipt.actor_user_id
 AND correction.corrected_at_ms = receipt.completed_at_ms
 AND json_type(correction.before_snapshot_json, '$.fadVersion') = 'integer'
 AND json_extract(correction.before_snapshot_json, '$.fadVersion') >= 1
 AND json_extract(correction.after_snapshot_json, '$.fadVersion') =
     json_extract(correction.before_snapshot_json, '$.fadVersion')
 AND json_extract(correction.after_snapshot_json, '$.status') = 'automatic_award'
 AND json_extract(correction.after_snapshot_json, '$.decisionCode') = 'corrected'
 AND json_extract(correction.after_snapshot_json, '$.version') = allocation.version
 AND json_extract(correction.after_snapshot_json, '$.accountedAtMs') = allocation.accounted_at_ms
 AND json_extract(correction.after_snapshot_json, '$.contractId') = allocation.contract_id
 AND json_extract(correction.after_snapshot_json, '$.ownershipId') = allocation.ownership_id
 AND json_extract(correction.after_snapshot_json, '$.winningTeamId') = allocation.winning_team_id
 AND json_extract(correction.after_snapshot_json, '$.winningSnapshotEntryId') = allocation.winning_snapshot_entry_id
JOIN free_agent_draft_allocation_events AS event
  ON event.league_id = allocation.league_id
 AND event.season_id = allocation.season_id
 AND event.fad_id = allocation.fad_id
 AND event.allocation_id = allocation.id
 AND event.allocation_version = allocation.version
 AND event.player_id = allocation.player_id
 AND event.correction_id = correction.id
 AND event.event_kind = 'correction_applied'
 AND event.decision_code = 'corrected'
 AND event.resulting_allocation_status = 'automatic_award'
 AND event.contract_id = allocation.contract_id
 AND event.ownership_id = allocation.ownership_id
 AND event.actor_user_id = receipt.actor_user_id
 AND event.actor_membership_id = receipt.actor_membership_id
 AND event.actor_authority = receipt.actor_authority
 AND event.occurred_at_ms = receipt.completed_at_ms
JOIN league_activity AS activity
  ON activity.id = receipt.activity_id
 AND activity.league_id = allocation.league_id
 AND activity.season_id = allocation.season_id
 AND activity.player_id = allocation.player_id
 AND activity.event_type = 'free_agent_draft_corrected'
 AND activity.related_type = 'free_agent_draft_allocation'
 AND activity.related_id = allocation.id
 AND activity.actor_user_id = receipt.actor_user_id
 AND activity.actor_authority = receipt.actor_authority
 AND activity.occurred_at_ms = receipt.completed_at_ms
JOIN candidate_card_snapshot_entries AS offer
  ON offer.id = allocation.winning_snapshot_entry_id
 AND offer.league_id = allocation.league_id
 AND offer.season_id = allocation.season_id
 AND offer.fad_id = allocation.fad_id
 AND offer.player_id = allocation.player_id
 AND offer.team_id = allocation.winning_team_id
JOIN ownership_events AS acquired
  ON acquired.league_id = allocation.league_id
 AND acquired.season_id = allocation.season_id
 AND acquired.player_id = allocation.player_id
 AND acquired.team_id = allocation.winning_team_id
 AND acquired.ownership_id = allocation.ownership_id
 AND acquired.source_type = 'free_agent_draft_allocation'
 AND acquired.source_id = allocation.id
 AND acquired.event_type = 'fad_allocation_player_acquired'
 AND acquired.actor_user_id = receipt.actor_user_id
 AND acquired.occurred_at_ms = allocation.accounted_at_ms
 AND acquired.before_metadata_json IS NULL
 AND json_extract(acquired.after_metadata_json, '$.ownershipKind') = 'Rostered'
 AND json_extract(acquired.after_metadata_json, '$.rosterCategory') =
     CASE WHEN offer.slot_group = 'B' THEN 'Bench' ELSE 'Active' END
 AND json_extract(acquired.after_metadata_json, '$.positionGroup') = offer.effective_position_group
 AND json_extract(acquired.after_metadata_json, '$.slotNumber') = offer.slot_number
JOIN contract_events AS created
  ON created.league_id = allocation.league_id
 AND created.player_id = allocation.player_id
 AND created.team_id = allocation.winning_team_id
 AND created.contract_id = allocation.contract_id
 AND created.source_type = 'free_agent_draft_allocation'
 AND created.source_id = allocation.id
 AND created.event_type = 'contract_created'
 AND created.actor_user_id = receipt.actor_user_id
 AND created.occurred_at_ms = allocation.accounted_at_ms
 AND json_extract(created.metadata_json, '$.contractType') = 'normal'
 AND json_extract(created.metadata_json, '$.startSeasonId') = allocation.season_id
 AND json_extract(created.metadata_json, '$.originalTotalValueCents') = offer.proposed_total_value_cents
 AND json_extract(created.metadata_json, '$.originalTermYears') = offer.proposed_term_years
 AND json_extract(created.metadata_json, '$.aavCents') = offer.proposed_aav_cents
WHERE allocation.status = 'automatic_award'
  AND allocation.decision_code = 'corrected';

-- Corrected awards publish correction events, not a new automatic decision.
-- Require both exact canonical envelopes and their single league audiences.
CREATE VIEW free_agent_draft_confirmed_correction_publications AS
SELECT corrected.league_id, corrected.season_id, corrected.fad_id,
       corrected.allocation_id
FROM free_agent_draft_confirmed_corrected_awards AS corrected
JOIN free_agent_draft_player_allocations AS allocation
  ON allocation.id = corrected.allocation_id
 AND allocation.league_id = corrected.league_id
 AND allocation.season_id = corrected.season_id
 AND allocation.fad_id = corrected.fad_id
JOIN outbox_events AS fad_notice
  ON fad_notice.league_id = allocation.league_id
 AND fad_notice.event_type = 'free_agent_draft.changed'
 AND fad_notice.aggregate_type = 'free_agent_draft'
 AND fad_notice.aggregate_id = allocation.fad_id
 AND fad_notice.created_at_ms = allocation.accounted_at_ms
 AND fad_notice.payload_json = json_object(
   'eventId', fad_notice.id, 'type', 'free_agent_draft.changed',
   'leagueId', allocation.league_id, 'resourceId', allocation.fad_id,
   'version', corrected.fad_version, 'reasonCode', 'correction_applied',
   'occurredAt', allocation.accounted_at_ms,
   'related', json_object(
     'fadId', allocation.fad_id, 'teamId', allocation.winning_team_id,
     'cardId', NULL, 'allocationId', allocation.id,
     'auctionId', corrected.prior_auction_id, 'recoveryId', NULL,
     'nominationQueueId', NULL, 'scheduleRecoveryOperationId', NULL
   )
 )
 AND (SELECT COUNT(*) FROM outbox_event_audiences AS audience
      WHERE audience.league_id = allocation.league_id
        AND audience.outbox_event_id = fad_notice.id) = 1
 AND EXISTS (
   SELECT 1 FROM outbox_event_audiences AS audience
   WHERE audience.league_id = allocation.league_id
     AND audience.outbox_event_id = fad_notice.id
     AND audience.audience_kind = 'league'
     AND audience.team_id IS NULL AND audience.user_id IS NULL
     AND audience.created_at_ms = allocation.accounted_at_ms
 )
JOIN outbox_events AS activity_notice
  ON activity_notice.league_id = allocation.league_id
 AND activity_notice.event_type = 'activity.created'
 AND activity_notice.aggregate_type = 'league_activity'
 AND activity_notice.aggregate_id = corrected.activity_id
 AND activity_notice.created_at_ms = allocation.accounted_at_ms
 AND activity_notice.payload_json = json_object(
   'eventId', activity_notice.id, 'type', 'activity.created',
   'leagueId', allocation.league_id, 'resourceId', corrected.activity_id,
   'version', 1, 'reasonCode', 'correction_applied',
   'occurredAt', allocation.accounted_at_ms,
   'related', json_object(
     'fadId', allocation.fad_id, 'teamId', allocation.winning_team_id,
     'cardId', NULL, 'allocationId', allocation.id,
     'auctionId', corrected.prior_auction_id, 'recoveryId', NULL,
     'nominationQueueId', NULL, 'scheduleRecoveryOperationId', NULL
   )
 )
 AND (SELECT COUNT(*) FROM outbox_event_audiences AS audience
      WHERE audience.league_id = allocation.league_id
        AND audience.outbox_event_id = activity_notice.id) = 1
 AND EXISTS (
   SELECT 1 FROM outbox_event_audiences AS audience
   WHERE audience.league_id = allocation.league_id
     AND audience.outbox_event_id = activity_notice.id
     AND audience.audience_kind = 'league'
     AND audience.team_id IS NULL AND audience.user_id IS NULL
     AND audience.created_at_ms = allocation.accounted_at_ms
 );

DROP TRIGGER free_agent_drafts_automatic_award_resources_barrier;

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
            AND (
            acquired.actor_user_id IS NULL
            OR EXISTS (
              SELECT 1 FROM free_agent_draft_confirmed_corrected_awards AS corrected
              WHERE corrected.league_id = allocation.league_id
                AND corrected.season_id = allocation.season_id
                AND corrected.fad_id = allocation.fad_id
                AND corrected.allocation_id = allocation.id
                AND corrected.actor_user_id = acquired.actor_user_id
            )
          )
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
                  -- Slot filling and trade-block toggles advance ownership
                  -- versions without changing the award or roster category.
                  -- Validate the latest recorded category move, not its old
                  -- presentation slot or an exact current row version.
                  AND json_extract(moved.after_metadata_json, '$.version') <= player_ownerships.version
                  AND json_extract(moved.after_metadata_json, '$.version') = json_extract(moved.before_metadata_json, '$.version') + 1
                  AND json_extract(moved.before_metadata_json, '$.version') >= 1
                  AND json_extract(moved.after_metadata_json, '$.rosterCategory') = player_ownerships.roster_category
                  AND json_extract(moved.after_metadata_json, '$.positionGroup') = player_ownerships.position_group
                  AND NOT EXISTS (
                    SELECT 1 FROM ownership_events AS later_move
                    WHERE later_move.league_id = moved.league_id
                      AND later_move.season_id = moved.season_id
                      AND later_move.player_id = moved.player_id
                      AND later_move.ownership_id = moved.ownership_id
                      AND later_move.event_type = 'roster_category_moved'
                      AND json_extract(later_move.after_metadata_json, '$.version') >
                          json_extract(moved.after_metadata_json, '$.version')
                  )
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
         AND (
            created.actor_user_id IS NULL
            OR EXISTS (
              SELECT 1 FROM free_agent_draft_confirmed_corrected_awards AS corrected
              WHERE corrected.league_id = allocation.league_id
                AND corrected.season_id = allocation.season_id
                AND corrected.fad_id = allocation.fad_id
                AND corrected.allocation_id = allocation.id
                AND corrected.actor_user_id = created.actor_user_id
            )
          )
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
            AND (
            acquired.actor_user_id IS NULL
            OR EXISTS (
              SELECT 1 FROM free_agent_draft_confirmed_corrected_awards AS corrected
              WHERE corrected.league_id = allocation.league_id
                AND corrected.season_id = allocation.season_id
                AND corrected.fad_id = allocation.fad_id
                AND corrected.allocation_id = allocation.id
                AND corrected.actor_user_id = acquired.actor_user_id
            )
          )
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
        SELECT 1 FROM free_agent_draft_confirmed_correction_publications AS corrected
        WHERE corrected.league_id = allocation.league_id
          AND corrected.season_id = allocation.season_id
          AND corrected.fad_id = allocation.fad_id
          AND corrected.allocation_id = allocation.id
      )
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

UPDATE application_metadata
SET metadata_value = '62',
    updated_at_ms = max(updated_at_ms, 62)
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '61';
