-- Add a shared quote catalogue. No existing records are rewritten.
-- Approved global quotes survive removal of their originating league.
CREATE TABLE quote_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  source_league_id TEXT REFERENCES leagues(id) ON DELETE SET NULL,
  submitted_by_user_id TEXT NOT NULL REFERENCES users(id),
  quote_text TEXT NOT NULL CHECK (length(trim(quote_text)) BETWEEN 1 AND 500),
  attribution TEXT NOT NULL CHECK (length(trim(attribution)) BETWEEN 1 AND 80),
  league_status TEXT NOT NULL DEFAULT 'pending' CHECK (league_status IN ('pending', 'approved', 'rejected')),
  global_status TEXT NOT NULL DEFAULT 'pending' CHECK (global_status IN ('pending', 'approved', 'rejected')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;
CREATE INDEX quote_submissions_league ON quote_submissions(source_league_id, league_status, created_at_ms DESC, id DESC);
CREATE INDEX quote_submissions_global ON quote_submissions(global_status, created_at_ms DESC, id DESC);

UPDATE application_metadata
SET metadata_value = '85',
    updated_at_ms = CASE WHEN updated_at_ms < 85 THEN 85 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version' AND metadata_value = '84';
