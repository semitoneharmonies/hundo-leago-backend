const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  loadBackupConfig,
} = require("../../src/config/loadBackupConfig");
const {
  compressAndEncryptBackup,
  decryptAndDecompressBackup,
} = require("../../src/infrastructure/backups/backupArtifactCrypto");
const {
  createObjectStorageAdapter,
} = require("../../src/infrastructure/backups/createObjectStorageAdapter");

function environment(overrides = {}) {
  return {
    BACKUP_LOCAL_DIR: path.resolve(".backup-test", "staging"),
    BACKUP_OBJECT_ENDPOINT: "https://objects.example.test",
    BACKUP_OBJECT_REGION: "ca-west-1",
    BACKUP_OBJECT_BUCKET: "hundo-staging-backups",
    BACKUP_OBJECT_PREFIX: "staging/database/",
    BACKUP_OBJECT_ACCESS_KEY_ID: "staging-access-key",
    BACKUP_OBJECT_SECRET_ACCESS_KEY: "staging-secret-key",
    BACKUP_ENCRYPTION_KEY_VERSION: "staging-v1",
    BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 0x25).toString("base64url"),
    BACKUP_SCHEDULE_ENABLED: "false",
    ...overrides,
  };
}

function runtimeConfig() {
  return Object.freeze({
    appEnv: "staging",
    persistentRoot: path.resolve(".backup-test"),
    environmentId: "staging-environment-v1",
    databaseId: "staging-database-v1",
  });
}

test("loads exact backup configuration without serializing secrets", () => {
  const config = loadBackupConfig({ env: environment(), runtimeConfig: runtimeConfig() });
  assert.equal(config.encryption.key.value.length, 32);
  assert.equal(config.scheduleEnabled, false);
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes("staging-secret-key"), false);
  assert.equal(serialized.includes(environment().BACKUP_ENCRYPTION_KEY), false);
  for (const [field, value] of [
    ["BACKUP_LOCAL_DIR", path.resolve("outside")],
    ["BACKUP_OBJECT_ENDPOINT", "http://objects.example.test"],
    ["BACKUP_OBJECT_PREFIX", "/staging/"],
    ["BACKUP_ENCRYPTION_KEY", "short"],
    ["BACKUP_SCHEDULE_ENABLED", "TRUE"],
  ]) {
    assert.throws(
      () => loadBackupConfig({
        env: environment({ [field]: value }),
        runtimeConfig: runtimeConfig(),
      }),
      (error) => error.code === "BACKUP_CONFIG_INVALID" && error.field === field
    );
  }
});

test("compresses before authenticated encryption and rejects wrong evidence", async () => {
  const plaintext = Buffer.from("league-state\n".repeat(1000));
  const key = Buffer.alloc(32, 0x31);
  const aad = Buffer.from('{"backupId":"one"}');
  const encrypted = await compressAndEncryptBackup({
    plaintext,
    key,
    aad,
    randomBytes: () => Buffer.alloc(12, 0x44),
  });
  assert.equal(encrypted.iv.length, 12);
  assert.equal(encrypted.tag.length, 16);
  assert.ok(encrypted.compressedSize < plaintext.length);
  assert.deepEqual(
    await decryptAndDecompressBackup({ ...encrypted, key, aad }),
    plaintext
  );
  await assert.rejects(
    decryptAndDecompressBackup({
      ...encrypted,
      key: Buffer.alloc(32, 0x32),
      aad,
    })
  );
  await assert.rejects(
    decryptAndDecompressBackup({
      ...encrypted,
      key,
      aad: Buffer.from('{"backupId":"two"}'),
    })
  );
});

test("object adapter forces private writes and validates downloaded bytes", async () => {
  const calls = [];
  const adapter = createObjectStorageAdapter({
    client: {
      async putObject(input) {
        calls.push(input);
        return { stored: true };
      },
      async headObject({ key }) {
        return { key, byteSize: 3 };
      },
      async getObject({ key }) {
        return { key, body: Buffer.from("abc") };
      },
    },
  });
  await adapter.putPrivateObject({
    objectKey: "staging/database/one.enc",
    body: Buffer.from("abc"),
    contentType: "application/octet-stream",
    metadata: { sha256: "safe" },
  });
  assert.equal(calls[0].visibility, "private");
  assert.deepEqual(
    (await adapter.getPrivateObject({ objectKey: "staging/database/one.enc" })).body,
    Buffer.from("abc")
  );
  await assert.rejects(
    adapter.getPrivateObject({ objectKey: "../production/secret" }),
    /canonical private key/
  );
});
