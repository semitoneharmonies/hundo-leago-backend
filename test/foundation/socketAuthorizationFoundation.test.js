const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createSessionService,
} = require(
  "../../src/application/services/accounts/createSessionService"
);
const {
  SOCKET_AUTHORIZATION_CODES,
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
  SESSION_REFRESH_INTERVAL_MS,
} = require(
  "../../src/domain/accounts/sessionPolicy"
);
const {
  SocketInvalidationError,
  createSocketInvalidation,
} = require(
  "../../src/domain/leagues/socketInvalidation"
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
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteSessionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSessionRepository"
);
const {
  createSqliteTeamAuthorityRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createSessionSecrets,
} = require(
  "../../src/infrastructure/security/createSessionSecrets"
);
const {
  createSecureRandom,
} = require(
  "../../src/infrastructure/security/createSecureRandom"
);
const {
  createSystemClock,
} = require(
  "../../src/infrastructure/security/createSystemClock"
);
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");
const {
  AUTHORITY_DATA_KEY,
  createAuthenticatedSocketRooms,
} = require(
  "../../src/transport/socket/createAuthenticatedSocketRooms"
);

const ORIGIN = "https://hundo.example";
const USER_ID =
  "00000000-0000-4000-8000-000000000001";
const LEAGUE_A_ID =
  "00000000-0000-4000-8000-000000000010";
const LEAGUE_B_ID =
  "00000000-0000-4000-8000-000000000011";
const RAW_SESSION_TOKEN = Buffer.alloc(32, 7).toString(
  "base64url"
);
const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T12:00:00.000Z");
const OTHER_USER_ID =
  "00000000-0000-4000-8000-000000000002";
const PLATFORM_USER_ID =
  "00000000-0000-4000-8000-000000000003";

function createHarness(overrides = {}) {
  const calls = {
    resolutionTokens: [],
    userIds: [],
  };
  const sessionCookie = createSessionCookie({
    appEnv: "production",
    publicFrontendOrigin: ORIGIN,
    sameSite: "lax",
  });
  const service = createSocketAuthorizationService({
    isAllowedOrigin: (origin) => origin === ORIGIN,
    sessionCookie,
    sessionService: {
      resolveWithoutActivity(rawSessionToken) {
        calls.resolutionTokens.push(rawSessionToken);
        return {
          valid: true,
          code: "SESSION_VALID",
          session: { userId: USER_ID },
          user: { id: USER_ID, status: "active" },
        };
      },
    },
    leagueAuthorization: {
      requireActiveUser(authenticated) {
        assert.equal(authenticated.valid, true);
        return { actorUserId: USER_ID, userVersion: 1 };
      },
    },
    leagueAccessRepository: {
      listVisibleLeagues(userId) {
        calls.userIds.push(userId);
        return [
          {
            league_id: LEAGUE_B_ID,
            league_status: "setup",
            membership_status: "active",
          },
          {
            league_id: LEAGUE_A_ID,
            league_status: "active",
            membership_status: "active",
          },
        ];
      },
    },
    teamAuthorityRepository: {
      listCurrentManagedTeams() {
        return [];
      },
    },
    ...overrides,
  });
  return { calls, service, sessionCookie };
}

function handshake(sessionCookie, overrides = {}) {
  return {
    headers: {
      origin: ORIGIN,
      cookie: sessionCookie
        .serialize(RAW_SESSION_TOKEN)
        .split(";", 1)[0],
    },
    auth: {
      userId: "client-user",
      leagueId: "client-league",
      room: "league:client-room",
    },
    query: {
      role: "commissioner",
    },
    ...overrides,
  };
}

function createFakeSocket(socketHandshake) {
  return {
    id: "socket-1",
    handshake: socketHandshake,
    data: {},
    rooms: new Set(["socket-1"]),
    disconnected: false,
    disconnectForce: null,
    async join(room) {
      this.rooms.add(room);
    },
    async leave(room) {
      this.rooms.delete(room);
    },
    disconnect(force) {
      this.disconnected = true;
      this.disconnectForce = force;
      this.rooms.clear();
    },
  };
}

function runMiddleware(middleware, socket) {
  return new Promise((resolve) => {
    middleware(socket, (error) => resolve(error));
  });
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function createDeterministicSecureRandom() {
  let nextByte = 40;
  let nextId = 900;
  return createSecureRandom({
    randomBytes(byteLength) {
      const output = Buffer.alloc(byteLength, nextByte);
      nextByte += 1;
      return output;
    },
    randomUUID() {
      const output = uuid(nextId);
      nextId += 1;
      return output;
    },
  });
}

function insertDatabaseUser(repositories, id, label) {
  const email = `${label
    .toLowerCase()
    .replaceAll(" ", "-")}@example.test`;
  return repositories.users.insert({
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

function insertDatabaseLeague(repositories, id, name) {
  return repositories.leagues.insert({
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

function insertDatabaseMembership(
  repositories,
  {
    id,
    leagueId,
    userId,
    status,
    permissionCategory = "member",
  }
) {
  return repositories.league_memberships.insert({
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status,
    joined_at_ms: status === "active" ? NOW_MS : null,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function databaseSemanticState(database) {
  const tableNames = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name ASC"
    )
    .all()
    .map(({ name }) => name);
  const tables = tableNames.map((tableName) => {
    const rows = database
      .prepare(`SELECT * FROM "${tableName}" ORDER BY rowid ASC`)
      .all();
    return {
      tableName,
      count: rows.length,
      rows,
    };
  });
  return Object.freeze({
    counts: Object.freeze(
      Object.fromEntries(
        tables.map(({ tableName, count }) => [
          tableName,
          count,
        ])
      )
    ),
    hash: crypto
      .createHash("sha256")
      .update(JSON.stringify(tables), "utf8")
      .digest("hex"),
  });
}

function createDatabaseRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-13-socket-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-13-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });

  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  insertDatabaseUser(context.repositories, USER_ID, "Socket User");
  insertDatabaseUser(
    context.repositories,
    OTHER_USER_ID,
    "Other User"
  );
  insertDatabaseUser(
    context.repositories,
    PLATFORM_USER_ID,
    "Platform User"
  );
  const leagueA = insertDatabaseLeague(
    context.repositories,
    LEAGUE_A_ID,
    "Socket League Alpha"
  );
  const leagueB = insertDatabaseLeague(
    context.repositories,
    LEAGUE_B_ID,
    "Socket League Bravo"
  );
  const membershipA = insertDatabaseMembership(
    context.repositories,
    {
      id: uuid(300),
      leagueId: LEAGUE_A_ID,
      userId: USER_ID,
      status: "active",
    }
  );
  const membershipB = insertDatabaseMembership(
    context.repositories,
    {
      id: uuid(301),
      leagueId: LEAGUE_B_ID,
      userId: USER_ID,
      status: "invited",
    }
  );
  insertDatabaseMembership(context.repositories, {
    id: uuid(302),
    leagueId: LEAGUE_B_ID,
    userId: OTHER_USER_ID,
    status: "active",
    permissionCategory: "commissioner",
  });
  context.repositories.platform_roles.insert({
    id: uuid(400),
    user_id: PLATFORM_USER_ID,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });

  const users = createSqliteUserRepository({
    database: connection.database,
  });
  const sessions = createSqliteSessionRepository({
    database: connection.database,
  });
  const leagueAccessRepository =
    createSqliteLeagueAccessRepository({
      database: connection.database,
    });
  const time = { nowMs: NOW_MS };
  const secureRandom = createDeterministicSecureRandom();
  const sessionService = createSessionService({
    userRepository: users,
    sessionRepository: sessions,
    sessionSecrets: createSessionSecrets({ secureRandom }),
    clock: createSystemClock({
      now: () => time.nowMs,
    }),
    secureRandom,
  });
  const sessionCookie = createSessionCookie({
    appEnv: "production",
    publicFrontendOrigin: ORIGIN,
    sameSite: "lax",
  });
  const leagueAuthorization =
    createLeagueAuthorizationService({
      userRepository: users,
      leagueAccessRepository,
    });
  const authorizationService =
    createSocketAuthorizationService({
      isAllowedOrigin: (origin) => origin === ORIGIN,
      sessionCookie,
      sessionService,
      leagueAuthorization,
      leagueAccessRepository,
      teamAuthorityRepository:
        createSqliteTeamAuthorityRepository({
          database: connection.database,
        }),
    });
  const roomManager = createAuthenticatedSocketRooms({
    authorizationService,
  });
  const issued = sessionService.issueForUser({
    userId: USER_ID,
  });

  return {
    ...connection,
    authorizationService,
    context,
    issued,
    leagueA,
    leagueB,
    membershipA,
    membershipB,
    roomManager,
    sessionCookie,
    sessionService,
    sessions,
    time,
    users,
  };
}

function databaseHandshake(runtime, issued = runtime.issued) {
  return {
    headers: {
      origin: ORIGIN,
      cookie: runtime.sessionCookie
        .serialize(issued.rawSessionToken)
        .split(";", 1)[0],
    },
    auth: {
      userId: OTHER_USER_ID,
      leagueId: LEAGUE_B_ID,
      room: `league:${LEAGUE_B_ID}`,
    },
  };
}

describe("M3-13 socket authorization", () => {
  test("derives deterministic user and league rooms from backend authority only", () => {
    const runtime = createHarness();

    const authority =
      runtime.service.authorizeHandshake(
        handshake(runtime.sessionCookie)
      );

    assert.deepEqual(authority, {
      userId: USER_ID,
      rooms: [
        `user:${USER_ID}`,
        `league:${LEAGUE_A_ID}`,
        `league:${LEAGUE_B_ID}`,
      ],
    });
    assert.deepEqual(runtime.calls.userIds, [USER_ID]);
    assert.deepEqual(runtime.calls.resolutionTokens, [
      RAW_SESSION_TOKEN,
    ]);
    assert.equal(
      JSON.stringify(authority).includes(RAW_SESSION_TOKEN),
      false
    );
    assert.equal(
      JSON.stringify(authority).includes("client"),
      false
    );
  });

  test("rejects missing and non-exact origins before reading the session", () => {
    const runtime = createHarness();
    for (const origin of [
      undefined,
      "https://hundo.example/",
      "https://attacker.example",
    ]) {
      assert.throws(
        () =>
          runtime.service.authorizeHandshake(
            handshake(runtime.sessionCookie, {
              headers: {
                origin,
                cookie: runtime.sessionCookie
                  .serialize(RAW_SESSION_TOKEN)
                  .split(";", 1)[0],
              },
            })
          ),
        (error) =>
          error.code ===
          SOCKET_AUTHORIZATION_CODES.originNotAllowed
      );
    }
    assert.deepEqual(runtime.calls.resolutionTokens, []);
  });

  test("uses one configured cookie and returns one generic session failure", () => {
    const invalidSessionService = {
      resolveWithoutActivity() {
        return {
          valid: false,
          code: "SESSION_INVALID",
        };
      },
    };
    const runtime = createHarness({
      sessionService: invalidSessionService,
    });
    const cookie = runtime.sessionCookie
      .serialize(RAW_SESSION_TOKEN)
      .split(";", 1)[0];

    for (const cookieHeader of [
      undefined,
      `${cookie}; ${cookie}`,
      "__Host-hl_session=malformed",
      cookie,
    ]) {
      assert.throws(
        () =>
          runtime.service.authorizeHandshake({
            headers: {
              origin: ORIGIN,
              cookie: cookieHeader,
            },
          }),
        (error) =>
          error.code ===
            SOCKET_AUTHORIZATION_CODES.sessionRequired &&
          !error.message.includes(RAW_SESSION_TOKEN)
      );
    }
  });

  test("skips inactive visibility rows and fails closed on malformed stable IDs", () => {
    const runtime = createHarness({
      leagueAccessRepository: {
        listVisibleLeagues() {
          return [
            {
              league_id: LEAGUE_A_ID,
              league_status: "active",
              membership_status: "invited",
            },
            {
              league_id: LEAGUE_B_ID,
              league_status: "deleted",
              membership_status: "active",
            },
          ];
        },
      },
    });
    assert.deepEqual(
      runtime.service.authorizeHandshake(
        handshake(runtime.sessionCookie)
      ).rooms,
      [`user:${USER_ID}`]
    );

    const malformed = createHarness({
      leagueAccessRepository: {
        listVisibleLeagues() {
          return [
            {
              league_id: "not-a-stable-id",
              league_status: "active",
              membership_status: "active",
            },
          ];
        },
      },
    });
    assert.throws(
      () =>
        malformed.service.authorizeHandshake(
          handshake(malformed.sessionCookie)
        ),
      (error) =>
        error.code ===
        SOCKET_AUTHORIZATION_CODES.sessionRequired
    );
  });

  test("middleware joins only backend-managed rooms and stores safe authority", async () => {
    const runtime = createHarness();
    const roomManager = createAuthenticatedSocketRooms({
      authorizationService: runtime.service,
    });
    const socket = createFakeSocket(
      handshake(runtime.sessionCookie)
    );

    const error = await runMiddleware(
      roomManager.middleware,
      socket
    );

    assert.equal(error, undefined);
    assert.deepEqual([...socket.rooms].sort(), [
      `league:${LEAGUE_A_ID}`,
      `league:${LEAGUE_B_ID}`,
      "socket-1",
      `user:${USER_ID}`,
    ]);
    assert.deepEqual(
      socket.data[AUTHORITY_DATA_KEY],
      roomManager.getAuthority(socket)
    );
    assert.equal(
      JSON.stringify(socket.data).includes(
        RAW_SESSION_TOKEN
      ),
      false
    );
  });

  test("reauthorization leaves stale rooms and joins only current rooms", async () => {
    let callCount = 0;
    const authorizationService = {
      authorizeHandshake() {
        callCount += 1;
        return Object.freeze({
          userId: USER_ID,
          rooms: Object.freeze(
            callCount === 1
              ? [
                  `user:${USER_ID}`,
                  `league:${LEAGUE_A_ID}`,
                ]
              : [
                  `user:${USER_ID}`,
                  `league:${LEAGUE_B_ID}`,
                ]
          ),
        });
      },
    };
    const roomManager = createAuthenticatedSocketRooms({
      authorizationService,
    });
    const socket = createFakeSocket({ headers: {} });
    assert.equal(
      await runMiddleware(roomManager.middleware, socket),
      undefined
    );

    assert.equal(await roomManager.reauthorize(socket), true);
    assert.equal(
      socket.rooms.has(`league:${LEAGUE_A_ID}`),
      false
    );
    assert.equal(
      socket.rooms.has(`league:${LEAGUE_B_ID}`),
      true
    );
    assert.equal(socket.rooms.has(`user:${USER_ID}`), true);
    assert.equal(socket.disconnected, false);
  });

  test("middleware reports safe errors and failed reauthorization disconnects", async () => {
    let valid = false;
    const authorizationService = {
      authorizeHandshake() {
        if (!valid) {
          const error = new Error(RAW_SESSION_TOKEN);
          error.code =
            SOCKET_AUTHORIZATION_CODES.sessionRequired;
          throw error;
        }
        return {
          userId: USER_ID,
          rooms: [`user:${USER_ID}`],
        };
      },
    };
    const roomManager = createAuthenticatedSocketRooms({
      authorizationService,
    });
    const socket = createFakeSocket({ headers: {} });
    const error = await runMiddleware(
      roomManager.middleware,
      socket
    );
    assert.deepEqual(error.data, {
      code: SOCKET_AUTHORIZATION_CODES.sessionRequired,
    });
    assert.equal(error.message.includes(RAW_SESSION_TOKEN), false);

    valid = true;
    assert.equal(
      await runMiddleware(roomManager.middleware, socket),
      undefined
    );
    valid = false;
    assert.equal(await roomManager.reauthorize(socket), false);
    assert.equal(socket.disconnected, true);
    assert.equal(socket.disconnectForce, true);
    assert.equal(roomManager.getAuthority(socket), null);
  });
});

describe("M3-13 current SQLite socket authority", () => {
  test("handshake derives active league visibility without changing any table", async (t) => {
    const runtime = createDatabaseRuntime(t);
    runtime.time.nowMs += SESSION_REFRESH_INTERVAL_MS;
    const before = databaseSemanticState(runtime.database);
    const socket = createFakeSocket(
      databaseHandshake(runtime)
    );

    assert.equal(
      await runMiddleware(runtime.roomManager.middleware, socket),
      undefined
    );

    assert.deepEqual([...socket.rooms].sort(), [
      `league:${LEAGUE_A_ID}`,
      "socket-1",
      `user:${USER_ID}`,
    ]);
    assert.equal(
      socket.rooms.has(`league:${LEAGUE_B_ID}`),
      false
    );
    assert.deepEqual(
      databaseSemanticState(runtime.database),
      before
    );
  });

  test("reauthorization follows current membership and deleted-league state without hidden writes", async (t) => {
    const runtime = createDatabaseRuntime(t);
    const socket = createFakeSocket(
      databaseHandshake(runtime)
    );
    assert.equal(
      await runMiddleware(runtime.roomManager.middleware, socket),
      undefined
    );

    const changedAtMs = NOW_MS + 1;
    runtime.membershipA =
      runtime.context.repositories.league_memberships.updateVersioned(
        {
          key: runtime.membershipA.id,
          leagueId: LEAGUE_A_ID,
          expectedVersion: runtime.membershipA.version,
          changes: {
            status: "ended",
            ended_at_ms: changedAtMs,
            updated_at_ms: changedAtMs,
          },
        }
      );
    runtime.membershipB =
      runtime.context.repositories.league_memberships.updateVersioned(
        {
          key: runtime.membershipB.id,
          leagueId: LEAGUE_B_ID,
          expectedVersion: runtime.membershipB.version,
          changes: {
            status: "active",
            joined_at_ms: changedAtMs,
            updated_at_ms: changedAtMs,
          },
        }
      );
    let before = databaseSemanticState(runtime.database);

    assert.equal(
      await runtime.roomManager.reauthorize(socket),
      true
    );
    assert.equal(
      socket.rooms.has(`league:${LEAGUE_A_ID}`),
      false
    );
    assert.equal(
      socket.rooms.has(`league:${LEAGUE_B_ID}`),
      true
    );
    assert.deepEqual(
      databaseSemanticState(runtime.database),
      before
    );

    runtime.leagueB =
      runtime.context.repositories.leagues.updateVersioned({
        key: runtime.leagueB.id,
        expectedVersion: runtime.leagueB.version,
        changes: {
          status: "deleted",
          updated_at_ms: changedAtMs + 1,
        },
      });
    before = databaseSemanticState(runtime.database);
    assert.equal(
      await runtime.roomManager.reauthorize(socket),
      true
    );
    assert.deepEqual([...socket.rooms].sort(), [
      "socket-1",
      `user:${USER_ID}`,
    ]);
    assert.deepEqual(
      databaseSemanticState(runtime.database),
      before
    );
  });

  test("a platform administrator without membership receives only a user room", async (t) => {
    const runtime = createDatabaseRuntime(t);
    const issued = runtime.sessionService.issueForUser({
      userId: PLATFORM_USER_ID,
    });
    const before = databaseSemanticState(runtime.database);
    const socket = createFakeSocket(
      databaseHandshake(runtime, issued)
    );

    assert.equal(
      await runMiddleware(runtime.roomManager.middleware, socket),
      undefined
    );
    assert.deepEqual([...socket.rooms].sort(), [
      "socket-1",
      `user:${PLATFORM_USER_ID}`,
    ]);
    assert.deepEqual(
      databaseSemanticState(runtime.database),
      before
    );
  });

  test("session revocation disconnects without another database change", async (t) => {
    const runtime = createDatabaseRuntime(t);
    const socket = createFakeSocket(
      databaseHandshake(runtime)
    );
    assert.equal(
      await runMiddleware(runtime.roomManager.middleware, socket),
      undefined
    );
    runtime.sessionService.revoke({
      sessionId: runtime.issued.session.id,
      expectedVersion: runtime.issued.session.version,
      reason: "sign_out",
    });
    const before = databaseSemanticState(runtime.database);

    assert.equal(
      await runtime.roomManager.reauthorize(socket),
      false
    );
    assert.equal(socket.disconnected, true);
    assert.deepEqual(
      databaseSemanticState(runtime.database),
      before
    );
  });

  test("idle expiry disconnects without persisting an expiry transition", async (t) => {
    const runtime = createDatabaseRuntime(t);
    const socket = createFakeSocket(
      databaseHandshake(runtime)
    );
    assert.equal(
      await runMiddleware(runtime.roomManager.middleware, socket),
      undefined
    );
    runtime.time.nowMs =
      runtime.issued.session.idleExpiresAtMs;
    const before = databaseSemanticState(runtime.database);

    assert.equal(
      await runtime.roomManager.reauthorize(socket),
      false
    );
    assert.equal(socket.disconnected, true);
    assert.equal(
      runtime.sessions.findById(runtime.issued.session.id)
        .status,
      "active"
    );
    assert.deepEqual(
      databaseSemanticState(runtime.database),
      before
    );
  });

  test("current user inactivation disconnects without another database change", async (t) => {
    const runtime = createDatabaseRuntime(t);
    const socket = createFakeSocket(
      databaseHandshake(runtime)
    );
    assert.equal(
      await runMiddleware(runtime.roomManager.middleware, socket),
      undefined
    );
    const user = runtime.users.findById(USER_ID);
    runtime.users.updateVersioned({
      key: user.id,
      expectedVersion: user.version,
      changes: {
        status: "disabled",
        updated_at_ms: NOW_MS + 1,
      },
    });
    const before = databaseSemanticState(runtime.database);

    assert.equal(
      await runtime.roomManager.reauthorize(socket),
      false
    );
    assert.equal(socket.disconnected, true);
    assert.deepEqual(
      databaseSemanticState(runtime.database),
      before
    );
  });
});

describe("M3-13 metadata-only socket invalidation", () => {
  test("creates frozen user and league invalidation metadata without state", () => {
    const leagueEvent = createSocketInvalidation({
      eventType: "league.memberships.changed",
      scope: "league",
      scopeId: LEAGUE_A_ID,
      version: 2,
      changedAtMs: NOW_MS,
    });
    const userEvent = createSocketInvalidation({
      eventType: "user.notifications.changed",
      scope: "user",
      scopeId: USER_ID,
      changedAtMs: NOW_MS,
    });

    assert.deepEqual(leagueEvent, {
      kind: "invalidation",
      eventType: "league.memberships.changed",
      scope: "league",
      scopeId: LEAGUE_A_ID,
      version: 2,
      changedAtMs: NOW_MS,
    });
    assert.equal(Object.isFrozen(leagueEvent), true);
    assert.equal(Object.isFrozen(userEvent), true);
    for (const forbidden of [
      "payload",
      "email",
      "credential",
      "session",
      "token",
      "leagueState",
    ]) {
      assert.equal(
        JSON.stringify([leagueEvent, userEvent]).includes(
          forbidden
        ),
        false
      );
    }
  });

  test("rejects team scope, malformed metadata, private payload keys, and state-shaped inputs", () => {
    const base = {
      eventType: "league.memberships.changed",
      scope: "league",
      scopeId: LEAGUE_A_ID,
      version: 2,
    };
    for (const input of [
      { ...base, scope: "team" },
      { ...base, scopeId: "not-a-stable-id" },
      { ...base, eventType: "Private State" },
      { ...base, version: 0 },
      { ...base, changedAtMs: -1 },
      {
        eventType: base.eventType,
        scope: base.scope,
        scopeId: base.scopeId,
      },
      { ...base, payload: { private: true } },
      { ...base, email: "private@example.test" },
      null,
      [],
    ]) {
      assert.throws(
        () => createSocketInvalidation(input),
        SocketInvalidationError
      );
    }
  });
});
