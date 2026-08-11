const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  CONTRACT_POLICY_CODES,
  ContractPolicyError,
  calculateRoundedAavCents,
  createNormalContractAggregate,
  normalContractValue,
} = require("../../src/domain/contracts/contractPolicy");
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
  createSqliteContractRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteContractRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T00:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  user: uuid(1),
  league: uuid(10),
  otherLeague: uuid(11),
  season1: uuid(20),
  season2: uuid(21),
  season3: uuid(22),
  otherSeason: uuid(23),
  team: uuid(30),
  otherTeam: uuid(31),
  player1: uuid(40),
  player2: uuid(41),
  contract1: uuid(50),
  contract2: uuid(51),
  year1: uuid(60),
  year2: uuid(61),
  year3: uuid(62),
  year4: uuid(63),
  year5: uuid(64),
  year6: uuid(65),
  event1: uuid(70),
  event2: uuid(71),
  source1: uuid(80),
  source2: uuid(81),
});

function seed(context) {
  context.repositories.users.insert({
    id: IDS.user,
    email_normalized: "commissioner@example.test",
    email_display: "commissioner@example.test",
    display_name: "Commissioner",
    display_name_normalized: "commissioner",
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  for (const [id, name] of [
    [IDS.league, "League"],
    [IDS.otherLeague, "Other League"],
  ]) {
    context.repositories.leagues.insert({
      id,
      name,
      name_normalized: name.toLowerCase(),
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (const [id, leagueId, label, key] of [
    [IDS.season1, IDS.league, "Season 1", "20262027"],
    [IDS.season2, IDS.league, "Season 2", "20272028"],
    [IDS.season3, IDS.league, "Season 3", "20282029"],
    [IDS.otherSeason, IDS.otherLeague, "Other", "20262027"],
  ]) {
    context.repositories.seasons.insert({
      id,
      league_id: leagueId,
      label,
      nhl_season_key: key,
      status: "planned",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (const [id, leagueId, name] of [
    [IDS.team, IDS.league, "Team"],
    [IDS.otherTeam, IDS.otherLeague, "Other Team"],
  ]) {
    context.repositories.teams.insert({
      id,
      league_id: leagueId,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (const [id, lastName] of [
    [IDS.player1, "One"],
    [IDS.player2, "Two"],
  ]) {
    context.repositories.players.insert({
      id,
      first_name: "Player",
      last_name: lastName,
      full_name: `Player ${lastName}`,
      birth_date: null,
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
}

function createRuntime(
  t,
  { candidateCardSummerSynchronizer } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-05-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-05-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  seed(context);
  return {
    database: connection.database,
    repository: createSqliteContractRepository({
      database: connection.database,
      candidateCardSummerSynchronizer:
        candidateCardSummerSynchronizer ?? {
          synchronize() {},
        },
    }),
  };
}

function normalInput(overrides = {}) {
  return {
    contractId: IDS.contract1,
    contractYearIds: [IDS.year1, IDS.year2, IDS.year3],
    contractEventId: IDS.event1,
    leagueId: IDS.league,
    playerId: IDS.player1,
    teamId: IDS.team,
    originalTotalValueCents: 1_000,
    termYears: 3,
    startSeasonId: IDS.season1,
    seasonIds: [IDS.season1, IDS.season2, IDS.season3],
    acquisitionSourceType: "auction",
    acquisitionSourceId: IDS.source1,
    auctionBuyoutLockExpiresAtMs: null,
    actorUserId: IDS.user,
    occurredAtMs: NOW_MS,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return (
      error instanceof ContractPolicyError &&
      error.reasonCode === reasonCode
    );
  });
}

function count(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

describe("M4-05 rounded-AAV normal contract policy", () => {
  test("calculates nearest-cent AAV without altering the exact total", () => {
    assert.equal(calculateRoundedAavCents(425, 1), 425);
    assert.equal(calculateRoundedAavCents(900, 2), 450);
    assert.equal(calculateRoundedAavCents(1_000, 3), 333);
    assert.equal(calculateRoundedAavCents(1_001, 3), 334);
    assert.deepEqual(normalContractValue(1_000, 3), {
      originalTotalValueCents: 1_000,
      termYears: 3,
      aavCents: 333,
    });
  });

  test("enforces term, minimum AAV, and multi-year whole-dollar rules", () => {
    assertPolicyError(
      () => normalContractValue(400, 4),
      CONTRACT_POLICY_CODES.termInvalid
    );
    assertPolicyError(
      () => normalContractValue(99, 1),
      CONTRACT_POLICY_CODES.totalValueInvalid
    );
    assertPolicyError(
      () => normalContractValue(199, 2),
      CONTRACT_POLICY_CODES.totalValueInvalid
    );
    assertPolicyError(
      () => normalContractValue(425, 2),
      CONTRACT_POLICY_CODES.precisionInvalid
    );
    assert.deepEqual(normalContractValue(100, 1), {
      originalTotalValueCents: 100,
      termYears: 1,
      aavCents: 100,
    });
  });

  test("projects an immutable current and future year schedule", () => {
    const aggregate = createNormalContractAggregate(normalInput());
    assert.equal(aggregate.contract.original_total_value_cents, 1_000);
    assert.equal(aggregate.contract.aav_cents, 333);
    assert.deepEqual(
      aggregate.years.map((year) => [
        year.year_number,
        year.status,
        year.aav_cents,
      ]),
      [
        [1, "current", 333],
        [2, "future", 333],
        [3, "future", 333],
      ]
    );
    assert.equal(aggregate.event.event_type, "contract_created");
    assert.equal(
      JSON.parse(aggregate.event.metadata_json).originalTotalValueCents,
      1_000
    );
    assert.equal(Object.isFrozen(aggregate), true);
    assert.equal(Object.isFrozen(aggregate.contract), true);
    assert.equal(Object.isFrozen(aggregate.years), true);
    assert.equal(Object.isFrozen(aggregate.years[0]), true);
    assert.equal(Object.isFrozen(aggregate.event), true);
  });
});

describe("M4-05 SQLite normal contract persistence", () => {
  test("creates the contract, all years, and creation event atomically", (t) => {
    const synchronizationCalls = [];
    let runtime;
    runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize(command) {
          assert.equal(runtime.database.inTransaction, true);
          synchronizationCalls.push(command);
        },
      },
    });
    const { database, repository } = runtime;
    const created = repository.createNormal(normalInput());
    assert.equal(created.contract.aav_cents, 333);
    assert.equal(created.contract.original_total_value_cents, 1_000);
    assert.deepEqual(
      created.years.map((year) => year.status),
      ["current", "future", "future"]
    );
    assert.equal(created.event.event_type, "contract_created");
    assert.equal(count(database, "contracts"), 1);
    assert.equal(count(database, "contract_years"), 3);
    assert.equal(count(database, "contract_events"), 1);
    assert.deepEqual(synchronizationCalls, [
      {
        leagueId: IDS.league,
        affectedTeamIds: [IDS.team],
        affectedPlayerIds: [IDS.player1],
        sourceOperationId: IDS.event1,
        sourceKind: "contract_change",
        nowMs: NOW_MS,
      },
    ]);
  });

  test("rolls back contract creation when Candidate Card synchronization fails", (t) => {
    const { database, repository } = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize() {
          throw new Error("forced Candidate Card synchronization failure");
        },
      },
    });
    const before = database.serialize();

    assert.throws(
      () => repository.createNormal(normalInput()),
      (error) =>
        error.code === REPOSITORY_ERROR_CODES.operationFailed &&
        error.details?.operation === "createNormalContract"
    );
    assert.deepEqual(database.serialize(), before);
  });

  test("enforces one active contract per league player", (t) => {
    const { database, repository } = createRuntime(t);
    repository.createNormal(normalInput());
    assert.throws(
      () =>
        repository.createNormal(
          normalInput({
            contractId: IDS.contract2,
            contractYearIds: [IDS.year4],
            contractEventId: IDS.event2,
            originalTotalValueCents: 125,
            termYears: 1,
            seasonIds: [IDS.season1],
          })
        ),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    assert.equal(count(database, "contracts"), 1);
    assert.equal(count(database, "contract_years"), 3);
    assert.equal(count(database, "contract_events"), 1);
  });

  test("rolls back cross-league and late aggregate constraint failures", (t) => {
    const { database, repository } = createRuntime(t);
    assert.throws(
      () =>
        repository.createNormal(
          normalInput({
            playerId: IDS.player2,
            teamId: IDS.otherTeam,
          })
        ),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    assert.equal(count(database, "contracts"), 0);

    const existing = repository.createNormal(normalInput());
    for (const overrides of [
      {
        contractYearIds: [IDS.year1, IDS.year4, IDS.year5],
        contractEventId: IDS.event2,
      },
      {
        contractYearIds: [IDS.year4, IDS.year5, IDS.year6],
        contractEventId: IDS.event1,
      },
    ]) {
      assert.throws(
        () =>
          repository.createNormal(
            normalInput({
              contractId: IDS.contract2,
              playerId: IDS.player2,
              acquisitionSourceId: IDS.source2,
              ...overrides,
            })
          ),
        (error) => error.code === REPOSITORY_ERROR_CODES.constraint
      );
      assert.equal(count(database, "contracts"), 1);
      assert.equal(count(database, "contract_years"), 3);
      assert.equal(count(database, "contract_events"), 1);
    }
    assert.equal(existing.contract.id, IDS.contract1);
  });

  test("keeps active-contract and year reads scoped, ordered, immutable, and read-only", (t) => {
    const { database, repository } = createRuntime(t);
    repository.createNormal(normalInput());
    const changesBefore = database
      .prepare("SELECT total_changes() AS value")
      .get().value;
    const active = repository.findActiveByPlayer({
      leagueId: IDS.league,
      playerId: IDS.player1,
    });
    const hidden = repository.findActiveByPlayer({
      leagueId: IDS.otherLeague,
      playerId: IDS.player1,
    });
    const years = repository.listYears({
      leagueId: IDS.league,
      contractId: IDS.contract1,
    });
    const hiddenYears = repository.listYears({
      leagueId: IDS.otherLeague,
      contractId: IDS.contract1,
    });
    assert.equal(active.id, IDS.contract1);
    assert.equal(hidden, null);
    assert.deepEqual(
      years.map((year) => year.year_number),
      [1, 2, 3]
    );
    assert.deepEqual(hiddenYears, []);
    assert.equal(Object.isFrozen(active), true);
    assert.equal(Object.isFrozen(years), true);
    assert.equal(Object.isFrozen(years[0]), true);
    assert.equal(
      database.prepare("SELECT total_changes() AS value").get().value,
      changesBefore
    );
  });
});
