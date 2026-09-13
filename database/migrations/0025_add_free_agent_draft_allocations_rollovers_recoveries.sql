-- Add deterministic FAD allocation, append-only allocation evidence,
-- seven rapid-rollover records, explicit recovery, quarantine, and
-- completion constraints.
-- Durable occurrences reuse job_runs. Corrections reuse
-- commissioner_corrections. Auction contexts, restricted participants,
-- seeded bids, and draws remain reserved for migration 0026.
-- This migration creates no FAD, allocation, rollover, recovery, job,
-- correction, auction, activity, notification, or completion row.

CREATE TABLE free_agent_draft_player_allocations (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending',
        'automatic_award',
        'restricted_scheduled',
        'restricted_active',
        'restricted_resolved',
        'no_valid_offer',
        'invalid',
        'correction_required',
        'deferred_restricted_recovery'
      )
    ),
  decision_code TEXT
    CHECK (
      decision_code IS NULL
      OR decision_code IN (
        'sole_valid_offer',
        'highest_total',
        'highest_equal_total_aav',
        'exact_total_and_term_tie',
        'no_valid_offer',
        'invalid_snapshot',
        'restricted_auction_result',
        'restricted_auction_no_winner',
        'corrected'
      )
    ),
  winning_snapshot_entry_id TEXT
    CHECK (
      winning_snapshot_entry_id IS NULL
      OR (
        length(winning_snapshot_entry_id) = 36
        AND winning_snapshot_entry_id =
          lower(winning_snapshot_entry_id)
      )
    ),
  winning_team_id TEXT,
  contract_id TEXT
    CHECK (
      contract_id IS NULL
      OR (length(contract_id) = 36 AND contract_id = lower(contract_id))
    ),
  ownership_id TEXT
    CHECK (
      ownership_id IS NULL
      OR (length(ownership_id) = 36 AND ownership_id = lower(ownership_id))
    ),
  restricted_auction_id TEXT
    CHECK (
      restricted_auction_id IS NULL
      OR (
        length(restricted_auction_id) = 36
        AND restricted_auction_id = lower(restricted_auction_id)
      )
    ),
  resolved_at_ms INTEGER
    CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= 0),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        last_error_code = trim(last_error_code)
        AND length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, id),
  UNIQUE (league_id, season_id, fad_id, id, player_id),
  UNIQUE (league_id, season_id, fad_id, player_id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_snapshot_entry_id)
    REFERENCES candidate_card_snapshot_entries(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, winning_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_id)
    REFERENCES player_ownerships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, restricted_auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      winning_snapshot_entry_id IS NULL
      AND winning_team_id IS NULL
      AND contract_id IS NULL
      AND ownership_id IS NULL
    )
    OR (
      winning_snapshot_entry_id IS NOT NULL
      AND winning_team_id IS NOT NULL
      AND contract_id IS NOT NULL
      AND ownership_id IS NOT NULL
    )
  ),
  CHECK (
    (
      status = 'pending'
      AND decision_code IS NULL
      AND winning_snapshot_entry_id IS NULL
      AND restricted_auction_id IS NULL
      AND resolved_at_ms IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'automatic_award'
      AND decision_code IN (
        'sole_valid_offer',
        'highest_total',
        'highest_equal_total_aav',
        'corrected'
      )
      AND winning_snapshot_entry_id IS NOT NULL
      AND restricted_auction_id IS NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'restricted_scheduled'
      AND decision_code = 'exact_total_and_term_tie'
      AND winning_snapshot_entry_id IS NULL
      AND restricted_auction_id IS NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'restricted_active'
      AND decision_code = 'exact_total_and_term_tie'
      AND winning_snapshot_entry_id IS NULL
      AND restricted_auction_id IS NOT NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'restricted_resolved'
      AND decision_code IN (
        'restricted_auction_result',
        'restricted_auction_no_winner',
        'corrected'
      )
      AND restricted_auction_id IS NOT NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NULL
      AND (
        (
          decision_code = 'restricted_auction_result'
          AND winning_snapshot_entry_id IS NOT NULL
        )
        OR (
          decision_code = 'restricted_auction_no_winner'
          AND winning_snapshot_entry_id IS NULL
        )
        OR decision_code = 'corrected'
      )
    )
    OR (
      status = 'no_valid_offer'
      AND decision_code IN ('no_valid_offer', 'corrected')
      AND winning_snapshot_entry_id IS NULL
      AND restricted_auction_id IS NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'invalid'
      AND decision_code IN ('invalid_snapshot', 'corrected')
      AND winning_snapshot_entry_id IS NULL
      AND restricted_auction_id IS NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'correction_required'
      AND decision_code IS NOT NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NOT NULL
    )
    OR (
      status = 'deferred_restricted_recovery'
      AND decision_code = 'exact_total_and_term_tie'
      AND winning_snapshot_entry_id IS NULL
      AND restricted_auction_id IS NULL
      AND resolved_at_ms IS NOT NULL
      AND last_error_code IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX free_agent_draft_allocations_one_restricted_auction
  ON free_agent_draft_player_allocations (
    league_id,
    restricted_auction_id
  )
  WHERE restricted_auction_id IS NOT NULL;

CREATE INDEX free_agent_draft_allocations_league_fad_status
  ON free_agent_draft_player_allocations (
    league_id,
    fad_id,
    status
  );

CREATE INDEX free_agent_draft_allocations_league_player_status
  ON free_agent_draft_player_allocations (
    league_id,
    player_id,
    status
  );

CREATE TABLE free_agent_draft_allocation_events (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  allocation_version INTEGER NOT NULL CHECK (allocation_version >= 1),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_kind TEXT NOT NULL
    CHECK (
      event_kind IN (
        'offer_considered',
        'decision_recorded',
        'restricted_state_changed',
        'correction_applied'
      )
    ),
  snapshot_entry_id TEXT
    CHECK (
      snapshot_entry_id IS NULL
      OR (
        length(snapshot_entry_id) = 36
        AND snapshot_entry_id = lower(snapshot_entry_id)
      )
    ),
  team_id TEXT,
  offer_valid INTEGER
    CHECK (offer_valid IS NULL OR offer_valid IN (0, 1)),
  rank_position INTEGER
    CHECK (rank_position IS NULL OR rank_position >= 1),
  offer_outcome_code TEXT
    CHECK (
      offer_outcome_code IS NULL
      OR offer_outcome_code IN (
        'winner',
        'lost_lower_total',
        'lost_lower_aav',
        'restricted_tied',
        'invalid'
      )
    ),
  decision_code TEXT
    CHECK (
      decision_code IS NULL
      OR decision_code IN (
        'sole_valid_offer',
        'highest_total',
        'highest_equal_total_aav',
        'exact_total_and_term_tie',
        'no_valid_offer',
        'invalid_snapshot',
        'restricted_auction_result',
        'restricted_auction_no_winner',
        'corrected'
      )
    ),
  resulting_allocation_status TEXT NOT NULL
    CHECK (
      resulting_allocation_status IN (
        'pending',
        'automatic_award',
        'restricted_scheduled',
        'restricted_active',
        'restricted_resolved',
        'no_valid_offer',
        'invalid',
        'correction_required',
        'deferred_restricted_recovery'
      )
    ),
  contract_id TEXT,
  ownership_id TEXT,
  auction_id TEXT,
  activity_id TEXT,
  correction_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT,
  actor_authority TEXT NOT NULL
    CHECK (
      actor_authority IN (
        'system',
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  evidence_json TEXT NOT NULL
    CHECK (
      json_valid(evidence_json) = 1
      AND json_type(evidence_json) = 'object'
      AND length(evidence_json) BETWEEN 2 AND 100000
    ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= occurred_at_ms),
  UNIQUE (league_id, id),
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    player_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id,
    player_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, snapshot_entry_id)
    REFERENCES candidate_card_snapshot_entries(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_id)
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_id)
    REFERENCES player_ownerships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, activity_id)
    REFERENCES league_activity(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, correction_id)
    REFERENCES commissioner_corrections(league_id, id)
    ON DELETE RESTRICT,
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
      event_kind = 'offer_considered'
      AND snapshot_entry_id IS NOT NULL
      AND team_id IS NOT NULL
      AND offer_valid IS NOT NULL
      AND offer_outcome_code IS NOT NULL
      AND decision_code IS NULL
      AND correction_id IS NULL
    )
    OR (
      event_kind = 'decision_recorded'
      AND snapshot_entry_id IS NULL
      AND team_id IS NULL
      AND offer_valid IS NULL
      AND rank_position IS NULL
      AND offer_outcome_code IS NULL
      AND decision_code IS NOT NULL
      AND correction_id IS NULL
    )
    OR (
      event_kind = 'restricted_state_changed'
      AND snapshot_entry_id IS NULL
      AND team_id IS NULL
      AND offer_valid IS NULL
      AND rank_position IS NULL
      AND offer_outcome_code IS NULL
      AND decision_code IS NOT NULL
      AND auction_id IS NOT NULL
      AND correction_id IS NULL
    )
    OR (
      event_kind = 'correction_applied'
      AND snapshot_entry_id IS NULL
      AND team_id IS NULL
      AND offer_valid IS NULL
      AND rank_position IS NULL
      AND offer_outcome_code IS NULL
      AND decision_code = 'corrected'
      AND correction_id IS NOT NULL
      AND actor_authority <> 'system'
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_allocation_events_league_allocation_time
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    occurred_at_ms
  );

CREATE INDEX free_agent_draft_allocation_events_league_fad_kind
  ON free_agent_draft_allocation_events (
    league_id,
    fad_id,
    event_kind
  );

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_offer_version
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version,
    snapshot_entry_id
  )
  WHERE event_kind = 'offer_considered';

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_decision_kind
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version,
    event_kind
  )
  WHERE event_kind <> 'offer_considered';

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_winner
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version
  )
  WHERE offer_outcome_code = 'winner';

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_correction
  ON free_agent_draft_allocation_events (
    league_id,
    correction_id
  )
  WHERE correction_id IS NOT NULL;

CREATE TABLE free_agent_draft_rollovers (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 7),
  opens_at_ms INTEGER NOT NULL CHECK (opens_at_ms >= 0),
  creation_cutoff_at_ms INTEGER NOT NULL
    CHECK (creation_cutoff_at_ms >= 0),
  rolls_over_at_ms INTEGER NOT NULL CHECK (rolls_over_at_ms >= 0),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'scheduled',
        'processing',
        'completed',
        'recovery_required'
      )
    ),
  processing_started_at_ms INTEGER
    CHECK (
      processing_started_at_ms IS NULL
      OR processing_started_at_ms >= rolls_over_at_ms
    ),
  completed_at_ms INTEGER
    CHECK (
      completed_at_ms IS NULL
      OR (
        processing_started_at_ms IS NOT NULL
        AND completed_at_ms >= processing_started_at_ms
      )
    ),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        last_error_code = trim(last_error_code)
        AND length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, id),
  UNIQUE (league_id, season_id, fad_id, sequence),
  UNIQUE (league_id, season_id, fad_id, rolls_over_at_ms),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  CHECK (
    creation_cutoff_at_ms = rolls_over_at_ms - 3600000
    AND opens_at_ms = rolls_over_at_ms - 86400000
  ),
  CHECK (
    (
      status = 'scheduled'
      AND processing_started_at_ms IS NULL
      AND completed_at_ms IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'processing'
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'completed'
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'recovery_required'
      AND processing_started_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
      AND last_error_code IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_rollovers_league_fad_status_time
  ON free_agent_draft_rollovers (
    league_id,
    fad_id,
    status,
    rolls_over_at_ms
  );

CREATE TABLE free_agent_draft_recoveries (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  allocation_id TEXT,
  rollover_id TEXT,
  auction_id TEXT,
  job_run_id TEXT,
  supersedes_recovery_id TEXT
    CHECK (
      supersedes_recovery_id IS NULL
      OR (
        length(supersedes_recovery_id) = 36
        AND supersedes_recovery_id =
          lower(supersedes_recovery_id)
      )
    ),
  causal_started_at_ms INTEGER
    CHECK (
      causal_started_at_ms IS NULL
      OR causal_started_at_ms >= 0
    ),
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'deadline_retry',
        'allocation_retry',
        'restricted_activation',
        'auction_resolution',
        'rollover_finalize',
        'completion',
        'deferred_restricted'
      )
    ),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending',
        'ready',
        'running',
        'resolved',
        'correction_required'
      )
    ),
  earliest_activation_at_ms INTEGER
    CHECK (
      earliest_activation_at_ms IS NULL
      OR earliest_activation_at_ms >= 0
    ),
  target_resolution_at_ms INTEGER
    CHECK (
      target_resolution_at_ms IS NULL
      OR target_resolution_at_ms >= 0
    ),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        last_error_code = trim(last_error_code)
        AND length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  commissioner_reason TEXT
    CHECK (
      commissioner_reason IS NULL
      OR (
        commissioner_reason = trim(commissioner_reason)
        AND length(commissioner_reason) BETWEEN 1 AND 500
      )
    ),
  created_by_operation_id TEXT
    CHECK (
      created_by_operation_id IS NULL
      OR (
        created_by_operation_id = trim(created_by_operation_id)
        AND length(created_by_operation_id) BETWEEN 1 AND 200
      )
    ),
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  resolved_by_membership_id TEXT,
  resolved_authority TEXT
    CHECK (
      resolved_authority IS NULL
      OR resolved_authority IN (
        'system',
        'commissioner',
        'platform_administrator_as_commissioner'
      )
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  resolved_at_ms INTEGER
    CHECK (
      resolved_at_ms IS NULL
      OR resolved_at_ms >= created_at_ms
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, season_id, fad_id, id),
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    player_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id,
    player_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, rollover_id)
    REFERENCES free_agent_draft_rollovers(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, job_run_id)
    REFERENCES job_runs(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, supersedes_recovery_id)
    REFERENCES free_agent_draft_recoveries(league_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (league_id, resolved_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      earliest_activation_at_ms IS NULL
      AND target_resolution_at_ms IS NULL
    )
    OR (
      earliest_activation_at_ms IS NOT NULL
      AND target_resolution_at_ms IS NOT NULL
      AND target_resolution_at_ms >
        earliest_activation_at_ms + 3600000
    )
  ),
  CHECK (
    (
      status = 'resolved'
      AND resolved_at_ms IS NOT NULL
      AND resolved_authority IS NOT NULL
    )
    OR (
      status <> 'resolved'
      AND resolved_at_ms IS NULL
      AND resolved_by_user_id IS NULL
      AND resolved_by_membership_id IS NULL
      AND resolved_authority IS NULL
    )
  ),
  CHECK (
    resolved_authority IS NULL
    OR (
      resolved_authority = 'system'
      AND resolved_by_user_id IS NULL
      AND resolved_by_membership_id IS NULL
    )
    OR (
      resolved_authority <> 'system'
      AND resolved_by_user_id IS NOT NULL
      AND resolved_by_membership_id IS NOT NULL
      AND commissioner_reason IS NOT NULL
    )
  ),
  CHECK (
    (
      supersedes_recovery_id IS NULL
      AND causal_started_at_ms IS NULL
    )
    OR (
      kind = 'deferred_restricted'
      AND supersedes_recovery_id IS NOT NULL
      AND causal_started_at_ms IS NOT NULL
      AND causal_started_at_ms <= created_at_ms
    )
  ),
  CHECK (
    (
      kind = 'deadline_retry'
      AND player_id IS NULL
      AND allocation_id IS NULL
      AND rollover_id IS NULL
      AND auction_id IS NULL
      AND earliest_activation_at_ms IS NULL
    )
    OR (
      kind = 'allocation_retry'
      AND player_id IS NOT NULL
      AND allocation_id IS NOT NULL
      AND rollover_id IS NULL
      AND auction_id IS NULL
      AND job_run_id IS NOT NULL
      AND earliest_activation_at_ms IS NULL
    )
    OR (
      kind = 'restricted_activation'
      AND player_id IS NOT NULL
      AND allocation_id IS NOT NULL
      AND auction_id IS NULL
      AND job_run_id IS NOT NULL
      AND earliest_activation_at_ms IS NOT NULL
    )
    OR (
      kind = 'auction_resolution'
      AND player_id IS NOT NULL
      AND auction_id IS NOT NULL
      AND job_run_id IS NOT NULL
      AND earliest_activation_at_ms IS NULL
    )
    OR (
      kind = 'rollover_finalize'
      AND allocation_id IS NULL
      AND rollover_id IS NOT NULL
      AND job_run_id IS NOT NULL
      AND earliest_activation_at_ms IS NULL
    )
    OR (
      kind = 'completion'
      AND player_id IS NULL
      AND allocation_id IS NULL
      AND rollover_id IS NULL
      AND auction_id IS NULL
      AND earliest_activation_at_ms IS NULL
    )
    OR (
      kind = 'deferred_restricted'
      AND player_id IS NOT NULL
      AND allocation_id IS NOT NULL
      AND rollover_id IS NULL
      AND auction_id IS NULL
      AND job_run_id IS NOT NULL
      AND earliest_activation_at_ms IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_recoveries_league_fad_status
  ON free_agent_draft_recoveries (
    league_id,
    fad_id,
    status
  );

CREATE INDEX free_agent_draft_recoveries_league_player_status
  ON free_agent_draft_recoveries (
    league_id,
    player_id,
    status
  );

CREATE INDEX free_agent_draft_recoveries_league_rollover
  ON free_agent_draft_recoveries (
    league_id,
    rollover_id
  );

CREATE UNIQUE INDEX free_agent_draft_recoveries_causal_operation
  ON free_agent_draft_recoveries (
    league_id,
    fad_id,
    kind,
    COALESCE(player_id, ''),
    COALESCE(allocation_id, ''),
    COALESCE(rollover_id, ''),
    COALESCE(auction_id, ''),
    COALESCE(job_run_id, ''),
    COALESCE(created_by_operation_id, '')
  );

CREATE UNIQUE INDEX free_agent_draft_recoveries_one_successor
  ON free_agent_draft_recoveries (
    league_id,
    supersedes_recovery_id
  )
  WHERE supersedes_recovery_id IS NOT NULL;

CREATE UNIQUE INDEX free_agent_draft_recoveries_one_deferred_root
  ON free_agent_draft_recoveries (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    created_at_ms
  )
  WHERE kind = 'deferred_restricted'
    AND supersedes_recovery_id IS NULL;

CREATE UNIQUE INDEX free_agent_draft_recoveries_one_unresolved_causal_state
  ON free_agent_draft_recoveries (
    league_id,
    season_id,
    fad_id,
    allocation_id,
    kind,
    created_at_ms,
    COALESCE(last_error_code, '')
  )
  WHERE allocation_id IS NOT NULL
    AND status IN (
      'pending',
      'ready',
      'running',
      'correction_required'
    );

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
    AND NEW.resolved_at_ms IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status = 'cards_open'
        AND NEW.created_at_ms >=
          free_agent_drafts.candidate_deadline_at_ms
    )
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
    )
  ) THEN RAISE(
    ABORT,
    'FAD allocation must begin pending for a snapshotted candidate player'
  ) END;
END;

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
    AND NEW.status <> 'pending'
    AND (
      (
        OLD.status = 'pending'
        AND NEW.status IN (
          'automatic_award',
          'restricted_scheduled',
          'restricted_active',
          'no_valid_offer',
          'invalid',
          'correction_required',
          'deferred_restricted_recovery'
        )
        AND NEW.resolved_at_ms = NEW.updated_at_ms
        AND (
          NEW.status <> 'correction_required'
          OR (
            NEW.winning_snapshot_entry_id IS NULL
            AND NEW.winning_team_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
            AND NEW.restricted_auction_id IS NULL
          )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'allocating'
        )
        AND EXISTS (
          SELECT 1
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.season_id = NEW.season_id
            AND job_runs.job_type = 'fad_allocation'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':allocate:' || NEW.player_id
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms >= NEW.updated_at_ms
        )
      )
      OR (
        OLD.status = 'restricted_scheduled'
        AND NEW.status IN (
          'restricted_active',
          'correction_required',
          'deferred_restricted_recovery'
        )
        AND (
          NEW.status <> 'deferred_restricted_recovery'
          OR (
            NEW.decision_code = 'exact_total_and_term_tie'
            AND NEW.winning_snapshot_entry_id IS NULL
            AND NEW.winning_team_id IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
            AND NEW.restricted_auction_id IS NULL
            AND NEW.resolved_at_ms = NEW.updated_at_ms
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_rollovers
              WHERE free_agent_draft_rollovers.league_id =
                  NEW.league_id
                AND free_agent_draft_rollovers.season_id =
                  NEW.season_id
                AND free_agent_draft_rollovers.fad_id = NEW.fad_id
                AND free_agent_draft_rollovers.sequence = 7
                AND NEW.resolved_at_ms >=
                  free_agent_draft_rollovers.creation_cutoff_at_ms
            )
          )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
        )
      )
      OR (
        OLD.status = 'restricted_active'
        AND NEW.status IN (
          'restricted_resolved',
          'correction_required'
        )
        AND NEW.restricted_auction_id IS
          OLD.restricted_auction_id
        AND (
          NEW.status <> 'correction_required'
          OR NEW.decision_code = OLD.decision_code
        )
        AND (
          NEW.status <> 'correction_required'
          OR (
            NEW.winning_snapshot_entry_id IS
              OLD.winning_snapshot_entry_id
            AND NEW.winning_team_id IS OLD.winning_team_id
            AND NEW.contract_id IS OLD.contract_id
            AND NEW.ownership_id IS OLD.ownership_id
          )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
        )
      )
      OR (
        OLD.status = 'deferred_restricted_recovery'
        AND NEW.status = 'restricted_active'
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          JOIN seasons
            ON seasons.league_id = free_agent_drafts.league_id
           AND seasons.id = free_agent_drafts.season_id
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'completed'
            AND seasons.free_agent_draft_completed_at_ms =
              free_agent_drafts.completed_at_ms
        )
      )
      OR (
        OLD.status = 'correction_required'
        AND OLD.decision_code = 'exact_total_and_term_tie'
        AND OLD.restricted_auction_id IS NULL
        AND NEW.status IN (
          'restricted_scheduled',
          'restricted_active'
        )
        AND NEW.decision_code = OLD.decision_code
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.resolved_at_ms = NEW.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_recoveries
          WHERE free_agent_draft_recoveries.league_id =
              OLD.league_id
            AND free_agent_draft_recoveries.season_id =
              OLD.season_id
            AND free_agent_draft_recoveries.fad_id = OLD.fad_id
            AND free_agent_draft_recoveries.allocation_id = OLD.id
            AND free_agent_draft_recoveries.player_id = OLD.player_id
            AND free_agent_draft_recoveries.kind =
              'restricted_activation'
            AND free_agent_draft_recoveries.status IN (
              'pending',
              'ready',
              'running',
              'correction_required'
            )
            AND free_agent_draft_recoveries.last_error_code =
              OLD.last_error_code
            AND free_agent_draft_recoveries.created_at_ms =
              OLD.resolved_at_ms
            AND free_agent_draft_recoveries.job_run_id IS NOT NULL
            AND (
              NEW.status = 'restricted_active'
              OR EXISTS (
                SELECT 1
                FROM free_agent_draft_rollovers AS target_rollover
                JOIN free_agent_draft_rollovers AS prior_rollover
                  ON prior_rollover.league_id =
                      target_rollover.league_id
                 AND prior_rollover.season_id =
                      target_rollover.season_id
                 AND prior_rollover.fad_id =
                      target_rollover.fad_id
                 AND prior_rollover.sequence =
                      target_rollover.sequence - 1
                WHERE target_rollover.league_id =
                    free_agent_draft_recoveries.league_id
                  AND target_rollover.season_id =
                    free_agent_draft_recoveries.season_id
                  AND target_rollover.fad_id =
                    free_agent_draft_recoveries.fad_id
                  AND target_rollover.id =
                    free_agent_draft_recoveries.rollover_id
                  AND target_rollover.rolls_over_at_ms =
                    free_agent_draft_recoveries
                      .target_resolution_at_ms
                  AND prior_rollover.rolls_over_at_ms =
                    free_agent_draft_recoveries
                      .earliest_activation_at_ms
                  AND NEW.updated_at_ms >=
                    prior_rollover.creation_cutoff_at_ms
                  AND NEW.updated_at_ms <
                    prior_rollover.rolls_over_at_ms
              )
            )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
        )
      )
      OR (
        OLD.status = 'correction_required'
        AND OLD.decision_code = 'exact_total_and_term_tie'
        AND OLD.restricted_auction_id IS NULL
        AND NEW.status = 'deferred_restricted_recovery'
        AND NEW.decision_code = OLD.decision_code
        AND NEW.winning_snapshot_entry_id IS NULL
        AND NEW.winning_team_id IS NULL
        AND NEW.contract_id IS NULL
        AND NEW.ownership_id IS NULL
        AND NEW.restricted_auction_id IS NULL
        AND NEW.resolved_at_ms = NEW.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers
          WHERE free_agent_draft_rollovers.league_id =
              NEW.league_id
            AND free_agent_draft_rollovers.season_id =
              NEW.season_id
            AND free_agent_draft_rollovers.fad_id = NEW.fad_id
            AND free_agent_draft_rollovers.sequence = 7
            AND NEW.resolved_at_ms >=
              free_agent_draft_rollovers.creation_cutoff_at_ms
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'rapid'
        )
      )
      OR (
        OLD.status = 'correction_required'
        AND OLD.restricted_auction_id IS NULL
        AND OLD.decision_code IN (
          'sole_valid_offer',
          'highest_total',
          'highest_equal_total_aav',
          'no_valid_offer',
          'invalid_snapshot'
        )
        AND NEW.decision_code = OLD.decision_code
        AND (
          (
            OLD.decision_code IN (
              'sole_valid_offer',
              'highest_total',
              'highest_equal_total_aav'
            )
            AND NEW.status = 'automatic_award'
          )
          OR (
            OLD.decision_code = 'no_valid_offer'
            AND NEW.status = 'no_valid_offer'
          )
          OR (
            OLD.decision_code = 'invalid_snapshot'
            AND NEW.status = 'invalid'
          )
        )
        AND NEW.restricted_auction_id IS NULL
        AND NEW.resolved_at_ms = NEW.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN (
              'allocating',
              'rapid',
              'completed'
            )
        )
      )
      OR (
        OLD.status = 'correction_required'
        AND OLD.decision_code = 'exact_total_and_term_tie'
        AND OLD.restricted_auction_id IS NOT NULL
        AND NEW.status = 'restricted_resolved'
        AND NEW.decision_code IN (
          'restricted_auction_result',
          'restricted_auction_no_winner'
        )
        AND NEW.restricted_auction_id IS
          OLD.restricted_auction_id
        AND NEW.resolved_at_ms = NEW.updated_at_ms
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
        )
      )
      OR (
        OLD.status IN (
          'automatic_award',
          'restricted_resolved',
          'no_valid_offer',
          'invalid',
          'correction_required'
        )
        AND NEW.status IN (
          'automatic_award',
          'restricted_resolved',
          'no_valid_offer',
          'invalid',
          'correction_required',
          'deferred_restricted_recovery'
        )
        AND (
          (
            NEW.status = 'correction_required'
            AND OLD.status <> 'correction_required'
          )
          OR NEW.decision_code = 'corrected'
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
            AND (
              NEW.status <> 'correction_required'
              OR free_agent_drafts.status = 'rapid'
            )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD allocation may only advance through an approved versioned state'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_terminal_failure_update
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status IN (
    'automatic_award',
    'restricted_resolved',
    'no_valid_offer',
    'invalid'
  )
  AND NEW.status = 'correction_required'
BEGIN
  SELECT CASE WHEN
    NEW.decision_code <> OLD.decision_code
    OR NEW.winning_snapshot_entry_id IS NOT
      OLD.winning_snapshot_entry_id
    OR NEW.winning_team_id IS NOT OLD.winning_team_id
    OR NEW.contract_id IS NOT OLD.contract_id
    OR NEW.ownership_id IS NOT OLD.ownership_id
    OR NEW.restricted_auction_id IS NOT
      OLD.restricted_auction_id
    OR NEW.resolved_at_ms <> NEW.updated_at_ms
    OR (
      SELECT COUNT(*)
      FROM free_agent_draft_recoveries
      JOIN job_runs
        ON job_runs.league_id =
            free_agent_draft_recoveries.league_id
       AND job_runs.id =
            free_agent_draft_recoveries.job_run_id
      WHERE free_agent_draft_recoveries.league_id =
          OLD.league_id
        AND free_agent_draft_recoveries.season_id =
          OLD.season_id
        AND free_agent_draft_recoveries.fad_id = OLD.fad_id
        AND free_agent_draft_recoveries.allocation_id = OLD.id
        AND free_agent_draft_recoveries.player_id = OLD.player_id
        AND free_agent_draft_recoveries.status IN (
          'pending',
          'ready',
          'running',
          'correction_required'
        )
        AND free_agent_draft_recoveries.created_at_ms =
          NEW.resolved_at_ms
        AND free_agent_draft_recoveries.last_error_code =
          NEW.last_error_code
        AND free_agent_draft_recoveries.updated_at_ms <=
          NEW.updated_at_ms
        AND job_runs.season_id = OLD.season_id
        AND (
          (
            job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms >= NEW.updated_at_ms
          )
          OR (
            job_runs.status = 'failed'
            AND job_runs.attempt_count >= 1
          )
        )
        AND (
          (
            OLD.restricted_auction_id IS NULL
            AND free_agent_draft_recoveries.kind =
              'allocation_retry'
            AND free_agent_draft_recoveries.auction_id IS NULL
            AND job_runs.job_type = 'fad_allocation'
            AND job_runs.occurrence_key =
              'fad:' || OLD.fad_id || ':allocate:' || OLD.player_id
            AND job_runs.scheduled_for_ms = (
              SELECT candidate_deadline_at_ms
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = OLD.league_id
                AND free_agent_drafts.season_id = OLD.season_id
                AND free_agent_drafts.id = OLD.fad_id
            )
          )
          OR (
            OLD.restricted_auction_id IS NOT NULL
            AND free_agent_draft_recoveries.kind =
              'auction_resolution'
            AND free_agent_draft_recoveries.auction_id =
              OLD.restricted_auction_id
            AND job_runs.job_type = 'auction.resolve.target'
            AND EXISTS (
              SELECT 1
              FROM auctions
              WHERE auctions.league_id = OLD.league_id
                AND auctions.season_id = OLD.season_id
                AND auctions.id = OLD.restricted_auction_id
                AND auctions.player_id = OLD.player_id
                AND job_runs.occurrence_key =
                  'auction:' || auctions.id || ':' ||
                    auctions.resolves_at_ms
                AND job_runs.scheduled_for_ms =
                  auctions.resolves_at_ms
            )
          )
        )
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD terminal allocation failure requires exact durable recovery'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_activation_lease_update
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status IN (
    'restricted_scheduled',
    'deferred_restricted_recovery',
    'correction_required'
  )
  AND NEW.status = 'restricted_active'
BEGIN
  SELECT CASE WHEN
    NEW.resolved_at_ms <> NEW.updated_at_ms
    OR (
      SELECT COUNT(*)
      FROM free_agent_draft_recoveries
      WHERE free_agent_draft_recoveries.league_id =
          NEW.league_id
        AND free_agent_draft_recoveries.season_id =
          NEW.season_id
        AND free_agent_draft_recoveries.fad_id = NEW.fad_id
        AND free_agent_draft_recoveries.allocation_id = NEW.id
        AND free_agent_draft_recoveries.player_id = NEW.player_id
        AND free_agent_draft_recoveries.kind = CASE
          WHEN OLD.status = 'deferred_restricted_recovery'
            THEN 'deferred_restricted'
          ELSE 'restricted_activation'
        END
        AND free_agent_draft_recoveries.status IN (
          'pending',
          'ready',
          'running',
          'correction_required'
        )
        AND (
          (
            OLD.status = 'deferred_restricted_recovery'
            AND COALESCE(
              free_agent_draft_recoveries.causal_started_at_ms,
              free_agent_draft_recoveries.created_at_ms
            ) = OLD.resolved_at_ms
            AND free_agent_draft_recoveries.last_error_code IS
              OLD.last_error_code
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recoveries AS successor
              WHERE successor.league_id =
                  free_agent_draft_recoveries.league_id
                AND successor.supersedes_recovery_id =
                  free_agent_draft_recoveries.id
            )
            AND (
              free_agent_draft_recoveries
                .supersedes_recovery_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries AS predecessor
                WHERE predecessor.league_id =
                    free_agent_draft_recoveries.league_id
                  AND predecessor.id =
                    free_agent_draft_recoveries
                      .supersedes_recovery_id
                  AND predecessor.status = 'resolved'
                  AND predecessor.resolved_at_ms <=
                    NEW.updated_at_ms
              )
            )
          )
          OR (
            OLD.status <> 'deferred_restricted_recovery'
            AND free_agent_draft_recoveries.created_at_ms =
              OLD.resolved_at_ms
            AND free_agent_draft_recoveries.last_error_code IS
              OLD.last_error_code
          )
        )
    ) <> 1
    OR (
      SELECT COUNT(*)
      FROM free_agent_draft_recoveries
      JOIN job_runs
        ON job_runs.league_id =
            free_agent_draft_recoveries.league_id
       AND job_runs.id =
            free_agent_draft_recoveries.job_run_id
      WHERE free_agent_draft_recoveries.league_id =
          NEW.league_id
        AND free_agent_draft_recoveries.season_id =
          NEW.season_id
        AND free_agent_draft_recoveries.fad_id = NEW.fad_id
        AND free_agent_draft_recoveries.allocation_id = NEW.id
        AND free_agent_draft_recoveries.player_id = NEW.player_id
        AND free_agent_draft_recoveries.kind = CASE
          WHEN OLD.status = 'deferred_restricted_recovery'
            THEN 'deferred_restricted'
          ELSE 'restricted_activation'
        END
        AND free_agent_draft_recoveries.status = 'running'
        AND free_agent_draft_recoveries
          .earliest_activation_at_ms <= NEW.updated_at_ms
        AND free_agent_draft_recoveries
          .target_resolution_at_ms >
            NEW.updated_at_ms + 3600000
        AND (
          (
            OLD.status = 'restricted_scheduled'
            AND free_agent_draft_recoveries.created_at_ms =
              OLD.resolved_at_ms
            AND free_agent_draft_recoveries.last_error_code IS
              OLD.last_error_code
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_rollovers AS target_rollover
              JOIN free_agent_draft_rollovers AS prior_rollover
                ON prior_rollover.league_id =
                    target_rollover.league_id
               AND prior_rollover.season_id =
                    target_rollover.season_id
               AND prior_rollover.fad_id =
                    target_rollover.fad_id
               AND prior_rollover.sequence =
                    target_rollover.sequence - 1
              WHERE target_rollover.league_id =
                  free_agent_draft_recoveries.league_id
                AND target_rollover.season_id =
                  free_agent_draft_recoveries.season_id
                AND target_rollover.fad_id =
                  free_agent_draft_recoveries.fad_id
                AND target_rollover.id =
                  free_agent_draft_recoveries.rollover_id
                AND target_rollover.rolls_over_at_ms =
                  free_agent_draft_recoveries
                    .target_resolution_at_ms
                AND prior_rollover.rolls_over_at_ms =
                  free_agent_draft_recoveries
                    .earliest_activation_at_ms
                AND OLD.resolved_at_ms >=
                  prior_rollover.creation_cutoff_at_ms
                AND OLD.resolved_at_ms <
                  prior_rollover.rolls_over_at_ms
            )
          )
          OR (
            OLD.status = 'deferred_restricted_recovery'
            AND COALESCE(
              free_agent_draft_recoveries.causal_started_at_ms,
              free_agent_draft_recoveries.created_at_ms
            ) = OLD.resolved_at_ms
            AND free_agent_draft_recoveries.last_error_code =
              OLD.last_error_code
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recoveries AS successor
              WHERE successor.league_id =
                  free_agent_draft_recoveries.league_id
                AND successor.supersedes_recovery_id =
                  free_agent_draft_recoveries.id
            )
            AND (
              free_agent_draft_recoveries
                .supersedes_recovery_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries AS predecessor
                WHERE predecessor.league_id =
                    free_agent_draft_recoveries.league_id
                  AND predecessor.id =
                    free_agent_draft_recoveries
                      .supersedes_recovery_id
                  AND predecessor.status = 'resolved'
                  AND predecessor.resolved_at_ms <=
                    NEW.updated_at_ms
              )
            )
          )
          OR (
            OLD.status = 'correction_required'
            AND free_agent_draft_recoveries.created_at_ms =
              OLD.resolved_at_ms
            AND free_agent_draft_recoveries.last_error_code =
              OLD.last_error_code
          )
        )
        AND job_runs.season_id = NEW.season_id
        AND job_runs.job_type = 'fad_restricted_activation'
        AND job_runs.occurrence_key =
          'fad:' || NEW.fad_id || ':restricted-activate:' ||
            NEW.id || ':' ||
            free_agent_draft_recoveries.earliest_activation_at_ms
        AND job_runs.scheduled_for_ms =
          free_agent_draft_recoveries.earliest_activation_at_ms
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms >= NEW.updated_at_ms
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD restricted activation requires its due recovery lease'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_failure_lease_update
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN (
    OLD.status = 'restricted_scheduled'
    AND NEW.status IN (
      'correction_required',
      'deferred_restricted_recovery'
    )
  )
  OR (
    OLD.status = 'correction_required'
    AND OLD.decision_code = 'exact_total_and_term_tie'
    AND OLD.restricted_auction_id IS NULL
    AND NEW.status = 'deferred_restricted_recovery'
  )
BEGIN
  SELECT CASE WHEN
    NEW.resolved_at_ms <> NEW.updated_at_ms
    OR (
      SELECT COUNT(*)
      FROM free_agent_draft_recoveries
      JOIN job_runs
        ON job_runs.league_id =
            free_agent_draft_recoveries.league_id
       AND job_runs.id =
            free_agent_draft_recoveries.job_run_id
      WHERE free_agent_draft_recoveries.league_id =
          OLD.league_id
        AND free_agent_draft_recoveries.season_id =
          OLD.season_id
        AND free_agent_draft_recoveries.fad_id = OLD.fad_id
        AND free_agent_draft_recoveries.allocation_id = OLD.id
        AND free_agent_draft_recoveries.player_id = OLD.player_id
        AND free_agent_draft_recoveries.kind =
          'restricted_activation'
        AND free_agent_draft_recoveries.status IN (
          'running',
          'correction_required'
        )
        AND free_agent_draft_recoveries.created_at_ms =
          OLD.resolved_at_ms
        AND free_agent_draft_recoveries.last_error_code IS
          OLD.last_error_code
        AND free_agent_draft_recoveries
          .earliest_activation_at_ms <= NEW.updated_at_ms
        AND (
          OLD.status <> 'restricted_scheduled'
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_rollovers AS target_rollover
            JOIN free_agent_draft_rollovers AS prior_rollover
              ON prior_rollover.league_id =
                  target_rollover.league_id
             AND prior_rollover.season_id =
                  target_rollover.season_id
             AND prior_rollover.fad_id =
                  target_rollover.fad_id
             AND prior_rollover.sequence =
                  target_rollover.sequence - 1
            WHERE target_rollover.league_id =
                free_agent_draft_recoveries.league_id
              AND target_rollover.season_id =
                free_agent_draft_recoveries.season_id
              AND target_rollover.fad_id =
                free_agent_draft_recoveries.fad_id
              AND target_rollover.id =
                free_agent_draft_recoveries.rollover_id
              AND target_rollover.rolls_over_at_ms =
                free_agent_draft_recoveries
                  .target_resolution_at_ms
              AND prior_rollover.rolls_over_at_ms =
                free_agent_draft_recoveries
                  .earliest_activation_at_ms
              AND OLD.resolved_at_ms >=
                prior_rollover.creation_cutoff_at_ms
              AND OLD.resolved_at_ms <
                prior_rollover.rolls_over_at_ms
          )
        )
        AND job_runs.season_id = OLD.season_id
        AND job_runs.job_type = 'fad_restricted_activation'
        AND job_runs.occurrence_key =
          'fad:' || OLD.fad_id || ':restricted-activate:' ||
            OLD.id || ':' ||
            free_agent_draft_recoveries
              .earliest_activation_at_ms
        AND job_runs.scheduled_for_ms =
          free_agent_draft_recoveries.earliest_activation_at_ms
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms >= NEW.updated_at_ms
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD restricted failure requires its exact due activation recovery lease'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_resolution_lease_update
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status = 'restricted_active'
  AND NEW.status = 'restricted_resolved'
BEGIN
  SELECT CASE WHEN
    NEW.resolved_at_ms <> NEW.updated_at_ms
    OR NEW.decision_code NOT IN (
      'restricted_auction_result',
      'restricted_auction_no_winner'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM auctions
      JOIN job_runs
        ON job_runs.league_id = auctions.league_id
       AND job_runs.season_id = auctions.season_id
       AND job_runs.job_type = 'auction.resolve.target'
       AND job_runs.occurrence_key =
            'auction:' || auctions.id || ':' ||
              auctions.resolves_at_ms
       AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.restricted_auction_id
        AND auctions.player_id = NEW.player_id
        AND auctions.resolves_at_ms <= NEW.updated_at_ms
        AND auctions.status = CASE NEW.decision_code
          WHEN 'restricted_auction_result' THEN 'resolved'
          ELSE 'no_winner'
        END
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms >= NEW.updated_at_ms
    )
  THEN RAISE(
    ABORT,
    'FAD restricted resolution requires its due auction lease'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_retry_lease_update
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status = 'correction_required'
  AND OLD.restricted_auction_id IS NULL
  AND NEW.status IN (
    'automatic_award',
    'no_valid_offer',
    'invalid'
  )
  AND NEW.decision_code = OLD.decision_code
BEGIN
  SELECT CASE WHEN
    NEW.resolved_at_ms <> NEW.updated_at_ms
    OR (
      SELECT COUNT(*)
      FROM free_agent_draft_recoveries
      JOIN job_runs
        ON job_runs.league_id =
            free_agent_draft_recoveries.league_id
       AND job_runs.id =
            free_agent_draft_recoveries.job_run_id
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id =
            free_agent_draft_recoveries.league_id
       AND free_agent_drafts.season_id =
            free_agent_draft_recoveries.season_id
       AND free_agent_drafts.id =
            free_agent_draft_recoveries.fad_id
      WHERE free_agent_draft_recoveries.league_id =
          OLD.league_id
        AND free_agent_draft_recoveries.season_id =
          OLD.season_id
        AND free_agent_draft_recoveries.fad_id = OLD.fad_id
        AND free_agent_draft_recoveries.allocation_id = OLD.id
        AND free_agent_draft_recoveries.player_id = OLD.player_id
        AND free_agent_draft_recoveries.kind = 'allocation_retry'
        AND free_agent_draft_recoveries.status = 'running'
        AND free_agent_draft_recoveries.created_at_ms =
          OLD.resolved_at_ms
        AND free_agent_draft_recoveries.last_error_code =
          OLD.last_error_code
        AND free_agent_draft_recoveries.updated_at_ms <=
          NEW.updated_at_ms
        AND job_runs.season_id = OLD.season_id
        AND job_runs.job_type = 'fad_allocation'
        AND job_runs.occurrence_key =
          'fad:' || OLD.fad_id || ':allocate:' || OLD.player_id
        AND job_runs.scheduled_for_ms =
          free_agent_drafts.candidate_deadline_at_ms
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.updated_at_ms <= NEW.updated_at_ms
        AND job_runs.lease_expires_at_ms >= NEW.updated_at_ms
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD allocation retry requires its exact active recovery lease'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_auction_retry_lease_update
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status = 'correction_required'
  AND OLD.decision_code = 'exact_total_and_term_tie'
  AND OLD.restricted_auction_id IS NOT NULL
  AND NEW.status = 'restricted_resolved'
  AND NEW.decision_code IN (
    'restricted_auction_result',
    'restricted_auction_no_winner'
  )
BEGIN
  SELECT CASE WHEN
    NEW.resolved_at_ms <> NEW.updated_at_ms
    OR (
      SELECT COUNT(*)
      FROM free_agent_draft_recoveries
      JOIN auctions
        ON auctions.league_id =
            free_agent_draft_recoveries.league_id
       AND auctions.season_id =
            free_agent_draft_recoveries.season_id
       AND auctions.id =
            free_agent_draft_recoveries.auction_id
       AND auctions.player_id =
            free_agent_draft_recoveries.player_id
      JOIN job_runs
        ON job_runs.league_id =
            free_agent_draft_recoveries.league_id
       AND job_runs.id =
            free_agent_draft_recoveries.job_run_id
      WHERE free_agent_draft_recoveries.league_id =
          OLD.league_id
        AND free_agent_draft_recoveries.season_id =
          OLD.season_id
        AND free_agent_draft_recoveries.fad_id = OLD.fad_id
        AND free_agent_draft_recoveries.allocation_id = OLD.id
        AND free_agent_draft_recoveries.player_id = OLD.player_id
        AND free_agent_draft_recoveries.auction_id =
          OLD.restricted_auction_id
        AND free_agent_draft_recoveries.kind =
          'auction_resolution'
        AND free_agent_draft_recoveries.status = 'running'
        AND free_agent_draft_recoveries.created_at_ms =
          OLD.resolved_at_ms
        AND free_agent_draft_recoveries.last_error_code =
          OLD.last_error_code
        AND free_agent_draft_recoveries.updated_at_ms <=
          NEW.updated_at_ms
        AND auctions.id = NEW.restricted_auction_id
        AND auctions.resolves_at_ms <= NEW.updated_at_ms
        AND auctions.updated_at_ms <= NEW.updated_at_ms
        AND auctions.status = CASE NEW.decision_code
          WHEN 'restricted_auction_result' THEN 'resolved'
          ELSE 'no_winner'
        END
        AND job_runs.season_id = OLD.season_id
        AND job_runs.job_type = 'auction.resolve.target'
        AND job_runs.occurrence_key =
          'auction:' || auctions.id || ':' ||
            auctions.resolves_at_ms
        AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.updated_at_ms <= NEW.updated_at_ms
        AND job_runs.lease_expires_at_ms >= NEW.updated_at_ms
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD restricted auction retry requires its exact active recovery lease'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_auction_failure_update
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status = 'restricted_active'
  AND NEW.status = 'correction_required'
BEGIN
  SELECT CASE WHEN
    NEW.resolved_at_ms <> NEW.updated_at_ms
    OR (
      SELECT COUNT(*)
      FROM free_agent_draft_recoveries
      JOIN auctions
        ON auctions.league_id =
            free_agent_draft_recoveries.league_id
       AND auctions.season_id =
            free_agent_draft_recoveries.season_id
       AND auctions.id =
            free_agent_draft_recoveries.auction_id
       AND auctions.player_id =
            free_agent_draft_recoveries.player_id
      WHERE free_agent_draft_recoveries.league_id =
          OLD.league_id
        AND free_agent_draft_recoveries.season_id =
          OLD.season_id
        AND free_agent_draft_recoveries.fad_id = OLD.fad_id
        AND free_agent_draft_recoveries.allocation_id = OLD.id
        AND free_agent_draft_recoveries.player_id = OLD.player_id
        AND free_agent_draft_recoveries.auction_id =
          OLD.restricted_auction_id
        AND free_agent_draft_recoveries.kind =
          'auction_resolution'
        AND free_agent_draft_recoveries.status IN (
          'pending',
          'ready',
          'running',
          'correction_required'
        )
        AND free_agent_draft_recoveries.last_error_code =
          NEW.last_error_code
        AND free_agent_draft_recoveries.created_at_ms =
          NEW.resolved_at_ms
        AND free_agent_draft_recoveries.job_run_id IS NOT NULL
        AND auctions.status IN ('failed', 'cancelled')
    ) <> 1
  THEN RAISE(
    ABORT,
    'FAD restricted auction failure requires exact auction recovery'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_resources_insert
BEFORE INSERT ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN
    NEW.winning_snapshot_entry_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id =
          NEW.league_id
        AND candidate_card_snapshot_entries.season_id =
          NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
        AND candidate_card_snapshot_entries.id =
          NEW.winning_snapshot_entry_id
        AND candidate_card_snapshot_entries.player_id =
          NEW.player_id
        AND candidate_card_snapshot_entries.team_id =
          NEW.winning_team_id
        AND candidate_card_snapshot_entries.row_kind = 'slot'
        AND candidate_card_snapshot_entries.occupant_kind =
          'candidate'
        AND candidate_card_snapshot_entries.eligibility_status
          IN ('valid', 'warning')
    )
  THEN RAISE(
    ABORT,
    'FAD allocation winner must use its valid same-FAD snapshot offer'
  ) END;

  SELECT CASE WHEN
    NEW.contract_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM contracts
      JOIN player_ownerships
        ON player_ownerships.league_id = contracts.league_id
       AND player_ownerships.id = NEW.ownership_id
       AND player_ownerships.season_id = NEW.season_id
       AND player_ownerships.player_id = NEW.player_id
       AND player_ownerships.team_id = NEW.winning_team_id
       AND player_ownerships.ownership_kind = 'Rostered'
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            contracts.league_id
       AND candidate_card_snapshot_entries.id =
            NEW.winning_snapshot_entry_id
      JOIN seasons AS target_season
        ON target_season.league_id = contracts.league_id
       AND target_season.id = NEW.season_id
      WHERE contracts.league_id = NEW.league_id
        AND contracts.id = NEW.contract_id
        AND contracts.player_id = NEW.player_id
        AND contracts.current_team_id = NEW.winning_team_id
        AND contracts.status = 'active'
        AND (
          NEW.status <> 'automatic_award'
          OR (
            contracts.contract_type = 'normal'
            AND contracts.start_season_id = NEW.season_id
            AND contracts.acquisition_source_type =
              'free_agent_draft_allocation'
            AND contracts.acquisition_source_id = NEW.id
            AND contracts.created_at_ms = NEW.resolved_at_ms
            AND contracts.auction_buyout_lock_expires_at_ms =
              NEW.resolved_at_ms + 1209600000
            AND player_ownerships.acquired_transaction_type =
              'free_agent_draft_allocation'
            AND player_ownerships.acquired_transaction_id = NEW.id
            AND player_ownerships.created_at_ms = NEW.resolved_at_ms
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
              WHERE contract_years.league_id = NEW.league_id
                AND contract_years.contract_id = NEW.contract_id
            ) = contracts.original_term_years
            AND NOT EXISTS (
              SELECT 1
              FROM contract_years
              JOIN seasons AS contract_year_season
                ON contract_year_season.league_id =
                    contract_years.league_id
               AND contract_year_season.id =
                    contract_years.season_id
              WHERE contract_years.league_id = NEW.league_id
                AND contract_years.contract_id = NEW.contract_id
                AND (
                  contract_years.year_number >
                    contracts.original_term_years
                  OR contract_years.aav_cents <>
                    contracts.aav_cents
                  OR contract_years.rollover_at_ms IS NOT NULL
                  OR contract_years.created_at_ms <>
                    NEW.resolved_at_ms
                  OR NOT (
                    (
                      contract_years.year_number = 1
                      AND contract_years.season_id = NEW.season_id
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
              candidate_card_snapshot_entries.proposed_total_value_cents
            AND contracts.original_term_years =
              candidate_card_snapshot_entries.proposed_term_years
            AND contracts.aav_cents =
              candidate_card_snapshot_entries.proposed_aav_cents
            AND (
              (
                candidate_card_snapshot_entries.slot_group IN ('F', 'D')
                AND player_ownerships.roster_category = 'Active'
              )
              OR (
                candidate_card_snapshot_entries.slot_group = 'B'
                AND player_ownerships.roster_category = 'Bench'
              )
            )
            AND player_ownerships.position_group =
              candidate_card_snapshot_entries.effective_position_group
            AND player_ownerships.slot_number =
              candidate_card_snapshot_entries.slot_number
          )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD allocation winner must match its exact contract and requested slot'
  ) END;

  SELECT CASE WHEN
    NEW.restricted_auction_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.restricted_auction_id
        AND auctions.player_id = NEW.player_id
    )
  THEN RAISE(
    ABORT,
    'FAD restricted auction must match its allocation player and season'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_resources_update
BEFORE UPDATE ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN
    NEW.winning_snapshot_entry_id IS NOT NULL
    AND (
      NEW.status = 'automatic_award'
      OR NEW.winning_snapshot_entry_id IS NOT
        OLD.winning_snapshot_entry_id
      OR NEW.winning_team_id IS NOT OLD.winning_team_id
      OR (
        NEW.status IN ('automatic_award', 'restricted_resolved')
        AND OLD.status NOT IN (
          'automatic_award',
          'restricted_resolved'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id =
          NEW.league_id
        AND candidate_card_snapshot_entries.season_id =
          NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
        AND candidate_card_snapshot_entries.id =
          NEW.winning_snapshot_entry_id
        AND candidate_card_snapshot_entries.player_id =
          NEW.player_id
        AND candidate_card_snapshot_entries.team_id =
          NEW.winning_team_id
        AND candidate_card_snapshot_entries.row_kind = 'slot'
        AND candidate_card_snapshot_entries.occupant_kind =
          'candidate'
        AND candidate_card_snapshot_entries.eligibility_status
          IN ('valid', 'warning')
    )
  THEN RAISE(
    ABORT,
    'FAD allocation winner must use its valid same-FAD snapshot offer'
  ) END;

  SELECT CASE WHEN
    NEW.contract_id IS NOT NULL
    AND (
      NEW.status = 'automatic_award'
      OR NEW.contract_id IS NOT OLD.contract_id
      OR NEW.ownership_id IS NOT OLD.ownership_id
      OR NEW.winning_snapshot_entry_id IS NOT
        OLD.winning_snapshot_entry_id
      OR NEW.winning_team_id IS NOT OLD.winning_team_id
      OR (
        NEW.status IN ('automatic_award', 'restricted_resolved')
        AND OLD.status NOT IN (
          'automatic_award',
          'restricted_resolved'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM contracts
      JOIN player_ownerships
        ON player_ownerships.league_id = contracts.league_id
       AND player_ownerships.id = NEW.ownership_id
       AND player_ownerships.season_id = NEW.season_id
       AND player_ownerships.player_id = NEW.player_id
       AND player_ownerships.team_id = NEW.winning_team_id
       AND player_ownerships.ownership_kind = 'Rostered'
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            contracts.league_id
       AND candidate_card_snapshot_entries.id =
            NEW.winning_snapshot_entry_id
      JOIN seasons AS target_season
        ON target_season.league_id = contracts.league_id
       AND target_season.id = NEW.season_id
      WHERE contracts.league_id = NEW.league_id
        AND contracts.id = NEW.contract_id
        AND contracts.player_id = NEW.player_id
        AND contracts.current_team_id = NEW.winning_team_id
        AND contracts.status = 'active'
        AND (
          NEW.status <> 'automatic_award'
          OR (
            contracts.contract_type = 'normal'
            AND contracts.start_season_id = NEW.season_id
            AND contracts.acquisition_source_type =
              'free_agent_draft_allocation'
            AND contracts.acquisition_source_id = NEW.id
            AND contracts.created_at_ms = NEW.resolved_at_ms
            AND contracts.auction_buyout_lock_expires_at_ms =
              NEW.resolved_at_ms + 1209600000
            AND player_ownerships.acquired_transaction_type =
              'free_agent_draft_allocation'
            AND player_ownerships.acquired_transaction_id = NEW.id
            AND player_ownerships.created_at_ms = NEW.resolved_at_ms
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
              WHERE contract_years.league_id = NEW.league_id
                AND contract_years.contract_id = NEW.contract_id
            ) = contracts.original_term_years
            AND NOT EXISTS (
              SELECT 1
              FROM contract_years
              JOIN seasons AS contract_year_season
                ON contract_year_season.league_id =
                    contract_years.league_id
               AND contract_year_season.id =
                    contract_years.season_id
              WHERE contract_years.league_id = NEW.league_id
                AND contract_years.contract_id = NEW.contract_id
                AND (
                  contract_years.year_number >
                    contracts.original_term_years
                  OR contract_years.aav_cents <>
                    contracts.aav_cents
                  OR contract_years.rollover_at_ms IS NOT NULL
                  OR contract_years.created_at_ms <>
                    NEW.resolved_at_ms
                  OR NOT (
                    (
                      contract_years.year_number = 1
                      AND contract_years.season_id = NEW.season_id
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
              candidate_card_snapshot_entries.proposed_total_value_cents
            AND contracts.original_term_years =
              candidate_card_snapshot_entries.proposed_term_years
            AND contracts.aav_cents =
              candidate_card_snapshot_entries.proposed_aav_cents
            AND (
              (
                candidate_card_snapshot_entries.slot_group IN ('F', 'D')
                AND player_ownerships.roster_category = 'Active'
              )
              OR (
                candidate_card_snapshot_entries.slot_group = 'B'
                AND player_ownerships.roster_category = 'Bench'
              )
            )
            AND player_ownerships.position_group =
              candidate_card_snapshot_entries.effective_position_group
            AND player_ownerships.slot_number =
              candidate_card_snapshot_entries.slot_number
          )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD allocation winner must match its exact contract and requested slot'
  ) END;

  SELECT CASE WHEN
    NEW.restricted_auction_id IS NOT NULL
    AND (
      NEW.restricted_auction_id IS NOT OLD.restricted_auction_id
      OR (
        NEW.status IN ('restricted_active', 'restricted_resolved')
        AND OLD.status NOT IN (
          'restricted_active',
          'restricted_resolved'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.restricted_auction_id
        AND auctions.player_id = NEW.player_id
    )
  THEN RAISE(
    ABORT,
    'FAD restricted auction must match its allocation player and season'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocations_corrected_ranking_update
BEFORE UPDATE ON free_agent_draft_player_allocations
WHEN NEW.status IN (
    'automatic_award',
    'restricted_resolved',
    'no_valid_offer',
    'invalid'
  )
  AND (
    NEW.decision_code = 'corrected'
    OR OLD.status = 'correction_required'
  )
BEGIN
  SELECT CASE WHEN
    NEW.status = 'automatic_award'
    AND (
      (
        SELECT COUNT(*)
        FROM candidate_card_snapshot_entries AS offer
        WHERE offer.league_id = NEW.league_id
          AND offer.season_id = NEW.season_id
          AND offer.fad_id = NEW.fad_id
          AND offer.player_id = NEW.player_id
          AND offer.row_kind = 'slot'
          AND offer.occupant_kind = 'candidate'
          AND offer.eligibility_status IN ('valid', 'warning')
          AND NOT EXISTS (
            SELECT 1
            FROM candidate_card_snapshot_entries AS competitor
            WHERE competitor.league_id = offer.league_id
              AND competitor.season_id = offer.season_id
              AND competitor.fad_id = offer.fad_id
              AND competitor.player_id = offer.player_id
              AND competitor.row_kind = 'slot'
              AND competitor.occupant_kind = 'candidate'
              AND competitor.eligibility_status IN (
                'valid',
                'warning'
              )
              AND (
                competitor.proposed_total_value_cents >
                  offer.proposed_total_value_cents
                OR (
                  competitor.proposed_total_value_cents =
                    offer.proposed_total_value_cents
                  AND competitor.proposed_aav_cents >
                    offer.proposed_aav_cents
                )
              )
          )
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM candidate_card_snapshot_entries AS offer
        WHERE offer.league_id = NEW.league_id
          AND offer.season_id = NEW.season_id
          AND offer.fad_id = NEW.fad_id
          AND offer.player_id = NEW.player_id
          AND offer.id = NEW.winning_snapshot_entry_id
          AND offer.team_id = NEW.winning_team_id
          AND offer.row_kind = 'slot'
          AND offer.occupant_kind = 'candidate'
          AND offer.eligibility_status IN ('valid', 'warning')
          AND NOT EXISTS (
            SELECT 1
            FROM candidate_card_snapshot_entries AS competitor
            WHERE competitor.league_id = offer.league_id
              AND competitor.season_id = offer.season_id
              AND competitor.fad_id = offer.fad_id
              AND competitor.player_id = offer.player_id
              AND competitor.row_kind = 'slot'
              AND competitor.occupant_kind = 'candidate'
              AND competitor.eligibility_status IN (
                'valid',
                'warning'
              )
              AND (
                competitor.proposed_total_value_cents >
                  offer.proposed_total_value_cents
                OR (
                  competitor.proposed_total_value_cents =
                    offer.proposed_total_value_cents
                  AND competitor.proposed_aav_cents >
                    offer.proposed_aav_cents
                )
              )
          )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD corrected automatic award must use its unique deterministic top offer'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'automatic_award'
    AND NEW.decision_code <> 'corrected'
    AND NOT (
      (
        NEW.decision_code = 'sole_valid_offer'
        AND (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS offer
          WHERE offer.league_id = NEW.league_id
            AND offer.season_id = NEW.season_id
            AND offer.fad_id = NEW.fad_id
            AND offer.player_id = NEW.player_id
            AND offer.row_kind = 'slot'
            AND offer.occupant_kind = 'candidate'
            AND offer.eligibility_status IN ('valid', 'warning')
        ) = 1
      )
      OR (
        NEW.decision_code = 'highest_total'
        AND (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS offer
          WHERE offer.league_id = NEW.league_id
            AND offer.season_id = NEW.season_id
            AND offer.fad_id = NEW.fad_id
            AND offer.player_id = NEW.player_id
            AND offer.row_kind = 'slot'
            AND offer.occupant_kind = 'candidate'
            AND offer.eligibility_status IN ('valid', 'warning')
        ) >= 2
        AND (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS offer
          WHERE offer.league_id = NEW.league_id
            AND offer.season_id = NEW.season_id
            AND offer.fad_id = NEW.fad_id
            AND offer.player_id = NEW.player_id
            AND offer.row_kind = 'slot'
            AND offer.occupant_kind = 'candidate'
            AND offer.eligibility_status IN ('valid', 'warning')
            AND NOT EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries AS competitor
              WHERE competitor.league_id = offer.league_id
                AND competitor.season_id = offer.season_id
                AND competitor.fad_id = offer.fad_id
                AND competitor.player_id = offer.player_id
                AND competitor.row_kind = 'slot'
                AND competitor.occupant_kind = 'candidate'
                AND competitor.eligibility_status IN (
                  'valid',
                  'warning'
                )
                AND competitor.proposed_total_value_cents >
                  offer.proposed_total_value_cents
            )
        ) = 1
      )
      OR (
        NEW.decision_code = 'highest_equal_total_aav'
        AND (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS offer
          WHERE offer.league_id = NEW.league_id
            AND offer.season_id = NEW.season_id
            AND offer.fad_id = NEW.fad_id
            AND offer.player_id = NEW.player_id
            AND offer.row_kind = 'slot'
            AND offer.occupant_kind = 'candidate'
            AND offer.eligibility_status IN ('valid', 'warning')
            AND NOT EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries AS competitor
              WHERE competitor.league_id = offer.league_id
                AND competitor.season_id = offer.season_id
                AND competitor.fad_id = offer.fad_id
                AND competitor.player_id = offer.player_id
                AND competitor.row_kind = 'slot'
                AND competitor.occupant_kind = 'candidate'
                AND competitor.eligibility_status IN (
                  'valid',
                  'warning'
                )
                AND competitor.proposed_total_value_cents >
                  offer.proposed_total_value_cents
            )
        ) >= 2
      )
    )
  THEN RAISE(
    ABORT,
    'FAD automatic award decision must match its deterministic offer class'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'restricted_resolved'
    AND (
      (
        SELECT COUNT(*)
        FROM candidate_card_snapshot_entries AS offer
        WHERE offer.league_id = NEW.league_id
          AND offer.season_id = NEW.season_id
          AND offer.fad_id = NEW.fad_id
          AND offer.player_id = NEW.player_id
          AND offer.row_kind = 'slot'
          AND offer.occupant_kind = 'candidate'
          AND offer.eligibility_status IN ('valid', 'warning')
          AND NOT EXISTS (
            SELECT 1
            FROM candidate_card_snapshot_entries AS competitor
            WHERE competitor.league_id = offer.league_id
              AND competitor.season_id = offer.season_id
              AND competitor.fad_id = offer.fad_id
              AND competitor.player_id = offer.player_id
              AND competitor.row_kind = 'slot'
              AND competitor.occupant_kind = 'candidate'
              AND competitor.eligibility_status IN (
                'valid',
                'warning'
              )
              AND (
                competitor.proposed_total_value_cents >
                  offer.proposed_total_value_cents
                OR (
                  competitor.proposed_total_value_cents =
                    offer.proposed_total_value_cents
                  AND competitor.proposed_aav_cents >
                    offer.proposed_aav_cents
                )
              )
          )
      ) < 2
      OR (
        SELECT COUNT(DISTINCT offer.proposed_term_years)
        FROM candidate_card_snapshot_entries AS offer
        WHERE offer.league_id = NEW.league_id
          AND offer.season_id = NEW.season_id
          AND offer.fad_id = NEW.fad_id
          AND offer.player_id = NEW.player_id
          AND offer.row_kind = 'slot'
          AND offer.occupant_kind = 'candidate'
          AND offer.eligibility_status IN ('valid', 'warning')
          AND NOT EXISTS (
            SELECT 1
            FROM candidate_card_snapshot_entries AS competitor
            WHERE competitor.league_id = offer.league_id
              AND competitor.season_id = offer.season_id
              AND competitor.fad_id = offer.fad_id
              AND competitor.player_id = offer.player_id
              AND competitor.row_kind = 'slot'
              AND competitor.occupant_kind = 'candidate'
              AND competitor.eligibility_status IN (
                'valid',
                'warning'
              )
              AND (
                competitor.proposed_total_value_cents >
                  offer.proposed_total_value_cents
                OR (
                  competitor.proposed_total_value_cents =
                    offer.proposed_total_value_cents
                  AND competitor.proposed_aav_cents >
                    offer.proposed_aav_cents
                )
              )
          )
      ) <> 1
      OR (
        NEW.winning_snapshot_entry_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS offer
          WHERE offer.league_id = NEW.league_id
            AND offer.season_id = NEW.season_id
            AND offer.fad_id = NEW.fad_id
            AND offer.player_id = NEW.player_id
            AND offer.id = NEW.winning_snapshot_entry_id
            AND offer.team_id = NEW.winning_team_id
            AND offer.row_kind = 'slot'
            AND offer.occupant_kind = 'candidate'
            AND offer.eligibility_status IN ('valid', 'warning')
            AND NOT EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries AS competitor
              WHERE competitor.league_id = offer.league_id
                AND competitor.season_id = offer.season_id
                AND competitor.fad_id = offer.fad_id
                AND competitor.player_id = offer.player_id
                AND competitor.row_kind = 'slot'
                AND competitor.occupant_kind = 'candidate'
                AND competitor.eligibility_status IN (
                  'valid',
                  'warning'
                )
                AND (
                  competitor.proposed_total_value_cents >
                    offer.proposed_total_value_cents
                  OR (
                    competitor.proposed_total_value_cents =
                      offer.proposed_total_value_cents
                    AND competitor.proposed_aav_cents >
                      offer.proposed_aav_cents
                  )
                )
            )
        )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD corrected restricted result requires an exact deterministic top tie'
  ) END;

  SELECT CASE WHEN
    NEW.status IN ('no_valid_offer', 'invalid')
    AND EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries AS offer
      WHERE offer.league_id = NEW.league_id
        AND offer.season_id = NEW.season_id
        AND offer.fad_id = NEW.fad_id
        AND offer.player_id = NEW.player_id
        AND offer.row_kind = 'slot'
        AND offer.occupant_kind = 'candidate'
        AND offer.eligibility_status IN ('valid', 'warning')
    )
  THEN RAISE(
    ABORT,
    'FAD corrected non-award cannot discard a valid snapshot offer'
  ) END;
END;

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
         AND winning_offer.eligibility_status IN (
              'valid',
              'warning'
            )
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
          AND contracts.created_at_ms = allocation.resolved_at_ms
          AND contracts.auction_buyout_lock_expires_at_ms =
              allocation.resolved_at_ms + 1209600000
          AND player_ownerships.acquired_transaction_type =
              'free_agent_draft_allocation'
          AND player_ownerships.acquired_transaction_id =
              allocation.id
          AND player_ownerships.created_at_ms =
              allocation.resolved_at_ms
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
                OR contract_years.rollover_at_ms IS NOT NULL
                OR contract_years.created_at_ms <>
                  allocation.resolved_at_ms
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
END;

CREATE TRIGGER free_agent_draft_allocations_immutable_delete
BEFORE DELETE ON free_agent_draft_player_allocations
BEGIN
  SELECT RAISE(ABORT, 'FAD allocation evidence cannot be deleted');
END;

CREATE TRIGGER free_agent_draft_allocation_events_evidence_insert
BEFORE INSERT ON free_agent_draft_allocation_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    JOIN free_agent_drafts
      ON free_agent_drafts.league_id =
          free_agent_draft_player_allocations.league_id
     AND free_agent_drafts.id =
          free_agent_draft_player_allocations.fad_id
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.fad_id
      AND free_agent_draft_player_allocations.id =
        NEW.allocation_id
      AND free_agent_draft_player_allocations.player_id =
        NEW.player_id
      AND free_agent_draft_player_allocations.version =
        NEW.allocation_version
      AND free_agent_draft_player_allocations.status =
        NEW.resulting_allocation_status
      AND NEW.occurred_at_ms =
        free_agent_draft_player_allocations.updated_at_ms
      AND NEW.occurred_at_ms >=
        free_agent_drafts.candidate_deadline_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD allocation event must match its current allocation version'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NOT EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries
      WHERE candidate_card_snapshot_entries.league_id =
          NEW.league_id
        AND candidate_card_snapshot_entries.season_id =
          NEW.season_id
        AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
        AND candidate_card_snapshot_entries.id =
          NEW.snapshot_entry_id
        AND candidate_card_snapshot_entries.player_id =
          NEW.player_id
        AND candidate_card_snapshot_entries.team_id = NEW.team_id
        AND candidate_card_snapshot_entries.row_kind IN (
          'slot',
          'conflict'
        )
        AND candidate_card_snapshot_entries.occupant_kind =
          'candidate'
    )
  THEN RAISE(
    ABORT,
    'FAD offer event must reference its same-FAD Candidate snapshot'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND (
      NEW.actor_authority <> 'system'
      OR NEW.resulting_allocation_status = 'pending'
    )
  THEN RAISE(
    ABORT,
    'FAD offer event must be system-authored after allocation'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      JOIN candidate_card_snapshot_entries
        ON candidate_card_snapshot_entries.league_id =
            free_agent_draft_player_allocations.league_id
       AND candidate_card_snapshot_entries.season_id =
            free_agent_draft_player_allocations.season_id
       AND candidate_card_snapshot_entries.fad_id =
            free_agent_draft_player_allocations.fad_id
       AND candidate_card_snapshot_entries.id =
            NEW.snapshot_entry_id
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
        AND NEW.offer_valid = CASE
          WHEN
            candidate_card_snapshot_entries.row_kind = 'slot'
            AND candidate_card_snapshot_entries.eligibility_status
              IN ('valid', 'warning')
            THEN 1
          ELSE 0
        END
    )
  THEN RAISE(
    ABORT,
    'FAD offer validity must match its immutable snapshot'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NOT (
      (
        NEW.offer_valid = 0
        AND NEW.rank_position IS NULL
        AND NEW.offer_outcome_code = 'invalid'
      )
      OR (
        NEW.offer_valid = 1
        AND NEW.rank_position IS NOT NULL
        AND NEW.offer_outcome_code <> 'invalid'
      )
    )
  THEN RAISE(
    ABORT,
    'FAD offer event rank and outcome must match validity'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NEW.offer_valid = 1
    AND NEW.rank_position <> 1 + (
      SELECT COUNT(*)
      FROM candidate_card_snapshot_entries AS higher_offer
      JOIN candidate_card_snapshot_entries AS current_offer
        ON current_offer.league_id = higher_offer.league_id
       AND current_offer.season_id = higher_offer.season_id
       AND current_offer.fad_id = higher_offer.fad_id
       AND current_offer.player_id = higher_offer.player_id
       AND current_offer.id = NEW.snapshot_entry_id
      WHERE higher_offer.league_id = NEW.league_id
        AND higher_offer.row_kind = 'slot'
        AND higher_offer.occupant_kind = 'candidate'
        AND higher_offer.eligibility_status IN ('valid', 'warning')
        AND (
          higher_offer.proposed_total_value_cents >
            current_offer.proposed_total_value_cents
          OR (
            higher_offer.proposed_total_value_cents =
              current_offer.proposed_total_value_cents
            AND higher_offer.proposed_aav_cents >
              current_offer.proposed_aav_cents
          )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD offer rank must match total-first AAV-second ordering'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND (
      NEW.contract_id IS NOT NULL
      OR NEW.ownership_id IS NOT NULL
      OR NEW.auction_id IS NOT NULL
      OR NEW.activity_id IS NOT NULL
      OR NEW.correction_id IS NOT NULL
    )
  THEN RAISE(
    ABORT,
    'FAD offer event cannot carry allocation result resources'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NEW.offer_outcome_code = 'winner'
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      JOIN candidate_card_snapshot_entries AS offer
        ON offer.league_id =
            free_agent_draft_player_allocations.league_id
       AND offer.season_id =
            free_agent_draft_player_allocations.season_id
       AND offer.fad_id =
            free_agent_draft_player_allocations.fad_id
       AND offer.id = NEW.snapshot_entry_id
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
        AND free_agent_draft_player_allocations.decision_code IN (
          'sole_valid_offer',
          'highest_total',
          'highest_equal_total_aav'
        )
        AND free_agent_draft_player_allocations.status IN (
          'automatic_award',
          'correction_required'
        )
        AND NEW.offer_valid = 1
        AND NEW.rank_position = 1
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS competitor
          WHERE competitor.league_id = offer.league_id
            AND competitor.season_id = offer.season_id
            AND competitor.fad_id = offer.fad_id
            AND competitor.player_id = offer.player_id
            AND competitor.row_kind = 'slot'
            AND competitor.occupant_kind = 'candidate'
            AND competitor.eligibility_status IN ('valid', 'warning')
            AND (
              competitor.proposed_total_value_cents >
                offer.proposed_total_value_cents
              OR (
                competitor.proposed_total_value_cents =
                  offer.proposed_total_value_cents
                AND competitor.proposed_aav_cents >
                  offer.proposed_aav_cents
              )
            )
        )
        AND (
          free_agent_draft_player_allocations.status <>
            'automatic_award'
          OR (
            free_agent_draft_player_allocations
              .winning_snapshot_entry_id = NEW.snapshot_entry_id
            AND free_agent_draft_player_allocations.winning_team_id =
              NEW.team_id
          )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD winner offer must be the exact top allocation offer'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NEW.offer_outcome_code = 'restricted_tied'
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_player_allocations
      JOIN candidate_card_snapshot_entries AS offer
        ON offer.league_id =
            free_agent_draft_player_allocations.league_id
       AND offer.season_id =
            free_agent_draft_player_allocations.season_id
       AND offer.fad_id =
            free_agent_draft_player_allocations.fad_id
       AND offer.id = NEW.snapshot_entry_id
      WHERE free_agent_draft_player_allocations.league_id =
          NEW.league_id
        AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
        AND free_agent_draft_player_allocations.decision_code =
          'exact_total_and_term_tie'
        AND free_agent_draft_player_allocations.status IN (
          'restricted_scheduled',
          'restricted_active',
          'correction_required',
          'deferred_restricted_recovery'
        )
        AND NEW.offer_valid = 1
        AND NEW.rank_position = 1
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS competitor
          WHERE competitor.league_id = offer.league_id
            AND competitor.season_id = offer.season_id
            AND competitor.fad_id = offer.fad_id
            AND competitor.player_id = offer.player_id
            AND competitor.row_kind = 'slot'
            AND competitor.occupant_kind = 'candidate'
            AND competitor.eligibility_status IN ('valid', 'warning')
            AND (
              competitor.proposed_total_value_cents >
                offer.proposed_total_value_cents
              OR (
                competitor.proposed_total_value_cents =
                  offer.proposed_total_value_cents
                AND competitor.proposed_aav_cents >
                  offer.proposed_aav_cents
              )
            )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD restricted offer must be an exact top tied offer'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NEW.offer_outcome_code = 'lost_lower_total'
    AND NOT EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries AS offer
      WHERE offer.league_id = NEW.league_id
        AND offer.season_id = NEW.season_id
        AND offer.fad_id = NEW.fad_id
        AND offer.id = NEW.snapshot_entry_id
        AND NEW.offer_valid = 1
        AND NEW.rank_position > 1
        AND EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS competitor
          WHERE competitor.league_id = offer.league_id
            AND competitor.season_id = offer.season_id
            AND competitor.fad_id = offer.fad_id
            AND competitor.player_id = offer.player_id
            AND competitor.row_kind = 'slot'
            AND competitor.occupant_kind = 'candidate'
            AND competitor.eligibility_status IN ('valid', 'warning')
            AND competitor.proposed_total_value_cents >
              offer.proposed_total_value_cents
        )
    )
  THEN RAISE(
    ABORT,
    'FAD lower-total offer must have a higher-total competitor'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'offer_considered'
    AND NEW.offer_outcome_code = 'lost_lower_aav'
    AND NOT EXISTS (
      SELECT 1
      FROM candidate_card_snapshot_entries AS offer
      WHERE offer.league_id = NEW.league_id
        AND offer.season_id = NEW.season_id
        AND offer.fad_id = NEW.fad_id
        AND offer.id = NEW.snapshot_entry_id
        AND NEW.offer_valid = 1
        AND NEW.rank_position > 1
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS competitor
          WHERE competitor.league_id = offer.league_id
            AND competitor.season_id = offer.season_id
            AND competitor.fad_id = offer.fad_id
            AND competitor.player_id = offer.player_id
            AND competitor.row_kind = 'slot'
            AND competitor.occupant_kind = 'candidate'
            AND competitor.eligibility_status IN ('valid', 'warning')
            AND competitor.proposed_total_value_cents >
              offer.proposed_total_value_cents
        )
        AND EXISTS (
          SELECT 1
          FROM candidate_card_snapshot_entries AS competitor
          WHERE competitor.league_id = offer.league_id
            AND competitor.season_id = offer.season_id
            AND competitor.fad_id = offer.fad_id
            AND competitor.player_id = offer.player_id
            AND competitor.row_kind = 'slot'
            AND competitor.occupant_kind = 'candidate'
            AND competitor.eligibility_status IN ('valid', 'warning')
            AND competitor.proposed_total_value_cents =
              offer.proposed_total_value_cents
            AND competitor.proposed_aav_cents >
              offer.proposed_aav_cents
        )
    )
  THEN RAISE(
    ABORT,
    'FAD lower-AAV offer must have an equal-total higher-AAV competitor'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind IN (
      'decision_recorded',
      'restricted_state_changed',
      'correction_applied'
    )
    AND NEW.event_kind <> (
      SELECT CASE
        WHEN decision_code = 'corrected'
          THEN 'correction_applied'
        WHEN restricted_auction_id IS NOT NULL
          THEN 'restricted_state_changed'
        ELSE 'decision_recorded'
      END
      FROM free_agent_draft_player_allocations
      WHERE league_id = NEW.league_id
        AND id = NEW.allocation_id
    )
  THEN RAISE(
    ABORT,
    'FAD decision event kind must match its allocation state'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind IN (
      'decision_recorded',
      'restricted_state_changed',
      'correction_applied'
    )
    AND (
      NEW.contract_id IS NOT (
        SELECT contract_id
        FROM free_agent_draft_player_allocations
        WHERE league_id = NEW.league_id
          AND id = NEW.allocation_id
      )
      OR NEW.ownership_id IS NOT (
        SELECT ownership_id
        FROM free_agent_draft_player_allocations
        WHERE league_id = NEW.league_id
          AND id = NEW.allocation_id
      )
      OR NEW.auction_id IS NOT (
        SELECT restricted_auction_id
        FROM free_agent_draft_player_allocations
        WHERE league_id = NEW.league_id
          AND id = NEW.allocation_id
      )
    )
  THEN RAISE(
    ABORT,
    'FAD decision event resources must match its allocation'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind IN (
      'decision_recorded',
      'restricted_state_changed',
      'correction_applied'
    )
    AND NEW.decision_code IS NOT (
      SELECT decision_code
      FROM free_agent_draft_player_allocations
      WHERE league_id = NEW.league_id
        AND id = NEW.allocation_id
    )
  THEN RAISE(
    ABORT,
    'FAD decision event code must match its allocation'
  ) END;

  SELECT CASE WHEN
    NEW.event_kind = 'correction_applied'
    AND NOT EXISTS (
      SELECT 1
      FROM commissioner_corrections
      WHERE commissioner_corrections.league_id = NEW.league_id
        AND commissioner_corrections.season_id = NEW.season_id
        AND commissioner_corrections.id = NEW.correction_id
        AND commissioner_corrections.feature =
          'free_agent_draft_allocation'
        AND commissioner_corrections.feature_record_id =
          NEW.allocation_id
        AND commissioner_corrections.actor_user_id =
          NEW.actor_user_id
        AND commissioner_corrections.corrected_at_ms =
          NEW.occurred_at_ms
    )
  THEN RAISE(
    ABORT,
    'FAD correction event must reference its indexed correction'
  ) END;

  SELECT CASE WHEN
    NEW.actor_authority <> 'system'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = NEW.league_id
          AND league_memberships.id = NEW.actor_membership_id
          AND league_memberships.user_id = NEW.actor_user_id
          AND league_memberships.status = 'active'
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
    'FAD allocation event actor lacks current commissioner authority'
  ) END;
END;

CREATE TRIGGER free_agent_draft_allocation_events_immutable_update
BEFORE UPDATE ON free_agent_draft_allocation_events
BEGIN
  SELECT RAISE(ABORT, 'FAD allocation event is immutable');
END;

CREATE TRIGGER free_agent_draft_allocation_events_immutable_delete
BEFORE DELETE ON free_agent_draft_allocation_events
BEGIN
  SELECT RAISE(ABORT, 'FAD allocation event is immutable');
END;

CREATE TRIGGER free_agent_draft_rollovers_setup_insert
BEFORE INSERT ON free_agent_draft_rollovers
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'scheduled'
    AND NEW.processing_started_at_ms IS NULL
    AND NEW.completed_at_ms IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND free_agent_drafts.status = 'cards_open'
        AND free_agent_drafts.opened_at_ms = NEW.created_at_ms
        AND NEW.opens_at_ms =
          free_agent_drafts.candidate_deadline_at_ms
            + (NEW.sequence - 1) * 86400000
        AND NEW.rolls_over_at_ms =
          free_agent_drafts.candidate_deadline_at_ms
            + NEW.sequence * 86400000
        AND (
          NEW.sequence <> 7
          OR NEW.rolls_over_at_ms =
            free_agent_drafts.first_matchup_starts_at_ms
        )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rollover must use its exact frozen elapsed-time window'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_forward_update
BEFORE UPDATE ON free_agent_draft_rollovers
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.sequence IS OLD.sequence
    AND NEW.opens_at_ms IS OLD.opens_at_ms
    AND NEW.creation_cutoff_at_ms IS
      OLD.creation_cutoff_at_ms
    AND NEW.rolls_over_at_ms IS OLD.rolls_over_at_ms
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'scheduled'
        AND NEW.status = 'processing'
        AND NEW.processing_started_at_ms >=
          NEW.rolls_over_at_ms
        AND NEW.updated_at_ms = NEW.processing_started_at_ms
        AND NEW.completed_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status = 'rapid'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers
          WHERE free_agent_draft_rollovers.league_id =
              NEW.league_id
            AND free_agent_draft_rollovers.season_id =
              NEW.season_id
            AND free_agent_draft_rollovers.fad_id = NEW.fad_id
            AND free_agent_draft_rollovers.sequence < NEW.sequence
            AND free_agent_draft_rollovers.status NOT IN (
              'completed',
              'recovery_required'
            )
        )
        AND EXISTS (
          SELECT 1
          FROM job_runs
          WHERE job_runs.league_id = NEW.league_id
            AND job_runs.season_id = NEW.season_id
            AND job_runs.job_type = 'fad_rollover'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':rollover:' ||
                NEW.sequence || ':' || NEW.rolls_over_at_ms
            AND job_runs.scheduled_for_ms = NEW.rolls_over_at_ms
            AND job_runs.status IN ('leased', 'running')
            AND job_runs.attempt_count >= 1
            AND job_runs.lease_owner IS NOT NULL
            AND job_runs.lease_token IS NOT NULL
            AND job_runs.lease_expires_at_ms >=
              NEW.processing_started_at_ms
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'completed'
        AND NEW.processing_started_at_ms IS
          OLD.processing_started_at_ms
        AND NEW.completed_at_ms IS NOT NULL
        AND NEW.updated_at_ms = NEW.completed_at_ms
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'recovery_required'
        AND NEW.processing_started_at_ms IS
          OLD.processing_started_at_ms
        AND NEW.completed_at_ms IS NOT NULL
        AND NEW.updated_at_ms = NEW.completed_at_ms
        AND NEW.last_error_code IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
        )
      )
      OR (
        OLD.status = 'recovery_required'
        AND NEW.status = 'processing'
        AND NEW.processing_started_at_ms >=
          OLD.completed_at_ms
        AND NEW.updated_at_ms = NEW.processing_started_at_ms
        AND NEW.completed_at_ms IS NULL
        AND NEW.last_error_code IS NULL
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id = NEW.league_id
            AND free_agent_drafts.season_id = NEW.season_id
            AND free_agent_drafts.id = NEW.fad_id
            AND free_agent_drafts.status IN ('rapid', 'completed')
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rollover may only advance through its versioned lifecycle'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_active_lease_update
BEFORE UPDATE OF status ON free_agent_draft_rollovers
WHEN (
  OLD.status = 'processing'
  AND NEW.status IN ('completed', 'recovery_required')
) OR (
  OLD.status = 'recovery_required'
  AND NEW.status = 'processing'
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_rollover'
      AND job_runs.occurrence_key =
        'fad:' || NEW.fad_id || ':rollover:' ||
          NEW.sequence || ':' || NEW.rolls_over_at_ms
      AND job_runs.scheduled_for_ms = NEW.rolls_over_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms >= CASE
        WHEN NEW.status = 'processing'
          THEN NEW.processing_started_at_ms
        ELSE NEW.completed_at_ms
      END
  ) THEN RAISE(
    ABORT,
    'FAD rollover transition requires its exact active lease'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_completion_recovery_update
BEFORE UPDATE OF status ON free_agent_draft_rollovers
WHEN NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_recoveries
    WHERE free_agent_draft_recoveries.league_id = NEW.league_id
      AND free_agent_draft_recoveries.season_id = NEW.season_id
      AND free_agent_draft_recoveries.fad_id = NEW.fad_id
      AND free_agent_draft_recoveries.rollover_id = NEW.id
      AND free_agent_draft_recoveries.kind = 'rollover_finalize'
      AND free_agent_draft_recoveries.status IN (
        'pending',
        'ready',
        'running',
        'correction_required'
      )
  ) THEN RAISE(
    ABORT,
    'FAD rollover cannot complete with unresolved recovery'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_recovery_evidence_update
BEFORE UPDATE OF status ON free_agent_draft_rollovers
WHEN OLD.status = 'processing'
  AND NEW.status = 'recovery_required'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_recoveries
    WHERE free_agent_draft_recoveries.league_id = NEW.league_id
      AND free_agent_draft_recoveries.season_id = NEW.season_id
      AND free_agent_draft_recoveries.fad_id = NEW.fad_id
      AND free_agent_draft_recoveries.rollover_id = NEW.id
      AND free_agent_draft_recoveries.kind = 'rollover_finalize'
      AND free_agent_draft_recoveries.status IN (
        'pending',
        'ready',
        'running',
        'correction_required'
      )
      AND free_agent_draft_recoveries.last_error_code =
        NEW.last_error_code
      AND free_agent_draft_recoveries.created_at_ms BETWEEN
        OLD.processing_started_at_ms AND NEW.completed_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD rollover failure requires direct recovery evidence'
  ) END;
END;

CREATE TRIGGER free_agent_draft_rollovers_immutable_delete
BEFORE DELETE ON free_agent_draft_rollovers
BEGIN
  SELECT RAISE(ABORT, 'FAD rollover evidence cannot be deleted');
END;

CREATE TRIGGER free_agent_draft_recoveries_causality_insert
BEFORE INSERT ON free_agent_draft_recoveries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status IN ('pending', 'ready', 'correction_required')
    AND NEW.resolved_at_ms IS NULL
    AND NEW.resolved_by_user_id IS NULL
    AND NEW.resolved_by_membership_id IS NULL
    AND NEW.resolved_authority IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
  ) THEN RAISE(
    ABORT,
    'FAD recovery must begin as unresolved version-1 evidence'
  ) END;

  SELECT CASE WHEN
    NEW.rollover_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_rollovers
      WHERE free_agent_draft_rollovers.league_id = NEW.league_id
        AND free_agent_draft_rollovers.season_id = NEW.season_id
        AND free_agent_draft_rollovers.fad_id = NEW.fad_id
        AND free_agent_draft_rollovers.id = NEW.rollover_id
    )
  THEN RAISE(
    ABORT,
    'FAD recovery rollover must belong to the same FAD'
  ) END;

  SELECT CASE WHEN
    NEW.auction_id IS NOT NULL
    AND (
      NEW.player_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.player_id = NEW.player_id
      )
    )
  THEN RAISE(
    ABORT,
    'FAD recovery auction must match its player and season'
  ) END;

  SELECT CASE WHEN
    NEW.job_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM job_runs
      WHERE job_runs.league_id = NEW.league_id
        AND job_runs.season_id = NEW.season_id
        AND job_runs.id = NEW.job_run_id
        AND job_runs.status IN (
          'pending',
          'leased',
          'running',
          'failed'
        )
        AND (
          (
            NEW.kind = 'deadline_retry'
            AND job_runs.job_type = 'fad_deadline'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':deadline:' ||
                (
                  SELECT candidate_deadline_at_ms
                  FROM free_agent_drafts
                  WHERE free_agent_drafts.league_id = NEW.league_id
                    AND free_agent_drafts.id = NEW.fad_id
                )
            AND job_runs.scheduled_for_ms = (
              SELECT candidate_deadline_at_ms
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = NEW.league_id
                AND free_agent_drafts.id = NEW.fad_id
            )
          )
          OR (
            NEW.kind = 'allocation_retry'
            AND job_runs.job_type = 'fad_allocation'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':allocate:' || NEW.player_id
            AND job_runs.scheduled_for_ms = (
              SELECT candidate_deadline_at_ms
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = NEW.league_id
                AND free_agent_drafts.id = NEW.fad_id
            )
          )
          OR (
            NEW.kind IN (
              'restricted_activation',
              'deferred_restricted'
            )
            AND job_runs.job_type = 'fad_restricted_activation'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':restricted-activate:' ||
                NEW.allocation_id || ':' ||
                NEW.earliest_activation_at_ms
            AND job_runs.scheduled_for_ms =
              NEW.earliest_activation_at_ms
          )
          OR (
            NEW.kind = 'auction_resolution'
            AND job_runs.job_type = 'auction.resolve.target'
            AND job_runs.occurrence_key =
              'auction:' || NEW.auction_id || ':' ||
                (
                  SELECT resolves_at_ms
                  FROM auctions
                  WHERE auctions.league_id = NEW.league_id
                    AND auctions.id = NEW.auction_id
                )
            AND job_runs.scheduled_for_ms = (
              SELECT resolves_at_ms
              FROM auctions
              WHERE auctions.league_id = NEW.league_id
                AND auctions.id = NEW.auction_id
            )
          )
          OR (
            NEW.kind = 'rollover_finalize'
            AND NEW.auction_id IS NULL
            AND job_runs.job_type = 'fad_rollover'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':rollover:' ||
                (
                  SELECT sequence
                  FROM free_agent_draft_rollovers
                  WHERE free_agent_draft_rollovers.league_id =
                      NEW.league_id
                    AND free_agent_draft_rollovers.id =
                      NEW.rollover_id
                ) || ':' ||
                (
                  SELECT rolls_over_at_ms
                  FROM free_agent_draft_rollovers
                  WHERE free_agent_draft_rollovers.league_id =
                      NEW.league_id
                    AND free_agent_draft_rollovers.id =
                      NEW.rollover_id
                )
            AND job_runs.scheduled_for_ms = (
              SELECT rolls_over_at_ms
              FROM free_agent_draft_rollovers
              WHERE free_agent_draft_rollovers.league_id =
                  NEW.league_id
                AND free_agent_draft_rollovers.id = NEW.rollover_id
            )
          )
          OR (
            NEW.kind = 'rollover_finalize'
            AND NEW.auction_id IS NOT NULL
            AND job_runs.job_type = 'auction.resolve.target'
            AND job_runs.occurrence_key =
              'auction:' || NEW.auction_id || ':' ||
                (
                  SELECT resolves_at_ms
                  FROM auctions
                  WHERE auctions.league_id = NEW.league_id
                    AND auctions.id = NEW.auction_id
                )
            AND job_runs.scheduled_for_ms = (
              SELECT resolves_at_ms
              FROM auctions
              WHERE auctions.league_id = NEW.league_id
                AND auctions.id = NEW.auction_id
            )
          )
          OR (
            NEW.kind = 'completion'
            AND job_runs.job_type = 'fad_completion'
            AND job_runs.occurrence_key =
              'fad:' || NEW.fad_id || ':complete:' ||
                (
                  SELECT first_matchup_starts_at_ms
                  FROM free_agent_drafts
                  WHERE free_agent_drafts.league_id = NEW.league_id
                    AND free_agent_drafts.id = NEW.fad_id
                )
            AND job_runs.scheduled_for_ms = (
              SELECT first_matchup_starts_at_ms
              FROM free_agent_drafts
              WHERE free_agent_drafts.league_id = NEW.league_id
                AND free_agent_drafts.id = NEW.fad_id
            )
          )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD recovery job must match its exact causal occurrence'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.kind = 'deadline_retry'
      AND EXISTS (
        SELECT 1
        FROM free_agent_drafts
        WHERE free_agent_drafts.league_id = NEW.league_id
          AND free_agent_drafts.season_id = NEW.season_id
          AND free_agent_drafts.id = NEW.fad_id
          AND free_agent_drafts.status = 'cards_open'
      )
    )
    OR (
      NEW.kind = 'allocation_retry'
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
          AND free_agent_draft_player_allocations.player_id =
            NEW.player_id
          AND (
            (
              free_agent_draft_player_allocations.status =
                'correction_required'
              AND free_agent_draft_player_allocations
                .restricted_auction_id IS NULL
              AND free_agent_draft_player_allocations
                .decision_code IN (
                  'sole_valid_offer',
                  'highest_total',
                  'highest_equal_total_aav',
                  'no_valid_offer',
                  'invalid_snapshot'
                )
            )
            OR (
              free_agent_draft_player_allocations.status IN (
                'automatic_award',
                'no_valid_offer',
                'invalid'
              )
              AND free_agent_draft_player_allocations
                .restricted_auction_id IS NULL
              AND free_agent_draft_player_allocations.updated_at_ms <=
                NEW.created_at_ms
              AND EXISTS (
                SELECT 1
                FROM free_agent_drafts
                WHERE free_agent_drafts.league_id = NEW.league_id
                  AND free_agent_drafts.season_id = NEW.season_id
                  AND free_agent_drafts.id = NEW.fad_id
                  AND free_agent_drafts.status = 'rapid'
              )
            )
          )
      )
    )
    OR (
      NEW.kind = 'restricted_activation'
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
          AND free_agent_draft_player_allocations.player_id =
            NEW.player_id
          AND (
            free_agent_draft_player_allocations.status =
              'restricted_scheduled'
            OR (
              free_agent_draft_player_allocations.status =
                'correction_required'
              AND free_agent_draft_player_allocations
                .restricted_auction_id IS NULL
              AND free_agent_draft_player_allocations.decision_code =
                'exact_total_and_term_tie'
            )
          )
      )
    )
    OR (
      NEW.kind = 'auction_resolution'
      AND EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.player_id = NEW.player_id
          AND (
            (
              auctions.status = 'failed'
              AND (
                NEW.allocation_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM free_agent_draft_player_allocations
                  WHERE free_agent_draft_player_allocations.league_id =
                      NEW.league_id
                    AND free_agent_draft_player_allocations.season_id =
                      NEW.season_id
                    AND free_agent_draft_player_allocations.fad_id =
                      NEW.fad_id
                    AND free_agent_draft_player_allocations.id =
                      NEW.allocation_id
                    AND free_agent_draft_player_allocations.player_id =
                      NEW.player_id
                    AND free_agent_draft_player_allocations
                      .restricted_auction_id = NEW.auction_id
                    AND free_agent_draft_player_allocations
                      .decision_code =
                        'exact_total_and_term_tie'
                    AND free_agent_draft_player_allocations.status IN (
                      'restricted_active',
                      'correction_required'
                    )
                )
              )
            )
            OR (
              NEW.status = 'correction_required'
              AND NEW.allocation_id IS NOT NULL
              AND auctions.status IN (
                'open',
                'resolving',
                'cancelled'
              )
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_player_allocations
                WHERE free_agent_draft_player_allocations
                    .league_id = NEW.league_id
                  AND free_agent_draft_player_allocations
                    .season_id = NEW.season_id
                  AND free_agent_draft_player_allocations.fad_id =
                    NEW.fad_id
                  AND free_agent_draft_player_allocations.id =
                    NEW.allocation_id
                  AND free_agent_draft_player_allocations
                    .player_id = NEW.player_id
                  AND free_agent_draft_player_allocations
                    .restricted_auction_id = NEW.auction_id
                  AND free_agent_draft_player_allocations.status
                    IN (
                      'restricted_active',
                      'correction_required'
                  )
              )
            )
            OR (
              NEW.allocation_id IS NOT NULL
              AND auctions.status IN (
                'resolved',
                'no_winner',
                'cancelled'
              )
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_player_allocations
                JOIN free_agent_drafts
                  ON free_agent_drafts.league_id =
                      free_agent_draft_player_allocations.league_id
                 AND free_agent_drafts.season_id =
                      free_agent_draft_player_allocations.season_id
                 AND free_agent_drafts.id =
                      free_agent_draft_player_allocations.fad_id
                WHERE free_agent_draft_player_allocations
                    .league_id = NEW.league_id
                  AND free_agent_draft_player_allocations
                    .season_id = NEW.season_id
                  AND free_agent_draft_player_allocations.fad_id =
                    NEW.fad_id
                  AND free_agent_draft_player_allocations.id =
                    NEW.allocation_id
                  AND free_agent_draft_player_allocations.player_id =
                    NEW.player_id
                  AND free_agent_draft_player_allocations
                    .restricted_auction_id = NEW.auction_id
                  AND free_agent_draft_player_allocations.status =
                    'restricted_resolved'
                  AND free_agent_draft_player_allocations.updated_at_ms <=
                    NEW.created_at_ms
                  AND free_agent_drafts.status IN (
                    'rapid',
                    'completed'
                  )
              )
            )
          )
      )
    )
    OR (
      NEW.kind = 'rollover_finalize'
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_rollovers
        WHERE free_agent_draft_rollovers.league_id = NEW.league_id
          AND free_agent_draft_rollovers.season_id = NEW.season_id
          AND free_agent_draft_rollovers.fad_id = NEW.fad_id
          AND free_agent_draft_rollovers.id = NEW.rollover_id
          AND free_agent_draft_rollovers.status IN (
            'processing',
            'recovery_required'
          )
      )
      AND NEW.job_run_id IS NOT NULL
      AND (
        NEW.auction_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM auctions
          JOIN free_agent_draft_rollovers AS causal_rollover
            ON causal_rollover.league_id = auctions.league_id
           AND causal_rollover.season_id = auctions.season_id
           AND causal_rollover.id = NEW.rollover_id
          WHERE auctions.league_id = NEW.league_id
            AND auctions.season_id = NEW.season_id
            AND auctions.id = NEW.auction_id
            AND auctions.player_id = NEW.player_id
            AND auctions.resolves_at_ms =
              causal_rollover.rolls_over_at_ms
            AND auctions.status IN (
              'failed',
              'resolved',
              'no_winner',
              'cancelled'
            )
        )
      )
    )
    OR (
      NEW.kind = 'completion'
      AND EXISTS (
        SELECT 1
        FROM free_agent_drafts
        WHERE free_agent_drafts.league_id = NEW.league_id
          AND free_agent_drafts.season_id = NEW.season_id
          AND free_agent_drafts.id = NEW.fad_id
          AND free_agent_drafts.status = 'rapid'
      )
    )
    OR (
      NEW.kind = 'deferred_restricted'
      AND NEW.job_run_id IS NOT NULL
      AND NEW.created_by_operation_id IS NOT NULL
      AND NEW.earliest_activation_at_ms >= (
        SELECT free_agent_drafts.first_matchup_starts_at_ms
        FROM free_agent_drafts
        WHERE free_agent_drafts.league_id = NEW.league_id
          AND free_agent_drafts.season_id = NEW.season_id
          AND free_agent_drafts.id = NEW.fad_id
      )
      AND (
        (
          NEW.supersedes_recovery_id IS NULL
          AND NEW.causal_started_at_ms IS NULL
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_player_allocations
            WHERE free_agent_draft_player_allocations.league_id =
                NEW.league_id
              AND free_agent_draft_player_allocations.season_id =
                NEW.season_id
              AND free_agent_draft_player_allocations.fad_id =
                NEW.fad_id
              AND free_agent_draft_player_allocations.id =
                NEW.allocation_id
              AND free_agent_draft_player_allocations.player_id =
                NEW.player_id
              AND free_agent_draft_player_allocations.status =
                'deferred_restricted_recovery'
              AND free_agent_draft_player_allocations.resolved_at_ms =
                NEW.created_at_ms
              AND free_agent_draft_player_allocations.last_error_code IS
                NEW.last_error_code
          )
        )
        OR (
          NEW.supersedes_recovery_id IS NOT NULL
          AND NEW.causal_started_at_ms IS NOT NULL
          AND NEW.earliest_activation_at_ms >= NEW.created_at_ms
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries AS predecessor
            JOIN job_runs AS predecessor_job
              ON predecessor_job.league_id = predecessor.league_id
             AND predecessor_job.id = predecessor.job_run_id
            JOIN free_agent_drafts AS draft
              ON draft.league_id = predecessor.league_id
             AND draft.season_id = predecessor.season_id
             AND draft.id = predecessor.fad_id
            JOIN seasons
              ON seasons.league_id = draft.league_id
             AND seasons.id = draft.season_id
            JOIN free_agent_draft_player_allocations AS allocation
              ON allocation.league_id = predecessor.league_id
             AND allocation.season_id = predecessor.season_id
             AND allocation.fad_id = predecessor.fad_id
             AND allocation.id = predecessor.allocation_id
             AND allocation.player_id = predecessor.player_id
            WHERE predecessor.league_id = NEW.league_id
              AND predecessor.season_id = NEW.season_id
              AND predecessor.fad_id = NEW.fad_id
              AND predecessor.id = NEW.supersedes_recovery_id
              AND predecessor.player_id = NEW.player_id
              AND predecessor.allocation_id = NEW.allocation_id
              AND predecessor.kind = 'deferred_restricted'
              AND predecessor.status = 'running'
              AND predecessor.last_error_code IS NEW.last_error_code
              AND predecessor.created_by_operation_id IS
                NEW.created_by_operation_id
              AND COALESCE(
                predecessor.causal_started_at_ms,
                predecessor.created_at_ms
              ) = NEW.causal_started_at_ms
              AND predecessor.updated_at_ms <= NEW.created_at_ms
              AND predecessor.target_resolution_at_ms <=
                NEW.created_at_ms + 3600000
              AND NEW.created_at_ms >= draft.completed_at_ms
              AND NEW.earliest_activation_at_ms >
                predecessor.earliest_activation_at_ms
              AND NEW.earliest_activation_at_ms >=
                predecessor.target_resolution_at_ms
              AND NEW.job_run_id IS NOT predecessor.job_run_id
              AND allocation.status =
                'deferred_restricted_recovery'
              AND allocation.resolved_at_ms =
                NEW.causal_started_at_ms
              AND allocation.last_error_code IS NEW.last_error_code
              AND draft.status = 'completed'
              AND seasons.free_agent_draft_completed_at_ms =
                draft.completed_at_ms
              AND (
                predecessor.supersedes_recovery_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM free_agent_draft_recoveries AS ancestor
                  WHERE ancestor.league_id =
                      predecessor.league_id
                    AND ancestor.id =
                      predecessor.supersedes_recovery_id
                    AND ancestor.status = 'resolved'
                    AND ancestor.resolved_at_ms <=
                      NEW.created_at_ms
                )
              )
              AND predecessor_job.status IN ('leased', 'running')
              AND predecessor_job.attempt_count >= 1
              AND predecessor_job.lease_owner IS NOT NULL
              AND predecessor_job.lease_token IS NOT NULL
              AND predecessor_job.lease_expires_at_ms >=
                NEW.created_at_ms
              AND NOT EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries AS existing_successor
                WHERE existing_successor.league_id =
                    predecessor.league_id
                  AND existing_successor.supersedes_recovery_id =
                    predecessor.id
              )
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery kind does not match its current causal state'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recoveries_forward_update
BEFORE UPDATE ON free_agent_draft_recoveries
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.rollover_id IS OLD.rollover_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.job_run_id IS OLD.job_run_id
    AND NEW.supersedes_recovery_id IS
      OLD.supersedes_recovery_id
    AND NEW.causal_started_at_ms IS OLD.causal_started_at_ms
    AND NEW.kind IS OLD.kind
    AND NEW.earliest_activation_at_ms IS
      OLD.earliest_activation_at_ms
    AND NEW.target_resolution_at_ms IS
      OLD.target_resolution_at_ms
    AND NEW.created_by_operation_id IS
      OLD.created_by_operation_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND (
      (
        OLD.status = 'pending'
        AND NEW.status IN (
          'ready',
          'running',
          'correction_required'
        )
      )
      OR (
        OLD.status = 'ready'
        AND NEW.status IN (
          'running',
          'correction_required'
        )
      )
      OR (
        OLD.status = 'running'
        AND NEW.status IN (
          'ready',
          'resolved',
          'correction_required'
        )
      )
      OR (
        OLD.status = 'correction_required'
        AND NEW.status IN (
          'ready',
          'running',
          'resolved'
        )
      )
    )
    AND (
      NEW.status <> 'resolved'
      OR (
        NEW.updated_at_ms = NEW.resolved_at_ms
        AND NEW.resolved_at_ms >= OLD.updated_at_ms
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery may only advance through its versioned lifecycle'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recovery_job_identity_update
BEFORE UPDATE OF
  league_id,
  season_id,
  job_type,
  occurrence_key,
  scheduled_for_ms
ON job_runs
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_recoveries
  WHERE free_agent_draft_recoveries.job_run_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD recovery job causal identity is immutable'
  );
END;

CREATE TRIGGER free_agent_draft_recovery_job_terminal_update
BEFORE UPDATE OF status ON job_runs
WHEN NEW.status IN ('succeeded', 'skipped')
  AND EXISTS (
    SELECT 1
    FROM free_agent_draft_recoveries
    WHERE free_agent_draft_recoveries.job_run_id = OLD.id
      AND (
        free_agent_draft_recoveries.status <> 'resolved'
        OR free_agent_draft_recoveries.resolved_at_ms >
          NEW.updated_at_ms
      )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD recovery job cannot become terminal before recovery resolves'
  );
END;

CREATE TRIGGER free_agent_draft_recoveries_terminal_update
BEFORE UPDATE OF status ON free_agent_draft_recoveries
WHEN NEW.status = 'resolved'
BEGIN
  SELECT CASE WHEN
    NEW.kind IN (
      'restricted_activation',
      'deferred_restricted'
    )
    AND NEW.resolved_at_ms < NEW.earliest_activation_at_ms
  THEN RAISE(
    ABORT,
    'FAD restricted recovery cannot resolve before activation'
  ) END;

  SELECT CASE WHEN
    NEW.kind = 'auction_resolution'
    AND (
      SELECT auctions.status
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.auction_id
    ) <> 'cancelled'
    AND NEW.resolved_at_ms < (
      SELECT auctions.resolves_at_ms
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.auction_id
    )
  THEN RAISE(
    ABORT,
    'FAD auction recovery cannot resolve before its target'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.kind = 'deadline_retry'
      AND EXISTS (
        SELECT 1
        FROM free_agent_drafts
        WHERE free_agent_drafts.league_id = NEW.league_id
          AND free_agent_drafts.season_id = NEW.season_id
          AND free_agent_drafts.id = NEW.fad_id
          AND free_agent_drafts.status <> 'cards_open'
          AND free_agent_drafts.updated_at_ms <= NEW.resolved_at_ms
      )
    )
    OR (
      NEW.kind = 'allocation_retry'
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_player_allocations
        WHERE free_agent_draft_player_allocations.league_id =
            NEW.league_id
          AND free_agent_draft_player_allocations.id =
            NEW.allocation_id
          AND free_agent_draft_player_allocations.status IN (
            'automatic_award',
            'restricted_scheduled',
            'restricted_active',
            'restricted_resolved',
            'no_valid_offer',
            'invalid',
            'deferred_restricted_recovery'
          )
          AND free_agent_draft_player_allocations.updated_at_ms <=
            NEW.resolved_at_ms
      )
    )
    OR (
      NEW.kind = 'restricted_activation'
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_player_allocations
        WHERE free_agent_draft_player_allocations.league_id =
            NEW.league_id
          AND free_agent_draft_player_allocations.id =
            NEW.allocation_id
          AND free_agent_draft_player_allocations.status IN (
            'restricted_active',
            'restricted_resolved'
          )
          AND free_agent_draft_player_allocations.updated_at_ms <=
            NEW.resolved_at_ms
      )
    )
    OR (
      NEW.kind = 'auction_resolution'
      AND EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = NEW.league_id
          AND auctions.season_id = NEW.season_id
          AND auctions.id = NEW.auction_id
          AND auctions.player_id = NEW.player_id
          AND auctions.status IN (
            'resolved',
            'no_winner',
            'cancelled'
          )
          AND auctions.updated_at_ms <= NEW.resolved_at_ms
          AND (
            NEW.allocation_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM free_agent_draft_player_allocations
              WHERE free_agent_draft_player_allocations.league_id =
                  NEW.league_id
                AND free_agent_draft_player_allocations.season_id =
                  NEW.season_id
                AND free_agent_draft_player_allocations.fad_id =
                  NEW.fad_id
                AND free_agent_draft_player_allocations.id =
                  NEW.allocation_id
                AND free_agent_draft_player_allocations.player_id =
                  NEW.player_id
                AND free_agent_draft_player_allocations.status IN (
                  'automatic_award',
                  'restricted_resolved',
                  'no_valid_offer',
                  'invalid'
                )
                AND free_agent_draft_player_allocations.updated_at_ms <=
                  NEW.resolved_at_ms
            )
          )
      )
    )
    OR (
      NEW.kind = 'rollover_finalize'
      AND (
        (
          NEW.auction_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_rollovers
            JOIN job_runs
              ON job_runs.league_id =
                  free_agent_draft_rollovers.league_id
             AND job_runs.id = NEW.job_run_id
            WHERE free_agent_draft_rollovers.league_id =
                NEW.league_id
              AND free_agent_draft_rollovers.id =
                NEW.rollover_id
              AND free_agent_draft_rollovers.status =
                'processing'
              AND free_agent_draft_rollovers.updated_at_ms <=
                NEW.resolved_at_ms
              AND job_runs.status IN ('leased', 'running')
              AND job_runs.attempt_count >= 1
              AND job_runs.lease_owner IS NOT NULL
              AND job_runs.lease_token IS NOT NULL
              AND job_runs.lease_expires_at_ms >=
                NEW.resolved_at_ms
          )
        )
        OR (
          NEW.auction_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_rollovers
            JOIN auctions
              ON auctions.league_id =
                  free_agent_draft_rollovers.league_id
             AND auctions.season_id =
                  free_agent_draft_rollovers.season_id
             AND auctions.id = NEW.auction_id
            WHERE free_agent_draft_rollovers.league_id =
                NEW.league_id
              AND free_agent_draft_rollovers.id =
                NEW.rollover_id
              AND free_agent_draft_rollovers.status IN (
                'processing',
                'recovery_required'
              )
              AND auctions.player_id = NEW.player_id
              AND auctions.status IN (
                'resolved',
                'no_winner',
                'cancelled'
              )
              AND auctions.updated_at_ms <= NEW.resolved_at_ms
          )
        )
      )
    )
    OR (
      NEW.kind = 'completion'
      AND EXISTS (
        SELECT 1
        FROM free_agent_drafts
        JOIN seasons
          ON seasons.league_id = free_agent_drafts.league_id
         AND seasons.id = free_agent_drafts.season_id
        WHERE free_agent_drafts.league_id = NEW.league_id
          AND free_agent_drafts.season_id = NEW.season_id
          AND free_agent_drafts.id = NEW.fad_id
          AND free_agent_drafts.status = 'completed'
          AND free_agent_drafts.updated_at_ms <= NEW.resolved_at_ms
          AND seasons.free_agent_draft_completed_at_ms =
            free_agent_drafts.completed_at_ms
      )
    )
    OR (
      NEW.kind = 'deferred_restricted'
      AND (
        EXISTS (
          SELECT 1
          FROM free_agent_draft_player_allocations
          WHERE free_agent_draft_player_allocations.league_id =
              NEW.league_id
            AND free_agent_draft_player_allocations.id =
              NEW.allocation_id
            AND free_agent_draft_player_allocations.status IN (
              'restricted_active',
              'restricted_resolved'
            )
            AND free_agent_draft_player_allocations.updated_at_ms <=
              NEW.resolved_at_ms
        )
        OR (
          OLD.status = 'running'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_player_allocations
            WHERE free_agent_draft_player_allocations.league_id =
                NEW.league_id
              AND free_agent_draft_player_allocations.season_id =
                NEW.season_id
              AND free_agent_draft_player_allocations.fad_id =
                NEW.fad_id
              AND free_agent_draft_player_allocations.id =
                NEW.allocation_id
              AND free_agent_draft_player_allocations.player_id =
                NEW.player_id
              AND free_agent_draft_player_allocations.status =
                'deferred_restricted_recovery'
              AND free_agent_draft_player_allocations.resolved_at_ms =
                COALESCE(
                  NEW.causal_started_at_ms,
                  NEW.created_at_ms
                )
              AND free_agent_draft_player_allocations.last_error_code IS
                NEW.last_error_code
          )
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries AS successor
            JOIN job_runs AS successor_job
              ON successor_job.league_id = successor.league_id
             AND successor_job.id = successor.job_run_id
            WHERE successor.league_id = NEW.league_id
              AND successor.season_id = NEW.season_id
              AND successor.fad_id = NEW.fad_id
              AND successor.supersedes_recovery_id = NEW.id
              AND successor.player_id = NEW.player_id
              AND successor.allocation_id = NEW.allocation_id
              AND successor.kind = 'deferred_restricted'
              AND successor.status IN (
                'pending',
                'ready',
                'running',
                'correction_required'
              )
              AND successor.last_error_code IS NEW.last_error_code
              AND successor.created_by_operation_id IS
                NEW.created_by_operation_id
              AND successor.causal_started_at_ms = COALESCE(
                NEW.causal_started_at_ms,
                NEW.created_at_ms
              )
              AND successor.created_at_ms >= OLD.updated_at_ms
              AND successor.created_at_ms <= NEW.resolved_at_ms
              AND successor_job.season_id = successor.season_id
              AND successor_job.job_type =
                'fad_restricted_activation'
              AND successor_job.occurrence_key =
                'fad:' || successor.fad_id ||
                  ':restricted-activate:' ||
                  successor.allocation_id || ':' ||
                  successor.earliest_activation_at_ms
              AND successor_job.scheduled_for_ms =
                successor.earliest_activation_at_ms
              AND successor_job.status IN (
                'pending',
                'leased',
                'running',
                'failed'
              )
          )
        )
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD recovery cannot resolve before its causal state is terminal'
  ) END;

  SELECT CASE WHEN
    NEW.resolved_authority <> 'system'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = NEW.league_id
          AND league_memberships.id = NEW.resolved_by_membership_id
          AND league_memberships.user_id = NEW.resolved_by_user_id
          AND league_memberships.status = 'active'
      )
      OR (
        NEW.resolved_authority = 'commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = NEW.league_id
            AND leagues.commissioner_membership_id =
              NEW.resolved_by_membership_id
        )
      )
      OR (
        NEW.resolved_authority =
          'platform_administrator_as_commissioner'
        AND NOT EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = NEW.resolved_by_user_id
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
        )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD recovery resolver lacks current commissioner authority'
  ) END;
END;

CREATE TRIGGER free_agent_draft_recoveries_immutable_delete
BEFORE DELETE ON free_agent_draft_recoveries
BEGIN
  SELECT RAISE(ABORT, 'FAD recovery evidence cannot be deleted');
END;

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
      AND free_agent_draft_rollovers.status <> 'scheduled'
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
  ) THEN RAISE(
    ABORT,
    'FAD deadline requires one pending allocation per candidate player'
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
      AND job_runs.lease_expires_at_ms >=
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

CREATE TRIGGER free_agent_drafts_allocation_start_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'deadline_locked'
  AND NEW.status = 'allocating'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD with no candidate allocations must enter rapid directly'
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
        free_agent_draft_player_allocations.status <> 'pending'
        OR (
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
      )
  ) THEN RAISE(
    ABORT,
    'FAD allocation start requires pending durable per-player work'
  ) END;
END;

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
      AND free_agent_draft_player_allocations.updated_at_ms >
        NEW.allocation_completed_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase cannot precede current allocation evidence'
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
        OR NOT EXISTS (
          SELECT 1
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
            AND free_agent_draft_allocation_events.event_kind IN (
              'decision_recorded',
              'restricted_state_changed',
              'correction_applied'
            )
            AND free_agent_draft_allocation_events
              .resulting_allocation_status =
                free_agent_draft_player_allocations.status
        )
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
    'FAD rapid phase requires every allocation decision to be evidenced'
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
       AND candidate_card_snapshot_entries.eligibility_status
            IN ('valid', 'warning')
    ),
    maximum_totals AS (
      SELECT
        allocation_id,
        MAX(total_value_cents) AS total_value_cents
      FROM valid_offers
      GROUP BY allocation_id
    ),
    top_total_offers AS (
      SELECT valid_offers.*
      FROM valid_offers
      JOIN maximum_totals
        ON maximum_totals.allocation_id =
            valid_offers.allocation_id
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
       AND maximum_aavs.aav_cents =
            top_total_offers.aav_cents
    ),
    valid_counts AS (
      SELECT allocation_id, COUNT(*) AS valid_count
      FROM valid_offers
      GROUP BY allocation_id
    ),
    top_total_counts AS (
      SELECT allocation_id, COUNT(*) AS top_total_count
      FROM top_total_offers
      GROUP BY allocation_id
    ),
    top_counts AS (
      SELECT
        allocation_id,
        COUNT(*) AS top_count,
        COUNT(DISTINCT term_years) AS top_term_count
      FROM top_offers
      GROUP BY allocation_id
    ),
    event_counts AS (
      SELECT
        current_allocations.id AS allocation_id,
        COUNT(free_agent_draft_allocation_events.id)
          AS offer_count,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_valid = 1
        ), 0) AS valid_event_count,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'winner'
        ), 0) AS winner_count,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'restricted_tied'
        ), 0) AS restricted_count,
        COALESCE(SUM(
          free_agent_draft_allocation_events.offer_outcome_code =
            'invalid'
        ), 0) AS invalid_count
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
    LEFT JOIN valid_counts
      ON valid_counts.allocation_id = current_allocations.id
    LEFT JOIN top_total_counts
      ON top_total_counts.allocation_id = current_allocations.id
    LEFT JOIN top_counts
      ON top_counts.allocation_id = current_allocations.id
    JOIN event_counts
      ON event_counts.allocation_id = current_allocations.id
    WHERE current_allocations.decision_code NOT IN (
      'sole_valid_offer',
      'highest_total',
      'highest_equal_total_aav',
      'exact_total_and_term_tie',
      'no_valid_offer',
      'invalid_snapshot'
    )
    OR (
      current_allocations.decision_code IN (
        'sole_valid_offer',
        'highest_total',
        'highest_equal_total_aav'
      )
      AND (
        event_counts.winner_count <> 1
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code = 'sole_valid_offer'
      AND COALESCE(valid_counts.valid_count, 0) <> 1
    )
    OR (
      current_allocations.decision_code = 'highest_total'
      AND (
        COALESCE(valid_counts.valid_count, 0) < 2
        OR COALESCE(top_total_counts.top_total_count, 0) <> 1
      )
    )
    OR (
      current_allocations.decision_code =
        'highest_equal_total_aav'
      AND (
        COALESCE(top_total_counts.top_total_count, 0) < 2
        OR COALESCE(top_counts.top_count, 0) <> 1
      )
    )
    OR (
      current_allocations.decision_code =
        'exact_total_and_term_tie'
      AND (
        COALESCE(top_counts.top_count, 0) < 2
        OR COALESCE(top_counts.top_term_count, 0) <> 1
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <>
          COALESCE(top_counts.top_count, 0)
      )
    )
    OR (
      current_allocations.decision_code = 'no_valid_offer'
      AND (
        COALESCE(valid_counts.valid_count, 0) <> 0
        OR event_counts.valid_event_count <> 0
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> 0
      )
    )
    OR (
      current_allocations.decision_code = 'invalid_snapshot'
      AND (
        COALESCE(valid_counts.valid_count, 0) <> 0
        OR event_counts.valid_event_count <> 0
        OR event_counts.invalid_count <> event_counts.offer_count
        OR event_counts.winner_count <> 0
        OR event_counts.restricted_count <> 0
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires deterministic offer ranking evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status =
        'correction_required'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            free_agent_draft_player_allocations.league_id
          AND free_agent_draft_recoveries.season_id =
            free_agent_draft_player_allocations.season_id
          AND free_agent_draft_recoveries.fad_id =
            free_agent_draft_player_allocations.fad_id
          AND free_agent_draft_recoveries.allocation_id =
            free_agent_draft_player_allocations.id
          AND free_agent_draft_recoveries.player_id =
            free_agent_draft_player_allocations.player_id
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code =
            free_agent_draft_player_allocations.last_error_code
          AND free_agent_draft_recoveries.created_at_ms =
            free_agent_draft_player_allocations.resolved_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
          AND (
            (
              free_agent_draft_player_allocations
                .restricted_auction_id IS NOT NULL
              AND free_agent_draft_recoveries.kind =
                'auction_resolution'
              AND free_agent_draft_recoveries.auction_id =
                free_agent_draft_player_allocations
                  .restricted_auction_id
              AND free_agent_draft_recoveries
                .earliest_activation_at_ms IS NULL
              AND free_agent_draft_recoveries
                .target_resolution_at_ms IS NULL
            )
            OR (
              free_agent_draft_player_allocations
                .restricted_auction_id IS NULL
              AND free_agent_draft_player_allocations.decision_code =
                'exact_total_and_term_tie'
              AND free_agent_draft_recoveries.kind =
                'restricted_activation'
              AND free_agent_draft_recoveries
                .earliest_activation_at_ms IS NOT NULL
              AND free_agent_draft_recoveries
                .target_resolution_at_ms IS NOT NULL
            )
            OR (
              free_agent_draft_player_allocations
                .restricted_auction_id IS NULL
              AND
              free_agent_draft_player_allocations.decision_code <>
                'exact_total_and_term_tie'
              AND free_agent_draft_recoveries.kind =
                'allocation_retry'
              AND free_agent_draft_recoveries
                .earliest_activation_at_ms IS NULL
              AND free_agent_draft_recoveries
                .target_resolution_at_ms IS NULL
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires correction-required allocation recovery'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status =
        'deferred_restricted_recovery'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            free_agent_draft_player_allocations.league_id
          AND free_agent_draft_recoveries.season_id =
            free_agent_draft_player_allocations.season_id
          AND free_agent_draft_recoveries.fad_id =
            free_agent_draft_player_allocations.fad_id
          AND free_agent_draft_recoveries.allocation_id =
            free_agent_draft_player_allocations.id
          AND free_agent_draft_recoveries.player_id =
            free_agent_draft_player_allocations.player_id
          AND free_agent_draft_recoveries.kind =
            'deferred_restricted'
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code =
            free_agent_draft_player_allocations.last_error_code
          AND free_agent_draft_recoveries.created_at_ms =
            free_agent_draft_player_allocations.resolved_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
          AND free_agent_draft_recoveries
            .earliest_activation_at_ms >=
              free_agent_draft_player_allocations.resolved_at_ms
          AND free_agent_draft_recoveries
            .earliest_activation_at_ms >=
              NEW.first_matchup_starts_at_ms
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_rollovers AS final_rollover
            WHERE final_rollover.league_id =
                free_agent_draft_player_allocations.league_id
              AND final_rollover.season_id =
                free_agent_draft_player_allocations.season_id
              AND final_rollover.fad_id =
                free_agent_draft_player_allocations.fad_id
              AND final_rollover.sequence = 7
              AND free_agent_draft_player_allocations.resolved_at_ms >=
                final_rollover.creation_cutoff_at_ms
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires deferred restricted recovery'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status =
        'restricted_scheduled'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            free_agent_draft_player_allocations.league_id
          AND free_agent_draft_recoveries.season_id =
            free_agent_draft_player_allocations.season_id
          AND free_agent_draft_recoveries.fad_id =
            free_agent_draft_player_allocations.fad_id
          AND free_agent_draft_recoveries.allocation_id =
            free_agent_draft_player_allocations.id
          AND free_agent_draft_recoveries.player_id =
            free_agent_draft_player_allocations.player_id
          AND free_agent_draft_recoveries.kind =
            'restricted_activation'
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code IS NULL
          AND free_agent_draft_recoveries.created_at_ms =
            free_agent_draft_player_allocations.resolved_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_rollovers AS target_rollover
            JOIN free_agent_draft_rollovers AS prior_rollover
              ON prior_rollover.league_id =
                  target_rollover.league_id
             AND prior_rollover.season_id =
                  target_rollover.season_id
             AND prior_rollover.fad_id = target_rollover.fad_id
             AND prior_rollover.sequence =
                  target_rollover.sequence - 1
            WHERE target_rollover.league_id =
                free_agent_draft_recoveries.league_id
              AND target_rollover.season_id =
                free_agent_draft_recoveries.season_id
              AND target_rollover.fad_id =
                free_agent_draft_recoveries.fad_id
              AND target_rollover.id =
                free_agent_draft_recoveries.rollover_id
              AND target_rollover.rolls_over_at_ms =
                free_agent_draft_recoveries
                  .target_resolution_at_ms
              AND prior_rollover.rolls_over_at_ms =
                free_agent_draft_recoveries
                  .earliest_activation_at_ms
              AND free_agent_draft_player_allocations.resolved_at_ms >=
                prior_rollover.creation_cutoff_at_ms
              AND free_agent_draft_player_allocations.resolved_at_ms <
                prior_rollover.rolls_over_at_ms
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rapid phase requires restricted scheduled activation recovery'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_final_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status NOT IN (
        'automatic_award',
        'restricted_resolved',
        'no_valid_offer',
        'invalid',
        'correction_required',
        'deferred_restricted_recovery'
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires every allocation to be final or recoverable'
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
          AND free_agent_draft_allocation_events.auction_id IS
            free_agent_draft_player_allocations
              .restricted_auction_id
          AND free_agent_draft_allocation_events.occurred_at_ms =
            free_agent_draft_player_allocations.updated_at_ms
          AND free_agent_draft_allocation_events.event_kind = CASE
            WHEN free_agent_draft_player_allocations.decision_code =
              'corrected'
              THEN 'correction_applied'
            WHEN free_agent_draft_player_allocations
              .restricted_auction_id IS NOT NULL
              THEN 'restricted_state_changed'
            ELSE 'decision_recorded'
          END
      ) <> 1
  ) THEN RAISE(
    ABORT,
    'FAD completion requires exact current allocation evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    JOIN free_agent_draft_recoveries
      ON free_agent_draft_recoveries.league_id =
          free_agent_draft_player_allocations.league_id
     AND free_agent_draft_recoveries.season_id =
          free_agent_draft_player_allocations.season_id
     AND free_agent_draft_recoveries.fad_id =
          free_agent_draft_player_allocations.fad_id
     AND free_agent_draft_recoveries.allocation_id =
          free_agent_draft_player_allocations.id
     AND free_agent_draft_recoveries.player_id =
          free_agent_draft_player_allocations.player_id
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status IN (
        'automatic_award',
        'restricted_resolved',
        'no_valid_offer',
        'invalid'
      )
      AND free_agent_draft_recoveries.kind IN (
        'allocation_retry',
        'restricted_activation',
        'auction_resolution',
        'deferred_restricted'
      )
      AND free_agent_draft_recoveries.status IN (
        'pending',
        'ready',
        'running',
        'correction_required'
      )
  ) THEN RAISE(
    ABORT,
    'FAD terminal allocation cannot retain unresolved recovery'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status =
        'correction_required'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            free_agent_draft_player_allocations.league_id
          AND free_agent_draft_recoveries.season_id =
            free_agent_draft_player_allocations.season_id
          AND free_agent_draft_recoveries.fad_id =
            free_agent_draft_player_allocations.fad_id
          AND free_agent_draft_recoveries.allocation_id =
            free_agent_draft_player_allocations.id
          AND free_agent_draft_recoveries.player_id =
            free_agent_draft_player_allocations.player_id
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code =
            free_agent_draft_player_allocations.last_error_code
          AND free_agent_draft_recoveries.created_at_ms =
            free_agent_draft_player_allocations.resolved_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
          AND (
            (
              free_agent_draft_player_allocations
                .restricted_auction_id IS NOT NULL
              AND free_agent_draft_recoveries.kind =
                'auction_resolution'
              AND free_agent_draft_recoveries.auction_id =
                free_agent_draft_player_allocations
                  .restricted_auction_id
              AND free_agent_draft_recoveries
                .earliest_activation_at_ms IS NULL
              AND free_agent_draft_recoveries
                .target_resolution_at_ms IS NULL
            )
            OR (
              free_agent_draft_player_allocations
                .restricted_auction_id IS NULL
              AND free_agent_draft_player_allocations.decision_code =
                'exact_total_and_term_tie'
              AND free_agent_draft_recoveries.kind =
                'restricted_activation'
              AND free_agent_draft_recoveries
                .earliest_activation_at_ms IS NOT NULL
              AND free_agent_draft_recoveries
                .target_resolution_at_ms IS NOT NULL
            )
            OR (
              free_agent_draft_player_allocations
                .restricted_auction_id IS NULL
              AND
              free_agent_draft_player_allocations.decision_code <>
                'exact_total_and_term_tie'
              AND free_agent_draft_recoveries.kind =
                'allocation_retry'
              AND free_agent_draft_recoveries
                .earliest_activation_at_ms IS NULL
              AND free_agent_draft_recoveries
                .target_resolution_at_ms IS NULL
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD correction-required allocation needs durable recovery'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.status =
        'deferred_restricted_recovery'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            free_agent_draft_player_allocations.league_id
          AND free_agent_draft_recoveries.season_id =
            free_agent_draft_player_allocations.season_id
          AND free_agent_draft_recoveries.fad_id =
            free_agent_draft_player_allocations.fad_id
          AND free_agent_draft_recoveries.allocation_id =
            free_agent_draft_player_allocations.id
          AND free_agent_draft_recoveries.player_id =
            free_agent_draft_player_allocations.player_id
          AND free_agent_draft_recoveries.kind =
            'deferred_restricted'
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.last_error_code =
            free_agent_draft_player_allocations.last_error_code
          AND free_agent_draft_recoveries.created_at_ms =
            free_agent_draft_player_allocations.resolved_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
          AND free_agent_draft_recoveries
            .earliest_activation_at_ms >=
              free_agent_draft_player_allocations.resolved_at_ms
          AND free_agent_draft_recoveries
            .earliest_activation_at_ms >=
              NEW.first_matchup_starts_at_ms
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_rollovers AS final_rollover
            WHERE final_rollover.league_id =
                free_agent_draft_player_allocations.league_id
              AND final_rollover.season_id =
                free_agent_draft_player_allocations.season_id
              AND final_rollover.fad_id =
                free_agent_draft_player_allocations.fad_id
              AND final_rollover.sequence = 7
              AND free_agent_draft_player_allocations.resolved_at_ms >=
                final_rollover.creation_cutoff_at_ms
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD deferred restricted allocation needs durable recovery'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.status IN (
        'completed',
        'recovery_required'
      )
  ) <> 7 THEN RAISE(
    ABORT,
    'FAD completion requires seven accounted rollovers'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.status = 'recovery_required'
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            free_agent_draft_rollovers.league_id
          AND free_agent_draft_recoveries.season_id =
            free_agent_draft_rollovers.season_id
          AND free_agent_draft_recoveries.fad_id =
            free_agent_draft_rollovers.fad_id
          AND free_agent_draft_recoveries.rollover_id =
            free_agent_draft_rollovers.id
          AND free_agent_draft_recoveries.kind =
            'rollover_finalize'
          AND free_agent_draft_recoveries.last_error_code =
            free_agent_draft_rollovers.last_error_code
          AND free_agent_draft_recoveries.created_at_ms BETWEEN
            free_agent_draft_rollovers.processing_started_at_ms
            AND free_agent_draft_rollovers.completed_at_ms
          AND free_agent_draft_recoveries.job_run_id IS NOT NULL
      )
  ) THEN RAISE(
    ABORT,
    'FAD recovery-required rollover needs direct causal recovery'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.sequence = 7
      AND NEW.completed_at_ms >=
        free_agent_draft_rollovers.rolls_over_at_ms
      AND free_agent_draft_rollovers.rolls_over_at_ms =
        NEW.first_matchup_starts_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD completion cannot precede the seventh rollover'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.completed_at_ms >
        NEW.completed_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD completion cannot precede actual rollover completion'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND free_agent_draft_player_allocations.updated_at_ms >
        NEW.completed_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD completion cannot precede current allocation evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    JOIN free_agent_draft_recoveries
      ON free_agent_draft_recoveries.league_id =
          free_agent_draft_rollovers.league_id
     AND free_agent_draft_recoveries.season_id =
          free_agent_draft_rollovers.season_id
     AND free_agent_draft_recoveries.fad_id =
          free_agent_draft_rollovers.fad_id
     AND free_agent_draft_recoveries.rollover_id =
          free_agent_draft_rollovers.id
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND free_agent_draft_rollovers.status = 'completed'
      AND free_agent_draft_recoveries.kind = 'rollover_finalize'
      AND free_agent_draft_recoveries.status IN (
        'pending',
        'ready',
        'running',
        'correction_required'
      )
  ) THEN RAISE(
    ABORT,
    'FAD completed rollover cannot retain unresolved recovery'
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
      AND job_runs.scheduled_for_ms =
        NEW.candidate_deadline_at_ms
      AND job_runs.status IN ('succeeded', 'skipped')
      AND job_runs.attempt_count >= 1
      AND job_runs.started_at_ms IS NOT NULL
      AND job_runs.completed_at_ms IS NOT NULL
      AND job_runs.completed_at_ms = job_runs.updated_at_ms
      AND job_runs.completed_at_ms <= NEW.completed_at_ms
      AND job_runs.lease_owner IS NULL
      AND job_runs.lease_token IS NULL
      AND job_runs.lease_expires_at_ms IS NULL
      AND job_runs.last_error_code IS NULL
      AND job_runs.next_attempt_at_ms IS NULL
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD completion requires terminal deadline occurrence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id =
            free_agent_draft_player_allocations.league_id
          AND job_runs.season_id =
            free_agent_draft_player_allocations.season_id
          AND job_runs.job_type = 'fad_allocation'
          AND job_runs.occurrence_key =
            'fad:' || free_agent_draft_player_allocations.fad_id ||
              ':allocate:' ||
              free_agent_draft_player_allocations.player_id
          AND job_runs.scheduled_for_ms =
            NEW.candidate_deadline_at_ms
          AND job_runs.attempt_count >= 1
          AND job_runs.started_at_ms IS NOT NULL
          AND job_runs.completed_at_ms IS NOT NULL
          AND job_runs.completed_at_ms = job_runs.updated_at_ms
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND (
            (
              job_runs.status IN ('succeeded', 'skipped')
              AND job_runs.last_error_code IS NULL
              AND job_runs.next_attempt_at_ms IS NULL
            )
            OR (
              job_runs.status = 'failed'
              AND job_runs.last_error_code IS NOT NULL
              AND job_runs.result_json IS NULL
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries
                WHERE free_agent_draft_recoveries.league_id =
                    free_agent_draft_player_allocations.league_id
                  AND free_agent_draft_recoveries.season_id =
                    free_agent_draft_player_allocations.season_id
                  AND free_agent_draft_recoveries.fad_id =
                    free_agent_draft_player_allocations.fad_id
                  AND free_agent_draft_recoveries.allocation_id =
                    free_agent_draft_player_allocations.id
                  AND free_agent_draft_recoveries.player_id =
                    free_agent_draft_player_allocations.player_id
                  AND free_agent_draft_recoveries.job_run_id =
                    job_runs.id
                  AND free_agent_draft_recoveries.kind =
                    'allocation_retry'
                  AND free_agent_draft_recoveries.last_error_code =
                    job_runs.last_error_code
                  AND (
                    (
                      free_agent_draft_player_allocations.status =
                        'correction_required'
                      AND free_agent_draft_recoveries.status IN (
                        'pending',
                        'ready',
                        'running',
                        'correction_required'
                      )
                      AND free_agent_draft_recoveries.last_error_code =
                        free_agent_draft_player_allocations
                          .last_error_code
                      AND free_agent_draft_recoveries.created_at_ms =
                        free_agent_draft_player_allocations
                          .resolved_at_ms
                    )
                    OR (
                      free_agent_draft_player_allocations.status IN (
                        'automatic_award',
                        'no_valid_offer',
                        'invalid'
                      )
                      AND free_agent_draft_recoveries.status =
                        'resolved'
                      AND free_agent_draft_recoveries.resolved_at_ms <=
                        NEW.completed_at_ms
                    )
                  )
              )
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires terminal allocation occurrences'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_rollovers
    WHERE free_agent_draft_rollovers.league_id = NEW.league_id
      AND free_agent_draft_rollovers.season_id = NEW.season_id
      AND free_agent_draft_rollovers.fad_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id =
            free_agent_draft_rollovers.league_id
          AND job_runs.season_id =
            free_agent_draft_rollovers.season_id
          AND job_runs.job_type = 'fad_rollover'
          AND job_runs.occurrence_key =
            'fad:' || free_agent_draft_rollovers.fad_id ||
              ':rollover:' ||
              free_agent_draft_rollovers.sequence || ':' ||
              free_agent_draft_rollovers.rolls_over_at_ms
          AND job_runs.scheduled_for_ms =
            free_agent_draft_rollovers.rolls_over_at_ms
          AND job_runs.attempt_count >= 1
          AND job_runs.started_at_ms IS NOT NULL
          AND job_runs.completed_at_ms IS NOT NULL
          AND job_runs.completed_at_ms = job_runs.updated_at_ms
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND (
            (
              job_runs.status IN ('succeeded', 'skipped')
              AND job_runs.last_error_code IS NULL
              AND job_runs.next_attempt_at_ms IS NULL
            )
            OR (
              job_runs.status = 'failed'
              AND job_runs.last_error_code IS NOT NULL
              AND job_runs.result_json IS NULL
              AND EXISTS (
                SELECT 1
                FROM free_agent_draft_recoveries
                WHERE free_agent_draft_recoveries.league_id =
                    free_agent_draft_rollovers.league_id
                  AND free_agent_draft_recoveries.season_id =
                    free_agent_draft_rollovers.season_id
                  AND free_agent_draft_recoveries.fad_id =
                    free_agent_draft_rollovers.fad_id
                  AND free_agent_draft_recoveries.rollover_id =
                    free_agent_draft_rollovers.id
                  AND free_agent_draft_recoveries.job_run_id =
                    job_runs.id
                  AND free_agent_draft_recoveries.kind =
                    'rollover_finalize'
                  AND free_agent_draft_recoveries.last_error_code =
                    job_runs.last_error_code
                  AND (
                    (
                      free_agent_draft_rollovers.status =
                        'recovery_required'
                      AND free_agent_draft_recoveries.status IN (
                        'pending',
                        'ready',
                        'running',
                        'resolved',
                        'correction_required'
                      )
                      AND free_agent_draft_recoveries.last_error_code =
                        free_agent_draft_rollovers.last_error_code
                      AND (
                        free_agent_draft_recoveries.status <>
                          'resolved'
                        OR free_agent_draft_recoveries
                          .resolved_at_ms <= NEW.completed_at_ms
                      )
                    )
                    OR (
                      free_agent_draft_rollovers.status = 'completed'
                      AND free_agent_draft_recoveries.status =
                        'resolved'
                      AND free_agent_draft_recoveries.resolved_at_ms <=
                        NEW.completed_at_ms
                    )
                  )
              )
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires terminal rollover occurrences'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM job_runs
    WHERE job_runs.league_id = NEW.league_id
      AND job_runs.season_id = NEW.season_id
      AND job_runs.job_type = 'fad_completion'
      AND job_runs.occurrence_key =
        'fad:' || NEW.id || ':complete:' ||
          NEW.first_matchup_starts_at_ms
      AND job_runs.scheduled_for_ms =
        NEW.first_matchup_starts_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms >= NEW.completed_at_ms
      AND job_runs.updated_at_ms >= job_runs.scheduled_for_ms
      AND job_runs.updated_at_ms <= NEW.completed_at_ms
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
          AND job_runs.started_at_ms <= NEW.completed_at_ms
        )
      )
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD completion requires its exact durable occurrence'
  ) END;

  SELECT CASE WHEN (
    SELECT free_agent_draft_completed_at_ms
    FROM seasons
    WHERE seasons.league_id = NEW.league_id
      AND seasons.id = NEW.season_id
  ) IS NOT NULL THEN RAISE(
    ABORT,
    'FAD completion requires an unfinished season marker'
  ) END;
END;

CREATE TRIGGER seasons_fad_completion_marker_guard
BEFORE UPDATE OF free_agent_draft_completed_at_ms ON seasons
WHEN NEW.free_agent_draft_completed_at_ms IS NOT
  OLD.free_agent_draft_completed_at_ms
  AND EXISTS (
    SELECT 1
    FROM free_agent_drafts
    WHERE free_agent_drafts.league_id = NEW.league_id
      AND free_agent_drafts.season_id = NEW.id
  )
BEGIN
  SELECT CASE WHEN NOT (
    OLD.free_agent_draft_completed_at_ms IS NULL
    AND NEW.free_agent_draft_completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.id
        AND free_agent_drafts.status = 'completed'
        AND free_agent_drafts.completed_at_ms =
          NEW.free_agent_draft_completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'season FAD completion marker must match its completed FAD'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_sync_season_completion
AFTER UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  UPDATE seasons
  SET free_agent_draft_completed_at_ms = NEW.completed_at_ms,
      updated_at_ms = CASE
        WHEN updated_at_ms < NEW.completed_at_ms
          THEN NEW.completed_at_ms
        ELSE updated_at_ms
      END,
      version = version + 1
  WHERE seasons.league_id = NEW.league_id
    AND seasons.id = NEW.season_id
    AND seasons.free_agent_draft_completed_at_ms IS NULL;

  SELECT CASE WHEN changes() <> 1 THEN RAISE(
    ABORT,
    'FAD completion must update exactly one season marker'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '25',
    updated_at_ms =
      CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
