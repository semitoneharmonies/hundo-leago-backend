#!/usr/bin/env node

const path = require("node:path");

const {
  createReleaseQaRuntime,
} = require("../src/operations/release/createReleaseQaRuntime");
const {
  rehearseReleaseQaRecovery,
} = require("../src/operations/release/rehearseReleaseQaRecovery");

const ROOT_DIRECTORY = path.resolve(__dirname, "..");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";

class ReleaseQaRecoveryArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseQaRecoveryArgumentError";
    this.code = "RELEASE_QA_RECOVERY_ARGUMENT_INVALID";
  }
}

async function runReleaseQaRecoveryCommand({
  env = process.env,
  createRuntime = createReleaseQaRuntime,
  rehearseRecovery = rehearseReleaseQaRecovery,
  output = console,
} = {}) {
  if (typeof env.M7_RELEASE_QA_PASSWORD !== "string" ||
      env.M7_RELEASE_QA_PASSWORD === "") {
    throw new ReleaseQaRecoveryArgumentError(
      "M7_RELEASE_QA_PASSWORD is required and is never written to output."
    );
  }
  const started = await createRuntime({
    frontendOrigin: FRONTEND_ORIGIN,
    leagueWriteMode: "open",
    migrationsDirectory: path.join(ROOT_DIRECTORY, "database", "migrations"),
    password: env.M7_RELEASE_QA_PASSWORD,
    port: 0,
  });
  try {
    const report = await rehearseRecovery({
      databasePath: started.databasePath,
      fixtureManifestChecksum: started.fixtureManifest.manifestChecksum,
      temporaryRoot: started.temporaryRoot,
    });
    output.log(JSON.stringify(report));
    return report;
  } finally {
    await started.close();
  }
}

async function main() {
  try {
    await runReleaseQaRecoveryCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "RELEASE_QA_RECOVERY_FAILED",
        message: error?.message || "The release-QA recovery rehearsal failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ReleaseQaRecoveryArgumentError,
  runReleaseQaRecoveryCommand,
};
