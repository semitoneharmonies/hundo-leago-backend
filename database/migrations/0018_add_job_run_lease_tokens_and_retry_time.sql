ALTER TABLE job_runs ADD COLUMN lease_token TEXT;
ALTER TABLE job_runs ADD COLUMN next_attempt_at_ms INTEGER
  CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0);

UPDATE job_runs
SET next_attempt_at_ms = CASE
  WHEN status IN ('pending', 'failed') THEN scheduled_for_ms
  ELSE NULL
END;

CREATE INDEX job_runs_due_v2
  ON job_runs (status, next_attempt_at_ms, scheduled_for_ms, lease_expires_at_ms);

UPDATE application_metadata
SET metadata_value = '18',
    updated_at_ms = CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
