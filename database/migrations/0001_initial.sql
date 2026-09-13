-- Hundo Leago Season 2 initial relational schema.
-- All persisted instants are UTC Unix milliseconds.
-- Money uses integer cents. Persisted fantasy points use integer hundredths.

CREATE TABLE application_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

INSERT INTO application_metadata (
  metadata_key,
  metadata_value,
  created_at_ms,
  updated_at_ms
) VALUES
  ('data_model_version', '1', 0, 0),
  ('application_compatibility_version', '1', 0, 0);

-- Accounts and platform security.

CREATE TABLE users (
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
      'active',
      'deactivated',
      'disabled'
    )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE user_credentials (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  algorithm TEXT NOT NULL CHECK (algorithm = 'scrypt'),
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version >= 1),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'replaced', 'revoked')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  replaced_at_ms INTEGER
    CHECK (replaced_at_ms IS NULL OR replaced_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX user_credentials_one_active_per_user
  ON user_credentials (user_id)
  WHERE status = 'active';

CREATE TABLE account_action_tokens (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_digest TEXT NOT NULL UNIQUE
    CHECK (length(token_digest) = 64),
  purpose TEXT NOT NULL
    CHECK (purpose IN (
      'email_verification',
      'administrator_setup',
      'password_reset',
      'self_reactivation'
    )),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'consumed', 'invalidated', 'expired')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  invalidated_at_ms INTEGER
    CHECK (invalidated_at_ms IS NULL OR invalidated_at_ms >= created_at_ms),
  failed_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (failed_attempt_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX account_action_tokens_one_active_purpose_per_user
  ON account_action_tokens (user_id, purpose)
  WHERE status = 'active';

CREATE TABLE sessions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
  csrf_secret_digest TEXT NOT NULL CHECK (length(csrf_secret_digest) = 64),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'revoked', 'expired')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= created_at_ms),
  idle_expires_at_ms INTEGER NOT NULL
    CHECK (idle_expires_at_ms > created_at_ms),
  absolute_expires_at_ms INTEGER NOT NULL
    CHECK (absolute_expires_at_ms >= idle_expires_at_ms),
  revoked_at_ms INTEGER
    CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  revocation_reason TEXT,
  client_metadata_json TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX sessions_one_active_per_user
  ON sessions (user_id)
  WHERE status = 'active';

CREATE TABLE platform_roles (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role = 'platform_administrator'),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  granted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  granted_at_ms INTEGER NOT NULL CHECK (granted_at_ms >= 0),
  ended_at_ms INTEGER
    CHECK (ended_at_ms IS NULL OR ended_at_ms >= granted_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX platform_roles_one_active_role
  ON platform_roles (user_id, role)
  WHERE status = 'active';

CREATE TABLE account_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  outcome TEXT NOT NULL CHECK (length(trim(outcome)) > 0),
  reason_code TEXT,
  metadata_json TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX account_events_user_time
  ON account_events (user_id, occurred_at_ms DESC);

CREATE TABLE security_audit_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  outcome TEXT NOT NULL CHECK (length(trim(outcome)) > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  request_correlation_id TEXT,
  reason_code TEXT,
  network_key_version INTEGER CHECK (network_key_version IS NULL OR network_key_version >= 1),
  network_metadata_digest TEXT,
  client_metadata_json TEXT,
  unknown_account_digest TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX security_audit_events_actor_time
  ON security_audit_events (actor_user_id, occurred_at_ms DESC);
CREATE INDEX security_audit_events_target_time
  ON security_audit_events (target_user_id, occurred_at_ms DESC);

CREATE TABLE authentication_rate_limits (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  bucket_digest TEXT NOT NULL CHECK (length(bucket_digest) = 64),
  window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
  window_ends_at_ms INTEGER NOT NULL
    CHECK (window_ends_at_ms > window_started_at_ms),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  blocked_until_ms INTEGER
    CHECK (blocked_until_ms IS NULL OR blocked_until_ms >= window_started_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= window_started_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (action, key_version, bucket_digest, window_started_at_ms)
) STRICT;

CREATE INDEX authentication_rate_limits_due
  ON authentication_rate_limits (action, window_ends_at_ms);

-- Leagues, seasons, memberships, and teams.

CREATE TABLE leagues (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  name_normalized TEXT NOT NULL UNIQUE
    CHECK (
      name_normalized = lower(trim(name_normalized))
      AND length(name_normalized) BETWEEN 1 AND 120
    ),
  status TEXT NOT NULL
    CHECK (status IN ('setup', 'active', 'frozen', 'completed', 'deleted')),
  timezone TEXT NOT NULL CHECK (length(trim(timezone)) > 0),
  commissioner_membership_id TEXT,
  current_season_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (id, commissioner_membership_id),
  UNIQUE (id, current_season_id)
) STRICT;

CREATE TABLE league_settings (
  league_id TEXT PRIMARY KEY
    REFERENCES leagues(id) ON DELETE RESTRICT,
  salary_cap_cents INTEGER NOT NULL CHECK (salary_cap_cents >= 0),
  trade_deadline_at_ms INTEGER CHECK (trade_deadline_at_ms IS NULL OR trade_deadline_at_ms >= 0),
  maximum_teams INTEGER NOT NULL CHECK (maximum_teams >= 2),
  active_forward_slots INTEGER NOT NULL DEFAULT 12
    CHECK (active_forward_slots = 12),
  active_defence_slots INTEGER NOT NULL DEFAULT 6
    CHECK (active_defence_slots = 6),
  bench_slots INTEGER NOT NULL DEFAULT 4 CHECK (bench_slots = 4),
  maximum_bench_aav_cents INTEGER NOT NULL DEFAULT 400
    CHECK (maximum_bench_aav_cents = 400),
  injured_reserve_slots INTEGER NOT NULL DEFAULT 4
    CHECK (injured_reserve_slots = 4),
  prospect_slots_unlimited INTEGER NOT NULL DEFAULT 1
    CHECK (prospect_slots_unlimited = 1),
  scoring_rule_version INTEGER NOT NULL CHECK (scoring_rule_version >= 1),
  standings_rule_version INTEGER NOT NULL CHECK (standings_rule_version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE seasons (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  nhl_season_key TEXT NOT NULL CHECK (length(trim(nhl_season_key)) > 0),
  status TEXT NOT NULL
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  regular_season_starts_at_ms INTEGER CHECK (regular_season_starts_at_ms IS NULL OR regular_season_starts_at_ms >= 0),
  regular_season_ends_at_ms INTEGER CHECK (
    regular_season_ends_at_ms IS NULL
    OR (
      regular_season_starts_at_ms IS NOT NULL
      AND regular_season_ends_at_ms > regular_season_starts_at_ms
    )
  ),
  fantasy_playoffs_start_at_ms INTEGER CHECK (fantasy_playoffs_start_at_ms IS NULL OR fantasy_playoffs_start_at_ms >= 0),
  fantasy_playoffs_end_at_ms INTEGER CHECK (
    fantasy_playoffs_end_at_ms IS NULL
    OR (
      fantasy_playoffs_start_at_ms IS NOT NULL
      AND fantasy_playoffs_end_at_ms > fantasy_playoffs_start_at_ms
    )
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, label)
) STRICT;

CREATE UNIQUE INDEX seasons_one_active_per_league
  ON seasons (league_id)
  WHERE status = 'active';

CREATE TABLE league_memberships (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  permission_category TEXT NOT NULL
    CHECK (permission_category IN ('commissioner', 'manager', 'member')),
  status TEXT NOT NULL
    CHECK (status IN ('invited', 'active', 'ended', 'suspended')),
  joined_at_ms INTEGER CHECK (joined_at_ms IS NULL OR joined_at_ms >= 0),
  ended_at_ms INTEGER CHECK (
    ended_at_ms IS NULL
    OR (joined_at_ms IS NOT NULL AND ended_at_ms >= joined_at_ms)
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id)
) STRICT;

CREATE UNIQUE INDEX league_memberships_one_active_per_user
  ON league_memberships (league_id, user_id)
  WHERE status = 'active';

CREATE TABLE league_invitations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  invited_email_normalized TEXT NOT NULL
    CHECK (invited_email_normalized = lower(trim(invited_email_normalized))),
  invited_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  inviting_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  accepted_at_ms INTEGER CHECK (accepted_at_ms IS NULL OR accepted_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX league_invitations_one_pending_email
  ON league_invitations (league_id, invited_email_normalized)
  WHERE status = 'pending';

CREATE TABLE teams (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  name_normalized TEXT NOT NULL
    CHECK (
      name_normalized = lower(trim(name_normalized))
      AND length(name_normalized) BETWEEN 1 AND 120
    ),
  status TEXT NOT NULL
    CHECK (status IN ('setup', 'active', 'inactive', 'erased')),
  primary_colour TEXT,
  secondary_colour TEXT,
  logo_reference TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, name_normalized)
) STRICT;

CREATE TABLE team_manager_assignments (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id TEXT NOT NULL,
  assigned_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'declined', 'ended')),
  assigned_at_ms INTEGER NOT NULL CHECK (assigned_at_ms >= 0),
  accepted_at_ms INTEGER CHECK (accepted_at_ms IS NULL OR accepted_at_ms >= assigned_at_ms),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= assigned_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX team_manager_assignments_one_active_manager
  ON team_manager_assignments (league_id, team_id)
  WHERE status = 'accepted' AND ended_at_ms IS NULL;

CREATE TABLE team_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  reason TEXT,
  metadata_json TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Complete the two deferred same-league league pointers.

CREATE TRIGGER leagues_commissioner_membership_same_league_insert
BEFORE INSERT ON leagues
WHEN NEW.commissioner_membership_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM league_memberships
    WHERE id = NEW.commissioner_membership_id
      AND league_id = NEW.id
      AND status = 'active'
      AND permission_category = 'commissioner'
  ) THEN RAISE(ABORT, 'invalid active commissioner membership') END;
END;

CREATE TRIGGER leagues_commissioner_membership_same_league_update
BEFORE UPDATE OF commissioner_membership_id, status ON leagues
WHEN NEW.commissioner_membership_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM league_memberships
    WHERE id = NEW.commissioner_membership_id
      AND league_id = NEW.id
      AND status = 'active'
      AND permission_category = 'commissioner'
  ) THEN RAISE(ABORT, 'invalid active commissioner membership') END;
END;

CREATE TRIGGER leagues_current_season_same_league_insert
BEFORE INSERT ON leagues
WHEN NEW.current_season_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM seasons
    WHERE id = NEW.current_season_id AND league_id = NEW.id
  ) THEN RAISE(ABORT, 'invalid current season') END;
END;

CREATE TRIGGER leagues_current_season_same_league_update
BEFORE UPDATE OF current_season_id ON leagues
WHEN NEW.current_season_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM seasons
    WHERE id = NEW.current_season_id AND league_id = NEW.id
  ) THEN RAISE(ABORT, 'invalid current season') END;
END;

-- Global players and league ownership.

CREATE TABLE players (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  first_name TEXT NOT NULL CHECK (length(trim(first_name)) > 0),
  last_name TEXT NOT NULL CHECK (length(trim(last_name)) > 0),
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  birth_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'historical')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE player_external_ids (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  external_value TEXT NOT NULL CHECK (length(trim(external_value)) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (provider, external_value),
  UNIQUE (player_id, provider)
) STRICT;

CREATE TABLE player_names (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  name_type TEXT NOT NULL CHECK (name_type IN ('alias', 'historical')),
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= created_at_ms),
  UNIQUE (player_id, name_type, full_name)
) STRICT;

CREATE TABLE player_source_state (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  source_position TEXT,
  normalized_position TEXT CHECK (normalized_position IS NULL OR normalized_position IN ('F', 'D')),
  nhl_team_abbreviation TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  source_version TEXT NOT NULL CHECK (length(trim(source_version)) > 0),
  source_payload_json TEXT,
  effective_at_ms INTEGER NOT NULL CHECK (effective_at_ms >= 0),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= effective_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (player_id, provider, effective_at_ms)
) STRICT;

CREATE UNIQUE INDEX player_source_state_one_current_provider
  ON player_source_state (player_id, provider)
  WHERE ended_at_ms IS NULL;

CREATE TABLE league_player_positions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  position_group TEXT NOT NULL CHECK (position_group IN ('F', 'D')),
  reason TEXT,
  corrected_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  effective_at_ms INTEGER NOT NULL CHECK (effective_at_ms >= 0),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= effective_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id)
) STRICT;

CREATE UNIQUE INDEX league_player_positions_one_current
  ON league_player_positions (league_id, player_id)
  WHERE ended_at_ms IS NULL;

CREATE TABLE player_ownerships (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL,
  ownership_kind TEXT NOT NULL
    CHECK (ownership_kind IN ('Rostered', 'Prospect Right')),
  roster_category TEXT NOT NULL
    CHECK (roster_category IN ('Active', 'Bench', 'Injured Reserve', 'Prospect')),
  position_group TEXT NOT NULL CHECK (position_group IN ('F', 'D')),
  slot_number INTEGER,
  acquired_transaction_type TEXT NOT NULL CHECK (length(trim(acquired_transaction_type)) > 0),
  acquired_transaction_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, player_id),
  CHECK (
    (roster_category = 'Active' AND position_group = 'F' AND slot_number BETWEEN 1 AND 12)
    OR (roster_category = 'Active' AND position_group = 'D' AND slot_number BETWEEN 1 AND 6)
    OR (roster_category IN ('Bench', 'Injured Reserve') AND slot_number BETWEEN 1 AND 4)
    OR (roster_category = 'Prospect' AND slot_number IS NULL)
  ),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX player_ownerships_active_slot
  ON player_ownerships (
    league_id,
    season_id,
    team_id,
    position_group,
    slot_number
  )
  WHERE roster_category = 'Active';

CREATE UNIQUE INDEX player_ownerships_bench_ir_slot
  ON player_ownerships (
    league_id,
    season_id,
    team_id,
    roster_category,
    slot_number
  )
  WHERE roster_category IN ('Bench', 'Injured Reserve');

CREATE TABLE ownership_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  team_id TEXT,
  ownership_id TEXT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  source_type TEXT,
  source_id TEXT,
  before_metadata_json TEXT,
  after_metadata_json TEXT,
  reason TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_id)
    REFERENCES player_ownerships(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Contracts and cap obligations.

CREATE TABLE contracts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  current_team_id TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK (contract_type IN ('normal', 'fantasy_elc')),
  original_total_value_cents INTEGER NOT NULL
    CHECK (original_total_value_cents > 0),
  original_term_years INTEGER NOT NULL
    CHECK (original_term_years BETWEEN 1 AND 3),
  aav_cents INTEGER NOT NULL CHECK (aav_cents > 0),
  start_season_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'expired', 'eliminated', 'cancelled')),
  acquisition_source_type TEXT NOT NULL
    CHECK (length(trim(acquisition_source_type)) > 0),
  acquisition_source_id TEXT,
  auction_buyout_lock_expires_at_ms INTEGER
    CHECK (auction_buyout_lock_expires_at_ms IS NULL OR auction_buyout_lock_expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  CHECK (original_total_value_cents = aav_cents * original_term_years),
  FOREIGN KEY (league_id, current_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, start_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX contracts_one_active_per_player
  ON contracts (league_id, player_id)
  WHERE status = 'active';

CREATE TABLE contract_years (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  contract_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  year_number INTEGER NOT NULL CHECK (year_number BETWEEN 1 AND 3),
  aav_cents INTEGER NOT NULL CHECK (aav_cents > 0),
  status TEXT NOT NULL
    CHECK (status IN ('future', 'current', 'completed', 'expired', 'eliminated')),
  rollover_at_ms INTEGER CHECK (rollover_at_ms IS NULL OR rollover_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (contract_id, year_number),
  UNIQUE (contract_id, season_id),
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE contract_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  contract_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  team_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  source_type TEXT,
  source_id TEXT,
  metadata_json TEXT,
  reason TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE retention_obligations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  contract_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  originating_team_id TEXT NOT NULL,
  responsible_team_id TEXT NOT NULL,
  retained_aav_cents INTEGER NOT NULL CHECK (retained_aav_cents > 0),
  creation_trade_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, originating_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, responsible_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE retention_years (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  retention_obligation_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  retained_aav_cents INTEGER NOT NULL CHECK (retained_aav_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('future', 'current', 'completed', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (retention_obligation_id, season_id),
  FOREIGN KEY (league_id, retention_obligation_id)
    REFERENCES retention_obligations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE buyout_obligations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  contract_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  originating_team_id TEXT NOT NULL,
  responsible_team_id TEXT NOT NULL,
  annual_penalty_basis_cents INTEGER NOT NULL
    CHECK (annual_penalty_basis_cents > 0),
  buyout_transaction_id TEXT NOT NULL CHECK (length(trim(buyout_transaction_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, contract_id),
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, originating_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, responsible_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE buyout_years (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  buyout_obligation_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  penalty_cents INTEGER NOT NULL CHECK (penalty_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('future', 'current', 'completed', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (buyout_obligation_id, season_id),
  FOREIGN KEY (league_id, buyout_obligation_id)
    REFERENCES buyout_obligations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Auctions.

CREATE TABLE auctions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('open', 'resolving', 'resolved', 'cancelled', 'failed')),
  opened_at_ms INTEGER NOT NULL CHECK (opened_at_ms >= 0),
  resolves_at_ms INTEGER NOT NULL CHECK (resolves_at_ms > opened_at_ms),
  opened_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX auctions_one_active_per_player
  ON auctions (league_id, player_id)
  WHERE status IN ('open', 'resolving');

CREATE TABLE auction_bids (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  submitted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  total_value_cents INTEGER NOT NULL CHECK (total_value_cents > 0),
  term_years INTEGER NOT NULL CHECK (term_years BETWEEN 1 AND 3),
  first_submitted_at_ms INTEGER NOT NULL CHECK (first_submitted_at_ms >= 0),
  last_edited_at_ms INTEGER NOT NULL CHECK (last_edited_at_ms >= first_submitted_at_ms),
  edit_count INTEGER NOT NULL DEFAULT 0 CHECK (edit_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'withdrawn', 'won', 'lost', 'invalid')),
  idempotency_request_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX auction_bids_one_current_team_bid
  ON auction_bids (league_id, auction_id, team_id)
  WHERE status = 'active';

CREATE TABLE auction_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  bid_id TEXT,
  team_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  metadata_json TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE auction_resolutions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  scheduled_occurrence_key TEXT NOT NULL,
  winning_team_id TEXT,
  winning_bid_id TEXT,
  highest_bid_cents INTEGER CHECK (highest_bid_cents IS NULL OR highest_bid_cents > 0),
  second_price_input_cents INTEGER CHECK (second_price_input_cents IS NULL OR second_price_input_cents >= 0),
  final_contract_value_cents INTEGER CHECK (final_contract_value_cents IS NULL OR final_contract_value_cents > 0),
  contract_id TEXT,
  ownership_id TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('automatic', 'commissioner')),
  triggered_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  status TEXT NOT NULL CHECK (status IN ('resolved', 'no_bids', 'failed', 'recovered')),
  resolved_at_ms INTEGER NOT NULL CHECK (resolved_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, auction_id),
  UNIQUE (league_id, scheduled_occurrence_key),
  UNIQUE (league_id, idempotency_key),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_id)
    REFERENCES player_ownerships(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Trades and typed assets.

CREATE TABLE trades (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  proposing_team_id TEXT NOT NULL,
  receiving_team_id TEXT NOT NULL,
  proposing_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('proposed', 'accepted', 'declined', 'cancelled', 'expired', 'completed', 'reversed')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  responded_at_ms INTEGER CHECK (responded_at_ms IS NULL OR responded_at_ms >= created_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  commissioner_completion_reference TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  CHECK (proposing_team_id <> receiving_team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, proposing_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, receiving_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE future_considerations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  originating_trade_id TEXT NOT NULL,
  owing_team_id TEXT NOT NULL,
  receiving_team_id TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  status TEXT NOT NULL CHECK (status IN ('outstanding', 'fulfilled', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  CHECK (owing_team_id <> receiving_team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, originating_trade_id)
    REFERENCES trades(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, owing_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, receiving_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE trade_assets (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  trade_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('proposing_to_receiving', 'receiving_to_proposing')),
  source_team_id TEXT NOT NULL,
  destination_team_id TEXT NOT NULL,
  asset_type TEXT NOT NULL
    CHECK (asset_type IN (
      'contract',
      'prospect_right',
      'draft_pick',
      'retention_obligation',
      'buyout_obligation',
      'future_consideration',
      'requested_retention'
    )),
  contract_id TEXT,
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  draft_pick_id TEXT,
  retention_obligation_id TEXT,
  buyout_obligation_id TEXT,
  future_consideration_id TEXT,
  requested_retention_cents INTEGER
    CHECK (requested_retention_cents IS NULL OR requested_retention_cents > 0),
  proposal_snapshot_json TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (trade_id, sequence),
  CHECK (source_team_id <> destination_team_id),
  CHECK (
    (asset_type = 'contract'
      AND contract_id IS NOT NULL
      AND player_id IS NULL
      AND draft_pick_id IS NULL
      AND retention_obligation_id IS NULL
      AND buyout_obligation_id IS NULL
      AND future_consideration_id IS NULL
      AND requested_retention_cents IS NULL)
    OR (asset_type = 'prospect_right'
      AND contract_id IS NULL
      AND player_id IS NOT NULL
      AND draft_pick_id IS NULL
      AND retention_obligation_id IS NULL
      AND buyout_obligation_id IS NULL
      AND future_consideration_id IS NULL
      AND requested_retention_cents IS NULL)
    OR (asset_type = 'draft_pick'
      AND contract_id IS NULL
      AND player_id IS NULL
      AND draft_pick_id IS NOT NULL
      AND retention_obligation_id IS NULL
      AND buyout_obligation_id IS NULL
      AND future_consideration_id IS NULL
      AND requested_retention_cents IS NULL)
    OR (asset_type = 'retention_obligation'
      AND contract_id IS NULL
      AND player_id IS NULL
      AND draft_pick_id IS NULL
      AND retention_obligation_id IS NOT NULL
      AND buyout_obligation_id IS NULL
      AND future_consideration_id IS NULL
      AND requested_retention_cents IS NULL)
    OR (asset_type = 'buyout_obligation'
      AND contract_id IS NULL
      AND player_id IS NULL
      AND draft_pick_id IS NULL
      AND retention_obligation_id IS NULL
      AND buyout_obligation_id IS NOT NULL
      AND future_consideration_id IS NULL
      AND requested_retention_cents IS NULL)
    OR (asset_type = 'future_consideration'
      AND contract_id IS NULL
      AND player_id IS NULL
      AND draft_pick_id IS NULL
      AND retention_obligation_id IS NULL
      AND buyout_obligation_id IS NULL
      AND future_consideration_id IS NOT NULL
      AND requested_retention_cents IS NULL)
    OR (asset_type = 'requested_retention'
      AND contract_id IS NULL
      AND player_id IS NULL
      AND draft_pick_id IS NULL
      AND retention_obligation_id IS NULL
      AND buyout_obligation_id IS NULL
      AND future_consideration_id IS NULL
      AND requested_retention_cents IS NOT NULL)
  ),
  FOREIGN KEY (league_id, trade_id)
    REFERENCES trades(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, destination_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, draft_pick_id)
    REFERENCES draft_picks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, retention_obligation_id)
    REFERENCES retention_obligations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, buyout_obligation_id)
    REFERENCES buyout_obligations(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, future_consideration_id)
    REFERENCES future_considerations(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE trade_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  reason TEXT,
  metadata_json TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, trade_id)
    REFERENCES trades(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Entry Draft.

CREATE TABLE entry_drafts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('setup', 'lottery_ready', 'ready', 'active', 'completed', 'cancelled')),
  rounds INTEGER NOT NULL DEFAULT 4 CHECK (rounds = 4),
  pick_clock_seconds INTEGER NOT NULL DEFAULT 300 CHECK (pick_clock_seconds = 300),
  starts_at_ms INTEGER CHECK (starts_at_ms IS NULL OR starts_at_ms >= 0),
  completed_at_ms INTEGER CHECK (
    completed_at_ms IS NULL
    OR (starts_at_ms IS NOT NULL AND completed_at_ms >= starts_at_ms)
  ),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_lottery_runs (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  standings_snapshot_id TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version >= 1),
  participant_count INTEGER NOT NULL CHECK (participant_count >= 2),
  confirmed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  random_audit_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'committed'),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, draft_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_lottery_results (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  lottery_run_id TEXT NOT NULL,
  original_team_id TEXT NOT NULL,
  current_pick_owner_team_id TEXT NOT NULL,
  reverse_standings_position INTEGER NOT NULL CHECK (reverse_standings_position >= 1),
  weight INTEGER NOT NULL CHECK (weight >= 0),
  draw_order INTEGER CHECK (draw_order IS NULL OR draw_order BETWEEN 1 AND 2),
  final_draft_position INTEGER NOT NULL CHECK (final_draft_position >= 1),
  finalist_role TEXT CHECK (finalist_role IS NULL OR finalist_role IN ('champion', 'runner_up')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (lottery_run_id, original_team_id),
  UNIQUE (lottery_run_id, final_draft_position),
  FOREIGN KEY (league_id, lottery_run_id)
    REFERENCES draft_lottery_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, original_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, current_pick_owner_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_eligibility_snapshots (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  nhl_entry_draft_key TEXT NOT NULL CHECK (length(trim(nhl_entry_draft_key)) > 0),
  source_version TEXT NOT NULL CHECK (length(trim(source_version)) > 0),
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'superseded')),
  confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at_ms INTEGER CHECK (confirmed_at_ms IS NULL OR confirmed_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (draft_id, snapshot_version),
  FOREIGN KEY (league_id, draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX draft_eligibility_snapshots_one_confirmed
  ON draft_eligibility_snapshots (league_id, draft_id)
  WHERE status = 'confirmed';

CREATE TABLE draft_eligible_players (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  eligibility_snapshot_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  position_group TEXT NOT NULL CHECK (position_group IN ('F', 'D')),
  eligibility_reason TEXT NOT NULL
    CHECK (eligibility_reason IN ('nhl_entry_draft', 'rights_release_reentry')),
  nhl_draft_year INTEGER CHECK (nhl_draft_year IS NULL OR nhl_draft_year >= 1900),
  nhl_round INTEGER CHECK (nhl_round IS NULL OR nhl_round >= 1),
  nhl_overall_selection INTEGER CHECK (nhl_overall_selection IS NULL OR nhl_overall_selection >= 1),
  rights_release_event_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (eligibility_snapshot_id, player_id),
  FOREIGN KEY (league_id, eligibility_snapshot_id)
    REFERENCES draft_eligibility_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rights_release_event_id)
    REFERENCES ownership_events(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_picks (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  target_season_id TEXT NOT NULL,
  round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 4),
  position_number INTEGER NOT NULL CHECK (position_number >= 1),
  original_team_id TEXT NOT NULL,
  current_owner_team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unused', 'used', 'forfeited')),
  selection_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (draft_id, round_number, position_number),
  FOREIGN KEY (league_id, draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, target_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, original_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, current_owner_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_pick_ownership_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  draft_pick_id TEXT NOT NULL,
  from_team_id TEXT,
  to_team_id TEXT NOT NULL,
  trade_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, draft_pick_id)
    REFERENCES draft_picks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, from_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, trade_id)
    REFERENCES trades(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_selections (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  draft_pick_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  selecting_team_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'commissioner', 'automatic_timeout')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  selected_at_ms INTEGER NOT NULL CHECK (selected_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (draft_id, draft_pick_id),
  UNIQUE (draft_id, player_id),
  FOREIGN KEY (league_id, draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, draft_pick_id)
    REFERENCES draft_picks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, selecting_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_queue_items (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  queue_position INTEGER NOT NULL CHECK (queue_position >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (draft_id, user_id, team_id, player_id),
  UNIQUE (draft_id, user_id, team_id, queue_position),
  FOREIGN KEY (league_id, draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE draft_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  metadata_json TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, draft_id)
    REFERENCES entry_drafts(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Player statistics and immutable scoring snapshots.

CREATE TABLE stat_sources (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  provider TEXT NOT NULL UNIQUE CHECK (length(trim(provider)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE stat_refreshes (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  stat_source_id TEXT NOT NULL REFERENCES stat_sources(id) ON DELETE RESTRICT,
  nhl_season_key TEXT NOT NULL CHECK (length(trim(nhl_season_key)) > 0),
  source_version TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('started', 'succeeded', 'failed', 'rejected')),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  player_count INTEGER CHECK (player_count IS NULL OR player_count >= 0),
  error_code TEXT,
  metadata_json TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE INDEX stat_refreshes_source_time
  ON stat_refreshes (stat_source_id, started_at_ms DESC);

CREATE TABLE player_stat_totals (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  stat_source_id TEXT NOT NULL REFERENCES stat_sources(id) ON DELETE RESTRICT,
  refresh_id TEXT NOT NULL REFERENCES stat_refreshes(id) ON DELETE RESTRICT,
  nhl_season_key TEXT NOT NULL CHECK (length(trim(nhl_season_key)) > 0),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  games_played INTEGER NOT NULL CHECK (games_played >= 0),
  goals INTEGER NOT NULL CHECK (goals >= 0),
  assists INTEGER NOT NULL CHECK (assists >= 0),
  nhl_points INTEGER NOT NULL CHECK (nhl_points >= 0 AND nhl_points = goals + assists),
  fantasy_points_hundredths INTEGER NOT NULL CHECK (fantasy_points_hundredths >= 0),
  source_updated_at_ms INTEGER NOT NULL CHECK (source_updated_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (stat_source_id, nhl_season_key, player_id, refresh_id)
) STRICT;

CREATE INDEX player_stat_totals_player_season
  ON player_stat_totals (player_id, nhl_season_key, source_updated_at_ms DESC);

CREATE TABLE stat_snapshots (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  stat_source_id TEXT NOT NULL REFERENCES stat_sources(id) ON DELETE RESTRICT,
  source_refresh_id TEXT NOT NULL REFERENCES stat_refreshes(id) ON DELETE RESTRICT,
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT,
  matchup_week_id TEXT,
  intended_use TEXT NOT NULL
    CHECK (intended_use IN ('matchup_baseline', 'matchup_final', 'diagnostic', 'migration')),
  completeness_status TEXT NOT NULL
    CHECK (completeness_status IN ('complete', 'partial', 'invalid')),
  freshness_status TEXT NOT NULL
    CHECK (freshness_status IN ('fresh', 'stale', 'unknown')),
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (league_id IS NULL AND season_id IS NULL AND matchup_week_id IS NULL)
    OR league_id IS NOT NULL
  )
) STRICT;

CREATE TABLE stat_snapshot_players (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT,
  stat_snapshot_id TEXT NOT NULL REFERENCES stat_snapshots(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  games_played INTEGER NOT NULL CHECK (games_played >= 0),
  goals INTEGER NOT NULL CHECK (goals >= 0),
  assists INTEGER NOT NULL CHECK (assists >= 0),
  nhl_points INTEGER NOT NULL CHECK (nhl_points >= 0 AND nhl_points = goals + assists),
  fantasy_points_hundredths INTEGER NOT NULL CHECK (fantasy_points_hundredths >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (stat_snapshot_id, player_id),
  FOREIGN KEY (league_id, stat_snapshot_id)
    REFERENCES stat_snapshots(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Matchup weeks, immutable locks, versioned results, and standings.

CREATE TABLE matchup_weeks (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  week_key TEXT NOT NULL CHECK (length(trim(week_key)) > 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0),
  baseline_at_ms INTEGER NOT NULL CHECK (baseline_at_ms >= starts_at_ms),
  locks_at_ms INTEGER NOT NULL CHECK (locks_at_ms >= baseline_at_ms),
  ends_at_ms INTEGER NOT NULL CHECK (ends_at_ms > locks_at_ms),
  rolls_over_at_ms INTEGER NOT NULL CHECK (rolls_over_at_ms >= ends_at_ms),
  status TEXT NOT NULL
    CHECK (status IN ('scheduled', 'open', 'locked', 'finalizing', 'finalized', 'rolled_over', 'failed')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, week_key),
  UNIQUE (league_id, season_id, sequence),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE matchups (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
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

CREATE TABLE matchup_byes (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
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

CREATE TABLE matchup_roster_locks (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  lock_type TEXT NOT NULL CHECK (lock_type IN ('normal', 'late')),
  legal INTEGER NOT NULL CHECK (legal IN (0, 1)),
  locked_at_ms INTEGER NOT NULL CHECK (locked_at_ms >= 0),
  baseline_snapshot_id TEXT NOT NULL,
  source_freshness_status TEXT NOT NULL
    CHECK (source_freshness_status IN ('fresh', 'stale', 'unknown')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, matchup_week_id, team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, baseline_snapshot_id)
    REFERENCES stat_snapshots(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE matchup_roster_players (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_roster_lock_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  position_group TEXT NOT NULL CHECK (position_group IN ('F', 'D')),
  slot_number INTEGER NOT NULL CHECK (slot_number >= 1),
  baseline_games_played INTEGER NOT NULL CHECK (baseline_games_played >= 0),
  baseline_goals INTEGER NOT NULL CHECK (baseline_goals >= 0),
  baseline_assists INTEGER NOT NULL CHECK (baseline_assists >= 0),
  baseline_fantasy_points_hundredths INTEGER NOT NULL CHECK (baseline_fantasy_points_hundredths >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (matchup_roster_lock_id, player_id),
  UNIQUE (matchup_roster_lock_id, position_group, slot_number),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_roster_lock_id)
    REFERENCES matchup_roster_locks(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE matchup_results (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_id TEXT NOT NULL,
  current_version_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'official', 'corrected', 'void')),
  finalized_at_ms INTEGER CHECK (finalized_at_ms IS NULL OR finalized_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, matchup_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_id)
    REFERENCES matchups(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE matchup_result_versions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_result_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  home_score_hundredths INTEGER NOT NULL CHECK (home_score_hundredths >= 0),
  away_score_hundredths INTEGER NOT NULL CHECK (away_score_hundredths >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('home_win', 'away_win', 'tie')),
  source_snapshot_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('calculated', 'correction')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT,
  supersedes_version_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (matchup_result_id, version_number),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_result_id)
    REFERENCES matchup_results(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, home_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, away_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_snapshot_id)
    REFERENCES stat_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, supersedes_version_id)
    REFERENCES matchup_result_versions(league_id, id) ON DELETE RESTRICT,
  CHECK (home_team_id <> away_team_id)
) STRICT;

CREATE TABLE matchup_operations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  matchup_week_id TEXT,
  matchup_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  operation_type TEXT NOT NULL CHECK (length(trim(operation_type)) > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'skipped')),
  reason TEXT,
  metadata_json TEXT,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_week_id)
    REFERENCES matchup_weeks(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, matchup_id)
    REFERENCES matchups(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE standings_snapshots (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version >= 1),
  source_result_version INTEGER NOT NULL CHECK (source_result_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('current', 'superseded', 'final')),
  calculated_at_ms INTEGER NOT NULL CHECK (calculated_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, snapshot_version),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX standings_snapshots_one_current
  ON standings_snapshots (league_id, season_id)
  WHERE status = 'current';

CREATE TABLE standings_rows (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  standings_snapshot_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  wins INTEGER NOT NULL CHECK (wins >= 0),
  losses INTEGER NOT NULL CHECK (losses >= 0),
  ties INTEGER NOT NULL CHECK (ties >= 0),
  standings_points INTEGER NOT NULL CHECK (standings_points >= 0),
  fantasy_points_for_hundredths INTEGER NOT NULL CHECK (fantasy_points_for_hundredths >= 0),
  fantasy_points_against_hundredths INTEGER NOT NULL CHECK (fantasy_points_against_hundredths >= 0),
  fantasy_point_differential_hundredths INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (standings_snapshot_id, team_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  CHECK (standings_points = wins * 2 + ties),
  CHECK (
    fantasy_point_differential_hundredths =
      fantasy_points_for_hundredths - fantasy_points_against_hundredths
  )
) STRICT;

CREATE TABLE standings_operations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  standings_snapshot_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('calculate', 'rebuild', 'correction_propagation')),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  reason TEXT,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, standings_snapshot_id)
    REFERENCES standings_snapshots(league_id, id) ON DELETE RESTRICT
) STRICT;

-- League history, notifications, commissioner operations, and recovery.

CREATE TABLE league_activity (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_authority TEXT NOT NULL CHECK (length(trim(actor_authority)) > 0),
  team_id TEXT,
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  related_type TEXT,
  related_id TEXT,
  display_summary TEXT NOT NULL CHECK (length(trim(display_summary)) > 0),
  reason TEXT,
  metadata_json TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  message_data_json TEXT NOT NULL,
  related_feature TEXT,
  related_record_id TEXT,
  delivery_status TEXT NOT NULL
    CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'suppressed')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  read_at_ms INTEGER CHECK (read_at_ms IS NULL OR read_at_ms >= created_at_ms),
  delivered_at_ms INTEGER CHECK (delivered_at_ms IS NULL OR delivered_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id)
) STRICT;

CREATE INDEX notifications_user_unread
  ON notifications (user_id, read_at_ms, created_at_ms DESC);

CREATE TABLE commissioner_corrections (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT,
  feature TEXT NOT NULL CHECK (length(trim(feature)) > 0),
  feature_record_id TEXT NOT NULL CHECK (length(trim(feature_record_id)) > 0),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  before_snapshot_json TEXT,
  after_snapshot_json TEXT,
  corrected_at_ms INTEGER NOT NULL CHECK (corrected_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE administrator_requests (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  request_type TEXT NOT NULL CHECK (length(trim(request_type)) > 0),
  requesting_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewing_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  affected_records_json TEXT NOT NULL,
  preview_reference TEXT NOT NULL CHECK (length(trim(preview_reference)) > 0),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'declined', 'completed', 'failed', 'cancelled')),
  reason TEXT,
  requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
  reviewed_at_ms INTEGER CHECK (reviewed_at_ms IS NULL OR reviewed_at_ms >= requested_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= requested_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= requested_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id)
) STRICT;

CREATE TABLE league_freezes (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  frozen_at_ms INTEGER NOT NULL CHECK (frozen_at_ms >= 0),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= frozen_at_ms),
  ended_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id)
) STRICT;

CREATE UNIQUE INDEX league_freezes_one_active
  ON league_freezes (league_id)
  WHERE status = 'active';

CREATE TABLE operational_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  feature TEXT NOT NULL CHECK (length(trim(feature)) > 0),
  outcome TEXT NOT NULL CHECK (length(trim(outcome)) > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  reason_code TEXT,
  details_json TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

-- Reliability, idempotency, durable jobs, outbox, and recovery catalogs.

CREATE TABLE idempotency_requests (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  client_key TEXT NOT NULL CHECK (length(trim(client_key)) > 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  result_type TEXT,
  result_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  UNIQUE (league_id, actor_user_id, operation, client_key),
  UNIQUE (league_id, id)
) STRICT;

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT,
  job_type TEXT NOT NULL CHECK (length(trim(job_type)) > 0),
  occurrence_key TEXT NOT NULL CHECK (length(trim(occurrence_key)) > 0),
  scheduled_for_ms INTEGER NOT NULL CHECK (scheduled_for_ms >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'leased', 'running', 'succeeded', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  completed_at_ms INTEGER CHECK (
    completed_at_ms IS NULL
    OR (started_at_ms IS NOT NULL AND completed_at_ms >= started_at_ms)
  ),
  result_json TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, job_type, occurrence_key),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  aggregate_type TEXT NOT NULL CHECK (length(trim(aggregate_type)) > 0),
  aggregate_id TEXT NOT NULL CHECK (length(trim(aggregate_id)) > 0),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'discarded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
  published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= available_at_ms),
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id)
) STRICT;

CREATE TABLE backup_catalog (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  environment_identity TEXT NOT NULL CHECK (length(trim(environment_identity)) > 0),
  backup_kind TEXT NOT NULL CHECK (backup_kind IN ('manual', 'scheduled', 'pre_migration', 'pre_cutover')),
  storage_reference TEXT NOT NULL UNIQUE CHECK (length(trim(storage_reference)) > 0),
  database_checksum TEXT NOT NULL CHECK (length(database_checksum) = 64),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  source_database_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'verified', 'invalid', 'expired')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  verified_at_ms INTEGER CHECK (verified_at_ms IS NULL OR verified_at_ms >= created_at_ms),
  metadata_json TEXT,
  UNIQUE (league_id, id)
) STRICT;

CREATE TABLE migration_reports (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT REFERENCES leagues(id) ON DELETE RESTRICT,
  source_bundle_id TEXT NOT NULL CHECK (length(trim(source_bundle_id)) > 0),
  reset_manifest_id TEXT,
  database_schema_version INTEGER NOT NULL CHECK (database_schema_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'rejected')),
  source_hashes_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  totals_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  rejects_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (source_bundle_id, database_schema_version)
) STRICT;

-- Deferred cross-family pointers. These triggers keep circular relationships
-- insertable while still enforcing same-league ownership once a pointer is set.

CREATE TRIGGER retention_obligations_creation_trade_insert
BEFORE INSERT ON retention_obligations
WHEN NEW.creation_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM trades
    WHERE trades.id = NEW.creation_trade_id
      AND trades.league_id = NEW.league_id
  )
BEGIN
  SELECT RAISE(ABORT, 'retention obligation creation trade must belong to the same league');
END;

CREATE TRIGGER retention_obligations_creation_trade_update
BEFORE UPDATE OF league_id, creation_trade_id ON retention_obligations
WHEN NEW.creation_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM trades
    WHERE trades.id = NEW.creation_trade_id
      AND trades.league_id = NEW.league_id
  )
BEGIN
  SELECT RAISE(ABORT, 'retention obligation creation trade must belong to the same league');
END;

CREATE TRIGGER draft_picks_selection_insert
BEFORE INSERT ON draft_picks
WHEN NEW.selection_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM draft_selections
    WHERE draft_selections.id = NEW.selection_id
      AND draft_selections.league_id = NEW.league_id
      AND draft_selections.draft_id = NEW.draft_id
      AND draft_selections.draft_pick_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'draft pick selection must reference this pick in the same league');
END;

CREATE TRIGGER draft_picks_selection_update
BEFORE UPDATE OF league_id, draft_id, selection_id ON draft_picks
WHEN NEW.selection_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM draft_selections
    WHERE draft_selections.id = NEW.selection_id
      AND draft_selections.league_id = NEW.league_id
      AND draft_selections.draft_id = NEW.draft_id
      AND draft_selections.draft_pick_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'draft pick selection must reference this pick in the same league');
END;

CREATE TRIGGER matchup_results_current_version_insert
BEFORE INSERT ON matchup_results
WHEN NEW.current_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM matchup_result_versions
    WHERE matchup_result_versions.id = NEW.current_version_id
      AND matchup_result_versions.league_id = NEW.league_id
      AND matchup_result_versions.matchup_result_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'current matchup result version must belong to this result and league');
END;

CREATE TRIGGER matchup_results_current_version_update
BEFORE UPDATE OF league_id, current_version_id ON matchup_results
WHEN NEW.current_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM matchup_result_versions
    WHERE matchup_result_versions.id = NEW.current_version_id
      AND matchup_result_versions.league_id = NEW.league_id
      AND matchup_result_versions.matchup_result_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'current matchup result version must belong to this result and league');
END;

-- A team may appear only once in a matchup week, whether matched or on a bye.

CREATE TRIGGER matchups_team_conflict_insert
BEFORE INSERT ON matchups
WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.matchup_week_id = NEW.matchup_week_id
      AND (
        matchups.home_team_id IN (NEW.home_team_id, NEW.away_team_id)
        OR matchups.away_team_id IN (NEW.home_team_id, NEW.away_team_id)
      )
  )
  OR EXISTS (
    SELECT 1
    FROM matchup_byes
    WHERE matchup_byes.league_id = NEW.league_id
      AND matchup_byes.matchup_week_id = NEW.matchup_week_id
      AND matchup_byes.team_id IN (NEW.home_team_id, NEW.away_team_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup or bye in this week');
END;

CREATE TRIGGER matchups_team_conflict_update
BEFORE UPDATE OF league_id, matchup_week_id, home_team_id, away_team_id ON matchups
WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.id <> OLD.id
      AND matchups.league_id = NEW.league_id
      AND matchups.matchup_week_id = NEW.matchup_week_id
      AND (
        matchups.home_team_id IN (NEW.home_team_id, NEW.away_team_id)
        OR matchups.away_team_id IN (NEW.home_team_id, NEW.away_team_id)
      )
  )
  OR EXISTS (
    SELECT 1
    FROM matchup_byes
    WHERE matchup_byes.league_id = NEW.league_id
      AND matchup_byes.matchup_week_id = NEW.matchup_week_id
      AND matchup_byes.team_id IN (NEW.home_team_id, NEW.away_team_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup or bye in this week');
END;

CREATE TRIGGER matchup_byes_team_conflict_insert
BEFORE INSERT ON matchup_byes
WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.matchup_week_id = NEW.matchup_week_id
      AND NEW.team_id IN (matchups.home_team_id, matchups.away_team_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup in this week');
END;

CREATE TRIGGER matchup_byes_team_conflict_update
BEFORE UPDATE OF league_id, matchup_week_id, team_id ON matchup_byes
WHEN EXISTS (
    SELECT 1
    FROM matchups
    WHERE matchups.league_id = NEW.league_id
      AND matchups.matchup_week_id = NEW.matchup_week_id
      AND NEW.team_id IN (matchups.home_team_id, matchups.away_team_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'team already has a matchup in this week');
END;

-- Every league-scoped table has an index whose first key is league_id. This is
-- deliberately explicit so tenant filtering never depends on an incidental
-- constraint-generated index.

CREATE INDEX security_audit_events_league_time
  ON security_audit_events (league_id, occurred_at_ms DESC);
CREATE INDEX league_settings_league
  ON league_settings (league_id);
CREATE INDEX seasons_league_status
  ON seasons (league_id, status);
CREATE INDEX league_memberships_league_status
  ON league_memberships (league_id, status);
CREATE INDEX league_invitations_league_status
  ON league_invitations (league_id, status);
CREATE INDEX teams_league_status
  ON teams (league_id, status);
CREATE INDEX team_manager_assignments_league_team
  ON team_manager_assignments (league_id, team_id);
CREATE INDEX team_events_league_time
  ON team_events (league_id, occurred_at_ms DESC);
CREATE INDEX league_player_positions_league_player
  ON league_player_positions (league_id, player_id);
CREATE INDEX player_ownerships_league_season
  ON player_ownerships (league_id, season_id);
CREATE INDEX ownership_events_league_time
  ON ownership_events (league_id, occurred_at_ms DESC);
CREATE INDEX contracts_league_status
  ON contracts (league_id, status);
CREATE INDEX contract_years_league_season
  ON contract_years (league_id, season_id);
CREATE INDEX contract_events_league_time
  ON contract_events (league_id, occurred_at_ms DESC);
CREATE INDEX retention_obligations_league_status
  ON retention_obligations (league_id, status);
CREATE INDEX retention_years_league_season
  ON retention_years (league_id, season_id);
CREATE INDEX buyout_obligations_league_status
  ON buyout_obligations (league_id, status);
CREATE INDEX buyout_years_league_season
  ON buyout_years (league_id, season_id);
CREATE INDEX auctions_league_status
  ON auctions (league_id, status);
CREATE INDEX auction_bids_league_auction
  ON auction_bids (league_id, auction_id);
CREATE INDEX auction_events_league_time
  ON auction_events (league_id, occurred_at_ms DESC);
CREATE INDEX auction_resolutions_league_time
  ON auction_resolutions (league_id, resolved_at_ms DESC);
CREATE INDEX trades_league_status
  ON trades (league_id, status);
CREATE INDEX future_considerations_league_status
  ON future_considerations (league_id, status);
CREATE INDEX trade_assets_league_trade
  ON trade_assets (league_id, trade_id);
CREATE INDEX trade_events_league_time
  ON trade_events (league_id, occurred_at_ms DESC);
CREATE INDEX entry_drafts_league_season
  ON entry_drafts (league_id, season_id);
CREATE INDEX draft_lottery_runs_league_draft
  ON draft_lottery_runs (league_id, draft_id);
CREATE INDEX draft_lottery_results_league_run
  ON draft_lottery_results (league_id, lottery_run_id);
CREATE INDEX draft_eligibility_snapshots_league_draft
  ON draft_eligibility_snapshots (league_id, draft_id);
CREATE INDEX draft_eligible_players_league_snapshot
  ON draft_eligible_players (league_id, eligibility_snapshot_id);
CREATE INDEX draft_picks_league_draft
  ON draft_picks (league_id, draft_id);
CREATE INDEX draft_pick_ownership_events_league_time
  ON draft_pick_ownership_events (league_id, occurred_at_ms DESC);
CREATE INDEX draft_selections_league_draft
  ON draft_selections (league_id, draft_id);
CREATE INDEX draft_queue_items_league_draft
  ON draft_queue_items (league_id, draft_id);
CREATE INDEX draft_events_league_time
  ON draft_events (league_id, occurred_at_ms DESC);
CREATE INDEX stat_snapshots_league_season
  ON stat_snapshots (league_id, season_id);
CREATE INDEX stat_snapshot_players_league_snapshot
  ON stat_snapshot_players (league_id, stat_snapshot_id);
CREATE INDEX matchup_weeks_league_season
  ON matchup_weeks (league_id, season_id);
CREATE INDEX matchups_league_week
  ON matchups (league_id, matchup_week_id);
CREATE INDEX matchup_byes_league_week
  ON matchup_byes (league_id, matchup_week_id);
CREATE INDEX matchup_roster_locks_league_week
  ON matchup_roster_locks (league_id, matchup_week_id);
CREATE INDEX matchup_roster_players_league_lock
  ON matchup_roster_players (league_id, matchup_roster_lock_id);
CREATE INDEX matchup_results_league_matchup
  ON matchup_results (league_id, matchup_id);
CREATE INDEX matchup_result_versions_league_result
  ON matchup_result_versions (league_id, matchup_result_id);
CREATE INDEX matchup_operations_league_time
  ON matchup_operations (league_id, started_at_ms DESC);
CREATE INDEX standings_snapshots_league_season
  ON standings_snapshots (league_id, season_id);
CREATE INDEX standings_rows_league_snapshot
  ON standings_rows (league_id, standings_snapshot_id);
CREATE INDEX standings_operations_league_time
  ON standings_operations (league_id, started_at_ms DESC);
CREATE INDEX league_activity_league_time
  ON league_activity (league_id, occurred_at_ms DESC);
CREATE INDEX notifications_league_time
  ON notifications (league_id, created_at_ms DESC);
CREATE INDEX commissioner_corrections_league_time
  ON commissioner_corrections (league_id, corrected_at_ms DESC);
CREATE INDEX administrator_requests_league_status
  ON administrator_requests (league_id, status);
CREATE INDEX league_freezes_league_time
  ON league_freezes (league_id, frozen_at_ms DESC);
CREATE INDEX operational_events_league_time
  ON operational_events (league_id, occurred_at_ms DESC);
CREATE INDEX idempotency_requests_league_created
  ON idempotency_requests (league_id, created_at_ms DESC);
CREATE INDEX job_runs_league_schedule
  ON job_runs (league_id, scheduled_for_ms);
CREATE INDEX outbox_events_league_available
  ON outbox_events (league_id, status, available_at_ms);
CREATE INDEX backup_catalog_league_created
  ON backup_catalog (league_id, created_at_ms DESC);
CREATE INDEX migration_reports_league_created
  ON migration_reports (league_id, created_at_ms DESC);

CREATE UNIQUE INDEX idempotency_requests_global_key
  ON idempotency_requests (actor_user_id, operation, client_key)
  WHERE league_id IS NULL;
CREATE UNIQUE INDEX job_runs_global_occurrence
  ON job_runs (job_type, occurrence_key)
  WHERE league_id IS NULL;
