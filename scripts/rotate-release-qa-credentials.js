#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const {
  loadStagingMaintenanceHoldConfig,
} = require("../src/config/loadStagingMaintenanceHoldConfig");
const {
  openDatabase,
  openReadonlyDatabase,
} = require("../src/infrastructure/database/connection");
const {
  assertDatabaseIdentity,
} = require("../src/infrastructure/database/databaseIdentity");
const {
  discoverMigrations,
  inspectMigrationState,
} = require("../src/infrastructure/database/migrate");
const {
  createScryptPasswordHasher,
} = require(
  "../src/infrastructure/security/createScryptPasswordHasher"
);
const {
  createSqliteCredentialRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqliteCredentialRepository"
);
const {
  createSqliteSessionRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqliteSessionRepository"
);
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require(
  "../src/operations/release/releaseQaFixtureContract"
);
const {
  rotateReleaseQaCredentials,
} = require(
  "../src/operations/release/rotateReleaseQaCredentials"
);
const {
  assertExactPhysicalTarget,
} = require("./reconcile-m7-26-staging-authority");

const ROOT_DIRECTORY = path.resolve(__dirname, "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const EXPECTED_SCHEMA_VERSION = 54;
const PASSWORD_ENVIRONMENT_FIELD = "M7_RELEASE_QA_PASSWORD";
const PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD =
  "M7_RELEASE_QA_PASSWORD_CONFIRMATION";
const RELEASE_ID_PATTERN = /^HL-\d{8}-[1-9]\d*$/u;

const COMMAND_ERROR_CODES = Object.freeze({
  argumentInvalid: "RELEASE_QA_CREDENTIAL_ROTATION_ARGUMENT_INVALID",
  environmentUnsafe: "RELEASE_QA_CREDENTIAL_ROTATION_ENVIRONMENT_UNSAFE",
  targetUnsafe: "RELEASE_QA_CREDENTIAL_ROTATION_TARGET_UNSAFE",
  identityMismatch: "RELEASE_QA_CREDENTIAL_ROTATION_IDENTITY_MISMATCH",
  schemaUnsupported: "RELEASE_QA_CREDENTIAL_ROTATION_SCHEMA_UNSUPPORTED",
  passwordInvalid: "RELEASE_QA_CREDENTIAL_ROTATION_PASSWORD_INVALID",
  commandFailed: "RELEASE_QA_CREDENTIAL_ROTATION_COMMAND_FAILED",
});

class ReleaseQaCredentialRotationCommandError extends Error {
  constructor(code, options = {}) {
    super(
      "The staging release-QA credential rotation command failed safely.",
      options
    );
    this.name = "ReleaseQaCredentialRotationCommandError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new ReleaseQaCredentialRotationCommandError(
    code,
    cause === undefined ? {} : { cause }
  );
}

function exactString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.startsWith("--")
  );
}

function parseArguments(argv) {
  const names = new Map([
    ["--database", "databasePath"],
    ["--environment", "environment"],
    ["--persistent-root", "persistentRoot"],
    ["--release-id", "releaseId"],
    ["--confirmation", "confirmation"],
  ]);
  if (!Array.isArray(argv) || argv.length !== names.size * 2) {
    fail(COMMAND_ERROR_CODES.argumentInvalid);
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = names.get(argv[index]);
    const value = argv[index + 1];
    if (!field || Object.hasOwn(options, field) || !exactString(value)) {
      fail(COMMAND_ERROR_CODES.argumentInvalid);
    }
    options[field] = value;
  }
  if (
    options.environment !== "staging" ||
    !RELEASE_ID_PATTERN.test(options.releaseId) ||
    !path.isAbsolute(options.databasePath) ||
    !path.isAbsolute(options.persistentRoot) ||
    path.normalize(options.databasePath) !== options.databasePath ||
    path.normalize(options.persistentRoot) !== options.persistentRoot ||
    path.parse(options.persistentRoot).root === options.persistentRoot
  ) {
    fail(COMMAND_ERROR_CODES.argumentInvalid);
  }
  return Object.freeze({ ...options });
}

function confirmationFor({ releaseId, environmentId, databaseId } = {}) {
  if (
    !RELEASE_ID_PATTERN.test(releaseId || "") ||
    environmentId !== FIXTURE_ENVIRONMENT_ID ||
    databaseId !== FIXTURE_DATABASE_ID
  ) {
    fail(COMMAND_ERROR_CODES.argumentInvalid);
  }
  return [
    "ROTATE-RELEASE-QA-CREDENTIALS",
    releaseId,
    "staging",
    environmentId,
    databaseId,
  ].join(":");
}

function assertSafeEnvironment(options, env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    fail(COMMAND_ERROR_CODES.environmentUnsafe);
  }
  let hold;
  try {
    hold = loadStagingMaintenanceHoldConfig({ env });
  } catch (error) {
    fail(COMMAND_ERROR_CODES.environmentUnsafe, error);
  }
  if (
    hold.enabled !== true ||
    env.APP_ENVIRONMENT_ID !== FIXTURE_ENVIRONMENT_ID ||
    env.DATABASE_ID !== FIXTURE_DATABASE_ID ||
    env.DATABASE_PATH !== options.databasePath ||
    env.PERSISTENT_DATA_ROOT !== options.persistentRoot ||
    options.confirmation !==
      confirmationFor({
        releaseId: options.releaseId,
        environmentId: env.APP_ENVIRONMENT_ID,
        databaseId: env.DATABASE_ID,
      })
  ) {
    fail(COMMAND_ERROR_CODES.environmentUnsafe);
  }
  return Object.freeze({
    databaseId: env.DATABASE_ID,
    environmentId: env.APP_ENVIRONMENT_ID,
  });
}

function consumePasswordEnvironment(env) {
  const password = env?.[PASSWORD_ENVIRONMENT_FIELD];
  const confirmation =
    env?.[PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD];
  if (env && typeof env === "object") {
    try {
      delete env[PASSWORD_ENVIRONMENT_FIELD];
      delete env[PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD];
    } catch {
      try {
        env[PASSWORD_ENVIRONMENT_FIELD] = undefined;
        env[PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD] = undefined;
      } catch {
        // The command will still retain no secret in output or arguments.
      }
    }
  }
  if (
    typeof password !== "string" ||
    typeof confirmation !== "string" ||
    password !== confirmation
  ) {
    fail(COMMAND_ERROR_CODES.passwordInvalid);
  }
  return password;
}

function assertExactTarget(options) {
  try {
    return assertExactPhysicalTarget({
      databasePath: options.databasePath,
      persistentRoot: options.persistentRoot,
    });
  } catch (error) {
    fail(COMMAND_ERROR_CODES.targetUnsafe, error);
  }
}

function assertExactDatabaseBinding(database, expectedIdentity) {
  let identity;
  try {
    identity = assertDatabaseIdentity(database, expectedIdentity);
  } catch (error) {
    fail(COMMAND_ERROR_CODES.identityMismatch, error);
  }
  let migrationState;
  try {
    migrationState = inspectMigrationState(
      database,
      discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY })
    );
  } catch (error) {
    fail(COMMAND_ERROR_CODES.schemaUnsupported, error);
  }
  const dataModelVersion = database.prepare(`
    SELECT metadata_value AS value
    FROM application_metadata
    WHERE metadata_key = 'data_model_version'
  `).get()?.value;
  if (
    migrationState.status !== "exact" ||
    migrationState.userVersion !== EXPECTED_SCHEMA_VERSION ||
    migrationState.applied.length !== EXPECTED_SCHEMA_VERSION ||
    dataModelVersion !== String(EXPECTED_SCHEMA_VERSION)
  ) {
    fail(COMMAND_ERROR_CODES.schemaUnsupported);
  }
  return Object.freeze({
    identity,
    schemaVersion: migrationState.userVersion,
  });
}

async function runReleaseQaCredentialRotationCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
  now = Date.now,
  openReadonlyDatabaseFunction = openReadonlyDatabase,
  openDatabaseFunction = openDatabase,
  createPasswordHasher = () =>
    createScryptPasswordHasher({
      secureRandom: Object.freeze({
        bytes(length) {
          return crypto.randomBytes(length);
        },
      }),
    }),
} = {}) {
  const password = consumePasswordEnvironment(env);
  const options = parseArguments(argv);
  const expectedIdentity = assertSafeEnvironment(options, env);
  const target = assertExactTarget(options);

  const readonlyDatabase = openReadonlyDatabaseFunction({
    databasePath: target.databasePath,
  });
  let readonlyBinding;
  try {
    readonlyDatabase.pragma("query_only = ON");
    readonlyBinding = assertExactDatabaseBinding(
      readonlyDatabase,
      expectedIdentity
    );
  } finally {
    if (readonlyDatabase?.open) readonlyDatabase.close();
  }

  const connection = openDatabaseFunction({
    databasePath: target.databasePath,
    environment: "staging",
    persistentRoot: target.persistentRoot,
    requirePersistentRoot: true,
  });
  try {
    const assertBinding = () => {
      const binding = assertExactDatabaseBinding(
        connection.database,
        expectedIdentity
      );
      if (
        binding.schemaVersion !== readonlyBinding.schemaVersion ||
        binding.identity.createdAt !== readonlyBinding.identity.createdAt
      ) {
        fail(COMMAND_ERROR_CODES.identityMismatch);
      }
      return binding;
    };
    assertBinding();
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      fail(COMMAND_ERROR_CODES.commandFailed);
    }
    const result = await rotateReleaseQaCredentials({
      database: connection.database,
      credentialRepository: createSqliteCredentialRepository({
        database: connection.database,
      }),
      sessionRepository: createSqliteSessionRepository({
        database: connection.database,
      }),
      auditRepository: createSqliteSecurityAuditRepository({
        database: connection.database,
      }),
      passwordHasher: createPasswordHasher(),
      password,
      rotationId: options.releaseId,
      environmentId: expectedIdentity.environmentId,
      databaseId: expectedIdentity.databaseId,
      schemaVersion: readonlyBinding.schemaVersion,
      nowMs,
      assertBinding,
    });
    output.log(JSON.stringify(result));
    return result;
  } finally {
    if (connection.database?.open) connection.database.close();
  }
}

async function main() {
  try {
    await runReleaseQaCredentialRotationCommand();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code:
            typeof error?.code === "string"
              ? error.code
              : COMMAND_ERROR_CODES.commandFailed,
          message:
            "The staging release-QA credential rotation command failed safely.",
        },
      })
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  COMMAND_ERROR_CODES,
  EXPECTED_SCHEMA_VERSION,
  MIGRATIONS_DIRECTORY,
  PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD,
  PASSWORD_ENVIRONMENT_FIELD,
  RELEASE_ID_PATTERN,
  ReleaseQaCredentialRotationCommandError,
  assertExactDatabaseBinding,
  assertSafeEnvironment,
  confirmationFor,
  consumePasswordEnvironment,
  parseArguments,
  runReleaseQaCredentialRotationCommand,
};
