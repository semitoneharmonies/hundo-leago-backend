ALTER TABLE player_injury_status ADD COLUMN timeline TEXT CHECK (timeline IS NULL OR length(timeline) <= 100);
ALTER TABLE player_injury_status ADD COLUMN designation TEXT CHECK (designation IS NULL OR length(designation) <= 30);
ALTER TABLE player_injury_status ADD COLUMN injury_reason TEXT CHECK (injury_reason IS NULL OR length(injury_reason) <= 200);

UPDATE application_metadata SET metadata_value = '91', updated_at_ms = MAX(updated_at_ms, 91)
WHERE metadata_key = 'data_model_version' AND metadata_value = '90';
