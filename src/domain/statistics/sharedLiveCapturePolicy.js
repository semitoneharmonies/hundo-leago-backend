const { createPlayerGameCoverageRequirements } = require("./playerGameCoveragePolicy");
const { normalizeExpandedSnapshot } = require("./expandedStatisticsSnapshotPolicy");
const { normalizeGameRecord, stableId, timestamp } = require("./sharedGameEvidencePolicy");

// Converts one fully normalized NHL capture without querying or changing storage.
// The completion transaction still verifies current identities and requirements.
function buildSharedLiveCapture(command) {
  if (command?.provider !== "nhl-completed-games" || command.playerIdentityProvider !== "nhl" ||
      !Array.isArray(command.rows) || command.rows.length === 0 || !Array.isArray(command.playerGameRows) ||
      !Array.isArray(command.playerGameCoverage)) throw new TypeError("A complete NHL capture is required for shared evidence.");
  const requirements = createPlayerGameCoverageRequirements({ nhlSeasonKey: command.nhlSeasonKey,
    playerIdentityProvider: command.playerIdentityProvider, requiredPlayers: command.requiredPlayers,
    requiredPlayerGames: command.requiredPlayerGames });
  if (requirements.requirementsSha256 !== command.requirementsSha256) throw new TypeError("Shared capture requirements changed.");
  const expanded = normalizeExpandedSnapshot(command.expandedScoring, {
    nhlSeasonKey: command.nhlSeasonKey, totals: command.rows, observations: command.playerGameRows,
  });
  const capturedAtMs = timestamp(command.completedAtMs);
  const observedAtMs = timestamp(command.rows[0].sourceUpdatedAtMs);
  if (observedAtMs > capturedAtMs || [...command.rows, ...command.playerGameRows].some(row => row.sourceUpdatedAtMs !== observedAtMs)) {
    throw new TypeError("Shared NHL evidence requires one consistent observation time.");
  }
  const required = new Map(requirements.requiredPlayers.map(player => [player.providerPlayerId, player]));
  const byPlayer = new Map(requirements.requiredPlayers.map(player => [player.playerId, player]));
  const coverage = new Map();
  for (const entry of command.playerGameCoverage) {
    if (byPlayer.get(entry.playerId)?.providerPlayerId !== entry.providerPlayerId) throw new TypeError("Shared coverage identity changed.");
    if (entry.disposition !== "expected_game") continue;
    const key = `${entry.providerPlayerId}\u0000${entry.nhlGameId}`;
    if (coverage.has(key)) throw new TypeError("Shared capture repeats game coverage.");
    coverage.set(key, entry);
  }
  if (coverage.size !== command.playerGameRows.length) throw new TypeError("Shared capture game coverage is incomplete.");
  const categories = new Map(expanded.playerGameRows.map(row => [`${row.playerId}\u0000${row.nhlGameId}`, row]));
  const seen = new Set();
  const records = command.playerGameRows.map(row => {
    const key = `${row.externalPlayerId}\u0000${row.nhlGameId}`;
    const player = required.get(row.externalPlayerId), entry = coverage.get(key), scoring = categories.get(key);
    if (!player || !entry || !scoring || seen.has(key) || entry.playerId !== player.playerId ||
        entry.nhlGameScheduledStartsAtMs !== row.nhlGameScheduledStartsAtMs || entry.observedGameState !== row.observedGameState) {
      throw new TypeError("Shared game observations do not match their coverage.");
    }
    seen.add(key);
    return normalizeGameRecord({ playerId: player.playerId, providerPlayerId: player.providerPlayerId,
      providerTeamId: entry.providerTeamId, nhlGameId: row.nhlGameId, scheduledStartsAtMs: row.nhlGameScheduledStartsAtMs,
      gameState: row.observedGameState, gamesPlayed: scoring.gamesPlayed, goals: row.goals, assists: row.assists,
      scoringRuleVersion: expanded.scoringRuleVersion, scoringStats: scoring.scoringStats });
  });
  for (const game of requirements.requiredPlayerGames) {
    const entry = coverage.get(`${game.providerPlayerId}\u0000${game.nhlGameId}`);
    if (!entry || entry.playerId !== game.playerId || entry.providerTeamId !== game.providerTeamId ||
        entry.nhlGameScheduledStartsAtMs !== game.nhlGameScheduledStartsAtMs) throw new TypeError("Shared capture lost historical game evidence.");
  }
  return Object.freeze({ refreshId: stableId(command.refreshId), statSourceId: stableId(command.statSourceId),
    nhlSeasonKey: command.nhlSeasonKey, observedAtMs, capturedAtMs, records: Object.freeze(records) });
}

module.exports = { buildSharedLiveCapture };
