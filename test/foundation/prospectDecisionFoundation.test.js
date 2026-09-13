const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createFantasyElcAggregate,
} = require("../../src/domain/contracts/contractPolicy");
const {
  PROSPECT_DECISION_CODES,
  ProspectDecisionPolicyError,
  validateProspectElcSigning,
  validateUnsignedProspectRelease,
} = require("../../src/domain/rosters/prospectDecisionPolicy");
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
  createSqliteProspectDecisionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteProspectDecisionRepository"
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
  tradeTeam: uuid(32),
  player: uuid(40),
  ownership: uuid(50),
  contract: uuid(60),
  normalContract: uuid(61),
  year1: uuid(70),
  year2: uuid(71),
  year3: uuid(72),
  contractEvent: uuid(80),
  ownershipEvent: uuid(81),
  activity: uuid(90),
  otherEvent: uuid(91),
  otherActivity: uuid(92),
  trade: uuid(100),
  tradeAsset: uuid(101),
  trade2: uuid(102),
  tradeAsset2: uuid(103),
});

function seed(context) {
  context.repositories.users.insert({
    id: IDS.user,
    email_normalized: "manager@example.test",
    email_display: "manager@example.test",
    display_name: "Manager",
    display_name_normalized: "manager",
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
    [IDS.tradeTeam, IDS.league, "Trade Team"],
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
  context.repositories.players.insert({
    id: IDS.player,
    first_name: "Player",
    last_name: "Prospect",
    full_name: "Player Prospect",
    birth_date: null,
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.player_ownerships.insert({
    id: IDS.ownership,
    league_id: IDS.league,
    season_id: IDS.season1,
    player_id: IDS.player,
    team_id: IDS.team,
    ownership_kind: "Prospect Right",
    roster_category: "Prospect",
    position_group: "F",
    slot_number: null,
    acquired_transaction_type: "entry_draft",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function createRuntime(
  t,
  {
    candidateCardSummerSynchronizer,
    tradePublicationWriter,
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-06-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-06-test",
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
    context,
    database: connection.database,
    repository: createSqliteProspectDecisionRepository({
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
      tradePublicationWriter,
    }),
  };
}

function seedPendingProspectTrade(
  context,
  { tradeId = IDS.trade, tradeAssetId = IDS.tradeAsset } = {}
) {
  context.repositories.trades.insert({
    id: tradeId,
    league_id: IDS.league,
    season_id: IDS.season1,
    proposing_team_id: IDS.team,
    receiving_team_id: IDS.tradeTeam,
    proposing_user_id: IDS.user,
    status: "proposed",
    created_at_ms: NOW_MS,
    expires_at_ms: NOW_MS + 60_000,
    responded_at_ms: null,
    completed_at_ms: null,
    commissioner_completion_reference: null,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.trade_assets.insert({
    id: tradeAssetId,
    league_id: IDS.league,
    trade_id: tradeId,
    direction: "proposing_to_receiving",
    source_team_id: IDS.team,
    destination_team_id: IDS.tradeTeam,
    asset_type: "prospect_right",
    player_id: IDS.player,
    sequence: 1,
    created_at_ms: NOW_MS,
  });
}

function signingInput(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season1,
    teamId: IDS.team,
    playerId: IDS.player,
    ownershipId: IDS.ownership,
    expectedOwnershipVersion: 1,
    contractId: IDS.contract,
    contractYearIds: [IDS.year1, IDS.year2, IDS.year3],
    contractEventId: IDS.contractEvent,
    seasonIds: [IDS.season1, IDS.season2, IDS.season3],
    ownershipEventId: IDS.ownershipEvent,
    activityId: IDS.activity,
    actorUserId: IDS.user,
    actorAuthority: "manager",
    destinationCategory: "Prospect",
    destinationPositionGroup: "F",
    destinationSlotNumber: null,
    occurredAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function releaseInput(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season1,
    teamId: IDS.team,
    playerId: IDS.player,
    ownershipId: IDS.ownership,
    expectedOwnershipVersion: 1,
    decision: "decline_elc",
    confirmed: true,
    ownershipEventId: IDS.ownershipEvent,
    activityId: IDS.activity,
    actorUserId: IDS.user,
    actorAuthority: "manager",
    reason: null,
    occurredAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return (
      error instanceof ProspectDecisionPolicyError &&
      error.reasonCode === reasonCode
    );
  });
}

function count(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

function databaseSemanticHash(database) {
  const tableNames = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name ASC"
    )
    .all()
    .map(({ name }) => name);
  const state = tableNames.map((tableName) => ({
    tableName,
    rows: database
      .prepare(`SELECT * FROM "${tableName}" ORDER BY rowid ASC`)
      .all(),
  }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(state), "utf8")
    .digest("hex");
}

function seedConflictingActivity(context) {
  context.repositories.league_activity.insert({
    id: IDS.activity,
    league_id: IDS.league,
    season_id: IDS.season1,
    event_type: "seed",
    actor_user_id: IDS.user,
    actor_authority: "manager",
    team_id: IDS.team,
    player_id: IDS.player,
    related_type: "seed",
    related_id: IDS.ownership,
    display_summary: "Seed activity.",
    reason: null,
    metadata_json: null,
    occurred_at_ms: NOW_MS,
  });
}

describe("M4-06 fantasy ELC and unsigned-right decision policy", () => {
  test("projects the fixed immutable fantasy ELC without a buyout lock", () => {
    const aggregate = createFantasyElcAggregate({
      contractId: IDS.contract,
      contractYearIds: [IDS.year1, IDS.year2, IDS.year3],
      contractEventId: IDS.contractEvent,
      leagueId: IDS.league,
      playerId: IDS.player,
      teamId: IDS.team,
      startSeasonId: IDS.season1,
      seasonIds: [IDS.season1, IDS.season2, IDS.season3],
      acquisitionSourceId: IDS.activity,
      actorUserId: IDS.user,
      occurredAtMs: NOW_MS,
    });
    assert.deepEqual(
      [
        aggregate.contract.contract_type,
        aggregate.contract.original_total_value_cents,
        aggregate.contract.original_term_years,
        aggregate.contract.aav_cents,
        aggregate.contract.auction_buyout_lock_expires_at_ms,
      ],
      ["fantasy_elc", 300, 3, 100, null]
    );
    assert.deepEqual(
      aggregate.years.map((year) => [year.status, year.aav_cents]),
      [
        ["current", 100],
        ["future", 100],
        ["future", 100],
      ]
    );
    assert.equal(Object.isFrozen(aggregate), true);
    assert.equal(Object.isFrozen(aggregate.years), true);
  });

  test("requires an exact three-season signing schedule", () => {
    assert.equal(Object.isFrozen(validateProspectElcSigning(signingInput())), true);
    assertPolicyError(
      () =>
        validateProspectElcSigning(
          signingInput({ seasonIds: [IDS.season2, IDS.season1, IDS.season3] })
        ),
      PROSPECT_DECISION_CODES.scheduleInvalid
    );
    assertPolicyError(
      () =>
        validateProspectElcSigning(
          signingInput({ contractYearIds: [IDS.year1, IDS.year1, IDS.year3] })
        ),
      PROSPECT_DECISION_CODES.scheduleInvalid
    );
  });

  test("requires explicit confirmation for either release decision", () => {
    for (const decision of ["decline_elc", "release_unsigned_rights"]) {
      assert.equal(
        validateUnsignedProspectRelease(
          releaseInput({ decision })
        ).decision,
        decision
      );
    }
    assertPolicyError(
      () => validateUnsignedProspectRelease(releaseInput({ confirmed: false })),
      PROSPECT_DECISION_CODES.confirmationRequired
    );
    assertPolicyError(
      () => validateUnsignedProspectRelease(releaseInput({ decision: "delete" })),
      PROSPECT_DECISION_CODES.decisionInvalid
    );
  });
});

describe("M4-06 atomic prospect decisions", () => {
  test("synchronizes each signed or released prospect inside its mutation transaction", (t) => {
    const calls = [];
    let signingRuntime;
    signingRuntime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize(command) {
          assert.equal(signingRuntime.database.inTransaction, true);
          calls.push(command);
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });
    signingRuntime.repository.signFantasyElc(signingInput());

    let releaseRuntime;
    releaseRuntime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize(command) {
          assert.equal(releaseRuntime.database.inTransaction, true);
          calls.push(command);
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });
    releaseRuntime.repository.releaseUnsignedRights(releaseInput());

    assert.deepEqual(calls, [
      {
        leagueId: IDS.league,
        affectedTeamIds: [IDS.team],
        affectedPlayerIds: [IDS.player],
        sourceOperationId: IDS.ownershipEvent,
        sourceKind: "prospect_decision",
        nowMs: NOW_MS + 1,
      },
      {
        leagueId: IDS.league,
        affectedTeamIds: [IDS.team],
        affectedPlayerIds: [IDS.player],
        sourceOperationId: IDS.ownershipEvent,
        sourceKind: "prospect_decision",
        nowMs: NOW_MS + 1,
      },
    ]);
  });

  test("signs one ELC and keeps a cap-exempt signed Prospect Right", (t) => {
    const { context, database, repository } = createRuntime(t);
    seedPendingProspectTrade(context);
    const result = repository.signFantasyElc(signingInput());
    assert.equal(result.ownership.ownership_kind, "Prospect Right");
    assert.equal(result.ownership.roster_category, "Prospect");
    assert.equal(result.ownership.version, 2);
    assert.equal(result.contract.contract_type, "fantasy_elc");
    assert.equal(result.contract.aav_cents, 100);
    assert.equal(result.years.length, 3);
    assert.equal(result.contractEvent.event_type, "fantasy_elc_created");
    assert.equal(result.ownershipEvent.event_type, "fantasy_elc_signed");
    assert.equal(result.activity.event_type, "fantasy_elc_signed");
    assert.deepEqual(result.automaticallyCancelledTradeIds, [IDS.trade]);
    assert.equal(count(database, "contracts"), 1);
    assert.equal(count(database, "contract_years"), 3);
    assert.equal(count(database, "contract_events"), 1);
    assert.equal(count(database, "ownership_events"), 1);
    assert.equal(count(database, "league_activity"), 2);
    assert.equal(count(database, "trade_events"), 1);
    assert.equal(count(database, "outbox_events"), 1);
    assert.equal(
      database.prepare("SELECT status FROM trades WHERE id = ?").get(IDS.trade)
        .status,
      "cancelled"
    );
  });

  test("atomically signs directly into one authoritative legal roster destination", (t) => {
    const { context, database, repository } = createRuntime(t);
    seedPendingProspectTrade(context);
    seedPendingProspectTrade(context, {
      tradeId: IDS.trade2,
      tradeAssetId: IDS.tradeAsset2,
    });
    const result = repository.signFantasyElc(
      signingInput({
        destinationCategory: "Active",
        destinationPositionGroup: "F",
        destinationSlotNumber: 1,
      })
    );
    assert.deepEqual(
      [
        result.ownership.ownership_kind,
        result.ownership.roster_category,
        result.ownership.position_group,
        result.ownership.slot_number,
      ],
      ["Rostered", "Active", "F", 1]
    );
    assert.equal(count(database, "contracts"), 1);
    assert.equal(count(database, "ownership_events"), 1);
    assert.equal(count(database, "league_activity"), 3);
    assert.equal(count(database, "outbox_events"), 2);
    assert.deepEqual(result.automaticallyCancelledTradeIds, [
      IDS.trade,
      IDS.trade2,
    ]);
    assert.equal(
      JSON.parse(result.activity.metadata_json).rosterCategory,
      "Active"
    );
    const trade = database
      .prepare("SELECT * FROM trades WHERE id = ?")
      .get(IDS.trade);
    assert.deepEqual(
      [trade.status, trade.responded_at_ms, trade.version],
      ["cancelled", NOW_MS + 1, 2]
    );
    assert.deepEqual(
      database
        .prepare("SELECT status, version FROM trades WHERE id = ?")
        .get(IDS.trade2),
      { status: "cancelled", version: 2 }
    );
    const tradeEvent = database
      .prepare("SELECT * FROM trade_events WHERE trade_id = ?")
      .get(IDS.trade);
    assert.equal(tradeEvent.event_type, "proposal_auto_cancelled");
    assert.equal(tradeEvent.reason, "prospect_right_converted");
    assert.deepEqual(JSON.parse(tradeEvent.metadata_json), {
      schemaVersion: 1,
      prospectDecisionId: IDS.ownershipEvent,
      playerId: IDS.player,
      fromStatus: "proposed",
      reasonCode: "prospect_right_converted",
    });
    const cancellationActivity = database
      .prepare(`
        SELECT * FROM league_activity
        WHERE event_type = 'trade_proposal_automatically_cancelled'
      `)
      .get();
    assert.equal(cancellationActivity.related_id, IDS.trade);
    assert.equal(cancellationActivity.reason, "prospect_right_converted");
    assert.equal(
      JSON.parse(
        database
          .prepare("SELECT payload_json FROM outbox_events WHERE aggregate_id = ?")
          .get(IDS.trade).payload_json
      ).type,
      "trade.changed"
    );
  });

  test("rejects stale, wrong-team, and already-signed ownership without writes", (t) => {
    const { database, repository } = createRuntime(t);
    for (const [overrides, reasonCode] of [
      [{ expectedOwnershipVersion: 2 }, PROSPECT_DECISION_CODES.versionConflict],
      [{ teamId: IDS.otherTeam }, PROSPECT_DECISION_CODES.scopeMismatch],
    ]) {
      assertPolicyError(
        () => repository.signFantasyElc(signingInput(overrides)),
        reasonCode
      );
    }
    database.prepare(
      "UPDATE player_ownerships SET ownership_kind = 'Rostered' WHERE id = ?"
    ).run(IDS.ownership);
    assertPolicyError(
      () => repository.signFantasyElc(signingInput()),
      PROSPECT_DECISION_CODES.ownershipInvalid
    );
    assert.equal(count(database, "contracts"), 0);
    assert.equal(count(database, "contract_events"), 0);
    assert.equal(count(database, "ownership_events"), 0);
    assert.equal(count(database, "league_activity"), 0);
  });

  test("rolls an ELC signing fully back when its final activity insert fails", (t) => {
    const { context, database, repository } = createRuntime(t);
    seedConflictingActivity(context);
    assert.throws(
      () => repository.signFantasyElc(signingInput()),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    const ownership = database
      .prepare("SELECT * FROM player_ownerships WHERE id = ?")
      .get(IDS.ownership);
    assert.equal(ownership.ownership_kind, "Prospect Right");
    assert.equal(ownership.version, 1);
    assert.equal(count(database, "contracts"), 0);
    assert.equal(count(database, "contract_years"), 0);
    assert.equal(count(database, "contract_events"), 0);
    assert.equal(count(database, "ownership_events"), 0);
    assert.equal(count(database, "league_activity"), 1);
  });

  test("declines the ELC by releasing only current rights and retaining history", (t) => {
    const { context, database, repository } = createRuntime(t);
    seedPendingProspectTrade(context);
    const result = repository.releaseUnsignedRights(releaseInput());
    assert.equal(result.releasedOwnership.id, IDS.ownership);
    assert.equal(result.ownershipEvent.event_type, "fantasy_elc_declined");
    assert.equal(result.ownershipEvent.ownership_id, IDS.ownership);
    assert.equal(result.activity.event_type, "fantasy_elc_declined");
    assert.deepEqual(result.automaticallyCancelledTradeIds, [IDS.trade]);
    assert.equal(count(database, "player_ownerships"), 0);
    assert.equal(count(database, "contracts"), 0);
    assert.equal(count(database, "ownership_events"), 1);
    assert.equal(count(database, "league_activity"), 2);
    assert.equal(count(database, "trade_events"), 1);
    assert.equal(count(database, "outbox_events"), 1);
    assert.deepEqual(
      database
        .prepare("SELECT status, version FROM trades WHERE id = ?")
        .get(IDS.trade),
      { status: "cancelled", version: 2 }
    );
    assert.equal(
      database
        .prepare("SELECT reason FROM trade_events WHERE trade_id = ?")
        .get(IDS.trade).reason,
      "prospect_right_released"
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  });

  test("records voluntary release distinctly and rolls late release failure back", (t) => {
    const first = createRuntime(t);
    seedPendingProspectTrade(first.context);
    const released = first.repository.releaseUnsignedRights(
      releaseInput({ decision: "release_unsigned_rights" })
    );
    assert.equal(
      released.ownershipEvent.event_type,
      "unsigned_prospect_rights_released"
    );
    assert.deepEqual(released.automaticallyCancelledTradeIds, [IDS.trade]);
    assert.equal(
      first.database
        .prepare("SELECT status FROM trades WHERE id = ?")
        .get(IDS.trade).status,
      "cancelled"
    );

    const second = createRuntime(t);
    seedConflictingActivity(second.context);
    assert.throws(
      () => second.repository.releaseUnsignedRights(releaseInput()),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    assert.equal(count(second.database, "player_ownerships"), 1);
    assert.equal(count(second.database, "ownership_events"), 0);
    assert.equal(count(second.database, "league_activity"), 1);
  });

  test("rolls every signing or release effect back when Candidate synchronization fails", (t) => {
    for (const execute of [
      (repository) => repository.signFantasyElc(signingInput()),
      (repository) => repository.releaseUnsignedRights(releaseInput()),
    ]) {
      const runtime = createRuntime(t, {
        candidateCardSummerSynchronizer: {
          synchronize() {
            throw new Error("injected Candidate synchronization failure");
          },
        },
      });
      const before = databaseSemanticHash(runtime.database);

      assert.throws(
        () => execute(runtime.repository),
        (error) =>
          error.code === REPOSITORY_ERROR_CODES.operationFailed &&
          error.cause?.message ===
            "injected Candidate synchronization failure"
      );
      assert.equal(databaseSemanticHash(runtime.database), before);
    }
  });

  test("rolls the prospect decision and pending trade back together when cancellation publication fails", (t) => {
    for (const execute of [
      (repository) =>
        repository.signFantasyElc(
          signingInput({
            destinationCategory: "Bench",
            destinationPositionGroup: "F",
            destinationSlotNumber: 1,
          })
        ),
      (repository) => repository.releaseUnsignedRights(releaseInput()),
    ]) {
      const runtime = createRuntime(t, {
        tradePublicationWriter: {
          publish() {
            throw new Error("injected trade publication failure");
          },
        },
      });
      seedPendingProspectTrade(runtime.context);
      const before = databaseSemanticHash(runtime.database);

      assert.throws(() => execute(runtime.repository));
      assert.equal(databaseSemanticHash(runtime.database), before);
      assert.equal(
        runtime.database
          .prepare("SELECT status FROM trades WHERE id = ?")
          .get(IDS.trade).status,
        "proposed"
      );
    }
  });
});
