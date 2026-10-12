-- Preserve every existing session and account record; remove only the
-- one-device restriction. Token digests remain globally unique.
DROP INDEX sessions_one_active_per_user;
CREATE INDEX sessions_active_by_user ON sessions(user_id) WHERE status = 'active';

UPDATE application_metadata
SET metadata_value = '90',
    updated_at_ms = CASE WHEN updated_at_ms < 90 THEN 90 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version' AND metadata_value = '89';
