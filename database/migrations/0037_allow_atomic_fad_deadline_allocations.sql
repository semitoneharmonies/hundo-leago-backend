-- Allow the deadline worker to stage exact pending player allocations in the
-- same transaction that locks Candidate Cards and advances the FAD root.
-- The existing deadline-locked and allocating insertion path remains intact.

DROP TRIGGER free_agent_draft_allocations_pending_insert;

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

UPDATE application_metadata
SET metadata_value = '37',
    updated_at_ms = CASE
      WHEN updated_at_ms < 37 THEN 37
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '36';
