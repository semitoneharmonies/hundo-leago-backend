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
  applyMigrations,
  assertMigrationCompatibility,
  discoverMigrations,
  hasMigrationLedger,
  inspectMigrationState,
  readAppliedMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATION_SCRIPT = path.join(
  ROOT_DIRECTORY,
  "scripts",
  "db-migrate.js"
);

function createTemporaryRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function registerTemporaryRootCleanup(
  t,
  temporaryRoot,
  connections = []
) {
  t.after(() => {
    for (const connection of connections) {
      if (connection.database.open) connection.database.close();
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
}

function writeMigration(directoryPath, fileName, sql) {
  fs.writeFileSync(path.join(directoryPath, fileName), sql, "utf8");
}

function createConnection(temporaryRoot, fileName = "test.sqlite3") {
  return openDatabase({
    databasePath: path.join(temporaryRoot, fileName),
    environment: "test",
  });
}

function assertMigrationError(code) {
  return (error) => error?.code === code;
}

describe("SQLite migration engine and ledger", () => {
  test("discovers canonical migrations in numeric order with exact checksums", (t) => {
    const temporaryRoot = createTemporaryRoot(
      "hundo-leago-m2-03-discovery-"
    );
    registerTemporaryRootCleanup(t, temporaryRoot);
    const firstSql =
      "CREATE TABLE first_table (id INTEGER PRIMARY KEY) STRICT;\n";
    const secondSql =
      "CREATE TABLE second_table (id INTEGER PRIMARY KEY) STRICT;\r\n";
    writeMigration(temporaryRoot, "0002_second_table.sql", secondSql);
    writeMigration(temporaryRoot, "0001_first_table.sql", firstSql);
    fs.writeFileSync(
      path.join(temporaryRoot, "README.md"),
      "ignored\n",
      "utf8"
    );

    const migrations = discoverMigrations({
      migrationsDirectory: temporaryRoot,
    });

    assert.deepEqual(
      migrations.map(({ id, fileName }) => ({ id, fileName })),
      [
        { id: 1, fileName: "0001_first_table.sql" },
        { id: 2, fileName: "0002_second_table.sql" },
      ]
    );
    assert.equal(
      migrations[0].checksum,
      crypto.createHash("sha256").update(firstSql).digest("hex")
    );
    assert.equal(
      migrations[1].checksum,
      crypto.createHash("sha256").update(secondSql).digest("hex")
    );
  });

  test("rejects malformed names and duplicate numeric IDs", (t) => {
    const malformedRoot = createTemporaryRoot(
      "hundo-leago-m2-03-malformed-"
    );
    registerTemporaryRootCleanup(t, malformedRoot);
    writeMigration(malformedRoot, "1_bad.sql", "SELECT 1;\n");
    assert.throws(
      () =>
        discoverMigrations({
          migrationsDirectory: malformedRoot,
        }),
      assertMigrationError("MIGRATION_FILE_NAME_INVALID")
    );

    const duplicateRoot = createTemporaryRoot(
      "hundo-leago-m2-03-duplicate-"
    );
    registerTemporaryRootCleanup(t, duplicateRoot);
    writeMigration(duplicateRoot, "0001_first.sql", "SELECT 1;\n");
    writeMigration(duplicateRoot, "0001_second.sql", "SELECT 2;\n");
    assert.throws(
      () =>
        discoverMigrations({
          migrationsDirectory: duplicateRoot,
        }),
      assertMigrationError("MIGRATION_ID_INVALID")
    );
  });

  test("reports empty and behind states without incidental writes", (t) => {
    const temporaryRoot = createTemporaryRoot(
      "hundo-leago-m2-03-state-"
    );
    const migrationsRoot = path.join(temporaryRoot, "migrations");
    fs.mkdirSync(migrationsRoot);
    const connection = createConnection(temporaryRoot);
    registerTemporaryRootCleanup(t, temporaryRoot, [connection]);

    const emptyMigrations = discoverMigrations({
      migrationsDirectory: migrationsRoot,
    });
    assert.deepEqual(
      inspectMigrationState(connection.database, emptyMigrations),
      {
        status: "exact",
        applied: [],
        pending: [],
        userVersion: 0,
      }
    );
    assert.equal(hasMigrationLedger(connection.database), false);

    writeMigration(
      migrationsRoot,
      "0001_example.sql",
      "CREATE TABLE example (id INTEGER PRIMARY KEY) STRICT;\n"
    );
    const migrations = discoverMigrations({
      migrationsDirectory: migrationsRoot,
    });
    const state = inspectMigrationState(
      connection.database,
      migrations
    );

    assert.equal(state.status, "behind");
    assert.deepEqual(
      state.pending.map((migration) => migration.id),
      [1]
    );
    assert.equal(hasMigrationLedger(connection.database), false);
    assert.throws(
      () =>
        assertMigrationCompatibility(
          connection.database,
          migrations
        ),
      assertMigrationError("MIGRATION_DATABASE_BEHIND")
    );
  });

  test("applies ordered migrations atomically and reruns idempotently", (t) => {
    const temporaryRoot = createTemporaryRoot(
      "hundo-leago-m2-03-apply-"
    );
    const migrationsRoot = path.join(temporaryRoot, "migrations");
    fs.mkdirSync(migrationsRoot);
    writeMigration(
      migrationsRoot,
      "0001_example.sql",
      "CREATE TABLE example (id INTEGER PRIMARY KEY) STRICT;\n"
    );
    writeMigration(
      migrationsRoot,
      "0002_example_name.sql",
      "ALTER TABLE example ADD COLUMN name TEXT;\n"
    );

    const connection = createConnection(temporaryRoot);
    registerTemporaryRootCleanup(t, temporaryRoot, [connection]);
    const migrations = discoverMigrations({
      migrationsDirectory: migrationsRoot,
    });
    const times = [1_000, 1_006, 2_000, 2_009];
    let timeCalls = 0;
    const result = applyMigrations({
      database: connection.database,
      migrations,
      applicationBuildId: "m2-03-test-build",
      now() {
        timeCalls += 1;
        return times[timeCalls - 1];
      },
    });

    assert.equal(result.status, "exact");
    assert.equal(connection.database.pragma("user_version", {
      simple: true,
    }), 2);
    assert.deepEqual(readAppliedMigrations(connection.database), [
      {
        id: 1,
        fileName: "0001_example.sql",
        checksum: migrations[0].checksum,
        applicationBuildId: "m2-03-test-build",
        startedAtMs: 1_000,
        appliedAtMs: 1_006,
        durationMs: 6,
      },
      {
        id: 2,
        fileName: "0002_example_name.sql",
        checksum: migrations[1].checksum,
        applicationBuildId: "m2-03-test-build",
        startedAtMs: 2_000,
        appliedAtMs: 2_009,
        durationMs: 9,
      },
    ]);
    assert.equal(
      connection.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM pragma_table_info('example')
        `)
        .get().count,
      2
    );

    const rerun = applyMigrations({
      database: connection.database,
      migrations,
      applicationBuildId: "m2-03-rerun",
      now() {
        throw new Error("an exact rerun must not call the clock");
      },
    });
    assert.equal(rerun.status, "exact");
    assert.equal(readAppliedMigrations(connection.database).length, 2);
  });

  test("fails closed for changed, ahead, and version-mismatch states", (t) => {
    const temporaryRoot = createTemporaryRoot(
      "hundo-leago-m2-03-compatibility-"
    );
    const migrationsRoot = path.join(temporaryRoot, "migrations");
    fs.mkdirSync(migrationsRoot);
    writeMigration(
      migrationsRoot,
      "0001_first.sql",
      "CREATE TABLE first_table (id INTEGER PRIMARY KEY) STRICT;\n"
    );
    writeMigration(
      migrationsRoot,
      "0002_second.sql",
      "CREATE TABLE second_table (id INTEGER PRIMARY KEY) STRICT;\n"
    );

    const connection = createConnection(temporaryRoot);
    registerTemporaryRootCleanup(t, temporaryRoot, [connection]);
    const migrations = discoverMigrations({
      migrationsDirectory: migrationsRoot,
    });
    applyMigrations({
      database: connection.database,
      migrations,
      applicationBuildId: "m2-03-test",
      now: () => 1_000,
    });

    writeMigration(
      migrationsRoot,
      "0001_first.sql",
      "CREATE TABLE changed_table (id INTEGER PRIMARY KEY) STRICT;\n"
    );
    assert.throws(
      () =>
        inspectMigrationState(
          connection.database,
          discoverMigrations({
            migrationsDirectory: migrationsRoot,
          })
        ),
      assertMigrationError("MIGRATION_CHECKSUM_MISMATCH")
    );

    writeMigration(
      migrationsRoot,
      "0001_first.sql",
      migrations[0].sql
    );
    fs.renameSync(
      path.join(migrationsRoot, "0001_first.sql"),
      path.join(migrationsRoot, "0001_renamed.sql")
    );
    assert.throws(
      () =>
        inspectMigrationState(
          connection.database,
          discoverMigrations({
            migrationsDirectory: migrationsRoot,
          })
        ),
      assertMigrationError("MIGRATION_FILE_NAME_MISMATCH")
    );

    fs.renameSync(
      path.join(migrationsRoot, "0001_renamed.sql"),
      path.join(migrationsRoot, "0001_first.sql")
    );
    assert.throws(
      () =>
        inspectMigrationState(connection.database, [migrations[0]]),
      assertMigrationError("MIGRATION_DATABASE_AHEAD")
    );

    connection.database.pragma("user_version = 1");
    assert.throws(
      () =>
        inspectMigrationState(connection.database, migrations),
      assertMigrationError("MIGRATION_USER_VERSION_MISMATCH")
    );
  });

  test("rolls back a failed migration without a partial ledger or version", (t) => {
    const temporaryRoot = createTemporaryRoot(
      "hundo-leago-m2-03-rollback-"
    );
    const migrationsRoot = path.join(temporaryRoot, "migrations");
    fs.mkdirSync(migrationsRoot);
    writeMigration(
      migrationsRoot,
      "0001_good.sql",
      "CREATE TABLE committed_table (id INTEGER PRIMARY KEY) STRICT;\n"
    );
    writeMigration(
      migrationsRoot,
      "0002_failing.sql",
      [
        "CREATE TABLE partial_table (id INTEGER PRIMARY KEY) STRICT;",
        "INSERT INTO missing_table (id) VALUES (1);",
        "",
      ].join("\n")
    );

    const connection = createConnection(temporaryRoot);
    registerTemporaryRootCleanup(t, temporaryRoot, [connection]);
    const migrations = discoverMigrations({
      migrationsDirectory: migrationsRoot,
    });

    assert.throws(
      () =>
        applyMigrations({
          database: connection.database,
          migrations,
          applicationBuildId: "m2-03-test",
          now: () => 1_000,
        }),
      assertMigrationError("MIGRATION_APPLY_FAILED")
    );
    assert.equal(
      connection.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'table' AND name = 'committed_table'
        `)
        .get().count,
      1
    );
    assert.equal(
      connection.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'table' AND name = 'partial_table'
        `)
        .get().count,
      0
    );
    assert.deepEqual(
      readAppliedMigrations(connection.database).map(
        (migration) => migration.id
      ),
      [1]
    );
    assert.equal(
      connection.database.pragma("user_version", { simple: true }),
      1
    );
  });

  test("runs only through the explicit CLI and fails safely without a path", (t) => {
    const temporaryRoot = createTemporaryRoot(
      "hundo-leago-m2-03-cli-"
    );
    registerTemporaryRootCleanup(t, temporaryRoot);
    const migrationsRoot = path.join(temporaryRoot, "migrations");
    const databasePath = path.join(temporaryRoot, "cli.sqlite3");
    fs.mkdirSync(migrationsRoot);
    writeMigration(
      migrationsRoot,
      "0001_cli.sql",
      "CREATE TABLE cli_table (id INTEGER PRIMARY KEY) STRICT;\n"
    );

    const success = spawnSync(
      process.execPath,
      [
        MIGRATION_SCRIPT,
        "--database",
        databasePath,
        "--migrations",
        migrationsRoot,
        "--build",
        "m2-03-cli-test",
        "--environment",
        "test",
      ],
      { cwd: ROOT_DIRECTORY, encoding: "utf8" }
    );
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout.trim()), {
      status: "exact",
      appliedCount: 1,
      latestMigrationId: 1,
    });

    const database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    assert.equal(database.pragma("user_version", { simple: true }), 1);
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'table' AND name = 'cli_table'
        `)
        .get().count,
      1
    );
    database.close();

    const failure = spawnSync(process.execPath, [MIGRATION_SCRIPT], {
      cwd: ROOT_DIRECTORY,
      encoding: "utf8",
    });
    assert.equal(failure.status, 1);
    assert.equal(
      JSON.parse(failure.stderr.trim()).error.code,
      "MIGRATION_ARGUMENT_INVALID"
    );

    const startupSources = [
      "server.js",
      "src/bootstrap/createApplication.js",
      "src/bootstrap/createCompatibilityRuntime.js",
      "src/bootstrap/createDependencies.js",
      "src/bootstrap/createHttpServer.js",
    ].map((relativePath) =>
      fs.readFileSync(
        path.join(ROOT_DIRECTORY, relativePath),
        "utf8"
      )
    );
    assert.equal(
      startupSources.some((source) =>
        source.includes("migrateDatabase")
      ),
      false
    );
  });
});
