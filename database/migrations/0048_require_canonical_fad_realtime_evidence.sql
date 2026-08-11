-- FAD-14 forward-only activity, notification, and realtime taxonomy.
-- Rebuild only the two live head-47 triggers that encoded legacy FAD evidence.
-- No historical migration, table, column, index, or unrelated trigger changes.

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
        JOIN candidate_card_snapshot_entries AS winning_offer
          ON winning_offer.league_id = allocation.league_id
         AND winning_offer.season_id = allocation.season_id
         AND winning_offer.fad_id = allocation.fad_id
         AND winning_offer.id = allocation.winning_snapshot_entry_id
         AND winning_offer.team_id = allocation.winning_team_id
         AND winning_offer.player_id = allocation.player_id
         AND winning_offer.row_kind = 'slot'
         AND winning_offer.occupant_kind = 'candidate'
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
          AND json_extract(outbox_events.payload_json, '$.version') = OLD.version
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

DROP TRIGGER free_agent_draft_readiness_operations_forward_update;

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

UPDATE application_metadata
SET metadata_value = '48',
    updated_at_ms = CASE
      WHEN updated_at_ms < 48 THEN 48
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '47';
