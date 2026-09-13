#!/usr/bin/env node

const {
  RESET_IMPORT_ARTIFACT_ERROR_CODES,
  ResetImportVerificationArtifactError,
  publishResetImportVerificationArtifact,
} = require("../src/infrastructure/migration/resetImportVerificationArtifact");

const SAFE_ERROR_CODES = new Set(
  Object.values(RESET_IMPORT_ARTIFACT_ERROR_CODES)
);

class ResetImportVerificationArtifactCommandArgumentError
  extends ResetImportVerificationArtifactError {
  constructor() {
    super(
      RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid
    );
    this.name =
      "ResetImportVerificationArtifactCommandArgumentError";
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
    throw new ResetImportVerificationArtifactCommandArgumentError();
  }
  for (
    let index = 0;
    index < argv.length;
    index += 2
  ) {
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
      throw new ResetImportVerificationArtifactCommandArgumentError();
    }
    options[optionName] = value;
  }
  if (
    Object.keys(options).length !== optionNames.size ||
    [...optionNames.values()].some(
      (name) => !Object.hasOwn(options, name)
    )
  ) {
    throw new ResetImportVerificationArtifactCommandArgumentError();
  }
  return Object.freeze(options);
}

function runResetImportVerificationArtifactCommand({
  argv = process.argv.slice(2),
  output = console,
  publish = publishResetImportVerificationArtifact,
} = {}) {
  const result = publish(parseArguments(argv));
  const summary = Object.freeze({
    status: result.status,
    replayed: result.replayed,
    artifactVersion: result.artifactVersion,
    evidenceBytes: result.evidenceBytes,
    evidenceSha256: result.evidenceSha256,
    verificationHash: result.verificationHash,
    stagingDescriptorSha256:
      result.stagingDescriptorSha256,
    databaseResourceId: result.databaseResourceId,
    sourceBundleId: result.sourceBundleId,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runResetImportVerificationArtifactCommand();
  } catch (error) {
    const code = SAFE_ERROR_CODES.has(error?.code)
      ? error.code
      : RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed;
    console.error(JSON.stringify({
      error: {
        code,
        message:
          "Reset import verification artifact publication failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ResetImportVerificationArtifactCommandArgumentError,
  parseArguments,
  runResetImportVerificationArtifactCommand,
};
