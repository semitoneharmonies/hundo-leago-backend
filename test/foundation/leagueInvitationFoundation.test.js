const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  LeagueInvitationConflictError,
  LeagueInvitationNotFoundError,
  createLeagueInvitationService,
} = require(
  "../../src/application/services/leagues/createLeagueInvitationService"
);
const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  LeagueInvitationPolicyError,
  validateAcceptanceInput,
  validateDeclineInput,
  validateIdempotencyKey,
  validateInvitationInput,
  validateTeamName,
} = require("../../src/domain/leagues/leagueInvitationPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueAccessRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository"
);
const {
  createSqliteLeagueInvitationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueInvitationRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createLeagueInvitationRouter,
} = require("../../src/transport/http/createLeagueInvitationRouter");
const {
  createTargetRequestSecurity,
} = require("../../src/transport/http/createTargetRequestSecurity");
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T08:00:00.000Z");
const COMMISSIONER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";
const LEAGUE_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_LEAGUE_ID = "00000000-0000-4000-8000-000000000011";
const TEAM_ID = "00000000-0000-4000-8000-000000000020";
const PUBLIC_FRONTEND_ORIGIN = "https://hundo.example";
const SESSION_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x61).toString("base64url"),
  [TARGET_ID]: Buffer.alloc(32, 0x62).toString("base64url"),
  [OTHER_ID]: Buffer.alloc(32, 0x63).toString("base64url"),
});
const CSRF_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x64).toString("base64url"),
  [TARGET_ID]: Buffer.alloc(32, 0x65).toString("base64url"),
  [OTHER_ID]: Buffer.alloc(32, 0x66).toString("base64url"),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function sessionIdFor(userId) {
  if (userId === COMMISSIONER_ID) return uuid(30);
  if (userId === TARGET_ID) return uuid(31);
  return uuid(32);
}

function authenticated(userId = COMMISSIONER_ID) {
  return {
    valid: true,
    code: "SESSION_VALID",
    session: { id: sessionIdFor(userId), userId, version: 1 },
    user: { id: userId, status: "active", version: 1 },
  };
}

function insertUser(context, { id, email, displayName, status = "active" }) {
  context.repositories.users.insert({
    id,
    email_normalized: email,
    email_display: email,
    display_name: displayName,
    display_name_normalized: displayName.toLowerCase(),
    status,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.sessions.insert({
    id: sessionIdFor(id),
    user_id: id,
    token_digest: id.slice(-1).repeat(64),
    csrf_secret_digest: id.slice(-2, -1).repeat(64),
    status: "active",
    created_at_ms: NOW_MS,
    last_used_at_ms: NOW_MS,
    idle_expires_at_ms: NOW_MS + 60 * 60 * 1000,
    absolute_expires_at_ms: NOW_MS + 2 * 60 * 60 * 1000,
    revoked_at_ms: null,
    revocation_reason: null,
    client_metadata_json: null,
    version: 1,
  });
}

function insertLeague(context, {
  id,
  name,
  status = "setup",
  maximumTeams = 20,
}) {
  context.repositories.leagues.insert({
    id,
    name,
    name_normalized: name.toLowerCase(),
    status,
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.league_settings.insert({
    league_id: id,
    salary_cap_cents: 10000,
    trade_deadline_at_ms: null,
    maximum_teams: maximumTeams,
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
}

function insertTeam(context, {
  id = TEAM_ID,
  leagueId = LEAGUE_ID,
  name = "Existing Team",
  status = "setup",
} = {}) {
  return context.repositories.teams.insert({
    id,
    league_id: leagueId,
    name,
    name_normalized: name.toLowerCase(),
    status,
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function createRuntime(t, {
  leagueStatus = "setup",
  targetStatus = "active",
  maximumTeams = 20,
  includeTeam = true,
} = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-15-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-15-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  insertUser(context, {
    id: COMMISSIONER_ID,
    email: "commissioner@example.test",
    displayName: "League Commissioner",
  });
  insertUser(context, {
    id: TARGET_ID,
    email: "target@example.test",
    displayName: "Target User",
    status: targetStatus,
  });
  insertUser(context, {
    id: OTHER_ID,
    email: "other@example.test",
    displayName: "Other User",
  });
  insertLeague(context, {
    id: LEAGUE_ID,
    name: "Invitation Test League",
    status: leagueStatus,
    maximumTeams,
  });
  const commissionerMembershipId = uuid(40);
  context.repositories.league_memberships.insert({
    id: commissionerMembershipId,
    league_id: LEAGUE_ID,
    user_id: COMMISSIONER_ID,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.leagues.updateVersioned({
    key: LEAGUE_ID,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: commissionerMembershipId,
      updated_at_ms: NOW_MS,
    },
  });
  if (includeTeam) insertTeam(context);

  const userRepository = createSqliteUserRepository({
    database: connection.database,
  });
  const leagueAccessRepository = createSqliteLeagueAccessRepository({
    database: connection.database,
  });
  let nextId = 100;
  return {
    auditRepository: createSqliteSecurityAuditRepository({
      database: connection.database,
    }),
    clock: { nowMs: () => NOW_MS },
    context,
    database: connection.database,
    invitationRepository: createSqliteLeagueInvitationRepository({
      database: connection.database,
    }),
    leagueAuthorization: createLeagueAuthorizationService({
      userRepository,
      leagueAccessRepository,
    }),
    secureRandom: { id: () => uuid(nextId++) },
    userRepository,
  };
}

function createService(runtime, overrides = {}) {
  return createLeagueInvitationService({
    repositoryContext: runtime.context,
    leagueAuthorization: runtime.leagueAuthorization,
    userRepository: runtime.userRepository,
    invitationRepository: runtime.invitationRepository,
    auditRepository: runtime.auditRepository,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
    ...overrides,
  });
}

function invitationCommand(input, overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    input,
    idempotencyKey: "league-invitation-key",
    authenticated: authenticated(COMMISSIONER_ID),
    auditContext: {
      requestCorrelationId: "request-m3-15",
      networkKeyVersion: 1,
      networkMetadataDigest: "d".repeat(64),
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "unknown",
        origin: "https://hundo.example",
      }),
    },
    ...overrides,
  };
}

function createTeamInput() {
  return { userId: TARGET_ID, workflow: "create_team" };
}

function manageTeamInput(teamId = TEAM_ID) {
  return { userId: TARGET_ID, workflow: "manage_team", teamId };
}

function tableCount(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

function invitationCounts(database) {
  return Object.fromEntries(
    [
      "league_invitations",
      "league_memberships",
      "teams",
      "team_manager_assignments",
      "notifications",
      "league_activity",
      "security_audit_events",
      "idempotency_requests",
    ].map((table) => [table, tableCount(database, table)])
  );
}

describe("M3-15 league-invitation policy", () => {
  test("accepts only exact dual-mode inputs and 35-code-point team names", () => {
    assert.deepEqual(validateInvitationInput(createTeamInput()), {
      userId: TARGET_ID,
      workflow: "create_team",
      teamId: null,
    });
    assert.deepEqual(validateInvitationInput(manageTeamInput()), {
      userId: TARGET_ID,
      workflow: "manage_team",
      teamId: TEAM_ID,
    });
    assert.deepEqual(validateAcceptanceInput({ teamName: "  Orcas  " }, "create_team"), {
      teamName: "Orcas",
      teamNameNormalized: "orcas",
    });
    assert.deepEqual(validateAcceptanceInput({}, "manage_team"), {
      teamName: null,
      teamNameNormalized: null,
    });
    assert.deepEqual(validateDeclineInput({}), {});
    assert.equal(validateIdempotencyKey("opaque-key"), "opaque-key");
    assert.equal(validateTeamName("🏒".repeat(35)).teamName.length, 70);

    for (const input of [
      null,
      { userId: TARGET_ID },
      { userId: TARGET_ID, workflow: "membership_only" },
      { userId: TARGET_ID, workflow: "create_team", teamId: TEAM_ID },
      { userId: TARGET_ID, workflow: "manage_team" },
    ]) {
      assert.throws(
        () => validateInvitationInput(input),
        LeagueInvitationPolicyError
      );
    }
    for (const command of [
      () => validateAcceptanceInput({}, "create_team"),
      () => validateAcceptanceInput({ teamName: "x" }, "manage_team"),
      () => validateAcceptanceInput({ teamName: "x".repeat(36) }, "create_team"),
      () => validateDeclineInput({ decline: true }),
      () => validateIdempotencyKey(" padded "),
    ]) {
      assert.throws(command, LeagueInvitationPolicyError);
    }
  });
});

describe("M3-15 invitation creation and safe read", () => {
  test("atomically creates and replays a non-expiring create-team invitation", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const result = service.invite(
      invitationCommand(createTeamInput())
    );

    assert.equal(result.code, "LEAGUE_INVITATION_CREATED");
    assert.equal(result.invitation.status, "pending");
    assert.equal(result.invitation.workflow, "create_team");
    assert.equal(result.membership.status, "invited");
    assert.equal(result.membership.permissionCategory, "manager");
    assert.equal(result.team, null);
    assert.deepEqual(invitationCounts(runtime.database), {
      league_invitations: 1,
      league_memberships: 2,
      teams: 1,
      team_manager_assignments: 0,
      notifications: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
    const persisted = runtime.database
      .prepare("SELECT * FROM league_invitations")
      .get();
    assert.equal(persisted.workflow, "create_team");
    assert.equal(persisted.team_id, null);
    assert.equal(persisted.expires_at_ms, Number.MAX_SAFE_INTEGER);
    assert.equal(JSON.stringify(result).includes("target@example.test"), false);

    const replay = service.invite(invitationCommand(createTeamInput()));
    assert.deepEqual(replay, result);
    assert.equal(replay.replayed, true);
    assert.equal(tableCount(runtime.database, "league_invitations"), 1);
    assert.throws(
      () =>
        service.invite(
          invitationCommand(manageTeamInput())
        ),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
  });

  test("targets one same-league unassigned team and hides the invitation from others", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const created = service.invite(
      invitationCommand(manageTeamInput())
    );
    assert.equal(created.team.id, TEAM_ID);
    assert.equal(created.team.name, "Existing Team");

    const before = invitationCounts(runtime.database);
    const found = service.read({
      invitationId: created.invitation.id,
      authenticated: authenticated(TARGET_ID),
    });
    assert.equal(found.code, "LEAGUE_INVITATION_FOUND");
    assert.deepEqual(invitationCounts(runtime.database), before);
    for (const command of [
      {
        invitationId: created.invitation.id,
        authenticated: authenticated(OTHER_ID),
      },
      {
        invitationId: uuid(999),
        authenticated: authenticated(TARGET_ID),
      },
    ]) {
      assert.throws(
        () => service.read(command),
        LeagueInvitationNotFoundError
      );
    }
  });

  test("rejects stale authority, active members, unavailable teams, and cross-league targets without writes", (t) => {
    const noAuthority = createRuntime(t);
    assert.throws(
      () =>
        createService(noAuthority).invite(
          invitationCommand(createTeamInput(), {
            authenticated: authenticated(OTHER_ID),
          })
        ),
      (error) => error.code === "LEAGUE_NOT_FOUND"
    );
    assert.equal(tableCount(noAuthority.database, "league_invitations"), 0);

    const activeMember = createRuntime(t);
    activeMember.context.repositories.league_memberships.insert({
      id: uuid(50),
      league_id: LEAGUE_ID,
      user_id: TARGET_ID,
      permission_category: "member",
      status: "active",
      joined_at_ms: NOW_MS,
      ended_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    assert.throws(
      () =>
        createService(activeMember).invite(
          invitationCommand(createTeamInput())
        ),
      LeagueInvitationConflictError
    );
    assert.equal(tableCount(activeMember.database, "league_invitations"), 0);

    const crossLeague = createRuntime(t);
    insertLeague(crossLeague.context, {
      id: OTHER_LEAGUE_ID,
      name: "Other League",
    });
    insertTeam(crossLeague.context, {
      id: uuid(21),
      leagueId: OTHER_LEAGUE_ID,
      name: "Other Team",
    });
    assert.throws(
      () =>
        createService(crossLeague).invite(
          invitationCommand(manageTeamInput(uuid(21)))
        ),
      LeagueInvitationConflictError
    );
    assert.equal(tableCount(crossLeague.database, "league_invitations"), 0);

    const assigned = createRuntime(t);
    assigned.context.repositories.league_memberships.insert({
      id: uuid(51),
      league_id: LEAGUE_ID,
      user_id: OTHER_ID,
      permission_category: "manager",
      status: "active",
      joined_at_ms: NOW_MS,
      ended_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    assigned.context.repositories.team_manager_assignments.insert({
      id: uuid(52),
      league_id: LEAGUE_ID,
      team_id: TEAM_ID,
      user_id: OTHER_ID,
      membership_id: uuid(51),
      assigned_by_user_id: COMMISSIONER_ID,
      status: "accepted",
      assigned_at_ms: NOW_MS,
      accepted_at_ms: NOW_MS,
      ended_at_ms: null,
      version: 1,
    });
    assert.throws(
      () =>
        createService(assigned).invite(
          invitationCommand(manageTeamInput())
        ),
      LeagueInvitationConflictError
    );
    assert.equal(tableCount(assigned.database, "league_invitations"), 0);
  });

  test("rolls every invitation-creation write seam back", (t) => {
    for (const seam of [
      "insertStartedIdempotency",
      "insertInvitedManagerMembership",
      "insertInvitation",
      "insertInvitationNotification",
      "appendInvitationActivity",
      "completeIdempotency",
    ]) {
      const runtime = createRuntime(t);
      const repository = {
        ...runtime.invitationRepository,
        [seam]() {
          throw new Error(`injected ${seam} failure`);
        },
      };
      assert.throws(
        () =>
          createService(runtime, {
            invitationRepository: repository,
          }).invite(invitationCommand(createTeamInput())),
        /repository operation failed/i
      );
      assert.deepEqual(invitationCounts(runtime.database), {
        league_invitations: 0,
        league_memberships: 1,
        teams: 1,
        team_manager_assignments: 0,
        notifications: 0,
        league_activity: 0,
        security_audit_events: 0,
        idempotency_requests: 0,
      });
    }
  });
});

describe("M3-15 invitation acceptance and decline", () => {
  test("accepts create-team atomically and replays only the same team name", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const invited = service.invite(
      invitationCommand(createTeamInput())
    );
    const accepted = service.accept({
      invitationId: invited.invitation.id,
      input: { teamName: "  Pacific Orcas  " },
      authenticated: authenticated(TARGET_ID),
    });
    assert.equal(accepted.code, "LEAGUE_INVITATION_ACCEPTED");
    assert.equal(accepted.invitation.status, "accepted");
    assert.equal(accepted.membership.status, "active");
    assert.equal(accepted.team.name, "Pacific Orcas");
    assert.equal(accepted.team.status, "setup");
    assert.equal(accepted.team.primaryColour, null);
    assert.equal(accepted.team.secondaryColour, null);
    assert.equal(accepted.team.logoReference, null);
    assert.equal(accepted.managerAssignment.status, "accepted");
    assert.equal(
      runtime.database
        .prepare("SELECT team_id FROM league_invitations")
        .get().team_id,
      accepted.team.id
    );
    const counts = invitationCounts(runtime.database);
    assert.deepEqual(counts, {
      league_invitations: 1,
      league_memberships: 2,
      teams: 2,
      team_manager_assignments: 1,
      notifications: 1,
      league_activity: 2,
      security_audit_events: 2,
      idempotency_requests: 1,
    });

    const replay = service.accept({
      invitationId: invited.invitation.id,
      input: { teamName: "Pacific Orcas" },
      authenticated: authenticated(TARGET_ID),
    });
    assert.deepEqual(replay, accepted);
    assert.equal(replay.replayed, true);
    assert.deepEqual(invitationCounts(runtime.database), counts);
    assert.throws(
      () =>
        service.accept({
          invitationId: invited.invitation.id,
          input: { teamName: "Different Team" },
          authenticated: authenticated(TARGET_ID),
        }),
      LeagueInvitationConflictError
    );
  });

  test("accepts manage-team in an active league for exactly the selected unassigned team", (t) => {
    const runtime = createRuntime(t, { leagueStatus: "active" });
    runtime.context.repositories.teams.updateVersioned({
      key: TEAM_ID,
      leagueId: LEAGUE_ID,
      expectedVersion: 1,
      changes: { status: "active", updated_at_ms: NOW_MS },
    });
    const service = createService(runtime);
    const invited = service.invite(
      invitationCommand(manageTeamInput())
    );
    const accepted = service.accept({
      invitationId: invited.invitation.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    });
    assert.equal(accepted.team.id, TEAM_ID);
    assert.equal(accepted.team.status, "active");
    assert.equal(accepted.membership.status, "active");
    assert.equal(accepted.managerAssignment.status, "accepted");
    assert.equal(tableCount(runtime.database, "teams"), 1);
  });

  test("declines without membership or manager authority and replays safely", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const invited = service.invite(
      invitationCommand(manageTeamInput())
    );
    const declined = service.decline({
      invitationId: invited.invitation.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    });
    assert.equal(declined.code, "LEAGUE_INVITATION_DECLINED");
    assert.equal(declined.invitation.status, "declined");
    assert.equal(declined.membership.status, "ended");
    assert.equal(declined.membership.joinedAtMs, null);
    assert.equal(declined.managerAssignment, null);
    assert.equal(tableCount(runtime.database, "team_manager_assignments"), 0);
    const counts = invitationCounts(runtime.database);
    const replay = service.decline({
      invitationId: invited.invitation.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    });
    assert.deepEqual(replay, declined);
    assert.equal(replay.replayed, true);
    assert.deepEqual(invitationCounts(runtime.database), counts);
    assert.throws(
      () =>
        service.accept({
          invitationId: invited.invitation.id,
          input: {},
          authenticated: authenticated(TARGET_ID),
        }),
      LeagueInvitationConflictError
    );
  });

  test("revalidates maximum teams, duplicate names, current assignment, and active membership", (t) => {
    const maximum = createRuntime(t, { maximumTeams: 2 });
    const maximumService = createService(maximum);
    const maximumInvite = maximumService.invite(
      invitationCommand(createTeamInput())
    );
    insertTeam(maximum.context, {
      id: uuid(22),
      name: "Second Existing Team",
    });
    const beforeMaximum = invitationCounts(maximum.database);
    assert.throws(
      () =>
        maximumService.accept({
          invitationId: maximumInvite.invitation.id,
          input: { teamName: "Third Team" },
          authenticated: authenticated(TARGET_ID),
        }),
      LeagueInvitationConflictError
    );
    assert.deepEqual(invitationCounts(maximum.database), beforeMaximum);

    const duplicate = createRuntime(t);
    const duplicateService = createService(duplicate);
    const duplicateInvite = duplicateService.invite(
      invitationCommand(createTeamInput())
    );
    const beforeDuplicate = invitationCounts(duplicate.database);
    assert.throws(
      () =>
        duplicateService.accept({
          invitationId: duplicateInvite.invitation.id,
          input: { teamName: "EXISTING TEAM" },
          authenticated: authenticated(TARGET_ID),
        }),
      LeagueInvitationConflictError
    );
    assert.deepEqual(invitationCounts(duplicate.database), beforeDuplicate);

    const manage = createRuntime(t);
    const manageService = createService(manage);
    const manageInvite = manageService.invite(
      invitationCommand(manageTeamInput())
    );
    manage.context.repositories.league_memberships.insert({
      id: uuid(60),
      league_id: LEAGUE_ID,
      user_id: TARGET_ID,
      permission_category: "member",
      status: "active",
      joined_at_ms: NOW_MS,
      ended_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    const beforeManage = invitationCounts(manage.database);
    assert.throws(
      () =>
        manageService.accept({
          invitationId: manageInvite.invitation.id,
          input: {},
          authenticated: authenticated(TARGET_ID),
        }),
      LeagueInvitationConflictError
    );
    assert.deepEqual(invitationCounts(manage.database), beforeManage);
  });

  test("rolls every create-team acceptance seam back to pending", (t) => {
    for (const seam of [
      "insertSetupTeam",
      "activateMembership",
      "insertAcceptedManagerAssignment",
      "acceptInvitation",
      "appendInvitationActivity",
    ]) {
      const runtime = createRuntime(t);
      const setupService = createService(runtime);
      const invited = setupService.invite(
        invitationCommand(createTeamInput())
      );
      const before = invitationCounts(runtime.database);
      const repository = {
        ...runtime.invitationRepository,
        [seam]() {
          throw new Error(`injected ${seam} failure`);
        },
      };
      assert.throws(
        () =>
          createService(runtime, {
            invitationRepository: repository,
          }).accept({
            invitationId: invited.invitation.id,
            input: { teamName: "Rollback Team" },
            authenticated: authenticated(TARGET_ID),
          }),
        /repository operation failed/i
      );
      assert.deepEqual(invitationCounts(runtime.database), before);
      const row = runtime.invitationRepository.findInvitationAggregate(
        invited.invitation.id
      );
      assert.equal(row.invitation_status, "pending");
      assert.equal(row.membership_status, "invited");
      assert.equal(row.invited_team_id, null);
    }
  });

  test("rolls decline seams and every Security Audit failure back", (t) => {
    for (const seam of [
      "endNeverActiveMembership",
      "cancelInvitation",
      "appendInvitationActivity",
    ]) {
      const runtime = createRuntime(t);
      const setupService = createService(runtime);
      const invited = setupService.invite(
        invitationCommand(manageTeamInput())
      );
      const before = invitationCounts(runtime.database);
      const repository = {
        ...runtime.invitationRepository,
        [seam]() {
          throw new Error(`injected ${seam} failure`);
        },
      };
      assert.throws(
        () =>
          createService(runtime, {
            invitationRepository: repository,
          }).decline({
            invitationId: invited.invitation.id,
            input: {},
            authenticated: authenticated(TARGET_ID),
          }),
        /repository operation failed/i
      );
      assert.deepEqual(invitationCounts(runtime.database), before);
    }

    for (const action of ["invite", "accept", "decline"]) {
      const runtime = createRuntime(t);
      const setupService = createService(runtime);
      const invited =
        action === "invite"
          ? null
          : setupService.invite(
              invitationCommand(
                action === "accept"
                  ? createTeamInput()
                  : manageTeamInput()
              )
            );
      const before = invitationCounts(runtime.database);
      const service = createService(runtime, {
        auditRepository: {
          append() {
            throw new Error("injected Security Audit failure");
          },
        },
      });
      assert.throws(
        () => {
          if (action === "invite") {
            service.invite(invitationCommand(createTeamInput()));
            return;
          }
          service[action]({
            invitationId: invited.invitation.id,
            input:
              action === "accept"
                ? { teamName: "Audit Rollback Team" }
                : {},
            authenticated: authenticated(TARGET_ID),
          });
        },
        /repository operation failed/i
      );
      assert.deepEqual(invitationCounts(runtime.database), before);
      if (invited) {
        const row = runtime.invitationRepository.findInvitationAggregate(
          invited.invitation.id
        );
        assert.equal(row.invitation_status, "pending");
        assert.equal(row.membership_status, "invited");
      }
    }
  });
});

function httpHeaders(sessionCookie, userId, {
  csrfToken = CSRF_TOKENS[userId],
  idempotencyKey = "http-league-invitation",
  includeCookie = true,
  origin = PUBLIC_FRONTEND_ORIGIN,
} = {}) {
  return {
    Origin: origin,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": idempotencyKey,
    ...(includeCookie
      ? {
          Cookie: `${sessionCookie.name}=${SESSION_TOKENS[userId]}`,
        }
      : {}),
  };
}

async function startLeagueInvitationApi(t, runtime) {
  const sessionCookie = createSessionCookie({
    appEnv: "staging",
    publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    sameSite: "none",
  });
  const userByToken = new Map(
    Object.entries(SESSION_TOKENS).map(([userId, token]) => [token, userId])
  );
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === PUBLIC_FRONTEND_ORIGIN;
    },
    requestIdFactory() {
      return "m3-15-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap(rawSessionToken) {
        const userId = userByToken.get(rawSessionToken);
        return userId
          ? authenticated(userId)
          : { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf({ rawSessionToken, rawCsrfToken }) {
        const userId = userByToken.get(rawSessionToken);
        if (!userId) return { valid: false, code: "SESSION_INVALID" };
        if (rawCsrfToken !== CSRF_TOKENS[userId]) {
          return { valid: false, code: "CSRF_INVALID" };
        }
        return authenticated(userId);
      },
    },
  });
  const app = express();
  app.use(
    createLeagueInvitationRouter({
      requestSecurity,
      leagueInvitationService: createService(runtime),
      auditPrivacyDigest: {
        digest() {
          return { digest: "e".repeat(64), keyVersion: 1 };
        },
      },
      networkSourceResolver() {
        return "198.51.100.0/24";
      },
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    sessionCookie,
  };
}

describe("M3-15 isolated league-invitation HTTP contract", () => {
  test("creates, replays, reads, and accepts create-team through safe envelopes", async (t) => {
    const runtime = createRuntime(t);
    const api = await startLeagueInvitationApi(t, runtime);
    const invitationUrl = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/invitations`,
      api.baseUrl
    );
    const commissionerHeaders = httpHeaders(
      api.sessionCookie,
      COMMISSIONER_ID
    );
    const created = await fetch(invitationUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: JSON.stringify(createTeamInput()),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal(
      created.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    assert.equal(
      created.headers.get("access-control-allow-credentials"),
      "true"
    );
    assert.equal(created.headers.get("set-cookie"), null);
    assert.equal(createdBody.data.code, "LEAGUE_INVITATION_CREATED");
    assert.equal(createdBody.meta.requestId, "m3-15-request");
    assert.equal(JSON.stringify(createdBody).includes("replayed"), false);

    const replay = await fetch(invitationUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: JSON.stringify(createTeamInput()),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).data, createdBody.data);

    const invitationId = createdBody.data.invitation.id;
    const targetUrl = new URL(
      `/api/v1/league-invitations/${invitationId}`,
      api.baseUrl
    );
    const read = await fetch(targetUrl, {
      headers: httpHeaders(api.sessionCookie, TARGET_ID),
    });
    const readBody = await read.json();
    assert.equal(read.status, 200);
    assert.equal(readBody.data.code, "LEAGUE_INVITATION_FOUND");
    assert.equal(readBody.data.invitation.id, invitationId);
    assert.equal(read.headers.get("set-cookie"), null);

    const hidden = await fetch(targetUrl, {
      headers: httpHeaders(api.sessionCookie, OTHER_ID),
    });
    assert.equal(hidden.status, 404);
    assert.equal(
      (await hidden.json()).error.code,
      "LEAGUE_INVITATION_NOT_FOUND"
    );

    const accepted = await fetch(
      new URL(`${targetUrl.pathname}/accept`, api.baseUrl),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, TARGET_ID),
        body: JSON.stringify({ teamName: "HTTP Orcas" }),
      }
    );
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.data.code, "LEAGUE_INVITATION_ACCEPTED");
    assert.equal(acceptedBody.data.team.name, "HTTP Orcas");
    assert.equal(acceptedBody.data.membership.status, "active");
    assert.equal(acceptedBody.data.managerAssignment.status, "accepted");
    assert.equal(accepted.headers.get("set-cookie"), null);
  });

  test("declines manage-team without granting authority", async (t) => {
    const runtime = createRuntime(t);
    const api = await startLeagueInvitationApi(t, runtime);
    const created = await fetch(
      new URL(`/api/v1/leagues/${LEAGUE_ID}/invitations`, api.baseUrl),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID),
        body: JSON.stringify(manageTeamInput()),
      }
    );
    const invitationId = (await created.json()).data.invitation.id;
    const declined = await fetch(
      new URL(
        `/api/v1/league-invitations/${invitationId}/decline`,
        api.baseUrl
      ),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, TARGET_ID),
        body: JSON.stringify({}),
      }
    );
    const body = await declined.json();
    assert.equal(declined.status, 200);
    assert.equal(body.data.code, "LEAGUE_INVITATION_DECLINED");
    assert.equal(body.data.membership.status, "ended");
    assert.equal(body.data.managerAssignment, null);
    assert.equal(tableCount(runtime.database, "team_manager_assignments"), 0);
  });

  test("maps malformed, session, CSRF, Origin, body, authority, and state failures without partial writes", async (t) => {
    const runtime = createRuntime(t);
    const api = await startLeagueInvitationApi(t, runtime);
    const url = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/invitations`,
      api.baseUrl
    );
    const malformed = await fetch(url, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID),
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      (await malformed.json()).error.code,
      "LEAGUE_INVITATION_INVALID"
    );
    const extra = await fetch(url, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID),
      body: JSON.stringify({ ...createTeamInput(), role: "manager" }),
    });
    assert.equal(extra.status, 400);
    const signedOut = await fetch(url, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        includeCookie: false,
      }),
      body: JSON.stringify(createTeamInput()),
    });
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");
    const badCsrf = await fetch(url, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        csrfToken: "invalid-csrf",
      }),
      body: JSON.stringify(createTeamInput()),
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error.code, "CSRF_INVALID");
    const badOrigin = await fetch(url, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        origin: "https://evil.example",
      }),
      body: JSON.stringify(createTeamInput()),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, "ORIGIN_NOT_ALLOWED");
    const notCommissioner = await fetch(url, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, OTHER_ID),
      body: JSON.stringify(createTeamInput()),
    });
    assert.equal(notCommissioner.status, 404);
    assert.equal((await notCommissioner.json()).error.code, "LEAGUE_NOT_FOUND");
    assert.equal(tableCount(runtime.database, "league_invitations"), 0);
    assert.equal(tableCount(runtime.database, "idempotency_requests"), 0);
  });
});
