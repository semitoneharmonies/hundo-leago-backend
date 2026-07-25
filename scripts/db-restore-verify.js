#!/usr/bin/env node
const { restoreBackupToCleanPath, BACKUP_ERROR_CODES } =
  require("../src/infrastructure/database/sqliteBackup");
const { loadTargetRuntimeConfig } = require("../src/config/loadTargetRuntimeConfig");
const { loadBackupConfig } = require("../src/config/loadBackupConfig");
const { createObjectStorageAdapter } = require("../src/infrastructure/backups/createObjectStorageAdapter");
const { createS3CompatibleClient } = require("../src/infrastructure/backups/createS3CompatibleClient");
const { restoreEncryptedBackupToCleanPath } = require("../src/operations/backups/restoreEncryptedBackupToCleanPath");

function parseArguments(argv) {
  const map = new Map([
    ["--backup", "backupDirectory"],
    ["--target", "targetDatabasePath"],
    ["--environment", "environment"],
  ]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = map.get(argv[i]);
    if (!key || options[key] !== undefined || !argv[i + 1]) {
      const error = new Error("Invalid restore arguments.");
      error.code = BACKUP_ERROR_CODES.argumentInvalid;
      throw error;
    }
    options[key] = argv[i + 1];
  }
  if ([...map.values()].some((key) => options[key] === undefined)) {
    const error = new Error("All restore arguments are required.");
    error.code = BACKUP_ERROR_CODES.argumentInvalid;
    throw error;
  }
  return options;
}

function parseDeployedArguments(argv) {
  const options = {};
  const map = new Map([
    ["--manifest-object-key", "manifestObjectKey"],
    ["--target", "targetDatabasePath"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = map.get(argv[index]);
    if (!key || options[key] !== undefined || !argv[index + 1]) {
      const error = new Error("Invalid encrypted restore-verification arguments.");
      error.code = BACKUP_ERROR_CODES.argumentInvalid;
      throw error;
    }
    options[key] = argv[index + 1];
  }
  if ([...map.values()].some((key) => options[key] === undefined)) {
    const error = new Error("All encrypted restore-verification arguments are required.");
    error.code = BACKUP_ERROR_CODES.argumentInvalid;
    throw error;
  }
  return options;
}

async function runDeployedRestoreVerification({
  env = process.env,
  argv,
  fetchImplementation = fetch,
} = {}) {
  const runtimeConfig = loadTargetRuntimeConfig({ env });
  const backupConfig = loadBackupConfig({ env, runtimeConfig });
  const client = createS3CompatibleClient({
    endpoint: backupConfig.objectStorage.endpoint,
    region: backupConfig.objectStorage.region,
    bucket: backupConfig.objectStorage.bucket,
    accessKeyId: backupConfig.objectStorage.accessKeyId.value,
    secretAccessKey: backupConfig.objectStorage.secretAccessKey.value,
    fetchImplementation,
  });
  return restoreEncryptedBackupToCleanPath({
    ...parseDeployedArguments(argv),
    objectStorage: createObjectStorageAdapter({ client }),
    keyResolver: async (version) =>
      version === backupConfig.encryption.keyVersion
        ? backupConfig.encryption.key.value
        : null,
    expectedEnvironment: runtimeConfig.appEnv,
    expectedEnvironmentId: runtimeConfig.environmentId,
    expectedDatabaseId: runtimeConfig.databaseId,
    temporaryRoot: runtimeConfig.persistentRoot,
  });
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    const result = argv.includes("--backup")
      ? restoreBackupToCleanPath(parseArguments(argv))
      : await runDeployedRestoreVerification({ argv });
    console.log(JSON.stringify({
      status: "verified",
      backupId: result.backupId,
      plaintextSha256: result.plaintextSha256,
      integrity: result.inspection.integrity,
      foreignKeyViolationCount:
        result.inspection.foreignKeyViolationCount,
    }));
  } catch (error) {
    console.error(JSON.stringify({ error: {
      code: error.code || BACKUP_ERROR_CODES.operationFailed,
      message: error.message || "Restore verification failed safely.",
    }}));
    process.exitCode = 1;
  }
}
if (require.main === module) void main();
module.exports = {
  parseArguments,
  parseDeployedArguments,
  runDeployedRestoreVerification,
};
