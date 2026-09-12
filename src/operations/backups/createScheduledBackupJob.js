const crypto = require("node:crypto");
const fs = require("node:fs");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createEncryptedOffsiteBackup } = require("./createEncryptedOffsiteBackup");
const { readManifest } = require("./restoreEncryptedBackupToCleanPath");
const { occurrenceReceiptKey, loadOccurrenceReceipt, publishOccurrenceReceipt, catalogEvidence } = require("./scheduledBackupReceipt");

const INTERVAL_MS = 60_000;
const MINIMUM_FREE_MARGIN = 64n * 1024n * 1024n;

function assertBackupDiskSpace({ databasePath, persistentRoot, fsModule = fs }) {
  const size = fsModule.statSync(databasePath, { bigint: true }).size;
  let walSize = 0n;
  try { walSize = fsModule.statSync(`${databasePath}-wal`, { bigint: true }).size; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const { bavail, bsize } = fsModule.statfsSync(persistentRoot, { bigint: true });
  if (bavail * bsize < 4n * (size + walSize) + MINIMUM_FREE_MARGIN) {
    const error = new Error("There is insufficient free space for a safe backup.");
    error.code = "BACKUP_DISK_SPACE_INSUFFICIENT";
    throw error;
  }
}

function createScheduledBackupJob({ databasePath, config, repository, objectStorage, backendBuildId,
  cadence, logger, nowMs = Date.now, createId = crypto.randomUUID, leaseOwner = `backup:${crypto.randomUUID()}`,
  setIntervalFunction = setInterval, clearIntervalFunction = clearInterval,
  fsModule = fs,
} = {}) {
  if (!config || config.scheduleEnabled !== true || !["staging", "production"].includes(config.appEnv) ||
      typeof databasePath !== "string" || typeof backendBuildId !== "string" || !backendBuildId.trim() ||
      typeof cadence !== "function" || typeof nowMs !== "function" || typeof createId !== "function" ||
      typeof setIntervalFunction !== "function" || typeof clearIntervalFunction !== "function" ||
      typeof logger?.error !== "function" || typeof logger?.info !== "function" ||
      ["claim", "complete", "fail", "renew"].some((name) => typeof repository?.[name] !== "function") ||
      ["putPrivateObject", "headPrivateObject", "getPrivateObject"].some((name) => typeof objectStorage?.[name] !== "function")) {
    throw new TypeError("scheduled backups require a configured, controlled runtime");
  }
  let timer = null;
  let inFlight = null;
  let started = null;
  let closed = false;

  async function execute() {
    let claim = null;
    let heartbeat = null;
    let leaseError = null;
    function renew() {
      if (leaseError) throw leaseError;
      claim = repository.renew({ claim, nowMs: nowMs() });
    }
    try {
      const desiredCadence = cadence();
      if (config.appEnv === "staging" && desiredCadence !== "daily") throw new Error("Invalid staging backup cadence");
      const claimed = repository.claim({ cadence: desiredCadence, nowMs: nowMs(),
        runId: createId(), backupId: createId(), leaseToken: createId(), leaseOwner });
      if (claimed.status !== "claimed") return claimed;
      claim = claimed.claim;
      heartbeat = setIntervalFunction(() => {
        try { renew(); } catch (error) { leaseError = error; }
      }, INTERVAL_MS);
      heartbeat?.unref?.();
      // Every external boundary rechecks ownership. Attempts retain distinct
      // artifacts; only the immutable occurrence winner enters the catalog.
      const guardedStorage = Object.fromEntries(["putPrivateObject", "headPrivateObject", "getPrivateObject"].map((method) => [method, async (input) => {
        renew();
        const result = await objectStorage[method](input);
        renew();
        return result;
      }]));
      const resumed = await loadOccurrenceReceipt({ config, claim, objectStorage: guardedStorage });
      if (resumed) {
        const completion = repository.complete({ claim, nowMs: nowMs(), evidence: catalogEvidence(resumed) });
        logger.info("scheduled_backup.verified", { backupId: completion.backupId });
        return completion;
      }
      assertBackupDiskSpace({ databasePath, persistentRoot: config.persistentRoot, fsModule });
      const scheduledOccurrence = { jobRunId: claim.runId, occurrenceKey: claim.occurrenceKey,
        supersedesBackupId: claim.supersedesBackupId, completionObjectKey: occurrenceReceiptKey({ config, claim }) };
      const result = await createEncryptedOffsiteBackup({ databasePath, config, objectStorage: guardedStorage,
        reason: `scheduled-${claim.cadence}`, retentionClass: claim.cadence,
        requestedByType: "backup_scheduler", requestedById: claim.runId, backendBuildId,
        createId: () => claim.backupId, nowMs, scheduledOccurrence });
      const remote = await guardedStorage.getPrivateObject({ objectKey: result.manifestObjectKey });
      const manifest = readManifest(remote.body);
      if (manifest.backupId !== claim.backupId || manifest.manifestChecksum !== result.manifestChecksum ||
          manifest.manifestObjectKey !== result.manifestObjectKey || manifest.storageObjectKey !== result.storageObjectKey ||
          manifest.encryptedArtifactSha256 !== result.encryptedArtifactSha256 || manifest.environment !== config.appEnv ||
          manifest.environmentId !== config.environmentId || manifest.databaseId !== config.databaseId ||
          manifest.encryptionKeyVersion !== config.encryption.keyVersion || manifest.backendBuildId !== backendBuildId ||
          manifest.reason !== `scheduled-${claim.cadence}` || manifest.retentionClass !== claim.cadence ||
          canonicalize(manifest.scheduledOccurrence) !== canonicalize({ ...scheduledOccurrence, completionReceiptRequired: true })) {
        throw new Error("Scheduled backup manifest does not match its occurrence");
      }
      const qualified = await publishOccurrenceReceipt({ manifest, config, claim, objectStorage: guardedStorage });
      const completion = repository.complete({ claim, nowMs: nowMs(), evidence: catalogEvidence(qualified) });
      logger.info("scheduled_backup.verified", { backupId: completion.backupId });
      return completion;
    } catch (error) {
      if (claim) {
        try { repository.fail({ claim, nowMs: nowMs() }); } catch { /* An expired owner cannot change the replacement attempt. */ }
      }
      const code = error?.code === "BACKUP_DISK_SPACE_INSUFFICIENT" ? error.code : "SCHEDULED_BACKUP_FAILED";
      logger.error("scheduled_backup.failed", { code });
      return Object.freeze({ status: "failed", code });
    } finally { if (heartbeat !== null) clearIntervalFunction(heartbeat); }
  }

  function run() {
    if (closed) return Promise.resolve(Object.freeze({ status: "skipped", reason: "closed" }));
    if (inFlight) return Promise.resolve(Object.freeze({ status: "skipped", reason: "overlap" }));
    const cycle = Promise.resolve().then(execute);
    inFlight = cycle;
    cycle.then(() => { if (inFlight === cycle) inFlight = null; }, () => { if (inFlight === cycle) inFlight = null; });
    return cycle;
  }
  return Object.freeze({
    run,
    start() {
      if (closed) throw new Error("Scheduled backup worker is closed");
      if (started) return started;
      timer = setIntervalFunction(() => { void run(); }, INTERVAL_MS);
      timer?.unref?.();
      started = Object.freeze({ status: "running", initialRun: run() });
      return started;
    },
    async close() {
      closed = true;
      if (timer !== null) { clearIntervalFunction(timer); timer = null; }
      if (inFlight) await inFlight;
    },
  });
}

module.exports = { INTERVAL_MS, MINIMUM_FREE_MARGIN, assertBackupDiskSpace, createScheduledBackupJob };
