const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  AUCTION_RESOLUTION_CODES,
  buildAuctionResolutionOccurrenceKey,
  evaluateAuctionResolution,
  smallestValidTotalCents,
} = require("../../src/domain/auctions/auctionResolutionPolicy");
const {
  createAuctionResolutionDecisionService,
} = require("../../src/application/services/auctions/createAuctionResolutionDecisionService");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
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
const {
  createSqliteAuctionResolutionRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository");

const NOW_MS = Date.parse("2026-07-26T23:00:00.000Z");
const OPEN_MS = Date.parse("2026-07-21T19:00:00.000Z");
const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  auction: uuid(2),
  player: uuid(3),
  teamA: uuid(4),
  teamB: uuid(5),
  teamC: uuid(6),
  bidA: uuid(10),
  bidB: uuid(11),
  bidC: uuid(12),
  managerA: uuid(20),
  managerB: uuid(21),
  commissioner: uuid(22),
  membershipA: uuid(23),
  membershipB: uuid(24),
  commissionerMembership: uuid(25),
  assignmentA: uuid(26),
  assignmentB: uuid(27),
  season: uuid(28),
  source: uuid(29),
  openingEvent: uuid(30),
  openingRequest: uuid(31),
  joiningEvent: uuid(32),
  joiningRequest: uuid(33),
  ownership: uuid(34),
  run: uuid(40),
  retryRun: uuid(41),
  restartRun: uuid(42),
  expiredRun: uuid(43),
  expiredRetryRun: uuid(44),
});

function auction(overrides = {}) {
  return {
    id: IDS.auction,
    leagueId: IDS.league,
    playerId: IDS.player,
    status: "open",
    resolvesAtMs: NOW_MS,
    playoffsStartAtMs: NOW_MS + 86_400_000,
    playerOwned: false,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function bid(overrides = {}) {
  return {
    id: IDS.bidA,
    leagueId: IDS.league,
    auctionId: IDS.auction,
    teamId: IDS.teamA,
    status: "active",
    teamStatus: "active",
    totalValueCents: 1_000,
    termYears: 3,
    lowestOfferedAavCents: 100,
    firstSubmittedAtMs: NOW_MS - 10_000,
    isStartingBid: true,
    authorityValid: true,
    ...overrides,
  };
}

function semanticHash(database) {
  const rows = database
    .prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => ({
      name,
      rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    }));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function insertUser(repositories, id, name) {
  repositories.users.insert({
    id,
    email_normalized: `${name.toLowerCase()}@example.test`,
    email_display: `${name.toLowerCase()}@example.test`,
    display_name: name,
    display_name_normalized: name.toLowerCase(),
    status: "active",
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
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
    joined_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
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
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
}

function insertAssignment(repositories, id, teamId, userId, membershipId) {
  repositories.team_manager_assignments.insert({
    id,
    league_id: IDS.league,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: IDS.commissioner,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: OPEN_MS - 1_000,
    accepted_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    version: 1,
  });
}

function createPersistenceRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m5-03-resolution-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m5-03-resolution",
    now: () => OPEN_MS,
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  const { repositories } = context;
  insertUser(repositories, IDS.managerA, "ManagerA");
  insertUser(repositories, IDS.managerB, "ManagerB");
  insertUser(repositories, IDS.commissioner, "Commissioner");
  repositories.leagues.insert({
    id: IDS.league,
    name: "League",
    name_normalized: "league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
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
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
    free_agent_draft_completed_at_ms: Date.parse("2026-07-01T08:00:00.000Z"),
  });
  insertTeam(repositories, IDS.teamA, "Alpha");
  insertTeam(repositories, IDS.teamB, "Bravo");
  insertMembership(repositories, IDS.membershipA, IDS.managerA, "manager");
  insertMembership(repositories, IDS.membershipB, IDS.managerB, "manager");
  insertMembership(
    repositories,
    IDS.commissionerMembership,
    IDS.commissioner,
    "commissioner"
  );
  repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: IDS.commissionerMembership,
      current_season_id: IDS.season,
      updated_at_ms: OPEN_MS,
    },
  });
  insertAssignment(
    repositories,
    IDS.assignmentA,
    IDS.teamA,
    IDS.managerA,
    IDS.membershipA
  );
  insertAssignment(
    repositories,
    IDS.assignmentB,
    IDS.teamB,
    IDS.managerB,
    IDS.membershipB
  );
  repositories.players.insert({
    id: IDS.player,
    first_name: "Test",
    last_name: "Player",
    full_name: "Test Player",
    birth_date: null,
    status: "active",
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
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
    effective_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: OPEN_MS - 1_000,
  });
  createSqliteAuctionRepository({ database: connection.database }).startAuction({
    auctionId: IDS.auction,
    bidId: IDS.bidA,
    eventId: IDS.openingEvent,
    idempotencyRequestId: IDS.openingRequest,
    leagueId: IDS.league,
    seasonId: IDS.season,
    teamId: IDS.teamA,
    playerId: IDS.player,
    actorUserId: IDS.managerA,
    actorMembershipId: IDS.membershipA,
    actorAuthority: "manager",
    totalValueCents: 1_000,
    termYears: 3,
    idempotencyKey: "m5-03-open",
    occurredAtMs: OPEN_MS,
    idempotencyExpiresAtMs: OPEN_MS + 86_400_000,
  });
  createSqliteAuctionBidRepository({ database: connection.database }).putBid({
    auctionId: IDS.auction,
    bidId: IDS.bidB,
    eventId: IDS.joiningEvent,
    idempotencyRequestId: IDS.joiningRequest,
    leagueId: IDS.league,
    teamId: IDS.teamB,
    actorUserId: IDS.managerB,
    actorMembershipId: IDS.membershipB,
    actorAuthority: "manager",
    totalValueCents: 500,
    termYears: 2,
    expectedBidVersion: null,
    idempotencyKey: "m5-03-join",
    occurredAtMs: OPEN_MS + 1,
    idempotencyExpiresAtMs: OPEN_MS + 86_400_001,
  });
  const repository = createSqliteAuctionResolutionRepository({
    database: connection.database,
  });
  return {
    database: connection.database,
    repositories,
    repository,
    service: createAuctionResolutionDecisionService({ repository }),
  };
}

describe("M5-03 deterministic auction resolution policy", () => {
  test("finds the smallest valid total that reaches a rounded AAV", () => {
    assert.equal(smallestValidTotalCents(167, 3), 500);
    assert.equal(smallestValidTotalCents(168, 3), 600);
    assert.equal(smallestValidTotalCents(150, 2), 300);
    assert.equal(smallestValidTotalCents(175, 1), 175);
  });

  test("ranks by AAV, shorter term, first time, then stable bid ID", () => {
    const result = evaluateAuctionResolution({
      auction: auction(),
      bids: [
        bid({
          id: IDS.bidC,
          teamId: IDS.teamC,
          totalValueCents: 200,
          termYears: 1,
          lowestOfferedAavCents: 200,
          firstSubmittedAtMs: NOW_MS - 20_000,
        }),
        bid({
          id: IDS.bidB,
          teamId: IDS.teamB,
          totalValueCents: 400,
          termYears: 2,
          lowestOfferedAavCents: 200,
          firstSubmittedAtMs: NOW_MS - 30_000,
        }),
        bid({
          id: IDS.bidA,
          totalValueCents: 200,
          termYears: 1,
          lowestOfferedAavCents: 200,
          firstSubmittedAtMs: NOW_MS - 20_000,
        }),
      ],
    });
    assert.equal(result.outcome, "winner");
    assert.deepEqual(
      result.rankedBids.map(({ bidId }) => bidId),
      [IDS.bidA, IDS.bidC, IDS.bidB]
    );
    assert.equal(result.winner.requiredWinningAavCents, 200);
    assert.equal(result.winner.finalTotalValueCents, 200);
  });

  test("uses the current offer for one bidder and anti-bluff pricing for competition", () => {
    const single = evaluateAuctionResolution({
      auction: auction(),
      bids: [bid()],
    });
    assert.equal(single.winner.finalTotalValueCents, 1_000);
    assert.equal(single.winner.requiredWinningAavCents, 333);

    const competing = evaluateAuctionResolution({
      auction: auction(),
      bids: [
        bid(),
        bid({
          id: IDS.bidB,
          teamId: IDS.teamB,
          totalValueCents: 500,
          termYears: 2,
          lowestOfferedAavCents: 250,
        }),
      ],
    });
    assert.equal(competing.winner.highestCompetingAavCents, 250);
    assert.equal(competing.winner.requiredWinningAavCents, 250);
    assert.equal(competing.winner.finalTotalValueCents, 800);
    assert.equal(competing.winner.finalAavCents, 267);
  });

  test("returns explicit before-deadline, playoff, ownership, and no-winner outcomes", () => {
    assert.equal(
      evaluateAuctionResolution({
        auction: auction({ nowMs: NOW_MS - 1 }),
        bids: [],
      }).outcome,
      "not_due"
    );
    assert.equal(
      evaluateAuctionResolution({
        auction: auction({ playoffsStartAtMs: NOW_MS }),
        bids: [bid()],
      }).outcome,
      "cancelled_season_closed"
    );
    assert.equal(
      evaluateAuctionResolution({
        auction: auction({ playerOwned: true }),
        bids: [bid()],
      }).outcome,
      "cancelled_unavailable"
    );
    assert.equal(
      evaluateAuctionResolution({ auction: auction(), bids: [] }).outcome,
      "no_winner"
    );
  });

  test("skips invalid authority, value, scope, and duplicate-team bids", () => {
    const result = evaluateAuctionResolution({
      auction: auction(),
      bids: [
        bid({ authorityValid: false }),
        bid({
          id: IDS.bidB,
          teamId: IDS.teamB,
          totalValueCents: 550,
          termYears: 3,
        }),
        bid({
          id: IDS.bidC,
          teamId: IDS.teamC,
          leagueId: uuid(99),
        }),
      ],
    });
    assert.equal(result.outcome, "no_winner");
    assert.deepEqual(
      new Set(result.skippedBids.map(({ reasonCode }) => reasonCode)),
      new Set([
        AUCTION_RESOLUTION_CODES.authorityInvalid,
        AUCTION_RESOLUTION_CODES.valueInvalid,
        AUCTION_RESOLUTION_CODES.bidScopeInvalid,
      ])
    );

    const duplicate = evaluateAuctionResolution({
      auction: auction(),
      bids: [
        bid(),
        bid({ id: IDS.bidB }),
      ],
    });
    assert.equal(duplicate.outcome, "no_winner");
    assert.equal(duplicate.skippedBids.length, 2);
    assert.equal(
      duplicate.skippedBids.every(
        ({ reasonCode }) => reasonCode === AUCTION_RESOLUTION_CODES.bidDuplicate
      ),
      true
    );

    const belowJoiningMinimum = evaluateAuctionResolution({
      auction: auction(),
      bids: [
        bid({
          id: IDS.bidB,
          teamId: IDS.teamB,
          totalValueCents: 200,
          termYears: 2,
          lowestOfferedAavCents: 100,
          isStartingBid: false,
        }),
      ],
    });
    assert.equal(belowJoiningMinimum.outcome, "no_winner");
    assert.deepEqual(belowJoiningMinimum.skippedBids, [
      {
        bidId: IDS.bidB,
        reasonCode: AUCTION_RESOLUTION_CODES.valueInvalid,
      },
    ]);

    const malformedTimestamp = evaluateAuctionResolution({
      auction: auction(),
      bids: [bid({ firstSubmittedAtMs: -1 })],
    });
    assert.equal(malformedTimestamp.outcome, "no_winner");
    assert.deepEqual(malformedTimestamp.skippedBids, [
      {
        bidId: IDS.bidA,
        reasonCode: AUCTION_RESOLUTION_CODES.bidInvalid,
      },
    ]);
  });

  test("builds one stable auction-and-due occurrence identity", () => {
    assert.equal(
      buildAuctionResolutionOccurrenceKey({
        auctionId: IDS.auction,
        dueAtMs: NOW_MS,
      }),
      `auction:${IDS.auction}:${NOW_MS}`
    );
  });
});

describe("M5-03 read-only SQLite auction resolution candidates", () => {
  test("lists only due work and decides the deterministic winner without writes", (t) => {
    const { database, repository, service } = createPersistenceRuntime(t);
    const before = semanticHash(database);

    assert.deepEqual(repository.listDue({ nowMs: NOW_MS - 1, limit: 10 }), []);
    assert.deepEqual(repository.listDue({ nowMs: NOW_MS, limit: 10 }), [
      {
        auctionId: IDS.auction,
        leagueId: IDS.league,
        seasonId: IDS.season,
        auctionVersion: 1,
        resolvesAtMs: NOW_MS,
        playoffsStartAtMs: Date.parse("2027-03-01T08:00:00.000Z"),
        dueAtMs: NOW_MS,
      },
    ]);

    const candidate = repository.loadCandidate({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      nowMs: NOW_MS,
    });
    assert.deepEqual(
      candidate.bids.map(({ id, isStartingBid, authorityValid }) => ({
        id,
        isStartingBid,
        authorityValid,
      })),
      [
        { id: IDS.bidA, isStartingBid: true, authorityValid: true },
        { id: IDS.bidB, isStartingBid: false, authorityValid: true },
      ]
    );
    const result = service.decideDue({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      nowMs: NOW_MS,
    });
    assert.equal(result.auctionVersion, 1);
    assert.equal(result.seasonId, IDS.season);
    assert.equal(result.decision.outcome, "winner");
    assert.equal(result.decision.winner.bidId, IDS.bidA);
    assert.equal(result.decision.winner.finalTotalValueCents, 1_000);
    assert.equal(
      repository.loadCandidate({
        leagueId: uuid(99),
        auctionId: IDS.auction,
        nowMs: NOW_MS,
      }),
      null
    );
    assert.equal(semanticHash(database), before);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM auction_resolutions").get()
        .count,
      0
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM job_runs").get().count,
      0
    );
  });

  test("uses historical submission authority after later manager departure", (t) => {
    const { database, repository } = createPersistenceRuntime(t);
    database
      .prepare(`
        UPDATE team_manager_assignments
        SET status = 'ended', ended_at_ms = @endedAtMs, version = version + 1
        WHERE id = @id
      `)
      .run({ id: IDS.assignmentB, endedAtMs: OPEN_MS + 2 });
    database
      .prepare(`
        UPDATE league_memberships
        SET status = 'ended', ended_at_ms = @endedAtMs,
          updated_at_ms = @endedAtMs, version = version + 1
        WHERE id = @id
      `)
      .run({ id: IDS.membershipB, endedAtMs: OPEN_MS + 2 });
    const before = semanticHash(database);

    const candidate = repository.loadCandidate({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      nowMs: NOW_MS,
    });
    assert.equal(
      candidate.bids.find(({ id }) => id === IDS.bidB).authorityValid,
      true
    );
    assert.equal(semanticHash(database), before);
  });

  test("skips a bid whose durable authority evidence is corrupt", (t) => {
    const { database, repository, service } = createPersistenceRuntime(t);
    database
      .prepare("UPDATE auction_events SET metadata_json = '{}' WHERE id = ?")
      .run(IDS.joiningEvent);
    const before = semanticHash(database);

    const candidate = repository.loadCandidate({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      nowMs: NOW_MS,
    });
    assert.equal(
      candidate.bids.find(({ id }) => id === IDS.bidB).authorityValid,
      false
    );
    const decision = service.decideDue({
      leagueId: IDS.league,
      auctionId: IDS.auction,
      nowMs: NOW_MS,
    }).decision;
    assert.equal(decision.outcome, "winner");
    assert.equal(decision.winner.bidId, IDS.bidA);
    assert.equal(decision.winner.finalTotalValueCents, 1_000);
    assert.deepEqual(decision.skippedBids, [
      {
        bidId: IDS.bidB,
        reasonCode: AUCTION_RESOLUTION_CODES.authorityInvalid,
      },
    ]);
    assert.equal(semanticHash(database), before);
  });

  test("returns an unavailable decision when ownership already exists", (t) => {
    const { database, repositories, service } = createPersistenceRuntime(t);
    repositories.player_ownerships.insert({
      id: IDS.ownership,
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.player,
      team_id: IDS.teamA,
      ownership_kind: "Rostered",
      roster_category: "Active",
      position_group: "F",
      slot_number: 1,
      acquired_transaction_type: "test",
      acquired_transaction_id: null,
      created_at_ms: OPEN_MS + 2,
      updated_at_ms: OPEN_MS + 2,
      version: 1,
    });
    const before = semanticHash(database);

    assert.equal(
      service.decideDue({
        leagueId: IDS.league,
        auctionId: IDS.auction,
        nowMs: NOW_MS,
      }).decision.outcome,
      "cancelled_unavailable"
    );
    assert.equal(semanticHash(database), before);
  });
});

describe("M5-03 durable auction resolution job-run leases", () => {
  test("leases, rejects overlap, retries failure, and survives restart success", (t) => {
    const { database, repository } = createPersistenceRuntime(t);
    const occurrenceKey = buildAuctionResolutionOccurrenceKey({
      auctionId: IDS.auction,
      dueAtMs: NOW_MS,
    });
    const command = {
      jobRunId: IDS.run,
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey,
      scheduledForMs: NOW_MS,
      leaseOwner: "m5-03-worker-a",
      nowMs: NOW_MS,
      leaseExpiresAtMs: NOW_MS + 1_000,
    };

    assert.deepEqual(repository.claimRun(command), {
      acquired: true,
      runId: IDS.run,
      version: 1,
      attemptCount: 1,
    });
    assert.deepEqual(
      repository.claimRun({
        ...command,
        jobRunId: IDS.retryRun,
        leaseOwner: "m5-03-worker-b",
        nowMs: NOW_MS + 1,
        leaseExpiresAtMs: NOW_MS + 1_001,
      }),
      {
        acquired: false,
        reason: "leased",
        runId: IDS.run,
        version: 1,
        attemptCount: 1,
      }
    );
    assert.deepEqual(
      repository.failRun({
        leagueId: IDS.league,
        runId: IDS.run,
        leaseOwner: "m5-03-worker-a",
        expectedVersion: 1,
        completedAtMs: NOW_MS + 2,
        errorCode: "AUCTION_RESOLUTION_INCOMPLETE",
      }),
      { runId: IDS.run, status: "failed", version: 2 }
    );
    const retry = repository.claimRun({
      ...command,
      jobRunId: IDS.retryRun,
      leaseOwner: "m5-03-worker-b",
      nowMs: NOW_MS + 3,
      leaseExpiresAtMs: NOW_MS + 1_003,
    });
    assert.deepEqual(retry, {
      acquired: true,
      runId: IDS.run,
      version: 3,
      attemptCount: 2,
    });
    assert.deepEqual(
      repository.succeedRun({
        leagueId: IDS.league,
        runId: retry.runId,
        leaseOwner: "m5-03-worker-b",
        expectedVersion: retry.version,
        completedAtMs: NOW_MS + 4,
        auctionId: IDS.auction,
        outcome: "resolved",
      }),
      { runId: IDS.run, status: "succeeded", version: 4 }
    );
    const restartedRepository = createSqliteAuctionResolutionRepository({
      database,
    });
    assert.deepEqual(
      restartedRepository.claimRun({
        ...command,
        jobRunId: IDS.restartRun,
        leaseOwner: "m5-03-worker-c",
        nowMs: NOW_MS + 5,
        leaseExpiresAtMs: NOW_MS + 1_005,
      }),
      {
        acquired: false,
        reason: "succeeded",
        runId: IDS.run,
        version: 4,
        attemptCount: 2,
      }
    );
    const stored = database
      .prepare("SELECT * FROM job_runs WHERE id = ?")
      .get(IDS.run);
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.attempt_count, 2);
    assert.equal(stored.last_error_code, null);
    assert.deepEqual(JSON.parse(stored.result_json), {
      auctionId: IDS.auction,
      outcome: "resolved",
    });
    assert.equal(
      database.prepare("SELECT status FROM auctions WHERE id = ?").get(IDS.auction)
        .status,
      "open"
    );
    assert.deepEqual(
      database
        .prepare("SELECT status FROM auction_bids ORDER BY id")
        .all()
        .map(({ status }) => status),
      ["active", "active"]
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM auction_resolutions").get()
        .count,
      0
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM contracts").get().count,
      0
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM player_ownerships").get()
        .count,
      0
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM outbox_events").get().count,
      0
    );
  });

  test("reclaims an expired lease without creating a duplicate occurrence", (t) => {
    const { database, repository } = createPersistenceRuntime(t);
    const occurrenceKey = `expired:${IDS.auction}:${NOW_MS}`;
    const first = repository.claimRun({
      jobRunId: IDS.expiredRun,
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey,
      scheduledForMs: NOW_MS,
      leaseOwner: "m5-03-worker-a",
      nowMs: NOW_MS,
      leaseExpiresAtMs: NOW_MS + 10,
    });
    const retry = repository.claimRun({
      jobRunId: IDS.expiredRetryRun,
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey,
      scheduledForMs: NOW_MS,
      leaseOwner: "m5-03-worker-b",
      nowMs: NOW_MS + 10,
      leaseExpiresAtMs: NOW_MS + 20,
    });

    assert.deepEqual(first, {
      acquired: true,
      runId: IDS.expiredRun,
      version: 1,
      attemptCount: 1,
    });
    assert.deepEqual(retry, {
      acquired: true,
      runId: IDS.expiredRun,
      version: 2,
      attemptCount: 2,
    });
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM job_runs WHERE occurrence_key = ?"
        )
        .get(occurrenceKey).count,
      1
    );
  });
});
