#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../src/infrastructure/migration/sourceInventory");
const { prepareRecoveryInvalidationReconciliation } = require("../src/operations/backups/prepareRecoveryInvalidationReconciliation");
const FIELDS = ["requestVersion","credentialPreparationPath","preparedDatabasePath","candidateReviewPath","invalidationReviewPath",
  "reviewedByUserId","reconciliationId","reconciledAtMs","temporaryRoot","outputDirectory"];
function fail() { const error = new Error("Exact recovery invalidation files are required.");error.code = "RECOVERY_INVALIDATION_REQUEST_INVALID";throw error; }
function readJson(file) {
  if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file)) fail();
  const stat = fs.statSync(file);if (!stat.isFile() || stat.size < 2 || stat.size > 16*1024*1024) fail();
  const value = JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();return value;
}
function runRecoveryInvalidationCommand({ argv,output = console } = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail();
  const request = readJson(argv[1]);
  if (request.requestVersion !== 1 || FIELDS.some(field => !Object.hasOwn(request,field)) ||
      Object.keys(request).some(field => !FIELDS.includes(field) && field !== "lineagePath")) fail();
  const { requestVersion,credentialPreparationPath,preparedDatabasePath,candidateReviewPath,invalidationReviewPath,lineagePath,...input } = request;
  const candidate = readJson(candidateReviewPath),{ reportChecksum,...body } = candidate,review = readJson(invalidationReviewPath);
  if (candidate.reviewVersion !== 1 || candidate.status !== "held-candidate-reviewed" || candidate.activationReady !== false || candidate.executable !== false ||
      crypto.createHash("sha256").update(canonicalize(body)).digest("hex") !== reportChecksum || Object.keys(review).join(",") !== "events") fail();
  const result = prepareRecoveryInvalidationReconciliation({ ...input,credentialPreparation: { ...readJson(credentialPreparationPath),preparedDatabasePath },
    plan: candidate.plan,events: review.events,lineage: lineagePath === undefined ? null : readJson(lineagePath) });
  output.log(JSON.stringify(result));return result;
}
if (require.main === module) {
  try { runRecoveryInvalidationCommand({ argv: process.argv.slice(2) }); }
  catch (error) {
    console.error(JSON.stringify({ error: { code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_INVALIDATION_FAILED",
      message: "Invalidation recovery failed safely. No delivery or activation was performed." } }));process.exitCode = 1;
  }
}
module.exports = { runRecoveryInvalidationCommand };
