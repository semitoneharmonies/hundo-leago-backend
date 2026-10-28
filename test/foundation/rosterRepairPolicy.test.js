const assert = require("node:assert/strict");
const { test } = require("node:test");
const { solveRosterRepair } = require("../../src/domain/rosters/rosterRepairPolicy");

const categories = ["Active", "Bench", "Injured Reserve"];
const player = (id, extra = {}) => ({ playerId: id, rosterCategory: "Active", positionGroup: "F",
  aavCents: 100, retainedAavCents: 0, injuryStatus: "healthy", irEligible: false, scheduledGames: 3, ...extra });
const input = (players, extra = {}) => ({ players, capLimitCents: 10_000, fixedObligationsCents: 0, scheduleAvailable: true, ...extra });

// Deliberately enumerate all three destinations independently from the production
// subset algorithm, then compare the full objective and deterministic assignment.
function bruteForce(value) {
  const players = [...value.players].sort((a, b) => a.playerId.localeCompare(b.playerId));
  let best = null;
  const assignment = [];
  function visit(index) {
    if (index < players.length) {
      for (const category of categories) { assignment.push(category); visit(index + 1); assignment.pop(); }
      return;
    }
    let forwards = 0, defence = 0, bench = 0, ir = 0, cost = value.fixedObligationsCents, games = 0, injured = 0, moves = 0;
    for (let i = 0; i < players.length; i += 1) {
      const row = players[i], destination = assignment[i];
      moves += Number(destination !== row.rosterCategory);
      if (destination === "Active") {
        if (row.positionGroup === "F") forwards += 1; else defence += 1;
        cost += row.aavCents - row.retainedAavCents;
        if (row.injuryStatus === "injured") injured += 1;
        else if (value.scheduleAvailable) games += row.scheduledGames;
      } else if (destination === "Bench") {
        bench += 1;
        if (row.aavCents > 400) return;
      } else {
        ir += 1;
        if (row.injuryStatus === "healthy" || (!row.irEligible && row.rosterCategory !== "Injured Reserve")) return;
      }
    }
    if (forwards > 12 || defence > 6 || bench > 4 || ir > 4 || cost > value.capLimitCents) return;
    const signature = assignment.map(category => categories.indexOf(category)).join("");
    const rank = [-games, value.scheduleAvailable ? injured : 0, moves];
    const comparison = best ? rank.findIndex((component, i) => component !== best.rank[i]) : -1;
    if (best && (comparison === -1 ? signature >= best.signature : rank[comparison] > best.rank[comparison])) return;
    best = { rank, signature, assignments: players.map((row, i) => ({ playerId: row.playerId, rosterCategory: assignment[i] })), cost, games, moves };
  }
  visit(0);
  return best;
}

test("maximizes games exactly when choosing the biggest individual schedule is suboptimal", () => {
  const result = solveRosterRepair(input([
    player("a", { aavCents: 400, scheduledGames: 4 }),
    player("b", { aavCents: 300, scheduledGames: 3 }),
    player("c", { aavCents: 300, scheduledGames: 3 }),
  ], { capLimitCents: 700, fixedObligationsCents: 100 }));
  assert.equal(result.status, "plan");
  assert.deepEqual(result.assignments, [
    { playerId: "a", rosterCategory: "Bench" },
    { playerId: "b", rosterCategory: "Active" },
    { playerId: "c", rosterCategory: "Active" },
  ]);
  assert.equal(result.metrics.scheduledGames, 6);
  assert.equal(result.metrics.capUsageCents, 700);
});

test("uses active net salary, keeps fixed obligations, and uses gross salary for Bench eligibility", () => {
  const players = [player("retained", { aavCents: 600, retainedAavCents: 400 })];
  assert.equal(solveRosterRepair(input(players, { capLimitCents: 700, fixedObligationsCents: 500 })).metrics.capUsageCents, 700);
  assert.equal(solveRosterRepair(input(players, { capLimitCents: 699, fixedObligationsCents: 500 })).status, "blocked");
  assert.equal(solveRosterRepair(input([], { capLimitCents: 499, fixedObligationsCents: 500 })).status, "blocked");
});

test("moves injured players off Active when games tie and never keeps explicit healthy IR", () => {
  const result = solveRosterRepair(input([
    player("injured", { injuryStatus: "injured", irEligible: true, aavCents: 500, scheduledGames: 8 }),
    player("healthy", { rosterCategory: "Injured Reserve", scheduledGames: 2 }),
  ]));
  assert.deepEqual(result.assignments, [
    { playerId: "healthy", rosterCategory: "Active" },
    { playerId: "injured", rosterCategory: "Injured Reserve" },
  ]);
  assert.equal(result.metrics.scheduledGames, 2);
  assert.equal(result.metrics.activeInjured, 0);
});

test("unknown existing IR may stay but unknown players cannot newly enter IR without eligibility", () => {
  const result = solveRosterRepair(input([
    player("unknown", { rosterCategory: "Injured Reserve", injuryStatus: "unknown", aavCents: 600, scheduledGames: null }),
  ], { scheduleAvailable: false, capLimitCents: 0 }));
  assert.equal(result.status, "plan");
  assert.equal(result.metrics.moveCount, 0);
  assert.equal(result.metrics.scheduledGames, null);
  const blocked = solveRosterRepair(input([player("unknown", { injuryStatus: "unknown", aavCents: 600 })], { capLimitCents: 0 }));
  assert.equal(blocked.status, "blocked");
});

test("full Bench/IR and position capacities are hard limits without requiring full Active slots", () => {
  const tooManyDefence = Array.from({ length: 11 }, (_, i) => player(`d${i}`, { positionGroup: "D" }));
  assert.equal(solveRosterRepair(input(tooManyDefence)).status, "blocked");
  const tenDefence = solveRosterRepair(input(tooManyDefence.slice(0, 10)));
  assert.equal(tenDefence.metrics.activeDefence, 6);
  assert.equal(tenDefence.metrics.bench, 4);
  assert.equal(solveRosterRepair(input([])).metrics.active, 0);
  const costlyInjured = Array.from({ length: 5 }, (_, i) => player(`i${i}`, { aavCents: 500, injuryStatus: "injured", irEligible: true }));
  assert.equal(solveRosterRepair(input(costlyInjured, { capLimitCents: 0 })).status, "blocked");
});

test("ties minimize category changes and then use stable player IDs independent of input order", () => {
  const a = player("a", { rosterCategory: "Bench" });
  const b = player("b");
  const value = input([a, b], { capLimitCents: 100 });
  const result = solveRosterRepair(value);
  assert.equal(result.metrics.moveCount, 0);
  assert.deepEqual(result.assignments, [{ playerId: "a", rosterCategory: "Bench" }, { playerId: "b", rosterCategory: "Active" }]);
  const tie = input([player("b"), player("a")], { capLimitCents: 100 });
  assert.deepEqual(solveRosterRepair(tie).assignments, [{ playerId: "a", rosterCategory: "Active" }, { playerId: "b", rosterCategory: "Bench" }]);
  assert.deepEqual(solveRosterRepair({ ...tie, players: [...tie.players].reverse() }), solveRosterRepair(tie));
});

test("missing schedule makes no games claim and chooses the smallest legal repair", () => {
  const value = input([
    player("a", { scheduledGames: null }),
    player("b", { rosterCategory: "Bench", scheduledGames: 100 }),
    player("c", { injuryStatus: "injured", irEligible: true, scheduledGames: undefined }),
  ], { scheduleAvailable: false });
  const result = solveRosterRepair(value);
  assert.equal(result.metrics.moveCount, 0);
  assert.equal(result.metrics.scheduledGames, null);
  assert.equal(result.metrics.scheduleAvailable, false);
});

test("invalid contracts, positions, duplicates, prospects and oversized rosters block without changing inputs", () => {
  for (const players of [
    [player("a", { aavCents: null })], [player("a", { retainedAavCents: 101 })],
    [player("a", { positionGroup: "G" })], [player("a"), player("a")],
    [player("a", { rosterCategory: "Prospect" })], [player("a", { scheduledGames: null })],
    Array.from({ length: 27 }, (_, i) => player(`p${i}`)),
  ]) assert.equal(solveRosterRepair(input(players)).status, "blocked");
  const value = input([player("b"), player("a")], { capLimitCents: 100 });
  const before = JSON.stringify(value);
  Object.freeze(value.players[0]); Object.freeze(value.players[1]); Object.freeze(value.players); Object.freeze(value);
  const result = solveRosterRepair(value);
  assert.equal(JSON.stringify(value), before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.assignments));
});

test("search exhaustion never reports an unproved optimum or partially usable plan", () => {
  const result = solveRosterRepair(input([player("a"), player("b")]), { maxSearchNodes: 3 });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasonCodes, ["ROSTER_REPAIR_SEARCH_LIMIT"]);
  assert.deepEqual(result.assignments, []);
  assert.equal(result.metrics, null);
});

test("solves the complete 26-player boundary with all eight inactive places required", () => {
  const players = Array.from({ length: 26 }, (_, i) => player(`p${String(i).padStart(2, "0")}`, {
    positionGroup: i < 16 ? "F" : "D", injuryStatus: "injured", irEligible: true,
  }));
  const result = solveRosterRepair(input(players));
  assert.equal(result.status, "plan");
  assert.equal(result.metrics.activeForwards, 12);
  assert.equal(result.metrics.activeDefence, 6);
  assert.equal(result.metrics.bench, 4);
  assert.equal(result.metrics.injuredReserve, 4);
  assert.equal(result.metrics.activeInjured, 18);
  assert.equal(result.metrics.scheduledGames, 0);
  assert.equal(result.metrics.moveCount, 8);
});

test("exact solver matches independent brute-force oracle across mixed small rosters", () => {
  let seed = 301;
  const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  for (let scenario = 0; scenario < 80; scenario += 1) {
    const players = Array.from({ length: 7 }, (_, i) => {
      const injuryStatus = ["healthy", "injured", "unknown"][random(3)];
      const aavCents = [100, 200, 300, 400, 500, 700][random(6)];
      return player(`p${i}`, { rosterCategory: categories[random(3)], positionGroup: random(3) ? "F" : "D",
        aavCents, retainedAavCents: random(2) ? 0 : Math.floor(aavCents / 2),
        injuryStatus, irEligible: injuryStatus !== "healthy" && random(2) === 0, scheduledGames: random(6) });
    });
    const value = input(players, { scheduleAvailable: random(3) !== 0, capLimitCents: 200 + random(15) * 100, fixedObligationsCents: random(4) * 100 });
    const expected = bruteForce(value), actual = solveRosterRepair(value);
    assert.equal(actual.status, expected ? "plan" : "blocked", `scenario ${scenario}`);
    if (!expected) continue;
    assert.deepEqual(actual.assignments, expected.assignments, `scenario ${scenario}`);
    assert.equal(actual.metrics.capUsageCents, expected.cost);
    assert.equal(actual.metrics.moveCount, expected.moves);
    assert.equal(actual.metrics.scheduledGames, value.scheduleAvailable ? expected.games : null);
  }
});
