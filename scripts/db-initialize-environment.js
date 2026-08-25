const path = require("node:path");

const {
  initializeDatabaseIdentity,
} = require("../src/infrastructure/database/databaseIdentity");

const ARGUMENTS = Object.freeze({
  "--database": "databasePath",
  "--persistent-root": "persistentRoot",
  "--environment": "applicationEnvironment",
  "--environment-id": "environmentId",
  "--database-id": "databaseId",
  "--created-at": "databaseCreatedAt",
  "--migrations": "migrationsDirectory",
  "--confirm-production": "productionConfirmation",
});

function argumentError() {
  const error = new Error("Database identity arguments are invalid.");
  error.code = "DATABASE_IDENTITY_ARGUMENT_INVALID";
  throw error;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) argumentError();
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = ARGUMENTS[argv[index]];
    const value = argv[index + 1];
    if (!key || typeof value !== "string" || value === "" || options[key]) {
      argumentError();
    }
    options[key] = value;
  }
  for (const key of Object.values(ARGUMENTS).filter(
    (value) => value !== "productionConfirmation"
  )) {
    if (!options[key]) argumentError();
  }
  return Object.freeze(options);
}

function safeResult(result, applicationEnvironment) {
  return Object.freeze({
    operation: "database-environment-identity",
    status: result.initialized ? "initialized" : "already-initialized",
    environment: applicationEnvironment,
    databaseIdSuffix: result.identity.databaseId.slice(-8),
    schemaVersion: result.schemaVersion,
  });
}

function runDatabaseIdentityCommand({
  argv = process.argv.slice(2),
  initialize = initializeDatabaseIdentity,
} = {}) {
  const options = parseArguments(argv);
  const result = initialize(options);
  return safeResult(result, options.applicationEnvironment);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(runDatabaseIdentityCommand())}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        error: {
          code: error?.code || "DATABASE_IDENTITY_OPERATION_FAILED",
          message: "Database environment identity was not changed.",
        },
      })}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  ARGUMENTS,
  parseArguments,
  runDatabaseIdentityCommand,
  safeResult,
};
