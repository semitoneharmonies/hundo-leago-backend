const fs = require("node:fs");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { RecoveryKnownBuyoutError, fail, hash, same, assertReader, buildKnownBuyoutEvidence,
  attributeKnownBuyout, readRows, snapshots } = require("./recoveryKnownBuyoutEvidence");

function knownBuyoutReceipt({ evidence, decision, attribution, reconciledPlaintextSha256 }) {
  const report = { reportVersion: 1, status: "known-buyout-reconstructed-held", recoveryId: evidence.review.recoveryId,
    recoveryEpoch: evidence.review.recoveryEpoch, planChecksum: evidence.review.planChecksum, review: evidence.review, decision,
    decisionChecksum: attribution.decisionChecksum, sourcePlaintextSha256: evidence.review.preparedPlaintextSha256,
    reconciledPlaintextSha256, reconstructedAtMs: evidence.review.observedAtMs, tableSnapshots: snapshots(attribution.expected),
    domainSnapshotSha256: hash(canonicalize(evidence.tableSnapshots)), domainReplay: "original-validated-buyout-command",
    historicalActorPreserved: true, historicalTimePreserved: true, reviewerEvidence: "active-platform-administrator-in-held-snapshot",
    sources: "unchanged", otherRecords: "unchanged", jobsAndMessages: "previous-records-unchanged-and-held",
    createdMessage: "pending-and-held", replayVerified: true,
    callbackScope: "no-open-candidate-cards-no-live-matchups-no-affected-pending-trades",
    normalRuntime: "blocked-by-durable-recovery-hold", operatorAuthenticated: false,
    completeLossWindowEvidence: false, activationReady: false, executable: false };
  return Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
}

// Recomputes the expected result from four actual offline copies and the two
// manifests. A rehashed receipt cannot authorize extra rows or financial loss.
function verifyRecoveryKnownBuyout({ reviewOptions, reconciledDatabase, reconciliation } = {}) {
  try {
    const evidence = buildKnownBuyoutEvidence(reviewOptions);
    if (!reconciliation || typeof reconciliation !== "object") fail("RECOVERY_BUYOUT_RECEIPT_INVALID");
    const { reconciledDatabasePath, inspection, ...receipt } = reconciliation;
    const attribution = attributeKnownBuyout({ evidence, decision: receipt.decision });
    const readers = [reviewOptions.preparedDatabase, reviewOptions.restoredDatabase, reviewOptions.preservedDatabase, reconciledDatabase];
    const digests = [evidence.review.preparedPlaintextSha256, evidence.review.restoredPlaintextSha256,
      evidence.review.preservedPlaintextSha256, receipt.reconciledPlaintextSha256];
    readers.forEach((reader, index) => assertReader(reader, digests[index]));
    if (new Set(readers.map(reader => fs.realpathSync(reader.name))).size !== readers.length) fail("RECOVERY_BUYOUT_SOURCE_REUSED");
    const changes = readers.map(reader => reader.prepare("SELECT total_changes() n").get().n);
    const schema = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    if (!same(reconciledDatabase.prepare(schema).all(), reviewOptions.preparedDatabase.prepare(schema).all()) ||
        reconciledDatabase.pragma("user_version", { simple: true }) !== reviewOptions.preparedDatabase.pragma("user_version", { simple: true }) ||
        reconciledDatabase.pragma("foreign_key_check").length !== 0 ||
        !same(reconciledDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]) ||
        !same(snapshots(readRows(reconciledDatabase)), snapshots(attribution.expected))) fail("RECOVERY_BUYOUT_DELTA_INVALID");
    const expected = knownBuyoutReceipt({ evidence, decision: receipt.decision, attribution, reconciledPlaintextSha256: digests[3] });
    if (!same(receipt, expected)) fail("RECOVERY_BUYOUT_RECEIPT_INVALID");
    readers.forEach((reader, index) => { assertReader(reader, digests[index]);
      if (reader.prepare("SELECT total_changes() n").get().n !== changes[index]) fail("RECOVERY_BUYOUT_WRITE_DETECTED"); });
    return expected;
  } catch (error) { if (error instanceof RecoveryKnownBuyoutError) throw error; fail("RECOVERY_BUYOUT_VERIFICATION_FAILED"); }
}

function buildKnownBuyoutReconciledRecoveryPlan({ preparedDatabase, reconciledDatabase, restoredDatabase, preservedDatabase,
  credentialPreparation, originalPlan, knownBuyoutReconciliation, observedAtMs, backupManifestBytes, preservationManifestBytes,
  parentProof, lineage = null } = {}) {
  try {
    const receipt = knownBuyoutReconciliation, review = receipt?.review;
    if (!Number.isSafeInteger(observedAtMs) || !Number.isSafeInteger(receipt?.reconstructedAtMs) || observedAtMs < receipt.reconstructedAtMs) fail("RECOVERY_BUYOUT_PLAN_TIME_INVALID");
    const verified = verifyRecoveryKnownBuyout({ reconciledDatabase, reconciliation: receipt, reviewOptions: {
      preparedDatabase, restoredDatabase, preservedDatabase, credentialPreparation, plan: originalPlan, parentProof, lineage,
      buyoutId: review?.buyoutId, leagueId: review?.leagueId, preservedPlaintextSha256: review?.preservedPlaintextSha256,
      observedAtMs: receipt.reconstructedAtMs, backupManifestBytes, preservationManifestBytes,
      expectedBackupManifestSha256: review?.provenance?.backupManifestSha256,
      expectedPreservationManifestSha256: review?.provenance?.preservationManifestSha256 } });
    const { planChecksum, ...parent } = originalPlan;
    const notificationEffect = verified.review.effects.find(effect => effect.table === "outbox_events");
    const message = reconciledDatabase.prepare("SELECT * FROM outbox_events WHERE id=?").get(notificationEffect.id);
    const outbox = [...parent.outbox, { id: message.id, leagueId: message.league_id, eventType: message.event_type,
      channel: "league-notification", status: message.status, version: message.version, rowSha256: hash(canonicalize(message)),
      disposition: "held-awaiting-delivery-evidence", deliveryPermitted: false }].sort((a, b) => a.id.localeCompare(b.id));
    const next = { ...parent, planVersion: 8, observedAtMs, previousPlanChecksum: planChecksum,
      credentialPreparedPlaintextSha256: credentialPreparation.preparedPlaintextSha256,
      preparedPlaintextSha256: verified.reconciledPlaintextSha256, knownBuyoutReconciliationChecksum: verified.reportChecksum,
      tableSnapshots: verified.tableSnapshots, snapshotSha256: hash(canonicalize(verified.tableSnapshots)), outbox,
      unresolvedMessages: parent.unresolvedMessages + 1, activationReady: false, executable: false };
    return Object.freeze({ ...next, planChecksum: hash(canonicalize(next)) });
  } catch (error) { if (error instanceof RecoveryKnownBuyoutError) throw error; fail("RECOVERY_BUYOUT_PLAN_FAILED"); }
}
module.exports = { knownBuyoutReceipt, verifyRecoveryKnownBuyout, buildKnownBuyoutReconciledRecoveryPlan };
