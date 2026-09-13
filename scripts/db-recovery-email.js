#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../src/infrastructure/migration/sourceInventory");
const { prepareRecoveryEmailReconciliation } = require("../src/operations/backups/prepareRecoveryEmailReconciliation");

const FIELDS = ["requestVersion", "credentialPreparationPath", "preparedDatabasePath", "candidateReviewPath", "deliveryReviewPath",
  "reviewedByUserId", "reconciliationId", "reconciledAtMs", "temporaryRoot", "outputDirectory"];
class RecoveryEmailCommandError extends Error {
  constructor() {
    super("Email recovery requires exact preparation, candidate review and delivery evidence files.");
    this.name = "RecoveryEmailCommandError"; this.code = "RECOVERY_EMAIL_REQUEST_INVALID";
  }
}
function fail() { throw new RecoveryEmailCommandError(); }
function readJson(file) {
  if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file)) fail();
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024 * 1024) fail();
  const value = JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
}
function runRecoveryEmailCommand({ argv,output = console } = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail();
  const request = readJson(argv[1]);
  if (request.requestVersion !== 1 || Object.keys(request).some(field => !FIELDS.includes(field) && field !== "lineagePath") ||
      FIELDS.some(field => !Object.hasOwn(request,field))) fail();
  const { requestVersion,credentialPreparationPath,preparedDatabasePath,candidateReviewPath,deliveryReviewPath,lineagePath,...input } = request;
  const candidate = readJson(candidateReviewPath),{ reportChecksum,...body } = candidate;
  const deliveryReview = readJson(deliveryReviewPath);
  if (candidate.reviewVersion !== 1 || candidate.status !== "held-candidate-reviewed" ||
      candidate.activationReady !== false || candidate.executable !== false ||
      crypto.createHash("sha256").update(canonicalize(body)).digest("hex") !== reportChecksum ||
      Object.keys(deliveryReview).join(",") !== "deliveries") fail();
  const result = prepareRecoveryEmailReconciliation({ ...input,
    lineage: lineagePath === undefined ? null : readJson(lineagePath),
    credentialPreparation: { ...readJson(credentialPreparationPath),preparedDatabasePath },plan: candidate.plan,deliveries: deliveryReview.deliveries });
  output.log(JSON.stringify(result));
  return result;
}
if (require.main === module) {
  try { runRecoveryEmailCommand({ argv: process.argv.slice(2) }); }
  catch (error) {
    console.error(JSON.stringify({ error: {
      code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_EMAIL_FAILED",
      message: "Email recovery failed safely. No activation was performed.",
    } }));
    process.exitCode = 1;
  }
}
module.exports = { RecoveryEmailCommandError,runRecoveryEmailCommand };
