const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadBackupConfig } = require("../../src/config/loadBackupConfig");
const { createObjectStorageAdapter } = require("../../src/infrastructure/backups/createObjectStorageAdapter");
const { openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { createEncryptedOffsiteBackup } = require("../../src/operations/backups/createEncryptedOffsiteBackup");
const { restoreEncryptedBackupToCleanPath } = require("../../src/operations/backups/restoreEncryptedBackupToCleanPath");
const { prepareRecoveryCredentials } = require("../../src/operations/backups/prepareRecoveryCredentials");
const { inspectRecoveryInventory } = require("../../src/operations/backups/inspectRecoveryInventory");
const { createReleaseQaRuntime } = require("../../src/operations/release/createReleaseQaRuntime");
const { fixtureId, canonicalize, FIXTURE_DATABASE_ID, FIXTURE_ENVIRONMENT_ID } = require("../../src/operations/release/releaseQaFixtureContract");
const { createSessionService } = require("../../src/application/services/accounts/createSessionService");
const { createAccountActionTokenService } = require("../../src/application/services/accounts/createAccountActionTokenService");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createSqliteSessionRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSessionRepository");
const { createSqliteAccountActionTokenRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteAccountActionTokenRepository");
const { createSecureRandom } = require("../../src/infrastructure/security/createSecureRandom");
const { createSessionSecrets } = require("../../src/infrastructure/security/createSessionSecrets");
const { createOpaqueActionTokens } = require("../../src/infrastructure/security/createOpaqueActionTokens");
const { RECOVERY_HOLD_KEY } = require("../../src/infrastructure/database/recoveryHold");
const { createTargetRuntime } = require("../../src/bootstrap/createTargetRuntime");

const PURPOSES = ["email_verification", "administrator_setup", "password_reset", "self_reactivation"];
const PRIVATE_VALUE = "private-recovery-credential-marker";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readHash = (file) => hash(fs.readFileSync(file));
const sessionBytes = Buffer.alloc(32, 19);
const tokenBytes = (index) => Buffer.alloc(32, index + 20);

function assertCredentialAccess(database, valid) {
  const secureRandom = createSecureRandom();
  const clock = { nowMs: () => 100 };
  const sessions = createSessionService({
    userRepository: createSqliteUserRepository({ database }),
    sessionRepository: createSqliteSessionRepository({ database }),
    sessionSecrets: createSessionSecrets({ secureRandom }), secureRandom, clock,
  });
  const tokens = createAccountActionTokenService({
    repository: createSqliteAccountActionTokenRepository({ database }),
    opaqueTokens: createOpaqueActionTokens({ secureRandom }), secureRandom, clock,
  });
  assert.equal(sessions.resolveWithoutActivity(sessionBytes.toString("base64url")).valid, valid);
  for (const [index, purpose] of PURPOSES.entries()) {
    assert.equal(tokens.resolve({ rawToken: tokenBytes(index).toString("base64url"), expectedPurpose: purpose }).valid, valid);
  }
}

function seedCredentials(database) {
  const userId = fixtureId("recovery-preparation:user");
  database.prepare(
    "INSERT INTO users (id,email_normalized,email_display,display_name,display_name_normalized,status," +
    "created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,?,'active',10,10,1)"
  ).run(userId, `${PRIVATE_VALUE}@example.test`, `${PRIVATE_VALUE}@example.test`, PRIVATE_VALUE, PRIVATE_VALUE);
  for (const [index, status] of ["active", "revoked", "expired"].entries()) {
    database.prepare(
      "INSERT INTO sessions (id,user_id,token_digest,csrf_secret_digest,status,created_at_ms," +
      "last_used_at_ms,idle_expires_at_ms,absolute_expires_at_ms,revoked_at_ms,client_metadata_json,version) " +
      "VALUES (?,?,?,?,?,10,10,500,1000,?,?,1)"
    ).run(fixtureId(`recovery-preparation:session:${status}`), userId, index === 0 ? hash(sessionBytes) : String(index + 1).repeat(64),
      "f".repeat(64), status, status === "active" ? null : 50, JSON.stringify({ private: PRIVATE_VALUE }));
  }
  for (const [index, purpose] of [...PURPOSES, "password_reset", "password_reset", "password_reset"].entries()) {
    const status = index < 4 ? "active" : ["consumed", "invalidated", "expired"][index - 4];
    database.prepare(
      "INSERT INTO account_action_tokens (id,user_id,token_digest,purpose,status,created_at_ms," +
      "expires_at_ms,consumed_at_ms,invalidated_at_ms,version) VALUES (?,?,?,?,?,10,500,?,?,1)"
    ).run(fixtureId(`recovery-preparation:token:${index}`), userId, hash(tokenBytes(index)), purpose, status,
      status === "consumed" ? 50 : null, status === "invalidated" ? 50 : null);
  }
}

function allRows(database) {
  return Object.fromEntries(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all()
    .map(canonicalize).sort()]));
}

async function candidate(t) {
  const started = await createReleaseQaRuntime({
    frontendOrigin: "http://127.0.0.1:5173", leagueWriteMode: "closed", port: 0,
    migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
    password: "Recovery Preparation Fixture Password 2026!",
  });
  t.after(() => started.close());
  seedCredentials(started.runtime.database);
  const encryptionKey = crypto.randomBytes(32);
  const config = loadBackupConfig({
    env: {
      BACKUP_LOCAL_DIR: path.join(started.temporaryRoot, "backup-work"),
      BACKUP_OBJECT_ENDPOINT: "https://release-qa.invalid", BACKUP_OBJECT_REGION: "local-1",
      BACKUP_OBJECT_BUCKET: "hundo-release-qa", BACKUP_OBJECT_PREFIX: "m7/recovery/",
      BACKUP_OBJECT_ACCESS_KEY_ID: "local-release-qa", BACKUP_OBJECT_SECRET_ACCESS_KEY: "fixture-only",
      BACKUP_ENCRYPTION_KEY_VERSION: "m7-local-v1", BACKUP_ENCRYPTION_KEY: encryptionKey.toString("base64url"),
      BACKUP_SCHEDULE_ENABLED: "false",
    },
    runtimeConfig: { appEnv: "staging", persistentRoot: started.temporaryRoot,
      environmentId: FIXTURE_ENVIRONMENT_ID, databaseId: FIXTURE_DATABASE_ID },
  });
  const objects = new Map();
  const objectStorage = createObjectStorageAdapter({ client: {
    async putObject({ key, body, visibility }) {
      assert.equal(visibility, "private"); objects.set(key, Buffer.from(body)); return { stored: true };
    },
    async headObject({ key }) { const body = objects.get(key); return body ? { byteSize: body.length, sha256: hash(body) } : null; },
    async getObject({ key }) { return { body: Buffer.from(objects.get(key)) }; },
  } });
  const backup = await createEncryptedOffsiteBackup({
    databasePath: started.databasePath, config, objectStorage, reason: "pre-cutover-rehearsal",
    requestedByType: "release_qa_automation", requestedById: "m7-local-release-rehearsal",
    backendBuildId: "m7-local-backend", retentionClass: "incident-preservation",
  });
  const restoredCandidate = await restoreEncryptedBackupToCleanPath({
    manifestObjectKey: backup.manifestObjectKey, objectStorage, keyResolver: async () => encryptionKey,
    expectedEnvironment: config.appEnv, expectedEnvironmentId: config.environmentId,
    expectedDatabaseId: config.databaseId, targetDatabasePath: path.join(started.temporaryRoot, "restored.sqlite3"),
    temporaryRoot: started.temporaryRoot,
  });
  const input = { restoredCandidate, temporaryRoot: started.temporaryRoot,
    expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID, expectedDatabaseId: FIXTURE_DATABASE_ID,
    recoveryId: crypto.randomUUID(), preparedAtMs: 100 };
  return { started, input, config, objectStorage, encryptionKey, backup };
}

test("encrypted clean restore preparation invalidates credentials atomically and preserves both leagues", async (t) => {
  const { started, input, config, objectStorage, encryptionKey } = await candidate(t);
  const sourceBefore = started.runtime.database.serialize();
  const originalHash = readHash(input.restoredCandidate.targetDatabasePath);
  const sourceRows = allRows(started.runtime.database);
  assertCredentialAccess(started.runtime.database, true);
  const outputDirectory = path.join(input.temporaryRoot, "prepared");
  const report = prepareRecoveryCredentials({ ...input, outputDirectory });
  const database = openReadonlyDatabase({ databasePath: report.preparedDatabasePath });
  let preparedRows;
  try {
    assertCredentialAccess(database, false);
    assert.equal(report.sessionsRevoked, 1);
    assert.equal(report.actionTokensInvalidated, 4);
    assert.equal(report.activationReady, false);
    assert.equal(report.sourceDatabase, "unchanged");
    assert.equal(report.normalRuntime, "blocked-by-durable-recovery-hold");
    assert.equal(report.sourceBackupId, input.restoredCandidate.backupId);
    assert.equal(report.sourcePlaintextSha256, originalHash);
    assert.notEqual(report.preparedPlaintextSha256, originalHash);
    const inventory = inspectRecoveryInventory({ database, expectedDatabaseId: FIXTURE_DATABASE_ID,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID, observedAtMs: 100 });
    assert.equal(inventory.sessions.active, 0);
    for (const purpose of PURPOSES) assert.equal(inventory.activeActionTokens[purpose], 0);
    preparedRows = allRows(database);
    for (const [table, rows] of Object.entries(sourceRows)) {
      if (!["sessions", "account_action_tokens", "security_audit_events", "application_metadata"].includes(table)) {
        assert.deepEqual(preparedRows[table], rows, table);
      }
    }
    assert.deepEqual(preparedRows.application_metadata.filter((row) => JSON.parse(row).metadata_key !== RECOVERY_HOLD_KEY), sourceRows.application_metadata);
    const hold = database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY);
    assert.equal(JSON.parse(hold.metadata_value).recoveryId, input.recoveryId);
    assert.equal(JSON.parse(hold.metadata_value).sourcePlaintextSha256, originalHash);
    assert.throws(() => createTargetRuntime({ database,
      migrationsDirectory: path.resolve(__dirname, "../../database/migrations") }), { code: "DATABASE_RECOVERY_HELD" });
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, 0);
    for (const table of ["sessions", "account_action_tokens"]) {
      for (const row of sourceRows[table].map(JSON.parse).filter(({ status }) => status !== "active")) {
        assert.deepEqual(database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id), row);
      }
    }
    const audit = database.prepare("SELECT * FROM security_audit_events WHERE id=?").get(input.recoveryId);
    assert.equal(audit.event_type, "recovery.credentials_invalidated");
    assert.equal(audit.reason_code, `restore_${report.sourceBackupId}_${originalHash}`);
    assert.equal(audit.occurred_at_ms, 100);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    const receipt = JSON.parse(fs.readFileSync(path.join(outputDirectory, "credential-preparation.json")));
    const { reportChecksum, ...body } = receipt;
    assert.equal(hash(canonicalize(body)), reportChecksum);
    for (const value of [PRIVATE_VALUE, "f".repeat(64), "1".repeat(64)]) {
      assert.equal(JSON.stringify(receipt).includes(value), false);
    }
  } finally { database.close(); }
  assert.equal(readHash(input.restoredCandidate.targetDatabasePath), originalHash);
  assert.deepEqual(started.runtime.database.serialize(), sourceBefore);

  await t.test("a new encrypted backup preserves invalidated credentials, audit and hold across another restore", async () => {
    const backup = await createEncryptedOffsiteBackup({
      databasePath: report.preparedDatabasePath, config, objectStorage, reason: "pre-cutover-rehearsal",
      requestedByType: "release_qa_automation", requestedById: "m7-local-post-preparation-rehearsal",
      backendBuildId: "m7-local-backend", retentionClass: "incident-preservation",
    });
    const restored = await restoreEncryptedBackupToCleanPath({
      manifestObjectKey: backup.manifestObjectKey, objectStorage, keyResolver: async () => encryptionKey,
      expectedEnvironment: config.appEnv, expectedEnvironmentId: config.environmentId,
      expectedDatabaseId: config.databaseId, targetDatabasePath: path.join(input.temporaryRoot, "prepared-restored.sqlite3"),
      temporaryRoot: input.temporaryRoot,
    });
    const restoredDatabase = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
    try {
      assert.notEqual(backup.backupId, input.restoredCandidate.backupId);
      assert.deepEqual(allRows(restoredDatabase), preparedRows);
      assertCredentialAccess(restoredDatabase, false);
      assert.throws(() => createTargetRuntime({ database: restoredDatabase,
        migrationsDirectory: path.resolve(__dirname, "../../database/migrations") }), { code: "DATABASE_RECOVERY_HELD" });
    } finally { restoredDatabase.close(); }
    assert.equal(readHash(report.preparedDatabasePath), report.preparedPlaintextSha256);
  });

  await t.test("a repeated output preserves the existing prepared files", () => {
    const preparedHash = readHash(report.preparedDatabasePath);
    assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory }), { code: "RECOVERY_PREPARATION_PATH_UNSAFE" });
    assert.equal(readHash(report.preparedDatabasePath), preparedHash);
  });

  await t.test("mismatched evidence, earlier time, active source sidecars and escaped paths fail closed", () => {
    for (const [index, overrides, code] of [
      [0, { expectedDatabaseId: "different-database" }, "RECOVERY_PREPARATION_IDENTITY_MISMATCH"],
      [1, { restoredCandidate: { ...input.restoredCandidate, plaintextSha256: "e".repeat(64) } }, "RECOVERY_SOURCE_CHANGED"],
      [2, { preparedAtMs: 9 }, "RECOVERY_PREPARATION_INPUT_INVALID"],
      [3, { outputDirectory: path.join(input.temporaryRoot, "..", "escaped-candidate") }, "RECOVERY_PREPARATION_PATH_UNSAFE"],
    ]) {
      const output = path.join(input.temporaryRoot, `rejected-${index}`);
      assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory: output, ...overrides }), { code });
      assert.equal(fs.existsSync(output), false);
    }
    const sidecar = `${input.restoredCandidate.targetDatabasePath}-wal`;
    fs.writeFileSync(sidecar, "another writer", { flag: "wx" });
    try {
      assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory: path.join(input.temporaryRoot, "sidecar-rejected") }), { code: "RECOVERY_SOURCE_CHANGED" });
      assert.equal(fs.readFileSync(sidecar, "utf8"), "another writer");
    } finally { fs.unlinkSync(sidecar); }
  });

  await t.test("interrupted preparation rolls back every credential and audit write before cleanup", () => {
    const output = path.join(input.temporaryRoot, "interrupted");
    let rollbackObserved = false;
    assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory: output, beforeCommit(database) {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status='active'").get().count, 0);
      const close = database.close.bind(database);
      database.close = () => {
        assert.equal(database.inTransaction, false);
        assert.deepEqual(allRows(database), sourceRows);
        rollbackObserved = true;
        return close();
      };
      throw new Error("simulated preparation interruption");
    } }), { code: "RECOVERY_PREPARATION_FAILED" });
    assert.equal(rollbackObserved, true);
    assert.equal(fs.existsSync(output), false);
  });

  await t.test("an unexpected league write rejects and rolls back the entire candidate", () => {
    const output = path.join(input.temporaryRoot, "unexpected-write");
    assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory: output, beforeCommit(database) {
      database.prepare("UPDATE teams SET version=version+1 WHERE id=(SELECT id FROM teams ORDER BY id LIMIT 1)").run();
    } }), { code: "RECOVERY_PREPARATION_POSTCHECK_FAILED" });
    assert.equal(fs.existsSync(output), false);
  });
  assert.equal(readHash(input.restoredCandidate.targetDatabasePath), originalHash);
  assert.deepEqual(started.runtime.database.serialize(), sourceBefore);
});

test("restoring the selected backup excludes a later real buyout and restores exact financial rows in both leagues", async (t) => {
  const { started, input, config, objectStorage, encryptionKey, backup } = await candidate(t);
  const source = started.runtime.database;
  const atBackup = allRows(source);
  const contractId = fixtureId("contract:leagueB:signedProspect");
  const contractAtBackup = source.prepare("SELECT * FROM contracts WHERE id=?").get(contractId);
  const otherLeagueAtBackup = source.prepare("SELECT * FROM contracts WHERE league_id=? ORDER BY id").all(fixtureId("league:leagueA"));
  const penaltyTotalAtBackup = source.prepare("SELECT COALESCE(SUM(penalty_cents),0) AS total FROM buyout_years").get().total;
  const issued = started.runtime.services.sessionService.issueForUser({ userId: fixtureId("account:leagueBManagerOne") });
  const authenticated = started.runtime.services.sessionService.resolve(issued.rawSessionToken);
  assert.equal(authenticated.valid, true);
  const boughtOut = await started.runtime.services.league.rosterAction.buyOutContract({
    authenticated, leagueId: fixtureId("league:leagueB"), teamId: fixtureId("team:leagueB:6"), contractId,
    input: { confirmed: true, expectedContractVersion: 1, expectedOwnershipVersion: 1 },
  });
  assert.equal(boughtOut.code, "CONTRACT_BOUGHT_OUT");
  assert.equal(source.prepare("SELECT status FROM contracts WHERE id=?").get(contractId).status, "eliminated");
  assert.equal(source.prepare("SELECT COALESCE(SUM(penalty_cents),0) AS total FROM buyout_years").get().total,
    penaltyTotalAtBackup + boughtOut.buyout.annualPenaltyCents * boughtOut.buyout.remainingYears);
  assert.deepEqual(source.prepare("SELECT * FROM contracts WHERE league_id=? ORDER BY id").all(fixtureId("league:leagueA")), otherLeagueAtBackup);
  assert.deepEqual(source.pragma("foreign_key_check"), []);
  const sourceAfterKnownChanges = source.serialize();
  const restored = await restoreEncryptedBackupToCleanPath({
    manifestObjectKey: backup.manifestObjectKey, objectStorage, keyResolver: async () => encryptionKey,
    expectedEnvironment: config.appEnv, expectedEnvironmentId: config.environmentId,
    expectedDatabaseId: config.databaseId, targetDatabasePath: path.join(input.temporaryRoot, "loss-window-restored.sqlite3"),
    temporaryRoot: input.temporaryRoot,
  });
  const prepared = prepareRecoveryCredentials({ ...input, restoredCandidate: restored,
    outputDirectory: path.join(input.temporaryRoot, "loss-window-prepared") });
  const database = openReadonlyDatabase({ databasePath: prepared.preparedDatabasePath });
  try {
    assert.deepEqual(database.prepare("SELECT * FROM contracts WHERE id=?").get(contractId), contractAtBackup);
    assert.equal(database.prepare("SELECT * FROM buyout_obligations WHERE id=?").get(boughtOut.buyout.id), undefined);
    assert.equal(database.prepare("SELECT * FROM sessions WHERE id=?").get(issued.session.id), undefined);
    assert.equal(database.prepare("SELECT COALESCE(SUM(penalty_cents),0) AS total FROM buyout_years").get().total, penaltyTotalAtBackup);
    const recovered = allRows(database);
    for (const [table, rows] of Object.entries(atBackup)) {
      if (!["sessions", "account_action_tokens", "security_audit_events", "application_metadata"].includes(table)) {
        assert.deepEqual(recovered[table], rows, table);
      }
    }
    assertCredentialAccess(database, false);
    assert.equal(prepared.activationReady, false);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
  assert.deepEqual(source.serialize(), sourceAfterKnownChanges);
  assert.equal(source.prepare("SELECT status FROM contracts WHERE id=?").get(contractId).status, "eliminated");
});
