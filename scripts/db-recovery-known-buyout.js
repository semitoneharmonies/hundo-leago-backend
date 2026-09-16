#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { openReadonlyDatabase } = require("../src/infrastructure/database/connection");
const { canonicalize } = require("../src/infrastructure/migration/sourceInventory");
const { hash, buildKnownBuyoutEvidence } = require("../src/operations/backups/recoveryKnownBuyoutEvidence");
const { prepareRecoveryKnownBuyout } = require("../src/operations/backups/prepareRecoveryKnownBuyout");

const FIELDS = ["requestVersion", "credentialPreparationPath", "candidateReviewPath", "preparedDatabasePath", "restoredDatabasePath",
  "preservedDatabasePath", "preservedPlaintextSha256", "buyoutId", "leagueId", "observedAtMs", "backupManifestPath",
  "preservationManifestPath", "expectedBackupManifestSha256", "expectedPreservationManifestSha256"];
function fail() { const error = new Error("Known buyout recovery requires an exact request and saved offline evidence.");
  error.code = "RECOVERY_BUYOUT_REQUEST_INVALID"; throw error; }
function absoluteFile(file) {
  if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file) || !fs.statSync(file).isFile() ||
      fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).nlink !== 1) fail();
  return file;
}
function bytes(file) { const stat = fs.statSync(absoluteFile(file)); if (stat.size < 2 || stat.size > 16 * 1024 * 1024) fail(); return fs.readFileSync(file); }
function json(file) { const value = JSON.parse(bytes(file).toString("utf8").replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(); return value; }
async function runKnownBuyoutCommand({ argv, output = console } = {}) {
  const readers = [];
  try {
    if (!Array.isArray(argv) || argv.length !== 2 || !["--review", "--request"].includes(argv[0])) fail();
    const readOnly = argv[0] === "--review", request = json(argv[1]);
    const required = [...FIELDS, ...(readOnly ? [] : ["decisionPath", "temporaryRoot", "outputDirectory"])];
    if (request.requestVersion !== 1 || required.some(field => !Object.hasOwn(request, field)) ||
        Object.keys(request).some(field => !required.includes(field) && field !== "lineagePath")) fail();
    const { requestVersion, credentialPreparationPath, candidateReviewPath, preparedDatabasePath, restoredDatabasePath, preservedDatabasePath,
      backupManifestPath, preservationManifestPath, decisionPath, temporaryRoot, outputDirectory, lineagePath, ...input } = request;
    const candidate = json(candidateReviewPath), { reportChecksum, ...body } = candidate;
    if (candidate.reviewVersion !== 1 || candidate.status !== "held-candidate-reviewed" || candidate.activationReady !== false ||
        candidate.executable !== false || hash(canonicalize(body)) !== reportChecksum) fail();
    const open = file => { absoluteFile(file);
      if ((fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size !== 0) || fs.existsSync(`${file}-journal`)) fail();
      const reader = openReadonlyDatabase({ databasePath: file }); readers.push(reader); return reader; };
    const reviewOptions = { ...input, preparedDatabase: open(preparedDatabasePath), restoredDatabase: open(restoredDatabasePath),
      preservedDatabase: open(preservedDatabasePath), credentialPreparation: json(credentialPreparationPath), plan: candidate.plan,
      backupManifestBytes: bytes(backupManifestPath), preservationManifestBytes: bytes(preservationManifestPath), lineage: lineagePath === undefined ? null : json(lineagePath) };
    const result = readOnly ? buildKnownBuyoutEvidence(reviewOptions).review : await prepareRecoveryKnownBuyout({ reviewOptions,
      decision: json(decisionPath), temporaryRoot, outputDirectory });
    output.log(JSON.stringify(result)); return result;
  } finally { for (const reader of readers.reverse()) if (reader.open) reader.close(); }
}
if (require.main === module) runKnownBuyoutCommand({ argv: process.argv.slice(2) }).catch(error => {
  console.error(JSON.stringify({ error: { code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_BUYOUT_COMMAND_FAILED",
    message: "Known buyout recovery failed safely. No activation was performed." } })); process.exitCode = 1;
});
module.exports = { runKnownBuyoutCommand };
