#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { openReadonlyDatabase } = require("../src/infrastructure/database/connection");
const { buildRecoveryRestorePlan } = require("../src/operations/backups/buildRecoveryRestorePlan");

const FIELDS = ["requestVersion", "restoredDatabasePath", "preservedDatabasePath", "restoredVerificationPath",
  "backupManifestPath", "expectedBackupManifestSha256", "preservationManifestPath", "expectedPreservationManifestSha256",
  "targetEnvironment", "expectedEnvironmentId", "expectedDatabaseId", "incidentId", "requestedByUserId", "requestedScope",
  "mutationsStoppedAtMs", "plannedAtMs", "currentBackendBuildId", "selectedBackendBuildId", "frontendBuildId",
  "maintenancePlanSha256", "communicationPlanSha256"];
class RestorePlanCommandError extends Error {
  constructor() {
    super("Restore planning requires an exact offline request. No execution was performed.");
    this.name = "RestorePlanCommandError"; this.code = "RECOVERY_RESTORE_PLAN_REQUEST_INVALID";
  }
}
function fail() { throw new RestorePlanCommandError(); }
function file(value) {
  if (typeof value !== "string" || value !== value.trim() || !path.isAbsolute(value) || !fs.statSync(value).isFile()) fail();
  return value;
}
function bytes(value) {
  const source = file(value), size = fs.statSync(source).size;
  if (size < 2 || size > 16 * 1024 * 1024) fail();
  return fs.readFileSync(source);
}
function json(value) {
  const result = JSON.parse(bytes(value).toString("utf8").replace(/^\uFEFF/, ""));
  if (!result || typeof result !== "object" || Array.isArray(result)) fail();
  return result;
}
function runRecoveryRestorePlanCommand({ argv, output = console } = {}) {
  const readers = [];
  const open = value => {
    file(value);
    if ((fs.existsSync(value + "-wal") && fs.statSync(value + "-wal").size !== 0) || fs.existsSync(value + "-journal")) fail();
    const database = openReadonlyDatabase({ databasePath: value }); readers.push(database); return database;
  };
  try {
    if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail();
    const request = json(argv[1]);
    if (request.requestVersion !== 1 || Object.keys(request).length !== FIELDS.length ||
        FIELDS.some(field => !Object.hasOwn(request, field))) fail();
    const { requestVersion, restoredDatabasePath, preservedDatabasePath, restoredVerificationPath,
      backupManifestPath, preservationManifestPath, ...input } = request;
    const result = buildRecoveryRestorePlan({ ...input,
      restoredDatabase: open(restoredDatabasePath), preservedDatabase: open(preservedDatabasePath),
      restoredVerification: json(restoredVerificationPath), backupManifestBytes: bytes(backupManifestPath),
      preservationManifestBytes: bytes(preservationManifestPath), migrationsDirectory: path.resolve(__dirname, "../database/migrations") });
    output.log(JSON.stringify(result));
    return result;
  } finally {
    for (const reader of readers.reverse()) reader.close();
  }
}
if (require.main === module) {
  try { runRecoveryRestorePlanCommand({ argv: process.argv.slice(2) }); }
  catch (error) {
    console.error(JSON.stringify({ error: {
      code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_RESTORE_PLAN_FAILED",
      message: "Restore planning failed safely. No execution was performed.",
    } }));
    process.exitCode = 1;
  }
}
module.exports = { RestorePlanCommandError, runRecoveryRestorePlanCommand };
