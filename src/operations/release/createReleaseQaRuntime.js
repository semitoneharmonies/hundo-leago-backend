const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createRuntimeHealthService,
} = require("../../application/services/operations/createRuntimeHealthService");
const {
  createTargetScheduler,
} = require("../../application/services/operations/createTargetScheduler");
const {
  createSecurityFoundations,
} = require("../../bootstrap/createSecurityFoundations");
const {
  createTargetHttpServer,
} = require("../../bootstrap/createTargetHttpServer");
const {
  createTargetRuntime,
} = require("../../bootstrap/createTargetRuntime");
const {
  openDatabase,
} = require("../../infrastructure/database/connection");
const {
  createScryptPasswordHasher,
} = require("../../infrastructure/security/createScryptPasswordHasher");
const {
  readDatabaseIdentity,
} = require("../../infrastructure/database/databaseIdentity");
const {
  createOperationsHealthRouter,
} = require("../../transport/http/createOperationsHealthRouter");
const {
  createPublicHealthRouter,
} = require("../../transport/http/createPublicHealthRouter");
const {
  createReleaseQaFixture,
} = require("./createReleaseQaFixture");
const {
  assertReleaseQaPassword,
  inspectReleaseQaPassword,
} = require("./releaseQaPasswordPolicy");

const LOCAL_FRONTEND_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
]);
const LOOPBACK_HOST = "127.0.0.1";
const TEMP_PREFIX = "hundo-m7-release-qa-";

class ReleaseQaRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReleaseQaRuntimeError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ReleaseQaRuntimeError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function assertOptions({ frontendOrigin, migrationsDirectory, password, port, leagueWriteMode }) {
  if (!LOCAL_FRONTEND_ORIGINS.has(frontendOrigin)) {
    fail(
      "RELEASE_QA_FRONTEND_ORIGIN_INVALID",
      "The release-QA frontend origin must be an approved loopback Vite origin."
    );
  }
  if (!path.isAbsolute(migrationsDirectory || "")) {
    fail(
      "RELEASE_QA_MIGRATIONS_REQUIRED",
      "An absolute release-QA migrations directory is required."
    );
  }
  if (typeof password !== "string" || password === "") {
    fail(
      "RELEASE_QA_PASSWORD_REQUIRED",
      "An explicit release-QA fixture password is required."
    );
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    fail(
      "RELEASE_QA_PORT_INVALID",
      "The release-QA port must be a valid TCP port, or zero for an ephemeral port."
    );
  }
  if (!new Set(["closed", "open"]).has(leagueWriteMode)) {
    fail(
      "RELEASE_QA_WRITE_MODE_INVALID",
      "The release-QA league write mode must be closed or open."
    );
  }
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function removeOwnedTemporaryRoot(temporaryRoot) {
  const systemTemp = fs.realpathSync(os.tmpdir());
  const resolved = path.resolve(temporaryRoot);
  if (
    !isInside(systemTemp, resolved) ||
    !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    fail(
      "RELEASE_QA_TEMP_CLEANUP_REFUSED",
      "Release-QA cleanup refused a path it did not create."
    );
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function securityEnvironment(frontendOrigin) {
  return Object.freeze({
    APP_ENV: "local",
    NODE_ENV: "development",
    APP_BUILD_ID: "m7-local-backend",
    LOG_LEVEL: "error",
    PUBLIC_FRONTEND_ORIGIN: frontendOrigin,
    FRONTEND_ORIGINS: frontendOrigin,
    EMAIL_DELIVERY_MODE: "capture",
    RATE_LIMIT_KEY_SECRET: crypto.randomBytes(36).toString("base64url"),
    AUDIT_METADATA_SECRET: crypto.randomBytes(36).toString("base64url"),
    ACTION_TOKEN_DELIVERY_KEY: crypto.randomBytes(32).toString("base64url"),
  });
}

async function createReleaseQaRuntime({
  frontendOrigin = "http://127.0.0.1:5173",
  leagueWriteMode = "open",
  migrationsDirectory,
  password,
  port = 0,
} = {}) {
  assertOptions({ frontendOrigin, migrationsDirectory, password, port, leagueWriteMode });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const databasePath = path.join(temporaryRoot, "m7-release-qa.sqlite3");
  let connection;
  let server;
  let runtime;
  let closePromise = null;

  try {
    const fixture = await createReleaseQaFixture({
      databasePath,
      environment: "test",
      migrationsDirectory,
      password,
      temporaryRoot,
    });
    const securityFoundations = createSecurityFoundations({
      env: securityEnvironment(frontendOrigin),
      loggerSink() {},
    });
    const passwordHasher = createScryptPasswordHasher({
      secureRandom: securityFoundations.secureRandom,
      validatePassword: assertReleaseQaPassword,
    });
    connection = openDatabase({ databasePath, environment: "test" });
    const baseRuntime = createTargetRuntime({
      database: connection.database,
      migrationsDirectory,
      securityFoundations,
      passwordHasher,
      passwordInspector: inspectReleaseQaPassword,
      currentSeason: Object.freeze({
        label: "2026",
        nhlSeasonKey: "20262027",
      }),
      networkSourceResolver() {
        return LOOPBACK_HOST;
      },
      leagueWriteMode,
      nhlFetchImplementation: async () => {
        const error = new Error("Release-QA provider access is disabled.");
        error.code = "RELEASE_QA_PROVIDER_DISABLED";
        throw error;
      },
    });
    const databaseIdentity = readDatabaseIdentity(connection.database);
    const runtimeConfig = Object.freeze({
      appEnv: "staging",
      buildId: "m7-local-backend",
      environmentId: databaseIdentity.environmentId,
      frontendBuildId: "m7-local-frontend",
      leagueWriteMode,
      scheduledJobsEnabled: false,
    });
    const health = createRuntimeHealthService({
      database: connection.database,
      migrationState: baseRuntime.migrationState,
      databaseIdentity,
      runtimeConfig,
    });
    const scheduler = createTargetScheduler({
      enabled: false,
      leagueWriteMode,
      jobs: baseRuntime.services.league.scheduledJobs,
      emailJob: baseRuntime.services.accountEmail.job,
      health,
      logger: securityFoundations.logger,
    });
    baseRuntime.app.use(createPublicHealthRouter({ healthService: health }));
    baseRuntime.app.use(createOperationsHealthRouter({
      requestSecurity: baseRuntime.transport.requestSecurity,
      platformAuthorization: baseRuntime.services.authorizations.platform,
      healthService: health,
    }));

    let runtimeClosed = false;
    runtime = Object.freeze({
      ...baseRuntime,
      database: connection.database,
      databaseIdentity,
      databasePath,
      fixtureManifest: fixture.manifest,
      health,
      runtimeConfig,
      scheduler,
      close() {
        if (runtimeClosed) return;
        runtimeClosed = true;
        if (connection.database.open) connection.database.close();
        health.markClosed();
      },
    });
    server = createTargetHttpServer({
      runtime,
      securityConfig: securityFoundations.config,
    });
    const schedulerStart = scheduler.start();
    const address = await server.listen({ port, host: LOOPBACK_HOST });
    const baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;

    async function close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let closeError;
        try {
          await server.close();
        } catch (error) {
          closeError = error;
        }
        if (!connection.database.open) {
          removeOwnedTemporaryRoot(temporaryRoot);
        }
        if (closeError) throw closeError;
      })();
      return closePromise;
    }

    return Object.freeze({
      address: Object.freeze({ host: LOOPBACK_HOST, port: address.port }),
      baseUrl,
      close,
      databasePath,
      fixtureManifest: fixture.manifest,
      frontendOrigin,
      runtime,
      schedulerStart,
      server,
      temporaryRoot,
    });
  } catch (error) {
    try {
      if (server) await server.close();
      else if (connection?.database?.open) connection.database.close();
    } catch {
      // Preserve the startup failure.
    }
    try {
      if (!connection?.database?.open) removeOwnedTemporaryRoot(temporaryRoot);
    } catch {
      // Preserve the startup failure.
    }
    if (error instanceof ReleaseQaRuntimeError) throw error;
    fail(
      "RELEASE_QA_RUNTIME_START_FAILED",
      "The local release-QA runtime failed to start safely.",
      error
    );
  }
}

module.exports = {
  LOCAL_FRONTEND_ORIGINS,
  LOOPBACK_HOST,
  ReleaseQaRuntimeError,
  createReleaseQaRuntime,
  removeOwnedTemporaryRoot,
};
