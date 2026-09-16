#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openReadonlyDatabase } = require("../src/infrastructure/database/connection");
const { canonicalize } = require("../src/infrastructure/migration/sourceInventory");
const { prepareRecoveryAuctionReconciliation } = require("../src/operations/backups/prepareRecoveryAuctionReconciliation");

const FIELDS = ["requestVersion", "credentialPreparationPath", "candidateReviewPath", "preparedDatabasePath", "restoredDatabasePath",
  "preservedDatabasePath", "preservedPlaintextSha256", "jobId", "auctionId", "leagueId", "observedAtMs", "decisionPath", "temporaryRoot", "outputDirectory"];
function fail() {
  const error = new Error("Auction recovery requires an exact saved decision and three distinct offline candidates.");
  error.code = "RECOVERY_AUCTION_REQUEST_INVALID"; throw error;
}
function absoluteFile(file) {
  if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file) || !fs.statSync(file).isFile() ||
      fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).nlink !== 1) fail();
  return file;
}
function readJson(file) {
  const stat = fs.statSync(absoluteFile(file));
  if (stat.size < 2 || stat.size > 16 * 1024 * 1024) fail();
  const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
}
async function runRecoveryAuctionCommand({ argv, output = console } = {}) {
  const readers = [];
  const open = file => {
    absoluteFile(file);
    if ((fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size !== 0) || fs.existsSync(`${file}-journal`)) fail();
    const database = openReadonlyDatabase({ databasePath: file }); readers.push(database); return database;
  };
  try {
    if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail();
    const request = readJson(argv[1]);
    if (request.requestVersion !== 1 || FIELDS.some(field => !Object.hasOwn(request, field)) ||
        Object.keys(request).some(field => !FIELDS.includes(field) && field !== "lineagePath")) fail();
    const { requestVersion, credentialPreparationPath, candidateReviewPath, preparedDatabasePath, restoredDatabasePath,
      preservedDatabasePath, lineagePath, decisionPath, temporaryRoot, outputDirectory, ...input } = request;
    const candidate = readJson(candidateReviewPath), { reportChecksum, ...body } = candidate;
    if (candidate.reviewVersion !== 1 || candidate.status !== "held-candidate-reviewed" || candidate.activationReady !== false ||
        candidate.executable !== false || crypto.createHash("sha256").update(canonicalize(body)).digest("hex") !== reportChecksum) fail();
    const result = await prepareRecoveryAuctionReconciliation({ reviewOptions: { ...input, preparedDatabase: open(preparedDatabasePath),
      restoredDatabase: open(restoredDatabasePath), preservedDatabase: open(preservedDatabasePath),
      credentialPreparation: readJson(credentialPreparationPath), plan: candidate.plan,
      lineage: lineagePath === undefined ? null : readJson(lineagePath) }, decision: readJson(decisionPath), temporaryRoot, outputDirectory });
    output.log(JSON.stringify(result)); return result;
  } finally { for (const reader of readers.reverse()) reader.close(); }
}
if (require.main === module) {
  runRecoveryAuctionCommand({ argv: process.argv.slice(2) }).catch(error => {
    console.error(JSON.stringify({ error: {
      code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_AUCTION_COMMAND_FAILED",
      message: "Auction recovery failed safely. No activation was performed.",
    } })); process.exitCode = 1;
  });
}
module.exports = { runRecoveryAuctionCommand };
