-- hundo-leago: foreign-key-rebuild

-- Preserve schema-50 rows while replacing only AAV-first constraints.
CREATE TEMP TABLE migration_0051_candidate_card_entries AS
SELECT * FROM candidate_card_entries;

CREATE TEMP TABLE migration_0051_candidate_card_snapshot_entries AS
SELECT * FROM candidate_card_snapshot_entries;

CREATE TEMP TABLE migration_0051_free_agent_draft_auction_participants AS
SELECT * FROM free_agent_draft_auction_participants;

CREATE TEMP TABLE migration_0051_free_agent_draft_nomination_queue AS
SELECT * FROM free_agent_draft_nomination_queue;

DROP TABLE candidate_card_snapshot_entries;
DROP TABLE candidate_card_entries;
DROP TABLE free_agent_draft_auction_participants;
DROP TABLE free_agent_draft_nomination_queue;

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
            proposed_aav_cents IS NULL
            OR proposed_term_years IS NULL
          )
          AND (
            proposed_total_value_cents IS NULL
            OR proposed_aav_cents IS NULL
          )
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
            (
              proposed_aav_cents % 25 = 0
              AND proposed_total_value_cents =
                proposed_aav_cents * proposed_term_years
            )
            OR (
              proposed_total_value_cents >= proposed_term_years * 100
              AND (
                proposed_term_years = 1
                OR proposed_total_value_cents % 100 = 0
              )
            )
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
            proposed_aav_cents IS NULL
            OR proposed_term_years IS NULL
          )
          AND (
            proposed_total_value_cents IS NULL
            OR proposed_aav_cents IS NULL
          )
          AND eligibility_status = 'invalid'
          AND validation_code = 'CANDIDATE_CONTRACT_INCOMPLETE'
        )
        OR (
          proposed_total_value_cents IS NOT NULL
          AND proposed_term_years IS NOT NULL
          AND proposed_aav_cents IS NOT NULL
          AND proposed_aav_cents >= 100
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
            (
              proposed_aav_cents % 25 = 0
              AND proposed_total_value_cents =
                proposed_aav_cents * proposed_term_years
            )
            OR (
              proposed_total_value_cents >= proposed_term_years * 100
              AND (
                proposed_term_years = 1
                OR proposed_total_value_cents % 100 = 0
              )
            )
          )
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

CREATE TABLE free_agent_draft_auction_participants (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  source_snapshot_entry_id TEXT NOT NULL,
  originating_candidate_revision_id TEXT NOT NULL,
  minimum_total_value_cents INTEGER NOT NULL
    CHECK (minimum_total_value_cents > 0),
  minimum_term_years INTEGER NOT NULL
    CHECK (minimum_term_years BETWEEN 1 AND 3),
  minimum_aav_cents INTEGER NOT NULL CHECK (minimum_aav_cents >= 100),
  active_improvement_bid_id TEXT,
  manager_edit_limit INTEGER NOT NULL CHECK (manager_edit_limit = 1),
  cooldown_duration_ms INTEGER NOT NULL
    CHECK (cooldown_duration_ms = 4500000),
  first_improvement_at_ms INTEGER
    CHECK (first_improvement_at_ms IS NULL OR first_improvement_at_ms >= 0),
  current_cooldown_anchor_at_ms INTEGER
    CHECK (
      current_cooldown_anchor_at_ms IS NULL
      OR current_cooldown_anchor_at_ms >= 0
    ),
  improvement_committed_at_ms INTEGER
    CHECK (
      improvement_committed_at_ms IS NULL
      OR improvement_committed_at_ms >= 0
    ),
  originating_actor_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  originating_actor_membership_id TEXT NOT NULL,
  originating_actor_authority TEXT NOT NULL
    CHECK (
      originating_actor_authority IN (
        'manager',
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  removed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  removed_by_membership_id TEXT,
  removed_authority TEXT
    CHECK (
      removed_authority IS NULL
      OR removed_authority IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  removal_reason TEXT
    CHECK (
      removal_reason IS NULL
      OR (
        removal_reason = trim(removal_reason)
        AND length(removal_reason) BETWEEN 1 AND 500
      )
    ),
  removed_at_ms INTEGER
    CHECK (removed_at_ms IS NULL OR removed_at_ms >= created_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, source_snapshot_entry_id),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    team_id
  ),
  UNIQUE (
    league_id,
    season_id,
    fad_id,
    auction_id,
    team_id
  ),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id, auction_id)
    REFERENCES auction_contexts(league_id, season_id, auction_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_snapshot_entry_id)
    REFERENCES candidate_card_snapshot_entries(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, originating_candidate_revision_id)
    REFERENCES candidate_card_revisions(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, active_improvement_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, originating_actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, removed_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    minimum_aav_cents =
      (minimum_total_value_cents / minimum_term_years)
      + CASE
          WHEN
            (minimum_total_value_cents % minimum_term_years) * 2
              >= minimum_term_years
          THEN 1
          ELSE 0
        END
    AND (
      (
        minimum_aav_cents % 25 = 0
        AND minimum_total_value_cents =
          minimum_aav_cents * minimum_term_years
      )
      OR (
        minimum_total_value_cents >= minimum_term_years * 100
        AND (
          minimum_term_years = 1
          OR minimum_total_value_cents % 100 = 0
        )
      )
    )
  ),

  CHECK (
    (
      status = 'active'
      AND active_improvement_bid_id IS NULL
      AND first_improvement_at_ms IS NULL
      AND current_cooldown_anchor_at_ms IS NULL
      AND improvement_committed_at_ms IS NULL
    )
    OR (
      status = 'active'
      AND active_improvement_bid_id IS NOT NULL
      AND first_improvement_at_ms IS NOT NULL
      AND current_cooldown_anchor_at_ms IS NOT NULL
      AND improvement_committed_at_ms IS NOT NULL
      AND first_improvement_at_ms <= improvement_committed_at_ms
      AND current_cooldown_anchor_at_ms <= improvement_committed_at_ms
    )
    OR (
      status = 'removed'
      AND active_improvement_bid_id IS NULL
      AND (
        (
          first_improvement_at_ms IS NULL
          AND current_cooldown_anchor_at_ms IS NULL
          AND improvement_committed_at_ms IS NULL
        )
        OR (
          first_improvement_at_ms IS NOT NULL
          AND current_cooldown_anchor_at_ms IS NOT NULL
          AND improvement_committed_at_ms IS NOT NULL
          AND first_improvement_at_ms <=
            improvement_committed_at_ms
          AND current_cooldown_anchor_at_ms <=
            improvement_committed_at_ms
        )
      )
    )
  ),
  CHECK (
    (
      status = 'active'
      AND removed_by_user_id IS NULL
      AND removed_by_membership_id IS NULL
      AND removed_authority IS NULL
      AND removal_reason IS NULL
      AND removed_at_ms IS NULL
    )
    OR (
      status = 'removed'
      AND active_improvement_bid_id IS NULL
      AND removed_by_user_id IS NOT NULL
      AND removed_by_membership_id IS NOT NULL
      AND removed_authority IS NOT NULL
      AND removed_at_ms IS NOT NULL
      AND updated_at_ms = removed_at_ms
    )
  )
) STRICT;

CREATE TABLE free_agent_draft_nomination_queue (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_rollover_id TEXT NOT NULL,
  target_opening_rollover_id TEXT NOT NULL,
  resolution_rollover_id TEXT,
  opening_total_value_cents INTEGER NOT NULL
    CHECK (opening_total_value_cents > 0),
  opening_term_years INTEGER NOT NULL
    CHECK (opening_term_years BETWEEN 1 AND 3),
  opening_aav_cents INTEGER NOT NULL
    CHECK (opening_aav_cents >= 100),
  binding_illegality_confirmed INTEGER NOT NULL
    CHECK (binding_illegality_confirmed = 1),
  binding_confirmed_at_ms INTEGER NOT NULL
    CHECK (binding_confirmed_at_ms >= 0),
  submitted_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  submitted_by_membership_id TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
  candidate_card_version_observed INTEGER NOT NULL
    CHECK (candidate_card_version_observed >= 1),
  team_version_observed INTEGER NOT NULL CHECK (team_version_observed >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued', 'opened', 'invalid')),
  opened_auction_id TEXT,
  opened_starter_bid_id TEXT,
  opened_at_ms INTEGER
    CHECK (opened_at_ms IS NULL OR opened_at_ms >= accepted_at_ms),
  terminal_at_ms INTEGER
    CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= accepted_at_ms),
  validation_code TEXT
    CHECK (
      validation_code IS NULL
      OR (
        validation_code = trim(validation_code)
        AND length(validation_code) BETWEEN 1 AND 100
        AND validation_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms = accepted_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), acceptance_idempotency_request_id TEXT
    REFERENCES idempotency_requests(id) ON DELETE RESTRICT
    CHECK (
      acceptance_idempotency_request_id IS NULL
      OR (
        length(acceptance_idempotency_request_id) = 36
        AND acceptance_idempotency_request_id =
          lower(acceptance_idempotency_request_id)
      )
    ),
  UNIQUE (league_id, id),
  UNIQUE (league_id, opened_auction_id),
  UNIQUE (league_id, opened_starter_bid_id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, source_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, target_opening_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, resolution_rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, submitted_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, opened_auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, opened_starter_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  CHECK (
    opening_aav_cents =
      (opening_total_value_cents / opening_term_years)
      + CASE
          WHEN
            (opening_total_value_cents % opening_term_years) * 2
              >= opening_term_years
          THEN 1
          ELSE 0
        END
    AND (
      (
        opening_aav_cents % 25 = 0
        AND opening_total_value_cents =
          opening_aav_cents * opening_term_years
      )
      OR (
        opening_total_value_cents >= opening_term_years * 100
        AND (
          opening_term_years = 1
          OR opening_total_value_cents % 100 = 0
        )
      )
    )
  ),

  CHECK (
    binding_confirmed_at_ms = accepted_at_ms
    AND source_rollover_id = target_opening_rollover_id
  ),
  CHECK (
    (
      status = 'queued'
      AND resolution_rollover_id IS NULL
      AND opened_auction_id IS NULL
      AND opened_starter_bid_id IS NULL
      AND opened_at_ms IS NULL
      AND terminal_at_ms IS NULL
      AND validation_code IS NULL
    )
    OR (
      status = 'opened'
      AND resolution_rollover_id IS NOT NULL
      AND target_opening_rollover_id <> resolution_rollover_id
      AND opened_auction_id IS NOT NULL
      AND opened_starter_bid_id IS NOT NULL
      AND opened_at_ms IS NOT NULL
      AND terminal_at_ms IS NOT NULL
      AND validation_code IS NULL
    )
    OR (
      status = 'invalid'
      AND resolution_rollover_id IS NULL
      AND opened_auction_id IS NULL
      AND opened_starter_bid_id IS NULL
      AND opened_at_ms IS NULL
      AND terminal_at_ms IS NOT NULL
      AND validation_code IS NOT NULL
    )
  )
) STRICT;

INSERT INTO candidate_card_entries
SELECT * FROM migration_0051_candidate_card_entries;

INSERT INTO candidate_card_snapshot_entries
SELECT * FROM migration_0051_candidate_card_snapshot_entries;

INSERT INTO free_agent_draft_auction_participants
SELECT * FROM migration_0051_free_agent_draft_auction_participants;

INSERT INTO free_agent_draft_nomination_queue
SELECT * FROM migration_0051_free_agent_draft_nomination_queue;

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

CREATE INDEX free_agent_draft_participants_auction_status
  ON free_agent_draft_auction_participants (
    league_id,
    auction_id,
    status
  );

CREATE UNIQUE INDEX free_agent_draft_participants_one_active_bid
  ON free_agent_draft_auction_participants (
    league_id,
    active_improvement_bid_id
  )
  WHERE active_improvement_bid_id IS NOT NULL;

CREATE TRIGGER free_agent_draft_auction_participants_forward_update
BEFORE UPDATE ON free_agent_draft_auction_participants
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.source_snapshot_entry_id IS OLD.source_snapshot_entry_id
    AND NEW.originating_candidate_revision_id IS
      OLD.originating_candidate_revision_id
    AND NEW.minimum_total_value_cents IS
      OLD.minimum_total_value_cents
    AND NEW.minimum_term_years IS OLD.minimum_term_years
    AND NEW.minimum_aav_cents IS OLD.minimum_aav_cents
    AND NEW.manager_edit_limit IS OLD.manager_edit_limit
    AND NEW.cooldown_duration_ms IS OLD.cooldown_duration_ms
    AND NEW.originating_actor_user_id IS
      OLD.originating_actor_user_id
    AND NEW.originating_actor_membership_id IS
      OLD.originating_actor_membership_id
    AND NEW.originating_actor_authority IS
      OLD.originating_actor_authority
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'active'
        AND NEW.status = 'active'
        AND NEW.removed_by_user_id IS NULL
        AND NEW.removed_by_membership_id IS NULL
        AND NEW.removed_authority IS NULL
        AND NEW.removal_reason IS NULL
        AND NEW.removed_at_ms IS NULL
        AND NEW.active_improvement_bid_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = NEW.league_id
            AND auction_bids.season_id = NEW.season_id
            AND auction_bids.id =
              NEW.active_improvement_bid_id
            AND auction_bids.auction_id = NEW.auction_id
            AND auction_bids.team_id = NEW.team_id
            AND auction_bids.status = 'active'
            AND (
              auction_bids.total_value_cents >
                NEW.minimum_total_value_cents
              OR (
                auction_bids.total_value_cents =
                  NEW.minimum_total_value_cents
                AND (
                  (auction_bids.total_value_cents /
                    auction_bids.term_years)
                    + CASE
                        WHEN
                          (auction_bids.total_value_cents %
                            auction_bids.term_years) * 2
                              >= auction_bids.term_years
                        THEN 1
                        ELSE 0
                      END
                ) > NEW.minimum_aav_cents
              )
            )
            AND NEW.current_cooldown_anchor_at_ms =
              auction_bids.last_edited_at_ms
            AND NEW.improvement_committed_at_ms =
              auction_bids.last_edited_at_ms
            AND (
              (
                OLD.active_improvement_bid_id IS NULL
                AND NEW.first_improvement_at_ms =
                  auction_bids.first_submitted_at_ms
                AND auction_bids.edit_count = 0
              )
              OR (
                OLD.active_improvement_bid_id =
                  NEW.active_improvement_bid_id
                AND NEW.first_improvement_at_ms =
                  OLD.first_improvement_at_ms
              )
            )
        )
      )
      OR (
        OLD.status = 'active'
        AND NEW.status = 'removed'
        AND NEW.active_improvement_bid_id IS NULL
        AND NEW.first_improvement_at_ms IS
          OLD.first_improvement_at_ms
        AND NEW.current_cooldown_anchor_at_ms IS
          OLD.current_cooldown_anchor_at_ms
        AND NEW.improvement_committed_at_ms IS
          OLD.improvement_committed_at_ms
        AND NEW.removed_by_user_id IS NOT NULL
        AND NEW.removed_by_membership_id IS NOT NULL
        AND NEW.removed_authority IS NOT NULL
        AND NEW.removed_at_ms = NEW.updated_at_ms
        AND OLD.active_improvement_bid_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM auction_events
          JOIN auctions
            ON auctions.league_id = auction_events.league_id
           AND auctions.season_id = auction_events.season_id
           AND auctions.id = auction_events.auction_id
          JOIN auction_contexts
            ON auction_contexts.league_id =
                auction_events.league_id
           AND auction_contexts.season_id =
                auction_events.season_id
           AND auction_contexts.auction_id =
                auction_events.auction_id
          JOIN free_agent_draft_player_allocations
            ON free_agent_draft_player_allocations.league_id =
                auction_contexts.league_id
           AND free_agent_draft_player_allocations.season_id =
                auction_contexts.season_id
           AND free_agent_draft_player_allocations.fad_id =
                auction_contexts.fad_id
           AND free_agent_draft_player_allocations.id =
                auction_contexts.fad_allocation_id
          JOIN auction_bids
            ON auction_bids.league_id = auction_events.league_id
           AND auction_bids.season_id = auction_events.season_id
           AND auction_bids.id = auction_events.bid_id
           AND auction_bids.auction_id =
                auction_events.auction_id
           AND auction_bids.team_id = auction_events.team_id
          JOIN league_memberships
            ON league_memberships.league_id =
                auction_events.league_id
           AND league_memberships.id =
                NEW.removed_by_membership_id
           AND league_memberships.user_id =
                auction_events.actor_user_id
          WHERE auction_events.league_id = NEW.league_id
            AND auction_events.season_id = NEW.season_id
            AND auction_events.auction_id = NEW.auction_id
            AND auction_events.bid_id =
              OLD.active_improvement_bid_id
            AND auction_events.team_id = NEW.team_id
            AND auction_events.actor_user_id =
              NEW.removed_by_user_id
            AND auction_events.event_type =
              'commissioner_bid_removed'
            AND auction_events.occurred_at_ms =
              NEW.removed_at_ms
            AND json_valid(auction_events.metadata_json) = 1
            AND json_extract(
              auction_events.metadata_json,
              '$.actorMembershipId'
            ) = NEW.removed_by_membership_id
            AND json_extract(
              auction_events.metadata_json,
              '$.actorAuthority'
            ) = NEW.removed_authority
            AND auction_contexts.source_kind = 'fad_restricted'
            AND auction_contexts.fad_id = NEW.fad_id
            AND auction_contexts.fad_allocation_id =
              NEW.allocation_id
            AND auctions.status = 'open'
            AND NEW.removed_at_ms >= auctions.opened_at_ms
            AND NEW.removed_at_ms < auctions.resolves_at_ms
            AND free_agent_draft_player_allocations.status =
              'restricted_active'
            AND free_agent_draft_player_allocations
              .restricted_auction_id = NEW.auction_id
            AND auction_bids.status = 'withdrawn'
            AND league_memberships.status = 'active'
            AND (
              (
                NEW.removed_authority = 'commissioner'
                AND EXISTS (
                  SELECT 1
                  FROM leagues
                  WHERE leagues.id = NEW.league_id
                    AND leagues.commissioner_membership_id =
                      NEW.removed_by_membership_id
                )
              )
              OR (
                NEW.removed_authority =
                  'platform_administrator_as_commissioner'
                AND EXISTS (
                  SELECT 1
                  FROM platform_roles
                  WHERE platform_roles.user_id =
                      NEW.removed_by_user_id
                    AND platform_roles.role =
                      'platform_administrator'
                    AND platform_roles.status = 'active'
                )
              )
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'restricted participant requires a current strict improvement or permanent removal'
  ) END;
END;

CREATE TRIGGER free_agent_draft_auction_participants_immutable_delete
BEFORE DELETE ON free_agent_draft_auction_participants
BEGIN
  SELECT RAISE(ABORT, 'restricted participant evidence is immutable');
END;

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

CREATE UNIQUE INDEX free_agent_draft_nomination_queue_acceptance_request
  ON free_agent_draft_nomination_queue (
    league_id,
    acceptance_idempotency_request_id
  )
  WHERE acceptance_idempotency_request_id IS NOT NULL;

CREATE UNIQUE INDEX free_agent_draft_nomination_queue_one_queued_player
  ON free_agent_draft_nomination_queue (
    league_id,
    season_id,
    player_id
  )
  WHERE status = 'queued';

CREATE INDEX free_agent_draft_nomination_queue_opening_boundary
  ON free_agent_draft_nomination_queue (
    league_id,
    target_opening_rollover_id,
    status
  );

CREATE TRIGGER free_agent_draft_nomination_queue_complete_acceptance_request
AFTER INSERT ON free_agent_draft_nomination_queue
BEGIN
  UPDATE idempotency_requests
  SET status = 'completed',
      result_type = 'fad_nomination_queue',
      result_id = NEW.id,
      completed_at_ms = NEW.accepted_at_ms
  WHERE league_id = NEW.league_id
    AND id = NEW.acceptance_idempotency_request_id
    AND actor_user_id = NEW.submitted_by_user_id
    AND operation = 'auction.start'
    AND status = 'started'
    AND result_type IS NULL
    AND result_id IS NULL
    AND created_at_ms = NEW.accepted_at_ms
    AND completed_at_ms IS NULL
    AND expires_at_ms > NEW.accepted_at_ms;

  SELECT CASE WHEN changes() <> 1 THEN RAISE(
    ABORT,
    'queued nomination must complete its exact acceptance request'
  ) END;
END;

CREATE TRIGGER free_agent_draft_nomination_queue_forward_update
BEFORE UPDATE ON free_agent_draft_nomination_queue
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'queued'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.source_rollover_id IS OLD.source_rollover_id
    AND NEW.target_opening_rollover_id IS
      OLD.target_opening_rollover_id
    AND NEW.opening_total_value_cents IS
      OLD.opening_total_value_cents
    AND NEW.opening_term_years IS OLD.opening_term_years
    AND NEW.opening_aav_cents IS OLD.opening_aav_cents
    AND NEW.binding_illegality_confirmed IS
      OLD.binding_illegality_confirmed
    AND NEW.binding_confirmed_at_ms IS
      OLD.binding_confirmed_at_ms
    AND NEW.submitted_by_user_id IS OLD.submitted_by_user_id
    AND NEW.submitted_by_membership_id IS
      OLD.submitted_by_membership_id
    AND NEW.accepted_at_ms IS OLD.accepted_at_ms
    AND NEW.candidate_card_version_observed IS
      OLD.candidate_card_version_observed
    AND NEW.team_version_observed IS OLD.team_version_observed
    AND NEW.acceptance_idempotency_request_id IS
      OLD.acceptance_idempotency_request_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_rollovers AS opening_rollover
      JOIN job_runs AS activation_job
        ON activation_job.league_id = OLD.league_id
       AND activation_job.season_id = OLD.season_id
      WHERE opening_rollover.league_id = OLD.league_id
        AND opening_rollover.season_id = OLD.season_id
        AND opening_rollover.fad_id = OLD.fad_id
        AND opening_rollover.id =
          OLD.target_opening_rollover_id
        AND opening_rollover.rolls_over_at_ms <=
          NEW.updated_at_ms
        AND activation_job.job_type =
          'fad_queued_nomination_activation'
        AND activation_job.occurrence_key =
          'fad:' || OLD.fad_id || ':nomination-open:' ||
            OLD.id || ':' || opening_rollover.rolls_over_at_ms
        AND activation_job.scheduled_for_ms =
          opening_rollover.rolls_over_at_ms
        AND activation_job.status = 'running'
        AND activation_job.attempt_count >= 1
        AND activation_job.lease_owner IS NOT NULL
        AND activation_job.lease_token IS NOT NULL
        AND activation_job.started_at_ms >=
          opening_rollover.rolls_over_at_ms
        AND activation_job.started_at_ms <=
          NEW.updated_at_ms
        AND activation_job.updated_at_ms =
          activation_job.started_at_ms
        AND activation_job.lease_expires_at_ms >
          NEW.updated_at_ms
        AND activation_job.completed_at_ms IS NULL
        AND activation_job.result_json IS NULL
        AND activation_job.last_error_code IS NULL
        AND activation_job.next_attempt_at_ms IS NULL
        AND activation_job.created_at_ms =
          OLD.accepted_at_ms
    )
    AND (
      (
        NEW.status = 'invalid'
        AND NEW.resolution_rollover_id IS NULL
        AND NEW.opened_auction_id IS NULL
        AND NEW.opened_starter_bid_id IS NULL
        AND NEW.opened_at_ms IS NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.validation_code = 'PLAYER_UNAVAILABLE'
      )
      OR (
        NEW.status = 'opened'
        AND NEW.resolution_rollover_id IS NOT NULL
        AND NEW.opened_at_ms IS NOT NULL
        AND NEW.terminal_at_ms = NEW.updated_at_ms
        AND NEW.updated_at_ms >= NEW.opened_at_ms
        AND NEW.validation_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers AS opening_rollover
          JOIN free_agent_draft_rollovers AS resolution_rollover
            ON resolution_rollover.league_id =
                opening_rollover.league_id
           AND resolution_rollover.season_id =
                opening_rollover.season_id
           AND resolution_rollover.fad_id =
                opening_rollover.fad_id
          JOIN auctions AS auction
            ON auction.league_id = NEW.league_id
           AND auction.season_id = NEW.season_id
           AND auction.id = NEW.opened_auction_id
          JOIN auction_contexts AS context
            ON context.league_id = auction.league_id
           AND context.season_id = auction.season_id
           AND context.auction_id = auction.id
          JOIN auction_bids AS starter
            ON starter.league_id = auction.league_id
           AND starter.season_id = auction.season_id
           AND starter.id = NEW.opened_starter_bid_id
           AND starter.auction_id = auction.id
          JOIN auction_events AS started_event
            ON started_event.league_id = starter.league_id
           AND started_event.season_id = starter.season_id
           AND started_event.auction_id = starter.auction_id
           AND started_event.bid_id = starter.id
           AND started_event.team_id = starter.team_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.auction_id = context.auction_id
          JOIN idempotency_requests AS request
            ON request.league_id = NEW.league_id
           AND request.id =
                NEW.acceptance_idempotency_request_id
          JOIN job_runs AS resolution_job
            ON resolution_job.league_id = auction.league_id
           AND resolution_job.season_id = auction.season_id
           AND resolution_job.job_type =
                'auction.resolve.target'
           AND resolution_job.occurrence_key =
                'auction:' || auction.id || ':' ||
                  auction.resolves_at_ms
          WHERE opening_rollover.league_id = NEW.league_id
            AND opening_rollover.season_id = NEW.season_id
            AND opening_rollover.fad_id = NEW.fad_id
            AND opening_rollover.id =
              NEW.target_opening_rollover_id
            AND opening_rollover.rolls_over_at_ms =
              NEW.opened_at_ms
            AND resolution_rollover.id =
              NEW.resolution_rollover_id
            AND resolution_rollover.sequence =
              opening_rollover.sequence + 1
            AND resolution_rollover.predecessor_rollover_id =
              opening_rollover.id
            AND resolution_rollover.opens_at_ms =
              opening_rollover.rolls_over_at_ms
            AND resolution_rollover.creation_cutoff_at_ms =
              resolution_rollover.rolls_over_at_ms - 3600000
            AND resolution_rollover.rolls_over_at_ms =
              opening_rollover.rolls_over_at_ms + 86400000
            AND resolution_rollover.status = 'scheduled'
            AND auction.player_id = NEW.player_id
            AND auction.status = 'open'
            AND auction.opened_at_ms = NEW.opened_at_ms
            AND auction.resolves_at_ms =
              resolution_rollover.rolls_over_at_ms
            AND auction.opened_by_user_id =
              NEW.submitted_by_user_id
            AND auction.created_at_ms = NEW.opened_at_ms
            AND auction.updated_at_ms = NEW.opened_at_ms
            AND auction.version = 1
            AND context.id = auction.id
            AND context.source_kind = 'fad_open_rapid'
            AND context.fad_id = NEW.fad_id
            AND context.fad_rollover_id =
              NEW.resolution_rollover_id
            AND context.fad_allocation_id IS NULL
            AND context.fad_origin = 'queued_nomination'
            AND context.created_at_ms = NEW.opened_at_ms
            AND starter.team_id = NEW.team_id
            AND starter.submitted_by_user_id =
              NEW.submitted_by_user_id
            AND starter.total_value_cents =
              NEW.opening_total_value_cents
            AND starter.term_years =
              NEW.opening_term_years
            AND starter.lowest_offered_aav_cents =
              NEW.opening_aav_cents
            AND starter.first_submitted_at_ms =
              NEW.accepted_at_ms
            AND starter.last_edited_at_ms =
              NEW.accepted_at_ms
            AND starter.edit_count = 0
            AND starter.status = 'active'
            AND starter.idempotency_request_id =
              NEW.acceptance_idempotency_request_id
            AND starter.version = 1
            AND started_event.actor_user_id =
              NEW.submitted_by_user_id
            AND started_event.event_type = 'auction_started'
            AND started_event.occurred_at_ms = NEW.opened_at_ms
            AND json_valid(started_event.metadata_json) = 1
            AND json_type(started_event.metadata_json) = 'object'
            AND (
              SELECT COUNT(*)
              FROM json_each(started_event.metadata_json)
            ) = 12
            AND json_extract(
                  started_event.metadata_json,
                  '$.openingTeamId'
                ) = NEW.team_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.actorMembershipId'
                ) = NEW.submitted_by_membership_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.actorAuthority'
                ) = 'manager'
            AND json_type(
                  started_event.metadata_json,
                  '$.bindingIllegalityConfirmed'
                ) = 'true'
            AND json_extract(
                  started_event.metadata_json,
                  '$.bindingIllegalityConfirmed'
                ) = 1
            AND json_extract(
                  started_event.metadata_json,
                  '$.playerPosition'
                ) IN ('F', 'D')
            AND json_extract(
                  started_event.metadata_json,
                  '$.creationCutoffAtMs'
                ) = opening_rollover.creation_cutoff_at_ms
            AND json_extract(
                  started_event.metadata_json,
                  '$.bidClosesAtMs'
                ) = auction.resolves_at_ms
            AND json_extract(
                  started_event.metadata_json,
                  '$.totalValueCents'
                ) = NEW.opening_total_value_cents
            AND json_extract(
                  started_event.metadata_json,
                  '$.termYears'
                ) = NEW.opening_term_years
            AND json_extract(
                  started_event.metadata_json,
                  '$.aavCents'
                ) = NEW.opening_aav_cents
            AND json_extract(
                  started_event.metadata_json,
                  '$.fadId'
                ) = NEW.fad_id
            AND json_extract(
                  started_event.metadata_json,
                  '$.fadRolloverId'
                ) = NEW.resolution_rollover_id
            AND draw.allocation_id IS NULL
            AND draw.algorithm_version = 1
            AND length(draw.nonce_bytes) = 32
            AND length(draw.commitment_hex) = 64
            AND draw.commitment_hex =
              lower(draw.commitment_hex)
            AND draw.commitment_hex NOT GLOB
              '*[^0-9a-f]*'
            AND draw.ordered_tied_bid_ids_json IS NULL
            AND draw.ordered_tied_team_ids_json IS NULL
            AND draw.rejection_counter IS NULL
            AND draw.selected_index IS NULL
            AND draw.selected_bid_id IS NULL
            AND draw.selected_team_id IS NULL
            AND draw.selected_digest_hex IS NULL
            AND draw.revealed_at_ms IS NULL
            AND draw.created_at_ms = NEW.opened_at_ms
            AND draw.updated_at_ms = NEW.opened_at_ms
            AND draw.version = 1
            AND request.actor_user_id =
              NEW.submitted_by_user_id
            AND request.operation = 'auction.start'
            AND request.status = 'completed'
            AND request.result_type =
              'fad_nomination_queue'
            AND request.result_id = NEW.id
            AND request.created_at_ms =
              NEW.accepted_at_ms
            AND request.completed_at_ms =
              NEW.accepted_at_ms
            AND request.expires_at_ms >
              NEW.accepted_at_ms
            AND resolution_job.scheduled_for_ms =
              auction.resolves_at_ms
            AND resolution_job.status = 'pending'
            AND resolution_job.attempt_count = 0
            AND resolution_job.lease_owner IS NULL
            AND resolution_job.lease_token IS NULL
            AND resolution_job.lease_expires_at_ms IS NULL
            AND resolution_job.started_at_ms IS NULL
            AND resolution_job.completed_at_ms IS NULL
            AND resolution_job.result_json IS NULL
            AND resolution_job.last_error_code IS NULL
            AND resolution_job.next_attempt_at_ms IS NULL
            AND resolution_job.created_at_ms =
              NEW.updated_at_ms
            AND resolution_job.updated_at_ms =
              NEW.updated_at_ms
            AND resolution_job.version = 1
            AND (
              SELECT COUNT(*)
              FROM auction_bids AS exact_starter
              WHERE exact_starter.league_id = auction.league_id
                AND exact_starter.auction_id = auction.id
            ) = 1
            AND (
              SELECT COUNT(*)
              FROM auction_events AS exact_started_event
              WHERE exact_started_event.league_id =
                  auction.league_id
                AND exact_started_event.auction_id = auction.id
                AND exact_started_event.event_type =
                  'auction_started'
            ) = 1
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'queued nomination may only open or invalidate under its exact live activation'
  ) END;
END;

CREATE TRIGGER free_agent_draft_nomination_queue_immutable_delete
BEFORE DELETE ON free_agent_draft_nomination_queue
BEGIN
  SELECT RAISE(ABORT, 'private nomination queue evidence is immutable');
END;

CREATE TRIGGER free_agent_draft_nomination_queue_valid_insert
BEFORE INSERT ON free_agent_draft_nomination_queue
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'queued'
    AND NEW.resolution_rollover_id IS NULL
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.accepted_at_ms
    AND NEW.acceptance_idempotency_request_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests
      WHERE idempotency_requests.league_id = NEW.league_id
        AND idempotency_requests.id =
          NEW.acceptance_idempotency_request_id
        AND idempotency_requests.actor_user_id =
          NEW.submitted_by_user_id
        AND idempotency_requests.operation = 'auction.start'
        AND idempotency_requests.status = 'started'
        AND idempotency_requests.result_type IS NULL
        AND idempotency_requests.result_id IS NULL
        AND idempotency_requests.created_at_ms = NEW.accepted_at_ms
        AND idempotency_requests.completed_at_ms IS NULL
        AND idempotency_requests.expires_at_ms > NEW.accepted_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status = 'rapid'
    )
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_rollovers
      WHERE free_agent_draft_rollovers.league_id = NEW.league_id
        AND free_agent_draft_rollovers.season_id = NEW.season_id
        AND free_agent_draft_rollovers.fad_id = NEW.fad_id
        AND free_agent_draft_rollovers.id =
          NEW.source_rollover_id
        AND free_agent_draft_rollovers.id =
          NEW.target_opening_rollover_id
        AND free_agent_draft_rollovers.status IN (
          'scheduled',
          'processing'
        )
        AND NEW.accepted_at_ms >=
          free_agent_draft_rollovers.creation_cutoff_at_ms
        AND NEW.accepted_at_ms <
          free_agent_draft_rollovers.rolls_over_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM teams
      WHERE teams.league_id = NEW.league_id
        AND teams.id = NEW.team_id
        AND teams.status = 'active'
        AND teams.version = NEW.team_version_observed
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_cards
      WHERE candidate_cards.league_id = NEW.league_id
        AND candidate_cards.season_id = NEW.season_id
        AND candidate_cards.fad_id = NEW.fad_id
        AND candidate_cards.team_id = NEW.team_id
        AND candidate_cards.version =
          NEW.candidate_card_version_observed
    )
    AND EXISTS (
      SELECT 1
      FROM team_manager_assignments
      JOIN league_memberships
        ON league_memberships.league_id =
            team_manager_assignments.league_id
       AND league_memberships.id =
            team_manager_assignments.membership_id
      WHERE team_manager_assignments.league_id = NEW.league_id
        AND team_manager_assignments.team_id = NEW.team_id
        AND team_manager_assignments.membership_id =
          NEW.submitted_by_membership_id
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.ended_at_ms IS NULL
        AND league_memberships.user_id =
          NEW.submitted_by_user_id
        AND league_memberships.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM player_ownerships
      WHERE player_ownerships.league_id = NEW.league_id
        AND player_ownerships.season_id = NEW.season_id
        AND player_ownerships.player_id = NEW.player_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.player_id = NEW.player_id
        AND auctions.status IN ('open', 'resolving')
    )
  ) THEN RAISE(
    ABORT,
    'final-hour nomination must privately bind the active opening boundary'
  ) END;
END;

-- Existing bids retain their submitted total as the historical low-water mark.
ALTER TABLE auction_bids
  ADD COLUMN lowest_offered_total_value_cents INTEGER
  CHECK (
    lowest_offered_total_value_cents IS NULL
    OR lowest_offered_total_value_cents > 0
  );

UPDATE auction_bids
SET lowest_offered_total_value_cents = total_value_cents;

CREATE TRIGGER auction_bids_lowest_total_insert
BEFORE INSERT ON auction_bids
WHEN NOT (
  NEW.lowest_offered_total_value_cents IS NOT NULL
  AND NEW.lowest_offered_total_value_cents = NEW.total_value_cents
)
BEGIN
  SELECT RAISE(ABORT, 'auction bid lowest total is invalid');
END;

CREATE TRIGGER auction_bids_lowest_total_update
BEFORE UPDATE ON auction_bids
WHEN NOT (
  NEW.lowest_offered_total_value_cents IS NOT NULL
  AND NEW.lowest_offered_total_value_cents > 0
  AND NEW.lowest_offered_total_value_cents <= NEW.total_value_cents
  AND (
    (
      NEW.status = 'active'
      AND NEW.lowest_offered_total_value_cents = MIN(
        OLD.lowest_offered_total_value_cents,
        NEW.total_value_cents
      )
    )
    OR (
      NEW.status <> 'active'
      AND NEW.lowest_offered_total_value_cents IS
        OLD.lowest_offered_total_value_cents
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'auction bid lowest total history is invalid');
END;

DROP TRIGGER free_agent_draft_draws_reveal_update;
CREATE TRIGGER free_agent_draft_draws_reveal_update
BEFORE UPDATE ON free_agent_draft_draws
BEGIN
  SELECT CASE WHEN NOT (
    OLD.revealed_at_ms IS NULL
    AND OLD.version = 1
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.algorithm_version IS OLD.algorithm_version
    AND NEW.nonce_bytes IS OLD.nonce_bytes
    AND NEW.commitment_hex IS OLD.commitment_hex
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.revealed_at_ms IS NOT NULL
    AND NEW.updated_at_ms = NEW.revealed_at_ms
    AND NEW.version = 2
    AND json(NEW.ordered_tied_bid_ids_json) =
      NEW.ordered_tied_bid_ids_json
    AND json(NEW.ordered_tied_team_ids_json) =
      NEW.ordered_tied_team_ids_json
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.ordered_tied_bid_ids_json)
      GROUP BY value
      HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.ordered_tied_team_ids_json)
      GROUP BY value
      HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.ordered_tied_bid_ids_json) AS current_bid
      JOIN json_each(NEW.ordered_tied_bid_ids_json) AS next_bid
        ON next_bid.key = current_bid.key + 1
      WHERE current_bid.value >= next_bid.value
    )
    AND EXISTS (
      SELECT 1
      FROM auctions
      JOIN auction_resolutions
        ON auction_resolutions.league_id = auctions.league_id
       AND auction_resolutions.auction_id = auctions.id
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.auction_id
        AND auctions.status IN (
          'resolving',
          'resolved',
          'no_winner',
          'cancelled'
        )
        AND auction_resolutions.resolved_at_ms =
          NEW.revealed_at_ms
        AND (
          (
            json_array_length(NEW.ordered_tied_bid_ids_json) = 0
            AND NEW.selected_bid_id IS NULL
            AND NEW.selected_team_id IS NULL
            AND NEW.selected_index IS NULL
            AND NEW.rejection_counter IS NULL
            AND NEW.selected_digest_hex IS NULL
          )
          OR (
            json_array_length(NEW.ordered_tied_bid_ids_json) >= 2
            AND auction_resolutions.winning_bid_id =
              NEW.selected_bid_id
            AND auction_resolutions.winning_team_id =
              NEW.selected_team_id
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.ordered_tied_bid_ids_json) AS bid_item
      JOIN json_each(NEW.ordered_tied_team_ids_json) AS team_item
        ON team_item.key = bid_item.key
      WHERE NOT EXISTS (
        SELECT 1
        FROM auction_bids
        WHERE auction_bids.league_id = NEW.league_id
          AND auction_bids.auction_id = NEW.auction_id
          AND auction_bids.id = bid_item.value
          AND auction_bids.team_id = team_item.value
          AND auction_bids.status IN ('won', 'lost')
      )
    )
    AND (
      (
        (
          SELECT COUNT(*)
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
        ) < 2
        AND NEW.ordered_tied_bid_ids_json = '[]'
        AND NEW.ordered_tied_team_ids_json = '[]'
      )
      OR (
        (
          SELECT COUNT(*)
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
        ) >= 2
        AND json_array_length(
          NEW.ordered_tied_bid_ids_json
        ) = (
          SELECT COUNT(*)
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            NEW.ordered_tied_bid_ids_json
          ) AS supplied_bid
          JOIN json_each(
            NEW.ordered_tied_team_ids_json
          ) AS supplied_team
            ON supplied_team.key = supplied_bid.key
          WHERE NOT EXISTS (
            SELECT 1
            FROM fad_frozen_eligible_bids AS top_bid
            WHERE top_bid.league_id = NEW.league_id
              AND top_bid.auction_id = NEW.auction_id
              AND top_bid.bid_id = supplied_bid.value
              AND top_bid.team_id = supplied_team.value
              AND top_bid.total_value_cents = (
                SELECT MAX(candidate.total_value_cents)
                FROM fad_frozen_eligible_bids AS candidate
                WHERE candidate.league_id = NEW.league_id
                  AND candidate.auction_id = NEW.auction_id
              )
              AND top_bid.aav_cents = (
                SELECT MAX(candidate.aav_cents)
                FROM fad_frozen_eligible_bids AS candidate
                WHERE candidate.league_id = NEW.league_id
                  AND candidate.auction_id = NEW.auction_id
                  AND candidate.total_value_cents = (
                    SELECT MAX(ranked.total_value_cents)
                    FROM fad_frozen_eligible_bids AS ranked
                    WHERE ranked.league_id = NEW.league_id
                      AND ranked.auction_id = NEW.auction_id
                  )
              )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM fad_frozen_eligible_bids AS top_bid
          WHERE top_bid.league_id = NEW.league_id
            AND top_bid.auction_id = NEW.auction_id
            AND top_bid.total_value_cents = (
              SELECT MAX(candidate.total_value_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
            AND top_bid.aav_cents = (
              SELECT MAX(candidate.aav_cents)
              FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
                AND candidate.total_value_cents = (
                  SELECT MAX(ranked.total_value_cents)
                  FROM fad_frozen_eligible_bids AS ranked
                  WHERE ranked.league_id = NEW.league_id
                    AND ranked.auction_id = NEW.auction_id
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(
                NEW.ordered_tied_bid_ids_json
              ) AS supplied_bid
              JOIN json_each(
                NEW.ordered_tied_team_ids_json
              ) AS supplied_team
                ON supplied_team.key = supplied_bid.key
              WHERE supplied_bid.value = top_bid.bid_id
                AND supplied_team.value = top_bid.team_id
            )
        )
      )
    )
    AND (
      NEW.selected_index IS NULL
      OR (
        json_extract(
          NEW.ordered_tied_bid_ids_json,
          '$[' || NEW.selected_index || ']'
        ) = NEW.selected_bid_id
        AND json_extract(
          NEW.ordered_tied_team_ids_json,
          '$[' || NEW.selected_index || ']'
        ) = NEW.selected_team_id
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD draw reveal must prove the terminal no-selection or exact-tie result'
  ) END;
END;

DROP TRIGGER idempotency_requests_fad_open_rapid_start_complete;
CREATE TRIGGER idempotency_requests_fad_open_rapid_start_complete
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation = 'auction.start'
  AND (
    (
      NEW.result_type = 'auction'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.auction_id = NEW.result_id
          AND auction_contexts.source_kind = 'fad_open_rapid'
          AND auction_contexts.fad_origin = 'manager_nomination'
          AND auction_contexts.fad_allocation_id IS NULL
      )
    )
    OR (
      OLD.result_type = 'auction'
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        WHERE auction_contexts.league_id = OLD.league_id
          AND auction_contexts.auction_id = OLD.result_id
          AND auction_contexts.source_kind = 'fad_open_rapid'
          AND auction_contexts.fad_origin = 'manager_nomination'
          AND auction_contexts.fad_allocation_id IS NULL
      )
    )
  )
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'started'
    AND OLD.result_type IS NULL
    AND OLD.result_id IS NULL
    AND OLD.completed_at_ms IS NULL
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.status = 'completed'
    AND NEW.result_type = 'auction'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms = OLD.created_at_ms
    AND OLD.expires_at_ms > OLD.created_at_ms
    AND EXISTS (
      SELECT 1
      FROM auctions
      JOIN auction_contexts
        ON auction_contexts.league_id = auctions.league_id
       AND auction_contexts.season_id = auctions.season_id
       AND auction_contexts.auction_id = auctions.id
      JOIN free_agent_draft_rollovers AS rollover
        ON rollover.league_id = auction_contexts.league_id
       AND rollover.season_id = auction_contexts.season_id
       AND rollover.fad_id = auction_contexts.fad_id
       AND rollover.id = auction_contexts.fad_rollover_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = rollover.league_id
       AND fad.season_id = rollover.season_id
       AND fad.id = rollover.fad_id
      JOIN auction_bids AS starter
        ON starter.league_id = auctions.league_id
       AND starter.season_id = auctions.season_id
       AND starter.auction_id = auctions.id
       AND starter.idempotency_request_id = OLD.id
      JOIN auction_events AS started_event
        ON started_event.league_id = starter.league_id
       AND started_event.season_id = starter.season_id
       AND started_event.auction_id = starter.auction_id
       AND started_event.bid_id = starter.id
       AND started_event.team_id = starter.team_id
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = auction_contexts.league_id
       AND draw.season_id = auction_contexts.season_id
       AND draw.fad_id = auction_contexts.fad_id
       AND draw.allocation_id IS NULL
       AND draw.auction_id = auction_contexts.auction_id
      JOIN job_runs AS resolution_job
        ON resolution_job.league_id = auctions.league_id
       AND resolution_job.season_id = auctions.season_id
       AND resolution_job.job_type = 'auction.resolve.target'
       AND resolution_job.occurrence_key =
            'auction:' || auctions.id || ':' ||
              auctions.resolves_at_ms
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.result_id
        AND auctions.status = 'open'
        AND auctions.opened_by_user_id = OLD.actor_user_id
        AND auctions.created_at_ms = OLD.created_at_ms
        AND auctions.opened_at_ms = OLD.created_at_ms
        AND auctions.updated_at_ms = OLD.created_at_ms
        AND auctions.version = 1
        AND auctions.resolves_at_ms =
          rollover.rolls_over_at_ms
        AND auction_contexts.source_kind = 'fad_open_rapid'
        AND auction_contexts.fad_origin =
          'manager_nomination'
        AND auction_contexts.fad_allocation_id IS NULL
        AND auction_contexts.created_at_ms =
          auctions.opened_at_ms
        AND rollover.status IN ('scheduled', 'processing')
        AND auctions.opened_at_ms >= rollover.opens_at_ms
        AND auctions.opened_at_ms <
          rollover.creation_cutoff_at_ms
        AND fad.status = 'rapid'
        AND starter.submitted_by_user_id =
          OLD.actor_user_id
        AND starter.status = 'active'
        AND starter.version = 1
        AND starter.edit_count = 0
        AND starter.first_submitted_at_ms =
          auctions.opened_at_ms
        AND starter.last_edited_at_ms =
          auctions.opened_at_ms
        AND starter.term_years BETWEEN 1 AND 3
        AND starter.total_value_cents >=
          starter.term_years * 100
        AND starter.lowest_offered_aav_cents >= 100
        AND starter.lowest_offered_aav_cents % 25 = 0
        AND starter.total_value_cents =
          starter.lowest_offered_aav_cents * starter.term_years
        AND starter.lowest_offered_total_value_cents =
          starter.total_value_cents
        AND starter.lowest_offered_aav_cents =
          (starter.total_value_cents / starter.term_years)
          + CASE
              WHEN (
                starter.total_value_cents %
                  starter.term_years
              ) * 2 >= starter.term_years
              THEN 1
              ELSE 0
            END
        AND started_event.actor_user_id =
          OLD.actor_user_id
        AND started_event.event_type = 'auction_started'
        AND started_event.occurred_at_ms =
          auctions.opened_at_ms
        AND json_valid(started_event.metadata_json) = 1
        AND json_type(started_event.metadata_json) =
          'object'
        AND (
          SELECT COUNT(*)
          FROM json_each(started_event.metadata_json)
        ) = 12
        AND json_type(
          started_event.metadata_json,
          '$.actorMembershipId'
        ) = 'text'
        AND json_type(
          started_event.metadata_json,
          '$.actorAuthority'
        ) = 'text'
        AND json_extract(
          started_event.metadata_json,
          '$.actorAuthority'
        ) IN ('manager', 'commissioner')
        AND json_type(
          started_event.metadata_json,
          '$.bindingIllegalityConfirmed'
        ) = 'true'
        AND json_extract(
          started_event.metadata_json,
          '$.bindingIllegalityConfirmed'
        ) = 1
        AND json_extract(
          started_event.metadata_json,
          '$.openingTeamId'
        ) = starter.team_id
        AND json_extract(
          started_event.metadata_json,
          '$.fadId'
        ) = auction_contexts.fad_id
        AND json_extract(
          started_event.metadata_json,
          '$.fadRolloverId'
        ) = auction_contexts.fad_rollover_id
        AND json_extract(
          started_event.metadata_json,
          '$.creationCutoffAtMs'
        ) = rollover.creation_cutoff_at_ms
        AND json_extract(
          started_event.metadata_json,
          '$.bidClosesAtMs'
        ) = auctions.resolves_at_ms
        AND json_extract(
          started_event.metadata_json,
          '$.totalValueCents'
        ) = starter.total_value_cents
        AND json_extract(
          started_event.metadata_json,
          '$.termYears'
        ) = starter.term_years
        AND json_extract(
          started_event.metadata_json,
          '$.aavCents'
        ) = starter.lowest_offered_aav_cents
        AND json_type(
          started_event.metadata_json,
          '$.playerPosition'
        ) = 'text'
        AND json_extract(
          started_event.metadata_json,
          '$.playerPosition'
        ) IN ('F', 'D')
        AND (
          (
            json_extract(
              started_event.metadata_json,
              '$.actorAuthority'
            ) = 'manager'
            AND EXISTS (
              SELECT 1
              FROM team_manager_assignments AS assignment
              JOIN league_memberships AS membership
                ON membership.league_id =
                    assignment.league_id
               AND membership.id =
                    assignment.membership_id
               AND membership.user_id =
                    assignment.user_id
              WHERE assignment.league_id =
                  starter.league_id
                AND assignment.team_id =
                  starter.team_id
                AND assignment.user_id =
                  starter.submitted_by_user_id
                AND assignment.membership_id =
                  json_extract(
                    started_event.metadata_json,
                    '$.actorMembershipId'
                  )
                AND assignment.status = 'accepted'
                AND assignment.ended_at_ms IS NULL
                AND membership.status = 'active'
            )
          )
          OR (
            json_extract(
              started_event.metadata_json,
              '$.actorAuthority'
            ) = 'commissioner'
            AND EXISTS (
              SELECT 1
              FROM league_memberships AS membership
              JOIN leagues
                ON leagues.id = membership.league_id
               AND leagues.commissioner_membership_id =
                    membership.id
              WHERE membership.league_id =
                  starter.league_id
                AND membership.id =
                  json_extract(
                    started_event.metadata_json,
                    '$.actorMembershipId'
                  )
                AND membership.user_id =
                  starter.submitted_by_user_id
                AND membership.status = 'active'
            )
          )
        )
        AND draw.algorithm_version = 1
        AND draw.ordered_tied_bid_ids_json IS NULL
        AND draw.ordered_tied_team_ids_json IS NULL
        AND draw.rejection_counter IS NULL
        AND draw.selected_index IS NULL
        AND draw.selected_bid_id IS NULL
        AND draw.selected_team_id IS NULL
        AND draw.selected_digest_hex IS NULL
        AND draw.revealed_at_ms IS NULL
        AND draw.created_at_ms = auctions.opened_at_ms
        AND draw.updated_at_ms = auctions.opened_at_ms
        AND draw.version = 1
        AND resolution_job.scheduled_for_ms =
          auctions.resolves_at_ms
        AND resolution_job.status = 'pending'
        AND resolution_job.attempt_count = 0
        AND resolution_job.lease_owner IS NULL
        AND resolution_job.lease_token IS NULL
        AND resolution_job.lease_expires_at_ms IS NULL
        AND resolution_job.started_at_ms IS NULL
        AND resolution_job.completed_at_ms IS NULL
        AND resolution_job.result_json IS NULL
        AND resolution_job.last_error_code IS NULL
        AND resolution_job.next_attempt_at_ms IS NULL
        AND resolution_job.created_at_ms =
          auctions.opened_at_ms
        AND resolution_job.updated_at_ms =
          auctions.opened_at_ms
        AND resolution_job.version = 1
        AND (
          SELECT COUNT(*)
          FROM auction_bids AS exact_starter
          WHERE exact_starter.league_id =
              auctions.league_id
            AND exact_starter.auction_id = auctions.id
        ) = 1
        AND (
          SELECT COUNT(*)
          FROM auction_events AS exact_started_event
          WHERE exact_started_event.league_id =
              auctions.league_id
            AND exact_started_event.auction_id =
              auctions.id
            AND exact_started_event.event_type =
              'auction_started'
        ) = 1
    )
  ) THEN RAISE(
    ABORT,
    'FAD immediate auction start must complete against exact private evidence'
  ) END;
END;

DROP TRIGGER auction_events_require_context_insert;
CREATE TRIGGER auction_events_require_context_insert
BEFORE INSERT ON auction_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
  ) THEN RAISE(
    ABORT,
    'auction event requires its persisted context'
  ) END;

  SELECT CASE WHEN
    NEW.event_type = 'commissioner_bid_removed'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      NEW.bid_id IS NOT NULL
      AND NEW.team_id IS NOT NULL
      AND NEW.actor_user_id IS NOT NULL
      AND json_valid(NEW.metadata_json)
      AND json_type(NEW.metadata_json, '$.actorMembershipId') =
        'text'
      AND json_type(NEW.metadata_json, '$.actorAuthority') =
        'text'
      AND json_extract(NEW.metadata_json, '$.actorAuthority') IN (
        'commissioner',
        'platform_administrator_as_commissioner'
      )
      AND EXISTS (
        SELECT 1
        FROM auction_bids
        WHERE auction_bids.league_id = NEW.league_id
          AND auction_bids.season_id = NEW.season_id
          AND auction_bids.id = NEW.bid_id
          AND auction_bids.auction_id = NEW.auction_id
          AND auction_bids.team_id = NEW.team_id
          AND auction_bids.status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = NEW.league_id
          AND league_memberships.id =
            json_extract(
              NEW.metadata_json,
              '$.actorMembershipId'
            )
          AND league_memberships.user_id = NEW.actor_user_id
          AND league_memberships.status = 'active'
          AND (
            (
              json_extract(
                NEW.metadata_json,
                '$.actorAuthority'
              ) = 'commissioner'
              AND EXISTS (
                SELECT 1
                FROM leagues
                WHERE leagues.id = NEW.league_id
                  AND leagues.commissioner_membership_id =
                    league_memberships.id
              )
            )
            OR (
              json_extract(
                NEW.metadata_json,
                '$.actorAuthority'
              ) =
                'platform_administrator_as_commissioner'
              AND EXISTS (
                SELECT 1
                FROM platform_roles
                WHERE platform_roles.user_id = NEW.actor_user_id
                  AND platform_roles.role =
                    'platform_administrator'
                  AND platform_roles.status = 'active'
              )
            )
          )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD commissioner removal event requires current attributable authority'
  ) END;

  SELECT CASE WHEN
    NEW.event_type = 'bid_edited'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      NEW.bid_id IS NOT NULL
      AND NEW.team_id IS NOT NULL
      AND NEW.actor_user_id IS NOT NULL
      AND json_valid(NEW.metadata_json) = 1
      AND json_type(NEW.metadata_json) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(NEW.metadata_json)
      ) = 4
      AND json_type(
        NEW.metadata_json,
        '$.actorMembershipId'
      ) = 'text'
      AND json_type(
        NEW.metadata_json,
        '$.actorAuthority'
      ) = 'text'
      AND json_type(NEW.metadata_json, '$.before') = 'object'
      AND json_type(NEW.metadata_json, '$.after') = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(
          json_extract(NEW.metadata_json, '$.before')
        )
      ) = 6
      AND (
        SELECT COUNT(*)
        FROM json_each(
          json_extract(NEW.metadata_json, '$.after')
        )
      ) = 7
      AND EXISTS (
        SELECT 1
        FROM auction_bids
        JOIN idempotency_requests
          ON idempotency_requests.league_id =
              auction_bids.league_id
         AND idempotency_requests.id =
              auction_bids.idempotency_request_id
        WHERE auction_bids.league_id = NEW.league_id
          AND auction_bids.season_id = NEW.season_id
          AND auction_bids.id = NEW.bid_id
          AND auction_bids.auction_id = NEW.auction_id
          AND auction_bids.team_id = NEW.team_id
          AND auction_bids.status = 'active'
          AND auction_bids.version > 1
          AND auction_bids.last_edited_at_ms =
            NEW.occurred_at_ms
          AND idempotency_requests.operation =
            'auction.bid.put'
          AND idempotency_requests.status = 'started'
          AND idempotency_requests.result_type IS NULL
          AND idempotency_requests.result_id IS NULL
          AND idempotency_requests.actor_user_id =
            NEW.actor_user_id
          AND idempotency_requests.created_at_ms =
            NEW.occurred_at_ms
          AND json_extract(
            NEW.metadata_json,
            '$.after.totalValueCents'
          ) = auction_bids.total_value_cents
          AND json_extract(
            NEW.metadata_json,
            '$.after.termYears'
          ) = auction_bids.term_years
          AND json_extract(
            NEW.metadata_json,
            '$.after.aavCents'
          ) = (
            (auction_bids.total_value_cents /
              auction_bids.term_years)
            + CASE
                WHEN
                  (
                    auction_bids.total_value_cents %
                    auction_bids.term_years
                  ) * 2 >= auction_bids.term_years
                THEN 1
                ELSE 0
              END
          )
          AND json_extract(
            NEW.metadata_json,
            '$.after.lowestOfferedAavCents'
          ) = auction_bids.lowest_offered_aav_cents
          AND json_extract(
            NEW.metadata_json,
            '$.after.lowestOfferedTotalValueCents'
          ) = auction_bids.lowest_offered_total_value_cents
          AND json_extract(
            NEW.metadata_json,
            '$.after.editCount'
          ) = auction_bids.edit_count
          AND json_extract(
            NEW.metadata_json,
            '$.after.version'
          ) = auction_bids.version
          AND json_type(
            NEW.metadata_json,
            '$.before.totalValueCents'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.totalValueCents'
          ) > 0
          AND json_type(
            NEW.metadata_json,
            '$.before.termYears'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.termYears'
          ) BETWEEN 1 AND 3
          AND json_type(
            NEW.metadata_json,
            '$.before.lowestOfferedAavCents'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.lowestOfferedAavCents'
          ) > 0
          AND json_type(
            NEW.metadata_json,
            '$.before.lowestOfferedTotalValueCents'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.lowestOfferedTotalValueCents'
          ) > 0
          AND json_type(
            NEW.metadata_json,
            '$.before.editCount'
          ) = 'integer'
          AND json_extract(
            NEW.metadata_json,
            '$.before.editCount'
          ) >= 0
          AND json_extract(
            NEW.metadata_json,
            '$.before.version'
          ) = auction_bids.version - 1
          AND auction_bids.lowest_offered_aav_cents = MIN(
            json_extract(
              NEW.metadata_json,
              '$.before.lowestOfferedAavCents'
            ),
            (
              (auction_bids.total_value_cents /
                auction_bids.term_years)
              + CASE
                  WHEN
                    (
                      auction_bids.total_value_cents %
                      auction_bids.term_years
                    ) * 2 >= auction_bids.term_years
                  THEN 1
                  ELSE 0
                END
            )
          )
          AND auction_bids.lowest_offered_total_value_cents = MIN(
            json_extract(
              NEW.metadata_json,
              '$.before.lowestOfferedTotalValueCents'
            ),
            auction_bids.total_value_cents
          )
          AND (
            (
              json_extract(
                NEW.metadata_json,
                '$.actorAuthority'
              ) = 'manager'
              AND json_extract(
                NEW.metadata_json,
                '$.after.editCount'
              ) = json_extract(
                NEW.metadata_json,
                '$.before.editCount'
              ) + 1
              AND EXISTS (
                SELECT 1
                FROM team_manager_assignments
                JOIN league_memberships
                  ON league_memberships.league_id =
                      team_manager_assignments.league_id
                 AND league_memberships.id =
                      team_manager_assignments.membership_id
                 AND league_memberships.user_id =
                      team_manager_assignments.user_id
                WHERE team_manager_assignments.league_id =
                    NEW.league_id
                  AND team_manager_assignments.team_id =
                    NEW.team_id
                  AND team_manager_assignments.user_id =
                    NEW.actor_user_id
                  AND team_manager_assignments.membership_id =
                    json_extract(
                      NEW.metadata_json,
                      '$.actorMembershipId'
                    )
                  AND team_manager_assignments.status =
                    'accepted'
                  AND team_manager_assignments.ended_at_ms IS NULL
                  AND league_memberships.status = 'active'
              )
            )
            OR (
              json_extract(
                NEW.metadata_json,
                '$.after.editCount'
              ) = json_extract(
                NEW.metadata_json,
                '$.before.editCount'
              )
              AND EXISTS (
                SELECT 1
                FROM league_memberships
                WHERE league_memberships.league_id =
                    NEW.league_id
                  AND league_memberships.id =
                    json_extract(
                      NEW.metadata_json,
                      '$.actorMembershipId'
                    )
                  AND league_memberships.user_id =
                    NEW.actor_user_id
                  AND league_memberships.status = 'active'
                  AND (
                    (
                      json_extract(
                        NEW.metadata_json,
                        '$.actorAuthority'
                      ) = 'commissioner'
                      AND EXISTS (
                        SELECT 1
                        FROM leagues
                        WHERE leagues.id = NEW.league_id
                          AND leagues
                            .commissioner_membership_id =
                            league_memberships.id
                      )
                    )
                    OR (
                      json_extract(
                        NEW.metadata_json,
                        '$.actorAuthority'
                      ) =
                        'platform_administrator_as_commissioner'
                      AND EXISTS (
                        SELECT 1
                        FROM platform_roles
                        WHERE platform_roles.user_id =
                            NEW.actor_user_id
                          AND platform_roles.role =
                            'platform_administrator'
                          AND platform_roles.status = 'active'
                      )
                    )
                  )
              )
            )
          )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD bid edit event must prove its exact bid version and actor authority'
  ) END;
END;

CREATE TEMP TABLE migration_0051_row_count_guard (
  preserved INTEGER NOT NULL CHECK (preserved = 1)
) STRICT;

INSERT INTO migration_0051_row_count_guard (preserved)
VALUES (
  (
    (SELECT COUNT(*) FROM candidate_card_entries)
      = (SELECT COUNT(*) FROM migration_0051_candidate_card_entries)
    AND (SELECT COUNT(*) FROM candidate_card_snapshot_entries)
      = (SELECT COUNT(*) FROM migration_0051_candidate_card_snapshot_entries)
    AND (SELECT COUNT(*) FROM free_agent_draft_auction_participants)
      = (SELECT COUNT(*) FROM migration_0051_free_agent_draft_auction_participants)
    AND (SELECT COUNT(*) FROM free_agent_draft_nomination_queue)
      = (SELECT COUNT(*) FROM migration_0051_free_agent_draft_nomination_queue)
  )
);

UPDATE application_metadata
SET metadata_value = '51',
    updated_at_ms = CASE WHEN updated_at_ms < 51 THEN 51 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';

DROP TABLE migration_0051_row_count_guard;
DROP TABLE migration_0051_candidate_card_entries;
DROP TABLE migration_0051_candidate_card_snapshot_entries;
DROP TABLE migration_0051_free_agent_draft_auction_participants;
DROP TABLE migration_0051_free_agent_draft_nomination_queue;
