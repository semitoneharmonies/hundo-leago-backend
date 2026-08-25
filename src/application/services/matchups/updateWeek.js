const {
  compatibilityError,
} = require("./generateSchedule");

function createUpdateWeekService({
  leagueStore,
  nodeEnv,
  clock = { nowMs: Date.now },
  publisher,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createUpdateWeekService requires a leagueStore"
    );
  }

  async function updateWeek(body = {}) {
    const weekIndex = Number(body.weekIndex);
    if (
      !Number.isFinite(weekIndex) ||
      weekIndex < 0
    ) {
      throw compatibilityError(
        400,
        "weekIndex is required and must be >= 0."
      );
    }

    const previous = leagueStore.loadLeague();
    const matchups = previous.matchups || {};
    const weeks = Array.isArray(matchups.scheduleWeeks)
      ? matchups.scheduleWeeks
      : [];
    if (!weeks[weekIndex]) {
      throw compatibilityError(
        404,
        "Week not found in scheduleWeeks."
      );
    }

    const forceRequested = Boolean(body.force);
    const force =
      nodeEnv !== "production" && forceRequested;
    const current = weeks[weekIndex];
    const nowMs = clock.nowMs();

    if (!force && nowMs >= current.weekStartAtMs) {
      throw compatibilityError(
        400,
        "Only future weeks can be edited. Use force=true only for emergency commissioner fixes."
      );
    }

    const weekStartAtMs =
      body.weekStartAtMs != null
        ? Number(body.weekStartAtMs)
        : current.weekStartAtMs;
    const weekEndAtMs =
      body.weekEndAtMs != null
        ? Number(body.weekEndAtMs)
        : current.weekEndAtMs;
    const lockAtMs =
      body.lockAtMs != null
        ? Number(body.lockAtMs)
        : current.lockAtMs;
    const rolloverAtMs =
      body.rolloverAtMs != null
        ? Number(body.rolloverAtMs)
        : current.rolloverAtMs;
    const baselineAtMs =
      weekStartAtMs + 60 * 60 * 1000;
    const updatedWeek = {
      ...current,
      weekStartAtMs,
      baselineAtMs,
      weekEndAtMs,
      lockAtMs,
      rolloverAtMs,
    };

    for (const key of [
      "weekStartAtMs",
      "baselineAtMs",
      "weekEndAtMs",
      "lockAtMs",
      "rolloverAtMs",
    ]) {
      const value = updatedWeek[key];
      if (!Number.isFinite(value) || value <= 0) {
        throw compatibilityError(
          400,
          `Invalid ${key}. Must be a positive number (ms).`
        );
      }
    }

    if (
      !(
        updatedWeek.weekStartAtMs <
          updatedWeek.baselineAtMs &&
        updatedWeek.baselineAtMs <=
          updatedWeek.weekEndAtMs
      )
    ) {
      throw compatibilityError(
        400,
        "baselineAtMs must be after weekStartAtMs and on/before weekEndAtMs."
      );
    }
    if (
      !(
        updatedWeek.weekStartAtMs <
        updatedWeek.weekEndAtMs
      )
    ) {
      throw compatibilityError(
        400,
        "weekStartAtMs must be < weekEndAtMs."
      );
    }
    if (
      !(
        updatedWeek.weekEndAtMs <
        updatedWeek.rolloverAtMs
      )
    ) {
      throw compatibilityError(
        400,
        "weekEndAtMs must be < rolloverAtMs."
      );
    }
    if (
      !(
        updatedWeek.weekStartAtMs <=
          updatedWeek.lockAtMs &&
        updatedWeek.lockAtMs <=
          updatedWeek.weekEndAtMs
      )
    ) {
      throw compatibilityError(
        400,
        "lockAtMs must be between weekStartAtMs and weekEndAtMs."
      );
    }

    const previousWeek = weeks[weekIndex - 1];
    const nextWeek = weeks[weekIndex + 1];
    if (
      !force &&
      previousWeek &&
      !(
        previousWeek.rolloverAtMs <=
        updatedWeek.weekStartAtMs
      )
    ) {
      throw compatibilityError(
        400,
        "This change would overlap the previous week. Use force=true if you really intend this."
      );
    }
    if (
      !force &&
      nextWeek &&
      !(
        updatedWeek.rolloverAtMs <=
        nextWeek.weekStartAtMs
      )
    ) {
      throw compatibilityError(
        400,
        "This change would overlap the next week. Use force=true if you really intend this."
      );
    }

    const nextWeeks = [...weeks];
    nextWeeks[weekIndex] = updatedWeek;
    const next = {
      ...previous,
      matchups: {
        ...matchups,
        scheduleWeeks: nextWeeks,
      },
    };

    await leagueStore.saveLeague(next, {
      savedBy: "commissioner:updateWeekWindow",
    });

    if (publisher?.publish) {
      await publisher.publish("league:updated", {
        reason: "matchups:weekUpdated",
        weekIndex,
      });
    }

    return {
      ok: true,
      weekIndex,
      updated: updatedWeek,
    };
  }

  return { updateWeek };
}

module.exports = { createUpdateWeekService };
