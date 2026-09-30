-- Only unreferenced NHL refresh payloads older than 72 hours are eligible.
-- Refresh headers and retirement receipts remain; matchup evidence is pinned.
CREATE TABLE stat_refresh_payload_retirements (
  refresh_id TEXT PRIMARY KEY REFERENCES stat_refreshes(id) ON DELETE RESTRICT,
  retired_at_ms INTEGER NOT NULL CHECK (retired_at_ms >= 0),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json))
) STRICT;

CREATE INDEX player_stat_totals_by_refresh ON player_stat_totals(refresh_id);
CREATE INDEX player_game_stat_observations_by_refresh ON player_game_stat_observations(refresh_id);
CREATE INDEX stat_refresh_coverage_by_refresh ON stat_refresh_player_game_coverage_entries(refresh_id);
CREATE INDEX stat_snapshots_by_source_refresh ON stat_snapshots(source_refresh_id);
CREATE INDEX stat_refreshes_season_completion ON stat_refreshes(stat_source_id, nhl_season_key, completed_at_ms);

CREATE TRIGGER stat_refresh_payload_retirements_valid_insert
BEFORE INSERT ON stat_refresh_payload_retirements
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM stat_refreshes r JOIN stat_sources s ON s.id = r.stat_source_id
    WHERE r.id = NEW.refresh_id AND r.status = 'succeeded'
      AND s.provider = 'nhl-completed-games'
      AND r.completed_at_ms < NEW.retired_at_ms - 259200000
      AND EXISTS (SELECT 1 FROM stat_refreshes newer
        WHERE newer.stat_source_id = r.stat_source_id AND newer.nhl_season_key = r.nhl_season_key
          AND newer.status = 'succeeded' AND newer.completed_at_ms > r.completed_at_ms
          AND NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements retired WHERE retired.refresh_id = newer.id))
      AND NOT EXISTS (SELECT 1 FROM stat_snapshots p WHERE p.source_refresh_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM matchup_roster_game_exclusions x
        JOIN player_game_stat_observations o ON o.id = x.baseline_player_game_stat_observation_id
        WHERE o.refresh_id = r.id)
  ) THEN RAISE(ABORT, 'statistics retention cannot remove protected or recent evidence') END;
END;

DROP TRIGGER expanded_player_game_stats_immutable_delete;
CREATE TRIGGER expanded_player_game_stats_immutable_delete BEFORE DELETE ON expanded_player_game_stats
WHEN NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id = OLD.refresh_id)
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

DROP TRIGGER expanded_stat_totals_immutable_delete;
CREATE TRIGGER expanded_stat_totals_immutable_delete BEFORE DELETE ON expanded_stat_totals
WHEN NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id = OLD.refresh_id)
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

DROP TRIGGER expanded_stat_refreshes_immutable_delete;
CREATE TRIGGER expanded_stat_refreshes_immutable_delete BEFORE DELETE ON expanded_stat_refreshes
WHEN NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id = OLD.refresh_id)
BEGIN SELECT RAISE(ABORT, 'expanded statistics are immutable'); END;

DROP TRIGGER stat_refresh_player_game_coverage_immutable_delete;
CREATE TRIGGER stat_refresh_player_game_coverage_immutable_delete BEFORE DELETE ON stat_refresh_player_game_coverage_entries
WHEN NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id = OLD.refresh_id)
BEGIN SELECT RAISE(ABORT, 'player-game coverage entry is immutable'); END;

DROP TRIGGER player_game_stat_observations_immutable_delete;
CREATE TRIGGER player_game_stat_observations_immutable_delete BEFORE DELETE ON player_game_stat_observations
WHEN NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id = OLD.refresh_id)
BEGIN SELECT RAISE(ABORT, 'player-game stat observation is immutable'); END;

DROP TRIGGER stat_refresh_player_game_sets_immutable_delete;
CREATE TRIGGER stat_refresh_player_game_sets_immutable_delete BEFORE DELETE ON stat_refresh_player_game_sets
WHEN NOT EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id = OLD.refresh_id)
BEGIN SELECT RAISE(ABORT, 'player-game observation set is immutable'); END;

CREATE TRIGGER stat_refresh_payload_retirements_apply AFTER INSERT ON stat_refresh_payload_retirements
BEGIN
  DELETE FROM expanded_player_game_stats WHERE refresh_id = NEW.refresh_id;
  DELETE FROM expanded_stat_totals WHERE refresh_id = NEW.refresh_id;
  DELETE FROM expanded_stat_refreshes WHERE refresh_id = NEW.refresh_id;
  DELETE FROM stat_refresh_player_game_coverage_entries WHERE refresh_id = NEW.refresh_id;
  DELETE FROM player_game_stat_observations WHERE refresh_id = NEW.refresh_id;
  DELETE FROM stat_refresh_player_game_sets WHERE refresh_id = NEW.refresh_id;
  DELETE FROM player_stat_totals WHERE refresh_id = NEW.refresh_id;
END;

CREATE TRIGGER stat_refresh_payload_retirements_immutable_update BEFORE UPDATE ON stat_refresh_payload_retirements
BEGIN SELECT RAISE(ABORT, 'statistics retention receipt is immutable'); END;
CREATE TRIGGER stat_refresh_payload_retirements_immutable_delete BEFORE DELETE ON stat_refresh_payload_retirements
BEGIN SELECT RAISE(ABORT, 'statistics retention receipt is immutable'); END;
CREATE TRIGGER stat_snapshots_reject_retired_refresh BEFORE INSERT ON stat_snapshots
WHEN EXISTS (SELECT 1 FROM stat_refresh_payload_retirements WHERE refresh_id = NEW.source_refresh_id)
BEGIN SELECT RAISE(ABORT, 'retired refresh cannot become matchup evidence'); END;

UPDATE application_metadata SET metadata_value='68', updated_at_ms=max(updated_at_ms,68)
WHERE metadata_key='data_model_version' AND metadata_value='67';
