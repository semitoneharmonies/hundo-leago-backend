-- hundo-leago: foreign-key-rebuild
-- Bind T-037 lifecycle transitions to immutable request, manifest, audit,
-- activity, notification, and outbox evidence.
-- SHA-256 recomputation remains an application/repository responsibility;
-- SQLite enforces digest shape and the complete relational closed set.

-- Preserve historical ownership IDs after a rollover release. These
-- three histories retain tombstone identities without owning the live row.

DROP TRIGGER auction_contexts_valid_insert;
DROP TRIGGER fad_auction_participants_forward_update;
DROP TRIGGER fad_auction_participants_valid_insert;
DROP TRIGGER fad_auction_resolution_failure_events_insert;
DROP TRIGGER fad_failed_auctions_recovery_update;
DROP TRIGGER fad_open_rapid_failure_recoveries_terminal_update;
DROP TRIGGER fad_restricted_bids_forward_update;
DROP TRIGGER fad_restricted_cancellation_recoveries_terminal_update;
DROP TRIGGER fad_restricted_removal_events_insert;
DROP TRIGGER fad_rollovers_auction_accounting_barrier;
DROP TRIGGER fad_rollovers_resolution_job_barrier;
DROP TRIGGER free_agent_draft_draws_valid_insert;
DROP TRIGGER free_agent_draft_recoveries_causality_insert;
DROP TRIGGER free_agent_draft_recoveries_terminal_update;
DROP TRIGGER free_agent_drafts_allocation_completion_barrier;
DROP TRIGGER free_agent_drafts_allocation_start_barrier;
DROP TRIGGER free_agent_drafts_auction_completion_barrier;
DROP TRIGGER free_agent_drafts_automatic_award_resources_barrier;
DROP TRIGGER free_agent_drafts_deadline_allocation_barrier;
DROP TRIGGER free_agent_drafts_final_completion_barrier;
DROP TRIGGER free_agent_drafts_resolution_job_completion_barrier;

CREATE TABLE free_agent_draft_allocation_events_m7_23 (
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

INSERT INTO free_agent_draft_allocation_events_m7_23 SELECT * FROM free_agent_draft_allocation_events;

DROP TABLE free_agent_draft_allocation_events;
ALTER TABLE free_agent_draft_allocation_events_m7_23 RENAME TO free_agent_draft_allocation_events;

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

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_correction
  ON free_agent_draft_allocation_events (
    league_id,
    correction_id
  )
  WHERE correction_id IS NOT NULL;

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_decision_kind
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version,
    event_kind
  )
  WHERE event_kind <> 'offer_considered';

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_offer_version
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version,
    snapshot_entry_id
  )
  WHERE event_kind = 'offer_considered';

CREATE UNIQUE INDEX free_agent_draft_allocation_events_one_winner
  ON free_agent_draft_allocation_events (
    league_id,
    allocation_id,
    allocation_version
  )
  WHERE offer_outcome_code = 'winner';

-- Defer allocation-event triggers until every rebuilt parent exists.
CREATE TABLE free_agent_draft_player_allocations_m7_23 (
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

INSERT INTO free_agent_draft_player_allocations_m7_23 SELECT * FROM free_agent_draft_player_allocations;

DROP TABLE free_agent_draft_player_allocations;
ALTER TABLE free_agent_draft_player_allocations_m7_23 RENAME TO free_agent_draft_player_allocations;

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

CREATE UNIQUE INDEX free_agent_draft_allocations_one_restricted_auction
  ON free_agent_draft_player_allocations (
    league_id,
    restricted_auction_id
  )
  WHERE restricted_auction_id IS NOT NULL;

-- Defer allocation-root triggers until every rebuilt parent exists.
CREATE TABLE auction_resolutions_m7_23 (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  scheduled_occurrence_key TEXT NOT NULL,
  outcome_code TEXT NOT NULL CHECK (
    outcome_code IN (
      'winner', 'no_winner', 'player_unavailable',
      'season_closed', 'failed', 'recovered'
    )
  ),
  winning_team_id TEXT,
  winning_bid_id TEXT,
  highest_bid_cents INTEGER
    CHECK (highest_bid_cents IS NULL OR highest_bid_cents > 0),
  second_price_input_cents INTEGER
    CHECK (second_price_input_cents IS NULL OR second_price_input_cents >= 0),
  final_contract_value_cents INTEGER
    CHECK (final_contract_value_cents IS NULL OR final_contract_value_cents > 0),
  winning_term_years INTEGER
    CHECK (winning_term_years IS NULL OR winning_term_years BETWEEN 1 AND 3),
  final_aav_cents INTEGER
    CHECK (final_aav_cents IS NULL OR final_aav_cents > 0),
  general_illegal INTEGER NOT NULL DEFAULT 0
    CHECK (general_illegal IN (0, 1)),
  warnings_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(warnings_json) > 1),
  contract_id TEXT,
  ownership_id TEXT,
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('automatic', 'commissioner')),
  triggered_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'resolved', 'no_bids', 'no_winner',
      'cancelled', 'failed', 'recovered'
    )
  ),
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
    REFERENCES contracts(league_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO auction_resolutions_m7_23 SELECT * FROM auction_resolutions;

DROP TABLE auction_resolutions;
ALTER TABLE auction_resolutions_m7_23 RENAME TO auction_resolutions;

CREATE TRIGGER auction_resolutions_require_context_insert
BEFORE INSERT ON auction_resolutions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
  ) THEN RAISE(
    ABORT,
    'auction resolution requires auction context'
  ) END;
END;

CREATE TRIGGER fad_auction_resolutions_context_insert
BEFORE INSERT ON auction_resolutions
WHEN EXISTS (
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
BEGIN
  SELECT CASE WHEN NEW.scheduled_occurrence_key <> (
    SELECT
      'auction:' || auctions.id || ':' || auctions.resolves_at_ms
    FROM auctions
    WHERE auctions.league_id = NEW.league_id
      AND auctions.id = NEW.auction_id
  ) THEN RAISE(
    ABORT,
    'FAD auction result requires the canonical occurrence key'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM auctions
    JOIN job_runs
      ON job_runs.league_id = auctions.league_id
     AND job_runs.season_id = auctions.season_id
     AND job_runs.job_type = 'auction.resolve.target'
     AND job_runs.occurrence_key =
          'auction:' || auctions.id || ':' || auctions.resolves_at_ms
     AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
    WHERE auctions.league_id = NEW.league_id
      AND auctions.season_id = NEW.season_id
      AND auctions.id = NEW.auction_id
      AND auctions.updated_at_ms = NEW.resolved_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.lease_expires_at_ms > NEW.resolved_at_ms
      AND job_runs.completed_at_ms IS NULL
      AND job_runs.result_json IS NULL
      AND job_runs.last_error_code IS NULL
      AND job_runs.next_attempt_at_ms IS NULL
      AND job_runs.updated_at_ms <= NEW.resolved_at_ms
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD auction result requires its exact active resolution job lease'
  ) END;

  SELECT CASE WHEN json_valid(NEW.warnings_json) <> 1 THEN RAISE(
    ABORT,
    'FAD auction result warnings must be valid canonical JSON'
  ) END;

  SELECT CASE WHEN NOT (
    json_type(NEW.warnings_json) = 'array'
    AND json(NEW.warnings_json) = NEW.warnings_json
    AND NEW.general_illegal = CASE
      WHEN json_array_length(NEW.warnings_json) > 0 THEN 1
      ELSE 0
    END
    AND (
      NEW.outcome_code = 'winner'
      OR (
        NEW.general_illegal = 0
        AND NEW.warnings_json = '[]'
      )
    )
  ) THEN RAISE(
    ABORT,
    'FAD auction result warnings must match its exact outcome'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_open_rapid'
      AND (
        (
          auctions.status = 'resolved'
          AND NOT (
            NEW.status = 'resolved'
            AND NEW.outcome_code = 'winner'
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.winning_bid_id IS NOT NULL
            AND NEW.highest_bid_cents IS NOT NULL
            AND NEW.final_contract_value_cents IS NOT NULL
            AND NEW.winning_term_years IS NOT NULL
            AND NEW.final_aav_cents IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
          )
        )
        OR (
          auctions.status = 'no_winner'
          AND NOT (
            NEW.status IN ('no_bids', 'no_winner')
            AND NEW.outcome_code = 'no_winner'
            AND NEW.winning_team_id IS NULL
            AND NEW.winning_bid_id IS NULL
            AND NEW.highest_bid_cents IS NULL
            AND NEW.second_price_input_cents IS NULL
            AND NEW.final_contract_value_cents IS NULL
            AND NEW.winning_term_years IS NULL
            AND NEW.final_aav_cents IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
          )
        )
        OR (
          auctions.status = 'cancelled'
          AND NOT (
            NEW.status = 'cancelled'
            AND NEW.outcome_code IN (
              'player_unavailable',
              'season_closed',
              'recovered'
            )
            AND NEW.winning_team_id IS NULL
            AND NEW.winning_bid_id IS NULL
            AND NEW.highest_bid_cents IS NULL
            AND NEW.second_price_input_cents IS NULL
            AND NEW.final_contract_value_cents IS NULL
            AND NEW.winning_term_years IS NULL
            AND NEW.final_aav_cents IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
            AND (
              NEW.outcome_code <> 'recovered'
              OR (
                NEW.trigger_type = 'commissioner'
                AND NEW.triggered_by_user_id IS NOT NULL
              )
            )
          )
        )
        OR auctions.status IN ('open', 'resolving', 'failed')
      )
  ) THEN RAISE(
    ABORT,
    'open rapid result does not match its physical terminal state'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_open_rapid'
      AND auctions.status = 'cancelled'
      AND (
        (
          NEW.outcome_code = 'recovered'
          AND NOT (
            NEW.status = 'cancelled'
            AND NEW.trigger_type = 'commissioner'
            AND NEW.triggered_by_user_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM league_memberships
              WHERE league_memberships.league_id = NEW.league_id
                AND league_memberships.user_id =
                  NEW.triggered_by_user_id
                AND league_memberships.status = 'active'
                AND (
                  EXISTS (
                    SELECT 1
                    FROM leagues
                    WHERE leagues.id = NEW.league_id
                      AND leagues.commissioner_membership_id =
                        league_memberships.id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM platform_roles
                    WHERE platform_roles.user_id =
                        NEW.triggered_by_user_id
                      AND platform_roles.role =
                        'platform_administrator'
                      AND platform_roles.status = 'active'
                  )
                )
            )
            AND (
              SELECT COUNT(*)
              FROM free_agent_draft_recoveries
              JOIN job_runs
                ON job_runs.league_id =
                    free_agent_draft_recoveries.league_id
               AND job_runs.id =
                    free_agent_draft_recoveries.job_run_id
              JOIN auction_events
                ON auction_events.league_id =
                    free_agent_draft_recoveries.league_id
               AND auction_events.auction_id =
                    free_agent_draft_recoveries.auction_id
               AND auction_events.event_type =
                    'fad_auction_resolution_failed'
              WHERE free_agent_draft_recoveries.league_id =
                  auction_contexts.league_id
                AND free_agent_draft_recoveries.season_id =
                  auction_contexts.season_id
                AND free_agent_draft_recoveries.fad_id =
                  auction_contexts.fad_id
                AND free_agent_draft_recoveries.player_id =
                  auctions.player_id
                AND free_agent_draft_recoveries.allocation_id IS NULL
                AND free_agent_draft_recoveries.rollover_id IS
                  auction_contexts.fad_rollover_id
                AND free_agent_draft_recoveries.auction_id =
                  auction_contexts.auction_id
                AND free_agent_draft_recoveries.kind =
                  'auction_resolution'
                AND free_agent_draft_recoveries.status = 'running'
                AND free_agent_draft_recoveries.updated_at_ms <=
                  NEW.resolved_at_ms
                AND job_runs.job_type = 'auction.resolve.target'
                AND job_runs.occurrence_key =
                  NEW.scheduled_occurrence_key
                AND job_runs.scheduled_for_ms =
                  auctions.resolves_at_ms
                AND job_runs.status IN ('leased', 'running')
                AND job_runs.lease_owner IS NOT NULL
                AND job_runs.lease_token IS NOT NULL
                AND job_runs.lease_expires_at_ms >
                  NEW.resolved_at_ms
                AND auction_events.actor_user_id IS NULL
                AND auction_events.bid_id IS NULL
                AND auction_events.team_id IS NULL
                AND auction_events.occurred_at_ms =
                  free_agent_draft_recoveries.created_at_ms
                AND json_extract(
                  auction_events.metadata_json,
                  '$.recoveryId'
                ) = free_agent_draft_recoveries.id
                AND json_extract(
                  auction_events.metadata_json,
                  '$.jobRunId'
                ) = free_agent_draft_recoveries.job_run_id
                AND json_extract(
                  auction_events.metadata_json,
                  '$.errorCode'
                ) = free_agent_draft_recoveries.last_error_code
            ) = 1
          )
        )
        OR (
          NEW.outcome_code IN (
            'player_unavailable',
            'season_closed'
          )
          AND EXISTS (
            SELECT 1
            FROM auction_events
            WHERE auction_events.league_id = NEW.league_id
              AND auction_events.auction_id = NEW.auction_id
              AND auction_events.event_type =
                'fad_auction_resolution_failed'
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'open rapid recovered cancellation requires exact failure recovery'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_open_rapid'
      AND (
        (
          auctions.status = 'resolved'
          AND (
            (
              SELECT COUNT(*)
              FROM auction_bids
              WHERE auction_bids.league_id = NEW.league_id
                AND auction_bids.auction_id = NEW.auction_id
                AND auction_bids.status = 'won'
                AND auction_bids.id = NEW.winning_bid_id
                AND auction_bids.team_id = NEW.winning_team_id
            ) <> 1
            OR EXISTS (
              SELECT 1
              FROM auction_bids
              WHERE auction_bids.league_id = NEW.league_id
                AND auction_bids.auction_id = NEW.auction_id
                AND (
                  auction_bids.status NOT IN (
                    'won',
                    'lost',
                    'invalid',
                    'withdrawn'
                  )
                  OR (
                    auction_bids.id <> NEW.winning_bid_id
                    AND auction_bids.status = 'won'
                  )
                )
            )
            OR EXISTS (
              SELECT 1
              FROM auction_bids AS competing_bid
              JOIN auction_bids AS winning_bid
                ON winning_bid.league_id = competing_bid.league_id
               AND winning_bid.auction_id = competing_bid.auction_id
               AND winning_bid.id = NEW.winning_bid_id
               AND winning_bid.status = 'won'
              WHERE competing_bid.league_id = NEW.league_id
                AND competing_bid.auction_id = NEW.auction_id
                AND competing_bid.status = 'lost'
                AND (
                  (
                    (competing_bid.total_value_cents /
                      competing_bid.term_years)
                    + CASE
                        WHEN
                          (competing_bid.total_value_cents %
                            competing_bid.term_years) * 2
                            >= competing_bid.term_years
                        THEN 1
                        ELSE 0
                      END
                  ) > (
                    (winning_bid.total_value_cents /
                      winning_bid.term_years)
                    + CASE
                        WHEN
                          (winning_bid.total_value_cents %
                            winning_bid.term_years) * 2
                            >= winning_bid.term_years
                        THEN 1
                        ELSE 0
                      END
                  )
                  OR (
                    (
                      (competing_bid.total_value_cents /
                        competing_bid.term_years)
                      + CASE
                          WHEN
                            (competing_bid.total_value_cents %
                              competing_bid.term_years) * 2
                              >= competing_bid.term_years
                          THEN 1
                          ELSE 0
                        END
                    ) = (
                      (winning_bid.total_value_cents /
                        winning_bid.term_years)
                      + CASE
                          WHEN
                            (winning_bid.total_value_cents %
                              winning_bid.term_years) * 2
                              >= winning_bid.term_years
                          THEN 1
                          ELSE 0
                        END
                    )
                    AND (
                      competing_bid.term_years <
                        winning_bid.term_years
                      OR (
                        competing_bid.term_years =
                          winning_bid.term_years
                        AND (
                          competing_bid.first_submitted_at_ms <
                            winning_bid.first_submitted_at_ms
                          OR (
                            competing_bid.first_submitted_at_ms =
                              winning_bid.first_submitted_at_ms
                            AND competing_bid.id < winning_bid.id
                          )
                        )
                      )
                    )
                  )
                )
            )
          )
        )
        OR (
          auctions.status = 'no_winner'
          AND EXISTS (
            SELECT 1
            FROM auction_bids
            WHERE auction_bids.league_id = NEW.league_id
              AND auction_bids.auction_id = NEW.auction_id
              AND auction_bids.status NOT IN ('invalid', 'withdrawn')
          )
        )
        OR (
          auctions.status = 'cancelled'
          AND EXISTS (
            SELECT 1
            FROM auction_bids
            WHERE auction_bids.league_id = NEW.league_id
              AND auction_bids.auction_id = NEW.auction_id
              AND auction_bids.status NOT IN ('cancelled', 'withdrawn')
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'open rapid result requires its complete ranked bid status set'
  ) END;

  SELECT CASE WHEN EXISTS (
    WITH eligible_open_rapid_bids AS (
      SELECT candidate_bid.id
      FROM auction_bids AS candidate_bid
      JOIN teams
        ON teams.league_id = candidate_bid.league_id
       AND teams.id = candidate_bid.team_id
       AND teams.status = 'active'
      JOIN auction_events AS submission_event
        ON submission_event.id = (
          SELECT earliest_submission.id
          FROM auction_events AS earliest_submission
          WHERE earliest_submission.league_id =
              candidate_bid.league_id
            AND earliest_submission.auction_id =
              candidate_bid.auction_id
            AND earliest_submission.bid_id = candidate_bid.id
            AND earliest_submission.event_type IN (
              'auction_started',
              'bid_submitted'
            )
          ORDER BY
            earliest_submission.occurred_at_ms,
            earliest_submission.id
          LIMIT 1
        )
      JOIN league_memberships AS submission_membership
        ON submission_membership.league_id =
            candidate_bid.league_id
       AND submission_membership.id = json_extract(
            submission_event.metadata_json,
            '$.actorMembershipId'
          )
       AND submission_membership.user_id =
            submission_event.actor_user_id
       AND submission_membership.status IN (
            'active',
            'ended',
            'suspended'
          )
       AND submission_membership.joined_at_ms IS NOT NULL
       AND submission_membership.joined_at_ms <=
            submission_event.occurred_at_ms
       AND (
            submission_membership.ended_at_ms IS NULL
            OR submission_membership.ended_at_ms >
              submission_event.occurred_at_ms
          )
      WHERE candidate_bid.league_id = NEW.league_id
        AND candidate_bid.auction_id = NEW.auction_id
        AND submission_event.actor_user_id =
          candidate_bid.submitted_by_user_id
        AND submission_event.team_id = candidate_bid.team_id
        AND submission_event.occurred_at_ms =
          candidate_bid.first_submitted_at_ms
        AND json_valid(submission_event.metadata_json) = 1
        AND json_type(submission_event.metadata_json) = 'object'
        AND json_extract(
          submission_event.metadata_json,
          '$.actorAuthority'
        ) IN ('manager', 'commissioner')
        AND submission_membership.permission_category =
          json_extract(
            submission_event.metadata_json,
            '$.actorAuthority'
          )
        AND (
          json_extract(
            submission_event.metadata_json,
            '$.actorAuthority'
          ) = 'commissioner'
          OR EXISTS (
            SELECT 1
            FROM team_manager_assignments
            WHERE team_manager_assignments.league_id =
                candidate_bid.league_id
              AND team_manager_assignments.team_id =
                candidate_bid.team_id
              AND team_manager_assignments.user_id =
                candidate_bid.submitted_by_user_id
              AND team_manager_assignments.membership_id =
                submission_membership.id
              AND team_manager_assignments.status IN (
                'accepted',
                'ended'
              )
              AND team_manager_assignments.accepted_at_ms IS NOT NULL
              AND team_manager_assignments.accepted_at_ms <=
                submission_event.occurred_at_ms
              AND (
                team_manager_assignments.ended_at_ms IS NULL
                OR team_manager_assignments.ended_at_ms >
                  submission_event.occurred_at_ms
              )
          )
        )
        AND candidate_bid.total_value_cents >= CASE
          WHEN submission_event.event_type = 'auction_started'
            THEN candidate_bid.term_years * 100
          ELSE CASE candidate_bid.term_years
            WHEN 1 THEN 150
            WHEN 2 THEN 300
            WHEN 3 THEN 500
          END
        END
        AND (
          candidate_bid.term_years = 1
          OR candidate_bid.total_value_cents % 100 = 0
        )
        AND candidate_bid.lowest_offered_aav_cents <=
          (candidate_bid.total_value_cents /
            candidate_bid.term_years)
          + CASE
              WHEN
                (candidate_bid.total_value_cents %
                  candidate_bid.term_years) * 2
                  >= candidate_bid.term_years
              THEN 1
              ELSE 0
            END
    )
    SELECT 1
    FROM auction_contexts
    JOIN auction_bids
      ON auction_bids.league_id = auction_contexts.league_id
     AND auction_bids.auction_id = auction_contexts.auction_id
    LEFT JOIN eligible_open_rapid_bids
      ON eligible_open_rapid_bids.id = auction_bids.id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_open_rapid'
      AND (
        (
          auction_bids.status IN ('won', 'lost')
          AND eligible_open_rapid_bids.id IS NULL
        )
        OR (
          auction_bids.status = 'invalid'
          AND eligible_open_rapid_bids.id IS NOT NULL
        )
      )
  ) THEN RAISE(
    ABORT,
    'open rapid terminal statuses must match exact bid eligibility'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN free_agent_draft_draws
      ON free_agent_draft_draws.league_id =
          auction_contexts.league_id
     AND free_agent_draft_draws.season_id =
          auction_contexts.season_id
     AND free_agent_draft_draws.fad_id = auction_contexts.fad_id
     AND free_agent_draft_draws.allocation_id =
          auction_contexts.fad_allocation_id
     AND free_agent_draft_draws.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND (
        free_agent_draft_draws.revealed_at_ms IS NULL
        OR free_agent_draft_draws.revealed_at_ms <>
          NEW.resolved_at_ms
        OR (
          auctions.status = 'resolved'
          AND NOT (
            NEW.status = 'resolved'
            AND NEW.outcome_code = 'winner'
            AND NEW.winning_team_id IS NOT NULL
            AND NEW.winning_bid_id IS NOT NULL
            AND NEW.highest_bid_cents IS NOT NULL
            AND NEW.final_contract_value_cents IS NOT NULL
            AND NEW.winning_term_years IS NOT NULL
            AND NEW.final_aav_cents IS NOT NULL
            AND NEW.contract_id IS NOT NULL
            AND NEW.ownership_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_auction_participants
              JOIN auction_bids
                ON auction_bids.league_id =
                    free_agent_draft_auction_participants.league_id
               AND auction_bids.auction_id =
                    free_agent_draft_auction_participants.auction_id
               AND auction_bids.id =
                    free_agent_draft_auction_participants.seeded_bid_id
               AND auction_bids.team_id =
                    free_agent_draft_auction_participants.team_id
              WHERE free_agent_draft_auction_participants.league_id =
                  NEW.league_id
                AND free_agent_draft_auction_participants
                  .auction_id = NEW.auction_id
                AND free_agent_draft_auction_participants.status =
                  'active'
                AND free_agent_draft_auction_participants
                  .seeded_bid_id = NEW.winning_bid_id
                AND free_agent_draft_auction_participants.team_id =
                  NEW.winning_team_id
                AND auction_bids.status = 'won'
                AND auction_bids.total_value_cents =
                  NEW.highest_bid_cents
                AND auction_bids.term_years =
                  NEW.winning_term_years
            )
            AND (
              free_agent_draft_draws.selected_bid_id IS NULL
              OR (
                free_agent_draft_draws.selected_bid_id =
                  NEW.winning_bid_id
                AND free_agent_draft_draws.selected_team_id =
                  NEW.winning_team_id
              )
            )
          )
        )
        OR (
          auctions.status = 'no_winner'
          AND NOT (
            NEW.status IN ('no_bids', 'no_winner')
            AND NEW.outcome_code = 'no_winner'
            AND NEW.winning_team_id IS NULL
            AND NEW.winning_bid_id IS NULL
            AND NEW.highest_bid_cents IS NULL
            AND NEW.second_price_input_cents IS NULL
            AND NEW.final_contract_value_cents IS NULL
            AND NEW.winning_term_years IS NULL
            AND NEW.final_aav_cents IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
            AND free_agent_draft_draws
              .ordered_tied_bid_ids_json = '[]'
          )
        )
        OR (
          auctions.status = 'cancelled'
          AND NOT (
            NEW.status = 'cancelled'
            AND NEW.outcome_code = 'failed'
            AND NEW.trigger_type = 'commissioner'
            AND NEW.triggered_by_user_id IS NOT NULL
            AND NEW.winning_team_id IS NULL
            AND NEW.winning_bid_id IS NULL
            AND NEW.highest_bid_cents IS NULL
            AND NEW.second_price_input_cents IS NULL
            AND NEW.final_contract_value_cents IS NULL
            AND NEW.winning_term_years IS NULL
            AND NEW.final_aav_cents IS NULL
            AND NEW.contract_id IS NULL
            AND NEW.ownership_id IS NULL
            AND free_agent_draft_draws
              .ordered_tied_bid_ids_json = '[]'
          )
        )
        OR auctions.status IN ('open', 'resolving', 'failed')
      )
  ) THEN RAISE(
    ABORT,
    'restricted result requires matching terminal draw and result evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND (
        (
          auctions.status = 'resolved'
          AND (
            (
              SELECT COUNT(*)
              FROM fad_restricted_eligible_bids AS winning_bid
              WHERE winning_bid.league_id = NEW.league_id
                AND winning_bid.auction_id = NEW.auction_id
                AND winning_bid.bid_status = 'won'
                AND winning_bid.bid_id = NEW.winning_bid_id
                AND winning_bid.team_id = NEW.winning_team_id
            ) <> 1
            OR EXISTS (
              SELECT 1
              FROM free_agent_draft_auction_participants
                AS resolved_participant
              JOIN auction_bids AS resolved_bid
                ON resolved_bid.league_id =
                    resolved_participant.league_id
               AND resolved_bid.auction_id =
                    resolved_participant.auction_id
               AND resolved_bid.team_id = resolved_participant.team_id
               AND resolved_bid.id = resolved_participant.seeded_bid_id
              WHERE resolved_participant.league_id = NEW.league_id
                AND resolved_participant.auction_id = NEW.auction_id
                AND (
                  (
                    resolved_participant.status = 'active'
                    AND (
                      (
                        EXISTS (
                          SELECT 1
                          FROM fad_restricted_eligible_bids
                            AS eligible_resolved_bid
                          WHERE eligible_resolved_bid.league_id =
                              resolved_bid.league_id
                            AND eligible_resolved_bid.auction_id =
                              resolved_bid.auction_id
                            AND eligible_resolved_bid.bid_id =
                              resolved_bid.id
                        )
                        AND (
                          (
                            resolved_bid.id = NEW.winning_bid_id
                            AND resolved_bid.status <> 'won'
                          )
                          OR (
                            resolved_bid.id <> NEW.winning_bid_id
                            AND resolved_bid.status <> 'lost'
                          )
                        )
                      )
                      OR (
                        NOT EXISTS (
                          SELECT 1
                          FROM fad_restricted_eligible_bids
                            AS eligible_resolved_bid
                          WHERE eligible_resolved_bid.league_id =
                              resolved_bid.league_id
                            AND eligible_resolved_bid.auction_id =
                              resolved_bid.auction_id
                            AND eligible_resolved_bid.bid_id =
                              resolved_bid.id
                        )
                        AND resolved_bid.status <> 'invalid'
                      )
                    )
                  )
                  OR (
                    resolved_participant.status = 'removed'
                    AND resolved_bid.status <> 'withdrawn'
                  )
                )
            )
          )
        )
        OR (
          auctions.status = 'no_winner'
          AND (
            EXISTS (
              SELECT 1
              FROM fad_restricted_eligible_bids
              WHERE fad_restricted_eligible_bids.league_id =
                  NEW.league_id
                AND fad_restricted_eligible_bids.auction_id =
                  NEW.auction_id
            )
            OR EXISTS (
              SELECT 1
              FROM free_agent_draft_auction_participants
                AS no_winner_participant
              JOIN auction_bids AS no_winner_bid
                ON no_winner_bid.league_id =
                    no_winner_participant.league_id
               AND no_winner_bid.auction_id =
                    no_winner_participant.auction_id
               AND no_winner_bid.team_id =
                    no_winner_participant.team_id
               AND no_winner_bid.id =
                    no_winner_participant.seeded_bid_id
              WHERE no_winner_participant.league_id = NEW.league_id
                AND no_winner_participant.auction_id = NEW.auction_id
                AND (
                  (
                    no_winner_participant.status = 'active'
                    AND no_winner_bid.status <> 'invalid'
                  )
                  OR (
                    no_winner_participant.status = 'removed'
                    AND no_winner_bid.status <> 'withdrawn'
                  )
                )
            )
          )
        )
        OR (
          auctions.status = 'cancelled'
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_auction_participants
              AS cancelled_participant
            JOIN auction_bids AS cancelled_bid
              ON cancelled_bid.league_id =
                  cancelled_participant.league_id
             AND cancelled_bid.auction_id =
                  cancelled_participant.auction_id
             AND cancelled_bid.team_id =
                  cancelled_participant.team_id
             AND cancelled_bid.id =
                  cancelled_participant.seeded_bid_id
            WHERE cancelled_participant.league_id = NEW.league_id
              AND cancelled_participant.auction_id = NEW.auction_id
              AND (
                (
                  cancelled_participant.status = 'active'
                  AND cancelled_bid.status <> 'cancelled'
                )
                OR (
                  cancelled_participant.status = 'removed'
                  AND cancelled_bid.status <> 'withdrawn'
                )
              )
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'restricted result requires its complete exact bid status set'
  ) END;

  SELECT CASE WHEN
    NEW.outcome_code = 'winner'
    AND NOT EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN auctions
        ON auctions.league_id = auction_contexts.league_id
       AND auctions.season_id = auction_contexts.season_id
       AND auctions.id = auction_contexts.auction_id
      JOIN auction_bids AS winning_bid
        ON winning_bid.league_id = auctions.league_id
       AND winning_bid.season_id = auctions.season_id
       AND winning_bid.auction_id = auctions.id
       AND winning_bid.id = NEW.winning_bid_id
       AND winning_bid.team_id = NEW.winning_team_id
       AND winning_bid.status = 'won'
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
        AND auctions.status = 'resolved'
        AND NEW.status = 'resolved'
        AND (
          auction_contexts.source_kind = 'fad_open_rapid'
          OR EXISTS (
            SELECT 1
            FROM fad_restricted_eligible_bids
            WHERE fad_restricted_eligible_bids.league_id =
                winning_bid.league_id
              AND fad_restricted_eligible_bids.auction_id =
                winning_bid.auction_id
              AND fad_restricted_eligible_bids.team_id =
                winning_bid.team_id
              AND fad_restricted_eligible_bids.bid_id =
                winning_bid.id
              AND fad_restricted_eligible_bids.bid_status = 'won'
          )
        )
        AND NEW.highest_bid_cents =
          winning_bid.total_value_cents
        AND NEW.winning_term_years = winning_bid.term_years
        AND NEW.second_price_input_cents IS (
          SELECT MAX(
            (competing_bid.total_value_cents /
              competing_bid.term_years)
            + CASE
                WHEN
                  (competing_bid.total_value_cents %
                    competing_bid.term_years) * 2
                    >= competing_bid.term_years
                THEN 1
                ELSE 0
              END
          )
          FROM auction_bids AS competing_bid
          WHERE competing_bid.league_id = winning_bid.league_id
            AND competing_bid.auction_id = winning_bid.auction_id
            AND competing_bid.status = 'lost'
            AND (
              auction_contexts.source_kind = 'fad_open_rapid'
              OR EXISTS (
                SELECT 1
                FROM fad_restricted_eligible_bids
                WHERE fad_restricted_eligible_bids.league_id =
                    competing_bid.league_id
                  AND fad_restricted_eligible_bids.auction_id =
                    competing_bid.auction_id
                  AND fad_restricted_eligible_bids.bid_id =
                    competing_bid.id
                  AND fad_restricted_eligible_bids.bid_status = 'lost'
              )
            )
        )
        AND NEW.final_contract_value_cents = CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM auction_bids AS competing_bid
            WHERE competing_bid.league_id = winning_bid.league_id
              AND competing_bid.auction_id = winning_bid.auction_id
              AND competing_bid.status = 'lost'
              AND (
                auction_contexts.source_kind = 'fad_open_rapid'
                OR EXISTS (
                  SELECT 1
                  FROM fad_restricted_eligible_bids
                  WHERE fad_restricted_eligible_bids.league_id =
                      competing_bid.league_id
                    AND fad_restricted_eligible_bids.auction_id =
                      competing_bid.auction_id
                    AND fad_restricted_eligible_bids.bid_id =
                      competing_bid.id
                    AND fad_restricted_eligible_bids.bid_status = 'lost'
                )
              )
          ) THEN winning_bid.total_value_cents
          WHEN winning_bid.term_years = 1 THEN MAX(
            winning_bid.term_years * 100,
            (
              (
                2 * MAX(
                  winning_bid.lowest_offered_aav_cents,
                  (
                    SELECT MAX(
                      (competing_bid.total_value_cents /
                        competing_bid.term_years)
                      + CASE
                          WHEN
                            (competing_bid.total_value_cents %
                              competing_bid.term_years) * 2
                              >= competing_bid.term_years
                          THEN 1
                          ELSE 0
                        END
                    )
                    FROM auction_bids AS competing_bid
                    WHERE competing_bid.league_id =
                        winning_bid.league_id
                      AND competing_bid.auction_id =
                        winning_bid.auction_id
                      AND competing_bid.status = 'lost'
                      AND (
                        auction_contexts.source_kind = 'fad_open_rapid'
                        OR EXISTS (
                          SELECT 1
                          FROM fad_restricted_eligible_bids
                          WHERE fad_restricted_eligible_bids.league_id =
                              competing_bid.league_id
                            AND fad_restricted_eligible_bids.auction_id =
                              competing_bid.auction_id
                            AND fad_restricted_eligible_bids.bid_id =
                              competing_bid.id
                            AND fad_restricted_eligible_bids
                              .bid_status = 'lost'
                        )
                      )
                  )
                ) - 1
              ) * winning_bid.term_years + 1
            ) / 2
          )
          ELSE (
            MAX(
              winning_bid.term_years * 100,
              (
                (
                  2 * MAX(
                    winning_bid.lowest_offered_aav_cents,
                    (
                      SELECT MAX(
                        (competing_bid.total_value_cents /
                          competing_bid.term_years)
                        + CASE
                            WHEN
                              (competing_bid.total_value_cents %
                                competing_bid.term_years) * 2
                                >= competing_bid.term_years
                            THEN 1
                            ELSE 0
                          END
                      )
                      FROM auction_bids AS competing_bid
                      WHERE competing_bid.league_id =
                          winning_bid.league_id
                        AND competing_bid.auction_id =
                          winning_bid.auction_id
                        AND competing_bid.status = 'lost'
                        AND (
                          auction_contexts.source_kind =
                            'fad_open_rapid'
                          OR EXISTS (
                            SELECT 1
                            FROM fad_restricted_eligible_bids
                            WHERE
                              fad_restricted_eligible_bids.league_id =
                                competing_bid.league_id
                              AND
                              fad_restricted_eligible_bids.auction_id =
                                competing_bid.auction_id
                              AND fad_restricted_eligible_bids.bid_id =
                                competing_bid.id
                              AND fad_restricted_eligible_bids
                                .bid_status = 'lost'
                          )
                        )
                    )
                  ) - 1
                ) * winning_bid.term_years + 1
              ) / 2
            ) + 99
          ) / 100 * 100
        END
        AND NEW.final_contract_value_cents <=
          winning_bid.total_value_cents
        AND NEW.final_aav_cents =
          (NEW.final_contract_value_cents / winning_bid.term_years)
          + CASE
              WHEN
                (NEW.final_contract_value_cents %
                  winning_bid.term_years) * 2
                  >= winning_bid.term_years
              THEN 1
              ELSE 0
            END
        AND (
          auction_contexts.source_kind = 'fad_open_rapid'
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_auction_participants
            WHERE free_agent_draft_auction_participants.league_id =
                auction_contexts.league_id
              AND free_agent_draft_auction_participants.season_id =
                auction_contexts.season_id
              AND free_agent_draft_auction_participants.fad_id =
                auction_contexts.fad_id
              AND free_agent_draft_auction_participants.allocation_id =
                auction_contexts.fad_allocation_id
              AND free_agent_draft_auction_participants.auction_id =
                auction_contexts.auction_id
              AND free_agent_draft_auction_participants.team_id =
                winning_bid.team_id
              AND free_agent_draft_auction_participants.seeded_bid_id =
                winning_bid.id
              AND free_agent_draft_auction_participants.status =
                'active'
              AND NEW.final_contract_value_cents >=
                free_agent_draft_auction_participants
                  .minimum_final_total_cents
          )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD winner result requires exact ranking and anti-bluff pricing'
  ) END;

  SELECT CASE WHEN
    NEW.outcome_code = 'winner'
    AND NOT EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN auctions
        ON auctions.league_id = auction_contexts.league_id
       AND auctions.season_id = auction_contexts.season_id
       AND auctions.id = auction_contexts.auction_id
      JOIN contracts
        ON contracts.league_id = auctions.league_id
       AND contracts.id = NEW.contract_id
       AND contracts.player_id = auctions.player_id
       AND contracts.current_team_id = NEW.winning_team_id
      JOIN player_ownerships
        ON player_ownerships.league_id = auctions.league_id
       AND player_ownerships.id = NEW.ownership_id
       AND player_ownerships.season_id = auctions.season_id
       AND player_ownerships.player_id = auctions.player_id
       AND player_ownerships.team_id = NEW.winning_team_id
      JOIN seasons AS target_season
        ON target_season.league_id = auctions.league_id
       AND target_season.id = auctions.season_id
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
        AND contracts.contract_type = 'normal'
        AND contracts.original_total_value_cents =
          NEW.final_contract_value_cents
        AND contracts.original_term_years =
          NEW.winning_term_years
        AND contracts.aav_cents = NEW.final_aav_cents
        AND contracts.start_season_id = NEW.season_id
        AND contracts.status = 'active'
        AND contracts.acquisition_source_type =
          'auction_resolution'
        AND contracts.acquisition_source_id = NEW.id
        AND contracts.auction_buyout_lock_expires_at_ms =
          NEW.resolved_at_ms + 1209600000
        AND contracts.created_at_ms = NEW.resolved_at_ms
        AND contracts.updated_at_ms = NEW.resolved_at_ms
        AND contracts.version = 1
        AND player_ownerships.ownership_kind = 'Rostered'
        AND player_ownerships.acquired_transaction_type =
          'auction_resolution'
        AND player_ownerships.acquired_transaction_id = NEW.id
        AND player_ownerships.created_at_ms = NEW.resolved_at_ms
        AND player_ownerships.updated_at_ms = NEW.resolved_at_ms
        AND player_ownerships.version = 1
        AND target_season.status = 'active'
        AND length(target_season.nhl_season_key) = 8
        AND target_season.nhl_season_key NOT GLOB '*[^0-9]*'
        AND CAST(
          substr(target_season.nhl_season_key, 5, 4) AS INTEGER
        ) = CAST(
          substr(target_season.nhl_season_key, 1, 4) AS INTEGER
        ) + 1
        AND (
          SELECT COUNT(*)
          FROM contract_years
          WHERE contract_years.league_id = NEW.league_id
            AND contract_years.contract_id = NEW.contract_id
        ) = NEW.winning_term_years
        AND NOT EXISTS (
          SELECT 1
          FROM contract_years
          JOIN seasons AS contract_year_season
            ON contract_year_season.league_id =
                contract_years.league_id
           AND contract_year_season.id = contract_years.season_id
          WHERE contract_years.league_id = NEW.league_id
            AND contract_years.contract_id = NEW.contract_id
            AND (
              contract_years.year_number >
                NEW.winning_term_years
              OR contract_years.aav_cents <> NEW.final_aav_cents
              OR contract_years.rollover_at_ms IS NOT NULL
              OR contract_years.created_at_ms <> NEW.resolved_at_ms
              OR NOT (
                (
                  contract_years.year_number = 1
                  AND contract_years.season_id = NEW.season_id
                  AND contract_years.status = 'current'
                )
                OR (
                  contract_years.year_number BETWEEN
                    2 AND NEW.winning_term_years
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
                  AND contract_year_season.nhl_season_key = printf(
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
        AND (
          (
            auction_contexts.source_kind = 'fad_restricted'
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_auction_participants
              JOIN candidate_card_snapshot_entries
                ON candidate_card_snapshot_entries.league_id =
                    free_agent_draft_auction_participants.league_id
               AND candidate_card_snapshot_entries.id =
                    free_agent_draft_auction_participants
                      .source_snapshot_entry_id
              WHERE free_agent_draft_auction_participants.league_id =
                  auction_contexts.league_id
                AND free_agent_draft_auction_participants.season_id =
                  auction_contexts.season_id
                AND free_agent_draft_auction_participants.fad_id =
                  auction_contexts.fad_id
                AND free_agent_draft_auction_participants
                  .allocation_id =
                    auction_contexts.fad_allocation_id
                AND free_agent_draft_auction_participants.auction_id =
                  auction_contexts.auction_id
                AND free_agent_draft_auction_participants.team_id =
                  NEW.winning_team_id
                AND free_agent_draft_auction_participants
                  .seeded_bid_id = NEW.winning_bid_id
                AND free_agent_draft_auction_participants.status =
                  'active'
                AND player_ownerships.position_group =
                  candidate_card_snapshot_entries
                    .effective_position_group
                AND player_ownerships.slot_number =
                  candidate_card_snapshot_entries.slot_number
                AND (
                  (
                    candidate_card_snapshot_entries.slot_group
                      IN ('F', 'D')
                    AND player_ownerships.roster_category = 'Active'
                  )
                  OR (
                    candidate_card_snapshot_entries.slot_group = 'B'
                    AND player_ownerships.roster_category = 'Bench'
                  )
                )
            )
          )
          OR (
            auction_contexts.source_kind = 'fad_open_rapid'
            AND player_ownerships.roster_category = 'Active'
            AND player_ownerships.position_group = COALESCE(
              (
                SELECT league_player_positions.position_group
                FROM league_player_positions
                WHERE league_player_positions.league_id =
                    auctions.league_id
                  AND league_player_positions.player_id =
                    auctions.player_id
                  AND league_player_positions.ended_at_ms IS NULL
                LIMIT 1
              ),
              (
                SELECT MIN(player_source_state.normalized_position)
                FROM player_source_state
                WHERE player_source_state.player_id =
                    auctions.player_id
                  AND player_source_state.ended_at_ms IS NULL
                  AND player_source_state.active = 1
                  AND player_source_state.normalized_position
                    IN ('F', 'D')
                HAVING COUNT(
                  DISTINCT player_source_state.normalized_position
                ) = 1
              )
            )
          )
        )
    )
  THEN RAISE(
    ABORT,
    'FAD winner result requires exact contract and ownership resources'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
  ) AND (
    SELECT COUNT(*)
    FROM free_agent_draft_draws
    WHERE free_agent_draft_draws.league_id = NEW.league_id
      AND free_agent_draft_draws.auction_id = NEW.auction_id
      AND free_agent_draft_draws.revealed_at_ms =
        NEW.resolved_at_ms
  ) <> 1 THEN RAISE(
    ABORT,
    'restricted result requires exactly one revealed draw'
  ) END;
END;

CREATE TRIGGER fad_auction_resolutions_immutable_delete
BEFORE DELETE ON auction_resolutions
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD auction resolution evidence is immutable'
  );
END;

CREATE TRIGGER fad_auction_resolutions_immutable_update
BEFORE UPDATE ON auction_resolutions
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind IN (
      'fad_open_rapid',
      'fad_restricted'
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD auction resolution evidence is immutable'
  );
END;

CREATE TRIGGER auction_contexts_valid_insert
BEFORE INSERT ON auction_contexts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auctions
    WHERE auctions.league_id = NEW.league_id
      AND auctions.season_id = NEW.season_id
      AND auctions.id = NEW.auction_id
      AND auctions.created_at_ms = NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'auction context must match the same-season auction creation'
  ) END;

  SELECT CASE WHEN
    NEW.source_kind <> 'ordinary_weekly'
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.created_at_ms = auctions.opened_at_ms
        AND NEW.created_at_ms = auctions.opened_at_ms
    )
  THEN RAISE(
    ABORT,
    'FAD auction creation and opening timestamps must be identical'
  ) END;

  SELECT CASE WHEN
    NEW.source_kind = 'fad_open_rapid'
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id = auctions.league_id
       AND free_agent_drafts.season_id = auctions.season_id
       AND free_agent_drafts.id = NEW.fad_id
      JOIN free_agent_draft_rollovers
        ON free_agent_draft_rollovers.league_id = auctions.league_id
       AND free_agent_draft_rollovers.season_id = auctions.season_id
       AND free_agent_draft_rollovers.fad_id = NEW.fad_id
       AND free_agent_draft_rollovers.id = NEW.fad_rollover_id
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.status = 'open'
        AND free_agent_drafts.status = 'rapid'
        AND free_agent_draft_rollovers.status = 'scheduled'
        AND auctions.opened_at_ms >=
          free_agent_draft_rollovers.opens_at_ms
        AND auctions.opened_at_ms <
          free_agent_draft_rollovers.creation_cutoff_at_ms
        AND auctions.resolves_at_ms =
          free_agent_draft_rollovers.rolls_over_at_ms
    )
  THEN RAISE(
    ABORT,
    'open rapid context requires the exact active FAD rollover window'
  ) END;

  SELECT CASE WHEN
    NEW.source_kind = 'fad_restricted'
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      JOIN free_agent_draft_player_allocations
        ON free_agent_draft_player_allocations.league_id =
            auctions.league_id
       AND free_agent_draft_player_allocations.season_id =
            auctions.season_id
       AND free_agent_draft_player_allocations.fad_id = NEW.fad_id
       AND free_agent_draft_player_allocations.id =
            NEW.fad_allocation_id
       AND free_agent_draft_player_allocations.player_id =
            auctions.player_id
      JOIN free_agent_drafts
        ON free_agent_drafts.league_id = auctions.league_id
       AND free_agent_drafts.season_id = auctions.season_id
       AND free_agent_drafts.id = NEW.fad_id
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.status = 'open'
        AND free_agent_draft_player_allocations
          .restricted_auction_id IS NULL
        AND (
          (
            free_agent_draft_player_allocations.status = 'pending'
            AND free_agent_draft_player_allocations.decision_code IS NULL
          )
          OR (
            free_agent_draft_player_allocations.status <> 'pending'
            AND free_agent_draft_player_allocations.decision_code =
              'exact_total_and_term_tie'
          )
        )
        AND (
          (
            NEW.fad_rollover_id IS NOT NULL
            AND free_agent_drafts.status IN ('allocating', 'rapid')
            AND free_agent_draft_player_allocations.status IN (
              'pending',
              'restricted_scheduled',
              'correction_required'
            )
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_rollovers
              WHERE free_agent_draft_rollovers.league_id =
                  NEW.league_id
                AND free_agent_draft_rollovers.season_id =
                  NEW.season_id
                AND free_agent_draft_rollovers.fad_id = NEW.fad_id
                AND free_agent_draft_rollovers.id =
                  NEW.fad_rollover_id
                AND free_agent_draft_rollovers.status = 'scheduled'
                AND auctions.opened_at_ms >=
                  free_agent_draft_rollovers.opens_at_ms
                AND auctions.opened_at_ms <
                  free_agent_draft_rollovers.creation_cutoff_at_ms
                AND auctions.resolves_at_ms =
                  free_agent_draft_rollovers.rolls_over_at_ms
            )
            AND (
              (
                free_agent_draft_player_allocations.status = 'pending'
                AND EXISTS (
                  SELECT 1
                  FROM job_runs
                  WHERE job_runs.league_id = NEW.league_id
                    AND job_runs.season_id = NEW.season_id
                    AND job_runs.job_type = 'fad_allocation'
                    AND job_runs.occurrence_key =
                      'fad:' || NEW.fad_id || ':allocate:' ||
                        auctions.player_id
                    AND job_runs.status IN ('leased', 'running')
                    AND job_runs.attempt_count >= 1
                    AND job_runs.lease_owner IS NOT NULL
                    AND job_runs.lease_token IS NOT NULL
                    AND job_runs.updated_at_ms <=
                      auctions.opened_at_ms
                    AND job_runs.lease_expires_at_ms >
                      auctions.opened_at_ms
                )
              )
              OR (
                free_agent_draft_player_allocations.status <> 'pending'
                AND EXISTS (
                SELECT 1
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
                  AND free_agent_draft_recoveries.fad_id =
                    NEW.fad_id
                  AND free_agent_draft_recoveries.allocation_id =
                    NEW.fad_allocation_id
                  AND free_agent_draft_recoveries.player_id =
                    auctions.player_id
                  AND free_agent_draft_recoveries.rollover_id =
                    NEW.fad_rollover_id
                  AND free_agent_draft_recoveries.kind =
                    'restricted_activation'
                  AND free_agent_draft_recoveries.status = 'running'
                  AND free_agent_draft_recoveries.updated_at_ms <=
                    auctions.opened_at_ms
                  AND free_agent_draft_recoveries.created_at_ms =
                    free_agent_draft_player_allocations.resolved_at_ms
                  AND free_agent_draft_recoveries.last_error_code IS
                    free_agent_draft_player_allocations.last_error_code
                  AND free_agent_draft_recoveries
                    .earliest_activation_at_ms <=
                      auctions.opened_at_ms
                  AND free_agent_draft_recoveries
                    .target_resolution_at_ms =
                      auctions.resolves_at_ms
                  AND job_runs.season_id = NEW.season_id
                  AND job_runs.job_type =
                    'fad_restricted_activation'
                  AND job_runs.occurrence_key =
                    'fad:' || NEW.fad_id ||
                      ':restricted-activate:' ||
                      NEW.fad_allocation_id || ':' ||
                      free_agent_draft_recoveries
                        .earliest_activation_at_ms
                  AND job_runs.scheduled_for_ms =
                    free_agent_draft_recoveries
                      .earliest_activation_at_ms
                  AND job_runs.status IN ('leased', 'running')
                  AND job_runs.attempt_count >= 1
                  AND job_runs.lease_owner IS NOT NULL
                  AND job_runs.lease_token IS NOT NULL
                  AND job_runs.updated_at_ms <=
                    auctions.opened_at_ms
                  AND job_runs.lease_expires_at_ms >
                    auctions.opened_at_ms
                )
              )
            )
          )
          OR (
            NEW.fad_rollover_id IS NULL
            AND free_agent_drafts.status = 'completed'
            AND free_agent_draft_player_allocations.status =
              'deferred_restricted_recovery'
            AND auctions.opened_at_ms <
              auctions.resolves_at_ms - 3600000
            AND EXISTS (
              SELECT 1
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
                AND free_agent_draft_recoveries.fad_id =
                  NEW.fad_id
                AND free_agent_draft_recoveries.allocation_id =
                  NEW.fad_allocation_id
                AND free_agent_draft_recoveries.player_id =
                  auctions.player_id
                AND free_agent_draft_recoveries.rollover_id IS NULL
                AND free_agent_draft_recoveries.kind =
                  'deferred_restricted'
                AND free_agent_draft_recoveries.status = 'running'
                AND free_agent_draft_recoveries.updated_at_ms <=
                  auctions.opened_at_ms
                AND COALESCE(
                  free_agent_draft_recoveries.causal_started_at_ms,
                  free_agent_draft_recoveries.created_at_ms
                ) =
                  free_agent_draft_player_allocations.resolved_at_ms
                AND free_agent_draft_recoveries.last_error_code IS
                  free_agent_draft_player_allocations.last_error_code
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_recoveries AS successor
                  WHERE successor.league_id =
                      free_agent_draft_recoveries.league_id
                    AND successor.supersedes_recovery_id =
                      free_agent_draft_recoveries.id
                )
                AND free_agent_draft_recoveries
                  .earliest_activation_at_ms <=
                    auctions.opened_at_ms
                AND free_agent_draft_recoveries
                  .target_resolution_at_ms =
                    auctions.resolves_at_ms
                AND job_runs.season_id = NEW.season_id
                AND job_runs.job_type =
                  'fad_restricted_activation'
                AND job_runs.occurrence_key =
                  'fad:' || NEW.fad_id ||
                    ':restricted-activate:' ||
                    NEW.fad_allocation_id || ':' ||
                    free_agent_draft_recoveries
                      .earliest_activation_at_ms
                AND job_runs.scheduled_for_ms =
                  free_agent_draft_recoveries
                    .earliest_activation_at_ms
                AND job_runs.status IN ('leased', 'running')
                AND job_runs.attempt_count >= 1
                AND job_runs.lease_owner IS NOT NULL
                AND job_runs.lease_token IS NOT NULL
                AND job_runs.updated_at_ms <=
                  auctions.opened_at_ms
                AND job_runs.lease_expires_at_ms >
                  auctions.opened_at_ms
            )
          )
        )
    )
  THEN RAISE(
    ABORT,
    'restricted context requires its exact allocation and activation window'
  ) END;
END;

CREATE TRIGGER fad_auction_participants_forward_update
BEFORE UPDATE ON free_agent_draft_auction_participants
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'active'
    AND NEW.status = 'removed'
    AND NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.fad_id IS OLD.fad_id
    AND NEW.allocation_id IS OLD.allocation_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.source_snapshot_entry_id IS OLD.source_snapshot_entry_id
    AND NEW.originating_candidate_revision_id IS
      OLD.originating_candidate_revision_id
    AND NEW.seeded_bid_id IS OLD.seeded_bid_id
    AND NEW.seed_event_id IS OLD.seed_event_id
    AND NEW.original_total_value_cents IS
      OLD.original_total_value_cents
    AND NEW.original_term_years IS OLD.original_term_years
    AND NEW.original_aav_cents IS OLD.original_aav_cents
    AND NEW.cooldown_anchor_at_ms IS OLD.cooldown_anchor_at_ms
    AND NEW.manager_edit_limit IS OLD.manager_edit_limit
    AND NEW.minimum_final_total_cents IS
      OLD.minimum_final_total_cents
    AND NEW.originating_actor_user_id IS
      OLD.originating_actor_user_id
    AND NEW.originating_actor_membership_id IS
      OLD.originating_actor_membership_id
    AND NEW.originating_actor_authority IS
      OLD.originating_actor_authority
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.version = OLD.version + 1
    AND NEW.updated_at_ms = NEW.removed_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
  ) THEN RAISE(
    ABORT,
    'restricted participant only permits one versioned removal'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_player_allocations
    JOIN auctions
      ON auctions.league_id =
          free_agent_draft_player_allocations.league_id
     AND auctions.season_id =
          free_agent_draft_player_allocations.season_id
     AND auctions.id =
          free_agent_draft_player_allocations.restricted_auction_id
    WHERE free_agent_draft_player_allocations.league_id =
        NEW.league_id
      AND free_agent_draft_player_allocations.season_id =
        NEW.season_id
      AND free_agent_draft_player_allocations.fad_id = NEW.fad_id
      AND free_agent_draft_player_allocations.id = NEW.allocation_id
      AND free_agent_draft_player_allocations.status =
        'restricted_active'
      AND free_agent_draft_player_allocations.restricted_auction_id =
        NEW.auction_id
      AND auctions.status = 'open'
      AND NEW.removed_at_ms >= auctions.opened_at_ms
      AND NEW.removed_at_ms < auctions.resolves_at_ms
  ) THEN RAISE(
    ABORT,
    'restricted participant removal requires an active open auction'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_memberships
    WHERE league_memberships.league_id = NEW.league_id
      AND league_memberships.id = NEW.removed_by_membership_id
      AND league_memberships.user_id = NEW.removed_by_user_id
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
            WHERE platform_roles.user_id = NEW.removed_by_user_id
              AND platform_roles.role = 'platform_administrator'
              AND platform_roles.status = 'active'
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'restricted participant removal requires current commissioner authority'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_bids
    WHERE auction_bids.league_id = NEW.league_id
      AND auction_bids.id = NEW.seeded_bid_id
      AND auction_bids.auction_id = NEW.auction_id
      AND auction_bids.team_id = NEW.team_id
      AND auction_bids.status = 'withdrawn'
  ) THEN RAISE(
    ABORT,
    'restricted participant removal requires withdrawn seed bid'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_events
    WHERE auction_events.league_id = NEW.league_id
      AND auction_events.season_id = NEW.season_id
      AND auction_events.auction_id = NEW.auction_id
      AND auction_events.bid_id = NEW.seeded_bid_id
      AND auction_events.team_id = NEW.team_id
      AND auction_events.actor_user_id = NEW.removed_by_user_id
      AND auction_events.event_type = 'commissioner_bid_removed'
      AND auction_events.occurred_at_ms = NEW.removed_at_ms
  ) THEN RAISE(
    ABORT,
    'restricted participant removal requires exact commissioner event'
  ) END;
END;

CREATE TRIGGER fad_auction_participants_valid_insert
BEFORE INSERT ON free_agent_draft_auction_participants
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'active'
    AND NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
  ) THEN RAISE(
    ABORT,
    'restricted participant must begin active at version one'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN free_agent_drafts
      ON free_agent_drafts.league_id = auction_contexts.league_id
     AND free_agent_drafts.season_id = auction_contexts.season_id
     AND free_agent_drafts.id = auction_contexts.fad_id
    JOIN free_agent_draft_player_allocations
      ON free_agent_draft_player_allocations.league_id =
          auction_contexts.league_id
     AND free_agent_draft_player_allocations.season_id =
          auction_contexts.season_id
     AND free_agent_draft_player_allocations.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_player_allocations.id =
          auction_contexts.fad_allocation_id
     AND free_agent_draft_player_allocations.player_id =
          auctions.player_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.fad_allocation_id = NEW.allocation_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND auctions.status = 'open'
      AND auctions.opened_at_ms = NEW.created_at_ms
      AND free_agent_drafts.candidate_deadline_at_ms =
        NEW.cooldown_anchor_at_ms
      AND free_agent_draft_player_allocations
        .restricted_auction_id IS NULL
      AND (
        (
          free_agent_draft_player_allocations.status = 'pending'
          AND free_agent_draft_player_allocations.decision_code IS NULL
        )
        OR (
          free_agent_draft_player_allocations.status IN (
            'restricted_scheduled',
            'deferred_restricted_recovery',
            'correction_required'
          )
          AND free_agent_draft_player_allocations.decision_code =
            'exact_total_and_term_tie'
        )
      )
  ) THEN RAISE(
    ABORT,
    'restricted participant requires its staged restricted auction'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_card_snapshot_entries
    JOIN free_agent_draft_player_allocations
      ON free_agent_draft_player_allocations.league_id =
          candidate_card_snapshot_entries.league_id
     AND free_agent_draft_player_allocations.season_id =
          candidate_card_snapshot_entries.season_id
     AND free_agent_draft_player_allocations.fad_id =
          candidate_card_snapshot_entries.fad_id
     AND free_agent_draft_player_allocations.id =
          NEW.allocation_id
     AND free_agent_draft_player_allocations.player_id =
          candidate_card_snapshot_entries.player_id
    WHERE candidate_card_snapshot_entries.league_id =
        NEW.league_id
      AND candidate_card_snapshot_entries.season_id =
        NEW.season_id
      AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
      AND candidate_card_snapshot_entries.id =
        NEW.source_snapshot_entry_id
      AND candidate_card_snapshot_entries.team_id = NEW.team_id
      AND candidate_card_snapshot_entries.row_kind = 'slot'
      AND candidate_card_snapshot_entries.occupant_kind = 'candidate'
      AND candidate_card_snapshot_entries.source_entry_id IS NOT NULL
      AND candidate_card_snapshot_entries.eligibility_status IN (
        'valid',
        'warning'
      )
      AND candidate_card_snapshot_entries.proposed_total_value_cents =
        NEW.original_total_value_cents
      AND candidate_card_snapshot_entries.proposed_term_years =
        NEW.original_term_years
      AND candidate_card_snapshot_entries.proposed_aav_cents =
        NEW.original_aav_cents
  ) THEN RAISE(
    ABORT,
    'restricted participant must preserve one eligible Candidate offer'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM candidate_card_revisions
    JOIN candidate_card_snapshot_entries
      ON candidate_card_snapshot_entries.league_id =
          candidate_card_revisions.league_id
     AND candidate_card_snapshot_entries.season_id =
          candidate_card_revisions.season_id
     AND candidate_card_snapshot_entries.fad_id =
          candidate_card_revisions.fad_id
     AND candidate_card_snapshot_entries.card_id =
          candidate_card_revisions.card_id
     AND candidate_card_snapshot_entries.team_id =
          candidate_card_revisions.team_id
     AND candidate_card_snapshot_entries.source_entry_id =
          candidate_card_revisions.affected_entry_id
     AND candidate_card_snapshot_entries.player_id =
          candidate_card_revisions.player_id
    JOIN candidate_card_snapshots
      ON candidate_card_snapshots.league_id =
          candidate_card_snapshot_entries.league_id
     AND candidate_card_snapshots.id =
          candidate_card_snapshot_entries.snapshot_id
    WHERE candidate_card_revisions.league_id = NEW.league_id
      AND candidate_card_revisions.season_id = NEW.season_id
      AND candidate_card_revisions.fad_id = NEW.fad_id
      AND candidate_card_revisions.id =
        NEW.originating_candidate_revision_id
      AND candidate_card_snapshot_entries.id =
        NEW.source_snapshot_entry_id
      AND candidate_card_revisions.action IN (
        'candidate_added',
        'candidate_edited',
        'candidate_moved'
      )
      AND candidate_card_revisions.actor_authority <> 'system'
      AND candidate_card_revisions.actor_user_id =
        NEW.originating_actor_user_id
      AND candidate_card_revisions.actor_membership_id =
        NEW.originating_actor_membership_id
      AND candidate_card_revisions.actor_authority =
        NEW.originating_actor_authority
      AND candidate_card_revisions.resulting_card_version <=
        candidate_card_snapshots.locked_card_version
      AND NOT EXISTS (
        SELECT 1
        FROM candidate_card_revisions AS later_revision
        WHERE later_revision.league_id =
            candidate_card_revisions.league_id
          AND later_revision.season_id =
            candidate_card_revisions.season_id
          AND later_revision.fad_id = candidate_card_revisions.fad_id
          AND later_revision.card_id = candidate_card_revisions.card_id
          AND later_revision.team_id = candidate_card_revisions.team_id
          AND later_revision.affected_entry_id =
            candidate_card_revisions.affected_entry_id
          AND later_revision.player_id =
            candidate_card_revisions.player_id
          AND later_revision.action IN (
            'candidate_added',
            'candidate_edited',
            'candidate_moved'
          )
          AND later_revision.actor_authority <> 'system'
          AND later_revision.resulting_card_version >
            candidate_card_revisions.resulting_card_version
          AND later_revision.resulting_card_version <=
            candidate_card_snapshots.locked_card_version
      )
  ) THEN RAISE(
    ABORT,
    'restricted participant requires the originating Candidate revision as latest actor evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_card_snapshot_entries AS better_offer
    WHERE better_offer.league_id = NEW.league_id
      AND better_offer.season_id = NEW.season_id
      AND better_offer.fad_id = NEW.fad_id
      AND better_offer.player_id = (
        SELECT source_offer.player_id
        FROM candidate_card_snapshot_entries AS source_offer
        WHERE source_offer.league_id = NEW.league_id
          AND source_offer.id = NEW.source_snapshot_entry_id
      )
      AND better_offer.row_kind = 'slot'
      AND better_offer.occupant_kind = 'candidate'
      AND better_offer.eligibility_status IN ('valid', 'warning')
      AND (
        better_offer.proposed_total_value_cents >
          NEW.original_total_value_cents
        OR (
          better_offer.proposed_total_value_cents =
            NEW.original_total_value_cents
          AND better_offer.proposed_aav_cents >
            NEW.original_aav_cents
        )
      )
  ) THEN RAISE(
    ABORT,
    'restricted participant offer is not in the exact top ranking group'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM candidate_card_snapshot_entries AS tied_offer
    WHERE tied_offer.league_id = NEW.league_id
      AND tied_offer.season_id = NEW.season_id
      AND tied_offer.fad_id = NEW.fad_id
      AND tied_offer.player_id = (
        SELECT source_offer.player_id
        FROM candidate_card_snapshot_entries AS source_offer
        WHERE source_offer.league_id = NEW.league_id
          AND source_offer.id = NEW.source_snapshot_entry_id
      )
      AND tied_offer.row_kind = 'slot'
      AND tied_offer.occupant_kind = 'candidate'
      AND tied_offer.eligibility_status IN ('valid', 'warning')
      AND tied_offer.proposed_total_value_cents =
        NEW.original_total_value_cents
      AND tied_offer.proposed_term_years = NEW.original_term_years
  ) < 2 THEN RAISE(
    ABORT,
    'restricted participant requires an exact total-and-term tie'
  ) END;
END;

CREATE TRIGGER fad_auction_resolution_failure_events_insert
BEFORE INSERT ON auction_events
WHEN NEW.event_type = 'fad_auction_resolution_failed'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND auctions.status = 'failed'
      AND auctions.updated_at_ms = NEW.occurred_at_ms
      AND NEW.bid_id IS NULL
      AND NEW.team_id IS NULL
      AND NEW.actor_user_id IS NULL
      AND NEW.metadata_json IS NOT NULL
      AND json_valid(NEW.metadata_json) = 1
      AND json_type(NEW.metadata_json) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(NEW.metadata_json)
      ) = 3
      AND json_type(NEW.metadata_json, '$.recoveryId') = 'text'
      AND json_type(NEW.metadata_json, '$.jobRunId') = 'text'
      AND json_type(NEW.metadata_json, '$.errorCode') = 'text'
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        JOIN job_runs
          ON job_runs.league_id =
              free_agent_draft_recoveries.league_id
         AND job_runs.id =
              free_agent_draft_recoveries.job_run_id
        WHERE free_agent_draft_recoveries.league_id =
            auction_contexts.league_id
          AND free_agent_draft_recoveries.season_id =
            auction_contexts.season_id
          AND free_agent_draft_recoveries.fad_id =
            auction_contexts.fad_id
          AND free_agent_draft_recoveries.player_id =
            auctions.player_id
          AND free_agent_draft_recoveries.allocation_id IS
            auction_contexts.fad_allocation_id
          AND free_agent_draft_recoveries.rollover_id IS
            auction_contexts.fad_rollover_id
          AND free_agent_draft_recoveries.auction_id =
            auction_contexts.auction_id
          AND free_agent_draft_recoveries.kind =
            'auction_resolution'
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
          AND free_agent_draft_recoveries.created_at_ms =
            auctions.updated_at_ms
          AND free_agent_draft_recoveries.last_error_code =
            json_extract(NEW.metadata_json, '$.errorCode')
          AND free_agent_draft_recoveries.id =
            json_extract(NEW.metadata_json, '$.recoveryId')
          AND free_agent_draft_recoveries.job_run_id =
            json_extract(NEW.metadata_json, '$.jobRunId')
          AND job_runs.id =
            json_extract(NEW.metadata_json, '$.jobRunId')
          AND job_runs.season_id = auction_contexts.season_id
          AND job_runs.job_type = 'auction.resolve.target'
          AND job_runs.occurrence_key =
            'auction:' || auctions.id || ':' || auctions.resolves_at_ms
          AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
          AND job_runs.status = 'failed'
          AND job_runs.attempt_count >= 1
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.started_at_ms IS NOT NULL
          AND job_runs.started_at_ms <= NEW.occurred_at_ms
          AND job_runs.completed_at_ms = NEW.occurred_at_ms
          AND job_runs.result_json IS NULL
          AND job_runs.last_error_code =
            json_extract(NEW.metadata_json, '$.errorCode')
          AND job_runs.next_attempt_at_ms = NEW.occurred_at_ms
          AND job_runs.updated_at_ms = NEW.occurred_at_ms
      )
      AND NOT EXISTS (
        SELECT 1
        FROM auction_resolutions
        WHERE auction_resolutions.league_id = NEW.league_id
          AND auction_resolutions.auction_id = NEW.auction_id
      )
  ) THEN RAISE(
    ABORT,
    'FAD operational failure requires its exact system failure event'
  ) END;
END;

CREATE TRIGGER fad_failed_auctions_recovery_update
BEFORE UPDATE OF status ON auctions
WHEN OLD.status = 'failed'
  AND NEW.status <> OLD.status
  AND EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = OLD.version + 1
    AND NEW.updated_at_ms > OLD.updated_at_ms
    AND NEW.updated_at_ms >= OLD.resolves_at_ms
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = OLD.league_id
        AND auction_contexts.season_id = OLD.season_id
        AND auction_contexts.auction_id = OLD.id
        AND (
          (
            auction_contexts.source_kind = 'fad_open_rapid'
            AND NEW.status = 'cancelled'
          )
          OR (
            auction_contexts.source_kind = 'fad_restricted'
            AND NEW.status IN (
              'resolved',
              'no_winner',
              'cancelled'
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'failed FAD auction may only advance through approved recovery'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM auction_contexts
    JOIN free_agent_draft_recoveries
      ON free_agent_draft_recoveries.league_id =
          auction_contexts.league_id
     AND free_agent_draft_recoveries.season_id =
          auction_contexts.season_id
     AND free_agent_draft_recoveries.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_recoveries.player_id = OLD.player_id
     AND free_agent_draft_recoveries.allocation_id IS
          auction_contexts.fad_allocation_id
     AND free_agent_draft_recoveries.rollover_id IS
          auction_contexts.fad_rollover_id
     AND free_agent_draft_recoveries.auction_id =
          auction_contexts.auction_id
     AND free_agent_draft_recoveries.kind =
          'auction_resolution'
    JOIN job_runs
      ON job_runs.league_id =
          free_agent_draft_recoveries.league_id
     AND job_runs.id = free_agent_draft_recoveries.job_run_id
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND free_agent_draft_recoveries.status = 'running'
      AND free_agent_draft_recoveries.created_at_ms =
        OLD.updated_at_ms
      AND free_agent_draft_recoveries.updated_at_ms <=
        NEW.updated_at_ms
      AND job_runs.season_id = OLD.season_id
      AND job_runs.job_type = 'auction.resolve.target'
      AND job_runs.occurrence_key =
        'auction:' || OLD.id || ':' || OLD.resolves_at_ms
      AND job_runs.scheduled_for_ms = OLD.resolves_at_ms
      AND job_runs.status IN ('leased', 'running')
      AND job_runs.attempt_count >= 1
      AND job_runs.lease_owner IS NOT NULL
      AND job_runs.lease_token IS NOT NULL
      AND job_runs.updated_at_ms <= NEW.updated_at_ms
      AND job_runs.lease_expires_at_ms > NEW.updated_at_ms
  ) <> 1 THEN RAISE(
    ABORT,
    'failed FAD auction recovery requires its exact active lease'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_events
    WHERE auction_events.league_id = OLD.league_id
      AND auction_events.season_id = OLD.season_id
      AND auction_events.auction_id = OLD.id
      AND auction_events.event_type =
        'fad_auction_resolution_failed'
      AND auction_events.actor_user_id IS NULL
      AND auction_events.bid_id IS NULL
      AND auction_events.team_id IS NULL
      AND auction_events.occurred_at_ms = OLD.updated_at_ms
  ) OR EXISTS (
    SELECT 1
    FROM auction_resolutions
    WHERE auction_resolutions.league_id = OLD.league_id
      AND auction_resolutions.auction_id = OLD.id
  ) THEN RAISE(
    ABORT,
    'failed FAD auction recovery requires unresolved failure evidence'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind = 'fad_restricted'
  ) AND NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN free_agent_draft_player_allocations
      ON free_agent_draft_player_allocations.league_id =
          auction_contexts.league_id
     AND free_agent_draft_player_allocations.season_id =
          auction_contexts.season_id
     AND free_agent_draft_player_allocations.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_player_allocations.id =
          auction_contexts.fad_allocation_id
    JOIN free_agent_draft_draws
      ON free_agent_draft_draws.league_id =
          auction_contexts.league_id
     AND free_agent_draft_draws.season_id =
          auction_contexts.season_id
     AND free_agent_draft_draws.fad_id = auction_contexts.fad_id
     AND free_agent_draft_draws.allocation_id =
          auction_contexts.fad_allocation_id
     AND free_agent_draft_draws.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND free_agent_draft_player_allocations.status =
          'correction_required'
      AND free_agent_draft_player_allocations
        .restricted_auction_id = OLD.id
      AND free_agent_draft_draws.revealed_at_ms IS NULL
      AND free_agent_draft_draws.version = 1
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_auction_participants
          AS retry_participant
        JOIN auction_bids AS retry_bid
          ON retry_bid.league_id = retry_participant.league_id
         AND retry_bid.auction_id = retry_participant.auction_id
         AND retry_bid.team_id = retry_participant.team_id
         AND retry_bid.id = retry_participant.seeded_bid_id
        WHERE retry_participant.league_id =
            auction_contexts.league_id
          AND retry_participant.season_id =
            auction_contexts.season_id
          AND retry_participant.fad_id = auction_contexts.fad_id
          AND retry_participant.allocation_id =
            auction_contexts.fad_allocation_id
          AND retry_participant.auction_id =
            auction_contexts.auction_id
          AND (
            (
              retry_participant.status = 'active'
              AND retry_bid.status <> 'active'
            )
            OR (
              retry_participant.status = 'removed'
              AND retry_bid.status <> 'withdrawn'
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'failed restricted retry requires frozen private draw evidence'
  ) END;
END;

CREATE TRIGGER fad_open_rapid_failure_recoveries_terminal_update
BEFORE UPDATE OF status ON free_agent_draft_recoveries
WHEN NEW.status = 'resolved'
  AND NEW.kind = 'auction_resolution'
  AND NEW.allocation_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.source_kind = 'fad_open_rapid'
  )
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'running'
    AND (
      SELECT COUNT(*)
      FROM auction_contexts
      JOIN auctions
        ON auctions.league_id = auction_contexts.league_id
       AND auctions.season_id = auction_contexts.season_id
       AND auctions.id = auction_contexts.auction_id
      JOIN auction_resolutions
        ON auction_resolutions.league_id =
            auction_contexts.league_id
       AND auction_resolutions.season_id =
            auction_contexts.season_id
       AND auction_resolutions.auction_id =
            auction_contexts.auction_id
      JOIN job_runs
        ON job_runs.league_id = NEW.league_id
       AND job_runs.id = NEW.job_run_id
      JOIN auction_events
        ON auction_events.league_id = auction_contexts.league_id
       AND auction_events.season_id = auction_contexts.season_id
       AND auction_events.auction_id =
            auction_contexts.auction_id
       AND auction_events.event_type =
            'fad_auction_resolution_failed'
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.fad_id = NEW.fad_id
        AND auction_contexts.source_kind = 'fad_open_rapid'
        AND auction_contexts.fad_allocation_id IS NULL
        AND auction_contexts.fad_rollover_id IS NEW.rollover_id
        AND auctions.player_id = NEW.player_id
        AND auctions.status = 'cancelled'
        AND auctions.updated_at_ms = NEW.resolved_at_ms
        AND auction_resolutions.status = 'cancelled'
        AND auction_resolutions.outcome_code = 'recovered'
        AND auction_resolutions.scheduled_occurrence_key =
          'auction:' || auctions.id || ':' || auctions.resolves_at_ms
        AND auction_resolutions.winning_team_id IS NULL
        AND auction_resolutions.winning_bid_id IS NULL
        AND auction_resolutions.highest_bid_cents IS NULL
        AND auction_resolutions.second_price_input_cents IS NULL
        AND auction_resolutions.final_contract_value_cents IS NULL
        AND auction_resolutions.winning_term_years IS NULL
        AND auction_resolutions.final_aav_cents IS NULL
        AND auction_resolutions.general_illegal = 0
        AND auction_resolutions.warnings_json = '[]'
        AND auction_resolutions.contract_id IS NULL
        AND auction_resolutions.ownership_id IS NULL
        AND auction_resolutions.trigger_type = 'commissioner'
        AND auction_resolutions.triggered_by_user_id IS NOT NULL
        AND auction_resolutions.resolved_at_ms =
          NEW.resolved_at_ms
        AND job_runs.season_id = NEW.season_id
        AND job_runs.job_type = 'auction.resolve.target'
        AND job_runs.occurrence_key =
          auction_resolutions.scheduled_occurrence_key
        AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
        AND job_runs.status IN ('leased', 'running')
        AND job_runs.attempt_count >= 1
        AND job_runs.lease_owner IS NOT NULL
        AND job_runs.lease_token IS NOT NULL
        AND job_runs.lease_expires_at_ms > NEW.resolved_at_ms
        AND job_runs.completed_at_ms IS NULL
        AND job_runs.result_json IS NULL
        AND job_runs.last_error_code IS NULL
        AND job_runs.next_attempt_at_ms IS NULL
        AND job_runs.updated_at_ms <= NEW.resolved_at_ms
        AND auction_events.actor_user_id IS NULL
        AND auction_events.bid_id IS NULL
        AND auction_events.team_id IS NULL
        AND auction_events.occurred_at_ms = NEW.created_at_ms
        AND json_extract(
          auction_events.metadata_json,
          '$.recoveryId'
        ) = NEW.id
        AND json_extract(
          auction_events.metadata_json,
          '$.jobRunId'
        ) = NEW.job_run_id
        AND json_extract(
          auction_events.metadata_json,
          '$.errorCode'
        ) = NEW.last_error_code
    ) = 1
  ) THEN RAISE(
    ABORT,
    'open rapid recovery requires its exact terminal evidence chain'
  ) END;
END;

CREATE TRIGGER fad_restricted_bids_forward_update
BEFORE UPDATE ON auction_bids
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind = 'fad_restricted'
)
BEGIN
  SELECT CASE WHEN OLD.status <> 'active' THEN RAISE(
    ABORT,
    'terminal restricted bid evidence is immutable'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.auction_id IS OLD.auction_id
    AND NEW.team_id IS OLD.team_id
    AND NEW.submitted_by_user_id IS OLD.submitted_by_user_id
    AND NEW.first_submitted_at_ms IS OLD.first_submitted_at_ms
    AND NEW.version = OLD.version + 1
    AND NEW.last_edited_at_ms >= OLD.last_edited_at_ms
  ) THEN RAISE(
    ABORT,
    'restricted bid identity and version history are immutable'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_auction_participants
    WHERE free_agent_draft_auction_participants.league_id =
        OLD.league_id
      AND free_agent_draft_auction_participants.auction_id =
        OLD.auction_id
      AND free_agent_draft_auction_participants.team_id = OLD.team_id
      AND free_agent_draft_auction_participants.seeded_bid_id = OLD.id
      AND free_agent_draft_auction_participants.status = 'active'
  ) THEN RAISE(
    ABORT,
    'removed or absent restricted participant cannot mutate a bid'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status = 'active'
    AND NOT (
      NEW.total_value_cents >= (
        SELECT minimum_final_total_cents
        FROM free_agent_draft_auction_participants
        WHERE league_id = OLD.league_id
          AND auction_id = OLD.auction_id
          AND team_id = OLD.team_id
      )
      AND NEW.total_value_cents >= CASE NEW.term_years
        WHEN 1 THEN 150
        WHEN 2 THEN 300
        WHEN 3 THEN 500
      END
      AND (
        NEW.term_years = 1
        OR NEW.total_value_cents % 100 = 0
      )
      AND NEW.lowest_offered_aav_cents = MIN(
        OLD.lowest_offered_aav_cents,
        (NEW.total_value_cents / NEW.term_years)
          + CASE
              WHEN
                (NEW.total_value_cents % NEW.term_years) * 2
                  >= NEW.term_years
              THEN 1
              ELSE 0
            END
      )
      AND NEW.edit_count <= (
        SELECT manager_edit_limit
        FROM free_agent_draft_auction_participants
        WHERE league_id = OLD.league_id
          AND auction_id = OLD.auction_id
          AND team_id = OLD.team_id
      )
      AND EXISTS (
        SELECT 1
        FROM auction_contexts
        JOIN auctions
          ON auctions.league_id = auction_contexts.league_id
         AND auctions.season_id = auction_contexts.season_id
         AND auctions.id = auction_contexts.auction_id
        JOIN free_agent_draft_player_allocations
          ON free_agent_draft_player_allocations.league_id =
              auction_contexts.league_id
         AND free_agent_draft_player_allocations.season_id =
              auction_contexts.season_id
         AND free_agent_draft_player_allocations.fad_id =
              auction_contexts.fad_id
         AND free_agent_draft_player_allocations.id =
              auction_contexts.fad_allocation_id
        WHERE auction_contexts.league_id = OLD.league_id
          AND auction_contexts.season_id = OLD.season_id
          AND auction_contexts.auction_id = OLD.auction_id
          AND auction_contexts.source_kind = 'fad_restricted'
          AND auctions.status = 'open'
          AND free_agent_draft_player_allocations.status =
            'restricted_active'
          AND free_agent_draft_player_allocations
            .restricted_auction_id = OLD.auction_id
      )
      AND NEW.last_edited_at_ms < (
        SELECT auctions.resolves_at_ms
        FROM auctions
        WHERE auctions.league_id = OLD.league_id
          AND auctions.id = OLD.auction_id
      )
      AND NEW.idempotency_request_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM idempotency_requests
        JOIN auction_events
          ON auction_events.league_id =
              idempotency_requests.league_id
         AND auction_events.auction_id = OLD.auction_id
         AND auction_events.bid_id = OLD.id
         AND auction_events.team_id = OLD.team_id
         AND auction_events.actor_user_id =
              idempotency_requests.actor_user_id
         AND auction_events.event_type = 'bid_edited'
         AND auction_events.occurred_at_ms =
              NEW.last_edited_at_ms
        WHERE idempotency_requests.league_id = OLD.league_id
          AND idempotency_requests.id =
            NEW.idempotency_request_id
          AND idempotency_requests.operation = 'auction.bid.put'
          AND idempotency_requests.status IN ('started', 'completed')
          AND idempotency_requests.created_at_ms =
            NEW.last_edited_at_ms
          AND (
            (
              NEW.edit_count = OLD.edit_count + 1
              AND NEW.last_edited_at_ms >= (
                SELECT
                  free_agent_draft_auction_participants
                    .cooldown_anchor_at_ms + 4500000
                FROM free_agent_draft_auction_participants
                WHERE
                  free_agent_draft_auction_participants.league_id =
                    OLD.league_id
                  AND
                    free_agent_draft_auction_participants.auction_id =
                      OLD.auction_id
                  AND free_agent_draft_auction_participants.team_id =
                    OLD.team_id
              )
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
                    OLD.league_id
                  AND team_manager_assignments.team_id = OLD.team_id
                  AND team_manager_assignments.user_id =
                    idempotency_requests.actor_user_id
                  AND team_manager_assignments.status = 'accepted'
                  AND team_manager_assignments.ended_at_ms IS NULL
                  AND league_memberships.status = 'active'
              )
            )
            OR (
              NEW.edit_count = OLD.edit_count
              AND EXISTS (
                SELECT 1
                FROM league_memberships
                WHERE league_memberships.league_id = OLD.league_id
                  AND league_memberships.user_id =
                    idempotency_requests.actor_user_id
                  AND league_memberships.status = 'active'
                  AND (
                    EXISTS (
                      SELECT 1
                      FROM leagues
                      WHERE leagues.id = OLD.league_id
                        AND leagues.commissioner_membership_id =
                          league_memberships.id
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM platform_roles
                      WHERE platform_roles.user_id =
                          idempotency_requests.actor_user_id
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
  THEN RAISE(
    ABORT,
    'restricted bid edit exceeds its floor or manager edit limit'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status = 'withdrawn'
    AND NOT EXISTS (
      SELECT 1
      FROM auction_events
      JOIN auction_contexts
        ON auction_contexts.league_id = auction_events.league_id
       AND auction_contexts.season_id = auction_events.season_id
       AND auction_contexts.auction_id = auction_events.auction_id
       AND auction_contexts.source_kind = 'fad_restricted'
      JOIN auctions
        ON auctions.league_id = auction_contexts.league_id
       AND auctions.season_id = auction_contexts.season_id
       AND auctions.id = auction_contexts.auction_id
      JOIN free_agent_draft_player_allocations
        ON free_agent_draft_player_allocations.league_id =
            auction_contexts.league_id
       AND free_agent_draft_player_allocations.season_id =
            auction_contexts.season_id
       AND free_agent_draft_player_allocations.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_player_allocations.id =
            auction_contexts.fad_allocation_id
      WHERE auction_events.league_id = OLD.league_id
        AND auction_events.season_id = OLD.season_id
        AND auction_events.auction_id = OLD.auction_id
        AND auction_events.bid_id = OLD.id
        AND auction_events.team_id = OLD.team_id
        AND auction_events.event_type = 'commissioner_bid_removed'
        AND auction_events.occurred_at_ms = NEW.last_edited_at_ms
        AND auctions.status = 'open'
        AND free_agent_draft_player_allocations.status =
          'restricted_active'
        AND free_agent_draft_player_allocations
          .restricted_auction_id = OLD.auction_id
        AND NEW.last_edited_at_ms >= auctions.opened_at_ms
        AND NEW.last_edited_at_ms < auctions.resolves_at_ms
    )
  THEN RAISE(
    ABORT,
    'restricted bid withdrawal requires commissioner removal event'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status IN ('won', 'lost', 'invalid', 'cancelled')
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      JOIN free_agent_draft_draws
        ON free_agent_draft_draws.league_id = auctions.league_id
       AND free_agent_draft_draws.auction_id = auctions.id
      WHERE auctions.league_id = OLD.league_id
        AND auctions.season_id = OLD.season_id
        AND auctions.id = OLD.auction_id
        AND auctions.status IN (
          'resolved',
          'no_winner',
          'cancelled'
        )
        AND free_agent_draft_draws.revealed_at_ms IS NOT NULL
        AND free_agent_draft_draws.revealed_at_ms =
          auctions.updated_at_ms
    )
  THEN RAISE(
    ABORT,
    'restricted terminal bid update requires terminal draw reveal'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status IN ('won', 'lost', 'invalid', 'cancelled')
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = OLD.league_id
        AND auctions.id = OLD.auction_id
        AND (
          (
            auctions.status = 'resolved'
            AND NEW.status IN ('won', 'lost', 'invalid')
          )
          OR (
            auctions.status = 'no_winner'
            AND NEW.status = 'invalid'
          )
          OR (
            auctions.status = 'cancelled'
            AND NEW.status = 'cancelled'
          )
        )
    )
  THEN RAISE(
    ABORT,
    'restricted terminal bid status must match the auction outcome'
  ) END;

  -- Winner-first terminalization preserves the live ranking evidence. The
  -- selected random winner (if any), or the sole highest-AAV/shortest-term
  -- bid, must become Won before any competing bid can leave Active.
  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status = 'won'
    AND NOT (
      EXISTS (
        SELECT 1
        FROM fad_restricted_eligible_bids
        WHERE fad_restricted_eligible_bids.league_id = OLD.league_id
          AND fad_restricted_eligible_bids.season_id = OLD.season_id
          AND fad_restricted_eligible_bids.auction_id = OLD.auction_id
          AND fad_restricted_eligible_bids.team_id = OLD.team_id
          AND fad_restricted_eligible_bids.bid_id = OLD.id
          AND fad_restricted_eligible_bids.bid_status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM auctions
        JOIN free_agent_draft_draws
          ON free_agent_draft_draws.league_id = auctions.league_id
         AND free_agent_draft_draws.auction_id = auctions.id
        WHERE auctions.league_id = OLD.league_id
          AND auctions.season_id = OLD.season_id
          AND auctions.id = OLD.auction_id
          AND auctions.status = 'resolved'
          AND free_agent_draft_draws.revealed_at_ms =
            auctions.updated_at_ms
          AND (
            (
              free_agent_draft_draws.selected_bid_id = OLD.id
              AND free_agent_draft_draws.selected_team_id = OLD.team_id
            )
            OR (
              free_agent_draft_draws.selected_bid_id IS NULL
              AND free_agent_draft_draws.selected_team_id IS NULL
              AND free_agent_draft_draws
                .ordered_tied_bid_ids_json = '[]'
              AND NOT EXISTS (
                SELECT 1
                FROM fad_restricted_eligible_bids AS competing_bid
                WHERE competing_bid.league_id = OLD.league_id
                  AND competing_bid.auction_id = OLD.auction_id
                  AND competing_bid.bid_id <> OLD.id
                  AND competing_bid.bid_status = 'active'
                  AND (
                    (
                      (competing_bid.total_value_cents /
                        competing_bid.term_years)
                      + CASE
                          WHEN
                            (competing_bid.total_value_cents %
                              competing_bid.term_years) * 2
                              >= competing_bid.term_years
                          THEN 1
                          ELSE 0
                        END
                    ) > (
                      (OLD.total_value_cents / OLD.term_years)
                      + CASE
                          WHEN
                            (OLD.total_value_cents % OLD.term_years) * 2
                              >= OLD.term_years
                          THEN 1
                          ELSE 0
                        END
                    )
                    OR (
                      (
                        (competing_bid.total_value_cents /
                          competing_bid.term_years)
                        + CASE
                            WHEN
                              (competing_bid.total_value_cents %
                                competing_bid.term_years) * 2
                                >= competing_bid.term_years
                            THEN 1
                            ELSE 0
                          END
                      ) = (
                        (OLD.total_value_cents / OLD.term_years)
                        + CASE
                            WHEN
                              (OLD.total_value_cents % OLD.term_years) * 2
                                >= OLD.term_years
                            THEN 1
                            ELSE 0
                          END
                      )
                      AND competing_bid.term_years <= OLD.term_years
                    )
                  )
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_auction_participants
          AS pending_participant
        JOIN auction_bids AS pending_bid
          ON pending_bid.league_id = pending_participant.league_id
         AND pending_bid.auction_id = pending_participant.auction_id
         AND pending_bid.team_id = pending_participant.team_id
         AND pending_bid.id = pending_participant.seeded_bid_id
        WHERE pending_participant.league_id = OLD.league_id
          AND pending_participant.auction_id = OLD.auction_id
          AND pending_participant.status = 'active'
          AND pending_bid.id <> OLD.id
          AND pending_bid.status <> 'active'
      )
    )
  THEN RAISE(
    ABORT,
    'restricted winner must be eligible and selected or unique live top'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status = 'lost'
    AND NOT (
      EXISTS (
        SELECT 1
        FROM fad_restricted_eligible_bids
        WHERE fad_restricted_eligible_bids.league_id = OLD.league_id
          AND fad_restricted_eligible_bids.season_id = OLD.season_id
          AND fad_restricted_eligible_bids.auction_id = OLD.auction_id
          AND fad_restricted_eligible_bids.team_id = OLD.team_id
          AND fad_restricted_eligible_bids.bid_id = OLD.id
          AND fad_restricted_eligible_bids.bid_status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = OLD.league_id
          AND auctions.id = OLD.auction_id
          AND auctions.status = 'resolved'
      )
      AND (
        SELECT COUNT(*)
        FROM fad_restricted_eligible_bids AS winner_bid
        WHERE winner_bid.league_id = OLD.league_id
          AND winner_bid.auction_id = OLD.auction_id
          AND winner_bid.bid_status = 'won'
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_auction_participants AS resolved_participant
        JOIN auction_bids AS resolved_bid
          ON resolved_bid.league_id = resolved_participant.league_id
         AND resolved_bid.auction_id = resolved_participant.auction_id
         AND resolved_bid.team_id = resolved_participant.team_id
         AND resolved_bid.id = resolved_participant.seeded_bid_id
        WHERE resolved_participant.league_id = OLD.league_id
          AND resolved_participant.auction_id = OLD.auction_id
          AND resolved_participant.status = 'active'
          AND resolved_bid.id <> OLD.id
          AND resolved_bid.status NOT IN (
            'active',
            'won',
            'lost',
            'invalid'
          )
      )
    )
  THEN RAISE(
    ABORT,
    'restricted losing bid must be ordinarily eligible'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status = 'invalid'
    AND EXISTS (
      SELECT 1
      FROM fad_restricted_eligible_bids
      WHERE fad_restricted_eligible_bids.league_id = OLD.league_id
        AND fad_restricted_eligible_bids.season_id = OLD.season_id
        AND fad_restricted_eligible_bids.auction_id = OLD.auction_id
        AND fad_restricted_eligible_bids.team_id = OLD.team_id
        AND fad_restricted_eligible_bids.bid_id = OLD.id
        AND fad_restricted_eligible_bids.bid_status = 'active'
    )
  THEN RAISE(
    ABORT,
    'restricted bid cannot be invalid while ordinarily eligible'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status = 'invalid'
    AND NOT (
      (
        EXISTS (
          SELECT 1
          FROM auctions
          WHERE auctions.league_id = OLD.league_id
            AND auctions.id = OLD.auction_id
            AND auctions.status = 'resolved'
        )
        AND (
          SELECT COUNT(*)
          FROM fad_restricted_eligible_bids AS resolved_winner
          WHERE resolved_winner.league_id = OLD.league_id
            AND resolved_winner.auction_id = OLD.auction_id
            AND resolved_winner.bid_status = 'won'
        ) = 1
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_auction_participants
            AS resolved_participant
          JOIN auction_bids AS resolved_bid
            ON resolved_bid.league_id = resolved_participant.league_id
           AND resolved_bid.auction_id =
                resolved_participant.auction_id
           AND resolved_bid.team_id = resolved_participant.team_id
           AND resolved_bid.id = resolved_participant.seeded_bid_id
          WHERE resolved_participant.league_id = OLD.league_id
            AND resolved_participant.auction_id = OLD.auction_id
            AND resolved_participant.status = 'active'
            AND resolved_bid.id <> OLD.id
            AND resolved_bid.status NOT IN (
              'active',
              'won',
              'lost',
              'invalid'
            )
        )
      )
      OR (
        EXISTS (
          SELECT 1
          FROM auctions
          WHERE auctions.league_id = OLD.league_id
            AND auctions.id = OLD.auction_id
            AND auctions.status = 'no_winner'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM fad_restricted_eligible_bids
          WHERE fad_restricted_eligible_bids.league_id =
              OLD.league_id
            AND fad_restricted_eligible_bids.auction_id =
              OLD.auction_id
            AND fad_restricted_eligible_bids.bid_status = 'active'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_auction_participants
            AS no_winner_participant
          JOIN auction_bids AS no_winner_bid
            ON no_winner_bid.league_id =
                no_winner_participant.league_id
           AND no_winner_bid.auction_id =
                no_winner_participant.auction_id
           AND no_winner_bid.team_id =
                no_winner_participant.team_id
           AND no_winner_bid.id =
                no_winner_participant.seeded_bid_id
          WHERE no_winner_participant.league_id = OLD.league_id
            AND no_winner_participant.auction_id = OLD.auction_id
            AND no_winner_participant.status = 'active'
            AND no_winner_bid.id <> OLD.id
            AND no_winner_bid.status NOT IN ('active', 'invalid')
        )
      )
    )
  THEN RAISE(
    ABORT,
    'restricted invalid bid requires an ineligible resolved path'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'active'
    AND NEW.status = 'cancelled'
    AND NOT (
      EXISTS (
        SELECT 1
        FROM auctions
        WHERE auctions.league_id = OLD.league_id
          AND auctions.id = OLD.auction_id
          AND auctions.status = 'cancelled'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_auction_participants
          AS cancelled_participant
        JOIN auction_bids AS cancelled_bid
          ON cancelled_bid.league_id = cancelled_participant.league_id
         AND cancelled_bid.auction_id =
              cancelled_participant.auction_id
         AND cancelled_bid.team_id = cancelled_participant.team_id
         AND cancelled_bid.id = cancelled_participant.seeded_bid_id
        WHERE cancelled_participant.league_id = OLD.league_id
          AND cancelled_participant.auction_id = OLD.auction_id
          AND cancelled_participant.status = 'active'
          AND cancelled_bid.id <> OLD.id
          AND cancelled_bid.status NOT IN ('active', 'cancelled')
      )
    )
  THEN RAISE(
    ABORT,
    'restricted cancelled bids must use the exact cancelled status set'
  ) END;

  SELECT CASE WHEN NOT (
    (
      OLD.status = 'active'
      AND (
        NEW.status = 'active'
        OR (
          NEW.status = 'withdrawn'
          AND NEW.total_value_cents IS OLD.total_value_cents
          AND NEW.term_years IS OLD.term_years
          AND NEW.lowest_offered_aav_cents IS
            OLD.lowest_offered_aav_cents
          AND NEW.edit_count IS OLD.edit_count
          AND (
            NEW.idempotency_request_id IS
              OLD.idempotency_request_id
            OR (
              NEW.idempotency_request_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM idempotency_requests
                WHERE idempotency_requests.league_id =
                    OLD.league_id
                  AND idempotency_requests.id =
                    NEW.idempotency_request_id
                  AND idempotency_requests.status IN (
                    'started',
                    'completed'
                  )
                  AND idempotency_requests.created_at_ms <=
                    NEW.last_edited_at_ms
              )
            )
          )
        )
        OR (
          NEW.status IN ('won', 'lost', 'invalid', 'cancelled')
          AND NEW.total_value_cents IS OLD.total_value_cents
          AND NEW.term_years IS OLD.term_years
          AND NEW.lowest_offered_aav_cents IS
            OLD.lowest_offered_aav_cents
          AND NEW.last_edited_at_ms IS OLD.last_edited_at_ms
          AND NEW.edit_count IS OLD.edit_count
          AND NEW.idempotency_request_id IS
            OLD.idempotency_request_id
        )
      )
    )
    OR (
      OLD.status IS NEW.status
      AND NEW.total_value_cents IS OLD.total_value_cents
      AND NEW.term_years IS OLD.term_years
      AND NEW.lowest_offered_aav_cents IS
        OLD.lowest_offered_aav_cents
      AND NEW.last_edited_at_ms IS OLD.last_edited_at_ms
      AND NEW.edit_count IS OLD.edit_count
      AND NEW.idempotency_request_id IS OLD.idempotency_request_id
    )
  ) THEN RAISE(
    ABORT,
    'restricted bid status transition is invalid'
  ) END;
END;

CREATE TRIGGER fad_restricted_cancellation_recoveries_terminal_update
BEFORE UPDATE OF status ON free_agent_draft_recoveries
WHEN NEW.status = 'resolved'
  AND NEW.kind = 'auction_resolution'
  AND NEW.allocation_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auction_resolutions
      ON auction_resolutions.league_id =
          auction_contexts.league_id
     AND auction_resolutions.season_id =
          auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND auction_resolutions.status = 'cancelled'
      AND auction_resolutions.outcome_code = 'failed'
  )
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN auction_resolutions
      ON auction_resolutions.league_id =
          auction_contexts.league_id
     AND auction_resolutions.season_id =
          auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    JOIN free_agent_draft_player_allocations AS allocation
      ON allocation.league_id = auction_contexts.league_id
     AND allocation.season_id = auction_contexts.season_id
     AND allocation.fad_id = auction_contexts.fad_id
     AND allocation.id = auction_contexts.fad_allocation_id
    JOIN free_agent_draft_allocation_events AS correction_event
      ON correction_event.league_id = allocation.league_id
     AND correction_event.season_id = allocation.season_id
     AND correction_event.fad_id = allocation.fad_id
     AND correction_event.allocation_id = allocation.id
     AND correction_event.event_kind = 'correction_applied'
    JOIN commissioner_corrections
      ON commissioner_corrections.league_id =
          correction_event.league_id
     AND commissioner_corrections.season_id =
          correction_event.season_id
     AND commissioner_corrections.id =
          correction_event.correction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND auction_contexts.fad_allocation_id = NEW.allocation_id
      AND auction_contexts.fad_rollover_id IS NEW.rollover_id
      AND auctions.player_id = NEW.player_id
      AND auctions.status = 'cancelled'
      AND auction_resolutions.status = 'cancelled'
      AND auction_resolutions.outcome_code = 'failed'
      AND auction_resolutions.scheduled_occurrence_key =
        'auction:' || auctions.id || ':' || auctions.resolves_at_ms
      AND auction_resolutions.resolved_at_ms <= NEW.resolved_at_ms
      AND allocation.player_id = NEW.player_id
      AND allocation.status = 'restricted_resolved'
      AND allocation.decision_code = 'corrected'
      AND allocation.restricted_auction_id = NEW.auction_id
      AND allocation.last_error_code IS NULL
      AND allocation.resolved_at_ms = NEW.resolved_at_ms
      AND allocation.updated_at_ms = NEW.resolved_at_ms
      AND correction_event.allocation_version = allocation.version
      AND correction_event.player_id = NEW.player_id
      AND correction_event.decision_code = 'corrected'
      AND correction_event.resulting_allocation_status =
        'restricted_resolved'
      AND correction_event.auction_id = NEW.auction_id
      AND correction_event.actor_user_id =
        NEW.resolved_by_user_id
      AND correction_event.actor_membership_id =
        NEW.resolved_by_membership_id
      AND correction_event.actor_authority =
        NEW.resolved_authority
      AND correction_event.occurred_at_ms = NEW.resolved_at_ms
      AND correction_event.created_at_ms = NEW.resolved_at_ms
      AND commissioner_corrections.feature =
        'free_agent_draft_allocation'
      AND commissioner_corrections.feature_record_id =
        NEW.allocation_id
      AND commissioner_corrections.actor_user_id =
        NEW.resolved_by_user_id
      AND commissioner_corrections.corrected_at_ms =
        NEW.resolved_at_ms
  ) <> 1 THEN RAISE(
    ABORT,
    'restricted cancellation recovery requires exact correction evidence'
  ) END;
END;

CREATE TRIGGER fad_restricted_removal_events_insert
BEFORE INSERT ON auction_events
WHEN NEW.event_type = 'commissioner_bid_removed'
  AND EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
  )
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_draft_auction_participants
    JOIN auctions
      ON auctions.league_id =
          free_agent_draft_auction_participants.league_id
     AND auctions.id =
          free_agent_draft_auction_participants.auction_id
    JOIN auction_contexts
      ON auction_contexts.league_id =
          free_agent_draft_auction_participants.league_id
     AND auction_contexts.season_id =
          free_agent_draft_auction_participants.season_id
     AND auction_contexts.fad_id =
          free_agent_draft_auction_participants.fad_id
     AND auction_contexts.fad_allocation_id =
          free_agent_draft_auction_participants.allocation_id
     AND auction_contexts.auction_id =
          free_agent_draft_auction_participants.auction_id
     AND auction_contexts.source_kind = 'fad_restricted'
    JOIN free_agent_draft_player_allocations
      ON free_agent_draft_player_allocations.league_id =
          auction_contexts.league_id
     AND free_agent_draft_player_allocations.season_id =
          auction_contexts.season_id
     AND free_agent_draft_player_allocations.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_player_allocations.id =
          auction_contexts.fad_allocation_id
    WHERE free_agent_draft_auction_participants.league_id =
        NEW.league_id
      AND free_agent_draft_auction_participants.season_id =
        NEW.season_id
      AND free_agent_draft_auction_participants.auction_id =
        NEW.auction_id
      AND free_agent_draft_auction_participants.seeded_bid_id =
        NEW.bid_id
      AND free_agent_draft_auction_participants.team_id = NEW.team_id
      AND free_agent_draft_auction_participants.status = 'active'
      AND NEW.actor_user_id IS NOT NULL
      AND auctions.status = 'open'
      AND free_agent_draft_player_allocations.status =
        'restricted_active'
      AND free_agent_draft_player_allocations.restricted_auction_id =
        NEW.auction_id
      AND NEW.occurred_at_ms >= auctions.opened_at_ms
      AND NEW.occurred_at_ms < auctions.resolves_at_ms
      AND EXISTS (
        SELECT 1
        FROM league_memberships
        WHERE league_memberships.league_id = NEW.league_id
          AND league_memberships.user_id = NEW.actor_user_id
          AND league_memberships.status = 'active'
          AND (
            EXISTS (
              SELECT 1
              FROM leagues
              WHERE leagues.id = NEW.league_id
                AND leagues.commissioner_membership_id =
                  league_memberships.id
            )
            OR EXISTS (
              SELECT 1
              FROM platform_roles
              WHERE platform_roles.user_id = NEW.actor_user_id
                AND platform_roles.role = 'platform_administrator'
                AND platform_roles.status = 'active'
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'restricted bid removal event requires an active participant'
  ) END;
END;

CREATE TRIGGER fad_rollovers_auction_accounting_barrier
BEFORE UPDATE OF status ON free_agent_draft_rollovers
WHEN OLD.status = 'processing'
  AND NEW.status IN ('completed', 'recovery_required')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    LEFT JOIN auction_resolutions
      ON auction_resolutions.league_id =
          auction_contexts.league_id
     AND auction_resolutions.season_id =
          auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    LEFT JOIN free_agent_draft_player_allocations AS allocation
      ON allocation.league_id = auction_contexts.league_id
     AND allocation.season_id = auction_contexts.season_id
     AND allocation.fad_id = auction_contexts.fad_id
     AND allocation.id = auction_contexts.fad_allocation_id
    LEFT JOIN free_agent_draft_draws
      ON free_agent_draft_draws.league_id =
          auction_contexts.league_id
     AND free_agent_draft_draws.season_id =
          auction_contexts.season_id
     AND free_agent_draft_draws.fad_id = auction_contexts.fad_id
     AND free_agent_draft_draws.allocation_id =
          auction_contexts.fad_allocation_id
     AND free_agent_draft_draws.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.fad_rollover_id = NEW.id
      AND (
        auctions.status IN ('open', 'resolving')
        OR (
          auctions.status <> 'failed'
          AND auction_resolutions.id IS NULL
        )
        OR (
          auction_resolutions.id IS NOT NULL
          AND auction_resolutions.resolved_at_ms >
            NEW.completed_at_ms
        )
        OR (
          auction_contexts.source_kind = 'fad_restricted'
          AND auctions.status <> 'failed'
          AND (
            free_agent_draft_draws.id IS NULL
            OR free_agent_draft_draws.revealed_at_ms IS NULL
            OR free_agent_draft_draws.revealed_at_ms >
              NEW.completed_at_ms
          )
        )
        OR (
          auctions.status = 'resolved'
          AND NOT (
            auction_resolutions.status = 'resolved'
            AND auction_resolutions.outcome_code = 'winner'
            AND (
              auction_contexts.source_kind = 'fad_open_rapid'
              OR (
                allocation.status = 'restricted_resolved'
                AND allocation.decision_code =
                  'restricted_auction_result'
                AND allocation.winning_team_id =
                  auction_resolutions.winning_team_id
                AND allocation.contract_id =
                  auction_resolutions.contract_id
                AND allocation.ownership_id =
                  auction_resolutions.ownership_id
              )
            )
          )
        )
        OR (
          auctions.status = 'no_winner'
          AND NOT (
            auction_resolutions.status IN ('no_bids', 'no_winner')
            AND auction_resolutions.outcome_code = 'no_winner'
            AND (
              auction_contexts.source_kind = 'fad_open_rapid'
              OR (
                allocation.status = 'restricted_resolved'
                AND allocation.decision_code =
                  'restricted_auction_no_winner'
              )
            )
          )
        )
        OR (
          auctions.status = 'cancelled'
          AND NOT (
            (
              auction_contexts.source_kind = 'fad_open_rapid'
              AND auction_resolutions.status = 'cancelled'
              AND (
                auction_resolutions.outcome_code IN (
                  'player_unavailable',
                  'season_closed'
                )
                OR (
                  auction_resolutions.outcome_code = 'recovered'
                  AND (
                    SELECT COUNT(*)
                    FROM free_agent_draft_recoveries
                    WHERE free_agent_draft_recoveries.league_id =
                        auction_contexts.league_id
                      AND free_agent_draft_recoveries.season_id =
                        auction_contexts.season_id
                      AND free_agent_draft_recoveries.fad_id =
                        auction_contexts.fad_id
                      AND free_agent_draft_recoveries.player_id =
                        auctions.player_id
                      AND free_agent_draft_recoveries
                        .allocation_id IS NULL
                      AND free_agent_draft_recoveries.rollover_id =
                        auction_contexts.fad_rollover_id
                      AND free_agent_draft_recoveries.auction_id =
                        auction_contexts.auction_id
                      AND free_agent_draft_recoveries.kind =
                        'auction_resolution'
                      AND free_agent_draft_recoveries.status =
                        'resolved'
                      AND free_agent_draft_recoveries.job_run_id
                        IS NOT NULL
                      AND free_agent_draft_recoveries.resolved_at_ms <=
                        NEW.completed_at_ms
                  ) = 1
                )
              )
            )
            OR (
              auction_contexts.source_kind = 'fad_restricted'
              AND auction_resolutions.status = 'cancelled'
              AND auction_resolutions.outcome_code = 'failed'
              AND allocation.status IN (
                'correction_required',
                'restricted_resolved'
              )
              AND (
                (
                  allocation.status = 'correction_required'
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_recoveries
                    WHERE free_agent_draft_recoveries.league_id =
                        auction_contexts.league_id
                      AND free_agent_draft_recoveries.season_id =
                        auction_contexts.season_id
                      AND free_agent_draft_recoveries.fad_id =
                        auction_contexts.fad_id
                      AND free_agent_draft_recoveries.player_id =
                        auctions.player_id
                      AND free_agent_draft_recoveries.allocation_id =
                        auction_contexts.fad_allocation_id
                      AND free_agent_draft_recoveries.rollover_id =
                        auction_contexts.fad_rollover_id
                      AND free_agent_draft_recoveries.auction_id =
                        auction_contexts.auction_id
                      AND free_agent_draft_recoveries.kind =
                        'auction_resolution'
                      AND free_agent_draft_recoveries.status IN (
                        'pending',
                        'ready',
                        'running',
                        'correction_required'
                      )
                  )
                )
                OR (
                  allocation.status = 'restricted_resolved'
                  AND allocation.decision_code = 'corrected'
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_recoveries
                    WHERE free_agent_draft_recoveries.league_id =
                        auction_contexts.league_id
                      AND free_agent_draft_recoveries.season_id =
                        auction_contexts.season_id
                      AND free_agent_draft_recoveries.fad_id =
                        auction_contexts.fad_id
                      AND free_agent_draft_recoveries.player_id =
                        auctions.player_id
                      AND free_agent_draft_recoveries.allocation_id =
                        auction_contexts.fad_allocation_id
                      AND free_agent_draft_recoveries.rollover_id =
                        auction_contexts.fad_rollover_id
                      AND free_agent_draft_recoveries.auction_id =
                        auction_contexts.auction_id
                      AND free_agent_draft_recoveries.kind =
                        'auction_resolution'
                      AND free_agent_draft_recoveries.status =
                        'resolved'
                      AND free_agent_draft_recoveries.resolved_at_ms <=
                        NEW.completed_at_ms
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM free_agent_draft_allocation_events
                    WHERE free_agent_draft_allocation_events.league_id =
                        allocation.league_id
                      AND free_agent_draft_allocation_events
                        .allocation_id = allocation.id
                      AND free_agent_draft_allocation_events.event_kind =
                        'correction_applied'
                      AND free_agent_draft_allocation_events
                        .decision_code = 'corrected'
                      AND free_agent_draft_allocation_events
                        .resulting_allocation_status =
                          'restricted_resolved'
                      AND free_agent_draft_allocation_events
                        .occurred_at_ms <= NEW.completed_at_ms
                  )
                )
              )
              AND (
                SELECT COUNT(*)
                FROM free_agent_draft_recoveries
                WHERE free_agent_draft_recoveries.league_id =
                    auction_contexts.league_id
                  AND free_agent_draft_recoveries.season_id =
                    auction_contexts.season_id
                  AND free_agent_draft_recoveries.fad_id =
                    auction_contexts.fad_id
                  AND free_agent_draft_recoveries.player_id =
                    auctions.player_id
                  AND free_agent_draft_recoveries.allocation_id =
                    auction_contexts.fad_allocation_id
                  AND free_agent_draft_recoveries.rollover_id =
                    auction_contexts.fad_rollover_id
                  AND free_agent_draft_recoveries.auction_id =
                    auction_contexts.auction_id
                  AND free_agent_draft_recoveries.kind =
                    'auction_resolution'
                  AND free_agent_draft_recoveries.job_run_id IS NOT NULL
              ) = 1
            )
          )
        )
        OR (
          auctions.status = 'failed'
          AND NOT (
            auction_resolutions.id IS NULL
            AND (
              SELECT COUNT(*)
              FROM free_agent_draft_recoveries
              JOIN job_runs
                ON job_runs.league_id =
                    free_agent_draft_recoveries.league_id
               AND job_runs.id =
                    free_agent_draft_recoveries.job_run_id
              JOIN auction_events
                ON auction_events.league_id =
                    free_agent_draft_recoveries.league_id
               AND auction_events.season_id =
                    free_agent_draft_recoveries.season_id
               AND auction_events.auction_id =
                    free_agent_draft_recoveries.auction_id
               AND auction_events.event_type =
                    'fad_auction_resolution_failed'
              WHERE free_agent_draft_recoveries.league_id =
                  auction_contexts.league_id
                AND free_agent_draft_recoveries.season_id =
                  auction_contexts.season_id
                AND free_agent_draft_recoveries.fad_id =
                  auction_contexts.fad_id
                AND free_agent_draft_recoveries.player_id =
                  auctions.player_id
                AND free_agent_draft_recoveries.allocation_id IS
                  auction_contexts.fad_allocation_id
                AND free_agent_draft_recoveries.rollover_id =
                  auction_contexts.fad_rollover_id
                AND free_agent_draft_recoveries.auction_id =
                  auction_contexts.auction_id
                AND free_agent_draft_recoveries.kind =
                  'auction_resolution'
                AND free_agent_draft_recoveries.status IN (
                  'pending',
                  'ready',
                  'running',
                  'correction_required'
                )
                AND free_agent_draft_recoveries.created_at_ms =
                  auctions.updated_at_ms
                AND free_agent_draft_recoveries.updated_at_ms <=
                  NEW.completed_at_ms
                AND job_runs.season_id = auctions.season_id
                AND job_runs.job_type = 'auction.resolve.target'
                AND job_runs.occurrence_key =
                  'auction:' || auctions.id || ':' ||
                    auctions.resolves_at_ms
                AND job_runs.scheduled_for_ms =
                  auctions.resolves_at_ms
                AND job_runs.attempt_count >= 1
                AND (
                  (
                    job_runs.status = 'failed'
                    AND job_runs.completed_at_ms >=
                      free_agent_draft_recoveries.created_at_ms
                    AND job_runs.completed_at_ms <=
                      NEW.completed_at_ms
                    AND job_runs.updated_at_ms =
                      job_runs.completed_at_ms
                    AND job_runs.last_error_code IS NOT NULL
                    AND job_runs.lease_owner IS NULL
                    AND job_runs.lease_expires_at_ms IS NULL
                    AND job_runs.lease_token IS NULL
                    AND job_runs.next_attempt_at_ms =
                      job_runs.completed_at_ms
                  )
                  OR (
                    job_runs.status IN ('leased', 'running')
                    AND job_runs.lease_owner IS NOT NULL
                    AND job_runs.lease_token IS NOT NULL
                    AND job_runs.lease_expires_at_ms >
                      NEW.completed_at_ms
                  )
                )
                AND auction_events.bid_id IS NULL
                AND auction_events.team_id IS NULL
                AND auction_events.actor_user_id IS NULL
                AND auction_events.occurred_at_ms =
                  auctions.updated_at_ms
                AND json_extract(
                  auction_events.metadata_json,
                  '$.recoveryId'
                ) = free_agent_draft_recoveries.id
                AND json_extract(
                  auction_events.metadata_json,
                  '$.jobRunId'
                ) = free_agent_draft_recoveries.job_run_id
                AND json_extract(
                  auction_events.metadata_json,
                  '$.errorCode'
                ) = free_agent_draft_recoveries.last_error_code
            ) = 1
            AND (
              auction_contexts.source_kind = 'fad_open_rapid'
              OR (
                allocation.status = 'correction_required'
                AND free_agent_draft_draws.id IS NOT NULL
                AND free_agent_draft_draws.revealed_at_ms IS NULL
                AND free_agent_draft_draws.version = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_auction_participants
                    AS failed_participant
                  JOIN auction_bids
                    ON auction_bids.league_id =
                        failed_participant.league_id
                   AND auction_bids.auction_id =
                        failed_participant.auction_id
                   AND auction_bids.id =
                        failed_participant.seeded_bid_id
                   AND auction_bids.team_id =
                        failed_participant.team_id
                  WHERE failed_participant.league_id =
                      auction_contexts.league_id
                    AND failed_participant.allocation_id =
                      auction_contexts.fad_allocation_id
                    AND failed_participant.auction_id =
                      auction_contexts.auction_id
                    AND (
                      (
                        failed_participant.status = 'active'
                        AND auction_bids.status <> 'active'
                      )
                      OR (
                        failed_participant.status = 'removed'
                        AND auction_bids.status <> 'withdrawn'
                      )
                    )
                )
              )
            )
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD rollover has an unaccounted auction'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'completed'
    AND (
      EXISTS (
        SELECT 1
        FROM auction_contexts
        JOIN auctions
          ON auctions.league_id = auction_contexts.league_id
         AND auctions.id = auction_contexts.auction_id
        LEFT JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = auction_contexts.league_id
         AND allocation.id = auction_contexts.fad_allocation_id
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.fad_rollover_id = NEW.id
          AND (
            auctions.status = 'failed'
            OR allocation.status = 'correction_required'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            NEW.league_id
          AND free_agent_draft_recoveries.fad_id = NEW.fad_id
          AND free_agent_draft_recoveries.rollover_id = NEW.id
          AND free_agent_draft_recoveries.status <> 'resolved'
      )
    )
  THEN RAISE(
    ABORT,
    'FAD rollover with unresolved recovery cannot complete normally'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'recovery_required'
    AND NOT (
      EXISTS (
        SELECT 1
        FROM auction_contexts
        JOIN auctions
          ON auctions.league_id = auction_contexts.league_id
         AND auctions.id = auction_contexts.auction_id
        LEFT JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = auction_contexts.league_id
         AND allocation.id = auction_contexts.fad_allocation_id
        WHERE auction_contexts.league_id = NEW.league_id
          AND auction_contexts.fad_rollover_id = NEW.id
          AND (
            auctions.status = 'failed'
            OR allocation.status = 'correction_required'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM free_agent_draft_recoveries
        WHERE free_agent_draft_recoveries.league_id =
            NEW.league_id
          AND free_agent_draft_recoveries.fad_id = NEW.fad_id
          AND free_agent_draft_recoveries.rollover_id = NEW.id
          AND free_agent_draft_recoveries.status IN (
            'pending',
            'ready',
            'running',
            'correction_required'
          )
      )
    )
  THEN RAISE(
    ABORT,
    'FAD rollover recovery state requires a direct unresolved cause'
  ) END;
END;

CREATE TRIGGER fad_rollovers_resolution_job_barrier
BEFORE UPDATE OF status ON free_agent_draft_rollovers
WHEN NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN auction_resolutions
      ON auction_resolutions.league_id = auction_contexts.league_id
     AND auction_resolutions.season_id = auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.fad_rollover_id = NEW.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND auctions.status IN ('resolved', 'no_winner', 'cancelled')
      AND NOT (
        auction_contexts.source_kind = 'fad_restricted'
        AND auctions.status = 'cancelled'
        AND auction_resolutions.status = 'cancelled'
        AND auction_resolutions.outcome_code = 'failed'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id = auction_contexts.league_id
          AND job_runs.season_id = auction_contexts.season_id
          AND job_runs.job_type = 'auction.resolve.target'
          AND job_runs.occurrence_key =
            auction_resolutions.scheduled_occurrence_key
          AND job_runs.occurrence_key =
            'auction:' || auctions.id || ':' ||
              auctions.resolves_at_ms
          AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
          AND job_runs.status = 'succeeded'
          AND job_runs.attempt_count >= 1
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.started_at_ms IS NOT NULL
          AND job_runs.started_at_ms <= job_runs.completed_at_ms
          AND job_runs.completed_at_ms >=
            auction_resolutions.resolved_at_ms
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.result_json IS NOT NULL
          AND job_runs.last_error_code IS NULL
          AND job_runs.next_attempt_at_ms IS NULL
          AND job_runs.updated_at_ms = job_runs.completed_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD rollover requires each resolved auction job to succeed'
  ) END;
END;

CREATE TRIGGER free_agent_draft_draws_valid_insert
BEFORE INSERT ON free_agent_draft_draws
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.revealed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'restricted draw must begin private at version one'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN free_agent_draft_player_allocations
      ON free_agent_draft_player_allocations.league_id =
          auction_contexts.league_id
     AND free_agent_draft_player_allocations.season_id =
          auction_contexts.season_id
     AND free_agent_draft_player_allocations.fad_id =
          auction_contexts.fad_id
     AND free_agent_draft_player_allocations.id =
          auction_contexts.fad_allocation_id
     AND free_agent_draft_player_allocations.player_id =
          auctions.player_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.fad_allocation_id = NEW.allocation_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND auctions.status = 'open'
      AND auctions.opened_at_ms = NEW.created_at_ms
      AND free_agent_draft_player_allocations
        .restricted_auction_id IS NULL
      AND (
        (
          free_agent_draft_player_allocations.status = 'pending'
          AND free_agent_draft_player_allocations.decision_code IS NULL
        )
        OR (
          free_agent_draft_player_allocations.status IN (
            'restricted_scheduled',
            'deferred_restricted_recovery',
            'correction_required'
          )
          AND free_agent_draft_player_allocations.decision_code =
            'exact_total_and_term_tie'
        )
      )
  ) THEN RAISE(
    ABORT,
    'restricted draw requires its staged restricted auction'
  ) END;
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

CREATE TRIGGER free_agent_drafts_auction_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    LEFT JOIN auction_resolutions
      ON auction_resolutions.league_id =
          auction_contexts.league_id
     AND auction_resolutions.season_id =
          auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    LEFT JOIN free_agent_draft_draws
      ON free_agent_draft_draws.league_id =
          auction_contexts.league_id
     AND free_agent_draft_draws.season_id =
          auction_contexts.season_id
     AND free_agent_draft_draws.fad_id = auction_contexts.fad_id
     AND free_agent_draft_draws.allocation_id =
          auction_contexts.fad_allocation_id
     AND free_agent_draft_draws.auction_id =
          auction_contexts.auction_id
    LEFT JOIN free_agent_draft_rollovers
      ON free_agent_draft_rollovers.league_id =
          auction_contexts.league_id
     AND free_agent_draft_rollovers.season_id =
          auction_contexts.season_id
     AND free_agent_draft_rollovers.fad_id = auction_contexts.fad_id
     AND free_agent_draft_rollovers.id =
          auction_contexts.fad_rollover_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.id
      AND (
        auction_contexts.fad_rollover_id IS NULL
        OR free_agent_draft_rollovers.status NOT IN (
          'completed',
          'recovery_required'
        )
        OR auctions.status IN ('open', 'resolving')
        OR (
          auctions.status <> 'failed'
          AND auction_resolutions.id IS NULL
        )
        OR (
          auction_resolutions.id IS NOT NULL
          AND auction_resolutions.resolved_at_ms >
            NEW.completed_at_ms
        )
        OR (
          auction_contexts.source_kind = 'fad_restricted'
          AND auctions.status <> 'failed'
          AND (
            free_agent_draft_draws.id IS NULL
            OR free_agent_draft_draws.revealed_at_ms IS NULL
            OR free_agent_draft_draws.revealed_at_ms >
              NEW.completed_at_ms
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires every FAD auction to be accounted'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.fad_id = NEW.id
      AND (
        (
          auctions.status = 'failed'
          AND NOT (
            NOT EXISTS (
              SELECT 1
              FROM auction_resolutions
              WHERE auction_resolutions.league_id =
                  auction_contexts.league_id
                AND auction_resolutions.auction_id =
                  auction_contexts.auction_id
            )
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_rollovers
              WHERE free_agent_draft_rollovers.league_id =
                  auction_contexts.league_id
                AND free_agent_draft_rollovers.id =
                  auction_contexts.fad_rollover_id
                AND free_agent_draft_rollovers.status =
                  'recovery_required'
            )
            AND (
              SELECT COUNT(*)
              FROM free_agent_draft_recoveries
              JOIN job_runs
                ON job_runs.league_id =
                    free_agent_draft_recoveries.league_id
               AND job_runs.id =
                    free_agent_draft_recoveries.job_run_id
              JOIN auction_events
                ON auction_events.league_id =
                    free_agent_draft_recoveries.league_id
               AND auction_events.auction_id =
                    free_agent_draft_recoveries.auction_id
               AND auction_events.event_type =
                    'fad_auction_resolution_failed'
              WHERE free_agent_draft_recoveries.league_id =
                  auction_contexts.league_id
                AND free_agent_draft_recoveries.season_id =
                  auction_contexts.season_id
                AND free_agent_draft_recoveries.fad_id =
                  auction_contexts.fad_id
                AND free_agent_draft_recoveries.player_id =
                  auctions.player_id
                AND free_agent_draft_recoveries.allocation_id IS
                  auction_contexts.fad_allocation_id
                AND free_agent_draft_recoveries.rollover_id IS
                  auction_contexts.fad_rollover_id
                AND free_agent_draft_recoveries.auction_id =
                  auction_contexts.auction_id
                AND free_agent_draft_recoveries.kind =
                  'auction_resolution'
                AND free_agent_draft_recoveries.status IN (
                  'pending',
                  'ready',
                  'running',
                  'correction_required'
                )
                AND free_agent_draft_recoveries.created_at_ms =
                  auctions.updated_at_ms
                AND free_agent_draft_recoveries.updated_at_ms <=
                  NEW.completed_at_ms
                AND job_runs.job_type = 'auction.resolve.target'
                AND job_runs.occurrence_key =
                  'auction:' || auctions.id || ':' ||
                    auctions.resolves_at_ms
                AND job_runs.scheduled_for_ms =
                  auctions.resolves_at_ms
                AND job_runs.attempt_count >= 1
                AND (
                  (
                    job_runs.status = 'failed'
                    AND job_runs.completed_at_ms >=
                      free_agent_draft_recoveries.created_at_ms
                    AND job_runs.completed_at_ms <=
                      NEW.completed_at_ms
                    AND job_runs.updated_at_ms =
                      job_runs.completed_at_ms
                    AND job_runs.last_error_code IS NOT NULL
                    AND job_runs.lease_owner IS NULL
                    AND job_runs.lease_expires_at_ms IS NULL
                    AND job_runs.lease_token IS NULL
                    AND job_runs.next_attempt_at_ms =
                      job_runs.completed_at_ms
                  )
                  OR (
                    job_runs.status IN ('leased', 'running')
                    AND job_runs.lease_owner IS NOT NULL
                    AND job_runs.lease_token IS NOT NULL
                    AND job_runs.lease_expires_at_ms >
                      NEW.completed_at_ms
                  )
                )
                AND auction_events.actor_user_id IS NULL
                AND auction_events.bid_id IS NULL
                AND auction_events.team_id IS NULL
                AND auction_events.occurred_at_ms =
                  auctions.updated_at_ms
                AND json_extract(
                  auction_events.metadata_json,
                  '$.recoveryId'
                ) = free_agent_draft_recoveries.id
                AND json_extract(
                  auction_events.metadata_json,
                  '$.jobRunId'
                ) = free_agent_draft_recoveries.job_run_id
                AND json_extract(
                  auction_events.metadata_json,
                  '$.errorCode'
                ) = free_agent_draft_recoveries.last_error_code
            ) = 1
            AND (
              auction_contexts.source_kind = 'fad_open_rapid'
              OR (
                EXISTS (
                  SELECT 1
                  FROM free_agent_draft_player_allocations
                  JOIN free_agent_draft_draws
                    ON free_agent_draft_draws.league_id =
                        free_agent_draft_player_allocations.league_id
                   AND free_agent_draft_draws.allocation_id =
                        free_agent_draft_player_allocations.id
                   AND free_agent_draft_draws.auction_id =
                        auction_contexts.auction_id
                  WHERE free_agent_draft_player_allocations.league_id =
                      auction_contexts.league_id
                    AND free_agent_draft_player_allocations.id =
                      auction_contexts.fad_allocation_id
                    AND free_agent_draft_player_allocations.status =
                      'correction_required'
                    AND free_agent_draft_draws.revealed_at_ms IS NULL
                    AND free_agent_draft_draws.version = 1
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_auction_participants
                    AS completion_participant
                  JOIN auction_bids
                    ON auction_bids.league_id =
                        completion_participant.league_id
                   AND auction_bids.auction_id =
                        completion_participant.auction_id
                   AND auction_bids.id =
                        completion_participant.seeded_bid_id
                   AND auction_bids.team_id =
                        completion_participant.team_id
                  WHERE completion_participant.league_id =
                      auction_contexts.league_id
                    AND completion_participant.allocation_id =
                      auction_contexts.fad_allocation_id
                    AND completion_participant.auction_id =
                      auction_contexts.auction_id
                    AND (
                      (
                        completion_participant.status = 'active'
                        AND auction_bids.status <> 'active'
                      )
                      OR (
                        completion_participant.status = 'removed'
                        AND auction_bids.status <> 'withdrawn'
                      )
                    )
                )
              )
            )
          )
        )
        OR (
          auction_contexts.source_kind = 'fad_restricted'
          AND auctions.status = 'cancelled'
          AND NOT EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries
            WHERE free_agent_draft_recoveries.league_id =
                auction_contexts.league_id
              AND free_agent_draft_recoveries.fad_id =
                auction_contexts.fad_id
              AND free_agent_draft_recoveries.player_id =
                auctions.player_id
              AND free_agent_draft_recoveries.allocation_id =
                auction_contexts.fad_allocation_id
              AND free_agent_draft_recoveries.rollover_id IS
                auction_contexts.fad_rollover_id
              AND free_agent_draft_recoveries.auction_id =
                auction_contexts.auction_id
              AND free_agent_draft_recoveries.kind =
                'auction_resolution'
              AND free_agent_draft_recoveries.job_run_id IS NOT NULL
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires durable recovery for abnormal auctions'
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

CREATE TRIGGER free_agent_drafts_resolution_job_completion_barrier
BEFORE UPDATE OF status ON free_agent_drafts
WHEN OLD.status = 'rapid'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN auction_resolutions
      ON auction_resolutions.league_id = auction_contexts.league_id
     AND auction_resolutions.season_id = auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND auctions.status IN ('resolved', 'no_winner', 'cancelled')
      AND NOT (
        auction_contexts.source_kind = 'fad_restricted'
        AND auctions.status = 'cancelled'
        AND auction_resolutions.status = 'cancelled'
        AND auction_resolutions.outcome_code = 'failed'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM job_runs
        WHERE job_runs.league_id = auction_contexts.league_id
          AND job_runs.season_id = auction_contexts.season_id
          AND job_runs.job_type = 'auction.resolve.target'
          AND job_runs.occurrence_key =
            auction_resolutions.scheduled_occurrence_key
          AND job_runs.occurrence_key =
            'auction:' || auctions.id || ':' ||
              auctions.resolves_at_ms
          AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
          AND job_runs.status = 'succeeded'
          AND job_runs.attempt_count >= 1
          AND job_runs.lease_owner IS NULL
          AND job_runs.lease_expires_at_ms IS NULL
          AND job_runs.lease_token IS NULL
          AND job_runs.started_at_ms IS NOT NULL
          AND job_runs.started_at_ms <= job_runs.completed_at_ms
          AND job_runs.completed_at_ms >=
            auction_resolutions.resolved_at_ms
          AND job_runs.completed_at_ms <= NEW.completed_at_ms
          AND job_runs.result_json IS NOT NULL
          AND job_runs.last_error_code IS NULL
          AND job_runs.next_attempt_at_ms IS NULL
          AND job_runs.updated_at_ms = job_runs.completed_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD completion requires each resolved auction job to succeed'
  ) END;
END;

-- Recreate history-table triggers only after every rebuilt parent exists.

CREATE TRIGGER fad_allocation_events_context_insert
BEFORE INSERT ON free_agent_draft_allocation_events
WHEN NEW.auction_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.fad_allocation_id = NEW.allocation_id
  ) THEN RAISE(
    ABORT,
    'FAD allocation event auction requires restricted context'
  ) END;
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

CREATE TRIGGER free_agent_draft_allocation_events_immutable_delete
BEFORE DELETE ON free_agent_draft_allocation_events
BEGIN
  SELECT RAISE(ABORT, 'FAD allocation event is immutable');
END;

CREATE TRIGGER free_agent_draft_allocation_events_immutable_update
BEFORE UPDATE ON free_agent_draft_allocation_events
BEGIN
  SELECT RAISE(ABORT, 'FAD allocation event is immutable');
END;

CREATE TRIGGER fad_allocations_restricted_activation_barrier
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN NEW.status = 'restricted_active'
  AND OLD.status <> 'restricted_active'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.fad_allocation_id = NEW.id
      AND auction_contexts.auction_id = NEW.restricted_auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND auctions.player_id = NEW.player_id
      AND auctions.status = 'open'
      AND auctions.opened_at_ms = NEW.updated_at_ms
      AND auctions.resolves_at_ms > NEW.updated_at_ms + 3600000
  ) THEN RAISE(
    ABORT,
    'restricted activation requires its exact fair-window context'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_auction_participants
    WHERE free_agent_draft_auction_participants.league_id =
        NEW.league_id
      AND free_agent_draft_auction_participants.season_id =
        NEW.season_id
      AND free_agent_draft_auction_participants.fad_id = NEW.fad_id
      AND free_agent_draft_auction_participants.allocation_id = NEW.id
      AND free_agent_draft_auction_participants.auction_id =
        NEW.restricted_auction_id
      AND free_agent_draft_auction_participants.status = 'active'
  ) < 2 THEN RAISE(
    ABORT,
    'restricted activation requires at least two active participants'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_auction_participants
    WHERE free_agent_draft_auction_participants.league_id =
        NEW.league_id
      AND free_agent_draft_auction_participants.season_id =
        NEW.season_id
      AND free_agent_draft_auction_participants.fad_id = NEW.fad_id
      AND free_agent_draft_auction_participants.allocation_id = NEW.id
      AND free_agent_draft_auction_participants.auction_id =
        NEW.restricted_auction_id
  ) <> (
    SELECT COUNT(*)
    FROM candidate_card_snapshot_entries AS exact_offer
    WHERE exact_offer.league_id = NEW.league_id
      AND exact_offer.season_id = NEW.season_id
      AND exact_offer.fad_id = NEW.fad_id
      AND exact_offer.player_id = NEW.player_id
      AND exact_offer.row_kind = 'slot'
      AND exact_offer.occupant_kind = 'candidate'
      AND exact_offer.eligibility_status IN ('valid', 'warning')
      AND NOT EXISTS (
        SELECT 1
        FROM candidate_card_snapshot_entries AS better_offer
        WHERE better_offer.league_id = exact_offer.league_id
          AND better_offer.season_id = exact_offer.season_id
          AND better_offer.fad_id = exact_offer.fad_id
          AND better_offer.player_id = exact_offer.player_id
          AND better_offer.row_kind = 'slot'
          AND better_offer.occupant_kind = 'candidate'
          AND better_offer.eligibility_status IN ('valid', 'warning')
          AND (
            better_offer.proposed_total_value_cents >
              exact_offer.proposed_total_value_cents
            OR (
              better_offer.proposed_total_value_cents =
                exact_offer.proposed_total_value_cents
              AND better_offer.proposed_aav_cents >
                exact_offer.proposed_aav_cents
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'restricted activation allowlist must equal the exact top Candidate tie'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM candidate_card_snapshot_entries AS exact_offer
    WHERE exact_offer.league_id = NEW.league_id
      AND exact_offer.season_id = NEW.season_id
      AND exact_offer.fad_id = NEW.fad_id
      AND exact_offer.player_id = NEW.player_id
      AND exact_offer.row_kind = 'slot'
      AND exact_offer.occupant_kind = 'candidate'
      AND exact_offer.eligibility_status IN ('valid', 'warning')
      AND NOT EXISTS (
        SELECT 1
        FROM candidate_card_snapshot_entries AS better_offer
        WHERE better_offer.league_id = exact_offer.league_id
          AND better_offer.season_id = exact_offer.season_id
          AND better_offer.fad_id = exact_offer.fad_id
          AND better_offer.player_id = exact_offer.player_id
          AND better_offer.row_kind = 'slot'
          AND better_offer.occupant_kind = 'candidate'
          AND better_offer.eligibility_status IN ('valid', 'warning')
          AND (
            better_offer.proposed_total_value_cents >
              exact_offer.proposed_total_value_cents
            OR (
              better_offer.proposed_total_value_cents =
                exact_offer.proposed_total_value_cents
              AND better_offer.proposed_aav_cents >
                exact_offer.proposed_aav_cents
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_auction_participants
        WHERE free_agent_draft_auction_participants.league_id =
            NEW.league_id
          AND free_agent_draft_auction_participants.allocation_id =
            NEW.id
          AND free_agent_draft_auction_participants.auction_id =
            NEW.restricted_auction_id
          AND free_agent_draft_auction_participants
            .source_snapshot_entry_id = exact_offer.id
      )
  ) THEN RAISE(
    ABORT,
    'restricted activation is missing an exact tied Candidate participant'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_auction_participants AS participant
    LEFT JOIN auction_bids
      ON auction_bids.league_id = participant.league_id
     AND auction_bids.season_id = participant.season_id
     AND auction_bids.auction_id = participant.auction_id
     AND auction_bids.id = participant.seeded_bid_id
     AND auction_bids.team_id = participant.team_id
     AND auction_bids.submitted_by_user_id =
          participant.originating_actor_user_id
     AND auction_bids.total_value_cents =
          participant.original_total_value_cents
     AND auction_bids.term_years = participant.original_term_years
     AND auction_bids.lowest_offered_aav_cents =
          participant.original_aav_cents
     AND auction_bids.first_submitted_at_ms =
          participant.created_at_ms
     AND auction_bids.last_edited_at_ms = participant.created_at_ms
     AND auction_bids.edit_count = 0
     AND auction_bids.status = 'active'
     AND auction_bids.version = 1
    LEFT JOIN auction_events
      ON auction_events.league_id = participant.league_id
     AND auction_events.season_id = participant.season_id
     AND auction_events.auction_id = participant.auction_id
     AND auction_events.id = participant.seed_event_id
     AND auction_events.bid_id = participant.seeded_bid_id
     AND auction_events.team_id = participant.team_id
     AND auction_events.actor_user_id IS NULL
     AND auction_events.event_type = 'fad_restricted_seed_created'
     AND auction_events.occurred_at_ms = participant.created_at_ms
    WHERE participant.league_id = NEW.league_id
      AND participant.season_id = NEW.season_id
      AND participant.fad_id = NEW.fad_id
      AND participant.allocation_id = NEW.id
      AND participant.auction_id = NEW.restricted_auction_id
      AND participant.status = 'active'
      AND (
        auction_bids.id IS NULL
        OR auction_events.id IS NULL
      )
  ) THEN RAISE(
    ABORT,
    'restricted activation requires every exact seed bid and event'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM free_agent_draft_draws
    WHERE free_agent_draft_draws.league_id = NEW.league_id
      AND free_agent_draft_draws.season_id = NEW.season_id
      AND free_agent_draft_draws.fad_id = NEW.fad_id
      AND free_agent_draft_draws.allocation_id = NEW.id
      AND free_agent_draft_draws.auction_id =
        NEW.restricted_auction_id
      AND free_agent_draft_draws.algorithm_version = 1
      AND free_agent_draft_draws.revealed_at_ms IS NULL
      AND free_agent_draft_draws.created_at_ms = NEW.updated_at_ms
      AND free_agent_draft_draws.updated_at_ms = NEW.updated_at_ms
      AND free_agent_draft_draws.version = 1
  ) <> 1 THEN RAISE(
    ABORT,
    'restricted activation requires one private committed draw'
  ) END;
END;

CREATE TRIGGER fad_allocations_restricted_correction_barrier
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status = 'restricted_active'
  AND NEW.status = 'correction_required'
BEGIN
  SELECT CASE WHEN NOT (
    EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN auctions
        ON auctions.league_id = auction_contexts.league_id
       AND auctions.id = auction_contexts.auction_id
      JOIN auction_resolutions
        ON auction_resolutions.league_id =
            auction_contexts.league_id
       AND auction_resolutions.auction_id =
            auction_contexts.auction_id
      JOIN free_agent_draft_draws
        ON free_agent_draft_draws.league_id =
            auction_contexts.league_id
       AND free_agent_draft_draws.auction_id =
            auction_contexts.auction_id
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.fad_id = NEW.fad_id
        AND auction_contexts.fad_allocation_id = NEW.id
        AND auction_contexts.auction_id =
          NEW.restricted_auction_id
        AND auction_contexts.source_kind = 'fad_restricted'
        AND auctions.status = 'cancelled'
        AND auction_resolutions.status = 'cancelled'
        AND auction_resolutions.outcome_code = 'failed'
        AND auction_resolutions.trigger_type = 'commissioner'
        AND auction_resolutions.triggered_by_user_id IS NOT NULL
        AND auction_resolutions.winning_team_id IS NULL
        AND auction_resolutions.winning_bid_id IS NULL
        AND auction_resolutions.highest_bid_cents IS NULL
        AND auction_resolutions.second_price_input_cents IS NULL
        AND auction_resolutions.final_contract_value_cents IS NULL
        AND auction_resolutions.winning_term_years IS NULL
        AND auction_resolutions.final_aav_cents IS NULL
        AND auction_resolutions.contract_id IS NULL
        AND auction_resolutions.ownership_id IS NULL
        AND free_agent_draft_draws.revealed_at_ms =
          auction_resolutions.resolved_at_ms
        AND free_agent_draft_draws
          .ordered_tied_bid_ids_json = '[]'
        AND NEW.resolved_at_ms =
          auction_resolutions.resolved_at_ms
    )
    OR EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN auctions
        ON auctions.league_id = auction_contexts.league_id
       AND auctions.season_id = auction_contexts.season_id
       AND auctions.id = auction_contexts.auction_id
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
      JOIN free_agent_draft_recoveries
        ON free_agent_draft_recoveries.league_id =
            auction_contexts.league_id
       AND free_agent_draft_recoveries.season_id =
            auction_contexts.season_id
       AND free_agent_draft_recoveries.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_recoveries.player_id =
            auctions.player_id
       AND free_agent_draft_recoveries.allocation_id =
            auction_contexts.fad_allocation_id
       AND free_agent_draft_recoveries.rollover_id IS
            auction_contexts.fad_rollover_id
       AND free_agent_draft_recoveries.auction_id =
            auction_contexts.auction_id
       AND free_agent_draft_recoveries.kind =
            'auction_resolution'
      JOIN job_runs
        ON job_runs.league_id =
            free_agent_draft_recoveries.league_id
       AND job_runs.id =
            free_agent_draft_recoveries.job_run_id
      JOIN auction_events
        ON auction_events.league_id = auction_contexts.league_id
       AND auction_events.season_id = auction_contexts.season_id
       AND auction_events.auction_id =
            auction_contexts.auction_id
       AND auction_events.event_type =
            'fad_auction_resolution_failed'
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.fad_id = NEW.fad_id
        AND auction_contexts.fad_allocation_id = NEW.id
        AND auction_contexts.auction_id =
          NEW.restricted_auction_id
        AND auction_contexts.source_kind = 'fad_restricted'
        AND auctions.status = 'failed'
        AND auctions.updated_at_ms = NEW.resolved_at_ms
        AND free_agent_draft_draws.revealed_at_ms IS NULL
        AND free_agent_draft_draws.version = 1
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
        AND job_runs.job_type = 'auction.resolve.target'
        AND job_runs.occurrence_key =
          'auction:' || auctions.id || ':' ||
            auctions.resolves_at_ms
        AND job_runs.scheduled_for_ms = auctions.resolves_at_ms
        AND job_runs.status = 'failed'
        AND job_runs.completed_at_ms = NEW.resolved_at_ms
        AND job_runs.updated_at_ms = NEW.resolved_at_ms
        AND job_runs.last_error_code = NEW.last_error_code
        AND auction_events.bid_id IS NULL
        AND auction_events.team_id IS NULL
        AND auction_events.actor_user_id IS NULL
        AND auction_events.occurred_at_ms = NEW.resolved_at_ms
        AND json_extract(
          auction_events.metadata_json,
          '$.recoveryId'
        ) = free_agent_draft_recoveries.id
        AND json_extract(
          auction_events.metadata_json,
          '$.jobRunId'
        ) = free_agent_draft_recoveries.job_run_id
        AND json_extract(
          auction_events.metadata_json,
          '$.errorCode'
        ) = free_agent_draft_recoveries.last_error_code
        AND NOT EXISTS (
          SELECT 1
          FROM auction_resolutions
          WHERE auction_resolutions.league_id = NEW.league_id
            AND auction_resolutions.auction_id =
              NEW.restricted_auction_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_auction_participants AS participant
          JOIN auction_bids
            ON auction_bids.league_id = participant.league_id
           AND auction_bids.auction_id = participant.auction_id
           AND auction_bids.id = participant.seeded_bid_id
           AND auction_bids.team_id = participant.team_id
          WHERE participant.league_id = NEW.league_id
            AND participant.allocation_id = NEW.id
            AND participant.auction_id =
              NEW.restricted_auction_id
            AND (
              (
                participant.status = 'active'
                AND auction_bids.status <> 'active'
              )
              OR (
                participant.status = 'removed'
                AND auction_bids.status <> 'withdrawn'
              )
            )
        )
    )
  ) THEN RAISE(
    ABORT,
    'restricted correction requires exact cancelled or failed evidence'
  ) END;
END;

CREATE TRIGGER fad_allocations_restricted_resolution_barrier
BEFORE UPDATE OF status ON free_agent_draft_player_allocations
WHEN OLD.status IN ('restricted_active', 'correction_required')
  AND NEW.status = 'restricted_resolved'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    JOIN auctions
      ON auctions.league_id = auction_contexts.league_id
     AND auctions.season_id = auction_contexts.season_id
     AND auctions.id = auction_contexts.auction_id
    JOIN auction_resolutions
      ON auction_resolutions.league_id =
          auction_contexts.league_id
     AND auction_resolutions.season_id =
          auction_contexts.season_id
     AND auction_resolutions.auction_id =
          auction_contexts.auction_id
    JOIN free_agent_draft_draws
      ON free_agent_draft_draws.league_id =
          auction_contexts.league_id
     AND free_agent_draft_draws.season_id =
          auction_contexts.season_id
     AND free_agent_draft_draws.fad_id = auction_contexts.fad_id
     AND free_agent_draft_draws.allocation_id =
          auction_contexts.fad_allocation_id
     AND free_agent_draft_draws.auction_id =
          auction_contexts.auction_id
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.fad_allocation_id = NEW.id
      AND auction_contexts.auction_id = NEW.restricted_auction_id
      AND auction_contexts.source_kind = 'fad_restricted'
      AND (
        (
          NEW.decision_code = 'restricted_auction_result'
          AND auction_resolutions.resolved_at_ms =
            NEW.resolved_at_ms
          AND free_agent_draft_draws.revealed_at_ms =
            NEW.resolved_at_ms
          AND auctions.status = 'resolved'
          AND auction_resolutions.status = 'resolved'
          AND auction_resolutions.outcome_code = 'winner'
          AND auction_resolutions.winning_team_id =
            NEW.winning_team_id
          AND auction_resolutions.contract_id = NEW.contract_id
          AND auction_resolutions.ownership_id = NEW.ownership_id
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_auction_participants
            WHERE free_agent_draft_auction_participants.league_id =
                NEW.league_id
              AND free_agent_draft_auction_participants.fad_id =
                NEW.fad_id
              AND free_agent_draft_auction_participants
                .allocation_id = NEW.id
              AND free_agent_draft_auction_participants
                .auction_id = NEW.restricted_auction_id
              AND free_agent_draft_auction_participants.team_id =
                NEW.winning_team_id
              AND free_agent_draft_auction_participants
                .source_snapshot_entry_id =
                  NEW.winning_snapshot_entry_id
              AND free_agent_draft_auction_participants
                .seeded_bid_id =
                  auction_resolutions.winning_bid_id
              AND free_agent_draft_auction_participants.status =
                'active'
          )
        )
        OR (
          NEW.decision_code = 'restricted_auction_no_winner'
          AND auction_resolutions.resolved_at_ms =
            NEW.resolved_at_ms
          AND free_agent_draft_draws.revealed_at_ms =
            NEW.resolved_at_ms
          AND auctions.status = 'no_winner'
          AND auction_resolutions.status IN (
            'no_bids',
            'no_winner'
          )
          AND auction_resolutions.outcome_code = 'no_winner'
          AND NEW.winning_snapshot_entry_id IS NULL
          AND NEW.winning_team_id IS NULL
          AND NEW.contract_id IS NULL
          AND NEW.ownership_id IS NULL
        )
        OR (
          OLD.status = 'correction_required'
          AND NEW.decision_code = 'corrected'
          AND auctions.status = 'cancelled'
          AND auction_resolutions.status = 'cancelled'
          AND auction_resolutions.outcome_code = 'failed'
          AND auction_resolutions.resolved_at_ms <=
            NEW.resolved_at_ms
          AND free_agent_draft_draws.revealed_at_ms =
            auction_resolutions.resolved_at_ms
          AND free_agent_draft_draws
            .ordered_tied_bid_ids_json = '[]'
          AND (
            SELECT COUNT(*)
            FROM commissioner_corrections
            JOIN league_memberships
              ON league_memberships.league_id =
                  commissioner_corrections.league_id
             AND league_memberships.user_id =
                  commissioner_corrections.actor_user_id
             AND league_memberships.status = 'active'
            WHERE commissioner_corrections.league_id =
                NEW.league_id
              AND commissioner_corrections.season_id =
                NEW.season_id
              AND commissioner_corrections.feature =
                'free_agent_draft_allocation'
              AND commissioner_corrections.feature_record_id =
                NEW.id
              AND commissioner_corrections.corrected_at_ms =
                NEW.resolved_at_ms
              AND (
                EXISTS (
                  SELECT 1
                  FROM leagues
                  WHERE leagues.id = NEW.league_id
                    AND leagues.commissioner_membership_id =
                      league_memberships.id
                )
                OR EXISTS (
                  SELECT 1
                  FROM platform_roles
                  WHERE platform_roles.user_id =
                      commissioner_corrections.actor_user_id
                    AND platform_roles.role =
                      'platform_administrator'
                    AND platform_roles.status = 'active'
                )
              )
          ) = 1
        )
      )
  ) THEN RAISE(
    ABORT,
    'restricted allocation resolution must match auction and draw evidence'
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

CREATE TRIGGER free_agent_draft_allocations_immutable_delete
BEFORE DELETE ON free_agent_draft_player_allocations
BEGIN
  SELECT RAISE(ABORT, 'FAD allocation evidence cannot be deleted');
END;

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
ALTER TABLE season_rollovers
ADD COLUMN idempotency_request_id TEXT
  REFERENCES idempotency_requests(id) ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN from_season_label TEXT;

ALTER TABLE season_rollovers
ADD COLUMN from_nhl_season_key TEXT;

ALTER TABLE season_rollovers
ADD COLUMN to_season_label TEXT;

ALTER TABLE season_rollovers
ADD COLUMN target_nhl_season_key TEXT;

ALTER TABLE season_rollovers
ADD COLUMN nhl_regular_season_starts_at_ms INTEGER;

ALTER TABLE season_rollovers
ADD COLUMN nhl_regular_season_ends_at_ms INTEGER;

ALTER TABLE season_rollovers
ADD COLUMN fantasy_playoffs_start_at_ms INTEGER;

ALTER TABLE season_rollovers
ADD COLUMN fantasy_playoffs_end_at_ms INTEGER;

ALTER TABLE season_rollovers
ADD COLUMN source_fad_id TEXT
  REFERENCES free_agent_drafts(id) ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN source_finalization_root_id TEXT
  REFERENCES standings_snapshot_finalizations(id)
  ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN source_finalization_id TEXT
  REFERENCES standings_snapshot_finalizations(id)
  ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN source_standings_snapshot_id TEXT
  REFERENCES standings_snapshots(id) ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN source_standings_operation_id TEXT
  REFERENCES standings_operations(id) ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN source_readiness_json TEXT
  CHECK (
    source_readiness_json IS NULL
    OR (
      json_valid(source_readiness_json) = 1
      AND json_type(source_readiness_json) = 'object'
      AND json(source_readiness_json) = source_readiness_json
    )
  );

ALTER TABLE season_rollovers
ADD COLUMN source_readiness_schema_version INTEGER
  CHECK (
    source_readiness_schema_version IS NULL
    OR source_readiness_schema_version = 1
  );

ALTER TABLE season_rollovers
ADD COLUMN source_readiness_sha256 TEXT
  CHECK (
    source_readiness_sha256 IS NULL
    OR (
      length(source_readiness_sha256) = 64
      AND source_readiness_sha256 =
        lower(source_readiness_sha256)
      AND source_readiness_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE season_rollovers
ADD COLUMN aggregate_activity_id TEXT
  REFERENCES league_activity(id) ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN security_audit_event_id TEXT
  REFERENCES security_audit_events(id) ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN outbox_event_id TEXT
  REFERENCES outbox_events(id) ON DELETE RESTRICT;

ALTER TABLE season_rollovers
ADD COLUMN manifest_schema_version INTEGER
  CHECK (
    manifest_schema_version IS NULL
    OR manifest_schema_version = 1
  );

ALTER TABLE season_rollovers
ADD COLUMN manifest_sha256 TEXT
  CHECK (
    manifest_sha256 IS NULL
    OR (
      length(manifest_sha256) = 64
      AND manifest_sha256 = lower(manifest_sha256)
      AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE UNIQUE INDEX season_rollovers_idempotency_request
  ON season_rollovers (idempotency_request_id)
  WHERE idempotency_request_id IS NOT NULL;

CREATE UNIQUE INDEX idempotency_requests_lifecycle_client_key
  ON idempotency_requests (
    league_id,
    operation,
    client_key
  )
  WHERE league_id IS NOT NULL
    AND operation = 'league.lifecycle.transition.v1';

CREATE UNIQUE INDEX season_rollovers_aggregate_activity
  ON season_rollovers (aggregate_activity_id)
  WHERE aggregate_activity_id IS NOT NULL;

CREATE UNIQUE INDEX season_rollovers_security_audit
  ON season_rollovers (security_audit_event_id)
  WHERE security_audit_event_id IS NOT NULL;

CREATE UNIQUE INDEX season_rollovers_outbox
  ON season_rollovers (outbox_event_id)
  WHERE outbox_event_id IS NOT NULL;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN idempotency_request_id TEXT
  REFERENCES idempotency_requests(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN migration_report_sha256 TEXT
  CHECK (
    migration_report_sha256 IS NULL
    OR (
      length(migration_report_sha256) = 64
      AND migration_report_sha256 = lower(migration_report_sha256)
      AND migration_report_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN bootstrap_identity_sha256 TEXT
  CHECK (
    bootstrap_identity_sha256 IS NULL
    OR (
      length(bootstrap_identity_sha256) = 64
      AND bootstrap_identity_sha256 = lower(bootstrap_identity_sha256)
      AND bootstrap_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN bootstrap_idempotency_request_id TEXT
  REFERENCES idempotency_requests(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN bootstrap_activity_id TEXT
  REFERENCES league_activity(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN bootstrap_security_audit_event_id TEXT
  REFERENCES security_audit_events(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN bootstrap_actor_user_id TEXT
  REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN authorization_activity_id TEXT
  REFERENCES league_activity(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN authorization_security_audit_event_id TEXT
  REFERENCES security_audit_events(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN commissioner_notification_id TEXT
  REFERENCES notifications(id) ON DELETE RESTRICT;

ALTER TABLE free_agent_draft_setup_exemptions
ADD COLUMN outbox_event_id TEXT
  REFERENCES outbox_events(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX fad_setup_exemptions_idempotency_request
  ON free_agent_draft_setup_exemptions (idempotency_request_id)
  WHERE idempotency_request_id IS NOT NULL;

CREATE UNIQUE INDEX fad_setup_exemptions_authorization_activity
  ON free_agent_draft_setup_exemptions (authorization_activity_id)
  WHERE authorization_activity_id IS NOT NULL;

CREATE UNIQUE INDEX fad_setup_exemptions_authorization_audit
  ON free_agent_draft_setup_exemptions (
    authorization_security_audit_event_id
  )
  WHERE authorization_security_audit_event_id IS NOT NULL;

CREATE UNIQUE INDEX fad_setup_exemptions_commissioner_notification
  ON free_agent_draft_setup_exemptions (commissioner_notification_id)
  WHERE commissioner_notification_id IS NOT NULL;

CREATE UNIQUE INDEX fad_setup_exemptions_outbox
  ON free_agent_draft_setup_exemptions (outbox_event_id)
  WHERE outbox_event_id IS NOT NULL;

CREATE TABLE season_rollover_items (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  rollover_id TEXT NOT NULL,
  idempotency_request_id TEXT NOT NULL,
  from_season_id TEXT NOT NULL,
  to_season_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL
    CHECK (
      effect_kind IN (
        'contract_advanced',
        'contract_expired',
        'ownership_carried',
        'ownership_released',
        'retention_year_advanced',
        'retention_obligation_completed',
        'buyout_year_advanced',
        'buyout_obligation_completed',
        'trade_cancelled'
      )
    ),
  entity_type TEXT NOT NULL
    CHECK (
      entity_type IN (
        'contract',
        'player_ownership',
        'retention_obligation',
        'buyout_obligation',
        'trade'
      )
    ),
  entity_id TEXT NOT NULL
    CHECK (length(entity_id) = 36 AND entity_id = lower(entity_id)),
  before_json TEXT NOT NULL
    CHECK (
      json_valid(before_json) = 1
      AND json_type(before_json) = 'object'
      AND json(before_json) = before_json
    ),
  after_json TEXT NOT NULL
    CHECK (
      json_valid(after_json) = 1
      AND json_type(after_json) = 'object'
      AND json(after_json) = after_json
    ),
  payload_sha256 TEXT NOT NULL
    CHECK (
      length(payload_sha256) = 64
      AND payload_sha256 = lower(payload_sha256)
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_event_id TEXT,
  ownership_event_id TEXT,
  trade_event_id TEXT,
  league_activity_id TEXT,
  causal_assets_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(causal_assets_json) = 1
      AND json_type(causal_assets_json) = 'array'
      AND json(causal_assets_json) = causal_assets_json
    ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, rollover_id, effect_kind, entity_id),
  FOREIGN KEY (league_id, rollover_id)
    REFERENCES season_rollovers(league_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, from_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, to_season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, contract_event_id)
    REFERENCES contract_events(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, ownership_event_id)
    REFERENCES ownership_events(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, trade_event_id)
    REFERENCES trade_events(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, league_activity_id)
    REFERENCES league_activity(league_id, id) ON DELETE RESTRICT,
  CHECK (from_season_id <> to_season_id),
  CHECK (
    (
      effect_kind IN ('contract_advanced', 'contract_expired')
      AND entity_type = 'contract'
      AND contract_event_id IS NOT NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NULL
      AND (
        (
          effect_kind = 'contract_advanced'
          AND league_activity_id IS NULL
        )
        OR (
          effect_kind = 'contract_expired'
          AND league_activity_id IS NOT NULL
        )
      )
      AND causal_assets_json = '[]'
    )
    OR (
      effect_kind IN ('ownership_carried', 'ownership_released')
      AND entity_type = 'player_ownership'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NOT NULL
      AND trade_event_id IS NULL
      AND league_activity_id IS NULL
      AND causal_assets_json = '[]'
    )
    OR (
      effect_kind IN (
        'retention_year_advanced',
        'retention_obligation_completed'
      )
      AND entity_type = 'retention_obligation'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NULL
      AND league_activity_id IS NULL
      AND causal_assets_json = '[]'
    )
    OR (
      effect_kind IN (
        'buyout_year_advanced',
        'buyout_obligation_completed'
      )
      AND entity_type = 'buyout_obligation'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NULL
      AND league_activity_id IS NULL
      AND causal_assets_json = '[]'
    )
    OR (
      effect_kind = 'trade_cancelled'
      AND entity_type = 'trade'
      AND contract_event_id IS NULL
      AND ownership_event_id IS NULL
      AND trade_event_id IS NOT NULL
      AND league_activity_id IS NOT NULL
      AND json_array_length(causal_assets_json) >= 1
    )
  )
) STRICT;

CREATE INDEX season_rollover_items_rollover_order
  ON season_rollover_items (
    league_id,
    rollover_id,
    effect_kind,
    entity_id
  );

CREATE INDEX season_rollover_items_idempotency
  ON season_rollover_items (
    league_id,
    idempotency_request_id,
    rollover_id
  );

CREATE TRIGGER season_rollover_items_shape_insert
BEFORE INSERT ON season_rollover_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM idempotency_requests
    WHERE idempotency_requests.league_id = NEW.league_id
      AND idempotency_requests.id = NEW.idempotency_request_id
      AND idempotency_requests.operation =
        'league.lifecycle.transition.v1'
      AND idempotency_requests.status = 'started'
      AND idempotency_requests.result_type IS NULL
      AND idempotency_requests.result_id IS NULL
      AND idempotency_requests.completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'rollover item requires its started lifecycle request'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_setup_exemptions
    WHERE free_agent_draft_setup_exemptions.idempotency_request_id =
      NEW.idempotency_request_id
  ) THEN RAISE(
    ABORT,
    'lifecycle request cannot own both resource types'
  ) END;

  SELECT CASE WHEN NEW.effect_kind IN (
    'contract_advanced',
    'contract_expired'
  ) AND (
    (SELECT COUNT(*) FROM json_each(NEW.before_json)) <> 16
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.before_json)
      WHERE key NOT IN (
        'id',
        'playerId',
        'currentTeamId',
        'contractType',
        'originalTotalValueCents',
        'originalTermYears',
        'aavCents',
        'startSeasonId',
        'status',
        'acquisitionSourceType',
        'acquisitionSourceId',
        'auctionBuyoutLockExpiresAtMs',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'years'
      )
    )
    OR (SELECT COUNT(*) FROM json_each(NEW.after_json)) <> 16
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.after_json)
      WHERE key NOT IN (
        'id',
        'playerId',
        'currentTeamId',
        'contractType',
        'originalTotalValueCents',
        'originalTermYears',
        'aavCents',
        'startSeasonId',
        'status',
        'acquisitionSourceType',
        'acquisitionSourceId',
        'auctionBuyoutLockExpiresAtMs',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'years'
      )
    )
  ) THEN RAISE(
    ABORT,
    'contract rollover item projection is not exact'
  ) END;

  SELECT CASE WHEN NEW.effect_kind IN (
    'ownership_carried',
    'ownership_released'
  ) AND (
    (SELECT COUNT(*) FROM json_each(NEW.before_json)) <> 16
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.before_json)
      WHERE key NOT IN (
        'exists',
        'id',
        'seasonId',
        'playerId',
        'teamId',
        'ownershipKind',
        'rosterCategory',
        'positionGroup',
        'slotNumber',
        'acquiredTransactionType',
        'acquiredTransactionId',
        'tradeBlocked',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'displayOrderEntries'
      )
    )
    OR (SELECT COUNT(*) FROM json_each(NEW.after_json)) <> 16
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.after_json)
      WHERE key NOT IN (
        'exists',
        'id',
        'seasonId',
        'playerId',
        'teamId',
        'ownershipKind',
        'rosterCategory',
        'positionGroup',
        'slotNumber',
        'acquiredTransactionType',
        'acquiredTransactionId',
        'tradeBlocked',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'displayOrderEntries'
      )
    )
  ) THEN RAISE(
    ABORT,
    'ownership rollover item projection is not exact'
  ) END;

  SELECT CASE WHEN NEW.effect_kind IN (
    'retention_year_advanced',
    'retention_obligation_completed'
  ) AND (
    (SELECT COUNT(*) FROM json_each(NEW.before_json)) <> 12
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.before_json)
      WHERE key NOT IN (
        'id',
        'contractId',
        'playerId',
        'originatingTeamId',
        'responsibleTeamId',
        'retainedAavCents',
        'creationTradeId',
        'status',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'years'
      )
    )
    OR (SELECT COUNT(*) FROM json_each(NEW.after_json)) <> 12
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.after_json)
      WHERE key NOT IN (
        'id',
        'contractId',
        'playerId',
        'originatingTeamId',
        'responsibleTeamId',
        'retainedAavCents',
        'creationTradeId',
        'status',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'years'
      )
    )
  ) THEN RAISE(
    ABORT,
    'retention rollover item projection is not exact'
  ) END;

  SELECT CASE WHEN NEW.effect_kind IN (
    'buyout_year_advanced',
    'buyout_obligation_completed'
  ) AND (
    (SELECT COUNT(*) FROM json_each(NEW.before_json)) <> 12
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.before_json)
      WHERE key NOT IN (
        'id',
        'contractId',
        'playerId',
        'originatingTeamId',
        'responsibleTeamId',
        'annualPenaltyBasisCents',
        'buyoutTransactionId',
        'status',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'years'
      )
    )
    OR (SELECT COUNT(*) FROM json_each(NEW.after_json)) <> 12
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.after_json)
      WHERE key NOT IN (
        'id',
        'contractId',
        'playerId',
        'originatingTeamId',
        'responsibleTeamId',
        'annualPenaltyBasisCents',
        'buyoutTransactionId',
        'status',
        'createdAtMs',
        'updatedAtMs',
        'version',
        'years'
      )
    )
  ) THEN RAISE(
    ABORT,
    'buyout rollover item projection is not exact'
  ) END;

  SELECT CASE WHEN NEW.effect_kind = 'trade_cancelled' AND (
    (SELECT COUNT(*) FROM json_each(NEW.before_json)) <> 18
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.before_json)
      WHERE key NOT IN (
        'id',
        'seasonId',
        'proposingTeamId',
        'receivingTeamId',
        'proposingUserId',
        'creatingMembershipId',
        'creatingAuthority',
        'status',
        'createdAtMs',
        'expiresAtMs',
        'effectiveDeadlineAtMs',
        'respondedAtMs',
        'completedAtMs',
        'commissionerCompletionReference',
        'proposalModelVersion',
        'updatedAtMs',
        'version',
        'assets'
      )
    )
    OR (SELECT COUNT(*) FROM json_each(NEW.after_json)) <> 18
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.after_json)
      WHERE key NOT IN (
        'id',
        'seasonId',
        'proposingTeamId',
        'receivingTeamId',
        'proposingUserId',
        'creatingMembershipId',
        'creatingAuthority',
        'status',
        'createdAtMs',
        'expiresAtMs',
        'effectiveDeadlineAtMs',
        'respondedAtMs',
        'completedAtMs',
        'commissionerCompletionReference',
        'proposalModelVersion',
        'updatedAtMs',
        'version',
        'assets'
      )
    )
  ) THEN RAISE(
    ABORT,
    'trade rollover item projection is not exact'
  ) END;

  SELECT CASE WHEN
    json_extract(NEW.before_json, '$.id') IS NOT NEW.entity_id
    OR json_extract(NEW.after_json, '$.id') IS NOT NEW.entity_id
  THEN RAISE(
    ABORT,
    'rollover item entity identity is inconsistent'
  ) END;
END;

CREATE TRIGGER season_rollover_items_contract_insert
BEFORE INSERT ON season_rollover_items
WHEN NEW.effect_kind IN ('contract_advanced', 'contract_expired')
BEGIN
  SELECT CASE WHEN NOT (
    json_extract(NEW.before_json, '$.status') = 'active'
    AND json_extract(NEW.before_json, '$.version') >= 1
    AND json_extract(NEW.after_json, '$.version') =
      json_extract(NEW.before_json, '$.version') + 1
    AND json_extract(NEW.after_json, '$.updatedAtMs') =
      NEW.occurred_at_ms
    AND json_extract(NEW.before_json, '$.playerId') IS
      json_extract(NEW.after_json, '$.playerId')
    AND json_extract(NEW.before_json, '$.currentTeamId') IS
      json_extract(NEW.after_json, '$.currentTeamId')
    AND json_extract(NEW.before_json, '$.contractType') IS
      json_extract(NEW.after_json, '$.contractType')
    AND json_extract(NEW.before_json, '$.originalTotalValueCents') IS
      json_extract(NEW.after_json, '$.originalTotalValueCents')
    AND json_extract(NEW.before_json, '$.originalTermYears') IS
      json_extract(NEW.after_json, '$.originalTermYears')
    AND json_extract(NEW.before_json, '$.aavCents') IS
      json_extract(NEW.after_json, '$.aavCents')
    AND json_extract(NEW.before_json, '$.startSeasonId') IS
      json_extract(NEW.after_json, '$.startSeasonId')
    AND json_extract(NEW.before_json, '$.acquisitionSourceType') IS
      json_extract(NEW.after_json, '$.acquisitionSourceType')
    AND json_extract(NEW.before_json, '$.acquisitionSourceId') IS
      json_extract(NEW.after_json, '$.acquisitionSourceId')
    AND json_extract(
      NEW.before_json,
      '$.auctionBuyoutLockExpiresAtMs'
    ) IS json_extract(
      NEW.after_json,
      '$.auctionBuyoutLockExpiresAtMs'
    )
    AND json_extract(NEW.before_json, '$.createdAtMs') IS
      json_extract(NEW.after_json, '$.createdAtMs')
    AND json_type(NEW.before_json, '$.years') = 'array'
    AND json_type(NEW.after_json, '$.years') = 'array'
    AND json_array_length(
      json_extract(NEW.before_json, '$.years')
    ) = json_extract(NEW.before_json, '$.originalTermYears')
    AND json_array_length(
      json_extract(NEW.after_json, '$.years')
    ) = json_extract(NEW.after_json, '$.originalTermYears')
    AND json_array_length(
      json_extract(NEW.before_json, '$.years')
    ) = json_array_length(
      json_extract(NEW.after_json, '$.years')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS year
      WHERE json_type(year.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(year.value)) <> 7
        OR EXISTS (
          SELECT 1
          FROM json_each(year.value) AS field
          WHERE field.key NOT IN (
            'id',
            'seasonId',
            'yearNumber',
            'aavCents',
            'status',
            'rolloverAtMs',
            'createdAtMs'
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS year
      WHERE json_type(year.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(year.value)) <> 7
        OR EXISTS (
          SELECT 1
          FROM json_each(year.value) AS field
          WHERE field.key NOT IN (
            'id',
            'seasonId',
            'yearNumber',
            'aavCents',
            'status',
            'rolloverAtMs',
            'createdAtMs'
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'contract rollover item transition is inconsistent'
  ) END;

  SELECT CASE WHEN
    NEW.effect_kind = 'contract_advanced'
    AND json_extract(NEW.after_json, '$.status') <> 'active'
  THEN RAISE(
    ABORT,
    'advanced contract requires its exact target year'
  ) END;

  SELECT CASE WHEN
    NEW.effect_kind = 'contract_expired'
    AND json_extract(NEW.after_json, '$.status') <> 'expired'
  THEN RAISE(
    ABORT,
    'expired contract requires its final source year'
  ) END;

  SELECT CASE WHEN
    (
      SELECT COUNT(*)
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      )
      WHERE json_extract(value, '$.seasonId') =
        NEW.from_season_id
        AND json_extract(value, '$.status') = 'current'
        AND json_type(value, '$.rolloverAtMs') = 'null'
    ) <> 1
    OR (
      SELECT COUNT(*)
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      )
      WHERE json_extract(value, '$.seasonId') =
        NEW.from_season_id
        AND json_extract(value, '$.status') = CASE NEW.effect_kind
          WHEN 'contract_advanced' THEN 'completed'
          WHEN 'contract_expired' THEN 'expired'
        END
        AND json_extract(value, '$.rolloverAtMs') =
          NEW.occurred_at_ms
    ) <> 1
    OR (
      NEW.effect_kind = 'contract_advanced'
      AND (
        (
          SELECT COUNT(*)
          FROM json_each(
            json_extract(NEW.before_json, '$.years')
          )
          WHERE json_extract(value, '$.seasonId') =
            NEW.to_season_id
            AND json_extract(value, '$.status') = 'future'
            AND json_type(value, '$.rolloverAtMs') = 'null'
        ) <> 1
        OR (
          SELECT COUNT(*)
          FROM json_each(
            json_extract(NEW.after_json, '$.years')
          )
          WHERE json_extract(value, '$.seasonId') =
            NEW.to_season_id
            AND json_extract(value, '$.status') = 'current'
            AND json_type(value, '$.rolloverAtMs') = 'null'
        ) <> 1
      )
    )
    OR (
      NEW.effect_kind = 'contract_expired'
      AND EXISTS (
        SELECT 1
        FROM json_each(
          json_extract(NEW.before_json, '$.years')
        )
        WHERE json_extract(value, '$.seasonId') =
          NEW.to_season_id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS before_year
      JOIN json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS after_year
        ON after_year.key = before_year.key
      WHERE json_extract(before_year.value, '$.id') IS NOT
          json_extract(after_year.value, '$.id')
        OR json_extract(
          before_year.value,
          '$.seasonId'
        ) IS NOT json_extract(after_year.value, '$.seasonId')
        OR json_extract(
          before_year.value,
          '$.yearNumber'
        ) IS NOT json_extract(after_year.value, '$.yearNumber')
        OR json_extract(
          before_year.value,
          '$.aavCents'
        ) IS NOT json_extract(after_year.value, '$.aavCents')
        OR json_extract(
          before_year.value,
          '$.createdAtMs'
        ) IS NOT json_extract(after_year.value, '$.createdAtMs')
        OR (
          json_extract(before_year.value, '$.seasonId')
            NOT IN (NEW.from_season_id, NEW.to_season_id)
          AND before_year.value <> after_year.value
        )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS year
      LEFT JOIN json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS prior
        ON prior.key = year.key - 1
      WHERE year.key > 0
        AND (
          json_extract(prior.value, '$.yearNumber') >
            json_extract(year.value, '$.yearNumber')
          OR (
            json_extract(prior.value, '$.yearNumber') =
              json_extract(year.value, '$.yearNumber')
            AND json_extract(prior.value, '$.id') >=
              json_extract(year.value, '$.id')
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS year
      WHERE NOT EXISTS (
        SELECT 1
        FROM contract_years
        WHERE contract_years.league_id = NEW.league_id
          AND contract_years.contract_id = NEW.entity_id
          AND contract_years.id =
            json_extract(year.value, '$.id')
          AND contract_years.season_id =
            json_extract(year.value, '$.seasonId')
          AND contract_years.year_number =
            json_extract(year.value, '$.yearNumber')
          AND contract_years.aav_cents =
            json_extract(year.value, '$.aavCents')
          AND contract_years.status =
            json_extract(year.value, '$.status')
          AND contract_years.rollover_at_ms IS
            json_extract(year.value, '$.rolloverAtMs')
          AND contract_years.created_at_ms =
            json_extract(year.value, '$.createdAtMs')
      )
    )
    OR (
      SELECT COUNT(*)
      FROM contract_years
      WHERE contract_years.league_id = NEW.league_id
        AND contract_years.contract_id = NEW.entity_id
    ) <> json_array_length(
      json_extract(NEW.after_json, '$.years')
    )
  THEN RAISE(
    ABORT,
    'contract rollover years are not an exact committed schedule'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM contracts
    WHERE contracts.league_id = NEW.league_id
      AND contracts.id = NEW.entity_id
      AND contracts.player_id =
        json_extract(NEW.after_json, '$.playerId')
      AND contracts.current_team_id =
        json_extract(NEW.after_json, '$.currentTeamId')
      AND contracts.contract_type =
        json_extract(NEW.after_json, '$.contractType')
      AND contracts.original_total_value_cents =
        json_extract(
          NEW.after_json,
          '$.originalTotalValueCents'
        )
      AND contracts.original_term_years =
        json_extract(NEW.after_json, '$.originalTermYears')
      AND contracts.aav_cents =
        json_extract(NEW.after_json, '$.aavCents')
      AND contracts.start_season_id =
        json_extract(NEW.after_json, '$.startSeasonId')
      AND contracts.status =
        json_extract(NEW.after_json, '$.status')
      AND contracts.acquisition_source_type =
        json_extract(
          NEW.after_json,
          '$.acquisitionSourceType'
        )
      AND contracts.acquisition_source_id IS
        json_extract(
          NEW.after_json,
          '$.acquisitionSourceId'
        )
      AND contracts.auction_buyout_lock_expires_at_ms IS
        json_extract(
          NEW.after_json,
          '$.auctionBuyoutLockExpiresAtMs'
        )
      AND contracts.created_at_ms =
        json_extract(NEW.after_json, '$.createdAtMs')
      AND contracts.updated_at_ms = NEW.occurred_at_ms
      AND contracts.version =
        json_extract(NEW.after_json, '$.version')
  ) THEN RAISE(
    ABORT,
    'contract rollover item must match the committed contract'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM contract_events
    WHERE contract_events.league_id = NEW.league_id
      AND contract_events.id = NEW.contract_event_id
      AND contract_events.contract_id = NEW.entity_id
      AND contract_events.player_id =
        json_extract(NEW.after_json, '$.playerId')
      AND contract_events.team_id =
        json_extract(NEW.after_json, '$.currentTeamId')
      AND contract_events.actor_user_id IS NULL
      AND contract_events.event_type = CASE NEW.effect_kind
        WHEN 'contract_advanced' THEN 'contract_year_advanced'
        WHEN 'contract_expired' THEN 'contract_expired'
      END
      AND contract_events.source_type = 'season_rollover'
      AND contract_events.source_id = NEW.rollover_id
      AND contract_events.occurred_at_ms = NEW.occurred_at_ms
      AND contract_events.reason = 'season_rollover'
      AND json_valid(contract_events.metadata_json) = 1
      AND json_type(contract_events.metadata_json) = 'object'
      AND json(contract_events.metadata_json) =
        contract_events.metadata_json
      AND (
        SELECT COUNT(*)
        FROM json_each(contract_events.metadata_json)
      ) = 7
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(contract_events.metadata_json)
        WHERE key NOT IN (
          'schemaVersion',
          'rolloverId',
          'rolloverItemId',
          'fromSeasonId',
          'toSeasonId',
          'before',
          'after'
        )
      )
      AND json_extract(
        contract_events.metadata_json,
        '$.schemaVersion'
      ) = 1
      AND json_extract(
        contract_events.metadata_json,
        '$.rolloverId'
      ) = NEW.rollover_id
      AND json_extract(
        contract_events.metadata_json,
        '$.rolloverItemId'
      ) = NEW.id
      AND json_extract(
        contract_events.metadata_json,
        '$.fromSeasonId'
      ) = NEW.from_season_id
      AND json_extract(
        contract_events.metadata_json,
        '$.toSeasonId'
      ) = NEW.to_season_id
      AND json_extract(
        contract_events.metadata_json,
        '$.before'
      ) = json(NEW.before_json)
      AND json_extract(
        contract_events.metadata_json,
        '$.after'
      ) = json(NEW.after_json)
  ) THEN RAISE(
    ABORT,
    'contract rollover event evidence is inconsistent'
  ) END;

  SELECT CASE WHEN
    NEW.effect_kind = 'contract_expired'
    AND NOT EXISTS (
      SELECT 1
      FROM league_activity
      WHERE league_activity.league_id = NEW.league_id
        AND league_activity.id = NEW.league_activity_id
        AND league_activity.season_id = NEW.from_season_id
        AND league_activity.event_type = 'contract_expired'
        AND league_activity.actor_user_id IS NULL
        AND league_activity.actor_authority = 'system'
        AND league_activity.team_id =
          json_extract(NEW.before_json, '$.currentTeamId')
        AND league_activity.player_id =
          json_extract(NEW.before_json, '$.playerId')
        AND league_activity.related_type = 'contract'
        AND league_activity.related_id = NEW.entity_id
        AND league_activity.display_summary =
          'Contract expired; player released.'
        AND league_activity.reason IS NULL
        AND league_activity.occurred_at_ms = NEW.occurred_at_ms
        AND json_valid(league_activity.metadata_json) = 1
        AND json_type(league_activity.metadata_json) = 'object'
        AND json(league_activity.metadata_json) =
          league_activity.metadata_json
        AND (
          SELECT COUNT(*)
          FROM json_each(league_activity.metadata_json)
        ) = 6
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(league_activity.metadata_json)
          WHERE key NOT IN (
            'rolloverId',
            'contractId',
            'ownershipId',
            'expiredAavCents',
            'originalTermYears',
            'rosterRemoval'
          )
        )
        AND json_extract(
          league_activity.metadata_json,
          '$.rolloverId'
        ) = NEW.rollover_id
        AND json_extract(
          league_activity.metadata_json,
          '$.contractId'
        ) = NEW.entity_id
        AND json_extract(
          league_activity.metadata_json,
          '$.expiredAavCents'
        ) = json_extract(NEW.before_json, '$.aavCents')
        AND json_extract(
          league_activity.metadata_json,
          '$.originalTermYears'
        ) = json_extract(
          NEW.before_json,
          '$.originalTermYears'
        )
        AND json_extract(
          league_activity.metadata_json,
          '$.rosterRemoval'
        ) = 'released'
        AND length(
          json_extract(
            league_activity.metadata_json,
            '$.ownershipId'
          )
        ) = 36
    )
  THEN RAISE(
    ABORT,
    'expired contract activity evidence is inconsistent'
  ) END;
END;

CREATE TRIGGER season_rollover_items_ownership_insert
BEFORE INSERT ON season_rollover_items
WHEN NEW.effect_kind IN ('ownership_carried', 'ownership_released')
BEGIN
  SELECT CASE WHEN NOT (
    json_type(NEW.before_json, '$.exists') = 'true'
    AND json_extract(NEW.before_json, '$.seasonId') =
      NEW.from_season_id
    AND json_extract(NEW.before_json, '$.version') >= 1
    AND json_extract(NEW.after_json, '$.updatedAtMs') =
      NEW.occurred_at_ms
    AND json_extract(NEW.before_json, '$.playerId') IS
      json_extract(NEW.after_json, '$.playerId')
    AND json_extract(NEW.before_json, '$.teamId') IS
      json_extract(NEW.after_json, '$.teamId')
    AND json_extract(NEW.before_json, '$.ownershipKind') IS
      json_extract(NEW.after_json, '$.ownershipKind')
    AND json_extract(NEW.before_json, '$.rosterCategory') IS
      json_extract(NEW.after_json, '$.rosterCategory')
    AND json_extract(NEW.before_json, '$.positionGroup') IS
      json_extract(NEW.after_json, '$.positionGroup')
    AND json_extract(NEW.before_json, '$.slotNumber') IS
      json_extract(NEW.after_json, '$.slotNumber')
    AND json_extract(
      NEW.before_json,
      '$.acquiredTransactionType'
    ) IS json_extract(
      NEW.after_json,
      '$.acquiredTransactionType'
    )
    AND json_extract(
      NEW.before_json,
      '$.acquiredTransactionId'
    ) IS json_extract(
      NEW.after_json,
      '$.acquiredTransactionId'
    )
    AND json_extract(NEW.before_json, '$.tradeBlocked') IS
      json_extract(NEW.after_json, '$.tradeBlocked')
    AND json_extract(NEW.before_json, '$.createdAtMs') IS
      json_extract(NEW.after_json, '$.createdAtMs')
    AND (
      (
        json_extract(NEW.before_json, '$.ownershipKind') =
          'Rostered'
        AND json_extract(NEW.before_json, '$.rosterCategory')
          IN ('Active', 'Bench', 'Injured Reserve')
      )
      OR (
        json_extract(NEW.before_json, '$.ownershipKind') =
          'Prospect Right'
        AND json_extract(NEW.before_json, '$.rosterCategory') =
          'Prospect'
      )
    )
  ) THEN RAISE(
    ABORT,
    'ownership rollover item transition is inconsistent'
  ) END;

  SELECT CASE WHEN NOT (
    json_type(
      NEW.before_json,
      '$.displayOrderEntries'
    ) = 'array'
    AND json_type(
      NEW.after_json,
      '$.displayOrderEntries'
    ) = 'array'
    AND json_array_length(
      json_extract(
        NEW.after_json,
        '$.displayOrderEntries'
      )
    ) = 0
  ) OR EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(
        NEW.before_json,
        '$.displayOrderEntries'
      )
    ) AS entry
    WHERE json_type(entry.value) <> 'object'
      OR (SELECT COUNT(*) FROM json_each(entry.value)) <> 7
      OR EXISTS (
        SELECT 1
        FROM json_each(entry.value) AS field
        WHERE field.key NOT IN (
          'id',
          'leagueId',
          'orderSetId',
          'ownershipId',
          'positionGroup',
          'displayOrder',
          'createdAtMs'
        )
      )
      OR json_extract(entry.value, '$.leagueId') <>
        NEW.league_id
      OR json_extract(entry.value, '$.ownershipId') <>
        NEW.entity_id
      OR json_extract(entry.value, '$.positionGroup') <>
        json_extract(NEW.before_json, '$.positionGroup')
  ) OR EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(
        NEW.before_json,
        '$.displayOrderEntries'
      )
    ) AS entry
    LEFT JOIN json_each(
      json_extract(
        NEW.before_json,
        '$.displayOrderEntries'
      )
    ) AS prior
      ON prior.key = entry.key - 1
    WHERE entry.key > 0
      AND (
        json_extract(prior.value, '$.orderSetId') >
          json_extract(entry.value, '$.orderSetId')
        OR (
          json_extract(prior.value, '$.orderSetId') =
            json_extract(entry.value, '$.orderSetId')
          AND json_extract(prior.value, '$.id') >=
            json_extract(entry.value, '$.id')
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM roster_display_order_entries
    WHERE roster_display_order_entries.league_id =
      NEW.league_id
      AND roster_display_order_entries.ownership_id =
        NEW.entity_id
  ) THEN RAISE(
    ABORT,
    'ownership display order cleanup is incomplete'
  ) END;

  SELECT CASE WHEN NEW.effect_kind = 'ownership_carried' AND NOT (
    json_type(NEW.after_json, '$.exists') = 'true'
    AND json_extract(NEW.after_json, '$.seasonId') =
      NEW.to_season_id
    AND json_extract(NEW.after_json, '$.version') =
      json_extract(NEW.before_json, '$.version') + 1
    AND EXISTS (
      SELECT 1
      FROM player_ownerships
      WHERE player_ownerships.league_id = NEW.league_id
        AND player_ownerships.id = NEW.entity_id
        AND player_ownerships.season_id = NEW.to_season_id
        AND player_ownerships.player_id =
          json_extract(NEW.after_json, '$.playerId')
        AND player_ownerships.team_id =
          json_extract(NEW.after_json, '$.teamId')
        AND player_ownerships.ownership_kind =
          json_extract(NEW.after_json, '$.ownershipKind')
        AND player_ownerships.roster_category =
          json_extract(NEW.after_json, '$.rosterCategory')
        AND player_ownerships.position_group =
          json_extract(NEW.after_json, '$.positionGroup')
        AND player_ownerships.slot_number IS
          json_extract(NEW.after_json, '$.slotNumber')
        AND player_ownerships.acquired_transaction_type =
          json_extract(
            NEW.after_json,
            '$.acquiredTransactionType'
          )
        AND player_ownerships.acquired_transaction_id IS
          json_extract(
            NEW.after_json,
            '$.acquiredTransactionId'
          )
        AND player_ownerships.trade_blocked =
          json_extract(NEW.after_json, '$.tradeBlocked')
        AND player_ownerships.created_at_ms =
          json_extract(NEW.after_json, '$.createdAtMs')
        AND player_ownerships.updated_at_ms =
          NEW.occurred_at_ms
        AND player_ownerships.version =
          json_extract(NEW.after_json, '$.version')
    )
  ) THEN RAISE(
    ABORT,
    'carried ownership must match the committed ownership'
  ) END;

  SELECT CASE WHEN NEW.effect_kind = 'ownership_released' AND NOT (
    json_type(NEW.after_json, '$.exists') = 'false'
    AND json_type(NEW.after_json, '$.seasonId') = 'null'
    AND json_type(NEW.after_json, '$.version') = 'null'
    AND EXISTS (
      SELECT 1
      FROM player_ownerships
      WHERE player_ownerships.league_id = NEW.league_id
        AND player_ownerships.id = NEW.entity_id
        AND player_ownerships.season_id = NEW.from_season_id
        AND player_ownerships.player_id =
          json_extract(NEW.before_json, '$.playerId')
        AND player_ownerships.team_id =
          json_extract(NEW.before_json, '$.teamId')
        AND player_ownerships.ownership_kind =
          json_extract(NEW.before_json, '$.ownershipKind')
        AND player_ownerships.roster_category =
          json_extract(NEW.before_json, '$.rosterCategory')
        AND player_ownerships.position_group =
          json_extract(NEW.before_json, '$.positionGroup')
        AND player_ownerships.slot_number IS
          json_extract(NEW.before_json, '$.slotNumber')
        AND player_ownerships.acquired_transaction_type =
          json_extract(
            NEW.before_json,
            '$.acquiredTransactionType'
          )
        AND player_ownerships.acquired_transaction_id IS
          json_extract(
            NEW.before_json,
            '$.acquiredTransactionId'
          )
        AND player_ownerships.trade_blocked =
          json_extract(NEW.before_json, '$.tradeBlocked')
        AND player_ownerships.created_at_ms =
          json_extract(NEW.before_json, '$.createdAtMs')
        AND player_ownerships.updated_at_ms =
          json_extract(NEW.before_json, '$.updatedAtMs')
        AND player_ownerships.version =
          json_extract(NEW.before_json, '$.version')
    )
  ) THEN RAISE(
    ABORT,
    'released ownership requires its exact live before-image'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM ownership_events
    WHERE ownership_events.league_id = NEW.league_id
      AND ownership_events.id = NEW.ownership_event_id
      AND ownership_events.season_id = CASE NEW.effect_kind
        WHEN 'ownership_carried' THEN NEW.to_season_id
        WHEN 'ownership_released' THEN NEW.from_season_id
      END
      AND ownership_events.player_id =
        json_extract(NEW.before_json, '$.playerId')
      AND ownership_events.team_id =
        json_extract(NEW.before_json, '$.teamId')
      AND ownership_events.ownership_id = NEW.entity_id
      AND ownership_events.event_type = CASE NEW.effect_kind
        WHEN 'ownership_carried' THEN
          'ownership_carried_to_season'
        WHEN 'ownership_released' THEN
          'player_released_by_contract_expiration'
      END
      AND ownership_events.actor_user_id IS NULL
      AND ownership_events.source_type = 'season_rollover'
      AND ownership_events.source_id = NEW.rollover_id
      AND ownership_events.reason = 'season_rollover'
      AND ownership_events.occurred_at_ms = NEW.occurred_at_ms
      AND ownership_events.before_metadata_json = NEW.before_json
      AND ownership_events.after_metadata_json = NEW.after_json
  ) THEN RAISE(
    ABORT,
    'ownership rollover event evidence is inconsistent'
  ) END;
END;

CREATE TRIGGER season_rollover_items_retention_insert
BEFORE INSERT ON season_rollover_items
WHEN NEW.effect_kind IN (
  'retention_year_advanced',
  'retention_obligation_completed'
)
BEGIN
  SELECT CASE WHEN NOT (
    json_extract(NEW.before_json, '$.status') = 'active'
    AND json_extract(NEW.before_json, '$.version') >= 1
    AND json_extract(NEW.after_json, '$.version') =
      json_extract(NEW.before_json, '$.version') + 1
    AND json_extract(NEW.after_json, '$.updatedAtMs') =
      NEW.occurred_at_ms
    AND json_extract(NEW.before_json, '$.contractId') IS
      json_extract(NEW.after_json, '$.contractId')
    AND json_extract(NEW.before_json, '$.playerId') IS
      json_extract(NEW.after_json, '$.playerId')
    AND json_extract(NEW.before_json, '$.originatingTeamId') IS
      json_extract(NEW.after_json, '$.originatingTeamId')
    AND json_extract(NEW.before_json, '$.responsibleTeamId') IS
      json_extract(NEW.after_json, '$.responsibleTeamId')
    AND json_extract(NEW.before_json, '$.retainedAavCents') IS
      json_extract(NEW.after_json, '$.retainedAavCents')
    AND json_extract(NEW.before_json, '$.creationTradeId') IS
      json_extract(NEW.after_json, '$.creationTradeId')
    AND json_extract(NEW.before_json, '$.createdAtMs') IS
      json_extract(NEW.after_json, '$.createdAtMs')
    AND json_type(NEW.before_json, '$.years') = 'array'
    AND json_type(NEW.after_json, '$.years') = 'array'
    AND json_array_length(
      json_extract(NEW.before_json, '$.years')
    ) = json_array_length(
      json_extract(NEW.after_json, '$.years')
    )
    AND json_array_length(
      json_extract(NEW.before_json, '$.years')
    ) >= 1
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS year
      WHERE json_type(year.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(year.value)) <> 5
        OR EXISTS (
          SELECT 1
          FROM json_each(year.value) AS field
          WHERE field.key NOT IN (
            'id',
            'seasonId',
            'amountCents',
            'status',
            'createdAtMs'
          )
        )
        OR json_extract(year.value, '$.amountCents') <>
          json_extract(NEW.before_json, '$.retainedAavCents')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS year
      WHERE json_type(year.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(year.value)) <> 5
        OR EXISTS (
          SELECT 1
          FROM json_each(year.value) AS field
          WHERE field.key NOT IN (
            'id',
            'seasonId',
            'amountCents',
            'status',
            'createdAtMs'
          )
        )
        OR json_extract(year.value, '$.amountCents') <>
          json_extract(NEW.after_json, '$.retainedAavCents')
    )
  ) THEN RAISE(
    ABORT,
    'retention rollover item transition is inconsistent'
  ) END;

  SELECT CASE WHEN
    NEW.effect_kind = 'retention_year_advanced'
    AND json_extract(NEW.after_json, '$.status') <> 'active'
  THEN RAISE(
    ABORT,
    'advanced retention requires its exact target year'
  ) END;

  SELECT CASE WHEN
    NEW.effect_kind = 'retention_obligation_completed'
    AND json_extract(NEW.after_json, '$.status') <> 'completed'
  THEN RAISE(
    ABORT,
    'completed retention requires its final source year'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM retention_obligations
    WHERE retention_obligations.league_id = NEW.league_id
      AND retention_obligations.id = NEW.entity_id
      AND retention_obligations.contract_id =
        json_extract(NEW.after_json, '$.contractId')
      AND retention_obligations.player_id =
        json_extract(NEW.after_json, '$.playerId')
      AND retention_obligations.originating_team_id =
        json_extract(NEW.after_json, '$.originatingTeamId')
      AND retention_obligations.responsible_team_id =
        json_extract(NEW.after_json, '$.responsibleTeamId')
      AND retention_obligations.retained_aav_cents =
        json_extract(NEW.after_json, '$.retainedAavCents')
      AND retention_obligations.creation_trade_id IS
        json_extract(NEW.after_json, '$.creationTradeId')
      AND retention_obligations.status =
        json_extract(NEW.after_json, '$.status')
      AND retention_obligations.created_at_ms =
        json_extract(NEW.after_json, '$.createdAtMs')
      AND retention_obligations.updated_at_ms =
        NEW.occurred_at_ms
      AND retention_obligations.version =
        json_extract(NEW.after_json, '$.version')
  ) THEN RAISE(
    ABORT,
    'retention item must match the committed obligation'
  ) END;

  SELECT CASE WHEN
    (
      SELECT COUNT(*)
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      )
      WHERE json_extract(value, '$.seasonId') =
        NEW.from_season_id
        AND json_extract(value, '$.status') = 'current'
    ) <> 1
    OR (
      SELECT COUNT(*)
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      )
      WHERE json_extract(value, '$.seasonId') =
        NEW.from_season_id
        AND json_extract(value, '$.status') = 'completed'
    ) <> 1
    OR (
      NEW.effect_kind = 'retention_year_advanced'
      AND (
        (
          SELECT COUNT(*)
          FROM json_each(
            json_extract(NEW.before_json, '$.years')
          )
          WHERE json_extract(value, '$.seasonId') =
            NEW.to_season_id
            AND json_extract(value, '$.status') = 'future'
        ) <> 1
        OR (
          SELECT COUNT(*)
          FROM json_each(
            json_extract(NEW.after_json, '$.years')
          )
          WHERE json_extract(value, '$.seasonId') =
            NEW.to_season_id
            AND json_extract(value, '$.status') = 'current'
        ) <> 1
      )
    )
    OR (
      NEW.effect_kind = 'retention_obligation_completed'
      AND EXISTS (
        SELECT 1
        FROM json_each(
          json_extract(NEW.before_json, '$.years')
        )
        WHERE json_extract(value, '$.seasonId') =
          NEW.to_season_id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS before_year
      JOIN json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS after_year
        ON after_year.key = before_year.key
      WHERE json_extract(before_year.value, '$.id') IS NOT
          json_extract(after_year.value, '$.id')
        OR json_extract(
          before_year.value,
          '$.seasonId'
        ) IS NOT json_extract(after_year.value, '$.seasonId')
        OR json_extract(
          before_year.value,
          '$.amountCents'
        ) IS NOT json_extract(after_year.value, '$.amountCents')
        OR json_extract(
          before_year.value,
          '$.createdAtMs'
        ) IS NOT json_extract(after_year.value, '$.createdAtMs')
        OR (
          json_extract(before_year.value, '$.seasonId')
            NOT IN (NEW.from_season_id, NEW.to_season_id)
          AND before_year.value <> after_year.value
        )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS year
      LEFT JOIN json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS prior
        ON prior.key = year.key - 1
      WHERE year.key > 0
        AND (
          json_extract(prior.value, '$.seasonId') >
            json_extract(year.value, '$.seasonId')
          OR (
            json_extract(prior.value, '$.seasonId') =
              json_extract(year.value, '$.seasonId')
            AND json_extract(prior.value, '$.id') >=
              json_extract(year.value, '$.id')
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS year
      WHERE NOT EXISTS (
        SELECT 1
        FROM retention_years
        WHERE retention_years.league_id = NEW.league_id
          AND retention_years.retention_obligation_id =
            NEW.entity_id
          AND retention_years.id =
            json_extract(year.value, '$.id')
          AND retention_years.season_id =
            json_extract(year.value, '$.seasonId')
          AND retention_years.retained_aav_cents =
            json_extract(year.value, '$.amountCents')
          AND retention_years.status =
            json_extract(year.value, '$.status')
          AND retention_years.created_at_ms =
            json_extract(year.value, '$.createdAtMs')
      )
    )
    OR (
      SELECT COUNT(*)
      FROM retention_years
      WHERE retention_years.league_id = NEW.league_id
        AND retention_years.retention_obligation_id =
          NEW.entity_id
    ) <> json_array_length(
      json_extract(NEW.after_json, '$.years')
    )
  THEN RAISE(
    ABORT,
    'retention item years are not an exact committed schedule'
  ) END;
END;

CREATE TRIGGER season_rollover_items_buyout_insert
BEFORE INSERT ON season_rollover_items
WHEN NEW.effect_kind IN (
  'buyout_year_advanced',
  'buyout_obligation_completed'
)
BEGIN
  SELECT CASE WHEN NOT (
    json_extract(NEW.before_json, '$.status') = 'active'
    AND json_extract(NEW.before_json, '$.version') >= 1
    AND json_extract(NEW.after_json, '$.version') =
      json_extract(NEW.before_json, '$.version') + 1
    AND json_extract(NEW.after_json, '$.updatedAtMs') =
      NEW.occurred_at_ms
    AND json_extract(NEW.before_json, '$.contractId') IS
      json_extract(NEW.after_json, '$.contractId')
    AND json_extract(NEW.before_json, '$.playerId') IS
      json_extract(NEW.after_json, '$.playerId')
    AND json_extract(NEW.before_json, '$.originatingTeamId') IS
      json_extract(NEW.after_json, '$.originatingTeamId')
    AND json_extract(NEW.before_json, '$.responsibleTeamId') IS
      json_extract(NEW.after_json, '$.responsibleTeamId')
    AND json_extract(
      NEW.before_json,
      '$.annualPenaltyBasisCents'
    ) IS json_extract(
      NEW.after_json,
      '$.annualPenaltyBasisCents'
    )
    AND json_extract(NEW.before_json, '$.buyoutTransactionId') IS
      json_extract(NEW.after_json, '$.buyoutTransactionId')
    AND json_extract(NEW.before_json, '$.createdAtMs') IS
      json_extract(NEW.after_json, '$.createdAtMs')
    AND json_type(NEW.before_json, '$.years') = 'array'
    AND json_type(NEW.after_json, '$.years') = 'array'
    AND json_array_length(
      json_extract(NEW.before_json, '$.years')
    ) = json_array_length(
      json_extract(NEW.after_json, '$.years')
    )
    AND json_array_length(
      json_extract(NEW.before_json, '$.years')
    ) >= 1
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS year
      WHERE json_type(year.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(year.value)) <> 5
        OR EXISTS (
          SELECT 1
          FROM json_each(year.value) AS field
          WHERE field.key NOT IN (
            'id',
            'seasonId',
            'amountCents',
            'status',
            'createdAtMs'
          )
        )
        OR json_extract(year.value, '$.amountCents') <>
          json_extract(
            NEW.before_json,
            '$.annualPenaltyBasisCents'
          )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS year
      WHERE json_type(year.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(year.value)) <> 5
        OR EXISTS (
          SELECT 1
          FROM json_each(year.value) AS field
          WHERE field.key NOT IN (
            'id',
            'seasonId',
            'amountCents',
            'status',
            'createdAtMs'
          )
        )
        OR json_extract(year.value, '$.amountCents') <>
          json_extract(
            NEW.after_json,
            '$.annualPenaltyBasisCents'
          )
    )
  ) THEN RAISE(
    ABORT,
    'buyout rollover item transition is inconsistent'
  ) END;

  SELECT CASE WHEN
    NEW.effect_kind = 'buyout_year_advanced'
    AND json_extract(NEW.after_json, '$.status') <> 'active'
  THEN RAISE(
    ABORT,
    'advanced buyout requires its exact target year'
  ) END;

  SELECT CASE WHEN
    NEW.effect_kind = 'buyout_obligation_completed'
    AND json_extract(NEW.after_json, '$.status') <> 'completed'
  THEN RAISE(
    ABORT,
    'completed buyout requires its final source year'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM buyout_obligations
    WHERE buyout_obligations.league_id = NEW.league_id
      AND buyout_obligations.id = NEW.entity_id
      AND buyout_obligations.contract_id =
        json_extract(NEW.after_json, '$.contractId')
      AND buyout_obligations.player_id =
        json_extract(NEW.after_json, '$.playerId')
      AND buyout_obligations.originating_team_id =
        json_extract(NEW.after_json, '$.originatingTeamId')
      AND buyout_obligations.responsible_team_id =
        json_extract(NEW.after_json, '$.responsibleTeamId')
      AND buyout_obligations.annual_penalty_basis_cents =
        json_extract(
          NEW.after_json,
          '$.annualPenaltyBasisCents'
        )
      AND buyout_obligations.buyout_transaction_id =
        json_extract(NEW.after_json, '$.buyoutTransactionId')
      AND buyout_obligations.status =
        json_extract(NEW.after_json, '$.status')
      AND buyout_obligations.created_at_ms =
        json_extract(NEW.after_json, '$.createdAtMs')
      AND buyout_obligations.updated_at_ms =
        NEW.occurred_at_ms
      AND buyout_obligations.version =
        json_extract(NEW.after_json, '$.version')
  ) THEN RAISE(
    ABORT,
    'buyout item must match the committed obligation'
  ) END;

  SELECT CASE WHEN
    (
      SELECT COUNT(*)
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      )
      WHERE json_extract(value, '$.seasonId') =
        NEW.from_season_id
        AND json_extract(value, '$.status') = 'current'
    ) <> 1
    OR (
      SELECT COUNT(*)
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      )
      WHERE json_extract(value, '$.seasonId') =
        NEW.from_season_id
        AND json_extract(value, '$.status') = 'completed'
    ) <> 1
    OR (
      NEW.effect_kind = 'buyout_year_advanced'
      AND (
        (
          SELECT COUNT(*)
          FROM json_each(
            json_extract(NEW.before_json, '$.years')
          )
          WHERE json_extract(value, '$.seasonId') =
            NEW.to_season_id
            AND json_extract(value, '$.status') = 'future'
        ) <> 1
        OR (
          SELECT COUNT(*)
          FROM json_each(
            json_extract(NEW.after_json, '$.years')
          )
          WHERE json_extract(value, '$.seasonId') =
            NEW.to_season_id
            AND json_extract(value, '$.status') = 'current'
        ) <> 1
      )
    )
    OR (
      NEW.effect_kind = 'buyout_obligation_completed'
      AND EXISTS (
        SELECT 1
        FROM json_each(
          json_extract(NEW.before_json, '$.years')
        )
        WHERE json_extract(value, '$.seasonId') =
          NEW.to_season_id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS before_year
      JOIN json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS after_year
        ON after_year.key = before_year.key
      WHERE json_extract(before_year.value, '$.id') IS NOT
          json_extract(after_year.value, '$.id')
        OR json_extract(
          before_year.value,
          '$.seasonId'
        ) IS NOT json_extract(after_year.value, '$.seasonId')
        OR json_extract(
          before_year.value,
          '$.amountCents'
        ) IS NOT json_extract(after_year.value, '$.amountCents')
        OR json_extract(
          before_year.value,
          '$.createdAtMs'
        ) IS NOT json_extract(after_year.value, '$.createdAtMs')
        OR (
          json_extract(before_year.value, '$.seasonId')
            NOT IN (NEW.from_season_id, NEW.to_season_id)
          AND before_year.value <> after_year.value
        )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS year
      LEFT JOIN json_each(
        json_extract(NEW.before_json, '$.years')
      ) AS prior
        ON prior.key = year.key - 1
      WHERE year.key > 0
        AND (
          json_extract(prior.value, '$.seasonId') >
            json_extract(year.value, '$.seasonId')
          OR (
            json_extract(prior.value, '$.seasonId') =
              json_extract(year.value, '$.seasonId')
            AND json_extract(prior.value, '$.id') >=
              json_extract(year.value, '$.id')
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.after_json, '$.years')
      ) AS year
      WHERE NOT EXISTS (
        SELECT 1
        FROM buyout_years
        WHERE buyout_years.league_id = NEW.league_id
          AND buyout_years.buyout_obligation_id =
            NEW.entity_id
          AND buyout_years.id =
            json_extract(year.value, '$.id')
          AND buyout_years.season_id =
            json_extract(year.value, '$.seasonId')
          AND buyout_years.penalty_cents =
            json_extract(year.value, '$.amountCents')
          AND buyout_years.status =
            json_extract(year.value, '$.status')
          AND buyout_years.created_at_ms =
            json_extract(year.value, '$.createdAtMs')
      )
    )
    OR (
      SELECT COUNT(*)
      FROM buyout_years
      WHERE buyout_years.league_id = NEW.league_id
        AND buyout_years.buyout_obligation_id =
          NEW.entity_id
    ) <> json_array_length(
      json_extract(NEW.after_json, '$.years')
    )
  THEN RAISE(
    ABORT,
    'buyout item years are not an exact committed schedule'
  ) END;
END;

CREATE TRIGGER season_rollover_items_trade_insert
BEFORE INSERT ON season_rollover_items
WHEN NEW.effect_kind = 'trade_cancelled'
BEGIN
  SELECT CASE WHEN NOT (
    json_extract(NEW.before_json, '$.status') = 'proposed'
    AND json_extract(NEW.after_json, '$.status') = 'cancelled'
    AND json_extract(NEW.before_json, '$.version') >= 1
    AND json_extract(NEW.after_json, '$.version') =
      json_extract(NEW.before_json, '$.version') + 1
    AND json_extract(NEW.before_json, '$.seasonId') =
      NEW.from_season_id
    AND json_extract(NEW.after_json, '$.seasonId') =
      NEW.from_season_id
    AND json_extract(NEW.before_json, '$.respondedAtMs') IS NULL
    AND json_extract(NEW.after_json, '$.respondedAtMs') =
      NEW.occurred_at_ms
    AND json_extract(NEW.before_json, '$.completedAtMs') IS NULL
    AND json_extract(NEW.after_json, '$.completedAtMs') IS NULL
    AND json_extract(
      NEW.before_json,
      '$.commissionerCompletionReference'
    ) IS NULL
    AND json_extract(
      NEW.after_json,
      '$.commissionerCompletionReference'
    ) IS NULL
    AND json_extract(NEW.after_json, '$.updatedAtMs') =
      NEW.occurred_at_ms
    AND json_extract(NEW.before_json, '$.proposingTeamId') IS
      json_extract(NEW.after_json, '$.proposingTeamId')
    AND json_extract(NEW.before_json, '$.receivingTeamId') IS
      json_extract(NEW.after_json, '$.receivingTeamId')
    AND json_extract(NEW.before_json, '$.proposingUserId') IS
      json_extract(NEW.after_json, '$.proposingUserId')
    AND json_extract(
      NEW.before_json,
      '$.creatingMembershipId'
    ) IS json_extract(
      NEW.after_json,
      '$.creatingMembershipId'
    )
    AND json_extract(NEW.before_json, '$.creatingAuthority') IS
      json_extract(NEW.after_json, '$.creatingAuthority')
    AND json_extract(NEW.before_json, '$.createdAtMs') IS
      json_extract(NEW.after_json, '$.createdAtMs')
    AND json_extract(NEW.before_json, '$.expiresAtMs') IS
      json_extract(NEW.after_json, '$.expiresAtMs')
    AND json_extract(
      NEW.before_json,
      '$.effectiveDeadlineAtMs'
    ) IS json_extract(
      NEW.after_json,
      '$.effectiveDeadlineAtMs'
    )
    AND json_extract(
      NEW.before_json,
      '$.proposalModelVersion'
    ) IS json_extract(
      NEW.after_json,
      '$.proposalModelVersion'
    )
    AND json_type(NEW.before_json, '$.assets') = 'array'
    AND json_type(NEW.after_json, '$.assets') = 'array'
    AND json_extract(NEW.before_json, '$.assets') =
      json_extract(NEW.after_json, '$.assets')
  ) THEN RAISE(
    ABORT,
    'trade rollover item transition is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(
      json_extract(NEW.after_json, '$.assets')
    ) AS asset
    WHERE json_type(asset.value) <> 'object'
      OR (SELECT COUNT(*) FROM json_each(asset.value)) <> 20
      OR EXISTS (
        SELECT 1
        FROM json_each(asset.value) AS field
        WHERE field.key NOT IN (
          'id',
          'leagueId',
          'tradeId',
          'direction',
          'sourceTeamId',
          'destinationTeamId',
          'assetType',
          'contractId',
          'playerId',
          'draftPickId',
          'retentionObligationId',
          'buyoutObligationId',
          'futureConsiderationId',
          'requestedRetentionContractId',
          'requestedRetentionCents',
          'futureConsiderationDescription',
          'proposalSnapshotJson',
          'assetModelVersion',
          'sequence',
          'createdAtMs'
        )
      )
      OR json_extract(asset.value, '$.leagueId') <>
        NEW.league_id
      OR json_extract(asset.value, '$.tradeId') <>
        NEW.entity_id
      OR NOT EXISTS (
        SELECT 1
        FROM trade_assets
        WHERE trade_assets.league_id = NEW.league_id
          AND trade_assets.trade_id = NEW.entity_id
          AND trade_assets.id =
            json_extract(asset.value, '$.id')
          AND trade_assets.direction =
            json_extract(asset.value, '$.direction')
          AND trade_assets.source_team_id =
            json_extract(asset.value, '$.sourceTeamId')
          AND trade_assets.destination_team_id =
            json_extract(asset.value, '$.destinationTeamId')
          AND trade_assets.asset_type =
            json_extract(asset.value, '$.assetType')
          AND trade_assets.contract_id IS
            json_extract(asset.value, '$.contractId')
          AND trade_assets.player_id IS
            json_extract(asset.value, '$.playerId')
          AND trade_assets.draft_pick_id IS
            json_extract(asset.value, '$.draftPickId')
          AND trade_assets.retention_obligation_id IS
            json_extract(
              asset.value,
              '$.retentionObligationId'
            )
          AND trade_assets.buyout_obligation_id IS
            json_extract(asset.value, '$.buyoutObligationId')
          AND trade_assets.future_consideration_id IS
            json_extract(
              asset.value,
              '$.futureConsiderationId'
            )
          AND trade_assets.requested_retention_contract_id IS
            json_extract(
              asset.value,
              '$.requestedRetentionContractId'
            )
          AND trade_assets.requested_retention_cents IS
            json_extract(
              asset.value,
              '$.requestedRetentionCents'
            )
          AND trade_assets.future_consideration_description IS
            json_extract(
              asset.value,
              '$.futureConsiderationDescription'
            )
          AND trade_assets.proposal_snapshot_json IS
            json_extract(asset.value, '$.proposalSnapshotJson')
          AND trade_assets.asset_model_version =
            json_extract(asset.value, '$.assetModelVersion')
          AND trade_assets.sequence =
            json_extract(asset.value, '$.sequence')
          AND trade_assets.created_at_ms =
            json_extract(asset.value, '$.createdAtMs')
      )
  ) THEN RAISE(
    ABORT,
    'trade rollover assets must match exact committed rows'
  ) END;

  SELECT CASE WHEN
    (
      SELECT COUNT(*)
      FROM trade_assets
      WHERE trade_assets.league_id = NEW.league_id
        AND trade_assets.trade_id = NEW.entity_id
    ) <> json_array_length(
      json_extract(NEW.after_json, '$.assets')
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.after_json, '$.assets')
      ) AS asset
      LEFT JOIN json_each(
        json_extract(NEW.after_json, '$.assets')
      ) AS prior
        ON prior.key = asset.key - 1
      WHERE asset.key > 0
        AND (
          json_extract(prior.value, '$.sequence') >
            json_extract(asset.value, '$.sequence')
          OR (
            json_extract(prior.value, '$.sequence') =
              json_extract(asset.value, '$.sequence')
            AND json_extract(prior.value, '$.id') >=
              json_extract(asset.value, '$.id')
          )
        )
    )
  THEN RAISE(
    ABORT,
    'trade rollover assets must be complete and ordered'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM trades
    WHERE trades.league_id = NEW.league_id
      AND trades.id = NEW.entity_id
      AND trades.season_id = NEW.from_season_id
      AND trades.proposing_team_id =
        json_extract(NEW.after_json, '$.proposingTeamId')
      AND trades.receiving_team_id =
        json_extract(NEW.after_json, '$.receivingTeamId')
      AND trades.proposing_user_id =
        json_extract(NEW.after_json, '$.proposingUserId')
      AND trades.creating_membership_id IS
        json_extract(
          NEW.after_json,
          '$.creatingMembershipId'
        )
      AND trades.creating_authority IS
        json_extract(NEW.after_json, '$.creatingAuthority')
      AND trades.status = 'cancelled'
      AND trades.created_at_ms =
        json_extract(NEW.after_json, '$.createdAtMs')
      AND trades.expires_at_ms =
        json_extract(NEW.after_json, '$.expiresAtMs')
      AND trades.effective_deadline_at_ms IS
        json_extract(
          NEW.after_json,
          '$.effectiveDeadlineAtMs'
        )
      AND trades.responded_at_ms = NEW.occurred_at_ms
      AND trades.completed_at_ms IS NULL
      AND trades.commissioner_completion_reference IS NULL
      AND trades.proposal_model_version =
        json_extract(
          NEW.after_json,
          '$.proposalModelVersion'
        )
      AND trades.updated_at_ms = NEW.occurred_at_ms
      AND trades.version =
        json_extract(NEW.after_json, '$.version')
  ) THEN RAISE(
    ABORT,
    'trade item must match the committed proposal'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.causal_assets_json) AS causal
    WHERE json_type(causal.value) <> 'object'
      OR (SELECT COUNT(*) FROM json_each(causal.value)) <> 3
      OR EXISTS (
        SELECT 1
        FROM json_each(causal.value) AS field
        WHERE field.key NOT IN (
          'tradeAssetSequence',
          'tradeAssetType',
          'rolloverItemId'
        )
      )
      OR json_type(
        causal.value,
        '$.tradeAssetSequence'
      ) <> 'integer'
      OR json_extract(
        causal.value,
        '$.tradeAssetSequence'
      ) < 1
      OR json_type(
        causal.value,
        '$.tradeAssetType'
      ) <> 'text'
      OR json_extract(
        causal.value,
        '$.tradeAssetType'
      ) NOT IN (
        'contract',
        'prospect_right',
        'retention_obligation',
        'buyout_obligation',
        'requested_retention'
      )
      OR json_type(
        causal.value,
        '$.rolloverItemId'
      ) <> 'text'
      OR NOT EXISTS (
        SELECT 1
        FROM trade_assets
        JOIN season_rollover_items AS cause_item
          ON cause_item.league_id = NEW.league_id
          AND cause_item.rollover_id = NEW.rollover_id
          AND cause_item.id = json_extract(
            causal.value,
            '$.rolloverItemId'
          )
        WHERE trade_assets.league_id = NEW.league_id
          AND trade_assets.trade_id = NEW.entity_id
          AND trade_assets.sequence = json_extract(
            causal.value,
            '$.tradeAssetSequence'
          )
          AND trade_assets.asset_type = json_extract(
            causal.value,
            '$.tradeAssetType'
          )
          AND (
            (
              trade_assets.asset_type = 'contract'
              AND cause_item.effect_kind = 'contract_expired'
              AND cause_item.entity_id = trade_assets.contract_id
            )
            OR (
              trade_assets.asset_type = 'prospect_right'
              AND cause_item.effect_kind = 'ownership_released'
              AND json_extract(
                cause_item.before_json,
                '$.playerId'
              ) = trade_assets.player_id
            )
            OR (
              trade_assets.asset_type = 'retention_obligation'
              AND cause_item.effect_kind =
                'retention_obligation_completed'
              AND cause_item.entity_id =
                trade_assets.retention_obligation_id
            )
            OR (
              trade_assets.asset_type = 'buyout_obligation'
              AND cause_item.effect_kind =
                'buyout_obligation_completed'
              AND cause_item.entity_id =
                trade_assets.buyout_obligation_id
            )
            OR (
              trade_assets.asset_type = 'requested_retention'
              AND cause_item.effect_kind = 'contract_expired'
              AND cause_item.entity_id =
                trade_assets.requested_retention_contract_id
            )
          )
      )
  ) THEN RAISE(
    ABORT,
    'trade cancellation causal assets are inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.causal_assets_json) AS causal
    LEFT JOIN json_each(NEW.causal_assets_json) AS prior
      ON prior.key = causal.key - 1
    WHERE causal.key > 0
      AND (
        json_extract(
          prior.value,
          '$.tradeAssetSequence'
        ) > json_extract(
          causal.value,
          '$.tradeAssetSequence'
        )
        OR (
          json_extract(
            prior.value,
            '$.tradeAssetSequence'
          ) = json_extract(
            causal.value,
            '$.tradeAssetSequence'
          )
          AND json_extract(
            prior.value,
            '$.rolloverItemId'
          ) >= json_extract(
            causal.value,
            '$.rolloverItemId'
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'trade cancellation causal assets must be ordered'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.causal_assets_json) AS causal
    JOIN json_each(NEW.causal_assets_json) AS duplicate
      ON duplicate.key <> causal.key
      AND json_extract(
        duplicate.value,
        '$.tradeAssetSequence'
      ) = json_extract(
        causal.value,
        '$.tradeAssetSequence'
      )
  ) THEN RAISE(
    ABORT,
    'trade cancellation requires one cause per asset sequence'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM trade_assets
    WHERE trade_assets.league_id = NEW.league_id
      AND trade_assets.trade_id = NEW.entity_id
      AND (
        EXISTS (
          SELECT 1
          FROM season_rollover_items AS cause_item
          WHERE cause_item.league_id = NEW.league_id
            AND cause_item.rollover_id = NEW.rollover_id
            AND (
              (
                trade_assets.asset_type = 'contract'
                AND cause_item.effect_kind =
                  'contract_expired'
                AND cause_item.entity_id =
                  trade_assets.contract_id
              )
              OR (
                trade_assets.asset_type = 'prospect_right'
                AND cause_item.effect_kind =
                  'ownership_released'
                AND json_extract(
                  cause_item.before_json,
                  '$.playerId'
                ) = trade_assets.player_id
              )
              OR (
                trade_assets.asset_type =
                  'retention_obligation'
                AND cause_item.effect_kind =
                  'retention_obligation_completed'
                AND cause_item.entity_id =
                  trade_assets.retention_obligation_id
              )
              OR (
                trade_assets.asset_type =
                  'buyout_obligation'
                AND cause_item.effect_kind =
                  'buyout_obligation_completed'
                AND cause_item.entity_id =
                  trade_assets.buyout_obligation_id
              )
              OR (
                trade_assets.asset_type =
                  'requested_retention'
                AND cause_item.effect_kind =
                  'contract_expired'
                AND cause_item.entity_id =
                  trade_assets.requested_retention_contract_id
              )
            )
        )
      )
  ) <> json_array_length(NEW.causal_assets_json)
  THEN RAISE(
    ABORT,
    'trade cancellation causal set is not closed'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM trade_events
    WHERE trade_events.league_id = NEW.league_id
      AND trade_events.id = NEW.trade_event_id
      AND trade_events.season_id = NEW.from_season_id
      AND trade_events.trade_id = NEW.entity_id
      AND trade_events.actor_user_id IS NULL
      AND trade_events.event_type = 'proposal_auto_cancelled'
      AND trade_events.reason =
        'asset_expired_during_season_rollover'
      AND trade_events.occurred_at_ms = NEW.occurred_at_ms
      AND json_valid(trade_events.metadata_json) = 1
      AND json_type(trade_events.metadata_json) = 'object'
      AND json(trade_events.metadata_json) =
        trade_events.metadata_json
      AND (
        SELECT COUNT(*)
        FROM json_each(trade_events.metadata_json)
      ) = 8
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(trade_events.metadata_json)
        WHERE key NOT IN (
          'schemaVersion',
          'rolloverId',
          'rolloverItemId',
          'fromSeasonId',
          'toSeasonId',
          'before',
          'after',
          'causalAssets'
        )
      )
      AND json_extract(
        trade_events.metadata_json,
        '$.schemaVersion'
      ) = 1
      AND json_extract(
        trade_events.metadata_json,
        '$.rolloverId'
      ) = NEW.rollover_id
      AND json_extract(
        trade_events.metadata_json,
        '$.rolloverItemId'
      ) = NEW.id
      AND json_extract(
        trade_events.metadata_json,
        '$.fromSeasonId'
      ) = NEW.from_season_id
      AND json_extract(
        trade_events.metadata_json,
        '$.toSeasonId'
      ) = NEW.to_season_id
      AND json_extract(
        trade_events.metadata_json,
        '$.before'
      ) = json(NEW.before_json)
      AND json_extract(
        trade_events.metadata_json,
        '$.after'
      ) = json(NEW.after_json)
      AND json_extract(
        trade_events.metadata_json,
        '$.causalAssets'
      ) = json(NEW.causal_assets_json)
  ) THEN RAISE(
    ABORT,
    'trade rollover event evidence is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_activity
    WHERE league_activity.league_id = NEW.league_id
      AND league_activity.id = NEW.league_activity_id
      AND league_activity.season_id = NEW.from_season_id
      AND league_activity.event_type =
        'trade_proposal_automatically_cancelled'
      AND league_activity.actor_user_id IS NULL
      AND league_activity.actor_authority = 'system'
      AND league_activity.team_id IS NULL
      AND league_activity.player_id IS NULL
      AND league_activity.related_type = 'trade'
      AND league_activity.related_id = NEW.entity_id
      AND league_activity.display_summary =
        'Trade proposal automatically cancelled.'
      AND league_activity.reason IS NULL
      AND league_activity.occurred_at_ms = NEW.occurred_at_ms
      AND json_valid(league_activity.metadata_json) = 1
      AND json_type(league_activity.metadata_json) = 'object'
      AND json(league_activity.metadata_json) =
        league_activity.metadata_json
      AND (
        SELECT COUNT(*)
        FROM json_each(league_activity.metadata_json)
      ) = 6
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(league_activity.metadata_json)
        WHERE key NOT IN (
          'rolloverId',
          'proposalId',
          'fromStatus',
          'toStatus',
          'reasonCode',
          'causalAssets'
        )
      )
      AND json_extract(
        league_activity.metadata_json,
        '$.rolloverId'
      ) = NEW.rollover_id
      AND json_extract(
        league_activity.metadata_json,
        '$.proposalId'
      ) = NEW.entity_id
      AND json_extract(
        league_activity.metadata_json,
        '$.fromStatus'
      ) = 'Pending'
      AND json_extract(
        league_activity.metadata_json,
        '$.toStatus'
      ) = 'Automatically Cancelled'
      AND json_extract(
        league_activity.metadata_json,
        '$.reasonCode'
      ) = 'asset_expired_during_season_rollover'
      AND json_extract(
        league_activity.metadata_json,
        '$.causalAssets'
      ) = json(NEW.causal_assets_json)
  ) THEN RAISE(
    ABORT,
    'trade rollover activity evidence is inconsistent'
  ) END;
END;

CREATE TRIGGER season_rollover_items_immutable_update
BEFORE UPDATE ON season_rollover_items
BEGIN
  SELECT RAISE(
    ABORT,
    'season rollover item evidence is immutable'
  );
END;

CREATE TRIGGER season_rollover_items_immutable_delete
BEFORE DELETE ON season_rollover_items
BEGIN
  SELECT RAISE(
    ABORT,
    'season rollover item evidence is immutable'
  );
END;

CREATE TRIGGER season_rollovers_t037_evidence_insert
BEFORE INSERT ON season_rollovers
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'succeeded'
    AND NEW.idempotency_request_id IS NOT NULL
    AND NEW.from_season_label IS NOT NULL
    AND NEW.from_nhl_season_key IS NOT NULL
    AND NEW.to_season_label IS NOT NULL
    AND NEW.target_nhl_season_key IS NOT NULL
    AND NEW.nhl_regular_season_starts_at_ms IS NOT NULL
    AND NEW.nhl_regular_season_ends_at_ms IS NOT NULL
    AND NEW.fantasy_playoffs_start_at_ms IS NOT NULL
    AND NEW.fantasy_playoffs_end_at_ms IS NOT NULL
    AND NEW.source_fad_id IS NOT NULL
    AND NEW.source_finalization_root_id IS NOT NULL
    AND NEW.source_finalization_id IS NOT NULL
    AND NEW.source_standings_snapshot_id IS NOT NULL
    AND NEW.source_standings_operation_id IS NOT NULL
    AND NEW.source_readiness_json IS NOT NULL
    AND NEW.source_readiness_schema_version = 1
    AND NEW.source_readiness_sha256 IS NOT NULL
    AND NEW.aggregate_activity_id IS NOT NULL
    AND NEW.security_audit_event_id IS NOT NULL
    AND NEW.outbox_event_id IS NOT NULL
    AND NEW.manifest_schema_version = 1
    AND NEW.manifest_sha256 IS NOT NULL
    AND NEW.created_at_ms = NEW.completed_at_ms
    AND NEW.version = 1
  ) THEN RAISE(
    ABORT,
    'season rollover requires complete version-1 evidence'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.nhl_regular_season_starts_at_ms <
      NEW.fantasy_playoffs_start_at_ms
    AND NEW.fantasy_playoffs_start_at_ms <
      NEW.fantasy_playoffs_end_at_ms
    AND NEW.fantasy_playoffs_end_at_ms =
      NEW.nhl_regular_season_ends_at_ms
    AND NEW.fantasy_playoffs_end_at_ms -
      NEW.fantasy_playoffs_start_at_ms = 2419200000
  ) THEN RAISE(
    ABORT,
    'season rollover target calendar is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM seasons AS source_season
    JOIN seasons AS target_season
      ON target_season.league_id = source_season.league_id
      AND target_season.id = NEW.to_season_id
    WHERE source_season.league_id = NEW.league_id
      AND source_season.id = NEW.from_season_id
      AND source_season.label = NEW.from_season_label
      AND source_season.nhl_season_key =
        NEW.from_nhl_season_key
      AND target_season.label = NEW.to_season_label
      AND target_season.nhl_season_key =
        NEW.target_nhl_season_key
      AND target_season.regular_season_starts_at_ms =
        NEW.nhl_regular_season_starts_at_ms
      AND target_season.regular_season_ends_at_ms =
        NEW.nhl_regular_season_ends_at_ms
      AND target_season.fantasy_playoffs_start_at_ms =
        NEW.fantasy_playoffs_start_at_ms
      AND target_season.fantasy_playoffs_end_at_ms =
        NEW.fantasy_playoffs_end_at_ms
  ) THEN RAISE(
    ABORT,
    'season rollover labels, keys, and calendar must be exact'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM idempotency_requests
    WHERE idempotency_requests.league_id = NEW.league_id
      AND idempotency_requests.id = NEW.idempotency_request_id
      AND idempotency_requests.actor_user_id =
        NEW.authorized_by_user_id
      AND idempotency_requests.operation =
        'league.lifecycle.transition.v1'
      AND idempotency_requests.status = 'started'
      AND idempotency_requests.result_type IS NULL
      AND idempotency_requests.result_id IS NULL
      AND idempotency_requests.completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'season rollover requires its started lifecycle request'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM free_agent_draft_setup_exemptions
    WHERE free_agent_draft_setup_exemptions.idempotency_request_id =
      NEW.idempotency_request_id
  ) THEN RAISE(
    ABORT,
    'lifecycle request cannot own both resource types'
  ) END;

  SELECT CASE WHEN
    json_valid(NEW.source_readiness_json) <> 1
    OR json_type(NEW.source_readiness_json) <> 'object'
    OR json(NEW.source_readiness_json) <>
      NEW.source_readiness_json
    OR (
      SELECT COUNT(*)
      FROM json_each(NEW.source_readiness_json)
    ) <> 36
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.source_readiness_json)
      WHERE key NOT IN (
        'leagueId',
        'fromSeasonId',
        'observedAtMs',
        'sourceFadId',
        'sourceFadCompletedAtMs',
        'sourceFinalizationRootId',
        'sourceFinalizationId',
        'sourceStandingsSnapshotId',
        'sourceStandingsOperationId',
        'recognizedSeasonOperationTables',
        'freeAgentDraft',
        'freeAgentDraftPlayerAllocations',
        'freeAgentDraftAllocationEvents',
        'freeAgentDraftRollovers',
        'freeAgentDraftRecoveries',
        'auctionContexts',
        'freeAgentDraftAuctionParticipants',
        'freeAgentDraftDraws',
        'auctions',
        'auctionBids',
        'auctionResolutions',
        'matchupWeeks',
        'matchups',
        'matchupResults',
        'matchupResultVersions',
        'matchupOperations',
        'standingsOperations',
        'jobRuns',
        'trades',
        'tradeAssets',
        'finalStandingsFinalizations',
        'standingsSnapshots',
        'standingsRows',
        'standingsSnapshotTeamIdentities',
        'standingsSnapshotResultVersions',
        'finalizationIdempotencyRequests'
      )
    )
    OR json_extract(
      NEW.source_readiness_json,
      '$.leagueId'
    ) <> NEW.league_id
    OR json_extract(
      NEW.source_readiness_json,
      '$.fromSeasonId'
    ) <> NEW.from_season_id
    OR json_extract(
      NEW.source_readiness_json,
      '$.observedAtMs'
    ) <> NEW.completed_at_ms
    OR json_extract(
      NEW.source_readiness_json,
      '$.sourceFadId'
    ) <> NEW.source_fad_id
    OR json_extract(
      NEW.source_readiness_json,
      '$.sourceFinalizationRootId'
    ) <> NEW.source_finalization_root_id
    OR json_extract(
      NEW.source_readiness_json,
      '$.sourceFinalizationId'
    ) <> NEW.source_finalization_id
    OR json_extract(
      NEW.source_readiness_json,
      '$.sourceStandingsSnapshotId'
    ) <> NEW.source_standings_snapshot_id
    OR json_extract(
      NEW.source_readiness_json,
      '$.sourceStandingsOperationId'
    ) <> NEW.source_standings_operation_id
    OR json_extract(
      NEW.source_readiness_json,
      '$.recognizedSeasonOperationTables'
    ) <> json(
      '["matchup_operations","standings_operations"]'
    )
    OR json_type(
      NEW.source_readiness_json,
      '$.freeAgentDraft'
    ) <> 'object'
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.source_readiness_json)
      WHERE key IN (
        'freeAgentDraftPlayerAllocations',
        'freeAgentDraftAllocationEvents',
        'freeAgentDraftRollovers',
        'freeAgentDraftRecoveries',
        'auctionContexts',
        'freeAgentDraftAuctionParticipants',
        'freeAgentDraftDraws',
        'auctions',
        'auctionBids',
        'auctionResolutions',
        'matchupWeeks',
        'matchups',
        'matchupResults',
        'matchupResultVersions',
        'matchupOperations',
        'standingsOperations',
        'jobRuns',
        'trades',
        'tradeAssets',
        'finalStandingsFinalizations',
        'standingsSnapshots',
        'standingsRows',
        'standingsSnapshotTeamIdentities',
        'standingsSnapshotResultVersions',
        'finalizationIdempotencyRequests'
      )
      AND type <> 'array'
    )
  THEN RAISE(
    ABORT,
    'season rollover source-readiness projection is not exact'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM free_agent_drafts
    WHERE free_agent_drafts.league_id = NEW.league_id
      AND free_agent_drafts.season_id = NEW.from_season_id
      AND free_agent_drafts.id = NEW.source_fad_id
      AND free_agent_drafts.status = 'completed'
      AND free_agent_drafts.completed_at_ms IS NOT NULL
      AND free_agent_drafts.completed_at_ms = json_extract(
        NEW.source_readiness_json,
        '$.sourceFadCompletedAtMs'
      )
      AND json_extract(
        NEW.source_readiness_json,
        '$.freeAgentDraft.id'
      ) = free_agent_drafts.id
      AND json_extract(
        NEW.source_readiness_json,
        '$.freeAgentDraft.league_id'
      ) = free_agent_drafts.league_id
      AND json_extract(
        NEW.source_readiness_json,
        '$.freeAgentDraft.season_id'
      ) = free_agent_drafts.season_id
  ) THEN RAISE(
    ABORT,
    'season rollover source FAD evidence is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM standings_snapshot_finalizations AS root_finalization
    JOIN standings_snapshot_finalizations AS finalization
      ON finalization.league_id = root_finalization.league_id
      AND finalization.season_id = root_finalization.season_id
      AND finalization.id = NEW.source_finalization_id
    JOIN standings_snapshots
      ON standings_snapshots.league_id = finalization.league_id
      AND standings_snapshots.season_id = finalization.season_id
      AND standings_snapshots.id =
        NEW.source_standings_snapshot_id
    JOIN standings_operations AS root_operation
      ON root_operation.league_id = root_finalization.league_id
      AND root_operation.season_id = root_finalization.season_id
      AND root_operation.id =
        root_finalization.standings_operation_id
    JOIN standings_operations AS current_operation
      ON current_operation.league_id = finalization.league_id
      AND current_operation.season_id = finalization.season_id
      AND current_operation.id =
        NEW.source_standings_operation_id
    WHERE root_finalization.league_id = NEW.league_id
      AND root_finalization.season_id = NEW.from_season_id
      AND root_finalization.id =
        NEW.source_finalization_root_id
      AND root_finalization.replaces_finalization_id IS NULL
      AND root_finalization.cause =
        'regular_season_completion'
      AND root_operation.status = 'succeeded'
      AND root_operation.operation_type =
        'finalize_regular_season'
      AND root_operation.standings_snapshot_id =
        root_finalization.standings_snapshot_id
      AND finalization.status = 'final'
      AND finalization.standings_snapshot_id =
        NEW.source_standings_snapshot_id
      AND finalization.standings_operation_id =
        NEW.source_standings_operation_id
      AND standings_snapshots.status = 'final'
      AND current_operation.status = 'succeeded'
      AND current_operation.standings_snapshot_id =
        NEW.source_standings_snapshot_id
      AND (
        (
          finalization.id = root_finalization.id
          AND root_finalization.status = 'final'
          AND finalization.cause =
            'regular_season_completion'
          AND current_operation.operation_type =
            'finalize_regular_season'
        )
        OR
        (
          finalization.id <> root_finalization.id
          AND root_finalization.status = 'superseded'
          AND finalization.cause = 'result_correction'
          AND current_operation.operation_type =
            'correction_propagation'
          AND EXISTS (
            WITH RECURSIVE finalization_lineage(
              id,
              replaces_finalization_id
            ) AS (
              SELECT
                current.id,
                current.replaces_finalization_id
              FROM standings_snapshot_finalizations AS current
              WHERE current.league_id = NEW.league_id
                AND current.season_id = NEW.from_season_id
                AND current.id = NEW.source_finalization_id
              UNION ALL
              SELECT
                parent.id,
                parent.replaces_finalization_id
              FROM standings_snapshot_finalizations AS parent
              JOIN finalization_lineage AS child
                ON child.replaces_finalization_id = parent.id
              WHERE parent.league_id = NEW.league_id
                AND parent.season_id = NEW.from_season_id
            )
            SELECT 1
            FROM finalization_lineage
            WHERE finalization_lineage.id =
              NEW.source_finalization_root_id
              AND finalization_lineage.replaces_finalization_id
                IS NULL
          )
        )
      )
  ) THEN RAISE(
    ABORT,
    'season rollover finalization generation is inconsistent'
  ) END;

  SELECT CASE WHEN
    (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'contract_advanced'
    ) <> NEW.contracts_advanced
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'contract_expired'
    ) <> NEW.contracts_expired
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'ownership_carried'
    ) <> NEW.ownerships_carried
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'ownership_released'
    ) <> NEW.ownerships_released
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'retention_year_advanced'
    ) <> NEW.retention_years_advanced
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'retention_obligation_completed'
    ) <> NEW.retention_obligations_completed
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'buyout_year_advanced'
    ) <> NEW.buyout_years_advanced
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'buyout_obligation_completed'
    ) <> NEW.buyout_obligations_completed
    OR (
      SELECT COUNT(*)
      FROM season_rollover_items
      WHERE season_rollover_items.league_id = NEW.league_id
        AND season_rollover_items.rollover_id = NEW.id
        AND season_rollover_items.effect_kind =
          'trade_cancelled'
    ) <> NEW.trades_cancelled
  THEN RAISE(
    ABORT,
    'season rollover manifest counts are inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM season_rollover_items
    WHERE season_rollover_items.league_id = NEW.league_id
      AND season_rollover_items.rollover_id = NEW.id
      AND (
        season_rollover_items.idempotency_request_id <>
          NEW.idempotency_request_id
        OR season_rollover_items.from_season_id <>
          NEW.from_season_id
        OR season_rollover_items.to_season_id <>
          NEW.to_season_id
        OR season_rollover_items.occurred_at_ms <>
          NEW.completed_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'season rollover items do not share root identity'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_activity
    WHERE league_activity.league_id = NEW.league_id
      AND league_activity.id = NEW.aggregate_activity_id
      AND league_activity.season_id = NEW.to_season_id
      AND league_activity.event_type = 'season_rolled_over'
      AND league_activity.actor_user_id =
        NEW.authorized_by_user_id
      AND league_activity.actor_authority =
        NEW.authorized_authority
      AND league_activity.team_id IS NULL
      AND league_activity.player_id IS NULL
      AND league_activity.related_type = 'season'
      AND league_activity.related_id = NEW.to_season_id
      AND league_activity.display_summary =
        'Season ' || NEW.from_season_label ||
        ' completed; ' || NEW.to_season_label ||
        ' is now active.'
      AND league_activity.reason IS NULL
      AND league_activity.occurred_at_ms = NEW.completed_at_ms
      AND json_valid(league_activity.metadata_json) = 1
      AND json_type(league_activity.metadata_json) = 'object'
      AND json(league_activity.metadata_json) =
        league_activity.metadata_json
      AND (
        SELECT COUNT(*)
        FROM json_each(league_activity.metadata_json)
      ) = 5
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(league_activity.metadata_json)
        WHERE key NOT IN (
          'rolloverId',
          'fromSeasonId',
          'toSeasonId',
          'targetNhlSeasonKey',
          'summary'
        )
      )
      AND json_extract(
        league_activity.metadata_json,
        '$.rolloverId'
      ) = NEW.id
      AND json_extract(
        league_activity.metadata_json,
        '$.fromSeasonId'
      ) = NEW.from_season_id
      AND json_extract(
        league_activity.metadata_json,
        '$.toSeasonId'
      ) = NEW.to_season_id
      AND json_extract(
        league_activity.metadata_json,
        '$.targetNhlSeasonKey'
      ) = NEW.target_nhl_season_key
      AND json_type(
        league_activity.metadata_json,
        '$.summary'
      ) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(
          json_extract(
            league_activity.metadata_json,
            '$.summary'
          )
        )
      ) = 9
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.contractsAdvanced'
      ) = NEW.contracts_advanced
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.contractsExpired'
      ) = NEW.contracts_expired
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.ownershipsCarried'
      ) = NEW.ownerships_carried
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.ownershipsReleased'
      ) = NEW.ownerships_released
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.retentionYearsAdvanced'
      ) = NEW.retention_years_advanced
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.retentionObligationsCompleted'
      ) = NEW.retention_obligations_completed
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.buyoutYearsAdvanced'
      ) = NEW.buyout_years_advanced
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.buyoutObligationsCompleted'
      ) = NEW.buyout_obligations_completed
      AND json_extract(
        league_activity.metadata_json,
        '$.summary.tradesCancelled'
      ) = NEW.trades_cancelled
  ) THEN RAISE(
    ABORT,
    'season rollover aggregate activity is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM security_audit_events
    WHERE security_audit_events.id =
      NEW.security_audit_event_id
      AND security_audit_events.event_type =
        'league.season_rolled_over'
      AND security_audit_events.outcome = 'success'
      AND security_audit_events.actor_user_id =
        NEW.authorized_by_user_id
      AND security_audit_events.target_user_id IS NULL
      AND security_audit_events.league_id = NEW.league_id
      AND security_audit_events.reason_code =
        'season_rollover_authorized'
      AND security_audit_events.occurred_at_ms =
        NEW.completed_at_ms
  ) THEN RAISE(
    ABORT,
    'season rollover security audit is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM outbox_events
    WHERE outbox_events.league_id = NEW.league_id
      AND outbox_events.id = NEW.outbox_event_id
      AND outbox_events.event_type = 'league.changed'
      AND outbox_events.aggregate_type = 'league'
      AND outbox_events.aggregate_id = NEW.league_id
      AND outbox_events.status = 'pending'
      AND outbox_events.attempt_count = 0
      AND outbox_events.available_at_ms = NEW.completed_at_ms
      AND outbox_events.published_at_ms IS NULL
      AND outbox_events.last_error_code IS NULL
      AND outbox_events.created_at_ms = NEW.completed_at_ms
      AND outbox_events.updated_at_ms = NEW.completed_at_ms
      AND outbox_events.version = 1
      AND json_valid(outbox_events.payload_json) = 1
      AND json_type(outbox_events.payload_json) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(outbox_events.payload_json)
      ) = 6
      AND json_extract(
        outbox_events.payload_json,
        '$.kind'
      ) = 'invalidation'
      AND json_extract(
        outbox_events.payload_json,
        '$.eventType'
      ) = 'league.changed'
      AND json_extract(
        outbox_events.payload_json,
        '$.scope'
      ) = 'league'
      AND json_extract(
        outbox_events.payload_json,
        '$.scopeId'
      ) = NEW.league_id
      AND json_extract(
        outbox_events.payload_json,
        '$.version'
      ) = NEW.league_version_after
      AND json_extract(
        outbox_events.payload_json,
        '$.changedAtMs'
      ) = NEW.completed_at_ms
      AND (
        SELECT COUNT(*)
        FROM outbox_event_audiences
        WHERE outbox_event_audiences.league_id =
            NEW.league_id
          AND outbox_event_audiences.outbox_event_id =
            NEW.outbox_event_id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM outbox_event_audiences
        WHERE outbox_event_audiences.league_id =
            NEW.league_id
          AND outbox_event_audiences.outbox_event_id =
            NEW.outbox_event_id
          AND outbox_event_audiences.audience_kind =
            'league'
          AND outbox_event_audiences.team_id IS NULL
          AND outbox_event_audiences.user_id IS NULL
          AND outbox_event_audiences.created_at_ms =
            NEW.completed_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'season rollover outbox evidence is inconsistent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM contract_years
    WHERE contract_years.league_id = NEW.league_id
      AND contract_years.season_id = NEW.from_season_id
      AND contract_years.status = 'current'
  ) OR EXISTS (
    SELECT 1
    FROM retention_years
    WHERE retention_years.league_id = NEW.league_id
      AND retention_years.season_id = NEW.from_season_id
      AND retention_years.status = 'current'
  ) OR EXISTS (
    SELECT 1
    FROM buyout_years
    WHERE buyout_years.league_id = NEW.league_id
      AND buyout_years.season_id = NEW.from_season_id
      AND buyout_years.status = 'current'
  ) OR EXISTS (
    SELECT 1
    FROM player_ownerships
    WHERE player_ownerships.league_id = NEW.league_id
      AND player_ownerships.season_id = NEW.from_season_id
  ) THEN RAISE(
    ABORT,
    'season rollover source entities are not closed'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM roster_display_order_entries
    JOIN season_rollover_items
      ON season_rollover_items.league_id =
        roster_display_order_entries.league_id
      AND season_rollover_items.entity_id =
        roster_display_order_entries.ownership_id
      AND season_rollover_items.rollover_id = NEW.id
      AND season_rollover_items.effect_kind IN (
        'ownership_carried',
        'ownership_released'
      )
    WHERE roster_display_order_entries.league_id =
      NEW.league_id
  ) THEN RAISE(
    ABORT,
    'season rollover ownership display order cleanup is incomplete'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM season_rollover_items AS contract_item
    JOIN league_activity
      ON league_activity.league_id = contract_item.league_id
      AND league_activity.id = contract_item.league_activity_id
    WHERE contract_item.league_id = NEW.league_id
      AND contract_item.rollover_id = NEW.id
      AND contract_item.effect_kind = 'contract_expired'
      AND NOT EXISTS (
        SELECT 1
        FROM season_rollover_items AS ownership_item
        WHERE ownership_item.league_id =
            contract_item.league_id
          AND ownership_item.rollover_id =
            contract_item.rollover_id
          AND ownership_item.effect_kind =
            'ownership_released'
          AND ownership_item.entity_id = json_extract(
            league_activity.metadata_json,
            '$.ownershipId'
          )
          AND json_extract(
            ownership_item.before_json,
            '$.playerId'
          ) = json_extract(
            contract_item.before_json,
            '$.playerId'
          )
      )
  ) THEN RAISE(
    ABORT,
    'expired contracts require exact ownership tombstones'
  ) END;
END;

CREATE TRIGGER fad_setup_exemptions_reason_insert_0029
BEFORE INSERT ON free_agent_draft_setup_exemptions
WHEN instr(NEW.reason, char(0)) > 0
  OR EXISTS (
    WITH RECURSIVE character_positions(position) AS (
      VALUES (1)
      UNION ALL
      SELECT position + 1
      FROM character_positions
      WHERE position < length(NEW.reason)
    )
    SELECT 1
    FROM character_positions
    WHERE unicode(substr(NEW.reason, position, 1))
        BETWEEN 0 AND 31
      OR unicode(substr(NEW.reason, position, 1))
        BETWEEN 127 AND 159
      OR unicode(substr(NEW.reason, position, 1))
        IN (8232, 8233)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD setup exemption reason contains a forbidden control'
  );
END;

CREATE TRIGGER fad_setup_exemptions_reason_update_0029
BEFORE UPDATE OF reason ON free_agent_draft_setup_exemptions
WHEN instr(NEW.reason, char(0)) > 0
  OR EXISTS (
    WITH RECURSIVE character_positions(position) AS (
      VALUES (1)
      UNION ALL
      SELECT position + 1
      FROM character_positions
      WHERE position < length(NEW.reason)
    )
    SELECT 1
    FROM character_positions
    WHERE unicode(substr(NEW.reason, position, 1))
        BETWEEN 0 AND 31
      OR unicode(substr(NEW.reason, position, 1))
        BETWEEN 127 AND 159
      OR unicode(substr(NEW.reason, position, 1))
        IN (8232, 8233)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD setup exemption reason contains a forbidden control'
  );
END;

CREATE TRIGGER fad_setup_exemptions_t037_evidence_insert
BEFORE INSERT ON free_agent_draft_setup_exemptions
BEGIN
  SELECT CASE WHEN NOT (
    NEW.idempotency_request_id IS NOT NULL
    AND NEW.migration_report_sha256 IS NOT NULL
    AND NEW.bootstrap_identity_sha256 IS NOT NULL
    AND NEW.bootstrap_idempotency_request_id IS NOT NULL
    AND NEW.bootstrap_activity_id IS NOT NULL
    AND NEW.bootstrap_security_audit_event_id IS NOT NULL
    AND NEW.bootstrap_actor_user_id IS NOT NULL
    AND NEW.authorization_activity_id IS NOT NULL
    AND NEW.authorization_security_audit_event_id IS NOT NULL
    AND NEW.commissioner_notification_id IS NOT NULL
    AND NEW.outbox_event_id IS NOT NULL
    AND NEW.created_at_ms = NEW.authorized_at_ms
    AND NEW.updated_at_ms = NEW.authorized_at_ms
    AND NEW.version = 1
    AND NEW.consumed_fad_id IS NULL
    AND NEW.consumed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption requires complete version-1 evidence'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM idempotency_requests
    WHERE idempotency_requests.league_id = NEW.league_id
      AND idempotency_requests.id = NEW.idempotency_request_id
      AND idempotency_requests.actor_user_id =
        NEW.authorized_by_user_id
      AND idempotency_requests.operation =
        'league.lifecycle.transition.v1'
      AND idempotency_requests.status = 'started'
      AND idempotency_requests.result_type IS NULL
      AND idempotency_requests.result_id IS NULL
      AND idempotency_requests.completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption requires its started lifecycle request'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.idempotency_request_id =
      NEW.idempotency_request_id
  ) THEN RAISE(
    ABORT,
    'lifecycle request cannot own both resource types'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN seasons
      ON seasons.league_id = leagues.id
      AND seasons.id = NEW.season_id
    WHERE leagues.id = NEW.league_id
      AND leagues.status IN ('active', 'frozen')
      AND leagues.current_season_id = NEW.season_id
      AND seasons.status = 'active'
      AND seasons.label = '2026'
      AND seasons.nhl_season_key = '20262027'
      AND (
        SELECT COUNT(*)
        FROM seasons AS all_seasons
        WHERE all_seasons.league_id = NEW.league_id
      ) = 1
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption target is not the reset Season 2'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM migration_reports
    WHERE migration_reports.league_id = NEW.league_id
      AND migration_reports.id = NEW.migration_report_id
      AND migration_reports.status = 'succeeded'
      AND migration_reports.completed_at_ms IS NOT NULL
      AND migration_reports.reset_manifest_id =
        '2026-season-1-reset-v1'
      AND migration_reports.database_schema_version >= 1
      AND length(trim(migration_reports.source_bundle_id)) > 0
      AND json_valid(
        migration_reports.source_hashes_json
      ) = 1
      AND json_type(
        migration_reports.source_hashes_json
      ) = 'object'
      AND json_valid(migration_reports.counts_json) = 1
      AND json_type(
        migration_reports.counts_json
      ) = 'object'
      AND json_valid(migration_reports.totals_json) = 1
      AND json_type(
        migration_reports.totals_json
      ) = 'object'
      AND json_valid(migration_reports.warnings_json) = 1
      AND json_type(
        migration_reports.warnings_json
      ) = 'array'
      AND json_valid(migration_reports.rejects_json) = 1
      AND json(migration_reports.rejects_json) = '[]'
  ) OR (
    SELECT COUNT(*)
    FROM migration_reports
    WHERE migration_reports.league_id = NEW.league_id
      AND migration_reports.status = 'succeeded'
      AND migration_reports.completed_at_ms IS NOT NULL
      AND migration_reports.reset_manifest_id =
        '2026-season-1-reset-v1'
      AND migration_reports.database_schema_version >= 1
      AND length(trim(migration_reports.source_bundle_id)) > 0
      AND json_valid(
        migration_reports.source_hashes_json
      ) = 1
      AND json_type(
        migration_reports.source_hashes_json
      ) = 'object'
      AND json_valid(migration_reports.counts_json) = 1
      AND json_type(
        migration_reports.counts_json
      ) = 'object'
      AND json_valid(migration_reports.totals_json) = 1
      AND json_type(
        migration_reports.totals_json
      ) = 'object'
      AND json_valid(migration_reports.warnings_json) = 1
      AND json_type(
        migration_reports.warnings_json
      ) = 'array'
      AND json_valid(migration_reports.rejects_json) = 1
      AND json(migration_reports.rejects_json) = '[]'
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD setup exemption migration report is not exact'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN seasons
      ON seasons.league_id = leagues.id
      AND seasons.id = NEW.season_id
    JOIN idempotency_requests AS bootstrap_request
      ON bootstrap_request.league_id = leagues.id
      AND bootstrap_request.id =
        NEW.bootstrap_idempotency_request_id
    JOIN league_activity AS bootstrap_activity
      ON bootstrap_activity.league_id = leagues.id
      AND bootstrap_activity.id = NEW.bootstrap_activity_id
    JOIN security_audit_events AS bootstrap_audit
      ON bootstrap_audit.league_id = leagues.id
      AND bootstrap_audit.id =
        NEW.bootstrap_security_audit_event_id
    WHERE leagues.id = NEW.league_id
      AND NEW.bootstrap_actor_user_id =
        bootstrap_request.actor_user_id
      AND bootstrap_request.operation =
        'admin.league.bootstrap_reset_original.v1'
      AND bootstrap_request.status = 'completed'
      AND bootstrap_request.result_type = 'league'
      AND bootstrap_request.result_id = NEW.league_id
      AND bootstrap_request.created_at_ms =
        leagues.created_at_ms
      AND bootstrap_request.completed_at_ms =
        leagues.created_at_ms
      AND bootstrap_activity.season_id = NEW.season_id
      AND bootstrap_activity.event_type = 'league_created'
      AND bootstrap_activity.actor_user_id =
        NEW.bootstrap_actor_user_id
      AND bootstrap_activity.actor_authority =
        'platform_administrator'
      AND bootstrap_activity.team_id IS NULL
      AND bootstrap_activity.player_id IS NULL
      AND bootstrap_activity.related_type = 'league'
      AND bootstrap_activity.related_id = NEW.league_id
      AND bootstrap_activity.display_summary =
        leagues.name || ' was created in Setup.'
      AND bootstrap_activity.reason IS NULL
      AND bootstrap_activity.metadata_json =
        '{"leagueStatus":"setup","seasonStatus":"planned"}'
      AND bootstrap_activity.occurred_at_ms =
        leagues.created_at_ms
      AND bootstrap_audit.event_type =
        'system_bootstrap.reset_original_league_created'
      AND bootstrap_audit.outcome = 'success'
      AND bootstrap_audit.actor_user_id =
        NEW.bootstrap_actor_user_id
      AND bootstrap_audit.target_user_id IS NULL
      AND bootstrap_audit.session_id IS NULL
      AND bootstrap_audit.request_correlation_id IS NULL
      AND bootstrap_audit.reason_code =
        'closed_write_reset_handoff'
      AND bootstrap_audit.network_key_version IS NULL
      AND bootstrap_audit.network_metadata_digest IS NULL
      AND bootstrap_audit.client_metadata_json IS NULL
      AND bootstrap_audit.unknown_account_digest IS NULL
      AND bootstrap_audit.occurred_at_ms =
        leagues.created_at_ms
      AND seasons.created_at_ms = leagues.created_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption bootstrap identity is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_activity
    WHERE league_activity.league_id = NEW.league_id
      AND league_activity.id = NEW.authorization_activity_id
      AND league_activity.season_id = NEW.season_id
      AND league_activity.event_type =
        'fad_setup_exemption_authorized'
      AND league_activity.actor_user_id =
        NEW.authorized_by_user_id
      AND league_activity.actor_authority =
        NEW.authorized_authority
      AND league_activity.team_id IS NULL
      AND league_activity.player_id IS NULL
      AND league_activity.related_type = 'season'
      AND league_activity.related_id = NEW.season_id
      AND league_activity.display_summary =
        'Initial Season 2 Free Agent Draft exemption authorized.'
      AND league_activity.reason IS NULL
      AND league_activity.occurred_at_ms =
        NEW.authorized_at_ms
      AND json_valid(league_activity.metadata_json) = 1
      AND json_type(league_activity.metadata_json) = 'object'
      AND json(league_activity.metadata_json) =
        league_activity.metadata_json
      AND (
        SELECT COUNT(*)
        FROM json_each(league_activity.metadata_json)
      ) = 3
      AND json_extract(
        league_activity.metadata_json,
        '$.exemptionId'
      ) = NEW.id
      AND json_extract(
        league_activity.metadata_json,
        '$.seasonId'
      ) = NEW.season_id
      AND json_extract(
        league_activity.metadata_json,
        '$.migrationReportId'
      ) = NEW.migration_report_id
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption activity is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM security_audit_events
    WHERE security_audit_events.id =
      NEW.authorization_security_audit_event_id
      AND security_audit_events.event_type =
        'fad.setup_exemption_authorized'
      AND security_audit_events.outcome = 'success'
      AND security_audit_events.actor_user_id =
        NEW.authorized_by_user_id
      AND security_audit_events.target_user_id IS NULL
      AND security_audit_events.league_id = NEW.league_id
      AND security_audit_events.reason_code =
        'initial_season2_no_draft_authorized'
      AND security_audit_events.occurred_at_ms =
        NEW.authorized_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption security audit is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM notifications
    JOIN leagues
      ON leagues.id = NEW.league_id
    JOIN league_memberships AS commissioner_membership
      ON commissioner_membership.league_id = leagues.id
      AND commissioner_membership.id =
        leagues.commissioner_membership_id
    WHERE notifications.league_id = NEW.league_id
      AND notifications.id = NEW.commissioner_notification_id
      AND commissioner_membership.status = 'active'
      AND notifications.user_id =
        commissioner_membership.user_id
      AND notifications.event_type =
        'fad_setup_exemption_authorized'
      AND notifications.related_feature =
        'free_agent_draft_setup'
      AND notifications.related_record_id = NEW.id
      AND notifications.delivery_status = 'pending'
      AND notifications.created_at_ms = NEW.authorized_at_ms
      AND notifications.read_at_ms IS NULL
      AND notifications.delivered_at_ms IS NULL
      AND notifications.version = 1
      AND notifications.deduplication_key =
        'fad_setup_exemption_authorized:' ||
        NEW.league_id || ':' || NEW.season_id || ':' ||
        NEW.id || ':' || commissioner_membership.user_id
      AND json_valid(notifications.message_data_json) = 1
      AND json_type(
        notifications.message_data_json
      ) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(notifications.message_data_json)
      ) = 3
      AND json_extract(
        notifications.message_data_json,
        '$.leagueId'
      ) = NEW.league_id
      AND json_extract(
        notifications.message_data_json,
        '$.seasonId'
      ) = NEW.season_id
      AND json_extract(
        notifications.message_data_json,
        '$.exemptionId'
      ) = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption notification is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM outbox_events
    WHERE outbox_events.league_id = NEW.league_id
      AND outbox_events.id = NEW.outbox_event_id
      AND outbox_events.event_type = 'league.changed'
      AND outbox_events.aggregate_type = 'league'
      AND outbox_events.aggregate_id = NEW.league_id
      AND outbox_events.status = 'pending'
      AND outbox_events.attempt_count = 0
      AND outbox_events.available_at_ms = NEW.authorized_at_ms
      AND outbox_events.published_at_ms IS NULL
      AND outbox_events.last_error_code IS NULL
      AND outbox_events.created_at_ms = NEW.authorized_at_ms
      AND outbox_events.updated_at_ms = NEW.authorized_at_ms
      AND outbox_events.version = 1
      AND json_valid(outbox_events.payload_json) = 1
      AND json_type(outbox_events.payload_json) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(outbox_events.payload_json)
      ) = 5
      AND json_extract(
        outbox_events.payload_json,
        '$.kind'
      ) = 'invalidation'
      AND json_extract(
        outbox_events.payload_json,
        '$.eventType'
      ) = 'league.changed'
      AND json_extract(
        outbox_events.payload_json,
        '$.scope'
      ) = 'league'
      AND json_extract(
        outbox_events.payload_json,
        '$.scopeId'
      ) = NEW.league_id
      AND json_extract(
        outbox_events.payload_json,
        '$.changedAtMs'
      ) = NEW.authorized_at_ms
      AND (
        SELECT COUNT(*)
        FROM outbox_event_audiences
        WHERE outbox_event_audiences.league_id =
            NEW.league_id
          AND outbox_event_audiences.outbox_event_id =
            NEW.outbox_event_id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM outbox_event_audiences
        WHERE outbox_event_audiences.league_id =
            NEW.league_id
          AND outbox_event_audiences.outbox_event_id =
            NEW.outbox_event_id
          AND outbox_event_audiences.audience_kind =
            'league'
          AND outbox_event_audiences.created_at_ms =
            NEW.authorized_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption outbox evidence is inconsistent'
  ) END;
END;

CREATE TRIGGER fad_setup_exemptions_evidence_immutable_update
BEFORE UPDATE ON free_agent_draft_setup_exemptions
WHEN NOT (
  OLD.version = 1
  AND NEW.version = 2
  AND OLD.consumed_fad_id IS NULL
  AND OLD.consumed_at_ms IS NULL
  AND NEW.consumed_fad_id IS NOT NULL
  AND NEW.consumed_at_ms IS NOT NULL
  AND NEW.updated_at_ms = NEW.consumed_at_ms
  AND NEW.idempotency_request_id IS
    OLD.idempotency_request_id
  AND NEW.migration_report_sha256 IS
    OLD.migration_report_sha256
  AND NEW.bootstrap_identity_sha256 IS
    OLD.bootstrap_identity_sha256
  AND NEW.bootstrap_idempotency_request_id IS
    OLD.bootstrap_idempotency_request_id
  AND NEW.bootstrap_activity_id IS OLD.bootstrap_activity_id
  AND NEW.bootstrap_security_audit_event_id IS
    OLD.bootstrap_security_audit_event_id
  AND NEW.bootstrap_actor_user_id IS
    OLD.bootstrap_actor_user_id
  AND NEW.authorization_activity_id IS
    OLD.authorization_activity_id
  AND NEW.authorization_security_audit_event_id IS
    OLD.authorization_security_audit_event_id
  AND NEW.commissioner_notification_id IS
    OLD.commissioner_notification_id
  AND NEW.outbox_event_id IS OLD.outbox_event_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD setup exemption evidence is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_lifecycle_insert_0029
BEFORE INSERT ON idempotency_requests
WHEN NEW.operation = 'league.lifecycle.transition.v1'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.league_id IS NOT NULL
    AND NEW.request_hash = lower(NEW.request_hash)
    AND NEW.request_hash NOT GLOB '*[^0-9a-f]*'
    AND NEW.status = 'started'
    AND NEW.result_type IS NULL
    AND NEW.result_id IS NULL
    AND NEW.completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'lifecycle idempotency request must begin started'
  ) END;
END;

CREATE TRIGGER idempotency_requests_lifecycle_update_0029
BEFORE UPDATE ON idempotency_requests
WHEN OLD.operation = 'league.lifecycle.transition.v1'
  OR NEW.operation = 'league.lifecycle.transition.v1'
BEGIN
  SELECT CASE WHEN NOT (
    OLD.operation = 'league.lifecycle.transition.v1'
    AND OLD.status = 'started'
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
    AND NEW.completed_at_ms IS NOT NULL
    AND (
      (
        NEW.status = 'completed'
        AND NEW.result_type IN (
          'season_rollover',
          'free_agent_draft_setup_exemption'
        )
        AND NEW.result_id IS NOT NULL
      )
      OR
      (
        NEW.status = 'failed'
        AND NEW.result_type IS NULL
        AND NEW.result_id IS NULL
      )
    )
  ) THEN RAISE(
    ABORT,
    'lifecycle idempotency evidence is immutable'
  ) END;
END;

CREATE TRIGGER idempotency_requests_lifecycle_delete_0029
BEFORE DELETE ON idempotency_requests
WHEN OLD.operation = 'league.lifecycle.transition.v1'
  AND OLD.status = 'completed'
BEGIN
  SELECT RAISE(
    ABORT,
    'completed lifecycle idempotency evidence cannot be deleted'
  );
END;

CREATE TRIGGER idempotency_requests_lifecycle_complete_0029
BEFORE UPDATE OF status, result_type, result_id, completed_at_ms
  ON idempotency_requests
WHEN NEW.operation = 'league.lifecycle.transition.v1'
  AND NEW.status = 'completed'
BEGIN
  SELECT CASE WHEN NOT (
    (
      NEW.result_type = 'season_rollover'
      AND (
        SELECT COUNT(*)
        FROM season_rollovers
        WHERE season_rollovers.league_id = NEW.league_id
          AND season_rollovers.id = NEW.result_id
          AND season_rollovers.idempotency_request_id = NEW.id
          AND season_rollovers.authorized_by_user_id =
            NEW.actor_user_id
          AND season_rollovers.completed_at_ms =
            NEW.completed_at_ms
          AND season_rollovers.status = 'succeeded'
          AND season_rollovers.version = 1
          AND (
            SELECT COUNT(*)
            FROM season_rollover_items
            WHERE season_rollover_items.league_id =
                season_rollovers.league_id
              AND season_rollover_items.rollover_id =
                season_rollovers.id
          ) =
            season_rollovers.contracts_advanced +
            season_rollovers.contracts_expired +
            season_rollovers.ownerships_carried +
            season_rollovers.ownerships_released +
            season_rollovers.retention_years_advanced +
            season_rollovers.retention_obligations_completed +
            season_rollovers.buyout_years_advanced +
            season_rollovers.buyout_obligations_completed +
            season_rollovers.trades_cancelled
          AND NOT EXISTS (
            SELECT 1
            FROM season_rollover_items
            WHERE season_rollover_items.league_id =
                season_rollovers.league_id
              AND season_rollover_items.rollover_id =
                season_rollovers.id
              AND season_rollover_items.idempotency_request_id <>
                NEW.id
          )
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM free_agent_draft_setup_exemptions
        WHERE free_agent_draft_setup_exemptions
          .idempotency_request_id = NEW.id
      )
    )
    OR
    (
      NEW.result_type =
        'free_agent_draft_setup_exemption'
      AND (
        SELECT COUNT(*)
        FROM free_agent_draft_setup_exemptions
        WHERE free_agent_draft_setup_exemptions.league_id =
            NEW.league_id
          AND free_agent_draft_setup_exemptions.id =
            NEW.result_id
          AND free_agent_draft_setup_exemptions
            .idempotency_request_id = NEW.id
          AND free_agent_draft_setup_exemptions
            .authorized_by_user_id = NEW.actor_user_id
          AND free_agent_draft_setup_exemptions
            .authorized_at_ms = NEW.completed_at_ms
          AND free_agent_draft_setup_exemptions.version = 1
          AND free_agent_draft_setup_exemptions
            .consumed_fad_id IS NULL
          AND free_agent_draft_setup_exemptions
            .consumed_at_ms IS NULL
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM season_rollovers
        WHERE season_rollovers.idempotency_request_id = NEW.id
      )
    )
  ) THEN RAISE(
    ABORT,
    'lifecycle idempotency completion is inconsistent'
  ) END;
END;

CREATE TRIGGER contract_events_rollover_evidence_update_0029
BEFORE UPDATE ON contract_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.contract_event_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced rollover contract event is immutable'
  );
END;

CREATE TRIGGER contract_events_rollover_evidence_delete_0029
BEFORE DELETE ON contract_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.contract_event_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced rollover contract event is immutable'
  );
END;

CREATE TRIGGER contract_events_rollover_late_insert_0029
BEFORE INSERT ON contract_events
WHEN NEW.source_type = 'season_rollover'
  AND EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.league_id = NEW.league_id
      AND season_rollovers.id = NEW.source_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'rollover contract events must precede the rollover root'
  );
END;

CREATE TRIGGER ownership_events_rollover_evidence_update_0029
BEFORE UPDATE ON ownership_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.ownership_event_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced rollover ownership event is immutable'
  );
END;

CREATE TRIGGER ownership_events_rollover_evidence_delete_0029
BEFORE DELETE ON ownership_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.ownership_event_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced rollover ownership event is immutable'
  );
END;

CREATE TRIGGER ownership_events_rollover_late_insert_0029
BEFORE INSERT ON ownership_events
WHEN NEW.source_type = 'season_rollover'
  AND EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.league_id = NEW.league_id
      AND season_rollovers.id = NEW.source_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'rollover ownership events must precede the rollover root'
  );
END;

CREATE TRIGGER trade_events_rollover_evidence_update_0029
BEFORE UPDATE ON trade_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.trade_event_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced rollover trade event is immutable'
  );
END;

CREATE TRIGGER trade_events_rollover_evidence_delete_0029
BEFORE DELETE ON trade_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.trade_event_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced rollover trade event is immutable'
  );
END;

CREATE TRIGGER trade_events_rollover_late_insert_0029
BEFORE INSERT ON trade_events
WHEN NEW.event_type = 'proposal_auto_cancelled'
  AND NEW.reason = 'asset_expired_during_season_rollover'
  AND json_valid(NEW.metadata_json) = 1
  AND EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.league_id = NEW.league_id
      AND season_rollovers.id = json_extract(
        NEW.metadata_json,
        '$.rolloverId'
      )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'rollover trade events must precede the rollover root'
  );
END;

CREATE TRIGGER league_activity_lifecycle_evidence_update_0029
BEFORE UPDATE ON league_activity
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.league_activity_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = OLD.league_id
    AND season_rollovers.aggregate_activity_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND (
      free_agent_draft_setup_exemptions
        .bootstrap_activity_id = OLD.id
      OR free_agent_draft_setup_exemptions
        .authorization_activity_id = OLD.id
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced lifecycle activity is immutable'
  );
END;

CREATE TRIGGER league_activity_lifecycle_evidence_delete_0029
BEFORE DELETE ON league_activity
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.league_activity_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = OLD.league_id
    AND season_rollovers.aggregate_activity_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND (
      free_agent_draft_setup_exemptions
        .bootstrap_activity_id = OLD.id
      OR free_agent_draft_setup_exemptions
        .authorization_activity_id = OLD.id
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced lifecycle activity is immutable'
  );
END;

CREATE TRIGGER league_activity_lifecycle_late_insert_0029
BEFORE INSERT ON league_activity
WHEN (
  json_valid(NEW.metadata_json) = 1
  AND EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.league_id = NEW.league_id
      AND season_rollovers.id = json_extract(
        NEW.metadata_json,
        '$.rolloverId'
      )
  )
)
OR (
  json_valid(NEW.metadata_json) = 1
  AND NEW.event_type = 'fad_setup_exemption_authorized'
  AND EXISTS (
    SELECT 1
    FROM free_agent_draft_setup_exemptions
    WHERE free_agent_draft_setup_exemptions.league_id =
        NEW.league_id
      AND free_agent_draft_setup_exemptions.id =
        json_extract(NEW.metadata_json, '$.exemptionId')
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'lifecycle activity must precede its resource root'
  );
END;

CREATE TRIGGER security_audit_events_lifecycle_evidence_update_0029
BEFORE UPDATE ON security_audit_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = OLD.league_id
    AND season_rollovers.security_audit_event_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND (
      free_agent_draft_setup_exemptions
        .bootstrap_security_audit_event_id = OLD.id
      OR free_agent_draft_setup_exemptions
        .authorization_security_audit_event_id = OLD.id
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced lifecycle security audit is immutable'
  );
END;

CREATE TRIGGER security_audit_events_lifecycle_evidence_delete_0029
BEFORE DELETE ON security_audit_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = OLD.league_id
    AND season_rollovers.security_audit_event_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND (
      free_agent_draft_setup_exemptions
        .bootstrap_security_audit_event_id = OLD.id
      OR free_agent_draft_setup_exemptions
        .authorization_security_audit_event_id = OLD.id
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced lifecycle security audit is immutable'
  );
END;

CREATE TRIGGER security_audit_events_lifecycle_late_insert_0029
BEFORE INSERT ON security_audit_events
WHEN (
  NEW.event_type = 'league.season_rolled_over'
  AND EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.league_id = NEW.league_id
      AND season_rollovers.authorized_by_user_id =
        NEW.actor_user_id
      AND season_rollovers.completed_at_ms =
        NEW.occurred_at_ms
  )
)
OR (
  NEW.event_type = 'fad.setup_exemption_authorized'
  AND EXISTS (
    SELECT 1
    FROM free_agent_draft_setup_exemptions
    WHERE free_agent_draft_setup_exemptions.league_id =
        NEW.league_id
      AND free_agent_draft_setup_exemptions
        .authorized_by_user_id = NEW.actor_user_id
      AND free_agent_draft_setup_exemptions
        .authorized_at_ms = NEW.occurred_at_ms
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'lifecycle security audit must precede its resource root'
  );
END;

CREATE TRIGGER migration_reports_exemption_evidence_update_0029
BEFORE UPDATE ON migration_reports
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions.migration_report_id =
      OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced exemption migration report is immutable'
  );
END;

CREATE TRIGGER migration_reports_exemption_evidence_delete_0029
BEFORE DELETE ON migration_reports
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions.migration_report_id =
      OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced exemption migration report is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_exemption_bootstrap_update_0029
BEFORE UPDATE ON idempotency_requests
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions
      .bootstrap_idempotency_request_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced exemption bootstrap request is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_exemption_bootstrap_delete_0029
BEFORE DELETE ON idempotency_requests
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions
      .bootstrap_idempotency_request_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced exemption bootstrap request is immutable'
  );
END;

CREATE TRIGGER trade_assets_rollover_evidence_insert_0029
BEFORE INSERT ON trade_assets
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = NEW.league_id
    AND season_rollover_items.entity_id = NEW.trade_id
    AND season_rollover_items.effect_kind = 'trade_cancelled'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'rollover-cancelled trade assets are immutable'
  );
END;

CREATE TRIGGER trade_assets_rollover_evidence_update_0029
BEFORE UPDATE ON trade_assets
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.entity_id = OLD.trade_id
    AND season_rollover_items.effect_kind = 'trade_cancelled'
)
OR EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = NEW.league_id
    AND season_rollover_items.entity_id = NEW.trade_id
    AND season_rollover_items.effect_kind = 'trade_cancelled'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'rollover-cancelled trade assets are immutable'
  );
END;

CREATE TRIGGER trade_assets_rollover_evidence_delete_0029
BEFORE DELETE ON trade_assets
WHEN EXISTS (
  SELECT 1
  FROM season_rollover_items
  WHERE season_rollover_items.league_id = OLD.league_id
    AND season_rollover_items.entity_id = OLD.trade_id
    AND season_rollover_items.effect_kind = 'trade_cancelled'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'rollover-cancelled trade assets are immutable'
  );
END;

CREATE TRIGGER outbox_events_lifecycle_evidence_update_0029
BEFORE UPDATE ON outbox_events
WHEN (
  EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.league_id = OLD.league_id
      AND season_rollovers.outbox_event_id = OLD.id
  )
  OR EXISTS (
    SELECT 1
    FROM free_agent_draft_setup_exemptions
    WHERE free_agent_draft_setup_exemptions.league_id =
        OLD.league_id
      AND free_agent_draft_setup_exemptions.outbox_event_id =
        OLD.id
  )
)
AND (
  NEW.id IS NOT OLD.id
  OR NEW.league_id IS NOT OLD.league_id
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.aggregate_type IS NOT OLD.aggregate_type
  OR NEW.aggregate_id IS NOT OLD.aggregate_id
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced lifecycle outbox content is immutable'
  );
END;

CREATE TRIGGER outbox_events_lifecycle_evidence_delete_0029
BEFORE DELETE ON outbox_events
WHEN EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = OLD.league_id
    AND season_rollovers.outbox_event_id = OLD.id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions.outbox_event_id =
      OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced lifecycle outbox cannot be deleted'
  );
END;

CREATE TRIGGER outbox_events_lifecycle_late_insert_0029
BEFORE INSERT ON outbox_events
WHEN NEW.event_type = 'league.changed'
  AND NEW.aggregate_type = 'league'
  AND (
    EXISTS (
      SELECT 1
      FROM season_rollovers
      WHERE season_rollovers.league_id = NEW.league_id
        AND season_rollovers.completed_at_ms =
          NEW.created_at_ms
    )
    OR EXISTS (
      SELECT 1
      FROM free_agent_draft_setup_exemptions
      WHERE free_agent_draft_setup_exemptions.league_id =
          NEW.league_id
        AND free_agent_draft_setup_exemptions.authorized_at_ms =
          NEW.created_at_ms
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'lifecycle outbox must precede its resource root'
  );
END;

CREATE TRIGGER outbox_event_audiences_lifecycle_insert_0029
BEFORE INSERT ON outbox_event_audiences
WHEN EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = NEW.league_id
    AND season_rollovers.outbox_event_id =
      NEW.outbox_event_id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      NEW.league_id
    AND free_agent_draft_setup_exemptions.outbox_event_id =
      NEW.outbox_event_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'lifecycle outbox audiences are immutable'
  );
END;

CREATE TRIGGER outbox_event_audiences_lifecycle_update_0029
BEFORE UPDATE ON outbox_event_audiences
WHEN EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = OLD.league_id
    AND season_rollovers.outbox_event_id =
      OLD.outbox_event_id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions.outbox_event_id =
      OLD.outbox_event_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'lifecycle outbox audiences are immutable'
  );
END;

CREATE TRIGGER outbox_event_audiences_lifecycle_delete_0029
BEFORE DELETE ON outbox_event_audiences
WHEN EXISTS (
  SELECT 1
  FROM season_rollovers
  WHERE season_rollovers.league_id = OLD.league_id
    AND season_rollovers.outbox_event_id =
      OLD.outbox_event_id
)
OR EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions.outbox_event_id =
      OLD.outbox_event_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'lifecycle outbox audiences are immutable'
  );
END;

CREATE TRIGGER notifications_exemption_evidence_update_0029
BEFORE UPDATE ON notifications
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions
      .commissioner_notification_id = OLD.id
)
AND (
  NEW.id IS NOT OLD.id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.league_id IS NOT OLD.league_id
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.message_data_json IS NOT OLD.message_data_json
  OR NEW.related_feature IS NOT OLD.related_feature
  OR NEW.related_record_id IS NOT OLD.related_record_id
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR NEW.deduplication_key IS NOT OLD.deduplication_key
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced exemption notification content is immutable'
  );
END;

CREATE TRIGGER notifications_exemption_evidence_delete_0029
BEFORE DELETE ON notifications
WHEN EXISTS (
  SELECT 1
  FROM free_agent_draft_setup_exemptions
  WHERE free_agent_draft_setup_exemptions.league_id =
      OLD.league_id
    AND free_agent_draft_setup_exemptions
      .commissioner_notification_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'referenced exemption notification cannot be deleted'
  );
END;

CREATE TRIGGER notifications_exemption_late_insert_0029
BEFORE INSERT ON notifications
WHEN NEW.event_type = 'fad_setup_exemption_authorized'
  AND NEW.related_feature = 'free_agent_draft_setup'
  AND EXISTS (
    SELECT 1
    FROM free_agent_draft_setup_exemptions
    WHERE free_agent_draft_setup_exemptions.league_id =
        NEW.league_id
      AND free_agent_draft_setup_exemptions.id =
        NEW.related_record_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'exemption notification must precede its resource root'
  );
END;

UPDATE application_metadata
SET metadata_value = '29',
    updated_at_ms =
      CASE WHEN updated_at_ms < 29 THEN 29 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
