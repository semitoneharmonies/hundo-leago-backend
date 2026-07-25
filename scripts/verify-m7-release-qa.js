#!/usr/bin/env node

const {
  verifyReleaseQaRuntime,
} = require("../src/operations/release/verifyReleaseQaRuntime");

class ReleaseQaVerificationArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseQaVerificationArgumentError";
    this.code = "RELEASE_QA_VERIFICATION_ARGUMENT_INVALID";
  }
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--base-url", "baseUrl"],
    ["--fixture-manifest-checksum", "fixtureManifestChecksum"],
    ["--frontend-origin", "frontendOrigin"],
    ["--write-mode", "expectedWriteMode"],
  ]);
  if (!Array.isArray(argv)) {
    throw new ReleaseQaVerificationArgumentError("Arguments must be an array.");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || Object.hasOwn(options, name) || typeof value !== "string" ||
        value === "" || value.startsWith("--")) {
      throw new ReleaseQaVerificationArgumentError(
        "Every release-QA verification argument is required exactly once."
      );
    }
    options[name] = value;
  }
  if (Object.keys(options).length !== names.size) {
    throw new ReleaseQaVerificationArgumentError(
      "Every release-QA verification argument is required exactly once."
    );
  }
  return Object.freeze(options);
}

async function runReleaseQaVerificationCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
  verify = verifyReleaseQaRuntime,
} = {}) {
  const options = parseArguments(argv);
  if (typeof env.M7_RELEASE_QA_PASSWORD !== "string" ||
      env.M7_RELEASE_QA_PASSWORD === "") {
    throw new ReleaseQaVerificationArgumentError(
      "M7_RELEASE_QA_PASSWORD is required and is never written to output."
    );
  }
  const report = await verify({
    ...options,
    password: env.M7_RELEASE_QA_PASSWORD,
  });
  output.log(JSON.stringify(report));
  return report;
}

async function main() {
  try {
    await runReleaseQaVerificationCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "RELEASE_QA_RUNTIME_VERIFICATION_FAILED",
        message: error?.message || "The release-QA runtime verification failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ReleaseQaVerificationArgumentError,
  parseArguments,
  runReleaseQaVerificationCommand,
};
