ALTER TABLE seasons
ADD COLUMN free_agent_draft_completed_at_ms INTEGER
  CHECK (
    free_agent_draft_completed_at_ms IS NULL
    OR free_agent_draft_completed_at_ms >= 0
  );

UPDATE application_metadata
SET
  metadata_value = '9',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
