const MATCHUP_SCHEDULE_CODES = Object.freeze({
  inputInvalid: "MATCHUP_SCHEDULE_INPUT_INVALID",
  calendarInvalid: "MATCHUP_SCHEDULE_CALENDAR_INVALID",
});

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BYE = Symbol("matchup-bye");

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
    if (part.type !== "literal") result[part.type] = part.value;
  }
  return result;
}

function weekdayIndexPT(shortWeekday) {
  return {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  }[shortWeekday];
}

function makeUtcMsForTZ({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const desired = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0
  );
  let timestampMs = desired;
  for (let index = 0; index < 3; index += 1) {
    const actualParts = getPartsInTZ(new Date(timestampMs), timeZone);
    const actual = Date.UTC(
      Number(actualParts.year),
      Number(actualParts.month) - 1,
      Number(actualParts.day),
      Number(actualParts.hour),
      Number(actualParts.minute),
      0
    );
    if (actual === desired) break;
    timestampMs += desired - actual;
  }
  return timestampMs;
}

class MatchupSchedulePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupSchedulePolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupSchedulePolicyError(code, message);
}

function stableTeams(value) {
  if (!Array.isArray(value) || value.length < 2) {
    fail(MATCHUP_SCHEDULE_CODES.inputInvalid, "At least two season teams are required.");
  }
  const result = value.map((teamId) => {
    if (typeof teamId !== "string" || !UUID_PATTERN.test(teamId)) {
      fail(MATCHUP_SCHEDULE_CODES.inputInvalid, "A stable season team ID is required.");
    }
    return teamId;
  }).sort();
  if (new Set(result).size !== result.length) {
    fail(MATCHUP_SCHEDULE_CODES.inputInvalid, "Season team IDs must be unique.");
  }
  return result;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(MATCHUP_SCHEDULE_CODES.inputInvalid, "A safe calendar timestamp is required.");
  }
  return value;
}

function validateTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    fail(MATCHUP_SCHEDULE_CODES.inputInvalid, "A league timezone is required.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    fail(MATCHUP_SCHEDULE_CODES.inputInvalid, "The league timezone is invalid.");
  }
  return value;
}

function localMidnight({ year, month, day }, timeZone) {
  return makeUtcMsForTZ({ year, month, day, hour: 0, minute: 0 }, timeZone);
}

function addLocalDays(timestampMs, days, timeZone) {
  const parts = getPartsInTZ(new Date(timestampMs), timeZone);
  const noonUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + days,
    12
  );
  const target = getPartsInTZ(new Date(noonUtc), timeZone);
  return localMidnight(target, timeZone);
}

function firstEligibleMonday(openingAtMs, timeZone) {
  const parts = getPartsInTZ(new Date(openingAtMs), timeZone);
  const midnight = localMidnight(parts, timeZone);
  const offset = (7 - weekdayIndexPT(parts.weekday)) % 7;
  return addLocalDays(midnight, offset, timeZone);
}

function createRoundRobin(teamIds) {
  const rotating = [...teamIds];
  if (rotating.length % 2 === 1) rotating.push(BYE);
  const rounds = [];
  for (let round = 0; round < rotating.length - 1; round += 1) {
    const pairs = [];
    let byeTeamId = null;
    for (let index = 0; index < rotating.length / 2; index += 1) {
      const first = rotating[index];
      const second = rotating[rotating.length - 1 - index];
      if (first === BYE || second === BYE) {
        byeTeamId = first === BYE ? second : first;
      } else {
        const swap = (round + index) % 2 === 1;
        pairs.push(Object.freeze({
          homeTeamId: swap ? second : first,
          awayTeamId: swap ? first : second,
        }));
      }
    }
    rounds.push(Object.freeze({ pairs: Object.freeze(pairs), byeTeamId }));
    const fixed = rotating[0];
    const rest = rotating.slice(1);
    rest.unshift(rest.pop());
    rotating.splice(0, rotating.length, fixed, ...rest);
  }
  return Object.freeze(rounds);
}

function boundary(startAtMs, hour, timeZone) {
  const parts = getPartsInTZ(new Date(startAtMs), timeZone);
  return makeUtcMsForTZ(
    { year: parts.year, month: parts.month, day: parts.day, hour, minute: 0 },
    timeZone
  );
}

function planMatchupSchedule({
  teamIds,
  nhlRegularSeasonStartsAtMs,
  fantasyPlayoffsStartAtMs,
  timeZone,
} = {}) {
  const teams = stableTeams(teamIds);
  const zone = validateTimeZone(timeZone);
  const openingAtMs = safeTimestamp(nhlRegularSeasonStartsAtMs);
  const playoffsAtMs = safeTimestamp(fantasyPlayoffsStartAtMs);
  const firstWeekStartsAtMs = firstEligibleMonday(openingAtMs, zone);
  const playoffParts = getPartsInTZ(new Date(playoffsAtMs), zone);
  const playoffStartAtMs = localMidnight(playoffParts, zone);
  if (
    weekdayIndexPT(playoffParts.weekday) !== 0 ||
    playoffsAtMs !== playoffStartAtMs ||
    playoffStartAtMs <= firstWeekStartsAtMs
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "Fantasy playoffs must begin at a later Monday midnight in the league timezone."
    );
  }
  const rounds = createRoundRobin(teams);
  const weeks = [];
  for (
    let startsAtMs = firstWeekStartsAtMs, sequence = 1;
    startsAtMs < playoffStartAtMs;
    startsAtMs = addLocalDays(startsAtMs, 7, zone), sequence += 1
  ) {
    const endsAtMs = addLocalDays(startsAtMs, 7, zone);
    if (endsAtMs > playoffStartAtMs) {
      fail(MATCHUP_SCHEDULE_CODES.calendarInvalid, "A regular-season week overlaps playoffs.");
    }
    const roundIndex = (sequence - 1) % rounds.length;
    weeks.push(Object.freeze({
      sequence,
      weekKey: `regular-${String(sequence).padStart(2, "0")}`,
      startsAtMs,
      baselineAtMs: boundary(startsAtMs, 1, zone),
      locksAtMs: boundary(startsAtMs, 16, zone),
      endsAtMs,
      rollsOverAtMs: endsAtMs,
      pairs: rounds[roundIndex].pairs,
      byeTeamId: rounds[roundIndex].byeTeamId,
    }));
  }
  if (weeks.length < 1) {
    fail(MATCHUP_SCHEDULE_CODES.calendarInvalid, "The calendar has no regular-season weeks.");
  }
  return Object.freeze({
    timeZone: zone,
    firstWeekStartsAtMs,
    fantasyPlayoffsStartAtMs: playoffStartAtMs,
    teamIds: Object.freeze(teams),
    weeks: Object.freeze(weeks),
  });
}

module.exports = {
  MATCHUP_SCHEDULE_CODES,
  MatchupSchedulePolicyError,
  addLocalDays,
  firstEligibleMonday,
  planMatchupSchedule,
};
