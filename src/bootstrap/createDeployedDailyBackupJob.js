const { createObjectStorageAdapter } = require("../infrastructure/backups/createObjectStorageAdapter");
const { createS3CompatibleClient } = require("../infrastructure/backups/createS3CompatibleClient");
const { createDailyCompanionBackupJob } = require("../operations/backups/createDailyCompanionBackup");

// Daily backup failures stay isolated from the existing Leago backup and runtime.
function createDeployedDailyBackupJob({ config, logger, fetchImplementation, jobOptions,
  createJobFunction = createDailyCompanionBackupJob } = {}) {
  if (config.backupScheduleEnabled !== true || config.scheduledJobsEnabled !== true || config.leagueWriteMode !== "open") return null;
  try {
    const backup = config.backup;
    if (!backup || backup.scheduleEnabled !== true || backup.appEnv !== config.appEnv ||
        backup.environmentId !== config.environmentId || backup.databaseId !== config.databaseId ||
        backup.persistentRoot !== config.persistentRoot) throw new Error("Daily backup configuration mismatch");
    const storage = backup.objectStorage;
    const objectStorage = createObjectStorageAdapter({ client: createS3CompatibleClient({
      endpoint: storage.endpoint, region: storage.region, bucket: storage.bucket,
      accessKeyId: storage.accessKeyId.value, secretAccessKey: storage.secretAccessKey.value,
      fetchImplementation, requestTimeoutMs: 60_000,
    }) });
    return createJobFunction({ ...jobOptions, databasePath: config.databasePath, config: backup,
      objectStorage, backendBuildId: config.buildId, logger, cadence: () => "hourly" });
  } catch {
    logger.error("daily_backup.failed", { code: "DAILY_BACKUP_CONFIGURATION_FAILED" });
    return null;
  }
}

module.exports = { createDeployedDailyBackupJob };
