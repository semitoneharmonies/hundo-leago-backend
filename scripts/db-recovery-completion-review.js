#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { canonicalize } = require("../src/infrastructure/migration/sourceInventory");
const { openReadonlyDatabase } = require("../src/infrastructure/database/connection");
const { buildRecoveryCompletionReview } = require("../src/operations/backups/buildRecoveryCompletionReview");

function fail() { const error = new Error("Invalid offline recovery review request."); error.code = "RECOVERY_COMPLETION_REQUEST_INVALID"; throw error; }
function file(value) {
  if (typeof value !== "string" || value !== value.trim() || !path.isAbsolute(value)) fail();
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail();
  return value;
}
function json(value) {
  file(value); const size = fs.statSync(value).size;
  if (size < 2 || size > 16 * 1024 * 1024) fail();
  const result = JSON.parse(fs.readFileSync(value, "utf8").replace(/^\uFEFF/, ""));
  if (!result || typeof result !== "object" || Array.isArray(result)) fail();
  return result;
}
function runRecoveryCompletionReviewCommand({ argv, output = console } = {}) {
  const readers = [];
  try {
    if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail();
    const request = json(argv[1]);
    const required = ["requestVersion", "candidateDatabasePath", "restoredDatabasePath", "preservedDatabasePath",
      "credentialPreparationPath", "candidateReviewPath", "preservedPlaintextSha256", "expectedEnvironmentId", "expectedDatabaseId", "observedAtMs"];
    if (request.requestVersion !== 1 || required.some(key => !Object.hasOwn(request, key)) ||
        Object.keys(request).some(key => ![...required, "lineagePath"].includes(key))) fail();
    const saved = json(request.candidateReviewPath);
    const { reportChecksum, ...body } = saved;
    if (saved.status !== "held-candidate-reviewed" ||
        crypto.createHash("sha256").update(canonicalize(body)).digest("hex") !== reportChecksum) fail();
    const open = value => {
      file(value);
      if ((fs.existsSync(`${value}-wal`) && fs.statSync(`${value}-wal`).size !== 0) || fs.existsSync(`${value}-journal`)) fail();
      const reader = openReadonlyDatabase({ databasePath: value }); readers.push(reader); return reader;
    };
    const report = buildRecoveryCompletionReview({ candidateDatabase: open(request.candidateDatabasePath),
      restoredDatabase: open(request.restoredDatabasePath), preservedDatabase: open(request.preservedDatabasePath),
      credentialPreparation: json(request.credentialPreparationPath), plan: saved.plan,
      preservedPlaintextSha256: request.preservedPlaintextSha256, expectedEnvironmentId: request.expectedEnvironmentId,
      expectedDatabaseId: request.expectedDatabaseId, observedAtMs: request.observedAtMs,
      lineage: request.lineagePath === undefined ? null : json(request.lineagePath) });
    output.log(JSON.stringify(report)); return report;
  } finally { for (const reader of readers.reverse()) if (reader.open) reader.close(); }
}
if (require.main === module) {
  try { runRecoveryCompletionReviewCommand({ argv: process.argv.slice(2) }); }
  catch (error) {
    console.error(JSON.stringify({ error: { code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_COMPLETION_REVIEW_FAILED",
      message: "Recovery completion review failed safely. The candidate remains held." } }));
    process.exitCode = 1;
  }
}
module.exports = { runRecoveryCompletionReviewCommand };
