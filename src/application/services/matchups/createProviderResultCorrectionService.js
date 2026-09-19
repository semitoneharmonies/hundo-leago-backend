const { EXPANDED_SCORING_VERSION } = require("../../../domain/statistics/expandedScoringPolicy");

function breakdownIdentity(score) {
  return JSON.stringify(["home", "away"].map(side => ({
    teamId: score[side].teamId, legal: score[side].legal,
    players: score[side].players.map(player => ({ playerId: player.playerId, positionGroup: player.positionGroup,
      slotNumber: player.slotNumber, gamesPlayed: player.gamesPlayedDelta, scoringStats: player.scoringStats,
      scoreHundredths: player.scoreHundredths })).sort((a, b) => a.playerId.localeCompare(b.playerId)),
  })));
}

function createProviderResultCorrectionService({ repository, scoringService, clock, createId, logger = console } = {}) {
  if (!repository?.listCandidates || !repository?.commit || !scoringService?.readForCorrection || !scoringService?.readAtRefresh || !clock?.nowMs || typeof createId !== "function") {
    throw new TypeError("Provider corrections require scoped storage, sealed scoring, a clock and IDs.");
  }
  function reconcile() {
    const report = { checked: 0, corrected: 0, unchanged: 0, awaitingData: 0, requiresPlayoffReview: 0 };
    for (const candidate of repository.listCandidates()) {
      report.checked += 1;
      try {
        const scope = { leagueId: candidate.league_id, seasonId: candidate.season_id,
          weekId: candidate.matchup_week_id, matchupId: candidate.matchup_id, providers: ["nhl-completed-games"], nowMs: clock.nowMs() };
        const current = scoringService.readForCorrection(scope);
        if (current.source.pendingGameCount > 0 || current.source.freshnessStatus !== "fresh" ||
            current.home.scoringRuleVersion !== EXPANDED_SCORING_VERSION || current.away.scoringRuleVersion !== EXPANDED_SCORING_VERSION) {
          report.awaitingData += 1;
          continue;
        }
        const previous = scoringService.readAtRefresh({ ...scope, refreshId: candidate.source_refresh_id });
        if (breakdownIdentity(previous) === breakdownIdentity(current)) { report.unchanged += 1; continue; }
        const result = repository.commit({ ...scope, expectedResultVersion: candidate.result_version,
          resultId: candidate.result_id, supersedesVersionId: candidate.result_version_id,
          versionNumber: candidate.version_number + 1, refreshId: current.source.refreshId,
          homeScoreHundredths: current.home.scoreHundredths, awayScoreHundredths: current.away.scoreHundredths,
          resultVersionId: createId(), snapshotId: createId(), operationId: createId() });
        if (result.status === "requires_playoff_review") {
          report.requiresPlayoffReview += 1;
          logger.warn?.("NHL statistics correction requires playoff review", { matchupId: candidate.matchup_id, code: "PROVIDER_CORRECTION_PLAYOFF_REVIEW_REQUIRED" });
        }
        else report.corrected += 1;
      } catch (error) {
        report.awaitingData += 1;
        logger.warn?.("NHL result correction awaits complete evidence", { matchupId: candidate.matchup_id, code: error.code || "PROVIDER_CORRECTION_FAILED" });
      }
    }
    return Object.freeze(report);
  }
  return Object.freeze({ reconcile });
}

module.exports = { breakdownIdentity, createProviderResultCorrectionService };
