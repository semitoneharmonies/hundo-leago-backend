const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const Database = require("better-sqlite3");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  DATABASE_IDENTITY_KEYS,
} = require("../../src/infrastructure/database/databaseIdentity");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATION_SCRIPT = path.join(
  ROOT_DIRECTORY,
  "scripts",
  "db-migrate.js"
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const ENVIRONMENT_ID = "test:release-qa";
const DATABASE_ID = "m7-release-qa-fixture";
const CREATED_AT = "2026-08-15T08:27:00.000Z";

function createSchema52Fixture(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const persistentRoot = path.join(temporaryRoot, "persistent");
  const databaseDirectory = path.join(persistentRoot, "sqlite");
  const databasePath = path.join(
    databaseDirectory,
    "staging.sqlite3"
  );
  fs.mkdirSync(databaseDirectory, { recursive: true });

  const migrations = discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  });
  assert.equal(migrations.length, 54);

  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  applyMigrations({
    database: connection.database,
    migrations: migrations.slice(0, 52),
    applicationBuildId: "schema-52-fixture",
    now: () => 1_000,
  });
  const insertMetadata = connection.database.prepare(`
    INSERT INTO application_metadata (
      metadata_key,
      metadata_value,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?)
  `);
  const createdAtMs = Date.parse(CREATED_AT);
  insertMetadata.run(
    DATABASE_IDENTITY_KEYS.environmentId,
    ENVIRONMENT_ID,
    createdAtMs,
    createdAtMs
  );
  insertMetadata.run(
    DATABASE_IDENTITY_KEYS.databaseId,
    DATABASE_ID,
    createdAtMs,
    createdAtMs
  );
  insertMetadata.run(
    DATABASE_IDENTITY_KEYS.createdAt,
    CREATED_AT,
    createdAtMs,
    createdAtMs
  );
  connection.database.pragma("wal_checkpoint(TRUNCATE)");
  connection.database.close();

  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { databasePath, persistentRoot, temporaryRoot };
}

function commandArguments(fixture, overrides = {}) {
  return [
    MIGRATION_SCRIPT,
    "--database",
    overrides.databasePath || fixture.databasePath,
    "--migrations",
    MIGRATIONS_DIRECTORY,
    "--build",
    "m7-26-migration-safety-test",
    "--environment",
    overrides.environment || "staging",
    "--persistent-root",
    overrides.persistentRoot || fixture.persistentRoot,
  ];
}

function commandEnvironment(fixture, overrides = {}) {
  return {
    ...process.env,
    APP_ENV: "staging",
    APP_ENVIRONMENT_ID: ENVIRONMENT_ID,
    DATABASE_ID,
    DATABASE_PATH: fixture.databasePath,
    NODE_ENV: "production",
    PERSISTENT_DATA_ROOT: fixture.persistentRoot,
    ...overrides,
  };
}

function hashFile(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function databaseFilesState(databasePath) {
  return Object.fromEntries(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => [
        path.basename(filePath),
        {
          sha256: hashFile(filePath),
          size: fs.statSync(filePath).size,
        },
      ])
  );
}

function readMigrationState(databasePath) {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return {
      appliedCount: database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get().count,
      userVersion: database.pragma("user_version", { simple: true }),
    };
  } finally {
    database.close();
  }
}

function assertFailureWithoutWrite({
  fixture,
  argumentsOverride,
  environmentOverride,
  expectedCode,
}) {
  const beforeState = readMigrationState(fixture.databasePath);
  const beforeFiles = databaseFilesState(fixture.databasePath);
  const result = spawnSync(
    process.execPath,
    commandArguments(fixture, argumentsOverride),
    {
      cwd: ROOT_DIRECTORY,
      encoding: "utf8",
      env: commandEnvironment(fixture, environmentOverride),
    }
  );

  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr.trim()).error.code, expectedCode);
  assert.deepEqual(readMigrationState(fixture.databasePath), beforeState);
  assert.deepEqual(databaseFilesState(fixture.databasePath), beforeFiles);
}

describe("staging SQLite migration command safety", () => {
  test("binds the exact physical staging database and reports the full schema-54 ledger", (t) => {
    const fixture = createSchema52Fixture(
      t,
      "hundo-leago-m7-26-migrate-success-"
    );
    const result = spawnSync(
      process.execPath,
      commandArguments(fixture),
      {
        cwd: ROOT_DIRECTORY,
        encoding: "utf8",
        env: commandEnvironment(fixture),
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      status: "exact",
      appliedCount: 54,
      latestMigrationId: 54,
    });
    assert.deepEqual(readMigrationState(fixture.databasePath), {
      appliedCount: 54,
      userVersion: 54,
    });

    const database = new Database(fixture.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const identity = Object.fromEntries(
        database
          .prepare(`
            SELECT metadata_key AS key, metadata_value AS value
            FROM application_metadata
            WHERE metadata_key IN (?, ?, ?)
            ORDER BY metadata_key
          `)
          .all(
            DATABASE_IDENTITY_KEYS.createdAt,
            DATABASE_IDENTITY_KEYS.databaseId,
            DATABASE_IDENTITY_KEYS.environmentId
          )
          .map((row) => [row.key, row.value])
      );
      assert.deepEqual(identity, {
        [DATABASE_IDENTITY_KEYS.createdAt]: CREATED_AT,
        [DATABASE_IDENTITY_KEYS.databaseId]: DATABASE_ID,
        [DATABASE_IDENTITY_KEYS.environmentId]: ENVIRONMENT_ID,
      });
    } finally {
      database.close();
    }
  });

  test("rejects staging environment, identity, path, root, and symlink drift before any write", (t) => {
    const fixture = createSchema52Fixture(
      t,
      "hundo-leago-m7-26-migrate-failures-"
    );

    const scenarios = [
      {
        environmentOverride: { APP_ENV: "production" },
        expectedCode: "MIGRATION_STAGING_ENVIRONMENT_UNSAFE",
      },
      {
        environmentOverride: {
          APP_ENVIRONMENT_ID: "different-staging-environment",
        },
        expectedCode: "DATABASE_IDENTITY_MISMATCH",
      },
      {
        environmentOverride: {
          DATABASE_ID: "different-staging-database",
        },
        expectedCode: "DATABASE_IDENTITY_MISMATCH",
      },
      {
        argumentsOverride: {
          databasePath: path.join(
            fixture.persistentRoot,
            "sqlite",
            "wrong.sqlite3"
          ),
        },
        expectedCode: "MIGRATION_STAGING_ENVIRONMENT_UNSAFE",
      },
      {
        argumentsOverride: {
          persistentRoot: path.join(
            fixture.temporaryRoot,
            "wrong-root"
          ),
        },
        expectedCode: "MIGRATION_STAGING_ENVIRONMENT_UNSAFE",
      },
    ];

    for (const scenario of scenarios) {
      assertFailureWithoutWrite({ fixture, ...scenario });
    }

    const outsideRoot = path.join(
      fixture.temporaryRoot,
      "other-persistent"
    );
    fs.mkdirSync(outsideRoot);
    assertFailureWithoutWrite({
      fixture,
      argumentsOverride: { persistentRoot: outsideRoot },
      environmentOverride: { PERSISTENT_DATA_ROOT: outsideRoot },
      expectedCode: "MIGRATION_STAGING_TARGET_UNSAFE",
    });

    const linkedRoot = path.join(
      fixture.temporaryRoot,
      "linked-persistent"
    );
    fs.symlinkSync(
      fixture.persistentRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
    assertFailureWithoutWrite({
      fixture,
      argumentsOverride: {
        databasePath: path.join(
          linkedRoot,
          "sqlite",
          path.basename(fixture.databasePath)
        ),
        persistentRoot: linkedRoot,
      },
      environmentOverride: {
        DATABASE_PATH: path.join(
          linkedRoot,
          "sqlite",
          path.basename(fixture.databasePath)
        ),
        PERSISTENT_DATA_ROOT: linkedRoot,
      },
      expectedCode: "MIGRATION_STAGING_TARGET_UNSAFE",
    });
  });
});
