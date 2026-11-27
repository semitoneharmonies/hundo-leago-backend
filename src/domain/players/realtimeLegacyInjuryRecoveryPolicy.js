const { normalizedName } = require('./injuryStatusPolicy');
const { resolveRealtimeIdentityCandidates, realtimeIdentityTeam } = require('./realtimeInjuryPolicy');

const validTime = value => Number.isSafeInteger(value) && value >= 0;
const name = value => typeof value === 'string' ? normalizedName(value) : '';
function position(value) {
  if (typeof value !== 'string') return null;
  const key = value.toUpperCase().trim();
  if (['F', 'C', 'L', 'R', 'LW', 'RW'].includes(key)) return 'F';
  if (['D', 'LD', 'RD'].includes(key)) return 'D';
  return key === 'G' ? 'G' : null;
}
function count(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) || 0) + 1);
  return counts;
}
function surname(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/);
  const last = name(parts.at(-1));
  return parts.length >= 2 && last.length >= 3 ? last : null;
}

// A legacy manual injury may predate this provider and have no provider ID.
// Use only the immediately previous accepted report and this incoming report;
// retained feed names are mutable and cannot prove every historical absence.
function legacyRealtimeRecoveryCandidates({ snapshot, previousRows, previousSuccessAtMs,
  previousSourceCount, previousTeamCount, catalogue, identities, mappings, statuses } = {}) {
  if (!snapshot || !validTime(snapshot.fetchedAtMs) || !validTime(previousSuccessAtMs) ||
      snapshot.fetchedAtMs <= previousSuccessAtMs) return [];
  const previous = previousRows.filter(row => row.present);
  if (!previous.length || previous.length !== previousSourceCount ||
      new Set(previous.map(row => row.teamId)).size !== previousTeamCount ||
      new Set(previous.map(row => row.providerPlayerId)).size !== previous.length ||
      previous.some(row => row.observedAtMs !== previousSuccessAtMs)) return [];
  const catalogueNames = count(catalogue, row => name(row.name));
  const cataloguePlayers = count(catalogue, row => row.playerId);
  const nhlIds = count(identities, row => row.nhlPlayerId);
  const playerIds = count(identities, row => row.playerId);
  const knownProviderPlayers = new Set(mappings.map(row => row.playerId));
  const knownNhlPlayers = new Set(mappings.map(row => row.nhlPlayerId));
  const historicalNames = new Set(previousRows.map(row => name(row.name)));
  const resolveRows = (rows, fetchedAtMs) => {
    const proposed = resolveRealtimeIdentityCandidates({ snapshot: { source: 'realtime', fetchedAtMs, rows },
      catalogue, mappings, nowMs: snapshot.fetchedAtMs }).mappings;
    const byProvider = new Map([...mappings, ...proposed].map(row => [row.providerPlayerId, row]));
    return rows.map(row => {
      const mapping = byProvider.get(row.providerPlayerId);
      const names = mapping ? [mapping.providerName, ...(mapping.aliases || [])].map(name) : [];
      return { ...row, names, mapping: mapping && names.includes(name(row.name)) ? mapping : null };
    });
  };
  const reports = [...resolveRows(previous, previousSuccessAtMs), ...resolveRows(snapshot.rows, snapshot.fetchedAtMs)];
  const result = [];
  for (const status of statuses) {
    if (status.status !== 'injured' || !['admin', 'espn'].includes(status.source) ||
        !validTime(status.evidenceAtMs) || previousSuccessAtMs <= status.evidenceAtMs) continue;
    const player = catalogue.find(row => row.playerId === status.playerId);
    const playerName = name(player?.name), playerPosition = position(player?.position);
    const playerSurname = surname(player?.name), playerTeam = realtimeIdentityTeam(player);
    if (!player || player.active !== true || !playerName || !playerPosition || !playerSurname || !playerTeam ||
        cataloguePlayers.get(player.playerId) !== 1 || catalogueNames.get(playerName) !== 1 ||
        nhlIds.get(player.nhlPlayerId) !== 1 || playerIds.get(player.playerId) !== 1 ||
        !identities.some(row => row.playerId === player.playerId && row.nhlPlayerId === player.nhlPlayerId) ||
        knownProviderPlayers.has(player.playerId) || knownNhlPlayers.has(player.nhlPlayerId) ||
        historicalNames.has(playerName)) continue;
    // Presence under a current name or reviewed alias always blocks recovery.
    // An unresolved compatible-position row is safely different only when both
    // its recognizable surname and canonical NHL team differ. Initials and
    // nicknames with the same surname still block across every team.
    const uncertain = reports.some(row => name(row.name) === playerName || row.names.includes(playerName) ||
      row.mapping?.playerId === player.playerId || row.mapping?.nhlPlayerId === player.nhlPlayerId ||
      (!row.mapping && (() => {
        const rowPosition = position(row.position);
        if (!rowPosition) return true;
        if (rowPosition && rowPosition !== playerPosition) return false;
        const rowSurname = surname(row.name), rowTeam = realtimeIdentityTeam(row);
        return !rowSurname || !rowTeam || rowTeam === playerTeam ||
          rowSurname.endsWith(playerSurname) || playerSurname.endsWith(rowSurname);
      })()));
    if (!uncertain) result.push({ playerId: player.playerId, nhlPlayerId: player.nhlPlayerId, afterMs: status.evidenceAtMs });
  }
  return result;
}

module.exports = { legacyRealtimeRecoveryCandidates };
