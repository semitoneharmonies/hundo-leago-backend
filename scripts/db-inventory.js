#!/usr/bin/env node

const {
  SOURCE_INVENTORY_ERROR_CODES,
  SourceInventoryError,
  inventorySourceBundle,
} = require("../src/infrastructure/migration/sourceInventory");

class InventoryCommandArgumentError extends SourceInventoryError {
  constructor(message) {
    super(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      message
    );
    this.name = "InventoryCommandArgumentError";
  }
}

function parseSourceArgument(value) {
  const separatorIndex = value.indexOf("=");
  if (
    separatorIndex < 1 ||
    separatorIndex === value.length - 1
  ) {
    throw new InventoryCommandArgumentError(
      "The --source value must use label=path."
    );
  }

  return {
    label: value.slice(0, separatorIndex),
    path: value.slice(separatorIndex + 1),
  };
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new InventoryCommandArgumentError(
      "Inventory arguments must be an array."
    );
  }

  const options = {
    sources: [],
  };
  const singletonOptions = new Map([
    ["--output", "outputDirectory"],
    ["--captured-at-ms", "capturedAtMs"],
    ["--build", "applicationBuildId"],
    ["--git-commit", "sourceGitCommit"],
  ]);
  const seenSingletons = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new InventoryCommandArgumentError(
        `Inventory argument requires a value: ${argument}`
      );
    }

    if (argument === "--source") {
      options.sources.push(parseSourceArgument(value));
      index += 1;
      continue;
    }

    const optionName = singletonOptions.get(argument);
    if (!optionName) {
      throw new InventoryCommandArgumentError(
        `Unknown inventory argument: ${argument}`
      );
    }
    if (seenSingletons.has(argument)) {
      throw new InventoryCommandArgumentError(
        `Inventory argument may appear only once: ${argument}`
      );
    }
    seenSingletons.add(argument);
    options[optionName] = value;
    index += 1;
  }

  if (!options.outputDirectory) {
    throw new InventoryCommandArgumentError(
      "The --output argument is required."
    );
  }
  if (options.capturedAtMs === undefined) {
    throw new InventoryCommandArgumentError(
      "The --captured-at-ms argument is required."
    );
  }
  if (options.sources.length === 0) {
    throw new InventoryCommandArgumentError(
      "At least one --source argument is required."
    );
  }
  if (!/^\d+$/.test(options.capturedAtMs)) {
    throw new InventoryCommandArgumentError(
      "The --captured-at-ms value must be a non-negative integer."
    );
  }
  options.capturedAtMs = Number(options.capturedAtMs);
  if (!Number.isSafeInteger(options.capturedAtMs)) {
    throw new InventoryCommandArgumentError(
      "The --captured-at-ms value exceeds the safe range."
    );
  }

  return options;
}

function runInventoryCommand({
  argv = process.argv.slice(2),
  output = console,
  inventory = inventorySourceBundle,
} = {}) {
  const options = parseArguments(argv);
  const result = inventory(options);
  const summary = {
    status: "created",
    sourceBundleId: result.manifest.sourceBundleId,
    bundleChecksum: result.manifest.bundleChecksum,
    sourceCount: result.manifest.sources.length,
    fileCount: result.manifest.sources.reduce(
      (total, source) => total + source.files.length,
      0
    ),
  };
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runInventoryCommand();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code:
            error?.code ||
            SOURCE_INVENTORY_ERROR_CODES.operationFailed,
          message:
            error?.message ||
            "The source inventory command failed.",
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
  InventoryCommandArgumentError,
  parseArguments,
  parseSourceArgument,
  runInventoryCommand,
};
