-- Hundo Leago SQLite schema migration 25 -> 26.
--
-- This migration adds the server-owned auction provenance required by the
-- Free Agent Draft (FAD), the immutable restricted-auction allowlist and seed
-- evidence, and the commit/reveal draw record. It is additive: the existing
-- auction tables retain their physical contracts.

-- Schema 25 did not distinguish FAD auctions from ordinary auctions. If any
-- existing row already points at an auction through FAD-only state, treating
-- that auction as ordinary would destroy provenance. Abort the migration
-- atomically instead of guessing.
CREATE TABLE migration_0026_fad_provenance_guard (
  must_be_zero INTEGER NOT NULL CHECK (must_be_zero = 0)
) STRICT;

INSERT INTO migration_0026_fad_provenance_guard (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM free_agent_draft_player_allocations
  WHERE restricted_auction_id IS NOT NULL

  UNION ALL

  SELECT 1
  FROM free_agent_draft_allocation_events
  WHERE auction_id IS NOT NULL

  UNION ALL

  SELECT 1
  FROM free_agent_draft_recoveries
  WHERE auction_id IS NOT NULL
);

DROP TABLE migration_0026_fad_provenance_guard;

CREATE TABLE auction_contexts (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (
      source_kind IN (
        'ordinary_weekly',
        'fad_open_rapid',
        'fad_restricted'
      )
    ),
  fad_id TEXT,
  fad_rollover_id TEXT,
  fad_allocation_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (league_id, id),
  UNIQUE (league_id, auction_id),
  UNIQUE (league_id, season_id, auction_id),
  FOREIGN KEY (league_id, season_id)
    REFERENCES seasons(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, auction_id)
    REFERENCES auctions(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, season_id, fad_id)
    REFERENCES free_agent_drafts(league_id, season_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    fad_rollover_id
  ) REFERENCES free_agent_draft_rollovers(
    league_id,
    season_id,
    fad_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    fad_allocation_id
  ) REFERENCES free_agent_draft_player_allocations(
    league_id,
    season_id,
    fad_id,
    id
  ) ON DELETE RESTRICT,
  CHECK (
    id = auction_id
  ),
  CHECK (
    (fad_id IS NULL)
    OR (length(fad_id) = 36 AND fad_id = lower(fad_id))
  ),
  CHECK (
    (fad_rollover_id IS NULL)
    OR (
      length(fad_rollover_id) = 36
      AND fad_rollover_id = lower(fad_rollover_id)
    )
  ),
  CHECK (
    (fad_allocation_id IS NULL)
    OR (
      length(fad_allocation_id) = 36
      AND fad_allocation_id = lower(fad_allocation_id)
    )
  ),
  CHECK (
    (
      source_kind = 'ordinary_weekly'
      AND fad_id IS NULL
      AND fad_rollover_id IS NULL
      AND fad_allocation_id IS NULL
    )
    OR (
      source_kind = 'fad_open_rapid'
      AND fad_id IS NOT NULL
      AND fad_rollover_id IS NOT NULL
      AND fad_allocation_id IS NULL
    )
    OR (
      source_kind = 'fad_restricted'
      AND fad_id IS NOT NULL
      AND fad_allocation_id IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX auction_contexts_league_source_time
  ON auction_contexts (
    league_id,
    source_kind,
    created_at_ms,
    auction_id
  );

CREATE INDEX auction_contexts_league_fad
  ON auction_contexts (
    league_id,
    season_id,
    fad_id,
    source_kind,
    auction_id
  )
  WHERE fad_id IS NOT NULL;

CREATE INDEX auction_contexts_league_rollover
  ON auction_contexts (
    league_id,
    season_id,
    fad_rollover_id,
    auction_id
  )
  WHERE fad_rollover_id IS NOT NULL;

CREATE UNIQUE INDEX auction_contexts_one_restricted_allocation
  ON auction_contexts (
    league_id,
    season_id,
    fad_id,
    fad_allocation_id
  )
  WHERE source_kind = 'fad_restricted';

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
  seeded_bid_id TEXT NOT NULL,
  seed_event_id TEXT NOT NULL,
  original_total_value_cents INTEGER NOT NULL
    CHECK (original_total_value_cents > 0),
  original_term_years INTEGER NOT NULL
    CHECK (original_term_years BETWEEN 1 AND 3),
  original_aav_cents INTEGER NOT NULL
    CHECK (original_aav_cents >= 100),
  cooldown_anchor_at_ms INTEGER NOT NULL
    CHECK (cooldown_anchor_at_ms >= 0),
  manager_edit_limit INTEGER NOT NULL
    CHECK (manager_edit_limit = 1),
  minimum_final_total_cents INTEGER NOT NULL
    CHECK (minimum_final_total_cents > 0),
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
    CHECK (
      removed_at_ms IS NULL
      OR removed_at_ms >= created_at_ms
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, source_snapshot_entry_id),
  UNIQUE (league_id, seeded_bid_id),
  UNIQUE (league_id, seed_event_id),
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
  FOREIGN KEY (league_id, seeded_bid_id)
    REFERENCES auction_bids(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, seed_event_id)
    REFERENCES auction_events(league_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (league_id, originating_actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, removed_by_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  CHECK (
    original_aav_cents =
      (original_total_value_cents / original_term_years)
      + CASE
          WHEN
            (original_total_value_cents % original_term_years) * 2
              >= original_term_years
          THEN 1
          ELSE 0
        END
  ),
  CHECK (
    original_term_years = 1
    OR original_total_value_cents % 100 = 0
  ),
  CHECK (minimum_final_total_cents = original_total_value_cents),
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
      AND removed_by_user_id IS NOT NULL
      AND removed_by_membership_id IS NOT NULL
      AND removed_authority IS NOT NULL
      AND removed_at_ms IS NOT NULL
      AND updated_at_ms = removed_at_ms
    )
  )
) STRICT;

CREATE INDEX fad_auction_participants_league_auction_status
  ON free_agent_draft_auction_participants (
    league_id,
    auction_id,
    status,
    team_id
  );

CREATE INDEX fad_auction_participants_league_allocation_status
  ON free_agent_draft_auction_participants (
    league_id,
    allocation_id,
    status,
    team_id
  );

-- This is the one resolution-time eligibility predicate for restricted
-- seeds. It mirrors the ordinary resolver's bid checks while treating the
-- immutable Candidate-derived system seed as the starting bid.
CREATE VIEW fad_restricted_eligible_bids AS
SELECT
  participant.league_id,
  participant.season_id,
  participant.fad_id,
  participant.allocation_id,
  participant.auction_id,
  participant.id AS participant_id,
  participant.team_id,
  participant.seeded_bid_id AS bid_id,
  bid.status AS bid_status,
  bid.total_value_cents,
  bid.term_years,
  bid.lowest_offered_aav_cents,
  (bid.total_value_cents / bid.term_years)
    + CASE
        WHEN
          (bid.total_value_cents % bid.term_years) * 2
            >= bid.term_years
        THEN 1
        ELSE 0
      END AS aav_cents,
  bid.first_submitted_at_ms
FROM free_agent_draft_auction_participants AS participant
JOIN auction_bids AS bid
  ON bid.league_id = participant.league_id
 AND bid.season_id = participant.season_id
 AND bid.auction_id = participant.auction_id
 AND bid.team_id = participant.team_id
 AND bid.id = participant.seeded_bid_id
JOIN teams
  ON teams.league_id = participant.league_id
 AND teams.id = participant.team_id
 AND teams.status = 'active'
JOIN candidate_card_snapshot_entries AS source_offer
  ON source_offer.league_id = participant.league_id
 AND source_offer.season_id = participant.season_id
 AND source_offer.fad_id = participant.fad_id
 AND source_offer.id = participant.source_snapshot_entry_id
 AND source_offer.team_id = participant.team_id
 AND source_offer.row_kind = 'slot'
 AND source_offer.occupant_kind = 'candidate'
 AND source_offer.eligibility_status IN ('valid', 'warning')
JOIN candidate_card_revisions AS source_revision
  ON source_revision.league_id = participant.league_id
 AND source_revision.season_id = participant.season_id
 AND source_revision.fad_id = participant.fad_id
 AND source_revision.id =
      participant.originating_candidate_revision_id
 AND source_revision.actor_user_id =
      participant.originating_actor_user_id
 AND source_revision.actor_membership_id =
      participant.originating_actor_membership_id
 AND source_revision.actor_authority =
      participant.originating_actor_authority
JOIN auction_events AS seed_event
  ON seed_event.league_id = participant.league_id
 AND seed_event.season_id = participant.season_id
 AND seed_event.auction_id = participant.auction_id
 AND seed_event.id = participant.seed_event_id
 AND seed_event.bid_id = participant.seeded_bid_id
 AND seed_event.team_id = participant.team_id
 AND seed_event.actor_user_id IS NULL
 AND seed_event.event_type = 'fad_restricted_seed_created'
 AND seed_event.occurred_at_ms = bid.first_submitted_at_ms
WHERE participant.status = 'active'
  AND bid.submitted_by_user_id =
    participant.originating_actor_user_id
  AND bid.total_value_cents >= bid.term_years * 100
  AND (
    bid.term_years = 1
    OR bid.total_value_cents % 100 = 0
  )
  AND bid.total_value_cents >=
    participant.minimum_final_total_cents
  AND bid.lowest_offered_aav_cents <=
    (bid.total_value_cents / bid.term_years)
    + CASE
        WHEN
          (bid.total_value_cents % bid.term_years) * 2
            >= bid.term_years
        THEN 1
        ELSE 0
      END;

CREATE TABLE free_agent_draft_draws (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version = 1),
  nonce_bytes BLOB NOT NULL
    CHECK (typeof(nonce_bytes) = 'blob' AND length(nonce_bytes) = 32),
  commitment_hex TEXT NOT NULL
    CHECK (
      length(commitment_hex) = 64
      AND commitment_hex = lower(commitment_hex)
      AND commitment_hex NOT GLOB '*[^0-9a-f]*'
    ),
  ordered_tied_bid_ids_json TEXT
    CHECK (
      ordered_tied_bid_ids_json IS NULL
      OR (
        length(ordered_tied_bid_ids_json) BETWEEN 2 AND 4194304
        AND json_valid(ordered_tied_bid_ids_json) = 1
        AND json_type(ordered_tied_bid_ids_json) = 'array'
      )
    ),
  ordered_tied_team_ids_json TEXT
    CHECK (
      ordered_tied_team_ids_json IS NULL
      OR (
        length(ordered_tied_team_ids_json) BETWEEN 2 AND 4194304
        AND json_valid(ordered_tied_team_ids_json) = 1
        AND json_type(ordered_tied_team_ids_json) = 'array'
      )
    ),
  rejection_counter INTEGER
    CHECK (
      rejection_counter IS NULL
      OR rejection_counter BETWEEN 0 AND 4294967295
    ),
  selected_index INTEGER
    CHECK (selected_index IS NULL OR selected_index >= 0),
  selected_bid_id TEXT,
  selected_team_id TEXT,
  selected_digest_hex TEXT
    CHECK (
      selected_digest_hex IS NULL
      OR (
        length(selected_digest_hex) = 64
        AND selected_digest_hex = lower(selected_digest_hex)
        AND selected_digest_hex NOT GLOB '*[^0-9a-f]*'
      )
    ),
  revealed_at_ms INTEGER
    CHECK (
      revealed_at_ms IS NULL
      OR revealed_at_ms >= created_at_ms
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, auction_id),
  UNIQUE (league_id, allocation_id),
  UNIQUE (league_id, commitment_hex),
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
  FOREIGN KEY (league_id, selected_bid_id)
    REFERENCES auction_bids(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, selected_team_id)
    REFERENCES teams(league_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      revealed_at_ms IS NULL
      AND ordered_tied_bid_ids_json IS NULL
      AND ordered_tied_team_ids_json IS NULL
      AND rejection_counter IS NULL
      AND selected_index IS NULL
      AND selected_bid_id IS NULL
      AND selected_team_id IS NULL
      AND selected_digest_hex IS NULL
    )
    OR (
      revealed_at_ms IS NOT NULL
      AND updated_at_ms = revealed_at_ms
      AND ordered_tied_bid_ids_json IS NOT NULL
      AND ordered_tied_team_ids_json IS NOT NULL
      AND json_array_length(ordered_tied_bid_ids_json) =
        json_array_length(ordered_tied_team_ids_json)
      AND (
        (
          ordered_tied_bid_ids_json = '[]'
          AND ordered_tied_team_ids_json = '[]'
          AND rejection_counter IS NULL
          AND selected_index IS NULL
          AND selected_bid_id IS NULL
          AND selected_team_id IS NULL
          AND selected_digest_hex IS NULL
        )
        OR (
          json_array_length(ordered_tied_bid_ids_json) >= 2
          AND rejection_counter IS NOT NULL
          AND selected_index IS NOT NULL
          AND selected_index <
            json_array_length(ordered_tied_bid_ids_json)
          AND selected_bid_id IS NOT NULL
          AND selected_team_id IS NOT NULL
          AND selected_digest_hex IS NOT NULL
        )
      )
    )
  )
) STRICT;

CREATE INDEX free_agent_draft_draws_league_fad_reveal
  ON free_agent_draft_draws (
    league_id,
    fad_id,
    revealed_at_ms,
    auction_id
  );

-- Auction context is immutable, exact, and tied to the physical auction row.
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

CREATE TRIGGER auction_contexts_immutable_update
BEFORE UPDATE ON auction_contexts
BEGIN
  SELECT RAISE(ABORT, 'auction context is immutable');
END;

CREATE TRIGGER auction_contexts_immutable_delete
BEFORE DELETE ON auction_contexts
BEGIN
  SELECT RAISE(ABORT, 'auction context is immutable');
END;

-- The guarded schema-25 population is known not to contain FAD auctions, so
-- every pre-existing auction receives deterministic ordinary provenance.
INSERT INTO auction_contexts (
  id,
  league_id,
  season_id,
  auction_id,
  source_kind,
  fad_id,
  fad_rollover_id,
  fad_allocation_id,
  created_at_ms
)
SELECT
  auctions.id,
  auctions.league_id,
  auctions.season_id,
  auctions.id,
  'ordinary_weekly',
  NULL,
  NULL,
  NULL,
  auctions.created_at_ms
FROM auctions;

-- A newly inserted auction may exist transiently while its context is written
-- in the same transaction. No bid, event, resolution, recovery link, or
-- physical mutation may use it until the sidecar exists.
CREATE TRIGGER auction_bids_require_context_insert
BEFORE INSERT ON auction_bids
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
  ) THEN RAISE(
    ABORT,
    'auction bid requires auction context'
  ) END;
END;

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
    'auction event requires auction context'
  ) END;
END;

CREATE UNIQUE INDEX auction_events_one_fad_resolution_failure
  ON auction_events (league_id, auction_id, event_type)
  WHERE event_type = 'fad_auction_resolution_failed';

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

CREATE TRIGGER auctions_require_context_update
BEFORE UPDATE ON auctions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
  ) THEN RAISE(
    ABORT,
    'auction mutation requires auction context'
  ) END;

  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.opened_at_ms IS OLD.opened_at_ms
    AND NEW.resolves_at_ms IS OLD.resolves_at_ms
    AND NEW.opened_by_user_id IS OLD.opened_by_user_id
    AND NEW.created_at_ms IS OLD.created_at_ms
  ) THEN RAISE(
    ABORT,
    'auction provenance inputs are immutable after context creation'
  ) END;

  SELECT CASE WHEN
    OLD.status = 'failed'
    AND NEW.status = 'failed'
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
    AND NOT (
      NEW.status IS OLD.status
      AND NEW.updated_at_ms IS OLD.updated_at_ms
      AND NEW.version IS OLD.version
    )
  THEN RAISE(
    ABORT,
    'failed FAD auction evidence is frozen until approved recovery'
  ) END;

  SELECT CASE WHEN
    OLD.status IN ('open', 'resolving')
    AND NEW.status IN ('resolved', 'no_winner', 'cancelled', 'failed')
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      JOIN free_agent_draft_auction_participants
        ON free_agent_draft_auction_participants.league_id =
            auction_contexts.league_id
       AND free_agent_draft_auction_participants.season_id =
            auction_contexts.season_id
       AND free_agent_draft_auction_participants.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_auction_participants.allocation_id =
            auction_contexts.fad_allocation_id
       AND free_agent_draft_auction_participants.auction_id =
            auction_contexts.auction_id
      JOIN auction_bids
        ON auction_bids.league_id =
            free_agent_draft_auction_participants.league_id
       AND auction_bids.auction_id =
            free_agent_draft_auction_participants.auction_id
       AND auction_bids.team_id =
            free_agent_draft_auction_participants.team_id
       AND auction_bids.id =
            free_agent_draft_auction_participants.seeded_bid_id
      WHERE auction_contexts.league_id = OLD.league_id
        AND auction_contexts.season_id = OLD.season_id
        AND auction_contexts.auction_id = OLD.id
        AND auction_contexts.source_kind = 'fad_restricted'
        AND (
          (
            free_agent_draft_auction_participants.status = 'active'
            AND auction_bids.status <> 'active'
          )
          OR (
            free_agent_draft_auction_participants.status = 'removed'
            AND auction_bids.status <> 'withdrawn'
          )
        )
    )
  THEN RAISE(
    ABORT,
    'restricted terminal transition requires its exact frozen bid set'
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

CREATE TRIGGER fad_recoveries_auction_context_insert
BEFORE INSERT ON free_agent_draft_recoveries
WHEN NEW.auction_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.auction_id
      AND auction_contexts.fad_id = NEW.fad_id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
      AND (
        (
          auction_contexts.source_kind = 'fad_open_rapid'
          AND NEW.allocation_id IS NULL
        )
        OR (
          auction_contexts.source_kind = 'fad_restricted'
          AND NEW.allocation_id =
            auction_contexts.fad_allocation_id
        )
      )
      AND (
        NEW.rollover_id IS NULL
        OR NEW.rollover_id = auction_contexts.fad_rollover_id
      )
  ) THEN RAISE(
    ABORT,
    'FAD auction recovery requires matching auction context'
  ) END;
END;

CREATE TRIGGER fad_auction_failure_recovery_error_immutable_update
BEFORE UPDATE OF last_error_code ON free_agent_draft_recoveries
WHEN OLD.kind = 'auction_resolution'
  AND EXISTS (
    SELECT 1
    FROM auction_events
    WHERE auction_events.league_id = OLD.league_id
      AND auction_events.auction_id = OLD.auction_id
      AND auction_events.event_type =
        'fad_auction_resolution_failed'
      AND json_extract(
        auction_events.metadata_json,
        '$.recoveryId'
      ) = OLD.id
  )
  AND NEW.last_error_code IS NOT OLD.last_error_code
BEGIN
  SELECT RAISE(
    ABORT,
    'FAD failure recovery preserves its original causal error'
  );
END;

-- A failed open rapid recovery has no allocation row to provide a terminal
-- barrier. Require its immutable semantic result and complete causal chain
-- before allowing the recovery to resolve.
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

-- A restricted T-082 cancellation records its immutable failed result at the
-- cancellation instant, but the linked recovery remains quarantined until a
-- later indexed commissioner correction is applied. The recovery may resolve
-- only at that correction instant and only after its exact allocation event.
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

-- A restricted participant is a frozen copy of one exact top Candidate offer
-- and its latest accepted human-authored revision.
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

CREATE TRIGGER fad_auction_participants_immutable_delete
BEFORE DELETE ON free_agent_draft_auction_participants
BEGIN
  SELECT RAISE(ABORT, 'restricted participant evidence is permanent');
END;

-- Restricted auctions have exactly the seed bid recorded by each participant;
-- a removed or absent team can never recreate a bid.
CREATE TRIGGER fad_restricted_bids_seed_insert
BEFORE INSERT ON auction_bids
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = NEW.league_id
    AND auction_contexts.season_id = NEW.season_id
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
     AND auctions.season_id =
          free_agent_draft_auction_participants.season_id
     AND auctions.id =
          free_agent_draft_auction_participants.auction_id
    WHERE free_agent_draft_auction_participants.league_id =
        NEW.league_id
      AND free_agent_draft_auction_participants.season_id =
        NEW.season_id
      AND free_agent_draft_auction_participants.auction_id =
        NEW.auction_id
      AND free_agent_draft_auction_participants.team_id =
        NEW.team_id
      AND free_agent_draft_auction_participants.status = 'active'
      AND free_agent_draft_auction_participants.seeded_bid_id = NEW.id
      AND free_agent_draft_auction_participants
        .originating_actor_user_id = NEW.submitted_by_user_id
      AND free_agent_draft_auction_participants
        .original_total_value_cents = NEW.total_value_cents
      AND free_agent_draft_auction_participants
        .original_term_years = NEW.term_years
      AND free_agent_draft_auction_participants.original_aav_cents =
        NEW.lowest_offered_aav_cents
      AND NEW.first_submitted_at_ms = auctions.opened_at_ms
      AND NEW.last_edited_at_ms = auctions.opened_at_ms
      AND NEW.edit_count = 0
      AND NEW.status = 'active'
      AND NEW.version = 1
  ) THEN RAISE(
    ABORT,
    'restricted auction bid must be its exact system seed'
  ) END;
END;

CREATE TRIGGER fad_restricted_seed_events_insert
BEFORE INSERT ON auction_events
WHEN NEW.event_type = 'fad_restricted_seed_created'
   OR EXISTS (
     SELECT 1
     FROM auction_contexts
     WHERE auction_contexts.league_id = NEW.league_id
       AND auction_contexts.season_id = NEW.season_id
       AND auction_contexts.auction_id = NEW.auction_id
       AND auction_contexts.source_kind = 'fad_restricted'
   )
BEGIN
  SELECT CASE WHEN
    NEW.event_type = 'fad_restricted_seed_created'
    AND NOT EXISTS (
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
       AND auction_contexts.auction_id =
            free_agent_draft_auction_participants.auction_id
      WHERE free_agent_draft_auction_participants.league_id =
          NEW.league_id
        AND free_agent_draft_auction_participants.season_id =
          NEW.season_id
        AND free_agent_draft_auction_participants.auction_id =
          NEW.auction_id
        AND free_agent_draft_auction_participants.seed_event_id =
          NEW.id
        AND free_agent_draft_auction_participants.seeded_bid_id =
          NEW.bid_id
        AND free_agent_draft_auction_participants.team_id =
          NEW.team_id
        AND free_agent_draft_auction_participants.status = 'active'
        AND NEW.actor_user_id IS NULL
        AND NEW.occurred_at_ms = auctions.opened_at_ms
        AND auction_contexts.source_kind = 'fad_restricted'
    )
  THEN RAISE(
    ABORT,
    'restricted seed event must identify the exact system seed'
  ) END;

  SELECT CASE WHEN
    NEW.event_type <> 'fad_restricted_seed_created'
    AND EXISTS (
      SELECT 1
      FROM free_agent_draft_auction_participants
      WHERE free_agent_draft_auction_participants.league_id =
          NEW.league_id
        AND free_agent_draft_auction_participants.seed_event_id =
          NEW.id
    )
  THEN RAISE(
    ABORT,
    'restricted participant seed event type is reserved'
  ) END;

  SELECT CASE WHEN
    NEW.event_type = 'fad_restricted_seed_created'
    AND NOT EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.auction_id
        AND auction_contexts.source_kind = 'fad_restricted'
    )
  THEN RAISE(
    ABORT,
    'restricted seed event is invalid outside restricted context'
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

CREATE TRIGGER fad_restricted_bids_immutable_delete
BEFORE DELETE ON auction_bids
WHEN EXISTS (
  SELECT 1
  FROM auction_contexts
  WHERE auction_contexts.league_id = OLD.league_id
    AND auction_contexts.auction_id = OLD.auction_id
    AND auction_contexts.source_kind = 'fad_restricted'
)
BEGIN
  SELECT RAISE(ABORT, 'restricted bid history is permanent');
END;

-- The private nonce and commitment are fixed before activation. Reveal is the
-- only permitted update and is optimistic, canonical, and terminally useful.
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

CREATE TRIGGER free_agent_draft_draws_reveal_update
BEFORE UPDATE ON free_agent_draft_draws
BEGIN
  SELECT CASE WHEN NOT (
    OLD.revealed_at_ms IS NULL
    AND NEW.revealed_at_ms IS NOT NULL
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
    AND NEW.version = OLD.version + 1
    AND NEW.updated_at_ms = NEW.revealed_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
  ) THEN RAISE(
    ABORT,
    'restricted draw only permits one versioned reveal'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auctions
    WHERE auctions.league_id = NEW.league_id
      AND auctions.season_id = NEW.season_id
      AND auctions.id = NEW.auction_id
      AND NEW.revealed_at_ms >= auctions.opened_at_ms
      AND auctions.status IN (
        'resolved',
        'no_winner',
        'cancelled'
      )
  ) THEN RAISE(
    ABORT,
    'restricted draw reveal requires terminal auction state in its lifetime'
  ) END;

  SELECT CASE WHEN
    NEW.ordered_tied_bid_ids_json <> '[]'
    AND NOT EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.auction_id
        AND auctions.status = 'resolved'
    )
  THEN RAISE(
    ABORT,
    'only a resolved winner may reveal random selection evidence'
  ) END;

  SELECT CASE WHEN NOT (
    json(NEW.ordered_tied_bid_ids_json) =
      NEW.ordered_tied_bid_ids_json
    AND json(NEW.ordered_tied_team_ids_json) =
      NEW.ordered_tied_team_ids_json
  ) THEN RAISE(
    ABORT,
    'restricted draw arrays must use canonical JSON'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.ordered_tied_bid_ids_json)
    WHERE json_each.type <> 'text'
      OR length(json_each.value) <> 36
      OR json_each.value <> lower(json_each.value)
  ) OR EXISTS (
    SELECT 1
    FROM json_each(NEW.ordered_tied_team_ids_json)
    WHERE json_each.type <> 'text'
      OR length(json_each.value) <> 36
      OR json_each.value <> lower(json_each.value)
  ) THEN RAISE(
    ABORT,
    'restricted draw arrays require canonical lowercase UUIDs'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.ordered_tied_bid_ids_json) AS earlier_bid
    JOIN json_each(NEW.ordered_tied_bid_ids_json) AS later_bid
      ON CAST(earlier_bid.key AS INTEGER) <
        CAST(later_bid.key AS INTEGER)
    WHERE earlier_bid.value >= later_bid.value
  ) THEN RAISE(
    ABORT,
    'restricted draw bid IDs must be strictly lexicographically ordered'
  ) END;

  SELECT CASE WHEN
    NEW.ordered_tied_bid_ids_json <> '[]'
    AND EXISTS (
      SELECT 1
      FROM json_each(NEW.ordered_tied_bid_ids_json) AS tied_bid
      JOIN json_each(NEW.ordered_tied_team_ids_json) AS tied_team
        ON tied_team.key = tied_bid.key
      LEFT JOIN fad_restricted_eligible_bids AS eligible_tied_bid
        ON eligible_tied_bid.league_id = NEW.league_id
       AND eligible_tied_bid.season_id = NEW.season_id
       AND eligible_tied_bid.fad_id = NEW.fad_id
       AND eligible_tied_bid.allocation_id = NEW.allocation_id
       AND eligible_tied_bid.auction_id = NEW.auction_id
       AND eligible_tied_bid.bid_id = tied_bid.value
       AND eligible_tied_bid.team_id = tied_team.value
       AND eligible_tied_bid.bid_status = 'active'
      WHERE eligible_tied_bid.bid_id IS NULL
    )
  THEN RAISE(
    ABORT,
    'restricted draw arrays must align eligible active bid and team IDs'
  ) END;

  -- If random selection is used, the arrays must contain every and only
  -- currently active bid tied at the highest AAV and shortest tied term.
  SELECT CASE WHEN
    NEW.ordered_tied_bid_ids_json <> '[]'
    AND (
      json_array_length(NEW.ordered_tied_bid_ids_json) <> (
        SELECT COUNT(*)
        FROM fad_restricted_eligible_bids AS tied_bid
        WHERE tied_bid.league_id = NEW.league_id
          AND tied_bid.season_id = NEW.season_id
          AND tied_bid.auction_id = NEW.auction_id
          AND tied_bid.bid_status = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM fad_restricted_eligible_bids AS better_bid
            WHERE better_bid.league_id = tied_bid.league_id
              AND better_bid.auction_id = tied_bid.auction_id
              AND better_bid.bid_status = 'active'
              AND (
                (
                  (better_bid.total_value_cents /
                    better_bid.term_years)
                  + CASE
                      WHEN
                        (better_bid.total_value_cents %
                          better_bid.term_years) * 2
                          >= better_bid.term_years
                      THEN 1
                      ELSE 0
                    END
                ) > (
                  (tied_bid.total_value_cents / tied_bid.term_years)
                  + CASE
                      WHEN
                        (tied_bid.total_value_cents %
                          tied_bid.term_years) * 2
                          >= tied_bid.term_years
                      THEN 1
                      ELSE 0
                    END
                )
                OR (
                  (
                    (better_bid.total_value_cents /
                      better_bid.term_years)
                    + CASE
                        WHEN
                          (better_bid.total_value_cents %
                            better_bid.term_years) * 2
                            >= better_bid.term_years
                        THEN 1
                        ELSE 0
                      END
                  ) = (
                    (tied_bid.total_value_cents /
                      tied_bid.term_years)
                    + CASE
                        WHEN
                          (tied_bid.total_value_cents %
                            tied_bid.term_years) * 2
                            >= tied_bid.term_years
                        THEN 1
                        ELSE 0
                      END
                  )
                  AND better_bid.term_years < tied_bid.term_years
                )
              )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM fad_restricted_eligible_bids AS required_tied_bid
        WHERE required_tied_bid.league_id = NEW.league_id
          AND required_tied_bid.auction_id = NEW.auction_id
          AND required_tied_bid.bid_status = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM fad_restricted_eligible_bids AS better_bid
            WHERE better_bid.league_id =
                required_tied_bid.league_id
              AND better_bid.auction_id =
                required_tied_bid.auction_id
              AND better_bid.bid_status = 'active'
              AND (
                (
                  (better_bid.total_value_cents /
                    better_bid.term_years)
                  + CASE
                      WHEN
                        (better_bid.total_value_cents %
                          better_bid.term_years) * 2
                          >= better_bid.term_years
                      THEN 1
                      ELSE 0
                    END
                ) > (
                  (required_tied_bid.total_value_cents /
                    required_tied_bid.term_years)
                  + CASE
                      WHEN
                        (required_tied_bid.total_value_cents %
                          required_tied_bid.term_years) * 2
                          >= required_tied_bid.term_years
                      THEN 1
                      ELSE 0
                    END
                )
                OR (
                  (
                    (better_bid.total_value_cents /
                      better_bid.term_years)
                    + CASE
                        WHEN
                          (better_bid.total_value_cents %
                            better_bid.term_years) * 2
                            >= better_bid.term_years
                        THEN 1
                        ELSE 0
                      END
                  ) = (
                    (required_tied_bid.total_value_cents /
                      required_tied_bid.term_years)
                    + CASE
                        WHEN
                          (required_tied_bid.total_value_cents %
                            required_tied_bid.term_years) * 2
                            >= required_tied_bid.term_years
                        THEN 1
                        ELSE 0
                      END
                  )
                  AND better_bid.term_years <
                    required_tied_bid.term_years
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(
              NEW.ordered_tied_bid_ids_json
            ) AS persisted_tied_bid
            WHERE persisted_tied_bid.value =
              required_tied_bid.bid_id
          )
      )
    )
  THEN RAISE(
    ABORT,
    'restricted draw arrays must equal the exact remaining top tie'
  ) END;

  SELECT CASE WHEN
    NEW.ordered_tied_bid_ids_json = '[]'
    AND EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.auction_id
        AND auctions.status = 'resolved'
    )
    AND (
      SELECT COUNT(*)
      FROM fad_restricted_eligible_bids AS top_bid
      WHERE top_bid.league_id = NEW.league_id
        AND top_bid.auction_id = NEW.auction_id
        AND top_bid.bid_status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM fad_restricted_eligible_bids AS better_bid
          WHERE better_bid.league_id = top_bid.league_id
            AND better_bid.auction_id = top_bid.auction_id
            AND better_bid.bid_status = 'active'
            AND (
              (
                (better_bid.total_value_cents / better_bid.term_years)
                + CASE
                    WHEN
                      (better_bid.total_value_cents %
                        better_bid.term_years) * 2
                        >= better_bid.term_years
                    THEN 1
                    ELSE 0
                  END
              ) > (
                (top_bid.total_value_cents / top_bid.term_years)
                + CASE
                    WHEN
                      (top_bid.total_value_cents %
                        top_bid.term_years) * 2
                        >= top_bid.term_years
                    THEN 1
                    ELSE 0
                  END
              )
              OR (
                (
                  (better_bid.total_value_cents /
                    better_bid.term_years)
                  + CASE
                      WHEN
                        (better_bid.total_value_cents %
                          better_bid.term_years) * 2
                          >= better_bid.term_years
                      THEN 1
                      ELSE 0
                    END
                ) = (
                  (top_bid.total_value_cents / top_bid.term_years)
                  + CASE
                      WHEN
                        (top_bid.total_value_cents %
                          top_bid.term_years) * 2
                          >= top_bid.term_years
                      THEN 1
                      ELSE 0
                    END
                )
                AND better_bid.term_years < top_bid.term_years
              )
            )
        )
    ) >= 2
  THEN RAISE(
    ABORT,
    'restricted draw cannot omit a remaining exact tie'
  ) END;

  SELECT CASE WHEN
    NEW.ordered_tied_bid_ids_json = '[]'
    AND EXISTS (
      SELECT 1
      FROM auctions
      WHERE auctions.league_id = NEW.league_id
        AND auctions.id = NEW.auction_id
        AND auctions.status = 'no_winner'
    )
    AND EXISTS (
      SELECT 1
      FROM fad_restricted_eligible_bids
      WHERE fad_restricted_eligible_bids.league_id = NEW.league_id
        AND fad_restricted_eligible_bids.season_id = NEW.season_id
        AND fad_restricted_eligible_bids.fad_id = NEW.fad_id
        AND fad_restricted_eligible_bids.allocation_id =
          NEW.allocation_id
        AND fad_restricted_eligible_bids.auction_id = NEW.auction_id
        AND fad_restricted_eligible_bids.bid_status = 'active'
    )
  THEN RAISE(
    ABORT,
    'restricted no-winner draw requires zero eligible bids'
  ) END;

  SELECT CASE WHEN
    NEW.ordered_tied_bid_ids_json <> '[]'
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.ordered_tied_bid_ids_json) AS selected_bid
      JOIN json_each(NEW.ordered_tied_team_ids_json) AS selected_team
        ON selected_team.key = selected_bid.key
      WHERE CAST(selected_bid.key AS INTEGER) = NEW.selected_index
        AND selected_bid.value = NEW.selected_bid_id
        AND selected_team.value = NEW.selected_team_id
    )
  THEN RAISE(
    ABORT,
    'restricted draw selection must match its persisted index'
  ) END;
END;

CREATE TRIGGER free_agent_draft_draws_immutable_delete
BEFORE DELETE ON free_agent_draft_draws
BEGIN
  SELECT RAISE(ABORT, 'restricted draw evidence is permanent');
END;

-- Allocation activation is the transaction's commit barrier: the context,
-- complete exact allowlist, all seeds/events, and private draw must already
-- exist and must provide strictly more than one hour of access.
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

-- FAD terminal results use the existing physical auction/result statuses but
-- must agree with their server-owned context. The transaction order is:
-- terminal auction state, draw reveal while competing bids are still Active,
-- terminal bid states/effects, resolution row, then allocation reconciliation.
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

-- A rollover is not an implicit batch result. Every linked auction must have
-- exact terminal evidence, and every abnormal terminal must have one direct
-- durable recovery link to this rollover and its causal resolution job.
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

-- FAD completion may preserve explicit recovery/quarantine, but it may not
-- erase an unaccounted auction or unrevealed restricted draw. Deferred
-- restricted auctions are created only after this transition and therefore
-- have no FAD rollover.
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

CREATE TRIGGER fad_auction_events_immutable_update
BEFORE UPDATE ON auction_events
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
  SELECT RAISE(ABORT, 'FAD auction event evidence is immutable');
END;

CREATE TRIGGER fad_auction_events_immutable_delete
BEFORE DELETE ON auction_events
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
  SELECT RAISE(ABORT, 'FAD auction event evidence is immutable');
END;

UPDATE application_metadata
SET metadata_value = '26',
    updated_at_ms = CASE
      WHEN updated_at_ms < 26 THEN 26
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version';
