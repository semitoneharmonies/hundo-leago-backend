const { canonicalize } = require("../../infrastructure/migration/sourceInventory");

const CONTRACT_STATES = ["active", "expired", "eliminated", "cancelled"];
const OBLIGATION_STATES = ["active", "completed", "cancelled"];
const CONTRACT_YEAR_STATES = ["future", "current", "completed", "expired", "eliminated"];
const OBLIGATION_YEAR_STATES = ["future", "current", "completed", "cancelled"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class RecoveryFinancialSummaryError extends Error {
  constructor(code) {
    super("Recorded recovery financial totals require complete, safely represented league and season records.");
    this.name = "RecoveryFinancialSummaryError"; this.code = code;
  }
}
function fail(code = "RECOVERY_FINANCIAL_STATE_INVALID") { throw new RecoveryFinancialSummaryError(code); }
function rows(snapshot, name) {
  const table = snapshot?.tables?.[name];
  if (!(table?.rows instanceof Map)) fail();
  return [...table.rows.values()].map(value => value.row);
}
function grouped(records, statuses, amounts) {
  const groups = Object.fromEntries(statuses.map(status => [status, { status, count: 0,
    ...Object.fromEntries(Object.values(amounts).map(field => [field, 0])) }]));
  for (const row of records) {
    const result = Object.hasOwn(groups, row.status) ? groups[row.status] : null;
    if (!result) fail();
    result.count++;
    for (const [column, field] of Object.entries(amounts)) {
      if (!Number.isSafeInteger(row[column]) || row[column] < 0) fail("RECOVERY_FINANCIAL_INTEGER_UNSAFE");
      const total = BigInt(result[field]) + BigInt(row[column]);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail("RECOVERY_FINANCIAL_INTEGER_UNSAFE");
      result[field] = Number(total);
    }
  }
  return Object.values(groups);
}

// Consumes the exact private snapshots already verified by the loss-window
// comparison. These are recorded original values and scheduled obligations,
// separated by status; they are not a derived current team-cap calculation.
function summarize(snapshot) {
  const names = ["leagues", "seasons", "contracts", "contract_years", "retention_obligations",
    "retention_years", "buyout_obligations", "buyout_years"];
  const tables = Object.fromEntries(names.map(name => [name, rows(snapshot, name)]));
  const leagues = new Map(tables.leagues.map(row => [row.id, row]));
  const seasons = new Map(tables.seasons.map(row => [row.id, row]));
  if (leagues.size !== tables.leagues.length || seasons.size !== tables.seasons.length ||
      [...leagues.keys(), ...seasons.keys()].some(id => !UUID.test(id))) fail();
  for (const name of names.filter(name => name !== "leagues")) {
    for (const row of tables[name]) {
      if (!leagues.has(row.league_id)) fail();
      if (name.endsWith("_years") && seasons.get(row.season_id)?.league_id !== row.league_id) fail();
    }
  }
  return new Map([...leagues.keys()].sort().map(leagueId => {
    const leagueRows = name => tables[name].filter(row => row.league_id === leagueId);
    return [leagueId, {
      contracts: grouped(leagueRows("contracts"), CONTRACT_STATES,
        { original_total_value_cents: "originalTotalValueCents", aav_cents: "aavCents" }),
      retentionObligations: grouped(leagueRows("retention_obligations"), OBLIGATION_STATES,
        { retained_aav_cents: "retainedAavCents" }),
      buyoutObligations: grouped(leagueRows("buyout_obligations"), OBLIGATION_STATES,
        { annual_penalty_basis_cents: "annualPenaltyBasisCents" }),
      seasons: leagueRows("seasons").sort((a, b) => a.id.localeCompare(b.id)).map(season => {
        const yearRows = name => leagueRows(name).filter(row => row.season_id === season.id);
        return { seasonId: season.id,
          contractYears: grouped(yearRows("contract_years"), CONTRACT_YEAR_STATES, { aav_cents: "aavCents" }),
          retentionYears: grouped(yearRows("retention_years"), OBLIGATION_YEAR_STATES, { retained_aav_cents: "retainedAavCents" }),
          buyoutYears: grouped(yearRows("buyout_years"), OBLIGATION_YEAR_STATES, { penalty_cents: "penaltyCents" }) };
      }),
    }];
  }));
}

function summarizeRecoveryFinancialState(restored, preserved) {
  const left = summarize(restored), right = summarize(preserved);
  const leagues = [...new Set([...left.keys(), ...right.keys()])].sort().map(leagueId => {
    const restored = left.get(leagueId) ?? null, preserved = right.get(leagueId) ?? null;
    return { leagueId, restored, preserved, recordedTotalsChanged: canonicalize(restored) !== canonicalize(preserved) };
  });
  return { summaryVersion: 1, scope: "recorded-contract-and-obligation-schedules", unit: "integer-cents",
    leagues, changedLeagues: leagues.filter(row => row.recordedTotalsChanged).length,
    capCalculationPerformed: false, completeReconciliation: false, activationReady: false };
}

module.exports = { RecoveryFinancialSummaryError, summarizeRecoveryFinancialState };
