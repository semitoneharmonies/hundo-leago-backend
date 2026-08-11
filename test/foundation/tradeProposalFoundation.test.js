const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  TRADE_PROPOSAL_FOUNDATION_CODES,
  TRADE_PROPOSAL_LIFETIME_MS,
  TradeProposalFoundationPolicyError,
  deriveTradeProposalTiming,
  validateTradeProposalFoundationCommand,
  validateTradeProposalFoundationInput,
  validateTradeProposalFoundationRequest,
} = require("../../src/domain/trades/tradeProposalPolicy");
const {
  createTradeProposalFoundationService,
} = require("../../src/application/services/trades/createTradeProposalFoundationService");
const {
  createLeagueAuthorizationService,
} = require("../../src/application/services/authorization/requireLeagueAuthority");
const {
  createTeamAuthorizationService,
} = require("../../src/application/services/authorization/requireTeamManagerAuthority");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueAccessRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const {
  createSqliteTeamAuthorityRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository");
const {
  createSqliteTradeProposalRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteTradeProposalRepository");
const {
  createSqliteUserRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-07-21T19:00:00.000Z");
const DRAFT_START_MS = NOW_MS - 24 * 60 * 60 * 1000;
const TRADE_DEADLINE_MS = NOW_MS + 2 * 24 * 60 * 60 * 1000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  managerA: uuid(1),
  managerB: uuid(2),
  commissioner: uuid(3),
  member: uuid(4),
  outsider: uuid(5),
  leagueA: uuid(10),
  leagueB: uuid(11),
  seasonA: uuid(20),
  seasonB: uuid(21),
  teamA: uuid(30),
  teamB: uuid(31),
  teamInactive: uuid(32),
  teamOtherLeague: uuid(33),
  managerMembershipA: uuid(40),
  managerMembershipB: uuid(41),
  commissionerMembership: uuid(42),
  memberMembership: uuid(43),
  outsiderMembership: uuid(44),
  assignmentA: uuid(50),
  assignmentB: uuid(51),
  outsiderAssignment: uuid(52),
  draftA: uuid(60),
  draftB: uuid(61),
  tradePending: uuid(70),
  tradeDeclined: uuid(71),
  tradeExpired: uuid(72),
  tradeCompleted: uuid(73),
});

function authenticated(userId) {
  return Object.freeze({
    valid: true,
    user: Object.freeze({ id: userId }),
    session: Object.freeze({ userId }),
  });
}

function semanticHash(database) {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
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
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
}

function insertLeague(repositories, { leagueId, seasonId, name }) {
  repositories.leagues.insert({
    id: leagueId,
    name: `${name} League`,
    name_normalized: `${name.toLowerCase()} league`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
  repositories.seasons.insert({
    id: seasonId,
    league_id: leagueId,
    label: name === "Alpha" ? "2026-27" : "2027-28",
    nhl_season_key: name === "Alpha" ? "20262027" : "20272028",
    status: "active",
    regular_season_starts_at_ms: NOW_MS - 20_000,
    regular_season_ends_at_ms: NOW_MS + 200_000_000,
    fantasy_playoffs_start_at_ms: NOW_MS + 100_000_000,
    fantasy_playoffs_end_at_ms: NOW_MS + 200_000_000,
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
    free_agent_draft_completed_at_ms: NOW_MS - 15_000,
  });
  repositories.league_settings.insert({
    league_id: leagueId,
    salary_cap_cents: 10000,
    trade_deadline_at_ms: TRADE_DEADLINE_MS,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
}

function insertTeam(repositories, { id, leagueId, name, status = "active" }) {
  repositories.teams.insert({
    id,
    league_id: leagueId,
    name,
    name_normalized: name.toLowerCase(),
    status,
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
}

function insertMembership(repositories, {
  id,
  leagueId,
  userId,
  permissionCategory,
}) {
  repositories.league_memberships.insert({
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: NOW_MS - 10_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
}

function insertAssignment(repositories, {
  id,
  leagueId,
  teamId,
  userId,
  membershipId,
  assignedByUserId,
}) {
  repositories.team_manager_assignments.insert({
    id,
    league_id: leagueId,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: assignedByUserId,
    status: "accepted",
    assigned_at_ms: NOW_MS - 10_000,
    accepted_at_ms: NOW_MS - 9_000,
    ended_at_ms: null,
    version: 1,
  });
}

function insertTrade(repositories, { id, status, createdAtMs, completedAtMs = null }) {
  repositories.trades.insert({
    id,
    league_id: IDS.leagueA,
    season_id: IDS.seasonA,
    proposing_team_id: IDS.teamA,
    receiving_team_id: IDS.teamB,
    proposing_user_id: IDS.managerA,
    status,
    created_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + TRADE_PROPOSAL_LIFETIME_MS,
    responded_at_ms: status === "proposed" ? null : createdAtMs + 1_000,
    completed_at_ms: completedAtMs,
    commissioner_completion_reference: null,
    updated_at_ms: completedAtMs || createdAtMs + 1_000,
    version: 1,
  });
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-05-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m5-05-test",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  const { repositories } = context;
  for (const [id, name] of [
    [IDS.managerA, "Manager A"],
    [IDS.managerB, "Manager B"],
    [IDS.commissioner, "Commissioner"],
    [IDS.member, "Member"],
    [IDS.outsider, "Outsider"],
  ]) {
    insertUser(repositories, id, name);
  }
  insertLeague(repositories, {
    leagueId: IDS.leagueA,
    seasonId: IDS.seasonA,
    name: "Alpha",
  });
  insertLeague(repositories, {
    leagueId: IDS.leagueB,
    seasonId: IDS.seasonB,
    name: "Bravo",
  });
  insertTeam(repositories, {
    id: IDS.teamA,
    leagueId: IDS.leagueA,
    name: "Alpha One",
  });
  insertTeam(repositories, {
    id: IDS.teamB,
    leagueId: IDS.leagueA,
    name: "Alpha Two",
  });
  insertTeam(repositories, {
    id: IDS.teamInactive,
    leagueId: IDS.leagueA,
    name: "Alpha Inactive",
    status: "inactive",
  });
  insertTeam(repositories, {
    id: IDS.teamOtherLeague,
    leagueId: IDS.leagueB,
    name: "Bravo One",
  });
  insertMembership(repositories, {
    id: IDS.managerMembershipA,
    leagueId: IDS.leagueA,
    userId: IDS.managerA,
    permissionCategory: "manager",
  });
  insertMembership(repositories, {
    id: IDS.managerMembershipB,
    leagueId: IDS.leagueA,
    userId: IDS.managerB,
    permissionCategory: "manager",
  });
  insertMembership(repositories, {
    id: IDS.commissionerMembership,
    leagueId: IDS.leagueA,
    userId: IDS.commissioner,
    permissionCategory: "commissioner",
  });
  insertMembership(repositories, {
    id: IDS.memberMembership,
    leagueId: IDS.leagueA,
    userId: IDS.member,
    permissionCategory: "member",
  });
  insertMembership(repositories, {
    id: IDS.outsiderMembership,
    leagueId: IDS.leagueB,
    userId: IDS.outsider,
    permissionCategory: "manager",
  });
  repositories.leagues.updateVersioned({
    key: IDS.leagueA,
    expectedVersion: 1,
    changes: {
      current_season_id: IDS.seasonA,
      commissioner_membership_id: IDS.commissionerMembership,
      updated_at_ms: NOW_MS,
    },
  });
  repositories.leagues.updateVersioned({
    key: IDS.leagueB,
    expectedVersion: 1,
    changes: {
      current_season_id: IDS.seasonB,
      updated_at_ms: NOW_MS,
    },
  });
  insertAssignment(repositories, {
    id: IDS.assignmentA,
    leagueId: IDS.leagueA,
    teamId: IDS.teamA,
    userId: IDS.managerA,
    membershipId: IDS.managerMembershipA,
    assignedByUserId: IDS.commissioner,
  });
  insertAssignment(repositories, {
    id: IDS.assignmentB,
    leagueId: IDS.leagueA,
    teamId: IDS.teamB,
    userId: IDS.managerB,
    membershipId: IDS.managerMembershipB,
    assignedByUserId: IDS.commissioner,
  });
  insertAssignment(repositories, {
    id: IDS.outsiderAssignment,
    leagueId: IDS.leagueB,
    teamId: IDS.teamOtherLeague,
    userId: IDS.outsider,
    membershipId: IDS.outsiderMembership,
    assignedByUserId: IDS.commissioner,
  });
  repositories.entry_drafts.insert({
    id: IDS.draftA,
    league_id: IDS.leagueA,
    season_id: IDS.seasonA,
    status: "completed",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: DRAFT_START_MS,
    completed_at_ms: DRAFT_START_MS + 1_000,
    created_by_user_id: IDS.commissioner,
    created_at_ms: DRAFT_START_MS - 1_000,
    updated_at_ms: DRAFT_START_MS + 1_000,
    version: 1,
  });
  repositories.entry_drafts.insert({
    id: IDS.draftB,
    league_id: IDS.leagueB,
    season_id: IDS.seasonB,
    status: "completed",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: DRAFT_START_MS,
    completed_at_ms: DRAFT_START_MS + 1_000,
    created_by_user_id: IDS.outsider,
    created_at_ms: DRAFT_START_MS - 1_000,
    updated_at_ms: DRAFT_START_MS + 1_000,
    version: 1,
  });

  const leagueAccess = createSqliteLeagueAccessRepository({
    database: connection.database,
  });
  const leagueAuthorization = createLeagueAuthorizationService({
    userRepository: createSqliteUserRepository({
      database: connection.database,
    }),
    leagueAccessRepository: leagueAccess,
  });
  const teamAuthorization = createTeamAuthorizationService({
    leagueAuthorization,
    teamAuthorityRepository: createSqliteTeamAuthorityRepository({
      database: connection.database,
    }),
  });
  const repository = createSqliteTradeProposalRepository({
    database: connection.database,
    candidateCardSummerSynchronizer: Object.freeze({
      synchronize() {
        return Object.freeze({
          affectedCardCount: 0,
          changedCardCount: 0,
        });
      },
    }),
  });
  let nowMs = NOW_MS;
  let nextId = 100;
  const service = createTradeProposalFoundationService({
    leagueAuthorization,
    teamAuthorization,
    repository,
    clock: Object.freeze({ nowMs: () => nowMs }),
    secureRandom: Object.freeze({ id: () => uuid(nextId++) }),
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return Object.freeze({
    database: connection.database,
    repositories,
    repository,
    service,
    setNow(value) {
      nowMs = value;
    },
  });
}

function assertPolicyReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeProposalFoundationPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("M5-05 trade proposal policy", () => {
  test("requires an exact two-team request and exact command", () => {
    assert.deepEqual(
      validateTradeProposalFoundationRequest({
        leagueId: IDS.leagueA,
        proposingTeamId: IDS.teamA,
        receivingTeamId: IDS.teamB,
      }),
      {
        leagueId: IDS.leagueA,
        proposingTeamId: IDS.teamA,
        receivingTeamId: IDS.teamB,
      }
    );
    assertPolicyReason(
      () =>
        validateTradeProposalFoundationInput({
          proposingTeamId: IDS.teamA,
          receivingTeamId: IDS.teamB,
          clientRole: "commissioner",
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.inputInvalid
    );
    assertPolicyReason(
      () =>
        validateTradeProposalFoundationInput({
          leagueId: IDS.leagueB,
          proposingTeamId: IDS.teamA,
          receivingTeamId: IDS.teamB,
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.inputInvalid
    );
    assertPolicyReason(
      () =>
        validateTradeProposalFoundationRequest({
          leagueId: IDS.leagueA,
          proposingTeamId: IDS.teamA,
          receivingTeamId: IDS.teamA,
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.teamsSame
    );
    assert.equal(
      validateTradeProposalFoundationCommand({
        proposalId: uuid(90),
        leagueId: IDS.leagueA,
        seasonId: IDS.seasonA,
        proposingTeamId: IDS.teamA,
        receivingTeamId: IDS.teamB,
        actorUserId: IDS.managerA,
        actorMembershipId: IDS.managerMembershipA,
        actorAuthority: "manager",
        createdAtMs: NOW_MS,
      }).seasonId,
      IDS.seasonA
    );
  });

  test("uses exactly 168 hours unless the league deadline is earlier", () => {
    const fullLifetime = deriveTradeProposalTiming({
      createdAtMs: NOW_MS,
      tradeDeadlineAtMs: NOW_MS + 30 * 24 * 60 * 60 * 1000,
    });
    assert.equal(
      fullLifetime.expiresAtMs,
      NOW_MS + TRADE_PROPOSAL_LIFETIME_MS
    );
    assert.equal(fullLifetime.effectiveDeadlineAtMs, fullLifetime.expiresAtMs);
    const deadlineFirst = deriveTradeProposalTiming({
      createdAtMs: NOW_MS,
      tradeDeadlineAtMs: TRADE_DEADLINE_MS,
    });
    assert.equal(deadlineFirst.effectiveDeadlineAtMs, TRADE_DEADLINE_MS);
    assertPolicyReason(
      () =>
        deriveTradeProposalTiming({
          createdAtMs: NOW_MS,
          tradeDeadlineAtMs: NOW_MS,
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.windowClosed
    );
  });
});

describe("M5-05 trade proposal SELECT-only foundation", () => {
  test("manager and commissioner previews derive current authority without writes", (t) => {
    const runtime = createRuntime(t);
    const before = semanticHash(runtime.database);
    const managerOne = runtime.service.preview({
      leagueId: IDS.leagueA,
      input: {
        proposingTeamId: IDS.teamA,
        receivingTeamId: IDS.teamB,
      },
      authenticated: authenticated(IDS.managerA),
    });
    const managerTwo = runtime.service.preview({
      leagueId: IDS.leagueA,
      input: {
        proposingTeamId: IDS.teamA,
        receivingTeamId: IDS.teamB,
      },
      authenticated: authenticated(IDS.managerA),
    });
    const commissioner = runtime.service.preview({
      leagueId: IDS.leagueA,
      input: {
        proposingTeamId: IDS.teamB,
        receivingTeamId: IDS.teamA,
      },
      authenticated: authenticated(IDS.commissioner),
    });
    assert.equal(managerOne.persisted, false);
    assert.equal(managerOne.proposal.creatingActor.authority, "manager");
    assert.equal(commissioner.proposal.creatingActor.authority, "commissioner");
    assert.notEqual(managerOne.proposal.id, managerTwo.proposal.id);
    assert.equal(managerOne.proposal.effectiveDeadlineAtMs, TRADE_DEADLINE_MS);
    assert.equal(
      runtime.database.prepare("SELECT count(*) AS count FROM trades").get().count,
      0
    );
    assert.equal(
      runtime.database.prepare("SELECT count(*) AS count FROM trade_assets").get()
        .count,
      0
    );
    assert.equal(
      runtime.database.prepare("SELECT count(*) AS count FROM trade_events").get()
        .count,
      0
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("nonparticipant, cross-league, inactive-team, and exact-deadline requests fail closed", (t) => {
    const runtime = createRuntime(t);
    const before = semanticHash(runtime.database);
    assert.throws(
      () =>
        runtime.service.preview({
          leagueId: IDS.leagueA,
          input: {
            proposingTeamId: IDS.teamA,
            receivingTeamId: IDS.teamB,
          },
          authenticated: authenticated(IDS.managerB),
        }),
      { code: "TEAM_MANAGER_REQUIRED" }
    );
    assertPolicyReason(
      () =>
        runtime.service.preview({
          leagueId: IDS.leagueA,
          input: {
            proposingTeamId: IDS.teamA,
            receivingTeamId: IDS.teamOtherLeague,
          },
          authenticated: authenticated(IDS.managerA),
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.seasonUnavailable
    );
    assertPolicyReason(
      () =>
        runtime.service.preview({
          leagueId: IDS.leagueA,
          input: {
            proposingTeamId: IDS.teamA,
            receivingTeamId: IDS.teamInactive,
          },
          authenticated: authenticated(IDS.managerA),
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.authorizationDenied
    );
    runtime.setNow(TRADE_DEADLINE_MS);
    assertPolicyReason(
      () =>
        runtime.service.preview({
          leagueId: IDS.leagueA,
          input: {
            proposingTeamId: IDS.teamA,
            receivingTeamId: IDS.teamB,
          },
          authenticated: authenticated(IDS.managerA),
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.windowClosed
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("a freeze blocks managers but preserves explicit commissioner preview", (t) => {
    const runtime = createRuntime(t);
    runtime.repositories.leagues.updateVersioned({
      key: IDS.leagueA,
      expectedVersion: 2,
      changes: { status: "frozen", updated_at_ms: NOW_MS + 1 },
    });
    const afterSetup = semanticHash(runtime.database);
    assertPolicyReason(
      () =>
        runtime.service.preview({
          leagueId: IDS.leagueA,
          input: {
            proposingTeamId: IDS.teamA,
            receivingTeamId: IDS.teamB,
          },
          authenticated: authenticated(IDS.managerA),
        }),
      TRADE_PROPOSAL_FOUNDATION_CODES.authorizationDenied
    );
    const commissioner = runtime.service.preview({
      leagueId: IDS.leagueA,
      input: {
        proposingTeamId: IDS.teamA,
        receivingTeamId: IDS.teamB,
      },
      authenticated: authenticated(IDS.commissioner),
    });
    assert.equal(commissioner.proposal.creatingActor.authority, "commissioner");
    assert.equal(semanticHash(runtime.database), afterSetup);
  });

  test("active league members see pending and terminal history without expiry-on-read", (t) => {
    const runtime = createRuntime(t);
    insertTrade(runtime.repositories, {
      id: IDS.tradePending,
      status: "proposed",
      createdAtMs: NOW_MS - 10 * 24 * 60 * 60 * 1000,
    });
    insertTrade(runtime.repositories, {
      id: IDS.tradeDeclined,
      status: "declined",
      createdAtMs: NOW_MS - 3_000,
    });
    insertTrade(runtime.repositories, {
      id: IDS.tradeExpired,
      status: "expired",
      createdAtMs: NOW_MS - 2_000,
    });
    insertTrade(runtime.repositories, {
      id: IDS.tradeCompleted,
      status: "completed",
      createdAtMs: NOW_MS - 1_000,
      completedAtMs: NOW_MS,
    });
    const before = semanticHash(runtime.database);
    const result = runtime.service.list({
      leagueId: IDS.leagueA,
      authenticated: authenticated(IDS.member),
    });
    assert.deepEqual(
      result.proposals.map(({ storageStatus }) => storageStatus),
      ["completed", "expired", "declined", "proposed"]
    );
    assert.equal(
      result.proposals.find(({ id }) => id === IDS.tradePending).status,
      "Pending"
    );
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM trades WHERE id = ?")
        .get(IDS.tradePending).status,
      "proposed"
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("public, inactive, and other-league identities gain no proposal visibility", (t) => {
    const runtime = createRuntime(t);
    insertTrade(runtime.repositories, {
      id: IDS.tradePending,
      status: "proposed",
      createdAtMs: NOW_MS - 1_000,
    });
    assert.throws(
      () => runtime.service.list({ leagueId: IDS.leagueA }),
      { code: "LEAGUE_NOT_FOUND" }
    );
    assert.throws(
      () =>
        runtime.service.list({
          leagueId: IDS.leagueA,
          authenticated: authenticated(IDS.outsider),
        }),
      { code: "LEAGUE_NOT_FOUND" }
    );
    runtime.repositories.league_memberships.updateVersioned({
      key: IDS.memberMembership,
      leagueId: IDS.leagueA,
      expectedVersion: 1,
      changes: {
        status: "ended",
        ended_at_ms: NOW_MS,
        updated_at_ms: NOW_MS,
      },
    });
    assert.throws(
      () =>
        runtime.service.list({
          leagueId: IDS.leagueA,
          authenticated: authenticated(IDS.member),
        }),
      { code: "LEAGUE_NOT_FOUND" }
    );
  });

  test("repository surface exposes only the approved read and atomic-create operations", (t) => {
    const runtime = createRuntime(t);
    assert.deepEqual(Object.keys(runtime.repository).sort(), [
      "createProposal",
      "executeAcceptance",
      "findLifecycleParticipants",
      "listVisible",
      "loadFoundationState",
      "previewAcceptance",
      "readDetail",
      "transitionLifecycle",
    ]);
  });
});
