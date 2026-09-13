-- Schema 33 records the exact system-owned corrective requeue performed
-- inside confirmed inaugural matchup-schedule creation. It preserves all
-- schema-32 readiness paths and creates no readiness occurrence or evidence
-- row for preexisting data.

CREATE TABLE free_agent_draft_readiness_corrective_requeues (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  readiness_operation_id TEXT NOT NULL
    CHECK (
      length(readiness_operation_id) = 36
      AND readiness_operation_id = lower(readiness_operation_id)
    ),
  readiness_attempt_id TEXT NOT NULL
    CHECK (
      length(readiness_attempt_id) = 36
      AND readiness_attempt_id = lower(readiness_attempt_id)
    ),
  job_run_id TEXT NOT NULL
    CHECK (
      length(job_run_id) = 36
      AND job_run_id = lower(job_run_id)
    ),
  occurrence_key TEXT NOT NULL
    CHECK (
      occurrence_key = trim(occurrence_key)
      AND length(occurrence_key) BETWEEN 1 AND 500
    ),
  correction_kind TEXT NOT NULL
    CHECK (correction_kind = 'matchup_schedule_created'),
  matchup_schedule_command_result_id TEXT NOT NULL
    CHECK (
      length(matchup_schedule_command_result_id) = 36
      AND matchup_schedule_command_result_id =
        lower(matchup_schedule_command_result_id)
    ),
  schedule_operation_id TEXT NOT NULL
    CHECK (
      length(schedule_operation_id) = 36
      AND schedule_operation_id = lower(schedule_operation_id)
    ),
  schedule_version INTEGER NOT NULL CHECK (schedule_version = 1),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  readiness_version_before INTEGER NOT NULL
    CHECK (readiness_version_before >= 1),
  readiness_version_after INTEGER NOT NULL
    CHECK (
      readiness_version_after = readiness_version_before + 1
    ),
  job_version_before INTEGER NOT NULL
    CHECK (job_version_before >= 1),
  job_version_after INTEGER NOT NULL
    CHECK (job_version_after = job_version_before + 1),
  blockers_json TEXT NOT NULL
    CHECK (
      json_valid(blockers_json) = 1
      AND json_type(blockers_json) = 'array'
      AND json(blockers_json) = blockers_json
      AND json_array_length(blockers_json) BETWEEN 1 AND 100
    ),
  blocked_at_ms INTEGER NOT NULL CHECK (blocked_at_ms >= 0),
  previous_next_retry_at_ms INTEGER NOT NULL
    CHECK (previous_next_retry_at_ms > blocked_at_ms),
  requeued_at_ms INTEGER NOT NULL
    CHECK (requeued_at_ms > blocked_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, matchup_schedule_command_result_id),
  UNIQUE (
    league_id,
    readiness_operation_id,
    readiness_version_after
  ),
  UNIQUE (league_id, job_run_id, job_version_after),
  UNIQUE (
    league_id,
    readiness_attempt_id,
    correction_kind
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, readiness_operation_id)
    REFERENCES free_agent_draft_readiness_operations(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, readiness_attempt_id)
    REFERENCES free_agent_draft_readiness_attempts(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    matchup_schedule_command_result_id
  ) REFERENCES matchup_schedule_command_results(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) REFERENCES season_matchup_schedule_generations(
    league_id,
    season_id,
    schedule_operation_id,
    schedule_version
  ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX free_agent_draft_readiness_corrective_requeues_operation_latest
  ON free_agent_draft_readiness_corrective_requeues (
    league_id,
    readiness_operation_id,
    readiness_version_after DESC
  );

CREATE TRIGGER free_agent_draft_readiness_corrective_requeues_valid_insert
BEFORE INSERT ON free_agent_draft_readiness_corrective_requeues
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
          'message',
          'resourceId',
          'resourceType'
        )
      )
      OR json_type(blocker.value, '$.code') IS NOT 'text'
      OR json_type(blocker.value, '$.message') IS NOT 'text'
      OR COALESCE(
        json_type(blocker.value, '$.field'),
        ''
      ) NOT IN ('text', 'null')
      OR COALESCE(
        json_type(blocker.value, '$.resourceId'),
        ''
      ) NOT IN ('text', 'null')
      OR COALESCE(
        json_type(blocker.value, '$.resourceType'),
        ''
      ) NOT IN ('text', 'null')
      OR length(json_extract(blocker.value, '$.code'))
        NOT BETWEEN 1 AND 100
      OR json_extract(blocker.value, '$.code')
        GLOB '*[^A-Z0-9_]*'
      OR json_extract(blocker.value, '$.message') <>
        trim(json_extract(blocker.value, '$.message'))
      OR length(json_extract(blocker.value, '$.message'))
        NOT BETWEEN 1 AND 500
      OR (
        json_type(blocker.value, '$.field') = 'text'
        AND (
          json_extract(blocker.value, '$.field') <>
            trim(json_extract(blocker.value, '$.field'))
          OR length(json_extract(blocker.value, '$.field'))
            NOT BETWEEN 1 AND 100
        )
      )
      OR (
        json_type(blocker.value, '$.resourceId') = 'text'
        AND (
          json_extract(blocker.value, '$.resourceId') <>
            trim(json_extract(blocker.value, '$.resourceId'))
          OR length(json_extract(blocker.value, '$.resourceId'))
            NOT BETWEEN 1 AND 500
        )
      )
      OR (
        json_type(blocker.value, '$.resourceType') = 'text'
        AND (
          json_extract(blocker.value, '$.resourceType') <>
            trim(json_extract(blocker.value, '$.resourceType'))
          OR length(json_extract(blocker.value, '$.resourceType'))
            NOT BETWEEN 1 AND 100
        )
      )
      OR blocker.value <> json_object(
        'code', json_extract(blocker.value, '$.code'),
        'field', json_extract(blocker.value, '$.field'),
        'message', json_extract(blocker.value, '$.message'),
        'resourceId', json_extract(blocker.value, '$.resourceId'),
        'resourceType', json_extract(blocker.value, '$.resourceType')
      )
  ) THEN RAISE(
    ABORT,
    'corrective requeue blockers require canonical five-field evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.blockers_json) AS left_blocker
    JOIN json_each(NEW.blockers_json) AS right_blocker
      ON right_blocker.key > left_blocker.key
     AND right_blocker.value = left_blocker.value
  ) THEN RAISE(
    ABORT,
    'corrective requeue blockers must be unique'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.blockers_json) AS blocker
    WHERE blocker.value = json_object(
      'code', 'MATCHUP_SCHEDULE_MISSING',
      'field', 'firstMatchupStartsAtMs',
      'message', 'The first matchup schedule must be confirmed.',
      'resourceId', NEW.season_id,
      'resourceType', 'season'
    )
  ) THEN RAISE(
    ABORT,
    'corrective requeue requires the canonical missing-schedule blocker'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM matchup_schedule_command_results AS command_result
    JOIN idempotency_requests AS command_request
      ON command_request.league_id = command_result.league_id
     AND command_request.id =
       command_result.idempotency_request_id
    JOIN season_matchup_schedule_generations AS generation
      ON generation.league_id = command_result.league_id
     AND generation.season_id = command_result.season_id
     AND generation.schedule_operation_id =
       command_result.new_schedule_operation_id
     AND generation.schedule_version =
       command_result.new_schedule_version
    JOIN free_agent_draft_readiness_operations AS readiness
      ON readiness.league_id = command_result.league_id
     AND readiness.season_id = command_result.season_id
    JOIN job_runs
      ON job_runs.league_id = readiness.league_id
     AND job_runs.season_id = readiness.season_id
     AND job_runs.id = readiness.job_run_id
     AND job_runs.occurrence_key =
       readiness.readiness_occurrence_key
    JOIN free_agent_draft_readiness_attempts AS attempt
      ON attempt.league_id = readiness.league_id
     AND attempt.season_id = readiness.season_id
     AND attempt.readiness_operation_id = readiness.id
     AND attempt.job_run_id = readiness.job_run_id
     AND attempt.attempt_number = readiness.attempt_count
    WHERE command_result.league_id = NEW.league_id
      AND command_result.season_id = NEW.season_id
      AND command_result.id =
        NEW.matchup_schedule_command_result_id
      AND command_result.action = 'generate'
      AND command_result.idempotency_operation =
        'matchup.schedule.generate.v1'
      AND command_result.old_schedule_operation_id IS NULL
      AND command_result.old_schedule_version IS NULL
      AND command_result.new_schedule_operation_id =
        NEW.schedule_operation_id
      AND command_result.new_schedule_version =
        NEW.schedule_version
      AND command_result.response_http_status = 201
      AND command_result.response_code =
        'MATCHUP_SCHEDULE_GENERATED'
      AND command_result.result_schema_version = 1
      AND command_result.created_at_ms = NEW.requeued_at_ms
      AND command_result.version = 1
      AND command_request.operation =
        'matchup.schedule.generate.v1'
      AND command_request.request_hash =
        command_result.request_sha256
      AND command_request.actor_user_id =
        command_result.actor_user_id
      AND command_request.status = 'started'
      AND command_request.result_type IS NULL
      AND command_request.result_id IS NULL
      AND command_request.completed_at_ms IS NULL
      AND command_request.created_at_ms <= NEW.requeued_at_ms
      AND command_request.expires_at_ms > NEW.requeued_at_ms
      AND generation.schedule_operation_id =
        NEW.schedule_operation_id
      AND generation.schedule_version = NEW.schedule_version
      AND generation.status = 'current'
      AND generation.created_at_ms = NEW.requeued_at_ms
      AND generation.version = 1
      AND readiness.id = NEW.readiness_operation_id
      AND readiness.trigger_kind = 'no_draft_inaugural'
      AND readiness.entry_draft_id IS NULL
      AND readiness.setup_exemption_id IS NULL
      AND readiness.job_run_id = NEW.job_run_id
      AND readiness.readiness_occurrence_key =
        NEW.occurrence_key
      AND readiness.status = 'blocked'
      AND readiness.attempt_count = NEW.attempt_count
      AND readiness.lease_owner IS NULL
      AND readiness.lease_token IS NULL
      AND readiness.lease_expires_at_ms IS NULL
      AND readiness.blockers_json = NEW.blockers_json
      AND readiness.matchup_schedule_version_before IS NULL
      AND readiness.matchup_schedule_version_after IS NULL
      AND readiness.schedule_recovery_id IS NULL
      AND readiness.created_fad_id IS NULL
      AND readiness.reminder_job_run_id IS NULL
      AND readiness.deadline_job_run_id IS NULL
      AND readiness.cards_opened_activity_id IS NULL
      AND readiness.cards_opened_outbox_event_id IS NULL
      AND readiness.started_at_ms IS NOT NULL
      AND readiness.next_retry_at_ms =
        NEW.previous_next_retry_at_ms
      AND readiness.terminal_at_ms = NEW.blocked_at_ms
      AND readiness.created_at_ms = job_runs.scheduled_for_ms
      AND readiness.updated_at_ms = NEW.blocked_at_ms
      AND readiness.version = NEW.readiness_version_before
      AND job_runs.job_type = 'fad_readiness'
      AND job_runs.status = 'failed'
      AND job_runs.attempt_count = NEW.attempt_count
      AND job_runs.lease_owner IS NULL
      AND job_runs.lease_token IS NULL
      AND job_runs.lease_expires_at_ms IS NULL
      AND job_runs.started_at_ms = readiness.started_at_ms
      AND job_runs.completed_at_ms = NEW.blocked_at_ms
      AND job_runs.result_json IS NULL
      AND job_runs.last_error_code =
        'FAD_READINESS_BLOCKED'
      AND job_runs.next_attempt_at_ms =
        NEW.previous_next_retry_at_ms
      AND job_runs.created_at_ms = readiness.created_at_ms
      AND job_runs.updated_at_ms = NEW.blocked_at_ms
      AND job_runs.version = NEW.job_version_before
      AND NEW.job_version_before =
        NEW.readiness_version_before
      AND attempt.id = NEW.readiness_attempt_id
      AND attempt.outcome = 'blocked'
      AND attempt.observed_readiness_version =
        NEW.readiness_version_before - 1
      AND attempt.recorded_at_ms = NEW.blocked_at_ms
      AND attempt.version = 1
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
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_readiness_attempts AS later_attempt
        WHERE later_attempt.league_id = readiness.league_id
          AND later_attempt.readiness_operation_id = readiness.id
          AND later_attempt.attempt_number > NEW.attempt_count
      )
  ) THEN RAISE(
    ABORT,
    'corrective requeue must bind the exact blocked inaugural readiness and new schedule'
  ) END;
END;

CREATE TRIGGER free_agent_draft_readiness_corrective_requeues_immutable_update
BEFORE UPDATE ON free_agent_draft_readiness_corrective_requeues
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD readiness corrective requeues are immutable'
  );
END;

CREATE TRIGGER free_agent_draft_readiness_corrective_requeues_immutable_delete
BEFORE DELETE ON free_agent_draft_readiness_corrective_requeues
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD readiness corrective requeues are immutable'
  );
END;

CREATE TRIGGER free_agent_draft_readiness_job_requeue_guard
BEFORE UPDATE ON job_runs
WHEN OLD.job_type = 'fad_readiness'
  AND OLD.status = 'failed'
  AND NEW.status = 'pending'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.job_type IS OLD.job_type
    AND NEW.occurrence_key IS OLD.occurrence_key
    AND NEW.scheduled_for_ms IS OLD.scheduled_for_ms
    AND NEW.attempt_count = OLD.attempt_count
    AND OLD.attempt_count >= 1
    AND OLD.lease_owner IS NULL
    AND OLD.lease_token IS NULL
    AND OLD.lease_expires_at_ms IS NULL
    AND OLD.started_at_ms IS NOT NULL
    AND OLD.completed_at_ms IS NOT NULL
    AND OLD.result_json IS NULL
    AND OLD.last_error_code = 'FAD_READINESS_BLOCKED'
    AND OLD.next_attempt_at_ms > OLD.completed_at_ms
    AND OLD.updated_at_ms = OLD.completed_at_ms
    AND NEW.lease_owner IS NULL
    AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at_ms IS NULL
    AND NEW.started_at_ms IS NULL
    AND NEW.completed_at_ms IS NULL
    AND NEW.result_json IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.next_attempt_at_ms = NEW.updated_at_ms
    AND NEW.updated_at_ms > OLD.completed_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_readiness_operations AS readiness
      WHERE readiness.league_id = OLD.league_id
        AND readiness.season_id = OLD.season_id
        AND readiness.job_run_id = OLD.id
        AND readiness.readiness_occurrence_key =
          OLD.occurrence_key
        AND readiness.status = 'blocked'
        AND readiness.attempt_count = OLD.attempt_count
        AND readiness.lease_owner IS NULL
        AND readiness.lease_token IS NULL
        AND readiness.lease_expires_at_ms IS NULL
        AND json_array_length(readiness.blockers_json) >= 1
        AND readiness.matchup_schedule_version_before IS NULL
        AND readiness.matchup_schedule_version_after IS NULL
        AND readiness.schedule_recovery_id IS NULL
        AND readiness.created_fad_id IS NULL
        AND readiness.reminder_job_run_id IS NULL
        AND readiness.deadline_job_run_id IS NULL
        AND readiness.cards_opened_activity_id IS NULL
        AND readiness.cards_opened_outbox_event_id IS NULL
        AND readiness.started_at_ms = OLD.started_at_ms
        AND readiness.next_retry_at_ms =
          OLD.next_attempt_at_ms
        AND readiness.terminal_at_ms = OLD.completed_at_ms
        AND readiness.created_at_ms = OLD.scheduled_for_ms
        AND readiness.updated_at_ms = OLD.completed_at_ms
        AND readiness.version = OLD.version
    )
    AND (
      EXISTS (
        SELECT 1
        FROM idempotency_requests AS retry_request
        JOIN users
          ON users.id = retry_request.actor_user_id
        JOIN league_memberships AS actor_membership
          ON actor_membership.league_id =
            retry_request.league_id
         AND actor_membership.user_id =
           retry_request.actor_user_id
        WHERE retry_request.league_id = NEW.league_id
          AND retry_request.operation =
            'free_agent_draft.readiness.retry.v1'
          AND retry_request.status = 'started'
          AND retry_request.result_type IS NULL
          AND retry_request.result_id IS NULL
          AND retry_request.created_at_ms =
            NEW.updated_at_ms
          AND retry_request.completed_at_ms IS NULL
          AND retry_request.expires_at_ms >
            NEW.updated_at_ms
          AND users.status = 'active'
          AND actor_membership.status = 'active'
          AND (
            (
              actor_membership.permission_category =
                'commissioner'
              AND EXISTS (
                SELECT 1
                FROM leagues
                WHERE leagues.id = NEW.league_id
                  AND leagues.commissioner_membership_id =
                    actor_membership.id
              )
            )
            OR EXISTS (
              SELECT 1
              FROM platform_roles
              WHERE platform_roles.user_id =
                  retry_request.actor_user_id
                AND platform_roles.role =
                  'platform_administrator'
                AND platform_roles.status = 'active'
            )
          )
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
        WHERE correction.league_id = NEW.league_id
          AND correction.season_id = NEW.season_id
          AND correction.readiness_operation_id = (
            SELECT readiness.id
            FROM free_agent_draft_readiness_operations
              AS readiness
            WHERE readiness.league_id = OLD.league_id
              AND readiness.job_run_id = OLD.id
          )
          AND correction.job_run_id = OLD.id
          AND correction.occurrence_key = OLD.occurrence_key
          AND correction.correction_kind =
            'matchup_schedule_created'
          AND correction.attempt_count = OLD.attempt_count
          AND correction.readiness_version_before =
            OLD.version
          AND correction.readiness_version_after =
            correction.readiness_version_before + 1
          AND correction.job_version_before = OLD.version
          AND correction.job_version_after = NEW.version
          AND correction.blockers_json = (
            SELECT readiness.blockers_json
            FROM free_agent_draft_readiness_operations
              AS readiness
            WHERE readiness.league_id = OLD.league_id
              AND readiness.job_run_id = OLD.id
          )
          AND correction.blocked_at_ms =
            OLD.completed_at_ms
          AND correction.previous_next_retry_at_ms =
            OLD.next_attempt_at_ms
          AND correction.requeued_at_ms =
            NEW.updated_at_ms
          AND command_result.action = 'generate'
          AND command_result.idempotency_operation =
            'matchup.schedule.generate.v1'
          AND command_result.created_at_ms =
            NEW.updated_at_ms
          AND command_request.operation =
            'matchup.schedule.generate.v1'
          AND command_request.status = 'started'
          AND command_request.result_type IS NULL
          AND command_request.result_id IS NULL
          AND command_request.completed_at_ms IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'readiness failed job may only requeue from exact retry or corrective evidence'
  ) END;
END;

DROP TRIGGER IF EXISTS free_agent_draft_readiness_operations_forward_update;

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
          FROM outbox_events
          WHERE outbox_events.league_id = NEW.league_id
            AND outbox_events.id =
              NEW.cards_opened_outbox_event_id
            AND outbox_events.event_type = 'fad_cards_opened'
            AND outbox_events.aggregate_type =
              'free_agent_draft'
            AND outbox_events.aggregate_id =
              NEW.created_fad_id
            AND outbox_events.created_at_ms =
              NEW.terminal_at_ms
            AND EXISTS (
              SELECT 1
              FROM outbox_event_audiences
              WHERE outbox_event_audiences.league_id =
                  outbox_events.league_id
                AND outbox_event_audiences.outbox_event_id =
                  outbox_events.id
                AND outbox_event_audiences.audience_kind =
                  'league'
                AND outbox_event_audiences.created_at_ms =
                  NEW.terminal_at_ms
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_teams
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
              NEW.league_id
            AND free_agent_draft_teams.fad_id =
              NEW.created_fad_id
            AND team_manager_assignments.status = 'accepted'
            AND team_manager_assignments.ended_at_ms IS NULL
            AND league_memberships.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM notifications
              WHERE notifications.league_id = NEW.league_id
                AND notifications.user_id =
                  team_manager_assignments.user_id
                AND notifications.event_type =
                  'fad_cards_opened'
                AND notifications.related_feature =
                  'free_agent_draft'
                AND notifications.related_record_id =
                  NEW.created_fad_id
                AND notifications.created_at_ms =
                  NEW.terminal_at_ms
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD readiness must open every team and seven windows or none'
  ) END;
END;

CREATE TRIGGER idempotency_requests_matchup_schedule_corrective_requeue_complete
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation = 'matchup.schedule.generate.v1'
  AND OLD.status = 'started'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN
    EXISTS (
      SELECT 1
      FROM matchup_schedule_command_results AS command_result
      JOIN free_agent_draft_readiness_corrective_requeues
        AS correction
        ON correction.league_id = command_result.league_id
       AND correction.season_id = command_result.season_id
       AND correction.matchup_schedule_command_result_id =
         command_result.id
      WHERE command_result.league_id = OLD.league_id
        AND command_result.idempotency_request_id = OLD.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM matchup_schedule_command_results AS command_result
      JOIN free_agent_draft_readiness_corrective_requeues
        AS correction
        ON correction.league_id = command_result.league_id
       AND correction.season_id = command_result.season_id
       AND correction.matchup_schedule_command_result_id =
         command_result.id
      JOIN season_matchup_schedule_generations AS generation
        ON generation.league_id = correction.league_id
       AND generation.season_id = correction.season_id
       AND generation.schedule_operation_id =
         correction.schedule_operation_id
       AND generation.schedule_version =
         correction.schedule_version
      JOIN free_agent_draft_readiness_operations AS readiness
        ON readiness.league_id = correction.league_id
       AND readiness.season_id = correction.season_id
       AND readiness.id = correction.readiness_operation_id
      JOIN job_runs
        ON job_runs.league_id = correction.league_id
       AND job_runs.season_id = correction.season_id
       AND job_runs.id = correction.job_run_id
       AND job_runs.occurrence_key = correction.occurrence_key
      WHERE command_result.league_id = NEW.league_id
        AND command_result.idempotency_request_id = NEW.id
        AND command_result.id = NEW.result_id
        AND NEW.result_type = 'matchup_schedule_command'
        AND NEW.completed_at_ms = correction.requeued_at_ms
        AND command_result.action = 'generate'
        AND command_result.idempotency_operation =
          'matchup.schedule.generate.v1'
        AND command_result.new_schedule_operation_id =
          correction.schedule_operation_id
        AND command_result.new_schedule_version =
          correction.schedule_version
        AND command_result.created_at_ms =
          correction.requeued_at_ms
        AND generation.status = 'current'
        AND generation.created_at_ms =
          correction.requeued_at_ms
        AND generation.version = 1
        AND readiness.trigger_kind = 'no_draft_inaugural'
        AND readiness.entry_draft_id IS NULL
        AND readiness.setup_exemption_id IS NULL
        AND readiness.job_run_id = correction.job_run_id
        AND readiness.readiness_occurrence_key =
          correction.occurrence_key
        AND readiness.status = 'blocked'
        AND readiness.attempt_count = correction.attempt_count
        AND readiness.lease_owner IS NULL
        AND readiness.lease_token IS NULL
        AND readiness.lease_expires_at_ms IS NULL
        AND readiness.blockers_json =
          correction.blockers_json
        AND readiness.matchup_schedule_version_before IS NULL
        AND readiness.matchup_schedule_version_after IS NULL
        AND readiness.schedule_recovery_id IS NULL
        AND readiness.created_fad_id IS NULL
        AND readiness.reminder_job_run_id IS NULL
        AND readiness.deadline_job_run_id IS NULL
        AND readiness.cards_opened_activity_id IS NULL
        AND readiness.cards_opened_outbox_event_id IS NULL
        AND readiness.started_at_ms IS NOT NULL
        AND readiness.next_retry_at_ms =
          correction.requeued_at_ms
        AND readiness.terminal_at_ms =
          correction.blocked_at_ms
        AND readiness.created_at_ms =
          job_runs.scheduled_for_ms
        AND readiness.updated_at_ms =
          correction.requeued_at_ms
        AND readiness.version =
          correction.readiness_version_after
        AND job_runs.job_type = 'fad_readiness'
        AND job_runs.status = 'pending'
        AND job_runs.attempt_count = correction.attempt_count
        AND job_runs.lease_owner IS NULL
        AND job_runs.lease_token IS NULL
        AND job_runs.lease_expires_at_ms IS NULL
        AND job_runs.started_at_ms IS NULL
        AND job_runs.completed_at_ms IS NULL
        AND job_runs.result_json IS NULL
        AND job_runs.last_error_code IS NULL
        AND job_runs.next_attempt_at_ms =
          correction.requeued_at_ms
        AND job_runs.created_at_ms = readiness.created_at_ms
        AND job_runs.updated_at_ms =
          correction.requeued_at_ms
        AND job_runs.version = correction.job_version_after
        AND correction.readiness_version_after =
          correction.job_version_after
    )
  THEN RAISE(
    ABORT,
    'matchup schedule corrective requeue must complete with exact pending readiness'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '33',
    updated_at_ms = CASE
      WHEN updated_at_ms < 33 THEN 33
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '32';
