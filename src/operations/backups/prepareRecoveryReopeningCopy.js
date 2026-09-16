const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../../infrastructure/database/connection");
const { RECOVERY_HOLD_KEY, assertRecoveryRuntimeAllowed } = require("../../infrastructure/database/recoveryHold");
const { readRecoveryEpoch } = require("../../infrastructure/database/recoveryEpoch");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createEncryptedOffsiteBackup } = require("./createEncryptedOffsiteBackup");
const { hash, same, readRows, snapshots } = require("./recoveryKnownBuyoutEvidence");
const inside = (root, file) => { const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function fail(code) { const error = new Error("The isolated reopening copy could not be prepared safely."); error.code = code; throw error; }

// Internal maintenance-route operation. authorize must re-resolve the actual
// session and review, including after backup I/O. This never edits its source,
// starts a runtime, releases workers, or publishes a deployment.
async function prepareRecoveryReopeningCopy({ sourceDatabase, outputRoot, temporaryRoot, backupConfig, backupEnvironment, objectStorage,
  backendBuildId, reopeningId, decision, authorize, nowMs }) {
  let directory, database;
  const root = fs.realpathSync(outputRoot), physicalTemp = fs.realpathSync(temporaryRoot);
  if (!inside(physicalTemp, root) || fs.lstatSync(outputRoot).isSymbolicLink() ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(reopeningId) || typeof authorize !== "function") fail("RECOVERY_REOPENING_PATH_UNSAFE");
  const input = JSON.parse(JSON.stringify(decision));
  try {
    const initial = authorize(), review = initial.review;
    if (!["staging", "production"].includes(backupEnvironment) || backupConfig?.appEnv !== backupEnvironment || backupConfig.environmentId !== review.databaseIdentity.environmentId ||
        backupConfig.databaseId !== review.databaseIdentity.databaseId || fs.realpathSync(backupConfig.persistentRoot) !== physicalTemp ||
        !inside(physicalTemp, fs.realpathSync(backupConfig.localDirectory))) fail("RECOVERY_REOPENING_BACKUP_INVALID");
    const target = path.join(root, "reopening-" + reopeningId);
    fs.mkdirSync(target, { recursive: false, mode: 0o700 }); directory = target;
    const databasePath = path.join(directory, "reopening.sqlite3");
    fs.copyFileSync(sourceDatabase.name, databasePath, fs.constants.COPYFILE_EXCL); fs.chmodSync(databasePath, 0o600);
    if (hash(fs.readFileSync(databasePath)) !== review.candidatePlaintextSha256) fail("RECOVERY_REOPENING_SOURCE_CHANGED");
    const backup = await createEncryptedOffsiteBackup({ databasePath, config: backupConfig, objectStorage,
      reason: "pre-cutover-rehearsal", requestedByType: "platform_administrator", requestedById: initial.actor.userId,
      backendBuildId, retentionClass: "incident-preservation", nowMs });
    const current = authorize();
    if (!same(current.actor, initial.actor) || current.review.reportChecksum !== review.reportChecksum || backup.status !== "verified" ||
        hash(fs.readFileSync(databasePath)) !== review.candidatePlaintextSha256) fail("RECOVERY_REOPENING_REVIEW_STALE");
    database = openDatabase({ databasePath, environment: backupEnvironment, persistentRoot: physicalTemp, requirePersistentRoot: true }).database;
    const before = readRows(database), hold = before.application_metadata.find(row => row.metadata_key === RECOVERY_HOLD_KEY);
    if (!hold || !same(readRecoveryEpoch(database), review.recoveryEpoch) ||
        !same(snapshots(before), current.plan.tableSnapshots) ||
        before.sessions.some(row => row.status === "active") || before.account_action_tokens.some(row => row.status === "active") ||
        before.job_runs.some(row => !["succeeded", "skipped"].includes(row.status)) ||
        before.outbox_events.some(row => !["published", "discarded"].includes(row.status))) fail("RECOVERY_REOPENING_WORK_UNRESOLVED");
    const decisionChecksum = hash(canonicalize(input));
    const approval = { reopeningId, scope: "isolated-reopening-copy", backupEnvironment, recoveryId: review.recoveryId, recoveryEpoch: review.recoveryEpoch,
      sourceBackupId: review.sourceBackupId, restoredPlaintextSha256: review.restoredPlaintextSha256,
      preservedPlaintextSha256: review.preservedPlaintextSha256,
      candidatePlaintextSha256: review.candidatePlaintextSha256, candidateReviewChecksum: review.reportChecksum,
      recordedLossComparisonChecksum: review.lossWindow.reportChecksum, recordedLossProgress: review.recordedLossProgress.counts,
      financialCorrections: JSON.parse(JSON.stringify(current.corrections)),
      decision: input, decisionChecksum, authenticatedActor: current.actor, approvedAtMs: current.nowMs,
      preReopeningBackup: backup, previousHold: hold, externalLossEvidenceVerified: false,
      currentOperatorApproval: true, productionActivationApproved: false, recoveryComplete: false };
    const metadata = { metadata_key: "recovery_reopening_review:" + reopeningId, metadata_value: canonicalize(approval),
      created_at_ms: current.nowMs, updated_at_ms: current.nowMs };
    const audit = { id: reopeningId, event_type: "recovery.reopening_copy_prepared", outcome: "success", actor_user_id: current.actor.userId,
      target_user_id: null, league_id: null, session_id: null, request_correlation_id: review.recoveryId, reason_code: "reopening_" + decisionChecksum,
      network_key_version: null, network_metadata_digest: null, unknown_account_digest: null,
      client_metadata_json: '{"networkSourceCategory":"local"}', occurred_at_ms: current.nowMs };
    database.transaction(() => {
      authorize();
      const changes = database.prepare("SELECT total_changes() n").get().n;
      database.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(metadata);
      createSqliteSecurityAuditRepository({ database }).append(audit);
      if (database.prepare("DELETE FROM application_metadata WHERE metadata_key=? AND metadata_value=?").run(RECOVERY_HOLD_KEY, hold.metadata_value).changes !== 1) fail("RECOVERY_REOPENING_HOLD_CHANGED");
      const expected = { ...before, application_metadata: [...before.application_metadata.filter(row => row.metadata_key !== RECOVERY_HOLD_KEY), metadata],
        security_audit_events: [...before.security_audit_events, audit] };
      if (!same(snapshots(readRows(database)), snapshots(expected)) || database.prepare("SELECT total_changes() n").get().n - changes !== 3 ||
          database.pragma("foreign_key_check").length !== 0 || !same(database.pragma("integrity_check"), [{ integrity_check: "ok" }])) fail("RECOVERY_REOPENING_POSTCHECK_FAILED");
      assertRecoveryRuntimeAllowed(database); authorize();
    }).immediate();
    const tableSnapshots = snapshots(readRows(database)); database.close(); database = null; authorize();
    const report = { reportVersion: 1, status: "controlled-reopening-copy-prepared", ...approval,
      sourceDatabase: "unchanged-and-held", maintenanceDatabase: "unchanged-and-held", activeSessions: 0,
      unresolvedJobs: 0, unresolvedMessages: 0, tableSnapshots, reopeningPlaintextSha256: hash(fs.readFileSync(databasePath)),
      runtimeStarted: false, deliveryPerformed: false, postReopeningBackupVerified: false };
    const receipt = { ...report, reportChecksum: hash(canonicalize(report)) };
    const receiptPath = path.join(directory, "reopening-preparation.json"), bytes = canonicalize(receipt) + "\n";
    const descriptor = fs.openSync(receiptPath, "wx", 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    return { receipt, databasePath, receiptPath, receiptFileSha256: hash(bytes) };
  } catch (error) {
    if (database?.open) database.close();
    if (directory) {
      const resolved = fs.realpathSync(directory);
      if (!inside(root, resolved) || fs.lstatSync(directory).isSymbolicLink()) fail("RECOVERY_REOPENING_CLEANUP_FAILED");
      fs.rmSync(resolved, { recursive: true, force: false });
    }
    throw error;
  }
}
module.exports = { prepareRecoveryReopeningCopy };
