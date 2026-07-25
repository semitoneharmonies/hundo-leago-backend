const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EXPECTED_NODE_VERSION,
  evaluateReleaseCandidatePreflight,
  inspectRepository,
} = require("../../src/operations/release/createReleaseCandidatePreflight");
const {
  ReleaseCandidateArgumentError,
  parseArguments,
  runReleaseCandidatePreflightCommand,
} = require("../../scripts/release-candidate-preflight");

const FRONTEND_COMMIT = "a".repeat(40);
const BACKEND_COMMIT = "b".repeat(40);
const FILE_HASH = "c".repeat(64);

function repository(name, overrides = {}) {
  return Object.freeze({
    name,
    branch: "staging",
    commit: name === "frontend" ? FRONTEND_COMMIT : BACKEND_COMMIT,
    dirtyEntryCount: 0,
    configurationSha256: Object.freeze({ "package-lock.json": FILE_HASH }),
    ...overrides,
  });
}

test("release-candidate preflight blocks implicit, dirty, and non-staging source", () => {
  const report = evaluateReleaseCandidatePreflight({
    frontend: repository("frontend", {
      branch: "feature/local-work",
      dirtyEntryCount: 3,
    }),
    backend: repository("backend", { dirtyEntryCount: 2 }),
    nodeVersion: EXPECTED_NODE_VERSION,
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers, [
    "FRONTEND_BRANCH_NOT_STAGING",
    "FRONTEND_WORKTREE_DIRTY",
    "BACKEND_WORKTREE_DIRTY",
    "EXACT_CANDIDATE_INPUT_REQUIRED",
  ]);
  assert.equal(report.authorityGranted, false);
  assert.equal(report.mutationsPerformed, false);
  assert.match(report.reportChecksum, /^[0-9a-f]{64}$/);
});

test("release-candidate preflight blocks invalid identity and commit mismatch", () => {
  const report = evaluateReleaseCandidatePreflight({
    frontend: repository("frontend"),
    backend: repository("backend"),
    candidate: {
      releaseId: "release-one",
      frontendCommit: "d".repeat(40),
      backendCommit: "invalid",
    },
    nodeVersion: "v22.0.0",
  });
  assert.deepEqual(report.blockers, [
    "NODE_VERSION_MISMATCH",
    "RELEASE_ID_INVALID",
    "FRONTEND_CANDIDATE_COMMIT_MISMATCH",
    "BACKEND_CANDIDATE_COMMIT_INVALID",
  ]);
  assert.equal(report.status, "blocked");
});

test("release-candidate preflight marks only exact clean staging input ready for freeze review", () => {
  const report = evaluateReleaseCandidatePreflight({
    frontend: repository("frontend"),
    backend: repository("backend"),
    candidate: {
      releaseId: "HL-20260722-1",
      frontendCommit: FRONTEND_COMMIT,
      backendCommit: BACKEND_COMMIT,
    },
    nodeVersion: EXPECTED_NODE_VERSION,
  });
  assert.equal(report.status, "ready-for-freeze-review");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.authorityGranted, false);
  assert.equal(report.mutationsPerformed, false);
});

test("repository inspection hashes exact inputs and reports status without exposing content", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-release-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package-lock.json"), "private-looking-content");
  const calls = [];
  const result = inspectRepository({
    name: "backend",
    directory: root,
    configurationFiles: ["package-lock.json"],
    runGit(directory, arguments_) {
      calls.push({ directory, arguments_ });
      if (arguments_[0] === "status") return " M package.json\n?? new.js";
      if (arguments_[0] === "branch") return "staging";
      return BACKEND_COMMIT;
    },
  });
  assert.equal(result.dirtyEntryCount, 2);
  assert.equal(result.branch, "staging");
  assert.equal(result.commit, BACKEND_COMMIT);
  assert.match(result.configurationSha256["package-lock.json"], /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes("private-looking-content"), false);
  assert.equal(calls.length, 3);
});

test("release-candidate CLI accepts inspection or one complete exact input and emits safely", () => {
  assert.equal(parseArguments([]), null);
  assert.deepEqual(
    parseArguments([
      "--release-id", "HL-20260722-1",
      "--frontend-commit", FRONTEND_COMMIT,
      "--backend-commit", BACKEND_COMMIT,
    ]),
    {
      releaseId: "HL-20260722-1",
      frontendCommit: FRONTEND_COMMIT,
      backendCommit: BACKEND_COMMIT,
    }
  );
  assert.throws(
    () => parseArguments(["--release-id", "HL-20260722-1"]),
    ReleaseCandidateArgumentError
  );
  const output = [];
  const expected = Object.freeze({ status: "blocked", blockers: ["DIRTY"] });
  const report = runReleaseCandidatePreflightCommand({
    argv: [],
    createPreflight(options) {
      assert.equal(options.candidate, null);
      return expected;
    },
    output: { log: (value) => output.push(value) },
  });
  assert.equal(report, expected);
  assert.deepEqual(JSON.parse(output[0]), expected);
});
