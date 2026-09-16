#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  createAccountActionTokenService,
} = require(
  "../src/application/services/accounts/createAccountActionTokenService"
);
const {
  createFirstPlatformAdministratorService,
} = require(
  "../src/application/services/accounts/createFirstPlatformAdministratorService"
);
const {
  openDatabase,
  openReadonlyDatabase,
  resolveDatabasePath,
} = require("../src/infrastructure/database/connection");
const {
  assertDatabaseIdentity,
} = require("../src/infrastructure/database/databaseIdentity");
const {
  assertMigrationCompatibility,
  discoverMigrations,
} = require("../src/infrastructure/database/migrate");
const {
  createSqliteAccountActionTokenRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqliteAccountActionTokenRepository"
);
const {
  createSqliteOutboxEventRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqliteOutboxEventRepository"
);
const {
  createSqlitePlatformRoleRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  createSqliteUserRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createActionTokenDeliveryEnvelope,
} = require(
  "../src/infrastructure/security/createActionTokenDeliveryEnvelope"
);
const {
  createOpaqueActionTokens,
} = require(
  "../src/infrastructure/security/createOpaqueActionTokens"
);
const {
  createSecureRandom,
} = require(
  "../src/infrastructure/security/createSecureRandom"
);
const {
  createSystemClock,
} = require(
  "../src/infrastructure/security/createSystemClock"
);

const APP_ENVIRONMENTS = Object.freeze([
  "local",
  "test",
  "staging",
  "production",
]);
const PRODUCTION_CONFIRMATION =
  "CREATE_FIRST_PLATFORM_ADMINISTRATOR";

class BootstrapCommandArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootstrapCommandArgumentError";
    this.code = "FIRST_PLATFORM_ADMINISTRATOR_ARGUMENT_INVALID";
  }
}

function fail(message) {
  throw new BootstrapCommandArgumentError(message);
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    fail("Bootstrap arguments are required.");
  }
  const optionMap = new Map([
    ["--app-env", "appEnv"],
    ["--confirm-app-env", "confirmedAppEnv"],
    ["--database", "databasePath"],
    ["--migrations", "migrationsDirectory"],
    ["--persistent-root", "persistentRoot"],
    ["--production-confirmation", "productionConfirmation"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const field = optionMap.get(option);
    if (!field || Object.hasOwn(options, field)) {
      fail("Bootstrap arguments are invalid.");
    }
    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.startsWith("--")
    ) {
      fail("Bootstrap arguments are invalid.");
    }
    options[field] = value;
    index += 1;
  }
  for (const field of [
    "appEnv",
    "confirmedAppEnv",
    "databasePath",
    "migrationsDirectory",
  ]) {
    if (!Object.hasOwn(options, field)) {
      fail("Bootstrap arguments are incomplete.");
    }
  }
  if (
    !APP_ENVIRONMENTS.includes(options.appEnv) ||
    options.confirmedAppEnv !== options.appEnv
  ) {
    fail("The application environment confirmation is invalid.");
  }
  const deployed = ["staging", "production"].includes(
    options.appEnv
  );
  if (deployed !== Object.hasOwn(options, "persistentRoot")) {
    fail("The persistent-root argument is invalid for this environment.");
  }
  if (options.appEnv === "production") {
    if (
      options.productionConfirmation !== PRODUCTION_CONFIRMATION
    ) {
      fail("The production bootstrap confirmation is invalid.");
    }
  } else if (
    Object.hasOwn(options, "productionConfirmation")
  ) {
    fail("Production confirmation is not accepted outside production.");
  }
  return Object.freeze({ ...options });
}

function protectedIdentity(env) {
  if (
    !env ||
    typeof env.BOOTSTRAP_ADMIN_EMAIL !== "string" ||
    typeof env.BOOTSTRAP_ADMIN_DISPLAY_NAME !== "string"
  ) {
    fail("Protected bootstrap identity input is required.");
  }
  return Object.freeze({
    email: env.BOOTSTRAP_ADMIN_EMAIL,
    displayName: env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
  });
}

function protectedDeliveryConfiguration(env) {
  if (
    !env ||
    typeof env.PUBLIC_FRONTEND_ORIGIN !== "string" ||
    typeof env.ACTION_TOKEN_DELIVERY_KEY !== "string"
  ) {
    fail("Protected bootstrap delivery configuration is required.");
  }
  return Object.freeze({
    publicFrontendOrigin: env.PUBLIC_FRONTEND_ORIGIN,
    encodedDeliveryKey: env.ACTION_TOKEN_DELIVERY_KEY,
  });
}

function confirmedProductionIdentity(options, env, delivery) {
  if (options.appEnv !== "production") return null;
  const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
  let origin;
  try { origin = new URL(delivery.publicFrontendOrigin); } catch { /* Reject below. */ }
  if (
    env.APP_ENV !== "production" ||
    typeof env.APP_ENVIRONMENT_ID !== "string" || !identityPattern.test(env.APP_ENVIRONMENT_ID) ||
    typeof env.DATABASE_ID !== "string" || !identityPattern.test(env.DATABASE_ID) ||
    !origin || origin.protocol !== "https:" || origin.origin !== delivery.publicFrontendOrigin
  ) {
    const error = new Error("Production bootstrap requires the confirmed database identity and secure frontend origin.");
    error.code = "FIRST_PLATFORM_ADMINISTRATOR_PRODUCTION_CONFIG_INVALID";
    throw error;
  }
  return Object.freeze({ environmentId: env.APP_ENVIRONMENT_ID, databaseId: env.DATABASE_ID });
}

function inspectProductionBootstrapDatabase(options, expected) {
  const databasePath = resolveDatabasePath({
    databasePath: options.databasePath,
    environment: "production",
    persistentRoot: options.persistentRoot,
  });
  if (!fs.existsSync(databasePath)) {
    const error = new Error("An existing absolute database path is required.");
    error.code = "DATABASE_PATH_REQUIRED";
    throw error;
  }
  function assertClosedSource() {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (fs.existsSync(databasePath + suffix)) {
        const error = new Error("Production bootstrap requires a closed, checkpointed database.");
        error.code = "FIRST_PLATFORM_ADMINISTRATOR_DATABASE_NOT_CLOSED";
        throw error;
      }
    }
  }
  const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assertClosedSource();
  const sourceHash = digest(databasePath);
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const temporaryDirectory = fs.mkdtempSync(path.join(temporaryParent, "hundo-bootstrap-preflight-"));
  try {
    fs.chmodSync(temporaryDirectory, 0o700);
    const copy = path.join(temporaryDirectory, "candidate.sqlite3");
    fs.copyFileSync(databasePath, copy, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(copy, 0o600);
    assertClosedSource();
    if (digest(copy) !== sourceHash || digest(databasePath) !== sourceHash) {
      const error = new Error("Production bootstrap source changed during inspection.");
      error.code = "FIRST_PLATFORM_ADMINISTRATOR_DATABASE_CHANGED";
      throw error;
    }
    // SQLite may create WAL sidecars even for read-only opens. Inspect only
    // this private disposable copy; a rejection leaves the selected files alone.
    const inspected = openReadonlyDatabase({ databasePath: copy });
    try {
      assertMigrationCompatibility(inspected, discoverMigrations({ migrationsDirectory: options.migrationsDirectory }));
      assertDatabaseIdentity(inspected, expected);
    } finally { inspected.close(); }
  } finally {
    const resolved = fs.realpathSync(temporaryDirectory);
    if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith("hundo-bootstrap-preflight-")) {
      throw new Error("Bootstrap temporary-directory cleanup target is invalid.");
    }
    fs.rmSync(resolved, { recursive: true, force: false });
  }
  assertClosedSource();
  if (digest(databasePath) !== sourceHash) {
    const error = new Error("Production bootstrap source changed after inspection.");
    error.code = "FIRST_PLATFORM_ADMINISTRATOR_DATABASE_CHANGED";
    throw error;
  }
}

function runBootstrapCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  const identity = protectedIdentity(env);
  const delivery = protectedDeliveryConfiguration(env);
  const productionIdentity = confirmedProductionIdentity(options, env, delivery);
  if (productionIdentity) {
    inspectProductionBootstrapDatabase(options, productionIdentity);
  }
  const connection = openDatabase({
    databasePath: options.databasePath,
    environment: ["staging", "production"].includes(options.appEnv)
      ? "production"
      : options.appEnv,
    persistentRoot: options.persistentRoot,
  });

  try {
    assertMigrationCompatibility(
      connection.database,
      discoverMigrations({
        migrationsDirectory: options.migrationsDirectory,
      })
    );
    const repositoryContext = createSqliteRepositoryContext({
      database: connection.database,
    });
    const userRepository = createSqliteUserRepository({
      database: connection.database,
    });
    const platformRoleRepository =
      createSqlitePlatformRoleRepository({
        database: connection.database,
      });
    const actionTokenRepository =
      createSqliteAccountActionTokenRepository({
        database: connection.database,
      });
    const auditRepository =
      createSqliteSecurityAuditRepository({
        database: connection.database,
      });
    const outboxRepository =
      createSqliteOutboxEventRepository({
        database: connection.database,
      });
    const clock = createSystemClock();
    const secureRandom = createSecureRandom();
    const actionTokenService =
      createAccountActionTokenService({
        repository: actionTokenRepository,
        opaqueTokens: createOpaqueActionTokens({
          secureRandom,
        }),
        clock,
        secureRandom,
      });
    const service = createFirstPlatformAdministratorService({
      repositoryContext,
      userRepository,
      platformRoleRepository,
      actionTokenService,
      auditRepository,
      outboxRepository,
      deliveryEnvelope: createActionTokenDeliveryEnvelope({
        encodedKey: delivery.encodedDeliveryKey,
        keyVersion: 1,
        secureRandom,
      }),
      clock,
      secureRandom,
      publicFrontendOrigin: delivery.publicFrontendOrigin,
    });
    const result = productionIdentity
      ? connection.database.transaction(() => {
          // Recheck under the same writer transaction as account creation.
          assertDatabaseIdentity(connection.database, productionIdentity);
          return service.bootstrap(identity);
        }).immediate()
      : service.bootstrap(identity);
    const summary = Object.freeze({
      status: "created",
      code: result.code,
      userId: result.userId,
      deliveryQueued: true,
    });
    output.log(JSON.stringify(summary));
    return summary;
  } finally {
    connection.database.close();
  }
}

function main() {
  try {
    runBootstrapCommand();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code:
            error?.code ||
            "FIRST_PLATFORM_ADMINISTRATOR_COMMAND_FAILED",
          message:
            error?.message ||
            "First platform-administrator bootstrap failed safely.",
        },
      })
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  APP_ENVIRONMENTS,
  BootstrapCommandArgumentError,
  PRODUCTION_CONFIRMATION,
  parseArguments,
  protectedDeliveryConfiguration,
  protectedIdentity,
  runBootstrapCommand,
};
