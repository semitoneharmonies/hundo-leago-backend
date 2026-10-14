-- Attach a confirmed first timetable to Goon's existing unscheduled draft.
-- No existing data changes during migration. All other league transitions retain their guards.
CREATE TABLE goon_draft_scheduling_receipts (
 id TEXT PRIMARY KEY, league_id TEXT NOT NULL CHECK(league_id='48e59cfb-b12d-4dfb-ae1a-4d8b3512ef03'),
 season_id TEXT NOT NULL, fad_id TEXT NOT NULL UNIQUE, actor_user_id TEXT NOT NULL REFERENCES users(id),
 before_root_json TEXT NOT NULL CHECK(json_valid(before_root_json)), after_root_json TEXT NOT NULL CHECK(json_valid(after_root_json)),
 before_readiness_json TEXT NOT NULL CHECK(json_valid(before_readiness_json)), after_readiness_json TEXT NOT NULL CHECK(json_valid(after_readiness_json)),
 rollovers_json TEXT NOT NULL CHECK(json_valid(rollovers_json) AND json_type(rollovers_json)='array'),
 jobs_json TEXT NOT NULL CHECK(json_valid(jobs_json) AND json_type(jobs_json)='array'),
 card_baselines_json TEXT NOT NULL CHECK(json_valid(card_baselines_json) AND json_type(card_baselines_json)='array'),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 FOREIGN KEY(league_id,season_id,fad_id) REFERENCES free_agent_drafts(league_id,season_id,id),
 FOREIGN KEY(league_id,id) REFERENCES season_matchup_schedule_generations(league_id,schedule_operation_id)
) STRICT;
CREATE TRIGGER goon_draft_scheduling_receipts_no_update BEFORE UPDATE ON goon_draft_scheduling_receipts BEGIN SELECT RAISE(ABORT,'Draft scheduling receipts are immutable'); END;
CREATE TRIGGER goon_draft_scheduling_receipts_no_delete BEFORE DELETE ON goon_draft_scheduling_receipts BEGIN SELECT RAISE(ABORT,'Draft scheduling receipts are immutable'); END;
CREATE TRIGGER goon_draft_scheduling_receipts_valid_insert BEFORE INSERT ON goon_draft_scheduling_receipts
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM free_agent_drafts d JOIN leagues l ON l.id=d.league_id
  JOIN free_agent_draft_readiness_operations r ON r.league_id=d.league_id AND r.id=d.readiness_operation_id
  JOIN season_matchup_schedule_generations s ON s.league_id=d.league_id AND s.season_id=d.season_id AND s.schedule_operation_id=NEW.id
  JOIN matchup_operations o ON o.league_id=s.league_id AND o.id=s.schedule_operation_id
  WHERE d.league_id=NEW.league_id AND d.season_id=NEW.season_id AND d.id=NEW.fad_id
   AND l.status='active' AND l.current_season_id=d.season_id AND s.status='current' AND o.actor_user_id=NEW.actor_user_id
   AND NOT EXISTS(SELECT 1 FROM league_freezes f WHERE f.league_id=d.league_id AND f.status='active')
   AND s.created_at_ms=NEW.created_at_ms AND d.status='cards_open' AND d.candidate_deadline_at_ms IS NULL
   AND r.status='succeeded' AND r.created_fad_id=d.id
   AND d.id IS json_extract(NEW.before_root_json, '$.id')
    AND d.league_id IS json_extract(NEW.before_root_json, '$.league_id')
    AND d.season_id IS json_extract(NEW.before_root_json, '$.season_id')
    AND d.readiness_operation_id IS json_extract(NEW.before_root_json, '$.readiness_operation_id')
    AND d.readiness_occurrence_key IS json_extract(NEW.before_root_json, '$.readiness_occurrence_key')
    AND d.first_matchup_week_id IS json_extract(NEW.before_root_json, '$.first_matchup_week_id')
    AND d.current_competition_first_matchup_week_id IS json_extract(NEW.before_root_json, '$.current_competition_first_matchup_week_id')
    AND d.schedule_recovery_id IS json_extract(NEW.before_root_json, '$.schedule_recovery_id')
    AND d.participating_team_count IS json_extract(NEW.before_root_json, '$.participating_team_count')
    AND d.status IS json_extract(NEW.before_root_json, '$.status')
    AND d.setup_path IS json_extract(NEW.before_root_json, '$.setup_path')
    AND d.entry_draft_id IS json_extract(NEW.before_root_json, '$.entry_draft_id')
    AND d.setup_exemption_id IS json_extract(NEW.before_root_json, '$.setup_exemption_id')
    AND d.prior_season_rollover_id IS json_extract(NEW.before_root_json, '$.prior_season_rollover_id')
    AND d.no_draft_reason IS json_extract(NEW.before_root_json, '$.no_draft_reason')
    AND d.opening_authority IS json_extract(NEW.before_root_json, '$.opening_authority')
    AND d.opened_at_ms IS json_extract(NEW.before_root_json, '$.opened_at_ms')
    AND d.help_opens_at_ms IS json_extract(NEW.before_root_json, '$.help_opens_at_ms')
    AND d.candidate_deadline_at_ms IS json_extract(NEW.before_root_json, '$.candidate_deadline_at_ms')
    AND d.first_matchup_starts_at_ms IS json_extract(NEW.before_root_json, '$.first_matchup_starts_at_ms')
    AND d.initial_rollover_times_json IS json_extract(NEW.before_root_json, '$.initial_rollover_times_json')
    AND d.auction_creation_cutoff_minutes IS json_extract(NEW.before_root_json, '$.auction_creation_cutoff_minutes')
    AND d.rollover_interval_minutes IS json_extract(NEW.before_root_json, '$.rollover_interval_minutes')
    AND d.deadline_locked_at_ms IS json_extract(NEW.before_root_json, '$.deadline_locked_at_ms')
    AND d.allocation_completed_at_ms IS json_extract(NEW.before_root_json, '$.allocation_completed_at_ms')
    AND d.completed_at_ms IS json_extract(NEW.before_root_json, '$.completed_at_ms')
    AND d.created_at_ms IS json_extract(NEW.before_root_json, '$.created_at_ms')
    AND d.updated_at_ms IS json_extract(NEW.before_root_json, '$.updated_at_ms')
    AND d.version IS json_extract(NEW.before_root_json, '$.version')
   AND r.id IS json_extract(NEW.before_readiness_json, '$.id')
    AND r.league_id IS json_extract(NEW.before_readiness_json, '$.league_id')
    AND r.season_id IS json_extract(NEW.before_readiness_json, '$.season_id')
    AND r.readiness_occurrence_key IS json_extract(NEW.before_readiness_json, '$.readiness_occurrence_key')
    AND r.trigger_kind IS json_extract(NEW.before_readiness_json, '$.trigger_kind')
    AND r.entry_draft_id IS json_extract(NEW.before_readiness_json, '$.entry_draft_id')
    AND r.setup_exemption_id IS json_extract(NEW.before_readiness_json, '$.setup_exemption_id')
    AND r.job_run_id IS json_extract(NEW.before_readiness_json, '$.job_run_id')
    AND r.status IS json_extract(NEW.before_readiness_json, '$.status')
    AND r.attempt_count IS json_extract(NEW.before_readiness_json, '$.attempt_count')
    AND r.lease_owner IS json_extract(NEW.before_readiness_json, '$.lease_owner')
    AND r.lease_token IS json_extract(NEW.before_readiness_json, '$.lease_token')
    AND r.lease_expires_at_ms IS json_extract(NEW.before_readiness_json, '$.lease_expires_at_ms')
    AND r.blockers_json IS json_extract(NEW.before_readiness_json, '$.blockers_json')
    AND r.matchup_schedule_version_before IS json_extract(NEW.before_readiness_json, '$.matchup_schedule_version_before')
    AND r.matchup_schedule_version_after IS json_extract(NEW.before_readiness_json, '$.matchup_schedule_version_after')
    AND r.schedule_recovery_id IS json_extract(NEW.before_readiness_json, '$.schedule_recovery_id')
    AND r.created_fad_id IS json_extract(NEW.before_readiness_json, '$.created_fad_id')
    AND r.reminder_job_run_id IS json_extract(NEW.before_readiness_json, '$.reminder_job_run_id')
    AND r.deadline_job_run_id IS json_extract(NEW.before_readiness_json, '$.deadline_job_run_id')
    AND r.cards_opened_activity_id IS json_extract(NEW.before_readiness_json, '$.cards_opened_activity_id')
    AND r.cards_opened_outbox_event_id IS json_extract(NEW.before_readiness_json, '$.cards_opened_outbox_event_id')
    AND r.started_at_ms IS json_extract(NEW.before_readiness_json, '$.started_at_ms')
    AND r.next_retry_at_ms IS json_extract(NEW.before_readiness_json, '$.next_retry_at_ms')
    AND r.terminal_at_ms IS json_extract(NEW.before_readiness_json, '$.terminal_at_ms')
    AND r.created_at_ms IS json_extract(NEW.before_readiness_json, '$.created_at_ms')
    AND r.updated_at_ms IS json_extract(NEW.before_readiness_json, '$.updated_at_ms')
    AND r.version IS json_extract(NEW.before_readiness_json, '$.version')
   AND d.id IS json_extract(NEW.after_root_json, '$.id')
    AND d.league_id IS json_extract(NEW.after_root_json, '$.league_id')
    AND d.season_id IS json_extract(NEW.after_root_json, '$.season_id')
    AND d.readiness_operation_id IS json_extract(NEW.after_root_json, '$.readiness_operation_id')
    AND d.readiness_occurrence_key IS json_extract(NEW.after_root_json, '$.readiness_occurrence_key')
    AND d.schedule_recovery_id IS json_extract(NEW.after_root_json, '$.schedule_recovery_id')
    AND d.participating_team_count IS json_extract(NEW.after_root_json, '$.participating_team_count')
    AND d.status IS json_extract(NEW.after_root_json, '$.status')
    AND d.setup_path IS json_extract(NEW.after_root_json, '$.setup_path')
    AND d.entry_draft_id IS json_extract(NEW.after_root_json, '$.entry_draft_id')
    AND d.setup_exemption_id IS json_extract(NEW.after_root_json, '$.setup_exemption_id')
    AND d.prior_season_rollover_id IS json_extract(NEW.after_root_json, '$.prior_season_rollover_id')
    AND d.no_draft_reason IS json_extract(NEW.after_root_json, '$.no_draft_reason')
    AND d.opening_authority IS json_extract(NEW.after_root_json, '$.opening_authority')
    AND d.opened_at_ms IS json_extract(NEW.after_root_json, '$.opened_at_ms')
    AND d.auction_creation_cutoff_minutes IS json_extract(NEW.after_root_json, '$.auction_creation_cutoff_minutes')
    AND d.rollover_interval_minutes IS json_extract(NEW.after_root_json, '$.rollover_interval_minutes')
    AND d.deadline_locked_at_ms IS json_extract(NEW.after_root_json, '$.deadline_locked_at_ms')
    AND d.allocation_completed_at_ms IS json_extract(NEW.after_root_json, '$.allocation_completed_at_ms')
    AND d.completed_at_ms IS json_extract(NEW.after_root_json, '$.completed_at_ms')
    AND d.created_at_ms IS json_extract(NEW.after_root_json, '$.created_at_ms')
   AND r.id IS json_extract(NEW.after_readiness_json, '$.id')
    AND r.league_id IS json_extract(NEW.after_readiness_json, '$.league_id')
    AND r.season_id IS json_extract(NEW.after_readiness_json, '$.season_id')
    AND r.readiness_occurrence_key IS json_extract(NEW.after_readiness_json, '$.readiness_occurrence_key')
    AND r.trigger_kind IS json_extract(NEW.after_readiness_json, '$.trigger_kind')
    AND r.entry_draft_id IS json_extract(NEW.after_readiness_json, '$.entry_draft_id')
    AND r.setup_exemption_id IS json_extract(NEW.after_readiness_json, '$.setup_exemption_id')
    AND r.job_run_id IS json_extract(NEW.after_readiness_json, '$.job_run_id')
    AND r.status IS json_extract(NEW.after_readiness_json, '$.status')
    AND r.attempt_count IS json_extract(NEW.after_readiness_json, '$.attempt_count')
    AND r.lease_owner IS json_extract(NEW.after_readiness_json, '$.lease_owner')
    AND r.lease_token IS json_extract(NEW.after_readiness_json, '$.lease_token')
    AND r.lease_expires_at_ms IS json_extract(NEW.after_readiness_json, '$.lease_expires_at_ms')
    AND r.blockers_json IS json_extract(NEW.after_readiness_json, '$.blockers_json')
    AND r.matchup_schedule_version_before IS json_extract(NEW.after_readiness_json, '$.matchup_schedule_version_before')
    AND r.matchup_schedule_version_after IS json_extract(NEW.after_readiness_json, '$.matchup_schedule_version_after')
    AND r.schedule_recovery_id IS json_extract(NEW.after_readiness_json, '$.schedule_recovery_id')
    AND r.created_fad_id IS json_extract(NEW.after_readiness_json, '$.created_fad_id')
    AND r.cards_opened_activity_id IS json_extract(NEW.after_readiness_json, '$.cards_opened_activity_id')
    AND r.cards_opened_outbox_event_id IS json_extract(NEW.after_readiness_json, '$.cards_opened_outbox_event_id')
    AND r.started_at_ms IS json_extract(NEW.after_readiness_json, '$.started_at_ms')
    AND r.next_retry_at_ms IS json_extract(NEW.after_readiness_json, '$.next_retry_at_ms')
    AND r.terminal_at_ms IS json_extract(NEW.after_readiness_json, '$.terminal_at_ms')
    AND r.created_at_ms IS json_extract(NEW.after_readiness_json, '$.created_at_ms')
   AND json_extract(NEW.after_root_json,'$.version')=d.version+1
   AND json_extract(NEW.after_root_json,'$.updated_at_ms')=max(d.updated_at_ms,NEW.created_at_ms)
   AND json_extract(NEW.after_root_json,'$.first_matchup_week_id')=s.week_one_matchup_week_id
   AND json_extract(NEW.after_root_json,'$.current_competition_first_matchup_week_id')=s.week_one_matchup_week_id
   AND json_extract(NEW.after_root_json,'$.first_matchup_starts_at_ms')=s.week_one_starts_at_ms
   AND json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms')=json_extract(s.fad_timing_json,'$.candidateDeadlineAtMs')
   AND json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms')>max(d.opened_at_ms,NEW.created_at_ms)
   AND json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms')<s.week_one_starts_at_ms
   AND json_extract(NEW.after_root_json,'$.help_opens_at_ms')=max(d.opened_at_ms,json_extract(s.fad_timing_json,'$.candidateDeadlineAtMs')-172800000)
   AND json_extract(NEW.after_root_json,'$.initial_rollover_times_json')=json_extract(s.fad_timing_json,'$.rolloverTimesAtMs')
   AND json_array_length(NEW.rollovers_json)=json_array_length(s.fad_timing_json,'$.rolloverTimesAtMs')
   AND json_array_length(NEW.rollovers_json) BETWEEN 1 AND 1000
   AND json_array_length(NEW.jobs_json)=json_array_length(NEW.rollovers_json)+2
   AND NOT EXISTS(SELECT 1 FROM free_agent_draft_rollovers x WHERE x.league_id=d.league_id AND x.fad_id=d.id)
   AND NOT EXISTS(SELECT 1 FROM candidate_card_snapshots x WHERE x.league_id=d.league_id AND x.fad_id=d.id)
   AND NOT EXISTS(SELECT 1 FROM free_agent_draft_player_allocations x WHERE x.league_id=d.league_id AND x.fad_id=d.id)
   AND NOT EXISTS(SELECT 1 FROM auction_contexts x WHERE x.league_id=d.league_id AND x.fad_id=d.id)
   AND (SELECT count(*) FROM candidate_cards c WHERE c.league_id=d.league_id AND c.fad_id=d.id AND c.status='open')=d.participating_team_count
   AND json_array_length(NEW.card_baselines_json)=d.participating_team_count
   AND (SELECT count(DISTINCT json_extract(b.value,'$.cardId')) FROM json_each(NEW.card_baselines_json) b)=d.participating_team_count
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.card_baselines_json) b WHERE NOT EXISTS(
    SELECT 1 FROM candidate_cards c WHERE c.league_id=d.league_id AND c.fad_id=d.id
     AND c.id=json_extract(b.value,'$.cardId') AND c.version=json_extract(b.value,'$.cardVersion')
     AND json_extract(b.value,'$.resetVersion')>=0
     AND json_extract(b.value,'$.revisionCount')=c.version-json_extract(b.value,'$.resetVersion')
     AND (SELECT count(*) FROM candidate_card_revisions rev WHERE rev.league_id=c.league_id AND rev.card_id=c.id)=json_extract(b.value,'$.revisionCount')
     AND (SELECT min(resulting_card_version) FROM candidate_card_revisions rev WHERE rev.league_id=c.league_id AND rev.card_id=c.id) IS json_extract(b.value,'$.firstRevision')
     AND (SELECT max(resulting_card_version) FROM candidate_card_revisions rev WHERE rev.league_id=c.league_id AND rev.card_id=c.id) IS json_extract(b.value,'$.lastRevision')
     AND (json_extract(b.value,'$.revisionCount')=0 OR
       (json_extract(b.value,'$.firstRevision')=json_extract(b.value,'$.resetVersion')+1 AND json_extract(b.value,'$.lastRevision')=c.version))))
   AND json_extract(NEW.after_readiness_json,'$.version')=r.version+1
   AND json_extract(NEW.after_readiness_json,'$.updated_at_ms')=max(r.updated_at_ms,NEW.created_at_ms)
   AND EXISTS(SELECT 1 FROM job_runs j WHERE j.id=json_extract(NEW.after_readiness_json,'$.deadline_job_run_id')
     AND j.league_id=d.league_id AND j.season_id=d.season_id AND j.job_type='fad_deadline' AND j.status='pending'
     AND j.attempt_count=0 AND j.version=1 AND j.created_at_ms=NEW.created_at_ms
     AND j.scheduled_for_ms=json_extract(s.fad_timing_json,'$.candidateDeadlineAtMs')
     AND j.occurrence_key='fad:'||d.id||':deadline:'||j.scheduled_for_ms)
   AND EXISTS(SELECT 1 FROM job_runs j WHERE j.id=json_extract(NEW.after_readiness_json,'$.reminder_job_run_id')
     AND j.league_id=d.league_id AND j.season_id=d.season_id AND j.job_type='fad_deadline_reminder' AND j.status='pending'
     AND j.attempt_count=0 AND j.version=1 AND j.created_at_ms=NEW.created_at_ms
     AND j.scheduled_for_ms=json_extract(s.fad_timing_json,'$.candidateDeadlineAtMs')-259200000
     AND j.occurrence_key='fad:'||d.id||':reminder:'||j.scheduled_for_ms)
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.jobs_json) p WHERE NOT EXISTS(SELECT 1 FROM job_runs actual WHERE actual.id IS json_extract(p.value, '$.id')
    AND actual.league_id IS json_extract(p.value, '$.league_id')
    AND actual.season_id IS json_extract(p.value, '$.season_id')
    AND actual.job_type IS json_extract(p.value, '$.job_type')
    AND actual.occurrence_key IS json_extract(p.value, '$.occurrence_key')
    AND actual.scheduled_for_ms IS json_extract(p.value, '$.scheduled_for_ms')
    AND actual.status IS json_extract(p.value, '$.status')
    AND actual.attempt_count IS json_extract(p.value, '$.attempt_count')
    AND actual.lease_owner IS json_extract(p.value, '$.lease_owner')
    AND actual.lease_expires_at_ms IS json_extract(p.value, '$.lease_expires_at_ms')
    AND actual.started_at_ms IS json_extract(p.value, '$.started_at_ms')
    AND actual.completed_at_ms IS json_extract(p.value, '$.completed_at_ms')
    AND actual.result_json IS json_extract(p.value, '$.result_json')
    AND actual.last_error_code IS json_extract(p.value, '$.last_error_code')
    AND actual.created_at_ms IS json_extract(p.value, '$.created_at_ms')
    AND actual.updated_at_ms IS json_extract(p.value, '$.updated_at_ms')
    AND actual.version IS json_extract(p.value, '$.version')
    AND actual.lease_token IS json_extract(p.value, '$.lease_token')
    AND actual.next_attempt_at_ms IS json_extract(p.value, '$.next_attempt_at_ms')))
 ) THEN RAISE(ABORT,'Existing draft scheduling requires matching confirmed schedule evidence') END;
END;

DROP TRIGGER free_agent_drafts_forward_update;
CREATE TRIGGER free_agent_drafts_forward_update
BEFORE UPDATE ON free_agent_drafts
WHEN NOT (EXISTS(SELECT 1 FROM goon_draft_scheduling_receipts scheduled WHERE scheduled.league_id=OLD.league_id
    AND OLD.id IS json_extract(scheduled.before_root_json, '$.id')
    AND OLD.league_id IS json_extract(scheduled.before_root_json, '$.league_id')
    AND OLD.season_id IS json_extract(scheduled.before_root_json, '$.season_id')
    AND OLD.readiness_operation_id IS json_extract(scheduled.before_root_json, '$.readiness_operation_id')
    AND OLD.readiness_occurrence_key IS json_extract(scheduled.before_root_json, '$.readiness_occurrence_key')
    AND OLD.first_matchup_week_id IS json_extract(scheduled.before_root_json, '$.first_matchup_week_id')
    AND OLD.current_competition_first_matchup_week_id IS json_extract(scheduled.before_root_json, '$.current_competition_first_matchup_week_id')
    AND OLD.schedule_recovery_id IS json_extract(scheduled.before_root_json, '$.schedule_recovery_id')
    AND OLD.participating_team_count IS json_extract(scheduled.before_root_json, '$.participating_team_count')
    AND OLD.status IS json_extract(scheduled.before_root_json, '$.status')
    AND OLD.setup_path IS json_extract(scheduled.before_root_json, '$.setup_path')
    AND OLD.entry_draft_id IS json_extract(scheduled.before_root_json, '$.entry_draft_id')
    AND OLD.setup_exemption_id IS json_extract(scheduled.before_root_json, '$.setup_exemption_id')
    AND OLD.prior_season_rollover_id IS json_extract(scheduled.before_root_json, '$.prior_season_rollover_id')
    AND OLD.no_draft_reason IS json_extract(scheduled.before_root_json, '$.no_draft_reason')
    AND OLD.opening_authority IS json_extract(scheduled.before_root_json, '$.opening_authority')
    AND OLD.opened_at_ms IS json_extract(scheduled.before_root_json, '$.opened_at_ms')
    AND OLD.help_opens_at_ms IS json_extract(scheduled.before_root_json, '$.help_opens_at_ms')
    AND OLD.candidate_deadline_at_ms IS json_extract(scheduled.before_root_json, '$.candidate_deadline_at_ms')
    AND OLD.first_matchup_starts_at_ms IS json_extract(scheduled.before_root_json, '$.first_matchup_starts_at_ms')
    AND OLD.initial_rollover_times_json IS json_extract(scheduled.before_root_json, '$.initial_rollover_times_json')
    AND OLD.auction_creation_cutoff_minutes IS json_extract(scheduled.before_root_json, '$.auction_creation_cutoff_minutes')
    AND OLD.rollover_interval_minutes IS json_extract(scheduled.before_root_json, '$.rollover_interval_minutes')
    AND OLD.deadline_locked_at_ms IS json_extract(scheduled.before_root_json, '$.deadline_locked_at_ms')
    AND OLD.allocation_completed_at_ms IS json_extract(scheduled.before_root_json, '$.allocation_completed_at_ms')
    AND OLD.completed_at_ms IS json_extract(scheduled.before_root_json, '$.completed_at_ms')
    AND OLD.created_at_ms IS json_extract(scheduled.before_root_json, '$.created_at_ms')
    AND OLD.updated_at_ms IS json_extract(scheduled.before_root_json, '$.updated_at_ms')
    AND OLD.version IS json_extract(scheduled.before_root_json, '$.version')
    AND NEW.id IS json_extract(scheduled.after_root_json, '$.id')
    AND NEW.league_id IS json_extract(scheduled.after_root_json, '$.league_id')
    AND NEW.season_id IS json_extract(scheduled.after_root_json, '$.season_id')
    AND NEW.readiness_operation_id IS json_extract(scheduled.after_root_json, '$.readiness_operation_id')
    AND NEW.readiness_occurrence_key IS json_extract(scheduled.after_root_json, '$.readiness_occurrence_key')
    AND NEW.first_matchup_week_id IS json_extract(scheduled.after_root_json, '$.first_matchup_week_id')
    AND NEW.current_competition_first_matchup_week_id IS json_extract(scheduled.after_root_json, '$.current_competition_first_matchup_week_id')
    AND NEW.schedule_recovery_id IS json_extract(scheduled.after_root_json, '$.schedule_recovery_id')
    AND NEW.participating_team_count IS json_extract(scheduled.after_root_json, '$.participating_team_count')
    AND NEW.status IS json_extract(scheduled.after_root_json, '$.status')
    AND NEW.setup_path IS json_extract(scheduled.after_root_json, '$.setup_path')
    AND NEW.entry_draft_id IS json_extract(scheduled.after_root_json, '$.entry_draft_id')
    AND NEW.setup_exemption_id IS json_extract(scheduled.after_root_json, '$.setup_exemption_id')
    AND NEW.prior_season_rollover_id IS json_extract(scheduled.after_root_json, '$.prior_season_rollover_id')
    AND NEW.no_draft_reason IS json_extract(scheduled.after_root_json, '$.no_draft_reason')
    AND NEW.opening_authority IS json_extract(scheduled.after_root_json, '$.opening_authority')
    AND NEW.opened_at_ms IS json_extract(scheduled.after_root_json, '$.opened_at_ms')
    AND NEW.help_opens_at_ms IS json_extract(scheduled.after_root_json, '$.help_opens_at_ms')
    AND NEW.candidate_deadline_at_ms IS json_extract(scheduled.after_root_json, '$.candidate_deadline_at_ms')
    AND NEW.first_matchup_starts_at_ms IS json_extract(scheduled.after_root_json, '$.first_matchup_starts_at_ms')
    AND NEW.initial_rollover_times_json IS json_extract(scheduled.after_root_json, '$.initial_rollover_times_json')
    AND NEW.auction_creation_cutoff_minutes IS json_extract(scheduled.after_root_json, '$.auction_creation_cutoff_minutes')
    AND NEW.rollover_interval_minutes IS json_extract(scheduled.after_root_json, '$.rollover_interval_minutes')
    AND NEW.deadline_locked_at_ms IS json_extract(scheduled.after_root_json, '$.deadline_locked_at_ms')
    AND NEW.allocation_completed_at_ms IS json_extract(scheduled.after_root_json, '$.allocation_completed_at_ms')
    AND NEW.completed_at_ms IS json_extract(scheduled.after_root_json, '$.completed_at_ms')
    AND NEW.created_at_ms IS json_extract(scheduled.after_root_json, '$.created_at_ms')
    AND NEW.updated_at_ms IS json_extract(scheduled.after_root_json, '$.updated_at_ms')
    AND NEW.version IS json_extract(scheduled.after_root_json, '$.version'))) AND (NOT (OLD.status IN ('cards_open','rapid') AND NEW.status=OLD.status AND EXISTS (SELECT 1 FROM fad_timing_changes AS change
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
    AND actual.next_attempt_at_ms IS json_extract(planned.value, '$.next_attempt_at_ms'))))))
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

DROP TRIGGER free_agent_drafts_initial_timing_immutable;
CREATE TRIGGER free_agent_drafts_initial_timing_immutable
BEFORE UPDATE OF initial_rollover_times_json ON free_agent_drafts
WHEN NOT (EXISTS(SELECT 1 FROM goon_draft_scheduling_receipts scheduled WHERE scheduled.league_id=OLD.league_id
    AND OLD.id IS json_extract(scheduled.before_root_json, '$.id')
    AND OLD.league_id IS json_extract(scheduled.before_root_json, '$.league_id')
    AND OLD.season_id IS json_extract(scheduled.before_root_json, '$.season_id')
    AND OLD.readiness_operation_id IS json_extract(scheduled.before_root_json, '$.readiness_operation_id')
    AND OLD.readiness_occurrence_key IS json_extract(scheduled.before_root_json, '$.readiness_occurrence_key')
    AND OLD.first_matchup_week_id IS json_extract(scheduled.before_root_json, '$.first_matchup_week_id')
    AND OLD.current_competition_first_matchup_week_id IS json_extract(scheduled.before_root_json, '$.current_competition_first_matchup_week_id')
    AND OLD.schedule_recovery_id IS json_extract(scheduled.before_root_json, '$.schedule_recovery_id')
    AND OLD.participating_team_count IS json_extract(scheduled.before_root_json, '$.participating_team_count')
    AND OLD.status IS json_extract(scheduled.before_root_json, '$.status')
    AND OLD.setup_path IS json_extract(scheduled.before_root_json, '$.setup_path')
    AND OLD.entry_draft_id IS json_extract(scheduled.before_root_json, '$.entry_draft_id')
    AND OLD.setup_exemption_id IS json_extract(scheduled.before_root_json, '$.setup_exemption_id')
    AND OLD.prior_season_rollover_id IS json_extract(scheduled.before_root_json, '$.prior_season_rollover_id')
    AND OLD.no_draft_reason IS json_extract(scheduled.before_root_json, '$.no_draft_reason')
    AND OLD.opening_authority IS json_extract(scheduled.before_root_json, '$.opening_authority')
    AND OLD.opened_at_ms IS json_extract(scheduled.before_root_json, '$.opened_at_ms')
    AND OLD.help_opens_at_ms IS json_extract(scheduled.before_root_json, '$.help_opens_at_ms')
    AND OLD.candidate_deadline_at_ms IS json_extract(scheduled.before_root_json, '$.candidate_deadline_at_ms')
    AND OLD.first_matchup_starts_at_ms IS json_extract(scheduled.before_root_json, '$.first_matchup_starts_at_ms')
    AND OLD.initial_rollover_times_json IS json_extract(scheduled.before_root_json, '$.initial_rollover_times_json')
    AND OLD.auction_creation_cutoff_minutes IS json_extract(scheduled.before_root_json, '$.auction_creation_cutoff_minutes')
    AND OLD.rollover_interval_minutes IS json_extract(scheduled.before_root_json, '$.rollover_interval_minutes')
    AND OLD.deadline_locked_at_ms IS json_extract(scheduled.before_root_json, '$.deadline_locked_at_ms')
    AND OLD.allocation_completed_at_ms IS json_extract(scheduled.before_root_json, '$.allocation_completed_at_ms')
    AND OLD.completed_at_ms IS json_extract(scheduled.before_root_json, '$.completed_at_ms')
    AND OLD.created_at_ms IS json_extract(scheduled.before_root_json, '$.created_at_ms')
    AND OLD.updated_at_ms IS json_extract(scheduled.before_root_json, '$.updated_at_ms')
    AND OLD.version IS json_extract(scheduled.before_root_json, '$.version')
    AND NEW.id IS json_extract(scheduled.after_root_json, '$.id')
    AND NEW.league_id IS json_extract(scheduled.after_root_json, '$.league_id')
    AND NEW.season_id IS json_extract(scheduled.after_root_json, '$.season_id')
    AND NEW.readiness_operation_id IS json_extract(scheduled.after_root_json, '$.readiness_operation_id')
    AND NEW.readiness_occurrence_key IS json_extract(scheduled.after_root_json, '$.readiness_occurrence_key')
    AND NEW.first_matchup_week_id IS json_extract(scheduled.after_root_json, '$.first_matchup_week_id')
    AND NEW.current_competition_first_matchup_week_id IS json_extract(scheduled.after_root_json, '$.current_competition_first_matchup_week_id')
    AND NEW.schedule_recovery_id IS json_extract(scheduled.after_root_json, '$.schedule_recovery_id')
    AND NEW.participating_team_count IS json_extract(scheduled.after_root_json, '$.participating_team_count')
    AND NEW.status IS json_extract(scheduled.after_root_json, '$.status')
    AND NEW.setup_path IS json_extract(scheduled.after_root_json, '$.setup_path')
    AND NEW.entry_draft_id IS json_extract(scheduled.after_root_json, '$.entry_draft_id')
    AND NEW.setup_exemption_id IS json_extract(scheduled.after_root_json, '$.setup_exemption_id')
    AND NEW.prior_season_rollover_id IS json_extract(scheduled.after_root_json, '$.prior_season_rollover_id')
    AND NEW.no_draft_reason IS json_extract(scheduled.after_root_json, '$.no_draft_reason')
    AND NEW.opening_authority IS json_extract(scheduled.after_root_json, '$.opening_authority')
    AND NEW.opened_at_ms IS json_extract(scheduled.after_root_json, '$.opened_at_ms')
    AND NEW.help_opens_at_ms IS json_extract(scheduled.after_root_json, '$.help_opens_at_ms')
    AND NEW.candidate_deadline_at_ms IS json_extract(scheduled.after_root_json, '$.candidate_deadline_at_ms')
    AND NEW.first_matchup_starts_at_ms IS json_extract(scheduled.after_root_json, '$.first_matchup_starts_at_ms')
    AND NEW.initial_rollover_times_json IS json_extract(scheduled.after_root_json, '$.initial_rollover_times_json')
    AND NEW.auction_creation_cutoff_minutes IS json_extract(scheduled.after_root_json, '$.auction_creation_cutoff_minutes')
    AND NEW.rollover_interval_minutes IS json_extract(scheduled.after_root_json, '$.rollover_interval_minutes')
    AND NEW.deadline_locked_at_ms IS json_extract(scheduled.after_root_json, '$.deadline_locked_at_ms')
    AND NEW.allocation_completed_at_ms IS json_extract(scheduled.after_root_json, '$.allocation_completed_at_ms')
    AND NEW.completed_at_ms IS json_extract(scheduled.after_root_json, '$.completed_at_ms')
    AND NEW.created_at_ms IS json_extract(scheduled.after_root_json, '$.created_at_ms')
    AND NEW.updated_at_ms IS json_extract(scheduled.after_root_json, '$.updated_at_ms')
    AND NEW.version IS json_extract(scheduled.after_root_json, '$.version'))) AND (NEW.initial_rollover_times_json IS NOT OLD.initial_rollover_times_json
  AND NOT (OLD.status IN ('cards_open','rapid') AND NEW.status=OLD.status AND EXISTS (SELECT 1 FROM fad_timing_changes AS change
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
    AND actual.next_attempt_at_ms IS json_extract(planned.value, '$.next_attempt_at_ms'))))))
BEGIN SELECT RAISE(ABORT, 'initial draft rollover instants are frozen after opening'); END;

DROP TRIGGER free_agent_draft_readiness_operations_forward_update;
CREATE TRIGGER free_agent_draft_readiness_operations_forward_update
BEFORE UPDATE ON free_agent_draft_readiness_operations
WHEN NOT (EXISTS(SELECT 1 FROM goon_draft_scheduling_receipts scheduled WHERE scheduled.league_id=OLD.league_id
    AND OLD.id IS json_extract(scheduled.before_readiness_json, '$.id')
    AND OLD.league_id IS json_extract(scheduled.before_readiness_json, '$.league_id')
    AND OLD.season_id IS json_extract(scheduled.before_readiness_json, '$.season_id')
    AND OLD.readiness_occurrence_key IS json_extract(scheduled.before_readiness_json, '$.readiness_occurrence_key')
    AND OLD.trigger_kind IS json_extract(scheduled.before_readiness_json, '$.trigger_kind')
    AND OLD.entry_draft_id IS json_extract(scheduled.before_readiness_json, '$.entry_draft_id')
    AND OLD.setup_exemption_id IS json_extract(scheduled.before_readiness_json, '$.setup_exemption_id')
    AND OLD.job_run_id IS json_extract(scheduled.before_readiness_json, '$.job_run_id')
    AND OLD.status IS json_extract(scheduled.before_readiness_json, '$.status')
    AND OLD.attempt_count IS json_extract(scheduled.before_readiness_json, '$.attempt_count')
    AND OLD.lease_owner IS json_extract(scheduled.before_readiness_json, '$.lease_owner')
    AND OLD.lease_token IS json_extract(scheduled.before_readiness_json, '$.lease_token')
    AND OLD.lease_expires_at_ms IS json_extract(scheduled.before_readiness_json, '$.lease_expires_at_ms')
    AND OLD.blockers_json IS json_extract(scheduled.before_readiness_json, '$.blockers_json')
    AND OLD.matchup_schedule_version_before IS json_extract(scheduled.before_readiness_json, '$.matchup_schedule_version_before')
    AND OLD.matchup_schedule_version_after IS json_extract(scheduled.before_readiness_json, '$.matchup_schedule_version_after')
    AND OLD.schedule_recovery_id IS json_extract(scheduled.before_readiness_json, '$.schedule_recovery_id')
    AND OLD.created_fad_id IS json_extract(scheduled.before_readiness_json, '$.created_fad_id')
    AND OLD.reminder_job_run_id IS json_extract(scheduled.before_readiness_json, '$.reminder_job_run_id')
    AND OLD.deadline_job_run_id IS json_extract(scheduled.before_readiness_json, '$.deadline_job_run_id')
    AND OLD.cards_opened_activity_id IS json_extract(scheduled.before_readiness_json, '$.cards_opened_activity_id')
    AND OLD.cards_opened_outbox_event_id IS json_extract(scheduled.before_readiness_json, '$.cards_opened_outbox_event_id')
    AND OLD.started_at_ms IS json_extract(scheduled.before_readiness_json, '$.started_at_ms')
    AND OLD.next_retry_at_ms IS json_extract(scheduled.before_readiness_json, '$.next_retry_at_ms')
    AND OLD.terminal_at_ms IS json_extract(scheduled.before_readiness_json, '$.terminal_at_ms')
    AND OLD.created_at_ms IS json_extract(scheduled.before_readiness_json, '$.created_at_ms')
    AND OLD.updated_at_ms IS json_extract(scheduled.before_readiness_json, '$.updated_at_ms')
    AND OLD.version IS json_extract(scheduled.before_readiness_json, '$.version')
    AND NEW.id IS json_extract(scheduled.after_readiness_json, '$.id')
    AND NEW.league_id IS json_extract(scheduled.after_readiness_json, '$.league_id')
    AND NEW.season_id IS json_extract(scheduled.after_readiness_json, '$.season_id')
    AND NEW.readiness_occurrence_key IS json_extract(scheduled.after_readiness_json, '$.readiness_occurrence_key')
    AND NEW.trigger_kind IS json_extract(scheduled.after_readiness_json, '$.trigger_kind')
    AND NEW.entry_draft_id IS json_extract(scheduled.after_readiness_json, '$.entry_draft_id')
    AND NEW.setup_exemption_id IS json_extract(scheduled.after_readiness_json, '$.setup_exemption_id')
    AND NEW.job_run_id IS json_extract(scheduled.after_readiness_json, '$.job_run_id')
    AND NEW.status IS json_extract(scheduled.after_readiness_json, '$.status')
    AND NEW.attempt_count IS json_extract(scheduled.after_readiness_json, '$.attempt_count')
    AND NEW.lease_owner IS json_extract(scheduled.after_readiness_json, '$.lease_owner')
    AND NEW.lease_token IS json_extract(scheduled.after_readiness_json, '$.lease_token')
    AND NEW.lease_expires_at_ms IS json_extract(scheduled.after_readiness_json, '$.lease_expires_at_ms')
    AND NEW.blockers_json IS json_extract(scheduled.after_readiness_json, '$.blockers_json')
    AND NEW.matchup_schedule_version_before IS json_extract(scheduled.after_readiness_json, '$.matchup_schedule_version_before')
    AND NEW.matchup_schedule_version_after IS json_extract(scheduled.after_readiness_json, '$.matchup_schedule_version_after')
    AND NEW.schedule_recovery_id IS json_extract(scheduled.after_readiness_json, '$.schedule_recovery_id')
    AND NEW.created_fad_id IS json_extract(scheduled.after_readiness_json, '$.created_fad_id')
    AND NEW.reminder_job_run_id IS json_extract(scheduled.after_readiness_json, '$.reminder_job_run_id')
    AND NEW.deadline_job_run_id IS json_extract(scheduled.after_readiness_json, '$.deadline_job_run_id')
    AND NEW.cards_opened_activity_id IS json_extract(scheduled.after_readiness_json, '$.cards_opened_activity_id')
    AND NEW.cards_opened_outbox_event_id IS json_extract(scheduled.after_readiness_json, '$.cards_opened_outbox_event_id')
    AND NEW.started_at_ms IS json_extract(scheduled.after_readiness_json, '$.started_at_ms')
    AND NEW.next_retry_at_ms IS json_extract(scheduled.after_readiness_json, '$.next_retry_at_ms')
    AND NEW.terminal_at_ms IS json_extract(scheduled.after_readiness_json, '$.terminal_at_ms')
    AND NEW.created_at_ms IS json_extract(scheduled.after_readiness_json, '$.created_at_ms')
    AND NEW.updated_at_ms IS json_extract(scheduled.after_readiness_json, '$.updated_at_ms')
    AND NEW.version IS json_extract(scheduled.after_readiness_json, '$.version')))
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
                AND free_agent_draft_rollovers.sequence BETWEEN 1 AND COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7)
            ) = COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7)
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

DROP TRIGGER free_agent_drafts_deadline_completeness_update;
CREATE TRIGGER free_agent_drafts_deadline_completeness_update
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'cards_open'
  AND NEW.status = 'deadline_locked'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_teams
    WHERE free_agent_draft_teams.league_id = NEW.league_id
      AND free_agent_draft_teams.fad_id = NEW.id
  ) <> NEW.participating_team_count THEN RAISE(
    ABORT,
    'FAD deadline requires its committed frozen participants'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM candidate_cards
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.fad_id = NEW.id
      AND candidate_cards.status IN (
        'locked_complete',
        'locked_incomplete',
        'locked_conflicted'
      )
  ) <> (
    SELECT COUNT(*)
    FROM free_agent_draft_teams
    WHERE free_agent_draft_teams.league_id = NEW.league_id
      AND free_agent_draft_teams.fad_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one locked card per participant'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_cards
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.fad_id = NEW.id
      AND (
        (
          SELECT COUNT(*)
          FROM candidate_card_revisions
          WHERE candidate_card_revisions.league_id =
              candidate_cards.league_id
            AND candidate_card_revisions.card_id =
              candidate_cards.id
        ) <> candidate_cards.version - COALESCE((SELECT json_extract(b.value,'$.resetVersion') FROM goon_draft_scheduling_receipts scheduled,
 json_each(scheduled.card_baselines_json) b WHERE scheduled.league_id=candidate_cards.league_id
 AND scheduled.fad_id=candidate_cards.fad_id AND json_extract(b.value,'$.cardId')=candidate_cards.id),0)
        OR NOT EXISTS (
          SELECT 1
          FROM candidate_card_revisions
          WHERE candidate_card_revisions.league_id =
              candidate_cards.league_id
            AND candidate_card_revisions.card_id =
              candidate_cards.id
            AND ((candidate_card_revisions.resulting_card_version = 1 AND candidate_card_revisions.action = 'card_opened')
              OR (candidate_card_revisions.resulting_card_version = ((SELECT json_extract(b.value,'$.resetVersion') FROM goon_draft_scheduling_receipts scheduled,
 json_each(scheduled.card_baselines_json) b WHERE scheduled.league_id=candidate_cards.league_id
 AND scheduled.fad_id=candidate_cards.fad_id AND json_extract(b.value,'$.cardId')=candidate_cards.id)+1)
                AND NOT EXISTS(SELECT 1 FROM candidate_card_revisions earlier WHERE earlier.league_id=candidate_cards.league_id
                  AND earlier.card_id=candidate_cards.id AND earlier.resulting_card_version<=(SELECT json_extract(b.value,'$.resetVersion') FROM goon_draft_scheduling_receipts scheduled,
 json_each(scheduled.card_baselines_json) b WHERE scheduled.league_id=candidate_cards.league_id
 AND scheduled.fad_id=candidate_cards.fad_id AND json_extract(b.value,'$.cardId')=candidate_cards.id))))
        )
        OR NOT EXISTS (
          SELECT 1
          FROM candidate_card_revisions
          WHERE candidate_card_revisions.league_id =
              candidate_cards.league_id
            AND candidate_card_revisions.card_id =
              candidate_cards.id
            AND candidate_card_revisions.resulting_card_version =
              candidate_cards.version
            AND candidate_card_revisions.action = 'deadline_locked'
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires contiguous immutable card revisions'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_card_help_requests
    WHERE candidate_card_help_requests.league_id = NEW.league_id
      AND candidate_card_help_requests.fad_id = NEW.id
      AND candidate_card_help_requests.status = 'active'
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires every help grant to expire'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_cards
    LEFT JOIN candidate_card_snapshots
      ON candidate_card_snapshots.league_id =
          candidate_cards.league_id
     AND candidate_card_snapshots.card_id = candidate_cards.id
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.fad_id = NEW.id
      AND (
        candidate_card_snapshots.id IS NULL
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
        ) <> 22
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind =
              'conflict'
        ) <> candidate_card_snapshots.structural_conflict_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind =
              'conflict'
            AND candidate_card_snapshot_entries.occupant_kind =
              'carryover'
        ) <> candidate_card_snapshots
              .carried_roster_structural_conflict_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.source_entry_id
              IS NOT NULL
        ) <> (
          SELECT COUNT(*)
          FROM candidate_card_entries
          WHERE candidate_card_entries.league_id =
              candidate_cards.league_id
            AND candidate_card_entries.card_id =
              candidate_cards.id
        )
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group IN ('F', 'D')
            AND candidate_card_snapshot_entries.occupant_kind <>
              'empty'
        ) <> candidate_card_snapshots.filled_mandatory_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group IN ('F', 'D')
            AND candidate_card_snapshot_entries.occupant_kind = 'empty'
        ) <> candidate_card_snapshots.missing_mandatory_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group = 'B'
            AND candidate_card_snapshot_entries.occupant_kind <>
              'empty'
        ) <> candidate_card_snapshots.filled_bench_count
        OR (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              candidate_card_snapshots.league_id
            AND candidate_card_snapshot_entries.snapshot_id =
              candidate_card_snapshots.id
            AND candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.slot_group = 'B'
            AND candidate_card_snapshot_entries.occupant_kind = 'empty'
        ) <> candidate_card_snapshots.empty_bench_count
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires complete immutable card snapshots'
  ) END;
END;
