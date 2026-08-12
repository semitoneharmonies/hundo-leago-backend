#!/usr/bin/env node

const path = require("node:path");

const {
  createReleaseQaFixture,
} = require("../src/operations/release/createReleaseQaFixture");

const ROOT_DIRECTORY = path.resolve(__dirname, "..");

class ReleaseQaFixtureArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseQaFixtureArgumentError";
    this.code = "RELEASE_QA_ARGUMENT_INVALID";
  }
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--database", "databasePath"],
    ["--provider-catalog-database", "providerCatalogSourceDatabasePath"],
    ["--temporary-root", "temporaryRoot"],
  ]);
  if (!Array.isArray(argv)) {
    throw new ReleaseQaFixtureArgumentError("Arguments must be an array.");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || Object.hasOwn(options, name) || typeof value !== "string" ||
        value === "" || value.startsWith("--")) {
      throw new ReleaseQaFixtureArgumentError(
        "--database and --temporary-root are each required exactly once."
      );
    }
    options[name] = value;
  }
  if (
    !Object.hasOwn(options, "databasePath") ||
    !Object.hasOwn(options, "temporaryRoot") ||
    ![2, 3].includes(Object.keys(options).length)
  ) {
    throw new ReleaseQaFixtureArgumentError(
      "--database and --temporary-root are required; the provider catalog is optional."
    );
  }
  return Object.freeze(options);
}

async function runReleaseQaFixtureCommand({
  argv = process.argv.slice(2),
  env = process.env,
  createFixture = createReleaseQaFixture,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  if (typeof env.M7_RELEASE_QA_PASSWORD !== "string" ||
      env.M7_RELEASE_QA_PASSWORD === "") {
    throw new ReleaseQaFixtureArgumentError(
      "M7_RELEASE_QA_PASSWORD is required and is never included in fixture output."
    );
  }
  const result = await createFixture({
    ...options,
    environment: "test",
    migrationsDirectory: path.join(ROOT_DIRECTORY, "database", "migrations"),
    password: env.M7_RELEASE_QA_PASSWORD,
  });
  output.log(JSON.stringify(result.manifest));
  return result;
}

async function main() {
  try {
    await runReleaseQaFixtureCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "RELEASE_QA_FIXTURE_FAILED",
        message: error?.message || "Release-QA fixture creation failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ReleaseQaFixtureArgumentError,
  parseArguments,
  runReleaseQaFixtureCommand,
};
