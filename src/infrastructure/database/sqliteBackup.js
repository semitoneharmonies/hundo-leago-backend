const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { canonicalize } = require("../migration/sourceInventory");
const { openReadonlyDatabase } = require("./connection");
const {
  DATABASE_IDENTITY_KEYS,
} = require("./databaseIdentity");

const BACKUP_MANIFEST_VERSION = 1;
const BACKUP_FILE_NAME = "database.sqlite3";
const BACKUP_MANIFEST_FILE_NAME = "backup-manifest.json";
const APPROVED_REASONS = Object.freeze([
  "scheduled-hourly",
  "scheduled-daily",
  "commissioner-request",
  "pre-deploy",
  "pre-migration",
  "pre-restore",
  "pre-reset",
  "pre-rollover",
  "pre-bulk-operation",
  "incident-preservation",
  "pre-cutover-rehearsal",
  "manual-platform-operation",
]);
const APPROVED_ENVIRONMENTS = Object.freeze([
  "test",
  "staging",
  "production",
]);
const BACKUP_ERROR_CODES = Object.freeze({
  argumentInvalid: "BACKUP_ARGUMENT_INVALID",
  pathUnsafe: "BACKUP_PATH_UNSAFE",
  verificationFailed: "BACKUP_VERIFICATION_FAILED",
  checksumMismatch: "BACKUP_CHECKSUM_MISMATCH",
  operationFailed: "BACKUP_OPERATION_FAILED",
});

class SqliteBackupError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SqliteBackupError";
    this.code = code;
  }
}

function backupError(code, message, options) {
  return new SqliteBackupError(code, message, options);
}

function hashFile(filePath) {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(filePath)).digest("hex");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function resolveNewTempPath(value, temporaryRoot, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw backupError(BACKUP_ERROR_CODES.argumentInvalid,
      `${name} must be an absolute path.`);
  }
  const root = fs.realpathSync(temporaryRoot);
  const parent = fs.realpathSync(path.dirname(value));
  const target = path.join(parent, path.basename(value));
  if (!isInside(root, target) || fs.existsSync(target)) {
    throw backupError(BACKUP_ERROR_CODES.pathUnsafe,
      `${name} must be a new path inside the temporary root.`);
  }
  return target;
}

function captureSidecarState(databasePath) {
  return Object.freeze({
    wal: fs.existsSync(`${databasePath}-wal`),
    shm: fs.existsSync(`${databasePath}-shm`),
  });
}

function removeNewEmptySidecars(databasePath, before) {
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  if (
    !before.wal &&
    fs.existsSync(walPath) &&
    fs.statSync(walPath).size !== 0
  ) {
    throw backupError(
      BACKUP_ERROR_CODES.verificationFailed,
      "A read-only verification unexpectedly created a nonempty WAL."
    );
  }
  if (!before.shm && fs.existsSync(shmPath)) {
    fs.rmSync(shmPath, { force: true });
  }
  if (!before.wal && fs.existsSync(walPath)) {
    fs.rmSync(walPath, { force: true });
  }
}

function inspectDatabase(databasePath) {
  const sidecarsBefore = captureSidecarState(databasePath);
  let database;
  let inspection;
  let operationError;
  try {
    database = openReadonlyDatabase({ databasePath });
    const integrity = database.pragma("integrity_check", {
      simple: true,
    });
    const foreignKeys = database.pragma("foreign_key_check");
    if (integrity !== "ok" || foreignKeys.length !== 0) {
      throw backupError(BACKUP_ERROR_CODES.verificationFailed,
        "SQLite integrity or foreign-key verification failed.");
    }
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(({ name }) => name);
    const rowCounts = Object.fromEntries(tables.map((tableName) => [
      tableName,
      database.prepare(
        `SELECT COUNT(*) AS count FROM "${tableName}"`
      ).get().count,
    ]));
    const migrations = tables.includes("schema_migrations")
      ? database.prepare(
        "SELECT migration_id AS id,file_name AS fileName,checksum " +
        "FROM schema_migrations ORDER BY migration_id"
      ).all()
      : [];
    const metadata = tables.includes("application_metadata")
      ? Object.fromEntries(
          database.prepare(
            "SELECT metadata_key, metadata_value FROM application_metadata " +
              "WHERE metadata_key IN (?, ?, ?) ORDER BY metadata_key"
          ).all(
            DATABASE_IDENTITY_KEYS.environmentId,
            DATABASE_IDENTITY_KEYS.databaseId,
            DATABASE_IDENTITY_KEYS.createdAt
          ).map(({ metadata_key: key, metadata_value: value }) => [key, value])
        )
      : {};
    inspection = Object.freeze({
      integrity,
      foreignKeyViolationCount: 0,
      userVersion: database.pragma("user_version", { simple: true }),
      rowCounts: Object.freeze(rowCounts),
      migrations: Object.freeze(migrations.map(Object.freeze)),
      databaseIdentity: Object.freeze({
        environmentId: metadata[DATABASE_IDENTITY_KEYS.environmentId] || null,
        databaseId: metadata[DATABASE_IDENTITY_KEYS.databaseId] || null,
        createdAt: metadata[DATABASE_IDENTITY_KEYS.createdAt] || null,
      }),
    });
  } catch (error) {
    operationError = error;
  } finally {
    if (database?.open) database.close();
  }
  try {
    removeNewEmptySidecars(databasePath, sidecarsBefore);
  } catch (error) {
    if (!operationError) operationError = error;
  }
  if (operationError) throw operationError;
  return inspection;
}

function calculateManifestChecksum(manifest) {
  const payload = { ...manifest };
  delete payload.manifestChecksum;
  return crypto.createHash("sha256")
    .update(canonicalize(payload)).digest("hex");
}

function readAndVerifyManifest(backupDirectory, environment) {
  const manifestPath = path.join(
    backupDirectory, BACKUP_MANIFEST_FILE_NAME
  );
  let raw;
  let manifest;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch (error) {
    throw backupError(BACKUP_ERROR_CODES.verificationFailed,
      "The backup manifest could not be read.", { cause: error });
  }
  if (raw !== `${canonicalize(manifest)}\n` ||
      manifest.manifestVersion !== BACKUP_MANIFEST_VERSION ||
      manifest.environment !== environment ||
      manifest.backupFileName !== BACKUP_FILE_NAME ||
      calculateManifestChecksum(manifest) !== manifest.manifestChecksum) {
    throw backupError(BACKUP_ERROR_CODES.verificationFailed,
      "The backup manifest failed canonical verification.");
  }
  const backupPath = path.join(backupDirectory, BACKUP_FILE_NAME);
  if (hashFile(backupPath) !== manifest.plaintextSha256) {
    throw backupError(BACKUP_ERROR_CODES.checksumMismatch,
      "The backup file checksum does not match.");
  }
  const inspection = inspectDatabase(backupPath);
  if (canonicalize(inspection) !==
      canonicalize(manifest.databaseInspection)) {
    throw backupError(BACKUP_ERROR_CODES.verificationFailed,
      "The backup database evidence does not match.");
  }
  return { manifest: Object.freeze(manifest), backupPath, inspection };
}

async function createVerifiedBackup({
  databasePath,
  outputDirectory,
  environment,
  reason,
  capturedAtMs,
  temporaryRoot = os.tmpdir(),
} = {}) {
  if (!APPROVED_ENVIRONMENTS.includes(environment) ||
      !APPROVED_REASONS.includes(reason) ||
      !Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0 ||
      typeof databasePath !== "string" ||
      !path.isAbsolute(databasePath) || !fs.existsSync(databasePath)) {
    throw backupError(BACKUP_ERROR_CODES.argumentInvalid,
      "An approved environment, reason, capture time, and existing database are required.");
  }
  const physicalRoot = fs.realpathSync(temporaryRoot);
  const physicalSource = fs.realpathSync(databasePath);
  if (!isInside(physicalRoot, physicalSource)) {
    throw backupError(BACKUP_ERROR_CODES.pathUnsafe,
      "The source database must be inside the approved root.");
  }
  const output = resolveNewTempPath(
    outputDirectory, temporaryRoot, "outputDirectory"
  );
  const temporary = `${output}.building-${crypto.randomUUID()}`;
  const sourceSidecarsBefore =
    captureSidecarState(physicalSource);
  let source;
  try {
    fs.mkdirSync(temporary);
    const backupPath = path.join(temporary, BACKUP_FILE_NAME);
    source = openReadonlyDatabase({ databasePath });
    await source.backup(backupPath);
    source.close();
    source = null;
    removeNewEmptySidecars(
      physicalSource,
      sourceSidecarsBefore
    );
    const inspection = inspectDatabase(backupPath);
    const plaintextSha256 = hashFile(backupPath);
    const baseManifest = {
      manifestVersion: BACKUP_MANIFEST_VERSION,
      backupId: `backup-v1-${plaintextSha256}`,
      environment,
      reason,
      capturedAtMs,
      backupFileName: BACKUP_FILE_NAME,
      byteSize: fs.statSync(backupPath).size,
      plaintextSha256,
      databaseInspection: inspection,
    };
    const manifest = {
      ...baseManifest,
      manifestChecksum: calculateManifestChecksum(baseManifest),
    };
    fs.writeFileSync(
      path.join(temporary, BACKUP_MANIFEST_FILE_NAME),
      `${canonicalize(manifest)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    readAndVerifyManifest(temporary, environment);
    fs.renameSync(temporary, output);
    return Object.freeze({
      backupId: manifest.backupId,
      outputDirectory: output,
      plaintextSha256,
      manifestChecksum: manifest.manifestChecksum,
    });
  } catch (error) {
    if (source?.open) source.close();
    try {
      removeNewEmptySidecars(
        physicalSource,
        sourceSidecarsBefore
      );
    } catch {
      // Preserve the original backup failure.
    }
    fs.rmSync(temporary, { recursive: true, force: true });
    if (error instanceof SqliteBackupError) throw error;
    throw backupError(BACKUP_ERROR_CODES.operationFailed,
      "The online SQLite backup failed safely.", { cause: error });
  }
}

function restoreBackupToCleanPath({
  backupDirectory,
  targetDatabasePath,
  environment,
  temporaryRoot = os.tmpdir(),
} = {}) {
  if (!APPROVED_ENVIRONMENTS.includes(environment) ||
      typeof backupDirectory !== "string" ||
      !path.isAbsolute(backupDirectory)) {
    throw backupError(BACKUP_ERROR_CODES.argumentInvalid,
      "An approved environment and absolute backup path are required.");
  }
  const root = fs.realpathSync(temporaryRoot);
  const physicalBackup = fs.realpathSync(backupDirectory);
  if (!isInside(root, physicalBackup)) {
    throw backupError(BACKUP_ERROR_CODES.pathUnsafe,
      "The backup must be inside the temporary root.");
  }
  const target = resolveNewTempPath(
    targetDatabasePath, temporaryRoot, "targetDatabasePath"
  );
  const verified = readAndVerifyManifest(
    physicalBackup, environment
  );
  try {
    fs.copyFileSync(
      verified.backupPath, target, fs.constants.COPYFILE_EXCL
    );
    if (hashFile(target) !== verified.manifest.plaintextSha256) {
      throw backupError(BACKUP_ERROR_CODES.checksumMismatch,
        "The restored copy checksum does not match.");
    }
    const inspection = inspectDatabase(target);
    if (canonicalize(inspection) !==
        canonicalize(verified.inspection)) {
      throw backupError(BACKUP_ERROR_CODES.verificationFailed,
        "The clean-path restore evidence does not match.");
    }
    return Object.freeze({
      backupId: verified.manifest.backupId,
      targetDatabasePath: target,
      plaintextSha256: verified.manifest.plaintextSha256,
      inspection,
    });
  } catch (error) {
    fs.rmSync(target, { force: true });
    if (error instanceof SqliteBackupError) throw error;
    throw backupError(BACKUP_ERROR_CODES.operationFailed,
      "The clean-path restore failed safely.", { cause: error });
  }
}

module.exports = {
  APPROVED_ENVIRONMENTS,
  APPROVED_REASONS,
  BACKUP_ERROR_CODES,
  BACKUP_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  SqliteBackupError,
  calculateManifestChecksum,
  createVerifiedBackup,
  inspectDatabase,
  restoreBackupToCleanPath,
};
