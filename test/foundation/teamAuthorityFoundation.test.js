const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createSocketAuthorizationService,
} = require(
  "../../src/application/services/authorization/createSocketAuthorizationService"
);
const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  TeamAuthorizationInputError,
  TeamManagerRequiredError,
  TeamVisibilityError,
  createTeamAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireTeamManagerAuthority"
);
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
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteTeamAuthorityRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createAuthenticatedSocketRooms,
} = require(
  "../../src/transport/socket/createAuthenticatedSocketRooms"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T18:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID =
  "00000000-0000-4000-8000-000000000002";
const PLATFORM_USER_ID =
  "00000000-0000-4000-8000-000000000003";
const LEAGUE_A_ID =
  "00000000-0000-4000-8000-000000000010";
const LEAGUE_B_ID =
  "00000000-0000-4000-8000-000000000011";
const TEAM_A_ID =
  "00000000-0000-4000-8000-000000000020";
const TEAM_B_ID =
  "00000000-0000-4000-8000-000000000021";
const MEMBERSHIP_A_ID =
  "00000000-0000-4000-8000-000000000030";
const MEMBERSHIP_B_ID =
  "00000000-0000-4000-8000-000000000031";
const ORIGIN = "https://hundo.example";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function authenticated(userId = USER_ID) {
  return {
    valid: true,
    code: "SESSION_VALID",
    session: {
      id: uuid(500),
      userId,
      version: 1,
    },
    user: {
      id: userId,
      status: "active",
      version: 1,
    },
  };
}

function insertUser(repositories, id, label) {
  const email = `${label.toLowerCase()}@example.test`;
  repositories.users.insert({
    id,
    email_normalized: email,
    email_display: email,
    display_name: label,
    display_name_normalized: label.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertLeague(repositories, id, name) {
  repositories.leagues.insert({
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

function insertMembership(
  repositories,
  {
    id,
    leagueId,
    userId,
    permissionCategory = "manager",
  }
) {
  return repositories.league_memberships.insert({
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertTeam(repositories, { id, leagueId }) {
  return repositories.teams.insert({
    id,
    league_id: leagueId,
    name: "Same Team",
    name_normalized: "same team",
    status: "setup",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertAssignment(
  repositories,
  {
    id,
    leagueId,
    teamId,
    userId,
    membershipId,
    status,
  }
) {
  return repositories.team_manager_assignments.insert({
    id,
    league_id: leagueId,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: OTHER_USER_ID,
    status,
    assigned_at_ms: NOW_MS,
    accepted_at_ms: status === "accepted" ? NOW_MS : null,
    ended_at_ms: null,
    version: 1,
  });
}

function semanticHash(database) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name ASC"
    )
    .all()
    .map(({ name }) => ({
      name,
      rows: database
        .prepare(`SELECT * FROM "${name}" ORDER BY rowid ASC`)
        .all(),
    }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(tables), "utf8")
    .digest("hex");
}

function createFakeSocket() {
  return {
    id: "team-socket",
    handshake: {
      headers: {
        origin: ORIGIN,
        cookie: "opaque-cookie",
      },
      auth: {
        teamId: TEAM_B_ID,
        role: "manager",
        room: `team:${TEAM_B_ID}`,
      },
    },
    data: {},
    rooms: new Set(["team-socket"]),
    disconnected: false,
    async join(room) {
      this.rooms.add(room);
    },
    async leave(room) {
      this.rooms.delete(room);
    },
    disconnect() {
      this.disconnected = true;
      this.rooms.clear();
    },
  };
}

function runMiddleware(middleware, socket) {
  return new Promise((resolve) => {
    middleware(socket, (error) => resolve(error));
  });
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-14-team-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-14-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  const { repositories } = context;
  insertUser(repositories, USER_ID, "manager");
  insertUser(repositories, OTHER_USER_ID, "commissioner");
  insertUser(repositories, PLATFORM_USER_ID, "platform");
  insertLeague(repositories, LEAGUE_A_ID, "League Alpha");
  insertLeague(repositories, LEAGUE_B_ID, "League Bravo");
  const membershipA = insertMembership(repositories, {
    id: MEMBERSHIP_A_ID,
    leagueId: LEAGUE_A_ID,
    userId: USER_ID,
  });
  const membershipB = insertMembership(repositories, {
    id: MEMBERSHIP_B_ID,
    leagueId: LEAGUE_B_ID,
    userId: USER_ID,
  });
  insertMembership(repositories, {
    id: uuid(32),
    leagueId: LEAGUE_A_ID,
    userId: OTHER_USER_ID,
    permissionCategory: "commissioner",
  });
  insertMembership(repositories, {
    id: uuid(33),
    leagueId: LEAGUE_A_ID,
    userId: PLATFORM_USER_ID,
    permissionCategory: "member",
  });
  repositories.platform_roles.insert({
    id: uuid(34),
    user_id: PLATFORM_USER_ID,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  const teamA = insertTeam(repositories, {
    id: TEAM_A_ID,
    leagueId: LEAGUE_A_ID,
  });
  const teamB = insertTeam(repositories, {
    id: TEAM_B_ID,
    leagueId: LEAGUE_B_ID,
  });
  const assignmentA = insertAssignment(repositories, {
    id: uuid(100),
    leagueId: LEAGUE_A_ID,
    teamId: TEAM_A_ID,
    userId: USER_ID,
    membershipId: MEMBERSHIP_A_ID,
    status: "accepted",
  });
  const assignmentB = insertAssignment(repositories, {
    id: uuid(101),
    leagueId: LEAGUE_B_ID,
    teamId: TEAM_B_ID,
    userId: USER_ID,
    membershipId: MEMBERSHIP_B_ID,
    status: "pending",
  });
  const teamRepository =
    createSqliteTeamAuthorityRepository({
      database: connection.database,
    });
  const leagueAccessRepository =
    createSqliteLeagueAccessRepository({
      database: connection.database,
    });
  const leagueAuthorization =
    createLeagueAuthorizationService({
      userRepository: createSqliteUserRepository({
        database: connection.database,
      }),
      leagueAccessRepository,
    });
  return {
    ...connection,
    assignmentA,
    assignmentB,
    context,
    membershipA,
    membershipB,
    repository: teamRepository,
    leagueAccessRepository,
    leagueAuthorization,
    teamAuthorization: createTeamAuthorizationService({
      leagueAuthorization,
      teamAuthorityRepository: teamRepository,
    }),
    teamA,
    teamB,
  };
}

describe("M3-14 SELECT-only team authority repository", () => {
  test("returns only current same-league accepted manager authority", (t) => {
    const runtime = createRuntime(t);
    const before = semanticHash(runtime.database);

    assert.deepEqual(
      runtime.repository.findTeam({
        leagueId: LEAGUE_A_ID,
        teamId: TEAM_A_ID,
      }),
      {
        team_id: TEAM_A_ID,
        league_id: LEAGUE_A_ID,
        team_name: "Same Team",
        team_status: "setup",
        team_version: 1,
      }
    );
    assert.equal(
      runtime.repository.findTeam({
        leagueId: LEAGUE_B_ID,
        teamId: TEAM_A_ID,
      }),
      null
    );
    const current =
      runtime.repository.findCurrentManagerAssignment({
        leagueId: LEAGUE_A_ID,
        teamId: TEAM_A_ID,
        userId: USER_ID,
        membershipId: MEMBERSHIP_A_ID,
      });
    assert.equal(current.assignment_id, runtime.assignmentA.id);
    assert.equal(current.assignment_status, "accepted");
    assert.equal(
      runtime.repository.findCurrentManagerAssignment({
        leagueId: LEAGUE_B_ID,
        teamId: TEAM_B_ID,
        userId: USER_ID,
        membershipId: MEMBERSHIP_B_ID,
      }),
      null
    );
    assert.deepEqual(
      runtime.repository
        .listCurrentManagedTeams(USER_ID)
        .map(({ team_id }) => team_id),
      [TEAM_A_ID]
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("rejects malformed IDs without querying or writing", (t) => {
    const runtime = createRuntime(t);
    const before = semanticHash(runtime.database);
    for (const action of [
      () =>
        runtime.repository.findTeam({
          leagueId: "bad-league",
          teamId: TEAM_A_ID,
        }),
      () =>
        runtime.repository.findCurrentManagerAssignment({
          leagueId: LEAGUE_A_ID,
          teamId: TEAM_A_ID,
          userId: USER_ID,
          membershipId: "bad-membership",
        }),
      () => runtime.repository.listCurrentManagedTeams("bad-user"),
    ]) {
      assert.throws(
        action,
        (error) =>
          error.code ===
          REPOSITORY_ERROR_CODES.argumentInvalid
      );
    }
    assert.equal(semanticHash(runtime.database), before);
  });
});

describe("M3-14 backend-derived team-manager authorization", () => {
  test("requires current membership, exact team scope, and accepted assignment", (t) => {
    const runtime = createRuntime(t);
    const before = semanticHash(runtime.database);

    assert.deepEqual(
      runtime.teamAuthorization.requireManager(
        authenticated(),
        LEAGUE_A_ID,
        TEAM_A_ID
      ),
      {
        authorized: true,
        actorUserId: USER_ID,
        assignmentId: runtime.assignmentA.id,
        assignmentVersion: 1,
        authority: "manager",
        code: "TEAM_MANAGER_AUTHORIZED",
        leagueId: LEAGUE_A_ID,
        leagueVersion: 1,
        membershipId: MEMBERSHIP_A_ID,
        membershipVersion: 1,
        permissionCategory: "manager",
        teamId: TEAM_A_ID,
        teamStatus: "setup",
        teamVersion: 1,
        userVersion: 1,
      }
    );
    assert.throws(
      () =>
        runtime.teamAuthorization.requireManager(
          authenticated(),
          LEAGUE_B_ID,
          TEAM_B_ID
        ),
      TeamManagerRequiredError
    );
    assert.throws(
      () =>
        runtime.teamAuthorization.requireManager(
          authenticated(),
          LEAGUE_B_ID,
          TEAM_A_ID
        ),
      TeamVisibilityError
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("rejects malformed, mismatched, and client-claimed authority without writes", (t) => {
    const runtime = createRuntime(t);
    const before = semanticHash(runtime.database);
    assert.throws(
      () =>
        runtime.teamAuthorization.requireManager(
          {
            ...authenticated(),
            role: "commissioner",
            teamId: TEAM_A_ID,
          },
          LEAGUE_A_ID,
          "bad-team"
        ),
      TeamAuthorizationInputError
    );
    assert.throws(
      () =>
        runtime.teamAuthorization.requireManager(
          authenticated(OTHER_USER_ID),
          LEAGUE_A_ID,
          TEAM_A_ID
        ),
      TeamManagerRequiredError
    );
    assert.throws(
      () =>
        runtime.teamAuthorization.requireManager(
          authenticated(PLATFORM_USER_ID),
          LEAGUE_A_ID,
          TEAM_A_ID
        ),
      TeamManagerRequiredError
    );
    assert.equal(semanticHash(runtime.database), before);
  });

  test("ended assignment and inactive membership remove current authority", (t) => {
    const runtime = createRuntime(t);
    runtime.assignmentA =
      runtime.context.repositories.team_manager_assignments.updateVersioned(
        {
          key: runtime.assignmentA.id,
          leagueId: LEAGUE_A_ID,
          expectedVersion: runtime.assignmentA.version,
          changes: {
            status: "ended",
            ended_at_ms: NOW_MS + 1,
          },
        }
      );
    let before = semanticHash(runtime.database);
    assert.throws(
      () =>
        runtime.teamAuthorization.requireManager(
          authenticated(),
          LEAGUE_A_ID,
          TEAM_A_ID
        ),
      TeamManagerRequiredError
    );
    assert.equal(semanticHash(runtime.database), before);

    runtime.membershipA =
      runtime.context.repositories.league_memberships.updateVersioned(
        {
          key: runtime.membershipA.id,
          leagueId: LEAGUE_A_ID,
          expectedVersion: runtime.membershipA.version,
          changes: {
            status: "suspended",
            updated_at_ms: NOW_MS + 2,
          },
        }
      );
    before = semanticHash(runtime.database);
    assert.throws(
      () =>
        runtime.teamAuthorization.requireManager(
          authenticated(),
          LEAGUE_A_ID,
          TEAM_A_ID
        ),
      (error) => error.code === "LEAGUE_NOT_FOUND"
    );
    assert.equal(semanticHash(runtime.database), before);
  });
});

describe("M3-14 authenticated team Socket.IO rooms", () => {
  test("joins, replaces, and removes only current backend-derived team rooms", async (t) => {
    const runtime = createRuntime(t);
    const socketAuthorization =
      createSocketAuthorizationService({
        isAllowedOrigin: (origin) => origin === ORIGIN,
        sessionCookie: {
          read() {
            return "internal-session-token";
          },
        },
        sessionService: {
          resolveWithoutActivity() {
            return authenticated();
          },
        },
        leagueAuthorization: runtime.leagueAuthorization,
        leagueAccessRepository:
          runtime.leagueAccessRepository,
        teamAuthorityRepository: runtime.repository,
      });
    const roomManager = createAuthenticatedSocketRooms({
      authorizationService: socketAuthorization,
    });
    const socket = createFakeSocket();
    let before = semanticHash(runtime.database);

    assert.equal(
      await runMiddleware(roomManager.middleware, socket),
      undefined
    );
    assert.deepEqual([...socket.rooms].sort(), [
      `league:${LEAGUE_A_ID}`,
      `league:${LEAGUE_B_ID}`,
      "team-socket",
      `team:${TEAM_A_ID}`,
      `user:${USER_ID}`,
    ]);
    assert.equal(socket.rooms.has(`team:${TEAM_B_ID}`), false);
    assert.equal(semanticHash(runtime.database), before);

    runtime.assignmentB =
      runtime.context.repositories.team_manager_assignments.updateVersioned(
        {
          key: runtime.assignmentB.id,
          leagueId: LEAGUE_B_ID,
          expectedVersion: runtime.assignmentB.version,
          changes: {
            status: "accepted",
            accepted_at_ms: NOW_MS + 1,
          },
        }
      );
    before = semanticHash(runtime.database);
    assert.equal(await roomManager.reauthorize(socket), true);
    assert.equal(socket.rooms.has(`team:${TEAM_A_ID}`), true);
    assert.equal(socket.rooms.has(`team:${TEAM_B_ID}`), true);
    assert.equal(semanticHash(runtime.database), before);

    runtime.assignmentA =
      runtime.context.repositories.team_manager_assignments.updateVersioned(
        {
          key: runtime.assignmentA.id,
          leagueId: LEAGUE_A_ID,
          expectedVersion: runtime.assignmentA.version,
          changes: {
            status: "ended",
            ended_at_ms: NOW_MS + 2,
          },
        }
      );
    before = semanticHash(runtime.database);
    assert.equal(await roomManager.reauthorize(socket), true);
    assert.equal(socket.rooms.has(`team:${TEAM_A_ID}`), false);
    assert.equal(socket.rooms.has(`team:${TEAM_B_ID}`), true);
    assert.equal(semanticHash(runtime.database), before);

    runtime.teamB = runtime.context.repositories.teams.updateVersioned({
      key: runtime.teamB.id,
      leagueId: LEAGUE_B_ID,
      expectedVersion: runtime.teamB.version,
      changes: {
        status: "erased",
        updated_at_ms: NOW_MS + 3,
      },
    });
    before = semanticHash(runtime.database);
    assert.equal(await roomManager.reauthorize(socket), true);
    assert.equal(socket.rooms.has(`team:${TEAM_B_ID}`), false);
    assert.equal(socket.rooms.has(`league:${LEAGUE_B_ID}`), true);
    assert.equal(semanticHash(runtime.database), before);
    assert.equal(socket.disconnected, false);
  });

  test("active-membership loss removes league and team rooms without ending the session", async (t) => {
    const runtime = createRuntime(t);
    const socketAuthorization =
      createSocketAuthorizationService({
        isAllowedOrigin: (origin) => origin === ORIGIN,
        sessionCookie: { read: () => "internal-session-token" },
        sessionService: {
          resolveWithoutActivity: () => authenticated(),
        },
        leagueAuthorization: runtime.leagueAuthorization,
        leagueAccessRepository:
          runtime.leagueAccessRepository,
        teamAuthorityRepository: runtime.repository,
      });
    const roomManager = createAuthenticatedSocketRooms({
      authorizationService: socketAuthorization,
    });
    const socket = createFakeSocket();
    assert.equal(
      await runMiddleware(roomManager.middleware, socket),
      undefined
    );
    runtime.membershipA =
      runtime.context.repositories.league_memberships.updateVersioned(
        {
          key: runtime.membershipA.id,
          leagueId: LEAGUE_A_ID,
          expectedVersion: runtime.membershipA.version,
          changes: {
            status: "suspended",
            updated_at_ms: NOW_MS + 1,
          },
        }
      );
    const before = semanticHash(runtime.database);

    assert.equal(await roomManager.reauthorize(socket), true);
    assert.equal(socket.rooms.has(`league:${LEAGUE_A_ID}`), false);
    assert.equal(socket.rooms.has(`team:${TEAM_A_ID}`), false);
    assert.equal(socket.rooms.has(`league:${LEAGUE_B_ID}`), true);
    assert.equal(socket.disconnected, false);
    assert.equal(semanticHash(runtime.database), before);
  });
});
