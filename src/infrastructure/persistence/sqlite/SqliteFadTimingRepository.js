const {publishLeagueChangeAnnouncement,changedDates}=require('./leagueChangeAnnouncement');
const crypto = require('node:crypto');
const { timingError } = require('../../../domain/freeAgentDraft/fadTimingChangePolicy');
const { createSqliteNotificationWriter } = require('./SqliteNotificationWriter');
const { createFadAuctionCutoffClock } = require('./fadAuctionCutoffClock');
const { resolveSqliteLeagueOutboxWriter } = require('./SqliteLeagueOutboxWriter');
const { createSocketEventMetadata, createEmptySocketRelated } = require('../../../domain/leagues/socketInvalidation');

function createSqliteFadTimingRepository({ database, leagueOutboxWriter }) {
  const notifications = createSqliteNotificationWriter({ database });
  const outbox = resolveSqliteLeagueOutboxWriter({ database, leagueOutboxWriter });
  const cutoffClock = createFadAuctionCutoffClock(database);
  const supportsRapidTiming = database.pragma('user_version', { simple: true }) >= 77;
  const supportsActiveTiming = database.pragma('user_version', { simple: true }) >= 78;
  function state(leagueId, fadId) {
    const draft = database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=? AND id=?').get(leagueId, fadId);
    if (!draft) timingError('FAD_TIMING_NOT_FOUND');
    const readiness = database.prepare('SELECT * FROM free_agent_draft_readiness_operations WHERE league_id=? AND id=?').get(leagueId, draft.readiness_operation_id);
    const count = table => database.prepare(`SELECT COUNT(*) n FROM ${table} WHERE league_id=? AND fad_id=?`).get(leagueId, fadId).n;
    return { draft, readiness, supportsRapidTiming, supportsActiveTiming, cutoffGapMs: cutoffClock.gap({leagueId,fadId}),
      auctionClocks: supportsActiveTiming ? database.prepare(`SELECT a.id,a.league_id,a.status,a.resolves_at_ms,a.version,a.updated_at_ms,
        c.fad_rollover_id,c.source_kind,c.fad_origin,r.creation_cutoff_at_ms,
        (SELECT COUNT(*) FROM auction_resolutions x WHERE x.league_id=a.league_id AND x.auction_id=a.id) resolution_count,
        (SELECT COUNT(*) FROM free_agent_draft_recoveries x WHERE x.league_id=a.league_id AND x.auction_id=a.id) recovery_count,
        (SELECT id FROM job_runs j WHERE j.league_id=a.league_id AND j.season_id=a.season_id
          AND j.job_type='auction.resolve.target' AND j.occurrence_key='auction:'||a.id||':'||a.resolves_at_ms) job_id
        FROM auction_contexts c JOIN auctions a ON a.league_id=c.league_id AND a.id=c.auction_id
        JOIN free_agent_draft_rollovers r ON r.league_id=c.league_id AND r.id=c.fad_rollover_id
        WHERE c.league_id=? AND c.fad_id=? ORDER BY a.id`).all(leagueId,fadId) : [],
      auctionJobs: supportsActiveTiming ? database.prepare(`SELECT j.* FROM job_runs j WHERE j.league_id=? AND j.season_id=?
        AND j.job_type='auction.resolve.target' AND j.status='pending' AND j.attempt_count=0 AND EXISTS(
          SELECT 1 FROM auction_contexts c JOIN auctions a ON a.league_id=c.league_id AND a.id=c.auction_id
          WHERE c.league_id=j.league_id AND c.fad_id=?
          AND j.occurrence_key='auction:'||c.auction_id||':'||a.resolves_at_ms) ORDER BY j.id`).all(leagueId,draft.season_id,fadId) : [],
      queueRoundIds: database.prepare(`SELECT r.id FROM free_agent_draft_rollovers r WHERE r.league_id=? AND r.fad_id=? AND
        EXISTS(SELECT 1 FROM free_agent_draft_nomination_queue q
          JOIN free_agent_draft_rollovers source ON source.league_id=q.league_id AND source.id=q.source_rollover_id
          JOIN free_agent_draft_rollovers opening ON opening.league_id=q.league_id AND opening.id=q.target_opening_rollover_id
          WHERE q.league_id=r.league_id AND q.fad_id=r.fad_id AND
            (r.id IN(q.source_rollover_id,q.target_opening_rollover_id,q.resolution_rollover_id)
              OR r.sequence=source.sequence+1 OR r.sequence=opening.sequence+1)) ORDER BY r.id`).all(leagueId,fadId).map(r=>r.id),
      // Presence and clocks only: never load players, managers, cards or offers.
      committedRoundIds: database.prepare(`SELECT r.id FROM free_agent_draft_rollovers r WHERE r.league_id=? AND r.fad_id=? AND (
        EXISTS(SELECT 1 FROM auction_contexts a WHERE a.league_id=r.league_id AND a.fad_rollover_id=r.id) OR
        EXISTS(SELECT 1 FROM free_agent_draft_nomination_queue q
          JOIN free_agent_draft_rollovers source ON source.league_id=q.league_id AND source.id=q.source_rollover_id
          JOIN free_agent_draft_rollovers opening ON opening.league_id=q.league_id AND opening.id=q.target_opening_rollover_id
          WHERE q.league_id=r.league_id AND q.fad_id=r.fad_id AND
            (r.id IN(q.source_rollover_id,q.target_opening_rollover_id,q.resolution_rollover_id)
             OR r.sequence=source.sequence+1 OR r.sequence=opening.sequence+1))) ORDER BY r.id`).all(leagueId,fadId).map(r=>r.id),
      busyJobs: database.prepare(`SELECT id,status,version FROM job_runs WHERE league_id=? AND season_id=? AND occurrence_key LIKE ?
        AND status IN ('leased','running','failed') ORDER BY id`).all(leagueId,draft.season_id,`fad:${fadId}:%`),
      league: database.prepare('SELECT status,current_season_id,version FROM leagues WHERE id=?').get(leagueId),
      control: database.prepare('SELECT * FROM fad_deadline_controls WHERE league_id=? AND id=?').get(leagueId, fadId) || null,
      rollovers: database.prepare('SELECT * FROM free_agent_draft_rollovers WHERE league_id=? AND fad_id=? ORDER BY sequence').all(leagueId, fadId),
      jobs: database.prepare(`SELECT * FROM job_runs WHERE league_id=? AND season_id=? AND (id IN (?,?) OR occurrence_key LIKE ?) ORDER BY id`)
        .all(leagueId, draft.season_id, readiness?.deadline_job_run_id || '', readiness?.reminder_job_run_id || '', `fad:${fadId}:rollover:%`),
      closedCards: database.prepare("SELECT COUNT(*) n FROM candidate_cards WHERE league_id=? AND fad_id=? AND status<>'open'").get(leagueId, fadId).n,
      auctions: count('auction_contexts'), allocations: count('free_agent_draft_player_allocations'), snapshots: count('candidate_card_snapshots') };
  }
  function update(table, before, after, fields) {
    const changed = database.prepare(`UPDATE ${table} SET ${fields.map(f => `${f}=@${f}`).join(',')} WHERE id=@id AND league_id=@league_id AND version=@priorVersion`)
      .run({ ...Object.fromEntries(fields.map(f => [f, after[f]])), id: after.id, league_id: after.league_id, priorVersion: before.version });
    if (changed.changes !== 1) timingError();
  }
  return {
    state, transaction: work => database.transaction(work).immediate(),
    replay: (leagueId, actorUserId, key) => database.prepare('SELECT id,request_hash FROM fad_timing_changes WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId, actorUserId, key),
    apply({ state: before, plan, actorUserId, authority, clientKey, requestHash, nowMs }) {
      const id = crypto.randomUUID();
      const { draft, rollovers, jobs } = before;
      const auctionChanges = plan.auctionChanges || [];
      for (const change of auctionChanges) database.prepare(`INSERT INTO fad_auction_clock_changes
        (id,league_id,fad_id,change_id,auction_id,rollover_id,previous_closes_at_ms,closes_at_ms,previous_cutoff_at_ms,cutoff_at_ms,
         previous_auction_version,auction_version,before_job_json,after_job_json,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(),draft.league_id,draft.id,id,change.auction.id,change.auction.fad_rollover_id,
          change.auction.resolves_at_ms,change.closesAtMs,change.auction.creation_cutoff_at_ms,change.cutoffAtMs,
          change.auction.version,change.auction.version+1,JSON.stringify(change.job),JSON.stringify(change.afterJob),nowMs);
      database.prepare(`INSERT INTO fad_timing_changes (id,league_id,fad_id,actor_user_id,client_key,request_hash,reason,
        before_root_json,after_root_json,before_rollovers_json,after_rollovers_json,before_jobs_json,after_jobs_json,before_control_json,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,draft.league_id,draft.id,actorUserId,clientKey,requestHash,plan.proposed.reason,
          JSON.stringify(draft),JSON.stringify(plan.afterRoot),JSON.stringify(rollovers),JSON.stringify(plan.afterRollovers),
          JSON.stringify([...jobs,...auctionChanges.map(c=>c.job)]),JSON.stringify([...plan.afterJobs,...auctionChanges.map(c=>c.afterJob)]),JSON.stringify(before.control),nowMs);
      for (const change of auctionChanges) {
        update('job_runs',change.job,change.afterJob,['scheduled_for_ms','occurrence_key','next_attempt_at_ms','updated_at_ms','version']);
        update('auctions',change.auction,{...change.auction,resolves_at_ms:change.closesAtMs,updated_at_ms:Math.max(nowMs,change.auction.updated_at_ms),
          version:change.auction.version+1},['resolves_at_ms','updated_at_ms','version']);
      }
      for (const [i, j] of jobs.entries()) if (j.version !== plan.afterJobs[i].version) update('job_runs', j, plan.afterJobs[i],
        ['scheduled_for_ms','occurrence_key','next_attempt_at_ms','updated_at_ms','version']);
      // Moving earlier first and later last avoids UNIQUE collisions when one
      // round takes the old time of an adjacent round. Identities are retained.
      const order = rollovers.map((r, i) => i).sort((a, b) => {
        const left = plan.afterRollovers[a].rolls_over_at_ms <= rollovers[a].rolls_over_at_ms;
        const right = plan.afterRollovers[b].rolls_over_at_ms <= rollovers[b].rolls_over_at_ms;
        return left !== right ? (left ? -1 : 1) : left ? a - b : b - a;
      });
      for (const i of order) if (rollovers[i].version !== plan.afterRollovers[i].version) update('free_agent_draft_rollovers', rollovers[i], plan.afterRollovers[i],
        ['opens_at_ms','creation_cutoff_at_ms','rolls_over_at_ms','updated_at_ms','version']);
      update('free_agent_drafts', draft, plan.afterRoot,
        ['candidate_deadline_at_ms','help_opens_at_ms','initial_rollover_times_json','updated_at_ms','version']);
      if (draft.status === 'cards_open') database.prepare('DELETE FROM fad_deadline_controls WHERE league_id=? AND id=?').run(draft.league_id,draft.id);
      const message = draft.status === 'rapid'
        ? 'The commissioner updated Free Agent Draft round dates. Check the draft and auction pages for the new closing times.'
        : 'The commissioner updated the Candidate Card target deadline and auction schedule. Check the Free Agent Draft for the new dates.';
      database.prepare(`INSERT INTO league_activity (id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
        VALUES (?,?,?,'league_fad_deadline_changed',?,?,'free_agent_draft',?,?,?,?,?)`)
        .run(id,draft.league_id,draft.season_id,actorUserId,authority,draft.id,message,plan.proposed.reason,JSON.stringify({ fadId: draft.id, timingChangeId: id }),nowMs);
      const recipients = database.prepare("SELECT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(draft.league_id);
      for (const user of recipients) notifications.insert({ id: crypto.randomUUID(), userId: user.id, leagueId: draft.league_id,
        eventType: 'league_fad_deadline_changed', messageDataJson: JSON.stringify({ message,leagueId:draft.league_id,fadId:draft.id }),
        relatedFeature:'free_agent_draft',relatedRecordId:draft.id,deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,
        deduplicationKey:`fad-timing:${id}:${user.id}` });
      for (const change of auctionChanges) outbox.write({ id:crypto.randomUUID(),leagueId:draft.league_id,
        eventType:'auction.changed',aggregateType:'auction',aggregateId:change.auction.id,
        payload:createSocketEventMetadata({eventType:'auction.changed',version:change.auction.version+1,
          reasonCode:'auction_changed',occurredAtMs:nowMs,related:createEmptySocketRelated({fadId:draft.id,auctionId:change.auction.id})}),
        occurredAtMs:nowMs,audiences:[{kind:'league'}] });
      const zone=database.prepare('SELECT timezone FROM leagues WHERE id=?').get(draft.league_id).timezone;
      const dates=changedDates(draft,plan.afterRoot,{candidate_deadline_at_ms:'Candidate Card deadline'},zone);
      const rounds=rollovers.flatMap((round,i)=>changedDates(round,plan.afterRollovers[i],{opens_at_ms:'Round '+round.sequence+' opens',creation_cutoff_at_ms:'Round '+round.sequence+' new-auction cutoff',rolls_over_at_ms:'Round '+round.sequence+' closes'},zone));
      const allDates=[...dates,...rounds];
      publishLeagueChangeAnnouncement(database,{id,leagueId:draft.league_id,actorUserId,title:'Free Agent Draft dates changed',message:message+'\n'+allDates.slice(0,17).join('\n')+(allDates.length>17?'\nMore dates changed; review the draft schedule.':''),reason:plan.proposed.reason,nowMs});
      return { id };
    },
  };
}
module.exports = { createSqliteFadTimingRepository };
