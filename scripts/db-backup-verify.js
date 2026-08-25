#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { runDeployedRestoreVerification } = require("./db-restore-verify");

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--manifest-object-key" ||
    typeof argv[1] !== "string" ||
    argv[1].trim() === ""
  ) {
    const error = new Error("A manifest object key is required.");
    error.code = "BACKUP_ARGUMENT_INVALID";
    throw error;
  }
  return argv[1];
}

async function runBackupVerification({ env = process.env, argv, fetchImplementation = fetch } = {}) {
  const manifestObjectKey = parseArguments(argv);
  const temporaryRoot = env.PERSISTENT_DATA_ROOT;
  const localDirectory = env.BACKUP_LOCAL_DIR;
  if (!path.isAbsolute(temporaryRoot || "") || !path.isAbsolute(localDirectory || "")) {
    const error = new Error("Backup verification paths are invalid.");
    error.code = "BACKUP_CONFIG_INVALID";
    throw error;
  }
  fs.mkdirSync(localDirectory, { recursive: true });
  const targetDatabasePath = path.join(
    localDirectory,
    `.verification-${crypto.randomUUID()}.sqlite3`
  );
  try {
    return await runDeployedRestoreVerification({
      env,
      argv: [
        "--manifest-object-key",
        manifestObjectKey,
        "--target",
        targetDatabasePath,
      ],
      fetchImplementation,
    });
  } finally {
    fs.rmSync(targetDatabasePath, { force: true });
  }
}

async function main() {
  try {
    const result = await runBackupVerification({ argv: process.argv.slice(2) });
    console.log(JSON.stringify({
      status: result.status,
      backupId: result.backupId,
      plaintextSha256: result.plaintextSha256,
      integrity: result.inspection.integrity,
      foreignKeyViolationCount: result.inspection.foreignKeyViolationCount,
    }));
  } catch (error) {
    console.error(JSON.stringify({ error: {
      code: error.code || "BACKUP_VERIFICATION_FAILED",
      message: "Backup verification failed safely.",
    }}));
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = { parseArguments, runBackupVerification };
