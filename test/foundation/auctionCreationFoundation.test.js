const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
  getAuctionCreationWindow,
  validateAuctionCreationCommand,
  validateOpeningBid,
} = require("../../src/domain/auctions/auctionCreationPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteAuctionRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteAuctionRepository");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T19:00:00.000Z");
const IDEMPOTENCY_EXPIRY_MS = NOW_MS + 24 * 60 * 60 * 1000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  manager: uuid(1),
  commissioner: uuid(2),
  otherUser: uuid(3),
  leagueA: uuid(10),
  leagueB: uuid(11),
  seasonA: uuid(20),
  seasonB: uuid(21),
  teamA: uuid(30),
  teamB: uuid(31),
  managerMembership: uuid(40),
  commissionerMembership: uuid(41),
  otherMembership: uuid(42),
  assignment: uuid(50),
  player1: uuid(60),
  player2: uuid(61),
  player3: uuid(62),
  source1: uuid(70),
  source2: uuid(71),
  source3: uuid(72),
  auction: uuid(80),
  bid: uuid(81),
  event: uuid(82),
  idempotency: uuid(83),
});

function semanticHash(database) {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name"
    )
    .all()
    .map(({ name }) => ({
      name,
      rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    }));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function insertUser(repositories, id, displayName) {
  repositories.users.insert({
    id,
    email_normalized: `${displayName.toLowerCase()}@example.test`,
    email_display: `${displayName.toLowerCase()}@example.test`,
    display_name: displayName,
    display_name_normalized: displayName.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS - 1000,
    updated_at_ms: NOW_MS - 1000,
    version: 1,
  });
}

function insertLeagueFoundation(repositories, {
  leagueId,
  seasonId,
  teamId,
  name,
  userId,
  membershipId,
  permissionCategory,
  status = "active",
}) {
  repositories.leagues.insert({
    id: leagueId,
    name: `${name} League`,
    name_normalized: `${name.toLowerCase()} league`,
    status,
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS - 1000,
    updated_at_ms: NOW_MS - 1000,
    version: 1,
  });
  repositories.seasons.insert({
    id: seasonId,
    league_id: leagueId,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: Date.parse("2026-07-01T07:00:00.000Z"),
    regular_season_ends_at_ms: Date.parse("2027-04-01T07:00:00.000Z"),
    fantasy_playoffs_start_at_ms: Date.parse("2027-03-01T08:00:00.000Z"),
    fantasy_playoffs_end_at_ms: Date.parse("2027-04-01T07:00:00.000Z"),
    created_at_ms: NOW_MS - 1000,
    updated_at_ms: NOW_MS - 1000,
    version: 1,
    free_agent_draft_completed_at_ms: Date.parse("2026-07-01T08:00:00.000Z"),
  });
  repositories.teams.insert({
    id: teamId,
    league_id: leagueId,
    name: `${name} Team`,
    name_normalized: `${name.toLowerCase()} team`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS - 1000,
    updated_at_ms: NOW_MS - 1000,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: membershipId,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: NOW_MS - 1000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 1000,
    updated_at_ms: NOW_MS - 1000,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: leagueId,
    expectedVersion: 1,
    changes: {
      current_season_id: seasonId,
      commissioner_membership_id:
        permissionCategory === "commissioner" ? membershipId : null,
      updated_at_ms: NOW_MS,
    },
  });
}

function insertPlayer(repositories, { playerId, sourceId, normalizedPosition = "F" }) {
  repositories.players.insert({
    id: playerId,
    first_name: "Player",
    last_name: playerId.slice(-2),
    full_name: `Player ${playerId.slice(-2)}`,
    birth_date: "2000-01-01",
    status: "active",
    created_at_ms: NOW_MS - 1000,
    updated_at_ms: NOW_MS - 1000,
    version: 1,
  });
  if (normalizedPosition !== null) {
    repositories.player_source_state.insert({
      id: sourceId,
      player_id: playerId,
      provider: "test",
      source_position: normalizedPosition === "F" ? "C" : "D",
      normalized_position: normalizedPosition,
      nhl_team_abbreviation: "TST",
      active: 1,
      source_version: "one",
      source_payload_json: null,
      effective_at_ms: NOW_MS - 1000,
      ended_at_ms: null,
      created_at_ms: NOW_MS - 1000,
    });
  }
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-01-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m5-01-test",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  const { repositories } = context;
  insertUser(repositories, IDS.manager, "Manager");
  insertUser(repositories, IDS.commissioner, "Commissioner");
  insertUser(repositories, IDS.otherUser, "Other");
  insertLeagueFoundation(repositories, {
    leagueId: IDS.leagueA,
    seasonId: IDS.seasonA,
    teamId: IDS.teamA,
    name: "Alpha",
    userId: IDS.manager,
    membershipId: IDS.managerMembership,
    permissionCategory: "manager",
  });
  repositories.league_memberships.insert({
    id: IDS.commissionerMembership,
    league_id: IDS.leagueA,
    user_id: IDS.commissioner,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS - 1000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 1000,
    updated_at_ms: NOW_MS - 1000,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: IDS.leagueA,
    expectedVersion: 2,
    changes: {
      commissioner_membership_id: IDS.commissionerMembership,
      updated_at_ms: NOW_MS + 1,
    },
  });
  repositories.team_manager_assignments.insert({
    id: IDS.assignment,
    league_id: IDS.leagueA,
    team_id: IDS.teamA,
    user_id: IDS.manager,
    membership_id: IDS.managerMembership,
    assigned_by_user_id: IDS.commissioner,
    status: "accepted",
    assigned_at_ms: NOW_MS - 1000,
    accepted_at_ms: NOW_MS - 1000,
    ended_at_ms: null,
    version: 1,
  });
  insertLeagueFoundation(repositories, {
    leagueId: IDS.leagueB,
    seasonId: IDS.seasonB,
    teamId: IDS.teamB,
    name: "Bravo",
    userId: IDS.otherUser,
    membershipId: IDS.otherMembership,
    permissionCategory: "manager",
  });
  insertPlayer(repositories, { playerId: IDS.player1, sourceId: IDS.source1 });
  insertPlayer(repositories, { playerId: IDS.player2, sourceId: IDS.source2 });
  insertPlayer(repositories, { playerId: IDS.player3, sourceId: IDS.source3 });
  const repository = createSqliteAuctionRepository({ database: connection.database });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { context, database: connection.database, repository };
}

function command(overrides = {}) {
  return {
    auctionId: IDS.auction,
    bidId: IDS.bid,
    eventId: IDS.event,
    idempotencyRequestId: IDS.idempotency,
    leagueId: IDS.leagueA,
    seasonId: IDS.seasonA,
    teamId: IDS.teamA,
    playerId: IDS.player1,
    actorUserId: IDS.manager,
    actorMembershipId: IDS.managerMembership,
    actorAuthority: "manager",
    totalValueCents: 1000,
    termYears: 3,
    idempotencyKey: "m5-01-start-one",
    occurredAtMs: NOW_MS,
    idempotencyExpiresAtMs: IDEMPOTENCY_EXPIRY_MS,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return error instanceof AuctionCreationPolicyError && error.reasonCode === reasonCode;
  });
}

describe("M5-01 auction creation policy", () => {
  test("calculates exact Pacific weekly boundaries, including a DST week", () => {
    const monday = getAuctionCreationWindow({
      nowMs: Date.parse("2026-07-20T07:00:00.000Z"),
      timeZone: "America/Vancouver",
    });
    assert.equal(monday.canStart, true);
    assert.equal(monday.opensAtMs, Date.parse("2026-07-20T07:00:00.000Z"));
    assert.equal(
      monday.newAuctionCutoffAtMs,
      Date.parse("2026-07-24T07:00:00.000Z")
    );
    assert.equal(monday.bidClosesAtMs, Date.parse("2026-07-26T23:00:00.000Z"));
    assert.equal(
      getAuctionCreationWindow({
        nowMs: monday.newAuctionCutoffAtMs - 1,
        timeZone: "America/Vancouver",
      }).canStart,
      true
    );
    assert.equal(
      getAuctionCreationWindow({
        nowMs: monday.newAuctionCutoffAtMs,
        timeZone: "America/Vancouver",
      }).canStart,
      false
    );

    const dstWeek = getAuctionCreationWindow({
      nowMs: Date.parse("2026-03-09T07:00:00.000Z"),
      timeZone: "America/Vancouver",
    });
    assert.equal(dstWeek.opensAtMs, Date.parse("2026-03-09T07:00:00.000Z"));
    assert.equal(dstWeek.bidClosesAtMs, Date.parse("2026-03-15T23:00:00.000Z"));
  });

  test("enforces starting minimums, precision, terms, and rounded AAV", () => {
    assert.deepEqual(validateOpeningBid(100, 1), {
      totalValueCents: 100,
      termYears: 1,
      aavCents: 100,
    });
    assert.deepEqual(validateOpeningBid(1000, 3), {
      totalValueCents: 1000,
      termYears: 3,
      aavCents: 333,
    });
    assertPolicyError(
      () => validateOpeningBid(100, 2),
      AUCTION_CREATION_CODES.valueInvalid
    );
    assertPolicyError(
      () => validateOpeningBid(250, 2),
      AUCTION_CREATION_CODES.valueInvalid
    );
    assertPolicyError(
      () => validateOpeningBid(400, 4),
      AUCTION_CREATION_CODES.termInvalid
    );
    assertPolicyError(
      () => validateAuctionCreationCommand({ ...command(), unknown: true }),
      AUCTION_CREATION_CODES.inputInvalid
    );
  });
});

describe("M5-01 auction persistence foundation", () => {
  test("adds the nullable lifecycle timestamp without changing pre-0009 season data", (t) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-01-migration-"));
    const connection = openDatabase({
      databasePath: path.join(temporaryRoot, "league.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });
    const migrations = discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY });
    applyMigrations({
      database: connection.database,
      migrations: migrations.slice(0, 8),
      applicationBuildId: "m5-01-before",
      now: () => NOW_MS,
    });
    const context = createSqliteRepositoryContext({ database: connection.database });
    context.repositories.leagues.insert({
      id: IDS.leagueA,
      name: "Alpha League",
      name_normalized: "alpha league",
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    context.repositories.seasons.insert({
      id: IDS.seasonA,
      league_id: IDS.leagueA,
      label: "2026-27",
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
    const before = connection.database.prepare("SELECT * FROM seasons").get();
    applyMigrations({
      database: connection.database,
      migrations: migrations.slice(0, 9),
      applicationBuildId: "m5-01-after",
      now: () => NOW_MS + 1,
    });
    const after = connection.database.prepare("SELECT * FROM seasons").get();
    assert.deepEqual(after, { ...before, free_agent_draft_completed_at_ms: null });
    assert.equal(connection.database.pragma("user_version", { simple: true }), 9);
  });

  test("creates one auction, opening bid, event, and completed idempotency atomically", (t) => {
    const runtime = createRuntime(t);
    const result = runtime.repository.startAuction(command());
    assert.equal(result.replayed, false);
    assert.deepEqual(result.auction, {
      id: IDS.auction,
      leagueId: IDS.leagueA,
      seasonId: IDS.seasonA,
      playerId: IDS.player1,
      status: "Active",
      openedAtMs: NOW_MS,
      bidClosesAtMs: Date.parse("2026-07-26T23:00:00.000Z"),
      scheduledResolutionAtMs: Date.parse("2026-07-26T23:00:00.000Z"),
      openedByUserId: IDS.manager,
      version: 1,
    });
    assert.equal(result.openingBid.aavCents, 333);
    assert.equal(result.openingBid.editCount, 0);
    assert.equal(result.event.type, "auction_started");
    assert.equal(
      runtime.database.prepare("SELECT status FROM idempotency_requests").get().status,
      "completed"
    );
    assert.equal(runtime.database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
    assert.equal(runtime.database.prepare("SELECT COUNT(*) AS count FROM outbox_events").get().count, 0);
  });

  test("replays a matching key without revalidating a now-closed window and rejects changed use", (t) => {
    const runtime = createRuntime(t);
    const created = runtime.repository.startAuction(command());
    const replayed = runtime.repository.startAuction(command({
      auctionId: uuid(180),
      bidId: uuid(181),
      eventId: uuid(182),
      idempotencyRequestId: uuid(183),
      occurredAtMs: Date.parse("2026-07-25T19:00:00.000Z"),
      idempotencyExpiresAtMs: Date.parse("2026-07-26T19:00:00.000Z"),
    }));
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.auction.id, created.auction.id);
    assert.equal(runtime.database.prepare("SELECT COUNT(*) AS count FROM auctions").get().count, 1);
    assertPolicyError(
      () => runtime.repository.startAuction(command({ totalValueCents: 1200 })),
      AUCTION_CREATION_CODES.idempotencyConflict
    );
  });

  test("enforces manager freeze while allowing the explicit current commissioner", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.leagues.updateVersioned({
      key: IDS.leagueA,
      expectedVersion: 3,
      changes: { status: "frozen", updated_at_ms: NOW_MS + 2 },
    });
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.startAuction(command()),
      AUCTION_CREATION_CODES.authorizationDenied
    );
    assert.equal(semanticHash(runtime.database), before);
    const commissionerResult = runtime.repository.startAuction(command({
      actorUserId: IDS.commissioner,
      actorMembershipId: IDS.commissionerMembership,
      actorAuthority: "commissioner",
    }));
    assert.equal(commissionerResult.auction.playerId, IDS.player1);
  });

  test("rejects closed seasonal and weekly windows without writing", (t) => {
    const runtime = createRuntime(t);
    for (const invalid of [
      { occurredAtMs: Date.parse("2026-07-24T07:00:00.000Z"), idempotencyExpiresAtMs: Date.parse("2026-07-25T07:00:00.000Z"), reason: AUCTION_CREATION_CODES.windowClosed },
      { occurredAtMs: Date.parse("2027-03-01T08:00:00.000Z"), idempotencyExpiresAtMs: Date.parse("2027-03-02T08:00:00.000Z"), reason: AUCTION_CREATION_CODES.seasonUnavailable },
    ]) {
      const { reason, ...overrides } = invalid;
      const before = semanticHash(runtime.database);
      assertPolicyError(
        () => runtime.repository.startAuction(command(overrides)),
        reason
      );
      assert.equal(semanticHash(runtime.database), before);
    }
  });

  test("rejects cross-league authority, current ownership, released rights, and duplicate auctions", (t) => {
    const cases = [
      {
        prepare() {},
        overrides: { leagueId: IDS.leagueB, seasonId: IDS.seasonB },
        reason: AUCTION_CREATION_CODES.authorizationDenied,
      },
      {
        prepare(runtime) {
          runtime.context.repositories.player_ownerships.insert({
            id: uuid(190), league_id: IDS.leagueA, season_id: IDS.seasonA,
            player_id: IDS.player1, team_id: IDS.teamA,
            ownership_kind: "Rostered", roster_category: "Active",
            position_group: "F", slot_number: 1,
            acquired_transaction_type: "test", acquired_transaction_id: null,
            created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1,
          });
        },
        overrides: {},
        reason: AUCTION_CREATION_CODES.playerOwned,
      },
      {
        prepare(runtime) {
          runtime.context.repositories.ownership_events.insert({
            id: uuid(191), league_id: IDS.leagueA, season_id: IDS.seasonA,
            player_id: IDS.player1, team_id: IDS.teamA, ownership_id: null,
            event_type: "unsigned_prospect_rights_released",
            actor_user_id: IDS.manager, source_type: "test", source_id: null,
            before_metadata_json: null, after_metadata_json: null,
            reason: null, occurred_at_ms: NOW_MS - 1,
          });
        },
        overrides: {},
        reason: AUCTION_CREATION_CODES.releasedRightsExcluded,
      },
      {
        prepare(runtime) {
          runtime.repository.startAuction(command({
            auctionId: uuid(192), bidId: uuid(193), eventId: uuid(194),
            idempotencyRequestId: uuid(195), idempotencyKey: "existing-auction",
          }));
        },
        overrides: { auctionId: uuid(196), bidId: uuid(197), eventId: uuid(198), idempotencyRequestId: uuid(199), idempotencyKey: "duplicate-auction" },
        reason: AUCTION_CREATION_CODES.activeAuctionExists,
      },
    ];
    for (const entry of cases) {
      const runtime = createRuntime(t);
      entry.prepare(runtime);
      const before = semanticHash(runtime.database);
      assertPolicyError(
        () => runtime.repository.startAuction(command(entry.overrides)),
        entry.reason
      );
      assert.equal(semanticHash(runtime.database), before);
    }
  });

  test("rejects players outside the active normalized F/D pool", (t) => {
    const runtime = createRuntime(t);
    runtime.database.prepare(
      "UPDATE player_source_state SET active = 0 WHERE player_id = ?"
    ).run(IDS.player1);
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.startAuction(command()),
      AUCTION_CREATION_CODES.playerIneligible
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("rolls back earlier inserts when a late stable-ID collision fails", (t) => {
    const runtime = createRuntime(t);
    runtime.repository.startAuction(command({
      auctionId: uuid(210), bidId: IDS.bid, eventId: uuid(212),
      idempotencyRequestId: uuid(213), playerId: IDS.player2,
      idempotencyKey: "seed-bid-id",
    }));
    const before = semanticHash(runtime.database);
    assert.throws(() => runtime.repository.startAuction(command({
      auctionId: uuid(214), eventId: uuid(215),
      idempotencyRequestId: uuid(216), idempotencyKey: "late-failure",
    })));
    assert.equal(semanticHash(runtime.database), before);
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM auctions WHERE player_id = ?").get(IDS.player1).count,
      0
    );
  });
});
