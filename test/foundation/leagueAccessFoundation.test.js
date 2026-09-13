const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  LeagueAuthorizationInputError,
  LeagueCommissionerRequiredError,
  LeagueVisibilityError,
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  createLeagueReadService,
} = require(
  "../../src/application/services/leagues/createLeagueReadService"
);
const {
  createPlatformAuthorizationService,
} = require(
  "../../src/application/services/authorization/requirePlatformAdministrator"
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
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createLeagueReadRouter,
} = require("../../src/transport/http/createLeagueReadRouter");
const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T00:00:00.000Z");
const USER_A_ID = "00000000-0000-4000-8000-000000000001";
const USER_B_ID = "00000000-0000-4000-8000-000000000002";
const PLATFORM_ONLY_ID = "00000000-0000-4000-8000-000000000003";
const LEAGUE_A_ID = "00000000-0000-4000-8000-000000000010";
const LEAGUE_B_ID = "00000000-0000-4000-8000-000000000011";
const PUBLIC_FRONTEND_ORIGIN = "https://hundo.example";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function authenticated(userId) {
  return {
    valid: true,
    code: "SESSION_VALID",
    session: {
      id:
        userId === USER_A_ID
          ? uuid(101)
          : userId === USER_B_ID
            ? uuid(102)
            : uuid(103),
      userId,
      version: 1,
    },
    user: { id: userId, status: "active", version: 1 },
  };
}

function insertUser(context, { id, email, displayName }) {
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
}

function insertLeagueAggregate(context, {
  leagueId,
  leagueName,
  seasonId,
}) {
  const league = context.repositories.leagues.insert({
    id: leagueId,
    name: leagueName,
    name_normalized: leagueName.toLowerCase(),
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.league_settings.insert({
    league_id: leagueId,
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
  context.repositories.seasons.insert({
    id: seasonId,
    league_id: leagueId,
    label: "2026",
    nhl_season_key: "20262027",
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  return context.repositories.leagues.updateVersioned({
    key: leagueId,
    expectedVersion: league.version,
    changes: {
      current_season_id: seasonId,
      updated_at_ms: NOW_MS,
    },
  });
}

function insertMembership(context, {
  id,
  leagueId,
  userId,
  permissionCategory,
  status = "active",
}) {
  const joinedAtMs = status === "invited" ? null : NOW_MS;
  return context.repositories.league_memberships.insert({
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status,
    joined_at_ms: joinedAtMs,
    ended_at_ms: status === "ended" ? NOW_MS : null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-12-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-12-test",
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
    id: USER_A_ID,
    email: "alpha@example.test",
    displayName: "Alpha User",
  });
  insertUser(context, {
    id: USER_B_ID,
    email: "bravo@example.test",
    displayName: "Bravo User",
  });
  insertUser(context, {
    id: PLATFORM_ONLY_ID,
    email: "platform@example.test",
    displayName: "Platform Only",
  });
  const leagueA = insertLeagueAggregate(context, {
    leagueId: LEAGUE_A_ID,
    leagueName: "Alpha League",
    seasonId: uuid(201),
  });
  const leagueB = insertLeagueAggregate(context, {
    leagueId: LEAGUE_B_ID,
    leagueName: "Bravo League",
    seasonId: uuid(202),
  });
  context.repositories.seasons.insert({
    id: uuid(203),
    league_id: LEAGUE_A_ID,
    label: "2025",
    nhl_season_key: "20252026",
    status: "completed",
    regular_season_starts_at_ms: NOW_MS - 2_000,
    regular_season_ends_at_ms: NOW_MS - 1_000,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: NOW_MS - 2_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
  const commissionerA = insertMembership(context, {
    id: uuid(301),
    leagueId: LEAGUE_A_ID,
    userId: USER_A_ID,
    permissionCategory: "commissioner",
  });
  insertMembership(context, {
    id: uuid(302),
    leagueId: LEAGUE_A_ID,
    userId: USER_B_ID,
    permissionCategory: "member",
  });
  insertMembership(context, {
    id: uuid(303),
    leagueId: LEAGUE_A_ID,
    userId: PLATFORM_ONLY_ID,
    permissionCategory: "member",
    status: "ended",
  });
  const commissionerB = insertMembership(context, {
    id: uuid(304),
    leagueId: LEAGUE_B_ID,
    userId: USER_B_ID,
    permissionCategory: "commissioner",
  });
  insertMembership(context, {
    id: uuid(305),
    leagueId: LEAGUE_B_ID,
    userId: USER_A_ID,
    permissionCategory: "member",
  });
  insertMembership(context, {
    id: uuid(306),
    leagueId: LEAGUE_B_ID,
    userId: PLATFORM_ONLY_ID,
    permissionCategory: "member",
    status: "invited",
  });
  context.repositories.leagues.updateVersioned({
    key: LEAGUE_A_ID,
    expectedVersion: leagueA.version,
    changes: {
      commissioner_membership_id: commissionerA.id,
      updated_at_ms: NOW_MS,
    },
  });
  context.repositories.leagues.updateVersioned({
    key: LEAGUE_B_ID,
    expectedVersion: leagueB.version,
    changes: {
      commissioner_membership_id: commissionerB.id,
      updated_at_ms: NOW_MS,
    },
  });
  context.repositories.platform_roles.insert({
    id: uuid(401),
    user_id: PLATFORM_ONLY_ID,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });

  const accessRepository = createSqliteLeagueAccessRepository({
    database: connection.database,
  });
  const userRepository = createSqliteUserRepository({
    database: connection.database,
  });
  const platformAuthorization = createPlatformAuthorizationService({
    userRepository,
    platformRoleRepository: createSqlitePlatformRoleRepository({
      database: connection.database,
    }),
  });
  const authorization = createLeagueAuthorizationService({
    userRepository,
    leagueAccessRepository: accessRepository,
    platformAuthorization,
  });
  const readService = createLeagueReadService({
    leagueAuthorization: authorization,
    leagueAccessRepository: accessRepository,
    platformAuthorization,
  });
  return {
    accessRepository,
    authorization,
    context,
    database: connection.database,
    platformAuthorization,
    readService,
    userRepository,
  };
}

function databaseSemanticHash(database) {
  const tableNames = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name ASC"
    )
    .all()
    .map(({ name }) => name);
  const state = tableNames.map((tableName) => ({
    tableName,
    rows: database
      .prepare(`SELECT * FROM "${tableName}" ORDER BY rowid ASC`)
      .all(),
  }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(state), "utf8")
    .digest("hex");
}

describe("M3-12 read-only league access repository", () => {
  test("returns only stable-ID-scoped visible leagues and safe read models", (t) => {
    const runtime = createRuntime(t);
    const before = databaseSemanticHash(runtime.database);
    const visible = runtime.accessRepository.listVisibleLeagues(USER_A_ID);
    assert.deepEqual(
      visible.map(({ league_id }) => league_id),
      [LEAGUE_A_ID, LEAGUE_B_ID]
    );
    assert.equal(visible[0].membership_status, "active");
    assert.equal(visible[0].season_label, "2026");
    assert.equal(Object.isFrozen(visible), true);
    assert.equal(Object.isFrozen(visible[0]), true);
    assert.equal(
      runtime.accessRepository.findActiveMembership({
        leagueId: LEAGUE_A_ID,
        userId: USER_A_ID,
      }).permission_category,
      "commissioner"
    );
    assert.equal(
      runtime.accessRepository.findActiveMembership({
        leagueId: LEAGUE_A_ID,
        userId: PLATFORM_ONLY_ID,
      }),
      null
    );
    assert.equal(
      runtime.accessRepository.findLeagueSummary(LEAGUE_B_ID).league_name,
      "Bravo League"
    );
    assert.equal(
      runtime.accessRepository.findLeagueSettings(LEAGUE_A_ID)
        .salary_cap_cents,
      10000
    );
    assert.deepEqual(
      runtime.accessRepository
        .listLeagueSeasons(LEAGUE_A_ID)
        .map(({ id }) => id),
      [uuid(201), uuid(203)]
    );
    const memberships =
      runtime.accessRepository.listLeagueMemberships(LEAGUE_A_ID);
    assert.equal(memberships.length, 3);
    assert.equal(JSON.stringify(memberships).includes("@example.test"), false);
    assert.equal(JSON.stringify(memberships).includes("email"), false);
    assert.equal(databaseSemanticHash(runtime.database), before);
  });

  test("rejects malformed IDs before query execution", (t) => {
    const runtime = createRuntime(t);
    const before = databaseSemanticHash(runtime.database);
    for (const action of [
      () => runtime.accessRepository.listVisibleLeagues("not-a-user"),
      () =>
        runtime.accessRepository.findActiveMembership({
          leagueId: "not-a-league",
          userId: USER_A_ID,
        }),
      () => runtime.accessRepository.findLeagueSummary("not-a-league"),
      () => runtime.accessRepository.findLeagueSettings("not-a-league"),
      () => runtime.accessRepository.listLeagueMemberships("not-a-league"),
    ]) {
      assert.throws(
        action,
        (error) => error.code === "REPOSITORY_ARGUMENT_INVALID"
      );
    }
    assert.equal(databaseSemanticHash(runtime.database), before);
  });
});

describe("M3-12 backend-derived league authorization", () => {
  test("reloads active user and exact active membership without platform-role authority", (t) => {
    const runtime = createRuntime(t);
    assert.deepEqual(
      runtime.authorization.requireActiveMembership(
        authenticated(USER_A_ID),
        LEAGUE_A_ID
      ),
      {
        authorized: true,
        code: "LEAGUE_MEMBERSHIP_AUTHORIZED",
        actorUserId: USER_A_ID,
        leagueId: LEAGUE_A_ID,
        leagueVersion: 3,
        membershipId: uuid(301),
        membershipVersion: 1,
        permissionCategory: "commissioner",
        userVersion: 1,
      }
    );
    assert.throws(
      () =>
        runtime.authorization.requireActiveMembership(
          authenticated(PLATFORM_ONLY_ID),
          LEAGUE_A_ID
        ),
      LeagueVisibilityError
    );
  });

  test("requires the exact referenced commissioner membership after visibility", (t) => {
    const runtime = createRuntime(t);
    const authority = runtime.authorization.requireCommissioner(
      authenticated(USER_A_ID),
      LEAGUE_A_ID
    );
    assert.equal(authority.code, "LEAGUE_COMMISSIONER_AUTHORIZED");
    assert.equal(authority.membershipId, uuid(301));
    assert.equal(authority.authority, "commissioner");

    assert.throws(
      () =>
        runtime.authorization.requireCommissioner(
          authenticated(USER_B_ID),
          LEAGUE_A_ID
        ),
      LeagueCommissionerRequiredError
    );
    assert.throws(
      () =>
        runtime.authorization.requireCommissioner(
          authenticated(PLATFORM_ONLY_ID),
          LEAGUE_A_ID
        ),
      LeagueVisibilityError
    );
  });

  test("inherits platform-administrator authority only after active league membership", (t) => {
    const runtime = createRuntime(t);
    assert.throws(
      () =>
        runtime.authorization.requireCommissioner(
          authenticated(PLATFORM_ONLY_ID),
          LEAGUE_A_ID
        ),
      LeagueVisibilityError
    );

    runtime.context.repositories.league_memberships.updateVersioned({
      key: uuid(303),
      leagueId: LEAGUE_A_ID,
      expectedVersion: 1,
      changes: {
        status: "active",
        joined_at_ms: NOW_MS,
        ended_at_ms: null,
        updated_at_ms: NOW_MS,
      },
    });

    const authority = runtime.authorization.requireCommissioner(
      authenticated(PLATFORM_ONLY_ID),
      LEAGUE_A_ID
    );
    assert.equal(
      authority.code,
      "LEAGUE_PLATFORM_ADMINISTRATOR_AUTHORIZED"
    );
    assert.equal(authority.authority, "platform_administrator");
    assert.equal(authority.permissionCategory, "member");
    assert.equal(authority.membershipId, uuid(303));
    assert.equal(authority.platformRoleId, uuid(401));

    const visible = runtime.readService.list({
      authenticated: authenticated(PLATFORM_ONLY_ID),
    });
    assert.deepEqual(
      visible.leagues.map(({ id }) => id),
      [LEAGUE_A_ID]
    );
    assert.equal(
      visible.leagues[0].membership.permissionCategory,
      "member"
    );
    assert.equal(
      visible.leagues[0].membership.effectiveAuthority,
      "platform_administrator"
    );
    assert.equal(
      runtime.readService.readLeague({
        leagueId: LEAGUE_A_ID,
        authenticated: authenticated(PLATFORM_ONLY_ID),
      }).league.membership.effectiveAuthority,
      "platform_administrator"
    );
    assert.equal(
      runtime.readService.listMemberships({
        leagueId: LEAGUE_A_ID,
        authenticated: authenticated(PLATFORM_ONLY_ID),
      }).memberships.length,
      3
    );
  });

  test("fails closed for malformed, mismatched, inactive, deleted, and stale authority", (t) => {
    const runtime = createRuntime(t);
    assert.throws(
      () =>
        runtime.authorization.requireActiveMembership(
          authenticated(USER_A_ID),
          "not-a-league"
        ),
      LeagueAuthorizationInputError
    );
    assert.throws(
      () =>
        runtime.authorization.requireActiveMembership(
          {
            ...authenticated(USER_A_ID),
            session: { userId: USER_B_ID },
          },
          LEAGUE_A_ID
        ),
      LeagueVisibilityError
    );
    for (const leagueId of [LEAGUE_A_ID, LEAGUE_B_ID]) {
      assert.throws(
        () =>
          runtime.authorization.requireActiveMembership(
            authenticated(PLATFORM_ONLY_ID),
            leagueId
          ),
        LeagueVisibilityError
      );
    }
    runtime.userRepository.updateVersioned({
      key: PLATFORM_ONLY_ID,
      expectedVersion: 1,
      changes: { status: "deactivated", updated_at_ms: NOW_MS },
    });
    assert.throws(
      () =>
        runtime.authorization.requireActiveUser(
          authenticated(PLATFORM_ONLY_ID)
        ),
      LeagueVisibilityError
    );
    runtime.context.repositories.league_memberships.updateVersioned({
      key: uuid(302),
      leagueId: LEAGUE_A_ID,
      expectedVersion: 1,
      changes: { status: "suspended", updated_at_ms: NOW_MS },
    });
    assert.throws(
      () =>
        runtime.authorization.requireActiveMembership(
          authenticated(USER_B_ID),
          LEAGUE_A_ID
        ),
      LeagueVisibilityError
    );
    const leagueA = runtime.context.repositories.leagues.findByKey({
      key: LEAGUE_A_ID,
    });
    runtime.context.repositories.leagues.updateVersioned({
      key: LEAGUE_A_ID,
      expectedVersion: leagueA.version,
      changes: {
        commissioner_membership_id: null,
        updated_at_ms: NOW_MS,
      },
    });
    assert.throws(
      () =>
        runtime.authorization.requireCommissioner(
          authenticated(USER_A_ID),
          LEAGUE_A_ID
        ),
      LeagueCommissionerRequiredError
    );
    const league = runtime.context.repositories.leagues.findByKey({
      key: LEAGUE_B_ID,
    });
    runtime.context.repositories.leagues.updateVersioned({
      key: LEAGUE_B_ID,
      expectedVersion: league.version,
      changes: { status: "deleted", updated_at_ms: NOW_MS },
    });
    assert.throws(
      () =>
        runtime.authorization.requireActiveMembership(
          authenticated(USER_A_ID),
          LEAGUE_B_ID
        ),
      LeagueVisibilityError
    );
  });
});

describe("M3-12 safe league read service", () => {
  test("lists two isolated visible leagues and reads summary and settings without writes", (t) => {
    const runtime = createRuntime(t);
    const before = databaseSemanticHash(runtime.database);
    const visible = runtime.readService.list({
      authenticated: authenticated(USER_A_ID),
    });
    assert.equal(visible.code, "LEAGUES_FOUND");
    assert.deepEqual(
      visible.leagues.map(({ id }) => id),
      [LEAGUE_A_ID, LEAGUE_B_ID]
    );
    assert.equal(visible.leagues[0].currentSeason.label, "2026");
    assert.equal(visible.leagues[1].currentSeason.label, "2026");
    assert.equal(
      visible.leagues[0].membership.permissionCategory,
      "commissioner"
    );
    assert.equal(
      visible.leagues[1].membership.permissionCategory,
      "member"
    );
    const league = runtime.readService.readLeague({
      leagueId: LEAGUE_A_ID,
      authenticated: authenticated(USER_A_ID),
    });
    assert.equal(league.code, "LEAGUE_FOUND");
    assert.equal(league.league.name, "Alpha League");
    assert.equal(league.league.currentSeason.nhlSeasonKey, "20262027");
    const seasons = runtime.readService.listSeasons({
      leagueId: LEAGUE_A_ID,
      authenticated: authenticated(USER_A_ID),
    });
    assert.equal(seasons.code, "LEAGUE_SEASONS_FOUND");
    assert.deepEqual(
      seasons.seasons.map(({ id, label, status }) => ({
        id,
        label,
        status,
      })),
      [
        { id: uuid(201), label: "2026", status: "planned" },
        { id: uuid(203), label: "2025", status: "completed" },
      ]
    );
    const settings = runtime.readService.readSettings({
      leagueId: LEAGUE_B_ID,
      authenticated: authenticated(USER_A_ID),
    });
    assert.equal(settings.code, "LEAGUE_SETTINGS_FOUND");
    assert.equal(settings.settings.leagueId, LEAGUE_B_ID);
    assert.equal(settings.settings.activeForwardSlots, 12);
    assert.equal(settings.settings.prospectSlotsUnlimited, true);
    const serialized = JSON.stringify({ league, settings, visible });
    for (const forbidden of [
      "email",
      "credential",
      "session",
      "platform",
      "invitation",
      "security_audit",
    ]) {
      assert.equal(serialized.toLowerCase().includes(forbidden), false);
    }
    assert.equal(databaseSemanticHash(runtime.database), before);
  });

  test("lists safe membership history only for the current commissioner", (t) => {
    const runtime = createRuntime(t);
    const before = databaseSemanticHash(runtime.database);
    const result = runtime.readService.listMemberships({
      leagueId: LEAGUE_A_ID,
      authenticated: authenticated(USER_A_ID),
    });
    assert.equal(result.code, "LEAGUE_MEMBERSHIPS_FOUND");
    assert.equal(result.memberships.length, 3);
    assert.deepEqual(
      result.memberships.map(({ status }) => status),
      ["active", "active", "ended"]
    );
    assert.equal(
      result.memberships[0].user.displayName,
      "Alpha User"
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("@example.test"), false);
    assert.equal(serialized.includes("email"), false);
    assert.equal(serialized.includes("account"), false);
    assert.throws(
      () =>
        runtime.readService.listMemberships({
          leagueId: LEAGUE_A_ID,
          authenticated: authenticated(USER_B_ID),
        }),
      LeagueCommissionerRequiredError
    );
    assert.equal(databaseSemanticHash(runtime.database), before);
  });

  test("does not leak another league through IDs or display context", (t) => {
    const runtime = createRuntime(t);
    const before = databaseSemanticHash(runtime.database);
    const visible = runtime.readService.list({
      authenticated: authenticated(PLATFORM_ONLY_ID),
    });
    assert.deepEqual(visible.leagues, []);
    for (const leagueId of [LEAGUE_A_ID, LEAGUE_B_ID, uuid(999)]) {
      assert.throws(
        () =>
          runtime.readService.readLeague({
            leagueId,
            authenticated: authenticated(PLATFORM_ONLY_ID),
          }),
        LeagueVisibilityError
      );
      assert.throws(
        () =>
          runtime.readService.listSeasons({
            leagueId,
            authenticated: authenticated(PLATFORM_ONLY_ID),
          }),
        LeagueVisibilityError
      );
    }
    assert.equal(databaseSemanticHash(runtime.database), before);
  });
});

const SESSION_TOKENS = Object.freeze({
  [USER_A_ID]: Buffer.alloc(32, 0x61).toString("base64url"),
  [USER_B_ID]: Buffer.alloc(32, 0x62).toString("base64url"),
  [PLATFORM_ONLY_ID]: Buffer.alloc(32, 0x63).toString("base64url"),
});

function browserHeaders(sessionCookie, userId, {
  includeCookie = true,
  origin = PUBLIC_FRONTEND_ORIGIN,
} = {}) {
  return {
    Origin: origin,
    ...(includeCookie
      ? {
          Cookie: `${sessionCookie.name}=${SESSION_TOKENS[userId]}`,
        }
      : {}),
  };
}

async function startLeagueReadApi(t, runtime) {
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
      return "m3-12-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap(rawSessionToken) {
        const userId = userByToken.get(rawSessionToken);
        return userId
          ? authenticated(userId)
          : { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf() {
        return { valid: false, code: "SESSION_INVALID" };
      },
    },
  });
  const app = express();
  app.use(
    createLeagueReadRouter({
      requestSecurity,
      leagueReadService: runtime.readService,
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

describe("M3-12 isolated league read HTTP contract", () => {
  test("returns safe visible, summary, settings, and commissioner membership envelopes without writes", async (t) => {
    const runtime = createRuntime(t);
    const before = databaseSemanticHash(runtime.database);
    const api = await startLeagueReadApi(t, runtime);
    const headers = browserHeaders(api.sessionCookie, USER_A_ID);
    const requests = [
      ["/api/v1/leagues", "LEAGUES_FOUND"],
      [`/api/v1/leagues/${LEAGUE_A_ID}`, "LEAGUE_FOUND"],
      [
        `/api/v1/leagues/${LEAGUE_A_ID}/settings`,
        "LEAGUE_SETTINGS_FOUND",
      ],
      [
        `/api/v1/leagues/${LEAGUE_A_ID}/memberships`,
        "LEAGUE_MEMBERSHIPS_FOUND",
      ],
      [
        `/api/v1/leagues/${LEAGUE_A_ID}/seasons`,
        "LEAGUE_SEASONS_FOUND",
      ],
    ];
    for (const [pathname, code] of requests) {
      const response = await fetch(new URL(pathname, api.baseUrl), {
        headers,
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        PUBLIC_FRONTEND_ORIGIN
      );
      assert.equal(
        response.headers.get("access-control-allow-credentials"),
        "true"
      );
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(body.data.code, code);
      assert.equal(body.meta.requestId, "m3-12-request");
      assert.equal(JSON.stringify(body).includes("@example.test"), false);
    }
    assert.equal(databaseSemanticHash(runtime.database), before);
  });

  test("maps signed-out, malformed, hidden, commissioner, and Origin failures without writes", async (t) => {
    const runtime = createRuntime(t);
    const before = databaseSemanticHash(runtime.database);
    const api = await startLeagueReadApi(t, runtime);
    const signedOut = await fetch(
      new URL("/api/v1/leagues", api.baseUrl),
      {
        headers: browserHeaders(api.sessionCookie, USER_A_ID, {
          includeCookie: false,
        }),
      }
    );
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");

    const malformed = await fetch(
      new URL("/api/v1/leagues/not-an-id", api.baseUrl),
      { headers: browserHeaders(api.sessionCookie, USER_A_ID) }
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "LEAGUE_ID_INVALID");

    const hidden = await fetch(
      new URL(`/api/v1/leagues/${LEAGUE_A_ID}`, api.baseUrl),
      { headers: browserHeaders(api.sessionCookie, PLATFORM_ONLY_ID) }
    );
    const unknown = await fetch(
      new URL(`/api/v1/leagues/${uuid(999)}`, api.baseUrl),
      { headers: browserHeaders(api.sessionCookie, PLATFORM_ONLY_ID) }
    );
    assert.equal(hidden.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal((await hidden.json()).error.code, "LEAGUE_NOT_FOUND");
    assert.equal((await unknown.json()).error.code, "LEAGUE_NOT_FOUND");

    const notCommissioner = await fetch(
      new URL(
        `/api/v1/leagues/${LEAGUE_A_ID}/memberships`,
        api.baseUrl
      ),
      { headers: browserHeaders(api.sessionCookie, USER_B_ID) }
    );
    assert.equal(notCommissioner.status, 403);
    assert.equal(
      (await notCommissioner.json()).error.code,
      "LEAGUE_COMMISSIONER_REQUIRED"
    );

    const badOrigin = await fetch(
      new URL("/api/v1/leagues", api.baseUrl),
      {
        headers: browserHeaders(api.sessionCookie, USER_A_ID, {
          origin: "https://evil.example",
        }),
      }
    );
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, "ORIGIN_NOT_ALLOWED");
    assert.equal(databaseSemanticHash(runtime.database), before);
  });
});
