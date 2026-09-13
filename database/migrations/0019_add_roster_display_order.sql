CREATE TABLE roster_display_order_sets (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, season_id, team_id),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE roster_display_order_entries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  order_set_id TEXT NOT NULL,
  ownership_id TEXT NOT NULL,
  position_group TEXT NOT NULL CHECK (position_group IN ('F', 'D')),
  display_order INTEGER NOT NULL CHECK (display_order >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (order_set_id, ownership_id),
  UNIQUE (order_set_id, position_group, display_order),
  FOREIGN KEY (league_id, order_set_id)
    REFERENCES roster_display_order_sets(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_id)
    REFERENCES player_ownerships(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX roster_display_order_entries_ownership
  ON roster_display_order_entries (league_id, ownership_id);

UPDATE application_metadata
SET metadata_value = '19',
    updated_at_ms = CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
