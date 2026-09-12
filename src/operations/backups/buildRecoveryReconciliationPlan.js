const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { RECOVERY_HOLD_KEY } = require("../../infrastructure/database/recoveryHold");
const { assertDatabaseIdentity } = require("../../infrastructure/database/databaseIdentity");
const { readRecoveryEpoch } = require("../../infrastructure/database/recoveryEpoch");
const { nextRecoveryEpoch } = require("../../domain/recovery/recoveryEpochPolicy");

const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const JOB_STATES = new Set(["pending", "leased", "running", "succeeded", "failed", "skipped"]);
const OUTBOX_STATES = new Set(["pending", "publishing", "published", "failed", "discarded"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

class RecoveryReconciliationPlanError extends Error {
  constructor(code) {
    super("A recovery reconciliation plan requires an unchanged, verified and held candidate.");
    this.name = "RecoveryReconciliationPlanError";
    this.code = code;
  }
}
function fail(code) { throw new RecoveryReconciliationPlanError(code); }
function unchangedFile(database, expectedHash) {
  // A byte-identical main file is insufficient if uncheckpointed WAL pages
  // can supply a different logical database. Planning requires an offline copy.
  const wal = `${database.name}-wal`;
  if ((fs.existsSync(wal) && fs.statSync(wal).size !== 0) ||
      fs.existsSync(`${database.name}-journal`) || hash(fs.readFileSync(database.name)) !== expectedHash) {
    fail("RECOVERY_PLAN_SOURCE_CHANGED");
  }
}

// This is a review artifact, never a command or permission to replay work.
// Payloads, credentials, client keys, lease tokens and provider results remain
// in the held database. Row hashes bind later decisions to their exact content.
function buildRecoveryReconciliationPlan({ database, credentialPreparation, observedAtMs, expectedEnvironmentId, expectedDatabaseId } = {}) {
  if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
      !Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || !credentialPreparation ||
      !IDENTITY.test(expectedEnvironmentId || "") || !IDENTITY.test(expectedDatabaseId || "") ||
      credentialPreparation.reportVersion !== 5 || credentialPreparation.status !== "credentials-prepared" ||
      credentialPreparation.activationReady !== false || credentialPreparation.normalRuntime !== "blocked-by-durable-recovery-hold" ||
      !UUID.test(credentialPreparation.recoveryId || "") || !UUID.test(credentialPreparation.sourceBackupId || "") ||
      !Number.isSafeInteger(credentialPreparation.preparedAtMs) || observedAtMs < credentialPreparation.preparedAtMs ||
      ![credentialPreparation.reportChecksum, credentialPreparation.sourcePlaintextSha256,
        credentialPreparation.preparedPlaintextSha256].every(value => DIGEST.test(value || ""))) {
    fail("RECOVERY_PLAN_INPUT_INVALID");
  }
  const { preparedDatabasePath, inspection, reportChecksum, ...receipt } = credentialPreparation;
  if (hash(canonicalize(receipt)) !== reportChecksum) fail("RECOVERY_PLAN_RECEIPT_INVALID");
  try {
    unchangedFile(database, receipt.preparedPlaintextSha256);
    const initialChanges = database.prepare("SELECT total_changes() AS count").get().count;
    const plan = database.transaction(() => {
      const hold = database.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY);
      const expectedHold = canonicalize({ recoveryId: receipt.recoveryId, sourceBackupId: receipt.sourceBackupId,
        sourcePlaintextSha256: receipt.sourcePlaintextSha256, recoveryEpoch: receipt.recoveryEpoch, state: "held" });
      if (hold?.metadata_value !== expectedHold) fail("RECOVERY_PLAN_HOLD_INVALID");
      const recoveryEpoch = nextRecoveryEpoch(receipt.previousRecoveryEpoch, receipt.recoveryId);
      if (canonicalize(recoveryEpoch) !== canonicalize(receipt.recoveryEpoch) ||
          canonicalize(readRecoveryEpoch(database)) !== canonicalize(recoveryEpoch)) fail("RECOVERY_PLAN_EPOCH_INVALID");
      const databaseIdentity = { environmentId: expectedEnvironmentId, databaseId: expectedDatabaseId };
      assertDatabaseIdentity(database, databaseIdentity);
      const audit = database.prepare("SELECT * FROM security_audit_events WHERE id=?").get(receipt.recoveryId);
      if (audit?.event_type !== "recovery.credentials_invalidated" || audit.outcome !== "success" ||
          audit.reason_code !== `restore_${receipt.sourceBackupId}_${receipt.sourcePlaintextSha256}` ||
          audit.occurred_at_ms !== receipt.preparedAtMs ||
          database.prepare("SELECT 1 FROM sessions WHERE status='active' LIMIT 1").get() ||
          database.prepare("SELECT 1 FROM account_action_tokens WHERE status='active' LIMIT 1").get()) {
        fail("RECOVERY_PLAN_CREDENTIAL_BOUNDARY_INVALID");
      }
      const invalidatedLeases = database.prepare("SELECT * FROM job_runs WHERE status IN ('leased','running') ORDER BY id").all();
      if (receipt.jobOccurrences !== "preserved-and-held" ||
          receipt.restoredJobLeasesInvalidated !== invalidatedLeases.length ||
          !DIGEST.test(receipt.restoredJobLeaseEvidenceSha256 || "") ||
          invalidatedLeases.some(row => row.lease_owner !== null || row.lease_token !== null ||
            row.lease_expires_at_ms !== receipt.preparedAtMs || row.updated_at_ms !== receipt.preparedAtMs || row.version < 2)) {
        fail("RECOVERY_PLAN_LEASE_BOUNDARY_INVALID");
      }
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const tableSnapshots = Object.fromEntries(tables.map(({ name }) => {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_PLAN_STATE_INVALID");
        const rows = database.prepare(`SELECT * FROM "${name}"`).all();
        return [name, { count: rows.length, sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) }];
      }));
      const jobs = database.prepare("SELECT * FROM job_runs ORDER BY id").all().map(row => {
        if (!JOB_STATES.has(row.status)) fail("RECOVERY_PLAN_STATE_INVALID");
        const terminal = ["succeeded", "skipped"].includes(row.status);
        return Object.freeze({ id: row.id, leagueId: row.league_id, jobType: row.job_type,
          occurrenceKey: row.occurrence_key, status: row.status, version: row.version,
          rowSha256: hash(canonicalize(row)), scheduledForMs: row.scheduled_for_ms,
          leaseExpired: ["leased", "running"].includes(row.status) && Number.isSafeInteger(row.lease_expires_at_ms)
            ? row.lease_expires_at_ms <= observedAtMs : null,
          disposition: terminal ? "preserve-recorded-result" : "held-awaiting-occurrence-evidence",
          executionPermitted: false });
      });
      const outbox = database.prepare("SELECT * FROM outbox_events ORDER BY id").all().map(row => {
        if (!OUTBOX_STATES.has(row.status)) fail("RECOVERY_PLAN_STATE_INVALID");
        const terminal = ["published", "discarded"].includes(row.status);
        return Object.freeze({ id: row.id, leagueId: row.league_id, eventType: row.event_type,
          channel: row.league_id === null ? "account-email" : "league-notification",
          status: row.status, version: row.version, rowSha256: hash(canonicalize(row)),
          disposition: terminal ? "preserve-recorded-result" : "held-awaiting-delivery-evidence",
          deliveryPermitted: false });
      });
      return { planVersion: 2, recoveryId: receipt.recoveryId, recoveryEpoch, sourceBackupId: receipt.sourceBackupId,
        sourcePlaintextSha256: receipt.sourcePlaintextSha256, preparedPlaintextSha256: receipt.preparedPlaintextSha256,
        credentialPreparationChecksum: reportChecksum, observedAtMs, databaseIdentity,
        schemaVersion: database.pragma("user_version", { simple: true }), tableSnapshots,
        snapshotSha256: hash(canonicalize(tableSnapshots)), jobs, outbox,
        unresolvedJobs: jobs.filter(row => row.disposition === "held-awaiting-occurrence-evidence").length,
        unresolvedMessages: outbox.filter(row => row.disposition === "held-awaiting-delivery-evidence").length,
        remainingGates: ["recovery-epoch-and-idempotency-boundary", "exact-job-and-outbox-dispositions",
          "financial-and-league-state-reconciliation", "post-reconciliation-backup", "controlled-reopening"],
        activationReady: false, executable: false };
    }).deferred();
    unchangedFile(database, receipt.preparedPlaintextSha256);
    if (database.prepare("SELECT total_changes() AS count").get().count !== initialChanges) fail("RECOVERY_PLAN_WRITE_DETECTED");
    return Object.freeze({ ...plan, planChecksum: hash(canonicalize(plan)) });
  } catch (error) {
    if (error instanceof RecoveryReconciliationPlanError) throw error;
    fail("RECOVERY_PLAN_FAILED");
  }
}

module.exports = { RecoveryReconciliationPlanError, buildRecoveryReconciliationPlan };
