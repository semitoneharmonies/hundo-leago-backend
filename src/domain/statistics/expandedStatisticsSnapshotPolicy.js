const { hashCanonicalJsonV1 } = require("../leagues/seasonRolloverEvidencePolicy");
const { EXPANDED_SCORING_VERSION, usesExpandedScoring, normalizeScoringStats } = require("./expandedScoringPolicy");

function normalizeExpandedSnapshot(value, { nhlSeasonKey, totals, observations }) {
  if (!usesExpandedScoring(nhlSeasonKey) || value?.scoringRuleVersion !== EXPANDED_SCORING_VERSION ||
      !Array.isArray(value.totalsRows) || !Array.isArray(value.playerGameRows)) {
    throw new TypeError("A complete expanded statistics snapshot for 2026–27 is required.");
  }
  function validate(rows, expectedRows, game) {
    const key = (row) => `${row.externalPlayerId ?? row.playerId}${game ? `:${row.nhlGameId}` : ""}`;
    const expected = new Map(expectedRows.map((row) => [key(row), row]));
    const seen = new Set();
    const normalized = rows.map((row) => {
      const id = key(row), expectedRow = expected.get(id);
      if (!expectedRow || seen.has(id)) throw new TypeError("Expanded statistics contain an unknown or duplicate player-game.");
      seen.add(id);
      const scoringStats = normalizeScoringStats(row.scoringStats);
      if (!game && expectedRow.gamesPlayed === 0 && Object.values(scoringStats).some((count) => count !== 0)) throw new TypeError("A player without games cannot have scoring statistics.");
      if (game && (![0, 1].includes(row.gamesPlayed) || (expectedRow.observedGameState !== "final" && row.gamesPlayed !== 0) || (row.gamesPlayed === 0 && Object.values(scoringStats).some((count) => count !== 0)))) throw new TypeError("Expanded game participation is invalid.");
      if (scoringStats.evenStrengthGoals + scoringStats.powerPlayGoals + scoringStats.shortHandedGoals !== expectedRow.goals ||
          scoringStats.primaryAssists + scoringStats.secondaryAssists !== expectedRow.assists ||
          (game && expectedRow.observedGameState !== "final" && Object.values(scoringStats).some((count) => count !== 0))) {
        throw new TypeError("Expanded categories do not reconcile with the completed-game snapshot.");
      }
      return { playerId: String(expectedRow.externalPlayerId ?? expectedRow.playerId), ...(game ? { nhlGameId: String(row.nhlGameId), gamesPlayed: row.gamesPlayed } : {}), scoringStats };
    });
    if (seen.size !== expected.size) throw new TypeError("Expanded statistics have incomplete player coverage.");
    normalized.sort((a, b) => key(a).localeCompare(key(b), "en"));
    return Object.freeze(normalized.map(Object.freeze));
  }
  return Object.freeze({ scoringRuleVersion: EXPANDED_SCORING_VERSION,
    totalsRows: validate(value.totalsRows, totals, false),
    playerGameRows: validate(value.playerGameRows, observations, true) });
}

function expandedSnapshotHash(value) {
  return hashCanonicalJsonV1(value);
}

module.exports = { normalizeExpandedSnapshot, expandedSnapshotHash };
