const assert = require("node:assert/strict");
const { test } = require("node:test");
const { defaultFreeAgentDraftTiming, validateFreeAgentDraftTiming, initialRolloverClock, createFreeAgentDraftClock, validateFreeAgentDraftRolloverSequence, evaluateFreeAgentDraftCompletionEligibility } = require("../../src/domain/freeAgentDraft/freeAgentDraftPolicy");
const HOUR = 60 * 60 * 1000;
const deadline = Date.parse("2026-09-13T18:00:00-07:00");

test("opening and completion use the frozen custom rounds instead of a mandatory seventh round", () => {
  for (const hours of [[24, 28, 33, 38, 43], Array.from({ length: 14 }, (_, index) => (index + 1) * 24)]) {
    const firstMatchupStartsAtMs = deadline + (hours.at(-1) + 5) * HOUR;
    const rolloverTimesAtMs = hours.map(hour => deadline + hour * HOUR);
    const clock = createFreeAgentDraftClock({ cardsOpenedAtMs: deadline - HOUR, firstMatchupStartsAtMs,
      draftTiming: { candidateDeadlineAtMs: deadline, rolloverTimesAtMs } });
    assert.equal(clock.candidateDeadlineAtMs, deadline);
    assert.equal(clock.initialRollovers.length, hours.length);
    const id = index => "00000000-0000-4000-8000-" + String(100 + index).padStart(12, "0");
    const rollovers = clock.initialRollovers.map((row, index) => ({ ...row, id: id(index),
      predecessorRolloverId: index === 0 ? null : id(index - 1), extensionReason: null, extensionSourceId: null, status: "completed" }));
    assert.equal(validateFreeAgentDraftRolloverSequence({ candidateDeadlineAtMs: deadline, rollovers,
      initialRolloverTimesAtMs: rolloverTimesAtMs }).length, hours.length);
    const input = { status: "rapid", nowMs: rolloverTimesAtMs.at(-1), candidateDeadlineAtMs: deadline,
      rollovers, initialRolloverTimesAtMs: rolloverTimesAtMs, cardStatuses: ["locked_complete"],
      allocationStatuses: [], nominationStatuses: [], auctionStatuses: [], recoveryStatuses: [],
      unaccountedPathCount: 0, quarantinedPlayerCount: 0 };
    assert.equal(evaluateFreeAgentDraftCompletionEligibility({ ...input, nowMs: input.nowMs - 1 }).eligible, false);
    assert.equal(evaluateFreeAgentDraftCompletionEligibility(input).eligible, true);
    assert.equal(evaluateFreeAgentDraftCompletionEligibility({ ...input, auctionStatuses: ["open"] }).eligible, false);
  }
});

test("daily defaults produce fourteen rounds for fourteen days and a shorter final round when needed", () => {
  const long = defaultFreeAgentDraftTiming(deadline + 14 * 24 * HOUR, deadline);
  assert.equal(long.rolloverTimesAtMs.length, 14);
  assert.equal(long.rolloverTimesAtMs.at(-1), deadline + 14 * 24 * HOUR);
  const short = defaultFreeAgentDraftTiming(deadline + 30 * HOUR, deadline);
  assert.deepEqual(short.rolloverTimesAtMs, [deadline + 24 * HOUR, deadline + 30 * HOUR]);
});

test("commissioner-chosen round counts and final-day times remain exact and may finish before Week 1", () => {
  const instants = [24, 28, 33, 38, 43].map(hour => deadline + hour * HOUR);
  const timing = validateFreeAgentDraftTiming({ candidateDeadlineAtMs: deadline, rolloverTimesAtMs: instants }, deadline + 48 * HOUR);
  assert.deepEqual(timing.rolloverTimesAtMs, instants);
  const clock = initialRolloverClock(timing, HOUR);
  assert.equal(clock.length, 5);
  assert.equal(clock[0].opensAtMs, deadline);
  assert.equal(clock[1].opensAtMs, instants[0]);
  assert.equal(clock.at(-1).rollsOverAtMs, instants.at(-1));
  assert.equal(clock.at(-1).creationCutoffAtMs, instants.at(-1) - HOUR);
  assert(Object.isFrozen(timing.rolloverTimesAtMs));
});

test("timing rejects duplicates, reversed rounds, rounds after Week 1, empty schedules and hidden extra fields", () => {
  const weekOne = deadline + 48 * HOUR;
  const good = { candidateDeadlineAtMs: deadline, rolloverTimesAtMs: [deadline + 24 * HOUR] };
  for (const invalid of [
    { ...good, rolloverTimesAtMs: [] },
    { ...good, rolloverTimesAtMs: [deadline] },
    { ...good, rolloverTimesAtMs: [deadline + HOUR, deadline + HOUR] },
    { ...good, rolloverTimesAtMs: [deadline + 2 * HOUR, deadline + HOUR] },
    { ...good, rolloverTimesAtMs: [weekOne + 1] },
    { ...good, rolloverTimesAtMs: ["2026-09-14"] },
    { ...good, candidateDeadlineAtMs: weekOne },
    { ...good, override: true },
  ]) assert.throws(() => validateFreeAgentDraftTiming(invalid, weekOne), error => error.code === "FAD_TIMING_INVALID");
});
