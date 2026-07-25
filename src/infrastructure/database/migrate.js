const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILE_PATTERN =
  /^(?<id>\d{4})_(?<name>[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const FOREIGN_KEY_REBUILD_DIRECTIVE =
  "-- hundo-leago: foreign-key-rebuild\n";

const MIGRATION_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id INTEGER PRIMARY KEY
      CHECK (migration_id > 0),
    file_name TEXT NOT NULL UNIQUE
      CHECK (length(file_name) > 9),
    checksum TEXT NOT NULL
      CHECK (
        length(checksum) = 64
        AND checksum NOT GLOB '*[^0-9a-f]*'
      ),
    application_build_id TEXT NOT NULL
      CHECK (length(application_build_id) > 0),
    started_at_ms INTEGER NOT NULL
      CHECK (started_at_ms >= 0),
    applied_at_ms INTEGER NOT NULL
      CHECK (applied_at_ms >= started_at_ms),
    duration_ms INTEGER NOT NULL
      CHECK (duration_ms >= 0)
  ) STRICT;
`;

class MigrationError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
    this.details = details;
  }
}

function migrationError(code, message, details, cause) {
  return new MigrationError(
    code,
    message,
    details,
    cause === undefined ? {} : { cause }
  );
}

function checksumBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function discoverMigrations({ migrationsDirectory } = {}) {
  if (
    typeof migrationsDirectory !== "string" ||
    migrationsDirectory.trim() === ""
  ) {
    throw migrationError(
      "MIGRATION_DIRECTORY_REQUIRED",
      "An explicit migrations directory is required."
    );
  }

  const resolvedDirectory = path.resolve(migrationsDirectory);
  let entries;
  try {
    entries = fs.readdirSync(resolvedDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    throw migrationError(
      "MIGRATION_DIRECTORY_UNREADABLE",
      "The migrations directory could not be read.",
      {},
      error
    );
  }

  const migrations = [];
  const seenIds = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;

    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw migrationError(
        "MIGRATION_FILE_NAME_INVALID",
        "Migration SQL files require a four-digit ID and canonical name.",
        { fileName: entry.name }
      );
    }

    const migrationId = Number(match.groups.id);
    if (migrationId < 1 || seenIds.has(migrationId)) {
      throw migrationError(
        "MIGRATION_ID_INVALID",
        "Migration IDs must be unique positive integers.",
        { fileName: entry.name, migrationId }
      );
    }
    seenIds.add(migrationId);

    const filePath = path.join(resolvedDirectory, entry.name);
    const bytes = fs.readFileSync(filePath);
    migrations.push({
      id: migrationId,
      fileName: entry.name,
      filePath,
      checksum: checksumBytes(bytes),
      sql: bytes.toString("utf8"),
    });
  }

  migrations.sort((left, right) => left.id - right.id);
  return migrations;
}

function hasMigrationLedger(database) {
  return (
    database
      .prepare(`
        SELECT 1 AS present
        FROM sqlite_schema
        WHERE type = 'table' AND name = 'schema_migrations'
      `)
      .get()?.present === 1
  );
}

function ensureMigrationLedger(database) {
  database.exec(MIGRATION_LEDGER_SQL);
}

function readAppliedMigrations(database) {
  if (!hasMigrationLedger(database)) return [];

  return database
    .prepare(`
      SELECT
        migration_id AS id,
        file_name AS fileName,
        checksum,
        application_build_id AS applicationBuildId,
        started_at_ms AS startedAtMs,
        applied_at_ms AS appliedAtMs,
        duration_ms AS durationMs
      FROM schema_migrations
      ORDER BY migration_id
    `)
    .all();
}

function inspectMigrationState(database, migrations) {
  const applied = readAppliedMigrations(database);
  const userVersion = database.pragma("user_version", {
    simple: true,
  });
  const latestAppliedId = applied.at(-1)?.id || 0;

  if (userVersion !== latestAppliedId) {
    throw migrationError(
      "MIGRATION_USER_VERSION_MISMATCH",
      "PRAGMA user_version does not match the migration ledger.",
      { latestAppliedId, userVersion }
    );
  }

  if (applied.length > migrations.length) {
    throw migrationError(
      "MIGRATION_DATABASE_AHEAD",
      "The database contains migrations unavailable to this application.",
      {
        appliedCount: applied.length,
        availableCount: migrations.length,
      }
    );
  }

  for (let index = 0; index < applied.length; index += 1) {
    const appliedMigration = applied[index];
    const sourceMigration = migrations[index];

    if (!sourceMigration || sourceMigration.id !== appliedMigration.id) {
      throw migrationError(
        "MIGRATION_DATABASE_AHEAD",
        "The database migration sequence is unavailable to this application.",
        {
          migrationId: appliedMigration.id,
          sourceMigrationId: sourceMigration?.id,
        }
      );
    }

    if (sourceMigration.fileName !== appliedMigration.fileName) {
      throw migrationError(
        "MIGRATION_FILE_NAME_MISMATCH",
        "An applied migration file name has changed.",
        {
          migrationId: appliedMigration.id,
          appliedFileName: appliedMigration.fileName,
          sourceFileName: sourceMigration.fileName,
        }
      );
    }

    if (sourceMigration.checksum !== appliedMigration.checksum) {
      throw migrationError(
        "MIGRATION_CHECKSUM_MISMATCH",
        "An applied migration checksum has changed.",
        {
          migrationId: appliedMigration.id,
          fileName: appliedMigration.fileName,
        }
      );
    }
  }

  const pending = migrations.slice(applied.length);
  return {
    status: pending.length === 0 ? "exact" : "behind",
    applied,
    pending,
    userVersion,
  };
}

function assertMigrationCompatibility(database, migrations) {
  const state = inspectMigrationState(database, migrations);
  if (state.status !== "exact") {
    throw migrationError(
      "MIGRATION_DATABASE_BEHIND",
      "The database requires explicit migration before use.",
      {
        pendingMigrationIds: state.pending.map(
          (migration) => migration.id
        ),
      }
    );
  }
  return state;
}

function assertApplicationBuildId(applicationBuildId) {
  if (
    typeof applicationBuildId !== "string" ||
    applicationBuildId.trim() === ""
  ) {
    throw migrationError(
      "MIGRATION_BUILD_ID_REQUIRED",
      "An application build identifier is required."
    );
  }
  return applicationBuildId.trim();
}

function applyOneMigration({
  database,
  migration,
  applicationBuildId,
  now,
}) {
  const startedAtMs = now();
  const requiresForeignKeyRebuild =
    migration.sql.startsWith(
      FOREIGN_KEY_REBUILD_DIRECTIVE
    );
  let foreignKeysSuspended = false;
  let caughtError = null;

  try {
    if (requiresForeignKeyRebuild) {
      database.pragma("foreign_keys = OFF");
      if (
        database.pragma("foreign_keys", {
          simple: true,
        }) !== 0
      ) {
        throw new Error(
          "Foreign-key enforcement could not be suspended for the declared rebuild."
        );
      }
      foreignKeysSuspended = true;
    }
    database.exec("BEGIN IMMEDIATE;");
    database.exec(migration.sql);
    if (
      requiresForeignKeyRebuild &&
      database.pragma("foreign_key_check").length > 0
    ) {
      throw new Error(
        "The declared rebuild produced a foreign-key violation."
      );
    }
    const appliedAtMs = now();
    const durationMs = Math.max(0, appliedAtMs - startedAtMs);

    database
      .prepare(`
        INSERT INTO schema_migrations (
          migration_id,
          file_name,
          checksum,
          application_build_id,
          started_at_ms,
          applied_at_ms,
          duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        migration.id,
        migration.fileName,
        migration.checksum,
        applicationBuildId,
        startedAtMs,
        appliedAtMs,
        durationMs
      );
    database.pragma(`user_version = ${migration.id}`);
    database.exec("COMMIT;");
  } catch (error) {
    caughtError = error;
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Preserve the original migration failure.
      }
    }
  } finally {
    if (foreignKeysSuspended) {
      try {
        database.pragma("foreign_keys = ON");
        if (
          database.pragma("foreign_keys", {
            simple: true,
          }) !== 1
        ) {
          throw new Error(
            "Foreign-key enforcement was not restored."
          );
        }
      } catch (error) {
        caughtError ||= error;
      }
    }
  }

  if (caughtError) {
    throw migrationError(
      "MIGRATION_APPLY_FAILED",
      "A migration failed and was rolled back.",
      {
        migrationId: migration.id,
        fileName: migration.fileName,
      },
      caughtError
    );
  }
}

function applyMigrations({
  database,
  migrations,
  applicationBuildId,
  now = Date.now,
}) {
  const buildId = assertApplicationBuildId(applicationBuildId);
  ensureMigrationLedger(database);
  const initialState = inspectMigrationState(database, migrations);

  for (const migration of initialState.pending) {
    applyOneMigration({
      database,
      migration,
      applicationBuildId: buildId,
      now,
    });
  }

  return assertMigrationCompatibility(database, migrations);
}

function migrateDatabase({
  database,
  migrationsDirectory,
  applicationBuildId,
  now = Date.now,
}) {
  const migrations = discoverMigrations({ migrationsDirectory });
  const state = applyMigrations({
    database,
    migrations,
    applicationBuildId,
    now,
  });

  return {
    ...state,
    migrations,
  };
}

module.exports = {
  FOREIGN_KEY_REBUILD_DIRECTIVE,
  MIGRATION_FILE_PATTERN,
  MIGRATION_LEDGER_SQL,
  MigrationError,
  applyMigrations,
  assertMigrationCompatibility,
  checksumBytes,
  discoverMigrations,
  ensureMigrationLedger,
  hasMigrationLedger,
  inspectMigrationState,
  migrateDatabase,
  readAppliedMigrations,
};
