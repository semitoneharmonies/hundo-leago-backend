-- Shared evidence is additive. Existing captures and every league record stay intact.
CREATE TABLE shared_stat_total_changes (
  id TEXT PRIMARY KEY,
  stat_source_id TEXT NOT NULL,
  nhl_season_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR (length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  UNIQUE (stat_source_id, nhl_season_key, player_id, revision),
  CHECK ((payload_json IS NULL) = (payload_sha256 IS NULL)),
  FOREIGN KEY (stat_source_id, nhl_season_key, revision)
    REFERENCES shared_game_evidence_captures(stat_source_id, nhl_season_key, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE shared_empty_coverage_sets (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;
CREATE TRIGGER shared_empty_coverage_sets_immutable_update BEFORE UPDATE ON shared_empty_coverage_sets
BEGIN SELECT RAISE(ABORT,'shared coverage is immutable'); END;
CREATE TRIGGER shared_empty_coverage_sets_immutable_delete BEFORE DELETE ON shared_empty_coverage_sets
BEGIN SELECT RAISE(ABORT,'shared coverage is protected'); END;

CREATE TABLE compact_stat_refreshes (
  refresh_id TEXT PRIMARY KEY REFERENCES shared_game_evidence_captures(refresh_id) ON DELETE RESTRICT,
  format_version INTEGER NOT NULL CHECK (format_version=1),
  total_count INTEGER NOT NULL CHECK (total_count>0),
  totals_sha256 TEXT NOT NULL CHECK (length(totals_sha256)=64),
  empty_coverage_sha256 TEXT NOT NULL REFERENCES shared_empty_coverage_sets(sha256) ON DELETE RESTRICT,
  required_player_count INTEGER NOT NULL CHECK (required_player_count>=0),
  coverage_entry_count INTEGER NOT NULL CHECK (coverage_entry_count>=0),
  coverage_sha256 TEXT NOT NULL CHECK (length(coverage_sha256)=64),
  observation_sha256 TEXT NOT NULL CHECK (length(observation_sha256)=64),
  expanded_sha256 TEXT NOT NULL CHECK (length(expanded_sha256)=64)
) STRICT;

CREATE TRIGGER shared_stat_total_changes_open_refresh BEFORE INSERT ON shared_stat_total_changes
WHEN NOT EXISTS (
  SELECT 1 FROM shared_game_evidence_captures c JOIN stat_refreshes r ON r.id=c.refresh_id
  WHERE c.stat_source_id=NEW.stat_source_id AND c.nhl_season_key=NEW.nhl_season_key
    AND c.revision=NEW.revision AND c.sealed=1
    AND NOT EXISTS (SELECT 1 FROM compact_stat_refreshes m WHERE m.refresh_id=r.id)
    AND NOT EXISTS (SELECT 1 FROM stat_refresh_player_game_sets s WHERE s.refresh_id=r.id)
)
BEGIN SELECT RAISE(ABORT,'shared totals require an open compact refresh'); END;
CREATE TRIGGER shared_stat_total_changes_immutable_update BEFORE UPDATE ON shared_stat_total_changes
BEGIN SELECT RAISE(ABORT,'shared total history is immutable'); END;
CREATE TRIGGER shared_stat_total_changes_immutable_delete BEFORE DELETE ON shared_stat_total_changes
BEGIN SELECT RAISE(ABORT,'shared total history is protected'); END;
CREATE TRIGGER compact_stat_refreshes_valid_insert BEFORE INSERT ON compact_stat_refreshes
WHEN NOT EXISTS (
  SELECT 1 FROM shared_game_evidence_captures c JOIN stat_refreshes r ON r.id=c.refresh_id
  WHERE c.refresh_id=NEW.refresh_id AND c.sealed=1 AND r.status='succeeded'
    AND r.player_count=NEW.total_count AND c.captured_at_ms=r.completed_at_ms
    AND NEW.coverage_entry_count=c.record_count+json_array_length((SELECT payload_json FROM shared_empty_coverage_sets WHERE sha256=NEW.empty_coverage_sha256))
    AND NOT EXISTS (SELECT 1 FROM stat_refresh_player_game_sets s WHERE s.refresh_id=r.id)
)
BEGIN SELECT RAISE(ABORT,'compact statistics must seal a matching successful capture'); END;
CREATE TRIGGER compact_stat_refreshes_immutable_update BEFORE UPDATE ON compact_stat_refreshes
BEGIN SELECT RAISE(ABORT,'compact statistics are immutable'); END;
CREATE TRIGGER compact_stat_refreshes_immutable_delete BEFORE DELETE ON compact_stat_refreshes
BEGIN SELECT RAISE(ABORT,'compact statistics are protected'); END;

-- The full legacy seal check is retained below for all non-compact captures.
DROP TRIGGER stat_refresh_player_game_sets_valid_insert;
CREATE TRIGGER stat_refresh_player_game_sets_valid_insert
BEFORE INSERT ON stat_refresh_player_game_sets
WHEN NOT EXISTS (SELECT 1 FROM compact_stat_refreshes WHERE refresh_id=NEW.refresh_id)
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.created_at_ms = NEW.captured_at_ms
    AND EXISTS (
      SELECT 1
      FROM stat_sources
      WHERE stat_sources.id = NEW.stat_source_id
        AND stat_sources.provider = NEW.provider
        AND stat_sources.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM stat_refreshes
      WHERE stat_refreshes.id = NEW.refresh_id
        AND stat_refreshes.stat_source_id =
          NEW.stat_source_id
        AND stat_refreshes.nhl_season_key =
          NEW.nhl_season_key
        AND stat_refreshes.source_version =
          NEW.source_version
        AND stat_refreshes.status = 'succeeded'
        AND stat_refreshes.completed_at_ms =
          NEW.captured_at_ms
        AND stat_refreshes.player_count IS NOT NULL
        AND stat_refreshes.error_code IS NULL
    )
    AND (
      SELECT COUNT(*)
      FROM stat_refresh_player_game_coverage_entries
      WHERE stat_refresh_player_game_coverage_entries.stat_source_id =
          NEW.stat_source_id
        AND stat_refresh_player_game_coverage_entries.refresh_id =
          NEW.refresh_id
        AND stat_refresh_player_game_coverage_entries.observation_set_id =
          NEW.id
        AND stat_refresh_player_game_coverage_entries.nhl_season_key =
          NEW.nhl_season_key
        AND stat_refresh_player_game_coverage_entries.created_at_ms =
          NEW.captured_at_ms
    ) = NEW.coverage_entry_count
    AND (
      SELECT COUNT(DISTINCT player_id)
      FROM stat_refresh_player_game_coverage_entries
      WHERE stat_refresh_player_game_coverage_entries.stat_source_id =
          NEW.stat_source_id
        AND stat_refresh_player_game_coverage_entries.refresh_id =
          NEW.refresh_id
        AND stat_refresh_player_game_coverage_entries.observation_set_id =
          NEW.id
    ) = NEW.required_player_count
    AND (
      SELECT COUNT(*)
      FROM stat_refresh_player_game_coverage_entries
      WHERE stat_refresh_player_game_coverage_entries.stat_source_id =
          NEW.stat_source_id
        AND stat_refresh_player_game_coverage_entries.refresh_id =
          NEW.refresh_id
        AND stat_refresh_player_game_coverage_entries.observation_set_id =
          NEW.id
        AND stat_refresh_player_game_coverage_entries.disposition =
          'expected_game'
    ) = NEW.expected_player_game_count
    AND NEW.observation_count = NEW.expected_player_game_count
    AND NOT EXISTS (
      SELECT 1
      FROM stat_refresh_player_game_coverage_entries AS coverage
      WHERE coverage.observation_set_id = NEW.id
        AND (
          coverage.stat_source_id <> NEW.stat_source_id
          OR coverage.refresh_id <> NEW.refresh_id
          OR coverage.nhl_season_key <> NEW.nhl_season_key
          OR coverage.created_at_ms <> NEW.captured_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM stat_refresh_player_game_coverage_entries AS left_coverage
      JOIN stat_refresh_player_game_coverage_entries AS right_coverage
        ON right_coverage.observation_set_id =
            left_coverage.observation_set_id
       AND right_coverage.player_id = left_coverage.player_id
       AND right_coverage.id <> left_coverage.id
      WHERE left_coverage.observation_set_id = NEW.id
        AND (
          left_coverage.provider_player_id <>
            right_coverage.provider_player_id
          OR (
            left_coverage.disposition = 'expected_game'
            AND right_coverage.disposition IN ('no_due_game', 'no_team')
          )
          OR (
            right_coverage.disposition = 'expected_game'
            AND left_coverage.disposition IN ('no_due_game', 'no_team')
          )
        )
    )
    AND (
      SELECT COUNT(*)
      FROM player_game_stat_observations
      WHERE player_game_stat_observations.stat_source_id =
          NEW.stat_source_id
        AND player_game_stat_observations.refresh_id =
          NEW.refresh_id
        AND player_game_stat_observations.observation_set_id =
          NEW.id
        AND player_game_stat_observations.nhl_season_key =
          NEW.nhl_season_key
        AND player_game_stat_observations.created_at_ms =
          NEW.captured_at_ms
    ) = NEW.observation_count
    AND NOT EXISTS (
      SELECT 1
      FROM player_game_stat_observations
      WHERE player_game_stat_observations.observation_set_id =
          NEW.id
        AND (
          player_game_stat_observations.stat_source_id <>
            NEW.stat_source_id
          OR player_game_stat_observations.refresh_id <>
            NEW.refresh_id
          OR player_game_stat_observations.nhl_season_key <>
            NEW.nhl_season_key
          OR player_game_stat_observations.created_at_ms <>
            NEW.captured_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM stat_refresh_player_game_coverage_entries AS coverage
      WHERE coverage.observation_set_id = NEW.id
        AND coverage.disposition = 'expected_game'
        AND NOT EXISTS (
          SELECT 1
          FROM player_game_stat_observations AS observation
          WHERE observation.observation_set_id = NEW.id
            AND observation.player_id = coverage.player_id
            AND observation.nhl_game_id = coverage.nhl_game_id
            AND observation.nhl_game_scheduled_starts_at_ms =
              coverage.nhl_game_scheduled_starts_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM player_game_stat_observations AS observation
      WHERE observation.observation_set_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM stat_refresh_player_game_coverage_entries AS coverage
          WHERE coverage.observation_set_id = NEW.id
            AND coverage.disposition = 'expected_game'
            AND coverage.player_id = observation.player_id
            AND coverage.nhl_game_id = observation.nhl_game_id
            AND coverage.nhl_game_scheduled_starts_at_ms =
              observation.nhl_game_scheduled_starts_at_ms
        )
    )
  ) THEN RAISE(
    ABORT,
    'player-game observation set must seal one exact successful refresh'
  ) END;
END;

CREATE TRIGGER compact_stat_refreshes_bound_set BEFORE INSERT ON stat_refresh_player_game_sets
WHEN EXISTS (SELECT 1 FROM compact_stat_refreshes WHERE refresh_id=NEW.refresh_id)
AND NOT EXISTS (
  SELECT 1 FROM compact_stat_refreshes m JOIN shared_game_evidence_captures c ON c.refresh_id=m.refresh_id
  JOIN stat_refreshes r ON r.id=m.refresh_id JOIN stat_sources s ON s.id=r.stat_source_id
  WHERE m.refresh_id=NEW.refresh_id AND c.sealed=1 AND r.status='succeeded' AND s.status='active'
    AND NEW.stat_source_id=c.stat_source_id AND NEW.nhl_season_key=c.nhl_season_key
    AND NEW.provider=s.provider AND NEW.source_version=r.source_version
    AND NEW.captured_at_ms=c.captured_at_ms AND NEW.created_at_ms=c.captured_at_ms AND NEW.version=1
    AND NEW.required_player_count=m.required_player_count AND NEW.coverage_entry_count=m.coverage_entry_count
    AND NEW.expected_player_game_count=c.record_count AND NEW.observation_count=c.record_count
    AND NEW.coverage_sha256=m.coverage_sha256 AND NEW.evidence_sha256=m.observation_sha256
    AND NEW.coverage_schema_version=1 AND NEW.evidence_schema_version=1
)
BEGIN SELECT RAISE(ABORT,'compact statistics seal does not match its capture'); END;

-- Only the latest physical totals are needed by the existing SQL player lists.
-- Historical totals remain reconstructible from immutable shared versions.
DROP TRIGGER expanded_stat_totals_immutable_update;
CREATE TRIGGER expanded_stat_totals_immutable_update BEFORE UPDATE ON expanded_stat_totals
WHEN NEW.total_id IS NOT OLD.total_id OR NEW.provider_player_id IS NOT OLD.provider_player_id
 OR NOT EXISTS (
   SELECT 1 FROM compact_stat_refreshes previous JOIN shared_game_evidence_captures old ON old.refresh_id=previous.refresh_id
   JOIN shared_game_evidence_captures next ON next.stat_source_id=old.stat_source_id AND next.nhl_season_key=old.nhl_season_key AND next.revision>old.revision
   JOIN compact_stat_refreshes current ON current.refresh_id=next.refresh_id
   JOIN player_stat_totals p ON p.id=NEW.total_id AND p.refresh_id=NEW.refresh_id
   WHERE previous.refresh_id=OLD.refresh_id AND current.refresh_id=NEW.refresh_id
 )
BEGIN SELECT RAISE(ABORT,'only a verified newer compact projection may replace expanded totals'); END;

DROP TRIGGER expanded_stat_totals_immutable_delete;
CREATE TRIGGER expanded_stat_totals_immutable_delete BEFORE DELETE ON expanded_stat_totals
WHEN NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id=OLD.refresh_id)
 AND NOT EXISTS (SELECT 1 FROM compact_stat_refreshes m JOIN stat_refreshes old ON old.id=m.refresh_id
   JOIN stat_refreshes newer ON newer.stat_source_id=old.stat_source_id AND newer.nhl_season_key=old.nhl_season_key
   JOIN compact_stat_refreshes next ON next.refresh_id=newer.id
   WHERE m.refresh_id=OLD.refresh_id AND newer.status='succeeded' AND newer.completed_at_ms>old.completed_at_ms)
BEGIN SELECT RAISE(ABORT,'expanded statistics are immutable'); END;

-- Compact headers and shared history are never candidates for legacy retirement.
CREATE TRIGGER compact_stat_refreshes_reject_retirement BEFORE INSERT ON stat_refresh_payload_retirements
WHEN EXISTS (SELECT 1 FROM compact_stat_refreshes WHERE refresh_id=NEW.refresh_id)
BEGIN SELECT RAISE(ABORT,'shared statistics cannot use legacy retirement'); END;

DROP TRIGGER stat_refresh_player_game_coverage_stage_before_set;
CREATE TRIGGER stat_refresh_player_game_coverage_stage_before_set BEFORE INSERT ON stat_refresh_player_game_coverage_entries
WHEN EXISTS (SELECT 1 FROM stat_refresh_player_game_sets WHERE id=NEW.observation_set_id)
 AND NOT EXISTS (SELECT 1 FROM compact_stat_refreshes m JOIN shared_game_evidence_captures c ON c.refresh_id=m.refresh_id
 JOIN stat_refresh_player_game_sets s ON s.refresh_id=m.refresh_id
 JOIN shared_game_evidence_changes g ON g.stat_source_id=c.stat_source_id AND g.nhl_season_key=c.nhl_season_key
   AND g.player_id=NEW.player_id AND g.nhl_game_id=NEW.nhl_game_id
 WHERE c.refresh_id=NEW.refresh_id AND c.stat_source_id=NEW.stat_source_id AND c.nhl_season_key=NEW.nhl_season_key
   AND s.id=NEW.observation_set_id AND c.sealed=1 AND NEW.created_at_ms=c.captured_at_ms AND NEW.version=1
   AND g.revision=(SELECT max(v.revision) FROM shared_game_evidence_changes v
     WHERE v.stat_source_id=g.stat_source_id AND v.nhl_season_key=g.nhl_season_key AND v.player_id=g.player_id
       AND v.nhl_game_id=g.nhl_game_id AND v.revision<=c.revision)
   AND g.payload_json IS NOT NULL
   AND NEW.nhl_game_scheduled_starts_at_ms=json_extract(g.payload_json,'$.scheduledStartsAtMs')
 AND NEW.disposition='expected_game'
 AND NEW.provider_player_id=json_extract(g.payload_json,'$.providerPlayerId')
 AND NEW.provider_team_id=json_extract(g.payload_json,'$.providerTeamId'))
BEGIN SELECT RAISE(ABORT,'only exact compact baseline evidence can be materialized after sealing'); END;

DROP TRIGGER player_game_stat_observations_stage_before_set;
CREATE TRIGGER player_game_stat_observations_stage_before_set BEFORE INSERT ON player_game_stat_observations
WHEN EXISTS (SELECT 1 FROM stat_refresh_player_game_sets WHERE id=NEW.observation_set_id)
 AND NOT EXISTS (SELECT 1 FROM compact_stat_refreshes m JOIN shared_game_evidence_captures c ON c.refresh_id=m.refresh_id
 JOIN stat_refresh_player_game_sets s ON s.refresh_id=m.refresh_id
 JOIN shared_game_evidence_changes g ON g.stat_source_id=c.stat_source_id AND g.nhl_season_key=c.nhl_season_key
   AND g.player_id=NEW.player_id AND g.nhl_game_id=NEW.nhl_game_id
 WHERE c.refresh_id=NEW.refresh_id AND c.stat_source_id=NEW.stat_source_id AND c.nhl_season_key=NEW.nhl_season_key
   AND s.id=NEW.observation_set_id AND c.sealed=1 AND NEW.created_at_ms=c.captured_at_ms AND NEW.version=1
   AND g.revision=(SELECT max(v.revision) FROM shared_game_evidence_changes v
     WHERE v.stat_source_id=g.stat_source_id AND v.nhl_season_key=g.nhl_season_key AND v.player_id=g.player_id
       AND v.nhl_game_id=g.nhl_game_id AND v.revision<=c.revision)
   AND g.payload_json IS NOT NULL
   AND NEW.nhl_game_scheduled_starts_at_ms=json_extract(g.payload_json,'$.scheduledStartsAtMs')
 AND NEW.observed_game_state=json_extract(g.payload_json,'$.gameState')
 AND NEW.goals=json_extract(g.payload_json,'$.goals') AND NEW.assists=json_extract(g.payload_json,'$.assists')
 AND NEW.nhl_points=NEW.goals+NEW.assists AND NEW.fantasy_points_hundredths=NEW.goals*125+NEW.assists*100
 AND NEW.source_updated_at_ms=c.observed_at_ms)
BEGIN SELECT RAISE(ABORT,'only exact compact baseline evidence can be materialized after sealing'); END;

UPDATE application_metadata SET metadata_value='70',updated_at_ms=max(updated_at_ms,70)
WHERE metadata_key='data_model_version' AND metadata_value='69';
