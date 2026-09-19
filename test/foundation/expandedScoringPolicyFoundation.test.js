const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CATEGORY_KEYS, emptyScoringStats, calculateExpandedScore, usesExpandedScoring } = require("../../src/domain/statistics/expandedScoringPolicy");

test("expanded scoring applies the approved category weights and only the two defence bonuses", () => {
  const expected = [300, 275, 325, 100, 225, 175, 20, 20, 20, 20, -10, 20, -20];
  CATEGORY_KEYS.forEach((key, index) => {
    const stats = { ...emptyScoringStats(), [key]: 1 };
    assert.equal(calculateExpandedScore(stats, "F").fantasyPointsHundredths, expected[index], key);
    assert.equal(calculateExpandedScore(stats, "D").fantasyPointsHundredths, expected[index] + (["hits", "blockedShots"].includes(key) ? 15 : 0), key);
  });
});

test("a game-winning power-play goal stacks with its shot and separate assists", () => {
  const stats = { ...emptyScoringStats(), powerPlayGoals: 1, gameWinningGoals: 1, shotsOnGoal: 3, primaryAssists: 2, secondaryAssists: 1 };
  assert.equal(calculateExpandedScore(stats, "F").fantasyPointsHundredths, 1060);
});

test("deductions can produce negative points and missing categories are never zero-filled", () => {
  const stats = { ...emptyScoringStats(), giveaways: 3, penaltiesTaken: 2 };
  assert.equal(calculateExpandedScore(stats, "D").fantasyPointsHundredths, -70);
  delete stats.hits;
  assert.throws(() => calculateExpandedScore(stats, "F"), /complete/);
  assert.throws(() => calculateExpandedScore({ ...emptyScoringStats(), hits: null }, "F"), /nonnegative/);
  assert.throws(() => calculateExpandedScore(emptyScoringStats(), "G"), /position/);
});

test("expanded season selection preserves historical scoring", () => {
  assert.equal(usesExpandedScoring("20262027"), true);
  assert.equal(usesExpandedScoring("20252026"), false);
  assert.equal(usesExpandedScoring("20272028"), false);
});
