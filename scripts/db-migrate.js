#!/usr/bin/env node

const path = require("node:path");

const {
  openDatabase,
} = require("../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../src/infrastructure/database/migrate");
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

function runMigrationCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  const connection = openDatabase({
    databasePath: options.databasePath,
    environment:
      options.environment || env.NODE_ENV || "development",
    persistentRoot: options.persistentRoot,
  });

  try {
    const result = migrateDatabase({
      database: connection.database,
      migrationsDirectory:
        options.migrationsDirectory ||
        DEFAULT_MIGRATIONS_DIRECTORY,
      applicationBuildId: resolveBuildIdentifier(options, env),
    });

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
