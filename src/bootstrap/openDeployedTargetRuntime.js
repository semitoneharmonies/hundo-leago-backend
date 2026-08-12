const fs = require("node:fs");

const {
  createTargetRuntime,
} = require("./createTargetRuntime");
const {
  openDatabase,
} = require("../infrastructure/database/connection");
const {
  assertMigrationCompatibility,
  discoverMigrations,
} = require("../infrastructure/database/migrate");
const {
  DATABASE_IDENTITY_KEYS,
  assertDatabaseIdentity,
  readDatabaseIdentity,
} = require("../infrastructure/database/databaseIdentity");
const {
  createRuntimeHealthService,
} = require("../application/services/operations/createRuntimeHealthService");
const {
  createTargetScheduler,
} = require("../application/services/operations/createTargetScheduler");
const {
  createOperationsHealthRouter,
} = require("../transport/http/createOperationsHealthRouter");
const {
  createPublicHealthRouter,
} = require("../transport/http/createPublicHealthRouter");
const {
  createStagingFixtureResetService,
} = require("../application/services/operations/createStagingFixtureResetService");
const {
  createStagingSportsDataIoImportService,
} = require("../application/services/operations/createStagingSportsDataIoImportService");
const {
  createStagingMaintenanceExclusionGuard,
} = require("../application/services/operations/createStagingMaintenanceExclusionGuard");
const {
  createSportsDataIoCatalogImportService,
} = require("../application/services/players/createSportsDataIoCatalogImportService");
const {
  createTargetStatisticsService,
} = require("../application/services/statistics/createTargetStatisticsService");
const {
  createStagingFixtureResetRouter,
} = require("../transport/http/createStagingFixtureResetRouter");
const {
  createStagingSportsDataIoImportRouter,
} = require("../transport/http/createStagingSportsDataIoImportRouter");
const {
  MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
  PROVIDER_NAME,
  createSportsDataIoLastSeasonStatisticsProvider,
  createSportsDataIoNhlAdapter,
} = require("../infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const {
  createSqlitePlayerCatalogRepository,
} = require("../infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require("../operations/release/releaseQaFixtureContract");
const {
  hashSportsDataIoLiveCapabilityProbeManifest,
  normalizeSportsDataIoLiveCapabilityProbeManifest,
} = require(
  "../operations/statistics/createSportsDataIoLiveCapabilityCheck"
);
const {
  createSportsDataIoLiveCapabilityAuthenticator,
} = require(
  "../infrastructure/security/createSportsDataIoLiveCapabilityAuthenticator"
);
const {
  createSportsDataIoLiveCapabilityArtifact,
} = require(
  "../infrastructure/statistics/SportsDataIoLiveCapabilityArtifact"
);

const SPORTS_DATA_IO_LIVE_CAPABILITY_STARTUP_ERROR_CODE =
  "SPORTSDATAIO_LIVE_CAPABILITY_STARTUP_VERIFICATION_FAILED";
const SPORTS_DATA_IO_LIVE_CAPABILITY_MANIFEST_MAX_BYTES =
  512 * 1024;
const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

class DeployedTargetRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "DeployedTargetRuntimeError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new DeployedTargetRuntimeError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function failLiveCapabilityStartup() {
  throw new DeployedTargetRuntimeError(
    SPORTS_DATA_IO_LIVE_CAPABILITY_STARTUP_ERROR_CODE,
    "Required SportsDataIO live capability verification failed safely."
  );
}

function loadSportsDataIoLiveProbeManifest({
  manifestPath,
  fsModule = fs,
  normalizeManifest =
    normalizeSportsDataIoLiveCapabilityProbeManifest,
  hashManifest =
    hashSportsDataIoLiveCapabilityProbeManifest,
} = {}) {
  let raw;
  try {
    if (
      typeof manifestPath !== "string" ||
      !fsModule ||
      typeof fsModule.readFileSync !== "function" ||
      typeof normalizeManifest !== "function" ||
      typeof hashManifest !== "function"
    ) {
      failLiveCapabilityStartup();
    }
    raw = fsModule.readFileSync(manifestPath);
    if (
      !Buffer.isBuffer(raw) ||
      raw.length < 1 ||
      raw.length >
        SPORTS_DATA_IO_LIVE_CAPABILITY_MANIFEST_MAX_BYTES
    ) {
      failLiveCapabilityStartup();
    }
    const manifest = normalizeManifest(
      JSON.parse(raw.toString("utf8"))
    );
    const probeManifestSha256 = hashManifest(manifest);
    if (!SHA256_PATTERN.test(probeManifestSha256)) {
      failLiveCapabilityStartup();
    }
    return Object.freeze({
      manifest,
      probeManifestSha256,
    });
  } catch {
    failLiveCapabilityStartup();
  } finally {
    if (Buffer.isBuffer(raw)) raw.fill(0);
  }
}

function sanitizeLiveCapabilityVerification(value) {
  const verification = value?.verification;
  if (
    !verification ||
    verification.status !== "verified" ||
    !UUID_V4_PATTERN.test(verification.evidenceId) ||
    !SHA256_PATTERN.test(verification.evidenceSha256) ||
    !Number.isSafeInteger(verification.issuedAtMs) ||
    verification.issuedAtMs < 0 ||
    !Number.isSafeInteger(verification.expiresAtMs) ||
    verification.expiresAtMs <= verification.issuedAtMs ||
    !Number.isSafeInteger(verification.verifiedAtMs) ||
    verification.verifiedAtMs < verification.issuedAtMs ||
    verification.verifiedAtMs >= verification.expiresAtMs
  ) {
    failLiveCapabilityStartup();
  }
  return Object.freeze({
    status: "verified",
    evidenceId: verification.evidenceId,
    evidenceSha256: verification.evidenceSha256,
    issuedAtMs: verification.issuedAtMs,
    expiresAtMs: verification.expiresAtMs,
    verifiedAtMs: verification.verifiedAtMs,
  });
}

function verifyRequiredSportsDataIoLiveCapability({
  config,
  securityFoundations,
  fsModule = fs,
  loadProbeManifest =
    loadSportsDataIoLiveProbeManifest,
  createAuthenticator =
    createSportsDataIoLiveCapabilityAuthenticator,
  createArtifactStore =
    createSportsDataIoLiveCapabilityArtifact,
} = {}) {
  const live = config?.sportsDataIoLiveNhl;
  if (live?.mode !== "required") return live;

  try {
    if (
      live.enabled !== false ||
      live.verified !== false ||
      typeof live.origin !== "string" ||
      typeof live.nhlSeasonKey !== "string" ||
      typeof live.artifactPath !== "string" ||
      typeof live.probeManifestPath !== "string" ||
      !Number.isSafeInteger(live.capabilityKeyVersion) ||
      live.capabilityKeyVersion < 1 ||
      typeof loadProbeManifest !== "function" ||
      typeof createAuthenticator !== "function" ||
      typeof createArtifactStore !== "function"
    ) {
      failLiveCapabilityStartup();
    }
    const apiKey =
      config.security?.sportsDataIoLive?.apiKey?.value;
    const capabilitySecret =
      config.security?.sportsDataIoLive
        ?.capabilitySecret?.value;
    if (
      typeof apiKey !== "string" ||
      apiKey === "" ||
      typeof capabilitySecret !== "string" ||
      capabilitySecret === ""
    ) {
      failLiveCapabilityStartup();
    }

    const loaded = loadProbeManifest({
      manifestPath: live.probeManifestPath,
      fsModule,
    });
    if (
      !loaded?.manifest ||
      !SHA256_PATTERN.test(loaded.probeManifestSha256) ||
      loaded.manifest.configuredNhlSeasonKey !==
        config.currentSeason?.nhlSeasonKey
    ) {
      failLiveCapabilityStartup();
    }
    const authenticator = createAuthenticator({
      capabilitySecret,
      dedicatedLiveApiKey: apiKey,
      capabilityKeyVersion: live.capabilityKeyVersion,
    });
    const artifactStore = createArtifactStore({
      persistentRoot: config.persistentRoot,
      artifactPath: live.artifactPath,
      authenticator,
      fsModule,
    });
    if (!artifactStore || typeof artifactStore.readAndVerify !== "function") {
      failLiveCapabilityStartup();
    }
    const expectedBindings = Object.freeze({
      appEnv: config.appEnv,
      environmentId: config.environmentId,
      backendBuildId: config.buildId,
      origin: live.origin,
      configuredNhlSeasonKey:
        config.currentSeason.nhlSeasonKey,
      probeNhlSeasonKey: loaded.manifest.probeNhlSeasonKey,
      probeKind: loaded.manifest.probeKind,
      probeManifestSha256: loaded.probeManifestSha256,
    });
    const verification = sanitizeLiveCapabilityVerification(
      artifactStore.readAndVerify({
        expectedBindings,
        nowMs: securityFoundations.clock.nowMs(),
      })
    );
    const descriptor = {
      mode: "required",
      enabled: true,
      verified: true,
      origin: live.origin,
      nhlSeasonKey: live.nhlSeasonKey,
      capabilityKeyVersion: live.capabilityKeyVersion,
      probeNhlSeasonKey: loaded.manifest.probeNhlSeasonKey,
      probeKind: loaded.manifest.probeKind,
      probeManifestSha256: loaded.probeManifestSha256,
      verification,
    };
    Object.defineProperty(descriptor, "apiKey", {
      configurable: false,
      enumerable: false,
      value: apiKey,
      writable: false,
    });
    return Object.freeze(descriptor);
  } catch {
    failLiveCapabilityStartup();
  }
}

function assertConfig(config, securityFoundations) {
  if (
    !config ||
    !["staging", "production"].includes(config.appEnv) ||
    typeof config.databasePath !== "string" ||
    typeof config.persistentRoot !== "string" ||
    typeof config.migrationsDirectory !== "string" ||
    typeof config.environmentId !== "string" ||
    typeof config.databaseId !== "string" ||
    typeof config.freeAgentDraftRoutesEnabled !== "boolean" ||
    !config.currentSeason
  ) {
    throw new TypeError(
      "deployed target runtime requires validated deployment configuration"
    );
  }
  if (
    !securityFoundations ||
    securityFoundations.config !== config.security
  ) {
    throw new TypeError(
      "deployed target runtime requires matching security foundations"
    );
  }
}

function openDeployedTargetRuntime({
  config,
  securityFoundations,
  networkSourceResolver = (request) => request.ip,
  emailAdapter,
  emailFetchImplementation,
  emailJobOptions,
  sportsDataIoFetchImplementation,
  leagueInvalidationPublisher,
  fsModule = fs,
  openDatabaseFunction = openDatabase,
  createRuntimeFunction = createTargetRuntime,
  loadSportsDataIoLiveProbeManifestFunction =
    loadSportsDataIoLiveProbeManifest,
  createSportsDataIoLiveCapabilityAuthenticatorFunction =
    createSportsDataIoLiveCapabilityAuthenticator,
  createSportsDataIoLiveCapabilityArtifactFunction =
    createSportsDataIoLiveCapabilityArtifact,
} = {}) {
  assertConfig(config, securityFoundations);
  if (
    !fsModule ||
    typeof fsModule.existsSync !== "function" ||
    typeof openDatabaseFunction !== "function" ||
    typeof createRuntimeFunction !== "function"
  ) {
    throw new TypeError(
      "deployed target runtime requires filesystem, database, and runtime adapters"
    );
  }
  const sportsDataIoLiveNhl =
    verifyRequiredSportsDataIoLiveCapability({
      config,
      securityFoundations,
      fsModule,
      loadProbeManifest:
        loadSportsDataIoLiveProbeManifestFunction,
      createAuthenticator:
        createSportsDataIoLiveCapabilityAuthenticatorFunction,
      createArtifactStore:
        createSportsDataIoLiveCapabilityArtifactFunction,
    });
  const runtimeConfig =
    sportsDataIoLiveNhl === config.sportsDataIoLiveNhl
      ? config
      : Object.freeze({
          ...config,
          sportsDataIoLiveNhl,
        });
  if (!fsModule.existsSync(config.databasePath)) {
    fail(
      "DATABASE_FILE_REQUIRED",
      "The deployed target database must exist before startup."
    );
  }

  const connection = openDatabaseFunction({
    databasePath: config.databasePath,
    environment: config.appEnv,
    persistentRoot: config.persistentRoot,
    requirePersistentRoot: true,
  });
  try {
    const migrations = discoverMigrations({
      migrationsDirectory: config.migrationsDirectory,
    });
    const migrationState = assertMigrationCompatibility(
      connection.database,
      migrations
    );
    const databaseIdentity = assertDatabaseIdentity(
      connection.database,
      runtimeConfig
    );
    const stagingAccountAutoVerificationEnabled =
      config.appEnv === "staging" &&
      config.environmentId === FIXTURE_ENVIRONMENT_ID &&
      config.databaseId === FIXTURE_DATABASE_ID &&
      config.leagueWriteMode === "closed" &&
      config.scheduledJobsEnabled === false &&
      config.accountEmailDeliveryEnabled === false &&
      config.security.email.deliveryMode === "capture";
    const runtime = createRuntimeFunction({
      database: connection.database,
      migrationsDirectory: config.migrationsDirectory,
      securityFoundations,
      currentSeason: config.currentSeason,
      networkSourceResolver,
      emailAdapter,
      emailFetchImplementation,
      emailJobOptions,
      sportsDataIoNhl: config.sportsDataIoNhl,
      sportsDataIoLiveNhl,
      sportsDataIoFetchImplementation,
      leagueInvalidationPublisher,
      leagueWriteMode: config.leagueWriteMode,
      freeAgentDraftRoutesEnabled:
        config.freeAgentDraftRoutesEnabled,
      stagingAccountAutoVerificationEnabled,
    });
    const health = createRuntimeHealthService({
      database: connection.database,
      migrationState,
      databaseIdentity,
      runtimeConfig,
    });
    const scheduler = createTargetScheduler({
      enabled: config.scheduledJobsEnabled,
      emailEnabled: config.accountEmailDeliveryEnabled,
      leagueWriteMode: config.leagueWriteMode,
      jobs: runtime.services.league.scheduledJobs,
      emailJob: runtime.services.accountEmail.job,
      health,
      logger: securityFoundations.logger,
    });
    runtime.app.use(createPublicHealthRouter({ healthService: health }));
    runtime.app.use(
      createOperationsHealthRouter({
        requestSecurity: runtime.transport.requestSecurity,
        platformAuthorization: runtime.services.authorizations.platform,
        healthService: health,
      })
    );
    if (
      config.appEnv === "staging" &&
      config.environmentId === FIXTURE_ENVIRONMENT_ID &&
      config.databaseId === FIXTURE_DATABASE_ID &&
      config.leagueWriteMode === "closed" &&
      config.scheduledJobsEnabled === false
    ) {
      const maintenanceExclusionGuard =
        createStagingMaintenanceExclusionGuard({
          database: connection.database,
          appEnv: config.appEnv,
          environmentId: config.environmentId,
          databaseId: config.databaseId,
          leagueWriteMode: config.leagueWriteMode,
          scheduledJobsEnabled: config.scheduledJobsEnabled,
        });
      const stagingFixtureResetService =
        createStagingFixtureResetService({
          database: connection.database,
          databasePath: connection.databasePath,
          persistentRoot: config.persistentRoot,
          appEnv: config.appEnv,
          environmentId: config.environmentId,
          databaseId: config.databaseId,
          maintenanceExclusionGuard,
          platformAuthorization:
            runtime.services.authorizations.platform,
          clock: securityFoundations.clock,
          createId: () => securityFoundations.secureRandom.id(),
        });
      runtime.app.use(
        createStagingFixtureResetRouter({
          requestSecurity: runtime.transport.requestSecurity,
          stagingFixtureResetService,
        })
      );
      if (
        config.sportsDataIoNhl.enabled === true &&
        config.leagueWriteMode === "closed" &&
        config.scheduledJobsEnabled === false
      ) {
        const providerAdapter = createSportsDataIoNhlAdapter({
          apiKey: config.sportsDataIoNhl.apiKey,
          fetchImpl: sportsDataIoFetchImplementation,
          origin: config.sportsDataIoNhl.origin,
          nowMs: () => securityFoundations.clock.nowMs(),
        });
        const providerStatistics =
          createTargetStatisticsService({
            repository: runtime.repositories.statistics,
            provider:
              createSportsDataIoLastSeasonStatisticsProvider({
                adapter: providerAdapter,
                seasonStart:
                  config.sportsDataIoNhl.seasonStartYear,
              }),
            nhlSeasonKey:
              config.sportsDataIoNhl.nhlSeasonKey,
            providerName: PROVIDER_NAME,
            minimumPlayerCount:
              MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
            nowMs: () => securityFoundations.clock.nowMs(),
            createId: () =>
              securityFoundations.secureRandom.id(),
          });
        const catalogImport =
          createSportsDataIoCatalogImportService({
            catalogRepository:
              createSqlitePlayerCatalogRepository({
                database: connection.database,
                createId: () =>
                  securityFoundations.secureRandom.id(),
                now: () =>
                  securityFoundations.clock.nowMs(),
              }),
            provider: providerAdapter,
            statisticsService: providerStatistics,
            seasonStart:
              config.sportsDataIoNhl.seasonStartYear,
            createId: () =>
              securityFoundations.secureRandom.id(),
          });
        const stagingSportsDataIoImportService =
          createStagingSportsDataIoImportService({
            database: connection.database,
            appEnv: config.appEnv,
            environmentId: config.environmentId,
            databaseId: config.databaseId,
            leagueWriteMode: config.leagueWriteMode,
            scheduledJobsEnabled:
              config.scheduledJobsEnabled,
            providerEnabled:
              config.sportsDataIoNhl.enabled,
            maintenanceExclusionGuard,
            platformAuthorization:
              runtime.services.authorizations.platform,
            importService: catalogImport,
            clock: securityFoundations.clock,
            createId: () =>
              securityFoundations.secureRandom.id(),
          });
        runtime.app.use(
          createStagingSportsDataIoImportRouter({
            requestSecurity:
              runtime.transport.requestSecurity,
            stagingSportsDataIoImportService,
          })
        );
      }
    }

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      health.markStopping();
      if (typeof runtime.close === "function") runtime.close();
      if (connection.database.open) connection.database.close();
      health.markClosed();
    }

    return Object.freeze({
      ...runtime,
      close,
      database: connection.database,
      databaseIdentity,
      databasePath: connection.databasePath,
      health,
      migrationState,
      runtimeConfig,
      scheduler,
    });
  } catch (error) {
    if (connection.database?.open) connection.database.close();
    throw error;
  }
}

module.exports = {
  DATABASE_IDENTITY_KEYS,
  DeployedTargetRuntimeError,
  SPORTS_DATA_IO_LIVE_CAPABILITY_STARTUP_ERROR_CODE,
  assertDatabaseIdentity,
  loadSportsDataIoLiveProbeManifest,
  openDeployedTargetRuntime,
  readDatabaseIdentity,
  verifyRequiredSportsDataIoLiveCapability,
};
