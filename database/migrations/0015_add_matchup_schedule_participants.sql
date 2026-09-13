-- hundo-leago: foreign-key-rebuild
-- Preserve finalized team display context directly on every persisted pairing
-- and bye. Complete schedule membership is the season-participant set.

DROP TRIGGER matchups_team_conflict_insert;
DROP TRIGGER matchups_team_conflict_update;
DROP TRIGGER matchup_byes_team_conflict_insert;
DROP TRIGGER matchup_byes_team_conflict_update;

CREATE TABLE matchups_m6_02 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  home_team_name TEXT NOT NULL CHECK (length(trim(home_team_name)) BETWEEN 1 AND 120),
  away_team_name TEXT NOT NULL CHECK (length(trim(away_team_name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL
    CHECK (status IN ('scheduled', 'active', 'finalized', 'cancelled')),
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

INSERT INTO matchups_m6_02 (
  id, league_id, season_id, matchup_week_id, home_team_id, away_team_id,
  home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version
)
SELECT
  matchups.id, matchups.league_id, matchups.season_id,
  matchups.matchup_week_id, matchups.home_team_id, matchups.away_team_id,
  home_team.name, away_team.name, matchups.status, matchups.created_at_ms,
  matchups.updated_at_ms, matchups.version
FROM matchups
JOIN teams AS home_team
  ON home_team.league_id = matchups.league_id
  AND home_team.id = matchups.home_team_id
JOIN teams AS away_team
  ON away_team.league_id = matchups.league_id
  AND away_team.id = matchups.away_team_id;

DROP TABLE matchups;
ALTER TABLE matchups_m6_02 RENAME TO matchups;

CREATE TABLE matchup_byes_m6_02 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_display_name TEXT NOT NULL CHECK (length(trim(team_display_name)) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, matchup_week_id, team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO matchup_byes_m6_02 (
  id, league_id, season_id, matchup_week_id, team_id, team_display_name,
  created_at_ms
)
SELECT
  matchup_byes.id, matchup_byes.league_id, matchup_byes.season_id,
  matchup_byes.matchup_week_id, matchup_byes.team_id, teams.name,
  matchup_byes.created_at_ms
FROM matchup_byes
JOIN teams
  ON teams.league_id = matchup_byes.league_id
  AND teams.id = matchup_byes.team_id;

DROP TABLE matchup_byes;
ALTER TABLE matchup_byes_m6_02 RENAME TO matchup_byes;

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

CREATE INDEX matchups_league_week
  ON matchups (league_id, matchup_week_id);
CREATE INDEX matchup_byes_league_week
  ON matchup_byes (league_id, matchup_week_id);

UPDATE application_metadata
SET
  metadata_value = '15',
  updated_at_ms = CASE
    WHEN updated_at_ms < 1 THEN 1
    ELSE updated_at_ms
  END
WHERE metadata_key = 'data_model_version';
