const assert = require("node:assert/strict");
const { test } = require("node:test");
const fixture = require("../fixtures/nhlExpandedScoringGames.json");
const { normalizeExpandedReports } = require("../../src/infrastructure/nhl/normalizeExpandedReports");
const { calculateExpandedScore } = require("../../src/domain/statistics/expandedScoringPolicy");

function input(game) { return { summary: game.summary, realtime: game.realtime, scoring: game.scoringpergame, penalties: game.penalties, penaltyShots: game.penaltyShots, penaltyShotLandings: game.penaltyShotLandings }; }

test("all 144 captured NHL player-games supply every category with reconciled goal and assist totals", () => {
  for (const game of fixture.games) {
    const rows = normalizeExpandedReports(input(game));
    assert.equal(rows.size, 36);
    for (const stats of rows.values()) assert.ok(Number.isSafeInteger(calculateExpandedScore(stats, "F").fantasyPointsHundredths));
  }
});

test("a real shorthanded penalty-shot goal receives the approved even-strength value", () => {
  const game = fixture.games.find((game) => game.gameId === 2025020477);
  const official = game.summary.find((row) => row.playerId === 8480797);
  assert.equal(official.shGoals, 1);
  const stats = normalizeExpandedReports(input(game)).get("2025020477:8480797");
  assert.equal(stats.shortHandedGoals, 0);
  assert.equal(stats.evenStrengthGoals, 1);
  assert.equal(calculateExpandedScore(stats, "F").breakdown.find((row) => row.key === "evenStrengthGoals").pointsHundredths, 300);
  assert.throws(() => normalizeExpandedReports({ ...input(game), penaltyShotLandings: [] }), /penalty shot/);
});

test("real double-minor and misconduct records count infractions rather than penalty minutes", () => {
  const doubleMinor = fixture.games.find((game) => game.gameId === 2025020798);
  const penalty = doubleMinor.penalties.find((row) => row.playerId === 8480188);
  assert.equal(penalty.penaltyMinutes, 4);
  assert.equal(normalizeExpandedReports(input(doubleMinor)).get("2025020798:8480188").penaltiesTaken, 1);
  const misconduct = fixture.games.find((game) => game.gameId === 2025020884);
  const kane = misconduct.penalties.find((row) => row.playerId === 8475169);
  assert.equal(kane.misconductPenalties, 1);
  assert.equal(kane.minorPenalties, 1);
  assert.equal(normalizeExpandedReports(input(misconduct)).get("2025020884:8475169").penaltiesTaken, 2);
});

test("incomplete, duplicated and mismatched reports are rejected instead of manufacturing zero points", () => {
  const game = fixture.games[0], valid = input(game);
  assert.throws(() => normalizeExpandedReports({ ...valid, realtime: valid.realtime.slice(1) }), /coverage/);
  assert.throws(() => normalizeExpandedReports({ ...valid, scoring: [...valid.scoring, valid.scoring[0]] }), /duplicate/);
  const missing = structuredClone(valid); delete missing.penalties[0].penaltiesDrawn;
  assert.throws(() => normalizeExpandedReports(missing), /missing/);
  const corrected = structuredClone(valid); corrected.scoring[0].totalPrimaryAssists += 1;
  assert.throws(() => normalizeExpandedReports(corrected), /reconcile/);
});
