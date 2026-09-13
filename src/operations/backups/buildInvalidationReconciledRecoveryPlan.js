const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryReconciliationPlan } = require("./buildRecoveryReconciliationPlan");
const { readVerifiedRecoveryParent } = require("./buildRecoveryReconciliationLineage");
const { UUID,DIGEST,DISPOSITION,RecoveryInvalidationError,fail,hash,fingerprint,validateInvalidationDecisions,
  readReviewedInvalidations,suppressedInvalidation,invalidationReviewRecords } = require("./recoveryInvalidationPolicy");
const same = (left,right) => canonicalize(left) === canonicalize(right);
function unchanged(database,digest) {
  if (hash(fs.readFileSync(database.name)) !== digest || (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`)) fail("RECOVERY_INVALIDATION_PLAN_SOURCE_CHANGED");
}
function buildInvalidationReconciledRecoveryPlan({ preparedDatabase,reconciledDatabase,credentialPreparation,originalPlan,
  invalidationReconciliation,observedAtMs,parentProof } = {}) {
  const input = invalidationReconciliation;
  if ([preparedDatabase,reconciledDatabase].some(database => !database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "")) ||
      (parentProof === undefined && originalPlan?.planVersion !== 2) || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0 ||
      input?.reportVersion !== 1 || input.status !== "invalidations-reconciled-held" || input.disposition !== DISPOSITION || input.deliveryPerformed !== false ||
      input.reviewEvidence !== "operator-supplied-not-current-authentication" || input.sourceDatabase !== "unchanged" || input.jobs !== "unchanged-and-held" ||
      input.authoritativeNotifications !== "unchanged" || input.normalRuntime !== "blocked-by-durable-recovery-hold" || input.activationReady !== false ||
      ![input.reconciliationId,input.reviewedByUserId].every(value => UUID.test(value || "")) || ![input.reconciledPlaintextSha256,input.reportChecksum].every(value => DIGEST.test(value || "")) ||
      !Number.isSafeInteger(input.reconciledAtMs) || input.reconciledAtMs < 0 || observedAtMs < input.reconciledAtMs) fail("RECOVERY_INVALIDATION_PLAN_INPUT_INVALID");
  try {
    if (fs.realpathSync(preparedDatabase.name) === fs.realpathSync(reconciledDatabase.name)) fail("RECOVERY_INVALIDATION_PLAN_INPUT_INVALID");
    const parent = parentProof !== undefined ? readVerifiedRecoveryParent({ parentProof,database: preparedDatabase,originalPlan,credentialPreparation })
      : buildRecoveryReconciliationPlan({ database: preparedDatabase,credentialPreparation,observedAtMs: originalPlan.observedAtMs,
        expectedEnvironmentId: originalPlan.databaseIdentity?.environmentId,expectedDatabaseId: originalPlan.databaseIdentity?.databaseId });
    if (!same(parent,originalPlan)) fail("RECOVERY_INVALIDATION_PLAN_PARENT_INVALID");
    const { reconciledDatabasePath,inspection,reportChecksum,...receipt } = input;
    const events = validateInvalidationDecisions(receipt.events);
    if (hash(canonicalize(receipt)) !== reportChecksum || !same(events,receipt.events) || receipt.planChecksum !== parent.planChecksum ||
        receipt.sourcePlaintextSha256 !== parent.preparedPlaintextSha256 || receipt.recoveryId !== parent.recoveryId || !same(receipt.recoveryEpoch,parent.recoveryEpoch) ||
        receipt.reconciledAtMs < parent.observedAtMs || receipt.suppressedEvents !== events.length) fail("RECOVERY_INVALIDATION_PLAN_RECEIPT_INVALID");
    unchanged(reconciledDatabase,receipt.reconciledPlaintextSha256);
    const changes = reconciledDatabase.prepare("SELECT total_changes() n").get().n;
    const plan = reconciledDatabase.transaction(() => {
      const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
      if (!same(reconciledDatabase.pragma("integrity_check"),[{ integrity_check: "ok" }]) || reconciledDatabase.pragma("foreign_key_check").length !== 0 ||
          reconciledDatabase.pragma("user_version",{ simple: true }) !== parent.schemaVersion ||
          !same(preparedDatabase.prepare(schemaSql).all(),reconciledDatabase.prepare(schemaSql).all())) fail("RECOVERY_INVALIDATION_PLAN_SCHEMA_INVALID");
      const names = Object.keys(parent.tableSnapshots).sort();
      const read = database => Object.fromEntries(names.map(name => {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_INVALIDATION_PLAN_SCHEMA_INVALID");
        return [name,database.prepare(`SELECT * FROM "${name}"`).all()];
      }));
      const before = read(preparedDatabase),after = read(reconciledDatabase);
      if (!preparedDatabase.prepare("SELECT 1 FROM users u JOIN platform_roles r ON r.user_id=u.id WHERE u.id=? AND u.status='active' AND r.role='platform_administrator' AND r.status='active'").get(receipt.reviewedByUserId)) fail("RECOVERY_INVALIDATION_PLAN_REVIEWER_INVALID");
      const selected = new Set(readReviewedInvalidations(preparedDatabase,events,{ preparedAtMs: credentialPreparation.preparedAtMs,reconciledAtMs: receipt.reconciledAtMs }).map(row => row.id));
      const records = invalidationReviewRecords({ plan: parent,events,reconciliationId: receipt.reconciliationId,reviewedByUserId: receipt.reviewedByUserId,reconciledAtMs: receipt.reconciledAtMs });
      const expected = { ...before,outbox_events: before.outbox_events.map(row => selected.has(row.id) ? suppressedInvalidation(row,receipt.reconciledAtMs) : row),
        application_metadata: [...before.application_metadata,records.metadata],security_audit_events: [...before.security_audit_events,records.audit] };
      const tableSnapshots = Object.fromEntries(names.map(name => [name,fingerprint(after[name])]));
      if (receipt.decisionChecksum !== records.decisionChecksum || receipt.protectedTableCount !== names.length-3 ||
          !same(tableSnapshots,receipt.tableSnapshots) || names.some(name => !same(tableSnapshots[name],fingerprint(expected[name])))) fail("RECOVERY_INVALIDATION_PLAN_DELTA_INVALID");
      const byId = new Map(after.outbox_events.map(row => [row.id,row]));
      const outbox = parent.outbox.map(entry => {
        const row = byId.get(entry.id),terminal = ["published","discarded"].includes(row.status);
        return { ...entry,status: row.status,version: row.version,rowSha256: hash(canonicalize(row)),
          disposition: terminal ? "preserve-recorded-result" : "held-awaiting-delivery-evidence",deliveryPermitted: false };
      });
      const unresolvedMessages = outbox.filter(row => row.disposition === "held-awaiting-delivery-evidence").length;
      if (unresolvedMessages !== receipt.unresolvedMessages || unresolvedMessages !== parent.unresolvedMessages-events.length) fail("RECOVERY_INVALIDATION_PLAN_RECEIPT_INVALID");
      const { planChecksum,...previous } = parent;
      return { ...previous,planVersion: 5,observedAtMs,previousPlanChecksum: planChecksum,credentialPreparedPlaintextSha256: credentialPreparation.preparedPlaintextSha256,
        preparedPlaintextSha256: receipt.reconciledPlaintextSha256,invalidationReconciliationChecksum: reportChecksum,tableSnapshots,
        snapshotSha256: hash(canonicalize(tableSnapshots)),outbox,unresolvedMessages,activationReady: false,executable: false };
    }).deferred();
    unchanged(preparedDatabase,parent.preparedPlaintextSha256);unchanged(reconciledDatabase,receipt.reconciledPlaintextSha256);
    if (reconciledDatabase.prepare("SELECT total_changes() n").get().n !== changes) fail("RECOVERY_INVALIDATION_PLAN_WRITE_DETECTED");
    return Object.freeze({ ...plan,planChecksum: hash(canonicalize(plan)) });
  } catch (error) {
    if (error instanceof RecoveryInvalidationError) throw error;
    fail("RECOVERY_INVALIDATION_PLAN_VERIFICATION_FAILED");
  }
}
module.exports = { buildInvalidationReconciledRecoveryPlan };
