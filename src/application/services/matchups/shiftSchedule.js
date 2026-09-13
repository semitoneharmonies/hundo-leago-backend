const {
  DAY_MS,
  getPartsInTZ,
  makeUtcMsForTZ,
} = require("../../../domain/matchups/buildSchedule");
const {
  compatibilityError,
} = require("./generateSchedule");

function createShiftScheduleService({
  leagueStore,
  timeZone,
  publisher,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createShiftScheduleService requires a leagueStore"
    );
  }

  function dayStartMs(timestamp) {
    const parts = getPartsInTZ(
      new Date(timestamp),
      timeZone
    );
    return makeUtcMsForTZ(
      {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: 0,
        minute: 0,
      },
      timeZone
    );
  }

  async function shiftSchedule(body = {}) {
    const fromWeekIndex = Number(body.fromWeekIndex);
    if (
      !Number.isFinite(fromWeekIndex) ||
      fromWeekIndex < 0
    ) {
      throw compatibilityError(
        400,
        "fromWeekIndex is required and must be >= 0."
      );
    }

    const previous = leagueStore.loadLeague();
    const matchups = previous.matchups || {};
    const weeks = Array.isArray(matchups.scheduleWeeks)
      ? matchups.scheduleWeeks
      : [];
    if (weeks.length === 0) {
      throw compatibilityError(
        400,
        "No scheduleWeeks to shift."
      );
    }
    if (!weeks[fromWeekIndex]) {
      throw compatibilityError(
        404,
        "fromWeekIndex out of range."
      );
    }

    const lockHour = Number(body.lockHour ?? 16);
    const lockMinute = Number(body.lockMinute ?? 0);
    const nextWeeks = [...weeks];

    for (
      let index = fromWeekIndex;
      index < nextWeeks.length;
      index += 1
    ) {
      const previousWeek = nextWeeks[index - 1];
      const currentWeek = nextWeeks[index];
      const startAnchor =
        index === 0
          ? currentWeek.weekStartAtMs
          : previousWeek.rolloverAtMs;
      const weekStartAtMs = dayStartMs(startAnchor);
      const baselineAtMs =
        weekStartAtMs + 60 * 60 * 1000;
      const startParts = getPartsInTZ(
        new Date(weekStartAtMs),
        timeZone
      );
      const startNoonMs = makeUtcMsForTZ(
        {
          year: startParts.year,
          month: startParts.month,
          day: startParts.day,
          hour: 12,
          minute: 0,
        },
        timeZone
      );
      const endParts = getPartsInTZ(
        new Date(startNoonMs + 6 * DAY_MS),
        timeZone
      );
      const weekEndAtMs = makeUtcMsForTZ(
        {
          year: endParts.year,
          month: endParts.month,
          day: endParts.day,
          hour: 23,
          minute: 59,
        },
        timeZone
      );
      const lockAtMs = makeUtcMsForTZ(
        {
          year: startParts.year,
          month: startParts.month,
          day: startParts.day,
          hour: lockHour,
          minute: lockMinute,
        },
        timeZone
      );
      const nextWeekNoonMs =
        startNoonMs + 7 * DAY_MS;
      const rolloverParts = getPartsInTZ(
        new Date(nextWeekNoonMs),
        timeZone
      );
      const rolloverAtMs = makeUtcMsForTZ(
        {
          year: rolloverParts.year,
          month: rolloverParts.month,
          day: rolloverParts.day,
          hour: 0,
          minute: 0,
        },
        timeZone
      );

      nextWeeks[index] = {
        ...currentWeek,
        weekStartAtMs,
        baselineAtMs,
        weekEndAtMs,
        lockAtMs,
        rolloverAtMs,
      };
    }

    const next = {
      ...previous,
      matchups: {
        ...matchups,
        scheduleWeeks: nextWeeks,
      },
    };

    await leagueStore.saveLeague(next, {
      savedBy: "commissioner:shiftSchedule",
    });

    if (publisher?.publish) {
      await publisher.publish("league:updated", {
        reason: "matchups:scheduleShifted",
        fromWeekIndex,
      });
    }

    return {
      ok: true,
      shiftedFrom: fromWeekIndex,
      weeksShifted:
        nextWeeks.length - fromWeekIndex,
    };
  }

  return { shiftSchedule };
}

module.exports = { createShiftScheduleService };
