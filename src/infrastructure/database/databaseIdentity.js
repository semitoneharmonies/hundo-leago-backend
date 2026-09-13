const fs = require("node:fs");

const {
  openDatabase,
} = require("./connection");
const {
  assertMigrationCompatibility,
  discoverMigrations,
} = require("./migrate");

const DATABASE_IDENTITY_KEYS = Object.freeze({
  createdAt: "database_created_at",
  databaseId: "database_id",
  environmentId: "environment_id",
});
const DATABASE_IDENTITY_KEY_LIST = Object.freeze(
  Object.values(DATABASE_IDENTITY_KEYS).sort()
);
const IDENTITY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

class DatabaseIdentityError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "DatabaseIdentityError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new DatabaseIdentityError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function validateIdentity(value, field) {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
    fail("DATABASE_IDENTITY_INPUT_INVALID", `${field} is invalid.`);
  }
  return value;
}

function validateCreatedAt(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(
      "DATABASE_IDENTITY_INPUT_INVALID",
      "databaseCreatedAt is invalid."
    );
  }
  return value;
}

function readDatabaseIdentityState(database) {
  let rows;
  try {
    rows = database
      .prepare(
        `
          SELECT metadata_key AS key, metadata_value AS value
          FROM application_metadata
          WHERE metadata_key IN (?, ?, ?)
          ORDER BY metadata_key
        `
      )
      .all(...DATABASE_IDENTITY_KEY_LIST);
  } catch (error) {
    fail(
      "DATABASE_IDENTITY_UNAVAILABLE",
      "The database environment identity is unavailable.",
      error
    );
  }
  return Object.freeze(
    Object.fromEntries(rows.map((row) => [row.key, row.value]))
  );
}

function readDatabaseIdentity(database) {
  const state = readDatabaseIdentityState(database);
  if (Object.keys(state).length !== 3) {
    fail(
      "DATABASE_IDENTITY_UNINITIALIZED",
      "The database environment identity is not initialized."
    );
  }
  const createdAt = state[DATABASE_IDENTITY_KEYS.createdAt];
  const databaseId = state[DATABASE_IDENTITY_KEYS.databaseId];
  const environmentId = state[DATABASE_IDENTITY_KEYS.environmentId];
  validateCreatedAt(createdAt);
  validateIdentity(databaseId, "databaseId");
  validateIdentity(environmentId, "environmentId");
  return Object.freeze({ createdAt, databaseId, environmentId });
}

function assertDatabaseIdentity(database, expected) {
  const identity = readDatabaseIdentity(database);
  if (
    identity.environmentId !== expected.environmentId ||
    identity.databaseId !== expected.databaseId
  ) {
    fail(
      "DATABASE_IDENTITY_MISMATCH",
      "The configured and stored database identities do not match."
    );
  }
  return identity;
}

function initializeDatabaseIdentity({
  databasePath,
  persistentRoot,
  applicationEnvironment,
  environmentId,
  databaseId,
  databaseCreatedAt,
  migrationsDirectory,
  productionConfirmation,
  beforeCommit,
  fsModule = fs,
  openDatabaseFunction = openDatabase,
} = {}) {
  if (!["staging", "production"].includes(applicationEnvironment)) {
    fail(
      "DATABASE_IDENTITY_INPUT_INVALID",
      "applicationEnvironment is invalid."
    );
  }
  const expected = Object.freeze({
    createdAt: validateCreatedAt(databaseCreatedAt),
    databaseId: validateIdentity(databaseId, "databaseId"),
    environmentId: validateIdentity(environmentId, "environmentId"),
  });
  if (
    applicationEnvironment === "production" &&
    productionConfirmation !== databaseId
  ) {
    fail(
      "DATABASE_IDENTITY_PRODUCTION_CONFIRMATION_REQUIRED",
      "Exact production database confirmation is required."
    );
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("database identity beforeCommit must be a function");
  }
  if (
    !fsModule ||
    typeof fsModule.existsSync !== "function" ||
    typeof openDatabaseFunction !== "function"
  ) {
    throw new TypeError("database identity requires filesystem and database adapters");
  }
  if (!fsModule.existsSync(databasePath)) {
    fail(
      "DATABASE_IDENTITY_DATABASE_REQUIRED",
      "An existing database is required."
    );
  }

  const connection = openDatabaseFunction({
    databasePath,
    environment: applicationEnvironment,
    persistentRoot,
    requirePersistentRoot: true,
  });
  try {
    const migrationState = assertMigrationCompatibility(
      connection.database,
      discoverMigrations({ migrationsDirectory })
    );
    const existing = readDatabaseIdentityState(connection.database);
    const existingKeys = Object.keys(existing).sort();
    if (existingKeys.length > 0) {
      if (
        existingKeys.length === 3 &&
        existingKeys.every((key, index) => key === DATABASE_IDENTITY_KEY_LIST[index])
      ) {
        const current = readDatabaseIdentity(connection.database);
        if (
          current.createdAt === expected.createdAt &&
          current.databaseId === expected.databaseId &&
          current.environmentId === expected.environmentId
        ) {
          return Object.freeze({
            identity: current,
            initialized: false,
            replayed: true,
            schemaVersion: migrationState.userVersion,
          });
        }
        fail(
          "DATABASE_IDENTITY_CONFLICT",
          "The database environment identity conflicts with the request."
        );
      }
      fail(
        "DATABASE_IDENTITY_PARTIAL",
        "The database environment identity is partially initialized."
      );
    }

    const insert = connection.database.prepare(
      `
        INSERT INTO application_metadata
          (metadata_key, metadata_value, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?)
      `
    );
    const createdAtMs = Date.parse(expected.createdAt);
    const initialize = connection.database.transaction(() => {
      insert.run(
        DATABASE_IDENTITY_KEYS.createdAt,
        expected.createdAt,
        createdAtMs,
        createdAtMs
      );
      insert.run(
        DATABASE_IDENTITY_KEYS.databaseId,
        expected.databaseId,
        createdAtMs,
        createdAtMs
      );
      insert.run(
        DATABASE_IDENTITY_KEYS.environmentId,
        expected.environmentId,
        createdAtMs,
        createdAtMs
      );
      if (beforeCommit) beforeCommit();
    });
    try {
      initialize.immediate();
    } catch (error) {
      fail(
        "DATABASE_IDENTITY_INITIALIZATION_FAILED",
        "Database environment identity initialization failed.",
        error
      );
    }
    return Object.freeze({
      identity: readDatabaseIdentity(connection.database),
      initialized: true,
      replayed: false,
      schemaVersion: migrationState.userVersion,
    });
  } finally {
    if (connection.database?.open) connection.database.close();
  }
}

module.exports = {
  DATABASE_IDENTITY_KEYS,
  DATABASE_IDENTITY_KEY_LIST,
  DatabaseIdentityError,
  assertDatabaseIdentity,
  initializeDatabaseIdentity,
  readDatabaseIdentity,
  readDatabaseIdentityState,
};
