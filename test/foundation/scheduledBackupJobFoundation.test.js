const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadBackupConfig } = require("../../src/config/loadBackupConfig");
const { createScheduledBackupJob, assertBackupDiskSpace } = require("../../src/operations/backups/createScheduledBackupJob");
const { createSqliteScheduledBackupRepository, LEASE_MS, RETRY_MS, INTERVALS, JOB_TYPE } = require("../../src/infrastructure/persistence/sqlite/SqliteScheduledBackupRepository");
const { createObjectStorageAdapter } = require("../../src/infrastructure/backups/createObjectStorageAdapter");
const { restoreEncryptedBackupToCleanPath } = require("../../src/operations/backups/restoreEncryptedBackupToCleanPath");
const { createReleaseQaFixture } = require("../../src/operations/release/createReleaseQaFixture");
const { FIXTURE_DATABASE_ID, FIXTURE_ENVIRONMENT_ID, canonicalize } = require("../../src/operations/release/releaseQaFixtureContract");
const { openDatabase, openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { selectBackupCadence } = require("../../src/bootstrap/createDeployedBackupJob");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function protectedRows(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('job_runs','backup_catalog') ORDER BY name")
    .all().map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all().map(canonicalize).sort()]));
}

async function fixture(t, appEnv = "staging") {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-backup-fixture-"));
  const databasePath = path.join(temporaryRoot, "scheduled-release-qa.sqlite3");
  const migrationsDirectory = path.resolve(__dirname, "../../database/migrations");
  const fixtureMigrations = path.join(temporaryRoot, "fixture-migrations");
  let database;
  t.after(() => {
    if (database?.open) database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  fs.mkdirSync(fixtureMigrations);
  // Verify the two-league seed at its supported schema before upgrading the backup source.
  for (const name of fs.readdirSync(migrationsDirectory)) {
    if (/^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 95) {
      fs.copyFileSync(path.join(migrationsDirectory, name), path.join(fixtureMigrations, name));
    }
  }
  await createReleaseQaFixture({ databasePath, temporaryRoot, environment: "test", migrationsDirectory: fixtureMigrations,
    password: "Scheduled Backup Fixture Password 2026!" });
  database = openDatabase({ databasePath, environment: "test" }).database;
  migrateDatabase({ database, migrationsDirectory, applicationBuildId: "scheduled-backup-test" });
  const source = { databasePath, temporaryRoot, database };
  const key = crypto.randomBytes(32);
  const config = loadBackupConfig({ env: {
    BACKUP_LOCAL_DIR: path.join(source.temporaryRoot, "backups"), BACKUP_OBJECT_ENDPOINT: "https://backup.invalid",
    BACKUP_OBJECT_REGION: "local-1", BACKUP_OBJECT_BUCKET: "private-backup-test", BACKUP_OBJECT_PREFIX: "scheduled/",
    BACKUP_OBJECT_ACCESS_KEY_ID: "fixture-access", BACKUP_OBJECT_SECRET_ACCESS_KEY: "fixture-private-secret",
    BACKUP_ENCRYPTION_KEY_VERSION: "fixture-v1", BACKUP_ENCRYPTION_KEY: key.toString("base64url"), BACKUP_SCHEDULE_ENABLED: "true",
  }, runtimeConfig: { appEnv, persistentRoot: source.temporaryRoot, environmentId: FIXTURE_ENVIRONMENT_ID, databaseId: FIXTURE_DATABASE_ID } });
  const state = { now: Date.now(), objects: new Map(), calls: [], logs: [], timers: [], failManifestHead: false, onPut: null, onBeforePut: null };
  const objectStorage = createObjectStorageAdapter({ client: {
    async putObject(input) {
      assert.equal(input.visibility, "private");
      if (state.onBeforePut) await state.onBeforePut(input);
      if (input.ifNoneMatch === "*" && state.objects.has(input.key)) {
        const error = new Error("Existing immutable object"); error.code = "BACKUP_OBJECT_STORAGE_FAILED"; error.status = 412; throw error;
      }
      assert.equal(state.objects.has(input.key), false, "no existing object may be overwritten");
      state.calls.push(input.key); state.objects.set(input.key, Buffer.from(input.body));
      if (state.onPut) await state.onPut(input);
      return { stored: true };
    },
    async headObject({ key: objectKey }) {
      if (state.failManifestHead && objectKey.endsWith(".manifest.json")) throw new Error("fixture-private-secret");
      const body = state.objects.get(objectKey); return body ? { byteSize: body.length, sha256: hash(body) } : null;
    },
    async getObject({ key: objectKey }) {
      if (!state.objects.has(objectKey)) { const error = new Error("Missing object"); error.code = "BACKUP_OBJECT_STORAGE_FAILED"; error.status = 404; throw error; }
      return { body: Buffer.from(state.objects.get(objectKey)) };
    },
  } });
  const repository = createSqliteScheduledBackupRepository({ database: source.database, environmentId: config.environmentId, databaseId: config.databaseId });
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
  const database = source.database;
  const before = protectedRows(database);
  const unrelatedJobs = database.prepare("SELECT * FROM job_runs ORDER BY id").all();
  const worker = job();
  const started = worker.start();
  assert.equal(worker.start(), started);
  assert.deepEqual(await worker.run(), { status: "skipped", reason: "overlap" });
  const result = await started.initialRun;
  assert.equal(result.status, "succeeded");
  assert.equal(state.objects.size, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM leagues").get().count, 2);
  assert.deepEqual(protectedRows(database), before);
  assert.deepEqual(database.prepare("SELECT * FROM job_runs WHERE job_type<>? ORDER BY id").all(JOB_TYPE), unrelatedJobs);
  const catalog = database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(result.backupId);
  assert.equal(catalog.status, "verified");
  const manifest = JSON.parse(state.objects.get(catalog.storage_reference));
  assert.equal(manifest.scheduledOccurrence.completionReceiptRequired, true);
  const externalReceipt = JSON.parse(state.objects.get(manifest.scheduledOccurrence.completionObjectKey));
  assert.equal(externalReceipt.backupId, result.backupId);
  assert.equal(JSON.parse(catalog.metadata_json).occurrenceReceiptChecksum, externalReceipt.receiptChecksum);
  assert.equal(manifest.scheduledOccurrence.supersedesBackupId, null);
  assert.equal(manifest.retentionClass, "daily");
  assert.equal(Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt), 14 * INTERVALS.daily);
  assert.equal(path.posix.dirname(manifest.storageObjectKey), "scheduled");
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
  assert.equal(state.objects.size, 3);
  assert.equal(JSON.stringify(state.logs).includes("fixture-private-secret"), false);
  state.now += INTERVALS.daily;
  const lowDisk = await job({ fsModule: { statSync: fs.statSync, statfsSync: () => ({ bavail: 0n, bsize: 1024n }) } }).run();
  assert.deepEqual(lowDisk, { status: "failed", code: "BACKUP_DISK_SPACE_INSUFFICIENT" });
  assert.equal(state.objects.size, 3);
  assert.deepEqual(database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(result.backupId), catalog);
});

test("failed external verification preserves the prior backup and retries with an explicitly superseding ID", async (t) => {
  const { source, state, job } = await fixture(t);
  const worker = job();
  const first = await worker.run();
  assert.equal(first.status, "succeeded");
  const catalog = source.database.prepare("SELECT * FROM backup_catalog ORDER BY id").all();
  state.now += INTERVALS.daily;
  state.failManifestHead = true;
  assert.equal((await worker.run()).status, "failed");
  const incomplete = source.database.prepare("SELECT * FROM job_runs WHERE job_type=? AND status='failed'").get(JOB_TYPE);
  assert.ok(incomplete);
  assert.deepEqual(source.database.prepare("SELECT * FROM backup_catalog ORDER BY id").all(), catalog);
  assert.equal((await job().run()).reason, "not-due");
  state.now += RETRY_MS;
  state.failManifestHead = false;
  assert.equal((await job().run()).status, "succeeded");
  const completed = source.database.prepare("SELECT * FROM job_runs WHERE id=?").get(incomplete.id);
  const receipt = JSON.parse(completed.result_json);
  const manifest = JSON.parse(state.objects.get(receipt.manifestObjectKey));
  assert.equal(manifest.scheduledOccurrence.supersedesBackupId, JSON.parse(incomplete.result_json).backupId);
  assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 2);
  assert.equal(state.objects.size, 8, "incomplete private objects are preserved, never overwritten or silently deleted");
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
  const row = source.database.prepare("SELECT * FROM job_runs WHERE id=?").get(replacement.claim.runId);
  assert.equal(row.status, "leased");
  assert.equal(row.lease_owner, "replacement-worker");
  assert.equal(state.objects.size, 1);
  assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 0);
});

test("disk headroom includes database, WAL, working copies and a margin", () => {
  const args = { databasePath: "fixture.sqlite3", persistentRoot: "fixture-root", fsModule: {
    statSync: (name) => ({ size: name.endsWith("-wal") ? 20n : 10n }),
    statfsSync: () => ({ bavail: 1n, bsize: 1024n }),
  } };
  assert.throws(() => assertBackupDiskSpace(args), { code: "BACKUP_DISK_SPACE_INSUFFICIENT" });
  assert.doesNotThrow(() => assertBackupDiskSpace({ ...args, fsModule: { ...args.fsModule, statfsSync: () => ({ bavail: 1024n * 1024n, bsize: 1024n }) } }));
});

test("a lost completion response resumes the same external backup without another upload", async (t) => {
  const { source, state, job } = await fixture(t);
  const originalTime = state.now;
  state.onPut = async input => { if (input.key.includes("/occurrences/")) throw new Error("fixture-private-secret lost response"); };
  assert.equal((await job().run()).status, "failed");
  const pending = source.database.prepare("SELECT * FROM job_runs WHERE job_type=?").get(JOB_TYPE);
  const originalBackupId = JSON.parse(pending.result_json).backupId;
  assert.equal(pending.status, "failed");
  assert.equal(state.objects.size, 3);
  assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 0);
  const uploads = state.calls.length;
  state.onPut = null;
  state.now += RETRY_MS;
  const result = await job().run();
  assert.deepEqual(result, { status: "succeeded", backupId: originalBackupId });
  assert.equal(state.calls.length, uploads);
  const catalog = source.database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(originalBackupId);
  assert.equal(catalog.created_at_ms, originalTime);
  assert.equal(catalog.verified_at_ms, state.now);
  assert.equal(source.database.prepare("SELECT attempt_count FROM job_runs WHERE id=?").get(pending.id).attempt_count, 2);
  assert.equal(JSON.stringify(state.logs).includes("fixture-private-secret"), false);
});

test("a catalog transaction failure resumes the external completion instead of generating a second backup", async (t) => {
  const { source, state, job } = await fixture(t);
  source.database.exec("CREATE TEMP TRIGGER reject_catalog BEFORE INSERT ON backup_catalog BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.equal((await job().run()).status, "failed");
  const row = source.database.prepare("SELECT * FROM job_runs WHERE job_type=?").get(JOB_TYPE);
  assert.equal(row.status, "failed");
  assert.equal(state.objects.size, 3);
  assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 0);
  source.database.exec("DROP TRIGGER temp.reject_catalog");
  state.now += RETRY_MS;
  assert.deepEqual(await job().run(), { status: "succeeded", backupId: JSON.parse(row.result_json).backupId });
  assert.equal(state.objects.size, 3);
  assert.equal(state.calls.length, 3);
});

test("a late expired worker can win storage once and its replacement catalogs that same verified result", async (t) => {
  const { source, state, job } = await fixture(t);
  const before = protectedRows(source.database);
  let announceFirst;
  const reached = new Promise(resolve => { announceFirst = resolve; });
  let releaseFirst;
  const released = new Promise(resolve => { releaseFirst = resolve; });
  let receiptWrites = 0;
  let firstRun;
  state.onBeforePut = async input => {
    if (!input.key.includes("/occurrences/")) return;
    receiptWrites += 1;
    if (receiptWrites === 1) { announceFirst(); await released; }
    else { releaseFirst(); await firstRun; }
  };
  firstRun = job({ leaseOwner: "worker-a" }).run();
  try {
    await Promise.race([reached, firstRun.then(() => { throw new Error("First worker stopped before the receipt race"); })]);
    const first = source.database.prepare("SELECT * FROM job_runs WHERE job_type=?").get(JOB_TYPE);
    const winningId = JSON.parse(first.result_json).backupId;
    state.now += LEASE_MS;
    const second = await job({ leaseOwner: "worker-b" }).run();
    assert.equal((await firstRun).status, "failed");
    assert.deepEqual(second, { status: "succeeded", backupId: winningId });
    assert.equal(receiptWrites, 2);
    assert.equal(state.objects.size, 5, "two attempts retain their artifacts but only one completion record exists");
    const catalog = source.database.prepare("SELECT * FROM backup_catalog").all();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, winningId);
    const record = source.database.prepare("SELECT * FROM job_runs WHERE id=?").get(first.id);
    assert.equal(record.status, "succeeded");
    assert.equal(record.attempt_count, 2);
    assert.equal(JSON.parse(record.result_json).backupId, winningId);
    assert.deepEqual(protectedRows(source.database), before);
  } finally { releaseFirst(); await firstRun; }
});

test("tampered completion identity fails closed without uploading another candidate", async (t) => {
  const { source, state, job } = await fixture(t);
  state.onPut = async input => { if (input.key.includes("/occurrences/")) throw new Error("lost response"); };
  assert.equal((await job().run()).status, "failed");
  const receiptKey = [...state.objects.keys()].find(key => key.includes("/occurrences/"));
  const receipt = JSON.parse(state.objects.get(receiptKey));
  receipt.environmentId = "different-environment";
  const { receiptChecksum, ...body } = receipt;
  receipt.receiptChecksum = hash(canonicalize(body));
  state.objects.set(receiptKey, Buffer.from(`${canonicalize(receipt)}\n`));
  state.onPut = null;
  state.now += RETRY_MS;
  assert.equal((await job().run()).status, "failed");
  assert.equal(state.calls.length, 3);
  assert.equal(state.objects.size, 3);
  assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 0);
});

test("recovery authenticates the ciphertext even when altered storage checksums agree", async (t) => {
  const { source, state, job } = await fixture(t);
  state.onPut = async input => { if (input.key.includes("/occurrences/")) throw new Error("lost response"); };
  assert.equal((await job().run()).status, "failed");
  const originalObjects = new Map([...state.objects].map(([key, body]) => [key, Buffer.from(body)]));
  const receiptKey = [...state.objects.keys()].find(key => key.includes("/occurrences/"));
  const receipt = JSON.parse(state.objects.get(receiptKey));
  const manifest = JSON.parse(state.objects.get(receipt.manifestObjectKey));
  const damaged = Buffer.from(state.objects.get(manifest.storageObjectKey));
  damaged[0] ^= 1;
  state.objects.set(manifest.storageObjectKey, damaged);
  manifest.encryptedArtifactSha256 = hash(damaged);
  const { manifestChecksum, ...manifestBody } = manifest;
  manifest.manifestChecksum = hash(canonicalize(manifestBody));
  state.objects.set(receipt.manifestObjectKey, Buffer.from(`${canonicalize(manifest)}\n`));
  receipt.encryptedArtifactSha256 = manifest.encryptedArtifactSha256;
  receipt.manifestChecksum = manifest.manifestChecksum;
  const { receiptChecksum, ...receiptBody } = receipt;
  receipt.receiptChecksum = hash(canonicalize(receiptBody));
  state.objects.set(receiptKey, Buffer.from(`${canonicalize(receipt)}\n`));
  state.onPut = null;
  state.now += RETRY_MS;
  assert.equal((await job().run()).status, "failed");
  assert.equal(state.calls.length, 3);
  assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM backup_catalog").get().count, 0);
  state.objects = originalObjects;
  state.now += RETRY_MS;
  assert.deepEqual(await job().run(), { status: "succeeded", backupId: receipt.backupId });
  assert.equal(state.calls.length, 3);
});

test("a twice-weekly production backup restores from the 30-day payload prefix and leaves its metadata outside it", async (t) => {
  const { source, config, key, state, objectStorage, job } = await fixture(t, "production");
  const expectedRows = protectedRows(source.database);
  const cadence = () => selectBackupCadence({ appEnv: "production", leagueWriteMode: "open", hasActiveSeason: true });
  state.now = Date.parse("2026-11-13T15:00:00Z");
  const result = await job({ cadence }).run();
  assert.equal(result.status, "succeeded");
  const catalog = source.database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(result.backupId);
  const manifest = JSON.parse(state.objects.get(catalog.storage_reference));
  assert.equal(manifest.retentionClass, "twice-weekly");
  assert.equal(manifest.reason, "scheduled-twice-weekly");
  assert.equal(Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt), 30 * INTERVALS.daily);
  assert.equal(path.posix.dirname(manifest.storageObjectKey), "scheduled/routine-30d");
  assert.equal(path.posix.dirname(catalog.storage_reference), "scheduled");
  const receiptKey = manifest.scheduledOccurrence.completionObjectKey;
  assert.equal(path.posix.dirname(receiptKey), "scheduled/occurrences");
  assert.equal(JSON.parse(state.objects.get(receiptKey)).backupId, result.backupId);
  const restored = await restoreEncryptedBackupToCleanPath({
    manifestObjectKey: catalog.storage_reference, objectStorage, keyResolver: async () => key,
    expectedEnvironment: config.appEnv, expectedEnvironmentId: config.environmentId, expectedDatabaseId: config.databaseId,
    targetDatabasePath: path.join(source.temporaryRoot, "twice-weekly-restored.sqlite3"), temporaryRoot: source.temporaryRoot,
  });
  const restoredDatabase = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
  try { assert.deepEqual(protectedRows(restoredDatabase), expectedRows); }
  finally { restoredDatabase.close(); }
  state.now += INTERVALS.daily;
  assert.deepEqual(await job({ cadence }).run(), { status: "skipped", reason: "not-due" });
  assert.equal(state.objects.size, 3);
  assert.deepEqual(protectedRows(source.database), expectedRows);
});

test("staging stays daily while production uses the twice-weekly schedule in every season and write mode", () => {
  for (const leagueWriteMode of ["open", "closed"]) {
    for (const hasActiveSeason of [true, false]) {
      assert.equal(selectBackupCadence({ appEnv: "staging", leagueWriteMode, hasActiveSeason }), "daily");
      assert.equal(selectBackupCadence({ appEnv: "production", leagueWriteMode, hasActiveSeason }), "twice-weekly");
    }
  }
  assert.throws(() => selectBackupCadence({ appEnv: "unknown", leagueWriteMode: "open", hasActiveSeason: false }), /explicit runtime state/);
});
