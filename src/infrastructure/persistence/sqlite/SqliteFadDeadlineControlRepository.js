const crypto = require("node:crypto");
const { createSqliteNotificationWriter } = require("./SqliteNotificationWriter");

function supportsSoftFadDeadline(database) {
  return database.prepare("PRAGMA user_version").get().user_version >= 68;
}
function deadlineControlError(code = "FAD_DEADLINE_CONTROL_CONFLICT") {
  const error = new Error(code); error.code = code; throw error;
}

function createSqliteFadDeadlineControlRepository({ database }) {
  const notifications = createSqliteNotificationWriter({ database });
  const cutoffClock=require("./fadAuctionCutoffClock").createFadAuctionCutoffClock(database);
  const read = database.prepare("SELECT * FROM fad_deadline_controls WHERE league_id=? AND id=?");
  const root = database.prepare(`SELECT f.*, l.status AS league_status FROM free_agent_drafts f
    JOIN leagues l ON l.id=f.league_id AND l.current_season_id=f.season_id
    WHERE f.league_id=? AND f.id=?`);
  const save = database.prepare(`INSERT INTO fad_deadline_controls
    (id,league_id,season_id,mode,reason,actor_user_id,created_at_ms,updated_at_ms)
    VALUES (@fadId,@leagueId,@seasonId,@mode,@reason,@actorUserId,@nowMs,@nowMs)
    ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,reason=excluded.reason,
      actor_user_id=excluded.actor_user_id,updated_at_ms=excluded.updated_at_ms,
      version=fad_deadline_controls.version+1`);
  const members = database.prepare(`SELECT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.league_id=? AND m.status='active' AND u.status='active'`);
  function publish(record, message) {
    const eventId = crypto.randomUUID();
    database.prepare(`INSERT INTO league_activity
      (id,league_id,season_id,event_type,actor_user_id,actor_authority,team_id,player_id,
       related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
      VALUES (?,?,?,?,?,?,NULL,NULL,'free_agent_draft',?,?,?,?,?)`).run(
      eventId, record.leagueId, record.seasonId, "league_fad_deadline_changed", record.actorUserId,
      record.actorAuthority || "system", record.fadId, message, record.reason,
      JSON.stringify({ fadId: record.fadId, mode: record.mode }), record.nowMs);
    for (const user of members.all(record.leagueId)) notifications.insert({
      id: crypto.randomUUID(), userId: user.id, leagueId: record.leagueId,
      eventType: "league_fad_deadline_changed", messageDataJson: JSON.stringify({ message, leagueId: record.leagueId, fadId: record.fadId }),
      relatedFeature: "free_agent_draft", relatedRecordId: record.fadId, deliveryStatus: "delivered",
      createdAtMs: record.nowMs, deliveredAtMs: record.nowMs,
      deduplicationKey: `fad-deadline-control:${eventId}:${user.id}`,
    });
  }
  return {
    transaction: work => database.transaction(work).immediate(),
    root: (leagueId, fadId) => root.get(leagueId, fadId),
    read: (leagueId, fadId) => read.get(leagueId, fadId),
    permitsIncomplete: (leagueId, fadId) => read.get(leagueId, fadId)?.mode === "proceed",
    state(leagueId, fadId) {
      const draft = root.get(leagueId, fadId);
      if (!draft) deadlineControlError("FAD_DEADLINE_CONTROL_NOT_FOUND");
      const control = read.get(leagueId, fadId);
      const cards = database.prepare(`SELECT c.team_id AS teamId,t.name AS teamName,c.version,
          c.completeness_code AS completeness,c.allocation_eligibility AS eligibility,
          c.filled_mandatory_count+c.filled_bench_count AS filled
        FROM candidate_cards c JOIN teams t ON t.id=c.team_id AND t.league_id=c.league_id
        WHERE c.league_id=? AND c.fad_id=? ORDER BY c.team_id`).all(leagueId, fadId);
      const jobs = database.prepare(`SELECT j.id,j.status,j.version,j.scheduled_for_ms AS scheduledForMs,
          j.lease_expires_at_ms AS leaseExpiresAtMs
        FROM job_runs j JOIN free_agent_draft_readiness_operations r ON r.deadline_job_run_id=j.id AND r.league_id=j.league_id
        WHERE r.league_id=? AND r.created_fad_id=?`).all(leagueId, fadId);
      const next = database.prepare(`SELECT MIN(rolls_over_at_ms) AS at FROM free_agent_draft_rollovers
        WHERE league_id=? AND fad_id=? AND status='scheduled'`).get(leagueId, fadId);
      return { draft, control: control || null, cards, jobs, nextRolloverAtMs: next.at, cutoffGapMs:cutoffClock.gap({leagueId,fadId}) };
    },
    holdClaimed(command) {
      return database.transaction(() => {
        const draft = root.get(command.leagueId, command.fadId);
        if (!draft || draft.status !== "cards_open") deadlineControlError();
        const released = database.prepare(`UPDATE job_runs SET status='pending',lease_owner=NULL,
          lease_token=NULL,lease_expires_at_ms=NULL,started_at_ms=NULL,completed_at_ms=NULL,
          result_json=NULL,last_error_code=NULL,next_attempt_at_ms=NULL,updated_at_ms=@executedAtMs,version=version+1
          WHERE id=@runId AND league_id=@leagueId AND job_type='fad_deadline' AND status='running'
            AND version=@expectedJobVersion AND lease_token=@leaseToken AND lease_owner=@leaseOwner
            AND lease_expires_at_ms>@executedAtMs`).run(command);
        if (released.changes !== 1) deadlineControlError();
        if (read.get(command.leagueId, command.fadId)?.mode !== "held") {
          const record = { leagueId: command.leagueId, seasonId: command.seasonId, fadId: command.fadId,
            mode: "held", reason: "Candidate Cards require attention before allocation.",
            actorUserId: null, nowMs: command.executedAtMs };
          save.run(record);
          publish(record, "The Candidate Card deadline is on hold. Managers can continue editing their own cards.");
        }
        return { outcome: "held", runId: command.runId, fadId: command.fadId };
      }).immediate();
    },
    replay(leagueId, actorUserId, key) {
      return database.prepare("SELECT * FROM fad_deadline_commands WHERE league_id=? AND actor_user_id=? AND client_key=?")
        .get(leagueId, actorUserId, key);
    },
    proceed(record) {
      const priorVersion = read.get(record.leagueId, record.fadId)?.version || 0;
      save.run({ fadId: record.fadId, leagueId: record.leagueId, seasonId: record.seasonId,
        mode: "proceed", reason: record.reason, actorUserId: record.actorUserId, nowMs: record.nowMs });
      const id = crypto.randomUUID();
      database.prepare(`INSERT INTO fad_deadline_commands
        (id,league_id,fad_id,actor_user_id,client_key,request_hash,reason,prior_control_version,control_version,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,record.leagueId,record.fadId,record.actorUserId,
        record.clientKey,record.requestHash,record.reason,priorVersion,priorVersion+1,record.nowMs);
      publish({ ...record, mode: "proceed" }, "The commissioner authorized processing of the saved Candidate Cards.");
      return { id, controlVersion: priorVersion + 1 };
    },
  };
}

module.exports = { supportsSoftFadDeadline, deadlineControlError, createSqliteFadDeadlineControlRepository };
