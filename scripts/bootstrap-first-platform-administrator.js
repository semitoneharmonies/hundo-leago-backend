#!/usr/bin/env node

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
} = require("../src/infrastructure/database/connection");
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

function runBootstrapCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  const identity = protectedIdentity(env);
  const delivery = protectedDeliveryConfiguration(env);
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
    const result = service.bootstrap(identity);
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
