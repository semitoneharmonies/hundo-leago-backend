#!/usr/bin/env node
const { createVerifiedBackup, BACKUP_ERROR_CODES } =
  require("../src/infrastructure/database/sqliteBackup");
const {
  loadTargetRuntimeConfig,
} = require("../src/config/loadTargetRuntimeConfig");
const {
  loadBackupConfig,
} = require("../src/config/loadBackupConfig");
const {
  createObjectStorageAdapter,
} = require("../src/infrastructure/backups/createObjectStorageAdapter");
const {
  createS3CompatibleClient,
} = require("../src/infrastructure/backups/createS3CompatibleClient");
const {
  createEncryptedOffsiteBackup,
} = require("../src/operations/backups/createEncryptedOffsiteBackup");

function parseArguments(argv) {
  const map = new Map([
    ["--database", "databasePath"],
    ["--output", "outputDirectory"],
    ["--environment", "environment"],
    ["--reason", "reason"],
    ["--captured-at-ms", "capturedAtMs"],
  ]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = map.get(argv[i]);
    if (!key || options[key] !== undefined || !argv[i + 1]) {
      const error = new Error("Invalid backup arguments.");
      error.code = BACKUP_ERROR_CODES.argumentInvalid;
      throw error;
    }
    options[key] = argv[i + 1];
  }
  if ([...map.values()].some((key) => options[key] === undefined) ||
      !/^\d+$/.test(options.capturedAtMs)) {
    const error = new Error("All backup arguments are required.");
    error.code = BACKUP_ERROR_CODES.argumentInvalid;
    throw error;
  }
  options.capturedAtMs = Number(options.capturedAtMs);
  return options;
}

function parseDeployedArguments(argv) {
  const map = new Map([
    ["--reason", "reason"],
    ["--requested-by-type", "requestedByType"],
    ["--requested-by-id", "requestedById"],
    ["--retention-class", "retentionClass"],
    ["--expires-at", "expiresAt"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = map.get(argv[index]);
    if (!key || options[key] !== undefined || !argv[index + 1]) {
      const error = new Error("Invalid deployed backup arguments.");
      error.code = BACKUP_ERROR_CODES.argumentInvalid;
      throw error;
    }
    options[key] = argv[index + 1];
  }
  if (options.reason === undefined) {
    const error = new Error("A deployed backup reason is required.");
    error.code = BACKUP_ERROR_CODES.argumentInvalid;
    throw error;
  }
  const retentionByReason = {
    "scheduled-hourly": "hourly",
    "scheduled-daily": "daily",
    "incident-preservation": "incident-preservation",
  };
  return {
    reason: options.reason,
    requestedByType: options.requestedByType || "platform_operation",
    requestedById: options.requestedById || "deployment-cli",
    retentionClass:
      options.retentionClass || retentionByReason[options.reason] ||
      (options.reason.startsWith("pre-") ? "pre-change" : "daily"),
    expiresAt: options.expiresAt || null,
  };
}

async function runDeployedBackup({ env = process.env, argv, fetchImplementation = fetch } = {}) {
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
  return createEncryptedOffsiteBackup({
    databasePath: runtimeConfig.databasePath,
    config: backupConfig,
    objectStorage: createObjectStorageAdapter({ client }),
    backendBuildId: runtimeConfig.buildId,
    ...parseDeployedArguments(argv),
  });
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    const legacy = argv.includes("--database");
    const result = legacy
      ? await createVerifiedBackup(parseArguments(argv))
      : await runDeployedBackup({ argv });
    console.log(JSON.stringify({
      status: "verified",
      backupId: result.backupId,
      ...(legacy
        ? { plaintextSha256: result.plaintextSha256 }
        : {
            encryptedArtifactSha256: result.encryptedArtifactSha256,
            manifestObjectKey: result.manifestObjectKey,
          }),
      manifestChecksum: result.manifestChecksum,
    }));
  } catch (error) {
    console.error(JSON.stringify({ error: {
      code: error.code || BACKUP_ERROR_CODES.operationFailed,
      message: error.message || "Backup failed safely.",
    }}));
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { parseArguments, parseDeployedArguments, runDeployedBackup };
