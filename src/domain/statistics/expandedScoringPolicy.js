const EXPANDED_SCORING_VERSION = "expanded-2026-v1";
const EXPANDED_NHL_SEASON = "20262027";
const SCORING_CATEGORIES = Object.freeze([
  ["evenStrengthGoals", "EVG", "Even-strength goals", 300],
  ["powerPlayGoals", "PPG", "Power-play goals", 275],
  ["shortHandedGoals", "SHG", "Shorthanded goals", 325],
  ["gameWinningGoals", "GWG", "Game-winning goals", 100],
  ["primaryAssists", "A1", "Primary assists", 225],
  ["secondaryAssists", "A2", "Secondary assists", 175],
  ["shotsOnGoal", "SOG", "Shots on goal", 20],
  ["hits", "HIT", "Hits", 20],
  ["blockedShots", "BLK", "Blocked shots", 20],
  ["takeaways", "TK", "Takeaways", 20],
  ["giveaways", "GV", "Giveaways", -10],
  ["penaltiesDrawn", "PD", "Penalties drawn", 20],
  ["penaltiesTaken", "PT", "Penalties taken", -20],
].map(([key, abbreviation, label, hundredths]) => Object.freeze({ key, abbreviation, label, hundredths })));
const CATEGORY_KEYS = Object.freeze(SCORING_CATEGORIES.map(({ key }) => key));

function usesExpandedScoring(nhlSeasonKey) {
  return nhlSeasonKey === EXPANDED_NHL_SEASON;
}

function emptyScoringStats() {
  return Object.fromEntries(CATEGORY_KEYS.map((key) => [key, 0]));
}

function normalizeScoringStats(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== CATEGORY_KEYS.length) {
    throw new TypeError("A complete expanded scoring breakdown is required.");
  }
  const result = {};
  for (const key of CATEGORY_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new TypeError(`Expanded scoring ${key} must be a nonnegative integer.`);
    }
    result[key] = value[key];
  }
  return Object.freeze(result);
}

function calculateExpandedScore(value, positionGroup) {
  const stats = normalizeScoringStats(value);
  if (!["F", "D"].includes(positionGroup)) {
    throw new TypeError("Expanded scoring requires a forward or defence position.");
  }
  const breakdown = SCORING_CATEGORIES.map(({ key, hundredths }) => {
    const weight = hundredths + (positionGroup === "D" && ["hits", "blockedShots"].includes(key) ? 15 : 0);
    const pointsHundredths = stats[key] * weight;
    if (!Number.isSafeInteger(pointsHundredths)) throw new RangeError("Expanded points exceed exact arithmetic.");
    return Object.freeze({ key, count: stats[key], weightHundredths: weight, pointsHundredths });
  });
  const fantasyPointsHundredths = breakdown.reduce((sum, row) => sum + row.pointsHundredths, 0);
  if (!Number.isSafeInteger(fantasyPointsHundredths)) throw new RangeError("Expanded total exceeds exact arithmetic.");
  return Object.freeze({ scoringRuleVersion: EXPANDED_SCORING_VERSION, scoringStats: stats, fantasyPointsHundredths, breakdown: Object.freeze(breakdown) });
}

function addScoringStats(target, value) {
  const normalized = normalizeScoringStats(value);
  for (const key of CATEGORY_KEYS) {
    const next = target[key] + normalized[key];
    if (!Number.isSafeInteger(next) || next < 0) throw new RangeError("Expanded category total exceeds exact arithmetic.");
    target[key] = next;
  }
  return target;
}

module.exports = { EXPANDED_SCORING_VERSION, EXPANDED_NHL_SEASON, SCORING_CATEGORIES, CATEGORY_KEYS,
  usesExpandedScoring, emptyScoringStats, normalizeScoringStats, calculateExpandedScore, addScoringStats };
