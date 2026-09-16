const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { expectedRecoveryAuctionDelta, readRows, snapshots } = require("./recoveryAuctionDeltaEvidence");
const { RecoveryAuctionReconciliationError, fail, hash, same, buildRecoveryAuctionAttribution } = require("./recoveryAuctionReconciliationEvidence");

function assertReader(database, digest) {
  if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
      fs.lstatSync(database.name).isSymbolicLink() || !fs.statSync(database.name).isFile() || fs.statSync(database.name).nlink !== 1 ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) || fs.existsSync(`${database.name}-journal`) ||
      hash(fs.readFileSync(database.name)) !== digest) fail("RECOVERY_AUCTION_RECEIPT_SOURCE_INVALID");
}

// Rebuilds the complete permitted result from actual predecessor and loss-window
// files. Receipt integrity alone never establishes the domain result, identity,
// callback scope or permission to reopen. Elapsed/callback execution remains
// attributed evidence in the audited snapshot, not new external observation.
function verifyRecoveryAuctionReconciliation({ reviewOptions, reconciledDatabase, reconciliation } = {}) {
  try {
    if (!reconciliation || typeof reconciliation !== "object") fail("RECOVERY_AUCTION_RECEIPT_INVALID");
    const { reconciledDatabasePath, inspection, reportChecksum, ...receipt } = reconciliation;
    if (hash(canonicalize(receipt)) !== reportChecksum) fail("RECOVERY_AUCTION_RECEIPT_INVALID");
    const evidence = expectedRecoveryAuctionDelta({ reviewOptions, identifiers: receipt.identifiers });
    const attribution = buildRecoveryAuctionAttribution({ evidence, decision: receipt.decision, execution: receipt.execution });
    const readers = [reviewOptions.preparedDatabase, reviewOptions.restoredDatabase, reviewOptions.preservedDatabase, reconciledDatabase];
    const digests = [evidence.review.preparedPlaintextSha256, evidence.review.restoredPlaintextSha256,
      evidence.review.preservedPlaintextSha256, receipt.reconciledPlaintextSha256];
    readers.forEach((reader, index) => assertReader(reader, digests[index]));
    if (new Set(readers.map(reader => fs.realpathSync(reader.name))).size !== readers.length) fail("RECOVERY_AUCTION_RECEIPT_SOURCE_REUSED");
    const changes = readers.map(reader => reader.prepare("SELECT total_changes() n").get().n);
    const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    const database = reconciledDatabase, before = reviewOptions.preparedDatabase;
    if (!same(database.prepare(schemaSql).all(), before.prepare(schemaSql).all()) ||
        database.pragma("user_version", { simple: true }) !== before.pragma("user_version", { simple: true }) ||
        database.pragma("foreign_key_check").length !== 0 || !same(database.pragma("integrity_check"), [{ integrity_check: "ok" }])) {
      fail("RECOVERY_AUCTION_RECEIPT_SCHEMA_INVALID");
    }
    const tableSnapshots = snapshots(readRows(database));
    if (!same(tableSnapshots, snapshots(attribution.expected))) fail("RECOVERY_AUCTION_RECEIPT_DELTA_INVALID");
    const expectedReceipt = { reportVersion: 1, status: "auction-reconciled-held", recoveryId: evidence.review.recoveryId,
      recoveryEpoch: evidence.review.recoveryEpoch, planChecksum: evidence.review.planChecksum, review: evidence.review,
      decision: receipt.decision, decisionChecksum: attribution.decisionChecksum, identifiers: evidence.identifiers, executedAtMs: evidence.review.observedAtMs,
      sourcePlaintextSha256: evidence.review.preparedPlaintextSha256, reconciledPlaintextSha256: hash(fs.readFileSync(database.name)),
      domainSnapshotSha256: hash(canonicalize(evidence.tableSnapshots)), execution: receipt.execution, tableSnapshots,
      completedJobId: evidence.review.jobId, completedJobRowSha256: hash(canonicalize(evidence.completedJob)),
      unresolvedJobs: reviewOptions.plan.unresolvedJobs - 1, unresolvedMessages: reviewOptions.plan.unresolvedMessages + 1,
      createdOutboxId: evidence.identifiers.outboxEventId, createdMessage: "pending-and-held", sourceDatabases: "unchanged",
      otherJobs: "unchanged-and-held", previousMessages: "unchanged-and-held", reviewEvidence: "operator-supplied-not-current-authentication",
      normalRuntime: "blocked-by-durable-recovery-hold", callbackExecutionVerified: true, leaseElapsedVerified: true,
      restartVerified: true, completeLossWindowEvidence: false, operatorAuthenticated: false, activationReady: false, executable: false };
    if (!same(receipt, expectedReceipt)) fail("RECOVERY_AUCTION_RECEIPT_INVALID");
    readers.forEach((reader, index) => {
      assertReader(reader, digests[index]);
      if (reader.prepare("SELECT total_changes() n").get().n !== changes[index]) fail("RECOVERY_AUCTION_RECEIPT_WRITE_DETECTED");
    });
    const job = evidence.completedJob, message = evidence.expected.outbox_events.find(row => row.id === evidence.identifiers.outboxEventId);
    const report = { verificationVersion: 1, status: "auction-reconciliation-verified-held", reconciliationChecksum: reportChecksum,
      reviewChecksum: evidence.review.reportChecksum, planChecksum: evidence.review.planChecksum, recoveryId: evidence.review.recoveryId,
      sourcePlaintextSha256: evidence.review.preparedPlaintextSha256, reconciledPlaintextSha256: receipt.reconciledPlaintextSha256,
      domainSnapshotSha256: expectedReceipt.domainSnapshotSha256, tableSnapshots, completedJobId: evidence.review.jobId,
      completedJob: { id: job.id, status: job.status, version: job.version, rowSha256: hash(canonicalize(job)) },
      createdMessage: { id: message.id, leagueId: message.league_id, eventType: message.event_type, status: message.status,
        version: message.version, rowSha256: hash(canonicalize(message)) },
      createdOutboxId: evidence.identifiers.outboxEventId, unresolvedJobs: expectedReceipt.unresolvedJobs, unresolvedMessages: expectedReceipt.unresolvedMessages,
      executionEvidence: "verified-against-attributed-local-audit", operatorAuthenticated: false, completeLossWindowEvidence: false,
      activationReady: false, executable: false };
    return Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
  } catch (error) {
    if (error instanceof RecoveryAuctionReconciliationError) throw error;
    fail("RECOVERY_AUCTION_RECEIPT_VERIFICATION_FAILED");
  }
}
module.exports = { verifyRecoveryAuctionReconciliation };
