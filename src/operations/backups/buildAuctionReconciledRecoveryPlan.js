const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { verifyRecoveryAuctionReconciliation } = require("./verifyRecoveryAuctionReconciliation");
const { RecoveryAuctionReconciliationError, fail, hash } = require("./recoveryAuctionReconciliationEvidence");

function buildAuctionReconciledRecoveryPlan({ preparedDatabase, reconciledDatabase, restoredDatabase, preservedDatabase,
  credentialPreparation, originalPlan, auctionReconciliation, observedAtMs, parentProof, lineage = null } = {}) {
  try {
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || !Number.isSafeInteger(auctionReconciliation?.executedAtMs) ||
        observedAtMs < auctionReconciliation.executedAtMs) fail("RECOVERY_AUCTION_PLAN_TIME_INVALID");
    const receipt = auctionReconciliation;
    const verified = verifyRecoveryAuctionReconciliation({ reconciledDatabase, reconciliation: receipt, reviewOptions: {
      preparedDatabase, restoredDatabase, preservedDatabase, credentialPreparation, plan: originalPlan, parentProof, lineage,
      jobId: receipt.completedJobId, auctionId: receipt.review?.auctionId, leagueId: receipt.review?.leagueId,
      preservedPlaintextSha256: receipt.review?.preservedPlaintextSha256, observedAtMs: receipt.executedAtMs,
    } });
    // Use the already verified expected rows. Do not introduce a second
    // database read after the receipt verifier has checked all file hashes.
    const job = verified.completedJob, message = verified.createdMessage;
    const jobs = originalPlan.jobs.map(row => row.id !== job.id ? row : { ...row, status: job.status, version: job.version,
      rowSha256: job.rowSha256, leaseExpired: null, disposition: "preserve-recorded-result", executionPermitted: false });
    const outbox = [...originalPlan.outbox, { id: message.id, leagueId: message.leagueId, eventType: message.eventType,
      channel: "league-notification", status: message.status, version: message.version, rowSha256: message.rowSha256,
      disposition: "held-awaiting-delivery-evidence", deliveryPermitted: false }].sort((a, b) => a.id.localeCompare(b.id));
    const { planChecksum, ...parent } = originalPlan;
    const next = { ...parent, planVersion: 7, observedAtMs, previousPlanChecksum: planChecksum,
      credentialPreparedPlaintextSha256: credentialPreparation.preparedPlaintextSha256,
      preparedPlaintextSha256: verified.reconciledPlaintextSha256, auctionReconciliationChecksum: verified.reconciliationChecksum,
      tableSnapshots: verified.tableSnapshots, snapshotSha256: hash(canonicalize(verified.tableSnapshots)), jobs, outbox,
      unresolvedJobs: verified.unresolvedJobs, unresolvedMessages: verified.unresolvedMessages, activationReady: false, executable: false };
    return Object.freeze({ ...next, planChecksum: hash(canonicalize(next)) });
  } catch (error) {
    if (error instanceof RecoveryAuctionReconciliationError) throw error;
    fail("RECOVERY_AUCTION_PLAN_FAILED");
  }
}
module.exports = { buildAuctionReconciledRecoveryPlan };
