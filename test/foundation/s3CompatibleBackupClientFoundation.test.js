const assert = require("node:assert/strict");
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
  createS3CompatibleClient,
} = require("../../src/infrastructure/backups/createS3CompatibleClient");
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
  parseDeployedArguments,
} = require("../../scripts/db-backup");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "database", "migrations");

test("signs private path-style PUT, HEAD, and GET without exposing the secret", async () => {
  const requests = [];
  const payload = Buffer.from("encrypted");
  const digest = require("node:crypto").createHash("sha256").update(payload).digest("hex");
  const client = createS3CompatibleClient({
    endpoint: "https://objects.example.test",
    region: "ca-west-1",
    bucket: "hundo-staging",
    accessKeyId: "access-id",
    secretAccessKey: "do-not-print-secret",
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async fetchImplementation(url, options) {
      requests.push({ url, options });
      if (options.method === "HEAD") {
        return {
          ok: true,
          headers: new Headers({
            "content-length": String(payload.length),
            "x-amz-meta-sha256": digest,
          }),
        };
      }
      if (options.method === "GET") {
        return { ok: true, arrayBuffer: async () => payload };
      }
      return { ok: true };
    },
  });
  await client.putObject({
    key: "staging/database/a b.enc",
    body: payload,
    contentType: "application/octet-stream",
    metadata: { sha256: digest },
    visibility: "private",
  });
  assert.deepEqual(
    await client.headObject({ key: "staging/database/a b.enc" }),
    { byteSize: payload.length, sha256: digest }
  );
  assert.deepEqual(
    (await client.getObject({ key: "staging/database/a b.enc" })).body,
    payload
  );
  assert.equal(requests[0].url.endsWith("/hundo-staging/staging/database/a%20b.enc"), true);
  assert.match(requests[0].options.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(
    requests.every(({ options }) => options.headers["accept-encoding"] === "identity"),
    true
  );
  assert.match(
    requests[0].options.headers.authorization,
    /SignedHeaders=accept-encoding;/
  );
  assert.equal(JSON.stringify(requests).includes("do-not-print-secret"), false);
  assert.equal(requests[0].options.headers["x-amz-acl"], undefined);
});

test("creates and remotely verifies an encrypted backup through the real signing client", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-s3-backup-client-"));
  const databaseDirectory = path.join(root, "database");
  const backupDirectory = path.join(root, "backup-staging");
  fs.mkdirSync(databaseDirectory);
  const connection = openDatabase({
    databasePath: path.join(databaseDirectory, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS,
    applicationBuildId: "s3-client-integration-test",
    now: () => 1,
  });
  const environmentId = "staging-s3-environment-v1";
  const databaseId = "staging-s3-database-v1";
  const insertMetadata = connection.database.prepare(
    "INSERT INTO application_metadata " +
      "(metadata_key, metadata_value, created_at_ms, updated_at_ms) " +
      "VALUES (?, ?, 1, 1)"
  );
  insertMetadata.run(DATABASE_IDENTITY_KEYS.environmentId, environmentId);
  insertMetadata.run(DATABASE_IDENTITY_KEYS.databaseId, databaseId);
  insertMetadata.run(
    DATABASE_IDENTITY_KEYS.createdAt,
    "2026-08-11T12:00:00.000Z"
  );
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const stored = new Map();
  const requests = [];
  const client = createS3CompatibleClient({
    endpoint: "https://objects.example.test",
    region: "auto",
    bucket: "hundo-staging",
    accessKeyId: "access-id",
    secretAccessKey: "do-not-print-secret",
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    async fetchImplementation(url, options) {
      requests.push({ url, options });
      if (options.method === "PUT") {
        stored.set(url, {
          body: Buffer.from(options.body),
          sha256: options.headers["x-amz-meta-sha256"],
        });
        return { ok: true };
      }
      if (options.method === "HEAD") {
        const object = stored.get(url);
        return {
          ok: object !== undefined,
          status: object === undefined ? 404 : 200,
          headers: new Headers({
            "content-length": String(object?.body.length || 0),
            "x-amz-meta-sha256": object?.sha256 || "",
          }),
        };
      }
      throw new Error(`Unexpected ${options.method} request.`);
    },
  });
  const config = loadBackupConfig({
    env: {
      BACKUP_LOCAL_DIR: backupDirectory,
      BACKUP_OBJECT_ENDPOINT: "https://objects.example.test",
      BACKUP_OBJECT_REGION: "auto",
      BACKUP_OBJECT_BUCKET: "hundo-staging",
      BACKUP_OBJECT_PREFIX: "hundo-leago/staging/",
      BACKUP_OBJECT_ACCESS_KEY_ID: "access-id",
      BACKUP_OBJECT_SECRET_ACCESS_KEY: "do-not-print-secret",
      BACKUP_ENCRYPTION_KEY_VERSION: "staging-v1",
      BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 0x71).toString("base64url"),
      BACKUP_SCHEDULE_ENABLED: "false",
    },
    runtimeConfig: {
      appEnv: "staging",
      environmentId,
      databaseId,
      persistentRoot: root,
    },
  });

  const result = await createEncryptedOffsiteBackup({
    databasePath: connection.databasePath,
    config,
    objectStorage: createObjectStorageAdapter({ client }),
    reason: "pre-reset",
    requestedByType: "platform_operation",
    requestedById: "deployment-cli",
    backendBuildId: "s3-client-integration-test",
    retentionClass: "pre-change",
  });

  assert.equal(result.status, "verified");
  assert.deepEqual(requests.map(({ options }) => options.method), [
    "PUT",
    "HEAD",
    "PUT",
    "HEAD",
  ]);
  assert.equal(
    requests[0].url.startsWith(
      "https://objects.example.test/hundo-staging/hundo-leago/staging/"
    ),
    true
  );
  assert.equal(
    requests[0].options.headers["x-amz-meta-key-version"],
    "staging-v1"
  );
  assert.equal(
    requests[2].options.headers["x-amz-meta-backup-id"],
    result.backupId
  );
  assert.equal(
    requests.filter(({ options }) => options.method === "HEAD").length,
    2
  );
  assert.equal(fs.readdirSync(backupDirectory).length, 0);
});

test("deployed backup arguments are explicit and have no force bypass", () => {
  assert.deepEqual(
    parseDeployedArguments([
      "--reason", "pre-deploy",
      "--requested-by-type", "platform_administrator",
      "--requested-by-id", "operator-id",
      "--retention-class", "pre-change",
      "--expires-at", "2026-10-20T12:00:00.000Z",
    ]),
    {
      reason: "pre-deploy",
      requestedByType: "platform_administrator",
      requestedById: "operator-id",
      retentionClass: "pre-change",
      expiresAt: "2026-10-20T12:00:00.000Z",
    }
  );
  assert.deepEqual(parseDeployedArguments(["--reason", "pre-deploy"]), {
    reason: "pre-deploy",
    requestedByType: "platform_operation",
    requestedById: "deployment-cli",
    retentionClass: "pre-change",
    expiresAt: null,
  });
  assert.throws(
    () => parseDeployedArguments(["--reason", "pre-deploy", "--force", "true"]),
    { code: "BACKUP_ARGUMENT_INVALID" }
  );
});
