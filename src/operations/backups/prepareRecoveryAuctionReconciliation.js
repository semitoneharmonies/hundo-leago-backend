const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createTargetRepositories } = require("../../bootstrap/createTargetRuntime");
const { createSecureRandom } = require("../../infrastructure/security/createSecureRandom");
const { createSqliteAuctionResolutionRepository } = require("../../infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createAuctionResolutionService } = require("../../application/services/auctions/createAuctionResolutionService");
const { createMatchupLockService } = require("../../application/services/matchups/createMatchupLockService");
const { createMatchupLegalityService } = require("../../application/services/matchups/createMatchupLegalityService");
const { createLateLockCoordinator } = require("../../application/services/matchups/createLateLockCoordinator");
const { createLiveStatisticsService } = require("../../application/services/statistics/createLiveStatisticsService");
const { PROVIDER_NAME, MINIMUM_CURRENT_SEASON_PLAYER_COUNT } = require("../../infrastructure/sportsdataio/SportsDataIoLiveNhlAdapter");
const { PROVIDER_NAME: PLAYER_IDENTITY_PROVIDER } = require("../../infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const { createResolveTargetAuctionsJob, DEFAULT_LEASE_MS } = require("../../jobs/definitions/resolveTargetAuctions");
const { expectedRecoveryAuctionDelta, verifyRecoveryAuctionDelta, readRows, snapshots } = require("./recoveryAuctionDeltaEvidence");
const { RecoveryAuctionReconciliationError, fail, hash, same, validateAuctionDecision, expectedAuctionCallbacks,
  expectedAuctionWorkerResult, buildRecoveryAuctionAttribution } = require("./recoveryAuctionReconciliationEvidence");

const inside = (root, target) => { const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function sourceUnchanged(source, digest) {
  if (fs.lstatSync(source).isSymbolicLink() || fs.statSync(source).nlink !== 1 ||
      (exists(`${source}-wal`) && fs.statSync(`${source}-wal`).size !== 0) || exists(`${source}-journal`) ||
      hash(fs.readFileSync(source)) !== digest) fail("RECOVERY_AUCTION_SOURCE_CHANGED");
}
function generateIdentifiers() {
  return { resolutionId: crypto.randomUUID(), contractId: crypto.randomUUID(), contractYearIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    contractEventId: crypto.randomUUID(), ownershipId: crypto.randomUUID(), ownershipEventId: crypto.randomUUID(), auctionEventId: crypto.randomUUID(),
    activityId: crypto.randomUUID(), outboxEventId: crypto.randomUUID(), futureSeasonIds: [crypto.randomUUID(), crypto.randomUUID()] };
}

// Only the real domain/callback services needed for this offline action are
// composed. No HTTP runtime, scheduler, publisher or account secrets are used.
function createOfflineWorker({ database, evidence, queue, leaseOwner, leaseDurationMs, observed }) {
  const nowMs = evidence.review.observedAtMs, clock = { nowMs: () => nowMs }, secureRandom = createSecureRandom();
  const repositories = createTargetRepositories({ database, secureRandom });
  const logger = { error() { observed.errors += 1; } };
  const season = evidence.before.seasons.find(row => row.id === evidence.review.seasonId);
  const statistics = createLiveStatisticsService({ repository: repositories.statistics, nhlSeasonKey: season.nhl_season_key,
    providerName: PROVIDER_NAME, playerIdentityProvider: PLAYER_IDENTITY_PROVIDER, minimumPlayerCount: MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
    nowMs: clock.nowMs, createId: () => secureRandom.id(),
    provider: { async fetchLiveSnapshot() { observed.providerCalls += 1; fail("RECOVERY_AUCTION_PROVIDER_UNAVAILABLE"); } } });
  const normalLockService = createMatchupLockService({ repository: repositories.matchupLocks, createId: () => secureRandom.id() });
  const legalityService = createMatchupLegalityService({ repository: repositories.matchupLocks, normalLockService,
    createId: () => secureRandom.id(), nowMs: clock.nowMs });
  const coordinator = createLateLockCoordinator({ targetRepository: repositories.lateLockCoordinator, legalityService,
    statisticsService: statistics, provider: PROVIDER_NAME, clock, logger });
  const repository = createSqliteAuctionResolutionRepository({ database, candidateCardSummerSynchronizer: {
    synchronize(command) {
      const inTransaction = database.inTransaction, result = repositories.candidateCardSummerSynchronizer.synchronize(command);
      observed.summer.push({ inTransaction, command, result }); return result;
    },
  } });
  const nextId = () => { const id = queue.shift(); if (!id) fail("RECOVERY_AUCTION_IDS_EXHAUSTED"); return id; };
  const service = createAuctionResolutionService({ repository, secureRandom: { id: nextId }, lateLockCoordinator: {
    async coordinateCommittedRoster(command) {
      const inTransaction = database.inTransaction, result = await coordinator.coordinateCommittedRoster(command);
      observed.lateLock.push({ inTransaction, command, result }); return result;
    },
  } });
  const originalAuction = evidence.before.auctions.find(row => row.id === evidence.review.auctionId);
  const originalJob = evidence.before.job_runs.find(row => row.id === evidence.review.jobId);
  return createResolveTargetAuctionsJob({ repository: { ...repository,
    listDue() {
      const current = database.prepare("SELECT * FROM auctions WHERE id=?").get(originalAuction.id);
      if (current?.status === "resolved") return [];
      if (!same(current, originalAuction)) fail("RECOVERY_AUCTION_SOURCE_CHANGED");
      return [{ auctionId: current.id, leagueId: current.league_id, seasonId: current.season_id, auctionVersion: current.version,
        resolvesAtMs: current.resolves_at_ms, playoffsStartAtMs: season.fantasy_playoffs_start_at_ms, dueAtMs: evidence.review.dueAtMs }];
    },
    claimRun(command) {
      const claim = repository.claimRun(command);
      if (!claim.acquired || claim.runId !== originalJob.id || claim.version !== originalJob.version + 1) fail("RECOVERY_AUCTION_LEASE_UNAVAILABLE");
      return claim;
    },
  }, resolutionService: service, clock, secureRandom: { id: nextId }, leaseOwner, leaseDurationMs, logger });
}

// The decision is attributed against the held snapshot, not an authenticated
// session. The result remains held for later independent lineage, complete
// loss-window, maintenance and reopening verification. No messages are sent.
async function prepareRecoveryAuctionReconciliation({ reviewOptions: suppliedReviewOptions, decision, temporaryRoot, outputDirectory,
  leaseDurationMs = DEFAULT_LEASE_MS, beforeReceipt = null } = {}) {
  if (!path.isAbsolute(temporaryRoot || "") || !path.isAbsolute(outputDirectory || "") ||
      !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > DEFAULT_LEASE_MS ||
      (beforeReceipt !== null && typeof beforeReceipt !== "function")) fail("RECOVERY_AUCTION_INPUT_INVALID");
  let ownedDirectory = null, physicalRoot, database;
  try {
    const reviewOptions = { ...suppliedReviewOptions,
      plan: JSON.parse(JSON.stringify(suppliedReviewOptions?.plan)),
      credentialPreparation: JSON.parse(JSON.stringify(suppliedReviewOptions?.credentialPreparation)),
      lineage: suppliedReviewOptions?.lineage == null ? null : JSON.parse(JSON.stringify(suppliedReviewOptions.lineage)) };
    const reviewedDecision = JSON.parse(JSON.stringify(decision));
    const identifiers = generateIdentifiers(), evidence = expectedRecoveryAuctionDelta({ reviewOptions, identifiers });
    validateAuctionDecision({ decision: reviewedDecision, evidence });
    const sources = [reviewOptions.preparedDatabase, reviewOptions.restoredDatabase, reviewOptions.preservedDatabase];
    const sourcePaths = sources.map(reader => fs.realpathSync(reader.name));
    const sourceHashes = [evidence.review.preparedPlaintextSha256, evidence.review.restoredPlaintextSha256, evidence.review.preservedPlaintextSha256];
    const assertSources = () => sourcePaths.forEach((file, index) => sourceUnchanged(file, sourceHashes[index]));
    const sourceChanges = sources.map(reader => reader.prepare("SELECT total_changes() n").get().n);
    physicalRoot = fs.realpathSync(temporaryRoot);
    const output = path.join(fs.realpathSync(path.dirname(outputDirectory)), path.basename(outputDirectory));
    if (!inside(fs.realpathSync(os.tmpdir()), physicalRoot) || !sourcePaths.every(file => inside(physicalRoot, file)) ||
        !inside(physicalRoot, output) || exists(output)) fail("RECOVERY_AUCTION_PATH_UNSAFE");
    assertSources();
    fs.mkdirSync(output, { mode: 0o700 }); ownedDirectory = output;
    const candidatePath = path.join(output, "auction-reconciled.sqlite3");
    fs.copyFileSync(sourcePaths[0], candidatePath, fs.constants.COPYFILE_EXCL); fs.chmodSync(candidatePath, 0o600);
    const open = () => openDatabase({ databasePath: candidatePath, environment: "staging", persistentRoot: physicalRoot, requirePersistentRoot: true }).database;
    database = open();
    if (!same(snapshots(readRows(database)), snapshots(evidence.before))) fail("RECOVERY_AUCTION_SOURCE_CHANGED");
    const observed = { summer: [], lateLock: [], providerCalls: 0, errors: 0 };
    const queue = [crypto.randomUUID(), identifiers.resolutionId, identifiers.contractId, ...identifiers.contractYearIds,
      identifiers.contractEventId, identifiers.ownershipId, identifiers.ownershipEventId, identifiers.auctionEventId,
      identifiers.activityId, identifiers.outboxEventId, ...identifiers.futureSeasonIds];
    const workerOptions = { evidence, queue, leaseOwner: `recovery:${reviewedDecision.reconciliationId}`, leaseDurationMs, observed };
    const worker = createOfflineWorker({ ...workerOptions, database });
    const started = performance.now(), workerResult = await worker.run(), elapsedMs = Math.ceil(performance.now() - started);
    if (elapsedMs >= leaseDurationMs || !same(workerResult, expectedAuctionWorkerResult()) || queue.length !== 0 ||
        !same(observed, expectedAuctionCallbacks(evidence))) fail("RECOVERY_AUCTION_EXECUTION_FAILED");
    assertSources(); database.close(); database = null;
    database = openReadonlyDatabase({ databasePath: candidatePath });
    verifyRecoveryAuctionDelta({ reviewOptions, identifiers, completedDatabase: database });
    database.close(); database = null;
    database = open();
    const beforeRestart = snapshots(readRows(database)), restartResult = await createOfflineWorker({ ...workerOptions, database }).run();
    if (!same(restartResult, expectedAuctionWorkerResult(true)) || database.prepare("SELECT total_changes() n").get().n !== 0 ||
        !same(snapshots(readRows(database)), beforeRestart) || !same(observed, expectedAuctionCallbacks(evidence))) fail("RECOVERY_AUCTION_RESTART_FAILED");
    const execution = { workerResult, restartResult, elapsedMs, leaseDurationMs, callbacks: observed };
    const attribution = buildRecoveryAuctionAttribution({ evidence, decision: reviewedDecision, execution });
    database.transaction(() => {
      database.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(attribution.metadata);
      createSqliteSecurityAuditRepository({ database }).append(attribution.audit);
    }).immediate();
    if (beforeReceipt && beforeReceipt(database)?.then) fail("RECOVERY_AUCTION_INPUT_INVALID");
    const tableSnapshots = snapshots(readRows(database));
    if (!same(tableSnapshots, snapshots(attribution.expected)) || database.pragma("foreign_key_check").length !== 0 ||
        !same(database.pragma("integrity_check"), [{ integrity_check: "ok" }])) fail("RECOVERY_AUCTION_POSTCHECK_FAILED");
    assertSources(); database.close(); database = null;
    const inspection = inspectDatabase(candidatePath);
    assertSources();
    sources.forEach((reader, index) => { if (reader.prepare("SELECT total_changes() n").get().n !== sourceChanges[index]) fail("RECOVERY_AUCTION_SOURCE_CHANGED"); });
    const report = { reportVersion: 1, status: "auction-reconciled-held", recoveryId: evidence.review.recoveryId,
      recoveryEpoch: evidence.review.recoveryEpoch, planChecksum: evidence.review.planChecksum, review: evidence.review,
      decision: reviewedDecision, decisionChecksum: attribution.decisionChecksum, identifiers, executedAtMs: evidence.review.observedAtMs,
      sourcePlaintextSha256: evidence.review.preparedPlaintextSha256, reconciledPlaintextSha256: hash(fs.readFileSync(candidatePath)),
      domainSnapshotSha256: hash(canonicalize(evidence.tableSnapshots)), execution, tableSnapshots,
      completedJobId: evidence.review.jobId, completedJobRowSha256: hash(canonicalize(evidence.completedJob)),
      unresolvedJobs: reviewOptions.plan.unresolvedJobs - 1, unresolvedMessages: reviewOptions.plan.unresolvedMessages + 1,
      createdOutboxId: identifiers.outboxEventId, createdMessage: "pending-and-held", sourceDatabases: "unchanged",
      otherJobs: "unchanged-and-held", previousMessages: "unchanged-and-held", reviewEvidence: "operator-supplied-not-current-authentication",
      normalRuntime: "blocked-by-durable-recovery-hold", callbackExecutionVerified: true, leaseElapsedVerified: true,
      restartVerified: true, completeLossWindowEvidence: false, operatorAuthenticated: false, activationReady: false, executable: false };
    const receipt = { ...report, reportChecksum: hash(canonicalize(report)) };
    fs.writeFileSync(path.join(output, "auction-reconciliation.json"), `${canonicalize(receipt)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ ...receipt, reconciledDatabasePath: candidatePath, inspection });
  } catch (error) {
    try {
      if (database?.open) database.close();
      if (ownedDirectory !== null) {
        if (!inside(physicalRoot, fs.realpathSync(ownedDirectory)) || fs.lstatSync(ownedDirectory).isSymbolicLink()) fail("RECOVERY_AUCTION_CLEANUP_FAILED");
        fs.rmSync(ownedDirectory, { recursive: true, force: false });
      }
    } catch { fail("RECOVERY_AUCTION_CLEANUP_FAILED"); }
    if (error instanceof RecoveryAuctionReconciliationError) throw error;
    if (/^RECOVERY_AUCTION_DELTA_[A-Z_]+$/.test(error?.code || "")) throw error;
    fail("RECOVERY_AUCTION_RECONCILIATION_FAILED");
  }
}
module.exports = { prepareRecoveryAuctionReconciliation };
