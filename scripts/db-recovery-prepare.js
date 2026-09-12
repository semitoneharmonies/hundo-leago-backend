#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { prepareRecoveryCredentials } = require("../src/operations/backups/prepareRecoveryCredentials");

const FIELDS = ["requestVersion", "restoredVerificationPath", "temporaryRoot", "outputDirectory",
  "expectedEnvironmentId", "expectedDatabaseId", "recoveryId", "preparedAtMs"];
class RecoveryPreparationCommandError extends Error {
  constructor() {
    super("Recovery preparation requires an exact offline request and an unused output directory.");
    this.name = "RecoveryPreparationCommandError"; this.code = "RECOVERY_PREPARATION_REQUEST_INVALID";
  }
}
function fail() { throw new RecoveryPreparationCommandError(); }
function readJson(file) {
  if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file)) fail();
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024 * 1024) fail();
  const value = JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
}

// Materializes only the existing verified, credential-invalidated and held
// offline derivative. No runtime, provider, database handoff or activation.
function runRecoveryPreparationCommand({ argv, output = console } = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail();
  const request = readJson(argv[1]);
  if (request.requestVersion !== 1 || Object.keys(request).length !== FIELDS.length ||
      FIELDS.some(field => !Object.hasOwn(request,field))) fail();
  const { requestVersion,restoredVerificationPath,...input } = request;
  const result = prepareRecoveryCredentials({ ...input,restoredCandidate: readJson(restoredVerificationPath) });
  output.log(JSON.stringify(result));
  return result;
}
if (require.main === module) {
  try { runRecoveryPreparationCommand({ argv: process.argv.slice(2) }); }
  catch (error) {
    console.error(JSON.stringify({ error: {
      code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_PREPARATION_FAILED",
      message: "Recovery preparation failed safely. No activation was performed.",
    } }));
    process.exitCode = 1;
  }
}
module.exports = { RecoveryPreparationCommandError,runRecoveryPreparationCommand };
