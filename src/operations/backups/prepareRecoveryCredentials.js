const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../../infrastructure/database/connection");
const { assertDatabaseIdentity } = require("../../infrastructure/database/databaseIdentity");
const { RECOVERY_HOLD_KEY, assertRecoveryRuntimeAllowed } = require("../../infrastructure/database/recoveryHold");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createSqliteSessionRepository } = require("../../infrastructure/persistence/sqlite/SqliteSessionRepository");
const { createSqliteAccountActionTokenRepository } = require("../../infrastructure/persistence/sqlite/SqliteAccountActionTokenRepository");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { ACTION_LINK_EVENTS, CLEARED_PAYLOAD_JSON, createSqliteOutboxEventRepository } = require("../../infrastructure/persistence/sqlite/SqliteOutboxEventRepository");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AUDIT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CHANGED_TABLES = new Set(["sessions", "account_action_tokens", "security_audit_events", "application_metadata", "outbox_events", "job_runs"]);
const LINK_EVENT_PURPOSES = Object.freeze(Object.fromEntries(Object.entries({
  ...ACTION_LINK_EVENTS, email_verification: "account.email_verification_requested",
}).map(([purpose, event]) => [event, purpose])));
const STALE_LINK_REASON = "RECOVERY_STALE_ACCOUNT_LINK";

class RecoveryCredentialPreparationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "RecoveryCredentialPreparationError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new RecoveryCredentialPreparationError(code, message, cause ? { cause } : {});
}
function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function hashFile(file) { return hash(fs.readFileSync(file)); }
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function exists(entry) {
  try { fs.lstatSync(entry); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function fingerprint(database, tables) {
  return Object.fromEntries(tables.map((table) => {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error("Unsupported table name");
    const rows = database.prepare(`SELECT * FROM "${table}"`).all();
    return [table, hash(canonicalize(rows.map((row) => hash(canonicalize(row))).sort()))];
  }));
}
function assertSourceUnchanged(source, expectedHash) {
  if (["-wal", "-shm", "-journal"].some((suffix) => exists(`${source}${suffix}`)) || hashFile(source) !== expectedHash) {
    fail("RECOVERY_SOURCE_CHANGED", "The verified restore source changed during preparation.");
  }
}

function restoredAccountLinks(rows, tokens, preparedAtMs) {
  const byToken = new Map(tokens.map(token => [token.id, token]));
  return rows.filter(row => {
    if (row.league_id !== null || !["pending", "failed", "publishing"].includes(row.status) ||
        !Object.hasOwn(LINK_EVENT_PURPOSES, row.event_type)) return false;
    if (row.created_at_ms > preparedAtMs || row.updated_at_ms > preparedAtMs) {
      fail("RECOVERY_PREPARATION_INPUT_INVALID", "The preparation time predates a restored account link.");
    }
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch { /* Reject ambiguous restored records. */ }
    const token = byToken.get(payload?.tokenId);
    const purpose = LINK_EVENT_PURPOSES[row.event_type];
    if (!token || payload.schemaVersion !== 1 || payload.purpose !== purpose || token.purpose !== purpose ||
        payload.deliveryKind !== (purpose === "email_verification" ? "email_verification" : "account_action_link") ||
        payload.recipientUserId !== token.user_id || row.aggregate_type !== "user" || row.aggregate_id !== token.user_id ||
        payload.expiresAtMs !== token.expires_at_ms) {
      fail("RECOVERY_ACCOUNT_LINK_INVALID", "A restored account link cannot be reconciled with its exact token and recipient.");
    }
    return true;
  });
}

// Creates an offline derivative of a verified restore. The selected restore and
// the application database are never opened for writing or activated here.
function prepareRecoveryCredentials({
  restoredCandidate,
  temporaryRoot,
  outputDirectory,
  expectedEnvironmentId,
  expectedDatabaseId,
  recoveryId,
  preparedAtMs,
  beforeCommit = null,
} = {}) {
  if (
    restoredCandidate?.status !== "verified" || !UUID.test(restoredCandidate?.backupId || "") ||
    !DIGEST.test(restoredCandidate?.plaintextSha256 || "") || !restoredCandidate?.inspection ||
    !path.isAbsolute(restoredCandidate?.targetDatabasePath || "") ||
    !path.isAbsolute(temporaryRoot || "") || !path.isAbsolute(outputDirectory || "") ||
    !IDENTITY.test(expectedEnvironmentId || "") || !IDENTITY.test(expectedDatabaseId || "") ||
    !AUDIT_UUID.test(recoveryId || "") || !Number.isSafeInteger(preparedAtMs) || preparedAtMs < 0 ||
    (beforeCommit !== null && typeof beforeCommit !== "function")
  ) {
    fail("RECOVERY_PREPARATION_INPUT_INVALID", "Exact verified-candidate and recovery preparation evidence is required.");
  }

  let ownedDirectory = null;
  let connection;
  try {
    const root = fs.realpathSync(temporaryRoot);
    const source = fs.realpathSync(restoredCandidate.targetDatabasePath);
    const output = path.join(fs.realpathSync(path.dirname(outputDirectory)), path.basename(outputDirectory));
    if (
      !inside(fs.realpathSync(os.tmpdir()), root) || !inside(root, source) || !inside(root, output) ||
      fs.lstatSync(restoredCandidate.targetDatabasePath).isSymbolicLink() ||
      !fs.statSync(source).isFile() || fs.statSync(source).nlink !== 1 || exists(output)
    ) {
      fail("RECOVERY_PREPARATION_PATH_UNSAFE", "Recovery preparation requires a new isolated temporary output.");
    }
    assertSourceUnchanged(source, restoredCandidate.plaintextSha256);
    const sourceInspection = inspectDatabase(source);
    if (canonicalize(sourceInspection) !== canonicalize(restoredCandidate.inspection) ||
        sourceInspection.databaseIdentity.environmentId !== expectedEnvironmentId ||
        sourceInspection.databaseIdentity.databaseId !== expectedDatabaseId) {
      fail("RECOVERY_PREPARATION_IDENTITY_MISMATCH", "The verified candidate identity or inspection does not match.");
    }
    assertSourceUnchanged(source, restoredCandidate.plaintextSha256);
    fs.mkdirSync(output, { recursive: false, mode: 0o700 });
    ownedDirectory = output;
    const preparedPath = path.join(output, "credentials-prepared.sqlite3");
    fs.copyFileSync(source, preparedPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(preparedPath, 0o600);
    if (hashFile(preparedPath) !== restoredCandidate.plaintextSha256) {
      fail("RECOVERY_SOURCE_CHANGED", "The copied recovery candidate does not match its verified source.");
    }
    connection = openDatabase({
      databasePath: preparedPath, environment: "staging", persistentRoot: root, requirePersistentRoot: true,
    });
    const database = connection.database;
    const sessions = createSqliteSessionRepository({ database });
    const tokens = createSqliteAccountActionTokenRepository({ database });
    const audit = createSqliteSecurityAuditRepository({ database });
    const outbox = createSqliteOutboxEventRepository({ database });

    const counts = database.transaction(() => {
      assertDatabaseIdentity(database, { environmentId: expectedEnvironmentId, databaseId: expectedDatabaseId });
      assertRecoveryRuntimeAllowed(database);
      if (audit.findById(recoveryId)) {
        fail("RECOVERY_PREPARATION_ALREADY_RECORDED", "This recovery identifier is already recorded in the candidate.");
      }
      const protectedTables = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all().map(({ name }) => name).filter((name) => !CHANGED_TABLES.has(name));
      const preserved = fingerprint(database, protectedTables);
      const beforeSessions = database.prepare("SELECT * FROM sessions ORDER BY id").all();
      const beforeTokens = database.prepare("SELECT * FROM account_action_tokens ORDER BY id").all();
      const beforeAudit = database.prepare("SELECT * FROM security_audit_events ORDER BY id").all();
      const beforeMetadata = database.prepare("SELECT * FROM application_metadata ORDER BY metadata_key").all();
      const beforeOutbox = database.prepare("SELECT * FROM outbox_events ORDER BY id").all();
      const beforeJobs = database.prepare("SELECT * FROM job_runs ORDER BY id").all();
      const restoredLeases = beforeJobs.filter(row => ["leased", "running"].includes(row.status));
      if (restoredLeases.some(row => row.created_at_ms > preparedAtMs || row.updated_at_ms > preparedAtMs ||
          !Number.isSafeInteger(row.version + 1))) {
        fail("RECOVERY_PREPARATION_INPUT_INVALID", "A restored job lease cannot be invalidated at this preparation boundary.");
      }
      const staleLinks = restoredAccountLinks(beforeOutbox, beforeTokens, preparedAtMs);
      const staleLinkIds = new Set(staleLinks.map(row => row.id));
      const activeSessions = beforeSessions.filter(({ status }) => status === "active");
      const activeTokens = beforeTokens.filter(({ status }) => status === "active");
      if ([...activeSessions, ...activeTokens].some(({ created_at_ms }) => preparedAtMs < created_at_ms)) {
        fail("RECOVERY_PREPARATION_INPUT_INVALID", "The preparation time predates a restored active credential.");
      }
      const initialChanges = database.prepare("SELECT total_changes() AS count").get().count;
      const holdRecord = {
        metadata_key: RECOVERY_HOLD_KEY,
        metadata_value: canonicalize({ recoveryId, sourceBackupId: restoredCandidate.backupId,
          sourcePlaintextSha256: restoredCandidate.plaintextSha256, state: "held" }),
        created_at_ms: preparedAtMs, updated_at_ms: preparedAtMs,
      };
      database.prepare("INSERT INTO application_metadata (metadata_key,metadata_value,created_at_ms,updated_at_ms) " +
        "VALUES (@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(holdRecord);
      for (const session of activeSessions) {
        sessions.revokeActive({
          sessionId: session.id, expectedVersion: session.version, changedAtMs: preparedAtMs,
          reason: "platform_security_action", transactionHook: null,
        });
      }
      for (const token of activeTokens) {
        tokens.invalidateActive({ tokenId: token.id, expectedVersion: token.version,
          changedAtMs: preparedAtMs, transactionHook: null });
      }
      // Every restored action link is stale after this credential boundary,
      // including links for already consumed, expired or invalidated tokens.
      // Other account notifications and every league event remain held intact.
      for (const link of staleLinks) {
        outbox.discard({ eventId: link.id, expectedVersion: link.version,
          nowMs: preparedAtMs, errorCode: STALE_LINK_REASON });
      }
      // Retain each occurrence and its recorded state for reconciliation while
      // invalidating the restored worker's token, version and expiry. This is
      // not a claim, retry, completion or permission to execute the occurrence.
      const invalidateLease = database.prepare("UPDATE job_runs SET lease_owner=NULL, lease_token=NULL, " +
        "lease_expires_at_ms=?, updated_at_ms=?, version=version+1 WHERE id=? AND version=? AND status IN ('leased','running')");
      for (const lease of restoredLeases) {
        if (invalidateLease.run(preparedAtMs, preparedAtMs, lease.id, lease.version).changes !== 1) {
          fail("RECOVERY_PREPARATION_POSTCHECK_FAILED", "A restored job lease changed during preparation.");
        }
      }
      audit.append({
        id: recoveryId, event_type: "recovery.credentials_invalidated", outcome: "success",
        actor_user_id: null, target_user_id: null, league_id: null, session_id: null,
        request_correlation_id: recoveryId,
        reason_code: `restore_${restoredCandidate.backupId}_${restoredCandidate.plaintextSha256}`,
        network_key_version: null, network_metadata_digest: null, unknown_account_digest: null,
        client_metadata_json: '{"networkSourceCategory":"local"}',
        occurred_at_ms: preparedAtMs,
      });
      if (beforeCommit && beforeCommit(database)?.then) {
        fail("RECOVERY_PREPARATION_INPUT_INVALID", "Recovery preparation hooks must finish synchronously.");
      }
      const expectedSessions = beforeSessions.map((row) => row.status !== "active" ? row : {
        ...row, status: "revoked", revoked_at_ms: preparedAtMs,
        revocation_reason: "platform_security_action", version: row.version + 1,
      });
      const expectedTokens = beforeTokens.map((row) => row.status !== "active" ? row : {
        ...row, status: "invalidated", invalidated_at_ms: preparedAtMs, version: row.version + 1,
      });
      const expectedOutbox = beforeOutbox.map(row => !staleLinkIds.has(row.id) ? row : {
        ...row, status: "discarded", payload_json: CLEARED_PAYLOAD_JSON, last_error_code: STALE_LINK_REASON,
        updated_at_ms: preparedAtMs, version: row.version + 1,
      });
      const expectedJobs = beforeJobs.map(row => !["leased", "running"].includes(row.status) ? row : {
        ...row, lease_owner: null, lease_token: null, lease_expires_at_ms: preparedAtMs,
        updated_at_ms: preparedAtMs, version: row.version + 1,
      });
      if (
        canonicalize(database.prepare("SELECT * FROM sessions ORDER BY id").all()) !== canonicalize(expectedSessions) ||
        canonicalize(database.prepare("SELECT * FROM account_action_tokens ORDER BY id").all()) !== canonicalize(expectedTokens) ||
        canonicalize(database.prepare("SELECT * FROM outbox_events ORDER BY id").all()) !== canonicalize(expectedOutbox) ||
        canonicalize(database.prepare("SELECT * FROM job_runs ORDER BY id").all()) !== canonicalize(expectedJobs) ||
        canonicalize(database.prepare("SELECT * FROM security_audit_events WHERE id <> ? ORDER BY id").all(recoveryId)) !== canonicalize(beforeAudit) ||
        canonicalize(database.prepare("SELECT * FROM application_metadata WHERE metadata_key <> ? ORDER BY metadata_key").all(RECOVERY_HOLD_KEY)) !== canonicalize(beforeMetadata) ||
        canonicalize(database.prepare("SELECT * FROM application_metadata WHERE metadata_key = ?").get(RECOVERY_HOLD_KEY)) !== canonicalize(holdRecord) ||
        canonicalize(fingerprint(database, protectedTables)) !== canonicalize(preserved) ||
        database.prepare("SELECT total_changes() AS count").get().count - initialChanges !== activeSessions.length + activeTokens.length + staleLinks.length + restoredLeases.length + 2 ||
        database.pragma("foreign_key_check").length !== 0
      ) {
        fail("RECOVERY_PREPARATION_POSTCHECK_FAILED", "The candidate preparation did not preserve its exact allowed changes.");
      }
      assertSourceUnchanged(source, restoredCandidate.plaintextSha256);
      return { sessionsRevoked: activeSessions.length, actionTokensInvalidated: activeTokens.length,
        staleAccountLinksDiscarded: staleLinks.length, staleAccountLinkEvidenceSha256: hash(canonicalize(staleLinks)),
        restoredJobLeasesInvalidated: restoredLeases.length, restoredJobLeaseEvidenceSha256: hash(canonicalize(restoredLeases)),
        jobOccurrences: "preserved-and-held",
        otherOutboxRecords: "unchanged-and-held",
        protectedTableCount: protectedTables.length };
    }).immediate();
    connection.database.close();
    connection = null;
    const inspection = inspectDatabase(preparedPath);
    assertSourceUnchanged(source, restoredCandidate.plaintextSha256);
    const reportBase = {
      reportVersion: 4, recoveryId, sourceBackupId: restoredCandidate.backupId,
      sourcePlaintextSha256: restoredCandidate.plaintextSha256, preparedPlaintextSha256: hashFile(preparedPath),
      preparedAtMs, ...counts, sourceDatabase: "unchanged", status: "credentials-prepared",
      normalRuntime: "blocked-by-durable-recovery-hold",
      activationReady: false, remainingRecoveryGates: ["recovery-execution-boundary", "job-and-outbox-reconciliation", "financial-and-league-reconciliation", "controlled-reopening"],
    };
    const report = { ...reportBase, reportChecksum: hash(canonicalize(reportBase)) };
    fs.writeFileSync(path.join(output, "credential-preparation.json"), `${canonicalize(report)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ ...report, preparedDatabasePath: preparedPath, inspection });
  } catch (error) {
    const cleanupErrors = [];
    try { if (connection?.database?.open) connection.database.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { if (ownedDirectory !== null) fs.rmSync(ownedDirectory, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length) {
      fail("RECOVERY_PREPARATION_CLEANUP_FAILED", "The isolated recovery candidate could not be fully cleaned.", new AggregateError([error, ...cleanupErrors]));
    }
    if (error instanceof RecoveryCredentialPreparationError) throw error;
    fail("RECOVERY_PREPARATION_FAILED", "The isolated recovery credential preparation failed safely.", error);
  }
}

module.exports = { RecoveryCredentialPreparationError, prepareRecoveryCredentials };
