const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { inspectDatabase, calculateManifestChecksum, BACKUP_FILE_NAME } = require("../../infrastructure/database/sqliteBackup");
const { discoverMigrations, assertMigrationCompatibility } = require("../../infrastructure/database/migrate");
const { readManifest } = require("./restoreEncryptedBackupToCleanPath");
const { migrationChecksumSetId, buildBackupAad } = require("./createEncryptedOffsiteBackup");
const { compareRecoveryLossWindow } = require("./compareRecoveryLossWindow");
const { inspectRecoveryInventory } = require("./inspectRecoveryInventory");

const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
class RecoveryRestorePlanError extends Error {
  constructor(code) {
    super("Restore planning requires exact verified offline evidence. No restore execution or approval was performed.");
    this.name = "RecoveryRestorePlanError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryRestorePlanError(code); }
function timestamp(value) {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || !Number.isSafeInteger(parsed) || parsed < 0 ||
      new Date(parsed).toISOString() !== value) fail("RECOVERY_RESTORE_PLAN_TIME_INVALID");
  return parsed;
}
function unchanged(database, digest) {
  if (hash(fs.readFileSync(database.name)) !== digest ||
      (fs.existsSync(database.name + "-wal") && fs.statSync(database.name + "-wal").size !== 0) ||
      fs.existsSync(database.name + "-journal")) fail("RECOVERY_RESTORE_PLAN_SOURCE_CHANGED");
}
function leagueState(database) {
  return database.transaction(() => ({
    leagues: database.prepare("SELECT id,status FROM leagues ORDER BY id").all(),
    seasons: database.prepare("SELECT id,league_id AS leagueId,status FROM seasons ORDER BY league_id,id").all(),
    pendingAuctions: database.prepare("SELECT id,league_id AS leagueId,season_id AS seasonId,status,resolves_at_ms AS resolvesAtMs FROM auctions WHERE status IN ('open','resolving','failed') ORDER BY league_id,id").all(),
    pendingTrades: database.prepare("SELECT id,league_id AS leagueId,season_id AS seasonId,status,expires_at_ms AS expiresAtMs FROM trades WHERE status IN ('proposed','accepted') ORDER BY league_id,id").all(),
    matchupPeriods: database.prepare("SELECT id,league_id AS leagueId,season_id AS seasonId,status,starts_at_ms AS startsAtMs,ends_at_ms AS endsAtMs FROM matchup_weeks ORDER BY league_id,season_id,sequence,id").all(),
    standingsPeriods: database.prepare("SELECT id,league_id AS leagueId,season_id AS seasonId,status,snapshot_version AS snapshotVersion,calculated_at_ms AS calculatedAtMs FROM standings_snapshots WHERE status IN ('current','final') ORDER BY league_id,season_id,id").all(),
  })).deferred();
}

// Produces a plan from supplied offline evidence. Approval, current strong
// reauthentication, worker dispositions and activation remain separate gates.
function buildRecoveryRestorePlan({ restoredDatabase, preservedDatabase, restoredVerification,
  backupManifestBytes, expectedBackupManifestSha256, preservationManifestBytes, expectedPreservationManifestSha256,
  targetEnvironment, expectedEnvironmentId, expectedDatabaseId, incidentId, requestedByUserId, requestedScope,
  mutationsStoppedAtMs, plannedAtMs, currentBackendBuildId, selectedBackendBuildId, frontendBuildId,
  migrationsDirectory, maintenancePlanSha256, communicationPlanSha256 } = {}) {
  if ([restoredDatabase,preservedDatabase].some(database => !database?.open || database.readonly !== true ||
      database.inTransaction || !path.isAbsolute(database.name || "")) ||
      ![backupManifestBytes,preservationManifestBytes].every(bytes => Buffer.isBuffer(bytes) && bytes.length > 1 && bytes.length <= 16 * 1024 * 1024) ||
      ![expectedBackupManifestSha256,expectedPreservationManifestSha256,maintenancePlanSha256,communicationPlanSha256].every(value => DIGEST.test(value || "")) ||
      !["staging","production"].includes(targetEnvironment) || requestedScope !== "whole-database" ||
      ![expectedEnvironmentId,expectedDatabaseId,currentBackendBuildId,selectedBackendBuildId,frontendBuildId].every(value => LABEL.test(value || "")) ||
      !UUID.test(incidentId || "") || !UUID.test(requestedByUserId || "") ||
      !Number.isSafeInteger(mutationsStoppedAtMs) || mutationsStoppedAtMs < 0 ||
      !Number.isSafeInteger(plannedAtMs) || plannedAtMs < mutationsStoppedAtMs || !path.isAbsolute(migrationsDirectory || "") ||
      restoredVerification?.status !== "verified") fail("RECOVERY_RESTORE_PLAN_INPUT_INVALID");
  try {
    if (hash(backupManifestBytes) !== expectedBackupManifestSha256 || hash(preservationManifestBytes) !== expectedPreservationManifestSha256)
      fail("RECOVERY_RESTORE_PLAN_MANIFEST_INVALID");
    const backup = readManifest(backupManifestBytes);
    const preserved = JSON.parse(preservationManifestBytes.toString("utf8"));
    if (preservationManifestBytes.toString("utf8") !== canonicalize(preserved) + "\n" ||
        preserved.manifestVersion !== 1 || calculateManifestChecksum(preserved) !== preserved.manifestChecksum ||
        preserved.environment !== targetEnvironment || preserved.reason !== "incident-preservation" ||
        preserved.backupFileName !== BACKUP_FILE_NAME ||
        preserved.backupId !== "backup-v1-" + preserved.plaintextSha256 ||
        !DIGEST.test(preserved.plaintextSha256 || "") || !Number.isSafeInteger(preserved.byteSize) ||
        preserved.byteSize !== fs.statSync(preservedDatabase.name).size ||
        backup.environment !== targetEnvironment || backup.environmentId !== expectedEnvironmentId ||
        backup.databaseId !== expectedDatabaseId || !UUID.test(backup.backupId || "") ||
        !LABEL.test(backup.backendBuildId || "") ||
        !DIGEST.test(backup.plainBackupSha256 || "") ||
        backup.backupId !== restoredVerification.backupId || backup.plainBackupSha256 !== restoredVerification.plaintextSha256 ||
        hash(buildBackupAad(backup)) !== backup.aadSha256)
      fail("RECOVERY_RESTORE_PLAN_MANIFEST_INVALID");
    const createdAtMs = timestamp(backup.createdAt), completedAtMs = timestamp(backup.completedAt);
    if (completedAtMs < createdAtMs || completedAtMs > mutationsStoppedAtMs ||
        !Number.isSafeInteger(preserved.capturedAtMs) || preserved.capturedAtMs < mutationsStoppedAtMs ||
        plannedAtMs < preserved.capturedAtMs) fail("RECOVERY_RESTORE_PLAN_TIME_INVALID");
    const comparison = compareRecoveryLossWindow({ restoredDatabase, preservedDatabase,
      restoredPlaintextSha256: backup.plainBackupSha256, preservedPlaintextSha256: preserved.plaintextSha256,
      sourceBackupId: backup.backupId, expectedEnvironmentId, expectedDatabaseId, observedAtMs: plannedAtMs, includeFinancialState: true });
    const changesBefore = [restoredDatabase,preservedDatabase].map(database => database.prepare("SELECT total_changes() n").get().n);
    const candidateInspection = inspectDatabase(restoredDatabase.name), preservedInspection = inspectDatabase(preservedDatabase.name);
    if (canonicalize(candidateInspection) !== canonicalize(restoredVerification.inspection) ||
        canonicalize(candidateInspection) !== canonicalize(backup.databaseInspection) ||
        canonicalize(preservedInspection) !== canonicalize(preserved.databaseInspection) ||
        backup.schemaVersion !== candidateInspection.userVersion ||
        backup.migrationChecksumSetId !== migrationChecksumSetId(candidateInspection.migrations))
      fail("RECOVERY_RESTORE_PLAN_INSPECTION_INVALID");
    const migrations = discoverMigrations({ migrationsDirectory });
    assertMigrationCompatibility(restoredDatabase, migrations);
    assertMigrationCompatibility(preservedDatabase, migrations);
    if (!preservedDatabase.prepare("SELECT 1 FROM users u JOIN platform_roles r ON r.user_id=u.id WHERE u.id=? AND u.status='active' AND r.role='platform_administrator' AND r.status='active'").get(requestedByUserId))
      fail("RECOVERY_RESTORE_PLAN_REQUESTER_INVALID");
    const inventory = database => inspectRecoveryInventory({ database, expectedEnvironmentId, expectedDatabaseId, observedAtMs: plannedAtMs });
    const candidate = { databaseIdentity: candidateInspection.databaseIdentity, schemaVersion: candidateInspection.userVersion,
      rowCounts: candidateInspection.rowCounts, inventory: inventory(restoredDatabase), leagueState: leagueState(restoredDatabase) };
    const current = { databaseIdentity: preservedInspection.databaseIdentity, schemaVersion: preservedInspection.userVersion,
      rowCounts: preservedInspection.rowCounts, inventory: inventory(preservedDatabase), leagueState: leagueState(preservedDatabase) };
    unchanged(restoredDatabase, backup.plainBackupSha256); unchanged(preservedDatabase, preserved.plaintextSha256);
    if ([restoredDatabase,preservedDatabase].some((database,index) => database.prepare("SELECT total_changes() n").get().n !== changesBefore[index]))
      fail("RECOVERY_RESTORE_PLAN_WRITE_DETECTED");
    const plan = { restorePlanVersion: 1, status: "awaiting-platform-approval", incidentId, requestedByUserId, plannedAtMs,
      requestedScope, targetEnvironment, expectedDataLossWindow: { startsAtMs: completedAtMs, endsAtMs: mutationsStoppedAtMs,
        durationMs: mutationsStoppedAtMs - completedAtMs, boundaryEvidence: "operator-supplied-mutation-stop" },
      selectedBackup: { backupId: backup.backupId, createdAt: backup.createdAt, completedAt: backup.completedAt,
        plaintextSha256: backup.plainBackupSha256, manifestSha256: expectedBackupManifestSha256, manifestChecksum: backup.manifestChecksum,
        backupBackendBuildId: backup.backendBuildId },
      rollbackArtifact: { backupId: preserved.backupId, capturedAtMs: preserved.capturedAtMs, plaintextSha256: preserved.plaintextSha256,
        manifestSha256: expectedPreservationManifestSha256, manifestChecksum: preserved.manifestChecksum, verificationScope: "verified-offline-preservation-copy" },
      buildCompatibility: { currentBackendBuildId, selectedBackendBuildId, frontendBuildId,
        scope: "matching-application-migrations-and-operator-supplied-build-ids", migrationChecksumSetId: backup.migrationChecksumSetId,
        requiredMigrations: [], applicationBehaviorVerified: false },
      affectedLeagueIds: comparison.financialState.leagues.map(row => row.leagueId), current, candidate, comparison,
      operationalPlans: { maintenancePlanSha256, communicationPlanSha256, contentsIndependentlyReviewed: false },
      approval: { status: "required", approvedByUserId: null, approvedAtMs: null, strongReauthentication: "required-at-execution" },
      providerEvidenceFetched: false, completeLossWindowEvidence: false, activationReady: false, executable: false,
      remainingGates: ["platform-approval-and-strong-reauthentication", "maintenance-and-worker-stop-verification",
        "credential-and-recovery-epoch-preparation", "exact-job-and-message-dispositions", "financial-and-league-corrections",
        "authenticated-readonly-recovery-acceptance", "verified-post-reconciliation-backup", "controlled-activation-and-monitoring"] };
    return Object.freeze({ ...plan, planChecksum: hash(canonicalize(plan)) });
  } catch (error) {
    if (error instanceof RecoveryRestorePlanError) throw error;
    fail("RECOVERY_RESTORE_PLAN_FAILED");
  }
}

module.exports = { RecoveryRestorePlanError, buildRecoveryRestorePlan };
