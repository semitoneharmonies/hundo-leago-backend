const { createHash } = require('node:crypto');
const { matchInjuryList } = require('../../../domain/players/injuryListPolicy');

function createSqliteInjuryListOperations({ database, nowMs, saveState }) {
  function preview({ rows, resolutions }) {
    const players = database.prepare("SELECT id,full_name,birth_date FROM players WHERE status='active' ORDER BY id").all();
    const states = database.prepare('SELECT * FROM player_injury_status ORDER BY id').all();
    const byId = new Map(states.map(row => [row.id, row]));
    const matched = matchInjuryList(rows, players, resolutions);
    const ids = new Set(matched.matches.map(row => row.playerId));
    const retained = [], changes = [];
    for (const row of matched.matches) {
      const before = byId.get(row.playerId);
      const change = { playerId: row.playerId, name: row.name, status: 'injured',
        timeline: row.timeline, designation: row.designation, reason: row.reason,
        expectedVersion: before?.version || 0,
        kind: before?.status === 'injured' ? 'update' : 'add' };
      if (before?.status === 'injured' && before.timeline === row.timeline && before.designation === row.designation && before.injury_reason === row.reason) retained.push(change);
      else changes.push(change);
    }
    for (const row of states) {
      if (row.status !== 'injured' || ids.has(row.id)) continue;
      const player = database.prepare('SELECT full_name FROM players WHERE id=?').get(row.id);
      changes.push({ playerId: row.id, name: player.full_name, status: 'healthy', kind: 'clear',
        timeline: null, designation: null, reason: null, expectedVersion: row.version });
    }
    const ir = database.prepare(`SELECT o.player_id AS playerId, t.name AS team, l.name AS league
      FROM player_ownerships o JOIN teams t ON t.id=o.team_id JOIN leagues l ON l.id=o.league_id
      WHERE o.roster_category='Injured Reserve' ORDER BY o.id`).all();
    const clearing = new Set(changes.filter(row => row.kind === 'clear').map(row => row.playerId));
    const warnings = ir.filter(row => clearing.has(row.playerId)).map(row => ({ ...row,
      name: changes.find(change => change.playerId === row.playerId).name }));
    // Includes all injury versions, catalogue identities and affected roster context.
    // Apply reconstructs this under the write transaction; client changes cannot
    // bypass matching, resolution, stale-preview or final-set checks.
    const revision = createHash('sha256').update(JSON.stringify({ rows, resolutions,
      players, states, ir })).digest('hex');
    return { revision, canApply: matched.unresolved.length === 0 && matched.matches.length > 0,
      total: rows.length, matched: matched.matches.length,
      counts: { add: changes.filter(row => row.kind === 'add').length,
        update: changes.filter(row => row.kind === 'update').length,
        clear: clearing.size, unchanged: retained.length },
      changes, unchanged: retained, unresolved: matched.unresolved, skipped: matched.skipped, warnings };
  }
  const apply = database.transaction(input => {
    const review = preview(input);
    if (review.revision !== input.expectedRevision) throw Object.assign(new Error('Preview changed. Review the list again.'), { code: 'INJURY_VERSION_CONFLICT' });
    if (!review.canApply) throw Object.assign(new Error('Resolve all player names before applying.'), { code: 'INJURY_LIST_INVALID' });
    const at = nowMs();
    for (const row of review.changes) {
      saveState(row.playerId, { status: row.status, source: 'admin', evidence_at_ms: at,
        observed_at_ms: at, review_reason: null, timeline: row.timeline,
        designation: row.designation, injury_reason: row.reason }, at, input.actorId,
      `Pasted injury list: ${row.kind === 'clear' ? 'absent from replacement list; returned to regular status' : 'included in reviewed list'}.`);
    }
    return { applied: review.changes.length, eligible: review.matched, counts: review.counts,
      skipped: review.skipped.map(row => row.name), warnings: review.warnings };
  });
  return { previewList: database.transaction(preview), applyList: input => apply.immediate(input) };
}
module.exports = { createSqliteInjuryListOperations };
