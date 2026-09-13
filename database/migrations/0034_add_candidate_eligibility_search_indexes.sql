-- Schema 34 supplies the league- and player-scoped indexes used by Candidate
-- Card eligibility reads. Migration 0030 rebuilt free_agent_draft_recoveries
-- without the player lookup originally present in migration 0025; the other
-- two indexes support the approved rights-release re-entry predicate.

CREATE INDEX free_agent_draft_recoveries_league_player_status
  ON free_agent_draft_recoveries (
    league_id,
    player_id,
    status
  );

CREATE INDEX ownership_events_candidate_release_by_player
  ON ownership_events (
    league_id,
    player_id,
    occurred_at_ms DESC,
    id DESC
  )
  WHERE event_type IN (
    'fantasy_elc_declined',
    'unsigned_prospect_rights_released'
  );

CREATE INDEX draft_eligible_players_rights_release_reentry
  ON draft_eligible_players (
    league_id,
    player_id,
    rights_release_event_id,
    eligibility_snapshot_id
  )
  WHERE eligibility_reason = 'rights_release_reentry';

UPDATE application_metadata
SET metadata_value = '34',
    updated_at_ms = CASE
      WHEN updated_at_ms < 34 THEN 34
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '33';
