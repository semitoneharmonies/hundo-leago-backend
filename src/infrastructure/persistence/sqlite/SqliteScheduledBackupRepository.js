const { assertDatabaseIdentity } = require("../../database/databaseIdentity");
const { assertRecoveryRuntimeAllowed } = require("../../database/recoveryHold");
const { canonicalize } = require("../../migration/sourceInventory");

const JOB_TYPE = "encrypted_database_backup";
const INTERVALS = Object.freeze({ hourly: 3_600_000, daily: 86_400_000 });
const LEASE_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error("The scheduled backup state could not be changed safely.");
  error.code = code;
  throw error;
}
function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - LEASE_MS) fail("BACKUP_JOB_INPUT_INVALID");
  return value;
}
function id(value) { if (!UUID.test(value || "")) fail("BACKUP_JOB_INPUT_INVALID"); return value; }

function createSqliteScheduledBackupRepository({ database, environmentId, databaseId } = {}) {
  if (!database || database.readonly || !database.open) fail("BACKUP_JOB_INPUT_INVALID");
  const identity = { environmentId, databaseId };
  function guard() {
    assertDatabaseIdentity(database, identity);
    assertRecoveryRuntimeAllowed(database);
  }
  guard();
  const byId = database.prepare("SELECT * FROM job_runs WHERE id=? AND league_id IS NULL AND job_type=?");
  function attempt(row) {
    try {
      const value = JSON.parse(row.result_json);
      if (!UUID.test(value.backupId)) fail("BACKUP_JOB_STATE_INVALID");
      return value;
    } catch { fail("BACKUP_JOB_STATE_INVALID"); }
  }
  function currentClaim(claim, nowMs) {
    const row = byId.get(id(claim?.runId), JOB_TYPE);
    if (!row || row.status !== "leased" || row.version !== claim.version ||
        row.lease_token !== claim.leaseToken || row.lease_owner !== claim.leaseOwner ||
        row.lease_expires_at_ms <= nowMs || row.started_at_ms > nowMs || row.updated_at_ms > nowMs ||
        row.occurrence_key !== claim.occurrenceKey || row.scheduled_for_ms !== claim.scheduledForMs ||
        row.started_at_ms !== claim.startedAtMs || row.occurrence_key.split(":")[0] !== claim.cadence ||
        attempt(row).backupId !== claim.backupId) fail("BACKUP_JOB_LEASE_LOST");
    return row;
  }

  const claimTransaction = database.transaction(({ cadence, nowMs, runId, backupId, leaseToken, leaseOwner }) => {
    guard();
    if (database.prepare("SELECT 1 FROM job_runs WHERE league_id IS NULL AND job_type=? " +
      "AND status IN ('leased','running') AND lease_expires_at_ms>? LIMIT 1").get(JOB_TYPE, nowMs)) {
      return Object.freeze({ status: "skipped", reason: "already-running" });
    }
    const scheduledForMs = Math.floor(nowMs / INTERVALS[cadence]) * INTERVALS[cadence];
    const occurrenceKey = `${cadence}:${scheduledForMs}`;
    if (!database.prepare("SELECT 1 FROM job_runs WHERE league_id IS NULL AND job_type=? AND occurrence_key=?")
      .get(JOB_TYPE, occurrenceKey)) {
      database.prepare("INSERT INTO job_runs (id,job_type,occurrence_key,scheduled_for_ms,status,created_at_ms,updated_at_ms,version,next_attempt_at_ms) " +
        "VALUES (?,?,?,?,'pending',?,?,1,?)").run(runId, JOB_TYPE, occurrenceKey, scheduledForMs, nowMs, nowMs, scheduledForMs);
    }
    const row = database.prepare("SELECT * FROM job_runs WHERE league_id IS NULL AND job_type=? AND scheduled_for_ms<=? " +
      "AND ((status IN ('pending','failed') AND next_attempt_at_ms<=?) OR (status IN ('leased','running') AND lease_expires_at_ms<=?)) " +
      "ORDER BY scheduled_for_ms,id LIMIT 1").get(JOB_TYPE, nowMs, nowMs, nowMs);
    if (!row) return Object.freeze({ status: "skipped", reason: "not-due" });
    if (row.updated_at_ms > nowMs) fail("BACKUP_JOB_INPUT_INVALID");
    const supersedesBackupId = row.attempt_count > 0 ? attempt(row).backupId : null;
    if (backupId === supersedesBackupId) fail("BACKUP_JOB_INPUT_INVALID");
    database.prepare("UPDATE job_runs SET status='leased',attempt_count=attempt_count+1,lease_owner=?,lease_token=?," +
      "lease_expires_at_ms=?,started_at_ms=?,completed_at_ms=NULL,result_json=?,last_error_code=NULL,updated_at_ms=?,version=version+1 " +
      "WHERE id=? AND version=?").run(leaseOwner, leaseToken, nowMs + LEASE_MS, nowMs,
      canonicalize({ backupId, supersedesBackupId }), nowMs, row.id, row.version);
    return Object.freeze({ status: "claimed", claim: Object.freeze({ runId: row.id, backupId,
      leaseToken, leaseOwner, version: row.version + 1, startedAtMs: nowMs,
      cadence: row.occurrence_key.split(":")[0], scheduledForMs: row.scheduled_for_ms,
      occurrenceKey: row.occurrence_key, leaseExpiresAtMs: nowMs + LEASE_MS, supersedesBackupId }) });
  });

  const completeTransaction = database.transaction(({ claim, nowMs, evidence }) => {
    guard();
    const receipt = { backupId: evidence.verifiedBackupId, ...evidence };
    const saved = byId.get(claim.runId, JOB_TYPE);
    const metadata = saved && canonicalize({ jobRunId: saved.id, occurrenceKey: saved.occurrence_key,
      manifestChecksum: evidence.manifestChecksum, encryptedArtifactSha256: evidence.encryptedArtifactSha256,
      retentionClass: saved.occurrence_key.split(":")[0], encryptionKeyVersion: evidence.encryptionKeyVersion,
      occurrenceReceiptObjectKey: evidence.occurrenceReceiptObjectKey, occurrenceReceiptChecksum: evidence.occurrenceReceiptChecksum });
    if (saved?.status === "succeeded" && saved.result_json === canonicalize(receipt)) {
      const catalog = database.prepare("SELECT * FROM backup_catalog WHERE id=?").get(evidence.verifiedBackupId);
      if (!catalog || catalog.status !== "verified" || catalog.database_checksum !== evidence.plaintextSha256 ||
          catalog.storage_reference !== evidence.manifestObjectKey || catalog.environment_identity !== environmentId ||
          catalog.source_database_id !== databaseId || catalog.backup_kind !== "scheduled" ||
          catalog.league_id !== null || catalog.schema_version !== evidence.schemaVersion ||
          catalog.created_at_ms !== evidence.backupCreatedAtMs || catalog.verified_at_ms !== saved.completed_at_ms ||
          catalog.metadata_json !== metadata) fail("BACKUP_JOB_CATALOG_MISMATCH");
      return Object.freeze({ status: "replayed", backupId: evidence.verifiedBackupId });
    }
    const row = currentClaim(claim, nowMs);
    database.prepare("INSERT INTO backup_catalog (id,league_id,environment_identity,backup_kind,storage_reference," +
      "database_checksum,schema_version,source_database_id,status,created_at_ms,verified_at_ms,metadata_json) " +
      "VALUES (?,NULL,?,'scheduled',?,?,?,?,'verified',?,?,?)").run(evidence.verifiedBackupId, environmentId,
      evidence.manifestObjectKey, evidence.plaintextSha256, evidence.schemaVersion, databaseId,
      evidence.backupCreatedAtMs, nowMs, metadata);
    database.prepare("UPDATE job_runs SET status='succeeded',completed_at_ms=?,result_json=?,lease_owner=NULL," +
      "lease_token=NULL,lease_expires_at_ms=NULL,updated_at_ms=?,version=version+1 WHERE id=? AND version=?")
      .run(nowMs, canonicalize(receipt), nowMs, row.id, row.version);
    return Object.freeze({ status: "succeeded", backupId: evidence.verifiedBackupId });
  });

  const failTransaction = database.transaction(({ claim, nowMs }) => {
    guard();
    const row = currentClaim(claim, nowMs);
    database.prepare("UPDATE job_runs SET status='failed',completed_at_ms=?,last_error_code='SCHEDULED_BACKUP_FAILED'," +
      "lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL,next_attempt_at_ms=?,updated_at_ms=?,version=version+1 WHERE id=? AND version=?")
      .run(nowMs, nowMs + RETRY_MS, nowMs, row.id, row.version);
    return Object.freeze({ status: "failed", retryAtMs: nowMs + RETRY_MS });
  });

  const renewTransaction = database.transaction(({ claim, nowMs }) => {
    guard();
    const row = currentClaim(claim, nowMs);
    database.prepare("UPDATE job_runs SET lease_expires_at_ms=?,updated_at_ms=?,version=version+1 WHERE id=? AND version=?")
      .run(nowMs + LEASE_MS, nowMs, row.id, row.version);
    return Object.freeze({ ...claim, version: row.version + 1, leaseExpiresAtMs: nowMs + LEASE_MS });
  });

  return Object.freeze({
    claim({ cadence, nowMs, runId, backupId, leaseToken, leaseOwner } = {}) {
      timestamp(nowMs); id(runId); id(backupId); id(leaseToken);
      if (!Object.hasOwn(INTERVALS, cadence) || typeof leaseOwner !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leaseOwner)) fail("BACKUP_JOB_INPUT_INVALID");
      return claimTransaction.immediate({ cadence, nowMs, runId, backupId, leaseToken, leaseOwner });
    },
    complete({ claim, nowMs, evidence } = {}) {
      timestamp(nowMs); id(claim?.runId); id(claim?.backupId);
      if (!evidence || ![evidence.plaintextSha256, evidence.manifestChecksum, evidence.encryptedArtifactSha256, evidence.occurrenceReceiptChecksum].every((value) => DIGEST.test(value || "")) ||
          !Number.isSafeInteger(evidence.schemaVersion) || evidence.schemaVersion < 1 ||
          !Number.isSafeInteger(evidence.backupCreatedAtMs) || evidence.backupCreatedAtMs < 0 || evidence.backupCreatedAtMs > nowMs ||
          typeof evidence.manifestObjectKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9/_:.-]{0,511}$/.test(evidence.manifestObjectKey) ||
          evidence.manifestObjectKey.includes("..") ||
          typeof evidence.occurrenceReceiptObjectKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9/_:.-]{0,511}$/.test(evidence.occurrenceReceiptObjectKey) ||
          evidence.occurrenceReceiptObjectKey.includes("..") ||
          typeof evidence.encryptionKeyVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(evidence.encryptionKeyVersion)) fail("BACKUP_JOB_INPUT_INVALID");
      const { plaintextSha256, manifestChecksum, encryptedArtifactSha256, schemaVersion, manifestObjectKey, encryptionKeyVersion,
        backupCreatedAtMs, occurrenceReceiptObjectKey, occurrenceReceiptChecksum, verifiedBackupId = claim.backupId } = evidence;
      id(verifiedBackupId);
      return completeTransaction.immediate({ claim, nowMs, evidence: {
        plaintextSha256, manifestChecksum, encryptedArtifactSha256, schemaVersion, manifestObjectKey, encryptionKeyVersion,
        backupCreatedAtMs, occurrenceReceiptObjectKey, occurrenceReceiptChecksum, verifiedBackupId,
      } });
    },
    fail({ claim, nowMs } = {}) { timestamp(nowMs); return failTransaction.immediate({ claim, nowMs }); },
    renew({ claim, nowMs } = {}) { timestamp(nowMs); return renewTransaction.immediate({ claim, nowMs }); },
  });
}

module.exports = { INTERVALS, JOB_TYPE, LEASE_MS, RETRY_MS, createSqliteScheduledBackupRepository };
