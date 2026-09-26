const { createSqliteTradeParticipants } = require('./SqliteTradeParticipants');

// Projection only: never alter the durable proposal, activity or audit records.
function createSqliteTradeVisibility(database) {
  const participants = createSqliteTradeParticipants(database);
  const viewerStatement = database.prepare(`SELECT
      m.permission_category, l.commissioner_membership_id,
      EXISTS (SELECT 1 FROM platform_roles r WHERE r.user_id = u.id
        AND r.role = 'platform_administrator' AND r.status = 'active'
        AND r.ended_at_ms IS NULL) AS platform_administrator
    FROM league_memberships m JOIN users u ON u.id = m.user_id
    JOIN leagues l ON l.id = m.league_id
    WHERE m.league_id = @leagueId AND m.id = @viewerMembershipId
      AND m.user_id = @viewerUserId AND m.status = 'active'
      AND u.status = 'active' AND l.status <> 'deleted'`);
  const managerStatement = database.prepare(`SELECT a.team_id FROM team_manager_assignments a
    JOIN teams t ON t.league_id = a.league_id AND t.id = a.team_id
    WHERE a.league_id = @leagueId AND a.user_id = @viewerUserId
      AND a.membership_id = @viewerMembershipId AND a.status = 'accepted'
      AND a.accepted_at_ms IS NOT NULL AND a.ended_at_ms IS NULL AND t.status <> 'erased'`);
  let approvalStatement;
  const tradeStatement = database.prepare(`SELECT t.id, t.league_id, t.status, t.completed_at_ms,
      t.proposing_team_id, a.name AS proposing_team_name,
      t.receiving_team_id, b.name AS receiving_team_name
    FROM trades t JOIN teams a ON a.league_id = t.league_id AND a.id = t.proposing_team_id
    JOIN teams b ON b.league_id = t.league_id AND b.id = t.receiving_team_id
    WHERE t.league_id = @leagueId AND t.id = @tradeId`);

  function teams(proposal) {
    return proposal.participants
      ? proposal.participants.map(p => ({ id: p.teamId, name: p.name }))
      : [proposal.proposingTeam, proposal.receivingTeam];
  }

  function canViewDetails(proposal, viewer) {
    if (Number.isSafeInteger(proposal.completedAtMs)) return true;
    if (!viewer.viewerUserId || !viewer.viewerMembershipId) return false;
    const input = { ...viewer, leagueId: proposal.leagueId };
    const authority = viewerStatement.get(input);
    if (!authority) return false;
    const teamIds = new Set(teams(proposal).map(team => team.id));
    if (managerStatement.all(input).some(row => teamIds.has(row.team_id))) return true;
    if (!['proposed', 'awaiting_commissioner_approval'].includes(proposal.storageStatus)) return false;
    const commissioner = authority.platform_administrator === 1 ||
      (authority.permission_category === 'commissioner' && authority.commissioner_membership_id === viewer.viewerMembershipId);
    if (!commissioner) return false;
    // Older held copies may predate commissioner acceptance receipts. Reads must
    // never migrate them or widen visibility just because the receipt is absent.
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_future_consideration_acceptances'").get()) return false;
    approvalStatement ||= database.prepare(`SELECT 1 FROM trade_future_consideration_acceptances a
      WHERE a.league_id = @leagueId AND a.trade_id = @tradeId
        AND EXISTS (SELECT 1 FROM trade_assets x WHERE x.league_id = a.league_id
          AND x.trade_id = a.trade_id AND x.asset_type = 'future_consideration')`);
    return Boolean(approvalStatement.get({ ...input, tradeId: proposal.id }));
  }

  function project(proposal, viewer) {
    if (canViewDetails(proposal, viewer)) return Object.freeze({ ...proposal, detailsVisible: true });
    // Allowlist prevents new asset-bearing fields or audit metadata leaking later.
    const result = { detailsVisible: false };
    for (const key of ['id', 'leagueId', 'seasonId', 'proposingTeam', 'receivingTeam',
      'status', 'storageStatus', 'createdAtMs', 'expiresAtMs', 'effectiveDeadlineAtMs', 'version']) {
      result[key] = proposal[key];
    }
    if (proposal.participants) result.participants = proposal.participants.map(({ teamId, name }) => ({ teamId, name }));
    if (proposal.assets) result.assets = [];
    if (proposal.history) result.history = [];
    return Object.freeze(result);
  }

  function projectActivity(row, viewer) {
    if (row.related_type !== 'trade') return row;
    const input = { leagueId: row.league_id, tradeId: row.related_id };
    const trade = tradeStatement.get(input);
    const proposal = trade && {
      id: trade.id, leagueId: trade.league_id, storageStatus: trade.status, completedAtMs: trade.completed_at_ms,
      proposingTeam: { id: trade.proposing_team_id, name: trade.proposing_team_name },
      receivingTeam: { id: trade.receiving_team_id, name: trade.receiving_team_name },
      ...participants.projection(input),
    };
    if (proposal && canViewDetails(proposal, viewer)) return row;
    // Preserve durable historical completion announcements whose original trade
    // was imported separately; a pending or unknown event never gets this bypass.
    if (!proposal && ['trade_completed', 'trade_reversed', 'trade_correction_required'].includes(row.event_type)) return row;
    const involvedTeams = proposal ? teams(proposal) : [];
    return Object.freeze({ ...row, actor_user_id: null, actor_authority: null, actor_display_name: null,
      team_id: null, team_name: null, player_id: null, player_full_name: null, reason: null,
      display_summary: involvedTeams.length ? `Trade involving ${involvedTeams.map(team => team.name).join(' ↔ ')}. Details are private until execution.` : 'Trade details are private until execution.',
      metadata_json: JSON.stringify({ proposalId: row.related_id, detailsVisible: false, teams: involvedTeams }),
    });
  }
  return Object.freeze({ project, projectActivity });
}

module.exports = { createSqliteTradeVisibility };
