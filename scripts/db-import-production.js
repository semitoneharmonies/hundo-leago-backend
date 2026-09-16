#!/usr/bin/env node
const { planProductionImport, runProductionImport } = require("../src/infrastructure/migration/runProductionImport");

const OPTIONS = Object.freeze({
  "--source-bundle": "sourceBundleDirectory", "--source-sha256": "sourceSha256",
  "--reset-manifest": "resetManifestPath", "--reset-sha256": "resetSha256",
  "--persistent-root": "persistentRoot", "--target": "targetDirectory",
  "--schema-version": "expectedSchemaVersion", "--build-id": "applicationBuildId",
  "--environment": "environment", "--operating-mode": "operatingMode",
  "--confirm-production": "productionConfirmation",
});
function invalid() {
  const error = new Error("Use --plan or an exact confirmation, with every required production import option once.");
  error.code = "IMPORT_ARGUMENT_INVALID";
  throw error;
}
function parseArguments(argv) {
  if (!Array.isArray(argv)) invalid();
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") {
      if (options.planOnly) invalid();
      options.planOnly = true; continue;
    }
    const name = Object.hasOwn(OPTIONS, argument) ? OPTIONS[argument] : undefined, value = argv[++index];
    if (!name || Object.hasOwn(options, name) || typeof value !== "string" || !value || value.startsWith("--")) invalid();
    options[name] = value;
  }
  if (Object.values(OPTIONS).filter((name) => name !== "productionConfirmation").some((name) => !Object.hasOwn(options, name)) ||
      !/^[1-9][0-9]*$/.test(options.expectedSchemaVersion) ||
      Boolean(options.planOnly) === Boolean(options.productionConfirmation)) invalid();
  options.expectedSchemaVersion = Number(options.expectedSchemaVersion);
  if (!Number.isSafeInteger(options.expectedSchemaVersion)) invalid();
  return Object.freeze(options);
}
function runProductionImportCommand({ argv = process.argv.slice(2), output = console } = {}) {
  const options = parseArguments(argv);
  const result = options.planOnly ? planProductionImport(options) : runProductionImport(options);
  output.log(JSON.stringify(result));
  return result;
}
if (require.main === module) {
  try { runProductionImportCommand(); }
  catch (error) {
    console.error(JSON.stringify({ error: { code: error?.code || "IMPORT_RECONCILIATION_FAILED",
      message: "Production import stopped. Inspect the plan and retain any failed attempt; no activation was performed." } }));
    process.exitCode = 1;
  }
}
module.exports = { OPTIONS, parseArguments, runProductionImportCommand };
