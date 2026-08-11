const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  BUYOUT_POLICY_CODES,
  BuyoutPolicyError,
  calculateBuyoutPenaltyCents,
  createBuyoutAggregate,
  validateBuyoutCommand,
} = require("../../src/domain/contracts/buyoutPolicy");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { REPOSITORY_ERROR_CODES } = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const { createSqliteBuyoutRepository } = require(
  "../../src/infrastructure/persistence/sqlite/SqliteBuyoutRepository"
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
  user: uuid(1), league: uuid(10), season1: uuid(20), season2: uuid(21),
  season3: uuid(22), team1: uuid(30), team2: uuid(31), player: uuid(40),
  ownership: uuid(50), contract: uuid(60), contractYear1: uuid(61),
  contractYear2: uuid(62), contractYear3: uuid(63), buyout: uuid(70),
  buyoutYear1: uuid(71), buyoutYear2: uuid(72), buyoutYear3: uuid(73),
  contractEvent: uuid(80), ownershipEvent: uuid(81), activity: uuid(82),
  retention: uuid(90), retentionYear1: uuid(91), retentionYear2: uuid(92),
  retentionYear3: uuid(93), trade: uuid(100), tradeAsset: uuid(101),
});

function seed(context) {
  context.repositories.users.insert({
    id: IDS.user, email_normalized: "manager@example.test",
    email_display: "manager@example.test", display_name: "Manager",
    display_name_normalized: "manager", status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.leagues.insert({
    id: IDS.league, name: "League", name_normalized: "league", status: "setup",
    timezone: "America/Vancouver", commissioner_membership_id: null,
    current_season_id: null, created_at_ms: NOW_MS, updated_at_ms: NOW_MS,
    version: 1,
  });
  for (const [id, key] of [[IDS.season1, "20262027"], [IDS.season2, "20272028"], [IDS.season3, "20282029"]]) {
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
  context.repositories.players.insert({
    id: IDS.player, first_name: "Player", last_name: "One",
    full_name: "Player One", birth_date: null, status: "active",
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
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
  context.repositories.player_ownerships.insert({
    id: IDS.ownership, league_id: IDS.league, season_id: IDS.season1,
    player_id: IDS.player, team_id: IDS.team1, ownership_kind: "Rostered",
    roster_category: "Active", position_group: "F", slot_number: 1,
    acquired_transaction_type: "auction", acquired_transaction_id: null,
    created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
  });
}

function createRuntime(
  t,
  { candidateCardSummerSynchronizer } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-08-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"), environment: "test",
  });
  migrateDatabase({
    database: connection.database, migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-08-test", now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  seed(context);
  return {
    context, database: connection.database,
    repository: createSqliteBuyoutRepository({
      database: connection.database,
      candidateCardSummerSynchronizer:
        candidateCardSummerSynchronizer ?? {
          synchronize() {
            return Object.freeze({
              affectedCardCount: 0,
              changedCardCount: 0,
            });
          },
        },
    }),
  };
}

function command(overrides = {}) {
  return {
    buyoutId: IDS.buyout,
    buyoutYearIds: [IDS.buyoutYear1, IDS.buyoutYear2, IDS.buyoutYear3],
    contractEventId: IDS.contractEvent, ownershipEventId: IDS.ownershipEvent,
    activityId: IDS.activity, leagueId: IDS.league, seasonId: IDS.season1,
    teamId: IDS.team1, playerId: IDS.player, contractId: IDS.contract,
    ownershipId: IDS.ownership, expectedContractVersion: 1,
    expectedOwnershipVersion: 1, actorUserId: IDS.user,
    actorAuthority: "manager", confirmed: true, reason: null,
    occurredAtMs: NOW_MS + 1, ...overrides,
  };
}

function aggregateInput(overrides = {}) {
  return {
    command: command(),
    contract: {
      id: IDS.contract, league_id: IDS.league, player_id: IDS.player,
      current_team_id: IDS.team1, status: "active", version: 1,
      aav_cents: 333, auction_buyout_lock_expires_at_ms: null,
    },
    ownership: {
      id: IDS.ownership, league_id: IDS.league, season_id: IDS.season1,
      team_id: IDS.team1, player_id: IDS.player, ownership_kind: "Rostered",
      roster_category: "Active", version: 1,
    },
    remainingContractYears: [
      { contractYearId: IDS.contractYear1, seasonId: IDS.season1, status: "current" },
      { contractYearId: IDS.contractYear2, seasonId: IDS.season2, status: "future" },
      { contractYearId: IDS.contractYear3, seasonId: IDS.season3, status: "future" },
    ],
    pendingTradeCount: 0,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) =>
    error instanceof BuyoutPolicyError && error.reasonCode === reasonCode
  );
}

function count(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function seedRetention(context) {
  context.repositories.retention_obligations.insert({
    id: IDS.retention, league_id: IDS.league, contract_id: IDS.contract,
    player_id: IDS.player, originating_team_id: IDS.team2,
    responsible_team_id: IDS.team2, retained_aav_cents: 50,
    creation_trade_id: null, status: "active", created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS, version: 1,
  });
  for (const [id, seasonId, status] of [
    [IDS.retentionYear1, IDS.season1, "current"],
    [IDS.retentionYear2, IDS.season2, "future"],
    [IDS.retentionYear3, IDS.season3, "future"],
  ]) {
    context.repositories.retention_years.insert({
      id, league_id: IDS.league, retention_obligation_id: IDS.retention,
      season_id: seasonId, retained_aav_cents: 50, status,
      created_at_ms: NOW_MS,
    });
  }
}

function seedPendingTrade(context) {
  context.repositories.trades.insert({
    id: IDS.trade, league_id: IDS.league, season_id: IDS.season1,
    proposing_team_id: IDS.team1, receiving_team_id: IDS.team2,
    proposing_user_id: IDS.user, status: "proposed", created_at_ms: NOW_MS,
    expires_at_ms: NOW_MS + 100, responded_at_ms: null,
    completed_at_ms: null, commissioner_completion_reference: null,
    updated_at_ms: NOW_MS, version: 1,
  });
  context.repositories.trade_assets.insert({
    id: IDS.tradeAsset, league_id: IDS.league, trade_id: IDS.trade,
    direction: "proposing_to_receiving", source_team_id: IDS.team1,
    destination_team_id: IDS.team2, asset_type: "contract",
    contract_id: IDS.contract, player_id: null, draft_pick_id: null,
    retention_obligation_id: null, buyout_obligation_id: null,
    future_consideration_id: null, requested_retention_cents: null,
    proposal_snapshot_json: null, sequence: 1, created_at_ms: NOW_MS,
  });
}

function seedConflictingActivity(context) {
  context.repositories.league_activity.insert({
    id: IDS.activity, league_id: IDS.league, season_id: IDS.season1,
    event_type: "seed", actor_user_id: IDS.user, actor_authority: "manager",
    team_id: IDS.team1, player_id: IDS.player, related_type: "seed",
    related_id: IDS.contract, display_summary: "Seed.", reason: null,
    metadata_json: null, occurred_at_ms: NOW_MS,
  });
}

describe("M4-08 buyout policy", () => {
  test("rounds 25 percent to the nearest cent and projects every remaining year", () => {
    assert.equal(calculateBuyoutPenaltyCents(100), 25);
    assert.equal(calculateBuyoutPenaltyCents(333), 83);
    assert.equal(calculateBuyoutPenaltyCents(334), 84);
    const aggregate = createBuyoutAggregate(aggregateInput());
    assert.equal(aggregate.annualPenaltyCents, 83);
    assert.equal(aggregate.totalScheduledPenaltyCents, 249);
    assert.equal(aggregate.years.length, 3);
    assert.equal(Object.isFrozen(aggregate.years), true);
  });

  test("requires confirmation and enforces the lock until its exact expiry", () => {
    assertPolicyError(
      () => validateBuyoutCommand(command({ confirmed: false })),
      BUYOUT_POLICY_CODES.confirmationRequired
    );
    assertPolicyError(
      () => createBuyoutAggregate(aggregateInput({ contract: {
        ...aggregateInput().contract,
        auction_buyout_lock_expires_at_ms: NOW_MS + 2,
      } })),
      BUYOUT_POLICY_CODES.lockActive
    );
    assert.equal(createBuyoutAggregate(aggregateInput({
      command: command({ occurredAtMs: NOW_MS + 2 }),
      contract: { ...aggregateInput().contract,
        auction_buyout_lock_expires_at_ms: NOW_MS + 2 },
    })).annualPenaltyCents, 83);
  });

  test("accepts a signed-ELC Prospect but fails closed for pending trades", () => {
    assert.equal(createBuyoutAggregate(aggregateInput({ ownership: {
      ...aggregateInput().ownership, roster_category: "Prospect",
    } })).annualPenaltyCents, 83);
    assertPolicyError(
      () => createBuyoutAggregate(aggregateInput({ pendingTradeCount: 1 })),
      BUYOUT_POLICY_CODES.pendingTradeExists
    );
  });
});

describe("M4-08 atomic SQLite buyout", () => {
  test("synchronizes the released player and penalty team inside the buyout transaction", (t) => {
    const calls = [];
    let runtime;
    runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize(command) {
          assert.equal(runtime.database.inTransaction, true);
          calls.push(command);
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });

    runtime.repository.buyOut(command());

    assert.deepEqual(calls, [
      {
        leagueId: IDS.league,
        affectedTeamIds: [IDS.team1],
        affectedPlayerIds: [IDS.player],
        sourceOperationId: IDS.buyout,
        sourceKind: "buyout",
        nowMs: NOW_MS + 1,
      },
    ]);
  });

  test("eliminates the contract, releases ownership, preserves retention, and schedules penalties", (t) => {
    const { context, database, repository } = createRuntime(t);
    seedRetention(context);
    const retentionBefore = database.prepare("SELECT * FROM retention_obligations").all();
    const result = repository.buyOut(command());
    assert.equal(result.contract.status, "eliminated");
    assert.equal(result.contract.version, 2);
    assert.equal(result.annualPenaltyCents, 83);
    assert.equal(result.years.length, 3);
    assert.equal(count(database, "player_ownerships"), 0);
    assert.equal(count(database, "buyout_obligations"), 1);
    assert.equal(count(database, "buyout_years"), 3);
    assert.deepEqual(
      database.prepare("SELECT status FROM contract_years ORDER BY year_number").all(),
      [{ status: "eliminated" }, { status: "eliminated" }, { status: "eliminated" }]
    );
    assert.deepEqual(database.prepare("SELECT * FROM retention_obligations").all(), retentionBefore);
    assert.equal(count(database, "contract_events"), 1);
    assert.equal(count(database, "ownership_events"), 1);
    assert.equal(count(database, "league_activity"), 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  });

  test("rejects active locks and pending trades without writes", (t) => {
    const first = createRuntime(t);
    first.context.repositories.contracts.updateVersioned({
      key: IDS.contract, leagueId: IDS.league, expectedVersion: 1,
      changes: { auction_buyout_lock_expires_at_ms: NOW_MS + 2,
        updated_at_ms: NOW_MS },
    });
    assertPolicyError(
      () => first.repository.buyOut(command({ expectedContractVersion: 2 })),
      BUYOUT_POLICY_CODES.lockActive
    );
    assert.equal(count(first.database, "buyout_obligations"), 0);
    assert.equal(count(first.database, "player_ownerships"), 1);

    const second = createRuntime(t);
    seedPendingTrade(second.context);
    assertPolicyError(
      () => second.repository.buyOut(command()),
      BUYOUT_POLICY_CODES.pendingTradeExists
    );
    assert.equal(count(second.database, "buyout_obligations"), 0);
    assert.equal(count(second.database, "player_ownerships"), 1);
  });

  test("rejects stale ownership and contract versions without partial mutation", (t) => {
    const { database, repository } = createRuntime(t);
    for (const overrides of [
      { expectedContractVersion: 2 },
      { expectedOwnershipVersion: 2 },
      { teamId: IDS.team2 },
    ]) {
      assertPolicyError(
        () => repository.buyOut(command(overrides)),
        overrides.teamId ? BUYOUT_POLICY_CODES.scopeMismatch : BUYOUT_POLICY_CODES.versionConflict
      );
    }
    assert.equal(database.prepare("SELECT status FROM contracts").get().status, "active");
    assert.equal(count(database, "player_ownerships"), 1);
    assert.equal(count(database, "buyout_obligations"), 0);
  });

  test("rolls every effect back when final activity insertion fails", (t) => {
    const { context, database, repository } = createRuntime(t);
    seedConflictingActivity(context);
    assert.throws(
      () => repository.buyOut(command()),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    assert.equal(database.prepare("SELECT status FROM contracts").get().status, "active");
    assert.deepEqual(
      database.prepare("SELECT status FROM contract_years ORDER BY year_number").all(),
      [{ status: "current" }, { status: "future" }, { status: "future" }]
    );
    assert.equal(count(database, "player_ownerships"), 1);
    assert.equal(count(database, "buyout_obligations"), 0);
    assert.equal(count(database, "buyout_years"), 0);
    assert.equal(count(database, "contract_events"), 0);
    assert.equal(count(database, "ownership_events"), 0);
    assert.equal(count(database, "league_activity"), 1);
  });

  test("rolls every buyout effect back when Candidate synchronization fails", (t) => {
    const { database, repository } = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize() {
          throw new Error("injected Candidate synchronization failure");
        },
      },
    });

    assert.throws(
      () => repository.buyOut(command()),
      (error) => error.code === REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.equal(
      database.prepare("SELECT status, version FROM contracts").get()
        .status,
      "active"
    );
    assert.deepEqual(
      database
        .prepare("SELECT status FROM contract_years ORDER BY year_number")
        .all(),
      [
        { status: "current" },
        { status: "future" },
        { status: "future" },
      ]
    );
    assert.equal(count(database, "player_ownerships"), 1);
    assert.equal(count(database, "buyout_obligations"), 0);
    assert.equal(count(database, "buyout_years"), 0);
    assert.equal(count(database, "contract_events"), 0);
    assert.equal(count(database, "ownership_events"), 0);
    assert.equal(count(database, "league_activity"), 0);
  });
});
