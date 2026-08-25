const {
  isTeamLegalNow,
} = require("../../application/services/matchups/readMatchups");
const { createJobRunner } = require("../runJob");

const JOB_NAME = "matchups:applyRosterLocks";

function createApplyRosterLocksJob({
  leagueStore,
  publisher = { publish() {} },
  clock = { nowMs: Date.now },
  isTeamLegal = isTeamLegalNow,
  logger = console,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createApplyRosterLocksJob requires a leagueStore"
    );
  }
  if (
    !clock ||
    typeof clock.nowMs !== "function"
  ) {
    throw new TypeError(
      "createApplyRosterLocksJob requires clock.nowMs"
    );
  }
  if (typeof isTeamLegal !== "function") {
    throw new TypeError(
      "createApplyRosterLocksJob requires isTeamLegal"
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
      if (!Number.isFinite(week.lockAtMs)) {
        return {
          status: "skipped",
          reason: "missingLockTime",
        };
      }
      if (nowMs < week.lockAtMs) {
        return {
          status: "skipped",
          reason: "beforeLockTime",
        };
      }

      const teams = Array.isArray(state.teams)
        ? state.teams
        : [];
      const locksByTeam = {
        ...(matchups.locksByTeam || {}),
      };
      const lockedTeams = [];

      for (const team of teams) {
        const teamName = team?.name;
        if (!teamName) continue;

        const existing = locksByTeam[teamName];
        if (
          existing &&
          Number(existing.weekIndex) ===
            currentWeekIndex
        ) {
          continue;
        }
        if (!isTeamLegal(team)) continue;

        locksByTeam[teamName] = {
          lockedAtMs: nowMs,
          weekIndex: currentWeekIndex,
        };
        lockedTeams.push(teamName);
      }

      if (lockedTeams.length === 0) {
        return {
          status: "skipped",
          reason: "noEligibleTeams",
        };
      }

      const nextState = {
        ...state,
        matchups: {
          ...matchups,
          locksByTeam,
        },
      };

      await leagueStore.saveLeague(nextState, {
        savedBy: "system:rosterLock",
      });
      await publisher.publish("league:updated", {
        reason: "matchups:rosterLocked",
      });

      return {
        status: "succeeded",
        currentWeekIndex,
        lockedTeams,
      };
    },
  });
}

module.exports = {
  JOB_NAME,
  createApplyRosterLocksJob,
};
