const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryReconciliationPlan } = require("./buildRecoveryReconciliationPlan");
const { readVerifiedRecoveryParent } = require("./buildRecoveryReconciliationLineage");
const { RecoveryTradeExpiryError, fail, hash, same, snapshots, readRows, safeTime,
  expectedTradeExpiryRows, CHANGED_TABLES } = require("./recoveryTradeExpiryEvidence");

function unchanged(database, digest) {
  if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
      !fs.statSync(database.name).isFile() || fs.statSync(database.name).nlink !== 1 ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`) || hash(fs.readFileSync(database.name)) !== digest) fail("RECOVERY_TRADE_PLAN_SOURCE_INVALID");
}
function buildTradeExpiryReconciledRecoveryPlan({ preparedDatabase, reconciledDatabase, credentialPreparation,
  originalPlan, tradeExpiryReconciliation, observedAtMs, parentProof } = {}) {
  if (!safeTime(observedAtMs) || !tradeExpiryReconciliation || !originalPlan) fail("RECOVERY_TRADE_PLAN_INPUT_INVALID");
  try {
    unchanged(preparedDatabase, originalPlan.preparedPlaintextSha256);
    unchanged(reconciledDatabase, tradeExpiryReconciliation.reconciledPlaintextSha256);
    if (fs.realpathSync(preparedDatabase.name) === fs.realpathSync(reconciledDatabase.name)) fail("RECOVERY_TRADE_PLAN_INPUT_INVALID");
    const parent = parentProof !== undefined ? readVerifiedRecoveryParent({ parentProof, database: preparedDatabase, originalPlan, credentialPreparation }) :
      buildRecoveryReconciliationPlan({ database: preparedDatabase, credentialPreparation, observedAtMs: originalPlan.observedAtMs,
        expectedEnvironmentId: originalPlan.databaseIdentity?.environmentId, expectedDatabaseId: originalPlan.databaseIdentity?.databaseId });
    if (!same(parent, originalPlan)) fail("RECOVERY_TRADE_PLAN_PARENT_INVALID");
    const { reconciledDatabasePath, inspection, reportChecksum, ...receipt } = tradeExpiryReconciliation;
    if (hash(canonicalize(receipt)) !== reportChecksum || !safeTime(receipt.executedAtMs) ||
        receipt.executedAtMs < parent.observedAtMs || receipt.executedAtMs > observedAtMs) fail("RECOVERY_TRADE_PLAN_RECEIPT_INVALID");
    const changes = reconciledDatabase.prepare("SELECT total_changes() n").get().n;
    const next = reconciledDatabase.transaction(() => {
      const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
      if (!same(reconciledDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]) || reconciledDatabase.pragma("foreign_key_check").length !== 0 ||
          reconciledDatabase.pragma("user_version", { simple: true }) !== parent.schemaVersion ||
          !same(preparedDatabase.prepare(schemaSql).all(), reconciledDatabase.prepare(schemaSql).all())) fail("RECOVERY_TRADE_PLAN_SCHEMA_INVALID");
      const before = readRows(preparedDatabase), after = readRows(reconciledDatabase);
      if (!same(snapshots(before), parent.tableSnapshots)) fail("RECOVERY_TRADE_PLAN_PARENT_INVALID");
      const evidence = expectedTradeExpiryRows({ before, decision: receipt.decision, executedAtMs: receipt.executedAtMs,
        eventId: receipt.eventId, plan: parent });
      const { job, completedJob, message } = evidence;
      if (parent.jobs.find(row => row.id === job.id)?.disposition !== "held-awaiting-occurrence-evidence" ||
          parent.unresolvedJobs < 1) fail("RECOVERY_TRADE_PLAN_JOB_INVALID");
      const tableSnapshots = snapshots(after);
      if (!same(tableSnapshots, snapshots(evidence.expected))) fail("RECOVERY_TRADE_PLAN_DELTA_INVALID");
      const expectedReceipt = { reportVersion: 1, status: "trade-expiry-reconciled-held", recoveryId: parent.recoveryId,
        recoveryEpoch: parent.recoveryEpoch, planChecksum: parent.planChecksum, sourcePlaintextSha256: parent.preparedPlaintextSha256,
        reconciledPlaintextSha256: hash(fs.readFileSync(reconciledDatabase.name)), decision: receipt.decision,
        decisionChecksum: evidence.decisionChecksum, executedAtMs: receipt.executedAtMs, eventId: evidence.event.id,
        createdOutboxId: message.id, completedJobId: job.id, completedJobRowSha256: hash(canonicalize(completedJob)), tableSnapshots,
        unresolvedJobs: parent.unresolvedJobs - 1, unresolvedMessages: parent.unresolvedMessages + 1,
        protectedTableCount: Object.keys(before).filter(name => !CHANGED_TABLES.includes(name)).length,
        sourceDatabase: "unchanged", otherJobs: "unchanged-and-held", previousMessages: "unchanged-and-held",
        createdMessage: "pending-and-held", reviewEvidence: "operator-supplied-not-current-authentication",
        normalRuntime: "blocked-by-durable-recovery-hold", activationReady: false };
      if (!same(receipt, expectedReceipt)) fail("RECOVERY_TRADE_PLAN_RECEIPT_INVALID");
      const jobs = parent.jobs.map(row => row.id !== job.id ? row : { ...row, status: completedJob.status, version: completedJob.version,
        rowSha256: hash(canonicalize(completedJob)), leaseExpired: null, disposition: "preserve-recorded-result", executionPermitted: false });
      const outbox = [...parent.outbox, { id: message.id, leagueId: message.league_id, eventType: message.event_type,
        channel: "league-notification", status: message.status, version: message.version, rowSha256: hash(canonicalize(message)),
        disposition: "held-awaiting-delivery-evidence", deliveryPermitted: false }].sort((a, b) => a.id.localeCompare(b.id));
      const { planChecksum, ...original } = parent;
      return { ...original, planVersion: 6, observedAtMs, previousPlanChecksum: planChecksum,
        credentialPreparedPlaintextSha256: credentialPreparation.preparedPlaintextSha256,
        preparedPlaintextSha256: receipt.reconciledPlaintextSha256, tradeExpiryReconciliationChecksum: reportChecksum,
        tableSnapshots, snapshotSha256: hash(canonicalize(tableSnapshots)), jobs, outbox,
        unresolvedJobs: parent.unresolvedJobs - 1, unresolvedMessages: parent.unresolvedMessages + 1,
        activationReady: false, executable: false };
    }).deferred();
    unchanged(preparedDatabase, parent.preparedPlaintextSha256);
    unchanged(reconciledDatabase, receipt.reconciledPlaintextSha256);
    if (reconciledDatabase.prepare("SELECT total_changes() n").get().n !== changes) fail("RECOVERY_TRADE_PLAN_WRITE_DETECTED");
    return Object.freeze({ ...next, planChecksum: hash(canonicalize(next)) });
  } catch (error) {
    if (error instanceof RecoveryTradeExpiryError) throw error;
    fail("RECOVERY_TRADE_PLAN_FAILED");
  }
}
module.exports = { buildTradeExpiryReconciledRecoveryPlan };
