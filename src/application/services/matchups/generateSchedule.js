const {
  buildScheduleWeeks,
  getNextMondayStartMsPT,
} = require("../../../domain/matchups/buildSchedule");

function compatibilityError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isCompatibilityError = true;
  return error;
}

function createGenerateScheduleService({
  leagueStore,
  timeZone,
  clock = { nowMs: Date.now },
  publisher,
  buildSchedule = buildScheduleWeeks,
  getNextMondayStart =
    getNextMondayStartMsPT,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createGenerateScheduleService requires a leagueStore"
    );
  }

  async function generateSchedule(body = {}) {
    const previous = leagueStore.loadLeague();
    const teamNames = (previous.teams || [])
      .map((team) => team?.name)
      .filter(Boolean);

    if (teamNames.length < 2) {
      throw compatibilityError(
        400,
        "Need at least 2 teams to generate schedule."
      );
    }
    if (teamNames.length % 2 !== 0) {
      throw compatibilityError(
        400,
        "Round robin schedule currently requires an even number of teams."
      );
    }

    const seasonId =
      body.seasonId ??
      previous?.matchups?.seasonId ??
      null;
    const numWeeks =
      Number(body.numWeeks || 26) || 26;
    const lockHour = Number(body.lockHour ?? 16);
    const lockMinute = Number(body.lockMinute ?? 0);
    const startWeekMsPT =
      Number(body.startWeekMsPT) ||
      getNextMondayStart({
        nowMs: clock.nowMs(),
        timeZone,
      });
    const scheduleWeeks = buildSchedule({
      teamNames,
      startWeekMsPT,
      numWeeks,
      lockHour,
      lockMinute,
      seasonId,
      timeZone,
    });
    const next = {
      ...previous,
      matchups: {
        ...(previous.matchups || {}),
        seasonId,
        scheduleWeeks,
        currentWeekIndex: 0,
        currentWeekId:
          scheduleWeeks?.[0]?.weekId || null,
        locksByTeam: {},
        baselineByWeekId: {},
        resultsByWeek: {},
        lastRolloverWeekId: null,
        baselineByPlayerId:
          previous?.matchups?.baselineByPlayerId || {},
      },
    };

    await leagueStore.saveLeague(next, {
      savedBy: "commissioner:generateSchedule",
    });

    if (publisher?.publish) {
      await publisher.publish("league:updated", {
        reason: "matchups:scheduleGenerated",
      });
    }

    return {
      ok: true,
      generated: {
        seasonId,
        numWeeks: scheduleWeeks.length,
        startWeekMsPT,
        currentWeekId: next.matchups.currentWeekId,
      },
    };
  }

  return { generateSchedule };
}

module.exports = {
  compatibilityError,
  createGenerateScheduleService,
};
