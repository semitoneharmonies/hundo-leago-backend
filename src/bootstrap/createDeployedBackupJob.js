const { createSqliteScheduledBackupRepository } = require("../infrastructure/persistence/sqlite/SqliteScheduledBackupRepository");
const { createObjectStorageAdapter } = require("../infrastructure/backups/createObjectStorageAdapter");
const { createS3CompatibleClient } = require("../infrastructure/backups/createS3CompatibleClient");
const { createScheduledBackupJob } = require("../operations/backups/createScheduledBackupJob");

function selectBackupCadence({ appEnv, leagueWriteMode, hasActiveSeason }) {
  if (!["staging", "production"].includes(appEnv) || !["open", "closed"].includes(leagueWriteMode) || typeof hasActiveSeason !== "boolean") {
    throw new TypeError("Backup cadence requires an explicit runtime state");
  }
  return appEnv === "staging" ? "daily" : leagueWriteMode === "open" || hasActiveSeason ? "hourly" : "daily";
}

function createDeployedBackupJob({ database, config, logger, fetchImplementation, jobOptions } = {}) {
  if (config.backupScheduleEnabled !== true) return null;
  const backup = config.backup;
  if (!backup || backup.scheduleEnabled !== true || backup.appEnv !== config.appEnv ||
      backup.environmentId !== config.environmentId || backup.databaseId !== config.databaseId ||
      backup.persistentRoot !== config.persistentRoot) {
    const error = new Error("Scheduled backups require matching private backup configuration.");
    error.code = "BACKUP_CONFIG_INVALID";
    throw error;
  }
  const repository = createSqliteScheduledBackupRepository({ database, environmentId: config.environmentId, databaseId: config.databaseId });
  const storage = backup.objectStorage;
  const objectStorage = createObjectStorageAdapter({ client: createS3CompatibleClient({
    endpoint: storage.endpoint, region: storage.region, bucket: storage.bucket,
    accessKeyId: storage.accessKeyId.value, secretAccessKey: storage.secretAccessKey.value,
    fetchImplementation, requestTimeoutMs: 60_000,
  }) });
  const activeSeason = database.prepare("SELECT 1 FROM seasons WHERE status='active' LIMIT 1");
  return createScheduledBackupJob({ ...jobOptions, databasePath: config.databasePath, config: backup,
    repository, objectStorage, backendBuildId: config.buildId, logger,
    cadence: () => selectBackupCadence({ appEnv: config.appEnv, leagueWriteMode: config.leagueWriteMode,
      hasActiveSeason: Boolean(activeSeason.get()) }),
  });
}

module.exports = { createDeployedBackupJob, selectBackupCadence };
