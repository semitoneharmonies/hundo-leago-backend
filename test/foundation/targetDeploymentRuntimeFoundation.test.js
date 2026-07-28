const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  DATABASE_IDENTITY_KEYS,
  openDeployedTargetRuntime,
} = require("../../src/bootstrap/openDeployedTargetRuntime");
const {
  createSecurityFoundations,
} = require("../../src/bootstrap/createSecurityFoundations");
const {
  createTargetHttpServer,
} = require("../../src/bootstrap/createTargetHttpServer");
const {
  reportTargetStartupFailure,
  startTargetProcess,
} = require("../../src/bootstrap/startTargetProcess");
const {
  TargetRuntimeConfigError,
  loadTargetRuntimeConfig,
  sportsDataIoNhlImport,
} = require("../../src/config/loadTargetRuntimeConfig");
const {
  openDatabase,
  resolveDatabasePath,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createReleaseQaFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureEmail,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");

const ROOT = path.resolve(__dirname, "..", "..");
const PERSISTENT_ROOT = path.join(ROOT, ".target-runtime-test-data");

function deployedEnvironment(overrides = {}) {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_BUILD_ID: "candidate-0123456789abcdef",
    APP_ENVIRONMENT_ID: "hundo-staging-environment-v1",
    DATABASE_ID: "hundo-staging-database-v1",
    FRONTEND_BUILD_ID: "frontend-candidate-0123456789abcdef",
    PORT: "4000",
    DATABASE_PATH: path.join(PERSISTENT_ROOT, "sqlite", "league.sqlite3"),
    PERSISTENT_DATA_ROOT: PERSISTENT_ROOT,
    CURRENT_SEASON_LABEL: "2026",
    CURRENT_NHL_SEASON_KEY: "20262027",
    PUBLIC_FRONTEND_ORIGIN: "https://staging.hundoleago.com",
    FRONTEND_ORIGINS: "https://staging.hundoleago.com",
    LOG_LEVEL: "info",
    SESSION_COOKIE_SAME_SITE: "lax",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
    SCHEDULED_JOBS_ENABLED: "false",
    LEAGUE_WRITE_MODE: "closed",
    DEBUG_ROUTES_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "capture",
    RATE_LIMIT_KEY_SECRET:
      "m7-runtime-rate-limit-secret-material-0123456789",
    AUDIT_METADATA_SECRET:
      "m7-runtime-audit-secret-material-9876543210",
    ACTION_TOKEN_DELIVERY_KEY: Buffer.alloc(32, 0x37).toString("base64url"),
    ...overrides,
  };
}

function createDeployedDatabase(t, { identity = true, migrated = true } = {}) {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m7-target-runtime-")
  );
  const databaseDirectory = path.join(persistentRoot, "sqlite");
  fs.mkdirSync(databaseDirectory);
  const databasePath = path.join(databaseDirectory, "league.sqlite3");
  const seed = openDatabase({ databasePath, environment: "test" });
  if (migrated) {
    migrateDatabase({
      database: seed.database,
      migrationsDirectory: path.join(ROOT, "database", "migrations"),
      applicationBuildId: "candidate-0123456789abcdef",
      now: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
  }
  if (identity) {
    const insert = seed.database.prepare(
      "INSERT INTO application_metadata " +
        "(metadata_key, metadata_value, created_at_ms, updated_at_ms) " +
        "VALUES (?, ?, 0, 0)"
    );
    insert.run(
      DATABASE_IDENTITY_KEYS.environmentId,
      "hundo-staging-environment-v1"
    );
    insert.run(
      DATABASE_IDENTITY_KEYS.databaseId,
      "hundo-staging-database-v1"
    );
    insert.run(
      DATABASE_IDENTITY_KEYS.createdAt,
      "2026-07-22T12:00:00.000Z"
    );
  }
  seed.database.close();
  return { databasePath, persistentRoot };
}

function deployedRuntimeInput(t, options) {
  const paths = createDeployedDatabase(t, options);
  const env = deployedEnvironment({
    DATABASE_PATH: paths.databasePath,
    PERSISTENT_DATA_ROOT: paths.persistentRoot,
  });
  const config = loadTargetRuntimeConfig({ env, backendRoot: ROOT });
  const securityFoundations = createSecurityFoundations({
    env,
    loadConfig: () => config.security,
    now: () => Date.parse("2026-07-22T12:00:00.000Z"),
    loggerSink() {},
  });
  return { config, persistentRoot: paths.persistentRoot, securityFoundations };
}

async function deployedFixtureRuntimeInput(overrides = {}) {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m7-deployed-fixture-")
  );
  const databaseDirectory = path.join(persistentRoot, "sqlite");
  fs.mkdirSync(databaseDirectory);
  const databasePath = path.join(
    databaseDirectory,
    "m7-release-qa.sqlite3"
  );
  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: path.join(ROOT, "database", "migrations"),
    password: "hundo",
    temporaryRoot: persistentRoot,
  });
  const env = deployedEnvironment({
    APP_ENVIRONMENT_ID: FIXTURE_ENVIRONMENT_ID,
    DATABASE_ID: FIXTURE_DATABASE_ID,
    DATABASE_PATH: databasePath,
    PERSISTENT_DATA_ROOT: persistentRoot,
    ...overrides,
  });
  const config = loadTargetRuntimeConfig({ env, backendRoot: ROOT });
  const securityFoundations = createSecurityFoundations({
    env,
    loadConfig: () => config.security,
    now: () => Date.parse("2026-07-25T12:30:00.000Z"),
    loggerSink() {},
  });
  return { config, persistentRoot, securityFoundations };
}

function assertConfigError(env, field) {
  assert.throws(
    () => loadTargetRuntimeConfig({ env, backendRoot: ROOT }),
    (error) =>
      error instanceof TargetRuntimeConfigError && error.field === field
  );
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

async function startApplication(t, runtime) {
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

describe("M7-01 deployed target runtime configuration", () => {
  test("loads one immutable staging runtime configuration without fallbacks", () => {
    const config = loadTargetRuntimeConfig({
      env: deployedEnvironment(),
      backendRoot: ROOT,
    });

    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.currentSeason), true);
    assert.equal(config.appEnv, "staging");
    assert.equal(config.port, 4000);
    assert.equal(config.accountEmailDeliveryEnabled, false);
    assert.equal(config.scheduledJobsEnabled, false);
    assert.equal(config.debugRoutesEnabled, false);
    assert.equal(config.leagueWriteMode, "closed");
    assert.deepEqual(config.sportsDataIoNhl, { enabled: false });
    assert.equal(
      config.frontendBuildId,
      "frontend-candidate-0123456789abcdef"
    );
    assert.deepEqual(config.currentSeason, {
      label: "2026",
      nhlSeasonKey: "20262027",
    });
    assert.equal(
      config.migrationsDirectory,
      path.join(ROOT, "database", "migrations")
    );
    assert.equal(JSON.stringify(config).includes("secret-material"), false);
  });

  test("keeps the SportsDataIO staging key non-enumerable and rejects unsafe provider configuration", () => {
    const config = loadTargetRuntimeConfig({
      env: deployedEnvironment({
        SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
        SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
      }),
      backendRoot: ROOT,
    });
    assert.equal(config.sportsDataIoNhl.enabled, true);
    assert.equal(config.sportsDataIoNhl.apiKey, "test-staging-provider-key");
    assert.equal(JSON.stringify(config).includes("provider-key"), false);
    assertConfigError(
      deployedEnvironment({
        SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
      }),
      "SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR"
    );
    assertConfigError(
      deployedEnvironment({
        SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
        SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
        SPORTSDATAIO_NHL_API_ORIGIN:
          "https://credential-capture.example/v3/nhl",
      }),
      "SPORTSDATAIO_NHL_API_ORIGIN"
    );
    assert.throws(
      () => sportsDataIoNhlImport({
        SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
        SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
      }, "production"),
      (error) =>
        error instanceof TargetRuntimeConfigError &&
        error.field === "SPORTSDATAIO_NHL_API_KEY"
    );
  });

  test("rejects local/test startup, missing identities, unsafe paths, and coercive booleans", () => {
    assertConfigError(
      deployedEnvironment({
        APP_ENV: "local",
        NODE_ENV: "development",
        APP_BUILD_ID: undefined,
        RATE_LIMIT_KEY_SECRET: undefined,
        AUDIT_METADATA_SECRET: undefined,
        ACTION_TOKEN_DELIVERY_KEY: undefined,
      }),
      "APP_ENV"
    );
    assertConfigError(
      deployedEnvironment({ APP_ENVIRONMENT_ID: "short" }),
      "APP_ENVIRONMENT_ID"
    );
    assertConfigError(
      deployedEnvironment({ DATABASE_ID: "production database id" }),
      "DATABASE_ID"
    );
    assertConfigError(
      deployedEnvironment({
        DATABASE_PATH: path.join(ROOT, "outside", "league.sqlite3"),
      }),
      "DATABASE_PATH"
    );
    assertConfigError(
      deployedEnvironment({ SCHEDULED_JOBS_ENABLED: "TRUE" }),
      "SCHEDULED_JOBS_ENABLED"
    );
    assertConfigError(
      deployedEnvironment({ ACCOUNT_EMAIL_DELIVERY_ENABLED: "TRUE" }),
      "ACCOUNT_EMAIL_DELIVERY_ENABLED"
    );
    assertConfigError(
      deployedEnvironment({ LEAGUE_WRITE_MODE: "maintenance" }),
      "LEAGUE_WRITE_MODE"
    );
    assertConfigError(
      deployedEnvironment({ CURRENT_NHL_SEASON_KEY: "20272028" }),
      "CURRENT_NHL_SEASON_KEY"
    );
  });

  test("applies deployed filesystem guards to staging as well as production", () => {
    assert.throws(
      () =>
        resolveDatabasePath({
          databasePath: "relative.sqlite3",
          environment: "staging",
          persistentRoot: PERSISTENT_ROOT,
          requirePersistentRoot: true,
        }),
      { code: "DATABASE_PATH_NOT_ABSOLUTE" }
    );
    assert.throws(
      () =>
        resolveDatabasePath({
          databasePath: path.join(ROOT, "outside", "league.sqlite3"),
          environment: "staging",
          persistentRoot: PERSISTENT_ROOT,
          requirePersistentRoot: true,
        }),
      (error) =>
        [
          "DATABASE_DIRECTORY_NOT_WRITABLE",
          "DATABASE_PATH_OUTSIDE_PERSISTENT_ROOT",
        ].includes(error.code)
    );
  });

  test("opens an existing exact-migration staging database with matching immutable identity", (t) => {
    const input = deployedRuntimeInput(t);
    const runtime = openDeployedTargetRuntime(input);
    t.after(() => runtime.close());
    t.after(() =>
      fs.rmSync(input.persistentRoot, { recursive: true, force: true })
    );

    assert.equal(runtime.migrationState.status, "exact");
    assert.deepEqual(runtime.databaseIdentity, {
      createdAt: "2026-07-22T12:00:00.000Z",
      databaseId: "hundo-staging-database-v1",
      environmentId: "hundo-staging-environment-v1",
    });
    assert.equal(runtime.runtimeConfig, input.config);
    assert.equal(runtime.securityConfig, input.config.security);
    assert.equal(runtime.database.open, true);
  });

  test("starts the enabled open scheduler once without effects when no work is due", async (t) => {
    const input = deployedRuntimeInput(t);
    input.config = Object.freeze({
      ...input.config,
      accountEmailDeliveryEnabled: true,
      scheduledJobsEnabled: true,
      leagueWriteMode: "open",
    });
    const runtime = openDeployedTargetRuntime(input);
    t.after(() => {
      if (runtime.database.open) runtime.close();
      fs.rmSync(input.persistentRoot, { recursive: true, force: true });
    });
    const before = runtime.database.serialize();
    const started = runtime.scheduler.start();
    assert.equal(started.status, "running");
    const cycle = await started.initialRun;
    if (started.emailInitialRun) await started.emailInitialRun;
    assert.equal(cycle.status, "succeeded");
    assert.deepEqual(
      cycle.outcomes.map(({ name }) => name),
      [
        "auction_resolution",
        "trade_expiry",
        "matchup_occurrences",
        "league_outbox",
      ]
    );
    assert.equal(runtime.scheduler.getState(), "running");
    assert.equal(before.equals(runtime.database.serialize()), true);
    await runtime.scheduler.close();
    assert.equal(runtime.scheduler.getState(), "stopped");
  });

  test("starts account email without enabling league scheduled jobs", async (t) => {
    const input = deployedRuntimeInput(t);
    input.config = Object.freeze({
      ...input.config,
      accountEmailDeliveryEnabled: true,
      scheduledJobsEnabled: false,
      leagueWriteMode: "open",
    });
    const runtime = openDeployedTargetRuntime(input);
    t.after(() => {
      if (runtime.database.open) runtime.close();
      fs.rmSync(input.persistentRoot, { recursive: true, force: true });
    });
    const before = runtime.database.serialize();
    const started = runtime.scheduler.start();
    assert.equal(started.status, "email_only");
    if (started.emailInitialRun) await started.emailInitialRun;
    assert.equal(runtime.scheduler.getState(), "disabled");
    assert.equal(before.equals(runtime.database.serialize()), true);
    await runtime.scheduler.close();
  });

  test("refuses missing, uninitialized, mismatched, and behind deployed databases", (t) => {
    const missing = deployedRuntimeInput(t);
    missing.config = Object.freeze({
      ...missing.config,
      databasePath: path.join(missing.config.persistentRoot, "sqlite", "missing.sqlite3"),
    });
    assert.throws(() => openDeployedTargetRuntime(missing), {
      code: "DATABASE_FILE_REQUIRED",
    });

    const uninitialized = deployedRuntimeInput(t, { identity: false });
    assert.throws(() => openDeployedTargetRuntime(uninitialized), {
      code: "DATABASE_IDENTITY_UNINITIALIZED",
    });

    const mismatched = deployedRuntimeInput(t);
    mismatched.config = Object.freeze({
      ...mismatched.config,
      databaseId: "different-staging-database-v1",
    });
    assert.throws(() => openDeployedTargetRuntime(mismatched), {
      code: "DATABASE_IDENTITY_MISMATCH",
    });

    const behind = deployedRuntimeInput(t, { identity: false, migrated: false });
    assert.throws(() => openDeployedTargetRuntime(behind), {
      code: "MIGRATION_DATABASE_BEHIND",
    });
    for (const input of [missing, uninitialized, mismatched, behind]) {
      t.after(() =>
        fs.rmSync(input.persistentRoot, { recursive: true, force: true })
      );
    }
  });

  test("does not initialize, migrate, or compose when preflight checks fail", (t) => {
    const input = deployedRuntimeInput(t);
    let composed = 0;
    input.config = Object.freeze({
      ...input.config,
      environmentId: "different-staging-environment-v1",
    });
    assert.throws(
      () =>
        openDeployedTargetRuntime({
          ...input,
          createRuntimeFunction() {
            composed += 1;
          },
        }),
      { code: "DATABASE_IDENTITY_MISMATCH" }
    );
    assert.equal(composed, 0);

    const inspect = openDatabase({
      databasePath: input.config.databasePath,
      environment: "test",
    });
    t.after(() => inspect.database.close());
    t.after(() =>
      fs.rmSync(input.persistentRoot, { recursive: true, force: true })
    );
    assert.equal(
      inspect.database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get().count,
      21
    );
    assert.equal(
      inspect.database
        .prepare("SELECT COUNT(*) AS count FROM application_metadata")
        .get().count,
      5
    );
  });

  test("serves minimal public health and administrator-only safe operational health without writes", async (t) => {
    const input = deployedRuntimeInput(t);
    const runtime = openDeployedTargetRuntime(input);
    t.after(() => runtime.close());
    t.after(() =>
      fs.rmSync(input.persistentRoot, { recursive: true, force: true })
    );
    const baseUrl = await startApplication(t, runtime);

    const starting = await fetch(new URL("/api/v1/health/ready", baseUrl));
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), {
      data: { status: "not_ready" },
    });

    runtime.health.markReady();
    const live = await fetch(new URL("/api/v1/health/live", baseUrl));
    const ready = await fetch(new URL("/api/v1/health/ready", baseUrl));
    assert.equal(live.status, 200);
    assert.equal(ready.status, 200);
    assert.equal(live.headers.get("x-powered-by"), null);
    assert.equal(ready.headers.get("x-powered-by"), null);
    assert.deepEqual(await live.json(), { data: { status: "live" } });
    assert.deepEqual(await ready.json(), { data: { status: "ready" } });

    const beforeBlockedWrite = runtime.database.serialize();
    const blockedWrite = await fetch(new URL("/api/v1/accounts", baseUrl), {
      method: "POST",
      headers: {
        Origin: "https://staging.hundoleago.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "blocked@example.test",
        displayName: "Blocked Manager",
        password: "correct horse battery staple",
        passwordConfirmation: "correct horse battery staple",
      }),
    });
    assert.equal(blockedWrite.status, 503);
    assert.equal((await blockedWrite.json()).error.code, "LEAGUE_WRITES_CLOSED");
    assert.deepEqual(runtime.database.serialize(), beforeBlockedWrite);

    const anonymous = await fetch(
      new URL("/api/v1/operations/health", baseUrl),
      { headers: { Origin: "https://staging.hundoleago.com" } }
    );
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, "SESSION_REQUIRED");

    const userId = uuid(7101);
    runtime.repositories.users.insert({
      id: userId,
      email_normalized: "m7-admin@example.test",
      email_display: "m7-admin@example.test",
      display_name: "M7 Administrator",
      display_name_normalized: "m7 administrator",
      status: "active",
      created_at_ms: Date.parse("2026-07-22T12:00:00.000Z"),
      updated_at_ms: Date.parse("2026-07-22T12:00:00.000Z"),
      version: 1,
    });
    runtime.repositories.platformRoles.insertActive({
      id: uuid(7102),
      user_id: userId,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: null,
      granted_at_ms: Date.parse("2026-07-22T12:00:00.000Z"),
      ended_at_ms: null,
      version: 1,
    });
    const session = runtime.services.sessionService.issueForUser({ userId });
    const before = runtime.database.serialize();
    const operations = await fetch(
      new URL("/api/v1/operations/health", baseUrl),
      {
        headers: {
          Origin: "https://staging.hundoleago.com",
          Cookie:
            `${runtime.transport.sessionCookie.name}=` +
            session.rawSessionToken,
        },
      }
    );
    const body = await operations.json();
    assert.equal(operations.status, 200);
    assert.deepEqual(
      Object.keys(body.data).sort(),
      [
        "accountEmailDelivery",
        "backendBuildId",
        "databaseIdSuffix",
        "environment",
        "environmentId",
        "frontendBuildId",
        "lastValidStatisticsRefresh",
        "lastVerifiedBackup",
        "lifecycle",
        "maintenance",
        "migrationChecksumSetId",
        "outbox",
        "scheduler",
        "schemaVersion",
        "sportsDataIoNhl",
      ].sort()
    );
    assert.equal(body.data.environment, "staging");
    assert.equal(body.data.schemaVersion, 21);
    assert.equal(body.data.scheduler.state, "disabled");
    assert.deepEqual(body.data.accountEmailDelivery, { enabled: false });
    assert.deepEqual(body.data.maintenance, { state: "closed" });
    assert.deepEqual(body.data.sportsDataIoNhl, {
      provider: "sportsdataio-discovery-lab",
      enabled: false,
      dataScope: "last-season-only",
      staleAfterMs: 259200000,
      lastSuccessfulImport: null,
      stale: true,
    });
    assert.deepEqual(body.data.outbox, {
      pending: 0,
      publishing: 0,
      failed: 0,
    });
    assert.match(body.data.migrationChecksumSetId, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      input.config.databasePath,
      input.config.persistentRoot,
      "RATE_LIMIT_KEY_SECRET",
      "secret-material",
      "league.sqlite3",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(runtime.database.serialize(), before);
  });

  test("executes the exact composed staging-fixture reset route with administrator session and CSRF checks", async (t) => {
    const input = await deployedFixtureRuntimeInput();
    const runtime = openDeployedTargetRuntime(input);
    t.after(() => {
      if (runtime.database.open) runtime.close();
      fs.rmSync(input.persistentRoot, { recursive: true, force: true });
    });
    const baseUrl = await startApplication(t, runtime);
    const teamId = fixtureId("team:leagueA:1");
    runtime.database
      .prepare(`
        UPDATE teams
        SET name = 'Changed Through Deployed Runtime',
          name_normalized = 'changed through deployed runtime',
          version = version + 1
        WHERE id = ?
      `)
      .run(teamId);
    const administratorId = fixtureId("account:platformAdmin");
    assert.equal(
      runtime.database
        .prepare("SELECT email_display FROM users WHERE id = ?")
        .get(administratorId).email_display,
      fixtureEmail("platformAdmin")
    );
    const session = runtime.services.sessionService.issueForUser({
      userId: administratorId,
    });

    const response = await fetch(
      new URL(
        "/api/v1/operations/staging-fixture-reset",
        baseUrl
      ),
      {
        method: "POST",
        headers: {
          Origin: "https://staging.hundoleago.com",
          "Content-Type": "application/json",
          Cookie:
            `${runtime.transport.sessionCookie.name}=` +
            session.rawSessionToken,
          "Idempotency-Key": "deployed-runtime-reset-one",
          "X-CSRF-Token": session.rawCsrfToken,
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        },
        body: JSON.stringify({
          confirmation: "RESET STAGING TEST LEAGUES",
          reason: "Verify the fully composed deployed reset route.",
        }),
      }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(
      body.data.code,
      "STAGING_FIXTURE_RESET_COMPLETED"
    );
    assert.equal(body.data.sessionInvalidated, true);
    assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(
      runtime.database
        .prepare("SELECT name FROM teams WHERE id = ?")
        .get(teamId).name,
      "Alpha Owls"
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM operational_events
          WHERE event_type = 'staging_fixture_reset'
            AND actor_user_id = ?
        `)
        .get(administratorId).count,
      1
    );
    assert.deepEqual(
      runtime.services.sessionService.resolveWithoutActivity(
        session.rawSessionToken
      ),
      { valid: false, code: "SESSION_INVALID" }
    );
  });

  test("executes the exact composed staging provider import and replays it without another provider request", async (t) => {
    const providerRows = Array.from(
      { length: 800 },
      (_, index) => ({
        PlayerID: index + 10_000,
        FirstName: "Provider",
        LastName: `Player ${String(index + 1).padStart(3, "0")}`,
        Name:
          `Provider Player ${String(index + 1).padStart(3, "0")}`,
        Status: "Active",
        Team: "TST",
        Position: index % 5 === 0 ? "D" : "C",
        BirthDate: "1998-02-03T00:00:00Z",
        Updated: "2026-04-18T12:00:00Z",
      })
    );
    const statisticsRows = providerRows.map((player) => ({
      PlayerID: player.PlayerID,
      Name: player.Name,
      Team: player.Team,
      Position: player.Position,
      Games: 82,
      Goals: 20,
      Assists: 30,
      Season: 2026,
      SeasonType: 1,
      Updated: "2026-04-18T12:00:00Z",
    }));
    const providerCalls = [];
    const input = await deployedFixtureRuntimeInput({
      SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
      SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
    });
    const runtime = openDeployedTargetRuntime({
      ...input,
      sportsDataIoFetchImplementation: async (url, options) => {
        providerCalls.push({ url, options });
        return {
          ok: true,
          async json() {
            if (url.endsWith("/Players")) return providerRows;
            if (url.endsWith("/FreeAgents")) return [];
            return statisticsRows;
          },
        };
      },
    });
    t.after(() => {
      if (runtime.database.open) runtime.close();
      fs.rmSync(input.persistentRoot, {
        recursive: true,
        force: true,
      });
    });
    const baseUrl = await startApplication(t, runtime);
    const administratorId =
      fixtureId("account:platformAdmin");
    const session = runtime.services.sessionService.issueForUser({
      userId: administratorId,
    });
    const requestOptions = {
      method: "POST",
      headers: {
        Origin: "https://staging.hundoleago.com",
        "Content-Type": "application/json",
        Cookie:
          `${runtime.transport.sessionCookie.name}=` +
          session.rawSessionToken,
        "Idempotency-Key":
          "deployed-runtime-provider-import-one",
        "X-CSRF-Token": session.rawCsrfToken,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
      body: JSON.stringify({
        confirmation: "IMPORT SPORTSDATAIO STAGING DATA",
        reason:
          "Populate hosted staging for release acceptance.",
      }),
    };
    const importUrl = new URL(
      "/api/v1/operations/staging-sportsdataio-import",
      baseUrl
    );

    const response = await fetch(importUrl, requestOptions);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(
      body.data.code,
      "STAGING_SPORTSDATAIO_IMPORT_COMPLETED"
    );
    assert.equal(body.data.catalog.createdPlayerCount, 800);
    assert.equal(body.data.statistics.playerCount, 800);
    assert.equal(providerCalls.length, 4);
    assert.equal(
      providerCalls.every(
        ({ url }) => !url.includes("test-staging-provider-key")
      ),
      true
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM player_external_ids
        WHERE provider = 'sportsdataio-discovery-lab'
      `).get().count,
      800
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM player_stat_totals AS total
        JOIN stat_sources AS source
          ON source.id = total.stat_source_id
        WHERE source.provider = 'sportsdataio-discovery-lab'
      `).get().count,
      800
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM operational_events
        WHERE event_type = 'staging_sportsdataio_import'
          AND outcome = 'succeeded'
          AND actor_user_id = ?
      `).get(administratorId).count,
      1
    );

    const replay = await fetch(importUrl, requestOptions);
    const replayBody = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayBody.data.replayed, true);
    assert.equal(providerCalls.length, 4);

    const matchupHealthResponse = await fetch(
      new URL(
        `/api/v1/leagues/${fixtureId("league:leagueA")}` +
          `/seasons/${fixtureId("season:leagueA:current")}` +
          "/matchup-weeks",
        baseUrl
      ),
      {
        headers: {
          Origin: "https://staging.hundoleago.com",
          Cookie:
            `${runtime.transport.sessionCookie.name}=` +
            session.rawSessionToken,
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        },
      }
    );
    const matchupHealthBody =
      await matchupHealthResponse.json();
    assert.equal(matchupHealthResponse.status, 200);
    assert.equal(
      matchupHealthBody.data.health.statistics.status,
      "stale"
    );
    assert.notEqual(
      matchupHealthBody.data.health.statistics.status,
      "unavailable"
    );
  });

  test("makes readiness true only after listen and false before closing resources", async (t) => {
    const input = deployedRuntimeInput(t);
    const runtime = openDeployedTargetRuntime(input);
    t.after(() => runtime.close());
    t.after(() =>
      fs.rmSync(input.persistentRoot, { recursive: true, force: true })
    );
    const shutdownObservations = [];
    class ObservedSocketServer {
      use() {}
      on() {}
      close(callback) {
        shutdownObservations.push(runtime.health.readReadiness().status);
        callback();
      }
    }
    const server = createTargetHttpServer({
      runtime,
      securityConfig: runtime.securityConfig,
      SocketServerClass: ObservedSocketServer,
    });
    assert.equal(runtime.health.readReadiness().status, "not_ready");
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    assert.equal(runtime.health.readReadiness().status, "ready");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/health/ready`
    );
    assert.equal(response.status, 200);

    const firstClose = server.close();
    const secondClose = server.close();
    assert.equal(firstClose, secondClose);
    assert.equal(runtime.health.readReadiness().status, "not_ready");
    await firstClose;
    assert.deepEqual(shutdownObservations, ["not_ready"]);
    assert.equal(runtime.health.readLiveness().status, "not_live");
    assert.equal(runtime.database.open, false);
  });

  test("starts once and handles SIGTERM through one idempotent graceful shutdown", async () => {
    const processObject = new EventEmitter();
    processObject.exitCode = 0;
    const events = [];
    let closeCalls = 0;
    const config = Object.freeze({
      port: 4321,
      scheduledJobsEnabled: false,
      debugRoutesEnabled: false,
      security: Object.freeze({ appEnv: "staging" }),
    });
    const foundations = {
      config: config.security,
      logger: {
        info(event, context) {
          events.push({ event, context });
        },
        error(event, context) {
          events.push({ event, context });
        },
      },
    };
    let schedulerStarts = 0;
    const runtime = Object.freeze({
      marker: "runtime",
      scheduler: Object.freeze({
        start() {
          schedulerStarts += 1;
          return Object.freeze({ status: "disabled" });
        },
      }),
    });
    const server = {
      async listen(options) {
        assert.deepEqual(options, { port: 4321 });
        return { address: "0.0.0.0", port: 4321 };
      },
      async close() {
        closeCalls += 1;
      },
    };
    const running = await startTargetProcess({
      env: Object.freeze({}),
      processObject,
      loadConfig: () => config,
      createFoundations: () => foundations,
      openRuntime(options) {
        assert.equal(options.config, config);
        assert.equal(options.securityFoundations, foundations);
        return runtime;
      },
      createServer(options) {
        assert.equal(options.runtime, runtime);
        assert.equal(options.securityConfig, config.security);
        return server;
      },
    });
    assert.equal(processObject.listenerCount("SIGTERM"), 1);
    assert.equal(processObject.listenerCount("SIGINT"), 1);
    assert.equal(schedulerStarts, 1);
    processObject.emit("SIGTERM");
    const first = running.shutdown("SIGTERM");
    const second = running.shutdown("SIGINT");
    assert.equal(first, second);
    await first;
    assert.equal(closeCalls, 1);
    assert.equal(processObject.listenerCount("SIGTERM"), 0);
    assert.equal(processObject.listenerCount("SIGINT"), 0);
    assert.deepEqual(
      events.map(({ event }) => event),
      [
        "target_runtime.ready",
        "target_runtime.shutdown_started",
        "target_runtime.shutdown_complete",
      ]
    );
    assert.equal(processObject.exitCode, 0);
  });

  test("requires the scheduler lifecycle, keeps debug routes closed, and reports no raw startup error", async () => {
    let dependenciesCreated = 0;
    await assert.rejects(
      startTargetProcess({
        processObject: new EventEmitter(),
        loadConfig: () => ({
          port: 4000,
          scheduledJobsEnabled: false,
          debugRoutesEnabled: true,
        }),
        createFoundations() {
          dependenciesCreated += 1;
        },
        openRuntime() {
          dependenciesCreated += 1;
        },
        createServer() {
          dependenciesCreated += 1;
        },
      }),
      { code: "TARGET_DEBUG_ROUTES_FORBIDDEN" }
    );
    assert.equal(dependenciesCreated, 0);

    const processObject = new EventEmitter();
    processObject.off = processObject.off.bind(processObject);
    await assert.rejects(
      startTargetProcess({
        processObject,
        loadConfig: () => ({
          port: 4000,
          scheduledJobsEnabled: true,
          debugRoutesEnabled: false,
          security: Object.freeze({ appEnv: "staging" }),
        }),
        createFoundations: () => ({
          config: Object.freeze({ appEnv: "staging" }),
          logger: { info() {}, error() {} },
        }),
        openRuntime: () => Object.freeze({}),
        createServer() {
          throw new Error("server composition must not be reached");
        },
      }),
      { code: "TARGET_SCHEDULER_REQUIRED" }
    );

    let output = "";
    const error = new Error(
      "database C:\\private\\league.sqlite3 secret=do-not-print"
    );
    error.code = "DATABASE_OPEN_FAILED";
    reportTargetStartupFailure(error, {
      write(value) {
        output += value;
      },
    });
    assert.deepEqual(JSON.parse(output), {
      severity: "error",
      event: "target_runtime.start_failed",
      code: "DATABASE_OPEN_FAILED",
      message: "The target runtime failed to start safely.",
    });
    assert.equal(output.includes("private"), false);
    assert.equal(output.includes("do-not-print"), false);

    output = "";
    const configError = new Error("must not be printed");
    configError.code = "SECURITY_CONFIG_INVALID";
    configError.field = "FRONTEND_ORIGINS";
    reportTargetStartupFailure(configError, {
      write(value) {
        output += value;
      },
    });
    assert.deepEqual(JSON.parse(output), {
      severity: "error",
      event: "target_runtime.start_failed",
      code: "SECURITY_CONFIG_INVALID",
      message: "The target runtime failed to start safely.",
      field: "FRONTEND_ORIGINS",
    });
    assert.equal(output.includes("must not be printed"), false);
  });
});
