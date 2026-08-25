-- hundo-leago: foreign-key-rebuild
-- Allow partial Candidate Card rows and one atomic whole-card save while
-- preserving every schema-49 Candidate Card row and immutable history row.

CREATE TEMP TABLE migration_0050_candidate_card_revisions AS
SELECT * FROM candidate_card_revisions;

CREATE TEMP TABLE migration_0050_candidate_card_entries AS
SELECT * FROM candidate_card_entries;

CREATE TEMP TABLE migration_0050_candidate_card_snapshot_entries AS
SELECT * FROM candidate_card_snapshot_entries;

DROP TABLE candidate_card_snapshot_entries;
DROP TABLE candidate_card_entries;
DROP TABLE candidate_card_revisions;

CREATE TABLE candidate_card_revisions (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  resulting_card_version INTEGER NOT NULL
    CHECK (resulting_card_version >= 1),
  action TEXT NOT NULL
    CHECK (
      action IN (
        'card_opened',
        'candidate_added',
        'candidate_edited',
        'candidate_moved',
        'candidate_removed',
        'candidate_card_saved',
        'carryover_moved',
        'carryover_synchronized',
        'eligibility_revalidated',
        'summer_state_synchronized',
        'deadline_locked'
      )
    ),
  affected_entry_id TEXT
    CHECK (
      affected_entry_id IS NULL
      OR (length(affected_entry_id) = 36 AND affected_entry_id = lower(affected_entry_id))
    ),
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  before_evidence_json TEXT NOT NULL
    CHECK (
      json_valid(before_evidence_json) = 1
      AND json_type(before_evidence_json) = 'object'
      AND length(before_evidence_json) BETWEEN 2 AND 65536
    ),
  after_evidence_json TEXT NOT NULL
    CHECK (
      json_valid(after_evidence_json) = 1
      AND json_type(after_evidence_json) = 'object'
      AND length(after_evidence_json) BETWEEN 2 AND 65536
    ),
  potential_illegality_acknowledged INTEGER NOT NULL
    CHECK (potential_illegality_acknowledged = 0),
  warning_codes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(warning_codes_json) = 1
      AND json_type(warning_codes_json) = 'array'
    ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= occurred_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, card_id, resulting_card_version),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ),
  FOREIGN KEY (league_id, season_id, fad_id, card_id, team_id)
    REFERENCES candidate_cards(
      league_id,
      season_id,
      fad_id,
      id,
      team_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      actor_authority = 'system'
      AND actor_user_id IS NULL
      AND actor_membership_id IS NULL
    )
    OR (
      actor_authority <> 'system'
      AND actor_user_id IS NOT NULL
      AND actor_membership_id IS NOT NULL
    )
  ),
  CHECK (
    (
      action IN (
        'candidate_added',
        'candidate_edited',
        'candidate_moved',
        'candidate_removed',
        'carryover_moved'
      )
      AND affected_entry_id IS NOT NULL
      AND player_id IS NOT NULL
    )
    OR action NOT IN (
      'candidate_added',
      'candidate_edited',
      'candidate_moved',
      'candidate_removed',
      'carryover_moved'
    )
  ),
  CHECK (
    action <> 'candidate_card_saved'
    OR (
      affected_entry_id IS NULL
      AND player_id IS NULL
    )
  )
) STRICT;

CREATE TABLE candidate_card_entries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL
    CHECK (entry_kind IN ('carryover', 'candidate')),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  effective_position_group TEXT NOT NULL
    CHECK (effective_position_group IN ('F', 'D')),
  requested_slot_group TEXT NOT NULL
    CHECK (requested_slot_group IN ('F', 'D', 'B')),
  requested_slot_number INTEGER NOT NULL,
  placement_state TEXT NOT NULL
    CHECK (placement_state IN ('placed', 'conflict')),
  conflict_code TEXT
    CHECK (
      conflict_code IS NULL
      OR (
        conflict_code = trim(conflict_code)
        AND length(conflict_code) BETWEEN 1 AND 100
        AND conflict_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  carryover_ownership_id TEXT
    CHECK (
      carryover_ownership_id IS NULL
      OR (
        length(carryover_ownership_id) = 36
        AND carryover_ownership_id = lower(carryover_ownership_id)
      )
    ),
  carryover_contract_id TEXT,
  source_roster_category TEXT
    CHECK (
      source_roster_category IS NULL
      OR source_roster_category IN (
        'Active',
        'Bench',
        'Injured Reserve'
      )
    ),
  carryover_original_total_value_cents INTEGER
    CHECK (
      carryover_original_total_value_cents IS NULL
      OR carryover_original_total_value_cents > 0
    ),
  carryover_original_term_years INTEGER
    CHECK (
      carryover_original_term_years IS NULL
      OR carryover_original_term_years BETWEEN 1 AND 3
    ),
  carryover_aav_cents INTEGER
    CHECK (carryover_aav_cents IS NULL OR carryover_aav_cents > 0),
  remaining_years INTEGER
    CHECK (remaining_years IS NULL OR remaining_years BETWEEN 1 AND 3),
  proposed_total_value_cents INTEGER
    CHECK (
      proposed_total_value_cents IS NULL
      OR proposed_total_value_cents > 0
    ),
  proposed_term_years INTEGER
    CHECK (
      proposed_term_years IS NULL
      OR proposed_term_years BETWEEN 1 AND 3
    ),
  proposed_aav_cents INTEGER
    CHECK (proposed_aav_cents IS NULL OR proposed_aav_cents > 0),
  eligibility_status TEXT
    CHECK (
      eligibility_status IS NULL
      OR eligibility_status IN ('valid', 'warning', 'invalid')
    ),
  validation_code TEXT
    CHECK (
      validation_code IS NULL
      OR (
        validation_code = trim(validation_code)
        AND length(validation_code) BETWEEN 1 AND 100
        AND validation_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  last_acknowledgement_revision_id TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_by_membership_id TEXT,
  created_by_authority TEXT NOT NULL
    CHECK (
      created_by_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  last_edited_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  last_edited_by_membership_id TEXT,
  last_edited_by_authority TEXT NOT NULL
    CHECK (
      last_edited_by_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, card_id, player_id),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ),
  FOREIGN KEY (league_id, season_id, fad_id, card_id, team_id)
    REFERENCES candidate_cards(
      league_id,
      season_id,
      fad_id,
      id,
      team_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, carryover_contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    last_acknowledgement_revision_id
  ) REFERENCES candidate_card_revisions(
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, created_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, last_edited_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      requested_slot_group = 'F'
      AND requested_slot_number BETWEEN 1 AND 12
      AND effective_position_group = 'F'
    )
    OR (
      requested_slot_group = 'D'
      AND requested_slot_number BETWEEN 1 AND 6
      AND effective_position_group = 'D'
    )
    OR (
      requested_slot_group = 'B'
      AND requested_slot_number BETWEEN 1 AND 4
    )
  ),
  CHECK (
    (
      placement_state = 'placed'
      AND conflict_code IS NULL
    )
    OR (
      placement_state = 'conflict'
      AND conflict_code IS NOT NULL
    )
  ),
  CHECK (
    (
      entry_kind = 'carryover'
      AND carryover_ownership_id IS NOT NULL
      AND carryover_contract_id IS NOT NULL
      AND source_roster_category IS NOT NULL
      AND carryover_original_total_value_cents IS NOT NULL
      AND carryover_original_term_years IS NOT NULL
      AND carryover_aav_cents IS NOT NULL
      AND remaining_years IS NOT NULL
      AND remaining_years <= carryover_original_term_years
      AND proposed_total_value_cents IS NULL
      AND proposed_term_years IS NULL
      AND proposed_aav_cents IS NULL
      AND eligibility_status IS NULL
      AND validation_code IS NULL
      AND last_acknowledgement_revision_id IS NULL
    )
    OR (
      entry_kind = 'candidate'
      AND carryover_ownership_id IS NULL
      AND carryover_contract_id IS NULL
      AND source_roster_category IS NULL
      AND carryover_original_total_value_cents IS NULL
      AND carryover_original_term_years IS NULL
      AND carryover_aav_cents IS NULL
      AND remaining_years IS NULL
      AND (
        (
          (
            proposed_total_value_cents IS NULL
            OR proposed_term_years IS NULL
          )
          AND proposed_aav_cents IS NULL
          AND eligibility_status = 'invalid'
          AND validation_code = 'CANDIDATE_CONTRACT_INCOMPLETE'
          AND last_acknowledgement_revision_id IS NULL
        )
        OR (
          proposed_total_value_cents IS NOT NULL
          AND proposed_term_years IS NOT NULL
          AND proposed_aav_cents IS NOT NULL
          AND proposed_aav_cents >= 100
          AND eligibility_status IS NOT NULL
          AND (
            (
              eligibility_status = 'valid'
              AND validation_code IS NULL
            )
            OR (
              eligibility_status IN ('warning', 'invalid')
              AND validation_code IS NOT NULL
              AND validation_code <> 'CANDIDATE_CONTRACT_INCOMPLETE'
            )
          )
          AND proposed_aav_cents =
            (proposed_total_value_cents / proposed_term_years)
            + CASE
              WHEN
                (proposed_total_value_cents % proposed_term_years) * 2
                  >= proposed_term_years
              THEN 1
              ELSE 0
            END
          AND (
            proposed_term_years = 1
            OR proposed_total_value_cents % 100 = 0
          )
        )
      )
    )
  ),
  CHECK (
    requested_slot_group <> 'B'
    OR placement_state = 'conflict'
    OR COALESCE(proposed_aav_cents, carryover_aav_cents) <= 400
  ),
  CHECK (
    entry_kind <> 'candidate'
    OR created_by_authority <> 'system'
  ),
  CHECK (
    entry_kind <> 'carryover'
    OR created_by_authority = 'system'
  ),
  CHECK (
    entry_kind <> 'carryover'
    OR (
      source_roster_category = 'Active'
      AND requested_slot_group = effective_position_group
    )
    OR (
      source_roster_category = 'Bench'
      AND requested_slot_group = 'B'
    )
    OR (
      source_roster_category = 'Injured Reserve'
      AND requested_slot_group = effective_position_group
    )
  ),
  CHECK (
    (
      created_by_authority = 'system'
      AND created_by_user_id IS NULL
      AND created_by_membership_id IS NULL
    )
    OR (
      created_by_authority <> 'system'
      AND created_by_user_id IS NOT NULL
      AND created_by_membership_id IS NOT NULL
    )
  ),
  CHECK (
    (
      last_edited_by_authority = 'system'
      AND last_edited_by_user_id IS NULL
      AND last_edited_by_membership_id IS NULL
    )
    OR (
      last_edited_by_authority <> 'system'
      AND last_edited_by_user_id IS NOT NULL
      AND last_edited_by_membership_id IS NOT NULL
    )
  )
) STRICT;

CREATE TABLE candidate_card_snapshot_entries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  row_kind TEXT NOT NULL CHECK (row_kind IN ('slot', 'conflict')),
  occupant_kind TEXT NOT NULL
    CHECK (occupant_kind IN ('empty', 'carryover', 'candidate')),
  slot_group TEXT NOT NULL CHECK (slot_group IN ('F', 'D', 'B')),
  slot_number INTEGER NOT NULL,
  source_entry_id TEXT,
  source_entry_version INTEGER
    CHECK (
      source_entry_version IS NULL
      OR source_entry_version >= 1
    ),
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  effective_position_group TEXT
    CHECK (
      effective_position_group IS NULL
      OR effective_position_group IN ('F', 'D')
    ),
  conflict_code TEXT
    CHECK (
      conflict_code IS NULL
      OR (
        conflict_code = trim(conflict_code)
        AND length(conflict_code) BETWEEN 1 AND 100
        AND conflict_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  carryover_ownership_id TEXT
    CHECK (
      carryover_ownership_id IS NULL
      OR (
        length(carryover_ownership_id) = 36
        AND carryover_ownership_id = lower(carryover_ownership_id)
      )
    ),
  carryover_contract_id TEXT,
  source_roster_category TEXT
    CHECK (
      source_roster_category IS NULL
      OR source_roster_category IN (
        'Active',
        'Bench',
        'Injured Reserve'
      )
    ),
  carryover_original_total_value_cents INTEGER
    CHECK (
      carryover_original_total_value_cents IS NULL
      OR carryover_original_total_value_cents > 0
    ),
  carryover_original_term_years INTEGER
    CHECK (
      carryover_original_term_years IS NULL
      OR carryover_original_term_years BETWEEN 1 AND 3
    ),
  carryover_aav_cents INTEGER
    CHECK (carryover_aav_cents IS NULL OR carryover_aav_cents > 0),
  remaining_years INTEGER
    CHECK (remaining_years IS NULL OR remaining_years BETWEEN 1 AND 3),
  proposed_total_value_cents INTEGER
    CHECK (
      proposed_total_value_cents IS NULL
      OR proposed_total_value_cents > 0
    ),
  proposed_term_years INTEGER
    CHECK (
      proposed_term_years IS NULL
      OR proposed_term_years BETWEEN 1 AND 3
    ),
  proposed_aav_cents INTEGER
    CHECK (proposed_aav_cents IS NULL OR proposed_aav_cents > 0),
  eligibility_status TEXT
    CHECK (
      eligibility_status IS NULL
      OR eligibility_status IN ('valid', 'warning', 'invalid')
    ),
  validation_code TEXT
    CHECK (
      validation_code IS NULL
      OR (
        validation_code = trim(validation_code)
        AND length(validation_code) BETWEEN 1 AND 100
        AND validation_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  last_edited_by_user_id TEXT
    REFERENCES users(id) ON DELETE RESTRICT,
  last_edited_by_membership_id TEXT,
  last_edited_by_authority TEXT
    CHECK (
      last_edited_by_authority IS NULL
      OR last_edited_by_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner',
        'system'
      )
    ),
  last_edited_at_ms INTEGER
    CHECK (last_edited_at_ms IS NULL OR last_edited_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), allocation_eligibility TEXT
  CHECK (
    allocation_eligibility IS NULL
    OR allocation_eligibility IN (
      'eligible',
      'excluded_structural_conflict',
      'excluded_over_cap'
    )
  ), allocation_exclusion_reason TEXT
  CHECK (
    allocation_exclusion_reason IS NULL
    OR allocation_exclusion_reason IN (
      'candidate_card_structural_conflict',
      'candidate_card_over_cap'
    )
  ),
  UNIQUE (league_id, id),
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    snapshot_id,
    card_id,
    team_id
  ) REFERENCES candidate_card_snapshots(
    league_id,
    season_id,
    fad_id,
    id,
    card_id,
    team_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    source_entry_id
  ) REFERENCES candidate_card_entries(
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, carryover_contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, last_edited_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (slot_group = 'F' AND slot_number BETWEEN 1 AND 12)
    OR (slot_group = 'D' AND slot_number BETWEEN 1 AND 6)
    OR (slot_group = 'B' AND slot_number BETWEEN 1 AND 4)
  ),
  CHECK (
    (
      row_kind = 'slot'
      AND conflict_code IS NULL
    )
    OR (
      row_kind = 'conflict'
      AND occupant_kind <> 'empty'
      AND conflict_code IS NOT NULL
    )
  ),
  CHECK (
    (
      occupant_kind = 'empty'
      AND source_entry_id IS NULL
      AND source_entry_version IS NULL
      AND player_id IS NULL
      AND effective_position_group IS NULL
      AND conflict_code IS NULL
      AND carryover_ownership_id IS NULL
      AND carryover_contract_id IS NULL
      AND source_roster_category IS NULL
      AND carryover_original_total_value_cents IS NULL
      AND carryover_original_term_years IS NULL
      AND carryover_aav_cents IS NULL
      AND remaining_years IS NULL
      AND proposed_total_value_cents IS NULL
      AND proposed_term_years IS NULL
      AND proposed_aav_cents IS NULL
      AND eligibility_status IS NULL
      AND validation_code IS NULL
      AND last_edited_by_user_id IS NULL
      AND last_edited_by_membership_id IS NULL
      AND last_edited_by_authority IS NULL
      AND last_edited_at_ms IS NULL
    )
    OR (
      occupant_kind = 'carryover'
      AND source_entry_id IS NOT NULL
      AND source_entry_version IS NOT NULL
      AND player_id IS NOT NULL
      AND effective_position_group IS NOT NULL
      AND carryover_ownership_id IS NOT NULL
      AND carryover_contract_id IS NOT NULL
      AND source_roster_category IS NOT NULL
      AND carryover_original_total_value_cents IS NOT NULL
      AND carryover_original_term_years IS NOT NULL
      AND carryover_aav_cents IS NOT NULL
      AND remaining_years IS NOT NULL
      AND proposed_total_value_cents IS NULL
      AND proposed_term_years IS NULL
      AND proposed_aav_cents IS NULL
      AND eligibility_status IS NULL
      AND validation_code IS NULL
      AND last_edited_by_authority IS NOT NULL
      AND last_edited_at_ms IS NOT NULL
    )
    OR (
      occupant_kind = 'candidate'
      AND source_entry_id IS NOT NULL
      AND source_entry_version IS NOT NULL
      AND player_id IS NOT NULL
      AND effective_position_group IS NOT NULL
      AND carryover_ownership_id IS NULL
      AND carryover_contract_id IS NULL
      AND source_roster_category IS NULL
      AND carryover_original_total_value_cents IS NULL
      AND carryover_original_term_years IS NULL
      AND carryover_aav_cents IS NULL
      AND remaining_years IS NULL
      AND (
        (
          (
            proposed_total_value_cents IS NULL
            OR proposed_term_years IS NULL
          )
          AND proposed_aav_cents IS NULL
          AND eligibility_status = 'invalid'
          AND validation_code = 'CANDIDATE_CONTRACT_INCOMPLETE'
        )
        OR (
          proposed_total_value_cents IS NOT NULL
          AND proposed_term_years IS NOT NULL
          AND proposed_aav_cents IS NOT NULL
          AND eligibility_status IS NOT NULL
          AND (
            (
              eligibility_status = 'valid'
              AND validation_code IS NULL
            )
            OR (
              eligibility_status IN ('warning', 'invalid')
              AND validation_code IS NOT NULL
              AND validation_code <> 'CANDIDATE_CONTRACT_INCOMPLETE'
            )
          )
        )
      )
      AND last_edited_by_authority IS NOT NULL
      AND last_edited_at_ms IS NOT NULL
    )
  ),
  CHECK (
    occupant_kind = 'empty'
    OR (
      (
        slot_group = 'F'
        AND effective_position_group = 'F'
      )
      OR (
        slot_group = 'D'
        AND effective_position_group = 'D'
      )
      OR slot_group = 'B'
    )
  ),
  CHECK (
    occupant_kind = 'empty'
    OR (
      (
        last_edited_by_authority = 'system'
        AND last_edited_by_user_id IS NULL
        AND last_edited_by_membership_id IS NULL
      )
      OR (
        last_edited_by_authority <> 'system'
        AND last_edited_by_user_id IS NOT NULL
        AND last_edited_by_membership_id IS NOT NULL
      )
    )
  )
) STRICT;

INSERT INTO candidate_card_revisions
SELECT * FROM migration_0050_candidate_card_revisions;

INSERT INTO candidate_card_entries
SELECT * FROM migration_0050_candidate_card_entries;

INSERT INTO candidate_card_snapshot_entries
SELECT * FROM migration_0050_candidate_card_snapshot_entries;

CREATE INDEX candidate_card_revisions_league_actor_time
  ON candidate_card_revisions (
    league_id,
    card_id,
    actor_authority,
    occurred_at_ms
  );

CREATE INDEX candidate_card_revisions_league_card_time
  ON candidate_card_revisions (
    league_id,
    card_id,
    occurred_at_ms
  );

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
            free_agent_drafts.candidate_deadline_at_ms
        )
        OR (
          NEW.action NOT IN ('card_opened', 'deadline_locked')
          AND candidate_cards.status = 'open'
          AND free_agent_drafts.status = 'cards_open'
          AND (
            NEW.actor_authority = 'system'
            OR NEW.occurred_at_ms <
              free_agent_drafts.candidate_deadline_at_ms
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

CREATE TRIGGER candidate_card_revisions_immutable_delete
BEFORE DELETE ON candidate_card_revisions
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card revisions are immutable');
END;

CREATE TRIGGER candidate_card_revisions_immutable_update
BEFORE UPDATE ON candidate_card_revisions
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card revisions are immutable');
END;

CREATE TRIGGER candidate_card_revisions_valid_insert
BEFORE INSERT ON candidate_card_revisions
BEGIN
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
    'Candidate revision must match the resulting card version'
  ) END;

  SELECT CASE WHEN
    NEW.action = 'carryover_moved'
    AND NEW.actor_authority = 'system'
  THEN RAISE(
    ABORT,
    'carryover movement requires manager or help-authorized attribution'
  ) END;
END;

CREATE INDEX candidate_card_entries_league_card_placement
  ON candidate_card_entries (
    league_id,
    card_id,
    placement_state
  );

CREATE INDEX candidate_card_entries_league_fad_player
  ON candidate_card_entries (league_id, fad_id, player_id);

CREATE UNIQUE INDEX candidate_card_entries_one_placed_slot
  ON candidate_card_entries (
    league_id,
    card_id,
    requested_slot_group,
    requested_slot_number
  )
  WHERE placement_state = 'placed';

CREATE TRIGGER candidate_card_entries_acknowledgement_insert
BEFORE INSERT ON candidate_card_entries
WHEN NEW.last_acknowledgement_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM candidate_card_revisions
    WHERE candidate_card_revisions.league_id = NEW.league_id
      AND candidate_card_revisions.season_id = NEW.season_id
      AND candidate_card_revisions.fad_id = NEW.fad_id
      AND candidate_card_revisions.card_id = NEW.card_id
      AND candidate_card_revisions.team_id = NEW.team_id
      AND candidate_card_revisions.id =
        NEW.last_acknowledgement_revision_id
      AND candidate_card_revisions.action IN (
        'candidate_added',
        'candidate_edited',
        'candidate_moved'
      )
      AND candidate_card_revisions.affected_entry_id = NEW.id
      AND candidate_card_revisions.player_id = NEW.player_id
      AND candidate_card_revisions.potential_illegality_acknowledged = 1
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Candidate acknowledgement must reference its accepted revision'
  );
END;

CREATE TRIGGER candidate_card_entries_acknowledgement_update
BEFORE UPDATE OF last_acknowledgement_revision_id
  ON candidate_card_entries
WHEN NEW.last_acknowledgement_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM candidate_card_revisions
    WHERE candidate_card_revisions.league_id = NEW.league_id
      AND candidate_card_revisions.season_id = NEW.season_id
      AND candidate_card_revisions.fad_id = NEW.fad_id
      AND candidate_card_revisions.card_id = NEW.card_id
      AND candidate_card_revisions.team_id = NEW.team_id
      AND candidate_card_revisions.id =
        NEW.last_acknowledgement_revision_id
      AND candidate_card_revisions.action IN (
        'candidate_added',
        'candidate_edited',
        'candidate_moved'
      )
      AND candidate_card_revisions.affected_entry_id = NEW.id
      AND candidate_card_revisions.player_id = NEW.player_id
      AND candidate_card_revisions.potential_illegality_acknowledged = 1
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Candidate acknowledgement must reference its accepted revision'
  );
END;

CREATE TRIGGER candidate_card_entries_actor_insert
BEFORE INSERT ON candidate_card_entries
WHEN NEW.created_by_authority <> 'system'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id = NEW.created_by_membership_id
      AND league_memberships.user_id = NEW.created_by_user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'Candidate entry creator must have active membership'
  ) END;

  SELECT CASE WHEN
    NEW.created_by_authority = 'manager'
    AND NOT EXISTS (
      SELECT 1
      FROM team_manager_assignments
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.user_id =
          NEW.created_by_user_id
        AND team_manager_assignments.membership_id =
          NEW.created_by_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
    )
  THEN RAISE(
    ABORT,
    'Candidate entry creator is not the current manager'
  ) END;

  SELECT CASE WHEN
    NEW.created_by_authority IN (
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
          AND NEW.created_at_ms <
            candidate_card_help_requests.expires_at_ms
      )
      OR (
        NEW.created_by_authority = 'commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.created_by_membership_id
        )
      )
      OR (
        NEW.created_by_authority =
          'platform_administrator_as_commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              NEW.created_by_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  THEN RAISE(
    ABORT,
    'commissioner Candidate entry requires active help'
  ) END;
END;

CREATE TRIGGER candidate_card_entries_actor_update
BEFORE UPDATE ON candidate_card_entries
WHEN NEW.last_edited_by_authority <> 'system'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id =
        NEW.last_edited_by_membership_id
      AND league_memberships.user_id =
        NEW.last_edited_by_user_id
      AND league_memberships.status = 'active'
  ) THEN RAISE(
    ABORT,
    'Candidate entry editor must have active membership'
  ) END;

  SELECT CASE WHEN
    NEW.last_edited_by_authority = 'manager'
    AND NOT EXISTS (
      SELECT 1
      FROM team_manager_assignments
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.user_id =
          NEW.last_edited_by_user_id
        AND team_manager_assignments.membership_id =
          NEW.last_edited_by_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
    )
  THEN RAISE(
    ABORT,
    'Candidate entry editor is not the current manager'
  ) END;

  SELECT CASE WHEN
    NEW.last_edited_by_authority IN (
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
          AND NEW.updated_at_ms <
            candidate_card_help_requests.expires_at_ms
      )
      OR (
        NEW.last_edited_by_authority = 'commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.last_edited_by_membership_id
        )
      )
      OR (
        NEW.last_edited_by_authority =
          'platform_administrator_as_commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              NEW.last_edited_by_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  THEN RAISE(
    ABORT,
    'commissioner Candidate edit requires active help'
  ) END;
END;

CREATE TRIGGER candidate_card_entries_open_delete
BEFORE DELETE ON candidate_card_entries
WHEN NOT EXISTS (
  SELECT 1
  FROM candidate_cards
  JOIN free_agent_drafts
    ON free_agent_drafts.league_id = candidate_cards.league_id
   AND free_agent_drafts.id = candidate_cards.fad_id
  WHERE candidate_cards.league_id = OLD.league_id
    AND candidate_cards.id = OLD.card_id
    AND candidate_cards.status = 'open'
    AND free_agent_drafts.status = 'cards_open'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'locked Candidate entry cannot be deleted'
  );
END;

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
          NEW.created_by_authority = 'system'
          OR NEW.created_at_ms <
            free_agent_drafts.candidate_deadline_at_ms
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
          NEW.last_edited_by_authority = 'system'
          OR NEW.updated_at_ms <
            free_agent_drafts.candidate_deadline_at_ms
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

CREATE TRIGGER candidate_card_entries_valid_carryover_delete
BEFORE DELETE ON candidate_card_entries
WHEN OLD.entry_kind = 'carryover'
  AND EXISTS (
    SELECT 1
    FROM player_ownerships
    JOIN contracts
      ON contracts.league_id = player_ownerships.league_id
     AND contracts.id = OLD.carryover_contract_id
     AND contracts.player_id = player_ownerships.player_id
     AND contracts.current_team_id = player_ownerships.team_id
     AND contracts.status = 'active'
     AND contracts.original_total_value_cents =
       OLD.carryover_original_total_value_cents
     AND contracts.original_term_years =
       OLD.carryover_original_term_years
     AND contracts.aav_cents = OLD.carryover_aav_cents
    WHERE player_ownerships.id = OLD.carryover_ownership_id
      AND player_ownerships.league_id = OLD.league_id
      AND player_ownerships.season_id = OLD.season_id
      AND player_ownerships.team_id = OLD.team_id
      AND player_ownerships.player_id = OLD.player_id
      AND player_ownerships.ownership_kind = 'Rostered'
      AND player_ownerships.roster_category =
        OLD.source_roster_category
      AND player_ownerships.position_group =
        OLD.effective_position_group
      AND (
        player_ownerships.roster_category = 'Injured Reserve'
        OR player_ownerships.slot_number IS NULL
        OR player_ownerships.slot_number =
          OLD.requested_slot_number
      )
      AND EXISTS (
        SELECT 1
        FROM contract_years
        WHERE contract_years.league_id = OLD.league_id
          AND contract_years.contract_id =
            OLD.carryover_contract_id
          AND contract_years.season_id = OLD.season_id
          AND contract_years.status = 'current'
      )
      AND OLD.remaining_years = (
        SELECT COUNT(*)
        FROM contract_years
        WHERE contract_years.league_id = OLD.league_id
          AND contract_years.contract_id =
            OLD.carryover_contract_id
          AND contract_years.status IN ('current', 'future')
      )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'valid carryover entry cannot be removed from its Candidate Card'
  );
END;

CREATE INDEX candidate_card_snapshot_entries_league_fad_player
  ON candidate_card_snapshot_entries (
    league_id,
    fad_id,
    player_id
  );

CREATE INDEX candidate_card_snapshot_entries_league_snapshot_kind
  ON candidate_card_snapshot_entries (
    league_id,
    snapshot_id,
    row_kind
  );

CREATE UNIQUE INDEX candidate_card_snapshot_entries_one_slot
  ON candidate_card_snapshot_entries (
    league_id,
    snapshot_id,
    slot_group,
    slot_number
  )
  WHERE row_kind = 'slot';

CREATE UNIQUE INDEX candidate_card_snapshot_entries_one_source
  ON candidate_card_snapshot_entries (
    league_id,
    snapshot_id,
    source_entry_id
  )
  WHERE source_entry_id IS NOT NULL;

CREATE TRIGGER candidate_card_snapshot_entries_cap_state_insert
BEFORE INSERT ON candidate_card_snapshot_entries
BEGIN
  SELECT CASE WHEN NOT (
    (
      NEW.occupant_kind <> 'candidate'
      AND NEW.allocation_eligibility IS NULL
      AND NEW.allocation_exclusion_reason IS NULL
    )
    OR (
      NEW.occupant_kind = 'candidate'
      AND EXISTS (
        SELECT 1
        FROM candidate_card_snapshots
        WHERE candidate_card_snapshots.league_id = NEW.league_id
          AND candidate_card_snapshots.id = NEW.snapshot_id
          AND candidate_card_snapshots.allocation_eligibility =
            NEW.allocation_eligibility
          AND candidate_card_snapshots.allocation_exclusion_reason IS
            NEW.allocation_exclusion_reason
      )
    )
  ) THEN RAISE(
    ABORT,
    'every snapshot candidate must copy the card-wide exclusion'
  ) END;
END;

CREATE TRIGGER candidate_card_snapshot_entries_immutable_delete
BEFORE DELETE ON candidate_card_snapshot_entries
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card snapshot entry is immutable');
END;

CREATE TRIGGER candidate_card_snapshot_entries_immutable_update
BEFORE UPDATE ON candidate_card_snapshot_entries
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card snapshot entry is immutable');
END;

CREATE TRIGGER candidate_card_snapshot_entries_source_insert
BEFORE INSERT ON candidate_card_snapshot_entries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_card_snapshots
    WHERE candidate_card_snapshots.league_id = NEW.league_id
      AND candidate_card_snapshots.id = NEW.snapshot_id
      AND candidate_card_snapshots.created_at_ms =
        NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'snapshot entry must share its snapshot commit time'
  ) END;

  SELECT CASE WHEN
    NEW.occupant_kind <> 'empty'
    AND NOT EXISTS (
      SELECT 1
      FROM candidate_card_entries
      WHERE candidate_card_entries.league_id = NEW.league_id
        AND candidate_card_entries.season_id = NEW.season_id
        AND candidate_card_entries.fad_id = NEW.fad_id
        AND candidate_card_entries.card_id = NEW.card_id
        AND candidate_card_entries.team_id = NEW.team_id
        AND candidate_card_entries.id = NEW.source_entry_id
        AND candidate_card_entries.version =
          NEW.source_entry_version
        AND candidate_card_entries.entry_kind =
          NEW.occupant_kind
        AND candidate_card_entries.player_id = NEW.player_id
        AND candidate_card_entries.effective_position_group =
          NEW.effective_position_group
        AND candidate_card_entries.requested_slot_group =
          NEW.slot_group
        AND candidate_card_entries.requested_slot_number =
          NEW.slot_number
        AND (
          (
            NEW.row_kind = 'slot'
            AND candidate_card_entries.placement_state = 'placed'
          )
          OR (
            NEW.row_kind = 'conflict'
            AND candidate_card_entries.placement_state = 'conflict'
            AND candidate_card_entries.conflict_code =
              NEW.conflict_code
          )
        )
        AND candidate_card_entries.carryover_ownership_id IS
          NEW.carryover_ownership_id
        AND candidate_card_entries.carryover_contract_id IS
          NEW.carryover_contract_id
        AND candidate_card_entries.source_roster_category IS
          NEW.source_roster_category
        AND candidate_card_entries.carryover_original_total_value_cents
          IS NEW.carryover_original_total_value_cents
        AND candidate_card_entries.carryover_original_term_years
          IS NEW.carryover_original_term_years
        AND candidate_card_entries.carryover_aav_cents IS
          NEW.carryover_aav_cents
        AND candidate_card_entries.remaining_years IS
          NEW.remaining_years
        AND candidate_card_entries.proposed_total_value_cents IS
          NEW.proposed_total_value_cents
        AND candidate_card_entries.proposed_term_years IS
          NEW.proposed_term_years
        AND candidate_card_entries.proposed_aav_cents IS
          NEW.proposed_aav_cents
        AND candidate_card_entries.eligibility_status IS
          NEW.eligibility_status
        AND candidate_card_entries.validation_code IS
          NEW.validation_code
        AND candidate_card_entries.last_edited_by_user_id IS
          NEW.last_edited_by_user_id
        AND candidate_card_entries.last_edited_by_membership_id IS
          NEW.last_edited_by_membership_id
        AND candidate_card_entries.last_edited_by_authority IS
          NEW.last_edited_by_authority
        AND candidate_card_entries.updated_at_ms =
          NEW.last_edited_at_ms
    )
  THEN RAISE(
    ABORT,
    'snapshot occupant must exactly copy its locked current entry'
  ) END;
END;

CREATE TABLE candidate_card_revision_entry_changes (
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  entry_id TEXT NOT NULL
    CHECK (length(entry_id) = 36 AND entry_id = lower(entry_id)),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  change_kind TEXT NOT NULL
    CHECK (change_kind IN ('add', 'edit', 'move', 'remove')),
  before_slot_key TEXT
    CHECK (before_slot_key IS NULL OR before_slot_key IN ('F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'B01', 'B02', 'B03', 'B04')),
  after_slot_key TEXT
    CHECK (after_slot_key IS NULL OR after_slot_key IN ('F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'B01', 'B02', 'B03', 'B04')),
  before_total_value_cents INTEGER
    CHECK (before_total_value_cents IS NULL OR before_total_value_cents > 0),
  before_term_years INTEGER
    CHECK (before_term_years IS NULL OR before_term_years BETWEEN 1 AND 3),
  after_total_value_cents INTEGER
    CHECK (after_total_value_cents IS NULL OR after_total_value_cents > 0),
  after_term_years INTEGER
    CHECK (after_term_years IS NULL OR after_term_years BETWEEN 1 AND 3),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (league_id, revision_id, entry_id),
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    revision_id
  ) REFERENCES candidate_card_revisions(
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ) ON DELETE RESTRICT,
  CHECK (
    (
      change_kind = 'add'
      AND before_slot_key IS NULL
      AND before_total_value_cents IS NULL
      AND before_term_years IS NULL
      AND after_slot_key IS NOT NULL
    )
    OR (
      change_kind = 'remove'
      AND before_slot_key IS NOT NULL
      AND after_slot_key IS NULL
      AND after_total_value_cents IS NULL
      AND after_term_years IS NULL
    )
    OR (
      change_kind = 'edit'
      AND before_slot_key IS NOT NULL
      AND after_slot_key = before_slot_key
    )
    OR (
      change_kind = 'move'
      AND before_slot_key IS NOT NULL
      AND after_slot_key IS NOT NULL
      AND after_slot_key <> before_slot_key
      AND before_total_value_cents IS after_total_value_cents
      AND before_term_years IS after_term_years
    )
  )
) STRICT;

CREATE INDEX candidate_card_revision_entry_changes_league_card_entry
  ON candidate_card_revision_entry_changes (
    league_id,
    card_id,
    entry_id,
    created_at_ms
  );

CREATE TRIGGER candidate_card_revision_entry_changes_valid_insert
BEFORE INSERT ON candidate_card_revision_entry_changes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_card_revisions
    WHERE candidate_card_revisions.league_id = NEW.league_id
      AND candidate_card_revisions.season_id = NEW.season_id
      AND candidate_card_revisions.fad_id = NEW.fad_id
      AND candidate_card_revisions.card_id = NEW.card_id
      AND candidate_card_revisions.team_id = NEW.team_id
      AND candidate_card_revisions.id = NEW.revision_id
      AND candidate_card_revisions.action = 'candidate_card_saved'
      AND candidate_card_revisions.occurred_at_ms = NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'Candidate Card entry change must belong to its card-wide save revision'
  ) END;
END;

CREATE TRIGGER candidate_card_revision_entry_changes_immutable_update
BEFORE UPDATE ON candidate_card_revision_entry_changes
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card entry change is immutable');
END;

CREATE TRIGGER candidate_card_revision_entry_changes_immutable_delete
BEFORE DELETE ON candidate_card_revision_entry_changes
BEGIN
  SELECT RAISE(ABORT, 'Candidate Card entry change is immutable');
END;

-- Rebuild allocation-evidence triggers against the schema-49 head definitions.
DROP TRIGGER free_agent_draft_allocations_pending_insert;
CREATE TRIGGER free_agent_draft_allocations_pending_insert
BEFORE INSERT ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'pending'
    AND NEW.decision_code IS NULL
    AND NEW.winning_snapshot_entry_id IS NULL
    AND NEW.winning_team_id IS NULL
    AND NEW.contract_id IS NULL
    AND NEW.ownership_id IS NULL
    AND NEW.restricted_auction_id IS NULL
    AND NEW.fallback_open_auction_id IS NULL
    AND NEW.restricted_minimum_total_cents IS NULL
    AND NEW.restricted_minimum_term_years IS NULL
    AND NEW.restricted_minimum_aav_cents IS NULL
    AND NEW.accounted_at_ms IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND (
          free_agent_drafts.status IN (
            'deadline_locked',
            'allocating'
          )
          OR (
            free_agent_drafts.status = 'cards_open'
            AND NEW.created_at_ms >=
              free_agent_drafts.candidate_deadline_at_ms
            AND EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries
              WHERE candidate_card_snapshot_entries.league_id =
                  NEW.league_id
                AND candidate_card_snapshot_entries.season_id =
                  NEW.season_id
                AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
                AND candidate_card_snapshot_entries.player_id =
                  NEW.player_id
                AND candidate_card_snapshot_entries.occupant_kind =
                  'candidate'
                AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
                AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
                AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
            )
            AND EXISTS (
              SELECT 1
              FROM job_runs
              WHERE job_runs.league_id = NEW.league_id
                AND job_runs.season_id = NEW.season_id
                AND job_runs.job_type = 'fad_deadline'
                AND job_runs.occurrence_key =
                  'fad:' || NEW.fad_id || ':deadline:' ||
                    free_agent_drafts.candidate_deadline_at_ms
                AND job_runs.scheduled_for_ms =
                  free_agent_drafts.candidate_deadline_at_ms
                AND job_runs.status IN ('leased', 'running')
                AND job_runs.attempt_count >= 1
                AND job_runs.lease_owner IS NOT NULL
                AND length(trim(job_runs.lease_owner)) > 0
                AND job_runs.lease_token IS NOT NULL
                AND length(trim(job_runs.lease_token)) > 0
                AND job_runs.lease_expires_at_ms > NEW.created_at_ms
                AND job_runs.updated_at_ms >=
                  job_runs.scheduled_for_ms
                AND job_runs.updated_at_ms <= NEW.created_at_ms
                AND job_runs.completed_at_ms IS NULL
                AND job_runs.result_json IS NULL
                AND job_runs.last_error_code IS NULL
                AND job_runs.next_attempt_at_ms IS NULL
                AND (
                  (
                    job_runs.status = 'leased'
                    AND job_runs.started_at_ms IS NULL
                  )
                  OR (
                    job_runs.status = 'running'
                    AND job_runs.started_at_ms IS NOT NULL
                    AND job_runs.started_at_ms <= NEW.created_at_ms
                  )
                )
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'allocation must begin as uncommitted per-player work'
  ) END;
END;

DROP TRIGGER free_agent_drafts_deadline_allocation_barrier;
CREATE TRIGGER free_agent_drafts_deadline_allocation_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'cards_open'
  AND NEW.status = 'deadline_locked'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.window_kind = 'initial'
  ) <> 7 THEN RAISE(
    ABORT,
    'FAD deadline requires exactly seven rapid rollovers'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        free_agent_draft_rollovers.window_kind <> 'initial'
        OR free_agent_draft_rollovers.status <> 'scheduled'
      )
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires all rapid rollovers to remain scheduled'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
  ) <> (
    SELECT COUNT(DISTINCT player_id)
    FROM candidate_card_snapshot_entries
    WHERE candidate_card_snapshot_entries.league_id = NEW.league_id
      AND candidate_card_snapshot_entries.season_id = NEW.season_id
      AND candidate_card_snapshot_entries.fad_id = NEW.id
      AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one pending allocation per candidate player'
  ) END;

  SELECT CASE WHEN
    EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id = NEW.league_id
        AND candidate_card_snapshot_entries.season_id = NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.id
        AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations
          WHERE free_agent_draft_player_allocations.league_id =
              candidate_card_snapshot_entries.league_id
            AND free_agent_draft_player_allocations.season_id =
              candidate_card_snapshot_entries.season_id
            AND free_agent_draft_player_allocations.fad_id =
              candidate_card_snapshot_entries.fad_id
            AND free_agent_draft_player_allocations.player_id =
              candidate_card_snapshot_entries.player_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id = NEW.league_id
        AND free_agent_draft_player_allocations.season_id = NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              free_agent_draft_player_allocations.league_id
            AND candidate_card_snapshot_entries.season_id =
              free_agent_draft_player_allocations.season_id
            AND candidate_card_snapshot_entries.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND candidate_card_snapshot_entries.player_id =
              free_agent_draft_player_allocations.player_id
            AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
      AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
      AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
        )
    )
  THEN RAISE(
    ABORT,
    'FAD deadline requires the exact Candidate snapshot player set'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status <> 'pending'
  ) THEN RAISE(
    ABORT,
    'FAD deadline allocations must all begin pending'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline_reminder'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':reminder:' ||
          (NEW.candidate_deadline_at_ms - 259200000)
      AND job_runs.scheduled_for_ms =
        NEW.candidate_deadline_at_ms - 259200000
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD deadline requires its exact reminder occurrence'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_deadline'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':deadline:' ||
          NEW.candidate_deadline_at_ms
      AND job_runs.scheduled_for_ms = NEW.candidate_deadline_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms >
        NEW.deadline_locked_at_ms
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD deadline requires its exact deadline occurrence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND (
        SELECT COUNT(*)
        FROM job_runs
        WHERE job_runs.league_id = NEW.league_id
          AND job_runs.season_id = NEW.season_id
          AND job_runs.job_type = 'fad_rollover'
          AND job_runs.occurrence_key =
            'fad:' || NEW.id || ':rollover:' ||
              free_agent_draft_rollovers.sequence || ':' ||
              free_agent_draft_rollovers.rolls_over_at_ms
          AND job_runs.scheduled_for_ms =
            free_agent_draft_rollovers.rolls_over_at_ms
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one exact occurrence per rollover'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND (
        SELECT COUNT(*)
        FROM job_runs
        WHERE job_runs.league_id = NEW.league_id
          AND job_runs.season_id = NEW.season_id
          AND job_runs.job_type = 'fad_allocation'
          AND job_runs.occurrence_key =
            'fad:' || NEW.id || ':allocate:' ||
              free_agent_draft_player_allocations.player_id
          AND job_runs.scheduled_for_ms =
            NEW.candidate_deadline_at_ms
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one exact occurrence per allocation'
  ) END;
END;

DROP TRIGGER free_agent_drafts_automatic_award_resources_barrier;
CREATE TRIGGER free_agent_drafts_automatic_award_resources_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN NEW.status IN ('rapid', 'completed')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status = 'automatic_award'
      AND NOT EXISTS (
        SELECT 1
        FROM contracts
        JOIN player_ownerships
          ON player_ownerships.league_id = contracts.league_id
         AND player_ownerships.id = allocation.ownership_id
         AND player_ownerships.season_id = allocation.season_id
         AND player_ownerships.player_id = allocation.player_id
         AND player_ownerships.team_id =
              allocation.winning_team_id
         AND player_ownerships.ownership_kind = 'Rostered'
        JOIN candidate_card_snapshot_entries AS winning_offer
          ON winning_offer.league_id = contracts.league_id
         AND winning_offer.season_id = allocation.season_id
         AND winning_offer.fad_id = allocation.fad_id
         AND winning_offer.id =
              allocation.winning_snapshot_entry_id
         AND winning_offer.player_id = allocation.player_id
         AND winning_offer.team_id = allocation.winning_team_id
         AND winning_offer.row_kind = 'slot'
         AND winning_offer.occupant_kind = 'candidate'
         AND winning_offer.proposed_total_value_cents IS NOT NULL
         AND winning_offer.proposed_term_years IS NOT NULL
         AND winning_offer.proposed_aav_cents IS NOT NULL
         AND winning_offer.eligibility_status IN (
              'valid',
              'warning'
            )
         AND winning_offer.allocation_eligibility = 'eligible'
        JOIN seasons AS target_season
          ON target_season.league_id = contracts.league_id
         AND target_season.id = allocation.season_id
        WHERE contracts.league_id = allocation.league_id
          AND contracts.id = allocation.contract_id
          AND contracts.player_id = allocation.player_id
          AND contracts.current_team_id =
              allocation.winning_team_id
          AND contracts.status = 'active'
          AND contracts.contract_type = 'normal'
          AND contracts.start_season_id = allocation.season_id
          AND contracts.acquisition_source_type =
              'free_agent_draft_allocation'
          AND contracts.acquisition_source_id = allocation.id
          AND contracts.created_at_ms = allocation.accounted_at_ms
          AND contracts.auction_buyout_lock_expires_at_ms =
              allocation.accounted_at_ms + 1209600000
          AND player_ownerships.acquired_transaction_type =
              'free_agent_draft_allocation'
          AND player_ownerships.acquired_transaction_id =
              allocation.id
          AND player_ownerships.created_at_ms =
              allocation.accounted_at_ms
          AND target_season.status = 'active'
          AND length(target_season.nhl_season_key) = 8
          AND target_season.nhl_season_key
            NOT GLOB '*[^0-9]*'
          AND CAST(
            substr(target_season.nhl_season_key, 5, 4) AS INTEGER
          ) = CAST(
            substr(target_season.nhl_season_key, 1, 4) AS INTEGER
          ) + 1
          AND target_season.nhl_season_key = printf(
            '%04d%04d',
            CAST(
              substr(
                target_season.nhl_season_key,
                1,
                4
              ) AS INTEGER
            ),
            CAST(
              substr(
                target_season.nhl_season_key,
                1,
                4
              ) AS INTEGER
            ) + 1
          )
          AND (
            SELECT COUNT(*)
            FROM contract_years
            WHERE contract_years.league_id = allocation.league_id
              AND contract_years.contract_id =
                  allocation.contract_id
          ) = contracts.original_term_years
          AND NOT EXISTS (
            SELECT 1
            FROM contract_years
            JOIN seasons AS contract_year_season
              ON contract_year_season.league_id =
                  contract_years.league_id
             AND contract_year_season.id =
                  contract_years.season_id
            WHERE contract_years.league_id =
                allocation.league_id
              AND contract_years.contract_id =
                  allocation.contract_id
              AND (
                contract_years.year_number >
                  contracts.original_term_years
                OR contract_years.aav_cents <> contracts.aav_cents
                OR contract_years.created_at_ms <>
                  allocation.accounted_at_ms
                OR NOT (
                  (
                    contract_years.year_number = 1
                    AND contract_years.season_id =
                      allocation.season_id
                    AND contract_years.status = 'current'
                  )
                  OR (
                    contract_years.year_number BETWEEN
                      2 AND contracts.original_term_years
                    AND contract_years.status = 'future'
                    AND contract_year_season.status = 'planned'
                    AND contract_year_season
                      .regular_season_starts_at_ms IS NULL
                    AND contract_year_season
                      .regular_season_ends_at_ms IS NULL
                    AND contract_year_season
                      .fantasy_playoffs_start_at_ms IS NULL
                    AND contract_year_season
                      .fantasy_playoffs_end_at_ms IS NULL
                    AND contract_year_season.nhl_season_key =
                      printf(
                        '%04d%04d',
                        CAST(
                          substr(
                            target_season.nhl_season_key,
                            1,
                            4
                          ) AS INTEGER
                        ) + contract_years.year_number - 1,
                        CAST(
                          substr(
                            target_season.nhl_season_key,
                            1,
                            4
                          ) AS INTEGER
                        ) + contract_years.year_number
                      )
                    AND contract_year_season.label = printf(
                      '%04d-%02d',
                      CAST(
                        substr(
                          target_season.nhl_season_key,
                          1,
                          4
                        ) AS INTEGER
                      ) + contract_years.year_number - 1,
                      (
                        CAST(
                          substr(
                            target_season.nhl_season_key,
                            1,
                            4
                          ) AS INTEGER
                        ) + contract_years.year_number
                      ) % 100
                    )
                  )
                )
              )
          )
          AND contracts.original_total_value_cents =
              winning_offer.proposed_total_value_cents
          AND contracts.original_term_years =
              winning_offer.proposed_term_years
          AND contracts.aav_cents =
              winning_offer.proposed_aav_cents
          AND (
            (
              winning_offer.slot_group IN ('F', 'D')
              AND player_ownerships.roster_category = 'Active'
            )
            OR (
              winning_offer.slot_group = 'B'
              AND player_ownerships.roster_category = 'Bench'
            )
          )
          AND player_ownerships.position_group =
              winning_offer.effective_position_group
          AND player_ownerships.slot_number =
              winning_offer.slot_number
      )
  ) THEN RAISE(
    ABORT,
    'FAD milestone requires durable automatic-award resources'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status = 'automatic_award'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_allocation_events AS decision_event
        JOIN league_activity
          ON league_activity.league_id = decision_event.league_id
         AND league_activity.id = decision_event.activity_id
        JOIN outbox_events
          ON outbox_events.league_id = decision_event.league_id
         AND outbox_events.id = json_extract(
              decision_event.evidence_json,
              '$.sideEffects.outboxEventId'
            )
        JOIN candidate_card_snapshot_entries AS winning_offer
          ON winning_offer.league_id = allocation.league_id
         AND winning_offer.season_id = allocation.season_id
         AND winning_offer.fad_id = allocation.fad_id
         AND winning_offer.id = allocation.winning_snapshot_entry_id
         AND winning_offer.team_id = allocation.winning_team_id
         AND winning_offer.player_id = allocation.player_id
         AND winning_offer.row_kind = 'slot'
         AND winning_offer.occupant_kind = 'candidate'
         AND winning_offer.proposed_total_value_cents IS NOT NULL
         AND winning_offer.proposed_term_years IS NOT NULL
         AND winning_offer.proposed_aav_cents IS NOT NULL
        WHERE decision_event.league_id = allocation.league_id
          AND decision_event.season_id = allocation.season_id
          AND decision_event.fad_id = allocation.fad_id
          AND decision_event.allocation_id = allocation.id
          AND decision_event.allocation_version = allocation.version
          AND decision_event.player_id = allocation.player_id
          AND decision_event.event_kind = 'decision_recorded'
          AND decision_event.decision_code = allocation.decision_code
          AND decision_event.resulting_allocation_status =
              allocation.status
          AND decision_event.contract_id = allocation.contract_id
          AND decision_event.ownership_id = allocation.ownership_id
          AND decision_event.auction_id IS NULL
          AND decision_event.activity_id IS NOT NULL
          AND decision_event.actor_authority = 'system'
          AND decision_event.occurred_at_ms = allocation.accounted_at_ms
          AND json_extract(
                decision_event.evidence_json,
                '$.sideEffects.activityId'
              ) = decision_event.activity_id
          AND league_activity.season_id = allocation.season_id
          AND league_activity.event_type =
              'free_agent_draft_player_awarded'
          AND league_activity.actor_user_id IS NULL
          AND league_activity.actor_authority = 'system'
          AND league_activity.team_id = allocation.winning_team_id
          AND league_activity.player_id = allocation.player_id
          AND league_activity.related_type =
              'free_agent_draft_allocation'
          AND league_activity.related_id = allocation.id
          AND league_activity.reason IS NULL
          AND league_activity.occurred_at_ms = allocation.accounted_at_ms
          AND json_extract(
                league_activity.metadata_json,
                '$.fadId'
              ) = allocation.fad_id
          AND json_extract(
                league_activity.metadata_json,
                '$.allocationId'
              ) = allocation.id
          AND json_extract(
                league_activity.metadata_json,
                '$.playerId'
              ) = allocation.player_id
          AND json_extract(
                league_activity.metadata_json,
                '$.winningTeamId'
              ) = allocation.winning_team_id
          AND json_extract(
                league_activity.metadata_json,
                '$.contractId'
              ) = allocation.contract_id
          AND json_extract(
                league_activity.metadata_json,
                '$.ownershipId'
              ) = allocation.ownership_id
          AND outbox_events.event_type = 'free_agent_draft.changed'
          AND outbox_events.aggregate_type = 'free_agent_draft'
          AND outbox_events.aggregate_id = allocation.fad_id
          AND outbox_events.available_at_ms = allocation.accounted_at_ms
          AND outbox_events.created_at_ms = allocation.accounted_at_ms
          AND json_valid(outbox_events.payload_json) = 1
          AND json_type(outbox_events.payload_json) = 'object'
          AND (SELECT COUNT(*) FROM json_each(outbox_events.payload_json)) = 8
          AND NOT EXISTS (
            SELECT 1 FROM json_each(outbox_events.payload_json) AS member
            WHERE member.key NOT IN (
              'eventId', 'type', 'leagueId', 'resourceId',
              'version', 'reasonCode', 'occurredAt', 'related'
            )
          )
          AND json_type(outbox_events.payload_json, '$.eventId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.eventId') = outbox_events.id
          AND json_type(outbox_events.payload_json, '$.type') = 'text'
          AND json_extract(outbox_events.payload_json, '$.type') = 'free_agent_draft.changed'
          AND json_type(outbox_events.payload_json, '$.leagueId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.leagueId') = outbox_events.league_id
          AND json_type(outbox_events.payload_json, '$.resourceId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.resourceId') = allocation.fad_id
          AND json_type(outbox_events.payload_json, '$.version') = 'integer'
          AND json_type(
                decision_event.evidence_json,
                '$.sideEffects.fadVersion'
              ) = 'integer'
          AND json_extract(
                decision_event.evidence_json,
                '$.sideEffects.fadVersion'
              ) >= 1
          AND json_extract(outbox_events.payload_json, '$.version') =
              json_extract(
                decision_event.evidence_json,
                '$.sideEffects.fadVersion'
              )
          AND json_type(outbox_events.payload_json, '$.reasonCode') = 'text'
          AND json_extract(outbox_events.payload_json, '$.reasonCode') = 'allocation_changed'
          AND json_type(outbox_events.payload_json, '$.occurredAt') = 'integer'
          AND json_extract(outbox_events.payload_json, '$.occurredAt') = allocation.accounted_at_ms
          AND json_type(outbox_events.payload_json, '$.related') = 'object'
          AND (SELECT COUNT(*) FROM json_each(outbox_events.payload_json, '$.related')) = 8
          AND NOT EXISTS (
            SELECT 1 FROM json_each(outbox_events.payload_json, '$.related') AS related_member
            WHERE related_member.key NOT IN (
              'fadId', 'teamId', 'cardId', 'allocationId',
              'auctionId', 'recoveryId', 'nominationQueueId',
              'scheduleRecoveryOperationId'
            )
          )
          AND json_type(outbox_events.payload_json, '$.related.fadId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.fadId') = allocation.fad_id
          AND json_type(outbox_events.payload_json, '$.related.teamId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.teamId') = allocation.winning_team_id
          AND json_type(outbox_events.payload_json, '$.related.cardId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.cardId') = winning_offer.card_id
          AND json_type(outbox_events.payload_json, '$.related.allocationId') = 'text'
          AND json_extract(outbox_events.payload_json, '$.related.allocationId') = allocation.id
          AND json_type(outbox_events.payload_json, '$.related.auctionId') = 'null'
          AND json_type(outbox_events.payload_json, '$.related.recoveryId') = 'null'
          AND json_type(outbox_events.payload_json, '$.related.nominationQueueId') = 'null'
          AND json_type(outbox_events.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
          AND (
            SELECT COUNT(*) FROM outbox_event_audiences AS audience
            WHERE audience.league_id = outbox_events.league_id
              AND audience.outbox_event_id = outbox_events.id
          ) = 1
          AND EXISTS (
            SELECT 1 FROM outbox_event_audiences AS audience
            WHERE audience.league_id = outbox_events.league_id
              AND audience.outbox_event_id = outbox_events.id
              AND audience.audience_kind = 'league'
              AND audience.team_id IS NULL
              AND audience.user_id IS NULL
              AND audience.created_at_ms = allocation.accounted_at_ms
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD milestone requires automatic-award activity and scoped outbox evidence'
  ) END;
END;

DROP TRIGGER free_agent_drafts_allocation_completion_barrier;
CREATE TRIGGER free_agent_drafts_allocation_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status IN ('deadline_locked', 'allocating')
  AND NEW.status = 'rapid'
BEGIN
  SELECT CASE WHEN
    OLD.status = 'deadline_locked'
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.season_id =
          NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.id
    )
  THEN RAISE(
    ABORT,
    'FAD may bypass allocating only when no allocations exist'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND (
        free_agent_draft_player_allocations.status = 'pending'
        OR free_agent_draft_player_allocations.updated_at_ms >
          NEW.allocation_completed_at_ms
        OR (
          SELECT COUNT(*)
          FROM free_agent_draft_allocation_events
          WHERE free_agent_draft_allocation_events.league_id =
              free_agent_draft_player_allocations.league_id
            AND free_agent_draft_allocation_events.season_id =
              free_agent_draft_player_allocations.season_id
            AND free_agent_draft_allocation_events.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND free_agent_draft_allocation_events.allocation_id =
              free_agent_draft_player_allocations.id
            AND free_agent_draft_allocation_events.player_id =
              free_agent_draft_player_allocations.player_id
            AND free_agent_draft_allocation_events.allocation_version =
              free_agent_draft_player_allocations.version
            AND free_agent_draft_allocation_events
              .resulting_allocation_status =
                free_agent_draft_player_allocations.status
            AND free_agent_draft_allocation_events.decision_code IS
              free_agent_draft_player_allocations.decision_code
            AND free_agent_draft_allocation_events.contract_id IS
              free_agent_draft_player_allocations.contract_id
            AND free_agent_draft_allocation_events.ownership_id IS
              free_agent_draft_player_allocations.ownership_id
            AND free_agent_draft_allocation_events.occurred_at_ms =
              free_agent_draft_player_allocations.updated_at_ms
            AND free_agent_draft_allocation_events.event_kind IN (
              'decision_recorded',
              'restricted_state_changed',
              'fallback_state_changed',
              'correction_applied'
            )
        ) <> 1
        OR EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries
          WHERE candidate_card_snapshot_entries.league_id =
              free_agent_draft_player_allocations.league_id
            AND candidate_card_snapshot_entries.season_id =
              free_agent_draft_player_allocations.season_id
            AND candidate_card_snapshot_entries.fad_id =
              free_agent_draft_player_allocations.fad_id
            AND candidate_card_snapshot_entries.player_id =
              free_agent_draft_player_allocations.player_id
            AND candidate_card_snapshot_entries.occupant_kind =
              'candidate'
            AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_allocation_events
              WHERE free_agent_draft_allocation_events.league_id =
                  candidate_card_snapshot_entries.league_id
                AND free_agent_draft_allocation_events.season_id =
                  candidate_card_snapshot_entries.season_id
                AND free_agent_draft_allocation_events.fad_id =
                  candidate_card_snapshot_entries.fad_id
                AND free_agent_draft_allocation_events.allocation_id =
                  free_agent_draft_player_allocations.id
                AND free_agent_draft_allocation_events.player_id =
                  candidate_card_snapshot_entries.player_id
                AND free_agent_draft_allocation_events
                  .allocation_version =
                    free_agent_draft_player_allocations.version
                AND free_agent_draft_allocation_events.event_kind =
                  'offer_considered'
                AND free_agent_draft_allocation_events.snapshot_entry_id =
                  candidate_card_snapshot_entries.id
            )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires current evidence for every allocation and offer'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND NOT (
        (
          allocation.status = 'automatic_award'
          AND allocation.decision_code IN (
            'sole_valid_offer',
            'highest_total',
            'highest_equal_total_aav'
          )
        )
        OR (
          allocation.status IN (
            'restricted_scheduled',
            'restricted_active'
          )
          AND allocation.decision_code =
            'exact_total_and_term_tie'
        )
        OR (
          allocation.status = 'no_valid_offer'
          AND allocation.decision_code = 'no_valid_offer'
        )
        OR (
          allocation.status = 'invalid'
          AND allocation.decision_code IN (
            'invalid_snapshot',
            'candidate_card_structural_conflict',
            'candidate_card_over_cap'
          )
        )
        OR allocation.status = 'correction_required'
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires an approved accounted allocation state'
  ) END;

  WITH
    current_allocations AS (
      SELECT *
      FROM free_agent_draft_player_allocations
      WHERE league_id = NEW.league_id
        AND season_id = NEW.season_id
        AND fad_id = NEW.id
    ),
    valid_offers AS (
      SELECT
        current_allocations.id AS allocation_id,
        candidate_card_snapshot_entries.id AS snapshot_entry_id,
        candidate_card_snapshot_entries.team_id AS team_id,
        candidate_card_snapshot_entries.proposed_total_value_cents
          AS total_value_cents,
        candidate_card_snapshot_entries.proposed_term_years
          AS term_years,
        candidate_card_snapshot_entries.proposed_aav_cents
          AS aav_cents
      FROM current_allocations
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            current_allocations.league_id
       AND candidate_card_snapshot_entries.season_id =
            current_allocations.season_id
       AND candidate_card_snapshot_entries.fad_id =
            current_allocations.fad_id
       AND candidate_card_snapshot_entries.player_id =
            current_allocations.player_id
       AND candidate_card_snapshot_entries.row_kind = 'slot'
       AND candidate_card_snapshot_entries.occupant_kind =
            'candidate'
            AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
            AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
       AND candidate_card_snapshot_entries.eligibility_status
            IN ('valid', 'warning')
       AND candidate_card_snapshot_entries.allocation_eligibility =
            'eligible'
    ),
    maximum_totals AS (
      SELECT allocation_id, MAX(total_value_cents) AS total_value_cents
      FROM valid_offers
      GROUP BY allocation_id
    ),
    top_total_offers AS (
      SELECT valid_offers.*
      FROM valid_offers
      JOIN maximum_totals
        ON maximum_totals.allocation_id = valid_offers.allocation_id
       AND maximum_totals.total_value_cents =
            valid_offers.total_value_cents
    ),
    maximum_aavs AS (
      SELECT allocation_id, MAX(aav_cents) AS aav_cents
      FROM top_total_offers
      GROUP BY allocation_id
    ),
    top_offers AS (
      SELECT top_total_offers.*
      FROM top_total_offers
      JOIN maximum_aavs
        ON maximum_aavs.allocation_id =
            top_total_offers.allocation_id
       AND maximum_aavs.aav_cents = top_total_offers.aav_cents
    ),
    offer_counts AS (
      SELECT
        current_allocations.id AS allocation_id,
        COUNT(valid_offers.snapshot_entry_id) AS valid_count,
        COUNT(top_total_offers.snapshot_entry_id) AS top_total_count,
        COUNT(top_offers.snapshot_entry_id) AS top_count,
        COUNT(DISTINCT top_offers.term_years) AS top_term_count
      FROM current_allocations
      LEFT JOIN valid_offers
        ON valid_offers.allocation_id = current_allocations.id
      LEFT JOIN top_total_offers
        ON top_total_offers.allocation_id = current_allocations.id
       AND top_total_offers.snapshot_entry_id =
            valid_offers.snapshot_entry_id
      LEFT JOIN top_offers
        ON top_offers.allocation_id = current_allocations.id
       AND top_offers.snapshot_entry_id = valid_offers.snapshot_entry_id
      GROUP BY current_allocations.id
    ),
    event_counts AS (
      SELECT
        current_allocations.id AS allocation_id,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'winner'
        ), 0) AS winner_count,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'restricted_tied'
        ), 0) AS restricted_count
      FROM current_allocations
      LEFT JOIN free_agent_draft_allocation_events
        ON free_agent_draft_allocation_events.league_id =
            current_allocations.league_id
       AND free_agent_draft_allocation_events.season_id =
            current_allocations.season_id
       AND free_agent_draft_allocation_events.fad_id =
            current_allocations.fad_id
       AND free_agent_draft_allocation_events.allocation_id =
            current_allocations.id
       AND free_agent_draft_allocation_events.allocation_version =
            current_allocations.version
       AND free_agent_draft_allocation_events.event_kind =
            'offer_considered'
      GROUP BY current_allocations.id
    )
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM current_allocations
    JOIN offer_counts
      ON offer_counts.allocation_id = current_allocations.id
    JOIN event_counts
      ON event_counts.allocation_id = current_allocations.id
    WHERE (
      current_allocations.decision_code = 'sole_valid_offer'
      AND (
        offer_counts.valid_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code = 'highest_total'
      AND (
        offer_counts.valid_count < 2
        OR offer_counts.top_total_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code =
        'highest_equal_total_aav'
      AND (
        offer_counts.top_total_count < 2
        OR offer_counts.top_count <> 1
        OR event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code =
        'exact_total_and_term_tie'
      AND (
        offer_counts.top_count < 2
        OR offer_counts.top_term_count <> 1
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> offer_counts.top_count
      )
    )
    OR (
      current_allocations.decision_code = 'no_valid_offer'
      AND (
        offer_counts.valid_count <> 0
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code IN (
        'sole_valid_offer',
        'highest_total',
        'highest_equal_total_aav'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM top_offers
        JOIN free_agent_draft_allocation_events AS winner_event
          ON winner_event.league_id = current_allocations.league_id
         AND winner_event.season_id = current_allocations.season_id
         AND winner_event.fad_id = current_allocations.fad_id
         AND winner_event.allocation_id = current_allocations.id
         AND winner_event.allocation_version =
              current_allocations.version
         AND winner_event.player_id = current_allocations.player_id
         AND winner_event.event_kind = 'offer_considered'
         AND winner_event.snapshot_entry_id =
              top_offers.snapshot_entry_id
         AND winner_event.team_id = top_offers.team_id
         AND winner_event.offer_valid = 1
         AND winner_event.offer_outcome_code = 'winner'
        WHERE top_offers.allocation_id = current_allocations.id
          AND top_offers.snapshot_entry_id =
              current_allocations.winning_snapshot_entry_id
          AND top_offers.team_id = current_allocations.winning_team_id
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires deterministic total-first and AAV-second evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status IN (
        'restricted_scheduled',
        'restricted_active'
      )
      AND NOT (
        EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.season_id = auctions.season_id
           AND auction_contexts.auction_id = auctions.id
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auction_contexts.league_id
           AND free_agent_draft_rollovers.season_id =
                auction_contexts.season_id
           AND free_agent_draft_rollovers.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_rollovers.id =
                auction_contexts.fad_rollover_id
          JOIN free_agent_draft_draws
            ON free_agent_draft_draws.league_id =
                auction_contexts.league_id
           AND free_agent_draft_draws.season_id =
                auction_contexts.season_id
           AND free_agent_draft_draws.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_draws.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_draws.auction_id =
                auction_contexts.auction_id
          WHERE auctions.league_id = allocation.league_id
            AND auctions.season_id = allocation.season_id
            AND auctions.id = allocation.restricted_auction_id
            AND auctions.player_id = allocation.player_id
            AND auctions.status = 'open'
            AND auctions.resolves_at_ms =
              free_agent_draft_rollovers.rolls_over_at_ms
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = allocation.fad_id
            AND auction_contexts.fad_allocation_id = allocation.id
            AND auction_contexts.fad_origin =
              'candidate_tie_restricted'
            AND free_agent_draft_draws.created_at_ms =
              auctions.opened_at_ms
            AND free_agent_draft_draws.revealed_at_ms IS NULL
            AND free_agent_draft_draws.version = 1
        )
        AND (
          SELECT COUNT(*)
          FROM free_agent_draft_auction_participants
          WHERE free_agent_draft_auction_participants.league_id =
              allocation.league_id
            AND free_agent_draft_auction_participants.season_id =
              allocation.season_id
            AND free_agent_draft_auction_participants.fad_id =
              allocation.fad_id
            AND free_agent_draft_auction_participants.allocation_id =
              allocation.id
            AND free_agent_draft_auction_participants.auction_id =
              allocation.restricted_auction_id
            AND free_agent_draft_auction_participants.status = 'active'
            AND free_agent_draft_auction_participants
              .minimum_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND free_agent_draft_auction_participants
              .minimum_term_years =
                allocation.restricted_minimum_term_years
            AND free_agent_draft_auction_participants
              .minimum_aav_cents =
                allocation.restricted_minimum_aav_cents
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS eligible_offer
          WHERE eligible_offer.league_id = allocation.league_id
            AND eligible_offer.season_id = allocation.season_id
            AND eligible_offer.fad_id = allocation.fad_id
            AND eligible_offer.player_id = allocation.player_id
            AND eligible_offer.row_kind = 'slot'
            AND eligible_offer.occupant_kind = 'candidate'
            AND eligible_offer.proposed_total_value_cents IS NOT NULL
            AND eligible_offer.proposed_term_years IS NOT NULL
            AND eligible_offer.proposed_aav_cents IS NOT NULL
            AND eligible_offer.eligibility_status IN ('valid', 'warning')
            AND eligible_offer.allocation_eligibility = 'eligible'
            AND (
              eligible_offer.proposed_total_value_cents >
                allocation.restricted_minimum_total_cents
              OR (
                eligible_offer.proposed_total_value_cents =
                  allocation.restricted_minimum_total_cents
                AND eligible_offer.proposed_aav_cents >
                  allocation.restricted_minimum_aav_cents
              )
            )
        )
        AND (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS tied_offer
          WHERE tied_offer.league_id = allocation.league_id
            AND tied_offer.season_id = allocation.season_id
            AND tied_offer.fad_id = allocation.fad_id
            AND tied_offer.player_id = allocation.player_id
            AND tied_offer.row_kind = 'slot'
            AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
            AND tied_offer.eligibility_status IN ('valid', 'warning')
            AND tied_offer.allocation_eligibility = 'eligible'
            AND tied_offer.proposed_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND tied_offer.proposed_term_years =
                allocation.restricted_minimum_term_years
            AND tied_offer.proposed_aav_cents =
                allocation.restricted_minimum_aav_cents
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS tied_offer
          WHERE tied_offer.league_id = allocation.league_id
            AND tied_offer.season_id = allocation.season_id
            AND tied_offer.fad_id = allocation.fad_id
            AND tied_offer.player_id = allocation.player_id
            AND tied_offer.row_kind = 'slot'
            AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
            AND tied_offer.eligibility_status IN ('valid', 'warning')
            AND tied_offer.allocation_eligibility = 'eligible'
            AND tied_offer.proposed_total_value_cents =
                allocation.restricted_minimum_total_cents
            AND tied_offer.proposed_aav_cents =
                allocation.restricted_minimum_aav_cents
            AND (
              tied_offer.proposed_term_years <>
                allocation.restricted_minimum_term_years
              OR NOT EXISTS (
                SELECT 1
                FROM free_agent_draft_auction_participants AS participant
                WHERE participant.league_id = allocation.league_id
                  AND participant.season_id = allocation.season_id
                  AND participant.fad_id = allocation.fad_id
                  AND participant.allocation_id = allocation.id
                  AND participant.auction_id =
                      allocation.restricted_auction_id
                  AND participant.team_id = tied_offer.team_id
                  AND participant.source_snapshot_entry_id = tied_offer.id
                  AND participant.status = 'active'
                  AND participant.minimum_total_value_cents =
                      allocation.restricted_minimum_total_cents
                  AND participant.minimum_term_years =
                      allocation.restricted_minimum_term_years
                  AND participant.minimum_aav_cents =
                      allocation.restricted_minimum_aav_cents
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_auction_participants AS participant
          WHERE participant.league_id = allocation.league_id
            AND participant.season_id = allocation.season_id
            AND participant.fad_id = allocation.fad_id
            AND participant.allocation_id = allocation.id
            AND participant.auction_id = allocation.restricted_auction_id
            AND participant.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries AS tied_offer
              WHERE tied_offer.league_id = participant.league_id
                AND tied_offer.season_id = participant.season_id
                AND tied_offer.fad_id = participant.fad_id
                AND tied_offer.id = participant.source_snapshot_entry_id
                AND tied_offer.player_id = allocation.player_id
                AND tied_offer.team_id = participant.team_id
                AND tied_offer.row_kind = 'slot'
                AND tied_offer.occupant_kind = 'candidate'
            AND tied_offer.proposed_total_value_cents IS NOT NULL
            AND tied_offer.proposed_term_years IS NOT NULL
            AND tied_offer.proposed_aav_cents IS NOT NULL
                AND tied_offer.eligibility_status IN ('valid', 'warning')
                AND tied_offer.allocation_eligibility = 'eligible'
                AND tied_offer.proposed_total_value_cents =
                    allocation.restricted_minimum_total_cents
                AND tied_offer.proposed_term_years =
                    allocation.restricted_minimum_term_years
                AND tied_offer.proposed_aav_cents =
                    allocation.restricted_minimum_aav_cents
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = allocation.league_id
            AND auction_bids.auction_id =
              allocation.restricted_auction_id
        )
        AND (
          (
            allocation.status = 'restricted_active'
            AND NOT EXISTS (
              SELECT 1
              FROM job_runs
              WHERE job_runs.league_id = allocation.league_id
                AND job_runs.season_id = allocation.season_id
                AND job_runs.job_type = 'fad_restricted_activation'
                AND job_runs.occurrence_key LIKE
                  'fad:' || allocation.fad_id ||
                    ':restricted-activate:' || allocation.id || ':%'
            )
          )
          OR (
            allocation.status = 'restricted_scheduled'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN job_runs
                ON job_runs.league_id = auctions.league_id
               AND job_runs.season_id = auctions.season_id
               AND job_runs.job_type =
                    'fad_restricted_activation'
               AND job_runs.occurrence_key =
                    'fad:' || allocation.fad_id ||
                      ':restricted-activate:' || allocation.id ||
                      ':' || auctions.opened_at_ms
               AND job_runs.scheduled_for_ms =
                    auctions.opened_at_ms
              WHERE auctions.league_id = allocation.league_id
                AND auctions.id = allocation.restricted_auction_id
                AND job_runs.status = 'pending'
                AND job_runs.attempt_count = 0
                AND job_runs.lease_owner IS NULL
                AND job_runs.lease_token IS NULL
                AND job_runs.started_at_ms IS NULL
                AND job_runs.completed_at_ms IS NULL
            )
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires complete immediate or scheduled restricted resources'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = NEW.league_id
      AND allocation.season_id = NEW.season_id
      AND allocation.fad_id = NEW.id
      AND allocation.status = 'correction_required'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            allocation.league_id
          AND free_agent_draft_recoveries.season_id =
            allocation.season_id
          AND free_agent_draft_recoveries.fad_id = allocation.fad_id
          AND free_agent_draft_recoveries.allocation_id = allocation.id
          AND free_agent_draft_recoveries.player_id =
            allocation.player_id
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code =
            allocation.last_error_code
          AND free_agent_draft_recoveries.created_at_ms =
            allocation.updated_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires correction-required allocation recovery'
  ) END;
END;

DROP TRIGGER free_agent_draft_auction_participants_valid_insert;
CREATE TRIGGER free_agent_draft_auction_participants_valid_insert
BEFORE INSERT ON free_agent_draft_auction_participants
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'active'
    AND NEW.active_improvement_bid_id IS NULL
    AND NEW.first_improvement_at_ms IS NULL
    AND NEW.current_cooldown_anchor_at_ms IS NULL
    AND NEW.improvement_committed_at_ms IS NULL
    AND NEW.removed_by_user_id IS NULL
    AND NEW.removed_by_membership_id IS NULL
    AND NEW.removed_authority IS NULL
    AND NEW.removal_reason IS NULL
    AND NEW.removed_at_ms IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind = 'fad_restricted'
        AND auction_contexts.fad_id = NEW.fad_id
        AND auction_contexts.fad_allocation_id =
          NEW.allocation_id
        AND auction_contexts.fad_origin =
          'candidate_tie_restricted'
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.season_id =
          NEW.season_id
        AND free_agent_draft_player_allocations.fad_id = NEW.fad_id
        AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
        AND free_agent_draft_player_allocations.restricted_auction_id =
          NEW.auction_id
        AND free_agent_draft_player_allocations.status IN (
          'restricted_scheduled',
          'restricted_active'
        )
        AND free_agent_draft_player_allocations.restricted_minimum_total_cents =
          NEW.minimum_total_value_cents
        AND free_agent_draft_player_allocations.restricted_minimum_term_years =
          NEW.minimum_term_years
        AND free_agent_draft_player_allocations.restricted_minimum_aav_cents =
          NEW.minimum_aav_cents
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id =
          NEW.league_id
        AND candidate_card_snapshot_entries.id =
          NEW.source_snapshot_entry_id
        AND candidate_card_snapshot_entries.season_id = NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
        AND candidate_card_snapshot_entries.team_id = NEW.team_id
        AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
        AND candidate_card_snapshot_entries.proposed_total_value_cents IS NOT NULL
        AND candidate_card_snapshot_entries.proposed_term_years IS NOT NULL
        AND candidate_card_snapshot_entries.proposed_aav_cents IS NOT NULL
        AND candidate_card_snapshot_entries.player_id = (
          SELECT player_id
          FROM free_agent_draft_player_allocations
          WHERE league_id = NEW.league_id
            AND id = NEW.allocation_id
        )
        AND candidate_card_snapshot_entries.proposed_total_value_cents =
          NEW.minimum_total_value_cents
        AND candidate_card_snapshot_entries.proposed_term_years =
          NEW.minimum_term_years
        AND candidate_card_snapshot_entries.proposed_aav_cents =
          NEW.minimum_aav_cents
        AND candidate_card_snapshot_entries.eligibility_status IN (
          'valid',
          'warning'
        )
        AND candidate_card_snapshot_entries.allocation_eligibility =
          'eligible'
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_card_revisions
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            candidate_card_revisions.league_id
       AND candidate_card_snapshot_entries.id =
            NEW.source_snapshot_entry_id
      JOIN candidate_card_snapshots
        ON candidate_card_snapshots.league_id =
            candidate_card_snapshot_entries.league_id
       AND candidate_card_snapshots.id =
            candidate_card_snapshot_entries.snapshot_id
      WHERE candidate_card_revisions.league_id = NEW.league_id
        AND candidate_card_revisions.id =
          NEW.originating_candidate_revision_id
        AND candidate_card_revisions.season_id = NEW.season_id
        AND candidate_card_revisions.fad_id = NEW.fad_id
        AND candidate_card_revisions.team_id = NEW.team_id
        AND (
          (
            candidate_card_revisions.player_id = (
              SELECT player_id
              FROM free_agent_draft_player_allocations
              WHERE league_id = NEW.league_id
                AND id = NEW.allocation_id
            )
            AND candidate_card_revisions.card_id =
              candidate_card_snapshot_entries.card_id
            AND candidate_card_revisions.affected_entry_id =
              candidate_card_snapshot_entries.source_entry_id
            AND candidate_card_revisions.action IN (
              'candidate_added',
              'candidate_edited',
              'candidate_moved'
            )
          )
          OR (
            candidate_card_revisions.action =
              'candidate_card_saved'
            AND EXISTS (
              SELECT 1
              FROM candidate_card_revision_entry_changes AS entry_change
              WHERE entry_change.league_id =
                  candidate_card_revisions.league_id
                AND entry_change.season_id =
                  candidate_card_revisions.season_id
                AND entry_change.fad_id =
                  candidate_card_revisions.fad_id
                AND entry_change.card_id =
                  candidate_card_revisions.card_id
                AND entry_change.team_id =
                  candidate_card_revisions.team_id
                AND entry_change.revision_id =
                  candidate_card_revisions.id
                AND entry_change.entry_id =
                  candidate_card_snapshot_entries.source_entry_id
                AND entry_change.player_id = (
                  SELECT player_id
                  FROM free_agent_draft_player_allocations
                  WHERE league_id = NEW.league_id
                    AND id = NEW.allocation_id
                )
                AND entry_change.change_kind IN (
                  'add',
                  'edit',
                  'move'
                )
            )
          )
        )
        AND candidate_card_revisions.resulting_card_version <=
          candidate_card_snapshots.locked_card_version
        AND candidate_card_revisions.actor_user_id =
          NEW.originating_actor_user_id
        AND candidate_card_revisions.actor_membership_id =
          NEW.originating_actor_membership_id
        AND candidate_card_revisions.actor_authority =
          NEW.originating_actor_authority
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_revisions AS later_revision
          WHERE later_revision.league_id =
              candidate_card_revisions.league_id
            AND later_revision.card_id =
              candidate_card_revisions.card_id
            AND (
              (
                later_revision.affected_entry_id =
                  candidate_card_revisions.affected_entry_id
                AND later_revision.player_id =
                  candidate_card_revisions.player_id
                AND later_revision.action IN (
                  'candidate_added',
                  'candidate_edited',
                  'candidate_moved'
                )
              )
              OR (
                later_revision.action =
                  'candidate_card_saved'
                AND EXISTS (
                  SELECT 1
                  FROM candidate_card_revision_entry_changes AS later_change
                  WHERE later_change.league_id =
                      later_revision.league_id
                    AND later_change.revision_id =
                      later_revision.id
                    AND later_change.entry_id =
                      candidate_card_snapshot_entries.source_entry_id
                    AND later_change.player_id = (
                      SELECT player_id
                      FROM free_agent_draft_player_allocations
                      WHERE league_id = NEW.league_id
                        AND id = NEW.allocation_id
                    )
                    AND later_change.change_kind IN (
                      'add',
                      'edit',
                      'move'
                    )
                )
              )
            )
            AND later_revision.resulting_card_version >
              candidate_card_revisions.resulting_card_version
            AND later_revision.resulting_card_version <=
              candidate_card_snapshots.locked_card_version
        )
    )
  ) THEN RAISE(
    ABORT,
    'restricted participant must begin with immutable Candidate minimum and no bid'
  ) END;
END;
DROP TRIGGER free_agent_draft_allocations_forward_update;
CREATE TRIGGER free_agent_draft_allocations_forward_update
BEFORE UPDATE ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'pending'
        AND NEW.status = 'automatic_award'
        AND NEW.decision_code IN (
          'sole_valid_offer',
          'highest_total',
          'highest_equal_total_aav'
        )
        AND NEW.winning_snapshot_entry_id IS NOT NULL
        AND NEW.winning_team_id IS NOT NULL
        AND NEW.contract_id IS NOT NULL
        AND NEW.ownership_id IS NOT NULL
        AND NEW.restricted_auction_id IS NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NULL
        AND NEW.restricted_minimum_term_years IS NULL
        AND NEW.restricted_minimum_aav_cents IS NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'pending'
        AND NEW.status IN (
          'restricted_scheduled',
          'restricted_active'
        )
        AND NEW.decision_code = 'exact_total_and_term_tie'
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.restricted_auction_id IS NOT NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NOT NULL
        AND NEW.restricted_minimum_term_years IS NOT NULL
        AND NEW.restricted_minimum_aav_cents IS NOT NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND (
          (
            NEW.status = 'restricted_active'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN free_agent_draft_rollovers AS current_rollover
                ON current_rollover.league_id = auctions.league_id
               AND current_rollover.season_id = auctions.season_id
               AND current_rollover.fad_id = NEW.fad_id
               AND current_rollover.rolls_over_at_ms =
                    auctions.resolves_at_ms
              WHERE auctions.league_id = NEW.league_id
                AND auctions.season_id = NEW.season_id
                AND auctions.id = NEW.restricted_auction_id
                AND auctions.player_id = NEW.player_id
                AND auctions.status = 'open'
                AND auctions.opened_at_ms = NEW.updated_at_ms
                AND current_rollover.status IN (
                  'scheduled',
                  'processing'
                )
                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.creation_cutoff_at_ms
            )
          )
          OR (
            NEW.status = 'restricted_scheduled'
            AND EXISTS (
              SELECT 1
              FROM auctions
              JOIN free_agent_draft_rollovers AS target_rollover
                ON target_rollover.league_id = auctions.league_id
               AND target_rollover.season_id = auctions.season_id
               AND target_rollover.fad_id = NEW.fad_id
               AND target_rollover.rolls_over_at_ms =
                    auctions.resolves_at_ms
              JOIN free_agent_draft_rollovers AS current_rollover
                ON current_rollover.league_id =
                    target_rollover.league_id
               AND current_rollover.season_id =
                    target_rollover.season_id
               AND current_rollover.fad_id = target_rollover.fad_id
               AND current_rollover.id =
                    target_rollover.predecessor_rollover_id
               AND current_rollover.sequence =
                    target_rollover.sequence - 1
              WHERE auctions.league_id = NEW.league_id
                AND auctions.season_id = NEW.season_id
                AND auctions.id = NEW.restricted_auction_id
                AND auctions.player_id = NEW.player_id
                AND auctions.status = 'open'
                AND auctions.opened_at_ms = target_rollover.opens_at_ms
                AND target_rollover.status = 'scheduled'
                AND target_rollover.opens_at_ms =
                  current_rollover.rolls_over_at_ms
                AND current_rollover.status IN (
                  'scheduled',
                  'processing'
                )
                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.rolls_over_at_ms
            )
          )
        )
      )
      OR (
        OLD.status = 'pending'
        AND NEW.status IN ('no_valid_offer', 'invalid')
        AND NEW.decision_code IN (
          'no_valid_offer',
          'invalid_snapshot',
          'candidate_card_structural_conflict',
          'candidate_card_over_cap'
        )
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.restricted_auction_id IS NULL
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS NULL
        AND NEW.restricted_minimum_term_years IS NULL
        AND NEW.restricted_minimum_aav_cents IS NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
      )
      OR (
        OLD.status = 'restricted_scheduled'
        AND NEW.status = 'restricted_active'
        AND NEW.decision_code IS OLD.decision_code
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM auctions
          JOIN auction_contexts
            ON auction_contexts.league_id = auctions.league_id
           AND auction_contexts.season_id = auctions.season_id
           AND auction_contexts.auction_id = auctions.id
          JOIN free_agent_draft_rollovers
            ON free_agent_draft_rollovers.league_id =
                auction_contexts.league_id
           AND free_agent_draft_rollovers.season_id =
                auction_contexts.season_id
           AND free_agent_draft_rollovers.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_rollovers.id =
                auction_contexts.fad_rollover_id
          JOIN job_runs
            ON job_runs.league_id = auctions.league_id
           AND job_runs.season_id = auctions.season_id
           AND job_runs.job_type = 'fad_restricted_activation'
           AND job_runs.occurrence_key =
                'fad:' || OLD.fad_id || ':restricted-activate:' ||
                  OLD.id || ':' || auctions.opened_at_ms
           AND job_runs.scheduled_for_ms = auctions.opened_at_ms
          WHERE auctions.league_id = OLD.league_id
            AND auctions.season_id = OLD.season_id
            AND auctions.id = OLD.restricted_auction_id
            AND auctions.player_id = OLD.player_id
            AND auctions.status = 'open'
            AND auctions.opened_at_ms <= NEW.updated_at_ms
            AND NEW.updated_at_ms < auctions.resolves_at_ms
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = OLD.fad_id
            AND auction_contexts.fad_allocation_id = OLD.id
            AND auction_contexts.fad_origin =
              'candidate_tie_restricted'
            AND free_agent_draft_rollovers.opens_at_ms =
                auctions.opened_at_ms
            AND free_agent_draft_rollovers.rolls_over_at_ms =
                auctions.resolves_at_ms
            AND free_agent_draft_rollovers.status IN (
              'scheduled',
              'processing'
            )
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms > NEW.updated_at_ms
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms IS NULL
        )
      )
      OR (
        OLD.status = 'restricted_active'
        AND NEW.status = 'restricted_fallback_open'
        AND NEW.decision_code =
          'restricted_no_improvement_fallback'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS NOT NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.accounted_at_ms IS NULL
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'restricted_active'
        AND NEW.status = 'restricted_resolved'
        AND NEW.decision_code = 'restricted_auction_result'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.winning_snapshot_entry_id IS NOT NULL
        AND NEW.winning_team_id IS NOT NULL
        AND NEW.contract_id IS NOT NULL
        AND NEW.ownership_id IS NOT NULL
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
      )
      OR (
        OLD.status = 'restricted_fallback_open'
        AND NEW.status = 'fallback_open_resolved'
        AND NEW.decision_code IN (
          'fallback_open_result',
          'fallback_open_no_winner'
        )
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
        AND (
          (
            NEW.decision_code = 'fallback_open_result'
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
          )
          OR (
            NEW.decision_code = 'fallback_open_no_winner'
            AND NEW.winning_snapshot_entry_id IS NULL
            AND NEW.winning_team_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
          )
        )
      )
      OR (
        OLD.status IN (
          'pending',
          'restricted_scheduled',
          'restricted_active',
          'restricted_fallback_open'
        )
        AND NEW.status = 'correction_required'
        AND NEW.decision_code IS OLD.decision_code
        AND NEW.winning_snapshot_entry_id IS
          OLD.winning_snapshot_entry_id
        AND NEW.winning_team_id IS OLD.winning_team_id
        AND NEW.contract_id IS OLD.contract_id
        AND NEW.ownership_id IS OLD.ownership_id
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms IS OLD.accounted_at_ms
        AND NEW.last_error_code IS NOT NULL
      )
      OR (
        OLD.status = 'correction_required'
        AND NEW.status = CASE
          WHEN OLD.decision_code =
              'exact_total_and_term_tie'
            AND OLD.restricted_auction_id IS NOT NULL
            AND OLD.fallback_open_auction_id IS NULL
            THEN 'restricted_active'
          WHEN OLD.decision_code =
              'restricted_no_improvement_fallback'
            AND OLD.restricted_auction_id IS NOT NULL
            AND OLD.fallback_open_auction_id IS NOT NULL
            THEN 'restricted_fallback_open'
          ELSE NULL
        END
        AND NEW.decision_code IS OLD.decision_code
        AND OLD.winning_snapshot_entry_id IS NULL
        AND OLD.winning_team_id IS NULL
        AND OLD.contract_id IS NULL
        AND OLD.ownership_id IS NULL
        AND NEW.winning_snapshot_entry_id IS
          OLD.winning_snapshot_entry_id
        AND NEW.winning_team_id IS OLD.winning_team_id
        AND NEW.contract_id IS OLD.contract_id
        AND NEW.ownership_id IS OLD.ownership_id
        AND NEW.restricted_auction_id IS
          OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND OLD.restricted_minimum_total_cents IS NOT NULL
        AND OLD.restricted_minimum_term_years IS NOT NULL
        AND OLD.restricted_minimum_aav_cents IS NOT NULL
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND OLD.accounted_at_ms IS NULL
        AND NEW.accounted_at_ms IS OLD.accounted_at_ms
        AND OLD.last_error_code IS NOT NULL
        AND NEW.last_error_code IS NULL
        AND NEW.updated_at_ms > OLD.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM auction_contexts AS context
          JOIN auctions AS auction
            ON auction.league_id = context.league_id
           AND auction.season_id = context.season_id
           AND auction.id = context.auction_id
           AND auction.player_id = OLD.player_id
          JOIN free_agent_draft_rollovers AS rollover
            ON rollover.league_id = context.league_id
           AND rollover.season_id = context.season_id
           AND rollover.fad_id = context.fad_id
           AND rollover.id = context.fad_rollover_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.allocation_id = context.fad_allocation_id
           AND draw.auction_id = context.auction_id
          JOIN free_agent_draft_recoveries AS recovery
            ON recovery.league_id = context.league_id
           AND recovery.season_id = context.season_id
           AND recovery.fad_id = context.fad_id
           AND recovery.player_id = auction.player_id
           AND recovery.allocation_id = context.fad_allocation_id
           AND recovery.rollover_id = context.fad_rollover_id
           AND recovery.auction_id = context.auction_id
          JOIN job_runs AS job
            ON job.league_id = recovery.league_id
           AND job.season_id = recovery.season_id
           AND job.id = recovery.job_run_id
          JOIN auction_events AS failure_event
            ON failure_event.league_id = recovery.league_id
           AND failure_event.season_id = recovery.season_id
           AND failure_event.auction_id = recovery.auction_id
           AND failure_event.event_type =
                'fad_auction_resolution_failed'
          JOIN free_agent_draft_recovery_action_command_results
            AS receipt
            ON receipt.league_id = recovery.league_id
           AND receipt.season_id = recovery.season_id
           AND receipt.fad_id = recovery.fad_id
           AND receipt.recovery_id = recovery.id
           AND receipt.job_run_id = recovery.job_run_id
          JOIN idempotency_requests AS request
            ON request.league_id = receipt.league_id
           AND request.id = receipt.idempotency_request_id
          WHERE context.league_id = OLD.league_id
            AND context.season_id = OLD.season_id
            AND context.fad_id = OLD.fad_id
            AND context.fad_allocation_id = OLD.id
            AND context.auction_id = CASE
              WHEN NEW.status = 'restricted_active'
                THEN OLD.restricted_auction_id
              ELSE OLD.fallback_open_auction_id
            END
            AND (
              (
                NEW.status = 'restricted_active'
                AND context.source_kind = 'fad_restricted'
                AND context.fad_origin =
                  'candidate_tie_restricted'
              )
              OR (
                NEW.status = 'restricted_fallback_open'
                AND context.source_kind = 'fad_open_rapid'
                AND context.fad_origin =
                  'restricted_no_improvement_fallback'
              )
            )
            AND auction.status = 'resolving'
            AND auction.updated_at_ms = NEW.updated_at_ms
            AND auction.resolves_at_ms <= NEW.updated_at_ms
            AND rollover.rolls_over_at_ms =
                auction.resolves_at_ms
            AND draw.algorithm_version = 1
            AND draw.nonce_bytes IS NOT NULL
            AND length(draw.nonce_bytes) = 32
            AND draw.commitment_hex IS NOT NULL
            AND draw.ordered_tied_bid_ids_json IS NULL
            AND draw.ordered_tied_team_ids_json IS NULL
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND draw.revealed_at_ms IS NULL
            AND draw.version = 1
            AND NOT EXISTS (
              SELECT 1
              FROM auction_resolutions AS resolution
              WHERE resolution.league_id = auction.league_id
                AND resolution.auction_id = auction.id
            )
            AND recovery.kind = 'auction_resolution'
            AND recovery.status = 'running'
            AND recovery.target_resolution_at_ms =
                auction.resolves_at_ms
            AND recovery.last_error_code =
                OLD.last_error_code
            AND recovery.commissioner_reason IS NOT NULL
            AND recovery.created_by_operation_id = job.id
            AND recovery.resolved_by_user_id IS NULL
            AND recovery.resolved_by_membership_id IS NULL
            AND recovery.resolved_authority IS NULL
            AND recovery.resolved_at_ms IS NULL
            AND recovery.created_at_ms <=
                failure_event.occurred_at_ms
            AND recovery.updated_at_ms =
                receipt.accepted_at_ms
            AND recovery.updated_at_ms <=
                NEW.updated_at_ms
            AND recovery.version >= 2
            AND failure_event.actor_user_id IS NULL
            AND failure_event.bid_id IS NULL
            AND failure_event.team_id IS NULL
            AND json_valid(failure_event.metadata_json) = 1
            AND json_extract(
                  failure_event.metadata_json,
                  '$.recoveryId'
                ) = recovery.id
            AND json_extract(
                  failure_event.metadata_json,
                  '$.jobRunId'
                ) = job.id
            AND json_extract(
                  failure_event.metadata_json,
                  '$.errorCode'
                ) = OLD.last_error_code
            AND failure_event.occurred_at_ms =
                OLD.updated_at_ms
            AND (
              SELECT COUNT(*)
              FROM auction_events AS exact_failure
              WHERE exact_failure.league_id =
                  failure_event.league_id
                AND exact_failure.season_id =
                  failure_event.season_id
                AND exact_failure.auction_id =
                  failure_event.auction_id
                AND exact_failure.event_type =
                  'fad_auction_resolution_failed'
                AND exact_failure.occurred_at_ms =
                  failure_event.occurred_at_ms
            ) = 1
            AND NOT EXISTS (
              SELECT 1
              FROM auction_events AS later_failure
              WHERE later_failure.league_id =
                  failure_event.league_id
                AND later_failure.season_id =
                  failure_event.season_id
                AND later_failure.auction_id =
                  failure_event.auction_id
                AND later_failure.event_type =
                  'fad_auction_resolution_failed'
                AND json_extract(
                      later_failure.metadata_json,
                      '$.recoveryId'
                    ) = recovery.id
                AND json_extract(
                      later_failure.metadata_json,
                      '$.jobRunId'
                    ) = job.id
                AND later_failure.occurred_at_ms >
                  failure_event.occurred_at_ms
            )
            AND job.job_type = 'auction.resolve.target'
            AND job.occurrence_key =
              'auction:' || auction.id || ':' ||
                auction.resolves_at_ms
            AND job.scheduled_for_ms =
                auction.resolves_at_ms
            AND job.status = 'running'
            AND job.attempt_count >= 2
            AND job.lease_owner IS NOT NULL
            AND job.lease_token IS NOT NULL
            AND job.lease_expires_at_ms >
                NEW.updated_at_ms
            AND job.started_at_ms =
                NEW.updated_at_ms
            AND job.updated_at_ms =
                NEW.updated_at_ms
            AND job.completed_at_ms IS NULL
            AND job.result_json IS NULL
            AND job.last_error_code IS NULL
            AND job.next_attempt_at_ms IS NULL
            AND receipt.action =
                'retry_auction_resolution'
            AND receipt.resource_kind = 'auction'
            AND receipt.resource_id = auction.id
            AND receipt.operation_id = job.id
            AND receipt.job_run_id = job.id
            AND receipt.occurrence_key =
                job.occurrence_key
            AND receipt.commissioner_reason =
                recovery.commissioner_reason
            AND receipt.accepted_status = 'pending'
            AND receipt.accepted_at_ms >=
                failure_event.occurred_at_ms
            AND receipt.accepted_at_ms <=
                NEW.updated_at_ms
            AND request.actor_user_id =
                receipt.actor_user_id
            AND request.operation =
                'free_agent_draft.recovery.action'
            AND request.request_hash =
                receipt.request_sha256
            AND request.status = 'completed'
            AND request.result_type =
                'free_agent_draft_recovery_action_command_result'
            AND request.result_id = receipt.id
            AND request.created_at_ms =
                receipt.accepted_at_ms
            AND request.completed_at_ms =
                receipt.accepted_at_ms
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recovery_action_command_results
                AS later_receipt
              WHERE later_receipt.league_id =
                  receipt.league_id
                AND later_receipt.recovery_id =
                  receipt.recovery_id
                AND later_receipt.action =
                  'retry_auction_resolution'
                AND (
                  later_receipt.accepted_at_ms >
                    receipt.accepted_at_ms
                  OR (
                    later_receipt.accepted_at_ms =
                      receipt.accepted_at_ms
                    AND later_receipt.id > receipt.id
                  )
                )
            )
        )
      )
      OR (
        OLD.status IN (
          'correction_required',
          'restricted_scheduled',
          'restricted_active',
          'restricted_fallback_open',
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
        AND NEW.status IN (
          'automatic_award',
          'restricted_resolved',
          'fallback_open_resolved',
          'no_valid_offer',
          'invalid'
        )
        AND NEW.decision_code = 'corrected'
        AND NEW.restricted_auction_id IS OLD.restricted_auction_id
        AND NEW.fallback_open_auction_id IS
          OLD.fallback_open_auction_id
        AND NEW.restricted_minimum_total_cents IS
          OLD.restricted_minimum_total_cents
        AND NEW.restricted_minimum_term_years IS
          OLD.restricted_minimum_term_years
        AND NEW.restricted_minimum_aav_cents IS
          OLD.restricted_minimum_aav_cents
        AND NEW.accounted_at_ms = NEW.updated_at_ms
        AND NEW.last_error_code IS NULL
        AND (
          OLD.status NOT IN (
            'restricted_scheduled',
            'restricted_active',
            'restricted_fallback_open'
          )
          OR NEW.status IN (
            'automatic_award',
            'no_valid_offer'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM commissioner_corrections AS correction
          WHERE correction.league_id = NEW.league_id
            AND correction.season_id = NEW.season_id
            AND correction.feature =
                'free_agent_draft_allocation'
            AND correction.feature_record_id = NEW.id
            AND correction.corrected_at_ms = NEW.updated_at_ms
            AND json_valid(correction.before_snapshot_json) = 1
            AND json_valid(correction.after_snapshot_json) = 1
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.status'
                ) = OLD.status
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.version'
                ) = OLD.version
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.status'
                ) = NEW.status
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.version'
                ) = NEW.version
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.decisionCode'
                ) = 'corrected'
            AND (
              EXISTS (
                SELECT 1
                FROM leagues AS league
                JOIN league_memberships AS membership
                  ON membership.league_id = league.id
                 AND membership.id =
                      league.commissioner_membership_id
                 AND membership.user_id =
                      correction.actor_user_id
                WHERE league.id = correction.league_id
                  AND membership.permission_category = 'commissioner'
                  AND membership.status = 'active'
              )
              OR EXISTS (
                SELECT 1
                FROM league_memberships AS membership
                JOIN platform_roles AS role
                  ON role.user_id = membership.user_id
                 AND role.role = 'platform_administrator'
                 AND role.status = 'active'
                WHERE membership.league_id = correction.league_id
                  AND membership.user_id = correction.actor_user_id
                  AND membership.status = 'active'
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM auctions AS linked_auction
          WHERE linked_auction.league_id = OLD.league_id
            AND linked_auction.id IN (
              OLD.restricted_auction_id,
              OLD.fallback_open_auction_id
            )
            AND linked_auction.status IN (
              'open',
              'resolving',
              'failed'
            )
        )
        AND (
          OLD.status NOT IN (
            'restricted_scheduled',
            'restricted_active',
            'restricted_fallback_open'
          )
          OR EXISTS (
            SELECT 1
            FROM commissioner_corrections AS correction
            JOIN auctions AS auction
              ON auction.league_id = NEW.league_id
             AND auction.id = CASE
                  WHEN OLD.status =
                    'restricted_fallback_open'
                    THEN OLD.fallback_open_auction_id
                  ELSE OLD.restricted_auction_id
                END
            JOIN auction_contexts AS context
              ON context.league_id = auction.league_id
             AND context.season_id = auction.season_id
             AND context.auction_id = auction.id
             AND context.fad_id = NEW.fad_id
             AND context.fad_allocation_id = NEW.id
            JOIN auction_resolutions AS resolution
              ON resolution.league_id = auction.league_id
             AND resolution.season_id = auction.season_id
             AND resolution.auction_id = auction.id
            JOIN free_agent_draft_draws AS draw
              ON draw.league_id = context.league_id
             AND draw.season_id = context.season_id
             AND draw.fad_id = context.fad_id
             AND draw.allocation_id = context.fad_allocation_id
             AND draw.auction_id = context.auction_id
            JOIN auction_events AS event
              ON event.league_id = auction.league_id
             AND event.season_id = auction.season_id
             AND event.auction_id = auction.id
            WHERE correction.league_id = NEW.league_id
              AND correction.season_id = NEW.season_id
              AND correction.feature =
                  'free_agent_draft_allocation'
              AND correction.feature_record_id = NEW.id
              AND correction.corrected_at_ms = NEW.updated_at_ms
              AND auction.player_id = NEW.player_id
              AND auction.status = 'cancelled'
              AND auction.updated_at_ms = NEW.updated_at_ms
              AND auction.created_at_ms <= NEW.updated_at_ms
              AND draw.created_at_ms <= NEW.updated_at_ms
              AND context.source_kind = CASE
                WHEN OLD.status = 'restricted_fallback_open'
                  THEN 'fad_open_rapid'
                ELSE 'fad_restricted'
              END
              AND (
                OLD.status <> 'restricted_fallback_open'
                OR context.fad_origin =
                  'restricted_no_improvement_fallback'
              )
              AND resolution.status = 'cancelled'
              AND resolution.outcome_code = 'recovered'
              AND resolution.trigger_type = 'commissioner'
              AND resolution.triggered_by_user_id =
                  correction.actor_user_id
              AND resolution.resolved_at_ms = NEW.updated_at_ms
              AND draw.version = 2
              AND draw.revealed_at_ms = NEW.updated_at_ms
              AND draw.ordered_tied_bid_ids_json = '[]'
              AND draw.ordered_tied_team_ids_json = '[]'
              AND draw.rejection_counter IS NULL
              AND draw.selected_index IS NULL
              AND draw.selected_bid_id IS NULL
              AND draw.selected_team_id IS NULL
              AND draw.selected_digest_hex IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM auction_bids AS bid
                WHERE bid.league_id = auction.league_id
                  AND bid.auction_id = auction.id
              )
              AND event.event_type = 'auction_cancelled'
              AND event.actor_user_id = correction.actor_user_id
              AND event.occurred_at_ms = NEW.updated_at_ms
              AND json_extract(
                    event.metadata_json,
                    '$.actorAuthority'
                  ) IN (
                    'commissioner',
                    'platform_administrator_as_commissioner'
                  )
              AND json_extract(
                    event.metadata_json,
                    '$.correctionId'
                  ) = correction.id
          )
        )
        AND (
          NEW.winning_snapshot_entry_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM candidate_card_snapshot_entries AS snapshot_entry
            WHERE snapshot_entry.league_id = NEW.league_id
              AND snapshot_entry.season_id = NEW.season_id
              AND snapshot_entry.fad_id = NEW.fad_id
              AND snapshot_entry.id = NEW.winning_snapshot_entry_id
              AND snapshot_entry.player_id = NEW.player_id
              AND snapshot_entry.team_id = NEW.winning_team_id
              AND snapshot_entry.proposed_total_value_cents IS NOT NULL
              AND snapshot_entry.proposed_term_years IS NOT NULL
              AND snapshot_entry.proposed_aav_cents IS NOT NULL
          )
        )
        AND (
          (
            NEW.status = 'automatic_award'
            AND NEW.winning_snapshot_entry_id IS NOT NULL
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
          )
          OR (
            NEW.status <> 'automatic_award'
            AND NEW.winning_team_id IS NULL
            AND NEW.winning_snapshot_entry_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
          )
        )
      )
    )
    AND (
      NEW.winning_team_id IS NULL
      OR (
        EXISTS (
          SELECT 1
          FROM contracts
          WHERE contracts.league_id = NEW.league_id
            AND contracts.id = NEW.contract_id
            AND contracts.player_id = NEW.player_id
            AND contracts.current_team_id = NEW.winning_team_id
            AND contracts.start_season_id = NEW.season_id
            AND contracts.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM player_ownerships
          WHERE player_ownerships.league_id = NEW.league_id
            AND player_ownerships.id = NEW.ownership_id
            AND player_ownerships.season_id = NEW.season_id
            AND player_ownerships.player_id = NEW.player_id
            AND player_ownerships.team_id = NEW.winning_team_id
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'allocation may only follow automatic, restricted, fallback, or attributable correction state'
  ) END;
END;
CREATE TEMP TABLE migration_0050_row_count_guard (
  preserved INTEGER NOT NULL CHECK (preserved = 1)
) STRICT;

INSERT INTO migration_0050_row_count_guard (preserved)
VALUES (
  (
    (SELECT COUNT(*) FROM candidate_card_revisions)
      = (SELECT COUNT(*) FROM migration_0050_candidate_card_revisions)
    AND (SELECT COUNT(*) FROM candidate_card_entries)
      = (SELECT COUNT(*) FROM migration_0050_candidate_card_entries)
    AND (SELECT COUNT(*) FROM candidate_card_snapshot_entries)
      = (SELECT COUNT(*) FROM migration_0050_candidate_card_snapshot_entries)
  )
);

UPDATE application_metadata
SET metadata_value = '50',
    updated_at_ms = CASE WHEN updated_at_ms < 50 THEN 50 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';

DROP TABLE migration_0050_row_count_guard;
DROP TABLE migration_0050_candidate_card_snapshot_entries;
DROP TABLE migration_0050_candidate_card_entries;
DROP TABLE migration_0050_candidate_card_revisions;
