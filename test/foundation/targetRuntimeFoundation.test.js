const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const express = require("express");

const {
  TARGET_ENDPOINTS,
  TARGET_ROUTER_KEYS,
  createTargetApplication,
  createTargetRuntime,
  openTargetRuntime,
  selectTargetRouterKey,
} = require("../../src/bootstrap/createTargetRuntime");
const {
  createSecurityFoundations,
} = require("../../src/bootstrap/createSecurityFoundations");
const {
  createTargetHttpServer,
} = require("../../src/bootstrap/createTargetHttpServer");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createScryptPasswordHasher,
} = require("../../src/infrastructure/security/createScryptPasswordHasher");
const {
  createTestAccount,
} = require("../helpers/createTestAccount");
const {
  seedFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-22T12:00:00.000Z");
const PUBLIC_FRONTEND_ORIGIN = "https://staging-hundo.netlify.app";
const TRACKED_COMPATIBILITY_FILES = Object.freeze([
  "league.json",
  "league_with_meta.json",
  "players.json",
]);

function securityEnv({ configured = true } = {}) {
  return {
    APP_ENV: configured ? "staging" : "local",
    NODE_ENV: configured ? "production" : "development",
    ...(configured ? { APP_BUILD_ID: "m3-19-test-build" } : {}),
    LOG_LEVEL: configured ? "info" : "debug",
    PUBLIC_FRONTEND_ORIGIN: configured
      ? PUBLIC_FRONTEND_ORIGIN
      : "http://localhost:5173",
    FRONTEND_ORIGINS: configured
      ? PUBLIC_FRONTEND_ORIGIN
      : "http://localhost:5173",
    EMAIL_DELIVERY_MODE: "capture",
    ...(configured
      ? {
          RATE_LIMIT_KEY_SECRET:
            "m3-19-rate-limit-secret-material-0123456789",
          AUDIT_METADATA_SECRET:
            "m3-19-audit-secret-material-9876543210",
          ACTION_TOKEN_DELIVERY_KEY: Buffer.alloc(32, 0x5a).toString(
            "base64url"
          ),
        }
      : {}),
  };
}

function foundations(options) {
  return createSecurityFoundations({
    env: securityEnv(options),
    now: () => NOW_MS,
    loggerSink() {},
  });
}

function createDatabase(t, { migrated = true } = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-19-runtime-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "target.sqlite3"),
    environment: "test",
  });
  if (migrated) {
    migrateDatabase({
      database: connection.database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      applicationBuildId: "m3-19-test-build",
      now: () => NOW_MS,
    });
  }
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return connection.database;
}

function createOwnedTargetRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(temporaryRoot, "target.sqlite3");
  const seedConnection = openDatabase({
    databasePath,
    environment: "test",
  });
  migrateDatabase({
    database: seedConnection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-19-test-build",
    now: () => NOW_MS,
  });
  seedConnection.database.close();
  const runtime = openTargetRuntime({
    ...runtimeOptions(undefined),
    databasePath,
    environment: "test",
  });
  t.after(() => {
    runtime.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return runtime;
}

function runtimeOptions(database, overrides = {}) {
  return {
    database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    securityFoundations: foundations(),
    currentSeason: {
      label: "2026",
      nhlSeasonKey: "20262027",
    },
    networkSourceResolver() {
      return "198.51.100.0/24";
    },
    ...overrides,
  };
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seedTwoLeagueProfileScenario(runtime) {
  const repositories = runtime.repositories.context.repositories;
  const managerUserId = uuid(1101);
  const otherUserId = uuid(1102);
  const visibleLeagueId = uuid(1201);
  const hiddenLeagueId = uuid(1202);
  const managerMembershipId = uuid(1301);
  const otherMembershipId = uuid(1302);
  const teamId = uuid(1401);
  const hiddenTeamId = uuid(1402);

  for (const [id, email, displayName] of [
    [managerUserId, "manager@m3-19.test", "M3 Manager"],
    [otherUserId, "other@m3-19.test", "Other Commissioner"],
  ]) {
    repositories.users.insert({
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
  for (const [id, name] of [
    [visibleLeagueId, "Visible League"],
    [hiddenLeagueId, "Hidden League"],
  ]) {
    repositories.leagues.insert({
      id,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  repositories.league_memberships.insert({
    id: managerMembershipId,
    league_id: visibleLeagueId,
    user_id: managerUserId,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: otherMembershipId,
    league_id: hiddenLeagueId,
    user_id: otherUserId,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: hiddenLeagueId,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: otherMembershipId,
      updated_at_ms: NOW_MS,
    },
  });
  repositories.teams.insert({
    id: teamId,
    league_id: visibleLeagueId,
    name: "Target Owls",
    name_normalized: "target owls",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.teams.insert({
    id: hiddenTeamId,
    league_id: hiddenLeagueId,
    name: "Hidden Ravens",
    name_normalized: "hidden ravens",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.team_manager_assignments.insert({
    id: uuid(1501),
    league_id: visibleLeagueId,
    team_id: teamId,
    user_id: managerUserId,
    membership_id: managerMembershipId,
    assigned_by_user_id: otherUserId,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  repositories.team_manager_assignments.insert({
    id: uuid(1502),
    league_id: hiddenLeagueId,
    team_id: hiddenTeamId,
    user_id: otherUserId,
    membership_id: otherMembershipId,
    assigned_by_user_id: otherUserId,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  const session = runtime.services.sessionService.issueForUser({
    userId: managerUserId,
  });
  return Object.freeze({
    hiddenLeagueId,
    hiddenTeamId,
    managerUserId,
    session,
    teamId,
    visibleLeagueId,
  });
}

function seedCommissionerInvitationScenario(runtime) {
  const repositories = runtime.repositories.context.repositories;
  const commissionerUserId = uuid(2101);
  const invitedUserId = uuid(2102);
  const leagueId = uuid(2201);
  const commissionerMembershipId = uuid(2301);
  for (const [id, email, displayName] of [
    [commissionerUserId, "commissioner@m3-19.test", "M3 Commissioner"],
    [invitedUserId, "invitee@m3-19.test", "Invited Manager"],
  ]) {
    repositories.users.insert({
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
  repositories.leagues.insert({
    id: leagueId,
    name: "Commissioner League",
    name_normalized: "commissioner league",
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_settings.insert({
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
  repositories.league_memberships.insert({
    id: commissionerMembershipId,
    league_id: leagueId,
    user_id: commissionerUserId,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: leagueId,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: commissionerMembershipId,
      updated_at_ms: NOW_MS,
    },
  });
  return Object.freeze({
    commissionerSession: runtime.services.sessionService.issueForUser({
      userId: commissionerUserId,
    }),
    commissionerUserId,
    invitedSession: runtime.services.sessionService.issueForUser({
      userId: invitedUserId,
    }),
    invitedUserId,
    leagueId,
  });
}

async function startRuntimeApp(t, runtime) {
  const server = runtime.app.listen(0, "127.0.0.1");
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
  return `http://127.0.0.1:${server.address().port}`;
}

function createTargetSocket(runtime, session) {
  return {
    data: {},
    disconnected: false,
    handshake: {
      headers: {
        origin: PUBLIC_FRONTEND_ORIGIN,
        cookie:
          `${runtime.transport.sessionCookie.name}=` +
          session.rawSessionToken,
      },
    },
    rooms: new Set(["target-socket"]),
    async join(room) {
      this.rooms.add(room);
    },
    async leave(room) {
      this.rooms.delete(room);
    },
    disconnect(force) {
      this.disconnected = force === true;
      this.rooms.clear();
    },
  };
}

function runSocketMiddleware(middleware, socket) {
  return new Promise((resolve) => {
    middleware(socket, (error) => resolve(error));
  });
}

function browserHeaders(extra = {}) {
  return {
    Origin: PUBLIC_FRONTEND_ORIGIN,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...extra,
  };
}

function concretePath(path) {
  return path
    .replace(":leagueId", "00000000-0000-4000-8000-000000000001")
    .replace(":teamId", "00000000-0000-4000-8000-000000000002")
    .replace(":playerId", "00000000-0000-4000-8000-000000000005")
    .replace(":invitationId", "00000000-0000-4000-8000-000000000003")
    .replace(":assignmentId", "00000000-0000-4000-8000-000000000004");
}

function createMarkerRouters() {
  return Object.freeze(
    Object.fromEntries(
      TARGET_ROUTER_KEYS.map((routerKey) => [
        routerKey,
        (request, response) => response.status(200).json({ routerKey }),
      ])
    )
  );
}

function installedTargetEndpoints(routers) {
  return Object.entries(routers).flatMap(([routerKey, router]) =>
    router.stack.flatMap((layer) => {
      if (!layer.route) return [];
      return Object.entries(layer.route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => ({
          method: method.toUpperCase(),
          path: layer.route.path,
          routerKey,
        }));
    })
  );
}

describe("M3-19 exact target endpoint dispatch", () => {
  test("declares 79 unique method/path contracts across the exact router set", () => {
    assert.equal(TARGET_ENDPOINTS.length, 79);
    assert.equal(
      new Set(TARGET_ENDPOINTS.map(({ method, path }) => `${method} ${path}`))
        .size,
      79
    );
    assert.deepEqual(TARGET_ROUTER_KEYS, [
      "accountRegistration",
      "accountSession",
      "activityNotification",
      "auction",
      "commissionerAssignment",
      "commissionerCorrection",
      "leagueInvitation",
      "leagueRead",
      "matchup",
      "platformAdministration",
      "player",
      "publicRoster",
      "team",
      "teamManagerAssignment",
      "teamProfile",
      "trade",
      "tradeRecovery",
    ]);
  });

  test("selects exactly one intended router for every endpoint and preflight", () => {
    for (const endpoint of TARGET_ENDPOINTS) {
      const path = concretePath(endpoint.path);
      assert.equal(
        selectTargetRouterKey(endpoint.method, path),
        endpoint.routerKey,
        `${endpoint.method} ${endpoint.path}`
      );
      assert.equal(
        selectTargetRouterKey("OPTIONS", path, endpoint.method),
        endpoint.routerKey,
        `OPTIONS ${endpoint.path} -> ${endpoint.method}`
      );
    }
    assert.equal(selectTargetRouterKey("GET", "/api/v1/unknown"), null);
    assert.equal(
      selectTargetRouterKey(
        "POST",
        "/api/v1/leagues/not-a-uuid/teams/not-a-uuid/logo"
      ),
      null
    );
  });

  test("requires the exact router set and creates an application without listening", () => {
    assert.throws(
      () => createTargetApplication({ routers: {} }),
      /exact target router set/
    );
    const app = createTargetApplication({
      routers: createMarkerRouters(),
      expressModule: express,
    });
    assert.equal(typeof app, "function");
    assert.equal(app.listen instanceof Function, true);
    assert.equal(app._router, undefined);
  });

  test("makes the target runtime the deployment entrypoint without compatibility startup", () => {
    const productionEntrypoint = fs.readFileSync(
      path.join(ROOT_DIRECTORY, "server.js"),
      "utf8"
    );
    assert.equal(productionEntrypoint.includes("startTargetProcess"), true);
    for (const forbidden of ["createCompatibilityRuntime", "startBackgroundJobs"]) {
      assert.equal(productionEntrypoint.includes(forbidden), false, forbidden);
    }
  });
});

describe("M3-19 exact-schema target dependency composition", () => {
  test("constructs every repository, service, router, and socket boundary without writes or listening", (t) => {
    const database = createDatabase(t);
    const before = database.serialize();
    const options = runtimeOptions(database);
    const runtime = createTargetRuntime(options);
    assert.equal(runtime.migrationState.status, "exact");
    assert.equal(runtime.migrationState.userVersion, 18);
    assert.equal(
      typeof runtime.services.league.auctionResolution.resolveDue,
      "function"
    );
    assert.deepEqual(
      Object.keys(runtime.transport.routers).sort(),
      TARGET_ROUTER_KEYS
    );
    assert.equal(typeof runtime.services.account.signIn.signIn, "function");
    assert.equal(
      typeof runtime.services.accountEmail.deliveryService.deliverDue,
      "function"
    );
    assert.equal(
      typeof runtime.services.accountEmail.job.start,
      "function"
    );
    assert.equal(runtime.services.accountEmail.job.isStarted(), false);
    assert.equal(typeof runtime.repositories.auctions.startAuction, "function");
    assert.equal(
      typeof runtime.repositories.tradeProposals.loadFoundationState,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.tradeProposals.readDetail,
      "function"
    );
    assert.equal(typeof runtime.repositories.auctionBids.putBid, "function");
    assert.equal(
      typeof runtime.repositories.auctionResolutions.loadCandidate,
      "function"
    );
    assert.equal(typeof runtime.services.league.auction.list, "function");
    assert.equal(typeof runtime.services.league.auction.read, "function");
    assert.equal(typeof runtime.services.league.auction.start, "function");
    assert.equal(
      typeof runtime.services.league.tradeProposalFoundation.preview,
      "function"
    );
    assert.equal(typeof runtime.services.league.tradeRead.read, "function");
    assert.equal(
      typeof runtime.services.league.tradeProposalCreation.create,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeProposalLifecycle.respond,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeAcceptancePreview.preview,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeAcceptance.accept,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeProposalExpiry.run,
      "function"
    );
    assert.equal(runtime.services.league.tradeProposalExpiry.isRunning(), false);
    assert.equal(typeof runtime.services.league.auction.putMine, "function");
    assert.equal(
      typeof runtime.services.league.auction.putAsCommissioner,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.auctionResolutionDecision.decideDue,
      "function"
    );
    assert.equal(typeof runtime.services.league.teamProfile.update, "function");
    assert.equal(typeof runtime.services.league.publicRoster.read, "function");
    assert.equal(typeof runtime.services.players.list, "function");
    assert.equal(typeof runtime.services.players.read, "function");
    assert.equal(typeof runtime.services.leaguePlayers.list, "function");
    assert.equal(typeof runtime.services.leaguePlayers.read, "function");
    assert.equal(typeof runtime.services.league.matchup.listWeeks, "function");
    assert.equal(typeof runtime.services.league.matchup.rebuildStandings, "function");
    assert.equal(typeof runtime.repositories.matchupRead.readSchedule, "function");
    assert.equal(typeof runtime.repositories.players.listPage, "function");
    assert.equal(
      typeof runtime.repositories.leaguePlayers.listByPlayerIds,
      "function"
    );
    assert.equal(
      runtime.securityConfig,
      options.securityFoundations.config
    );
    assert.equal(typeof runtime.socketRooms.middleware, "function");
    assert.equal(typeof runtime.app.listen, "function");
    assert.equal(before.equals(database.serialize()), true);
  });

  test("installs every declared target method and path exactly once in its intended router", (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const sortEndpoint = ({ method, path, routerKey }) =>
      `${method} ${path} ${routerKey}`;
    const actual = installedTargetEndpoints(runtime.transport.routers)
      .map(sortEndpoint)
      .sort();
    const expected = TARGET_ENDPOINTS.map(sortEndpoint).sort();
    assert.equal(new Set(actual).size, actual.length);
    assert.deepEqual(actual, expected);
  });

  test("fails closed for an unmigrated database before constructing repositories", (t) => {
    const database = createDatabase(t, { migrated: false });
    const before = database.serialize();
    assert.throws(
      () => createTargetRuntime(runtimeOptions(database)),
      { code: "MIGRATION_DATABASE_BEHIND" }
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("requires configured independent runtime secrets even for local composition", (t) => {
    const database = createDatabase(t);
    const before = database.serialize();
    assert.throws(
      () =>
        createTargetRuntime(
          runtimeOptions(database, {
            securityFoundations: foundations({ configured: false }),
          })
        ),
      /configured rate-limit key/
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("opens and idempotently closes an explicit local or test database", (t) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-m3-19-owned-runtime-")
    );
    const databasePath = path.join(temporaryRoot, "target.sqlite3");
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const seedConnection = openDatabase({
      databasePath,
      environment: "test",
    });
    migrateDatabase({
      database: seedConnection.database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      applicationBuildId: "m3-19-test-build",
      now: () => NOW_MS,
    });
    seedConnection.database.close();

    const runtime = openTargetRuntime({
      ...runtimeOptions(undefined),
      databasePath,
      environment: "test",
    });
    assert.equal(runtime.databasePath, databasePath);
    assert.equal(runtime.database.open, true);
    runtime.close();
    runtime.close();
    assert.equal(runtime.database.open, false);
  });

  test("closes an owned database when startup fails and rejects shared environments", (t) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-m3-19-failed-runtime-")
    );
    const databasePath = path.join(temporaryRoot, "unmigrated.sqlite3");
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    let openedDatabase;
    assert.throws(
      () =>
        openTargetRuntime({
          ...runtimeOptions(undefined),
          databasePath,
          environment: "test",
          openDatabaseFunction(options) {
            const connection = openDatabase(options);
            openedDatabase = connection.database;
            return connection;
          },
        }),
      { code: "MIGRATION_DATABASE_BEHIND" }
    );
    assert.equal(openedDatabase.open, false);

    let openAttempted = false;
    assert.throws(
      () =>
        openTargetRuntime({
          ...runtimeOptions(undefined),
          databasePath,
          environment: "staging",
          openDatabaseFunction() {
            openAttempted = true;
          },
        }),
      /only in local or test environments/
    );
    assert.equal(openAttempted, false);
  });
});

describe("M3-19 composed target HTTP boundary", () => {
  test("registers through the composed endpoint without touching compatibility JSON", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const baseUrl = await startRuntimeApp(t, runtime);
    const protectedPaths = TRACKED_COMPATIBILITY_FILES;
    const before = new Map(
      protectedPaths.map((file) => [
        file,
        fs.readFileSync(path.join(ROOT_DIRECTORY, file)),
      ])
    );
    const response = await fetch(new URL("/api/v1/accounts", baseUrl), {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({
        email: "new.manager@example.test",
        displayName: "New Manager",
        password: "correct horse battery staple",
        passwordConfirmation: "correct horse battery staple",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(body.data, { accepted: true });
    assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    const user = database.prepare(
      "SELECT id, status FROM users WHERE email_normalized = ?"
    ).get("new.manager@example.test");
    assert.equal(user.status, "pending_verification");
    const credential = database.prepare(
      "SELECT password_hash FROM user_credentials WHERE user_id = ? AND status = 'active'"
    ).get(user.id);
    assert.match(credential.password_hash, /^scrypt\$/);
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'pending'"
      ).get().count,
      1
    );
    assert.deepEqual(
      await runtime.services.accountEmail.deliveryService.deliverDue(),
      [
        {
          eventId: database
            .prepare(
              "SELECT id FROM outbox_events WHERE aggregate_id = ?"
            )
            .get(user.id).id,
          outcome: "published",
        },
      ]
    );
    const captured = runtime.services.accountEmail.adapter.listCaptured();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].to, "new.manager@example.test");
    assert.match(captured[0].verificationUrl, /#token=[A-Za-z0-9_-]{43}$/u);
    for (const [file, bytes] of before) {
      assert.equal(
        bytes.equals(fs.readFileSync(path.join(ROOT_DIRECTORY, file))),
        true,
        file
      );
    }
  });

  test("signs in, bootstraps read-only, enforces CSRF, and signs out through the composed session router", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const password = "correct horse battery staple";
    const account = await createTestAccount({
      repositoryContext: runtime.repositories.context,
      userRepository: runtime.repositories.users,
      credentialRepository: runtime.repositories.credentials,
      passwordHasher: createScryptPasswordHasher({
        secureRandom: securityFoundations.secureRandom,
      }),
      clock: securityFoundations.clock,
      secureRandom: securityFoundations.secureRandom,
      emailNormalized: "session.manager@example.test",
      emailDisplay: "Session.Manager@Example.Test",
      displayName: "Session Manager",
      displayNameNormalized: "session manager",
      password,
    });
    const baseUrl = await startRuntimeApp(t, runtime);
    const sessionUrl = new URL("/api/v1/session", baseUrl);
    const signIn = await fetch(sessionUrl, {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({
        email: " Session.Manager@Example.Test ",
        password,
      }),
    });
    const signInBody = await signIn.json();
    assert.equal(signIn.status, 200);
    assert.equal(signInBody.data.user.id, account.user.id);
    const setCookie = signIn.headers.get("set-cookie");
    assert.match(setCookie, /^__Host-hl_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=None/);
    const cookie = setCookie.split(";", 1)[0];

    const beforeBootstrap = database.serialize();
    const bootstrap = await fetch(sessionUrl, {
      headers: browserHeaders({ Cookie: cookie }),
    });
    const bootstrapBody = await bootstrap.json();
    assert.equal(bootstrap.status, 200);
    assert.equal(
      bootstrapBody.data.session.id,
      signInBody.data.session.id
    );
    assert.equal(
      bootstrapBody.data.csrfToken,
      signInBody.data.csrfToken
    );
    assert.equal(
      bootstrapBody.data.user.displayName,
      "Session Manager"
    );
    assert.equal(beforeBootstrap.equals(database.serialize()), true);

    const beforeBadCsrf = database.serialize();
    const badCsrf = await fetch(sessionUrl, {
      method: "DELETE",
      headers: browserHeaders({
        Cookie: cookie,
        "X-CSRF-Token": "invalid",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error.code, "CSRF_INVALID");
    assert.equal(beforeBadCsrf.equals(database.serialize()), true);

    const signOut = await fetch(sessionUrl, {
      method: "DELETE",
      headers: browserHeaders({
        Cookie: cookie,
        "X-CSRF-Token": signInBody.data.csrfToken,
      }),
      body: JSON.stringify({}),
    });
    assert.equal(signOut.status, 200);
    assert.equal((await signOut.json()).data.code, "SESSION_SIGNED_OUT");
    assert.match(
      signOut.headers.get("set-cookie"),
      /^__Host-hl_session=; Max-Age=0;/
    );
    const rejected = await fetch(sessionUrl, {
      headers: browserHeaders({ Cookie: cookie }),
    });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, "SESSION_REQUIRED");
  });

  test("previews and applies an audited commissioner roster addition through the composed routers", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const passwordHash = await createScryptPasswordHasher({
      secureRandom: securityFoundations.secureRandom,
    }).hash("correct horse battery staple");
    database.transaction(() => {
      seedFixture(database, passwordHash, {
        includeIdentityMetadata: false,
      });
    }).immediate();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const baseUrl = await startRuntimeApp(t, runtime);
    const leagueId = fixtureId("league:leagueA");
    const playerId = fixtureId("player:freeAgentForward");
    const session = runtime.services.sessionService.issueForUser({
      userId: fixtureId("account:leagueACommissioner"),
    });
    const headers = browserHeaders({
      Cookie:
        `${runtime.transport.sessionCookie.name}=` +
        session.rawSessionToken,
      "X-CSRF-Token": session.rawCsrfToken,
    });
    const workspaceResponse = await fetch(
      new URL(
        `/api/v1/leagues/${leagueId}/commissioner/roster-workspace`,
        baseUrl
      ),
      { headers }
    );
    const workspaceBody = await workspaceResponse.json();
    assert.equal(workspaceResponse.status, 200);
    const workspace = workspaceBody.data.workspace;
    assert.equal(workspace.league.id, leagueId);
    assert.equal(
      workspace.freeAgents.some((player) => player.playerId === playerId),
      true
    );
    const teamId = fixtureId("team:leagueA:1");
    const occupiedForwardSlots = new Set(
      workspace.roster
        .filter((player) =>
          player.teamId === teamId &&
          player.rosterCategory === "Active" &&
          player.positionGroup === "F"
        )
        .map((player) => player.slotNumber)
    );
    const slotNumber = Array.from(
      { length: 12 },
      (_, index) => index + 1
    ).find((slot) => !occupiedForwardSlots.has(slot));
    assert.equal(Number.isSafeInteger(slotNumber), true);
    const request = {
      seasonId: workspace.league.currentSeasonId,
      playerId,
      teamId,
      rosterCategory: "Active",
      positionGroup: "F",
      slotNumber,
      contractType: "normal",
      originalTotalValueCents: 200,
      termYears: 1,
      reason: "Restore a missing staging roster assignment.",
    };
    const previewUrl = new URL(
      `/api/v1/leagues/${leagueId}/commissioner/roster-additions/previews`,
      baseUrl
    );
    const beforePreview = database.serialize();
    const previewResponse = await fetch(previewUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const previewBody = await previewResponse.json();
    assert.equal(
      previewResponse.status,
      200,
      JSON.stringify(previewBody)
    );
    assert.equal(
      previewBody.data.code,
      "COMMISSIONER_ROSTER_ADD_CORRECTION_PREVIEWED"
    );
    assert.equal(previewBody.data.preview, true);
    assert.equal(beforePreview.equals(database.serialize()), true);

    const applyUrl = new URL(
      `/api/v1/leagues/${leagueId}/commissioner/roster-additions`,
      baseUrl
    );
    const applyHeaders = {
      ...headers,
      "Idempotency-Key": "m7-10-composed-roster-addition",
    };
    const applyResponse = await fetch(applyUrl, {
      method: "POST",
      headers: applyHeaders,
      body: JSON.stringify({ ...request, confirmWarnings: false }),
    });
    const applyBody = await applyResponse.json();
    assert.equal(applyResponse.status, 200);
    assert.equal(
      applyBody.data.code,
      "COMMISSIONER_ROSTER_ADD_CORRECTION_APPLIED"
    );
    assert.equal(applyBody.data.evidence.activityType, "commissioner_player_added");
    const replayResponse = await fetch(applyUrl, {
      method: "POST",
      headers: applyHeaders,
      body: JSON.stringify({ ...request, confirmWarnings: false }),
    });
    assert.equal(replayResponse.status, 200);
    assert.deepEqual((await replayResponse.json()).data, applyBody.data);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM player_ownerships
        WHERE league_id = ? AND player_id = ?
      `).get(leagueId, playerId).count,
      1
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM commissioner_corrections
        WHERE league_id = ? AND feature = 'roster_add'
      `).get(leagueId).count,
      1
    );
  });

  test("serves isolated read-only league player context through the composed player router", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const passwordHash = await createScryptPasswordHasher({
      secureRandom: securityFoundations.secureRandom,
    }).hash("correct horse battery staple");
    database.transaction(() => {
      seedFixture(database, passwordHash, {
        includeIdentityMetadata: false,
      });
    }).immediate();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const baseUrl = await startRuntimeApp(t, runtime);
    const leagueId = fixtureId("league:leagueA");
    const hiddenLeagueId = fixtureId("league:leagueB");
    const playerId = fixtureId("player:activeForward3");
    const session = runtime.services.sessionService.issueForUser({
      userId: fixtureId("account:leagueACommissioner"),
    });
    const headers = browserHeaders({
      Cookie:
        `${runtime.transport.sessionCookie.name}=` +
        session.rawSessionToken,
    });
    const before = database.serialize();

    const collection = await fetch(
      new URL(
        `/api/v1/leagues/${leagueId}/players?query=Fixture%20Player%2003`,
        baseUrl
      ),
      { headers }
    );
    const collectionBody = await collection.json();
    assert.equal(collection.status, 200);
    assert.equal(collectionBody.data.length, 1);
    assert.equal(collectionBody.data[0].id, playerId);
    assert.equal(collectionBody.data[0].league.id, leagueId);

    const detail = await fetch(
      new URL(
        `/api/v1/leagues/${leagueId}/players/${playerId}`,
        baseUrl
      ),
      { headers }
    );
    const detailBody = await detail.json();
    assert.equal(detail.status, 200);
    assert.deepEqual(detailBody.data.league, {
      id: leagueId,
      ownership: {
        kind: "Rostered",
        category: "Active",
        team: {
          id: fixtureId("team:leagueA:3"),
          name: "Alpha Wolves",
        },
      },
      activeContract: {
        originalTotalValueCents: 750,
        originalTermYears: 3,
        aavCents: 250,
        remainingYears: 3,
      },
    });

    const globalDetail = await fetch(
      new URL(`/api/v1/players/${playerId}`, baseUrl),
      { headers }
    );
    const globalBody = await globalDetail.json();
    assert.equal(globalDetail.status, 200);
    assert.equal(
      Object.prototype.hasOwnProperty.call(globalBody.data, "league"),
      false
    );

    const crossLeague = await fetch(
      new URL(
        `/api/v1/leagues/${hiddenLeagueId}/players/${playerId}`,
        baseUrl
      ),
      { headers }
    );
    assert.equal(crossLeague.status, 404);
    assert.equal(
      (await crossLeague.json()).error.code,
      "LEAGUE_NOT_FOUND"
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("rate-limits repeated failed sign-ins through the composed session router", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const baseUrl = await startRuntimeApp(t, runtime);
    const statuses = [];
    let finalBody;
    let finalRetryAfter;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await fetch(new URL("/api/v1/session", baseUrl), {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          email: "unknown-rate-limit@example.test",
          password: "incorrect password",
        }),
      });
      statuses.push(response.status);
      finalRetryAfter = response.headers.get("retry-after");
      finalBody = await response.json();
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    assert.equal(finalBody.error.code, "RATE_LIMITED");
    assert.equal(Number(finalRetryAfter) > 0, true);
    assert.equal(
      JSON.stringify(finalBody).includes("unknown-rate-limit@example.test"),
      false
    );
  });

  test("routes anonymous session denial and method-aware profile preflight through their own boundaries", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const baseUrl = await startRuntimeApp(t, runtime);
    const before = database.serialize();
    const session = await fetch(new URL("/api/v1/session", baseUrl), {
      headers: { Origin: PUBLIC_FRONTEND_ORIGIN },
    });
    assert.equal(session.status, 401);
    assert.equal((await session.json()).error.code, "SESSION_REQUIRED");

    const preflight = await fetch(
      new URL(
        "/api/v1/leagues/00000000-0000-4000-8000-000000000001/teams/00000000-0000-4000-8000-000000000002",
        baseUrl
      ),
      {
        method: "OPTIONS",
        headers: {
          Origin: PUBLIC_FRONTEND_ORIGIN,
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers":
            "Content-Type, X-CSRF-Token, If-Match, Idempotency-Key",
        },
      }
    );
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    assert.match(
      preflight.headers.get("access-control-allow-methods"),
      /PATCH/
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("keeps two-league visibility scoped while a real manager updates and reads a team logo", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const baseUrl = await startRuntimeApp(t, runtime);
    const compatibilityFiles = TRACKED_COMPATIBILITY_FILES;
    const compatibilityBefore = new Map(
      compatibilityFiles.map((file) => [
        file,
        fs.readFileSync(path.join(ROOT_DIRECTORY, file)),
      ])
    );
    const sessionHeaders = {
      ...browserHeaders(),
      Cookie:
        `${runtime.transport.sessionCookie.name}=` +
        scenario.session.rawSessionToken,
    };

    const leagueListResponse = await fetch(
      new URL("/api/v1/leagues", baseUrl),
      { headers: sessionHeaders }
    );
    const leagueListBody = await leagueListResponse.json();
    assert.equal(leagueListResponse.status, 200);
    assert.deepEqual(
      leagueListBody.data.leagues.map(({ id }) => id),
      [scenario.visibleLeagueId]
    );

    const hiddenResponse = await fetch(
      new URL(`/api/v1/leagues/${scenario.hiddenLeagueId}`, baseUrl),
      { headers: sessionHeaders }
    );
    assert.equal(hiddenResponse.status, 404);
    assert.equal((await hiddenResponse.json()).error.code, "LEAGUE_NOT_FOUND");

    const logoBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const teamUrl = new URL(
      `/api/v1/leagues/${scenario.visibleLeagueId}/teams/${scenario.teamId}`,
      baseUrl
    );
    const updateResponse = await fetch(teamUrl, {
      method: "PATCH",
      headers: {
        ...sessionHeaders,
        "If-Match": '"1"',
        "Idempotency-Key": "m3-19-composed-profile",
        "X-CSRF-Token": scenario.session.rawCsrfToken,
      },
      body: JSON.stringify({
        name: "Composed Owls",
        primaryColour: "#102030",
        secondaryColour: "#abcdef",
        logo: {
          mediaType: "image/png",
          contentBase64: logoBytes.toString("base64"),
        },
      }),
    });
    const updateBody = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updateBody.data.team.name, "Composed Owls");
    assert.equal(updateBody.data.team.version, 2);
    assert.equal(
      updateBody.data.team.logoReference,
      `/api/v1/leagues/${scenario.visibleLeagueId}/teams/${scenario.teamId}/logo`
    );

    const beforeStaleUpdate = database.serialize();
    const staleUpdate = await fetch(teamUrl, {
      method: "PATCH",
      headers: {
        ...sessionHeaders,
        "If-Match": '"1"',
        "Idempotency-Key": "m3-19-stale-composed-profile",
        "X-CSRF-Token": scenario.session.rawCsrfToken,
      },
      body: JSON.stringify({ name: "Stale Owls" }),
    });
    const staleBody = await staleUpdate.json();
    assert.equal(staleUpdate.status, 412);
    assert.equal(staleBody.error.code, "PRECONDITION_FAILED");
    assert.deepEqual(staleBody.error.details, {
      currentVersion: 2,
      refetch: true,
    });
    assert.equal(beforeStaleUpdate.equals(database.serialize()), true);

    const beforeLogoRead = database.serialize();
    const logoResponse = await fetch(
      new URL(updateBody.data.team.logoReference, baseUrl),
      { headers: sessionHeaders }
    );
    assert.equal(logoResponse.status, 200);
    assert.equal(logoResponse.headers.get("content-type"), "image/png");
    assert.equal(
      Buffer.from(await logoResponse.arrayBuffer()).equals(logoBytes),
      true
    );
    assert.equal(beforeLogoRead.equals(database.serialize()), true);
    for (const [file, bytes] of compatibilityBefore) {
      assert.equal(
        bytes.equals(fs.readFileSync(path.join(ROOT_DIRECTORY, file))),
        true,
        file
      );
    }
  });

  test("runs commissioner team creation and manager invitation acceptance through the composed routers", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedCommissionerInvitationScenario(runtime);
    const baseUrl = await startRuntimeApp(t, runtime);
    const compatibilityFiles = TRACKED_COMPATIBILITY_FILES;
    const compatibilityBefore = new Map(
      compatibilityFiles.map((file) => [
        file,
        fs.readFileSync(path.join(ROOT_DIRECTORY, file)),
      ])
    );
    function authenticatedHeaders(session, idempotencyKey) {
      return browserHeaders({
        Cookie:
          `${runtime.transport.sessionCookie.name}=` +
          session.rawSessionToken,
        "X-CSRF-Token": session.rawCsrfToken,
        "Idempotency-Key": idempotencyKey,
      });
    }

    const teamCollectionUrl = new URL(
      `/api/v1/leagues/${scenario.leagueId}/teams`,
      baseUrl
    );
    const teamHeaders = authenticatedHeaders(
      scenario.commissionerSession,
      "m3-19-composed-team-create"
    );
    const beforeDenied = database.serialize();
    const denied = await fetch(teamCollectionUrl, {
      method: "POST",
      headers: { ...teamHeaders, "X-CSRF-Token": "invalid" },
      body: JSON.stringify({ name: "Composed Falcons" }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, "CSRF_INVALID");
    assert.equal(beforeDenied.equals(database.serialize()), true);

    const created = await fetch(teamCollectionUrl, {
      method: "POST",
      headers: teamHeaders,
      body: JSON.stringify({ name: "Composed Falcons" }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdBody.data.code, "TEAM_CREATED");
    assert.equal(createdBody.data.team.currentManager, null);
    const teamId = createdBody.data.team.id;
    const replayed = await fetch(teamCollectionUrl, {
      method: "POST",
      headers: teamHeaders,
      body: JSON.stringify({ name: "composed falcons" }),
    });
    assert.equal(replayed.status, 200);
    assert.deepEqual((await replayed.json()).data, createdBody.data);

    const invitationResponse = await fetch(
      new URL(`/api/v1/leagues/${scenario.leagueId}/invitations`, baseUrl),
      {
        method: "POST",
        headers: authenticatedHeaders(
          scenario.commissionerSession,
          "m3-19-composed-manager-invitation"
        ),
        body: JSON.stringify({
          userId: scenario.invitedUserId,
          workflow: "manage_team",
          teamId,
        }),
      }
    );
    const invitationBody = await invitationResponse.json();
    assert.equal(invitationResponse.status, 201);
    assert.equal(
      invitationBody.data.code,
      "LEAGUE_INVITATION_CREATED"
    );
    const invitationId = invitationBody.data.invitation.id;
    const targetUrl = new URL(
      `/api/v1/league-invitations/${invitationId}`,
      baseUrl
    );
    const invitedHeaders = authenticatedHeaders(
      scenario.invitedSession,
      "m3-19-unused-target-key"
    );
    const readInvitation = await fetch(targetUrl, {
      headers: invitedHeaders,
    });
    assert.equal(readInvitation.status, 200);
    assert.equal(
      (await readInvitation.json()).data.code,
      "LEAGUE_INVITATION_FOUND"
    );
    const accepted = await fetch(
      new URL(`${targetUrl.pathname}/accept`, baseUrl),
      {
        method: "POST",
        headers: invitedHeaders,
        body: JSON.stringify({}),
      }
    );
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.data.code, "LEAGUE_INVITATION_ACCEPTED");
    assert.equal(acceptedBody.data.membership.status, "active");
    assert.equal(acceptedBody.data.managerAssignment.status, "accepted");

    const managedTeam = await fetch(
      new URL(
        `/api/v1/leagues/${scenario.leagueId}/teams/${teamId}`,
        baseUrl
      ),
      { headers: invitedHeaders }
    );
    const managedTeamBody = await managedTeam.json();
    assert.equal(managedTeam.status, 200);
    assert.equal(
      managedTeamBody.data.team.currentManager.userId,
      scenario.invitedUserId
    );
    for (const [file, bytes] of compatibilityBefore) {
      assert.equal(
        bytes.equals(fs.readFileSync(path.join(ROOT_DIRECTORY, file))),
        true,
        file
      );
    }
  });
});

describe("M3-19 composed target Socket.IO authorization", () => {
  test("joins only the current user's visible league and managed-team rooms without writes", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const socket = createTargetSocket(runtime, scenario.session);
    const before = database.serialize();

    const error = await runSocketMiddleware(
      runtime.socketRooms.middleware,
      socket
    );
    assert.equal(error, undefined);
    assert.deepEqual([...socket.rooms].sort(), [
      `league:${scenario.visibleLeagueId}`,
      "target-socket",
      `team:${scenario.teamId}`,
      `user:${scenario.managerUserId}`,
    ]);
    assert.equal(socket.rooms.has(`league:${scenario.hiddenLeagueId}`), false);
    assert.equal(socket.rooms.has(`team:${scenario.hiddenTeamId}`), false);
    assert.deepEqual(runtime.socketRooms.getAuthority(socket), {
      userId: scenario.managerUserId,
      rooms: [
        `user:${scenario.managerUserId}`,
        `league:${scenario.visibleLeagueId}`,
        `team:${scenario.teamId}`,
      ],
    });
    assert.equal(before.equals(database.serialize()), true);
  });

  test("fails a composed handshake closed for a non-allowlisted origin without writes", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const socket = createTargetSocket(runtime, scenario.session);
    socket.handshake.headers.origin = "https://evil.example";
    const before = database.serialize();

    const error = await runSocketMiddleware(
      runtime.socketRooms.middleware,
      socket
    );
    assert.deepEqual(error.data, { code: "SOCKET_ORIGIN_NOT_ALLOWED" });
    assert.deepEqual([...socket.rooms], ["target-socket"]);
    assert.equal(runtime.socketRooms.getAuthority(socket), null);
    assert.equal(before.equals(database.serialize()), true);
  });
});

describe("M3-19 local target HTTP and Socket.IO server lifecycle", () => {
  test("attaches authenticated socket middleware once, listens, and closes idempotently without jobs", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const instances = [];
    class FakeSocketServer {
      constructor(server, options) {
        this.server = server;
        this.options = options;
        this.middlewares = [];
        this.handlers = [];
        this.closeCalls = 0;
        instances.push(this);
      }
      use(middleware) {
        this.middlewares.push(middleware);
      }
      on(event, handler) {
        this.handlers.push({ event, handler });
      }
      close(callback) {
        this.closeCalls += 1;
        callback();
      }
    }
    const targetServer = createTargetHttpServer({
      runtime,
      securityConfig: securityFoundations.config,
      SocketServerClass: FakeSocketServer,
    });
    assert.equal(instances.length, 1);
    assert.deepEqual(instances[0].middlewares, [runtime.socketRooms.middleware]);
    assert.deepEqual(
      instances[0].handlers.map(({ event }) => event),
      ["connection"]
    );
    assert.equal(runtime.app.get("io"), instances[0]);
    const allowed = await new Promise((resolve) => {
      instances[0].options.cors.origin(
        PUBLIC_FRONTEND_ORIGIN,
        (error, accepted) => resolve({ error, accepted })
      );
    });
    assert.equal(allowed.error, null);
    assert.equal(allowed.accepted, true);
    const blocked = await new Promise((resolve) => {
      instances[0].options.cors.origin(
        "https://evil.example",
        (error, accepted) => resolve({ error, accepted })
      );
    });
    assert.match(blocked.error.message, /Socket CORS blocked/);
    assert.equal(blocked.accepted, undefined);

    const address = await targetServer.listen({
      port: 0,
      host: "127.0.0.1",
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/session`,
      { headers: { Origin: PUBLIC_FRONTEND_ORIGIN } }
    );
    assert.equal(response.status, 401);
    const firstClose = targetServer.close();
    const secondClose = targetServer.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    assert.equal(instances[0].closeCalls, 1);
    assert.equal(targetServer.server.listening, false);
  });

  test("closes an owned SQLite runtime when listening is rejected before startup", async (t) => {
    const runtime = createOwnedTargetRuntime(
      t,
      "hundo-m3-19-listen-failure-"
    );
    let socketCloseCalls = 0;
    class FakeSocketServer {
      use() {}
      on() {}
      close(callback) {
        socketCloseCalls += 1;
        callback();
      }
    }
    const targetServer = createTargetHttpServer({
      runtime,
      securityConfig: runtime.securityConfig,
      SocketServerClass: FakeSocketServer,
    });
    await assert.rejects(
      targetServer.listen({ port: -1, host: "127.0.0.1" }),
      /valid port/
    );
    assert.equal(socketCloseCalls, 1);
    assert.equal(targetServer.server.listening, false);
    assert.equal(runtime.database.open, false);
  });

  test("continues shutdown through HTTP and SQLite when Socket.IO close fails", async (t) => {
    const runtime = createOwnedTargetRuntime(
      t,
      "hundo-m3-19-close-failure-"
    );
    class FailingSocketServer {
      use() {}
      on() {}
      close(callback) {
        callback(new Error("injected Socket.IO close failure"));
      }
    }
    const targetServer = createTargetHttpServer({
      runtime,
      securityConfig: runtime.securityConfig,
      SocketServerClass: FailingSocketServer,
    });
    await targetServer.listen({ port: 0, host: "127.0.0.1" });
    await assert.rejects(
      targetServer.close(),
      (error) =>
        error instanceof AggregateError &&
        error.errors[0].message === "injected Socket.IO close failure"
    );
    assert.equal(targetServer.server.listening, false);
    assert.equal(runtime.database.open, false);
  });
});
