-- Schema 36 adds immutable provider-catalog eligibility revalidation
-- occurrences. One row binds one semantic player delta to one open FAD and
-- one exact shared-lease job. The provider catalog transaction writes its
-- occurrences first, their jobs second, and the catalog operational event
-- last; deferred foreign keys and the sealing trigger make that whole batch
-- atomic without a second manifest table.

CREATE UNIQUE INDEX player_source_state_fad_eligibility_evidence
  ON player_source_state (player_id, id);

CREATE TABLE free_agent_draft_eligibility_revalidation_occurrences (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_operation_id TEXT NOT NULL,
  source_provider TEXT NOT NULL
    CHECK (
      source_provider = trim(source_provider)
      AND length(source_provider) BETWEEN 1 AND 80
    ),
  player_version_before INTEGER NOT NULL
    CHECK (player_version_before >= 1),
  player_version_after INTEGER NOT NULL
    CHECK (player_version_after >= 1),
  player_status_before TEXT NOT NULL
    CHECK (player_status_before IN ('active', 'historical')),
  player_status_after TEXT NOT NULL
    CHECK (player_status_after IN ('active', 'historical')),
  source_state_before_id TEXT
    CHECK (
      source_state_before_id IS NULL
      OR (
        length(source_state_before_id) = 36
        AND source_state_before_id = lower(source_state_before_id)
      )
    ),
  source_state_after_id TEXT NOT NULL
    CHECK (
      length(source_state_after_id) = 36
      AND source_state_after_id = lower(source_state_after_id)
    ),
  source_resolved_position_group_before TEXT
    CHECK (
      source_resolved_position_group_before IS NULL
      OR source_resolved_position_group_before IN ('F', 'D')
    ),
  source_resolved_position_group_after TEXT
    CHECK (
      source_resolved_position_group_after IS NULL
      OR source_resolved_position_group_after IN ('F', 'D')
    ),
  league_position_override_id TEXT
    CHECK (
      league_position_override_id IS NULL
      OR (
        length(league_position_override_id) = 36
        AND league_position_override_id =
          lower(league_position_override_id)
      )
    ),
  effective_position_group_before TEXT
    CHECK (
      effective_position_group_before IS NULL
      OR effective_position_group_before IN ('F', 'D')
    ),
  effective_position_group_after TEXT
    CHECK (
      effective_position_group_after IS NULL
      OR effective_position_group_after IN ('F', 'D')
    ),
  eligibility_delta_sha256 TEXT NOT NULL
    CHECK (
      length(eligibility_delta_sha256) = 64
      AND eligibility_delta_sha256 = lower(eligibility_delta_sha256)
      AND eligibility_delta_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  job_run_id TEXT NOT NULL
    CHECK (length(job_run_id) = 36 AND job_run_id = lower(job_run_id)),
  occurrence_key TEXT NOT NULL
    CHECK (
      occurrence_key =
        'fad:' || fad_id || ':eligibility-revalidate:' ||
        player_id || ':' || source_operation_id
    ),
  scheduled_for_ms INTEGER NOT NULL CHECK (scheduled_for_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, job_run_id),
  UNIQUE (league_id, occurrence_key),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    player_id,
    source_operation_id
  ),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (player_id, source_state_before_id)
    REFERENCES player_source_state(player_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (player_id, source_state_after_id)
    REFERENCES player_source_state(player_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, league_position_override_id)
    REFERENCES league_player_positions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (source_operation_id)
    REFERENCES operational_events(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (scheduled_for_ms = created_at_ms),
  CHECK (
    player_version_after = player_version_before
    OR player_version_after = player_version_before + 1
  ),
  CHECK (
    player_status_before IS NOT player_status_after
    OR effective_position_group_before IS NOT
      effective_position_group_after
  )
) STRICT;

CREATE INDEX free_agent_draft_eligibility_revalidation_source
  ON free_agent_draft_eligibility_revalidation_occurrences (
    source_operation_id,
    player_id,
    league_id,
    fad_id
  );

CREATE INDEX free_agent_draft_eligibility_revalidation_barrier
  ON free_agent_draft_eligibility_revalidation_occurrences (
    league_id,
    season_id,
    fad_id,
    job_run_id
  );

CREATE TRIGGER free_agent_draft_eligibility_revalidation_valid_insert
BEFORE INSERT
  ON free_agent_draft_eligibility_revalidation_occurrences
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.scheduled_for_ms = NEW.created_at_ms
    AND NOT EXISTS (
      SELECT 1
      FROM operational_events AS source_operation
      WHERE source_operation.id = NEW.source_operation_id
    )
    AND EXISTS (
      SELECT 1
      FROM players AS player
      WHERE player.id = NEW.player_id
        AND player.version = NEW.player_version_after
        AND player.status = NEW.player_status_after
    )
    AND (
      (
        NEW.player_status_before = NEW.player_status_after
        AND NEW.player_version_after IN (
          NEW.player_version_before,
          NEW.player_version_before + 1
        )
      )
      OR (
        NEW.player_status_before <> NEW.player_status_after
        AND NEW.player_version_after = NEW.player_version_before + 1
      )
    )
    AND (
      NEW.source_state_before_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM player_source_state AS source_before
        WHERE source_before.player_id = NEW.player_id
          AND source_before.id = NEW.source_state_before_id
      )
    )
    AND EXISTS (
      SELECT 1
      FROM player_source_state AS source_after
      WHERE source_after.player_id = NEW.player_id
        AND source_after.id = NEW.source_state_after_id
        AND source_after.ended_at_ms IS NULL
    )
    AND NEW.source_resolved_position_group_after IS (
      SELECT CASE
        WHEN COUNT(DISTINCT source.normalized_position) = 1
        THEN MIN(source.normalized_position)
        ELSE NULL
      END
      FROM player_source_state AS source
      WHERE source.player_id = NEW.player_id
        AND source.ended_at_ms IS NULL
        AND source.active = 1
        AND source.normalized_position IN ('F', 'D')
    )
    AND (
      (
        NEW.league_position_override_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM league_player_positions AS position_override
          WHERE position_override.league_id = NEW.league_id
            AND position_override.player_id = NEW.player_id
            AND position_override.ended_at_ms IS NULL
        )
        AND NEW.effective_position_group_before IS
          NEW.source_resolved_position_group_before
        AND NEW.effective_position_group_after IS
          NEW.source_resolved_position_group_after
      )
      OR EXISTS (
        SELECT 1
        FROM league_player_positions AS position_override
        WHERE position_override.league_id = NEW.league_id
          AND position_override.player_id = NEW.player_id
          AND position_override.id = NEW.league_position_override_id
          AND position_override.ended_at_ms IS NULL
          AND NEW.effective_position_group_before =
            position_override.position_group
          AND NEW.effective_position_group_after =
            position_override.position_group
      )
    )
    AND (
      NEW.player_status_before IS NOT NEW.player_status_after
      OR NEW.effective_position_group_before IS NOT
        NEW.effective_position_group_after
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts AS fad
      JOIN candidate_cards AS card
        ON card.league_id = fad.league_id
       AND card.season_id = fad.season_id
       AND card.fad_id = fad.id
       AND card.status = 'open'
      JOIN candidate_card_entries AS entry
        ON entry.league_id = card.league_id
       AND entry.season_id = card.season_id
       AND entry.fad_id = card.fad_id
       AND entry.card_id = card.id
       AND entry.team_id = card.team_id
       AND entry.player_id = NEW.player_id
      WHERE fad.league_id = NEW.league_id
        AND fad.season_id = NEW.season_id
        AND fad.id = NEW.fad_id
        AND fad.status = 'cards_open'
        AND fad.opened_at_ms <= NEW.created_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'FAD eligibility revalidation must bind an unsealed semantic player delta in an affected open FAD'
  ) END;
END;

CREATE TRIGGER job_runs_fad_eligibility_revalidation_valid_insert
BEFORE INSERT ON job_runs
WHEN NEW.job_type = 'fad_eligibility_revalidation'
  OR instr(NEW.occurrence_key, ':eligibility-revalidate:') > 0
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    WHERE occurrence.league_id = NEW.league_id
      AND occurrence.season_id = NEW.season_id
      AND occurrence.job_run_id = NEW.id
      AND occurrence.occurrence_key = NEW.occurrence_key
      AND occurrence.scheduled_for_ms = NEW.scheduled_for_ms
      AND occurrence.created_at_ms = NEW.created_at_ms
      AND NEW.job_type = 'fad_eligibility_revalidation'
      AND NEW.status = 'pending'
      AND NEW.attempt_count = 0
      AND NEW.lease_owner IS NULL
      AND NEW.lease_token IS NULL
      AND NEW.lease_expires_at_ms IS NULL
      AND NEW.started_at_ms IS NULL
      AND NEW.completed_at_ms IS NULL
      AND NEW.result_json IS NULL
      AND NEW.last_error_code IS NULL
      AND NEW.next_attempt_at_ms IS NULL
      AND NEW.created_at_ms = NEW.updated_at_ms
      AND NEW.version = 1
  ) THEN RAISE(
    ABORT,
    'FAD eligibility revalidation job must bind its exact pending occurrence'
  ) END;
END;

CREATE TRIGGER operational_events_fad_eligibility_catalog_valid_insert
AFTER INSERT ON operational_events
WHEN NEW.event_type = 'player_catalog_applied'
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    WHERE occurrence.source_operation_id = NEW.id
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.league_id IS NULL
    AND NEW.season_id IS NULL
    AND NEW.event_type = 'player_catalog_applied'
    AND NEW.feature = 'player_data_provider'
    AND NEW.outcome = 'succeeded'
    AND NEW.actor_user_id IS NULL
    AND NEW.reason_code = 'provider_catalog_import'
    AND json_valid(NEW.details_json) = 1
    AND json_type(NEW.details_json) = 'object'
    AND json_type(NEW.details_json, '$.schemaVersion') = 'integer'
    AND json_extract(NEW.details_json, '$.schemaVersion') = 1
    AND json_extract(NEW.details_json, '$.code') =
      'PLAYER_CATALOG_APPLIED'
    AND json_extract(NEW.details_json, '$.sourceOperationId') = NEW.id
    AND json_type(NEW.details_json, '$.provider') = 'text'
    AND json_extract(NEW.details_json, '$.provider') =
      trim(json_extract(NEW.details_json, '$.provider'))
    AND length(json_extract(NEW.details_json, '$.provider')) BETWEEN 1 AND 80
    AND json_type(NEW.details_json, '$.capturedAtMs') = 'integer'
    AND json_extract(NEW.details_json, '$.capturedAtMs') >= 0
    AND json_extract(NEW.details_json, '$.capturedAtMs') <=
      NEW.occurred_at_ms
    AND json_type(NEW.details_json, '$.appliedAtMs') = 'integer'
    AND json_extract(NEW.details_json, '$.appliedAtMs') =
      NEW.occurred_at_ms
    AND json_type(NEW.details_json, '$.requestSha256') = 'text'
    AND length(json_extract(NEW.details_json, '$.requestSha256')) = 64
    AND json_extract(NEW.details_json, '$.requestSha256') =
      lower(json_extract(NEW.details_json, '$.requestSha256'))
    AND json_extract(NEW.details_json, '$.requestSha256')
      NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.details_json, '$.rowCount') = 'integer'
    AND json_extract(NEW.details_json, '$.rowCount') >= 1
    AND json_type(NEW.details_json, '$.createdPlayerCount') = 'integer'
    AND json_extract(NEW.details_json, '$.createdPlayerCount') >= 0
    AND json_type(NEW.details_json, '$.updatedPlayerCount') = 'integer'
    AND json_extract(NEW.details_json, '$.updatedPlayerCount') >= 0
    AND json_extract(NEW.details_json, '$.createdPlayerCount') +
      json_extract(NEW.details_json, '$.updatedPlayerCount') <=
      json_extract(NEW.details_json, '$.rowCount')
    AND json_type(NEW.details_json, '$.sourceStateChangeCount') = 'integer'
    AND json_extract(NEW.details_json, '$.sourceStateChangeCount') >= 0
    AND json_extract(NEW.details_json, '$.sourceStateChangeCount') <=
      json_extract(NEW.details_json, '$.rowCount')
    AND json_type(
      NEW.details_json,
      '$.eligibilityChangedPlayerCount'
    ) = 'integer'
    AND json_extract(
      NEW.details_json,
      '$.eligibilityChangedPlayerCount'
    ) >= 0
    AND json_extract(
      NEW.details_json,
      '$.eligibilityChangedPlayerCount'
    ) <= json_extract(NEW.details_json, '$.rowCount')
    AND json_type(
      NEW.details_json,
      '$.eligibilityRevalidationOccurrenceCount'
    ) = 'integer'
    AND json_extract(
      NEW.details_json,
      '$.eligibilityRevalidationOccurrenceCount'
    ) = (
      SELECT COUNT(*)
      FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
      WHERE occurrence.source_operation_id = NEW.id
    )
    AND json_extract(
      NEW.details_json,
      '$.eligibilityChangedPlayerCount'
    ) >= (
      SELECT COUNT(DISTINCT occurrence.player_id)
      FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
      WHERE occurrence.source_operation_id = NEW.id
    )
    AND NEW.details_json = json_object(
      'schemaVersion', 1,
      'code', 'PLAYER_CATALOG_APPLIED',
      'sourceOperationId', NEW.id,
      'provider', json_extract(NEW.details_json, '$.provider'),
      'capturedAtMs', json_extract(NEW.details_json, '$.capturedAtMs'),
      'appliedAtMs', NEW.occurred_at_ms,
      'requestSha256', json_extract(NEW.details_json, '$.requestSha256'),
      'rowCount', json_extract(NEW.details_json, '$.rowCount'),
      'createdPlayerCount',
        json_extract(NEW.details_json, '$.createdPlayerCount'),
      'updatedPlayerCount',
        json_extract(NEW.details_json, '$.updatedPlayerCount'),
      'sourceStateChangeCount',
        json_extract(NEW.details_json, '$.sourceStateChangeCount'),
      'eligibilityChangedPlayerCount',
        json_extract(
          NEW.details_json,
          '$.eligibilityChangedPlayerCount'
        ),
      'eligibilityRevalidationOccurrenceCount',
        json_extract(
          NEW.details_json,
          '$.eligibilityRevalidationOccurrenceCount'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
      JOIN player_source_state AS source_after
        ON source_after.player_id = occurrence.player_id
       AND source_after.id = occurrence.source_state_after_id
      LEFT JOIN player_source_state AS source_before
        ON source_before.player_id = occurrence.player_id
       AND source_before.id = occurrence.source_state_before_id
      LEFT JOIN job_runs AS job
        ON job.league_id = occurrence.league_id
       AND job.id = occurrence.job_run_id
      WHERE occurrence.source_operation_id = NEW.id
        AND NOT (
          occurrence.source_provider =
            json_extract(NEW.details_json, '$.provider')
          AND occurrence.scheduled_for_ms = NEW.occurred_at_ms
          AND occurrence.created_at_ms = NEW.occurred_at_ms
          AND source_after.provider = occurrence.source_provider
          AND source_after.ended_at_ms IS NULL
          AND (
            occurrence.source_state_before_id IS NULL
            OR source_before.provider = occurrence.source_provider
          )
          AND job.season_id = occurrence.season_id
          AND job.job_type = 'fad_eligibility_revalidation'
          AND job.occurrence_key = occurrence.occurrence_key
          AND job.scheduled_for_ms = occurrence.scheduled_for_ms
          AND job.status = 'pending'
          AND job.attempt_count = 0
          AND job.lease_owner IS NULL
          AND job.lease_token IS NULL
          AND job.lease_expires_at_ms IS NULL
          AND job.started_at_ms IS NULL
          AND job.completed_at_ms IS NULL
          AND job.result_json IS NULL
          AND job.last_error_code IS NULL
          AND job.next_attempt_at_ms IS NULL
          AND job.created_at_ms = occurrence.created_at_ms
          AND job.updated_at_ms = occurrence.created_at_ms
          AND job.version = 1
        )
    )
  ) THEN RAISE(
    ABORT,
    'player catalog event must seal its exact eligibility revalidation batch'
  ) END;
END;

CREATE TRIGGER free_agent_draft_eligibility_revalidation_immutable_update
BEFORE UPDATE
  ON free_agent_draft_eligibility_revalidation_occurrences
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD eligibility revalidation occurrences are immutable'
  );
END;

CREATE TRIGGER free_agent_draft_eligibility_revalidation_immutable_delete
BEFORE DELETE ON free_agent_draft_eligibility_revalidation_occurrences
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD eligibility revalidation occurrences are immutable'
  );
END;

CREATE TRIGGER operational_events_fad_eligibility_catalog_immutable_update
BEFORE UPDATE ON operational_events
WHEN OLD.event_type = 'player_catalog_applied'
  OR NEW.event_type = 'player_catalog_applied'
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    WHERE occurrence.source_operation_id IN (OLD.id, NEW.id)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'player catalog eligibility source events are immutable'
  );
END;

CREATE TRIGGER operational_events_fad_eligibility_catalog_immutable_delete
BEFORE DELETE ON operational_events
WHEN OLD.event_type = 'player_catalog_applied'
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    WHERE occurrence.source_operation_id = OLD.id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'player catalog eligibility source events are immutable'
  );
END;

CREATE TRIGGER job_runs_fad_eligibility_revalidation_identity_update
BEFORE UPDATE ON job_runs
WHEN OLD.job_type = 'fad_eligibility_revalidation'
  OR NEW.job_type = 'fad_eligibility_revalidation'
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    WHERE occurrence.job_run_id IN (OLD.id, NEW.id)
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.job_type IS OLD.job_type
    AND NEW.occurrence_key IS OLD.occurrence_key
    AND NEW.scheduled_for_ms IS OLD.scheduled_for_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
      WHERE occurrence.league_id = NEW.league_id
        AND occurrence.season_id = NEW.season_id
        AND occurrence.job_run_id = NEW.id
        AND occurrence.occurrence_key = NEW.occurrence_key
        AND occurrence.scheduled_for_ms = NEW.scheduled_for_ms
        AND occurrence.created_at_ms = NEW.created_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'FAD eligibility revalidation job causal identity is immutable'
  ) END;
END;

CREATE TRIGGER job_runs_fad_eligibility_revalidation_identity_delete
BEFORE DELETE ON job_runs
WHEN OLD.job_type = 'fad_eligibility_revalidation'
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    WHERE occurrence.job_run_id = OLD.id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD eligibility revalidation jobs cannot be deleted'
  );
END;

CREATE TRIGGER player_source_state_fad_eligibility_evidence_update
BEFORE UPDATE ON player_source_state
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
  WHERE occurrence.source_state_before_id = OLD.id
     OR occurrence.source_state_after_id = OLD.id
)
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.player_id IS OLD.player_id
    AND NEW.provider IS OLD.provider
    AND NEW.source_position IS OLD.source_position
    AND NEW.normalized_position IS OLD.normalized_position
    AND NEW.nhl_team_abbreviation IS OLD.nhl_team_abbreviation
    AND NEW.active IS OLD.active
    AND NEW.source_version IS OLD.source_version
    AND NEW.source_payload_json IS OLD.source_payload_json
    AND NEW.effective_at_ms IS OLD.effective_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND (
      NEW.ended_at_ms IS OLD.ended_at_ms
      OR (
        OLD.ended_at_ms IS NULL
        AND NEW.ended_at_ms >= OLD.effective_at_ms
      )
    )
  ) THEN RAISE(
    ABORT,
    'referenced player source eligibility evidence cannot be changed'
  ) END;
END;

CREATE TRIGGER player_source_state_fad_eligibility_evidence_delete
BEFORE DELETE ON player_source_state
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
  WHERE occurrence.source_state_before_id = OLD.id
     OR occurrence.source_state_after_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced player source eligibility evidence cannot be deleted'
  );
END;

CREATE TRIGGER free_agent_drafts_fad_eligibility_revalidation_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'cards_open'
  AND NEW.status = 'deadline_locked'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_eligibility_revalidation_occurrences AS occurrence
    LEFT JOIN job_runs AS job
      ON job.league_id = occurrence.league_id
     AND job.id = occurrence.job_run_id
    WHERE occurrence.league_id = OLD.league_id
      AND occurrence.season_id = OLD.season_id
      AND occurrence.fad_id = OLD.id
      AND (
        job.id IS NULL
        OR job.status NOT IN ('succeeded', 'skipped')
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline must consume every eligibility revalidation occurrence'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '36',
    updated_at_ms = CASE
      WHEN updated_at_ms < 36 THEN 36
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '35';
