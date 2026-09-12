const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { RECOVERY_HOLD_KEY } = require("../../src/infrastructure/database/recoveryHold");
const { createSqliteScheduledBackupRepository, LEASE_MS, RETRY_MS, INTERVALS } = require("../../src/infrastructure/persistence/sqlite/SqliteScheduledBackupRepository");

const identity = { environmentId: "test:backup-scheduler", databaseId: "scheduled-backup-test" };
const now = 2 * INTERVALS.daily + 1000;
const claimInput = (nowMs = now, extras = {}) => ({ cadence: "daily", nowMs,
  runId: crypto.randomUUID(), backupId: crypto.randomUUID(), leaseToken: crypto.randomUUID(),
  leaseOwner: "worker-a", ...extras });
const evidence = (name = "first") => ({ plaintextSha256: "a".repeat(64), manifestChecksum: "b".repeat(64),
  encryptedArtifactSha256: "c".repeat(64), schemaVersion: 55, manifestObjectKey: `test/${name}.manifest.json`, encryptionKeyVersion: "v1" });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-scheduled-backup-"));
  const options = { databasePath: path.join(root, "source.sqlite3"), environment: "test" };
  const first = openDatabase(options);
  migrateDatabase({ database: first.database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
    applicationBuildId: "scheduled-backup-test", now: () => 1 });
  const insert = first.database.prepare("INSERT INTO application_metadata VALUES (?,?,1,1)");
  insert.run("environment_id", identity.environmentId);
  insert.run("database_id", identity.databaseId);
  insert.run("database_created_at", "2026-09-12T00:00:00.000Z");
  const second = openDatabase(options);
  t.after(() => { first.database.close(); second.database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repository = (database) => createSqliteScheduledBackupRepository({ database, ...identity });
  return { database: first.database, a: repository(first.database), b: repository(second.database), second: second.database };
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
const changes = (db) => db.prepare("SELECT total_changes() AS count").get().count;

test("competing connections lease one occurrence, atomically catalog it, and replay without writes", (t) => {
  const { a, b, database, second } = fixture(t);
  const result = a.claim(claimInput());
  assert.equal(result.status, "claimed");
  const before = changes(second);
  assert.deepEqual(b.claim(claimInput(now + 1, { leaseOwner: "worker-b" })), { status: "skipped", reason: "already-running" });
  assert.equal(changes(second), before);
  const complete = { claim: result.claim, nowMs: now + 2, evidence: evidence() };
  assert.equal(a.complete(complete).status, "succeeded");
  assert.equal(rows(database, "job_runs").length, 1);
  assert.equal(rows(database, "backup_catalog").length, 1);
  assert.equal(rows(database, "backup_catalog")[0].id, result.claim.backupId);
  const after = changes(second);
  assert.equal(b.complete({ ...complete, nowMs: now + 3 }).status, "replayed");
  assert.equal(changes(second), after);
  for (const field of ["schemaVersion", "encryptedArtifactSha256", "encryptionKeyVersion"]) {
    const value = field === "schemaVersion" ? 54 : field === "encryptedArtifactSha256" ? "d".repeat(64) : "v2";
    assert.throws(() => b.complete({ ...complete, evidence: { ...complete.evidence, [field]: value } }), { code: "BACKUP_JOB_LEASE_LOST" });
  }
  assert.equal(changes(second), after);
  assert.deepEqual(a.claim(claimInput(now + 4)), { status: "skipped", reason: "not-due" });
  assert.deepEqual(database.pragma("foreign_key_check"), []);
});

test("a restarted worker replaces an expired attempt and the old worker cannot complete or fail it", (t) => {
  const { a, b, database } = fixture(t);
  const old = a.claim(claimInput()).claim;
  const replacement = b.claim(claimInput(now + LEASE_MS, { leaseOwner: "worker-b" })).claim;
  assert.equal(replacement.runId, old.runId);
  assert.equal(replacement.supersedesBackupId, old.backupId);
  assert.notEqual(replacement.backupId, old.backupId);
  const snapshot = rows(database, "job_runs");
  for (const method of ["complete", "fail", "renew"]) {
    assert.throws(() => a[method]({ claim: old, nowMs: now + LEASE_MS + 1, evidence: evidence() }), { code: "BACKUP_JOB_LEASE_LOST" });
  }
  assert.deepEqual(rows(database, "job_runs"), snapshot);
  assert.equal(b.complete({ claim: replacement, nowMs: now + LEASE_MS + 2, evidence: evidence() }).status, "succeeded");
  assert.equal(rows(database, "backup_catalog")[0].id, replacement.backupId);
  assert.equal(rows(database, "job_runs")[0].attempt_count, 2);
});

test("renewal fences the previous token version and extends exclusive ownership", (t) => {
  const { a, b } = fixture(t);
  const original = a.claim(claimInput()).claim;
  const renewed = a.renew({ claim: original, nowMs: now + LEASE_MS - 1 });
  assert.equal(renewed.leaseExpiresAtMs, now + 2 * LEASE_MS - 1);
  assert.deepEqual(b.claim(claimInput(now + LEASE_MS + 1)), { status: "skipped", reason: "already-running" });
  assert.throws(() => a.complete({ claim: original, nowMs: now + LEASE_MS, evidence: evidence() }), { code: "BACKUP_JOB_LEASE_LOST" });
  assert.equal(a.complete({ claim: renewed, nowMs: now + LEASE_MS, evidence: evidence() }).status, "succeeded");
});

test("failed backup retries leave the last verified catalog untouched and do not run before their retry time", (t) => {
  const { a, database } = fixture(t);
  const first = a.claim(claimInput()).claim;
  a.complete({ claim: first, nowMs: now + 1, evidence: evidence() });
  const catalog = rows(database, "backup_catalog");
  const next = now + INTERVALS.daily;
  const failed = a.claim(claimInput(next)).claim;
  const result = a.fail({ claim: failed, nowMs: next + 1 });
  assert.equal(result.retryAtMs, next + 1 + RETRY_MS);
  assert.deepEqual(a.claim(claimInput(next + RETRY_MS)), { status: "skipped", reason: "not-due" });
  const retry = a.claim(claimInput(result.retryAtMs)).claim;
  assert.equal(retry.runId, failed.runId);
  assert.equal(retry.supersedesBackupId, failed.backupId);
  assert.deepEqual(rows(database, "backup_catalog"), catalog);
  a.complete({ claim: retry, nowMs: result.retryAtMs + 1, evidence: evidence("second") });
  assert.equal(rows(database, "backup_catalog").length, 2);
  assert.deepEqual(database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(first.backupId), catalog[0]);
});

test("catalog insertion failure rolls back completion and evidence with altered claim bindings is rejected", (t) => {
  const { a, database } = fixture(t);
  const first = a.claim(claimInput()).claim;
  a.complete({ claim: first, nowMs: now + 1, evidence: evidence() });
  const next = now + INTERVALS.daily;
  const second = a.claim(claimInput(next)).claim;
  const snapshot = { jobs: rows(database, "job_runs"), catalog: rows(database, "backup_catalog") };
  assert.throws(() => a.complete({ claim: second, nowMs: next + 1, evidence: evidence() }), /UNIQUE constraint failed/);
  for (const claim of [{ ...second, cadence: "hourly" }, { ...second, scheduledForMs: 0 }, { ...second, startedAtMs: 0 }]) {
    assert.throws(() => a.complete({ claim, nowMs: next + 1, evidence: evidence("second") }), { code: "BACKUP_JOB_LEASE_LOST" });
  }
  assert.deepEqual(rows(database, "job_runs"), snapshot.jobs);
  assert.deepEqual(rows(database, "backup_catalog"), snapshot.catalog);
});

test("identity changes and recovery holds block every mutation without disturbing held work", (t) => {
  const { a, database } = fixture(t);
  const claim = a.claim(claimInput()).claim;
  database.prepare("INSERT INTO application_metadata VALUES (?, 'false',1,1)").run(RECOVERY_HOLD_KEY);
  const snapshot = database.serialize();
  for (const method of ["complete", "fail", "renew"]) {
    assert.throws(() => a[method]({ claim, nowMs: now + 1, evidence: evidence() }), { code: "DATABASE_RECOVERY_HELD" });
  }
  assert.throws(() => a.claim(claimInput(now + 1)), { code: "DATABASE_RECOVERY_HELD" });
  assert.deepEqual(database.serialize(), snapshot);
  assert.throws(() => createSqliteScheduledBackupRepository({ database, ...identity, databaseId: "wrong-database-id" }), { code: "DATABASE_IDENTITY_MISMATCH" });
});
