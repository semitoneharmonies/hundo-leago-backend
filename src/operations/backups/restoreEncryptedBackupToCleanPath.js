const fs = require("node:fs");
const path = require("node:path");

const {
  decryptAndDecompressBackup,
} = require("../../infrastructure/backups/backupArtifactCrypto");
const {
  inspectDatabase,
} = require("../../infrastructure/database/sqliteBackup");
const {
  canonicalize,
} = require("../../infrastructure/migration/sourceInventory");
const {
  FORMAT_VERSION,
  buildBackupAad,
  calculateExternalManifestChecksum,
  hashBuffer,
} = require("./createEncryptedOffsiteBackup");

class EncryptedRestoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EncryptedRestoreError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new EncryptedRestoreError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function pathEntryExists(entryPath) {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function newCleanPath(targetDatabasePath, temporaryRoot) {
  if (
    typeof targetDatabasePath !== "string" ||
    !path.isAbsolute(targetDatabasePath) ||
    typeof temporaryRoot !== "string" ||
    !path.isAbsolute(temporaryRoot)
  ) {
    fail("RESTORE_PATH_UNSAFE", "Absolute restore paths are required.");
  }
  const root = fs.realpathSync(temporaryRoot);
  const parent = fs.realpathSync(path.dirname(targetDatabasePath));
  const target = path.join(parent, path.basename(targetDatabasePath));
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    pathEntryExists(target) ||
    pathEntryExists(`${target}-wal`) ||
    pathEntryExists(`${target}-shm`)
  ) {
    fail(
      "RESTORE_PATH_UNSAFE",
      "The restore target must be a new path inside the temporary root."
    );
  }
  return target;
}

function readManifest(bytes) {
  let manifest;
  try {
    const raw = bytes.toString("utf8");
    manifest = JSON.parse(raw);
    if (
      raw !== `${canonicalize(manifest)}\n` ||
      manifest.formatVersion !== FORMAT_VERSION ||
      calculateExternalManifestChecksum(manifest) !== manifest.manifestChecksum
    ) {
      throw new Error("manifest mismatch");
    }
  } catch (error) {
    fail(
      "RESTORE_MANIFEST_INVALID",
      "The encrypted backup manifest failed verification.",
      error
    );
  }
  return manifest;
}

async function restoreEncryptedBackupToCleanPath({
  manifestObjectKey,
  objectStorage,
  keyResolver,
  expectedEnvironment,
  expectedEnvironmentId,
  expectedDatabaseId,
  targetDatabasePath,
  temporaryRoot,
} = {}) {
  for (const method of ["getPrivateObject", "headPrivateObject"]) {
    if (!objectStorage || typeof objectStorage[method] !== "function") {
      throw new TypeError("encrypted restore requires private object storage");
    }
  }
  if (typeof keyResolver !== "function") {
    throw new TypeError("encrypted restore requires a versioned key resolver");
  }
  const target = newCleanPath(targetDatabasePath, temporaryRoot);
  let targetDescriptor = null;
  let targetOwned = false;
  try {
    const manifestObject = await objectStorage.getPrivateObject({
      objectKey: manifestObjectKey,
    });
    const manifest = readManifest(manifestObject.body);
    if (
      manifest.manifestObjectKey !== manifestObjectKey ||
      manifest.environment !== expectedEnvironment ||
      manifest.environmentId !== expectedEnvironmentId ||
      manifest.databaseId !== expectedDatabaseId
    ) {
      fail(
        "RESTORE_IDENTITY_MISMATCH",
        "The backup does not match the requested restore environment."
      );
    }
    const remote = await objectStorage.headPrivateObject({
      objectKey: manifest.storageObjectKey,
    });
    if (
      remote?.byteSize !== manifest.encryptedSize ||
      remote?.sha256 !== manifest.encryptedArtifactSha256
    ) {
      fail(
        "RESTORE_REMOTE_VERIFICATION_FAILED",
        "The encrypted backup object failed remote verification."
      );
    }
    const artifact = await objectStorage.getPrivateObject({
      objectKey: manifest.storageObjectKey,
    });
    if (
      artifact.body.length !== manifest.encryptedSize ||
      hashBuffer(artifact.body) !== manifest.encryptedArtifactSha256
    ) {
      fail(
        "RESTORE_ENCRYPTED_CHECKSUM_MISMATCH",
        "The downloaded encrypted backup checksum does not match."
      );
    }
    const key = await keyResolver(manifest.encryptionKeyVersion);
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      fail(
        "RESTORE_KEY_UNAVAILABLE",
        "The required backup encryption key is unavailable."
      );
    }
    const aad = buildBackupAad(manifest);
    if (hashBuffer(aad) !== manifest.aadSha256) {
      fail(
        "RESTORE_MANIFEST_INVALID",
        "The backup authentication evidence does not match."
      );
    }
    let plaintext;
    try {
      plaintext = await decryptAndDecompressBackup({
        ciphertext: artifact.body,
        key,
        aad,
        iv: Buffer.from(manifest.encryptionIv, "base64url"),
        tag: Buffer.from(manifest.encryptionTag, "base64url"),
      });
    } catch (error) {
      fail(
        "RESTORE_AUTHENTICATION_FAILED",
        "The encrypted backup could not be authenticated.",
        error
      );
    }
    if (hashBuffer(plaintext) !== manifest.plainBackupSha256) {
      fail(
        "RESTORE_PLAINTEXT_CHECKSUM_MISMATCH",
        "The restored plaintext checksum does not match."
      );
    }
    targetDescriptor = fs.openSync(target, "wx", 0o600);
    targetOwned = true;
    fs.writeFileSync(targetDescriptor, plaintext);
    fs.fsyncSync(targetDescriptor);
    fs.closeSync(targetDescriptor);
    targetDescriptor = null;
    const inspection = inspectDatabase(target);
    if (
      canonicalize(inspection) !== canonicalize(manifest.databaseInspection) ||
      inspection.databaseIdentity.environmentId !== expectedEnvironmentId ||
      inspection.databaseIdentity.databaseId !== expectedDatabaseId
    ) {
      fail(
        "RESTORE_DATABASE_VERIFICATION_FAILED",
        "The clean restore database evidence does not match."
      );
    }
    return Object.freeze({
      backupId: manifest.backupId,
      targetDatabasePath: target,
      plaintextSha256: manifest.plainBackupSha256,
      inspection,
      status: "verified",
    });
  } catch (error) {
    const cleanupErrors = [];
    if (targetDescriptor !== null) {
      try {
        fs.closeSync(targetDescriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (targetOwned) {
      for (const ownedPath of [target, `${target}-wal`, `${target}-shm`]) {
        try {
          fs.rmSync(ownedPath, { force: true });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      fail(
        "RESTORE_CLEANUP_FAILED",
        "The encrypted clean restore could not clean its owned target.",
        new AggregateError([error, ...cleanupErrors])
      );
    }
    if (error instanceof EncryptedRestoreError) throw error;
    fail(
      "RESTORE_OFFSITE_OPERATION_FAILED",
      "The encrypted clean restore failed safely.",
      error
    );
  }
}

module.exports = {
  EncryptedRestoreError,
  readManifest,
  restoreEncryptedBackupToCleanPath,
};
