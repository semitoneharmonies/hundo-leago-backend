-- hundo-leago: foreign-key-rebuild
-- Replace legacy matchup lifecycle labels with the approved M6 state model.

DROP TRIGGER matchups_team_conflict_insert;
DROP TRIGGER matchups_team_conflict_update;
DROP TRIGGER matchup_byes_team_conflict_insert;
DROP TRIGGER matchup_byes_team_conflict_update;

CREATE TABLE matchup_weeks_m6_03 (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  week_key TEXT NOT NULL CHECK (length(trim(week_key)) > 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0),
  baseline_at_ms INTEGER NOT NULL CHECK (baseline_at_ms >= starts_at_ms),
  locks_at_ms INTEGER NOT NULL CHECK (locks_at_ms >= baseline_at_ms),
  ends_at_ms INTEGER NOT NULL CHECK (ends_at_ms > locks_at_ms),
  rolls_over_at_ms INTEGER NOT NULL CHECK (rolls_over_at_ms >= ends_at_ms),
  status TEXT NOT NULL CHECK (status IN (
    'scheduled', 'baseline_ready', 'live', 'awaiting_data', 'final',
    'correction_required', 'cancelled'
  )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, week_key),
  UNIQUE (league_id, season_id, sequence),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO matchup_weeks_m6_03
SELECT
  id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms,
  locks_at_ms, ends_at_ms, rolls_over_at_ms,
  CASE status
    WHEN 'open' THEN 'baseline_ready'
    WHEN 'locked' THEN 'live'
    WHEN 'finalizing' THEN 'awaiting_data'
    WHEN 'finalized' THEN 'final'
    WHEN 'rolled_over' THEN 'final'
    WHEN 'failed' THEN 'correction_required'
    ELSE status
  END,
  created_at_ms, updated_at_ms, version
FROM matchup_weeks;

DROP TABLE matchup_weeks;
ALTER TABLE matchup_weeks_m6_03 RENAME TO matchup_weeks;

CREATE TABLE matchups_m6_03 (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  home_team_name TEXT NOT NULL CHECK (length(trim(home_team_name)) BETWEEN 1 AND 120),
  away_team_name TEXT NOT NULL CHECK (length(trim(away_team_name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN (
    'scheduled', 'live', 'awaiting_data', 'final', 'postponed', 'cancelled',
    'correction_required'
  )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, matchup_week_id, home_team_id, away_team_id),
  CHECK (home_team_id <> away_team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, home_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, away_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO matchups_m6_03
SELECT
  id, league_id, season_id, matchup_week_id, home_team_id, away_team_id,
  home_team_name, away_team_name,
  CASE status WHEN 'active' THEN 'live' WHEN 'finalized' THEN 'final' ELSE status END,
  created_at_ms, updated_at_ms, version
FROM matchups;

DROP TABLE matchups;
ALTER TABLE matchups_m6_03 RENAME TO matchups;

CREATE TRIGGER matchups_team_conflict_insert
BEFORE INSERT ON matchups
WHEN EXISTS (
    SELECT 1 FROM matchups
    WHERE league_id = NEW.league_id
      AND matchup_week_id = NEW.matchup_week_id
      AND (
        NEW.home_team_id IN (home_team_id, away_team_id)
        OR NEW.away_team_id IN (home_team_id, away_team_id)
      )
  )
  OR EXISTS (
    SELECT 1 FROM matchup_byes
    WHERE league_id = NEW.league_id
      AND matchup_week_id = NEW.matchup_week_id
      AND team_id IN (NEW.home_team_id, NEW.away_team_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup or bye in this week');
END;

CREATE TRIGGER matchups_team_conflict_update
BEFORE UPDATE OF league_id, matchup_week_id, home_team_id, away_team_id ON matchups
WHEN EXISTS (
    SELECT 1 FROM matchups
    WHERE id <> OLD.id
      AND league_id = NEW.league_id
      AND matchup_week_id = NEW.matchup_week_id
      AND (
        NEW.home_team_id IN (home_team_id, away_team_id)
        OR NEW.away_team_id IN (home_team_id, away_team_id)
      )
  )
  OR EXISTS (
    SELECT 1 FROM matchup_byes
    WHERE league_id = NEW.league_id
      AND matchup_week_id = NEW.matchup_week_id
      AND team_id IN (NEW.home_team_id, NEW.away_team_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup or bye in this week');
END;

CREATE TRIGGER matchup_byes_team_conflict_insert
BEFORE INSERT ON matchup_byes
WHEN EXISTS (
  SELECT 1 FROM matchups
  WHERE league_id = NEW.league_id
    AND matchup_week_id = NEW.matchup_week_id
    AND NEW.team_id IN (home_team_id, away_team_id)
)
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup in this week');
END;

CREATE TRIGGER matchup_byes_team_conflict_update
BEFORE UPDATE OF league_id, matchup_week_id, team_id ON matchup_byes
WHEN EXISTS (
  SELECT 1 FROM matchups
  WHERE league_id = NEW.league_id
    AND matchup_week_id = NEW.matchup_week_id
    AND NEW.team_id IN (home_team_id, away_team_id)
)
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup in this week');
END;

CREATE INDEX matchups_league_week ON matchups (league_id, matchup_week_id);

UPDATE application_metadata
SET metadata_value = '16',
    updated_at_ms = CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
