-- A scoped, audited handoff exception must be explicitly installed by an
-- authorized operator before Week 1. Deploying this schema grants no exception.
-- It never changes saved auction clocks, matchup dates, or another league.
CREATE VIEW free_agent_draft_approved_week_one_handoffs AS
SELECT approval.id AS approval_id, draft.league_id, draft.season_id,
       draft.id AS fad_id, week.id AS matchup_week_id,
       week.starts_at_ms, week.baseline_at_ms
FROM operational_events AS approval
JOIN free_agent_drafts AS draft
  ON draft.league_id = approval.league_id
 AND draft.season_id = approval.season_id
 AND draft.id = json_extract(approval.details_json, '$.fadId')
 AND draft.status = 'rapid'
 AND draft.current_competition_first_matchup_week_id = draft.first_matchup_week_id
 AND draft.schedule_recovery_id IS NULL
JOIN matchup_weeks AS week
  ON week.league_id = draft.league_id
 AND week.season_id = draft.season_id
 AND week.id = draft.current_competition_first_matchup_week_id
 AND week.sequence = 1 AND week.status = 'scheduled'
 AND week.starts_at_ms = draft.first_matchup_starts_at_ms
 AND week.baseline_at_ms > week.starts_at_ms
 AND week.baseline_at_ms <= week.starts_at_ms + 3600000
 AND week.locks_at_ms > week.baseline_at_ms
JOIN season_matchup_schedule_generations AS generation
  ON generation.league_id = draft.league_id
 AND generation.season_id = draft.season_id
 AND generation.week_one_matchup_week_id = week.id
 AND generation.week_one_starts_at_ms = week.starts_at_ms
 AND generation.status = 'current' AND generation.superseded_at_ms IS NULL
JOIN operational_events AS removal
  ON removal.id = json_extract(approval.details_json, '$.removalOperationId')
 AND removal.league_id = approval.league_id
 AND removal.season_id = approval.season_id
 AND removal.event_type = 'league.two_team_removal.v1'
 AND removal.outcome = 'succeeded'
 AND removal.actor_user_id = approval.actor_user_id
 AND removal.occurred_at_ms = approval.occurred_at_ms
WHERE approval.event_type = 'free_agent_draft.week_one_handoff_approved.v1'
  AND approval.feature = 'free_agent_draft'
  AND approval.outcome = 'succeeded'
  AND approval.reason_code = 'preserve_september_29_week_one'
  AND approval.actor_user_id IS NOT NULL
  AND approval.occurred_at_ms < week.starts_at_ms
  AND approval.details_json = json_object(
    'format', 'fad-week-one-handoff-v1',
    'fadId', draft.id,
    'matchupWeekId', week.id,
    'scheduleVersion', generation.schedule_version,
    'startsAtMs', week.starts_at_ms,
    'baselineAtMs', week.baseline_at_ms,
    'activeTeamCount', 12,
    'removalOperationId', removal.id
  )
  AND (SELECT MAX(rollover.rolls_over_at_ms)
       FROM free_agent_draft_rollovers AS rollover
       WHERE rollover.league_id = draft.league_id
         AND rollover.season_id = draft.season_id
         AND rollover.fad_id = draft.id
         AND rollover.window_kind = 'initial') = week.starts_at_ms
  AND (SELECT COUNT(*) FROM teams WHERE league_id = draft.league_id AND status = 'active') = 12
  AND (SELECT COUNT(*) FROM matchups WHERE league_id = draft.league_id AND matchup_week_id = week.id) = 6
  AND NOT EXISTS (
    SELECT 1 FROM matchups AS matchup
    WHERE matchup.league_id = draft.league_id AND matchup.season_id = draft.season_id
      AND (matchup.status <> 'scheduled'
        OR NOT EXISTS (SELECT 1 FROM teams WHERE id=matchup.home_team_id AND league_id=draft.league_id AND status='active')
        OR NOT EXISTS (SELECT 1 FROM teams WHERE id=matchup.away_team_id AND league_id=draft.league_id AND status='active'))
  )
  AND NOT EXISTS (SELECT 1 FROM matchup_roster_locks WHERE league_id=draft.league_id AND season_id=draft.season_id)
  AND NOT EXISTS (SELECT 1 FROM matchup_results WHERE league_id=draft.league_id AND season_id=draft.season_id)
  AND NOT EXISTS (
    SELECT 1 FROM job_runs
    WHERE league_id=draft.league_id AND season_id=draft.season_id AND job_type LIKE 'matchup:%'
      AND (status <> 'pending' OR attempt_count <> 0)
  )
  AND NOT EXISTS (
    SELECT 1 FROM operational_events AS revocation
    WHERE revocation.league_id=approval.league_id AND revocation.season_id=approval.season_id
      AND revocation.event_type='free_agent_draft.week_one_handoff_revoked.v1'
      AND json_extract(revocation.details_json, '$.approvalId')=approval.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM operational_events AS reversed
    WHERE reversed.league_id=removal.league_id AND reversed.season_id=removal.season_id
      AND reversed.event_type='league.two_team_removal.v1.rolled_back'
      AND json_extract(reversed.details_json, '$.originalOperationId')=removal.id
  );

DROP TRIGGER free_agent_drafts_forward_update;

CREATE TRIGGER free_agent_drafts_forward_update
BEFORE UPDATE ON free_agent_drafts
BEGIN
  SELECT CASE WHEN NOT (
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
  ) THEN RAISE(
    ABORT,
    'FAD may only advance through its atomic locked lifecycle'
  ) END;
END;

UPDATE application_metadata SET metadata_value='63', updated_at_ms=max(updated_at_ms,63) WHERE metadata_key='data_model_version' AND metadata_value='62';
