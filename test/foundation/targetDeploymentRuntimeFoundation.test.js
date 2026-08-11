const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  DATABASE_IDENTITY_KEYS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_STARTUP_ERROR_CODE,
  loadSportsDataIoLiveProbeManifest,
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
  SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST_RELATIVE_PATH,
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
  ROUTE_PATH: STAGING_FIXTURE_RESET_ROUTE_PATH,
} = require("../../src/transport/http/createStagingFixtureResetRouter");
const {
  ROUTE_PATH: STAGING_SPORTSDATAIO_IMPORT_ROUTE_PATH,
} = require("../../src/transport/http/createStagingSportsDataIoImportRouter");
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
  hashSportsDataIoLiveCapabilityProbeManifest,
} = require(
  "../../src/operations/statistics/createSportsDataIoLiveCapabilityCheck"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureEmail,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");

const ROOT = path.resolve(__dirname, "..", "..");
const PERSISTENT_ROOT = path.join(ROOT, ".target-runtime-test-data");
const SPORTSDATAIO_LIVE_API_KEY =
  "target-runtime-live-provider-key-0123456789";
const SPORTSDATAIO_LIVE_CAPABILITY_SECRET =
  "target-runtime-live-capability-secret-9876543210";

function liveProviderEnvironment(mode, overrides = {}) {
  return deployedEnvironment({
    SPORTSDATAIO_NHL_LIVE_MODE: mode,
    SPORTSDATAIO_NHL_LIVE_API_KEY:
      SPORTSDATAIO_LIVE_API_KEY,
    SPORTSDATAIO_NHL_LIVE_API_ORIGIN:
      "https://api.sportsdata.io",
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET:
      SPORTSDATAIO_LIVE_CAPABILITY_SECRET,
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION: "7",
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT: path.join(
      PERSISTENT_ROOT,
      "provider-capability",
      "sportsdataio-live-v1.json"
    ),
    ...overrides,
  });
}

function liveCapabilityProbeManifest() {
  return {
    domain:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
    schemaVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
    probeKind: "historical_offseason",
    configuredNhlSeasonKey: "20262027",
    probeNhlSeasonKey: "20252026",
    players: [
      {
        playerId: uuid(8101),
        providerPlayerId: "101",
        expectedDisposition: "expected_game",
      },
      {
        playerId: uuid(8102),
        providerPlayerId: "102",
        expectedDisposition: "no_due_game",
      },
      {
        playerId: uuid(8103),
        providerPlayerId: "103",
        expectedDisposition: "no_team",
      },
    ],
    historicalZeroGame: {
      playerId: uuid(8101),
      providerPlayerId: "101",
      providerTeamId: "10",
      nhlGameId: "8001",
      nhlGameScheduledStartsAtMs:
        Date.parse("2026-04-18T19:00:00.000Z"),
    },
  };
}

function liveCapabilityVerificationReceipt() {
  const verifiedAtMs = Date.parse("2026-07-22T12:00:00.000Z");
  const issuedAtMs = verifiedAtMs - 1_000;
  return Object.freeze({
    status: "verified",
    evidenceId: uuid(8999),
    evidenceSha256: "a".repeat(64),
    issuedAtMs,
    expiresAtMs: issuedAtMs + 86_400_000,
    verifiedAtMs,
  });
}

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
    SPORTSDATAIO_NHL_LIVE_MODE: "disabled",
    PUBLIC_FRONTEND_ORIGIN: "https://staging.hundoleago.com",
    FRONTEND_ORIGINS: "https://staging.hundoleago.com",
    LOG_LEVEL: "info",
    SESSION_COOKIE_SAME_SITE: "lax",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
    SCHEDULED_JOBS_ENABLED: "false",
    FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
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

function requiredDeployedRuntimeInput(t, overrides = {}) {
  const paths = createDeployedDatabase(t);
  const env = liveProviderEnvironment("required", {
    DATABASE_PATH: paths.databasePath,
    PERSISTENT_DATA_ROOT: paths.persistentRoot,
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT: path.join(
      paths.persistentRoot,
      "provider-capability",
      "sportsdataio-live-v1.json"
    ),
    ...overrides,
  });
  const config = loadTargetRuntimeConfig({
    env,
    backendRoot: ROOT,
  });
  const securityFoundations = createSecurityFoundations({
    env,
    loadConfig: () => config.security,
    now: () => Date.parse("2026-07-22T12:00:00.000Z"),
    loggerSink() {},
  });
  return {
    config,
    persistentRoot: paths.persistentRoot,
    securityFoundations,
  };
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
      error?.field === field &&
      [
        "TARGET_RUNTIME_CONFIG_INVALID",
        "SECURITY_CONFIG_INVALID",
      ].includes(error.code)
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
    assert.equal(config.freeAgentDraftRoutesEnabled, false);
    assert.equal(config.leagueWriteMode, "closed");
    assert.deepEqual(config.sportsDataIoLiveNhl, {
      mode: "disabled",
      enabled: false,
      verified: false,
      probeManifestPath: path.join(
        ROOT,
        SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST_RELATIVE_PATH
      ),
    });
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

  test("loads closed SportsDataIO live modes without consulting the legacy import credential", () => {
    const legacyOnly = loadTargetRuntimeConfig({
      env: deployedEnvironment({
        SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
        SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
      }),
      backendRoot: ROOT,
    });
    assert.equal(legacyOnly.sportsDataIoLiveNhl.mode, "disabled");
    assert.equal(legacyOnly.sportsDataIoLiveNhl.enabled, false);
    assert.equal(legacyOnly.sportsDataIoLiveNhl.verified, false);
    assert.equal(
      legacyOnly.security.sportsDataIoLive.apiKey.configured,
      false
    );
    assert.deepEqual(legacyOnly.sportsDataIoNhl, {
      enabled: true,
      origin: "https://api.sportsdata.io/api/nhl/fantasy",
      seasonStartYear: "2025",
      nhlSeasonKey: "20252026",
    });

    const expectedProbeManifestPath = path.join(
      ROOT,
      SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST_RELATIVE_PATH
    );
    for (const mode of ["probe", "required"]) {
      const config = loadTargetRuntimeConfig({
        env: liveProviderEnvironment(mode),
        backendRoot: ROOT,
      });
      assert.deepEqual(config.sportsDataIoLiveNhl, {
        mode,
        enabled: false,
        verified: false,
        origin: "https://api.sportsdata.io",
        nhlSeasonKey: "20262027",
        capabilityKeyVersion: 7,
        artifactPath: path.join(
          PERSISTENT_ROOT,
          "provider-capability",
          "sportsdataio-live-v1.json"
        ),
        probeManifestPath: expectedProbeManifestPath,
      });
      assert.equal(
        config.security.sportsDataIoLive.apiKey.value,
        SPORTSDATAIO_LIVE_API_KEY
      );
      assert.equal(
        config.security.sportsDataIoLive.capabilitySecret.value,
        SPORTSDATAIO_LIVE_CAPABILITY_SECRET
      );
      const serialized = JSON.stringify(config);
      assert.equal(serialized.includes(SPORTSDATAIO_LIVE_API_KEY), false);
      assert.equal(
        serialized.includes(
          SPORTSDATAIO_LIVE_CAPABILITY_SECRET
        ),
        false
      );
    }
  });

  test("rejects invalid live modes, missing or extra bindings, and unsafe paths", () => {
    assertConfigError(
      deployedEnvironment({
        SPORTSDATAIO_NHL_LIVE_MODE: undefined,
      }),
      "SPORTSDATAIO_NHL_LIVE_MODE"
    );
    assertConfigError(
      deployedEnvironment({
        SPORTSDATAIO_NHL_LIVE_MODE: "enabled",
      }),
      "SPORTSDATAIO_NHL_LIVE_MODE"
    );

    for (const [field, value] of [
      ["SPORTSDATAIO_NHL_LIVE_API_KEY", SPORTSDATAIO_LIVE_API_KEY],
      [
        "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET",
        SPORTSDATAIO_LIVE_CAPABILITY_SECRET,
      ],
      ["SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION", "7"],
      [
        "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT",
        path.join(PERSISTENT_ROOT, "provider-capability", "artifact.json"),
      ],
    ]) {
      assertConfigError(
        deployedEnvironment({ [field]: value }),
        field
      );
    }

    for (const field of [
      "SPORTSDATAIO_NHL_LIVE_API_KEY",
      "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET",
      "SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION",
      "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT",
      "SPORTSDATAIO_NHL_LIVE_API_ORIGIN",
    ]) {
      assertConfigError(
        liveProviderEnvironment("probe", {
          [field]: undefined,
          ...(field === "SPORTSDATAIO_NHL_LIVE_API_KEY"
            ? {
                SPORTSDATAIO_NHL_API_KEY:
                  "legacy-import-key-cannot-enable-live",
                SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
              }
            : {}),
        }),
        field
      );
    }

    assertConfigError(
      liveProviderEnvironment("probe", {
        SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST:
          path.join(ROOT, "unapproved-probe.json"),
      }),
      "SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST"
    );

    for (const origin of [
      "http://api.sportsdata.io",
      "https://credential-capture.example",
      "https://api.sportsdata.io/api/nhl/fantasy",
      "https://api.sportsdata.io?redirect=1",
    ]) {
      assertConfigError(
        liveProviderEnvironment("required", {
          SPORTSDATAIO_NHL_LIVE_API_ORIGIN: origin,
        }),
        "SPORTSDATAIO_NHL_LIVE_API_ORIGIN"
      );
    }

    for (const version of ["0", "01", "+1", "1.0", "99999999999999999999"]) {
      assertConfigError(
        liveProviderEnvironment("required", {
          SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION: version,
        }),
        "SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION"
      );
    }

    for (const artifactPath of [
      PERSISTENT_ROOT,
      path.join(ROOT, "outside-provider-capability.json"),
      path.join("provider-capability", "sportsdataio-live-v1.json"),
      `${PERSISTENT_ROOT}${path.sep}provider-capability${path.sep}..${path.sep}sportsdataio-live-v1.json`,
    ]) {
      assertConfigError(
        liveProviderEnvironment("required", {
          SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT:
            artifactPath,
        }),
        "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT"
      );
    }
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
      deployedEnvironment({ FREE_AGENT_DRAFT_ROUTES_ENABLED: undefined }),
      "FREE_AGENT_DRAFT_ROUTES_ENABLED"
    );
    assertConfigError(
      deployedEnvironment({ FREE_AGENT_DRAFT_ROUTES_ENABLED: "TRUE" }),
      "FREE_AGENT_DRAFT_ROUTES_ENABLED"
    );
    assertConfigError(
      deployedEnvironment({ FREE_AGENT_DRAFT_ROUTES_ENABLED: "true" }),
      "FREE_AGENT_DRAFT_ROUTES_ENABLED"
    );
    assert.equal(
      loadTargetRuntimeConfig({
        env: liveProviderEnvironment("required", {
          FREE_AGENT_DRAFT_ROUTES_ENABLED: "true",
        }),
        backendRoot: ROOT,
      }).freeAgentDraftRoutesEnabled,
      true
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

  test("FAD-05 live capability startup loads and hashes only the exact build-owned manifest", () => {
    const manifest = liveCapabilityProbeManifest();
    const raw = Buffer.from(JSON.stringify(manifest));
    const manifestPath = path.join(
      ROOT,
      SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST_RELATIVE_PATH
    );
    let reads = 0;
    const loaded = loadSportsDataIoLiveProbeManifest({
      manifestPath,
      fsModule: {
        readFileSync(filePath) {
          reads += 1;
          assert.equal(filePath, manifestPath);
          return raw;
        },
      },
    });
    assert.equal(reads, 1);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.manifest), true);
    assert.deepEqual(loaded.manifest, manifest);
    assert.equal(
      loaded.probeManifestSha256,
      hashSportsDataIoLiveCapabilityProbeManifest(manifest)
    );
    assert.equal(raw.every((value) => value === 0), true);

    const forbiddenPath = path.join(
      ROOT,
      "private",
      "unapproved-probe.json"
    );
    let caught;
    try {
      loadSportsDataIoLiveProbeManifest({
        manifestPath: forbiddenPath,
        fsModule: {
          readFileSync() {
            throw new Error(
              `${forbiddenPath}:${SPORTSDATAIO_LIVE_API_KEY}:raw-provider-row-marker`
            );
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(
      caught?.code,
      SPORTS_DATA_IO_LIVE_CAPABILITY_STARTUP_ERROR_CODE
    );
    const serialized = JSON.stringify({
      message: caught?.message,
      code: caught?.code,
    });
    for (const forbidden of [
      forbiddenPath,
      SPORTSDATAIO_LIVE_API_KEY,
      "raw-provider-row-marker",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });

  test("FAD-05 live capability startup skips artifact work in disabled and probe modes", () => {
    for (const mode of ["disabled", "probe"]) {
      const missingDatabasePath = path.join(
        PERSISTENT_ROOT,
        "sqlite",
        `missing-${mode}-live-capability.sqlite3`
      );
      const env = mode === "disabled"
        ? deployedEnvironment({
            DATABASE_PATH: missingDatabasePath,
          })
        : liveProviderEnvironment("probe", {
            DATABASE_PATH: missingDatabasePath,
          });
      const config = loadTargetRuntimeConfig({
        env,
        backendRoot: ROOT,
      });
      const securityFoundations = createSecurityFoundations({
        env,
        loadConfig: () => config.security,
        now: () => Date.parse("2026-07-22T12:00:00.000Z"),
        loggerSink() {},
      });
      let manifestLoads = 0;
      let authenticatorCreations = 0;
      let artifactStoreCreations = 0;
      let databaseOpens = 0;
      let runtimeCompositions = 0;
      assert.throws(
        () =>
          openDeployedTargetRuntime({
            config,
            securityFoundations,
            loadSportsDataIoLiveProbeManifestFunction() {
              manifestLoads += 1;
            },
            createSportsDataIoLiveCapabilityAuthenticatorFunction() {
              authenticatorCreations += 1;
            },
            createSportsDataIoLiveCapabilityArtifactFunction() {
              artifactStoreCreations += 1;
            },
            openDatabaseFunction() {
              databaseOpens += 1;
            },
            createRuntimeFunction() {
              runtimeCompositions += 1;
            },
          }),
        { code: "DATABASE_FILE_REQUIRED" }
      );
      assert.deepEqual(
        {
          manifestLoads,
          authenticatorCreations,
          artifactStoreCreations,
          databaseOpens,
          runtimeCompositions,
        },
        {
          manifestLoads: 0,
          authenticatorCreations: 0,
          artifactStoreCreations: 0,
          databaseOpens: 0,
          runtimeCompositions: 0,
        }
      );
      assert.equal(config.sportsDataIoLiveNhl.enabled, false);
      assert.equal(config.sportsDataIoLiveNhl.verified, false);
    }
  });

  test("FAD-05 live capability startup fails closed before database access for manifest and artifact failures", () => {
    const missingDatabasePath = path.join(
      PERSISTENT_ROOT,
      "sqlite",
      "missing-required-live-capability.sqlite3"
    );
    const env = liveProviderEnvironment("required", {
      DATABASE_PATH: missingDatabasePath,
    });
    const config = loadTargetRuntimeConfig({
      env,
      backendRoot: ROOT,
    });
    const securityFoundations = createSecurityFoundations({
      env,
      loadConfig: () => config.security,
      now: () => Date.parse("2026-07-22T12:00:00.000Z"),
      loggerSink() {},
    });
    const manifest = liveCapabilityProbeManifest();
    const cases = [
      {
        label: "missing-manifest",
        readFileSync() {
          throw new Error(config.sportsDataIoLiveNhl.probeManifestPath);
        },
      },
      {
        label: "corrupt-manifest",
        readFileSync() {
          return Buffer.from("raw-provider-row-marker:not-json");
        },
      },
      {
        label: "cross-season-manifest",
        readFileSync() {
          const mismatched = liveCapabilityProbeManifest();
          mismatched.configuredNhlSeasonKey = "20252026";
          mismatched.probeNhlSeasonKey = "20242025";
          return Buffer.from(JSON.stringify(mismatched));
        },
      },
      ...["corrupt-artifact", "expired-artifact", "cross-bound-artifact"].map(
        (label) => ({
          label,
          readFileSync() {
            return Buffer.from(JSON.stringify(manifest));
          },
          artifactFailure: true,
        })
      ),
    ];

    for (const scenario of cases) {
      let artifactReads = 0;
      let databasePathChecks = 0;
      let databaseOpens = 0;
      let runtimeCompositions = 0;
      let caught;
      try {
        openDeployedTargetRuntime({
          config,
          securityFoundations,
          fsModule: {
            existsSync() {
              databasePathChecks += 1;
              return true;
            },
            readFileSync: scenario.readFileSync,
          },
          createSportsDataIoLiveCapabilityAuthenticatorFunction() {
            return Object.freeze({ marker: "authenticator" });
          },
          createSportsDataIoLiveCapabilityArtifactFunction() {
            return Object.freeze({
              readAndVerify() {
                artifactReads += 1;
                if (scenario.artifactFailure) {
                  throw new Error(
                    `${scenario.label}:${SPORTSDATAIO_LIVE_API_KEY}:` +
                    `${config.sportsDataIoLiveNhl.artifactPath}:raw-provider-row-marker`
                  );
                }
                assert.fail("artifact verification must not be reached");
              },
            });
          },
          openDatabaseFunction() {
            databaseOpens += 1;
          },
          createRuntimeFunction() {
            runtimeCompositions += 1;
          },
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(
        caught?.code,
        SPORTS_DATA_IO_LIVE_CAPABILITY_STARTUP_ERROR_CODE,
        scenario.label
      );
      assert.equal(
        artifactReads,
        scenario.artifactFailure ? 1 : 0,
        scenario.label
      );
      assert.equal(databasePathChecks, 0, scenario.label);
      assert.equal(databaseOpens, 0, scenario.label);
      assert.equal(runtimeCompositions, 0, scenario.label);
      const serialized = JSON.stringify({
        code: caught?.code,
        message: caught?.message,
      });
      for (const forbidden of [
        SPORTSDATAIO_LIVE_API_KEY,
        SPORTSDATAIO_LIVE_CAPABILITY_SECRET,
        config.sportsDataIoLiveNhl.artifactPath,
        config.sportsDataIoLiveNhl.probeManifestPath,
        "raw-provider-row-marker",
      ]) {
        assert.equal(
          serialized.includes(forbidden),
          false,
          `${scenario.label}:${forbidden}`
        );
      }
    }
  });

  test("FAD-05 live capability startup verifies exact bindings once before database open and composes one sanitized descriptor", (t) => {
    const input = requiredDeployedRuntimeInput(t);
    t.after(() =>
      fs.rmSync(input.persistentRoot, {
        recursive: true,
        force: true,
      })
    );
    const manifest = liveCapabilityProbeManifest();
    const probeManifestSha256 =
      hashSportsDataIoLiveCapabilityProbeManifest(manifest);
    const nowMs = Date.parse("2026-07-22T12:00:00.000Z");
    const verification = liveCapabilityVerificationReceipt();
    const order = [];
    let artifactReads = 0;
    let databaseOpens = 0;
    let runtimeCompositions = 0;
    let providerRequests = 0;
    let openedConnection;
    let composedLiveDescriptor;
    const authenticator = Object.freeze({ marker: "authenticator" });
    const stopAfterComposition = new Error(
      "expected stop after live descriptor composition"
    );

    assert.throws(
      () =>
        openDeployedTargetRuntime({
          ...input,
          loadSportsDataIoLiveProbeManifestFunction(options) {
            order.push("manifest");
            assert.equal(
              options.manifestPath,
              input.config.sportsDataIoLiveNhl.probeManifestPath
            );
            assert.equal(options.fsModule, fs);
            return Object.freeze({
              manifest,
              probeManifestSha256,
            });
          },
          createSportsDataIoLiveCapabilityAuthenticatorFunction(options) {
            order.push("authenticator");
            assert.deepEqual(options, {
              capabilitySecret:
                SPORTSDATAIO_LIVE_CAPABILITY_SECRET,
              dedicatedLiveApiKey:
                SPORTSDATAIO_LIVE_API_KEY,
              capabilityKeyVersion: 7,
            });
            return authenticator;
          },
          createSportsDataIoLiveCapabilityArtifactFunction(options) {
            order.push("artifact-store");
            assert.deepEqual(
              {
                persistentRoot: options.persistentRoot,
                artifactPath: options.artifactPath,
                authenticator: options.authenticator,
                fsModule: options.fsModule,
              },
              {
                persistentRoot: input.config.persistentRoot,
                artifactPath:
                  input.config.sportsDataIoLiveNhl.artifactPath,
                authenticator,
                fsModule: fs,
              }
            );
            return Object.freeze({
              readAndVerify(options_) {
                order.push("artifact-read");
                artifactReads += 1;
                assert.deepEqual(options_, {
                  expectedBindings: {
                    appEnv: "staging",
                    environmentId:
                      "hundo-staging-environment-v1",
                    backendBuildId:
                      "candidate-0123456789abcdef",
                    origin: "https://api.sportsdata.io",
                    configuredNhlSeasonKey: "20262027",
                    probeNhlSeasonKey: "20252026",
                    probeKind: "historical_offseason",
                    probeManifestSha256,
                  },
                  nowMs,
                });
                return {
                  artifactPath:
                    input.config.sportsDataIoLiveNhl.artifactPath,
                  artifact: {
                    rawPayload: "raw-provider-row-marker",
                  },
                  verification,
                };
              },
            });
          },
          openDatabaseFunction(options) {
            order.push("database-open");
            databaseOpens += 1;
            openedConnection = openDatabase(options);
            return openedConnection;
          },
          createRuntimeFunction(options) {
            order.push("runtime-composition");
            runtimeCompositions += 1;
            assert.equal(
              options.freeAgentDraftRoutesEnabled,
              false
            );
            composedLiveDescriptor =
              options.sportsDataIoLiveNhl;
            throw stopAfterComposition;
          },
          sportsDataIoFetchImplementation() {
            providerRequests += 1;
          },
        }),
      (error) => error === stopAfterComposition
    );

    assert.deepEqual(order, [
      "manifest",
      "authenticator",
      "artifact-store",
      "artifact-read",
      "database-open",
      "runtime-composition",
    ]);
    assert.equal(artifactReads, 1);
    assert.equal(databaseOpens, 1);
    assert.equal(runtimeCompositions, 1);
    assert.equal(providerRequests, 0);
    assert.equal(openedConnection.database.open, false);
    assert.equal(Object.isFrozen(composedLiveDescriptor), true);
    assert.equal(
      Object.isFrozen(composedLiveDescriptor.verification),
      true
    );
    assert.deepEqual(composedLiveDescriptor, {
      mode: "required",
      enabled: true,
      verified: true,
      origin: "https://api.sportsdata.io",
      nhlSeasonKey: "20262027",
      capabilityKeyVersion: 7,
      probeNhlSeasonKey: "20252026",
      probeKind: "historical_offseason",
      probeManifestSha256,
      verification,
    });
    assert.equal(
      composedLiveDescriptor.apiKey,
      SPORTSDATAIO_LIVE_API_KEY
    );
    assert.equal(
      Object.keys(composedLiveDescriptor).includes("apiKey"),
      false
    );
    const serialized = JSON.stringify(composedLiveDescriptor);
    for (const forbidden of [
      SPORTSDATAIO_LIVE_API_KEY,
      SPORTSDATAIO_LIVE_CAPABILITY_SECRET,
      input.config.sportsDataIoLiveNhl.artifactPath,
      input.config.sportsDataIoLiveNhl.probeManifestPath,
      "raw-provider-row-marker",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
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
    for (const invalidValue of [undefined, "false", true]) {
      assert.throws(
        () => openDeployedTargetRuntime({
          ...input,
          config: Object.freeze({
            ...input.config,
            freeAgentDraftRoutesEnabled: invalidValue,
          }),
        }),
        /validated deployment configuration/
      );
    }
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

  test("keeps deployed dedicated FAD reads, writes, and preflights unexposed while shared auctions remain routed", async (t) => {
    const input = deployedRuntimeInput(t);
    const runtime = openDeployedTargetRuntime(input);
    t.after(() => runtime.close());
    t.after(() =>
      fs.rmSync(input.persistentRoot, { recursive: true, force: true })
    );
    const baseUrl = await startApplication(t, runtime);
    const leagueId = uuid(7001);
    const before = runtime.database.serialize();
    const fadRequests = [
      {
        method: "GET",
        path: `/api/v1/leagues/${leagueId}/free-agent-drafts/navigation`,
      },
      {
        method: "POST",
        path: `/api/v1/leagues/${leagueId}/free-agent-drafts/readiness/retries`,
      },
    ];
    for (const request of fadRequests) {
      const url = new URL(request.path, baseUrl);
      const response = await fetch(url, {
        method: request.method,
        headers: {
          Origin: "https://staging.hundoleago.com",
          ...(request.method === "POST"
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(request.method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(response.status, 404);
      assert.equal((await response.text()).includes("routerKey"), false);
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: "https://staging.hundoleago.com",
          "Access-Control-Request-Method": request.method,
        },
      });
      assert.equal(preflight.status, 404);
      assert.equal(
        preflight.headers.has("access-control-allow-origin"),
        false
      );
    }

    const auctionsUrl = new URL(
      `/api/v1/leagues/${leagueId}/auctions`,
      baseUrl
    );
    const auctionRead = await fetch(auctionsUrl, {
      headers: { Origin: "https://staging.hundoleago.com" },
    });
    assert.equal(auctionRead.status, 401);
    const auctionPreflight = await fetch(auctionsUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://staging.hundoleago.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(auctionPreflight.status, 204);
    assert.equal(
      auctionPreflight.headers.get("access-control-allow-origin"),
      "https://staging.hundoleago.com"
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
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
        "entry_draft_rollover",
        "free_agent_draft_readiness",
        "free_agent_draft_eligibility_revalidation",
        "free_agent_draft_deadline_reminder",
        "free_agent_draft_deadline",
        "free_agent_draft_allocation_cycle",
        "free_agent_draft_auction_resolution",
        "free_agent_draft_restricted_activation",
        "free_agent_draft_fallback_activation",
        "free_agent_draft_queued_nomination_activation",
        "free_agent_draft_rollover_finalization",
        "auction_resolution",
        "free_agent_draft_completion",
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
    assert.equal(
      runtime.services.league.scheduledJobs.some(
        ({ name, runner }) =>
          name ===
            "free_agent_draft_rollover_finalization" &&
          runner ===
            runtime.services.league.freeAgentDraftRolloverJob
      ),
      true
    );
    const started = runtime.scheduler.start();
    assert.equal(started.status, "email_only");
    if (started.emailInitialRun) await started.emailInitialRun;
    assert.equal(runtime.scheduler.getState(), "disabled");
    assert.deepEqual(
      await runtime.scheduler.runCycle(),
      { status: "skipped", reason: "not_running" }
    );
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
      49
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
        "freeAgentDraftRoutes",
        "lastValidStatisticsRefresh",
        "lastVerifiedBackup",
        "lifecycle",
        "maintenance",
        "migrationChecksumSetId",
        "outbox",
        "scheduler",
        "schemaVersion",
        "sportsDataIoLiveNhl",
        "sportsDataIoNhl",
      ].sort()
    );
    assert.equal(body.data.environment, "staging");
    assert.equal(body.data.schemaVersion, 49);
    assert.equal(body.data.scheduler.state, "disabled");
    assert.deepEqual(body.data.accountEmailDelivery, { enabled: false });
    assert.deepEqual(body.data.freeAgentDraftRoutes, { enabled: false });
    assert.deepEqual(body.data.maintenance, { state: "closed" });
    assert.deepEqual(body.data.sportsDataIoNhl, {
      provider: "sportsdataio-discovery-lab",
      enabled: false,
      dataScope: "last-season-only",
      staleAfterMs: 259200000,
      lastSuccessfulImport: null,
      stale: true,
    });
    assert.deepEqual(body.data.sportsDataIoLiveNhl, {
      provider: "sportsdataio-live",
      mode: "disabled",
      enabled: false,
      verified: false,
      verification: null,
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
      path.basename(
        input.config.sportsDataIoLiveNhl.probeManifestPath
      ),
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(runtime.database.serialize(), before);
  });

  test("projects only sanitized verified live capability state into operations health", async (t) => {
    const input = requiredDeployedRuntimeInput(t, {
      FREE_AGENT_DRAFT_ROUTES_ENABLED: "true",
    });
    const manifest = liveCapabilityProbeManifest();
    const probeManifestSha256 =
      hashSportsDataIoLiveCapabilityProbeManifest(manifest);
    const verification = liveCapabilityVerificationReceipt();
    const runtime = openDeployedTargetRuntime({
      ...input,
      loadSportsDataIoLiveProbeManifestFunction() {
        return Object.freeze({
          manifest,
          probeManifestSha256,
        });
      },
      createSportsDataIoLiveCapabilityAuthenticatorFunction() {
        return Object.freeze({ marker: "authenticator" });
      },
      createSportsDataIoLiveCapabilityArtifactFunction() {
        return Object.freeze({
          readAndVerify() {
            return Object.freeze({
              artifactPath:
                input.config.sportsDataIoLiveNhl.artifactPath,
              artifact: Object.freeze({
                rawPayload: "raw-live-provider-payload-marker",
              }),
              verification,
            });
          },
        });
      },
    });
    t.after(() => {
      if (runtime.database.open) runtime.close();
      fs.rmSync(input.persistentRoot, {
        recursive: true,
        force: true,
      });
    });

    runtime.health.markReady();
    const health = runtime.health.readOperations();
    assert.deepEqual(health.freeAgentDraftRoutes, { enabled: true });
    assert.equal(Object.isFrozen(health.freeAgentDraftRoutes), true);
    assert.equal(Object.isFrozen(health.sportsDataIoLiveNhl), true);
    assert.equal(
      Object.isFrozen(health.sportsDataIoLiveNhl.verification),
      true
    );
    assert.deepEqual(
      Object.keys(health.sportsDataIoLiveNhl).sort(),
      ["enabled", "mode", "provider", "verification", "verified"]
    );
    assert.deepEqual(health.sportsDataIoLiveNhl, {
      provider: "sportsdataio-live",
      mode: "required",
      enabled: true,
      verified: true,
      verification,
    });
    const baseUrl = await startApplication(t, runtime);
    const navigationUrl = new URL(
      `/api/v1/leagues/${uuid(8998)}/free-agent-drafts/navigation`,
      baseUrl
    );
    const navigation = await fetch(navigationUrl, {
      headers: { Origin: "https://staging.hundoleago.com" },
    });
    assert.equal(navigation.status, 401);
    const preflight = await fetch(navigationUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://staging.hundoleago.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://staging.hundoleago.com"
    );
    assert.deepEqual(
      Object.keys(health.sportsDataIoLiveNhl.verification).sort(),
      [
        "evidenceId",
        "evidenceSha256",
        "expiresAtMs",
        "issuedAtMs",
        "status",
        "verifiedAtMs",
      ]
    );
    const serialized = JSON.stringify(health);
    for (const forbidden of [
      SPORTSDATAIO_LIVE_API_KEY,
      SPORTSDATAIO_LIVE_CAPABILITY_SECRET,
      path.basename(input.config.sportsDataIoLiveNhl.artifactPath),
      path.basename(input.config.sportsDataIoLiveNhl.probeManifestPath),
      "raw-live-provider-payload-marker",
      "capabilitySecret",
      "apiKey",
      "artifactPath",
      "probeManifestPath",
      "probeManifestSha256",
      "rawPayload",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  test("composes maintenance routes only for their exact closed staging-fixture conditions", async (t) => {
    const exactInput = await deployedFixtureRuntimeInput({
      SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
      SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
    });
    const nonFixtureInput = deployedRuntimeInput(t);
    nonFixtureInput.config = Object.freeze({
      ...nonFixtureInput.config,
      sportsDataIoNhl: exactInput.config.sportsDataIoNhl,
    });
    t.after(() => {
      fs.rmSync(exactInput.persistentRoot, {
        recursive: true,
        force: true,
      });
      fs.rmSync(nonFixtureInput.persistentRoot, {
        recursive: true,
        force: true,
      });
    });

    const scenarios = [
      {
        label: "exact closed staging fixture with provider enabled",
        input: exactInput,
        config: exactInput.config,
        resetMounted: true,
        importMounted: true,
      },
      {
        label: "provider disabled",
        input: exactInput,
        config: Object.freeze({
          ...exactInput.config,
          sportsDataIoNhl: Object.freeze({ enabled: false }),
        }),
        resetMounted: true,
        importMounted: false,
      },
      {
        label: "league writes open",
        input: exactInput,
        config: Object.freeze({
          ...exactInput.config,
          leagueWriteMode: "open",
        }),
        resetMounted: false,
        importMounted: false,
      },
      {
        label: "scheduled jobs enabled",
        input: exactInput,
        config: Object.freeze({
          ...exactInput.config,
          scheduledJobsEnabled: true,
        }),
        resetMounted: false,
        importMounted: false,
      },
      {
        label: "non-staging application environment",
        input: exactInput,
        config: Object.freeze({
          ...exactInput.config,
          appEnv: "production",
        }),
        resetMounted: false,
        importMounted: false,
      },
      {
        label: "non-fixture database identity",
        input: nonFixtureInput,
        config: nonFixtureInput.config,
        resetMounted: false,
        importMounted: false,
      },
    ];

    for (const scenario of scenarios) {
      await t.test(scenario.label, async (child) => {
        let providerCalls = 0;
        const runtime = openDeployedTargetRuntime({
          ...scenario.input,
          config: scenario.config,
          async sportsDataIoFetchImplementation() {
            providerCalls += 1;
            throw new Error("maintenance route mount check reached provider");
          },
        });
        child.after(() => runtime.close());
        const baseUrl = await startApplication(child, runtime);
        const before = runtime.database.serialize();

        for (const [routePath, mounted] of [
          [STAGING_FIXTURE_RESET_ROUTE_PATH, scenario.resetMounted],
          [
            STAGING_SPORTSDATAIO_IMPORT_ROUTE_PATH,
            scenario.importMounted,
          ],
        ]) {
          const response = await fetch(new URL(routePath, baseUrl), {
            method: "POST",
            headers: {
              Origin: "https://staging.hundoleago.com",
              "Content-Type": "application/json",
            },
            body: "{}",
          });
          const body = await response.text();
          assert.equal(
            response.status,
            mounted ? 401 : 404,
            `${scenario.label}: ${routePath}: ${body}`
          );
          assert.equal(
            response.headers.get("content-type")?.startsWith(
              mounted ? "application/json" : "text/html"
            ),
            true,
            `${scenario.label}: ${routePath}: ${body}`
          );
        }

        assert.equal(providerCalls, 0);
        assert.equal(
          before.equals(runtime.database.serialize()),
          true
        );
      });
    }
  });

  test("rejects live and correction-required matchup state through both composed maintenance routes without persistence", async (t) => {
    const providerCalls = [];
    const input = await deployedFixtureRuntimeInput({
      SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
      SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
    });
    const runtime = openDeployedTargetRuntime({
      ...input,
      async sportsDataIoFetchImplementation(url) {
        providerCalls.push(url);
        throw new Error("blocked maintenance route reached provider");
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
    const administratorId = fixtureId("account:platformAdmin");
    const session = runtime.services.sessionService.issueForUser({
      userId: administratorId,
    });
    const matchup = runtime.database
      .prepare("SELECT id, status FROM matchups ORDER BY id LIMIT 1")
      .get();

    for (const status of ["live", "correction_required"]) {
      runtime.database
        .prepare("UPDATE matchups SET status = ? WHERE id = ?")
        .run(status, matchup.id);
      const before = runtime.database.serialize();

      for (const request of [
        {
          routePath: STAGING_FIXTURE_RESET_ROUTE_PATH,
          idempotencyKey: `deployed-reset-blocked-${status}`,
          input: {
            confirmation: "RESET STAGING TEST LEAGUES",
            reason: `Reject fixture reset while matchup is ${status}.`,
          },
          expectedCode: "STAGING_FIXTURE_RESET_FAILED",
        },
        {
          routePath: STAGING_SPORTSDATAIO_IMPORT_ROUTE_PATH,
          idempotencyKey: `deployed-import-blocked-${status}`,
          input: {
            confirmation: "IMPORT SPORTSDATAIO STAGING DATA",
            reason: `Reject provider import while matchup is ${status}.`,
          },
          expectedCode: "STAGING_SPORTSDATAIO_IMPORT_FAILED",
        },
      ]) {
        const response = await fetch(
          new URL(request.routePath, baseUrl),
          {
            method: "POST",
            headers: {
              Origin: "https://staging.hundoleago.com",
              "Content-Type": "application/json",
              Cookie:
                `${runtime.transport.sessionCookie.name}=` +
                session.rawSessionToken,
              "Idempotency-Key": request.idempotencyKey,
              "X-CSRF-Token": session.rawCsrfToken,
              "Sec-Fetch-Site": "cross-site",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Dest": "empty",
            },
            body: JSON.stringify(request.input),
          }
        );
        const body = await response.json();
        assert.equal(response.status, 500);
        assert.equal(body.error.code, request.expectedCode);
        assert.equal(
          JSON.stringify(body).includes(
            "STAGING_MAINTENANCE_EXCLUSION_MATCHUP_ACTIVE"
          ),
          false
        );
      }

      assert.equal(providerCalls.length, 0);
      assert.equal(
        before.equals(runtime.database.serialize()),
        true
      );
      runtime.database
        .prepare("UPDATE matchups SET status = ? WHERE id = ?")
        .run(matchup.status, matchup.id);
    }
  });

  test("does not compose staging maintenance routes when any deployment prerequisite is absent", async (t) => {
    const scenarios = [
      {
        label: "production",
        input: await deployedFixtureRuntimeInput({
          APP_ENV: "production",
          PUBLIC_FRONTEND_ORIGIN: "https://hundoleago.com",
          FRONTEND_ORIGINS: "https://hundoleago.com",
          EMAIL_DELIVERY_MODE: "send",
          EMAIL_FROM: "Hundo Leago <accounts@hundoleago.com>",
          EMAIL_REPLY_TO: "support@hundoleago.com",
          RESEND_API_KEY:
            "re_target_runtime_fake_provider_key_0123456789",
        }),
      },
      {
        label: "wrong fixture identity",
        input: deployedRuntimeInput(t),
      },
      {
        label: "league writes open",
        input: await deployedFixtureRuntimeInput({
          LEAGUE_WRITE_MODE: "open",
          SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
          SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
        }),
      },
      {
        label: "scheduled jobs enabled",
        input: await deployedFixtureRuntimeInput({
          SCHEDULED_JOBS_ENABLED: "true",
          SPORTSDATAIO_NHL_API_KEY: "test-staging-provider-key",
          SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
        }),
      },
    ];
    const routePaths = [
      "/api/v1/operations/staging-fixture-reset",
      "/api/v1/operations/staging-sportsdataio-import",
    ];

    for (const scenario of scenarios) {
      const runtime = openDeployedTargetRuntime(scenario.input);
      t.after(() => {
        if (runtime.database.open) runtime.close();
        fs.rmSync(scenario.input.persistentRoot, {
          recursive: true,
          force: true,
        });
      });
      const baseUrl = await startApplication(t, runtime);

      for (const routePath of routePaths) {
        const response = await fetch(new URL(routePath, baseUrl), {
          method: "POST",
          headers: {
            Origin:
              scenario.input.config.security.publicFrontendOrigin,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
          },
          body: "{}",
        });
        assert.equal(response.status, 404, `${scenario.label}: ${routePath}`);
      }
    }
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
    const providerIdentityCountBefore = runtime.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM player_external_ids
        WHERE provider = 'sportsdataio-discovery-lab'
      `)
      .get().count;
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
      providerIdentityCountBefore + 800
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
