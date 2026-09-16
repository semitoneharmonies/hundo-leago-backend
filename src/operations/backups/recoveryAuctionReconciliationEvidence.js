const crypto = require("node:crypto");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { DEFAULT_LEASE_MS, JOB_NAME } = require("../../jobs/definitions/resolveTargetAuctions");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (left, right) => canonicalize(left) === canonicalize(right);
class RecoveryAuctionReconciliationError extends Error {
  constructor(code) {
    super("Auction reconciliation requires exact reviewed evidence and a verified result in a separate held copy.");
    this.name = "RecoveryAuctionReconciliationError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryAuctionReconciliationError(code); }
function validateAuctionDecision({ decision, evidence }) {
  if (!decision || Object.keys(decision).sort().join(",") !== "action,evidenceSha256,reasonCode,reconciliationId,reviewChecksum,reviewedByUserId" ||
      decision.action !== "resolve-ordinary-auction-held" || !UUID.test(decision.reconciliationId || "") || !UUID.test(decision.reviewedByUserId || "") ||
      !DIGEST.test(decision.evidenceSha256 || "") || decision.reviewChecksum !== evidence.review.reportChecksum ||
      !/^[A-Z][A-Z0-9_]{0,79}$/.test(decision.reasonCode || "")) fail("RECOVERY_AUCTION_DECISION_INVALID");
  const { before, identifiers } = evidence;
  const user = before.users.find(row => row.id === decision.reviewedByUserId);
  if (user?.status !== "active" || !before.platform_roles.some(row => row.user_id === user.id && row.role === "platform_administrator" && row.status === "active")) {
    fail("RECOVERY_AUCTION_REVIEWER_INVALID");
  }
  if (Object.values(identifiers).flat().includes(decision.reconciliationId) ||
      before.security_audit_events.some(row => row.id === decision.reconciliationId) ||
      before.application_metadata.some(row => row.metadata_key === `recovery_auction_review:${decision.reconciliationId}`)) fail("RECOVERY_AUCTION_DECISION_REUSED");
}
function expectedAuctionCallbacks(evidence) {
  const { review, identifiers } = evidence, winner = review.pricingPreview.decision.winner;
  return {
    summer: [{ inTransaction: true, command: { leagueId: review.leagueId, affectedTeamIds: [winner.teamId],
      affectedPlayerIds: [review.contextEvidence.candidateState.auction.playerId], sourceOperationId: identifiers.resolutionId,
      sourceKind: "auction_allocation", nowMs: review.observedAtMs },
    result: { leagueId: review.leagueId, sourceOperationId: identifiers.resolutionId, sourceKind: "auction_allocation", affectedCardCount: 0, changedCardCount: 0, cards: [] } }],
    lateLock: [{ inTransaction: false, command: { mutationKind: "auction_resolution", teams: [{ leagueId: review.leagueId,
      seasonId: review.seasonId, teamId: winner.teamId, ownershipWitnesses: [{ ownershipId: identifiers.ownershipId, ownershipVersion: 1, state: "present" }] }] },
    result: { status: "not_applicable" } }], providerCalls: 0, errors: 0,
  };
}
function expectedAuctionWorkerResult(restarted = false) {
  return { job: JOB_NAME, status: "succeeded", due: restarted ? 0 : 1, acquired: restarted ? 0 : 1,
    completed: restarted ? 0 : 1, failed: 0, skipped: 0 };
}
// Reconstructs the two attributed rows independently of the writer. Identity
// is checked in the held snapshot; this is not current user authentication.
function buildRecoveryAuctionAttribution({ evidence, decision, execution }) {
  validateAuctionDecision({ decision, evidence });
  if (!execution || Object.keys(execution).sort().join(",") !== "callbacks,elapsedMs,leaseDurationMs,restartResult,workerResult" ||
      !Number.isSafeInteger(execution.elapsedMs) || execution.elapsedMs < 0 || !Number.isSafeInteger(execution.leaseDurationMs) ||
      execution.leaseDurationMs < 1 || execution.leaseDurationMs > DEFAULT_LEASE_MS || execution.elapsedMs >= execution.leaseDurationMs ||
      !same(execution.callbacks, expectedAuctionCallbacks(evidence)) || !same(execution.workerResult, expectedAuctionWorkerResult()) ||
      !same(execution.restartResult, expectedAuctionWorkerResult(true))) fail("RECOVERY_AUCTION_EXECUTION_EVIDENCE_INVALID");
  const { review, identifiers } = evidence, decisionChecksum = hash(canonicalize(decision));
  const metadata = { metadata_key: `recovery_auction_review:${decision.reconciliationId}`,
    metadata_value: canonicalize({ recoveryId: review.recoveryId, planChecksum: review.planChecksum, reviewChecksum: review.reportChecksum,
      decisionChecksum, decision, identifiers, executedAtMs: review.observedAtMs, execution,
      domainSnapshotSha256: hash(canonicalize(evidence.tableSnapshots)) }), created_at_ms: review.observedAtMs, updated_at_ms: review.observedAtMs };
  const audit = { id: decision.reconciliationId, event_type: "recovery.auction_reconciled", outcome: "success", actor_user_id: decision.reviewedByUserId,
    target_user_id: null, league_id: review.leagueId, session_id: null, request_correlation_id: review.recoveryId,
    reason_code: `auction_reconciled_${decisionChecksum}`, network_key_version: null, network_metadata_digest: null,
    unknown_account_digest: null, client_metadata_json: '{"networkSourceCategory":"local"}', occurred_at_ms: review.observedAtMs };
  return { metadata, audit, decisionChecksum, expected: { ...evidence.expected,
    application_metadata: [...evidence.expected.application_metadata, metadata], security_audit_events: [...evidence.expected.security_audit_events, audit] } };
}
module.exports = { RecoveryAuctionReconciliationError, fail, hash, same, validateAuctionDecision, expectedAuctionCallbacks,
  expectedAuctionWorkerResult, buildRecoveryAuctionAttribution };
