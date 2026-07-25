const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  DATABASE_IDENTITY_KEYS,
  initializeDatabaseIdentity,
  readDatabaseIdentityState,
} = require("../../src/infrastructure/database/databaseIdentity");
const {
  openDatabase,
  openReadonlyDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  parseArguments,
  runDatabaseIdentityCommand,
} = require("../../scripts/db-initialize-environment");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "database", "migrations");
const CREATED_AT = "2026-07-22T14:00:00.000Z";
const ENVIRONMENT_ID = "hundo-staging-environment-v2";
const DATABASE_ID = "hundo-staging-database-v2";

function createCandidate(t, { migrated = true } = {}) {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m7-database-identity-")
  );
  const directory = path.join(persistentRoot, "sqlite");
  fs.mkdirSync(directory);
  const databasePath = path.join(directory, "candidate.sqlite3");
  const connection = openDatabase({ databasePath, environment: "test" });
  if (migrated) {
    migrateDatabase({
      database: connection.database,
      migrationsDirectory: MIGRATIONS,
      applicationBuildId: "m7-02-test",
      now: () => Date.parse(CREATED_AT),
    });
  }
  connection.database.close();
  t.after(() => fs.rmSync(persistentRoot, { recursive: true, force: true }));
  return { databasePath, persistentRoot };
}

function identityOptions(candidate, overrides = {}) {
  return {
    ...candidate,
    applicationEnvironment: "staging",
    environmentId: ENVIRONMENT_ID,
    databaseId: DATABASE_ID,
    databaseCreatedAt: CREATED_AT,
    migrationsDirectory: MIGRATIONS,
    ...overrides,
  };
}

function readState(databasePath) {
  const database = openReadonlyDatabase({ databasePath });
  try {
    return readDatabaseIdentityState(database);
  } finally {
    database.close();
  }
}

describe("M7-02 explicit database environment identity", () => {
  test("initializes all three immutable values atomically after exact migration verification", (t) => {
    const candidate = createCandidate(t);
    const result = initializeDatabaseIdentity(identityOptions(candidate));

    assert.equal(result.initialized, true);
    assert.equal(result.replayed, false);
    assert.equal(result.schemaVersion, 18);
    assert.deepEqual(result.identity, {
      createdAt: CREATED_AT,
      databaseId: DATABASE_ID,
      environmentId: ENVIRONMENT_ID,
    });
    assert.deepEqual(readState(candidate.databasePath), {
      [DATABASE_IDENTITY_KEYS.createdAt]: CREATED_AT,
      [DATABASE_IDENTITY_KEYS.databaseId]: DATABASE_ID,
      [DATABASE_IDENTITY_KEYS.environmentId]: ENVIRONMENT_ID,
    });
  });

  test("replays exact identity without a write and rejects every conflict without change", (t) => {
    const candidate = createCandidate(t);
    initializeDatabaseIdentity(identityOptions(candidate));
    const before = fs.readFileSync(candidate.databasePath);
    const replay = initializeDatabaseIdentity(identityOptions(candidate));
    assert.equal(replay.initialized, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(fs.readFileSync(candidate.databasePath), before);

    for (const override of [
      { databaseId: "hundo-different-database-v2" },
      { environmentId: "hundo-different-environment-v2" },
      { databaseCreatedAt: "2026-07-22T14:00:01.000Z" },
    ]) {
      assert.throws(
        () =>
          initializeDatabaseIdentity(identityOptions(candidate, override)),
        { code: "DATABASE_IDENTITY_CONFLICT" }
      );
      assert.deepEqual(fs.readFileSync(candidate.databasePath), before);
    }
  });

  test("rejects partial identity and rolls an injected late failure fully back", (t) => {
    const partial = createCandidate(t);
    const connection = openDatabase({
      databasePath: partial.databasePath,
      environment: "test",
    });
    connection.database
      .prepare(
        "INSERT INTO application_metadata " +
          "(metadata_key, metadata_value, created_at_ms, updated_at_ms) " +
          "VALUES (?, ?, 0, 0)"
      )
      .run(DATABASE_IDENTITY_KEYS.databaseId, DATABASE_ID);
    connection.database.close();
    const partialBefore = fs.readFileSync(partial.databasePath);
    assert.throws(
      () => initializeDatabaseIdentity(identityOptions(partial)),
      { code: "DATABASE_IDENTITY_PARTIAL" }
    );
    assert.deepEqual(fs.readFileSync(partial.databasePath), partialBefore);

    const rollback = createCandidate(t);
    assert.throws(
      () =>
        initializeDatabaseIdentity(
          identityOptions(rollback, {
            beforeCommit() {
              throw new Error("injected late failure");
            },
          })
        ),
      { code: "DATABASE_IDENTITY_INITIALIZATION_FAILED" }
    );
    assert.deepEqual(readState(rollback.databasePath), {});
  });

  test("refuses missing and behind databases and requires exact production confirmation", (t) => {
    const missing = createCandidate(t);
    fs.rmSync(missing.databasePath);
    assert.throws(
      () => initializeDatabaseIdentity(identityOptions(missing)),
      { code: "DATABASE_IDENTITY_DATABASE_REQUIRED" }
    );
    assert.equal(fs.existsSync(missing.databasePath), false);

    const behind = createCandidate(t, { migrated: false });
    assert.throws(
      () => initializeDatabaseIdentity(identityOptions(behind)),
      { code: "MIGRATION_DATABASE_BEHIND" }
    );
    const behindDatabase = openReadonlyDatabase({
      databasePath: behind.databasePath,
    });
    assert.equal(
      behindDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema " +
            "WHERE type = 'table' AND name = 'application_metadata'"
        )
        .get().count,
      0
    );
    behindDatabase.close();

    const production = createCandidate(t);
    assert.throws(
      () =>
        initializeDatabaseIdentity(
          identityOptions(production, {
            applicationEnvironment: "production",
          })
        ),
      { code: "DATABASE_IDENTITY_PRODUCTION_CONFIRMATION_REQUIRED" }
    );
    const result = initializeDatabaseIdentity(
      identityOptions(production, {
        applicationEnvironment: "production",
        productionConfirmation: DATABASE_ID,
      })
    );
    assert.equal(result.initialized, true);
  });

  test("parses exact CLI flags and emits content-free summary evidence", () => {
    const argv = [
      "--database",
      "C:\\private\\candidate.sqlite3",
      "--persistent-root",
      "C:\\private",
      "--environment",
      "staging",
      "--environment-id",
      ENVIRONMENT_ID,
      "--database-id",
      DATABASE_ID,
      "--created-at",
      CREATED_AT,
      "--migrations",
      "C:\\source\\migrations",
    ];
    assert.equal(parseArguments(argv).databaseId, DATABASE_ID);
    const summary = runDatabaseIdentityCommand({
      argv,
      initialize(options) {
        assert.equal(options.databasePath, "C:\\private\\candidate.sqlite3");
        return {
          initialized: true,
          schemaVersion: 18,
          identity: { databaseId: DATABASE_ID },
        };
      },
    });
    assert.deepEqual(summary, {
      operation: "database-environment-identity",
      status: "initialized",
      environment: "staging",
      databaseIdSuffix: "abase-v2",
      schemaVersion: 18,
    });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("private"), false);
    assert.equal(serialized.includes("candidate.sqlite3"), false);
    assert.throws(
      () => parseArguments([...argv, "--database", "duplicate"]),
      { code: "DATABASE_IDENTITY_ARGUMENT_INVALID" }
    );
  });
});
