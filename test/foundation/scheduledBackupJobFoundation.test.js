const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadBackupConfig } = require("../../src/config/loadBackupConfig");
const { createScheduledBackupJob, assertBackupDiskSpace } = require("../../src/operations/backups/createScheduledBackupJob");
const { createSqliteScheduledBackupRepository, LEASE_MS, RETRY_MS, INTERVALS, JOB_TYPE } = require("../../src/infrastructure/persistence/sqlite/SqliteScheduledBackupRepository");
const { createObjectStorageAdapter } = require("../../src/infrastructure/backups/createObjectStorageAdapter");
const { restoreEncryptedBackupToCleanPath } = require("../../src/operations/backups/restoreEncryptedBackupToCleanPath");
const { createReleaseQaRuntime } = require("../../src/operations/release/createReleaseQaRuntime");
const { FIXTURE_DATABASE_ID, FIXTURE_ENVIRONMENT_ID, canonicalize } = require("../../src/operations/release/releaseQaFixtureContract");
const { openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { selectBackupCadence } = require("../../src/bootstrap/createDeployedBackupJob");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function protectedRows(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('job_runs','backup_catalog') ORDER BY name")
    .all().map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all().map(canonicalize).sort()]));
}

async function fixture(t) {
  const source = await createReleaseQaRuntime({ frontendOrigin: "http://127.0.0.1:5173", leagueWriteMode: "closed", port: 0,
    migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), password: "Scheduled Backup Fixture Password 2026!" });
  t.after(() => source.close());
  const key = crypto.randomBytes(32);
  const config = loadBackupConfig({ env: {
    BACKUP_LOCAL_DIR: path.join(source.temporaryRoot, "backups"), BACKUP_OBJECT_ENDPOINT: "https://backup.invalid",
    BACKUP_OBJECT_REGION: "local-1", BACKUP_OBJECT_BUCKET: "private-backup-test", BACKUP_OBJECT_PREFIX: "scheduled/",
    BACKUP_OBJECT_ACCESS_KEY_ID: "fixture-access", BACKUP_OBJECT_SECRET_ACCESS_KEY: "fixture-private-secret",
    BACKUP_ENCRYPTION_KEY_VERSION: "fixture-v1", BACKUP_ENCRYPTION_KEY: key.toString("base64url"), BACKUP_SCHEDULE_ENABLED: "true",
  }, runtimeConfig: { appEnv: "staging", persistentRoot: source.temporaryRoot, environmentId: FIXTURE_ENVIRONMENT_ID, databaseId: FIXTURE_DATABASE_ID } });
  const state = { now: Date.now(), objects: new Map(), calls: [], logs: [], timers: [], failManifestHead: false, onPut: null };
  const objectStorage = createObjectStorageAdapter({ client: {
    async putObject(input) {
      assert.equal(input.visibility, "private");
      assert.equal(state.objects.has(input.key), false, "no existing object may be overwritten");
      state.calls.push(input.key); state.objects.set(input.key, Buffer.from(input.body));
      if (state.onPut) await state.onPut(input);
      return { stored: true };
    },
    async headObject({ key: objectKey }) {
      if (state.failManifestHead && objectKey.endsWith(".manifest.json")) throw new Error("fixture-private-secret");
      const body = state.objects.get(objectKey); return body ? { byteSize: body.length, sha256: hash(body) } : null;
    },
    async getObject({ key: objectKey }) { return { body: Buffer.from(state.objects.get(objectKey)) }; },
  } });
  const repository = createSqliteScheduledBackupRepository({ database: source.runtime.database, environmentId: config.environmentId, databaseId: config.databaseId });
  function job(extra = {}) {
    const value = createScheduledBackupJob({ databasePath: source.databasePath, config, repository, objectStorage,
      backendBuildId: "scheduled-backup-test", cadence: () => "daily", nowMs: () => state.now,
      logger: { info: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args) },
      setIntervalFunction(callback, intervalMs) { const timer = { callback, intervalMs, unref() {} }; state.timers.push(timer); return timer; },
      clearIntervalFunction(timer) { timer.cleared = true; }, ...extra });
    t.after(() => value.close());
    return value;
  }
  return { source, config, key, state, repository, objectStorage, job };
}

test("a real scheduled encrypted backup survives restart, restores both leagues, and preserves all application rows", async (t) => {
  const { source, config, key, state, objectStorage, job } = await fixture(t);
  const database = source.runtime.database;
  const before = protectedRows(database);
  const unrelatedJobs = database.prepare("SELECT * FROM job_runs ORDER BY id").all();
  const worker = job();
  const started = worker.start();
  assert.equal(worker.start(), started);
  assert.deepEqual(await worker.run(), { status: "skipped", reason: "overlap" });
  const result = await started.initialRun;
  assert.equal(result.status, "succeeded");
  assert.equal(state.objects.size, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM leagues").get().count, 2);
  assert.deepEqual(protectedRows(database), before);
  assert.deepEqual(database.prepare("SELECT * FROM job_runs WHERE job_type<>? ORDER BY id").all(JOB_TYPE), unrelatedJobs);
  const catalog = database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(result.backupId);
  assert.equal(catalog.status, "verified");
  const manifest = JSON.parse(state.objects.get(catalog.storage_reference));
  assert.equal(manifest.scheduledOccurrence.catalogCommitRequired, true);
  assert.equal(manifest.scheduledOccurrence.supersedesBackupId, null);
  assert.equal(manifest.retentionClass, "daily");
  const restored = await restoreEncryptedBackupToCleanPath({ manifestObjectKey: catalog.storage_reference, objectStorage,
    keyResolver: async () => key, expectedEnvironment: config.appEnv, expectedEnvironmentId: config.environmentId,
    expectedDatabaseId: config.databaseId, targetDatabasePath: path.join(source.temporaryRoot, "scheduled-restored.sqlite3"), temporaryRoot: source.temporaryRoot });
  const restoredDatabase = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
  try { assert.deepEqual(protectedRows(restoredDatabase), before); }
  finally { restoredDatabase.close(); }
  await worker.close();
  assert.equal(state.timers.every((timer) => timer.cleared), true);
  assert.deepEqual(await worker.run(), { status: "skipped", reason: "closed" });
  assert.deepEqual(await job().run(), { status: "skipped", reason: "not-due" });
  assert.equal(state.objects.size, 2);
  assert.equal(JSON.stringify(state.logs).includes("fixture-private-secret"), false);
  state.now += INTERVALS.daily;
  const lowDisk = await job({ fsModule: { statSync: fs.statSync, statfsSync: () => ({ bavail: 0n, bsize: 1024n }) } }).run();
  assert.deepEqual(lowDisk, { status: "failed", code: "BACKUP_DISK_SPACE_INSUFFICIENT" });
  assert.equal(state.objects.size, 2);
  assert.deepEqual(database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(result.backupId), catalog);
});

test("failed external verification preserves the prior backup and retries with an explicitly superseding ID", async (t) => {
  const { source, state, job } = await fixture(t);
  const worker = job();
  const first = await worker.run();
  assert.equal(first.status, "succeeded");
  const catalog = source.runtime.database.prepare("SELECT * FROM backup_catalog ORDER BY id").all();
  state.now += INTERVALS.daily;
  state.failManifestHead = true;
  assert.equal((await worker.run()).status, "failed");
  const incomplete = source.runtime.database.prepare("SELECT * FROM job_runs WHERE job_type=? AND status='failed'").get(JOB_TYPE);
  assert.ok(incomplete);
  assert.deepEqual(source.runtime.database.prepare("SELECT * FROM backup_catalog ORDER BY id").all(), catalog);
  assert.equal((await job().run()).reason, "not-due");
  state.now += RETRY_MS;
  state.failManifestHead = false;
  assert.equal((await job().run()).status, "succeeded");
  const completed = source.runtime.database.prepare("SELECT * FROM job_runs WHERE id=?").get(incomplete.id);
  const receipt = JSON.parse(completed.result_json);
  const manifest = JSON.parse(state.objects.get(receipt.manifestObjectKey));
  assert.equal(manifest.scheduledOccurrence.supersedesBackupId, JSON.parse(incomplete.result_json).backupId);
  assert.equal(source.runtime.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 2);
  assert.equal(state.objects.size, 6, "incomplete private objects are preserved, never overwritten or silently deleted");
  assert.equal(JSON.stringify(state.logs).includes("fixture-private-secret"), false);
  assert.deepEqual(fs.readdirSync(path.join(source.temporaryRoot, "backups")), []);
});

test("an expired worker stops after upload and cannot catalog or fail its replacement", async (t) => {
  const { source, state, repository, job } = await fixture(t);
  let replacement;
  state.onPut = async () => {
    state.now += LEASE_MS;
    replacement = repository.claim({ cadence: "daily", nowMs: state.now,
      runId: crypto.randomUUID(), backupId: crypto.randomUUID(), leaseToken: crypto.randomUUID(), leaseOwner: "replacement-worker" });
  };
  assert.equal((await job().run()).status, "failed");
  assert.equal(replacement.status, "claimed");
  const row = source.runtime.database.prepare("SELECT * FROM job_runs WHERE id=?").get(replacement.claim.runId);
  assert.equal(row.status, "leased");
  assert.equal(row.lease_owner, "replacement-worker");
  assert.equal(state.objects.size, 1);
  assert.equal(source.runtime.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 0);
});

test("disk headroom includes database, WAL, working copies and a margin", () => {
  const args = { databasePath: "fixture.sqlite3", persistentRoot: "fixture-root", fsModule: {
    statSync: (name) => ({ size: name.endsWith("-wal") ? 20n : 10n }),
    statfsSync: () => ({ bavail: 1n, bsize: 1024n }),
  } };
  assert.throws(() => assertBackupDiskSpace(args), { code: "BACKUP_DISK_SPACE_INSUFFICIENT" });
  assert.doesNotThrow(() => assertBackupDiskSpace({ ...args, fsModule: { ...args.fsModule, statfsSync: () => ({ bavail: 1024n * 1024n, bsize: 1024n }) } }));
});

test("staging stays daily while production active seasons and open transactions require hourly backups", () => {
  for (const leagueWriteMode of ["open", "closed"]) {
    for (const hasActiveSeason of [true, false]) {
      assert.equal(selectBackupCadence({ appEnv: "staging", leagueWriteMode, hasActiveSeason }), "daily");
    }
  }
  assert.equal(selectBackupCadence({ appEnv: "production", leagueWriteMode: "closed", hasActiveSeason: false }), "daily");
  assert.equal(selectBackupCadence({ appEnv: "production", leagueWriteMode: "closed", hasActiveSeason: true }), "hourly");
  assert.equal(selectBackupCadence({ appEnv: "production", leagueWriteMode: "open", hasActiveSeason: false }), "hourly");
  assert.throws(() => selectBackupCadence({ appEnv: "unknown", leagueWriteMode: "open", hasActiveSeason: false }), /explicit runtime state/);
});
