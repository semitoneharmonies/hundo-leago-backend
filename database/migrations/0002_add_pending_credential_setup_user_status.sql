-- hundo-leago: foreign-key-rebuild
-- Add the distinct pending state required for administrator-created accounts.
-- The original migration is immutable, so rebuild only the users constraint.

CREATE TABLE users_m3_09 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  email_normalized TEXT NOT NULL UNIQUE
    CHECK (
      email_normalized = lower(trim(email_normalized))
      AND length(email_normalized) BETWEEN 3 AND 320
    ),
  email_display TEXT NOT NULL
    CHECK (length(trim(email_display)) BETWEEN 3 AND 320),
  display_name TEXT NOT NULL
    CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
  display_name_normalized TEXT NOT NULL UNIQUE
    CHECK (
      display_name_normalized = lower(trim(display_name_normalized))
      AND length(display_name_normalized) BETWEEN 1 AND 100
    ),
  status TEXT NOT NULL
    CHECK (status IN (
      'pending_verification',
      'pending_credential_setup',
      'active',
      'deactivated',
      'disabled'
    )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

INSERT INTO users_m3_09 (
  id,
  email_normalized,
  email_display,
  display_name,
  display_name_normalized,
  status,
  created_at_ms,
  updated_at_ms,
  version
)
SELECT
  id,
  email_normalized,
  email_display,
  display_name,
  display_name_normalized,
  status,
  created_at_ms,
  updated_at_ms,
  version
FROM users;

DROP TABLE users;

ALTER TABLE users_m3_09 RENAME TO users;

UPDATE application_metadata
SET
  metadata_value = '2',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
