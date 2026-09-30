-- Preserve every existing league record. Deadline holds are explicit state.
CREATE TABLE fad_deadline_controls (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('held', 'proceed')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_user_id TEXT REFERENCES users(id),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (league_id, season_id, id) REFERENCES free_agent_drafts(league_id, season_id, id),
  FOREIGN KEY (league_id, season_id) REFERENCES seasons(league_id, id)
) STRICT;
CREATE INDEX fad_deadline_controls_league ON fad_deadline_controls(league_id, season_id);

CREATE TABLE fad_deadline_commands (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  client_key TEXT NOT NULL CHECK (length(client_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  prior_control_version INTEGER NOT NULL CHECK (prior_control_version >= 0),
  control_version INTEGER NOT NULL CHECK (control_version = prior_control_version + 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, actor_user_id, client_key),
  FOREIGN KEY (league_id, fad_id) REFERENCES free_agent_drafts(league_id, id)
) STRICT;
CREATE INDEX fad_deadline_commands_league ON fad_deadline_commands(league_id, fad_id, created_at_ms);
CREATE TRIGGER fad_deadline_commands_no_update BEFORE UPDATE ON fad_deadline_commands
BEGIN SELECT RAISE(ABORT, 'FAD deadline command history is immutable'); END;
CREATE TRIGGER fad_deadline_commands_no_delete BEFORE DELETE ON fad_deadline_commands
BEGIN SELECT RAISE(ABORT, 'FAD deadline command history is immutable'); END;

UPDATE application_metadata SET metadata_value = '68', updated_at_ms = max(updated_at_ms, 68)
WHERE metadata_key = 'data_model_version' AND metadata_value = '67';

-- Managers retain access while cards remain open. All assignment, membership,
-- card-phase, contract and commissioner-help guards remain in force.

DROP TRIGGER candidate_card_entries_open_insert;
CREATE TRIGGER candidate_card_entries_open_insert
BEFORE INSERT ON candidate_card_entries
BEGIN
  SELECT CASE WHEN
    NEW.entry_kind = 'candidate'
    AND NEW.placement_state <> 'placed'
  THEN RAISE(
    ABORT,
    'new selectable Candidate entry must begin placed'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.last_edited_by_user_id IS NEW.created_by_user_id
    AND NEW.last_edited_by_membership_id IS
      NEW.created_by_membership_id
    AND NEW.last_edited_by_authority IS NEW.created_by_authority
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id =
            candidate_cards.league_id
       AND free_agent_drafts.season_id =
            candidate_cards.season_id
       AND free_agent_drafts.id = candidate_cards.fad_id
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.season_id = NEW.season_id
        AND candidate_cards.fad_id = NEW.fad_id
        AND candidate_cards.id = NEW.card_id
        AND candidate_cards.team_id = NEW.team_id
        AND candidate_cards.status = 'open'
        AND free_agent_drafts.status = 'cards_open'
        AND (
          NEW.created_by_authority IN ('system', 'manager')
          OR NEW.created_at_ms <
            coalesce(free_agent_drafts.candidate_deadline_at_ms, 8640000000000000)
        )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate entry insert requires an open pre-deadline card'
  ) END;

  SELECT CASE WHEN
    NEW.entry_kind = 'carryover'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM player_ownerships
        WHERE player_ownerships.id =
            NEW.carryover_ownership_id
          AND player_ownerships.league_id = NEW.league_id
          AND player_ownerships.season_id = NEW.season_id
          AND player_ownerships.team_id = NEW.team_id
          AND player_ownerships.player_id = NEW.player_id
          AND player_ownerships.ownership_kind = 'Rostered'
          AND player_ownerships.roster_category =
            NEW.source_roster_category
          AND player_ownerships.position_group =
            NEW.effective_position_group
          AND (
            player_ownerships.roster_category =
              'Injured Reserve'
            OR player_ownerships.slot_number IS NULL
            OR player_ownerships.slot_number =
              NEW.requested_slot_number
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM contracts
        WHERE contracts.id = NEW.carryover_contract_id
          AND contracts.league_id = NEW.league_id
          AND contracts.player_id = NEW.player_id
          AND contracts.current_team_id = NEW.team_id
          AND contracts.status = 'active'
          AND contracts.original_total_value_cents =
            NEW.carryover_original_total_value_cents
          AND contracts.original_term_years =
            NEW.carryover_original_term_years
          AND contracts.aav_cents = NEW.carryover_aav_cents
      )
      OR NOT EXISTS (
        SELECT 1
        FROM contract_years
        WHERE contract_years.league_id = NEW.league_id
          AND contract_years.contract_id =
            NEW.carryover_contract_id
          AND contract_years.season_id = NEW.season_id
          AND contract_years.status = 'current'
      )
      OR NEW.remaining_years <> (
        SELECT COUNT(*)
        FROM contract_years
        WHERE contract_years.league_id = NEW.league_id
          AND contract_years.contract_id =
            NEW.carryover_contract_id
          AND contract_years.status IN ('current', 'future')
      )
    )
  THEN RAISE(
    ABORT,
    'carryover entry must copy current ownership and contract evidence'
  ) END;
END;

DROP TRIGGER candidate_card_entries_open_update;
CREATE TRIGGER candidate_card_entries_open_update
BEFORE UPDATE ON candidate_card_entries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.card_id IS OLD.card_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.entry_kind IS OLD.entry_kind
    AND NEW.player_id IS OLD.player_id
    AND NEW.created_by_user_id IS OLD.created_by_user_id
    AND NEW.created_by_membership_id IS OLD.created_by_membership_id
    AND NEW.created_by_authority IS OLD.created_by_authority
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id = candidate_cards.league_id
       AND free_agent_drafts.id = candidate_cards.fad_id
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.id = NEW.card_id
        AND candidate_cards.status = 'open'
        AND free_agent_drafts.status = 'cards_open'
        AND (
          NEW.last_edited_by_authority IN ('system', 'manager')
          OR NEW.updated_at_ms <
            coalesce(free_agent_drafts.candidate_deadline_at_ms, 8640000000000000)
        )
    )
    AND (
      OLD.entry_kind = 'candidate'
      OR (
        NEW.carryover_ownership_id IS OLD.carryover_ownership_id
        AND NEW.carryover_contract_id IS OLD.carryover_contract_id
        AND NEW.carryover_original_total_value_cents IS
          OLD.carryover_original_total_value_cents
        AND NEW.carryover_original_term_years IS
          OLD.carryover_original_term_years
        AND NEW.carryover_aav_cents IS OLD.carryover_aav_cents
        AND NEW.remaining_years IS OLD.remaining_years
        AND NEW.effective_position_group IS
          OLD.effective_position_group
        AND NEW.placement_state = 'placed'
        AND NEW.conflict_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM player_ownerships
          WHERE player_ownerships.league_id = NEW.league_id
            AND player_ownerships.id = NEW.carryover_ownership_id
            AND player_ownerships.season_id = NEW.season_id
            AND player_ownerships.team_id = NEW.team_id
            AND player_ownerships.player_id = NEW.player_id
            AND player_ownerships.roster_category =
              NEW.source_roster_category
            AND (
              (
                NEW.source_roster_category = 'Active'
                AND NEW.requested_slot_group =
                  NEW.effective_position_group
              )
              OR (
                NEW.source_roster_category = 'Bench'
                AND NEW.requested_slot_group = 'B'
              )
              OR (
                NEW.source_roster_category = 'Injured Reserve'
                AND NEW.requested_slot_group =
                  NEW.effective_position_group
              )
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate entry update violates open-card or carryover move rules'
  ) END;
END;

DROP TRIGGER candidate_card_revisions_authority_insert;
CREATE TRIGGER candidate_card_revisions_authority_insert
BEFORE INSERT ON candidate_card_revisions
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.warning_codes_json)
    WHERE json_each.type <> 'text'
      OR json_each.value <> trim(json_each.value)
      OR length(json_each.value) NOT BETWEEN 1 AND 100
      OR json_each.value GLOB '*[^A-Z0-9_]*'
  ) THEN RAISE(
    ABORT,
    'Candidate Card warning codes must be safe strings'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_cards
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.season_id = NEW.season_id
      AND candidate_cards.fad_id = NEW.fad_id
      AND candidate_cards.id = NEW.card_id
      AND candidate_cards.team_id = NEW.team_id
      AND candidate_cards.version = NEW.resulting_card_version
  ) THEN RAISE(
    ABORT,
    'Candidate Card revision must match the resulting card version'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_cards
    JOIN free_agent_drafts
      ON free_agent_drafts.league_id =
          candidate_cards.league_id
     AND free_agent_drafts.season_id =
          candidate_cards.season_id
     AND free_agent_drafts.id = candidate_cards.fad_id
    WHERE candidate_cards.league_id = NEW.league_id
      AND candidate_cards.id = NEW.card_id
      AND (
        (
          NEW.action = 'card_opened'
          AND candidate_cards.status = 'open'
          AND free_agent_drafts.status = 'cards_open'
          AND NEW.occurred_at_ms = free_agent_drafts.opened_at_ms
        )
        OR (
          NEW.action = 'deadline_locked'
          AND candidate_cards.status IN (
            'locked_complete',
            'locked_incomplete',
            'locked_conflicted'
          )
          AND NEW.occurred_at_ms >=
            coalesce(free_agent_drafts.candidate_deadline_at_ms, 8640000000000000)
        )
        OR (
          NEW.action NOT IN ('card_opened', 'deadline_locked')
          AND candidate_cards.status = 'open'
          AND free_agent_drafts.status = 'cards_open'
          AND (
            NEW.actor_authority IN ('system', 'manager')
            OR NEW.occurred_at_ms <
              coalesce(free_agent_drafts.candidate_deadline_at_ms, 8640000000000000)
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'Candidate Card revision is outside its lifecycle phase'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority = 'system'
    AND NEW.action NOT IN (
      'card_opened',
      'carryover_synchronized',
      'eligibility_revalidated',
      'summer_state_synchronized',
      'deadline_locked'
    )
  THEN RAISE(
    ABORT,
    'system cannot perform a manager Candidate action'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority <> 'system'
    AND NOT EXISTS (
      SELECT 1
      FROM league_memberships
      WHERE league_memberships.league_id = NEW.league_id
        AND league_memberships.id = NEW.actor_membership_id
        AND league_memberships.user_id = NEW.actor_user_id
        AND league_memberships.status = 'active'
    )
  THEN RAISE(
    ABORT,
    'Candidate Card revision actor must have active membership'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority = 'manager'
    AND NOT EXISTS (
      SELECT 1
      FROM team_manager_assignments
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.user_id = NEW.actor_user_id
        AND team_manager_assignments.membership_id =
          NEW.actor_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
    )
  THEN RAISE(
    ABORT,
    'Candidate Card revision actor is not the current manager'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority IN (
      'commissioner',
      'platform_administrator_as_commissioner'
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM candidate_card_help_requests
        WHERE candidate_card_help_requests.league_id =
            NEW.league_id
          AND candidate_card_help_requests.fad_id = NEW.fad_id
          AND candidate_card_help_requests.card_id = NEW.card_id
          AND candidate_card_help_requests.team_id = NEW.team_id
          AND candidate_card_help_requests.status = 'active'
          AND NEW.occurred_at_ms <
            candidate_card_help_requests.expires_at_ms
      )
      OR (
        NEW.actor_authority = 'commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.actor_membership_id
        )
      )
      OR (
        NEW.actor_authority =
          'platform_administrator_as_commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = NEW.actor_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  THEN RAISE(
    ABORT,
    'commissioner Candidate edit requires active help authority'
  ) END;

  SELECT CASE WHEN
    (
      NEW.action = 'card_opened'
      AND NOT (
        NEW.actor_authority = 'system'
        AND NEW.resulting_card_version = 1
      )
    )
    OR (
      NEW.action = 'deadline_locked'
      AND NOT (
        NEW.actor_authority = 'system'
        AND EXISTS (
          SELECT 1
          FROM candidate_cards
          WHERE candidate_cards.league_id = NEW.league_id
            AND candidate_cards.id = NEW.card_id
            AND candidate_cards.status IN (
              'locked_complete',
              'locked_incomplete',
              'locked_conflicted'
            )
        )
      )
    )
  THEN RAISE(
    ABORT,
    'Candidate Card lifecycle revision has invalid authority'
  ) END;
END;
