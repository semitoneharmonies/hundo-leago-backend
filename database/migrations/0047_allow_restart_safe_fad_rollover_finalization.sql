-- Allow an explicitly retried FAD rollover to reach completion, or to
-- record another terminal automatic failure, without replacing its causal
-- job or recovery. Preserve the original normal rollover transitions.

DROP TRIGGER free_agent_draft_rollovers_forward_update;

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

CREATE UNIQUE INDEX
  free_agent_draft_recoveries_one_rollover_finalize_job
  ON free_agent_draft_recoveries (
    league_id,
    season_id,
    fad_id,
    rollover_id,
    job_run_id
  )
  WHERE kind = 'rollover_finalize'
    AND job_run_id IS NOT NULL;

UPDATE application_metadata
SET metadata_value = '47',
    updated_at_ms = CASE
      WHEN updated_at_ms < 47 THEN 47
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '46';
