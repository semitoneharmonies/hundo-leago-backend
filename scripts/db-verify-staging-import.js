#!/usr/bin/env node

const {
  STAGING_VERIFICATION_ERROR_CODES,
  StagingImportVerificationError,
  verifyStagingImport,
} = require("../src/infrastructure/migration/verifyStagingImport");

class StagingVerificationCommandArgumentError
  extends StagingImportVerificationError {
  constructor(message) {
    super(
      STAGING_VERIFICATION_ERROR_CODES.argumentInvalid,
      message
    );
    this.name = "StagingVerificationCommandArgumentError";
  }
}

function parseArguments(argv) {
  const optionNames = new Map([
    ["--descriptor", "descriptorPath"],
    ["--source-bundle", "sourceBundleDirectory"],
    ["--database", "databasePath"],
    ["--reset-manifest", "resetManifestPath"],
    ["--import-report", "importReportPath"],
    ["--operating-mode", "operatingMode"],
  ]);
  const options = {};
  if (!Array.isArray(argv)) {
    throw new StagingVerificationCommandArgumentError(
      "Staging verification arguments must be an array."
    );
  }
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const optionName = optionNames.get(argument);
    const value = argv[index + 1];
    if (
      !optionName ||
      Object.hasOwn(options, optionName) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new StagingVerificationCommandArgumentError(
        "Every staging verification option is required exactly once."
      );
    }
    options[optionName] = value;
  }
  if (
    Object.keys(options).length !== optionNames.size ||
    [...optionNames.values()].some(
      (name) => !Object.hasOwn(options, name)
    )
  ) {
    throw new StagingVerificationCommandArgumentError(
      "Every staging verification option is required exactly once."
    );
  }
  return Object.freeze(options);
}

function runStagingVerificationCommand({
  argv = process.argv.slice(2),
  output = console,
  verify = verifyStagingImport,
} = {}) {
  const evidence = verify(parseArguments(argv));
  const summary = Object.freeze({
    status: evidence.status,
    environment: evidence.environment,
    verificationHash: evidence.verificationHash,
    sourceBundleId: evidence.sourceBundle.id,
    databaseSha256: evidence.database.sha256,
    importReportSha256: evidence.importReport.sha256,
    semanticReportHash:
      evidence.importReport.semanticReportHash,
    importedRowCount: evidence.database.targetTables.reduce(
      (total, table) => total + table.validatedRowCount,
      0
    ),
    integrity: evidence.checks.integrity,
    foreignKeyViolationCount:
      evidence.checks.foreignKeyViolationCount,
    applicationAuthority:
      evidence.checks.applicationAuthority,
    sqliteApplicationAuthorityEnabled:
      evidence.checks.sqliteApplicationAuthorityEnabled,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runStagingVerificationCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code:
          error?.code ||
          STAGING_VERIFICATION_ERROR_CODES.semanticMismatch,
        message:
          error?.message ||
          "Staging import verification failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  StagingVerificationCommandArgumentError,
  parseArguments,
  runStagingVerificationCommand,
};
