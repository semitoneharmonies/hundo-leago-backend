#!/usr/bin/env node

const {
  JSON_IMPORT_ERROR_CODES,
  JsonImportError,
  runJsonImportDryRun,
} = require("../src/infrastructure/migration/runJsonImport");

class JsonImportCommandArgumentError extends JsonImportError {
  constructor(message) {
    super(
      JSON_IMPORT_ERROR_CODES.argumentInvalid,
      message
    );
    this.name = "JsonImportCommandArgumentError";
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new JsonImportCommandArgumentError(
      "JSON import arguments must be an array."
    );
  }
  const optionNames = new Map([
    ["--source-bundle", "sourceBundleDirectory"],
    ["--database", "databasePath"],
    ["--reset-manifest", "resetManifestPath"],
    ["--report", "reportDirectory"],
    ["--environment", "environment"],
    ["--operating-mode", "operatingMode"],
  ]);
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (options.dryRun === true) {
        throw new JsonImportCommandArgumentError(
          "The --dry-run flag may appear only once."
        );
      }
      options.dryRun = true;
      continue;
    }

    const optionName = optionNames.get(argument);
    if (!optionName) {
      throw new JsonImportCommandArgumentError(
        `Unknown JSON import argument: ${argument}`
      );
    }
    if (Object.hasOwn(options, optionName)) {
      throw new JsonImportCommandArgumentError(
        `JSON import argument may appear only once: ${argument}`
      );
    }
    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new JsonImportCommandArgumentError(
        `JSON import argument requires a value: ${argument}`
      );
    }
    options[optionName] = value;
    index += 1;
  }

  for (const [argument, optionName] of optionNames) {
    if (!Object.hasOwn(options, optionName)) {
      throw new JsonImportCommandArgumentError(
        `The ${argument} argument is required.`
      );
    }
  }
  if (options.dryRun !== true) {
    throw new JsonImportCommandArgumentError(
      "The --dry-run flag is required in M2-09."
    );
  }

  return Object.freeze(options);
}

function runJsonImportCommand({
  argv = process.argv.slice(2),
  output = console,
  runImport = runJsonImportDryRun,
} = {}) {
  const options = parseArguments(argv);
  const result = runImport(options);
  const summary = Object.freeze({
    status: result.status,
    dryRun: result.dryRun,
    sourceBundleId: result.sourceBundleId,
    resetManifestId: result.resetManifestId,
    semanticReportHash: result.semanticReportHash,
    plannedRowCount: result.plannedRowCount,
    blockingRejectCount: result.blockingRejectCount,
    quarantineCount: result.quarantineCount,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runJsonImportCommand();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code:
            error?.code ||
            JSON_IMPORT_ERROR_CODES.reconciliationFailed,
          message:
            error?.message ||
            "The JSON import dry-run failed safely.",
        },
      })
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  JsonImportCommandArgumentError,
  parseArguments,
  runJsonImportCommand,
};
