#!/usr/bin/env node

"use strict";

const {
  loadBackupConfig,
} = require("../src/config/loadBackupConfig");
const {
  loadTargetRuntimeConfig,
} = require("../src/config/loadTargetRuntimeConfig");
const {
  createObjectStorageAdapter,
} = require(
  "../src/infrastructure/backups/createObjectStorageAdapter"
);
const {
  createS3CompatibleClient,
} = require(
  "../src/infrastructure/backups/createS3CompatibleClient"
);
const {
  DEFAULT_CONTRACT,
  ERROR_CODES,
  executeAbortReleaseQaStrictRestore,
  executeReleaseQaStrictRestore,
  parseArguments,
  planAbortReleaseQaStrictRestore,
  planReleaseQaStrictRestore,
} = require(
  "../src/operations/release/materializeReleaseQaStrictRestore"
);

const COMMAND_MODES = Object.freeze({
  plan: Object.freeze({
    execute: false,
    operation: planReleaseQaStrictRestore,
  }),
  execute: Object.freeze({
    execute: true,
    operation: executeReleaseQaStrictRestore,
  }),
  "abort-plan": Object.freeze({
    execute: false,
    operation: planAbortReleaseQaStrictRestore,
  }),
  "abort-execute": Object.freeze({
    execute: true,
    operation: executeAbortReleaseQaStrictRestore,
  }),
});

function deployedBackupAccess({ env, fetchImplementation }) {
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
  return Object.freeze({
    objectStorage: createObjectStorageAdapter({ client }),
    keyResolver: async (version) =>
      version === backupConfig.encryption.keyVersion
        ? backupConfig.encryption.key.value
        : null,
  });
}

async function runReleaseQaStrictRestoreCommand({
  mode,
  argv,
  env = process.env,
  output = console,
  fetchImplementation = fetch,
  backupAccess,
  contract = DEFAULT_CONTRACT,
  ...operationDependencies
} = {}) {
  const command = COMMAND_MODES[mode];
  if (!command) {
    const error = new Error(
      "The release-QA strict restore command mode is invalid."
    );
    error.code = ERROR_CODES.inputInvalid;
    throw error;
  }
  const options = parseArguments(argv, { execute: command.execute });
  const access = backupAccess ||
    deployedBackupAccess({ env, fetchImplementation });
  const result = await command.operation({
    options,
    env,
    contract,
    objectStorage: access.objectStorage,
    keyResolver: access.keyResolver,
    ...operationDependencies,
  });
  output.log(JSON.stringify(result));
  return result;
}

async function main() {
  try {
    const mode = process.argv[2];
    await runReleaseQaStrictRestoreCommand({
      mode,
      argv: process.argv.slice(3),
    });
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code:
          typeof error?.code === "string"
            ? error.code
            : ERROR_CODES.failed,
        message:
          "The staging release-QA strict restore command failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  deployedBackupAccess,
  runReleaseQaStrictRestoreCommand,
};
