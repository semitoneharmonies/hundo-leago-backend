-- Clock-only audit for open rapid manager nominations. Installation preserves all prior rows.
CREATE TABLE fad_auction_clock_changes (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL,
 fad_id TEXT NOT NULL,
 change_id TEXT NOT NULL REFERENCES fad_timing_changes(id) DEFERRABLE INITIALLY DEFERRED,
 auction_id TEXT NOT NULL,
 rollover_id TEXT NOT NULL,
 previous_closes_at_ms INTEGER NOT NULL CHECK(previous_closes_at_ms>created_at_ms),
 closes_at_ms INTEGER NOT NULL CHECK(closes_at_ms>created_at_ms AND closes_at_ms<>previous_closes_at_ms),
 previous_cutoff_at_ms INTEGER NOT NULL CHECK(previous_cutoff_at_ms>=0),
 cutoff_at_ms INTEGER NOT NULL CHECK(cutoff_at_ms>=0 AND cutoff_at_ms<=closes_at_ms),
 previous_auction_version INTEGER NOT NULL CHECK(previous_auction_version>=1),
 auction_version INTEGER NOT NULL CHECK(auction_version=previous_auction_version+1),
 before_job_json TEXT NOT NULL CHECK(json_valid(before_job_json)),
 after_job_json TEXT NOT NULL CHECK(json_valid(after_job_json)),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 UNIQUE(league_id,auction_id,previous_auction_version),
 UNIQUE(change_id,auction_id),
 FOREIGN KEY(league_id,fad_id) REFERENCES free_agent_drafts(league_id,id),
 FOREIGN KEY(league_id,auction_id) REFERENCES auctions(league_id,id),
 FOREIGN KEY(league_id,rollover_id) REFERENCES free_agent_draft_rollovers(league_id,id)
) STRICT;
CREATE INDEX fad_auction_clock_changes_scope ON fad_auction_clock_changes(league_id,change_id);
CREATE TRIGGER fad_auction_clock_changes_immutable_update BEFORE UPDATE ON fad_auction_clock_changes
BEGIN SELECT RAISE(ABORT,'FAD auction clock history is immutable'); END;
CREATE TRIGGER fad_auction_clock_changes_immutable_delete BEFORE DELETE ON fad_auction_clock_changes
BEGIN SELECT RAISE(ABORT,'FAD auction clock history is immutable'); END;
CREATE TRIGGER fad_auction_clock_changes_valid_insert BEFORE INSERT ON fad_auction_clock_changes
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM fad_timing_changes WHERE id=NEW.change_id) OR NOT EXISTS(
   SELECT 1 FROM auctions a JOIN auction_contexts c ON c.league_id=a.league_id AND c.auction_id=a.id
   JOIN free_agent_drafts d ON d.league_id=c.league_id AND d.id=c.fad_id
   JOIN leagues l ON l.id=d.league_id
   JOIN free_agent_draft_rollovers r ON r.league_id=c.league_id AND r.id=c.fad_rollover_id
   JOIN job_runs j ON j.league_id=a.league_id AND j.season_id=a.season_id
     AND j.job_type='auction.resolve.target' AND j.occurrence_key='auction:'||a.id||':'||a.resolves_at_ms
   WHERE a.league_id=NEW.league_id AND a.id=NEW.auction_id AND a.status='open'
     AND a.resolves_at_ms=NEW.previous_closes_at_ms AND a.version=NEW.previous_auction_version
     AND c.fad_id=NEW.fad_id AND c.fad_rollover_id=NEW.rollover_id
     AND c.source_kind='fad_open_rapid' AND c.fad_origin='manager_nomination'
     AND r.rolls_over_at_ms=a.resolves_at_ms AND r.creation_cutoff_at_ms=NEW.previous_cutoff_at_ms
     AND d.status='rapid' AND l.status='active' AND l.current_season_id=d.season_id
     AND r.status='scheduled' AND r.rolls_over_at_ms=a.resolves_at_ms
     AND NEW.closes_at_ms<=d.first_matchup_starts_at_ms
     AND j.status='pending' AND j.attempt_count=0 AND j.lease_owner IS NULL AND j.lease_token IS NULL
     AND j.lease_expires_at_ms IS NULL AND j.last_error_code IS NULL AND j.result_json IS NULL
     AND j.id IS json_extract(NEW.before_job_json,'$.id')
      AND j.league_id IS json_extract(NEW.before_job_json,'$.league_id')
      AND j.season_id IS json_extract(NEW.before_job_json,'$.season_id')
      AND j.job_type IS json_extract(NEW.before_job_json,'$.job_type')
      AND j.occurrence_key IS json_extract(NEW.before_job_json,'$.occurrence_key')
      AND j.scheduled_for_ms IS json_extract(NEW.before_job_json,'$.scheduled_for_ms')
      AND j.status IS json_extract(NEW.before_job_json,'$.status')
      AND j.attempt_count IS json_extract(NEW.before_job_json,'$.attempt_count')
      AND j.lease_owner IS json_extract(NEW.before_job_json,'$.lease_owner')
      AND j.lease_expires_at_ms IS json_extract(NEW.before_job_json,'$.lease_expires_at_ms')
      AND j.started_at_ms IS json_extract(NEW.before_job_json,'$.started_at_ms')
      AND j.completed_at_ms IS json_extract(NEW.before_job_json,'$.completed_at_ms')
      AND j.result_json IS json_extract(NEW.before_job_json,'$.result_json')
      AND j.last_error_code IS json_extract(NEW.before_job_json,'$.last_error_code')
      AND j.created_at_ms IS json_extract(NEW.before_job_json,'$.created_at_ms')
      AND j.updated_at_ms IS json_extract(NEW.before_job_json,'$.updated_at_ms')
      AND j.version IS json_extract(NEW.before_job_json,'$.version')
      AND j.lease_token IS json_extract(NEW.before_job_json,'$.lease_token')
      AND j.next_attempt_at_ms IS json_extract(NEW.before_job_json,'$.next_attempt_at_ms')
     AND NOT EXISTS(SELECT 1 FROM auction_resolutions x WHERE x.league_id=a.league_id AND x.auction_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM free_agent_draft_recoveries x WHERE x.league_id=a.league_id AND x.auction_id=a.id)
 ) THEN RAISE(ABORT,'Only idle open manager nominations may change their clocks') END;
 SELECT CASE WHEN (
   json_extract(NEW.before_job_json,'$.id') IS json_extract(NEW.after_job_json,'$.id')
      AND json_extract(NEW.before_job_json,'$.league_id') IS json_extract(NEW.after_job_json,'$.league_id')
      AND json_extract(NEW.before_job_json,'$.season_id') IS json_extract(NEW.after_job_json,'$.season_id')
      AND json_extract(NEW.before_job_json,'$.job_type') IS json_extract(NEW.after_job_json,'$.job_type')
      AND json_extract(NEW.before_job_json,'$.status') IS json_extract(NEW.after_job_json,'$.status')
      AND json_extract(NEW.before_job_json,'$.attempt_count') IS json_extract(NEW.after_job_json,'$.attempt_count')
      AND json_extract(NEW.before_job_json,'$.lease_owner') IS json_extract(NEW.after_job_json,'$.lease_owner')
      AND json_extract(NEW.before_job_json,'$.lease_expires_at_ms') IS json_extract(NEW.after_job_json,'$.lease_expires_at_ms')
      AND json_extract(NEW.before_job_json,'$.started_at_ms') IS json_extract(NEW.after_job_json,'$.started_at_ms')
      AND json_extract(NEW.before_job_json,'$.completed_at_ms') IS json_extract(NEW.after_job_json,'$.completed_at_ms')
      AND json_extract(NEW.before_job_json,'$.result_json') IS json_extract(NEW.after_job_json,'$.result_json')
      AND json_extract(NEW.before_job_json,'$.last_error_code') IS json_extract(NEW.after_job_json,'$.last_error_code')
      AND json_extract(NEW.before_job_json,'$.created_at_ms') IS json_extract(NEW.after_job_json,'$.created_at_ms')
      AND json_extract(NEW.before_job_json,'$.lease_token') IS json_extract(NEW.after_job_json,'$.lease_token')
   AND json_extract(NEW.after_job_json,'$.scheduled_for_ms')=NEW.closes_at_ms
   AND json_extract(NEW.after_job_json,'$.occurrence_key')='auction:'||NEW.auction_id||':'||NEW.closes_at_ms
   AND json_extract(NEW.after_job_json,'$.next_attempt_at_ms') IS NULL
   AND json_extract(NEW.after_job_json,'$.updated_at_ms')=max(NEW.created_at_ms,json_extract(NEW.before_job_json,'$.updated_at_ms'))
   AND json_extract(NEW.after_job_json,'$.version')=json_extract(NEW.before_job_json,'$.version')+1
 ) IS NOT TRUE THEN RAISE(ABORT,'Auction clock changes preserve the original resolution job identity') END;
END;

DROP TRIGGER fad_timing_changes_rapid_valid_insert;
CREATE TRIGGER fad_timing_changes_rapid_valid_insert BEFORE INSERT ON fad_timing_changes
WHEN json_extract(NEW.before_root_json,'$.status')='rapid'
BEGIN
  SELECT CASE WHEN NOT (
    json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms') IS json_extract(NEW.before_root_json,'$.candidate_deadline_at_ms')
    AND json_extract(NEW.after_root_json,'$.help_opens_at_ms') IS json_extract(NEW.before_root_json,'$.help_opens_at_ms')
    AND NOT EXISTS(SELECT 1 FROM job_runs WHERE league_id=NEW.league_id
      AND season_id=json_extract(NEW.before_root_json,'$.season_id')
      AND occurrence_key LIKE 'fad:'||NEW.fad_id||':%' AND status IN ('leased','running','failed'))
    AND EXISTS(SELECT 1 FROM free_agent_draft_readiness_operations WHERE league_id=NEW.league_id
      AND id=json_extract(NEW.before_root_json,'$.readiness_operation_id') AND status='succeeded' AND created_fad_id=NEW.fad_id)
    AND json_array_length(NEW.before_rollovers_json)=(SELECT COUNT(*) FROM free_agent_draft_rollovers WHERE league_id=NEW.league_id AND fad_id=NEW.fad_id)
    AND json_array_length(NEW.before_jobs_json)=json_array_length(NEW.before_rollovers_json)+2+(SELECT COUNT(*) FROM fad_auction_clock_changes WHERE league_id=NEW.league_id AND change_id=NEW.id)
    AND json_extract(NEW.after_root_json,'$.updated_at_ms')>=json_extract(NEW.before_root_json,'$.updated_at_ms')
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.after_rollovers_json) after
      WHERE json_extract(after.value,'$.sequence')<>after.key+1
      OR json_extract(after.value,'$.rolls_over_at_ms') IS NOT
        json_extract(json_extract(NEW.after_root_json,'$.initial_rollover_times_json'),'$['||after.key||']')
      OR json_extract(after.value,'$.opens_at_ms') IS NOT CASE WHEN after.key=0
        THEN json_extract(NEW.after_root_json,'$.candidate_deadline_at_ms')
        ELSE json_extract(json_extract(NEW.after_root_json,'$.initial_rollover_times_json'),'$['||(after.key-1)||']') END)
  ) THEN RAISE(ABORT,'Rapid timing must preserve the locked deadline and idle lifecycle') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM json_each(NEW.before_rollovers_json) before
    WHERE NOT EXISTS(SELECT 1 FROM free_agent_draft_rollovers r
      WHERE r.league_id=NEW.league_id AND r.fad_id=NEW.fad_id
      AND r.id IS json_extract(before.value,'$.id')
      AND r.league_id IS json_extract(before.value,'$.league_id')
      AND r.season_id IS json_extract(before.value,'$.season_id')
      AND r.fad_id IS json_extract(before.value,'$.fad_id')
      AND r.sequence IS json_extract(before.value,'$.sequence')
      AND r.window_kind IS json_extract(before.value,'$.window_kind')
      AND r.predecessor_rollover_id IS json_extract(before.value,'$.predecessor_rollover_id')
      AND r.extension_reason IS json_extract(before.value,'$.extension_reason')
      AND r.extension_source_id IS json_extract(before.value,'$.extension_source_id')
      AND r.opens_at_ms IS json_extract(before.value,'$.opens_at_ms')
      AND r.creation_cutoff_at_ms IS json_extract(before.value,'$.creation_cutoff_at_ms')
      AND r.rolls_over_at_ms IS json_extract(before.value,'$.rolls_over_at_ms')
      AND r.status IS json_extract(before.value,'$.status')
      AND r.processing_job_run_id IS json_extract(before.value,'$.processing_job_run_id')
      AND r.processing_started_at_ms IS json_extract(before.value,'$.processing_started_at_ms')
      AND r.completed_at_ms IS json_extract(before.value,'$.completed_at_ms')
      AND r.last_error_code IS json_extract(before.value,'$.last_error_code')
      AND r.created_at_ms IS json_extract(before.value,'$.created_at_ms')
      AND r.updated_at_ms IS json_extract(before.value,'$.updated_at_ms')
      AND r.version IS json_extract(before.value,'$.version')
      AND r.sequence=before.key+1 AND r.window_kind='initial'
      AND (r.status='completed' OR (r.status='scheduled' AND r.rolls_over_at_ms>NEW.created_at_ms))))
    OR EXISTS(SELECT 1 FROM json_each(NEW.after_rollovers_json) after
      JOIN json_each(NEW.before_rollovers_json) before ON before.key=after.key
      JOIN free_agent_draft_rollovers r ON r.id=json_extract(before.value,'$.id') AND r.league_id=NEW.league_id
      WHERE before.value<>after.value AND (
        r.status<>'scheduled' OR json_extract(after.value,'$.rolls_over_at_ms')<=NEW.created_at_ms
        OR (json_extract(after.value,'$.opens_at_ms')<>r.opens_at_ms AND (r.opens_at_ms<=NEW.created_at_ms OR json_extract(after.value,'$.opens_at_ms')<=NEW.created_at_ms))
        OR json_extract(after.value,'$.rolls_over_at_ms')<=json_extract(after.value,'$.opens_at_ms')
        OR json_extract(after.value,'$.updated_at_ms')<r.updated_at_ms
        OR json_extract(after.value,'$.creation_cutoff_at_ms')<>max(json_extract(after.value,'$.opens_at_ms'),
          json_extract(after.value,'$.rolls_over_at_ms')-COALESCE((SELECT gap_ms FROM fad_auction_cutoff_settings
            WHERE league_id=NEW.league_id AND id=NEW.fad_id),(SELECT auction_creation_cutoff_minutes*60000 FROM free_agent_drafts WHERE id=NEW.fad_id AND league_id=NEW.league_id),3600000))
        OR EXISTS(SELECT 1 FROM auction_contexts a WHERE a.league_id=r.league_id AND a.fad_rollover_id=r.id AND NOT EXISTS(
    SELECT 1 FROM fad_auction_clock_changes clock WHERE clock.league_id=NEW.league_id AND clock.fad_id=NEW.fad_id AND clock.change_id=NEW.id
      AND clock.auction_id=a.auction_id AND clock.rollover_id=r.id AND clock.previous_closes_at_ms=r.rolls_over_at_ms
      AND clock.closes_at_ms=json_extract(after.value,'$.rolls_over_at_ms')
      AND clock.cutoff_at_ms=json_extract(after.value,'$.creation_cutoff_at_ms')))
  OR EXISTS(SELECT 1 FROM free_agent_draft_nomination_queue q
    JOIN free_agent_draft_rollovers source ON source.league_id=q.league_id AND source.id=q.source_rollover_id
    JOIN free_agent_draft_rollovers opening ON opening.league_id=q.league_id AND opening.id=q.target_opening_rollover_id
    WHERE q.league_id=r.league_id AND q.fad_id=r.fad_id AND
      (r.id IN(q.source_rollover_id,q.target_opening_rollover_id,q.resolution_rollover_id)
       OR r.sequence=source.sequence+1 OR r.sequence=opening.sequence+1))
      ))
    THEN RAISE(ABORT,'Rapid timing cannot change opened or committed rounds') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM json_each(NEW.before_jobs_json) before
    WHERE NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.league_id=NEW.league_id
      AND j.season_id=json_extract(NEW.before_root_json,'$.season_id')
      AND j.id IS json_extract(before.value,'$.id')
      AND j.league_id IS json_extract(before.value,'$.league_id')
      AND j.season_id IS json_extract(before.value,'$.season_id')
      AND j.job_type IS json_extract(before.value,'$.job_type')
      AND j.occurrence_key IS json_extract(before.value,'$.occurrence_key')
      AND j.scheduled_for_ms IS json_extract(before.value,'$.scheduled_for_ms')
      AND j.status IS json_extract(before.value,'$.status')
      AND j.attempt_count IS json_extract(before.value,'$.attempt_count')
      AND j.lease_owner IS json_extract(before.value,'$.lease_owner')
      AND j.lease_expires_at_ms IS json_extract(before.value,'$.lease_expires_at_ms')
      AND j.started_at_ms IS json_extract(before.value,'$.started_at_ms')
      AND j.completed_at_ms IS json_extract(before.value,'$.completed_at_ms')
      AND j.result_json IS json_extract(before.value,'$.result_json')
      AND j.last_error_code IS json_extract(before.value,'$.last_error_code')
      AND j.created_at_ms IS json_extract(before.value,'$.created_at_ms')
      AND j.updated_at_ms IS json_extract(before.value,'$.updated_at_ms')
      AND j.version IS json_extract(before.value,'$.version')
      AND j.lease_token IS json_extract(before.value,'$.lease_token')
      AND j.next_attempt_at_ms IS json_extract(before.value,'$.next_attempt_at_ms')
      AND (j.status='succeeded' OR (j.status='pending' AND j.lease_owner IS NULL AND j.lease_token IS NULL
      AND j.lease_expires_at_ms IS NULL AND j.last_error_code IS NULL))))
    OR EXISTS(SELECT 1 FROM json_each(NEW.after_jobs_json) after
      JOIN json_each(NEW.before_jobs_json) before ON before.key=after.key
      WHERE before.value<>after.value AND NOT (EXISTS(SELECT 1 FROM fad_auction_clock_changes clock WHERE clock.league_id=NEW.league_id
        AND clock.change_id=NEW.id AND clock.before_job_json=before.value AND clock.after_job_json=after.value) OR (
        json_extract(before.value,'$.id') IS json_extract(after.value,'$.id')
      AND json_extract(before.value,'$.league_id') IS json_extract(after.value,'$.league_id')
      AND json_extract(before.value,'$.season_id') IS json_extract(after.value,'$.season_id')
      AND json_extract(before.value,'$.job_type') IS json_extract(after.value,'$.job_type')
      AND json_extract(before.value,'$.status') IS json_extract(after.value,'$.status')
      AND json_extract(before.value,'$.attempt_count') IS json_extract(after.value,'$.attempt_count')
      AND json_extract(before.value,'$.lease_owner') IS json_extract(after.value,'$.lease_owner')
      AND json_extract(before.value,'$.lease_expires_at_ms') IS json_extract(after.value,'$.lease_expires_at_ms')
      AND json_extract(before.value,'$.started_at_ms') IS json_extract(after.value,'$.started_at_ms')
      AND json_extract(before.value,'$.completed_at_ms') IS json_extract(after.value,'$.completed_at_ms')
      AND json_extract(before.value,'$.result_json') IS json_extract(after.value,'$.result_json')
      AND json_extract(before.value,'$.last_error_code') IS json_extract(after.value,'$.last_error_code')
      AND json_extract(before.value,'$.created_at_ms') IS json_extract(after.value,'$.created_at_ms')
      AND json_extract(before.value,'$.lease_token') IS json_extract(after.value,'$.lease_token')
        AND json_extract(before.value,'$.status')='pending' AND json_extract(before.value,'$.job_type')='fad_rollover'
        AND json_extract(after.value,'$.version')=json_extract(before.value,'$.version')+1
        AND json_extract(after.value,'$.updated_at_ms')>=json_extract(before.value,'$.updated_at_ms')
        AND json_extract(after.value,'$.next_attempt_at_ms') IS NULL
        AND EXISTS(SELECT 1 FROM json_each(NEW.before_rollovers_json) oldRound
          JOIN json_each(NEW.after_rollovers_json) newRound ON oldRound.key=newRound.key
          WHERE json_extract(before.value,'$.occurrence_key')='fad:'||NEW.fad_id||':rollover:'||
            json_extract(oldRound.value,'$.sequence')||':'||json_extract(oldRound.value,'$.rolls_over_at_ms')
          AND json_extract(before.value,'$.scheduled_for_ms')=json_extract(oldRound.value,'$.rolls_over_at_ms')
          AND json_extract(after.value,'$.occurrence_key')='fad:'||NEW.fad_id||':rollover:'||
            json_extract(newRound.value,'$.sequence')||':'||json_extract(newRound.value,'$.rolls_over_at_ms')
          AND json_extract(after.value,'$.scheduled_for_ms')=json_extract(newRound.value,'$.rolls_over_at_ms'))
      ))
    ) THEN RAISE(ABORT,'Rapid timing must retain job identities and completed receipts') END;
END;

DROP TRIGGER auctions_require_context_update;
CREATE TRIGGER auctions_require_context_update
BEFORE UPDATE ON auctions
WHEN NOT EXISTS(SELECT 1 FROM fad_auction_clock_changes clock
 JOIN fad_timing_changes change ON change.id=clock.change_id AND change.league_id=clock.league_id AND change.fad_id=clock.fad_id
 JOIN free_agent_drafts d ON d.league_id=clock.league_id AND d.id=clock.fad_id
 WHERE clock.league_id=OLD.league_id AND d.status='rapid' AND d.version=json_extract(change.before_root_json,'$.version')
   AND clock.auction_id=OLD.id AND OLD.status='open' AND NEW.status='open'
   AND OLD.resolves_at_ms=clock.previous_closes_at_ms AND NEW.resolves_at_ms=clock.closes_at_ms
   AND OLD.version=clock.previous_auction_version AND NEW.version=clock.auction_version
   AND NEW.updated_at_ms=max(OLD.updated_at_ms,clock.created_at_ms)
   AND NEW.id IS OLD.id
      AND NEW.league_id IS OLD.league_id
      AND NEW.season_id IS OLD.season_id
      AND NEW.player_id IS OLD.player_id
      AND NEW.status IS OLD.status
      AND NEW.opened_at_ms IS OLD.opened_at_ms
      AND NEW.opened_by_user_id IS OLD.opened_by_user_id
      AND NEW.created_at_ms IS OLD.created_at_ms
   AND EXISTS(SELECT 1 FROM auction_contexts c WHERE c.league_id=OLD.league_id AND c.auction_id=OLD.id
     AND c.fad_rollover_id=clock.rollover_id AND c.fad_origin='manager_nomination'))
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = NEW.league_id
      AND auction_contexts.season_id = NEW.season_id
      AND auction_contexts.auction_id = NEW.id
  ) THEN RAISE(
    ABORT,
    'auction state transition requires its persisted context'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM auction_contexts
    WHERE auction_contexts.league_id = OLD.league_id
      AND auction_contexts.season_id = OLD.season_id
      AND auction_contexts.auction_id = OLD.id
      AND auction_contexts.source_kind IN (
        'fad_open_rapid',
        'fad_restricted'
      )
  ) AND NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.season_id IS OLD.season_id
    AND NEW.player_id IS OLD.player_id
    AND NEW.opened_at_ms IS OLD.opened_at_ms
    AND NEW.resolves_at_ms IS OLD.resolves_at_ms
    AND NEW.opened_by_user_id IS OLD.opened_by_user_id
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND NEW.version = OLD.version + 1
    AND OLD.status NOT IN (
      'resolved',
      'no_winner',
      'cancelled'
    )
  ) THEN RAISE(
    ABORT,
    'FAD auction identity and terminal history are immutable'
  ) END;

  SELECT CASE WHEN
    NEW.status IN ('resolved', 'no_winner', 'cancelled')
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.auction_id = NEW.id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      (
        NEW.status = 'cancelled'
        AND EXISTS (
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
                NEW.player_id
           AND free_agent_draft_recoveries.allocation_id =
                auction_contexts.fad_allocation_id
           AND free_agent_draft_recoveries.rollover_id =
                auction_contexts.fad_rollover_id
           AND free_agent_draft_recoveries.auction_id =
                auction_contexts.auction_id
          WHERE auction_contexts.league_id = NEW.league_id
            AND auction_contexts.season_id = NEW.season_id
            AND auction_contexts.auction_id = NEW.id
            AND auction_contexts.source_kind =
              'fad_restricted'
            AND free_agent_draft_player_allocations.status =
              'correction_required'
            AND free_agent_draft_player_allocations
              .restricted_auction_id = NEW.id
            AND free_agent_draft_player_allocations
              .updated_at_ms = NEW.updated_at_ms
            AND free_agent_draft_draws.revealed_at_ms IS NULL
            AND free_agent_draft_draws.version = 1
            AND free_agent_draft_recoveries.kind =
              'auction_resolution'
            AND free_agent_draft_recoveries.status =
              'correction_required'
            AND free_agent_draft_recoveries.last_error_code
              IS NOT NULL
            AND free_agent_draft_recoveries.created_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_recoveries.updated_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_recoveries.resolved_at_ms IS NULL
            AND free_agent_draft_recoveries
              .resolved_by_user_id IS NULL
            AND free_agent_draft_recoveries
              .resolved_by_membership_id IS NULL
            AND free_agent_draft_recoveries
              .resolved_authority IS NULL
        )
      )
      OR (
        NEW.status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM auction_contexts AS context
          JOIN free_agent_draft_player_allocations AS allocation
            ON allocation.league_id = context.league_id
           AND allocation.season_id = context.season_id
           AND allocation.fad_id = context.fad_id
           AND allocation.id = context.fad_allocation_id
           AND allocation.player_id = NEW.player_id
          JOIN auction_resolutions AS resolution
            ON resolution.league_id = context.league_id
           AND resolution.season_id = context.season_id
           AND resolution.auction_id = context.auction_id
          JOIN free_agent_draft_draws AS draw
            ON draw.league_id = context.league_id
           AND draw.season_id = context.season_id
           AND draw.fad_id = context.fad_id
           AND draw.allocation_id = context.fad_allocation_id
           AND draw.auction_id = context.auction_id
          JOIN commissioner_corrections AS correction
            ON correction.league_id = allocation.league_id
           AND correction.season_id = allocation.season_id
           AND correction.feature =
                'free_agent_draft_allocation'
           AND correction.feature_record_id = allocation.id
           AND correction.corrected_at_ms = NEW.updated_at_ms
          JOIN auction_events AS event
            ON event.league_id = context.league_id
           AND event.season_id = context.season_id
           AND event.auction_id = context.auction_id
           AND event.event_type = 'auction_cancelled'
           AND event.actor_user_id = correction.actor_user_id
           AND event.occurred_at_ms = correction.corrected_at_ms
          WHERE context.league_id = NEW.league_id
            AND context.season_id = NEW.season_id
            AND context.auction_id = NEW.id
            AND (
              (
                context.source_kind = 'fad_restricted'
                AND context.fad_origin =
                  'candidate_tie_restricted'
                AND allocation.restricted_auction_id = NEW.id
                AND allocation.status IN (
                  'restricted_scheduled',
                  'restricted_active',
                  'correction_required'
                )
              )
              OR (
                context.source_kind = 'fad_open_rapid'
                AND context.fad_origin =
                  'restricted_no_improvement_fallback'
                AND allocation.fallback_open_auction_id = NEW.id
                AND allocation.status IN (
                  'restricted_fallback_open',
                  'correction_required'
                )
              )
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
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.version'
                ) = allocation.version
            AND json_extract(
                  correction.before_snapshot_json,
                  '$.status'
                ) = allocation.status
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.version'
                ) = allocation.version + 1
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.status'
                ) IN ('automatic_award', 'no_valid_offer')
            AND json_extract(
                  correction.after_snapshot_json,
                  '$.decisionCode'
                ) = 'corrected'
            AND json_extract(
                  event.metadata_json,
                  '$.correctionId'
                ) = correction.id
            AND json_extract(
                  event.metadata_json,
                  '$.actorAuthority'
                ) IN (
                  'commissioner',
                  'platform_administrator_as_commissioner'
                )
            AND NOT EXISTS (
              SELECT 1
              FROM auction_bids AS bid
              WHERE bid.league_id = NEW.league_id
                AND bid.auction_id = NEW.id
            )
        )
      )
      OR (
        NOT (
          NEW.status = 'cancelled'
          AND EXISTS (
            SELECT 1
            FROM auction_contexts
            WHERE auction_contexts.league_id = NEW.league_id
              AND auction_contexts.season_id = NEW.season_id
              AND auction_contexts.auction_id = NEW.id
              AND auction_contexts.source_kind =
                'fad_restricted'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_draws
          WHERE free_agent_draft_draws.league_id =
              NEW.league_id
            AND free_agent_draft_draws.auction_id = NEW.id
            AND free_agent_draft_draws.revealed_at_ms =
              NEW.updated_at_ms
            AND free_agent_draft_draws.version = 2
        )
      )
    )
  THEN RAISE(
    ABORT,
    'terminal FAD auction requires the exact revealed or correction draw state'
  ) END;

  SELECT CASE WHEN
    NEW.status = 'failed'
    AND EXISTS (
      SELECT 1
      FROM auction_contexts
      WHERE auction_contexts.league_id = NEW.league_id
        AND auction_contexts.season_id = NEW.season_id
        AND auction_contexts.auction_id = NEW.id
        AND auction_contexts.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
    )
    AND NOT (
      OLD.status IN ('open', 'resolving')
      AND NEW.updated_at_ms >= NEW.resolves_at_ms
      AND NOT EXISTS (
        SELECT 1
        FROM auction_resolutions
        WHERE auction_resolutions.league_id = NEW.league_id
          AND auction_resolutions.auction_id = NEW.id
      )
      AND EXISTS (
        SELECT 1
        FROM free_agent_draft_draws
        WHERE free_agent_draft_draws.league_id =
            NEW.league_id
          AND free_agent_draft_draws.auction_id = NEW.id
          AND free_agent_draft_draws.revealed_at_ms IS NULL
          AND free_agent_draft_draws.version = 1
      )
    )
  THEN RAISE(
    ABORT,
    'failed FAD auction must preserve its private draw and have no result'
  ) END;
END;

CREATE TRIGGER free_agent_drafts_clock_change_barrier BEFORE UPDATE ON free_agent_drafts
WHEN EXISTS(SELECT 1 FROM fad_timing_changes change WHERE change.league_id=OLD.league_id AND change.fad_id=OLD.id
  AND json_extract(change.before_root_json,'$.version')=OLD.version
  AND EXISTS(SELECT 1 FROM fad_auction_clock_changes clock WHERE clock.change_id=change.id AND NOT EXISTS(
    SELECT 1 FROM auctions a JOIN auction_contexts c ON c.league_id=a.league_id AND c.auction_id=a.id
    JOIN free_agent_draft_rollovers r ON r.league_id=c.league_id AND r.id=c.fad_rollover_id
    WHERE a.league_id=clock.league_id AND a.id=clock.auction_id AND a.status='open'
      AND a.version=clock.auction_version AND a.resolves_at_ms=clock.closes_at_ms
      AND r.rolls_over_at_ms=clock.closes_at_ms AND r.creation_cutoff_at_ms=clock.cutoff_at_ms)))
BEGIN SELECT RAISE(ABORT,'FAD schedule change must update every accepted auction clock atomically'); END;
CREATE TRIGGER fad_timing_changes_clock_binding BEFORE INSERT ON fad_timing_changes
WHEN EXISTS(SELECT 1 FROM fad_auction_clock_changes clock WHERE clock.change_id=NEW.id AND NOT (
 clock.league_id=NEW.league_id AND clock.fad_id=NEW.fad_id AND clock.created_at_ms=NEW.created_at_ms
 AND json_extract(NEW.before_root_json,'$.status')='rapid'
 AND EXISTS(SELECT 1 FROM json_each(NEW.after_rollovers_json) r WHERE json_extract(r.value,'$.id')=clock.rollover_id
   AND json_extract(r.value,'$.rolls_over_at_ms')=clock.closes_at_ms AND json_extract(r.value,'$.creation_cutoff_at_ms')=clock.cutoff_at_ms)
 AND EXISTS(SELECT 1 FROM json_each(NEW.before_jobs_json) j WHERE j.value=clock.before_job_json)
 AND EXISTS(SELECT 1 FROM json_each(NEW.after_jobs_json) j WHERE j.value=clock.after_job_json)))
BEGIN SELECT RAISE(ABORT,'Auction clock history must match the exact coordinated FAD change'); END;
UPDATE application_metadata SET metadata_value='74',updated_at_ms=max(updated_at_ms,74)
WHERE metadata_key='data_model_version' AND metadata_value='73';
