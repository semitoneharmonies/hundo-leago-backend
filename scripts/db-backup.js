#!/usr/bin/env node
const { createVerifiedBackup, BACKUP_ERROR_CODES } =
  require("../src/infrastructure/database/sqliteBackup");

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

async function main() {
  try {
    const result = await createVerifiedBackup(
      parseArguments(process.argv.slice(2))
    );
    console.log(JSON.stringify({
      status: "verified",
      backupId: result.backupId,
      plaintextSha256: result.plaintextSha256,
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
module.exports = { parseArguments };
