#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../src/infrastructure/migration/sourceInventory");
const { prepareRecoveryStatisticsReconciliation } = require("../src/operations/backups/prepareRecoveryStatisticsReconciliation");

const FIELDS = ["requestVersion", "credentialPreparationPath", "preparedDatabasePath", "candidateReviewPath", "decisionPath",
  "executedAtMs", "temporaryRoot", "outputDirectory", "minimumPlayerCount"];
class RecoveryStatisticsCommandError extends Error {
  constructor() {
    super("Statistics recovery requires exact preparation, candidate review and occurrence decision files.");
    this.name = "RecoveryStatisticsCommandError"; this.code = "RECOVERY_STATISTICS_REQUEST_INVALID";
  }
}
function fail() { throw new RecoveryStatisticsCommandError(); }
function readJson(file) {
  if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file)) fail();
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024 * 1024) fail();
  const value = JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
}
async function runRecoveryStatisticsCommand({ argv,output = console } = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail();
  const request = readJson(argv[1]);
  if (request.requestVersion !== 1 || Object.keys(request).some(field => !FIELDS.includes(field) && field !== "lineagePath") ||
      FIELDS.some(field => !Object.hasOwn(request,field))) fail();
  const { requestVersion,credentialPreparationPath,preparedDatabasePath,candidateReviewPath,decisionPath,lineagePath,...input } = request;
  const candidate = readJson(candidateReviewPath),{ reportChecksum,...body } = candidate;
  if (candidate.reviewVersion !== 1 || candidate.status !== "held-candidate-reviewed" ||
      candidate.activationReady !== false || candidate.executable !== false ||
      crypto.createHash("sha256").update(canonicalize(body)).digest("hex") !== reportChecksum) fail();
  const result = await prepareRecoveryStatisticsReconciliation({ ...input,
    lineage: lineagePath === undefined ? null : readJson(lineagePath),
    credentialPreparation: { ...readJson(credentialPreparationPath),preparedDatabasePath },plan: candidate.plan,review: readJson(decisionPath) });
  output.log(JSON.stringify(result));
  return result;
}
if (require.main === module) {
  runRecoveryStatisticsCommand({ argv: process.argv.slice(2) }).catch(error => {
    console.error(JSON.stringify({ error: {
      code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_STATISTICS_FAILED",
      message: "Statistics recovery failed safely. No activation was performed.",
    } }));
    process.exitCode = 1;
  });
}
module.exports = { RecoveryStatisticsCommandError,runRecoveryStatisticsCommand };
