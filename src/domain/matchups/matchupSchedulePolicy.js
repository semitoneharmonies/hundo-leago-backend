const MATCHUP_SCHEDULE_CODES = Object.freeze({
  inputInvalid: "MATCHUP_SCHEDULE_INPUT_INVALID",
  calendarInvalid: "MATCHUP_SCHEDULE_CALENDAR_INVALID",
});

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NHL_SEASON_KEY_PATTERN = /^\d{8}$/;
const MAXIMUM_UTC_TIMESTAMP_MS = 8_640_000_000_000_000;
const FANTASY_PLAYOFF_DURATION_MS =
  28 * 24 * 60 * 60 * 1000;
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

function safeExplicitTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_UTC_TIMESTAMP_MS
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.inputInvalid,
      "A valid explicit UTC calendar timestamp is required."
    );
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

function canonicalNhlSeasonStartYear(value) {
  if (
    typeof value !== "string" ||
    !NHL_SEASON_KEY_PATTERN.test(value)
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.inputInvalid,
      "A canonical NHL season key is required."
    );
  }
  const startYear = Number(value.slice(0, 4));
  const endYear = Number(value.slice(4));
  if (endYear !== startYear + 1) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "The NHL season key must contain consecutive calendar years."
    );
  }
  return startYear;
}

function utcYear(timestampMs) {
  return new Date(timestampMs).getUTCFullYear();
}

function isLocalMondayMidnight(timestampMs, timeZone) {
  return firstEligibleMonday(timestampMs, timeZone) === timestampMs;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.isFrozen(value)
    ? value
    : Object.freeze(value);
}

function buildWeeks({
  teams,
  firstWeekStartsAtMs,
  fantasyPlayoffsStartAtMs,
  timeZone,
}) {
  const rounds = createRoundRobin(teams);
  const weeks = [];
  for (
    let startsAtMs = firstWeekStartsAtMs, sequence = 1;
    startsAtMs < fantasyPlayoffsStartAtMs;
    startsAtMs = addLocalDays(startsAtMs, 7, timeZone), sequence += 1
  ) {
    const endsAtMs = addLocalDays(startsAtMs, 7, timeZone);
    if (endsAtMs > fantasyPlayoffsStartAtMs) {
      fail(
        MATCHUP_SCHEDULE_CODES.calendarInvalid,
        "A regular-season week overlaps playoffs."
      );
    }
    const roundIndex = (sequence - 1) % rounds.length;
    weeks.push({
      sequence,
      weekKey: `regular-${String(sequence).padStart(2, "0")}`,
      startsAtMs,
      baselineAtMs: boundary(startsAtMs, 1, timeZone),
      locksAtMs: boundary(startsAtMs, 16, timeZone),
      endsAtMs,
      rollsOverAtMs: endsAtMs,
      pairs: rounds[roundIndex].pairs,
      byeTeamId: rounds[roundIndex].byeTeamId,
    });
  }
  if (weeks.length < 1) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "The calendar has no regular-season weeks."
    );
  }
  return weeks;
}

function stableScheduleId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.inputInvalid,
      `A stable ${description} ID is required.`
    );
  }
  return value;
}

function canonicalExistingScheduleWeeks(value, timeZone) {
  if (!Array.isArray(value) || value.length < 1) {
    fail(
      MATCHUP_SCHEDULE_CODES.inputInvalid,
      "At least one existing matchup week is required."
    );
  }

  const weekIds = new Set();
  let participantSignature = null;
  let previousStartsAtMs = null;
  return value.map((week, index) => {
    if (
      week === null ||
      typeof week !== "object" ||
      Array.isArray(week)
    ) {
      fail(
        MATCHUP_SCHEDULE_CODES.inputInvalid,
        "Each existing matchup week must be an object."
      );
    }

    const id = stableScheduleId(week.id, "matchup week");
    if (weekIds.has(id)) {
      fail(
        MATCHUP_SCHEDULE_CODES.calendarInvalid,
        "Existing matchup week IDs must be unique."
      );
    }
    weekIds.add(id);

    const sequence = week.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      fail(
        MATCHUP_SCHEDULE_CODES.inputInvalid,
        "Each existing matchup week requires a positive sequence."
      );
    }
    if (sequence !== index + 1) {
      fail(
        MATCHUP_SCHEDULE_CODES.calendarInvalid,
        "Existing matchup week sequences must be contiguous from Week 1."
      );
    }

    const expectedWeekKey =
      `regular-${String(sequence).padStart(2, "0")}`;
    if (
      typeof week.weekKey !== "string" ||
      week.weekKey !== expectedWeekKey
    ) {
      fail(
        typeof week.weekKey === "string"
          ? MATCHUP_SCHEDULE_CODES.calendarInvalid
          : MATCHUP_SCHEDULE_CODES.inputInvalid,
        "Each existing matchup week requires its canonical week key."
      );
    }

    const startsAtMs = safeExplicitTimestamp(
      week.startsAtMs
    );
    const baselineAtMs = safeExplicitTimestamp(
      week.baselineAtMs
    );
    const locksAtMs = safeExplicitTimestamp(
      week.locksAtMs
    );
    const endsAtMs = safeExplicitTimestamp(
      week.endsAtMs
    );
    const rollsOverAtMs = safeExplicitTimestamp(
      week.rollsOverAtMs
    );
    if (
      !isLocalMondayMidnight(startsAtMs, timeZone) ||
      (
        previousStartsAtMs !== null &&
        startsAtMs !==
          addLocalDays(
            previousStartsAtMs,
            7,
            timeZone
          )
      ) ||
      baselineAtMs !== boundary(startsAtMs, 1, timeZone) ||
      locksAtMs !== boundary(startsAtMs, 16, timeZone) ||
      endsAtMs !== addLocalDays(startsAtMs, 7, timeZone) ||
      rollsOverAtMs !== endsAtMs
    ) {
      fail(
        MATCHUP_SCHEDULE_CODES.calendarInvalid,
        "Existing matchup week boundaries are not canonical."
      );
    }
    previousStartsAtMs = startsAtMs;

    if (!Array.isArray(week.pairs) || week.pairs.length < 1) {
      fail(
        MATCHUP_SCHEDULE_CODES.inputInvalid,
        "Each existing matchup week requires at least one pairing."
      );
    }
    const participants = new Set();
    const pairs = week.pairs.map((pair) => {
      if (
        pair === null ||
        typeof pair !== "object" ||
        Array.isArray(pair)
      ) {
        fail(
          MATCHUP_SCHEDULE_CODES.inputInvalid,
          "Each existing matchup pairing must be an object."
        );
      }
      const homeTeamId = stableScheduleId(
        pair.homeTeamId,
        "home team"
      );
      const awayTeamId = stableScheduleId(
        pair.awayTeamId,
        "away team"
      );
      if (
        homeTeamId === awayTeamId ||
        participants.has(homeTeamId) ||
        participants.has(awayTeamId)
      ) {
        fail(
          MATCHUP_SCHEDULE_CODES.calendarInvalid,
          "A team may appear only once in an existing matchup week."
        );
      }
      participants.add(homeTeamId);
      participants.add(awayTeamId);
      return {
        homeTeamId,
        awayTeamId,
      };
    });

    let byeTeamId = null;
    if (week.byeTeamId !== null) {
      byeTeamId = stableScheduleId(
        week.byeTeamId,
        "bye team"
      );
      if (participants.has(byeTeamId)) {
        fail(
          MATCHUP_SCHEDULE_CODES.calendarInvalid,
          "A bye team cannot also appear in a matchup."
        );
      }
      participants.add(byeTeamId);
    }

    const currentParticipantSignature =
      [...participants].sort().join("|");
    if (
      participantSignature !== null &&
      currentParticipantSignature !== participantSignature
    ) {
      fail(
        MATCHUP_SCHEDULE_CODES.calendarInvalid,
        "Every existing matchup week must contain the same team set."
      );
    }
    participantSignature = currentParticipantSignature;

    return {
      id,
      weekKey: week.weekKey,
      sequence,
      startsAtMs,
      baselineAtMs,
      locksAtMs,
      endsAtMs,
      rollsOverAtMs,
      pairs,
      byeTeamId,
    };
  });
}

function planExplicitMatchupSchedule({
  teamIds,
  nhlSeasonKey,
  nhlRegularSeasonStartsAtMs,
  nhlRegularSeasonEndsAtMs,
  fantasyPlayoffsStartAtMs,
  fantasyPlayoffsEndAtMs,
  firstWeekStartsAtMs,
  timeZone,
  nowMs,
} = {}) {
  const teams = stableTeams(teamIds);
  const zone = validateTimeZone(timeZone);
  const seasonStartYear =
    canonicalNhlSeasonStartYear(nhlSeasonKey);
  const regularStartsAtMs = safeExplicitTimestamp(
    nhlRegularSeasonStartsAtMs
  );
  const regularEndsAtMs = safeExplicitTimestamp(
    nhlRegularSeasonEndsAtMs
  );
  const playoffsStartAtMs = safeExplicitTimestamp(
    fantasyPlayoffsStartAtMs
  );
  const playoffsEndAtMs = safeExplicitTimestamp(
    fantasyPlayoffsEndAtMs
  );
  const selectedFirstWeekStartsAtMs =
    safeExplicitTimestamp(firstWeekStartsAtMs);
  const plannedAtMs = safeExplicitTimestamp(nowMs);

  if (
    regularStartsAtMs >= playoffsStartAtMs ||
    playoffsStartAtMs >= playoffsEndAtMs ||
    playoffsEndAtMs !== regularEndsAtMs
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "The explicit NHL and fantasy playoff calendar is not ordered canonically."
    );
  }
  if (
    playoffsEndAtMs - playoffsStartAtMs !==
    FANTASY_PLAYOFF_DURATION_MS
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "Fantasy playoffs must reserve exactly 28 elapsed days."
    );
  }

  const seasonEndYear = seasonStartYear + 1;
  if (
    utcYear(regularStartsAtMs) !== seasonStartYear ||
    utcYear(playoffsStartAtMs) !== seasonEndYear ||
    utcYear(playoffsEndAtMs) !== seasonEndYear ||
    utcYear(regularEndsAtMs) !== seasonEndYear
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "The explicit calendar does not match the NHL season key."
    );
  }
  if (!isLocalMondayMidnight(playoffsStartAtMs, zone)) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "Fantasy playoffs must begin at league-local Monday midnight."
    );
  }
  if (!isLocalMondayMidnight(selectedFirstWeekStartsAtMs, zone)) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "Week 1 must begin at league-local Monday midnight."
    );
  }
  if (selectedFirstWeekStartsAtMs <= plannedAtMs) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "Week 1 must begin strictly after the current server time."
    );
  }
  if (
    selectedFirstWeekStartsAtMs < regularStartsAtMs ||
    addLocalDays(selectedFirstWeekStartsAtMs, 7, zone) >
      playoffsStartAtMs
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "Week 1 must fit wholly within the NHL regular-season scoring range."
    );
  }

  const weeks = buildWeeks({
    teams,
    firstWeekStartsAtMs: selectedFirstWeekStartsAtMs,
    fantasyPlayoffsStartAtMs: playoffsStartAtMs,
    timeZone: zone,
  });

  return deepFreeze({
    nhlSeasonKey,
    timeZone: zone,
    nhlRegularSeasonStartsAtMs: regularStartsAtMs,
    nhlRegularSeasonEndsAtMs: regularEndsAtMs,
    fantasyPlayoffsStartAtMs: playoffsStartAtMs,
    fantasyPlayoffsEndAtMs: playoffsEndAtMs,
    firstWeekStartsAtMs: selectedFirstWeekStartsAtMs,
    teamIds: teams,
    weeks,
  });
}

function planMatchupWeekOneShift({
  weeks,
  nhlSeasonKey,
  nhlRegularSeasonStartsAtMs,
  nhlRegularSeasonEndsAtMs,
  fantasyPlayoffsStartAtMs,
  fantasyPlayoffsEndAtMs,
  firstWeekStartsAtMs,
  timeZone,
  nowMs,
} = {}) {
  const zone = validateTimeZone(timeZone);
  const existingWeeks =
    canonicalExistingScheduleWeeks(weeks, zone);
  const previousFirstWeekStartsAtMs =
    existingWeeks[0].startsAtMs;
  const selectedFirstWeekStartsAtMs =
    safeExplicitTimestamp(firstWeekStartsAtMs);
  const plannedAtMs = safeExplicitTimestamp(nowMs);

  if (previousFirstWeekStartsAtMs <= plannedAtMs) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "The existing Week 1 must still be in the future."
    );
  }
  if (
    selectedFirstWeekStartsAtMs ===
    previousFirstWeekStartsAtMs
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "The replacement Week 1 must change the existing start."
    );
  }

  const teamIds = [
    ...existingWeeks[0].pairs.flatMap(
      ({ homeTeamId, awayTeamId }) => [
        homeTeamId,
        awayTeamId,
      ]
    ),
    ...(existingWeeks[0].byeTeamId === null
      ? []
      : [existingWeeks[0].byeTeamId]),
  ];
  const calendar = planExplicitMatchupSchedule({
    teamIds,
    nhlSeasonKey,
    nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs,
    firstWeekStartsAtMs:
      selectedFirstWeekStartsAtMs,
    timeZone: zone,
    nowMs: plannedAtMs,
  });

  if (
    existingWeeks[0].startsAtMs <
      calendar.nhlRegularSeasonStartsAtMs ||
    existingWeeks.at(-1).endsAtMs >
      calendar.fantasyPlayoffsStartAtMs
  ) {
    fail(
      MATCHUP_SCHEDULE_CODES.calendarInvalid,
      "The existing matchup schedule falls outside its persisted scoring range."
    );
  }

  const shiftedWeeks = existingWeeks.map(
    (week, index) => {
      const startsAtMs = addLocalDays(
        selectedFirstWeekStartsAtMs,
        index * 7,
        zone
      );
      const endsAtMs = addLocalDays(
        startsAtMs,
        7,
        zone
      );
      if (
        startsAtMs <
          calendar.nhlRegularSeasonStartsAtMs ||
        endsAtMs >
          calendar.fantasyPlayoffsStartAtMs
      ) {
        fail(
          MATCHUP_SCHEDULE_CODES.calendarInvalid,
          "A translated matchup week falls outside the persisted scoring range."
        );
      }
      return {
        id: week.id,
        weekKey: week.weekKey,
        sequence: week.sequence,
        startsAtMs,
        baselineAtMs: boundary(
          startsAtMs,
          1,
          zone
        ),
        locksAtMs: boundary(
          startsAtMs,
          16,
          zone
        ),
        endsAtMs,
        rollsOverAtMs: endsAtMs,
        pairs: week.pairs.map((pair) => ({
          homeTeamId: pair.homeTeamId,
          awayTeamId: pair.awayTeamId,
        })),
        byeTeamId: week.byeTeamId,
      };
    }
  );

  return deepFreeze({
    nhlSeasonKey: calendar.nhlSeasonKey,
    timeZone: calendar.timeZone,
    nhlRegularSeasonStartsAtMs:
      calendar.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      calendar.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs:
      calendar.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs:
      calendar.fantasyPlayoffsEndAtMs,
    previousFirstWeekStartsAtMs,
    firstWeekStartsAtMs:
      selectedFirstWeekStartsAtMs,
    lastWeekEndsAtMs:
      shiftedWeeks.at(-1).endsAtMs,
    shiftedWeekCount: shiftedWeeks.length,
    teamIds: calendar.teamIds,
    weeks: shiftedWeeks,
  });
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
  FANTASY_PLAYOFF_DURATION_MS,
  MAXIMUM_UTC_TIMESTAMP_MS,
  MATCHUP_SCHEDULE_CODES,
  MatchupSchedulePolicyError,
  addLocalDays,
  firstEligibleMonday,
  planExplicitMatchupSchedule,
  planMatchupSchedule,
  planMatchupWeekOneShift,
};
