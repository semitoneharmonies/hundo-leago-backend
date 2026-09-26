const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  defaultSeasonCalendar, isDefaultSeasonCalendar, planExplicitMatchupSchedule,
  planMatchupWeekOneShift, addLocalDays,
} = require("../../src/domain/matchups/matchupSchedulePolicy");
const { validateSeasonRolloverCalendar } = require("../../src/domain/leagues/leagueLifecycleTransitionPolicy");
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const zone = "America/Vancouver";
const defaults = defaultSeasonCalendar("20262027", zone);
const input = { ...defaults, timeZone: zone, teamIds: ids, nowMs: Date.parse("2026-09-01T00:00:00Z") };

test("the approved default covers every scoring day once and excludes both breaks", () => {
  for (const timeZone of [zone, "America/New_York", "UTC"]) {
    const calendar = defaultSeasonCalendar("20262027", timeZone);
    const plan = planExplicitMatchupSchedule({ ...input, ...calendar, timeZone });
    assert.equal(plan.weeks.length, 22);
    assert.equal(plan.weeks[0].startsAtMs, calendar.nhlRegularSeasonStartsAtMs);
    assert.equal(plan.weeks.at(-1).endsAtMs, calendar.fantasyPlayoffsStartAtMs);
    for (let day = calendar.firstWeekStartsAtMs; day < calendar.fantasyPlayoffsStartAtMs; day = addLocalDays(day, 1, timeZone)) {
      const excluded = calendar.scoringBreaks.some((b) => day >= b.startsAtMs && day < b.endsAtMs);
      assert.equal(plan.weeks.filter((w) => day >= w.startsAtMs && day < w.endsAtMs).length, excluded ? 0 : 1);
    }
    for (const week of plan.weeks) {
      assert.ok(week.startsAtMs < week.baselineAtMs && week.baselineAtMs < week.locksAtMs && week.locksAtMs < week.endsAtMs);
      assert.equal(new Set([...week.pairs.flatMap((p) => [p.homeTeamId, p.awayTeamId]), week.byeTeamId]).size, 5);
      assert.equal(calendar.scoringBreaks.some((b) => week.startsAtMs < b.endsAtMs && week.endsAtMs > b.startsAtMs), false);
    }
    assert.equal(plan.fantasyPlayoffsEndAtMs - plan.fantasyPlayoffsStartAtMs, 27 * 86_400_000);
  }
});

test("all baselines and roster locks use day one including Tuesday opening and Saturday after Christmas", () => {
  for (const timeZone of [zone, "Etc/GMT+7"]) {
    const calendar = defaultSeasonCalendar("20262027", timeZone);
    const plan = planExplicitMatchupSchedule({ ...input, ...calendar, timeZone });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" });
    for (const week of plan.weeks) {
      assert.equal(day.format(week.baselineAtMs), day.format(week.startsAtMs));
      assert.equal(day.format(week.locksAtMs), day.format(week.startsAtMs));
      assert.equal(hour.format(week.baselineAtMs), "01");
      assert.equal(hour.format(week.locksAtMs), "16");
    }
    assert.equal(day.format(plan.weeks[0].startsAtMs), "2026-09-29");
    assert.equal(day.format(plan.weeks[12].startsAtMs), "2026-12-26");
    assert.equal(day.format(plan.weeks[17].startsAtMs), "2027-02-08");
  }
});

test("only the exact approved season/calendar gets partial-week and break behavior", () => {
  assert.equal(defaultSeasonCalendar("20272028", zone), null);
  assert.equal(isDefaultSeasonCalendar(defaults, zone), true);
  assert.equal(isDefaultSeasonCalendar({ ...defaults, fantasyPlayoffsEndAtMs: defaults.fantasyPlayoffsEndAtMs + 1 }, zone), false);
  for (const firstWeekStartsAtMs of [defaults.scoringBreaks[0].startsAtMs, defaults.scoringBreaks[1].startsAtMs, defaults.firstWeekStartsAtMs + 1000]) {
    assert.throws(() => planExplicitMatchupSchedule({ ...input, firstWeekStartsAtMs }), { code: "MATCHUP_SCHEDULE_CALENDAR_INVALID" });
  }
});

test("a Week 1 correction preserves matchups and the holiday boundaries", () => {
  const plan = planExplicitMatchupSchedule(input);
  const weeks = plan.weeks.map((w, i) => ({ ...w, id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}` }));
  const shifted = planMatchupWeekOneShift({ ...input, weeks, firstWeekStartsAtMs: addLocalDays(input.firstWeekStartsAtMs, 1, zone) });
  assert.equal(shifted.weeks[0].startsAtMs, Date.parse("2026-09-30T07:00:00Z"));
  assert.deepEqual(shifted.weeks.slice(1), weeks.slice(1));
  assert.deepEqual(shifted.weeks.map((w) => w.pairs), weeks.map((w) => w.pairs));
  assert.throws(() => planMatchupWeekOneShift({ ...input, weeks, firstWeekStartsAtMs: Date.parse("2026-10-05T07:00:00Z") }), { code: "MATCHUP_SCHEDULE_CALENDAR_INVALID" });
});

test("the new closing boundary remains valid as the source of the following season rollover", () => {
  const { firstWeekStartsAtMs, scoringBreaks, ...source } = defaults;
  assert.ok(firstWeekStartsAtMs && scoringBreaks.length === 2);
  const target = { nhlSeasonKey: "20272028", nhlRegularSeasonStartsAtMs: Date.parse("2027-10-01T07:00:00Z"), nhlRegularSeasonEndsAtMs: Date.parse("2028-04-10T07:00:00Z"), fantasyPlayoffsStartAtMs: Date.parse("2028-03-13T07:00:00Z"), fantasyPlayoffsEndAtMs: Date.parse("2028-04-10T07:00:00Z") };
  assert.doesNotThrow(() => validateSeasonRolloverCalendar({ leagueTimeZone: zone, source, target, entryDraftStartsAtMs: Date.parse("2027-07-01T07:00:00Z"), attemptedAtMs: Date.parse("2027-07-01T08:00:00Z"), weekOneStartsAtMs: Date.parse("2027-10-04T07:00:00Z") }));
});
