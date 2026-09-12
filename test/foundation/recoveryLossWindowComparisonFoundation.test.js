const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { canonicalize } = require("../../src/infrastructure/migration/sourceInventory");
const { compareRecoveryLossWindow } = require("../../src/operations/backups/compareRecoveryLossWindow");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const readHash = file => hash(fs.readFileSync(file));
const PRIVATE = "private-provider-result-client-key-and-email";

function copies(t, alter = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-loss-window-"));
  const left = path.join(root, "restored.sqlite3"); const right = path.join(root, "preserved.sqlite3");
  const database = new Database(left);
  database.exec(`PRAGMA user_version=56;
    CREATE TABLE application_metadata (metadata_key TEXT PRIMARY KEY, metadata_value TEXT NOT NULL);
    INSERT INTO application_metadata VALUES ('database_id','test-database'),('environment_id','test-environment'),
      ('database_created_at','2026-09-12T00:00:00.000Z');
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(56,'original');
    CREATE TABLE positions (league_id TEXT NOT NULL, player_id TEXT NOT NULL, amount INTEGER, PRIMARY KEY(league_id,player_id));
    INSERT INTO positions VALUES('league-a','player-one',10),('league-b','player-one',20),('league-b','player-two',30);
    CREATE TABLE outbox_events(id TEXT PRIMARY KEY, status TEXT NOT NULL, payload_json TEXT);
    CREATE TABLE job_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, result_json TEXT);`);
  database.prepare("INSERT INTO outbox_events VALUES('message','publishing',?)").run(PRIVATE);
  database.prepare("INSERT INTO job_runs VALUES('occurrence','running',?)").run(PRIVATE);
  database.close(); fs.copyFileSync(left, right, fs.constants.COPYFILE_EXCL);
  if (alter) { const writer = new Database(right); try { alter(writer); } finally { writer.close(); } }
  const restoredDatabase = openReadonlyDatabase({ databasePath: left });
  const preservedDatabase = openReadonlyDatabase({ databasePath: right });
  t.after(() => {
    if (restoredDatabase.open) restoredDatabase.close();
    if (preservedDatabase.open) preservedDatabase.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { restoredDatabase, preservedDatabase, restoredPlaintextSha256: readHash(left), preservedPlaintextSha256: readHash(right),
    sourceBackupId: crypto.randomUUID(), expectedEnvironmentId: "test-environment", expectedDatabaseId: "test-database", observedAtMs: 100 };
}

test("loss-window comparison distinguishes composite keys, insertions, removals and changed effects without leaking values", t => {
  const input = copies(t, database => database.exec(`UPDATE positions SET amount=99 WHERE league_id='league-a';
    DELETE FROM positions WHERE player_id='player-two'; INSERT INTO positions VALUES('league-c','player-one',40);
    UPDATE outbox_events SET status='published'; UPDATE job_runs SET status='succeeded';`));
  const report = compareRecoveryLossWindow(input);
  assert.equal(report.changedTables, 3); assert.equal(report.changedRecords, 5);
  assert.deepEqual(report.tables.positions.changes.map(row => row.kind).sort(),
    ["absent-from-backup", "absent-from-preserved-copy", "changed-after-backup"]);
  assert.equal(report.tables.positions.changes.some(row => row.keySha256 === hash(canonicalize(["league-b", "player-one"]))), false);
  assert.deepEqual(report.tables.outbox_events.changes.map(({ restoredStatus, preservedStatus, externalOutcomeVerified, replayPermitted }) =>
    ({ restoredStatus, preservedStatus, externalOutcomeVerified, replayPermitted })),
  [{ restoredStatus: "publishing", preservedStatus: "published", externalOutcomeVerified: false, replayPermitted: false }]);
  assert.equal(report.tables.job_runs.changes[0].preservedStatus, "succeeded");
  const { reportChecksum, ...body } = report;
  assert.equal(reportChecksum, hash(canonicalize(body)));
  for (const marker of [PRIVATE, "league-a", "player-one", input.restoredDatabase.name]) assert.equal(JSON.stringify(report).includes(marker), false);
  assert.equal(readHash(input.restoredDatabase.name), input.restoredPlaintextSha256);
  assert.equal(readHash(input.preservedDatabase.name), input.preservedPlaintextSha256);
  for (const database of [input.restoredDatabase, input.preservedDatabase]) assert.equal(database.prepare("SELECT total_changes() AS n").get().n, 0);
  assert.deepEqual(compareRecoveryLossWindow(input), report);
});

test("loss-window comparison refuses mismatched identity, hash, live transactions and a shared copy", t => {
  const input = copies(t);
  for (const patch of [{ expectedDatabaseId: "wrong-database" }, { restoredPlaintextSha256: "a".repeat(64) },
    { preservedDatabase: input.restoredDatabase }, { observedAtMs: -1 }]) {
    assert.throws(() => compareRecoveryLossWindow({ ...input, ...patch }), error => /^RECOVERY_COMPARISON_/.test(error.code));
  }
  input.restoredDatabase.transaction(() => {
    assert.throws(() => compareRecoveryLossWindow(input), { code: "RECOVERY_COMPARISON_INPUT_INVALID" });
  })();
  const writable = new Database(input.preservedDatabase.name);
  try { assert.throws(() => compareRecoveryLossWindow({ ...input, preservedDatabase: writable }), { code: "RECOVERY_COMPARISON_INPUT_INVALID" }); }
  finally { writable.close(); }
});

for (const [name, sql] of [
  ["schema version", "PRAGMA user_version=57"],
  ["table structure", "ALTER TABLE positions ADD COLUMN extra TEXT"],
  ["migration checksum", "UPDATE schema_migrations SET checksum='changed'"],
  ["database creation identity", "UPDATE application_metadata SET metadata_value='2026-09-11T00:00:00.000Z' WHERE metadata_key='database_created_at'"],
]) test(`loss-window comparison rejects changed ${name}`, t => {
  const input = copies(t, database => database.exec(sql));
  assert.throws(() => compareRecoveryLossWindow(input), { code: "RECOVERY_COMPARISON_SCHEMA_MISMATCH" });
});

test("loss-window comparison rejects uncheckpointed WAL rather than trusting an unchanged main file", t => {
  const input = copies(t);
  const writer = new Database(input.preservedDatabase.name);
  try {
    writer.pragma("journal_mode=WAL"); writer.pragma("wal_autocheckpoint=0");
    writer.exec("UPDATE positions SET amount=60 WHERE league_id='league-a'");
    assert.ok(fs.statSync(`${writer.name}-wal`).size > 0);
    assert.throws(() => compareRecoveryLossWindow({ ...input, preservedPlaintextSha256: readHash(writer.name) }), { code: "RECOVERY_COMPARISON_SOURCE_CHANGED" });
  } finally { writer.close(); }
});

test("loss-window comparison rejects integers that would lose precision and cannot invent terminal states", t => {
  const input = copies(t, database => database.exec("UPDATE positions SET amount=9223372036854775807"));
  assert.throws(() => compareRecoveryLossWindow(input), { code: "RECOVERY_COMPARISON_INTEGER_UNSAFE" });
  const invalid = copies(t, database => database.prepare("UPDATE job_runs SET status=?").run(PRIVATE));
  assert.throws(() => compareRecoveryLossWindow(invalid), { code: "RECOVERY_COMPARISON_STATE_INVALID" });
});
