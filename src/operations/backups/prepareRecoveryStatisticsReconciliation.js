const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryReconciliationPlan } = require("./buildRecoveryReconciliationPlan");
const { createSqliteStatisticsScheduleRepository, JOB_TYPE, LEASE_MS } = require("../../infrastructure/persistence/sqlite/SqliteStatisticsScheduleRepository");
const { createSqliteStatisticsRepository } = require("../../infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createNhlCompletedGameAdapter, PROVIDER_NAME, PLAYER_IDENTITY_PROVIDER } = require("../../infrastructure/nhl/NhlCompletedGameAdapter");
const { createLiveStatisticsService } = require("../../application/services/statistics/createLiveStatisticsService");
const { assertNhlSeasonKey } = require("../../domain/statistics/statisticsPolicy");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVIEW_FIELDS = "evidenceSha256,jobId,nhlSeasonKey,occurrenceKeySha256,reasonCode,reconciliationId,reviewedByUserId,rowSha256";
const CHANGED = new Set(["job_runs", "stat_sources", "stat_refreshes", "player_stat_totals", "player_game_stat_observations",
  "stat_refresh_player_game_sets", "stat_refresh_player_game_coverage_entries", "security_audit_events", "application_metadata"]);
const APPENDED_STATISTICS = ["stat_refreshes", "player_stat_totals", "player_game_stat_observations",
  "stat_refresh_player_game_sets", "stat_refresh_player_game_coverage_entries"];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = file => hash(fs.readFileSync(file));
const same = (left,right) => canonicalize(left) === canonicalize(right);
const fingerprint = rows => ({ count: rows.length,sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) });
const inside = (root,target) => {
  const relative = path.relative(root,target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function exists(entry) {
  try { fs.lstatSync(entry); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
class RecoveryStatisticsReconciliationError extends Error {
  constructor(code) {
    super("Statistics recovery requires one exact reviewed occurrence in an unchanged held temporary candidate.");
    this.name = "RecoveryStatisticsReconciliationError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryStatisticsReconciliationError(code); }
function assertSource(source,digest) {
  if (["-wal", "-shm", "-journal"].some(suffix => exists(`${source}${suffix}`)) || hashFile(source) !== digest) fail("RECOVERY_STATISTICS_SOURCE_CHANGED");
}
function snapshots(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_STATISTICS_STATE_INVALID");
    const rows = database.prepare(`SELECT * FROM "${name}"`).all();
    return [name,fingerprint(rows)];
  }));
}

// This operation only reads the NHL provider and changes a new offline copy.
// The administrator attribution/evidence is operator supplied, not current
// authentication. No auction, matchup, message or normal runtime is released.
async function prepareRecoveryStatisticsReconciliation({ credentialPreparation,plan,review,executedAtMs,
  temporaryRoot,outputDirectory,minimumPlayerCount = 200,fetchImpl = globalThis.fetch,beforeReceipt = null } = {}) {
  if (!review || Object.keys(review).sort().join(",") !== REVIEW_FIELDS ||
      ![review.jobId,review.reviewedByUserId,review.reconciliationId].every(value => UUID.test(value || "")) ||
      ![review.rowSha256,review.occurrenceKeySha256,review.evidenceSha256].every(value => DIGEST.test(value || "")) ||
      typeof review.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(review.reasonCode) ||
      !Number.isSafeInteger(executedAtMs) || executedAtMs < 0 || !Number.isSafeInteger(executedAtMs + LEASE_MS) ||
      !Number.isSafeInteger(minimumPlayerCount) || minimumPlayerCount < 1 || typeof fetchImpl !== "function" ||
      !path.isAbsolute(temporaryRoot || "") || !path.isAbsolute(outputDirectory || "") ||
      !path.isAbsolute(credentialPreparation?.preparedDatabasePath || "") ||
      !DIGEST.test(credentialPreparation?.preparedPlaintextSha256 || "") || !DIGEST.test(plan?.planChecksum || "") ||
      (beforeReceipt !== null && typeof beforeReceipt !== "function")) fail("RECOVERY_STATISTICS_INPUT_INVALID");
  const decision = Object.freeze({ ...review });
  let ownedDirectory = null,physicalRoot,database;
  try {
    assertNhlSeasonKey(decision.nhlSeasonKey);
    // Snapshot all JSON evidence before provider awaits can run other code.
    const credential = JSON.parse(JSON.stringify(credentialPreparation)),originalPlan = JSON.parse(JSON.stringify(plan));
    physicalRoot = fs.realpathSync(temporaryRoot);
    const source = fs.realpathSync(credential.preparedDatabasePath);
    const output = path.join(fs.realpathSync(path.dirname(outputDirectory)),path.basename(outputDirectory));
    if (!inside(fs.realpathSync(os.tmpdir()),physicalRoot) || !inside(physicalRoot,source) || !inside(physicalRoot,output) ||
        fs.lstatSync(credential.preparedDatabasePath).isSymbolicLink() || !fs.statSync(source).isFile() ||
        fs.statSync(source).nlink !== 1 || exists(output)) fail("RECOVERY_STATISTICS_PATH_UNSAFE");
    assertSource(source,credential.preparedPlaintextSha256);
    fs.mkdirSync(output,{ recursive: false,mode: 0o700 }); ownedDirectory = output;
    const candidatePath = path.join(output,"statistics-reconciled.sqlite3");
    fs.copyFileSync(source,candidatePath,fs.constants.COPYFILE_EXCL); fs.chmodSync(candidatePath,0o600);
    database = openReadonlyDatabase({ databasePath: candidatePath });
    const verifiedPlan = buildRecoveryReconciliationPlan({ database,credentialPreparation: credential,
      observedAtMs: originalPlan.observedAtMs,expectedEnvironmentId: originalPlan.databaseIdentity?.environmentId,
      expectedDatabaseId: originalPlan.databaseIdentity?.databaseId });
    if (!same(verifiedPlan,originalPlan) || executedAtMs < verifiedPlan.observedAtMs) fail("RECOVERY_STATISTICS_PLAN_INVALID");
    const row = database.prepare("SELECT * FROM job_runs WHERE id=?").get(decision.jobId);
    if (!row || row.league_id !== null || row.season_id !== null || row.job_type !== JOB_TYPE ||
        !["pending","running","failed"].includes(row.status) || row.updated_at_ms > executedAtMs || row.scheduled_for_ms > executedAtMs ||
        row.occurrence_key !== `${decision.nhlSeasonKey}:${row.scheduled_for_ms}` ||
        !Number.isSafeInteger(row.version + 2) || !Number.isSafeInteger(row.attempt_count + 1) ||
        hash(canonicalize(row)) !== decision.rowSha256 ||
        hash(canonicalize([row.league_id,row.job_type,row.occurrence_key])) !== decision.occurrenceKeySha256 ||
        (row.lease_expires_at_ms !== null && row.lease_expires_at_ms > executedAtMs)) fail("RECOVERY_STATISTICS_OCCURRENCE_INVALID");
    if (!database.prepare("SELECT 1 FROM users u JOIN platform_roles r ON r.user_id=u.id WHERE u.id=? AND u.status='active' AND r.role='platform_administrator' AND r.status='active'").get(decision.reviewedByUserId)) fail("RECOVERY_STATISTICS_REVIEWER_INVALID");
    const metadataKey = `recovery_statistics_review:${decision.reconciliationId}`;
    if (database.prepare("SELECT 1 FROM application_metadata WHERE metadata_key=?").get(metadataKey) ||
        database.prepare("SELECT 1 FROM security_audit_events WHERE id=?").get(decision.reconciliationId)) fail("RECOVERY_STATISTICS_REVIEW_REUSED");
    database.close(); database = null;
    database = openDatabase({ databasePath: candidatePath,environment: "staging",persistentRoot: physicalRoot,requirePersistentRoot: true }).database;
    const beforeTables = snapshots(database);
    if (!same(beforeTables,verifiedPlan.tableSnapshots)) fail("RECOVERY_STATISTICS_SOURCE_CHANGED");
    const beforeJobs = database.prepare("SELECT * FROM job_runs WHERE id<>? ORDER BY id").all(row.id);
    const beforeAudit = database.prepare("SELECT * FROM security_audit_events ORDER BY id").all();
    const beforeMetadata = database.prepare("SELECT * FROM application_metadata ORDER BY metadata_key").all();
    const beforeSources = database.prepare("SELECT * FROM stat_sources ORDER BY id").all();
    const schedule = createSqliteStatisticsScheduleRepository({ database });
    const startedMonotonicMs = performance.now();
    const nowMs = () => {
      const value = executedAtMs + Math.floor(performance.now() - startedMonotonicMs);
      if (!Number.isSafeInteger(value)) fail("RECOVERY_STATISTICS_TIME_INVALID");
      return value;
    };
    const lease = schedule.claim({ occurrenceKey: row.occurrence_key,scheduledForMs: row.scheduled_for_ms,
      nowMs: executedAtMs,owner: `recovery:${decision.reconciliationId}` });
    if (!lease || lease.id !== row.id || lease.version !== row.version + 1) fail("RECOVERY_STATISTICS_LEASE_UNAVAILABLE");
    const statistics = createSqliteStatisticsRepository({ database });
    const provider = createNhlCompletedGameAdapter({ fetchImpl,nowMs,readCatalogPlayers: () => statistics.readNhlCatalogPlayers() });
    const service = createLiveStatisticsService({ repository: statistics,provider,nhlSeasonKey: decision.nhlSeasonKey,
      providerName: PROVIDER_NAME,playerIdentityProvider: PLAYER_IDENTITY_PROVIDER,minimumPlayerCount,nowMs });
    const result = await service.refresh({ authorizePersist: () => schedule.assertLease(lease,nowMs()) });
    const completedAtMs = nowMs();
    schedule.complete({ lease,nowMs: completedAtMs,result });
    // Statistics persistence is append-only for a new refresh. Preserve every
    // older source, refresh and observation even inside the permitted tables.
    const completedTables = snapshots(database);
    const refresh = database.prepare("SELECT * FROM stat_refreshes WHERE id=?").get(result.refreshId);
    const sourceRow = database.prepare("SELECT * FROM stat_sources WHERE id=?").get(refresh?.stat_source_id);
    const oldSource = beforeSources.find(item => item.id === sourceRow?.id);
    if (!refresh || refresh.status !== "succeeded" || refresh.nhl_season_key !== decision.nhlSeasonKey ||
        refresh.source_version !== result.sourceVersion || refresh.player_count !== result.playerCount ||
        refresh.completed_at_ms !== result.capturedAtMs || refresh.error_code !== null || refresh.version !== 2 ||
        !sourceRow || sourceRow.provider !== PROVIDER_NAME || sourceRow.status !== "active" ||
        (oldSource ? !same(sourceRow,oldSource) : sourceRow.version !== 1 || sourceRow.created_at_ms < executedAtMs ||
          sourceRow.updated_at_ms !== sourceRow.created_at_ms || sourceRow.created_at_ms > completedAtMs) ||
        !same(fingerprint(database.prepare("SELECT * FROM stat_sources WHERE id<>?").all(sourceRow.id)),
          fingerprint(beforeSources.filter(item => item.id !== sourceRow.id))) ||
        APPENDED_STATISTICS.some(name => !same(fingerprint(database.prepare(`SELECT * FROM "${name}" WHERE ${name === "stat_refreshes" ? "id" : "refresh_id"}<>?`).all(result.refreshId)),beforeTables[name])) ||
        completedTables.stat_refreshes.count !== beforeTables.stat_refreshes.count + 1 ||
        completedTables.player_stat_totals.count !== beforeTables.player_stat_totals.count + result.playerCount ||
        completedTables.player_game_stat_observations.count !== beforeTables.player_game_stat_observations.count + result.playerGameObservationCount ||
        completedTables.stat_refresh_player_game_sets.count !== beforeTables.stat_refresh_player_game_sets.count + 1 ||
        completedTables.stat_refresh_player_game_coverage_entries.count !== beforeTables.stat_refresh_player_game_coverage_entries.count + result.playerGameCoverageEntryCount) fail("RECOVERY_STATISTICS_POSTCHECK_FAILED");
    const decisionChecksum = hash(canonicalize(decision));
    const metadata = { metadata_key: metadataKey,metadata_value: canonicalize({ recoveryId: verifiedPlan.recoveryId,
      planChecksum: verifiedPlan.planChecksum,decisionChecksum,decision,executedAtMs,completedAtMs,refreshId: result.refreshId }),
      created_at_ms: completedAtMs,updated_at_ms: completedAtMs };
    const audit = { id: decision.reconciliationId,event_type: "recovery.statistics_reconciled",outcome: "success",
      actor_user_id: decision.reviewedByUserId,target_user_id: null,league_id: null,session_id: null,
      request_correlation_id: verifiedPlan.recoveryId,reason_code: `statistics_${decisionChecksum}`,network_key_version: null,
      network_metadata_digest: null,unknown_account_digest: null,client_metadata_json: '{"networkSourceCategory":"local"}',occurred_at_ms: completedAtMs };
    database.transaction(() => {
      database.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(metadata);
      createSqliteSecurityAuditRepository({ database }).append(audit);
    }).immediate();
    if (beforeReceipt && beforeReceipt(database)?.then) fail("RECOVERY_STATISTICS_INPUT_INVALID");
    const expectedJob = { ...row,status: "succeeded",attempt_count: row.attempt_count + 1,lease_owner: null,lease_expires_at_ms: null,
      started_at_ms: executedAtMs,completed_at_ms: completedAtMs,updated_at_ms: completedAtMs,version: row.version + 2,
      result_json: JSON.stringify(result),last_error_code: null };
    const afterTables = snapshots(database);
    if (Object.keys(beforeTables).some(name => !CHANGED.has(name) && !same(beforeTables[name],afterTables[name])) ||
        ["stat_sources",...APPENDED_STATISTICS].some(name => !same(completedTables[name],afterTables[name])) ||
        !same(database.prepare("SELECT * FROM job_runs WHERE id=?").get(row.id),expectedJob) ||
        !same(database.prepare("SELECT * FROM job_runs WHERE id<>? ORDER BY id").all(row.id),beforeJobs) ||
        !same(database.prepare("SELECT * FROM security_audit_events WHERE id<>? ORDER BY id").all(audit.id),beforeAudit) ||
        !same(database.prepare("SELECT * FROM security_audit_events WHERE id=?").get(audit.id),audit) ||
        !same(database.prepare("SELECT * FROM application_metadata WHERE metadata_key<>? ORDER BY metadata_key").all(metadataKey),beforeMetadata) ||
        !same(database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(metadataKey),metadata) ||
        database.pragma("foreign_key_check").length !== 0) fail("RECOVERY_STATISTICS_POSTCHECK_FAILED");
    assertSource(source,credential.preparedPlaintextSha256);
    database.close(); database = null;
    const inspection = inspectDatabase(candidatePath);
    assertSource(source,credential.preparedPlaintextSha256);
    const report = { reportVersion: 1,status: "statistics-reconciled-held",recoveryId: verifiedPlan.recoveryId,recoveryEpoch: verifiedPlan.recoveryEpoch,
      planChecksum: verifiedPlan.planChecksum,sourcePlaintextSha256: credential.preparedPlaintextSha256,
      reconciledPlaintextSha256: hashFile(candidatePath),decision,decisionChecksum,executedAtMs,completedAtMs,result,
      completedJobId: row.id,completedJobRowSha256: hash(canonicalize(expectedJob)),tableSnapshots: afterTables,
      unresolvedJobs: verifiedPlan.unresolvedJobs - 1,unresolvedMessages: verifiedPlan.unresolvedMessages,
      protectedTableCount: Object.keys(beforeTables).filter(name => !CHANGED.has(name)).length,
      sourceDatabase: "unchanged",otherJobs: "unchanged-and-held",messages: "unchanged-and-held",
      reviewEvidence: "operator-supplied-not-current-authentication",providerEvidence: "fetched-through-nhl-completed-game-adapter",
      normalRuntime: "blocked-by-durable-recovery-hold",activationReady: false };
    const receipt = { ...report,reportChecksum: hash(canonicalize(report)) };
    fs.writeFileSync(path.join(output,"statistics-reconciliation.json"),`${canonicalize(receipt)}\n`,{ flag: "wx",mode: 0o600 });
    return Object.freeze({ ...receipt,reconciledDatabasePath: candidatePath,inspection });
  } catch (error) {
    try {
      if (database?.open) database.close();
      if (ownedDirectory !== null) {
        if (!inside(physicalRoot,fs.realpathSync(ownedDirectory)) || fs.lstatSync(ownedDirectory).isSymbolicLink()) fail("RECOVERY_STATISTICS_CLEANUP_FAILED");
        fs.rmSync(ownedDirectory,{ recursive: true,force: false });
      }
    } catch { fail("RECOVERY_STATISTICS_CLEANUP_FAILED"); }
    if (error instanceof RecoveryStatisticsReconciliationError) throw error;
    fail("RECOVERY_STATISTICS_FAILED");
  }
}

module.exports = { RecoveryStatisticsReconciliationError,prepareRecoveryStatisticsReconciliation };
