const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadBackupConfig,
} = require("../../config/loadBackupConfig");
const {
  createObjectStorageAdapter,
} = require("../../infrastructure/backups/createObjectStorageAdapter");
const {
  createEncryptedOffsiteBackup,
} = require("../backups/createEncryptedOffsiteBackup");
const {
  restoreEncryptedBackupToCleanPath,
} = require("../backups/restoreEncryptedBackupToCleanPath");
const {
  FIXTURE_DATABASE_ID,
  canonicalize,
} = require("./releaseQaFixtureContract");
const {
  verifyReleaseQaFixture,
} = require("./verifyReleaseQaFixture");

const TEMP_ROOT_PREFIX = "hundo-m7-release-qa-";
const SOURCE_FILE_NAME = "m7-release-qa.sqlite3";

class ReleaseQaRecoveryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReleaseQaRecoveryError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ReleaseQaRecoveryError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeInput({ databasePath, fixtureManifestChecksum, temporaryRoot }) {
  if (
    !path.isAbsolute(databasePath || "") ||
    !path.isAbsolute(temporaryRoot || "") ||
    !/^[0-9a-f]{64}$/.test(fixtureManifestChecksum || "")
  ) {
    fail(
      "RELEASE_QA_RECOVERY_INPUT_INVALID",
      "Absolute release-QA paths and an exact fixture checksum are required."
    );
  }
  const systemTemp = fs.realpathSync(os.tmpdir());
  const physicalRoot = fs.realpathSync(temporaryRoot);
  const physicalDatabase = fs.realpathSync(databasePath);
  if (
    !isInside(systemTemp, physicalRoot) ||
    !path.basename(physicalRoot).startsWith(TEMP_ROOT_PREFIX) ||
    !isInside(physicalRoot, physicalDatabase) ||
    path.basename(physicalDatabase) !== SOURCE_FILE_NAME
  ) {
    fail(
      "RELEASE_QA_RECOVERY_PATH_UNSAFE",
      "Recovery rehearsal is restricted to its owned M7 release-QA database."
    );
  }
  return Object.freeze({ physicalDatabase, physicalRoot });
}

function createPrivateMemoryStorage() {
  const objects = new Map();
  const adapter = createObjectStorageAdapter({
    client: {
      async putObject(input) {
        if (input.visibility !== "private") {
          throw new Error("Release-QA backup objects must remain private.");
        }
        objects.set(input.key, Object.freeze({
          body: Buffer.from(input.body),
          metadata: Object.freeze({ ...input.metadata }),
        }));
        return Object.freeze({ stored: true });
      },
      async headObject({ key }) {
        const object = objects.get(key);
        if (!object) return null;
        return Object.freeze({
          byteSize: object.body.length,
          sha256: hash(object.body),
        });
      },
      async getObject({ key }) {
        const object = objects.get(key);
        if (!object) throw new Error("The release-QA backup object is missing.");
        return Object.freeze({ body: Buffer.from(object.body) });
      },
    },
  });
  return Object.freeze({ adapter, count: () => objects.size });
}

function backupConfiguration({ encryptionKey, physicalRoot, fixtureManifest }) {
  const localDirectory = path.join(physicalRoot, "recovery-rehearsal", "backup-work");
  return loadBackupConfig({
    env: {
      BACKUP_LOCAL_DIR: localDirectory,
      BACKUP_OBJECT_ENDPOINT: "https://release-qa.invalid",
      BACKUP_OBJECT_REGION: "local-1",
      BACKUP_OBJECT_BUCKET: "hundo-release-qa",
      BACKUP_OBJECT_PREFIX: "m7/recovery/",
      BACKUP_OBJECT_ACCESS_KEY_ID: "local-release-qa",
      BACKUP_OBJECT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString("base64url"),
      BACKUP_ENCRYPTION_KEY_VERSION: "m7-local-v1",
      BACKUP_ENCRYPTION_KEY: encryptionKey.toString("base64url"),
      BACKUP_SCHEDULE_ENABLED: "false",
    },
    runtimeConfig: {
      appEnv: "staging",
      persistentRoot: physicalRoot,
      environmentId: fixtureManifest.environmentId,
      databaseId: FIXTURE_DATABASE_ID,
    },
  });
}

async function rehearseReleaseQaRecovery({
  databasePath,
  fixtureManifestChecksum,
  temporaryRoot,
} = {}) {
  const { physicalDatabase, physicalRoot } = assertSafeInput({
    databasePath,
    fixtureManifestChecksum,
    temporaryRoot,
  });
  const rehearsalRoot = path.join(physicalRoot, "recovery-rehearsal");
  if (fs.existsSync(rehearsalRoot)) {
    fail(
      "RELEASE_QA_RECOVERY_PATH_UNSAFE",
      "The recovery rehearsal requires a new owned working path."
    );
  }
  const fixtureBefore = verifyReleaseQaFixture({ databasePath: physicalDatabase });
  if (fixtureBefore.manifestChecksum !== fixtureManifestChecksum) {
    fail(
      "RELEASE_QA_RECOVERY_FIXTURE_MISMATCH",
      "The release-QA source fixture does not match the requested rehearsal."
    );
  }
  const sourceSha256Before = hash(fs.readFileSync(physicalDatabase));
  const encryptionKey = crypto.randomBytes(32);
  const storage = createPrivateMemoryStorage();
  const restoreDirectory = path.join(rehearsalRoot, "restores");
  fs.mkdirSync(restoreDirectory, { recursive: true });
  const config = backupConfiguration({
    encryptionKey,
    physicalRoot,
    fixtureManifest: fixtureBefore,
  });
  try {
    const backup = await createEncryptedOffsiteBackup({
      databasePath: physicalDatabase,
      config,
      objectStorage: storage.adapter,
      reason: "pre-cutover-rehearsal",
      requestedByType: "release_qa_automation",
      requestedById: "m7-local-release-rehearsal",
      backendBuildId: "m7-local-backend",
      retentionClass: "incident-preservation",
    });
    const wrongKeyPath = path.join(restoreDirectory, "wrong-key.sqlite3");
    let wrongKeyRejected = false;
    try {
      await restoreEncryptedBackupToCleanPath({
        manifestObjectKey: backup.manifestObjectKey,
        objectStorage: storage.adapter,
        keyResolver: async () => Buffer.alloc(32, 0x7f),
        expectedEnvironment: config.appEnv,
        expectedEnvironmentId: config.environmentId,
        expectedDatabaseId: config.databaseId,
        targetDatabasePath: wrongKeyPath,
        temporaryRoot: physicalRoot,
      });
    } catch (error) {
      wrongKeyRejected = error?.code === "RESTORE_AUTHENTICATION_FAILED" &&
        !fs.existsSync(wrongKeyPath);
    }
    if (!wrongKeyRejected) {
      fail(
        "RELEASE_QA_RECOVERY_FAILURE_CONTROL_FAILED",
        "The wrong-key restore control did not fail closed."
      );
    }
    const restoredPath = path.join(restoreDirectory, "verified.sqlite3");
    const restored = await restoreEncryptedBackupToCleanPath({
      manifestObjectKey: backup.manifestObjectKey,
      objectStorage: storage.adapter,
      keyResolver: async (version) =>
        version === config.encryption.keyVersion ? encryptionKey : null,
      expectedEnvironment: config.appEnv,
      expectedEnvironmentId: config.environmentId,
      expectedDatabaseId: config.databaseId,
      targetDatabasePath: restoredPath,
      temporaryRoot: physicalRoot,
    });
    const fixtureAfterRestore = verifyReleaseQaFixture({
      databasePath: restored.targetDatabasePath,
    });
    const sourceSha256After = hash(fs.readFileSync(physicalDatabase));
    if (
      fixtureAfterRestore.manifestChecksum !== fixtureManifestChecksum ||
      sourceSha256After !== sourceSha256Before
    ) {
      fail(
        "RELEASE_QA_RECOVERY_VERIFICATION_FAILED",
        "The clean restore or source-preservation proof failed."
      );
    }
    const reportBase = Object.freeze({
      reportVersion: 1,
      backup: "encrypted-private-object-verified",
      cleanRestore: "verified-to-new-path",
      fixtureManifestChecksum,
      objectCount: storage.count(),
      sourceDatabase: "unchanged",
      wrongKeyRestore: "rejected-without-target",
    });
    return Object.freeze({
      ...reportBase,
      reportChecksum: hash(canonicalize(reportBase)),
    });
  } catch (error) {
    if (error instanceof ReleaseQaRecoveryError) throw error;
    fail(
      "RELEASE_QA_RECOVERY_FAILED",
      "The local release-QA recovery rehearsal failed safely.",
      error
    );
  } finally {
    fs.rmSync(rehearsalRoot, { recursive: true, force: true });
  }
}

module.exports = {
  ReleaseQaRecoveryError,
  rehearseReleaseQaRecovery,
};
