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
  fad: uuid(25),
  rollover: uuid(26),
  allocation: uuid(27),
  participant: uuid(28),
  draw: uuid(29),
});

function command(overrides = {}) {
  const normalizedOverrides = { ...overrides };
  delete normalizedOverrides.bindingIllegalityConfirmed;
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedOverrides,
      "totalValueCents"
    )
  ) {
    const termYears = normalizedOverrides.termYears ?? 3;
    normalizedOverrides.aavCents =
      Math.round(
        normalizedOverrides.totalValueCents /
          termYears /
          25
      ) * 25;
    delete normalizedOverrides.totalValueCents;
  }
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
    aavCents: 200,
    termYears: 3,
    expectedBidVersion: null,
    idempotencyKey: "m5-02-bid-one",
    occurredAtMs: NOW_MS,
    idempotencyExpiresAtMs: NOW_MS + 86_400_000,
    ...normalizedOverrides,
  });
}

function authority(overrides = {}) {
  return {
    league_status: "active",
    user_status: "active",
    membership_status: "active",
    membership_permission: "manager",
    membership_joined_at_ms: NOW_MS - 1_000,
    membership_ended_at_ms: null,
    assignment_status: "accepted",
    assignment_accepted_at_ms: NOW_MS - 1_000,
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
    lowest_offered_total_value_cents: 600,
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

function expectedRequestHash(value) {
  const payload = {
    leagueId: value.leagueId,
    auctionId: value.auctionId,
    teamId: value.teamId,
    actorUserId: value.actorUserId,
    actorMembershipId: value.actorMembershipId,
    actorAuthority: value.actorAuthority,
    aavCents: value.aavCents,
    termYears: value.termYears,
    expectedBidVersion: value.expectedBidVersion,
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function replaceAuctionContextForIsolationTest(
  database,
  sourceKind
) {
  database.exec(`
    DROP TRIGGER auction_contexts_immutable_update;
    DROP TRIGGER auction_contexts_immutable_delete;
    PRAGMA ignore_check_constraints = ON;
  `);
  if (sourceKind === null) {
    database
      .prepare(
        "DELETE FROM auction_contexts WHERE auction_id = ?"
      )
      .run(IDS.auction);
    return;
  }
  database
    .prepare(`
      UPDATE auction_contexts
      SET source_kind = ?
      WHERE auction_id = ?
    `)
    .run(sourceKind, IDS.auction);
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
    aavCents: 350,
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

function configureFadBidRuntime(
  runtime,
  {
    kind,
    minimumTotalValueCents = 300,
    minimumTermYears = 3,
    minimumAavCents = 100,
  }
) {
  const { database } = runtime;
  const allocationLinked = ["restricted", "fallback"].includes(
    kind
  );
  const queued = kind === "queued";
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  database.pragma("foreign_keys = OFF");
  database.pragma("ignore_check_constraints = ON");
  try {
    for (const trigger of triggers) {
      database.exec(
        `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
      );
    }
    if (allocationLinked) {
      database.prepare(
        "DELETE FROM auction_events WHERE auction_id = ?"
      ).run(IDS.auction);
      database.prepare(
        "DELETE FROM auction_bids WHERE auction_id = ?"
      ).run(IDS.auction);
      database.prepare(
        "DELETE FROM idempotency_requests WHERE id = ?"
      ).run(IDS.openingIdempotency);
    }
    database.prepare(`
      UPDATE auction_contexts
      SET source_kind = @sourceKind,
        fad_id = @fadId,
        fad_rollover_id = @rolloverId,
        fad_allocation_id = @allocationId,
        fad_origin = @fadOrigin
      WHERE auction_id = @auctionId
    `).run({
      auctionId: IDS.auction,
      sourceKind:
        kind === "restricted" ? "fad_restricted" : "fad_open_rapid",
      fadId: IDS.fad,
      rolloverId: IDS.rollover,
      allocationId: allocationLinked ? IDS.allocation : null,
      fadOrigin:
        kind === "restricted"
          ? "candidate_tie_restricted"
          : kind === "fallback"
            ? "restricted_no_improvement_fallback"
            : kind === "queued"
              ? "queued_nomination"
              : "manager_nomination",
    });
    if (allocationLinked) {
      database.prepare(`
        INSERT INTO free_agent_draft_player_allocations (
          id, league_id, season_id, fad_id, player_id, status,
          decision_code, restricted_auction_id,
          fallback_open_auction_id,
          restricted_minimum_total_cents,
          restricted_minimum_term_years,
          restricted_minimum_aav_cents,
          created_at_ms, updated_at_ms, version
        ) VALUES (
          @id, @leagueId, @seasonId, @fadId, @playerId, @status,
          @decisionCode, @restrictedAuctionId,
          @fallbackAuctionId,
          @minimumTotalValueCents,
          @minimumTermYears,
          @minimumAavCents,
          @nowMs, @nowMs, 1
        )
      `).run({
        id: IDS.allocation,
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        playerId: IDS.player,
        status:
          kind === "restricted"
            ? "restricted_active"
            : "restricted_fallback_open",
        decisionCode:
          kind === "restricted"
            ? "exact_total_and_term_tie"
            : "restricted_no_improvement_fallback",
        restrictedAuctionId:
          kind === "restricted" ? IDS.auction : uuid(290),
        fallbackAuctionId:
          kind === "fallback" ? IDS.auction : null,
        minimumTotalValueCents,
        minimumTermYears,
        minimumAavCents,
        nowMs: NOW_MS,
      });
    }
    if (kind === "restricted") {
      database.prepare(`
        INSERT INTO free_agent_draft_auction_participants (
          id, league_id, season_id, fad_id, allocation_id,
          auction_id, team_id, status,
          source_snapshot_entry_id,
          originating_candidate_revision_id,
          minimum_total_value_cents,
          minimum_term_years,
          minimum_aav_cents,
          active_improvement_bid_id,
          manager_edit_limit, cooldown_duration_ms,
          first_improvement_at_ms,
          current_cooldown_anchor_at_ms,
          improvement_committed_at_ms,
          originating_actor_user_id,
          originating_actor_membership_id,
          originating_actor_authority,
          created_at_ms, updated_at_ms, version
        ) VALUES (
          @id, @leagueId, @seasonId, @fadId, @allocationId,
          @auctionId, @teamId, 'active',
          @snapshotEntryId, @revisionId,
          @minimumTotalValueCents, @minimumTermYears,
          @minimumAavCents, NULL, 1, @cooldownMs,
          NULL, NULL, NULL,
          @actorUserId, @actorMembershipId, 'manager',
          @nowMs, @nowMs, 1
        )
      `).run({
        id: IDS.participant,
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        allocationId: IDS.allocation,
        auctionId: IDS.auction,
        teamId: IDS.teamB,
        snapshotEntryId: uuid(291),
        revisionId: uuid(292),
        minimumTotalValueCents,
        minimumTermYears,
        minimumAavCents,
        cooldownMs: COOLDOWN_MS,
        actorUserId: IDS.managerB,
        actorMembershipId: IDS.membershipB,
        nowMs: NOW_MS,
      });
    }
    if (queued) {
      const acceptedAtMs = NOW_MS - 1;
      database.prepare(`
        UPDATE auction_bids
        SET first_submitted_at_ms = @acceptedAtMs,
          last_edited_at_ms = @acceptedAtMs
        WHERE id = @bidId
      `).run({
        acceptedAtMs,
        bidId: IDS.openingBid,
      });
      database.prepare(`
        INSERT INTO free_agent_draft_nomination_queue (
          id, league_id, season_id, fad_id, team_id, player_id,
          source_rollover_id, target_opening_rollover_id,
          resolution_rollover_id, opening_total_value_cents,
          opening_term_years, opening_aav_cents,
          binding_illegality_confirmed, binding_confirmed_at_ms,
          submitted_by_user_id, submitted_by_membership_id,
          accepted_at_ms, candidate_card_version_observed,
          team_version_observed, status, opened_auction_id,
          opened_starter_bid_id, opened_at_ms, terminal_at_ms,
          validation_code, created_at_ms, updated_at_ms, version,
          acceptance_idempotency_request_id
        ) VALUES (
          @id, @leagueId, @seasonId, @fadId, @teamId, @playerId,
          @sourceRolloverId, @sourceRolloverId,
          @resolutionRolloverId, 1000, 3, 333,
          1, @acceptedAtMs, @actorUserId, @actorMembershipId,
          @acceptedAtMs, 1, 1, 'opened', @auctionId,
          @starterBidId, @openedAtMs, @openedAtMs,
          NULL, @acceptedAtMs, @openedAtMs, 2,
          @acceptanceRequestId
        )
      `).run({
        id: uuid(293),
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.team,
        playerId: IDS.player,
        sourceRolloverId: IDS.rollover,
        resolutionRolloverId: uuid(294),
        acceptedAtMs,
        actorUserId: IDS.user,
        actorMembershipId: IDS.membership,
        auctionId: IDS.auction,
        starterBidId: IDS.openingBid,
        openedAtMs: NOW_MS,
        acceptanceRequestId: IDS.openingIdempotency,
      });
    }
    database.prepare(`
      INSERT INTO free_agent_draft_draws (
        id, league_id, season_id, fad_id, allocation_id,
        auction_id, algorithm_version, nonce_bytes,
        commitment_hex, created_at_ms, updated_at_ms, version
      ) VALUES (
        @id, @leagueId, @seasonId, @fadId, @allocationId,
        @auctionId, 1, @nonceBytes,
        @commitmentHex, @nowMs, @nowMs, 1
      )
    `).run({
      id: IDS.draw,
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      allocationId: allocationLinked ? IDS.allocation : null,
      auctionId: IDS.auction,
      nonceBytes: Buffer.alloc(32, 41),
      commitmentHex: "a".repeat(64),
      nowMs: NOW_MS,
    });
  } finally {
    database.pragma("ignore_check_constraints = OFF");
    for (const trigger of triggers) database.exec(trigger.sql);
    database.pragma("foreign_keys = ON");
  }
  return runtime;
}

function persistenceCommand(overrides = {}) {
  const occurredAtMs = overrides.occurredAtMs ?? NOW_MS + 1;
  const normalizedOverrides = { ...overrides };
  delete normalizedOverrides.bindingIllegalityConfirmed;
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedOverrides,
      "totalValueCents"
    )
  ) {
    const termYears = normalizedOverrides.termYears ?? 3;
    normalizedOverrides.aavCents =
      Math.round(
        normalizedOverrides.totalValueCents /
          termYears /
          25
      ) * 25;
    delete normalizedOverrides.totalValueCents;
  }
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
    aavCents: 200,
    termYears: 3,
    expectedBidVersion: null,
    idempotencyKey: "m5-02-bravo-join",
    occurredAtMs,
    idempotencyExpiresAtMs: occurredAtMs + 86_400_000,
    ...normalizedOverrides,
  };
}

describe("M5-02 auction bid policy", () => {
  test("enforces joining minimums, term, and quarter-AAV precision", () => {
    assert.deepEqual(validateBidOffer(150, 1, { joining: true }), {
      totalValueCents: 150,
      termYears: 1,
      aavCents: 150,
    });
    assert.deepEqual(validateBidOffer(175, 3, { joining: true }), {
      totalValueCents: 525,
      termYears: 3,
      aavCents: 175,
    });
    for (const [aavCents, termYears] of [
      [149, 1],
      [125, 2],
      [125, 3],
      [160, 3],
    ]) {
      assertPolicyError(
        () => validateBidOffer(aavCents, termYears, { joining: true }),
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
        lowestOfferedTotalValueCents: 600,
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

  test("rejects a manager bid one millisecond before opening and accepts it at the exact opening instant", () => {
    const opensAtMs = NOW_MS + 60_000;
    assertPolicyError(
      () =>
        assertAuctionBidState({
          command: command({
            occurredAtMs: opensAtMs - 1,
            idempotencyExpiresAtMs:
              opensAtMs + 86_400_000,
          }),
          authority: authority(),
          auction: auction({
            opened_at_ms: opensAtMs,
          }),
          existingBid: null,
        }),
      AUCTION_BID_CODES.auctionUnavailable
    );

    const result = assertAuctionBidState({
      command: command({
        occurredAtMs: opensAtMs,
        idempotencyExpiresAtMs:
          opensAtMs + 86_400_000,
      }),
      authority: authority(),
      auction: auction({
        opened_at_ms: opensAtMs,
      }),
      existingBid: null,
    });
    assert.equal(result.action, "submitted");
    assert.equal(result.firstSubmittedAtMs, opensAtMs);
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

  test("binds direct and queued FAD starter edits to the unique start event rather than the opening timestamp", () => {
    const nominatedAuction = (overrides = {}) => ({
      ...auction(),
      source_kind: "fad_open_rapid",
      fad_origin: "manager_nomination",
      fad_allocation_id: null,
      fad_started_event_count: 1,
      fad_starter_bid_count: 1,
      fad_starter_bid_id: IDS.bid,
      fad_starter_team_id: IDS.team,
      queued_starter_count: 0,
      queued_starter_bid_id: null,
      queued_starter_team_id: null,
      ...overrides,
    });
    const confirmedEdit = command({
      expectedBidVersion: 2,
      bindingIllegalityConfirmed: true,
    });

    assert.equal(
      assertAuctionBidState({
        command: confirmedEdit,
        authority: authority(),
        auction: nominatedAuction(),
        existingBid: existingBid({
          edit_count: 1,
          version: 2,
        }),
      }).editCount,
      2
    );

    assertPolicyError(
      () => assertAuctionBidState({
        command: confirmedEdit,
        authority: authority(),
        auction: nominatedAuction({
          fad_starter_bid_id: IDS.openingBid,
          fad_starter_team_id: IDS.teamB,
        }),
        existingBid: existingBid({
          edit_count: 1,
          version: 2,
        }),
      }),
      AUCTION_BID_CODES.editLimitReached
    );

    assert.equal(
      assertAuctionBidState({
        command: confirmedEdit,
        authority: authority(),
        auction: nominatedAuction({
          fad_origin: "queued_nomination",
          queued_starter_count: 1,
          queued_starter_bid_id: IDS.bid,
          queued_starter_team_id: IDS.team,
        }),
        existingBid: existingBid({
          first_submitted_at_ms:
            NOW_MS - COOLDOWN_MS - 1,
          edit_count: 1,
          version: 2,
        }),
      }).editCount,
      2
    );

    assert.equal(
      assertAuctionBidState({
        command: command({ expectedBidVersion: 1 }),
        authority: authority(),
        auction: nominatedAuction(),
        existingBid: existingBid(),
      }).action,
      "edited"
    );
  });

  test("uses joining validation at the exact fallback opening instant before applying its equal floor", () => {
    const fallbackAuction = auction({
      id: IDS.auction,
      season_id: IDS.season,
      source_kind: "fad_open_rapid",
      fad_origin: "restricted_no_improvement_fallback",
      allocation_status: "restricted_fallback_open",
      fallback_open_auction_id: IDS.auction,
      restricted_minimum_total_cents: 300,
      restricted_minimum_aav_cents: 100,
      opened_at_ms: NOW_MS,
    });
    assertPolicyError(
      () => assertAuctionBidState({
        command: command({
          totalValueCents: 400,
          termYears: 3,
          bindingIllegalityConfirmed: true,
        }),
        authority: authority(),
        auction: fallbackAuction,
        existingBid: null,
      }),
      AUCTION_BID_CODES.valueInvalid
    );
    const joined = assertAuctionBidState({
      command: command({
        totalValueCents: 500,
        termYears: 3,
        bindingIllegalityConfirmed: true,
      }),
      authority: authority(),
      auction: fallbackAuction,
      existingBid: null,
    });
    assert.equal(joined.action, "submitted");
    assert.equal(joined.firstSubmittedAtMs, NOW_MS);
  });

  test("rejects commissioner authority from the manager bid policy", () => {
    assertPolicyError(
      () => command({ actorAuthority: "commissioner" }),
      AUCTION_BID_CODES.authorityInvalid
    );
  });

  test("rejects stale user, membership, and manager-assignment authority evidence", () => {
    for (const staleAuthority of [
      authority({ user_status: "disabled" }),
      authority({ membership_status: "suspended" }),
      authority({ membership_joined_at_ms: null }),
      authority({ membership_joined_at_ms: NOW_MS + 1 }),
      authority({ membership_ended_at_ms: NOW_MS + 1 }),
      authority({ assignment_status: "ended" }),
      authority({ assignment_accepted_at_ms: null }),
      authority({ assignment_accepted_at_ms: NOW_MS + 1 }),
      authority({ assignment_ended_at_ms: NOW_MS + 1 }),
    ]) {
      assertPolicyError(
        () =>
          assertAuctionBidState({
            command: command(),
            authority: staleAuthority,
            auction: auction(),
            existingBid: null,
          }),
        AUCTION_BID_CODES.authorizationDenied
      );
    }
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
    assert.equal(
      runtime.database.prepare(`
        SELECT request_hash
        FROM idempotency_requests
        WHERE id = ?
      `).get(uuid(102)).request_hash,
      expectedRequestHash(persistenceCommand())
    );

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
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT result_type, result_id
        FROM idempotency_requests
        WHERE id = ?
      `).get(uuid(102)),
      {
        result_type: "auction_bid",
        result_id: uuid(100),
      }
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM auction_administration_command_results
      `).get().count,
      0
    );
    const beforeConfirmedReuse = semanticHash(runtime.database);
    assert.equal(
      runtime.repository.putBid(
        persistenceCommand({
          bindingIllegalityConfirmed: true,
        })
      ).replayed,
      true
    );
    assert.equal(
      semanticHash(runtime.database),
      beforeConfirmedReuse
    );
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({ totalValueCents: 700 })
        ),
      AUCTION_BID_CODES.idempotencyKeyReused
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

  test("maps changed reuse of an in-progress idempotency key before its generic conflict and writes nothing", (t) => {
    const runtime = createPersistenceRuntime(t);
    runtime.database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key,
        request_hash, status, result_type, result_id,
        created_at_ms, completed_at_ms, expires_at_ms
      ) VALUES (
        ?, ?, ?, 'auction.bid.put', ?, ?, 'started',
        NULL, NULL, ?, NULL, ?
      )
    `).run(
      uuid(109),
      IDS.league,
      IDS.managerB,
      "changed-in-progress-key",
      "0".repeat(64),
      NOW_MS + 1,
      NOW_MS + 86_400_001
    );
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          idempotencyKey: "changed-in-progress-key",
        })
      ),
      AUCTION_BID_CODES.idempotencyKeyReused
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

  test("supports league-wide direct FAD bidding while event-binding the two-edit starter allowance", (t) => {
    const runtime = configureFadBidRuntime(
      createPersistenceRuntime(t),
      { kind: "manager" }
    );
    const starterCommand = (index) => {
      const occurredAtMs = NOW_MS + index * COOLDOWN_MS;
      return persistenceCommand({
        bidId: uuid(340 + index),
        eventId: uuid(343 + index),
        idempotencyRequestId: uuid(346 + index),
        teamId: IDS.team,
        actorUserId: IDS.user,
        actorMembershipId: IDS.membership,
        totalValueCents: 1_000 - index * 100,
        expectedBidVersion: index,
        idempotencyKey: `fad-direct-starter-edit-${index}`,
        occurredAtMs,
        idempotencyExpiresAtMs:
          occurredAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      });
    };
    for (const index of [1, 2]) {
      const edited = runtime.repository.putBid(
        starterCommand(index)
      );
      assert.equal(edited.bid.id, IDS.openingBid);
      assert.equal(edited.bid.editCount, index);
    }

    const beforeBelowJoiningMinimum = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          idempotencyKey: "fad-direct-below-joining-minimum",
          totalValueCents: 400,
          termYears: 3,
          occurredAtMs: NOW_MS,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.valueInvalid
    );
    assert.equal(
      semanticHash(runtime.database),
      beforeBelowJoiningMinimum
    );

    const joinCommand = persistenceCommand({
      totalValueCents: 500,
      termYears: 3,
      occurredAtMs: NOW_MS,
      bindingIllegalityConfirmed: true,
    });
    const joined = runtime.repository.putBid(joinCommand);
    assert.equal(joined.action, "submitted");
    assert.equal(joined.bid.firstSubmittedAtMs, NOW_MS);
    assert.equal(
      runtime.database.prepare(`
        SELECT request_hash
        FROM idempotency_requests
        WHERE id = ?
      `).get(uuid(102)).request_hash,
      expectedRequestHash(joinCommand, { fad: true })
    );

    const firstJoinerEditAtMs = NOW_MS + COOLDOWN_MS;
    const firstJoinerEdit = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(350),
        eventId: uuid(351),
        idempotencyRequestId: uuid(352),
        idempotencyKey: "fad-direct-joiner-edit",
        totalValueCents: 300,
        termYears: 3,
        expectedBidVersion: 1,
        occurredAtMs: firstJoinerEditAtMs,
        idempotencyExpiresAtMs:
          firstJoinerEditAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    );
    assert.equal(firstJoinerEdit.bid.editCount, 1);
    assert.equal(firstJoinerEdit.bid.aavCents, 100);

    const beforeSecondJoinerEdit = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          bidId: uuid(353),
          eventId: uuid(354),
          idempotencyRequestId: uuid(355),
          idempotencyKey: "fad-direct-joiner-second-edit",
          expectedBidVersion: 2,
          occurredAtMs:
            firstJoinerEditAtMs + COOLDOWN_MS,
          idempotencyExpiresAtMs:
            firstJoinerEditAtMs + COOLDOWN_MS + 86_400_000,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.editLimitReached
    );
    assert.equal(
      semanticHash(runtime.database),
      beforeSecondJoinerEdit
    );

    const replayed = runtime.repository.putBid({
      ...joinCommand,
      bidId: uuid(356),
      eventId: uuid(357),
      idempotencyRequestId: uuid(358),
      occurredAtMs: firstJoinerEditAtMs + 1,
      idempotencyExpiresAtMs:
        firstJoinerEditAtMs + 1 + 86_400_000,
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.bid.version, 1);
    assert.equal(replayed.bid.totalValueCents, 525);
  });

  test("gives the immutable queued FAD starter two edits despite its pre-opening submission time", (t) => {
    const runtime = configureFadBidRuntime(
      createPersistenceRuntime(t),
      { kind: "queued" }
    );
    const commands = [];
    for (const index of [1, 2]) {
      const occurredAtMs =
        NOW_MS - 1 + index * COOLDOWN_MS;
      const queuedEdit = persistenceCommand({
        bidId: uuid(360 + index),
        eventId: uuid(363 + index),
        idempotencyRequestId: uuid(366 + index),
        teamId: IDS.team,
        actorUserId: IDS.user,
        actorMembershipId: IDS.membership,
        totalValueCents: 1_000 - index * 100,
        expectedBidVersion: index,
        idempotencyKey: `fad-queued-starter-edit-${index}`,
        occurredAtMs,
        idempotencyExpiresAtMs:
          occurredAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      });
      commands.push(queuedEdit);
      const edited = runtime.repository.putBid(queuedEdit);
      assert.equal(edited.bid.id, IDS.openingBid);
      assert.equal(edited.bid.editCount, index);
      assert.equal(edited.bid.firstSubmittedAtMs, NOW_MS - 1);
    }
    const replayed = runtime.repository.putBid({
      ...commands[0],
      bidId: uuid(370),
      eventId: uuid(371),
      idempotencyRequestId: uuid(372),
      occurredAtMs: NOW_MS + 3 * COOLDOWN_MS,
      idempotencyExpiresAtMs:
        NOW_MS + 3 * COOLDOWN_MS + 86_400_000,
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.action, "edited");
    assert.equal(replayed.bid.version, 2);
    assert.equal(replayed.bid.editCount, 1);
    assert.equal(replayed.bid.firstSubmittedAtMs, NOW_MS - 1);
  });

  test("rejects commissioner authority before the manager bid repository writes", (t) => {
    const runtime = createPersistenceRuntime(t);
    const before = semanticHash(runtime.database);
    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({
            actorUserId: IDS.commissioner,
            actorMembershipId: IDS.commissionerMembership,
            actorAuthority: "commissioner",
            expectedBidVersion: null,
            idempotencyKey: "m5-02-commissioner-rejected",
          })
        ),
      AUCTION_BID_CODES.authorityInvalid
    );
    assert.equal(semanticHash(runtime.database), before);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM auction_administration_command_results
      `).get().count,
      0
    );
    const beforeOrdinaryConfirmation = semanticHash(runtime.database);
    assertPolicyError(
      () => validateAuctionBidCommand({
        ...persistenceCommand({
          idempotencyKey: "legacy-confirmation-rejected",
        }),
        bindingIllegalityConfirmed: true,
      }),
      AUCTION_BID_CODES.inputInvalid
    );
    assert.equal(
      semanticHash(runtime.database),
      beforeOrdinaryConfirmation
    );
  });

  test("requires exact current user, membership, and accepted manager authority inside the fresh bid transaction", (t) => {
    const runtime = createPersistenceRuntime(t);
    const assertFreshDenied = () => {
      const before = semanticHash(runtime.database);
      assertPolicyError(
        () => runtime.repository.putBid(persistenceCommand()),
        AUCTION_BID_CODES.authorizationDenied
      );
      assert.equal(semanticHash(runtime.database), before);
    };

    runtime.database.prepare(`
      UPDATE users
      SET status = 'disabled',
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @userId
    `).run({
      updatedAtMs: NOW_MS + 1,
      userId: IDS.managerB,
    });
    assertFreshDenied();
    runtime.database.prepare(`
      UPDATE users
      SET status = 'active',
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @userId
    `).run({
      updatedAtMs: NOW_MS + 1,
      userId: IDS.managerB,
    });

    runtime.database.prepare(`
      UPDATE league_memberships
      SET status = 'suspended',
          version = version + 1
      WHERE id = @membershipId
    `).run({ membershipId: IDS.membershipB });
    assertFreshDenied();
    runtime.database.prepare(`
      UPDATE league_memberships
      SET status = 'active',
          version = version + 1
      WHERE id = @membershipId
    `).run({ membershipId: IDS.membershipB });

    runtime.database.prepare(`
      UPDATE league_memberships
      SET joined_at_ms = NULL,
          version = version + 1
      WHERE id = @membershipId
    `).run({ membershipId: IDS.membershipB });
    assertFreshDenied();
    runtime.database.prepare(`
      UPDATE league_memberships
      SET joined_at_ms = @joinedAtMs,
          version = version + 1
      WHERE id = @membershipId
    `).run({
      joinedAtMs: NOW_MS - 1_000,
      membershipId: IDS.membershipB,
    });

    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `)
      .run({
        endedAtMs: NOW_MS + 1,
        membershipId: IDS.membershipB,
      });
    assert.equal(
      runtime.database
        .prepare(`
          SELECT ended_at_ms
          FROM league_memberships
          WHERE id = @membershipId
        `)
        .get({ membershipId: IDS.membershipB }).ended_at_ms,
      NOW_MS + 1
    );
    assertFreshDenied();
    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = NULL,
          version = version + 1
      WHERE id = @membershipId
    `).run({ membershipId: IDS.membershipB });

    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'ended',
          version = version + 1
      WHERE id = @assignmentId
    `).run({ assignmentId: IDS.assignmentB });
    assertFreshDenied();
    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'accepted',
          version = version + 1
      WHERE id = @assignmentId
    `).run({ assignmentId: IDS.assignmentB });

    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET accepted_at_ms = NULL,
          version = version + 1
      WHERE id = @assignmentId
    `).run({ assignmentId: IDS.assignmentB });
    assertFreshDenied();
    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET accepted_at_ms = @acceptedAtMs,
          version = version + 1
      WHERE id = @assignmentId
    `).run({
      acceptedAtMs: NOW_MS - 1_000,
      assignmentId: IDS.assignmentB,
    });

    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET ended_at_ms = @endedAtMs,
          version = version + 1
      WHERE id = @assignmentId
    `).run({
      endedAtMs: NOW_MS + 1,
      assignmentId: IDS.assignmentB,
    });
    assertFreshDenied();
  });

  test("preserves changed-hash precedence but reauthorizes an exact replay inside the bid transaction", (t) => {
    const runtime = createPersistenceRuntime(t);
    runtime.repository.putBid(persistenceCommand());
    runtime.database
      .prepare(`
        UPDATE users
        SET status = 'disabled',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @userId
      `)
      .run({
        updatedAtMs: NOW_MS + 1,
        userId: IDS.managerB,
      });
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM users
          WHERE id = @userId
        `)
        .get({ userId: IDS.managerB }).status,
      "disabled"
    );
    const before = semanticHash(runtime.database);

    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({ totalValueCents: 700 })
        ),
      AUCTION_BID_CODES.idempotencyKeyReused
    );
    assert.equal(semanticHash(runtime.database), before);

    assertPolicyError(
      () =>
        runtime.repository.putBid(
          persistenceCommand({
            bidId: uuid(430),
            eventId: uuid(431),
            idempotencyRequestId: uuid(432),
            occurredAtMs: NOW_MS + 1,
            idempotencyExpiresAtMs:
              NOW_MS + 86_400_001,
          })
        ),
      AUCTION_BID_CODES.authorizationDenied
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("exposes only the manager write command because canonical reads use the isolated read repository", (t) => {
    const runtime = createPersistenceRuntime(t);
    assert.deepEqual(
      Object.keys(runtime.repository),
      ["putBid"]
    );
    assert.equal(
      Object.isFrozen(runtime.repository),
      true
    );
  });

  test(
    "fails closed before manager bidding when ordinary context is missing or FAD-linked",
    async (t) => {
      for (const sourceKind of [
        "fad_open_rapid",
        "fad_restricted",
        null,
      ]) {
        await t.test(
          sourceKind || "missing",
          (contextTest) => {
            const runtime =
              createPersistenceRuntime(contextTest);
            replaceAuctionContextForIsolationTest(
              runtime.database,
              sourceKind
            );
            const before = semanticHash(
              runtime.database
            );

            const openedAtMs = runtime.database
              .prepare(
                "SELECT opened_at_ms FROM auctions WHERE id = ?"
              )
              .get(IDS.auction).opened_at_ms;
            for (const occurredAtMs of [
              openedAtMs - 1,
              openedAtMs,
            ]) {
              assertPolicyError(
                () =>
                  runtime.repository.putBid(
                    persistenceCommand({
                      bidId:
                        occurredAtMs === openedAtMs
                          ? uuid(160)
                          : uuid(161),
                      eventId:
                        occurredAtMs === openedAtMs
                          ? uuid(162)
                          : uuid(163),
                      idempotencyRequestId:
                        occurredAtMs === openedAtMs
                          ? uuid(164)
                          : uuid(165),
                      idempotencyKey:
                        `${sourceKind || "missing"}-${occurredAtMs}`,
                      occurredAtMs,
                      idempotencyExpiresAtMs:
                        occurredAtMs + 86_400_000,
                    })
                  ),
                AUCTION_BID_CODES.auctionUnavailable
              );
            }
            assert.equal(
              semanticHash(runtime.database),
              before
            );
          }
        );
      }
    }
  );

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

  test("atomically joins and edits an active restricted participant, then replays immutable original evidence", (t) => {
    const runtime = configureFadBidRuntime(
      createPersistenceRuntime(t),
      { kind: "restricted" }
    );
    const submittedAtMs = NOW_MS + 1;
    const submittedCommand = persistenceCommand({
      totalValueCents: 300,
      termYears: 1,
      occurredAtMs: submittedAtMs,
      idempotencyExpiresAtMs:
        submittedAtMs + 86_400_000,
      bindingIllegalityConfirmed: true,
    });
    const submitted = runtime.repository.putBid(
      submittedCommand
    );
    assert.deepEqual(
      {
        action: submitted.action,
        version: submitted.bid.version,
        totalValueCents: submitted.bid.totalValueCents,
        editCount: submitted.bid.editCount,
      },
      {
        action: "submitted",
        version: 1,
        totalValueCents: 300,
        editCount: 0,
      }
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT request_hash
        FROM idempotency_requests
        WHERE id = ?
      `).get(uuid(102)).request_hash,
      expectedRequestHash(submittedCommand, { fad: true })
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT active_improvement_bid_id,
          first_improvement_at_ms,
          current_cooldown_anchor_at_ms,
          improvement_committed_at_ms,
          version
        FROM free_agent_draft_auction_participants
        WHERE id = ?
      `).get(IDS.participant),
      {
        active_improvement_bid_id: submitted.bid.id,
        first_improvement_at_ms: submittedAtMs,
        current_cooldown_anchor_at_ms: submittedAtMs,
        improvement_committed_at_ms: submittedAtMs,
        version: 2,
      }
    );

    const editedAtMs = submittedAtMs + COOLDOWN_MS;
    const edited = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(300),
        eventId: uuid(301),
        idempotencyRequestId: uuid(302),
        idempotencyKey: "fad-restricted-edit",
        totalValueCents: 600,
        termYears: 3,
        expectedBidVersion: 1,
        occurredAtMs: editedAtMs,
        idempotencyExpiresAtMs:
          editedAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    );
    assert.equal(edited.action, "edited");
    assert.equal(edited.bid.version, 2);
    assert.equal(edited.bid.editCount, 1);

    const beforeSecondEdit = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          bidId: uuid(306),
          eventId: uuid(307),
          idempotencyRequestId: uuid(308),
          idempotencyKey: "fad-restricted-second-edit",
          expectedBidVersion: 2,
          occurredAtMs: editedAtMs + COOLDOWN_MS,
          idempotencyExpiresAtMs:
            editedAtMs + COOLDOWN_MS + 86_400_000,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.editLimitReached
    );
    assert.equal(
      semanticHash(runtime.database),
      beforeSecondEdit
    );

    const allocationTrigger = runtime.database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name = 'free_agent_draft_allocations_forward_update'
    `).get();
    runtime.database.exec(
      "DROP TRIGGER free_agent_draft_allocations_forward_update"
    );
    runtime.database.pragma("ignore_check_constraints = ON");
    runtime.database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'restricted_resolved'
      WHERE id = ?
    `).run(IDS.allocation);
    runtime.database.pragma("ignore_check_constraints = OFF");
    runtime.database.exec(allocationTrigger.sql);

    const replayed = runtime.repository.putBid({
      ...submittedCommand,
      bidId: uuid(303),
      eventId: uuid(304),
      idempotencyRequestId: uuid(305),
      occurredAtMs: editedAtMs + 1,
      idempotencyExpiresAtMs:
        editedAtMs + 1 + 86_400_000,
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.action, "submitted");
    assert.equal(replayed.bid.version, 1);
    assert.equal(replayed.bid.totalValueCents, 300);
    assert.equal(replayed.bid.lastEditedAtMs, submittedAtMs);
  });

  test("enforces restricted authorization, joining minimum, floor, cooldown, and participant permanence without writes", (t) => {
    const runtime = configureFadBidRuntime(
      createPersistenceRuntime(t),
      { kind: "restricted" }
    );
    let rejectionIndex = 0;
    for (const [overrides, reasonCode] of [
      [
        {
          bindingIllegalityConfirmed: true,
          totalValueCents: 400,
          termYears: 3,
        },
        AUCTION_BID_CODES.valueInvalid,
      ],
      [
        {
          bindingIllegalityConfirmed: true,
          totalValueCents: 300,
          termYears: 3,
        },
        AUCTION_BID_CODES.valueInvalid,
      ],
      [
        {
          bindingIllegalityConfirmed: true,
          actorUserId: IDS.member,
          actorMembershipId: IDS.memberMembership,
        },
        AUCTION_BID_CODES.authorizationDenied,
      ],
      [
        {
          bindingIllegalityConfirmed: true,
          teamId: IDS.team,
          actorUserId: IDS.user,
          actorMembershipId: IDS.membership,
        },
        AUCTION_BID_CODES.auctionUnavailable,
      ],
    ]) {
      rejectionIndex += 1;
      const before = semanticHash(runtime.database);
      assertPolicyError(
        () => runtime.repository.putBid(
          persistenceCommand({
            ...overrides,
            idempotencyKey:
              `restricted-reject-${rejectionIndex}`,
          })
        ),
        reasonCode
      );
      assert.equal(semanticHash(runtime.database), before);
    }

    const submittedAtMs = NOW_MS + 1;
    runtime.repository.putBid(
      persistenceCommand({
        totalValueCents: 500,
        termYears: 3,
        occurredAtMs: submittedAtMs,
        idempotencyExpiresAtMs:
          submittedAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    );
    const beforeCooldown = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          bidId: uuid(310),
          eventId: uuid(311),
          idempotencyRequestId: uuid(312),
          idempotencyKey: "restricted-before-cooldown",
          expectedBidVersion: 1,
          occurredAtMs:
            submittedAtMs + COOLDOWN_MS - 1,
          idempotencyExpiresAtMs:
            submittedAtMs + COOLDOWN_MS - 1 + 86_400_000,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.cooldownActive
    );
    assert.equal(semanticHash(runtime.database), beforeCooldown);

    const removalTriggers = runtime.database.prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name IN (
          'fad_auction_bids_forward_update',
          'free_agent_draft_auction_participants_forward_update'
        )
      ORDER BY name
    `).all();
    for (const trigger of removalTriggers) {
      runtime.database.exec(`DROP TRIGGER "${trigger.name}"`);
    }
    runtime.database.pragma("ignore_check_constraints = ON");
    runtime.database.prepare(`
      UPDATE auction_bids
      SET status = 'withdrawn'
      WHERE id = ?
    `).run(uuid(100));
    runtime.database.prepare(`
      UPDATE free_agent_draft_auction_participants
      SET status = 'removed',
        active_improvement_bid_id = NULL
      WHERE id = ?
    `).run(IDS.participant);
    runtime.database.pragma("ignore_check_constraints = OFF");
    for (const trigger of removalTriggers) {
      runtime.database.exec(trigger.sql);
    }
    const beforeRemovedRejoin = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          bidId: uuid(313),
          eventId: uuid(314),
          idempotencyRequestId: uuid(315),
          idempotencyKey: "restricted-removed-rejoin",
          totalValueCents: 600,
          termYears: 3,
          occurredAtMs: submittedAtMs + COOLDOWN_MS,
          idempotencyExpiresAtMs:
            submittedAtMs + COOLDOWN_MS + 86_400_000,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.auctionUnavailable
    );
    assert.equal(
      semanticHash(runtime.database),
      beforeRemovedRejoin
    );
  });

  test("keeps an allocation-linked fallback league-wide, floor-bound, and limited to one edit even for an opening-instant join", (t) => {
    const runtime = configureFadBidRuntime(
      createPersistenceRuntime(t),
      {
        kind: "fallback",
        minimumTotalValueCents: 600,
        minimumTermYears: 2,
        minimumAavCents: 300,
      }
    );
    const beforeLowerAav = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          totalValueCents: 600,
          termYears: 3,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.valueInvalid
    );
    assert.equal(semanticHash(runtime.database), beforeLowerAav);

    const submitted = runtime.repository.putBid(
      persistenceCommand({
        totalValueCents: 600,
        termYears: 2,
        occurredAtMs: NOW_MS,
        idempotencyExpiresAtMs: NOW_MS + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    );
    assert.equal(submitted.action, "submitted");
    const editedAtMs = NOW_MS + COOLDOWN_MS;
    const beforeLowerEdit = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          bidId: uuid(316),
          eventId: uuid(317),
          idempotencyRequestId: uuid(318),
          idempotencyKey: "fallback-lower-aav-edit",
          totalValueCents: 600,
          termYears: 3,
          expectedBidVersion: 1,
          occurredAtMs: editedAtMs,
          idempotencyExpiresAtMs:
            editedAtMs + 86_400_000,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.valueInvalid
    );
    assert.equal(semanticHash(runtime.database), beforeLowerEdit);
    const beforeCollision = semanticHash(runtime.database);
    assert.throws(() => runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(320),
        eventId: uuid(101),
        idempotencyRequestId: uuid(322),
        idempotencyKey: "fallback-collision",
        totalValueCents: 700,
        termYears: 2,
        expectedBidVersion: 1,
        occurredAtMs: editedAtMs,
        idempotencyExpiresAtMs:
          editedAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    ));
    assert.equal(semanticHash(runtime.database), beforeCollision);

    const edited = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(323),
        eventId: uuid(324),
        idempotencyRequestId: uuid(325),
        idempotencyKey: "fallback-edit",
        totalValueCents: 700,
        termYears: 2,
        expectedBidVersion: 1,
        occurredAtMs: editedAtMs,
        idempotencyExpiresAtMs:
          editedAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    );
    assert.equal(edited.bid.editCount, 1);
    const beforeSecond = semanticHash(runtime.database);
    assertPolicyError(
      () => runtime.repository.putBid(
        persistenceCommand({
          bidId: uuid(326),
          eventId: uuid(327),
          idempotencyRequestId: uuid(328),
          idempotencyKey: "fallback-second-edit",
          totalValueCents: 800,
          termYears: 2,
          expectedBidVersion: 2,
          occurredAtMs: editedAtMs + COOLDOWN_MS,
          idempotencyExpiresAtMs:
            editedAtMs + COOLDOWN_MS + 86_400_000,
          bindingIllegalityConfirmed: true,
        })
      ),
      AUCTION_BID_CODES.editLimitReached
    );
    assert.equal(semanticHash(runtime.database), beforeSecond);
  });

  test("uses the restricted edit's current AAV rather than its historical lowest AAV at an equal-total floor", (t) => {
    const runtime = configureFadBidRuntime(
      createPersistenceRuntime(t),
      {
        kind: "restricted",
        minimumTotalValueCents: 600,
        minimumTermYears: 2,
        minimumAavCents: 300,
      }
    );
    const submittedAtMs = NOW_MS + 1;
    const submitted = runtime.repository.putBid(
      persistenceCommand({
        totalValueCents: 700,
        termYears: 3,
        occurredAtMs: submittedAtMs,
        idempotencyExpiresAtMs:
          submittedAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    );
    assert.equal(submitted.bid.aavCents, 225);

    const editedAtMs = submittedAtMs + COOLDOWN_MS;
    const edited = runtime.repository.putBid(
      persistenceCommand({
        bidId: uuid(330),
        eventId: uuid(331),
        idempotencyRequestId: uuid(332),
        idempotencyKey: "restricted-current-aav-edit",
        totalValueCents: 600,
        termYears: 1,
        expectedBidVersion: 1,
        occurredAtMs: editedAtMs,
        idempotencyExpiresAtMs:
          editedAtMs + 86_400_000,
        bindingIllegalityConfirmed: true,
      })
    );
    assert.equal(edited.bid.aavCents, 600);
    assert.equal(edited.bid.version, 2);
    assert.equal(
      runtime.database.prepare(`
        SELECT lowest_offered_aav_cents
        FROM auction_bids
        WHERE id = ?
      `).get(uuid(100)).lowest_offered_aav_cents,
      225
    );
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
