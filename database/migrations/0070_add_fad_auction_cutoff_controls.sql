-- hundo-leago: foreign-key-rebuild

-- Preserve all existing rows and identities. Saved cutoffs become authoritative
-- instants so older rounds can retain the gap they were accepted under.
CREATE TABLE fad_auction_cutoff_settings (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  gap_ms INTEGER NOT NULL CHECK(gap_ms BETWEEN 0 AND 604800000 AND gap_ms%60000=0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0),
  version INTEGER NOT NULL CHECK(version>=1),
  FOREIGN KEY(league_id,season_id,id) REFERENCES free_agent_drafts(league_id,season_id,id)
) STRICT;
CREATE INDEX fad_auction_cutoff_settings_scope ON fad_auction_cutoff_settings(league_id,season_id);
CREATE TABLE fad_auction_cutoff_changes (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  league_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
  previous_gap_ms INTEGER NOT NULL CHECK(previous_gap_ms BETWEEN 0 AND 604800000),
  gap_ms INTEGER NOT NULL CHECK(gap_ms BETWEEN 0 AND 604800000 AND gap_ms%60000=0),
  previous_settings_version INTEGER NOT NULL CHECK(previous_settings_version>=0),
  settings_version INTEGER NOT NULL CHECK(settings_version=previous_settings_version+1),
  before_rollovers_json TEXT NOT NULL CHECK(json_valid(before_rollovers_json)),
  after_rollovers_json TEXT NOT NULL CHECK(json_valid(after_rollovers_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(league_id,actor_user_id,client_key),
  FOREIGN KEY(league_id,fad_id) REFERENCES free_agent_drafts(league_id,id)
) STRICT;
CREATE INDEX fad_auction_cutoff_changes_scope ON fad_auction_cutoff_changes(league_id,fad_id,created_at_ms);
CREATE TRIGGER fad_auction_cutoff_changes_no_update BEFORE UPDATE ON fad_auction_cutoff_changes
BEGIN SELECT RAISE(ABORT,'FAD cutoff history is immutable'); END;
CREATE TRIGGER fad_auction_cutoff_changes_no_delete BEFORE DELETE ON fad_auction_cutoff_changes
BEGIN SELECT RAISE(ABORT,'FAD cutoff history is immutable'); END;

DROP TRIGGER free_agent_draft_nomination_queue_forward_update;

DROP TRIGGER free_agent_draft_nomination_queue_valid_insert;

DROP TRIGGER free_agent_draft_readiness_operations_forward_update;

DROP TRIGGER free_agent_draft_rollovers_immutable_delete;

DROP TRIGGER free_agent_drafts_auction_completion_barrier;

DROP TRIGGER idempotency_requests_fad_open_rapid_start_complete;

DROP TRIGGER auction_bids_require_context_insert;

DROP TRIGGER auction_contexts_restricted_fallback_full_window_insert;

DROP TRIGGER auction_contexts_valid_insert;

DROP TRIGGER auctions_restricted_fallback_overlap_insert;

DROP TRIGGER free_agent_draft_allocations_forward_update;

DROP TRIGGER free_agent_draft_recoveries_forward_update;

DROP TRIGGER free_agent_draft_recoveries_valid_insert;

DROP TRIGGER free_agent_draft_rollovers_valid_insert;

DROP TRIGGER free_agent_drafts_allocation_completion_barrier;

DROP TRIGGER free_agent_drafts_final_completion_barrier;

DROP VIEW free_agent_draft_approved_week_one_handoffs;

DROP TRIGGER free_agent_drafts_forward_update;

DROP TRIGGER free_agent_draft_rollovers_forward_update;

DROP TRIGGER free_agent_drafts_initial_timing_immutable;

DROP TRIGGER free_agent_drafts_deadline_allocation_barrier;

CREATE TABLE "cutoff_rollovers_rebuild" (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  window_kind TEXT NOT NULL
    CHECK (window_kind IN ('initial', 'extension')),
  predecessor_rollover_id TEXT,
  extension_reason TEXT
    CHECK (
      extension_reason IS NULL
      OR extension_reason IN (
        'queued_nomination',
        'restricted_auction',
        'fallback_auction',
        'recovery'
      )
    ),
  extension_source_id TEXT,
  opens_at_ms INTEGER NOT NULL CHECK (opens_at_ms >= 0),
  creation_cutoff_at_ms INTEGER NOT NULL
    CHECK (creation_cutoff_at_ms >= 0),
  rolls_over_at_ms INTEGER NOT NULL CHECK (rolls_over_at_ms >= 0),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'scheduled',
        'processing',
        'completed',
        'recovery_required'
      )
    ),
  processing_job_run_id TEXT,
  processing_started_at_ms INTEGER
    CHECK (
      processing_started_at_ms IS NULL
      OR processing_started_at_ms >= rolls_over_at_ms
    ),
  completed_at_ms INTEGER
    CHECK (
      completed_at_ms IS NULL
      OR (
        processing_started_at_ms IS NOT NULL
        AND completed_at_ms >= processing_started_at_ms
      )
    ),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        last_error_code = trim(last_error_code)
        AND length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, id),
  UNIQUE (league_id, season_id, fad_id, sequence),
  UNIQUE (league_id, season_id, fad_id, rolls_over_at_ms),
  UNIQUE (league_id, predecessor_rollover_id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, predecessor_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, processing_job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  CHECK (
    creation_cutoff_at_ms >= opens_at_ms AND creation_cutoff_at_ms <= rolls_over_at_ms
    AND opens_at_ms < rolls_over_at_ms
    AND (window_kind = 'initial' OR opens_at_ms = rolls_over_at_ms - 86400000)
  ),
  CHECK (
    (
      window_kind = 'initial'
      AND sequence >= 1
      AND extension_reason IS NULL
      AND extension_source_id IS NULL
    )
    OR (
      window_kind = 'extension'
      AND sequence >= 2
      AND predecessor_rollover_id IS NOT NULL
      AND extension_reason IS NOT NULL
      AND extension_source_id IS NOT NULL
    )
  ),
  CHECK (
    (sequence = 1 AND predecessor_rollover_id IS NULL)
    OR (sequence > 1 AND predecessor_rollover_id IS NOT NULL)
  ),
  CHECK (
    (
      status = 'scheduled'
      AND processing_job_run_id IS NULL
      AND processing_started_at_ms IS NULL
      AND completed_at_ms IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'processing'
      AND processing_job_run_id IS NOT NULL
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'completed'
      AND processing_job_run_id IS NOT NULL
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'recovery_required'
      AND processing_job_run_id IS NOT NULL
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
      AND last_error_code IS NOT NULL
    )
  )
) STRICT;
INSERT INTO cutoff_rollovers_rebuild (id,league_id,season_id,fad_id,sequence,window_kind,predecessor_rollover_id,extension_reason,extension_source_id,opens_at_ms,creation_cutoff_at_ms,rolls_over_at_ms,status,processing_job_run_id,processing_started_at_ms,completed_at_ms,last_error_code,created_at_ms,updated_at_ms,version) SELECT id,league_id,season_id,fad_id,sequence,window_kind,predecessor_rollover_id,extension_reason,extension_source_id,opens_at_ms,creation_cutoff_at_ms,rolls_over_at_ms,status,processing_job_run_id,processing_started_at_ms,completed_at_ms,last_error_code,created_at_ms,updated_at_ms,version FROM free_agent_draft_rollovers;
DROP TABLE free_agent_draft_rollovers;
ALTER TABLE cutoff_rollovers_rebuild RENAME TO free_agent_draft_rollovers;

CREATE INDEX free_agent_draft_rollovers_league_fad_status_time
  ON free_agent_draft_rollovers (
    league_id,
    fad_id,
    status,
    rolls_over_at_ms
  );

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

CREATE TRIGGER free_agent_draft_nomination_queue_forward_update
BEFORE UPDATE ON free_agent_draft_nomination_queue
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'queued'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.source_rollover_id IS OLD.source_rollover_id
    AND NEW.target_opening_rollover_id IS
      OLD.target_opening_rollover_id
    AND NEW.opening_total_value_cents IS
      OLD.opening_total_value_cents
    AND NEW.opening_term_years IS OLD.opening_term_years
    AND NEW.opening_aav_cents IS OLD.opening_aav_cents
    AND NEW.binding_illegality_confirmed IS
      OLD.binding_illegality_confirmed
    AND NEW.binding_confirmed_at_ms IS
      OLD.binding_confirmed_at_ms
    AND NEW.submitted_by_user_id IS OLD.submitted_by_user_id
    AND NEW.submitted_by_membership_id IS
      OLD.submitted_by_membership_id
    AND NEW.accepted_at_ms IS OLD.accepted_at_ms
    AND NEW.candidate_card_version_observed IS
      OLD.candidate_card_version_observed
    AND NEW.team_version_observed IS OLD.team_version_observed
    AND NEW.acceptance_idempotency_request_id IS
      OLD.acceptance_idempotency_request_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_rollovers AS opening_rollover
      JOIN job_runs AS activation_job
        ON activation_job.league_id = OLD.league_id
       AND activation_job.season_id = OLD.season_id
      WHERE opening_rollover.league_id = OLD.league_id
        AND opening_rollover.season_id = OLD.season_id
        AND opening_rollover.fad_id = OLD.fad_id
        AND opening_rollover.id =
          OLD.target_opening_rollover_id
        AND opening_rollover.rolls_over_at_ms <=
          NEW.updated_at_ms
        AND activation_job.job_type =
          'fad_queued_nomination_activation'
        AND activation_job.occurrence_key =
          'fad:' || OLD.fad_id || ':nomination-open:' ||
            OLD.id || ':' || opening_rollover.rolls_over_at_ms
        AND activation_job.scheduled_for_ms =
          opening_rollover.rolls_over_at_ms
        AND activation_job.status = 'running'
        AND activation_job.attempt_count >= 1
        AND activation_job.lease_owner IS NOT NULL
        AND activation_job.lease_token IS NOT NULL
        AND activation_job.started_at_ms >=
          opening_rollover.rolls_over_at_ms
        AND activation_job.started_at_ms <=
          NEW.updated_at_ms
        AND activation_job.updated_at_ms =
          activation_job.started_at_ms
        AND activation_job.lease_expires_at_ms >
          NEW.updated_at_ms
        AND activation_job.completed_at_ms IS NULL
        AND activation_job.result_json IS NULL
        AND activation_job.last_error_code IS NULL
        AND activation_job.next_attempt_at_ms IS NULL
        AND activation_job.created_at_ms =
          OLD.accepted_at_ms
    )
    AND (
      (
        NEW.status = 'invalid'
        AND NEW.resolution_rollover_id IS NULL
        AND NEW.opened_auction_id IS NULL
        AND NEW.opened_starter_bid_id IS NULL
        AND NEW.opened_at_ms IS NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.validation_code = 'PLAYER_UNAVAILABLE'
      )
      OR (
        NEW.status = 'opened'
        AND NEW.resolution_rollover_id IS NOT NULL
        AND NEW.opened_at_ms IS NOT NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.updated_at_ms >= NEW.opened_at_ms
        AND NEW.validation_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers AS opening_rollover
          JOIN free_agent_draft_rollovers AS resolution_rollover
            ON resolution_rollover.league_id =
                opening_rollover.league_id
           AND resolution_rollover.season_id =
                opening_rollover.season_id
           AND resolution_rollover.fad_id =
                opening_rollover.fad_id
          JOIN auctions AS auction
            ON auction.league_id = NEW.league_id
           AND auction.season_id = NEW.season_id
           AND auction.id = NEW.opened_auction_id
          JOIN auction_contexts AS context
            ON context.league_id = auction.league_id
           AND context.season_id = auction.season_id
           AND context.auction_id = auction.id
          JOIN auction_bids AS starter
            ON starter.league_id = auction.league_id
           AND starter.season_id = auction.season_id
           AND starter.id = NEW.opened_starter_bid_id
           AND starter.auction_id = auction.id
          JOIN auction_events AS started_event
            ON started_event.league_id = starter.league_id
           AND started_event.season_id = starter.season_id
           AND started_event.auction_id = starter.auction_id
           AND started_event.bid_id = starter.id
           AND started_event.team_id = starter.team_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.auction_id = context.auction_id
          JOIN idempotency_requests AS request
            ON request.league_id = NEW.league_id
           AND request.id =
                NEW.acceptance_idempotency_request_id
          JOIN job_runs AS resolution_job
            ON resolution_job.league_id = auction.league_id
           AND resolution_job.season_id = auction.season_id
           AND resolution_job.job_type =
                'auction.resolve.target'
           AND resolution_job.occurrence_key =
                'auction:' || auction.id || ':' ||
                  auction.resolves_at_ms
          WHERE opening_rollover.league_id = NEW.league_id
            AND opening_rollover.season_id = NEW.season_id
            AND opening_rollover.fad_id = NEW.fad_id
            AND opening_rollover.id =
              NEW.target_opening_rollover_id
            AND opening_rollover.rolls_over_at_ms =
              NEW.opened_at_ms
            AND resolution_rollover.id =
              NEW.resolution_rollover_id
            AND resolution_rollover.sequence =
              opening_rollover.sequence + 1
            AND resolution_rollover.predecessor_rollover_id =
              opening_rollover.id
            AND resolution_rollover.opens_at_ms =
              opening_rollover.rolls_over_at_ms
            AND resolution_rollover.creation_cutoff_at_ms BETWEEN resolution_rollover.opens_at_ms AND resolution_rollover.rolls_over_at_ms
            AND resolution_rollover.rolls_over_at_ms >
              opening_rollover.rolls_over_at_ms
            AND resolution_rollover.status = 'scheduled'
            AND auction.player_id = NEW.player_id
            AND auction.status = 'open'
            AND auction.opened_at_ms = NEW.opened_at_ms
            AND auction.resolves_at_ms =
              resolution_rollover.rolls_over_at_ms
            AND auction.opened_by_user_id =
              NEW.submitted_by_user_id
            AND auction.created_at_ms = NEW.opened_at_ms
            AND auction.updated_at_ms = NEW.opened_at_ms
            AND auction.version = 1
            AND context.id = auction.id
            AND context.source_kind = 'fad_open_rapid'
            AND context.fad_id = NEW.fad_id
            AND context.fad_rollover_id =
              NEW.resolution_rollover_id
            AND context.fad_allocation_id IS NULL
            AND context.fad_origin = 'queued_nomination'
            AND context.created_at_ms = NEW.opened_at_ms
            AND starter.team_id = NEW.team_id
            AND starter.submitted_by_user_id =
              NEW.submitted_by_user_id
            AND starter.total_value_cents =
              NEW.opening_total_value_cents
            AND starter.term_years =
              NEW.opening_term_years
            AND starter.lowest_offered_aav_cents =
              NEW.opening_aav_cents
            AND starter.first_submitted_at_ms =
              NEW.accepted_at_ms
            AND starter.last_edited_at_ms =
              NEW.accepted_at_ms
            AND starter.edit_count = 0
            AND starter.status = 'active'
            AND starter.idempotency_request_id =
              NEW.acceptance_idempotency_request_id
            AND starter.version = 1
            AND started_event.actor_user_id =
              NEW.submitted_by_user_id
            AND started_event.event_type = 'auction_started'
            AND started_event.occurred_at_ms = NEW.opened_at_ms
            AND json_valid(started_event.metadata_json) = 1
            AND json_type(started_event.metadata_json) = 'object'
            AND (
              SELECT COUNT(*)
              FROM json_each(started_event.metadata_json)
            ) = 12
            AND json_extract(
                  started_event.metadata_json,
                  '$.openingTeamId'
                ) = NEW.team_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.actorMembershipId'
                ) = NEW.submitted_by_membership_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.actorAuthority'
                ) = 'manager'
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
                  '$.playerPosition'
                ) IN ('F', 'D')
            AND json_extract(
                  started_event.metadata_json,
                  '$.creationCutoffAtMs'
                ) = opening_rollover.creation_cutoff_at_ms
            AND json_extract(
                  started_event.metadata_json,
                  '$.bidClosesAtMs'
                ) = auction.resolves_at_ms
            AND json_extract(
                  started_event.metadata_json,
                  '$.totalValueCents'
                ) = NEW.opening_total_value_cents
            AND json_extract(
                  started_event.metadata_json,
                  '$.termYears'
                ) = NEW.opening_term_years
            AND json_extract(
                  started_event.metadata_json,
                  '$.aavCents'
                ) = NEW.opening_aav_cents
            AND json_extract(
                  started_event.metadata_json,
                  '$.fadId'
                ) = NEW.fad_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.fadRolloverId'
                ) = NEW.resolution_rollover_id
            AND draw.allocation_id IS NULL
            AND draw.algorithm_version = 1
            AND length(draw.nonce_bytes) = 32
            AND length(draw.commitment_hex) = 64
            AND draw.commitment_hex =
              lower(draw.commitment_hex)
            AND draw.commitment_hex NOT GLOB
              '*[^0-9a-f]*'
            AND draw.ordered_tied_bid_ids_json IS NULL
            AND draw.ordered_tied_team_ids_json IS NULL
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND draw.revealed_at_ms IS NULL
            AND draw.created_at_ms = NEW.opened_at_ms
            AND draw.updated_at_ms = NEW.opened_at_ms
            AND draw.version = 1
            AND request.actor_user_id =
              NEW.submitted_by_user_id
            AND request.operation = 'auction.start'
            AND request.status = 'completed'
            AND request.result_type =
              'fad_nomination_queue'
            AND request.result_id = NEW.id
            AND request.created_at_ms =
              NEW.accepted_at_ms
            AND request.completed_at_ms =
              NEW.accepted_at_ms
            AND request.expires_at_ms >
              NEW.accepted_at_ms
            AND resolution_job.scheduled_for_ms =
              auction.resolves_at_ms
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
              NEW.updated_at_ms
            AND resolution_job.updated_at_ms =
              NEW.updated_at_ms
            AND resolution_job.version = 1
            AND (
              SELECT COUNT(*)
              FROM auction_bids AS exact_starter
              WHERE exact_starter.league_id = auction.league_id
                AND exact_starter.auction_id = auction.id
            ) = 1
            AND (
              SELECT COUNT(*)
              FROM auction_events AS exact_started_event
              WHERE exact_started_event.league_id =
                  auction.league_id
                AND exact_started_event.auction_id = auction.id
                AND exact_started_event.event_type =
                  'auction_started'
            ) = 1
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'queued nomination may only open or invalidate under its exact live activation'
  ) END;
END;

CREATE TRIGGER free_agent_draft_nomination_queue_valid_insert
BEFORE INSERT ON free_agent_draft_nomination_queue
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'queued'
    AND NEW.resolution_rollover_id IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.accepted_at_ms
    AND NEW.acceptance_idempotency_request_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id =
          NEW.acceptance_idempotency_request_id
        AND idempotency_requests.actor_user_id =
          NEW.submitted_by_user_id
        AND idempotency_requests.operation = 'auction.start'
        AND idempotency_requests.status = 'started'
        AND idempotency_requests.result_type IS NULL
        AND idempotency_requests.result_id IS NULL
        AND idempotency_requests.created_at_ms = NEW.accepted_at_ms
        AND idempotency_requests.completed_at_ms IS NULL
        AND idempotency_requests.expires_at_ms > NEW.accepted_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status IN ('allocating', 'rapid')
        AND free_agent_drafts.candidate_deadline_at_ms <= NEW.accepted_at_ms
        AND free_agent_drafts.deadline_locked_at_ms <= NEW.accepted_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_rollovers
      WHERE free_agent_draft_rollovers.league_id = NEW.league_id
        AND free_agent_draft_rollovers.season_id = NEW.season_id
        AND free_agent_draft_rollovers.fad_id = NEW.fad_id
        AND free_agent_draft_rollovers.id =
          NEW.source_rollover_id
        AND free_agent_draft_rollovers.id =
          NEW.target_opening_rollover_id
        AND free_agent_draft_rollovers.status IN (
          'scheduled',
          'processing'
        )
        AND NEW.accepted_at_ms >=
          free_agent_draft_rollovers.creation_cutoff_at_ms
        AND NEW.accepted_at_ms <
          free_agent_draft_rollovers.rolls_over_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM teams
      WHERE teams.league_id = NEW.league_id
        AND teams.id = NEW.team_id
        AND teams.status = 'active'
        AND teams.version = NEW.team_version_observed
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.season_id = NEW.season_id
        AND candidate_cards.fad_id = NEW.fad_id
        AND candidate_cards.team_id = NEW.team_id
        AND candidate_cards.version =
          NEW.candidate_card_version_observed
    )
    AND EXISTS (
      SELECT 1
      FROM team_manager_assignments
      JOIN league_memberships
        ON league_memberships.league_id =
            team_manager_assignments.league_id
       AND league_memberships.id =
            team_manager_assignments.membership_id
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.membership_id =
          NEW.submitted_by_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
        AND league_memberships.user_id =
          NEW.submitted_by_user_id
        AND league_memberships.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM player_ownerships
      WHERE player_ownerships.league_id = NEW.league_id
        AND player_ownerships.season_id = NEW.season_id
        AND player_ownerships.player_id = NEW.player_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.player_id = NEW.player_id
        AND auctions.status IN ('open', 'resolving')
    )
  ) THEN RAISE(
    ABORT,
    'final-hour nomination must privately bind the active opening boundary'
  ) END;
END;

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

CREATE TRIGGER free_agent_draft_rollovers_immutable_delete
BEFORE DELETE ON free_agent_draft_rollovers
BEGIN
  SELECT RAISE(ABORT, 'FAD rollover evidence is immutable');
END;

CREATE TRIGGER free_agent_drafts_auction_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN free_agent_draft_rollovers
      ON free_agent_draft_rollovers.league_id =
          auction_contexts.league_id
     AND free_agent_draft_rollovers.season_id =
          auction_contexts.season_id
     AND free_agent_draft_rollovers.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_rollovers.id =
          auction_contexts.fad_rollover_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND (
        free_agent_draft_rollovers.status <> 'completed'
        OR free_agent_draft_rollovers.completed_at_ms >
          NEW.completed_at_ms
        OR auctions.status NOT IN (
          'resolved',
          'no_winner',
          'cancelled'
        )
        OR (
          SELECT COUNT(*)
          FROM auction_resolutions
          WHERE auction_resolutions.league_id =
              auction_contexts.league_id
            AND auction_resolutions.season_id =
              auction_contexts.season_id
            AND auction_resolutions.auction_id =
              auction_contexts.auction_id
            AND auction_resolutions.resolved_at_ms <=
              NEW.completed_at_ms
            AND (
              (
                auctions.status = 'resolved'
                AND auction_resolutions.status = 'resolved'
                AND auction_resolutions.outcome_code = 'winner'
              )
              OR (
                auctions.status = 'no_winner'
                AND auction_resolutions.status IN (
                  'no_bids',
                  'no_winner'
                )
                AND auction_resolutions.outcome_code = 'no_winner'
              )
              OR (
                auctions.status = 'cancelled'
                AND auction_resolutions.status = 'cancelled'
                AND auction_resolutions.outcome_code IN (
                  'failed',
                  'recovered',
                  'player_unavailable',
                  'season_closed'
                )
              )
            )
        ) <> 1
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires every FAD auction to be terminal and accounted'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN auction_resolutions
      ON auction_resolutions.league_id =
          auction_contexts.league_id
     AND auction_resolutions.season_id =
          auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND NOT (
        (
          auction_contexts.source_kind = 'fad_restricted'
          AND auctions.status = 'cancelled'
          AND auction_resolutions.status = 'cancelled'
          AND auction_resolutions.outcome_code = 'failed'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_draws
            WHERE free_agent_draft_draws.league_id =
                auction_contexts.league_id
              AND free_agent_draft_draws.season_id =
                auction_contexts.season_id
              AND free_agent_draft_draws.fad_id =
                auction_contexts.fad_id
              AND free_agent_draft_draws.allocation_id =
                auction_contexts.fad_allocation_id
              AND free_agent_draft_draws.auction_id =
                auction_contexts.auction_id
              AND free_agent_draft_draws.revealed_at_ms IS NULL
              AND free_agent_draft_draws.version = 1
          )
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries
            WHERE free_agent_draft_recoveries.league_id =
                auction_contexts.league_id
              AND free_agent_draft_recoveries.season_id =
                auction_contexts.season_id
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
        OR EXISTS (
          SELECT 1
          FROM free_agent_draft_draws
          WHERE free_agent_draft_draws.league_id =
              auction_contexts.league_id
            AND free_agent_draft_draws.season_id =
              auction_contexts.season_id
            AND free_agent_draft_draws.fad_id =
              auction_contexts.fad_id
            AND free_agent_draft_draws.allocation_id IS
              auction_contexts.fad_allocation_id
            AND free_agent_draft_draws.auction_id =
              auction_contexts.auction_id
            AND free_agent_draft_draws.revealed_at_ms =
              auction_resolutions.resolved_at_ms
            AND free_agent_draft_draws.revealed_at_ms <=
              NEW.completed_at_ms
            AND free_agent_draft_draws.version = 2
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires an auditable draw or resolved blind correction'
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
        AND fad.status IN ('allocating', 'rapid')
        AND fad.candidate_deadline_at_ms <= auctions.opened_at_ms
        AND fad.deadline_locked_at_ms <= auctions.opened_at_ms
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
        AND starter.lowest_offered_aav_cents >= 100
        AND starter.lowest_offered_aav_cents % 25 = 0
        AND starter.total_value_cents =
          starter.lowest_offered_aav_cents * starter.term_years
        AND starter.lowest_offered_total_value_cents =
          starter.total_value_cents
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
                      AND fad.status IN ('allocating', 'rapid')
                      AND fad.candidate_deadline_at_ms <=
                        auctions.opened_at_ms
                      AND fad.deadline_locked_at_ms <=
                        auctions.opened_at_ms
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
                'processing',
                'recovery_required'
              )
              AND (
                opening_rollover.status <> 'recovery_required'
                OR EXISTS (
                  SELECT 1
                  FROM free_agent_draft_recoveries AS recovery
                  WHERE recovery.league_id = queue.league_id
                    AND recovery.season_id = queue.season_id
                    AND recovery.fad_id = queue.fad_id
                    AND recovery.nomination_queue_id = queue.id
                    AND recovery.player_id = queue.player_id
                    AND recovery.allocation_id IS NULL
                    AND recovery.rollover_id = opening_rollover.id
                    AND recovery.auction_id IS NULL
                    AND recovery.job_run_id = activation_job.id
                    AND recovery.kind =
                      'queued_nomination_activation'
                    AND recovery.status = 'running'
                    AND recovery.last_error_code IS NOT NULL
                    AND recovery.created_by_operation_id =
                      activation_job.id
                    AND recovery.resolved_at_ms IS NULL
                    AND recovery.updated_at_ms <=
                      activation_job.started_at_ms
                )
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
              AND resolution_rollover.rolls_over_at_ms >
                opening_rollover.rolls_over_at_ms
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
              AND activation_job.started_at_ms >=
                auctions.opened_at_ms
              AND activation_job.lease_expires_at_ms >
                activation_job.started_at_ms
              AND activation_job.completed_at_ms IS NULL
              AND activation_job.result_json IS NULL
              AND activation_job.last_error_code IS NULL
              AND activation_job.next_attempt_at_ms IS NULL
              AND activation_job.updated_at_ms =
                activation_job.started_at_ms
              AND activation_job.created_at_ms <=
                auctions.opened_at_ms
          )
          AND EXISTS (
            SELECT 1
            FROM free_agent_drafts
            WHERE free_agent_drafts.league_id = NEW.league_id
              AND free_agent_drafts.season_id = NEW.season_id
              AND free_agent_drafts.id = auction_contexts.fad_id
              AND free_agent_drafts.status IN (
                'allocating',
                'rapid'
              )
              AND free_agent_drafts.candidate_deadline_at_ms <=
                NEW.first_submitted_at_ms
              AND free_agent_drafts.deadline_locked_at_ms <=
                NEW.first_submitted_at_ms
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
            (NEW.lowest_offered_aav_cents) > free_agent_draft_auction_participants.minimum_aav_cents
            OR ((NEW.lowest_offered_aav_cents) = free_agent_draft_auction_participants.minimum_aav_cents AND NEW.term_years > free_agent_draft_auction_participants.minimum_term_years)
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
        (NEW.lowest_offered_aav_cents) > free_agent_draft_player_allocations.restricted_minimum_aav_cents
            OR ((NEW.lowest_offered_aav_cents) = free_agent_draft_player_allocations.restricted_minimum_aav_cents AND NEW.term_years >= free_agent_draft_player_allocations.restricted_minimum_term_years)
      )
  ) THEN RAISE(
    ABORT,
    'fallback bid cannot rank below its Candidate minimum'
  ) END;
END;

CREATE TRIGGER auction_contexts_restricted_fallback_full_window_insert
BEFORE INSERT ON auction_contexts
WHEN NEW.source_kind = 'fad_open_rapid'
  AND NEW.fad_origin = 'restricted_no_improvement_fallback'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auctions AS fallback_auction
    JOIN free_agent_draft_rollovers AS target_rollover
      ON target_rollover.league_id = fallback_auction.league_id
     AND target_rollover.season_id = fallback_auction.season_id
     AND target_rollover.fad_id = NEW.fad_id
     AND target_rollover.id = NEW.fad_rollover_id
    JOIN free_agent_draft_player_allocations AS allocation
      ON allocation.league_id = fallback_auction.league_id
     AND allocation.season_id = fallback_auction.season_id
     AND allocation.fad_id = NEW.fad_id
     AND allocation.id = NEW.fad_allocation_id
     AND allocation.player_id = fallback_auction.player_id
    JOIN auctions AS restricted_auction
      ON restricted_auction.league_id = allocation.league_id
     AND restricted_auction.season_id = allocation.season_id
     AND restricted_auction.id = allocation.restricted_auction_id
     AND restricted_auction.player_id = allocation.player_id
    WHERE fallback_auction.league_id = NEW.league_id
      AND fallback_auction.season_id = NEW.season_id
      AND fallback_auction.id = NEW.auction_id
      AND fallback_auction.status = 'open'
      AND fallback_auction.opened_by_user_id IS NULL
      AND fallback_auction.opened_at_ms = target_rollover.opens_at_ms
      AND fallback_auction.resolves_at_ms = target_rollover.rolls_over_at_ms
      AND fallback_auction.resolves_at_ms -
            fallback_auction.opened_at_ms > 0
      AND allocation.status = 'restricted_fallback_open'
      AND allocation.decision_code = 'restricted_no_improvement_fallback'
      AND allocation.fallback_open_auction_id = fallback_auction.id
      AND restricted_auction.status = 'resolving'
  ) THEN RAISE(
    ABORT,
    'restricted fallback context requires its exact complete handoff window'
  ) END;
END;

CREATE TRIGGER auction_contexts_valid_insert
BEFORE INSERT ON auction_contexts
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.created_at_ms <= NEW.created_at_ms
    )
    AND (
      NEW.source_kind = 'ordinary_weekly'
      OR (
        EXISTS (
          SELECT 1
          FROM auctions
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auctions.league_id
           AND free_agent_draft_rollovers.season_id =
                auctions.season_id
          WHERE auctions.league_id = NEW.league_id
            AND auctions.id = NEW.auction_id
            AND auctions.status = 'open'
            AND free_agent_draft_rollovers.fad_id = NEW.fad_id
            AND free_agent_draft_rollovers.id =
              NEW.fad_rollover_id
            AND auctions.resolves_at_ms =
              free_agent_draft_rollovers.rolls_over_at_ms
            AND auctions.opened_at_ms >=
              free_agent_draft_rollovers.opens_at_ms
            AND auctions.opened_at_ms <
              free_agent_draft_rollovers.rolls_over_at_ms
        )
        AND (
          (
            NEW.source_kind = 'fad_restricted'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.fad_allocation_id
                AND free_agent_draft_player_allocations.restricted_auction_id =
                  NEW.auction_id
                AND free_agent_draft_player_allocations.status IN (
                  'restricted_scheduled',
                  'restricted_active'
                )
            )
          )
          OR (
            NEW.fad_origin =
              'restricted_no_improvement_fallback'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.fad_allocation_id
                AND free_agent_draft_player_allocations.fallback_open_auction_id =
                  NEW.auction_id
                AND free_agent_draft_player_allocations.status =
                  'restricted_fallback_open'
            )
          )
          OR NEW.fad_origin IN (
            'manager_nomination',
            'queued_nomination'
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'auction context must bind the exact ordinary or FAD window'
  ) END;
END;

CREATE TRIGGER auctions_restricted_fallback_overlap_insert
BEFORE INSERT ON auctions
WHEN NEW.status IN ('open', 'resolving')
  AND EXISTS (
    SELECT 1
    FROM auctions AS active_auction
    WHERE active_auction.league_id = NEW.league_id
      AND active_auction.player_id = NEW.player_id
      AND active_auction.status IN ('open', 'resolving')
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'open'
    AND NEW.opened_by_user_id IS NULL
    AND NEW.created_at_ms = NEW.updated_at_ms
    AND NEW.version = 1
    AND NEW.opened_at_ms >= NEW.created_at_ms
    AND NEW.resolves_at_ms > NEW.opened_at_ms
    AND (
      SELECT COUNT(*)
      FROM auctions AS active_auction
      WHERE active_auction.league_id = NEW.league_id
        AND active_auction.player_id = NEW.player_id
        AND active_auction.status IN ('open', 'resolving')
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM auctions AS restricted_auction
      JOIN auction_contexts AS restricted_context
        ON restricted_context.league_id = restricted_auction.league_id
       AND restricted_context.season_id = restricted_auction.season_id
       AND restricted_context.auction_id = restricted_auction.id
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = restricted_context.league_id
       AND allocation.season_id = restricted_context.season_id
       AND allocation.fad_id = restricted_context.fad_id
       AND allocation.id = restricted_context.fad_allocation_id
       AND allocation.player_id = restricted_auction.player_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = allocation.fad_id
      JOIN free_agent_draft_rollovers AS source_rollover
        ON source_rollover.league_id = restricted_context.league_id
       AND source_rollover.season_id = restricted_context.season_id
       AND source_rollover.fad_id = restricted_context.fad_id
       AND source_rollover.id = restricted_context.fad_rollover_id
      JOIN free_agent_draft_draws AS restricted_draw
        ON restricted_draw.league_id = restricted_context.league_id
       AND restricted_draw.season_id = restricted_context.season_id
       AND restricted_draw.fad_id = restricted_context.fad_id
       AND restricted_draw.allocation_id = restricted_context.fad_allocation_id
       AND restricted_draw.auction_id = restricted_context.auction_id
      JOIN job_runs AS resolution_job
        ON resolution_job.league_id = restricted_auction.league_id
       AND resolution_job.season_id = restricted_auction.season_id
       AND resolution_job.job_type = 'auction.resolve.target'
       AND resolution_job.occurrence_key =
            'auction:' || restricted_auction.id || ':' ||
              restricted_auction.resolves_at_ms
       AND resolution_job.scheduled_for_ms = restricted_auction.resolves_at_ms
      WHERE restricted_auction.league_id = NEW.league_id
        AND restricted_auction.season_id = NEW.season_id
        AND restricted_auction.player_id = NEW.player_id
        AND restricted_auction.status = 'resolving'
        AND restricted_auction.resolves_at_ms <= NEW.created_at_ms
        AND restricted_context.source_kind = 'fad_restricted'
        AND restricted_context.fad_origin = 'candidate_tie_restricted'
        AND allocation.status = 'restricted_active'
        AND allocation.decision_code = 'exact_total_and_term_tie'
        AND allocation.winning_snapshot_entry_id IS NULL
        AND allocation.winning_team_id IS NULL
        AND allocation.contract_id IS NULL
        AND allocation.ownership_id IS NULL
        AND allocation.restricted_auction_id = restricted_auction.id
        AND allocation.fallback_open_auction_id IS NULL
        AND allocation.restricted_minimum_total_cents IS NOT NULL
        AND allocation.restricted_minimum_term_years IS NOT NULL
        AND allocation.restricted_minimum_aav_cents IS NOT NULL
        AND allocation.accounted_at_ms IS NULL
        AND allocation.last_error_code IS NULL
        AND source_rollover.rolls_over_at_ms =
            restricted_auction.resolves_at_ms
        AND restricted_auction.opened_at_ms >= source_rollover.opens_at_ms
        AND restricted_auction.opened_at_ms < source_rollover.rolls_over_at_ms
        AND restricted_draw.revealed_at_ms IS NULL
        AND restricted_draw.version = 1
        AND NOT EXISTS (
          SELECT 1
          FROM auction_resolutions
          WHERE auction_resolutions.league_id = restricted_auction.league_id
            AND auction_resolutions.auction_id = restricted_auction.id
        )
        AND resolution_job.status IN ('leased', 'running')
        AND resolution_job.attempt_count >= 1
        AND resolution_job.lease_owner IS NOT NULL
        AND resolution_job.lease_token IS NOT NULL
        AND resolution_job.lease_expires_at_ms > NEW.created_at_ms
        AND resolution_job.completed_at_ms IS NULL
        AND resolution_job.result_json IS NULL
        AND resolution_job.last_error_code IS NULL
        AND resolution_job.next_attempt_at_ms IS NULL
        AND resolution_job.updated_at_ms <= NEW.created_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = restricted_auction.league_id
            AND auction_bids.auction_id = restricted_auction.id
            AND auction_bids.status = 'active'
        )
        AND NEW.opened_at_ms >= NEW.created_at_ms
        AND NEW.opened_at_ms >= restricted_auction.resolves_at_ms
        AND NEW.opened_at_ms >= fad.candidate_deadline_at_ms
        AND (EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS target
          WHERE target.league_id = fad.league_id AND target.season_id = fad.season_id AND target.fad_id = fad.id
            AND target.opens_at_ms = NEW.opened_at_ms AND target.rolls_over_at_ms = NEW.resolves_at_ms
            AND target.status IN ('scheduled', 'processing'))
          OR (
            NEW.resolves_at_ms = NEW.opened_at_ms + 86400000
            AND NOT EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS existing_target
              WHERE existing_target.league_id = fad.league_id AND existing_target.season_id = fad.season_id
                AND existing_target.fad_id = fad.id AND existing_target.opens_at_ms = NEW.opened_at_ms)
            AND EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS predecessor
              WHERE predecessor.league_id = fad.league_id AND predecessor.season_id = fad.season_id
                AND predecessor.fad_id = fad.id AND predecessor.rolls_over_at_ms = NEW.opened_at_ms
                AND predecessor.sequence >= COALESCE(json_array_length(fad.initial_rollover_times_json), 7)
                AND predecessor.status IN ('processing', 'completed', 'recovery_required')
                AND NOT EXISTS (SELECT 1 FROM free_agent_draft_rollovers AS later
                  WHERE later.league_id = fad.league_id AND later.season_id = fad.season_id
                    AND later.fad_id = fad.id AND later.sequence > predecessor.sequence))
          ))
    )
  ) THEN RAISE(
    ABORT,
    'active auction overlap requires one exact restricted fallback handoff'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_forward_update
BEFORE UPDATE ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'pending'
        AND NEW.status = 'automatic_award'
        AND NEW.decision_code IN (
          'sole_valid_offer',
          'highest_total',
          'highest_equal_total_aav',
          'highest_aav',
          'highest_equal_aav_term'
        )
        AND NEW.winning_snapshot_entry_id IS NOT NULL
        AND NEW.winning_team_id IS NOT NULL
        AND NEW.contract_id IS NOT NULL
        AND NEW.ownership_id IS NOT NULL
        AND NEW.restricted_auction_id IS NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NULL
        AND NEW.restricted_minimum_term_years IS NULL
        AND NEW.restricted_minimum_aav_cents IS NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'pending'
        AND NEW.status IN (
          'restricted_scheduled',
          'restricted_active'
        )
        AND NEW.decision_code = 'exact_total_and_term_tie'
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.restricted_auction_id IS NOT NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NOT NULL
        AND NEW.restricted_minimum_term_years IS NOT NULL
        AND NEW.restricted_minimum_aav_cents IS NOT NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND (
          (
            NEW.status = 'restricted_active'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN free_agent_draft_rollovers AS current_rollover
                ON current_rollover.league_id = auctions.league_id
               AND current_rollover.season_id = auctions.season_id
               AND current_rollover.fad_id = NEW.fad_id
               AND current_rollover.rolls_over_at_ms =
                    auctions.resolves_at_ms
              WHERE auctions.league_id = NEW.league_id
                AND auctions.season_id = NEW.season_id
                AND auctions.id = NEW.restricted_auction_id
                AND auctions.player_id = NEW.player_id
                AND auctions.status = 'open'
                AND auctions.opened_at_ms = NEW.updated_at_ms
                AND current_rollover.status IN (
                  'scheduled',
                  'processing'
                )
                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.creation_cutoff_at_ms
            )
          )
          OR (
            NEW.status = 'restricted_scheduled'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN free_agent_draft_rollovers AS target_rollover
                ON target_rollover.league_id = auctions.league_id
               AND target_rollover.season_id = auctions.season_id
               AND target_rollover.fad_id = NEW.fad_id
               AND target_rollover.rolls_over_at_ms =
                    auctions.resolves_at_ms
              JOIN free_agent_draft_rollovers AS current_rollover
                ON current_rollover.league_id =
                    target_rollover.league_id
               AND current_rollover.season_id =
                    target_rollover.season_id
               AND current_rollover.fad_id = target_rollover.fad_id
               AND current_rollover.id =
                    target_rollover.predecessor_rollover_id
               AND current_rollover.sequence =
                    target_rollover.sequence - 1
              WHERE auctions.league_id = NEW.league_id
                AND auctions.season_id = NEW.season_id
                AND auctions.id = NEW.restricted_auction_id
                AND auctions.player_id = NEW.player_id
                AND auctions.status = 'open'
                AND auctions.opened_at_ms = target_rollover.opens_at_ms
                AND target_rollover.status = 'scheduled'
                AND target_rollover.opens_at_ms =
                  current_rollover.rolls_over_at_ms
                AND current_rollover.status IN (
                  'scheduled',
                  'processing'
                )
                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.rolls_over_at_ms
            )
          )
        )
      )
      OR (
        OLD.status = 'pending'
        AND NEW.status IN ('no_valid_offer', 'invalid')
        AND NEW.decision_code IN (
          'no_valid_offer',
          'invalid_snapshot',
          'candidate_card_structural_conflict',
          'candidate_card_over_cap'
        )
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.restricted_auction_id IS NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NULL
        AND NEW.restricted_minimum_term_years IS NULL
        AND NEW.restricted_minimum_aav_cents IS NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
      )
      OR (
        OLD.status = 'restricted_scheduled'
        AND NEW.status = 'restricted_active'
        AND NEW.decision_code IS OLD.decision_code
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.season_id = auctions.season_id
           AND auction_contexts.auction_id = auctions.id
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auction_contexts.league_id
           AND free_agent_draft_rollovers.season_id =
                auction_contexts.season_id
           AND free_agent_draft_rollovers.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_rollovers.id =
                auction_contexts.fad_rollover_id
          JOIN job_runs
            ON job_runs.league_id = auctions.league_id
           AND job_runs.season_id = auctions.season_id
           AND job_runs.job_type = 'fad_restricted_activation'
           AND job_runs.occurrence_key =
                'fad:' || OLD.fad_id || ':restricted-activate:' ||
                  OLD.id || ':' || auctions.opened_at_ms
           AND job_runs.scheduled_for_ms = auctions.opened_at_ms
          WHERE auctions.league_id = OLD.league_id
            AND auctions.season_id = OLD.season_id
            AND auctions.id = OLD.restricted_auction_id
            AND auctions.player_id = OLD.player_id
            AND auctions.status = 'open'
            AND auctions.opened_at_ms <= NEW.updated_at_ms
            AND NEW.updated_at_ms < auctions.resolves_at_ms
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = OLD.fad_id
            AND auction_contexts.fad_allocation_id = OLD.id
            AND auction_contexts.fad_origin =
              'candidate_tie_restricted'
            AND free_agent_draft_rollovers.opens_at_ms =
                auctions.opened_at_ms
            AND free_agent_draft_rollovers.rolls_over_at_ms =
                auctions.resolves_at_ms
            AND free_agent_draft_rollovers.status IN (
              'scheduled',
              'processing'
            )
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms > NEW.updated_at_ms
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms IS NULL
        )
      )
      OR (
        OLD.status = 'restricted_active'
        AND NEW.status = 'restricted_fallback_open'
        AND NEW.decision_code =
          'restricted_no_improvement_fallback'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS NOT NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'restricted_active'
        AND NEW.status = 'restricted_resolved'
        AND NEW.decision_code = 'restricted_auction_result'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.winning_snapshot_entry_id IS NOT NULL
        AND NEW.winning_team_id IS NOT NULL
        AND NEW.contract_id IS NOT NULL
        AND NEW.ownership_id IS NOT NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'restricted_fallback_open'
        AND NEW.status = 'fallback_open_resolved'
        AND NEW.decision_code IN (
          'fallback_open_result',
          'fallback_open_no_winner'
        )
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
        AND (
          (
            NEW.decision_code = 'fallback_open_result'
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
          )
          OR (
            NEW.decision_code = 'fallback_open_no_winner'
            AND NEW.winning_snapshot_entry_id IS NULL
            AND NEW.winning_team_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
          )
        )
      )
      OR (
        OLD.status IN (
          'pending',
          'restricted_scheduled',
          'restricted_active',
          'restricted_fallback_open'
        )
        AND NEW.status = 'correction_required'
        AND NEW.decision_code IS OLD.decision_code
        AND NEW.winning_snapshot_entry_id IS
          OLD.winning_snapshot_entry_id
        AND NEW.winning_team_id IS OLD.winning_team_id
        AND NEW.contract_id IS OLD.contract_id
        AND NEW.ownership_id IS OLD.ownership_id
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms IS OLD.accounted_at_ms
        AND NEW.last_error_code IS NOT NULL
      )
      OR (
        OLD.status = 'correction_required'
        AND NEW.status = CASE
          WHEN OLD.decision_code =
              'exact_total_and_term_tie'
            AND OLD.restricted_auction_id IS NOT NULL
            AND OLD.fallback_open_auction_id IS NULL
            THEN 'restricted_active'
          WHEN OLD.decision_code =
              'restricted_no_improvement_fallback'
            AND OLD.restricted_auction_id IS NOT NULL
            AND OLD.fallback_open_auction_id IS NOT NULL
            THEN 'restricted_fallback_open'
          ELSE NULL
        END
        AND NEW.decision_code IS OLD.decision_code
        AND OLD.winning_snapshot_entry_id IS NULL
        AND OLD.winning_team_id IS NULL
        AND OLD.contract_id IS NULL
        AND OLD.ownership_id IS NULL
        AND NEW.winning_snapshot_entry_id IS
          OLD.winning_snapshot_entry_id
        AND NEW.winning_team_id IS OLD.winning_team_id
        AND NEW.contract_id IS OLD.contract_id
        AND NEW.ownership_id IS OLD.ownership_id
        AND NEW.restricted_auction_id IS
          OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND OLD.restricted_minimum_total_cents IS NOT NULL
        AND OLD.restricted_minimum_term_years IS NOT NULL
        AND OLD.restricted_minimum_aav_cents IS NOT NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND OLD.accounted_at_ms IS NULL
        AND NEW.accounted_at_ms IS OLD.accounted_at_ms
        AND OLD.last_error_code IS NOT NULL
        AND NEW.last_error_code IS NULL
        AND NEW.updated_at_ms > OLD.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM auction_contexts AS context
          JOIN auctions AS auction
            ON auction.league_id = context.league_id
           AND auction.season_id = context.season_id
           AND auction.id = context.auction_id
           AND auction.player_id = OLD.player_id
          JOIN free_agent_draft_rollovers AS rollover
            ON rollover.league_id = context.league_id
           AND rollover.season_id = context.season_id
           AND rollover.fad_id = context.fad_id
           AND rollover.id = context.fad_rollover_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.allocation_id = context.fad_allocation_id
           AND draw.auction_id = context.auction_id
          JOIN free_agent_draft_recoveries AS recovery
            ON recovery.league_id = context.league_id
           AND recovery.season_id = context.season_id
           AND recovery.fad_id = context.fad_id
           AND recovery.player_id = auction.player_id
           AND recovery.allocation_id = context.fad_allocation_id
           AND recovery.rollover_id = context.fad_rollover_id
           AND recovery.auction_id = context.auction_id
          JOIN job_runs AS job
            ON job.league_id = recovery.league_id
           AND job.season_id = recovery.season_id
           AND job.id = recovery.job_run_id
          JOIN auction_events AS failure_event
            ON failure_event.league_id = recovery.league_id
           AND failure_event.season_id = recovery.season_id
           AND failure_event.auction_id = recovery.auction_id
           AND failure_event.event_type =
                'fad_auction_resolution_failed'
          JOIN free_agent_draft_recovery_action_command_results
            AS receipt
            ON receipt.league_id = recovery.league_id
           AND receipt.season_id = recovery.season_id
           AND receipt.fad_id = recovery.fad_id
           AND receipt.recovery_id = recovery.id
           AND receipt.job_run_id = recovery.job_run_id
          JOIN idempotency_requests AS request
            ON request.league_id = receipt.league_id
           AND request.id = receipt.idempotency_request_id
          WHERE context.league_id = OLD.league_id
            AND context.season_id = OLD.season_id
            AND context.fad_id = OLD.fad_id
            AND context.fad_allocation_id = OLD.id
            AND context.auction_id = CASE
              WHEN NEW.status = 'restricted_active'
                THEN OLD.restricted_auction_id
              ELSE OLD.fallback_open_auction_id
            END
            AND (
              (
                NEW.status = 'restricted_active'
                AND context.source_kind = 'fad_restricted'
                AND context.fad_origin =
                  'candidate_tie_restricted'
              )
              OR (
                NEW.status = 'restricted_fallback_open'
                AND context.source_kind = 'fad_open_rapid'
                AND context.fad_origin =
                  'restricted_no_improvement_fallback'
              )
            )
            AND auction.status = 'resolving'
            AND auction.updated_at_ms = NEW.updated_at_ms
            AND auction.resolves_at_ms <= NEW.updated_at_ms
            AND rollover.rolls_over_at_ms =
                auction.resolves_at_ms
            AND draw.algorithm_version = 1
            AND draw.nonce_bytes IS NOT NULL
            AND length(draw.nonce_bytes) = 32
            AND draw.commitment_hex IS NOT NULL
            AND draw.ordered_tied_bid_ids_json IS NULL
            AND draw.ordered_tied_team_ids_json IS NULL
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND draw.revealed_at_ms IS NULL
            AND draw.version = 1
            AND NOT EXISTS (
              SELECT 1
              FROM auction_resolutions AS resolution
              WHERE resolution.league_id = auction.league_id
                AND resolution.auction_id = auction.id
            )
            AND recovery.kind = 'auction_resolution'
            AND recovery.status = 'running'
            AND recovery.target_resolution_at_ms =
                auction.resolves_at_ms
            AND recovery.last_error_code =
                OLD.last_error_code
            AND recovery.commissioner_reason IS NOT NULL
            AND recovery.created_by_operation_id = job.id
            AND recovery.resolved_by_user_id IS NULL
            AND recovery.resolved_by_membership_id IS NULL
            AND recovery.resolved_authority IS NULL
            AND recovery.resolved_at_ms IS NULL
            AND recovery.created_at_ms <=
                failure_event.occurred_at_ms
            AND recovery.updated_at_ms =
                receipt.accepted_at_ms
            AND recovery.updated_at_ms <=
                NEW.updated_at_ms
            AND recovery.version >= 2
            AND failure_event.actor_user_id IS NULL
            AND failure_event.bid_id IS NULL
            AND failure_event.team_id IS NULL
            AND json_valid(failure_event.metadata_json) = 1
            AND json_extract(
                  failure_event.metadata_json,
                  '$.recoveryId'
                ) = recovery.id
            AND json_extract(
                  failure_event.metadata_json,
                  '$.jobRunId'
                ) = job.id
            AND json_extract(
                  failure_event.metadata_json,
                  '$.errorCode'
                ) = OLD.last_error_code
            AND failure_event.occurred_at_ms =
                OLD.updated_at_ms
            AND (
              SELECT COUNT(*)
              FROM auction_events AS exact_failure
              WHERE exact_failure.league_id =
                  failure_event.league_id
                AND exact_failure.season_id =
                  failure_event.season_id
                AND exact_failure.auction_id =
                  failure_event.auction_id
                AND exact_failure.event_type =
                  'fad_auction_resolution_failed'
                AND exact_failure.occurred_at_ms =
                  failure_event.occurred_at_ms
            ) = 1
            AND NOT EXISTS (
              SELECT 1
              FROM auction_events AS later_failure
              WHERE later_failure.league_id =
                  failure_event.league_id
                AND later_failure.season_id =
                  failure_event.season_id
                AND later_failure.auction_id =
                  failure_event.auction_id
                AND later_failure.event_type =
                  'fad_auction_resolution_failed'
                AND json_extract(
                      later_failure.metadata_json,
                      '$.recoveryId'
                    ) = recovery.id
                AND json_extract(
                      later_failure.metadata_json,
                      '$.jobRunId'
                    ) = job.id
                AND later_failure.occurred_at_ms >
                  failure_event.occurred_at_ms
            )
            AND job.job_type = 'auction.resolve.target'
            AND job.occurrence_key =
              'auction:' || auction.id || ':' ||
                auction.resolves_at_ms
            AND job.scheduled_for_ms =
                auction.resolves_at_ms
            AND job.status = 'running'
            AND job.attempt_count >= 2
            AND job.lease_owner IS NOT NULL
            AND job.lease_token IS NOT NULL
            AND job.lease_expires_at_ms >
                NEW.updated_at_ms
            AND job.started_at_ms =
                NEW.updated_at_ms
            AND job.updated_at_ms =
                NEW.updated_at_ms
            AND job.completed_at_ms IS NULL
            AND job.result_json IS NULL
            AND job.last_error_code IS NULL
            AND job.next_attempt_at_ms IS NULL
            AND receipt.action =
                'retry_auction_resolution'
            AND receipt.resource_kind = 'auction'
            AND receipt.resource_id = auction.id
            AND receipt.operation_id = job.id
            AND receipt.job_run_id = job.id
            AND receipt.occurrence_key =
                job.occurrence_key
            AND receipt.commissioner_reason =
                recovery.commissioner_reason
            AND receipt.accepted_status = 'pending'
            AND receipt.accepted_at_ms >=
                failure_event.occurred_at_ms
            AND receipt.accepted_at_ms <=
                NEW.updated_at_ms
            AND request.actor_user_id =
                receipt.actor_user_id
            AND request.operation =
                'free_agent_draft.recovery.action'
            AND request.request_hash =
                receipt.request_sha256
            AND request.status = 'completed'
            AND request.result_type =
                'free_agent_draft_recovery_action_command_result'
            AND request.result_id = receipt.id
            AND request.created_at_ms =
                receipt.accepted_at_ms
            AND request.completed_at_ms =
                receipt.accepted_at_ms
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recovery_action_command_results
                AS later_receipt
              WHERE later_receipt.league_id =
                  receipt.league_id
                AND later_receipt.recovery_id =
                  receipt.recovery_id
                AND later_receipt.action =
                  'retry_auction_resolution'
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
        OLD.status IN (
          'correction_required',
          'restricted_scheduled',
          'restricted_active',
          'restricted_fallback_open',
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
        AND NEW.status IN (
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
        AND NEW.decision_code = 'corrected'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
        AND (
          OLD.status NOT IN (
            'restricted_scheduled',
            'restricted_active',
            'restricted_fallback_open'
          )
          OR NEW.status IN (
            'automatic_award',
            'no_valid_offer'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM commissioner_corrections AS correction
          WHERE correction.league_id = NEW.league_id
            AND correction.season_id = NEW.season_id
            AND correction.feature =
                'free_agent_draft_allocation'
            AND correction.feature_record_id = NEW.id
            AND correction.corrected_at_ms = NEW.updated_at_ms
            AND json_valid(correction.before_snapshot_json) = 1
            AND json_valid(correction.after_snapshot_json) = 1
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.status'
                ) = OLD.status
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.version'
                ) = OLD.version
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.status'
                ) = NEW.status
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.version'
                ) = NEW.version
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.decisionCode'
                ) = 'corrected'
            AND (
              EXISTS (
                SELECT 1
                FROM leagues AS league
                JOIN league_memberships AS membership
                  ON membership.league_id = league.id
                 AND membership.id =
                      league.commissioner_membership_id
                 AND membership.user_id =
                      correction.actor_user_id
                WHERE league.id = correction.league_id
                  AND membership.permission_category = 'commissioner'
                  AND membership.status = 'active'
              )
              OR EXISTS (
                SELECT 1
                FROM league_memberships AS membership
                JOIN platform_roles AS role
                  ON role.user_id = membership.user_id
                 AND role.role = 'platform_administrator'
                 AND role.status = 'active'
                WHERE membership.league_id = correction.league_id
                  AND membership.user_id = correction.actor_user_id
                  AND membership.status = 'active'
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auctions AS linked_auction
          WHERE linked_auction.league_id = OLD.league_id
            AND linked_auction.id IN (
              OLD.restricted_auction_id,
              OLD.fallback_open_auction_id
            )
            AND linked_auction.status IN (
              'open',
              'resolving',
              'failed'
            )
        )
        AND (
          OLD.status NOT IN (
            'restricted_scheduled',
            'restricted_active',
            'restricted_fallback_open'
          )
          OR EXISTS (
            SELECT 1
            FROM commissioner_corrections AS correction
            JOIN auctions AS auction
              ON auction.league_id = NEW.league_id
             AND auction.id = CASE
                  WHEN OLD.status =
                    'restricted_fallback_open'
                    THEN OLD.fallback_open_auction_id
                  ELSE OLD.restricted_auction_id
                END
            JOIN auction_contexts AS context
              ON context.league_id = auction.league_id
             AND context.season_id = auction.season_id
             AND context.auction_id = auction.id
             AND context.fad_id = NEW.fad_id
             AND context.fad_allocation_id = NEW.id
            JOIN auction_resolutions AS resolution
              ON resolution.league_id = auction.league_id
             AND resolution.season_id = auction.season_id
             AND resolution.auction_id = auction.id
            JOIN free_agent_draft_draws AS draw
              ON draw.league_id = context.league_id
             AND draw.season_id = context.season_id
             AND draw.fad_id = context.fad_id
             AND draw.allocation_id = context.fad_allocation_id
             AND draw.auction_id = context.auction_id
            JOIN auction_events AS event
              ON event.league_id = auction.league_id
             AND event.season_id = auction.season_id
             AND event.auction_id = auction.id
            WHERE correction.league_id = NEW.league_id
              AND correction.season_id = NEW.season_id
              AND correction.feature =
                  'free_agent_draft_allocation'
              AND correction.feature_record_id = NEW.id
              AND correction.corrected_at_ms = NEW.updated_at_ms
              AND auction.player_id = NEW.player_id
              AND auction.status = 'cancelled'
              AND auction.updated_at_ms = NEW.updated_at_ms
              AND auction.created_at_ms <= NEW.updated_at_ms
              AND draw.created_at_ms <= NEW.updated_at_ms
              AND context.source_kind = CASE
                WHEN OLD.status = 'restricted_fallback_open'
                  THEN 'fad_open_rapid'
                ELSE 'fad_restricted'
              END
              AND (
                OLD.status <> 'restricted_fallback_open'
                OR context.fad_origin =
                  'restricted_no_improvement_fallback'
              )
              AND resolution.status = 'cancelled'
              AND resolution.outcome_code = 'recovered'
              AND resolution.trigger_type = 'commissioner'
              AND resolution.triggered_by_user_id =
                  correction.actor_user_id
              AND resolution.resolved_at_ms = NEW.updated_at_ms
              AND draw.version = 2
              AND draw.revealed_at_ms = NEW.updated_at_ms
              AND draw.ordered_tied_bid_ids_json = '[]'
              AND draw.ordered_tied_team_ids_json = '[]'
              AND draw.rejection_counter IS NULL
              AND draw.selected_index IS NULL
              AND draw.selected_bid_id IS NULL
              AND draw.selected_team_id IS NULL
              AND draw.selected_digest_hex IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM auction_bids AS bid
                WHERE bid.league_id = auction.league_id
                  AND bid.auction_id = auction.id
              )
              AND event.event_type = 'auction_cancelled'
              AND event.actor_user_id = correction.actor_user_id
              AND event.occurred_at_ms = NEW.updated_at_ms
              AND json_extract(
                    event.metadata_json,
                    '$.actorAuthority'
                  ) IN (
                    'commissioner',
                    'platform_administrator_as_commissioner'
                  )
              AND json_extract(
                    event.metadata_json,
                    '$.correctionId'
                  ) = correction.id
          )
        )
        AND (
          NEW.winning_snapshot_entry_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM candidate_card_snapshot_entries AS snapshot_entry
            WHERE snapshot_entry.league_id = NEW.league_id
              AND snapshot_entry.season_id = NEW.season_id
              AND snapshot_entry.fad_id = NEW.fad_id
              AND snapshot_entry.id = NEW.winning_snapshot_entry_id
              AND snapshot_entry.player_id = NEW.player_id
              AND snapshot_entry.team_id = NEW.winning_team_id
              AND snapshot_entry.proposed_total_value_cents IS NOT NULL
              AND snapshot_entry.proposed_term_years IS NOT NULL
              AND snapshot_entry.proposed_aav_cents IS NOT NULL
          )
        )
        AND (
          (
            NEW.status = 'automatic_award'
            AND NEW.winning_snapshot_entry_id IS NOT NULL
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
          )
          OR (
            NEW.status <> 'automatic_award'
            AND NEW.winning_team_id IS NULL
            AND NEW.winning_snapshot_entry_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
          )
        )
      )
    )
    AND (
      NEW.winning_team_id IS NULL
      OR (
        EXISTS (
          SELECT 1
          FROM contracts
          WHERE contracts.league_id = NEW.league_id
            AND contracts.id = NEW.contract_id
            AND contracts.player_id = NEW.player_id
            AND contracts.current_team_id = NEW.winning_team_id
            AND contracts.start_season_id = NEW.season_id
            AND contracts.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM player_ownerships
          WHERE player_ownerships.league_id = NEW.league_id
            AND player_ownerships.id = NEW.ownership_id
            AND player_ownerships.season_id = NEW.season_id
            AND player_ownerships.player_id = NEW.player_id
            AND player_ownerships.team_id = NEW.winning_team_id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'allocation may only follow automatic, restricted, fallback, or attributable correction state'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recoveries_forward_update
BEFORE UPDATE ON free_agent_draft_recoveries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.rollover_id IS OLD.rollover_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.job_run_id IS OLD.job_run_id
    AND NEW.nomination_queue_id IS OLD.nomination_queue_id
    AND NEW.kind IS OLD.kind
    AND NEW.earliest_activation_at_ms IS
      OLD.earliest_activation_at_ms
    AND NEW.target_resolution_at_ms IS
      OLD.target_resolution_at_ms
    AND NEW.created_by_operation_id IS
      OLD.created_by_operation_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status IN ('pending', 'ready')
        AND NEW.status = 'running'
        AND NEW.resolved_at_ms IS NULL
        AND NEW.resolved_authority IS NULL
      )
      OR (
        OLD.status = 'running'
        AND NEW.status = 'resolved'
        AND NEW.resolved_at_ms = NEW.updated_at_ms
        AND NEW.resolved_authority IS NOT NULL
        AND (
          NEW.resolved_authority = 'system'
          OR EXISTS (
            SELECT 1
            FROM league_memberships
            WHERE league_memberships.league_id = NEW.league_id
              AND league_memberships.id =
                NEW.resolved_by_membership_id
              AND league_memberships.user_id =
                NEW.resolved_by_user_id
          )
        )
        AND (
          (
            NEW.kind = 'deadline_retry'
            AND EXISTS (
              SELECT 1
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = NEW.league_id
                AND free_agent_drafts.id = NEW.fad_id
                AND free_agent_drafts.status IN (
                  'deadline_locked',
                  'allocating',
                  'rapid',
                  'completed'
                )
                AND free_agent_drafts.deadline_locked_at_ms
                  IS NOT NULL
            )
          )
          OR (
            NEW.kind = 'allocation_retry'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.allocation_id
                AND free_agent_draft_player_allocations.status IN (
                  'automatic_award',
                  'restricted_scheduled',
                  'restricted_active',
                  'restricted_fallback_open',
                  'restricted_resolved',
                  'fallback_open_resolved',
                  'no_valid_offer',
                  'invalid'
                )
                AND free_agent_draft_player_allocations.status <>
                  'correction_required'
            )
          )
          OR (
            NEW.kind = 'restricted_activation'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              JOIN auctions
                ON auctions.league_id =
                    free_agent_draft_player_allocations.league_id
               AND auctions.id =
                    free_agent_draft_player_allocations
                      .restricted_auction_id
              JOIN auction_contexts
                ON auction_contexts.league_id = auctions.league_id
               AND auction_contexts.auction_id = auctions.id
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.allocation_id
                AND free_agent_draft_player_allocations
                  .restricted_auction_id = NEW.auction_id
                AND free_agent_draft_player_allocations.status IN (
                  'restricted_active',
                  'restricted_resolved',
                  'restricted_fallback_open',
                  'fallback_open_resolved'
                )
                AND auctions.status IN (
                  'open',
                  'resolving',
                  'resolved',
                  'no_winner'
                )
                AND auction_contexts.source_kind = 'fad_restricted'
            )
          )
          OR (
            NEW.kind = 'queued_nomination_activation'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_nomination_queue
              WHERE free_agent_draft_nomination_queue.league_id =
                  NEW.league_id
                AND free_agent_draft_nomination_queue.season_id =
                  NEW.season_id
                AND free_agent_draft_nomination_queue.fad_id =
                  NEW.fad_id
                AND free_agent_draft_nomination_queue.id =
                  NEW.nomination_queue_id
                AND free_agent_draft_nomination_queue.player_id =
                  NEW.player_id
                AND free_agent_draft_nomination_queue
                  .target_opening_rollover_id = NEW.rollover_id
                AND free_agent_draft_nomination_queue.status IN (
                  'opened',
                  'invalid'
                )
                AND free_agent_draft_nomination_queue
                  .terminal_at_ms <= NEW.resolved_at_ms
            )
          )
          OR (
            NEW.kind = 'fallback_activation'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              JOIN auctions
                ON auctions.league_id =
                    free_agent_draft_player_allocations.league_id
               AND auctions.id =
                    free_agent_draft_player_allocations
                      .fallback_open_auction_id
              JOIN auction_contexts
                ON auction_contexts.league_id = auctions.league_id
               AND auction_contexts.auction_id = auctions.id
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.id =
                  NEW.allocation_id
                AND free_agent_draft_player_allocations
                  .fallback_open_auction_id = NEW.auction_id
                AND free_agent_draft_player_allocations.status IN (
                  'restricted_fallback_open',
                  'fallback_open_resolved'
                )
                AND auctions.status IN (
                  'open',
                  'resolving',
                  'resolved',
                  'no_winner'
                )
                AND auction_contexts.source_kind = 'fad_open_rapid'
                AND auction_contexts.fad_origin =
                  'restricted_no_improvement_fallback'
            )
          )
          OR (
            NEW.kind IN (
              'restricted_activation',
              'fallback_activation'
            )
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations AS allocation
              JOIN auctions AS auction
                ON auction.league_id = allocation.league_id
               AND auction.id = NEW.auction_id
              JOIN auction_contexts AS context
                ON context.league_id = auction.league_id
               AND context.season_id = auction.season_id
               AND context.auction_id = auction.id
               AND context.fad_id = allocation.fad_id
               AND context.fad_allocation_id = allocation.id
              JOIN auction_resolutions AS resolution
                ON resolution.league_id = auction.league_id
               AND resolution.season_id = auction.season_id
               AND resolution.auction_id = auction.id
              JOIN free_agent_draft_draws AS draw
                ON draw.league_id = context.league_id
               AND draw.season_id = context.season_id
               AND draw.fad_id = context.fad_id
               AND draw.allocation_id = context.fad_allocation_id
               AND draw.auction_id = context.auction_id
              JOIN free_agent_draft_allocation_events AS event
                ON event.league_id = allocation.league_id
               AND event.season_id = allocation.season_id
               AND event.fad_id = allocation.fad_id
               AND event.allocation_id = allocation.id
               AND event.allocation_version = allocation.version
               AND event.player_id = allocation.player_id
              JOIN commissioner_corrections AS correction
                ON correction.league_id = event.league_id
               AND correction.season_id = event.season_id
               AND correction.id = event.correction_id
              JOIN job_runs AS job
                ON job.league_id = NEW.league_id
               AND job.season_id = NEW.season_id
               AND job.id = NEW.job_run_id
              WHERE allocation.league_id = NEW.league_id
                AND allocation.season_id = NEW.season_id
                AND allocation.fad_id = NEW.fad_id
                AND allocation.id = NEW.allocation_id
                AND allocation.player_id = NEW.player_id
                AND allocation.status IN (
                  'automatic_award',
                  'no_valid_offer'
                )
                AND allocation.decision_code = 'corrected'
                AND allocation.accounted_at_ms = NEW.resolved_at_ms
                AND allocation.last_error_code IS NULL
                AND context.fad_rollover_id = NEW.rollover_id
                AND (
                  (
                    NEW.kind = 'restricted_activation'
                    AND allocation.restricted_auction_id =
                        NEW.auction_id
                    AND context.source_kind = 'fad_restricted'
                    AND context.fad_origin =
                      'candidate_tie_restricted'
                    AND job.job_type =
                      'fad_restricted_activation'
                  )
                  OR (
                    NEW.kind = 'fallback_activation'
                    AND allocation.fallback_open_auction_id =
                        NEW.auction_id
                    AND context.source_kind = 'fad_open_rapid'
                    AND context.fad_origin =
                      'restricted_no_improvement_fallback'
                    AND job.job_type =
                      'fad_fallback_activation'
                  )
                )
                AND auction.status = 'cancelled'
                AND auction.updated_at_ms = NEW.resolved_at_ms
                AND resolution.status = 'cancelled'
                AND resolution.outcome_code = 'recovered'
                AND resolution.trigger_type = 'commissioner'
                AND resolution.triggered_by_user_id =
                    NEW.resolved_by_user_id
                AND resolution.resolved_at_ms = NEW.resolved_at_ms
                AND draw.version = 2
                AND draw.revealed_at_ms = NEW.resolved_at_ms
                AND draw.ordered_tied_bid_ids_json = '[]'
                AND draw.ordered_tied_team_ids_json = '[]'
                AND draw.rejection_counter IS NULL
                AND draw.selected_index IS NULL
                AND draw.selected_bid_id IS NULL
                AND draw.selected_team_id IS NULL
                AND draw.selected_digest_hex IS NULL
                AND event.event_kind = 'correction_applied'
                AND event.decision_code = 'corrected'
                AND event.resulting_allocation_status =
                    allocation.status
                AND event.auction_id IS
                    allocation.restricted_auction_id
                AND event.actor_user_id = NEW.resolved_by_user_id
                AND event.actor_membership_id =
                    NEW.resolved_by_membership_id
                AND event.actor_authority = NEW.resolved_authority
                AND event.occurred_at_ms = NEW.resolved_at_ms
                AND correction.feature =
                    'free_agent_draft_allocation'
                AND correction.feature_record_id = allocation.id
                AND correction.actor_user_id =
                    NEW.resolved_by_user_id
                AND correction.corrected_at_ms = NEW.resolved_at_ms
                AND NEW.created_by_operation_id = job.id
                AND job.status IN (
                  'succeeded',
                  'failed',
                  'skipped'
                )
                AND job.attempt_count >= 1
                AND job.lease_owner IS NULL
                AND job.lease_token IS NULL
                AND job.lease_expires_at_ms IS NULL
                AND job.completed_at_ms IS NOT NULL
                AND job.completed_at_ms <= NEW.resolved_at_ms
                AND job.updated_at_ms <= NEW.resolved_at_ms
            )
          )
          OR (
            NEW.kind = 'auction_resolution'
            AND (
              EXISTS (
                SELECT 1
                FROM auctions
                JOIN free_agent_draft_draws
                  ON free_agent_draft_draws.league_id =
                      auctions.league_id
                 AND free_agent_draft_draws.auction_id = auctions.id
                WHERE auctions.league_id = NEW.league_id
                  AND auctions.id = NEW.auction_id
                  AND auctions.status IN (
                    'resolved',
                    'no_winner',
                    'cancelled'
                  )
                  AND free_agent_draft_draws.revealed_at_ms =
                    auctions.updated_at_ms
                  AND (
                    SELECT COUNT(*)
                    FROM auction_resolutions
                    WHERE auction_resolutions.league_id =
                        auctions.league_id
                      AND auction_resolutions.auction_id = auctions.id
                      AND auction_resolutions.status IN (
                        'resolved',
                        'no_bids',
                        'no_winner',
                        'cancelled',
                        'recovered'
                      )
                  ) = 1
              )
              OR EXISTS (
                SELECT 1
                FROM auctions
                JOIN auction_contexts
                  ON auction_contexts.league_id = auctions.league_id
                 AND auction_contexts.season_id = auctions.season_id
                 AND auction_contexts.auction_id = auctions.id
                JOIN auction_resolutions
                  ON auction_resolutions.league_id = auctions.league_id
                 AND auction_resolutions.season_id = auctions.season_id
                 AND auction_resolutions.auction_id = auctions.id
                JOIN free_agent_draft_draws
                  ON free_agent_draft_draws.league_id = auctions.league_id
                 AND free_agent_draft_draws.season_id = auctions.season_id
                 AND free_agent_draft_draws.fad_id =
                      auction_contexts.fad_id
                 AND free_agent_draft_draws.allocation_id =
                      auction_contexts.fad_allocation_id
                 AND free_agent_draft_draws.auction_id = auctions.id
                JOIN free_agent_draft_player_allocations AS allocation
                  ON allocation.league_id = auction_contexts.league_id
                 AND allocation.season_id = auction_contexts.season_id
                 AND allocation.fad_id = auction_contexts.fad_id
                 AND allocation.id = auction_contexts.fad_allocation_id
                 AND allocation.player_id = auctions.player_id
                JOIN free_agent_draft_allocation_events AS correction_event
                  ON correction_event.league_id = allocation.league_id
                 AND correction_event.season_id = allocation.season_id
                 AND correction_event.fad_id = allocation.fad_id
                 AND correction_event.allocation_id = allocation.id
                 AND correction_event.allocation_version = allocation.version
                 AND correction_event.player_id = allocation.player_id
                JOIN commissioner_corrections
                  ON commissioner_corrections.league_id =
                      correction_event.league_id
                 AND commissioner_corrections.id =
                      correction_event.correction_id
                 AND commissioner_corrections.season_id =
                      correction_event.season_id
                JOIN job_runs
                  ON job_runs.league_id = auctions.league_id
                 AND job_runs.season_id = auctions.season_id
                 AND job_runs.id = NEW.job_run_id
                WHERE auctions.league_id = NEW.league_id
                  AND auctions.season_id = NEW.season_id
                  AND auctions.id = NEW.auction_id
                  AND auctions.player_id = NEW.player_id
                  AND auctions.status = 'cancelled'
                  AND auctions.updated_at_ms <= NEW.resolved_at_ms
                  AND auction_contexts.source_kind = 'fad_restricted'
                  AND auction_contexts.fad_id = NEW.fad_id
                  AND auction_contexts.fad_rollover_id = NEW.rollover_id
                  AND auction_contexts.fad_allocation_id =
                      NEW.allocation_id
                  AND auction_contexts.fad_origin =
                      'candidate_tie_restricted'
                  AND auction_resolutions.scheduled_occurrence_key =
                      'auction:' || auctions.id || ':' ||
                        auctions.resolves_at_ms
                  AND auction_resolutions.status = 'cancelled'
                  AND auction_resolutions.outcome_code = 'failed'
                  AND auction_resolutions.resolved_at_ms =
                      auctions.updated_at_ms
                  AND free_agent_draft_draws.revealed_at_ms IS NULL
                  AND free_agent_draft_draws.ordered_tied_bid_ids_json
                      IS NULL
                  AND free_agent_draft_draws.ordered_tied_team_ids_json
                      IS NULL
                  AND free_agent_draft_draws.selected_bid_id IS NULL
                  AND free_agent_draft_draws.selected_team_id IS NULL
                  AND free_agent_draft_draws.updated_at_ms =
                      free_agent_draft_draws.created_at_ms
                  AND free_agent_draft_draws.version = 1
                  AND allocation.status IN (
                    'automatic_award',
                    'restricted_resolved',
                    'fallback_open_resolved',
                    'no_valid_offer',
                    'invalid'
                  )
                  AND allocation.decision_code = 'corrected'
                  AND allocation.restricted_auction_id = auctions.id
                  AND allocation.last_error_code IS NULL
                  AND allocation.accounted_at_ms <= NEW.resolved_at_ms
                  AND correction_event.event_kind = 'correction_applied'
                  AND correction_event.decision_code = 'corrected'
                  AND correction_event.resulting_allocation_status =
                      allocation.status
                  AND correction_event.auction_id = auctions.id
                  AND correction_event.actor_authority IN (
                    'commissioner',
                    'platform_administrator_as_commissioner'
                  )
                  AND correction_event.occurred_at_ms =
                      allocation.accounted_at_ms
                  AND commissioner_corrections.feature =
                      'free_agent_draft_allocation'
                  AND commissioner_corrections.feature_record_id =
                      allocation.id
                  AND commissioner_corrections.actor_user_id =
                      correction_event.actor_user_id
                  AND commissioner_corrections.corrected_at_ms =
                      correction_event.occurred_at_ms
                  AND job_runs.job_type = 'auction.resolve.target'
                  AND job_runs.occurrence_key =
                      auction_resolutions.scheduled_occurrence_key
                  AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
                  AND job_runs.status = 'failed'
                  AND job_runs.attempt_count >= 1
                  AND job_runs.lease_owner IS NULL
                  AND job_runs.lease_token IS NULL
                  AND job_runs.lease_expires_at_ms IS NULL
                  AND job_runs.result_json IS NULL
                  AND job_runs.last_error_code = OLD.last_error_code
                  AND job_runs.completed_at_ms = auctions.updated_at_ms
              )
            )
            AND (
              NEW.allocation_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM free_agent_draft_player_allocations
                WHERE free_agent_draft_player_allocations.league_id =
                    NEW.league_id
                  AND free_agent_draft_player_allocations.id =
                    NEW.allocation_id
                  AND free_agent_draft_player_allocations.status IN (
                    'automatic_award',
                    'restricted_resolved',
                    'restricted_fallback_open',
                    'fallback_open_resolved',
                    'no_valid_offer',
                    'invalid'
                  )
              )
            )
          )
          OR (
            NEW.kind = 'rollover_finalize'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_rollovers
              WHERE free_agent_draft_rollovers.league_id = NEW.league_id
                AND free_agent_draft_rollovers.id = NEW.rollover_id
                AND free_agent_draft_rollovers.status = 'completed'
                AND free_agent_draft_rollovers.completed_at_ms <=
                  NEW.resolved_at_ms
            )
          )
          OR (
            NEW.kind = 'completion'
            AND EXISTS (
              SELECT 1
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = NEW.league_id
                AND free_agent_drafts.id = NEW.fad_id
                AND free_agent_drafts.status = 'rapid'
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_player_allocations
                  WHERE free_agent_draft_player_allocations.league_id =
                      NEW.league_id
                    AND free_agent_draft_player_allocations.fad_id =
                      NEW.fad_id
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
                    AND free_agent_draft_rollovers.fad_id = NEW.fad_id
                    AND free_agent_draft_rollovers.status <> 'completed'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_nomination_queue
                  WHERE free_agent_draft_nomination_queue.league_id =
                      NEW.league_id
                    AND free_agent_draft_nomination_queue.fad_id =
                      NEW.fad_id
                    AND free_agent_draft_nomination_queue.status = 'queued'
                )
            )
          )
        )
      )
      OR (
        OLD.status IN ('pending', 'ready', 'running')
        AND NEW.status = 'correction_required'
        AND NEW.resolved_at_ms IS NULL
        AND NEW.resolved_authority IS NULL
        AND NEW.last_error_code IS NOT NULL
      )
      OR (
        OLD.status = 'correction_required'
        AND NEW.status = 'running'
        AND NEW.resolved_at_ms IS NULL
        AND NEW.resolved_authority IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery may only advance through explicit retry or resolution'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recoveries_valid_insert
BEFORE INSERT ON free_agent_draft_recoveries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status IN (
      'pending',
      'ready',
      'running',
      'correction_required'
    )
    AND NEW.resolved_at_ms IS NULL
    AND NEW.resolved_by_user_id IS NULL
    AND NEW.resolved_by_membership_id IS NULL
    AND NEW.resolved_authority IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND (
      NEW.allocation_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_player_allocations AS allocation
        WHERE allocation.league_id = NEW.league_id
          AND allocation.season_id = NEW.season_id
          AND allocation.fad_id = NEW.fad_id
          AND allocation.id = NEW.allocation_id
          AND allocation.player_id = NEW.player_id
      )
    )
    AND (
      NEW.rollover_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_rollovers AS rollover
        WHERE rollover.league_id = NEW.league_id
          AND rollover.season_id = NEW.season_id
          AND rollover.fad_id = NEW.fad_id
          AND rollover.id = NEW.rollover_id
      )
    )
    AND (
      NEW.auction_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM auction_contexts AS context
        JOIN auctions AS auction
          ON auction.league_id = context.league_id
         AND auction.season_id = context.season_id
         AND auction.id = context.auction_id
        WHERE context.league_id = NEW.league_id
          AND context.season_id = NEW.season_id
          AND context.fad_id = NEW.fad_id
          AND context.auction_id = NEW.auction_id
          AND auction.player_id = NEW.player_id
      )
    )
    AND (
      (
        NEW.job_run_id IS NULL
        AND (
          NEW.created_by_operation_id IS NULL
          OR (
            length(NEW.created_by_operation_id) = 36
            AND NEW.created_by_operation_id =
              lower(NEW.created_by_operation_id)
          )
        )
      )
      OR EXISTS (
        SELECT 1
        FROM job_runs AS job
        WHERE job.league_id = NEW.league_id
          AND job.season_id = NEW.season_id
          AND job.id = NEW.job_run_id
          AND NEW.created_by_operation_id = job.id
      )
    )
    AND (
      (
        NEW.kind = 'queued_nomination_activation'
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_nomination_queue AS queue
          WHERE queue.league_id = NEW.league_id
            AND queue.season_id = NEW.season_id
            AND queue.fad_id = NEW.fad_id
            AND queue.id = NEW.nomination_queue_id
            AND queue.player_id = NEW.player_id
            AND queue.target_opening_rollover_id = NEW.rollover_id
        )
      )
      OR (
        NEW.kind <> 'queued_nomination_activation'
        AND NEW.nomination_queue_id IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery must preserve exact causal resources and operation identity'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_valid_insert
BEFORE INSERT ON free_agent_draft_rollovers
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'scheduled'
    AND NEW.processing_job_run_id IS NULL
    AND NEW.processing_started_at_ms IS NULL
    AND NEW.completed_at_ms IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status IN (
          'cards_open',
          'deadline_locked',
          'allocating',
          'rapid'
        )
        AND (
          (NEW.window_kind = 'initial' AND NEW.sequence <= COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7)
            AND NEW.opens_at_ms = CASE
              WHEN free_agent_drafts.initial_rollover_times_json IS NULL THEN free_agent_drafts.candidate_deadline_at_ms + (NEW.sequence - 1) * 86400000
              WHEN NEW.sequence = 1 THEN free_agent_drafts.candidate_deadline_at_ms
              ELSE json_extract(free_agent_drafts.initial_rollover_times_json, '$[' || (NEW.sequence - 2) || ']') END
            AND NEW.rolls_over_at_ms = CASE
              WHEN free_agent_drafts.initial_rollover_times_json IS NULL THEN free_agent_drafts.candidate_deadline_at_ms + NEW.sequence * 86400000
              ELSE json_extract(free_agent_drafts.initial_rollover_times_json, '$[' || (NEW.sequence - 1) || ']') END)
          OR (NEW.window_kind = 'extension' AND NEW.sequence > COALESCE(json_array_length(free_agent_drafts.initial_rollover_times_json), 7))
        )
    )
    AND (
      (
        NEW.sequence = 1
        AND NEW.window_kind = 'initial'
        AND NEW.predecessor_rollover_id IS NULL
      )
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_rollovers AS predecessor
        WHERE predecessor.league_id = NEW.league_id
          AND predecessor.season_id = NEW.season_id
          AND predecessor.fad_id = NEW.fad_id
          AND predecessor.id = NEW.predecessor_rollover_id
          AND predecessor.sequence = NEW.sequence - 1
          AND predecessor.rolls_over_at_ms = NEW.opens_at_ms
          AND (
            (
              NEW.window_kind = 'initial'
              AND NEW.sequence >= 2
            )
            OR (
              NEW.window_kind = 'extension'
              AND NEW.sequence >= 2
              AND (
                predecessor.status IN (
                  'processing',
                  'completed',
                  'recovery_required'
                )
                OR (
                  predecessor.status = 'scheduled'
                  AND NEW.extension_reason = 'queued_nomination'
                  AND NEW.created_at_ms >=
                    predecessor.rolls_over_at_ms
                  AND NEW.created_at_ms <
                    NEW.rolls_over_at_ms
                )
                OR (
                  predecessor.status = 'scheduled'
                  AND NEW.extension_reason = 'fallback_auction'
                  AND NEW.created_at_ms >=
                    predecessor.creation_cutoff_at_ms
                  AND NEW.created_at_ms <
                    predecessor.rolls_over_at_ms
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_player_allocations
                      AS allocation
                    JOIN auctions AS restricted_auction
                      ON restricted_auction.league_id =
                          allocation.league_id
                     AND restricted_auction.season_id =
                          allocation.season_id
                     AND restricted_auction.id =
                          allocation.restricted_auction_id
                     AND restricted_auction.player_id =
                          allocation.player_id
                    JOIN auction_contexts AS restricted_context
                      ON restricted_context.league_id =
                          restricted_auction.league_id
                     AND restricted_context.season_id =
                          restricted_auction.season_id
                     AND restricted_context.auction_id =
                          restricted_auction.id
                    JOIN free_agent_draft_rollovers AS source_rollover
                      ON source_rollover.league_id =
                          restricted_context.league_id
                     AND source_rollover.season_id =
                          restricted_context.season_id
                     AND source_rollover.fad_id =
                          restricted_context.fad_id
                     AND source_rollover.id =
                          restricted_context.fad_rollover_id
                    JOIN free_agent_draft_draws AS restricted_draw
                      ON restricted_draw.league_id =
                          restricted_context.league_id
                     AND restricted_draw.season_id =
                          restricted_context.season_id
                     AND restricted_draw.fad_id =
                          restricted_context.fad_id
                     AND restricted_draw.allocation_id =
                          restricted_context.fad_allocation_id
                     AND restricted_draw.auction_id =
                          restricted_context.auction_id
                    JOIN job_runs AS resolution_job
                      ON resolution_job.league_id =
                          restricted_auction.league_id
                     AND resolution_job.season_id =
                          restricted_auction.season_id
                     AND resolution_job.job_type =
                          'auction.resolve.target'
                     AND resolution_job.occurrence_key =
                          'auction:' || restricted_auction.id || ':' ||
                            restricted_auction.resolves_at_ms
                     AND resolution_job.scheduled_for_ms =
                          restricted_auction.resolves_at_ms
                    WHERE allocation.league_id = NEW.league_id
                      AND allocation.season_id = NEW.season_id
                      AND allocation.fad_id = NEW.fad_id
                      AND allocation.id = NEW.extension_source_id
                      AND allocation.status = 'restricted_active'
                      AND allocation.decision_code =
                        'exact_total_and_term_tie'
                      AND allocation.winning_snapshot_entry_id IS NULL
                      AND allocation.winning_team_id IS NULL
                      AND allocation.contract_id IS NULL
                      AND allocation.ownership_id IS NULL
                      AND allocation.restricted_auction_id IS NOT NULL
                      AND allocation.fallback_open_auction_id IS NULL
                      AND allocation.restricted_minimum_total_cents
                        IS NOT NULL
                      AND allocation.restricted_minimum_term_years
                        IS NOT NULL
                      AND allocation.restricted_minimum_aav_cents
                        IS NOT NULL
                      AND allocation.accounted_at_ms IS NULL
                      AND allocation.last_error_code IS NULL
                      AND restricted_auction.status = 'resolving'
                      AND restricted_auction.opened_at_ms >=
                        source_rollover.opens_at_ms
                      AND restricted_auction.opened_at_ms <
                        source_rollover.rolls_over_at_ms
                      AND restricted_auction.resolves_at_ms =
                        source_rollover.rolls_over_at_ms
                      AND restricted_auction.resolves_at_ms <=
                        NEW.created_at_ms
                      AND NOT EXISTS (
                        SELECT 1
                        FROM auction_resolutions
                        WHERE auction_resolutions.league_id =
                            restricted_auction.league_id
                          AND auction_resolutions.auction_id =
                            restricted_auction.id
                      )
                      AND restricted_context.source_kind =
                        'fad_restricted'
                      AND restricted_context.fad_id = allocation.fad_id
                      AND restricted_context.fad_allocation_id = allocation.id
                      AND restricted_context.fad_origin =
                        'candidate_tie_restricted'
                      AND restricted_draw.revealed_at_ms IS NULL
                      AND restricted_draw.version = 1
                      AND (
                        (
                          source_rollover.id =
                            predecessor.predecessor_rollover_id
                          AND source_rollover.sequence =
                            predecessor.sequence - 1
                          AND source_rollover.rolls_over_at_ms =
                            predecessor.opens_at_ms
                          AND source_rollover.status IN (
                            'scheduled',
                            'processing',
                            'recovery_required'
                          )
                          AND resolution_job.status IN (
                            'leased',
                            'running'
                          )
                          AND resolution_job.attempt_count >= 1
                          AND resolution_job.lease_owner IS NOT NULL
                          AND resolution_job.lease_token IS NOT NULL
                          AND resolution_job.lease_expires_at_ms >
                            NEW.created_at_ms
                          AND resolution_job.completed_at_ms IS NULL
                          AND resolution_job.result_json IS NULL
                          AND resolution_job.last_error_code IS NULL
                          AND resolution_job.next_attempt_at_ms IS NULL
                          AND resolution_job.updated_at_ms <=
                            NEW.created_at_ms
                          AND (
                            source_rollover.status <>
                              'recovery_required'
                            OR EXISTS (
                              SELECT 1
                              FROM free_agent_draft_recoveries AS recovery
                              WHERE recovery.league_id =
                                  allocation.league_id
                                AND recovery.season_id =
                                  allocation.season_id
                                AND recovery.fad_id = allocation.fad_id
                                AND recovery.player_id = allocation.player_id
                                AND recovery.allocation_id = allocation.id
                                AND recovery.rollover_id = source_rollover.id
                                AND recovery.auction_id =
                                  restricted_auction.id
                                AND recovery.job_run_id = resolution_job.id
                                AND recovery.kind = 'auction_resolution'
                                AND recovery.status = 'running'
                                AND recovery.created_by_operation_id =
                                  resolution_job.id
                                AND recovery.resolved_at_ms IS NULL
                            )
                          )
                        )
                        OR (
                          source_rollover.sequence <
                            predecessor.sequence - 1
                          AND source_rollover.rolls_over_at_ms <
                            predecessor.opens_at_ms
                          AND source_rollover.status =
                            'recovery_required'
                          AND resolution_job.status IN (
                            'leased',
                            'running'
                          )
                          AND resolution_job.attempt_count >= 2
                          AND resolution_job.lease_owner IS NOT NULL
                          AND resolution_job.lease_token IS NOT NULL
                          AND resolution_job.lease_expires_at_ms >
                            NEW.created_at_ms
                          AND resolution_job.completed_at_ms IS NULL
                          AND resolution_job.result_json IS NULL
                          AND resolution_job.last_error_code IS NULL
                          AND resolution_job.next_attempt_at_ms IS NULL
                          AND resolution_job.updated_at_ms <=
                            NEW.created_at_ms
                          AND EXISTS (
                            SELECT 1
                            FROM free_agent_draft_recoveries AS recovery
                            JOIN auction_events AS failure_event
                              ON failure_event.league_id =
                                  recovery.league_id
                             AND failure_event.season_id =
                                  recovery.season_id
                             AND failure_event.auction_id =
                                  recovery.auction_id
                             AND failure_event.event_type =
                                  'fad_auction_resolution_failed'
                            JOIN free_agent_draft_recovery_action_command_results
                              AS receipt
                              ON receipt.league_id = recovery.league_id
                             AND receipt.season_id = recovery.season_id
                             AND receipt.fad_id = recovery.fad_id
                             AND receipt.recovery_id = recovery.id
                             AND receipt.job_run_id = recovery.job_run_id
                            JOIN idempotency_requests AS request
                              ON request.league_id = receipt.league_id
                             AND request.id =
                                  receipt.idempotency_request_id
                            WHERE recovery.league_id = allocation.league_id
                              AND recovery.season_id = allocation.season_id
                              AND recovery.fad_id = allocation.fad_id
                              AND recovery.player_id = allocation.player_id
                              AND recovery.allocation_id = allocation.id
                              AND recovery.rollover_id = source_rollover.id
                              AND recovery.auction_id = restricted_auction.id
                              AND recovery.job_run_id = resolution_job.id
                              AND recovery.kind = 'auction_resolution'
                              AND recovery.status = 'running'
                              AND recovery.last_error_code IS NOT NULL
                              AND recovery.created_by_operation_id =
                                resolution_job.id
                              AND recovery.resolved_at_ms IS NULL
                              AND recovery.updated_at_ms <= NEW.created_at_ms
                              AND failure_event.actor_user_id IS NULL
                              AND failure_event.bid_id IS NULL
                              AND failure_event.team_id IS NULL
                              AND json_extract(
                                    failure_event.metadata_json,
                                    '$.recoveryId'
                                  ) = recovery.id
                              AND json_extract(
                                    failure_event.metadata_json,
                                    '$.jobRunId'
                                  ) = resolution_job.id
                              AND json_extract(
                                    failure_event.metadata_json,
                                    '$.errorCode'
                                  ) = recovery.last_error_code
                              AND recovery.created_at_ms <=
                                failure_event.occurred_at_ms
                              AND NOT EXISTS (
                                SELECT 1
                                FROM auction_events AS later_failure
                                WHERE later_failure.league_id =
                                    failure_event.league_id
                                  AND later_failure.season_id =
                                    failure_event.season_id
                                  AND later_failure.auction_id =
                                    failure_event.auction_id
                                  AND later_failure.event_type =
                                    'fad_auction_resolution_failed'
                                  AND json_extract(
                                        later_failure.metadata_json,
                                        '$.recoveryId'
                                      ) = recovery.id
                                  AND json_extract(
                                        later_failure.metadata_json,
                                        '$.jobRunId'
                                      ) = resolution_job.id
                                  AND later_failure.occurred_at_ms >
                                    failure_event.occurred_at_ms
                              )
                              AND receipt.action =
                                'retry_auction_resolution'
                              AND receipt.resource_kind = 'auction'
                              AND receipt.resource_id = restricted_auction.id
                              AND receipt.operation_id = resolution_job.id
                              AND receipt.occurrence_key =
                                resolution_job.occurrence_key
                              AND receipt.accepted_status = 'pending'
                              AND receipt.accepted_at_ms >=
                                failure_event.occurred_at_ms
                              AND receipt.accepted_at_ms <= NEW.created_at_ms
                              AND request.status = 'completed'
                              AND request.result_type =
                                'free_agent_draft_recovery_action_command_result'
                              AND request.result_id = receipt.id
                              AND request.completed_at_ms =
                                receipt.accepted_at_ms
                              AND NOT EXISTS (
                                SELECT 1
                                FROM free_agent_draft_recovery_action_command_results
                                  AS later_receipt
                                WHERE later_receipt.league_id =
                                    receipt.league_id
                                  AND later_receipt.recovery_id =
                                    receipt.recovery_id
                                  AND later_receipt.action =
                                    'retry_auction_resolution'
                                  AND later_receipt.accepted_at_ms >
                                    receipt.accepted_at_ms
                                  AND later_receipt.accepted_at_ms <=
                                    NEW.created_at_ms
                              )
                          )
                        )
                      )
                  )
                )
              )
            )
          )
      )
    )
    AND (
      NEW.window_kind = 'initial'
      OR (
        (
          NEW.extension_reason = 'queued_nomination'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_nomination_queue AS queue
            JOIN free_agent_draft_rollovers AS opening_rollover
              ON opening_rollover.league_id = queue.league_id
             AND opening_rollover.season_id = queue.season_id
             AND opening_rollover.fad_id = queue.fad_id
             AND opening_rollover.id =
                  queue.target_opening_rollover_id
            JOIN job_runs AS activation_job
              ON activation_job.league_id = queue.league_id
             AND activation_job.season_id = queue.season_id
            WHERE queue.league_id = NEW.league_id
              AND queue.season_id = NEW.season_id
              AND queue.fad_id = NEW.fad_id
              AND queue.id = NEW.extension_source_id
              AND queue.status = 'queued'
              AND queue.target_opening_rollover_id =
                NEW.predecessor_rollover_id
              AND queue.resolution_rollover_id IS NULL
              AND queue.opened_auction_id IS NULL
              AND queue.opened_starter_bid_id IS NULL
              AND queue.opened_at_ms IS NULL
              AND queue.terminal_at_ms IS NULL
              AND queue.validation_code IS NULL
              AND opening_rollover.rolls_over_at_ms =
                NEW.opens_at_ms
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
              AND activation_job.started_at_ms >=
                opening_rollover.rolls_over_at_ms
              AND activation_job.started_at_ms <=
                NEW.created_at_ms
              AND activation_job.updated_at_ms =
                activation_job.started_at_ms
              AND activation_job.lease_expires_at_ms >
                NEW.created_at_ms
              AND activation_job.completed_at_ms IS NULL
              AND activation_job.result_json IS NULL
              AND activation_job.last_error_code IS NULL
              AND activation_job.next_attempt_at_ms IS NULL
              AND activation_job.created_at_ms =
                queue.accepted_at_ms
          )
        )
        OR (
          NEW.extension_reason = 'restricted_auction'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_player_allocations
            WHERE free_agent_draft_player_allocations.league_id =
                NEW.league_id
              AND free_agent_draft_player_allocations.season_id =
                NEW.season_id
              AND free_agent_draft_player_allocations.fad_id =
                NEW.fad_id
              AND free_agent_draft_player_allocations.id =
                NEW.extension_source_id
              AND free_agent_draft_player_allocations.status IN (
                'restricted_scheduled',
                'restricted_active'
              )
          )
        )
        OR (
          NEW.extension_reason = 'fallback_auction'
          AND (
            EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.season_id =
                  NEW.season_id
                AND free_agent_draft_player_allocations.fad_id =
                  NEW.fad_id
                AND free_agent_draft_player_allocations.id =
                  NEW.extension_source_id
                AND free_agent_draft_player_allocations.status =
                  'restricted_fallback_open'
            )
            OR EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations AS allocation
              JOIN auctions AS restricted_auction
                ON restricted_auction.league_id = allocation.league_id
               AND restricted_auction.season_id = allocation.season_id
               AND restricted_auction.id =
                    allocation.restricted_auction_id
               AND restricted_auction.player_id = allocation.player_id
              JOIN auction_contexts AS restricted_context
                ON restricted_context.league_id =
                    restricted_auction.league_id
               AND restricted_context.season_id =
                    restricted_auction.season_id
               AND restricted_context.auction_id = restricted_auction.id
              JOIN free_agent_draft_rollovers AS source_rollover
                ON source_rollover.league_id =
                    restricted_context.league_id
               AND source_rollover.season_id =
                    restricted_context.season_id
               AND source_rollover.fad_id = restricted_context.fad_id
               AND source_rollover.id =
                    restricted_context.fad_rollover_id
              JOIN free_agent_draft_rollovers AS predecessor
                ON predecessor.league_id = NEW.league_id
               AND predecessor.season_id = NEW.season_id
               AND predecessor.fad_id = NEW.fad_id
               AND predecessor.id = NEW.predecessor_rollover_id
              JOIN free_agent_draft_draws AS restricted_draw
                ON restricted_draw.league_id =
                    restricted_context.league_id
               AND restricted_draw.season_id =
                    restricted_context.season_id
               AND restricted_draw.fad_id = restricted_context.fad_id
               AND restricted_draw.allocation_id =
                    restricted_context.fad_allocation_id
               AND restricted_draw.auction_id =
                    restricted_context.auction_id
              JOIN job_runs AS resolution_job
                ON resolution_job.league_id = restricted_auction.league_id
               AND resolution_job.season_id = restricted_auction.season_id
               AND resolution_job.job_type = 'auction.resolve.target'
               AND resolution_job.occurrence_key =
                    'auction:' || restricted_auction.id || ':' ||
                      restricted_auction.resolves_at_ms
               AND resolution_job.scheduled_for_ms =
                    restricted_auction.resolves_at_ms
              WHERE allocation.league_id = NEW.league_id
                AND allocation.season_id = NEW.season_id
                AND allocation.fad_id = NEW.fad_id
                AND allocation.id = NEW.extension_source_id
                AND allocation.status = 'restricted_active'
                AND allocation.decision_code =
                  'exact_total_and_term_tie'
                AND allocation.winning_snapshot_entry_id IS NULL
                AND allocation.winning_team_id IS NULL
                AND allocation.contract_id IS NULL
                AND allocation.ownership_id IS NULL
                AND allocation.restricted_auction_id IS NOT NULL
                AND allocation.fallback_open_auction_id IS NULL
                AND allocation.restricted_minimum_total_cents IS NOT NULL
                AND allocation.restricted_minimum_term_years IS NOT NULL
                AND allocation.restricted_minimum_aav_cents IS NOT NULL
                AND allocation.accounted_at_ms IS NULL
                AND allocation.last_error_code IS NULL
                AND restricted_auction.status = 'resolving'
                AND restricted_auction.opened_at_ms >=
                  source_rollover.opens_at_ms
                AND restricted_auction.opened_at_ms <
                  source_rollover.rolls_over_at_ms
                AND restricted_auction.resolves_at_ms =
                  source_rollover.rolls_over_at_ms
                AND restricted_auction.resolves_at_ms <= NEW.created_at_ms
                AND NOT EXISTS (
                  SELECT 1
                  FROM auction_resolutions
                  WHERE auction_resolutions.league_id =
                      restricted_auction.league_id
                    AND auction_resolutions.auction_id =
                      restricted_auction.id
                )
                AND restricted_context.source_kind = 'fad_restricted'
                AND restricted_context.fad_id = allocation.fad_id
                AND restricted_context.fad_allocation_id = allocation.id
                AND restricted_context.fad_origin =
                  'candidate_tie_restricted'
                AND restricted_draw.revealed_at_ms IS NULL
                AND restricted_draw.version = 1
                AND predecessor.status = 'scheduled'
                AND predecessor.sequence = NEW.sequence - 1
                AND predecessor.rolls_over_at_ms = NEW.opens_at_ms
                AND NEW.created_at_ms >=
                  predecessor.creation_cutoff_at_ms
                AND NEW.created_at_ms < predecessor.rolls_over_at_ms
                AND (
                  (
                    source_rollover.id =
                      predecessor.predecessor_rollover_id
                    AND source_rollover.sequence =
                      predecessor.sequence - 1
                    AND source_rollover.rolls_over_at_ms =
                      predecessor.opens_at_ms
                    AND source_rollover.status IN (
                      'scheduled',
                      'processing',
                      'recovery_required'
                    )
                    AND resolution_job.status IN ('leased', 'running')
                    AND resolution_job.attempt_count >= 1
                    AND resolution_job.lease_owner IS NOT NULL
                    AND resolution_job.lease_token IS NOT NULL
                    AND resolution_job.lease_expires_at_ms >
                      NEW.created_at_ms
                    AND resolution_job.completed_at_ms IS NULL
                    AND resolution_job.result_json IS NULL
                    AND resolution_job.last_error_code IS NULL
                    AND resolution_job.next_attempt_at_ms IS NULL
                    AND resolution_job.updated_at_ms <= NEW.created_at_ms
                    AND (
                      source_rollover.status <> 'recovery_required'
                      OR EXISTS (
                        SELECT 1
                        FROM free_agent_draft_recoveries AS recovery
                        WHERE recovery.league_id = allocation.league_id
                          AND recovery.season_id = allocation.season_id
                          AND recovery.fad_id = allocation.fad_id
                          AND recovery.player_id = allocation.player_id
                          AND recovery.allocation_id = allocation.id
                          AND recovery.rollover_id = source_rollover.id
                          AND recovery.auction_id = restricted_auction.id
                          AND recovery.job_run_id = resolution_job.id
                          AND recovery.kind = 'auction_resolution'
                          AND recovery.status = 'running'
                          AND recovery.created_by_operation_id =
                            resolution_job.id
                          AND recovery.resolved_at_ms IS NULL
                      )
                    )
                  )
                  OR (
                    source_rollover.sequence <
                      predecessor.sequence - 1
                    AND source_rollover.rolls_over_at_ms <
                      predecessor.opens_at_ms
                    AND source_rollover.status = 'recovery_required'
                    AND resolution_job.status IN ('leased', 'running')
                    AND resolution_job.attempt_count >= 2
                    AND resolution_job.lease_owner IS NOT NULL
                    AND resolution_job.lease_token IS NOT NULL
                    AND resolution_job.lease_expires_at_ms >
                      NEW.created_at_ms
                    AND resolution_job.completed_at_ms IS NULL
                    AND resolution_job.result_json IS NULL
                    AND resolution_job.last_error_code IS NULL
                    AND resolution_job.next_attempt_at_ms IS NULL
                    AND resolution_job.updated_at_ms <= NEW.created_at_ms
                    AND EXISTS (
                      SELECT 1
                      FROM free_agent_draft_recoveries AS recovery
                      JOIN auction_events AS failure_event
                        ON failure_event.league_id = recovery.league_id
                       AND failure_event.season_id = recovery.season_id
                       AND failure_event.auction_id = recovery.auction_id
                       AND failure_event.event_type =
                            'fad_auction_resolution_failed'
                      JOIN free_agent_draft_recovery_action_command_results
                        AS receipt
                        ON receipt.league_id = recovery.league_id
                       AND receipt.season_id = recovery.season_id
                       AND receipt.fad_id = recovery.fad_id
                       AND receipt.recovery_id = recovery.id
                       AND receipt.job_run_id = recovery.job_run_id
                      JOIN idempotency_requests AS request
                        ON request.league_id = receipt.league_id
                       AND request.id = receipt.idempotency_request_id
                      WHERE recovery.league_id = allocation.league_id
                        AND recovery.season_id = allocation.season_id
                        AND recovery.fad_id = allocation.fad_id
                        AND recovery.player_id = allocation.player_id
                        AND recovery.allocation_id = allocation.id
                        AND recovery.rollover_id = source_rollover.id
                        AND recovery.auction_id = restricted_auction.id
                        AND recovery.job_run_id = resolution_job.id
                        AND recovery.kind = 'auction_resolution'
                        AND recovery.status = 'running'
                        AND recovery.last_error_code IS NOT NULL
                        AND recovery.created_by_operation_id =
                          resolution_job.id
                        AND recovery.resolved_at_ms IS NULL
                        AND recovery.updated_at_ms <= NEW.created_at_ms
                        AND failure_event.actor_user_id IS NULL
                        AND failure_event.bid_id IS NULL
                        AND failure_event.team_id IS NULL
                        AND json_extract(
                              failure_event.metadata_json,
                              '$.recoveryId'
                            ) = recovery.id
                        AND json_extract(
                              failure_event.metadata_json,
                              '$.jobRunId'
                            ) = resolution_job.id
                        AND json_extract(
                              failure_event.metadata_json,
                              '$.errorCode'
                            ) = recovery.last_error_code
                        AND recovery.created_at_ms <=
                          failure_event.occurred_at_ms
                        AND NOT EXISTS (
                          SELECT 1
                          FROM auction_events AS later_failure
                          WHERE later_failure.league_id =
                              failure_event.league_id
                            AND later_failure.season_id =
                              failure_event.season_id
                            AND later_failure.auction_id =
                              failure_event.auction_id
                            AND later_failure.event_type =
                              'fad_auction_resolution_failed'
                            AND json_extract(
                                  later_failure.metadata_json,
                                  '$.recoveryId'
                                ) = recovery.id
                            AND json_extract(
                                  later_failure.metadata_json,
                                  '$.jobRunId'
                                ) = resolution_job.id
                            AND later_failure.occurred_at_ms >
                              failure_event.occurred_at_ms
                        )
                        AND receipt.action =
                          'retry_auction_resolution'
                        AND receipt.resource_kind = 'auction'
                        AND receipt.resource_id = restricted_auction.id
                        AND receipt.operation_id = resolution_job.id
                        AND receipt.occurrence_key =
                          resolution_job.occurrence_key
                        AND receipt.accepted_status = 'pending'
                        AND receipt.accepted_at_ms >=
                          failure_event.occurred_at_ms
                        AND receipt.accepted_at_ms <= NEW.created_at_ms
                        AND request.status = 'completed'
                        AND request.result_type =
                          'free_agent_draft_recovery_action_command_result'
                        AND request.result_id = receipt.id
                        AND request.completed_at_ms = receipt.accepted_at_ms
                        AND NOT EXISTS (
                          SELECT 1
                          FROM free_agent_draft_recovery_action_command_results
                            AS later_receipt
                          WHERE later_receipt.league_id = receipt.league_id
                            AND later_receipt.recovery_id =
                              receipt.recovery_id
                            AND later_receipt.action =
                              'retry_auction_resolution'
                            AND later_receipt.accepted_at_ms >
                              receipt.accepted_at_ms
                            AND later_receipt.accepted_at_ms <=
                              NEW.created_at_ms
                        )
                    )
                  )
                )
            )
          )
        )
        OR (
          NEW.extension_reason = 'recovery'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries
            WHERE free_agent_draft_recoveries.league_id =
                NEW.league_id
              AND free_agent_draft_recoveries.season_id =
                NEW.season_id
              AND free_agent_draft_recoveries.fad_id = NEW.fad_id
              AND free_agent_draft_recoveries.id =
                NEW.extension_source_id
              AND free_agent_draft_recoveries.status <> 'resolved'
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rollover must be the next contiguous justified boundary'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_allocation_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status IN ('deadline_locked', 'allocating')
  AND NEW.status = 'rapid'
BEGIN
  SELECT CASE WHEN
    OLD.status = 'deadline_locked'
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.season_id =
          NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.id
    )
  THEN RAISE(
    ABORT,
    'FAD may bypass allocating only when no allocations exist'
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
        free_agent_draft_player_allocations.status = 'pending'
        OR free_agent_draft_player_allocations.updated_at_ms >
          NEW.allocation_completed_at_ms
        OR (
          SELECT COUNT(*)
          FROM free_agent_draft_allocation_events
          WHERE free_agent_draft_allocation_events.league_id =
              free_agent_draft_player_allocations.league_id
            AND free_agent_draft_allocation_events.season_id =
              free_agent_draft_player_allocations.season_id
            AND free_agent_draft_allocation_events.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND free_agent_draft_allocation_events.allocation_id =
              free_agent_draft_player_allocations.id
            AND free_agent_draft_allocation_events.player_id =
              free_agent_draft_player_allocations.player_id
            AND free_agent_draft_allocation_events.allocation_version =
              free_agent_draft_player_allocations.version
            AND free_agent_draft_allocation_events
              .resulting_allocation_status =
                free_agent_draft_player_allocations.status
            AND free_agent_draft_allocation_events.decision_code IS
              free_agent_draft_player_allocations.decision_code
            AND free_agent_draft_allocation_events.contract_id IS
              free_agent_draft_player_allocations.contract_id
            AND free_agent_draft_allocation_events.ownership_id IS
              free_agent_draft_player_allocations.ownership_id
            AND free_agent_draft_allocation_events.occurred_at_ms =
              free_agent_draft_player_allocations.updated_at_ms
            AND free_agent_draft_allocation_events.event_kind IN (
              'decision_recorded',
              'restricted_state_changed',
              'fallback_state_changed',
              'correction_applied'
            )
        ) <> 1
        OR EXISTS (
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
            AND candidate_card_snapshot_entries.occupant_kind =
              'candidate'
            AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_allocation_events
              WHERE free_agent_draft_allocation_events.league_id =
                  candidate_card_snapshot_entries.league_id
                AND free_agent_draft_allocation_events.season_id =
                  candidate_card_snapshot_entries.season_id
                AND free_agent_draft_allocation_events.fad_id =
                  candidate_card_snapshot_entries.fad_id
                AND free_agent_draft_allocation_events.allocation_id =
                  free_agent_draft_player_allocations.id
                AND free_agent_draft_allocation_events.player_id =
                  candidate_card_snapshot_entries.player_id
                AND free_agent_draft_allocation_events
                  .allocation_version =
                    free_agent_draft_player_allocations.version
                AND free_agent_draft_allocation_events.event_kind =
                  'offer_considered'
                AND free_agent_draft_allocation_events.snapshot_entry_id =
                  candidate_card_snapshot_entries.id
            )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires current evidence for every allocation and offer'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND NOT (
        (
          allocation.status = 'automatic_award'
          AND allocation.decision_code IN (
            'sole_valid_offer',
            'highest_total', 'highest_equal_total_aav', 'highest_aav', 'highest_equal_aav_term'
          )
        )
        OR (
          allocation.status IN (
            'restricted_scheduled',
            'restricted_active'
          )
          AND allocation.decision_code =
            'exact_total_and_term_tie'
        )
        OR (
          allocation.status = 'no_valid_offer'
          AND allocation.decision_code = 'no_valid_offer'
        )
        OR (
          allocation.status = 'invalid'
          AND allocation.decision_code IN (
            'invalid_snapshot',
            'candidate_card_structural_conflict',
            'candidate_card_over_cap'
          )
        )
        OR (
          allocation.status IN ('restricted_resolved', 'restricted_fallback_open', 'fallback_open_resolved')
          AND EXISTS (
            SELECT 1 FROM auction_resolutions AS resolution
            JOIN auctions AS auction
              ON auction.id = resolution.auction_id
             AND auction.league_id = resolution.league_id
             AND auction.season_id = resolution.season_id
            JOIN auction_contexts AS context
              ON context.auction_id = auction.id
             AND context.league_id = auction.league_id
             AND context.season_id = auction.season_id
            WHERE resolution.league_id = allocation.league_id
              AND resolution.season_id = allocation.season_id
              AND context.fad_id = allocation.fad_id
              AND context.fad_allocation_id = allocation.id
              AND auction.player_id = allocation.player_id
              AND (
                (auction.status = 'resolved' AND resolution.status = 'resolved'
                  AND resolution.outcome_code = 'winner')
                OR (auction.status = 'no_winner' AND resolution.status IN ('no_bids', 'no_winner')
                  AND resolution.outcome_code = 'no_winner')
              )
              AND resolution.contract_id IS allocation.contract_id
              AND resolution.ownership_id IS allocation.ownership_id
              AND resolution.winning_team_id IS allocation.winning_team_id
              AND (
                (allocation.status = 'restricted_resolved'
                  AND allocation.decision_code = 'restricted_auction_result'
                  AND resolution.outcome_code = 'winner'
                  AND auction.id = allocation.restricted_auction_id
                  AND context.source_kind = 'fad_restricted'
                  AND context.fad_origin = 'candidate_tie_restricted')
                OR (allocation.status = 'restricted_fallback_open'
                  AND allocation.decision_code = 'restricted_no_improvement_fallback'
                  AND resolution.outcome_code = 'no_winner'
                  AND auction.id = allocation.restricted_auction_id
                  AND context.source_kind = 'fad_restricted'
                  AND context.fad_origin = 'candidate_tie_restricted')
                OR (allocation.status = 'fallback_open_resolved'
                  AND allocation.decision_code = CASE
                    WHEN resolution.outcome_code = 'winner' THEN 'fallback_open_result'
                    WHEN resolution.outcome_code = 'no_winner' THEN 'fallback_open_no_winner'
                    ELSE NULL END
                  AND auction.id = allocation.fallback_open_auction_id
                  AND context.source_kind = 'fad_open_rapid'
                  AND context.fad_origin = 'restricted_no_improvement_fallback')
              )
          )
        )
        OR allocation.status = 'correction_required'
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires an approved accounted allocation state'
  ) END;

  WITH
    current_allocations AS (
      SELECT *
      FROM free_agent_draft_player_allocations
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
        AND fad_id = NEW.id
    ),
    valid_offers AS (
      SELECT
        current_allocations.id AS allocation_id,
        candidate_card_snapshot_entries.id AS snapshot_entry_id,
        candidate_card_snapshot_entries.team_id AS team_id,
        candidate_card_snapshot_entries.proposed_total_value_cents
          AS total_value_cents,
        candidate_card_snapshot_entries.proposed_term_years
          AS term_years,
        candidate_card_snapshot_entries.proposed_aav_cents
          AS aav_cents,
        CASE WHEN current_allocations.decision_code IN ('highest_total', 'highest_equal_total_aav')
          THEN candidate_card_snapshot_entries.proposed_total_value_cents
          ELSE candidate_card_snapshot_entries.proposed_aav_cents END AS rank_primary,
        CASE WHEN current_allocations.decision_code IN ('highest_total', 'highest_equal_total_aav')
          THEN candidate_card_snapshot_entries.proposed_aav_cents
          ELSE candidate_card_snapshot_entries.proposed_term_years END AS rank_secondary
      FROM current_allocations
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            current_allocations.league_id
       AND candidate_card_snapshot_entries.season_id =
            current_allocations.season_id
       AND candidate_card_snapshot_entries.fad_id =
            current_allocations.fad_id
       AND candidate_card_snapshot_entries.player_id =
            current_allocations.player_id
       AND candidate_card_snapshot_entries.row_kind = 'slot'
       AND candidate_card_snapshot_entries.occupant_kind =
            'candidate'
            AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
       AND candidate_card_snapshot_entries.eligibility_status
            IN ('valid', 'warning')
       AND candidate_card_snapshot_entries.allocation_eligibility =
            'eligible'
    ),
    maximum_totals AS (
      SELECT allocation_id, MAX(rank_primary) AS primary_value FROM valid_offers GROUP BY allocation_id
    ),
    top_total_offers AS (
      SELECT valid_offers.* FROM valid_offers JOIN maximum_totals
        ON maximum_totals.allocation_id = valid_offers.allocation_id
       AND maximum_totals.primary_value = valid_offers.rank_primary
    ),
    maximum_aavs AS (
      SELECT allocation_id, MAX(rank_secondary) AS secondary_value FROM top_total_offers GROUP BY allocation_id
    ),
    top_offers AS (
      SELECT top_total_offers.* FROM top_total_offers JOIN maximum_aavs
        ON maximum_aavs.allocation_id = top_total_offers.allocation_id
       AND maximum_aavs.secondary_value = top_total_offers.rank_secondary
    ),
    offer_counts AS (
      SELECT
        current_allocations.id AS allocation_id,
        COUNT(valid_offers.snapshot_entry_id) AS valid_count,
        COUNT(top_total_offers.snapshot_entry_id) AS top_total_count,
        COUNT(top_offers.snapshot_entry_id) AS top_count,
        COUNT(DISTINCT top_offers.term_years) AS top_term_count
      FROM current_allocations
      LEFT JOIN valid_offers
        ON valid_offers.allocation_id = current_allocations.id
      LEFT JOIN top_total_offers
        ON top_total_offers.allocation_id = current_allocations.id
       AND top_total_offers.snapshot_entry_id =
            valid_offers.snapshot_entry_id
      LEFT JOIN top_offers
        ON top_offers.allocation_id = current_allocations.id
       AND top_offers.snapshot_entry_id = valid_offers.snapshot_entry_id
      GROUP BY current_allocations.id
    ),
    event_counts AS (
      SELECT
        current_allocations.id AS allocation_id,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'winner'
        ), 0) AS winner_count,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'restricted_tied'
        ), 0) AS restricted_count
      FROM current_allocations
      LEFT JOIN free_agent_draft_allocation_events
        ON free_agent_draft_allocation_events.league_id =
            current_allocations.league_id
       AND free_agent_draft_allocation_events.season_id =
            current_allocations.season_id
       AND free_agent_draft_allocation_events.fad_id =
            current_allocations.fad_id
       AND free_agent_draft_allocation_events.allocation_id =
            current_allocations.id
       AND free_agent_draft_allocation_events.allocation_version =
            current_allocations.version
       AND free_agent_draft_allocation_events.event_kind =
            'offer_considered'
      GROUP BY current_allocations.id
    )
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM current_allocations
    JOIN offer_counts
      ON offer_counts.allocation_id = current_allocations.id
    JOIN event_counts
      ON event_counts.allocation_id = current_allocations.id
    WHERE (
      current_allocations.decision_code = 'sole_valid_offer'
      AND (
        offer_counts.valid_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code IN ('highest_total', 'highest_aav')
      AND (
        offer_counts.valid_count < 2
        OR offer_counts.top_total_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code IN ('highest_equal_total_aav', 'highest_equal_aav_term')
      AND (
        offer_counts.top_total_count < 2
        OR offer_counts.top_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code =
        'exact_total_and_term_tie'
      AND (
        offer_counts.top_count < 2
        OR offer_counts.top_term_count <> 1
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> offer_counts.top_count
      )
    )
    OR (
      current_allocations.decision_code = 'no_valid_offer'
      AND (
        offer_counts.valid_count <> 0
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code IN (
        'sole_valid_offer',
        'highest_total', 'highest_equal_total_aav', 'highest_aav', 'highest_equal_aav_term'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM top_offers
        JOIN free_agent_draft_allocation_events AS winner_event
          ON winner_event.league_id = current_allocations.league_id
         AND winner_event.season_id = current_allocations.season_id
         AND winner_event.fad_id = current_allocations.fad_id
         AND winner_event.allocation_id = current_allocations.id
         AND winner_event.allocation_version =
              current_allocations.version
         AND winner_event.player_id = current_allocations.player_id
         AND winner_event.event_kind = 'offer_considered'
         AND winner_event.snapshot_entry_id =
              top_offers.snapshot_entry_id
         AND winner_event.team_id = top_offers.team_id
         AND winner_event.offer_valid = 1
         AND winner_event.offer_outcome_code = 'winner'
        WHERE top_offers.allocation_id = current_allocations.id
          AND top_offers.snapshot_entry_id =
              current_allocations.winning_snapshot_entry_id
          AND top_offers.team_id = current_allocations.winning_team_id
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires deterministic ranking evidence for its recorded decision policy'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status IN (
        'restricted_scheduled',
        'restricted_active'
      )
      AND NOT (
        EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.season_id = auctions.season_id
           AND auction_contexts.auction_id = auctions.id
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auction_contexts.league_id
           AND free_agent_draft_rollovers.season_id =
                auction_contexts.season_id
           AND free_agent_draft_rollovers.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_rollovers.id =
                auction_contexts.fad_rollover_id
          JOIN free_agent_draft_draws
            ON free_agent_draft_draws.league_id =
                auction_contexts.league_id
           AND free_agent_draft_draws.season_id =
                auction_contexts.season_id
           AND free_agent_draft_draws.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_draws.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_draws.auction_id =
                auction_contexts.auction_id
          WHERE auctions.league_id = allocation.league_id
            AND auctions.season_id = allocation.season_id
            AND auctions.id = allocation.restricted_auction_id
            AND auctions.player_id = allocation.player_id
            AND auctions.status = 'open'
            AND auctions.resolves_at_ms =
              free_agent_draft_rollovers.rolls_over_at_ms
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = allocation.fad_id
            AND auction_contexts.fad_allocation_id = allocation.id
            AND auction_contexts.fad_origin =
              'candidate_tie_restricted'
            AND free_agent_draft_draws.created_at_ms =
              auctions.opened_at_ms
            AND free_agent_draft_draws.revealed_at_ms IS NULL
            AND free_agent_draft_draws.version = 1
        )
        AND (
          SELECT COUNT(*)
          FROM free_agent_draft_auction_participants
          WHERE free_agent_draft_auction_participants.league_id =
              allocation.league_id
            AND free_agent_draft_auction_participants.season_id =
              allocation.season_id
            AND free_agent_draft_auction_participants.fad_id =
              allocation.fad_id
            AND free_agent_draft_auction_participants.allocation_id =
              allocation.id
            AND free_agent_draft_auction_participants.auction_id =
              allocation.restricted_auction_id
            AND free_agent_draft_auction_participants.status = 'active'
            AND free_agent_draft_auction_participants
              .minimum_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND free_agent_draft_auction_participants
              .minimum_term_years =
                allocation.restricted_minimum_term_years
            AND free_agent_draft_auction_participants
              .minimum_aav_cents =
                allocation.restricted_minimum_aav_cents
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS eligible_offer
          WHERE eligible_offer.league_id = allocation.league_id
            AND eligible_offer.season_id = allocation.season_id
            AND eligible_offer.fad_id = allocation.fad_id
            AND eligible_offer.player_id = allocation.player_id
            AND eligible_offer.row_kind = 'slot'
            AND eligible_offer.occupant_kind = 'candidate'
            AND eligible_offer.proposed_total_value_cents IS NOT NULL
            AND eligible_offer.proposed_term_years IS NOT NULL
            AND eligible_offer.proposed_aav_cents IS NOT NULL
            AND eligible_offer.eligibility_status IN ('valid', 'warning')
            AND eligible_offer.allocation_eligibility = 'eligible'
            AND (
              eligible_offer.proposed_aav_cents > allocation.restricted_minimum_aav_cents
              OR (eligible_offer.proposed_aav_cents = allocation.restricted_minimum_aav_cents
                AND eligible_offer.proposed_term_years > allocation.restricted_minimum_term_years)
            )
        )
        AND (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS tied_offer
          WHERE tied_offer.league_id = allocation.league_id
            AND tied_offer.season_id = allocation.season_id
            AND tied_offer.fad_id = allocation.fad_id
            AND tied_offer.player_id = allocation.player_id
            AND tied_offer.row_kind = 'slot'
            AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
            AND tied_offer.eligibility_status IN ('valid', 'warning')
            AND tied_offer.allocation_eligibility = 'eligible'
            AND tied_offer.proposed_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND tied_offer.proposed_term_years =
                allocation.restricted_minimum_term_years
            AND tied_offer.proposed_aav_cents =
                allocation.restricted_minimum_aav_cents
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS tied_offer
          WHERE tied_offer.league_id = allocation.league_id
            AND tied_offer.season_id = allocation.season_id
            AND tied_offer.fad_id = allocation.fad_id
            AND tied_offer.player_id = allocation.player_id
            AND tied_offer.row_kind = 'slot'
            AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
            AND tied_offer.eligibility_status IN ('valid', 'warning')
            AND tied_offer.allocation_eligibility = 'eligible'
            AND tied_offer.proposed_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND tied_offer.proposed_aav_cents =
                allocation.restricted_minimum_aav_cents
            AND (
              tied_offer.proposed_term_years <>
                allocation.restricted_minimum_term_years
              OR NOT EXISTS (
                SELECT 1
                FROM free_agent_draft_auction_participants AS participant
                WHERE participant.league_id = allocation.league_id
                  AND participant.season_id = allocation.season_id
                  AND participant.fad_id = allocation.fad_id
                  AND participant.allocation_id = allocation.id
                  AND participant.auction_id =
                      allocation.restricted_auction_id
                  AND participant.team_id = tied_offer.team_id
                  AND participant.source_snapshot_entry_id = tied_offer.id
                  AND participant.status = 'active'
                  AND participant.minimum_total_value_cents =
                      allocation.restricted_minimum_total_cents
                  AND participant.minimum_term_years =
                      allocation.restricted_minimum_term_years
                  AND participant.minimum_aav_cents =
                      allocation.restricted_minimum_aav_cents
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_auction_participants AS participant
          WHERE participant.league_id = allocation.league_id
            AND participant.season_id = allocation.season_id
            AND participant.fad_id = allocation.fad_id
            AND participant.allocation_id = allocation.id
            AND participant.auction_id = allocation.restricted_auction_id
            AND participant.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries AS tied_offer
              WHERE tied_offer.league_id = participant.league_id
                AND tied_offer.season_id = participant.season_id
                AND tied_offer.fad_id = participant.fad_id
                AND tied_offer.id = participant.source_snapshot_entry_id
                AND tied_offer.player_id = allocation.player_id
                AND tied_offer.team_id = participant.team_id
                AND tied_offer.row_kind = 'slot'
                AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
                AND tied_offer.eligibility_status IN ('valid', 'warning')
                AND tied_offer.allocation_eligibility = 'eligible'
                AND tied_offer.proposed_total_value_cents =
                    allocation.restricted_minimum_total_cents
                AND tied_offer.proposed_term_years =
                    allocation.restricted_minimum_term_years
                AND tied_offer.proposed_aav_cents =
                    allocation.restricted_minimum_aav_cents
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = allocation.league_id
            AND auction_bids.auction_id =
              allocation.restricted_auction_id
        )
        AND (
          (
            allocation.status = 'restricted_active'
            AND NOT EXISTS (
              SELECT 1
              FROM job_runs
              WHERE job_runs.league_id = allocation.league_id
                AND job_runs.season_id = allocation.season_id
                AND job_runs.job_type = 'fad_restricted_activation'
                AND job_runs.occurrence_key LIKE
                  'fad:' || allocation.fad_id ||
                    ':restricted-activate:' || allocation.id || ':%'
            )
          )
          OR (
            allocation.status = 'restricted_scheduled'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN job_runs
                ON job_runs.league_id = auctions.league_id
               AND job_runs.season_id = auctions.season_id
               AND job_runs.job_type =
                    'fad_restricted_activation'
               AND job_runs.occurrence_key =
                    'fad:' || allocation.fad_id ||
                      ':restricted-activate:' || allocation.id ||
                      ':' || auctions.opened_at_ms
               AND job_runs.scheduled_for_ms =
                    auctions.opened_at_ms
              WHERE auctions.league_id = allocation.league_id
                AND auctions.id = allocation.restricted_auction_id
                AND job_runs.status = 'pending'
                AND job_runs.attempt_count = 0
                AND job_runs.lease_owner IS NULL
                AND job_runs.lease_token IS NULL
                AND job_runs.started_at_ms IS NULL
                AND job_runs.completed_at_ms IS NULL
            )
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires complete immediate or scheduled restricted resources'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status = 'correction_required'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            allocation.league_id
          AND free_agent_draft_recoveries.season_id =
            allocation.season_id
          AND free_agent_draft_recoveries.fad_id = allocation.fad_id
          AND free_agent_draft_recoveries.allocation_id = allocation.id
          AND free_agent_draft_recoveries.player_id =
            allocation.player_id
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code =
            allocation.last_error_code
          AND free_agent_draft_recoveries.created_at_ms =
            allocation.updated_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires correction-required allocation recovery'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_final_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND (
        allocation.status NOT IN (
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
        OR allocation.updated_at_ms > NEW.completed_at_ms
        OR (
          SELECT COUNT(*)
          FROM free_agent_draft_allocation_events
          WHERE free_agent_draft_allocation_events.league_id =
              allocation.league_id
            AND free_agent_draft_allocation_events.season_id =
              allocation.season_id
            AND free_agent_draft_allocation_events.fad_id =
              allocation.fad_id
            AND free_agent_draft_allocation_events.allocation_id =
              allocation.id
            AND free_agent_draft_allocation_events.player_id =
              allocation.player_id
            AND free_agent_draft_allocation_events.allocation_version =
              allocation.version
            AND free_agent_draft_allocation_events
              .resulting_allocation_status = allocation.status
            AND free_agent_draft_allocation_events.decision_code IS
              allocation.decision_code
            AND free_agent_draft_allocation_events.contract_id IS
              allocation.contract_id
            AND free_agent_draft_allocation_events.ownership_id IS
              allocation.ownership_id
            AND free_agent_draft_allocation_events.occurred_at_ms =
              allocation.updated_at_ms
            AND free_agent_draft_allocation_events.event_kind IN (
              'decision_recorded',
              'restricted_state_changed',
              'fallback_state_changed',
              'correction_applied'
            )
        ) <> 1
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires every allocation to be terminal and current'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.window_kind = 'initial'
  ) <> COALESCE(json_array_length(NEW.initial_rollover_times_json), 7) OR EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        free_agent_draft_rollovers.status <> 'completed'
        OR free_agent_draft_rollovers.completed_at_ms >
          NEW.completed_at_ms
      )
  ) OR (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
  ) <> (
    SELECT MAX(sequence)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD completion requires seven initial and every contiguous extension rollover'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_nomination_queue
    WHERE free_agent_draft_nomination_queue.league_id =
        NEW.league_id
      AND free_agent_draft_nomination_queue.season_id =
        NEW.season_id
      AND free_agent_draft_nomination_queue.fad_id = NEW.id
      AND free_agent_draft_nomination_queue.status = 'queued'
  ) OR EXISTS (
    SELECT 1
    FROM free_agent_draft_recoveries
    WHERE free_agent_draft_recoveries.league_id = NEW.league_id
      AND free_agent_draft_recoveries.season_id = NEW.season_id
      AND free_agent_draft_recoveries.fad_id = NEW.id
      AND free_agent_draft_recoveries.status <> 'resolved'
  ) THEN RAISE(
    ABORT,
    'FAD completion requires no queued work or unresolved recovery'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':deadline:' ||
          NEW.candidate_deadline_at_ms
      AND job_runs.scheduled_for_ms = NEW.candidate_deadline_at_ms
      AND job_runs.status IN ('succeeded', 'skipped')
      AND job_runs.attempt_count >= 1
      AND job_runs.completed_at_ms <= NEW.completed_at_ms
      AND job_runs.completed_at_ms = job_runs.updated_at_ms
      AND job_runs.lease_owner IS NULL
      AND job_runs.lease_token IS NULL
      AND job_runs.lease_expires_at_ms IS NULL
      AND job_runs.last_error_code IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD completion requires its terminal deadline occurrence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id = allocation.league_id
          AND job_runs.season_id = allocation.season_id
          AND job_runs.job_type = 'fad_allocation'
          AND job_runs.occurrence_key =
            'fad:' || allocation.fad_id || ':allocate:' ||
              allocation.player_id
          AND job_runs.scheduled_for_ms =
            NEW.candidate_deadline_at_ms
          AND job_runs.attempt_count >= 1
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.completed_at_ms = job_runs.updated_at_ms
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND (
            (
              job_runs.status IN ('succeeded', 'skipped')
              AND job_runs.last_error_code IS NULL
            )
            OR (
              job_runs.status = 'failed'
              AND job_runs.last_error_code IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries
                WHERE free_agent_draft_recoveries.league_id =
                    allocation.league_id
                  AND free_agent_draft_recoveries.season_id =
                    allocation.season_id
                  AND free_agent_draft_recoveries.fad_id =
                    allocation.fad_id
                  AND free_agent_draft_recoveries.allocation_id =
                    allocation.id
                  AND free_agent_draft_recoveries.player_id =
                    allocation.player_id
                  AND free_agent_draft_recoveries.job_run_id =
                    job_runs.id
                  AND free_agent_draft_recoveries.kind =
                    'allocation_retry'
                  AND free_agent_draft_recoveries.status = 'resolved'
                  AND free_agent_draft_recoveries.resolved_at_ms <=
                    NEW.completed_at_ms
              )
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires terminal allocation occurrences'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers AS rollover
    WHERE rollover.league_id = NEW.league_id
      AND rollover.season_id = NEW.season_id
      AND rollover.fad_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id = rollover.league_id
          AND job_runs.season_id = rollover.season_id
          AND job_runs.job_type = 'fad_rollover'
          AND job_runs.occurrence_key =
            'fad:' || rollover.fad_id || ':rollover:' ||
              rollover.sequence || ':' || rollover.rolls_over_at_ms
          AND job_runs.scheduled_for_ms = rollover.rolls_over_at_ms
          AND job_runs.attempt_count >= 1
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.completed_at_ms = job_runs.updated_at_ms
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND (
            (
              job_runs.status IN ('succeeded', 'skipped')
              AND job_runs.last_error_code IS NULL
            )
            OR (
              job_runs.status = 'failed'
              AND job_runs.last_error_code IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries
                WHERE free_agent_draft_recoveries.league_id =
                    rollover.league_id
                  AND free_agent_draft_recoveries.season_id =
                    rollover.season_id
                  AND free_agent_draft_recoveries.fad_id =
                    rollover.fad_id
                  AND free_agent_draft_recoveries.rollover_id =
                    rollover.id
                  AND free_agent_draft_recoveries.job_run_id =
                    job_runs.id
                  AND free_agent_draft_recoveries.kind =
                    'rollover_finalize'
                  AND free_agent_draft_recoveries.status = 'resolved'
                  AND free_agent_draft_recoveries.resolved_at_ms <=
                    NEW.completed_at_ms
              )
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires terminal rollover occurrences'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_completion'
      AND job_runs.occurrence_key = 'fad:' || NEW.id || ':complete'
      AND job_runs.scheduled_for_ms <= NEW.completed_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms > NEW.completed_at_ms
      AND job_runs.completed_at_ms IS NULL
      AND job_runs.last_error_code IS NULL
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD completion requires its exact durable occurrence'
  ) END;
END;

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
  AND NOT (EXISTS (SELECT 1 FROM fad_auction_cutoff_changes AS change
  JOIN fad_auction_cutoff_settings AS setting ON setting.id=change.fad_id AND setting.league_id=change.league_id AND setting.version=change.settings_version
  JOIN free_agent_drafts AS draft ON draft.id=change.fad_id AND draft.league_id=change.league_id
  JOIN json_each(change.before_rollovers_json) AS before
  JOIN json_each(change.after_rollovers_json) AS after ON before.key=after.key
  WHERE change.league_id=OLD.league_id AND change.fad_id=OLD.fad_id
    AND draft.status IN ('cards_open','rapid') AND OLD.status='scheduled' AND NEW.status='scheduled'
    AND OLD.id IS json_extract(before.value,'$.id')
      AND OLD.league_id IS json_extract(before.value,'$.league_id')
      AND OLD.season_id IS json_extract(before.value,'$.season_id')
      AND OLD.fad_id IS json_extract(before.value,'$.fad_id')
      AND OLD.sequence IS json_extract(before.value,'$.sequence')
      AND OLD.window_kind IS json_extract(before.value,'$.window_kind')
      AND OLD.predecessor_rollover_id IS json_extract(before.value,'$.predecessor_rollover_id')
      AND OLD.extension_reason IS json_extract(before.value,'$.extension_reason')
      AND OLD.extension_source_id IS json_extract(before.value,'$.extension_source_id')
      AND OLD.opens_at_ms IS json_extract(before.value,'$.opens_at_ms')
      AND OLD.creation_cutoff_at_ms IS json_extract(before.value,'$.creation_cutoff_at_ms')
      AND OLD.rolls_over_at_ms IS json_extract(before.value,'$.rolls_over_at_ms')
      AND OLD.status IS json_extract(before.value,'$.status')
      AND OLD.processing_job_run_id IS json_extract(before.value,'$.processing_job_run_id')
      AND OLD.processing_started_at_ms IS json_extract(before.value,'$.processing_started_at_ms')
      AND OLD.completed_at_ms IS json_extract(before.value,'$.completed_at_ms')
      AND OLD.last_error_code IS json_extract(before.value,'$.last_error_code')
      AND OLD.created_at_ms IS json_extract(before.value,'$.created_at_ms')
      AND OLD.updated_at_ms IS json_extract(before.value,'$.updated_at_ms')
      AND OLD.version IS json_extract(before.value,'$.version') AND NEW.id IS json_extract(after.value,'$.id')
      AND NEW.league_id IS json_extract(after.value,'$.league_id')
      AND NEW.season_id IS json_extract(after.value,'$.season_id')
      AND NEW.fad_id IS json_extract(after.value,'$.fad_id')
      AND NEW.sequence IS json_extract(after.value,'$.sequence')
      AND NEW.window_kind IS json_extract(after.value,'$.window_kind')
      AND NEW.predecessor_rollover_id IS json_extract(after.value,'$.predecessor_rollover_id')
      AND NEW.extension_reason IS json_extract(after.value,'$.extension_reason')
      AND NEW.extension_source_id IS json_extract(after.value,'$.extension_source_id')
      AND NEW.opens_at_ms IS json_extract(after.value,'$.opens_at_ms')
      AND NEW.creation_cutoff_at_ms IS json_extract(after.value,'$.creation_cutoff_at_ms')
      AND NEW.rolls_over_at_ms IS json_extract(after.value,'$.rolls_over_at_ms')
      AND NEW.status IS json_extract(after.value,'$.status')
      AND NEW.processing_job_run_id IS json_extract(after.value,'$.processing_job_run_id')
      AND NEW.processing_started_at_ms IS json_extract(after.value,'$.processing_started_at_ms')
      AND NEW.completed_at_ms IS json_extract(after.value,'$.completed_at_ms')
      AND NEW.last_error_code IS json_extract(after.value,'$.last_error_code')
      AND NEW.created_at_ms IS json_extract(after.value,'$.created_at_ms')
      AND NEW.updated_at_ms IS json_extract(after.value,'$.updated_at_ms')
      AND NEW.version IS json_extract(after.value,'$.version')
    AND NOT EXISTS (SELECT 1 FROM auction_contexts WHERE league_id=OLD.league_id AND fad_rollover_id=OLD.id)
    AND NOT EXISTS (SELECT 1 FROM free_agent_draft_nomination_queue WHERE league_id=OLD.league_id AND fad_id=OLD.fad_id
      AND OLD.id IN (source_rollover_id,target_opening_rollover_id,resolution_rollover_id))))
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

CREATE TRIGGER fad_auction_cutoff_changes_valid_insert BEFORE INSERT ON fad_auction_cutoff_changes
BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM free_agent_drafts f JOIN leagues l ON l.id=f.league_id
   WHERE f.league_id=NEW.league_id AND f.id=NEW.fad_id AND f.status IN ('cards_open','rapid') AND l.status='active' AND l.current_season_id=f.season_id)
   OR NEW.previous_settings_version<>COALESCE((SELECT version FROM fad_auction_cutoff_settings WHERE id=NEW.fad_id AND league_id=NEW.league_id),0)
   OR NEW.previous_gap_ms<>COALESCE((SELECT gap_ms FROM fad_auction_cutoff_settings WHERE id=NEW.fad_id AND league_id=NEW.league_id),(SELECT auction_creation_cutoff_minutes*60000 FROM free_agent_drafts WHERE id=NEW.fad_id AND league_id=NEW.league_id),3600000)
   OR json_array_length(NEW.before_rollovers_json)<>json_array_length(NEW.after_rollovers_json)
 THEN RAISE(ABORT,'FAD cutoff change requires current settings and an active draft') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.after_rollovers_json) AS after
   WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.before_rollovers_json) AS before WHERE before.key=after.key
     AND json_extract(before.value,'$.id') IS json_extract(after.value,'$.id')
     AND json_extract(before.value,'$.league_id') IS json_extract(after.value,'$.league_id')
     AND json_extract(before.value,'$.season_id') IS json_extract(after.value,'$.season_id')
     AND json_extract(before.value,'$.fad_id') IS json_extract(after.value,'$.fad_id')
     AND json_extract(before.value,'$.sequence') IS json_extract(after.value,'$.sequence')
     AND json_extract(before.value,'$.window_kind') IS json_extract(after.value,'$.window_kind')
     AND json_extract(before.value,'$.predecessor_rollover_id') IS json_extract(after.value,'$.predecessor_rollover_id')
     AND json_extract(before.value,'$.extension_reason') IS json_extract(after.value,'$.extension_reason')
     AND json_extract(before.value,'$.extension_source_id') IS json_extract(after.value,'$.extension_source_id')
     AND json_extract(before.value,'$.opens_at_ms') IS json_extract(after.value,'$.opens_at_ms')
     AND json_extract(before.value,'$.rolls_over_at_ms') IS json_extract(after.value,'$.rolls_over_at_ms')
     AND json_extract(before.value,'$.status') IS json_extract(after.value,'$.status')
     AND json_extract(before.value,'$.processing_job_run_id') IS json_extract(after.value,'$.processing_job_run_id')
     AND json_extract(before.value,'$.processing_started_at_ms') IS json_extract(after.value,'$.processing_started_at_ms')
     AND json_extract(before.value,'$.completed_at_ms') IS json_extract(after.value,'$.completed_at_ms')
     AND json_extract(before.value,'$.last_error_code') IS json_extract(after.value,'$.last_error_code')
     AND json_extract(before.value,'$.created_at_ms') IS json_extract(after.value,'$.created_at_ms')
     AND json_extract(after.value,'$.status')='scheduled'
     AND json_extract(after.value,'$.league_id')=NEW.league_id AND json_extract(after.value,'$.fad_id')=NEW.fad_id
     AND json_extract(after.value,'$.rolls_over_at_ms')>NEW.created_at_ms
     AND json_extract(after.value,'$.creation_cutoff_at_ms')=max(json_extract(after.value,'$.opens_at_ms'),json_extract(after.value,'$.rolls_over_at_ms')-NEW.gap_ms)
     AND json_extract(after.value,'$.version')=json_extract(before.value,'$.version')+1
     AND json_extract(after.value,'$.updated_at_ms')>=json_extract(before.value,'$.updated_at_ms')))
 THEN RAISE(ABORT,'FAD cutoff change may only update scheduled cutoffs') END;
END;
CREATE TRIGGER free_agent_draft_rollovers_configured_cutoff_insert BEFORE INSERT ON free_agent_draft_rollovers
WHEN NEW.creation_cutoff_at_ms<>max(NEW.opens_at_ms,NEW.rolls_over_at_ms-COALESCE(
 (SELECT gap_ms FROM fad_auction_cutoff_settings WHERE league_id=NEW.league_id AND id=NEW.fad_id),(SELECT auction_creation_cutoff_minutes*60000 FROM free_agent_drafts WHERE id=NEW.fad_id AND league_id=NEW.league_id),3600000))
BEGIN SELECT RAISE(ABORT,'New FAD rounds require the configured cutoff'); END;
UPDATE application_metadata SET metadata_value='70',updated_at_ms=max(updated_at_ms,70)
WHERE metadata_key='data_model_version' AND metadata_value='69';

-- Retain the released Goon guard while honoring an audited cutoff override.
CREATE TRIGGER free_agent_draft_rollovers_goon_cutoff_insert BEFORE INSERT ON free_agent_draft_rollovers
WHEN NEW.league_id='48e59cfb-b12d-4dfb-ae1a-4d8b3512ef03' BEGIN
 SELECT CASE WHEN NEW.creation_cutoff_at_ms IS NOT max(NEW.opens_at_ms, NEW.rolls_over_at_ms - COALESCE(
   (SELECT gap_ms FROM fad_auction_cutoff_settings WHERE league_id=NEW.league_id AND id=NEW.fad_id),
   (SELECT auction_creation_cutoff_minutes*60000 FROM free_agent_drafts WHERE league_id=NEW.league_id AND id=NEW.fad_id)))
 THEN RAISE(ABORT,'Goon rollover must match its configured nomination cutoff') END; END;
