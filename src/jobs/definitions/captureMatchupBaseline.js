const { createJobRunner } = require("../runJob");

const JOB_NAME = "matchups:captureBaseline";

function createCaptureMatchupBaselineJob({
  leagueStore,
  statisticsRepository,
  publisher = { publish() {} },
  clock = { nowMs: Date.now },
  logger = console,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createCaptureMatchupBaselineJob requires a leagueStore"
    );
  }
  if (!statisticsRepository) {
    throw new TypeError(
      "createCaptureMatchupBaselineJob requires a statisticsRepository"
    );
  }
  if (
    !clock ||
    typeof clock.nowMs !== "function"
  ) {
    throw new TypeError(
      "createCaptureMatchupBaselineJob requires clock.nowMs"
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
        !Number.isFinite(week.baselineAtMs)
      ) {
        return {
          status: "skipped",
          reason: "missingBaselineConfiguration",
        };
      }
      if (nowMs < week.baselineAtMs) {
        return {
          status: "skipped",
          reason: "beforeBaselineTime",
        };
      }

      const weekId = String(week.weekId);
      const baselineByWeekId = {
        ...(matchups.baselineByWeekId || {}),
      };
      if (baselineByWeekId[weekId]) {
        return {
          status: "skipped",
          reason: "alreadyCaptured",
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
      const byPlayerId =
        statsJson?.byPlayerId &&
        typeof statsJson.byPlayerId === "object"
          ? statsJson.byPlayerId
          : null;
      if (!byPlayerId) {
        return {
          status: "skipped",
          reason: "statsByPlayerMissing",
          weekId,
        };
      }

      const snapshotByPlayerId = {};
      for (const [playerId, stats] of Object.entries(
        byPlayerId
      )) {
        const goals = Number(stats?.goals) || 0;
        const assists = Number(stats?.assists) || 0;
        const gamesPlayed =
          Number(stats?.gamesPlayed) || 0;
        snapshotByPlayerId[playerId] = {
          goals,
          assists,
          gamesPlayed,
          fp: goals * 1.25 + assists,
        };
      }

      baselineByWeekId[weekId] = {
        weekId,
        capturedAtMs: nowMs,
        statsSeasonId: statsJson?.seasonId ?? null,
        statsLastUpdatedAt:
          statsJson?.lastUpdatedAt ?? null,
        byPlayerId: snapshotByPlayerId,
      };

      const nextState = {
        ...state,
        matchups: {
          ...matchups,
          baselineByWeekId,
        },
      };

      await leagueStore.saveLeague(nextState, {
        savedBy: "system:baselineCapture",
      });
      await publisher.publish("league:updated", {
        reason: "matchups:baselineCaptured",
        weekId,
      });

      return {
        status: "succeeded",
        weekId,
        playerCount: Object.keys(
          snapshotByPlayerId
        ).length,
      };
    },
  });
}

module.exports = {
  JOB_NAME,
  createCaptureMatchupBaselineJob,
};
