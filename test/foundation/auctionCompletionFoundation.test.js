const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  AUCTION_COMPLETION_CODES,
  AuctionCompletionPolicyError,
  planAuctionContractSeasons,
} = require(
  "../../src/domain/auctions/auctionCompletionPolicy"
);
const {
  buildAuctionResolutionOccurrenceKey,
} = require("../../src/domain/auctions/auctionResolutionPolicy");
const {
  createAuctionResolutionService,
} = require("../../src/application/services/auctions/createAuctionResolutionService");
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
  createSqliteAuctionResolutionRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const OPEN_MS = Date.parse("2026-07-21T19:00:00.000Z");
const NOW_MS = Date.parse("2026-07-26T23:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  current: uuid(2),
  future1: uuid(3),
  future2: uuid(4),
  generated1: uuid(5),
  generated2: uuid(6),
});

const PERSISTED = Object.freeze({
  league: uuid(1_000),
  season: uuid(1_001),
  teamA: uuid(1_002),
  teamB: uuid(1_003),
  player: uuid(1_004),
  userA: uuid(1_005),
  userB: uuid(1_006),
  membershipA: uuid(1_007),
  membershipB: uuid(1_008),
  assignmentA: uuid(1_009),
  assignmentB: uuid(1_010),
  auction: uuid(1_011),
  bidA: uuid(1_012),
  bidB: uuid(1_013),
  eventA: uuid(1_014),
  eventB: uuid(1_015),
  source: uuid(1_016),
  existingOwnership: uuid(1_017),
  blockingOutbox: uuid(1_018),
});

function season(id, label, status = "planned") {
  return {
    id,
    label,
    nhlSeasonKey: `${label}${Number(label) + 1}`,
    status,
  };
}

function input(overrides = {}) {
  const currentSeason = season(IDS.current, "2026", "active");
  return {
    leagueId: IDS.league,
    currentSeason,
    existingSeasons: [currentSeason],
    futureSeasonIds: [IDS.generated1, IDS.generated2],
    termYears: 3,
    nowMs: 1_000,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) =>
    error instanceof AuctionCompletionPolicyError &&
    error.code === AUCTION_COMPLETION_CODES.inputInvalid &&
    error.reasonCode === reasonCode
  );
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
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(rows))
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
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
}

function insertTeam(repositories, id, name) {
  repositories.teams.insert({
    id,
    league_id: PERSISTED.league,
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

function insertMembership(repositories, id, userId) {
  repositories.league_memberships.insert({
    id,
    league_id: PERSISTED.league,
    user_id: userId,
    permission_category: "manager",
    status: "active",
    joined_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
}

function insertAssignment(
  repositories,
  id,
  teamId,
  userId,
  membershipId
) {
  repositories.team_manager_assignments.insert({
    id,
    league_id: PERSISTED.league,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: PERSISTED.userA,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: OPEN_MS - 1_000,
    accepted_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    version: 1,
  });
}

function insertPlayer(repositories, id, name, sourceId) {
  repositories.players.insert({
    id,
    first_name: name,
    last_name: "Player",
    full_name: `${name} Player`,
    birth_date: null,
    status: "active",
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
  repositories.player_source_state.insert({
    id: sourceId,
    player_id: id,
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
}

function createPersistenceRuntime(
  t,
  {
    includeBidA = true,
    includeBidB = true,
    bidA = {},
    bidB = {},
    corruptBidAAuthority = false,
    playoffsStartAtMs = NOW_MS + 86_400_000,
    resolvesAtMs = NOW_MS,
    salaryCapCents = 10_000,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m5-04-completion-")
  );
  const databasePath = path.join(temporaryRoot, "league.sqlite3");
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m5-04-completion",
    now: () => OPEN_MS,
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  const { repositories } = context;
  insertUser(repositories, PERSISTED.userA, "ManagerA");
  insertUser(repositories, PERSISTED.userB, "ManagerB");
  repositories.leagues.insert({
    id: PERSISTED.league,
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
  repositories.league_settings.insert({
    league_id: PERSISTED.league,
    salary_cap_cents: salaryCapCents,
    trade_deadline_at_ms: null,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
  repositories.seasons.insert({
    id: PERSISTED.season,
    league_id: PERSISTED.league,
    label: "2026",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: OPEN_MS - 86_400_000,
    regular_season_ends_at_ms: NOW_MS + 200_000_000,
    fantasy_playoffs_start_at_ms: playoffsStartAtMs,
    fantasy_playoffs_end_at_ms: playoffsStartAtMs + 86_400_000,
    free_agent_draft_completed_at_ms: OPEN_MS - 1,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: PERSISTED.league,
    expectedVersion: 1,
    changes: {
      current_season_id: PERSISTED.season,
      updated_at_ms: OPEN_MS,
    },
  });
  insertTeam(repositories, PERSISTED.teamA, "Alpha");
  insertTeam(repositories, PERSISTED.teamB, "Bravo");
  insertMembership(
    repositories,
    PERSISTED.membershipA,
    PERSISTED.userA
  );
  insertMembership(
    repositories,
    PERSISTED.membershipB,
    PERSISTED.userB
  );
  insertAssignment(
    repositories,
    PERSISTED.assignmentA,
    PERSISTED.teamA,
    PERSISTED.userA,
    PERSISTED.membershipA
  );
  insertAssignment(
    repositories,
    PERSISTED.assignmentB,
    PERSISTED.teamB,
    PERSISTED.userB,
    PERSISTED.membershipB
  );
  insertPlayer(
    repositories,
    PERSISTED.player,
    "Target",
    PERSISTED.source
  );
  repositories.auctions.insert({
    id: PERSISTED.auction,
    league_id: PERSISTED.league,
    season_id: PERSISTED.season,
    player_id: PERSISTED.player,
    status: "open",
    opened_at_ms: OPEN_MS,
    resolves_at_ms: resolvesAtMs,
    opened_by_user_id: PERSISTED.userA,
    created_at_ms: OPEN_MS,
    updated_at_ms: OPEN_MS,
    version: 1,
  });

  function insertBid({
    id,
    teamId,
    userId,
    membershipId,
    eventId,
    eventType,
    occurredAtMs,
    totalValueCents,
    termYears,
    lowestOfferedAavCents,
    corruptAuthority,
  }) {
    repositories.auction_bids.insert({
      id,
      league_id: PERSISTED.league,
      season_id: PERSISTED.season,
      auction_id: PERSISTED.auction,
      team_id: teamId,
      submitted_by_user_id: userId,
      total_value_cents: totalValueCents,
      term_years: termYears,
      lowest_offered_aav_cents: lowestOfferedAavCents,
      first_submitted_at_ms: occurredAtMs,
      last_edited_at_ms: occurredAtMs,
      edit_count: 0,
      status: "active",
      idempotency_request_id: null,
      version: 1,
    });
    const aavCents = Math.floor(totalValueCents / termYears) +
      ((totalValueCents % termYears) * 2 >= termYears ? 1 : 0);
    const values = {
      totalValueCents,
      termYears,
      aavCents,
      lowestOfferedAavCents,
      editCount: 0,
      version: 1,
    };
    repositories.auction_events.insert({
      id: eventId,
      league_id: PERSISTED.league,
      season_id: PERSISTED.season,
      auction_id: PERSISTED.auction,
      bid_id: id,
      team_id: teamId,
      actor_user_id: userId,
      event_type: eventType,
      metadata_json: JSON.stringify({
        actorMembershipId: corruptAuthority ? uuid(9_999) : membershipId,
        actorAuthority: "manager",
        ...(eventType === "auction_started" ? values : { before: null, after: values }),
      }),
      occurred_at_ms: occurredAtMs,
    });
  }

  if (includeBidA) {
    insertBid({
      id: PERSISTED.bidA,
      teamId: PERSISTED.teamA,
      userId: PERSISTED.userA,
      membershipId: PERSISTED.membershipA,
      eventId: PERSISTED.eventA,
      eventType: "auction_started",
      occurredAtMs: OPEN_MS,
      totalValueCents: 1_000,
      termYears: 3,
      lowestOfferedAavCents: 100,
      corruptAuthority: corruptBidAAuthority,
      ...bidA,
    });
  }
  if (includeBidB) {
    insertBid({
      id: PERSISTED.bidB,
      teamId: PERSISTED.teamB,
      userId: PERSISTED.userB,
      membershipId: PERSISTED.membershipB,
      eventId: PERSISTED.eventB,
      eventType: "bid_submitted",
      occurredAtMs: OPEN_MS + 1,
      totalValueCents: 500,
      termYears: 2,
      lowestOfferedAavCents: 250,
      corruptAuthority: false,
      ...bidB,
    });
  }
  const repository = createSqliteAuctionResolutionRepository({
    database: connection.database,
  });
  let nextId = 10_000;
  const secureRandom = { id: () => uuid(nextId++) };
  return {
    connection,
    database: connection.database,
    databasePath,
    repositories,
    repository,
    secureRandom,
    service: createAuctionResolutionService({ repository, secureRandom }),
  };
}

function occurrenceKey(dueAtMs = NOW_MS) {
  return buildAuctionResolutionOccurrenceKey({
    auctionId: PERSISTED.auction,
    dueAtMs,
  });
}

function resolve(service, overrides = {}) {
  return service.resolveDue({
    leagueId: PERSISTED.league,
    auctionId: PERSISTED.auction,
    occurrenceKey: occurrenceKey(),
    expectedAuctionVersion: 1,
    nowMs: NOW_MS,
    ...overrides,
  });
}

function directCompletion(overrides = {}) {
  return {
    leagueId: PERSISTED.league,
    auctionId: PERSISTED.auction,
    occurrenceKey: occurrenceKey(),
    expectedAuctionVersion: 1,
    nowMs: NOW_MS,
    resolutionId: uuid(20_000),
    contractId: uuid(20_001),
    contractYearIds: [uuid(20_002), uuid(20_003), uuid(20_004)],
    contractEventId: uuid(20_005),
    ownershipId: uuid(20_006),
    ownershipEventId: uuid(20_007),
    auctionEventId: uuid(20_008),
    activityId: uuid(20_009),
    outboxEventId: uuid(20_010),
    futureSeasonIds: [uuid(20_011), uuid(20_012)],
    ...overrides,
  };
}

describe("M5-04 auction contract-season planning", () => {
  test("creates only the missing planned seasons required by the term", () => {
    const plan = planAuctionContractSeasons(input());

    assert.deepEqual(plan.seasonIds, [
      IDS.current,
      IDS.generated1,
      IDS.generated2,
    ]);
    assert.deepEqual(plan.seasonsToCreate, [
      {
        id: IDS.generated1,
        leagueId: IDS.league,
        label: "2027",
        nhlSeasonKey: "20272028",
        status: "planned",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
      {
        id: IDS.generated2,
        leagueId: IDS.league,
        label: "2028",
        nhlSeasonKey: "20282029",
        status: "planned",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ]);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.seasonsToCreate[0]), true);
  });

  test("reuses matching future seasons and never changes their lifecycle", () => {
    const current = season(IDS.current, "2026", "active");
    const future1 = season(IDS.future1, "2027", "planned");
    const future2 = season(IDS.future2, "2028", "active");
    const plan = planAuctionContractSeasons(input({
      currentSeason: current,
      existingSeasons: [current, future1, future2],
    }));

    assert.deepEqual(plan.seasonIds, [
      IDS.current,
      IDS.future1,
      IDS.future2,
    ]);
    assert.deepEqual(plan.seasonsToCreate, []);
  });

  test("a one-year term neither consumes nor creates a future season", () => {
    const plan = planAuctionContractSeasons(input({ termYears: 1 }));
    assert.deepEqual(plan.seasonIds, [IDS.current]);
    assert.deepEqual(plan.seasonsToCreate, []);
  });

  test("rejects mismatched current, completed future, and conflicting seasons", () => {
    const current = season(IDS.current, "2026", "active");
    for (const value of [
      input({ existingSeasons: [] }),
      input({
        existingSeasons: [
          current,
          season(IDS.future1, "2027", "completed"),
        ],
      }),
      input({
        existingSeasons: [
          current,
          season(IDS.future1, "2027"),
          season(IDS.future2, "2027"),
        ],
      }),
    ]) {
      assertPolicyError(
        () => planAuctionContractSeasons(value),
        AUCTION_COMPLETION_CODES.seasonConflict
      );
    }
  });

  test("rejects malformed terms, IDs, timestamps, and extra input", () => {
    const cases = [
      [input({ termYears: 4 }), AUCTION_COMPLETION_CODES.termInvalid],
      [input({ leagueId: "bad" }), AUCTION_COMPLETION_CODES.stableIdInvalid],
      [input({ nowMs: -1 }), AUCTION_COMPLETION_CODES.timestampInvalid],
      [
        { ...input(), unexpected: true },
        AUCTION_COMPLETION_CODES.inputInvalid,
      ],
    ];
    for (const [value, reasonCode] of cases) {
      assertPolicyError(
        () => planAuctionContractSeasons(value),
        reasonCode
      );
    }
  });
});

describe("M5-04 atomic SQLite auction completion", () => {
  test("commits one winner, contract schedule, ownership, activity, and metadata-only outbox", (t) => {
    const runtime = createPersistenceRuntime(t);
    const result = resolve(runtime.service);

    assert.deepEqual(
      {
        completed: result.completed,
        replayed: result.replayed,
        status: result.status,
        outcomeCode: result.outcomeCode,
        generalIllegal: result.generalIllegal,
      },
      {
        completed: true,
        replayed: false,
        status: "resolved",
        outcomeCode: "winner",
        generalIllegal: false,
      }
    );
    const auction = runtime.database
      .prepare("SELECT status, version FROM auctions WHERE id = ?")
      .get(PERSISTED.auction);
    assert.deepEqual(auction, { status: "resolved", version: 2 });
    assert.deepEqual(
      runtime.database
        .prepare("SELECT id, status, version FROM auction_bids ORDER BY id")
        .all(),
      [
        { id: PERSISTED.bidA, status: "won", version: 2 },
        { id: PERSISTED.bidB, status: "lost", version: 2 },
      ]
    );
    const resolution = runtime.database
      .prepare("SELECT * FROM auction_resolutions")
      .get();
    assert.equal(resolution.winning_bid_id, PERSISTED.bidA);
    assert.equal(resolution.highest_bid_cents, 1_000);
    assert.equal(resolution.second_price_input_cents, 250);
    assert.equal(resolution.final_contract_value_cents, 800);
    assert.equal(resolution.winning_term_years, 3);
    assert.equal(resolution.final_aav_cents, 267);
    const contract = runtime.database.prepare("SELECT * FROM contracts").get();
    assert.equal(contract.original_total_value_cents, 800);
    assert.equal(contract.original_term_years, 3);
    assert.equal(contract.aav_cents, 267);
    assert.equal(
      contract.auction_buyout_lock_expires_at_ms,
      NOW_MS + 14 * 24 * 60 * 60 * 1_000
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT year_number, aav_cents, status
          FROM contract_years ORDER BY year_number
        `)
        .all(),
      [
        { year_number: 1, aav_cents: 267, status: "current" },
        { year_number: 2, aav_cents: 267, status: "future" },
        { year_number: 3, aav_cents: 267, status: "future" },
      ]
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT label, nhl_season_key, status,
            regular_season_starts_at_ms, fantasy_playoffs_start_at_ms
          FROM seasons ORDER BY label
        `)
        .all()
        .slice(1),
      [
        {
          label: "2027",
          nhl_season_key: "20272028",
          status: "planned",
          regular_season_starts_at_ms: null,
          fantasy_playoffs_start_at_ms: null,
        },
        {
          label: "2028",
          nhl_season_key: "20282029",
          status: "planned",
          regular_season_starts_at_ms: null,
          fantasy_playoffs_start_at_ms: null,
        },
      ]
    );
    assert.equal(
      runtime.database.prepare("SELECT current_season_id FROM leagues").get()
        .current_season_id,
      PERSISTED.season
    );
    const ownership = runtime.database
      .prepare("SELECT * FROM player_ownerships")
      .get();
    assert.equal(ownership.team_id, PERSISTED.teamA);
    assert.equal(ownership.roster_category, "Active");
    assert.equal(ownership.position_group, "F");
    assert.equal(ownership.slot_number, 1);
    assert.equal(ownership.acquired_transaction_type, "auction_resolution");
    const activity = runtime.database.prepare("SELECT * FROM league_activity").get();
    const activityMetadata = JSON.parse(activity.metadata_json);
    assert.equal(activity.actor_authority, "system");
    assert.equal(activityMetadata.playerDisplayName, "Target Player");
    assert.equal(activityMetadata.finalTotalValueCents, 800);
    assert.equal(activityMetadata.bidHistory.length, 2);
    assert.equal(activityMetadata.rankedBids.length, 2);
    const outbox = runtime.database.prepare("SELECT * FROM outbox_events").get();
    const payload = JSON.parse(outbox.payload_json);
    assert.deepEqual(payload, {
      kind: "invalidation",
      eventType: "auction.updated",
      scope: "league",
      scopeId: PERSISTED.league,
      version: 2,
      changedAtMs: NOW_MS,
    });
    assert.equal(/bid|value|term/i.test(outbox.payload_json), false);
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);

    const after = semanticHash(runtime.database);
    const restartedRepository = createSqliteAuctionResolutionRepository({
      database: runtime.database,
    });
    const replay = createAuctionResolutionService({
      repository: restartedRepository,
      secureRandom: runtime.secureRandom,
    }).resolveDue({
      leagueId: PERSISTED.league,
      auctionId: PERSISTED.auction,
      occurrenceKey: occurrenceKey(),
      expectedAuctionVersion: 1,
      nowMs: NOW_MS,
    });
    assert.equal(replay.completed, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.resolutionId, result.resolutionId);
    assert.equal(semanticHash(runtime.database), after);
  });

  test("preserves tied anti-bluff pricing at the winning current AAV", (t) => {
    const runtime = createPersistenceRuntime(t, {
      bidA: {
        totalValueCents: 333,
        termYears: 1,
        lowestOfferedAavCents: 100,
      },
      bidB: {
        totalValueCents: 333,
        termYears: 1,
        lowestOfferedAavCents: 333,
      },
    });

    resolve(runtime.service);
    const resolution = runtime.database
      .prepare(`
        SELECT winning_bid_id, second_price_input_cents,
          final_contract_value_cents, final_aav_cents
        FROM auction_resolutions
      `)
      .get();
    assert.deepEqual(resolution, {
      winning_bid_id: PERSISTED.bidA,
      second_price_input_cents: 333,
      final_contract_value_cents: 333,
      final_aav_cents: 333,
    });
  });

  test("persists no-winner outcomes without signing side effects and hides skipped invalid details from activity", (t) => {
    const empty = createPersistenceRuntime(t, {
      includeBidA: false,
      includeBidB: false,
    });
    const emptyResult = resolve(empty.service);
    assert.equal(emptyResult.status, "no_winner");
    assert.equal(
      empty.database.prepare("SELECT status FROM auctions").get().status,
      "no_winner"
    );
    for (const table of ["contracts", "player_ownerships"]) {
      assert.equal(
        empty.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
          .count,
        0
      );
    }
    assert.equal(
      empty.database.prepare("SELECT COUNT(*) AS count FROM outbox_events").get()
        .count,
      1
    );

    const invalid = createPersistenceRuntime(t, {
      includeBidB: false,
      corruptBidAAuthority: true,
    });
    const invalidResult = resolve(invalid.service);
    assert.equal(invalidResult.status, "no_winner");
    assert.equal(
      invalid.database.prepare("SELECT status FROM auction_bids").get().status,
      "invalid"
    );
    assert.equal(
      invalid.database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count,
      1
    );
    const activityMetadata = JSON.parse(
      invalid.database
        .prepare("SELECT metadata_json FROM league_activity")
        .get().metadata_json
    );
    assert.equal(activityMetadata.outcome, "no_winner");
    assert.equal(Object.hasOwn(activityMetadata, "skippedBids"), false);
    const history = JSON.parse(
      invalid.database
        .prepare(`
          SELECT metadata_json FROM auction_events
          WHERE event_type = 'auction_no_winner'
        `)
        .get().metadata_json
    );
    assert.equal(history.skippedBids.length, 1);
  });

  test("cancels an already-owned player and an auction open at playoff start", (t) => {
    const owned = createPersistenceRuntime(t);
    owned.repositories.player_ownerships.insert({
      id: PERSISTED.existingOwnership,
      league_id: PERSISTED.league,
      season_id: PERSISTED.season,
      player_id: PERSISTED.player,
      team_id: PERSISTED.teamB,
      ownership_kind: "Rostered",
      roster_category: "Active",
      position_group: "F",
      slot_number: 1,
      acquired_transaction_type: "migration",
      acquired_transaction_id: null,
      created_at_ms: NOW_MS - 1,
      updated_at_ms: NOW_MS - 1,
      version: 1,
    });
    const ownedResult = resolve(owned.service);
    assert.equal(ownedResult.status, "cancelled");
    assert.equal(ownedResult.outcomeCode, "player_unavailable");
    assert.equal(
      owned.database.prepare("SELECT COUNT(*) AS count FROM contracts").get()
        .count,
      0
    );
    assert.equal(
      owned.database
        .prepare("SELECT COUNT(*) AS count FROM player_ownerships")
        .get().count,
      1
    );
    assert.equal(
      owned.database
        .prepare("SELECT COUNT(*) AS count FROM league_activity")
        .get().count,
      1
    );
    assert.equal(
      owned.database
        .prepare("SELECT COUNT(*) AS count FROM auction_bids WHERE status = 'cancelled'")
        .get().count,
      2
    );

    const closed = createPersistenceRuntime(t, {
      playoffsStartAtMs: NOW_MS,
      resolvesAtMs: NOW_MS + 86_400_000,
    });
    const closedResult = resolve(closed.service);
    assert.equal(closedResult.status, "cancelled");
    assert.equal(closedResult.outcomeCode, "season_closed");
    assert.equal(
      closed.database.prepare("SELECT status FROM auctions").get().status,
      "cancelled"
    );
  });

  test("completes a cap-and-roster-illegal winner as explicitly unplaced", (t) => {
    const runtime = createPersistenceRuntime(t, { salaryCapCents: 100 });
    for (let slot = 1; slot <= 12; slot += 1) {
      const playerId = uuid(30_000 + slot);
      insertPlayer(
        runtime.repositories,
        playerId,
        `Existing${slot}`,
        uuid(31_000 + slot)
      );
      runtime.repositories.player_ownerships.insert({
        id: uuid(32_000 + slot),
        league_id: PERSISTED.league,
        season_id: PERSISTED.season,
        player_id: playerId,
        team_id: PERSISTED.teamA,
        ownership_kind: "Rostered",
        roster_category: "Active",
        position_group: "F",
        slot_number: slot,
        acquired_transaction_type: "migration",
        acquired_transaction_id: null,
        created_at_ms: OPEN_MS,
        updated_at_ms: OPEN_MS,
        version: 1,
      });
    }

    const result = resolve(runtime.service);
    assert.equal(result.status, "resolved");
    assert.equal(result.generalIllegal, true);
    assert.equal(
      result.warnings.some(
        ({ code }) => code === "ACTIVE_FORWARD_LIMIT_EXCEEDED"
      ),
      true
    );
    assert.equal(
      result.warnings.some(({ code }) => code === "TEAM_OVER_CAP"),
      true
    );
    const ownership = runtime.database
      .prepare("SELECT * FROM player_ownerships WHERE player_id = ?")
      .get(PERSISTED.player);
    assert.equal(ownership.roster_category, "Active");
    assert.equal(ownership.slot_number, null);
    assert.equal(ownership.acquired_transaction_type, "auction_resolution");
  });

  test("rejects stale and cross-league work and leaves before-deadline work unchanged", (t) => {
    const runtime = createPersistenceRuntime(t);
    const before = semanticHash(runtime.database);
    assert.throws(
      () => resolve(runtime.service, { expectedAuctionVersion: 2 }),
      ({ code }) => code === "REPOSITORY_VERSION_CONFLICT"
    );
    assert.throws(
      () => resolve(runtime.service, { leagueId: uuid(40_000) }),
      ({ code }) => code === "REPOSITORY_RECORD_NOT_FOUND"
    );
    assert.equal(semanticHash(runtime.database), before);

    const early = createPersistenceRuntime(t, {
      resolvesAtMs: NOW_MS + 1,
    });
    const earlyBefore = semanticHash(early.database);
    const earlyResult = resolve(early.service, {
      occurrenceKey: occurrenceKey(NOW_MS + 1),
    });
    assert.deepEqual(earlyResult, {
      completed: false,
      replayed: false,
      status: "not_due",
      reason: "before_deadline",
    });
    assert.equal(semanticHash(early.database), earlyBefore);
  });

  test("rolls every winner write back when the final outbox insert fails", (t) => {
    const runtime = createPersistenceRuntime(t);
    runtime.repositories.outbox_events.insert({
      id: PERSISTED.blockingOutbox,
      league_id: PERSISTED.league,
      event_type: "test.blocker",
      aggregate_type: "test",
      aggregate_id: "blocker",
      payload_json: "{}",
      status: "pending",
      attempt_count: 0,
      available_at_ms: NOW_MS,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    const before = semanticHash(runtime.database);

    assert.throws(
      () =>
        runtime.repository.completeDue(
          directCompletion({ outboxEventId: PERSISTED.blockingOutbox })
        ),
      ({ code }) => code === "REPOSITORY_CONSTRAINT"
    );
    assert.equal(semanticHash(runtime.database), before);
    assert.equal(
      runtime.database.prepare("SELECT status FROM auctions").get().status,
      "open"
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM auction_resolutions")
        .get().count,
      0
    );
  });
});
