const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  MINIMUM_SQLITE_VERSION,
  REQUIRED_PRAGMAS,
  compareVersions,
  openDatabase,
} = require("../../src/infrastructure/database/connection");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT_DIRECTORY, relativePath), "utf8")
  );
}

function listJavaScriptFiles(directoryPath) {
  return fs.readdirSync(directoryPath, { withFileTypes: true }).flatMap(
    (entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".js")
        ? [entryPath]
        : [];
    }
  );
}

function createTemporaryRoot(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return temporaryRoot;
}

function assertConnectionError(code) {
  return (error) => error?.code === code;
}

describe("SQLite driver and connection foundation", () => {
  test("pins the exact approved driver behind one infrastructure import", () => {
    const packageJson = readJson("package.json");
    const packageLock = readJson("package-lock.json");
    const installedDriver = require("better-sqlite3/package.json");

    assert.equal(packageJson.dependencies["better-sqlite3"], "12.11.1");
    assert.equal(
      packageLock.packages[""].dependencies["better-sqlite3"],
      "12.11.1"
    );
    assert.equal(
      packageLock.packages["node_modules/better-sqlite3"].version,
      "12.11.1"
    );
    assert.equal(installedDriver.version, "12.11.1");

    const driverImports = listJavaScriptFiles(
      path.join(ROOT_DIRECTORY, "src")
    )
      .filter((filePath) =>
        fs
          .readFileSync(filePath, "utf8")
          .includes('require("better-sqlite3")')
      )
      .map((filePath) =>
        path
          .relative(ROOT_DIRECTORY, filePath)
          .replaceAll(path.sep, "/")
      );

    assert.deepEqual(driverImports, [
      "src/infrastructure/database/connection.js",
    ]);
  });

  test("rejects unsafe paths before creating a database", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-02-invalid-"
    );
    const persistentRoot = path.join(temporaryRoot, "persistent");
    const outsidePath = path.join(temporaryRoot, "outside.sqlite3");
    fs.mkdirSync(persistentRoot);

    assert.throws(
      () => openDatabase(),
      assertConnectionError("DATABASE_PATH_REQUIRED")
    );
    assert.throws(
      () => openDatabase({ databasePath: "  " }),
      assertConnectionError("DATABASE_PATH_REQUIRED")
    );
    assert.throws(
      () => openDatabase({ databasePath: ":memory:" }),
      assertConnectionError("DATABASE_PATH_UNSUPPORTED")
    );
    assert.throws(
      () => openDatabase({ databasePath: "file:memory" }),
      assertConnectionError("DATABASE_PATH_UNSUPPORTED")
    );
    assert.throws(
      () =>
        openDatabase({
          databasePath: "relative.sqlite3",
          environment: "production",
          persistentRoot,
        }),
      assertConnectionError("DATABASE_PATH_NOT_ABSOLUTE")
    );
    assert.throws(
      () =>
        openDatabase({
          databasePath: outsidePath,
          environment: "production",
        }),
      assertConnectionError("DATABASE_PERSISTENT_ROOT_REQUIRED")
    );
    assert.throws(
      () =>
        openDatabase({
          databasePath: outsidePath,
          environment: "production",
          persistentRoot,
        }),
      assertConnectionError(
        "DATABASE_PATH_OUTSIDE_PERSISTENT_ROOT"
      )
    );
    assert.equal(fs.existsSync(outsidePath), false);
  });

  test("opens an explicit temporary file with every required PRAGMA", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-02-local-"
    );
    const relativeDatabasePath = path.join(
      "runtime",
      "foundation.sqlite3"
    );
    const expectedDatabasePath = path.join(
      temporaryRoot,
      relativeDatabasePath
    );
    const connection = openDatabase({
      databasePath: relativeDatabasePath,
      environment: "test",
      workingDirectory: temporaryRoot,
    });

    t.after(() => {
      if (connection.database.open) connection.database.close();
    });

    assert.equal(connection.databasePath, expectedDatabasePath);
    assert.equal(fs.existsSync(expectedDatabasePath), true);
    assert.deepEqual(connection.pragmas, REQUIRED_PRAGMAS);
    assert.equal(
      compareVersions(
        connection.sqliteVersion,
        MINIMUM_SQLITE_VERSION
      ) >= 0,
      true
    );

    connection.database.exec(`
      CREATE TABLE parent (
        id INTEGER PRIMARY KEY
      ) STRICT;
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parent(id)
      ) STRICT;
    `);

    assert.throws(
      () =>
        connection.database
          .prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)")
          .run(1, 999),
      /FOREIGN KEY constraint failed/
    );

    connection.database
      .prepare("INSERT INTO parent (id) VALUES (?)")
      .run(1);
    connection.database
      .prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)")
      .run(1, 1);

    assert.equal(
      path.dirname(`${connection.databasePath}-wal`),
      path.dirname(connection.databasePath)
    );
    assert.equal(fs.existsSync(`${connection.databasePath}-wal`), true);
    assert.equal(fs.existsSync(`${connection.databasePath}-shm`), true);

    connection.database.close();
    assert.equal(connection.database.open, false);
  });

  test("accepts only an existing production directory below its root", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-02-production-"
    );
    const persistentRoot = path.join(temporaryRoot, "persistent");
    const databaseDirectory = path.join(persistentRoot, "hundo");
    const databasePath = path.join(
      databaseDirectory,
      "hundo-leago.sqlite3"
    );
    fs.mkdirSync(databaseDirectory, { recursive: true });

    const connection = openDatabase({
      databasePath,
      environment: "production",
      persistentRoot,
    });

    assert.equal(connection.databasePath, databasePath);
    assert.equal(connection.pragmas.journalMode, "wal");
    connection.database.close();

    assert.throws(
      () =>
        openDatabase({
          databasePath: path.join(
            persistentRoot,
            "missing",
            "missing.sqlite3"
          ),
          environment: "production",
          persistentRoot,
        }),
      assertConnectionError("DATABASE_DIRECTORY_NOT_WRITABLE")
    );
  });
});
