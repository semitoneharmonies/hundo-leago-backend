-- Approved 2026-09-23: all auction ties use the earliest original bid.
-- Replace only the terminal commitment guard; preserve every historical row.
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
    AND NEW.ordered_tied_bid_ids_json IS '[]'
    AND NEW.ordered_tied_team_ids_json IS '[]'
    AND NEW.selected_bid_id IS NULL
    AND NEW.selected_team_id IS NULL
    AND NEW.selected_index IS NULL
    AND NEW.rejection_counter IS NULL
    AND NEW.selected_digest_hex IS NULL
    AND EXISTS (
      SELECT 1
      FROM auctions
      JOIN auction_resolutions
        ON auction_resolutions.league_id = auctions.league_id
       AND auction_resolutions.auction_id = auctions.id
      WHERE auctions.league_id = NEW.league_id
        AND auctions.season_id = NEW.season_id
        AND auctions.id = NEW.auction_id
        AND auctions.status IN ('resolving', 'resolved', 'no_winner', 'cancelled')
        AND auction_resolutions.resolved_at_ms = NEW.revealed_at_ms
        AND (
          (
            auction_resolutions.winning_bid_id = (
              SELECT candidate.bid_id
              FROM fad_frozen_eligible_bids AS candidate
              JOIN auction_bids AS original
                ON original.league_id = candidate.league_id
               AND original.auction_id = candidate.auction_id
               AND original.id = candidate.bid_id
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
              ORDER BY candidate.aav_cents DESC, candidate.term_years DESC,
                original.first_submitted_at_ms ASC, candidate.bid_id ASC
              LIMIT 1
            )
            AND EXISTS (
              SELECT 1 FROM fad_frozen_eligible_bids AS winner
              WHERE winner.league_id = NEW.league_id
                AND winner.auction_id = NEW.auction_id
                AND winner.bid_id = auction_resolutions.winning_bid_id
                AND winner.team_id = auction_resolutions.winning_team_id
            )
          )
          OR (
            auction_resolutions.winning_bid_id IS NULL
            AND auction_resolutions.winning_team_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM fad_frozen_eligible_bids AS candidate
              WHERE candidate.league_id = NEW.league_id
                AND candidate.auction_id = NEW.auction_id
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'FAD result must use AAV, longer term, earliest original bid, then stable bid ID without a draw'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '60', updated_at_ms = max(updated_at_ms, 60)
WHERE metadata_key = 'data_model_version' AND metadata_value = '59';
