const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  calculateAge,
  createPublicRosterProjection,
} = require("../../src/domain/rosters/publicRosterPolicy");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { REPOSITORY_ERROR_CODES } = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const { createSqlitePublicRosterRepository } = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePublicRosterRepository"
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
  league: uuid(10), season: uuid(20), team: uuid(30),
  activePlayer: uuid(40), prospectPlayer: uuid(41), activeOwnership: uuid(50),
  prospectOwnership: uuid(51), contract: uuid(60), contractYear: uuid(61),
  statSource: uuid(70), statRefresh: uuid(71), statTotal: uuid(72),
});

function seed(context, database) {
  context.repositories.leagues.insert({
    id: IDS.league, name: "Public League", name_normalized: "public league",
    status: "setup", timezone: "America/Vancouver",
    commissioner_membership_id: null, current_season_id: null,
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
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
  context.repositories.seasons.insert({
    id: IDS.season, league_id: IDS.league, label: "Season 2",
    nhl_season_key: "20262027", status: "active",
    regular_season_starts_at_ms: null, regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null, fantasy_playoffs_end_at_ms: null,
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS + 1, version: 1,
  });
  database.prepare(`
    UPDATE leagues
    SET status = 'active', current_season_id = ?,
      updated_at_ms = ?, version = version + 1
    WHERE id = ? AND version = 1
  `).run(IDS.season, NOW_MS + 1, IDS.league);
  context.repositories.teams.insert({
    id: IDS.team, league_id: IDS.league, name: "Public Team",
    name_normalized: "public team", status: "active",
    primary_colour: "#112233", secondary_colour: "#aabbcc",
    logo_reference: "legacy/private/path.png", created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS + 2, version: 1,
  });
  for (const [id, name, birthDate] of [
    [IDS.activePlayer, "Active Player", "2000-07-22"],
    [IDS.prospectPlayer, "Prospect Player", null],
  ]) {
    const [firstName, lastName] = name.split(" ");
    context.repositories.players.insert({
      id, first_name: firstName, last_name: lastName, full_name: name,
      birth_date: birthDate, status: "active", created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS, version: 1,
    });
  }
  context.repositories.contracts.insert({
    id: IDS.contract, league_id: IDS.league, player_id: IDS.activePlayer,
    current_team_id: IDS.team, contract_type: "normal",
    original_total_value_cents: 1_000, original_term_years: 1,
    aav_cents: 1_000, start_season_id: IDS.season, status: "active",
    acquisition_source_type: "auction", acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null, created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS + 3, version: 1,
  });
  context.repositories.contract_years.insert({
    id: IDS.contractYear, league_id: IDS.league, contract_id: IDS.contract,
    season_id: IDS.season, year_number: 1, aav_cents: 1_000,
    status: "current", rollover_at_ms: null, created_at_ms: NOW_MS,
  });
  context.repositories.player_ownerships.insert({
    id: IDS.activeOwnership, league_id: IDS.league, season_id: IDS.season,
    player_id: IDS.activePlayer, team_id: IDS.team,
    ownership_kind: "Rostered", roster_category: "Active",
    position_group: "F", slot_number: 1,
    acquired_transaction_type: "auction", acquired_transaction_id: null,
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS + 4, version: 1,
  });
  context.repositories.player_ownerships.insert({
    id: IDS.prospectOwnership, league_id: IDS.league, season_id: IDS.season,
    player_id: IDS.prospectPlayer, team_id: IDS.team,
    ownership_kind: "Prospect Right", roster_category: "Prospect",
    position_group: "D", slot_number: null,
    acquired_transaction_type: "entry_draft", acquired_transaction_id: null,
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS + 5, version: 1,
  });
  context.repositories.stat_sources.insert({
    id: IDS.statSource, provider: "test-provider", status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.stat_refreshes.insert({
    id: IDS.statRefresh, stat_source_id: IDS.statSource,
    nhl_season_key: "20262027", source_version: "one",
    status: "succeeded", started_at_ms: NOW_MS,
    completed_at_ms: NOW_MS + 6, player_count: 1,
    error_code: null, metadata_json: null, version: 1,
  });
  context.repositories.player_stat_totals.insert({
    id: IDS.statTotal, stat_source_id: IDS.statSource,
    refresh_id: IDS.statRefresh, nhl_season_key: "20262027",
    player_id: IDS.activePlayer, games_played: 10, goals: 4,
    assists: 6, nhl_points: 10, fantasy_points_hundredths: 1_250,
    source_updated_at_ms: NOW_MS + 7, created_at_ms: NOW_MS + 7,
  });
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-10-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"), environment: "test",
  });
  migrateDatabase({ database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-10-test", now: () => NOW_MS });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  seed(context, connection.database);
  return { context, database: connection.database,
    repository: createSqlitePublicRosterRepository({ database: connection.database }) };
}

function projectionInput(overrides = {}) {
  return {
    asOfDate: "2026-07-21",
    league: { id: IDS.league, name: "Public League" },
    season: { id: IDS.season, label: "Season 2" },
    team: { id: IDS.team, name: "Public Team", patternTemplate: "even-two",
      primaryColour: "#112233", secondaryColour: "#aabbcc", tertiaryColour: null,
      logoReference: null },
    players: [{
      id: IDS.activePlayer, name: "Active Player", position: "F",
      rosterCategory: "Active", aavCents: 1_000,
      remainingContractYears: 1, birthDate: "2000-07-22",
      statistics: { gamesPlayed: 10, goals: 4, assists: 6,
        nhlPoints: 10, fantasyPointsHundredths: 1_250 },
    }],
    cap: { capLimitCents: 10_000, capUsageCents: 1_000,
      capSpaceCents: 9_000, retainedSalaryTotalCents: 0,
      buyoutPenaltyTotalCents: 0 },
    updatedAt: NOW_MS + 7,
    ...overrides,
  };
}

function collectKeys(value, keys = new Set()) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("M4-10 public roster projection policy", () => {
  test("calculates age at an explicit date and freezes the approved shape", () => {
    assert.equal(calculateAge("2000-07-22", "2026-07-21"), 25);
    assert.equal(calculateAge("2000-07-22", "2026-07-22"), 26);
    const result = createPublicRosterProjection(projectionInput());
    assert.equal(result.players[0].age, 25);
    assert.equal(result.players[0].playerReference, IDS.activePlayer);
    assert.equal(result.team.patternTemplate, "even-two");
    assert.deepEqual(Object.keys(result.cap), [
      "capLimitCents", "capUsageCents", "capSpaceCents",
      "retainedSalaryTotalCents", "buyoutPenaltyTotalCents",
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.players[0]), true);
  });
});

describe("M4-10 SQLite public roster reader", () => {
  test("returns exact safe identity, contracts, age, persisted stats, and public cap", (t) => {
    const { repository } = createRuntime(t);
    const result = repository.read({
      leagueId: IDS.league, teamId: IDS.team, asOfDate: "2026-07-21",
    });
    assert.deepEqual(result.league, { id: IDS.league, name: "Public League" });
    assert.equal(result.team.logoReference, null);
    assert.equal(result.players.length, 2);
    assert.deepEqual(result.players[0], {
      playerReference: IDS.activePlayer, name: "Active Player",
      normalizedPosition: "F", rosterCategory: "Active", aavCents: 1_000,
      remainingContractYears: 1, age: 25,
      seasonStatistics: { gamesPlayed: 10, goals: 4, assists: 6,
        nhlPoints: 10, fantasyPointsHundredths: 1_250 },
    });
    assert.equal(result.players[1].aavCents, null);
    assert.equal(result.players[1].remainingContractYears, 0);
    assert.equal(result.players[1].age, null);
    assert.deepEqual(result.cap, {
      capLimitCents: 10_000, capUsageCents: 1_000,
      capSpaceCents: 9_000, retainedSalaryTotalCents: 0,
      buyoutPenaltyTotalCents: 0,
    });
    assert.equal(result.updatedAt, NOW_MS + 7);
  });

  test("contains none of the explicitly private field families", (t) => {
    const { repository } = createRuntime(t);
    const keys = collectKeys(repository.read({
      leagueId: IDS.league, teamId: IDS.team, asOfDate: "2026-07-21",
    }));
    for (const forbidden of [
      "email", "userId", "membershipId", "managerId", "provider",
      "providerId", "sourceState", "auctionBid", "trade", "activity",
      "reason", "metadata", "version", "ownershipId", "contractId",
    ]) assert.equal(keys.has(forbidden), false, forbidden);
  });

  test("is read-only and hides inactive leagues", (t) => {
    const { context, database, repository } = createRuntime(t);
    const before = database.prepare("SELECT total_changes() AS value").get().value;
    repository.read({ leagueId: IDS.league, teamId: IDS.team,
      asOfDate: "2026-07-21" });
    assert.equal(database.prepare("SELECT total_changes() AS value").get().value, before);
    database.prepare(`
      UPDATE leagues
      SET status = 'frozen', updated_at_ms = ?, version = version + 1
      WHERE id = ? AND version = 2
    `).run(NOW_MS + 8, IDS.league);
    assert.throws(
      () => repository.read({ leagueId: IDS.league, teamId: IDS.team,
        asOfDate: "2026-07-21" }),
      (error) => error.code === REPOSITORY_ERROR_CODES.recordNotFound
    );
  });

  test("fails closed instead of publishing an incomplete active-contract cap", (t) => {
    const { context, repository } = createRuntime(t);
    context.repositories.contracts.updateVersioned({
      key: IDS.contract, leagueId: IDS.league, expectedVersion: 1,
      changes: { status: "cancelled", updated_at_ms: NOW_MS + 8 },
    });
    assert.throws(
      () => repository.read({ leagueId: IDS.league, teamId: IDS.team,
        asOfDate: "2026-07-21" }),
      (error) => error.code === REPOSITORY_ERROR_CODES.schemaIncompatible
    );
  });
});
