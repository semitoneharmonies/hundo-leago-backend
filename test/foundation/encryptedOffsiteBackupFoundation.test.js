const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadBackupConfig,
} = require("../../src/config/loadBackupConfig");
const {
  createObjectStorageAdapter,
} = require("../../src/infrastructure/backups/createObjectStorageAdapter");
const {
  DATABASE_IDENTITY_KEYS,
} = require("../../src/infrastructure/database/databaseIdentity");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createEncryptedOffsiteBackup,
} = require("../../src/operations/backups/createEncryptedOffsiteBackup");
const {
  restoreEncryptedBackupToCleanPath,
} = require("../../src/operations/backups/restoreEncryptedBackupToCleanPath");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "database", "migrations");
const BACKUP_ID = "00000000-0000-4000-8000-000000007001";
const ENVIRONMENT_ID = "staging-environment-v1";
const DATABASE_ID = "staging-database-v1";
const KEY = Buffer.alloc(32, 0x62);

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createStorage() {
  const objects = new Map();
  const calls = [];
  const adapter = createObjectStorageAdapter({
    client: {
      async putObject(input) {
        calls.push({ ...input, body: Buffer.from(input.body) });
        objects.set(input.key, {
          body: Buffer.from(input.body),
          metadata: { ...input.metadata },
          visibility: input.visibility,
        });
        return { stored: true };
      },
      async headObject({ key }) {
        const object = objects.get(key);
        if (!object) return null;
        return { byteSize: object.body.length, sha256: hash(object.body) };
      },
      async getObject({ key }) {
        const object = objects.get(key);
        if (!object) throw new Error("missing object");
        return { body: Buffer.from(object.body) };
      },
    },
  });
  return { adapter, calls, objects };
}

function runtime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m7-backup-"));
  const databaseDirectory = path.join(root, "database");
  const backupDirectory = path.join(root, "backup-staging");
  const restoreDirectory = path.join(root, "restore");
  fs.mkdirSync(databaseDirectory);
  fs.mkdirSync(restoreDirectory);
  const connection = openDatabase({
    databasePath: path.join(databaseDirectory, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS,
    applicationBuildId: "candidate-backup-test",
    now: () => 1,
  });
  const metadata = connection.database.prepare(
    "INSERT INTO application_metadata " +
      "(metadata_key, metadata_value, created_at_ms, updated_at_ms) " +
      "VALUES (?, ?, 1, 1)"
  );
  metadata.run(DATABASE_IDENTITY_KEYS.environmentId, ENVIRONMENT_ID);
  metadata.run(DATABASE_IDENTITY_KEYS.databaseId, DATABASE_ID);
  metadata.run(DATABASE_IDENTITY_KEYS.createdAt, "2026-07-22T12:00:00.000Z");
  connection.database.prepare(
    "INSERT INTO users (id, email_normalized, email_display, display_name, " +
      "display_name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(
    "00000000-0000-4000-8000-000000007010",
    "before@example.test",
    "before@example.test",
    "Before",
    "before"
  );
  const runtimeConfig = Object.freeze({
    appEnv: "staging",
    environmentId: ENVIRONMENT_ID,
    databaseId: DATABASE_ID,
    persistentRoot: root,
  });
  const config = loadBackupConfig({
    env: {
      BACKUP_LOCAL_DIR: backupDirectory,
      BACKUP_OBJECT_ENDPOINT: "https://objects.example.test",
      BACKUP_OBJECT_REGION: "ca-west-1",
      BACKUP_OBJECT_BUCKET: "hundo-staging-backups",
      BACKUP_OBJECT_PREFIX: "staging/database/",
      BACKUP_OBJECT_ACCESS_KEY_ID: "test-access",
      BACKUP_OBJECT_SECRET_ACCESS_KEY: "test-secret",
      BACKUP_ENCRYPTION_KEY_VERSION: "staging-v1",
      BACKUP_ENCRYPTION_KEY: KEY.toString("base64url"),
      BACKUP_SCHEDULE_ENABLED: "false",
    },
    runtimeConfig,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { config, connection, restoreDirectory, root };
}

async function createBackup(t) {
  const state = runtime(t);
  const storage = createStorage();
  const times = [
    Date.parse("2026-07-22T12:00:00.000Z"),
    Date.parse("2026-07-22T12:00:01.000Z"),
  ];
  const result = await createEncryptedOffsiteBackup({
    databasePath: state.connection.databasePath,
    config: state.config,
    objectStorage: storage.adapter,
    reason: "manual-platform-operation",
    requestedByType: "platform_administrator",
    requestedById: "00000000-0000-4000-8000-000000007020",
    backendBuildId: "candidate-backup-test",
    retentionClass: "daily",
    expiresAt: "2026-08-05T12:00:00.000Z",
    nowMs: () => times.shift(),
    createId: () => BACKUP_ID,
    randomBytes: () => Buffer.alloc(12, 0x45),
  });
  return { result, state, storage };
}

test("creates a verified private offsite artifact and restores its exact boundary", async (t) => {
  const { result, state, storage } = await createBackup(t);
  assert.equal(result.status, "verified");
  assert.equal(storage.objects.size, 2);
  assert.equal(storage.calls.every(({ visibility }) => visibility === "private"), true);
  assert.equal(fs.readdirSync(state.config.localDirectory).length, 0);
  const manifest = JSON.parse(
    storage.objects.get(result.manifestObjectKey).body.toString("utf8")
  );
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.environmentId, ENVIRONMENT_ID);
  assert.equal(manifest.databaseId, DATABASE_ID);
  assert.equal(manifest.encryptionAlgorithm, "AES-256-GCM");
  assert.equal(manifest.encryptionKeyVersion, "staging-v1");
  assert.equal(manifest.verificationResults.integrity, "ok");
  assert.equal(manifest.verificationResults.foreignKeyViolationCount, 0);
  assert.equal(manifest.keepIndefinitely, false);
  assert.equal(manifest.expiresAt, "2026-08-05T12:00:00.000Z");
  assert.equal(JSON.stringify(manifest).includes("test-secret"), false);
  assert.equal(JSON.stringify(manifest).includes(KEY.toString("base64url")), false);

  state.connection.database.prepare(
    "INSERT INTO users (id, email_normalized, email_display, display_name, " +
      "display_name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'active', 2, 2, 1)"
  ).run(
    "00000000-0000-4000-8000-000000007011",
    "after@example.test",
    "after@example.test",
    "After",
    "after"
  );
  const restored = await restoreEncryptedBackupToCleanPath({
    manifestObjectKey: result.manifestObjectKey,
    objectStorage: storage.adapter,
    keyResolver: async (version) => (version === "staging-v1" ? KEY : null),
    expectedEnvironment: "staging",
    expectedEnvironmentId: ENVIRONMENT_ID,
    expectedDatabaseId: DATABASE_ID,
    targetDatabasePath: path.join(state.restoreDirectory, "restored.sqlite3"),
    temporaryRoot: state.root,
  });
  assert.equal(restored.status, "verified");
  const restoredDatabase = openDatabase({
    databasePath: restored.targetDatabasePath,
    environment: "test",
  });
  assert.equal(restoredDatabase.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  restoredDatabase.database.close();
  assert.equal(state.connection.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 2);
});

test("wrong key, wrong environment, and encrypted corruption create no target", async (t) => {
  const { result, state, storage } = await createBackup(t);
  const attempt = async (name, overrides = {}) => {
    const target = path.join(state.restoreDirectory, `${name}.sqlite3`);
    await assert.rejects(
      restoreEncryptedBackupToCleanPath({
        manifestObjectKey: result.manifestObjectKey,
        objectStorage: storage.adapter,
        keyResolver: async () => KEY,
        expectedEnvironment: "staging",
        expectedEnvironmentId: ENVIRONMENT_ID,
        expectedDatabaseId: DATABASE_ID,
        targetDatabasePath: target,
        temporaryRoot: state.root,
        ...overrides,
      })
    );
    assert.equal(fs.existsSync(target), false);
  };
  await attempt("wrong-key", { keyResolver: async () => Buffer.alloc(32, 0x63) });
  await attempt("wrong-environment", { expectedEnvironment: "production" });
  const existing = path.join(state.restoreDirectory, "existing.sqlite3");
  fs.writeFileSync(existing, "preserve me");
  await assert.rejects(
    restoreEncryptedBackupToCleanPath({
      manifestObjectKey: result.manifestObjectKey,
      objectStorage: storage.adapter,
      keyResolver: async () => KEY,
      expectedEnvironment: "staging",
      expectedEnvironmentId: ENVIRONMENT_ID,
      expectedDatabaseId: DATABASE_ID,
      targetDatabasePath: existing,
      temporaryRoot: state.root,
    }),
    { code: "RESTORE_PATH_UNSAFE" }
  );
  assert.equal(fs.readFileSync(existing, "utf8"), "preserve me");
  const artifact = storage.objects.get(result.storageObjectKey);
  artifact.body[0] ^= 0xff;
  await attempt("corrupt");
});

test("remote checksum mismatch prevents verified catalog publication and cleans plaintext", async (t) => {
  const state = runtime(t);
  const storage = createStorage();
  storage.adapter = createObjectStorageAdapter({
    client: {
      async putObject(input) {
        storage.objects.set(input.key, { body: Buffer.from(input.body) });
      },
      async headObject({ key }) {
        const object = storage.objects.get(key);
        return { byteSize: object.body.length, sha256: "0".repeat(64) };
      },
      async getObject() {
        throw new Error("not used");
      },
    },
  });
  await assert.rejects(
    createEncryptedOffsiteBackup({
      databasePath: state.connection.databasePath,
      config: state.config,
      objectStorage: storage.adapter,
      reason: "pre-deploy",
      requestedByType: "platform_administrator",
      requestedById: "00000000-0000-4000-8000-000000007020",
      backendBuildId: "candidate-backup-test",
      retentionClass: "pre-change",
      expiresAt: "2026-10-20T12:00:00.000Z",
      nowMs: () => Date.parse("2026-07-22T12:00:00.000Z"),
      createId: () => BACKUP_ID,
    }),
    { code: "BACKUP_REMOTE_VERIFICATION_FAILED" }
  );
  assert.equal([...storage.objects.keys()].some((key) => key.endsWith(".manifest.json")), false);
  assert.equal(fs.readdirSync(state.config.localDirectory).length, 0);
});
