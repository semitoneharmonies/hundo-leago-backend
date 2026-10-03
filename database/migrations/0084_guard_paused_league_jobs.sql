-- Catch stale worker claims after an explicit website pause. Existing jobs and
-- clocks remain untouched. Global statistics, notices and backups continue.
CREATE TRIGGER job_runs_paused_league_insert BEFORE INSERT ON job_runs
WHEN NEW.status IN ('leased','running') AND EXISTS (
 SELECT 1 FROM league_freezes WHERE league_id=NEW.league_id AND status='active'
)
BEGIN SELECT RAISE(ABORT,'League competition is paused'); END;
CREATE TRIGGER job_runs_paused_league_update BEFORE UPDATE ON job_runs
WHEN NEW.status IN ('leased','running') AND EXISTS (
 SELECT 1 FROM league_freezes WHERE league_id=NEW.league_id AND status='active'
)
BEGIN SELECT RAISE(ABORT,'League competition is paused'); END;
UPDATE application_metadata SET metadata_value='84',updated_at_ms=max(updated_at_ms,84)
WHERE metadata_key='data_model_version' AND metadata_value='83';

-- Preserve both timing guards, permitting reviewed edits while the league is paused.
DROP TRIGGER fad_timing_changes_valid_insert;
CREATE TRIGGER fad_timing_changes_valid_insert BEFORE INSERT ON fad_timing_changes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM free_agent_drafts AS draft JOIN leagues AS league ON league.id=draft.league_id
    WHERE draft.league_id=NEW.league_id AND draft.id=NEW.fad_id
      AND draft.status IN ('cards_open','rapid') AND league.status IN ('active','frozen') AND league.current_season_id=draft.season_id
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
    AND (json_extract(NEW.before_root_json,'$.status')='rapid' OR json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms')>NEW.created_at_ms)
    AND json_array_length(NEW.after_rollovers_json)=json_array_length(NEW.before_rollovers_json)
    AND json_array_length(NEW.after_rollovers_json)=json_array_length(json_extract(NEW.after_root_json,'$.initial_rollover_times_json'))
    AND json_array_length(NEW.after_jobs_json)=json_array_length(NEW.before_jobs_json)
  ) THEN RAISE(ABORT,'FAD timing change must preserve draft identity and history') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.after_rollovers_json) AS after
    WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.before_rollovers_json) AS before WHERE (
      json_extract(NEW.before_root_json,'$.status')='rapid' AND before.key=after.key AND before.value=after.value) OR (
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
  )) THEN RAISE(ABORT,'FAD timing change must preserve scheduled round identities') END;
END;
DROP TRIGGER fad_auction_clock_changes_valid_insert;
CREATE TRIGGER fad_auction_clock_changes_valid_insert BEFORE INSERT ON fad_auction_clock_changes
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM fad_timing_changes WHERE id=NEW.change_id) OR NOT EXISTS(
   SELECT 1 FROM auctions a JOIN auction_contexts c ON c.league_id=a.league_id AND c.auction_id=a.id
   JOIN free_agent_drafts d ON d.league_id=c.league_id AND d.id=c.fad_id
   JOIN leagues l ON l.id=d.league_id
   JOIN free_agent_draft_rollovers r ON r.league_id=c.league_id AND r.id=c.fad_rollover_id
   JOIN job_runs j ON j.league_id=a.league_id AND j.season_id=a.season_id
     AND j.job_type='auction.resolve.target' AND j.occurrence_key='auction:'||a.id||':'||a.resolves_at_ms
   WHERE a.league_id=NEW.league_id AND a.id=NEW.auction_id AND a.status='open'
     AND a.resolves_at_ms=NEW.previous_closes_at_ms AND a.version=NEW.previous_auction_version
     AND c.fad_id=NEW.fad_id AND c.fad_rollover_id=NEW.rollover_id
     AND c.source_kind='fad_open_rapid' AND c.fad_origin='manager_nomination'
     AND r.rolls_over_at_ms=a.resolves_at_ms AND r.creation_cutoff_at_ms=NEW.previous_cutoff_at_ms
     AND d.status='rapid' AND l.status IN ('active','frozen') AND l.current_season_id=d.season_id
     AND r.status='scheduled' AND r.rolls_over_at_ms=a.resolves_at_ms
     AND NEW.closes_at_ms<=d.first_matchup_starts_at_ms
     AND j.status='pending' AND j.attempt_count=0 AND j.lease_owner IS NULL AND j.lease_token IS NULL
     AND j.lease_expires_at_ms IS NULL AND j.last_error_code IS NULL AND j.result_json IS NULL
     AND j.id IS json_extract(NEW.before_job_json,'$.id')
      AND j.league_id IS json_extract(NEW.before_job_json,'$.league_id')
      AND j.season_id IS json_extract(NEW.before_job_json,'$.season_id')
      AND j.job_type IS json_extract(NEW.before_job_json,'$.job_type')
      AND j.occurrence_key IS json_extract(NEW.before_job_json,'$.occurrence_key')
      AND j.scheduled_for_ms IS json_extract(NEW.before_job_json,'$.scheduled_for_ms')
      AND j.status IS json_extract(NEW.before_job_json,'$.status')
      AND j.attempt_count IS json_extract(NEW.before_job_json,'$.attempt_count')
      AND j.lease_owner IS json_extract(NEW.before_job_json,'$.lease_owner')
      AND j.lease_expires_at_ms IS json_extract(NEW.before_job_json,'$.lease_expires_at_ms')
      AND j.started_at_ms IS json_extract(NEW.before_job_json,'$.started_at_ms')
      AND j.completed_at_ms IS json_extract(NEW.before_job_json,'$.completed_at_ms')
      AND j.result_json IS json_extract(NEW.before_job_json,'$.result_json')
      AND j.last_error_code IS json_extract(NEW.before_job_json,'$.last_error_code')
      AND j.created_at_ms IS json_extract(NEW.before_job_json,'$.created_at_ms')
      AND j.updated_at_ms IS json_extract(NEW.before_job_json,'$.updated_at_ms')
      AND j.version IS json_extract(NEW.before_job_json,'$.version')
      AND j.lease_token IS json_extract(NEW.before_job_json,'$.lease_token')
      AND j.next_attempt_at_ms IS json_extract(NEW.before_job_json,'$.next_attempt_at_ms')
     AND NOT EXISTS(SELECT 1 FROM auction_resolutions x WHERE x.league_id=a.league_id AND x.auction_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM free_agent_draft_recoveries x WHERE x.league_id=a.league_id AND x.auction_id=a.id)
 ) THEN RAISE(ABORT,'Only idle open manager nominations may change their clocks') END;
 SELECT CASE WHEN (
   json_extract(NEW.before_job_json,'$.id') IS json_extract(NEW.after_job_json,'$.id')
      AND json_extract(NEW.before_job_json,'$.league_id') IS json_extract(NEW.after_job_json,'$.league_id')
      AND json_extract(NEW.before_job_json,'$.season_id') IS json_extract(NEW.after_job_json,'$.season_id')
      AND json_extract(NEW.before_job_json,'$.job_type') IS json_extract(NEW.after_job_json,'$.job_type')
      AND json_extract(NEW.before_job_json,'$.status') IS json_extract(NEW.after_job_json,'$.status')
      AND json_extract(NEW.before_job_json,'$.attempt_count') IS json_extract(NEW.after_job_json,'$.attempt_count')
      AND json_extract(NEW.before_job_json,'$.lease_owner') IS json_extract(NEW.after_job_json,'$.lease_owner')
      AND json_extract(NEW.before_job_json,'$.lease_expires_at_ms') IS json_extract(NEW.after_job_json,'$.lease_expires_at_ms')
      AND json_extract(NEW.before_job_json,'$.started_at_ms') IS json_extract(NEW.after_job_json,'$.started_at_ms')
      AND json_extract(NEW.before_job_json,'$.completed_at_ms') IS json_extract(NEW.after_job_json,'$.completed_at_ms')
      AND json_extract(NEW.before_job_json,'$.result_json') IS json_extract(NEW.after_job_json,'$.result_json')
      AND json_extract(NEW.before_job_json,'$.last_error_code') IS json_extract(NEW.after_job_json,'$.last_error_code')
      AND json_extract(NEW.before_job_json,'$.created_at_ms') IS json_extract(NEW.after_job_json,'$.created_at_ms')
      AND json_extract(NEW.before_job_json,'$.lease_token') IS json_extract(NEW.after_job_json,'$.lease_token')
   AND json_extract(NEW.after_job_json,'$.scheduled_for_ms')=NEW.closes_at_ms
   AND json_extract(NEW.after_job_json,'$.occurrence_key')='auction:'||NEW.auction_id||':'||NEW.closes_at_ms
   AND json_extract(NEW.after_job_json,'$.next_attempt_at_ms') IS NULL
   AND json_extract(NEW.after_job_json,'$.updated_at_ms')=max(NEW.created_at_ms,json_extract(NEW.before_job_json,'$.updated_at_ms'))
   AND json_extract(NEW.after_job_json,'$.version')=json_extract(NEW.before_job_json,'$.version')+1
 ) IS NOT TRUE THEN RAISE(ABORT,'Auction clock changes preserve the original resolution job identity') END;
END;
