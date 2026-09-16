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
const { prepareRecoveryInvalidationReconciliation } = require("../../src/operations/backups/prepareRecoveryInvalidationReconciliation");
const { buildInvalidationReconciledRecoveryPlan } = require("../../src/operations/backups/buildInvalidationReconciledRecoveryPlan");
const { buildEmailReconciledRecoveryPlan } = require("../../src/operations/backups/buildEmailReconciledRecoveryPlan");
const { buildStatisticsReconciledRecoveryPlan } = require("../../src/operations/backups/buildStatisticsReconciledRecoveryPlan");
const { buildRecoveryPlanFromLineage,readVerifiedRecoveryParent } = require("../../src/operations/backups/buildRecoveryReconciliationLineage");
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

test("completion review binds actual held financial state and keeps every unproved recovery gate open", async t => {
  const { buildRecoveryCompletionReview } = require("../../src/operations/backups/buildRecoveryCompletionReview");
  const { started, input } = await candidate(t, database => {
    database.prepare("UPDATE league_settings SET salary_cap_cents=1 WHERE league_id=?").run(fixtureId("league:leagueA"));
  });
  const sourceBytes = started.runtime.database.serialize();
  const prepared = prepareRecoveryCredentials({ ...input, outputDirectory: path.join(input.temporaryRoot, "completion-input") });
  const restoredPath = input.restoredCandidate.targetDatabasePath;
  const preservedPath = path.join(input.temporaryRoot, "completion-preserved.sqlite3");
  fs.copyFileSync(restoredPath, preservedPath, fs.constants.COPYFILE_EXCL);
  const files = [prepared.preparedDatabasePath, restoredPath, preservedPath], hashes = files.map(readHash);
  const readers = files.map(databasePath => openReadonlyDatabase({ databasePath }));
  const save = (name, value) => { const file = path.join(input.temporaryRoot, name); fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" }); return file; };
  const command = (name, request, success = true) => {
    const requestPath = save(crypto.randomUUID()+".json", request);
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/"+name), "--request", requestPath],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 16*1024*1024 });
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    assert.equal((result.stdout+result.stderr).includes(PRIVATE_VALUE), false);
    if (success) { assert.equal(result.stderr, ""); return JSON.parse(result.stdout); }
    assert.equal(result.stdout, ""); assert.match(JSON.parse(result.stderr).error.code, /^RECOVERY_/);
  };
  try {
    const plan = buildRecoveryReconciliationPlan({ database: readers[0], credentialPreparation: prepared,
      observedAtMs: 101, expectedEnvironmentId: input.expectedEnvironmentId, expectedDatabaseId: input.expectedDatabaseId });
    const options = { candidateDatabase: readers[0], restoredDatabase: readers[1], preservedDatabase: readers[2],
      credentialPreparation: prepared, plan, preservedPlaintextSha256: hashes[2],
      expectedEnvironmentId: input.expectedEnvironmentId, expectedDatabaseId: input.expectedDatabaseId, observedAtMs: 102 };
    const report = buildRecoveryCompletionReview(options);
    assert.equal(report.status, "recovery-completion-reviewed-held");
    assert.equal(report.lossWindow.changedRecords, 0);
    assert.equal(report.recordedLossProgress.totalChangedRecords,0);
    assert.deepEqual(report.recordedLossProgress.counts,{matchesPreserved:0,stillAtBackupState:0,differentFromBoth:0});
    assert.deepEqual(report.recordedLossProgress.tables,{});
    assert.equal(report.recordedLossProgress.candidateOnlyChangedRecords,report.candidateChanges.changedRecords);
    assert.equal(report.recordedLossProgress.completeLossWindowEvidence,false);
    assert.equal(report.lossWindow.financialState.changedLeagues, 0);
    assert.equal(report.candidateChanges.financialState.changedLeagues, 0);
    assert.ok(report.candidateChanges.changedRecords > 0);
    assert.equal(report.currentCaps.leagues.length, 2);
    assert.equal(report.currentCaps.unconfiguredLeagues, 0);
    assert.ok(report.currentCaps.leagues.every(league => league.teams.length > 0));
    const reduced = report.currentCaps.leagues.find(league => league.leagueId === fixtureId("league:leagueA"));
    assert.ok(reduced.teams.some(team => team.overCap));
    assert.ok(reduced.teams.every(team => team.capLimitCents === 1));
    assert.ok(report.currentCaps.leagues.find(league => league.leagueId === fixtureId("league:leagueB")).teams.every(team => team.capLimitCents > 1));
    for (const [name, digest] of [["candidate",hashes[0]],["restored",hashes[1]],["preserved",hashes[2]]]) {
      const financial = report.financialConsistency[name];
      assert.equal(financial.plaintextSha256,digest);
      assert.deepEqual(financial.findings.map(row=>row.code),["BUYOUT_POLICY_AMOUNT_REQUIRES_REVIEW","BUYOUT_POLICY_AMOUNT_REQUIRES_REVIEW"]);
      assert.equal(financial.activationReady,false);assert.equal(financial.completeFinancialReconciliation,false);
      assert.ok(financial.warnings.some(row=>row.code==="TEAM_OVER_CAP"));
    }
    assert.deepEqual(report.financialConsistency.restored.tables,report.financialConsistency.candidate.tables);
    assert.deepEqual(report.financialConsistency.restored.tables,report.financialConsistency.preserved.tables);
    for (const league of report.currentCaps.leagues) for (const team of league.teams) {
      assert.equal(team.capUsageCents, team.breakdown.activePlayerCents+team.breakdown.retentionCents+team.breakdown.buyoutCents);
      assert.equal(team.capSpaceCents, team.capLimitCents-team.capUsageCents);
      assert.equal(team.overCap, team.capUsageCents > team.capLimitCents);
    }
    assert.equal(report.dispositions.unresolvedJobs, plan.unresolvedJobs);
    assert.equal(report.dispositions.unresolvedMessages, plan.unresolvedMessages);
    assert.equal(report.inventory.sessions.active, 0);
    assert.ok(Object.values(report.inventory.activeActionTokens).every(count => count === 0));
    assert.ok(report.gates.every(gate => gate.status === "pending"));
    for (const field of ["completeLossWindowEvidence", "completeFinancialReconciliation", "operatorAuthenticated", "activationReady", "executable"]) assert.equal(report[field], false, field);
    assert.equal(JSON.stringify(report).includes(PRIVATE_VALUE), false);
    for (const file of files) assert.equal(JSON.stringify(report).includes(file), false);
    const { reportChecksum, ...body } = report; assert.equal(reportChecksum, hash(canonicalize(body)));
    assert.deepEqual(buildRecoveryCompletionReview(options), report);
    const { planChecksum, ...forgedBody } = { ...plan, unresolvedJobs: 0, activationReady: true };
    for (const patch of [{ plan: { ...forgedBody, planChecksum: hash(canonicalize(forgedBody)) } },
      { candidateDatabase: readers[1] }, { preservedDatabase: readers[1] }, { preservedPlaintextSha256: "a".repeat(64) },
      { observedAtMs: 100 }, { expectedDatabaseId: "wrong-database" },
      { lineage: { initialDatabasePath: files[0], initialPlan: plan, steps: [] } }]) {
      assert.throws(() => buildRecoveryCompletionReview({ ...options, ...patch }), error => /^RECOVERY_COMPLETION_/.test(error.code));
    }
    readers[0].transaction(() => assert.throws(() => buildRecoveryCompletionReview(options), { code: "RECOVERY_COMPLETION_INPUT_INVALID" }))();
    const credentials = save("completion-credentials.json", prepared);
    const review = command("db-recovery-review.js", { requestVersion: 1, preparedDatabasePath: files[0], credentialPreparationPath: credentials,
      expectedEnvironmentId: input.expectedEnvironmentId, expectedDatabaseId: input.expectedDatabaseId, observedAtMs: 101 });
    const request = { requestVersion: 1, candidateDatabasePath: files[0], restoredDatabasePath: files[1], preservedDatabasePath: files[2],
      credentialPreparationPath: credentials, candidateReviewPath: save("completion-candidate.json", review), preservedPlaintextSha256: hashes[2],
      expectedEnvironmentId: input.expectedEnvironmentId, expectedDatabaseId: input.expectedDatabaseId, observedAtMs: 102 };
    assert.deepEqual(command("db-recovery-completion-review.js", request), report);
    for (const patch of [{ force: true }, { activationReady: true }, { preservedDatabasePath: files[1] }, { preservedPlaintextSha256: "b".repeat(64) }]) {
      command("db-recovery-completion-review.js", { ...request, ...patch }, false);
    }
    const { reportChecksum: discarded, ...badReview } = { ...review, plan: { ...forgedBody, planChecksum: hash(canonicalize(forgedBody)) } };
    const forgedPath = save("completion-forged-plan.json", { ...badReview, reportChecksum: hash(canonicalize(badReview)) });
    command("db-recovery-completion-review.js", { ...request, candidateReviewPath: forgedPath }, false);
    await t.test("credential revocation is not mistaken for reconstruction of a changed session",()=>{
      const alteredPath = path.join(input.temporaryRoot,"completion-preserved-session-change.sqlite3");
      fs.copyFileSync(preservedPath,alteredPath,fs.constants.COPYFILE_EXCL);
      const writer = openDatabase({databasePath:alteredPath,environment:"staging",persistentRoot:input.temporaryRoot,requirePersistentRoot:true}).database;
      let sessionId;
      try {
        sessionId = writer.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY id LIMIT 1").get().id;
        assert.equal(writer.prepare("UPDATE sessions SET version=version+1 WHERE id=?").run(sessionId).changes,1);
      } finally { writer.close(); }
      const digest = readHash(alteredPath),altered = openReadonlyDatabase({databasePath:alteredPath});
      try {
        const reviewed = buildRecoveryCompletionReview({...options,preservedDatabase:altered,preservedPlaintextSha256:digest});
        assert.equal(reviewed.recordedLossProgress.totalChangedRecords,1);
        assert.deepEqual(reviewed.recordedLossProgress.counts,{matchesPreserved:0,stillAtBackupState:0,differentFromBoth:1});
        const row=reviewed.recordedLossProgress.tables.sessions[0];
        assert.equal(row.keySha256,hash(canonicalize([sessionId])));assert.equal(row.credentialBoundaryApplies,true);
        assert.equal(row.status,"differentFromBoth");assert.equal(reviewed.inventory.sessions.active,0);
        assert.equal(reviewed.recordedLossProgress.preservedStateIsApproved,false);
        assert.equal(readHash(alteredPath),digest);assert.equal(altered.prepare("SELECT total_changes() n").get().n,0);
      } finally { altered.close(); }
    });
    for (const reader of readers) assert.equal(reader.prepare("SELECT total_changes() n").get().n, 0);
  } finally { readers.forEach(reader => reader.close()); }
  assert.deepEqual(files.map(readHash), hashes);
  assert.deepEqual(started.runtime.database.serialize(), sourceBytes);
});

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

test("reviewed restored invalidations suppress only exact refresh hints and preserve authoritative records", async t => {
  const now = Date.now()+60_000;
  const fixtures = [];
  const { started,input } = await candidate(t,database => {
    const originals = database.prepare("SELECT * FROM outbox_events WHERE league_id IS NOT NULL AND status='pending' ORDER BY id").all();
    const templates = [...new Map(originals.map(row => [row.league_id,row])).values()];
    assert.equal(templates.length,2);
    for (const [leagueIndex,template] of templates.entries()) {
      for (const kind of ["pending","failed","publishing",...(leagueIndex === 0 ? ["notification","activity","published","future","malformed"] : [])]) {
        const id = fixtureId(`recovery-invalidations:${leagueIndex}:${kind}`);
        const eventType = kind === "notification" ? "notification.created" : kind === "activity" ? "activity.created" : "league.changed";
        const createdAt = kind === "future" ? now+1000 : now-1000;
        const row = { ...template,id,event_type: eventType,status: ["pending","failed","publishing","published"].includes(kind) ? kind : "pending",
          published_at_ms: kind === "published" ? now-500 : null,created_at_ms: createdAt,updated_at_ms: createdAt,available_at_ms: createdAt,
          payload_json: kind === "malformed" ? "{}" : JSON.stringify({ kind: "invalidation",eventType,scope: "league",scopeId: template.league_id,version: 1,changedAtMs: createdAt }) };
        database.prepare("INSERT INTO outbox_events("+Object.keys(row).join(",")+") VALUES("+Object.keys(row).map(key => `@${key}`).join(",")+")").run(row);
        const audiences = database.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(template.id);
        assert.ok(audiences.length > 0);
        for (const [index,audience] of audiences.entries()) {
          const copy = { ...audience,id: fixtureId(`recovery-invalidations:audience:${id}:${index}`),outbox_event_id: id };
          database.prepare("INSERT INTO outbox_event_audiences("+Object.keys(copy).join(",")+") VALUES("+Object.keys(copy).map(key => `@${key}`).join(",")+")").run(copy);
        }
        fixtures.push({ id,kind });
      }
    }
  });
  input.preparedAtMs = now;
  const sourceBefore = started.runtime.database.serialize();
  const prepared = prepareRecoveryCredentials({ ...input,outputDirectory: path.join(input.temporaryRoot,"invalidation-input") });
  const sourceHash = readHash(prepared.preparedDatabasePath);
  const copy = file => { const target = path.join(input.temporaryRoot,crypto.randomUUID()+"-review.sqlite3");fs.copyFileSync(file,target,fs.constants.COPYFILE_EXCL);return target; };
  const reviewPath = copy(prepared.preparedDatabasePath),reader = openReadonlyDatabase({ databasePath: reviewPath });
  let plan,beforeRows,decisions;
  try {
    plan = buildRecoveryReconciliationPlan({ database: reader,credentialPreparation: prepared,observedAtMs: now,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,expectedDatabaseId: FIXTURE_DATABASE_ID });
    beforeRows = allRows(reader);
    decisions = fixtures.map(({ id,kind }) => {
      const row = reader.prepare("SELECT * FROM outbox_events WHERE id=?").get(id);
      const audiences = reader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(id);
      return { kind,event: { eventId: id,leagueId: row.league_id,rowSha256: hash(canonicalize(row)),payloadSha256: hash(row.payload_json),
        audienceSha256: hash(canonicalize(audiences.map(row => hash(canonicalize(row))).sort())),
        reasonCode: "RESTORED_REFRESH_REVIEWED",evidenceSha256: hash("synthetic-invalidation-review:"+id) } };
    });
  } finally { reader.close(); }
  const events = decisions.filter(row => ["pending","failed","publishing"].includes(row.kind)).map(row => row.event);
  assert.equal(events.length,6);assert.equal(new Set(events.map(row => row.leagueId)).size,2);
  const options = { credentialPreparation: prepared,plan,events,reviewedByUserId: fixtureId("account:platformAdmin"),
    reconciliationId: crypto.randomUUID(),reconciledAtMs: now+2000,temporaryRoot: input.temporaryRoot };
  const result = prepareRecoveryInvalidationReconciliation({ ...options,outputDirectory: path.join(input.temporaryRoot,"invalidations-output") });
  assert.equal(result.suppressedEvents,6);assert.equal(result.unresolvedMessages,plan.unresolvedMessages-6);
  assert.equal(result.activationReady,false);assert.equal(result.deliveryPerformed,false);
  assert.equal(JSON.stringify(result).includes(PRIVATE_VALUE),false);
  await t.test("preserves all authoritative rows, message history and the hold without delivery", async () => {
    const db = openDatabase({ databasePath: copy(result.reconciledDatabasePath),environment: "staging",persistentRoot: input.temporaryRoot,requirePersistentRoot: true }).database;
    try {
      const after = allRows(db),ids = new Set(events.map(row => row.eventId));
      for (const [name,rows] of Object.entries(beforeRows)) if (!["outbox_events","application_metadata","security_audit_events"].includes(name)) assert.deepEqual(after[name],rows,name);
      for (const row of beforeRows.outbox_events.map(JSON.parse)) assert.deepEqual(db.prepare("SELECT * FROM outbox_events WHERE id=?").get(row.id),ids.has(row.id) ? {
        ...row,status: "discarded",last_error_code: "RECOVERY_INVALIDATION_SUPPRESSED",updated_at_ms: options.reconciledAtMs,version: row.version+1 } : row);
      assertCredentialAccess(db,false);assert.deepEqual(readRecoveryEpoch(db),prepared.recoveryEpoch);
      assert.ok(db.prepare("SELECT 1 FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY));
      assert.equal(db.prepare("SELECT event_type FROM security_audit_events WHERE id=?").get(options.reconciliationId).event_type,"recovery.invalidations_suppressed");
      const publisher = createLeagueOutboxPublicationService({ repository: createSqliteLeagueOutboxRepository({ database: db }),
        publisher: { publish() { assert.fail("Suppression must not deliver a refresh hint."); } },clock: { nowMs: () => now+3000 } });
      const before = db.serialize();
      for (const event of events) {
        const row = db.prepare("SELECT * FROM outbox_events WHERE id=?").get(event.eventId);
        assert.equal((await publisher.publishExact({ eventId: row.id,leagueId: row.league_id,expectedVersion: row.version })).outcome,"state_changed");
      }
      assert.deepEqual(db.serialize(),before);
    } finally { db.close(); }
  });
  await t.test("rebuilds exact review and rejects forged receipts and unrelated data changes", () => {
    const parent = openReadonlyDatabase({ databasePath: reviewPath }),current = openReadonlyDatabase({ databasePath: copy(result.reconciledDatabasePath) });
    const input = { preparedDatabase: parent,reconciledDatabase: current,credentialPreparation: prepared,originalPlan: plan,
      invalidationReconciliation: result,observedAtMs: now+3000 };
    try {
      const next = buildInvalidationReconciledRecoveryPlan(input);
      assert.equal(next.planVersion,5);assert.equal(next.previousPlanChecksum,plan.planChecksum);
      assert.equal(next.unresolvedMessages,plan.unresolvedMessages-6);assert.deepEqual(next.jobs,plan.jobs);
      assert.equal(next.executable,false);assert.equal(next.activationReady,false);assert.equal(current.prepare("SELECT total_changes() n").get().n,0);
      for (const patch of [{ observedAtMs: now },{ parentProof: {} },{ invalidationReconciliation: { ...result,reportChecksum: "e".repeat(64) } }])
        assert.throws(() => buildInvalidationReconciledRecoveryPlan({ ...input,...patch }),error => /^RECOVERY_/.test(error.code));
      const alteredPath = copy(result.reconciledDatabasePath);
      const writer = openDatabase({ databasePath: alteredPath,environment: "staging",persistentRoot: path.dirname(reviewPath),requirePersistentRoot: true }).database;
      let tableSnapshots;
      try {
        writer.prepare("UPDATE teams SET version=version+1 WHERE id=(SELECT id FROM teams ORDER BY id LIMIT 1)").run();
        tableSnapshots = Object.fromEntries(Object.entries(allRows(writer)).map(([name,rows]) => [name,{ count: rows.length,sha256: hash(canonicalize(rows.map(hash).sort())) }]));
      } finally { writer.close(); }
      const spoofed = { ...result,reconciledPlaintextSha256: readHash(alteredPath),tableSnapshots };
      for (const key of ["reportChecksum","reconciledDatabasePath","inspection"]) delete spoofed[key];
      const altered = openReadonlyDatabase({ databasePath: alteredPath });
      try { assert.throws(() => buildInvalidationReconciledRecoveryPlan({ ...input,reconciledDatabase: altered,
        invalidationReconciliation: { ...spoofed,reportChecksum: hash(canonicalize(spoofed)) } }),{ code: "RECOVERY_INVALIDATION_PLAN_DELTA_INVALID" }); }
      finally { altered.close(); }
    } finally { parent.close();current.close(); }
  });
  await t.test("rejects wrong evidence, other leagues, protected notifications, future events and non-administrators", () => {
    const change = patch => ({ events: [{ ...events[0],...patch }] });
    const cases = [
      [change({ rowSha256: "e".repeat(64) }),"EVENT_MISMATCH"],[change({ payloadSha256: "e".repeat(64) }),"EVENT_MISMATCH"],
      [change({ audienceSha256: "e".repeat(64) }),"AUDIENCE_MISMATCH"],
      [change({ leagueId: events.find(row => row.leagueId !== events[0].leagueId).leagueId }),"EVENT_MISMATCH"],
      [{ events: [events[0],events[0]] },"INPUT_INVALID"],[change({ approve: true }),"INPUT_INVALID"],
      [{ reviewedByUserId: fixtureId("account:leagueACommissioner") },"REVIEWER_INVALID"],
      [{ plan: { ...plan,planChecksum: "e".repeat(64) } },"PLAN_INVALID"],
      ...["notification","activity","published","future","malformed"].map(kind => [{ events: [decisions.find(row => row.kind === kind).event] },
        ["notification","activity"].includes(kind) ? "NOT_REFRESH_HINT" : kind === "malformed" ? "PAYLOAD_INVALID" : "EVENT_MISMATCH"]),
      [change({ eventId: fixtureId("recovery-preparation:outbox:security") }),"EVENT_MISMATCH"],
    ];
    for (const [patch,code] of cases) {
      const outputDirectory = path.join(input.temporaryRoot,crypto.randomUUID()+"-rejected");
      assert.throws(() => prepareRecoveryInvalidationReconciliation({ ...options,...patch,outputDirectory }),{ code: "RECOVERY_INVALIDATION_"+code });
      assert.equal(fs.existsSync(outputDirectory),false);
    }
  });
  await t.test("rolls back interrupted and unexpected writes, and preserves collisions and active sources", () => {
    for (const tamper of [false,true]) {
      let rolledBack = false;
      const outputDirectory = path.join(input.temporaryRoot,crypto.randomUUID()+"-rollback");
      assert.throws(() => prepareRecoveryInvalidationReconciliation({ ...options,outputDirectory,beforeCommit(db) {
        const close = db.close.bind(db);db.close = () => { assert.equal(db.inTransaction,false);assert.deepEqual(allRows(db),beforeRows);rolledBack = true;return close(); };
        if (tamper) db.prepare("UPDATE teams SET version=version+1 WHERE id=(SELECT id FROM teams ORDER BY id LIMIT 1)").run();
        else throw Error("fixture interruption");
      } }),{ code: tamper ? "RECOVERY_INVALIDATION_POSTCHECK_FAILED" : "RECOVERY_INVALIDATION_FAILED" });
      assert.equal(rolledBack,true);assert.equal(fs.existsSync(outputDirectory),false);
    }
    const existing = path.dirname(result.reconciledDatabasePath),digest = readHash(result.reconciledDatabasePath);
    assert.throws(() => prepareRecoveryInvalidationReconciliation({ ...options,outputDirectory: existing }),{ code: "RECOVERY_INVALIDATION_PATH_UNSAFE" });
    assert.equal(readHash(result.reconciledDatabasePath),digest);
    const wal = prepared.preparedDatabasePath+"-wal";fs.writeFileSync(wal,"fixture active writer",{ flag: "wx" });
    try {
      assert.throws(() => prepareRecoveryInvalidationReconciliation({ ...options,outputDirectory: path.join(input.temporaryRoot,"wal-rejected") }),{ code: "RECOVERY_INVALIDATION_SOURCE_CHANGED" });
      assert.equal(fs.readFileSync(wal,"utf8"),"fixture active writer");
    } finally { fs.unlinkSync(wal); }
  });
  await t.test("actual commands compose invalidation, email and another invalidation batch with immutable predecessors", () => {
    const write = value => { const file = path.join(input.temporaryRoot,crypto.randomUUID()+".json");fs.writeFileSync(file,JSON.stringify(value),{ flag: "wx" });return file; };
    const invoke = (script,request) => spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/"+script),"--request",write(request)],
      { encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
    const success = (script,request) => { const run = invoke(script,request);assert.equal(run.status,0,run.stderr);assert.equal(run.stderr,"");assert.equal(run.stdout.includes(PRIVATE_VALUE),false);return JSON.parse(run.stdout); };
    const credentialPreparationPath = write(prepared);
    const review = (source,at,lineage) => success("db-recovery-review.js",{ requestVersion: 1,credentialPreparationPath,preparedDatabasePath: source,
      expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,expectedDatabaseId: FIXTURE_DATABASE_ID,observedAtMs: at,...(lineage ? { lineagePath: write(lineage) } : {}) });
    const originalReview = review(reviewPath,now);
    const request = { requestVersion: 1,credentialPreparationPath,preparedDatabasePath: prepared.preparedDatabasePath,candidateReviewPath: write(originalReview),
      invalidationReviewPath: write({ events: events.slice(0,3) }),reviewedByUserId: options.reviewedByUserId,reconciliationId: crypto.randomUUID(),
      reconciledAtMs: now+2000,temporaryRoot: input.temporaryRoot,outputDirectory: path.join(input.temporaryRoot,"invalidation-command-first") };
    const first = success("db-recovery-invalidations.js",request),firstCopy = copy(first.reconciledDatabasePath);
    const lineage = { initialDatabasePath: reviewPath,initialPlan: plan,steps: [{ kind: "invalidation",reconciledDatabasePath: firstCopy,receipt: first,observedAtMs: now+3000 }] };
    const firstReview = review(firstCopy,now+3000,lineage);assert.equal(firstReview.plan.planVersion,5);
    const security = beforeRows.outbox_events.map(JSON.parse).find(row => row.id === fixtureId("recovery-preparation:outbox:security"));
    const deliveries = [{ eventId: security.id,rowSha256: hash(canonicalize(security)),payloadSha256: hash(security.payload_json),
      providerMessageSha256: hash("synthetic-invalidation-email-message"),providerReceiptSha256: hash("synthetic-invalidation-email-receipt"),deliveredAtMs: 90 }];
    const email = success("db-recovery-email.js",{ requestVersion: 1,credentialPreparationPath,preparedDatabasePath: first.reconciledDatabasePath,
      candidateReviewPath: write(firstReview),deliveryReviewPath: write({ deliveries }),lineagePath: write(lineage),reviewedByUserId: options.reviewedByUserId,
      reconciliationId: crypto.randomUUID(),reconciledAtMs: now+4000,temporaryRoot: input.temporaryRoot,outputDirectory: path.join(input.temporaryRoot,"invalidation-command-email") });
    const emailCopy = copy(email.reconciledDatabasePath);
    lineage.steps.push({ kind: "email",reconciledDatabasePath: emailCopy,receipt: email,observedAtMs: now+5000 });
    const emailReview = review(emailCopy,now+5000,lineage);
    const second = success("db-recovery-invalidations.js",{ ...request,preparedDatabasePath: email.reconciledDatabasePath,candidateReviewPath: write(emailReview),
      invalidationReviewPath: write({ events: events.slice(3) }),lineagePath: write(lineage),reconciliationId: crypto.randomUUID(),reconciledAtMs: now+6000,
      outputDirectory: path.join(input.temporaryRoot,"invalidation-command-second") });
    const secondCopy = copy(second.reconciledDatabasePath);
    lineage.steps.push({ kind: "invalidation",reconciledDatabasePath: secondCopy,receipt: second,observedAtMs: now+7000 });
    const final = review(secondCopy,now+7000,lineage);
    assert.equal(final.plan.planVersion,5);assert.equal(final.plan.unresolvedMessages,plan.unresolvedMessages-7);
    assert.deepEqual(final.plan.jobs,plan.jobs);assert.equal(final.activationReady,false);assert.equal(final.executable,false);
    for (const receipt of [first,email,second]) assert.equal(readHash(receipt.reconciledDatabasePath),receipt.reconciledPlaintextSha256);
    for (const patch of [{ approve: true },{ invalidationReviewPath: write({ events,send: true }) },{ invalidationReviewPath: write({ events: [{ ...events[0],audienceSha256: "e".repeat(64) }] }) }]) {
      const invalid = { ...request,...patch,outputDirectory: path.join(input.temporaryRoot,crypto.randomUUID()+"-cli-rejected") },run = invoke("db-recovery-invalidations.js",invalid);
      assert.equal(run.status,1);assert.equal(run.stdout,"");assert.match(JSON.parse(run.stderr).error.code,/^RECOVERY_INVALIDATION_/);
      assert.equal(run.stderr.includes(PRIVATE_VALUE),false);assert.equal(fs.existsSync(invalid.outputDirectory),false);
    }
  });
  assert.equal(readHash(prepared.preparedDatabasePath),sourceHash);assert.deepEqual(started.runtime.database.serialize(),sourceBefore);
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
  await t.test("email recovery command suppresses the exact reviewed messages and preserves rejected outputs", () => {
    const directory = path.join(input.temporaryRoot,"email-command-inputs"); fs.mkdirSync(directory);
    const write = (name,value) => {
      const file = path.join(directory,name);fs.writeFileSync(file,JSON.stringify(value),{ flag: "wx" });return file;
    };
    const credentialPreparationPath = write("credentials.json",prepared);
    const reviewRequest = { requestVersion: 1,expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,expectedDatabaseId: FIXTURE_DATABASE_ID,
      observedAtMs: plan.observedAtMs,preparedDatabasePath: reviewPath,credentialPreparationPath };
    const reviewed = spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-review.js"),"--request",write("review.json",reviewRequest)],
      { encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
    assert.equal(reviewed.status,0,reviewed.stderr);assert.equal(reviewed.stderr,"");
    const candidateReview = JSON.parse(reviewed.stdout);assert.deepEqual(candidateReview.plan,plan);
    const request = { requestVersion: 1,credentialPreparationPath,preparedDatabasePath: prepared.preparedDatabasePath,
      candidateReviewPath: write("candidate.json",candidateReview),deliveryReviewPath: write("deliveries.json",{ deliveries }),
      reviewedByUserId: options.reviewedByUserId,reconciliationId: crypto.randomUUID(),reconciledAtMs: now,
      temporaryRoot: input.temporaryRoot,outputDirectory: path.join(input.temporaryRoot,"email-command-output") };
    const invoke = value => spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-email.js"),"--request",
      write(crypto.randomUUID()+".json",value)],{ encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
    const success = invoke(request);assert.equal(success.status,0,success.stderr);assert.equal(success.stderr,"");
    const output = JSON.parse(success.stdout),receiptPath = path.join(request.outputDirectory,"email-reconciliation.json");
    assert.equal(output.suppressedMessages,3);assert.equal(output.unresolvedMessages,plan.unresolvedMessages-3);
    assert.equal(output.activationReady,false);assert.equal(output.normalRuntime,"blocked-by-durable-recovery-hold");
    assert.equal(output.providerEvidence,"reviewer-supplied-not-independently-fetched");assert.equal(success.stdout.includes(PRIVATE_VALUE),false);
    const outputHash = readHash(output.reconciledDatabasePath),receiptHash = readHash(receiptPath);
    const outputReader = openReadonlyDatabase({ databasePath: output.reconciledDatabasePath });
    const originalReader = openReadonlyDatabase({ databasePath: reviewPath });
    try {
      const next = buildEmailReconciledRecoveryPlan({ preparedDatabase: originalReader,reconciledDatabase: outputReader,
        credentialPreparation: prepared,originalPlan: plan,emailReconciliation: JSON.parse(fs.readFileSync(receiptPath,"utf8")),observedAtMs: now+1 });
      assert.equal(next.unresolvedMessages,plan.unresolvedMessages-3);assert.deepEqual(next.jobs,plan.jobs);
      assert.equal(next.preparedPlaintextSha256,outputHash);assert.equal(next.activationReady,false);
      assertCredentialAccess(outputReader,false);assert.equal(outputReader.prepare("SELECT total_changes() n").get().n,0);
    } finally { originalReader.close();outputReader.close(); }
    const alteredReview = { ...candidateReview,plan: { ...plan,unresolvedMessages: 0 } };
    delete alteredReview.reportChecksum;alteredReview.reportChecksum = hash(canonicalize(alteredReview));
    const failures = [
      [request,"RECOVERY_EMAIL_PATH_UNSAFE"],
      [{ ...request,outputDirectory: path.join(input.temporaryRoot,"email-command-extra"),approve: true },"RECOVERY_EMAIL_REQUEST_INVALID"],
      [{ ...request,outputDirectory: path.join(input.temporaryRoot,"email-command-reviewer"),reviewedByUserId: fixtureId("account:leagueACommissioner") },"RECOVERY_EMAIL_REVIEWER_INVALID"],
      [{ ...request,outputDirectory: path.join(input.temporaryRoot,"email-command-stale"),candidateReviewPath: write("altered-candidate.json",alteredReview) },"RECOVERY_EMAIL_PLAN_INVALID"],
      [{ ...request,outputDirectory: path.join(input.temporaryRoot,"email-command-delivery"),deliveryReviewPath: write("altered-deliveries.json",{ deliveries: [{ ...deliveries[0],rowSha256: "f".repeat(64) }] }) },"RECOVERY_EMAIL_DELIVERY_MISMATCH"],
      [{ ...request,outputDirectory: path.join(input.temporaryRoot,"email-command-provider"),deliveryReviewPath: write("extra-deliveries.json",{ deliveries,send: true }) },"RECOVERY_EMAIL_REQUEST_INVALID"],
    ];
    for (const [invalid,code] of failures) {
      const failure = invoke(invalid);assert.equal(failure.status,1);assert.equal(failure.stdout,"");
      assert.equal(JSON.parse(failure.stderr).error.code,code);assert.equal(failure.stderr.includes(PRIVATE_VALUE),false);
      if (invalid.outputDirectory !== request.outputDirectory) assert.equal(fs.existsSync(invalid.outputDirectory),false);
    }
    assert.equal(readHash(output.reconciledDatabasePath),outputHash);assert.equal(readHash(receiptPath),receiptHash);
    assert.equal(readHash(prepared.preparedDatabasePath),sourceHash);assert.deepEqual(started.runtime.database.serialize(),sourceBefore);
  });
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
  const { createTargetServices } = require("../../src/bootstrap/createTargetRuntime");
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
  // The backup uses wall-clock timestamps. Give this later transaction the
  // same clock basis instead of the fixture runtime's fixed historical date.
  const postBackupServices = createTargetServices({ repositories: started.runtime.repositories,
    currentSeason: { label: "2026", nhlSeasonKey: "20262027" },
    securityFoundations: { config: started.runtime.securityConfig, clock: { nowMs: () => Date.now() }, secureRandom: createSecureRandom(),
      logger: { error() { assert.fail("Post-backup fixture operation must not log an error."); }, warn() {}, info() {} } },
    leagueInvalidationPublisher: { publish() { assert.fail("Post-backup fixture operation must not publish."); } },
    nhlFetchImplementation: async () => { assert.fail("Post-backup fixture operation must not call a provider."); } });
  const boughtOut = await postBackupServices.league.rosterAction.buyOutContract({
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
  const prepared = prepareRecoveryCredentials({ ...input, restoredCandidate: restored, preparedAtMs: Date.now(),
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
    await t.test("completion review separates a real lost buyout from the intact held candidate", () => {
      const { buildRecoveryCompletionReview } = require("../../src/operations/backups/buildRecoveryCompletionReview");
      const reader = openReadonlyDatabase({ databasePath: prepared.preparedDatabasePath });
      const before = [reader,restoredDatabase,preservedDatabase].map(database => readHash(database.name));
      const observedAtMs = Date.now();
      try {
        const plan = buildRecoveryReconciliationPlan({ database: reader,credentialPreparation: prepared,observedAtMs,
          expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId });
        const reviewed = buildRecoveryCompletionReview({ candidateDatabase: reader,restoredDatabase,preservedDatabase,
          credentialPreparation: prepared,plan,preservedPlaintextSha256: preserved.plaintextSha256,
          expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,observedAtMs });
        assert.deepEqual(reviewed.lossWindow.financialState,financial);
        assert.equal(reviewed.lossWindow.changedRecords,comparison.changedRecords);
        assert.equal(reviewed.candidateChanges.financialState.changedLeagues,0);
        assert.ok(reviewed.lossWindow.changedRecords > 0);
        assert.equal(reviewed.recordedLossProgress.totalChangedRecords,comparison.changedRecords);
        for (const table of ["contracts","buyout_obligations","player_ownerships"]) {
          assert.ok(reviewed.recordedLossProgress.tables[table].length>0);
          assert.ok(reviewed.recordedLossProgress.tables[table].every(row=>row.status==="stillAtBackupState"));
        }
        assert.equal(reviewed.gates.find(gate => gate.id === "loss-window-and-preservation-evidence").recordedChangedRecords,comparison.changedRecords);
        assert.equal(reviewed.preservationProvenanceVerified,false);
        assert.equal(reviewed.completeLossWindowEvidence,false);assert.equal(reviewed.activationReady,false);
        assert.equal(JSON.stringify(reviewed).includes(issued.rawSessionToken),false);
        assert.equal(JSON.stringify(reviewed).includes(PRIVATE_VALUE),false);
        for (const database of [reader,restoredDatabase,preservedDatabase]) assert.equal(database.prepare("SELECT total_changes() n").get().n,0);
        assert.deepEqual([reader,restoredDatabase,preservedDatabase].map(database => readHash(database.name)),before);
      } finally { reader.close(); }
    });
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
  await t.test("a known lost buyout reconstructs exact financial history after fresh fixture sign-in and survives encrypted backup", async () => {
    const { createTargetRepositories,createTargetServices } = require("../../src/bootstrap/createTargetRuntime");
    const { assertRecoveryRuntimeAllowed } = require("../../src/infrastructure/database/recoveryHold");
    const activity = source.prepare("SELECT * FROM league_activity WHERE related_type='buyout_obligation' AND related_id=?").get(boughtOut.buyout.id);
    const originalReceipt = JSON.parse(activity.metadata_json).buyoutReceipt;
    const contractEvent = source.prepare("SELECT * FROM contract_events WHERE source_type='buyout' AND source_id=?").get(boughtOut.buyout.id);
    const ownershipEvent = source.prepare("SELECT * FROM ownership_events WHERE source_type='buyout' AND source_id=?").get(boughtOut.buyout.id);
    assert.ok(activity && originalReceipt && contractEvent && ownershipEvent);
    // These IDs and the original time are reconstructed from actual preserved
    // evidence. They are not newly guessed transactions or production authority.
    const preservedIds = [boughtOut.buyout.id,...originalReceipt.years.map(year => year.id),contractEvent.id,ownershipEvent.id,activity.id];
    const sourceRows = allRows(source);
    const gameTables = Object.keys(atBackup).filter(table => !["sessions","security_audit_events"].includes(table) &&
      canonicalize(atBackup[table]) !== canonicalize(sourceRows[table])).sort();
    assert.ok(gameTables.includes("buyout_years"));assert.ok(gameTables.includes("player_ownerships"));
    const originalFiles = [prepared.preparedDatabasePath,restored.targetDatabasePath,path.join(preserved.outputDirectory,BACKUP_FILE_NAME)];
    const originalHashes = originalFiles.map(readHash);
    const replayPath = path.join(input.temporaryRoot,"known-buyout-reconstruction.sqlite3");
    fs.copyFileSync(prepared.preparedDatabasePath,replayPath,fs.constants.COPYFILE_EXCL);
    const random = createSecureRandom(),ids = [],providers = [],deliveries = [],errors = [];
    const secureRandom = { ...random,id: () => ids.length ? ids.shift() : random.id() };
    let now = Date.now();
    const makeServices = database => createTargetServices({ repositories: createTargetRepositories({ database,secureRandom }),
      currentSeason: { label: "2026",nhlSeasonKey: "20262027" },
      securityFoundations: { config: started.runtime.securityConfig,clock: { nowMs: () => now },secureRandom,
        logger: { error: value => errors.push(value),warn: value => errors.push(value),info() {} } },
      leagueInvalidationPublisher: { publish() { deliveries.push(true);assert.fail("Held reconstruction must not publish."); } },
      nhlFetchImplementation: async () => { providers.push(true);throw new Error("Recovery fixture provider unavailable."); } });
    let reconstructedRows,freshToken;
    let work = openDatabase({ databasePath: replayPath,environment: "test" }).database;
    try {
      assert.throws(() => assertRecoveryRuntimeAllowed(work),{ code: "DATABASE_RECOVERY_HELD" });
      const services = makeServices(work);
      assert.equal(services.sessionService.resolveWithoutActivity(issued.rawSessionToken).valid,false);
      assert.equal(services.sessionService.resolveWithoutActivity(sessionBytes.toString("base64url")).valid,false);
      const email = work.prepare("SELECT email_normalized FROM users WHERE id=?").get(fixtureId("account:leagueBManagerOne")).email_normalized;
      const signedIn = await services.account.signIn.signIn({ email,password: "Recovery Preparation Fixture Password 2026!" });
      assert.equal(signedIn.signedIn,true);
      freshToken = signedIn.rawSessionToken;
      const fresh = services.sessionService.resolveWithoutActivity(freshToken);assert.equal(fresh.valid,true);
      assert.equal(fresh.user.id,activity.actor_user_id);
      assert.notEqual(fresh.session.id,issued.session.id);
      const before = allRows(work);
      const command = { authenticated: fresh,leagueId: fixtureId("league:leagueB"),teamId: fixtureId("team:leagueB:6"),contractId,
        input: { confirmed: true,expectedContractVersion: contractAtBackup.version,expectedOwnershipVersion: originalReceipt.releasedOwnership.version } };
      await assert.rejects(services.league.rosterAction.buyOutContract({ ...command,leagueId: fixtureId("league:leagueA"),teamId: fixtureId("team:leagueA:1") }),
        { code: "LEAGUE_NOT_FOUND" });
      assert.deepEqual(allRows(work),before);
      ids.push(...preservedIds);
      now = activity.occurred_at_ms;
      const result = await services.league.rosterAction.buyOutContract(command);
      assert.equal(ids.length,0);assert.equal(result.code,"CONTRACT_BOUGHT_OUT");
      assert.deepEqual(result.buyout,boughtOut.buyout);assert.deepEqual(result.lateLock,boughtOut.lateLock);
      assert.deepEqual(providers,[]);assert.deepEqual(deliveries,[]);assert.deepEqual(errors,[]);
      const after = allRows(work);
      assert.deepEqual(Object.keys(before).filter(table => canonicalize(before[table]) !== canonicalize(after[table])).sort(),gameTables);
      for (const table of gameTables) {
        const expectedRows = table === "outbox_events"
          ? [...sourceRows[table].filter(row => JSON.parse(row).league_id !== null),
            ...before[table].filter(row => JSON.parse(row).league_id === null)].sort()
          : sourceRows[table];
        assert.deepEqual(after[table],expectedRows,table);
      }
      for (const table of Object.keys(before).filter(table => !gameTables.includes(table))) assert.deepEqual(after[table],before[table],table);
      const totals = work.prepare("SELECT COALESCE(SUM(penalty_cents),0) total FROM buyout_years").get().total;
      assert.equal(totals,penaltyTotalAtBackup+boughtOut.buyout.annualPenaltyCents*boughtOut.buyout.remainingYears);
      await assert.rejects(services.league.rosterAction.buyOutContract(command),{ code: "BUYOUT_CONTRACT_NOT_OWNED" });
      assert.deepEqual(allRows(work),after);
      now = Date.now();
      assert.equal(services.account.signOut.signOut({ session: fresh.session,user: fresh.user }).signedOut,true);
      assert.equal(services.sessionService.resolveWithoutActivity(freshToken).valid,false);
      assert.equal(work.prepare("SELECT COUNT(*) n FROM sessions WHERE status='active'").get().n,0);
      assert.equal(work.prepare("SELECT COUNT(*) n FROM account_action_tokens WHERE status='active'").get().n,0);
      assert.deepEqual(readRecoveryEpoch(work),prepared.recoveryEpoch);
      assert.throws(() => assertRecoveryRuntimeAllowed(work),{ code: "DATABASE_RECOVERY_HELD" });
      assert.deepEqual(work.pragma("foreign_key_check"),[]);
      reconstructedRows = allRows(work);
    } finally { work.close(); }
    // A fresh service composition still cannot reconstruct the transaction twice.
    work = openDatabase({ databasePath: replayPath,environment: "test" }).database;
    try {
      const services = makeServices(work);
      assert.equal(services.sessionService.resolveWithoutActivity(freshToken).valid,false);
      const before = allRows(work);
      const replayCommand = { buyoutId: boughtOut.buyout.id,buyoutYearIds: originalReceipt.years.map(year => year.id),
        contractEventId: contractEvent.id,ownershipEventId: ownershipEvent.id,activityId: activity.id,
        leagueId: activity.league_id,seasonId: originalReceipt.releasedOwnership.season_id,teamId: originalReceipt.releasedOwnership.team_id,
        playerId: originalReceipt.releasedOwnership.player_id,contractId,ownershipId: originalReceipt.releasedOwnership.id,
        expectedContractVersion: contractAtBackup.version,expectedOwnershipVersion: originalReceipt.releasedOwnership.version,
        actorUserId: activity.actor_user_id,actorAuthority: activity.actor_authority,confirmed: true,reason: activity.reason,occurredAtMs: activity.occurred_at_ms };
      const repositories = createTargetRepositories({ database: work,secureRandom });
      const replayed = repositories.buyouts.buyOut(replayCommand);
      assert.equal(replayed.obligation.id,boughtOut.buyout.id);
      assert.deepEqual(allRows(work),before);assert.deepEqual(before,reconstructedRows);
      assert.equal(work.prepare("SELECT total_changes() n").get().n,0);
    } finally { work.close(); }
    const replayHash = readHash(replayPath);
    const encrypted = await createEncryptedOffsiteBackup({ databasePath: replayPath,config,objectStorage,
      reason: "pre-cutover-rehearsal",requestedByType: "release_qa_automation",requestedById: "known-buyout-reconstruction-fixture",
      backendBuildId: "m7-local-backend",retentionClass: "incident-preservation" });
    const restoredAgain = await restoreEncryptedBackupToCleanPath({ manifestObjectKey: encrypted.manifestObjectKey,objectStorage,
      keyResolver: async () => encryptionKey,expectedEnvironment: config.appEnv,expectedEnvironmentId: config.environmentId,
      expectedDatabaseId: config.databaseId,targetDatabasePath: path.join(input.temporaryRoot,"known-buyout-reconstruction-restored.sqlite3"),temporaryRoot: input.temporaryRoot });
    const finalReader = openReadonlyDatabase({ databasePath: restoredAgain.targetDatabasePath });
    try {
      assert.deepEqual(allRows(finalReader),reconstructedRows);
      assert.deepEqual(readRecoveryEpoch(finalReader),prepared.recoveryEpoch);
      assert.throws(() => assertRecoveryRuntimeAllowed(finalReader),{ code: "DATABASE_RECOVERY_HELD" });
      assert.equal(finalReader.prepare("SELECT total_changes() n").get().n,0);
    } finally { finalReader.close(); }
    assert.equal(readHash(replayPath),replayHash);assert.deepEqual(originalFiles.map(readHash),originalHashes);
    assert.deepEqual(providers,[]);assert.deepEqual(deliveries,[]);assert.deepEqual(errors,[]);
  });
  await t.test("reviewed known-buyout operation preserves historical rows and independently rejects forged recovery evidence", async () => {
    const { buildKnownBuyoutEvidence, readRows: readRecoveryRows, snapshots: recoverySnapshots } = require("../../src/operations/backups/recoveryKnownBuyoutEvidence");
    const { prepareRecoveryKnownBuyout } = require("../../src/operations/backups/prepareRecoveryKnownBuyout");
    const { verifyRecoveryKnownBuyout, buildKnownBuyoutReconciledRecoveryPlan } = require("../../src/operations/backups/verifyRecoveryKnownBuyout");
    const { assertRecoveryRuntimeAllowed } = require("../../src/infrastructure/database/recoveryHold");
    const reader = openReadonlyDatabase({ databasePath: prepared.preparedDatabasePath });
    const restoredDatabase = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
    const preservedDatabase = openReadonlyDatabase({ databasePath: path.join(preserved.outputDirectory,BACKUP_FILE_NAME) });
    const sources = [reader, restoredDatabase, preservedDatabase], originalHashes = sources.map(row => readHash(row.name));
    const backupManifestBytes = (await objectStorage.getPrivateObject({ objectKey: backup.manifestObjectKey })).body;
    const preservationManifestBytes = fs.readFileSync(path.join(preserved.outputDirectory,"backup-manifest.json"));
    const observedAtMs = Date.now();
    try {
      const plan = buildRecoveryReconciliationPlan({ database: reader, credentialPreparation: prepared, observedAtMs,
        expectedEnvironmentId: config.environmentId, expectedDatabaseId: config.databaseId });
      const reviewOptions = { preparedDatabase: reader, restoredDatabase, preservedDatabase, credentialPreparation: prepared, plan,
        buyoutId: boughtOut.buyout.id, leagueId: fixtureId("league:leagueB"), preservedPlaintextSha256: preserved.plaintextSha256,
        observedAtMs, backupManifestBytes, preservationManifestBytes, expectedBackupManifestSha256: hash(backupManifestBytes),
        expectedPreservationManifestSha256: hash(preservationManifestBytes) };
      const { review, expected } = buildKnownBuyoutEvidence(reviewOptions);
      assert.equal(review.provenance.offlineManifestBindingVerified,true);
      assert.equal(review.provenance.externalCustodyVerified,false);
      assert.equal(review.historicalActorUserId,fixtureId("account:leagueBManagerOne"));
      assert.equal(review.financialEffect.totalScheduledPenaltyCents,boughtOut.buyout.annualPenaltyCents*boughtOut.buyout.remainingYears);
      assert.equal(review.operatorAuthenticated,false);assert.equal(review.completeLossWindowEvidence,false);assert.equal(review.activationReady,false);
      assert.equal(JSON.stringify(review).includes(PRIVATE_VALUE),false);assert.equal(JSON.stringify(review).includes(issued.rawSessionToken),false);
      const decision = { reconciliationId: crypto.randomUUID(), action: "reconstruct-known-buyout-held", reviewedByUserId: fixtureId("account:platformAdmin"),
        reviewChecksum: review.reportChecksum, evidenceSha256: review.evidenceSha256, reasonCode: "RECOVER_PRESERVED_BUYOUT" };
      const outputDirectory = path.join(input.temporaryRoot,"reviewed-known-buyout");
      const action = { reviewOptions, decision, temporaryRoot: input.temporaryRoot, outputDirectory };
      for (const bad of [{ ...decision, reviewedByUserId: fixtureId("account:leagueBManagerOne") },
        { ...decision, evidenceSha256: "0".repeat(64) }, { ...decision, activate: true }]) {
        await assert.rejects(prepareRecoveryKnownBuyout({ ...action, decision: bad }),error => /^RECOVERY_BUYOUT_(REVIEWER|DECISION)_INVALID$/.test(error.code));
        assert.equal(fs.existsSync(outputDirectory),false);
      }
      assert.throws(() => buildKnownBuyoutEvidence({ ...reviewOptions, expectedPreservationManifestSha256: "0".repeat(64) }),{ code: "RECOVERY_BUYOUT_INPUT_INVALID" });
      assert.throws(() => buildKnownBuyoutEvidence({ ...reviewOptions, leagueId: fixtureId("league:leagueA") }),{ code: "RECOVERY_BUYOUT_HISTORY_INCOMPLETE" });
      const preparedResult = await prepareRecoveryKnownBuyout(action);
      assert.equal(preparedResult.status,"known-buyout-reconstructed-held");
      const resultReader = openReadonlyDatabase({ databasePath: preparedResult.reconciledDatabasePath });
      try {
        const verified = verifyRecoveryKnownBuyout({ reviewOptions, reconciledDatabase: resultReader, reconciliation: preparedResult });
        assert.equal(verified.reportChecksum,preparedResult.reportChecksum);
        assert.equal(resultReader.prepare("SELECT actor_user_id FROM security_audit_events WHERE id=?").get(decision.reconciliationId).actor_user_id,decision.reviewedByUserId);
        assert.equal(resultReader.prepare("SELECT occurred_at_ms FROM security_audit_events WHERE id=?").get(decision.reconciliationId).occurred_at_ms,observedAtMs);
        const rows = allRows(resultReader), resultSnapshots = recoverySnapshots(readRecoveryRows(resultReader)), expectedSnapshots = recoverySnapshots(expected);
        const preservedRows = allRows(preservedDatabase);
        for (const table of Object.keys(expected).filter(name => !["application_metadata","security_audit_events"].includes(name))) {
          assert.deepEqual(resultSnapshots[table],expectedSnapshots[table],table);
        }
        for (const table of new Set(review.effects.map(row => row.table))) {
          const expectedRows = table === "outbox_events"
            ? [...preservedRows[table].filter(row => JSON.parse(row).league_id !== null),
              ...allRows(reader)[table].filter(row => JSON.parse(row).league_id === null)].sort()
            : preservedRows[table];
          assert.deepEqual(rows[table],expectedRows,table);
        }
        assert.throws(() => assertRecoveryRuntimeAllowed(resultReader),{ code: "DATABASE_RECOVERY_HELD" });
        assert.deepEqual(readRecoveryEpoch(resultReader),prepared.recoveryEpoch);
        assert.equal(resultReader.prepare("SELECT COUNT(*) n FROM sessions WHERE status='active'").get().n,0);
        const next = buildKnownBuyoutReconciledRecoveryPlan({ preparedDatabase: reader, reconciledDatabase: resultReader, restoredDatabase, preservedDatabase,
          credentialPreparation: prepared, originalPlan: plan, knownBuyoutReconciliation: preparedResult, observedAtMs, backupManifestBytes, preservationManifestBytes });
        assert.equal(next.planVersion,8);assert.equal(next.previousPlanChecksum,plan.planChecksum);
        assert.deepEqual(next.jobs,plan.jobs);
        const priorMessageIds = new Set(plan.outbox.map(row => row.id));
        assert.deepEqual(next.outbox.filter(row => priorMessageIds.has(row.id)),plan.outbox);
        const addedMessages = next.outbox.filter(row => !priorMessageIds.has(row.id));
        assert.equal(addedMessages.length,1);assert.equal(addedMessages[0].eventType,"contract.changed");
        assert.equal(addedMessages[0].disposition,"held-awaiting-delivery-evidence");assert.equal(addedMessages[0].deliveryPermitted,false);
        assert.equal(next.unresolvedJobs,plan.unresolvedJobs);assert.equal(next.unresolvedMessages,plan.unresolvedMessages+1);
        assert.equal(next.activationReady,false);
        const { buildRecoveryReconciliationLineage, buildRecoveryPlanFromLineage } = require("../../src/operations/backups/buildRecoveryReconciliationLineage");
        const step = { kind: "known-buyout", reconciledDatabase: resultReader, receipt: preparedResult, observedAtMs,
          restoredDatabase, preservedDatabase, backupManifestBytes, preservationManifestBytes };
        assert.deepEqual(buildRecoveryReconciliationLineage({ initialDatabase: reader, credentialPreparation: prepared, initialPlan: plan, steps: [step] }),next);
        assert.throws(() => buildRecoveryReconciliationLineage({ initialDatabase: reader, credentialPreparation: prepared, initialPlan: plan,
          steps: [step,{ ...step, observedAtMs: observedAtMs+1 }] }),{ code: "RECOVERY_LINEAGE_SOURCE_REUSED" });
        const commandDirectory = path.join(input.temporaryRoot,"known-buyout-command");fs.mkdirSync(commandDirectory);
        const save = (name,value) => { const file = path.join(commandDirectory,name);fs.writeFileSync(file,Buffer.isBuffer(value) ? value : JSON.stringify(value),{ flag: "wx" });return file; };
        const invoke = (name,flag,value,success=true) => {
          const result = spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/"+name),flag,save(crypto.randomUUID()+".json",value)],
            { encoding: "utf8",timeout: 60_000,maxBuffer: 16*1024*1024 });
          assert.equal(result.status,success ? 0 : 1,result.stderr);assert.equal((result.stdout+result.stderr).includes(PRIVATE_VALUE),false);
          if (success) { assert.equal(result.stderr,"");return JSON.parse(result.stdout); }
          assert.equal(result.stdout,"");assert.match(JSON.parse(result.stderr).error.code,/^RECOVERY_/);
        };
        const credentialPreparationPath = save("credentials.json",prepared), backupManifestPath = save("backup-manifest.json",backupManifestBytes),
          preservationManifestPath = save("preservation-manifest.json",preservationManifestBytes);
        const candidateRequest = { requestVersion: 1,expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,
          observedAtMs,preparedDatabasePath: reader.name,credentialPreparationPath };
        const candidateReview = invoke("db-recovery-review.js","--request",candidateRequest);
        assert.deepEqual(candidateReview.plan,plan);
        const commandRequest = { requestVersion: 1,credentialPreparationPath,candidateReviewPath: save("candidate-review.json",candidateReview),
          preparedDatabasePath: reader.name,restoredDatabasePath: restoredDatabase.name,preservedDatabasePath: preservedDatabase.name,
          preservedPlaintextSha256: preserved.plaintextSha256,buyoutId: review.buyoutId,leagueId: review.leagueId,observedAtMs,
          backupManifestPath,preservationManifestPath,expectedBackupManifestSha256: hash(backupManifestBytes),expectedPreservationManifestSha256: hash(preservationManifestBytes) };
        assert.deepEqual(invoke("db-recovery-known-buyout.js","--review",commandRequest),review);
        for (const change of [{ activate: true },{ decisionPath: PRIVATE_VALUE },{ expectedBackupManifestSha256: "0".repeat(64) }]) {
          invoke("db-recovery-known-buyout.js","--review",{ ...commandRequest,...change },false);
        }
        const cliResult = invoke("db-recovery-known-buyout.js","--request",{ ...commandRequest,decisionPath: save("decision.json",decision),
          temporaryRoot: input.temporaryRoot,outputDirectory: path.join(input.temporaryRoot,"known-buyout-cli-output") });
        assert.equal(cliResult.reportChecksum,preparedResult.reportChecksum);
        assert.equal(readHash(cliResult.reconciledDatabasePath),readHash(preparedResult.reconciledDatabasePath));
        const descriptor = { initialDatabasePath: reader.name,initialPlan: plan,steps: [{ kind: "known-buyout",reconciledDatabasePath: resultReader.name,
          receipt: preparedResult,observedAtMs,restoredDatabasePath: restoredDatabase.name,preservedDatabasePath: preservedDatabase.name,backupManifestPath,preservationManifestPath }] };
        const lineageOptions = { database: resultReader,credentialPreparation: prepared,lineage: descriptor,observedAtMs,
          expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId };
        assert.deepEqual(buildRecoveryPlanFromLineage(lineageOptions),next);
        const lineagePath = save("lineage.json",descriptor);
        const reviewedNext = invoke("db-recovery-review.js","--request",{ ...candidateRequest,preparedDatabasePath: resultReader.name,lineagePath });
        assert.deepEqual(reviewedNext.plan,next);
        invoke("db-recovery-review.js","--request",{ ...candidateRequest,preparedDatabasePath: resultReader.name },false);
        const incomplete = JSON.parse(JSON.stringify(descriptor));delete incomplete.steps[0].preservationManifestPath;
        assert.throws(() => buildRecoveryPlanFromLineage({ ...lineageOptions,lineage: incomplete }),{ code: "RECOVERY_LINEAGE_INPUT_INVALID" });
        const { buildRecoveryCompletionReview } = require("../../src/operations/backups/buildRecoveryCompletionReview");
        const completion = buildRecoveryCompletionReview({ candidateDatabase: resultReader,restoredDatabase,preservedDatabase,
          credentialPreparation: prepared,plan: next,lineage: descriptor,preservedPlaintextSha256: preserved.plaintextSha256,
          expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,observedAtMs });
        for (const state of completion.candidateChanges.financialState.leagues) {
          assert.deepEqual(state.preserved,completion.lossWindow.financialState.leagues.find(row => row.leagueId === state.leagueId).preserved);
        }
        assert.equal(completion.completeLossWindowEvidence,false);assert.equal(completion.activationReady,false);
        for (const table of new Set(review.effects.map(row=>row.table))) {
          const changed = completion.recordedLossProgress.tables[table];
          assert.ok(changed?.length>0,table);
          assert.ok(changed.every(row=>row.status==="matchesPreserved"),table);
        }
        assert.ok(completion.recordedLossProgress.counts.matchesPreserved>0);
        assert.equal(completion.recordedLossProgress.preservedStateIsApproved,false);
        assert.equal(completion.recordedLossProgress.completeLossWindowEvidence,false);
        // A following real recovery operation must verify the buyout's entire
        // predecessor and manifests, preserving its reconstructed finances.
        const event = resultReader.prepare("SELECT * FROM outbox_events WHERE league_id IS NOT NULL AND event_type='trade.changed' AND status='pending' ORDER BY id LIMIT 1").get();
        assert.ok(event);
        const audiences = resultReader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(event.id);
        const cleanSourcePath = path.join(input.temporaryRoot,"known-buyout-before-invalidation.sqlite3");
        fs.copyFileSync(resultReader.name,cleanSourcePath,fs.constants.COPYFILE_EXCL);
        const suppressed = prepareRecoveryInvalidationReconciliation({ credentialPreparation: { ...prepared,preparedDatabasePath: cleanSourcePath },
          plan: next,lineage: descriptor,events: [{ eventId: event.id,leagueId: event.league_id,rowSha256: hash(canonicalize(event)),
            payloadSha256: hash(event.payload_json),audienceSha256: hash(canonicalize(audiences.map(row => hash(canonicalize(row))).sort())),
            reasonCode: "REVIEWED_RESTORED_REFRESH",evidenceSha256: hash("synthetic restored refresh after known buyout") }],
          reviewedByUserId: decision.reviewedByUserId,reconciliationId: crypto.randomUUID(),reconciledAtMs: observedAtMs+1,
          temporaryRoot: input.temporaryRoot,outputDirectory: path.join(input.temporaryRoot,"known-buyout-then-invalidation") });
        const suppressedReader = openReadonlyDatabase({ databasePath: suppressed.reconciledDatabasePath });
        try {
          const combined = { ...descriptor,steps: [...descriptor.steps,{ kind: "invalidation",reconciledDatabasePath: suppressedReader.name,
            receipt: suppressed,observedAtMs: observedAtMs+2 }] };
          const combinedOptions = { ...lineageOptions,database: suppressedReader,lineage: combined,observedAtMs: observedAtMs+2 };
          const combinedPlan = buildRecoveryPlanFromLineage(combinedOptions);
          assert.equal(combinedPlan.previousPlanChecksum,next.planChecksum);
          assert.equal(combinedPlan.unresolvedMessages,next.unresolvedMessages-1);
          assert.deepEqual(combinedPlan.jobs,next.jobs);
          const combinedRows = allRows(suppressedReader);
          for (const table of new Set(review.effects.map(row => row.table))) {
            const unaffected = row => table !== "outbox_events" || JSON.parse(row).id !== event.id;
            assert.deepEqual(combinedRows[table].filter(unaffected),rows[table].filter(unaffected),table);
          }
          const suppressedEvent = suppressedReader.prepare("SELECT * FROM outbox_events WHERE id=?").get(event.id);
          assert.equal(suppressedEvent.status,"discarded");
          assert.equal(suppressedEvent.version,event.version+1);
          assert.throws(() => buildRecoveryPlanFromLineage({ ...combinedOptions,lineage: { ...combined,steps: combined.steps.slice(1) } }),
            error => /^RECOVERY_LINEAGE_/.test(error.code));
          assert.equal(suppressedReader.prepare("SELECT total_changes() n").get().n,0);
        } finally { suppressedReader.close(); }
        const { reconciledDatabasePath: ignoredPath, inspection: ignoredInspection, reportChecksum: ignoredChecksum, ...receiptBody } = preparedResult;
        const forged = { ...receiptBody, activationReady: true };
        assert.throws(() => verifyRecoveryKnownBuyout({ reviewOptions, reconciledDatabase: resultReader,
          reconciliation: { ...forged, reportChecksum: hash(canonicalize(forged)) } }),{ code: "RECOVERY_BUYOUT_RECEIPT_INVALID" });
        assert.equal(resultReader.prepare("SELECT total_changes() n").get().n,0);
      } finally { resultReader.close(); }
      await assert.rejects(prepareRecoveryKnownBuyout(action),{ code: "RECOVERY_BUYOUT_PATH_UNSAFE" });
      const corruptOutput = path.join(input.temporaryRoot,"reviewed-known-buyout-corrupt");
      await assert.rejects(prepareRecoveryKnownBuyout({ ...action, outputDirectory: corruptOutput, beforeReceipt(database) {
        database.prepare("UPDATE teams SET version=version+1 WHERE id=?").run(fixtureId("team:leagueA:1"));
      } }),{ code: "RECOVERY_BUYOUT_POSTCHECK_FAILED" });
      assert.equal(fs.existsSync(corruptOutput),false);
      const alteredPath = path.join(input.temporaryRoot,"known-buyout-altered-result.sqlite3");
      fs.copyFileSync(preparedResult.reconciledDatabasePath,alteredPath,fs.constants.COPYFILE_EXCL);
      const writer = openDatabase({ databasePath: alteredPath,environment: "test" }).database;
      writer.prepare("UPDATE buyout_years SET penalty_cents=penalty_cents+1 WHERE buyout_obligation_id=?").run(boughtOut.buyout.id);writer.close();
      const altered = openReadonlyDatabase({ databasePath: alteredPath });
      try {
        const { reconciledDatabasePath, inspection, reportChecksum, ...body } = preparedResult;
        body.reconciledPlaintextSha256 = readHash(alteredPath);
        assert.throws(() => verifyRecoveryKnownBuyout({ reviewOptions, reconciledDatabase: altered,
          reconciliation: { ...body, reportChecksum: hash(canonicalize(body)) } }),{ code: "RECOVERY_BUYOUT_DELTA_INVALID" });
      } finally { altered.close(); }
      assert.deepEqual(sources.map(row => readHash(row.name)),originalHashes);
      for (const database of sources) assert.equal(database.prepare("SELECT total_changes() n").get().n,0);
    } finally { for (const database of sources) database.close(); }
  });
  assert.deepEqual(source.serialize(), sourceAfterKnownChanges);
  assert.equal(source.prepare("SELECT status FROM contracts WHERE id=?").get(contractId).status, "eliminated");
});

test("an exact restored auction rejects its previous worker and signs once with real roster callbacks", async t => {
  const { createTargetRepositories, createTargetServices } = require("../../src/bootstrap/createTargetRuntime");
  const { createSqliteAuctionResolutionRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository");
  const { createAuctionResolutionService } = require("../../src/application/services/auctions/createAuctionResolutionService");
  const { createResolveTargetAuctionsJob } = require("../../src/jobs/definitions/resolveTargetAuctions");
  const { buildAuctionResolutionOccurrenceKey } = require("../../src/domain/auctions/auctionResolutionPolicy");
  const { REPOSITORY_ERROR_CODES } = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");
  let auction, bid, occurrence, oldClaim, now;
  const oldOwner = "synthetic-before-auction-recovery", secureRandom = createSecureRandom();
  const { started, input, config, backup } = await candidate(t, database => {
    auction = database.prepare("SELECT * FROM auctions WHERE id=?").get(fixtureId("auction:leagueA"));
    bid = database.prepare("SELECT * FROM auction_bids WHERE auction_id=?").get(auction.id);
    // Complete this synthetic fixture's original submission history. The base
    // read-view fixture predates its manager membership and has no bid event.
    // Keep the persisted auction deadline and offered price/term unchanged.
    const assignment = database.prepare("SELECT * FROM team_manager_assignments WHERE league_id=? AND team_id=? " +
      "AND user_id=? AND status='accepted'").get(auction.league_id, bid.team_id, bid.submitted_by_user_id);
    const submittedAtMs = assignment.accepted_at_ms + 1;
    assert.ok(submittedAtMs > auction.opened_at_ms && submittedAtMs < auction.resolves_at_ms);
    database.prepare("UPDATE auction_bids SET first_submitted_at_ms=?,last_edited_at_ms=? WHERE id=?")
      .run(submittedAtMs, submittedAtMs, bid.id);
    bid = database.prepare("SELECT * FROM auction_bids WHERE id=?").get(bid.id);
    database.prepare("INSERT INTO auction_events(id,league_id,season_id,auction_id,bid_id,team_id,actor_user_id,event_type,metadata_json,occurred_at_ms) " +
      "VALUES(?,?,?,?,?,?,?,'bid_submitted',?,?)").run(crypto.randomUUID(), auction.league_id, auction.season_id, auction.id,
      bid.id, bid.team_id, bid.submitted_by_user_id, JSON.stringify({ actorMembershipId: assignment.membership_id,
        actorAuthority: "manager", before: null, after: { totalValueCents: 900,termYears: 3,aavCents: 300,
          lowestOfferedAavCents: 300,lowestOfferedTotalValueCents: 900,editCount: 0,version: 1 } }), submittedAtMs);
    const repositories = createTargetRepositories({ database, secureRandom });
    now = auction.resolves_at_ms + 1000;
    occurrence = repositories.auctionResolutions.listDue({ nowMs: now,limit: 100 }).find(row => row.auctionId === auction.id);
    assert.ok(occurrence); assert.equal(occurrence.dueAtMs, auction.resolves_at_ms);
    const candidate = repositories.auctionResolutions.loadCandidate({ leagueId: auction.league_id,auctionId: auction.id,nowMs: now });
    assert.equal(candidate.bids.length, 1); assert.equal(candidate.bids[0].authorityValid, true);
    oldClaim = repositories.auctionResolutions.claimRun({ jobRunId: crypto.randomUUID(), leagueId: auction.league_id,
      seasonId: auction.season_id, occurrenceKey: buildAuctionResolutionOccurrenceKey({ auctionId: auction.id,dueAtMs: occurrence.dueAtMs }),
      scheduledForMs: occurrence.dueAtMs,leaseOwner: oldOwner,nowMs: now - 1000,leaseExpiresAtMs: now + 60_000 });
    assert.equal(oldClaim.acquired, true);
  });
  const occurrenceKey = buildAuctionResolutionOccurrenceKey({ auctionId: auction.id,dueAtMs: occurrence.dueAtMs });
  const sourceBytes = started.runtime.database.serialize(), restoredHash = readHash(input.restoredCandidate.targetDatabasePath);
  const prepared = prepareRecoveryCredentials({ ...input,preparedAtMs: now,
    outputDirectory: path.join(input.temporaryRoot,"auction-preparation") });
  const preparedHash = readHash(prepared.preparedDatabasePath), workPath = path.join(input.temporaryRoot,"auction-work.sqlite3");
  fs.copyFileSync(prepared.preparedDatabasePath, workPath, fs.constants.COPYFILE_EXCL);
  const open = () => openDatabase({ databasePath: workPath,environment: "test" }).database;
  const summerCalls = [], lateLockCalls = [], completions = [], completionCommands = [], errors = [], providerCalls = [];
  function worker(database, previousWorker = false) {
    const clock = { nowMs: () => now }, logger = { error: value => errors.push(value),warn: value => errors.push(value),info() {} };
    const repositories = createTargetRepositories({ database,secureRandom });
    const services = createTargetServices({ repositories,currentSeason: { label: "2026",nhlSeasonKey: "20262027" },
      securityFoundations: { config: started.runtime.securityConfig,clock,secureRandom,logger },
      leagueInvalidationPublisher: { publish() { assert.fail("Held auction messages must remain unpublished."); } },
      nhlFetchImplementation: async () => { providerCalls.push(true);throw new Error("Fixture provider is unavailable."); } });
    // These wrappers observe the production implementations; neither callback
    // is replaced by a success/no-op stub. No runtime or scheduler is started.
    const repository = createSqliteAuctionResolutionRepository({ database,candidateCardSummerSynchronizer: {
      synchronize(command) {
        const inTransaction = database.inTransaction;
        const result = repositories.candidateCardSummerSynchronizer.synchronize(command);
        summerCalls.push({ command,inTransaction,result }); return result;
      },
    } });
    const service = createAuctionResolutionService({ repository: { ...repository,
      completeClaimedDue(command) { const result = repository.completeClaimedDue(command); completionCommands.push(command); return result; },
    },secureRandom,lateLockCoordinator: {
      async coordinateCommittedRoster(command) {
        const inTransaction = database.inTransaction;
        const result = await services.league.lateLockCoordinator.coordinateCommittedRoster(command);
        lateLockCalls.push({ command,inTransaction,result }); return result;
      },
    } });
    return createResolveTargetAuctionsJob({ repository: { ...repository,
      listDue(query) { return repository.listDue({ ...query,limit: 100 }).filter(row => row.auctionId === auction.id); },
      ...(previousWorker ? { claimRun() { return oldClaim; } } : {}),
    },resolutionService: { async resolveClaimedDue(command) {
      const result = await service.resolveClaimedDue(command);completions.push(result);return result;
    } },clock,secureRandom,leaseOwner: previousWorker ? oldOwner : "synthetic-after-auction-recovery",logger });
  }
  let database = open();
  try {
    const before = allRows(database), beforeBytes = database.serialize();
    const restoredJob = database.prepare("SELECT * FROM job_runs WHERE id=?").get(oldClaim.runId);
    assert.equal(restoredJob.status, "leased"); assert.equal(restoredJob.lease_owner, null);
    assert.equal(restoredJob.lease_expires_at_ms, now); assert.equal(restoredJob.version, oldClaim.version + 1);
    const stale = await worker(database,true).run();
    assert.equal(stale.status, "succeeded"); assert.equal(stale.completed, 0); assert.equal(stale.skipped, 1);
    assert.equal(stale.failed, 0); assert.deepEqual(database.serialize(), beforeBytes);
    assert.deepEqual(summerCalls, []); assert.deepEqual(lateLockCalls, []); assert.deepEqual(completions, []);
    assert.equal(database.prepare("SELECT total_changes() n").get().n, 0);
    const result = await worker(database).run();
    assert.equal(result.status, "succeeded", JSON.stringify(errors)); assert.equal(result.due, 1);
    assert.equal(result.acquired, 1); assert.equal(result.completed, 1); assert.equal(result.failed, 0); assert.equal(result.skipped, 0);
    assert.equal(completions.length, 1); assert.equal(completions[0].status, "resolved");
    assert.equal(summerCalls.length, 1); assert.equal(lateLockCalls.length, 1);
    assert.equal(summerCalls[0].inTransaction, true); assert.equal(lateLockCalls[0].inTransaction, false);
    assert.equal(summerCalls[0].result.affectedCardCount, 0); assert.equal(summerCalls[0].result.changedCardCount, 0);
    assert.deepEqual(completions[0].lateLock, { status: "not_applicable" });
    assert.deepEqual(errors, []); assert.deepEqual(providerCalls, []);
    const after = allRows(database);
    const updatedTables = new Map([["auctions",auction.id],["auction_bids",bid.id],["job_runs",oldClaim.runId]]);
    const addedCounts = { contracts: 1,contract_years: 3,contract_events: 1,player_ownerships: 1,
      ownership_events: 1,auction_events: 1,auction_resolutions: 1,league_activity: 1,outbox_events: 1,outbox_event_audiences: 1 };
    for (const [table,rows] of Object.entries(before)) {
      if (!updatedTables.has(table) && !Object.hasOwn(addedCounts,table)) assert.deepEqual(after[table],rows,table);
      if (updatedTables.has(table)) assert.deepEqual(after[table].filter(row => JSON.parse(row).id !== updatedTables.get(table)),
        rows.filter(row => JSON.parse(row).id !== updatedTables.get(table)),table);
    }
    const additions = {};
    for (const [table,count] of Object.entries(addedCounts)) {
      const oldIds = new Set(before[table].map(row => JSON.parse(row).id));
      assert.deepEqual(after[table].filter(row => oldIds.has(JSON.parse(row).id)),before[table],table);
      additions[table] = after[table].map(JSON.parse).filter(row => !oldIds.has(row.id));
      assert.equal(additions[table].length,count,table);
      assert.ok(additions[table].every(row => row.league_id === auction.league_id),table);
    }
    const resolution = additions.auction_resolutions[0], contract = additions.contracts[0], ownership = additions.player_ownerships[0];
    assert.equal(resolution.outcome_code, "winner"); assert.equal(resolution.winning_bid_id,bid.id);
    assert.equal(resolution.winning_team_id,bid.team_id); assert.equal(resolution.scheduled_occurrence_key,occurrenceKey);
    assert.equal(resolution.highest_bid_cents,900); assert.equal(resolution.winning_term_years,3);
    assert.equal(resolution.contract_id,contract.id); assert.equal(resolution.ownership_id,ownership.id);
    assert.equal(resolution.resolved_at_ms,now); assert.equal(resolution.status,"resolved");
    assert.equal(resolution.final_contract_value_cents,900); assert.equal(resolution.final_aav_cents,300);
    assert.equal(contract.player_id,auction.player_id); assert.equal(contract.current_team_id,bid.team_id);
    assert.equal(contract.original_total_value_cents,900); assert.equal(contract.original_term_years,3);
    assert.equal(contract.aav_cents,300); assert.equal(contract.acquisition_source_id,resolution.id);
    assert.deepEqual(additions.contract_years.map(row => row.year_number).sort(),[1,2,3]);
    assert.ok(additions.contract_years.every(row => row.contract_id === contract.id && row.aav_cents === 300 && row.created_at_ms === now));
    assert.equal(additions.contract_years.filter(row => row.status === "current").length,1);
    assert.equal(additions.contract_years.filter(row => row.status === "future").length,2);
    assert.equal(ownership.player_id,auction.player_id); assert.equal(ownership.team_id,bid.team_id);
    assert.equal(ownership.roster_category,"Active"); assert.equal(ownership.acquired_transaction_id,resolution.id);
    // The real completion preserves the normal overfull-roster warning.
    // Recovery neither invents a slot nor silently repairs the manager's team.
    assert.equal(ownership.slot_number,null); assert.equal(resolution.general_illegal,1);
    assert.deepEqual(summerCalls[0].command, { leagueId: auction.league_id,affectedTeamIds: [bid.team_id],
      affectedPlayerIds: [auction.player_id],sourceOperationId: resolution.id,sourceKind: "auction_allocation",nowMs: now });
    assert.equal(lateLockCalls[0].command.mutationKind,"auction_resolution");
    assert.equal(lateLockCalls[0].command.teams[0].teamId,bid.team_id);
    assert.equal(additions.contract_events[0].contract_id,contract.id);
    assert.equal(additions.ownership_events[0].ownership_id,ownership.id);
    assert.equal(additions.auction_events[0].event_type,"auction_resolved");
    assert.equal(additions.league_activity[0].event_type,"auction_signing_completed");
    assert.equal(additions.league_activity[0].related_id,resolution.id);
    const message = additions.outbox_events[0];
    assert.equal(message.event_type,"auction.changed"); assert.equal(message.aggregate_id,auction.id);
    assert.equal(message.status,"pending"); assert.equal(message.published_at_ms,null); assert.equal(message.attempt_count,0);
    assert.deepEqual(additions.outbox_event_audiences[0], { id: message.id,outbox_event_id: message.id,
      league_id: auction.league_id,audience_kind: "league",team_id: null,user_id: null,created_at_ms: now });
    assert.deepEqual(database.prepare("SELECT * FROM auctions WHERE id=?").get(auction.id),
      { ...auction,status: "resolved",updated_at_ms: now,version: auction.version + 1 });
    assert.deepEqual(database.prepare("SELECT * FROM auction_bids WHERE id=?").get(bid.id), { ...bid,status: "won",version: bid.version + 1 });
    const job = database.prepare("SELECT * FROM job_runs WHERE id=?").get(oldClaim.runId);
    assert.equal(job.status,"succeeded"); assert.equal(job.attempt_count,oldClaim.attemptCount + 1);
    assert.equal(job.version,oldClaim.version + 3); assert.equal(job.lease_owner,null); assert.equal(job.lease_expires_at_ms,null);
    assert.equal(job.completed_at_ms,now);
    assert.deepEqual(job,{ ...restoredJob,status: "succeeded",attempt_count: oldClaim.attemptCount + 1,
      lease_owner: null,lease_expires_at_ms: null,started_at_ms: now,completed_at_ms: now,
      result_json: JSON.stringify({ auctionId: auction.id,outcome: "resolved" }),last_error_code: null,
      updated_at_ms: now,version: oldClaim.version + 3 });
    assert.ok(database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY));
    assert.deepEqual(readRecoveryEpoch(database),prepared.recoveryEpoch); assertCredentialAccess(database,false);
    assert.throws(() => createTargetRuntime({ database,migrationsDirectory: path.resolve(__dirname,"../../database/migrations") }),
      { code: "DATABASE_RECOVERY_HELD" });
    const completedBytes = database.serialize();
    assert.throws(() => createTargetRepositories({ database,secureRandom }).auctionResolutions.succeedRun({ leagueId: auction.league_id,
      runId: oldClaim.runId,leaseOwner: oldOwner,expectedVersion: oldClaim.version,completedAtMs: now,
      auctionId: auction.id,outcome: "resolved" }), { code: REPOSITORY_ERROR_CODES.versionConflict });
    assert.deepEqual(database.serialize(),completedBytes);
    assert.deepEqual(database.pragma("foreign_key_check"),[]); assert.deepEqual(database.pragma("integrity_check"),[{ integrity_check: "ok" }]);
    database.close(); database = open();
    const restartBytes = database.serialize(), restarted = await worker(database).run();
    assert.equal(restarted.status,"succeeded"); assert.equal(restarted.due,0); assert.equal(restarted.completed,0);
    assert.deepEqual(database.serialize(),restartBytes); assert.deepEqual(allRows(database),after);
    assert.equal(database.prepare("SELECT total_changes() n").get().n,0);
    assert.equal(summerCalls.length,1); assert.equal(lateLockCalls.length,1); assert.equal(completions.length,1);
  } finally { if (database.open) database.close(); }
  assert.equal(readHash(prepared.preparedDatabasePath),preparedHash);
  assert.equal(readHash(input.restoredCandidate.targetDatabasePath),restoredHash);
  assert.deepEqual(started.runtime.database.serialize(),sourceBytes);
  const { buildRecoveryAuctionReview } = require("../../src/operations/backups/buildRecoveryAuctionReview");
  let auctionReviewPaths, auctionReviewPlan;
  await t.test("the read-only auction review command binds actual copies and rejects forged context", async reviewTest => {
    const directory = path.join(input.temporaryRoot,"auction-review-command"); fs.mkdirSync(directory);
    const candidatePath = path.join(directory,"prepared-review.sqlite3");
    fs.copyFileSync(prepared.preparedDatabasePath,candidatePath,fs.constants.COPYFILE_EXCL);
    const restoredPath = path.join(directory,"restored-review.sqlite3");
    fs.copyFileSync(input.restoredCandidate.targetDatabasePath,restoredPath,fs.constants.COPYFILE_EXCL);
    const preserved = await createVerifiedBackup({ databasePath: started.databasePath,
      outputDirectory: path.join(directory,"preserved"),environment: config.appEnv,
      reason: "incident-preservation",capturedAtMs: Date.now(),temporaryRoot: input.temporaryRoot });
    const preservedPath = path.join(preserved.outputDirectory,BACKUP_FILE_NAME);
    const files = [candidatePath,restoredPath,preservedPath], hashes = files.map(readHash);
    const credentialsPath = path.join(directory,"credentials.json"), candidateReviewPath = path.join(directory,"candidate-review.json");
    fs.writeFileSync(credentialsPath,JSON.stringify(prepared),{ flag: "wx" });
    const candidateRequestPath = path.join(directory,"candidate-request.json");
    fs.writeFileSync(candidateRequestPath,JSON.stringify({ requestVersion: 1,expectedEnvironmentId: config.environmentId,
      expectedDatabaseId: config.databaseId,observedAtMs: now,preparedDatabasePath: candidatePath,credentialPreparationPath: credentialsPath }),{ flag: "wx" });
    const candidateCommand = spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-review.js"),"--request",candidateRequestPath],
      { encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
    assert.equal(candidateCommand.status,0,candidateCommand.stderr); assert.equal(candidateCommand.stderr,"");
    const candidateReview = JSON.parse(candidateCommand.stdout); auctionReviewPlan = candidateReview.plan;
    fs.writeFileSync(candidateReviewPath,candidateCommand.stdout,{ flag: "wx" });
    const request = { requestVersion: 1,credentialPreparationPath: credentialsPath,candidateReviewPath,
      preparedDatabasePath: candidatePath,restoredDatabasePath: restoredPath,preservedDatabasePath: preservedPath,
      preservedPlaintextSha256: preserved.plaintextSha256,jobId: oldClaim.runId,auctionId: auction.id,leagueId: auction.league_id,observedAtMs: now };
    let sequence = 0;
    function invoke(value, passes = true) {
      const requestPath = path.join(directory,`request-${sequence++}.json`);fs.writeFileSync(requestPath,JSON.stringify(value),{ flag: "wx" });
      const child = spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-auction-review.js"),"--request",requestPath],
        { encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
      if (passes) { assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,"");return JSON.parse(child.stdout); }
      assert.equal(child.status,1,child.stderr);assert.equal(child.stdout,"");
      assert.match(JSON.parse(child.stderr).error.code,/^RECOVERY_AUCTION_REVIEW_/);
      assert.equal(child.stderr.includes(PRIVATE_VALUE),false);
    }
    let commandSequence = 0;
    function recoveryCommand(script,value,passes = true) {
      const commandPath = path.join(directory,`auction-command-${commandSequence++}.json`);
      fs.writeFileSync(commandPath,JSON.stringify(value),{ flag: "wx" });
      const child = spawnSync(process.execPath,[path.resolve(__dirname,`../../scripts/${script}`),"--request",commandPath],
        { encoding: "utf8",timeout: 90_000,maxBuffer: 16*1024*1024 });
      if (passes) { assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,"");return JSON.parse(child.stdout); }
      assert.equal(child.status,1,child.stderr);assert.equal(child.stdout,"");
      assert.match(JSON.parse(child.stderr).error.code,/^RECOVERY_/);assert.equal(child.stderr.includes(PRIVATE_VALUE),false);
    }
    function saveAuctionJson(name,value) {
      const file = path.join(directory,name);fs.writeFileSync(file,JSON.stringify(value),{ flag: "wx" });return file;
    }
    const reviewed = invoke(request);
    assert.equal(reviewed.status,"auction-recovery-reviewed-held"); assert.equal(reviewed.auctionId,auction.id);
    assert.equal(reviewed.jobId,oldClaim.runId); assert.equal(reviewed.planChecksum,auctionReviewPlan.planChecksum);
    assert.equal(reviewed.contextEvidence.preparedSnapshotSha256,auctionReviewPlan.snapshotSha256);
    assert.equal(reviewed.contextSha256,hash(canonicalize(reviewed.contextEvidence)));
    assert.equal(reviewed.originalDeadlineAtMs,auction.resolves_at_ms); assert.equal(reviewed.dueAtMs,occurrence.dueAtMs);
    assert.equal(reviewed.contextEvidence.candidateState.auction.rowSha256,hash(canonicalize(auction)));
    assert.equal(reviewed.contextEvidence.candidateState.bids[0].rowSha256,hash(canonicalize(bid)));
    assert.deepEqual(reviewed.bidAuthority,[{ bidId: bid.id,historicalAuthorityValid: true }]);
    assert.equal(reviewed.pricingPreview.decision.outcome,"winner");
    assert.equal(reviewed.pricingPreview.decision.winner.finalTotalValueCents,900);
    assert.equal(reviewed.pricingPreview.completionEligibilityVerified,false);
    assert.deepEqual(reviewed.contextEvidence.callbacks,{ openCandidateCardsInLeague: 0,liveMatchupWeeksInLeague: 0,effectsEvaluated: false });
    assert.equal(reviewed.lossWindow.changedRecords,0); assert.deepEqual(reviewed.restoredState,reviewed.preservedState);
    assert.equal(reviewed.lossWindowReportChecksum,reviewed.lossWindow.reportChecksum);
    assert.equal(reviewed.requiredReview,"league-rules-loss-window-and-domain-effects");
    for (const field of ["operatorAuthenticated","replayPermitted","completeLossWindowEvidence","activationReady","executable"]) assert.equal(reviewed[field],false);
    const { reportChecksum,...body } = reviewed; assert.equal(hash(canonicalize(body)),reportChecksum);
    assert.equal(JSON.stringify(reviewed).includes(PRIVATE_VALUE),false);
    for (const change of [{ mode: "execute" },{ requestVersion: 2 },{ observedAtMs: now - 1 },
      { leagueId: fixtureId("league:leagueB") },{ jobId: crypto.randomUUID() },{ auctionId: fixtureId("auction:leagueB") },
      { preservedPlaintextSha256: "0".repeat(64) },{ preservedDatabasePath: restoredPath,preservedPlaintextSha256: restoredHash }]) {
      invoke({ ...request,...change },false);
    }
    const forgedCandidate = { ...candidateReview,plan: { ...candidateReview.plan,unresolvedJobs: candidateReview.plan.unresolvedJobs - 1 } };
    const { reportChecksum: oldChecksum,...forgedBody } = forgedCandidate;
    forgedCandidate.reportChecksum = hash(canonicalize(forgedBody));
    const forgedPath = path.join(directory,"forged-candidate.json");fs.writeFileSync(forgedPath,JSON.stringify(forgedCandidate),{ flag: "wx" });
    invoke({ ...request,candidateReviewPath: forgedPath },false);
    const readers = files.map(databasePath => openReadonlyDatabase({ databasePath }));
    try {
      const options = { preparedDatabase: readers[0],restoredDatabase: readers[1],preservedDatabase: readers[2],
        credentialPreparation: prepared,plan: auctionReviewPlan,jobId: oldClaim.runId,auctionId: auction.id,
        leagueId: auction.league_id,preservedPlaintextSha256: preserved.plaintextSha256,observedAtMs: now };
      assert.deepEqual(buildRecoveryAuctionReview(options),reviewed);
      await reviewTest.test("independent auction evidence verifies the real domain delta and rejects altered output", async () => {
        const { expectedRecoveryAuctionDelta, verifyRecoveryAuctionDelta } = require("../../src/operations/backups/recoveryAuctionDeltaEvidence");
        assert.equal(completionCommands.length,1);
        const command = completionCommands[0];
        const identifiers = Object.fromEntries(["activityId","auctionEventId","contractEventId","contractId","contractYearIds",
          "futureSeasonIds","outboxEventId","ownershipEventId","ownershipId","resolutionId"].map(key => [key,command[key]]));
        const evidence = expectedRecoveryAuctionDelta({ reviewOptions: options,identifiers });
        const { createSqliteCapReadRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteCapReadRepository");
        const previousCap = createSqliteCapReadRepository({ database: readers[0] }).calculate({ leagueId: auction.league_id,seasonId: auction.season_id,teamId: bid.team_id });
        assert.equal(evidence.completedJob.status,"succeeded");assert.equal(evidence.cap.capUsageCents,previousCap.capUsageCents + 300);
        assert.deepEqual(evidence.expectedCallbacks,{ candidateCardsAffected: 0,candidateCardsChanged: 0,lateLockStatus: "not_applicable" });
        const completedReader = openReadonlyDatabase({ databasePath: workPath });
        const completedHash = readHash(workPath);
        try {
          const differences = [];
          for (const [table,rows] of Object.entries(evidence.expected)) {
            const actual = completedReader.prepare(`SELECT * FROM "${table}"`).all();
            if (actual.length !== rows.length) differences.push({ table,count: true });
            for (const row of rows) {
              const observed = actual.find(item => row.id ? item.id === row.id : canonicalize(item) === canonicalize(row));
              if (!observed) { differences.push({ table,missing: true });continue; }
              const columns = [...new Set([...Object.keys(row),...Object.keys(observed)])].filter(key => canonicalize(row[key]) !== canonicalize(observed[key]));
              if (columns.length) differences.push({ table,columns });
            }
          }
          assert.deepEqual(differences,[]);
          const verified = verifyRecoveryAuctionDelta({ reviewOptions: options,identifiers,completedDatabase: completedReader });
          assert.equal(verified.status,"auction-domain-delta-verified-held");assert.equal(verified.reviewChecksum,reviewed.reportChecksum);
          assert.equal(verified.completedPlaintextSha256,completedHash);assert.equal(verified.createdPendingMessages,1);
          for (const field of ["callbackExecutionVerified","operatorAuthenticated","completeLossWindowEvidence","leaseElapsedVerified","activationReady","executable"]) assert.equal(verified[field],false);
          const { reportChecksum,...body } = verified;assert.equal(reportChecksum,hash(canonicalize(body)));
          assert.equal(JSON.stringify(verified).includes(PRIVATE_VALUE),false);
          assert.equal(completedReader.prepare("SELECT total_changes() n").get().n,0);
          assert.throws(() => verifyRecoveryAuctionDelta({ reviewOptions: options,identifiers,completedDatabase: readers[0] }),
            { code: "RECOVERY_AUCTION_DELTA_OUTPUT_INVALID" });
          for (const invalid of [{ ...identifiers,force: true },{ ...identifiers,contractId: identifiers.ownershipId },
            { ...identifiers,contractYearIds: identifiers.contractYearIds.slice(0,2) },{ ...identifiers,resolutionId: auction.id }]) {
            assert.throws(() => expectedRecoveryAuctionDelta({ reviewOptions: options,identifiers: invalid }),
              { code: "RECOVERY_AUCTION_DELTA_IDS_INVALID" });
          }
        } finally { completedReader.close(); }
        const mutations = [
          ["contract value","UPDATE contracts SET original_total_value_cents=original_total_value_cents+300,aav_cents=aav_cents+100 WHERE id=?",identifiers.contractId],
          ["year charge","UPDATE contract_years SET aav_cents=aav_cents+100 WHERE id=?",identifiers.contractYearIds[0]],
          ["ownership version","UPDATE player_ownerships SET version=version+1 WHERE id=?",identifiers.ownershipId],
          ["winning bid","UPDATE auction_bids SET version=version+1 WHERE id=?",bid.id],
          ["resolution warning","UPDATE auction_resolutions SET warnings_json='[]' WHERE id=?",identifiers.resolutionId],
          ["contract event","UPDATE contract_events SET reason='altered' WHERE id=?",identifiers.contractEventId],
          ["ownership event","UPDATE ownership_events SET reason='altered' WHERE id=?",identifiers.ownershipEventId],
          ["auction event","UPDATE auction_events SET metadata_json='{}' WHERE id=?",identifiers.auctionEventId],
          ["activity history","UPDATE league_activity SET reason='altered' WHERE id=?",identifiers.activityId],
          ["job attempt","UPDATE job_runs SET attempt_count=attempt_count+1 WHERE id=?",oldClaim.runId],
          ["pending delivery","UPDATE outbox_events SET attempt_count=attempt_count+1 WHERE id=?",identifiers.outboxEventId],
          ["audience timestamp","UPDATE outbox_event_audiences SET created_at_ms=created_at_ms+1 WHERE id=?",identifiers.outboxEventId],
          ["recovery hold","UPDATE application_metadata SET metadata_value='{}' WHERE metadata_key=?",RECOVERY_HOLD_KEY],
          ["credential preservation","UPDATE users SET updated_at_ms=updated_at_ms+1 WHERE id=?",fixtureId("account:platformAdmin")],
          ["other league","UPDATE auctions SET version=version+1 WHERE id=?",fixtureId("auction:leagueB")],
        ];
        for (const [index,[label,sql,id]] of mutations.entries()) {
          const alteredPath = path.join(directory,`altered-auction-${index}.sqlite3`);
          fs.copyFileSync(workPath,alteredPath,fs.constants.COPYFILE_EXCL);
          const writer = openDatabase({ databasePath: alteredPath,environment: "test" }).database;
          try { assert.equal(writer.prepare(sql).run(id).changes,1,label); }
          catch (error) { throw new Error(`Altered ${label} fixture failed: ${error.code || error.name}`); }
          finally { writer.close(); }
          const alteredReader = openReadonlyDatabase({ databasePath: alteredPath });
          const alteredHash = readHash(alteredPath);
          try {
            assert.throws(() => verifyRecoveryAuctionDelta({ reviewOptions: options,identifiers,completedDatabase: alteredReader }),
              { code: "RECOVERY_AUCTION_DELTA_MISMATCH" },label);
            assert.equal(alteredReader.prepare("SELECT total_changes() n").get().n,0,label);
          } finally { alteredReader.close(); }
          assert.equal(readHash(alteredPath),alteredHash,label);
        }
        assert.equal(readHash(workPath),completedHash);
        assert.deepEqual(files.map(readHash),hashes);
        assert.deepEqual(started.runtime.database.serialize(),sourceBytes);
      });
      await reviewTest.test("the attributed auction action verifies real callbacks and leaves a complete held receipt", async actionTest => {
        const { prepareRecoveryAuctionReconciliation } = require("../../src/operations/backups/prepareRecoveryAuctionReconciliation");
        const { expectedRecoveryAuctionDelta, snapshots } = require("../../src/operations/backups/recoveryAuctionDeltaEvidence");
        const { buildRecoveryAuctionAttribution } = require("../../src/operations/backups/recoveryAuctionReconciliationEvidence");
        const { verifyRecoveryAuctionReconciliation } = require("../../src/operations/backups/verifyRecoveryAuctionReconciliation");
        const decision = { action: "resolve-ordinary-auction-held",reconciliationId: crypto.randomUUID(),
          reviewedByUserId: fixtureId("account:platformAdmin"),reasonCode: "REVIEWED_AUCTION_DEADLINE_AND_LOSS_WINDOW",
          evidenceSha256: hash("synthetic auction administrator review"),reviewChecksum: reviewed.reportChecksum };
        const outputDirectory = path.join(directory,"attributed-auction");
        const actionOptions = { reviewOptions: options,decision,temporaryRoot: input.temporaryRoot,outputDirectory };
        const report = await prepareRecoveryAuctionReconciliation(actionOptions);
        const receiptPath = path.join(outputDirectory,"auction-reconciliation.json"), outputHash = readHash(report.reconciledDatabasePath);
        const receiptHash = readHash(receiptPath), receipt = JSON.parse(fs.readFileSync(receiptPath,"utf8"));
        const { reconciledDatabasePath,inspection,...body } = report;assert.deepEqual(body,receipt);
        const { reportChecksum,...signedBody } = receipt;assert.equal(reportChecksum,hash(canonicalize(signedBody)));
        assert.equal(report.status,"auction-reconciled-held");assert.equal(report.reconciledPlaintextSha256,outputHash);
        assert.equal(report.unresolvedJobs,auctionReviewPlan.unresolvedJobs - 1);
        assert.equal(report.unresolvedMessages,auctionReviewPlan.unresolvedMessages + 1);
        assert.deepEqual(report.decision,decision);assert.deepEqual(report.review,reviewed);
        for (const field of ["callbackExecutionVerified","leaseElapsedVerified","restartVerified"]) assert.equal(report[field],true);
        for (const field of ["operatorAuthenticated","completeLossWindowEvidence","activationReady","executable"]) assert.equal(report[field],false);
        assert.equal(report.execution.callbacks.summer.length,1);assert.equal(report.execution.callbacks.lateLock.length,1);
        assert.equal(report.execution.callbacks.summer[0].inTransaction,true);assert.equal(report.execution.callbacks.lateLock[0].inTransaction,false);
        assert.equal(report.execution.callbacks.summer[0].result.affectedCardCount,0);
        assert.deepEqual(report.execution.callbacks.lateLock[0].result,{ status: "not_applicable" });
        assert.equal(report.execution.callbacks.providerCalls,0);assert.equal(report.execution.callbacks.errors,0);
        assert.ok(report.execution.elapsedMs < report.execution.leaseDurationMs);
        assert.equal(report.execution.restartResult.due,0);assert.equal(report.execution.restartResult.completed,0);
        assert.equal(JSON.stringify(report).includes(PRIVATE_VALUE),false);
        const expected = expectedRecoveryAuctionDelta({ reviewOptions: options,identifiers: report.identifiers });
        const attribution = buildRecoveryAuctionAttribution({ evidence: expected,decision,execution: report.execution });
        const output = openReadonlyDatabase({ databasePath: report.reconciledDatabasePath });
        try {
          assert.deepEqual(report.tableSnapshots,snapshots(attribution.expected));
          const actualRows = allRows(output);
          for (const [table,rows] of Object.entries(attribution.expected)) assert.deepEqual(actualRows[table],rows.map(canonicalize).sort(),table);
          assert.deepEqual(output.prepare("SELECT * FROM security_audit_events WHERE id=?").get(decision.reconciliationId),attribution.audit);
          assert.deepEqual(output.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(attribution.metadata.metadata_key),attribution.metadata);
          assert.ok(output.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY));
          assert.deepEqual(readRecoveryEpoch(output),prepared.recoveryEpoch);assertCredentialAccess(output,false);
          assert.equal(output.prepare("SELECT * FROM outbox_events WHERE id=?").get(report.createdOutboxId).status,"pending");
          assert.equal(output.prepare("SELECT total_changes() n").get().n,0);
          assert.throws(() => createTargetRuntime({ database: output,migrationsDirectory: path.resolve(__dirname,"../../database/migrations") }),{ code: "DATABASE_RECOVERY_HELD" });
          const verified = verifyRecoveryAuctionReconciliation({ reviewOptions: options,reconciledDatabase: output,reconciliation: receipt });
          assert.equal(verified.status,"auction-reconciliation-verified-held");assert.equal(verified.reconciliationChecksum,receipt.reportChecksum);
          assert.equal(verified.unresolvedJobs,report.unresolvedJobs);assert.equal(verified.unresolvedMessages,report.unresolvedMessages);
          assert.deepEqual(verified.tableSnapshots,report.tableSnapshots);assert.equal(verified.operatorAuthenticated,false);
          assert.equal(verified.activationReady,false);assert.equal(verified.executable,false);
          assert.equal(JSON.stringify(verified).includes(PRIVATE_VALUE),false);
          const resign = change => { const { reportChecksum,...body } = { ...receipt,...change };return { ...body,reportChecksum: hash(canonicalize(body)) }; };
          for (const change of [{ activationReady: true },{ unresolvedJobs: report.unresolvedJobs - 1 },
            { domainSnapshotSha256: "0".repeat(64) },{ decisionChecksum: "0".repeat(64) }]) {
            assert.throws(() => verifyRecoveryAuctionReconciliation({ reviewOptions: options,reconciledDatabase: output,reconciliation: resign(change) }),
              { code: "RECOVERY_AUCTION_RECEIPT_INVALID" });
          }
          assert.throws(() => verifyRecoveryAuctionReconciliation({ reviewOptions: options,reconciledDatabase: readers[0],
            reconciliation: resign({ reconciledPlaintextSha256: reviewed.preparedPlaintextSha256 }) }),{ code: "RECOVERY_AUCTION_RECEIPT_SOURCE_REUSED" });
          assert.equal(output.prepare("SELECT total_changes() n").get().n,0);
        } finally { output.close(); }
        const preservedFiles = [...files,report.reconciledDatabasePath,receiptPath], preservedHashes = preservedFiles.map(readHash);
        const attempts = [
          ["forged-review",{ decision: { ...decision,reviewChecksum: "0".repeat(64) } },"RECOVERY_AUCTION_DECISION_INVALID"],
          ["wrong-action",{ decision: { ...decision,action: "activate" } },"RECOVERY_AUCTION_DECISION_INVALID"],
          ["extra-decision",{ decision: { ...decision,force: true } },"RECOVERY_AUCTION_DECISION_INVALID"],
          ["wrong-reviewer",{ decision: { ...decision,reviewedByUserId: fixtureId("recovery-preparation:user") } },"RECOVERY_AUCTION_REVIEWER_INVALID"],
          ["extended-lease",{ leaseDurationMs: report.execution.leaseDurationMs + 1 },"RECOVERY_AUCTION_INPUT_INVALID"],
          ["expired-elapsed-lease",{ leaseDurationMs: 1 },"RECOVERY_AUCTION_EXECUTION_FAILED"],
          ["existing-output",{ outputDirectory },"RECOVERY_AUCTION_PATH_UNSAFE"],
          ["escaped-output",{ outputDirectory: path.join(path.dirname(input.temporaryRoot),"auction-escaped") },"RECOVERY_AUCTION_PATH_UNSAFE"],
          ["interrupted",{ beforeReceipt() { throw new Error("synthetic receipt interruption"); } },"RECOVERY_AUCTION_RECONCILIATION_FAILED"],
          ["unexpected-change",{ beforeReceipt(db) { db.prepare("UPDATE auctions SET version=version+1 WHERE id=?").run(fixtureId("auction:leagueB")); } },"RECOVERY_AUCTION_POSTCHECK_FAILED"],
        ];
        for (const [label,change,code] of attempts) {
          const target = change.outputDirectory || path.join(directory,`auction-action-${label}`);
          await assert.rejects(() => prepareRecoveryAuctionReconciliation({ ...actionOptions,outputDirectory: target,...change }),{ code },label);
          if (label !== "existing-output") assert.equal(fs.existsSync(target),false,label);
          assert.deepEqual(preservedFiles.map(readHash),preservedHashes,label);
        }
        // Bind a recorded timeout without sleeping through a five-minute lease.
        assert.throws(() => buildRecoveryAuctionAttribution({ evidence: expected,decision,
          execution: { ...report.execution,elapsedMs: report.execution.leaseDurationMs } }),{ code: "RECOVERY_AUCTION_EXECUTION_EVIDENCE_INVALID" });
        assert.throws(() => buildRecoveryAuctionAttribution({ evidence: expected,decision,
          execution: { ...report.execution,callbacks: { ...report.execution.callbacks,providerCalls: 1 } } }),{ code: "RECOVERY_AUCTION_EXECUTION_EVIDENCE_INVALID" });
        for (const [index,[table,sql,id,code]] of [
          ["contracts","UPDATE contracts SET original_total_value_cents=original_total_value_cents+300,aav_cents=aav_cents+100 WHERE id=?",report.identifiers.contractId,"RECOVERY_AUCTION_RECEIPT_DELTA_INVALID"],
          ["security_audit_events","UPDATE security_audit_events SET reason_code='changed' WHERE id=?",decision.reconciliationId,"RECOVERY_AUCTION_RECEIPT_DELTA_INVALID"],
          ["application_metadata","UPDATE application_metadata SET metadata_value='{}' WHERE metadata_key=?",attribution.metadata.metadata_key,"RECOVERY_AUCTION_RECEIPT_DELTA_INVALID"],
          ["schema","CREATE TABLE unexpected_recovery_table (id TEXT)",null,"RECOVERY_AUCTION_RECEIPT_SCHEMA_INVALID"],
        ].entries()) {
          const alteredPath = path.join(directory,`altered-receipt-output-${index}.sqlite3`);
          fs.copyFileSync(report.reconciledDatabasePath,alteredPath,fs.constants.COPYFILE_EXCL);
          const alteredWriter = openDatabase({ databasePath: alteredPath,environment: "test" }).database;
          try { if (id === null) alteredWriter.exec(sql);else assert.equal(alteredWriter.prepare(sql).run(id).changes,1,table); }
          finally { alteredWriter.close(); }
          const alteredReader = openReadonlyDatabase({ databasePath: alteredPath }), alteredHash = readHash(alteredPath);
          try {
            const { readRows } = require("../../src/operations/backups/recoveryAuctionDeltaEvidence");
            const { reportChecksum,...forgedBody } = { ...receipt,reconciledPlaintextSha256: alteredHash,tableSnapshots: snapshots(readRows(alteredReader)) };
            const forged = { ...forgedBody,reportChecksum: hash(canonicalize(forgedBody)) };
            assert.throws(() => verifyRecoveryAuctionReconciliation({ reviewOptions: options,reconciledDatabase: alteredReader,reconciliation: forged }),{ code },table);
            assert.equal(alteredReader.prepare("SELECT total_changes() n").get().n,0,table);
          } finally { alteredReader.close(); }
          assert.equal(readHash(alteredPath),alteredHash,table);
          assert.deepEqual(preservedFiles.map(readHash),preservedHashes,table);
        }
        await actionTest.test("actual auction commands advance only with complete history and keep their new notification held", async () => {
          const { buildAuctionReconciledRecoveryPlan } = require("../../src/operations/backups/buildAuctionReconciledRecoveryPlan");
          const cliDecisionPath = saveAuctionJson("command-auction-decision.json",{ ...decision,reconciliationId: crypto.randomUUID() });
          const cliOutput = path.join(directory,"command-auction-action");
          const cliRequest = { ...request,decisionPath: cliDecisionPath,temporaryRoot: input.temporaryRoot,outputDirectory: cliOutput };
          const cliReport = recoveryCommand("db-recovery-auction.js",cliRequest);
          assert.equal(cliReport.status,"auction-reconciled-held");assert.equal(cliReport.activationReady,false);
          const cliReceipt = JSON.parse(fs.readFileSync(path.join(cliOutput,"auction-reconciliation.json"),"utf8"));
          const cliSourceHash = readHash(cliReport.reconciledDatabasePath);
          const inspectionPath = path.join(directory,"command-auction-inspection.sqlite3");
          fs.copyFileSync(cliReport.reconciledDatabasePath,inspectionPath,fs.constants.COPYFILE_EXCL);
          const inspectionReader = openReadonlyDatabase({ databasePath: inspectionPath });
          let nextPlan, event, audiences;
          try {
            const planOptions = { preparedDatabase: readers[0],reconciledDatabase: inspectionReader,restoredDatabase: readers[1],preservedDatabase: readers[2],
              credentialPreparation: prepared,originalPlan: auctionReviewPlan,auctionReconciliation: cliReceipt,observedAtMs: now + 1 };
            nextPlan = buildAuctionReconciledRecoveryPlan(planOptions);
            assert.equal(nextPlan.planVersion,7);assert.equal(nextPlan.previousPlanChecksum,auctionReviewPlan.planChecksum);
            assert.equal(nextPlan.unresolvedJobs,auctionReviewPlan.unresolvedJobs - 1);assert.equal(nextPlan.unresolvedMessages,auctionReviewPlan.unresolvedMessages + 1);
            assert.equal(nextPlan.jobs.find(row => row.id === oldClaim.runId).disposition,"preserve-recorded-result");
            assert.equal(nextPlan.outbox.find(row => row.id === cliReport.createdOutboxId).disposition,"held-awaiting-delivery-evidence");
            assert.equal(nextPlan.activationReady,false);assert.equal(nextPlan.executable,false);
            assert.throws(() => buildAuctionReconciledRecoveryPlan({ ...planOptions,parentProof: {} }),{ code: "RECOVERY_AUCTION_RECEIPT_VERIFICATION_FAILED" });
            event = inspectionReader.prepare("SELECT * FROM outbox_events WHERE id=?").get(cliReport.createdOutboxId);
            audiences = inspectionReader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(event.id);
            assert.equal(inspectionReader.prepare("SELECT total_changes() n").get().n,0);
          } finally { inspectionReader.close(); }
          const auctionStep = { kind: "auction",reconciledDatabasePath: inspectionPath,receipt: cliReceipt,observedAtMs: now + 1,
            restoredDatabasePath: restoredPath,preservedDatabasePath: preservedPath };
          const history = { initialDatabasePath: candidatePath,initialPlan: auctionReviewPlan,steps: [auctionStep] };
          const historyPath = saveAuctionJson("command-auction-lineage.json",history);
          const nextCandidateRequest = { requestVersion: 1,credentialPreparationPath: credentialsPath,preparedDatabasePath: inspectionPath,
            expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,observedAtMs: now + 1,lineagePath: historyPath };
          const nextCandidate = recoveryCommand("db-recovery-review.js",nextCandidateRequest);
          assert.deepEqual(nextCandidate.plan,nextPlan);
          const nextCandidatePath = saveAuctionJson("command-auction-next-candidate.json",nextCandidate);
          const completionRequest = { requestVersion: 1,candidateDatabasePath: inspectionPath,restoredDatabasePath: restoredPath,
            preservedDatabasePath: preservedPath,credentialPreparationPath: credentialsPath,candidateReviewPath: nextCandidatePath,
            preservedPlaintextSha256: readHash(preservedPath),expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,
            observedAtMs: now + 1,lineagePath: historyPath };
          const completion = recoveryCommand("db-recovery-completion-review.js",completionRequest);
          assert.equal(completion.planChecksum,nextPlan.planChecksum);assert.equal(completion.lineageVerified,true);
          assert.equal(completion.lossWindow.changedRecords,0);assert.equal(completion.candidateChanges.financialState.changedLeagues,1);
          const financial = completion.candidateChanges.financialState.leagues.find(row => row.leagueId === auction.league_id);
          const activeTotal = side => financial[side].contracts.find(row => row.status === "active");
          assert.equal(activeTotal("preserved").originalTotalValueCents-activeTotal("restored").originalTotalValueCents,900);
          assert.equal(activeTotal("preserved").aavCents-activeTotal("restored").aavCents,300);
          assert.equal(completion.dispositions.unresolvedJobs,nextPlan.unresolvedJobs);
          assert.equal(completion.dispositions.messages.some(row => row.id === cliReport.createdOutboxId),true);
          assert.equal(completion.activationReady,false);assert.equal(completion.completeFinancialReconciliation,false);
          const { lineagePath: completionHistory,...completionWithoutHistory } = completionRequest;
          recoveryCommand("db-recovery-completion-review.js",completionWithoutHistory,false);
          const { lineagePath: omitted,...missingHistory } = nextCandidateRequest;
          recoveryCommand("db-recovery-review.js",missingHistory,false);
          const { preservedDatabasePath: missing,...incompleteStep } = auctionStep;
          const incompletePath = saveAuctionJson("command-auction-incomplete-lineage.json",{ ...history,steps: [incompleteStep] });
          recoveryCommand("db-recovery-review.js",{ ...nextCandidateRequest,lineagePath: incompletePath },false);
          const reusedPath = saveAuctionJson("command-auction-reused-source-lineage.json",{ ...history,steps: [{ ...auctionStep,preservedDatabasePath: restoredPath }] });
          recoveryCommand("db-recovery-review.js",{ ...nextCandidateRequest,lineagePath: reusedPath },false);
          const rejectedPath = path.join(directory,"command-auction-repeated");
          recoveryCommand("db-recovery-auction.js",{ ...cliRequest,preparedDatabasePath: inspectionPath,candidateReviewPath: nextCandidatePath,
            observedAtMs: now + 1,lineagePath: historyPath,outputDirectory: rejectedPath },false);
          assert.equal(fs.existsSync(rejectedPath),false);
          recoveryCommand("db-recovery-auction.js",{ ...cliRequest,force: true,outputDirectory: rejectedPath },false);
          assert.equal(fs.existsSync(rejectedPath),false);
          const refreshReviewPath = saveAuctionJson("command-auction-refresh-review.json",{ events: [{ eventId: event.id,leagueId: event.league_id,
            rowSha256: hash(canonicalize(event)),payloadSha256: hash(event.payload_json),audienceSha256: hash(canonicalize(audiences.map(row => hash(canonicalize(row))).sort())),
            reasonCode: "RESTORED_REFRESH_REVIEWED",evidenceSha256: hash("synthetic newly created auction refresh review") }] });
          const refreshOutput = path.join(directory,"command-auction-refresh");
          const refresh = recoveryCommand("db-recovery-invalidations.js",{ requestVersion: 1,credentialPreparationPath: credentialsPath,
            preparedDatabasePath: cliReport.reconciledDatabasePath,candidateReviewPath: nextCandidatePath,lineagePath: historyPath,
            invalidationReviewPath: refreshReviewPath,reviewedByUserId: decision.reviewedByUserId,reconciliationId: crypto.randomUUID(),
            reconciledAtMs: now + 2,temporaryRoot: input.temporaryRoot,outputDirectory: refreshOutput });
          const refreshReceipt = JSON.parse(fs.readFileSync(path.join(refreshOutput,"invalidation-reconciliation.json"),"utf8"));
          const refreshInspection = path.join(directory,"command-auction-refresh-inspection.sqlite3");
          fs.copyFileSync(refresh.reconciledDatabasePath,refreshInspection,fs.constants.COPYFILE_EXCL);
          const combinedHistoryPath = saveAuctionJson("command-auction-refresh-lineage.json",{ ...history,steps: [...history.steps,
            { kind: "invalidation",reconciledDatabasePath: refreshInspection,receipt: refreshReceipt,observedAtMs: now + 3 }] });
          const combined = recoveryCommand("db-recovery-review.js",{ ...nextCandidateRequest,preparedDatabasePath: refreshInspection,
            observedAtMs: now + 3,lineagePath: combinedHistoryPath });
          assert.equal(combined.plan.unresolvedJobs,auctionReviewPlan.unresolvedJobs - 1);
          assert.equal(combined.plan.unresolvedMessages,auctionReviewPlan.unresolvedMessages);
          assert.equal(combined.plan.activationReady,false);assert.equal(combined.plan.executable,false);
          const combinedReviewPath = saveAuctionJson("command-auction-refresh-completion-candidate.json",combined);
          const finalCompletion = recoveryCommand("db-recovery-completion-review.js",{ ...completionRequest,candidateDatabasePath: refreshInspection,
            candidateReviewPath: combinedReviewPath,lineagePath: combinedHistoryPath,observedAtMs: now + 3 });
          assert.equal(finalCompletion.dispositions.messages.some(row => row.id === cliReport.createdOutboxId),false);
          assert.deepEqual(finalCompletion.currentCaps,completion.currentCaps);
          assert.equal(finalCompletion.dispositions.unresolvedMessages,auctionReviewPlan.unresolvedMessages);
          assert.equal(finalCompletion.activationReady,false);
          assert.equal(readHash(cliReport.reconciledDatabasePath),cliSourceHash);
          assert.deepEqual(preservedFiles.map(readHash),preservedHashes);
        });
        assert.equal(readHash(report.reconciledDatabasePath),outputHash);assert.equal(readHash(receiptPath),receiptHash);
        assert.deepEqual(started.runtime.database.serialize(),sourceBytes);
      });
      assert.throws(() => buildRecoveryAuctionReview({ ...options,lineage: { initialDatabasePath: candidatePath,initialPlan: auctionReviewPlan,steps: [] } }),
        { code: "RECOVERY_AUCTION_REVIEW_FAILED" });
      const event = readers[0].prepare("SELECT * FROM outbox_events WHERE league_id=? AND event_type='trade.changed' AND status='pending' ORDER BY id LIMIT 1")
        .get(auction.league_id); assert.ok(event);
      const audiences = readers[0].prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(event.id);
      const outputDirectory = path.join(directory,"prior-invalidation");
      const suppressed = prepareRecoveryInvalidationReconciliation({ credentialPreparation: prepared,plan: auctionReviewPlan,
        events: [{ eventId: event.id,leagueId: event.league_id,rowSha256: hash(canonicalize(event)),payloadSha256: hash(event.payload_json),
          audienceSha256: hash(canonicalize(audiences.map(row => hash(canonicalize(row))).sort())),
          reasonCode: "RESTORED_REFRESH_REVIEWED",evidenceSha256: hash("synthetic-auction-review-prior-invalidation") }],
        reviewedByUserId: fixtureId("account:platformAdmin"),reconciliationId: crypto.randomUUID(),reconciledAtMs: now + 1,
        temporaryRoot: input.temporaryRoot,outputDirectory });
      const receipt = JSON.parse(fs.readFileSync(path.join(outputDirectory,"invalidation-reconciliation.json"),"utf8"));
      const derivativePath = path.join(directory,"lineage-review.sqlite3");
      fs.copyFileSync(suppressed.reconciledDatabasePath,derivativePath,fs.constants.COPYFILE_EXCL);
      const derivativeHash = readHash(derivativePath), successfulOutputHash = readHash(suppressed.reconciledDatabasePath);
      const lineagePath = path.join(directory,"lineage.json");
      const lineage = { initialDatabasePath: candidatePath,initialPlan: auctionReviewPlan,steps: [{ kind: "invalidation",
        reconciledDatabasePath: derivativePath,receipt,observedAtMs: now + 2 }] };
      fs.writeFileSync(lineagePath,JSON.stringify(lineage),{ flag: "wx" });
      const nextRequestPath = path.join(directory,"lineage-candidate-request.json");
      fs.writeFileSync(nextRequestPath,JSON.stringify({ requestVersion: 1,expectedEnvironmentId: config.environmentId,
        expectedDatabaseId: config.databaseId,observedAtMs: now + 2,preparedDatabasePath: derivativePath,
        credentialPreparationPath: credentialsPath,lineagePath }),{ flag: "wx" });
      const nextCandidate = spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-review.js"),"--request",nextRequestPath],
        { encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
      assert.equal(nextCandidate.status,0,nextCandidate.stderr);assert.equal(nextCandidate.stderr,"");
      const nextCandidatePath = path.join(directory,"lineage-candidate-review.json");
      fs.writeFileSync(nextCandidatePath,nextCandidate.stdout,{ flag: "wx" });
      const nextRequest = { ...request,preparedDatabasePath: derivativePath,candidateReviewPath: nextCandidatePath,
        observedAtMs: now + 2,lineagePath };
      const next = invoke(nextRequest);
      assert.equal(next.planChecksum,JSON.parse(nextCandidate.stdout).plan.planChecksum);
      assert.notEqual(next.contextSha256,reviewed.contextSha256);
      assert.equal(next.contextEvidence.candidateState.auction.rowSha256,reviewed.contextEvidence.candidateState.auction.rowSha256);
      assert.equal(next.requiredReview,"league-rules-loss-window-and-domain-effects");assert.equal(next.replayPermitted,false);
      await reviewTest.test("auction recovery follows an earlier invalidation only with its actual complete lineage", async () => {
        const decisionPath = saveAuctionJson("after-invalidation-auction-decision.json",{ action: "resolve-ordinary-auction-held",reconciliationId: crypto.randomUUID(),
          reviewedByUserId: fixtureId("account:platformAdmin"),reasonCode: "REVIEWED_AUCTION_DEADLINE_AND_LOSS_WINDOW",
          evidenceSha256: hash("synthetic reviewed auction after invalidation"),reviewChecksum: next.reportChecksum });
        const outputDirectory = path.join(directory,"after-invalidation-auction");
        const report = recoveryCommand("db-recovery-auction.js",{ ...nextRequest,decisionPath,temporaryRoot: input.temporaryRoot,outputDirectory });
        assert.equal(report.planChecksum,next.planChecksum);assert.equal(report.activationReady,false);
        const receipt = JSON.parse(fs.readFileSync(path.join(outputDirectory,"auction-reconciliation.json"),"utf8"));
        const resultPath = path.join(directory,"after-invalidation-auction-inspection.sqlite3");
        fs.copyFileSync(report.reconciledDatabasePath,resultPath,fs.constants.COPYFILE_EXCL);
        const step = { kind: "auction",reconciledDatabasePath: resultPath,receipt,observedAtMs: now + 3,
          restoredDatabasePath: restoredPath,preservedDatabasePath: preservedPath };
        const combinedPath = saveAuctionJson("after-invalidation-auction-lineage.json",{ ...lineage,steps: [...lineage.steps,step] });
        const request = { requestVersion: 1,credentialPreparationPath: credentialsPath,preparedDatabasePath: resultPath,
          expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,observedAtMs: now + 3,lineagePath: combinedPath };
        const candidate = recoveryCommand("db-recovery-review.js",request);
        assert.equal(candidate.plan.planVersion,7);assert.equal(candidate.plan.unresolvedJobs,auctionReviewPlan.unresolvedJobs - 1);
        assert.equal(candidate.plan.unresolvedMessages,auctionReviewPlan.unresolvedMessages);
        assert.equal(candidate.plan.activationReady,false);assert.equal(candidate.plan.executable,false);
        const omittedPath = saveAuctionJson("after-invalidation-auction-omitted-lineage.json",{ ...lineage,steps: [step] });
        recoveryCommand("db-recovery-review.js",{ ...request,lineagePath: omittedPath },false);
        assert.equal(readHash(derivativePath),derivativeHash);assert.equal(readHash(suppressed.reconciledDatabasePath),successfulOutputHash);
      });
      const { lineagePath: omitted,...missingLineage } = nextRequest;invoke(missingLineage,false);
      const forgedLineagePath = path.join(directory,"forged-lineage.json");
      fs.writeFileSync(forgedLineagePath,JSON.stringify({ ...lineage,steps: [{ ...lineage.steps[0],receipt: { ...receipt,reportChecksum: "0".repeat(64) } }] }),{ flag: "wx" });
      invoke({ ...nextRequest,lineagePath: forgedLineagePath },false);
      assert.equal(readHash(derivativePath),derivativeHash);assert.equal(readHash(suppressed.reconciledDatabasePath),successfulOutputHash);
      for (const reader of readers) assert.equal(reader.prepare("SELECT total_changes() n").get().n,0);
    } finally { for (const reader of readers) reader.close(); }
    assert.deepEqual(files.map(readHash),hashes); assert.deepEqual(started.runtime.database.serialize(),sourceBytes);
    assert.equal(readHash(prepared.preparedDatabasePath),preparedHash);
    auctionReviewPaths = { prepared: candidatePath,restored: restoredPath };
  });
  await t.test("the loss-window report identifies a real signing completed after the selected backup", async () => {
    // Only after proving source preservation, simulate a real later signing in
    // the original synthetic fixture. Its original claim is still current
    // there, while the held derivative has already rejected that same claim.
    const heldHash = readHash(workPath), source = started.runtime.database;
    const completed = await worker(source,true).run();
    assert.equal(completed.status,"succeeded"); assert.equal(completed.completed,1);
    assert.equal(summerCalls.length,2); assert.equal(lateLockCalls.length,2);
    assert.deepEqual(errors,[]); assert.deepEqual(providerCalls,[]);
    const resolution = source.prepare("SELECT * FROM auction_resolutions WHERE auction_id=?").get(auction.id);
    assert.equal(resolution.status,"resolved");
    const sourceAfterSigning = source.serialize();
    const preserved = await createVerifiedBackup({ databasePath: started.databasePath,
      outputDirectory: path.join(input.temporaryRoot,"auction-loss-window-preserved"),environment: config.appEnv,
      reason: "incident-preservation",capturedAtMs: Date.now(),temporaryRoot: input.temporaryRoot });
    const restoredDatabase = openReadonlyDatabase({ databasePath: input.restoredCandidate.targetDatabasePath });
    const preservedDatabase = openReadonlyDatabase({ databasePath: path.join(preserved.outputDirectory,BACKUP_FILE_NAME) });
    try {
      const report = compareRecoveryLossWindow({ restoredDatabase,preservedDatabase,restoredPlaintextSha256: restoredHash,
        preservedPlaintextSha256: preserved.plaintextSha256,sourceBackupId: backup.backupId,
        expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,observedAtMs: Date.now(),
        includeFinancialState: true,includeJobEvidence: true });
      assert.equal(report.changedTables,13); assert.equal(report.changedRecords,15);
      const expected = { auctions: 1,auction_bids: 1,job_runs: 1,contracts: 1,contract_years: 3,contract_events: 1,
        player_ownerships: 1,ownership_events: 1,auction_events: 1,auction_resolutions: 1,league_activity: 1,
        outbox_events: 1,outbox_event_audiences: 1 };
      for (const [table,rows] of Object.entries(report.tables)) assert.equal(rows.changes.length,expected[table] || 0,table);
      for (const [table,id] of [["contracts",resolution.contract_id],["player_ownerships",resolution.ownership_id],
        ["auction_resolutions",resolution.id]]) {
        const changed = report.tables[table].changes[0];
        assert.equal(changed.keySha256,hash(canonicalize([id]))); assert.equal(changed.kind,"absent-from-backup");
        assert.equal(changed.restoredRowSha256,null);
        assert.equal(changed.preservedRowSha256,hash(canonicalize(source.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id))));
      }
      assert.equal(report.jobEvidence.changedOccurrences,1); assert.equal(report.jobEvidence.recordedCompletionsAfterBackup,1);
      const job = report.jobEvidence.occurrences.find(row => row.jobId === oldClaim.runId);
      assert.equal(job.restored.status,"leased"); assert.equal(job.preserved.status,"succeeded");
      assert.equal(job.replayPermitted,false); assert.equal(job.domainOutcomeVerified,false); assert.equal(job.externalOutcomeVerified,false);
      assert.equal(report.financialState.changedLeagues,1); assert.equal(report.financialState.completeReconciliation,false);
      const financial = report.financialState.leagues.find(row => row.leagueId === auction.league_id);
      const before = financial.restored.contracts.find(row => row.status === "active");
      const after = financial.preserved.contracts.find(row => row.status === "active");
      assert.equal(after.count,before.count + 1); assert.equal(after.originalTotalValueCents,before.originalTotalValueCents + 900);
      assert.equal(after.aavCents,before.aavCents + 300);
      for (const league of report.financialState.leagues.filter(row => row.leagueId !== auction.league_id)) {
        assert.deepEqual(league.restored,league.preserved); assert.equal(league.recordedTotalsChanged,false);
      }
      assert.equal(report.activationReady,false); assert.equal(report.executable,false); assert.equal(report.completeLossWindowEvidence,false);
      assert.equal(report.tables.outbox_events.changes[0].preservedStatus,"pending");
      assert.equal(report.tables.outbox_events.changes[0].replayPermitted,false);
      const { reportChecksum,...body } = report; assert.equal(hash(canonicalize(body)),reportChecksum);
      assert.equal(JSON.stringify(report).includes(PRIVATE_VALUE),false);
      const preparedReader = openReadonlyDatabase({ databasePath: auctionReviewPaths.prepared });
      try {
        const reviewed = buildRecoveryAuctionReview({ preparedDatabase: preparedReader,restoredDatabase,preservedDatabase,
          credentialPreparation: prepared,plan: auctionReviewPlan,jobId: oldClaim.runId,auctionId: auction.id,leagueId: auction.league_id,
          preservedPlaintextSha256: preserved.plaintextSha256,observedAtMs: report.observedAtMs });
        assert.equal(reviewed.requiredReview,"recorded-outcome-and-loss-reconciliation");
        assert.equal(reviewed.restoredState.auction.status,"open"); assert.equal(reviewed.preservedState.auction.status,"resolved");
        assert.equal(reviewed.preservedState.resolutions.length,1);
        const linked = reviewed.preservedState.resolutions[0];
        assert.equal(linked.id,resolution.id); assert.equal(linked.contract.id,resolution.contract_id); assert.equal(linked.ownership.id,resolution.ownership_id);
        assert.equal(linked.contract.rowSha256,hash(canonicalize(source.prepare("SELECT * FROM contracts WHERE id=?").get(resolution.contract_id))));
        assert.equal(linked.ownership.rowSha256,hash(canonicalize(source.prepare("SELECT * FROM player_ownerships WHERE id=?").get(resolution.ownership_id))));
        assert.deepEqual(reviewed.lossWindow,report); assert.equal(reviewed.replayPermitted,false);
        assert.equal(reviewed.activationReady,false); assert.equal(reviewed.executable,false);
        assert.equal(preparedReader.prepare("SELECT total_changes() n").get().n,0);
      } finally { preparedReader.close(); }
      for (const db of [restoredDatabase,preservedDatabase]) assert.equal(db.prepare("SELECT total_changes() n").get().n,0);
    } finally { restoredDatabase.close();preservedDatabase.close(); }
    assert.deepEqual(source.serialize(),sourceAfterSigning);
    assert.equal(readHash(workPath),heldHash); assert.equal(readHash(prepared.preparedDatabasePath),preparedHash);
    assert.equal(readHash(input.restoredCandidate.targetDatabasePath),restoredHash);
  });
});

test("an exact restored trade expiry rejects its previous worker and replays once in a held copy", async t => {
  const { createSqliteTradeExpiryRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteTradeExpiryRepository");
  const { createExpireTradeProposalsJob } = require("../../src/jobs/definitions/expireTradeProposals");
  const { buildTradeExpiryOccurrenceKey } = require("../../src/domain/trades/tradeLifecyclePolicy");
  const { REPOSITORY_ERROR_CODES } = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");
  let trade, oldClaim, occurrenceKey, now;
  const oldOwner = "synthetic-before-trade-recovery";
  const { started, input } = await candidate(t, database => {
    // Select a real pending proposal created by the deterministic release
    // fixture's service. Never invent or change its persisted deadline.
    trade = database.prepare("SELECT * FROM trades WHERE league_id=? AND status='proposed' " +
      "AND proposal_model_version=2 AND effective_deadline_at_ms IS NOT NULL ORDER BY id LIMIT 1")
      .get(fixtureId("league:leagueA"));
    assert.ok(trade);
    occurrenceKey = buildTradeExpiryOccurrenceKey({ tradeId: trade.id, effectiveDeadlineAtMs: trade.effective_deadline_at_ms });
    now = trade.effective_deadline_at_ms + 1000;
    oldClaim = createSqliteTradeExpiryRepository({ database }).claimRun({
      jobRunId: crypto.randomUUID(), leagueId: trade.league_id, seasonId: trade.season_id, occurrenceKey,
      scheduledForMs: trade.effective_deadline_at_ms, leaseOwner: oldOwner,
      nowMs: now - 1000, leaseExpiresAtMs: now + 60_000,
    });
    assert.equal(oldClaim.acquired, true);
  });
  const sourceBytes = started.runtime.database.serialize(), restoredHash = readHash(input.restoredCandidate.targetDatabasePath);
  const prepared = prepareRecoveryCredentials({ ...input, preparedAtMs: now,
    outputDirectory: path.join(input.temporaryRoot, "trade-expiry-preparation") });
  const preparedHash = readHash(prepared.preparedDatabasePath);
  const workPath = path.join(input.temporaryRoot, "trade-expiry-working-copy.sqlite3");
  fs.copyFileSync(prepared.preparedDatabasePath, workPath, fs.constants.COPYFILE_EXCL);
  const open = () => openDatabase({ databasePath: workPath, environment: "test" }).database;
  const worker = (database, previousWorker = false) => {
    const repository = createSqliteTradeExpiryRepository({ database });
    return createExpireTradeProposalsJob({ repository: {
      ...repository,
      // This isolated rehearsal selects only the reviewed fixture occurrence.
      // Production recovery still requires an attributed operation and receipt.
      listDue(query) { return repository.listDue({ ...query, limit: 100 }).filter(row => row.tradeId === trade.id); },
      ...(previousWorker ? { claimRun() { return oldClaim; } } : {}),
    }, clock: { nowMs: () => now }, secureRandom: { id: () => crypto.randomUUID() },
    leaseOwner: previousWorker ? oldOwner : "synthetic-after-trade-recovery", logger: { error() {} } });
  };
  let database = open();
  try {
    const before = allRows(database), beforeBytes = database.serialize();
    const restoredJob = database.prepare("SELECT * FROM job_runs WHERE id=?").get(oldClaim.runId);
    assert.equal(restoredJob.status, "leased"); assert.equal(restoredJob.lease_owner, null);
    assert.equal(restoredJob.lease_expires_at_ms, now); assert.equal(restoredJob.version, oldClaim.version + 1);
    const stale = await worker(database, true).run();
    assert.equal(stale.status, "succeeded"); assert.equal(stale.expired, 0); assert.equal(stale.skipped, 1);
    assert.equal(stale.failed, 0); assert.deepEqual(database.serialize(), beforeBytes);
    assert.equal(database.prepare("SELECT total_changes() n").get().n, 0);

    const result = await worker(database).run();
    assert.deepEqual(result, { job: "trades:expire:target", status: "succeeded", due: 1,
      acquired: 1, expired: 1, terminal: 0, failed: 0, skipped: 0 });
    const after = allRows(database), changed = new Set(["trades", "job_runs", "trade_events", "league_activity", "outbox_events", "outbox_event_audiences"]);
    for (const [table, rows] of Object.entries(before)) if (!changed.has(table)) assert.deepEqual(after[table], rows, table);
    const currentTrade = database.prepare("SELECT * FROM trades WHERE id=?").get(trade.id);
    assert.deepEqual(currentTrade, { ...trade, status: "expired", responded_at_ms: now, updated_at_ms: now, version: trade.version + 1 });
    const currentJob = database.prepare("SELECT * FROM job_runs WHERE id=?").get(oldClaim.runId);
    assert.deepEqual(currentJob, { ...restoredJob, status: "succeeded", attempt_count: oldClaim.attemptCount + 1,
      lease_owner: null, lease_expires_at_ms: null, started_at_ms: now, completed_at_ms: now,
      result_json: JSON.stringify({ tradeId: trade.id, outcome: "expired" }), last_error_code: null,
      updated_at_ms: now, version: oldClaim.version + 3 });
    for (const [table, id] of [["trades", trade.id], ["job_runs", oldClaim.runId]]) {
      assert.deepEqual(after[table].filter(row => JSON.parse(row).id !== id), before[table].filter(row => JSON.parse(row).id !== id), table);
    }
    const additions = {};
    for (const table of ["trade_events", "league_activity", "outbox_events", "outbox_event_audiences"]) {
      const oldIds = new Set(before[table].map(row => JSON.parse(row).id));
      assert.deepEqual(after[table].filter(row => oldIds.has(JSON.parse(row).id)), before[table], table);
      additions[table] = after[table].map(JSON.parse).filter(row => !oldIds.has(row.id));
      assert.equal(additions[table].length, 1, table);
      assert.equal(additions[table][0].league_id, trade.league_id, table);
    }
    const event = additions.trade_events[0], activity = additions.league_activity[0], message = additions.outbox_events[0];
    assert.equal(event.trade_id, trade.id); assert.equal(event.season_id, trade.season_id);
    assert.equal(event.actor_user_id, null); assert.equal(event.event_type, "proposal_expired");
    assert.equal(event.reason, "effective_deadline_elapsed"); assert.equal(event.occurred_at_ms, now);
    assert.deepEqual(JSON.parse(event.metadata_json), { schemaVersion: 1, occurrenceKey,
      effectiveDeadlineAtMs: trade.effective_deadline_at_ms, fromStatus: "proposed", toStatus: "expired" });
    assert.equal(activity.event_type, "trade_proposal_expired"); assert.equal(activity.related_id, trade.id);
    assert.equal(activity.actor_authority, "system"); assert.equal(activity.occurred_at_ms, now);
    assert.equal(message.event_type, "trade.changed"); assert.equal(message.aggregate_type, "trade");
    assert.equal(message.aggregate_id, trade.id); assert.equal(message.status, "pending");
    assert.equal(message.published_at_ms, null); assert.equal(message.attempt_count, 0);
    assert.equal(JSON.parse(message.payload_json).version, trade.version + 1);
    assert.deepEqual(additions.outbox_event_audiences[0], { id: message.id, outbox_event_id: message.id,
      league_id: trade.league_id, audience_kind: "league", team_id: null, user_id: null, created_at_ms: now });
    assert.ok(database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY));
    assert.throws(() => createTargetRuntime({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations") }),
      { code: "DATABASE_RECOVERY_HELD" });
    const completedBytes = database.serialize();
    assert.throws(() => createSqliteTradeExpiryRepository({ database }).succeedRun({ leagueId: trade.league_id,
      runId: oldClaim.runId, leaseOwner: oldOwner, expectedVersion: oldClaim.version, completedAtMs: now,
      tradeId: trade.id, outcome: "expired" }), { code: REPOSITORY_ERROR_CODES.versionConflict });
    assert.deepEqual(database.serialize(), completedBytes);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    database.close(); database = open();
    const restartBytes = database.serialize(), restarted = await worker(database).run();
    assert.equal(restarted.status, "succeeded"); assert.equal(restarted.due, 0); assert.equal(restarted.expired, 0);
    assert.deepEqual(database.serialize(), restartBytes); assert.deepEqual(allRows(database), after);
    assert.equal(database.prepare("SELECT total_changes() n").get().n, 0);
  } finally { if (database.open) database.close(); }
  await t.test("the reviewed offline trade operation records exact domain changes and rejects unsafe evidence", async operationTest => {
    const { prepareRecoveryTradeExpiryReconciliation } = require("../../src/operations/backups/prepareRecoveryTradeExpiryReconciliation");
    const reviewPath = path.join(input.temporaryRoot, "trade-expiry-review.sqlite3");
    fs.copyFileSync(prepared.preparedDatabasePath, reviewPath, fs.constants.COPYFILE_EXCL);
    const reader = openReadonlyDatabase({ databasePath: reviewPath });
    let plan, row, initial;
    try {
      plan = buildRecoveryReconciliationPlan({ database: reader, credentialPreparation: prepared, observedAtMs: now,
        expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID, expectedDatabaseId: FIXTURE_DATABASE_ID });
      row = reader.prepare("SELECT * FROM job_runs WHERE id=?").get(oldClaim.runId); initial = allRows(reader);
    } finally { reader.close(); }
    const review = { reconciliationId: crypto.randomUUID(), reviewedByUserId: fixtureId("account:platformAdmin"),
      reasonCode: "REVIEWED_ORIGINAL_TRADE_DEADLINE", evidenceSha256: hash("synthetic commissioner deadline and loss-window review"),
      jobId: row.id, leagueId: trade.league_id, seasonId: trade.season_id, tradeId: trade.id,
      deadlineAtMs: trade.effective_deadline_at_ms, rowSha256: hash(canonicalize(row)), tradeRowSha256: hash(canonicalize(trade)),
      occurrenceKeySha256: hash(canonicalize([row.league_id, row.job_type, row.occurrence_key])) };
    const options = { credentialPreparation: prepared, plan, review, executedAtMs: now,
      temporaryRoot: input.temporaryRoot, outputDirectory: path.join(input.temporaryRoot, "trade-expiry-operation") };
    const report = await prepareRecoveryTradeExpiryReconciliation(options);
    assert.equal(report.status, "trade-expiry-reconciled-held"); assert.equal(report.activationReady, false);
    assert.equal(report.unresolvedJobs, plan.unresolvedJobs - 1); assert.equal(report.unresolvedMessages, plan.unresolvedMessages + 1);
    assert.equal(report.createdMessage, "pending-and-held"); assert.equal(report.previousMessages, "unchanged-and-held");
    assert.equal(report.sourcePlaintextSha256, preparedHash);
    assert.equal(report.reconciledPlaintextSha256, readHash(report.reconciledDatabasePath));
    const receipt = JSON.parse(fs.readFileSync(path.join(options.outputDirectory, "trade-expiry-reconciliation.json"), "utf8"));
    const { reportChecksum, ...receiptBody } = receipt;
    assert.equal(hash(canonicalize(receiptBody)), reportChecksum); assert.deepEqual(receipt.decision, review);
    const resultHash = readHash(report.reconciledDatabasePath), restartPath = path.join(input.temporaryRoot, "trade-operation-restart.sqlite3");
    fs.copyFileSync(report.reconciledDatabasePath, restartPath, fs.constants.COPYFILE_EXCL);
    const resultDatabase = openDatabase({ databasePath: restartPath, environment: "test" }).database;
    try {
      const rows = allRows(resultDatabase);
      for (const [table, values] of Object.entries(initial)) {
        if (!["job_runs", "trades", "trade_events", "league_activity", "outbox_events", "outbox_event_audiences", "security_audit_events", "application_metadata"].includes(table)) assert.deepEqual(rows[table], values, table);
      }
      const completed = resultDatabase.prepare("SELECT * FROM job_runs WHERE id=?").get(row.id);
      assert.equal(completed.status, "succeeded"); assert.equal(completed.version, row.version + 2);
      assert.equal(hash(canonicalize(completed)), report.completedJobRowSha256);
      const event = resultDatabase.prepare("SELECT * FROM trade_events WHERE id=?").get(report.eventId);
      assert.equal(event.trade_id, trade.id); assert.equal(event.event_type, "proposal_expired");
      const message = resultDatabase.prepare("SELECT * FROM outbox_events WHERE id=?").get(report.createdOutboxId);
      assert.equal(message.aggregate_id, trade.id); assert.equal(message.status, "pending");
      const audit = resultDatabase.prepare("SELECT * FROM security_audit_events WHERE id=?").get(review.reconciliationId);
      assert.equal(audit.actor_user_id, review.reviewedByUserId); assert.equal(audit.league_id, trade.league_id);
      assert.equal(audit.event_type, "recovery.trade_expiry_reconciled");
      assert.ok(resultDatabase.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY));
      const bytes = resultDatabase.serialize(); const restarted = await worker(resultDatabase).run();
      assert.equal(restarted.due, 0); assert.deepEqual(resultDatabase.serialize(), bytes);
      assert.equal(resultDatabase.prepare("SELECT total_changes() n").get().n, 0);
    } finally { resultDatabase.close(); }
    await assert.rejects(prepareRecoveryTradeExpiryReconciliation(options), { code: "RECOVERY_TRADE_PATH_UNSAFE" });
    for (const [suffix, change, code] of [
      ["row", { review: { ...review, rowSha256: "f".repeat(64) } }, "RECOVERY_TRADE_OCCURRENCE_INVALID"],
      ["trade", { review: { ...review, tradeRowSha256: "f".repeat(64) } }, "RECOVERY_TRADE_OCCURRENCE_INVALID"],
      ["league", { review: { ...review, leagueId: fixtureId("league:leagueB") } }, "RECOVERY_TRADE_OCCURRENCE_INVALID"],
      ["deadline", { review: { ...review, deadlineAtMs: review.deadlineAtMs + 1 } }, "RECOVERY_TRADE_OCCURRENCE_INVALID"],
      ["reviewer", { review: { ...review, reviewedByUserId: fixtureId("account:leagueACommissioner") } }, "RECOVERY_TRADE_REVIEWER_INVALID"],
      ["extra", { review: { ...review, approve: true } }, "RECOVERY_TRADE_INPUT_INVALID"],
      ["time", { executedAtMs: now - 1 }, "RECOVERY_TRADE_PLAN_INVALID"],
      ["plan", { plan: { ...plan, unresolvedJobs: 0 } }, "RECOVERY_TRADE_PLAN_INVALID"],
    ]) {
      const outputDirectory = path.join(input.temporaryRoot, "trade-operation-reject-" + suffix);
      await assert.rejects(prepareRecoveryTradeExpiryReconciliation({ ...options, ...change, outputDirectory }), { code });
      assert.equal(fs.existsSync(outputDirectory), false);
    }
    for (const [suffix, beforeReceipt] of [
      ["other-trade", db => db.prepare("UPDATE trades SET version=version+1 WHERE league_id=?").run(fixtureId("league:leagueB"))],
      ["wrong-result", db => db.prepare("UPDATE trades SET version=version+1 WHERE id=?").run(trade.id)],
      ["send", db => db.prepare("UPDATE outbox_events SET status='discarded' WHERE aggregate_id=?").run(trade.id)],
      ["interrupt", () => { throw new Error("synthetic interruption after domain completion"); }],
    ]) {
      const outputDirectory = path.join(input.temporaryRoot, "trade-operation-failure-" + suffix);
      await assert.rejects(prepareRecoveryTradeExpiryReconciliation({ ...options, outputDirectory, beforeReceipt }),
        { code: suffix === "interrupt" ? "RECOVERY_TRADE_FAILED" : "RECOVERY_TRADE_POSTCHECK_FAILED" });
      assert.equal(fs.existsSync(outputDirectory), false);
    }
    await operationTest.test("actual trade commands verify their lineage and the new held notification", async () => {
      const { buildTradeExpiryReconciledRecoveryPlan } = require("../../src/operations/backups/buildTradeExpiryReconciledRecoveryPlan");
      let sequence = 0;
      const write = (name, value) => {
        const file = path.join(input.temporaryRoot, `trade-command-${++sequence}-${name}.json`);
        fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" }); return file;
      };
      const invoke = (script, request, succeeds = true) => {
        const processResult = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/" + script), "--request", write("request", request)],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: process.env });
        if (succeeds) { assert.equal(processResult.status, 0, processResult.stderr); assert.equal(processResult.stderr, ""); return JSON.parse(processResult.stdout); }
        assert.equal(processResult.status, 1); assert.equal(processResult.stdout, ""); return JSON.parse(processResult.stderr);
      };
      const inspectCopy = source => {
        const copyPath = path.join(input.temporaryRoot, `trade-inspect-${++sequence}.sqlite3`);
        fs.copyFileSync(source, copyPath, fs.constants.COPYFILE_EXCL); return copyPath;
      };
      const credentialPreparationPath = write("credentials", prepared);
      const initialReviewRequest = { requestVersion: 1, expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,
        expectedDatabaseId: FIXTURE_DATABASE_ID, observedAtMs: now, preparedDatabasePath: reviewPath, credentialPreparationPath };
      const initialReview = invoke("db-recovery-review.js", initialReviewRequest);
      assert.deepEqual(initialReview.plan, plan);
      const commandRequest = { requestVersion: 1, credentialPreparationPath, preparedDatabasePath: prepared.preparedDatabasePath,
        candidateReviewPath: write("candidate-review", initialReview), decisionPath: write("decision", review),
        executedAtMs: now, temporaryRoot: input.temporaryRoot, outputDirectory: path.join(input.temporaryRoot, "trade-command-output") };
      const commanded = invoke("db-recovery-trade-expiry.js", commandRequest);
      assert.equal(commanded.status, "trade-expiry-reconciled-held"); assert.equal(commanded.activationReady, false);
      const commandReceipt = JSON.parse(fs.readFileSync(path.join(commandRequest.outputDirectory, "trade-expiry-reconciliation.json"), "utf8"));
      const currentPath = inspectCopy(commanded.reconciledDatabasePath);
      const lineage = { initialDatabasePath: reviewPath, initialPlan: plan, steps: [{ kind: "trade-expiry",
        reconciledDatabasePath: currentPath, receipt: commandReceipt, observedAtMs: now + 1 }] };
      const nextReviewRequest = { ...initialReviewRequest, observedAtMs: now + 1, preparedDatabasePath: currentPath, lineagePath: write("lineage", lineage) };
      const nextReview = invoke("db-recovery-review.js", nextReviewRequest);
      assert.equal(nextReview.plan.planVersion, 6); assert.equal(nextReview.plan.unresolvedJobs, plan.unresolvedJobs - 1);
      assert.equal(nextReview.plan.unresolvedMessages, plan.unresolvedMessages + 1); assert.equal(nextReview.activationReady, false);
      assert.equal(nextReview.plan.outbox.find(row => row.id === commanded.createdOutboxId).deliveryPermitted, false);
      const originalReader = openReadonlyDatabase({ databasePath: reviewPath }), currentReader = openReadonlyDatabase({ databasePath: currentPath });
      try {
        const verification = { preparedDatabase: originalReader, reconciledDatabase: currentReader, credentialPreparation: prepared,
          originalPlan: plan, tradeExpiryReconciliation: commandReceipt, observedAtMs: now + 1 };
        assert.deepEqual(buildTradeExpiryReconciledRecoveryPlan(verification), nextReview.plan);
        const { reportChecksum: ignored, ...forgedBody } = commandReceipt;
        forgedBody.unresolvedMessages = plan.unresolvedMessages;
        assert.throws(() => buildTradeExpiryReconciledRecoveryPlan({ ...verification,
          tradeExpiryReconciliation: { ...forgedBody, reportChecksum: hash(canonicalize(forgedBody)) } }), { code: "RECOVERY_TRADE_PLAN_RECEIPT_INVALID" });
        const audiences = currentReader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(commanded.createdOutboxId);
        const message = currentReader.prepare("SELECT * FROM outbox_events WHERE id=?").get(commanded.createdOutboxId);
        const events = [{ eventId: message.id, leagueId: message.league_id, rowSha256: hash(canonicalize(message)),
          payloadSha256: hash(message.payload_json), audienceSha256: hash(canonicalize(audiences.map(row => hash(canonicalize(row))).sort())),
          reasonCode: "REVIEWED_NEW_TRADE_REFRESH", evidenceSha256: hash("synthetic trade refresh suppression review") }];
        const suppressed = prepareRecoveryInvalidationReconciliation({ credentialPreparation: { ...prepared, preparedDatabasePath: commanded.reconciledDatabasePath },
          plan: nextReview.plan, lineage, events, reviewedByUserId: review.reviewedByUserId, reconciliationId: crypto.randomUUID(),
          reconciledAtMs: now + 2, temporaryRoot: input.temporaryRoot, outputDirectory: path.join(input.temporaryRoot, "trade-then-invalidation") });
        assert.equal(suppressed.unresolvedMessages, plan.unresolvedMessages); assert.equal(suppressed.deliveryPerformed, false);
        const suppressedPath = inspectCopy(suppressed.reconciledDatabasePath);
        const suppressedReceipt = JSON.parse(fs.readFileSync(path.join(path.dirname(suppressed.reconciledDatabasePath), "invalidation-reconciliation.json"), "utf8"));
        const finalLineage = { ...lineage, steps: [...lineage.steps, { kind: "invalidation", reconciledDatabasePath: suppressedPath,
          receipt: suppressedReceipt, observedAtMs: now + 3 }] };
        const finalReview = invoke("db-recovery-review.js", { ...initialReviewRequest, observedAtMs: now + 3,
          preparedDatabasePath: suppressedPath, lineagePath: write("final-lineage", finalLineage) });
        assert.equal(finalReview.plan.unresolvedJobs, plan.unresolvedJobs - 1);
        assert.equal(finalReview.plan.outbox.find(row => row.id === message.id).status, "discarded");
        assert.equal(finalReview.activationReady, false);
        const missing = invoke("db-recovery-review.js", { ...initialReviewRequest, observedAtMs: now + 3,
          preparedDatabasePath: suppressedPath, lineagePath: write("missing-step", { ...lineage, steps: [finalLineage.steps[1]] }) }, false);
        assert.match(missing.error.code, /^RECOVERY_/);
      } finally { currentReader.close(); originalReader.close(); }
      const reverseReader = openReadonlyDatabase({ databasePath: reviewPath });
      let priorEvent;
      try {
        const message = reverseReader.prepare("SELECT * FROM outbox_events WHERE event_type='trade.changed' AND status='pending' ORDER BY id LIMIT 1").get();
        assert.ok(message);
        const audiences = reverseReader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(message.id);
        priorEvent = { eventId: message.id, leagueId: message.league_id, rowSha256: hash(canonicalize(message)), payloadSha256: hash(message.payload_json),
          audienceSha256: hash(canonicalize(audiences.map(row => hash(canonicalize(row))).sort())),
          reasonCode: "REVIEWED_EXISTING_TRADE_REFRESH", evidenceSha256: hash("synthetic earlier refresh review") };
      } finally { reverseReader.close(); }
      const firstSuppressed = prepareRecoveryInvalidationReconciliation({ credentialPreparation: prepared, plan, events: [priorEvent],
        reviewedByUserId: review.reviewedByUserId, reconciliationId: crypto.randomUUID(), reconciledAtMs: now + 1,
        temporaryRoot: input.temporaryRoot, outputDirectory: path.join(input.temporaryRoot, "invalidation-before-trade") });
      const firstSuppressedPath = inspectCopy(firstSuppressed.reconciledDatabasePath);
      const firstSuppressedReceipt = JSON.parse(fs.readFileSync(path.join(path.dirname(firstSuppressed.reconciledDatabasePath), "invalidation-reconciliation.json"), "utf8"));
      const reverseLineage = { initialDatabasePath: reviewPath, initialPlan: plan, steps: [{ kind: "invalidation",
        reconciledDatabasePath: firstSuppressedPath, receipt: firstSuppressedReceipt, observedAtMs: now + 2 }] };
      const reverseLineagePath = write("reverse-lineage", reverseLineage);
      const reverseReview = invoke("db-recovery-review.js", { ...initialReviewRequest, observedAtMs: now + 2,
        preparedDatabasePath: firstSuppressedPath, lineagePath: reverseLineagePath });
      const afterSuppression = invoke("db-recovery-trade-expiry.js", { ...commandRequest, preparedDatabasePath: firstSuppressed.reconciledDatabasePath,
        candidateReviewPath: write("reverse-review", reverseReview), decisionPath: write("reverse-decision", { ...review, reconciliationId: crypto.randomUUID() }),
        lineagePath: reverseLineagePath, executedAtMs: now + 3, outputDirectory: path.join(input.temporaryRoot, "trade-after-invalidation") });
      const reversedPath = inspectCopy(afterSuppression.reconciledDatabasePath);
      const reversedReceipt = JSON.parse(fs.readFileSync(path.join(path.dirname(afterSuppression.reconciledDatabasePath), "trade-expiry-reconciliation.json"), "utf8"));
      const reversedLineage = { ...reverseLineage, steps: [...reverseLineage.steps,
        { kind: "trade-expiry", reconciledDatabasePath: reversedPath, receipt: reversedReceipt, observedAtMs: now + 4 }] };
      const reversedLineagePath = write("reversed-final-lineage", reversedLineage);
      const reversedReview = invoke("db-recovery-review.js", { ...initialReviewRequest, observedAtMs: now + 4, preparedDatabasePath: reversedPath,
        lineagePath: reversedLineagePath });
      assert.equal(reversedReview.plan.planVersion, 6); assert.equal(reversedReview.plan.unresolvedJobs, plan.unresolvedJobs - 1);
      assert.equal(reversedReview.plan.unresolvedMessages, plan.unresolvedMessages); assert.equal(reversedReview.activationReady, false);
      const delayedReader = openReadonlyDatabase({ databasePath: reversedPath });
      let delayedEvent;
      try {
        const message = delayedReader.prepare("SELECT * FROM outbox_events WHERE id=?").get(afterSuppression.createdOutboxId);
        assert.ok(message.created_at_ms > prepared.preparedAtMs);
        const audiences = delayedReader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(message.id);
        delayedEvent = { eventId: message.id, leagueId: message.league_id, rowSha256: hash(canonicalize(message)),
          payloadSha256: hash(message.payload_json), audienceSha256: hash(canonicalize(audiences.map(row => hash(canonicalize(row))).sort())),
          reasonCode: "REVIEWED_DELAYED_TRADE_REFRESH", evidenceSha256: hash("synthetic delayed refresh review") };
      } finally { delayedReader.close(); }
      const delayedRequest = { requestVersion: 1, credentialPreparationPath, preparedDatabasePath: afterSuppression.reconciledDatabasePath,
        candidateReviewPath: write("delayed-review", reversedReview), invalidationReviewPath: write("delayed-events", { events: [delayedEvent] }),
        lineagePath: reversedLineagePath, reviewedByUserId: review.reviewedByUserId, reconciliationId: crypto.randomUUID(),
        reconciledAtMs: now + 5, temporaryRoot: input.temporaryRoot, outputDirectory: path.join(input.temporaryRoot, "delayed-invalidation") };
      assert.equal(invoke("db-recovery-invalidations.js", delayedRequest, false).error.code, "RECOVERY_INVALIDATION_EVENT_MISMATCH");
      assert.equal(fs.existsSync(delayedRequest.outputDirectory), false);
      const delayedSuppressed = invoke("db-recovery-invalidations.js", { ...delayedRequest, eventScope: "reviewed-candidate" });
      assert.equal(delayedSuppressed.disposition, "suppress-reviewed-refresh-hint");
      assert.equal(delayedSuppressed.unresolvedMessages, plan.unresolvedMessages - 1);
      assert.equal(delayedSuppressed.deliveryPerformed, false); assert.equal(delayedSuppressed.activationReady, false);
      const delayedPath = inspectCopy(delayedSuppressed.reconciledDatabasePath);
      const delayedReceipt = JSON.parse(fs.readFileSync(path.join(path.dirname(delayedSuppressed.reconciledDatabasePath), "invalidation-reconciliation.json"), "utf8"));
      const delayedLineage = { ...reversedLineage, steps: [...reversedLineage.steps,
        { kind: "invalidation", reconciledDatabasePath: delayedPath, receipt: delayedReceipt, observedAtMs: now + 6 }] };
      const delayedReview = invoke("db-recovery-review.js", { ...initialReviewRequest, observedAtMs: now + 6, preparedDatabasePath: delayedPath,
        lineagePath: write("delayed-lineage", delayedLineage) });
      assert.equal(delayedReview.plan.outbox.find(row => row.id === delayedEvent.eventId).status, "discarded");
      assert.equal(delayedReview.plan.unresolvedMessages, plan.unresolvedMessages - 1);
      assert.equal(delayedReview.plan.unresolvedJobs, plan.unresolvedJobs - 1); assert.equal(delayedReview.activationReady, false);
      for (const [suffix, change] of [["scope", { eventScope: "all" }], ["history", { lineagePath: undefined }],
        ["hash", { invalidationReviewPath: write("bad-delayed-events", { events: [{ ...delayedEvent, rowSha256: "f".repeat(64) }] }) }]]) {
        const outputDirectory = path.join(input.temporaryRoot, "delayed-reject-" + suffix);
        const rejected = invoke("db-recovery-invalidations.js", { ...delayedRequest, eventScope: "reviewed-candidate", ...change, outputDirectory }, false);
        assert.match(rejected.error.code, /^RECOVERY_/); assert.equal(fs.existsSync(outputDirectory), false);
      }
      const { reportChecksum: delayedChecksum, ...downgradedBody } = delayedReceipt;
      downgradedBody.disposition = "suppress-restored-refresh-hint";
      const downgradedReceipt = { ...downgradedBody, reportChecksum: hash(canonicalize(downgradedBody)) };
      const downgradedLineage = { ...delayedLineage, steps: delayedLineage.steps.map((step, index) => index === 2 ? { ...step, receipt: downgradedReceipt } : step) };
      invoke("db-recovery-review.js", { ...initialReviewRequest, observedAtMs: now + 6, preparedDatabasePath: delayedPath,
        lineagePath: write("downgraded-lineage", downgradedLineage) }, false);
      assert.equal(readHash(delayedSuppressed.reconciledDatabasePath), delayedSuppressed.reconciledPlaintextSha256);
      assert.equal(readHash(firstSuppressed.reconciledDatabasePath), firstSuppressed.reconciledPlaintextSha256);
      assert.equal(readHash(afterSuppression.reconciledDatabasePath), afterSuppression.reconciledPlaintextSha256);
      for (const [suffix, change] of [["repeat", {}], ["extra", { approve: true }],
        ["bad-review", { candidateReviewPath: write("bad-review", { ...initialReview, activationReady: true }) }]]) {
        const outputDirectory = suffix === "repeat" ? commandRequest.outputDirectory : path.join(input.temporaryRoot, "trade-command-reject-" + suffix);
        invoke("db-recovery-trade-expiry.js", { ...commandRequest, ...change, outputDirectory }, false);
        if (suffix !== "repeat") assert.equal(fs.existsSync(outputDirectory), false);
      }
      const alteredPath = inspectCopy(commanded.reconciledDatabasePath);
      const altered = openDatabase({ databasePath: alteredPath, environment: "test" }).database;
      altered.prepare("UPDATE trades SET version=version+1 WHERE id=?").run(trade.id); altered.close();
      const { reportChecksum: ignored, ...alteredBody } = commandReceipt;
      alteredBody.reconciledPlaintextSha256 = readHash(alteredPath);
      const alteredReader = openReadonlyDatabase({ databasePath: alteredPath });
      const preparedReader = openReadonlyDatabase({ databasePath: reviewPath });
      try {
        // Even a fresh file hash, table hashes and receipt checksum cannot
        // legitimize an additional domain change that was never reviewed.
        const { snapshots, readRows } = require("../../src/operations/backups/recoveryTradeExpiryEvidence");
        alteredBody.tableSnapshots = snapshots(readRows(alteredReader));
        assert.throws(() => buildTradeExpiryReconciledRecoveryPlan({ preparedDatabase: preparedReader, reconciledDatabase: alteredReader,
          credentialPreparation: prepared, originalPlan: plan, observedAtMs: now + 1,
          tradeExpiryReconciliation: { ...alteredBody, reportChecksum: hash(canonicalize(alteredBody)) } }), { code: "RECOVERY_TRADE_PLAN_DELTA_INVALID" });
      } finally { alteredReader.close(); preparedReader.close(); }
      assert.equal(readHash(commanded.reconciledDatabasePath), commanded.reconciledPlaintextSha256);
    });
    assert.equal(readHash(report.reconciledDatabasePath), resultHash);
  });
  assert.equal(readHash(prepared.preparedDatabasePath), preparedHash);
  assert.equal(readHash(input.restoredCandidate.targetDatabasePath), restoredHash);
  assert.deepEqual(started.runtime.database.serialize(), sourceBytes);
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
    const message = database.prepare("SELECT * FROM outbox_events WHERE id=?").get(fixtureId("recovery-preparation:outbox:security"));
    for (const suffix of ["second","third"]) database.prepare("INSERT INTO outbox_events("+Object.keys(message).join(",")+") VALUES("+Object.keys(message).map(key => `@${key}`).join(",")+")")
      .run({ ...message,id: fixtureId("recovery-lineage-email:"+suffix) });
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
  const reconciledReviewPath = path.join(input.temporaryRoot,"statistics-reconciled-review.sqlite3");
  fs.copyFileSync(commandReport.reconciledDatabasePath,reconciledReviewPath,fs.constants.COPYFILE_EXCL);
  const originalReader = openReadonlyDatabase({ databasePath: reviewPath }),reconciledReader = openReadonlyDatabase({ databasePath: reconciledReviewPath });
  const statisticsReceiptPath = path.join(commandRequest.outputDirectory,"statistics-reconciliation.json");
  // Use the canonical on-disk receipt, whose result keys have a different
  // serialization order from the job's original result_json string.
  const statisticsReceipt = JSON.parse(fs.readFileSync(statisticsReceiptPath,"utf8"));
  const observedAtMs = commandReport.completedAtMs+100;
  let nextPlan;
  const nextOptions = { preparedDatabase: originalReader,reconciledDatabase: reconciledReader,credentialPreparation: prepared,
    originalPlan: plan,statisticsReconciliation: statisticsReceipt,observedAtMs };
  try {
    nextPlan = buildStatisticsReconciledRecoveryPlan(nextOptions);
    assert.equal(nextPlan.planVersion,4); assert.equal(nextPlan.preparedPlaintextSha256,commandHash);
    assert.equal(nextPlan.previousPlanChecksum,plan.planChecksum); assert.equal(nextPlan.statisticsReconciliationChecksum,statisticsReceipt.reportChecksum);
    assert.equal(nextPlan.unresolvedJobs,plan.unresolvedJobs-1); assert.deepEqual(nextPlan.outbox,plan.outbox);
    assert.equal(nextPlan.activationReady,false); assert.equal(nextPlan.executable,false);
    const job = nextPlan.jobs.find(entry => entry.id === row.id);
    assert.equal(job.status,"succeeded"); assert.equal(job.disposition,"preserve-recorded-result"); assert.equal(job.executionPermitted,false);
    const { planChecksum,...nextBody } = nextPlan; assert.equal(hash(canonicalize(nextBody)),planChecksum);
    assert.equal(JSON.stringify(nextPlan).includes(PRIVATE_VALUE),false);
    for (const patch of [ { observedAtMs: commandReport.completedAtMs-1 },{ originalPlan: { ...plan,unresolvedJobs: 0 } },
      { statisticsReconciliation: { ...statisticsReceipt,reportChecksum: "f".repeat(64) } } ]) {
      assert.throws(() => buildStatisticsReconciledRecoveryPlan({ ...nextOptions,...patch }),error => /^RECOVERY_STATISTICS_PLAN_/.test(error.code));
    }
    const { reportChecksum: originalChecksum,...wrongCount } = statisticsReceipt; wrongCount.unresolvedJobs = 0;
    assert.throws(() => buildStatisticsReconciledRecoveryPlan({ ...nextOptions,
      statisticsReconciliation: { ...wrongCount,reportChecksum: hash(canonicalize(wrongCount)) } }),{ code: "RECOVERY_STATISTICS_PLAN_DELTA_INVALID" });
    assert.equal(originalReader.prepare("SELECT total_changes() n").get().n,0);
    assert.equal(reconciledReader.prepare("SELECT total_changes() n").get().n,0);
  } finally { originalReader.close(); reconciledReader.close(); }
  const nextReviewRequest = { requestVersion: 1,expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,expectedDatabaseId: FIXTURE_DATABASE_ID,
    observedAtMs,preparedDatabasePath: reviewPath,credentialPreparationPath,
    statisticsReview: { originalPlanPath: write("original-plan.json",plan),statisticsReconciliationPath: statisticsReceiptPath,reconciledDatabasePath: reconciledReviewPath } };
  const invokeReview = request => spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-review.js"),
    "--request",write(crypto.randomUUID()+".json",request)],{ encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
  const reviewedStatistics = invokeReview(nextReviewRequest); assert.equal(reviewedStatistics.status,0,reviewedStatistics.stderr);
  assert.deepEqual(JSON.parse(reviewedStatistics.stdout).plan,nextPlan); assert.equal(reviewedStatistics.stderr,"");
  for (const request of [{ ...nextReviewRequest,emailReview: {} },{ ...nextReviewRequest,statisticsReview: { ...nextReviewRequest.statisticsReview,approve: true } }]) {
    const rejected = invokeReview(request); assert.equal(rejected.status,1); assert.equal(rejected.stdout,"");
    assert.equal(JSON.parse(rejected.stderr).error.message,"Recovery review failed safely. No activation was performed.");
  }
  const changedCopy = path.join(input.temporaryRoot,"statistics-review-unrelated-change.sqlite3");
  fs.copyFileSync(commandReport.reconciledDatabasePath,changedCopy,fs.constants.COPYFILE_EXCL);
  const writer = openDatabase({ databasePath: changedCopy,environment: "test" }).database;
  let changedTables;
  try {
    writer.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES('unreviewed_recovery_change','{}',?,?)").run(observedAtMs,observedAtMs);
    changedTables = Object.fromEntries(Object.entries(allRows(writer)).map(([name,rows]) => [name,{ count: rows.length,sha256: hash(canonicalize(rows.map(row => hash(row)).sort())) }]));
  } finally { writer.close(); }
  const { reportChecksum: ignoredChecksum,...forgedBody } = statisticsReceipt;
  forgedBody.reconciledPlaintextSha256 = readHash(changedCopy); forgedBody.tableSnapshots = changedTables;
  const forgedReceipt = { ...forgedBody,reportChecksum: hash(canonicalize(forgedBody)) };
  const originalAgain = openReadonlyDatabase({ databasePath: reviewPath }),changedReader = openReadonlyDatabase({ databasePath: changedCopy });
  try {
    assert.throws(() => buildStatisticsReconciledRecoveryPlan({ ...nextOptions,preparedDatabase: originalAgain,reconciledDatabase: changedReader,
      statisticsReconciliation: forgedReceipt }),{ code: "RECOVERY_STATISTICS_PLAN_DELTA_INVALID" });
    assert.equal(changedReader.prepare("SELECT total_changes() n").get().n,0);
  } finally { originalAgain.close(); changedReader.close(); }
  await t.test("actual recovery commands verify email and statistics lineage in both orders and preserve every predecessor", async () => {
    const copy = file => { const target = path.join(input.temporaryRoot,crypto.randomUUID()+"-lineage-review.sqlite3");fs.copyFileSync(file,target,fs.constants.COPYFILE_EXCL);return target; };
    const readReceipt = (result,kind) => JSON.parse(fs.readFileSync(path.join(path.dirname(result.reconciledDatabasePath),kind+"-reconciliation.json"),"utf8"));
    const messages = before.outbox_events.map(JSON.parse).filter(row => row.league_id === null && ["pending","failed","publishing"].includes(row.status));
    assert.equal(messages.length,3);
    const deliveries = messages.map(message => ({ eventId: message.id,rowSha256: hash(canonicalize(message)),payloadSha256: hash(message.payload_json),
      providerMessageSha256: hash("synthetic-lineage-message:"+message.id),providerReceiptSha256: hash("synthetic-lineage-delivery:"+message.id),deliveredAtMs: now-1 }));
    const { statisticsReview: unused,...commonReview } = nextReviewRequest;
    const reviewLineage = (lineage,currentPath,at) => {
      const execution = invokeReview({ ...commonReview,preparedDatabasePath: currentPath,observedAtMs: at,lineagePath: write(crypto.randomUUID()+"-lineage.json",lineage) });
      assert.equal(execution.status,0,execution.stderr);assert.equal(execution.stderr,"");assert.equal(execution.stdout.includes(PRIVATE_VALUE),false);
      return JSON.parse(execution.stdout);
    };
    const emailCommand = ({ source,candidate,lineage,selected,at }) => {
      const request = { requestVersion: 1,credentialPreparationPath,preparedDatabasePath: source,candidateReviewPath: write(crypto.randomUUID()+"-candidate.json",candidate),
        deliveryReviewPath: write(crypto.randomUUID()+"-delivery.json",{ deliveries: selected }),reviewedByUserId: review.reviewedByUserId,
        reconciliationId: crypto.randomUUID(),reconciledAtMs: at,temporaryRoot: input.temporaryRoot,outputDirectory: path.join(input.temporaryRoot,crypto.randomUUID()+"-email-output"),
        ...(lineage ? { lineagePath: write(crypto.randomUUID()+"-lineage.json",lineage) } : {}) };
      const execution = spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/db-recovery-email.js"),"--request",write(crypto.randomUUID()+"-request.json",request)],
        { encoding: "utf8",timeout: 60_000,maxBuffer: 8*1024*1024 });
      assert.equal(execution.status,0,execution.stderr);assert.equal(execution.stderr,"");assert.equal(execution.stdout.includes(PRIVATE_VALUE),false);
      return JSON.parse(execution.stdout);
    };
    const statsLineage = { initialDatabasePath: reviewPath,initialPlan: plan,
      steps: [{ kind: "statistics",reconciledDatabasePath: reconciledReviewPath,receipt: statisticsReceipt,observedAtMs }] };
    const statsReview = reviewLineage(statsLineage,reconciledReviewPath,observedAtMs);assert.deepEqual(statsReview.plan,nextPlan);
    const firstEmail = emailCommand({ source: commandReport.reconciledDatabasePath,candidate: statsReview,lineage: statsLineage,selected: deliveries.slice(0,1),at: observedAtMs+1 });
    const firstEmailPath = copy(firstEmail.reconciledDatabasePath),firstEmailAt = firstEmail.reconciledAtMs+1;
    const statsThenEmail = { ...statsLineage,steps: [...statsLineage.steps,{ kind: "email",reconciledDatabasePath: firstEmailPath,receipt: readReceipt(firstEmail,"email"),observedAtMs: firstEmailAt }] };
    const firstEmailReview = reviewLineage(statsThenEmail,firstEmailPath,firstEmailAt);
    const secondEmail = emailCommand({ source: firstEmail.reconciledDatabasePath,candidate: firstEmailReview,lineage: statsThenEmail,selected: deliveries.slice(1),at: firstEmailAt+1 });
    const secondEmailPath = copy(secondEmail.reconciledDatabasePath),secondEmailAt = secondEmail.reconciledAtMs+1;
    const completeLineage = { ...statsThenEmail,steps: [...statsThenEmail.steps,{ kind: "email",reconciledDatabasePath: secondEmailPath,receipt: readReceipt(secondEmail,"email"),observedAtMs: secondEmailAt }] };
    const completed = reviewLineage(completeLineage,secondEmailPath,secondEmailAt);
    assert.equal(completed.plan.unresolvedMessages,plan.unresolvedMessages-3);assert.equal(completed.plan.unresolvedJobs,plan.unresolvedJobs-1);
    assert.equal(completed.plan.credentialPreparedPlaintextSha256,preparedHash);assert.equal(completed.activationReady,false);
    assert.equal(completed.plan.statisticsReconciliationChecksum,statisticsReceipt.reportChecksum);

    const emailFirst = emailCommand({ source: prepared.preparedDatabasePath,candidate: reviewed,selected: deliveries,at: now });
    const emailFirstPath = copy(emailFirst.reconciledDatabasePath),emailFirstAt = now+1;
    const emailLineage = { initialDatabasePath: reviewPath,initialPlan: plan,
      steps: [{ kind: "email",reconciledDatabasePath: emailFirstPath,receipt: readReceipt(emailFirst,"email"),observedAtMs: emailFirstAt }] };
    const emailFirstReview = reviewLineage(emailLineage,emailFirstPath,emailFirstAt);
    const chainedStatistics = invoke({ ...commandRequest,preparedDatabasePath: emailFirst.reconciledDatabasePath,
      candidateReviewPath: write("email-first-candidate.json",emailFirstReview),lineagePath: write("email-first-lineage.json",emailLineage),
      decisionPath: write("email-first-statistics-decision.json",{ ...review,reconciliationId: crypto.randomUUID() }),
      outputDirectory: path.join(input.temporaryRoot,"email-first-statistics-output"),executedAtMs: emailFirstAt+1 });
    assert.equal(chainedStatistics.status,0,chainedStatistics.stderr);assert.equal(chainedStatistics.stderr,"");
    const finalStatistics = JSON.parse(chainedStatistics.stdout),finalStatisticsPath = copy(finalStatistics.reconciledDatabasePath),finalStatisticsAt = finalStatistics.completedAtMs+1;
    const emailThenStats = { ...emailLineage,steps: [...emailLineage.steps,{ kind: "statistics",reconciledDatabasePath: finalStatisticsPath,
      receipt: readReceipt(finalStatistics,"statistics"),observedAtMs: finalStatisticsAt }] };
    const reversed = reviewLineage(emailThenStats,finalStatisticsPath,finalStatisticsAt);
    assert.equal(reversed.plan.unresolvedMessages,plan.unresolvedMessages-3);assert.equal(reversed.plan.unresolvedJobs,plan.unresolvedJobs-1);
    assert.equal(reversed.plan.credentialPreparedPlaintextSha256,preparedHash);assert.equal(reversed.activationReady,false);
    assert.equal(reversed.plan.emailReconciliationChecksum,emailFirst.reportChecksum);
    const files = [prepared.preparedDatabasePath,reviewPath,commandReport.reconciledDatabasePath,reconciledReviewPath,firstEmail.reconciledDatabasePath,
      firstEmailPath,secondEmail.reconciledDatabasePath,secondEmailPath,emailFirst.reconciledDatabasePath,emailFirstPath,finalStatistics.reconciledDatabasePath,finalStatisticsPath];
    const hashes = files.map(readHash);
    for (const invalid of [
      { ...completeLineage,steps: [...completeLineage.steps].reverse() },
      { ...completeLineage,steps: completeLineage.steps.slice(1) },
      { ...completeLineage,steps: [completeLineage.steps[0],completeLineage.steps[0]] },
      { ...completeLineage,steps: Array(33).fill(completeLineage.steps[0]) },
      { ...completeLineage,initialPlan: { ...plan,unresolvedJobs: 0 } },
      { ...completeLineage,approve: true },
    ]) {
      const rejected = invokeReview({ ...commonReview,preparedDatabasePath: secondEmailPath,observedAtMs: secondEmailAt,lineagePath: write(crypto.randomUUID()+"-invalid-lineage.json",invalid) });
      assert.equal(rejected.status,1);assert.equal(rejected.stdout,"");assert.match(JSON.parse(rejected.stderr).error.code,/^RECOVERY_LINEAGE_/);
    }
    const held = openReadonlyDatabase({ databasePath: secondEmailPath });
    try {
      assertCredentialAccess(held,false);assert.equal(held.prepare("SELECT total_changes() n").get().n,0);
      assert.throws(() => readVerifiedRecoveryParent({ parentProof: {},database: held,originalPlan: completed.plan,credentialPreparation: prepared }),{ code: "RECOVERY_LINEAGE_PARENT_INVALID" });
      assert.throws(() => buildRecoveryPlanFromLineage({ database: held,credentialPreparation: prepared,lineage: statsLineage,
        observedAtMs,expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,expectedDatabaseId: FIXTURE_DATABASE_ID }),{ code: "RECOVERY_LINEAGE_CANDIDATE_MISMATCH" });
      assert.equal(held.prepare("SELECT total_changes() n").get().n,0);
    } finally { held.close(); }
    let attemptedProviderReads = 0;
    const rejectedOutput = path.join(input.temporaryRoot,"invalid-lineage-statistics-output");
    await assert.rejects(() => prepareRecoveryStatisticsReconciliation({ ...options,credentialPreparation: { ...prepared,preparedDatabasePath: emailFirst.reconciledDatabasePath },
      plan: emailFirstReview.plan,lineage: { ...emailLineage,steps: [] },executedAtMs: emailFirstAt+1,outputDirectory: rejectedOutput,
      fetchImpl: async () => { attemptedProviderReads++;throw Error("invalid lineage must not contact provider"); } }),{ code: "RECOVERY_STATISTICS_FAILED" });
    assert.equal(attemptedProviderReads,0);assert.equal(fs.existsSync(rejectedOutput),false);
    assert.deepEqual(files.map(readHash),hashes);assert.deepEqual(started.runtime.database.serialize(),sourceBytes);
  });
  assert.equal(readHash(commandReport.reconciledDatabasePath),commandHash); assert.equal(readHash(reconciledReviewPath),commandHash);
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
