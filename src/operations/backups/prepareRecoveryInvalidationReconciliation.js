const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase,openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { buildRecoveryPlanFromLineage } = require("./buildRecoveryReconciliationLineage");
const { UUID,DIGEST,DISPOSITION,ERROR_CODE,RecoveryInvalidationError,fail,hash,fingerprint,validateInvalidationDecisions,
  readReviewedInvalidations,suppressedInvalidation,invalidationReviewRecords } = require("./recoveryInvalidationPolicy");

const same = (left,right) => canonicalize(left) === canonicalize(right);
const hashFile = file => hash(fs.readFileSync(file));
const inside = (root,target) => { const relative = path.relative(root,target);return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function exists(file) { try { fs.lstatSync(file);return true; } catch (error) { if (error.code === "ENOENT") return false;throw error; } }
function unchanged(file,digest) {
  if (["-wal","-shm","-journal"].some(suffix => exists(file+suffix)) || hashFile(file) !== digest) fail("RECOVERY_INVALIDATION_SOURCE_CHANGED");
}
function allRows(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_INVALIDATION_STATE_INVALID");
    return [name,database.prepare(`SELECT * FROM "${name}"`).all()];
  }));
}

// Suppresses selected restored refresh hints after credential invalidation.
// Authoritative activity/notifications, all other messages and every prior
// database remain untouched. This operation sends nothing and never reopens.
function prepareRecoveryInvalidationReconciliation({ credentialPreparation,plan,events,reviewedByUserId,reconciliationId,reconciledAtMs,
  temporaryRoot,outputDirectory,lineage = null,beforeCommit = null } = {}) {
  if (![reviewedByUserId,reconciliationId].every(value => UUID.test(value || "")) || !Number.isSafeInteger(reconciledAtMs) || reconciledAtMs < 0 ||
      ![temporaryRoot,outputDirectory,credentialPreparation?.preparedDatabasePath].every(value => typeof value === "string" && path.isAbsolute(value)) ||
      ![plan?.preparedPlaintextSha256,plan?.planChecksum].every(value => DIGEST.test(value || "")) ||
      (beforeCommit !== null && typeof beforeCommit !== "function")) fail("RECOVERY_INVALIDATION_INPUT_INVALID");
  const decisions = validateInvalidationDecisions(events);
  let ownedDirectory = null,physicalRoot,database;
  try {
    const credential = JSON.parse(JSON.stringify(credentialPreparation)),originalPlan = JSON.parse(JSON.stringify(plan));
    physicalRoot = fs.realpathSync(temporaryRoot);
    const source = fs.realpathSync(credential.preparedDatabasePath),output = path.join(fs.realpathSync(path.dirname(outputDirectory)),path.basename(outputDirectory));
    if (!inside(fs.realpathSync(os.tmpdir()),physicalRoot) || !inside(physicalRoot,source) || !inside(physicalRoot,output) || exists(output) ||
        fs.lstatSync(credential.preparedDatabasePath).isSymbolicLink() || !fs.statSync(source).isFile() || fs.statSync(source).nlink !== 1) fail("RECOVERY_INVALIDATION_PATH_UNSAFE");
    unchanged(source,originalPlan.preparedPlaintextSha256);
    fs.mkdirSync(output,{ recursive: false,mode: 0o700 });ownedDirectory = output;
    const candidatePath = path.join(output,"invalidation-reconciled.sqlite3");
    fs.copyFileSync(source,candidatePath,fs.constants.COPYFILE_EXCL);fs.chmodSync(candidatePath,0o600);
    database = openReadonlyDatabase({ databasePath: candidatePath });
    const verified = buildRecoveryPlanFromLineage({ database,credentialPreparation: credential,lineage,observedAtMs: originalPlan.observedAtMs,
      expectedEnvironmentId: originalPlan.databaseIdentity?.environmentId,expectedDatabaseId: originalPlan.databaseIdentity?.databaseId });
    if (!same(verified,originalPlan) || reconciledAtMs < verified.observedAtMs) fail("RECOVERY_INVALIDATION_PLAN_INVALID");
    database.close();database = null;
    database = openDatabase({ databasePath: candidatePath,environment: "staging",persistentRoot: physicalRoot,requirePersistentRoot: true }).database;
    const result = database.transaction(() => {
      const before = allRows(database),beforeTables = Object.fromEntries(Object.entries(before).map(([name,rows]) => [name,fingerprint(rows)]));
      if (!same(beforeTables,verified.tableSnapshots)) fail("RECOVERY_INVALIDATION_SOURCE_CHANGED");
      if (!database.prepare("SELECT 1 FROM users u JOIN platform_roles r ON r.user_id=u.id WHERE u.id=? AND u.status='active' AND r.role='platform_administrator' AND r.status='active'").get(reviewedByUserId)) fail("RECOVERY_INVALIDATION_REVIEWER_INVALID");
      const rows = readReviewedInvalidations(database,decisions,{ preparedAtMs: credential.preparedAtMs,reconciledAtMs });
      const records = invalidationReviewRecords({ plan: verified,events: decisions,reconciliationId,reviewedByUserId,reconciledAtMs });
      const initialChanges = database.prepare("SELECT total_changes() n").get().n;
      const suppress = database.prepare("UPDATE outbox_events SET status='discarded',last_error_code=?,updated_at_ms=?,version=version+1 WHERE id=? AND league_id=? AND version=? AND status IN ('pending','failed','publishing')");
      for (const row of rows) if (suppress.run(ERROR_CODE,reconciledAtMs,row.id,row.league_id,row.version).changes !== 1) fail("RECOVERY_INVALIDATION_EVENT_MISMATCH");
      database.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(records.metadata);
      createSqliteSecurityAuditRepository({ database }).append(records.audit);
      if (beforeCommit && beforeCommit(database)?.then) fail("RECOVERY_INVALIDATION_INPUT_INVALID");
      const selected = new Set(rows.map(row => row.id));
      const expected = { ...before,outbox_events: before.outbox_events.map(row => selected.has(row.id) ? suppressedInvalidation(row,reconciledAtMs) : row),
        application_metadata: [...before.application_metadata,records.metadata],security_audit_events: [...before.security_audit_events,records.audit] };
      const tables = Object.fromEntries(Object.entries(allRows(database)).map(([name,rows]) => [name,fingerprint(rows)]));
      if (Object.keys(tables).some(name => !same(tables[name],fingerprint(expected[name]))) ||
          database.prepare("SELECT total_changes() n").get().n-initialChanges !== decisions.length+2 || database.pragma("foreign_key_check").length !== 0) fail("RECOVERY_INVALIDATION_POSTCHECK_FAILED");
      unchanged(source,originalPlan.preparedPlaintextSha256);
      return { decisionChecksum: records.decisionChecksum,events: decisions,suppressedEvents: decisions.length,tableSnapshots: tables,
        protectedTableCount: Object.keys(tables).length-3,unresolvedMessages: verified.unresolvedMessages-decisions.length };
    }).immediate();
    database.close();database = null;
    const inspection = inspectDatabase(candidatePath);unchanged(source,originalPlan.preparedPlaintextSha256);
    const report = { reportVersion: 1,status: "invalidations-reconciled-held",recoveryId: verified.recoveryId,recoveryEpoch: verified.recoveryEpoch,
      reconciliationId,reviewedByUserId,reconciledAtMs,planChecksum: verified.planChecksum,sourcePlaintextSha256: verified.preparedPlaintextSha256,
      reconciledPlaintextSha256: hashFile(candidatePath),...result,disposition: DISPOSITION,deliveryPerformed: false,
      reviewEvidence: "operator-supplied-not-current-authentication",sourceDatabase: "unchanged",jobs: "unchanged-and-held",
      authoritativeNotifications: "unchanged",normalRuntime: "blocked-by-durable-recovery-hold",activationReady: false };
    const receipt = { ...report,reportChecksum: hash(canonicalize(report)) };
    fs.writeFileSync(path.join(output,"invalidation-reconciliation.json"),canonicalize(receipt)+"\n",{ flag: "wx",mode: 0o600 });
    return Object.freeze({ ...receipt,reconciledDatabasePath: candidatePath,inspection });
  } catch (error) {
    try {
      if (database?.open) database.close();
      if (ownedDirectory !== null) {
        if (!inside(physicalRoot,fs.realpathSync(ownedDirectory)) || fs.lstatSync(ownedDirectory).isSymbolicLink()) fail("RECOVERY_INVALIDATION_CLEANUP_FAILED");
        fs.rmSync(ownedDirectory,{ recursive: true,force: false });
      }
    } catch { fail("RECOVERY_INVALIDATION_CLEANUP_FAILED"); }
    if (error instanceof RecoveryInvalidationError) throw error;
    fail("RECOVERY_INVALIDATION_FAILED");
  }
}
module.exports = { prepareRecoveryInvalidationReconciliation };
