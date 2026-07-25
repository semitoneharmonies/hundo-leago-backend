const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  RETENTION_POLICY_CODES,
  RetentionPolicyError,
  calculateRetentionCeilingCents,
  createRetentionAggregate,
} = require("../../src/domain/contracts/retentionPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteRetentionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRetentionRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-07-21T00:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  user: uuid(1), league: uuid(10), otherLeague: uuid(11),
  season1: uuid(20), season2: uuid(21), season3: uuid(22),
  team1: uuid(30), team2: uuid(31), otherTeam: uuid(32), player: uuid(40),
  contract: uuid(50), contractYear1: uuid(51), contractYear2: uuid(52),
  contractYear3: uuid(53), retention1: uuid(60), retention2: uuid(61),
  retentionYear1: uuid(70), retentionYear2: uuid(71), retentionYear3: uuid(72),
  retentionYear4: uuid(73), retentionYear5: uuid(74), retentionYear6: uuid(75),
  trade1: uuid(80), trade2: uuid(81), activity1: uuid(90), activity2: uuid(91),
});

function seed(context) {
  context.repositories.users.insert({
    id: IDS.user, email_normalized: "manager@example.test",
    email_display: "manager@example.test", display_name: "Manager",
    display_name_normalized: "manager", status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
  for (const [id, name] of [[IDS.league, "League"], [IDS.otherLeague, "Other League"]]) {
    context.repositories.leagues.insert({
      id, name, name_normalized: name.toLowerCase(), status: "setup",
      timezone: "America/Vancouver", commissioner_membership_id: null,
      current_season_id: null, created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS, version: 1,
    });
  }
  for (const [id, key] of [[IDS.season1, "20262027"], [IDS.season2, "20272028"], [IDS.season3, "20282029"]]) {
    context.repositories.seasons.insert({
      id, league_id: IDS.league, label: key, nhl_season_key: key,
      status: "planned", regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null, fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null, created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS, version: 1,
    });
  }
  for (const [id, leagueId, name] of [
    [IDS.team1, IDS.league, "Team One"],
    [IDS.team2, IDS.league, "Team Two"],
    [IDS.otherTeam, IDS.otherLeague, "Other Team"],
  ]) {
    context.repositories.teams.insert({
      id, league_id: leagueId, name, name_normalized: name.toLowerCase(),
      status: "active", primary_colour: null, secondary_colour: null,
      logo_reference: null, created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS, version: 1,
    });
  }
  context.repositories.players.insert({
    id: IDS.player, first_name: "Player", last_name: "One",
    full_name: "Player One", birth_date: null, status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
  for (const [id, proposingTeamId, receivingTeamId] of [
    [IDS.trade1, IDS.team1, IDS.team2],
    [IDS.trade2, IDS.team2, IDS.team1],
  ]) {
    context.repositories.trades.insert({
      id,
      league_id: IDS.league,
      season_id: IDS.season1,
      proposing_team_id: proposingTeamId,
      receiving_team_id: receivingTeamId,
      proposing_user_id: IDS.user,
      status: "completed",
      created_at_ms: NOW_MS,
      expires_at_ms: NOW_MS + 100,
      responded_at_ms: NOW_MS + 1,
      completed_at_ms: NOW_MS + 1,
      commissioner_completion_reference: null,
      updated_at_ms: NOW_MS + 1,
      version: 1,
    });
  }
  context.repositories.contracts.insert({
    id: IDS.contract, league_id: IDS.league, player_id: IDS.player,
    current_team_id: IDS.team1, contract_type: "normal",
    original_total_value_cents: 1_000, original_term_years: 3,
    aav_cents: 333, start_season_id: IDS.season1, status: "active",
    acquisition_source_type: "auction", acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null, created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS, version: 1,
  });
  for (const [id, seasonId, number, status] of [
    [IDS.contractYear1, IDS.season1, 1, "current"],
    [IDS.contractYear2, IDS.season2, 2, "future"],
    [IDS.contractYear3, IDS.season3, 3, "future"],
  ]) {
    context.repositories.contract_years.insert({
      id, league_id: IDS.league, contract_id: IDS.contract,
      season_id: seasonId, year_number: number, aav_cents: 333,
      status, rollover_at_ms: null, created_at_ms: NOW_MS,
    });
  }
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-07-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"), environment: "test",
  });
  migrateDatabase({
    database: connection.database, migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-07-test", now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  seed(context);
  return {
    context, database: connection.database,
    repository: createSqliteRetentionRepository({ database: connection.database }),
  };
}

function command(overrides = {}) {
  return {
    retentionId: IDS.retention1,
    retentionYearIds: [IDS.retentionYear1, IDS.retentionYear2, IDS.retentionYear3],
    leagueId: IDS.league, contractId: IDS.contract, playerId: IDS.player,
    originatingTeamId: IDS.team1, responsibleTeamId: IDS.team1,
    retainedAavCents: 100, creationTradeId: IDS.trade1,
    activityId: IDS.activity1, actorUserId: IDS.user,
    actorAuthority: "manager", occurredAtMs: NOW_MS + 1, ...overrides,
  };
}

function material(overrides = {}) {
  return {
    command: command(), contractAavCents: 333, contractPlayerId: IDS.player,
    contractCurrentTeamId: IDS.team1, contractStatus: "active",
    remainingContractYears: [
      { seasonId: IDS.season1, status: "current" },
      { seasonId: IDS.season2, status: "future" },
      { seasonId: IDS.season3, status: "future" },
    ],
    existingRetainedAavCents: 0,
    responsibleTeamActiveRetentionCount: 0,
    responsibleTeamAlreadyRetainsContract: false,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) =>
    error instanceof RetentionPolicyError && error.reasonCode === reasonCode
  );
}

function count(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function seedConflictingActivity(context) {
  context.repositories.league_activity.insert({
    id: IDS.activity1, league_id: IDS.league, season_id: IDS.season1,
    event_type: "seed", actor_user_id: IDS.user, actor_authority: "manager",
    team_id: IDS.team1, player_id: IDS.player, related_type: "seed",
    related_id: IDS.contract, display_summary: "Seed.", reason: null,
    metadata_json: null, occurred_at_ms: NOW_MS,
  });
}

describe("M4-07 retained-salary policy", () => {
  test("rounds an odd-cent 50 percent ceiling down", () => {
    assert.equal(calculateRetentionCeilingCents(333), 166);
    const aggregate = createRetentionAggregate(material());
    assert.equal(aggregate.retentionCeilingCents, 166);
    assert.equal(aggregate.cumulativeRetainedAavCents, 100);
    assert.deepEqual(aggregate.years.map((year) => year.status), ["current", "future", "future"]);
    assert.equal(Object.isFrozen(aggregate.years), true);
  });

  test("enforces cumulative ceiling, three slots, and one team-contract obligation", () => {
    assertPolicyError(
      () => createRetentionAggregate(material({ existingRetainedAavCents: 100, command: command({ retainedAavCents: 67 }) })),
      RETENTION_POLICY_CODES.ceilingExceeded
    );
    assertPolicyError(
      () => createRetentionAggregate(material({ responsibleTeamActiveRetentionCount: 3 })),
      RETENTION_POLICY_CODES.slotLimitExceeded
    );
    assertPolicyError(
      () => createRetentionAggregate(material({ responsibleTeamAlreadyRetainsContract: true })),
      RETENTION_POLICY_CODES.duplicateTeamContract
    );
  });
});

describe("M4-07 SQLite retained-salary persistence", () => {
  test("creates one obligation, every remaining-year charge, and activity atomically", (t) => {
    const { database, repository } = createRuntime(t);
    const result = repository.create(command());
    assert.equal(result.obligation.retained_aav_cents, 100);
    assert.equal(result.years.length, 3);
    assert.equal(result.activity.event_type, "retained_salary_created");
    assert.equal(result.retentionCeilingCents, 166);
    assert.equal(count(database, "retention_obligations"), 1);
    assert.equal(count(database, "retention_years"), 3);
    assert.equal(count(database, "league_activity"), 1);
  });

  test("derives cumulative retention across successive responsible teams", (t) => {
    const { context, database, repository } = createRuntime(t);
    repository.create(command());
    context.repositories.contracts.updateVersioned({
      key: IDS.contract, leagueId: IDS.league, expectedVersion: 1,
      changes: { current_team_id: IDS.team2, updated_at_ms: NOW_MS + 2 },
    });
    const second = command({
      retentionId: IDS.retention2,
      retentionYearIds: [IDS.retentionYear4, IDS.retentionYear5, IDS.retentionYear6],
      originatingTeamId: IDS.team2, responsibleTeamId: IDS.team2,
      retainedAavCents: 66, creationTradeId: IDS.trade2,
      activityId: IDS.activity2, occurredAtMs: NOW_MS + 3,
    });
    assertPolicyError(
      () => repository.create({ ...second, retainedAavCents: 67 }),
      RETENTION_POLICY_CODES.ceilingExceeded
    );
    const created = repository.create(second);
    assert.equal(created.cumulativeRetainedAavCents, 166);
    assert.equal(count(database, "retention_obligations"), 2);
    assert.equal(count(database, "retention_years"), 6);
  });

  test("rejects duplicate and cross-league team context without partial rows", (t) => {
    const { database, repository } = createRuntime(t);
    repository.create(command());
    assertPolicyError(
      () => repository.create(command({ retentionId: IDS.retention2,
        retentionYearIds: [IDS.retentionYear4, IDS.retentionYear5, IDS.retentionYear6],
        retainedAavCents: 1, activityId: IDS.activity2 })),
      RETENTION_POLICY_CODES.duplicateTeamContract
    );
    assertPolicyError(
      () => repository.create(command({ responsibleTeamId: IDS.otherTeam })),
      RETENTION_POLICY_CODES.teamInvalid
    );
    assert.equal(count(database, "retention_obligations"), 1);
    assert.equal(count(database, "retention_years"), 3);
  });

  test("rolls back obligation and years when final activity insertion fails", (t) => {
    const { context, database, repository } = createRuntime(t);
    seedConflictingActivity(context);
    assert.throws(
      () => repository.create(command()),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    assert.equal(count(database, "retention_obligations"), 0);
    assert.equal(count(database, "retention_years"), 0);
    assert.equal(count(database, "league_activity"), 1);
  });

  test("returns immutable league-scoped team obligations and year schedules without writes", (t) => {
    const { database, repository } = createRuntime(t);
    repository.create(command());
    const before = database.prepare("SELECT total_changes() AS value").get().value;
    const obligations = repository.listActiveByResponsibleTeam({ leagueId: IDS.league, responsibleTeamId: IDS.team1 });
    const hidden = repository.listActiveByResponsibleTeam({ leagueId: IDS.otherLeague, responsibleTeamId: IDS.otherTeam });
    const years = repository.listYears({ leagueId: IDS.league, retentionId: IDS.retention1 });
    assert.equal(obligations.length, 1);
    assert.deepEqual(hidden, []);
    assert.equal(years.length, 3);
    assert.equal(Object.isFrozen(obligations), true);
    assert.equal(Object.isFrozen(obligations[0]), true);
    assert.equal(Object.isFrozen(years), true);
    assert.equal(database.prepare("SELECT total_changes() AS value").get().value, before);
  });
});
