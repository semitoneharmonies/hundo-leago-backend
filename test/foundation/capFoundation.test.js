const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  CAP_POLICY_CODES,
  CapPolicyError,
  calculateTeamCap,
} = require("../../src/domain/contracts/capPolicy");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { createSqliteCapReadRepository } = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCapReadRepository"
);
const { createSqliteRepositoryContext } = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-07-21T00:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(10), season1: uuid(20), season2: uuid(21),
  team1: uuid(30), team2: uuid(31),
  activePlayer: uuid(40), benchPlayer: uuid(41), irPlayer: uuid(42),
  prospectPlayer: uuid(43), boughtOutPlayer: uuid(44), missingPlayer: uuid(45),
  activeContract: uuid(50), benchContract: uuid(51), irContract: uuid(52),
  prospectContract: uuid(53), eliminatedContract: uuid(54),
  retentionOnActive: uuid(60), retentionForTeam: uuid(61), buyout: uuid(62),
});

function insertPlayer(context, id, lastName) {
  context.repositories.players.insert({
    id, first_name: "Player", last_name: lastName,
    full_name: `Player ${lastName}`, birth_date: null, status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
}

function insertContract(context, { id, playerId, teamId, aavCents, status = "active" }) {
  context.repositories.contracts.insert({
    id, league_id: IDS.league, player_id: playerId, current_team_id: teamId,
    contract_type: "normal", original_total_value_cents: aavCents,
    original_term_years: 1, aav_cents: aavCents,
    start_season_id: IDS.season1, status,
    acquisition_source_type: "migration", acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null, created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.contract_years.insert({
    id: uuid(Number(id.slice(-12)) + 100), league_id: IDS.league,
    contract_id: id, season_id: IDS.season1, year_number: 1,
    aav_cents: aavCents, status: status === "active" ? "current" : "eliminated",
    rollover_at_ms: status === "active" ? null : NOW_MS,
    created_at_ms: NOW_MS,
  });
}

function insertOwnership(context, { id, playerId, category, slotNumber, teamId = IDS.team1 }) {
  context.repositories.player_ownerships.insert({
    id, league_id: IDS.league, season_id: IDS.season1, player_id: playerId,
    team_id: teamId, ownership_kind: "Rostered", roster_category: category,
    position_group: "F", slot_number: slotNumber,
    acquired_transaction_type: "migration", acquired_transaction_id: null,
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
}

function seed(context) {
  context.repositories.leagues.insert({
    id: IDS.league, name: "League", name_normalized: "league", status: "setup",
    timezone: "America/Vancouver", commissioner_membership_id: null,
    current_season_id: null, created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.league_settings.insert({
    league_id: IDS.league, salary_cap_cents: 10_000,
    trade_deadline_at_ms: null, maximum_teams: 10,
    active_forward_slots: 12, active_defence_slots: 6, bench_slots: 4,
    maximum_bench_aav_cents: 400, injured_reserve_slots: 4,
    prospect_slots_unlimited: 1, scoring_rule_version: 1,
    standings_rule_version: 1, created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS, version: 1,
  });
  for (const [id, key] of [[IDS.season1, "20262027"], [IDS.season2, "20272028"]]) {
    context.repositories.seasons.insert({
      id, league_id: IDS.league, label: key, nhl_season_key: key,
      status: "planned", regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null, fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null, created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS, version: 1,
    });
  }
  for (const [id, name] of [[IDS.team1, "Team One"], [IDS.team2, "Team Two"]]) {
    context.repositories.teams.insert({
      id, league_id: IDS.league, name, name_normalized: name.toLowerCase(),
      status: "active", primary_colour: null, secondary_colour: null,
      logo_reference: null, created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS, version: 1,
    });
  }
  for (const [id, name] of [
    [IDS.activePlayer, "Active"], [IDS.benchPlayer, "Bench"],
    [IDS.irPlayer, "IR"], [IDS.prospectPlayer, "Prospect"],
    [IDS.boughtOutPlayer, "BoughtOut"], [IDS.missingPlayer, "Missing"],
  ]) insertPlayer(context, id, name);
  for (const data of [
    { id: IDS.activeContract, playerId: IDS.activePlayer, teamId: IDS.team1, aavCents: 1_000 },
    { id: IDS.benchContract, playerId: IDS.benchPlayer, teamId: IDS.team1, aavCents: 400 },
    { id: IDS.irContract, playerId: IDS.irPlayer, teamId: IDS.team1, aavCents: 500 },
    { id: IDS.prospectContract, playerId: IDS.prospectPlayer, teamId: IDS.team1, aavCents: 100 },
    { id: IDS.eliminatedContract, playerId: IDS.boughtOutPlayer, teamId: IDS.team2, aavCents: 300, status: "eliminated" },
  ]) insertContract(context, data);
  insertOwnership(context, { id: uuid(70), playerId: IDS.activePlayer, category: "Active", slotNumber: 1 });
  insertOwnership(context, { id: uuid(71), playerId: IDS.benchPlayer, category: "Bench", slotNumber: 1 });
  insertOwnership(context, { id: uuid(72), playerId: IDS.irPlayer, category: "Injured Reserve", slotNumber: 1 });
  insertOwnership(context, { id: uuid(73), playerId: IDS.prospectPlayer, category: "Prospect", slotNumber: null });

  context.repositories.retention_obligations.insert({
    id: IDS.retentionOnActive, league_id: IDS.league,
    contract_id: IDS.activeContract, player_id: IDS.activePlayer,
    originating_team_id: IDS.team2, responsible_team_id: IDS.team2,
    retained_aav_cents: 300, creation_trade_id: null, status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.retention_years.insert({
    id: uuid(160), league_id: IDS.league,
    retention_obligation_id: IDS.retentionOnActive, season_id: IDS.season1,
    retained_aav_cents: 300, status: "current", created_at_ms: NOW_MS,
  });
  context.repositories.retention_obligations.insert({
    id: IDS.retentionForTeam, league_id: IDS.league,
    contract_id: IDS.benchContract, player_id: IDS.benchPlayer,
    originating_team_id: IDS.team1, responsible_team_id: IDS.team1,
    retained_aav_cents: 200, creation_trade_id: null, status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.retention_years.insert({
    id: uuid(161), league_id: IDS.league,
    retention_obligation_id: IDS.retentionForTeam, season_id: IDS.season1,
    retained_aav_cents: 200, status: "current", created_at_ms: NOW_MS,
  });
  context.repositories.retention_years.insert({
    id: uuid(162), league_id: IDS.league,
    retention_obligation_id: IDS.retentionForTeam, season_id: IDS.season2,
    retained_aav_cents: 200, status: "future", created_at_ms: NOW_MS,
  });

  context.repositories.buyout_obligations.insert({
    id: IDS.buyout, league_id: IDS.league,
    contract_id: IDS.eliminatedContract, player_id: IDS.boughtOutPlayer,
    originating_team_id: IDS.team1, responsible_team_id: IDS.team1,
    annual_penalty_basis_cents: 75, buyout_transaction_id: IDS.buyout,
    status: "active", created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.buyout_years.insert({
    id: uuid(170), league_id: IDS.league,
    buyout_obligation_id: IDS.buyout, season_id: IDS.season1,
    penalty_cents: 75, status: "current", created_at_ms: NOW_MS,
  });
  context.repositories.buyout_years.insert({
    id: uuid(171), league_id: IDS.league,
    buyout_obligation_id: IDS.buyout, season_id: IDS.season2,
    penalty_cents: 75, status: "future", created_at_ms: NOW_MS,
  });
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-09-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"), environment: "test",
  });
  migrateDatabase({ database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-09-test", now: () => NOW_MS });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  seed(context);
  return { context, database: connection.database,
    repository: createSqliteCapReadRepository({ database: connection.database }) };
}

function policyInput(overrides = {}) {
  return {
    leagueId: IDS.league, seasonId: IDS.season1, teamId: IDS.team1,
    salaryCapCents: 1_000,
    activePlayers: [{ playerId: IDS.activePlayer, ownershipId: uuid(70),
      contractId: IDS.activeContract, aavCents: 1_000, retainedAavCents: 300 }],
    retentionObligations: [{ retentionId: IDS.retentionForTeam,
      contractId: IDS.benchContract, playerId: IDS.benchPlayer, amountCents: 200 }],
    buyoutObligations: [{ buyoutId: IDS.buyout,
      contractId: IDS.eliminatedContract, playerId: IDS.boughtOutPlayer, amountCents: 75 }],
    issues: [], ...overrides,
  };
}

describe("M4-09 authoritative cap policy", () => {
  test("returns immutable source totals, space, and over-cap state", () => {
    const result = calculateTeamCap(policyInput());
    assert.deepEqual(result.breakdown, {
      activePlayerCents: 700, retentionCents: 200, buyoutCents: 75,
    });
    assert.equal(result.capUsageCents, 975);
    assert.equal(result.capSpaceCents, 25);
    assert.equal(result.overCap, false);
    assert.equal(calculateTeamCap(policyInput({ salaryCapCents: 900 })).overCap, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.activePlayers), true);
  });

  test("rejects retention above full AAV instead of producing negative player salary", () => {
    assert.throws(
      () => calculateTeamCap(policyInput({ activePlayers: [{
        playerId: IDS.activePlayer, ownershipId: uuid(70),
        contractId: IDS.activeContract, aavCents: 100, retainedAavCents: 101,
      }] })),
      (error) => error instanceof CapPolicyError &&
        error.reasonCode === CAP_POLICY_CODES.retentionInvalid
    );
  });
});

describe("M4-09 SQLite cap reader", () => {
  test("counts only active net AAV and current assigned obligations", (t) => {
    const { repository } = createRuntime(t);
    const result = repository.calculate({
      leagueId: IDS.league, seasonId: IDS.season1, teamId: IDS.team1,
    });
    assert.equal(result.complete, true);
    assert.equal(result.activePlayers.length, 1);
    assert.equal(result.activePlayers[0].netAavCents, 700);
    assert.deepEqual(result.breakdown, {
      activePlayerCents: 700, retentionCents: 200, buyoutCents: 75,
    });
    assert.equal(result.capUsageCents, 975);
    assert.equal(result.capLimitCents, 10_000);
  });

  test("returns explicit missing and team-mismatched active-contract issues", (t) => {
    const { context, repository } = createRuntime(t);
    insertOwnership(context, { id: uuid(74), playerId: IDS.missingPlayer,
      category: "Active", slotNumber: 2 });
    context.repositories.contracts.updateVersioned({
      key: IDS.activeContract, leagueId: IDS.league, expectedVersion: 1,
      changes: { current_team_id: IDS.team2, updated_at_ms: NOW_MS + 1 },
    });
    const result = repository.calculate({
      leagueId: IDS.league, seasonId: IDS.season1, teamId: IDS.team1,
    });
    assert.equal(result.complete, false);
    assert.deepEqual(result.issues.map((issue) => issue.code), [
      "ACTIVE_CONTRACT_TEAM_MISMATCH", "ACTIVE_CONTRACT_MISSING",
    ]);
    assert.equal(result.breakdown.activePlayerCents, 0);
  });

  test("keeps team scope exact and performs no writes", (t) => {
    const { database, repository } = createRuntime(t);
    const before = database.prepare("SELECT total_changes() AS value").get().value;
    const other = repository.calculate({
      leagueId: IDS.league, seasonId: IDS.season1, teamId: IDS.team2,
    });
    assert.equal(other.capUsageCents, 300);
    assert.equal(other.breakdown.retentionCents, 300);
    assert.equal(other.activePlayers.length, 0);
    assert.equal(Object.isFrozen(other.retentionObligations), true);
    assert.equal(database.prepare("SELECT total_changes() AS value").get().value, before);
  });
});
