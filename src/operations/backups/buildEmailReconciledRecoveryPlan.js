const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { CLEARED_PAYLOAD_JSON } = require("../../infrastructure/persistence/sqlite/SqliteOutboxEventRepository");
const { buildRecoveryReconciliationPlan } = require("./buildRecoveryReconciliationPlan");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const same = (left, right) => canonicalize(left) === canonicalize(right);
const fingerprint = rows => ({ count: rows.length, sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) });
class EmailReconciledRecoveryPlanError extends Error {
  constructor(code) {
    super("The next recovery plan requires the exact original and email-reconciled held candidates.");
    this.name = "EmailReconciledRecoveryPlanError"; this.code = code;
  }
}
function fail(code) { throw new EmailReconciledRecoveryPlanError(code); }
function unchanged(database, digest) {
  if (hash(fs.readFileSync(database.name)) !== digest ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`)) fail("RECOVERY_RECONCILED_SOURCE_CHANGED");
}

// Revalidates both physical candidates and their exact permitted delta. This
// report grants no delivery, job execution, hold removal or activation authority.
function buildEmailReconciledRecoveryPlan({ preparedDatabase, reconciledDatabase, credentialPreparation,
  originalPlan, emailReconciliation, observedAtMs } = {}) {
  if ([preparedDatabase, reconciledDatabase].some(database => !database?.open || database.readonly !== true ||
      database.inTransaction || !path.isAbsolute(database.name || "")) ||
      !Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || originalPlan?.planVersion !== 2 ||
      emailReconciliation?.reportVersion !== 1 || emailReconciliation.status !== "email-reconciled-held" ||
      emailReconciliation.activationReady !== false || emailReconciliation.jobs !== "unchanged-and-held" ||
      emailReconciliation.normalRuntime !== "blocked-by-durable-recovery-hold" ||
      emailReconciliation.providerEvidence !== "reviewer-supplied-not-independently-fetched" ||
      !DIGEST.test(emailReconciliation.reconciledPlaintextSha256 || "") ||
      !DIGEST.test(emailReconciliation.reportChecksum || "") ||
      !UUID.test(emailReconciliation.reconciliationId || "") || !UUID.test(emailReconciliation.reviewedByUserId || "") ||
      !Number.isSafeInteger(emailReconciliation.reconciledAtMs) || observedAtMs < emailReconciliation.reconciledAtMs) {
    fail("RECOVERY_RECONCILED_INPUT_INVALID");
  }
  try {
    if (fs.realpathSync(preparedDatabase.name) === fs.realpathSync(reconciledDatabase.name)) fail("RECOVERY_RECONCILED_INPUT_INVALID");
    const verified = buildRecoveryReconciliationPlan({ database: preparedDatabase, credentialPreparation,
      observedAtMs: originalPlan.observedAtMs, expectedEnvironmentId: originalPlan.databaseIdentity?.environmentId,
      expectedDatabaseId: originalPlan.databaseIdentity?.databaseId });
    if (!same(verified, originalPlan)) fail("RECOVERY_RECONCILED_PARENT_INVALID");
    const { reconciledDatabasePath, inspection, reportChecksum, ...email } = emailReconciliation;
    if (hash(canonicalize(email)) !== reportChecksum || email.planChecksum !== verified.planChecksum ||
        email.sourcePlaintextSha256 !== verified.preparedPlaintextSha256 || email.recoveryId !== verified.recoveryId ||
        !same(email.recoveryEpoch, verified.recoveryEpoch) || email.reconciledAtMs < verified.observedAtMs ||
        !Array.isArray(email.deliveries) || email.deliveries.length < 1 || email.deliveries.length > 1000 ||
        email.suppressedMessages !== email.deliveries.length || hash(canonicalize(email.deliveries)) !== email.decisionChecksum) {
      fail("RECOVERY_RECONCILED_RECEIPT_INVALID");
    }
    unchanged(reconciledDatabase, email.reconciledPlaintextSha256);
    const initialChanges = reconciledDatabase.prepare("SELECT total_changes() n").get().n;
    const result = reconciledDatabase.transaction(() => {
      if (!same(reconciledDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]) ||
          reconciledDatabase.pragma("foreign_key_check").length !== 0) fail("RECOVERY_RECONCILED_INTEGRITY_INVALID");
      const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
      if (reconciledDatabase.pragma("user_version", { simple: true }) !== verified.schemaVersion ||
          !same(preparedDatabase.prepare(schemaSql).all(), reconciledDatabase.prepare(schemaSql).all())) fail("RECOVERY_RECONCILED_SCHEMA_INVALID");
      const names = Object.keys(verified.tableSnapshots).sort();
      const rows = database => Object.fromEntries(names.map(name => {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_RECONCILED_SCHEMA_INVALID");
        return [name, database.prepare(`SELECT * FROM "${name}"`).all()];
      }));
      const before = rows(preparedDatabase), after = rows(reconciledDatabase);
      if (!preparedDatabase.prepare("SELECT 1 FROM users u JOIN platform_roles r ON r.user_id=u.id WHERE u.id=? AND u.status='active' AND r.role='platform_administrator' AND r.status='active'").get(email.reviewedByUserId)) fail("RECOVERY_RECONCILED_REVIEWER_INVALID");
      const decisions = new Map(email.deliveries.map(item => [item.eventId, item]));
      if (decisions.size !== email.deliveries.length) fail("RECOVERY_RECONCILED_RECEIPT_INVALID");
      let matched = 0;
      const expectedOutbox = before.outbox_events.map(row => {
        const decision = decisions.get(row.id); if (!decision) return row;
        if (row.league_id !== null || !["pending", "publishing", "failed"].includes(row.status) ||
            hash(canonicalize(row)) !== decision.rowSha256 || hash(row.payload_json) !== decision.payloadSha256 ||
            ![decision.providerMessageSha256, decision.providerReceiptSha256].every(value => DIGEST.test(value || "")) ||
            !Number.isSafeInteger(decision.deliveredAtMs) || decision.deliveredAtMs < row.created_at_ms ||
            decision.deliveredAtMs > email.reconciledAtMs || row.updated_at_ms > email.reconciledAtMs ||
            !Number.isSafeInteger(row.version + 1)) fail("RECOVERY_RECONCILED_DELIVERY_INVALID");
        matched++;
        return { ...row, status: "discarded", payload_json: CLEARED_PAYLOAD_JSON,
          last_error_code: "RECOVERY_DELIVERY_RECONCILED", updated_at_ms: email.reconciledAtMs, version: row.version + 1 };
      });
      if (matched !== decisions.size) fail("RECOVERY_RECONCILED_DELIVERY_INVALID");
      const metadataKey = `recovery_email_review:${email.reconciliationId}`;
      const expectedMetadata = { metadata_key: metadataKey, metadata_value: canonicalize({ recoveryId: verified.recoveryId,
        reconciliationId: email.reconciliationId, reviewedByUserId: email.reviewedByUserId, reconciledAtMs: email.reconciledAtMs,
        planChecksum: verified.planChecksum, decisionChecksum: email.decisionChecksum, deliveries: email.deliveries }),
        created_at_ms: email.reconciledAtMs, updated_at_ms: email.reconciledAtMs };
      const expectedAudit = { id: email.reconciliationId, event_type: "recovery.email_reconciled", outcome: "success",
        actor_user_id: email.reviewedByUserId, target_user_id: null, league_id: null, session_id: null,
        request_correlation_id: verified.recoveryId, reason_code: `delivery_${email.decisionChecksum}`, network_key_version: null,
        network_metadata_digest: null, unknown_account_digest: null, client_metadata_json: '{"networkSourceCategory":"local"}', occurred_at_ms: email.reconciledAtMs };
      const expected = { ...before, outbox_events: expectedOutbox, application_metadata: [...before.application_metadata, expectedMetadata],
        security_audit_events: [...before.security_audit_events, expectedAudit] };
      const tableSnapshots = Object.fromEntries(names.map(name => [name, fingerprint(after[name])]));
      if (names.some(name => !same(fingerprint(expected[name]), tableSnapshots[name])) ||
          !same(tableSnapshots, email.tableSnapshots) || email.protectedTableCount !== names.length - 3) fail("RECOVERY_RECONCILED_DELTA_INVALID");
      const byId = new Map(after.outbox_events.map(row => [row.id, row]));
      const outbox = verified.outbox.map(entry => {
        const row = byId.get(entry.id); const terminal = ["published", "discarded"].includes(row.status);
        return { ...entry, status: row.status, version: row.version, rowSha256: hash(canonicalize(row)),
          disposition: terminal ? "preserve-recorded-result" : "held-awaiting-delivery-evidence", deliveryPermitted: false };
      });
      const unresolvedMessages = outbox.filter(row => row.disposition === "held-awaiting-delivery-evidence").length;
      if (unresolvedMessages !== email.unresolvedMessages) fail("RECOVERY_RECONCILED_RECEIPT_INVALID");
      const { planChecksum, ...parent } = verified;
      return { ...parent, planVersion: 3, observedAtMs, previousPlanChecksum: planChecksum,
        credentialPreparedPlaintextSha256: verified.preparedPlaintextSha256, preparedPlaintextSha256: email.reconciledPlaintextSha256,
        emailReconciliationChecksum: reportChecksum, tableSnapshots, snapshotSha256: hash(canonicalize(tableSnapshots)),
        outbox, unresolvedMessages, activationReady: false, executable: false };
    }).deferred();
    unchanged(preparedDatabase, credentialPreparation.preparedPlaintextSha256);
    unchanged(reconciledDatabase, email.reconciledPlaintextSha256);
    if (reconciledDatabase.prepare("SELECT total_changes() n").get().n !== initialChanges) fail("RECOVERY_RECONCILED_WRITE_DETECTED");
    return Object.freeze({ ...result, planChecksum: hash(canonicalize(result)) });
  } catch (error) {
    if (error instanceof EmailReconciledRecoveryPlanError) throw error;
    fail("RECOVERY_RECONCILED_VERIFICATION_FAILED");
  }
}

module.exports = { EmailReconciledRecoveryPlanError, buildEmailReconciledRecoveryPlan };
