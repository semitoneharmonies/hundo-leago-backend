const { createJobRunner } = require("../runJob");

const JOB_NAME = "matchups:rolloverWeek";

function snapshotStatistics(statsJson, {
  weekId,
  capturedAtMs,
}) {
  const byPlayerId =
    statsJson?.byPlayerId &&
    typeof statsJson.byPlayerId === "object"
      ? statsJson.byPlayerId
      : null;
  if (!byPlayerId) return null;

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

  return {
    weekId,
    capturedAtMs,
    statsSeasonId: statsJson?.seasonId ?? null,
    statsLastUpdatedAt:
      statsJson?.lastUpdatedAt ?? null,
    byPlayerId: snapshotByPlayerId,
  };
}

function createRolloverMatchupWeekJob({
  leagueStore,
  statisticsRepository,
  publisher = { publish() {} },
  clock = { nowMs: Date.now },
  logger = console,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createRolloverMatchupWeekJob requires a leagueStore"
    );
  }
  if (!statisticsRepository) {
    throw new TypeError(
      "createRolloverMatchupWeekJob requires a statisticsRepository"
    );
  }
  if (
    !clock ||
    typeof clock.nowMs !== "function"
  ) {
    throw new TypeError(
      "createRolloverMatchupWeekJob requires clock.nowMs"
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
        !Number.isFinite(week.rolloverAtMs)
      ) {
        return {
          status: "skipped",
          reason: "missingRolloverConfiguration",
        };
      }
      if (nowMs < week.rolloverAtMs) {
        return {
          status: "skipped",
          reason: "beforeRolloverTime",
        };
      }

      const weekId = String(week.weekId);
      if (
        matchups.lastRolloverWeekId &&
        String(matchups.lastRolloverWeekId) ===
          weekId
      ) {
        return {
          status: "skipped",
          reason: "alreadyRolledOver",
          weekId,
        };
      }
      if (!matchups.resultsByWeek?.[weekId]) {
        return {
          status: "skipped",
          reason: "resultsMissing",
          weekId,
        };
      }

      const nextWeekIndex = currentWeekIndex + 1;
      const nextWeek = weeks[nextWeekIndex];
      if (!nextWeek?.weekId) {
        const nextState = {
          ...state,
          matchups: {
            ...matchups,
            lastRolloverWeekId: weekId,
          },
        };
        await leagueStore.saveLeague(nextState, {
          savedBy:
            "system:matchupRollover:endOfSchedule",
        });
        await publisher.publish("league:updated", {
          reason:
            "matchups:rollover:endOfSchedule",
          weekId,
        });

        return {
          status: "succeeded",
          weekId,
          endOfSchedule: true,
        };
      }

      const nextWeekId = String(nextWeek.weekId);
      const advancedMatchups = {
        ...matchups,
        currentWeekIndex: nextWeekIndex,
        currentWeekId: nextWeekId,
        lastRolloverWeekId: weekId,
      };
      const baselineByWeekId = {
        ...(advancedMatchups.baselineByWeekId || {}),
      };
      let baselineCaptured = false;

      if (
        nextWeek.baselineAtMs != null &&
        Number.isFinite(Number(nextWeek.baselineAtMs)) &&
        nowMs >= Number(nextWeek.baselineAtMs) &&
        !baselineByWeekId[nextWeekId] &&
        statisticsRepository.cacheExists()
      ) {
        const snapshot = snapshotStatistics(
          statisticsRepository.readCache(),
          {
            weekId: nextWeekId,
            capturedAtMs: nowMs,
          }
        );
        if (snapshot) {
          baselineByWeekId[nextWeekId] = snapshot;
          advancedMatchups.baselineByWeekId =
            baselineByWeekId;
          baselineCaptured = true;
        }
      }

      const nextState = {
        ...state,
        matchups: advancedMatchups,
      };
      await leagueStore.saveLeague(nextState, {
        savedBy: "system:matchupRollover",
      });
      await publisher.publish("league:updated", {
        reason: "matchups:rollover",
        fromWeekId: weekId,
        toWeekId: nextWeekId,
        fromWeekIndex: currentWeekIndex,
        toWeekIndex: nextWeekIndex,
      });

      return {
        status: "succeeded",
        fromWeekId: weekId,
        toWeekId: nextWeekId,
        fromWeekIndex: currentWeekIndex,
        toWeekIndex: nextWeekIndex,
        baselineCaptured,
        endOfSchedule: false,
      };
    },
  });
}

module.exports = {
  JOB_NAME,
  createRolloverMatchupWeekJob,
  snapshotStatistics,
};
