-- hundo-leago: foreign-key-rebuild


-- Expanded scoring preserves every historical row and source snapshot.

-- Rebuild only score-bearing result/standings tables to permit deductions.

DROP TRIGGER idempotency_requests_matchup_result_correction_complete;

DROP TRIGGER idempotency_requests_matchup_result_correction_operation_complete;

DROP TRIGGER matchup_result_versions_immutable_delete;

DROP TRIGGER matchup_result_versions_immutable_update;

DROP TRIGGER matchup_results_current_version_insert;

DROP TRIGGER matchup_results_current_version_update;

DROP TRIGGER standings_rows_canonical_delete;

DROP TRIGGER standings_rows_canonical_insert;

DROP TRIGGER standings_rows_canonical_update;

DROP TRIGGER standings_snapshot_finalizations_evidence_after_schedule_insert;

DROP TRIGGER standings_snapshot_result_versions_consistency_insert;

CREATE TABLE matchup_result_versions_expanded_rebuild (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_result_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  home_score_hundredths INTEGER NOT NULL,
  away_score_hundredths INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('home_win', 'away_win', 'tie')),
  source_snapshot_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('calculated', 'correction', 'provider_correction')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT,
  supersedes_version_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (matchup_result_id, version_number),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_result_id)
    REFERENCES matchup_results(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, home_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, away_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_snapshot_id)
    REFERENCES stat_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, supersedes_version_id)
    REFERENCES matchup_result_versions(league_id, id) ON DELETE RESTRICT,
  CHECK (home_team_id <> away_team_id)
) STRICT;

INSERT INTO matchup_result_versions_expanded_rebuild SELECT * FROM matchup_result_versions;

DROP TABLE matchup_result_versions;

ALTER TABLE matchup_result_versions_expanded_rebuild RENAME TO matchup_result_versions;

CREATE INDEX matchup_result_versions_league_result
  ON matchup_result_versions (league_id, matchup_result_id);

CREATE TABLE standings_rows_expanded_rebuild (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  standings_snapshot_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  wins INTEGER NOT NULL CHECK (wins >= 0),
  losses INTEGER NOT NULL CHECK (losses >= 0),
  ties INTEGER NOT NULL CHECK (ties >= 0),
  standings_points INTEGER NOT NULL CHECK (standings_points >= 0),
  fantasy_points_for_hundredths INTEGER NOT NULL,
  fantasy_points_against_hundredths INTEGER NOT NULL,
  fantasy_point_differential_hundredths INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (standings_snapshot_id, team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  CHECK (standings_points = wins * 2 + ties),
  CHECK (
    fantasy_point_differential_hundredths =
      fantasy_points_for_hundredths - fantasy_points_against_hundredths
  )
) STRICT;

INSERT INTO standings_rows_expanded_rebuild SELECT * FROM standings_rows;

DROP TABLE standings_rows;

ALTER TABLE standings_rows_expanded_rebuild RENAME TO standings_rows;

CREATE INDEX standings_rows_league_snapshot
  ON standings_rows (league_id, standings_snapshot_id);

CREATE TRIGGER idempotency_requests_matchup_result_correction_complete
BEFORE UPDATE OF status, result_type, result_id, completed_at_ms
  ON idempotency_requests
WHEN NEW.operation = 'matchup.result.correct.v1'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'started'
    AND NEW.result_type = 'matchup_result_correction'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM matchup_result_versions AS corrected_version
      JOIN matchup_results
        ON matchup_results.league_id =
          corrected_version.league_id
       AND matchup_results.season_id =
          corrected_version.season_id
       AND matchup_results.id =
          corrected_version.matchup_result_id
      JOIN seasons
        ON seasons.league_id =
          corrected_version.league_id
       AND seasons.id =
          corrected_version.season_id
      WHERE corrected_version.league_id = NEW.league_id
        AND corrected_version.id = NEW.result_id
        AND corrected_version.source_type = 'correction'
        AND corrected_version.actor_user_id =
          NEW.actor_user_id
        AND length(trim(corrected_version.reason))
          BETWEEN 1 AND 500
        AND corrected_version.version_number > 1
        AND matchup_results.current_version_id =
          corrected_version.id
        AND matchup_results.status = 'corrected'
        AND EXISTS (
          SELECT 1
          FROM matchup_result_versions AS previous_version
          WHERE previous_version.league_id =
              corrected_version.league_id
            AND previous_version.season_id =
              corrected_version.season_id
            AND previous_version.matchup_result_id =
              corrected_version.matchup_result_id
            AND previous_version.version_number =
              corrected_version.version_number - 1
            AND previous_version.id =
              corrected_version.supersedes_version_id
        )
        AND corrected_version.version_number = (
          SELECT COUNT(*)
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
            AND NOT (
              (
                history.version_number = 1
                AND history.source_type = 'calculated'
                AND history.actor_user_id IS NULL
                AND history.reason IS NULL
                AND history.supersedes_version_id IS NULL
              )
              OR
              (
                history.version_number > 1
                AND ((history.source_type = 'correction' AND history.actor_user_id IS NOT NULL)
                  OR (history.source_type = 'provider_correction' AND history.actor_user_id IS NULL))
                AND length(trim(history.reason))
                  BETWEEN 1 AND 500
                AND EXISTS (
                  SELECT 1
                  FROM matchup_result_versions AS prior
                  WHERE prior.league_id = history.league_id
                    AND prior.season_id = history.season_id
                    AND prior.matchup_result_id =
                      history.matchup_result_id
                    AND prior.version_number =
                      history.version_number - 1
                    AND prior.id =
                      history.supersedes_version_id
                )
              )
            )
        )
        AND (
          (
            NOT EXISTS (
              SELECT 1
              FROM standings_snapshot_finalizations
              WHERE standings_snapshot_finalizations.league_id =
                  corrected_version.league_id
                AND standings_snapshot_finalizations.season_id =
                  corrected_version.season_id
                AND standings_snapshot_finalizations
                      .evidence_schema_version = 1
            )
            AND NOT EXISTS (
              SELECT 1
              FROM standings_operations
              WHERE standings_operations.league_id =
                  corrected_version.league_id
                AND standings_operations.season_id =
                  corrected_version.season_id
                AND standings_operations.operation_type =
                  'correction_propagation'
                AND standings_operations.idempotency_request_id =
                  NEW.id
            )
          )
          OR
          (
            EXISTS (
              SELECT 1
              FROM standings_snapshot_finalizations
              WHERE standings_snapshot_finalizations.league_id =
                  corrected_version.league_id
                AND standings_snapshot_finalizations.season_id =
                  corrected_version.season_id
                AND standings_snapshot_finalizations
                      .evidence_schema_version = 1
            )
            AND (
              SELECT COUNT(*)
              FROM standings_snapshot_finalizations AS replacement
              JOIN standings_operations AS replacement_operation
                ON replacement_operation.league_id =
                  replacement.league_id
               AND replacement_operation.season_id =
                  replacement.season_id
               AND replacement_operation.id =
                  replacement.standings_operation_id
               AND replacement_operation.standings_snapshot_id =
                  replacement.standings_snapshot_id
              JOIN standings_snapshot_result_versions AS replacement_link
                ON replacement_link.league_id =
                  replacement.league_id
               AND replacement_link.season_id =
                  replacement.season_id
               AND replacement_link.standings_snapshot_id =
                  replacement.standings_snapshot_id
                AND replacement_link.matchup_result_version_id =
                  corrected_version.id
              JOIN standings_snapshot_finalizations AS replaced
                ON replaced.league_id = replacement.league_id
               AND replaced.season_id = replacement.season_id
               AND replaced.id =
                  replacement.replaces_finalization_id
              JOIN standings_snapshot_result_versions AS replaced_link
                ON replaced_link.league_id = replaced.league_id
               AND replaced_link.season_id = replaced.season_id
               AND replaced_link.standings_snapshot_id =
                  replaced.standings_snapshot_id
               AND replaced_link.matchup_week_id =
                  replacement_link.matchup_week_id
               AND replaced_link.matchup_id =
                  replacement_link.matchup_id
               AND replaced_link.matchup_result_id =
                  replacement_link.matchup_result_id
              WHERE replacement.league_id =
                  corrected_version.league_id
                AND replacement.season_id =
                  corrected_version.season_id
                AND replacement.idempotency_request_id =
                  NEW.id
                AND replacement.cause = 'result_correction'
                AND replacement.status = 'final'
                AND replacement.evidence_schema_version = 1
                AND replacement_operation.operation_type =
                  'correction_propagation'
                AND replacement_operation.status = 'succeeded'
                AND replacement_operation.idempotency_request_id =
                  NEW.id
                AND replacement_link.result_version_number =
                  replaced_link.result_version_number + 1
                AND corrected_version.supersedes_version_id =
                  replaced_link.matchup_result_version_id
                AND seasons.version =
                  replacement.season_version_after
            ) = 1
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'matchup result correction idempotency completion is inconsistent'
  ) END;
END;

CREATE TRIGGER idempotency_requests_matchup_result_correction_operation_complete
BEFORE UPDATE OF status, result_type, result_id, completed_at_ms
  ON idempotency_requests
WHEN NEW.operation = 'matchup.result.correct.v1'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM matchup_result_versions AS corrected_version
    JOIN matchup_results
      ON matchup_results.league_id = corrected_version.league_id
     AND matchup_results.season_id = corrected_version.season_id
     AND matchup_results.id =
       corrected_version.matchup_result_id
    JOIN matchups
      ON matchups.league_id = matchup_results.league_id
     AND matchups.season_id = matchup_results.season_id
     AND matchups.id = matchup_results.matchup_id
    JOIN matchup_operations AS correction_operation
      ON correction_operation.league_id =
        corrected_version.league_id
     AND correction_operation.season_id =
        corrected_version.season_id
     AND correction_operation.matchup_week_id =
        matchups.matchup_week_id
     AND correction_operation.matchup_id = matchups.id
     AND correction_operation.actor_user_id =
        corrected_version.actor_user_id
     AND correction_operation.operation_type = 'result_correct'
     AND correction_operation.status = 'succeeded'
     AND correction_operation.reason IS corrected_version.reason
     AND correction_operation.completed_at_ms =
        corrected_version.created_at_ms
    WHERE corrected_version.league_id = NEW.league_id
      AND corrected_version.id = NEW.result_id
      AND corrected_version.actor_user_id =
        NEW.actor_user_id
      AND json_valid(correction_operation.metadata_json) = 1
      AND json_type(
        CASE
          WHEN json_valid(correction_operation.metadata_json) = 1
            THEN correction_operation.metadata_json
          ELSE '{}'
        END
      ) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(
          CASE
            WHEN json_valid(correction_operation.metadata_json) = 1
              THEN correction_operation.metadata_json
            ELSE '{}'
          END
        )
      ) = 2
      AND (
        SELECT COUNT(DISTINCT key)
        FROM json_each(
          CASE
            WHEN json_valid(correction_operation.metadata_json) = 1
              THEN correction_operation.metadata_json
            ELSE '{}'
          END
        )
      ) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          CASE
            WHEN json_valid(correction_operation.metadata_json) = 1
              THEN correction_operation.metadata_json
            ELSE '{}'
          END
        )
        WHERE json_each.key NOT IN (
          'resultId',
          'resultVersionId'
        )
      )
      AND json_extract(
        correction_operation.metadata_json,
        '$.resultId'
      ) = corrected_version.matchup_result_id
      AND json_extract(
        correction_operation.metadata_json,
        '$.resultVersionId'
      ) = corrected_version.id
  ) <> 1 THEN RAISE(
    ABORT,
    'matchup result correction operation evidence is inconsistent'
  ) END;
END;

CREATE TRIGGER matchup_result_versions_immutable_delete
BEFORE DELETE ON matchup_result_versions
BEGIN
  SELECT RAISE(
    ABORT,
    'matchup result-version history cannot be deleted'
  );
END;

CREATE TRIGGER matchup_result_versions_immutable_update
BEFORE UPDATE ON matchup_result_versions
BEGIN
  SELECT RAISE(
    ABORT,
    'matchup result-version history is immutable'
  );
END;

CREATE TRIGGER matchup_results_current_version_insert
BEFORE INSERT ON matchup_results
WHEN NEW.current_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM matchup_result_versions
    WHERE matchup_result_versions.id = NEW.current_version_id
      AND matchup_result_versions.league_id = NEW.league_id
      AND matchup_result_versions.matchup_result_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'current matchup result version must belong to this result and league');
END;

CREATE TRIGGER matchup_results_current_version_update
BEFORE UPDATE OF league_id, current_version_id ON matchup_results
WHEN NEW.current_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM matchup_result_versions
    WHERE matchup_result_versions.id = NEW.current_version_id
      AND matchup_result_versions.league_id = NEW.league_id
      AND matchup_result_versions.matchup_result_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'current matchup result version must belong to this result and league');
END;

CREATE TRIGGER standings_rows_canonical_delete
BEFORE DELETE ON standings_rows
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      OLD.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings rows cannot be deleted'
  );
END;

CREATE TRIGGER standings_rows_canonical_insert
BEFORE INSERT ON standings_rows
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = NEW.league_id
    AND standings_snapshot_finalizations.season_id = NEW.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      NEW.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings rows are immutable'
  );
END;

CREATE TRIGGER standings_rows_canonical_update
BEFORE UPDATE ON standings_rows
WHEN EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = OLD.league_id
    AND standings_snapshot_finalizations.season_id = OLD.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      OLD.standings_snapshot_id
)
OR EXISTS (
  SELECT 1
  FROM standings_snapshot_finalizations
  WHERE standings_snapshot_finalizations.league_id = NEW.league_id
    AND standings_snapshot_finalizations.season_id = NEW.season_id
    AND standings_snapshot_finalizations.standings_snapshot_id =
      NEW.standings_snapshot_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'canonical standings rows are immutable'
  );
END;

CREATE TRIGGER standings_snapshot_finalizations_evidence_after_schedule_insert
BEFORE INSERT ON standings_snapshot_finalizations
BEGIN

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchup_weeks
    JOIN seasons
      ON seasons.league_id = matchup_weeks.league_id
     AND seasons.id = matchup_weeks.season_id
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
      AND (
        matchup_weeks.status <> 'final'
        OR seasons.regular_season_starts_at_ms IS NULL
        OR seasons.fantasy_playoffs_start_at_ms IS NULL
        OR matchup_weeks.starts_at_ms <
          seasons.regular_season_starts_at_ms
        OR matchup_weeks.ends_at_ms <>
          matchup_weeks.rolls_over_at_ms
        OR (
          matchup_weeks.ends_at_ms -
            matchup_weeks.starts_at_ms
        ) NOT BETWEEN 590400000 AND 619200000
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization requires complete regular-season weeks'
  ) END;

  SELECT CASE WHEN (
    SELECT MIN(matchup_weeks.sequence)
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
  ) <> 1 OR (
    SELECT MAX(matchup_weeks.sequence)
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
  ) <> NEW.expected_week_count THEN RAISE(
    ABORT,
    'standings finalization requires contiguous regular-season weeks'
  ) END;

  SELECT CASE WHEN (
    SELECT final_week.rolls_over_at_ms
    FROM matchup_weeks AS final_week
    WHERE final_week.league_id = NEW.league_id
      AND final_week.season_id = NEW.season_id
    ORDER BY final_week.sequence DESC
    LIMIT 1
  ) <> (
    SELECT seasons.fantasy_playoffs_start_at_ms
    FROM seasons
    WHERE seasons.league_id = NEW.league_id
      AND seasons.id = NEW.season_id
  ) OR EXISTS (
    SELECT 1
    FROM matchup_weeks AS current_week
    WHERE current_week.league_id = NEW.league_id
      AND current_week.season_id = NEW.season_id
      AND current_week.sequence > 1
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_weeks AS prior_week
        WHERE prior_week.league_id =
          current_week.league_id
          AND prior_week.season_id =
            current_week.season_id
          AND prior_week.sequence =
            current_week.sequence - 1
          AND prior_week.rolls_over_at_ms =
            current_week.starts_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule boundaries are incomplete'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_weeks
        WHERE matchup_weeks.league_id =
          matchups.league_id
          AND matchup_weeks.season_id =
            matchups.season_id
          AND matchup_weeks.id =
            matchups.matchup_week_id
      )
  ) OR EXISTS (
    SELECT 1
    FROM matchup_byes
    WHERE matchup_byes.league_id = NEW.league_id
      AND matchup_byes.season_id = NEW.season_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_weeks
        WHERE matchup_weeks.league_id =
          matchup_byes.league_id
          AND matchup_weeks.season_id =
            matchup_byes.season_id
          AND matchup_weeks.id =
            matchup_byes.matchup_week_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule assignments cross season scope'
  ) END;

  SELECT CASE WHEN EXISTS (
    WITH participants AS (
      SELECT matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    ),
    assignments AS (
      SELECT
        matchups.matchup_week_id AS matchup_week_id,
        matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION ALL
      SELECT
        matchups.matchup_week_id,
        matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION ALL
      SELECT
        matchup_byes.matchup_week_id,
        matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    )
    SELECT 1
    FROM matchup_weeks
    CROSS JOIN participants
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
      AND (
        SELECT COUNT(*)
        FROM assignments
        WHERE assignments.matchup_week_id =
          matchup_weeks.id
          AND assignments.team_id =
            participants.team_id
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule participant coverage is incomplete'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchup_weeks
    WHERE matchup_weeks.league_id = NEW.league_id
      AND matchup_weeks.season_id = NEW.season_id
      AND (
        (
          SELECT COUNT(*)
          FROM matchups
          WHERE matchups.league_id = NEW.league_id
            AND matchups.season_id = NEW.season_id
            AND matchups.matchup_week_id =
              matchup_weeks.id
        ) <> CAST(NEW.participant_count / 2 AS INTEGER)
        OR
        (
          SELECT COUNT(*)
          FROM matchup_byes
          WHERE matchup_byes.league_id = NEW.league_id
            AND matchup_byes.season_id = NEW.season_id
            AND matchup_byes.matchup_week_id =
              matchup_weeks.id
        ) <> (NEW.participant_count % 2)
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization schedule matchup and bye counts are invalid'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
  ) <> NEW.expected_matchup_count OR EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
      AND matchups.status <> 'final'
  ) THEN RAISE(
    ABORT,
    'standings finalization requires every expected matchup final'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM standings_snapshot_result_versions
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) <> NEW.finalized_matchup_count THEN RAISE(
    ABORT,
    'standings finalization result-link count is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.season_id = NEW.season_id
      AND NOT EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions
        WHERE standings_snapshot_result_versions.league_id =
          matchups.league_id
          AND standings_snapshot_result_versions.season_id =
            matchups.season_id
          AND standings_snapshot_result_versions.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND standings_snapshot_result_versions.matchup_id =
            matchups.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchups
        WHERE matchups.league_id =
          standings_snapshot_result_versions.league_id
          AND matchups.season_id =
            standings_snapshot_result_versions.season_id
          AND matchups.id =
            standings_snapshot_result_versions.matchup_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization result links do not match the schedule'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND NOT EXISTS (
        SELECT 1
        FROM matchups
        JOIN matchup_weeks
          ON matchup_weeks.league_id = matchups.league_id
         AND matchup_weeks.season_id = matchups.season_id
         AND matchup_weeks.id = matchups.matchup_week_id
        JOIN matchup_results
          ON matchup_results.league_id = matchups.league_id
         AND matchup_results.season_id = matchups.season_id
         AND matchup_results.matchup_id = matchups.id
        JOIN matchup_result_versions
          ON matchup_result_versions.league_id =
            matchup_results.league_id
         AND matchup_result_versions.season_id =
            matchup_results.season_id
         AND matchup_result_versions.matchup_result_id =
            matchup_results.id
        WHERE matchups.league_id =
          standings_snapshot_result_versions.league_id
          AND matchups.season_id =
            standings_snapshot_result_versions.season_id
          AND matchups.id =
            standings_snapshot_result_versions.matchup_id
          AND matchup_weeks.id =
            standings_snapshot_result_versions.matchup_week_id
          AND matchup_results.id =
            standings_snapshot_result_versions.matchup_result_id
          AND matchup_results.status IN ('official', 'corrected')
          AND matchup_results.current_version_id =
            standings_snapshot_result_versions.matchup_result_version_id
          AND matchup_result_versions.id =
            standings_snapshot_result_versions.matchup_result_version_id
          AND matchup_result_versions.version_number =
            standings_snapshot_result_versions.result_version_number
          AND matchup_result_versions.home_team_id =
            matchups.home_team_id
          AND matchup_result_versions.away_team_id =
            matchups.away_team_id
          AND matchup_weeks.status = 'final'
          AND matchups.status = 'final'
          AND (
            (
              matchup_result_versions.outcome = 'home_win'
              AND matchup_result_versions.home_score_hundredths >
                matchup_result_versions.away_score_hundredths
            )
            OR
            (
              matchup_result_versions.outcome = 'away_win'
              AND matchup_result_versions.away_score_hundredths >
                matchup_result_versions.home_score_hundredths
            )
            OR
            (
              matchup_result_versions.outcome = 'tie'
              AND matchup_result_versions.home_score_hundredths =
                matchup_result_versions.away_score_hundredths
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization requires exact current result versions'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    JOIN matchup_result_versions AS corrected_version
      ON corrected_version.league_id =
        standings_snapshot_result_versions.league_id
     AND corrected_version.season_id =
        standings_snapshot_result_versions.season_id
     AND corrected_version.matchup_result_id =
        standings_snapshot_result_versions.matchup_result_id
     AND corrected_version.id =
        standings_snapshot_result_versions.matchup_result_version_id
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND corrected_version.source_type IN ('correction', 'provider_correction')
      AND (
        corrected_version.version_number <= 1
        OR (corrected_version.source_type = 'correction' AND corrected_version.actor_user_id IS NULL)
        OR (corrected_version.source_type = 'provider_correction' AND corrected_version.actor_user_id IS NOT NULL)
        OR length(trim(corrected_version.reason))
          NOT BETWEEN 1 AND 500
        OR corrected_version.version_number <> (
          SELECT COUNT(*)
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM matchup_result_versions AS previous_version
          WHERE previous_version.league_id =
              corrected_version.league_id
            AND previous_version.season_id =
              corrected_version.season_id
            AND previous_version.matchup_result_id =
              corrected_version.matchup_result_id
            AND previous_version.version_number =
              corrected_version.version_number - 1
            AND previous_version.id =
              corrected_version.supersedes_version_id
        )
        OR EXISTS (
          SELECT 1
          FROM matchup_result_versions AS history
          WHERE history.league_id =
              corrected_version.league_id
            AND history.season_id =
              corrected_version.season_id
            AND history.matchup_result_id =
              corrected_version.matchup_result_id
            AND NOT (
              (
                history.version_number = 1
                AND history.source_type = 'calculated'
                AND history.actor_user_id IS NULL
                AND history.reason IS NULL
                AND history.supersedes_version_id IS NULL
              )
              OR
              (
                history.version_number > 1
                AND ((history.source_type = 'correction' AND history.actor_user_id IS NOT NULL)
                  OR (history.source_type = 'provider_correction' AND history.actor_user_id IS NULL))
                AND length(trim(history.reason))
                  BETWEEN 1 AND 500
                AND EXISTS (
                  SELECT 1
                  FROM matchup_result_versions AS prior
                  WHERE prior.league_id = history.league_id
                    AND prior.season_id = history.season_id
                    AND prior.matchup_result_id =
                      history.matchup_result_id
                    AND prior.version_number =
                      history.version_number - 1
                    AND prior.id =
                      history.supersedes_version_id
                )
              )
            )
        )
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization correction chain is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_result_versions
    JOIN matchup_result_versions AS corrected_version
      ON corrected_version.league_id =
        standings_snapshot_result_versions.league_id
     AND corrected_version.season_id =
        standings_snapshot_result_versions.season_id
     AND corrected_version.matchup_result_id =
        standings_snapshot_result_versions.matchup_result_id
     AND corrected_version.id =
        standings_snapshot_result_versions.matchup_result_version_id
    WHERE standings_snapshot_result_versions.league_id = NEW.league_id
      AND standings_snapshot_result_versions.season_id = NEW.season_id
      AND standings_snapshot_result_versions.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND corrected_version.source_type IN ('correction', 'provider_correction')
      AND (
        SELECT COUNT(*)
        FROM matchup_operations AS correction_operation
        WHERE correction_operation.league_id =
            corrected_version.league_id
          AND correction_operation.season_id =
            corrected_version.season_id
          AND correction_operation.matchup_week_id =
            standings_snapshot_result_versions.matchup_week_id
          AND correction_operation.matchup_id =
            standings_snapshot_result_versions.matchup_id
          AND correction_operation.actor_user_id IS
            corrected_version.actor_user_id
          AND correction_operation.operation_type =
            'result_correct'
          AND correction_operation.status = 'succeeded'
          AND correction_operation.reason IS
            corrected_version.reason
          AND correction_operation.completed_at_ms =
            corrected_version.created_at_ms
          AND json_valid(correction_operation.metadata_json) = 1
          AND json_type(
            CASE
              WHEN json_valid(correction_operation.metadata_json) = 1
                THEN correction_operation.metadata_json
              ELSE '{}'
            END
          ) = 'object'
          AND (
            SELECT COUNT(*)
            FROM json_each(
              CASE
                WHEN json_valid(correction_operation.metadata_json) = 1
                  THEN correction_operation.metadata_json
                ELSE '{}'
              END
            )
          ) = 2
          AND (
            SELECT COUNT(DISTINCT key)
            FROM json_each(
              CASE
                WHEN json_valid(correction_operation.metadata_json) = 1
                  THEN correction_operation.metadata_json
                ELSE '{}'
              END
            )
          ) = 2
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(
              CASE
                WHEN json_valid(correction_operation.metadata_json) = 1
                  THEN correction_operation.metadata_json
                ELSE '{}'
              END
            )
            WHERE json_each.key NOT IN (
              'resultId',
              'resultVersionId'
            )
          )
          AND json_type(
            correction_operation.metadata_json,
            '$.resultId'
          ) = 'text'
          AND json_extract(
            correction_operation.metadata_json,
            '$.resultId'
          ) = corrected_version.matchup_result_id
          AND json_type(
            correction_operation.metadata_json,
            '$.resultVersionId'
          ) = 'text'
          AND json_extract(
            correction_operation.metadata_json,
            '$.resultVersionId'
          ) = corrected_version.id
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'standings finalization correction operation is inconsistent'
  ) END;

  SELECT CASE WHEN NEW.cause = 'result_correction'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM standings_snapshot_finalizations AS replaced
        WHERE replaced.league_id = NEW.league_id
          AND replaced.season_id = NEW.season_id
          AND replaced.id = NEW.replaces_finalization_id
      )
      OR (
        SELECT COUNT(*)
        FROM standings_snapshot_result_versions AS replacement_link
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
      ) <> (
        SELECT COUNT(*)
        FROM standings_snapshot_result_versions AS replaced_link
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replaced.league_id = NEW.league_id
          AND replaced.season_id = NEW.season_id
          AND replaced.id = NEW.replaces_finalization_id
      )
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replacement_link
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND NOT EXISTS (
            SELECT 1
            FROM standings_snapshot_result_versions AS replaced_link
            JOIN standings_snapshot_finalizations AS replaced
              ON replaced.league_id = replaced_link.league_id
             AND replaced.season_id = replaced_link.season_id
             AND replaced.standings_snapshot_id =
               replaced_link.standings_snapshot_id
            WHERE replaced.league_id = NEW.league_id
              AND replaced.season_id = NEW.season_id
              AND replaced.id = NEW.replaces_finalization_id
              AND replaced_link.matchup_week_id =
                replacement_link.matchup_week_id
              AND replaced_link.matchup_id =
                replacement_link.matchup_id
              AND replaced_link.matchup_result_id =
                replacement_link.matchup_result_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replaced_link
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replaced.league_id = NEW.league_id
          AND replaced.season_id = NEW.season_id
          AND replaced.id = NEW.replaces_finalization_id
          AND NOT EXISTS (
            SELECT 1
            FROM standings_snapshot_result_versions AS replacement_link
            WHERE replacement_link.league_id = NEW.league_id
              AND replacement_link.season_id = NEW.season_id
              AND replacement_link.standings_snapshot_id =
                NEW.standings_snapshot_id
              AND replacement_link.matchup_week_id =
                replaced_link.matchup_week_id
              AND replacement_link.matchup_id =
                replaced_link.matchup_id
              AND replacement_link.matchup_result_id =
                replaced_link.matchup_result_id
          )
      )
      OR (
        SELECT COUNT(*)
        FROM standings_snapshot_result_versions AS replacement_link
        JOIN standings_snapshot_result_versions AS replaced_link
          ON replaced_link.league_id = replacement_link.league_id
         AND replaced_link.season_id = replacement_link.season_id
         AND replaced_link.matchup_week_id =
           replacement_link.matchup_week_id
         AND replaced_link.matchup_id =
           replacement_link.matchup_id
         AND replaced_link.matchup_result_id =
           replacement_link.matchup_result_id
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND replaced.id = NEW.replaces_finalization_id
          AND replacement_link.matchup_result_version_id <>
            replaced_link.matchup_result_version_id
      ) <> 1
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replacement_link
        JOIN standings_snapshot_result_versions AS replaced_link
          ON replaced_link.league_id = replacement_link.league_id
         AND replaced_link.season_id = replacement_link.season_id
         AND replaced_link.matchup_week_id =
           replacement_link.matchup_week_id
         AND replaced_link.matchup_id =
           replacement_link.matchup_id
         AND replaced_link.matchup_result_id =
           replacement_link.matchup_result_id
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        JOIN matchup_result_versions AS replacement_version
          ON replacement_version.league_id =
            replacement_link.league_id
         AND replacement_version.season_id =
            replacement_link.season_id
         AND replacement_version.matchup_result_id =
            replacement_link.matchup_result_id
         AND replacement_version.id =
            replacement_link.matchup_result_version_id
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND replaced.id = NEW.replaces_finalization_id
          AND replacement_link.matchup_result_version_id <>
            replaced_link.matchup_result_version_id
          AND (
            replacement_link.result_version_number <>
              replaced_link.result_version_number + 1
            OR replacement_version.supersedes_version_id <>
              replaced_link.matchup_result_version_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM standings_snapshot_result_versions AS replacement_link
        JOIN standings_snapshot_result_versions AS replaced_link
          ON replaced_link.league_id = replacement_link.league_id
         AND replaced_link.season_id = replacement_link.season_id
         AND replaced_link.matchup_week_id =
           replacement_link.matchup_week_id
         AND replaced_link.matchup_id =
           replacement_link.matchup_id
         AND replaced_link.matchup_result_id =
           replacement_link.matchup_result_id
        JOIN standings_snapshot_finalizations AS replaced
          ON replaced.league_id = replaced_link.league_id
         AND replaced.season_id = replaced_link.season_id
         AND replaced.standings_snapshot_id =
           replaced_link.standings_snapshot_id
        WHERE replacement_link.league_id = NEW.league_id
          AND replacement_link.season_id = NEW.season_id
          AND replacement_link.standings_snapshot_id =
            NEW.standings_snapshot_id
          AND replaced.id = NEW.replaces_finalization_id
          AND replacement_link.matchup_result_version_id =
            replaced_link.matchup_result_version_id
          AND replacement_link.result_version_number <>
            replaced_link.result_version_number
      )
    )
  THEN RAISE(
    ABORT,
    'replacement standings links must contain one direct correction'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM (
      SELECT matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    )
  ) <> NEW.participant_count THEN RAISE(
    ABORT,
    'standings finalization participant count is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM standings_rows
    WHERE standings_rows.league_id = NEW.league_id
      AND standings_rows.season_id = NEW.season_id
      AND standings_rows.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) <> NEW.standings_row_count OR EXISTS (
    SELECT 1
    FROM standings_rows
    WHERE standings_rows.standings_snapshot_id =
      NEW.standings_snapshot_id
      AND (
        standings_rows.league_id <> NEW.league_id
        OR standings_rows.season_id <> NEW.season_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization row count is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM standings_snapshot_team_identities
    WHERE standings_snapshot_team_identities.league_id =
      NEW.league_id
      AND standings_snapshot_team_identities.season_id =
        NEW.season_id
      AND standings_snapshot_team_identities.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) <> NEW.participant_count THEN RAISE(
    ABORT,
    'standings finalization identity count is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT matchups.home_team_id AS team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchups.away_team_id
      FROM matchups
      WHERE matchups.league_id = NEW.league_id
        AND matchups.season_id = NEW.season_id
      UNION
      SELECT matchup_byes.team_id
      FROM matchup_byes
      WHERE matchup_byes.league_id = NEW.league_id
        AND matchup_byes.season_id = NEW.season_id
    ) AS participants
    WHERE NOT EXISTS (
      SELECT 1
      FROM standings_rows
      WHERE standings_rows.league_id = NEW.league_id
        AND standings_rows.season_id = NEW.season_id
        AND standings_rows.standings_snapshot_id =
          NEW.standings_snapshot_id
        AND standings_rows.team_id = participants.team_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM standings_snapshot_team_identities
      WHERE standings_snapshot_team_identities.league_id =
        NEW.league_id
        AND standings_snapshot_team_identities.season_id =
          NEW.season_id
        AND standings_snapshot_team_identities.standings_snapshot_id =
          NEW.standings_snapshot_id
        AND standings_snapshot_team_identities.team_id =
          participants.team_id
    )
  ) OR EXISTS (
    SELECT 1
    FROM standings_rows
    WHERE standings_rows.league_id = NEW.league_id
      AND standings_rows.season_id = NEW.season_id
      AND standings_rows.standings_snapshot_id =
        NEW.standings_snapshot_id
      AND NOT EXISTS (
        SELECT 1
        FROM standings_snapshot_team_identities
        WHERE standings_snapshot_team_identities.league_id =
          standings_rows.league_id
          AND standings_snapshot_team_identities.season_id =
            standings_rows.season_id
          AND standings_snapshot_team_identities.standings_snapshot_id =
            standings_rows.standings_snapshot_id
          AND standings_snapshot_team_identities.team_id =
            standings_rows.team_id
      )
  ) THEN RAISE(
    ABORT,
    'standings finalization requires exact row and identity coverage'
  ) END;

  SELECT CASE WHEN NEW.replaces_finalization_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM standings_snapshot_finalizations AS replaced
      WHERE replaced.league_id = NEW.league_id
        AND replaced.season_id = NEW.season_id
        AND replaced.id = NEW.replaces_finalization_id
        AND replaced.status = 'superseded'
        AND replaced.superseded_by_snapshot_id =
          NEW.standings_snapshot_id
        AND replaced.superseded_by_user_id =
          NEW.authorized_by_user_id
        AND replaced.superseded_by_membership_id =
          NEW.authorized_by_membership_id
        AND replaced.superseded_by_authority =
          NEW.authorized_authority
        AND replaced.superseded_by_operation_id =
          NEW.standings_operation_id
        AND replaced.finalization_version <
          NEW.finalization_version
    )
  THEN RAISE(
    ABORT,
    'replacement standings finalization chain is inconsistent'
  ) END;
END;

CREATE TRIGGER standings_snapshot_result_versions_consistency_insert
BEFORE INSERT ON standings_snapshot_result_versions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM standings_snapshots
    WHERE standings_snapshots.league_id = NEW.league_id
      AND standings_snapshots.season_id = NEW.season_id
      AND standings_snapshots.id = NEW.standings_snapshot_id
      AND standings_snapshots.status = 'final'
  ) THEN RAISE(
    ABORT,
    'standings result-version link requires a staged final snapshot'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM standings_snapshot_finalizations
    WHERE standings_snapshot_finalizations.league_id = NEW.league_id
      AND standings_snapshot_finalizations.season_id = NEW.season_id
      AND standings_snapshot_finalizations.standings_snapshot_id =
        NEW.standings_snapshot_id
  ) THEN RAISE(
    ABORT,
    'final standings result-version links are immutable'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM seasons
    JOIN matchup_weeks
      ON matchup_weeks.league_id = seasons.league_id
     AND matchup_weeks.season_id = seasons.id
    JOIN matchups
      ON matchups.league_id = matchup_weeks.league_id
     AND matchups.season_id = matchup_weeks.season_id
     AND matchups.matchup_week_id = matchup_weeks.id
    JOIN matchup_results
      ON matchup_results.league_id = matchups.league_id
     AND matchup_results.season_id = matchups.season_id
     AND matchup_results.matchup_id = matchups.id
    JOIN matchup_result_versions
      ON matchup_result_versions.league_id = matchup_results.league_id
     AND matchup_result_versions.season_id = matchup_results.season_id
     AND matchup_result_versions.matchup_result_id = matchup_results.id
    WHERE seasons.league_id = NEW.league_id
      AND seasons.id = NEW.season_id
      AND matchup_weeks.id = NEW.matchup_week_id
      AND matchups.id = NEW.matchup_id
      AND matchup_results.id = NEW.matchup_result_id
      AND matchup_result_versions.id =
        NEW.matchup_result_version_id
      AND matchup_result_versions.version_number =
        NEW.result_version_number
      AND matchup_weeks.status = 'final'
      AND matchups.status = 'final'
      AND matchup_results.status IN ('official', 'corrected')
      AND matchup_result_versions.home_team_id =
        matchups.home_team_id
      AND matchup_result_versions.away_team_id =
        matchups.away_team_id
      AND (
        (
          matchup_result_versions.outcome = 'home_win'
          AND matchup_result_versions.home_score_hundredths >
            matchup_result_versions.away_score_hundredths
        )
        OR
        (
          matchup_result_versions.outcome = 'away_win'
          AND matchup_result_versions.away_score_hundredths >
            matchup_result_versions.home_score_hundredths
        )
        OR
        (
          matchup_result_versions.outcome = 'tie'
          AND matchup_result_versions.home_score_hundredths =
            matchup_result_versions.away_score_hundredths
        )
      )
      AND seasons.regular_season_starts_at_ms IS NOT NULL
      AND seasons.fantasy_playoffs_start_at_ms IS NOT NULL
      AND matchup_weeks.starts_at_ms >=
        seasons.regular_season_starts_at_ms
      AND matchup_weeks.rolls_over_at_ms <=
        seasons.fantasy_playoffs_start_at_ms
  ) THEN RAISE(
    ABORT,
    'standings result-version link is not exact regular-season evidence'
  ) END;
END;

CREATE TRIGGER matchup_provider_correction_source_insert
BEFORE INSERT ON matchup_result_versions
WHEN NEW.source_type = 'provider_correction'
BEGIN
  SELECT CASE WHEN NEW.actor_user_id IS NOT NULL
    OR NEW.reason IS NOT 'Automatic NHL statistics correction'
    OR NEW.version_number <= 1
    OR NOT EXISTS (
      SELECT 1 FROM matchup_results AS result
      JOIN matchups AS matchup ON matchup.id = result.matchup_id AND matchup.league_id = result.league_id
      JOIN matchup_weeks AS week ON week.id = matchup.matchup_week_id AND week.league_id = matchup.league_id
      JOIN seasons AS season ON season.id = result.season_id AND season.league_id = result.league_id
      JOIN matchup_result_versions AS prior ON prior.id = result.current_version_id AND prior.matchup_result_id = result.id
      JOIN stat_snapshots AS snapshot ON snapshot.id = NEW.source_snapshot_id AND snapshot.league_id = result.league_id
      JOIN stat_refreshes AS refresh ON refresh.id = snapshot.source_refresh_id AND refresh.stat_source_id = snapshot.stat_source_id
      JOIN stat_sources AS source ON source.id = refresh.stat_source_id
      JOIN expanded_stat_refreshes AS expanded ON expanded.refresh_id = refresh.id
      WHERE result.id = NEW.matchup_result_id AND result.league_id = NEW.league_id AND result.season_id = NEW.season_id
        AND result.status IN ('official', 'corrected') AND matchup.status = 'final'
        AND season.nhl_season_key = '20262027' AND refresh.nhl_season_key = season.nhl_season_key
        AND season.fantasy_playoffs_start_at_ms IS NOT NULL AND week.ends_at_ms <= season.fantasy_playoffs_start_at_ms
        AND NEW.home_team_id = matchup.home_team_id AND NEW.away_team_id = matchup.away_team_id
        AND prior.id = NEW.supersedes_version_id AND NEW.version_number = prior.version_number + 1
        AND NEW.created_at_ms >= prior.created_at_ms
        AND snapshot.season_id = NEW.season_id AND snapshot.matchup_week_id = matchup.matchup_week_id
        AND snapshot.intended_use = 'matchup_final' AND snapshot.committed = 1
        AND snapshot.completeness_status = 'complete' AND snapshot.freshness_status = 'fresh'
        AND source.provider = 'nhl-completed-games' AND refresh.status = 'succeeded'
        AND refresh.completed_at_ms >= week.ends_at_ms AND refresh.completed_at_ms <= NEW.created_at_ms
        AND NEW.outcome = CASE WHEN NEW.home_score_hundredths = NEW.away_score_hundredths THEN 'tie'
          WHEN NEW.home_score_hundredths > NEW.away_score_hundredths THEN 'home_win' ELSE 'away_win' END
    ) THEN RAISE(ABORT, 'provider correction requires exact completed NHL source and result history') END;
END;

CREATE TRIGGER matchup_provider_correction_operation_update
BEFORE UPDATE OF current_version_id ON matchup_results
WHEN EXISTS (SELECT 1 FROM matchup_result_versions WHERE id = NEW.current_version_id AND source_type = 'provider_correction')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM matchup_result_versions AS version
    JOIN matchup_operations AS operation ON operation.league_id = version.league_id AND operation.season_id = version.season_id
    JOIN matchups AS matchup ON matchup.id = NEW.matchup_id AND matchup.league_id = NEW.league_id
    WHERE version.id = NEW.current_version_id AND version.matchup_result_id = NEW.id
      AND version.supersedes_version_id = OLD.current_version_id AND NEW.status = 'corrected' AND NEW.version = OLD.version + 1
      AND operation.matchup_id = NEW.matchup_id AND operation.matchup_week_id = matchup.matchup_week_id
      AND operation.operation_type = 'result_correct' AND operation.status = 'succeeded'
      AND operation.actor_user_id IS NULL AND operation.reason IS version.reason
      AND operation.completed_at_ms = version.created_at_ms
      AND json_valid(operation.metadata_json) AND json_extract(operation.metadata_json, '$.resultId') = NEW.id
      AND json_extract(operation.metadata_json, '$.resultVersionId') = version.id
  ) THEN RAISE(ABORT, 'provider correction requires matching audit operation') END;
END;

CREATE TABLE expanded_stat_refreshes (
  refresh_id TEXT PRIMARY KEY REFERENCES stat_refreshes(id),
  scoring_rule_version TEXT NOT NULL CHECK (scoring_rule_version = 'expanded-2026-v1'),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  total_count INTEGER NOT NULL CHECK (total_count > 0),
  observation_count INTEGER NOT NULL CHECK (observation_count >= 0)
) STRICT;

CREATE TABLE expanded_stat_totals (
  total_id TEXT PRIMARY KEY REFERENCES player_stat_totals(id),
  refresh_id TEXT NOT NULL REFERENCES expanded_stat_refreshes(refresh_id),
  provider_player_id TEXT NOT NULL CHECK (length(provider_player_id) > 0 AND provider_player_id NOT GLOB '*[^0-9]*'),
  stats_json TEXT NOT NULL CHECK (json_valid(stats_json) AND json_type(stats_json) = 'object' AND json_type(stats_json, '$.evenStrengthGoals') IS 'integer' AND json_extract(stats_json, '$.evenStrengthGoals') >= 0 AND json_type(stats_json, '$.powerPlayGoals') IS 'integer' AND json_extract(stats_json, '$.powerPlayGoals') >= 0 AND json_type(stats_json, '$.shortHandedGoals') IS 'integer' AND json_extract(stats_json, '$.shortHandedGoals') >= 0 AND json_type(stats_json, '$.gameWinningGoals') IS 'integer' AND json_extract(stats_json, '$.gameWinningGoals') >= 0 AND json_type(stats_json, '$.primaryAssists') IS 'integer' AND json_extract(stats_json, '$.primaryAssists') >= 0 AND json_type(stats_json, '$.secondaryAssists') IS 'integer' AND json_extract(stats_json, '$.secondaryAssists') >= 0 AND json_type(stats_json, '$.shotsOnGoal') IS 'integer' AND json_extract(stats_json, '$.shotsOnGoal') >= 0 AND json_type(stats_json, '$.hits') IS 'integer' AND json_extract(stats_json, '$.hits') >= 0 AND json_type(stats_json, '$.blockedShots') IS 'integer' AND json_extract(stats_json, '$.blockedShots') >= 0 AND json_type(stats_json, '$.takeaways') IS 'integer' AND json_extract(stats_json, '$.takeaways') >= 0 AND json_type(stats_json, '$.giveaways') IS 'integer' AND json_extract(stats_json, '$.giveaways') >= 0 AND json_type(stats_json, '$.penaltiesDrawn') IS 'integer' AND json_extract(stats_json, '$.penaltiesDrawn') >= 0 AND json_type(stats_json, '$.penaltiesTaken') IS 'integer' AND json_extract(stats_json, '$.penaltiesTaken') >= 0),
  forward_fp_hundredths INTEGER NOT NULL CHECK (forward_fp_hundredths = json_extract(stats_json, '$.evenStrengthGoals') * 300 + json_extract(stats_json, '$.powerPlayGoals') * 275 + json_extract(stats_json, '$.shortHandedGoals') * 325 + json_extract(stats_json, '$.gameWinningGoals') * 100 + json_extract(stats_json, '$.primaryAssists') * 225 + json_extract(stats_json, '$.secondaryAssists') * 175 + json_extract(stats_json, '$.shotsOnGoal') * 20 + json_extract(stats_json, '$.hits') * 20 + json_extract(stats_json, '$.blockedShots') * 20 + json_extract(stats_json, '$.takeaways') * 20 + json_extract(stats_json, '$.giveaways') * -10 + json_extract(stats_json, '$.penaltiesDrawn') * 20 + json_extract(stats_json, '$.penaltiesTaken') * -20),
  defence_fp_hundredths INTEGER NOT NULL CHECK (defence_fp_hundredths = json_extract(stats_json, '$.evenStrengthGoals') * 300 + json_extract(stats_json, '$.powerPlayGoals') * 275 + json_extract(stats_json, '$.shortHandedGoals') * 325 + json_extract(stats_json, '$.gameWinningGoals') * 100 + json_extract(stats_json, '$.primaryAssists') * 225 + json_extract(stats_json, '$.secondaryAssists') * 175 + json_extract(stats_json, '$.shotsOnGoal') * 20 + json_extract(stats_json, '$.hits') * 35 + json_extract(stats_json, '$.blockedShots') * 35 + json_extract(stats_json, '$.takeaways') * 20 + json_extract(stats_json, '$.giveaways') * -10 + json_extract(stats_json, '$.penaltiesDrawn') * 20 + json_extract(stats_json, '$.penaltiesTaken') * -20)
) STRICT;

CREATE INDEX expanded_stat_totals_refresh ON expanded_stat_totals(refresh_id);

CREATE TRIGGER expanded_stat_totals_bound_insert BEFORE INSERT ON expanded_stat_totals
WHEN NOT EXISTS (SELECT 1 FROM player_stat_totals AS source JOIN stat_refreshes AS refresh ON refresh.id = source.refresh_id WHERE source.id = NEW.total_id AND source.refresh_id = NEW.refresh_id AND refresh.nhl_season_key = '20262027' AND refresh.status = 'succeeded')
BEGIN SELECT RAISE(ABORT, 'expanded statistics require their succeeded source refresh'); END;

CREATE TABLE expanded_player_game_stats (
  observation_id TEXT PRIMARY KEY REFERENCES player_game_stat_observations(id),
  games_played INTEGER NOT NULL CHECK (games_played IN (0, 1)),
  refresh_id TEXT NOT NULL REFERENCES expanded_stat_refreshes(refresh_id),
  provider_player_id TEXT NOT NULL CHECK (length(provider_player_id) > 0 AND provider_player_id NOT GLOB '*[^0-9]*'),
  stats_json TEXT NOT NULL CHECK (json_valid(stats_json) AND json_type(stats_json) = 'object' AND json_type(stats_json, '$.evenStrengthGoals') IS 'integer' AND json_extract(stats_json, '$.evenStrengthGoals') >= 0 AND json_type(stats_json, '$.powerPlayGoals') IS 'integer' AND json_extract(stats_json, '$.powerPlayGoals') >= 0 AND json_type(stats_json, '$.shortHandedGoals') IS 'integer' AND json_extract(stats_json, '$.shortHandedGoals') >= 0 AND json_type(stats_json, '$.gameWinningGoals') IS 'integer' AND json_extract(stats_json, '$.gameWinningGoals') >= 0 AND json_type(stats_json, '$.primaryAssists') IS 'integer' AND json_extract(stats_json, '$.primaryAssists') >= 0 AND json_type(stats_json, '$.secondaryAssists') IS 'integer' AND json_extract(stats_json, '$.secondaryAssists') >= 0 AND json_type(stats_json, '$.shotsOnGoal') IS 'integer' AND json_extract(stats_json, '$.shotsOnGoal') >= 0 AND json_type(stats_json, '$.hits') IS 'integer' AND json_extract(stats_json, '$.hits') >= 0 AND json_type(stats_json, '$.blockedShots') IS 'integer' AND json_extract(stats_json, '$.blockedShots') >= 0 AND json_type(stats_json, '$.takeaways') IS 'integer' AND json_extract(stats_json, '$.takeaways') >= 0 AND json_type(stats_json, '$.giveaways') IS 'integer' AND json_extract(stats_json, '$.giveaways') >= 0 AND json_type(stats_json, '$.penaltiesDrawn') IS 'integer' AND json_extract(stats_json, '$.penaltiesDrawn') >= 0 AND json_type(stats_json, '$.penaltiesTaken') IS 'integer' AND json_extract(stats_json, '$.penaltiesTaken') >= 0),
  forward_fp_hundredths INTEGER NOT NULL CHECK (forward_fp_hundredths = json_extract(stats_json, '$.evenStrengthGoals') * 300 + json_extract(stats_json, '$.powerPlayGoals') * 275 + json_extract(stats_json, '$.shortHandedGoals') * 325 + json_extract(stats_json, '$.gameWinningGoals') * 100 + json_extract(stats_json, '$.primaryAssists') * 225 + json_extract(stats_json, '$.secondaryAssists') * 175 + json_extract(stats_json, '$.shotsOnGoal') * 20 + json_extract(stats_json, '$.hits') * 20 + json_extract(stats_json, '$.blockedShots') * 20 + json_extract(stats_json, '$.takeaways') * 20 + json_extract(stats_json, '$.giveaways') * -10 + json_extract(stats_json, '$.penaltiesDrawn') * 20 + json_extract(stats_json, '$.penaltiesTaken') * -20),
  defence_fp_hundredths INTEGER NOT NULL CHECK (defence_fp_hundredths = json_extract(stats_json, '$.evenStrengthGoals') * 300 + json_extract(stats_json, '$.powerPlayGoals') * 275 + json_extract(stats_json, '$.shortHandedGoals') * 325 + json_extract(stats_json, '$.gameWinningGoals') * 100 + json_extract(stats_json, '$.primaryAssists') * 225 + json_extract(stats_json, '$.secondaryAssists') * 175 + json_extract(stats_json, '$.shotsOnGoal') * 20 + json_extract(stats_json, '$.hits') * 35 + json_extract(stats_json, '$.blockedShots') * 35 + json_extract(stats_json, '$.takeaways') * 20 + json_extract(stats_json, '$.giveaways') * -10 + json_extract(stats_json, '$.penaltiesDrawn') * 20 + json_extract(stats_json, '$.penaltiesTaken') * -20)
) STRICT;

CREATE INDEX expanded_player_game_stats_refresh ON expanded_player_game_stats(refresh_id);

CREATE TRIGGER expanded_player_game_stats_bound_insert BEFORE INSERT ON expanded_player_game_stats
WHEN NOT EXISTS (SELECT 1 FROM player_game_stat_observations AS source JOIN stat_refreshes AS refresh ON refresh.id = source.refresh_id WHERE source.id = NEW.observation_id AND source.refresh_id = NEW.refresh_id AND refresh.nhl_season_key = '20262027' AND refresh.status = 'succeeded')
BEGIN SELECT RAISE(ABORT, 'expanded statistics require their succeeded source refresh'); END;

CREATE TRIGGER expanded_stat_refreshes_immutable_update BEFORE UPDATE ON expanded_stat_refreshes
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

CREATE TRIGGER expanded_stat_refreshes_immutable_delete BEFORE DELETE ON expanded_stat_refreshes
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

CREATE TRIGGER expanded_stat_totals_immutable_update BEFORE UPDATE ON expanded_stat_totals
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

CREATE TRIGGER expanded_stat_totals_immutable_delete BEFORE DELETE ON expanded_stat_totals
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

CREATE TRIGGER expanded_player_game_stats_immutable_update BEFORE UPDATE ON expanded_player_game_stats
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

CREATE TRIGGER expanded_player_game_stats_immutable_delete BEFORE DELETE ON expanded_player_game_stats
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;
