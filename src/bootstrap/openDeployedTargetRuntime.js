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
  nhlFetchImplementation,
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
      nhlApiOrigin: config.nhlApiOrigin,
      nhlFetchImplementation,
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
