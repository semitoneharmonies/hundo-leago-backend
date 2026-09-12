const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { loadBackupConfig } = require("../../src/config/loadBackupConfig");
const { createObjectStorageAdapter } = require("../../src/infrastructure/backups/createObjectStorageAdapter");
const { openDatabase, openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { createEncryptedOffsiteBackup } = require("../../src/operations/backups/createEncryptedOffsiteBackup");
const { restoreEncryptedBackupToCleanPath } = require("../../src/operations/backups/restoreEncryptedBackupToCleanPath");
const { prepareRecoveryCredentials } = require("../../src/operations/backups/prepareRecoveryCredentials");
const { buildRecoveryReconciliationPlan } = require("../../src/operations/backups/buildRecoveryReconciliationPlan");
const { prepareRecoveryEmailReconciliation } = require("../../src/operations/backups/prepareRecoveryEmailReconciliation");
const { prepareRecoveryStatisticsReconciliation } = require("../../src/operations/backups/prepareRecoveryStatisticsReconciliation");
const { buildEmailReconciledRecoveryPlan } = require("../../src/operations/backups/buildEmailReconciledRecoveryPlan");
const { createLeagueOutboxPublicationService } = require("../../src/application/services/activity/createLeagueOutboxPublicationService");
const { createSqliteLeagueOutboxRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository");
const { compareRecoveryLossWindow } = require("../../src/operations/backups/compareRecoveryLossWindow");
const { createVerifiedBackup, BACKUP_FILE_NAME } = require("../../src/infrastructure/database/sqliteBackup");
const { inspectRecoveryInventory } = require("../../src/operations/backups/inspectRecoveryInventory");
const { createReleaseQaRuntime } = require("../../src/operations/release/createReleaseQaRuntime");
const { fixtureId, canonicalize, FIXTURE_DATABASE_ID, FIXTURE_ENVIRONMENT_ID } = require("../../src/operations/release/releaseQaFixtureContract");
const { createSessionService } = require("../../src/application/services/accounts/createSessionService");
const { createAccountActionTokenService } = require("../../src/application/services/accounts/createAccountActionTokenService");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createSqliteSessionRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSessionRepository");
const { createSqliteAccountActionTokenRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteAccountActionTokenRepository");
const { createSqliteStatisticsScheduleRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsScheduleRepository");
const { ACTION_LINK_EVENTS, CLEARED_PAYLOAD_JSON } = require("../../src/infrastructure/persistence/sqlite/SqliteOutboxEventRepository");
const { createSecureRandom } = require("../../src/infrastructure/security/createSecureRandom");
const { createSessionSecrets } = require("../../src/infrastructure/security/createSessionSecrets");
const { createOpaqueActionTokens } = require("../../src/infrastructure/security/createOpaqueActionTokens");
const { RECOVERY_HOLD_KEY } = require("../../src/infrastructure/database/recoveryHold");
const { RECOVERY_EPOCH_KEY, readRecoveryEpoch } = require("../../src/infrastructure/database/recoveryEpoch");
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
    const payload = { schemaVersion: 1, deliveryKind: purpose === "email_verification" ? "email_verification" : "account_action_link",
      purpose, tokenId: fixtureId(`recovery-preparation:token:${index}`), recipientUserId: userId, expiresAtMs: 500,
      envelope: { algorithm: "A256GCM", envelopeVersion: 1, keyVersion: 1, nonce: "fixture", authenticationTag: "fixture", ciphertext: PRIVATE_VALUE } };
    database.prepare("INSERT INTO outbox_events (id,league_id,event_type,aggregate_type,aggregate_id,payload_json,status," +
      "attempt_count,available_at_ms,published_at_ms,last_error_code,created_at_ms,updated_at_ms,version) " +
      "VALUES (?,NULL,?,'user',?,?,?,1,10,NULL,NULL,10,10,1)")
      .run(fixtureId(`recovery-preparation:outbox:${index}`), purpose === "email_verification" ? "account.email_verification_requested" : ACTION_LINK_EVENTS[purpose],
        userId, JSON.stringify(payload), ["pending", "failed", "publishing"][index % 3]);
  }
  for (const [suffix, eventType, payload, status, publishedAt] of [
    ["security", "account.password_changed_notification", { schemaVersion: 1, deliveryKind: "security_notification", notificationKind: "password_changed", recipientUserId: userId, occurredAtMs: 10 }, "pending", null],
    ["published", "account.password_reset_requested", JSON.parse(CLEARED_PAYLOAD_JSON), "published", 50],
    ["discarded", "account.password_reset_requested", JSON.parse(CLEARED_PAYLOAD_JSON), "discarded", null],
  ]) {
    database.prepare("INSERT INTO outbox_events (id,league_id,event_type,aggregate_type,aggregate_id,payload_json,status," +
      "attempt_count,available_at_ms,published_at_ms,last_error_code,created_at_ms,updated_at_ms,version) " +
      "VALUES (?,NULL,?,'user',?,?,?,1,10,?,NULL,10,50,1)")
      .run(fixtureId(`recovery-preparation:outbox:${suffix}`), eventType, userId, JSON.stringify(payload), status, publishedAt);
  }
  for (const [index, status] of ["pending", "leased", "running", "failed", "succeeded", "skipped"].entries()) {
    database.prepare("INSERT INTO job_runs (id,league_id,job_type,occurrence_key,scheduled_for_ms,status,attempt_count," +
      "lease_owner,lease_token,lease_expires_at_ms,started_at_ms,completed_at_ms,result_json,created_at_ms,updated_at_ms,version) " +
      "VALUES (?,?,'recovery.fixture',?,20,?,1,?,?,?,30,?,?,10,50,1)")
      .run(fixtureId(`recovery-preparation:job:${status}`), index % 2 ? fixtureId("league:leagueA") : fixtureId("league:leagueB"),
        `recovery:${status}`, status, PRIVATE_VALUE, PRIVATE_VALUE, status === "leased" ? 80 : null,
        ["succeeded", "skipped"].includes(status) ? 50 : null, JSON.stringify({ private: PRIVATE_VALUE }));
  }
}

function allRows(database) {
  return Object.fromEntries(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all()
    .map(canonicalize).sort()]));
}

async function candidate(t, alterSource = null) {
  const started = await createReleaseQaRuntime({
    frontendOrigin: "http://127.0.0.1:5173", leagueWriteMode: "closed", port: 0,
    migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
    password: "Recovery Preparation Fixture Password 2026!",
  });
  t.after(() => started.close());
  seedCredentials(started.runtime.database);
  if (alterSource) alterSource(started.runtime.database);
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

test("selected restored league invalidations publish once without repeating domain effects after worker restart", async t => {
  const { started, input } = await candidate(t);
  const sourceBefore = started.runtime.database.serialize();
  const prepared = prepareRecoveryCredentials({ ...input, outputDirectory: path.join(input.temporaryRoot, "league-publication-input") });
  const preparedHash = readHash(prepared.preparedDatabasePath);
  const workPath = path.join(input.temporaryRoot, "league-publication-work.sqlite3");
  fs.copyFileSync(prepared.preparedDatabasePath, workPath, fs.constants.COPYFILE_EXCL);
  const database = openDatabase({ databasePath: workPath, environment: "staging", persistentRoot: input.temporaryRoot, requirePersistentRoot: true }).database;
  try {
    const before = allRows(database);
    const pending = database.prepare("SELECT * FROM outbox_events WHERE league_id IS NOT NULL AND status='pending' ORDER BY id").all();
    assert.ok(pending.length > 0); assert.equal(new Set(pending.map(row => row.league_id)).size, 2);
    // Explicit fixture event selection is local recovery-test authority only.
    // No scheduler, real Socket.IO publisher or ordinary runtime is started.
    const captured = [];
    const repository = createSqliteLeagueOutboxRepository({ database });
    const nowMs = Date.now();
    const publisher = { async publish(event) {
      assert.equal(event.payload.eventId, event.eventId);
      assert.equal(event.payload.leagueId, event.leagueId);
      assert.ok(event.audiences.length > 0);
      assert.ok(event.audiences.every(audience => audience.leagueId === event.leagueId));
      captured.push({ eventId: event.eventId, leagueId: event.leagueId, payload: event.payload, audiences: event.audiences });
    } };
    const service = createLeagueOutboxPublicationService({ repository, publisher, clock: { nowMs: () => nowMs } });
    const first = pending[0];
    const otherLeagueId = pending.find(row => row.league_id !== first.league_id).league_id;
    const initialBytes = database.serialize();
    assert.equal((await service.publishExact({ eventId: first.id, leagueId: otherLeagueId, expectedVersion: first.version })).outcome, "state_changed");
    assert.equal((await service.publishExact({ eventId: first.id, leagueId: first.league_id, expectedVersion: first.version + 1 })).outcome, "state_changed");
    assert.deepEqual(database.serialize(), initialBytes); assert.equal(captured.length, 0);
    for (const row of pending) {
      const result = await service.publishExact({ eventId: row.id, leagueId: row.league_id, expectedVersion: row.version });
      assert.equal(result.outcome, "published", database.prepare("SELECT last_error_code FROM outbox_events WHERE id=?").get(row.id)?.last_error_code);
    }
    assert.equal(captured.length, pending.length); assert.equal(new Set(captured.map(row => row.eventId)).size, pending.length);
    const after = allRows(database);
    for (const [table, rows] of Object.entries(before)) if (table !== "outbox_events") assert.deepEqual(after[table], rows, table);
    const selectedIds = new Set(pending.map(row => row.id));
    for (const row of before.outbox_events.map(JSON.parse)) {
      const actual = database.prepare("SELECT * FROM outbox_events WHERE id=?").get(row.id);
      if (!selectedIds.has(row.id)) assert.deepEqual(actual, row);
      else { assert.equal(actual.status, "published"); assert.equal(actual.attempt_count, row.attempt_count + 1); assert.equal(actual.payload_json, row.payload_json); }
    }
    const afterBytes = database.serialize();
    const restarted = createLeagueOutboxPublicationService({ repository: createSqliteLeagueOutboxRepository({ database }),
      publisher: { publish() { assert.fail("A completed restored occurrence must not publish again."); } }, clock: { nowMs: () => nowMs + 1000 } });
    for (const row of pending) {
      assert.equal((await restarted.publishExact({ eventId: row.id, leagueId: row.league_id, expectedVersion: row.version })).outcome, "state_changed");
      const current = repository.findById({ eventId: row.id, leagueId: row.league_id });
      assert.equal((await restarted.publishExact({ eventId: row.id, leagueId: row.league_id, expectedVersion: current.version })).outcome, "already_published");
    }
    assert.deepEqual(await restarted.publishDue(), []);
    assert.deepEqual(database.serialize(), afterBytes);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY).n, 1);
    assert.deepEqual(readRecoveryEpoch(database), prepared.recoveryEpoch); assertCredentialAccess(database, false);
  } finally { database.close(); }
  assert.equal(readHash(prepared.preparedDatabasePath), preparedHash);
  assert.deepEqual(started.runtime.database.serialize(), sourceBefore);
});

test("reviewed restored email suppression preserves source, jobs and every unrelated row", async t => {
  const { started, input, config, objectStorage, encryptionKey } = await candidate(t, database => {
    const original = database.prepare("SELECT * FROM outbox_events WHERE id=?").get(fixtureId("recovery-preparation:outbox:security"));
    for (const status of ["failed", "publishing"]) database.prepare("INSERT INTO outbox_events(" + Object.keys(original).join(",") + ") VALUES(" + Object.keys(original).map(key => `@${key}`).join(",") + ")")
      .run({ ...original, id: fixtureId(`recovery-email:${status}`), status });
  });
  const sourceBefore = started.runtime.database.serialize();
  const prepared = prepareRecoveryCredentials({ ...input, outputDirectory: path.join(input.temporaryRoot, "email-input") });
  // Keep the offline input free of SQLite reader sidecars by reviewing an
  // exact separate copy. The operation independently verifies another copy.
  const reviewPath = path.join(input.temporaryRoot, "email-review-source.sqlite3");
  fs.copyFileSync(prepared.preparedDatabasePath, reviewPath, fs.constants.COPYFILE_EXCL);
  const reader = openReadonlyDatabase({ databasePath: reviewPath });
  let plan; let beforeRows; let messages;
  try {
    plan = buildRecoveryReconciliationPlan({ database: reader, credentialPreparation: prepared, observedAtMs: 100,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID, expectedDatabaseId: FIXTURE_DATABASE_ID });
    beforeRows = allRows(reader);
    messages = reader.prepare("SELECT * FROM outbox_events WHERE league_id IS NULL AND status IN ('pending','failed','publishing') ORDER BY id").all();
  } finally { reader.close(); }
  const now = Date.now();
  const deliveries = messages.map(row => ({ eventId: row.id, rowSha256: hash(canonicalize(row)), payloadSha256: hash(row.payload_json),
    providerMessageSha256: hash(`synthetic-provider-message:${row.id}`), providerReceiptSha256: hash(`synthetic-delivery-receipt:${row.id}`), deliveredAtMs: 90 }));
  assert.equal(deliveries.length, 3);
  const options = { credentialPreparation: prepared, plan, deliveries, reviewedByUserId: fixtureId("account:platformAdmin"),
    reconciliationId: crypto.randomUUID(), reconciledAtMs: now, temporaryRoot: input.temporaryRoot };
  const sourceHash = readHash(prepared.preparedDatabasePath);
  let result;
  await t.test("suppresses exact pending, failed and publishing account messages while keeping the hold", async suppressionTest => {
    result = prepareRecoveryEmailReconciliation({ ...options, outputDirectory: path.join(input.temporaryRoot, "email-reviewed") });
    assert.equal(result.suppressedMessages, 3); assert.equal(result.protectedTableCount, 131);
    assert.equal(result.activationReady, false); assert.equal(result.jobs, "unchanged-and-held");
    assert.equal(result.providerEvidence, "reviewer-supplied-not-independently-fetched");
    assert.equal(result.unresolvedMessages, plan.unresolvedMessages - 3);
    const db = openReadonlyDatabase({ databasePath: result.reconciledDatabasePath });
    try {
      const after = allRows(db);
      for (const [table, rows] of Object.entries(beforeRows)) if (!["outbox_events", "security_audit_events", "application_metadata"].includes(table)) assert.deepEqual(after[table], rows, table);
      const ids = new Set(deliveries.map(item => item.eventId));
      for (const row of beforeRows.outbox_events.map(JSON.parse)) assert.deepEqual(db.prepare("SELECT * FROM outbox_events WHERE id=?").get(row.id), !ids.has(row.id) ? row : {
        ...row, status: "discarded", payload_json: CLEARED_PAYLOAD_JSON, last_error_code: "RECOVERY_DELIVERY_RECONCILED", updated_at_ms: now, version: row.version + 1 });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY).n, 1);
      assert.deepEqual(readRecoveryEpoch(db), prepared.recoveryEpoch);
      const audit = db.prepare("SELECT * FROM security_audit_events WHERE id=?").get(options.reconciliationId);
      assert.equal(audit.event_type, "recovery.email_reconciled"); assert.equal(audit.actor_user_id, options.reviewedByUserId);
      assert.equal(audit.reason_code, `delivery_${result.decisionChecksum}`);
      assertCredentialAccess(db, false);
      const parentDb = openReadonlyDatabase({ databasePath: reviewPath });
      try {
        const planInput = { preparedDatabase: parentDb, reconciledDatabase: db, credentialPreparation: prepared,
          originalPlan: plan, emailReconciliation: result, observedAtMs: now + 1 };
        const bytesBefore = db.serialize();
        const next = buildEmailReconciledRecoveryPlan(planInput);
        assert.equal(next.planVersion, 3); assert.equal(next.previousPlanChecksum, plan.planChecksum);
        assert.equal(next.emailReconciliationChecksum, result.reportChecksum);
        assert.equal(next.credentialPreparedPlaintextSha256, prepared.preparedPlaintextSha256);
        assert.equal(next.preparedPlaintextSha256, result.reconciledPlaintextSha256);
        assert.equal(next.unresolvedMessages, plan.unresolvedMessages - 3);
        assert.deepEqual(next.jobs, plan.jobs); assert.deepEqual(next.tableSnapshots, result.tableSnapshots);
        assert.equal(next.activationReady, false); assert.equal(next.executable, false);
        for (const delivery of deliveries) {
          const entry = next.outbox.find(row => row.id === delivery.eventId);
          assert.equal(entry.status, "discarded"); assert.equal(entry.disposition, "preserve-recorded-result");
          assert.equal(entry.deliveryPermitted, false); assert.notEqual(entry.rowSha256, delivery.rowSha256);
        }
        const { planChecksum, ...body } = next; assert.equal(hash(canonicalize(body)), planChecksum);
        assert.equal(JSON.stringify(next).includes(PRIVATE_VALUE), false);
        assert.throws(() => buildEmailReconciledRecoveryPlan({ ...planInput, observedAtMs: now - 1 }), { code: "RECOVERY_RECONCILED_INPUT_INVALID" });
        assert.throws(() => buildEmailReconciledRecoveryPlan({ ...planInput, originalPlan: { ...plan, unresolvedMessages: 0 } }), { code: "RECOVERY_RECONCILED_PARENT_INVALID" });
        assert.throws(() => buildEmailReconciledRecoveryPlan({ ...planInput, emailReconciliation: { ...result, reportChecksum: "e".repeat(64) } }), { code: "RECOVERY_RECONCILED_RECEIPT_INVALID" });
        assert.throws(() => buildEmailReconciledRecoveryPlan({ ...planInput, reconciledDatabase: parentDb }), { code: "RECOVERY_RECONCILED_INPUT_INVALID" });
        assert.deepEqual(db.serialize(), bytesBefore);
      } finally { parentDb.close(); }
    } finally { db.close(); }
    assert.equal(JSON.stringify(result).includes(PRIVATE_VALUE), false);
    await suppressionTest.test("operator command reviews actual candidates and receipts without exposing private state or changing source", () => {
      const directory = path.join(input.temporaryRoot, "operator-review");
      fs.mkdirSync(directory);
      const write = (name, value) => {
        const file = path.join(directory, name);
        fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" });
        return file;
      };
      const preservedPath = path.join(directory, "preserved.sqlite3");
      fs.copyFileSync(input.restoredCandidate.targetDatabasePath, preservedPath, fs.constants.COPYFILE_EXCL);
      const request = { requestVersion: 1, expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,
        expectedDatabaseId: FIXTURE_DATABASE_ID, observedAtMs: now + 1,
        preparedDatabasePath: reviewPath, credentialPreparationPath: write("credentials.json", prepared),
        lossWindow: { restoredDatabasePath: input.restoredCandidate.targetDatabasePath,
          preservedDatabasePath: preservedPath, preservedPlaintextSha256: readHash(preservedPath) } };
      const files = [reviewPath, preservedPath, result.reconciledDatabasePath, input.restoredCandidate.targetDatabasePath];
      const before = files.map(readHash);
      const invoke = value => spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/db-recovery-review.js"),
        "--request", write(`${crypto.randomUUID()}.json`, value)], { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      const initial = invoke(request);
      assert.equal(initial.status, 0, initial.stderr); assert.equal(initial.stderr, "");
      const initialReport = JSON.parse(initial.stdout);
      assert.equal(initialReport.plan.planVersion, 2);
      assert.equal(initialReport.lossWindow.changedRecords, 0);
      assert.equal(initialReport.lossWindow.completeLossWindowEvidence, false);
      assert.equal(initialReport.lossWindow.financialState, undefined);
      assert.equal(initialReport.lossWindow.jobEvidence, undefined);
      assert.equal(initialReport.plan.unresolvedMessages, plan.unresolvedMessages);
      request.emailReview = { originalPlanPath: write("original-plan.json", plan),
        emailReconciliationPath: write("email.json", result), reconciledDatabasePath: result.reconciledDatabasePath };
      request.lossWindow.includeFinancialState = true;
      request.lossWindow.includeJobEvidence = true;
      const reviewed = invoke(request);
      assert.equal(reviewed.status, 0, reviewed.stderr); assert.equal(reviewed.stderr, "");
      const report = JSON.parse(reviewed.stdout);
      assert.equal(report.plan.planVersion, 3); assert.equal(report.plan.unresolvedMessages, plan.unresolvedMessages - 3);
      assert.equal(report.plan.previousPlanChecksum, plan.planChecksum);
      assert.equal(report.activationReady, false); assert.equal(report.executable, false);
      assert.equal(report.providerEvidenceFetched, false);
      assert.equal(report.lossWindow.financialState.changedLeagues, 0);
      assert.equal(report.lossWindow.financialState.leagues.length, 2);
      assert.equal(report.lossWindow.financialState.completeReconciliation, false);
      assert.equal(report.lossWindow.financialState.capCalculationPerformed, false);
      assert.equal(report.lossWindow.jobEvidence.changedOccurrences, 0);
      assert.ok(report.lossWindow.jobEvidence.occurrences.length > 0);
      assert.equal(report.lossWindow.jobEvidence.replayPermitted, false);
      const { reportChecksum, ...body } = report; assert.equal(hash(canonicalize(body)), reportChecksum);
      assert.equal(reviewed.stdout.includes(PRIVATE_VALUE), false);
      assert.equal(reviewed.stdout.includes(directory.replace(/\\/g, "\\\\")), false);
      for (const invalid of [{ ...request, expectedDatabaseId: "wrong-database-identity" },
        { ...request, emailReview: { ...request.emailReview, emailReconciliationPath: write("forged-email.json", { ...result, reportChecksum: "e".repeat(64) }) } },
        { ...request, lossWindow: { ...request.lossWindow, preservedPlaintextSha256: "e".repeat(64) } },
        { ...request, lossWindow: { ...request.lossWindow, includeFinancialState: "true" } },
        { ...request, lossWindow: { ...request.lossWindow, includeJobEvidence: "true" } }]) {
        const failure = invoke(invalid); assert.equal(failure.status, 1); assert.equal(failure.stdout, "");
        assert.equal(JSON.parse(failure.stderr).error.message, "Recovery review failed safely. No activation was performed.");
        assert.equal(failure.stderr.includes(PRIVATE_VALUE), false);
      }
      assert.deepEqual(files.map(readHash), before);
      assert.deepEqual(started.runtime.database.serialize(), sourceBefore);
    });
    const { reconciledDatabasePath, inspection, reportChecksum, ...receipt } = result;
    assert.equal(hash(canonicalize(receipt)), reportChecksum);
    const backup = await createEncryptedOffsiteBackup({ databasePath: reconciledDatabasePath, config, objectStorage,
      reason: "pre-cutover-rehearsal", requestedByType: "release_qa_automation", requestedById: "m7-local-release-rehearsal",
      backendBuildId: "recovery-email-local", retentionClass: "incident-preservation" });
    const restored = await restoreEncryptedBackupToCleanPath({ manifestObjectKey: backup.manifestObjectKey, objectStorage,
      keyResolver: async () => encryptionKey, expectedEnvironment: config.appEnv, expectedEnvironmentId: config.environmentId,
      expectedDatabaseId: config.databaseId, temporaryRoot: input.temporaryRoot, targetDatabasePath: path.join(input.temporaryRoot, "email-roundtrip.sqlite3") });
    const restoredDb = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
    const candidateDb = openReadonlyDatabase({ databasePath: reconciledDatabasePath });
    try { assert.deepEqual(allRows(restoredDb), allRows(candidateDb)); } finally { restoredDb.close(); candidateDb.close(); }
  });
  await t.test("rejects a self-consistent replacement receipt that conceals an unrelated league change", () => {
    const alteredPath = path.join(input.temporaryRoot, "email-altered-review.sqlite3");
    fs.copyFileSync(result.reconciledDatabasePath, alteredPath, fs.constants.COPYFILE_EXCL);
    const writer = openDatabase({ databasePath: alteredPath, environment: "staging", persistentRoot: input.temporaryRoot, requirePersistentRoot: true }).database;
    let tableSnapshots;
    try {
      writer.prepare("UPDATE teams SET version=version+1 WHERE id=(SELECT id FROM teams ORDER BY id LIMIT 1)").run();
      tableSnapshots = Object.fromEntries(Object.entries(allRows(writer)).map(([name, rows]) =>
        [name, { count: rows.length, sha256: hash(canonicalize(rows.map(row => hash(row)).sort())) }]));
    } finally { writer.close(); }
    const spoofed = { ...result, reconciledPlaintextSha256: readHash(alteredPath), tableSnapshots };
    for (const field of ["reconciledDatabasePath", "inspection", "reportChecksum"]) delete spoofed[field];
    const emailReconciliation = { ...spoofed, reportChecksum: hash(canonicalize(spoofed)) };
    const parentDb = openReadonlyDatabase({ databasePath: reviewPath });
    const alteredDb = openReadonlyDatabase({ databasePath: alteredPath });
    try {
      const beforeBytes = alteredDb.serialize();
      assert.throws(() => buildEmailReconciledRecoveryPlan({ preparedDatabase: parentDb, reconciledDatabase: alteredDb,
        credentialPreparation: prepared, originalPlan: plan, emailReconciliation, observedAtMs: now + 1 }),
      { code: "RECOVERY_RECONCILED_DELTA_INVALID" });
      assert.deepEqual(alteredDb.serialize(), beforeBytes);
    } finally { parentDb.close(); alteredDb.close(); }
  });
  await t.test("rejects stale plans, mismatched evidence, duplicate decisions and non-administrators", () => {
    const mismatched = (changes) => [{ ...deliveries[0], ...changes }, ...deliveries.slice(1)];
    for (const [index, overrides, code] of [
      [0, { plan: { ...plan, planChecksum: "e".repeat(64) } }, "RECOVERY_EMAIL_PLAN_INVALID"],
      [1, { deliveries: mismatched({ rowSha256: "e".repeat(64) }) }, "RECOVERY_EMAIL_DELIVERY_MISMATCH"],
      [2, { deliveries: mismatched({ payloadSha256: "e".repeat(64) }) }, "RECOVERY_EMAIL_DELIVERY_MISMATCH"],
      [3, { deliveries: mismatched({ deliveredAtMs: 9 }) }, "RECOVERY_EMAIL_DELIVERY_MISMATCH"],
      [4, { deliveries: [deliveries[0], deliveries[0]] }, "RECOVERY_EMAIL_INPUT_INVALID"],
      [5, { deliveries: mismatched({ providerMessageSha256: deliveries[1].providerMessageSha256 }) }, "RECOVERY_EMAIL_INPUT_INVALID"],
      [6, { reviewedByUserId: fixtureId("account:leagueACommissioner") }, "RECOVERY_EMAIL_REVIEWER_INVALID"],
      [7, { deliveries: mismatched({ deliveredAtMs: now + 1 }) }, "RECOVERY_EMAIL_INPUT_INVALID"],
      [8, { deliveries: mismatched({ eventId: plan.outbox.find(row => row.leagueId !== null).id }) }, "RECOVERY_EMAIL_DELIVERY_MISMATCH"],
      [9, { deliveries: mismatched({ eventId: fixtureId("recovery-preparation:outbox:published") }) }, "RECOVERY_EMAIL_DELIVERY_MISMATCH"],
    ]) {
      const outputDirectory = path.join(input.temporaryRoot, `email-rejected-${index}`);
      assert.throws(() => prepareRecoveryEmailReconciliation({ ...options, ...overrides, outputDirectory }), { code });
      assert.equal(fs.existsSync(outputDirectory), false);
    }
  });
  await t.test("rolls back every row before cleanup after interruption or an unexpected write", () => {
    for (const tamper of [false, true]) {
      let rollbackObserved = false;
      const outputDirectory = path.join(input.temporaryRoot, `email-rollback-${tamper}`);
      assert.throws(() => prepareRecoveryEmailReconciliation({ ...options, outputDirectory, beforeCommit(db) {
        const close = db.close.bind(db);
        db.close = () => { assert.equal(db.inTransaction, false); assert.deepEqual(allRows(db), beforeRows); rollbackObserved = true; return close(); };
        if (tamper) db.prepare("UPDATE teams SET version=version+1 WHERE id=(SELECT id FROM teams ORDER BY id LIMIT 1)").run();
        else throw new Error("simulated interruption");
      } }), { code: tamper ? "RECOVERY_EMAIL_POSTCHECK_FAILED" : "RECOVERY_EMAIL_FAILED" });
      assert.equal(rollbackObserved, true); assert.equal(fs.existsSync(outputDirectory), false);
    }
  });
  await t.test("preserves colliding output and active-source sidecars without reusing a receipt", () => {
    const outputDirectory = path.join(input.temporaryRoot, "email-collision"); fs.mkdirSync(outputDirectory);
    const marker = path.join(outputDirectory, "owned-by-other-attempt.txt"); fs.writeFileSync(marker, "preserve", { flag: "wx" });
    assert.throws(() => prepareRecoveryEmailReconciliation({ ...options, outputDirectory }), { code: "RECOVERY_EMAIL_PATH_UNSAFE" });
    assert.equal(fs.readFileSync(marker, "utf8"), "preserve");
    const wal = `${prepared.preparedDatabasePath}-wal`; fs.writeFileSync(wal, "active-writer", { flag: "wx" });
    try {
      assert.throws(() => prepareRecoveryEmailReconciliation({ ...options, outputDirectory: path.join(input.temporaryRoot, "email-wal-rejected") }), { code: "RECOVERY_EMAIL_SOURCE_CHANGED" });
      assert.equal(fs.readFileSync(wal, "utf8"), "active-writer");
    } finally { fs.unlinkSync(wal); }
  });
  assert.equal(readHash(prepared.preparedDatabasePath), sourceHash);
  assert.deepEqual(started.runtime.database.serialize(), sourceBefore);
});

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
    assert.equal(report.staleAccountLinksDiscarded, 7);
    assert.equal(report.reportVersion, 5);
    assert.deepEqual(report.previousRecoveryEpoch, { generation: 0, recoveryId: null });
    assert.deepEqual(report.recoveryEpoch, { generation: 1, recoveryId: input.recoveryId });
    assert.deepEqual(readRecoveryEpoch(database), report.recoveryEpoch);
    assert.equal(report.restoredJobLeasesInvalidated, 2);
    assert.equal(report.jobOccurrences, "preserved-and-held");
    assert.equal(report.otherOutboxRecords, "unchanged-and-held");
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
      if (!["sessions", "account_action_tokens", "security_audit_events", "application_metadata", "outbox_events", "job_runs"].includes(table)) {
        assert.deepEqual(preparedRows[table], rows, table);
      }
    }
    const staleIds = new Set(Array.from({ length: 7 }, (_, index) => fixtureId(`recovery-preparation:outbox:${index}`)));
    const originalOutbox = sourceRows.outbox_events.map(JSON.parse);
    for (const row of originalOutbox) {
      const expected = !staleIds.has(row.id) ? row : { ...row, status: "discarded", payload_json: CLEARED_PAYLOAD_JSON,
        last_error_code: "RECOVERY_STALE_ACCOUNT_LINK", updated_at_ms: 100, version: row.version + 1 };
      assert.deepEqual(database.prepare("SELECT * FROM outbox_events WHERE id=?").get(row.id), expected);
    }
    const staleOriginal = originalOutbox.filter(row => staleIds.has(row.id)).sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(report.staleAccountLinkEvidenceSha256, hash(canonicalize(staleOriginal)));
    const originalJobs = sourceRows.job_runs.map(JSON.parse);
    for (const row of originalJobs) {
      const expected = !["leased", "running"].includes(row.status) ? row : {
        ...row, lease_owner: null, lease_token: null, lease_expires_at_ms: 100, updated_at_ms: 100, version: row.version + 1,
      };
      assert.deepEqual(database.prepare("SELECT * FROM job_runs WHERE id=?").get(row.id), expected);
    }
    assert.equal(report.restoredJobLeaseEvidenceSha256,
      hash(canonicalize(originalJobs.filter(row => ["leased", "running"].includes(row.status)).sort((a, b) => a.id.localeCompare(b.id)))));
    assert.deepEqual(preparedRows.application_metadata.filter((row) => ![RECOVERY_HOLD_KEY, RECOVERY_EPOCH_KEY].includes(JSON.parse(row).metadata_key)), sourceRows.application_metadata);
    const hold = database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY);
    assert.equal(JSON.parse(hold.metadata_value).recoveryId, input.recoveryId);
    assert.equal(JSON.parse(hold.metadata_value).sourcePlaintextSha256, originalHash);
    assert.deepEqual(JSON.parse(hold.metadata_value).recoveryEpoch, report.recoveryEpoch);
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

  await t.test("a read-only reconciliation plan binds every held job and message without permitting replay", () => {
    const reader = openReadonlyDatabase({ databasePath: report.preparedDatabasePath });
    try {
      const options = { database: reader, credentialPreparation: report, observedAtMs: 100,
        expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID, expectedDatabaseId: FIXTURE_DATABASE_ID };
      const plan = buildRecoveryReconciliationPlan(options);
      assert.deepEqual(buildRecoveryReconciliationPlan(options), plan);
      assert.equal(plan.activationReady, false);
      assert.equal(plan.executable, false);
      assert.equal(plan.planVersion, 2);
      assert.deepEqual(plan.recoveryEpoch, report.recoveryEpoch);
      assert.equal(plan.preparedPlaintextSha256, report.preparedPlaintextSha256);
      assert.equal(Object.keys(plan.tableSnapshots).length, Object.keys(preparedRows).length);
      assert.equal(plan.unresolvedJobs, 4);
      assert.equal(plan.jobs.every(row => row.executionPermitted === false), true);
      assert.equal(plan.outbox.every(row => row.deliveryPermitted === false), true);
      assert.equal(plan.jobs.find(row => row.status === "leased").leaseExpired, true);
      assert.equal(plan.jobs.find(row => row.status === "running").leaseExpired, true, "preparation explicitly invalidated even a missing restored expiry");
      assert.equal(plan.jobs.find(row => row.status === "pending").leaseExpired, null, "pending work has no lease expiry evidence");
      for (const status of ["succeeded", "skipped"]) {
        assert.equal(plan.jobs.find(row => row.status === status).disposition, "preserve-recorded-result");
      }
      assert.equal(plan.outbox.find(row => row.id === fixtureId("recovery-preparation:outbox:security")).disposition, "held-awaiting-delivery-evidence");
      assert.equal(plan.outbox.filter(row => row.status === "discarded").every(row => row.disposition === "preserve-recorded-result"), true);
      for (const record of plan.outbox) {
        assert.equal(record.rowSha256, hash(canonicalize(reader.prepare("SELECT * FROM outbox_events WHERE id=?").get(record.id))));
      }
      const { planChecksum, ...body } = plan;
      assert.equal(planChecksum, hash(canonicalize(body)));
      assert.equal(JSON.stringify(plan).includes(PRIVATE_VALUE), false);
      assert.equal(JSON.stringify(plan).includes("payload_json"), false);
      assert.equal(reader.prepare("SELECT total_changes() AS count").get().count, 0);
      assert.throws(() => buildRecoveryReconciliationPlan({ ...options, credentialPreparation: { ...report, reportChecksum: "e".repeat(64) } }),
        { code: "RECOVERY_PLAN_RECEIPT_INVALID" });
      const { preparedDatabasePath, inspection, reportChecksum, ...wrongFileReceipt } = report;
      wrongFileReceipt.preparedPlaintextSha256 = "f".repeat(64);
      assert.throws(() => buildRecoveryReconciliationPlan({ ...options,
        credentialPreparation: { ...wrongFileReceipt, reportChecksum: hash(canonicalize(wrongFileReceipt)) } }),
      { code: "RECOVERY_PLAN_SOURCE_CHANGED" });
      assert.throws(() => buildRecoveryReconciliationPlan({ ...options, expectedDatabaseId: "different-database" }), { code: "RECOVERY_PLAN_FAILED" });
      assert.throws(() => buildRecoveryReconciliationPlan({ ...options, database: started.runtime.database }), { code: "RECOVERY_PLAN_INPUT_INVALID" });
      assert.deepEqual(allRows(reader), preparedRows);
    } finally { reader.close(); }
    assert.equal(readHash(report.preparedDatabasePath), report.preparedPlaintextSha256);
  });

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
  await t.test("an unexpected change to a held security notification rejects the entire candidate", () => {
    const output = path.join(input.temporaryRoot, "unexpected-outbox-write");
    assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory: output, beforeCommit(database) {
      database.prepare("UPDATE outbox_events SET version=version+1 WHERE id=?").run(fixtureId("recovery-preparation:outbox:security"));
    } }), { code: "RECOVERY_PREPARATION_POSTCHECK_FAILED" });
    assert.equal(fs.existsSync(output), false);
  });
  await t.test("a changed job lease or terminal result rejects and rolls back the entire candidate", () => {
    for (const status of ["running", "succeeded"]) {
      const output = path.join(input.temporaryRoot, `unexpected-job-${status}`);
      let rollbackObserved = false;
      assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory: output, beforeCommit(database) {
        database.prepare("UPDATE job_runs SET lease_token=? WHERE id=?").run("unexpected-worker", fixtureId(`recovery-preparation:job:${status}`));
        const close = database.close.bind(database);
        database.close = () => {
          assert.equal(database.inTransaction, false);
          assert.deepEqual(allRows(database), sourceRows);
          rollbackObserved = true;
          return close();
        };
      } }), { code: "RECOVERY_PREPARATION_POSTCHECK_FAILED" });
      assert.equal(rollbackObserved, true);
      assert.equal(fs.existsSync(output), false);
    }
  });
  assert.equal(readHash(input.restoredCandidate.targetDatabasePath), originalHash);
  assert.deepEqual(started.runtime.database.serialize(), sourceBefore);
});

test("the recovery preparation command creates a held derivative and preserves sources and rejected outputs", async t => {
  const { started,input } = await candidate(t);
  const sourceBefore = started.runtime.database.serialize(), restoredHash = readHash(input.restoredCandidate.targetDatabasePath);
  const directory = path.join(input.temporaryRoot,"preparation-command"); fs.mkdirSync(directory);
  const write = (name,value) => { const file = path.join(directory,name); fs.writeFileSync(file,JSON.stringify(value),{ flag: "wx" }); return file; };
  const { restoredCandidate,...requestInput } = input;
  const request = { requestVersion: 1,...requestInput,restoredVerificationPath: write("restored.json",restoredCandidate),
    outputDirectory: path.join(input.temporaryRoot,"command-prepared") };
  const invoke = value => spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-prepare.js"),
    "--request",write(crypto.randomUUID()+".json",value)],{ encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
  const prepared = invoke(request); assert.equal(prepared.status,0,prepared.stderr); assert.equal(prepared.stderr,"");
  const report = JSON.parse(prepared.stdout);
  assert.equal(report.status,"credentials-prepared"); assert.equal(report.sourceBackupId,restoredCandidate.backupId);
  assert.equal(report.recoveryId,input.recoveryId); assert.equal(report.sourcePlaintextSha256,restoredHash);
  assert.equal(report.activationReady,false); assert.equal(report.normalRuntime,"blocked-by-durable-recovery-hold");
  assert.equal(report.sessionsRevoked,1); assert.equal(report.actionTokensInvalidated,4); assert.equal(report.staleAccountLinksDiscarded,7);
  assert.equal(prepared.stdout.includes(PRIVATE_VALUE),false);
  const receiptPath = path.join(request.outputDirectory,"credential-preparation.json");
  const stored = JSON.parse(fs.readFileSync(receiptPath,"utf8")), { preparedDatabasePath,inspection,...receipt } = report;
  assert.deepEqual(receipt,stored); assert.equal(readHash(preparedDatabasePath),report.preparedPlaintextSha256);
  const { reportChecksum,...body } = receipt; assert.equal(hash(canonicalize(body)),reportChecksum);
  const database = openReadonlyDatabase({ databasePath: preparedDatabasePath });
  try {
    assertCredentialAccess(database,false);
    const plan = buildRecoveryReconciliationPlan({ database,credentialPreparation: report,observedAtMs: 100,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,expectedDatabaseId: FIXTURE_DATABASE_ID });
    assert.equal(plan.activationReady,false); assert.equal(plan.executable,false);
    assert.ok(plan.unresolvedJobs > 0); assert.ok(plan.unresolvedMessages > 0);
    assert.throws(() => createTargetRuntime({ database,migrationsDirectory: path.resolve(__dirname,"../../database/migrations") }),
      { code: "DATABASE_RECOVERY_HELD" });
    assert.equal(database.prepare("SELECT total_changes() n").get().n,0);
  } finally { database.close(); }
  const collision = path.join(input.temporaryRoot,"command-collision"); fs.mkdirSync(collision);
  const marker = path.join(collision,"preserve.txt"); fs.writeFileSync(marker,"preserve",{ flag: "wx" });
  const safeBefore = [readHash(preparedDatabasePath),readHash(receiptPath)];
  for (const value of [request,{ ...request,outputDirectory: collision },
    { ...request,outputDirectory: path.join(input.temporaryRoot,"command-wrong-identity"),expectedDatabaseId: "wrong-database-id" },
    { ...request,outputDirectory: path.join(input.temporaryRoot,"command-no-approval"),approve: true },
    { ...request,outputDirectory: "relative-output" }]) {
    const rejected = invoke(value); assert.equal(rejected.status,1); assert.equal(rejected.stdout,"");
    assert.equal(JSON.parse(rejected.stderr).error.message,"Recovery preparation failed safely. No activation was performed.");
    assert.equal(rejected.stderr.includes(PRIVATE_VALUE),false);
    assert.equal(rejected.stderr.includes(directory.replace(/\\/g,"\\\\")),false);
  }
  assert.equal(fs.readFileSync(marker,"utf8"),"preserve");
  assert.equal(fs.existsSync(path.join(input.temporaryRoot,"command-wrong-identity")),false);
  assert.equal(fs.existsSync(path.join(input.temporaryRoot,"command-no-approval")),false);
  assert.deepEqual([readHash(preparedDatabasePath),readHash(receiptPath)],safeBefore);
  assert.equal(readHash(restoredCandidate.targetDatabasePath),restoredHash);
  assert.deepEqual(started.runtime.database.serialize(),sourceBefore);
});

test("an account link bound to a different recipient rejects recovery preparation without changing its verified source", async (t) => {
  const { started, input } = await candidate(t, database => {
    database.prepare("UPDATE outbox_events SET payload_json=json_set(payload_json,'$.recipientUserId',?) WHERE id=?")
      .run(fixtureId("account:leagueBManagerOne"), fixtureId("recovery-preparation:outbox:0"));
  });
  const sourceBefore = started.runtime.database.serialize();
  const originalHash = readHash(input.restoredCandidate.targetDatabasePath);
  const outputDirectory = path.join(input.temporaryRoot, "ambiguous-link");
  assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory }), { code: "RECOVERY_ACCOUNT_LINK_INVALID" });
  assert.equal(fs.existsSync(outputDirectory), false);
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
  // Prepare before read-only inspection creates SQLite WAL sidecars. The
  // original preparation guard must continue to reject those sidecars.
  const prepared = prepareRecoveryCredentials({ ...input, restoredCandidate: restored,
    outputDirectory: path.join(input.temporaryRoot, "loss-window-prepared") });
  const mutationsStoppedAtMs = Date.now();
  const preserved = await createVerifiedBackup({ databasePath: started.databasePath,
    outputDirectory: path.join(input.temporaryRoot, "preserved-loss-window"), environment: config.appEnv,
    reason: "incident-preservation", capturedAtMs: mutationsStoppedAtMs, temporaryRoot: input.temporaryRoot });
  const restoredDatabase = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
  const preservedDatabase = openReadonlyDatabase({ databasePath: path.join(preserved.outputDirectory, BACKUP_FILE_NAME) });
  try {
    const comparison = compareRecoveryLossWindow({ restoredDatabase, preservedDatabase,
      restoredPlaintextSha256: restored.plaintextSha256, preservedPlaintextSha256: preserved.plaintextSha256,
      sourceBackupId: backup.backupId, expectedEnvironmentId: config.environmentId, expectedDatabaseId: config.databaseId,
      observedAtMs: Date.now(), includeFinancialState: true });
    assert.equal(Object.keys(comparison.tables).length, Object.keys(atBackup).length);
    const financial = comparison.financialState;
    assert.equal(financial.unit, "integer-cents");
    assert.equal(financial.changedLeagues, 1);
    assert.equal(financial.capCalculationPerformed, false);
    assert.equal(financial.completeReconciliation, false);
    const otherLeague = financial.leagues.find(row => row.leagueId === fixtureId("league:leagueA"));
    assert.deepEqual(otherLeague.restored, otherLeague.preserved);
    assert.equal(otherLeague.recordedTotalsChanged, false);
    const changedLeague = financial.leagues.find(row => row.leagueId === fixtureId("league:leagueB"));
    assert.equal(changedLeague.recordedTotalsChanged, true);
    const activeBefore = changedLeague.restored.contracts.find(row => row.status === "active");
    const activeAfter = changedLeague.preserved.contracts.find(row => row.status === "active");
    assert.equal(activeAfter.count, activeBefore.count - 1);
    assert.equal(activeAfter.originalTotalValueCents, activeBefore.originalTotalValueCents - contractAtBackup.original_total_value_cents);
    assert.equal(activeAfter.aavCents, activeBefore.aavCents - contractAtBackup.aav_cents);
    assert.deepEqual(changedLeague.restored.retentionObligations, changedLeague.preserved.retentionObligations);
    const penalties = state => state.seasons.flatMap(season => season.buyoutYears)
      .reduce((sum, row) => sum + row.penaltyCents, 0);
    assert.equal(penalties(changedLeague.preserved) - penalties(changedLeague.restored),
      boughtOut.buyout.annualPenaltyCents * boughtOut.buyout.remainingYears);
    const { reportChecksum, ...comparisonBody } = comparison;
    assert.equal(hash(canonicalize(comparisonBody)), reportChecksum);
    const keyHash = id => hash(canonicalize([id]));
    const changedContract = comparison.tables.contracts.changes.find(row => row.keySha256 === keyHash(contractId));
    assert.equal(changedContract.kind, "changed-after-backup");
    assert.ok(changedContract.changedColumns.includes("status"));
    assert.equal(changedContract.restoredRowSha256, hash(canonicalize(contractAtBackup)));
    assert.equal(changedContract.preservedRowSha256, hash(canonicalize(source.prepare("SELECT * FROM contracts WHERE id=?").get(contractId))));
    assert.equal(comparison.tables.buyout_obligations.changes.find(row => row.keySha256 === keyHash(boughtOut.buyout.id)).kind, "absent-from-backup");
    assert.equal(comparison.tables.sessions.changes.find(row => row.keySha256 === keyHash(issued.session.id)).kind, "absent-from-backup");
    assert.equal(comparison.tables.job_runs.changes.length, 0);
    assert.equal(comparison.tables.contracts.changes.length, 1);
    assert.equal(comparison.activationReady, false);
    assert.equal(comparison.executable, false);
    assert.equal(comparison.completeLossWindowEvidence, false);
    assert.equal(JSON.stringify(comparison).includes(PRIVATE_VALUE), false);
    assert.equal(JSON.stringify(comparison).includes(issued.rawSessionToken), false);
    await t.test("restore planning binds actual manifests, financial loss and administrator review without execution", async () => {
      const { buildRecoveryRestorePlan } = require("../../src/operations/backups/buildRecoveryRestorePlan");
      const backupManifestBytes = (await objectStorage.getPrivateObject({ objectKey: backup.manifestObjectKey })).body;
      const preservationManifestPath = path.join(preserved.outputDirectory, "backup-manifest.json");
      const preservationManifestBytes = fs.readFileSync(preservationManifestPath);
      const options = { restoredDatabase, preservedDatabase, restoredVerification: restored, backupManifestBytes,
        expectedBackupManifestSha256: hash(backupManifestBytes), preservationManifestBytes,
        expectedPreservationManifestSha256: hash(preservationManifestBytes), targetEnvironment: config.appEnv,
        expectedEnvironmentId: config.environmentId, expectedDatabaseId: config.databaseId, incidentId: crypto.randomUUID(),
        requestedByUserId: fixtureId("account:platformAdmin"), requestedScope: "whole-database", mutationsStoppedAtMs,
        plannedAtMs: Date.now(), currentBackendBuildId: "m7-current-backend", selectedBackendBuildId: "m7-candidate-backend",
        frontendBuildId: "m7-current-frontend", migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
        maintenancePlanSha256: hash("fixture maintenance plan"), communicationPlanSha256: hash("fixture communication plan") };
      const before = [restoredDatabase,preservedDatabase].map(database => database.serialize());
      const plan = buildRecoveryRestorePlan(options);
      assert.equal(plan.restorePlanVersion, 1); assert.equal(plan.status, "awaiting-platform-approval");
      assert.equal(plan.approval.status, "required"); assert.equal(plan.approval.approvedByUserId, null);
      assert.equal(plan.approval.strongReauthentication, "required-at-execution");
      assert.equal(plan.activationReady, false); assert.equal(plan.executable, false);
      assert.equal(plan.providerEvidenceFetched, false); assert.equal(plan.buildCompatibility.applicationBehaviorVerified, false);
      assert.equal(plan.selectedBackup.backupId, backup.backupId);
      assert.equal(plan.rollbackArtifact.plaintextSha256, preserved.plaintextSha256);
      assert.equal(plan.rollbackArtifact.manifestChecksum, preserved.manifestChecksum);
      assert.equal(plan.expectedDataLossWindow.endsAtMs, mutationsStoppedAtMs);
      assert.equal(plan.expectedDataLossWindow.startsAtMs, Date.parse(JSON.parse(backupManifestBytes).completedAt));
      assert.deepEqual(plan.buildCompatibility.requiredMigrations, []);
      assert.equal(plan.comparison.financialState.changedLeagues, 1);
      assert.deepEqual(plan.comparison.financialState, financial);
      assert.deepEqual(plan.affectedLeagueIds, [fixtureId("league:leagueA"),fixtureId("league:leagueB")].sort());
      assert.equal(plan.current.rowCounts.buyout_obligations, plan.candidate.rowCounts.buyout_obligations + 1);
      const { planChecksum, ...body } = plan; assert.equal(hash(canonicalize(body)), planChecksum);
      assert.equal(JSON.stringify(plan).includes(PRIVATE_VALUE), false);
      assert.equal(JSON.stringify(plan).includes(issued.rawSessionToken), false);
      for (const [change, code] of [
        [{ requestedByUserId: fixtureId("account:leagueBManagerOne") }, "RECOVERY_RESTORE_PLAN_REQUESTER_INVALID"],
        [{ requestedScope: "league" }, "RECOVERY_RESTORE_PLAN_INPUT_INVALID"],
        [{ expectedBackupManifestSha256: "0".repeat(64) }, "RECOVERY_RESTORE_PLAN_MANIFEST_INVALID"],
        [{ expectedPreservationManifestSha256: "0".repeat(64) }, "RECOVERY_RESTORE_PLAN_MANIFEST_INVALID"],
        [{ plannedAtMs: mutationsStoppedAtMs - 1 }, "RECOVERY_RESTORE_PLAN_INPUT_INVALID"],
        [{ mutationsStoppedAtMs: plan.expectedDataLossWindow.startsAtMs - 1 }, "RECOVERY_RESTORE_PLAN_TIME_INVALID"],
        [{ restoredDatabase: preservedDatabase }, "RECOVERY_RESTORE_PLAN_FAILED"],
      ]) assert.throws(() => buildRecoveryRestorePlan({ ...options, ...change }), { code });
      const pendingDirectory = path.join(input.temporaryRoot, "unapproved-migrations");
      fs.mkdirSync(pendingDirectory);
      for (const entry of fs.readdirSync(options.migrationsDirectory)) fs.copyFileSync(
        path.join(options.migrationsDirectory, entry), path.join(pendingDirectory, entry), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(pendingDirectory, "0057_unapproved_recovery.sql"), "SELECT 1;\n", { flag: "wx" });
      assert.throws(() => buildRecoveryRestorePlan({ ...options, migrationsDirectory: pendingDirectory }),
        { code: "RECOVERY_RESTORE_PLAN_FAILED" });
      const commandDirectory = path.join(input.temporaryRoot, "restore-plan-command"); fs.mkdirSync(commandDirectory);
      const write = (name, value) => { const file = path.join(commandDirectory, name); fs.writeFileSync(file, value, { flag: "wx" }); return file; };
      const { restoredDatabase: ignoredRestored, preservedDatabase: ignoredPreserved, restoredVerification,
        backupManifestBytes: ignoredBackup, preservationManifestBytes: ignoredPreservation, migrationsDirectory, ...requestInput } = options;
      const request = { requestVersion: 1, ...requestInput, restoredDatabasePath: restoredDatabase.name,
        preservedDatabasePath: preservedDatabase.name, restoredVerificationPath: write("restored.json", JSON.stringify(restoredVerification)),
        backupManifestPath: write("backup-manifest.json", backupManifestBytes), preservationManifestPath };
      const invoke = value => spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/db-restore-plan.js"),
        "--request", write(crypto.randomUUID() + ".json", JSON.stringify(value))],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      const result = invoke(request); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), plan);
      for (const value of [{ ...request, requestedScope: "league" }, { ...request, approve: true },
        { ...request, expectedBackupManifestSha256: "0".repeat(64) }]) {
        const rejected = invoke(value); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, "");
        assert.equal(JSON.parse(rejected.stderr).error.message, "Restore planning failed safely. No execution was performed.");
      }
      for (const [index,database] of [restoredDatabase,preservedDatabase].entries()) assert.deepEqual(database.serialize(), before[index]);
      assert.deepEqual(source.serialize(), sourceAfterKnownChanges);
    });
    for (const connection of [restoredDatabase, preservedDatabase]) {
      assert.equal(connection.prepare("SELECT total_changes() AS count").get().count, 0);
    }
  } finally { restoredDatabase.close(); preservedDatabase.close(); }
  const database = openReadonlyDatabase({ databasePath: prepared.preparedDatabasePath });
  try {
    assert.deepEqual(database.prepare("SELECT * FROM contracts WHERE id=?").get(contractId), contractAtBackup);
    assert.equal(database.prepare("SELECT * FROM buyout_obligations WHERE id=?").get(boughtOut.buyout.id), undefined);
    assert.equal(database.prepare("SELECT * FROM sessions WHERE id=?").get(issued.session.id), undefined);
    assert.equal(database.prepare("SELECT COALESCE(SUM(penalty_cents),0) AS total FROM buyout_years").get().total, penaltyTotalAtBackup);
    const recovered = allRows(database);
    for (const [table, rows] of Object.entries(atBackup)) {
      if (!["sessions", "account_action_tokens", "security_audit_events", "application_metadata", "outbox_events", "job_runs"].includes(table)) {
        assert.deepEqual(recovered[table], rows, table);
      }
    }
    assert.deepEqual(recovered.outbox_events.filter(row => JSON.parse(row).league_id !== null),
      atBackup.outbox_events.filter(row => JSON.parse(row).league_id !== null));
    assert.equal(prepared.staleAccountLinksDiscarded, 7);
    assertCredentialAccess(database, false);
    assert.equal(prepared.activationReady, false);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
  assert.deepEqual(source.serialize(), sourceAfterKnownChanges);
  assert.equal(source.prepare("SELECT status FROM contracts WHERE id=?").get(contractId).status, "eliminated");
});

test("a real statistics worker cannot use its restored lease after recovery preparation", async t => {
  let lease;
  const { started, input } = await candidate(t, database => {
    const repository = createSqliteStatisticsScheduleRepository({ database });
    lease = repository.claim({ occurrenceKey: "20260912:0", scheduledForMs: 30, nowMs: 50, owner: "synthetic-previous-worker" });
    repository.assertLease(lease, 75);
  });
  const sourceBefore = started.runtime.database.serialize();
  const report = prepareRecoveryCredentials({ ...input, outputDirectory: path.join(input.temporaryRoot, "lease-preparation") });
  assert.equal(report.restoredJobLeasesInvalidated, 3);
  const connection = openDatabase({ databasePath: report.preparedDatabasePath, environment: "test" });
  const database = connection.database;
  try {
    const before = database.serialize();
    const repository = createSqliteStatisticsScheduleRepository({ database });
    assert.throws(() => repository.assertLease(lease, 110), { code: "NHL_STATISTICS_LEASE_LOST" });
    assert.throws(() => repository.complete({ lease, nowMs: 110, result: { refreshed: true } }), { code: "NHL_STATISTICS_LEASE_LOST" });
    assert.deepEqual(database.serialize(), before);
    assert.equal(database.prepare("SELECT total_changes() AS n").get().n, 0);
    const row = database.prepare("SELECT * FROM job_runs WHERE id=?").get(lease.id);
    assert.equal(row.status, "running");
    assert.equal(row.version, lease.version + 1);
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_expires_at_ms, 100);
    assert.throws(() => createTargetRuntime({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations") }),
      { code: "DATABASE_RECOVERY_HELD" });
  } finally { database.close(); }
  assert.deepEqual(started.runtime.database.serialize(), sourceBefore);
});

test("an expired restored completed-game occurrence replays once through the real worker and remains complete after restart", async t => {
  const { createNhlCompletedGameAdapter, PROVIDER_NAME, PLAYER_IDENTITY_PROVIDER } = require("../../src/infrastructure/nhl/NhlCompletedGameAdapter");
  const { createLiveStatisticsService } = require("../../src/application/services/statistics/createLiveStatisticsService");
  const { createSqliteStatisticsRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");
  const { createRunCompletedGameStatisticsJob, latestEveningOccurrence } = require("../../src/jobs/definitions/runCompletedGameStatistics");
  // A separate synthetic NHL season keeps the existing two-league schedule and
  // historical player-game requirements intact. This is a worker rehearsal,
  // not an operator disposition or permission to release the durable hold.
  const nhlSeasonKey = "20272028", now = Date.parse("2027-10-12T01:20:00Z");
  const scheduledForMs = latestEveningOccurrence(now);
  let oldLease, catalog;
  const { started, input } = await candidate(t, database => {
    catalog = database.prepare("SELECT id FROM players ORDER BY id").all().map((row,index) => ({
      playerId: row.id, providerPlayerId: String(8478000 + index),
    }));
    const insert = database.prepare("INSERT INTO player_external_ids(id,player_id,provider,external_value,created_at_ms) VALUES(?,?,'nhl',?,?)");
    for (const player of catalog) insert.run(fixtureId("recovery-nhl-identity:" + player.playerId), player.playerId, player.providerPlayerId, now - 60_000);
    oldLease = createSqliteStatisticsScheduleRepository({ database }).claim({ occurrenceKey: `${nhlSeasonKey}:${scheduledForMs}`,
      scheduledForMs, nowMs: scheduledForMs + 60_000, owner: "synthetic-pre-restore-worker" });
  });
  const originalSource = started.runtime.database.serialize(), originalCandidateHash = readHash(input.restoredCandidate.targetDatabasePath);
  const prepared = prepareRecoveryCredentials({ ...input, preparedAtMs: now,
    outputDirectory: path.join(input.temporaryRoot, "statistics-worker-rehearsal") });
  const preparedHash = readHash(prepared.preparedDatabasePath);
  const workPath = path.join(input.temporaryRoot, "statistics-worker-work.sqlite3");
  fs.copyFileSync(prepared.preparedDatabasePath, workPath, fs.constants.COPYFILE_EXCL);
  const requests = [];
  const game = { id: 2027020001, season: 20272028, gameType: 2, easternStartTime: "2027-10-10T17:00:00",
    homeTeamId: 13, visitingTeamId: 16, gameStateId: 7 };
  const skaters = Array.from({ length: 36 }, (_,index) => ({ playerId: 8478000 + index, gameId: game.id,
    homeRoad: index < 18 ? "H" : "R", gamesPlayed: 1, goals: index === 0 ? 2 : 0,
    assists: index === 0 ? 1 : 0, points: index === 0 ? 3 : 0 }));
  const open = () => openDatabase({ databasePath: workPath, environment: "test" }).database;
  const worker = database => {
    const statisticsRepository = createSqliteStatisticsRepository({ database });
    const provider = createNhlCompletedGameAdapter({ nowMs: () => now, readCatalogPlayers: () => statisticsRepository.readNhlCatalogPlayers(),
      retryDelay: async () => {}, fetchImpl: async uri => {
        const url = new URL(uri); requests.push(url.href); assert.equal(url.origin, "https://api.nhle.com");
        assert.equal(url.searchParams.get("start"), "0");
        const games = url.pathname === "/stats/rest/en/game";
        assert.ok(games || url.pathname === "/stats/rest/en/skater/summary");
        assert.equal(url.searchParams.get("cayenneExp"), games ? "season=20272028 and gameType=2" : "gameId in (2027020001)");
        const data = games ? [game] : skaters;
        return { ok: true, json: async () => ({ total: data.length, data: structuredClone(data) }) };
      } });
    return createRunCompletedGameStatisticsJob({ repository: createSqliteStatisticsScheduleRepository({ database }),
      statisticsService: createLiveStatisticsService({ repository: statisticsRepository, provider, nhlSeasonKey,
        providerName: PROVIDER_NAME, playerIdentityProvider: PLAYER_IDENTITY_PROVIDER,
        minimumPlayerCount: catalog.length, nowMs: () => now }), nhlSeasonKey, clock: { nowMs: () => now }, logger: { error() {} } });
  };
  let database = open();
  try {
    const before = allRows(database), hold = database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY);
    const result = await worker(database).run(); assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(requests.length, 2);
    const job = database.prepare("SELECT * FROM job_runs WHERE id=?").get(oldLease.id);
    assert.equal(job.status, "succeeded"); assert.equal(job.attempt_count, 2); assert.equal(job.version, oldLease.version + 3);
    assert.equal(job.occurrence_key, oldLease.occurrence_key); assert.equal(job.scheduled_for_ms, oldLease.scheduled_for_ms);
    assert.equal(JSON.parse(job.result_json).refreshId, result.refreshId);
    const total = database.prepare("SELECT * FROM player_stat_totals WHERE refresh_id=? AND player_id=?").get(result.refreshId, catalog[0].playerId);
    assert.equal(total.games_played, 1); assert.equal(total.goals, 2); assert.equal(total.assists, 1);
    assert.equal(total.fantasy_points_hundredths, 350);
    const after = allRows(database), changed = new Set(["job_runs", "stat_sources", "stat_refreshes", "player_stat_totals",
      "player_game_stat_observations", "stat_refresh_player_game_sets", "stat_refresh_player_game_coverage_entries"]);
    for (const [table,rows] of Object.entries(before)) if (!changed.has(table)) assert.deepEqual(after[table], rows, table);
    assert.deepEqual(after.job_runs.filter(row => JSON.parse(row).id !== oldLease.id), before.job_runs.filter(row => JSON.parse(row).id !== oldLease.id));
    const bytes = database.serialize(), repository = createSqliteStatisticsScheduleRepository({ database });
    assert.throws(() => repository.assertLease(oldLease, now), { code: "NHL_STATISTICS_LEASE_LOST" });
    assert.throws(() => repository.complete({ lease: oldLease, nowMs: now, result: { stale: true } }), { code: "NHL_STATISTICS_LEASE_LOST" });
    assert.deepEqual(database.serialize(), bytes);
    assert.deepEqual(database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY), hold);
    assert.throws(() => createTargetRuntime({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations") }),
      { code: "DATABASE_RECOVERY_HELD" });
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    database.close(); database = open();
    const restarted = database.serialize(); assert.equal((await worker(database).run()).status, "skipped");
    assert.equal(requests.length, 2); assert.deepEqual(database.serialize(), restarted);
    assert.equal(database.prepare("SELECT total_changes() n").get().n, 0);
  } finally { if (database.open) database.close(); }
  assert.equal(readHash(prepared.preparedDatabasePath), preparedHash);
  assert.equal(readHash(input.restoredCandidate.targetDatabasePath), originalCandidateHash);
  assert.deepEqual(started.runtime.database.serialize(), originalSource);
});

test("reviewed statistics recovery executes only its exact occurrence in a new held copy", async t => {
  const { createRunCompletedGameStatisticsJob, latestEveningOccurrence } = require("../../src/jobs/definitions/runCompletedGameStatistics");
  const nhlSeasonKey = "20272028", now = Date.parse("2027-10-12T01:20:00Z"), scheduledForMs = latestEveningOccurrence(now);
  let oldLease,catalog;
  const { started,input } = await candidate(t,database => {
    catalog = database.prepare("SELECT id FROM players ORDER BY id").all().map((row,index) => ({ playerId: row.id,providerPlayerId: String(8478000+index) }));
    const insert = database.prepare("INSERT INTO player_external_ids(id,player_id,provider,external_value,created_at_ms) VALUES(?,?,'nhl',?,?)");
    for (const player of catalog) insert.run(fixtureId("reviewed-recovery-nhl:"+player.playerId),player.playerId,player.providerPlayerId,now-60_000);
    oldLease = createSqliteStatisticsScheduleRepository({ database }).claim({ occurrenceKey: `${nhlSeasonKey}:${scheduledForMs}`,
      scheduledForMs,nowMs: scheduledForMs+60_000,owner: "synthetic-old-worker" });
  });
  const sourceBytes = started.runtime.database.serialize(),restoredHash = readHash(input.restoredCandidate.targetDatabasePath);
  const prepared = prepareRecoveryCredentials({ ...input,preparedAtMs: now,outputDirectory: path.join(input.temporaryRoot,"statistics-operation-input") });
  const preparedHash = readHash(prepared.preparedDatabasePath);
  const reviewPath = path.join(input.temporaryRoot,"statistics-operation-review.sqlite3");
  fs.copyFileSync(prepared.preparedDatabasePath,reviewPath,fs.constants.COPYFILE_EXCL);
  const reader = openReadonlyDatabase({ databasePath: reviewPath });
  let plan,row,before;
  try {
    plan = buildRecoveryReconciliationPlan({ database: reader,credentialPreparation: prepared,observedAtMs: now,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,expectedDatabaseId: FIXTURE_DATABASE_ID });
    row = reader.prepare("SELECT * FROM job_runs WHERE id=?").get(oldLease.id); before = allRows(reader);
  } finally { reader.close(); }
  const requests = [];
  const game = { id: 2027020001,season: 20272028,gameType: 2,easternStartTime: "2027-10-10T17:00:00",homeTeamId: 13,visitingTeamId: 16,gameStateId: 7 };
  const skaters = Array.from({ length: 36 },(_,index) => ({ playerId: 8478000+index,gameId: game.id,homeRoad: index<18?"H":"R",
    gamesPlayed: 1,goals: index===0?2:0,assists: index===0?1:0,points: index===0?3:0 }));
  const fetchImpl = async uri => {
    const url = new URL(uri); requests.push(url.href); assert.equal(url.origin,"https://api.nhle.com");
    const games = url.pathname === "/stats/rest/en/game";
    assert.ok(games || url.pathname === "/stats/rest/en/skater/summary");
    const data = games?[game]:skaters;
    return { ok: true,json: async () => ({ total: data.length,data: structuredClone(data) }) };
  };
  const review = { jobId: row.id,rowSha256: hash(canonicalize(row)),occurrenceKeySha256: hash(canonicalize([row.league_id,row.job_type,row.occurrence_key])),
    nhlSeasonKey,reviewedByUserId: fixtureId("account:platformAdmin"),reconciliationId: crypto.randomUUID(),
    reasonCode: "VERIFIED_STATISTICS_REFETCH",evidenceSha256: hash("synthetic reviewed recovery evidence") };
  const options = { credentialPreparation: prepared,plan,review,executedAtMs: now,temporaryRoot: input.temporaryRoot,
    minimumPlayerCount: catalog.length,fetchImpl };
  const outputDirectory = path.join(input.temporaryRoot,"statistics-operation-output");
  const report = await prepareRecoveryStatisticsReconciliation({ ...options,outputDirectory });
  assert.equal(requests.length,2); assert.equal(report.status,"statistics-reconciled-held");
  assert.equal(report.activationReady,false); assert.equal(report.completedJobId,row.id);
  assert.equal(report.unresolvedJobs,plan.unresolvedJobs-1); assert.equal(report.unresolvedMessages,plan.unresolvedMessages);
  assert.equal(report.protectedTableCount,125); assert.equal(report.otherJobs,"unchanged-and-held");
  assert.equal(report.messages,"unchanged-and-held"); assert.equal(report.sourcePlaintextSha256,preparedHash);
  assert.equal(report.reviewEvidence,"operator-supplied-not-current-authentication");
  assert.equal(report.providerEvidence,"fetched-through-nhl-completed-game-adapter");
  assert.ok(report.completedAtMs >= now); assert.equal(JSON.stringify(report).includes(PRIVATE_VALUE),false);
  const receiptPath = path.join(outputDirectory,"statistics-reconciliation.json");
  const { reconciledDatabasePath,inspection,...receipt } = report;
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath,"utf8")),receipt);
  const { reportChecksum,...body } = receipt; assert.equal(hash(canonicalize(body)),reportChecksum);
  assert.equal(readHash(reconciledDatabasePath),report.reconciledPlaintextSha256);
  const workPath = path.join(input.temporaryRoot,"statistics-operation-restart.sqlite3");
  fs.copyFileSync(reconciledDatabasePath,workPath,fs.constants.COPYFILE_EXCL);
  const database = openDatabase({ databasePath: workPath,environment: "test" }).database;
  try {
    const after = allRows(database),changed = new Set(["job_runs","stat_sources","stat_refreshes","player_stat_totals","player_game_stat_observations",
      "stat_refresh_player_game_sets","stat_refresh_player_game_coverage_entries","application_metadata","security_audit_events"]);
    for (const [table,rows] of Object.entries(before)) if (!changed.has(table)) assert.deepEqual(after[table],rows,table);
    assert.deepEqual(after.job_runs.filter(value => JSON.parse(value).id!==row.id),before.job_runs.filter(value => JSON.parse(value).id!==row.id));
    const completed = database.prepare("SELECT * FROM job_runs WHERE id=?").get(row.id);
    assert.equal(completed.status,"succeeded"); assert.equal(completed.attempt_count,row.attempt_count+1);
    assert.equal(hash(canonicalize(completed)),report.completedJobRowSha256);
    assert.equal(database.prepare("SELECT fantasy_points_hundredths n FROM player_stat_totals WHERE refresh_id=? AND player_id=?").get(report.result.refreshId,catalog[0].playerId).n,350);
    const audit = database.prepare("SELECT * FROM security_audit_events WHERE id=?").get(review.reconciliationId);
    assert.equal(audit.actor_user_id,review.reviewedByUserId); assert.equal(audit.event_type,"recovery.statistics_reconciled");
    assertCredentialAccess(database,false);
    const bytes = database.serialize(),repository = createSqliteStatisticsScheduleRepository({ database });
    assert.throws(() => repository.complete({ lease: oldLease,nowMs: now,result: {} }),{ code: "NHL_STATISTICS_LEASE_LOST" });
    const restarted = createRunCompletedGameStatisticsJob({ repository,nhlSeasonKey,clock: { nowMs: () => now },
      statisticsService: { async refresh() { assert.fail("A completed recovered occurrence must not fetch or persist again"); } },logger: { error() {} } });
    assert.equal((await restarted.run()).status,"skipped"); assert.deepEqual(database.serialize(),bytes);
    assert.throws(() => createTargetRuntime({ database,migrationsDirectory: path.resolve(__dirname,"../../database/migrations") }),{ code: "DATABASE_RECOVERY_HELD" });
    assert.deepEqual(database.pragma("foreign_key_check"),[]);
  } finally { database.close(); }
  const outputHashes = [readHash(reconciledDatabasePath),readHash(receiptPath)];
  for (const [suffix,patch] of [
    ["repeat",{ outputDirectory }],
    ["wrong-row",{ review: { ...review,rowSha256: "f".repeat(64) } }],
    ["wrong-occurrence",{ review: { ...review,occurrenceKeySha256: "f".repeat(64) } }],
    ["wrong-reviewer",{ review: { ...review,reviewedByUserId: fixtureId("recovery-preparation:user") } }],
    ["wrong-season",{ review: { ...review,nhlSeasonKey: "20262027" } }],
    ["extra-approval",{ review: { ...review,approve: true } }],
    ["wrong-plan",{ plan: { ...plan,unresolvedJobs: 0 } }],
  ]) {
    const target = path.join(input.temporaryRoot,"statistics-operation-"+suffix);
    await assert.rejects(() => prepareRecoveryStatisticsReconciliation({ ...options,outputDirectory: target,...patch }),
      error => /^RECOVERY_STATISTICS_/.test(error.code) && !error.message.includes(PRIVATE_VALUE));
    if (suffix!=="repeat") assert.equal(fs.existsSync(target),false);
  }
  assert.equal(requests.length,2);
  const tampered = path.join(input.temporaryRoot,"statistics-operation-unrelated-write");
  await assert.rejects(() => prepareRecoveryStatisticsReconciliation({ ...options,outputDirectory: tampered,
    beforeReceipt: db => db.prepare("UPDATE leagues SET name='invalid recovery write' WHERE id=?").run(fixtureId("league:leagueA")) }),
    { code: "RECOVERY_STATISTICS_POSTCHECK_FAILED" });
  assert.equal(requests.length,4); assert.equal(fs.existsSync(tampered),false);
  const changedStatistics = path.join(input.temporaryRoot,"statistics-operation-changed-statistics");
  await assert.rejects(() => prepareRecoveryStatisticsReconciliation({ ...options,outputDirectory: changedStatistics,
    beforeReceipt: db => db.prepare("UPDATE player_stat_totals SET fantasy_points_hundredths=fantasy_points_hundredths+50 WHERE nhl_season_key=?").run(nhlSeasonKey) }),
    error => ["RECOVERY_STATISTICS_POSTCHECK_FAILED","RECOVERY_STATISTICS_FAILED"].includes(error.code));
  assert.equal(requests.length,6); assert.equal(fs.existsSync(changedStatistics),false);
  const unavailable = path.join(input.temporaryRoot,"statistics-operation-provider-unavailable");
  await assert.rejects(() => prepareRecoveryStatisticsReconciliation({ ...options,outputDirectory: unavailable,
    fetchImpl: async () => ({ ok: false,status: 400 }) }),{ code: "RECOVERY_STATISTICS_FAILED" });
  assert.equal(fs.existsSync(unavailable),false);
  // Run the real operator entrypoint. Only the external HTTP transport is
  // preloaded with captured synthetic responses; production accepts no hook.
  const commandRoot = path.join(input.temporaryRoot,"statistics-command"); fs.mkdirSync(commandRoot);
  const write = (name,value) => { const file = path.join(commandRoot,name); fs.writeFileSync(file,JSON.stringify(value),{ flag: "wx" }); return file; };
  const credentialPreparationPath = path.join(path.dirname(prepared.preparedDatabasePath),"credential-preparation.json");
  const reviewRequestPath = write("review-request.json",{ requestVersion: 1,expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,
    expectedDatabaseId: FIXTURE_DATABASE_ID,observedAtMs: now,preparedDatabasePath: reviewPath,credentialPreparationPath });
  const reviewed = require("../../scripts/db-recovery-review").runRecoveryReviewCommand({ argv: ["--request",reviewRequestPath],output: { log() {} } });
  assert.deepEqual(reviewed.plan,plan);
  const preload = path.join(commandRoot,"captured-http.cjs");
  write("responses.json",{ game,skaters });
  fs.writeFileSync(preload,'const assert=require("node:assert/strict"),data=require("./responses.json"); globalThis.fetch=async uri=>{const url=new URL(uri); assert.equal(url.origin,"https://api.nhle.com"); const games=url.pathname==="/stats/rest/en/game"; assert(games||url.pathname==="/stats/rest/en/skater/summary"); const rows=games?[data.game]:data.skaters; return {ok:true,json:async()=>({total:rows.length,data:rows})};};\n',{ flag: "wx" });
  const commandRequest = { requestVersion: 1,credentialPreparationPath,preparedDatabasePath: prepared.preparedDatabasePath,
    candidateReviewPath: write("candidate-review.json",reviewed),decisionPath: write("decision.json",review),
    executedAtMs: now,temporaryRoot: input.temporaryRoot,outputDirectory: path.join(input.temporaryRoot,"statistics-command-output"),minimumPlayerCount: catalog.length };
  const invoke = request => spawnSync(process.execPath,["--require",preload,path.resolve(__dirname,"../../scripts/db-recovery-statistics.js"),
    "--request",write(crypto.randomUUID()+".json",request)],{ encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
  const command = invoke(commandRequest); assert.equal(command.status,0,command.stderr); assert.equal(command.stderr,"");
  const commandReport = JSON.parse(command.stdout); assert.equal(commandReport.status,"statistics-reconciled-held");
  assert.equal(commandReport.completedJobId,row.id); assert.equal(commandReport.minimumPlayerCount,catalog.length);
  assert.equal(commandReport.activationReady,false); assert.equal(commandReport.normalRuntime,"blocked-by-durable-recovery-hold");
  assert.equal(command.stdout.includes(PRIVATE_VALUE),false);
  const commandHash = readHash(commandReport.reconciledDatabasePath);
  assert.equal(commandHash,commandReport.reconciledPlaintextSha256);
  const alteredReview = write("altered-review.json",{ ...reviewed,plan: { ...reviewed.plan,unresolvedJobs: 0 } });
  for (const request of [commandRequest,{ ...commandRequest,outputDirectory: path.join(input.temporaryRoot,"statistics-command-approval"),approve: true },
    { ...commandRequest,outputDirectory: path.join(input.temporaryRoot,"statistics-command-altered-review"),candidateReviewPath: alteredReview }]) {
    const rejected = invoke(request); assert.equal(rejected.status,1); assert.equal(rejected.stdout,"");
    assert.equal(JSON.parse(rejected.stderr).error.message,"Statistics recovery failed safely. No activation was performed.");
    assert.equal(rejected.stderr.includes(PRIVATE_VALUE),false);
  }
  assert.equal(fs.existsSync(path.join(input.temporaryRoot,"statistics-command-approval")),false);
  assert.equal(fs.existsSync(path.join(input.temporaryRoot,"statistics-command-altered-review")),false);
  assert.equal(readHash(commandReport.reconciledDatabasePath),commandHash);
  assert.deepEqual([readHash(reconciledDatabasePath),readHash(receiptPath)],outputHashes);
  assert.equal(readHash(prepared.preparedDatabasePath),preparedHash); assert.equal(readHash(input.restoredCandidate.targetDatabasePath),restoredHash);
  assert.deepEqual(started.runtime.database.serialize(),sourceBytes);
});

test("recovery review detects a real statistics occurrence completed after its selected encrypted backup", async t => {
  let lease;
  const { started, input, backup } = await candidate(t, database => {
    lease = createSqliteStatisticsScheduleRepository({ database }).claim({
      occurrenceKey: "20262027:30", scheduledForMs: 30, nowMs: 50, owner: "synthetic-backup-worker" });
  });
  const source = started.runtime.database, beforeCompletion = allRows(source);
  const result = { refreshId: crypto.randomUUID(), privateProviderReceipt: PRIVATE_VALUE };
  createSqliteStatisticsScheduleRepository({ database: source }).complete({ lease, nowMs: 80, result });
  const afterCompletion = allRows(source), sourceBytes = source.serialize();
  for (const [table,rows] of Object.entries(beforeCompletion)) if (table !== "job_runs") assert.deepEqual(afterCompletion[table],rows,table);
  assert.deepEqual(afterCompletion.job_runs.filter(row => JSON.parse(row).id !== lease.id), beforeCompletion.job_runs.filter(row => JSON.parse(row).id !== lease.id));
  const prepared = prepareRecoveryCredentials({ ...input, outputDirectory: path.join(input.temporaryRoot,"completed-job-prepared") });
  const preserved = await createVerifiedBackup({ databasePath: started.databasePath,
    outputDirectory: path.join(input.temporaryRoot,"completed-job-preserved"), environment: "test",
    reason: "incident-preservation", capturedAtMs: 100, temporaryRoot: input.temporaryRoot });
  const restoredDatabase = openReadonlyDatabase({ databasePath: input.restoredCandidate.targetDatabasePath });
  const preservedDatabase = openReadonlyDatabase({ databasePath: path.join(preserved.outputDirectory,BACKUP_FILE_NAME) });
  try {
    const options = { restoredDatabase,preservedDatabase,restoredPlaintextSha256: input.restoredCandidate.plaintextSha256,
      preservedPlaintextSha256: preserved.plaintextSha256, sourceBackupId: backup.backupId,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID, expectedDatabaseId: FIXTURE_DATABASE_ID, observedAtMs: 100 };
    const ordinary = compareRecoveryLossWindow(options); assert.equal(ordinary.jobEvidence,undefined);
    const reviewed = compareRecoveryLossWindow({ ...options,includeJobEvidence: true });
    assert.deepEqual(reviewed.tables,ordinary.tables); assert.equal(reviewed.jobEvidence.changedOccurrences,1);
    assert.equal(reviewed.jobEvidence.recordedCompletionsAfterBackup,1);
    const row = reviewed.jobEvidence.occurrences.find(row => row.jobId === lease.id);
    assert.equal(row.restored.status,"running"); assert.equal(row.preserved.status,"succeeded");
    assert.equal(row.preserved.resultSha256,hash(JSON.stringify(result))); assert.equal(row.replayPermitted,false);
    assert.equal(row.externalOutcomeVerified,false); assert.equal(row.domainOutcomeVerified,false);
    const { reportChecksum,...body } = reviewed; assert.equal(hash(canonicalize(body)),reportChecksum);
    assert.equal(JSON.stringify(reviewed).includes(PRIVATE_VALUE),false);
    const directory = path.join(input.temporaryRoot,"completed-job-command"); fs.mkdirSync(directory);
    const credentials = path.join(directory,"credentials.json"), requestPath = path.join(directory,"request.json");
    fs.writeFileSync(credentials,JSON.stringify(prepared),{ flag: "wx" });
    fs.writeFileSync(requestPath,JSON.stringify({ requestVersion: 1, expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,
      expectedDatabaseId: FIXTURE_DATABASE_ID, observedAtMs: 100, preparedDatabasePath: prepared.preparedDatabasePath,
      credentialPreparationPath: credentials, lossWindow: { restoredDatabasePath: restoredDatabase.name,
        preservedDatabasePath: preservedDatabase.name, preservedPlaintextSha256: preserved.plaintextSha256,includeJobEvidence: true } }),{ flag: "wx" });
    const command = spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-review.js"),"--request",requestPath],
      { encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
    assert.equal(command.status,0,command.stderr); assert.equal(command.stderr,"");
    assert.deepEqual(JSON.parse(command.stdout).lossWindow,reviewed); assert.equal(command.stdout.includes(PRIVATE_VALUE),false);
    for (const database of [restoredDatabase,preservedDatabase]) assert.equal(database.prepare("SELECT total_changes() n").get().n,0);
  } finally { restoredDatabase.close(); preservedDatabase.close(); }
  assert.deepEqual(source.serialize(),sourceBytes);
});

test("a later recovery advances the prior epoch atomically without deleting idempotency history", async t => {
  const previous = { generation: 7, recoveryId: crypto.randomUUID() };
  const { started, input } = await candidate(t, database => database.prepare(
    "INSERT INTO application_metadata (metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(?,?,10,20)"
  ).run(RECOVERY_EPOCH_KEY, canonicalize(previous)));
  const sourceBefore = started.runtime.database.serialize();
  const history = allRows(started.runtime.database).idempotency_requests;
  const report = prepareRecoveryCredentials({ ...input, outputDirectory: path.join(input.temporaryRoot, "later-epoch") });
  const reader = openReadonlyDatabase({ databasePath: report.preparedDatabasePath });
  try {
    assert.deepEqual(report.previousRecoveryEpoch, previous);
    assert.deepEqual(report.recoveryEpoch, { generation: 8, recoveryId: input.recoveryId });
    assert.deepEqual(readRecoveryEpoch(reader), report.recoveryEpoch);
    const row = reader.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_EPOCH_KEY);
    assert.equal(row.created_at_ms, 10); assert.equal(row.updated_at_ms, 100);
    assert.deepEqual(allRows(reader).idempotency_requests, history);
    const plan = buildRecoveryReconciliationPlan({ database: reader, credentialPreparation: report, observedAtMs: 100,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID, expectedDatabaseId: FIXTURE_DATABASE_ID });
    assert.deepEqual(plan.recoveryEpoch, report.recoveryEpoch);
    assert.equal(plan.executable, false);
  } finally { reader.close(); }
  assert.deepEqual(started.runtime.database.serialize(), sourceBefore);
  const output = path.join(input.temporaryRoot, "tampered-epoch");
  let rollbackObserved = false;
  assert.throws(() => prepareRecoveryCredentials({ ...input, outputDirectory: output, beforeCommit(database) {
    database.prepare("UPDATE application_metadata SET metadata_value=? WHERE metadata_key=?").run(canonicalize(previous), RECOVERY_EPOCH_KEY);
    const close = database.close.bind(database);
    database.close = () => {
      assert.deepEqual(readRecoveryEpoch(database), previous);
      assert.deepEqual(allRows(database).idempotency_requests, history);
      rollbackObserved = true; return close();
    };
  } }), { code: "RECOVERY_PREPARATION_POSTCHECK_FAILED" });
  assert.equal(rollbackObserved, true); assert.equal(fs.existsSync(output), false);
});
