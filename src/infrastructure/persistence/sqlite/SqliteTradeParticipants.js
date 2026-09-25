const { TradeLifecyclePolicyError, TRADE_LIFECYCLE_CODES } = require('../../../domain/trades/tradeLifecyclePolicy');
const crypto = require('node:crypto');

// Participant rows are additive; absent rows mean an unchanged two-team trade.
function createSqliteTradeParticipants(database) {
  const rows = database.prepare(`SELECT p.*, t.name FROM trade_participants p
    JOIN teams t ON t.league_id = p.league_id AND t.id = p.team_id
    WHERE p.league_id = @leagueId AND p.trade_id = @tradeId ORDER BY p.sequence`);
  function list(input) {
    const result = rows.all(input);
    if (result.length && (result.length !== 3 || result.some((p, index) => p.sequence !== index + 1))) throw new TradeLifecyclePolicyError(TRADE_LIFECYCLE_CODES.stateInvalid);
    return result;
  }
  function ids(input) {
    const participants = list(input);
    return participants.length ? participants.map(p => p.team_id) : [input.proposingTeamId, input.receivingTeamId];
  }
  function projection(input) {
    const participants = list(input);
    return participants.length ? { participants: participants.map(p => ({
      teamId: p.team_id, name: p.name, decision: p.decision,
      respondedAtMs: p.responded_at_ms, acknowledgedAtMs: p.acknowledged_at_ms,
    })) } : {};
  }
  function actorTeam(input, { includeProposer = false } = {}) {
    if (!list(input).length) return input.receivingTeamId;
    const matches = database.prepare(`SELECT p.team_id FROM trade_participants p
      JOIN team_manager_assignments a ON a.league_id = p.league_id AND a.team_id = p.team_id
      JOIN league_memberships m ON m.league_id = a.league_id AND m.id = a.membership_id AND m.user_id = a.user_id
      JOIN users u ON u.id = a.user_id
      WHERE p.league_id = @leagueId AND p.trade_id = @tradeId AND a.user_id = @actorUserId
        AND a.status = 'accepted' AND a.accepted_at_ms IS NOT NULL AND a.ended_at_ms IS NULL
        AND m.status = 'active' AND u.status = 'active'
        AND (@includeProposer = 1 OR p.sequence <> 1)`).all({ ...input, includeProposer: includeProposer ? 1 : 0 });
    if (matches.length !== 1) throw new TradeLifecyclePolicyError(TRADE_LIFECYCLE_CODES.roleDenied);
    return matches[0].team_id;
  }
  function clearNotifications(input) {
    database.prepare(`UPDATE notifications SET read_at_ms = MAX(created_at_ms, @occurredAtMs), version = version + 1
      WHERE league_id = @leagueId AND related_feature = 'trade' AND related_record_id = @tradeId
        AND user_id = @actorUserId AND read_at_ms IS NULL`).run(input);
  }
  function respond(input, teamId, decision) {
    const result = database.prepare(`UPDATE trade_participants SET decision = @decision,
      responded_by_user_id = @actorUserId, responded_by_membership_id = @actorMembershipId,
      responded_at_ms = @occurredAtMs,
      acknowledged_at_ms = CASE WHEN @decision = 'declined' THEN @occurredAtMs ELSE acknowledged_at_ms END
      WHERE league_id = @leagueId AND trade_id = @tradeId AND team_id = @teamId
        AND (decision = 'pending' OR (@decision = 'declined' AND decision = 'accepted'))`).run({ ...input, teamId, decision });
    if (result.changes !== 1) throw new TradeLifecyclePolicyError(TRADE_LIFECYCLE_CODES.notPending);
    clearNotifications(input);
  }
  const acknowledge = database.transaction(input => {
    const trade = database.prepare('SELECT status FROM trades WHERE league_id = @leagueId AND id = @tradeId').get(input);
    if (!trade) throw new TradeLifecyclePolicyError(TRADE_LIFECYCLE_CODES.notFound);
    if (trade.status !== 'declined' || list(input).length !== 3) throw new TradeLifecyclePolicyError(TRADE_LIFECYCLE_CODES.notPending);
    const teamId = actorTeam(input, { includeProposer: true });
    database.prepare(`UPDATE trade_participants SET acknowledged_at_ms = @occurredAtMs
      WHERE league_id = @leagueId AND trade_id = @tradeId AND team_id = @teamId AND acknowledged_at_ms IS NULL`).run({ ...input, teamId });
    clearNotifications(input);
    return { code: 'TRADE_ACKNOWLEDGED', tradeId: input.tradeId, teamId };
  });
  function create(command) {
    if (!command.participantTeamIds) return;
    const insert = database.prepare(`INSERT INTO trade_participants
      (id, league_id, trade_id, team_id, sequence, decision, responded_by_user_id, responded_by_membership_id, responded_at_ms)
      VALUES (@id, @leagueId, @tradeId, @teamId, @sequence, @decision, @userId, @membershipId, @respondedAtMs)`);
    command.participantTeamIds.forEach((teamId, index) => insert.run({ ...command, id: crypto.randomUUID(), teamId, sequence: index + 1,
      decision: index === 0 ? 'accepted' : 'pending', userId: index === 0 ? command.actorUserId : null,
      membershipId: index === 0 ? command.actorMembershipId : null, respondedAtMs: index === 0 ? command.createdAtMs : null }));
  }
  return { list, ids, projection, actorTeam, respond, create, acknowledge: input => acknowledge.immediate(input) };
}
module.exports = { createSqliteTradeParticipants };
