-- Permit the one bounded active-auction overlap required by the atomic
-- restricted no-improvement fallback transaction.
--
-- The restricted source must remain resolving until its semantic no-winner
-- result and empty draw reveal exist.  The fallback auction must already exist
-- before the allocation can link it and before that semantic result may be
-- inserted.  Keep separate one-open and one-resolving invariants and admit an
-- open shell beside one exact resolving restricted source only while the
-- caller-owned transaction completes the linked evidence.

DROP INDEX auctions_one_active_per_player;

CREATE UNIQUE INDEX auctions_one_open_per_player
  ON auctions (league_id, player_id)
  WHERE status = 'open';

CREATE UNIQUE INDEX auctions_one_resolving_per_player
  ON auctions (league_id, player_id)
  WHERE status = 'resolving';

CREATE TRIGGER auctions_restricted_fallback_overlap_insert
BEFORE INSERT ON auctions
WHEN NEW.status IN ('open', 'resolving')
  AND EXISTS (
    SELECT 1
    FROM auctions AS active_auction
    WHERE active_auction.league_id = NEW.league_id
      AND active_auction.player_id = NEW.player_id
      AND active_auction.status IN ('open', 'resolving')
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'open'
    AND NEW.opened_by_user_id IS NULL
    AND NEW.created_at_ms = NEW.updated_at_ms
    AND NEW.version = 1
    AND NEW.opened_at_ms >= NEW.created_at_ms
    AND NEW.resolves_at_ms = NEW.opened_at_ms + 86400000
    AND (
      SELECT COUNT(*)
      FROM auctions AS active_auction
      WHERE active_auction.league_id = NEW.league_id
        AND active_auction.player_id = NEW.player_id
        AND active_auction.status IN ('open', 'resolving')
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM auctions AS restricted_auction
      JOIN auction_contexts AS restricted_context
        ON restricted_context.league_id = restricted_auction.league_id
       AND restricted_context.season_id = restricted_auction.season_id
       AND restricted_context.auction_id = restricted_auction.id
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = restricted_context.league_id
       AND allocation.season_id = restricted_context.season_id
       AND allocation.fad_id = restricted_context.fad_id
       AND allocation.id = restricted_context.fad_allocation_id
       AND allocation.player_id = restricted_auction.player_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = allocation.fad_id
      JOIN free_agent_draft_rollovers AS source_rollover
        ON source_rollover.league_id = restricted_context.league_id
       AND source_rollover.season_id = restricted_context.season_id
       AND source_rollover.fad_id = restricted_context.fad_id
       AND source_rollover.id = restricted_context.fad_rollover_id
      JOIN free_agent_draft_draws AS restricted_draw
        ON restricted_draw.league_id = restricted_context.league_id
       AND restricted_draw.season_id = restricted_context.season_id
       AND restricted_draw.fad_id = restricted_context.fad_id
       AND restricted_draw.allocation_id = restricted_context.fad_allocation_id
       AND restricted_draw.auction_id = restricted_context.auction_id
      JOIN job_runs AS resolution_job
        ON resolution_job.league_id = restricted_auction.league_id
       AND resolution_job.season_id = restricted_auction.season_id
       AND resolution_job.job_type = 'auction.resolve.target'
       AND resolution_job.occurrence_key =
            'auction:' || restricted_auction.id || ':' ||
              restricted_auction.resolves_at_ms
       AND resolution_job.scheduled_for_ms = restricted_auction.resolves_at_ms
      WHERE restricted_auction.league_id = NEW.league_id
        AND restricted_auction.season_id = NEW.season_id
        AND restricted_auction.player_id = NEW.player_id
        AND restricted_auction.status = 'resolving'
        AND restricted_auction.resolves_at_ms <= NEW.created_at_ms
        AND restricted_context.source_kind = 'fad_restricted'
        AND restricted_context.fad_origin = 'candidate_tie_restricted'
        AND allocation.status = 'restricted_active'
        AND allocation.decision_code = 'exact_total_and_term_tie'
        AND allocation.winning_snapshot_entry_id IS NULL
        AND allocation.winning_team_id IS NULL
        AND allocation.contract_id IS NULL
        AND allocation.ownership_id IS NULL
        AND allocation.restricted_auction_id = restricted_auction.id
        AND allocation.fallback_open_auction_id IS NULL
        AND allocation.restricted_minimum_total_cents IS NOT NULL
        AND allocation.restricted_minimum_term_years IS NOT NULL
        AND allocation.restricted_minimum_aav_cents IS NOT NULL
        AND allocation.accounted_at_ms IS NULL
        AND allocation.last_error_code IS NULL
        AND source_rollover.rolls_over_at_ms =
            restricted_auction.resolves_at_ms
        AND restricted_auction.opened_at_ms >= source_rollover.opens_at_ms
        AND restricted_auction.opened_at_ms < source_rollover.rolls_over_at_ms
        AND restricted_draw.revealed_at_ms IS NULL
        AND restricted_draw.version = 1
        AND NOT EXISTS (
          SELECT 1
          FROM auction_resolutions
          WHERE auction_resolutions.league_id = restricted_auction.league_id
            AND auction_resolutions.auction_id = restricted_auction.id
        )
        AND resolution_job.status IN ('leased', 'running')
        AND resolution_job.attempt_count >= 1
        AND resolution_job.lease_owner IS NOT NULL
        AND resolution_job.lease_token IS NOT NULL
        AND resolution_job.lease_expires_at_ms > NEW.created_at_ms
        AND resolution_job.completed_at_ms IS NULL
        AND resolution_job.result_json IS NULL
        AND resolution_job.last_error_code IS NULL
        AND resolution_job.next_attempt_at_ms IS NULL
        AND resolution_job.updated_at_ms <= NEW.created_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM auction_bids
          WHERE auction_bids.league_id = restricted_auction.league_id
            AND auction_bids.auction_id = restricted_auction.id
            AND auction_bids.status = 'active'
        )
        AND NEW.opened_at_ms >= NEW.created_at_ms
        AND NEW.opened_at_ms >= restricted_auction.resolves_at_ms
        AND NEW.opened_at_ms >= fad.candidate_deadline_at_ms
        AND (
          NEW.opened_at_ms - fad.candidate_deadline_at_ms
        ) % 86400000 = 0
    )
  ) THEN RAISE(
    ABORT,
    'active auction overlap requires one exact restricted fallback handoff'
  ) END;
END;

CREATE TRIGGER auctions_active_overlap_update
BEFORE UPDATE ON auctions
WHEN NEW.status IN ('open', 'resolving')
  AND EXISTS (
    SELECT 1
    FROM auctions AS other_auction
    WHERE other_auction.league_id = NEW.league_id
      AND other_auction.player_id = NEW.player_id
      AND other_auction.id <> OLD.id
      AND other_auction.status IN ('open', 'resolving')
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'an existing auction cannot enter or mutate inside an active overlap'
  );
END;

CREATE TRIGGER auction_contexts_restricted_fallback_full_window_insert
BEFORE INSERT ON auction_contexts
WHEN NEW.source_kind = 'fad_open_rapid'
  AND NEW.fad_origin = 'restricted_no_improvement_fallback'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auctions AS fallback_auction
    JOIN free_agent_draft_rollovers AS target_rollover
      ON target_rollover.league_id = fallback_auction.league_id
     AND target_rollover.season_id = fallback_auction.season_id
     AND target_rollover.fad_id = NEW.fad_id
     AND target_rollover.id = NEW.fad_rollover_id
    JOIN free_agent_draft_player_allocations AS allocation
      ON allocation.league_id = fallback_auction.league_id
     AND allocation.season_id = fallback_auction.season_id
     AND allocation.fad_id = NEW.fad_id
     AND allocation.id = NEW.fad_allocation_id
     AND allocation.player_id = fallback_auction.player_id
    JOIN auctions AS restricted_auction
      ON restricted_auction.league_id = allocation.league_id
     AND restricted_auction.season_id = allocation.season_id
     AND restricted_auction.id = allocation.restricted_auction_id
     AND restricted_auction.player_id = allocation.player_id
    WHERE fallback_auction.league_id = NEW.league_id
      AND fallback_auction.season_id = NEW.season_id
      AND fallback_auction.id = NEW.auction_id
      AND fallback_auction.status = 'open'
      AND fallback_auction.opened_by_user_id IS NULL
      AND fallback_auction.opened_at_ms = target_rollover.opens_at_ms
      AND fallback_auction.resolves_at_ms = target_rollover.rolls_over_at_ms
      AND fallback_auction.resolves_at_ms -
            fallback_auction.opened_at_ms = 86400000
      AND allocation.status = 'restricted_fallback_open'
      AND allocation.decision_code = 'restricted_no_improvement_fallback'
      AND allocation.fallback_open_auction_id = fallback_auction.id
      AND restricted_auction.status = 'resolving'
  ) THEN RAISE(
    ABORT,
    'restricted fallback context requires its exact complete handoff window'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '40',
    updated_at_ms = CASE
      WHEN updated_at_ms < 40 THEN 40
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '39';
