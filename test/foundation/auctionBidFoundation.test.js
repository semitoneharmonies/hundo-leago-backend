const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  AUCTION_BID_CODES,
  AuctionBidPolicyError,
  COOLDOWN_MS,
  assertAuctionBidState,
  validateAuctionBidCommand,
  validateBidOffer,
} = require("../../src/domain/auctions/auctionBidPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createSqliteAuctionRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteAuctionRepository");
const {
  createSqliteAuctionBidRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteAuctionBidRepository");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T19:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createHistoricalRepositories(database) {
  return new Proxy(
    {},
    {
      get(_target, tableName) {
        return {
          insert(values) {
            const columns = Object.keys(values);
            database
              .prepare(
                `INSERT INTO ${String(tableName)} (${columns.join(", ")}) ` +
                  `VALUES (${columns.map(() => "?").join(", ")})`
              )
              .run(...columns.map((column) => values[column]));
          },
        };
      },
    }
  );
}

const IDS = Object.freeze({
  user: uuid(1),
  membership: uuid(2),
  league: uuid(3),
  season: uuid(4),
  team: uuid(5),
  player: uuid(6),
  auction: uuid(7),
  bid: uuid(8),
  event: uuid(9),
  idempotency: uuid(10),
  managerB: uuid(11),
  commissioner: uuid(12),
  member: uuid(13),
  membershipB: uuid(14),
  commissionerMembership: uuid(15),
  memberMembership: uuid(16),
  teamB: uuid(17),
  teamC: uuid(18),
  assignmentA: uuid(19),
  assignmentB: uuid(20),
  source: uuid(21),
  openingBid: uuid(22),
  openingEvent: uuid(23),
  openingIdempotency: uuid(24),
});

function command(overrides = {}) {
  return validateAuctionBidCommand({
    auctionId: IDS.auction,
    bidId: IDS.bid,
    eventId: IDS.event,
    idempotencyRequestId: IDS.idempotency,
    leagueId: IDS.league,
    teamId: IDS.team,
    actorUserId: IDS.user,
    actorMembershipId: IDS.membership,
    actorAuthority: "manager",
    totalValueCents: 600,
    termYears: 3,
    expectedBidVersion: null,
    idempotencyKey: "m5-02-bid-one",
    occurredAtMs: NOW_MS,
    idempotencyExpiresAtMs: NOW_MS + 86_400_000,
    ...overrides,
  });
}

function authority(overrides = {}) {
  return {
    league_status: "active",
    membership_status: "active",
    membership_permission: "manager",
    assignment_status: "accepted",
    assignment_ended_at_ms: null,
    team_id: IDS.team,
    team_status: "active",
    commissioner_membership_id: uuid(90),
    ...overrides,
  };
}

function auction(overrides = {}) {
  return {
    league_id: IDS.league,
    status: "open",
    opened_at_ms: NOW_MS - COOLDOWN_MS,
    resolves_at_ms: NOW_MS + 86_400_000,
    ...overrides,
  };
}

function existingBid(overrides = {}) {
  return {
    id: IDS.bid,
    auction_id: IDS.auction,
    team_id: IDS.team,
    total_value_cents: 600,
    term_years: 3,
    lowest_offered_aav_cents: 200,
    first_submitted_at_ms: NOW_MS - COOLDOWN_MS,
    last_edited_at_ms: NOW_MS - COOLDOWN_MS,
    edit_count: 0,
    status: "active",
    version: 1,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return error instanceof AuctionBidPolicyError && error.reasonCode === reasonCode;
  });
}

function semanticHash(database) {
  const tables = database
    .prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all();
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        tables.map(({ name }) => ({
          name,
          rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        }))
      )
    )
    .digest("hex");
}

function insertUser(repositories, id, name) {
  repositories.users.insert({
    id,
    email_normalized: `${name.toLowerCase()}@example.test`,
    email_display: `${name.toLowerCase()}@example.test`,
    display_name: name,
    display_name_normalized: name.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
}

function insertMembership(repositories, id, userId, permissionCategory) {
  repositories.league_memberships.insert({
    id,
    league_id: IDS.league,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: NOW_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
}

function insertTeam(repositories, id, name) {
  repositories.teams.insert({
    id,
    league_id: IDS.league,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
}

function insertAssignment(repositories, {
  id,
  teamId,
  userId,
  membershipId,
}) {
  repositories.team_manager_assignments.insert({
    id,
    league_id: IDS.league,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: IDS.commissioner,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: NOW_MS - 1_000,
    accepted_at_ms: NOW_MS - 1_000,
    ended_at_ms: null,
    version: 1,
  });
}

function createPersistenceRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-02-bids-"));
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
    migrations,
    applicationBuildId: "m5-02-bids",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  const { repositories } = context;
  insertUser(repositories, IDS.user, "ManagerA");
  insertUser(repositories, IDS.managerB, "ManagerB");
  insertUser(repositories, IDS.commissioner, "Commissioner");
  insertUser(repositories, IDS.member, "Member");
  repositories.leagues.insert({
    id: IDS.league,
    name: "League",
    name_normalized: "league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
  repositories.seasons.insert({
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: Date.parse("2026-07-01T07:00:00.000Z"),
    regular_season_ends_at_ms: Date.parse("2027-04-01T07:00:00.000Z"),
    fantasy_playoffs_start_at_ms: Date.parse("2027-03-01T08:00:00.000Z"),
    fantasy_playoffs_end_at_ms: Date.parse("2027-04-01T07:00:00.000Z"),
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
    free_agent_draft_completed_at_ms: Date.parse("2026-07-01T08:00:00.000Z"),
  });
  insertTeam(repositories, IDS.team, "Alpha");
  insertTeam(repositories, IDS.teamB, "Bravo");
  insertTeam(repositories, IDS.teamC, "Charlie");
  insertMembership(repositories, IDS.membership, IDS.user, "manager");
  insertMembership(repositories, IDS.membershipB, IDS.managerB, "manager");
  insertMembership(
    repositories,
    IDS.commissionerMembership,
    IDS.commissioner,
    "commissioner"
  );
  insertMembership(repositories, IDS.memberMembership, IDS.member, "member");
  repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: IDS.commissionerMembership,
      current_season_id: IDS.season,
      updated_at_ms: NOW_MS,
    },
  });
  insertAssignment(repositories, {
    id: IDS.assignmentA,
    teamId: IDS.team,
    userId: IDS.user,
    membershipId: IDS.membership,
  });
  insertAssignment(repositories, {
    id: IDS.assignmentB,
    teamId: IDS.teamB,
    userId: IDS.managerB,
    membershipId: IDS.membershipB,
  });
  repositories.players.insert({
    id: IDS.player,
    first_name: "Test",
    last_name: "Player",
    full_name: "Test Player",
    birth_date: null,
    status: "active",
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
  repositories.player_source_state.insert({
    id: IDS.source,
    player_id: IDS.player,
    provider: "test",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "TST",
    active: 1,
    source_version: "one",
    source_payload_json: null,
    effective_at_ms: NOW_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 1_000,
  });
  const auctionRepository = createSqliteAuctionRepository({
    database: connection.database,
  });
  auctionRepository.startAuction({
    auctionId: IDS.auction,
    bidId: IDS.openingBid,
    eventId: IDS.openingEvent,
    idempotencyRequestId: IDS.openingIdempotency,
    leagueId: IDS.league,
    seasonId: IDS.season,
    teamId: IDS.team,
    playerId: IDS.player,
    actorUserId: IDS.user,
    actorMembershipId: IDS.membership,
    actorAuthority: "manager",
    totalValueCents: 1_000,
    termYears: 3,
    idempotencyKey: "m5-02-open",
    occurredAtMs: NOW_MS,
    idempotencyExpiresAtMs: NOW_MS + 86_400_000,
  });
  return {
    database: connection.database,
    repositories,
    repository: createSqliteAuctionBidRepository({ database: connection.database }),
  };
}

function persistenceCommand(overrides = {}) {
  const occurredAtMs = overrides.occurredAtMs ?? NOW_MS + 1;
  return {
    auctionId: IDS.auction,
    bidId: uuid(100),
    eventId: uuid(101),
    idempotencyRequestId: uuid(102),
    leagueId: IDS.league,
    teamId: IDS.teamB,
    actorUserId: IDS.managerB,
    actorMembershipId: IDS.membershipB,
    actorAuthority: "manager",
    totalValueCents: 600,
    termYears: 3,
    expectedBidVersion: null,
    idempotencyKey: "m5-02-bravo-join",
    occurredAtMs,
    idempotencyExpiresAtMs: occurredAtMs + 86_400_000,
    ...overrides,
  };
}

describe("M5-02 auction bid policy", () => {
  test("enforces joining minimums, term precision, and rounded AAV", () => {
    assert.deepEqual(validateBidOffer(150, 1, { joining: true }), {
      totalValueCents: 150,
      termYears: 1,
      aavCents: 150,
    });
    assert.deepEqual(validateBidOffer(500, 3, { joining: true }), {
      totalValueCents: 500,
      termYears: 3,
      aavCents: 167,
    });
    for (const [totalValueCents, termYears] of [
      [149, 1],
      [200, 2],
      [400, 3],
      [550, 3],
    ]) {
      assertPolicyError(
        () => validateBidOffer(totalValueCents, termYears, { joining: true }),
        AUCTION_BID_CODES.valueInvalid
      );
    }
  });

  test("accepts a join before but not at close and initializes durable counters", () => {
    assert.deepEqual(
      assertAuctionBidState({
        command: command(),
        authority: authority(),
        auction: auction(),
        existingBid: null,
      }),
      {
        action: "submitted",
        totalValueCents: 600,
        termYears: 3,
        aavCents: 200,
        lowestOfferedAavCents: 200,
        firstSubmittedAtMs: NOW_MS,
        lastEditedAtMs: NOW_MS,
        editCount: 0,
        nextVersion: 1,
      }
    );
    assertPolicyError(
      () =>
        assertAuctionBidState({
          command: command(),
          authority: authority(),
          auction: auction({ resolves_at_ms: NOW_MS }),
          existingBid: null,
        }),
      AUCTION_BID_CODES.windowClosed
    );
  });

  test("allows manager edits exactly at cooldown and preserves the lowest AAV", () => {
    const result = assertAuctionBidState({
      command: command({
        expectedBidVersion: 1,
        totalValueCents: 300,
        termYears: 3,
      }),
      authority: authority(),
      auction: auction(),
      existingBid: existingBid(),
    });
    assert.equal(result.editCount, 1);
    assert.equal(result.nextVersion, 2);
    assert.equal(result.firstSubmittedAtMs, NOW_MS - COOLDOWN_MS);
    assert.equal(result.lowestOfferedAavCents, 100);

    assertPolicyError(
      () =>
        assertAuctionBidState({
          command: command({
            expectedBidVersion: 1,
            occurredAtMs: NOW_MS - 1,
          }),
          authority: authority(),
          auction: auction(),
          existingBid: existingBid(),
        }),
      AUCTION_BID_CODES.cooldownActive
    );
  });

  test("gives the starter two edits, every later bidder one, and rejects stale versions", () => {
    assert.doesNotThrow(() =>
      assertAuctionBidState({
        command: command({ expectedBidVersion: 2 }),
        authority: authority(),
        auction: auction(),
        existingBid: existingBid({ edit_count: 1, version: 2 }),
      })
    );
    assertPolicyError(
      () =>
        assertAuctionBidState({
          command: command({ expectedBidVersion: 3 }),
          authority: authority(),
          auction: auction(),
          existingBid: existingBid({ edit_count: 2, version: 3 }),
        }),
      AUCTION_BID_CODES.editLimitReached
    );
    assertPolicyError(
      () =>
        assertAuctionBidState({
          command: command({ expectedBidVersion: 2 }),
          authority: authority(),
          auction: auction(),
          existingBid: existingBid({
            first_submitted_at_ms: NOW_MS - COOLDOWN_MS - 1,
            edit_count: 1,
            version: 2,
          }),
        }),
      AUCTION_BID_CODES.editLimitReached
    );
    assertPolicyError(
      () =>
        assertAuctionBidState({
          command: command({ expectedBidVersion: 9 }),
          authority: authority(),
          auction: auction(),
          existingBid: existingBid(),
        }),
      AUCTION_BID_CODES.versionConflict
    );
  });

  test("lets the current commissioner bypass cooldown and manager edit consumption", () => {
    const result = assertAuctionBidState({
      command: command({
        actorAuthority: "commissioner",
        expectedBidVersion: 4,
        occurredAtMs: NOW_MS,
      }),
      authority: authority({
        league_status: "frozen",
        membership_permission: "commissioner",
        assignment_status: null,
        assignment_ended_at_ms: null,
        team_id: null,
        commissioner_membership_id: IDS.membership,
      }),
      auction: auction(),
      existingBid: existingBid({
        last_edited_at_ms: NOW_MS,
        edit_count: 2,
        version: 4,
      }),
    });
    assert.equal(result.editCount, 2);
    assert.equal(result.nextVersion, 5);
  });
});

describe("M5-02 atomic sealed-bid persistence", () => {
  test("joins once, replays the same request, and rejects changed key reuse", (t) => {
    const runtime = createPersistenceRuntime(t);
    const submitted = runtime.repository.putBid(persistenceCommand());
    assert.equal(submitted.replayed, false);
    assert.equal(submitted.action, "submitted");
    assert.equal(submitted.bid.id, uuid(100));
    assert.equal(submitted.bid.aavCents, 200);

    const replayed = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(103),
        eventId: uuid(104),
        idempotencyRequestId: uuid(105),
        occurredAtMs: NOW_MS + 10,
        idempotencyExpiresAtMs: NOW_MS + 86_400_010,
      })
    );
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.action, "submitted");
    assert.equal(replayed.bid.id, submitted.bid.id);
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({ totalValueCents: 700 })
        ),
      AUCTION_BID_CODES.idempotencyConflict
    );
    assert.equal(semanticHash(runtime.database), before);
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM auction_bids")
        .get().count,
      2
    );
  });

  test("edits the stable bid atomically and preserves its first time and lowest AAV", (t) => {
    const runtime = createPersistenceRuntime(t);
    runtime.repository.putBid(persistenceCommand());
    const editedAtMs = NOW_MS + 1 + COOLDOWN_MS;
    const edited = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(110),
        eventId: uuid(111),
        idempotencyRequestId: uuid(112),
        idempotencyKey: "m5-02-bravo-edit",
        totalValueCents: 300,
        expectedBidVersion: 1,
        occurredAtMs: editedAtMs,
        idempotencyExpiresAtMs: editedAtMs + 86_400_000,
      })
    );
    assert.equal(edited.action, "edited");
    assert.equal(edited.bid.id, uuid(100));
    assert.equal(edited.bid.firstSubmittedAtMs, NOW_MS + 1);
    assert.equal(edited.bid.lastEditedAtMs, editedAtMs);
    assert.equal(edited.bid.editCount, 1);
    assert.equal(edited.bid.version, 2);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT total_value_cents, term_years, lowest_offered_aav_cents,
          first_submitted_at_ms, last_edited_at_ms, edit_count, version
        FROM auction_bids WHERE id = ?
      `).get(uuid(100)),
      {
        total_value_cents: 300,
        term_years: 3,
        lowest_offered_aav_cents: 100,
        first_submitted_at_ms: NOW_MS + 1,
        last_edited_at_ms: editedAtMs,
        edit_count: 1,
        version: 2,
      }
    );
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({
            bidId: uuid(113),
            eventId: uuid(114),
            idempotencyRequestId: uuid(115),
            idempotencyKey: "m5-02-bravo-second-edit",
            expectedBidVersion: 2,
            occurredAtMs: editedAtMs + COOLDOWN_MS,
            idempotencyExpiresAtMs: editedAtMs + COOLDOWN_MS + 86_400_000,
          })
        ),
      AUCTION_BID_CODES.editLimitReached
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("allows exactly two manager edits on the starter bid", (t) => {
    const runtime = createPersistenceRuntime(t);
    for (const [index, occurredAtMs] of [
      [1, NOW_MS + COOLDOWN_MS],
      [2, NOW_MS + 2 * COOLDOWN_MS],
    ]) {
      const result = runtime.repository.putBid(
        persistenceCommand({
          bidId: uuid(120 + index),
          eventId: uuid(123 + index),
          idempotencyRequestId: uuid(126 + index),
          teamId: IDS.team,
          actorUserId: IDS.user,
          actorMembershipId: IDS.membership,
          totalValueCents: 900 - index * 100,
          expectedBidVersion: index,
          idempotencyKey: `m5-02-alpha-edit-${index}`,
          occurredAtMs,
          idempotencyExpiresAtMs: occurredAtMs + 86_400_000,
        })
      );
      assert.equal(result.bid.editCount, index);
      assert.equal(result.bid.version, index + 1);
      assert.equal(result.bid.id, IDS.openingBid);
    }
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({
            bidId: uuid(130),
            eventId: uuid(131),
            idempotencyRequestId: uuid(132),
            teamId: IDS.team,
            actorUserId: IDS.user,
            actorMembershipId: IDS.membership,
            expectedBidVersion: 3,
            idempotencyKey: "m5-02-alpha-third-edit",
            occurredAtMs: NOW_MS + 3 * COOLDOWN_MS,
            idempotencyExpiresAtMs: NOW_MS + 3 * COOLDOWN_MS + 86_400_000,
          })
        ),
      AUCTION_BID_CODES.editLimitReached
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("lets the commissioner submit and replace blindly without manager edit use", (t) => {
    const runtime = createPersistenceRuntime(t);
    runtime.repository.putBid(persistenceCommand());
    runtime.repositories.leagues.updateVersioned({
      key: IDS.league,
      expectedVersion: 2,
      changes: { status: "frozen", updated_at_ms: NOW_MS + 1 },
    });
    const replaced = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(100),
        eventId: uuid(140),
        idempotencyRequestId: uuid(141),
        actorUserId: IDS.commissioner,
        actorMembershipId: IDS.commissionerMembership,
        actorAuthority: "commissioner",
        totalValueCents: 500,
        expectedBidVersion: 1,
        idempotencyKey: "m5-02-commissioner-replace",
      })
    );
    assert.equal(replaced.bid.editCount, 0);
    assert.equal(replaced.bid.version, 2);

    const submitted = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(142),
        eventId: uuid(143),
        idempotencyRequestId: uuid(144),
        teamId: IDS.teamC,
        actorUserId: IDS.commissioner,
        actorMembershipId: IDS.commissionerMembership,
        actorAuthority: "commissioner",
        totalValueCents: 500,
        expectedBidVersion: null,
        idempotencyKey: "m5-02-commissioner-submit",
      })
    );
    assert.equal(submitted.action, "submitted");
    assert.equal(submitted.bid.teamId, IDS.teamC);
    assert.equal(submitted.bid.editCount, 0);
  });

  test("shows only the current manager's own values and keeps reads write-free", (t) => {
    const runtime = createPersistenceRuntime(t);
    runtime.repository.putBid(persistenceCommand());
    const before = semanticHash(runtime.database);
    const managerA = runtime.repository.listActive({
      leagueId: IDS.league,
      viewerUserId: IDS.user,
      viewerMembershipId: IDS.membership,
    });
    const managerB = runtime.repository.readActive({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      viewerUserId: IDS.managerB,
      viewerMembershipId: IDS.membershipB,
    });
    const commissioner = runtime.repository.readActive({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      viewerUserId: IDS.commissioner,
      viewerMembershipId: IDS.commissionerMembership,
    });
    const member = runtime.repository.readActive({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      viewerUserId: IDS.member,
      viewerMembershipId: IDS.memberMembership,
    });
    assert.equal(managerA.length, 1);
    assert.equal(managerA[0].participantCount, 2);
    assert.equal(managerA[0].ownBid.teamId, IDS.team);
    assert.equal(managerA[0].ownBid.totalValueCents, 1_000);
    assert.equal(managerA[0].ownBid.remainingManagerEdits, 2);
    assert.equal(
      managerA[0].ownBid.cooldownEndsAtMs,
      managerA[0].ownBid.lastEditedAtMs + 75 * 60 * 1000
    );
    assert.equal(managerB.ownBid.teamId, IDS.teamB);
    assert.equal(managerB.ownBid.totalValueCents, 600);
    assert.equal(managerB.ownBid.remainingManagerEdits, 1);
    assert.equal(commissioner.ownBid, null);
    assert.equal(member.ownBid, null);
    for (const projection of [commissioner, member]) {
      assert.deepEqual(
        Object.keys(projection.participants[0]).sort(),
        ["teamId", "teamName"]
      );
    }
    assert.equal(semanticHash(runtime.database), before);
  });

  test("rolls back a late event collision and rejects the exact close boundary", (t) => {
    const runtime = createPersistenceRuntime(t);
    const beforeCollision = semanticHash(runtime.database);
    assert.throws(() =>
      runtime.repository.putBid(
        persistenceCommand({ eventId: IDS.openingEvent })
      )
    );
    assert.equal(semanticHash(runtime.database), beforeCollision);

    const closeMs = runtime.database
      .prepare("SELECT resolves_at_ms FROM auctions WHERE id = ?")
      .get(IDS.auction).resolves_at_ms;
    const beforeClose = semanticHash(runtime.database);
    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({
            bidId: uuid(150),
            eventId: uuid(151),
            idempotencyRequestId: uuid(152),
            idempotencyKey: "m5-02-at-close",
            occurredAtMs: closeMs,
            idempotencyExpiresAtMs: closeMs + 86_400_000,
          })
        ),
      AUCTION_BID_CODES.windowClosed
    );
    assert.equal(semanticHash(runtime.database), beforeClose);
  });
});

describe("M5-02 lowest-offered AAV migration", () => {
  test("preserves a pre-0010 bid and derives its rounded historical floor", (t) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-02-migration-"));
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
      migrations: migrations.slice(0, 9),
      applicationBuildId: "m5-02-before",
      now: () => NOW_MS,
    });
    const repositories = createHistoricalRepositories(connection.database);
    repositories.users.insert({
      id: IDS.user,
      email_normalized: "manager@example.test",
      email_display: "manager@example.test",
      display_name: "Manager",
      display_name_normalized: "manager",
      status: "active",
      created_at_ms: NOW_MS - 1,
      updated_at_ms: NOW_MS - 1,
      version: 1,
    });
    repositories.leagues.insert({
      id: IDS.league,
      name: "League",
      name_normalized: "league",
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS - 1,
      updated_at_ms: NOW_MS - 1,
      version: 1,
    });
    repositories.seasons.insert({
      id: IDS.season,
      league_id: IDS.league,
      label: "2026-27",
      nhl_season_key: "20262027",
      status: "active",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: NOW_MS - 1,
      updated_at_ms: NOW_MS - 1,
      version: 1,
      free_agent_draft_completed_at_ms: null,
    });
    repositories.teams.insert({
      id: IDS.team,
      league_id: IDS.league,
      name: "Team",
      name_normalized: "team",
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: NOW_MS - 1,
      updated_at_ms: NOW_MS - 1,
      version: 1,
    });
    repositories.players.insert({
      id: IDS.player,
      first_name: "Test",
      last_name: "Player",
      full_name: "Test Player",
      birth_date: null,
      status: "active",
      created_at_ms: NOW_MS - 1,
      updated_at_ms: NOW_MS - 1,
      version: 1,
    });
    repositories.auctions.insert({
      id: IDS.auction,
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.player,
      status: "open",
      opened_at_ms: NOW_MS - 1,
      resolves_at_ms: NOW_MS + 1,
      opened_by_user_id: IDS.user,
      created_at_ms: NOW_MS - 1,
      updated_at_ms: NOW_MS - 1,
      version: 1,
    });
    repositories.auction_bids.insert({
      id: IDS.bid,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.auction,
      team_id: IDS.team,
      submitted_by_user_id: IDS.user,
      total_value_cents: 1_000,
      term_years: 3,
      first_submitted_at_ms: NOW_MS - 1,
      last_edited_at_ms: NOW_MS - 1,
      edit_count: 0,
      status: "active",
      idempotency_request_id: null,
      version: 1,
    });

    applyMigrations({
      database: connection.database,
      migrations: migrations.slice(0, 10),
      applicationBuildId: "m5-02-after",
      now: () => NOW_MS + 1,
    });

    assert.deepEqual(
      connection.database.prepare(`
        SELECT id, total_value_cents, term_years,
          lowest_offered_aav_cents, version
        FROM auction_bids
      `).get(),
      {
        id: IDS.bid,
        total_value_cents: 1_000,
        term_years: 3,
        lowest_offered_aav_cents: 333,
        version: 1,
      }
    );
    assert.equal(connection.database.pragma("user_version", { simple: true }), 10);
    assert.equal(connection.database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(connection.database.pragma("foreign_key_check"), []);
  });
});
