#!/usr/bin/env node

const {
  STAGING_DESCRIPTOR_ERROR_CODES,
  StagingDescriptorError,
  descriptorSha256,
  loadAndValidateStagingDescriptor,
} = require("../src/infrastructure/database/stagingEnvironment");

class StagingDescriptorCommandArgumentError extends StagingDescriptorError {
  constructor(message) {
    super(STAGING_DESCRIPTOR_ERROR_CODES.argumentInvalid, message);
    this.name = "StagingDescriptorCommandArgumentError";
  }
}

function parseArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--descriptor" ||
    typeof argv[1] !== "string" ||
    argv[1].trim() === "" ||
    argv[1].startsWith("--")
  ) {
    throw new StagingDescriptorCommandArgumentError(
      "Exactly one --descriptor <path> argument is required."
    );
  }
  return Object.freeze({ descriptorPath: argv[1] });
}

function runStagingDescriptorValidationCommand({
  argv = process.argv.slice(2),
  output = console,
  loadDescriptor = loadAndValidateStagingDescriptor,
} = {}) {
  const descriptor = loadDescriptor(parseArguments(argv));
  const summary = Object.freeze({
    status: "valid",
    descriptorVersion: descriptor.descriptorVersion,
    descriptorSha256: descriptorSha256(descriptor),
    environment: descriptor.environment,
    serviceId: descriptor.resourceIds.service,
    diskId: descriptor.resourceIds.disk,
    databaseId: descriptor.resourceIds.database,
    applicationAuthority: descriptor.applicationAuthority,
    sqliteApplicationAuthorityEnabled:
      descriptor.sqliteApplicationAuthorityEnabled,
    productionStorageAccessible:
      descriptor.productionStorageAccessible,
    productionSecretsAccessible:
      descriptor.productionSecretsAccessible,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runStagingDescriptorValidationCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code:
          error?.code ||
          STAGING_DESCRIPTOR_ERROR_CODES.readFailed,
        message:
          error?.message ||
          "Staging descriptor validation failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  StagingDescriptorCommandArgumentError,
  parseArguments,
  runStagingDescriptorValidationCommand,
};
