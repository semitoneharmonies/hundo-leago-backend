const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  COMMISSIONER_CORRECTION_CODES,
  CommissionerCorrectionPolicyError,
  validateContractCorrection,
  validateRosterCorrection,
} = require(
  "../../src/domain/leagues/commissionerCorrectionPolicy"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteCommissionerCorrectionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCommissionerCorrectionRepository"
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
  commissioner: uuid(1),
  manager: uuid(2),
  league: uuid(10),
  commissionerMembership: uuid(11),
  managerMembership: uuid(12),
  platformRole: uuid(13),
  season1: uuid(20),
  season2: uuid(21),
  season3: uuid(22),
  team1: uuid(30),
  team2: uuid(31),
  player: uuid(40),
  source: uuid(41),
  freePlayer: uuid(42),
  freeSource: uuid(43),
  ownership: uuid(50),
  addedOwnership: uuid(51),
  contract: uuid(60),
  addedContract: uuid(64),
  contractYear1: uuid(61),
  contractYear2: uuid(62),
  contractYear3: uuid(63),
  addedContractYear: uuid(65),
  correction: uuid(70),
  correction2: uuid(71),
  addCorrection: uuid(75),
  removeCorrection: uuid(76),
  ownershipEvent: uuid(72),
  addedOwnershipEvent: uuid(77),
  removedOwnershipEvent: uuid(78),
  contractEvent: uuid(73),
  addedContractEvent: uuid(79),
  removedContractEvent: uuid(82),
  activity: uuid(74),
  addActivity: uuid(83),
  removeActivity: uuid(84),
  trade: uuid(80),
  tradeAsset: uuid(81),
  retention: uuid(85),
});

function createConnection(t, prefix = "hundo-m4-11-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return connection;
}

function insertUser(repositories, id, name) {
  repositories.users.insert({
    id,
    email_normalized: `${name.toLowerCase()}@example.test`,
    email_display: `${name.toLowerCase()}@example.test`,
    display_name: name,
    display_name_normalized: name.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertRow(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(
      `INSERT INTO ${tableName} (${columns.join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")})`
    )
    .run(...columns.map((column) => values[column]));
}

function seedRuntime(context) {
  const { repositories } = context;
  insertUser(repositories, IDS.commissioner, "Commissioner");
  insertUser(repositories, IDS.manager, "Manager");
  repositories.leagues.insert({
    id: IDS.league,
    name: "Correction League",
    name_normalized: "correction league",
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: IDS.league,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms: null,
    maximum_teams: 10,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  for (const [id, label, status] of [
    [IDS.season1, "2026-27", "active"],
    [IDS.season2, "2027-28", "planned"],
    [IDS.season3, "2028-29", "planned"],
  ]) {
    repositories.seasons.insert({
      id,
      league_id: IDS.league,
      label,
      nhl_season_key: label.replace("-", "20"),
      status,
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  repositories.league_memberships.insert({
    id: IDS.commissionerMembership,
    league_id: IDS.league,
    user_id: IDS.commissioner,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: IDS.managerMembership,
    league_id: IDS.league,
    user_id: IDS.manager,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      status: "active",
      commissioner_membership_id: IDS.commissionerMembership,
      current_season_id: IDS.season1,
      updated_at_ms: NOW_MS,
    },
  });
  for (const [id, name] of [
    [IDS.team1, "Team One"],
    [IDS.team2, "Team Two"],
  ]) {
    repositories.teams.insert({
      id,
      league_id: IDS.league,
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
  repositories.players.insert({
    id: IDS.player,
    first_name: "Player",
    last_name: "One",
    full_name: "Player One",
    birth_date: null,
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.player_source_state.insert({
    id: IDS.source,
    player_id: IDS.player,
    provider: "test",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "AAA",
    active: 1,
    source_version: "one",
    source_payload_json: null,
    effective_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
  });
  repositories.player_ownerships.insert({
    id: IDS.ownership,
    league_id: IDS.league,
    season_id: IDS.season1,
    player_id: IDS.player,
    team_id: IDS.team1,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "migration",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.contracts.insert({
    id: IDS.contract,
    league_id: IDS.league,
    player_id: IDS.player,
    current_team_id: IDS.team1,
    contract_type: "normal",
    original_total_value_cents: 500,
    original_term_years: 1,
    aav_cents: 500,
    start_season_id: IDS.season1,
    status: "active",
    acquisition_source_type: "migration",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.contract_years.insert({
    id: IDS.contractYear1,
    league_id: IDS.league,
    contract_id: IDS.contract,
    season_id: IDS.season1,
    year_number: 1,
    aav_cents: 500,
    status: "current",
    rollover_at_ms: null,
    created_at_ms: NOW_MS,
  });
}

function createRuntime(t) {
  const connection = createConnection(t);
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-11-test",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  seedRuntime(context);
  return {
    context,
    database: connection.database,
    repository: createSqliteCommissionerCorrectionRepository({
      database: connection.database,
    }),
  };
}

function seedFreeAgent(runtime) {
  runtime.context.repositories.players.insert({
    id: IDS.freePlayer,
    first_name: "Free",
    last_name: "Agent",
    full_name: "Free Agent",
    birth_date: null,
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  runtime.context.repositories.player_source_state.insert({
    id: IDS.freeSource,
    player_id: IDS.freePlayer,
    provider: "test",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "BBB",
    active: 1,
    source_version: "one",
    source_payload_json: null,
    effective_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
  });
}

function additionInput(overrides = {}) {
  return {
    correctionId: IDS.addCorrection,
    ownershipId: IDS.addedOwnership,
    ownershipEventId: IDS.addedOwnershipEvent,
    contractId: IDS.addedContract,
    contractEventId: IDS.addedContractEvent,
    contractYearIds: [IDS.addedContractYear],
    activityId: IDS.addActivity,
    leagueId: IDS.league,
    seasonId: IDS.season1,
    playerId: IDS.freePlayer,
    actorUserId: IDS.commissioner,
    actorMembershipId: IDS.commissionerMembership,
    actorAuthority: "commissioner",
    teamId: IDS.team1,
    rosterCategory: "Active",
    positionGroup: "F",
    slotNumber: 2,
    contractType: "normal",
    originalTotalValueCents: 200,
    termYears: 1,
    confirmWarnings: false,
    reason: "Correct a missing roster assignment.",
    occurredAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function removalInput(overrides = {}) {
  return {
    correctionId: IDS.removeCorrection,
    ownershipEventId: IDS.removedOwnershipEvent,
    contractEventId: IDS.removedContractEvent,
    activityId: IDS.removeActivity,
    leagueId: IDS.league,
    seasonId: IDS.season1,
    ownershipId: IDS.ownership,
    playerId: IDS.player,
    expectedVersion: 1,
    contractId: IDS.contract,
    expectedContractVersion: 1,
    actorUserId: IDS.commissioner,
    actorMembershipId: IDS.commissionerMembership,
    actorAuthority: "commissioner",
    confirmWarnings: false,
    reason: "Correct an ownership assignment.",
    occurredAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function correctionIdempotency(operation, idValue, overrides = {}) {
  return {
    id: uuid(idValue),
    key: `m7-10-${operation}`,
    operation,
    requestHash: "a".repeat(64),
    expiresAtMs: NOW_MS + 86_400_000,
    ...overrides,
  };
}

function rosterInput(overrides = {}) {
  return {
    correctionId: IDS.correction,
    ownershipEventId: IDS.ownershipEvent,
    activityId: IDS.activity,
    leagueId: IDS.league,
    seasonId: IDS.season1,
    ownershipId: IDS.ownership,
    playerId: IDS.player,
    expectedVersion: 1,
    actorUserId: IDS.commissioner,
    actorMembershipId: IDS.commissionerMembership,
    actorAuthority: "commissioner",
    correctedTeamId: IDS.team1,
    correctedOwnershipKind: "Rostered",
    correctedRosterCategory: "Bench",
    correctedPositionGroup: "F",
    correctedSlotNumber: 1,
    confirmWarnings: false,
    reason: null,
    occurredAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function contractInput(overrides = {}) {
  return {
    correctionId: IDS.correction2,
    contractEventId: IDS.contractEvent,
    activityId: IDS.activity,
    leagueId: IDS.league,
    seasonId: IDS.season1,
    contractId: IDS.contract,
    playerId: IDS.player,
    expectedVersion: 1,
    actorUserId: IDS.commissioner,
    actorMembershipId: IDS.commissionerMembership,
    actorAuthority: "commissioner",
    correctedTeamId: IDS.team1,
    correctedContractType: "normal",
    correctedOriginalTotalValueCents: 1_000,
    correctedOriginalTermYears: 3,
    correctedStartSeasonId: IDS.season1,
    correctedStatus: "active",
    correctedAuctionBuyoutLockExpiresAtMs: null,
    correctedYears: [
      {
        id: IDS.contractYear1,
        seasonId: IDS.season1,
        yearNumber: 1,
        status: "current",
        rolloverAtMs: null,
      },
      {
        id: IDS.contractYear2,
        seasonId: IDS.season2,
        yearNumber: 2,
        status: "future",
        rolloverAtMs: null,
      },
      {
        id: IDS.contractYear3,
        seasonId: IDS.season3,
        yearNumber: 3,
        status: "future",
        rolloverAtMs: null,
      },
    ],
    confirmWarnings: false,
    reason: "Restore the approved auction terms.",
    occurredAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return (
      error instanceof CommissionerCorrectionPolicyError &&
      error.reasonCode === reasonCode
    );
  });
}

describe("M4-11 commissioner correction policy", () => {
  test("requires explicit commissioner authority and exact roster shapes", () => {
    assert.equal(Object.isFrozen(validateRosterCorrection(rosterInput())), true);
    assert.equal(
      validateRosterCorrection(
        rosterInput({ actorAuthority: "platform_administrator" })
      ).actorAuthority,
      "platform_administrator"
    );
    assertPolicyError(
      () => validateRosterCorrection(rosterInput({ actorAuthority: "manager" })),
      COMMISSIONER_CORRECTION_CODES.authorityInvalid
    );
    assertPolicyError(
      () =>
        validateRosterCorrection(
          rosterInput({
            correctedOwnershipKind: "Prospect Right",
            correctedRosterCategory: "Active",
          })
        ),
      COMMISSIONER_CORRECTION_CODES.rosterInvalid
    );
  });

  test("derives rounded AAV and validates a complete corrected year schedule", () => {
    const correction = validateContractCorrection(contractInput());
    assert.equal(correction.correctedAavCents, 333);
    assert.equal(correction.correctedYears.length, 3);
    assertPolicyError(
      () =>
        validateContractCorrection(
          contractInput({
            correctedYears: contractInput().correctedYears.map((year) => ({
              ...year,
              status: "future",
            })),
          })
        ),
      COMMISSIONER_CORRECTION_CODES.scheduleInvalid
    );
  });
});

describe("M4-11 optional-reason migration", () => {
  test("preserves existing correction rows and accepts a null reason", (t) => {
    const { database } = createConnection(t, "hundo-m4-11-migration-");
    const migrations = discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    });
    applyMigrations({
      database,
      migrations: migrations.slice(0, 7),
      applicationBuildId: "m4-11-before",
      now: () => NOW_MS,
    });
    insertRow(database, "users", {
      id: IDS.commissioner,
      email_normalized: "commissioner@example.test",
      email_display: "commissioner@example.test",
      display_name: "Commissioner",
      display_name_normalized: "commissioner",
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    insertRow(database, "leagues", {
      id: IDS.league,
      name: "League",
      name_normalized: "league",
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    insertRow(database, "seasons", {
      id: IDS.season1,
      league_id: IDS.league,
      label: "Season",
      nhl_season_key: "20262027",
      status: "planned",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    insertRow(database, "commissioner_corrections", {
      id: IDS.correction,
      league_id: IDS.league,
      season_id: IDS.season1,
      feature: "contract",
      feature_record_id: IDS.contract,
      actor_user_id: IDS.commissioner,
      reason: "Legacy reason",
      before_snapshot_json: "{}",
      after_snapshot_json: "{}",
      corrected_at_ms: NOW_MS,
    });

    applyMigrations({
      database,
      migrations,
      applicationBuildId: "m4-11-after",
      now: () => NOW_MS + 1,
    });
    assert.equal(
      database
        .prepare("SELECT reason FROM commissioner_corrections WHERE id = ?")
        .get(IDS.correction).reason,
      "Legacy reason"
    );
    assert.equal(
      database
        .pragma("table_info(commissioner_corrections)")
        .find((column) => column.name === "reason").notnull,
      0
    );
    database.prepare(`
      INSERT INTO commissioner_corrections (
        id, league_id, season_id, feature, feature_record_id,
        actor_user_id, reason, before_snapshot_json,
        after_snapshot_json, corrected_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', '{}', ?)
    `).run(
      IDS.correction2,
      IDS.league,
      IDS.season1,
      "roster",
      IDS.ownership,
      IDS.commissioner,
      NOW_MS + 1
    );
    assert.equal(database.pragma("user_version", { simple: true }), 21);
  });
});

describe("M4-11 atomic SQLite commissioner corrections", () => {
  test("previews and applies an audited free-agent roster addition atomically", (t) => {
    const runtime = createRuntime(t);
    seedFreeAgent(runtime);
    const before = runtime.database.serialize();
    const preview = runtime.repository.previewAdd(additionInput());
    assert.equal(preview.preview, true);
    assert.equal(preview.authoritative.ownership.playerId, IDS.freePlayer);
    assert.equal(preview.authoritative.contract.aavCents, 200);
    assert.deepEqual(runtime.database.serialize(), before);

    const applied = runtime.repository.applyAdd(
      additionInput(),
      correctionIdempotency("commissioner_roster_add", 90)
    );
    assert.equal(applied.preview, false);
    assert.equal(applied.correction.feature, "roster_add");
    assert.equal(applied.activity.event_type, "commissioner_player_added");
    assert.equal(
      runtime.context.repositories.player_ownerships.findByKey({
        key: IDS.addedOwnership,
        leagueId: IDS.league,
      }).player_id,
      IDS.freePlayer
    );
    assert.equal(
      runtime.context.repositories.contracts.findByKey({
        key: IDS.addedContract,
        leagueId: IDS.league,
      }).aav_cents,
      200
    );
    const replay = runtime.repository.applyAdd(
      additionInput({
        correctionId: uuid(100),
        ownershipId: uuid(101),
        ownershipEventId: uuid(102),
        contractId: uuid(103),
        contractEventId: uuid(104),
        contractYearIds: [uuid(105)],
        activityId: uuid(106),
        occurredAtMs: NOW_MS + 2,
      }),
      correctionIdempotency(
        "commissioner_roster_add",
        107,
        { expiresAtMs: NOW_MS + 86_400_001 }
      )
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.correction.id, IDS.addCorrection);
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM idempotency_requests")
        .get().count,
      1
    );
  });

  test("keeps unresolved or goalie-source players out of commissioner roster additions", (t) => {
    const runtime = createRuntime(t);
    seedFreeAgent(runtime);
    runtime.database.prepare(`
      UPDATE player_source_state
      SET source_position = 'G', normalized_position = NULL
      WHERE id = ?
    `).run(IDS.freeSource);

    const before = runtime.database.serialize();
    const workspace = runtime.repository.readWorkspace({
      leagueId: IDS.league,
      actorUserId: IDS.commissioner,
      actorMembershipId: IDS.commissionerMembership,
      actorAuthority: "commissioner",
      observedAtMs: NOW_MS,
    });
    assert.equal(
      workspace.freeAgents.some(
        ({ playerId }) => playerId === IDS.freePlayer
      ),
      false
    );
    assertPolicyError(
      () => runtime.repository.previewAdd(additionInput()),
      COMMISSIONER_CORRECTION_CODES.rosterInvalid
    );
    assert.deepEqual(runtime.database.serialize(), before);
  });

  test("previews and applies an audited roster removal with contract cancellation", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const preview = runtime.repository.previewRemove(removalInput());
    assert.equal(preview.preview, true);
    assert.equal(preview.authoritative.ownership, null);
    assert.equal(preview.authoritative.contract.status, "cancelled");
    assert.deepEqual(runtime.database.serialize(), before);

    const applied = runtime.repository.applyRemove(
      removalInput(),
      correctionIdempotency("commissioner_roster_remove", 91)
    );
    assert.equal(applied.correction.feature, "roster_remove");
    assert.equal(applied.activity.event_type, "commissioner_player_removed");
    assert.equal(
      runtime.context.repositories.player_ownerships.findByKey({
        key: IDS.ownership,
        leagueId: IDS.league,
      }),
      null
    );
    assert.equal(
      runtime.context.repositories.contracts.findByKey({
        key: IDS.contract,
        leagueId: IDS.league,
      }).status,
      "cancelled"
    );
  });

  test("reads authoritative correction inputs and honors inherited platform-admin authority", (t) => {
    const runtime = createRuntime(t);
    const workspace = runtime.repository.readWorkspace({
      leagueId: IDS.league,
      actorUserId: IDS.commissioner,
      actorMembershipId: IDS.commissionerMembership,
      actorAuthority: "commissioner",
      observedAtMs: NOW_MS,
    });
    assert.equal(workspace.league.currentSeasonId, IDS.season1);
    assert.equal(workspace.teams.length, 2);
    assert.equal(workspace.seasons.length, 3);
    assert.deepEqual(workspace.seasons[0], {
      id: IDS.season1,
      label: "2026-27",
      nhlSeasonKey: "20262027",
      status: "active",
      sequence: 1,
    });
    assert.equal(workspace.roster.length, 1);
    assert.equal(workspace.roster[0].ownershipId, IDS.ownership);
    assert.equal(workspace.roster[0].contract.id, IDS.contract);
    assert.equal(workspace.roster[0].contract.years.length, 1);
    assert.equal(workspace.freeAgents.length, 0);
    assert.equal(workspace.providerHealth.stale, true);
    assert.equal(workspace.providerHealth.catalogPlayerCount, 0);

    runtime.context.repositories.platform_roles.insert({
      id: IDS.platformRole,
      user_id: IDS.manager,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: IDS.commissioner,
      granted_at_ms: NOW_MS,
      ended_at_ms: null,
      version: 1,
    });
    const preview = runtime.repository.previewRoster(
      rosterInput({
        actorUserId: IDS.manager,
        actorMembershipId: IDS.managerMembership,
        actorAuthority: "platform_administrator",
      })
    );
    assert.equal(preview.preview, true);
  });

  test("previews roster illegality without writing any state", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const result = runtime.repository.previewRoster(rosterInput());
    const after = runtime.database.serialize();

    assert.equal(result.preview, true);
    assert.equal(result.authoritative.version, 2);
    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      ["BENCH_AAV_LIMIT_EXCEEDED"]
    );
    assert.deepEqual(after, before);
    assert.equal(
      runtime.context.repositories.player_ownerships.findByKey({
        key: IDS.ownership,
        leagueId: IDS.league,
      }).roster_category,
      "Active"
    );
  });

  test("requires warning confirmation, then records all roster evidence atomically", (t) => {
    const runtime = createRuntime(t);
    assertPolicyError(
      () =>
        runtime.repository.applyRoster(
          rosterInput(),
          correctionIdempotency(
            "commissioner_roster_correction",
            92
          )
        ),
      COMMISSIONER_CORRECTION_CODES.confirmationRequired
    );
    assert.equal(
      runtime.context.repositories.player_ownerships.findByKey({
        key: IDS.ownership,
        leagueId: IDS.league,
      }).version,
      1
    );

    const result = runtime.repository.applyRoster(
      rosterInput({ confirmWarnings: true }),
      correctionIdempotency(
        "commissioner_roster_correction",
        92
      )
    );
    assert.equal(result.preview, false);
    assert.equal(result.authoritative.rosterCategory, "Bench");
    assert.equal(result.correction.reason, null);
    assert.equal(
      JSON.parse(result.correction.after_snapshot_json).actor.membershipId,
      IDS.commissionerMembership
    );
    assert.equal(result.ownershipEvent.event_type, "commissioner_roster_corrected");
    assert.equal(result.activity.actor_authority, "commissioner");
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_players").get().count,
      0
    );
  });

  test("corrects contract terms and schedule while preserving stable IDs and history", (t) => {
    const runtime = createRuntime(t);
    const preview = runtime.repository.previewContract(contractInput());
    assert.equal(preview.preview, true);
    assert.equal(preview.authoritative.aavCents, 333);
    assert.equal(
      runtime.context.repositories.contracts.findByKey({
        key: IDS.contract,
        leagueId: IDS.league,
      }).version,
      1
    );

    const result = runtime.repository.applyContract(
      contractInput(),
      correctionIdempotency(
        "commissioner_contract_correction",
        93
      )
    );
    assert.equal(result.authoritative.id, IDS.contract);
    assert.equal(result.authoritative.version, 2);
    assert.equal(result.authoritative.aavCents, 333);
    assert.deepEqual(
      result.authoritative.years.map((year) => year.id),
      [IDS.contractYear1, IDS.contractYear2, IDS.contractYear3]
    );
    assert.equal(result.contractEvent.event_type, "commissioner_contract_corrected");
    assert.equal(result.correction.feature, "contract");
    assert.equal(result.activity.related_id, IDS.contract);
  });

  test("rejects non-current commissioner authority and stale versions without writes", (t) => {
    const runtime = createRuntime(t);
    assertPolicyError(
      () =>
        runtime.repository.applyRoster(
          rosterInput({
            actorUserId: IDS.manager,
            actorMembershipId: IDS.managerMembership,
          }),
          correctionIdempotency(
            "commissioner_roster_correction",
            92
          )
        ),
      COMMISSIONER_CORRECTION_CODES.authorityInvalid
    );
    assertPolicyError(
      () =>
        runtime.repository.applyRoster(
          rosterInput({ expectedVersion: 2 }),
          correctionIdempotency(
            "commissioner_roster_correction",
            92
          )
        ),
      COMMISSIONER_CORRECTION_CODES.sourceChanged
    );
    assertPolicyError(
      () =>
        runtime.repository.previewRoster(
          rosterInput({ correctedTeamId: IDS.team2 })
        ),
      COMMISSIONER_CORRECTION_CODES.scopeMismatch
    );
    assertPolicyError(
      () =>
        runtime.repository.previewContract(
          contractInput({ correctedTeamId: IDS.team2 })
        ),
      COMMISSIONER_CORRECTION_CODES.scopeMismatch
    );
    assertPolicyError(
      () =>
        runtime.repository.previewContract(
          contractInput({
            correctedContractType: "fantasy_elc",
            correctedOriginalTotalValueCents: 300,
          })
        ),
      COMMISSIONER_CORRECTION_CODES.scopeMismatch
    );
    assertPolicyError(
      () =>
        runtime.repository.previewContract(
          contractInput({
            correctedAuctionBuyoutLockExpiresAtMs: NOW_MS + 1000,
          })
        ),
      COMMISSIONER_CORRECTION_CODES.scopeMismatch
    );
    assertPolicyError(
      () =>
        runtime.repository.previewRoster(
          rosterInput({
            correctedOwnershipKind: "Prospect Right",
            correctedRosterCategory: "Prospect",
            correctedSlotNumber: null,
          })
        ),
      COMMISSIONER_CORRECTION_CODES.rosterInvalid
    );
    assert.equal(
      runtime.repository.previewRoster(
        rosterInput({
          correctedOwnershipKind: "Rostered",
          correctedRosterCategory: "Prospect",
          correctedSlotNumber: null,
        })
      ).warnings.some(
        ({ code }) =>
          code ===
          "PROSPECT_STATUS_REQUIRES_CORRECTION_CONFIRMATION"
      ),
      true
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM commissioner_corrections").get().count,
      0
    );
  });

  test("fails closed when a pending trade depends on the corrected contract", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.trades.insert({
      id: IDS.trade,
      league_id: IDS.league,
      season_id: IDS.season1,
      proposing_team_id: IDS.team1,
      receiving_team_id: IDS.team2,
      proposing_user_id: IDS.commissioner,
      status: "proposed",
      created_at_ms: NOW_MS,
      expires_at_ms: NOW_MS + 10_000,
      responded_at_ms: null,
      completed_at_ms: null,
      commissioner_completion_reference: null,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    runtime.context.repositories.trade_assets.insert({
      id: IDS.tradeAsset,
      league_id: IDS.league,
      trade_id: IDS.trade,
      direction: "proposing_to_receiving",
      source_team_id: IDS.team1,
      destination_team_id: IDS.team2,
      asset_type: "contract",
      contract_id: IDS.contract,
      player_id: null,
      draft_pick_id: null,
      retention_obligation_id: null,
      buyout_obligation_id: null,
      future_consideration_id: null,
      requested_retention_cents: null,
      proposal_snapshot_json: "{}",
      sequence: 1,
      created_at_ms: NOW_MS,
    });
    assertPolicyError(
      () => runtime.repository.previewContract(contractInput()),
      COMMISSIONER_CORRECTION_CODES.dependencyConflict
    );
    assert.equal(
      runtime.context.repositories.contracts.findByKey({
        key: IDS.contract,
        leagueId: IDS.league,
      }).version,
      1
    );
  });

  test("fails closed when active salary retention depends on the corrected contract", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.retention_obligations.insert({
      id: IDS.retention,
      league_id: IDS.league,
      contract_id: IDS.contract,
      player_id: IDS.player,
      originating_team_id: IDS.team1,
      responsible_team_id: IDS.team2,
      retained_aav_cents: 100,
      creation_trade_id: null,
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });

    assertPolicyError(
      () => runtime.repository.previewContract(contractInput()),
      COMMISSIONER_CORRECTION_CODES.dependencyConflict
    );
    assert.equal(
      runtime.context.repositories.contracts.findByKey({
        key: IDS.contract,
        leagueId: IDS.league,
      }).version,
      1
    );
  });

  test("rolls back state and earlier evidence when a final history insert fails", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.league_activity.insert({
      id: IDS.activity,
      league_id: IDS.league,
      season_id: IDS.season1,
      event_type: "existing",
      actor_user_id: IDS.commissioner,
      actor_authority: "commissioner",
      team_id: IDS.team1,
      player_id: IDS.player,
      related_type: null,
      related_id: null,
      display_summary: "Existing activity.",
      reason: null,
      metadata_json: null,
      occurred_at_ms: NOW_MS,
    });
    assert.throws(() =>
      runtime.repository.applyRoster(
        rosterInput({ confirmWarnings: true }),
        correctionIdempotency(
          "commissioner_roster_correction",
          92
        )
      )
    );
    const ownership = runtime.context.repositories.player_ownerships.findByKey({
      key: IDS.ownership,
      leagueId: IDS.league,
    });
    assert.equal(ownership.roster_category, "Active");
    assert.equal(ownership.version, 1);
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM commissioner_corrections").get().count,
      0
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM ownership_events").get().count,
      0
    );
  });
});
