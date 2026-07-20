#!/usr/bin/env node

const {
  JSON_IMPORT_ERROR_CODES,
  JsonImportError,
} = require("../src/infrastructure/migration/runJsonImport");
const {
  runStagingImport,
} = require("../src/infrastructure/migration/runStagingImport");

class StagingImportCommandArgumentError extends JsonImportError {
  constructor(message) {
    super(JSON_IMPORT_ERROR_CODES.argumentInvalid, message);
    this.name = "StagingImportCommandArgumentError";
  }
}

function parseArguments(argv) {
  const optionNames = new Map([
    ["--descriptor", "descriptorPath"],
    ["--source-bundle", "sourceBundleDirectory"],
    ["--database", "databasePath"],
    ["--reset-manifest", "resetManifestPath"],
    ["--report", "reportDirectory"],
    ["--operating-mode", "operatingMode"],
  ]);
  const options = {};
  if (!Array.isArray(argv)) {
    throw new StagingImportCommandArgumentError(
      "Staging import arguments must be an array."
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
      throw new StagingImportCommandArgumentError(
        "Every staging import option is required exactly once."
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
    throw new StagingImportCommandArgumentError(
      "Every staging import option is required exactly once."
    );
  }
  return Object.freeze(options);
}

function runStagingImportCommand({
  argv = process.argv.slice(2),
  output = console,
  runImport = runStagingImport,
} = {}) {
  const result = runImport(parseArguments(argv));
  const summary = Object.freeze({
    status: result.status,
    environment: result.environment,
    sourceBundleId: result.sourceBundleId,
    resetManifestId: result.resetManifestId,
    stagingDescriptorSha256:
      result.stagingDescriptorSha256,
    databaseSha256: result.databaseSha256,
    databaseBytes: result.databaseBytes,
    semanticReportHash: result.semanticReportHash,
    importedRowCount: result.importedRowCount,
    blockingRejectCount: result.blockingRejectCount,
    quarantineCount: result.quarantineCount,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runStagingImportCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code:
          error?.code ||
          JSON_IMPORT_ERROR_CODES.reconciliationFailed,
        message:
          error?.message ||
          "The staging import failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  StagingImportCommandArgumentError,
  parseArguments,
  runStagingImportCommand,
};
