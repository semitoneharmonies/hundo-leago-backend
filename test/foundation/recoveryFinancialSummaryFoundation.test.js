const assert = require("node:assert/strict");
const test = require("node:test");
const { summarizeRecoveryFinancialState } = require("../../src/operations/backups/summarizeRecoveryFinancialState");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEASON = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FUTURE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function snapshot(overrides = {}) {
  const records = {
    leagues: [{ id: A, private_name: "do-not-emit-this" }, { id: B }],
    seasons: [{ id: SEASON, league_id: A }, { id: FUTURE, league_id: A }],
    contracts: [{ league_id: A, status: "active", original_total_value_cents: 100, aav_cents: 33 }],
    contract_years: [{ league_id: A, season_id: SEASON, status: "current", aav_cents: 33 },
      { league_id: A, season_id: FUTURE, status: "future", aav_cents: 33 }],
    retention_obligations: [{ league_id: A, status: "active", retained_aav_cents: 5 }],
    retention_years: [{ league_id: A, season_id: SEASON, status: "current", retained_aav_cents: 5 },
      { league_id: A, season_id: FUTURE, status: "future", retained_aav_cents: 5 }],
    buyout_obligations: [{ league_id: A, status: "active", annual_penalty_basis_cents: 400 }],
    buyout_years: [{ league_id: A, season_id: SEASON, status: "current", penalty_cents: 100 },
      { league_id: A, season_id: FUTURE, status: "completed", penalty_cents: 75 }],
    ...overrides,
  };
  return { tables: Object.fromEntries(Object.entries(records).map(([name, list]) =>
    [name, { rows: new Map(list.map((row, index) => [String(index), { row }])) }])) };
}

test("recovery financial summaries keep rounded original totals, years, status and league responsibilities separate", () => {
  const before = snapshot();
  const after = snapshot({ buyout_years: [
    { league_id: A, season_id: SEASON, status: "current", penalty_cents: 125 },
    { league_id: A, season_id: FUTURE, status: "completed", penalty_cents: 75 },
  ] });
  const source = structuredClone(before), preserved = structuredClone(after);
  const result = summarizeRecoveryFinancialState(before, after);
  assert.equal(result.changedLeagues, 1);
  assert.equal(result.unit, "integer-cents");
  assert.equal(result.capCalculationPerformed, false);
  assert.equal(result.completeReconciliation, false);
  assert.equal(result.activationReady, false);
  const league = result.leagues.find(row => row.leagueId === A);
  assert.deepEqual(league.restored.contracts.find(row => row.status === "active"),
    { status: "active", count: 1, originalTotalValueCents: 100, aavCents: 33 });
  const current = league.restored.seasons.find(row => row.seasonId === SEASON);
  const future = league.restored.seasons.find(row => row.seasonId === FUTURE);
  assert.equal(current.contractYears.find(row => row.status === "current").aavCents, 33);
  assert.equal(future.contractYears.find(row => row.status === "future").aavCents, 33);
  assert.equal(current.retentionYears.find(row => row.status === "current").retainedAavCents, 5);
  assert.equal(current.buyoutYears.find(row => row.status === "current").penaltyCents, 100);
  assert.equal(future.buyoutYears.find(row => row.status === "current").penaltyCents, 0);
  assert.equal(future.buyoutYears.find(row => row.status === "completed").penaltyCents, 75);
  assert.equal(result.leagues.find(row => row.leagueId === B).recordedTotalsChanged, false);
  assert.equal(JSON.stringify(result).includes("do-not-emit-this"), false);
  assert.deepEqual(before, source); assert.deepEqual(after, preserved);
});

test("recovery financial totals reject unsafe sums, unknown statuses and wrong-league season rows", () => {
  for (const [changes, code] of [
    [{ contracts: [{ league_id: A, status: "active", original_total_value_cents: Number.MAX_SAFE_INTEGER, aav_cents: 1 },
      { league_id: A, status: "active", original_total_value_cents: 1, aav_cents: 1 }] }, "RECOVERY_FINANCIAL_INTEGER_UNSAFE"],
    [{ contracts: [{ league_id: A, status: "active", original_total_value_cents: 1.5, aav_cents: 1 }] }, "RECOVERY_FINANCIAL_INTEGER_UNSAFE"],
    [{ buyout_years: [{ league_id: B, season_id: SEASON, status: "current", penalty_cents: 100 }] }, "RECOVERY_FINANCIAL_STATE_INVALID"],
    [{ contract_years: [{ league_id: A, season_id: SEASON, status: "__proto__", aav_cents: 33 }] }, "RECOVERY_FINANCIAL_STATE_INVALID"],
    [{ seasons: [] }, "RECOVERY_FINANCIAL_STATE_INVALID"],
  ]) assert.throws(() => summarizeRecoveryFinancialState(snapshot(), snapshot(changes)), { code });
});

test("an empty league is distinct from a missing league and equal totals do not complete reconciliation", () => {
  const before = snapshot(), after = snapshot({ leagues: [{ id: A }] });
  const result = summarizeRecoveryFinancialState(before, after);
  const missing = result.leagues.find(row => row.leagueId === B);
  assert.notEqual(missing.restored, null); assert.equal(missing.preserved, null);
  assert.equal(missing.recordedTotalsChanged, true);
  const identical = summarizeRecoveryFinancialState(before, before);
  assert.equal(identical.changedLeagues, 0);
  assert.equal(identical.completeReconciliation, false);
});

