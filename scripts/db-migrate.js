#!/usr/bin/env node

const path = require("node:path");

const {
  openDatabase,
  openReadonlyDatabase,
} = require("../src/infrastructure/database/connection");
const {
  assertDatabaseIdentity,
} = require("../src/infrastructure/database/databaseIdentity");
const {
  migrateDatabase,
} = require("../src/infrastructure/database/migrate");
const {
  assertExactPhysicalTarget,
} = require("./reconcile-m7-26-staging-authority");
const packageJson = require("../package.json");

const DEFAULT_MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "database",
  "migrations"
);

class CommandArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandArgumentError";
    this.code = "MIGRATION_ARGUMENT_INVALID";
  }
}

class MigrationCommandSafetyError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "MigrationCommandSafetyError";
    this.code = code;
  }
}

function safetyError(code, message, cause) {
  return new MigrationCommandSafetyError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function parseArguments(argv) {
  const options = {};
  const valueOptions = new Map([
    ["--database", "databasePath"],
    ["--migrations", "migrationsDirectory"],
    ["--build", "applicationBuildId"],
    ["--environment", "environment"],
    ["--persistent-root", "persistentRoot"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const optionName = valueOptions.get(argument);
    if (!optionName) {
      throw new CommandArgumentError(
        `Unknown migration argument: ${argument}`
      );
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CommandArgumentError(
        `Migration argument requires a value: ${argument}`
      );
    }

    options[optionName] = value;
    index += 1;
  }

  if (!options.databasePath) {
    throw new CommandArgumentError(
      "The --database argument is required."
    );
  }

  return options;
}

function resolveBuildIdentifier(options, env) {
  return (
    options.applicationBuildId ||
    env.APPLICATION_BUILD_ID ||
    env.RENDER_GIT_COMMIT ||
    `${packageJson.name}@${packageJson.version}`
  );
}

function isExactNonemptyString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim()
  );
}

function resolveStagingBinding(options, env) {
  if (
    options.environment !== "staging" ||
    env.APP_ENV !== "staging" ||
    env.DATABASE_PATH !== options.databasePath ||
    env.PERSISTENT_DATA_ROOT !== options.persistentRoot ||
    !isExactNonemptyString(env.APP_ENVIRONMENT_ID) ||
    !isExactNonemptyString(env.DATABASE_ID) ||
    !path.isAbsolute(options.databasePath) ||
    !path.isAbsolute(options.persistentRoot || "") ||
    path.normalize(options.databasePath) !== options.databasePath ||
    path.normalize(options.persistentRoot) !== options.persistentRoot ||
    path.parse(options.persistentRoot).root === options.persistentRoot
  ) {
    throw safetyError(
      "MIGRATION_STAGING_ENVIRONMENT_UNSAFE",
      "The staging migration command is not bound to the configured staging database."
    );
  }

  let target;
  try {
    target = assertExactPhysicalTarget({
      databasePath: options.databasePath,
      persistentRoot: options.persistentRoot,
    });
  } catch (error) {
    throw safetyError(
      "MIGRATION_STAGING_TARGET_UNSAFE",
      "The staging migration target is not an exact physical persistent-root database.",
      error
    );
  }

  return Object.freeze({
    expectedIdentity: Object.freeze({
      databaseId: env.DATABASE_ID,
      environmentId: env.APP_ENVIRONMENT_ID,
    }),
    target,
  });
}

function assertReadonlyStagingIdentity({
  databasePath,
  expectedIdentity,
}) {
  const database = openReadonlyDatabase({ databasePath });
  try {
    return assertDatabaseIdentity(database, expectedIdentity);
  } finally {
    if (database.open) database.close();
  }
}

function runMigrationCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  const stagingRequested =
    options.environment === "staging" || env.APP_ENV === "staging";
  const stagingBinding = stagingRequested
    ? resolveStagingBinding(options, env)
    : null;

  if (stagingBinding) {
    assertReadonlyStagingIdentity({
      databasePath: stagingBinding.target.databasePath,
      expectedIdentity: stagingBinding.expectedIdentity,
    });
  }

  const connection = openDatabase({
    databasePath:
      stagingBinding?.target.databasePath || options.databasePath,
    environment:
      options.environment || env.NODE_ENV || "development",
    persistentRoot:
      stagingBinding?.target.persistentRoot || options.persistentRoot,
    requirePersistentRoot: Boolean(stagingBinding),
  });

  try {
    if (stagingBinding) {
      assertDatabaseIdentity(
        connection.database,
        stagingBinding.expectedIdentity
      );
    }

    const result = migrateDatabase({
      database: connection.database,
      migrationsDirectory:
        options.migrationsDirectory ||
        DEFAULT_MIGRATIONS_DIRECTORY,
      applicationBuildId: resolveBuildIdentifier(options, env),
    });

    if (stagingBinding) {
      assertDatabaseIdentity(
        connection.database,
        stagingBinding.expectedIdentity
      );
    }

    const summary = {
      status: result.status,
      appliedCount: result.applied.length,
      latestMigrationId: result.applied.at(-1)?.id || 0,
    };
    output.log(JSON.stringify(summary));
    return summary;
  } finally {
    connection.database.close();
  }
}

function main() {
  try {
    runMigrationCommand();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: error?.code || "MIGRATION_COMMAND_FAILED",
          message: error?.message || "Migration command failed.",
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
  CommandArgumentError,
  DEFAULT_MIGRATIONS_DIRECTORY,
  parseArguments,
  resolveBuildIdentifier,
  runMigrationCommand,
};
