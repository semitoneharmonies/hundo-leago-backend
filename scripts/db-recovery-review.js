#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openReadonlyDatabase } = require("../src/infrastructure/database/connection");
const { canonicalize } = require("../src/infrastructure/migration/sourceInventory");
const { buildRecoveryReconciliationPlan } = require("../src/operations/backups/buildRecoveryReconciliationPlan");
const { buildEmailReconciledRecoveryPlan } = require("../src/operations/backups/buildEmailReconciledRecoveryPlan");
const { compareRecoveryLossWindow } = require("../src/operations/backups/compareRecoveryLossWindow");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;

class RecoveryReviewCommandError extends Error {
  constructor(code) {
    super("Recovery review requires exact offline candidates and verified receipts. No activation was performed.");
    this.name = "RecoveryReviewCommandError";
    this.code = code;
  }
}
function fail(code) { throw new RecoveryReviewCommandError(code); }
function absoluteFile(file) {
  if (typeof file !== "string" || file !== file.trim() || !path.isAbsolute(file) || !fs.statSync(file).isFile()) {
    fail("RECOVERY_REVIEW_FILE_INVALID");
  }
  return file;
}
function readJson(file) {
  absoluteFile(file);
  const size = fs.statSync(file).size;
  if (size < 2 || size > MAX_REQUEST_BYTES) fail("RECOVERY_REVIEW_FILE_INVALID");
  const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!value || Array.isArray(value) || typeof value !== "object") fail("RECOVERY_REVIEW_FILE_INVALID");
  return value;
}
function exactFields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    fail("RECOVERY_REVIEW_REQUEST_INVALID");
  }
}
function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request") fail("RECOVERY_REVIEW_ARGUMENT_INVALID");
  return absoluteFile(argv[1]);
}

// This command only composes existing verification primitives. It does not
// load a runtime, contact a provider, infer dispositions or replace a database.
function runRecoveryReviewCommand({ argv, output = console } = {}) {
  const readers = [];
  const open = file => {
    absoluteFile(file);
    if ((fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size !== 0) || fs.existsSync(`${file}-journal`)) {
      fail("RECOVERY_REVIEW_SOURCE_NOT_OFFLINE");
    }
    const database = openReadonlyDatabase({ databasePath: file });
    readers.push(database);
    return database;
  };
  try {
    const request = readJson(parseArguments(argv));
    exactFields(request, ["requestVersion", "expectedEnvironmentId", "expectedDatabaseId", "observedAtMs",
      "preparedDatabasePath", "credentialPreparationPath"], ["emailReview", "lossWindow"]);
    if (request.requestVersion !== 1 || !IDENTITY.test(request.expectedEnvironmentId) ||
        !IDENTITY.test(request.expectedDatabaseId) || !Number.isSafeInteger(request.observedAtMs) || request.observedAtMs < 0) {
      fail("RECOVERY_REVIEW_REQUEST_INVALID");
    }
    const credentialPreparation = readJson(request.credentialPreparationPath);
    const preparedDatabase = open(request.preparedDatabasePath);
    let plan;
    if (request.emailReview !== undefined) {
      exactFields(request.emailReview, ["originalPlanPath", "emailReconciliationPath", "reconciledDatabasePath"]);
      const originalPlan = readJson(request.emailReview.originalPlanPath);
      if (originalPlan.databaseIdentity?.environmentId !== request.expectedEnvironmentId ||
          originalPlan.databaseIdentity?.databaseId !== request.expectedDatabaseId) fail("RECOVERY_REVIEW_IDENTITY_MISMATCH");
      plan = buildEmailReconciledRecoveryPlan({ preparedDatabase,
        reconciledDatabase: open(request.emailReview.reconciledDatabasePath), credentialPreparation, originalPlan,
        emailReconciliation: readJson(request.emailReview.emailReconciliationPath), observedAtMs: request.observedAtMs });
    } else {
      plan = buildRecoveryReconciliationPlan({ database: preparedDatabase, credentialPreparation,
        observedAtMs: request.observedAtMs, expectedEnvironmentId: request.expectedEnvironmentId,
        expectedDatabaseId: request.expectedDatabaseId });
    }
    let lossWindow = null;
    if (request.lossWindow !== undefined) {
      exactFields(request.lossWindow, ["restoredDatabasePath", "preservedDatabasePath", "preservedPlaintextSha256"]);
      if (!DIGEST.test(request.lossWindow.preservedPlaintextSha256)) fail("RECOVERY_REVIEW_REQUEST_INVALID");
      lossWindow = compareRecoveryLossWindow({ restoredDatabase: open(request.lossWindow.restoredDatabasePath),
        preservedDatabase: open(request.lossWindow.preservedDatabasePath),
        restoredPlaintextSha256: plan.sourcePlaintextSha256,
        preservedPlaintextSha256: request.lossWindow.preservedPlaintextSha256,
        sourceBackupId: plan.sourceBackupId, expectedEnvironmentId: request.expectedEnvironmentId,
        expectedDatabaseId: request.expectedDatabaseId, observedAtMs: request.observedAtMs });
    }
    const report = { reviewVersion: 1, status: "held-candidate-reviewed", requestSha256: hash(canonicalize(request)),
      plan, lossWindow, evidenceScope: "offline-candidate-review", providerEvidenceFetched: false,
      completeLossWindowEvidence: false, activationReady: false, executable: false };
    const result = Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
    output.log(JSON.stringify(result));
    return result;
  } finally {
    for (const reader of readers.reverse()) reader.close();
  }
}

if (require.main === module) {
  try { runRecoveryReviewCommand({ argv: process.argv.slice(2) }); }
  catch (error) {
    console.error(JSON.stringify({ error: {
      code: /^RECOVERY_[A-Z_]+$/.test(error?.code || "") ? error.code : "RECOVERY_REVIEW_FAILED",
      message: "Recovery review failed safely. No activation was performed.",
    } }));
    process.exitCode = 1;
  }
}
module.exports = { RecoveryReviewCommandError, parseArguments, runRecoveryReviewCommand };
