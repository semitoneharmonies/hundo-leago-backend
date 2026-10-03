-- Preserve confirmed historical schedules; new schedules may include an explicit cutoff gap.
DROP TRIGGER season_matchup_schedule_generations_fad_timing_insert;
CREATE TRIGGER season_matchup_schedule_generations_fad_timing_insert
BEFORE INSERT ON season_matchup_schedule_generations
WHEN NEW.fad_timing_json IS NOT NULL
BEGIN
 SELECT CASE WHEN (
   ((SELECT count(*) FROM json_each(NEW.fad_timing_json))=2
      AND json_type(NEW.fad_timing_json,'$.auctionCreationCutoffMinutes') IS NULL
    OR (SELECT count(*) FROM json_each(NEW.fad_timing_json))=3
      AND json_type(NEW.fad_timing_json,'$.auctionCreationCutoffMinutes')='integer'
      AND json_extract(NEW.fad_timing_json,'$.auctionCreationCutoffMinutes') BETWEEN 0 AND 10080)
   AND json_type(NEW.fad_timing_json,'$.candidateDeadlineAtMs')='integer'
   AND json_extract(NEW.fad_timing_json,'$.candidateDeadlineAtMs')>NEW.created_at_ms
   AND json_extract(NEW.fad_timing_json,'$.candidateDeadlineAtMs')<NEW.week_one_starts_at_ms
   AND json_type(NEW.fad_timing_json,'$.rolloverTimesAtMs')='array'
   AND json_array_length(NEW.fad_timing_json,'$.rolloverTimesAtMs') BETWEEN 1 AND 1000
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.fad_timing_json,'$.rolloverTimesAtMs') r
     WHERE r.type<>'integer' OR r.value>NEW.week_one_starts_at_ms
       OR r.value<=CASE WHEN CAST(r.key AS INTEGER)=0 THEN json_extract(NEW.fad_timing_json,'$.candidateDeadlineAtMs')
         ELSE json_extract(NEW.fad_timing_json,'$.rolloverTimesAtMs['||(CAST(r.key AS INTEGER)-1)||']') END)
 ) IS NOT 1 THEN RAISE(ABORT,'draft timetable and cutoff must be valid before Week 1') END;
END;
-- Bind the opening projection to the cutoff in its confirmed current schedule.
DROP TRIGGER free_agent_draft_readiness_attempts_valid_insert;
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
        ) BETWEEN 1 AND 1000
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
      OR json_extract(rollover.value, '$.rollsOverAtMs') <=
        json_extract(rollover.value, '$.opensAtMs')
      OR json_extract(rollover.value, '$.rollsOverAtMs') >
        json_extract(NEW.projection_json, '$.firstMatchupWeekAfter.startsAtMs')
      OR json_extract(
        rollover.value,
        '$.creationCutoffAtMs'
      ) <> max(json_extract(rollover.value, '$.opensAtMs'),
        json_extract(rollover.value, '$.rollsOverAtMs') - coalesce((SELECT json_extract(g.fad_timing_json,'$.auctionCreationCutoffMinutes')*60000 FROM season_matchup_schedule_generations g WHERE g.league_id=NEW.league_id AND g.season_id=NEW.season_id AND g.status='current'),3600000))
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
    'readiness rollover projection requires the exact ordered initial windows'
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
UPDATE application_metadata SET metadata_value='88',updated_at_ms=max(updated_at_ms,88)
WHERE metadata_key='data_model_version' AND metadata_value='87';
