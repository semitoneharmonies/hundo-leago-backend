const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createReleaseQaRuntime } = require("../../src/operations/release/createReleaseQaRuntime");
const { fixtureId, FIXTURE_NOW_MS, FIXTURE_DATABASE_ID, FIXTURE_ENVIRONMENT_ID, canonicalize } = require("../../src/operations/release/releaseQaFixtureContract");
const { createTargetServices, createTargetRuntime } = require("../../src/bootstrap/createTargetRuntime");
const { createSecureRandom } = require("../../src/infrastructure/security/createSecureRandom");
const { openDatabase, openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { createTargetHttpServer } = require("../../src/bootstrap/createTargetHttpServer");
const { assertRecoveryRuntimeAllowed } = require("../../src/infrastructure/database/recoveryHold");
const { loadBackupConfig } = require("../../src/config/loadBackupConfig");
const { createObjectStorageAdapter } = require("../../src/infrastructure/backups/createObjectStorageAdapter");
const { createEncryptedOffsiteBackup } = require("../../src/operations/backups/createEncryptedOffsiteBackup");
const { restoreEncryptedBackupToCleanPath } = require("../../src/operations/backups/restoreEncryptedBackupToCleanPath");
const { prepareRecoveryCredentials } = require("../../src/operations/backups/prepareRecoveryCredentials");
const { buildRecoveryReconciliationPlan } = require("../../src/operations/backups/buildRecoveryReconciliationPlan");
const { buildRecoveryPlanFromLineage } = require("../../src/operations/backups/buildRecoveryReconciliationLineage");
const { prepareRecoveryInvalidationReconciliation } = require("../../src/operations/backups/prepareRecoveryInvalidationReconciliation");
const { startRecoveryMaintenanceSession } = require("../../src/operations/backups/startRecoveryMaintenanceSession");
const { readRows, snapshots, hash, buildKnownBuyoutEvidence } = require("../../src/operations/backups/recoveryKnownBuyoutEvidence");
const { createVerifiedBackup, BACKUP_FILE_NAME } = require("../../src/infrastructure/database/sqliteBackup");
const { prepareRecoveryKnownBuyout } = require("../../src/operations/backups/prepareRecoveryKnownBuyout");
const { prepareRecoveryTradeExpiryReconciliation } = require("../../src/operations/backups/prepareRecoveryTradeExpiryReconciliation");
const { createSqliteTradeExpiryRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteTradeExpiryRepository");
const { createExpireTradeProposalsJob } = require("../../src/jobs/definitions/expireTradeProposals");
const { buildTradeExpiryOccurrenceKey } = require("../../src/domain/trades/tradeLifecyclePolicy");
const { createRuntimeHealthService } = require("../../src/application/services/operations/createRuntimeHealthService");
const { createPublicHealthRouter } = require("../../src/transport/http/createPublicHealthRouter");
const { createOperationsHealthRouter } = require("../../src/transport/http/createOperationsHealthRouter");

const PASSWORD = "Recovery Maintenance Fixture Password 2026!";
const ORIGIN = "http://127.0.0.1:5173";
const PRODUCTION_ORIGIN = "https://recovery-profile.example.test";
const migrationsDirectory = path.resolve(__dirname, "../../database/migrations");
const readHash = file => hash(fs.readFileSync(file));

async function fixture(t, { rehearsalNowMs = null, recoverKnownLoss = false, backupEnvironment = "staging" } = {}) {
  const started = await createReleaseQaRuntime({ frontendOrigin: ORIGIN, leagueWriteMode: "closed", port: 0, migrationsDirectory, password: PASSWORD });
  t.after(() => started.close());
  let now = rehearsalNowMs ?? Date.now();
  let interrupted = null, knownLoss = null;
  if (recoverKnownLoss) {
    const trade = started.runtime.database.prepare("SELECT * FROM trades WHERE league_id=? AND status='proposed' " +
      "AND proposal_model_version=2 AND effective_deadline_at_ms IS NOT NULL ORDER BY effective_deadline_at_ms,id LIMIT 1")
      .get(fixtureId("league:leagueA"));
    assert.ok(trade);
    now = trade.effective_deadline_at_ms - 1000;
    const oldOwner = "integrated-recovery-before-backup";
    const occurrenceKey = buildTradeExpiryOccurrenceKey({ tradeId: trade.id, effectiveDeadlineAtMs: trade.effective_deadline_at_ms });
    const oldClaim = createSqliteTradeExpiryRepository({ database: started.runtime.database }).claimRun({
      jobRunId: crypto.randomUUID(), leagueId: trade.league_id, seasonId: trade.season_id, occurrenceKey,
      scheduledForMs: trade.effective_deadline_at_ms, leaseOwner: oldOwner, nowMs: now, leaseExpiresAtMs: now + 60_000 });
    assert.equal(oldClaim.acquired, true);
    interrupted = { trade, oldOwner, oldClaim };
  }
  const securityFoundations = { config: backupEnvironment === "production"
    ? { ...started.runtime.securityConfig, appEnv: "production", publicFrontendOrigin: PRODUCTION_ORIGIN,
      frontendOrigins: [PRODUCTION_ORIGIN], isAllowedFrontendOrigin: origin => origin === PRODUCTION_ORIGIN, sessionCookieSameSite: "lax" }
    : started.runtime.securityConfig, clock: { nowMs: () => now }, secureRandom: createSecureRandom(),
    logger: { info() {}, warn() {}, error() {} } };
  const currentSeason = { label: "2026", nhlSeasonKey: "20262027" };
  const originalServices = createTargetServices({ repositories: started.runtime.repositories, securityFoundations, currentSeason,
    leagueInvalidationPublisher: { publish() { assert.fail("Fixture setup cannot publish."); } }, nhlFetchImplementation: async () => { assert.fail("Fixture setup cannot fetch a provider."); } });
  const oldSession = originalServices.sessionService.issueForUser({ userId: fixtureId("account:leagueAManagerOne") });
  assert.equal(originalServices.sessionService.resolveWithoutActivity(oldSession.rawSessionToken).valid, true);
  const historicalSession = recoverKnownLoss ? originalServices.sessionService.issueForUser({ userId: fixtureId("account:leagueBManagerOne") }) : null;
  const encryptionKey = crypto.randomBytes(32), objects = new Map();
  const objectStorage = createObjectStorageAdapter({ client: {
    async putObject({ key, body, visibility }) { assert.equal(visibility,"private");objects.set(key,Buffer.from(body));return { stored: true }; },
    async headObject({ key }) { const body = objects.get(key);return body ? { byteSize: body.length,sha256: hash(body) } : null; },
    async getObject({ key }) { return { body: Buffer.from(objects.get(key)) }; },
  } });
  const config = loadBackupConfig({ env: { BACKUP_LOCAL_DIR: path.join(started.temporaryRoot,"backup-work"),BACKUP_OBJECT_ENDPOINT: "https://release-qa.invalid",
    BACKUP_OBJECT_REGION: "local-1",BACKUP_OBJECT_BUCKET: "hundo-release-qa",BACKUP_OBJECT_PREFIX: "m7/maintenance/",BACKUP_OBJECT_ACCESS_KEY_ID: "local-release-qa",
    BACKUP_OBJECT_SECRET_ACCESS_KEY: "fixture-only",BACKUP_ENCRYPTION_KEY_VERSION: "maintenance-local-v1",BACKUP_ENCRYPTION_KEY: encryptionKey.toString("base64url"),BACKUP_SCHEDULE_ENABLED: "false" },
    runtimeConfig: { appEnv: backupEnvironment,persistentRoot: started.temporaryRoot,environmentId: FIXTURE_ENVIRONMENT_ID,databaseId: FIXTURE_DATABASE_ID } });
  const backup = await createEncryptedOffsiteBackup({ databasePath: started.databasePath,config,objectStorage,reason: "pre-cutover-rehearsal",
    requestedByType: "release_qa_automation",requestedById: "maintenance-fixture",backendBuildId: "local-maintenance-fixture",retentionClass: "incident-preservation",nowMs: () => now });
  if (recoverKnownLoss) {
    const before = readRows(started.runtime.database);
    now += 2000;
    const boughtOut = await originalServices.league.rosterAction.buyOutContract({
      authenticated: originalServices.sessionService.resolveWithoutActivity(historicalSession.rawSessionToken),
      leagueId: fixtureId("league:leagueB"), teamId: fixtureId("team:leagueB:6"), contractId: fixtureId("contract:leagueB:signedProspect"),
      input: { confirmed: true, expectedContractVersion: 1, expectedOwnershipVersion: 1 } });
    assert.equal(boughtOut.code, "CONTRACT_BOUGHT_OUT");
    const preserved = await createVerifiedBackup({ databasePath: started.databasePath,
      outputDirectory: path.join(started.temporaryRoot, "preserved-known-loss"), environment: config.appEnv,
      reason: "incident-preservation", capturedAtMs: now, temporaryRoot: started.temporaryRoot });
    const backupManifestPath = path.join(started.temporaryRoot, "selected-backup-manifest.json");
    fs.writeFileSync(backupManifestPath, (await objectStorage.getPrivateObject({ objectKey: backup.manifestObjectKey })).body, { flag: "wx" });
    knownLoss = { boughtOut, before, preserved, backupManifestPath,
      preservationManifestPath: path.join(preserved.outputDirectory, "backup-manifest.json") };
  }
  const restored = await restoreEncryptedBackupToCleanPath({ manifestObjectKey: backup.manifestObjectKey,objectStorage,keyResolver: async () => encryptionKey,
    expectedEnvironment: config.appEnv,expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,
    targetDatabasePath: path.join(started.temporaryRoot,"restored.sqlite3"),temporaryRoot: started.temporaryRoot });
  if (!recoverKnownLoss) now = rehearsalNowMs ?? Date.now();
  const prepared = prepareRecoveryCredentials({ restoredCandidate: restored,temporaryRoot: started.temporaryRoot,
    expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId,recoveryId: crypto.randomUUID(),preparedAtMs: now,
    outputDirectory: path.join(started.temporaryRoot,"prepared") });
  const preservedPath = path.join(started.temporaryRoot,"preserved.sqlite3");
  fs.copyFileSync(knownLoss ? path.join(knownLoss.preserved.outputDirectory, BACKUP_FILE_NAME) : restored.targetDatabasePath,preservedPath,fs.constants.COPYFILE_EXCL);
  const sources = [prepared.preparedDatabasePath,restored.targetDatabasePath,preservedPath].map(databasePath => openReadonlyDatabase({ databasePath }));
  const sourceHashes = sources.map(database => readHash(database.name));
  const plan = buildRecoveryReconciliationPlan({ database: sources[0],credentialPreparation: prepared,observedAtMs: now,
    expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId });
  if (knownLoss) {
    assert.deepEqual(snapshots(readRows(sources[1])), snapshots(knownLoss.before));
    assert.equal(sources[0].prepare("SELECT id FROM buyout_obligations WHERE id=?").get(knownLoss.boughtOut.buyout.id), undefined);
    assert.equal(sources[0].prepare("SELECT status FROM contracts WHERE id=?").get(fixtureId("contract:leagueB:signedProspect")).status, "active");
    assert.equal(sources[2].prepare("SELECT status FROM contracts WHERE id=?").get(fixtureId("contract:leagueB:signedProspect")).status, "eliminated");
  }
  return { started,config,prepared,sources,sourceHashes,oldSession,securityFoundations,currentSeason,now,objectStorage,encryptionKey,originalBackup: backup,
    interrupted, knownLoss,
    setNow(value) { now = value; },
    options: { reviewOptions: { candidateDatabase: sources[0],restoredDatabase: sources[1],preservedDatabase: sources[2],credentialPreparation: prepared,plan,
      observedAtMs: now,preservedPlaintextSha256: sourceHashes[2],expectedEnvironmentId: config.environmentId,expectedDatabaseId: config.databaseId },
      temporaryRoot: started.temporaryRoot,outputDirectory: path.join(started.temporaryRoot,"maintenance"),migrationsDirectory,
      securityFoundations,currentSeason,backendBuildId: "local-maintenance-fixture" } };
}

async function request(baseUrl, pathname, { method="GET",cookie,csrf,body,origin=ORIGIN,timeoutMs=10000,idempotencyKey }={}) {
  const response = await fetch(new URL(pathname,baseUrl),{ method,headers: { Origin: origin,
    ...(cookie ? { Cookie: cookie } : {}),...(csrf ? { "X-CSRF-Token": csrf } : {}),...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();return { status: response.status,headers: response.headers,text,json: text ? JSON.parse(text) : null };
}

// Real Engine.IO polling and Socket.IO namespace packets, with no mocked
// authorization or room membership and no additional client dependency.
async function socketSession(baseUrl, cookie, origin = ORIGIN) {
  const headers = { Origin: origin,Cookie: cookie };
  const opening = await fetch(baseUrl+"/socket.io/?EIO=4&transport=polling",{ headers,signal: AbortSignal.timeout(5000) });
  const initial = await opening.text();assert.equal(opening.status,200,initial);assert.equal(initial[0],"0");
  const sid = JSON.parse(initial.slice(1)).sid, url = baseUrl+"/socket.io/?EIO=4&transport=polling&sid="+encodeURIComponent(sid);
  const send = async body => { const response = await fetch(url,{ method: "POST",headers: { ...headers,"Content-Type": "text/plain;charset=UTF-8" },body,signal: AbortSignal.timeout(5000) });
    assert.equal(response.status,200,await response.text()); };
  await send("40");
  const response = await fetch(url,{ headers,signal: AbortSignal.timeout(5000) }), packet = await response.text();
  return { packet,send,async receive() { const response = await fetch(url,{ headers,signal: AbortSignal.timeout(5000) });return response.text(); },
    async close() { try { await send("1"); } catch {} } };
}

const requestWithOrigin = request;
for (const { recoverKnownLoss, backupEnvironment } of [
  { recoverKnownLoss: false, backupEnvironment: "staging" },
  { recoverKnownLoss: true, backupEnvironment: "staging" },
  { recoverKnownLoss: false, backupEnvironment: "production" },
]) test(backupEnvironment === "production"
  ? "production-profile temporary recovery preserves its backup environment through reopening and restore"
  : recoverKnownLoss
  ? "known lost buyout and interrupted expiry reach reviewed reopening and exact post-recovery backup"
  : "fully reconciled normal fixture reaches authenticated maintenance and encrypted backup without pending work", async t => {
  const f = await fixture(t, { rehearsalNowMs: FIXTURE_NOW_MS + 60_000, recoverKnownLoss, backupEnvironment });
  const request = (baseUrl, pathname, options = {}) => requestWithOrigin(baseUrl, pathname,
    { origin: backupEnvironment === "production" ? PRODUCTION_ORIGIN : ORIGIN, ...options });
  let maintenance, candidateReader, administrator, reopening, reviewedResponse, correctionReceipt, duringBackup = null;
  const intermediateReaders = [];
  try {
    const basePlan = f.options.reviewOptions.plan;
    assert.equal(basePlan.unresolvedJobs, recoverKnownLoss ? 1 : 0); assert.equal(basePlan.unresolvedMessages, 14);
    const lineage = { initialDatabasePath: f.sources[0].name, initialPlan: basePlan, steps: [] };
    let operationPlan = basePlan, operationReader = f.sources[0], operationDatabasePath = f.prepared.preparedDatabasePath;
    const appendStep = (kind, result, receipt, extra = {}) => {
      const inspectionPath = path.join(f.started.temporaryRoot, kind + "-inspection.sqlite3");
      fs.copyFileSync(result.reconciledDatabasePath, inspectionPath, fs.constants.COPYFILE_EXCL);
      const reader = openReadonlyDatabase({ databasePath: inspectionPath }); intermediateReaders.push(reader);
      lineage.steps.push({ kind, reconciledDatabasePath: inspectionPath, receipt, observedAtMs: f.now, ...extra });
      operationPlan = buildRecoveryPlanFromLineage({ database: reader, credentialPreparation: f.prepared, lineage,
        observedAtMs: f.now, expectedEnvironmentId: f.config.environmentId, expectedDatabaseId: f.config.databaseId });
      operationReader = reader; operationDatabasePath = result.reconciledDatabasePath;
    };
    if (recoverKnownLoss) await t.test("reconstructs the preserved buyout then reconciles only the exact interrupted trade occurrence", async () => {
      const reviewOptions = { preparedDatabase: operationReader, restoredDatabase: f.sources[1], preservedDatabase: f.sources[2],
        credentialPreparation: f.prepared, plan: operationPlan, buyoutId: f.knownLoss.boughtOut.buyout.id,
        leagueId: fixtureId("league:leagueB"), preservedPlaintextSha256: f.sourceHashes[2], observedAtMs: f.now,
        backupManifestBytes: fs.readFileSync(f.knownLoss.backupManifestPath), preservationManifestBytes: fs.readFileSync(f.knownLoss.preservationManifestPath) };
      reviewOptions.expectedBackupManifestSha256 = hash(reviewOptions.backupManifestBytes);
      reviewOptions.expectedPreservationManifestSha256 = hash(reviewOptions.preservationManifestBytes);
      const { review } = buildKnownBuyoutEvidence(reviewOptions);
      assert.equal(review.provenance.offlineManifestBindingVerified, true);
      const notification = f.sources[2].prepare("SELECT * FROM outbox_events WHERE league_id=? AND aggregate_id=? AND event_type='contract.changed'")
        .get(review.leagueId, review.contractId);
      assert.equal(notification.status, "pending");
      assert.equal(JSON.parse(notification.payload_json).resourceId, review.contractId);
      assert.deepEqual(review.effects.filter(effect => ["outbox_events", "outbox_event_audiences"].includes(effect.table)).map(effect => ({
        table: effect.table, id: effect.id, beforeSha256: effect.beforeSha256,
      })), [{ table: "outbox_events", id: notification.id, beforeSha256: null },
        { table: "outbox_event_audiences", id: notification.id, beforeSha256: null }]);
      const recovered = await prepareRecoveryKnownBuyout({ reviewOptions, decision: { reconciliationId: crypto.randomUUID(),
        action: "reconstruct-known-buyout-held", reviewedByUserId: fixtureId("account:platformAdmin"), reviewChecksum: review.reportChecksum,
        evidenceSha256: review.evidenceSha256, reasonCode: "RECOVER_PRESERVED_BUYOUT" }, temporaryRoot: f.started.temporaryRoot,
        outputDirectory: path.join(f.started.temporaryRoot, "known-buyout-recovered") });
      appendStep("known-buyout", recovered, recovered, { restoredDatabasePath: f.sources[1].name, preservedDatabasePath: f.sources[2].name,
        backupManifestPath: f.knownLoss.backupManifestPath, preservationManifestPath: f.knownLoss.preservationManifestPath });
      assert.equal(operationPlan.unresolvedMessages, basePlan.unresolvedMessages + 1);
      assert.deepEqual(operationReader.prepare("SELECT * FROM outbox_events WHERE id=?").get(notification.id), notification);
      assert.deepEqual(operationReader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=?").all(notification.id),
        f.sources[2].prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=?").all(notification.id));
      for (const table of new Set(review.effects.map(effect => effect.table))) {
        assert.deepEqual(readRows(operationReader)[table], readRows(f.sources[2])[table], table);
      }
      const { trade, oldOwner, oldClaim } = f.interrupted;
      const stalePath = path.join(f.started.temporaryRoot, "previous-worker-check.sqlite3");
      fs.copyFileSync(operationDatabasePath, stalePath, fs.constants.COPYFILE_EXCL);
      const staleDatabase = openDatabase({ databasePath: stalePath, environment: "test" }).database;
      try {
        const repository = createSqliteTradeExpiryRepository({ database: staleDatabase }), before = snapshots(readRows(staleDatabase));
        const stale = await createExpireTradeProposalsJob({ repository: { ...repository,
          listDue(query) { return repository.listDue({ ...query, limit: 100 }).filter(row => row.tradeId === trade.id); },
          claimRun() { return oldClaim; } }, clock: { nowMs: () => f.now }, secureRandom: createSecureRandom(), leaseOwner: oldOwner,
          logger: { error() {} } }).run();
        assert.equal(stale.expired, 0); assert.equal(stale.skipped, 1);
        assert.deepEqual(snapshots(readRows(staleDatabase)), before); assert.equal(staleDatabase.prepare("SELECT total_changes() n").get().n, 0);
      } finally { staleDatabase.close(); }
      const row = operationReader.prepare("SELECT * FROM job_runs WHERE id=?").get(oldClaim.runId);
      const outputDirectory = path.join(f.started.temporaryRoot, "interrupted-expiry-recovered");
      // Prior verification may leave empty SQLite reader sidecars. Give the
      // next operation a byte-identical clean input, retaining every receipt.
      const expirySource = path.join(f.started.temporaryRoot, "expiry-source.sqlite3");
      fs.copyFileSync(operationDatabasePath, expirySource, fs.constants.COPYFILE_EXCL);
      assert.equal(readHash(expirySource), operationPlan.preparedPlaintextSha256);
      const expired = await prepareRecoveryTradeExpiryReconciliation({ credentialPreparation: { ...f.prepared, preparedDatabasePath: expirySource },
        plan: operationPlan, lineage, review: { reconciliationId: crypto.randomUUID(), reviewedByUserId: fixtureId("account:platformAdmin"),
          reasonCode: "REVIEWED_ORIGINAL_TRADE_DEADLINE", evidenceSha256: hash("integrated local drill exact preserved trade deadline"),
          jobId: row.id, leagueId: trade.league_id, seasonId: trade.season_id, tradeId: trade.id, deadlineAtMs: trade.effective_deadline_at_ms,
          rowSha256: hash(canonicalize(row)), tradeRowSha256: hash(canonicalize(trade)),
          occurrenceKeySha256: hash(canonicalize([row.league_id, row.job_type, row.occurrence_key])) }, executedAtMs: f.now,
        temporaryRoot: f.started.temporaryRoot, outputDirectory });
      appendStep("trade-expiry", expired, JSON.parse(fs.readFileSync(path.join(outputDirectory, "trade-expiry-reconciliation.json"), "utf8")));
      assert.equal(operationPlan.unresolvedJobs, 0); assert.equal(operationPlan.unresolvedMessages, 16);
      assert.equal(operationReader.prepare("SELECT status FROM job_runs WHERE id=?").get(row.id).status, "succeeded");
      assert.equal(operationReader.prepare("SELECT status FROM trades WHERE id=?").get(trade.id).status, "expired");
    });
    const expectedSuppressed = recoverKnownLoss ? 16 : 14;
    const events = operationReader.prepare("SELECT * FROM outbox_events WHERE status='pending' ORDER BY id").all().map(row => {
      assert.ok(row.event_type === "trade.changed" || (recoverKnownLoss && row.event_type === "contract.changed"));
      const audiences = operationReader.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? ORDER BY id").all(row.id);
      return { eventId: row.id, leagueId: row.league_id, rowSha256: hash(canonicalize(row)), payloadSha256: hash(row.payload_json),
        audienceSha256: hash(canonicalize(audiences.map(audience => hash(canonicalize(audience))).sort())),
        reasonCode: "REVIEWED_NORMAL_FIXTURE_REFRESH", evidenceSha256: hash("synthetic normal-fixture refresh review:" + row.id) };
    });
    const operationSource = path.join(f.started.temporaryRoot, "reconciliation-source.sqlite3");
    fs.copyFileSync(operationDatabasePath, operationSource, fs.constants.COPYFILE_EXCL);
    const suppressed = prepareRecoveryInvalidationReconciliation({ credentialPreparation: { ...f.prepared, preparedDatabasePath: operationSource },
      plan: operationPlan, lineage: lineage.steps.length ? lineage : null, events, eventScope: "reviewed-candidate", reviewedByUserId: fixtureId("account:platformAdmin"),
      reconciliationId: crypto.randomUUID(), reconciledAtMs: f.now, temporaryRoot: f.started.temporaryRoot,
      outputDirectory: path.join(f.started.temporaryRoot, "all-refreshes-reconciled") });
    assert.equal(suppressed.suppressedEvents, expectedSuppressed); assert.equal(suppressed.unresolvedMessages, 0);
    const candidatePath = path.join(f.started.temporaryRoot, "reconciled-inspection.sqlite3");
    fs.copyFileSync(suppressed.reconciledDatabasePath, candidatePath, fs.constants.COPYFILE_EXCL);
    candidateReader = openReadonlyDatabase({ databasePath: candidatePath });
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(suppressed.reconciledDatabasePath), "invalidation-reconciliation.json"), "utf8"));
    lineage.steps.push({ kind: "invalidation", reconciledDatabasePath: candidatePath, receipt, observedAtMs: f.now + 1 });
    const plan = buildRecoveryPlanFromLineage({ database: candidateReader, credentialPreparation: f.prepared, lineage,
      observedAtMs: f.now + 1, expectedEnvironmentId: f.config.environmentId, expectedDatabaseId: f.config.databaseId });
    assert.equal(plan.unresolvedJobs, 0); assert.equal(plan.unresolvedMessages, 0); assert.equal(plan.activationReady, false);
    f.setNow(f.now + 2);
    const reopeningStorage = { ...f.objectStorage, async putPrivateObject(input) {
      const action = duringBackup; duringBackup = null; if (action) await action(); return f.objectStorage.putPrivateObject(input);
    } };
    const maintenanceOptions = { ...f.options, reopeningBackup: { config: f.config, objectStorage: reopeningStorage }, reviewOptions: { ...f.options.reviewOptions,
      candidateDatabase: candidateReader, plan, lineage, observedAtMs: f.now + 2 } };
    if (backupEnvironment === "production") await t.test("cross-environment backup configurations are refused before any copy or upload", async () => {
      const sourceHash = readHash(candidatePath), outputBefore = fs.readdirSync(f.started.temporaryRoot).sort();
      const forbiddenStorage = { async putPrivateObject() { assert.fail("A mismatched backup cannot upload."); } };
      await assert.rejects(startRecoveryMaintenanceSession({ ...maintenanceOptions,
        reopeningBackup: { config: { ...f.config, appEnv: "staging" }, objectStorage: forbiddenStorage } }),
      { code: "RECOVERY_MAINTENANCE_BACKUP_ENVIRONMENT_INVALID" });
      await assert.rejects(startRecoveryMaintenanceSession({ ...maintenanceOptions,
        securityFoundations: { ...f.securityFoundations, config: { ...f.securityFoundations.config, appEnv: "staging" } },
        reopeningBackup: { config: f.config, objectStorage: forbiddenStorage } }),
      { code: "RECOVERY_MAINTENANCE_BACKUP_ENVIRONMENT_INVALID" });
      assert.deepEqual(fs.readdirSync(f.started.temporaryRoot).sort(), outputBefore);
      assert.equal(readHash(candidatePath), sourceHash);
    });
    maintenance = await startRecoveryMaintenanceSession(maintenanceOptions);
    await t.test("fresh administrator review sees the exact reconciled copy and records its remaining financial follow-ups", async () => {
      const endpoint = "/api/v1/operations/recovery/review";
      assert.equal((await request(maintenance.baseUrl, endpoint)).status, 401);
      const email = candidateReader.prepare("SELECT email_normalized FROM users WHERE id=?").get(fixtureId("account:platformAdmin")).email_normalized;
      const login = await request(maintenance.baseUrl, "/api/v1/session", { method: "POST", body: { email, password: PASSWORD } });
      assert.equal(login.status, 200, login.text);
      administrator = { cookie: login.headers.get("set-cookie").split(";")[0], csrf: login.json.data.csrfToken };
      const review = await request(maintenance.baseUrl, endpoint, administrator);
      assert.equal(review.status, 200, review.text);
      assert.equal(review.json.data.candidatePlaintextSha256, suppressed.reconciledPlaintextSha256);
      assert.deepEqual(review.json.data.dispositions.jobs, []); assert.deepEqual(review.json.data.dispositions.messages, []);
      assert.equal(review.json.data.dispositions.unresolvedJobs, 0); assert.equal(review.json.data.dispositions.unresolvedMessages, 0);
      assert.equal(review.json.data.gates.find(gate => gate.id === "exact-job-and-outbox-dispositions").status, "no-held-records");
      const loss = review.json.data.recordedLossProgress;
      if (recoverKnownLoss) {
        assert.ok(loss.totalChangedRecords > 0); assert.equal(loss.counts.matchesPreserved, loss.totalChangedRecords - 1);
        assert.equal(loss.counts.stillAtBackupState, 0); assert.equal(loss.counts.differentFromBoth, 1);
        const historicalNotification = f.sources[2].prepare("SELECT * FROM outbox_events WHERE event_type='contract.changed'").get();
        const heldNotification = candidateReader.prepare("SELECT * FROM outbox_events WHERE id=?").get(historicalNotification.id);
        assert.equal(historicalNotification.status, "pending"); assert.equal(heldNotification.status, "discarded");
        const reconciledNotification = loss.tables.outbox_events.filter(row => row.status === "differentFromBoth");
        assert.equal(reconciledNotification.length, 1);
        assert.equal(reconciledNotification[0].preservedRowSha256, hash(canonicalize(historicalNotification)));
        assert.equal(reconciledNotification[0].candidateRowSha256, hash(canonicalize(heldNotification)));
      } else assert.equal(loss.totalChangedRecords, 0);
      const correctionReview = review.json.meta.correctionReview;
      assert.equal(correctionReview.findings.length, 2);
      const tracked = await request(maintenance.baseUrl, "/api/v1/operations/recovery/corrections", { ...administrator, method: "POST",
        body: { reportChecksum: review.json.data.reportChecksum, reviewToken: correctionReview.reviewToken,
          corrections: correctionReview.findings.map((finding, index) => ({ findingSha256: finding.findingSha256,
            disposition: "tracked-for-correction", trackingReference: "LOCAL-RECONCILED-FIXTURE-" + (index + 1) })) } });
      assert.equal(tracked.status, 201, tracked.text); assert.equal(tracked.json.data.trackedFindingCount, 2);
      assert.equal(tracked.json.data.activationReady, false); assert.equal(tracked.json.data.currentOperatorApproval, false);
      assert.equal(review.json.data.activationReady, false);
      reviewedResponse = review.json; correctionReceipt = tracked.json.data;
    });
    await t.test("only a current reviewed administrator can prepare one backed-up reopening copy", async () => {
      const endpoint = "/api/v1/operations/recovery/reopening-copy";
      const body = { mode: "prepare-isolated-copy", reviewToken: reviewedResponse.meta.correctionReview.reviewToken,
        reportChecksum: reviewedResponse.data.reportChecksum, correctionReviewChecksum: correctionReceipt.reportChecksum,
        lossWindowReference: "LOCAL-REOPENING-RECORDED-LOSS-REVIEW" };
      const post = (input, options = {}) => request(maintenance.baseUrl, endpoint,
        { ...administrator, method: "POST", body: input, timeoutMs: 30_000, ...options });
      assert.equal((await request(maintenance.baseUrl, endpoint, { method: "POST", body })).status, 401);
      assert.equal((await post(body, { csrf: undefined })).status, 403);
      assert.equal((await post(body, { origin: "https://untrusted.invalid" })).status, 403);
      assert.equal((await post({ ...body, mode: "production" })).status, 400);
      assert.equal((await post({ ...body, correctionReviewChecksum: null })).status, 409);
      assert.equal((await post({ ...body, reviewToken: crypto.randomUUID() })).status, 409);
      duringBackup = async () => { throw new Error("Synthetic private backup unavailable"); };
      assert.equal((await post(body)).status, 409);
      assert.deepEqual(fs.readdirSync(path.dirname(maintenance.databasePath)).filter(name => name.startsWith("reopening-")), []);
      duringBackup = async () => {
        const concurrent = await post(body); assert.equal(concurrent.status, 409, concurrent.text);
        assert.equal(concurrent.json.error.code, "RECOVERY_REOPENING_IN_PROGRESS");
        const signedOut = await request(maintenance.baseUrl, "/api/v1/session", { ...administrator, method: "DELETE", body: {} });
        assert.equal(signedOut.status, 200, signedOut.text);
      };
      const interrupted = await post(body); assert.equal(interrupted.status, 403, interrupted.text);
      assert.equal(interrupted.json.error.code, "RECOVERY_FRESH_SIGN_IN_REQUIRED");
      assert.deepEqual(fs.readdirSync(path.dirname(maintenance.databasePath)).filter(name => name.startsWith("reopening-")), []);
      assert.throws(() => assertRecoveryRuntimeAllowed(candidateReader), { code: "DATABASE_RECOVERY_HELD" });
      const email = candidateReader.prepare("SELECT email_normalized FROM users WHERE id=?").get(fixtureId("account:platformAdmin")).email_normalized;
      const login = await request(maintenance.baseUrl, "/api/v1/session", { method: "POST", body: { email, password: PASSWORD } });
      assert.equal(login.status, 200, login.text);
      administrator = { cookie: login.headers.get("set-cookie").split(";")[0], csrf: login.json.data.csrfToken };
      const renewed = await request(maintenance.baseUrl, "/api/v1/operations/recovery/review", administrator);
      assert.equal(renewed.status, 200, renewed.text);
      const trackedAgain = await request(maintenance.baseUrl, "/api/v1/operations/recovery/corrections", { ...administrator, method: "POST", body: {
        reportChecksum: renewed.json.data.reportChecksum, reviewToken: renewed.json.meta.correctionReview.reviewToken,
        corrections: renewed.json.meta.correctionReview.findings.map((finding, index) => ({ findingSha256: finding.findingSha256,
          disposition: "tracked-for-correction", trackingReference: "LOCAL-RECONCILED-FIXTURE-" + (index + 1) })) } });
      assert.equal(trackedAgain.status, 201, trackedAgain.text);
      body.reportChecksum = renewed.json.data.reportChecksum; body.reviewToken = renewed.json.meta.correctionReview.reviewToken;
      body.correctionReviewChecksum = trackedAgain.json.data.reportChecksum;
      const preparedCopy = await post(body); assert.equal(preparedCopy.status, 201, preparedCopy.text);
      reopening = preparedCopy.json.data;
      assert.equal(reopening.status, "controlled-reopening-copy-prepared"); assert.equal(reopening.currentOperatorApproval, true);
      assert.equal(reopening.scope, "isolated-reopening-copy"); assert.equal(reopening.productionActivationApproved, false);
      assert.equal(reopening.backupEnvironment, backupEnvironment);
      assert.equal(reopening.financialCorrections.length, 2);
      assert.equal(reopening.sourceBackupId, f.originalBackup.backupId);
      assert.equal(reopening.preservedPlaintextSha256, f.sourceHashes[2]);
      assert.equal(reopening.recoveryComplete, false); assert.equal(reopening.preReopeningBackup.status, "verified");
      assert.equal(reopening.runtimeStarted, false); assert.equal(reopening.authenticatedActor.userId, fixtureId("account:platformAdmin"));
      const replay = await post(body); assert.equal(replay.status, 200, replay.text); assert.equal(replay.json.meta.replayed, true);
      assert.deepEqual(replay.json.data, reopening);
      assert.equal((await post({ ...body, lossWindowReference: "CHANGED-LOSS-DECISION" })).status, 409);
      assert.equal(readHash(reopening.databasePath), reopening.reopeningPlaintextSha256);
      assert.throws(() => assertRecoveryRuntimeAllowed(candidateReader), { code: "DATABASE_RECOVERY_HELD" });
    });
    const closed = await maintenance.close();
    assert.equal(closed.authenticationChanges.createdSessions, 2); assert.equal(closed.authenticationChanges.heldNewSecurityMessages, 0);
    assert.equal(closed.correctionReviews.length, 2); assert.equal(closed.activeSessions, 0);
    assert.equal(closed.reopeningCopies.length, 1);
    assert.equal(closed.observed.emailCalls, 0); assert.equal(closed.observed.providerCalls, 0); assert.equal(closed.observed.publications, 0);
    await t.test("the actual encrypted backup and clean restore retain zero pending work and the durable hold", async () => {
      const backup = await createEncryptedOffsiteBackup({ databasePath: maintenance.databasePath, config: f.config, objectStorage: f.objectStorage,
        reason: "pre-cutover-rehearsal", requestedByType: "release_qa_automation", requestedById: "reconciled-maintenance-fixture",
        backendBuildId: f.options.backendBuildId, retentionClass: "incident-preservation", nowMs: () => f.securityFoundations.clock.nowMs() + 1 });
      assert.equal(backup.status, "verified"); assert.notEqual(backup.backupId, f.originalBackup.backupId);
      const restored = await restoreEncryptedBackupToCleanPath({ manifestObjectKey: backup.manifestObjectKey, objectStorage: f.objectStorage,
        keyResolver: async version => { assert.equal(version, f.config.encryption.keyVersion); return f.encryptionKey; },
        expectedEnvironment: f.config.appEnv, expectedEnvironmentId: f.config.environmentId, expectedDatabaseId: f.config.databaseId,
        targetDatabasePath: path.join(f.started.temporaryRoot, "reconciled-maintenance-restored.sqlite3"), temporaryRoot: f.started.temporaryRoot });
      const reader = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
      try {
        assert.deepEqual(snapshots(readRows(reader)), closed.afterSnapshots);
        assert.equal(reader.prepare("SELECT COUNT(*) n FROM outbox_events WHERE status NOT IN ('published','discarded')").get().n, 0);
        assert.equal(reader.prepare("SELECT COUNT(*) n FROM job_runs").get().n, recoverKnownLoss ? 1 : 0);
        assert.equal(reader.prepare("SELECT COUNT(*) n FROM sessions WHERE status='active'").get().n, 0);
        assert.equal(reader.prepare("SELECT COUNT(*) n FROM outbox_events WHERE last_error_code='RECOVERY_INVALIDATION_SUPPRESSED'").get().n, expectedSuppressed);
        assert.throws(() => assertRecoveryRuntimeAllowed(reader), { code: "DATABASE_RECOVERY_HELD" });
        assert.deepEqual(reader.pragma("foreign_key_check"), []); assert.deepEqual(reader.pragma("integrity_check"), [{ integrity_check: "ok" }]);
        assert.equal(reader.prepare("SELECT total_changes() n").get().n, 0);
      } finally { reader.close(); }
      assert.equal(readHash(maintenance.databasePath), closed.verificationCopyPlaintextSha256);
    });
    await t.test("normal runtime accepts only the new copy and preserves the recovery epoch and revoked credentials", async () => {
      const database = openDatabase({ databasePath: reopening.databasePath, environment: "test" }).database;
      let server;
      try {
        assertRecoveryRuntimeAllowed(database);
        assert.deepEqual(snapshots(readRows(database)), reopening.tableSnapshots);
        const runtime = createTargetRuntime({ database, migrationsDirectory, securityFoundations: f.securityFoundations, networkSourceResolver: () => "127.0.0.1",
          currentSeason: f.currentSeason, leagueWriteMode: "open", nhlFetchImplementation: async () => assert.fail("Reopening cannot fetch statistics.") });
        if (recoverKnownLoss) {
          const repository = createSqliteTradeExpiryRepository({ database }), before = snapshots(readRows(database));
          const restarted = await createExpireTradeProposalsJob({ repository: { ...repository,
            listDue(query) { return repository.listDue({ ...query, limit: 100 }).filter(row => row.tradeId === f.interrupted.trade.id); } },
            clock: f.securityFoundations.clock, secureRandom: createSecureRandom(), leaseOwner: "integrated-recovery-reopened-worker",
            logger: { error() { assert.fail("Reconciled occurrence cannot fail after restart."); } } }).run();
          assert.equal(restarted.due, 0); assert.equal(restarted.expired, 0);
          assert.deepEqual(snapshots(readRows(database)), before); assert.equal(database.prepare("SELECT total_changes() n").get().n, 0);
          assert.equal(database.prepare("SELECT status FROM job_runs WHERE id=?").get(f.interrupted.oldClaim.runId).status, "succeeded");
          assert.equal(database.prepare("SELECT COUNT(*) n FROM trade_events WHERE trade_id=? AND event_type='proposal_expired'").get(f.interrupted.trade.id).n, 1);
        }
        // Match the deployed runtime's actual health-service and route wiring.
        // These bounded samples are local smoke evidence, not a hosted review window.
        const health = createRuntimeHealthService({ database, migrationState: runtime.migrationState,
          databaseIdentity: plan.databaseIdentity, nowMs: () => f.securityFoundations.clock.nowMs(), runtimeConfig: {
            appEnv: backupEnvironment, environmentId: f.config.environmentId, buildId: f.options.backendBuildId, frontendBuildId: "local-recovery-fixture",
            freeAgentDraftRoutesEnabled: true, leagueWriteMode: "open", scheduledJobsEnabled: false, accountEmailDeliveryEnabled: false } });
        runtime.app.use(createPublicHealthRouter({ healthService: health }));
        runtime.app.use(createOperationsHealthRouter({ requestSecurity: runtime.transport.requestSecurity,
          platformAuthorization: runtime.services.authorizations.platform, healthService: health }));
        server = createTargetHttpServer({ runtime: { ...runtime, health, close() {} }, securityConfig: f.securityFoundations.config });
        const address = await server.listen({ host: "127.0.0.1", port: 0 }), baseUrl = "http://127.0.0.1:" + address.port;
        const adminEmail = database.prepare("SELECT email_normalized FROM users WHERE id=?").get(fixtureId("account:platformAdmin")).email_normalized;
        const adminLogin = await request(baseUrl, "/api/v1/session", { method: "POST", body: { email: adminEmail, password: PASSWORD } });
        assert.equal(adminLogin.status, 200, adminLogin.text);
        const healthAdministrator = { cookie: adminLogin.headers.get("set-cookie").split(";")[0] };
        const healthSamples = [], observationStarted = performance.now();
        const sampleHealth = async phase => {
          const before = snapshots(readRows(database)), writesBefore = database.prepare("SELECT total_changes() n").get().n;
          const live = await request(baseUrl, "/api/v1/health/live"), ready = await request(baseUrl, "/api/v1/health/ready");
          const operations = await request(baseUrl, "/api/v1/operations/health", healthAdministrator);
          assert.equal(live.status, 200); assert.equal(ready.status, 200); assert.equal(ready.json.data.status, "ready");
          assert.equal(operations.status, 200, operations.text);
          const observed = operations.json.data;
          assert.equal(observed.backendBuildId, f.options.backendBuildId); assert.equal(observed.environmentId, f.config.environmentId);
          assert.equal(observed.schemaVersion, runtime.migrationState.userVersion); assert.equal(observed.lifecycle, "ready");
          assert.deepEqual(observed.scheduler, { enabled: false, state: "disabled" });
          assert.deepEqual(observed.accountEmailDelivery, { enabled: false }); assert.equal(observed.maintenance.state, "open");
          assert.deepEqual(observed.outbox, { pending: 0, publishing: 0, failed: 0 });
          assert.deepEqual(snapshots(readRows(database)), before); assert.equal(database.prepare("SELECT total_changes() n").get().n, writesBefore);
          healthSamples.push({ phase, observedAt: new Date().toISOString(), elapsedMs: performance.now() - observationStarted, ready: true });
        };
        await sampleHealth("reopened-before-write");
        const oldCookie = f.started.runtime.transport.sessionCookie.name + "=" + f.oldSession.rawSessionToken;
        assert.equal((await request(baseUrl, "/api/v1/session", { cookie: oldCookie })).status, 401);
        const email = database.prepare("SELECT email_normalized FROM users WHERE id=?").get(fixtureId("account:leagueAManagerOne")).email_normalized;
        const signedIn = await request(baseUrl, "/api/v1/session", { method: "POST", body: { email, password: PASSWORD } });
        assert.equal(signedIn.status, 200, signedIn.text);
        const manager = { cookie: signedIn.headers.get("set-cookie").split(";")[0], csrf: signedIn.json.data.csrfToken,
          recoveryEpoch: signedIn.headers.get("X-Hundo-Recovery-Epoch") };
        assert.equal(manager.recoveryEpoch, reopening.recoveryEpoch.recoveryId);
        assert.equal((await request(baseUrl, "/api/v1/leagues", manager)).status, 200);
        assert.equal((await request(baseUrl, "/api/v1/leagues/" + fixtureId("league:leagueB"), manager)).status, 404);
        assert.equal((await request(baseUrl, "/api/v1/operations/health", manager)).status, 403);
        assert.equal(database.prepare("SELECT status FROM sessions WHERE id=?").get(f.oldSession.session.id).status, "revoked");
        const leagueId = fixtureId("league:leagueA"), proposingTeamId = fixtureId("team:leagueA:1");
        const receivingTeamId = database.prepare("SELECT team_id FROM team_manager_assignments WHERE league_id=? AND user_id=? AND status='accepted' LIMIT 1")
          .get(leagueId, fixtureId("account:leagueAManagerTwo")).team_id;
        const financialBefore = snapshots(Object.fromEntries(Object.entries(readRows(database)).filter(([name]) =>
          ["contracts", "contract_years", "player_ownerships", "draft_picks", "buyout_obligations", "retention_obligations"].includes(name))));
        const socket = await socketSession(baseUrl, manager.cookie, f.securityFoundations.config.publicFrontendOrigin);
        try {
          assert.ok(socket.packet.startsWith("40"), socket.packet);
          const endpoint = "/api/v1/leagues/" + leagueId + "/trades";
          const command = { ...manager, method: "POST", idempotencyKey: "recovery:" + manager.recoveryEpoch + ":local-reopening-proposal", body: {
            proposingTeamId, receivingTeamId,
            proposingAssets: [{ type: "future_consideration_instruction", description: "Local reopening test offer, cancelled before acceptance" }],
            receivingAssets: [{ type: "future_consideration_instruction", description: "Local reopening test return, cancelled before acceptance" }] } };
          const beforeStale = snapshots(readRows(database));
          const stale = await request(baseUrl, endpoint, { ...command, idempotencyKey: "recovery:" + crypto.randomUUID() + ":previous-action" });
          assert.equal(stale.status, 409); assert.equal(stale.json.error.code, "RECOVERY_REQUEST_STALE");
          const staleKey = await request(baseUrl, endpoint, { ...command, idempotencyKey: "local-reopening-proposal" });
          assert.equal(staleKey.status, 409); assert.equal(staleKey.json.error.code, "RECOVERY_REQUEST_STALE");
          assert.deepEqual(snapshots(readRows(database)), beforeStale);
          const created = await request(baseUrl, endpoint, command); assert.equal(created.status, 201, created.text);
          const tradeId = created.json.data.proposal.id;
          assert.equal(database.prepare("SELECT status FROM trades WHERE id=?").get(tradeId).status, "proposed");
          const committed = snapshots(readRows(database));
          const repeated = await request(baseUrl, endpoint, command); assert.equal(repeated.status, 201, repeated.text);
          assert.equal(repeated.json.data.replayed, true); assert.deepEqual(snapshots(readRows(database)), committed);
          const publishOne = async () => {
            const pending = database.prepare("SELECT * FROM outbox_events WHERE aggregate_id=? AND status='pending'").all(tradeId);
            assert.equal(pending.length, 1);
            const row = pending[0], result = await runtime.services.league.outboxPublication.publishExact({ eventId: row.id, leagueId, expectedVersion: row.version });
            assert.equal(result.outcome, "published");
            const packets = (await socket.receive()).split("\x1e").filter(packet => packet.startsWith("42")).map(packet => JSON.parse(packet.slice(2)));
            assert.equal(packets.length, 1); assert.equal(packets[0][0], "trade.changed"); assert.equal(packets[0][1].eventId, row.id);
            const beforeRetry = snapshots(readRows(database));
            const version = database.prepare("SELECT version FROM outbox_events WHERE id=?").get(row.id).version;
            assert.equal((await runtime.services.league.outboxPublication.publishExact({ eventId: row.id, leagueId, expectedVersion: version })).outcome, "already_published");
            assert.deepEqual(snapshots(readRows(database)), beforeRetry);
          };
          await publishOne();
          const cancelCommand = { ...manager, method: "POST", body: {}, idempotencyKey: "recovery:" + manager.recoveryEpoch + ":local-reopening-cancel" };
          const cancelled = await request(baseUrl, endpoint + "/" + tradeId + "/cancel", cancelCommand);
          assert.equal(cancelled.status, 200, cancelled.text); assert.equal(database.prepare("SELECT status FROM trades WHERE id=?").get(tradeId).status, "cancelled");
          const afterCancel = snapshots(readRows(database));
          assert.equal((await request(baseUrl, endpoint + "/" + tradeId + "/cancel", cancelCommand)).status, 200);
          assert.deepEqual(snapshots(readRows(database)), afterCancel); await publishOne();
          const financialAfter = snapshots(Object.fromEntries(Object.entries(readRows(database)).filter(([name]) => Object.hasOwn(financialBefore, name))));
          assert.deepEqual(financialAfter, financialBefore);
          assert.equal(database.prepare("SELECT COUNT(*) n FROM job_runs").get().n, recoverKnownLoss ? 1 : 0);
          assert.equal(database.prepare("SELECT COUNT(*) n FROM outbox_events WHERE status NOT IN ('published','discarded')").get().n, 0);
        } finally { await socket.close(); }
        await sampleHealth("after-proposal-cancellation-and-retries");
        t.diagnostic(JSON.stringify({ scope: "local-reopening-health-smoke", recoverKnownLoss, samples: healthSamples,
          hostedMonitoringWindowVerified: false, incidentClosed: false }));
        await server.close(); server = null;
        const finalRows = snapshots(readRows(database));
        const backup = await createEncryptedOffsiteBackup({ databasePath: reopening.databasePath, config: f.config, objectStorage: f.objectStorage,
          reason: "pre-cutover-rehearsal", requestedByType: "release_qa_automation", requestedById: "post-reopening-fixture",
          backendBuildId: f.options.backendBuildId, retentionClass: "incident-preservation", nowMs: () => f.securityFoundations.clock.nowMs() + 1 });
        assert.equal(backup.status, "verified"); assert.notEqual(backup.backupId, reopening.preReopeningBackup.backupId);
        const restored = await restoreEncryptedBackupToCleanPath({ manifestObjectKey: backup.manifestObjectKey, objectStorage: f.objectStorage,
          keyResolver: async () => f.encryptionKey, expectedEnvironment: f.config.appEnv, expectedEnvironmentId: f.config.environmentId,
          expectedDatabaseId: f.config.databaseId, targetDatabasePath: path.join(f.started.temporaryRoot, "post-reopening-restored.sqlite3"), temporaryRoot: f.started.temporaryRoot });
        const restoredReader = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
        try {
          assert.deepEqual(snapshots(readRows(restoredReader)), finalRows); assertRecoveryRuntimeAllowed(restoredReader);
          const approval = JSON.parse(restoredReader.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key=?")
            .get("recovery_reopening_review:" + reopening.reopeningId).metadata_value);
          assert.deepEqual(approval.financialCorrections, reopening.financialCorrections);
          assert.deepEqual(approval.financialCorrections.map(row => row.trackingReference),
            reopening.financialCorrections.map(row => row.trackingReference));
          assert.equal(approval.sourceBackupId, f.originalBackup.backupId);
          assert.equal(approval.preservedPlaintextSha256, f.sourceHashes[2]);
          assert.equal(restoredReader.prepare("SELECT status FROM sessions WHERE id=?").get(f.oldSession.session.id).status, "revoked");
          assert.deepEqual(restoredReader.pragma("foreign_key_check"), []); assert.deepEqual(restoredReader.pragma("integrity_check"), [{ integrity_check: "ok" }]);
        } finally { restoredReader.close(); }
      } finally { if (server) await server.close(); database.close(); }
    });
    assert.deepEqual(f.sources.map(database => readHash(database.name)), f.sourceHashes);
    assert.equal(readHash(operationSource), operationPlan.preparedPlaintextSha256);
    assert.equal(readHash(suppressed.reconciledDatabasePath), suppressed.reconciledPlaintextSha256);
  } finally {
    if (maintenance) await maintenance.close();
    if (candidateReader?.open) candidateReader.close();
    for (const reader of intermediateReaders) if (reader.open) reader.close();
    for (const source of f.sources) if (source.open) source.close();
  }
});

test("held maintenance uses real fresh HTTP authentication and read-only feature/socket access while all league work stays paused", async t => {
  const f = await fixture(t);let maintenance,inspection;
  try {
    await t.test("rejects forged predecessor evidence and occupied output before starting", async () => {
      const rejected = path.join(f.started.temporaryRoot,"forged-maintenance");
      await assert.rejects(startRecoveryMaintenanceSession({ ...f.options,outputDirectory: rejected,
        reviewOptions: { ...f.options.reviewOptions,plan: { ...f.options.reviewOptions.plan,activationReady: true } } }),{ code: "RECOVERY_MAINTENANCE_START_FAILED" });
      assert.equal(fs.existsSync(rejected),false);
      const occupied = path.join(f.started.temporaryRoot,"occupied");fs.mkdirSync(occupied);fs.writeFileSync(path.join(occupied,"keep.txt"),"preserve");
      await assert.rejects(startRecoveryMaintenanceSession({ ...f.options,outputDirectory: occupied }),{ code: "RECOVERY_MAINTENANCE_PATH_UNSAFE" });
      assert.equal(fs.readFileSync(path.join(occupied,"keep.txt"),"utf8"),"preserve");
    });
    maintenance = await startRecoveryMaintenanceSession({ ...f.options, reopeningBackup: { config: f.config, objectStorage: f.objectStorage } });
    inspection = openReadonlyDatabase({ databasePath: maintenance.databasePath });
    const oldCookie = f.started.runtime.transport.sessionCookie.name+"="+f.oldSession.rawSessionToken;
    const sourceRows = snapshots(readRows(f.sources[0]));
    assert.deepEqual(snapshots(readRows(inspection)),sourceRows);
    const login = async alias => {
      const userId = fixtureId("account:"+alias),email = inspection.prepare("SELECT email_normalized FROM users WHERE id=?").get(userId).email_normalized;
      const result = await request(maintenance.baseUrl,"/api/v1/session",{ method: "POST",body: { email,password: PASSWORD } });
      assert.equal(result.status,200,result.text);assert.equal(result.json.data.user.id,userId);
      return { cookie: result.headers.get("set-cookie").split(";")[0],csrf: result.json.data.csrfToken,userId };
    };
    let manager,otherManager,administrator;
    await t.test("revoked credentials fail and valid passwords create new sessions", async () => {
      assert.equal((await request(maintenance.baseUrl,"/health")).status,200);
      assert.equal((await request(maintenance.baseUrl,"/api/v1/session",{ cookie: oldCookie })).status,401);
      assert.equal((await request(maintenance.baseUrl,"/api/v1/leagues")).status,401);
      assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/recovery/review")).status,401);
      assert.deepEqual(snapshots(readRows(inspection)),sourceRows);
      const email = inspection.prepare("SELECT email_normalized FROM users WHERE id=?").get(fixtureId("account:leagueAManagerOne")).email_normalized;
      assert.equal((await request(maintenance.baseUrl,"/api/v1/session",{ method: "POST",body: { email,password: "incorrect-fixture-password" } })).status,401);
      manager = await login("leagueAManagerOne");otherManager = await login("leagueBManagerOne");administrator = await login("platformAdmin");
      assert.notEqual(manager.cookie,oldCookie);
      assert.equal(inspection.prepare("SELECT status FROM sessions WHERE id=?").get(f.oldSession.session.id).status,"revoked");
    });
    await t.test("actual feature reads and administrator readiness preserve all rows and enforce league isolation", async () => {
      const before = snapshots(readRows(inspection)),fileHash = readHash(maintenance.databasePath);
      for (const [account,alias,teamNumber] of [[manager,"leagueA",1],[otherManager,"leagueB",6]]) {
        const leagueId = fixtureId("league:"+alias),seasonId = inspection.prepare("SELECT current_season_id FROM leagues WHERE id=?").get(leagueId).current_season_id;
        for (const endpoint of ["/api/v1/session","/api/v1/leagues",`/api/v1/leagues/${leagueId}`,`/api/v1/leagues/${leagueId}/teams`,
          `/api/v1/leagues/${leagueId}/teams/${fixtureId(`team:${alias}:${teamNumber}`)}/roster`,`/api/v1/leagues/${leagueId}/auctions`,
          `/api/v1/leagues/${leagueId}/trades`,`/api/v1/leagues/${leagueId}/seasons/${seasonId}/matchup-weeks`,
          `/api/v1/leagues/${leagueId}/seasons/${seasonId}/standings`]) {
          const result = await request(maintenance.baseUrl,endpoint,account);assert.equal(result.status,200,endpoint+" "+result.text);
          assert.equal(result.headers.get("cache-control"),"no-store");
        }
      }
      const denied = await request(maintenance.baseUrl,`/api/v1/leagues/${fixtureId("league:leagueB")}`,manager);
      assert.equal(denied.status,404);assert.equal(denied.json.error.code,"LEAGUE_NOT_FOUND");
      assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/health",manager)).status,403);
      const health = await request(maintenance.baseUrl,"/api/v1/operations/health",administrator);
      assert.equal(health.status,200,health.text);assert.deepEqual(health.json.data.databaseIdentity,f.options.reviewOptions.plan.databaseIdentity);
      assert.equal(health.json.data.sourceBackupId,f.prepared.sourceBackupId);assert.equal(health.json.data.schemaVersion,62);
      assert.equal(health.json.data.backendBuildId,f.options.backendBuildId);assert.equal(health.json.data.activationReady,false);
      assert.equal(health.json.data.jobs,"not-started");assert.equal(health.json.data.email,"held");
      assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/recovery/review",manager)).status,403);
      const reviewed = await request(maintenance.baseUrl,"/api/v1/operations/recovery/review",administrator);
      assert.equal(reviewed.status,200,reviewed.text);assert.equal(reviewed.headers.get("cache-control"),"no-store");
      assert.equal(reviewed.json.meta.scope,"source-candidate-review");assert.equal(reviewed.json.meta.maintenanceCopyIsActivationCandidate,false);
      assert.equal(reviewed.json.data.reportChecksum,maintenance.initialReviewChecksum);
      assert.equal(reviewed.json.data.candidatePlaintextSha256,f.sourceHashes[0]);assert.equal(reviewed.json.data.sourceBackupId,f.prepared.sourceBackupId);
      assert.equal(reviewed.json.data.recordedLossProgress.totalChangedRecords,0);
      assert.equal(reviewed.json.data.financialConsistency.candidate.findings.length,2);
      assert.equal(reviewed.json.data.activationReady,false);assert.equal(reviewed.json.data.operatorAuthenticated,false);
      assert.equal(reviewed.text.includes(PASSWORD),false);assert.equal(reviewed.text.includes(f.oldSession.rawSessionToken),false);
      assert.deepEqual(snapshots(readRows(inspection)),before);assert.equal(readHash(maintenance.databasePath),fileHash);
    });
    await t.test("league and account mutations are rejected before any write or delivery", async () => {
      const before = snapshots(readRows(inspection));
      for (const [method,endpoint] of [["POST",`/api/v1/leagues/${fixtureId("league:leagueA")}/teams`],
        ["POST","/api/v1/password-reset-requests"],["POST","/api/v1/session/password"],["PATCH",`/api/v1/leagues/${fixtureId("league:leagueA")}`],
        ["DELETE",`/api/v1/leagues/${fixtureId("league:leagueA")}`],["HEAD","/api/v1/leagues"],["GET","/api/v1/%73ession"]]) {
        const result = await request(maintenance.baseUrl,endpoint,{ ...administrator,method,...(["GET","HEAD"].includes(method) ? {} : { body: {} }) });
        assert.equal(result.status,503,endpoint+" "+result.text);
      }
      assert.equal((await request(maintenance.baseUrl,"/api/v1/session",{ ...manager,method: "DELETE",csrf: "wrong",body: {} })).status,403);
      assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/health",{ ...administrator,origin: "https://untrusted.invalid" })).status,403);
      assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/recovery/review",{ ...administrator,method:"POST",body:{activationReady:true} })).status,503);
      assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/recovery/review",{ ...administrator,origin:"https://untrusted.invalid" })).status,403);
      assert.equal((await request(maintenance.baseUrl,"/api/v1/session",{ cookie: f.started.runtime.transport.sessionCookie.name+"=%ZZ" })).status,401);
      assert.deepEqual(snapshots(readRows(inspection)),before);
    });
    await t.test("fresh administrator correction decisions bind the exact review and retain one immutable local receipt", async () => {
      const endpoint = "/api/v1/operations/recovery/corrections", reviewPath = "/api/v1/operations/recovery/review";
      const getReview = async () => { const result = await request(maintenance.baseUrl,reviewPath,administrator);
        assert.equal(result.status,200,result.text);return result.json; };
      const bodyFor = review => ({ reviewToken: review.meta.correctionReview.reviewToken,reportChecksum: review.data.reportChecksum,
        corrections: review.meta.correctionReview.findings.map((finding,index) => ({ findingSha256: finding.findingSha256,
          disposition:"tracked-for-correction",trackingReference:`fixture-correction-${index+1}` })) });
      const post = (body,account=administrator) => request(maintenance.baseUrl,endpoint,{ ...account,method:"POST",body });
      let review = await getReview(),body = bodyFor(review);
      const before = snapshots(readRows(inspection)),fileHash = readHash(maintenance.databasePath);
      const files = () => fs.readdirSync(path.dirname(maintenance.databasePath)).filter(name => name.startsWith("correction-review-"));
      assert.equal((await post(body,{})).status,401);
      assert.equal((await post(body,manager)).status,403);
      assert.equal((await post(body,{ ...administrator,csrf:"invalid" })).status,403);
      assert.equal((await post(body,{ ...administrator,origin:"https://untrusted.invalid" })).status,403);
      for (const rawBody of ["{",JSON.stringify({ padding:"x".repeat(33*1024) })]) {
        const malformed = await fetch(maintenance.baseUrl+endpoint,{ method:"POST",headers:{ Origin:ORIGIN,Cookie:administrator.cookie,
          "X-CSRF-Token":administrator.csrf,"Content-Type":"application/json" },body:rawBody,signal:AbortSignal.timeout(10_000) });
        assert.equal(malformed.status,400,await malformed.text());
      }
      for (const invalid of [{}, { ...body,actorUserId:administrator.userId }, { ...body,corrections:body.corrections.slice(1) },
        { ...body,corrections:[body.corrections[0],body.corrections[0]] },
        { ...body,corrections:body.corrections.map(row => ({ ...row,disposition:"corrected" })) },
        { ...body,corrections:body.corrections.map(row => ({ ...row,findingSha256:"0".repeat(64) })) },
        { ...body,corrections:body.corrections.map(row => ({ ...row,trackingReference:"" })) }]) {
        const rejected = await post(invalid);assert.equal(rejected.status,400,rejected.text);
      }
      assert.equal((await post({ ...body,reportChecksum:"0".repeat(64) })).status,409);
      review = await getReview();assert.equal((await post(body)).status,409);body = bodyFor(review);
      assert.deepEqual(files(),[]);assert.deepEqual(snapshots(readRows(inspection)),before);assert.equal(readHash(maintenance.databasePath),fileHash);
      const candidateBytes = fs.readFileSync(f.sources[0].name);
      fs.appendFileSync(f.sources[0].name,"unapproved-fixture-change");
      try { assert.equal((await post(body)).status,503);assert.deepEqual(files(),[]); }
      finally { fs.writeFileSync(f.sources[0].name,candidateBytes); }
      const saved = await post(body);assert.equal(saved.status,201,saved.text);
      const receipt = saved.json.data;
      assert.equal(receipt.trackedFindingCount,2);assert.equal(receipt.authenticatedActor.userId,administrator.userId);
      assert.equal(receipt.authenticatedActor.sessionCreatedAtMs,f.now);
      assert.equal(receipt.candidateReviewChecksum,review.data.reportChecksum);
      assert.equal(receipt.candidatePlaintextSha256,f.sourceHashes[0]);assert.equal(receipt.preservedPlaintextSha256,f.sourceHashes[2]);
      assert.equal(receipt.allCurrentCandidateFindingsTracked,true);assert.equal(receipt.referencedCorrectionsIndependentlyVerified,false);
      assert.equal(receipt.currentOperatorApproval,false);assert.equal(receipt.completeFinancialReconciliation,false);assert.equal(receipt.activationReady,false);
      assert.deepEqual(receipt.corrections.map(row => row.findingSha256).sort(),body.corrections.map(row => row.findingSha256).sort());
      assert.deepEqual(files(),[`correction-review-${receipt.reportChecksum}.json`]);
      const receiptPath = path.join(path.dirname(maintenance.databasePath),files()[0]),savedBytes = fs.readFileSync(receiptPath);
      assert.deepEqual(JSON.parse(savedBytes),receipt);
      assert.equal(savedBytes.includes(Buffer.from(body.reviewToken)),false);assert.equal(savedBytes.includes(Buffer.from(administrator.csrf)),false);
      assert.equal(savedBytes.includes(Buffer.from(PASSWORD)),false);
      const retry = await post({ ...body,corrections:[...body.corrections].reverse() });assert.equal(retry.status,200,retry.text);
      assert.equal(retry.json.meta.replayed,true);assert.deepEqual(retry.json.data,receipt);assert.equal(files().length,1);
      body = bodyFor(await getReview());
      const renewed = await post(body);assert.equal(renewed.status,200,renewed.text);assert.equal(renewed.json.meta.replayed,true);
      assert.deepEqual(renewed.json.data,receipt);assert.equal(files().length,1);
      assert.equal((await post({ ...body,corrections:body.corrections.map(row => ({ ...row,trackingReference:"different-fixture-reference" })) })).status,409);
      fs.appendFileSync(receiptPath," ");
      try { assert.equal((await post(body)).status,503); } finally { fs.writeFileSync(receiptPath,savedBytes); }
      f.setNow(f.now+5*60*1000);
      try { const aged = await post(body);assert.equal(aged.status,403,aged.text);assert.equal(aged.json.error.code,"RECOVERY_FRESH_SIGN_IN_REQUIRED"); }
      finally { f.setNow(f.now); }
      assert.deepEqual(snapshots(readRows(inspection)),before);assert.equal(readHash(maintenance.databasePath),fileHash);
      const replaced = administrator;administrator = await login("platformAdmin");
      assert.equal((await post(body,replaced)).status,401);assert.equal((await post(body)).status,409);
      assert.equal(files().length,1);assert.deepEqual(fs.readFileSync(receiptPath),savedBytes);
      assert.deepEqual(f.sources.map(database => readHash(database.name)),f.sourceHashes);
      assert.throws(() => assertRecoveryRuntimeAllowed(inspection),{ code:"DATABASE_RECOVERY_HELD" });
      const pendingReview = await request(maintenance.baseUrl, "/api/v1/operations/recovery/review", administrator);
      assert.equal(pendingReview.status, 200, pendingReview.text);
      const reopeningBody = { mode: "prepare-isolated-copy", reviewToken: pendingReview.json.meta.correctionReview.reviewToken,
        reportChecksum: pendingReview.json.data.reportChecksum, correctionReviewChecksum: null, lossWindowReference: "LOCAL-PENDING-REVIEW" };
      const forbidden = await request(maintenance.baseUrl, "/api/v1/operations/recovery/reopening-copy", { ...manager, method: "POST", body: reopeningBody });
      assert.equal(forbidden.status, 403, forbidden.text);
      const unresolved = await request(maintenance.baseUrl, "/api/v1/operations/recovery/reopening-copy", { ...administrator, method: "POST", body: reopeningBody });
      assert.equal(unresolved.status, 409, unresolved.text);
      assert.deepEqual(fs.readdirSync(path.dirname(maintenance.databasePath)).filter(name => name.startsWith("reopening-")), []);
    });
    await t.test("real sockets reject old sessions, stay in allowed rooms and disconnect on replacement and sign-out", async () => {
      const old = await socketSession(maintenance.baseUrl,oldCookie);
      assert.ok(old.packet.startsWith("44"),old.packet);await old.close();
      let socket = await socketSession(maintenance.baseUrl,manager.cookie);
      try {
        assert.ok(socket.packet.startsWith("40"),socket.packet);
        const connected = maintenance.inspectConnections();assert.equal(connected.length,1);
        assert.ok(connected[0].rooms.includes("league:"+fixtureId("league:leagueA")));
        assert.equal(connected[0].rooms.some(room => room.includes(fixtureId("league:leagueB"))),false);
        await socket.send('42["join","league:'+fixtureId("league:leagueB")+'"]');
        assert.equal(maintenance.inspectConnections()[0].rooms.some(room => room.includes(fixtureId("league:leagueB"))),false);
        const replaced = manager;
        manager = await login("leagueAManagerOne");
        assert.notEqual(manager.cookie,replaced.cookie);
        assert.equal(maintenance.inspectConnections().length,0);
        assert.equal((await request(maintenance.baseUrl,"/api/v1/session",replaced)).status,401);
        const rejected = await socketSession(maintenance.baseUrl,replaced.cookie);
        assert.ok(rejected.packet.startsWith("44"),rejected.packet);await rejected.close();await socket.close();
        socket = await socketSession(maintenance.baseUrl,manager.cookie);
        assert.ok(socket.packet.startsWith("40"),socket.packet);
        const signedOut = await request(maintenance.baseUrl,"/api/v1/session",{ ...manager,method: "DELETE",body: {} });
        assert.equal(signedOut.status,200,signedOut.text);
        assert.equal(maintenance.inspectConnections().length,0);
        assert.equal((await request(maintenance.baseUrl,"/api/v1/session",manager)).status,401);
      } finally { await socket.close(); }
    });
    await t.test("expired sessions cannot read or connect and expiry checks do not persist changes", async () => {
      const before = snapshots(readRows(inspection)),fileHash = readHash(maintenance.databasePath);
      f.setNow(inspection.prepare("SELECT MAX(idle_expires_at_ms) deadline FROM sessions WHERE status='active'").get().deadline+1);
      for (const account of [otherManager,administrator]) {
        assert.equal((await request(maintenance.baseUrl,"/api/v1/session",account)).status,401);
        assert.equal((await request(maintenance.baseUrl,"/api/v1/leagues",account)).status,401);
        assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/recovery/review",account)).status,401);
        assert.equal((await request(maintenance.baseUrl,"/api/v1/operations/recovery/corrections",{ ...account,method:"POST",body:{} })).status,401);
        const rejected = await socketSession(maintenance.baseUrl,account.cookie);
        assert.ok(rejected.packet.startsWith("44"),rejected.packet);await rejected.close();
      }
      assert.deepEqual(snapshots(readRows(inspection)),before);assert.equal(readHash(maintenance.databasePath),fileHash);
    });
    inspection.close();inspection = null;
    const receipt = await maintenance.close();
    assert.equal(receipt.status,"isolated-maintenance-session-closed-held");assert.equal(receipt.authenticationChanges.createdSessions,5);
    assert.equal(receipt.authenticationChanges.heldNewSecurityMessages,2);
    assert.equal(receipt.correctionReviews.length,1);assert.equal(receipt.correctionReviews[0].trackedFindingCount,2);
    const correctionPath = path.join(path.dirname(maintenance.databasePath),`correction-review-${receipt.correctionReviews[0].reportChecksum}.json`);
    assert.equal(readHash(correctionPath),receipt.correctionReviews[0].fileSha256);
    assert.equal(receipt.activeSessions,0);assert.equal(receipt.featureReaderWrites,0);assert.equal(receipt.observed.providerCalls,0);
    assert.equal(receipt.observed.emailCalls,0);assert.equal(receipt.observed.publications,0);assert.equal(receipt.activationReady,false);
    const after = openReadonlyDatabase({ databasePath: maintenance.databasePath });
    try { assert.throws(() => assertRecoveryRuntimeAllowed(after),{ code: "DATABASE_RECOVERY_HELD" });
      assert.throws(() => createTargetRuntime({ database: after,migrationsDirectory,securityFoundations: f.securityFoundations,currentSeason: f.currentSeason }),{ code: "DATABASE_RECOVERY_HELD" });
      assert.equal(after.prepare("SELECT COUNT(*) n FROM sessions WHERE status='active'").get().n,0);
    } finally { after.close(); }
    await t.test("encrypted backup and clean restore preserve the closed maintenance state and revoked credentials", async () => {
      const sourceHash = readHash(maintenance.databasePath);
      const finalBackup = await createEncryptedOffsiteBackup({ databasePath: maintenance.databasePath,config: f.config,objectStorage: f.objectStorage,
        reason: "pre-cutover-rehearsal",requestedByType: "release_qa_automation",requestedById: "maintenance-fixture",
        backendBuildId: f.options.backendBuildId,retentionClass: "incident-preservation",nowMs: () => f.securityFoundations.clock.nowMs()+1 });
      assert.equal(finalBackup.status,"verified");assert.notEqual(finalBackup.backupId,f.originalBackup.backupId);
      const restored = await restoreEncryptedBackupToCleanPath({ manifestObjectKey: finalBackup.manifestObjectKey,objectStorage: f.objectStorage,
        keyResolver: async version => { assert.equal(version,f.config.encryption.keyVersion);return f.encryptionKey; },
        expectedEnvironment: f.config.appEnv,expectedEnvironmentId: f.config.environmentId,expectedDatabaseId: f.config.databaseId,
        targetDatabasePath: path.join(f.started.temporaryRoot,"maintenance-backup-restored.sqlite3"),temporaryRoot: f.started.temporaryRoot });
      const restoredReader = openReadonlyDatabase({ databasePath: restored.targetDatabasePath });
      try {
        assert.deepEqual(snapshots(readRows(restoredReader)),receipt.afterSnapshots);
        assert.equal(restoredReader.prepare("SELECT COUNT(*) n FROM sessions WHERE status='active'").get().n,0);
        assert.equal(restoredReader.prepare("SELECT status FROM sessions WHERE id=?").get(f.oldSession.session.id).status,"revoked");
        assert.throws(() => assertRecoveryRuntimeAllowed(restoredReader),{ code: "DATABASE_RECOVERY_HELD" });
        assert.deepEqual(restoredReader.pragma("foreign_key_check"),[]);assert.deepEqual(restoredReader.pragma("integrity_check"),[{ integrity_check: "ok" }]);
        assert.equal(restoredReader.prepare("SELECT total_changes() n").get().n,0);
      } finally { restoredReader.close(); }
      assert.equal(readHash(maintenance.databasePath),sourceHash);
      assert.equal(sourceHash,receipt.verificationCopyPlaintextSha256);
    });
    assert.deepEqual(f.sources.map(database => readHash(database.name)),f.sourceHashes);
    for (const source of f.sources) assert.equal(source.prepare("SELECT total_changes() n").get().n,0);
    assert.equal(JSON.stringify(receipt).includes(PASSWORD),false);assert.equal(JSON.stringify(receipt).includes(f.oldSession.rawSessionToken),false);
  } finally {
    if (inspection?.open) inspection.close();
    if (maintenance) await maintenance.close();
    for (const source of f.sources) if (source.open) source.close();
  }
});
