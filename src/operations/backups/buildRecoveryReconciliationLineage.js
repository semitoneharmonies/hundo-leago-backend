const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryReconciliationPlan } = require("./buildRecoveryReconciliationPlan");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (left,right) => canonicalize(left) === canonicalize(right);
// Tokens never leave the synchronous lineage walk. Only a plan just rebuilt
// from its actual predecessor can reach a delta verifier through this map.
const parents = new WeakMap();
class RecoveryLineageError extends Error {
  constructor(code) {
    super("Recovery requires the complete unchanged sequence of held candidates and exact reconciliation receipts.");
    this.name = "RecoveryLineageError";this.code = code;
  }
}
function fail(code) { throw new RecoveryLineageError(code); }
function exact(value,fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) fail("RECOVERY_LINEAGE_INPUT_INVALID");
}
function assertReader(database,digest) {
  if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
      !fs.statSync(database.name).isFile() || fs.statSync(database.name).nlink !== 1 ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`)) fail("RECOVERY_LINEAGE_SOURCE_INVALID");
  const actual = hash(fs.readFileSync(database.name));
  if (digest !== undefined && actual !== digest) fail("RECOVERY_LINEAGE_SOURCE_CHANGED");
  return actual;
}

// Internal verifier boundary: no caller-created object, receipt checksum or
// JSON field can substitute for a predecessor verified in the current walk.
function readVerifiedRecoveryParent({ parentProof,database,originalPlan,credentialPreparation }) {
  const entry = parents.get(parentProof);
  if (!entry || entry.database !== database || entry.plan !== originalPlan ||
      entry.credentialChecksum !== credentialPreparation?.reportChecksum) fail("RECOVERY_LINEAGE_PARENT_INVALID");
  assertReader(database,entry.plan.preparedPlaintextSha256);
  return entry.plan;
}

function buildRecoveryReconciliationLineage({ initialDatabase,credentialPreparation,initialPlan,steps } = {}) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 32 || initialPlan?.planVersion !== 2) fail("RECOVERY_LINEAGE_INPUT_INVALID");
  try {
    const readers = [initialDatabase,...steps.map(step => {
      exact(step,["kind","reconciledDatabase","receipt","observedAtMs"]);
      if (!["email","statistics","invalidation","trade-expiry"].includes(step.kind) || !Number.isSafeInteger(step.observedAtMs) || step.observedAtMs < 0) fail("RECOVERY_LINEAGE_INPUT_INVALID");
      return step.reconciledDatabase;
    })];
    const paths = readers.map(database => { assertReader(database);return fs.realpathSync(database.name); });
    if (new Set(paths).size !== paths.length) fail("RECOVERY_LINEAGE_SOURCE_REUSED");
    const before = readers.map(database => ({ digest: assertReader(database),changes: database.prepare("SELECT total_changes() n").get().n }));
    let plan = buildRecoveryReconciliationPlan({ database: initialDatabase,credentialPreparation,observedAtMs: initialPlan.observedAtMs,
      expectedEnvironmentId: initialPlan.databaseIdentity?.environmentId,expectedDatabaseId: initialPlan.databaseIdentity?.databaseId });
    if (!same(plan,initialPlan)) fail("RECOVERY_LINEAGE_PARENT_INVALID");
    const receipts = new Set(),reviews = new Set();
    for (const [index,step] of steps.entries()) {
      const reviewId = ["statistics","trade-expiry"].includes(step.kind) ? step.receipt?.decision?.reconciliationId : step.receipt?.reconciliationId;
      if (!reviewId || !step.receipt?.reportChecksum || reviews.has(reviewId) || receipts.has(step.receipt.reportChecksum) ||
          step.observedAtMs < plan.observedAtMs) fail("RECOVERY_LINEAGE_RECEIPT_REUSED");
      reviews.add(reviewId);receipts.add(step.receipt.reportChecksum);
      const parentProof = Object.freeze({});
      parents.set(parentProof,{ database: readers[index],plan,credentialChecksum: credentialPreparation.reportChecksum });
      try {
        // Lazy imports keep the public single-step verifiers usable on their
        // own without exposing a constructor for verified-parent tokens.
        let verify,receiptField;
        if (step.kind === "email") { verify = require("./buildEmailReconciledRecoveryPlan").buildEmailReconciledRecoveryPlan;receiptField = "emailReconciliation"; }
        else if (step.kind === "statistics") { verify = require("./buildStatisticsReconciledRecoveryPlan").buildStatisticsReconciledRecoveryPlan;receiptField = "statisticsReconciliation"; }
        else if (step.kind === "trade-expiry") { verify = require("./buildTradeExpiryReconciledRecoveryPlan").buildTradeExpiryReconciledRecoveryPlan;receiptField = "tradeExpiryReconciliation"; }
        else { verify = require("./buildInvalidationReconciledRecoveryPlan").buildInvalidationReconciledRecoveryPlan;receiptField = "invalidationReconciliation"; }
        plan = verify({ preparedDatabase: readers[index],reconciledDatabase: readers[index+1],credentialPreparation,
          originalPlan: plan,parentProof,observedAtMs: step.observedAtMs,[receiptField]: step.receipt });
      } finally { parents.delete(parentProof); }
    }
    for (const [index,database] of readers.entries()) {
      assertReader(database,before[index].digest);
      if (database.prepare("SELECT total_changes() n").get().n !== before[index].changes) fail("RECOVERY_LINEAGE_WRITE_DETECTED");
    }
    return plan;
  } catch (error) {
    if (error instanceof RecoveryLineageError) throw error;
    fail("RECOVERY_LINEAGE_VERIFICATION_FAILED");
  }
}

// File descriptors are JSON evidence, never callbacks or authority. Use exact
// inspection copies: SQLite readers may create empty reader sidecars there.
function buildRecoveryPlanFromLineage({ database,credentialPreparation,lineage = null,observedAtMs,expectedEnvironmentId,expectedDatabaseId } = {}) {
  if (lineage === null) return buildRecoveryReconciliationPlan({ database,credentialPreparation,observedAtMs,expectedEnvironmentId,expectedDatabaseId });
  const readers = [];
  try {
    const currentHash = assertReader(database),changes = database.prepare("SELECT total_changes() n").get().n;
    exact(lineage,["initialDatabasePath","initialPlan","steps"]);
    if (!Array.isArray(lineage.steps) || lineage.steps.length < 1 || lineage.steps.length > 32) fail("RECOVERY_LINEAGE_INPUT_INVALID");
    const open = file => {
      if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file) || !fs.statSync(file).isFile() ||
          (fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size !== 0) || fs.existsSync(`${file}-journal`)) fail("RECOVERY_LINEAGE_SOURCE_INVALID");
      const reader = openReadonlyDatabase({ databasePath: file });readers.push(reader);return reader;
    };
    const initialDatabase = open(lineage.initialDatabasePath);
    const steps = lineage.steps.map(step => {
      exact(step,["kind","reconciledDatabasePath","receipt","observedAtMs"]);
      return { kind: step.kind,reconciledDatabase: open(step.reconciledDatabasePath),receipt: step.receipt,observedAtMs: step.observedAtMs };
    });
    const plan = buildRecoveryReconciliationLineage({ initialDatabase,credentialPreparation,initialPlan: lineage.initialPlan,steps });
    if (plan.observedAtMs !== observedAtMs || plan.databaseIdentity.environmentId !== expectedEnvironmentId ||
        plan.databaseIdentity.databaseId !== expectedDatabaseId || plan.preparedPlaintextSha256 !== currentHash) fail("RECOVERY_LINEAGE_CANDIDATE_MISMATCH");
    assertReader(database,currentHash);
    if (database.prepare("SELECT total_changes() n").get().n !== changes) fail("RECOVERY_LINEAGE_WRITE_DETECTED");
    return plan;
  } catch (error) {
    if (error instanceof RecoveryLineageError) throw error;
    fail("RECOVERY_LINEAGE_VERIFICATION_FAILED");
  } finally { for (const reader of readers.reverse()) if (reader.open) reader.close(); }
}

module.exports = { RecoveryLineageError,buildRecoveryReconciliationLineage,buildRecoveryPlanFromLineage,readVerifiedRecoveryParent };
