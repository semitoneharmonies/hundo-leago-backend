#!/usr/bin/env node
const { restoreBackupToCleanPath, BACKUP_ERROR_CODES } =
  require("../src/infrastructure/database/sqliteBackup");

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

function main() {
  try {
    const result = restoreBackupToCleanPath(
      parseArguments(process.argv.slice(2))
    );
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
if (require.main === module) main();
module.exports = { parseArguments };
