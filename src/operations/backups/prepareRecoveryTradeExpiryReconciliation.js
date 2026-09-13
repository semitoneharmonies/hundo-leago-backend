const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryPlanFromLineage } = require("./buildRecoveryReconciliationLineage");
const { createSqliteTradeExpiryRepository } = require("../../infrastructure/persistence/sqlite/SqliteTradeExpiryRepository");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createExpireTradeProposalsJob, DEFAULT_LEASE_MS } = require("../../jobs/definitions/expireTradeProposals");
const { RecoveryTradeExpiryError, fail, hash, same, snapshots, readRows, safeTime, validateDecision,
  expectedTradeExpiryRows, CHANGED_TABLES } = require("./recoveryTradeExpiryEvidence");

const hashFile = file => hash(fs.readFileSync(file));
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function exists(entry) {
  try { fs.lstatSync(entry); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function assertSource(source, digest) {
  if (["-wal", "-shm", "-journal"].some(suffix => exists(`${source}${suffix}`)) || hashFile(source) !== digest) fail("RECOVERY_TRADE_SOURCE_CHANGED");
}

// An offline derivative only. Administrator identity, league deadline review
// and loss-window evidence are operator supplied, not current authentication.
// This never activates a database, releases its hold or delivers messages.
async function prepareRecoveryTradeExpiryReconciliation({ credentialPreparation, plan, review, executedAtMs,
  temporaryRoot, outputDirectory, lineage = null, beforeReceipt = null } = {}) {
  validateDecision(review);
  if (!safeTime(executedAtMs) || !safeTime(executedAtMs + DEFAULT_LEASE_MS) ||
      !path.isAbsolute(temporaryRoot || "") || !path.isAbsolute(outputDirectory || "") ||
      !path.isAbsolute(credentialPreparation?.preparedDatabasePath || "") ||
      !/^[a-f0-9]{64}$/.test(plan?.planChecksum || "") || !/^[a-f0-9]{64}$/.test(plan?.preparedPlaintextSha256 || "") ||
      (beforeReceipt !== null && typeof beforeReceipt !== "function")) fail("RECOVERY_TRADE_INPUT_INVALID");
  let ownedDirectory = null, physicalRoot, database;
  try {
    const decision = Object.freeze({ ...review }), credential = JSON.parse(JSON.stringify(credentialPreparation));
    const originalPlan = JSON.parse(JSON.stringify(plan)), lineageEvidence = lineage === null ? null : JSON.parse(JSON.stringify(lineage));
    physicalRoot = fs.realpathSync(temporaryRoot);
    const source = fs.realpathSync(credential.preparedDatabasePath);
    const output = path.join(fs.realpathSync(path.dirname(outputDirectory)), path.basename(outputDirectory));
    if (!inside(fs.realpathSync(os.tmpdir()), physicalRoot) || !inside(physicalRoot, source) || !inside(physicalRoot, output) ||
        fs.lstatSync(credential.preparedDatabasePath).isSymbolicLink() || !fs.statSync(source).isFile() ||
        fs.statSync(source).nlink !== 1 || exists(output)) fail("RECOVERY_TRADE_PATH_UNSAFE");
    assertSource(source, originalPlan.preparedPlaintextSha256);
    fs.mkdirSync(output, { recursive: false, mode: 0o700 }); ownedDirectory = output;
    const candidatePath = path.join(output, "trade-expiry-reconciled.sqlite3");
    fs.copyFileSync(source, candidatePath, fs.constants.COPYFILE_EXCL); fs.chmodSync(candidatePath, 0o600);
    database = openReadonlyDatabase({ databasePath: candidatePath });
    const verifiedPlan = buildRecoveryPlanFromLineage({ database, credentialPreparation: credential, lineage: lineageEvidence,
      observedAtMs: originalPlan.observedAtMs, expectedEnvironmentId: originalPlan.databaseIdentity?.environmentId,
      expectedDatabaseId: originalPlan.databaseIdentity?.databaseId });
    if (!same(verifiedPlan, originalPlan) || executedAtMs < verifiedPlan.observedAtMs) fail("RECOVERY_TRADE_PLAN_INVALID");
    const before = readRows(database), eventId = crypto.randomUUID();
    const evidence = expectedTradeExpiryRows({ before, decision, executedAtMs, eventId, plan: verifiedPlan });
    const { job, trade, metadata, audit } = evidence;
    const selected = verifiedPlan.jobs.find(row => row.id === job.id);
    if (selected?.disposition !== "held-awaiting-occurrence-evidence" || verifiedPlan.unresolvedJobs < 1 ||
        !same(snapshots(before), verifiedPlan.tableSnapshots)) fail("RECOVERY_TRADE_PLAN_INVALID");
    database.close(); database = null;
    database = openDatabase({ databasePath: candidatePath, environment: "staging", persistentRoot: physicalRoot, requirePersistentRoot: true }).database;
    if (!same(snapshots(readRows(database)), verifiedPlan.tableSnapshots)) fail("RECOVERY_TRADE_SOURCE_CHANGED");
    const repository = createSqliteTradeExpiryRepository({ database }), generatedIds = [crypto.randomUUID(), eventId];
    const startedMonotonic = performance.now();
    const worker = createExpireTradeProposalsJob({
      repository: { ...repository,
        // Select from actual current data by the reviewed ID, independent of
        // unrelated due-job volume or a batch limit. The repository still
        // validates the occurrence and current claim inside its transaction.
        listDue() {
          const current = database.prepare("SELECT * FROM trades WHERE id=?").get(trade.id);
          if (!same(current, trade)) fail("RECOVERY_TRADE_SOURCE_CHANGED");
          return [{ tradeId: trade.id, leagueId: trade.league_id, seasonId: trade.season_id,
            effectiveDeadlineAtMs: trade.effective_deadline_at_ms, tradeVersion: trade.version }];
        },
        claimRun(command) {
          const claim = repository.claimRun(command);
          if (!claim.acquired || claim.runId !== job.id || claim.version !== job.version + 1) fail("RECOVERY_TRADE_LEASE_UNAVAILABLE");
          return claim;
        },
      },
      // All domain writes are synchronous with one attributed operation time.
      clock: { nowMs: () => executedAtMs }, secureRandom: { id: () => generatedIds.shift() },
      leaseOwner: `recovery:${decision.reconciliationId}`, logger: { error() {} },
    });
    const result = await worker.run();
    if (!same(result, { job: "trades:expire:target", status: "succeeded", due: 1, acquired: 1,
      expired: 1, terminal: 0, failed: 0, skipped: 0 }) || generatedIds.length !== 0 ||
      performance.now() - startedMonotonic >= DEFAULT_LEASE_MS) fail("RECOVERY_TRADE_EXECUTION_FAILED");
    database.transaction(() => {
      database.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(metadata);
      createSqliteSecurityAuditRepository({ database }).append(audit);
    }).immediate();
    if (beforeReceipt && beforeReceipt(database)?.then) fail("RECOVERY_TRADE_INPUT_INVALID");
    const tableSnapshots = snapshots(readRows(database));
    if (!same(tableSnapshots, snapshots(evidence.expected)) || database.pragma("foreign_key_check").length !== 0 ||
        !same(database.pragma("integrity_check"), [{ integrity_check: "ok" }])) fail("RECOVERY_TRADE_POSTCHECK_FAILED");
    assertSource(source, originalPlan.preparedPlaintextSha256);
    database.close(); database = null;
    const inspection = inspectDatabase(candidatePath);
    assertSource(source, originalPlan.preparedPlaintextSha256);
    const report = { reportVersion: 1, status: "trade-expiry-reconciled-held", recoveryId: verifiedPlan.recoveryId,
      recoveryEpoch: verifiedPlan.recoveryEpoch, planChecksum: verifiedPlan.planChecksum,
      sourcePlaintextSha256: verifiedPlan.preparedPlaintextSha256, reconciledPlaintextSha256: hashFile(candidatePath),
      decision, decisionChecksum: evidence.decisionChecksum, executedAtMs, eventId, createdOutboxId: evidence.message.id,
      completedJobId: job.id, completedJobRowSha256: hash(canonicalize(evidence.completedJob)), tableSnapshots,
      unresolvedJobs: verifiedPlan.unresolvedJobs - 1, unresolvedMessages: verifiedPlan.unresolvedMessages + 1,
      protectedTableCount: Object.keys(before).filter(name => !CHANGED_TABLES.includes(name)).length,
      sourceDatabase: "unchanged", otherJobs: "unchanged-and-held", previousMessages: "unchanged-and-held",
      createdMessage: "pending-and-held", reviewEvidence: "operator-supplied-not-current-authentication",
      normalRuntime: "blocked-by-durable-recovery-hold", activationReady: false };
    const receipt = { ...report, reportChecksum: hash(canonicalize(report)) };
    fs.writeFileSync(path.join(output, "trade-expiry-reconciliation.json"), `${canonicalize(receipt)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ ...receipt, reconciledDatabasePath: candidatePath, inspection });
  } catch (error) {
    try {
      if (database?.open) database.close();
      if (ownedDirectory !== null) {
        if (!inside(physicalRoot, fs.realpathSync(ownedDirectory)) || fs.lstatSync(ownedDirectory).isSymbolicLink()) fail("RECOVERY_TRADE_CLEANUP_FAILED");
        fs.rmSync(ownedDirectory, { recursive: true, force: false });
      }
    } catch { fail("RECOVERY_TRADE_CLEANUP_FAILED"); }
    if (error instanceof RecoveryTradeExpiryError) throw error;
    fail("RECOVERY_TRADE_FAILED");
  }
}
module.exports = { prepareRecoveryTradeExpiryReconciliation };
