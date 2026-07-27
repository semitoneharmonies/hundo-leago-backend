const {
  assertDatabaseIdentity,
} = require("../infrastructure/database/databaseIdentity");
const {
  openDatabase,
} = require("../infrastructure/database/connection");
const {
  loadTargetRuntimeConfig,
} = require("../config/loadTargetRuntimeConfig");
const {
  runDeployedBackup,
} = require("../../scripts/db-backup");
const {
  runMigrationCommand,
} = require("../../scripts/db-migrate");

const CONFIRMATION =
  "MIGRATE RELEASE QA STAGING TO SCHEMA 21";
const SOURCE_SCHEMA_VERSION = 20;
const TARGET_SCHEMA_VERSION = 21;

class StagingSchemaMigrationBridgeError extends Error {
  constructor(code) {
    super("The staging schema migration bridge failed safely.");
    this.name = "StagingSchemaMigrationBridgeError";
    this.code = code;
  }
}

function fail(code) {
  throw new StagingSchemaMigrationBridgeError(code);
}

function inspectSchema({
  config,
  openDatabaseFunction,
  assertDatabaseIdentityFunction,
}) {
  const connection = openDatabaseFunction({
    databasePath: config.databasePath,
    environment: config.appEnv,
    persistentRoot: config.persistentRoot,
    requirePersistentRoot: true,
  });
  try {
    assertDatabaseIdentityFunction(connection.database, {
      databaseId: config.databaseId,
      environmentId: config.environmentId,
    });
    return connection.database.pragma("user_version", { simple: true });
  } finally {
    if (connection.database?.open) connection.database.close();
  }
}

async function runStagingSchemaMigrationBridge({
  env = process.env,
  loadConfig = loadTargetRuntimeConfig,
  openDatabaseFunction = openDatabase,
  assertDatabaseIdentityFunction = assertDatabaseIdentity,
  createBackup = runDeployedBackup,
  migrate = runMigrationCommand,
} = {}) {
  const confirmation = env.STAGING_SCHEMA_MIGRATION_CONFIRMATION;
  if (confirmation === undefined) {
    return Object.freeze({ ran: false, replayed: false });
  }
  if (
    confirmation !== CONFIRMATION ||
    typeof loadConfig !== "function" ||
    typeof openDatabaseFunction !== "function" ||
    typeof assertDatabaseIdentityFunction !== "function" ||
    typeof createBackup !== "function" ||
    typeof migrate !== "function"
  ) {
    fail("STAGING_SCHEMA_MIGRATION_BRIDGE_INVALID");
  }

  const config = loadConfig({ env });
  if (
    config.appEnv !== "staging" ||
    config.environmentId !== "test:release-qa" ||
    config.databaseId !== "m7-release-qa-fixture"
  ) {
    fail("STAGING_SCHEMA_MIGRATION_BRIDGE_FORBIDDEN");
  }

  const beforeVersion = inspectSchema({
    config,
    openDatabaseFunction,
    assertDatabaseIdentityFunction,
  });
  if (beforeVersion === TARGET_SCHEMA_VERSION) {
    return Object.freeze({
      ran: false,
      replayed: true,
      schemaVersion: TARGET_SCHEMA_VERSION,
    });
  }
  if (beforeVersion !== SOURCE_SCHEMA_VERSION) {
    fail("STAGING_SCHEMA_MIGRATION_BRIDGE_VERSION_MISMATCH");
  }

  const backup = await createBackup({
    env,
    argv: [
      "--reason",
      "pre-migration",
      "--requested-by-type",
      "platform_operation",
      "--requested-by-id",
      "m7-15-schema-21",
      "--retention-class",
      "pre-change",
    ],
  });
  const migration = migrate({
    env,
    argv: [
      "--database",
      config.databasePath,
      "--migrations",
      config.migrationsDirectory,
      "--build",
      config.buildId,
      "--environment",
      config.appEnv,
      "--persistent-root",
      config.persistentRoot,
    ],
    output: { log() {} },
  });
  const afterVersion = inspectSchema({
    config,
    openDatabaseFunction,
    assertDatabaseIdentityFunction,
  });
  if (
    afterVersion !== TARGET_SCHEMA_VERSION ||
    migration.latestMigrationId !== TARGET_SCHEMA_VERSION
  ) {
    fail("STAGING_SCHEMA_MIGRATION_BRIDGE_INCOMPLETE");
  }
  return Object.freeze({
    backupId: backup.backupId,
    manifestChecksum: backup.manifestChecksum,
    ran: true,
    replayed: false,
    schemaVersion: afterVersion,
  });
}

module.exports = {
  CONFIRMATION,
  SOURCE_SCHEMA_VERSION,
  StagingSchemaMigrationBridgeError,
  TARGET_SCHEMA_VERSION,
  runStagingSchemaMigrationBridge,
};
