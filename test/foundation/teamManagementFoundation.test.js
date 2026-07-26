const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const express = require("express");

const {
  TeamCreationConflictError,
  createTeamCreationService,
} = require(
  "../../src/application/services/leagues/createTeamCreationService"
);
const {
  TeamNotFoundError,
  createTeamReadService,
} = require("../../src/application/services/leagues/createTeamReadService");
const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  TeamPolicyError,
  validateIdempotencyKey,
  validateStableId,
  validateTeamCreationInput,
} = require("../../src/domain/leagues/teamPolicy");
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
  createSqliteTeamReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamReadRepository"
);
const {
  createSqliteTeamCreationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamCreationRepository"
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
  createTargetRequestSecurity,
} = require("../../src/transport/http/createTargetRequestSecurity");
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");
const {
  createTeamRouter,
} = require("../../src/transport/http/createTeamRouter");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T09:00:00.000Z");
const COMMISSIONER_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const OUTSIDER_ID = "00000000-0000-4000-8000-000000000003";
const LEAGUE_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_LEAGUE_ID = "00000000-0000-4000-8000-000000000011";
const TEAM_A_ID = "00000000-0000-4000-8000-000000000020";
const TEAM_B_ID = "00000000-0000-4000-8000-000000000021";
const OTHER_TEAM_ID = "00000000-0000-4000-8000-000000000022";
const PUBLIC_FRONTEND_ORIGIN = "https://staging.hundo.example";
const SESSION_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x61).toString("base64url"),
  [MEMBER_ID]: Buffer.alloc(32, 0x62).toString("base64url"),
  [OUTSIDER_ID]: Buffer.alloc(32, 0x63).toString("base64url"),
});
const CSRF_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x64).toString("base64url"),
  [MEMBER_ID]: Buffer.alloc(32, 0x65).toString("base64url"),
  [OUTSIDER_ID]: Buffer.alloc(32, 0x66).toString("base64url"),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function authenticated(userId) {
  return {
    valid: true,
    session: { id: uuid(900 + Number(userId.slice(-1))), userId },
    user: { id: userId, status: "active", version: 1 },
  };
}

function insertUser(context, id, email, displayName) {
  context.repositories.users.insert({
    id,
    email_normalized: email,
    email_display: email,
    display_name: displayName,
    display_name_normalized: displayName.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.sessions.insert({
    id: uuid(900 + Number(id.slice(-1))),
    user_id: id,
    token_digest: id.slice(-1).repeat(64),
    csrf_secret_digest: id.slice(-1).toUpperCase().repeat(64),
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

function insertLeague(context, id, name, status = "active") {
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
    maximum_teams: 20,
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

function insertMembership(context, {
  id,
  leagueId,
  userId,
  permissionCategory,
}) {
  return context.repositories.league_memberships.insert({
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

function insertTeam(context, {
  id,
  leagueId,
  name,
  status = "active",
  primaryColour = null,
  secondaryColour = null,
  logoReference = null,
}) {
  return context.repositories.teams.insert({
    id,
    league_id: leagueId,
    name,
    name_normalized: name.toLowerCase(),
    status,
    primary_colour: primaryColour,
    secondary_colour: secondaryColour,
    logo_reference: logoReference,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function createRuntime(t, { leagueStatus = "active", maximumTeams = 20 } = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-16-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-16-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  insertUser(
    context,
    COMMISSIONER_ID,
    "commissioner@example.test",
    "League Commissioner"
  );
  insertUser(context, MEMBER_ID, "member@example.test", "Team Manager");
  insertUser(context, OUTSIDER_ID, "outsider@example.test", "Outsider");
  insertLeague(context, LEAGUE_ID, "Team Test League", leagueStatus);
  context.repositories.league_settings.updateVersioned({
    key: LEAGUE_ID,
    leagueId: LEAGUE_ID,
    expectedVersion: 1,
    changes: { maximum_teams: maximumTeams, updated_at_ms: NOW_MS },
  });
  insertLeague(context, OTHER_LEAGUE_ID, "Other Team League");
  const commissionerMembership = insertMembership(context, {
    id: uuid(40),
    leagueId: LEAGUE_ID,
    userId: COMMISSIONER_ID,
    permissionCategory: "commissioner",
  });
  context.repositories.leagues.updateVersioned({
    key: LEAGUE_ID,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: commissionerMembership.id,
      updated_at_ms: NOW_MS,
    },
  });
  const managerMembership = insertMembership(context, {
    id: uuid(41),
    leagueId: LEAGUE_ID,
    userId: MEMBER_ID,
    permissionCategory: "manager",
  });
  insertTeam(context, {
    id: TEAM_A_ID,
    leagueId: LEAGUE_ID,
    name: "Alpha Team",
    primaryColour: "#111111",
    secondaryColour: "#eeeeee",
    logoReference: "safe-logo-reference",
  });
  insertTeam(context, {
    id: TEAM_B_ID,
    leagueId: LEAGUE_ID,
    name: "Beta Team",
  });
  insertTeam(context, {
    id: uuid(23),
    leagueId: LEAGUE_ID,
    name: "Erased Team",
    status: "erased",
  });
  insertTeam(context, {
    id: OTHER_TEAM_ID,
    leagueId: OTHER_LEAGUE_ID,
    name: "Other League Team",
  });
  context.repositories.team_manager_assignments.insert({
    id: uuid(50),
    league_id: LEAGUE_ID,
    team_id: TEAM_A_ID,
    user_id: MEMBER_ID,
    membership_id: managerMembership.id,
    assigned_by_user_id: COMMISSIONER_ID,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });

  const userRepository = createSqliteUserRepository({
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
    leagueAuthorization: createLeagueAuthorizationService({
      userRepository,
      leagueAccessRepository: createSqliteLeagueAccessRepository({
        database: connection.database,
      }),
    }),
    teamReadRepository: createSqliteTeamReadRepository({
      database: connection.database,
    }),
    teamCreationRepository: createSqliteTeamCreationRepository({
      database: connection.database,
    }),
    secureRandom: { id: () => uuid(nextId++) },
    userRepository,
  };
}

function createReadService(runtime) {
  return createTeamReadService({
    leagueAuthorization: runtime.leagueAuthorization,
    teamReadRepository: runtime.teamReadRepository,
  });
}

function createCreationService(runtime, overrides = {}) {
  return createTeamCreationService({
    repositoryContext: runtime.context,
    leagueAuthorization: runtime.leagueAuthorization,
    teamCreationRepository: runtime.teamCreationRepository,
    teamReadRepository: runtime.teamReadRepository,
    auditRepository: runtime.auditRepository,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
    ...overrides,
  });
}

function creationCommand(input, overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    input,
    idempotencyKey: "m3-16-create-team",
    authenticated: authenticated(COMMISSIONER_ID),
    auditContext: {
      requestCorrelationId: uuid(800),
      networkKeyVersion: 1,
      networkMetadataDigest: "a".repeat(64),
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "local",
      }),
    },
    ...overrides,
  };
}

function tableCount(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
    .count;
}

function writeCounts(database) {
  return Object.fromEntries(
    [
      "teams",
      "team_manager_assignments",
      "league_activity",
      "security_audit_events",
      "idempotency_requests",
    ].map((tableName) => [tableName, tableCount(database, tableName)])
  );
}

describe("M3-16 team policy", () => {
  test("validates exact stable IDs, names, and idempotency keys", () => {
    assert.equal(validateStableId(TEAM_A_ID), TEAM_A_ID);
    assert.deepEqual(validateTeamCreationInput({ name: "  Snow Owls  " }), {
      name: "Snow Owls",
      nameNormalized: "snow owls",
    });
    assert.equal(validateIdempotencyKey("team-create-key"), "team-create-key");
    for (const callback of [
      () => validateStableId("bad-id"),
      () => validateTeamCreationInput(null),
      () => validateTeamCreationInput({ name: "" }),
      () => validateTeamCreationInput({ name: "x".repeat(36) }),
      () => validateTeamCreationInput({ name: "Okay", status: "active" }),
      () => validateIdempotencyKey(" padded "),
    ]) {
      assert.throws(callback, TeamPolicyError);
    }
  });
});

describe("M3-16 SELECT-only authenticated team reads", () => {
  test("lists only same-league non-erased teams with safe current-manager summaries", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const result = createReadService(runtime).list({
      leagueId: LEAGUE_ID,
      authenticated: authenticated(MEMBER_ID),
    });
    assert.equal(result.code, "TEAMS_FOUND");
    assert.deepEqual(
      result.teams.map(({ id }) => id),
      [TEAM_A_ID, TEAM_B_ID]
    );
    assert.deepEqual(result.teams[0].currentManager, {
      assignmentId: uuid(50),
      userId: MEMBER_ID,
      displayName: "Team Manager",
      acceptedAtMs: NOW_MS,
      version: 1,
    });
    assert.equal(result.teams[1].currentManager, null);
    assert.equal(result.teams[0].primaryColour, "#111111");
    assert.equal(result.teams[0].logoReference, null);
    assert(before.equals(runtime.database.serialize()));
    assert.equal(JSON.stringify(result).includes("@example.test"), false);
  });

  test("reads one exact team and hides cross-league, erased, unknown, and unauthorized targets", (t) => {
    const runtime = createRuntime(t);
    const service = createReadService(runtime);
    const before = runtime.database.serialize();
    const found = service.read({
      leagueId: LEAGUE_ID,
      teamId: TEAM_A_ID,
      authenticated: authenticated(COMMISSIONER_ID),
    });
    assert.equal(found.code, "TEAM_FOUND");
    assert.equal(found.team.id, TEAM_A_ID);
    assert.equal(found.team.leagueId, LEAGUE_ID);

    for (const teamId of [OTHER_TEAM_ID, uuid(23), uuid(999)]) {
      assert.throws(
        () =>
          service.read({
            leagueId: LEAGUE_ID,
            teamId,
            authenticated: authenticated(COMMISSIONER_ID),
          }),
        TeamNotFoundError
      );
    }
    assert.throws(
      () =>
        service.list({
          leagueId: LEAGUE_ID,
          authenticated: authenticated(OUTSIDER_ID),
        }),
      (error) => error.code === "LEAGUE_NOT_FOUND"
    );
    assert.throws(
      () =>
        service.read({
          leagueId: LEAGUE_ID,
          teamId: "not-an-id",
          authenticated: authenticated(COMMISSIONER_ID),
        }),
      TeamPolicyError
    );
    assert(before.equals(runtime.database.serialize()));
  });

  test("repository rejects malformed scope and exposes no mutation method", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    assert.throws(
      () => runtime.teamReadRepository.listTeams("bad"),
      (error) => error.code === "REPOSITORY_ARGUMENT_INVALID"
    );
    assert.equal(runtime.teamReadRepository.insert, undefined);
    assert.equal(runtime.teamReadRepository.update, undefined);
    assert.equal(runtime.teamReadRepository.delete, undefined);
    assert(before.equals(runtime.database.serialize()));
  });
});

describe("M3-16 commissioner-only Setup team creation", () => {
  test("creates and replays one unassigned setup team with atomic records", (t) => {
    const runtime = createRuntime(t, { leagueStatus: "setup" });
    const service = createCreationService(runtime);
    const result = service.create(
      creationCommand({ name: "  Snow Owls  " })
    );

    assert.equal(result.code, "TEAM_CREATED");
    assert.equal(result.replayed, false);
    assert.equal(result.team.name, "Snow Owls");
    assert.equal(result.team.status, "setup");
    assert.equal(result.team.primaryColour, null);
    assert.equal(result.team.secondaryColour, null);
    assert.equal(result.team.logoReference, null);
    assert.equal(result.team.currentManager, null);
    assert.deepEqual(writeCounts(runtime.database), {
      teams: 5,
      team_manager_assignments: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
    const persisted = runtime.database
      .prepare("SELECT * FROM teams WHERE id = ?")
      .get(result.team.id);
    assert.equal(persisted.name_normalized, "snow owls");
    assert.equal(persisted.primary_colour, null);
    assert.equal(persisted.secondary_colour, null);
    assert.equal(persisted.logo_reference, null);
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM team_manager_assignments WHERE team_id = ?")
        .get(result.team.id).count,
      0
    );
    const activity = runtime.database
      .prepare("SELECT * FROM league_activity")
      .get();
    assert.equal(activity.event_type, "team_created");
    assert.equal(activity.actor_authority, "commissioner");
    assert.equal(activity.team_id, result.team.id);
    assert.deepEqual(JSON.parse(activity.metadata_json), {
      teamId: result.team.id,
      status: "setup",
    });
    const audit = runtime.database
      .prepare("SELECT * FROM security_audit_events")
      .get();
    assert.equal(audit.event_type, "team.created");
    assert.equal(audit.actor_user_id, COMMISSIONER_ID);
    assert.equal(audit.league_id, LEAGUE_ID);
    const idempotency = runtime.database
      .prepare("SELECT * FROM idempotency_requests")
      .get();
    assert.equal(idempotency.status, "completed");
    assert.equal(idempotency.result_type, "team");
    assert.equal(idempotency.result_id, result.team.id);

    const replay = service.create(
      creationCommand({ name: "snow owls" })
    );
    assert.deepEqual(replay, result);
    assert.equal(replay.replayed, true);
    assert.deepEqual(writeCounts(runtime.database), {
      teams: 5,
      team_manager_assignments: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
    assert.throws(
      () => service.create(creationCommand({ name: "Different Team" })),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
  });

  test("rejects duplicate names, team limits, non-Setup leagues, and missing commissioner authority without writes", (t) => {
    const duplicate = createRuntime(t, { leagueStatus: "setup" });
    const duplicateBefore = writeCounts(duplicate.database);
    assert.throws(
      () =>
        createCreationService(duplicate).create(
          creationCommand({ name: "alpha TEAM" })
        ),
      (error) => error.code === "TEAM_NAME_UNAVAILABLE"
    );
    assert.deepEqual(writeCounts(duplicate.database), duplicateBefore);

    const racedDuplicate = createRuntime(t, { leagueStatus: "setup" });
    const racedBefore = writeCounts(racedDuplicate.database);
    assert.throws(
      () =>
        createCreationService(racedDuplicate, {
          teamCreationRepository: {
            ...racedDuplicate.teamCreationRepository,
            findTeamByNormalizedName() {
              return null;
            },
          },
        }).create(creationCommand({ name: "ALPHA TEAM" })),
      (error) =>
        error.code === "TEAM_NAME_UNAVAILABLE" &&
        error.cause?.code === "REPOSITORY_CONSTRAINT"
    );
    assert.deepEqual(writeCounts(racedDuplicate.database), racedBefore);

    const full = createRuntime(t, {
      leagueStatus: "setup",
      maximumTeams: 2,
    });
    const fullBefore = writeCounts(full.database);
    assert.throws(
      () =>
        createCreationService(full).create(
          creationCommand({ name: "Third Team" })
        ),
      (error) => error.code === "TEAM_LIMIT_REACHED"
    );
    assert.deepEqual(writeCounts(full.database), fullBefore);

    const active = createRuntime(t);
    const activeBefore = writeCounts(active.database);
    assert.throws(
      () =>
        createCreationService(active).create(
          creationCommand({ name: "Late Team" })
        ),
      (error) => error.code === "TEAM_CREATION_NOT_ALLOWED"
    );
    assert.deepEqual(writeCounts(active.database), activeBefore);

    const manager = createRuntime(t, { leagueStatus: "setup" });
    const managerBefore = writeCounts(manager.database);
    assert.throws(
      () =>
        createCreationService(manager).create(
          creationCommand(
            { name: "Manager Team" },
            { authenticated: authenticated(MEMBER_ID) }
          )
        ),
      (error) => error.code === "LEAGUE_COMMISSIONER_REQUIRED"
    );
    assert.deepEqual(writeCounts(manager.database), managerBefore);

    const outsider = createRuntime(t, { leagueStatus: "setup" });
    const outsiderBefore = writeCounts(outsider.database);
    assert.throws(
      () =>
        createCreationService(outsider).create(
          creationCommand(
            { name: "Outsider Team" },
            { authenticated: authenticated(OUTSIDER_ID) }
          )
        ),
      (error) => error.code === "LEAGUE_NOT_FOUND"
    );
    assert.deepEqual(writeCounts(outsider.database), outsiderBefore);
  });

  test("rolls back every post-idempotency creation seam, including Security Audit", (t) => {
    for (const seam of [
      "insertSetupTeam",
      "appendCreationActivity",
      "completeIdempotency",
    ]) {
      const runtime = createRuntime(t, { leagueStatus: "setup" });
      const before = writeCounts(runtime.database);
      const repository = {
        ...runtime.teamCreationRepository,
        [seam]() {
          throw new Error(`injected ${seam} failure`);
        },
      };
      assert.throws(
        () =>
          createCreationService(runtime, {
            teamCreationRepository: repository,
          }).create(creationCommand({ name: `Failure ${seam}` })),
        /repository operation failed/i
      );
      assert.deepEqual(writeCounts(runtime.database), before);
    }

    const auditFailure = createRuntime(t, { leagueStatus: "setup" });
    const beforeAudit = writeCounts(auditFailure.database);
    assert.throws(
      () =>
        createCreationService(auditFailure, {
          auditRepository: {
            append() {
              throw new Error("injected Security Audit failure");
            },
          },
        }).create(creationCommand({ name: "Audit Failure" })),
      /repository operation failed/i
    );
    assert.deepEqual(writeCounts(auditFailure.database), beforeAudit);
  });
});

function httpHeaders(sessionCookie, userId, {
  csrfToken = CSRF_TOKENS[userId],
  idempotencyKey = "http-team-create",
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

async function startTeamApi(t, runtime) {
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
      return "m3-16-request";
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
    createTeamRouter({
      requestSecurity,
      teamReadService: createReadService(runtime),
      teamCreationService: createCreationService(runtime),
      teamWorkspaceService: {
        read() {
          throw new Error("The team-workspace endpoint is outside this test.");
        },
        saveOrder() {
          throw new Error("The roster-order endpoint is outside this test.");
        },
        setTradeBlock() {
          throw new Error("The trade-block endpoint is outside this test.");
        },
      },
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

describe("M3-16 isolated team HTTP contract", () => {
  test("lists, reads, creates, and replays teams through safe envelopes", async (t) => {
    const runtime = createRuntime(t, { leagueStatus: "setup" });
    const api = await startTeamApi(t, runtime);
    const memberHeaders = httpHeaders(api.sessionCookie, MEMBER_ID);
    const beforeReads = runtime.database.serialize();
    const collectionUrl = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/teams`,
      api.baseUrl
    );

    const listed = await fetch(collectionUrl, { headers: memberHeaders });
    const listedBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    assert.equal(
      listed.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    assert.equal(listedBody.meta.requestId, "m3-16-request");
    assert.deepEqual(
      listedBody.data.teams.map(({ id }) => id),
      [TEAM_A_ID, TEAM_B_ID]
    );

    const read = await fetch(
      new URL(
        `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_A_ID}`,
        api.baseUrl
      ),
      { headers: memberHeaders }
    );
    const readBody = await read.json();
    assert.equal(read.status, 200);
    assert.equal(readBody.data.team.id, TEAM_A_ID);
    assert.equal(
      readBody.data.team.currentManager.userId,
      MEMBER_ID
    );
    assert(beforeReads.equals(runtime.database.serialize()));

    const commissionerHeaders = httpHeaders(
      api.sessionCookie,
      COMMISSIONER_ID
    );
    const created = await fetch(collectionUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: JSON.stringify({ name: "HTTP Owls" }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdBody.data.code, "TEAM_CREATED");
    assert.equal(createdBody.data.team.name, "HTTP Owls");
    assert.equal(createdBody.data.team.currentManager, null);
    assert.equal(JSON.stringify(createdBody).includes("replayed"), false);

    const replay = await fetch(collectionUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: JSON.stringify({ name: "http owls" }),
    });
    const replayBody = await replay.json();
    assert.equal(replay.status, 200);
    assert.deepEqual(replayBody.data, createdBody.data);
    assert.equal(tableCount(runtime.database, "league_activity"), 1);
    assert.equal(tableCount(runtime.database, "security_audit_events"), 1);
    assert.equal(tableCount(runtime.database, "idempotency_requests"), 1);
  });

  test("maps malformed, hidden, session, CSRF, Origin, authority, and state failures without writes", async (t) => {
    const runtime = createRuntime(t, { leagueStatus: "setup" });
    const api = await startTeamApi(t, runtime);
    const collectionUrl = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/teams`,
      api.baseUrl
    );
    const commissionerHeaders = httpHeaders(
      api.sessionCookie,
      COMMISSIONER_ID
    );
    const before = writeCounts(runtime.database);

    const malformedId = await fetch(
      new URL("/api/v1/leagues/bad/teams", api.baseUrl),
      { headers: commissionerHeaders }
    );
    assert.equal(malformedId.status, 400);
    assert.equal((await malformedId.json()).error.code, "TEAM_INPUT_INVALID");

    const hidden = await fetch(
      new URL(
        `/api/v1/leagues/${LEAGUE_ID}/teams/${OTHER_TEAM_ID}`,
        api.baseUrl
      ),
      { headers: commissionerHeaders }
    );
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json()).error.code, "TEAM_NOT_FOUND");

    const outsider = await fetch(collectionUrl, {
      headers: httpHeaders(api.sessionCookie, OUTSIDER_ID),
    });
    assert.equal(outsider.status, 404);
    assert.equal((await outsider.json()).error.code, "LEAGUE_NOT_FOUND");

    const signedOut = await fetch(collectionUrl, {
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        includeCookie: false,
      }),
    });
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");

    const invalidBody = await fetch(collectionUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: JSON.stringify({ name: "Valid", status: "active" }),
    });
    assert.equal(invalidBody.status, 400);
    assert.equal((await invalidBody.json()).error.code, "TEAM_INPUT_INVALID");

    const invalidJson = await fetch(collectionUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error.code, "TEAM_INPUT_INVALID");

    const badCsrf = await fetch(collectionUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        csrfToken: "invalid-csrf",
      }),
      body: JSON.stringify({ name: "CSRF Team" }),
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error.code, "CSRF_INVALID");

    const badOrigin = await fetch(collectionUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        origin: "https://evil.example",
      }),
      body: JSON.stringify({ name: "Origin Team" }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, "ORIGIN_NOT_ALLOWED");

    const manager = await fetch(collectionUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, MEMBER_ID),
      body: JSON.stringify({ name: "Manager Team" }),
    });
    assert.equal(manager.status, 403);
    assert.equal(
      (await manager.json()).error.code,
      "LEAGUE_COMMISSIONER_REQUIRED"
    );

    const duplicate = await fetch(collectionUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        idempotencyKey: "duplicate-team-name",
      }),
      body: JSON.stringify({ name: "alpha team" }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      (await duplicate.json()).error.code,
      "TEAM_NAME_UNAVAILABLE"
    );
    assert.deepEqual(writeCounts(runtime.database), before);

    const active = createRuntime(t);
    const activeApi = await startTeamApi(t, active);
    const activeBefore = writeCounts(active.database);
    const notSetup = await fetch(
      new URL(`/api/v1/leagues/${LEAGUE_ID}/teams`, activeApi.baseUrl),
      {
        method: "POST",
        headers: httpHeaders(activeApi.sessionCookie, COMMISSIONER_ID),
        body: JSON.stringify({ name: "Late Team" }),
      }
    );
    assert.equal(notSetup.status, 409);
    assert.equal(
      (await notSetup.json()).error.code,
      "TEAM_CREATION_NOT_ALLOWED"
    );
    assert.deepEqual(writeCounts(active.database), activeBefore);
  });
});
