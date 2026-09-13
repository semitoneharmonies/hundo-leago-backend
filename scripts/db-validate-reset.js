#!/usr/bin/env node

const {
  RESET_MANIFEST_ERROR_CODES,
  ResetManifestError,
  loadAndValidateResetManifest,
} = require("../src/infrastructure/migration/resetManifest");

class ResetManifestCommandArgumentError extends ResetManifestError {
  constructor(message) {
    super(
      RESET_MANIFEST_ERROR_CODES.argumentInvalid,
      message
    );
    this.name = "ResetManifestCommandArgumentError";
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new ResetManifestCommandArgumentError(
      "Reset-manifest arguments must be an array."
    );
  }

  const optionNames = new Map([
    ["--manifest", "manifestPath"],
    ["--operating-mode", "operatingMode"],
    [
      "--source-bundle-version",
      "sourceBundleManifestVersion",
    ],
  ]);
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const optionName = optionNames.get(argument);
    if (!optionName) {
      throw new ResetManifestCommandArgumentError(
        `Unknown reset-manifest argument: ${argument}`
      );
    }
    if (Object.hasOwn(options, optionName)) {
      throw new ResetManifestCommandArgumentError(
        `Reset-manifest argument may appear only once: ${argument}`
      );
    }

    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new ResetManifestCommandArgumentError(
        `Reset-manifest argument requires a value: ${argument}`
      );
    }
    options[optionName] = value;
    index += 1;
  }

  for (const [argument, optionName] of optionNames) {
    if (!Object.hasOwn(options, optionName)) {
      throw new ResetManifestCommandArgumentError(
        `The ${argument} argument is required.`
      );
    }
  }

  if (!/^\d+$/.test(options.sourceBundleManifestVersion)) {
    throw new ResetManifestCommandArgumentError(
      "The --source-bundle-version value must be a non-negative integer."
    );
  }
  options.sourceBundleManifestVersion = Number(
    options.sourceBundleManifestVersion
  );
  if (
    !Number.isSafeInteger(
      options.sourceBundleManifestVersion
    )
  ) {
    throw new ResetManifestCommandArgumentError(
      "The --source-bundle-version value exceeds the safe range."
    );
  }

  return Object.freeze(options);
}

function runResetManifestValidationCommand({
  argv = process.argv.slice(2),
  output = console,
  loadManifest = loadAndValidateResetManifest,
} = {}) {
  const options = parseArguments(argv);
  const manifest = loadManifest(options);
  const summary = Object.freeze({
    status: "valid",
    manifestId: manifest.manifestId,
    manifestVersion: manifest.manifestVersion,
    checksum: manifest.checksum,
    omissionFamilyCount: manifest.omissionFamilies.length,
    protectedFamilyCount:
      manifest.protectedFamilies.length,
    neverImportFamilyCount:
      manifest.neverImportFamilies.length,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runResetManifestValidationCommand();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code:
            error?.code ||
            RESET_MANIFEST_ERROR_CODES.parseFailed,
          message:
            error?.message ||
            "The reset-manifest validation command failed.",
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
  ResetManifestCommandArgumentError,
  parseArguments,
  runResetManifestValidationCommand,
};
