const {
  calculateWeeklyScore,
} = require("../../domain/matchups/calculateWeeklyScore");
const { createJobRunner } = require("../runJob");

const JOB_NAME = "matchups:finalizeResults";

function createFinalizeMatchupResultsJob({
  leagueStore,
  statisticsRepository,
  publisher = { publish() {} },
  clock = { nowMs: Date.now },
  logger = console,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createFinalizeMatchupResultsJob requires a leagueStore"
    );
  }
  if (!statisticsRepository) {
    throw new TypeError(
      "createFinalizeMatchupResultsJob requires a statisticsRepository"
    );
  }
  if (
    !clock ||
    typeof clock.nowMs !== "function"
  ) {
    throw new TypeError(
      "createFinalizeMatchupResultsJob requires clock.nowMs"
    );
  }

  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const state = leagueStore.loadLeague();
      const matchups = state?.matchups || {};
      const weeks = Array.isArray(
        matchups.scheduleWeeks
      )
        ? matchups.scheduleWeeks
        : [];
      const currentWeekIndex = Number(
        matchups.currentWeekIndex || 0
      );
      const week = weeks[currentWeekIndex] || null;

      if (!week) {
        return {
          status: "skipped",
          reason: "noWeek",
        };
      }

      const nowMs = clock.nowMs();
      if (
        Number.isFinite(week.weekStartAtMs) &&
        nowMs < Number(week.weekStartAtMs)
      ) {
        return {
          status: "skipped",
          reason: "beforeWeekStart",
        };
      }
      if (
        !week.weekId ||
        !Number.isFinite(week.weekEndAtMs)
      ) {
        return {
          status: "skipped",
          reason: "missingFinalizationConfiguration",
        };
      }
      if (nowMs < week.weekEndAtMs) {
        return {
          status: "skipped",
          reason: "beforeWeekEnd",
        };
      }

      const weekId = String(week.weekId);
      const resultsByWeek = {
        ...(matchups.resultsByWeek || {}),
      };
      if (resultsByWeek[weekId]) {
        return {
          status: "skipped",
          reason: "alreadyFinalized",
          weekId,
        };
      }

      const baseline =
        matchups.baselineByWeekId?.[weekId] || null;
      if (!baseline?.byPlayerId) {
        return {
          status: "skipped",
          reason: "baselineMissing",
          weekId,
        };
      }
      if (!statisticsRepository.cacheExists()) {
        return {
          status: "skipped",
          reason: "statsCacheMissing",
          weekId,
        };
      }

      const statsJson = statisticsRepository.readCache();
      const score = calculateWeeklyScore({
        state,
        statsJson,
        nowMs,
      });
      const perTeam = {};
      for (const team of score.teams) {
        perTeam[team.teamName] = {
          weeklyFP: team.weeklyFP,
          locked: team.locked,
          lockedAtMs: team.lockedAtMs,
        };
      }

      resultsByWeek[weekId] = {
        weekId,
        finalizedAtMs: nowMs,
        weekIndex: currentWeekIndex,
        weekEndAtMs: week.weekEndAtMs,
        baselineCapturedAtMs:
          baseline.capturedAtMs ?? null,
        baselineStatsLastUpdatedAt:
          baseline.statsLastUpdatedAt ?? null,
        statsLastUpdatedAt:
          statsJson?.lastUpdatedAt ?? null,
        perTeam,
      };

      const nextState = {
        ...state,
        matchups: {
          ...matchups,
          resultsByWeek,
        },
      };

      await leagueStore.saveLeague(nextState, {
        savedBy: "system:finalizeWeeklyResults",
      });
      await publisher.publish("league:updated", {
        reason: "matchups:weekFinalized",
        weekId,
      });

      return {
        status: "succeeded",
        weekId,
        teamCount: Object.keys(perTeam).length,
      };
    },
  });
}

module.exports = {
  JOB_NAME,
  createFinalizeMatchupResultsJob,
};
