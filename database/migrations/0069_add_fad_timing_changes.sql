-- Additive audit history. Existing rows are not changed by installation.
CREATE TABLE fad_timing_changes (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  league_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
  before_root_json TEXT NOT NULL CHECK(json_valid(before_root_json)),
  after_root_json TEXT NOT NULL CHECK(json_valid(after_root_json)),
  before_rollovers_json TEXT NOT NULL CHECK(json_valid(before_rollovers_json)),
  after_rollovers_json TEXT NOT NULL CHECK(json_valid(after_rollovers_json)),
  before_jobs_json TEXT NOT NULL CHECK(json_valid(before_jobs_json)),
  after_jobs_json TEXT NOT NULL CHECK(json_valid(after_jobs_json)),
  before_control_json TEXT NOT NULL CHECK(json_valid(before_control_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(league_id,actor_user_id,client_key),
  FOREIGN KEY(league_id,fad_id) REFERENCES free_agent_drafts(league_id,id)
) STRICT;
CREATE INDEX fad_timing_changes_scope ON fad_timing_changes(league_id,fad_id,created_at_ms);
CREATE TRIGGER fad_timing_changes_no_update BEFORE UPDATE ON fad_timing_changes
BEGIN SELECT RAISE(ABORT,'FAD timing history is immutable'); END;
CREATE TRIGGER fad_timing_changes_no_delete BEFORE DELETE ON fad_timing_changes
BEGIN SELECT RAISE(ABORT,'FAD timing history is immutable'); END;

CREATE TRIGGER fad_timing_changes_valid_insert BEFORE INSERT ON fad_timing_changes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM free_agent_drafts AS draft JOIN leagues AS league ON league.id=draft.league_id
    WHERE draft.league_id=NEW.league_id AND draft.id=NEW.fad_id
      AND draft.status='cards_open' AND league.status='active' AND league.current_season_id=draft.season_id
      AND draft.id IS json_extract(NEW.before_root_json, '$.id')
    AND draft.league_id IS json_extract(NEW.before_root_json, '$.league_id')
    AND draft.season_id IS json_extract(NEW.before_root_json, '$.season_id')
    AND draft.readiness_operation_id IS json_extract(NEW.before_root_json, '$.readiness_operation_id')
    AND draft.readiness_occurrence_key IS json_extract(NEW.before_root_json, '$.readiness_occurrence_key')
    AND draft.first_matchup_week_id IS json_extract(NEW.before_root_json, '$.first_matchup_week_id')
    AND draft.current_competition_first_matchup_week_id IS json_extract(NEW.before_root_json, '$.current_competition_first_matchup_week_id')
    AND draft.schedule_recovery_id IS json_extract(NEW.before_root_json, '$.schedule_recovery_id')
    AND draft.participating_team_count IS json_extract(NEW.before_root_json, '$.participating_team_count')
    AND draft.status IS json_extract(NEW.before_root_json, '$.status')
    AND draft.setup_path IS json_extract(NEW.before_root_json, '$.setup_path')
    AND draft.entry_draft_id IS json_extract(NEW.before_root_json, '$.entry_draft_id')
    AND draft.setup_exemption_id IS json_extract(NEW.before_root_json, '$.setup_exemption_id')
    AND draft.prior_season_rollover_id IS json_extract(NEW.before_root_json, '$.prior_season_rollover_id')
    AND draft.no_draft_reason IS json_extract(NEW.before_root_json, '$.no_draft_reason')
    AND draft.opening_authority IS json_extract(NEW.before_root_json, '$.opening_authority')
    AND draft.opened_at_ms IS json_extract(NEW.before_root_json, '$.opened_at_ms')
    AND draft.help_opens_at_ms IS json_extract(NEW.before_root_json, '$.help_opens_at_ms')
    AND draft.candidate_deadline_at_ms IS json_extract(NEW.before_root_json, '$.candidate_deadline_at_ms')
    AND draft.first_matchup_starts_at_ms IS json_extract(NEW.before_root_json, '$.first_matchup_starts_at_ms')
    AND draft.initial_rollover_times_json IS json_extract(NEW.before_root_json, '$.initial_rollover_times_json')
    AND draft.deadline_locked_at_ms IS json_extract(NEW.before_root_json, '$.deadline_locked_at_ms')
    AND draft.allocation_completed_at_ms IS json_extract(NEW.before_root_json, '$.allocation_completed_at_ms')
    AND draft.completed_at_ms IS json_extract(NEW.before_root_json, '$.completed_at_ms')
    AND draft.created_at_ms IS json_extract(NEW.before_root_json, '$.created_at_ms')
    AND draft.updated_at_ms IS json_extract(NEW.before_root_json, '$.updated_at_ms')
    AND draft.version IS json_extract(NEW.before_root_json, '$.version')
  ) THEN RAISE(ABORT,'FAD timing change requires the current open draft') END;
  SELECT CASE WHEN NOT (
    json_extract(NEW.before_root_json,'$.id') IS json_extract(NEW.after_root_json,'$.id')
    AND json_extract(NEW.before_root_json,'$.league_id') IS json_extract(NEW.after_root_json,'$.league_id')
    AND json_extract(NEW.before_root_json,'$.season_id') IS json_extract(NEW.after_root_json,'$.season_id')
    AND json_extract(NEW.before_root_json,'$.readiness_operation_id') IS json_extract(NEW.after_root_json,'$.readiness_operation_id')
    AND json_extract(NEW.before_root_json,'$.readiness_occurrence_key') IS json_extract(NEW.after_root_json,'$.readiness_occurrence_key')
    AND json_extract(NEW.before_root_json,'$.first_matchup_week_id') IS json_extract(NEW.after_root_json,'$.first_matchup_week_id')
    AND json_extract(NEW.before_root_json,'$.current_competition_first_matchup_week_id') IS json_extract(NEW.after_root_json,'$.current_competition_first_matchup_week_id')
    AND json_extract(NEW.before_root_json,'$.schedule_recovery_id') IS json_extract(NEW.after_root_json,'$.schedule_recovery_id')
    AND json_extract(NEW.before_root_json,'$.participating_team_count') IS json_extract(NEW.after_root_json,'$.participating_team_count')
    AND json_extract(NEW.before_root_json,'$.status') IS json_extract(NEW.after_root_json,'$.status')
    AND json_extract(NEW.before_root_json,'$.setup_path') IS json_extract(NEW.after_root_json,'$.setup_path')
    AND json_extract(NEW.before_root_json,'$.entry_draft_id') IS json_extract(NEW.after_root_json,'$.entry_draft_id')
    AND json_extract(NEW.before_root_json,'$.setup_exemption_id') IS json_extract(NEW.after_root_json,'$.setup_exemption_id')
    AND json_extract(NEW.before_root_json,'$.prior_season_rollover_id') IS json_extract(NEW.after_root_json,'$.prior_season_rollover_id')
    AND json_extract(NEW.before_root_json,'$.no_draft_reason') IS json_extract(NEW.after_root_json,'$.no_draft_reason')
    AND json_extract(NEW.before_root_json,'$.opening_authority') IS json_extract(NEW.after_root_json,'$.opening_authority')
    AND json_extract(NEW.before_root_json,'$.opened_at_ms') IS json_extract(NEW.after_root_json,'$.opened_at_ms')
    AND json_extract(NEW.before_root_json,'$.first_matchup_starts_at_ms') IS json_extract(NEW.after_root_json,'$.first_matchup_starts_at_ms')
    AND json_extract(NEW.before_root_json,'$.deadline_locked_at_ms') IS json_extract(NEW.after_root_json,'$.deadline_locked_at_ms')
    AND json_extract(NEW.before_root_json,'$.allocation_completed_at_ms') IS json_extract(NEW.after_root_json,'$.allocation_completed_at_ms')
    AND json_extract(NEW.before_root_json,'$.completed_at_ms') IS json_extract(NEW.after_root_json,'$.completed_at_ms')
    AND json_extract(NEW.before_root_json,'$.created_at_ms') IS json_extract(NEW.after_root_json,'$.created_at_ms')
    AND json_extract(NEW.after_root_json,'$.version')=json_extract(NEW.before_root_json,'$.version')+1
    AND json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms')>NEW.created_at_ms
    AND json_array_length(NEW.after_rollovers_json)=json_array_length(NEW.before_rollovers_json)
    AND json_array_length(NEW.after_rollovers_json)=json_array_length(json_extract(NEW.after_root_json,'$.initial_rollover_times_json'))
    AND json_array_length(NEW.after_jobs_json)=json_array_length(NEW.before_jobs_json)
  ) THEN RAISE(ABORT,'FAD timing change must preserve draft identity and history') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.after_rollovers_json) AS after
    WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.before_rollovers_json) AS before WHERE
      json_extract(before.value,'$.id') IS json_extract(after.value,'$.id')
      AND json_extract(before.value,'$.league_id') IS json_extract(after.value,'$.league_id')
      AND json_extract(before.value,'$.season_id') IS json_extract(after.value,'$.season_id')
      AND json_extract(before.value,'$.fad_id') IS json_extract(after.value,'$.fad_id')
      AND json_extract(before.value,'$.sequence') IS json_extract(after.value,'$.sequence')
      AND json_extract(before.value,'$.window_kind') IS json_extract(after.value,'$.window_kind')
      AND json_extract(before.value,'$.predecessor_rollover_id') IS json_extract(after.value,'$.predecessor_rollover_id')
      AND json_extract(before.value,'$.extension_reason') IS json_extract(after.value,'$.extension_reason')
      AND json_extract(before.value,'$.extension_source_id') IS json_extract(after.value,'$.extension_source_id')
      AND json_extract(before.value,'$.status') IS json_extract(after.value,'$.status')
      AND json_extract(before.value,'$.processing_job_run_id') IS json_extract(after.value,'$.processing_job_run_id')
      AND json_extract(before.value,'$.processing_started_at_ms') IS json_extract(after.value,'$.processing_started_at_ms')
      AND json_extract(before.value,'$.completed_at_ms') IS json_extract(after.value,'$.completed_at_ms')
      AND json_extract(before.value,'$.last_error_code') IS json_extract(after.value,'$.last_error_code')
      AND json_extract(before.value,'$.created_at_ms') IS json_extract(after.value,'$.created_at_ms')
      AND json_extract(before.value,'$.status')='scheduled'
      AND json_extract(before.value,'$.window_kind')='initial'
      AND json_extract(after.value,'$.version')=json_extract(before.value,'$.version')+1
      AND json_extract(after.value,'$.rolls_over_at_ms')<=json_extract(NEW.after_root_json,'$.first_matchup_starts_at_ms')
      AND json_extract(after.value,'$.rolls_over_at_ms')=json_extract(json_extract(NEW.after_root_json,'$.initial_rollover_times_json'),'$[' || after.key || ']')
      AND json_extract(after.value,'$.opens_at_ms')=CASE WHEN after.key=0 THEN json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms') ELSE json_extract(json_extract(NEW.after_root_json,'$.initial_rollover_times_json'),'$[' || (after.key-1) || ']') END
    )
  ) THEN RAISE(ABORT,'FAD timing change must preserve scheduled round identities') END;
END;

-- Preserve the existing forward transitions verbatim, with an exception only
-- for an exact, recorded open-card reschedule. The root is written last.

DROP TRIGGER free_agent_drafts_forward_update;
CREATE TRIGGER free_agent_drafts_forward_update
BEFORE UPDATE ON free_agent_drafts
WHEN NOT (OLD.status='cards_open' AND NEW.status='cards_open' AND EXISTS (SELECT 1 FROM fad_timing_changes AS change
  WHERE change.league_id=OLD.league_id AND change.fad_id=OLD.id
    AND OLD.id IS json_extract(change.before_root_json, '$.id')
    AND OLD.league_id IS json_extract(change.before_root_json, '$.league_id')
    AND OLD.season_id IS json_extract(change.before_root_json, '$.season_id')
    AND OLD.readiness_operation_id IS json_extract(change.before_root_json, '$.readiness_operation_id')
    AND OLD.readiness_occurrence_key IS json_extract(change.before_root_json, '$.readiness_occurrence_key')
    AND OLD.first_matchup_week_id IS json_extract(change.before_root_json, '$.first_matchup_week_id')
    AND OLD.current_competition_first_matchup_week_id IS json_extract(change.before_root_json, '$.current_competition_first_matchup_week_id')
    AND OLD.schedule_recovery_id IS json_extract(change.before_root_json, '$.schedule_recovery_id')
    AND OLD.participating_team_count IS json_extract(change.before_root_json, '$.participating_team_count')
    AND OLD.status IS json_extract(change.before_root_json, '$.status')
    AND OLD.setup_path IS json_extract(change.before_root_json, '$.setup_path')
    AND OLD.entry_draft_id IS json_extract(change.before_root_json, '$.entry_draft_id')
    AND OLD.setup_exemption_id IS json_extract(change.before_root_json, '$.setup_exemption_id')
    AND OLD.prior_season_rollover_id IS json_extract(change.before_root_json, '$.prior_season_rollover_id')
    AND OLD.no_draft_reason IS json_extract(change.before_root_json, '$.no_draft_reason')
    AND OLD.opening_authority IS json_extract(change.before_root_json, '$.opening_authority')
    AND OLD.opened_at_ms IS json_extract(change.before_root_json, '$.opened_at_ms')
    AND OLD.help_opens_at_ms IS json_extract(change.before_root_json, '$.help_opens_at_ms')
    AND OLD.candidate_deadline_at_ms IS json_extract(change.before_root_json, '$.candidate_deadline_at_ms')
    AND OLD.first_matchup_starts_at_ms IS json_extract(change.before_root_json, '$.first_matchup_starts_at_ms')
    AND OLD.initial_rollover_times_json IS json_extract(change.before_root_json, '$.initial_rollover_times_json')
    AND OLD.deadline_locked_at_ms IS json_extract(change.before_root_json, '$.deadline_locked_at_ms')
    AND OLD.allocation_completed_at_ms IS json_extract(change.before_root_json, '$.allocation_completed_at_ms')
    AND OLD.completed_at_ms IS json_extract(change.before_root_json, '$.completed_at_ms')
    AND OLD.created_at_ms IS json_extract(change.before_root_json, '$.created_at_ms')
    AND OLD.updated_at_ms IS json_extract(change.before_root_json, '$.updated_at_ms')
    AND OLD.version IS json_extract(change.before_root_json, '$.version')
    AND NEW.id IS json_extract(change.after_root_json, '$.id')
    AND NEW.league_id IS json_extract(change.after_root_json, '$.league_id')
    AND NEW.season_id IS json_extract(change.after_root_json, '$.season_id')
    AND NEW.readiness_operation_id IS json_extract(change.after_root_json, '$.readiness_operation_id')
    AND NEW.readiness_occurrence_key IS json_extract(change.after_root_json, '$.readiness_occurrence_key')
    AND NEW.first_matchup_week_id IS json_extract(change.after_root_json, '$.first_matchup_week_id')
    AND NEW.current_competition_first_matchup_week_id IS json_extract(change.after_root_json, '$.current_competition_first_matchup_week_id')
    AND NEW.schedule_recovery_id IS json_extract(change.after_root_json, '$.schedule_recovery_id')
    AND NEW.participating_team_count IS json_extract(change.after_root_json, '$.participating_team_count')
    AND NEW.status IS json_extract(change.after_root_json, '$.status')
    AND NEW.setup_path IS json_extract(change.after_root_json, '$.setup_path')
    AND NEW.entry_draft_id IS json_extract(change.after_root_json, '$.entry_draft_id')
    AND NEW.setup_exemption_id IS json_extract(change.after_root_json, '$.setup_exemption_id')
    AND NEW.prior_season_rollover_id IS json_extract(change.after_root_json, '$.prior_season_rollover_id')
    AND NEW.no_draft_reason IS json_extract(change.after_root_json, '$.no_draft_reason')
    AND NEW.opening_authority IS json_extract(change.after_root_json, '$.opening_authority')
    AND NEW.opened_at_ms IS json_extract(change.after_root_json, '$.opened_at_ms')
    AND NEW.help_opens_at_ms IS json_extract(change.after_root_json, '$.help_opens_at_ms')
    AND NEW.candidate_deadline_at_ms IS json_extract(change.after_root_json, '$.candidate_deadline_at_ms')
    AND NEW.first_matchup_starts_at_ms IS json_extract(change.after_root_json, '$.first_matchup_starts_at_ms')
    AND NEW.initial_rollover_times_json IS json_extract(change.after_root_json, '$.initial_rollover_times_json')
    AND NEW.deadline_locked_at_ms IS json_extract(change.after_root_json, '$.deadline_locked_at_ms')
    AND NEW.allocation_completed_at_ms IS json_extract(change.after_root_json, '$.allocation_completed_at_ms')
    AND NEW.completed_at_ms IS json_extract(change.after_root_json, '$.completed_at_ms')
    AND NEW.created_at_ms IS json_extract(change.after_root_json, '$.created_at_ms')
    AND NEW.updated_at_ms IS json_extract(change.after_root_json, '$.updated_at_ms')
    AND NEW.version IS json_extract(change.after_root_json, '$.version')
    AND (SELECT COUNT(*) FROM free_agent_draft_rollovers WHERE league_id=NEW.league_id AND fad_id=NEW.id)=json_array_length(change.after_rollovers_json)
    AND NOT EXISTS (SELECT 1 FROM json_each(change.after_rollovers_json) AS planned
      WHERE NOT EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS actual WHERE actual.id IS json_extract(planned.value, '$.id')
    AND actual.league_id IS json_extract(planned.value, '$.league_id')
    AND actual.season_id IS json_extract(planned.value, '$.season_id')
    AND actual.fad_id IS json_extract(planned.value, '$.fad_id')
    AND actual.sequence IS json_extract(planned.value, '$.sequence')
    AND actual.window_kind IS json_extract(planned.value, '$.window_kind')
    AND actual.predecessor_rollover_id IS json_extract(planned.value, '$.predecessor_rollover_id')
    AND actual.extension_reason IS json_extract(planned.value, '$.extension_reason')
    AND actual.extension_source_id IS json_extract(planned.value, '$.extension_source_id')
    AND actual.opens_at_ms IS json_extract(planned.value, '$.opens_at_ms')
    AND actual.creation_cutoff_at_ms IS json_extract(planned.value, '$.creation_cutoff_at_ms')
    AND actual.rolls_over_at_ms IS json_extract(planned.value, '$.rolls_over_at_ms')
    AND actual.status IS json_extract(planned.value, '$.status')
    AND actual.processing_job_run_id IS json_extract(planned.value, '$.processing_job_run_id')
    AND actual.processing_started_at_ms IS json_extract(planned.value, '$.processing_started_at_ms')
    AND actual.completed_at_ms IS json_extract(planned.value, '$.completed_at_ms')
    AND actual.last_error_code IS json_extract(planned.value, '$.last_error_code')
    AND actual.created_at_ms IS json_extract(planned.value, '$.created_at_ms')
    AND actual.updated_at_ms IS json_extract(planned.value, '$.updated_at_ms')
    AND actual.version IS json_extract(planned.value, '$.version')))
    AND NOT EXISTS (SELECT 1 FROM json_each(change.after_jobs_json) AS planned
      WHERE NOT EXISTS (SELECT 1 FROM job_runs AS actual WHERE actual.id IS json_extract(planned.value, '$.id')
    AND actual.league_id IS json_extract(planned.value, '$.league_id')
    AND actual.season_id IS json_extract(planned.value, '$.season_id')
    AND actual.job_type IS json_extract(planned.value, '$.job_type')
    AND actual.occurrence_key IS json_extract(planned.value, '$.occurrence_key')
    AND actual.scheduled_for_ms IS json_extract(planned.value, '$.scheduled_for_ms')
    AND actual.status IS json_extract(planned.value, '$.status')
    AND actual.attempt_count IS json_extract(planned.value, '$.attempt_count')
    AND actual.lease_owner IS json_extract(planned.value, '$.lease_owner')
    AND actual.lease_expires_at_ms IS json_extract(planned.value, '$.lease_expires_at_ms')
    AND actual.started_at_ms IS json_extract(planned.value, '$.started_at_ms')
    AND actual.completed_at_ms IS json_extract(planned.value, '$.completed_at_ms')
    AND actual.result_json IS json_extract(planned.value, '$.result_json')
    AND actual.last_error_code IS json_extract(planned.value, '$.last_error_code')
    AND actual.created_at_ms IS json_extract(planned.value, '$.created_at_ms')
    AND actual.updated_at_ms IS json_extract(planned.value, '$.updated_at_ms')
    AND actual.version IS json_extract(planned.value, '$.version')
    AND actual.lease_token IS json_extract(planned.value, '$.lease_token')
    AND actual.next_attempt_at_ms IS json_extract(planned.value, '$.next_attempt_at_ms')))))
BEGIN
  SELECT CASE WHEN NOT ((NEW.league_id='48e59cfb-b12d-4dfb-ae1a-4d8b3512ef03' AND OLD.status='cards_open' AND OLD.candidate_deadline_at_ms IS NULL AND NEW.id IS OLD.id AND NEW.league_id IS OLD.league_id AND NEW.season_id IS OLD.season_id AND NEW.readiness_operation_id IS OLD.readiness_operation_id AND NEW.readiness_occurrence_key IS OLD.readiness_occurrence_key AND NEW.first_matchup_week_id IS OLD.first_matchup_week_id AND NEW.current_competition_first_matchup_week_id IS OLD.current_competition_first_matchup_week_id AND NEW.schedule_recovery_id IS OLD.schedule_recovery_id AND NEW.participating_team_count IS OLD.participating_team_count AND NEW.status IS OLD.status AND NEW.setup_path IS OLD.setup_path AND NEW.entry_draft_id IS OLD.entry_draft_id AND NEW.setup_exemption_id IS OLD.setup_exemption_id AND NEW.prior_season_rollover_id IS OLD.prior_season_rollover_id AND NEW.no_draft_reason IS OLD.no_draft_reason AND NEW.opening_authority IS OLD.opening_authority AND NEW.opened_at_ms IS OLD.opened_at_ms AND NEW.help_opens_at_ms IS OLD.help_opens_at_ms AND NEW.candidate_deadline_at_ms IS OLD.candidate_deadline_at_ms AND NEW.first_matchup_starts_at_ms IS OLD.first_matchup_starts_at_ms AND NEW.initial_rollover_times_json IS OLD.initial_rollover_times_json AND NEW.deadline_locked_at_ms IS OLD.deadline_locked_at_ms AND NEW.allocation_completed_at_ms IS OLD.allocation_completed_at_ms AND NEW.completed_at_ms IS OLD.completed_at_ms AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND NEW.version=OLD.version+1) OR (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.readiness_operation_id IS OLD.readiness_operation_id
    AND NEW.readiness_occurrence_key IS OLD.readiness_occurrence_key
    AND NEW.first_matchup_week_id IS OLD.first_matchup_week_id
    AND NEW.participating_team_count IS OLD.participating_team_count
    AND NEW.setup_path IS OLD.setup_path
    AND NEW.entry_draft_id IS OLD.entry_draft_id
    AND NEW.setup_exemption_id IS OLD.setup_exemption_id
    AND NEW.prior_season_rollover_id IS OLD.prior_season_rollover_id
    AND NEW.no_draft_reason IS OLD.no_draft_reason
    AND NEW.opening_authority IS OLD.opening_authority
    AND NEW.opened_at_ms IS OLD.opened_at_ms
    AND NEW.help_opens_at_ms IS OLD.help_opens_at_ms
    AND NEW.candidate_deadline_at_ms IS OLD.candidate_deadline_at_ms
    AND NEW.first_matchup_starts_at_ms IS OLD.first_matchup_starts_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'cards_open'
        AND NEW.status = 'deadline_locked'
        AND NEW.current_competition_first_matchup_week_id IS
          OLD.current_competition_first_matchup_week_id
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.deadline_locked_at_ms >=
          NEW.candidate_deadline_at_ms
        AND NEW.allocation_completed_at_ms IS NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status = 'deadline_locked'
        AND NEW.status = 'allocating'
        AND NEW.current_competition_first_matchup_week_id IS
          OLD.current_competition_first_matchup_week_id
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.deadline_locked_at_ms IS OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status IN ('deadline_locked', 'allocating')
        AND NEW.status = 'rapid'
        AND NEW.current_competition_first_matchup_week_id IS
          OLD.current_competition_first_matchup_week_id
        AND NEW.schedule_recovery_id IS NULL
        AND NEW.deadline_locked_at_ms IS OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS NOT NULL
        AND NEW.completed_at_ms IS NULL
      )
      OR (
        OLD.status = 'rapid'
        AND NEW.status = 'completed'
        AND NEW.deadline_locked_at_ms IS OLD.deadline_locked_at_ms
        AND NEW.allocation_completed_at_ms IS
          OLD.allocation_completed_at_ms
        AND NEW.completed_at_ms IS NOT NULL
        AND (
          NEW.completed_at_ms < (
            SELECT matchup_weeks.starts_at_ms FROM matchup_weeks
            WHERE matchup_weeks.league_id = NEW.league_id
              AND matchup_weeks.id = NEW.current_competition_first_matchup_week_id
          )
          OR EXISTS (
            SELECT 1 FROM free_agent_draft_approved_week_one_handoffs AS handoff
            WHERE handoff.league_id = NEW.league_id
              AND handoff.season_id = NEW.season_id
              AND handoff.fad_id = NEW.id
              AND handoff.matchup_week_id = NEW.current_competition_first_matchup_week_id
              AND NEW.completed_at_ms >= handoff.starts_at_ms
              AND NEW.completed_at_ms < handoff.baseline_at_ms
          )
        )
        AND (
          SELECT seasons.free_agent_draft_completed_at_ms
          FROM seasons
          WHERE seasons.league_id = NEW.league_id
            AND seasons.id = NEW.season_id
        ) IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations
          WHERE free_agent_draft_player_allocations.league_id =
              NEW.league_id
            AND free_agent_draft_player_allocations.fad_id =
              NEW.id
            AND free_agent_draft_player_allocations.status NOT IN (
              'automatic_award',
              'restricted_resolved',
              'fallback_open_resolved',
              'no_valid_offer',
              'invalid'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers
          WHERE free_agent_draft_rollovers.league_id =
              NEW.league_id
            AND free_agent_draft_rollovers.fad_id = NEW.id
            AND free_agent_draft_rollovers.status <> 'completed'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_nomination_queue
          WHERE free_agent_draft_nomination_queue.league_id =
              NEW.league_id
            AND free_agent_draft_nomination_queue.fad_id = NEW.id
            AND free_agent_draft_nomination_queue.status =
              'queued'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auction_contexts
          JOIN auctions
            ON auctions.league_id = auction_contexts.league_id
           AND auctions.season_id = auction_contexts.season_id
           AND auctions.id = auction_contexts.auction_id
          WHERE auction_contexts.league_id = NEW.league_id
            AND auction_contexts.fad_id = NEW.id
            AND auction_contexts.source_kind IN (
              'fad_open_rapid',
              'fad_restricted'
            )
            AND (
              auctions.status NOT IN (
                'resolved',
                'no_winner',
                'cancelled'
              )
              OR (
                SELECT COUNT(*)
                FROM auction_resolutions
                WHERE auction_resolutions.league_id =
                    auctions.league_id
                  AND auction_resolutions.auction_id =
                    auctions.id
                  AND auction_resolutions.status IN (
                    'resolved',
                    'no_bids',
                    'no_winner',
                    'cancelled',
                    'recovered'
                  )
              ) <> 1
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_draws
                  WHERE free_agent_draft_draws.league_id =
                      auctions.league_id
                    AND free_agent_draft_draws.auction_id =
                      auctions.id
                    AND free_agent_draft_draws.revealed_at_ms =
                      auctions.updated_at_ms
                )
                AND NOT (
                  auction_contexts.source_kind = 'fad_restricted'
                  AND auctions.status = 'cancelled'
                  AND EXISTS (
                    SELECT 1
                    FROM auction_resolutions
                    WHERE auction_resolutions.league_id =
                        auctions.league_id
                      AND auction_resolutions.auction_id =
                        auctions.id
                      AND auction_resolutions.status = 'cancelled'
                      AND auction_resolutions.outcome_code = 'failed'
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_draws
                    WHERE free_agent_draft_draws.league_id =
                        auctions.league_id
                      AND free_agent_draft_draws.auction_id =
                        auctions.id
                      AND free_agent_draft_draws.revealed_at_ms IS NULL
                      AND free_agent_draft_draws.version = 1
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_recoveries
                    WHERE free_agent_draft_recoveries.league_id =
                        auction_contexts.league_id
                      AND free_agent_draft_recoveries.fad_id =
                        auction_contexts.fad_id
                      AND free_agent_draft_recoveries.allocation_id =
                        auction_contexts.fad_allocation_id
                      AND free_agent_draft_recoveries.rollover_id =
                        auction_contexts.fad_rollover_id
                      AND free_agent_draft_recoveries.auction_id =
                        auction_contexts.auction_id
                      AND free_agent_draft_recoveries.kind =
                        'auction_resolution'
                      AND free_agent_draft_recoveries.status = 'resolved'
                      AND free_agent_draft_recoveries.resolved_at_ms <=
                        NEW.completed_at_ms
                  )
                )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_recoveries
          WHERE free_agent_draft_recoveries.league_id =
              NEW.league_id
            AND free_agent_draft_recoveries.fad_id = NEW.id
            AND free_agent_draft_recoveries.status <> 'resolved'
        )
        AND (
          SELECT COUNT(*)
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.season_id = NEW.season_id
            AND job_runs.job_type = 'fad_completion'
            AND job_runs.occurrence_key =
              'fad:' || NEW.id || ':complete'
            AND job_runs.scheduled_for_ms <=
              NEW.completed_at_ms
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms >
              NEW.completed_at_ms
            AND job_runs.started_at_ms IS NOT NULL
            AND job_runs.completed_at_ms IS NULL
        ) = 1
        AND (
          (
            NEW.schedule_recovery_id IS NULL
            AND NEW.current_competition_first_matchup_week_id IS
              OLD.current_competition_first_matchup_week_id
          )
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_schedule_recoveries
            WHERE free_agent_draft_schedule_recoveries.league_id =
                NEW.league_id
              AND free_agent_draft_schedule_recoveries.fad_id = NEW.id
              AND free_agent_draft_schedule_recoveries.id =
                NEW.schedule_recovery_id
              AND free_agent_draft_schedule_recoveries.recovery_kind =
                'completion'
              AND free_agent_draft_schedule_recoveries.old_first_matchup_week_id =
                OLD.current_competition_first_matchup_week_id
              AND free_agent_draft_schedule_recoveries.new_first_matchup_week_id =
                NEW.current_competition_first_matchup_week_id
              AND free_agent_draft_schedule_recoveries.completed_at_ms =
                NEW.completed_at_ms
          )
        )
      )
    )
  )) THEN RAISE(
    ABORT,
    'FAD may only advance through its atomic locked lifecycle'
  ) END;
END;

DROP TRIGGER free_agent_draft_rollovers_forward_update;
CREATE TRIGGER free_agent_draft_rollovers_forward_update
BEFORE UPDATE ON free_agent_draft_rollovers
WHEN NOT (EXISTS (SELECT 1 FROM fad_timing_changes AS change
  JOIN free_agent_drafts AS draft ON draft.league_id=change.league_id AND draft.id=change.fad_id
  JOIN json_each(change.before_rollovers_json) AS before
  JOIN json_each(change.after_rollovers_json) AS after ON json_extract(after.value,'$.id')=json_extract(before.value,'$.id')
  WHERE change.league_id=OLD.league_id AND change.fad_id=OLD.fad_id
    AND draft.status='cards_open' AND draft.version=json_extract(change.before_root_json,'$.version')
    AND OLD.id IS json_extract(before.value, '$.id')
    AND OLD.league_id IS json_extract(before.value, '$.league_id')
    AND OLD.season_id IS json_extract(before.value, '$.season_id')
    AND OLD.fad_id IS json_extract(before.value, '$.fad_id')
    AND OLD.sequence IS json_extract(before.value, '$.sequence')
    AND OLD.window_kind IS json_extract(before.value, '$.window_kind')
    AND OLD.predecessor_rollover_id IS json_extract(before.value, '$.predecessor_rollover_id')
    AND OLD.extension_reason IS json_extract(before.value, '$.extension_reason')
    AND OLD.extension_source_id IS json_extract(before.value, '$.extension_source_id')
    AND OLD.opens_at_ms IS json_extract(before.value, '$.opens_at_ms')
    AND OLD.creation_cutoff_at_ms IS json_extract(before.value, '$.creation_cutoff_at_ms')
    AND OLD.rolls_over_at_ms IS json_extract(before.value, '$.rolls_over_at_ms')
    AND OLD.status IS json_extract(before.value, '$.status')
    AND OLD.processing_job_run_id IS json_extract(before.value, '$.processing_job_run_id')
    AND OLD.processing_started_at_ms IS json_extract(before.value, '$.processing_started_at_ms')
    AND OLD.completed_at_ms IS json_extract(before.value, '$.completed_at_ms')
    AND OLD.last_error_code IS json_extract(before.value, '$.last_error_code')
    AND OLD.created_at_ms IS json_extract(before.value, '$.created_at_ms')
    AND OLD.updated_at_ms IS json_extract(before.value, '$.updated_at_ms')
    AND OLD.version IS json_extract(before.value, '$.version')
    AND NEW.id IS json_extract(after.value, '$.id')
    AND NEW.league_id IS json_extract(after.value, '$.league_id')
    AND NEW.season_id IS json_extract(after.value, '$.season_id')
    AND NEW.fad_id IS json_extract(after.value, '$.fad_id')
    AND NEW.sequence IS json_extract(after.value, '$.sequence')
    AND NEW.window_kind IS json_extract(after.value, '$.window_kind')
    AND NEW.predecessor_rollover_id IS json_extract(after.value, '$.predecessor_rollover_id')
    AND NEW.extension_reason IS json_extract(after.value, '$.extension_reason')
    AND NEW.extension_source_id IS json_extract(after.value, '$.extension_source_id')
    AND NEW.opens_at_ms IS json_extract(after.value, '$.opens_at_ms')
    AND NEW.creation_cutoff_at_ms IS json_extract(after.value, '$.creation_cutoff_at_ms')
    AND NEW.rolls_over_at_ms IS json_extract(after.value, '$.rolls_over_at_ms')
    AND NEW.status IS json_extract(after.value, '$.status')
    AND NEW.processing_job_run_id IS json_extract(after.value, '$.processing_job_run_id')
    AND NEW.processing_started_at_ms IS json_extract(after.value, '$.processing_started_at_ms')
    AND NEW.completed_at_ms IS json_extract(after.value, '$.completed_at_ms')
    AND NEW.last_error_code IS json_extract(after.value, '$.last_error_code')
    AND NEW.created_at_ms IS json_extract(after.value, '$.created_at_ms')
    AND NEW.updated_at_ms IS json_extract(after.value, '$.updated_at_ms')
    AND NEW.version IS json_extract(after.value, '$.version')))
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

DROP TRIGGER free_agent_drafts_initial_timing_immutable;
CREATE TRIGGER free_agent_drafts_initial_timing_immutable
BEFORE UPDATE OF initial_rollover_times_json ON free_agent_drafts
WHEN NEW.initial_rollover_times_json IS NOT OLD.initial_rollover_times_json
  AND NOT (OLD.status='cards_open' AND NEW.status='cards_open' AND EXISTS (SELECT 1 FROM fad_timing_changes AS change
  WHERE change.league_id=OLD.league_id AND change.fad_id=OLD.id
    AND OLD.id IS json_extract(change.before_root_json, '$.id')
    AND OLD.league_id IS json_extract(change.before_root_json, '$.league_id')
    AND OLD.season_id IS json_extract(change.before_root_json, '$.season_id')
    AND OLD.readiness_operation_id IS json_extract(change.before_root_json, '$.readiness_operation_id')
    AND OLD.readiness_occurrence_key IS json_extract(change.before_root_json, '$.readiness_occurrence_key')
    AND OLD.first_matchup_week_id IS json_extract(change.before_root_json, '$.first_matchup_week_id')
    AND OLD.current_competition_first_matchup_week_id IS json_extract(change.before_root_json, '$.current_competition_first_matchup_week_id')
    AND OLD.schedule_recovery_id IS json_extract(change.before_root_json, '$.schedule_recovery_id')
    AND OLD.participating_team_count IS json_extract(change.before_root_json, '$.participating_team_count')
    AND OLD.status IS json_extract(change.before_root_json, '$.status')
    AND OLD.setup_path IS json_extract(change.before_root_json, '$.setup_path')
    AND OLD.entry_draft_id IS json_extract(change.before_root_json, '$.entry_draft_id')
    AND OLD.setup_exemption_id IS json_extract(change.before_root_json, '$.setup_exemption_id')
    AND OLD.prior_season_rollover_id IS json_extract(change.before_root_json, '$.prior_season_rollover_id')
    AND OLD.no_draft_reason IS json_extract(change.before_root_json, '$.no_draft_reason')
    AND OLD.opening_authority IS json_extract(change.before_root_json, '$.opening_authority')
    AND OLD.opened_at_ms IS json_extract(change.before_root_json, '$.opened_at_ms')
    AND OLD.help_opens_at_ms IS json_extract(change.before_root_json, '$.help_opens_at_ms')
    AND OLD.candidate_deadline_at_ms IS json_extract(change.before_root_json, '$.candidate_deadline_at_ms')
    AND OLD.first_matchup_starts_at_ms IS json_extract(change.before_root_json, '$.first_matchup_starts_at_ms')
    AND OLD.initial_rollover_times_json IS json_extract(change.before_root_json, '$.initial_rollover_times_json')
    AND OLD.deadline_locked_at_ms IS json_extract(change.before_root_json, '$.deadline_locked_at_ms')
    AND OLD.allocation_completed_at_ms IS json_extract(change.before_root_json, '$.allocation_completed_at_ms')
    AND OLD.completed_at_ms IS json_extract(change.before_root_json, '$.completed_at_ms')
    AND OLD.created_at_ms IS json_extract(change.before_root_json, '$.created_at_ms')
    AND OLD.updated_at_ms IS json_extract(change.before_root_json, '$.updated_at_ms')
    AND OLD.version IS json_extract(change.before_root_json, '$.version')
    AND NEW.id IS json_extract(change.after_root_json, '$.id')
    AND NEW.league_id IS json_extract(change.after_root_json, '$.league_id')
    AND NEW.season_id IS json_extract(change.after_root_json, '$.season_id')
    AND NEW.readiness_operation_id IS json_extract(change.after_root_json, '$.readiness_operation_id')
    AND NEW.readiness_occurrence_key IS json_extract(change.after_root_json, '$.readiness_occurrence_key')
    AND NEW.first_matchup_week_id IS json_extract(change.after_root_json, '$.first_matchup_week_id')
    AND NEW.current_competition_first_matchup_week_id IS json_extract(change.after_root_json, '$.current_competition_first_matchup_week_id')
    AND NEW.schedule_recovery_id IS json_extract(change.after_root_json, '$.schedule_recovery_id')
    AND NEW.participating_team_count IS json_extract(change.after_root_json, '$.participating_team_count')
    AND NEW.status IS json_extract(change.after_root_json, '$.status')
    AND NEW.setup_path IS json_extract(change.after_root_json, '$.setup_path')
    AND NEW.entry_draft_id IS json_extract(change.after_root_json, '$.entry_draft_id')
    AND NEW.setup_exemption_id IS json_extract(change.after_root_json, '$.setup_exemption_id')
    AND NEW.prior_season_rollover_id IS json_extract(change.after_root_json, '$.prior_season_rollover_id')
    AND NEW.no_draft_reason IS json_extract(change.after_root_json, '$.no_draft_reason')
    AND NEW.opening_authority IS json_extract(change.after_root_json, '$.opening_authority')
    AND NEW.opened_at_ms IS json_extract(change.after_root_json, '$.opened_at_ms')
    AND NEW.help_opens_at_ms IS json_extract(change.after_root_json, '$.help_opens_at_ms')
    AND NEW.candidate_deadline_at_ms IS json_extract(change.after_root_json, '$.candidate_deadline_at_ms')
    AND NEW.first_matchup_starts_at_ms IS json_extract(change.after_root_json, '$.first_matchup_starts_at_ms')
    AND NEW.initial_rollover_times_json IS json_extract(change.after_root_json, '$.initial_rollover_times_json')
    AND NEW.deadline_locked_at_ms IS json_extract(change.after_root_json, '$.deadline_locked_at_ms')
    AND NEW.allocation_completed_at_ms IS json_extract(change.after_root_json, '$.allocation_completed_at_ms')
    AND NEW.completed_at_ms IS json_extract(change.after_root_json, '$.completed_at_ms')
    AND NEW.created_at_ms IS json_extract(change.after_root_json, '$.created_at_ms')
    AND NEW.updated_at_ms IS json_extract(change.after_root_json, '$.updated_at_ms')
    AND NEW.version IS json_extract(change.after_root_json, '$.version')
    AND (SELECT COUNT(*) FROM free_agent_draft_rollovers WHERE league_id=NEW.league_id AND fad_id=NEW.id)=json_array_length(change.after_rollovers_json)
    AND NOT EXISTS (SELECT 1 FROM json_each(change.after_rollovers_json) AS planned
      WHERE NOT EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS actual WHERE actual.id IS json_extract(planned.value, '$.id')
    AND actual.league_id IS json_extract(planned.value, '$.league_id')
    AND actual.season_id IS json_extract(planned.value, '$.season_id')
    AND actual.fad_id IS json_extract(planned.value, '$.fad_id')
    AND actual.sequence IS json_extract(planned.value, '$.sequence')
    AND actual.window_kind IS json_extract(planned.value, '$.window_kind')
    AND actual.predecessor_rollover_id IS json_extract(planned.value, '$.predecessor_rollover_id')
    AND actual.extension_reason IS json_extract(planned.value, '$.extension_reason')
    AND actual.extension_source_id IS json_extract(planned.value, '$.extension_source_id')
    AND actual.opens_at_ms IS json_extract(planned.value, '$.opens_at_ms')
    AND actual.creation_cutoff_at_ms IS json_extract(planned.value, '$.creation_cutoff_at_ms')
    AND actual.rolls_over_at_ms IS json_extract(planned.value, '$.rolls_over_at_ms')
    AND actual.status IS json_extract(planned.value, '$.status')
    AND actual.processing_job_run_id IS json_extract(planned.value, '$.processing_job_run_id')
    AND actual.processing_started_at_ms IS json_extract(planned.value, '$.processing_started_at_ms')
    AND actual.completed_at_ms IS json_extract(planned.value, '$.completed_at_ms')
    AND actual.last_error_code IS json_extract(planned.value, '$.last_error_code')
    AND actual.created_at_ms IS json_extract(planned.value, '$.created_at_ms')
    AND actual.updated_at_ms IS json_extract(planned.value, '$.updated_at_ms')
    AND actual.version IS json_extract(planned.value, '$.version')))
    AND NOT EXISTS (SELECT 1 FROM json_each(change.after_jobs_json) AS planned
      WHERE NOT EXISTS (SELECT 1 FROM job_runs AS actual WHERE actual.id IS json_extract(planned.value, '$.id')
    AND actual.league_id IS json_extract(planned.value, '$.league_id')
    AND actual.season_id IS json_extract(planned.value, '$.season_id')
    AND actual.job_type IS json_extract(planned.value, '$.job_type')
    AND actual.occurrence_key IS json_extract(planned.value, '$.occurrence_key')
    AND actual.scheduled_for_ms IS json_extract(planned.value, '$.scheduled_for_ms')
    AND actual.status IS json_extract(planned.value, '$.status')
    AND actual.attempt_count IS json_extract(planned.value, '$.attempt_count')
    AND actual.lease_owner IS json_extract(planned.value, '$.lease_owner')
    AND actual.lease_expires_at_ms IS json_extract(planned.value, '$.lease_expires_at_ms')
    AND actual.started_at_ms IS json_extract(planned.value, '$.started_at_ms')
    AND actual.completed_at_ms IS json_extract(planned.value, '$.completed_at_ms')
    AND actual.result_json IS json_extract(planned.value, '$.result_json')
    AND actual.last_error_code IS json_extract(planned.value, '$.last_error_code')
    AND actual.created_at_ms IS json_extract(planned.value, '$.created_at_ms')
    AND actual.updated_at_ms IS json_extract(planned.value, '$.updated_at_ms')
    AND actual.version IS json_extract(planned.value, '$.version')
    AND actual.lease_token IS json_extract(planned.value, '$.lease_token')
    AND actual.next_attempt_at_ms IS json_extract(planned.value, '$.next_attempt_at_ms')))))
BEGIN SELECT RAISE(ABORT, 'initial draft rollover instants are frozen after opening'); END;

DROP TRIGGER free_agent_drafts_deadline_allocation_barrier;
CREATE TRIGGER free_agent_drafts_deadline_allocation_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'cards_open'
  AND NEW.status = 'deadline_locked'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.window_kind = 'initial'
  ) <> COALESCE(json_array_length(NEW.initial_rollover_times_json), 7) THEN RAISE(
    ABORT,
    'FAD deadline requires the complete configured initial rollover schedule'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        free_agent_draft_rollovers.window_kind <> 'initial'
        OR free_agent_draft_rollovers.status <> 'scheduled'
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires all rapid rollovers to remain scheduled'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
  ) <> (
    SELECT COUNT(DISTINCT player_id)
    FROM candidate_card_snapshot_entries
    WHERE candidate_card_snapshot_entries.league_id = NEW.league_id
      AND candidate_card_snapshot_entries.season_id = NEW.season_id
      AND candidate_card_snapshot_entries.fad_id = NEW.id
      AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one pending allocation per candidate player'
  ) END;

  SELECT CASE WHEN
    EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id = NEW.league_id
        AND candidate_card_snapshot_entries.season_id = NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.id
        AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations
          WHERE free_agent_draft_player_allocations.league_id =
              candidate_card_snapshot_entries.league_id
            AND free_agent_draft_player_allocations.season_id =
              candidate_card_snapshot_entries.season_id
            AND free_agent_draft_player_allocations.fad_id =
              candidate_card_snapshot_entries.fad_id
            AND free_agent_draft_player_allocations.player_id =
              candidate_card_snapshot_entries.player_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id = NEW.league_id
        AND free_agent_draft_player_allocations.season_id = NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              free_agent_draft_player_allocations.league_id
            AND candidate_card_snapshot_entries.season_id =
              free_agent_draft_player_allocations.season_id
            AND candidate_card_snapshot_entries.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND candidate_card_snapshot_entries.player_id =
              free_agent_draft_player_allocations.player_id
            AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
        )
    )
  THEN RAISE(
    ABORT,
    'FAD deadline requires the exact Candidate snapshot player set'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status <> 'pending'
  ) THEN RAISE(
    ABORT,
    'FAD deadline allocations must all begin pending'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline_reminder'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':reminder:' ||
          (NEW.candidate_deadline_at_ms - 259200000)
      AND job_runs.scheduled_for_ms =
        NEW.candidate_deadline_at_ms - 259200000
  ) <> 1 AND NOT EXISTS (
    SELECT 1 FROM fad_timing_changes AS change
    JOIN json_each(change.after_jobs_json) AS saved
    JOIN job_runs AS reminder ON reminder.id=json_extract(saved.value,'$.id')
    JOIN free_agent_draft_readiness_operations AS readiness ON readiness.league_id=NEW.league_id AND readiness.id=NEW.readiness_operation_id
    WHERE change.league_id=NEW.league_id AND change.fad_id=NEW.id
      AND json_extract(change.after_root_json,'$.version')=OLD.version
      AND json_extract(change.after_root_json,'$.candidate_deadline_at_ms')=NEW.candidate_deadline_at_ms
      AND reminder.league_id=NEW.league_id AND reminder.season_id=NEW.season_id
      AND reminder.id=readiness.reminder_job_run_id
      AND reminder.job_type='fad_deadline_reminder' AND reminder.status='succeeded'
      AND reminder.id IS json_extract(saved.value, '$.id')
    AND reminder.league_id IS json_extract(saved.value, '$.league_id')
    AND reminder.season_id IS json_extract(saved.value, '$.season_id')
    AND reminder.job_type IS json_extract(saved.value, '$.job_type')
    AND reminder.occurrence_key IS json_extract(saved.value, '$.occurrence_key')
    AND reminder.scheduled_for_ms IS json_extract(saved.value, '$.scheduled_for_ms')
    AND reminder.status IS json_extract(saved.value, '$.status')
    AND reminder.attempt_count IS json_extract(saved.value, '$.attempt_count')
    AND reminder.lease_owner IS json_extract(saved.value, '$.lease_owner')
    AND reminder.lease_expires_at_ms IS json_extract(saved.value, '$.lease_expires_at_ms')
    AND reminder.started_at_ms IS json_extract(saved.value, '$.started_at_ms')
    AND reminder.completed_at_ms IS json_extract(saved.value, '$.completed_at_ms')
    AND reminder.result_json IS json_extract(saved.value, '$.result_json')
    AND reminder.last_error_code IS json_extract(saved.value, '$.last_error_code')
    AND reminder.created_at_ms IS json_extract(saved.value, '$.created_at_ms')
    AND reminder.updated_at_ms IS json_extract(saved.value, '$.updated_at_ms')
    AND reminder.version IS json_extract(saved.value, '$.version')
    AND reminder.lease_token IS json_extract(saved.value, '$.lease_token')
    AND reminder.next_attempt_at_ms IS json_extract(saved.value, '$.next_attempt_at_ms')
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires its exact reminder occurrence'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':deadline:' ||
          NEW.candidate_deadline_at_ms
      AND job_runs.scheduled_for_ms = NEW.candidate_deadline_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms >
        NEW.deadline_locked_at_ms
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD deadline requires its exact deadline occurrence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        SELECT COUNT(*)
        FROM job_runs
        WHERE job_runs.league_id = NEW.league_id
          AND job_runs.season_id = NEW.season_id
          AND job_runs.job_type = 'fad_rollover'
          AND job_runs.occurrence_key =
            'fad:' || NEW.id || ':rollover:' ||
              free_agent_draft_rollovers.sequence || ':' ||
              free_agent_draft_rollovers.rolls_over_at_ms
          AND job_runs.scheduled_for_ms =
            free_agent_draft_rollovers.rolls_over_at_ms
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one exact occurrence per rollover'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND (
        SELECT COUNT(*)
        FROM job_runs
        WHERE job_runs.league_id = NEW.league_id
          AND job_runs.season_id = NEW.season_id
          AND job_runs.job_type = 'fad_allocation'
          AND job_runs.occurrence_key =
            'fad:' || NEW.id || ':allocate:' ||
              free_agent_draft_player_allocations.player_id
          AND job_runs.scheduled_for_ms =
            NEW.candidate_deadline_at_ms
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one exact occurrence per allocation'
  ) END;
END;

UPDATE application_metadata SET metadata_value='69',updated_at_ms=max(updated_at_ms,69)
WHERE metadata_key='data_model_version' AND metadata_value='68';
