const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { discoverMigrations, assertMigrationCompatibility } = require("../../infrastructure/database/migrate");
const { normalContractValue } = require("../../domain/contracts/contractPolicy");
const { calculateRetentionCeilingCents } = require("../../domain/contracts/retentionPolicy");
const { calculateBuyoutPenaltyCents } = require("../../domain/contracts/buyoutPolicy");
const { createSqliteCapReadRepository } = require("../../infrastructure/persistence/sqlite/SqliteCapReadRepository");
const { inspectRecoveryInventory } = require("./inspectRecoveryInventory");

const TABLES = ["leagues", "seasons", "teams", "league_settings", "player_ownerships", "contracts", "contract_years",
  "retention_obligations", "retention_years", "buyout_obligations", "buyout_years"];
const LIVE_YEARS = new Set(["current", "future"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const key = row => `${row.league_id}:${row.player_id}`;
class RecoveryFinancialConsistencyError extends Error {
  constructor(code) { super("Financial recovery inspection requires an unchanged, compatible offline database.");
    this.name = "RecoveryFinancialConsistencyError"; this.code = code; }
}
function fail(code) { throw new RecoveryFinancialConsistencyError(code); }
function assertSource(database, digest) {
  if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
      !/^[a-f0-9]{64}$/.test(digest || "")) fail("RECOVERY_FINANCIAL_INPUT_INVALID");
  const stat = fs.lstatSync(database.name);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.existsSync(`${database.name}-journal`) ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      hash(fs.readFileSync(database.name)) !== digest) fail("RECOVERY_FINANCIAL_SOURCE_CHANGED");
}
function group(rows, column) {
  const result = new Map();for (const row of rows) { const value = typeof column === "function" ? column(row) : row[column];
    if (!result.has(value)) result.set(value, []);result.get(value).push(row); }
  return result;
}

// These are reproducible relational and current-policy findings, not proof of
// complete financial history or a decision to override a commissioner correction.
// An over-cap team is reported separately: it is not database corruption.
function inspectRecoveryFinancialConsistency({ database, plaintextSha256, expectedEnvironmentId, expectedDatabaseId, observedAtMs,
  migrationsDirectory = path.resolve(__dirname, "../../../database/migrations") } = {}) {
  try {
    assertSource(database, plaintextSha256);
    const beforeChanges = database.prepare("SELECT total_changes() n").get().n;
    const inventory = inspectRecoveryInventory({ database, expectedEnvironmentId, expectedDatabaseId, observedAtMs });
    assertMigrationCompatibility(database, discoverMigrations({ migrationsDirectory }));
    if (database.pragma("foreign_key_check").length !== 0 ||
        canonicalize(database.pragma("integrity_check")) !== canonicalize([{ integrity_check: "ok" }])) fail("RECOVERY_FINANCIAL_DATABASE_INVALID");
    const result = database.transaction(() => {
      const rows = Object.fromEntries(TABLES.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY ${table === "league_settings" ? "league_id" : "id"}`).all()]));
      const findings = [], warnings = [];
      const add = (code, table, row) => findings.push({ code, table, recordId: row.id, leagueId: row.league_id || row.id,
        recordSha256: hash(canonicalize(row)) });
      for (const table of TABLES) for (const row of rows[table]) for (const [column, value] of Object.entries(row)) {
        if (column.endsWith("_cents") && (!Number.isSafeInteger(value) || value < 0)) fail("RECOVERY_FINANCIAL_INTEGER_UNSAFE");
      }
      const contracts = new Map(rows.contracts.map(row => [row.id, row]));
      const seasons = new Map(rows.seasons.map(row => [row.id, row]));
      const contractYears = group(rows.contract_years, "contract_id"), ownerships = group(rows.player_ownerships, key);
      const activeContracts = group(rows.contracts.filter(row => row.status === "active"), key);
      const retentionYears = group(rows.retention_years, "retention_obligation_id"), buyoutYears = group(rows.buyout_years, "buyout_obligation_id");
      for (const contract of rows.contracts) {
        try {
          const value = normalContractValue(contract.original_total_value_cents, contract.original_term_years);
          if (value.aavCents !== contract.aav_cents || (contract.contract_type === "fantasy_elc" &&
              (contract.original_total_value_cents !== 300 || contract.original_term_years !== 3 || contract.aav_cents !== 100))) {
            add("CONTRACT_VALUE_MISMATCH", "contracts", contract);
          }
        } catch { add("CONTRACT_VALUE_INVALID", "contracts", contract); }
        const years = [...(contractYears.get(contract.id) || [])].sort((a,b) => a.year_number-b.year_number);
        const scheduled = years.filter(year => year.year_number <= contract.original_term_years);
        // A shorter commissioner correction preserves omitted old rows as
        // eliminated years. Do not mistake that retained history for extra term.
        if (scheduled.length !== contract.original_term_years || scheduled.some((year,index) => year.year_number !== index+1) ||
            scheduled[0]?.season_id !== contract.start_season_id || years.some(year => year.aav_cents !== contract.aav_cents ||
              (year.year_number > contract.original_term_years && year.status !== "eliminated"))) add("CONTRACT_SCHEDULE_MISMATCH", "contracts", contract);
        const start = seasons.get(contract.start_season_id)?.nhl_season_key;
        if (!/^\d{8}$/.test(start || "") || Number(start.slice(4)) !== Number(start.slice(0,4))+1 || scheduled.some(year => {
          const first = Number(start.slice(0,4))+year.year_number-1;
          return seasons.get(year.season_id)?.nhl_season_key !== `${first}${first+1}`;
        })) add("CONTRACT_SEASON_SEQUENCE_MISMATCH", "contracts", contract);
        if (contract.status === "active") {
          const live = scheduled.filter(year => LIVE_YEARS.has(year.status));
          if (live.length === 0 || live[0].status !== "current" || live.slice(1).some(year => year.status !== "future") ||
              live.some((year,index) => year.year_number !== live[0].year_number+index) ||
              live.at(-1)?.year_number !== contract.original_term_years ||
              scheduled.filter(year => year.year_number < live[0]?.year_number).some(year => !["completed","expired"].includes(year.status))) {
            add("ACTIVE_CONTRACT_YEARS_MISMATCH", "contracts", contract);
          }
          const owners = ownerships.get(key(contract)) || [];
          const allowedOwnership = owners.length === 1 && (owners[0].ownership_kind === "Rostered" ||
            (owners[0].ownership_kind === "Prospect Right" && owners[0].roster_category === "Prospect" && contract.contract_type === "fantasy_elc"));
          if (!allowedOwnership || owners[0].team_id !== contract.current_team_id ||
              live.filter(year => year.status === "current").length !== 1 || owners[0].season_id !== live[0]?.season_id) {
            add("ACTIVE_CONTRACT_OWNERSHIP_MISMATCH", "contracts", contract);
          }
        } else if (years.some(year => LIVE_YEARS.has(year.status))) add("INACTIVE_CONTRACT_HAS_LIVE_YEARS", "contracts", contract);
      }
      for (const ownership of rows.player_ownerships) {
        const linked = activeContracts.get(key(ownership)) || [];
        if (ownership.ownership_kind === "Prospect Right") {
          // Signing an ELC preserves Prospect Right ownership until promotion.
          if (ownership.roster_category !== "Prospect" || linked.length > 1 ||
              (linked.length === 1 && (linked[0].contract_type !== "fantasy_elc" || linked[0].current_team_id !== ownership.team_id))) {
            add("PROSPECT_RIGHT_CONTRACT_MISMATCH", "player_ownerships", ownership);
          }
        } else if (linked.length !== 1 || linked[0].current_team_id !== ownership.team_id ||
            (ownership.roster_category === "Prospect" && linked[0].contract_type !== "fantasy_elc")) {
          add("ROSTER_CONTRACT_MISMATCH", "player_ownerships", ownership);
        }
      }
      for (const [table, yearTable, yearGroups, amount] of [["retention_obligations","retention_years",retentionYears,"retained_aav_cents"],
        ["buyout_obligations","buyout_years",buyoutYears,"annual_penalty_basis_cents"]]) {
        const retention = table === "retention_obligations", yearAmount = retention ? amount : "penalty_cents";
        for (const obligation of rows[table]) {
          const contract = contracts.get(obligation.contract_id), years = yearGroups.get(obligation.id) || [],
            scheduled = contractYears.get(obligation.contract_id) || [], remaining = years.filter(year => LIVE_YEARS.has(year.status));
          if (!contract || contract.league_id !== obligation.league_id || contract.player_id !== obligation.player_id) {
            add("OBLIGATION_CONTRACT_MISMATCH", table, obligation);continue;
          }
          if (years.length === 0 || years.some(year => !scheduled.some(contractYear => contractYear.season_id === year.season_id))) {
            add("OBLIGATION_SEASON_MISMATCH", table, obligation);
          }
          for (const year of years) if (year[yearAmount] !== obligation[amount]) add("OBLIGATION_YEAR_AMOUNT_MISMATCH", yearTable, year);
          if (!retention && obligation[amount] !== calculateBuyoutPenaltyCents(contract.aav_cents)) add("BUYOUT_POLICY_AMOUNT_REQUIRES_REVIEW", table, obligation);
          if (obligation.status === "active") {
            if (remaining.filter(year => year.status === "current").length !== 1 ||
                !["active","eliminated"].includes(contract.status) || (!retention && contract.status !== "eliminated")) {
              add("ACTIVE_OBLIGATION_STATE_MISMATCH", table, obligation);
            }
            const current = remaining.find(year => year.status === "current"), currentNumber = scheduled.find(year => year.season_id === current?.season_id)?.year_number;
            const expected = scheduled.filter(year => year.year_number >= currentNumber && year.year_number <= contract.original_term_years);
            if (expected.length !== remaining.length || expected.some(year => !remaining.some(other => other.season_id === year.season_id &&
                other.status === (year.year_number === currentNumber ? "current" : "future")))) add("OBLIGATION_REMAINING_SCHEDULE_MISMATCH", table, obligation);
          } else if (remaining.length !== 0) add("INACTIVE_OBLIGATION_HAS_LIVE_YEARS", table, obligation);
        }
      }
      const activeRetention = rows.retention_obligations.filter(row => row.status === "active");
      for (const retained of group(activeRetention, "contract_id").values()) {
        const contract = contracts.get(retained[0].contract_id);if (!contract) continue;
        if (retained.reduce((sum,row) => sum+BigInt(row.retained_aav_cents),0n) > BigInt(calculateRetentionCeilingCents(contract.aav_cents))) {
          for (const row of retained) add("RETENTION_CEILING_EXCEEDED", "retention_obligations", row);
        }
      }
      for (const retained of group(activeRetention,row => `${row.league_id}:${row.responsible_team_id}`).values()) {
        if (retained.length > 3) for (const row of retained) add("RETENTION_SLOT_LIMIT_EXCEEDED", "retention_obligations", row);
      }
      for (const retained of group(activeRetention,row => `${row.league_id}:${row.responsible_team_id}:${row.contract_id}`).values()) {
        if (retained.length > 1) for (const row of retained) add("DUPLICATE_TEAM_RETENTION", "retention_obligations", row);
      }
      const capRepository = createSqliteCapReadRepository({ database });
      const caps = [];
      for (const league of rows.leagues) {
        if (league.current_season_id === null) { warnings.push({code:"CURRENT_SEASON_NOT_CONFIGURED",leagueId:league.id});continue; }
        for (const team of rows.teams.filter(row => row.league_id === league.id)) {
          const cap = capRepository.calculate({leagueId:league.id,seasonId:league.current_season_id,teamId:team.id});
          caps.push({leagueId:league.id,seasonId:league.current_season_id,teamId:team.id,complete:cap.complete,
            capUsageCents:cap.capUsageCents,capLimitCents:cap.capLimitCents,overCap:cap.overCap,calculationSha256:hash(canonicalize(cap))});
          for (const issue of cap.issues) findings.push({code:issue.code,table:"teams",recordId:team.id,leagueId:league.id,recordSha256:hash(canonicalize(issue))});
          if (cap.overCap) warnings.push({code:"TEAM_OVER_CAP",leagueId:league.id,teamId:team.id});
        }
      }
      findings.sort((a,b) => canonicalize(a).localeCompare(canonicalize(b)));
      return {inspectionVersion:1,scope:"recorded-financial-relations-and-current-policy",observedAtMs,
        databaseIdentity:inventory.databaseIdentity,schemaVersion:inventory.schemaVersion,plaintextSha256,
        tables:Object.fromEntries(TABLES.map(table => [table,{count:rows[table].length,sha256:hash(canonicalize(rows[table]))}])),
        findings,warnings,caps,checkedRelationsConsistent:findings.length===0,
        completeFinancialReconciliation:false,correctionHistoryReviewed:false,completeLossWindowEvidence:false,activationReady:false,executable:false};
    }).deferred();
    assertSource(database, plaintextSha256);
    if (database.prepare("SELECT total_changes() n").get().n !== beforeChanges) fail("RECOVERY_FINANCIAL_WRITE_DETECTED");
    return Object.freeze({...result,reportChecksum:hash(canonicalize(result))});
  } catch (error) {
    if (error instanceof RecoveryFinancialConsistencyError) throw error;
    fail("RECOVERY_FINANCIAL_INSPECTION_FAILED");
  }
}
module.exports = {RecoveryFinancialConsistencyError,inspectRecoveryFinancialConsistency};
