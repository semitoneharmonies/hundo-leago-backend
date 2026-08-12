const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  compressAndEncryptBackup,
} = require("../../infrastructure/backups/backupArtifactCrypto");
const {
  APPROVED_REASONS,
  BACKUP_FILE_NAME,
  createVerifiedBackup,
} = require("../../infrastructure/database/sqliteBackup");
const {
  canonicalize,
} = require("../../infrastructure/migration/sourceInventory");

const FORMAT_VERSION = 2;
const RETENTION_CLASSES = Object.freeze([
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "pre-change",
  "season-end",
  "incident-preservation",
]);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class EncryptedBackupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EncryptedBackupError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new EncryptedBackupError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function migrationChecksumSetId(migrations) {
  return hashBuffer(Buffer.from(canonicalize(migrations)));
}

function backupTimestamp(timestampMs) {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    fail("BACKUP_INPUT_INVALID", "A safe backup timestamp is required.");
  }
  return new Date(timestampMs).toISOString().replace(/[-:.]/g, "");
}

function bounded(value, label, maximum = 128) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail("BACKUP_INPUT_INVALID", `A canonical ${label} is required.`);
  }
  return value;
}

function minimumRetentionExpiry(createdAtMs, retentionClass) {
  const durations = {
    hourly: 48 * 60 * 60 * 1000,
    daily: 14 * 24 * 60 * 60 * 1000,
    weekly: 8 * 7 * 24 * 60 * 60 * 1000,
    monthly: 365 * 24 * 60 * 60 * 1000,
    "pre-change": 90 * 24 * 60 * 60 * 1000,
  };
  const duration = durations[retentionClass];
  return duration === undefined
    ? null
    : new Date(createdAtMs + duration).toISOString();
}

function buildBackupAad(manifest) {
  const fields = {
    formatVersion: manifest.formatVersion,
    backupId: manifest.backupId,
    environment: manifest.environment,
    environmentId: manifest.environmentId,
    databaseId: manifest.databaseId,
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    backendBuildId: manifest.backendBuildId,
    schemaVersion: manifest.schemaVersion,
    migrationChecksumSetId: manifest.migrationChecksumSetId,
    encryptionAlgorithm: manifest.encryptionAlgorithm,
    encryptionKeyVersion: manifest.encryptionKeyVersion,
    storageObjectKey: manifest.storageObjectKey,
  };
  return Buffer.from(canonicalize(fields));
}

function calculateExternalManifestChecksum(manifest) {
  const payload = { ...manifest };
  delete payload.manifestChecksum;
  return hashBuffer(Buffer.from(canonicalize(payload)));
}

function assertDependencies(config, objectStorage) {
  if (
    !config ||
    !["staging", "production"].includes(config.appEnv) ||
    typeof config.environmentId !== "string" ||
    typeof config.databaseId !== "string" ||
    typeof config.persistentRoot !== "string" ||
    typeof config.localDirectory !== "string" ||
    !Buffer.isBuffer(config.encryption?.key?.value) ||
    config.encryption.key.value.length !== 32 ||
    typeof config.encryption.keyVersion !== "string" ||
    typeof config.objectStorage?.prefix !== "string"
  ) {
    throw new TypeError("encrypted backup requires validated configuration");
  }
  for (const method of ["putPrivateObject", "headPrivateObject"]) {
    if (!objectStorage || typeof objectStorage[method] !== "function") {
      throw new TypeError("encrypted backup requires private object storage");
    }
  }
}

async function createEncryptedOffsiteBackup({
  databasePath,
  config,
  objectStorage,
  reason,
  requestedByType,
  requestedById,
  backendBuildId,
  retentionClass,
  expiresAt = null,
  nowMs = Date.now,
  createId = crypto.randomUUID,
  randomBytes = crypto.randomBytes,
} = {}) {
  assertDependencies(config, objectStorage);
  if (
    !APPROVED_REASONS.includes(reason) ||
    !RETENTION_CLASSES.includes(retentionClass) ||
    typeof nowMs !== "function" ||
    typeof createId !== "function"
  ) {
    fail("BACKUP_INPUT_INVALID", "Approved backup operation input is required.");
  }
  const backupId = createId();
  if (!UUID_PATTERN.test(backupId)) {
    fail("BACKUP_INPUT_INVALID", "A stable backup identifier is required.");
  }
  const createdAtMs = nowMs();
  const createdAt = new Date(createdAtMs).toISOString();
  const safeRequestedByType = bounded(requestedByType, "requester type", 64);
  const safeRequestedById = bounded(requestedById, "requester identity", 128);
  const safeBuildId = bounded(backendBuildId, "backend build identity", 128);
  const minimumExpiry = minimumRetentionExpiry(createdAtMs, retentionClass);
  if (
    (expiresAt !== null &&
      (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) ||
    (["season-end", "incident-preservation"].includes(retentionClass) &&
      expiresAt !== null) ||
    (minimumExpiry !== null &&
      expiresAt !== null &&
      Date.parse(expiresAt) < Date.parse(minimumExpiry))
  ) {
    fail("BACKUP_INPUT_INVALID", "Backup retention evidence is invalid.");
  }
  const effectiveExpiresAt = expiresAt || minimumExpiry;
  fs.mkdirSync(config.localDirectory, { recursive: true });
  const workDirectory = path.join(config.localDirectory, backupId);
  const verifiedDirectory = path.join(workDirectory, "verified");
  const baseName =
    `hundo-leago_${config.appEnv}_${backupTimestamp(createdAtMs)}_${backupId}`;
  const storageObjectKey = `${config.objectStorage.prefix}${baseName}.sqlite3.gz.enc`;
  const manifestObjectKey = `${config.objectStorage.prefix}${baseName}.manifest.json`;
  try {
    fs.mkdirSync(workDirectory, { recursive: false });
    const verified = await createVerifiedBackup({
      databasePath,
      outputDirectory: verifiedDirectory,
      environment: config.appEnv,
      reason,
      capturedAtMs: createdAtMs,
      temporaryRoot: config.persistentRoot,
    });
    const plaintextPath = path.join(verifiedDirectory, BACKUP_FILE_NAME);
    const plaintext = fs.readFileSync(plaintextPath);
    const internalManifest = JSON.parse(
      fs.readFileSync(path.join(verifiedDirectory, "backup-manifest.json"), "utf8")
    );
    const inspection = internalManifest.databaseInspection;
    if (
      inspection.databaseIdentity?.environmentId !== config.environmentId ||
      inspection.databaseIdentity?.databaseId !== config.databaseId
    ) {
      fail(
        "BACKUP_IDENTITY_MISMATCH",
        "The backup database identity does not match its environment."
      );
    }
    const aadManifest = {
      formatVersion: FORMAT_VERSION,
      backupId,
      environment: config.appEnv,
      environmentId: config.environmentId,
      databaseId: config.databaseId,
      createdAt,
      reason,
      backendBuildId: safeBuildId,
      schemaVersion: inspection.userVersion,
      migrationChecksumSetId: migrationChecksumSetId(inspection.migrations),
      encryptionAlgorithm: "AES-256-GCM",
      encryptionKeyVersion: config.encryption.keyVersion,
      storageObjectKey,
    };
    const aad = buildBackupAad(aadManifest);
    const encrypted = await compressAndEncryptBackup({
      plaintext,
      key: config.encryption.key.value,
      aad,
      randomBytes,
    });
    const encryptedArtifactSha256 = hashBuffer(encrypted.ciphertext);
    await objectStorage.putPrivateObject({
      objectKey: storageObjectKey,
      body: encrypted.ciphertext,
      contentType: "application/octet-stream",
      metadata: {
        sha256: encryptedArtifactSha256,
        "key-version": config.encryption.keyVersion,
      },
    });
    const remote = await objectStorage.headPrivateObject({
      objectKey: storageObjectKey,
    });
    if (
      remote?.byteSize !== encrypted.ciphertext.length ||
      remote?.sha256 !== encryptedArtifactSha256
    ) {
      fail(
        "BACKUP_REMOTE_VERIFICATION_FAILED",
        "The encrypted offsite object failed remote verification."
      );
    }
    const completedAt = new Date(nowMs()).toISOString();
    const manifestBase = {
      ...aadManifest,
      completedAt,
      requestedByType: safeRequestedByType,
      requestedById: safeRequestedById,
      sourceDatabaseSize: fs.statSync(databasePath).size,
      plainBackupSha256: verified.plaintextSha256,
      compressedSize: encrypted.compressedSize,
      encryptedSize: encrypted.ciphertext.length,
      encryptedArtifactSha256,
      encryptionIv: encrypted.iv.toString("base64url"),
      encryptionTag: encrypted.tag.toString("base64url"),
      aadSha256: hashBuffer(aad),
      manifestObjectKey,
      verificationResults: {
        integrity: inspection.integrity,
        foreignKeyViolationCount: inspection.foreignKeyViolationCount,
        remoteByteSizeMatched: true,
        remoteSha256Matched: true,
      },
      retentionClass,
      expiresAt: effectiveExpiresAt,
      keepIndefinitely: effectiveExpiresAt === null,
      databaseInspection: inspection,
    };
    const manifest = {
      ...manifestBase,
      manifestChecksum: calculateExternalManifestChecksum(manifestBase),
    };
    const manifestBytes = Buffer.from(`${canonicalize(manifest)}\n`);
    const manifestSha256 = hashBuffer(manifestBytes);
    await objectStorage.putPrivateObject({
      objectKey: manifestObjectKey,
      body: manifestBytes,
      contentType: "application/json",
      metadata: { sha256: manifestSha256, "backup-id": backupId },
    });
    const remoteManifest = await objectStorage.headPrivateObject({
      objectKey: manifestObjectKey,
    });
    if (
      remoteManifest?.byteSize !== manifestBytes.length ||
      remoteManifest?.sha256 !== manifestSha256
    ) {
      fail(
        "BACKUP_CATALOG_VERIFICATION_FAILED",
        "The external backup catalog failed remote verification."
      );
    }
    return Object.freeze({
      backupId,
      storageObjectKey,
      manifestObjectKey,
      encryptedArtifactSha256,
      manifestChecksum: manifest.manifestChecksum,
      status: "verified",
    });
  } catch (error) {
    if (error instanceof EncryptedBackupError) throw error;
    fail(
      "BACKUP_OFFSITE_OPERATION_FAILED",
      "The encrypted offsite backup failed safely.",
      error
    );
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  EncryptedBackupError,
  FORMAT_VERSION,
  RETENTION_CLASSES,
  buildBackupAad,
  calculateExternalManifestChecksum,
  createEncryptedOffsiteBackup,
  hashBuffer,
  migrationChecksumSetId,
  minimumRetentionExpiry,
};
