const DAY_MS = 24 * 60 * 60 * 1000;

function getPartsInTZ(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return result;
}

function weekdayIndexPT(shortWeekday) {
  const indexes = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return indexes[shortWeekday] ?? 0;
}

function makeUtcMsForTZ(
  {
    year,
    month,
    day,
    hour = 0,
    minute = 0,
  },
  timeZone
) {
  let date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0
    )
  );

  for (let index = 0; index < 3; index += 1) {
    const parts = getPartsInTZ(date, timeZone);
    const actual = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      0
    );
    const desired = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0
    );
    const deltaMs = desired - actual;

    if (Math.abs(deltaMs) < 1000) break;
    date = new Date(date.getTime() + deltaMs);
  }

  return date.getTime();
}

function getNextMondayStartMsPT({
  nowMs,
  timeZone,
}) {
  const now = new Date(nowMs);
  const parts = getPartsInTZ(now, timeZone);
  const utcNoonToday = makeUtcMsForTZ(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 12,
      minute: 0,
    },
    timeZone
  );
  const dayOfWeek = weekdayIndexPT(parts.weekday);
  const utcNoonMondayThisWeek =
    utcNoonToday - dayOfWeek * DAY_MS;
  const mondayParts = getPartsInTZ(
    new Date(utcNoonMondayThisWeek),
    timeZone
  );
  const mondayStartThisWeekMs = makeUtcMsForTZ(
    {
      year: mondayParts.year,
      month: mondayParts.month,
      day: mondayParts.day,
      hour: 0,
      minute: 0,
    },
    timeZone
  );

  if (nowMs >= mondayStartThisWeekMs) {
    const utcNoonNextMonday =
      utcNoonMondayThisWeek + 7 * DAY_MS;
    const nextMondayParts = getPartsInTZ(
      new Date(utcNoonNextMonday),
      timeZone
    );
    return makeUtcMsForTZ(
      {
        year: nextMondayParts.year,
        month: nextMondayParts.month,
        day: nextMondayParts.day,
        hour: 0,
        minute: 0,
      },
      timeZone
    );
  }

  return mondayStartThisWeekMs;
}

function generateRoundRobinPairs(teamNames) {
  const names = [...teamNames];
  if (names.length < 2) return [];
  if (names.length % 2 !== 0) names.push("__BYE__");

  const teams = [...names];
  const rounds = teams.length - 1;
  const half = teams.length / 2;
  const schedule = [];

  for (let round = 0; round < rounds; round += 1) {
    const pairs = [];

    for (let index = 0; index < half; index += 1) {
      const first = teams[index];
      const second = teams[teams.length - 1 - index];
      if (first !== "__BYE__" && second !== "__BYE__") {
        pairs.push([first, second]);
      }
    }

    schedule.push(pairs);
    const fixed = teams[0];
    const rest = teams.slice(1);
    rest.unshift(rest.pop());
    teams.splice(0, teams.length, fixed, ...rest);
  }

  return schedule;
}

function buildScheduleWeeks({
  teamNames,
  startWeekMsPT,
  numWeeks = 26,
  lockHour = 16,
  lockMinute = 0,
  seasonId = null,
  timeZone,
}) {
  const baseRoundPairs = generateRoundRobinPairs(teamNames);
  if (baseRoundPairs.length === 0) return [];

  const startParts = getPartsInTZ(
    new Date(startWeekMsPT),
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
  const weeks = [];

  for (
    let weekIndex = 0;
    weekIndex < numWeeks;
    weekIndex += 1
  ) {
    const weekNoonMs =
      startNoonMs + weekIndex * 7 * DAY_MS;
    const weekParts = getPartsInTZ(
      new Date(weekNoonMs),
      timeZone
    );
    const weekStartAtMs = makeUtcMsForTZ(
      {
        year: weekParts.year,
        month: weekParts.month,
        day: weekParts.day,
        hour: 0,
        minute: 0,
      },
      timeZone
    );
    const endNoonMs = weekNoonMs + 6 * DAY_MS;
    const endParts = getPartsInTZ(
      new Date(endNoonMs),
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
        year: weekParts.year,
        month: weekParts.month,
        day: weekParts.day,
        hour: lockHour,
        minute: lockMinute,
      },
      timeZone
    );
    const nextWeekNoonMs = weekNoonMs + 7 * DAY_MS;
    const nextParts = getPartsInTZ(
      new Date(nextWeekNoonMs),
      timeZone
    );
    const rolloverAtMs = makeUtcMsForTZ(
      {
        year: nextParts.year,
        month: nextParts.month,
        day: nextParts.day,
        hour: 0,
        minute: 0,
      },
      timeZone
    );
    const weekId = `${seasonId || weekParts.year}-W${String(
      weekIndex + 1
    ).padStart(2, "0")}`;
    const pairs =
      baseRoundPairs[weekIndex % baseRoundPairs.length];
    const baselineAtMs =
      weekStartAtMs + 60 * 60 * 1000;

    weeks.push({
      weekIndex,
      weekId,
      weekStartAtMs,
      baselineAtMs,
      weekEndAtMs,
      lockAtMs,
      rolloverAtMs,
      pairs,
    });
  }

  return weeks;
}

module.exports = {
  DAY_MS,
  buildScheduleWeeks,
  generateRoundRobinPairs,
  getNextMondayStartMsPT,
  getPartsInTZ,
  makeUtcMsForTZ,
  weekdayIndexPT,
};
