#!/usr/bin/env node

const path = require("node:path");

const {
  createReleaseCandidatePreflight,
} = require("../src/operations/release/createReleaseCandidatePreflight");

const BACKEND_DIRECTORY = path.resolve(__dirname, "..");
const FRONTEND_DIRECTORY = path.resolve(BACKEND_DIRECTORY, "..", "hundo-leago");

class ReleaseCandidateArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseCandidateArgumentError";
    this.code = "RELEASE_CANDIDATE_ARGUMENT_INVALID";
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new ReleaseCandidateArgumentError("Arguments must be an array.");
  }
  if (argv.length === 0) return null;
  const names = new Map([
    ["--release-id", "releaseId"],
    ["--frontend-commit", "frontendCommit"],
    ["--backend-commit", "backendCommit"],
  ]);
  const candidate = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    const value = argv[index + 1];
    if (
      !key || Object.hasOwn(candidate, key) || typeof value !== "string" ||
      value === "" || value.startsWith("--")
    ) {
      throw new ReleaseCandidateArgumentError(
        "Use no arguments for inspection, or provide release ID and both commits exactly once."
      );
    }
    candidate[key] = value;
  }
  if (Object.keys(candidate).length !== names.size) {
    throw new ReleaseCandidateArgumentError(
      "Use no arguments for inspection, or provide release ID and both commits exactly once."
    );
  }
  return Object.freeze(candidate);
}

function runReleaseCandidatePreflightCommand({
  argv = process.argv.slice(2),
  createPreflight = createReleaseCandidatePreflight,
  output = console,
} = {}) {
  const candidate = parseArguments(argv);
  const report = createPreflight({
    backendDirectory: BACKEND_DIRECTORY,
    frontendDirectory: FRONTEND_DIRECTORY,
    candidate,
  });
  output.log(JSON.stringify(report));
  return report;
}

function main() {
  try {
    const report = runReleaseCandidatePreflightCommand();
    if (report.status !== "ready-for-freeze-review") process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "RELEASE_CANDIDATE_PREFLIGHT_FAILED",
        message: error?.message || "Release-candidate preflight failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ReleaseCandidateArgumentError,
  parseArguments,
  runReleaseCandidatePreflightCommand,
};
