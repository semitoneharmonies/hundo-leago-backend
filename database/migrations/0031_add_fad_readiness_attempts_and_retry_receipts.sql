-- Schema 31 adds immutable automatic-readiness attempt snapshots and exact
-- idempotent commissioner-retry receipts. It does not execute readiness,
-- open Candidate Cards, or create any operational row. Migration 0030 remains
-- byte-for-byte frozen.

CREATE TABLE free_agent_draft_readiness_attempts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  readiness_operation_id TEXT NOT NULL,
  job_run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  observed_readiness_version INTEGER NOT NULL
    CHECK (observed_readiness_version >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('blocked', 'succeeded')),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= observed_at_ms),
  projection_json TEXT NOT NULL
    CHECK (
      json_valid(projection_json) = 1
      AND json_type(projection_json) = 'object'
      AND json(projection_json) = projection_json
    ),
  projection_sha256 TEXT NOT NULL
    CHECK (
      length(projection_sha256) = 64
      AND projection_sha256 = lower(projection_sha256)
      AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, readiness_operation_id, attempt_number),
  UNIQUE (league_id, job_run_id, attempt_number),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, readiness_operation_id)
    REFERENCES free_agent_draft_readiness_operations(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX free_agent_draft_readiness_attempts_operation_latest
  ON free_agent_draft_readiness_attempts (
    league_id,
    readiness_operation_id,
    attempt_number DESC
  );

CREATE TABLE free_agent_draft_readiness_retry_receipts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  readiness_operation_id TEXT NOT NULL,
  idempotency_request_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_from_version INTEGER NOT NULL
    CHECK (accepted_from_version >= 1),
  resulting_readiness_version INTEGER NOT NULL
    CHECK (resulting_readiness_version = accepted_from_version + 1),
  retry_attempt_number INTEGER NOT NULL
    CHECK (retry_attempt_number >= 1),
  job_run_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL
    CHECK (
      occurrence_key = trim(occurrence_key)
      AND length(occurrence_key) BETWEEN 1 AND 500
    ),
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
  response_http_status INTEGER NOT NULL
    CHECK (response_http_status = 202),
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
  UNIQUE (
    league_id,
    readiness_operation_id,
    resulting_readiness_version
  ),
  UNIQUE (
    league_id,
    readiness_operation_id,
    retry_attempt_number
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, readiness_operation_id)
    REFERENCES free_agent_draft_readiness_operations(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX free_agent_draft_readiness_retry_receipts_operation_latest
  ON free_agent_draft_readiness_retry_receipts (
    league_id,
    readiness_operation_id,
    retry_attempt_number DESC
  );

CREATE TRIGGER free_agent_draft_readiness_attempts_valid_insert
BEFORE INSERT ON free_agent_draft_readiness_attempts
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_readiness_operations AS readiness
      JOIN seasons
        ON seasons.league_id = readiness.league_id
       AND seasons.id = readiness.season_id
      JOIN job_runs
        ON job_runs.league_id = readiness.league_id
       AND job_runs.season_id = readiness.season_id
       AND job_runs.id = readiness.job_run_id
       AND job_runs.occurrence_key = readiness.readiness_occurrence_key
      WHERE readiness.league_id = NEW.league_id
        AND readiness.season_id = NEW.season_id
        AND readiness.id = NEW.readiness_operation_id
        AND readiness.job_run_id = NEW.job_run_id
        AND readiness.status = 'running'
        AND readiness.attempt_count = NEW.attempt_number
        AND readiness.version = NEW.observed_readiness_version
        AND seasons.version = json_extract(
          NEW.projection_json,
          '$.observedSeasonVersion'
        )
        AND job_runs.job_type = 'fad_readiness'
        AND job_runs.status = 'running'
        AND job_runs.attempt_count = NEW.attempt_number
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms > NEW.observed_at_ms
        AND job_runs.started_at_ms IS NOT NULL
        AND job_runs.started_at_ms <= NEW.observed_at_ms
        AND NEW.observed_at_ms >= readiness.started_at_ms
    )
    AND (SELECT COUNT(*) FROM json_each(NEW.projection_json)) = 12
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.projection_json) AS member
      WHERE member.key NOT IN (
        'observedSeasonVersion',
        'firstMatchupWeekBefore',
        'firstMatchupWeekAfter',
        'candidateDeadlineAtMs',
        'reminderAtMs',
        'helpOpensAtMs',
        'initialRollovers',
        'priorSeasonRollover',
        'participatingTeamCount',
        'teamProjections',
        'blockers',
        'warnings'
      )
    )
    AND json_type(
      NEW.projection_json,
      '$.observedSeasonVersion'
    ) = 'integer'
    AND json_extract(
      NEW.projection_json,
      '$.observedSeasonVersion'
    ) >= 1
    AND json_type(
      NEW.projection_json,
      '$.firstMatchupWeekBefore'
    ) IN ('object', 'null')
    AND json_type(
      NEW.projection_json,
      '$.firstMatchupWeekAfter'
    ) IN ('object', 'null')
    AND json_type(
      NEW.projection_json,
      '$.candidateDeadlineAtMs'
    ) IN ('integer', 'null')
    AND json_type(
      NEW.projection_json,
      '$.reminderAtMs'
    ) IN ('integer', 'null')
    AND json_type(
      NEW.projection_json,
      '$.helpOpensAtMs'
    ) IN ('integer', 'null')
    AND json_type(
      NEW.projection_json,
      '$.initialRollovers'
    ) = 'array'
    AND json_type(
      NEW.projection_json,
      '$.priorSeasonRollover'
    ) IN ('object', 'null')
    AND json_type(
      NEW.projection_json,
      '$.participatingTeamCount'
    ) = 'integer'
    AND json_extract(
      NEW.projection_json,
      '$.participatingTeamCount'
    ) >= 0
    AND json_type(
      NEW.projection_json,
      '$.teamProjections'
    ) = 'array'
    AND json_type(NEW.projection_json, '$.blockers') = 'array'
    AND json_type(NEW.projection_json, '$.warnings') = 'array'
    AND (
      (
        json_type(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) = 'null'
        AND json_type(
          NEW.projection_json,
          '$.reminderAtMs'
        ) = 'null'
        AND json_type(
          NEW.projection_json,
          '$.helpOpensAtMs'
        ) = 'null'
        AND json_array_length(
          json_extract(NEW.projection_json, '$.initialRollovers')
        ) = 0
      )
      OR (
        json_type(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) = 'integer'
        AND json_type(
          NEW.projection_json,
          '$.reminderAtMs'
        ) = 'integer'
        AND json_type(
          NEW.projection_json,
          '$.helpOpensAtMs'
        ) = 'integer'
        AND json_extract(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) >= 0
        AND json_extract(
          NEW.projection_json,
          '$.reminderAtMs'
        ) = json_extract(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        ) - 259200000
        AND json_extract(
          NEW.projection_json,
          '$.helpOpensAtMs'
        ) BETWEEN 0 AND json_extract(
          NEW.projection_json,
          '$.candidateDeadlineAtMs'
        )
        AND json_array_length(
          json_extract(NEW.projection_json, '$.initialRollovers')
        ) = 7
      )
    )
    AND json_array_length(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) = json_extract(
      NEW.projection_json,
      '$.participatingTeamCount'
    )
    AND (
      (
        NEW.outcome = 'blocked'
        AND json_array_length(
          json_extract(NEW.projection_json, '$.blockers')
        ) >= 1
      )
      OR (
        NEW.outcome = 'succeeded'
        AND json_extract(NEW.projection_json, '$.blockers') = '[]'
      )
    )
  ) THEN RAISE(
    ABORT,
    'readiness attempt must bind the exact active operation, job, and public projection'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(
        NEW.projection_json,
        '$.firstMatchupWeekBefore'
      ) AS projection_json_value
      UNION ALL
      SELECT json_extract(
        NEW.projection_json,
        '$.firstMatchupWeekAfter'
      )
    ) AS week_projection
    WHERE week_projection.projection_json_value IS NOT NULL
      AND NOT (
        (
          SELECT COUNT(*)
          FROM json_each(week_projection.projection_json_value)
        ) = 4
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            week_projection.projection_json_value
          ) AS member
          WHERE member.key NOT IN (
            'weekId', 'sequence', 'startsAtMs', 'version'
          )
        )
        AND json_type(
          week_projection.projection_json_value,
          '$.weekId'
        ) = 'text'
        AND length(json_extract(
          week_projection.projection_json_value,
          '$.weekId'
        )) = 36
        AND json_extract(
          week_projection.projection_json_value,
          '$.weekId'
        ) = lower(json_extract(
          week_projection.projection_json_value,
          '$.weekId'
        ))
        AND json_type(
          week_projection.projection_json_value,
          '$.sequence'
        ) = 'integer'
        AND json_extract(
          week_projection.projection_json_value,
          '$.sequence'
        ) >= 1
        AND json_type(
          week_projection.projection_json_value,
          '$.startsAtMs'
        ) = 'integer'
        AND json_extract(
          week_projection.projection_json_value,
          '$.startsAtMs'
        ) >= 0
        AND json_type(
          week_projection.projection_json_value,
          '$.version'
        ) = 'integer'
        AND json_extract(
          week_projection.projection_json_value,
          '$.version'
        ) >= 1
      )
  ) THEN RAISE(
    ABORT,
    'readiness Week 1 projections require the exact safe shape'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(NEW.projection_json, '$.initialRollovers')
    ) AS rollover
    WHERE rollover.type <> 'object'
      OR (SELECT COUNT(*) FROM json_each(rollover.value)) <> 4
      OR EXISTS (
        SELECT 1
        FROM json_each(rollover.value) AS member
        WHERE member.key NOT IN (
          'sequence',
          'opensAtMs',
          'creationCutoffAtMs',
          'rollsOverAtMs'
        )
      )
      OR json_type(rollover.value, '$.sequence') <> 'integer'
      OR json_type(rollover.value, '$.opensAtMs') <> 'integer'
      OR json_type(
        rollover.value,
        '$.creationCutoffAtMs'
      ) <> 'integer'
      OR json_type(rollover.value, '$.rollsOverAtMs') <> 'integer'
      OR json_extract(rollover.value, '$.sequence') <>
        CAST(rollover.key AS INTEGER) + 1
      OR json_extract(rollover.value, '$.opensAtMs') < 0
      OR json_extract(rollover.value, '$.rollsOverAtMs') <>
        json_extract(rollover.value, '$.opensAtMs') + 86400000
      OR json_extract(
        rollover.value,
        '$.creationCutoffAtMs'
      ) <> json_extract(
        rollover.value,
        '$.rollsOverAtMs'
      ) - 3600000
      OR (
        CAST(rollover.key AS INTEGER) = 0
        AND json_extract(rollover.value, '$.opensAtMs') <>
          json_extract(
            NEW.projection_json,
            '$.candidateDeadlineAtMs'
          )
      )
      OR (
        CAST(rollover.key AS INTEGER) > 0
        AND json_extract(rollover.value, '$.opensAtMs') <>
          json_extract(
            NEW.projection_json,
            '$.initialRollovers[' ||
              (CAST(rollover.key AS INTEGER) - 1) ||
              '].rollsOverAtMs'
          )
      )
  ) THEN RAISE(
    ABORT,
    'readiness rollover projection requires seven exact windows'
  ) END;

  SELECT CASE WHEN
    json_type(
      NEW.projection_json,
      '$.priorSeasonRollover'
    ) = 'object'
    AND NOT (
      (
        SELECT COUNT(*)
        FROM json_each(json_extract(
          NEW.projection_json,
          '$.priorSeasonRollover'
        ))
      ) = 5
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(
          NEW.projection_json,
          '$.priorSeasonRollover'
        )) AS member
        WHERE member.key NOT IN (
          'rolloverId',
          'fromSeasonId',
          'toSeasonId',
          'completedAtMs',
          'manifestSha256'
        )
      )
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.rolloverId'
      ) = 'text'
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.fromSeasonId'
      ) = 'text'
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.toSeasonId'
      ) = 'text'
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.toSeasonId'
      ) = NEW.season_id
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.completedAtMs'
      ) = 'integer'
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.completedAtMs'
      ) >= 0
      AND json_type(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ) = 'text'
      AND length(json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      )) = 64
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ) = lower(json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ))
      AND json_extract(
        NEW.projection_json,
        '$.priorSeasonRollover.manifestSha256'
      ) NOT GLOB '*[^0-9a-f]*'
    )
  THEN RAISE(
    ABORT,
    'prior-season rollover projection requires the exact safe shape'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) AS projection
    WHERE projection.type <> 'object'
      OR (SELECT COUNT(*) FROM json_each(projection.value)) <> 9
      OR EXISTS (
        SELECT 1
        FROM json_each(projection.value) AS member
        WHERE member.key NOT IN (
          'teamId',
          'team',
          'managerReady',
          'managerAssignmentId',
          'carryoverCount',
          'openForwardSlots',
          'openDefenceSlots',
          'openBenchSlots',
          'structuralConflictCount'
        )
      )
      OR json_type(projection.value, '$.teamId') <> 'text'
      OR json_type(projection.value, '$.team') <> 'object'
      OR (
        SELECT COUNT(*)
        FROM json_each(json_extract(projection.value, '$.team'))
      ) <> 7
      OR EXISTS (
        SELECT 1
        FROM json_each(json_extract(projection.value, '$.team')) AS member
        WHERE member.key NOT IN (
          'teamId',
          'name',
          'primaryColour',
          'secondaryColour',
          'tertiaryColour',
          'patternTemplate',
          'logoReference'
        )
      )
      OR json_extract(projection.value, '$.team.teamId') IS NOT
        json_extract(projection.value, '$.teamId')
      OR json_type(projection.value, '$.team.teamId') <> 'text'
      OR json_type(projection.value, '$.team.name') <> 'text'
      OR json_type(projection.value, '$.team.primaryColour') <> 'text'
      OR json_type(projection.value, '$.team.secondaryColour') <> 'text'
      OR json_type(
        projection.value,
        '$.team.tertiaryColour'
      ) NOT IN ('text', 'null')
      OR json_type(
        projection.value,
        '$.team.patternTemplate'
      ) <> 'text'
      OR json_type(
        projection.value,
        '$.team.logoReference'
      ) NOT IN ('text', 'null')
      OR json_type(projection.value, '$.managerReady') NOT IN (
        'true', 'false'
      )
      OR json_type(
        projection.value,
        '$.managerAssignmentId'
      ) NOT IN ('text', 'null')
      OR (
        json_extract(projection.value, '$.managerReady') = 1
        AND json_type(
          projection.value,
          '$.managerAssignmentId'
        ) <> 'text'
      )
      OR (
        json_extract(projection.value, '$.managerReady') = 0
        AND json_type(
          projection.value,
          '$.managerAssignmentId'
        ) <> 'null'
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(projection.value) AS count_member
        WHERE count_member.key IN (
          'carryoverCount',
          'openForwardSlots',
          'openDefenceSlots',
          'openBenchSlots',
          'structuralConflictCount'
        )
          AND (
            count_member.type <> 'integer'
            OR count_member.atom < 0
          )
      )
  ) THEN RAISE(
    ABORT,
    'readiness team projections require the exact safe shape'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) AS current_projection
    JOIN json_each(
      json_extract(NEW.projection_json, '$.teamProjections')
    ) AS prior_projection
      ON CAST(prior_projection.key AS INTEGER) =
        CAST(current_projection.key AS INTEGER) - 1
    WHERE json_extract(current_projection.value, '$.teamId') <=
      json_extract(prior_projection.value, '$.teamId')
  ) THEN RAISE(
    ABORT,
    'readiness team projections must be unique and stably ordered'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(NEW.projection_json, '$.blockers') AS value
      UNION ALL
      SELECT json_extract(NEW.projection_json, '$.warnings')
    ) AS diagnostics,
    json_each(diagnostics.value) AS diagnostic
    WHERE diagnostic.type <> 'object'
      OR (SELECT COUNT(*) FROM json_each(diagnostic.value)) <> 3
      OR EXISTS (
        SELECT 1
        FROM json_each(diagnostic.value) AS member
        WHERE member.key NOT IN (
          'code', 'message', 'resourceId'
        )
      )
      OR json_type(diagnostic.value, '$.code') <> 'text'
      OR length(json_extract(diagnostic.value, '$.code'))
        NOT BETWEEN 1 AND 100
      OR json_extract(diagnostic.value, '$.code')
        GLOB '*[^A-Z0-9_]*'
      OR json_type(diagnostic.value, '$.message') <> 'text'
      OR length(json_extract(diagnostic.value, '$.message'))
        NOT BETWEEN 1 AND 500
      OR json_type(diagnostic.value, '$.resourceId')
        NOT IN ('text', 'null')
  ) THEN RAISE(
    ABORT,
    'readiness public diagnostics require the exact safe shape'
  ) END;
END;

CREATE TRIGGER free_agent_draft_readiness_attempts_immutable_update
BEFORE UPDATE ON free_agent_draft_readiness_attempts
BEGIN
  SELECT RAISE(ABORT, 'FAD readiness attempts are immutable');
END;

CREATE TRIGGER free_agent_draft_readiness_attempts_immutable_delete
BEFORE DELETE ON free_agent_draft_readiness_attempts
BEGIN
  SELECT RAISE(ABORT, 'FAD readiness attempts are immutable');
END;

CREATE TRIGGER free_agent_draft_readiness_retry_receipts_valid_insert
BEFORE INSERT ON free_agent_draft_readiness_retry_receipts
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_readiness_operations AS readiness
      JOIN job_runs
        ON job_runs.league_id = readiness.league_id
       AND job_runs.season_id = readiness.season_id
       AND job_runs.id = readiness.job_run_id
       AND job_runs.occurrence_key = readiness.readiness_occurrence_key
      WHERE readiness.league_id = NEW.league_id
        AND readiness.season_id = NEW.season_id
        AND readiness.id = NEW.readiness_operation_id
        AND readiness.job_run_id = NEW.job_run_id
        AND readiness.readiness_occurrence_key = NEW.occurrence_key
        AND readiness.status = 'blocked'
        AND readiness.version = NEW.accepted_from_version
        AND NEW.retry_attempt_number = readiness.attempt_count + 1
        AND job_runs.job_type = 'fad_readiness'
        AND job_runs.scheduled_for_ms = readiness.created_at_ms
        AND job_runs.status = 'pending'
        AND job_runs.attempt_count = readiness.attempt_count
        AND NEW.retry_attempt_number = job_runs.attempt_count + 1
        AND job_runs.lease_owner IS NULL
        AND job_runs.lease_token IS NULL
        AND job_runs.lease_expires_at_ms IS NULL
        AND job_runs.started_at_ms IS NULL
        AND job_runs.completed_at_ms IS NULL
        AND job_runs.result_json IS NULL
        AND job_runs.last_error_code IS NULL
        AND job_runs.next_attempt_at_ms = NEW.accepted_at_ms
        AND job_runs.updated_at_ms = NEW.accepted_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id = NEW.idempotency_request_id
        AND idempotency_requests.actor_user_id = NEW.actor_user_id
        AND idempotency_requests.operation =
          'free_agent_draft.readiness.retry.v1'
        AND idempotency_requests.request_hash = NEW.request_sha256
        AND idempotency_requests.status = 'started'
        AND idempotency_requests.result_type IS NULL
        AND idempotency_requests.result_id IS NULL
        AND idempotency_requests.completed_at_ms IS NULL
        AND idempotency_requests.created_at_ms <= NEW.accepted_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id = NEW.actor_membership_id
        AND league_memberships.user_id = NEW.actor_user_id
        AND league_memberships.status = 'active'
        AND (
          (
            NEW.actor_authority = 'commissioner'
            AND league_memberships.permission_category = 'commissioner'
            AND EXISTS (
              SELECT 1
              FROM leagues
              WHERE leagues.id = NEW.league_id
                AND leagues.commissioner_membership_id =
                  NEW.actor_membership_id
            )
          )
          OR (
            NEW.actor_authority =
              'platform_administrator_as_commissioner'
            AND EXISTS (
              SELECT 1
              FROM platform_roles
              WHERE platform_roles.user_id = NEW.actor_user_id
                AND platform_roles.role = 'platform_administrator'
                AND platform_roles.status = 'active'
            )
          )
        )
    )
    AND NEW.response_json = json_object(
      'acceptedAtMs', NEW.accepted_at_ms,
      'acceptedFromVersion', NEW.accepted_from_version,
      'jobRunId', NEW.job_run_id,
      'leagueId', NEW.league_id,
      'occurrenceKey', NEW.occurrence_key,
      'readinessOperationId', NEW.readiness_operation_id,
      'resultingReadinessVersion', NEW.resulting_readiness_version,
      'retryAttemptNumber', NEW.retry_attempt_number,
      'retryReceiptId', NEW.id,
      'seasonId', NEW.season_id,
      'status', 'accepted'
    )
  ) THEN RAISE(
    ABORT,
    'readiness retry receipt must bind the exact request, actor, operation, and pending job'
  ) END;
END;

CREATE TRIGGER free_agent_draft_readiness_retry_receipts_immutable_update
BEFORE UPDATE ON free_agent_draft_readiness_retry_receipts
BEGIN
  SELECT RAISE(ABORT, 'FAD readiness retry receipts are immutable');
END;

CREATE TRIGGER free_agent_draft_readiness_retry_receipts_immutable_delete
BEFORE DELETE ON free_agent_draft_readiness_retry_receipts
BEGIN
  SELECT RAISE(ABORT, 'FAD readiness retry receipts are immutable');
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
        AND EXISTS (
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

UPDATE application_metadata
SET metadata_value = '31',
    updated_at_ms = CASE
      WHEN updated_at_ms < 31 THEN 31
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '30';
