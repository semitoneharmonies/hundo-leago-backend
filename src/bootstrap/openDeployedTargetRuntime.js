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

function assertConfig(config, securityFoundations) {
  if (
    !config ||
    !["staging", "production"].includes(config.appEnv) ||
    typeof config.databasePath !== "string" ||
    typeof config.persistentRoot !== "string" ||
    typeof config.migrationsDirectory !== "string" ||
    typeof config.environmentId !== "string" ||
    typeof config.databaseId !== "string" ||
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
    const databaseIdentity = assertDatabaseIdentity(connection.database, config);
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
      sportsDataIoFetchImplementation,
      leagueInvalidationPublisher,
      leagueWriteMode: config.leagueWriteMode,
    });
    const health = createRuntimeHealthService({
      database: connection.database,
      migrationState,
      databaseIdentity,
      runtimeConfig: config,
    });
    const scheduler = createTargetScheduler({
      enabled: config.scheduledJobsEnabled,
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
      config.databaseId === FIXTURE_DATABASE_ID
    ) {
      const stagingFixtureResetService =
        createStagingFixtureResetService({
          database: connection.database,
          databasePath: connection.databasePath,
          persistentRoot: config.persistentRoot,
          appEnv: config.appEnv,
          environmentId: config.environmentId,
          databaseId: config.databaseId,
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
              }),
            provider: providerAdapter,
            statisticsService: providerStatistics,
            seasonStart:
              config.sportsDataIoNhl.seasonStartYear,
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
      runtimeConfig: config,
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
  assertDatabaseIdentity,
  openDeployedTargetRuntime,
  readDatabaseIdentity,
};
