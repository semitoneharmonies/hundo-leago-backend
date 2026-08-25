#!/usr/bin/env node

const path = require("node:path");

const {
  createReleaseQaRuntime,
} = require("../src/operations/release/createReleaseQaRuntime");

const ROOT_DIRECTORY = path.resolve(__dirname, "..");

class ReleaseQaRuntimeArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseQaRuntimeArgumentError";
    this.code = "RELEASE_QA_RUNTIME_ARGUMENT_INVALID";
  }
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--frontend-origin", "frontendOrigin"],
    ["--port", "port"],
    ["--write-mode", "leagueWriteMode"],
  ]);
  if (!Array.isArray(argv)) {
    throw new ReleaseQaRuntimeArgumentError("Arguments must be an array.");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || Object.hasOwn(options, name) || typeof value !== "string" ||
        value === "" || value.startsWith("--")) {
      throw new ReleaseQaRuntimeArgumentError(
        "--frontend-origin, --port, and --write-mode are each required exactly once."
      );
    }
    options[name] = name === "port" && /^\d{1,5}$/.test(value)
      ? Number(value)
      : value;
  }
  if (Object.keys(options).length !== names.size ||
      !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535 ||
      !["closed", "open"].includes(options.leagueWriteMode)) {
    throw new ReleaseQaRuntimeArgumentError(
      "--frontend-origin, a nonzero --port, and --write-mode closed|open are required."
    );
  }
  return Object.freeze(options);
}

async function runReleaseQaRuntimeCommand({
  argv = process.argv.slice(2),
  env = process.env,
  createRuntime = createReleaseQaRuntime,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  if (typeof env.M7_RELEASE_QA_PASSWORD !== "string" ||
      env.M7_RELEASE_QA_PASSWORD === "") {
    throw new ReleaseQaRuntimeArgumentError(
      "M7_RELEASE_QA_PASSWORD is required and is never written to output."
    );
  }
  const started = await createRuntime({
    ...options,
    migrationsDirectory: path.join(ROOT_DIRECTORY, "database", "migrations"),
    password: env.M7_RELEASE_QA_PASSWORD,
  });
  output.log(JSON.stringify({
    status: "ready",
    baseUrl: started.baseUrl,
    frontendOrigin: started.frontendOrigin,
    fixtureManifestChecksum: started.fixtureManifest.manifestChecksum,
    scheduler: started.schedulerStart.status,
    writeMode: options.leagueWriteMode,
  }));
  return started;
}

async function main() {
  let started;
  let closing = null;
  function close(signal) {
    if (closing || !started) return closing;
    closing = started.close().then(() => {
      process.stdout.write(`${JSON.stringify({ status: "closed", signal })}\n`);
    });
    return closing;
  }
  try {
    started = await runReleaseQaRuntimeCommand();
    process.once("SIGINT", () => close("SIGINT").catch(() => { process.exitCode = 1; }));
    process.once("SIGTERM", () => close("SIGTERM").catch(() => { process.exitCode = 1; }));
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "RELEASE_QA_RUNTIME_START_FAILED",
        message: error?.message || "The release-QA runtime failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ReleaseQaRuntimeArgumentError,
  parseArguments,
  runReleaseQaRuntimeCommand,
};
