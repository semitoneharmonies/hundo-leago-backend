-- Additive FAD-11 recovery and correction evidence boundary.
-- Schema 39 opens the first FAD-11 persistence boundary. It separates the
-- nomination-queue cause from the creating operation, preserves exact T-142
-- and T-144 replay evidence, permits attributable deterministic correction
-- of an already-terminal allocation, and makes recovered cancellation of a
-- failed open-rapid auction reachable without changing ordinary or restricted
-- auction rules.

DROP TRIGGER free_agent_draft_recoveries_valid_insert;
DROP TRIGGER free_agent_draft_recoveries_forward_update;
DROP TRIGGER free_agent_draft_nomination_queue_valid_insert;
DROP TRIGGER free_agent_draft_nomination_queue_forward_update;
DROP TRIGGER auction_bids_require_context_insert;
DROP TRIGGER free_agent_draft_allocation_events_valid_insert;
DROP TRIGGER free_agent_draft_allocation_events_immutable_update;

ALTER TABLE free_agent_draft_recoveries
  ADD COLUMN nomination_queue_id TEXT
    REFERENCES free_agent_draft_nomination_queue(id)
    ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_nomination_queue
  ADD COLUMN acceptance_idempotency_request_id TEXT
    REFERENCES idempotency_requests(id) ON DELETE RESTRICT
    CHECK (
      acceptance_idempotency_request_id IS NULL
      OR (
        length(acceptance_idempotency_request_id) = 36
        AND acceptance_idempotency_request_id =
          lower(acceptance_idempotency_request_id)
      )
    );

CREATE UNIQUE INDEX free_agent_draft_nomination_queue_acceptance_request
  ON free_agent_draft_nomination_queue (
    league_id,
    acceptance_idempotency_request_id
  )
  WHERE acceptance_idempotency_request_id IS NOT NULL;

UPDATE free_agent_draft_allocation_events
SET rank_position = NULL
WHERE event_kind = 'offer_considered'
  AND offer_valid = 0
  AND rank_position IS NOT NULL;

CREATE TRIGGER free_agent_draft_allocation_events_valid_insert
BEFORE INSERT ON free_agent_draft_allocation_events
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.created_at_ms >= NEW.occurred_at_ms
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.season_id =
          NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.fad_id
        AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
        AND free_agent_draft_player_allocations.player_id =
          NEW.player_id
        AND free_agent_draft_player_allocations.version =
          NEW.allocation_version
        AND free_agent_draft_player_allocations.status =
          NEW.resulting_allocation_status
    )
    AND (
      (
        NEW.event_kind = 'offer_considered'
        AND NEW.snapshot_entry_id IS NOT NULL
        AND NEW.team_id IS NOT NULL
        AND NEW.offer_valid IS NOT NULL
        AND (
          (
            NEW.offer_valid = 1
            AND NEW.rank_position IS NOT NULL
          )
          OR (
            NEW.offer_valid = 0
            AND NEW.rank_position IS NULL
          )
        )
        AND NEW.offer_outcome_code IS NOT NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.auction_id IS NULL
        AND NEW.correction_id IS NULL
      )
      OR (
        NEW.event_kind <> 'offer_considered'
        AND NEW.offer_valid IS NULL
        AND NEW.rank_position IS NULL
        AND NEW.offer_outcome_code IS NULL
      )
    )
    AND (
      NEW.actor_authority = 'system'
      OR EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = NEW.league_id
          AND league_memberships.id = NEW.actor_membership_id
          AND league_memberships.user_id = NEW.actor_user_id
      )
    )
    AND (
      NEW.event_kind <> 'correction_applied'
      OR (
        NEW.decision_code = 'corrected'
        AND NEW.correction_id IS NOT NULL
        AND NEW.actor_authority IN (
          'commissioner',
          'platform_administrator_as_commissioner'
        )
        AND NEW.snapshot_entry_id IS NULL
        AND NEW.team_id IS NULL
        AND NEW.activity_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations AS allocation
          JOIN commissioner_corrections
            ON commissioner_corrections.league_id = allocation.league_id
           AND commissioner_corrections.id = NEW.correction_id
           AND commissioner_corrections.season_id = allocation.season_id
           AND commissioner_corrections.feature =
                'free_agent_draft_allocation'
           AND commissioner_corrections.feature_record_id = allocation.id
           AND commissioner_corrections.actor_user_id = NEW.actor_user_id
           AND commissioner_corrections.corrected_at_ms =
                NEW.occurred_at_ms
          WHERE allocation.league_id = NEW.league_id
            AND allocation.season_id = NEW.season_id
            AND allocation.fad_id = NEW.fad_id
            AND allocation.id = NEW.allocation_id
            AND allocation.player_id = NEW.player_id
            AND allocation.version = NEW.allocation_version
            AND allocation.status = NEW.resulting_allocation_status
            AND allocation.decision_code = 'corrected'
            AND allocation.contract_id IS NEW.contract_id
            AND allocation.ownership_id IS NEW.ownership_id
            AND allocation.restricted_auction_id IS NEW.auction_id
            AND allocation.accounted_at_ms = NEW.occurred_at_ms
            AND allocation.last_error_code IS NULL
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'allocation event must match the exact resulting aggregate version'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocation_events_immutable_update
BEFORE UPDATE ON free_agent_draft_allocation_events
BEGIN
  SELECT RAISE(ABORT, 'allocation events are immutable');
END;

CREATE TABLE migration_0039_recovery_causality_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO migration_0039_recovery_causality_guard (valid)
SELECT CASE WHEN
  (
    recovery.kind <> 'queued_nomination_activation'
    OR EXISTS (
      SELECT 1
      FROM free_agent_draft_nomination_queue AS queue
      WHERE queue.league_id = recovery.league_id
        AND queue.season_id = recovery.season_id
        AND queue.fad_id = recovery.fad_id
        AND queue.id = recovery.created_by_operation_id
        AND queue.player_id = recovery.player_id
        AND queue.target_opening_rollover_id = recovery.rollover_id
    )
  )
  AND (
    recovery.job_run_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM job_runs AS job
      WHERE job.league_id = recovery.league_id
        AND job.season_id = recovery.season_id
        AND job.id = recovery.job_run_id
    )
  )
THEN 1 ELSE 0 END
FROM free_agent_draft_recoveries AS recovery;

DROP TABLE migration_0039_recovery_causality_guard;

UPDATE free_agent_draft_recoveries
SET
  nomination_queue_id = CASE
    WHEN kind = 'queued_nomination_activation'
    THEN created_by_operation_id
    ELSE NULL
  END,
  created_by_operation_id = CASE
    WHEN job_run_id IS NOT NULL THEN job_run_id
    WHEN kind <> 'queued_nomination_activation'
      AND length(created_by_operation_id) = 36
      AND created_by_operation_id = lower(created_by_operation_id)
    THEN created_by_operation_id
    ELSE NULL
  END;

CREATE INDEX free_agent_draft_recoveries_nomination_queue
  ON free_agent_draft_recoveries (
    league_id,
    nomination_queue_id,
    status
  )
  WHERE nomination_queue_id IS NOT NULL;

CREATE TABLE free_agent_draft_recovery_action_command_results (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  recovery_id TEXT NOT NULL,
  idempotency_request_id TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (
      action IN (
        'retry_deadline',
        'retry_allocation',
        'activate_restricted',
        'activate_queued_nomination',
        'activate_fallback',
        'retry_auction_resolution',
        'finalize_rollover',
        'complete_fad'
      )
    ),
  resource_kind TEXT NOT NULL
    CHECK (
      resource_kind IN (
        'fad',
        'allocation',
        'nomination_queue',
        'auction',
        'rollover'
      )
    ),
  resource_id TEXT NOT NULL
    CHECK (length(resource_id) = 36 AND resource_id = lower(resource_id)),
  operation_id TEXT NOT NULL
    CHECK (length(operation_id) = 36 AND operation_id = lower(operation_id)),
  job_run_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL
    CHECK (
      occurrence_key = trim(occurrence_key)
      AND length(occurrence_key) BETWEEN 1 AND 500
    ),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  commissioner_reason TEXT NOT NULL
    CHECK (
      commissioner_reason = trim(commissioner_reason)
      AND length(commissioner_reason) BETWEEN 1 AND 500
    ),
  request_json TEXT NOT NULL
    CHECK (
      json_valid(request_json) = 1
      AND json_type(request_json) = 'object'
      AND json(request_json) = request_json
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_status TEXT NOT NULL
    CHECK (accepted_status IN ('pending', 'already_succeeded')),
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
  response_http_status INTEGER NOT NULL CHECK (response_http_status = 202),
  response_json TEXT NOT NULL
    CHECK (
      json_valid(response_json) = 1
      AND json_type(response_json) = 'object'
      AND json(response_json) = response_json
    ),
  response_sha256 TEXT NOT NULL
    CHECK (
      length(response_sha256) = 64
      AND response_sha256 = lower(response_sha256)
      AND response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, idempotency_request_id),
  UNIQUE (league_id, recovery_id, id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id, fad_id, recovery_id)
    REFERENCES free_agent_draft_recoveries(
      league_id,
      season_id,
      fad_id,
      id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (operation_id = job_run_id)
) STRICT;

CREATE INDEX free_agent_draft_recovery_action_results_recovery
  ON free_agent_draft_recovery_action_command_results (
    league_id,
    fad_id,
    recovery_id,
    accepted_at_ms,
    id
  );

CREATE TABLE free_agent_draft_allocation_correction_command_results (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  idempotency_request_id TEXT NOT NULL,
  commissioner_correction_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  accepted_from_allocation_version INTEGER NOT NULL
    CHECK (accepted_from_allocation_version >= 1),
  resulting_allocation_version INTEGER NOT NULL
    CHECK (resulting_allocation_version >= 2),
  preview_json TEXT NOT NULL
    CHECK (
      json_valid(preview_json) = 1
      AND json_type(preview_json) = 'object'
      AND json(preview_json) = preview_json
    ),
  preview_fingerprint TEXT NOT NULL
    CHECK (
      length(preview_fingerprint) = 64
      AND preview_fingerprint = lower(preview_fingerprint)
      AND preview_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  request_json TEXT NOT NULL
    CHECK (
      json_valid(request_json) = 1
      AND json_type(request_json) = 'object'
      AND json(request_json) = request_json
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  response_http_status INTEGER NOT NULL CHECK (response_http_status = 200),
  response_json TEXT NOT NULL
    CHECK (
      json_valid(response_json) = 1
      AND json_type(response_json) = 'object'
      AND json(response_json) = response_json
    ),
  response_sha256 TEXT NOT NULL
    CHECK (
      length(response_sha256) = 64
      AND response_sha256 = lower(response_sha256)
      AND response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, idempotency_request_id),
  UNIQUE (league_id, commissioner_correction_id),
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    player_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id,
    player_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, commissioner_correction_id)
    REFERENCES commissioner_corrections(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, activity_id)
    REFERENCES league_activity(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    resulting_allocation_version =
      accepted_from_allocation_version + 1
  )
) STRICT;

CREATE INDEX free_agent_draft_allocation_correction_results_allocation
  ON free_agent_draft_allocation_correction_command_results (
    league_id,
    fad_id,
    allocation_id,
    completed_at_ms,
    id
  );

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

CREATE TRIGGER free_agent_draft_recovery_action_results_valid_insert
BEFORE INSERT ON free_agent_draft_recovery_action_command_results
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.operation_id = NEW.job_run_id
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests AS request
      WHERE request.league_id = NEW.league_id
        AND request.id = NEW.idempotency_request_id
        AND request.actor_user_id = NEW.actor_user_id
        AND request.operation =
          'free_agent_draft.recovery.action'
        AND request.request_hash = NEW.request_sha256
        AND request.status = 'started'
        AND request.result_type IS NULL
        AND request.result_id IS NULL
        AND request.completed_at_ms IS NULL
        AND request.created_at_ms = NEW.accepted_at_ms
        AND request.expires_at_ms > NEW.accepted_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships AS membership
      JOIN users AS actor
        ON actor.id = membership.user_id
      WHERE membership.league_id = NEW.league_id
        AND membership.id = NEW.actor_membership_id
        AND membership.user_id = NEW.actor_user_id
        AND membership.status = 'active'
        AND actor.status = 'active'
        AND (
          (
            NEW.actor_authority = 'commissioner'
            AND EXISTS (
              SELECT 1
              FROM leagues AS league
              WHERE league.id = NEW.league_id
                AND league.commissioner_membership_id =
                  NEW.actor_membership_id
            )
          )
          OR (
            NEW.actor_authority =
              'platform_administrator_as_commissioner'
            AND EXISTS (
              SELECT 1
              FROM platform_roles AS role
              WHERE role.user_id = NEW.actor_user_id
                AND role.role = 'platform_administrator'
                AND role.status = 'active'
            )
          )
        )
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_recoveries AS recovery
      JOIN job_runs AS job
        ON job.league_id = recovery.league_id
       AND job.season_id = recovery.season_id
       AND job.id = recovery.job_run_id
      WHERE recovery.league_id = NEW.league_id
        AND recovery.season_id = NEW.season_id
        AND recovery.fad_id = NEW.fad_id
        AND recovery.id = NEW.recovery_id
        AND recovery.job_run_id = NEW.job_run_id
        AND recovery.created_by_operation_id = NEW.operation_id
        AND job.occurrence_key = NEW.occurrence_key
        AND job.updated_at_ms <= NEW.accepted_at_ms
        AND (
          (
            NEW.accepted_status = 'pending'
            AND job.status IN ('pending', 'leased', 'running')
            AND recovery.status IN ('pending', 'ready', 'running')
          )
          OR (
            NEW.accepted_status = 'already_succeeded'
            AND job.status = 'succeeded'
            AND recovery.status = 'resolved'
          )
        )
        AND (
          (NEW.action = 'retry_deadline'
            AND recovery.kind = 'deadline_retry'
            AND NEW.resource_kind = 'fad'
            AND NEW.resource_id = NEW.fad_id)
          OR (NEW.action = 'retry_allocation'
            AND recovery.kind = 'allocation_retry'
            AND NEW.resource_kind = 'allocation'
            AND NEW.resource_id = recovery.allocation_id)
          OR (NEW.action = 'activate_restricted'
            AND recovery.kind = 'restricted_activation'
            AND NEW.resource_kind = 'allocation'
            AND NEW.resource_id = recovery.allocation_id)
          OR (NEW.action = 'activate_queued_nomination'
            AND recovery.kind = 'queued_nomination_activation'
            AND NEW.resource_kind = 'nomination_queue'
            AND NEW.resource_id = recovery.nomination_queue_id)
          OR (NEW.action = 'activate_fallback'
            AND recovery.kind = 'fallback_activation'
            AND NEW.resource_kind = 'allocation'
            AND NEW.resource_id = recovery.allocation_id)
          OR (NEW.action = 'retry_auction_resolution'
            AND recovery.kind = 'auction_resolution'
            AND NEW.resource_kind = 'auction'
            AND NEW.resource_id = recovery.auction_id)
          OR (NEW.action = 'finalize_rollover'
            AND recovery.kind = 'rollover_finalize'
            AND NEW.resource_kind = 'rollover'
            AND NEW.resource_id = recovery.rollover_id)
          OR (NEW.action = 'complete_fad'
            AND recovery.kind = 'completion'
            AND NEW.resource_kind = 'fad'
            AND NEW.resource_id = NEW.fad_id)
        )
    )
    AND NEW.request_json = json_object(
      'body', json_object(
        'action', NEW.action,
        'reason', NEW.commissioner_reason,
        'resourceId', CASE
          WHEN NEW.resource_kind = 'fad' THEN NULL
          ELSE NEW.resource_id
        END
      ),
      'domain',
        'hundo-leago.free-agent-draft-recovery-action-request',
      'fadId', NEW.fad_id,
      'leagueId', NEW.league_id,
      'schemaVersion', 1
    )
    AND NEW.response_json = json_object(
      'acceptedAtMs', NEW.accepted_at_ms,
      'action', NEW.action,
      'occurrenceKey', NEW.occurrence_key,
      'operationId', NEW.operation_id,
      'pollDescriptor', json_object(
        'fadId', NEW.fad_id,
        'kind', 'fad_recovery',
        'leagueId', NEW.league_id
      ),
      'resourceId', CASE
        WHEN NEW.resource_kind = 'fad' THEN NULL
        ELSE NEW.resource_id
      END,
      'status', NEW.accepted_status
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery action result must bind its exact request, authority, resource, operation, job, recovery, and response'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recovery_action_results_immutable_update
BEFORE UPDATE ON free_agent_draft_recovery_action_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD recovery action command results are immutable'
  );
END;

CREATE TRIGGER free_agent_draft_recovery_action_results_immutable_delete
BEFORE DELETE ON free_agent_draft_recovery_action_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD recovery action command results are immutable'
  );
END;

CREATE TRIGGER idempotency_requests_fad_recovery_action_complete
BEFORE UPDATE ON idempotency_requests
WHEN (
  OLD.operation = 'free_agent_draft.recovery.action'
  AND NEW.status = 'completed'
)
OR NEW.result_type =
  'free_agent_draft_recovery_action_command_result'
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_recovery_action_command_results AS result
  WHERE result.league_id = OLD.league_id
    AND result.idempotency_request_id = OLD.id
)
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.status = 'completed'
    AND NEW.result_type =
      'free_agent_draft_recovery_action_command_result'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_recovery_action_command_results AS result
      WHERE result.league_id = NEW.league_id
        AND result.id = NEW.result_id
        AND result.idempotency_request_id = NEW.id
        AND result.actor_user_id = NEW.actor_user_id
        AND result.request_sha256 = NEW.request_hash
        AND result.accepted_at_ms = NEW.completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery action request must complete against its exact immutable result'
  ) END;
END;

CREATE TRIGGER idempotency_requests_fad_recovery_action_completed_immutable
BEFORE UPDATE ON idempotency_requests
WHEN OLD.status = 'completed'
  AND (
    OLD.result_type =
      'free_agent_draft_recovery_action_command_result'
    OR EXISTS (
      SELECT 1
      FROM free_agent_draft_recovery_action_command_results AS result
      WHERE result.league_id = OLD.league_id
        AND result.idempotency_request_id = OLD.id
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'completed FAD recovery action request evidence is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_fad_recovery_action_result_delete
BEFORE DELETE ON idempotency_requests
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_recovery_action_command_results AS result
  WHERE result.league_id = OLD.league_id
    AND result.idempotency_request_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD recovery action result request evidence is immutable'
  );
END;

CREATE TRIGGER free_agent_draft_allocation_correction_results_valid_insert
BEFORE INSERT ON free_agent_draft_allocation_correction_command_results
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.resulting_allocation_version =
      NEW.accepted_from_allocation_version + 1
    AND json_type(NEW.request_json, '$.reason') = 'text'
    AND json_extract(NEW.request_json, '$.reason') =
      trim(json_extract(NEW.request_json, '$.reason'))
    AND length(json_extract(NEW.request_json, '$.reason'))
      BETWEEN 1 AND 500
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests AS request
      WHERE request.league_id = NEW.league_id
        AND request.id = NEW.idempotency_request_id
        AND request.actor_user_id = NEW.actor_user_id
        AND request.operation =
          'free_agent_draft.allocation.correction'
        AND request.request_hash = NEW.request_sha256
        AND request.status = 'started'
        AND request.result_type IS NULL
        AND request.result_id IS NULL
        AND request.completed_at_ms IS NULL
        AND request.created_at_ms = NEW.completed_at_ms
        AND request.expires_at_ms > NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships AS membership
      JOIN users AS actor
        ON actor.id = membership.user_id
      WHERE membership.league_id = NEW.league_id
        AND membership.id = NEW.actor_membership_id
        AND membership.user_id = NEW.actor_user_id
        AND membership.status = 'active'
        AND actor.status = 'active'
        AND (
          (
            NEW.actor_authority = 'commissioner'
            AND EXISTS (
              SELECT 1
              FROM leagues AS league
              WHERE league.id = NEW.league_id
                AND league.commissioner_membership_id =
                  NEW.actor_membership_id
            )
          )
          OR (
            NEW.actor_authority =
              'platform_administrator_as_commissioner'
            AND EXISTS (
              SELECT 1
              FROM platform_roles AS role
              WHERE role.user_id = NEW.actor_user_id
                AND role.role = 'platform_administrator'
                AND role.status = 'active'
            )
          )
        )
    )
    AND EXISTS (
      SELECT 1
      FROM commissioner_corrections AS correction
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = correction.league_id
       AND allocation.season_id = correction.season_id
       AND allocation.id = correction.feature_record_id
      JOIN free_agent_draft_allocation_events AS correction_event
        ON correction_event.league_id = allocation.league_id
       AND correction_event.season_id = allocation.season_id
       AND correction_event.fad_id = allocation.fad_id
       AND correction_event.allocation_id = allocation.id
       AND correction_event.allocation_version = allocation.version
       AND correction_event.player_id = allocation.player_id
       AND correction_event.correction_id = correction.id
      WHERE correction.league_id = NEW.league_id
        AND correction.season_id = NEW.season_id
        AND correction.id = NEW.commissioner_correction_id
        AND correction.feature = 'free_agent_draft_allocation'
        AND correction.feature_record_id = NEW.allocation_id
        AND correction.actor_user_id = NEW.actor_user_id
        AND correction.reason =
          json_extract(NEW.request_json, '$.reason')
        AND correction.corrected_at_ms = NEW.completed_at_ms
        AND json_valid(correction.before_snapshot_json) = 1
        AND json_valid(correction.after_snapshot_json) = 1
        AND json_extract(
              correction.before_snapshot_json,
              '$.version'
            ) = NEW.accepted_from_allocation_version
        AND json_extract(
              correction.after_snapshot_json,
              '$.version'
            ) = NEW.resulting_allocation_version
        AND json_extract(
              correction.after_snapshot_json,
              '$.decisionCode'
            ) = 'corrected'
        AND allocation.fad_id = NEW.fad_id
        AND allocation.player_id = NEW.player_id
        AND allocation.version = NEW.resulting_allocation_version
        AND allocation.decision_code = 'corrected'
        AND allocation.updated_at_ms = NEW.completed_at_ms
        AND allocation.accounted_at_ms = NEW.completed_at_ms
        AND allocation.last_error_code IS NULL
        AND correction_event.event_kind = 'correction_applied'
        AND correction_event.decision_code = 'corrected'
        AND correction_event.resulting_allocation_status =
          allocation.status
        AND correction_event.contract_id IS allocation.contract_id
        AND correction_event.ownership_id IS allocation.ownership_id
        AND correction_event.actor_user_id = NEW.actor_user_id
        AND correction_event.actor_membership_id =
          NEW.actor_membership_id
        AND correction_event.actor_authority = NEW.actor_authority
        AND correction_event.activity_id IS NULL
        AND correction_event.occurred_at_ms = NEW.completed_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM league_activity AS activity
      WHERE activity.league_id = NEW.league_id
        AND activity.season_id = NEW.season_id
        AND activity.id = NEW.activity_id
        AND activity.actor_user_id = NEW.actor_user_id
        AND activity.actor_authority = NEW.actor_authority
        AND activity.player_id = NEW.player_id
        AND activity.related_type =
          'free_agent_draft_allocation'
        AND activity.related_id = NEW.allocation_id
        AND activity.occurred_at_ms = NEW.completed_at_ms
    )
    AND json_extract(NEW.preview_json, '$.allocationId') =
      NEW.allocation_id
    AND json_extract(NEW.preview_json, '$.allocationVersion') =
      NEW.accepted_from_allocation_version
    AND json_extract(NEW.preview_json, '$.reversible') = 1
    AND json_extract(NEW.preview_json, '$.confirmationText') =
      'APPLY FAD CORRECTION'
    AND NEW.request_json = json_object(
      'allocationId', NEW.allocation_id,
      'confirmation', 'APPLY FAD CORRECTION',
      'domain', 'hundo-leago.fad-allocation-correction-request',
      'fadId', NEW.fad_id,
      'leagueId', NEW.league_id,
      'mode', 'recompute_locked_snapshot',
      'previewFingerprint', NEW.preview_fingerprint,
      'reason', json_extract(NEW.request_json, '$.reason'),
      'schemaVersion', 1
    )
    AND (
      SELECT COUNT(*)
      FROM json_each(NEW.response_json)
    ) = 5
    AND json_extract(NEW.response_json, '$.activityId') =
      NEW.activity_id
    AND json_extract(
          NEW.response_json,
          '$.allocation.allocationId'
        ) = NEW.allocation_id
    AND json_extract(
          NEW.response_json,
          '$.allocation.allocationVersion'
        ) = NEW.resulting_allocation_version
    AND json_type(NEW.response_json, '$.appliedDeltas') = 'array'
    AND json_extract(NEW.response_json, '$.completedAtMs') =
      NEW.completed_at_ms
    AND json_extract(NEW.response_json, '$.correctionId') =
      NEW.commissioner_correction_id
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_recoveries AS recovery
      WHERE recovery.league_id = NEW.league_id
        AND recovery.season_id = NEW.season_id
        AND recovery.fad_id = NEW.fad_id
        AND recovery.allocation_id = NEW.allocation_id
        AND recovery.status <> 'resolved'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations AS allocation
      JOIN auctions AS auction
        ON auction.league_id = allocation.league_id
       AND auction.id IN (
            allocation.restricted_auction_id,
            allocation.fallback_open_auction_id
          )
      WHERE allocation.league_id = NEW.league_id
        AND allocation.season_id = NEW.season_id
        AND allocation.fad_id = NEW.fad_id
        AND allocation.id = NEW.allocation_id
        AND auction.status IN ('open', 'resolving', 'failed')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        NEW.response_json,
        '$.appliedDeltas'
      ) AS delta
      WHERE json_extract(delta.value, '$.resourceType') =
          'auction'
        AND json_extract(delta.value, '$.action') = 'cancel'
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations AS allocation
          JOIN auctions AS auction
            ON auction.league_id = allocation.league_id
           AND auction.id = json_extract(
                delta.value,
                '$.resourceId'
              )
           AND auction.id IN (
                allocation.restricted_auction_id,
                allocation.fallback_open_auction_id
              )
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
          JOIN auction_events AS event
            ON event.league_id = auction.league_id
           AND event.season_id = auction.season_id
           AND event.auction_id = auction.id
          WHERE allocation.league_id = NEW.league_id
            AND allocation.season_id = NEW.season_id
            AND allocation.fad_id = NEW.fad_id
            AND allocation.id = NEW.allocation_id
            AND auction.status = 'cancelled'
            AND auction.updated_at_ms = NEW.completed_at_ms
            AND auction.version > json_extract(
                  delta.value,
                  '$.beforeVersion'
                )
            AND json_extract(
                  delta.value,
                  '$.afterSummary.status'
                ) = 'cancelled'
            AND json_extract(
                  delta.value,
                  '$.afterSummary.auctionId'
                ) = auction.id
            AND resolution.status = 'cancelled'
            AND resolution.outcome_code = 'recovered'
            AND resolution.trigger_type = 'commissioner'
            AND resolution.triggered_by_user_id = NEW.actor_user_id
            AND resolution.resolved_at_ms = NEW.completed_at_ms
            AND draw.version = 2
            AND draw.revealed_at_ms = NEW.completed_at_ms
            AND draw.ordered_tied_bid_ids_json = '[]'
            AND draw.ordered_tied_team_ids_json = '[]'
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND event.event_type = 'auction_cancelled'
            AND event.actor_user_id = NEW.actor_user_id
            AND event.occurred_at_ms = NEW.completed_at_ms
            AND json_extract(
                  event.metadata_json,
                  '$.actorAuthority'
                ) = NEW.actor_authority
            AND json_extract(
                  event.metadata_json,
                  '$.correctionId'
                ) = NEW.commissioner_correction_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations AS allocation
      JOIN auctions AS auction
        ON auction.league_id = allocation.league_id
       AND auction.id IN (
            allocation.restricted_auction_id,
            allocation.fallback_open_auction_id
          )
      JOIN auction_resolutions AS resolution
        ON resolution.league_id = auction.league_id
       AND resolution.season_id = auction.season_id
       AND resolution.auction_id = auction.id
      WHERE allocation.league_id = NEW.league_id
        AND allocation.season_id = NEW.season_id
        AND allocation.fad_id = NEW.fad_id
        AND allocation.id = NEW.allocation_id
        AND auction.status = 'cancelled'
        AND auction.updated_at_ms = NEW.completed_at_ms
        AND resolution.status = 'cancelled'
        AND resolution.outcome_code = 'recovered'
        AND resolution.resolved_at_ms = NEW.completed_at_ms
        AND (
          SELECT COUNT(*)
          FROM json_each(
            NEW.response_json,
            '$.appliedDeltas'
          ) AS delta
          WHERE json_extract(
                  delta.value,
                  '$.resourceType'
                ) = 'auction'
            AND json_extract(delta.value, '$.action') = 'cancel'
            AND json_extract(
                  delta.value,
                  '$.resourceId'
                ) = auction.id
        ) <> 1
    )
  ) THEN RAISE(
    ABORT,
    'FAD allocation correction result must bind its exact request, preview, authority, correction, event, activity, allocation version, and response'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocation_correction_results_immutable_update
BEFORE UPDATE ON free_agent_draft_allocation_correction_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD allocation correction command results are immutable'
  );
END;

CREATE TRIGGER free_agent_draft_allocation_correction_results_immutable_delete
BEFORE DELETE ON free_agent_draft_allocation_correction_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD allocation correction command results are immutable'
  );
END;

CREATE TRIGGER commissioner_corrections_fad_allocation_immutable_update
BEFORE UPDATE ON commissioner_corrections
WHEN OLD.feature = 'free_agent_draft_allocation'
  OR NEW.feature = 'free_agent_draft_allocation'
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD allocation correction evidence is immutable'
  );
END;

CREATE TRIGGER commissioner_corrections_fad_allocation_immutable_delete
BEFORE DELETE ON commissioner_corrections
WHEN OLD.feature = 'free_agent_draft_allocation'
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD allocation correction evidence is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_fad_allocation_correction_complete
BEFORE UPDATE ON idempotency_requests
WHEN (
  OLD.operation = 'free_agent_draft.allocation.correction'
  AND NEW.status = 'completed'
)
OR NEW.result_type =
  'free_agent_draft_allocation_correction_command_result'
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_allocation_correction_command_results AS result
  WHERE result.league_id = OLD.league_id
    AND result.idempotency_request_id = OLD.id
)
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.status = 'completed'
    AND NEW.result_type =
      'free_agent_draft_allocation_correction_command_result'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_allocation_correction_command_results AS result
      WHERE result.league_id = NEW.league_id
        AND result.id = NEW.result_id
        AND result.idempotency_request_id = NEW.id
        AND result.actor_user_id = NEW.actor_user_id
        AND result.request_sha256 = NEW.request_hash
        AND result.completed_at_ms = NEW.completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'FAD allocation correction request must complete against its exact immutable result'
  ) END;
END;

CREATE TRIGGER idempotency_requests_fad_allocation_correction_completed_immutable
BEFORE UPDATE ON idempotency_requests
WHEN OLD.status = 'completed'
  AND (
    OLD.result_type =
      'free_agent_draft_allocation_correction_command_result'
    OR EXISTS (
      SELECT 1
      FROM free_agent_draft_allocation_correction_command_results AS result
      WHERE result.league_id = OLD.league_id
        AND result.idempotency_request_id = OLD.id
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'completed FAD allocation correction request evidence is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_fad_allocation_correction_result_delete
BEFORE DELETE ON idempotency_requests
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_allocation_correction_command_results AS result
  WHERE result.league_id = OLD.league_id
    AND result.idempotency_request_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD allocation correction result request evidence is immutable'
  );
END;

DROP TRIGGER free_agent_draft_allocations_forward_update;

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
          'highest_equal_total_aav'
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

DROP TRIGGER auctions_require_context_update;

CREATE TRIGGER auctions_require_context_update
BEFORE UPDATE ON auctions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'auction state transition requires its persisted context'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
  ) AND NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.opened_at_ms IS OLD.opened_at_ms
    AND NEW.resolves_at_ms IS OLD.resolves_at_ms
    AND NEW.opened_by_user_id IS OLD.opened_by_user_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND OLD.status NOT IN (
      'resolved',
      'no_winner',
      'cancelled'
    )
  ) THEN RAISE(
    ABORT,
    'FAD auction identity and terminal history are immutable'
  ) END;

  SELECT CASE WHEN
    NEW.status IN ('resolved', 'no_winner', 'cancelled')
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      (
        NEW.status = 'cancelled'
        AND EXISTS (
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
          JOIN free_agent_draft_recoveries
            ON free_agent_draft_recoveries.league_id =
                auction_contexts.league_id
           AND free_agent_draft_recoveries.season_id =
                auction_contexts.season_id
           AND free_agent_draft_recoveries.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_recoveries.player_id =
                NEW.player_id
           AND free_agent_draft_recoveries.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_recoveries.rollover_id =
                auction_contexts.fad_rollover_id
           AND free_agent_draft_recoveries.auction_id =
                auction_contexts.auction_id
          WHERE auction_contexts.league_id = NEW.league_id
            AND auction_contexts.season_id = NEW.season_id
            AND auction_contexts.auction_id = NEW.id
            AND auction_contexts.source_kind =
              'fad_restricted'
            AND free_agent_draft_player_allocations.status =
              'correction_required'
            AND free_agent_draft_player_allocations
              .restricted_auction_id = NEW.id
            AND free_agent_draft_player_allocations
              .updated_at_ms = NEW.updated_at_ms
            AND free_agent_draft_draws.revealed_at_ms IS NULL
            AND free_agent_draft_draws.version = 1
            AND free_agent_draft_recoveries.kind =
              'auction_resolution'
            AND free_agent_draft_recoveries.status =
              'correction_required'
            AND free_agent_draft_recoveries.last_error_code
              IS NOT NULL
            AND free_agent_draft_recoveries.created_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_recoveries.updated_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_recoveries.resolved_at_ms IS NULL
            AND free_agent_draft_recoveries
              .resolved_by_user_id IS NULL
            AND free_agent_draft_recoveries
              .resolved_by_membership_id IS NULL
            AND free_agent_draft_recoveries
              .resolved_authority IS NULL
        )
      )
      OR (
        NEW.status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM auction_contexts AS context
          JOIN free_agent_draft_player_allocations AS allocation
            ON allocation.league_id = context.league_id
           AND allocation.season_id = context.season_id
           AND allocation.fad_id = context.fad_id
           AND allocation.id = context.fad_allocation_id
           AND allocation.player_id = NEW.player_id
          JOIN auction_resolutions AS resolution
            ON resolution.league_id = context.league_id
           AND resolution.season_id = context.season_id
           AND resolution.auction_id = context.auction_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.allocation_id = context.fad_allocation_id
           AND draw.auction_id = context.auction_id
          JOIN commissioner_corrections AS correction
            ON correction.league_id = allocation.league_id
           AND correction.season_id = allocation.season_id
           AND correction.feature =
                'free_agent_draft_allocation'
           AND correction.feature_record_id = allocation.id
           AND correction.corrected_at_ms = NEW.updated_at_ms
          JOIN auction_events AS event
            ON event.league_id = context.league_id
           AND event.season_id = context.season_id
           AND event.auction_id = context.auction_id
           AND event.event_type = 'auction_cancelled'
           AND event.actor_user_id = correction.actor_user_id
           AND event.occurred_at_ms = correction.corrected_at_ms
          WHERE context.league_id = NEW.league_id
            AND context.season_id = NEW.season_id
            AND context.auction_id = NEW.id
            AND (
              (
                context.source_kind = 'fad_restricted'
                AND context.fad_origin =
                  'candidate_tie_restricted'
                AND allocation.restricted_auction_id = NEW.id
                AND allocation.status IN (
                  'restricted_scheduled',
                  'restricted_active',
                  'correction_required'
                )
              )
              OR (
                context.source_kind = 'fad_open_rapid'
                AND context.fad_origin =
                  'restricted_no_improvement_fallback'
                AND allocation.fallback_open_auction_id = NEW.id
                AND allocation.status IN (
                  'restricted_fallback_open',
                  'correction_required'
                )
              )
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
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.version'
                ) = allocation.version
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.status'
                ) = allocation.status
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.version'
                ) = allocation.version + 1
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.status'
                ) IN ('automatic_award', 'no_valid_offer')
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.decisionCode'
                ) = 'corrected'
            AND json_extract(
                  event.metadata_json,
                  '$.correctionId'
                ) = correction.id
            AND json_extract(
                  event.metadata_json,
                  '$.actorAuthority'
                ) IN (
                  'commissioner',
                  'platform_administrator_as_commissioner'
                )
            AND NOT EXISTS (
              SELECT 1
              FROM auction_bids AS bid
              WHERE bid.league_id = NEW.league_id
                AND bid.auction_id = NEW.id
            )
        )
      )
      OR (
        NOT (
          NEW.status = 'cancelled'
          AND EXISTS (
            SELECT 1
            FROM auction_contexts
            WHERE auction_contexts.league_id = NEW.league_id
              AND auction_contexts.season_id = NEW.season_id
              AND auction_contexts.auction_id = NEW.id
              AND auction_contexts.source_kind =
                'fad_restricted'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_draws
          WHERE free_agent_draft_draws.league_id =
              NEW.league_id
            AND free_agent_draft_draws.auction_id = NEW.id
            AND free_agent_draft_draws.revealed_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_draws.version = 2
        )
      )
    )
  THEN RAISE(
    ABORT,
    'terminal FAD auction requires the exact revealed or correction draw state'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'failed'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      OLD.status IN ('open', 'resolving')
      AND NEW.updated_at_ms >= NEW.resolves_at_ms
      AND NOT EXISTS (
        SELECT 1
        FROM auction_resolutions
        WHERE auction_resolutions.league_id = NEW.league_id
          AND auction_resolutions.auction_id = NEW.id
      )
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_draws
        WHERE free_agent_draft_draws.league_id =
            NEW.league_id
          AND free_agent_draft_draws.auction_id = NEW.id
          AND free_agent_draft_draws.revealed_at_ms IS NULL
          AND free_agent_draft_draws.version = 1
      )
    )
  THEN RAISE(
    ABORT,
    'failed FAD auction must preserve its private draw and have no result'
  ) END;
END;

DROP TRIGGER fad_auction_resolutions_context_insert;

CREATE TRIGGER fad_auction_resolutions_context_insert
BEFORE INSERT ON auction_resolutions
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = NEW.league_id
    AND auction_contexts.season_id = NEW.season_id
    AND auction_contexts.auction_id = NEW.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT CASE WHEN NOT (
    NEW.scheduled_occurrence_key = (
      SELECT
        'auction:' || auctions.id || ':' ||
          auctions.resolves_at_ms
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
    )
    AND json_valid(NEW.warnings_json) = 1
    AND json_type(NEW.warnings_json) = 'array'
    AND json(NEW.warnings_json) = NEW.warnings_json
    AND NEW.general_illegal = CASE
      WHEN json_array_length(NEW.warnings_json) > 0 THEN 1
      ELSE 0
    END
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_draws
      JOIN auction_contexts
        ON auction_contexts.league_id =
            free_agent_draft_draws.league_id
       AND auction_contexts.season_id =
            free_agent_draft_draws.season_id
       AND auction_contexts.fad_id =
            free_agent_draft_draws.fad_id
       AND auction_contexts.fad_allocation_id IS
            free_agent_draft_draws.allocation_id
       AND auction_contexts.auction_id =
            free_agent_draft_draws.auction_id
      WHERE free_agent_draft_draws.league_id = NEW.league_id
        AND free_agent_draft_draws.season_id = NEW.season_id
        AND free_agent_draft_draws.auction_id = NEW.auction_id
        AND free_agent_draft_draws.revealed_at_ms IS NULL
        AND free_agent_draft_draws.version = 1
    )
  ) THEN RAISE(
    ABORT,
    'FAD result requires its canonical occurrence, warnings, and private draw'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.status = 'resolved'
      AND NEW.outcome_code = 'winner'
      AND NEW.winning_team_id IS NOT NULL
      AND NEW.winning_bid_id IS NOT NULL
      AND NEW.highest_bid_cents IS NOT NULL
      AND NEW.second_price_input_cents IS NOT NULL
      AND NEW.final_contract_value_cents IS NOT NULL
      AND NEW.winning_term_years IS NOT NULL
      AND NEW.final_aav_cents IS NOT NULL
      AND NEW.contract_id IS NOT NULL
      AND NEW.ownership_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auctions
        JOIN auction_bids
          ON auction_bids.league_id = auctions.league_id
         AND auction_bids.season_id = auctions.season_id
         AND auction_bids.auction_id = auctions.id
        JOIN contracts
          ON contracts.league_id = auction_bids.league_id
         AND contracts.id = NEW.contract_id
        JOIN player_ownerships
          ON player_ownerships.league_id = auction_bids.league_id
         AND player_ownerships.id = NEW.ownership_id
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status IN ('resolving', 'resolved')
          AND NEW.resolved_at_ms >= auctions.resolves_at_ms
          AND auction_bids.id = NEW.winning_bid_id
          AND auction_bids.team_id = NEW.winning_team_id
          AND auction_bids.status = 'won'
          AND auction_bids.total_value_cents = NEW.highest_bid_cents
          AND auction_bids.term_years = NEW.winning_term_years
          AND NEW.final_aav_cents = (
            (NEW.final_contract_value_cents /
              NEW.winning_term_years)
            + CASE
                WHEN
                  (
                    NEW.final_contract_value_cents %
                    NEW.winning_term_years
                  ) * 2 >= NEW.winning_term_years
                THEN 1
                ELSE 0
              END
          )
          AND contracts.player_id = auctions.player_id
          AND contracts.current_team_id = NEW.winning_team_id
          AND contracts.start_season_id = NEW.season_id
          AND contracts.original_total_value_cents =
            NEW.final_contract_value_cents
          AND contracts.original_term_years = NEW.winning_term_years
          AND contracts.aav_cents = NEW.final_aav_cents
          AND contracts.status = 'active'
          AND player_ownerships.season_id = NEW.season_id
          AND player_ownerships.player_id = auctions.player_id
          AND player_ownerships.team_id = NEW.winning_team_id
      )
    )
    OR (
      NEW.status IN ('no_bids', 'no_winner')
      AND NEW.outcome_code = 'no_winner'
      AND NEW.winning_team_id IS NULL
      AND NEW.winning_bid_id IS NULL
      AND NEW.highest_bid_cents IS NULL
      AND NEW.second_price_input_cents IS NULL
      AND NEW.final_contract_value_cents IS NULL
      AND NEW.winning_term_years IS NULL
      AND NEW.final_aav_cents IS NULL
      AND NEW.contract_id IS NULL
      AND NEW.ownership_id IS NULL
      AND NEW.general_illegal = 0
      AND NEW.warnings_json = '[]'
      AND EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status IN ('resolving', 'no_winner')
          AND NEW.resolved_at_ms >= auctions.resolves_at_ms
      )
    )
    OR (
      NEW.status = 'cancelled'
      AND NEW.outcome_code = 'failed'
      AND NEW.winning_team_id IS NULL
      AND NEW.winning_bid_id IS NULL
      AND NEW.highest_bid_cents IS NULL
      AND NEW.second_price_input_cents IS NULL
      AND NEW.final_contract_value_cents IS NULL
      AND NEW.winning_term_years IS NULL
      AND NEW.final_aav_cents IS NULL
      AND NEW.contract_id IS NULL
      AND NEW.ownership_id IS NULL
      AND NEW.general_illegal = 0
      AND NEW.warnings_json = '[]'
      AND NEW.trigger_type = 'commissioner'
      AND NEW.triggered_by_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auctions
        JOIN auction_contexts
          ON auction_contexts.league_id = auctions.league_id
         AND auction_contexts.season_id = auctions.season_id
         AND auction_contexts.auction_id = auctions.id
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status = 'cancelled'
          AND auctions.updated_at_ms = NEW.resolved_at_ms
          AND auction_contexts.source_kind = 'fad_restricted'
      )
    )
    OR (
      NEW.status = 'cancelled'
      AND NEW.outcome_code = 'recovered'
      AND NEW.winning_team_id IS NULL
      AND NEW.winning_bid_id IS NULL
      AND NEW.highest_bid_cents IS NULL
      AND NEW.second_price_input_cents IS NULL
      AND NEW.final_contract_value_cents IS NULL
      AND NEW.winning_term_years IS NULL
      AND NEW.final_aav_cents IS NULL
      AND NEW.contract_id IS NULL
      AND NEW.ownership_id IS NULL
      AND NEW.general_illegal = 0
      AND NEW.warnings_json = '[]'
      AND NEW.trigger_type = 'commissioner'
      AND NEW.triggered_by_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auctions AS auction
        JOIN auction_contexts AS context
          ON context.league_id = auction.league_id
         AND context.season_id = auction.season_id
         AND context.auction_id = auction.id
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = context.league_id
         AND allocation.season_id = context.season_id
         AND allocation.fad_id = context.fad_id
         AND allocation.id = context.fad_allocation_id
         AND allocation.player_id = auction.player_id
        JOIN free_agent_draft_draws AS draw
          ON draw.league_id = context.league_id
         AND draw.season_id = context.season_id
         AND draw.fad_id = context.fad_id
         AND draw.allocation_id = context.fad_allocation_id
         AND draw.auction_id = context.auction_id
        JOIN commissioner_corrections AS correction
          ON correction.league_id = allocation.league_id
         AND correction.season_id = allocation.season_id
         AND correction.feature =
              'free_agent_draft_allocation'
         AND correction.feature_record_id = allocation.id
         AND correction.actor_user_id = NEW.triggered_by_user_id
         AND correction.corrected_at_ms = NEW.resolved_at_ms
        JOIN auction_events AS event
          ON event.league_id = auction.league_id
         AND event.season_id = auction.season_id
         AND event.auction_id = auction.id
         AND event.event_type = 'auction_cancelled'
         AND event.actor_user_id = correction.actor_user_id
         AND event.occurred_at_ms = correction.corrected_at_ms
        WHERE auction.league_id = NEW.league_id
          AND auction.season_id = NEW.season_id
          AND auction.id = NEW.auction_id
          AND auction.status = 'resolving'
          AND auction.created_at_ms <= NEW.resolved_at_ms
          AND draw.created_at_ms <= NEW.resolved_at_ms
          AND draw.revealed_at_ms IS NULL
          AND draw.version = 1
          AND draw.ordered_tied_bid_ids_json IS NULL
          AND draw.ordered_tied_team_ids_json IS NULL
          AND draw.rejection_counter IS NULL
          AND draw.selected_index IS NULL
          AND draw.selected_bid_id IS NULL
          AND draw.selected_team_id IS NULL
          AND draw.selected_digest_hex IS NULL
          AND (
            (
              context.source_kind = 'fad_restricted'
              AND context.fad_origin =
                'candidate_tie_restricted'
              AND allocation.restricted_auction_id = auction.id
              AND allocation.status IN (
                'restricted_scheduled',
                'restricted_active',
                'correction_required'
              )
            )
            OR (
              context.source_kind = 'fad_open_rapid'
              AND context.fad_origin =
                'restricted_no_improvement_fallback'
              AND allocation.fallback_open_auction_id = auction.id
              AND allocation.status IN (
                'restricted_fallback_open',
                'correction_required'
              )
            )
          )
          AND json_valid(correction.before_snapshot_json) = 1
          AND json_valid(correction.after_snapshot_json) = 1
          AND json_extract(
                correction.before_snapshot_json,
                '$.version'
              ) = allocation.version
          AND json_extract(
                correction.before_snapshot_json,
                '$.status'
              ) = allocation.status
          AND json_extract(
                correction.after_snapshot_json,
                '$.version'
              ) = allocation.version + 1
          AND json_extract(
                correction.after_snapshot_json,
                '$.status'
              ) IN ('automatic_award', 'no_valid_offer')
          AND json_extract(
                correction.after_snapshot_json,
                '$.decisionCode'
              ) = 'corrected'
          AND json_extract(
                event.metadata_json,
                '$.correctionId'
              ) = correction.id
          AND json_extract(
                event.metadata_json,
                '$.actorAuthority'
              ) IN (
                'commissioner',
                'platform_administrator_as_commissioner'
              )
          AND NOT EXISTS (
            SELECT 1
            FROM auction_bids AS bid
            WHERE bid.league_id = auction.league_id
              AND bid.auction_id = auction.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM auction_resolutions AS prior_resolution
            WHERE prior_resolution.league_id = auction.league_id
              AND prior_resolution.auction_id = auction.id
          )
          AND EXISTS (
            SELECT 1
            FROM league_memberships AS membership
            WHERE membership.league_id = correction.league_id
              AND membership.user_id = correction.actor_user_id
              AND membership.status = 'active'
              AND (
                (
                  json_extract(
                    event.metadata_json,
                    '$.actorAuthority'
                  ) = 'commissioner'
                  AND EXISTS (
                    SELECT 1
                    FROM leagues AS league
                    WHERE league.id = correction.league_id
                      AND league.commissioner_membership_id =
                          membership.id
                  )
                )
                OR (
                  json_extract(
                    event.metadata_json,
                    '$.actorAuthority'
                  ) =
                    'platform_administrator_as_commissioner'
                  AND EXISTS (
                    SELECT 1
                    FROM platform_roles AS role
                    WHERE role.user_id = correction.actor_user_id
                      AND role.role = 'platform_administrator'
                      AND role.status = 'active'
                  )
                )
              )
          )
      )
    )
    OR (
      NEW.status = 'cancelled'
      AND NEW.outcome_code IN (
        'recovered',
        'player_unavailable',
        'season_closed'
      )
      AND NEW.winning_team_id IS NULL
      AND NEW.winning_bid_id IS NULL
      AND NEW.highest_bid_cents IS NULL
      AND NEW.second_price_input_cents IS NULL
      AND NEW.final_contract_value_cents IS NULL
      AND NEW.winning_term_years IS NULL
      AND NEW.final_aav_cents IS NULL
      AND NEW.contract_id IS NULL
      AND NEW.ownership_id IS NULL
      AND NEW.general_illegal = 0
      AND NEW.warnings_json = '[]'
      AND (
        NEW.outcome_code <> 'recovered'
        OR (
          NEW.trigger_type = 'commissioner'
          AND NEW.triggered_by_user_id IS NOT NULL
        )
      )
      AND EXISTS (
        SELECT 1
        FROM auctions
        JOIN auction_contexts
          ON auction_contexts.league_id = auctions.league_id
         AND auction_contexts.season_id = auctions.season_id
         AND auction_contexts.auction_id = auctions.id
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.status IN ('resolving', 'cancelled')
          AND auction_contexts.source_kind = 'fad_open_rapid'
          AND (
            NEW.outcome_code = 'recovered'
            OR NEW.resolved_at_ms >= auctions.resolves_at_ms
          )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD result status and resources do not match its physical outcome'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM auction_events
    WHERE auction_events.league_id = NEW.league_id
      AND auction_events.season_id = NEW.season_id
      AND auction_events.auction_id = NEW.auction_id
      AND auction_events.occurred_at_ms = NEW.resolved_at_ms
      AND auction_events.event_type = CASE
        WHEN NEW.outcome_code = 'winner'
          THEN 'auction_resolved'
        WHEN NEW.outcome_code = 'no_winner'
          THEN 'auction_no_winner'
        ELSE 'auction_cancelled'
      END
      AND (
        NEW.trigger_type <> 'commissioner'
        OR auction_events.actor_user_id = NEW.triggered_by_user_id
      )
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD result requires one exact terminal auction event'
  ) END;

  SELECT CASE WHEN
    NEW.outcome_code IN ('winner', 'no_winner')
    AND (
      SELECT COUNT(*)
      FROM auctions
      JOIN job_runs
        ON job_runs.league_id = auctions.league_id
       AND job_runs.season_id = auctions.season_id
       AND job_runs.job_type = 'auction.resolve.target'
       AND job_runs.occurrence_key =
            'auction:' || auctions.id || ':' || auctions.resolves_at_ms
       AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms > NEW.resolved_at_ms
        AND job_runs.completed_at_ms IS NULL
        AND job_runs.updated_at_ms <= NEW.resolved_at_ms
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD semantic result requires its exact active resolution job'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
  ) AND NOT (
    (
      NEW.outcome_code = 'winner'
      AND EXISTS (
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
          AND free_agent_draft_player_allocations.status =
            'restricted_resolved'
          AND free_agent_draft_player_allocations.decision_code =
            'restricted_auction_result'
          AND free_agent_draft_player_allocations.winning_team_id =
            NEW.winning_team_id
          AND free_agent_draft_player_allocations.contract_id =
            NEW.contract_id
          AND free_agent_draft_player_allocations.ownership_id =
            NEW.ownership_id
          AND free_agent_draft_player_allocations.accounted_at_ms =
            NEW.resolved_at_ms
      )
    )
    OR (
      NEW.outcome_code = 'no_winner'
      AND EXISTS (
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
          AND free_agent_draft_player_allocations.status =
            'restricted_fallback_open'
          AND free_agent_draft_player_allocations.decision_code =
            'restricted_no_improvement_fallback'
          AND free_agent_draft_player_allocations
            .fallback_open_auction_id IS NOT NULL
      )
    )
    OR (
      NEW.outcome_code = 'failed'
      AND EXISTS (
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
        JOIN free_agent_draft_recoveries
          ON free_agent_draft_recoveries.league_id =
              auction_contexts.league_id
         AND free_agent_draft_recoveries.season_id =
              auction_contexts.season_id
         AND free_agent_draft_recoveries.fad_id =
              auction_contexts.fad_id
         AND free_agent_draft_recoveries.player_id = (
              SELECT player_id
              FROM auctions
              WHERE auctions.league_id = NEW.league_id
                AND auctions.id = NEW.auction_id
            )
         AND free_agent_draft_recoveries.allocation_id =
              auction_contexts.fad_allocation_id
         AND free_agent_draft_recoveries.rollover_id =
              auction_contexts.fad_rollover_id
         AND free_agent_draft_recoveries.auction_id =
              auction_contexts.auction_id
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.auction_id = NEW.auction_id
          AND free_agent_draft_player_allocations.status =
            'correction_required'
          AND free_agent_draft_player_allocations.updated_at_ms =
            NEW.resolved_at_ms
          AND free_agent_draft_recoveries.kind = 'auction_resolution'
          AND free_agent_draft_recoveries.status =
            'correction_required'
          AND free_agent_draft_recoveries.created_at_ms =
            NEW.resolved_at_ms
          AND free_agent_draft_recoveries.resolved_at_ms IS NULL
      )
    )
    OR (
      NEW.outcome_code = 'recovered'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts AS context
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = context.league_id
         AND allocation.season_id = context.season_id
         AND allocation.fad_id = context.fad_id
         AND allocation.id = context.fad_allocation_id
        JOIN commissioner_corrections AS correction
          ON correction.league_id = allocation.league_id
         AND correction.season_id = allocation.season_id
         AND correction.feature =
              'free_agent_draft_allocation'
         AND correction.feature_record_id = allocation.id
         AND correction.actor_user_id = NEW.triggered_by_user_id
         AND correction.corrected_at_ms = NEW.resolved_at_ms
        WHERE context.league_id = NEW.league_id
          AND context.season_id = NEW.season_id
          AND context.auction_id = NEW.auction_id
          AND context.source_kind = 'fad_restricted'
          AND allocation.restricted_auction_id = NEW.auction_id
          AND allocation.status IN (
            'restricted_scheduled',
            'restricted_active',
            'correction_required'
          )
          AND json_extract(
                correction.before_snapshot_json,
                '$.version'
              ) = allocation.version
          AND json_extract(
                correction.before_snapshot_json,
                '$.status'
              ) = allocation.status
          AND json_extract(
                correction.after_snapshot_json,
                '$.version'
              ) = allocation.version + 1
          AND json_extract(
                correction.after_snapshot_json,
                '$.status'
              ) IN ('automatic_award', 'no_valid_offer')
          AND json_extract(
                correction.after_snapshot_json,
                '$.decisionCode'
              ) = 'corrected'
      )
    )
  ) THEN RAISE(
    ABORT,
    'restricted result must reconcile its exact allocation and recovery state'
  ) END;

  SELECT CASE WHEN
    NEW.outcome_code = 'recovered'
    AND NOT (
      EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN free_agent_draft_recoveries AS recovery
        ON recovery.league_id = auction_contexts.league_id
       AND recovery.season_id = auction_contexts.season_id
       AND recovery.fad_id = auction_contexts.fad_id
       AND recovery.player_id = (
            SELECT player_id
            FROM auctions
            WHERE auctions.league_id = NEW.league_id
              AND auctions.id = NEW.auction_id
          )
       AND recovery.allocation_id IS
            auction_contexts.fad_allocation_id
       AND recovery.rollover_id =
            auction_contexts.fad_rollover_id
       AND recovery.auction_id = auction_contexts.auction_id
      JOIN job_runs AS job
        ON job.league_id = recovery.league_id
       AND job.season_id = recovery.season_id
       AND job.id = recovery.job_run_id
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind = 'fad_open_rapid'
        AND recovery.kind = 'auction_resolution'
        AND recovery.status = 'running'
        AND recovery.resolved_at_ms IS NULL
        AND recovery.resolved_by_user_id IS NULL
        AND recovery.resolved_by_membership_id IS NULL
        AND recovery.resolved_authority IS NULL
        AND recovery.updated_at_ms <= NEW.resolved_at_ms
        AND recovery.created_by_operation_id = job.id
        AND job.job_type = 'auction.resolve.target'
        AND job.occurrence_key = NEW.scheduled_occurrence_key
        AND job.status IN ('leased', 'running')
        AND job.attempt_count >= 1
        AND job.lease_owner IS NOT NULL
        AND job.lease_token IS NOT NULL
        AND job.lease_expires_at_ms > NEW.resolved_at_ms
        AND job.completed_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM league_memberships AS membership
          WHERE membership.league_id = NEW.league_id
            AND membership.user_id = NEW.triggered_by_user_id
            AND membership.status = 'active'
            AND (
              EXISTS (
                SELECT 1
                FROM leagues AS league
                WHERE league.id = NEW.league_id
                  AND league.commissioner_membership_id = membership.id
              )
              OR EXISTS (
                SELECT 1
                FROM platform_roles AS role
                WHERE role.user_id = NEW.triggered_by_user_id
                  AND role.role = 'platform_administrator'
                  AND role.status = 'active'
              )
            )
        )
      )
      OR EXISTS (
        SELECT 1
        FROM auction_contexts AS context
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = context.league_id
         AND allocation.season_id = context.season_id
         AND allocation.fad_id = context.fad_id
         AND allocation.id = context.fad_allocation_id
        JOIN commissioner_corrections AS correction
          ON correction.league_id = allocation.league_id
         AND correction.season_id = allocation.season_id
         AND correction.feature =
              'free_agent_draft_allocation'
         AND correction.feature_record_id = allocation.id
         AND correction.actor_user_id = NEW.triggered_by_user_id
         AND correction.corrected_at_ms = NEW.resolved_at_ms
        WHERE context.league_id = NEW.league_id
          AND context.season_id = NEW.season_id
          AND context.auction_id = NEW.auction_id
          AND context.source_kind IN (
            'fad_restricted',
            'fad_open_rapid'
          )
          AND (
            (
              context.source_kind = 'fad_restricted'
              AND allocation.restricted_auction_id = NEW.auction_id
            )
            OR (
              context.source_kind = 'fad_open_rapid'
              AND context.fad_origin =
                'restricted_no_improvement_fallback'
              AND allocation.fallback_open_auction_id = NEW.auction_id
            )
          )
          AND json_extract(
                correction.before_snapshot_json,
                '$.version'
              ) = allocation.version
          AND json_extract(
                correction.before_snapshot_json,
                '$.status'
              ) = allocation.status
          AND json_extract(
                correction.after_snapshot_json,
                '$.version'
              ) = allocation.version + 1
          AND json_extract(
                correction.after_snapshot_json,
                '$.status'
              ) IN ('automatic_award', 'no_valid_offer')
          AND json_extract(
                correction.after_snapshot_json,
                '$.decisionCode'
              ) = 'corrected'
      )
    )
  THEN RAISE(
    ABORT,
    'recovered open FAD cancellation requires its running recovery and exact active operation'
  ) END;
END;

CREATE TRIGGER fad_open_rapid_recovery_resolution_guard
BEFORE UPDATE OF status ON free_agent_draft_recoveries
WHEN OLD.status = 'running'
  AND NEW.status = 'resolved'
  AND NEW.kind = 'auction_resolution'
  AND EXISTS (
    SELECT 1
    FROM auction_contexts AS context
    WHERE context.league_id = NEW.league_id
      AND context.season_id = NEW.season_id
      AND context.fad_id = NEW.fad_id
      AND context.auction_id = NEW.auction_id
      AND context.source_kind = 'fad_open_rapid'
  )
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts AS context
    JOIN auctions AS auction
      ON auction.league_id = context.league_id
     AND auction.season_id = context.season_id
     AND auction.id = context.auction_id
    JOIN auction_resolutions AS resolution
      ON resolution.league_id = auction.league_id
     AND resolution.season_id = auction.season_id
     AND resolution.auction_id = auction.id
    JOIN free_agent_draft_draws AS draw
      ON draw.league_id = context.league_id
     AND draw.season_id = context.season_id
     AND draw.fad_id = context.fad_id
     AND draw.allocation_id IS context.fad_allocation_id
     AND draw.auction_id = context.auction_id
    JOIN job_runs AS job
      ON job.league_id = NEW.league_id
     AND job.season_id = NEW.season_id
     AND job.id = NEW.job_run_id
    JOIN auction_events AS failure_event
      ON failure_event.league_id = context.league_id
     AND failure_event.season_id = context.season_id
     AND failure_event.auction_id = context.auction_id
     AND failure_event.event_type = 'fad_auction_resolution_failed'
    WHERE context.league_id = NEW.league_id
      AND context.season_id = NEW.season_id
      AND context.fad_id = NEW.fad_id
      AND context.auction_id = NEW.auction_id
      AND context.fad_allocation_id IS NEW.allocation_id
      AND context.fad_rollover_id = NEW.rollover_id
      AND context.source_kind = 'fad_open_rapid'
      AND auction.player_id = NEW.player_id
      AND auction.status = 'cancelled'
      AND auction.updated_at_ms = NEW.resolved_at_ms
      AND resolution.status = 'cancelled'
      AND resolution.outcome_code = 'recovered'
      AND resolution.trigger_type = 'commissioner'
      AND resolution.triggered_by_user_id = NEW.resolved_by_user_id
      AND resolution.resolved_at_ms = NEW.resolved_at_ms
      AND draw.revealed_at_ms = NEW.resolved_at_ms
      AND draw.version = 2
      AND draw.ordered_tied_bid_ids_json = '[]'
      AND draw.ordered_tied_team_ids_json = '[]'
      AND draw.selected_bid_id IS NULL
      AND draw.selected_team_id IS NULL
      AND job.job_type = 'auction.resolve.target'
      AND job.occurrence_key = resolution.scheduled_occurrence_key
      AND job.status IN ('leased', 'running')
      AND job.attempt_count >= 1
      AND job.lease_owner IS NOT NULL
      AND job.lease_token IS NOT NULL
      AND job.lease_expires_at_ms > NEW.resolved_at_ms
      AND job.completed_at_ms IS NULL
      AND NEW.created_by_operation_id = job.id
      AND failure_event.actor_user_id IS NULL
      AND failure_event.bid_id IS NULL
      AND failure_event.team_id IS NULL
      AND failure_event.occurred_at_ms = NEW.created_at_ms
      AND json_extract(
            failure_event.metadata_json,
            '$.recoveryId'
          ) = NEW.id
      AND json_extract(
            failure_event.metadata_json,
            '$.jobRunId'
          ) = NEW.job_run_id
      AND json_extract(
            failure_event.metadata_json,
            '$.errorCode'
          ) = OLD.last_error_code
      AND EXISTS (
        SELECT 1
        FROM league_memberships AS membership
        WHERE membership.league_id = NEW.league_id
          AND membership.id = NEW.resolved_by_membership_id
          AND membership.user_id = NEW.resolved_by_user_id
          AND membership.status = 'active'
          AND (
            (
              NEW.resolved_authority = 'commissioner'
              AND EXISTS (
                SELECT 1
                FROM leagues AS league
                WHERE league.id = NEW.league_id
                  AND league.commissioner_membership_id =
                    membership.id
              )
            )
            OR (
              NEW.resolved_authority =
                'platform_administrator_as_commissioner'
              AND EXISTS (
                SELECT 1
                FROM platform_roles AS role
                WHERE role.user_id = NEW.resolved_by_user_id
                  AND role.role = 'platform_administrator'
                  AND role.status = 'active'
              )
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'open rapid cancellation recovery requires its exact failure, operation, no-winner result, draw, and current authority evidence'
  ) END;
END;

CREATE TRIGGER auction_administration_fad_open_cancel_result_guard
BEFORE INSERT ON auction_administration_command_results
WHEN NEW.action = 'cancel_auction'
  AND EXISTS (
    SELECT 1
    FROM auction_contexts AS context
    JOIN auction_resolutions AS resolution
      ON resolution.league_id = context.league_id
     AND resolution.season_id = context.season_id
     AND resolution.auction_id = context.auction_id
    WHERE context.league_id = NEW.league_id
      AND context.season_id = NEW.season_id
      AND context.auction_id = NEW.auction_id
      AND context.source_kind = 'fad_open_rapid'
      AND resolution.outcome_code = 'recovered'
  )
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts AS context
    JOIN auctions AS auction
      ON auction.league_id = context.league_id
     AND auction.season_id = context.season_id
     AND auction.id = context.auction_id
    JOIN auction_resolutions AS resolution
      ON resolution.league_id = auction.league_id
     AND resolution.season_id = auction.season_id
     AND resolution.auction_id = auction.id
    JOIN free_agent_draft_draws AS draw
      ON draw.league_id = context.league_id
     AND draw.season_id = context.season_id
     AND draw.fad_id = context.fad_id
     AND draw.allocation_id IS context.fad_allocation_id
     AND draw.auction_id = context.auction_id
    JOIN free_agent_draft_recoveries AS recovery
      ON recovery.league_id = context.league_id
     AND recovery.season_id = context.season_id
     AND recovery.fad_id = context.fad_id
     AND recovery.player_id = auction.player_id
     AND recovery.allocation_id IS context.fad_allocation_id
     AND recovery.rollover_id = context.fad_rollover_id
     AND recovery.auction_id = context.auction_id
    WHERE context.league_id = NEW.league_id
      AND context.season_id = NEW.season_id
      AND context.auction_id = NEW.auction_id
      AND context.source_kind = 'fad_open_rapid'
      AND auction.status = 'cancelled'
      AND auction.version = NEW.resulting_resource_version
      AND auction.updated_at_ms = NEW.created_at_ms
      AND resolution.status = 'cancelled'
      AND resolution.outcome_code = 'recovered'
      AND resolution.trigger_type = 'commissioner'
      AND resolution.triggered_by_user_id = NEW.actor_user_id
      AND resolution.resolved_at_ms = NEW.created_at_ms
      AND draw.revealed_at_ms = NEW.created_at_ms
      AND draw.version = 2
      AND recovery.kind = 'auction_resolution'
      AND recovery.status = 'resolved'
      AND recovery.resolved_by_user_id = NEW.actor_user_id
      AND recovery.resolved_by_membership_id = NEW.actor_membership_id
      AND recovery.resolved_authority = NEW.actor_authority
      AND recovery.resolved_at_ms = NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'failed open rapid cancellation result requires its exact resolved recovery evidence'
  ) END;
END;

-- A delayed restricted resolution may reach the final hour before the next
-- already-persisted rollover.  The mandatory no-improvement fallback then
-- needs the following complete window, but that following extension must be
-- inserted before the allocation can link its fallback auction.  Preserve the
-- original rollover guard and add only this evidence-bound pre-transition
-- exception for the otherwise circular insert order.

DROP TRIGGER free_agent_draft_rollovers_valid_insert;

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
        AND NEW.rolls_over_at_ms =
          free_agent_drafts.candidate_deadline_at_ms
          + NEW.sequence * 86400000
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
              AND NEW.sequence BETWEEN 2 AND 7
            )
            OR (
              NEW.window_kind = 'extension'
              AND NEW.sequence >= 8
              AND (
                predecessor.status IN (
                  'processing',
                  'completed',
                  'recovery_required'
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
                             AND failure_event.occurred_at_ms =
                                  recovery.created_at_ms
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
                              AND receipt.action =
                                'retry_auction_resolution'
                              AND receipt.resource_kind = 'auction'
                              AND receipt.resource_id = restricted_auction.id
                              AND receipt.operation_id = resolution_job.id
                              AND receipt.occurrence_key =
                                resolution_job.occurrence_key
                              AND receipt.accepted_status = 'pending'
                              AND receipt.accepted_at_ms >=
                                recovery.created_at_ms
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
            FROM free_agent_draft_nomination_queue
            WHERE free_agent_draft_nomination_queue.league_id =
                NEW.league_id
              AND free_agent_draft_nomination_queue.season_id =
                NEW.season_id
              AND free_agent_draft_nomination_queue.fad_id =
                NEW.fad_id
              AND free_agent_draft_nomination_queue.id =
                NEW.extension_source_id
              AND free_agent_draft_nomination_queue.status = 'queued'
              AND free_agent_draft_nomination_queue.target_opening_rollover_id =
                NEW.predecessor_rollover_id
              AND free_agent_draft_nomination_queue.resolution_rollover_id IS NULL
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
                       AND failure_event.occurred_at_ms =
                            recovery.created_at_ms
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
                        AND receipt.action = 'retry_auction_resolution'
                        AND receipt.resource_kind = 'auction'
                        AND receipt.resource_id = restricted_auction.id
                        AND receipt.operation_id = resolution_job.id
                        AND receipt.occurrence_key =
                          resolution_job.occurrence_key
                        AND receipt.accepted_status = 'pending'
                        AND receipt.accepted_at_ms >= recovery.created_at_ms
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
        AND free_agent_drafts.status = 'rapid'
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

CREATE TRIGGER idempotency_requests_fad_nomination_queue_complete
BEFORE UPDATE ON idempotency_requests
WHEN NEW.result_type = 'fad_nomination_queue'
  OR OLD.result_type = 'fad_nomination_queue'
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_nomination_queue
    WHERE free_agent_draft_nomination_queue.league_id = OLD.league_id
      AND free_agent_draft_nomination_queue
        .acceptance_idempotency_request_id = OLD.id
  )
BEGIN
  SELECT CASE WHEN NOT (
    OLD.operation = 'auction.start'
    AND OLD.status = 'started'
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
    AND NEW.result_type = 'fad_nomination_queue'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms = OLD.created_at_ms
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_nomination_queue AS queue
      WHERE queue.league_id = NEW.league_id
        AND queue.id = NEW.result_id
        AND queue.acceptance_idempotency_request_id = NEW.id
        AND queue.submitted_by_user_id = NEW.actor_user_id
        AND queue.accepted_at_ms = NEW.created_at_ms
        AND queue.created_at_ms = NEW.created_at_ms
        AND queue.status = 'queued'
    )
  ) THEN RAISE(
    ABORT,
    'queued nomination acceptance request may complete exactly once'
  ) END;
END;

CREATE TRIGGER free_agent_draft_nomination_queue_complete_acceptance_request
AFTER INSERT ON free_agent_draft_nomination_queue
BEGIN
  UPDATE idempotency_requests
  SET status = 'completed',
      result_type = 'fad_nomination_queue',
      result_id = NEW.id,
      completed_at_ms = NEW.accepted_at_ms
  WHERE league_id = NEW.league_id
    AND id = NEW.acceptance_idempotency_request_id
    AND actor_user_id = NEW.submitted_by_user_id
    AND operation = 'auction.start'
    AND status = 'started'
    AND result_type IS NULL
    AND result_id IS NULL
    AND created_at_ms = NEW.accepted_at_ms
    AND completed_at_ms IS NULL
    AND expires_at_ms > NEW.accepted_at_ms;

  SELECT CASE WHEN changes() <> 1 THEN RAISE(
    ABORT,
    'queued nomination must complete its exact acceptance request'
  ) END;
END;

CREATE TRIGGER idempotency_requests_fad_nomination_queue_delete
BEFORE DELETE ON idempotency_requests
WHEN OLD.result_type = 'fad_nomination_queue'
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_nomination_queue
    WHERE free_agent_draft_nomination_queue.league_id = OLD.league_id
      AND free_agent_draft_nomination_queue
        .acceptance_idempotency_request_id = OLD.id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'queued nomination acceptance request evidence is immutable'
  );
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
              AND idempotency_requests.operation = 'auction.bid.put'
              AND idempotency_requests.status = 'started'
              AND idempotency_requests.result_type IS NULL
              AND idempotency_requests.result_id IS NULL
              AND idempotency_requests.created_at_ms =
                NEW.first_submitted_at_ms
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
    AND (
      (
        NEW.status = 'invalid'
        AND NEW.resolution_rollover_id IS NULL
        AND NEW.opened_auction_id IS NULL
        AND NEW.opened_starter_bid_id IS NULL
        AND NEW.opened_at_ms IS NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.validation_code IS NOT NULL
      )
      OR (
        NEW.status = 'opened'
        AND NEW.resolution_rollover_id IS NOT NULL
        AND NEW.opened_at_ms = NEW.updated_at_ms
        AND NEW.terminal_at_ms = NEW.updated_at_ms
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
            AND resolution_rollover.opens_at_ms =
              opening_rollover.rolls_over_at_ms
            AND resolution_rollover.rolls_over_at_ms =
              opening_rollover.rolls_over_at_ms + 86400000
        )
        AND EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.auction_id = auctions.id
          WHERE auctions.league_id = NEW.league_id
            AND auctions.season_id = NEW.season_id
            AND auctions.id = NEW.opened_auction_id
            AND auctions.player_id = NEW.player_id
            AND auctions.status = 'open'
            AND auctions.opened_at_ms = NEW.opened_at_ms
            AND auctions.resolves_at_ms = (
              SELECT rolls_over_at_ms
              FROM free_agent_draft_rollovers
              WHERE league_id = NEW.league_id
                AND id = NEW.resolution_rollover_id
            )
            AND auctions.opened_by_user_id =
              NEW.submitted_by_user_id
            AND auction_contexts.season_id = NEW.season_id
            AND auction_contexts.source_kind = 'fad_open_rapid'
            AND auction_contexts.fad_id = NEW.fad_id
            AND auction_contexts.fad_rollover_id =
              NEW.resolution_rollover_id
            AND auction_contexts.fad_allocation_id IS NULL
            AND auction_contexts.fad_origin = 'queued_nomination'
        )
        AND EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = NEW.league_id
            AND auction_bids.season_id = NEW.season_id
            AND auction_bids.id = NEW.opened_starter_bid_id
            AND auction_bids.auction_id = NEW.opened_auction_id
            AND auction_bids.team_id = NEW.team_id
            AND auction_bids.submitted_by_user_id =
              NEW.submitted_by_user_id
            AND auction_bids.total_value_cents =
              NEW.opening_total_value_cents
            AND auction_bids.term_years =
              NEW.opening_term_years
            AND auction_bids.lowest_offered_aav_cents =
              NEW.opening_aav_cents
            AND auction_bids.first_submitted_at_ms =
              NEW.accepted_at_ms
            AND auction_bids.last_edited_at_ms =
              NEW.accepted_at_ms
            AND auction_bids.edit_count = 0
            AND auction_bids.status = 'active'
            AND auction_bids.idempotency_request_id =
              NEW.acceptance_idempotency_request_id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'queued nomination may only open atomically or record objective invalidity'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '39',
    updated_at_ms = CASE
      WHEN updated_at_ms < 39 THEN 39
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '38';
