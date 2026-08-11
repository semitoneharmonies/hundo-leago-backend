-- Keep the restricted participant evidence fence aligned with the canonical
-- current-offer floor enforced by fad_auction_bids_forward_update.
--
-- lowest_offered_aav_cents is immutable bid history.  A valid edit may lower
-- that historical value while its new current offer still strictly improves
-- the Candidate floor by equal total and higher rounded AAV.  Rebuild only the
-- participant forward-update trigger so its equal-total branch evaluates the
-- current offer with the same integer half-up rounding formula as the bid
-- trigger.  Every other participant identity, lifecycle, actor, and removal
-- fence remains unchanged.

DROP TRIGGER free_agent_draft_auction_participants_forward_update;

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

UPDATE application_metadata
SET metadata_value = '42',
    updated_at_ms = CASE
      WHEN updated_at_ms < 42 THEN 42
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '41';
