const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  canonicalize,
} = require("./releaseQaFixtureContract");

const EXPECTED_NODE_VERSION = "v24.14.1";
const EXPECTED_STAGING_BRANCH = "staging";
const RELEASE_ID_PATTERN = /^HL-\d{8}-[1-9]\d*$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

class ReleaseCandidatePreflightError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReleaseCandidatePreflightError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ReleaseCandidatePreflightError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readGit(directory, arguments_) {
  try {
    return execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${directory.replaceAll("\\", "/")}`,
        "-C",
        directory,
        ...arguments_,
      ],
      { encoding: "utf8", windowsHide: true }
    ).trim();
  } catch (error) {
    fail(
      "RELEASE_CANDIDATE_GIT_FAILED",
      "Release-candidate source inspection failed safely.",
      error
    );
  }
}

function inspectRepository({
  configurationFiles,
  directory,
  name,
  runGit = readGit,
} = {}) {
  if (
    !["backend", "frontend"].includes(name) ||
    !path.isAbsolute(directory || "") ||
    !Array.isArray(configurationFiles) ||
    configurationFiles.length < 1 ||
    configurationFiles.some((file) =>
      typeof file !== "string" || file === "" || path.isAbsolute(file) ||
      path.normalize(file) !== file || file.startsWith("..")
    ) ||
    typeof runGit !== "function"
  ) {
    fail(
      "RELEASE_CANDIDATE_INPUT_INVALID",
      "Exact release-candidate repository inspection input is required."
    );
  }
  const physicalDirectory = fs.realpathSync(directory);
  const status = runGit(
    physicalDirectory,
    ["status", "--porcelain=v1", "--untracked-files=all"]
  );
  const configurationSha256 = {};
  for (const relativePath of configurationFiles) {
    const filePath = path.join(physicalDirectory, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      fail(
        "RELEASE_CANDIDATE_CONFIGURATION_MISSING",
        `Required ${name} release configuration is missing.`
      );
    }
    configurationSha256[relativePath.replaceAll("\\", "/")] =
      sha256(fs.readFileSync(filePath));
  }
  return Object.freeze({
    name,
    branch: runGit(physicalDirectory, ["branch", "--show-current"]),
    commit: runGit(physicalDirectory, ["rev-parse", "--verify", "HEAD"]),
    dirtyEntryCount: status === ""
      ? 0
      : status.split(/\r?\n/u).filter(Boolean).length,
    configurationSha256: Object.freeze(configurationSha256),
  });
}

function assertRepositoryFacts(repository, name) {
  if (
    !repository || repository.name !== name ||
    typeof repository.branch !== "string" ||
    !COMMIT_PATTERN.test(repository.commit || "") ||
    !Number.isSafeInteger(repository.dirtyEntryCount) ||
    repository.dirtyEntryCount < 0 ||
    !repository.configurationSha256 ||
    typeof repository.configurationSha256 !== "object" ||
    Array.isArray(repository.configurationSha256) ||
    Object.keys(repository.configurationSha256).length < 1 ||
    Object.values(repository.configurationSha256).some(
      (value) => !/^[0-9a-f]{64}$/.test(value)
    )
  ) {
    fail(
      "RELEASE_CANDIDATE_FACTS_INVALID",
      `Exact ${name} release-candidate facts are required.`
    );
  }
}

function evaluateReleaseCandidatePreflight({
  backend,
  candidate = null,
  frontend,
  nodeVersion,
} = {}) {
  assertRepositoryFacts(backend, "backend");
  assertRepositoryFacts(frontend, "frontend");
  if (typeof nodeVersion !== "string") {
    fail(
      "RELEASE_CANDIDATE_FACTS_INVALID",
      "The exact Node runtime version is required."
    );
  }
  if (
    candidate !== null &&
    (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !==
        "backendCommit,frontendCommit,releaseId" ||
      typeof candidate.releaseId !== "string" ||
      typeof candidate.frontendCommit !== "string" ||
      typeof candidate.backendCommit !== "string"
    )
  ) {
    fail(
      "RELEASE_CANDIDATE_INPUT_INVALID",
      "Release identity and both exact commits must be supplied together."
    );
  }

  const blockers = [];
  if (nodeVersion !== EXPECTED_NODE_VERSION) {
    blockers.push("NODE_VERSION_MISMATCH");
  }
  for (const repository of [frontend, backend]) {
    const prefix = repository.name.toUpperCase();
    if (repository.branch !== EXPECTED_STAGING_BRANCH) {
      blockers.push(`${prefix}_BRANCH_NOT_STAGING`);
    }
    if (repository.dirtyEntryCount !== 0) {
      blockers.push(`${prefix}_WORKTREE_DIRTY`);
    }
  }
  if (candidate === null) {
    blockers.push("EXACT_CANDIDATE_INPUT_REQUIRED");
  } else {
    if (!RELEASE_ID_PATTERN.test(candidate.releaseId)) {
      blockers.push("RELEASE_ID_INVALID");
    }
    for (const repository of [frontend, backend]) {
      const key = `${repository.name}Commit`;
      const prefix = repository.name.toUpperCase();
      if (!COMMIT_PATTERN.test(candidate[key])) {
        blockers.push(`${prefix}_CANDIDATE_COMMIT_INVALID`);
      } else if (candidate[key] !== repository.commit) {
        blockers.push(`${prefix}_CANDIDATE_COMMIT_MISMATCH`);
      }
    }
  }

  const reportBase = Object.freeze({
    reportVersion: 1,
    status: blockers.length === 0 ? "ready-for-freeze-review" : "blocked",
    authorityGranted: false,
    mutationsPerformed: false,
    releaseId: candidate?.releaseId || null,
    nodeVersion,
    expectedNodeVersion: EXPECTED_NODE_VERSION,
    expectedBranch: EXPECTED_STAGING_BRANCH,
    frontend: Object.freeze({
      branch: frontend.branch,
      commit: frontend.commit,
      dirtyEntryCount: frontend.dirtyEntryCount,
      configurationSha256: frontend.configurationSha256,
    }),
    backend: Object.freeze({
      branch: backend.branch,
      commit: backend.commit,
      dirtyEntryCount: backend.dirtyEntryCount,
      configurationSha256: backend.configurationSha256,
    }),
    blockers: Object.freeze(blockers),
  });
  return Object.freeze({
    ...reportBase,
    reportChecksum: sha256(canonicalize(reportBase)),
  });
}

function createReleaseCandidatePreflight({
  backendDirectory,
  candidate = null,
  frontendDirectory,
  nodeVersion = process.version,
  runGit = readGit,
} = {}) {
  const backend = inspectRepository({
    name: "backend",
    directory: backendDirectory,
    configurationFiles: ["package-lock.json", "package.json", "render.yaml"],
    runGit,
  });
  const frontend = inspectRepository({
    name: "frontend",
    directory: frontendDirectory,
    configurationFiles: ["package-lock.json", "package.json", "vite.config.js"],
    runGit,
  });
  return evaluateReleaseCandidatePreflight({
    backend,
    candidate,
    frontend,
    nodeVersion,
  });
}

module.exports = {
  COMMIT_PATTERN,
  EXPECTED_NODE_VERSION,
  EXPECTED_STAGING_BRANCH,
  RELEASE_ID_PATTERN,
  ReleaseCandidatePreflightError,
  createReleaseCandidatePreflight,
  evaluateReleaseCandidatePreflight,
  inspectRepository,
};
