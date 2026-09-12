const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { assertDatabaseIdentity } = require("../../infrastructure/database/databaseIdentity");
const { RecoveryFinancialSummaryError, summarizeRecoveryFinancialState } = require("./summarizeRecoveryFinancialState");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const NAME = /^[a-z][a-z0-9_]*$/;

class RecoveryLossWindowError extends Error {
  constructor(code) {
    super("Recovery comparison requires two unchanged, compatible and verified database copies.");
    this.name = "RecoveryLossWindowError";
    this.code = code;
  }
}
function fail(code) { throw new RecoveryLossWindowError(code); }
function unchanged(database, expectedHash) {
  if (hash(fs.readFileSync(database.name)) !== expectedHash ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`)) fail("RECOVERY_COMPARISON_SOURCE_CHANGED");
}
function safeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value !== "bigint") return [key, value];
    const number = Number(value);
    if (!Number.isSafeInteger(number)) fail("RECOVERY_COMPARISON_INTEGER_UNSAFE");
    return [key, number];
  }));
}
function snapshot(database, expectedHash, expectedIdentity) {
  if (!database?.open || database.readonly !== true || database.inTransaction ||
      !path.isAbsolute(database.name || "") || !DIGEST.test(expectedHash || "")) {
    fail("RECOVERY_COMPARISON_INPUT_INVALID");
  }
  unchanged(database, expectedHash);
  const initialChanges = database.prepare("SELECT total_changes() AS count").get().count;
  const result = database.transaction(() => {
    const identity = assertDatabaseIdentity(database, expectedIdentity);
    if (canonicalize(database.pragma("integrity_check")) !== '[{"integrity_check":"ok"}]' ||
        database.pragma("foreign_key_check").length !== 0) fail("RECOVERY_COMPARISON_INTEGRITY_INVALID");
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = {};
    for (const { name } of schema.filter(row => row.type === "table")) {
      if (!NAME.test(name)) fail("RECOVERY_COMPARISON_SCHEMA_UNSUPPORTED");
      const columns = database.pragma(`table_info("${name}")`);
      if (columns.some(column => !NAME.test(column.name))) fail("RECOVERY_COMPARISON_SCHEMA_UNSUPPORTED");
      const primaryKey = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
      if (primaryKey.length === 0) fail("RECOVERY_COMPARISON_SCHEMA_UNSUPPORTED");
      const rows = new Map();
      for (const row of database.prepare(`SELECT * FROM "${name}"`).safeIntegers(true).all().map(safeRow)) {
        const key = primaryKey.map(column => row[column]);
        if (key.some(value => value === null)) fail("RECOVERY_COMPARISON_SCHEMA_UNSUPPORTED");
        const keyHash = hash(canonicalize(key));
        if (rows.has(keyHash)) fail("RECOVERY_COMPARISON_SCHEMA_UNSUPPORTED");
        rows.set(keyHash, { row, sha256: hash(canonicalize(row)) });
      }
      tables[name] = { rows, sha256: hash(canonicalize([...rows].map(([key, value]) => [key, value.sha256]).sort())) };
    }
    if (!tables.schema_migrations) fail("RECOVERY_COMPARISON_SCHEMA_UNSUPPORTED");
    return { identity, schemaVersion: database.pragma("user_version", { simple: true }), schemaSha256: hash(canonicalize(schema)), tables };
  }).deferred();
  unchanged(database, expectedHash);
  if (database.prepare("SELECT total_changes() AS count").get().count !== initialChanges) fail("RECOVERY_COMPARISON_WRITE_DETECTED");
  return result;
}

// Reports what two preserved copies contain. Database status is not proof of an
// external delivery, nor permission to replay a lost transaction or occurrence.
function compareRecoveryLossWindow({ restoredDatabase, preservedDatabase, restoredPlaintextSha256,
  preservedPlaintextSha256, sourceBackupId, expectedEnvironmentId, expectedDatabaseId, observedAtMs,
  includeFinancialState = false } = {}) {
  if (!UUID.test(sourceBackupId || "") || !IDENTITY.test(expectedEnvironmentId || "") ||
      !IDENTITY.test(expectedDatabaseId || "") || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0 ||
      typeof includeFinancialState !== "boolean") {
    fail("RECOVERY_COMPARISON_INPUT_INVALID");
  }
  try {
    const expectedIdentity = { environmentId: expectedEnvironmentId, databaseId: expectedDatabaseId };
    const before = snapshot(restoredDatabase, restoredPlaintextSha256, expectedIdentity);
    const after = snapshot(preservedDatabase, preservedPlaintextSha256, expectedIdentity);
    if (fs.realpathSync(restoredDatabase.name) === fs.realpathSync(preservedDatabase.name)) fail("RECOVERY_COMPARISON_INPUT_INVALID");
    if (before.schemaVersion !== after.schemaVersion || before.schemaSha256 !== after.schemaSha256 ||
        canonicalize(before.identity) !== canonicalize(after.identity) ||
        before.tables.schema_migrations?.sha256 !== after.tables.schema_migrations?.sha256) {
      fail("RECOVERY_COMPARISON_SCHEMA_MISMATCH");
    }
    const tables = {};
    for (const name of Object.keys(before.tables).sort()) {
      const left = before.tables[name]; const right = after.tables[name];
      const changes = [];
      for (const key of [...new Set([...left.rows.keys(), ...right.rows.keys()])].sort()) {
        const old = left.rows.get(key); const current = right.rows.get(key);
        if (old?.sha256 === current?.sha256) continue;
        const changedColumns = old && current ? Object.keys(old.row)
          .filter(column => canonicalize(old.row[column]) !== canonicalize(current.row[column])).sort() : [];
        const statuses = name === "job_runs" ? ["pending", "leased", "running", "succeeded", "failed", "skipped"]
          : name === "outbox_events" ? ["pending", "publishing", "published", "failed", "discarded"] : null;
        if (statuses && [old, current].some(value => value && !statuses.includes(value.row.status))) {
          fail("RECOVERY_COMPARISON_STATE_INVALID");
        }
        const effect = ["job_runs", "outbox_events"].includes(name) ? {
          restoredStatus: old?.row.status ?? null, preservedStatus: current?.row.status ?? null,
          externalOutcomeVerified: false, replayPermitted: false,
        } : {};
        changes.push({ keySha256: key, kind: !old ? "absent-from-backup" : !current ? "absent-from-preserved-copy" : "changed-after-backup",
          restoredRowSha256: old?.sha256 ?? null, preservedRowSha256: current?.sha256 ?? null,
          changedColumns, ...effect });
      }
      tables[name] = { restoredCount: left.rows.size, preservedCount: right.rows.size,
        restoredRowsSha256: left.sha256, preservedRowsSha256: right.sha256, changes };
    }
    unchanged(restoredDatabase, restoredPlaintextSha256);
    unchanged(preservedDatabase, preservedPlaintextSha256);
    const report = { reportVersion: 1, sourceBackupId, restoredPlaintextSha256, preservedPlaintextSha256,
      observedAtMs, databaseIdentity: expectedIdentity, schemaVersion: before.schemaVersion, schemaSha256: before.schemaSha256,
      tables, changedTables: Object.values(tables).filter(table => table.changes.length > 0).length,
      changedRecords: Object.values(tables).reduce((count, table) => count + table.changes.length, 0),
      ...(includeFinancialState ? { financialState: summarizeRecoveryFinancialState(before, after) } : {}),
      evidenceScope: "preserved-database-comparison", completeLossWindowEvidence: false,
      activationReady: false, executable: false };
    return Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
  } catch (error) {
    if (error instanceof RecoveryLossWindowError || error instanceof RecoveryFinancialSummaryError) throw error;
    fail("RECOVERY_COMPARISON_FAILED");
  }
}

module.exports = { RecoveryLossWindowError, compareRecoveryLossWindow };
