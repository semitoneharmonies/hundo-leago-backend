const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { createDailyCompanionBackupJob, restoreDailyCompanionBackupToCleanPath, APPLICATION_ID } = require("../../src/operations/backups/createDailyCompanionBackup");
const { calculateExternalManifestChecksum } = require("../../src/operations/backups/createEncryptedOffsiteBackup");
const { canonicalize } = require("../../src/infrastructure/migration/sourceInventory");

const HOUR = 3_600_000;
const digest = body => crypto.createHash("sha256").update(body).digest("hex");
function fixture(t, { daily = true, profiles = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-backup-test-"));
  const persistentRoot = path.join(root, "persistent"), scratch = path.join(root, "scratch");
  fs.mkdirSync(persistentRoot); fs.mkdirSync(scratch);
  const databasePath = path.join(persistentRoot, "main.sqlite3");
  const main = new Database(databasePath);
  main.exec("CREATE TABLE application_metadata(metadata_key TEXT PRIMARY KEY, metadata_value TEXT NOT NULL)");
  for (const [key, value] of [["environment_id", "test:daily-backup"], ["database_id", "daily-parent-database"], ["database_created_at", "2026-11-20T00:00:00.000Z"]]) main.prepare("INSERT INTO application_metadata VALUES (?,?)").run(key, value);
  main.close();
  const sidecar = databasePath + ".hundo-daily.sqlite3";
  let writer;
  function initialize() {
    writer = new Database(sidecar); writer.pragma("journal_mode=WAL");
    writer.exec(`CREATE TABLE slates(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE rooms(id TEXT PRIMARY KEY,slate_id TEXT REFERENCES slates(id),info TEXT NOT NULL,play TEXT NOT NULL);
      CREATE TABLE sent_reminders(room_id TEXT,user_id TEXT,starts_at INTEGER,PRIMARY KEY(room_id,user_id,starts_at));
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
    writer.prepare("INSERT INTO slates VALUES (?,?)").run("slate-a", '{"players":[{"id":"1"}]}');
    writer.prepare("INSERT INTO rooms VALUES (?,?,?,?)").run("room-a", "slate-a", '{"members":[{"id":"manager-a"}]}', '{"lots":[{"playerId":"1","bids":[{"userId":"manager-a","amount":7}]}]}');
    if (profiles) { writer.exec("CREATE TABLE daily_profiles(user_id TEXT PRIMARY KEY,appearance TEXT NOT NULL)"); writer.prepare("INSERT INTO daily_profiles VALUES (?,?)").run("manager-a", '{"patternTemplate":"even-two","primaryColour":"#123456","secondaryColour":"#abcdef","tertiaryColour":null}'); }
    return writer;
  }
  if (daily) initialize();
  const config = { appEnv: "staging", environmentId: "test:daily-backup", databaseId: "daily-parent-database", persistentRoot, objectStorage: { prefix: "staging/backups/" }, encryption: { algorithm: "AES-256-GCM", keyVersion: "fixture-v1", key: { value: crypto.randomBytes(32) } } };
  const objects = new Map(), calls = [], logs = [];
  let failGet = false, clock = Date.UTC(2026, 10, 20, 1, 3);
  const storage = {
    async putPrivateObject({ objectKey, body, ifAbsent, metadata }) {
      calls.push(["put", objectKey]); assert.equal(ifAbsent, true); assert.equal(metadata.sha256, digest(body));
      if (objects.has(objectKey)) { const error = new Error("already exists"); error.status = 412; throw error; }
      objects.set(objectKey, Buffer.from(body));
    },
    async headPrivateObject({ objectKey }) { calls.push(["head", objectKey]); const body = objects.get(objectKey); if (!body) { const error = new Error("not found"); error.status = 404; throw error; } return { byteSize: body.length, sha256: digest(body) }; },
    async getPrivateObject({ objectKey }) { calls.push(["get", objectKey]); if (failGet && objectKey.endsWith(".enc")) throw new Error("simulated storage failure with secret detail"); return { body: Buffer.from(objects.get(objectKey)) }; },
  };
  const jobs = [];
  function job(overrides = {}) {
    const value = createDailyCompanionBackupJob({ databasePath, config, objectStorage: storage, backendBuildId: "fixture-build", logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) }, temporaryRoot: scratch, nowMs: () => clock, ...overrides }); jobs.push(value); return value;
  }
  t.after(async () => { for (const value of jobs) await value.close(); if (writer?.open) writer.close(); assert.equal(fs.realpathSync(root), root); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, scratch, persistentRoot, databasePath, sidecar, config, storage, objects, calls, logs, job, initialize, writer: () => writer, advance: ms => { clock += ms; }, failGet: value => { failGet = value; } };
}

test("absent Daily store skips without creating files or writing to storage, then backs up its first write", async t => {
  const f = fixture(t, { daily: false }), job = f.job();
  assert.deepEqual(await job.run(), { status: "skipped", reason: "daily-absent" });
  assert.equal(fs.existsSync(f.sidecar), false); assert.deepEqual(fs.readdirSync(f.scratch), []); assert.equal(f.calls.length, 0);
  f.initialize(); assert.equal((await job.run()).status, "verified");
});

test("online WAL snapshot, private encryption, offsite GET and isolated restore retain rooms, bids and optional profiles", async t => {
  const f = fixture(t), mainBefore = fs.readFileSync(f.databasePath), walBefore = fs.readFileSync(f.sidecar + "-wal");
  const result = await f.job().run(); assert.equal(result.status, "verified");
  assert.ok(f.calls.some(([method, key]) => method === "get" && key.endsWith(".enc")));
  assert.deepEqual(fs.readFileSync(f.databasePath), mainBefore); assert.deepEqual(fs.readFileSync(f.sidecar + "-wal"), walBefore);
  assert.deepEqual(fs.readdirSync(f.scratch), []);
  const manifest = JSON.parse(f.objects.get(result.manifestObjectKey));
  assert.equal(manifest.backupKind, "hundo-daily-sidecar"); assert.equal(manifest.parentDatabaseId, f.config.databaseId); assert.equal(Object.hasOwn(manifest, "parentBackupId"), false);
  assert.equal(Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt), 48 * HOUR);
  assert.equal(f.objects.get(manifest.storageObjectKey).includes(Buffer.from("manager-a")), false);
  const target = path.join(f.scratch, "verified.sqlite3");
  const restored = await restoreDailyCompanionBackupToCleanPath({ manifestObjectKey: result.manifestObjectKey, config: f.config, objectStorage: f.storage, temporaryRoot: f.scratch, targetDatabasePath: target });
  assert.equal(restored.status, "verified"); assert.equal(restored.inspection.rowCounts.daily_profiles, 1); assert.equal(restored.inspection.foreignKeyViolationCount, 0);
  const db = new Database(target, { readonly: true });
  try { for (const table of ["rooms", "slates", "daily_profiles", "sent_reminders"]) assert.deepEqual(db.prepare("SELECT * FROM " + table).all(), f.writer().prepare("SELECT * FROM " + table).all()); } finally { db.close(); }
});

test("legacy Daily without profiles restores, and same-hour restarts validate the immutable receipt without another upload", async t => {
  const f = fixture(t, { profiles: false }), first = f.job();
  const result = await first.run(); assert.equal(result.status, "verified");
  const puts = f.calls.filter(([method]) => method === "put").length;
  assert.deepEqual(await first.run(), { status: "skipped", reason: "not-due" });
  const replay = await f.job().run(); assert.equal(replay.status, "verified"); assert.equal(replay.backupId, result.backupId);
  assert.equal(f.calls.filter(([method]) => method === "put").length, puts);
  f.advance(HOUR); assert.equal((await first.run()).status, "verified");
  assert.equal(f.calls.filter(([method]) => method === "put").length, puts + 3);
});

test("failed verification publishes no success receipt, logs no sensitive error, and retries safely", async t => {
  const f = fixture(t), job = f.job(); f.failGet(true);
  assert.deepEqual(await job.run(), { status: "failed", code: "DAILY_BACKUP_FAILED" });
  assert.equal([...f.objects.keys()].some(key => key.includes("/occurrences/")), false);
  assert.equal(JSON.stringify(f.logs).includes("secret"), false); assert.deepEqual(fs.readdirSync(f.scratch), []);
  f.failGet(false); assert.deepEqual(await job.run(), { status: "skipped", reason: "retry-wait" });
  f.advance(300_001); assert.equal((await job.run()).status, "verified");
});

test("wrong parent identity or Daily application type fails without uploading or changing source", async t => {
  const f = fixture(t), bytes = fs.readFileSync(f.databasePath);
  assert.equal((await f.job({ config: { ...f.config, databaseId: "different-parent" } }).run()).status, "failed");
  f.writer().pragma("application_id=123");
  assert.equal((await f.job().run()).status, "failed");
  assert.equal(f.calls.length, 0); assert.deepEqual(fs.readFileSync(f.databasePath), bytes);
});

test("isolated recovery rejects wrong identity, bad authentication, persistent and existing targets", async t => {
  const f = fixture(t), result = await f.job().run(), target = path.join(f.scratch, "recover.sqlite3");
  const base = { manifestObjectKey: result.manifestObjectKey, config: f.config, objectStorage: f.storage, temporaryRoot: f.scratch, targetDatabasePath: target };
  await assert.rejects(restoreDailyCompanionBackupToCleanPath({ ...base, config: { ...f.config, databaseId: "different-parent" } }));
  await assert.rejects(restoreDailyCompanionBackupToCleanPath({ ...base, targetDatabasePath: f.databasePath }));
  await assert.rejects(restoreDailyCompanionBackupToCleanPath({ ...base, temporaryRoot: f.persistentRoot, targetDatabasePath: path.join(f.persistentRoot, "new.sqlite3") }));
  fs.writeFileSync(target, "preserve this"); await assert.rejects(restoreDailyCompanionBackupToCleanPath(base)); assert.equal(fs.readFileSync(target, "utf8"), "preserve this"); fs.rmSync(target);
  const manifest = JSON.parse(f.objects.get(result.manifestObjectKey)), encrypted = f.objects.get(manifest.storageObjectKey);
  encrypted[0] ^= 1;
  await assert.rejects(restoreDailyCompanionBackupToCleanPath(base)); assert.equal(fs.existsSync(target), false);
  // Even rewritten transport checksums cannot authenticate modified ciphertext.
  manifest.encryptedArtifactSha256 = digest(encrypted);
  manifest.manifestChecksum = calculateExternalManifestChecksum(manifest);
  f.objects.set(result.manifestObjectKey, Buffer.from(canonicalize(manifest) + "\n"));
  await assert.rejects(restoreDailyCompanionBackupToCleanPath(base)); assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(f.scratch), []);
  f.objects.set(manifest.storageObjectKey, encrypted.subarray(0, encrypted.length - 1));
  await assert.rejects(restoreDailyCompanionBackupToCleanPath(base)); assert.equal(fs.existsSync(target), false);
});

test("another hour's receipt cannot satisfy this hour and corrupted receipt never reports verified", async t => {
  const f = fixture(t), result = await f.job().run();
  const receipt = JSON.parse(f.objects.get(result.receiptObjectKey)); receipt.parentDatabaseId = "different-parent";
  f.objects.set(result.receiptObjectKey, Buffer.from(JSON.stringify(receipt)));
  assert.equal((await f.job().run()).status, "failed");
  assert.equal(f.logs.filter(([event]) => event === "daily_backup.verified").length, 1);
  const next = { ...receipt, parentDatabaseId: f.config.databaseId, scheduledForMs: receipt.scheduledForMs + HOUR };
  delete next.receiptChecksum; next.receiptChecksum = digest(Buffer.from(canonicalize(next) + "\n"));
  f.objects.set(result.receiptObjectKey.replace(receipt.scheduledForMs + ".json", next.scheduledForMs + ".json"), Buffer.from(canonicalize(next) + "\n"));
  f.advance(HOUR); assert.equal((await f.job().run()).status, "failed");
  assert.equal(f.logs.filter(([event]) => event === "daily_backup.verified").length, 1);
});

test("overlap is suppressed, close awaits verification, and hourly startup is idempotent", async t => {
  const f = fixture(t); let release, entered; const blocked = new Promise(resolve => { entered = resolve; });
  const original = f.storage.putPrivateObject;
  f.storage.putPrivateObject = async input => { if (!release) { await new Promise(resolve => { release = resolve; entered(); }); } return original(input); };
  let timerCalls = 0, clearCalls = 0;
  const job = f.job({ setIntervalFunction: () => { timerCalls++; return { unref() {} }; }, clearIntervalFunction: () => { clearCalls++; } });
  const started = job.start(); assert.equal(job.start(), started); await blocked;
  assert.deepEqual(await job.run(), { status: "skipped", reason: "overlap" });
  let closed = false; const closing = job.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); release();
  assert.equal((await started.initialRun).status, "verified"); await closing;
  assert.equal(timerCalls, 1); assert.equal(clearCalls, 1); assert.deepEqual(await job.run(), { status: "skipped", reason: "closed" });
});
