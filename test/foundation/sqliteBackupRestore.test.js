const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");
const Database = require("better-sqlite3");

const { openDatabase } =
  require("../../src/infrastructure/database/connection");
const { migrateDatabase } =
  require("../../src/infrastructure/database/migrate");
const {
  BACKUP_ERROR_CODES,
  createVerifiedBackup,
  restoreBackupToCleanPath,
} = require("../../src/infrastructure/database/sqliteBackup");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "database", "migrations");
function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m2-10-"));
}
function user(id, email) {
  return {
    id, email_normalized: email, email_display: email,
    display_name: email, display_name_normalized: email,
    status: "active", created_at_ms: 1, updated_at_ms: 1, version: 1,
  };
}
function sourceDatabase(t) {
  const root = temp();
  const opened = openDatabase({
    databasePath: path.join(root, "source.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: opened.database,
    migrationsDirectory: MIGRATIONS,
    applicationBuildId: "m2-10-test",
    now: () => 1,
  });
  opened.database.prepare(
    "INSERT INTO users (id,email_normalized,email_display,display_name," +
    "display_name_normalized,status,created_at_ms,updated_at_ms,version) " +
    "VALUES (@id,@email_normalized,@email_display,@display_name," +
    "@display_name_normalized,@status,@created_at_ms,@updated_at_ms,@version)"
  ).run(user("00000000-0000-4000-8000-000000000001", "a@example.com"));
  t.after(() => {
    if (opened.database.open) opened.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, ...opened };
}
function code(expected) {
  return (error) => error?.code === expected;
}

describe("M2-10 SQLite backup and restore verification", () => {
  test("backs up a live WAL database and restores the exact backup boundary", async (t) => {
    const source = sourceDatabase(t);
    const output = path.join(source.root, "backup");
    const result = await createVerifiedBackup({
      databasePath: source.databasePath,
      outputDirectory: output,
      environment: "test",
      reason: "pre-migration",
      capturedAtMs: 10,
    });
    source.database.prepare(
      "INSERT INTO users (id,email_normalized,email_display,display_name," +
      "display_name_normalized,status,created_at_ms,updated_at_ms,version) " +
      "VALUES (@id,@email_normalized,@email_display,@display_name," +
      "@display_name_normalized,@status,@created_at_ms,@updated_at_ms,@version)"
    ).run(user("00000000-0000-4000-8000-000000000002", "b@example.com"));
    const restoredPath = path.join(source.root, "restored.sqlite3");
    const restored = restoreBackupToCleanPath({
      backupDirectory: output,
      targetDatabasePath: restoredPath,
      environment: "test",
    });
    const db = new Database(restoredPath, { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.close();
    assert.equal(source.database.prepare("SELECT COUNT(*) n FROM users").get().n, 2);
    assert.equal(restored.plaintextSha256, result.plaintextSha256);
  });

  test("manifest and database tampering fail before creating a restore target", async (t) => {
    const source = sourceDatabase(t);
    const output = path.join(source.root, "backup");
    await createVerifiedBackup({
      databasePath: source.databasePath, outputDirectory: output,
      environment: "test", reason: "pre-restore", capturedAtMs: 10,
    });
    const manifestPath = path.join(output, "backup-manifest.json");
    fs.appendFileSync(manifestPath, " ");
    const target = path.join(source.root, "bad-restore.sqlite3");
    assert.throws(() => restoreBackupToCleanPath({
      backupDirectory: output, targetDatabasePath: target, environment: "test",
    }), code(BACKUP_ERROR_CODES.verificationFailed));
    assert.equal(fs.existsSync(target), false);
  });

  test("rejects wrong environments and existing output or restore paths", async (t) => {
    const source = sourceDatabase(t);
    await assert.rejects(() => createVerifiedBackup({
      databasePath: source.databasePath,
      outputDirectory: path.join(source.root, "wrong"),
      environment: "development", reason: "pre-migration", capturedAtMs: 1,
    }), code(BACKUP_ERROR_CODES.argumentInvalid));
    const existing = path.join(source.root, "existing");
    fs.mkdirSync(existing);
    await assert.rejects(() => createVerifiedBackup({
      databasePath: source.databasePath, outputDirectory: existing,
      environment: "test", reason: "pre-migration", capturedAtMs: 1,
    }), code(BACKUP_ERROR_CODES.pathUnsafe));
  });

  test("preserves a backup building directory owned by an earlier attempt", async (t) => {
    const source = sourceDatabase(t);
    const output = path.join(source.root, "collision-backup");
    const backupId = "00000000-0000-4000-8000-000000000010";
    const existingDirectory = `${output}.building-${backupId}`;
    const artifact = path.join(existingDirectory, "in-progress.sqlite3");
    fs.mkdirSync(existingDirectory);
    fs.writeFileSync(artifact, "preserve existing backup");
    const databaseBefore = source.database.serialize();
    t.mock.method(crypto, "randomUUID", () => backupId);

    await assert.rejects(createVerifiedBackup({
      databasePath: source.databasePath, outputDirectory: output,
      environment: "test", reason: "pre-migration", capturedAtMs: 10,
    }), code(BACKUP_ERROR_CODES.operationFailed));

    assert.equal(fs.readFileSync(artifact, "utf8"), "preserve existing backup");
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(source.database.serialize(), databaseBefore);
  });

  test("preserves a restore target created after the clean-path check", async (t) => {
    const source = sourceDatabase(t);
    const output = path.join(source.root, "backup");
    await createVerifiedBackup({
      databasePath: source.databasePath, outputDirectory: output,
      environment: "test", reason: "pre-restore", capturedAtMs: 10,
    });
    const target = path.join(source.root, "competing-restore.sqlite3");
    const databaseBefore = source.database.serialize();
    const originalCopy = fs.copyFileSync;
    t.mock.method(fs, "copyFileSync", (input, destination, flags) => {
      assert.equal(destination, target);
      fs.writeFileSync(destination, "preserve competing restore", { flag: "wx" });
      return originalCopy(input, destination, flags);
    });

    assert.throws(() => restoreBackupToCleanPath({
      backupDirectory: output, targetDatabasePath: target, environment: "test",
    }), code(BACKUP_ERROR_CODES.operationFailed));

    assert.equal(fs.readFileSync(target, "utf8"), "preserve competing restore");
    assert.deepEqual(source.database.serialize(), databaseBefore);
  });

  test("removes its own restore target when copied bytes fail verification", async (t) => {
    const source = sourceDatabase(t);
    const output = path.join(source.root, "backup");
    await createVerifiedBackup({
      databasePath: source.databasePath, outputDirectory: output,
      environment: "test", reason: "pre-restore", capturedAtMs: 10,
    });
    const target = path.join(source.root, "corrupted-copy.sqlite3");
    const databaseBefore = source.database.serialize();
    const originalCopy = fs.copyFileSync;
    t.mock.method(fs, "copyFileSync", (input, destination, flags) => {
      originalCopy(input, destination, flags);
      fs.appendFileSync(destination, "corrupt copied bytes");
    });

    assert.throws(() => restoreBackupToCleanPath({
      backupDirectory: output, targetDatabasePath: target, environment: "test",
    }), code(BACKUP_ERROR_CODES.checksumMismatch));

    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(source.database.serialize(), databaseBefore);
  });

  test("backup and restore CLIs verify a migrated database", async (t) => {
    const source = sourceDatabase(t);
    const output = path.join(source.root, "cli-backup");
    const backup = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "db-backup.js"),
      "--database", source.databasePath, "--output", output,
      "--environment", "test", "--reason", "pre-migration",
      "--captured-at-ms", "10",
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(JSON.parse(backup.stdout).status, "verified");
    const target = path.join(source.root, "cli-restored.sqlite3");
    const restore = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "db-restore-verify.js"),
      "--backup", output, "--target", target, "--environment", "test",
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(JSON.parse(restore.stdout).integrity, "ok");
  });
});
