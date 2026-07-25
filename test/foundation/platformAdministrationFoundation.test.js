const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  PlatformAuthorizationError,
  createPlatformAuthorizationService,
} = require(
  "../../src/application/services/authorization/requirePlatformAdministrator"
);
const {
  LeagueIdempotencyConflictError,
  LeagueNameUnavailableError,
  createAdministrativeLeagueService,
} = require(
  "../../src/application/services/leagues/createAdministrativeLeagueService"
);
const {
  LeagueCreationPolicyError,
  validateIdempotencyKey,
  validateLeagueCreationInput,
} = require(
  "../../src/domain/leagues/leagueCreationPolicy"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueCreationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueCreationRepository"
);
const {
  createSqlitePlatformRoleRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository"
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
  createPlatformAdministrationRouter,
} = require(
  "../../src/transport/http/createPlatformAdministrationRouter"
);
const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ROLE_ID = "00000000-0000-4000-8000-000000000002";
const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-20T22:00:00.000Z");
const PUBLIC_FRONTEND_ORIGIN = "https://hundo.example";
const RAW_SESSION_TOKEN = Buffer.alloc(32, 0x61).toString("base64url");
const RAW_CSRF_TOKEN = Buffer.alloc(32, 0x62).toString("base64url");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function createPersistenceRuntime(t, { withAdministrator = false } = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-10-persistence-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-10-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  context.repositories.users.insert({
    id: USER_ID,
    email_normalized: "admin@example.test",
    email_display: "admin@example.test",
    display_name: "League Admin",
    display_name_normalized: "league admin",
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.sessions.insert({
    id: authenticated().session.id,
    user_id: USER_ID,
    token_digest: "e".repeat(64),
    csrf_secret_digest: "f".repeat(64),
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
  if (withAdministrator) {
    context.repositories.platform_roles.insert({
      id: ROLE_ID,
      user_id: USER_ID,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: null,
      granted_at_ms: NOW_MS,
      ended_at_ms: null,
      version: 1,
    });
  }
  const leagueCreationRepository =
    createSqliteLeagueCreationRepository({
      database: connection.database,
    });
  const userRepository = createSqliteUserRepository({
    database: connection.database,
  });
  const platformRoleRepository =
    createSqlitePlatformRoleRepository({
      database: connection.database,
    });
  const auditRepository =
    createSqliteSecurityAuditRepository({
      database: connection.database,
    });
  return {
    auditRepository,
    context,
    database: connection.database,
    platformAuthorization: createPlatformAuthorizationService({
      userRepository,
      platformRoleRepository,
    }),
    repository: leagueCreationRepository,
  };
}

function tableCount(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

function createLeagueService(
  runtime,
  { auditRepository, leagueCreationRepository } = {}
) {
  let nextId = 100;
  return createAdministrativeLeagueService({
    repositoryContext: runtime.context,
    platformAuthorization: runtime.platformAuthorization,
    leagueCreationRepository:
      leagueCreationRepository || runtime.repository,
    auditRepository: auditRepository || runtime.auditRepository,
    clock: { nowMs: () => NOW_MS },
    secureRandom: { id: () => uuid(nextId++) },
    currentSeason: {
      label: "2026",
      nhlSeasonKey: "20262027",
    },
  });
}

function authenticated(overrides = {}) {
  return {
    valid: true,
    code: "SESSION_VALID",
    session: {
      id: "00000000-0000-4000-8000-000000000003",
      userId: USER_ID,
      version: 1,
    },
    user: { id: USER_ID, status: "active", version: 1 },
    ...overrides,
  };
}

function repositories({ user = {}, role = {} } = {}) {
  const calls = [];
  return {
    calls,
    userRepository: {
      findById(userId) {
        calls.push(["user", userId]);
        return {
          id: USER_ID,
          status: "active",
          version: 7,
          ...user,
        };
      },
    },
    platformRoleRepository: {
      findActiveByUserId(userId) {
        calls.push(["role", userId]);
        return {
          id: ROLE_ID,
          user_id: USER_ID,
          role: "platform_administrator",
          status: "active",
          ended_at_ms: null,
          version: 4,
          ...role,
        };
      },
    },
  };
}

describe("M3-10 backend-derived platform authorization", () => {
  test("reloads current user and role and returns only safe authority metadata", () => {
    const runtime = repositories();
    const service = createPlatformAuthorizationService(runtime);

    const result = service.requireAdministrator(
      authenticated()
    );

    assert.deepEqual(runtime.calls, [
      ["user", USER_ID],
      ["role", USER_ID],
    ]);
    assert.deepEqual(result, {
      authorized: true,
      code: "PLATFORM_ADMINISTRATOR_AUTHORIZED",
      actorUserId: USER_ID,
      authority: "platform_administrator",
      roleId: ROLE_ID,
      roleVersion: 4,
      userVersion: 7,
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(JSON.stringify(result).includes("email"), false);
    assert.equal(JSON.stringify(result).includes("token"), false);
  });

  test("denies malformed or mismatched authenticated state before repository access", () => {
    for (const candidate of [
      null,
      {},
      authenticated({ valid: false }),
      authenticated({
        session: {
          userId: "00000000-0000-4000-8000-000000000099",
        },
      }),
      authenticated({ user: { id: "not-a-user-id" } }),
    ]) {
      const runtime = repositories();
      const service = createPlatformAuthorizationService(runtime);
      assert.throws(
        () => service.requireAdministrator(candidate),
        (error) =>
          error instanceof PlatformAuthorizationError &&
          error.code === "PLATFORM_ADMINISTRATOR_REQUIRED"
      );
      assert.deepEqual(runtime.calls, []);
    }
  });

  test("denies a missing or inactive current user without loading a role", () => {
    for (const user of [null, { status: "disabled" }]) {
      const runtime = repositories({ user });
      if (user === null) {
        runtime.userRepository.findById = (userId) => {
          runtime.calls.push(["user", userId]);
          return null;
        };
      }
      const service = createPlatformAuthorizationService(runtime);
      assert.throws(
        () => service.requireAdministrator(authenticated()),
        PlatformAuthorizationError
      );
      assert.deepEqual(runtime.calls, [["user", USER_ID]]);
    }
  });

  test("denies absent, ended, or mismatched current role authority", () => {
    const roles = [
      null,
      { status: "ended", ended_at_ms: 10 },
      { user_id: "00000000-0000-4000-8000-000000000099" },
      { role: "league_commissioner" },
    ];
    for (const role of roles) {
      const runtime = repositories({ role });
      if (role === null) {
        runtime.platformRoleRepository.findActiveByUserId =
          (userId) => {
            runtime.calls.push(["role", userId]);
            return null;
          };
      }
      const service = createPlatformAuthorizationService(runtime);
      assert.throws(
        () => service.requireAdministrator(authenticated()),
        PlatformAuthorizationError
      );
      assert.deepEqual(runtime.calls, [
        ["user", USER_ID],
        ["role", USER_ID],
      ]);
    }
  });

  test("rejects incomplete repository dependencies", () => {
    assert.throws(
      () => createPlatformAuthorizationService(),
      /requires a user repository/
    );
    assert.throws(
      () =>
        createPlatformAuthorizationService({
          userRepository: { findById() {} },
        }),
      /requires a platform-role repository/
    );
  });
});

describe("M3-10 specialized league-creation persistence", () => {
  test("stores the setup aggregate, audit activity, and completed idempotency evidence", (t) => {
    const runtime = createPersistenceRuntime(t);
    const leagueId = uuid(10);
    const seasonId = uuid(11);
    const idempotencyId = uuid(12);
    const activityId = uuid(13);

    const result = runtime.context.transaction(() => {
      const started =
        runtime.repository.insertStartedIdempotency({
          id: idempotencyId,
          actorUserId: USER_ID,
          operation: "admin.league.create.v1",
          clientKey: "opaque-client-key",
          requestHash: "a".repeat(64),
          createdAtMs: NOW_MS,
          expiresAtMs: NOW_MS + 24 * 60 * 60 * 1000,
        });
      const inserted = runtime.repository.insertSetupLeague({
        id: leagueId,
        name: "Pacific Test League",
        nameNormalized: "pacific test league",
        nowMs: NOW_MS,
      });
      const settings =
        runtime.repository.insertInitialSettings({
          leagueId,
          nowMs: NOW_MS,
        });
      const season = runtime.repository.insertPlannedSeason({
        id: seasonId,
        leagueId,
        label: "2026",
        nhlSeasonKey: "20262027",
        nowMs: NOW_MS,
      });
      const league = runtime.repository.setCurrentSeason({
        leagueId,
        seasonId,
        expectedVersion: inserted.version,
        nowMs: NOW_MS,
      });
      const activity =
        runtime.repository.appendCreationActivity({
          id: activityId,
          leagueId,
          seasonId,
          actorUserId: USER_ID,
          displaySummary:
            "Pacific Test League was created in Setup.",
          metadataJson: JSON.stringify({
            leagueStatus: "setup",
            seasonStatus: "planned",
          }),
          nowMs: NOW_MS,
        });
      const completed =
        runtime.repository.completeIdempotency({
          id: idempotencyId,
          leagueId,
          completedAtMs: NOW_MS,
        });
      return { activity, completed, league, season, settings, started };
    });

    assert.equal(result.started.status, "started");
    assert.equal(result.started.league_id, null);
    assert.equal(result.league.status, "setup");
    assert.equal(result.league.current_season_id, seasonId);
    assert.equal(result.league.version, 2);
    assert.equal(result.season.status, "planned");
    assert.equal(result.settings.salary_cap_cents, 10000);
    assert.equal(result.settings.maximum_teams, 20);
    assert.equal(result.settings.active_forward_slots, 12);
    assert.equal(result.settings.active_defence_slots, 6);
    assert.equal(result.settings.bench_slots, 4);
    assert.equal(result.settings.maximum_bench_aav_cents, 400);
    assert.equal(result.settings.injured_reserve_slots, 4);
    assert.equal(result.settings.prospect_slots_unlimited, 1);
    assert.equal(result.activity.actor_authority, "platform_administrator");
    assert.equal(result.completed.status, "completed");
    assert.equal(result.completed.result_type, "league");
    assert.equal(result.completed.result_id, leagueId);
    assert.deepEqual(
      runtime.repository.findIdempotency({
        actorUserId: USER_ID,
        operation: "admin.league.create.v1",
        clientKey: "opaque-client-key",
      }),
      result.completed
    );
    assert.equal(
      runtime.repository.findLeagueByNormalizedName(
        "pacific test league"
      ).id,
      leagueId
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("rejects noncanonical parameters and repeat completion safely", (t) => {
    const runtime = createPersistenceRuntime(t);
    assert.throws(
      () =>
        runtime.repository.insertSetupLeague({
          id: uuid(20),
          name: "Bad League",
          nameNormalized: "Bad League",
          nowMs: NOW_MS,
        }),
      (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
    );
    assert.throws(
      () =>
        runtime.repository.insertInitialSettings({
          leagueId: uuid(20),
          nowMs: NOW_MS,
          maximumTeams: 999,
        }),
      (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
    );

    runtime.repository.insertStartedIdempotency({
      id: uuid(21),
      actorUserId: USER_ID,
      operation: "admin.league.create.v1",
      clientKey: "one-use-key",
      requestHash: "b".repeat(64),
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + 1,
    });
    const league = runtime.repository.insertSetupLeague({
      id: uuid(22),
      name: "Completion Test",
      nameNormalized: "completion test",
      nowMs: NOW_MS,
    });
    runtime.repository.completeIdempotency({
      id: uuid(21),
      leagueId: league.id,
      completedAtMs: NOW_MS,
    });
    assert.throws(
      () =>
        runtime.repository.completeIdempotency({
          id: uuid(21),
          leagueId: league.id,
          completedAtMs: NOW_MS,
        }),
      (error) => error?.code === "REPOSITORY_VERSION_CONFLICT"
    );
  });

  test("rejects duplicate nullable pre-league idempotency scope", (t) => {
    const runtime = createPersistenceRuntime(t);
    runtime.repository.insertStartedIdempotency({
      id: uuid(30),
      actorUserId: USER_ID,
      operation: "admin.league.create.v1",
      clientKey: "duplicated-null-scope",
      requestHash: "c".repeat(64),
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + 1,
    });
    assert.throws(
      () =>
      runtime.repository.insertStartedIdempotency({
        id: uuid(31),
        actorUserId: USER_ID,
        operation: "admin.league.create.v1",
        clientKey: "duplicated-null-scope",
        requestHash: "d".repeat(64),
        createdAtMs: NOW_MS,
        expiresAtMs: NOW_MS + 1,
      }),
      (error) => error?.code === "REPOSITORY_CONSTRAINT"
    );
    assert.equal(
      runtime.repository.findIdempotency({
        actorUserId: USER_ID,
        operation: "admin.league.create.v1",
        clientKey: "duplicated-null-scope",
      }).id,
      uuid(30)
    );
  });
});

describe("M3-10 administrative league-creation policy and service", () => {
  test("validates only the approved name and opaque idempotency key", () => {
    assert.deepEqual(
      validateLeagueCreationInput({
        name: "  Pacific League  ",
      }),
      {
        name: "Pacific League",
        nameNormalized: "pacific league",
      }
    );
    assert.equal(
      validateIdempotencyKey("opaque-key_123"),
      "opaque-key_123"
    );
    for (const input of [
      null,
      {},
      { name: "" },
      { name: "bad\nname" },
      { name: "x".repeat(121) },
      { name: "League", role: "platform_administrator" },
    ]) {
      assert.throws(
        () => validateLeagueCreationInput(input),
        LeagueCreationPolicyError
      );
    }
    for (const key of [null, "", " padded ", "bad\nkey", "x".repeat(129)]) {
      assert.throws(
        () => validateIdempotencyKey(key),
        LeagueCreationPolicyError
      );
    }
  });

  test("atomically creates only the approved setup aggregate and both audit surfaces", (t) => {
    const runtime = createPersistenceRuntime(t, {
      withAdministrator: true,
    });
    const service = createLeagueService(runtime);

    const result = service.create({
      input: { name: "Pacific League" },
      idempotencyKey: "create-pacific-league",
      authenticated: authenticated(),
      auditContext: {
        requestCorrelationId: "request-m3-10",
      },
    });

    assert.equal(result.code, "LEAGUE_CREATED");
    assert.equal(result.league.name, "Pacific League");
    assert.equal(result.league.status, "setup");
    assert.equal(result.league.timezone, "America/Vancouver");
    assert.equal(result.league.version, 2);
    assert.equal(result.season.label, "2026");
    assert.equal(result.season.nhlSeasonKey, "20262027");
    assert.equal(result.season.status, "planned");
    assert.equal(result.settings.salaryCapCents, 10000);
    assert.equal(result.settings.maximumTeams, 20);
    assert.equal(result.settings.tradeDeadlineAtMs, null);
    assert.equal(result.replayed, false);
    assert.equal(JSON.stringify(result).includes("replayed"), false);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["code", "league", "season", "settings"]
    );
    assert.equal(tableCount(runtime.database, "leagues"), 1);
    assert.equal(tableCount(runtime.database, "seasons"), 1);
    assert.equal(tableCount(runtime.database, "league_settings"), 1);
    assert.equal(tableCount(runtime.database, "league_activity"), 1);
    assert.equal(tableCount(runtime.database, "security_audit_events"), 1);
    assert.equal(tableCount(runtime.database, "idempotency_requests"), 1);
    for (const table of [
      "league_memberships",
      "league_invitations",
      "teams",
      "team_manager_assignments",
      "notifications",
    ]) {
      assert.equal(tableCount(runtime.database, table), 0);
    }
    const securityAudit = runtime.database
      .prepare("SELECT * FROM security_audit_events")
      .get();
    assert.equal(
      securityAudit.event_type,
      "platform_administration.league_created"
    );
    assert.equal(securityAudit.actor_user_id, USER_ID);
    assert.equal(securityAudit.league_id, result.league.id);
    assert.equal(securityAudit.session_id, authenticated().session.id);
    assert.equal(securityAudit.request_correlation_id, "request-m3-10");
    const leagueActivity = runtime.database
      .prepare("SELECT * FROM league_activity")
      .get();
    assert.equal(leagueActivity.event_type, "league_created");
    assert.equal(leagueActivity.actor_user_id, USER_ID);
    assert.equal(
      leagueActivity.actor_authority,
      "platform_administrator"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("returns the original aggregate for exact replay without another write", (t) => {
    const runtime = createPersistenceRuntime(t, {
      withAdministrator: true,
    });
    const service = createLeagueService(runtime);
    const command = {
      input: { name: "Replay League" },
      idempotencyKey: "replay-key",
      authenticated: authenticated(),
    };
    const first = service.create(command);
    const before = Object.fromEntries(
      [
        "leagues",
        "seasons",
        "league_settings",
        "league_activity",
        "security_audit_events",
        "idempotency_requests",
      ].map((table) => [table, tableCount(runtime.database, table)])
    );
    const replay = service.create(command);

    assert.deepEqual(replay, first);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(before).map((table) => [
          table,
          tableCount(runtime.database, table),
        ])
      ),
      before
    );
  });

  test("rejects mismatched replay and duplicate normalized league names", (t) => {
    const runtime = createPersistenceRuntime(t, {
      withAdministrator: true,
    });
    const service = createLeagueService(runtime);
    service.create({
      input: { name: "Unique League" },
      idempotencyKey: "first-key",
      authenticated: authenticated(),
    });
    assert.throws(
      () =>
        service.create({
          input: { name: "Different League" },
          idempotencyKey: "first-key",
          authenticated: authenticated(),
        }),
      (error) =>
        error instanceof LeagueIdempotencyConflictError &&
        error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    assert.throws(
      () =>
        service.create({
          input: { name: "  UNIQUE LEAGUE  " },
          idempotencyKey: "second-key",
          authenticated: authenticated(),
        }),
      LeagueNameUnavailableError
    );
    assert.equal(tableCount(runtime.database, "leagues"), 1);
    assert.equal(tableCount(runtime.database, "idempotency_requests"), 1);
  });

  test("denies missing current authority before every league write", (t) => {
    const runtime = createPersistenceRuntime(t);
    const service = createLeagueService(runtime);
    assert.throws(
      () =>
        service.create({
          input: { name: "Denied League" },
          idempotencyKey: "denied-key",
          authenticated: authenticated(),
        }),
      PlatformAuthorizationError
    );
    for (const table of [
      "leagues",
      "seasons",
      "league_settings",
      "league_activity",
      "security_audit_events",
      "idempotency_requests",
    ]) {
      assert.equal(tableCount(runtime.database, table), 0);
    }
  });

  test("rolls every league row back when Security Audit fails", (t) => {
    const runtime = createPersistenceRuntime(t, {
      withAdministrator: true,
    });
    const service = createLeagueService(runtime, {
      auditRepository: {
        append() {
          throw new Error("synthetic audit failure");
        },
      },
    });
    assert.throws(
      () =>
        service.create({
          input: { name: "Rollback League" },
          idempotencyKey: "rollback-key",
          authenticated: authenticated(),
        }),
      /repository operation failed/i
    );
    for (const table of [
      "leagues",
      "seasons",
      "league_settings",
      "league_activity",
      "security_audit_events",
      "idempotency_requests",
    ]) {
      assert.equal(tableCount(runtime.database, table), 0);
    }
  });

  test("rolls the aggregate back at every repository write seam", (t) => {
    const seams = [
      "insertStartedIdempotency",
      "insertSetupLeague",
      "insertInitialSettings",
      "insertPlannedSeason",
      "setCurrentSeason",
      "appendCreationActivity",
      "completeIdempotency",
    ];
    for (const seam of seams) {
      const runtime = createPersistenceRuntime(t, {
        withAdministrator: true,
      });
      const repository = {
        ...runtime.repository,
        [seam]() {
          throw new Error(`synthetic ${seam} failure`);
        },
      };
      const service = createLeagueService(runtime, {
        leagueCreationRepository: repository,
      });
      assert.throws(
        () =>
          service.create({
            input: { name: `Rollback ${seam}` },
            idempotencyKey: `rollback-${seam}`,
            authenticated: authenticated(),
          }),
        /repository operation failed/i
      );
      for (const table of [
        "leagues",
        "seasons",
        "league_settings",
        "league_activity",
        "security_audit_events",
        "idempotency_requests",
      ]) {
        assert.equal(
          tableCount(runtime.database, table),
          0,
          `${seam} left a row in ${table}`
        );
      }
    }
  });
});

function platformBrowserHeaders(
  sessionCookie,
  {
    csrfToken = RAW_CSRF_TOKEN,
    idempotencyKey = "http-create-key",
    includeCookie = true,
  } = {}
) {
  return {
    Origin: PUBLIC_FRONTEND_ORIGIN,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": idempotencyKey,
    ...(includeCookie
      ? {
          Cookie: `${sessionCookie.name}=${RAW_SESSION_TOKEN}`,
        }
      : {}),
  };
}

async function startPlatformApi(t, runtime) {
  const sessionCookie = createSessionCookie({
    appEnv: "staging",
    publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    sameSite: "none",
  });
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === PUBLIC_FRONTEND_ORIGIN;
    },
    requestIdFactory() {
      return "m3-10-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap() {
        return { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf({ rawSessionToken, rawCsrfToken }) {
        if (rawSessionToken !== RAW_SESSION_TOKEN) {
          return { valid: false, code: "SESSION_INVALID" };
        }
        if (rawCsrfToken !== RAW_CSRF_TOKEN) {
          return { valid: false, code: "CSRF_INVALID" };
        }
        return authenticated();
      },
    },
  });
  const app = express();
  app.use(
    createPlatformAdministrationRouter({
      requestSecurity,
      leagueCreationService: createLeagueService(runtime),
      auditPrivacyDigest: {
        digest() {
          return {
            digest: "a".repeat(64),
            keyVersion: 1,
          };
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

describe("M3-10 isolated platform-administration HTTP contract", () => {
  test("creates and replays with exact target security and safe envelopes", async (t) => {
    const runtime = createPersistenceRuntime(t, {
      withAdministrator: true,
    });
    const api = await startPlatformApi(t, runtime);
    const url = new URL("/api/v1/admin/leagues", api.baseUrl);
    const headers = platformBrowserHeaders(api.sessionCookie);

    const created = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "HTTP League" }),
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
    assert.equal(createdBody.data.code, "LEAGUE_CREATED");
    assert.equal(createdBody.data.league.status, "setup");
    assert.equal(createdBody.meta.requestId, "m3-10-request");
    assert.equal(JSON.stringify(createdBody).includes("replayed"), false);

    const replay = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "HTTP League" }),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).data, createdBody.data);
    assert.equal(tableCount(runtime.database, "leagues"), 1);
    assert.equal(tableCount(runtime.database, "league_activity"), 1);
    assert.equal(tableCount(runtime.database, "security_audit_events"), 1);
  });

  test("maps invalid, unauthenticated, CSRF, conflict, and ended-role requests without writes", async (t) => {
    const runtime = createPersistenceRuntime(t, {
      withAdministrator: true,
    });
    const api = await startPlatformApi(t, runtime);
    const url = new URL("/api/v1/admin/leagues", api.baseUrl);
    const validHeaders = platformBrowserHeaders(api.sessionCookie);

    const malformedJson = await fetch(url, {
      method: "POST",
      headers: validHeaders,
      body: "{",
    });
    assert.equal(malformedJson.status, 400);
    assert.equal(
      (await malformedJson.json()).error.code,
      "LEAGUE_CREATION_INVALID"
    );

    const invalidBody = await fetch(url, {
      method: "POST",
      headers: validHeaders,
      body: JSON.stringify({
        name: "Invalid Authority Claim",
        role: "platform_administrator",
      }),
    });
    assert.equal(invalidBody.status, 400);

    const signedOut = await fetch(url, {
      method: "POST",
      headers: platformBrowserHeaders(api.sessionCookie, {
        includeCookie: false,
      }),
      body: JSON.stringify({ name: "Signed Out League" }),
    });
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");

    const badCsrf = await fetch(url, {
      method: "POST",
      headers: platformBrowserHeaders(api.sessionCookie, {
        csrfToken: "invalid-csrf",
      }),
      body: JSON.stringify({ name: "Bad CSRF League" }),
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error.code, "CSRF_INVALID");

    const created = await fetch(url, {
      method: "POST",
      headers: validHeaders,
      body: JSON.stringify({ name: "Conflict League" }),
    });
    assert.equal(created.status, 201);

    const mismatchedReplay = await fetch(url, {
      method: "POST",
      headers: validHeaders,
      body: JSON.stringify({ name: "Different League" }),
    });
    assert.equal(mismatchedReplay.status, 409);
    assert.equal(
      (await mismatchedReplay.json()).error.code,
      "IDEMPOTENCY_KEY_REUSED"
    );

    const duplicateName = await fetch(url, {
      method: "POST",
      headers: platformBrowserHeaders(api.sessionCookie, {
        idempotencyKey: "different-http-key",
      }),
      body: JSON.stringify({ name: "  CONFLICT LEAGUE  " }),
    });
    assert.equal(duplicateName.status, 409);
    assert.equal(
      (await duplicateName.json()).error.code,
      "LEAGUE_NAME_UNAVAILABLE"
    );

    runtime.context.repositories.platform_roles.updateVersioned({
      key: ROLE_ID,
      expectedVersion: 1,
      changes: {
        status: "ended",
        ended_at_ms: NOW_MS,
      },
    });
    const endedRole = await fetch(url, {
      method: "POST",
      headers: platformBrowserHeaders(api.sessionCookie, {
        idempotencyKey: "ended-role-key",
      }),
      body: JSON.stringify({ name: "Ended Role League" }),
    });
    assert.equal(endedRole.status, 403);
    assert.equal(
      (await endedRole.json()).error.code,
      "PLATFORM_ADMINISTRATOR_REQUIRED"
    );
    assert.equal(tableCount(runtime.database, "leagues"), 1);
    assert.equal(tableCount(runtime.database, "league_activity"), 1);
    assert.equal(tableCount(runtime.database, "security_audit_events"), 1);
  });

  test("two simultaneous exact submissions produce one creator and one replay", async (t) => {
    const runtime = createPersistenceRuntime(t, {
      withAdministrator: true,
    });
    const api = await startPlatformApi(t, runtime);
    const url = new URL("/api/v1/admin/leagues", api.baseUrl);
    const request = () =>
      fetch(url, {
        method: "POST",
        headers: platformBrowserHeaders(api.sessionCookie, {
          idempotencyKey: "simultaneous-key",
        }),
        body: JSON.stringify({ name: "Simultaneous League" }),
      });

    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 201]
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json())
    );
    assert.deepEqual(bodies[0].data, bodies[1].data);
    assert.equal(tableCount(runtime.database, "leagues"), 1);
    assert.equal(tableCount(runtime.database, "seasons"), 1);
    assert.equal(tableCount(runtime.database, "league_settings"), 1);
    assert.equal(tableCount(runtime.database, "league_activity"), 1);
    assert.equal(tableCount(runtime.database, "security_audit_events"), 1);
    assert.equal(tableCount(runtime.database, "idempotency_requests"), 1);
  });
});
