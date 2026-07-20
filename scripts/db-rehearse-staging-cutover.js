#!/usr/bin/env node

const {
  STAGING_REHEARSAL_ERROR_CODES,
  StagingCutoverRehearsalError,
  rehearseStagingCutover,
} = require("../src/infrastructure/migration/rehearseStagingCutover");

class StagingRehearsalCommandArgumentError
  extends StagingCutoverRehearsalError {
  constructor(message) {
    super(
      STAGING_REHEARSAL_ERROR_CODES.argumentInvalid,
      message
    );
    this.name = "StagingRehearsalCommandArgumentError";
  }
}

function parseArguments(argv) {
  const optionNames = new Map([
    ["--descriptor", "descriptorPath"],
    ["--source-bundle", "sourceBundleDirectory"],
    ["--database", "databasePath"],
    ["--reset-manifest", "resetManifestPath"],
    ["--import-report", "importReportPath"],
    ["--backup", "backupDirectory"],
    ["--rehearsal", "rehearsalDirectory"],
    ["--operating-mode", "operatingMode"],
    ["--rehearsed-at-ms", "rehearsedAtMs"],
  ]);
  const options = {};
  if (!Array.isArray(argv)) {
    throw new StagingRehearsalCommandArgumentError(
      "Staging rehearsal arguments must be an array."
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
      throw new StagingRehearsalCommandArgumentError(
        "Every staging rehearsal option is required exactly once."
      );
    }
    options[optionName] = value;
  }
  if (
    Object.keys(options).length !== optionNames.size ||
    [...optionNames.values()].some(
      (name) => !Object.hasOwn(options, name)
    ) ||
    !/^\d+$/.test(options.rehearsedAtMs)
  ) {
    throw new StagingRehearsalCommandArgumentError(
      "Every staging rehearsal option is required exactly once."
    );
  }
  options.rehearsedAtMs = Number(options.rehearsedAtMs);
  if (!Number.isSafeInteger(options.rehearsedAtMs)) {
    throw new StagingRehearsalCommandArgumentError(
      "The rehearsal timestamp exceeds the safe integer range."
    );
  }
  return Object.freeze(options);
}

async function runStagingRehearsalCommand({
  argv = process.argv.slice(2),
  output = console,
  rehearse = rehearseStagingCutover,
} = {}) {
  const result = await rehearse(parseArguments(argv));
  const summary = Object.freeze({
    status: result.status,
    environment: result.environment,
    rehearsalHash: result.rehearsalHash,
    sourceVerificationHash:
      result.sourceVerificationHash,
    backupId: result.backupId,
    backupSha256: result.backupSha256,
    candidateSha256: result.candidateSha256,
    applicationAuthority:
      result.applicationAuthority,
    sqliteApplicationAuthorityEnabled:
      result.sqliteApplicationAuthorityEnabled,
    productionAuthorityChanged:
      result.productionAuthorityChanged,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

async function main() {
  try {
    await runStagingRehearsalCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code:
          error?.code ||
          STAGING_REHEARSAL_ERROR_CODES.publicationFailed,
        message:
          error?.message ||
          "The staging cutover rehearsal failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  StagingRehearsalCommandArgumentError,
  parseArguments,
  runStagingRehearsalCommand,
};
