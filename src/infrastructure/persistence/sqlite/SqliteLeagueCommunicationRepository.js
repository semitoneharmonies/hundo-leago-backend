const { createSqliteNotificationWriter } = require("./SqliteNotificationWriter");

function createSqliteLeagueCommunicationRepository({ database, notificationWriter } = {}) {
  const notifications = notificationWriter || createSqliteNotificationWriter({ database });
  const members = database.prepare(`
    SELECT u.id AS userId, u.display_name AS displayName
    FROM league_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.league_id = ? AND m.status = 'active' AND u.status = 'active'
    ORDER BY u.id`);
  const managers = database.prepare(`
    SELECT DISTINCT u.id AS userId, u.display_name AS displayName
    FROM team_manager_assignments a JOIN users u ON u.id = a.user_id
    JOIN league_memberships m ON m.id = a.membership_id AND m.league_id = a.league_id AND m.user_id = u.id
    JOIN teams t ON t.id = a.team_id AND t.league_id = a.league_id
    WHERE a.league_id = ? AND a.status = 'accepted' AND a.ended_at_ms IS NULL
      AND m.status = 'active' AND u.status = 'active' AND t.status = 'active'
    ORDER BY u.id`);
  const invitations = database.prepare(`
    SELECT DISTINCT u.id AS userId, u.display_name AS displayName
    FROM league_invitations i JOIN users u ON u.id = i.invited_user_id
    WHERE i.league_id = ? AND i.status = 'pending' AND i.expires_at_ms > ?
      AND u.status = 'active' ORDER BY u.id`);
  // Select operational status only. Never load players, offer values, or card contents.
  const cards = database.prepare(`
    SELECT t.id AS teamId, t.name AS teamName,
      COALESCE(c.filled_mandatory_count + c.filled_bench_count, 0) AS filledCount,
      c.completeness_code AS completenessCode, c.allocation_eligibility AS eligibility,
      u.id AS userId, u.display_name AS displayName
    FROM free_agent_drafts f
    JOIN leagues l ON l.id = f.league_id AND l.current_season_id = f.season_id
    JOIN teams t ON t.league_id = f.league_id AND t.status = 'active'
    LEFT JOIN candidate_cards c ON c.fad_id = f.id AND c.league_id = f.league_id AND c.team_id = t.id AND c.status = 'open'
    LEFT JOIN team_manager_assignments a ON a.team_id = t.id AND a.league_id = t.league_id
      AND a.status = 'accepted' AND a.ended_at_ms IS NULL
    LEFT JOIN league_memberships m ON m.id = a.membership_id AND m.league_id = t.league_id
      AND m.user_id = a.user_id AND m.status = 'active'
    LEFT JOIN users u ON u.id = m.user_id AND u.status = 'active'
    WHERE f.league_id = ? AND f.status = 'cards_open'
      AND f.deadline_locked_at_ms IS NULL ORDER BY t.name, t.id`);
  const findReplay = database.prepare(`SELECT * FROM league_communications
    WHERE league_id = ? AND created_by_user_id = ? AND client_key = ?`);
  const findOne = database.prepare("SELECT * FROM league_communications WHERE league_id = ? AND id = ?");
  const list = database.prepare(`SELECT c.*, u.display_name AS authorName FROM league_communications c
    JOIN users u ON u.id = c.created_by_user_id WHERE c.league_id = ?
      AND (? = 1 OR (c.kind = 'announcement' AND c.archived_at_ms IS NULL
        AND (c.expires_at_ms IS NULL OR c.expires_at_ms > ?)))
    ORDER BY c.pinned DESC, c.created_at_ms DESC, c.id LIMIT 100`);
  const insert = database.prepare(`INSERT INTO league_communications
    (id, league_id, created_by_user_id, kind, title, body, audience, pinned, expires_at_ms,
      notify, recipient_count, client_key, request_hash, created_at_ms)
    VALUES (@id, @leagueId, @actorUserId, @kind, @title, @body, @audience, @pinned, @expiresAtMs,
      @notify, @recipientCount, @clientKey, @requestHash, @nowMs)`);
  const archive = database.prepare(`UPDATE league_communications SET archived_at_ms = @nowMs,
    archived_by_user_id = @actorUserId, version = version + 1
    WHERE league_id = @leagueId AND id = @id AND version = @version
      AND kind = 'announcement' AND archived_at_ms IS NULL`);

  function cardProgress(leagueId) {
    return cards.all(leagueId).map(row => ({ teamId: row.teamId, teamName: row.teamName,
      userId: row.userId, displayName: row.displayName,
      status: row.filledCount === 0 ? "empty" : row.completenessCode === "complete" &&
        row.eligibility === "eligible" ? "complete" : "incomplete" }));
  }

  return {
    transaction: work => database.transaction(work).immediate(),
    cardProgress,
    recipients(leagueId, audience, nowMs) {
      if (audience === "members") return members.all(leagueId);
      if (audience === "managers") return managers.all(leagueId);
      if (audience === "pending_invitations") return invitations.all(leagueId, nowMs);
      const pending = cardProgress(leagueId).filter(row => row.status !== "complete" && row.userId);
      return [...new Map(pending.map(row => [row.userId, { userId: row.userId, displayName: row.displayName }])).values()]
        .sort((a, b) => a.userId.localeCompare(b.userId));
    },
    list: (leagueId, history, nowMs) => list.all(leagueId, Number(history), nowMs),
    find: (leagueId, id) => findOne.get(leagueId, id),
    replay: (leagueId, userId, key) => findReplay.get(leagueId, userId, key),
    insert(record) { insert.run({ ...record, pinned: Number(record.pinned), notify: Number(record.notify) }); },
    archive: record => archive.run(record).changes,
    notify: record => notifications.insert(record),
  };
}

module.exports = { createSqliteLeagueCommunicationRepository };
