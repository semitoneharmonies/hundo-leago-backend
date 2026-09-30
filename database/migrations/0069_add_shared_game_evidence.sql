-- Additive foundation only: existing statistics and matchup evidence stay intact.
-- Captures share unchanged games through an ordered history of changes.
CREATE TABLE shared_game_evidence_captures (
  refresh_id TEXT PRIMARY KEY REFERENCES stat_refreshes(id) ON DELETE RESTRICT,
  stat_source_id TEXT NOT NULL REFERENCES stat_sources(id) ON DELETE RESTRICT,
  nhl_season_key TEXT NOT NULL CHECK (length(nhl_season_key) = 8),
  revision INTEGER NOT NULL CHECK (revision > 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= observed_at_ms),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
  UNIQUE (stat_source_id, nhl_season_key, revision)
) STRICT;

CREATE TABLE shared_game_evidence_changes (
  id TEXT PRIMARY KEY,
  stat_source_id TEXT NOT NULL,
  nhl_season_key TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  nhl_game_id TEXT NOT NULL CHECK (length(nhl_game_id) BETWEEN 1 AND 200),
  revision INTEGER NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK ((payload_json IS NULL) = (payload_sha256 IS NULL)),
  UNIQUE (stat_source_id, nhl_season_key, player_id, nhl_game_id, revision),
  FOREIGN KEY (stat_source_id, nhl_season_key, revision)
    REFERENCES shared_game_evidence_captures(stat_source_id, nhl_season_key, revision) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER shared_game_evidence_captures_valid_insert
BEFORE INSERT ON shared_game_evidence_captures
BEGIN
  SELECT CASE WHEN NEW.sealed <> 0 OR NOT EXISTS (
    SELECT 1 FROM stat_refreshes r JOIN stat_sources s ON s.id = r.stat_source_id
    WHERE r.id = NEW.refresh_id AND r.stat_source_id = NEW.stat_source_id
      AND r.nhl_season_key = NEW.nhl_season_key AND r.status = 'started'
      AND s.provider = 'nhl-completed-games'
      AND r.started_at_ms <= NEW.observed_at_ms
  ) OR NEW.revision <> COALESCE((SELECT MAX(revision) + 1 FROM shared_game_evidence_captures
    WHERE stat_source_id = NEW.stat_source_id AND nhl_season_key = NEW.nhl_season_key), 1)
  OR EXISTS (SELECT 1 FROM shared_game_evidence_captures previous
    WHERE previous.stat_source_id = NEW.stat_source_id AND previous.nhl_season_key = NEW.nhl_season_key
      AND (previous.sealed = 0 OR previous.captured_at_ms > NEW.captured_at_ms
        OR previous.observed_at_ms > NEW.observed_at_ms))
  THEN RAISE(ABORT, 'shared game capture source or order is invalid') END;
END;

CREATE TRIGGER shared_game_evidence_captures_seal_only
BEFORE UPDATE ON shared_game_evidence_captures
WHEN OLD.sealed <> 0 OR NEW.sealed <> 1
  OR NEW.refresh_id IS NOT OLD.refresh_id OR NEW.stat_source_id IS NOT OLD.stat_source_id
  OR NEW.nhl_season_key IS NOT OLD.nhl_season_key OR NEW.revision IS NOT OLD.revision
  OR NEW.observed_at_ms IS NOT OLD.observed_at_ms OR NEW.captured_at_ms IS NOT OLD.captured_at_ms
  OR NEW.record_count IS NOT OLD.record_count OR NEW.evidence_sha256 IS NOT OLD.evidence_sha256
BEGIN SELECT RAISE(ABORT, 'shared game captures are immutable after sealing'); END;

CREATE TRIGGER shared_game_evidence_changes_open_capture
BEFORE INSERT ON shared_game_evidence_changes
WHEN NOT EXISTS (SELECT 1 FROM shared_game_evidence_captures c
  WHERE c.stat_source_id = NEW.stat_source_id AND c.nhl_season_key = NEW.nhl_season_key
    AND c.revision = NEW.revision AND c.sealed = 0)
BEGIN SELECT RAISE(ABORT, 'shared game changes require an open capture'); END;

CREATE TRIGGER shared_game_evidence_captures_immutable_delete
BEFORE DELETE ON shared_game_evidence_captures
BEGIN SELECT RAISE(ABORT, 'shared game capture history is protected'); END;

CREATE TRIGGER shared_game_evidence_changes_immutable_update
BEFORE UPDATE ON shared_game_evidence_changes
BEGIN SELECT RAISE(ABORT, 'shared game evidence is immutable'); END;

CREATE TRIGGER shared_game_evidence_changes_immutable_delete
BEFORE DELETE ON shared_game_evidence_changes
BEGIN SELECT RAISE(ABORT, 'shared game evidence is protected'); END;

UPDATE application_metadata SET metadata_value='69', updated_at_ms=max(updated_at_ms,69)
WHERE metadata_key='data_model_version' AND metadata_value='68';
