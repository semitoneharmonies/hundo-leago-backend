const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const MINIMUM_SQLITE_VERSION = "3.37.0";

const REQUIRED_PRAGMAS = Object.freeze({
  foreignKeys: 1,
  journalMode: "wal",
  synchronous: 2,
  busyTimeout: 5000,
  walAutocheckpoint: 1000,
  journalSizeLimit: 67_108_864,
  trustedSchema: 0,
});

class DatabaseConnectionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "DatabaseConnectionError";
    this.code = code;
  }
}

function connectionError(code, message, cause) {
  return new DatabaseConnectionError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function isPathInside(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function assertWritableDirectory(directoryPath) {
  try {
    fs.accessSync(directoryPath, fs.constants.W_OK);
  } catch (error) {
    throw connectionError(
      "DATABASE_DIRECTORY_NOT_WRITABLE",
      "Database parent directory must exist and be writable.",
      error
    );
  }
}

function resolveDatabasePath({
  databasePath,
  environment = "development",
  persistentRoot,
  workingDirectory = process.cwd(),
} = {}) {
  if (typeof databasePath !== "string" || databasePath.trim() === "") {
    throw connectionError(
      "DATABASE_PATH_REQUIRED",
      "An explicit database path is required."
    );
  }

  const trimmedDatabasePath = databasePath.trim();
  if (
    trimmedDatabasePath === ":memory:" ||
    trimmedDatabasePath.toLowerCase().startsWith("file:")
  ) {
    throw connectionError(
      "DATABASE_PATH_UNSUPPORTED",
      "The application connection requires a real database file path."
    );
  }

  if (environment === "production") {
    if (!path.isAbsolute(trimmedDatabasePath)) {
      throw connectionError(
        "DATABASE_PATH_NOT_ABSOLUTE",
        "The production database path must be absolute."
      );
    }

    if (
      typeof persistentRoot !== "string" ||
      persistentRoot.trim() === "" ||
      !path.isAbsolute(persistentRoot.trim())
    ) {
      throw connectionError(
        "DATABASE_PERSISTENT_ROOT_REQUIRED",
        "An absolute production persistent root is required."
      );
    }

    const resolvedDatabasePath = path.resolve(trimmedDatabasePath);
    const resolvedPersistentRoot = path.resolve(persistentRoot.trim());
    const databaseDirectory = path.dirname(resolvedDatabasePath);

    let physicalPersistentRoot;
    let physicalDatabaseDirectory;
    try {
      physicalPersistentRoot = fs.realpathSync(resolvedPersistentRoot);
      physicalDatabaseDirectory = fs.realpathSync(databaseDirectory);
    } catch (error) {
      throw connectionError(
        "DATABASE_DIRECTORY_NOT_WRITABLE",
        "The production persistent root and database parent directory must exist.",
        error
      );
    }

    const physicalDatabasePath = fs.existsSync(resolvedDatabasePath)
      ? fs.realpathSync(resolvedDatabasePath)
      : path.join(
          physicalDatabaseDirectory,
          path.basename(resolvedDatabasePath)
        );

    if (
      !isPathInside(physicalPersistentRoot, physicalDatabasePath)
    ) {
      throw connectionError(
        "DATABASE_PATH_OUTSIDE_PERSISTENT_ROOT",
        "The production database must be below its persistent root."
      );
    }

    assertWritableDirectory(physicalDatabaseDirectory);
    return resolvedDatabasePath;
  }

  const resolvedDatabasePath = path.resolve(
    workingDirectory,
    trimmedDatabasePath
  );
  const databaseDirectory = path.dirname(resolvedDatabasePath);

  try {
    fs.mkdirSync(databaseDirectory, { recursive: true });
  } catch (error) {
    throw connectionError(
      "DATABASE_DIRECTORY_NOT_WRITABLE",
      "The database parent directory could not be created.",
      error
    );
  }

  assertWritableDirectory(databaseDirectory);
  return resolvedDatabasePath;
}

function compareVersions(leftVersion, rightVersion) {
  const leftParts = leftVersion.split(".").map(Number);
  const rightParts = rightVersion.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }

  return 0;
}

function configureDatabase(database) {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma(
    `busy_timeout = ${REQUIRED_PRAGMAS.busyTimeout}`
  );
  database.pragma(
    `wal_autocheckpoint = ${REQUIRED_PRAGMAS.walAutocheckpoint}`
  );
  database.pragma(
    `journal_size_limit = ${REQUIRED_PRAGMAS.journalSizeLimit}`
  );
  database.pragma("trusted_schema = OFF");

  const actualPragmas = {
    foreignKeys: database.pragma("foreign_keys", { simple: true }),
    journalMode: database.pragma("journal_mode", { simple: true }),
    synchronous: database.pragma("synchronous", { simple: true }),
    busyTimeout: database.pragma("busy_timeout", { simple: true }),
    walAutocheckpoint: database.pragma("wal_autocheckpoint", {
      simple: true,
    }),
    journalSizeLimit: database.pragma("journal_size_limit", {
      simple: true,
    }),
    trustedSchema: database.pragma("trusted_schema", {
      simple: true,
    }),
  };

  for (const [pragmaName, requiredValue] of Object.entries(
    REQUIRED_PRAGMAS
  )) {
    if (actualPragmas[pragmaName] !== requiredValue) {
      throw connectionError(
        "DATABASE_PRAGMA_MISMATCH",
        `Required SQLite PRAGMA ${pragmaName} was not established.`
      );
    }
  }

  const { version: sqliteVersion } = database
    .prepare("SELECT sqlite_version() AS version")
    .get();

  if (
    typeof sqliteVersion !== "string" ||
    compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0
  ) {
    throw connectionError(
      "DATABASE_SQLITE_VERSION_UNSUPPORTED",
      `SQLite ${MINIMUM_SQLITE_VERSION} or newer is required.`
    );
  }

  database.exec(
    "CREATE TEMP TABLE __hundo_strict_capability (value INTEGER) STRICT;"
  );
  database.exec("DROP TABLE temp.__hundo_strict_capability;");

  const readiness = database.prepare("SELECT 1 AS ready").get();
  if (readiness?.ready !== 1) {
    throw connectionError(
      "DATABASE_READINESS_FAILED",
      "SQLite readiness query failed."
    );
  }

  return {
    pragmas: actualPragmas,
    sqliteVersion,
  };
}

function openDatabase(options = {}) {
  const databasePath = resolveDatabasePath(options);
  let database;

  try {
    database = new Database(databasePath, {
      timeout: REQUIRED_PRAGMAS.busyTimeout,
    });
    const configuration = configureDatabase(database);

    return {
      database,
      databasePath,
      ...configuration,
    };
  } catch (error) {
    if (database?.open) {
      try {
        database.close();
      } catch {
        // Preserve the connection or configuration failure.
      }
    }

    if (error instanceof DatabaseConnectionError) {
      throw error;
    }

    throw connectionError(
      "DATABASE_OPEN_FAILED",
      "SQLite database connection could not be established.",
      error
    );
  }
}

function openReadonlyDatabase({ databasePath } = {}) {
  if (
    typeof databasePath !== "string" ||
    databasePath.trim() === "" ||
    !path.isAbsolute(databasePath.trim()) ||
    !fs.existsSync(databasePath.trim())
  ) {
    throw connectionError(
      "DATABASE_PATH_REQUIRED",
      "An existing absolute database path is required."
    );
  }
  try {
    return new Database(path.resolve(databasePath.trim()), {
      readonly: true,
      fileMustExist: true,
      timeout: REQUIRED_PRAGMAS.busyTimeout,
    });
  } catch (error) {
    throw connectionError(
      "DATABASE_OPEN_FAILED",
      "The read-only SQLite database could not be opened.",
      error
    );
  }
}

module.exports = {
  DatabaseConnectionError,
  MINIMUM_SQLITE_VERSION,
  REQUIRED_PRAGMAS,
  compareVersions,
  configureDatabase,
  openDatabase,
  openReadonlyDatabase,
  resolveDatabasePath,
};
