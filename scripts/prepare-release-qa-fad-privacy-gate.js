#!/usr/bin/env node

"use strict";

const path = require("node:path");

const {
  createSecurityFoundations,
} = require("../src/bootstrap/createSecurityFoundations");
const {
  createTargetRuntime,
} = require("../src/bootstrap/createTargetRuntime");
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
  prepareReleaseQaFadPrivacyGate,
  REQUIRED_SCHEMA_VERSION,
} = require(
  "../src/operations/release/prepareReleaseQaFadPrivacyGate"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require(
  "../src/operations/release/releaseQaFixtureContract"
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
const RELEASE_ID_PATTERN = /^HL-\d{8}-[1-9]\d*$/u;

const COMMAND_ERROR_CODES = Object.freeze({
  argumentInvalid: "RELEASE_QA_FAD_PRIVACY_GATE_ARGUMENT_INVALID",
  environmentUnsafe: "RELEASE_QA_FAD_PRIVACY_GATE_ENVIRONMENT_UNSAFE",
  targetUnsafe: "RELEASE_QA_FAD_PRIVACY_GATE_TARGET_UNSAFE",
  identityMismatch: "RELEASE_QA_FAD_PRIVACY_GATE_IDENTITY_MISMATCH",
  schemaUnsupported: "RELEASE_QA_FAD_PRIVACY_GATE_SCHEMA_UNSUPPORTED",
  commandFailed: "RELEASE_QA_FAD_PRIVACY_GATE_COMMAND_FAILED",
});

class ReleaseQaFadPrivacyGateCommandError extends Error {
  constructor(code, options = {}) {
    super(
      "The staging release-QA FAD privacy-gate command failed safely.",
      options
    );
    this.name = "ReleaseQaFadPrivacyGateCommandError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new ReleaseQaFadPrivacyGateCommandError(
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

function confirmationFor({ releaseId } = {}) {
  if (!RELEASE_ID_PATTERN.test(releaseId || "")) {
    fail(COMMAND_ERROR_CODES.argumentInvalid);
  }
  return [
    "PREPARE-RELEASE-QA-FAD-PRIVACY-GATE",
    releaseId,
    "staging",
    FIXTURE_ENVIRONMENT_ID,
    FIXTURE_DATABASE_ID,
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
    options.confirmation !== confirmationFor({ releaseId: options.releaseId })
  ) {
    fail(COMMAND_ERROR_CODES.environmentUnsafe);
  }
  return Object.freeze({
    databaseId: FIXTURE_DATABASE_ID,
    environmentId: FIXTURE_ENVIRONMENT_ID,
  });
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
    migrationState.userVersion !== REQUIRED_SCHEMA_VERSION ||
    migrationState.applied.length !== REQUIRED_SCHEMA_VERSION ||
    dataModelVersion !== String(REQUIRED_SCHEMA_VERSION)
  ) {
    fail(COMMAND_ERROR_CODES.schemaUnsupported);
  }
  return Object.freeze({
    identity,
    schemaVersion: migrationState.userVersion,
  });
}

function createOperatorRuntime({ database, env, now }) {
  const securityFoundations = createSecurityFoundations({
    env,
    now,
    loggerSink() {},
  });
  // This runtime is never bound to a listener. Its HTTP write gate and FAD
  // routes stay held; the operator invokes only its allowlisted services.
  const runtime = createTargetRuntime({
    database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    securityFoundations,
    currentSeason: Object.freeze({
      label: "2026",
      nhlSeasonKey: "20262027",
    }),
    leagueWriteMode: "closed",
    freeAgentDraftRoutesEnabled: false,
    networkSourceResolver() {
      return "127.0.0.1";
    },
  });
  return Object.freeze({ ...runtime, database });
}

async function runReleaseQaFadPrivacyGateCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
  now = Date.now,
  openReadonlyDatabaseFunction = openReadonlyDatabase,
  openDatabaseFunction = openDatabase,
  createOperatorRuntimeFunction = createOperatorRuntime,
  prepareFunction = prepareReleaseQaFadPrivacyGate,
} = {}) {
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
      const currentIdentity = assertSafeEnvironment(options, env);
      const currentTarget = assertExactTarget(options);
      if (
        currentTarget.databasePath !== target.databasePath ||
        currentTarget.persistentRoot !== target.persistentRoot
      ) {
        fail(COMMAND_ERROR_CODES.targetUnsafe);
      }
      const binding = assertExactDatabaseBinding(
        connection.database,
        currentIdentity
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
    let runtime;
    try {
      runtime = createOperatorRuntimeFunction({
        database: connection.database,
        env,
        now: () => nowMs,
      });
    } catch (error) {
      fail(COMMAND_ERROR_CODES.commandFailed, error);
    }
    const result = await prepareFunction({
      runtime,
      operationId: options.releaseId,
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
    await runReleaseQaFadPrivacyGateCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code:
          typeof error?.code === "string"
            ? error.code
            : COMMAND_ERROR_CODES.commandFailed,
        message:
          "The staging release-QA FAD privacy-gate command failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  COMMAND_ERROR_CODES,
  MIGRATIONS_DIRECTORY,
  RELEASE_ID_PATTERN,
  ReleaseQaFadPrivacyGateCommandError,
  assertExactDatabaseBinding,
  assertSafeEnvironment,
  confirmationFor,
  createOperatorRuntime,
  parseArguments,
  runReleaseQaFadPrivacyGateCommand,
};
