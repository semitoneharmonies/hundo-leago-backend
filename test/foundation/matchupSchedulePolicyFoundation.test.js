const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FANTASY_PLAYOFF_DURATION_MS,
  MAXIMUM_UTC_TIMESTAMP_MS,
  MATCHUP_SCHEDULE_CODES,
  planExplicitMatchupSchedule,
  planMatchupWeekOneShift,
} = require("../../src/domain/matchups/matchupSchedulePolicy");

const HOUR_MS = 60 * 60 * 1000;
const TEAM_IDS = Object.freeze([
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000003",
]);
const NHL_REGULAR_SEASON_STARTS_AT_MS =
  Date.parse("2026-10-06T07:00:00.000Z");
const FANTASY_PLAYOFFS_START_AT_MS =
  Date.parse("2027-03-15T07:00:00.000Z");
const FANTASY_PLAYOFFS_END_AT_MS =
  FANTASY_PLAYOFFS_START_AT_MS +
  FANTASY_PLAYOFF_DURATION_MS;
const FIRST_WEEK_STARTS_AT_MS =
  Date.parse("2026-10-12T07:00:00.000Z");
const SECOND_WEEK_STARTS_AT_MS =
  Date.parse("2026-10-19T07:00:00.000Z");
const NOW_MS = Date.parse("2026-09-01T07:00:00.000Z");

function explicitInput(overrides = {}) {
  return {
    teamIds: [...TEAM_IDS],
    nhlSeasonKey: "20262027",
    nhlRegularSeasonStartsAtMs:
      NHL_REGULAR_SEASON_STARTS_AT_MS,
    nhlRegularSeasonEndsAtMs:
      FANTASY_PLAYOFFS_END_AT_MS,
    fantasyPlayoffsStartAtMs:
      FANTASY_PLAYOFFS_START_AT_MS,
    fantasyPlayoffsEndAtMs:
      FANTASY_PLAYOFFS_END_AT_MS,
    firstWeekStartsAtMs: FIRST_WEEK_STARTS_AT_MS,
    timeZone: "America/Vancouver",
    nowMs: NOW_MS,
    ...overrides,
  };
}

function assertPolicyError(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function assertDeeplyFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeeplyFrozen(child);
  }
}

function pairCounts(plan) {
  const counts = new Map();
  for (const week of plan.weeks) {
    for (const pair of week.pairs) {
      const key = [pair.homeTeamId, pair.awayTeamId]
        .sort()
        .join("|");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.values()];
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function mutableExistingWeeks(plan) {
  return plan.weeks.map((week, index) => ({
    id: uuid(100 + index),
    weekKey: week.weekKey,
    sequence: week.sequence,
    startsAtMs: week.startsAtMs,
    baselineAtMs: week.baselineAtMs,
    locksAtMs: week.locksAtMs,
    endsAtMs: week.endsAtMs,
    rollsOverAtMs: week.rollsOverAtMs,
    pairs: week.pairs.map((pair) => ({
      homeTeamId: pair.homeTeamId,
      awayTeamId: pair.awayTeamId,
    })),
    byeTeamId: week.byeTeamId,
  }));
}

function shiftInput({
  existingFirstWeekStartsAtMs =
    SECOND_WEEK_STARTS_AT_MS,
  firstWeekStartsAtMs = FIRST_WEEK_STARTS_AT_MS,
  teamIds = [
    ...TEAM_IDS,
    "00000000-0000-4000-8000-000000000005",
  ],
  calendar = {},
  nowMs = NOW_MS,
} = {}) {
  const explicit = explicitInput({
    ...calendar,
    teamIds,
    firstWeekStartsAtMs:
      existingFirstWeekStartsAtMs,
    nowMs,
  });
  const existingPlan =
    planExplicitMatchupSchedule(explicit);
  return {
    weeks: mutableExistingWeeks(existingPlan),
    nhlSeasonKey: explicit.nhlSeasonKey,
    nhlRegularSeasonStartsAtMs:
      explicit.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      explicit.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs:
      explicit.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs:
      explicit.fantasyPlayoffsEndAtMs,
    firstWeekStartsAtMs,
    timeZone: explicit.timeZone,
    nowMs,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("FAD-05 explicit matchup schedule policy", () => {
  test("returns the complete explicit calendar and a deeply frozen deterministic plan", () => {
    const suppliedTeams = [...TEAM_IDS];
    const plan = planExplicitMatchupSchedule(
      explicitInput({ teamIds: suppliedTeams })
    );

    assert.deepEqual(suppliedTeams, TEAM_IDS);
    assert.equal(plan.nhlSeasonKey, "20262027");
    assert.equal(plan.timeZone, "America/Vancouver");
    assert.equal(
      plan.nhlRegularSeasonStartsAtMs,
      NHL_REGULAR_SEASON_STARTS_AT_MS
    );
    assert.equal(
      plan.nhlRegularSeasonEndsAtMs,
      FANTASY_PLAYOFFS_END_AT_MS
    );
    assert.equal(
      plan.fantasyPlayoffsStartAtMs,
      FANTASY_PLAYOFFS_START_AT_MS
    );
    assert.equal(
      plan.fantasyPlayoffsEndAtMs,
      FANTASY_PLAYOFFS_END_AT_MS
    );
    assert.equal(
      plan.firstWeekStartsAtMs,
      FIRST_WEEK_STARTS_AT_MS
    );
    assert.deepEqual(plan.teamIds, [...TEAM_IDS].sort());
    assert.equal(plan.weeks.length, 22);
    assert.equal(
      plan.weeks.at(-1).endsAtMs,
      FANTASY_PLAYOFFS_START_AT_MS
    );
    assert.equal(
      Math.max(...pairCounts(plan)) -
        Math.min(...pairCounts(plan)),
      1
    );
    assertDeeplyFrozen(plan);
    assert.throws(() => plan.weeks.push({}), TypeError);
  });

  test("uses the selected Week 1 without substituting the first eligible Monday", () => {
    const firstPlan =
      planExplicitMatchupSchedule(explicitInput());
    const secondWeekStartsAtMs =
      Date.parse("2026-10-19T07:00:00.000Z");
    const secondPlan = planExplicitMatchupSchedule(
      explicitInput({
        firstWeekStartsAtMs: secondWeekStartsAtMs,
      })
    );

    assert.equal(
      firstPlan.weeks[0].startsAtMs,
      FIRST_WEEK_STARTS_AT_MS
    );
    assert.equal(
      secondPlan.weeks[0].startsAtMs,
      secondWeekStartsAtMs
    );
    assert.equal(firstPlan.weeks.length, 22);
    assert.equal(secondPlan.weeks.length, 21);
    assert.notDeepEqual(firstPlan.weeks, secondPlan.weeks);
  });

  test("uses consecutive local Mondays across both Pacific DST directions", () => {
    const plan =
      planExplicitMatchupSchedule(explicitInput());
    const fallWeek = plan.weeks.find(
      ({ startsAtMs }) =>
        startsAtMs ===
        Date.parse("2026-10-26T07:00:00.000Z")
    );
    const springWeek = plan.weeks.find(
      ({ startsAtMs }) =>
        startsAtMs ===
        Date.parse("2027-03-08T08:00:00.000Z")
    );

    assert.ok(fallWeek);
    assert.equal(
      fallWeek.endsAtMs - fallWeek.startsAtMs,
      169 * HOUR_MS
    );
    assert.equal(
      fallWeek.endsAtMs,
      Date.parse("2026-11-02T08:00:00.000Z")
    );
    assert.ok(springWeek);
    assert.equal(
      springWeek.endsAtMs - springWeek.startsAtMs,
      167 * HOUR_MS
    );
    assert.equal(
      springWeek.endsAtMs,
      FANTASY_PLAYOFFS_START_AT_MS
    );
  });

  test("rotates byes and balances pairings for an odd stable team set", () => {
    const oddTeams = [
      ...TEAM_IDS,
      "00000000-0000-4000-8000-000000000005",
    ];
    const plan = planExplicitMatchupSchedule(
      explicitInput({ teamIds: oddTeams })
    );
    const byeCounts = new Map(
      oddTeams.map((teamId) => [teamId, 0])
    );

    for (const week of plan.weeks) {
      assert.equal(week.pairs.length, 2);
      assert.equal(oddTeams.includes(week.byeTeamId), true);
      byeCounts.set(
        week.byeTeamId,
        byeCounts.get(week.byeTeamId) + 1
      );
    }
    assert.equal(
      Math.max(...byeCounts.values()) -
        Math.min(...byeCounts.values()),
      1
    );
    assert.equal(
      Math.max(...pairCounts(plan)) -
        Math.min(...pairCounts(plan)),
      1
    );
  });

  test("requires every explicit timestamp and rejects values outside the UTC range", () => {
    for (const property of [
      "nhlRegularSeasonStartsAtMs",
      "nhlRegularSeasonEndsAtMs",
      "fantasyPlayoffsStartAtMs",
      "fantasyPlayoffsEndAtMs",
      "firstWeekStartsAtMs",
      "nowMs",
    ]) {
      const input = explicitInput();
      delete input[property];
      assertPolicyError(
        () => planExplicitMatchupSchedule(input),
        MATCHUP_SCHEDULE_CODES.inputInvalid
      );
    }

    for (const value of [
      -1,
      Number.MAX_SAFE_INTEGER,
      MAXIMUM_UTC_TIMESTAMP_MS + 1,
      1.5,
      "2026-10-06T07:00:00.000Z",
    ]) {
      assertPolicyError(
        () =>
          planExplicitMatchupSchedule(
            explicitInput({
              nhlRegularSeasonStartsAtMs: value,
            })
          ),
        MATCHUP_SCHEDULE_CODES.inputInvalid
      );
    }
  });

  test("requires a canonical consecutive NHL season key and matching UTC years", () => {
    for (const nhlSeasonKey of [
      undefined,
      20262027,
      "2026-2027",
      "20262028",
    ]) {
      assertPolicyError(
        () =>
          planExplicitMatchupSchedule(
            explicitInput({ nhlSeasonKey })
          ),
        nhlSeasonKey === "20262028"
          ? MATCHUP_SCHEDULE_CODES.calendarInvalid
          : MATCHUP_SCHEDULE_CODES.inputInvalid
      );
    }

    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({
            nhlSeasonKey: "20252026",
          })
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );
  });

  test("requires canonical ordering, a shared ending, and exactly 28 elapsed playoff days", () => {
    const invalidCalendars = [
      {
        nhlRegularSeasonStartsAtMs:
          FANTASY_PLAYOFFS_START_AT_MS,
      },
      {
        fantasyPlayoffsEndAtMs:
          FANTASY_PLAYOFFS_END_AT_MS + HOUR_MS,
      },
      {
        nhlRegularSeasonEndsAtMs:
          FANTASY_PLAYOFFS_END_AT_MS + HOUR_MS,
      },
      {
        fantasyPlayoffsStartAtMs:
          FANTASY_PLAYOFFS_START_AT_MS + HOUR_MS,
      },
    ];

    for (const calendar of invalidCalendars) {
      assertPolicyError(
        () =>
          planExplicitMatchupSchedule(
            explicitInput(calendar)
          ),
        MATCHUP_SCHEDULE_CODES.calendarInvalid
      );
    }
  });

  test("requires league-local Monday midnight playoff and Week 1 boundaries", () => {
    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({
            fantasyPlayoffsStartAtMs:
              FANTASY_PLAYOFFS_START_AT_MS + 1,
            fantasyPlayoffsEndAtMs:
              FANTASY_PLAYOFFS_END_AT_MS + 1,
            nhlRegularSeasonEndsAtMs:
              FANTASY_PLAYOFFS_END_AT_MS + 1,
          })
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );
    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({
            firstWeekStartsAtMs:
              FIRST_WEEK_STARTS_AT_MS + HOUR_MS,
          })
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );
    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({ timeZone: "Not/A_Zone" })
        ),
      MATCHUP_SCHEDULE_CODES.inputInvalid
    );
  });

  test("requires Week 1 to be future-facing and wholly inside the scoring range", () => {
    for (const nowMs of [
      FIRST_WEEK_STARTS_AT_MS,
      FIRST_WEEK_STARTS_AT_MS + 1,
    ]) {
      assertPolicyError(
        () =>
          planExplicitMatchupSchedule(
            explicitInput({ nowMs })
          ),
        MATCHUP_SCHEDULE_CODES.calendarInvalid
      );
    }

    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({
            firstWeekStartsAtMs:
              Date.parse("2026-10-05T07:00:00.000Z"),
          })
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );
    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({
            firstWeekStartsAtMs:
              FANTASY_PLAYOFFS_START_AT_MS,
          })
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );

    const oneWeekPlan = planExplicitMatchupSchedule(
      explicitInput({
        firstWeekStartsAtMs:
          Date.parse("2027-03-08T08:00:00.000Z"),
      })
    );
    assert.equal(oneWeekPlan.weeks.length, 1);
    assert.equal(
      oneWeekPlan.weeks[0].endsAtMs,
      FANTASY_PLAYOFFS_START_AT_MS
    );
  });

  test("rejects missing, duplicate, or unstable participant identities", () => {
    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({ teamIds: [TEAM_IDS[0]] })
        ),
      MATCHUP_SCHEDULE_CODES.inputInvalid
    );
    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({
            teamIds: [TEAM_IDS[0], TEAM_IDS[0]],
          })
        ),
      MATCHUP_SCHEDULE_CODES.inputInvalid
    );
    assertPolicyError(
      () =>
        planExplicitMatchupSchedule(
          explicitInput({
            teamIds: [TEAM_IDS[0], "team-2"],
          })
        ),
      MATCHUP_SCHEDULE_CODES.inputInvalid
    );
  });
});

describe("FAD-05 manual Week 1 translation policy", () => {
  test("preserves week identity, pairings, byes, count, and the complete calendar while allowing an earlier start", () => {
    const input = shiftInput();
    const before = clone(input);
    const firstPlan =
      planMatchupWeekOneShift(input);
    const secondPlan =
      planMatchupWeekOneShift(input);

    assert.deepEqual(firstPlan, secondPlan);
    assert.deepEqual(input, before);
    assert.equal(
      Object.isFrozen(input.weeks[0]),
      false
    );
    assert.equal(
      Object.isFrozen(input.weeks[0].pairs[0]),
      false
    );
    assert.equal(
      firstPlan.nhlSeasonKey,
      input.nhlSeasonKey
    );
    assert.equal(
      firstPlan.nhlRegularSeasonStartsAtMs,
      input.nhlRegularSeasonStartsAtMs
    );
    assert.equal(
      firstPlan.nhlRegularSeasonEndsAtMs,
      input.nhlRegularSeasonEndsAtMs
    );
    assert.equal(
      firstPlan.fantasyPlayoffsStartAtMs,
      input.fantasyPlayoffsStartAtMs
    );
    assert.equal(
      firstPlan.fantasyPlayoffsEndAtMs,
      input.fantasyPlayoffsEndAtMs
    );
    assert.equal(
      firstPlan.previousFirstWeekStartsAtMs,
      SECOND_WEEK_STARTS_AT_MS
    );
    assert.equal(
      firstPlan.firstWeekStartsAtMs,
      FIRST_WEEK_STARTS_AT_MS
    );
    assert.equal(
      firstPlan.shiftedWeekCount,
      input.weeks.length
    );
    assert.equal(firstPlan.weeks.length, 21);
    assert.equal(
      firstPlan.lastWeekEndsAtMs,
      Date.parse("2027-03-08T08:00:00.000Z")
    );
    assert.ok(
      firstPlan.lastWeekEndsAtMs <
        input.fantasyPlayoffsStartAtMs
    );
    assert.deepEqual(
      firstPlan.weeks.map((week) => ({
        id: week.id,
        weekKey: week.weekKey,
        sequence: week.sequence,
        pairs: week.pairs,
        byeTeamId: week.byeTeamId,
      })),
      input.weeks.map((week) => ({
        id: week.id,
        weekKey: week.weekKey,
        sequence: week.sequence,
        pairs: week.pairs,
        byeTeamId: week.byeTeamId,
      }))
    );
    assert.notEqual(
      firstPlan.weeks[0],
      input.weeks[0]
    );
    assert.notEqual(
      firstPlan.weeks[0].pairs[0],
      input.weeks[0].pairs[0]
    );
    assertDeeplyFrozen(firstPlan);
  });

  test("recomputes both DST directions with league-local day arithmetic", () => {
    const playoffsStartAtMs =
      Date.parse("2027-03-22T07:00:00.000Z");
    const playoffsEndAtMs =
      playoffsStartAtMs +
      FANTASY_PLAYOFF_DURATION_MS;
    const plan = planMatchupWeekOneShift(
      shiftInput({
        existingFirstWeekStartsAtMs:
          Date.parse("2026-10-26T07:00:00.000Z"),
        firstWeekStartsAtMs:
          SECOND_WEEK_STARTS_AT_MS,
        calendar: {
          fantasyPlayoffsStartAtMs:
            playoffsStartAtMs,
          fantasyPlayoffsEndAtMs:
            playoffsEndAtMs,
          nhlRegularSeasonEndsAtMs:
            playoffsEndAtMs,
        },
      })
    );
    const fallWeek = plan.weeks.find(
      ({ startsAtMs }) =>
        startsAtMs ===
        Date.parse("2026-10-26T07:00:00.000Z")
    );
    const springWeek = plan.weeks.find(
      ({ startsAtMs }) =>
        startsAtMs ===
        Date.parse("2027-03-08T08:00:00.000Z")
    );

    assert.ok(fallWeek);
    assert.equal(
      fallWeek.endsAtMs - fallWeek.startsAtMs,
      169 * HOUR_MS
    );
    assert.equal(
      fallWeek.baselineAtMs,
      Date.parse("2026-10-26T08:00:00.000Z")
    );
    assert.equal(
      fallWeek.locksAtMs,
      Date.parse("2026-10-26T23:00:00.000Z")
    );
    assert.ok(springWeek);
    assert.equal(
      springWeek.endsAtMs -
        springWeek.startsAtMs,
      167 * HOUR_MS
    );
    assert.equal(
      springWeek.endsAtMs,
      Date.parse("2027-03-15T07:00:00.000Z")
    );
  });

  test("rejects malformed or noncanonical existing schedule evidence", () => {
    const cases = [
      {
        code: MATCHUP_SCHEDULE_CODES.inputInvalid,
        change(input) {
          input.weeks = [];
        },
      },
      {
        code: MATCHUP_SCHEDULE_CODES.calendarInvalid,
        change(input) {
          input.weeks[1].id = input.weeks[0].id;
        },
      },
      {
        code: MATCHUP_SCHEDULE_CODES.calendarInvalid,
        change(input) {
          input.weeks[1].sequence = 3;
        },
      },
      {
        code: MATCHUP_SCHEDULE_CODES.calendarInvalid,
        change(input) {
          input.weeks[0].weekKey = "regular-99";
        },
      },
      {
        code: MATCHUP_SCHEDULE_CODES.calendarInvalid,
        change(input) {
          input.weeks[0].baselineAtMs += 1;
        },
      },
      {
        code: MATCHUP_SCHEDULE_CODES.calendarInvalid,
        change(input) {
          input.weeks[0].pairs[0].awayTeamId =
            input.weeks[0].pairs[0].homeTeamId;
        },
      },
      {
        code: MATCHUP_SCHEDULE_CODES.calendarInvalid,
        change(input) {
          input.weeks[1].byeTeamId = uuid(999);
        },
      },
      {
        code: MATCHUP_SCHEDULE_CODES.inputInvalid,
        change(input) {
          delete input.weeks[0].byeTeamId;
        },
      },
    ];

    for (const scenario of cases) {
      const input = shiftInput();
      scenario.change(input);
      assertPolicyError(
        () => planMatchupWeekOneShift(input),
        scenario.code
      );
    }
  });

  test("requires distinct future local-Monday old and new Week 1 starts", () => {
    const same = shiftInput({
      firstWeekStartsAtMs:
        SECOND_WEEK_STARTS_AT_MS,
    });
    assertPolicyError(
      () => planMatchupWeekOneShift(same),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );

    const nonMonday = shiftInput();
    nonMonday.firstWeekStartsAtMs += HOUR_MS;
    assertPolicyError(
      () => planMatchupWeekOneShift(nonMonday),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );

    const newStartNotFuture = shiftInput();
    newStartNotFuture.nowMs =
      newStartNotFuture.firstWeekStartsAtMs;
    assertPolicyError(
      () =>
        planMatchupWeekOneShift(
          newStartNotFuture
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );

    const oldStartNotFuture = shiftInput();
    oldStartNotFuture.nowMs =
      oldStartNotFuture.weeks[0].startsAtMs;
    assertPolicyError(
      () =>
        planMatchupWeekOneShift(
          oldStartNotFuture
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );

    const outsideNhlRange = shiftInput();
    outsideNhlRange.firstWeekStartsAtMs =
      Date.parse("2026-10-05T07:00:00.000Z");
    assertPolicyError(
      () =>
        planMatchupWeekOneShift(
          outsideNhlRange
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );
  });

  test("rejects a translation that would move any retained week into the fixed playoffs", () => {
    const fullSchedule = shiftInput({
      existingFirstWeekStartsAtMs:
        FIRST_WEEK_STARTS_AT_MS,
      firstWeekStartsAtMs:
        SECOND_WEEK_STARTS_AT_MS,
    });
    assert.equal(fullSchedule.weeks.length, 22);

    assertPolicyError(
      () =>
        planMatchupWeekOneShift(fullSchedule),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );
    assert.equal(
      fullSchedule.weeks.at(-1).endsAtMs,
      FANTASY_PLAYOFFS_START_AT_MS
    );
  });

  test("revalidates the complete unchanged NHL and playoff calendar", () => {
    const invalidSharedEnd = shiftInput();
    invalidSharedEnd.nhlRegularSeasonEndsAtMs +=
      HOUR_MS;
    assertPolicyError(
      () =>
        planMatchupWeekOneShift(
          invalidSharedEnd
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );

    const invalidSeasonKey = shiftInput();
    invalidSeasonKey.nhlSeasonKey = "20262028";
    assertPolicyError(
      () =>
        planMatchupWeekOneShift(
          invalidSeasonKey
        ),
      MATCHUP_SCHEDULE_CODES.calendarInvalid
    );
  });
});
