const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createSqliteOutboxEventRepository, CLEARED_PAYLOAD_JSON } = require("../../infrastructure/persistence/sqlite/SqliteOutboxEventRepository");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { buildRecoveryPlanFromLineage } = require("./buildRecoveryReconciliationLineage");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REASON = "RECOVERY_DELIVERY_RECONCILED";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = file => hash(fs.readFileSync(file));
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function exists(entry) {
  try { fs.lstatSync(entry); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
class RecoveryEmailReconciliationError extends Error {
  constructor(code) {
    super("Recovery email reconciliation requires an unchanged held candidate and exact reviewed delivery evidence.");
    this.name = "RecoveryEmailReconciliationError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryEmailReconciliationError(code); }
function assertSource(source, digest) {
  if (["-wal", "-shm", "-journal"].some(suffix => exists(`${source}${suffix}`)) || hashFile(source) !== digest) {
    fail("RECOVERY_EMAIL_SOURCE_CHANGED");
  }
}
function snapshots(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_EMAIL_STATE_INVALID");
    const rows = database.prepare(`SELECT * FROM "${name}"`).all();
    return [name, { count: rows.length, sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) }];
  }));
}

// This offline operation records a reviewer's evidence, not an independent
// provider-delivery lookup. It can only suppress; it cannot send, replay or reopen.
function prepareRecoveryEmailReconciliation({ credentialPreparation, plan, deliveries,
  reviewedByUserId, reconciliationId, reconciledAtMs, temporaryRoot, outputDirectory, lineage = null, beforeCommit = null } = {}) {
  if (!UUID.test(reviewedByUserId || "") || !UUID.test(reconciliationId || "") ||
      !Number.isSafeInteger(reconciledAtMs) || reconciledAtMs < 0 ||
      !path.isAbsolute(temporaryRoot || "") || !path.isAbsolute(outputDirectory || "") ||
      !path.isAbsolute(credentialPreparation?.preparedDatabasePath || "") ||
      !DIGEST.test(credentialPreparation?.preparedPlaintextSha256 || "") ||
      !DIGEST.test(plan?.planChecksum || "") || !DIGEST.test(plan?.preparedPlaintextSha256 || "") || !Array.isArray(deliveries) || deliveries.length < 1 || deliveries.length > 1000 ||
      (beforeCommit !== null && typeof beforeCommit !== "function")) fail("RECOVERY_EMAIL_INPUT_INVALID");
  // Copy primitive input before any callback can change the reviewed decision.
  const decisions = deliveries.map(item => {
    if (!item || Object.keys(item).sort().join(",") !== "deliveredAtMs,eventId,payloadSha256,providerMessageSha256,providerReceiptSha256,rowSha256" ||
        !UUID.test(item.eventId || "") || ![item.rowSha256, item.payloadSha256, item.providerMessageSha256, item.providerReceiptSha256].every(value => DIGEST.test(value || "")) ||
        !Number.isSafeInteger(item.deliveredAtMs) || item.deliveredAtMs < 0 || item.deliveredAtMs > reconciledAtMs) fail("RECOVERY_EMAIL_INPUT_INVALID");
    return { ...item };
  }).sort((a, b) => a.eventId.localeCompare(b.eventId));
  if (new Set(decisions.map(item => item.eventId)).size !== decisions.length ||
      new Set(decisions.map(item => item.providerMessageSha256)).size !== decisions.length) fail("RECOVERY_EMAIL_INPUT_INVALID");
  let ownedDirectory = null; let database; let physicalRoot;
  try {
    physicalRoot = fs.realpathSync(temporaryRoot);
    const source = fs.realpathSync(credentialPreparation.preparedDatabasePath);
    const output = path.join(fs.realpathSync(path.dirname(outputDirectory)), path.basename(outputDirectory));
    if (!inside(fs.realpathSync(os.tmpdir()), physicalRoot) || !inside(physicalRoot, source) || !inside(physicalRoot, output) ||
        fs.lstatSync(credentialPreparation.preparedDatabasePath).isSymbolicLink() || !fs.statSync(source).isFile() ||
        fs.statSync(source).nlink !== 1 || exists(output)) fail("RECOVERY_EMAIL_PATH_UNSAFE");
    assertSource(source, plan.preparedPlaintextSha256);
    fs.mkdirSync(output, { recursive: false, mode: 0o700 }); ownedDirectory = output;
    const candidatePath = path.join(output, "email-reconciled.sqlite3");
    fs.copyFileSync(source, candidatePath, fs.constants.COPYFILE_EXCL); fs.chmodSync(candidatePath, 0o600);
    database = openReadonlyDatabase({ databasePath: candidatePath });
    const verifiedPlan = buildRecoveryPlanFromLineage({ database, credentialPreparation, lineage,
      observedAtMs: plan.observedAtMs, expectedEnvironmentId: plan.databaseIdentity?.environmentId,
      expectedDatabaseId: plan.databaseIdentity?.databaseId });
    database.close(); database = null;
    if (canonicalize(verifiedPlan) !== canonicalize(plan) || reconciledAtMs < plan.observedAtMs) fail("RECOVERY_EMAIL_PLAN_INVALID");
    database = openDatabase({ databasePath: candidatePath, environment: "staging", persistentRoot: physicalRoot, requirePersistentRoot: true }).database;
    const result = database.transaction(() => {
      const beforeTables = snapshots(database);
      if (canonicalize(beforeTables) !== canonicalize(plan.tableSnapshots)) fail("RECOVERY_EMAIL_SOURCE_CHANGED");
      if (!database.prepare("SELECT 1 FROM users u JOIN platform_roles r ON r.user_id=u.id WHERE u.id=? AND u.status='active' AND r.role='platform_administrator' AND r.status='active'").get(reviewedByUserId)) fail("RECOVERY_EMAIL_REVIEWER_INVALID");
      const beforeOutbox = database.prepare("SELECT * FROM outbox_events ORDER BY id").all();
      const beforeAudit = database.prepare("SELECT * FROM security_audit_events ORDER BY id").all();
      const beforeMetadata = database.prepare("SELECT * FROM application_metadata ORDER BY metadata_key").all();
      const initialChanges = database.prepare("SELECT total_changes() AS count").get().count;
      const byId = new Map(beforeOutbox.map(row => [row.id, row]));
      for (const decision of decisions) {
        const row = byId.get(decision.eventId);
        if (!row || row.league_id !== null || !["pending", "publishing", "failed"].includes(row.status) ||
            hash(canonicalize(row)) !== decision.rowSha256 || hash(row.payload_json) !== decision.payloadSha256 ||
            !Number.isSafeInteger(row.version + 1) || row.updated_at_ms > reconciledAtMs || row.created_at_ms > decision.deliveredAtMs) fail("RECOVERY_EMAIL_DELIVERY_MISMATCH");
      }
      const decisionChecksum = hash(canonicalize(decisions));
      const metadataKey = `recovery_email_review:${reconciliationId}`;
      const metadata = { metadata_key: metadataKey, metadata_value: canonicalize({ recoveryId: plan.recoveryId,
        reconciliationId, reviewedByUserId, reconciledAtMs, planChecksum: plan.planChecksum, decisionChecksum, deliveries: decisions }),
        created_at_ms: reconciledAtMs, updated_at_ms: reconciledAtMs };
      const outbox = createSqliteOutboxEventRepository({ database });
      for (const decision of decisions) outbox.discard({ eventId: decision.eventId, expectedVersion: byId.get(decision.eventId).version,
        nowMs: reconciledAtMs, errorCode: REASON });
      database.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(metadata);
      createSqliteSecurityAuditRepository({ database }).append({ id: reconciliationId, event_type: "recovery.email_reconciled", outcome: "success",
        actor_user_id: reviewedByUserId, target_user_id: null, league_id: null, session_id: null,
        request_correlation_id: plan.recoveryId, reason_code: `delivery_${decisionChecksum}`, network_key_version: null,
        network_metadata_digest: null, unknown_account_digest: null, client_metadata_json: '{"networkSourceCategory":"local"}', occurred_at_ms: reconciledAtMs });
      if (beforeCommit && beforeCommit(database)?.then) fail("RECOVERY_EMAIL_INPUT_INVALID");
      const changedIds = new Set(decisions.map(item => item.eventId));
      const expectedOutbox = beforeOutbox.map(row => !changedIds.has(row.id) ? row : { ...row, status: "discarded",
        payload_json: CLEARED_PAYLOAD_JSON, last_error_code: REASON, updated_at_ms: reconciledAtMs, version: row.version + 1 });
      const afterTables = snapshots(database);
      const preserved = Object.keys(beforeTables).filter(name => !["outbox_events", "security_audit_events", "application_metadata"].includes(name));
      if (preserved.some(name => canonicalize(beforeTables[name]) !== canonicalize(afterTables[name])) ||
          canonicalize(database.prepare("SELECT * FROM outbox_events ORDER BY id").all()) !== canonicalize(expectedOutbox) ||
          canonicalize(database.prepare("SELECT * FROM security_audit_events WHERE id<>? ORDER BY id").all(reconciliationId)) !== canonicalize(beforeAudit) ||
          canonicalize(database.prepare("SELECT * FROM application_metadata WHERE metadata_key<>? ORDER BY metadata_key").all(metadataKey)) !== canonicalize(beforeMetadata) ||
          canonicalize(database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(metadataKey)) !== canonicalize(metadata) ||
          database.prepare("SELECT total_changes() AS count").get().count - initialChanges !== decisions.length + 2 ||
          database.pragma("foreign_key_check").length !== 0) fail("RECOVERY_EMAIL_POSTCHECK_FAILED");
      assertSource(source, plan.preparedPlaintextSha256);
      return { decisionChecksum, deliveries: decisions, suppressedMessages: decisions.length, protectedTableCount: preserved.length,
        tableSnapshots: afterTables, unresolvedMessages: expectedOutbox.filter(row => ["pending", "publishing", "failed"].includes(row.status)).length };
    }).immediate();
    database.close(); database = null;
    const inspection = inspectDatabase(candidatePath);
    assertSource(source, plan.preparedPlaintextSha256);
    const report = { reportVersion: 1, status: "email-reconciled-held", recoveryId: plan.recoveryId, recoveryEpoch: plan.recoveryEpoch,
      reconciliationId, reviewedByUserId, reconciledAtMs, planChecksum: plan.planChecksum,
      sourcePlaintextSha256: verifiedPlan.preparedPlaintextSha256, reconciledPlaintextSha256: hashFile(candidatePath),
      ...result, sourceDatabase: "unchanged", jobs: "unchanged-and-held", normalRuntime: "blocked-by-durable-recovery-hold",
      providerEvidence: "reviewer-supplied-not-independently-fetched", activationReady: false };
    const receipt = { ...report, reportChecksum: hash(canonicalize(report)) };
    fs.writeFileSync(path.join(output, "email-reconciliation.json"), `${canonicalize(receipt)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ ...receipt, reconciledDatabasePath: candidatePath, inspection });
  } catch (error) {
    try {
      if (database?.open) database.close();
      if (ownedDirectory !== null) {
        if (!inside(physicalRoot, fs.realpathSync(ownedDirectory)) || fs.lstatSync(ownedDirectory).isSymbolicLink()) fail("RECOVERY_EMAIL_CLEANUP_FAILED");
        fs.rmSync(ownedDirectory, { recursive: true, force: false });
      }
    } catch { fail("RECOVERY_EMAIL_CLEANUP_FAILED"); }
    if (error instanceof RecoveryEmailReconciliationError) throw error;
    fail("RECOVERY_EMAIL_FAILED");
  }
}

module.exports = { RecoveryEmailReconciliationError, prepareRecoveryEmailReconciliation };
